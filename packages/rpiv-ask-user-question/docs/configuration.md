# Configuration

Every setting the package reads, where the file lives, and what happens when a value is
wrong.

## The config file

```
~/.config/rpiv-ask-user-question/config.json
```

The file is optional — with no config at all, every setting takes its default. During
normal operation the package only ever *reads* the file; the one exception is the
`/remote-ask` command, which writes back the `remote.enabled` flag (and nothing else). The
package never creates, chmods or rewrites the file otherwise, so its permissions are
whatever you give it.

A complete example:

```json
{
  "collapseKey": "alt+o",
  "guidance": {
    "promptSnippet": "Ask me before guessing on anything ambiguous",
    "promptGuidelines": [
      "Batch every clarifying question into one ask_user_question call.",
      "Put your recommended option first and suffix it with (Recommended)."
    ]
  },
  "remote": {
    "enabled": false,
    "localTimeoutMs": 300000,
    "timeoutMs": 600000,
    "cancelWords": ["取消", "cancel"],
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "receivers": [
        { "type": "email", "value": "me@example.com" },
        { "type": "chat_id", "value": "oc_xxx" }
      ]
    }
  }
}
```

### Where the file is looked up

1. `$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json`, if `XDG_CONFIG_HOME` is set,
   non-empty and absolute. A leading `~` is expanded first; a relative value is ignored.
   Unset or ignored, the directory falls back to `~/.config`.
2. If that file does not exist, the legacy path `~/.config/rpiv-ask-user-question/config.json`
   is read. This path deliberately ignores `XDG_CONFIG_HOME`, so an existing config keeps
   working after you set the variable.
3. Neither present: all defaults.

If the XDG-path file exists, its result wins even when it is malformed — there is no
second chance at the legacy path.

### When the file is invalid

Malformed JSON is not fatal. The loader warns on stderr and continues with defaults:

```
rpiv-config: invalid JSON at <path>, using default ({}) — <parser message>
```

Valid JSON that is not an object (a string, number, `null`, or an array) is rejected too,
falling back to defaults — but silently, with no warning. Individual keys with the wrong
type are likewise dropped back to their default without a warning.

## Settings

| Setting | What it does | Default |
| --- | --- | --- |
| `collapseKey` | Key that collapses and expands the dialog overlay. | `"ctrl+]"` |
| `guidance.promptSnippet` | One-line snippet describing the tool in the system prompt. | built-in snippet |
| `guidance.promptGuidelines` | List of usage guidelines given to the model. | 4 built-in guidelines |
| `remote` | Feishu remote-asking mode (see below). | off |

### `collapseKey`

The value uses Pi's keybinding id format: zero or more distinct modifiers from `ctrl`,
`shift`, `alt`, `super`, joined by `+`, followed by a base key. Values are trimmed and
lowercased before matching.

The base key is either a single printable character from
`a-z 0-9 _ - ! @ # $ % ^ & * ( ) | ~ \` ' " : ; , . / < > ? [ ] { } = \`, or one of the
named keys `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`,
`insert`, `clear`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`,
`f1`–`f12`.

Examples that work: `"ctrl+]"`, `"alt+o"`, `"ctrl+shift+h"`, `"f9"`, `"ctrl+}"`.

Set `"off"` (any casing) to disable the collapse shortcut entirely — no raw terminal
listener is registered in that case.

A spec that does not match the grammar is rejected and the default is used. This is
strict on purpose: Pi's parser takes the last `+`-separated part as the key and ignores
unknown parts, so a typo like `"ctr+]"` would otherwise silently capture every bare `]`
keypress at the terminal level.

One known rough edge: the footer hint line inside the dialog always reads `Ctrl+] to
collapse` and does not interpolate a custom `collapseKey`. The one-shot notification you
get when the dialog first collapses *does* name your configured key.

### `guidance.promptSnippet` and `guidance.promptGuidelines`

These replace the text Pi puts in the system prompt about when to reach for
`ask_user_question`. Use them to make the model ask more or less often, or to enforce a
house style for options.

`promptSnippet` is used only when it is a non-empty string. `promptGuidelines` is used
only when it is a non-empty array whose entries are all non-empty strings. Anything else
falls back to the built-in defaults. Both are read once, when the extension registers the
tool, so changes take effect on the next Pi restart.

### `remote` — Feishu remote asking

Lets `ask_user_question` reach you through a Feishu bot instead of (or after) the local
dialog. Credentials and receivers live in this config file — there is no environment-variable
or wizard path. Everything under `remote` is optional; with it absent, behavior is
identical to a version without this feature.

| Field | What it does | Default |
| --- | --- | --- |
| `enabled` | Remote as the primary mode: every questionnaire is sent to Feishu. | `false` |
| `localTimeoutMs` | Local-timeout fallback threshold. **Only when configured** does an unanswered local dialog hand its remaining questions to Feishu after this many milliseconds. Absent → no local timeout, original flow. | not set |
| `timeoutMs` | How long to wait for a Feishu reply per question. On timeout the unanswered questions are re-asked in the main conversation instead of being treated as a decline. | `600000` (10 min) |
| `cancelWords` | Exact-match words (after trim, case-insensitive) that abort the remote questionnaire. | `["取消", "cancel"]` |
| `feishu.appId` / `feishu.appSecret` | Credentials of a Feishu enterprise self-built app (开发者后台 → 凭证与基础信息). | — |
| `feishu.receivers` | Who receives the questions. Each entry is `{ "type", "value" }`; `type` is one of `open_id`, `user_id`, `union_id`, `email`, `chat_id` (the native `receive_id_type` values — no phone lookup). Invalid entries are dropped. | `[]` |
| `feishu.useCards` | Send questions as interactive cards. Single-select questions get one clickable button per option plus a Cancel button (the chosen button is checked ✓ and the rest disabled after a click); multi-select questions render the options in the card but still take a text reply (`1,2`). Card sends fall back to plain text automatically. | `true` |

Behavior matrix (when credentials are complete):

| `enabled` | `localTimeoutMs` | Behavior |
| --- | --- | --- |
| `true` | any | Everything goes to Feishu immediately. |
| `false` | configured | Local dialog first; after `localTimeoutMs` it closes, local answers are kept, and the remaining questions go to Feishu. |
| `false` | not set | Original flow, no timeout. |

If `localTimeoutMs` is configured but the Feishu credentials are missing, the fallback is
silently disabled — the local dialog never times out, so a config mistake cannot turn a
waiting user into a cancelled questionnaire.

Each question is sent as one message to every receiver; the first matching reply wins
(`Type something.`-style custom answers are plain text, option numbers select options,
multi-select accepts `1,3`). In group chats the bot only reacts to messages that @ it; in
private chats any message answers the pending question. Non-text messages (stickers,
images) are ignored with a hint. A cancel word cancels the whole questionnaire
(`cancelled: true`); a per-question timeout instead recovers to the main
conversation — the still-unanswered questions are re-asked in the local dialog
(and the local-timeout handoff comes back to the local ask too if Feishu stays
silent).

With `feishu.useCards` (default) a single-select question arrives as an interactive card
with one button per option plus a Cancel button. Clicking a button answers immediately
and locks the card — the chosen button shows a ✓, every other button (including Cancel)
is disabled so a repeated click cannot double-fire. Text replies keep working alongside
buttons, and card send failures fall back to plain text.


#### `/rpiv-ask-user-question` command

The single command for both remote-asking channels (it replaced the old `/remote-ask`):

```
/rpiv-ask-user-question                   → usage + combined status of both channels
/rpiv-ask-user-question status            → same
/rpiv-ask-user-question remote on         → enable Feishu remote (errors if credentials are missing)
/rpiv-ask-user-question remote off        → disable
/rpiv-ask-user-question remote status     → Feishu mode, local fallback, wait timeout, credentials, receivers
/rpiv-ask-user-question prd on            → enable session-level ask-prd (Telegram; errors if tg credentials are missing)
/rpiv-ask-user-question prd off           → disable
/rpiv-ask-user-question prd status        → ask-prd state, tg wait timeout, tg credentials
```

The `remote` subcommand writes `remote.enabled` back to this file (preserving every other
field, in the same file the loader actually reads). The `prd` subcommand is session-scoped:
it lives in memory keyed by the current session id and resets on every new/restored
session — it never writes config.json. The command requires an interactive session, and a
failed write never reports success. Malformed values in the file still fall back to
defaults, never to an error.

### `remote.tg` — ask-prd (Telegram)

`ask-prd` is a **session-level** mode: while it is on (`/rpiv-ask-user-question prd on`),
every questionnaire is sent by a Telegram bot to a chat and @-mentions a specified user,
and **all Feishu logic is skipped** (both the `remote` primary mode and the local-timeout
fallback to Feishu). Only the configured @-user's replies/button clicks count as answers.

| Field | What it does | Default |
| --- | --- | --- |
| `tg.botToken` | Telegram bot token (from @BotFather). | — |
| `tg.chatId` | Target chat id (group/supergroup ids are negative, kept as a string). The bot and the @-user must be members. | — |
| `tg.userId` | The @-mentioned user's numeric id; **only** this user's replies/button clicks are accepted. | — |
| `tg.username` | Optional public username (e.g. `"@alice"`) used for the visible @ mention. | absent → `@user(<id>)` |
| `tg.useCards` | Send questions as inline-keyboard cards (one button per option + Cancel); clicking answers immediately and **removes the buttons** from the card (a ✓ toast confirms). Multi-select still takes a text reply (`1,2`). Card sends fall back to plain text. | `true` |
| `tg.timeoutMs` | How long to wait for the @-user's reply per question. **Independent of the Feishu `timeoutMs`** — Telegram messages are not expected to be answered quickly. On timeout the unanswered questions are re-asked in the main conversation. | `1800000` (30 min) |
| `tg.proxy` | Optional HTTP(S) proxy (e.g. `"http://127.0.0.1:6152"`). Falls back to `HTTPS_PROXY`/`HTTP_PROXY` env, then the macOS system proxy (`scutil`), then a direct connection. Needed where Telegram requires a proxy (Node's global fetch cannot use the system proxy). | auto |

A bot in **privacy mode** only receives @-mentions, replies to its own messages, and
commands in a group — plain-text replies from the @-user would be missed. To let the
@-user answer with any text, disable Group Privacy for the bot (BotFather → Bot Settings →
Group Privacy → Turn off). The bot token must not be polled by any other process, or
`getUpdates` fails with 409.


## Environment variables

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME` | Relocates the config directory, as described above. Must be absolute. |

`LANG` and `LC_ALL` influence the dialog language, but they are read by
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) rather than
by this package — see [localization.md](./localization.md).

No other environment variables are read. The package makes no model calls, so it needs no
API keys or model settings of its own.
