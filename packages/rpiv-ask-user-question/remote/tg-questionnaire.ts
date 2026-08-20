import { t } from "../state/i18n-bridge.js";
import type { QuestionAnswer } from "../tool/types.js";
import { parseReply } from "./message-format.js";
import type { RemoteConfig } from "./remote-config.js";
import type { RemoteOutcome, RemoteQuestion } from "./remote-questionnaire.js";
import { classifyRemoteError, type TgTransport } from "./tg-channel.js";
import { buildTgKeyboard, buildTgQuestionMessage } from "./tg-message.js";

/**
 * Orchestrator for the `ask-prd` Telegram questionnaire: one message per
 * question to the configured chat (@-mentioning the target user), wait for the
 * @-user's reply on each, parse it into the shared `QuestionAnswer` shape.
 *
 * Mirrors `runRemoteQuestionnaire` (Feishu): accepts a subset of questions with
 * their ORIGINAL indices (the local-timeout fallback hands over only the still
 * unanswered ones), and every produced answer keeps its original `questionIndex`
 * so the envelope merge in ask-user-question.ts stays consistent.
 *
 * The wait uses the INDEPENDENT `cfg.tg.timeoutMs`, not the Feishu `timeoutMs`.
 */

const ERROR_TG_FAILED_PREFIX =
	"Error: the Telegram remote questionnaire failed — the user never saw the remaining questions. Do NOT treat this as a decline. Ask the remaining questions as plain chat text instead.";

export async function runTgQuestionnaire(
	transport: TgTransport,
	questions: readonly RemoteQuestion[],
	cfg: RemoteConfig,
	onNotify: (message: string, level: "info" | "error") => void,
): Promise<RemoteOutcome> {
	const answers: QuestionAnswer[] = [];

	for (const { question, index } of questions) {
		const text = buildTgQuestionMessage(question, cfg.tg);
		const keyboard = cfg.tg.useCards ? buildTgKeyboard(question, index) : undefined;
		try {
			if (keyboard) {
				try {
					await transport.sendCard(text, keyboard);
				} catch {
					// Card send failed (e.g. permission) — fall back to plain text.
					await transport.sendText(text);
				}
			} else {
				await transport.sendText(text);
			}
		} catch (err) {
			const { code, message } = classifyRemoteError(err);
			return {
				kind: "failed",
				message: `${ERROR_TG_FAILED_PREFIX} (send failed, code ${code} — ${message})`,
				partialAnswers: answers,
			};
		}
		onNotify(t("remote.tg_sent", `Question ${index + 1} sent to Telegram — the @-user can reply there`), "info");

		let reply: Awaited<ReturnType<TgTransport["waitForReply"]>>;
		try {
			reply = await transport.waitForReply(
				cfg.tg.timeoutMs,
				() => {
					onNotify(t("remote.please_text", "Please reply with text (stickers/images cannot answer)"), "info");
				},
				keyboard ? { question, index, cancelWord: cfg.cancelWords[0] ?? "取消" } : undefined,
			);
		} catch (err) {
			const { code, message } = classifyRemoteError(err);
			return {
				kind: "failed",
				message: `${ERROR_TG_FAILED_PREFIX} (wait failed, code ${code} — ${message})`,
				partialAnswers: answers,
			};
		}
		if (reply === null) {
			return { kind: "timed_out", partialAnswers: answers };
		}

		const parsed = parseReply(reply.text, question, index, cfg.cancelWords);
		if (parsed.kind === "cancel") {
			return { kind: "answered", result: { answers, cancelled: true } };
		}
		answers.push(parsed.answer);
	}

	return { kind: "answered", result: { answers, cancelled: false } };
}
