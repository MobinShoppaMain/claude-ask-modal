// Reviewer accounts (codex / claude CLIs) that second-check a recommendation. No vscode dependency, so it runs in tests.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS = [
  { id: 'fable', fullId: 'claude-fable-5-1', name: 'Fable 5.1' },
  { id: 'opus', fullId: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'sonnet', fullId: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'haiku', fullId: 'claude-haiku-5-5', name: 'Haiku 5.5' }
].map(m => ({ ...m, efforts: CLAUDE_EFFORTS, defaultEffort: 'high' }));
// `claude --effort` lists low, medium, high and max only.
const CLAUDE_CLI_EFFORT = { xhigh: 'high' };

const REVIEW_TIMEOUT_MS = 3 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 60 * 1000;
const SAFE_TOKEN = /^[\w.:\[\]-]{1,100}$/;

const expandHome = p => (p ? path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir())) : undefined);

/** Settings entries, cleaned: unknown vendors and nameless or duplicate entries are dropped. */
function normalizeEntries(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).filter(e => e && typeof e.name === 'string' && e.name.trim()
    && (e.vendor === 'codex' || e.vendor === 'claude') && !seen.has(e.name) && seen.add(e.name))
    .map(e => ({
      name: e.name,
      vendor: e.vendor,
      home: typeof e.home === 'string' && e.home.trim() ? expandHome(e.home.trim()) : undefined,
      preCheck: e.preCheck && e.preCheck.model ? { model: String(e.preCheck.model), effort: String(e.preCheck.effort || 'high') } : undefined
    }));
}

// A claude entry without a home is the calling Claude session itself; only that session can run it.
const isSession = e => e.vendor === 'claude' && !e.home;
const canLogIn = e => !isSession(e);

/** `codex debug models` output -> the models the picker lists. */
function parseCodexCatalog(text) {
  const start = String(text).indexOf('{');
  if (start < 0) throw new Error('no JSON in the model catalog');
  const catalog = JSON.parse(String(text).slice(start));
  return (catalog.models || []).filter(m => m && m.slug && m.visibility === 'list').map(m => {
    const efforts = (m.supported_reasoning_levels || []).map(l => (typeof l === 'string' ? l : l && l.effort)).filter(Boolean);
    return { id: m.slug, name: m.display_name || m.slug, efforts,
      defaultEffort: efforts.includes('high') ? 'high' : m.default_reasoning_level || efforts[0] };
  });
}

function envWith(vars) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(vars)) if (v) env[k] = v;
  return env;
}

const homeEnv = e => (e.vendor === 'codex' ? { CODEX_HOME: e.home } : { CLAUDE_CONFIG_DIR: e.home });

function pathOf(env) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  return key ? env[key] : '';
}

// cmd.exe expands % even inside quotes, and a quote would end the argument; neither is ever needed here.
function cmdQuote(arg) {
  if (/["%\r\n]/.test(arg)) throw new Error(`unsafe argument for cmd.exe: ${arg}`);
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * How to start `name` without a shell. On Windows an .exe runs directly; a .cmd/.bat shim runs through
 * `cmd.exe /d /s /c` with every argument quoted. Untrusted text never goes on the command line: it travels on stdin.
 */
function resolveCommand(name, args, env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { file: name, args, verbatim: false };
  const exts = ['.exe', '.com', '.cmd', '.bat'];
  for (const dir of pathOf(env).split(';').filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      if (!fs.existsSync(file)) continue;
      if (ext === '.exe' || ext === '.com') return { file, args, verbatim: false };
      const line = [file, ...args].map(cmdQuote).join(' ');
      return { file: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
    }
  }
  return null;
}

function killTree(child) {
  if (process.platform === 'win32') {
    cp.spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false }).on('error', () => {});
  } else {
    child.kill('SIGKILL');
  }
}

/** Runs a CLI with stdin fed and closed, so it can never wait for input. Never rejects. */
function runCli({ command, args, cwd, env = process.env, input = '', timeoutMs = REVIEW_TIMEOUT_MS }) {
  return new Promise(resolve => {
    let resolved;
    try {
      resolved = resolveCommand(command, args, env);
    } catch (e) {
      return resolve({ spawnError: e.message, stdout: '', stderr: '' });
    }
    if (!resolved) return resolve({ spawnError: `${command} not found on PATH`, stdout: '', stderr: '' });
    let child;
    try {
      child = cp.spawn(resolved.file, resolved.args, { cwd, env, shell: false, windowsHide: true,
        windowsVerbatimArguments: resolved.verbatim, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ spawnError: e.message, stdout: '', stderr: '' });
    }
    const out = [], err = [];
    let size = 0, timedOut = false, done = false;
    const collect = list => c => { if ((size += c.length) < 50e6) list.push(c); };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const finish = extra => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, ...extra });
    };
    child.on('error', e => finish({ spawnError: e.code === 'ENOENT' ? `${command} not found on PATH` : e.message }));
    child.on('close', code => finish({ code }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const lastLine = text => String(text).trim().split(/\r?\n/).filter(l => l.trim()).slice(-1)[0] || '';
const short = (text, n = 200) => (text.length > n ? text.slice(0, n - 3) + '...' : text);

/** A short, readable reason for a failed CLI run. Auth failures start with "not logged in" so the modal can offer Log in. */
function describeFailure(r, timeoutMs = REVIEW_TIMEOUT_MS) {
  if (r.spawnError) return r.spawnError;
  if (r.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  const text = `${r.stderr}\n${r.stdout}`;
  if (/not logged in|\/login|codex login|unauthori[sz]ed|\b401\b|invalid api key|authentication|auth(?:entication)? required|token (?:expired|revoked)|refresh token/i.test(text)) {
    return `not logged in (${short(lastLine(text), 120)})`;
  }
  if (/credit|quota|usage limit|insufficient|billing|\b429\b|rate.?limit/i.test(text)) return `out of credits or rate limited (${short(lastLine(text), 120)})`;
  return short(lastLine(text) || `exited with code ${r.code}`);
}

const isAuthError = text => /^not logged in/i.test(String(text || ''));

async function loadCodexModels(entry, run = runCli) {
  const r = await run({ command: 'codex', args: ['debug', 'models'], cwd: os.tmpdir(), env: envWith(homeEnv(entry)), timeoutMs: CATALOG_TIMEOUT_MS });
  if (r.spawnError || r.timedOut || r.code !== 0) return { error: describeFailure(r, CATALOG_TIMEOUT_MS) };
  try {
    const models = parseCodexCatalog(r.stdout);
    return models.length ? { models } : { error: 'no models listed for this account' };
  } catch (e) {
    return { error: `could not read the model catalog: ${e.message}` };
  }
}

/** One reviewer as the picker and review_config show it; `catalog` is the loaded codex catalog (or undefined while loading). */
function describe(entry, catalog) {
  const base = { name: entry.name, vendor: entry.vendor, home: !!entry.home, session: isSession(entry), canLogIn: canLogIn(entry) };
  if (entry.vendor === 'claude') return { ...base, models: CLAUDE_MODELS.map(({ id, name, efforts, defaultEffort }) => ({ id, name, efforts, defaultEffort })) };
  if (!catalog) return { ...base, loading: true, models: [] };
  return catalog.error ? { ...base, error: catalog.error, models: [] } : { ...base, models: catalog.models };
}

function defaultPreCheck(entries) {
  const e = entries.find(x => x.preCheck);
  return e ? { reviewer: e.name, model: e.preCheck.model, effort: e.preCheck.effort, session: isSession(e) } : null;
}

const norm = s => String(s || '').replace(/\s*\(recommended\)\s*$/i, '').trim().toLowerCase();

function buildPrompt({ question, context, options, myPick }) {
  return [
    'You are reviewing a decision another AI coding assistant is about to put to its user.',
    'Judge it independently. You may read the repository in the current directory to check the facts; do not change anything.',
    '',
    `Decision: ${question}`,
    ...(context ? ['', 'Context:', context] : []),
    '',
    'Options:',
    ...options.map(o => `- ${o.label}${o.description ? `: ${o.description}` : ''}`),
    '',
    `The assistant's pick is: ${myPick}`,
    '',
    'Reply with only this JSON object and nothing else:',
    '{ "pick": "<the exact label of the option you would choose>", "agree": <true if your pick is the assistant\'s pick>, "reason": "<at most 2 sentences>" }'
  ].join('\n');
}

function verdictSchema(labels) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['pick', 'agree', 'reason'],
    properties: { pick: { type: 'string', enum: labels }, agree: { type: 'boolean' }, reason: { type: 'string' } }
  };
}

// Every balanced {...} span, outermost first, so junk before or after the JSON does not matter.
function* jsonCandidates(text) {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, inString = false;
    for (let k = start; k < text.length; k++) {
      const c = text[k];
      if (inString) {
        if (c === '\\') k++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { yield text.slice(start, k + 1); break; }
    }
  }
}

/** The reviewer's final text -> { pick, agree, reason } with pick mapped onto an exact option label, or { error }. */
function parseVerdict(text, options, myPick) {
  for (const candidate of jsonCandidates(String(text || ''))) {
    let v;
    try { v = JSON.parse(candidate); } catch { continue; }
    if (!v || typeof v.pick !== 'string') continue;
    const option = options.find(o => norm(o.label) === norm(v.pick));
    if (!option) return { error: `picked an option that does not exist: "${short(v.pick, 60)}"` };
    const agree = norm(option.label) === norm(myPick);
    const reason = short(String(v.reason || '').trim(), 400);
    return { pick: option.label, agree, reason };
  }
  return { error: `no JSON verdict in the reply (${short(lastLine(text) || 'empty', 100)})` };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ask-modal-review-'));
}

async function runCodex(entry, a, run, timeoutMs) {
  const dir = tempDir();
  try {
    const schema = path.join(dir, 'schema.json');
    const last = path.join(dir, 'last.txt');
    fs.writeFileSync(schema, JSON.stringify(verdictSchema(a.options.map(o => o.label))));
    const args = ['exec', '-m', a.model, '-s', 'read-only', '-C', a.cwd, '--skip-git-repo-check', '--ephemeral', '--color', 'never',
      '-c', `model_reasoning_effort=${a.effort}`, '--output-schema', schema, '-o', last, '-'];
    const r = await run({ command: 'codex', args, cwd: a.cwd, env: envWith(homeEnv(entry)), input: buildPrompt(a), timeoutMs });
    const text = fs.existsSync(last) ? fs.readFileSync(last, 'utf8') : '';
    if (r.spawnError || r.timedOut || (r.code !== 0 && !text.trim())) return { error: describeFailure(r, timeoutMs) };
    if (!text.trim()) return { error: describeFailure({ ...r, stdout: r.stdout || 'no final message' }, timeoutMs) };
    return parseVerdict(text, a.options, a.myPick);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runClaude(entry, a, model, run, timeoutMs) {
  const args = ['-p', '--model', model.fullId, '--output-format', 'json', '--effort', CLAUDE_CLI_EFFORT[a.effort] || a.effort,
    '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--no-session-persistence'];
  const r = await run({ command: 'claude', args, cwd: a.cwd, env: envWith(homeEnv(entry)), input: buildPrompt(a), timeoutMs });
  if (r.spawnError || r.timedOut) return { error: describeFailure(r, timeoutMs) };
  let result;
  try {
    result = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  } catch {
    return { error: describeFailure(r, timeoutMs) };
  }
  if (result.is_error || r.code !== 0) return { error: describeFailure({ ...r, stdout: String(result.result || result.subtype || '') }, timeoutMs) };
  return parseVerdict(result.result, a.options, a.myPick);
}

/** The run_review tool: never throws, returns { pick, agree, reason, by } or { error } (plus `by` when known). */
async function runReview(entries, args, { run = runCli, timeoutMs = REVIEW_TIMEOUT_MS, catalog } = {}) {
  try {
    const a = args || {};
    const entry = entries.find(e => e.name === a.reviewer);
    if (!entry) return { error: `unknown reviewer "${a.reviewer}"; reviewers: ${entries.map(e => e.name).join(', ') || 'none'}` };
    if (isSession(entry)) {
      return { error: `"${entry.name}" is this Claude session: run it as your own subagent (Agent tool, model ${a.model || 'from review_config'}, effort ${a.effort || 'high'}), not through run_review` };
    }
    if (!SAFE_TOKEN.test(String(a.model || '')) || !/^[a-z]{1,10}$/.test(String(a.effort || ''))) return { error: 'model and effort are required (see review_config)' };
    if (!a.question || !Array.isArray(a.options) || a.options.length < 2 || !a.myPick) return { error: 'question, at least two options and myPick are required' };
    const options = a.options.filter(o => o && typeof o.label === 'string').map(o => ({ label: o.label, description: o.description }));
    if (!options.some(o => norm(o.label) === norm(a.myPick))) return { error: `myPick "${a.myPick}" is not one of the option labels` };
    if (!a.cwd || !fs.existsSync(a.cwd) || !fs.statSync(a.cwd).isDirectory()) return { error: `cwd is not a directory: ${a.cwd}` };
    const input = { ...a, options, cwd: path.resolve(a.cwd) };

    if (entry.vendor === 'claude') {
      const model = CLAUDE_MODELS.find(m => m.id === a.model || m.fullId === a.model);
      if (!model) return { error: `unknown Claude model "${a.model}"; use ${CLAUDE_MODELS.map(m => m.id).join(', ')}` };
      if (!CLAUDE_EFFORTS.includes(a.effort)) return { error: `unknown effort "${a.effort}"; use ${CLAUDE_EFFORTS.join(', ')}` };
      const by = `${model.name} · ${entry.name}`;
      return { ...(await runClaude(entry, input, model, run, timeoutMs)), by };
    }
    const models = (catalog || (await loadCodexModels(entry, run))).models || [];
    const known = models.find(m => m.id === a.model);
    const by = `${known ? known.name : a.model} · ${entry.name}`;
    return { ...(await runCodex(entry, input, run, timeoutMs)), by };
  } catch (e) {
    return { error: `review failed: ${e.message || e}` };
  }
}

module.exports = {
  CLAUDE_MODELS, CLAUDE_EFFORTS, REVIEW_TIMEOUT_MS, normalizeEntries, isSession, canLogIn, parseCodexCatalog, resolveCommand,
  runCli, describeFailure, isAuthError, loadCodexModels, describe, defaultPreCheck, buildPrompt, verdictSchema, parseVerdict, runReview, homeEnv
};
