# Claude Ask Modal

Shows Claude Code decision questions as a native, centered VS Code modal.

The extension serves an MCP endpoint with one tool, `ask_modal`.

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
