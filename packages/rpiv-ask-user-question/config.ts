import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GuidanceFields } from "@juicesharp/rpiv-config";
import {
	loadJsonConfig,
	loadJsonConfigWithLegacyFallback,
	saveJsonConfig,
	validateGuidanceFields,
} from "@juicesharp/rpiv-config";
import type { RemoteConfig } from "./remote/remote-config.js";

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	/**
	 * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
	 * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
	 * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
	 * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
	 * Pass `"off"` to disable the collapse shortcut entirely.
	 */
	collapseKey?: CollapseKeySpec;
	/** Raw `remote` config; parse with `loadRemoteConfig` for guarded access. */
	remote?: RemoteConfig;
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidCollapseKeySpec(spec: string): boolean {
	// Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then a
	// base key that is a single printable character or a named special key. A loose
	// check is not enough — pi-tui's `parseKeyId` takes the LAST `+`-part as the key
	// and ignores unknown parts, so a typo like `ctr+]` would silently match every
	// bare `]` keypress (and the raw terminal listener would consume them globally).
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	const raw = config.collapseKey?.trim().toLowerCase();
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}

// The only compound-word names in SPECIAL_KEYS — first-letter capitalization
// alone would render them "Pageup"/"Pagedown".
const COMPOUND_KEY_DISPLAY: Record<string, string> = {
	pageup: "PageUp",
	pagedown: "PageDown",
};

/**
 * Pretty-print a resolved key spec for UI copy: each `+`-part gets its first
 * character uppercased (`"ctrl+]"` → `"Ctrl+]"`, `"alt+o"` → `"Alt+O"`),
 * `"f9"` → `"F9"`, `"ctrl+pagedown"` → `"Ctrl+PageDown"`). Display-only — key
 * matching always uses the raw lowercase spec (`matchesKey` lowercases ids),
 * so never feed the result back into it.
 */
export function formatKeySpecForDisplay(spec: CollapseKeySpec): string {
	return spec
		.split("+")
		.map(
			(part) =>
				COMPOUND_KEY_DISPLAY[part] ??
				(part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)),
		)
		.join("+");
}

/** 配置目录名（= 包名去掉 scope），也是 `~/.pi/agent/extensions/<name>/` 的子目录名 */
export const CONFIG_NAME = "rpiv-ask-user-question";

/**
 * pi 原生配置路径（优先）：`~/.pi/agent/extensions/rpiv-ask-user-question/config.json`。
 * 与 pi-mono 各扩展的约定一致（见 pi-mono/AGENTS.md「配置与运行数据一律放 extensions 目录」）。
 */
export function piConfigPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_NAME, "config.json");
}

/**
 * 读取原始配置对象，顺序：
 *   1. pi 原生路径 `~/.pi/agent/extensions/<包名>/config.json`
 *   2. rpiv 默认路径 `$XDG_CONFIG_HOME/<包名>/config.json`（rpiv-config 再兜底 `~/.config/<包名>/config.json`）
 * 文件缺失或非法时返回 `{}`（两个 loader 都是 fail-soft）。
 */
export function loadRawConfig(): Record<string, unknown> {
	const primary = piConfigPath();
	if (existsSync(primary)) return loadJsonConfig<Record<string, unknown>>(primary);
	return loadJsonConfigWithLegacyFallback<Record<string, unknown>>(CONFIG_NAME);
}

/** 写回原始配置：只写 pi 原生路径（迁移后不再分裂到两处）。 */
export function saveRawConfig(data: unknown): boolean {
	return saveJsonConfig(piConfigPath(), data);
}

export function loadConfig(): AskUserQuestionConfig {
	return loadRawConfig() as AskUserQuestionConfig;
}

export { validateGuidanceFields };
