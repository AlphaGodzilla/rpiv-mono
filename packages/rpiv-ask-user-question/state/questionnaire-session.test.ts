import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { QuestionnaireSession } from "./questionnaire-session.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const CTRL_G = "\x07";
const CTRL_U = "\x15";
const SHIFT_ENTER = "\x1b\r";
const TAB = "\t";

const params: QuestionParams = {
	questions: [
		{
			question: "Which?",
			header: "Pick",
			options: [
				{ label: "A", description: "a" },
				{ label: "B", description: "b" },
			],
		},
	],
};

function itemsFor(value: QuestionParams): WrappingSelectItem[][] {
	return value.questions.map((question) => [
		...question.options.map((option) => ({
			kind: "option" as const,
			label: option.label,
			description: option.description,
		})),
		{ kind: "other" as const, label: "Type something." },
	]);
}

const keybindings = {
	matches(data: string, name: string): boolean {
		switch (name) {
			case "tui.select.up":
				return data === UP;
			case "tui.select.down":
				return data === DOWN;
			case "tui.select.confirm":
				return data === ENTER;
			case "tui.input.newLine":
				return data === SHIFT_ENTER;
			case "tui.editor.cursorUp":
				return data === UP;
			case "tui.editor.cursorDown":
				return data === DOWN;
			case "tui.select.cancel":
				return data === ESC;
			case "tui.editor.deleteToLineStart":
				return data === CTRL_U;
			case "app.editor.external":
				return data === CTRL_G;
			default:
				return false;
		}
	},
};

interface SessionTestOptions {
	params?: QuestionParams;
	itemsByTab?: WrappingSelectItem[][];
	editInput?: (value: string) => Promise<string | undefined>;
}

function makeSession(options: SessionTestOptions = {}) {
	const sessionParams = options.params ?? params;
	const done = vi.fn<(result: QuestionnaireResult) => void>();
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
		theme: makeTheme() as unknown as Theme,
		params: sessionParams,
		itemsByTab: options.itemsByTab ?? itemsFor(sessionParams),
		done,
		keybindings,
		editInput: options.editInput ?? (async () => undefined),
		collapseKey: "off",
	});
	return { session, done };
}

function focusCustomAnswer(session: QuestionnaireSession): void {
	session.dispatch(DOWN);
	session.dispatch(DOWN);
}

describe("QuestionnaireSession — custom-answer drafts", () => {
	it("preserves a draft while browsing options and restores it on return", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("draft answer");
		session.dispatch(UP);
		const browsingView = session.component.render(120).join("\n");
		expect(browsingView).toContain("draft answer");
		expect(browsingView).not.toContain("Type something.");
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [
				{
					questionIndex: 0,
					question: "Which?",
					kind: "custom",
					answer: "draft answer",
				},
			],
			cancelled: false,
		});
	});

	it("submits a multiline custom answer composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first line");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second line");
		const view = session.component.render(120).join("\n");
		expect(view).toContain("first line");
		expect(view).toContain("second line");
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first line\nsecond line" })],
			cancelled: false,
		});
	});

	it("uses vertical arrows within the draft and returns to row navigation at the boundary", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch("!");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "first!\nsecond" })],
			cancelled: false,
		});
	});

	it("clears the whole draft with Pi's Ctrl+U line-kill binding", () => {
		const { session, done } = makeSession();
		focusCustomAnswer(session);
		session.dispatch("discard me");
		session.dispatch(CTRL_U);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: null })],
			cancelled: false,
		});
	});

	it("replaces the inline draft with the external editor result", async () => {
		const editInput = vi.fn(async (value: string) => `${value} + edited`);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);
		await Promise.resolve();
		await Promise.resolve();
		expect(editInput).toHaveBeenCalledWith("draft");
		session.dispatch(ENTER);

		expect(done).toHaveBeenLastCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "draft + edited" })],
			cancelled: false,
		});
	});

	it("keeps input exclusive while the external editor is open", async () => {
		let resolveEditor!: (value: string | undefined) => void;
		const editInput = vi.fn(
			() =>
				new Promise<string | undefined>((resolve) => {
					resolveEditor = resolve;
				}),
		);
		const { session, done } = makeSession({ editInput });
		focusCustomAnswer(session);
		session.dispatch("draft");
		session.dispatch(CTRL_G);

		session.dispatch(UP);
		session.dispatch("late input");
		resolveEditor("edited");
		await Promise.resolve();
		await Promise.resolve();
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "custom", answer: "edited" })],
			cancelled: false,
		});
	});

	it("attaches multiline notes composed with Shift+Enter", () => {
		const { session, done } = makeSession();
		session.dispatch("n");
		session.dispatch("first note");
		session.dispatch(SHIFT_ENTER);
		session.dispatch("second note");
		session.dispatch(ENTER);
		session.dispatch(ENTER);

		expect(done).toHaveBeenCalledWith({
			answers: [expect.objectContaining({ kind: "option", notes: "first note\nsecond note" })],
			cancelled: false,
		});
	});

	it("keeps each question's latest draft isolated through real navigation and tab switches", () => {
		const multiParams: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session } = makeSession({ params: multiParams });

		focusCustomAnswer(session);
		session.dispatch("first");
		session.dispatch(UP);
		session.dispatch(DOWN);
		session.dispatch("-latest");
		session.dispatch(ENTER);

		focusCustomAnswer(session);
		session.dispatch("second");
		session.dispatch(UP);
		session.dispatch(TAB);
		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("first-latest");

		session.dispatch(TAB);
		expect(session.component.render(120).join("\n")).toContain("second");
	});
});

describe("QuestionnaireSession — extractPartialAnswersAndClose", () => {
	it("extracts nothing when no question was answered and closes without cancellation", () => {
		const { session, done } = makeSession();
		const result = session.extractPartialAnswersAndClose();
		expect(result).toEqual({ answers: [], cancelled: false });
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("extracts only the answered questions with original indices", () => {
		const multiParams: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session, done } = makeSession({ params: multiParams });

		// Answer Q1 (auto-advances to Q2), leave Q2 unanswered.
		focusCustomAnswer(session);
		session.dispatch("first answer");
		session.dispatch(ENTER);

		const result = session.extractPartialAnswersAndClose();
		expect(result.cancelled).toBe(false);
		expect(result.answers).toEqual([
			{ questionIndex: 0, question: "First?", kind: "custom", answer: "first answer" },
		]);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("extracts every answer when all questions are answered", () => {
		const multiParams: QuestionParams = {
			questions: [
				{ ...params.questions[0]!, question: "First?", header: "First" },
				{ ...params.questions[0]!, question: "Second?", header: "Second" },
			],
		};
		const { session, done } = makeSession({ params: multiParams });

		// Answering Q1 auto-advances to Q2 (autoAdvanceTab in multi mode), so no TAB here.
		focusCustomAnswer(session);
		session.dispatch("first answer");
		session.dispatch(ENTER);
		focusCustomAnswer(session);
		session.dispatch("second answer");
		session.dispatch(ENTER);

		const result = session.extractPartialAnswersAndClose();
		expect(result.answers).toEqual([
			{ questionIndex: 0, question: "First?", kind: "custom", answer: "first answer" },
			{ questionIndex: 1, question: "Second?", kind: "custom", answer: "second answer" },
		]);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("is idempotent against a racing user submit: done fires exactly once", () => {
		const { session, done } = makeSession();
		// Answer the single question the normal way — this closes the dialog.
		focusCustomAnswer(session);
		session.dispatch("answer");
		session.dispatch(ENTER);
		expect(done).toHaveBeenCalledTimes(1);

		// A late handoff must not double-resolve the host dialog.
		const result = session.extractPartialAnswersAndClose();
		expect(result.answers).toHaveLength(1);
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("extracts an option answer with its preview", () => {
		const { session, done } = makeSession({
			params: {
				questions: [
					{
						question: "Layout?",
						header: "Layout",
						options: [
							{ label: "Centered", description: "c", preview: "## Mock" },
							{ label: "Left", description: "l" },
						],
					},
				],
			},
		});
		session.dispatch(DOWN);
		session.dispatch(ENTER);

		const result = session.extractPartialAnswersAndClose();
		expect(result.answers).toEqual([
			{
				questionIndex: 0,
				question: "Layout?",
				kind: "option",
				answer: "Left",
			},
		]);
		expect(done).toHaveBeenCalledTimes(1);
	});
});
