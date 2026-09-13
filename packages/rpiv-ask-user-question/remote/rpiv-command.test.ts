import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setRemoteEnabledMock = vi.hoisted(() => vi.fn<(enabled: boolean) => boolean>());

vi.mock("./remote-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./remote-config.js")>();
	return {
		...actual,
		setRemoteEnabled: setRemoteEnabledMock,
	};
});

vi.mock("../config.js", () => ({
	loadConfig: vi.fn(() => ({
		remote: {
			enabled: false,
			localTimeoutMs: 300_000,
			timeoutMs: 600_000,
			cancelWords: ["取消", "cancel"],
			feishu: {
				useCards: true,
				receivers: [
					{ type: "email", value: "me@example.com" },
					{ type: "chat_id", value: "oc_1" },
				],
			},
			tg: {
				chatId: "c",
				userId: 7,
				username: "@alice",
				useCards: true,
				timeoutMs: 1_800_000,
			},
		},
	})),
}));

import { loadConfig } from "../config.js";
import { isAskPrdActive, resetAskPrdState } from "./ask-prd-state.js";
import type { RemoteConfig } from "./remote-config.js";
import { RPIV_COMMAND, registerRpivCommand } from "./rpiv-command.js";

const DEFAULT_CONFIG: RemoteConfig = {
	enabled: false,
	localTimeoutMs: 300_000,
	timeoutMs: 600_000,
	cancelWords: ["取消", "cancel"],
	feishu: {
		useCards: true,
		receivers: [
			{ type: "email", value: "me@example.com" },
			{ type: "chat_id", value: "oc_1" },
		],
	},
	tg: {
		chatId: "c",
		userId: 7,
		username: "@alice",
		useCards: true,
		timeoutMs: 1_800_000,
	},
};

interface CapturedCommand {
	description: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function makePi(): { pi: ExtensionAPI; command: CapturedCommand } {
	const captured: { command: CapturedCommand } = { command: { description: "", handler: async () => undefined } };
	const pi = {
		registerCommand: vi.fn((name: string, opts: CapturedCommand) => {
			expect(name).toBe(RPIV_COMMAND);
			captured.command = opts;
		}),
	} as unknown as ExtensionAPI;
	return { pi, command: captured.command };
}

function makeCtx(over: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	const notify = vi.fn();
	return {
		hasUI: true,
		ui: { notify },
		sessionManager: { getSessionId: () => "session-1" },
		...over,
	} as unknown as ExtensionCommandContext;
}

function setupCommand() {
	const made = makePi();
	registerRpivCommand(made.pi);
	const command = vi.mocked(made.pi.registerCommand).mock.calls[0][1] as CapturedCommand;
	return { ...made, command };
}

describe("registerRpivCommand", () => {
	let command: CapturedCommand;

	beforeEach(() => {
		setRemoteEnabledMock.mockReset();
		resetAskPrdState();
		setRemoteEnabledMock.mockImplementation((enabled: boolean) => {
			vi.mocked(loadConfig).mockReturnValue({ remote: { ...DEFAULT_CONFIG, enabled } });
			return true;
		});
		vi.mocked(loadConfig).mockReturnValue({ remote: DEFAULT_CONFIG });
		command = setupCommand().command;
	});

	it("registers the single command /rpiv-ask-user-question", () => {
		expect(vi.mocked(setupCommand().pi.registerCommand)).toHaveBeenCalledTimes(1);
	});

	it("completes subcommands and per-subcommand actions", () => {
		expect((command.getArgumentCompletions?.("re") as { value: string }[])?.map((c) => c.value)).toEqual(["remote"]);
		expect((command.getArgumentCompletions?.("remote ") as { value: string }[])?.map((c) => c.value).sort()).toEqual([
			"remote off",
			"remote on",
			"remote status",
		]);
		expect((command.getArgumentCompletions?.("remote o") as { value: string }[])?.map((c) => c.value).sort()).toEqual(
			["remote off", "remote on"],
		);
		expect((command.getArgumentCompletions?.("prd ") as { value: string }[])?.map((c) => c.value).sort()).toEqual([
			"prd off",
			"prd on",
			"prd status",
		]);
		expect(command.getArgumentCompletions?.("zzz")).toBeNull();
	});

	it("rejects running without an interactive session", async () => {
		const ctx = makeCtx({ hasUI: false });
		await command.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(setRemoteEnabledMock).not.toHaveBeenCalled();
	});

	it("bare invocation prints usage + combined status (both channels OFF)", async () => {
		const ctx = makeCtx();
		await command.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Remote mode: OFF"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ask-prd: OFF (session)"), "info");
	});

	it("status alias behaves like bare", async () => {
		const ctx = makeCtx();
		await command.handler("status", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Remote mode: OFF"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ask-prd: OFF (session)"), "info");
	});

	describe("remote subcommand (Feishu)", () => {
		it("status prints the feishu state without writing", async () => {
			const ctx = makeCtx();
			await command.handler("remote status", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Remote mode: OFF"), "info");
			expect(setRemoteEnabledMock).not.toHaveBeenCalled();
		});

		it("on enables and persists the flag", async () => {
			const ctx = makeCtx();
			await command.handler("remote on", ctx);
			expect(setRemoteEnabledMock).toHaveBeenCalledWith(true);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("questions go to Feishu"), "info");
		});

		it("on without feishu credentials errors and does not write", async () => {
			vi.mocked(loadConfig).mockReturnValue({
				remote: { ...DEFAULT_CONFIG, feishu: { receivers: [], useCards: true } },
			});
			const ctx = makeCtx();
			await command.handler("remote on", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("receivers are missing"), "error");
			expect(setRemoteEnabledMock).not.toHaveBeenCalled();
		});

		it("bare remote toggles", async () => {
			const ctx = makeCtx();
			await command.handler("remote", ctx);
			expect(setRemoteEnabledMock).toHaveBeenCalledWith(true);
		});
	});

	describe("prd subcommand (Telegram / session-scoped)", () => {
		it("status prints ask-prd OFF without touching state", async () => {
			const ctx = makeCtx();
			await command.handler("prd status", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ask-prd: OFF (session)"), "info");
			expect(isAskPrdActive("session-1")).toBe(false);
		});

		it("on enables ask-prd for the current session only (no persistence)", async () => {
			const ctx = makeCtx();
			await command.handler("prd on", ctx);
			expect(isAskPrdActive("session-1")).toBe(true);
			expect(isAskPrdActive("other-session")).toBe(false);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("questions go to Telegram"), "info");
			expect(setRemoteEnabledMock).not.toHaveBeenCalled();
		});

		it("on without tg credentials errors and stays off", async () => {
			vi.mocked(loadConfig).mockReturnValue({
				remote: {
					...DEFAULT_CONFIG,
					tg: {
						chatId: "",
						userId: 0,
						username: undefined,
						useCards: true,
						timeoutMs: 1_800_000,
					},
				},
			});
			const ctx = makeCtx();
			await command.handler("prd on", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("chatId/userId are missing"), "error");
			expect(isAskPrdActive("session-1")).toBe(false);
		});

		it("off disables ask-prd", async () => {
			await command.handler("prd on", makeCtx());
			const ctx = makeCtx();
			await command.handler("prd off", ctx);
			expect(isAskPrdActive("session-1")).toBe(false);
		});

		it("bare prd toggles", async () => {
			const ctx = makeCtx();
			await command.handler("prd", ctx);
			expect(isAskPrdActive("session-1")).toBe(true);
		});

		it("combined status reflects an enabled prd session", async () => {
			await command.handler("prd on", makeCtx());
			const ctx = makeCtx();
			await command.handler("", ctx);
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ask-prd: ON (session)"), "info");
		});
	});

	it("errors with usage for an unknown subcommand", async () => {
		const ctx = makeCtx();
		await command.handler("maybe", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "error");
		expect(setRemoteEnabledMock).not.toHaveBeenCalled();
		expect(isAskPrdActive("session-1")).toBe(false);
	});
});
