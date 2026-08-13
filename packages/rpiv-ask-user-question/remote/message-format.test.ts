import { describe, expect, it } from "vitest";
import type { QuestionData } from "../tool/types.js";
import {
	buildQuestionCard,
	buildQuestionMessage,
	isCancelWord,
	MAX_REMOTE_PREVIEW_CHARS,
	parseReply,
} from "./message-format.js";

function makeQuestion(over: Partial<QuestionData> = {}): QuestionData {
	return {
		question: over.question ?? "Pick one",
		header: over.header ?? "Pick",
		options: over.options ?? [
			{ label: "A", description: "a-desc" },
			{ label: "B", description: "b-desc" },
		],
		multiSelect: over.multiSelect,
	};
}

const CANCEL = ["取消", "cancel"];

describe("buildQuestionMessage", () => {
	it("formats header, question, numbered options and the single-select hint", () => {
		const msg = buildQuestionMessage(makeQuestion());
		expect(msg).toContain("[Pick] Pick one");
		expect(msg).toContain("1. A — a-desc");
		expect(msg).toContain("2. B — b-desc");
		expect(msg).toContain("Reply with the option number");
		expect(msg).toContain('"取消" or "cancel" to abort');
	});

	it("uses the multi-select hint for multiSelect questions", () => {
		const msg = buildQuestionMessage(makeQuestion({ multiSelect: true }));
		expect(msg).toContain('comma-separated (e.g. "1,3")');
		expect(msg).not.toContain("Reply with the option number");
	});

	it("omits the header bracket when header is empty", () => {
		const msg = buildQuestionMessage(makeQuestion({ header: "" }));
		expect(msg).toContain("Pick one");
		expect(msg).not.toContain("[");
	});

	it("folds an option preview into the message", () => {
		const msg = buildQuestionMessage(
			makeQuestion({
				options: [
					{ label: "A", description: "a", preview: "## Centered\n\nbody" },
					{ label: "B", description: "b" },
				],
			}),
		);
		expect(msg).toContain("--- 1. preview ---");
		expect(msg).toContain("## Centered\n\nbody");
	});

	it("truncates previews beyond the remote preview cap", () => {
		const long = "x".repeat(MAX_REMOTE_PREVIEW_CHARS + 200);
		const msg = buildQuestionMessage(
			makeQuestion({
				options: [{ label: "A", description: "a", preview: long }],
			}),
		);
		expect(msg).toContain("x".repeat(MAX_REMOTE_PREVIEW_CHARS));
		expect(msg).not.toContain("x".repeat(MAX_REMOTE_PREVIEW_CHARS + 1));
	});
});

describe("isCancelWord", () => {
	it("matches a configured word exactly after trimming", () => {
		expect(isCancelWord("取消", CANCEL)).toBe(true);
		expect(isCancelWord("  cancel  ", CANCEL)).toBe(true);
	});

	it("matches case-insensitively for latin words", () => {
		expect(isCancelWord("Cancel", CANCEL)).toBe(true);
		expect(isCancelWord("CANCEL", CANCEL)).toBe(true);
	});

	it("does not match non-cancel text or partial words", () => {
		expect(isCancelWord("取消问卷", CANCEL)).toBe(false);
		expect(isCancelWord("cancelled", CANCEL)).toBe(false);
		expect(isCancelWord("1", CANCEL)).toBe(false);
	});
});

describe("parseReply — single select", () => {
	const q = makeQuestion();

	it("maps an option number to its label", () => {
		const parsed = parseReply("2", q, 0, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: { questionIndex: 0, question: "Pick one", kind: "option", answer: "B" },
		});
	});

	it("parses a leading-digit token like '2. B — b-desc'", () => {
		const parsed = parseReply("2. B — b-desc", q, 1, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: { questionIndex: 1, question: "Pick one", kind: "option", answer: "B" },
		});
	});

	it("attaches the option preview when the chosen option carries one", () => {
		const withPreview = makeQuestion({
			options: [
				{ label: "A", description: "a", preview: "## Mock" },
				{ label: "B", description: "b" },
			],
		});
		const parsed = parseReply("1", withPreview, 2, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: {
				questionIndex: 2,
				question: "Pick one",
				kind: "option",
				answer: "A",
				preview: "## Mock",
			},
		});
	});

	it("treats out-of-range numbers as a custom answer", () => {
		const parsed = parseReply("9", q, 0, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: { questionIndex: 0, question: "Pick one", kind: "custom", answer: "9" },
		});
	});

	it("treats any other text as a custom answer", () => {
		const parsed = parseReply("我选 A 吧", q, 0, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: { questionIndex: 0, question: "Pick one", kind: "custom", answer: "我选 A 吧" },
		});
	});
});

describe("parseReply — multi select", () => {
	const q = makeQuestion({
		multiSelect: true,
		options: [
			{ label: "FE", description: "Frontend" },
			{ label: "BE", description: "Backend" },
			{ label: "Tests", description: "Tests" },
		],
	});

	it("maps a comma-separated list to selected labels", () => {
		const parsed = parseReply("1,3", q, 0, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: {
				questionIndex: 0,
				question: "Pick one",
				kind: "multi",
				answer: null,
				selected: ["FE", "Tests"],
			},
		});
	});

	it("accepts space-separated tokens and de-duplicates labels", () => {
		const parsed = parseReply("2 1 2", q, 1, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: {
				questionIndex: 1,
				question: "Pick one",
				kind: "multi",
				answer: null,
				selected: ["BE", "FE"],
			},
		});
	});

	it("treats an out-of-range token as a custom answer", () => {
		const parsed = parseReply("1,13", q, 0, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: { questionIndex: 0, question: "Pick one", kind: "custom", answer: "1,13" },
		});
	});

	it("treats non-numeric text as a custom answer", () => {
		const parsed = parseReply("都要", q, 0, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: { questionIndex: 0, question: "Pick one", kind: "custom", answer: "都要" },
		});
	});

	it("keeps an empty reply as an empty custom answer", () => {
		const parsed = parseReply("   ", q, 0, CANCEL);
		expect(parsed).toEqual({
			kind: "answer",
			answer: { questionIndex: 0, question: "Pick one", kind: "custom", answer: "" },
		});
	});
});

describe("parseReply — cancel", () => {
	it("returns the cancel signal for a configured cancel word", () => {
		expect(parseReply("取消", makeQuestion(), 0, CANCEL)).toEqual({ kind: "cancel" });
		expect(parseReply("cancel", makeQuestion({ multiSelect: true }), 3, CANCEL)).toEqual({ kind: "cancel" });
	});

	it("uses custom cancel words from config", () => {
		expect(parseReply("stop", makeQuestion(), 0, ["stop"])).toEqual({ kind: "cancel" });
		expect(parseReply("取消", makeQuestion(), 0, ["stop"])).not.toEqual({ kind: "cancel" });
	});
});

describe("buildQuestionCard", () => {
	it("builds a V2 card with one button per option plus a cancel button", () => {
		const card = buildQuestionCard(makeQuestion(), 0) as {
			schema: string;
			body: {
				elements: {
					tag: string;
					columns?: { elements: { tag: string; text: { content: string }; behaviors?: { value: unknown }[] }[] }[];
				}[];
			};
		};
		expect(card.schema).toBe("2.0");
		const buttons = card.body.elements
			.filter((e) => e.tag === "column_set")
			.flatMap((e) => e.columns?.map((c) => c.elements[0]) ?? []);
		expect(buttons.map((b) => b.text.content)).toEqual(["A", "B", "取消"]);
		const values = buttons.map((b) => b.behaviors?.[0]?.value);
		expect(values[0]).toEqual({ q: "0", o: "1" });
		expect(values[2]).toEqual({ q: "0", c: "1" });
	});

	it("marks the chosen button with a checkmark and disables every other button when answered", () => {
		const card = buildQuestionCard(makeQuestion(), 1, 1) as {
			body: {
				elements: {
					tag: string;
					columns?: { elements: { tag: string; text: { content: string }; disabled?: boolean }[] }[];
				}[];
			};
		};
		const buttons = card.body.elements
			.filter((e) => e.tag === "column_set")
			.flatMap((e) => e.columns?.map((c) => c.elements[0]) ?? []);
		expect(buttons[0].text.content).toBe("A");
		expect(buttons[0].disabled).toBe(true);
		expect(buttons[1].text.content).toBe("✓ B");
		expect(buttons[1].disabled).toBeUndefined();
		expect(buttons[2].text.content).toBe("取消");
		expect(buttons[2].disabled).toBe(true);
	});

	it("disables all buttons and appends a cancelled notice when cancelled", () => {
		const card = buildQuestionCard(makeQuestion(), 0, undefined, true) as {
			body: {
				elements: {
					tag: string;
					content?: string;
					columns?: { elements: { tag: string; disabled?: boolean; text: { content: string } }[] }[];
				}[];
			};
		};
		const buttons = card.body.elements
			.filter((e) => e.tag === "column_set")
			.flatMap((e) => e.columns?.map((c) => c.elements[0]) ?? []);
		expect(buttons.every((b) => b.disabled === true)).toBe(true);
		expect(buttons[buttons.length - 1].text.content).toBe("已取消");
		const markdown = card.body.elements.find((e) => e.tag === "markdown") as { content: string };
		expect(markdown.content).toContain("已取消");
	});

	it("multi-select cards carry only a cancel button", () => {
		const card = buildQuestionCard(makeQuestion({ multiSelect: true }), 2) as {
			body: { elements: { tag: string; columns?: { elements: { tag: string }[] }[] }[] };
		};
		const buttons = card.body.elements
			.filter((e) => e.tag === "column_set")
			.flatMap((e) => e.columns?.map((c) => c.elements[0]) ?? []);
		expect(buttons).toHaveLength(1);
		expect(buttons[0].tag).toBe("button");
	});
});
