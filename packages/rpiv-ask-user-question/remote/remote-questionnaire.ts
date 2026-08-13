import { t } from "../state/i18n-bridge.js";
import type { QuestionAnswer, QuestionData, QuestionnaireResult } from "../tool/types.js";
import { classifyRemoteError, type RemoteTransport } from "./feishu-channel.js";
import { buildQuestionCard, buildQuestionMessage, parseReply } from "./message-format.js";
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
	| { kind: "failed"; message: string; partialAnswers: QuestionAnswer[] };

const ERROR_REMOTE_FAILED_PREFIX =
	"Error: the Feishu remote questionnaire failed — the user never saw the remaining questions. Do NOT treat this as a decline. Ask the remaining questions as plain chat text instead.";

/**
 * Send every question to every configured receiver, waiting for the first
 * matching reply per question. Cancel words abort; a per-question timeout
 * cancels the whole questionnaire (a user who does not answer is unlikely to
 * answer later questions either).
 */
export async function runRemoteQuestionnaire(
	transport: RemoteTransport,
	questions: readonly RemoteQuestion[],
	cfg: RemoteConfig,
	onNotify: (message: string, level: "info" | "error") => void,
): Promise<RemoteOutcome> {
	const answers: QuestionAnswer[] = [];

	for (const { question, index } of questions) {
		const text = buildQuestionMessage(question);
		const card = cfg.feishu.useCards ? buildQuestionCard(question, index) : undefined;
		for (const receiver of cfg.feishu.receivers) {
			try {
				if (card) {
					try {
						await transport.sendCard(receiver, card);
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
			card ? { question, index, cancelWord: cfg.cancelWords[0] ?? "取消" } : undefined,
		);
		if (reply === null) {
			return {
				kind: "answered",
				result: { answers, cancelled: true },
			};
		}

		const parsed = parseReply(reply.text, question, index, cfg.cancelWords);
		if (parsed.kind === "cancel") {
			return { kind: "answered", result: { answers, cancelled: true } };
		}
		answers.push(parsed.answer);
	}

	return { kind: "answered", result: { answers, cancelled: false } };
}
