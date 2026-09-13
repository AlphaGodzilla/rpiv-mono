import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { loadConfig, resolveCollapseKey, validateGuidanceFields } from "./config.js";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.js";
import { isAskPrdActive } from "./remote/ask-prd-state.js";
import {
	classifyRemoteError,
	createFeishuTransport,
	createTgTransport,
	type EventsLike,
} from "./remote/channel-transport.js";
import {
	getLocalTimeoutMs,
	isTgConfigured,
	loadRemoteConfig,
	type RemoteConfig,
	shouldUseRemote,
} from "./remote/remote-config.js";
import { type RemoteOutcome, type RemoteQuestion, runRemoteQuestionnaire } from "./remote/remote-questionnaire.js";
import { runTgQuestionnaire } from "./remote/tg-questionnaire.js";
// Static import is fine — rpc-fallback pulls only types + the i18n bridge,
// none of the ~560ms TUI render graph that QuestionnaireSession lazy-loads.
import { hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";
import { displayLabel, t } from "./state/i18n-bridge.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireError,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams): void {
	const payload: AskUserPromptEventPayload = {
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitAskUserBlockedEvent(pi: ExtensionAPI, active: boolean): void {
	const payload: AskUserBlockedEventPayload = { active };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

/** Canonical tool name — single source of truth shared with the reconcile module. */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const ERROR_REMOTE_CHANNEL_FAILED =
	"Error: the Feishu remote channel is unavailable (check remote.feishu.receivers in ~/.pi/agent/extensions/rpiv-ask-user-question/config.json, falling back to ~/.config/rpiv-ask-user-question/config.json, and that the pi-channel plugin is installed with working Feishu credentials). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead.";

const ERROR_TG_CHANNEL_FAILED =
	"Error: the Telegram remote channel is unavailable (check remote.tg.chatId/userId in ~/.pi/agent/extensions/rpiv-ask-user-question/config.json, falling back to ~/.config/rpiv-ask-user-question/config.json, and that the pi-channel plugin is installed with a working bot token). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead.";
const ERROR_SESSION_LOAD_FAILED =
	"Error: the questionnaire UI failed to load — the host's installed dependencies were likely replaced or removed on disk while Pi was running (e.g. a package-manager install touched the store). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user that restoring this tool requires repairing the install if needed and restarting Pi.";

const ERROR_STALE_MODULE_CACHE =
	"Error: the questionnaire UI cannot load — the host's module cache went stale after an earlier failed load (typically dependencies replaced on disk mid-session). This is unrecoverable within the current Pi process. The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, and tell the user to restart Pi to restore this tool.";

/** Delay before the background session-graph pre-warm; mirrors rpiv-workflow's /wf prewarm. */
export const PREWARM_DELAY_MS = 2000;

type SessionModule = typeof import("./state/questionnaire-session.js");

type SessionLoad =
	| { ok: true; module: SessionModule }
	| { ok: false; error: Extract<QuestionnaireError, "session_load_failed" | "stale_module_cache">; message: string };

/**
 * Lazy-load the ~560ms QuestionnaireSession view/TUI render graph, guarding
 * the two failure shapes of issue #107. Pi's jiti loader registers a module in
 * its graph cache BEFORE evaluating the body and does not evict it when
 * evaluation throws (jiti 2.7.0), so one failed load — e.g. `pnpm install
 * --force` replacing the store entry mid-session — leaves every later import
 * of this specifier resolving to a namespace without the class. That state is
 * unrecoverable in-process (cache-busting specifiers fail jiti resolution);
 * both branches therefore return an LLM-facing envelope that names the restart
 * requirement instead of leaking a bare "not a constructor" TypeError.
 */
export async function loadQuestionnaireSession(): Promise<SessionLoad> {
	let mod: SessionModule;
	try {
		mod = await import("./state/questionnaire-session.js");
	} catch (e) {
		const cause = e instanceof Error ? e.message : String(e);
		return { ok: false, error: "session_load_failed", message: `${ERROR_SESSION_LOAD_FAILED} (cause: ${cause})` };
	}
	if (typeof mod.QuestionnaireSession !== "function") {
		const keys = JSON.stringify(Object.keys(mod));
		return {
			ok: false,
			error: "stale_module_cache",
			message: `${ERROR_STALE_MODULE_CACHE} (resolved namespace keys: ${keys})`,
		};
	}
	return { ok: true, module: mod };
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask User Question",
		description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;
			if (!ctx.hasUI) return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			// Emit event for external listeners (e.g., notification plugins)
			emitAskUserPromptEvent(pi, typed);

			// Feishu remote as primary mode: every questionnaire goes to Feishu and
			// the user answers there (group chats must @ the bot). Falls back to the
			// original flows only when remote mode is off or credentials are missing.
			const remoteCfg = loadRemoteConfig(loadConfig().remote);

			// Session-level ask-prd: Telegram takes over and ALL Feishu logic — the
			// remote-as-primary path AND the local-timeout fallback to Feishu — is
			// skipped. When tg is not configured we still go local, but with the
			// Feishu fallback disabled so nothing ever reaches Feishu under ask-prd.
			if (isAskPrdActive(ctx.sessionManager?.getSessionId())) {
				emitAskUserBlockedEvent(pi, true);
				try {
					if (!isTgConfigured(remoteCfg)) {
						return localOutcomeEnvelope(
							await runLocalQuestionnaire(pi, ctx, typed, remoteCfg, { enableLocalTimeout: false }),
							typed,
						);
					}
					const outcome = await runTgQuestionnaireWithConnect(
						pi.events,
						ctx,
						typed.questions.map((q, i) => ({ question: q, index: i })),
						remoteCfg,
					);
					if (outcome.kind === "answered") return buildQuestionnaireResponse(outcome.result, typed);
					// Telegram stayed silent past its (independent, longer) timeout — recover
					// to the main conversation's local ask instead of treating silence as a decline.
					if (outcome.kind === "timed_out") {
						const recovered = await recoverFromRemoteTimeout(
							pi,
							ctx,
							typed.questions.map((q, i) => ({ question: q, index: i })),
							outcome,
							remoteCfg,
						);
						return localOutcomeEnvelope(recovered, typed);
					}
					return buildToolResult(outcome.message, { answers: outcome.partialAnswers, cancelled: true });
				} finally {
					emitAskUserBlockedEvent(pi, false);
				}
			}
			if (shouldUseRemote(remoteCfg)) {
				emitAskUserBlockedEvent(pi, true);
				try {
					const outcome = await runRemoteQuestionnaireWithConnect(
						pi.events,
						ctx,
						typed.questions.map((q, i) => ({ question: q, index: i })),
						remoteCfg,
					);
					if (outcome.kind === "answered") return buildQuestionnaireResponse(outcome.result, typed);
					// Feishu stayed silent past the per-question timeout — recover to the
					// main conversation's local ask instead of treating silence as a decline.
					if (outcome.kind === "timed_out") {
						const recovered = await recoverFromRemoteTimeout(
							pi,
							ctx,
							typed.questions.map((q, i) => ({ question: q, index: i })),
							outcome,
							remoteCfg,
						);
						return localOutcomeEnvelope(recovered, typed);
					}
					return buildToolResult(outcome.message, { answers: outcome.partialAnswers, cancelled: true });
				} finally {
					emitAskUserBlockedEvent(pi, false);
				}
			}

			return localOutcomeEnvelope(await runLocalQuestionnaire(pi, ctx, typed, remoteCfg), typed);
		},
	});

	// Pre-warm the lazy session graph once startup settles (#107). A graph
	// evaluated while the paths Pi resolved at boot still exist stays in memory
	// for the process lifetime, so later on-disk dependency churn (e.g. `pnpm
	// install --force` replacing the store mid-session) can no longer poison
	// jiti's graph cache. Swallowed failure is safe: the first real call
	// re-imports and surfaces it through loadQuestionnaireSession's structured
	// envelope. unref keeps the timer from holding a non-TUI embedder's process
	// open.
	const timer = setTimeout(() => void loadQuestionnaireSession().catch(() => undefined), PREWARM_DELAY_MS);
	timer.unref?.();
}

/**
 * Run the Feishu questionnaire over the pi-channel event bus. Send failures
 * (including a missing plugin / result timeout) are classified and surfaced as
 * an LLM-facing failure envelope — the user never saw the questions, so this
 * is NOT a decline.
 */
async function runRemoteQuestionnaireWithConnect(
	events: EventsLike,
	ctx: { ui: { notify?: (msg: string, level: "info" | "error") => void } },
	questions: RemoteQuestion[],
	cfg: RemoteConfig,
): Promise<RemoteOutcome> {
	try {
		const transport = await createFeishuTransport(cfg.feishu, { events });
		try {
			return await runRemoteQuestionnaire(transport, questions, cfg, (msg, level) => ctx.ui.notify?.(msg, level));
		} finally {
			await transport.close();
		}
	} catch (err) {
		const { code, message } = classifyRemoteError(err);
		return {
			kind: "failed",
			message: `${ERROR_REMOTE_CHANNEL_FAILED} (code ${code} — ${message})`,
			partialAnswers: [],
		};
	}
}

/**
 * Run the ask-prd Telegram questionnaire over the pi-channel event bus. Send
 * failures (including a missing plugin / result timeout) are classified and
 * surfaced as an LLM-facing failure envelope — the user never saw the questions,
 * so this is NOT a decline.
 */
async function runTgQuestionnaireWithConnect(
	events: EventsLike,
	ctx: { ui: { notify?: (msg: string, level: "info" | "error") => void } },
	questions: RemoteQuestion[],
	cfg: RemoteConfig,
): Promise<RemoteOutcome> {
	try {
		const transport = createTgTransport(cfg.tg, { events });
		try {
			return await runTgQuestionnaire(transport, questions, cfg, (msg, level) => ctx.ui.notify?.(msg, level));
		} finally {
			await transport.close();
		}
	} catch (err) {
		const { code, message } = classifyRemoteError(err);
		return {
			kind: "failed",
			message: `${ERROR_TG_CHANNEL_FAILED} (code ${code} — ${message})`,
			partialAnswers: [],
		};
	}
}

type LocalQuestionnaireOutcome =
	| { kind: "answered"; result: QuestionnaireResult }
	| { kind: "failed"; message: string; result: QuestionnaireResult };

/** Structural slice of the tool exec context the local flows need. */
type LocalQuestionnaireCtx = {
	cwd: string;
	isProjectTrusted: () => boolean;
	mode?: string;
	ui: ExtensionUIContext;
};

/** Map a local-flow outcome to the LLM-facing tool envelope. */
function localOutcomeEnvelope(outcome: LocalQuestionnaireOutcome, params: QuestionParams) {
	return outcome.kind === "answered"
		? buildQuestionnaireResponse(outcome.result, params)
		: buildToolResult(outcome.message, outcome.result);
}

/**
 * Run the questionnaire in the main conversation — the RPC dialog walker for
 * RPC hosts, the tabbed TUI overlay otherwise. Shared by the primary path and
 * by the remote-timeout recovery, which re-asks the still-unanswered
 * questions here. `enableLocalTimeout` is switched off during recovery so a
 * second silence ends in the local ask instead of bouncing back to Feishu.
 */
async function runLocalQuestionnaire(
	pi: ExtensionAPI,
	ctx: LocalQuestionnaireCtx,
	typed: QuestionParams,
	remoteCfg: RemoteConfig,
	options: { enableLocalTimeout?: boolean } = {},
): Promise<LocalQuestionnaireOutcome> {
	const enableLocalTimeout = options.enableLocalTimeout ?? true;

	// RPC hosts (VSCode pendant, ACP clients like Zed/Paseo — issue #78):
	// ui.custom() cannot render there, but the select/input dialog
	// sub-protocol works. Hosts that advertise ctx.mode (pi ≥0.79) route to
	// the sequential dialog walker up front, skipping the TUI render-graph
	// import entirely; RPC builds that predate ctx.mode are caught by the
	// custom()-resolved-undefined backstop below. See ./rpc-fallback.ts.
	if (ctx.mode === "rpc" && hasDialogUI(ctx.ui)) {
		emitAskUserBlockedEvent(pi, true);
		try {
			return { kind: "answered", result: await runRpcQuestionnaire(ctx.ui, typed) };
		} finally {
			emitAskUserBlockedEvent(pi, false);
		}
	}

	const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

	// Lazy — QuestionnaireSession pulls the ~560ms view/TUI render graph;
	// load it only when the tool runs, not at extension registration.
	const sessionLoad = await loadQuestionnaireSession();
	if (!sessionLoad.ok) {
		return {
			kind: "failed",
			message: sessionLoad.message,
			result: { answers: [], cancelled: true, error: sessionLoad.error },
		};
	}
	const { QuestionnaireSession } = sessionLoad.module;
	// Resolve the collapse/expand key spec from config. Default is `ctrl+]`; users
	// with non-US layouts (e.g. Latin American, where `]` is shifted) can override
	// via the `collapseKey` config field. `resolveCollapseKey` also accepts the
	// sentinel value `"off"` to disable the shortcut entirely.
	const collapseKey = resolveCollapseKey(loadConfig());

	// Capture the overlay handle so the session can call `setHidden()` when the
	// user toggles collapse, and register a raw terminal input listener for the
	// same key so the toggle still works while the overlay is hidden (pi-tui does
	// not route input to a hidden overlay's `component.handleInput`).
	const sessionRef: {
		current: import("./state/questionnaire-session.js").QuestionnaireSession | null;
	} = { current: null };
	const overlayHandleRef: { current: import("@earendil-works/pi-tui").OverlayHandle | undefined } = {
		current: undefined,
	};
	let hasAnnouncedHide = false;
	let removeOverlayInputListener: (() => void) | undefined;

	if (collapseKey !== "off" && typeof ctx.ui.onTerminalInput === "function") {
		removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
			const handle = overlayHandleRef.current;
			if (!handle) return undefined;
			// Only act while the questionnaire is hidden (its handleInput is
			// unreachable) or actually focused. When some other overlay is on
			// top (e.g. `/btw`), leave the keystroke to that overlay instead of
			// toggling the questionnaire from underneath it.
			if (!handle.isHidden() && !handle.isFocused()) return undefined;
			if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
			// Kitty-protocol terminals report press, repeat, and release separately.
			// Toggle only on the initial press so a tap does not immediately reopen
			// the overlay and a held key does not toggle it repeatedly.
			if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
			sessionRef.current?.toggleCollapsedExternal();
			if (handle.isHidden() && !hasAnnouncedHide) {
				hasAnnouncedHide = true;
				ctx.ui.notify?.(`ask_user_question hidden — press ${collapseKey} to reopen`, "info");
			}
			return { consume: true };
		});
	}
	// Local-timeout fallback: when `localTimeoutMs` is configured (and remote
	// credentials exist), an unanswered local dialog hands the remaining
	// questions over to Feishu. The timer only starts for the TUI path — the
	// RPC walker above returned already.
	const localTimeoutMs = enableLocalTimeout ? getLocalTimeoutMs(remoteCfg) : undefined;
	let localTimer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	if (localTimeoutMs !== undefined) {
		localTimer = setTimeout(() => {
			timedOut = true;
			sessionRef.current?.extractPartialAnswersAndClose();
		}, localTimeoutMs);
		// A stray timer must not hold a non-TUI embedder's process open.
		localTimer.unref?.();
	}

	emitAskUserBlockedEvent(pi, true);
	try {
		const result = await ctx.ui.custom<QuestionnaireResult>(
			(tui, theme, keybindings, done) => {
				const session = new QuestionnaireSession({
					tui,
					theme,
					params: typed,
					itemsByTab,
					done,
					keybindings,
					editInput: async (value) => {
						try {
							const [{ SettingsManager }, { editWithExternalEditor }] = await Promise.all([
								import("@earendil-works/pi-coding-agent"),
								import("./state/external-editor.js"),
							]);
							const editorCommand = SettingsManager.create(ctx.cwd, undefined, {
								projectTrusted: ctx.isProjectTrusted(),
							}).getExternalEditorCommand();
							if (!editorCommand) throw new Error("No external editor command is configured");
							return await editWithExternalEditor(tui, editorCommand, value);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							ctx.ui.notify(`${t("editor.failed", "External editor failed")}: ${message}`, "error");
							return undefined;
						}
					},
					collapseKey,
				});
				sessionRef.current = session;
				return session.component;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: { left: 0, right: 0, bottom: 0 },
				},
				onHandle: (handle) => {
					overlayHandleRef.current = handle;
					sessionRef.current?.setOverlayHandle(handle);
				},
			},
		);

		// A TUI questionnaire ALWAYS resolves a QuestionnaireResult (cancel
		// included — state-reducer emits `{ answers, cancelled }`), so
		// `undefined` uniquely means "host cannot render", never "user
		// declined". RPC builds that predate ctx.mode land here: run the
		// dialog walker when the host has the primitives; otherwise tell the
		// model the user never saw the questions.
		if (result === undefined) {
			if (hasDialogUI(ctx.ui)) {
				return { kind: "answered", result: await runRpcQuestionnaire(ctx.ui, typed) };
			}
			return {
				kind: "failed",
				message: ERROR_NO_CUSTOM_UI,
				result: { answers: [], cancelled: true, error: "no_custom_ui" },
			};
		}

		// User cancelled (Esc) — never hand off to Feishu; respect the decline.
		if (result.cancelled) return { kind: "answered", result };

		// Local timeout fired: forward the still-unanswered questions to Feishu
		// and merge the local answers back into the envelope.
		if (timedOut) {
			const answered = new Set(result.answers.map((a) => a.questionIndex));
			const remaining = typed.questions
				.map((q, i) => ({ question: q, index: i }))
				.filter(({ index }) => !answered.has(index));
			if (remaining.length > 0) {
				ctx.ui.notify?.(
					t("remote.fallback_notify", "Local wait timed out — remaining questions sent to Feishu"),
					"info",
				);
				const outcome = await runRemoteQuestionnaireWithConnect(pi.events, ctx, remaining, remoteCfg);
				if (outcome.kind === "answered") {
					return {
						kind: "answered",
						result: {
							answers: [...result.answers, ...outcome.result.answers],
							cancelled: outcome.result.cancelled,
						},
					};
				}
				// Feishu also stayed silent — recover to the main conversation.
				if (outcome.kind === "timed_out") {
					const recovered = await recoverFromRemoteTimeout(pi, ctx, remaining, outcome, remoteCfg);
					if (recovered.kind === "failed") return recovered;
					return {
						kind: "answered",
						result: {
							answers: [...result.answers, ...recovered.result.answers],
							cancelled: recovered.result.cancelled,
						},
					};
				}
				return {
					kind: "failed",
					message: outcome.message,
					result: { answers: [...result.answers, ...outcome.partialAnswers], cancelled: true },
				};
			}
		}

		return { kind: "answered", result };
	} finally {
		if (localTimer !== undefined) clearTimeout(localTimer);
		removeOverlayInputListener?.();
		emitAskUserBlockedEvent(pi, false);
	}
}

/**
 * Feishu wait timed out with no reply: re-ask the still-unanswered questions
 * in the main conversation (local TUI / RPC ask). Answers keep their ORIGINAL
 * `questionIndex` — local answers are remapped through `questions` so the
 * merged envelope stays aligned with the caller's original `typed.questions`.
 */
async function recoverFromRemoteTimeout(
	pi: ExtensionAPI,
	ctx: LocalQuestionnaireCtx,
	questions: RemoteQuestion[],
	outcome: Extract<RemoteOutcome, { kind: "timed_out" }>,
	remoteCfg: RemoteConfig,
): Promise<LocalQuestionnaireOutcome> {
	const answered = new Set(outcome.partialAnswers.map((a) => a.questionIndex));
	const remaining = questions.filter(({ index }) => !answered.has(index));
	if (remaining.length === 0) {
		return { kind: "answered", result: { answers: outcome.partialAnswers, cancelled: false } };
	}
	ctx.ui.notify?.(
		t("remote.timeout_recover", "No reply from Feishu — asking in the main conversation instead"),
		"info",
	);
	const local = await runLocalQuestionnaire(pi, ctx, { questions: remaining.map((r) => r.question) }, remoteCfg, {
		enableLocalTimeout: false,
	});
	if (local.kind === "failed") return local;
	const remapped = local.result.answers.map((a) => ({
		...a,
		questionIndex: remaining[a.questionIndex]?.index ?? a.questionIndex,
	}));
	return {
		kind: "answered",
		result: { answers: [...outcome.partialAnswers, ...remapped], cancelled: local.result.cancelled },
	};
}

export { buildQuestionnaireResponse, buildToolResult };
