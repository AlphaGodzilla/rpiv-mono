import { describe, expect, it } from "vitest";
import { makeQuestion } from "../test-fixtures.js";
import type { TgRemoteConfig } from "./remote-config.js";
import {
	buildTgAnswerNote,
	buildTgDoneKeyboard,
	buildTgKeyboard,
	buildTgQuestionMessage,
	type TgButtonValue,
} from "./tg-message.js";

function tgCfg(over: Partial<TgRemoteConfig> = {}): TgRemoteConfig {
	return {
		chatId: "c",
		userId: 42,
		username: undefined,
		useCards: true,
		timeoutMs: 1_800_000,
		...over,
	};
}

interface ParsedButton {
	text: string;
	value: TgButtonValue;
}

function parseKeyboard(keyboard: object): { rows: ParsedButton[][] } {
	const markup = keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
	return {
		rows: markup.inline_keyboard.map((row) =>
			row.map((btn) => ({ text: btn.text, value: JSON.parse(btn.callback_data) as TgButtonValue })),
		),
	};
}

describe("buildTgQuestionMessage", () => {
	it("prepends an HTML mention line above the question body", () => {
		const text = buildTgQuestionMessage(makeQuestion(), tgCfg());
		expect(text).toContain(`<a href="tg://user?id=42">@user(42)</a>`);
		expect(text).toContain("Pick one");
		expect(text).toContain("1. A — a");
		expect(text).toContain("2. B — b");
	});

	it("uses the configured username as the mention text", () => {
		const text = buildTgQuestionMessage(makeQuestion(), tgCfg({ username: "@alice" }));
		expect(text).toContain(`<a href="tg://user?id=42">@alice</a>`);
	});
});

describe("buildTgKeyboard", () => {
	it("single-select: one button per option (3 per row), no cancel button", () => {
		const q = makeQuestion({
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
				{ label: "C", description: "c" },
				{ label: "D", description: "d" },
			],
		});
		const { rows } = parseKeyboard(buildTgKeyboard(q, 1));
		expect(rows).toHaveLength(2); // [A,B,C] [D] — no cancel row
		expect(rows[0].map((b) => b.text)).toEqual(["A", "B", "C"]);
		expect(rows[0].map((b) => b.value)).toEqual([
			{ q: "1", o: "1", ackText: "已选择" },
			{ q: "1", o: "2", ackText: "已选择" },
			{ q: "1", o: "3", ackText: "已选择" },
		]);
		expect(rows[1].map((b) => b.text)).toEqual(["D"]);
		expect(rows[1][0].value).toEqual({ q: "1", o: "4", ackText: "已选择" });
	});

	it("multi-select: no buttons at all (text reply 1,2)", () => {
		const q = makeQuestion({ multiSelect: true });
		expect(buildTgKeyboard(q, 0)).toEqual({ inline_keyboard: [] });
	});
});

describe("buildTgDoneKeyboard", () => {
	it("removes every button after an answer", () => {
		expect(buildTgDoneKeyboard()).toEqual({ inline_keyboard: [] });
	});
});

describe("buildTgAnswerNote", () => {
	it("notes the chosen option label", () => {
		const q = makeQuestion({
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		});
		expect(buildTgAnswerNote(q, 2, false)).toBe("\n\n✅ 已选择：B");
	});

	it("notes a cancel", () => {
		const q = makeQuestion();
		expect(buildTgAnswerNote(q, undefined, true)).toBe("\n\n❌ 已取消");
	});

	it("escapes HTML characters in the option label", () => {
		const q = makeQuestion({ options: [{ label: "A & B <C>", description: "d" }] });
		expect(buildTgAnswerNote(q, 1, false)).toBe("\n\n✅ 已选择：A &amp; B &lt;C&gt;");
	});

	it("falls back to a bare note when the option index is invalid", () => {
		const q = makeQuestion({ options: [{ label: "A", description: "a" }] });
		expect(buildTgAnswerNote(q, 99, false)).toBe("\n\n✅ 已选择");
	});
});
