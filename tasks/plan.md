# Implementation Plan: ask-prd — tgbot 远程问答模式

> 项目：`rpiv-mono` packages/rpiv-ask-user-question，分支 `base-v2.4.0`
> 依据：`SPEC.md`（已批准），依赖 `planning-and-task-breakdown`
> 任务清单：`tasks/todo.md`

## Overview

为 `rpiv-ask-user-question` 增加 session 级 `ask-prd` 模式：开启后 `ask_user_question` 的问题改由 Telegram bot 发送到指定 chat 并 @ 一个指定用户（仅该用户作答有效），交互卡片为 Telegram Inline Keyboard 按钮；独立可配超时（默认 30 分钟）；超时回落本地主对话提问。开启时飞书全部逻辑（远程主模式 + 本地超时兜底）被跳过。命令统一为 `/rpiv-ask-user-question`（子命令 `remote` / `prd`），旧 `/remote-ask` 移除。按能力地图自底向上实现：state → config → message → channel → questionnaire → command → orchestration。

## Architecture Decisions

- **零新增依赖**：Telegram Bot API 用 Node 22 全局 `fetch` 直连（`https://api.telegram.org/bot<TOKEN>/<method>`），已通过类型检查验证（`@types/node@22` 提供全局 fetch 声明）。
- **getUpdates 长轮询**：`timeout=50&offset=<last+1>&allowed_updates=["message","callback_query"]`；轮询仅在 `waitForReply` 活跃期间启动，`close()` 停止并 `unref` 防泄漏。
- **仅被@者作答**：`message.from.id` / `callback_query.from.id === cfg.userId` 才被处理；`callback_data` 载荷 `{q,o,c}` 与飞书 `CardButtonValue` 同构（`q`=题号防旧卡误触）。
- **锁定用 `editMessageReplyMarkup`**（只换键盘为 ✓/禁用态）而非 `editMessageText`，规避 Telegram "message is not modified" 错误；配合 `answerCallbackQuery` 出 toast。
- **ask-prd 状态**：内存单例 `{ sessionId, enabled }`，按 `ctx.sessionManager.getSessionId()` 键控，`session_start` 事件复位；不落盘、不写 config.json。
- **复用飞书侧**：`parseReply` / `isCancelWord`（tg-message 直接 import）、`RemoteOutcome` / `RemoteQuestion`（tg-questionnaire）、`recoverFromRemoteTimeout`（orchestration 超时回落，通道无关）、`classifyRemoteError` 语义。
- **错误包络语义**：发送/连接失败返回 LLM 面错误包络（「用户没看到问题 ≠ 拒绝」，模型用文本提问），与飞书一致。
- **命令统一**：单命令 `/rpiv-ask-user-question`，handler 解析 `args` 首 token 子命令（`remote`/`prd`/`status`/空）+ 次 token 动作；`remote` 沿用旧 `/remote-ask` 落盘语义，`prd` 为 session 级；无参/`status` 打印用法+综合状态；`getArgumentCompletions` 两级补全。

## Task List

见 `tasks/todo.md`（每个任务含 Acceptance criteria / Verification / Dependencies / Files）。

### Phase 1: Foundation（T1–T3）
- [ ] Task 1: `ask-prd-state` — session 级开关状态
- [ ] Task 2: `tg-config` — `remote.tg` 配置解析与守卫
- [ ] Task 3: `tg-message` — TG 文本 + Inline Keyboard 构建

### Checkpoint A: Foundation
- [ ] `npx vitest run packages/rpiv-ask-user-question` 全绿
- [ ] `npm run check`（biome + tsc --noEmit）干净
- [ ] 与人类复核一次再继续

### Phase 2: Transport + Orchestrator（T4–T5）
- [ ] Task 4: `tg-channel` — TG Bot API 传输（getUpdates 长轮询）
- [ ] Task 5: `tg-questionnaire` — TG 问卷编排

### Checkpoint B: Transport
- [ ] tg-channel/tg-questionnaire 单测全绿（mock fetch / mock transport）
- [ ] 可选：真实 Telegram bot 凭证冒烟（发送 + @提及 + 按钮点击）

### Phase 3: Command + Integration（T6–T7）
- [ ] Task 6: `rpiv-command` — 统一命令 `/rpiv-ask-user-question`（remote/prd 子命令），移除 `/remote-ask`
- [ ] Task 7: `orchestration` — ask-user-question.ts 路由集成 + locales/docs/files 白名单收尾

### Checkpoint C: Complete
- [ ] 全包单测全绿（含既有 661 用例回归）
- [ ] `/reload` 后 `/rpiv-ask-user-question` 手动验证（status/remote/prd 全路径）
- [ ] SPEC §10 全部 Success Criteria 满足
- [ ] 与人类复核后进入 Phase 3（Tasks）逐条实现

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| getUpdates 409 Conflict（同 token 另有轮询/多会话） | High | 错误包络 + 明确错误提示；文档注明 Telegram 单轮询限制；spec Open Question 待用户决策多会话策略 |
| `editMessageText` "message is not modified" | Med | 锁定用 `editMessageReplyMarkup`（只换键盘），不改文本 |
| 长轮询生命周期泄漏（timer/轮询循环挂进程） | Med | 轮询仅 waitForReply 活跃期间启动；close 停止 + `timer.unref?.()` |
| `fetch` 类型/可用性 | Low | 已验证 Node22 全局 fetch 类型通过（tsc --strict 无错） |
| ask-prd 状态跨会话误判 | Low | 按 sessionId 键控 + `session_start` 复位双保险 |
| 被@者不在 chat / 无 username | Med | `tg://user?id=` 提及在超级群可用；docs 说明前置条件（bot 与被@者须在同一 chat） |
| 同 bot token 长轮询与既有 feishu 无冲突 | Low | 独立 transport，不共享长连接 |

## Open Questions

- `remote.tg.timeoutMs` 默认 30 分钟是否合适（见 SPEC §11）。
- 是否需要真实 Telegram bot 凭证做 e2e 验收（不阻塞单测）。
- 多会话同时活跃时同 bot token 长轮询 409 的处理策略（当前按单活跃问卷处理）。
