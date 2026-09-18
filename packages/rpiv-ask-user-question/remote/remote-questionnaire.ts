import { t } from "../state/i18n-bridge.js";
import type { QuestionAnswer, QuestionData, QuestionnaireResult } from "../tool/types.js";
import { classifyRemoteError, type RemoteTransport } from "./channel-transport.js";
import { buildQuestionCard, buildQuestionMessage, parseReply, tuiHandoffHint } from "./message-format.js";
import type { RemoteConfig } from "./remote-config.js";

/**
 * Orchestrator for the Feishu remote questionnaire: one message per question,
 * wait for a reply on each, parse it into the shared `QuestionAnswer` shape.
 *
 * Accepts a subset of questions with their ORIGINAL indices — the local
 * timeout fallback hands over only the questions still unanswered, and every
 * produced answer keeps its original `questionIndex` so the envelope merge in
 * `ask-user-question.ts` stays consistent.
 */

export interface RemoteQuestion {
	question: QuestionData;
	index: number;
}

export type RemoteOutcome =
	| { kind: "answered"; result: QuestionnaireResult }
	| { kind: "timed_out"; partialAnswers: QuestionAnswer[] }
	/**
	 * The user asked to finish in the terminal (the 「回到 TUI」 button or the
	 * reserved `tui` reply): nothing was answered for the pending question, the
	 * caller re-asks the still-unanswered ones in the local TUI/RPC ask.
	 */
	| { kind: "handoff"; partialAnswers: QuestionAnswer[] }
	| { kind: "failed"; message: string; partialAnswers: QuestionAnswer[] };

/**
 * Telegram (ask-prd) outcomes: the tg flow has no 「回到 TUI」 entry (the inline
 * keyboard cannot express it and ask-prd must be answered), so no handoff.
 */
export type TgOutcome = Exclude<RemoteOutcome, { kind: "handoff" }>;
const ERROR_REMOTE_FAILED_PREFIX =
	"Error: the Feishu remote questionnaire failed — the user never saw the remaining questions. Do NOT treat this as a decline. Ask the remaining questions as plain chat text instead.";

/**
 * Send every question to every configured receiver, waiting for the first
 * matching reply per question. Cancel words abort the questionnaire; a
 * per-question timeout reports `timed_out` with the answers collected so far
 * so the caller decides how to recover — the local flow asks the still
 * unanswered questions in the main conversation instead of treating a silent
 * user as a decline.
 */
export async function runRemoteQuestionnaire(
	transport: RemoteTransport,
	questions: readonly RemoteQuestion[],
	cfg: RemoteConfig,
	onNotify: (message: string, level: "info" | "error") => void,
): Promise<RemoteOutcome> {
	const answers: QuestionAnswer[] = [];

	for (const { question, index } of questions) {
		// The back-to-TUI keyword is advertised in the message text too, so a
		// text-only send (useCards false / card fallback) still offers the way back.
		const text = buildQuestionMessage(question, [tuiHandoffHint()]);
		const card = cfg.feishu.useCards ? buildQuestionCard(question, index) : undefined;
		// Cards sent for this question (one per receiver): a handoff triggered by a
		// text reply must lock every one of them, not just a clicked card.
		const cardMessageIds: string[] = [];
		for (const receiver of cfg.feishu.receivers) {
			try {
				if (card) {
					try {
						const messageId = await transport.sendCard(receiver, card);
						if (messageId) cardMessageIds.push(messageId);
					} catch {
						// Card send failed (e.g. permission) — fall back to plain text.
						await transport.send(receiver, text);
					}
				} else {
					await transport.send(receiver, text);
				}
			} catch (err) {
				const { code, message } = classifyRemoteError(err);
				return {
					kind: "failed",
					message: `${ERROR_REMOTE_FAILED_PREFIX} (send failed to ${receiver.type}:${receiver.value}, code ${code} — ${message})`,
					partialAnswers: answers,
				};
			}
		}
		onNotify(t("remote.sent", `Question ${index + 1} sent to Feishu — reply there to answer`), "info");

		const reply = await transport.waitForReply(
			cfg.timeoutMs,
			() => {
				onNotify(t("remote.please_text", "Please reply with text (stickers/images cannot answer)"), "info");
			},
			card ? { question, index, cancelWord: cfg.cancelWords[0] ?? "取消", cardMessageIds } : undefined,
		);
		if (reply === null) {
			return { kind: "timed_out", partialAnswers: answers };
		}
		//「回到 TUI」：nothing was answered for this question — hand the flow back
		// so the caller re-asks the remaining questions in the terminal.
		if (reply.tuiHandoff) {
			return { kind: "handoff", partialAnswers: answers };
		}

		const parsed = parseReply(reply.text, question, index, cfg.cancelWords);
		if (parsed.kind === "cancel") {
			return { kind: "answered", result: { answers, cancelled: true } };
		}
		answers.push(parsed.answer);
	}

	return { kind: "answered", result: { answers, cancelled: false } };
}
