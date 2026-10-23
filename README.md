# Claude Ask Modal

Shows Claude Code decision questions as a native, centered VS Code modal.

The extension serves an MCP endpoint at `http://127.0.0.1:39217/mcp` with one tool, `ask_modal`.

Register it once:

```
claude mcp add --transport http --scope user ask-modal http://127.0.0.1:39217/mcp
```

Only the first VS Code window that starts owns the port; modals appear in that window.
