# Spec: ask-prd — tgbot 远程问答模式（rpiv-ask-user-question）

> 项目：`rpiv-mono` monorepo，包 `@juicesharp/rpiv-ask-user-question` v2.4.0，分支 `base-v2.4.0`
> 状态：**已批准的能力地图 + 模块 spec（Phase 0/1 完成，待用户确认后进入 Phase 2 Plan）**
> 2026-08 制定

## 0. 背景与范围

当前插件已支持**飞书远程问答**（`remote.enabled` 远程主模式 + `localTimeoutMs` 本地超时兜底到飞书），见 `docs/memory/rpiv-ask-user-question-feishu-remote.md`。

本次改造新增一个 **session 级模式 `ask-prd`**：开启后，`ask_user_question` 的所有问题改由 **Telegram bot** 发送到指定 chat 并 **@ 一个指定的用户**；该模式下**飞书的所有逻辑（远程主模式 + 本地超时兜底）全部被跳过**，由 tgbot 逻辑拦截。消息以**可交互卡片**（Telegram Inline Keyboard 按钮）发送，交互语义对齐飞书卡片；问题**超时时间独立于飞书且可配置**；被 @ 用户的回复才是有效作答。

**关键澄清（用户已确认）**
- 被 @ 的用户：**仅该用户的回复/按钮点击算作答**，chat 内其他人一律忽略；被 @ 者不回复则持续等待至超时。
- `ask-prd` 作用域：**仅当前 session 生效**，不落盘，新会话自动关闭。
- tg 接收方式：**Bot API `getUpdates` 长轮询**（无公网端口）。
- 超时后行为：**回落到本地主对话提问**（与飞书一致，错误包络语义不变）。
- 命令形态（追加确认）：旧 `/remote-ask` 与新 `prd` 合并为**单一命令 `/rpiv-ask-user-question` 的子命令**（`remote` / `prd`），**彻底移除 `/remote-ask`**（无别名）；无参时打印用法 + 双渠道综合状态。

---

## 1. Objective

**我们在构建什么，为什么**

为 `rpiv-ask-user-question` 增加一个 session 级的 `ask-prd` 模式，让问卷通过 Telegram 触达一个指定的被 @ 用户（通常是「产品评审人 / PRD 审阅者」），即便该用户不在终端前、不会短时间回复，也能在**更长且独立可配的超时**内作答。开启后 tgbot 完全接管，飞书渠道被拦截跳过。

**目标用户**
- 使用 pi 的工程师本人（在本机终端运行 pi，配置 tg 凭证与目标用户）。
- 被 @ 的指定 Telegram 用户（评审人，通过聊天/按钮作答）。

**成功标准（用户视角）**
- 会话内执行 `/rpiv-ask-user-question prd on` 后，下一个 `ask_user_question` 的每个问题都出现在指定 Telegram chat 中并 @ 指定用户，且带可点击的选项/取消按钮。
- 只有被 @ 用户能作答；其他人发言/点击被忽略。
- 开启 `ask-prd` 时，**飞书渠道不再收到任何消息**（无论 `remote.enabled` 与 `localTimeoutMs` 如何配置）。
- tg 超时时间独立配置（`remote.tg.timeoutMs`），默认显著长于飞书。
- tg 超时无回复 → 未答问题在主对话本地重新提问（与飞书超时一致）。
- 新会话/重启后 `ask-prd` 自动关闭（session 级，不持久化）。

---

## 2. Capability Map（已批准）

| Module id | 职责 | Depends on |
|---|---|---|
| `ask-prd-state` | session 级 `/ask-prd` 开关状态（内存、按 sessionId 键控、`session_start` 复位） | — |
| `tg-config` | `remote.tg.*` 配置解析/守卫（botToken/chatId/userId/独立 timeoutMs）、`isTgConfigured` | — |
| `tg-message` | TG 文本 + Inline Keyboard 卡片构建（@提及、选项/取消按钮），复用 `parseReply`/`isCancelWord` | — |
| `tg-channel` | TG Bot API 传输：getUpdates 长轮询、sendMessage/answerCallbackQuery/editMessage、仅被@者(`from.id`)作答过滤 | tg-config, tg-message |
| `tg-questionnaire` | 逐题发送+等待+解析编排，独立超时，超时返回部分答案（复用 `RemoteOutcome`/`parseReply`） | tg-channel |
| `rpiv-command` | 统一命令 `/rpiv-ask-user-question`：子命令 `remote on\|off\|status`（飞书 toggle，落盘，取代旧 `/remote-ask`）与 `prd on\|off\|status`（session 级 tg）；无参打印用法+综合状态 | ask-prd-state, tg-config |
| `orchestration` | `ask-user-question.ts` 路由：ask-prd 拦截并**跳过全部飞书逻辑**，tg 超时回落本地 | ask-prd-state, tg-config, tg-questionnaire |

**依赖方向（无环）**：`ask-prd-state`, `tg-config` → `tg-message` → `tg-channel` → `tg-questionnaire` → `rpiv-command` → `orchestration`

> **地图修订（用户追加需求 2026-08）**：`ask-prd-command` 与旧 `remote-command`（`/remote-ask`）合并为 `rpiv-command`（统一命令 `/rpiv-ask-user-question` 子命令 `remote`/`prd`）；`/remote-ask` 彻底移除。

**构建顺序**：按依赖方向依次实现与验证（见 §6 各模块 spec）。

---

## 3. Tech Stack

- 运行时：Node ≥ 22（`rpiv-mono` engines），TypeScript strict，ES2022 target，Node16 module resolution。
- 测试：vitest 4（`npx vitest run`），覆盖率阈值 stat 94 / branch 87 / func 93 / line 95。
- Lint/格式：biome 2.5.5（tab 缩进、lineWidth 120，preset recommended）。
- 依赖：**零新增依赖** —— Telegram Bot API 调用用 Node 22 全局 `fetch`（已通过类型检查验证）。不引入 telegraf / node-telegram-bot-api / axios。
- 复用：飞书侧 `parseReply`、`isCancelWord`、`RemoteOutcome`、`RemoteQuestion`、`recoverFromRemoteTimeout`、`RemoteTransport` 的 `classifyRemoteError` 语义。
- 配置：沿用 `@juicesharp/rpiv-config` 的 `loadJsonConfigWithLegacyFallback` + 手工守卫（malformed → defaults，绝不 throw），凭证全走 config.json，**不新增环境变量**。

---

## 4. Commands

```bash
# 包内单测（本功能开发循环）
cd ~/.pi/agent/rpiv-mono
npx vitest run packages/rpiv-ask-user-question

# 全仓单测（含其它包，基线 661 通过）
npm test

# 类型 + lint（biome --write + tsc --noEmit）
npm run check

# 覆盖率（阈值见上）
npm run coverage

# pi 内验证（需 /reload 加载本地薄壳 extensions/rpiv-ask-user-question）
# 交互界面执行：
/reload
/rpiv-ask-user-question                   # 无参：用法说明 + 双渠道综合状态
/rpiv-ask-user-question status            # 综合状态
/rpiv-ask-user-question remote on          # 飞书远程主模式（落盘，原 /remote-ask 语义）
/rpiv-ask-user-question remote off
/rpiv-ask-user-question remote status
/rpiv-ask-user-question prd on             # 开启 ask-prd（仅当前 session）
/rpiv-ask-user-question prd off
/rpiv-ask-user-question prd status         # 查看 tg 凭证完整性与当前 session 开关状态
```

---

## 5. Project Structure

新文件（全部位于 `rpiv-mono/packages/rpiv-ask-user-question/`，镜像飞书 `remote/` 布局）：

```
remote/
├── remote-config.ts        # (改) RemoteConfig 增加 tg 段 + TgRemoteConfig 解析/守卫
├── remote-config.test.ts   # (改) tg 解析用例
├── ask-prd-state.ts        # (新) session 级 ask-prd 开关状态
├── ask-prd-state.test.ts   # (新)
├── tg-message.ts           # (新) TG 文本 + Inline Keyboard 构建
├── tg-message.test.ts      # (新)
├── tg-channel.ts           # (新) TG 传输（getUpdates 长轮询）
├── tg-channel.test.ts      # (新) 纯逻辑 + mock fetch
├── tg-questionnaire.ts     # (新) TG 问卷编排（复用 RemoteOutcome/parseReply）
├── tg-questionnaire.test.ts# (新)
├── rpiv-command.ts          # (新) 统一命令 /rpiv-ask-user-question（子命令 remote/prd/status）
├── rpiv-command.test.ts     # (新)
├── remote-command.ts        # (删) /remote-ask 移除，逻辑迁入 rpiv-command.ts
└── remote-command.test.ts   # (删) 用例迁入 rpiv-command.test.ts
ask-user-question.ts        # (改) orchestration 路由（§6.7）
ask-user-question.test.ts   # (改) 路由级用例（mock transport）
locales/en.json, zh.json    # (改) tg 文案键（remote.tg_*）
docs/configuration.md       # (改) remote.tg 配置说明
package.json                # (改) files 数组追加新模块（发布白名单）
index.ts                    # (改) 注册 rpiv-command（移除 registerRemoteCommand 调用）
```

> 发布白名单：本包 `package.json#files` 逐文件列出，新增模块必须加入，否则发布后缺失。

---

## 6. Per-Module Specs（按依赖顺序）

### 6.1 `ask-prd-state` — session 级开关状态

**Objective**：管理 `ask-prd` 的开启状态，作用域严格限定在当前 session；不落盘、不写 config.json。

**接口**（`remote/ask-prd-state.ts`）：

```ts
export function resetAskPrdState(): void;                 // session_start 复位（含切换会话）
export function setAskPrdEnabled(sessionId: string, enabled: boolean): void;
export function isAskPrdActive(sessionId: string | undefined): boolean; // sessionId 不匹配 → false
```

**行为**：
- 模块级单例 `{ sessionId: string | null; enabled: boolean }`，初始 `{ null, false }`。
- `setAskPrdEnabled` 记录 sessionId + enabled。
- `isAskPrdActive(sid)` 仅在 `enabled && sid !== undefined && sid === state.sessionId` 时为 true —— 新 session id 天然自动关闭。
- 在扩展工厂（`index.ts`）订阅 `pi.on("session_start", ...)` 调用 `resetAskPrdState()`，保证新会话/恢复会话彻底复位（防御性，双保险）。

**Success Criteria**：
- 同一 session 内 `on → isAskPrdActive(sid) === true`，`off → false`。
- 不同 sessionId 调用 `isAskPrdActive` 永远 false。
- `session_start` 后状态复位。

### 6.2 `tg-config` — remote.tg 配置解析与守卫

**Objective**：解析 `remote.tg` 段，malformed/mistyped 一律回落默认值（fail-soft，同飞书契约）。

**配置形状**（`~/.config/rpiv-ask-user-question/config.json`）：

```jsonc
{
  "remote": {
    "tg": {
      "botToken": "123456:AA-…",   // 必填，Telegram bot token
      "chatId": "-1001234567890",  // 必填，目标 chat（群/超级群为负值，字符串类型）
      "userId": 987654321,         // 必填，被 @ 的用户数字 id（回复判定 from.id 与之匹配）
      "username": "@alice",        // 可选，公开 username，用于可见的 @ 提及文案
      "useCards": true,            // 可选，Inline Keyboard 按钮卡片，默认 true
      "timeoutMs": 1800000         // 可选，tg 每问超时，默认 30 分钟，与飞书 remote.timeoutMs 独立
    }
  }
}
```

**接口**（`remote/remote-config.ts` 扩展）：

```ts
export interface TgRemoteConfig {
  botToken: string;
  chatId: string;
  userId: number;
  username: string | undefined;
  useCards: boolean;
  timeoutMs: number;
}
export const DEFAULT_TG_TIMEOUT_MS = 1_800_000; // 30 min —— 远长于飞书 10 min
export function isTgConfigured(cfg: RemoteConfig): boolean; // botToken/chatId 非空 且 userId > 0
```

`loadRemoteConfig` 增加 `tg` 分支：`botToken`/`chatId` 非空字符串、`userId` 正整数、`useCards` 布尔、`timeoutMs` 正有限数（默认 1_800_000）。

**Success Criteria**：
- 合法配置 → 全部字段正确解析；缺字段/错类型 → 回默认（不 throw）。
- `isTgConfigured` 三条件独立（botToken、chatId、userId>0）。
- tg 配置不影响飞书 `shouldUseRemote` 判定（互不干扰）。

### 6.3 `tg-message` — TG 文本与 Inline Keyboard 卡片

**Objective**：纯函数构建 TG 消息文本（含 @提及）与 Inline Keyboard；解析复用飞书 `parseReply`/`isCancelWord`。

**接口**（`remote/tg-message.ts`）：

```ts
export interface TgButtonValue { q: string; o?: string; c?: string } // 同飞书 CardButtonValue（≤64B callback_data）
export function buildTgQuestionMessage(q: QuestionData, cfg: TgRemoteConfig): string;
  // 头部行 @提及 + 问题 + 编号选项（折叠 preview，同 MAX_REMOTE_PREVIEW_CHARS）+ 回复提示
export function buildTgKeyboard(q: QuestionData, questionIndex: number): object; // InlineKeyboardMarkup
export function buildTgLockedKeyboard(q: QuestionData, questionIndex: number, selectedIndex: number | undefined, cancelled: boolean): object;
  // 作答后锁定：✓ 高亮 + 其余禁用（TG 用禁用态 text，如 "✓ 选项" / "已取消"，避免误点）
```

**@提及格式**（统一 `parse_mode: "HTML"`）：
- `username` 已配置 → `<a href="tg://user?id={userId}">{username}</a>`
- 否则 → `<a href="tg://user?id={userId}">@user({userId})</a>`

**卡片语义（对齐飞书 §feishu-channel / message-format，ask-prd 不允许取消）**：
- 单选：每个选项一个 inline 按钮（callback_data `{q,o}`），**无取消按钮**；最多 3 个一行。
- 多选：按钮无法表达选择列表 → 消息带选项文本 + **无按钮**，用户文本回复 `1,2`（复用 `parseReply` 多选逻辑）。
- 取消词（文本回复）与旧卡取消回调（`{q,c:"1"}`）一律忽略、继续等待——ask-prd 必须作答，超时才回落本地。
- 作答后：`buildTgDoneKeyboard` 移除全部按钮 + `editMessageText` 末尾追加 `✅ 已选择：<选项>`，防重复点击。

**Success Criteria**：
- `buildTgQuestionMessage` 输出含合法 HTML @提及与完整选项文本。
- 单选/多选/取消三种 keyboard 结构正确，callback_data 与飞书一致（`q`=题号防旧卡误触）。
- 纯函数、无副作用，可直接单测。

### 6.4 `tg-channel` — TG Bot API 传输（getUpdates 长轮询）

**Objective**：封装 Telegram Bot API 传输：发送文本/卡片、长轮询接收、仅被@者作答过滤、点击后锁定卡片；对外暴露与飞书 `RemoteTransport` 同构的 `TgTransport` 接缝（单测 mock 点）。

**接口**（`remote/tg-channel.ts`）：

```ts
export interface TgSentMessage { chatId: number; messageId: number }
export interface TgReply { text: string; chatId: number; messageId: number }
export interface TgCardContext { question: QuestionData; index: number; cancelWord: string }

export interface TgTransport {
  sendText(text: string): Promise<TgSentMessage>;            // sendMessage
  sendCard(text: string, keyboard: object): Promise<TgSentMessage>; // sendMessage + reply_markup
  waitForReply(timeoutMs: number, onNonText?: () => void, card?: TgCardContext): Promise<TgReply | null>;
  close(): Promise<void>;
}
export function createTgTransport(cfg: TgRemoteConfig, log: (msg: string) => void): TgTransport;
```

**传输细节**：
- HTTP：Node 22 全局 `fetch` → `https://api.telegram.org/bot<TOKEN>/<method>`，零依赖。
- **getUpdates 长轮询**：`getUpdates?timeout=50&offset=<next>&allowed_updates=["message","callback_query"]`；`offset = 最后处理 update_id + 1`；仅在 `waitForReply` 活跃期间启动轮询循环，`close()` 停止。
- **发送**：`sendMessage`（`parse_mode:"HTML"` + 可选 `reply_markup`）。
- **作答过滤（仅被@者）**：
  - `message`：仅 `from.id === cfg.userId` 且 `chat.id === cfg.chatId` 且非空文本。
  - `callback_query`：仅 `from.id === cfg.userId` 且 `message.chat.id === cfg.chatId`，且 `callback_data.q === 当前题号`（防旧卡）。
  - 被@者的非文本消息/表情 → 触发 `onNonText()` 通知（贴纸/图片不算作答，同飞书）。
- **点击锁定**：匹配的 callback → `answerCallbackQuery`（toast「已选择/已取消」）+ `editMessageText`/`editMessageReplyMarkup` 换为锁定键盘（✓/禁用），然后 resolve。
- **错误分类**：复用 `classifyRemoteError` 语义；`409 Conflict`（同 token 另有轮询）→ 错误包络；网络错误/`getUpdates` 401（token 错）→ 错误包络。
- `close()`：停止轮询循环、清理 timer（`timer.unref?.()` 防挂进程）。

**Success Criteria**：
- `waitForReply` 仅接受被@用户文本/按钮，其它用户消息被忽略且不 resolve。
- 非文本 → `onNonText` 触发；文本 → 正确 `TgReply`。
- 点击后卡片被锁定、`answerCallbackQuery` 已发。
- 超时返回 `null`；`close()` 后不再接收。
- 单测全部 mock `fetch`（纯逻辑可测，无真实网络）。

### 6.5 `tg-questionnaire` — TG 问卷编排

**Objective**：逐题发送+等待+解析，独立超时，超时返回部分答案；复用飞书 `RemoteOutcome`/`RemoteQuestion`/`parseReply`。

**接口**（`remote/tg-questionnaire.ts`）：

```ts
export async function runTgQuestionnaire(
  transport: TgTransport,
  questions: readonly RemoteQuestion[],
  cfg: RemoteConfig,
  onNotify: (message: string, level: "info" | "error") => void,
): Promise<RemoteOutcome>; // 复用 remote-questionnaire 的 RemoteOutcome
```

**流程（镜像 `runRemoteQuestionnaire`）**：
1. 每题：`buildTgQuestionMessage(q, cfg.tg)` 文本；若 `cfg.tg.useCards` → `buildTgKeyboard`，`sendCard` 失败自动回退 `sendText`（同飞书）。
2. `onNotify(t("remote.tg_sent", "Question N sent to Telegram — awaiting the @-user"))`。
3. `transport.waitForReply(cfg.tg.timeoutMs, onNonText, card ? {question,index,cancelWord} : undefined)`。
4. `null` → `{ kind: "timed_out", partialAnswers }`。
5. `parseReply(reply.text, question, index, cfg.cancelWords)`：cancel → `{ answered, cancelled: true }`；否则 push answer。

**Success Criteria**：
- 每题一条消息、逐题等待，被@用户作答后进入下一题。
- 取消词/取消按钮中止问卷。
- tg 超时（独立 `cfg.tg.timeoutMs`）返回 `timed_out` + 部分答案，交由 orchestration 回落本地。

### 6.6 `rpiv-command` — 统一命令 `/rpiv-ask-user-question`

**Objective**：将旧 `/remote-ask`（飞书 toggle）与新 `prd`（session 级 tg）合并为单一命令的子命令；**彻底移除 `/remote-ask`**（无别名）。

**命令形状**：
```
/rpiv-ask-user-question                          # 无参：用法说明 + 双渠道综合状态
/rpiv-ask-user-question status                   # 综合状态（remote.enabled + ask-prd + 双方凭证/超时）
/rpiv-ask-user-question remote on|off|status     # 飞书远程主模式（落盘 remote.enabled，保留原 /remote-ask 语义）
/rpiv-ask-user-question prd on|off|status        # session 级 ask-prd（不落盘）
```

**行为**：
- 解析 `args` 第一个 token 为子命令（`remote`/`prd`/`status`/空），第二个 token 为动作（`on`/`off`/`status`）。
- `remote`：旧 `remote-command.ts` 逻辑原样迁移（`setRemoteEnabled` 落盘、凭证缺失拒绝、空参 toggle）。
- `prd`：`status` 显示当前 session 开关 + `isTgConfigured` + `tg.timeoutMs`；`on` 若 `!isTgConfigured(cfg)` → error notify（提示编辑 config.json 的 `remote.tg`），否则 `setAskPrdEnabled(sessionId, true)`；`off` → `setAskPrdEnabled(sessionId, false)`；`sessionId` 取自 `ctx.sessionManager.getSessionId()`。
- 无参 / `status`：打印 usage + 综合状态（飞书 `remote.enabled`、tg `ask-prd`、双方凭证与超时）。
- `!ctx.hasUI` → error notify（同旧 `/remote-ask`）。
- `getArgumentCompletions`：首级 `["remote","prd","status"]`；前缀命中子命令后补 `["on","off","status"]`。

**注册**：`index.ts` 中 `registerRemoteCommand` 移除，改为 `registerRpivCommand(pi)`。

**Success Criteria**：
- 四个入口（无参/status/remote X/prd X）行为正确、状态即时反馈到终端。
- `remote` 子命令与旧 `/remote-ask` 行为完全一致（落盘语义不变）。
- `prd` 凭证缺失时 `on` 拒绝并明确提示；不写 config.json（session 级）。
- 旧 `/remote-ask` 不再注册（`registerRemoteCommand` 移除）。

### 6.7 `orchestration` — ask-user-question.ts 路由

**Objective**：ask-prd 开启时拦截并跳过飞书全部逻辑，走 tg；tg 超时回落本地。

**路由逻辑**（`execute()` 内，置于 `shouldUseRemote` 分支之前）：

```ts
const remoteCfg = loadRemoteConfig(loadConfig().remote);
const askPrd = isAskPrdActive(ctx.sessionManager.getSessionId());

if (askPrd) {
  // ask-prd：飞书全部逻辑跳过，由 tgbot 拦截
  emitAskUserBlockedEvent(pi, true);
  try {
    if (!isTgConfigured(remoteCfg)) {
      // tg 未配置 → 本地提问；本地超时兜底到飞书也必须禁用（不发飞书）
      return localOutcomeEnvelope(await runLocalQuestionnaire(pi, ctx, typed, remoteCfg, { enableLocalTimeout: false }), typed);
    }
    const outcome = await runTgQuestionnaireWithConnect(ctx, questions, remoteCfg);
    if (outcome.kind === "answered") return buildQuestionnaireResponse(outcome.result, typed);
    if (outcome.kind === "timed_out") {
      const recovered = await recoverFromRemoteTimeout(pi, ctx, questions, outcome, remoteCfg); // 复用，本地重问
      return localOutcomeEnvelope(recovered, typed);
    }
    return buildToolResult(outcome.message, { answers: outcome.partialAnswers, cancelled: true });
  } finally {
    emitAskUserBlockedEvent(pi, false);
  }
}

if (shouldUseRemote(remoteCfg)) { /* 既有飞书路径，不改动 */ }
```

**要点**：
- `ask-prd` 分支在 `shouldUseRemote` 之前 → 即便 `remote.enabled=true`（飞书主模式）也被跳过。
- tg 未配置时本地提问用 `{ enableLocalTimeout: false }` → `localTimeoutMs` 的「本地超时兜底到飞书」也被禁用（彻底拦截飞书）。
- `runTgQuestionnaireWithConnect`：镜像 `runRemoteQuestionnaireWithConnect`（createTgTransport + runTgQuestionnaire + close，失败包错误包络）。
- `recoverFromRemoteTimeout` 为通道无关复用（仅用 `partialAnswers` + `runLocalQuestionnaire`），tg 超时直接复用，无需改动。
- `ERROR_*` 提示串新增 tg 专用（连接失败/未配置），沿用「用户没看到问题 ≠ 拒绝」错误包络语义。

**Success Criteria**：
- `ask-prd on` + 配置完整 → 问题走 tg（飞书零消息）。
- `ask-prd on` + tg 未配置 → 本地提问且**不**兜底到飞书。
- tg 超时 → 本地重问未答问题，`questionIndex` 保序合并（复用恢复逻辑）。
- 未开启 ask-prd → 既有行为完全不变（回归）。

---

## 7. Code Style

沿用仓库既有风格（biome 强制：tab 缩进、lineWidth 120、preset recommended）：

- 命名：类型/接口 PascalCase，函数/变量 camelCase，模块文件 kebab-case；常量 UPPER_SNAKE。
- 纯函数优先、副作用收口在 transport/orchestration；错误用错误包络返回而非 throw（同 `RemoteOutcome`）。
- 配置解析一律手工守卫（`isNonEmptyString`、`Number.isFinite` 等），malformed 回落默认，绝不 throw（同 `loadRemoteConfig`）。
- i18n：文案走 `t("remote.tg_*", "English fallback")`，并同步 `locales/en.json`、`locales/zh.json`。
- 示例（镜像飞书 message-format 风格）：

```ts
export const TG_CANCEL_VALUE: TgButtonValue = { q: "0", c: "1" };

export function buildTgQuestionMessage(q: QuestionData, cfg: TgRemoteConfig): string {
	const lines: string[] = [];
	const header = q.header ? `${REMOTE_MSG_HEADER(q.header)} ` : "";
	lines.push(`${tgMention(cfg)} 请回答：`);
	lines.push(`${header}${q.question}`);
	lines.push("");
	q.options.forEach((o, i) => lines.push(MSG_OPTION_LINE(i + 1, o.label, o.description)));
	lines.push("");
	lines.push(t("remote.msg.tg_hint", "Reply with the option number, or type your own answer."));
	return lines.join("\n");
}
```

- 单测：每文件同名 `.test.ts`，用 vitest `describe/it/expect`，mock `fetch`/transport，避免真实网络。

---

## 8. Testing Strategy

- **框架/位置**：vitest，测试文件与被测模块同目录（`remote/*.test.ts` 模式）。
- **层级**：
  - 单元（主要）：`tg-config`/`tg-message`/`ask-prd-state`/`rpiv-command` 纯逻辑全覆盖；`tg-channel` mock `fetch` 覆盖发送、轮询、作答过滤、锁定、超时、409/401 错误分类。
  - 编排：`tg-questionnaire` mock `TgTransport`；`ask-user-question.ts` 路由级用例（mock transport）覆盖 §6.7 三条路径（tg 正常 / tg 未配置本地且不兜底飞书 / tg 超时回落本地）。
  - 回归：既有 661 用例保持全绿，飞书路径不受影响。
- **覆盖率**：新模块纳入 vitest coverage 阈值（stat 94 / branch 87 / func 93 / line 95）。
- **可选 e2e**（不阻塞单测）：本机可用真实 Telegram bot 凭证时，人工验证「发送+@提及+按钮点击全链路」；前置条件与飞书 e2e 相同（本机凭证），见 `docs/memory/rpiv-ask-user-question-feishu-remote.md`。

---

## 9. Boundaries

**Always do**
- 凭证全走 `config.json`（`remote.tg`），不引入环境变量。
- 配置解析 fail-soft（malformed → defaults，不 throw）。
- 保持「用户没看到问题 ≠ 拒绝」错误包络语义（发送/连接失败让模型用文本提问）。
- ask-prd 开启时彻底跳过飞书（含 `localTimeoutMs` 兜底）。
- 只接受被 @ 用户的作答；其它用户消息忽略。
- 新增模块加入 `package.json#files` 发布白名单；新文案同步 en/zh locale。
- 实现前跑 `npm run check` + 包内 vitest。

**Ask first**
- 增加任何 npm 依赖（当前设计为零新增依赖，用全局 `fetch`）。
- 修改既有飞书路径行为（§6.7 之外对 `feishu-channel`/`remote-questionnaire` 的改动）。
- 改变 `remote.tg.timeoutMs` 默认值（当前默认 30 分钟）。
- 引入 webhook 方式或改动配置 schema 字段名。
- 更新 `docs/memory/` 记忆或发布包。

**Never do**
- 不把 bot token / 凭证写入代码、日志或提交到 git。
- 不修改 `node_modules`、不提交 secrets、不删除/绕过失败测试。
- 不改变飞书既有行为来迁就 tg（隔离，各自独立）。
- 不在 ask-prd 开启时把消息发到飞书（无论配置如何）。

---

## 10. Success Criteria（可测试验收）

1. `remote.tg` 合法配置 + `/rpiv-ask-user-question prd on` → 新 `ask_user_question` 的每个问题均出现在指定 chat、带 @提及与被@者可点击的按钮卡片；飞书零消息。
2. 只有被 @ 用户作答有效；其它用户文本/按钮点击被忽略，问卷不推进。
3. 按钮点击直接作答并锁定卡片（✓/禁用 + toast），重复点击不重复计数。
4. tg 超时使用独立 `remote.tg.timeoutMs`（默认 30 min），与飞书 `remote.timeoutMs` 互不影响。
5. tg 超时无回复 → 未答问题在主对话本地重问，`questionIndex` 保序合并。
6. 新会话 / 重启后 `ask-prd` 自动关闭；`/rpiv-ask-user-question prd status` 反馈准确。
7. `remote.enabled=true`（飞书主模式）时开启 ask-prd 仍走 tg，飞书被跳过。
8. 未开启 ask-prd → 既有行为完全不变（661 用例全绿 + 路由回归）。

---

## 11. Open Questions

- **tg.timeoutMs 默认值**：当前定 30 分钟；如需更长/更短（如 1 小时）请在实施前说明。
- **e2e 验收**：是否需要真实 Telegram bot 凭证做端到端人工验证（同飞书 e2e 流程），还是仅单测通过即可视为完成？
- **多会话并发**：同一 bot token 在多个 pi 会话同时长轮询会 409（Telegram 单轮询限制）。当前设计按「同一时间只有一个活跃 tg 问卷」处理，是否需要多会话串行/互斥策略？
