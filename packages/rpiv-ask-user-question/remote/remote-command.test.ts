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
				appId: "cli_1",
				appSecret: "secret",
				receivers: [
					{ type: "email", value: "me@example.com" },
					{ type: "chat_id", value: "oc_1" },
				],
			},
		},
	})),
}));

import { loadConfig } from "../config.js";
import { REMOTE_ASK_COMMAND, registerRemoteCommand } from "./remote-command.js";
import type { RemoteConfig } from "./remote-config.js";

const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
	enabled: false,
	localTimeoutMs: 300_000,
	timeoutMs: 600_000,
	cancelWords: ["取消", "cancel"],
	feishu: {
		appId: "cli_1",
		appSecret: "secret",
		useCards: true,
		receivers: [
			{ type: "email", value: "me@example.com" },
			{ type: "chat_id", value: "oc_1" },
		],
	},
	tg: { botToken: "", chatId: "", userId: 0, username: undefined, useCards: true, timeoutMs: 600_000, proxy: undefined },
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
			expect(name).toBe(REMOTE_ASK_COMMAND);
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
		...over,
	} as unknown as ExtensionCommandContext;
}

describe("registerRemoteCommand", () => {
	let pi: ExtensionAPI;
	let command: CapturedCommand;

	beforeEach(() => {
		setRemoteEnabledMock.mockReset();
		// Simulate a successful write: the flag lands back in the config the
		// command re-reads after persisting.
		setRemoteEnabledMock.mockImplementation((enabled: boolean) => {
			vi.mocked(loadConfig).mockReturnValue({ remote: { ...DEFAULT_REMOTE_CONFIG, enabled } });
			return true;
		});
		vi.mocked(loadConfig).mockReturnValue({ remote: DEFAULT_REMOTE_CONFIG });
		const made = makePi();
		pi = made.pi;
		registerRemoteCommand(pi);
		command = vi.mocked(pi.registerCommand).mock.calls[0][1] as CapturedCommand;
	});

	it("registers the command with argument completions for on/off/status", () => {
		expect(pi.registerCommand).toHaveBeenCalledTimes(1);
		const completions = command.getArgumentCompletions?.("o") as { value: string }[] | null;
		expect(completions?.map((c) => c.value).sort()).toEqual(["off", "on"]);
		expect(command.getArgumentCompletions?.("x")).toBeNull();
	});

	it("rejects running without an interactive session", async () => {
		const ctx = makeCtx({ hasUI: false });
		await command.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(setRemoteEnabledMock).not.toHaveBeenCalled();
	});

	it("status prints the current state without writing", async () => {
		const ctx = makeCtx();
		await command.handler("status", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Remote mode: OFF"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Local timeout fallback: 300s"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Credentials: OK"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Receivers: 2 (email, chat_id)"), "info");
		expect(setRemoteEnabledMock).not.toHaveBeenCalled();
	});

	it("on enables and persists the flag, printing the change", async () => {
		const ctx = makeCtx();
		await command.handler("on", ctx);
		expect(setRemoteEnabledMock).toHaveBeenCalledWith(true);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Remote mode: ON"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("questions go to Feishu"), "info");
	});

	it("off disables and persists the flag", async () => {
		vi.mocked(loadConfig).mockReturnValue({ remote: { ...DEFAULT_REMOTE_CONFIG, enabled: true } });
		const ctx = makeCtx();
		await command.handler("off", ctx);
		expect(setRemoteEnabledMock).toHaveBeenCalledWith(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Remote mode: OFF"), "info");
	});

	it("no argument toggles from OFF to ON", async () => {
		const ctx = makeCtx();
		await command.handler("", ctx);
		expect(setRemoteEnabledMock).toHaveBeenCalledWith(true);
	});

	it("on without credentials errors and does not write", async () => {
		vi.mocked(loadConfig).mockReturnValue({
			remote: {
				...DEFAULT_REMOTE_CONFIG,
				enabled: false,
				feishu: { appId: "", appSecret: "", receivers: [], useCards: true },
			},
		});
		const ctx = makeCtx();
		await command.handler("on", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("credentials are missing"), "error");
		expect(setRemoteEnabledMock).not.toHaveBeenCalled();
	});

	it("errors with usage for an unknown argument", async () => {
		const ctx = makeCtx();
		await command.handler("maybe", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "error");
		expect(setRemoteEnabledMock).not.toHaveBeenCalled();
	});

	it("surfaces a failed config write as an error", async () => {
		vi.mocked(loadConfig).mockReturnValue({ remote: { ...DEFAULT_REMOTE_CONFIG, enabled: true } });
		setRemoteEnabledMock.mockReturnValue(false);
		const ctx = makeCtx();
		await command.handler("off", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to write config"), "error");
	});

	it("no-ops with a status print when the flag is already the target value", async () => {
		vi.mocked(loadConfig).mockReturnValue({
			remote: { ...DEFAULT_REMOTE_CONFIG, enabled: true },
		});
		const ctx = makeCtx();
		await command.handler("on", ctx);
		expect(setRemoteEnabledMock).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Remote mode: ON"), "info");
	});
});
