# Hosts and runtime behavior

Where the questionnaire renders, what it degrades to, and what happens when it cannot
render at all.

## Three environments

| Environment | What the model sees | What you see |
| --- | --- | --- |
| Interactive terminal | `ask_user_question` in its tool list | The full tabbed TUI overlay |
| RPC / ACP host (VS Code pendant, Zed, Paseo) | `ask_user_question` in its tool list | A sequence of the host's own native select and input dialogs |
| Feishu remote mode (`remote.enabled`, receiver configured) | `ask_user_question` in its tool list | One Feishu message per question; you reply in Feishu |
| Non-interactive run (no UI) | Nothing — the tool is removed | Nothing |

## Feishu remote mode

When `remote.enabled` is `true`, a Feishu receiver is configured and the pi-channel plugin
is connected, every questionnaire skips the terminal entirely: each question is sent as one message to every
configured receiver, and the first matching reply is parsed back into the same result
envelope the TUI produces. This works identically in interactive terminals and RPC/ACP
hosts — anything with `ctx.hasUI` — because the dialog never opens. Non-interactive runs
still strip the tool (see below).

Reception rules:

- **Private chats**: any text message answers the pending question (only people who
  received the question know it exists). Stickers, images and other non-text messages are
  ignored with a hint.
- **Group chats**: only messages that @ the bot reach the consumer (the pi-channel
  plugin's `requireMention` policy — configure it there).
- A reply matching a `cancelWords` entry aborts the whole questionnaire (`cancelled: true`),
  mirroring `Esc`.
- Waiting longer than `timeoutMs` per question also cancels — a user who does not answer
  the first question is unlikely to answer later ones.

### Interactive cards

With `feishu.useCards` (default), each question is sent as a V2 interactive card:
single-select questions carry one button per option plus a Cancel button. Clicking a
button answers the question (the click arrives as `card.action.trigger` over the same
long-connection) and immediately locks the card via the message-update API: the chosen
button gains a ✓, every other button is disabled. Multi-select questions render the
options in the card but keep the free-text interaction (`1,2` reply) since a single
click cannot express a selection list; the card still carries a Cancel button.

Card-callback acks are handled by the pi-channel plugin: every button value carries an
`ackText` toast ("已选择"/"已取消") and the plugin answers the platform within the 3-second
window (Feishu card callback response / Telegram `answerCallbackQuery`). Locking an
answered card is a normal bus update (`update.messageId`), because a Feishu callback
response cannot carry a V2 card body.

Card send failures fall back to plain text automatically; `feishu.useCards: false`
disables cards entirely.

Failure handling: a send failure returns an envelope telling the model the user never saw
the questions and to ask them as plain chat text — explicitly not a decline. The message
names the error code the pi-channel plugin reported (`not_configured`, `permission_denied`,
…), or `timeout` when the plugin is absent or did not answer the request in time.

### Local-timeout fallback

opens normally but arms a total-duration timer. When it fires, the dialog closes with the
answers committed so far, a notification announces the handoff, and the *remaining*
questions are sent to Feishu. The envelope then merges local and remote answers, with
original question indices preserved. The fallback never engages when the user cancelled
(`Esc`) or completed the dialog in time, and it does not apply to the RPC dialog walker
(no unified session to time out).

## Non-interactive runs

A `before_agent_start` hook reconciles the active tool set against `ctx.hasUI` before every

A `before_agent_start` hook reconciles the active tool set against `ctx.hasUI` before every
turn. When there is no UI, `ask_user_question` is stripped from the list so the model never
sees a tool it cannot use — better than offering it and auto-declining every call. When UI
comes back, the tool is restored. The reconciler is idempotent and leaves sibling tools
untouched.

A second guard lives inside the tool handler as a one-turn backstop: if a call somehow
arrives without UI, it returns `error: "no_ui"` and the text
`Error: UI not available (running in non-interactive mode)`.

## RPC and ACP hosts

RPC hosts report `hasUI: true` because Pi's dialog sub-protocol works there, but custom
terminal UI does not render. The package detects this two ways: hosts that advertise
`ctx.mode === "rpc"` route straight to the dialog walker, skipping the TUI import
entirely, and older RPC builds are caught by a backstop when custom UI resolves without
rendering anything. Either path requires the host to expose both `select` and `input`.

The walker asks one question per dialog and returns exactly the same result envelope the
TUI produces. Trade-offs inherent to the native primitives:

- No side-by-side preview pane. Previews are folded into the dialog title instead,
  truncated at 600 characters each.
- No tab bar and no Submit review tab — one dialog per question, in order.
- Multi-select is a free-text input: type the option numbers, comma-separated
  (`1,3`). Any token that is not a valid option index is treated as a typed custom answer,
  which is how the `Type something.` escape survives. An empty input commits an empty
  selection, matching `Next` with nothing toggled.
- Dismissing any dialog cancels the whole questionnaire, mirroring `Esc` in the TUI.

If the host can render neither custom UI nor dialogs, the call returns
`error: "no_custom_ui"` with text telling the model the user never saw the questions and
that it should ask them as plain chat text instead — explicitly not a decline.

## Conditional surfaces

Some parts of the dialog exist only under the right conditions:

| Surface | Appears when |
| --- | --- |
| Tab bar and Submit tab | The call carries more than one question |
| `Next` row | The question is multi-select |
| `Type something.` row | Always |
| Side-by-side preview | An option carries a `preview`, and terminal and pane are both ≥ 100 columns |
| Preview pane at all | Single-select questions only |
| Collapse shortcut | `collapseKey` is not `"off"` and the host exposes raw terminal input |
| Localized chrome | `@juicesharp/rpiv-i18n` is installed |

## Loading and startup cost

The dialog's render graph costs roughly 560 ms to import, so it is loaded lazily — on the
first tool call, not when the extension registers. To keep that first call fast and safe,
the graph is also pre-warmed in the background two seconds after startup. The pre-warm
timer is unref'd, so it never holds a process open, and a failed pre-warm is swallowed:
the first real call re-imports and reports properly.

The pre-warm exists for a specific failure. Pi's module loader registers a module in its
graph cache *before* evaluating it and does not evict it if evaluation throws. If your
package manager replaces the dependency store while Pi is running, one failed import can
poison the cache for the rest of the process. Evaluating the graph early, while the paths
Pi resolved at boot still exist, keeps it in memory for the process lifetime and makes
that unreachable.

When it does happen, you get a structured envelope rather than a raw `TypeError`:

| `error` | Meaning | Fix |
| --- | --- | --- |
| `session_load_failed` | The dialog module could not be imported. | Repair the install if needed, then restart Pi. |
| `stale_module_cache` | The module cache went stale after an earlier failed import. | Restart Pi — this is unrecoverable in the running process. |

Both messages tell the model the questions were never shown and to ask them as plain chat
text instead of treating the failure as a decline.
