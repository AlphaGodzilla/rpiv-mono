import { describe, expect, it, vi } from "vitest";
import { makeQuestion } from "../test-fixtures.js";
import type { RemoteConfig } from "./remote-config.js";
import type { TgReply, TgTransport } from "./tg-channel.js";
import { runTgQuestionnaire } from "./tg-questionnaire.js";

function remoteConfig(over: Partial<RemoteConfig> = {}): RemoteConfig {
	return {
		enabled: false,
		localTimeoutMs: undefined,
		timeoutMs: 600_000,
		cancelWords: ["取消", "cancel"],
		feishu: { appId: "", appSecret: "", receivers: [], useCards: true },
		tg: {
			botToken: "t",
			chatId: "c",
			userId: 1,
			username: undefined,
			useCards: true,
			timeoutMs: 1_000,
			proxy: undefined,
		},
		...over,
	};
}

function makeTransport(overrides: Partial<TgTransport> = {}): { transport: TgTransport; sends: string[] } {
	const sends: string[] = [];
	const transport: TgTransport = {
		sendText: vi.fn(async () => {
			sends.push("sendText");
			return { chatId: -100123, messageId: 1 };
		}),
		sendCard: vi.fn(async () => {
			sends.push("sendCard");
			return { chatId: -100123, messageId: 2 };
		}),
		waitForReply: vi.fn(async () => null),
		close: vi.fn(async () => undefined),
		...overrides,
	};
	return { transport, sends };
}

const reply = (text: string, messageId = 5): TgReply => ({ text, chatId: -100123, messageId });

describe("runTgQuestionnaire", () => {
	it("sends an interactive card per question and resolves a button/text answer", async () => {
		const { transport, sends } = makeTransport({
			waitForReply: vi.fn(async () => reply("2")),
		});
		const outcome = await runTgQuestionnaire(
			transport,
			[{ question: makeQuestion(), index: 0 }],
			remoteConfig(),
			() => undefined,
		);
		expect(sends).toEqual(["sendCard"]);
		expect(outcome.kind).toBe("answered");
		if (outcome.kind === "answered") {
			expect(outcome.result.answers).toEqual([
				{ questionIndex: 0, question: "Pick one", kind: "option", answer: "B" },
			]);
			expect(outcome.result.cancelled).toBe(false);
		}
	});

	it("falls back to plain text when the card send fails", async () => {
		const { transport, sends } = makeTransport({
			sendCard: vi.fn(async () => {
				sends.push("sendCard");
				throw new Error("card rejected");
			}),
			waitForReply: vi.fn(async () => reply("1")),
		});
		const outcome = await runTgQuestionnaire(
			transport,
			[{ question: makeQuestion(), index: 0 }],
			remoteConfig(),
			() => undefined,
		);
		expect(sends).toEqual(["sendCard", "sendText"]);
		expect(outcome.kind).toBe("answered");
	});

	it("uses the independent tg.timeoutMs for the wait", async () => {
		const waitForReply = vi.fn(async () => reply("1"));
		const { transport } = makeTransport({ waitForReply });
		await runTgQuestionnaire(transport, [{ question: makeQuestion(), index: 0 }], remoteConfig(), () => undefined);
		expect(waitForReply).toHaveBeenCalledWith(1_000, expect.any(Function), expect.any(Object));
	});

	it("returns timed_out with the partial answers when a question goes unanswered", async () => {
		const { transport } = makeTransport({
			waitForReply: vi.fn(async () => null),
		});
		const outcome = await runTgQuestionnaire(
			transport,
			[
				{ question: makeQuestion(), index: 0 },
				{ question: makeQuestion({ question: "Q2" }), index: 1 },
			],
			remoteConfig(),
			() => undefined,
		);
		expect(outcome.kind).toBe("timed_out");
	});

	it("aborts with cancelled=true on a cancel word reply", async () => {
		const { transport } = makeTransport({
			waitForReply: vi.fn(async () => reply("取消")),
		});
		const outcome = await runTgQuestionnaire(
			transport,
			[{ question: makeQuestion(), index: 0 }],
			remoteConfig(),
			() => undefined,
		);
		expect(outcome.kind).toBe("answered");
		if (outcome.kind === "answered") {
			expect(outcome.result.cancelled).toBe(true);
			expect(outcome.result.answers).toEqual([]);
		}
	});

	it("parses a multi-select text reply", async () => {
		const { transport } = makeTransport({
			waitForReply: vi.fn(async () => reply("1,2")),
		});
		const outcome = await runTgQuestionnaire(
			transport,
			[{ question: makeQuestion({ multiSelect: true }), index: 0 }],
			remoteConfig(),
			() => undefined,
		);
		expect(outcome.kind).toBe("answered");
		if (outcome.kind === "answered") {
			expect(outcome.result.answers[0]).toMatchObject({ kind: "multi", selected: ["A", "B"] });
		}
	});

	it("returns a failed envelope (not a decline) when a wait rejects", async () => {
		const { transport } = makeTransport({
			waitForReply: vi.fn(async () => {
				throw new Error("getUpdates 409");
			}),
		});
		const outcome = await runTgQuestionnaire(
			transport,
			[{ question: makeQuestion(), index: 0 }],
			remoteConfig(),
			() => undefined,
		);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") {
			expect(outcome.message).toContain("getUpdates 409");
			expect(outcome.partialAnswers).toEqual([]);
		}
	});
});
