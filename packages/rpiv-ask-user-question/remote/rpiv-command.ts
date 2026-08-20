import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { loadConfig } from "../config.js";
import { isAskPrdActive, setAskPrdEnabled } from "./ask-prd-state.js";
import {
	isFeishuConfigured,
	isTgConfigured,
	loadRemoteConfig,
	type RemoteConfig,
	setRemoteEnabled,
} from "./remote-config.js";

/**
 * `/rpiv-ask-user-question` — the single command for both remote-asking channels.
 *
 * Subcommands (args: `[remote|prd|status] [on|off|status]`):
 * - `remote` — Feishu remote-as-primary toggle. Persists `remote.enabled` to
 *   config.json via `setRemoteEnabled` (the old `/remote-ask` behaviour).
 * - `prd` — session-scoped ask-prd (Telegram) toggle. In-memory only, keyed by
 *   the current session id; never writes config.json.
 * - `status` / bare — usage + combined status of both channels.
 *
 * The old `/remote-ask` command is intentionally removed (no alias).
 */

export const RPIV_COMMAND = "rpiv-ask-user-question";

const SUBCOMMANDS = ["remote", "prd", "status"] as const;
const ACTIONS = ["on", "off", "status"] as const;

const USAGE = "Usage: /rpiv-ask-user-question [remote|prd|status] [on|off|status]";

/** Feishu channel status line (mirrors the old /remote-ask summary). */
function formatRemoteStatus(cfg: RemoteConfig, changedTo?: boolean): string {
	const mode = cfg.enabled ? "ON" : "OFF";
	const change =
		changedTo === undefined ? "" : changedTo ? " → enabled (questions go to Feishu)" : " → disabled (local dialog)";
	const fallback = cfg.localTimeoutMs === undefined ? "disabled" : `${Math.round(cfg.localTimeoutMs / 1000)}s`;
	const creds = isFeishuConfigured(cfg) ? "OK" : "MISSING (configure feishu.appId/appSecret/receivers)";
	const receivers =
		cfg.feishu.receivers.length > 0
			? ` ${cfg.feishu.receivers.length} (${cfg.feishu.receivers.map((r) => r.type).join(", ")})`
			: " none";
	const wait = `${Math.round(cfg.timeoutMs / 1000)}s`;
	return `Remote mode: ${mode}${change} · Local timeout fallback: ${fallback} · Remote wait timeout: ${wait} · Credentials: ${creds} · Receivers:${receivers}`;
}

/** Telegram ask-prd status line. */
function formatPrdStatus(active: boolean, changedTo?: boolean): string {
	const mode = active ? "ON" : "OFF";
	const change =
		changedTo === undefined ? "" : changedTo ? " → enabled (questions go to Telegram)" : " → disabled (local dialog)";
	return `ask-prd: ${mode}${change} (session)`;
}

/** Combined one-shot status for bare / `status` invocation. */
function combinedStatus(cfg: RemoteConfig, sessionId: string | undefined): string {
	const tg = isTgConfigured(cfg) ? "OK" : "MISSING (configure tg.botToken/chatId/userId)";
	const wait = `${Math.round(cfg.tg.timeoutMs / 1000)}s`;
	return `${USAGE}\n${formatRemoteStatus(cfg)}\n${formatPrdStatus(isAskPrdActive(sessionId))} · tg wait timeout: ${wait} · Credentials: ${tg}`;
}

async function handleRemote(ctx: ExtensionCommandContext, cfg: RemoteConfig, action: string): Promise<void> {
	if (action === "status") {
		ctx.ui.notify(formatRemoteStatus(cfg), "info");
		return;
	}
	let next: boolean;
	if (action === "") {
		next = !cfg.enabled;
	} else if (action === "on") {
		if (!isFeishuConfigured(cfg)) {
			ctx.ui.notify(
				"Cannot enable remote mode: Feishu credentials are missing. Edit ~/.config/rpiv-ask-user-question/config.json and add remote.feishu.appId / appSecret / receivers.",
				"error",
			);
			return;
		}
		next = true;
	} else if (action === "off") {
		next = false;
	} else {
		ctx.ui.notify(USAGE, "error");
		return;
	}

	if (next === cfg.enabled) {
		ctx.ui.notify(formatRemoteStatus(cfg), "info");
		return;
	}
	if (!setRemoteEnabled(next)) {
		ctx.ui.notify("Failed to write config — remote mode unchanged", "error");
		return;
	}
	const updated = loadRemoteConfig(loadConfig().remote);
	ctx.ui.notify(formatRemoteStatus(updated, next), "info");
}

async function handlePrd(
	ctx: ExtensionCommandContext,
	cfg: RemoteConfig,
	action: string,
	sessionId: string | undefined,
): Promise<void> {
	const active = isAskPrdActive(sessionId);
	if (action === "status") {
		ctx.ui.notify(formatPrdStatus(active), "info");
		return;
	}
	let next: boolean;
	if (action === "") {
		next = !active;
	} else if (action === "on") {
		if (!isTgConfigured(cfg)) {
			ctx.ui.notify(
				"Cannot enable ask-prd: Telegram credentials are missing. Edit ~/.config/rpiv-ask-user-question/config.json and add remote.tg.botToken / chatId / userId.",
				"error",
			);
			return;
		}
		next = true;
	} else if (action === "off") {
		next = false;
	} else {
		ctx.ui.notify(USAGE, "error");
		return;
	}
	if (sessionId === undefined) {
		ctx.ui.notify("Cannot enable ask-prd: no active session id", "error");
		return;
	}
	if (next === active) {
		ctx.ui.notify(formatPrdStatus(active), "info");
		return;
	}
	setAskPrdEnabled(sessionId, next);
	ctx.ui.notify(formatPrdStatus(next, next), "info");
}

export function registerRpivCommand(pi: ExtensionAPI): void {
	pi.registerCommand(RPIV_COMMAND, {
		description:
			"Inspect or toggle the ask_user_question remote channels: `remote` (Feishu) and `prd` (session-scoped Telegram ask-prd)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trimStart();
			const [first, second] = trimmed.split(/\s+/, 2);
			if (first === "remote" || first === "prd") {
				// Second level: complete the action, replacing the whole arg prefix.
				const filtered = second === undefined ? [...ACTIONS] : ACTIONS.filter((a) => a.startsWith(second));
				if (filtered.length === 0) return null;
				return filtered.map((a) => ({ value: `${first} ${a}`, label: `${first} ${a}` }));
			}
			const items = SUBCOMMANDS.filter((s) => s.startsWith(trimmed)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/rpiv-ask-user-question requires an interactive session", "error");
				return;
			}
			const [sub, action] = args.trim().split(/\s+/, 2);
			const cfg = loadRemoteConfig(loadConfig().remote);
			const sessionId = ctx.sessionManager?.getSessionId();

			if (sub === "remote") {
				await handleRemote(ctx, cfg, action ?? "");
				return;
			}
			if (sub === "prd") {
				await handlePrd(ctx, cfg, action ?? "", sessionId);
				return;
			}
			if (sub === undefined || sub === "" || sub === "status") {
				ctx.ui.notify(combinedStatus(cfg, sessionId), "info");
				return;
			}
			ctx.ui.notify(USAGE, "error");
		},
	});
}
