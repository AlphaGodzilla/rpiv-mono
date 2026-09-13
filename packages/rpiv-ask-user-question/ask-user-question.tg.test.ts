import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import type { TgTransport } from "./remote/channel-transport.js";
import type { RemoteOutcome } from "./remote/remote-questionnaire.js";
import { FakeChannelBus } from "./test-fixtures.js";
import type { QuestionnaireResult, QuestionParams } from "./tool/types.js";

/**
 * Routing tests for the session-level `ask-prd` branch of the tool execute flow:
 * tg takes over and ALL Feishu logic is skipped. `createTgTransport` /
 * `runTgQuestionnaire` / `isAskPrdActive` / `isTgConfigured` are mocked so the
 * orchestration wiring is exercised without real Telegram I/O (the tg modules
 * themselves are unit-tested elsewhere).
 */

const {
	createTgTransportMock,
	runTgQuestionnaireMock,
	isAskPrdActiveMock,
	isTgConfiguredMock,
	createFeishuTransportMock,
	loadConfigMock,
} = vi.hoisted(() => ({
	createTgTransportMock: vi.fn<() => TgTransport>(),
	runTgQuestionnaireMock: vi.fn<(transport: TgTransport, ...rest: unknown[]) => Promise<RemoteOutcome>>(),
	isAskPrdActiveMock: vi.fn<(sessionId: string | undefined) => boolean>(),
	isTgConfiguredMock: vi.fn<() => boolean>(),
	createFeishuTransportMock: vi.fn<() => Promise<unknown>>(),
	loadConfigMock: vi.fn(),
}));

vi.mock("./remote/channel-transport.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./remote/channel-transport.js")>();
	return { ...actual, createTgTransport: createTgTransportMock, createFeishuTransport: createFeishuTransportMock };
});
vi.mock("./remote/tg-questionnaire.js", () => ({ runTgQuestionnaire: runTgQuestionnaireMock }));
vi.mock("./remote/ask-prd-state.js", () => ({
	isAskPrdActive: isAskPrdActiveMock,
	setAskPrdEnabled: vi.fn(),
	resetAskPrdState: vi.fn(),
}));
vi.mock("./remote/remote-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./remote/remote-config.js")>();
	return { ...actual, isTgConfigured: isTgConfiguredMock };
});
vi.mock("./config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./config.js")>();
	return { ...actual, loadConfig: loadConfigMock };
});
vi.mock("./state/questionnaire-session.js", () => ({
	QuestionnaireSession: class {
		private readonly done: (result: QuestionnaireResult) => void;
		readonly component = { render: () => [] as string[], invalidate: () => undefined, handleInput: () => undefined };
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

function fullRemoteConfig(enabled: boolean) {
	return {
		enabled,
		localTimeoutMs: 300_000,
		timeoutMs: 60_000,
		cancelWords: ["取消", "cancel"],
		feishu: {
			useCards: false,
			receivers: [{ type: "email", value: "me@example.com" }],
		},
		tg: {
			chatId: "c",
			userId: 7,
			username: "@alice",
			useCards: true,
			timeoutMs: 1_800_000,
		},
	};
}

function makeTgTransport(): TgTransport {
	return {
		sendText: vi.fn(async () => ({ chatId: -100, messageId: 1 })),
		sendCard: vi.fn(async () => ({ chatId: -100, messageId: 1 })),
		waitForReply: vi.fn(async () => null),
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
		sessionManager?: { getSessionId: () => string };
		ui: {
			notify: ReturnType<typeof vi.fn>;
			onTerminalInput?: (cb: (data: string) => unknown) => () => void;
			custom: ReturnType<typeof vi.fn>;
		};
	} & Record<string, unknown>,
) => Promise<unknown>;

interface Harness {
	execute: Execute;
	ctx: Parameters<Execute>[4];
	events: FakeChannelBus;
	resolveCustom: (result: QuestionnaireResult) => void;
}

function makeHarness(): Harness {
	let pendingResolve: ((r: QuestionnaireResult) => void) | undefined;
	const ctx = {
		hasUI: true,
		cwd: "/tmp",
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session-1" },
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

describe("ask_user_question — session-level ask-prd routing", () => {
	beforeEach(() => {
		createTgTransportMock.mockReset();
		runTgQuestionnaireMock.mockReset();
		isAskPrdActiveMock.mockReset();
		isTgConfiguredMock.mockReset();
		createFeishuTransportMock.mockReset();
		loadConfigMock.mockReset();
		loadConfigMock.mockReturnValue({ remote: fullRemoteConfig(true) }); // feishu remote-as-primary also ON
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("routes to Telegram and skips Feishu when ask-prd is active", async () => {
		isAskPrdActiveMock.mockReturnValue(true);
		isTgConfiguredMock.mockReturnValue(true);
		const transport = makeTgTransport();
		createTgTransportMock.mockReturnValue(transport);
		runTgQuestionnaireMock.mockResolvedValue({
			kind: "answered",
			result: {
				answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "B" }],
				cancelled: false,
			},
		});
		const h = makeHarness();

		const result = await h.execute("t1", makeParams(), undefined, undefined, h.ctx);

		expect(createTgTransportMock).toHaveBeenCalledTimes(1);
		expect(runTgQuestionnaireMock).toHaveBeenCalledTimes(1);
		expect(runTgQuestionnaireMock.mock.calls[0][0]).toBe(transport);
		expect(transport.close).toHaveBeenCalledTimes(1);
		expect(createFeishuTransportMock).not.toHaveBeenCalled();
		expect(h.ctx.ui.custom).not.toHaveBeenCalled();
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain("User has answered your questions");
	});

	it("goes local WITHOUT the Feishu fallback when ask-prd is active but tg is not configured", async () => {
		isAskPrdActiveMock.mockReturnValue(true);
		isTgConfiguredMock.mockReturnValue(false);
		const h = makeHarness();

		const promise = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.waitFor(() => {
			expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);
		});
		h.resolveCustom({
			answers: [{ questionIndex: 0, question: "Which library?", kind: "custom", answer: "local" }],
			cancelled: false,
		});
		const result = await promise;

		expect(createTgTransportMock).not.toHaveBeenCalled();
		expect(createFeishuTransportMock).not.toHaveBeenCalled();
		expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain("local");
	});

	it("falls back to the local questionnaire with a warning when pi-channel has no telegram configuration", async () => {
		isAskPrdActiveMock.mockReturnValue(true);
		isTgConfiguredMock.mockReturnValue(true);
		const h = makeHarness();
		h.events.status = {
			configPath: "/tmp/rpiv-test/pi-channel.json",
			providers: [{ provider: "feishu", configured: true, connected: true }],
		};

		const promise = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.waitFor(() => {
			expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);
		});
		h.resolveCustom({
			answers: [{ questionIndex: 0, question: "Which library?", kind: "custom", answer: "local" }],
			cancelled: false,
		});
		const result = await promise;

		expect(createTgTransportMock).not.toHaveBeenCalled();
		expect(runTgQuestionnaireMock).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("pi-channel has no telegram configuration (/tmp/rpiv-test/pi-channel.json)"),
			"warning",
		);
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain("local");
	});

	it("recovers to the local ask when the Telegram wait times out", async () => {
		isAskPrdActiveMock.mockReturnValue(true);
		isTgConfiguredMock.mockReturnValue(true);
		createTgTransportMock.mockReturnValue(makeTgTransport());
		runTgQuestionnaireMock.mockResolvedValue({ kind: "timed_out", partialAnswers: [] });
		const h = makeHarness();

		const promise = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.waitFor(() => {
			expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);
		});
		h.resolveCustom({
			answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "A" }],
			cancelled: false,
		});
		const result = await promise;

		expect(createTgTransportMock).toHaveBeenCalledTimes(1);
		expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1); // recovered locally
		const content = (result as { content: { text: string }[] }).content[0].text;
		expect(content).toContain("A");
	});

	it("keeps the existing Feishu path when ask-prd is NOT active", async () => {
		isAskPrdActiveMock.mockReturnValue(false);
		const transport = {
			send: vi.fn(async () => undefined),
			sendCard: vi.fn(async () => undefined),
			updateCard: vi.fn(async () => undefined),
			waitForReply: vi.fn(async () => null),
			close: vi.fn(async () => undefined),
		};
		createFeishuTransportMock.mockResolvedValue(transport);
		const h = makeHarness();

		const promise = h.execute("t1", makeParams(), undefined, undefined, h.ctx);
		await vi.waitFor(() => {
			expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1); // Feishu wait times out → local recovery
		});
		h.resolveCustom({ answers: [], cancelled: true });
		const result = await promise;

		expect(createTgTransportMock).not.toHaveBeenCalled();
		expect(createFeishuTransportMock).toHaveBeenCalledTimes(1);
		expect(result).toBeDefined();
	});
});
