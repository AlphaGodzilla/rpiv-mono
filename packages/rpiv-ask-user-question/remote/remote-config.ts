import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPath, loadJsonConfigWithLegacyFallback, saveJsonConfig } from "@juicesharp/rpiv-config";

/**
 * Remote-mode config for rpiv-ask-user-question.
 *
 * Lives under the top-level `remote` key of the package config file. All fields
 * are hand-guarded (mirroring the `resolveCollapseKey` style in ../config.ts):
 * malformed or mistyped values fall back to defaults, never throw.
 */

/** Feishu `receive_id_type` values — the only receiver kinds we accept. */
export type FeishuReceiverType = "open_id" | "user_id" | "union_id" | "email" | "chat_id";

export const FEISHU_RECEIVER_TYPES: readonly FeishuReceiverType[] = [
	"open_id",
	"user_id",
	"union_id",
	"email",
	"chat_id",
];

export interface FeishuReceiver {
	type: FeishuReceiverType;
	value: string;
}

export interface FeishuRemoteConfig {
	appId: string;
	appSecret: string;
	receivers: FeishuReceiver[];
	/** Send questions as interactive cards (single-select: clickable option buttons). Default true. */
	useCards: boolean;
}

export interface RemoteConfig {
	/** Remote-as-primary mode. When true (and credentials are complete) every questionnaire goes to Feishu. */
	enabled: boolean;
	/**
	 * Local-timeout fallback threshold (ms). OPTIONAL on purpose — the fallback
	 * only engages when the user explicitly configured a value; absent means no
	 * local timeout and the original TUI flow.
	 */
	localTimeoutMs: number | undefined;
	/** Remote wait timeout per question (ms). Default 10 minutes. */
	timeoutMs: number;
	/** Exact-match words that abort the remote questionnaire. Default ["取消", "cancel"]. */
	cancelWords: string[];
	feishu: FeishuRemoteConfig;
}

export const DEFAULT_REMOTE_TIMEOUT_MS = 600_000;
export const DEFAULT_CANCEL_WORDS = ["取消", "cancel"] as const;

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

function parseReceiver(raw: unknown): FeishuReceiver | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.type !== "string" || !(FEISHU_RECEIVER_TYPES as readonly string[]).includes(r.type)) return undefined;
	if (!isNonEmptyString(r.value)) return undefined;
	return { type: r.type as FeishuReceiverType, value: r.value };
}

/**
 * Parse and clean the raw `remote` config value. Invalid entries are dropped
 * back to their defaults — same fail-soft contract as the rest of the package.
 */
export function loadRemoteConfig(raw: unknown): RemoteConfig {
	const cfg: RemoteConfig = {
		enabled: false,
		localTimeoutMs: undefined,
		timeoutMs: DEFAULT_REMOTE_TIMEOUT_MS,
		cancelWords: [...DEFAULT_CANCEL_WORDS],
		feishu: { appId: "", appSecret: "", receivers: [], useCards: true },
	};
	if (!raw || typeof raw !== "object") return cfg;

	const r = raw as Record<string, unknown>;
	if (typeof r.enabled === "boolean") cfg.enabled = r.enabled;

	if (typeof r.localTimeoutMs === "number" && Number.isFinite(r.localTimeoutMs) && r.localTimeoutMs > 0) {
		cfg.localTimeoutMs = r.localTimeoutMs;
	}

	if (typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) && r.timeoutMs > 0) {
		cfg.timeoutMs = r.timeoutMs;
	}

	if (Array.isArray(r.cancelWords)) {
		const words = r.cancelWords.filter(isNonEmptyString);
		if (words.length > 0) cfg.cancelWords = words;
	}

	if (r.feishu && typeof r.feishu === "object") {
		const f = r.feishu as Record<string, unknown>;
		if (isNonEmptyString(f.appId)) cfg.feishu.appId = f.appId;
		if (isNonEmptyString(f.appSecret)) cfg.feishu.appSecret = f.appSecret;
		if (typeof f.useCards === "boolean") cfg.feishu.useCards = f.useCards;
		if (Array.isArray(f.receivers)) {
			cfg.feishu.receivers = f.receivers
				.map(parseReceiver)
				.filter((rec): rec is FeishuReceiver => rec !== undefined);
		}
	}
	return cfg;
}

/** Credentials complete enough to send/receive on Feishu — independent of `enabled`. */
export function isFeishuConfigured(cfg: RemoteConfig): boolean {
	return cfg.feishu.appId.length > 0 && cfg.feishu.appSecret.length > 0 && cfg.feishu.receivers.length > 0;
}

/** Remote-as-primary mode active: `enabled` AND usable credentials. */
export function shouldUseRemote(cfg: RemoteConfig): boolean {
	return cfg.enabled && isFeishuConfigured(cfg);
}

/** Local-timeout fallback threshold, or undefined when the fallback is not engaged. */
export function getLocalTimeoutMs(cfg: RemoteConfig): number | undefined {
	if (cfg.enabled) return undefined;
	return cfg.localTimeoutMs !== undefined && isFeishuConfigured(cfg) ? cfg.localTimeoutMs : undefined;
}

const CONFIG_NAME = "rpiv-ask-user-question";

/**
 * Path of the config file that `loadJsonConfigWithLegacyFallback` actually
 * read: the XDG-resolved path when present, otherwise the legacy path. Writes
 * must go to the same file so a `/remote-ask` toggle never splits config
 * across the two locations.
 */
function effectiveConfigPath(): string {
	const xdg = configPath("rpiv-ask-user-question");
	return existsSync(xdg) ? xdg : join(homedir(), ".config", CONFIG_NAME, "config.json");
}

/**
 * Persist a change to `remote.enabled` (only), preserving every other field of
 * the config file. Returns false when the file could not be written.
 */
export function setRemoteEnabled(enabled: boolean): boolean {
	const raw = loadJsonConfigWithLegacyFallback<Record<string, unknown>>(CONFIG_NAME);
	const remote = raw.remote && typeof raw.remote === "object" ? (raw.remote as Record<string, unknown>) : {};
	raw.remote = { ...remote, enabled };
	return saveJsonConfig(effectiveConfigPath(), raw);
}
