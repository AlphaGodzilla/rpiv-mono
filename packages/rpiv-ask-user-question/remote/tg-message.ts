import type { QuestionData } from "../tool/types.js";
import { buildQuestionMessage } from "./message-format.js";
import type { TgRemoteConfig } from "./remote-config.js";

/**
 * Telegram message formatting for the `ask-prd` flow.
 *
 * The question body reuses the Feishu `buildQuestionMessage` (channel-agnostic:
 * numbered options, folded previews, reply hint); the tg-specific additions are
 * the @-mention line and the inline-keyboard buttons. Reply parsing stays on
 * the shared `parseReply`/`isCancelWord` from message-format.js.
 */

/** callback_data payloads — `q` pins the question index, `o` the option, `c` cancel, `d` a locked/done marker. */
export interface TgButtonValue {
	q: string;
	o?: string;
	c?: string;
	d?: string;
}

const TG_OPTIONS_PER_ROW = 3;

function tgMention(cfg: TgRemoteConfig): string {
	const target = cfg.username && cfg.username.trim().length > 0 ? cfg.username.trim() : `@user(${cfg.userId})`;
	return `<a href="tg://user?id=${cfg.userId}">${target}</a>`;
}

/** Question message: @-mention line on top, then the shared numbered-options body. */
export function buildTgQuestionMessage(q: QuestionData, cfg: TgRemoteConfig): string {
	return `${tgMention(cfg)}\n${buildQuestionMessage(q)}`;
}

interface TgButton {
	text: string;
	callback_data: string;
}

function button(text: string, value: TgButtonValue): TgButton {
	return { text, callback_data: JSON.stringify(value) };
}

function cancelButton(questionIndex: number): TgButton {
	return button("取消", { q: String(questionIndex), c: "1" });
}

/**
 * Inline-keyboard card. Single-select: one button per option (up to 3 per row)
 * plus a trailing Cancel button — clicks answer directly. Multi-select: buttons
 * cannot express a selection list, so the card keeps the option text (in the
 * message body) and only a Cancel button; the user replies with "1,2" text.
 */
export function buildTgKeyboard(q: QuestionData, questionIndex: number): object {
	const rows: TgButton[][] = [];
	if (!q.multiSelect) {
		for (let start = 0; start < q.options.length; start += TG_OPTIONS_PER_ROW) {
			rows.push(
				q.options.slice(start, start + TG_OPTIONS_PER_ROW).map((o, i) => {
					const optionNum = start + i + 1;
					return button(o.label, { q: String(questionIndex), o: String(optionNum) });
				}),
			);
		}
	}
	rows.push([cancelButton(questionIndex)]);
	return { inline_keyboard: rows };
}

/**
 * "Done" keyboard for an answered card: every button is removed. The
 * answerCallbackQuery toast ("已选择"/"已取消") is the confirmation; the message
 * itself stays clean without the option buttons.
 */
export function buildTgDoneKeyboard(): object {
	return { inline_keyboard: [] };
}

/** Escape text for Telegram HTML parse mode (labels may contain & < >). */
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Footer appended to the card text once the user answers: the chosen option
 * label (or 已取消), so the card keeps a persistent record of the selection
 * after the buttons are removed. Leading blank lines separate it from the body.
 */
export function buildTgAnswerNote(q: QuestionData, optionNum: number | undefined, isCancel: boolean): string {
	if (isCancel) return "\n\n已取消";
	const label =
		optionNum !== undefined && Number.isInteger(optionNum) ? q.options[optionNum - 1]?.label : undefined;
	return label === undefined ? "\n\n已选择" : `\n\n已选择：${escapeHtml(label)}`;
}
