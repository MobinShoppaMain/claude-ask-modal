# Claude Ask Modal

Shows Claude Code decision questions as a native, centered VS Code modal.

The extension serves an MCP endpoint with three tools: `ask_modal`, and `review_config` / `run_review` for
reviewer verdicts.

## What a question can show

- **Briefing screens**: a question without `options` is read-only, with a Continue button. Claude uses
  these to explain the problem before asking anything.
- **Markdown** in `context`, option descriptions and previews: headings, lists, tables, code, diffs.
- **Mermaid diagrams**: a ```` ```mermaid ```` block is drawn in the VS Code theme. Mermaid is bundled;
  nothing is loaded from the network.
- **Links**: `[text](https://...)` and bare `https://` URLs open in the browser. File references such as
  `` `src/Foo.cs:42` ``, `Foo.cs#L10` or `[text](https://github.com/MobinShoppaMain/claude-ask-modal/blob/HEAD/C:\repo\Foo.cs:42)` open in the editor beside the modal.
  Other schemes (`command:`, `javascript:`) are ignored.
- **Images**: `![alt](https://github.com/MobinShoppaMain/claude-ask-modal/raw/HEAD/C:\abs\path.png)` shows a local png, jpg, gif, svg or webp file that exists.
- **Something's off**: every screen can end the dialog with a correction, which Claude gets back
  instead of answers.
- **Dig deeper**: every screen can mark its decision as not ready, with an optional note; Claude then explains it in more depth and asks sharper follow-up questions before asking again
- **Already in the default branch**: each decision can carry a `precedent` box showing what the repo's default branch already does for it (or that nothing was found); Claude recommends reusing an existing helper or pattern first, and reviewers are told to check for one too
- **Reviewer verdicts**: each option shows who picked it (`Recommended · Claude ✓ · GPT-5.5 ✓`); a
  disagreeing reviewer's reason appears in a "Reviewer says" box above the options, and a failed review
  shows as a "Review failed" banner while the question stays answerable.

## Reviewers

Every recommendation is checked by a second model before you see it, and you can re-check any decision
with a model and account you pick. Accounts are listed in `claudeAskModal.reviewers` (read on every call,
no reload needed):

```json
"claudeAskModal.reviewers": [
  { "name": "session", "vendor": "claude", "preCheck": { "model": "fable", "effort": "high" } },
  { "name": "shoppa", "vendor": "codex" },
  { "name": "private", "vendor": "codex", "home": "C:\\Users\\me\\.codex-private" },
  { "name": "team", "vendor": "claude", "home": "C:\\Users\\me\\.claude-team" }
]
```

- `vendor`: `codex` or `claude`. `home` is the account's `CODEX_HOME` or `CLAUDE_CONFIG_DIR`; leave it
  out for the default login.
- A `claude` entry without `home` is the calling Claude session itself: Claude runs it as its own
  subagent. Every other entry runs through the `run_review` tool, which starts the CLI read-only in the
  repository (`codex exec -s read-only`, or `claude -p` with only Read, Grep and Glob) and stops it after
  3 minutes.
- Models: Claude accounts offer Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 (efforts low to max);
  codex accounts list what `codex debug models` returns for that account.

**Pre-check**: before each round with decisions, Claude runs the first entry with `preCheck` on every
decision in parallel and shows the verdicts beside its own pick.

**Check again**: on a decision screen, pick a reviewer and model, an effort, and press Check again. Like
Dig deeper, that question goes back to Claude (`(check again: <reviewer> <model> <effort>)`), which runs
that reviewer and asks the question again with all verdicts shown. Picking an option afterwards clears it.

**Log in** to an account once, in a terminal:

```
CODEX_HOME=C:\Users\me\.codex-private codex login
CLAUDE_CONFIG_DIR=C:\Users\me\.claude-team claude      (then type /login)
```

or use the "Log in to <name>" link next to the reviewer picker or in an auth-related "Review failed"
banner, or the command **Claude Ask Modal: Log in reviewer account**. Each opens a terminal with the
account's directory set.

## Long waits

Claude Code aborts a tool call after 300 seconds without a response or progress. While the modal is open,
the server answers as an event stream and sends a progress notification every 30 seconds, so the user can
take as long as they need.

## One modal per window

Each VS Code window serves its own endpoint on a port derived from its workspace folder
(40000-49999, the next free one if taken). On startup it registers that endpoint for the
folder with `claude mcp add --scope local ask-modal ...`, so Claude sessions in that folder
open their modals in that window. The `claude` CLI must be on PATH. A session started
before the first registration needs a restart to pick it up; after that the port stays
the same across window reloads.

To pin a workspace's port, set `claudeAskModal.port` in its workspace settings.

## Fallback

Every window also tries to listen on `claudeAskModal.port` (user setting, default 39217);
the first window to start owns it. Register it once for sessions with no local entry:

```
claude mcp add --transport http --scope user ask-modal http://127.0.0.1:39217/mcp
```

The output channel "Claude Ask Modal" logs the ports and registrations.
