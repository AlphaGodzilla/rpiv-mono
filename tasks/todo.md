# Task List: ask-prd — tgbot 远程问答模式

> 依赖 `tasks/plan.md`。任务按依赖顺序编号，每个任务满足 Acceptance criteria + Verification 才算完成。
> 聚焦测试命令：`cd ~/.pi/agent/rpiv-mono && npx vitest run packages/rpiv-ask-user-question`

## Task 1: ask-prd-state — session 级开关状态

**Description:** 新建内存单例管理 `ask-prd` 开关，按 sessionId 键控；`session_start` 事件复位。纯逻辑、不落盘。

**Acceptance criteria:**
- [x] `isAskPrdActive(sid)` 仅当 `enabled && sid === state.sessionId` 为 true；其它 sid 永远 false
- [x] `setAskPrdEnabled(sid, true/false)` 与 `resetAskPrdState()` 行为正确
- [x] `index.ts` 订阅 `pi.on("session_start", ...)` 调用 `resetAskPrdState()`（防御性双保险）

**Verification:**
- [ ] Tests pass: `npx vitest run packages/rpiv-ask-user-question/remote/ask-prd-state.test.ts`
- [ ] Build succeeds: `npm run check`（biome + tsc --noEmit）干净
- [ ] Manual check: 无（纯逻辑）

**Dependencies:** None

**Files likely touched:**
- `remote/ask-prd-state.ts`（新）
- `remote/ask-prd-state.test.ts`（新）
- `index.ts`（改，注册 session_start 复位）

**Estimated scope:** Small（2-3 文件）

## Task 2: tg-config — remote.tg 配置解析与守卫

**Description:** 扩展 `RemoteConfig` 增加 `tg` 段（`TgRemoteConfig`），手工守卫解析（fail-soft），新增 `isTgConfigured` 与 `DEFAULT_TG_TIMEOUT_MS`。

**Acceptance criteria:**
- [x] `loadRemoteConfig` 解析 `remote.tg`（botToken/chatId/userId/username/useCards/timeoutMs），缺字段/错类型回默认不 throw
- [x] `isTgConfigured` 三条件独立（botToken、chatId 非空，userId>0）
- [x] tg 配置不影响飞书 `shouldUseRemote` 判定（互不干扰）

**Verification:**
- [ ] Tests pass: `npx vitest run packages/rpiv-ask-user-question/remote/remote-config.test.ts`
- [ ] Build succeeds: `npm run check`

**Dependencies:** None（扩展既有 remote-config.ts）

**Files likely touched:**
- `remote/remote-config.ts`（改）
- `remote/remote-config.test.ts`（改）

**Estimated scope:** Small（2 文件）

## Task 3: tg-message — TG 文本 + Inline Keyboard 卡片

**Description:** 纯函数构建 TG 消息文本（含 HTML @提及 `tg://user?id=` 或 username）、选项/取消 Inline Keyboard、作答后锁定键盘；复用飞书 `parseReply`/`isCancelWord`。

**Acceptance criteria:**
- [x] `buildTgQuestionMessage` 输出含合法 HTML @提及 + 完整编号选项文本
- [x] `buildTgKeyboard` 单选（每选项一按钮+取消）/多选（仅取消）/取消三种结构正确，callback_data `{q,o,c}` 同飞书（q=题号防旧卡）
- [x] `buildTgLockedKeyboard` 作答后 ✓/禁用锁定；纯函数无副作用

**Verification:**
- [ ] Tests pass: `npx vitest run packages/rpiv-ask-user-question/remote/tg-message.test.ts`
- [ ] Build succeeds: `npm run check`

**Dependencies:** Task 2（TgRemoteConfig）

**Files likely touched:**
- `remote/tg-message.ts`（新）
- `remote/tg-message.test.ts`（新）

**Estimated scope:** Small（2 文件）

## Task 4: tg-channel — TG Bot API 传输（getUpdates 长轮询）

**Description:** 用 Node 22 全局 `fetch` 封装 Telegram Bot API：sendMessage（文本/卡片）、getUpdates 长轮询接收、仅被@者（`from.id===userId`）作答过滤、按钮点击 answerCallbackQuery + editMessageReplyMarkup 锁定、close 停止轮询。高风险的传输核心，尽早做。

**Acceptance criteria:**
- [ ] `waitForReply` 仅接受被@者文本/按钮；其它用户消息忽略不 resolve；被@者非文本触发 `onNonText`
- [ ] 按钮点击（q 匹配当前题号）→ answerCallbackQuery + 锁定键盘后 resolve；超时返回 null
- [ ] 409/401/网络错误分类（`classifyRemoteError` 语义）；`close()` 停止轮询、timer unref 防泄漏

**Verification:**
- [ ] Tests pass: `npx vitest run packages/rpiv-ask-user-question/remote/tg-channel.test.ts`（mock fetch，无真实网络）
- [ ] Build succeeds: `npm run check`
- [ ] Manual check（可选）：真实 bot 凭证冒烟（发送 + @提及 + 按钮点击全链路）

**Dependencies:** Task 2, Task 3

**Files likely touched:**
- `remote/tg-channel.ts`（新）
- `remote/tg-channel.test.ts`（新）

**Estimated scope:** Medium（2 文件，逻辑复杂）

## Task 5: tg-questionnaire — TG 问卷编排

**Description:** `runTgQuestionnaire` 镜像飞书 `runRemoteQuestionnaire`：逐题发送+等待+解析；sendCard 失败回退 sendText；独立 `cfg.tg.timeoutMs`；超时返回 `timed_out` + 部分答案。复用 `RemoteOutcome`/`RemoteQuestion`/`parseReply`。

**Acceptance criteria:**
- [ ] 逐题发送+等待+解析，被@者作答后进入下一题；取消词/取消按钮中止
- [ ] 独立超时返回 `{ kind: "timed_out", partialAnswers }`（用 `cfg.tg.timeoutMs` 而非飞书 `timeoutMs`）
- [ ] sendCard 失败自动回退 sendText；发送失败返回错误包络（≠拒绝）

**Verification:**
- [ ] Tests pass: `npx vitest run packages/rpiv-ask-user-question/remote/tg-questionnaire.test.ts`（mock TgTransport）
- [ ] Build succeeds: `npm run check`

**Dependencies:** Task 4

**Files likely touched:**
- `remote/tg-questionnaire.ts`（新）
- `remote/tg-questionnaire.test.ts`（新）

**Estimated scope:** Small-Medium（2 文件）

## Task 6: rpiv-command — 统一命令 /rpiv-ask-user-question

**Description:** 移除 `remote-command.ts`（`/remote-ask`），新建 `rpiv-command.ts` 注册 `/rpiv-ask-user-question`，handler 解析子命令 `remote`/`prd`/`status`/空；`remote` 沿用旧落盘语义，`prd` 为 session 级；无参/status 打印用法+综合状态；两级补全。

**Acceptance criteria:**
- [x] `remote on/off/status` 与旧 `/remote-ask` 行为一致（`setRemoteEnabled` 落盘）（`setRemoteEnabled` 落盘、凭证缺失拒绝）
- [x] `prd on/off/status` session 级不落盘；`prd on` 时 `!isTgConfigured` 拒绝并提示
- [x] 无参/`status` 打印用法+综合状态；两级补全；`/remote-ask` 不再注册（`registerRemoteCommand` 移除）（`registerRemoteCommand` 移除）

**Verification:**
- [ ] Tests pass: `npx vitest run packages/rpiv-ask-user-question/remote/rpiv-command.test.ts`
- [ ] Build succeeds: `npm run check`
- [ ] Manual check: pi 内 `/reload` 后 `/rpiv-ask-user-question status`、`remote status`、`prd status`

**Dependencies:** Task 1, Task 2

**Files likely touched:**
- `remote/rpiv-command.ts`（新）
- `remote/rpiv-command.test.ts`（新）
- `remote/remote-command.ts`（删）
- `remote/remote-command.test.ts`（删）
- `index.ts`（改，注册 rpiv-command，移除 registerRemoteCommand）

**Estimated scope:** Medium（3-5 文件）

## Task 7: orchestration — 路由集成 + 收尾

**Description:** `ask-user-question.ts` 在 `shouldUseRemote` 分支前插入 ask-prd 分支：ask-prd 开启走 tg（跳过飞书全部逻辑）；tg 未配置 → 本地且 `enableLocalTimeout:false`（不兜底飞书）；tg 超时 → 复用 `recoverFromRemoteTimeout` 本地重问。收尾：locales（en/zh tg 文案）、docs/configuration.md、package.json files 白名单、路由级测试。

**Acceptance criteria:**
- [x] ask-prd on + 配置完整 → 走 tg，飞书零消息（即使 `remote.enabled=true` 也跳过）（即使 `remote.enabled=true` 也跳过）
- [x] ask-prd on + tg 未配置 → 本地提问且不兜底到飞书（`enableLocalTimeout:false`）（`enableLocalTimeout:false`）
- [x] tg 超时 → 本地重问未答问题，`questionIndex` 保序合并；未开启 ask-prd 既有行为不变（回归）
- [x] 新增模块全部加入 `package.json#files` 白名单；tg 文案同步 en/zh locale

**Verification:**
- [ ] Tests pass: `npx vitest run packages/rpiv-ask-user-question`（全绿，含既有 661 用例回归）
- [ ] Build succeeds: `npm run check`
- [ ] Manual check（可选 e2e）：真实 bot 凭证走通「发送+@提及+按钮点击→完成问卷」；SPEC §10 验收

**Dependencies:** Task 1–6

**Files likely touched:**
- `ask-user-question.ts`（改，路由）
- `ask-user-question.test.ts`（改，路由级用例）
- `locales/en.json`、`locales/zh.json`（改，`remote.tg_*` 文案）
- `docs/configuration.md`（改，remote.tg 配置说明）
- `package.json`（改，files 白名单）

**Estimated scope:** Medium（3-5 文件）

---

## Checkpoint: After Task 1-3（Foundation）
- [x] `npx vitest run packages/rpiv-ask-user-question` 全绿 (677 passed)
- [x] `npm run check`（tsc 通过 + 改动文件 biome 干净；根目录 biome 路径问题为既有，见下）
- [ ] 与人类复核一次再继续

## Checkpoint: After Task 4-5（Transport）
- [x] tg-channel / tg-questionnaire 单测全绿（17/17，mock fetch / mock transport）
- [ ] 可选：真实 Telegram bot 凭证冒烟

## Checkpoint: After Task 6-7（Complete）
- [x] 全包单测全绿（709 passed + 1 skipped，含既有回归）
- [ ] `/reload` 后 `/rpiv-ask-user-question` 手动验证（status/remote/prd 全路径）
- [ ] SPEC §10 全部 Success Criteria 满足
- [ ] 与人类复核后进入 Phase 3（Tasks）逐条实现
