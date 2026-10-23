const vscode = require('vscode');
const http = require('http');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const reviewers = require('./reviewers');

const MARKDOWN = 'Markdown: paragraphs, **bold**, *italic*, `code`, fenced code blocks, lists, > quotes, | tables |, ### headings, ' +
  '```mermaid diagrams (drawn), [links](https://...) and bare https URLs (open in the browser), file references like ' +
  '`src/Foo.cs:42` or [text](C:\\repo\\Foo.cs:42) (open in the editor), and ![alt](C:\\abs\\path.png) local images (png, jpg, gif, svg, webp).';

const TOOL = {
  name: 'ask_modal',
  description:
    'Ask the user one or more questions in a full-window VS Code modal and wait for the answers. ' +
    'Use instead of plain chat text whenever the user must decide something. ' +
    'Brief before you ask: start with one or more briefing screens (a question with no `options`) that explain the ' +
    'problem in depth - who raised it, the PRs or services involved as links with their titles, how they depend on ' +
    'each other (a mermaid diagram), the current code, and what each part affects. Then ask the decisions. ' +
    'Put the recommended option first and end its label with "(Recommended)". Keep `question` short; put background, ' +
    'code, tables and diagrams in `context`, and per-option diffs, impact tables and after-diagrams in `preview`. ' +
    'Every screen has a "Something\'s off" button: if the user uses it, the result says what they corrected and where; ' +
    'fix your understanding and ask again. ' +
    'Every screen also has a "Dig deeper" button: an answer of "(dig deeper)" (with an optional note on what is unclear) ' +
    'means the user is not ready to decide. Next round, brief that decision again in more depth - concrete examples, ' +
    'scenarios, the code involved, what each choice changes - answer the note, ask 1-3 sharper sub-questions, then ask ' +
    'the original decision again. Never treat it as accepting your recommendation. ' +
    'Pre-check: before every round that has decisions, call `review_config` and run its default pre-check reviewer on each ' +
    'decision question in parallel - a `session` reviewer is your own subagent (Agent tool with that model and effort, ' +
    'returning the same pick/agree/reason JSON), any other reviewer goes through `run_review`. Pass the verdicts as ' +
    '`reviews`; never skip this because it is slow; on failure pass `{ by, error }`. An answer ' +
    '"(check again: <reviewer> <model> <effort>)" is not a decision: run that reviewer on that question, then ask it ' +
    'again with all verdicts so far in `reviews`. ' +
    'Precedent: before recommending, search the default branch (e.g. `git grep <pattern> origin/master --`, ' +
    '`git show origin/master:<path>`) of the current repo and any added working directories for an existing helper, ' +
    'pattern or convention that already solves the decision. If one exists, the recommended option reuses or follows it; ' +
    'cite it in `precedent` with file:line links. If none exists, set `precedent` to "Nothing in <branch>" so the user ' +
    'sees it was checked. Give the reviewer your precedent finding too. ' + MARKDOWN,
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'Short topic label, e.g. "Auth". The modal adds "Q2 of 6" itself.' },
            question: { type: 'string', description: 'The decision itself, one or two sentences. Markdown inline only.' },
            context: { type: 'string', description: 'Optional background the user needs to decide: facts, code, tables. ' + MARKDOWN },
            options: {
              type: 'array',
              description: 'Two to four choices. Leave out (or empty) for a briefing screen the user only reads.',
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Button text, 1-5 words. Append "(Recommended)" to the recommended one.' },
                  description: { type: 'string', description: 'Why pick this, trade-offs. ' + MARKDOWN },
                  preview: { type: 'string', description: 'Optional code, diff or mockup shown beside the options when this one is focused. ' + MARKDOWN }
                },
                required: ['label']
              }
            },
            multiSelect: { type: 'boolean', default: false },
            precedent: { type: 'string', description: 'What the default branch already does for this decision (file:line links), or "Nothing in <branch>". Shown as an "Already in <branch>" box. ' + MARKDOWN },
            reviews: {
              type: 'array',
              description: 'Reviewer verdicts on this decision, from the pre-check and any Check again: { by, pick, agree, reason } or { by, error }.',
              items: {
                type: 'object',
                properties: {
                  by: { type: 'string', description: 'As returned by run_review, e.g. "Fable 5.1 · session".' },
                  pick: { type: 'string', description: 'Exact label of the option the reviewer picked.' },
                  agree: { type: 'boolean' },
                  reason: { type: 'string' },
                  error: { type: 'string' }
                },
                required: ['by']
              }
            }
          },
          required: ['question']
        }
      }
    },
    required: ['questions']
  }
};

const REVIEW_CONFIG_TOOL = {
  name: 'review_config',
  description: 'Lists the reviewer accounts that second-check recommendations (claudeAskModal.reviewers setting), their ' +
    'models and efforts, and the default pre-check reviewer. A reviewer with `session: true` is this Claude session: ' +
    'run it yourself as a subagent with that model and effort.',
  inputSchema: { type: 'object', properties: {} }
};

const RUN_REVIEW_TOOL = {
  name: 'run_review',
  description: 'Has a reviewer CLI (codex, or claude with its own config dir) judge one decision read-only in `cwd`, killed ' +
    'after 3 minutes. Returns JSON { pick, agree, reason, by } or { error, by }. Pass the result into ask_modal `reviews`.',
  inputSchema: {
    type: 'object',
    properties: {
      reviewer: { type: 'string', description: 'Reviewer name from review_config.' },
      model: { type: 'string', description: 'Model id from review_config.' },
      effort: { type: 'string', description: "One of the model's efforts." },
      cwd: { type: 'string', description: 'Absolute path of the repository the decision is about.' },
      question: { type: 'string' },
      context: { type: 'string' },
      options: {
        type: 'array',
        items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] }
      },
      myPick: { type: 'string', description: 'Label of the option you recommend.' },
      precedent: { type: 'string', description: 'What you found already in the default branch for this decision.' }
    },
    required: ['reviewer', 'model', 'effort', 'cwd', 'question', 'options', 'myPick']
  }
};

// Read on every call, so settings edits apply without a reload.
const reviewerEntries = () => reviewers.normalizeEntries(vscode.workspace.getConfiguration('claudeAskModal').get('reviewers'));

function codexCatalog(entry, cache) {
  const key = entry.home || '';
  if (!cache.has(key)) cache.set(key, reviewers.loadCodexModels(entry));
  return cache.get(key);
}

async function reviewConfig() {
  const entries = reviewerEntries();
  const cache = new Map();
  const list = await Promise.all(entries.map(async e =>
    reviewers.describe(e, e.vendor === 'codex' ? await codexCatalog(e, cache) : undefined)));
  return { reviewers: list, defaultPreCheck: reviewers.defaultPreCheck(entries) };
}

/** Opens a terminal with the account's config dir set and starts its login. */
function logIn(name) {
  const entry = reviewerEntries().find(e => e.name === name);
  if (!entry || !reviewers.canLogIn(entry)) {
    vscode.window.showWarningMessage(`Claude Ask Modal: no reviewer account "${name}" to log in to.`);
    return;
  }
  const terminal = vscode.window.createTerminal({ name: `Log in: ${entry.name}`, env: reviewers.homeEnv(entry) });
  terminal.show();
  terminal.sendText(entry.vendor === 'codex' ? 'codex login' : 'claude');
  if (entry.vendor === 'claude') vscode.window.showInformationMessage(`Claude is starting in the terminal for "${entry.name}"; type /login there.`);
}

async function pickLogIn() {
  const items = reviewerEntries().filter(reviewers.canLogIn)
    .map(e => ({ label: e.name, description: `${e.vendor} · ${e.home || 'default login'}` }));
  if (!items.length) return vscode.window.showInformationMessage('Claude Ask Modal: no reviewer accounts to log in to (see claudeAskModal.reviewers).');
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Reviewer account to log in to' });
  if (pick) logIn(pick.label);
}

const openPanels = new Set();
let extensionUri;
let log;

const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

/** Local image files the questions reference by absolute path; only these become loadable. */
function referencedImages(questions) {
  const text = JSON.stringify(questions);
  const found = new Map();
  for (const [, raw] of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    let ref, file;
    try {
      ref = JSON.parse(`"${raw}"`);
      file = decodeURI(ref.replace(/^file:\/\/\/?/i, ''));
    } catch {
      continue;
    }
    if (path.isAbsolute(file) && IMAGE_TYPES.has(path.extname(file).toLowerCase()) && fs.existsSync(file)) {
      found.set(ref, vscode.Uri.file(file));
    }
  }
  return found;
}

/**
 * Opens the dialog tab. Resolves to { answers } with one entry per question (null = dismissed), or to
 * { offTrack: { at, text, answers } } when the user stopped to correct the briefing.
 */
function ask(questions) {
  return new Promise(resolve => {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    const images = referencedImages(questions);
    const imageDirs = [...new Set([...images.values()].map(u => path.dirname(u.fsPath)))].map(d => vscode.Uri.file(d));
    const panel = vscode.window.createWebviewPanel(
      'claudeAskModal',
      'Claude asks',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media, ...imageDirs] }
    );
    openPanels.add(panel);
    let result = null;
    // The picker fills in as each codex catalog arrives; the page asks for the snapshot once it is listening.
    const entries = reviewerEntries();
    const snapshot = entries.map(e => reviewers.describe(e));
    let ready = false;
    const sendReviewers = () => ready && panel.webview.postMessage({ type: 'reviewers', reviewers: snapshot,
      defaultPreCheck: reviewers.defaultPreCheck(entries) });
    if (questions.some(q => q.options && q.options.length)) {
      const cache = new Map();
      entries.forEach((e, n) => {
        if (e.vendor === 'codex') codexCatalog(e, cache).then(c => { snapshot[n] = reviewers.describe(e, c); sendReviewers(); });
      });
    }
    panel.webview.onDidReceiveMessage(m => {
      if (m.type === 'open') return openLink(m.href);
      if (m.type === 'ready') { ready = true; return sendReviewers(); }
      if (m.type === 'login') return logIn(m.reviewer);
      result = m.type === 'offtrack' ? { offTrack: m } : { answers: m.answers };
      panel.dispose();
    });
    panel.onDidDispose(() => {
      openPanels.delete(panel);
      resolve(result || { answers: questions.map(() => null) });
    });
    const imageUris = Object.fromEntries([...images].map(([ref, uri]) => [ref, panel.webview.asWebviewUri(uri).toString()]));
    panel.webview.html = renderHtml(panel.webview, media, questions, imageUris);
  });
}

// `C:\repo\Foo.cs:42`, `src/Foo.cs:10-20`, `Foo.cs#L10-L20`, `file:///C:/repo/Foo.cs`.
function parseFileRef(href) {
  let ref = href.replace(/^file:\/\/\/?/i, '');
  try { ref = decodeURI(ref); } catch { /* keep it as written */ }
  const m = /^(.*?)(?::(\d+)(?:-\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(ref);
  return { file: m[1], line: Number(m[2] || m[3] || 0) };
}

async function resolveFile(file) {
  if (path.isAbsolute(file)) return fs.existsSync(file) ? [vscode.Uri.file(file)] : [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const candidate = path.join(folder.uri.fsPath, file);
    if (fs.existsSync(candidate)) return [vscode.Uri.file(candidate)];
  }
  // A bare name like `PrintFanoutExecutor.cs`: search the workspace for it.
  const glob = `**/${file.replace(/\\/g, '/').replace(/^\.?\//, '')}`;
  return vscode.workspace.findFiles(glob, '**/{node_modules,bin,obj,.git}/**', 20);
}

/** Web links go to the browser (VS Code asks first for untrusted domains); file references open beside the modal. */
async function openLink(href) {
  const target = String(href || '').trim();
  if (/^https?:\/\//i.test(target)) return vscode.env.openExternal(vscode.Uri.parse(target, true));
  // Any other scheme (command:, javascript:, vscode://...) is ignored; only files remain.
  if (/^(?!file:)[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(javascript|data|vbscript|command|vscode):/i.test(target)) return;

  const { file, line } = parseFileRef(target);
  const matches = await resolveFile(file);
  let uri = matches[0];
  if (matches.length > 1) {
    const pick = await vscode.window.showQuickPick(matches.map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
      { placeHolder: `Several files match ${file}` });
    uri = pick && pick.uri;
  }
  if (!uri) {
    if (matches.length === 0) vscode.window.showWarningMessage(`Claude Ask Modal: no file found for ${file}`);
    return;
  }
  const at = new vscode.Position(Math.max(line - 1, 0), 0);
  await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(at, at) });
}

function questionLabel(q, i) {
  const firstLine = String(q.question || '').split('\n')[0];
  return `Q${i + 1}${q.header ? ` (${q.header})` : ''}: ${firstLine.length > 140 ? firstLine.slice(0, 137) + '...' : firstLine}`;
}

// Review tools always answer with text, never an RPC error, so a round can go on without a verdict.
async function callReviewTool(name, args) {
  let value;
  try {
    value = name === REVIEW_CONFIG_TOOL.name ? await reviewConfig() : await reviewers.runReview(reviewerEntries(), args);
  } catch (e) {
    value = { error: e.message || String(e) };
  }
  if (log && name === RUN_REVIEW_TOOL.name) {
    log.appendLine(`run_review ${args.reviewer} ${args.model} ${args.effort}: ${value.error ? `failed, ${value.error}` : value.pick}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function callTool(args) {
  const questions = args.questions || [];
  const result = await ask(questions);
  if (result.offTrack) {
    const { at, text, answers } = result.offTrack;
    const before = questions.slice(0, at).map((q, i) => `${questionLabel(q, i)}\n  = ${answers[i] === null ? '(not answered)' : `"${answers[i]}"`}`);
    return { content: [{ type: 'text', text: [
      `The user stopped at ${questionLabel(questions[at], at)}`,
      `Something's off: "${text}"`,
      'Nothing after that was answered. Fix your understanding, then brief and ask again.',
      ...(before.length ? ['', 'Answered before stopping:', ...before] : [])
    ].join('\n') }] };
  }
  const lines = questions.map((q, i) => `${questionLabel(q, i)}\n  = ${result.answers[i] === null
    ? '(dismissed - ask again or proceed with your recommendation only if the user said so)'
    : `"${result.answers[i]}"`}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// The page only loads its own files; the questions travel as inert JSON. Inline styles are allowed only
// because mermaid styles the SVG it draws; scripts stay limited to the extension's own files.
function renderHtml(webview, media, questions, imageUris) {
  const src = name => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const data = json(questions);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${src('modal.css')}">
</head>
<body>
<script type="application/json" id="questions">${data}</script>
<script type="application/json" id="images">${json(imageUris)}</script>
<div class="card" role="dialog" aria-modal="true" aria-labelledby="q">
  <header class="top">
    <div class="crumbs"><span class="chip" id="chip"></span><ol class="steps" id="steps"></ol></div>
    <button class="icon" id="close" title="Dismiss (Esc)" aria-label="Dismiss">&#x2715;</button>
  </header>
  <main class="body" id="body">
    <section class="prompt" id="prompt">
      <h1 id="q"></h1>
      <div class="md context" id="context"></div>
    </section>
    <section class="choices" id="choices">
      <div id="verdicts"></div>
      <div class="label-row"><span class="section-label" id="pick-label"></span></div>
      <div id="opts" role="radiogroup"></div>
      <details class="note" id="note-box"><summary>Add a note</summary><textarea id="note" placeholder="Anything to add to this answer"></textarea></details>
    </section>
    <aside class="preview" id="preview">
      <div class="section-label" id="preview-label"></div>
      <div class="md" id="pv"></div>
    </aside>
    <section class="review" id="review" hidden></section>
  </main>
  <section class="offtrack" id="offtrack" hidden>
    <label class="section-label" for="off-text">Something's off? Tell Claude what it got wrong</label>
    <textarea id="off-text" placeholder="What is wrong or missing in this explanation"></textarea>
    <div class="offtrack-actions">
      <button class="btn secondary" id="off-cancel">Keep going</button>
      <button class="btn primary" id="off-send">Send to Claude (Ctrl+Enter)</button>
    </div>
  </section>
  <section class="offtrack" id="dig" hidden>
    <label class="section-label" for="dig-text">Dig deeper: what should Claude explain or probe? (optional)</label>
    <textarea id="dig-text" placeholder="What is unclear, or what you want to understand before deciding"></textarea>
    <div class="offtrack-actions">
      <button class="btn secondary" id="dig-cancel">Keep going</button>
      <button class="btn primary" id="dig-send">Dig deeper (Ctrl+Enter)</button>
    </div>
  </section>
  <footer class="actions">
    <span class="hint" id="hint"></span>
    <button class="btn ghost" id="off">Something's off</button>
    <button class="btn ghost" id="dig-open">Dig deeper</button>
    <span class="check" id="check-box">
      <a href="#" class="login-link" id="rv-login" hidden></a>
      <select id="rv-model" title="Reviewer · model" aria-label="Reviewer and model"></select>
      <select id="rv-effort" title="Effort" aria-label="Effort"></select>
      <button class="btn ghost" id="check">Check again</button>
    </span>
    <button class="btn secondary" id="back">Back</button>
    <button class="btn secondary" id="cancel">Cancel</button>
    <button class="btn primary" id="apply" disabled>Next</button>
  </footer>
</div>
<script src="${src('mermaid.min.js')}"></script>
<script src="${src('markdown.js')}"></script>
<script src="${src('modal.js')}"></script>
</body></html>`;
}

async function handleRpc(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-ask-modal', version: '0.6.1' }
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: [TOOL, REVIEW_CONFIG_TOOL, RUN_REVIEW_TOOL] };
    case 'tools/call':
      if (msg.params.name === REVIEW_CONFIG_TOOL.name || msg.params.name === RUN_REVIEW_TOOL.name) {
        return callReviewTool(msg.params.name, msg.params.arguments || {});
      }
      if (msg.params.name !== TOOL.name) throw { code: -32602, message: `Unknown tool ${msg.params.name}` };
      return callTool(msg.params.arguments || {});
    default:
      throw { code: -32601, message: `Method not found: ${msg.method}` };
  }
}

const HEARTBEAT_MS = Number(process.env.CLAUDE_ASK_MODAL_HEARTBEAT_MS) || 30000;

/**
 * Claude Code aborts a tool call after 300 s with no response or progress. While the user thinks, answer as an
 * event stream and send a progress notification every 30 s (a comment line when the client sent no progress token).
 */
function heartbeat(res, msg) {
  const token = msg.params && msg.params._meta && msg.params._meta.progressToken;
  if (log) log.appendLine(`tools/call streaming; progress token ${token === undefined ? 'absent, sending keep-alive comments' : 'present'}.`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let beats = 0;
  const timer = setInterval(() => {
    beats++;
    if (token === undefined) {
      res.write(': waiting for the user\n\n');
      return;
    }
    const note = { jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken: token, progress: beats, message: `Waiting for the user (${beats * HEARTBEAT_MS / 1000}s)` } };
    res.write(`event: message\ndata: ${JSON.stringify(note)}\n\n`);
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

function createServer() {
  return http.createServer((req, res) => {
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
      const stream = msg.method === 'tools/call' && /text\/event-stream/.test(req.headers.accept || '');
      if (msg.method === 'tools/call' && log) {
        log.appendLine(`tools/call: Accept "${req.headers.accept || ''}", _meta ${JSON.stringify((msg.params && msg.params._meta) || null)}`);
      }
      const stopHeartbeat = stream ? heartbeat(res, msg) : () => {};
      let reply;
      try {
        reply = { jsonrpc: '2.0', id: msg.id, result: await handleRpc(msg) };
      } catch (e) {
        reply = { jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message || String(e) } };
      }
      stopHeartbeat();
      if (res.destroyed) return;
      if (stream) res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
}

/** Resolves to the listening server, or null when the port is taken. */
function listen(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Stable per workspace, so a Claude session started before a window reload still reaches this window.
function workspacePort(folderPath) {
  let h = 0;
  for (const c of folderPath.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 40000 + (h % 10000);
}

function run(command, cwd) {
  return new Promise(resolve => cp.exec(command, { cwd, windowsHide: true }, (err, stdout, stderr) =>
    resolve({ ok: !err, output: (stderr || stdout || (err && err.message) || '').trim() })));
}

// Local scope wins over the user-scope entry, so Claude sessions in this folder reach this window's server.
async function register(folderPath, url, log) {
  const current = await run('claude mcp get ask-modal', folderPath);
  if (/Scope: Local/i.test(current.output) && current.output.includes(`URL: ${url}`)) {
    log.appendLine(`Already registered ${url} for ${folderPath}.`);
    return;
  }
  await run('claude mcp remove --scope local ask-modal', folderPath);
  const added = await run(`claude mcp add --transport http --scope local ask-modal ${url}`, folderPath);
  log.appendLine(added.ok
    ? `Registered ${url} for ${folderPath}; new Claude sessions there use this window.`
    : `Could not register ${url} for ${folderPath}: ${added.output}`);
}

async function activate(context) {
  extensionUri = context.extensionUri;
  log = vscode.window.createOutputChannel('Claude Ask Modal');
  context.subscriptions.push(log);
  const keep = server => server && context.subscriptions.push({ dispose: () => server.close() });

  const configured = vscode.workspace.getConfiguration('claudeAskModal').inspect('port');
  const fixedPort = configured.workspaceFolderValue ?? configured.workspaceValue;
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);

  if (folders.length > 0) {
    const first = fixedPort ?? workspacePort(folders[0]);
    let server = null;
    let port = first;
    for (; !server && port < first + 10; port++) server = await listen(port);
    if (!server) {
      log.appendLine(`No free port in ${first}-${first + 9}; this window serves no modals.`);
    } else {
      keep(server);
      const url = `http://127.0.0.1:${port - 1}/mcp`;
      log.appendLine(`MCP endpoint: ${url}`);
      // Not awaited: `claude mcp get` health-checks every server, and activation should not wait on it.
      folders.reduce((p, f) => p.then(() => register(f, url, log)), Promise.resolve());
    }
  }

  // Fallback for sessions with no local registration (no folder open, or registration failed); first window wins.
  const fallbackPort = configured.globalValue ?? configured.defaultValue;
  const fallback = await listen(fallbackPort);
  keep(fallback);
  log.appendLine(fallback
    ? `Fallback endpoint: http://127.0.0.1:${fallbackPort}/mcp`
    : `Fallback port ${fallbackPort} is owned by another window.`);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAskModal.test', async () => {
      const result = await callTool({ questions: SAMPLE });
      vscode.window.showInformationMessage(result.content[0].text.replace(/\n/g, ' | '));
    }),
    vscode.commands.registerCommand('claudeAskModal.logIn', pickLogIn)
  );
}

// Exercises every layout: briefing with a diagram and links, plain, context with code and a table, previews, multi-select.
const SAMPLE = [
  {
    header: 'Briefing',
    question: 'Two settings must name the same blob container, and nothing checks that they do',
    context: [
      'Raised on [PR !5636](https://dev.azure.com/shoppaab/Shoppa/_git/Shoppa/pullrequest/5636). ' +
        'PrintService rebuilds the PDF URL in `PrintFanoutExecutor.cs:240`.',
      '```mermaid',
      'flowchart LR',
      '  DA[DrawingAgent !5636] -- blobName --> PS[PrintService !5654]',
      '  PS -- URL --> PE[PrintEngine]',
      '  DA -. SAS URL .-> C[(lunapdfs)]',
      '  PS -. base URL .-> C',
      '```',
      '',
      '| PR | Repo | Merge order |',
      '|---|---|---|',
      '| !5636 DrawingAgent | Shoppa | 1 |',
      '| !5654 PrintService | Omnishop | 2 |'
    ].join('\n')
  },
  {
    header: 'Layout',
    question: 'Does this modal read better than the chat picker?',
    options: [
      { label: 'Yes (Recommended)', description: 'Full window, full text, nothing truncated.' },
      { label: 'No', description: 'Keep the docked picker.' }
    ],
    reviews: [
      { by: 'Fable 5.1 · session', pick: 'Yes (Recommended)', agree: true, reason: 'Nothing is truncated.' },
      { by: 'GPT-5.5 · shoppa', error: 'not logged in (run codex login)' }
    ]
  },
  {
    header: 'Retry policy',
    question: 'How should a failed **payload download** be retried?',
    context: 'Today a download failure fails the job at once:\n\n```csharp\ncatch (Exception ex)\n{\n    await FailRegistrationAsync(message, payloadPath, ex, ct);\n}\n```\n\n| Cause | Share | Transient |\n|---|---|---|\n| Timeout | 61% | yes |\n| 403 expired SAS | 30% | no |\n| 404 | 9% | no |\n\n> Most failures are timeouts, which a retry would fix.',
    options: [
      { label: 'Retry timeouts (Recommended)', description: 'Retry `TimeoutException` 3 times with backoff; fail the rest.', preview: '```csharp\ncatch (TimeoutException) when (attempt < 3)\n{\n    await Task.Delay(Backoff(attempt), ct);\n}\n```' },
      { label: 'Retry everything', description: 'Simple, but a **403** retries pointlessly.', preview: '```csharp\ncatch (Exception) when (attempt < 3) { ... }\n```' },
      { label: 'Keep failing fast', description: 'No change.' }
    ],
    reviews: [
      { by: 'Fable 5.1 · session', pick: 'Retry timeouts (Recommended)', agree: true, reason: 'Timeouts are the only transient cause in the table.' },
      { by: 'GPT-5.5 · shoppa', pick: 'Retry everything', agree: false, reason: 'The 403 share comes from clock skew, which a retry also fixes.' }
    ]
  },
  {
    header: 'Scope',
    question: 'Which areas should the follow-up cover?',
    multiSelect: true,
    options: [
      { label: 'Agent', description: 'printengine service.' },
      { label: 'Server', description: 'PrintService.' },
      { label: 'Installer', description: 'MSI and bootstrapper.' }
    ]
  }
];

function deactivate() {}

module.exports = { activate, deactivate };
