import { describe, expect, it, vi } from "vitest";
import { makeQuestion } from "../test-fixtures.js";
import type { TgRemoteConfig } from "./remote-config.js";
import { createTgTransport, type TgTransportDeps } from "./tg-channel.js";

function tgCfg(over: Partial<TgRemoteConfig> = {}): TgRemoteConfig {
	return {
		botToken: "TOKEN",
		chatId: "-100123",
		userId: 42,
		username: undefined,
		useCards: true,
		timeoutMs: 1_800_000,
		proxy: undefined,
		...over,
	};
}

/** Record every Telegram method call (URL method + JSON body) for assertions. */
interface Call {
	method: string;
	body: Record<string, unknown>;
}

function makeTransport(handler: (url: string, body: Record<string, unknown>) => Promise<object>): {
	transport: ReturnType<typeof createTgTransport>;
	calls: Call[];
} {
	const calls: Call[] = [];
	const fakeFetch = (async (url: string, init?: RequestInit) => {
		const method = url.split("/botTOKEN/")[1] ?? "";
		const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
		calls.push({ method, body });
		const result = await handler(url, body);
		return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	const deps: TgTransportDeps = { fetch: fakeFetch, pollTimeoutSec: 0 };
	return { transport: createTgTransport(tgCfg(), deps), calls };
}

function messageUpdate(over: Record<string, unknown> = {}) {
	return {
		update_id: 1,
		message: {
			message_id: 111,
			from: { id: 42, is_bot: false, first_name: "Alice" },
			chat: { id: -100123, type: "supergroup" },
			text: "2",
			...over,
		},
	};
}

function callbackUpdate(over: Record<string, unknown> = {}) {
	return {
		update_id: 2,
		callback_query: {
			id: "cb_1",
			from: { id: 42, is_bot: false, first_name: "Alice" },
			message: { message_id: 222, chat: { id: -100123, type: "supergroup" } },
			data: JSON.stringify({ q: "0", o: "2" }),
			...over,
		},
	};
}

describe("sendText / sendCard", () => {
	it("posts sendMessage with the configured chat and returns ids", async () => {
		const { transport, calls } = makeTransport(async () => ({
			ok: true,
			result: { message_id: 5, chat: { id: -100123 } },
		}));
		const sent = await transport.sendText("hello <a>@u</a>");
		expect(sent).toEqual({ chatId: -100123, messageId: 5 });
		expect(calls[0].method).toBe("sendMessage");
		expect(calls[0].body.chat_id).toBe("-100123");
		expect(calls[0].body.parse_mode).toBe("HTML");
	});

	it("sendCard includes the reply_markup keyboard", async () => {
		const { transport, calls } = makeTransport(async () => ({
			ok: true,
			result: { message_id: 6, chat: { id: -100123 } },
		}));
		await transport.sendCard("q?", { inline_keyboard: [] });
		expect(calls[0].body.reply_markup).toEqual({ inline_keyboard: [] });
	});

	it("throws a classified error when the API returns ok:false", async () => {
		const { transport } = makeTransport(async () => ({ ok: false, error_code: 400, description: "Bad Request" }));
		await expect(transport.sendText("x")).rejects.toMatchObject({ code: "tg_sendMessage" });
	});
});

describe("waitForReply", () => {
	it("resolves with the @-user's text message from the configured chat", async () => {
		const { transport } = makeTransport(async () => ({ ok: true, result: [messageUpdate()] }));
		const reply = await transport.waitForReply(1_000);
		expect(reply).toEqual({ text: "2", chatId: -100123, messageId: 111 });
	});

	it("ignores messages from other users and keeps waiting", async () => {
		const { transport } = makeTransport(async () => ({
			ok: true,
			result: [messageUpdate({ from: { id: 99, is_bot: false, first_name: "Other" } })],
		}));
		// The only update is from another user — the wait must not resolve.
		const timer = setTimeout(() => undefined, 50);
		const reply = await transport.waitForReply(30);
		clearTimeout(timer);
		expect(reply).toBeNull(); // timed out without accepting the other user's message
	});

	it("fires onNonText for a non-text message from the @-user and keeps waiting", async () => {
		const onNonText = vi.fn();
		let polls = 0;
		const { transport } = makeTransport(async () => {
			polls += 1;
			if (polls === 1) return { ok: true, result: [messageUpdate({ text: undefined, sticker: { file_id: "x" } })] };
			return { ok: true, result: [] };
		});
		const reply = await transport.waitForReply(30, onNonText);
		expect(onNonText).toHaveBeenCalledTimes(1);
		expect(reply).toBeNull();
	});

	it("ignores updates older than the last send (pre-question noise)", async () => {
		const { transport } = makeTransport(async (url) => {
			if (url.includes("/getUpdates")) return { ok: true, result: [messageUpdate({ date: 1_700_000_000 })] };
			return { ok: true, result: { message_id: 9, chat: { id: -100123 } } };
		});
		await transport.sendCard("q", { inline_keyboard: [] }); // advances epoch past the stale update
		const reply = await transport.waitForReply(30);
		expect(reply).toBeNull();
	});

	it("accepts a button click on the sent card even when the server clock lags the client (uses server date)", async () => {
		// The question's SERVER date is older than the client clock (clock skew). The
		// baseline must be the sendMessage response date, not the client's wall clock,
		// or the callback on our own card would be mistaken for pre-question noise.
		const sentDate = 1_700_000_000;
		const { transport } = makeTransport(async (url) => {
			if (url.includes("/getUpdates")) {
				return {
					ok: true,
					result: [
						callbackUpdate({
							message: { message_id: 222, chat: { id: -100123, type: "supergroup" }, date: sentDate },
						}),
					],
				};
			}
			return { ok: true, result: { message_id: 9, chat: { id: -100123 }, date: sentDate } };
		});
		const question = makeQuestion({
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		});
		await transport.sendCard("q", { inline_keyboard: [] });
		const reply = await transport.waitForReply(1_000, undefined, { question, index: 0, cancelWord: "取消" });
		expect(reply).not.toBeNull();
	});

	it("answers a matching button click and locks the card", async () => {
		const { transport, calls } = makeTransport(async () => ({
			ok: true,
			result: [callbackUpdate()],
		}));
		const question = makeQuestion({
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		});
		const reply = await transport.waitForReply(1_000, undefined, { question, index: 0, cancelWord: "取消" });
		expect(reply).toEqual({ text: "2", chatId: -100123, messageId: 222 });
		const methods = calls.map((c) => c.method);
		expect(methods).toContain("answerCallbackQuery");
		expect(methods).toContain("editMessageReplyMarkup");
		const lock = calls.find((c) => c.method === "editMessageReplyMarkup");
		expect(lock?.body.reply_markup).toEqual({
			inline_keyboard: [
				[
					{ text: "🔒 A", callback_data: JSON.stringify({ q: "0", d: "1" }) },
					{ text: "✓ B", callback_data: JSON.stringify({ q: "0", d: "1" }) },
				],
				[{ text: "🔒 取消", callback_data: JSON.stringify({ q: "0", d: "1" }) }],
			],
		});
	});

	it("ignores clicks on a stale card (q mismatch)", async () => {
		const { transport } = makeTransport(async () => ({
			ok: true,
			result: [callbackUpdate({ data: JSON.stringify({ q: "9", o: "1" }) })],
		}));
		const question = makeQuestion();
		const reply = await transport.waitForReply(30, undefined, { question, index: 0, cancelWord: "取消" });
		expect(reply).toBeNull();
	});

	it("rejects with a classified error on getUpdates 409 conflict", async () => {
		const { transport } = makeTransport(async () => ({
			ok: false,
			error_code: 409,
			description: "Conflict: terminated by other getUpdates request",
		}));
		await expect(transport.waitForReply(1_000)).rejects.toMatchObject({ code: "tg_getUpdates" });
	});
});

describe("close", () => {
	it("resolves any pending wait to null and stops polling", async () => {
		const { transport } = makeTransport(async () => ({ ok: true, result: [] }));
		const pending = transport.waitForReply(60_000);
		await transport.close();
		await expect(pending).resolves.toBeNull();
	});
});
