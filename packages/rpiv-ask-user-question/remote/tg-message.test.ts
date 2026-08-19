import { describe, expect, it } from "vitest";
import { makeQuestion } from "../test-fixtures.js";
import type { TgRemoteConfig } from "./remote-config.js";
import { buildTgKeyboard, buildTgLockedKeyboard, buildTgQuestionMessage, type TgButtonValue } from "./tg-message.js";

function tgCfg(over: Partial<TgRemoteConfig> = {}): TgRemoteConfig {
	return {
		botToken: "t",
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
	it("single-select: one button per option (3 per row) plus a trailing cancel row", () => {
		const q = makeQuestion({
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
				{ label: "C", description: "c" },
				{ label: "D", description: "d" },
			],
		});
		const { rows } = parseKeyboard(buildTgKeyboard(q, 1));
		expect(rows).toHaveLength(3); // [A,B,C] [D] [取消]
		expect(rows[0].map((b) => b.text)).toEqual(["A", "B", "C"]);
		expect(rows[0].map((b) => b.value)).toEqual([
			{ q: "1", o: "1" },
			{ q: "1", o: "2" },
			{ q: "1", o: "3" },
		]);
		expect(rows[1].map((b) => b.text)).toEqual(["D"]);
		expect(rows[1][0].value).toEqual({ q: "1", o: "4" });
		expect(rows[2].map((b) => b.text)).toEqual(["取消"]);
		expect(rows[2][0].value).toEqual({ q: "1", c: "1" });
	});

	it("multi-select: no option buttons, only a cancel button", () => {
		const q = makeQuestion({ multiSelect: true });
		const { rows } = parseKeyboard(buildTgKeyboard(q, 0));
		expect(rows).toHaveLength(1);
		expect(rows[0].map((b) => b.text)).toEqual(["取消"]);
	});
});

describe("buildTgLockedKeyboard", () => {
	it("marks the chosen option with a checkmark and keeps only it", () => {
		const q = makeQuestion({
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		});
		const { rows } = parseKeyboard(buildTgLockedKeyboard(q, 0, 1, false)); // selected option index 1 ("B")
		expect(rows).toHaveLength(1);
		expect(rows[0][0].text).toBe("✓ B");
		expect(rows[0][0].value).toEqual({ q: "0", d: "1" });
	});

	it("cancelled keyboard shows 已取消 and is inert", () => {
		const q = makeQuestion();
		const { rows } = parseKeyboard(buildTgLockedKeyboard(q, 0, undefined, true));
		expect(rows).toHaveLength(1);
		expect(rows[0][0].text).toBe("已取消");
		expect(rows[0][0].value).toEqual({ q: "0", d: "1" });
	});
});
