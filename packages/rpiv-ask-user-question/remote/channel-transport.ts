import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG_NAME } from "../config.js";
import type { QuestionData } from "../tool/types.js";
import { buildQuestionCard, type CardButtonValue, isCancelWord, isTuiHandoffWord } from "./message-format.js";
import type { FeishuReceiver, FeishuRemoteConfig, TgRemoteConfig } from "./remote-config.js";
import { buildTgAnswerNote, buildTgDoneKeyboard, buildTgQuestionMessage, type TgButtonValue } from "./tg-message.js";

/**
 * Channel transport built on the `ag-pi-channel` event bus.
 *
 * The pi-channel plugin owns the provider credentials and the connections
 * (Feishu websocket / Telegram long-polling); this package only emits
 * `ag-pi-channel:send` requests and listens for `ag-pi-channel:inbound`
 * events. The constants, payload types, `readAckText` convention and
 * `sendViaBus` / `statusViaBus` below are a copy of
 * `ag-pi-mono/packages/pi-channel/lib/events.ts`
 * — cross-repo imports are not possible, so the contract MUST stay in sync:
 * the plugin is the other side of these events and the requestId correlation
 * in `sendViaBus` is what matches a result to its request. The only intended
 * divergence is the shorter default of `statusViaBus` (1.5s — a pre-flight
 * probe budget, not pi-channel's 5s interactive default).
 *
 * `RemoteTransport` (Feishu) and `TgTransport` (Telegram) keep their old
 * surface so the questionnaire orchestrators stay untouched: `send*` rejects
 * when the plugin reports a failure (the orchestrator turns that into a
 * "send failed" envelope), while `waitForReply` resolves `null` on timeout.
 */

/**
 * 诊断日志（debug.log）：**默认关闭**，由配置顶层 `debug: true` 打开（每次问卷开始时读取）。
 *
 * 为什么要有它：卡片交互的问题多发生在「不可见的那几秒」——发送耗时、入站事件是否到达、
 * 被哪条过滤规则丢弃、等待何时开始/结束。开着它才能把「点卡片 → 生效」的时间轴摊开，
 * 并与 pi-channel 的 debug.log 对齐时间轴；默认关闭时一行不写、也不产生文件（TUI 同样零输出）。
 */
let debugEnabled = false;

/** 开关来源：transport 构造时的 `deps.debug`（由 ask-user-question 从配置读取后传入）。 */
function setTransportDebug(enabled: boolean): void {
	debugEnabled = enabled;
}

export function transportDebugLogPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_NAME, "debug.log");
}

function logDebug(line: string): void {
	if (!debugEnabled) return;
	// vitest 下不写盘：测试不该碰真实用户目录。
	if (process.env.VITEST !== undefined) return;
	try {
		const file = transportDebugLogPath();
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `[${new Date().toISOString()}] ${line.slice(0, 400)}\n`, "utf8");
	} catch {
		// 诊断日志失败绝不影响主流程
	}
}

export const CHANNEL_SEND = "ag-pi-channel:send";
export const CHANNEL_SEND_RESULT = "ag-pi-channel:send:result";
export const CHANNEL_INBOUND = "ag-pi-channel:inbound";
export const CHANNEL_STATUS = "ag-pi-channel:status";
export const CHANNEL_STATUS_RESULT = "ag-pi-channel:status:result";
/**
 * 入站就绪请求（镜像 pi-channel 的 `ag-pi-channel:connect`）：插件是惰性连接的（首次发送成功后才
 * 建长连接），于是「卡片已到飞书、长连接还没握完手」的窗口里用户点击平台无处投递 → 丢击 + 客户端
 * 3s 超时重试（观感就是「点好几次才生效」）。首发送前先请求就绪，等价于拆分前 connect-then-send 的时序。
 */
export const CHANNEL_CONNECT = "ag-pi-channel:connect";
export const CHANNEL_CONNECT_RESULT = "ag-pi-channel:connect:result";
/**
 * 入站释放请求（镜像 pi-channel 的 `ag-pi-channel:release`）：connect 的反向操作。
 * 必须成对 —— 飞书对同一 app 的多条长连接是选一条投递，而插件是全局扩展（每个 pi 进程都加载）：
 * 只 connect 不 release 的进程会长期占着连接，把按钮点击从「正在等回复」的进程那里抢走（点击被别的
 * 实例 ack 成 toast，却永远没人处理）。问卷结束（transport close）时释放，双方计数归零即断开连接。
 */
export const CHANNEL_RELEASE = "ag-pi-channel:release";
export const CHANNEL_RELEASE_RESULT = "ag-pi-channel:release:result";

export type ChannelProvider = "feishu" | "telegram";

/** 飞书 `receive_id_type`；telegram 只用 `id`（chat id），`type` 忽略。 */
export type FeishuReceiverType = "open_id" | "user_id" | "union_id" | "email" | "chat_id";

export type ChannelTarget = {
	/** provider 的收件人 id：feishu = receive_id；telegram = chat id */
	id: string;
	/** feishu 的 receive_id_type，缺省 `chat_id` */
	type?: FeishuReceiverType;
};

/**
 * 出站请求：**按 provider 判别的联合类型**。
 *
 * 两家的"卡片"不是同一层概念，字段因此分开、不共用一个槽位：
 *  - 飞书：`feishuCard` 就是整条消息（交互卡片自带 header/body，`msg_type: interactive`）
 *  - Telegram：`telegramKeyboard` 只是 reply_markup（键盘），正文必须另给 `text`
 * 这样编译期就能挡住"把飞书卡片发给 telegram"这类错配。
 */
export type ParseMode = "HTML" | "MarkdownV2";

/** 出站请求的公共字段（provider/kind 之外的都在这） */
export type ChannelSendCommon = {
	requestId: string;
	/** 缺省用该 provider 配置里的默认收件人（feishu.defaultReceiver / telegram.defaultChatId） */
	to?: ChannelTarget;
};

/** 飞书：文本消息，或整卡发送 / 整卡替换（patch） */
export type FeishuSendRequest = ChannelSendCommon &
	(
		| { provider: "feishu"; kind: "text"; text: string }
		| {
				provider: "feishu";
				kind: "card";
				/** 飞书交互卡片 JSON（schema 2.0 等），插件原样投递 */
				feishuCard: object;
				/** 传了则整卡替换既有消息（im.v1.message.patch） */
				update?: { messageId: string };
		  }
	);

/**
 * Telegram：键盘只是附件，因此 `kind: "card"` 必须同时给 `text`；
 * `kind: "keyboard"` 仅用于"只替换键盘"的更新（编辑已发消息的按钮）。
 */
export type TelegramSendRequest = ChannelSendCommon &
	(
		| { provider: "telegram"; kind: "text"; text: string; parseMode?: ParseMode; update?: { messageId: string } }
		| {
				provider: "telegram";
				kind: "card";
				text: string;
				/** reply_markup 对象（inline_keyboard 等），插件原样投递 */
				telegramKeyboard: object;
				parseMode?: ParseMode;
				update?: { messageId: string };
		  }
		| { provider: "telegram"; kind: "keyboard"; telegramKeyboard: object; update: { messageId: string } }
	);

export type ChannelSendRequest = FeishuSendRequest | TelegramSendRequest;

/** 分配式 Omit：联合类型逐个成员处理（`Omit<Union, K>` 只会塌成公共键） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 消费方调用时无需自己生成 requestId */
export type ChannelSendInput = DistributiveOmit<ChannelSendRequest, "requestId"> & { requestId?: string };

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

export type ChannelStatusRequest = {
	requestId: string;
};

export type ChannelProviderStatus = {
	provider: ChannelProvider;
	/** 配置里存在且必填项齐备 */
	configured: boolean;
	/** 长连接/长轮询是否已建立（出站模式未连接时为 false） */
	connected: boolean;
	/** 脱敏后的应用标识（feishu appId / telegram bot id），便于确认用的是哪套凭据 */
	accountMasked?: string;
	error?: string;
};

export type ChannelStatusResult = {
	requestId: string;
	configPath: string;
	providers: ChannelProviderStatus[];
};

export type ChannelConnectRequest = {
	requestId: string;
	provider: ChannelProvider;
};

export type ChannelConnectResult = {
	requestId: string;
	ok: boolean;
	/** 入站通道是否已就绪（`ok: false` 时为 false） */
	connected: boolean;
	error?: { code: string; message: string };
};

export type ChannelReleaseRequest = {
	requestId: string;
	provider: ChannelProvider;
};

export type ChannelReleaseResult = {
	requestId: string;
	ok: boolean;
	/** 释放后该 provider 的实际连接状态（仍有别的持有者时为 true） */
	connected: boolean;
	error?: { code: string; message: string };
};

/** 入站就绪等待上限：实测飞书冷启动握手 ~2.5s，留足余量。 */
/**
 * 入站就绪等待上限（默认 5s）：实测飞书冷启动握手 ~2.5s，留 2× 余量；
 * 超时（老版本插件不响应该请求）按旧行为继续发送，不让首发送白等更久。
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** 消费方需要的最小事件总线形状（与 pi 的 EventBus 结构一致）。 */
export type EventsLike = {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
};

/** 出站请求的默认等待上限；超时按 `ok: false, code: "timeout"` 返回（绝不抛异常）。 */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/**
 * 请求/响应助手：emit `ag-pi-channel:send` 并等 `ag-pi-channel:send:result`。
 * 与 `ag-pi-mono/packages/pi-channel/lib/events.ts` 的 `sendViaBus` 保持同一契约。
 */
export async function sendViaBus(
	events: EventsLike,
	request: ChannelSendInput,
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

/** 状态查询的默认等待上限：只用于出站前置探测，不必像发送那样等满 10s。 */
export const DEFAULT_STATUS_TIMEOUT_MS = 1_500;

/**
 * 查询插件状态（连接情况 / 配置路径 / 脱敏账号），超时返回 `null`。
 * 与 `ag-pi-mono/packages/pi-channel/lib/events.ts` 的 `statusViaBus` 同语义
 * （requestId 关联响应 + 超时返回 `null`，绝不抛异常）；默认上限压到 1.5s ——
 * 它只服务出站前置探测，不该像真正的发送那样等满 10s。
 */
export async function statusViaBus(
	events: EventsLike,
	timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
): Promise<ChannelStatusResult | null> {
	const requestId = globalThis.crypto.randomUUID();
	return await new Promise<ChannelStatusResult | null>((resolve) => {
		let settled = false;
		const finish = (result: ChannelStatusResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		const unsubscribe = events.on(CHANNEL_STATUS_RESULT, (data) => {
			const result = data as ChannelStatusResult | undefined;
			if (!result || result.requestId !== requestId) return;
			finish(result);
		});
		events.emit(CHANNEL_STATUS, { requestId } satisfies ChannelStatusRequest);
	});
}

/** 插件上报 `ok: false`（或请求超时）时抛出；`classifyRemoteError` 能读出 `code`。 */
/**
 * 请求插件把该 provider 的入站通道建好（幂等），超时返回 `null`。
 * 与 `sendViaBus` / `statusViaBus` 同源同语义（requestId 关联 + 绝不抛异常）。
 * `null` = 插件没加载，或插件版本还没有 connect 契约 —— 调用方应照常继续（退化为惰性行为）。
 */
export async function connectViaBus(
	events: EventsLike,
	provider: ChannelProvider,
	timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<ChannelConnectResult | null> {
	const requestId = globalThis.crypto.randomUUID();
	return await new Promise<ChannelConnectResult | null>((resolve) => {
		let settled = false;
		const finish = (result: ChannelConnectResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		const unsubscribe = events.on(CHANNEL_CONNECT_RESULT, (data) => {
			const result = data as ChannelConnectResult | undefined;
			if (!result || result.requestId !== requestId) return;
			finish(result);
		});
		events.emit(CHANNEL_CONNECT, { requestId, provider } satisfies ChannelConnectRequest);
	});
}

/**
 * `connectViaBus` 的反向操作：告诉插件「这个 provider 的入站我用完了」。
 * 同源同语义（requestId 关联 + 绝不抛异常，超时返回 `null`）；调用方通常 fire-and-forget。
 */
export async function releaseViaBus(
	events: EventsLike,
	provider: ChannelProvider,
	timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<ChannelReleaseResult | null> {
	const requestId = globalThis.crypto.randomUUID();
	return await new Promise<ChannelReleaseResult | null>((resolve) => {
		let settled = false;
		const finish = (result: ChannelReleaseResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		timer.unref?.();
		const unsubscribe = events.on(CHANNEL_RELEASE_RESULT, (data) => {
			const result = data as ChannelReleaseResult | undefined;
			if (!result || result.requestId !== requestId) return;
			finish(result);
		});
		events.emit(CHANNEL_RELEASE, { requestId, provider } satisfies ChannelReleaseRequest);
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
	/**
	 * The user asked to keep answering in the terminal instead (the 「回到 TUI」
	 * button or the reserved `tui` reply): nothing was answered, `text` is empty.
	 */
	tuiHandoff?: boolean;
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
	/**
	 * Message ids of the cards sent for this question (one per receiver). A
	 * text-reply handoff locks all of them — the card the user did not click
	 * would otherwise stay clickable.
	 */
	cardMessageIds?: readonly string[];
}

export interface RemoteTransport {
	send(receiver: FeishuReceiver, text: string): Promise<void>;
	/** Send an interactive card (V2 schema); resolves with its message id when known. */
	sendCard(receiver: FeishuReceiver, card: object): Promise<string | undefined>;
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

/** How the transports reach the pi-channel plugin; the timeouts are test seams. */
export interface ChannelTransportDeps {
	events: EventsLike;
	/** Outbound send timeout (default 10s — the plugin's own request budget). */
	sendTimeoutMs?: number;
	/** One-shot plugin readiness probe timeout (default 1.5s). */
	probeTimeoutMs?: number;
	/** Inbound-readiness wait before the first send (default 10s — the measured cold handshake is ~2.5s). */
	connectTimeoutMs?: number;
	/** 诊断日志开关（配置顶层 `debug`）：开则写 debug.log，默认关。 */
	debug?: boolean;
}

abstract class ChannelTransportBase<Reply> {
	protected abstract readonly provider: ChannelProvider;
	protected readonly events: EventsLike;
	protected readonly sendTimeoutMs: number;
	protected readonly probeTimeoutMs: number;
	protected readonly connectTimeoutMs: number;

	private active = true;
	private unsubscribe: (() => void) | undefined;
	private cancelPending: (() => void) | undefined;
	/** 记忆化的一次性就绪探测；一旦失败，之后每次发送都直接沿用该拒绝。 */
	private readinessProbe: Promise<void> | undefined;
	/** 记忆化的一次性入站就绪请求（见 `ensureInboundChannel`）。 */
	private inboundProbe: Promise<void> | undefined;
	/** 本次 transport 是否成功持有过入站（`close()` 要按同一语义释放，保证与插件的计数配对）。 */
	private inboundAcquired = false;

	constructor(deps: ChannelTransportDeps) {
		this.events = deps.events;
		this.sendTimeoutMs = deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
		this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
		this.connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		setTransportDebug(deps.debug === true);
	}

	/**
	 * 首次发送前的就绪探测。为什么：插件缺席时 `sendViaBus` 只能等满
	 * `sendTimeoutMs`（默认 10s）才报 timeout；provider 未配置时发送也永远
	 * 不会成功。提前探测让失败更快、错误码更准（plugin_missing / not_configured）。
	 * 探测结果按实例记忆化：后续发送不再重复探测，失败也直接沿用。
	 */
	private ensurePluginReady(): Promise<void> {
		this.readinessProbe ??= (async () => {
			const status = await statusViaBus(this.events, this.probeTimeoutMs);
			if (status === null) {
				throw new ChannelSendError(
					"plugin_missing",
					"the pi-channel plugin is not loaded (no ag-pi-channel:status reply)",
				);
			}
			const provider = status.providers.find((p) => p.provider === this.provider);
			if (!provider?.configured) {
				throw new ChannelSendError(
					"not_configured",
					`pi-channel has no ${this.provider} configuration (${status.configPath})`,
				);
			}
		})();
		return this.readinessProbe;
	}

	/**
	 * 首次发送前确保插件的入站通道就绪。为什么：插件是惰性连接的 —— 它要等第一次发送成功后才去建
	 * 长连接，于是最先发出的那张卡片会在「平台还没法投递点击」的状态下等约 2.5s，窗口内的点击直接
	 * 丢失（客户端 3s 超时后重试，用户观感是「点了好几次才生效」）。先请求就绪再发首条，即拆分前
	 * connect-then-send 的时序。
	 *
	 * 已连接时零额外开销；插件不支持该请求（老版本 / 未加载）时不阻塞发送 —— 发送自己会给出准确的
	 * 错误码，这里只负责把窗口消掉。
	 */
	private ensureInboundChannel(): Promise<void> {
		this.inboundProbe ??= (async () => {
			await this.ensurePluginReady();
			// 即使 status 显示已连接也照发 connect：持有是**计数**语义，必须与 close() 的 release 严格配对。
			// 「已连接就跳过」会留下竞态：上一份问卷的 release 在下一份问卷进行中把连接关掉。
			const result = await connectViaBus(this.events, this.provider, this.connectTimeoutMs);
			if (result?.ok) this.inboundAcquired = true;
		})().catch(() => undefined);
		return this.inboundProbe;
	}

	/** Emit one send request and reject when the plugin reports a failure or the request times out. */
	protected async sendRequest(request: ChannelSendInput): Promise<string | undefined> {
		const startedAt = Date.now();
		const kind = "update" in request && request.update ? `${request.kind}(update)` : request.kind;
		logDebug(`[send] start provider=${request.provider} kind=${kind}`);
		try {
			await this.ensureInboundChannel();
			await this.ensurePluginReady();
			const result = await sendViaBus(this.events, request, this.sendTimeoutMs);
			if (!result.ok) {
				const code = result.error?.code ?? "unknown";
				const message = result.error?.message ?? `channel ${request.provider} ${request.kind} request failed`;
				throw new ChannelSendError(code, message);
			}
			logDebug(`[send] ok in ${Date.now() - startedAt}ms msg=${result.messageId ?? "-"}`);
			return result.messageId;
		} catch (err) {
			const { code } = classifyRemoteError(err);
			logDebug(`[send] FAIL in ${Date.now() - startedAt}ms code=${code}`);
			throw err;
		}
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
			const startedAt = Date.now();
			logDebug(`[wait] start provider=${this.provider} timeout=${timeoutMs}ms`);
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (reply: Reply | null) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				this.unsubscribe?.();
				this.unsubscribe = undefined;
				this.cancelPending = undefined;
				logDebug(
					`[wait] resolve in ${Date.now() - startedAt}ms ${reply === null ? "timeout/closed" : JSON.stringify(reply).slice(0, 200)}`,
				);
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
		this.releaseInbound();
	}

	/**
	 * 用完入站：通知插件清掉本次持有（`ag-pi-channel:release`，与首次发送前的 connect 配对）。
	 * fire-and-forget —— 结束流程不该被总线往返拖住；插件侧计数归零才会真正断开连接，
	 * 于是问卷结束后本进程不再占着飞书长连接（正是「多个 pi 进程抢回调」的根治点）。
	 */
	private releaseInbound(): void {
		if (!this.inboundAcquired) return;
		this.inboundAcquired = false;
		void releaseViaBus(this.events, this.provider, this.connectTimeoutMs).catch(() => undefined);
	}
}

class FeishuBusTransport extends ChannelTransportBase<RemoteReply> implements RemoteTransport {
	protected readonly provider: ChannelProvider = "feishu";
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

	async sendCard(receiver: FeishuReceiver, card: object): Promise<string | undefined> {
		return await this.sendRequest({
			provider: "feishu",
			kind: "card",
			to: { id: receiver.value, type: receiver.type },
			feishuCard: card,
		});
	}

	async updateCard(messageId: string, card: object): Promise<void> {
		await this.sendRequest({ provider: "feishu", kind: "card", feishuCard: card, update: { messageId } });
	}

	waitForReply(timeoutMs: number, onNonText?: () => void, card?: CardReplyContext): Promise<RemoteReply | null> {
		return this.waitForInbound(timeoutMs, (evt, finish) => {
			logDebug(
				`[evt] provider=${evt.provider} kind=${evt.kind} chat=${evt.chatId} msg=${evt.messageId} ${
					evt.kind === "message"
						? `type=${evt.contentType} text=${JSON.stringify(evt.text).slice(0, 80)}`
						: `value=${JSON.stringify(evt.value).slice(0, 120)}`
				}`,
			);
			if (evt.provider !== "feishu") return;

			if (evt.kind === "message") {
				// Non-text messages (sticker, image, file, …) never answer a question.
				if (evt.contentType !== "text" || evt.text.trim().length === 0) {
					logDebug("[drop] non-text");
					onNonText?.();
					return;
				}
				// p2p: any sender answers (the only people who get the question in DM
				// are the configured receivers). group: the chat must be one of the
				// configured chat_id receivers; the plugin's requireMention policy
				// already guarantees the bot was @'d.
				if (evt.chatType !== "p2p" && !this.groupChatIds.has(evt.chatId)) {
					logDebug(`[drop] chat-filter(message) chat=${evt.chatId}`);
					return;
				}
				// The reserved 「回到 TUI」 reply: the user wants to keep answering in
				// the terminal — lock the question's cards (when cards were sent) and
				// hand the flow back. Works in text mode too, which advertises it.
				if (isTuiHandoffWord(evt.text)) {
					logDebug("[act] tui-handoff(keyword)");
					if (card) this.lockCards(card, true);
					finish(this.handoffReply(evt));
					return;
				}
				logDebug("[act] answer(text)");
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
			if (!card) {
				logDebug("[drop] no-card-ctx");
				return;
			}
			if (this.groupChatIds.size > 0 && !this.groupChatIds.has(evt.chatId)) {
				logDebug(`[drop] chat-filter(action) chat=${evt.chatId}`);
				return;
			}
			const value = evt.value as CardButtonValue | undefined;
			if (!value || typeof value !== "object") {
				logDebug("[drop] bad-value");
				return;
			}
			if (String(card.index) !== String(value.q)) {
				logDebug(`[drop] stale-q wait=${card.index} card=${value.q}`);
				return;
			}

			// 「回到 TUI」: nothing is answered — lock every card sent for this
			// question and let the caller continue in the terminal.
			if (value.t === "1") {
				logDebug("[act] tui-handoff(button)");
				this.lockCards(card, true, evt.messageId);
				finish(this.handoffReply(evt));
				return;
			}

			const isCancel = value.c === "1";
			const optionNum = typeof value.o === "string" ? Number.parseInt(value.o, 10) : NaN;
			const selectedIndex = isCancel || !Number.isFinite(optionNum) ? undefined : optionNum - 1;
			const updatedCard = buildQuestionCard(card.question, card.index, selectedIndex, isCancel);
			// Lock the card via the update API: ✓ on the chosen button, everything
			// else disabled. The 3s callback ack (toast) is handled by the plugin
			// from the button value's `ackText`.
			logDebug(`[act] answer(button) o=${value.o ?? "-"} c=${value.c ?? "-"}`);
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

	/** Reply shape for the 「回到 TUI」 handoff: nothing was answered, so `text` is empty. */
	private handoffReply(evt: ChannelInboundMessage | ChannelInboundAction): RemoteReply {
		return {
			text: "",
			chatId: evt.chatId,
			chatType: this.chatTypeOf(evt),
			senderId: evt.senderId,
			messageId: evt.messageId,
			tuiHandoff: true,
		};
	}

	/**
	 * Lock the card(s) sent for the pending question and, when `handedOff` is
	 * true, mark them as moved to the terminal. Tracked ids come first (every
	 * receiver's card must stop accepting answers); a click without tracked ids
	 * still locks its own card via `fallbackMessageId` — a text reply has no
	 * card to point at.
	 */
	private lockCards(card: CardReplyContext, handedOff: boolean, fallbackMessageId?: string): void {
		const ids = card.cardMessageIds?.length ? card.cardMessageIds : fallbackMessageId ? [fallbackMessageId] : [];
		const updated = buildQuestionCard(card.question, card.index, undefined, false, handedOff);
		for (const id of ids) void this.updateCard(id, updated).catch(() => undefined);
	}

	/** Feishu p2p/group label; action events may lack `chatType`, so fall back to the receiver set. */
	private chatTypeOf(evt: ChannelInboundEvent): "p2p" | "group" {
		if (evt.chatType === "p2p" || evt.chatType === "group") return evt.chatType;
		return this.groupChatIds.has(evt.chatId) ? "group" : "p2p";
	}
}

class TgBusTransport extends ChannelTransportBase<TgReply> implements TgTransport {
	protected readonly provider: ChannelProvider = "telegram";
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
		const messageId =
			keyboard === undefined
				? await this.sendRequest({
						provider: "telegram",
						kind: "text",
						to: { id: this.tgCfg.chatId },
						text,
						parseMode: "HTML",
					})
				: await this.sendRequest({
						provider: "telegram",
						kind: "card",
						to: { id: this.tgCfg.chatId },
						text,
						telegramKeyboard: keyboard,
						parseMode: "HTML",
					});
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
			telegramKeyboard: buildTgDoneKeyboard(),
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
