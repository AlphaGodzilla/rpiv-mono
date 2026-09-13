import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { RemoteTransport } from "./remote/channel-transport.js";
import { FakeChannelBus } from "./test-fixtures.js";
import type { QuestionnaireResult, QuestionParams } from "./tool/types.js";

/**
 * Integration tests for the Feishu remote branches of the tool execute flow:
 * remote-as-primary mode, local-timeout fallback handoff, and the failure
 * envelopes. `createFeishuTransport` is mocked; the real `QuestionnaireSession`
 * runs inside the mocked `ui.custom`.
 */

const { createFeishuTransportMock, loadConfigMock } = vi.hoisted(() => ({
	createFeishuTransportMock: vi.fn<() => Promise<RemoteTransport>>(),
	loadConfigMock: vi.fn(),
}));

vi.mock("./remote/channel-transport.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./remote/channel-transport.js")>();
	return { ...actual, createFeishuTransport: createFeishuTransportMock };
});

vi.mock("./config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./config.js")>();
	return { ...actual, loadConfig: loadConfigMock };
});

// The real QuestionnaireSession is exercised by the session-level tests; here
// the integration harness only needs the handoff surface the fallback calls.
// (The lazy dynamic import would not settle under fake timers, so mocking the
// module also keeps the timeout path deterministic.)
vi.mock("./state/questionnaire-session.js", () => ({
	QuestionnaireSession: class {
		private readonly done: (result: QuestionnaireResult) => void;
		readonly component = {
			render: () => [] as string[],
			invalidate: () => undefined,
			handleInput: () => undefined,
		};
		constructor(config: { done: (result: QuestionnaireResult) => void }) {
			this.done = config.done;
		}
		setOverlayHandle(): void {}
		toggleCollapsedExternal(): void {}
		extractPartialAnswersAndClose(): QuestionnaireResult {
			const result: QuestionnaireResult = { answers: [], cancelled: false };
			this.done(result);
			return result;
		}
	},
}));

function makeParams(over: Partial<QuestionParams> = {}): QuestionParams {
	return {
		questions: over.questions ?? [
			{
				question: "Which library?",
				header: "Lib",
				options: [
					{ label: "A", description: "aaa" },
					{ label: "B", description: "bbb" },
				],
			},
		],
	};
}

function fullRemoteConfig(enabled: boolean, localTimeoutMs?: number) {
	return {
		enabled,
		localTimeoutMs,
		timeoutMs: 60_000,
		cancelWords: ["取消", "cancel"],
		feishu: {
			useCards: false,
			receivers: [{ type: "email", value: "me@example.com" }],
		},
	};
}

function makeTransport(): RemoteTransport {
	return {
		send: vi.fn(async () => undefined),
		sendCard: vi.fn(async () => undefined),
		updateCard: vi.fn(async () => undefined),
		waitForReply: vi.fn<RemoteTransport["waitForReply"]>(async () => ({
			text: "1",
			chatId: "oc_x",
			chatType: "p2p" as const,
			senderId: "ou_1",
			messageId: "om_1",
		})),
		close: vi.fn(async () => undefined),
	};
}

type Execute = (
	toolCallId: string,
	params: QuestionParams,
	signal: undefined,
	onUpdate: undefined,
	ctx: {
		hasUI: boolean;
		cwd: string;
		isProjectTrusted: () => boolean;
		ui: {
			notify: ReturnType<typeof vi.fn>;
			onTerminalInput?: (cb: (data: string) => unknown) => () => void;
			custom: ReturnType<typeof vi.fn>;
			select?: ReturnType<typeof vi.fn>;
			input?: ReturnType<typeof vi.fn>;
		};
	} & Record<string, unknown>,
) => Promise<unknown>;

interface Harness {
	execute: Execute;
	ctx: {
		hasUI: boolean;
		cwd: string;
		isProjectTrusted: () => boolean;
		ui: {
			notify: ReturnType<typeof vi.fn>;
			onTerminalInput?: (cb: (data: string) => unknown) => () => void;
			custom: ReturnType<typeof vi.fn>;
		};
	};
	events: FakeChannelBus;
	/** Resolve the pending ui.custom with a result (user submit / cancel). */
	resolveCustom: (result: QuestionnaireResult) => void;
}

function makeHarness(): Harness {
	let pendingResolve: ((r: QuestionnaireResult) => void) | undefined;

	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		isProjectTrusted: () => true,
		ui: {
			notify: vi.fn(),
			onTerminalInput: vi.fn(() => () => undefined),
			custom: vi.fn(
				(
					renderFn: (
						tui: unknown,
						theme: unknown,
						keybindings: unknown,
						done: (r: QuestionnaireResult) => void,
					) => unknown,
				) => {
					renderFn(
						{ terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
						makeTheme() as unknown as Theme,
						{ matches: () => false },
						(result) => pendingResolve?.(result),
					);
					return new Promise<QuestionnaireResult>((resolve) => {
						pendingResolve = resolve;
					});
				},
			),
		},
	};

	const events = new FakeChannelBus();
	const pi = {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn(),
		events,
		getActiveTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	} as unknown as Parameters<typeof registerAskUserQuestionTool>[0];

	registerAskUserQuestionTool(pi);
	const tool = vi.mocked(pi.registerTool).mock.calls[0][0] as unknown as { execute: Execute };
	return {
		execute: tool.execute.bind(tool),
		ctx,
		events,
		resolveCustom: (result) => {
			const r = pendingResolve;
			pendingResolve = undefined;
			r?.(result);
		},
	};
}

describe("ask_user_question — Feishu remote as primary mode", () => {
	beforeEach(() => {
		createFeishuTransportMock.mockReset();
		loadConfigMock.mockReset();
		loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(true) });
	});

	it("routes the whole questionnaire to Feishu without opening the local dialog", async () => {
		const transport = makeTransport();
		createFeishuTransportMock.mockResolvedValue(transport);
		const h = makeHarness();

		const result = await h.execute("t1", makeParams(), undefined, undefined, h.ctx);

		expect(h.ctx.ui.custom).not.toHaveBeenCalled();
		expect(createFeishuTransportMock).toHaveBeenCalledTimes(1);
		expect(transport.send).toHaveBeenCalledTimes(1);
		expect(transport.close).toHaveBeenCalledTimes(1);
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain("User has answered your questions");
		expect(content).toContain('"Which library?"="A"');
	});

	it("keeps an in-flight remote wait alive when remote mode is switched off mid-wait", async () => {
		const transport = makeTransport();
		// `/rpiv-ask-user-question remote off` (or `prd off`) only ever affects the NEXT
		// ask: a questionnaire that is already waiting on the card holds the config
		// snapshot it started with, so the reply to that wait must still be accepted
		// and the flow must not fall back to the local dialog half-way through.
		transport.waitForReply = vi.fn<RemoteTransport["waitForReply"]>(async () => {
			loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(false) });
			return {
				text: "1",
				chatId: "oc_x",
				chatType: "p2p" as const,
				senderId: "ou_1",
				messageId: "om_1",
			};
		});
		createFeishuTransportMock.mockResolvedValue(transport);
		const h = makeHarness();

		const result = await h.execute("t1", makeParams(), undefined, undefined, h.ctx);

		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain("User has answered your questions");
		expect(content).toContain('"Which library?"="A"');
		expect(h.ctx.ui.custom).not.toHaveBeenCalled();
	});
	it("emits blocked events around the remote wait", async () => {
		const transport = makeTransport();
		createFeishuTransportMock.mockResolvedValue(transport);
		const h = makeHarness();

		await h.execute("t1", makeParams(), undefined, undefined, h.ctx);

		const emits = h.events.emit.mock.calls
			.filter(([name]) => name === "rpiv:ask-user:blocked")
			.map(([, payload]) => payload);
		expect(emits).toEqual([{ active: true }, { active: false }]);
	});

	it("returns a decline-style failure envelope when the connection fails", async () => {
		const err = new Error("bad secret") as Error & { code?: string };
		err.code = "permission_denied";
		createFeishuTransportMock.mockRejectedValue(err);
		const h = makeHarness();

		const result = await h.execute("t1", makeParams(), undefined, undefined, h.ctx);

		const text = (result as { content: { text: string }[] }).content[0].text;
		expect(text).toContain("never saw the questions");
		expect(text).toContain("permission_denied");
		expect(text).toContain("do NOT treat this as a decline");
		// ③ The user sees the failure too — not just the model.
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("permission_denied"), "error");
	});

	it("falls back to the local questionnaire with a warning when the pi-channel plugin is absent", async () => {
		vi.useFakeTimers();
		try {
			const h = makeHarness();
			h.events.status = null; // no ag-pi-channel:status reply → no plugin
			const promise = h.execute("t1", makeParams(), undefined, undefined, h.ctx);

			// The readiness probe waits out its 1.5s timeout before falling back.
			await vi.advanceTimersByTimeAsync(2_000);
			expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);

			h.resolveCustom({
				answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "A" }],
				cancelled: false,
			});
			const result = await promise;

			expect(createFeishuTransportMock).not.toHaveBeenCalled();
			expect(h.ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("the pi-channel plugin is not loaded"),
				"warning",
			);
			const content = (result as { content: { text: string }[] }).content[0].text;
			expect(content).toContain('"Which library?"="A"');
		} finally {
			vi.useRealTimers();
		}
	});

	it("recovers to the local ask when the Feishu wait times out, merging answers by original index", async () => {
		const transport = makeTransport();
		vi.mocked(transport.waitForReply)
			.mockResolvedValueOnce({ text: "1", chatId: "oc_x", chatType: "p2p", senderId: "ou_1", messageId: "om_1" })
			.mockResolvedValueOnce(null);
		createFeishuTransportMock.mockResolvedValue(transport);
		const h = makeHarness();
		const twoQuestions = makeParams({
			questions: [
				{
					question: "Q1",
					header: "H1",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2",
					header: "H2",
					options: [
						{ label: "X", description: "x" },
						{ label: "Y", description: "y" },
					],
				},
			],
		});

		const pending = h.execute("t1", twoQuestions, undefined, undefined, h.ctx);

		// Q1 answered on Feishu; Q2 times out → the local dialog re-asks Q2.
		await vi.waitFor(() => {
			expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);
		});
		h.resolveCustom({
			answers: [{ questionIndex: 0, question: "Q2", kind: "option", answer: "Y" }],
			cancelled: false,
		});
		const result = await pending;

		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain('"Q1"="A"');
		expect(content).toContain('"Q2"="Y"');
		expect(transport.close).toHaveBeenCalledTimes(1);
		// Blocked stays ON across the whole wait (remote + local recovery); the
		// inner local dialog closes first, then the outer remote wait.
		const emits = h.events.emit.mock.calls
			.filter(([name]) => name === "rpiv:ask-user:blocked")
			.map(([, payload]) => payload);
		expect(emits).toEqual([{ active: true }, { active: true }, { active: false }, { active: false }]);
	});

	it("re-asks ALL questions locally when every Feishu wait times out and the user cancels", async () => {
		const transport = makeTransport();
		vi.mocked(transport.waitForReply).mockResolvedValue(null);
		createFeishuTransportMock.mockResolvedValue(transport);
		const h = makeHarness();

		const pending = h.execute("t1", makeParams(), undefined, undefined, h.ctx);

		await vi.waitFor(() => {
			expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);
		});
		h.resolveCustom({ answers: [], cancelled: true });
		const result = await pending;

		const text = (result as { content: { text: string }[] }).content[0].text;
		expect(text).toContain("User declined to answer questions");
	});
});

describe("ask_user_question — local timeout fallback", () => {
	beforeEach(() => {
		createFeishuTransportMock.mockReset();
		loadConfigMock.mockReset();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("hands the unanswered questions to Feishu after the local timeout and merges the envelope", async () => {
		loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(false, 5_000) });
		const transport = makeTransport();
		createFeishuTransportMock.mockResolvedValue(transport);
		const h = makeHarness();

		const pending = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.advanceTimersByTimeAsync(100);
		expect(h.ctx.ui.custom).toHaveBeenCalled();

		// Timeout fires → session closes with no answers → all questions go remote.
		await vi.advanceTimersByTimeAsync(4_900);
		const result = await pending;

		expect(createFeishuTransportMock).toHaveBeenCalledTimes(1);
		expect(transport.send).toHaveBeenCalledTimes(1);
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain('"Which library?"="A"');
	});

	it("does not hand off when the local dialog already resolved all questions", async () => {
		loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(false, 5_000) });
		const transport = makeTransport();
		createFeishuTransportMock.mockResolvedValue(transport);
		const twoQuestions = makeParams({
			questions: [
				{
					question: "Q1",
					header: "H1",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
				{
					question: "Q2",
					header: "H2",
					options: [
						{ label: "X", description: "x" },
						{ label: "Y", description: "y" },
					],
				},
			],
		});
		const h = makeHarness();

		const pending = h.execute("t1", twoQuestions, undefined, undefined, h.ctx);
		await vi.advanceTimersByTimeAsync(100);
		// The local dialog completes (all questions answered) before the timeout fires.
		h.resolveCustom({
			answers: [
				{ questionIndex: 0, question: "Q1", kind: "option", answer: "A" },
				{ questionIndex: 1, question: "Q2", kind: "option", answer: "X" },
			],
			cancelled: false,
		});
		const result = await pending;

		// Local dialog completed before the timeout → no remote handoff at all.
		expect(createFeishuTransportMock).not.toHaveBeenCalled();
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain('"Q1"="A"');
		expect(content).toContain('"Q2"="X"');
	});

	it("respects a local cancel and never hands off to Feishu", async () => {
		loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(false, 5_000) });
		const h = makeHarness();

		const pending = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.advanceTimersByTimeAsync(100);
		h.resolveCustom({ answers: [], cancelled: true });
		const result = await pending;

		expect(createFeishuTransportMock).not.toHaveBeenCalled();
		const text = (result as { content: { text: string }[] }).content[0].text;
		expect(text).toContain("User declined to answer questions");
	});

	it("does not start a local timeout when localTimeoutMs is not configured", async () => {
		loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(false, undefined) });
		const h = makeHarness();

		const pending = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.advanceTimersByTimeAsync(100);
		h.resolveCustom({
			answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "A" }],
			cancelled: false,
		});
		const result = await pending;

		expect(createFeishuTransportMock).not.toHaveBeenCalled();
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain('"Which library?"="A"');
	});

	it("does not start a local timeout when no receiver is configured", async () => {
		loadConfigMock.mockReturnValue({
			remote: {
				enabled: false,
				localTimeoutMs: 5_000,
				feishu: { receivers: [] },
			},
		});
		const h = makeHarness();

		const pending = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.advanceTimersByTimeAsync(100);
		h.resolveCustom({
			answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "B" }],
			cancelled: false,
		});
		const result = await pending;

		expect(createFeishuTransportMock).not.toHaveBeenCalled();
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain('"Which library?"="B"');
	});

	it("surfaces a remote failure with the local answers preserved", async () => {
		loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(false, 5_000) });
		createFeishuTransportMock.mockRejectedValue(Object.assign(new Error("timeout"), { code: "not_connected" }));
		const h = makeHarness();

		const pending = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(4_900);
		const result = await pending;

		const text = (result as { content: { text: string }[] }).content[0].text;
		expect(text).toContain("never saw the questions");
		expect(text).toContain("not_connected");
	});
	it("recovers to the local ask when the Feishu handoff also times out", async () => {
		loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(false, 5_000) });
		const transport = makeTransport();
		vi.mocked(transport.waitForReply).mockResolvedValue(null);
		createFeishuTransportMock.mockResolvedValue(transport);
		const h = makeHarness();

		const pending = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.advanceTimersByTimeAsync(100);
		expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);

		// Local timeout fires → hand off to Feishu → Feishu also stays silent →
		// the local dialog opens again for the still-unanswered question.
		await vi.advanceTimersByTimeAsync(4_900);
		expect(h.ctx.ui.custom).toHaveBeenCalledTimes(2);
		h.resolveCustom({
			answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "B" }],
			cancelled: false,
		});
		const result = await pending;

		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain('"Which library?"="B"');
	});
});
