# opencode-ask-user-question

Claude Code-style interactive questioning for [OpenCode V2](https://opencode.ai) plugins.
Native rewrite of the pi extension [`pi-ask-user-question`](https://github.com/hakergeniusz/pi-ask-user-question).

Lets the model ask 1–4 multiple-choice questions (2–4 options each) mid-turn, with
descriptions, optional previews, multi-select, and an automatically appended
"Other" free-text option. Questions share one hard 3-minute deadline.

## What it does

- Registers the `AskUserQuestion` tool (Claude Code-compatible schema).
- **sync** (default): blocks the turn until the user answers, declines, or the
  timeout fires. Returns `"question"="answer"` text to the model.
- **async**: returns immediately, keeps the question open, and injects the
  result back into the session as a follow-up message (`delivery: "queue"`)
  when the user answers, declines, or time runs out — so the agent is notified
  either way and never needs to re-ask.
- **One dialog at a time**: a new question withdraws any older async question
  with a "do not re-ask" note.
- **Hard 3-minute timeout** with a live remaining-time hint in the dialog and a
  `Timeout - user did not reply within 3 minutes. Do not retry.` result.
- **Headless fallback**: with no TUI part connected, the tool returns text that
  tells the model to ask the user in plain text (same as the pi original).
- **Desktop notifications** via `notify-send` on ask, answer, timeout, and
  dismissal.
- `/ask-pending [id]` lists or cancels open async questions.

## Parts and how it loads

| Part | Export | File | SDK |
| --- | --- | --- | --- |
| Server | `.` | `src/index.ts` | `@opencode/plugin` |
| TUI | `./tui` | `src/tui.tsx` | `@opencode/plugin/tui` |
| RPC contract | `./rpc` | `src/rpc.ts` | `@opencode/plugin/rpc` |

One plugin entry loads the server and TUI parts together:

```jsonc title="opencode.jsonc"
{
  "plugins": ["opencode-ask-user-question"]
}
```

Local directory form:

```jsonc
{
  "plugins": ["./plugins/opencode-ask-user-question"]
}
```

TUI-only use (e.g. against a remote server): put the package in `cli.json`.

## How the pi behavior maps to OpenCode V2

| pi concept | OpenCode V2 implementation |
| --- | --- |
| `pi.registerTool` | `ctx.tool.transform(editor => editor.add({...}))` with a JSON Schema input; tool `execute` uses `context.signal` for cancellation. |
| `pi.registerCommand("ask-pending")` | `ctx.command.transform(...)`; replies are sent with `ctx.session.prompt({ delivery })`. A palette-only TUI command also lists pending questions. |
| `ctx.ui.custom(...)` rich TUI dialog + `askViaDialogs` RPC fallback | Server ↔ TUI **RPC bridge**: the tool emits `asked`; the TUI part subscribes and drives `context.ui.dialog.select` / `prompt`, then calls the `answer` / `decline` RPC methods. `resolved` closes stale dialogs. |
| `pi.sendUserMessage(..., { deliverAs: "followUp" })` | `ctx.session.prompt({ sessionID, text, delivery: "queue" })`. |
| `pi.on("session_shutdown")` | Cleanup function returned from `Plugin.define({ setup })`. |
| module-level `pendingQuestions` Map | Module-level `Map` scoped to the plugin instance (same process model as the original). |
| `ctx.hasUI` headless check | TUI `register` RPC method reports UI availability to the server. |
| `notify-send` | Kept as-is in the server part. |
| `details` in tool results + `renderCall`/`renderResult` | Not available in the V2 tool API; all information is conveyed in result text. |

## Options

No plugin options are required. The tool accepts:

- `questions` (1–4): each with `question`, `header` (≤12 chars), `options` (2–4, each with
  `label`, `description`, optional `preview`), optional `multiSelect`.
- `mode`: `"sync"` (default) or `"async"`.

The RPC contract is exported at `opencode-ask-user-question/rpc` for other
plugins or clients that want to drive questions.

## Known gaps

- **No custom tabbed dialog / animated countdown.** The pi extension drew a
  bespoke TUI component with tabs, previews, an inline editor, and a live
  `m:ss` countdown. OpenCode V2's TUI plugin API offers promise-based native
  dialogs instead, so the TUI part renders a sequence of native `select` /
  `prompt` dialogs. The remaining time is shown in each dialog title, and the
  server still enforces the hard deadline. Description text is preserved;
  `preview` is accepted by the schema but not rendered in a native dialog.
- **Result rendering.** `details`, `renderCall`, and `renderResult` from pi have
  no V2 equivalent; the model sees plain text results instead of colored chips.
- **UI detection** uses a registration handshake rather than a host `hasUI`
  flag. If the TUI crashes without running its cleanup, the server may briefly
  consider a UI connected until the unregister call is missed; the question
  then times out rather than falling back to text.
- **Permissions.** This tool does not call `ctx.permission.assert`; answering a
  question is itself the user interaction. Permission prompts are a separate
  OpenCode mechanism.

## Tests

The original pi tests were rewritten as SDK-free tests of the pure
validation/formatting core (`src/core.test.ts`, run with `bun test`). The TUI
dialog interaction and RPC plumbing are not unit-tested because they require a
running OpenCode server + TUI.

## License

MIT — 2026 hakergeniusz.
