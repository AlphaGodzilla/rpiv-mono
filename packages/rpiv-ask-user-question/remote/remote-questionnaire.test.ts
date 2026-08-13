import { describe, expect, it, vi } from "vitest";
import type { QuestionData } from "../tool/types.js";
import type { RemoteReply, RemoteTransport } from "./feishu-channel.js";
import { loadRemoteConfig, type RemoteConfig } from "./remote-config.js";
import { type RemoteQuestion, runRemoteQuestionnaire } from "./remote-questionnaire.js";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "Pick",
		options: over.options ?? [
			{ label: "A", description: "a-desc" },
			{ label: "B", description: "b-desc" },
		],
		multiSelect: over.multiSelect,
	};
}

function makeCfg(over: Partial<RemoteConfig> = {}, useCards = true): RemoteConfig {
	return loadRemoteConfig({
		enabled: true,
		timeoutMs: 10_000,
		cancelWords: ["取消", "cancel"],
		feishu: {
			appId: "cli_1",
			appSecret: "s",
			useCards,
			receivers: [
				{ type: "email", value: "me@example.com" },
				{ type: "chat_id", value: "oc_1" },
			],
		},
		...over,
	});
}

function reply(text: string, over: Partial<RemoteReply> = {}): RemoteReply {
	return { text, chatId: "oc_x", chatType: "p2p", senderId: "ou_1", messageId: "om_1", ...over };
}

function makeTransport(over: Partial<RemoteTransport> = {}): RemoteTransport {
	return {
		send: vi.fn(async () => undefined),
		sendCard: vi.fn(async () => undefined),
		updateCard: vi.fn(async () => undefined),
		waitForReply: vi.fn(async () => reply("1")),
		close: vi.fn(async () => undefined),
		...over,
	};
}

const questions: RemoteQuestion[] = [
	{ question: makeQuestion({ question: "Q1" }), index: 0 },
	{ question: makeQuestion({ question: "Q2" }), index: 2 },
];

describe("runRemoteQuestionnaire", () => {
	it("walks every question, sends to every receiver, and merges answers with original indices", async () => {
		const transport = makeTransport();
		vi.mocked(transport.waitForReply)
			.mockResolvedValueOnce(reply("1"))
			.mockResolvedValueOnce(reply("2", { chatType: "group", chatId: "oc_1" }));
		const notify = vi.fn();

		const outcome = await runRemoteQuestionnaire(transport, questions, makeCfg({}, false), notify);

		expect(outcome.kind).toBe("answered");
		if (outcome.kind !== "answered") return;
		expect(outcome.result.cancelled).toBe(false);
		expect(outcome.result.answers).toEqual([
			{ questionIndex: 0, question: "Q1", kind: "option", answer: "A" },
			{ questionIndex: 2, question: "Q2", kind: "option", answer: "B" },
		]);
		// 2 questions × 2 receivers
		expect(transport.send).toHaveBeenCalledTimes(4);
		// Sent to both receiver kinds
		const sends = vi.mocked(transport.send).mock.calls.map(([r]) => r.type);
		expect(sends).toEqual(["email", "chat_id", "email", "chat_id"]);
		// Notified once per question, numbering follows the ORIGINAL index + 1
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Question 1 sent to Feishu"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Question 3 sent to Feishu"), "info");
	});

	it("aborts with cancelled when the user replies a cancel word, keeping collected answers", async () => {
		const transport = makeTransport();
		vi.mocked(transport.waitForReply).mockResolvedValueOnce(reply("1")).mockResolvedValueOnce(reply("取消"));

		const outcome = await runRemoteQuestionnaire(transport, questions, makeCfg({}, false), vi.fn());

		expect(outcome.kind).toBe("answered");
		if (outcome.kind !== "answered") return;
		expect(outcome.result.cancelled).toBe(true);
		expect(outcome.result.answers).toHaveLength(1);
		expect(outcome.result.answers[0].questionIndex).toBe(0);
	});

	it("cancels the whole questionnaire when a per-question wait times out", async () => {
		const transport = makeTransport();
		vi.mocked(transport.waitForReply).mockResolvedValueOnce(reply("1")).mockResolvedValueOnce(null);

		const outcome = await runRemoteQuestionnaire(transport, questions, makeCfg({ timeoutMs: 500 }, false), vi.fn());

		expect(outcome.kind).toBe("answered");
		if (outcome.kind !== "answered") return;
		expect(outcome.result.cancelled).toBe(true);
	});

	it("routes the timeout from cfg into waitForReply", async () => {
		const transport = makeTransport();
		await runRemoteQuestionnaire(transport, questions, makeCfg({ timeoutMs: 42_000 }, false), vi.fn());
		expect(vi.mocked(transport.waitForReply).mock.calls[0][0]).toBe(42_000);
	});

	it("surfaces a send failure as a failed outcome with partial answers", async () => {
		const transport = makeTransport({
			send: vi.fn(async () => {
				const err = new Error("app secret wrong") as Error & { code?: string };
				err.code = "permission_denied";
				throw err;
			}),
		});
		const notify = vi.fn();

		const outcome = await runRemoteQuestionnaire(transport, questions, makeCfg({}, false), notify);

		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.message).toContain("permission_denied");
		expect(outcome.message).toContain("me@example.com");
		expect(outcome.partialAnswers).toEqual([]);
	});

	it("notifies when a non-text reply arrives (onNonText wired to notify)", async () => {
		const transport = makeTransport();
		const notify = vi.fn();
		vi.mocked(transport.waitForReply).mockImplementationOnce((_t, onNonText) => {
			onNonText?.();
			return Promise.resolve(reply("1"));
		});

		const outcome = await runRemoteQuestionnaire(transport, [questions[0]], makeCfg(), notify);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("text"), "info");
		expect(outcome.kind).toBe("answered");
	});

	it("uses custom cancel words from config", async () => {
		const transport = makeTransport();
		vi.mocked(transport.waitForReply).mockResolvedValueOnce(reply("stop"));
		const outcome = await runRemoteQuestionnaire(
			transport,
			[questions[0]],
			makeCfg({ cancelWords: ["stop"] }),
			vi.fn(),
		);
		expect(outcome.kind).toBe("answered");
		if (outcome.kind !== "answered") return;
		expect(outcome.result.cancelled).toBe(true);
	});
});

describe("runRemoteQuestionnaire — card mode", () => {
	it("sends interactive cards instead of text when useCards is enabled", async () => {
		const transport = makeTransport();
		vi.mocked(transport.waitForReply).mockResolvedValueOnce(reply("1"));
		const outcome = await runRemoteQuestionnaire(transport, [questions[0]], makeCfg(), vi.fn());
		expect(outcome.kind).toBe("answered");
		expect(transport.sendCard).toHaveBeenCalledTimes(2); // 2 receivers
		expect(transport.send).not.toHaveBeenCalled();
		const card = vi.mocked(transport.sendCard).mock.calls[0][1] as { schema: string };
		expect(card.schema).toBe("2.0");
	});

	it("falls back to plain text when the card send fails", async () => {
		const transport = makeTransport({
			sendCard: vi.fn(async () => {
				throw new Error("interactive not allowed");
			}),
		});
		const outcome = await runRemoteQuestionnaire(transport, [questions[0]], makeCfg(), vi.fn());
		expect(outcome.kind).toBe("answered");
		expect(transport.send).toHaveBeenCalledTimes(2);
	});

	it("passes the card reply context (question, index, cancelWord) into waitForReply", async () => {
		const transport = makeTransport();
		await runRemoteQuestionnaire(transport, questions, makeCfg(), vi.fn());
		const ctx = vi.mocked(transport.waitForReply).mock.calls[0][2];
		expect(ctx).toEqual({ question: questions[0].question, index: 0, cancelWord: "取消" });
	});
});
