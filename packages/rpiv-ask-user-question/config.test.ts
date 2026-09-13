import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AskUserQuestionConfig,
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	loadConfig,
	piConfigPath,
	resolveCollapseKey,
	saveRawConfig,
} from "./config.js";

describe("resolveCollapseKey", () => {
	it("returns the default when config has no collapseKey", () => {
		expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: undefined })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("returns the default when collapseKey is empty or whitespace", () => {
		expect(resolveCollapseKey({ collapseKey: "" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "   " })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("normalizes the spec (trim + lowercase)", () => {
		expect(resolveCollapseKey({ collapseKey: "  Ctrl+}  " })).toBe("ctrl+}");
		expect(resolveCollapseKey({ collapseKey: "ALT+O" })).toBe("alt+o");
	});

	it("returns the off sentinel unchanged (case-insensitive)", () => {
		expect(resolveCollapseKey({ collapseKey: "off" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "OFF" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "  off  " })).toBe(COLLAPSE_KEY_OFF);
	});

	it("falls back to the default for malformed specs", () => {
		// Leading/trailing +, double ++, or empty
		expect(resolveCollapseKey({ collapseKey: "+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl++" })).toBe(DEFAULT_COLLAPSE_KEY);
		// The default itself is valid
		expect(resolveCollapseKey({ collapseKey: "ctrl+]" })).toBe("ctrl+]");
		// Multi-modifier specs are valid
		expect(resolveCollapseKey({ collapseKey: "ctrl+shift+h" })).toBe("ctrl+shift+h");
	});

	it("falls back to the default for typo'd modifiers and unknown key names", () => {
		// `ctr+]` is the dangerous one: pi-tui's parseKeyId takes the LAST `+`-part as
		// the key and ignores unknown parts, so an unvalidated `ctr+]` would match every
		// bare `]` keypress and the raw terminal listener would consume them globally.
		expect(resolveCollapseKey({ collapseKey: "ctr+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "control+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+nosuchkey" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "hello" })).toBe(DEFAULT_COLLAPSE_KEY);
		// Duplicate modifiers are not part of the KeyId grammar
		expect(resolveCollapseKey({ collapseKey: "ctrl+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("accepts named special keys and bare base keys", () => {
		expect(resolveCollapseKey({ collapseKey: "ctrl+pageup" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "Ctrl+PageUp" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "f5" })).toBe("f5");
		expect(resolveCollapseKey({ collapseKey: "alt+escape" })).toBe("alt+escape");
	});
});

describe("loadConfig", () => {
	// Use the test HOME set by the project's setup.ts. The config module resolves
	// `~` at import time, so we use the directory that setup.ts has already wired up
	// and write a per-test config inside it.
	const home = process.env.HOME ?? "";
	const configPath = join(home, ".config", "rpiv-ask-user-question", "config.json");
	// pi 原生路径（优先）：getAgentDir() 在测试里 = $TEST_HOME/.pi/agent（setup.ts 已隔离 HOME 并清掉 PI_CODING_AGENT_DIR）
	const piPath = piConfigPath();

	const removeConfig = (): void => {
		if (existsSync(configPath)) rmSync(configPath);
		if (existsSync(piPath)) rmSync(piPath);
	};

	afterEach(removeConfig);

	it("returns an empty config when no file is present", () => {
		removeConfig();
		expect(loadConfig().collapseKey).toBeUndefined();
	});

	it("falls back to the rpiv default path when the pi-native file is absent", () => {
		removeConfig();
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify({ collapseKey: "alt+o" }));
		expect(loadConfig().collapseKey).toBe("alt+o");
	});

	it("prefers the pi-native path (~/.pi/agent/extensions/<name>/config.json) over the rpiv default", () => {
		removeConfig();
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify({ collapseKey: "ctrl+]" }));
		mkdirSync(dirname(piPath), { recursive: true });
		writeFileSync(piPath, JSON.stringify({ collapseKey: "alt+o" }));
		expect(loadConfig().collapseKey).toBe("alt+o");
	});

	it("saveRawConfig writes to the pi-native path and creates the directory", () => {
		removeConfig();
		expect(saveRawConfig({ collapseKey: "alt+o" })).toBe(true);
		expect(existsSync(piPath)).toBe(true);
		expect(JSON.parse(readFileSync(piPath, "utf8"))).toEqual({ collapseKey: "alt+o" });
	});

	it("reads a valid JSON config from the rpiv default path", () => {
		removeConfig();
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({ collapseKey: "alt+o", guidance: { promptSnippet: "x" } } satisfies AskUserQuestionConfig),
		);
		const c = loadConfig();
		expect(c.collapseKey).toBe("alt+o");
		expect(c.guidance?.promptSnippet).toBe("x");
	});
});
