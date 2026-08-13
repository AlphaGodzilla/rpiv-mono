import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { loadConfig } from "../config.js";
import { isFeishuConfigured, loadRemoteConfig, type RemoteConfig, setRemoteEnabled } from "./remote-config.js";

/**
 * `/remote-ask` — toggle / inspect the Feishu remote-asking mode.
 *
 * Every invocation outputs a status notification (info on success, error on
 * failure), so the terminal always reflects the current mode. Only
 * `remote.enabled` is ever written back; `localTimeoutMs` and the rest of the
 * config are preserved as-is.
 */

export const REMOTE_ASK_COMMAND = "remote-ask";
const USAGE = "Usage: /remote-ask [on|off|status] (no argument toggles)";

function formatStatusSummary(cfg: RemoteConfig, changedTo?: boolean): string {
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

export function registerRemoteCommand(pi: ExtensionAPI): void {
	pi.registerCommand(REMOTE_ASK_COMMAND, {
		description: "Toggle or inspect the Feishu remote-asking mode (ask_user_question via Feishu)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const choices = ["on", "off", "status"];
			const items = choices.filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/remote-ask requires an interactive session", "error");
				return;
			}
			const arg = args.trim().toLowerCase();
			const cfg = loadRemoteConfig(loadConfig().remote);

			if (arg === "status") {
				ctx.ui.notify(formatStatusSummary(cfg), "info");
				return;
			}

			let next: boolean;
			if (arg === "") {
				next = !cfg.enabled;
			} else if (arg === "on") {
				if (!isFeishuConfigured(cfg)) {
					ctx.ui.notify(
						"Cannot enable remote mode: Feishu credentials are missing. Edit ~/.config/rpiv-ask-user-question/config.json and add remote.feishu.appId / appSecret / receivers.",
						"error",
					);
					return;
				}
				next = true;
			} else if (arg === "off") {
				next = false;
			} else {
				ctx.ui.notify(USAGE, "error");
				return;
			}

			if (next === cfg.enabled) {
				ctx.ui.notify(formatStatusSummary(cfg), "info");
				return;
			}

			if (!setRemoteEnabled(next)) {
				ctx.ui.notify("Failed to write config — remote mode unchanged", "error");
				return;
			}
			const updated = loadRemoteConfig(loadConfig().remote);
			ctx.ui.notify(formatStatusSummary(updated, next), "info");
		},
	});
}
