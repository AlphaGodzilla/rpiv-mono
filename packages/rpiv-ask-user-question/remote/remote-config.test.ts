import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveJsonConfigMock, loadRawMock, configPathMock, existsSyncMock } = vi.hoisted(() => ({
	saveJsonConfigMock: vi.fn<(path: string, data: unknown) => boolean>(),
	loadRawMock: vi.fn<() => Record<string, unknown>>(() => ({})),
	configPathMock: vi.fn<() => string>(),
	existsSyncMock: vi.fn<(p: string) => boolean>(() => false),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: existsSyncMock };
});

vi.mock("@juicesharp/rpiv-config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@juicesharp/rpiv-config")>();
	return {
		...actual,
		saveJsonConfig: saveJsonConfigMock,
		loadJsonConfigWithLegacyFallback: loadRawMock,
		configPath: configPathMock,
	};
});

import {
	DEFAULT_CANCEL_WORDS,
	DEFAULT_REMOTE_TIMEOUT_MS,
	DEFAULT_TG_TIMEOUT_MS,
	getLocalTimeoutMs,
	isFeishuConfigured,
	isTgConfigured,
	loadRemoteConfig,
	type RemoteConfig,
	setRemoteEnabled,
	shouldUseRemote,
} from "./remote-config.js";

function fullConfig(): RemoteConfig {
	return loadRemoteConfig({
		enabled: true,
		localTimeoutMs: 300_000,
		timeoutMs: 60_000,
		cancelWords: ["stop"],
		feishu: {
			appId: "cli_1",
			appSecret: "secret",
			receivers: [
				{ type: "email", value: "me@example.com" },
				{ type: "chat_id", value: "oc_1" },
			],
		},
	});
}

describe("loadRemoteConfig", () => {
	it("returns defaults for missing or non-object config", () => {
		for (const raw of [undefined, null, "x", 42, []]) {
			const cfg = loadRemoteConfig(raw);
			expect(cfg.enabled).toBe(false);
			expect(cfg.localTimeoutMs).toBeUndefined();
			expect(cfg.timeoutMs).toBe(DEFAULT_REMOTE_TIMEOUT_MS);
			expect(cfg.cancelWords).toEqual([...DEFAULT_CANCEL_WORDS]);
			expect(cfg.feishu.receivers).toEqual([]);
		}
	});

	it("parses valid fields", () => {
		const cfg = fullConfig();
		expect(cfg.enabled).toBe(true);
		expect(cfg.localTimeoutMs).toBe(300_000);
		expect(cfg.timeoutMs).toBe(60_000);
		expect(cfg.cancelWords).toEqual(["stop"]);
		expect(cfg.feishu.appId).toBe("cli_1");
		expect(cfg.feishu.receivers).toHaveLength(2);
	});

	it("drops non-positive or non-finite timeout values back to defaults", () => {
		for (const bad of [0, -5, NaN, Infinity, "3000", null]) {
			const cfg = loadRemoteConfig({ enabled: true, localTimeoutMs: bad, timeoutMs: bad });
			expect(cfg.localTimeoutMs).toBeUndefined();
			expect(cfg.timeoutMs).toBe(DEFAULT_REMOTE_TIMEOUT_MS);
		}
	});

	it("accepts every native feishu receiver type and drops invalid receivers", () => {
		const cfg = loadRemoteConfig({
			feishu: {
				receivers: [
					{ type: "open_id", value: "ou_1" },
					{ type: "user_id", value: "u_1" },
					{ type: "union_id", value: "un_1" },
					{ type: "email", value: "a@b.c" },
					{ type: "chat_id", value: "oc_1" },
					{ type: "mobile", value: "13800000000" },
					{ type: "email" },
					{ type: "chat_id", value: "" },
					null,
					"string",
				],
			},
		});
		expect(cfg.feishu.receivers.map((r) => r.type)).toEqual(["open_id", "user_id", "union_id", "email", "chat_id"]);
	});

	it("defaults useCards to true and parses explicit values", () => {
		expect(loadRemoteConfig({}).feishu.useCards).toBe(true);
		expect(loadRemoteConfig({ feishu: { useCards: false } }).feishu.useCards).toBe(false);
		expect(loadRemoteConfig({ feishu: { useCards: "yes" } }).feishu.useCards).toBe(true);
	});

	it("filters empty cancel words and keeps the default when none remain", () => {
		expect(loadRemoteConfig({ cancelWords: ["", "  ", 3] }).cancelWords).toEqual([...DEFAULT_CANCEL_WORDS]);
		expect(loadRemoteConfig({ cancelWords: ["stop"] }).cancelWords).toEqual(["stop"]);
	});
});

describe("isFeishuConfigured / shouldUseRemote", () => {
	it("requires appId, appSecret and at least one receiver", () => {
		expect(isFeishuConfigured(fullConfig())).toBe(true);
		expect(isFeishuConfigured(loadRemoteConfig({ feishu: { appId: "a", appSecret: "b" } }))).toBe(false);
		expect(
			isFeishuConfigured(loadRemoteConfig({ feishu: { appId: "a", receivers: [{ type: "email", value: "x" }] } })),
		).toBe(false);
	});

	it("shouldUseRemote requires enabled AND configured credentials", () => {
		expect(shouldUseRemote(fullConfig())).toBe(true);
		expect(shouldUseRemote(loadRemoteConfig({ enabled: true }))).toBe(false);
		expect(
			shouldUseRemote(
				loadRemoteConfig({
					enabled: false,
					feishu: { appId: "a", appSecret: "b", receivers: [{ type: "email", value: "x" }] },
				}),
			),
		).toBe(false);
	});
});

describe("getLocalTimeoutMs", () => {
	const creds = { feishu: { appId: "a", appSecret: "b", receivers: [{ type: "email", value: "x" }] } };

	it("returns the configured threshold when credentials exist and remote is off", () => {
		expect(getLocalTimeoutMs(loadRemoteConfig({ enabled: false, localTimeoutMs: 123, ...creds }))).toBe(123);
	});

	it("returns undefined when remote mode is on", () => {
		expect(getLocalTimeoutMs(loadRemoteConfig({ enabled: true, localTimeoutMs: 123, ...creds }))).toBeUndefined();
	});

	it("returns undefined when localTimeoutMs is not configured", () => {
		expect(getLocalTimeoutMs(loadRemoteConfig({ enabled: false, ...creds }))).toBeUndefined();
	});

	it("returns undefined when credentials are missing", () => {
		expect(getLocalTimeoutMs(loadRemoteConfig({ enabled: false, localTimeoutMs: 123 }))).toBeUndefined();
	});
});

describe("setRemoteEnabled", () => {
	beforeEach(() => {
		saveJsonConfigMock.mockReset();
		loadRawMock.mockReset();
		configPathMock.mockReset();
	});

	it("merges the enabled flag into the existing remote object and preserves other fields", () => {
		configPathMock.mockReturnValue("/xdg/config.json");
		existsSyncMock.mockReturnValue(true);
		loadRawMock.mockReturnValue({
			collapseKey: "alt+o",
			remote: { enabled: false, localTimeoutMs: 300_000, feishu: { appId: "a" } },
		});
		saveJsonConfigMock.mockReturnValue(true);

		expect(setRemoteEnabled(true)).toBe(true);
		expect(saveJsonConfigMock).toHaveBeenCalledTimes(1);
		const [path, data] = saveJsonConfigMock.mock.calls[0];
		expect(path).toBe("/xdg/config.json");
		expect(data).toEqual({
			collapseKey: "alt+o",
			remote: { enabled: true, localTimeoutMs: 300_000, feishu: { appId: "a" } },
		});
	});

	it("creates the remote object when the config has none", () => {
		configPathMock.mockReturnValue("/xdg/config.json");
		existsSyncMock.mockReturnValue(true);
		loadRawMock.mockReturnValue({ collapseKey: "ctrl+]" });
		saveJsonConfigMock.mockReturnValue(true);

		expect(setRemoteEnabled(false)).toBe(true);
		expect(saveJsonConfigMock.mock.calls[0][1]).toEqual({
			collapseKey: "ctrl+]",
			remote: { enabled: false },
		});
	});

	it("returns false when the save fails", () => {
		configPathMock.mockReturnValue("/xdg/config.json");
		existsSyncMock.mockReturnValue(true);
		loadRawMock.mockReturnValue({});
		saveJsonConfigMock.mockReturnValue(false);
		expect(setRemoteEnabled(true)).toBe(false);
	});
});

describe("loadRemoteConfig tg", () => {
	it("defaults tg to unconfigured", () => {
		const cfg = loadRemoteConfig({});
		expect(cfg.tg.botToken).toBe("");
		expect(cfg.tg.chatId).toBe("");
		expect(cfg.tg.userId).toBe(0);
		expect(cfg.tg.username).toBeUndefined();
		expect(cfg.tg.useCards).toBe(true);
		expect(cfg.tg.timeoutMs).toBe(DEFAULT_TG_TIMEOUT_MS);
	});

	it("parses valid tg config", () => {
		const cfg = loadRemoteConfig({
			tg: {
				botToken: "123:abc",
				chatId: "-1001",
				userId: 42,
				username: "@alice",
				useCards: false,
				timeoutMs: 99_000,
			},
		});
		expect(cfg.tg.botToken).toBe("123:abc");
		expect(cfg.tg.chatId).toBe("-1001");
		expect(cfg.tg.userId).toBe(42);
		expect(cfg.tg.username).toBe("@alice");
		expect(cfg.tg.useCards).toBe(false);
		expect(cfg.tg.timeoutMs).toBe(99_000);
	});

	it("drops invalid tg fields back to defaults", () => {
		const cfg = loadRemoteConfig({
			tg: { botToken: 3, chatId: "", userId: -1, username: "  ", useCards: "yes", timeoutMs: 0 },
		});
		expect(cfg.tg.botToken).toBe("");
		expect(cfg.tg.chatId).toBe("");
		expect(cfg.tg.userId).toBe(0);
		expect(cfg.tg.username).toBeUndefined();
		expect(cfg.tg.useCards).toBe(true);
		expect(cfg.tg.timeoutMs).toBe(DEFAULT_TG_TIMEOUT_MS);
	});

	it("treats non-object tg as defaults", () => {
		expect(loadRemoteConfig({ tg: "x" }).tg.userId).toBe(0);
		expect(loadRemoteConfig({ tg: null }).tg.botToken).toBe("");
	});
});

describe("isTgConfigured", () => {
	it("requires botToken, chatId and a positive userId", () => {
		expect(isTgConfigured(loadRemoteConfig({ tg: { botToken: "t", chatId: "c", userId: 1 } }))).toBe(true);
		expect(isTgConfigured(loadRemoteConfig({ tg: { chatId: "c", userId: 1 } }))).toBe(false);
		expect(isTgConfigured(loadRemoteConfig({ tg: { botToken: "t", userId: 1 } }))).toBe(false);
		expect(isTgConfigured(loadRemoteConfig({ tg: { botToken: "t", chatId: "c" } }))).toBe(false);
	});
});
