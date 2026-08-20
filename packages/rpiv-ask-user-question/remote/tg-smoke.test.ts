import { describe, expect, it } from "vitest";
import { makeQuestion } from "../test-fixtures.js";
import type { RemoteConfig } from "./remote-config.js";
import { createTgTransport } from "./tg-channel.js";
import { runTgQuestionnaire } from "./tg-questionnaire.js";

/**
 * Manual e2e smoke for the ask-prd Telegram flow. SKIPPED unless TG_SMOKE=1.
 *
 * Run with real credentials from the environment (never hardcode a token):
 *
 *   TG_SMOKE=1 \
 *   TG_SMOKE_TOKEN=123456:AA-... \
 *   TG_SMOKE_CHAT=-1001234567890 \
 *   TG_SMOKE_USER=987654321 \
 *   TG_SMOKE_USERNAME=@alice \
 *   npx vitest run packages/rpiv-ask-user-question/remote/tg-smoke.test.ts
 *
 * The @-user must click an option button (or reply with text) in the chat
 * within the wait window for the test to pass.
 */
const enabled = process.env.TG_SMOKE === "1";
const token = process.env.TG_SMOKE_TOKEN ?? "";
const chatId = process.env.TG_SMOKE_CHAT ?? "";
const userId = Number(process.env.TG_SMOKE_USER ?? 0);
const username = process.env.TG_SMOKE_USERNAME;

function cfg(): RemoteConfig {
	return {
		enabled: false,
		localTimeoutMs: undefined,
		timeoutMs: 600_000,
		cancelWords: ["取消", "cancel"],
		feishu: { appId: "", appSecret: "", receivers: [], useCards: true },
		tg: { botToken: token, chatId, userId, username, useCards: true, timeoutMs: 120_000, proxy: undefined },
	};
}

describe.runIf(enabled && token.length > 0 && chatId.length > 0 && userId > 0)("tg-smoke (ask-prd real bot)", () => {
	it("sends a question card to the chat and resolves the @-user's button click / text reply", async () => {
		const remote = cfg();
		const transport = createTgTransport(remote.tg, { log: (m) => console.log("[tg-smoke]", m) });
		try {
			const question = makeQuestion({
				header: "冒烟测试",
				question: "请点击下方选项按钮，或直接回复文本（1 或 2）",
				options: [
					{ label: "选项A", description: "第一个选项" },
					{ label: "选项B", description: "第二个选项" },
				],
			});
			const outcome = await runTgQuestionnaire(transport, [{ question, index: 0 }], remote, (message, level) =>
				console.log(`[tg-smoke:${level}]`, message),
			);
			console.log("[tg-smoke] outcome:", JSON.stringify(outcome));
			expect(outcome.kind).toBe("answered");
		} finally {
			await transport.close();
		}
	}, 130_000);
});
