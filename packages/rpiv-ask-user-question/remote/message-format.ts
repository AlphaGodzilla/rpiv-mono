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

/**
 * Build the Feishu message text for one question: header, question, numbered
 * options (with folded previews), and a reply hint.
 */
export function buildQuestionMessage(q: QuestionData): string {
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
	return lines.join("\n");
}

/** True when the trimmed reply exactly matches one of the configured cancel words (case-insensitive). */
export function isCancelWord(text: string, cancelWords: readonly string[]): boolean {
	const trimmed = text.trim().toLowerCase();
	return cancelWords.some((w) => w.trim().toLowerCase() === trimmed);
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
 * `o` is the 1-based option index for single-select, `c: "1"` marks cancel.
 * `ackText` is the toast the pi-channel plugin shows for the click (feishu
 * 3s callback response / telegram answerCallbackQuery).
 */
export interface CardButtonValue {
	q: string;
	o?: string;
	c?: string;
	ackText?: string;
}

export const CARD_CANCEL_VALUE: CardButtonValue = { q: "0", c: "1" };

const CARD_HEADER_TEMPLATE = "blue";
const CARD_OPTION_LINE = (n: number, label: string, description: string): string =>
	`**${n}. ${label}** — ${description}`;
const CARD_MULTI_HINT = "点击「取消」中止，或用文本回复编号列表（如 1,2）";

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

/**
 * Build a Feishu interactive-card (V2 schema) for one question.
 *
 * Single-select questions get one clickable button per option plus a Cancel
 * button — clicks are routed back as replies via `card.action.trigger`
 * (verified working over the long-connection transport). Multi-select keeps
 * the free-text interaction (buttons cannot express a selection list) and the
 * card carries the options plus a Cancel button.
 */
const CARD_SELECTED_PREFIX = "✓ ";
const CARD_CANCELLED_LINE = "\n\n_已取消_";

/**
 * Build a Feishu interactive-card (V2 schema) for one question.
 *
 * Single-select questions get one clickable button per option plus a Cancel
 * button — clicks are routed back as replies via `card.action.trigger`
 * (verified working over the long-connection transport). Multi-select keeps
 * the free-text interaction (buttons cannot express a selection list) and the
 * card carries the options plus a Cancel button.
 *
 * When `selectedIndex` (0-based option index) is provided the card is rebuilt
 * in "answered" state: the chosen button gains a ✓ prefix, and every other
 * button (options + cancel) is disabled so repeated clicks cannot double-fire.
 * When `cancelled` is true all buttons are disabled and a notice line is
 * appended.
 */
export function buildQuestionCard(
	q: QuestionData,
	questionIndex: number,
	selectedIndex?: number,
	cancelled = false,
): object {
	const answered = selectedIndex !== undefined || cancelled;
	const header = q.header ? `${REMOTE_MSG_HEADER(q.header)} ` : "";
	const optionLines = q.options.map((o, i) => CARD_OPTION_LINE(i + 1, o.label, o.description)).join("\n");
	const hint = q.multiSelect
		? t("remote.msg.multi_hint", MSG_MULTI_HINT)
		: t("remote.msg.single_hint", MSG_SINGLE_HINT);

	const markdown = q.multiSelect
		? `${header}${q.question}\n\n${optionLines}\n\n${hint}\n\n${CARD_MULTI_HINT}${cancelled ? CARD_CANCELLED_LINE : ""}`
		: `${header}${q.question}\n\n${optionLines}\n\n${hint}${cancelled ? CARD_CANCELLED_LINE : ""}`;

	const elements: object[] = [{ tag: "markdown", content: markdown }, { tag: "hr" }];

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
			columns: [columnOf(cancelButton)],
		});
	} else {
		// Option buttons, up to 3 per row; a trailing Cancel button on its own row.
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
			columns: [columnOf(cancelButton)],
		});
	}

	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { template: CARD_HEADER_TEMPLATE, title: { content: q.header || q.question, tag: "plain_text" } },
		body: { elements },
	};
}
