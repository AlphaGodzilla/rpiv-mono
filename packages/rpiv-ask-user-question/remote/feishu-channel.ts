import { createLarkChannel, type LarkChannel } from "@larksuiteoapi/node-sdk";
import type { QuestionData } from "../tool/types.js";
import { buildQuestionCard, type CardButtonValue } from "./message-format.js";
import type { FeishuReceiver, FeishuRemoteConfig } from "./remote-config.js";

/**
 * Feishu transport built on the official SDK's `createLarkChannel` high-level
 * module (websocket long-connection mode):
 *
 * - `policy.requireMention: true` — group messages that do not @ the bot are
 *   filtered by the SDK's policy layer before they reach our handler.
 * - `dmMode: "open"` — p2p messages reach us without extra configuration.
 *
 * The `RemoteTransport` interface is the seam unit tests mock; the
 * questionnaire orchestrator never touches `LarkChannel` directly.
 */

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
	 * `card` is given, `card.action.trigger` clicks on the pending question
	 * card are also accepted (and the card is locked before resolving).
	 */
	waitForReply(timeoutMs: number, onNonText?: () => void, card?: CardReplyContext): Promise<RemoteReply | null>;
	close(): Promise<void>;
}

export function classifyRemoteError(err: unknown): { code: string; message: string } {
	if (err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string") {
		return { code: (err as { code: string }).code, message: err.message };
	}
	return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

class FeishuTransport implements RemoteTransport {
	/** Exposed for advanced callers (e.g. cardAction subscription in tests/e2e). */
	get channel(): LarkChannel {
		return this._channel;
	}

	private readonly _channel: LarkChannel;
	private readonly receivers: readonly FeishuReceiver[];
	private active = true;

	constructor(channel: LarkChannel, receivers: readonly FeishuReceiver[]) {
		this._channel = channel;
		this.receivers = receivers;
	}

	async send(receiver: FeishuReceiver, text: string): Promise<void> {
		if (receiver.type === "chat_id") {
			await this._channel.send(receiver.value, { text });
			return;
		}
		// Channel.send only accepts chat ids; personal receivers keep the native
		// receive_id_type via the raw client ("escape hatch" per the SDK docs).
		await this._channel.rawClient.im.v1.message.create({
			params: { receive_id_type: receiver.type },
			data: {
				receive_id: receiver.value,
				content: JSON.stringify({ text }),
				msg_type: "text",
			},
		});
	}

	async sendCard(receiver: FeishuReceiver, card: object): Promise<void> {
		if (receiver.type === "chat_id") {
			await this._channel.send(receiver.value, { card });
			return;
		}
		await this._channel.rawClient.im.v1.message.create({
			params: { receive_id_type: receiver.type },
			data: {
				receive_id: receiver.value,
				content: JSON.stringify(card),
				msg_type: "interactive",
			},
		});
	}

	async updateCard(messageId: string, card: object): Promise<void> {
		await this._channel.updateCard(messageId, card);
	}

	waitForReply(timeoutMs: number, onNonText?: () => void, card?: CardReplyContext): Promise<RemoteReply | null> {
		return new Promise((resolve) => {
			const groupChatIds = new Set(this.receivers.filter((r) => r.type === "chat_id").map((r) => r.value));
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const finish = (reply: RemoteReply | null) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				messageUnsubscribe();
				cardUnsubscribe();
				resolve(reply);
			};
			// p2p: any sender answers (the only people who get the question in
			// DM are the configured receivers). group: the chat must be one of
			// the configured chat_id receivers; the SDK's requireMention policy
			// already guarantees the bot was @'d.
			const matchesChat = (chatId: string, chatType: "p2p" | "group"): boolean =>
				chatType === "p2p" ? true : groupChatIds.has(chatId);

			const messageUnsubscribe = this._channel.on("message", (msg) => {
				if (!this.active) return;
				// Non-text messages (sticker, image, file, …) never answer a question.
				if (msg.rawContentType !== "text" || msg.content.trim().length === 0) {
					onNonText?.();
					return;
				}
				if (matchesChat(msg.chatId, msg.chatType)) {
					finish({
						text: msg.content,
						chatId: msg.chatId,
						chatType: msg.chatType,
						senderId: msg.senderId,
						messageId: msg.messageId,
					});
				}
			});

			// Card button clicks on the pending question card. `card.action.trigger`
			// carries no chatType, so the accept rule is: no group receiver
			// configured → accept any click (personal scenario); otherwise only
			// clicks from the configured group chats. The question-index check
			// (`value.q`) drops clicks on stale cards from earlier questions.
			const cardUnsubscribe = this._channel.on("cardAction", (evt) => {
				if (!this.active) return;
				if (groupChatIds.size > 0 && !groupChatIds.has(evt.chatId)) return;
				const value = evt.action?.value as CardButtonValue | undefined;
				if (!value || typeof value !== "object") return;
				if (card && String(card.index) !== String(value.q)) return;
				if (!card) return;

				const isCancel = value.c === "1";
				const optionNum = typeof value.o === "string" ? Number.parseInt(value.o, 10) : NaN;
				const selectedIndex = isCancel || !Number.isFinite(optionNum) ? undefined : optionNum - 1;
				const updatedCard = buildQuestionCard(card.question, card.index, selectedIndex, isCancel);

				// Lock the card via the updateCard API: ✓ on the chosen button,
				// everything else disabled. (The callback response cannot carry
				// the card — the platform rejects non-V1 card bodies — and the
				// 3s window is kept for the toast ack only.)
				void this.updateCard(evt.messageId, updatedCard).catch(() => undefined);

				finish({
					text: isCancel ? card.cancelWord : String(optionNum),
					chatId: evt.chatId,
					chatType: groupChatIds.size > 0 && groupChatIds.has(evt.chatId) ? "group" : "p2p",
					senderId: evt.operator.openId,
					messageId: evt.messageId,
				});
				// The 3s callback response is injected at the WS dispatcher level
				// (installCardCallbackResponder) — the SDK discards this listener's
				// return value, so nothing is returned here.
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
		// The card-callback ack is sent right after our cardAction listener
		// resolves the pending reply — disconnecting immediately can drop the
		// queued ack, so the Feishu client shows "回调响应超时". Give the
		// socket a beat to flush the last frame before tearing down.
		await new Promise((resolve) => setTimeout(resolve, 400));
		await this._channel.disconnect();
	}
}

/** Build a connected transport for the configured Feishu app. Rejects with `LarkChannelError` on failure. */
export async function createFeishuTransport(cfg: FeishuRemoteConfig): Promise<RemoteTransport> {
	const channel = createLarkChannel({
		appId: cfg.appId,
		appSecret: cfg.appSecret,
		policy: { requireMention: true, dmMode: "open" },
	});
	await channel.connect();
	const transport = new FeishuTransport(channel, cfg.receivers);
	installCardCallbackResponder(channel);
	return transport;
}

/**
 * Feishu long-connection card callbacks expect a response body within 3s. The
 * SDK's Channel safety layer discards our `cardAction` listener's return value
 * (its `pushAction` never propagates the handler result), so without this the
 * client spins into "回调响应超时" after every button click. We inject a
 * generic success response at the WS dispatcher level instead — the event
 * arrives as `{ schema, header, event }` with the type in
 * `header.event_type`, and the response is base64-encoded into the ack's
 * `data` field by the SDK's `WSClient.handleEventData`.
 */
function installCardCallbackResponder(channel: LarkChannel): void {
	const ws = channel.rawWsClient as
		| { eventDispatcher?: { invoke: (...args: unknown[]) => Promise<unknown> } }
		| undefined;
	const dispatcher = ws?.eventDispatcher;
	if (!ws || !dispatcher) return;
	const origInvoke = dispatcher.invoke.bind(dispatcher);
	dispatcher.invoke = async (data: unknown, opts?: unknown) => {
		const result = await origInvoke(data, opts);
		const header = (data as { header?: { event_type?: string } } | null)?.header;
		if (header?.event_type === "card.action.trigger") {
			const value = (data as { event?: { action?: { value?: { c?: string } } } } | null)?.event?.action?.value;
			return { toast: { type: "success", content: value?.c === "1" ? "已取消" : "已选择" } };
		}
		return result;
	};
}
