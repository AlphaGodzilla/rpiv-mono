import { describe, expect, it, vi } from "vitest";
import { makeQuestion } from "../test-fixtures.js";
import {
	CHANNEL_INBOUND,
	CHANNEL_SEND,
	CHANNEL_SEND_RESULT,
	CHANNEL_STATUS,
	CHANNEL_STATUS_RESULT,
	type ChannelInboundAction,
	type ChannelInboundEvent,
	type ChannelInboundMessage,
	type ChannelSendRequest,
	type ChannelSendResult,
	type ChannelStatusRequest,
	type ChannelStatusResult,
	createFeishuTransport,
	createTgTransport,
	type EventsLike,
} from "./channel-transport.js";
import { buildQuestionCard } from "./message-format.js";
import type { FeishuRemoteConfig, TgRemoteConfig } from "./remote-config.js";
import { buildTgAnswerNote, buildTgKeyboard, buildTgQuestionMessage } from "./tg-message.js";

/**
 * Transport-level tests for the pi-channel event bus wiring: outbound payload
 * shapes + requestId correlation, the readiness probe, the failure/timeout degradation contract,
 * and the inbound filtering/locking rules of both providers. A FakeBus stands
 * in for the plugin — no network, no real bus.
 */

class FakeBus implements EventsLike {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	readonly sends: ChannelSendRequest[] = [];
	/** Number of `ag-pi-channel:status` probes — asserted to prove memoization. */
	statusQueries = 0;
	/** Return `undefined` to stay silent (the readiness probe then times out → plugin_missing). */
	statusResponder: (request: ChannelStatusRequest) => ChannelStatusResult | undefined = (request) => ({
		requestId: request.requestId,
		configPath: "/tmp/rpiv-test/pi-channel.json",
		providers: [
			{ provider: "feishu", configured: true, connected: true },
			{ provider: "telegram", configured: true, connected: true },
		],
	});
	/** Return `undefined` to stay silent (the send then times out). */
	responder: (request: ChannelSendRequest) => ChannelSendResult | undefined = (request) => ({
		requestId: request.requestId,
		ok: true,
		messageId: `mid-${this.sends.length}`,
	});

	emit(channel: string, data: unknown): void {
		if (channel === CHANNEL_STATUS) {
			this.statusQueries += 1;
			const status = this.statusResponder(data as ChannelStatusRequest);
			if (status !== undefined) queueMicrotask(() => this.deliver(CHANNEL_STATUS_RESULT, status));
			return;
		}
		if (channel === CHANNEL_SEND) {
			const request = data as ChannelSendRequest;
			this.sends.push(request);
			const result = this.responder(request);
			if (result !== undefined) queueMicrotask(() => this.deliver(CHANNEL_SEND_RESULT, result));
			return;
		}
		this.deliver(channel, data);
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
		this.handlers.set(channel, set);
		set.add(handler);
		return () => set.delete(handler);
	}

	inbound(event: ChannelInboundEvent): void {
		this.deliver(CHANNEL_INBOUND, event);
	}

	private deliver(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

function feishuCfg(over: Partial<FeishuRemoteConfig> = {}): FeishuRemoteConfig {
	return { receivers: [{ type: "email", value: "me@example.com" }], useCards: true, ...over };
}

function tgCfg(over: Partial<TgRemoteConfig> = {}): TgRemoteConfig {
	return { chatId: "-100123", userId: 42, username: undefined, useCards: true, timeoutMs: 1_800_000, ...over };
}

function feishuMessage(over: Partial<ChannelInboundMessage> = {}): ChannelInboundMessage {
	return {
		provider: "feishu",
		kind: "message",
		chatId: "oc_p2p",
		chatType: "p2p",
		senderId: "ou_1",
		messageId: "om_1",
		text: "1",
		contentType: "text",
		...over,
	};
}

function feishuAction(over: Partial<ChannelInboundAction> = {}): ChannelInboundAction {
	return {
		provider: "feishu",
		kind: "action",
		chatId: "oc_p2p",
		senderId: "ou_1",
		messageId: "om_card",
		value: { q: "0", o: "2", ackText: "已选择" },
		...over,
	};
}

function tgMessage(over: Partial<ChannelInboundMessage> = {}): ChannelInboundMessage {
	return {
		provider: "telegram",
		kind: "message",
		chatId: "-100123",
		chatType: "group",
		senderId: "42",
		messageId: "111",
		text: "2",
		contentType: "text",
		...over,
	};
}

function tgAction(over: Partial<ChannelInboundAction> = {}): ChannelInboundAction {
	return {
		provider: "telegram",
		kind: "action",
		chatId: "-100123",
		chatType: "group",
		senderId: "42",
		messageId: "222",
		value: { q: "0", o: "2", ackText: "已选择" },
		...over,
	};
}

/** Every button value inside a Feishu V2 card, in body order. */
function feishuButtonValues(card: unknown): unknown[] {
	type Element = {
		tag?: string;
		columns?: { elements?: { behaviors?: { value?: unknown }[] }[] }[];
	};
	const elements = (card as { body?: { elements?: Element[] } }).body?.elements ?? [];
	return elements
		.filter((el) => el.tag === "column_set")
		.flatMap((el) => el.columns ?? [])
		.map((col) => col.elements?.[0]?.behaviors?.[0]?.value);
}

/**
 * Narrow a recorded send request to a Feishu card request, failing loudly when
 * the payload is not `{ provider: "feishu", kind: "card" }`.
 */
function expectFeishuCard(request: ChannelSendRequest) {
	if (request.provider !== "feishu" || request.kind !== "card") {
		throw new Error(`expected a feishu card request, got ${request.provider}/${request.kind}`);
	}
	return request;
}

/**
 * Narrow a recorded send request to a Telegram card request, failing loudly when
 * the payload is not `{ provider: "telegram", kind: "card" }`.
 */
function expectTelegramCard(request: ChannelSendRequest) {
	if (request.provider !== "telegram" || request.kind !== "card") {
		throw new Error(`expected a telegram card request, got ${request.provider}/${request.kind}`);
	}
	return request;
}

describe("feishu transport over the event bus", () => {
	it("emits a send request with provider, target and text, and resolves on the correlated result", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });

		await transport.send({ type: "email", value: "me@example.com" }, "hello");

		expect(bus.sends).toHaveLength(1);
		const sent = bus.sends[0];
		expect(sent.requestId).toBeTypeOf("string");
		expect(sent).toMatchObject({
			provider: "feishu",
			kind: "text",
			to: { id: "me@example.com", type: "email" },
			text: "hello",
		});
		expect("feishuCard" in sent).toBe(false);
	});

	it("ignores a result for another requestId (times out) and accepts the correlated one", async () => {
		const bus = new FakeBus();
		let calls = 0;
		bus.responder = (request) => {
			calls += 1;
			if (calls === 1) return { requestId: "somebody-else", ok: true, messageId: "nope" };
			return { requestId: request.requestId, ok: true, messageId: "om_2" };
		};
		const transport = await createFeishuTransport(feishuCfg(), { events: bus, sendTimeoutMs: 10 });

		await expect(transport.send({ type: "email", value: "me@example.com" }, "first")).rejects.toMatchObject({
			code: "timeout",
		});
		await expect(transport.send({ type: "email", value: "me@example.com" }, "second")).resolves.toBeUndefined();
	});

	it("rejects with the plugin's error code when the result reports ok:false", async () => {
		const bus = new FakeBus();
		bus.responder = (request) => ({
			requestId: request.requestId,
			ok: false,
			error: { code: "not_configured", message: "no credentials" },
		});
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });

		await expect(transport.send({ type: "chat_id", value: "oc_1" }, "x")).rejects.toMatchObject({
			code: "not_configured",
			message: "no credentials",
		});
	});

	it("fails fast with plugin_missing and memoizes the probe when no status reply arrives", async () => {
		const bus = new FakeBus();
		bus.statusResponder = () => undefined;
		const transport = await createFeishuTransport(feishuCfg(), {
			events: bus,
			probeTimeoutMs: 5,
			sendTimeoutMs: 60_000,
		});

		await expect(transport.send({ type: "email", value: "me@example.com" }, "first")).rejects.toMatchObject({
			code: "plugin_missing",
			message: "the pi-channel plugin is not loaded (no ag-pi-channel:status reply)",
		});
		// The rejected probe is memoized — the second send fails without another probe.
		await expect(transport.send({ type: "email", value: "me@example.com" }, "second")).rejects.toMatchObject({
			code: "plugin_missing",
		});

		expect(bus.statusQueries).toBe(1);
		expect(bus.sends).toHaveLength(0);
	});

	it("sends normally when the plugin reports the provider configured", async () => {
		const bus = new FakeBus();
		bus.statusResponder = (request) => ({
			requestId: request.requestId,
			configPath: "/tmp/rpiv-test/pi-channel.json",
			providers: [{ provider: "feishu", configured: true, connected: true }],
		});
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });

		await expect(transport.send({ type: "email", value: "me@example.com" }, "hello")).resolves.toBeUndefined();

		expect(bus.statusQueries).toBe(1);
		expect(bus.sends).toHaveLength(1);
	});

	it("maps sendCard and updateCard onto card requests (update carries the messageId)", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });
		const card = { schema: "2.0" };

		await transport.sendCard({ type: "chat_id", value: "oc_1" }, card);
		expect(bus.sends[0]).toMatchObject({
			provider: "feishu",
			kind: "card",
			to: { id: "oc_1", type: "chat_id" },
			feishuCard: card,
		});

		await transport.updateCard("om_9", card);
		expect(bus.sends[1]).toMatchObject({
			provider: "feishu",
			kind: "card",
			update: { messageId: "om_9" },
			feishuCard: card,
		});
	});

	it("accepts a p2p text reply from any sender", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });

		const pending = transport.waitForReply(1_000);
		bus.inbound(feishuMessage());

		await expect(pending).resolves.toEqual({
			text: "1",
			chatId: "oc_p2p",
			chatType: "p2p",
			senderId: "ou_1",
			messageId: "om_1",
		});
	});

	it("accepts group replies only from a configured chat_id receiver", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(
			feishuCfg({ receivers: [{ type: "chat_id", value: "oc_group" }] }),
			{
				events: bus,
			},
		);

		const pending = transport.waitForReply(1_000);
		bus.inbound(feishuMessage({ chatId: "oc_other", chatType: "group", text: "9" }));
		bus.inbound(feishuMessage({ chatId: "oc_group", chatType: "group", text: "2" }));

		await expect(pending).resolves.toMatchObject({ text: "2", chatId: "oc_group", chatType: "group" });
	});

	it("fires onNonText for non-text messages and keeps waiting", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });
		const onNonText = vi.fn();

		const pending = transport.waitForReply(1_000, onNonText);
		bus.inbound(feishuMessage({ contentType: "sticker", text: "" }));
		bus.inbound(feishuMessage({ text: "2" }));

		await expect(pending).resolves.toMatchObject({ text: "2" });
		expect(onNonText).toHaveBeenCalledTimes(1);
	});

	it("accepts a matching card click, locks the card and keeps ackText in every button value", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });
		const question = makeQuestion();

		const pending = transport.waitForReply(1_000, undefined, { question, index: 0, cancelWord: "取消" });
		bus.inbound(feishuAction());

		await expect(pending).resolves.toMatchObject({ text: "2", chatId: "oc_p2p", messageId: "om_card" });
		expect(bus.sends).toHaveLength(1);
		const update = bus.sends[0];
		expect(update).toMatchObject({ provider: "feishu", kind: "card", update: { messageId: "om_card" } });
		const lockedCard = expectFeishuCard(update);
		expect(lockedCard.feishuCard).toEqual(buildQuestionCard(question, 0, 1));
		expect(feishuButtonValues(lockedCard.feishuCard)).toEqual([
			{ q: "0", o: "1", ackText: "已选择" },
			{ q: "0", o: "2", ackText: "已选择" },
			{ q: "0", c: "1", ackText: "已取消" },
		]);
	});

	it("routes a cancel click through the configured cancel word and locks a cancelled card", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });
		const question = makeQuestion();

		const pending = transport.waitForReply(1_000, undefined, { question, index: 0, cancelWord: "取消" });
		bus.inbound(feishuAction({ value: { q: "0", c: "1", ackText: "已取消" } }));

		await expect(pending).resolves.toMatchObject({ text: "取消", messageId: "om_card" });
		expect(expectFeishuCard(bus.sends[0]).feishuCard).toEqual(buildQuestionCard(question, 0, undefined, true));
	});

	it("ignores clicks on a stale card (q mismatch) and clicks without a card context", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });
		const question = makeQuestion();

		const stale = transport.waitForReply(20, undefined, { question, index: 0, cancelWord: "取消" });
		bus.inbound(feishuAction({ value: { q: "9", o: "1", ackText: "已选择" } }));
		await expect(stale).resolves.toBeNull();

		const unprotected = transport.waitForReply(20);
		bus.inbound(feishuAction());
		await expect(unprotected).resolves.toBeNull();
		expect(bus.sends).toHaveLength(0);
	});

	it("ignores card clicks from chats outside the configured group receivers", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(
			feishuCfg({ receivers: [{ type: "chat_id", value: "oc_group" }] }),
			{
				events: bus,
			},
		);
		const question = makeQuestion();

		const pending = transport.waitForReply(1_000, undefined, { question, index: 0, cancelWord: "取消" });
		bus.inbound(feishuAction({ chatId: "oc_other" }));
		bus.inbound(feishuAction({ chatId: "oc_group" }));

		await expect(pending).resolves.toMatchObject({ text: "2", chatType: "group" });
	});

	it("resolves null when no reply arrives before the timeout", async () => {
		const bus = new FakeBus();
		const transport = await createFeishuTransport(feishuCfg(), { events: bus });

		await expect(transport.waitForReply(10)).resolves.toBeNull();
	});
});

describe("telegram transport over the event bus", () => {
	it("sends text with HTML parse mode and returns numeric ids", async () => {
		const bus = new FakeBus();
		bus.responder = (request) => ({ requestId: request.requestId, ok: true, messageId: "7" });
		const transport = createTgTransport(tgCfg(), { events: bus });

		const sent = await transport.sendText("hello <a>@u</a>");

		expect(sent).toEqual({ chatId: -100123, messageId: 7 });
		expect(bus.sends[0]).toMatchObject({
			provider: "telegram",
			kind: "text",
			to: { id: "-100123" },
			text: "hello <a>@u</a>",
			parseMode: "HTML",
		});
		expect("telegramKeyboard" in bus.sends[0]).toBe(false);
	});

	it("sends the reply_markup keyboard as a card with HTML parse mode", async () => {
		const bus = new FakeBus();
		const transport = createTgTransport(tgCfg(), { events: bus });
		const keyboard = buildTgKeyboard(makeQuestion(), 0);

		await transport.sendCard("question", keyboard);

		expect(bus.sends[0]).toMatchObject({
			provider: "telegram",
			kind: "card",
			to: { id: "-100123" },
			text: "question",
			telegramKeyboard: keyboard,
			parseMode: "HTML",
		});
	});

	it("rejects with the plugin's error code when the result reports ok:false", async () => {
		const bus = new FakeBus();
		bus.responder = (request) => ({
			requestId: request.requestId,
			ok: false,
			error: { code: "no_target", message: "telegram send needs to.id" },
		});
		const transport = createTgTransport(tgCfg(), { events: bus });

		await expect(transport.sendText("x")).rejects.toMatchObject({ code: "no_target" });
	});

	it("rejects fast with not_configured when the plugin has no telegram configuration", async () => {
		const bus = new FakeBus();
		bus.statusResponder = (request) => ({
			requestId: request.requestId,
			configPath: "/tmp/rpiv-test/pi-channel.json",
			providers: [{ provider: "feishu", configured: true, connected: true }],
		});
		const transport = createTgTransport(tgCfg(), { events: bus, probeTimeoutMs: 5, sendTimeoutMs: 60_000 });

		await expect(transport.sendText("x")).rejects.toMatchObject({
			code: "not_configured",
			message: "pi-channel has no telegram configuration (/tmp/rpiv-test/pi-channel.json)",
		});

		expect(bus.sends).toHaveLength(0);
	});

	it("accepts text only from the configured chat and @-user", async () => {
		const bus = new FakeBus();
		const transport = createTgTransport(tgCfg(), { events: bus });

		const pending = transport.waitForReply(1_000);
		bus.inbound(tgMessage({ senderId: "99" }));
		bus.inbound(tgMessage({ chatId: "-999" }));
		bus.inbound(tgMessage({ text: " 2 " }));

		await expect(pending).resolves.toEqual({ text: "2", chatId: -100123, messageId: 111 });
	});

	it("fires onNonText for non-text input from the @-user and keeps waiting", async () => {
		const bus = new FakeBus();
		const transport = createTgTransport(tgCfg(), { events: bus });
		const onNonText = vi.fn();

		const pending = transport.waitForReply(1_000, onNonText);
		bus.inbound(tgMessage({ contentType: "sticker", text: "" }));
		bus.inbound(tgMessage({ text: "1" }));

		await expect(pending).resolves.toMatchObject({ text: "1" });
		expect(onNonText).toHaveBeenCalledTimes(1);
	});

	it("ignores cancel words (ask-prd cannot be cancelled) and times out", async () => {
		const bus = new FakeBus();
		const transport = createTgTransport(tgCfg(), { events: bus });

		const pending = transport.waitForReply(20, undefined, {
			question: makeQuestion(),
			index: 0,
			cancelWord: "取消",
		});
		bus.inbound(tgMessage({ text: "取消" }));

		await expect(pending).resolves.toBeNull();
	});

	it("answers a matching button click and finalizes the card (text + empty keyboard)", async () => {
		const bus = new FakeBus();
		const transport = createTgTransport(tgCfg(), { events: bus });
		const question = makeQuestion();

		const pending = transport.waitForReply(1_000, undefined, { question, index: 0, cancelWord: "取消" });
		bus.inbound(tgAction());

		await expect(pending).resolves.toEqual({ text: "2", chatId: -100123, messageId: 222 });
		expect(bus.sends).toHaveLength(1);
		const finalize = expectTelegramCard(bus.sends[0]);
		expect(finalize).toMatchObject({
			provider: "telegram",
			kind: "card",
			to: { id: "-100123" },
			update: { messageId: "222" },
			telegramKeyboard: { inline_keyboard: [] },
			parseMode: "HTML",
		});
		expect(finalize.text).toBe(buildTgQuestionMessage(question, tgCfg()) + buildTgAnswerNote(question, 2, false));
		expect(finalize.text).toContain("✅ 已选择：B");
	});

	it("ignores stale card clicks (q mismatch) and legacy cancel clicks", async () => {
		const bus = new FakeBus();
		const transport = createTgTransport(tgCfg(), { events: bus });
		const question = makeQuestion();

		const stale = transport.waitForReply(20, undefined, { question, index: 0, cancelWord: "取消" });
		bus.inbound(tgAction({ value: { q: "9", o: "1", ackText: "已选择" } }));
		await expect(stale).resolves.toBeNull();

		const legacyCancel = transport.waitForReply(20, undefined, { question, index: 0, cancelWord: "取消" });
		bus.inbound(tgAction({ value: { q: "0", c: "1", ackText: "已取消" } }));
		await expect(legacyCancel).resolves.toBeNull();
		expect(bus.sends).toHaveLength(0);
	});

	it("ignores inbound events from the other provider", async () => {
		const bus = new FakeBus();
		const transport = createTgTransport(tgCfg(), { events: bus });

		const pending = transport.waitForReply(20);
		bus.inbound(feishuMessage());

		await expect(pending).resolves.toBeNull();
	});

	it("close() unsubscribes and settles a pending wait with null", async () => {
		const bus = new FakeBus();
		const transport = createTgTransport(tgCfg(), { events: bus });

		const pending = transport.waitForReply(60_000);
		await transport.close();

		await expect(pending).resolves.toBeNull();
	});
});
