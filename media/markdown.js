// A small markdown subset for model-written text. Every piece of input is escaped before any tag is added,
// so nothing the caller sends can become live HTML.
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
  const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  const unesc = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g, m => UNESC[m]);

  // Clicks on these go to the extension, which opens web links externally and file links in the editor.
  const link = (href, text) => `<a class="link" href="#" data-href="${href}" title="${href}">${text}</a>`;

  // `src/Foo.cs:42`, `C:\repo\Foo.cs`, `Foo.cs#L10-L20`: a path with an extension, plus a separator or a line.
  const FILE_REF = /^(?:[A-Za-z]:)?[\w.\/\\-]*\.\w+(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)?$/;
  const looksLikeFile = t => FILE_REF.test(t) && /[:#\/\\]/.test(t) && !/^\d/.test(t);

  // Local images the extension resolved to webview URIs; anything else shows as text.
  function image(alt, src) {
    const resolved = (window.mdImages || {})[unesc(src)];
    return resolved
      ? `<img class="md-img" src="${esc(resolved)}" alt="${alt}">`
      : `<span class="missing-img" title="${src}">[image: ${alt || src}]</span>`;
  }

  function inline(text) {
    return String(text).split(/(`[^`\n]+`)/).map(part => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
        const raw = part.slice(1, -1);
        const code = `<code>${esc(raw)}</code>`;
        return looksLikeFile(raw) ? link(esc(raw), code) : code;
      }
      // Images and links become placeholders first, so emphasis rules never run inside a URL.
      const slots = [];
      const slot = html => `\u0000${slots.push(html) - 1}\u0000`;
      return esc(part)
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => slot(image(alt, src)))
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => slot(link(href, label)))
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?])/g, (_, pre, url) => pre + slot(link(url, url)))
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
        .replace(/\u0000(\d+)\u0000/g, (_, n) => slots[n]);
    }).join('');
  }

  const isFence = l => /^\s*```/.test(l);
  const isHeading = l => /^#{1,6}\s+/.test(l);
  const isList = l => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isQuote = l => /^\s*>/.test(l);
  const isRule = l => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  const isTableStart = (l, next) => /^\s*\|/.test(l) && next !== undefined && /^\s*\|?\s*:?-{2,}/.test(next);
  const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  function block(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      if (isFence(line)) {
        const lang = line.trim().slice(3).trim();
        const body = [];
        for (i++; i < lines.length && !isFence(lines[i]); i++) body.push(lines[i]);
        i++;
        // modal.js swaps this for the drawn diagram; the source stays visible if drawing fails.
        if (/^mermaid$/i.test(lang)) {
          const src = esc(body.join('\n'));
          out.push(`<div class="mermaid-box" data-src="${src}"><pre><code>${src}</code></pre></div>`);
          continue;
        }
        const cls = /^diff$/i.test(lang) ? ' diff' : '';
        const code = body.map(l => {
          const e = esc(l);
          if (!cls) return e;
          return l.startsWith('+') ? `<span class="add">${e}</span>` : l.startsWith('-') ? `<span class="del">${e}</span>` : e;
        }).join('\n');
        out.push(`<figure class="code${cls}">${lang ? `<figcaption>${esc(lang)}</figcaption>` : ''}<pre><code>${code}</code></pre></figure>`);
        continue;
      }

      if (isHeading(line)) {
        const level = Math.min(line.match(/^#+/)[0].length + 1, 5);
        out.push(`<h${level}>${inline(line.replace(/^#+\s+/, ''))}</h${level}>`);
        i++;
        continue;
      }

      if (isRule(line)) { out.push('<hr>'); i++; continue; }

      if (isTableStart(line, lines[i + 1])) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map(c => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left'));
        const rows = [];
        for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
        // Classes, not style attributes: the page's CSP allows no inline styles.
        const td = (tag, c, n) => `<${tag} class="al-${align[n] || 'left'}">${inline(c)}</${tag}>`;
        out.push(`<div class="table"><table><thead><tr>${head.map((c, n) => td('th', c, n)).join('')}</tr></thead><tbody>${
          rows.map(r => `<tr>${r.map((c, n) => td('td', c, n)).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }

      if (isQuote(line)) {
        const body = [];
        for (; i < lines.length && isQuote(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${block(body.join('\n'))}</blockquote>`);
        continue;
      }

      if (isList(line)) {
        const ordered = /^\s*\d/.test(line);
        const items = [];
        for (; i < lines.length && (isList(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]))); i++) {
          if (isList(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          else items[items.length - 1] += ' ' + lines[i].trim();
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
        continue;
      }

      const para = [];
      for (; i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isHeading(lines[i]) && !isList(lines[i])
        && !isQuote(lines[i]) && !isRule(lines[i]) && !isTableStart(lines[i], lines[i + 1]); i++) para.push(lines[i].trim());
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    return out.join('');
  }

  window.md = { block, inline, esc, unesc };
})();
