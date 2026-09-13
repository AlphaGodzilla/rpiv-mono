# @juicesharp/rpiv-ask-user-question

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-ask-user-question.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question">
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/cover.png" alt="rpiv-ask-user-question cover: a tabbed terminal questionnaire asking Which real development task are we planning right now?, with numbered options — Bug fix, New feature, Refactor — each under a one-line description, and a footer of key hints" width="50%">
  </a>
</div>

Let the model ask you instead of guessing. This extension gives [Pi Agent](https://github.com/badlogic/pi-mono) one tool — `ask_user_question` — that opens a terminal dialog of up to four questions with written-out options, and hands your choices back as structured data. Install it if you would rather spend fifteen seconds picking than an hour undoing a wrong assumption.

## Install

```sh
pi install npm:@juicesharp/rpiv-ask-user-question
```

Restart your Pi session.

## Quick start

Nothing to set up — the tool is live as soon as Pi restarts. Hand the model a task with a real decision buried in it:

> Add caching to the API client.

Rather than picking a strategy on your behalf, the model calls `ask_user_question` and a dialog takes over the bottom of your terminal. Move with `↑`/`↓`, choose with `Enter`, press `n` to attach a note, or land on the `Type something.` row to answer in your own words. While typing, `Shift+Enter` adds a line, `Ctrl+G` opens Pi's configured external editor, and `Ctrl+U` clears the draft; browsing another option and returning keeps what you wrote. `Esc` abandons the questionnaire entirely.

![Single question in the dialog: the tab strip reads Feature Type, Design Tab, Testing, Release, Submit; the question Which real development task are we planning right now? sits above four numbered options — Bug fix (Recommended), New feature, Refactor, Perf tuning — each with a one-line description, followed by the appended Type something. row](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/single-question.jpg)

When the model asks several things at once, `Tab` moves between them and a Submit tab reviews everything before it goes back:

![Submit tab of a four-question dialog: a Review your answers list showing Feature Type set to Bug fix and Testing set to Unit tests plus Integration tests, a warning naming Design Tab and Release as still unanswered, and a picker offering Submit answers or Cancel](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/submit-tab.jpg)

## What you get

- **Typed options instead of a wall of prose** — each question carries 2-4 authored choices, and every choice comes with a description of what it means or what it costs you.
- **You can always answer in your own words** — a `Type something.` row is appended to every question, single- or multi-select, widens to the full pane while you type, keeps its multiline draft visible in that row while you browse, and supports Pi's `Shift+Enter` newline and `Ctrl+G` external-editor flows.
- **Compare real artifacts, not just labels** — an option can carry a markdown `preview` (ASCII mockup, code, diagram, config) that renders in a bordered box beside the option list.
- **One interruption, not five** — up to four questions arrive in a single tabbed dialog, and the Submit tab lists your answers and names anything still blank before you commit.
- **Notes on any answer** — `n` opens a multiline note editor on any question tab; the note travels back to the model alongside the choice without marking the question answered.
- **Read the transcript behind the dialog** — `Ctrl+]` collapses the overlay so you can scroll the conversation, then brings it back with your answers intact.
- **Works outside the terminal too** — in RPC and ACP hosts such as the VS Code pendant or Zed the questionnaire walks through the host's native dialogs, and in non-interactive runs the tool is removed from the model's tool list instead of failing every call.
- **Ask from your phone** — with the pi-channel plugin and a Feishu receiver configured, `remote.enabled` sends every question to Feishu as interactive cards with clickable option buttons (group chats need an @), and `localTimeoutMs` makes an unanswered local dialog hand its remaining questions to Feishu after a delay. Toggle it live with `/rpiv-ask-user-question remote`.
## Configuration
Optional. Settings live in `~/.config/rpiv-ask-user-question/config.json`; the file is read, never written.

| Setting | What it does | Default |
| --- | --- | --- |
| `collapseKey` | Key that collapses and expands the dialog. Accepts Pi keybinding ids such as `alt+o`; `"off"` disables the shortcut. | `"ctrl+]"` |
| `guidance.promptSnippet` | One-line description of the tool in the system prompt — tune how eagerly the model asks. | built-in snippet |
| `guidance.promptGuidelines` | Usage guidelines given to the model, as a list of strings. | 4 built-in guidelines |
| `remote` | Feishu remote-asking mode (see below). | off |

```json
{ "collapseKey": "alt+o" }
```

Malformed JSON falls back to the defaults with a warning; an individual unusable value is silently dropped back to its default. Never an error.

### Remote asking via Feishu

Point `ask_user_question` at a Feishu bot so you can answer from anywhere:

```json
{
  "remote": {
    "enabled": false,
    "localTimeoutMs": 300000,
    "timeoutMs": 600000,
    "feishu": {
      "receivers": [
        { "type": "email", "value": "me@example.com" }
      ]
    }
  }
}
```

1. Install the **pi-channel** plugin and give it a Feishu enterprise self-built app (create one at the [Feishu developer console](https://open.feishu.cn/app), enable the **long-connection (长连接) event subscription** with the `im.message.receive_v1` event, plus the `im:message` send permission). The plugin owns the `appId`/`appSecret` and the connection.
2. Put your `receivers` in this config. Receiver `type` is a native `receive_id_type`: `open_id`, `user_id`, `union_id`, `email`, or `chat_id` (find your `open_id`/`chat_id` via the Feishu console's debug tools).
3. `remote.enabled: true` sends every questionnaire to Feishu as **interactive cards** — click an option button to answer (it gets a ✓ and the rest disable), or reply with the option number, `1,3` for multi-select, plain text, or a cancel word. In group chats the bot only answers when @'d. Set `feishu.useCards: false` to fall back to plain-text messages.
4. Alternatively leave `enabled` off and set `localTimeoutMs`: an unanswered local dialog closes after that many milliseconds and hands its **remaining** questions to Feishu, keeping your local answers.
5. `/rpiv-ask-user-question remote` (in Pi) toggles the mode on/off and prints the current status; `remote status` shows the receivers and whether the fallback is armed. The command writes `remote.enabled` back to the config file.

Full behavior, failure envelopes, and the RPC/ACP interplay: [configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/configuration.md) and [hosts](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/hosts.md).

## Reference

- [Tool schema](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/tool-schema.md) — parameters, limits, reserved labels, validation errors, the result envelope, and the `rpiv:ask-user:prompt` event.
- [Keyboard and layout](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/keyboard.md) — every key, the rows the dialog appends, notes, collapse mode, and how previews and overflow adapt to terminal size.
- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/configuration.md) — file lookup and `XDG_CONFIG_HOME`, the `collapseKey` grammar, the `guidance.*` prompt overrides, and how invalid values are handled.
- [Hosts and runtime behavior](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/hosts.md) — terminal vs RPC vs non-interactive, what degrades in each, and the load-failure envelopes.
- [Localization](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/localization.md) — the nine shipped languages, how the locale is chosen, and how to add one.

## Requirements

- Node.js 22 or newer.
- Pi Agent, with an interactive terminal or an RPC/ACP host. Non-interactive runs never see the tool.
- A terminal at least 100 columns wide for side-by-side previews; narrower terminals stack the preview under the options.

No native dependencies, no compiler, no API keys — the extension makes no model calls of its own.

## Troubleshooting

**The model says the questionnaire UI failed to load and asks its questions as chat text.** The dialog's modules were replaced on disk while Pi was running, usually by a package-manager install touching the store. Repair the install if it is broken, then restart Pi; the failure is not recoverable inside the running process.

**`Ctrl+]` does nothing.** On keyboard layouts where `]` sits on the shifted layer (Latin American among them) the default is unreachable. Set `collapseKey` to something you can type, for example `"alt+o"`.

## Related

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) — optional; installing it renders the dialog chrome in your language and adds `/languages`.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) — the umbrella package whose workflow skills use `ask_user_question` as their developer checkpoint. `/rpiv-setup` offers to install this extension.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/LICENSE).
