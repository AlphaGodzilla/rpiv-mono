import { t } from "../state/i18n-bridge.js";
import type { QuestionAnswer, QuestionData } from "../tool/types.js";

/**
 * Pure message formatting / reply parsing for the Feishu remote flow.
 *
 * Formatting mirrors the RPC walker (`../rpc-fallback.ts`) conventions:
 * numbered option lines with descriptions, previews folded in and truncated,
 * and the same index-token parsing semantics for replies.
 */

/** Longest preview slice folded into a question message before truncation. */
export const MAX_REMOTE_PREVIEW_CHARS = 600;

export const REMOTE_MSG_HEADER = (header: string): string => `[${header}]`;
export const REMOTE_MSG_QUESTION = (question: string): string => question;

// Canonical-English fallbacks; resolved through `t()` at call time so the live
// locale applies (same pattern as rpc-fallback.ts).
const MSG_OPTION_LINE = (n: number, label: string, description: string): string => `${n}. ${label} — ${description}`;
const MSG_PREVIEW_BLOCK = (n: number, preview: string): string =>
	`\n--- ${n}. preview ---\n${preview.slice(0, MAX_REMOTE_PREVIEW_CHARS)}`;
const MSG_SINGLE_HINT = 'Reply with the option number, or type your own answer. Reply "取消" or "cancel" to abort.';
const MSG_MULTI_HINT =
	'Reply with the numbers of all that apply, comma-separated (e.g. "1,3"), or type your own answer. Reply "取消" or "cancel" to abort.';
/** Canonical-English fallback for the back-to-TUI hint; resolved through `t()` at call time. */
const MSG_TUI_HINT = 'Reply "tui" to answer the remaining questions in the terminal instead.';
/**
 * Reserved replies that switch the questionnaire back to the local TUI: the
 * user replies `tui` (or `本地`) instead of an answer. The Feishu card carries
 * an equivalent 「回到 TUI」 button; both are accepted by the Feishu wait.
 */
export const TUI_HANDOFF_WORDS: readonly string[] = ["tui", "本地"];

/**
 * Build the Feishu message text for one question: header, question, numbered
 * options (with folded previews), and a reply hint. `extraHints` are appended
 * after the standard hint — the Feishu flow adds the back-to-TUI keyword line
 * there, while Telegram reuses this builder and passes none.
 */
export function buildQuestionMessage(q: QuestionData, extraHints: readonly string[] = []): string {
	const lines: string[] = [];
	const header = q.header ? `${REMOTE_MSG_HEADER(q.header)} ` : "";
	lines.push(`${header}${REMOTE_MSG_QUESTION(q.question)}`);
	lines.push("");
	q.options.forEach((o, i) => {
		lines.push(MSG_OPTION_LINE(i + 1, o.label, o.description));
		if (o.preview && o.preview.length > 0) lines.push(MSG_PREVIEW_BLOCK(i + 1, o.preview));
	});
	lines.push("");
	lines.push(
		q.multiSelect ? t("remote.msg.multi_hint", MSG_MULTI_HINT) : t("remote.msg.single_hint", MSG_SINGLE_HINT),
	);
	for (const hint of extraHints) {
		if (hint.trim().length > 0) lines.push(hint);
	}
	return lines.join("\n");
}

/** True when the trimmed reply exactly matches one of the configured cancel words (case-insensitive). */
export function isCancelWord(text: string, cancelWords: readonly string[]): boolean {
	const trimmed = text.trim().toLowerCase();
	return cancelWords.some((w) => w.trim().toLowerCase() === trimmed);
}

/** True when the reply asks to continue in the local TUI instead of answering here. */
export function isTuiHandoffWord(text: string): boolean {
	const trimmed = text.trim().toLowerCase();
	return TUI_HANDOFF_WORDS.some((w) => w.toLowerCase() === trimmed);
}

/** The localized back-to-TUI hint appended to Feishu text messages. */
export function tuiHandoffHint(): string {
	return t("remote.msg.tui_hint", MSG_TUI_HINT);
}

export type ParsedReply = { kind: "cancel" } | { kind: "answer"; answer: QuestionAnswer };

/**
 * Parse a free-text reply into a `QuestionAnswer` (or a cancel signal).
 * Mirrors `rpc-fallback.ts` semantics: leading-digit index parsing for
 * single-select, comma/space-separated index lists for multi-select, and any
 * other text preserved verbatim as a custom answer.
 */
export function parseReply(
	text: string,
	question: QuestionData,
	questionIndex: number,
	cancelWords: readonly string[],
): ParsedReply {
	if (isCancelWord(text, cancelWords)) return { kind: "cancel" };

	const trimmed = text.trim();
	const optionCount = question.options.length;

	// Single-select: a leading-digit index selects that option.
	if (!question.multiSelect) {
		const idx = parseIndexToken(trimmed, optionCount);
		if (idx !== null) {
			const o = question.options[idx];
			return {
				kind: "answer",
				answer: {
					questionIndex,
					question: question.question,
					kind: "option",
					answer: o.label,
					preview: o.preview && o.preview.length > 0 ? o.preview : undefined,
				},
			};
		}
		return {
			kind: "answer",
			answer: { questionIndex, question: question.question, kind: "custom", answer: trimmed },
		};
	}

	// Multi-select: all-numeric tokens → selected labels; anything else → custom.
	const tokens = trimmed.split(/[,\s]+/).filter((tok) => tok.length > 0);
	if (tokens.length > 0 && tokens.every((tok) => /^\d+\.?$/.test(tok))) {
		const selected: string[] = [];
		for (const tok of tokens) {
			const i = parseIndexToken(tok, optionCount);
			if (i === null) {
				// Out-of-range number (e.g. "13" for three options) is a typed answer.
				return {
					kind: "answer",
					answer: { questionIndex, question: question.question, kind: "custom", answer: trimmed },
				};
			}
			const label = question.options[i].label;
			if (!selected.includes(label)) selected.push(label);
		}
		return {
			kind: "answer",
			answer: { questionIndex, question: question.question, kind: "multi", answer: null, selected },
		};
	}
	// Any other text (or an empty reply) is preserved verbatim as a custom answer.
	return {
		kind: "answer",
		answer: { questionIndex, question: question.question, kind: "custom", answer: trimmed },
	};
}

/**
 * Parse a "N…" token to a 0-based option index. Mirrors rpc-fallback's
 * `parseIndex`: parseInt reads the leading digits of "2. B — b" as 2; NaN and
 * out-of-range fail the bounds check and return null.
 */
function parseIndexToken(token: string, count: number): number | null {
	const i = Number.parseInt(token, 10) - 1;
	return i >= 0 && i < count ? i : null;
}

/**
 * Button-value payloads embedded in question cards. `q` pins the question
 * index so a click on a stale card (from an earlier question) is ignored;
 * `o` is the 1-based option index for single-select, `c: "1"` marks cancel,
 * `t: "1"` marks the 「回到 TUI」 handoff (the questionnaire continues in the
 * terminal and the card locks). `ackText` is the toast the pi-channel plugin
 * shows for the click (feishu 3s callback response / telegram
 * answerCallbackQuery).
 */
export interface CardButtonValue {
	q: string;
	o?: string;
	c?: string;
	t?: string;
	ackText?: string;
}

export const CARD_CANCEL_VALUE: CardButtonValue = { q: "0", c: "1" };

const CARD_HEADER_TEMPLATE = "blue";
const CARD_OPTION_LINE = (n: number, label: string, description: string): string =>
	`**${n}. ${label}** — ${description}`;
const CARD_MULTI_HINT = "点击「取消」中止，或用文本回复编号列表（如 1,2）";
/** 「回到 TUI」 affordance: the handoff also works as a reserved reply word. */
const CARD_TUI_LABEL = "回到 TUI";
const CARD_TUI_DONE_LABEL = "已切回 TUI";
const CARD_TUI_ACK = "已切回 TUI";
const CARD_TUI_HINT = "点击「回到 TUI」或在飞书回复 tui 回到本地界面作答。";
const CARD_TUI_LINE = "\n\n_已切回 TUI 作答_";

function buttonElement(
	text: string,
	type: "primary" | "default" | "danger",
	value: CardButtonValue,
	disabled = false,
): object {
	const el: Record<string, unknown> = {
		tag: "button",
		text: { content: text, tag: "plain_text" },
		type,
		behaviors: [{ type: "callback", value }],
	};
	if (disabled) el.disabled = true;
	return el;
}

function columnOf(button: object): object {
	return {
		tag: "column",
		width: "weighted",
		vertical_align: "top",
		elements: [button],
	};
}

const CARD_SELECTED_PREFIX = "✓ ";
const CARD_CANCELLED_LINE = "\n\n_已取消_";

/**
 * Build a Feishu interactive-card (V2 schema) for one question.
 *
 * Single-select questions get one clickable button per option plus a Cancel
 * button — clicks are routed back as replies via `card.action.trigger`
 * (verified working over the long-connection transport). Multi-select keeps
 * the free-text interaction (buttons cannot express a selection list) and the
 * card carries the options plus a Cancel button. Both shapes carry a
 * 「回到 TUI」 button: it answers nothing, it asks the caller to keep the
 * questionnaire going in the terminal instead (the same handoff the reserved
 * `tui` reply triggers).
 *
 * When `selectedIndex` (0-based option index) is provided the card is rebuilt
 * in "answered" state: the chosen button gains a ✓ prefix, and every other
 * button (options + cancel) is disabled so repeated clicks cannot double-fire.
 * When `cancelled` is true all buttons are disabled and a notice line is
 * appended. When `handedOff` is true every button is disabled as well (the
 * user is answering in the TUI now, so the card must not stay clickable) and
 * the card says the questionnaire moved to the terminal.
 */
export function buildQuestionCard(
	q: QuestionData,
	questionIndex: number,
	selectedIndex?: number,
	cancelled = false,
	handedOff = false,
): object {
	const answered = selectedIndex !== undefined || cancelled || handedOff;
	const header = q.header ? `${REMOTE_MSG_HEADER(q.header)} ` : "";
	const optionLines = q.options.map((o, i) => CARD_OPTION_LINE(i + 1, o.label, o.description)).join("\n");
	const hint = q.multiSelect
		? t("remote.msg.multi_hint", MSG_MULTI_HINT)
		: t("remote.msg.single_hint", MSG_SINGLE_HINT);
	// A handed-off card advertises where the questionnaire went; a cancelled card
	// has no way back, so it carries neither line; an open card offers the button.
	const stateLine = handedOff ? CARD_TUI_LINE : cancelled ? CARD_CANCELLED_LINE : `\n\n${CARD_TUI_HINT}`;

	const markdown = q.multiSelect
		? `${header}${q.question}\n\n${optionLines}\n\n${hint}\n\n${CARD_MULTI_HINT}${stateLine}`
		: `${header}${q.question}\n\n${optionLines}\n\n${hint}${stateLine}`;

	const elements: object[] = [{ tag: "markdown", content: markdown }, { tag: "hr" }];

	const tuiButton = buttonElement(
		handedOff ? CARD_TUI_DONE_LABEL : CARD_TUI_LABEL,
		"default",
		{ q: String(questionIndex), t: "1", ackText: CARD_TUI_ACK },
		answered,
	);

	const cancelButton = buttonElement(
		answered && !cancelled ? "取消" : cancelled ? "已取消" : "取消",
		"danger",
		{ q: String(questionIndex), c: "1", ackText: "已取消" },
		answered,
	);

	if (q.multiSelect) {
		elements.push({
			tag: "column_set",
			flex_mode: "none",
			background_style: "default",
			columns: [columnOf(tuiButton), columnOf(cancelButton)],
		});
	} else {
		// Option buttons, up to 3 per row; a trailing row with 「回到 TUI」 + Cancel.
		const rowSize = 3;
		for (let start = 0; start < q.options.length; start += rowSize) {
			const rowButtons = q.options.slice(start, start + rowSize).map((o, i) => {
				const optionNum = start + i + 1;
				const isSelected = selectedIndex !== undefined && selectedIndex === start + i;
				return buttonElement(
					isSelected ? `${CARD_SELECTED_PREFIX}${o.label}` : o.label,
					isSelected ? "primary" : "default",
					{ q: String(questionIndex), o: String(optionNum), ackText: "已选择" },
					answered && !isSelected,
				);
			});
			elements.push({
				tag: "column_set",
				flex_mode: "none",
				background_style: "default",
				columns: rowButtons.map(columnOf),
			});
		}
		elements.push({
			tag: "column_set",
			flex_mode: "none",
			background_style: "default",
			columns: [columnOf(tuiButton), columnOf(cancelButton)],
		});
	}

	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { template: CARD_HEADER_TEMPLATE, title: { content: q.header || q.question, tag: "plain_text" } },
		body: { elements },
	};
}
