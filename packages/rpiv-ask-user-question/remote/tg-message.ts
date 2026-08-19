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
 * Locked keyboard for an answered card: a single ✓/已取消 button with a `d`
 * marker. Telegram has no disabled buttons — after the reply resolves the
 * transport unsubscribes, so this button is purely visual and inert.
 */
export function buildTgLockedKeyboard(
	q: QuestionData,
	questionIndex: number,
	selectedIndex: number | undefined,
	cancelled: boolean,
): object {
	const label = cancelled
		? "已取消"
		: selectedIndex !== undefined
			? `✓ ${q.options[selectedIndex]?.label ?? ""}`
			: "已选择";
	const row = [button(label, { q: String(questionIndex), d: "1" })];
	return { inline_keyboard: [row] };
}
