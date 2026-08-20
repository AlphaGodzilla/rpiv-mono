import type { QuestionData } from "../tool/types.js";
import type { TgRemoteConfig } from "./remote-config.js";
import { createProxyAwareFetch, type TgFetch } from "./tg-http.js";
import { buildTgLockedKeyboard, type TgButtonValue } from "./tg-message.js";

/**
 * Telegram transport for the `ask-prd` flow, built on a zero-dependency
 * `node:https` client (`remote/tg-http.ts`, proxy-aware) against the Bot API:
 *
 * - `sendMessage` for text and interactive (inline-keyboard) cards.
 * - `getUpdates` long-polling (timeout=50) receives messages and button
 *   callback queries; ONLY the configured @-user's input from the configured
 *   chat is accepted as a reply.
 * - A button click answers the question directly: the card is locked
 *   (`editMessageReplyMarkup` → ✓/已取消 button) and a toast is sent
 *   (`answerCallbackQuery`).
 *
 * The `TgTransport` interface is the seam unit tests mock; the questionnaire
 * orchestrator never touches HTTP or Telegram internals directly.
 */

export interface TgSentMessage {
	chatId: number;
	messageId: number;
}

export interface TgReply {
	text: string;
	chatId: number;
	messageId: number;
}

/** Card context handed to `waitForReply` so button clicks answer; `q` pins the question index (stale cards ignored). */
export interface TgCardContext {
	question: QuestionData;
	index: number;
	/** First configured cancel word — button-cancel replies route through it. */
	cancelWord: string;
}

export interface TgTransport {
	sendText(text: string): Promise<TgSentMessage>;
	/** Send an interactive inline-keyboard card. */
	sendCard(text: string, keyboard: object): Promise<TgSentMessage>;
	/**
	 * Resolve with the next matching reply from the @-user, or `null` when
	 * `timeoutMs` elapses first. Fatal transport errors (401/409) reject with a
	 * `TgChannelError`. Non-text input from the @-user fires `onNonText` and the
	 * wait continues.
	 */
	waitForReply(timeoutMs: number, onNonText?: () => void, card?: TgCardContext): Promise<TgReply | null>;
	close(): Promise<void>;
}

export interface TgTransportDeps {
	/** HTTP implementation; defaults to a proxy-aware node:https client. Injected for tests. */
	fetch?: TgFetch;
	log?: (msg: string) => void;
	/** getUpdates long-poll seconds. Default 50 (Telegram max). Tests use a small value. */
	pollTimeoutSec?: number;
	/** Retry backoff for transient getUpdates errors. Default 1000ms. */
	retryDelayMs?: number;
}

export class TgChannelError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** Normalize an unknown error into `{ code, message }` — mirrors Feishu's classifyRemoteError. */
export function classifyRemoteError(err: unknown): { code: string; message: string } {
	if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string") {
		return { code: (err as { code: string }).code, message: err.message };
	}
	return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

interface PendingWait {
	resolve: (reply: TgReply | null) => void;
	reject: (err: unknown) => void;
	onNonText?: () => void;
	card?: TgCardContext;
}

interface TgApiResponse {
	ok: boolean;
	error_code?: number;
	description?: string;
	result?: unknown;
}

export function createTgTransport(cfg: TgRemoteConfig, deps: TgTransportDeps = {}): TgTransport {
	return new TgTransportImpl(cfg, deps);
}

class TgTransportImpl implements TgTransport {
	private readonly cfg: TgRemoteConfig;
	private readonly fetchImpl: TgFetch;
	private readonly log: (msg: string) => void;
	private readonly pollTimeoutSec: number;
	private readonly retryDelayMs: number;

	private active = true;
	private pending: PendingWait | null = null;
	private waitTimer: ReturnType<typeof setTimeout> | undefined;
	private polling = false;
	private offset: number | undefined;
	private currentController: AbortController | undefined;
	/** Unix-seconds of the most recent question send — older updates (pre-question noise) are ignored. */
	private epochSeconds = 0;

	constructor(cfg: TgRemoteConfig, deps: TgTransportDeps) {
		this.cfg = cfg;
		this.fetchImpl = deps.fetch ?? createProxyAwareFetch(cfg.proxy);
		this.log = deps.log ?? (() => undefined);
		this.pollTimeoutSec = deps.pollTimeoutSec ?? 50;
		this.retryDelayMs = deps.retryDelayMs ?? 1_000;
	}

	async sendText(text: string): Promise<TgSentMessage> {
		return this.sendMessage(text, undefined);
	}

	async sendCard(text: string, keyboard: object): Promise<TgSentMessage> {
		return this.sendMessage(text, keyboard);
	}

	private async sendMessage(text: string, keyboard: object | undefined): Promise<TgSentMessage> {
		const body: Record<string, unknown> = { chat_id: this.cfg.chatId, text, parse_mode: "HTML" };
		if (keyboard !== undefined) body.reply_markup = keyboard;
		const result = (await this.callApi("sendMessage", body)) as { message_id: number; chat: { id: number } };
		// Any update older than this send predates the question and must not answer it.
		this.epochSeconds = Math.floor(Date.now() / 1000);
		return { chatId: result.chat.id, messageId: result.message_id };
	}

	waitForReply(timeoutMs: number, onNonText?: () => void, card?: TgCardContext): Promise<TgReply | null> {
		return new Promise((resolve, reject) => {
			if (!this.active) return resolve(null);
			this.pending = { resolve, reject, onNonText, card };
			this.startPolling();
			if (timeoutMs > 0) {
				const timer = setTimeout(() => {
					this.settle(null);
				}, timeoutMs);
				timer.unref?.();
				this.waitTimer = timer;
			}
		});
	}

	async close(): Promise<void> {
		this.active = false;
		this.abortCurrent();
		if (this.waitTimer !== undefined) clearTimeout(this.waitTimer);
		this.waitTimer = undefined;
		this.settle(null);
		this.polling = false;
	}

	// ---- polling ----

	private startPolling(): void {
		if (this.polling || !this.active) return;
		this.polling = true;
		void this.pollLoop();
	}

	private async pollLoop(): Promise<void> {
		while (this.active && this.pending !== null) {
			const keepGoing = await this.pollOnce();
			if (!keepGoing) break;
			// Yield to the event loop so the wait timer / close can fire even when
			// getUpdates resolves instantly (e.g. a test mock fetch) instead of
			// spinning a microtask loop that starves macrotask timers.
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		this.polling = false;
	}

	private async pollOnce(): Promise<boolean> {
		const controller = new AbortController();
		this.currentController = controller;
		const params = new URLSearchParams({
			timeout: String(this.pollTimeoutSec),
			allowed_updates: JSON.stringify(["message", "callback_query"]),
		});
		if (this.offset !== undefined) params.set("offset", String(this.offset));
		const url = `https://api.telegram.org/bot${this.cfg.botToken}/getUpdates?${params.toString()}`;
		try {
			const res = await this.fetchImpl(url, { signal: controller.signal });
			const data = (await res.json().catch(() => ({}))) as TgApiResponse;
			if (!data.ok) return this.handlePollError(data, res.status);
			for (const update of (data.result as Array<Record<string, unknown>> | undefined) ?? []) {
				if (!this.active || this.pending === null) break;
				this.offset = Number(update.update_id) + 1;
				this.processUpdate(update);
			}
			return true;
		} catch (err) {
			if (!this.active) return false;
			this.log(`getUpdates error: ${err instanceof Error ? err.message : String(err)}`);
			await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
			return true;
		}
	}

	private handlePollError(data: TgApiResponse, status: number): boolean {
		const code = data.error_code ?? status;
		const desc = data.description ?? String(data);
		if (code === 409) {
			this.failPending(
				new TgChannelError(
					"tg_getUpdates",
					`Telegram getUpdates conflict (409) — another poller is using this bot token: ${desc}`,
				),
			);
			return false;
		}
		if (code === 401) {
			this.failPending(new TgChannelError("tg_getUpdates", `Telegram unauthorized (401) — bad bot token: ${desc}`));
			return false;
		}
		this.log(`getUpdates transient error (${code}): ${desc} — retrying`);
		return true;
	}

	// ---- update processing ----

	private processUpdate(update: Record<string, unknown>): void {
		const pending = this.pending;
		if (pending === null) return;

		const message = update.message as Record<string, unknown> | undefined;
		if (message !== undefined) {
			this.processMessage(pending, message);
			return;
		}
		const callback = update.callback_query as Record<string, unknown> | undefined;
		if (callback !== undefined) this.processCallback(pending, callback);
	}

	private processMessage(pending: PendingWait, message: Record<string, unknown>): void {
		const from = message.from as Record<string, unknown> | undefined;
		if (from?.id !== this.cfg.userId) return; // only the @-user answers
		const chat = message.chat as Record<string, unknown> | undefined;
		if (String(chat?.id) !== this.cfg.chatId) return;
		// Ignore updates older than the latest question send — stray pre-question messages
		// from the @-user must not answer a question they never saw.
		if (typeof message.date === "number" && message.date < this.epochSeconds) return;
		const text = typeof message.text === "string" ? message.text.trim() : "";
		if (text.length === 0) {
			pending.onNonText?.();
			return;
		}
		this.settle({ text, chatId: Number(chat?.id), messageId: Number(message.message_id) });
	}

	private processCallback(pending: PendingWait, callback: Record<string, unknown>): void {
		const from = callback.from as Record<string, unknown> | undefined;
		if (from?.id !== this.cfg.userId) return;
		const msg = callback.message as Record<string, unknown> | undefined;
		if (!msg) return;
		const chat = msg.chat as Record<string, unknown> | undefined;
		if (!chat || String(chat.id) !== this.cfg.chatId) return;
		// Same pre-question noise guard as for messages.
		if (typeof msg.date === "number" && msg.date < this.epochSeconds) return;
		const value = this.parseButtonValue(callback.data);
		if (!value) return;
		if (!pending.card || String(pending.card.index) !== String(value.q)) return; // stale card
		const isCancel = value.c === "1";
		const optionNum = typeof value.o === "string" ? Number.parseInt(value.o, 10) : NaN;
		const selectedIndex = isCancel || !Number.isFinite(optionNum) ? undefined : optionNum - 1;
		const locked = buildTgLockedKeyboard(pending.card.question, pending.card.index, selectedIndex, isCancel);
		void this.callApi("editMessageReplyMarkup", {
			chat_id: chat.id,
			message_id: msg.message_id,
			reply_markup: locked,
		}).catch(() => undefined);
		void this.callApi("answerCallbackQuery", {
			callback_query_id: callback.id,
			text: isCancel ? "已取消" : "已选择",
		}).catch(() => undefined);
		this.settle({
			text: isCancel ? pending.card.cancelWord : String(optionNum),
			chatId: Number(chat.id),
			messageId: Number(msg.message_id),
		});
	}

	private parseButtonValue(raw: unknown): TgButtonValue | undefined {
		if (typeof raw !== "string") return undefined;
		try {
			const v = JSON.parse(raw) as unknown;
			if (!v || typeof v !== "object") return undefined;
			const o = v as Record<string, unknown>;
			if (typeof o.q !== "string") return undefined;
			const out: TgButtonValue = { q: o.q };
			if (typeof o.o === "string") out.o = o.o;
			if (typeof o.c === "string") out.c = o.c;
			return out;
		} catch {
			return undefined;
		}
	}

	// ---- lifecycle helpers ----

	private settle(reply: TgReply | null): void {
		if (this.pending === null) return;
		const pending = this.pending;
		this.pending = null;
		if (this.waitTimer !== undefined) clearTimeout(this.waitTimer);
		this.waitTimer = undefined;
		pending.resolve(reply);
	}

	private failPending(err: unknown): void {
		this.abortCurrent();
		if (this.pending === null) return;
		const pending = this.pending;
		this.pending = null;
		if (this.waitTimer !== undefined) clearTimeout(this.waitTimer);
		this.waitTimer = undefined;
		pending.reject(err);
	}

	private abortCurrent(): void {
		this.currentController?.abort();
		this.currentController = undefined;
	}

	private async callApi(method: string, body: Record<string, unknown>): Promise<unknown> {
		const res = await this.fetchImpl(`https://api.telegram.org/bot${this.cfg.botToken}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgApiResponse;
		if (!data.ok) {
			throw new TgChannelError(
				`tg_${method}`,
				`Telegram ${method} failed (${data.error_code ?? res.status}): ${data.description ?? "unknown"}`,
			);
		}
		return data.result;
	}
}
