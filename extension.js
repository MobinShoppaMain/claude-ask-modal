const vscode = require('vscode');
const http = require('http');

const TOOL = {
  name: 'ask_modal',
  description:
    'Ask the user one or more decision questions in a centered VS Code modal and wait for the answers. ' +
    'Use instead of plain chat text whenever the user must decide something. Put the recommended option first.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Full question text, including the context needed to decide.' },
            header: { type: 'string', description: 'Short label, e.g. "Q2 of 6 · Auth".' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Button text, 1-5 words.' },
                  description: { type: 'string', description: 'Why pick this, trade-offs.' }
                },
                required: ['label']
              }
            },
            multiSelect: { type: 'boolean', default: false }
          },
          required: ['question', 'options']
        }
      }
    },
    required: ['questions']
  }
};

const openPanels = new Set();

/** Opens the dialog tab and resolves to one answer per question (null = dismissed). */
function ask(questions) {
  return new Promise(resolve => {
    const panel = vscode.window.createWebviewPanel(
      'claudeAskModal',
      'Claude asks',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    openPanels.add(panel);
    let answers = null;
    panel.webview.onDidReceiveMessage(m => {
      answers = m.answers;
      panel.dispose();
    });
    panel.onDidDispose(() => {
      openPanels.delete(panel);
      resolve(answers || questions.map(() => null));
    });
    panel.webview.html = renderHtml(questions);
  });
}

async function callTool(args) {
  const questions = args.questions || [];
  const answers = await ask(questions);
  const lines = questions.map((q, i) =>
    `"${q.question}" = ${answers[i] === null ? '(dismissed — ask again in chat or proceed with your recommendation only if the user said so)' : `"${answers[i]}"`}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function renderHtml(questions) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const data = JSON.stringify(questions).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--vscode-editor-background) 55%, #000 45%);
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
  }
  .card {
    width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow: auto;
    background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 14px; box-shadow: 0 24px 64px rgba(0,0,0,.45); padding: 22px 24px 20px; box-sizing: border-box;
  }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .close { background: none; border: 0; color: var(--vscode-descriptionForeground); font-size: 18px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
  .close:hover { background: var(--vscode-toolbar-hoverBackground); }
  h1 { font-size: 16px; font-weight: 600; line-height: 1.45; margin: 12px 0 16px; white-space: pre-wrap; }
  .opt { display: flex; gap: 12px; align-items: flex-start; padding: 11px 13px; margin-bottom: 8px; border-radius: 10px; cursor: pointer;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #8884)); background: var(--vscode-input-background); }
  .opt:hover { border-color: var(--vscode-focusBorder); }
  .opt.sel { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder) inset; }
  .opt input { margin-top: 3px; accent-color: var(--vscode-button-background); }
  .lbl { font-weight: 600; font-size: 13px; }
  .key { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 6px; }
  .desc { font-size: 12.5px; line-height: 1.5; color: var(--vscode-descriptionForeground); margin-top: 3px; white-space: pre-wrap; }
  textarea { width: 100%; box-sizing: border-box; min-height: 64px; margin-top: 8px; resize: vertical; font: inherit; font-size: 13px;
    padding: 8px 10px; border-radius: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #8884); }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
  button.btn { font: inherit; font-size: 13px; padding: 7px 16px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
  .secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:disabled { opacity: .45; cursor: default; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-right: auto; align-self: center; }
</style></head>
<body>
<div class="card" role="dialog" aria-modal="true">
  <div class="top"><span class="chip" id="chip"></span><button class="close" id="close" title="Dismiss (Esc)">✕</button></div>
  <h1 id="q"></h1>
  <div id="opts"></div>
  <div class="actions">
    <span class="hint">1-9 pick · Enter apply · Esc dismiss</span>
    <button class="btn secondary" id="cancel">Cancel</button>
    <button class="btn primary" id="apply" disabled>Apply</button>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const qs = ${data};
  const answers = [];
  let i = 0;
  const $ = id => document.getElementById(id);
  const OTHER = '__other__';

  function render() {
    const q = qs[i];
    const multi = !!q.multiSelect;
    $('chip').textContent = (qs.length > 1 ? 'Q' + (i + 1) + ' of ' + qs.length + (q.header ? ' · ' : '') : '') + (q.header || (qs.length > 1 ? '' : 'Decision'));
    $('q').textContent = q.question;
    $('apply').textContent = i < qs.length - 1 ? 'Next' : 'Apply';
    const box = $('opts');
    box.innerHTML = '';
    [...q.options, { label: 'Other', description: 'Write your own answer.', other: true }].forEach((o, n) => {
      const row = document.createElement('label');
      row.className = 'opt';
      const inp = document.createElement('input');
      inp.type = multi ? 'checkbox' : 'radio';
      inp.name = 'o';
      inp.value = o.other ? OTHER : o.label;
      const body = document.createElement('div');
      const l = document.createElement('div');
      l.className = 'lbl';
      l.textContent = o.label;
      const k = document.createElement('span');
      k.className = 'key';
      k.textContent = n + 1;
      l.appendChild(k);
      body.appendChild(l);
      if (o.description) { const d = document.createElement('div'); d.className = 'desc'; d.textContent = o.description; body.appendChild(d); }
      if (o.other) { const t = document.createElement('textarea'); t.id = 'other'; t.placeholder = 'Your answer…'; t.hidden = true; body.appendChild(t); t.addEventListener('input', sync); }
      row.append(inp, body);
      inp.addEventListener('change', sync);
      box.appendChild(row);
    });
    sync();
  }

  function picked() { return [...document.querySelectorAll('input[name=o]')].filter(x => x.checked).map(x => x.value); }

  function sync() {
    document.querySelectorAll('.opt').forEach(r => r.classList.toggle('sel', r.querySelector('input').checked));
    const p = picked();
    const other = $('other');
    const wasHidden = other.hidden;
    other.hidden = !p.includes(OTHER);
    if (wasHidden && !other.hidden) other.focus();
    const ok = p.length > 0 && (!p.includes(OTHER) || other.value.trim());
    $('apply').disabled = !ok;
  }

  function apply() {
    if ($('apply').disabled) return;
    const vals = picked().map(v => v === OTHER ? $('other').value.trim() : v);
    answers.push(vals.join(', '));
    if (++i < qs.length) render(); else vscode.postMessage({ answers });
  }

  function dismiss() {
    while (answers.length < qs.length) answers.push(null);
    vscode.postMessage({ answers });
  }

  $('apply').onclick = apply;
  $('cancel').onclick = dismiss;
  $('close').onclick = dismiss;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') return dismiss();
    if (e.target.tagName === 'TEXTAREA') { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) apply(); return; }
    if (e.key === 'Enter') { e.preventDefault(); return apply(); }
    const n = parseInt(e.key, 10);
    const inputs = document.querySelectorAll('input[name=o]');
    if (n >= 1 && n <= inputs.length) { const x = inputs[n - 1]; x.checked = x.type === 'checkbox' ? !x.checked : true; sync(); }
  });
  render();
</script>
</body></html>`;
}

async function handleRpc(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-ask-modal', version: '0.1.0' }
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL] };
    case 'tools/call':
      if (msg.params.name !== TOOL.name) throw { code: -32602, message: `Unknown tool ${msg.params.name}` };
      return callTool(msg.params.arguments || {});
    default:
      throw { code: -32601, message: `Method not found: ${msg.method}` };
  }
}

function startServer(port, log) {
  const server = http.createServer((req, res) => {
    // Browsers always send Origin; refusing it blocks web pages from driving the modal.
    if (req.headers.origin || req.url.split('?')[0] !== '/mcp') {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      // Claude Code gave up on the call (timeout); close the dialog so a late answer isn't silently lost.
      res.on('close', () => {
        if (!res.writableEnded && msg.method === 'tools/call') openPanels.forEach(p => p.dispose());
      });
      let reply;
      try {
        reply = { jsonrpc: '2.0', id: msg.id, result: await handleRpc(msg) };
      } catch (e) {
        reply = { jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message || String(e) } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
    });
  });

  server.on('error', e => log.appendLine(`Server not started on port ${port}: ${e.message} (another VS Code window probably owns it).`));
  server.listen(port, '127.0.0.1', () => log.appendLine(`MCP endpoint: http://127.0.0.1:${port}/mcp`));
  return server;
}

function activate(context) {
  const log = vscode.window.createOutputChannel('Claude Ask Modal');
  const port = vscode.workspace.getConfiguration('claudeAskModal').get('port', 39217);
  const server = startServer(port, log);
  context.subscriptions.push(log, { dispose: () => server.close() });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAskModal.test', async () => {
      const result = await callTool({
        questions: [{
          header: 'Test',
          question: 'Does this modal read better than the chat picker?',
          options: [
            { label: 'Yes (Recommended)', description: 'Centered, full text, nothing truncated.' },
            { label: 'No', description: 'Keep the docked picker.' }
          ]
        }]
      });
      vscode.window.showInformationMessage(result.content[0].text.replace(/\n/g, ' · '));
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
