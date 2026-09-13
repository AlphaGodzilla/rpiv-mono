import type { QuestionData } from "../tool/types.js";
import { buildQuestionCard, type CardButtonValue, isCancelWord } from "./message-format.js";
import type { FeishuReceiver, FeishuRemoteConfig, TgRemoteConfig } from "./remote-config.js";
import { buildTgAnswerNote, buildTgDoneKeyboard, buildTgQuestionMessage, type TgButtonValue } from "./tg-message.js";

/**
 * Channel transport built on the `ag-pi-channel` event bus.
 *
 * The pi-channel plugin owns the provider credentials and the connections
 * (Feishu websocket / Telegram long-polling); this package only emits
 * `ag-pi-channel:send` requests and listens for `ag-pi-channel:inbound`
 * events. The constants, payload types, `readAckText` convention and
 * `sendViaBus` below are a copy of `pi-mono/packages/pi-channel/lib/events.ts`
 * — cross-repo imports are not possible, so the contract MUST stay in sync:
 * the plugin is the other side of these events and the requestId correlation
 * in `sendViaBus` is what matches a result to its request.
 *
 * `RemoteTransport` (Feishu) and `TgTransport` (Telegram) keep their old
 * surface so the questionnaire orchestrators stay untouched: `send*` rejects
 * when the plugin reports a failure (the orchestrator turns that into a
 * "send failed" envelope), while `waitForReply` resolves `null` on timeout.
 */

export const CHANNEL_SEND = "ag-pi-channel:send";
export const CHANNEL_SEND_RESULT = "ag-pi-channel:send:result";
export const CHANNEL_INBOUND = "ag-pi-channel:inbound";

export type ChannelProvider = "feishu" | "telegram";

/** 飞书 `receive_id_type`；telegram 只用 `id`（chat id），`type` 忽略。 */
export type FeishuReceiverType = "open_id" | "user_id" | "union_id" | "email" | "chat_id";

export type ChannelTarget = {
	/** provider 的收件人 id：feishu = receive_id；telegram = chat id */
	id: string;
	/** feishu 的 receive_id_type，缺省 `chat_id` */
	type?: FeishuReceiverType;
};

export type ChannelSendRequest = {
	requestId: string;
	provider: ChannelProvider;
	kind: "text" | "card";
	/** 缺省用该 provider 配置里的默认收件人（feishu.defaultReceiver / telegram.defaultChatId） */
	to?: ChannelTarget;
	/** kind = "text" 时的正文 */
	text?: string;
	/** kind = "card" 时的 provider 原生载荷：feishu = 交互卡片 JSON；telegram = reply_markup 对象 */
	card?: unknown;
	/** 传了则更新既有消息：feishu 走卡片 patch，telegram 走 editMessageText / editMessageReplyMarkup */
	update?: { messageId: string; text?: string };
	/**
	 * 文本解析模式（telegram 专用）：`HTML` / `MarkdownV2`；缺省纯文本。
	 * feishu 忽略该字段（飞书文本消息不走 parse_mode）。
	 */
	parseMode?: "HTML" | "MarkdownV2";
};

export type ChannelSendResult = {
	requestId: string;
	ok: boolean;
	messageId?: string;
	error?: { code: string; message: string };
};

export type ChannelInboundMessage = {
	provider: ChannelProvider;
	kind: "message";
	chatId: string;
	/** feishu 区分 p2p/group；telegram 由 plugin 依 chat id 推断（负数 = 群/频道） */
	chatType?: "p2p" | "group";
	senderId: string;
	messageId: string;
	/** 文本正文；非文本消息为空串 */
	text: string;
	/** `text` 之外的取值（sticker / image / file …）表示这条不是文本消息 */
	contentType: string;
	timestamp?: number;
};

export type ChannelInboundAction = {
	provider: ChannelProvider;
	kind: "action";
	chatId: string;
	chatType?: "p2p" | "group";
	senderId: string;
	messageId: string;
	/** 按钮 value（消费方自定义结构）。若其中带字符串字段 `ackText`，插件用它回 toast/ack。 */
	value: unknown;
	timestamp?: number;
};

export type ChannelInboundEvent = ChannelInboundMessage | ChannelInboundAction;

/** 消费方需要的最小事件总线形状（与 pi 的 EventBus 结构一致）。 */
export type EventsLike = {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
};

/** 出站请求的默认等待上限；超时按 `ok: false, code: "timeout"` 返回（绝不抛异常）。 */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/**
 * 请求/响应助手：emit `ag-pi-channel:send` 并等 `ag-pi-channel:send:result`。
 * 与 `pi-mono/packages/pi-channel/lib/events.ts` 的 `sendViaBus` 保持同一契约。
 */
export async function sendViaBus(
	events: EventsLike,
	request: Omit<ChannelSendRequest, "requestId"> & { requestId?: string },
	timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
): Promise<ChannelSendResult> {
	const requestId = request.requestId ?? globalThis.crypto.randomUUID();
	const payload = { ...request, requestId } as ChannelSendRequest;

	return await new Promise<ChannelSendResult>((resolve) => {
		let settled = false;
		const finish = (result: ChannelSendResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};

		const timer = setTimeout(
			() => finish({ requestId, ok: false, error: { code: "timeout", message: `no result within ${timeoutMs}ms` } }),
			timeoutMs,
		);
		timer.unref?.();

		const unsubscribe = events.on(CHANNEL_SEND_RESULT, (data) => {
			const result = data as ChannelSendResult | undefined;
			if (!result || result.requestId !== requestId) return;
			finish(result);
		});

		events.emit(CHANNEL_SEND, payload);
	});
}

/** 插件上报 `ok: false`（或请求超时）时抛出；`classifyRemoteError` 能读出 `code`。 */
export class ChannelSendError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** Normalize an unknown error into `{ code, message }` for the LLM-facing failure envelopes. */
export function classifyRemoteError(err: unknown): { code: string; message: string } {
	if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string") {
		return { code: (err as { code: string }).code, message: err.message };
	}
	return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

export interface RemoteReply {
	text: string;
	chatId: string;
	chatType: "p2p" | "group";
	senderId: string;
	messageId: string;
}

/**
 * Optional card context handed to `waitForReply` so button clicks on the
 * question card are accepted as replies: the click's `value.q` must match the
 * pending question index (stale cards are ignored), and the card is rebuilt in
 * "answered" state (✓ on the chosen button, everything else disabled) before
 * the reply resolves.
 */
export interface CardReplyContext {
	question: QuestionData;
	index: number;
	/** First configured cancel word — button-cancel replies are routed through it. */
	cancelWord: string;
}

export interface RemoteTransport {
	send(receiver: FeishuReceiver, text: string): Promise<void>;
	/** Send an interactive card (V2 schema). */
	sendCard(receiver: FeishuReceiver, card: object): Promise<void>;
	/** Replace an already-sent card's content (used to lock answered cards). */
	updateCard(messageId: string, card: object): Promise<void>;
	/**
	 * Resolve with the next matching reply, or `null` when `timeoutMs`
	 * elapses first. Non-text messages are ignored (after `onNonText`
	 * fires) so a sticker or image never aborts the questionnaire. When
	 * `card` is given, card button clicks on the pending question card are
	 * also accepted (and the card is locked before resolving).
	 */
	waitForReply(timeoutMs: number, onNonText?: () => void, card?: CardReplyContext): Promise<RemoteReply | null>;
	close(): Promise<void>;
}

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
	 * `timeoutMs` elapses first. Non-text input from the @-user fires
	 * `onNonText` and the wait continues.
	 */
	waitForReply(timeoutMs: number, onNonText?: () => void, card?: TgCardContext): Promise<TgReply | null>;
	close(): Promise<void>;
}

/** How the transports reach the pi-channel plugin; `sendTimeoutMs` is a test seam. */
export interface ChannelTransportDeps {
	events: EventsLike;
	/** Outbound send timeout (default 10s — the plugin's own request budget). */
	sendTimeoutMs?: number;
}

class ChannelTransportBase<Reply> {
	protected readonly events: EventsLike;
	protected readonly sendTimeoutMs: number;

	private active = true;
	private unsubscribe: (() => void) | undefined;
	private cancelPending: (() => void) | undefined;

	constructor(deps: ChannelTransportDeps) {
		this.events = deps.events;
		this.sendTimeoutMs = deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
	}

	/** Emit one send request and reject when the plugin reports a failure or the request times out. */
	protected async sendRequest(
		request: Omit<ChannelSendRequest, "requestId"> & { requestId?: string },
	): Promise<string | undefined> {
		const result = await sendViaBus(this.events, request, this.sendTimeoutMs);
		if (!result.ok) {
			const code = result.error?.code ?? "unknown";
			const message = result.error?.message ?? `channel ${request.provider} ${request.kind} request failed`;
			throw new ChannelSendError(code, message);
		}
		return result.messageId;
	}

	/**
	 * Subscribe to inbound events for one wait. The handler calls `finish` to settle
	 * the wait; simply returning keeps listening (non-text input, stale cards).
	 */
	protected waitForInbound(
		timeoutMs: number,
		handle: (evt: ChannelInboundEvent, finish: (reply: Reply | null) => void) => void,
	): Promise<Reply | null> {
		return new Promise<Reply | null>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (reply: Reply | null) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				this.unsubscribe?.();
				this.unsubscribe = undefined;
				this.cancelPending = undefined;
				resolve(reply);
			};

			this.cancelPending = () => finish(null);
			this.unsubscribe = this.events.on(CHANNEL_INBOUND, (data) => {
				if (!this.active) return;
				const evt = data as ChannelInboundEvent | undefined;
				if (!evt || typeof evt !== "object") return;
				handle(evt, finish);
			});

			if (timeoutMs > 0) {
				timer = setTimeout(() => finish(null), timeoutMs);
				// A stray timer must not hold a non-TUI embedder's process open.
				timer.unref?.();
			}
		});
	}

	async close(): Promise<void> {
		this.active = false;
		this.cancelPending?.();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

class FeishuBusTransport extends ChannelTransportBase<RemoteReply> implements RemoteTransport {
	private readonly groupChatIds: Set<string>;

	constructor(cfg: FeishuRemoteConfig, deps: ChannelTransportDeps) {
		super(deps);
		this.groupChatIds = new Set(cfg.receivers.filter((r) => r.type === "chat_id").map((r) => r.value));
	}

	async send(receiver: FeishuReceiver, text: string): Promise<void> {
		await this.sendRequest({
			provider: "feishu",
			kind: "text",
			to: { id: receiver.value, type: receiver.type },
			text,
		});
	}

	async sendCard(receiver: FeishuReceiver, card: object): Promise<void> {
		await this.sendRequest({
			provider: "feishu",
			kind: "card",
			to: { id: receiver.value, type: receiver.type },
			card,
		});
	}

	async updateCard(messageId: string, card: object): Promise<void> {
		await this.sendRequest({ provider: "feishu", kind: "card", update: { messageId }, card });
	}

	waitForReply(timeoutMs: number, onNonText?: () => void, card?: CardReplyContext): Promise<RemoteReply | null> {
		return this.waitForInbound(timeoutMs, (evt, finish) => {
			if (evt.provider !== "feishu") return;

			if (evt.kind === "message") {
				// Non-text messages (sticker, image, file, …) never answer a question.
				if (evt.contentType !== "text" || evt.text.trim().length === 0) {
					onNonText?.();
					return;
				}
				// p2p: any sender answers (the only people who get the question in DM
				// are the configured receivers). group: the chat must be one of the
				// configured chat_id receivers; the plugin's requireMention policy
				// already guarantees the bot was @'d.
				if (evt.chatType !== "p2p" && !this.groupChatIds.has(evt.chatId)) return;
				finish({
					text: evt.text,
					chatId: evt.chatId,
					chatType: this.chatTypeOf(evt),
					senderId: evt.senderId,
					messageId: evt.messageId,
				});
				return;
			}

			// Card button clicks. `card.action.trigger` carries no chatType, so the
			// accept rule is: no group receiver configured → accept any click
			// (personal scenario); otherwise only clicks from the configured group
			// chats. The question-index check (`value.q`) drops clicks on stale
			// cards from earlier questions.
			if (!card) return;
			if (this.groupChatIds.size > 0 && !this.groupChatIds.has(evt.chatId)) return;
			const value = evt.value as CardButtonValue | undefined;
			if (!value || typeof value !== "object") return;
			if (String(card.index) !== String(value.q)) return;

			const isCancel = value.c === "1";
			const optionNum = typeof value.o === "string" ? Number.parseInt(value.o, 10) : NaN;
			const selectedIndex = isCancel || !Number.isFinite(optionNum) ? undefined : optionNum - 1;
			const updatedCard = buildQuestionCard(card.question, card.index, selectedIndex, isCancel);
			// Lock the card via the update API: ✓ on the chosen button, everything
			// else disabled. The 3s callback ack (toast) is handled by the plugin
			// from the button value's `ackText`.
			void this.updateCard(evt.messageId, updatedCard).catch(() => undefined);

			finish({
				text: isCancel ? card.cancelWord : String(optionNum),
				chatId: evt.chatId,
				chatType: this.chatTypeOf(evt),
				senderId: evt.senderId,
				messageId: evt.messageId,
			});
		});
	}

	/** Feishu p2p/group label; action events may lack `chatType`, so fall back to the receiver set. */
	private chatTypeOf(evt: ChannelInboundEvent): "p2p" | "group" {
		if (evt.chatType === "p2p" || evt.chatType === "group") return evt.chatType;
		return this.groupChatIds.has(evt.chatId) ? "group" : "p2p";
	}
}

class TgBusTransport extends ChannelTransportBase<TgReply> implements TgTransport {
	private readonly tgCfg: TgRemoteConfig;

	constructor(cfg: TgRemoteConfig, deps: ChannelTransportDeps) {
		super(deps);
		this.tgCfg = cfg;
	}

	async sendText(text: string): Promise<TgSentMessage> {
		return await this.sendMessage(text, undefined);
	}

	async sendCard(text: string, keyboard: object): Promise<TgSentMessage> {
		return await this.sendMessage(text, keyboard);
	}

	private async sendMessage(text: string, keyboard: object | undefined): Promise<TgSentMessage> {
		// The tg question body carries HTML markup (mention link, escaped labels).
		const request: Omit<ChannelSendRequest, "requestId"> = {
			provider: "telegram",
			kind: keyboard === undefined ? "text" : "card",
			to: { id: this.tgCfg.chatId },
			text,
			parseMode: "HTML",
		};
		if (keyboard !== undefined) request.card = keyboard;
		const messageId = await this.sendRequest(request);
		return { chatId: Number(this.tgCfg.chatId), messageId: Number(messageId ?? 0) };
	}

	waitForReply(timeoutMs: number, onNonText?: () => void, card?: TgCardContext): Promise<TgReply | null> {
		return this.waitForInbound(timeoutMs, (evt, finish) => {
			if (evt.provider !== "telegram") return;
			// ONLY the configured @-user's input from the configured chat answers.
			if (evt.chatId !== this.tgCfg.chatId || evt.senderId !== String(this.tgCfg.userId)) return;

			if (evt.kind === "message") {
				if (evt.contentType !== "text" || evt.text.trim().length === 0) {
					onNonText?.();
					return;
				}
				const text = evt.text.trim();
				// ask-prd cannot be cancelled: a cancel word is ignored and the wait
				// continues until the @-user actually answers.
				if (card && isCancelWord(text, [card.cancelWord])) return;
				finish({ text, chatId: Number(evt.chatId), messageId: Number(evt.messageId) });
				return;
			}

			if (!card) return;
			const value = parseTgButtonValue(evt.value);
			if (!value) return;
			if (String(card.index) !== String(value.q)) return; // stale card
			// ask-prd cannot be cancelled: a cancel callback (legacy card) is ignored.
			if (value.c === "1") return;

			const optionNum = typeof value.o === "string" ? Number.parseInt(value.o, 10) : NaN;
			const finalText =
				buildTgQuestionMessage(card.question, this.tgCfg) +
				buildTgAnswerNote(card.question, Number.isFinite(optionNum) ? optionNum : undefined, false);
			// Lock the card: edit the text (answer footer) and drop the keyboard.
			// The toast ack ("已选择") is handled by the plugin from the button
			// value's `ackText`.
			void this.finalizeCard(evt.messageId, finalText).catch(() => undefined);

			finish({ text: String(optionNum), chatId: Number(evt.chatId), messageId: Number(evt.messageId) });
		});
	}

	private async finalizeCard(messageId: string, text: string): Promise<void> {
		await this.sendRequest({
			provider: "telegram",
			kind: "card",
			to: { id: this.tgCfg.chatId },
			update: { messageId },
			text,
			card: buildTgDoneKeyboard(),
			parseMode: "HTML",
		});
	}
}

/** tg callback values arrive as the JSON object the plugin parsed (string fallback for hand-built updates). */
function parseTgButtonValue(raw: unknown): TgButtonValue | undefined {
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return undefined;
		}
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const o = parsed as Record<string, unknown>;
	if (typeof o.q !== "string") return undefined;
	const out: TgButtonValue = { q: o.q };
	if (typeof o.o === "string") out.o = o.o;
	if (typeof o.c === "string") out.c = o.c;
	return out;
}

/** Feishu transport on the event bus; never connects (the plugin holds the connection). */
export async function createFeishuTransport(
	cfg: FeishuRemoteConfig,
	deps: ChannelTransportDeps,
): Promise<RemoteTransport> {
	return new FeishuBusTransport(cfg, deps);
}

/** Telegram transport on the event bus; never polls (the plugin holds the connection). */
export function createTgTransport(cfg: TgRemoteConfig, deps: ChannelTransportDeps): TgTransport {
	return new TgBusTransport(cfg, deps);
}
