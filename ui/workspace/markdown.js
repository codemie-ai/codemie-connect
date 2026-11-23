// Meeting notes Markdown → HTML for the Meetings page. Every piece of text is escaped before it
// is formatted, so a note (written by Claude from what people said) can never inject markup:
// front matter (a `<dl>`), headings, bullet, numbered and `- [ ]` lists (nested by indent), tables,
// `>` quotes, code blocks, `---` rules, **bold**, *italic*, `code`, and `[hh:mm]` / `[hh:mm:ss]`
// references, which become buttons that open the transcript at that moment. Links are not made.
import { escapeHtml as e } from './store.js';

const TIME = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** `**bold**`, scanned once left to right instead of with a backtracking regex: the previous
 *  lazy-quantifier-plus-lookaround pattern was quadratic on an unclosed `**` run (a long
 *  paragraph of untrusted plugin or note text could stall the window's render for hundreds of
 *  milliseconds). Same rule as before — an opening and a closing `**` each need a non-whitespace
 *  character on their inner side — but once no valid closing `**` exists anywhere further on,
 *  nothing later can have one either, so the rest of the text is copied as is instead of
 *  re-scanned. */
function bold(html) {
  const n = html.length;
  let out = '';
  let copied = 0;
  let pos = 0;
  while (pos < n - 1) {
    if (html[pos] === '*' && html[pos + 1] === '*' && /\S/.test(html[pos + 2] || '')) {
      let close = -1;
      for (let j = pos + 3; j < n - 1; j++) {
        if (html[j] === '*' && html[j + 1] === '*' && /\S/.test(html[j - 1])) { close = j; break; }
      }
      if (close === -1) break; // no valid close anywhere further on: nothing more to find
      out += html.slice(copied, pos) + `<strong>${html.slice(pos + 2, close)}</strong>`;
      copied = close + 2;
      pos = close + 2;
      continue;
    }
    pos++;
  }
  return out + html.slice(copied);
}

/** Bold, italic and time references in text that is already escaped. */
function format(html) {
  return bold(html)
    .replace(/(^|[\s(“"'])\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?=$|[\s).,;:!?”"'])/g, '$1<em>$2</em>')
    .replace(TIME, '<button type="button" class="ws-md-ts" data-action="meeting-goto-line" data-t="$1" title="Show in the transcript">$1</button>');
}

/** One line of inline Markdown: `code` spans are kept as they are, the rest is formatted. */
export function inline(text) {
  return String(text ?? '').split(/(`[^`]+`)/).map(part => (part.length > 2 && part.startsWith('`') && part.endsWith('`')
    ? `<code>${e(part.slice(1, -1))}</code>`
    : format(e(part)))).join('');
}

const tagSpans = v => v.replace(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean).map(t => `<span class="ws-md-tag">${e(t)}</span>`).join('');

/** Front matter as a `<dl>`, or with `front: 'tags'` only its tags as chips (the page already
 *  shows the title, the date and the people). */
function frontMatter(lines, front = 'all') {
  const rows = lines.filter(l => l.includes(':')).map(l => {
    const at = l.indexOf(':');
    return [l.slice(0, at).trim(), l.slice(at + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')];
  });
  if (front === 'tags') {
    const tags = tagSpans(rows.find(([k]) => k === 'tags')?.[1] || '');
    return tags ? `<p class="ws-md-tags">${tags}</p>` : '';
  }
  if (!rows.length) return '';
  const value = (k, v) => (k === 'tags' || /^\[.*\]$/.test(v) ? tagSpans(v) : e(v));
  return `<dl class="ws-md-front">${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${value(k, v)}</dd>`).join('')}</dl>`;
}

/** The lines without their first `# ` heading when it says `title` (any case): the page shows it. */
function withoutTitle(lines, title) {
  const want = String(title || '').trim().toLowerCase();
  if (!want) return lines;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('```')) fenced = !fenced;
    if (fenced) continue;
    const h1 = /^#\s+(.*?)\s*#*$/.exec(l);
    if (h1) return h1[1].trim().toLowerCase() === want ? [...lines.slice(0, i), ...lines.slice(i + 1)] : lines;
  }
  return lines;
}

const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

function table(rows) {
  const [head, ...rest] = rows;
  const body = rest.filter(r => !TABLE_RULE.test(r));
  return `<div class="ws-md-table"><table><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** A list from its lines (`[indent, marker, text]`), nested by indent. */
function list(items) {
  let i = 0;
  const build = indent => {
    const ordered = /\d/.test(items[i][1]);
    const first = ordered ? parseInt(items[i][1], 10) : 1;
    const out = [];
    while (i < items.length && items[i][0] >= indent) {
      const [own, , text] = items[i];
      if (own > indent) {
        // Deeper than this level: a nested list under the item before.
        const nested = build(own);
        if (out.length) out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, `${nested}</li>`);
        else out.push(`<li>${nested}</li>`);
        continue;
      }
      i++;
      const check = /^\[( |x|X)\]\s+(.*)$/.exec(text);
      out.push(check
        ? `<li class="ws-md-check${check[1] === ' ' ? '' : ' ws-md-done'}"><span class="ws-md-box" aria-hidden="true"></span><span>${inline(check[2])}</span></li>`
        : `<li>${inline(text)}</li>`);
    }
    return ordered ? `<ol${first !== 1 ? ` start="${first}"` : ''}>${out.join('')}</ol>` : `<ul>${out.join('')}</ul>`;
  };
  const html = [];
  while (i < items.length) html.push(build(items[i][0]));
  return html.join('');
}

function blocks(lines) {
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { flush(); i++; continue; }
    if (/^```/.test(trimmed)) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      i++;
      out.push(`<pre class="ws-md-code"><code>${e(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2].replace(/\s+#+\s*$/, ''))}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); out.push('<hr>'); i++; continue; }
    if (trimmed.startsWith('|')) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      out.push(rows.length > 1 && TABLE_RULE.test(rows[1]) ? table(rows) : `<p>${inline(rows.join(' '))}</p>`);
      continue;
    }
    if (trimmed.startsWith('>')) {
      flush();
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''));
      out.push(`<blockquote class="ws-md-quote">${blocks(quote)}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const items = [];
      while (i < lines.length && LIST.test(lines[i])) {
        const [, indent, marker, text] = LIST.exec(lines[i]);
        items.push([indent.replace(/\t/g, '  ').length, marker, text]);
        i++;
      }
      out.push(list(items));
      continue;
    }
    para.push(trimmed);
    i++;
  }
  flush();
  return out.join('');
}

/** The notes as HTML: front matter between the first two `---` lines, then the blocks.
 *  `front: 'tags'` draws only the front matter's tags; `dropTitle` leaves out a first `# `
 *  heading that repeats it. */
export function renderMarkdown(md, { front = 'all', dropTitle = '' } = {}) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) return frontMatter(lines.slice(1, end), front) + blocks(withoutTitle(lines.slice(end + 1), dropTitle));
  }
  return blocks(withoutTitle(lines, dropTitle));
}
