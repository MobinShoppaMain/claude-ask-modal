(function () {
  const vscode = acquireVsCodeApi();
  const qs = JSON.parse(document.getElementById('questions').textContent);
  window.mdImages = JSON.parse(document.getElementById('images').textContent);
  const $ = id => document.getElementById(id);
  // A question without options is a briefing screen: read it, then Continue.
  const isInfo = q => !q.options || q.options.length === 0;

  const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  let diagramSeq = 0;

  async function drawDiagrams() {
    if (!window.mermaid) return;
    for (const box of document.querySelectorAll('.mermaid-box:not([data-drawn])')) {
      box.dataset.drawn = '1';
      try {
        const { svg } = await window.mermaid.render(`mmd-${++diagramSeq}`, box.dataset.src);
        box.innerHTML = svg;
        box.classList.add('drawn');
      } catch (e) {
        box.insertAdjacentHTML('beforeend', `<div class="diagram-error">Diagram failed: ${md.esc(e.message || e)}</div>`);
      }
    }
  }

  document.addEventListener('click', e => {
    const login = e.target.closest('a[data-login]');
    if (login) {
      e.preventDefault();
      return vscode.postMessage({ type: 'login', reviewer: login.dataset.login });
    }
    const a = e.target.closest('a[data-href]');
    if (!a) return;
    e.preventDefault();
    vscode.postMessage({ type: 'open', href: a.dataset.href });
  });
  const OTHER = '__other__';
  const RECOMMENDED = /\s*\(recommended\)\s*$/i;
  const COUNTER = /^Q\d+ of \d+\s*[·:-]?\s*/;
  const sameLabel = (a, b) => String(a || '').replace(RECOMMENDED, '').trim().toLowerCase() === String(b || '').replace(RECOMMENDED, '').trim().toLowerCase();

  // Reviewer accounts for Check again; the extension sends them, codex catalogs arrive later.
  let rv = { reviewers: [], defaultPreCheck: null };
  let lastCheck = null;
  const verdicts = q => (q.reviews || []).filter(r => r && r.by);
  const byShort = by => String(by).split(' · ')[0];
  const byAccount = by => String(by).split(' · ').slice(-1)[0];
  const isAuthError = text => /not logged in|log ?in|unauthori[sz]ed|\b401\b|authenticat/i.test(String(text || ''));
  const loginLink = name => `<a href="#" class="login-link" data-login="${md.esc(name)}">Log in to ${md.esc(name)}</a>`;

  // One entry per question, so Back restores what was picked.
  const state = qs.map(() => ({ picked: [], other: '', note: '', dig: null, check: null }));
  const hasReview = qs.filter(q => !isInfo(q)).length > 1;
  let i = 0;
  let focusedPreview = null;

  function steps() {
    const total = qs.length + (hasReview ? 1 : 0);
    const box = $('steps');
    box.innerHTML = '';
    if (total < 2) return;
    for (let n = 0; n < total; n++) {
      const li = document.createElement('li');
      li.className = n === i ? 'on' : n < i ? 'done' : '';
      li.title = n < qs.length ? `Question ${n + 1}` : 'Review';
      box.appendChild(li);
    }
  }

  function chip(q) {
    const topic = (q.header || '').replace(COUNTER, '');
    const counter = qs.length > 1 ? `Question ${i + 1} of ${qs.length}` : '';
    return [counter, topic].filter(Boolean).join(' · ') || 'Decision';
  }

  function layout(q) {
    const hasContext = !!(q.context && q.context.trim());
    const hasPreview = !isInfo(q) && q.options.some(o => o.preview && o.preview.trim());
    $('body').className = 'body ' + (isInfo(q) ? 'simple' : hasPreview ? 'with-preview' : hasContext ? 'with-context' : 'simple');
    $('choices').hidden = isInfo(q);
    $('context').hidden = !hasContext;
    $('preview').hidden = !hasPreview;
  }

  function option(o, n, q, s) {
    const multi = !!q.multiSelect;
    const value = o.other ? OTHER : o.label;
    const row = document.createElement('label');
    row.className = 'opt';
    row.dataset.index = n;

    const inp = document.createElement('input');
    inp.type = multi ? 'checkbox' : 'radio';
    inp.name = 'o';
    inp.value = value;
    inp.checked = s.picked.includes(value);

    const key = document.createElement('kbd');
    key.textContent = n + 1;

    const body = document.createElement('div');
    body.className = 'opt-body';
    const title = document.createElement('div');
    title.className = 'lbl';
    const recommended = !o.other && RECOMMENDED.test(o.label);
    // Claude's pick and every reviewer that picked the same option share one badge.
    const pickers = o.other ? [] : verdicts(q).filter(r => !r.error && sameLabel(r.pick, o.label)).map(r => `${byShort(r.by)} ✓`);
    const badge = recommended ? ['Recommended', 'Claude ✓', ...pickers] : pickers;
    title.innerHTML = md.inline(o.label.replace(RECOMMENDED, ''))
      + (badge.length ? ` <span class="badge${recommended ? '' : ' reviewer'}">${md.esc(badge.join(' · '))}</span>` : '')
      + (o.preview ? ' <span class="badge subtle">Preview</span>' : '');
    body.appendChild(title);

    if (o.description) {
      const d = document.createElement('div');
      d.className = 'md desc';
      d.innerHTML = md.block(o.description);
      body.appendChild(d);
    }
    if (o.other) {
      const t = document.createElement('textarea');
      t.id = 'other';
      t.placeholder = 'Your answer';
      t.value = s.other;
      t.hidden = !inp.checked;
      t.addEventListener('input', sync);
      body.appendChild(t);
    }

    row.append(inp, key, body);
    inp.addEventListener('change', sync);
    const show = () => showPreview(q, o);
    row.addEventListener('mouseenter', show);
    inp.addEventListener('focus', show);
    return row;
  }

  function showPreview(q, o) {
    if ($('preview').hidden) return;
    const target = o && o.preview ? o : q.options.find(x => x.preview);
    if (!target || target === focusedPreview) return;
    focusedPreview = target;
    $('preview-label').textContent = `Preview · ${target.label.replace(RECOMMENDED, '')}`;
    $('pv').innerHTML = md.block(target.preview);
    drawDiagrams();
    document.querySelectorAll('.opt').forEach(r => r.classList.toggle('previewing', q.options[r.dataset.index] === target));
  }

  function loginAllowed(name) {
    const r = rv.reviewers.find(x => x.name === name);
    return r ? r.canLogIn : rv.reviewers.length === 0;
  }

  // Failed reviews as banners, disagreeing ones as a "Reviewer says" box above the options.
  function renderVerdicts(q) {
    const list = isInfo(q) ? [] : verdicts(q);
    const failed = list.filter(r => r.error).map(r => `<div class="verdict failed">Review failed (${md.esc(r.by)}): ${md.esc(r.error)}`
      + (isAuthError(r.error) && loginAllowed(byAccount(r.by)) ? ` ${loginLink(byAccount(r.by))}` : '') + '</div>');
    const against = list.filter(r => !r.error && r.agree === false);
    const says = against.length ? [`<div class="verdict disagree"><div class="section-label">Reviewer says</div>`
      + against.map(r => `<p><strong>${md.esc(r.by)}</strong> picks <em>${md.esc(String(r.pick || '').replace(RECOMMENDED, ''))}</em>: `
        + `${md.inline(r.reason || '')}</p>`).join('') + '</div>'] : [];
    const prior = !isInfo(q) && q.precedent && q.precedent.trim()
      ? [`<div class="verdict precedent"><div class="section-label">Already in the default branch</div>${md.block(q.precedent)}</div>`] : [];
    $('verdicts').innerHTML = [...prior, ...failed, ...says].join('');
  }

  const selectedReviewer = () => {
    const [ri, mi] = ($('rv-model').value || '').split('|');
    const r = rv.reviewers[ri];
    return { r, m: r && mi !== '' ? r.models[mi] : undefined };
  };

  function fillEfforts() {
    const { r, m } = selectedReviewer();
    const box = $('rv-effort');
    box.innerHTML = '';
    const efforts = (m && m.efforts) || [];
    const keep = lastCheck && efforts.includes(lastCheck.effort) ? lastCheck.effort
      : efforts.includes('high') ? 'high' : (m && m.defaultEffort) || efforts[0];
    efforts.forEach(e => box.add(new Option(e, e, false, e === keep)));
    box.disabled = !efforts.length;
    $('check').disabled = !m || !efforts.length;
    const login = $('rv-login');
    login.hidden = !(r && r.canLogIn);
    if (r) {
      login.dataset.login = r.name;
      login.textContent = `Log in to ${r.name}`;
      login.title = r.error || `Open a terminal to log in to ${r.name}`;
    }
  }

  // Grouped by reviewer account; keeps the last choice, else the default pre-check reviewer.
  function fillCheck() {
    const box = $('rv-model');
    const want = lastCheck || (rv.defaultPreCheck && { reviewer: rv.defaultPreCheck.reviewer, model: rv.defaultPreCheck.model });
    box.innerHTML = '';
    let chosen = '';
    rv.reviewers.forEach((r, ri) => {
      const group = document.createElement('optgroup');
      group.label = `${r.name} (${r.vendor})`;
      if (r.loading) group.appendChild(new Option('loading…', '', false, false)).disabled = true;
      else if (r.error) group.appendChild(new Option(`unavailable: ${r.error.slice(0, 80)}`, `${ri}|`));
      r.models.forEach((m, mi) => {
        group.appendChild(new Option(`${m.name} · ${r.name}`, `${ri}|${mi}`));
        if (!chosen && want && want.reviewer === r.name && want.model === m.id) chosen = `${ri}|${mi}`;
      });
      box.appendChild(group);
    });
    if (!chosen) {
      const first = [...box.options].find(o => !o.disabled && o.value && !o.value.endsWith('|'));
      chosen = first ? first.value : '';
    }
    box.value = chosen;
    box.disabled = !rv.reviewers.length;
    fillEfforts();
  }

  function rememberCheck() {
    const { r, m } = selectedReviewer();
    if (r && m) lastCheck = { reviewer: r.name, model: m.id, effort: $('rv-effort').value };
  }

  function render() {
    if (i === qs.length) return renderReview();
    const q = qs[i];
    const s = state[i];
    $('review').hidden = true;
    $('check-box').hidden = isInfo(q);
    renderVerdicts(q);
    $('prompt').hidden = $('choices').hidden = false;
    closeOffTrack();
    closeDig();
    steps();
    layout(q);
    $('chip').textContent = chip(q);
    $('q').innerHTML = md.inline(q.question);
    $('context').innerHTML = q.context ? md.block(q.context) : '';
    $('pick-label').textContent = q.multiSelect ? 'Pick one or more' : 'Pick one';
    $('note').value = s.note;
    $('note-box').open = !!s.note;

    const box = $('opts');
    box.innerHTML = '';
    $('back').hidden = i === 0;
    $('dig-open').hidden = false;
    focusedPreview = null;
    drawDiagrams();

    if (isInfo(q)) {
      $('apply').textContent = i < qs.length - 1 ? 'Continue' : hasReview ? 'Review' : 'Done';
      $('apply').disabled = false;
      $('hint').textContent = "Enter continue · Something's off to correct me · Dig deeper to ask for more · Esc dismiss";
      $('body').scrollTop = 0;
      return;
    }

    box.setAttribute('role', q.multiSelect ? 'group' : 'radiogroup');
    [...q.options, { label: 'Other', description: 'Write your own answer.', other: true }]
      .forEach((o, n) => box.appendChild(option(o, n, q, s)));

    showPreview(q, q.options.find(o => s.picked.includes(o.label) && o.preview));
    $('apply').textContent = i < qs.length - 1 ? 'Next' : hasReview ? 'Review' : 'Submit';
    $('hint').textContent = `1–${q.options.length + 1} pick · ↑↓ move · Enter ${i < qs.length - 1 ? 'next' : 'continue'} · Esc dismiss`;
    sync();
    $('body').scrollTop = 0;
    $('prompt').scrollTop = 0;
  }

  function answerText(n) {
    const s = state[n];
    if (s.check) return s.check;
    if (s.dig !== null) return s.dig ? `(dig deeper) note: ${s.dig}` : '(dig deeper)';
    if (isInfo(qs[n])) return '(read)';
    const picked = s.picked.map(v => (v === OTHER ? s.other.trim() : v)).join(', ');
    return s.note.trim() ? `${picked} (note: ${s.note.trim()})` : picked;
  }

  function renderReview() {
    steps();
    closeOffTrack();
    closeDig();
    $('dig-open').hidden = true;
    $('check-box').hidden = true;
    $('chip').textContent = 'Review your answers';
    $('body').className = 'body simple';
    $('prompt').hidden = $('choices').hidden = $('preview').hidden = true;
    const box = $('review');
    box.hidden = false;
    box.innerHTML = '';
    qs.forEach((q, n) => {
      if (isInfo(q) && state[n].dig === null) return;
      const item = document.createElement('button');
      item.className = 'review-item';
      item.title = 'Change this answer';
      item.innerHTML = `<span class="review-n">${n + 1}</span><span class="review-text">`
        + `<span class="review-topic">${md.esc((q.header || '').replace(COUNTER, '') || `Question ${n + 1}`)}</span>`
        + `<span class="review-q">${md.inline(q.question)}</span>`
        + `<span class="review-a">${md.esc(answerText(n))}</span></span><span class="review-edit">Change</span>`;
      item.onclick = () => { i = n; render(); };
      box.appendChild(item);
    });
    $('apply').textContent = 'Submit answers';
    $('apply').disabled = false;
    $('back').hidden = false;
    $('hint').textContent = 'Click an answer to change it · Enter submit · Esc dismiss';
  }

  function picked() { return [...document.querySelectorAll('input[name=o]')].filter(x => x.checked).map(x => x.value); }

  function sync() {
    if (i === qs.length || isInfo(qs[i])) return;
    const s = state[i];
    document.querySelectorAll('.opt').forEach(r => r.classList.toggle('sel', r.querySelector('input').checked));
    s.picked = picked();
    if (s.picked.length) s.dig = s.check = null;
    const other = $('other');
    const wasHidden = other.hidden;
    other.hidden = !s.picked.includes(OTHER);
    if (wasHidden && !other.hidden) other.focus();
    s.other = other.value;
    $('apply').disabled = !(s.dig !== null || s.check || (s.picked.length > 0 && (!s.picked.includes(OTHER) || s.other.trim())));
  }

  function next() {
    if ($('apply').disabled) return;
    if (i < qs.length && isInfo(qs[i])) state[i].dig = null;
    if (i === qs.length || (!hasReview && i === qs.length - 1)) {
      return vscode.postMessage({ type: 'answers', answers: qs.map((_, n) => answerText(n)) });
    }
    i++;
    render();
  }

  function back() {
    if (i === 0) return;
    i--;
    render();
  }

  function dismiss() { vscode.postMessage({ type: 'answers', answers: qs.map(() => null) }); }

  // Ends the dialog early so Claude can fix its understanding before the user decides anything.
  function openOffTrack() {
    closeDig();
    $('offtrack').hidden = false;
    $('off-text').focus();
  }
  function closeOffTrack() {
    $('offtrack').hidden = true;
  }
  function sendOffTrack() {
    const text = $('off-text').value.trim();
    if (!text) return $('off-text').focus();
    vscode.postMessage({ type: 'offtrack', at: Math.min(i, qs.length - 1), text,
      answers: qs.map((_, n) => (n < i && state[n].picked.length ? answerText(n) : null)) });
  }

  // Marks this question "not ready to decide" so Claude explains it more deeply next round; the rest go on as usual.
  function openDig() {
    closeOffTrack();
    $('dig').hidden = false;
    $('dig-text').value = state[i].dig || '';
    $('dig-text').focus();
  }
  function closeDig() {
    $('dig').hidden = true;
  }
  function sendDig() {
    const s = state[i];
    s.dig = $('dig-text').value.trim();
    s.check = null;
    s.picked = [];
    advance();
  }

  // Like Dig deeper: this question goes back to Claude for another reviewer's verdict; the rest go on as usual.
  function sendCheck() {
    const { r, m } = selectedReviewer();
    const effort = $('rv-effort').value;
    if (!r || !m || !effort) return;
    rememberCheck();
    const s = state[i];
    s.check = `(check again: ${r.name} ${m.id} ${effort})`;
    s.dig = null;
    s.picked = [];
    advance();
  }

  function advance() {
    if (i === qs.length - 1 && !hasReview) return vscode.postMessage({ type: 'answers', answers: qs.map((_, n) => answerText(n)) });
    i++;
    render();
  }

  function move(delta) {
    const inputs = [...document.querySelectorAll('input[name=o]')];
    if (!inputs.length) return;
    const at = inputs.indexOf(document.activeElement);
    const target = inputs[(at + delta + inputs.length) % inputs.length];
    target.focus();
    if (target.type === 'radio') { target.checked = true; sync(); }
  }

  $('note').addEventListener('input', e => { state[i].note = e.target.value; });
  $('apply').onclick = next;
  $('back').onclick = back;
  $('cancel').onclick = dismiss;
  $('close').onclick = dismiss;
  $('off').onclick = openOffTrack;
  $('off-send').onclick = sendOffTrack;
  $('off-cancel').onclick = closeOffTrack;
  $('dig-open').onclick = openDig;
  $('dig-send').onclick = sendDig;
  $('dig-cancel').onclick = closeDig;
  $('check').onclick = sendCheck;
  $('rv-model').onchange = () => { fillEfforts(); rememberCheck(); };
  $('rv-effort').onchange = rememberCheck;

  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.type !== 'reviewers') return;
    rv = { reviewers: m.reviewers || [], defaultPreCheck: m.defaultPreCheck || null };
    fillCheck();
    if (i < qs.length) renderVerdicts(qs[i]);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('dig').hidden) return closeDig();
      return $('offtrack').hidden ? dismiss() : closeOffTrack();
    }
    if (e.target.tagName === 'SELECT') return;
    if (e.target.id === 'dig-text') {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendDig(); }
      return;
    }
    if (e.target.id === 'off-text') {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendOffTrack(); }
      return;
    }
    const typing = e.target.tagName === 'TEXTAREA';
    if (typing) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); next(); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); return next(); }
    if (e.altKey && e.key === 'ArrowLeft') return back();
    if (i === qs.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); return move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); return move(-1); }
    const n = parseInt(e.key, 10);
    const inputs = document.querySelectorAll('input[name=o]');
    if (n >= 1 && n <= inputs.length) {
      const x = inputs[n - 1];
      x.checked = x.type === 'checkbox' ? !x.checked : true;
      x.focus();
      sync();
    }
  });

  fillCheck();
  render();
  vscode.postMessage({ type: 'ready' });
})();
