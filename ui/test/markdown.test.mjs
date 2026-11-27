// Notes Markdown as the Meetings page shows it: escaped first, then formatted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../workspace/markdown.js';

const EVIL = '<script>alert(1)</script>';

test('escapes HTML in every construct', () => {
  const md = [
    '---',
    `title: ${EVIL}`,
    `tags: [meeting, ${EVIL}]`,
    '---',
    `# ${EVIL}`,
    `## Heading ${EVIL}`,
    `- item ${EVIL}`,
    `- [ ] check ${EVIL}`,
    `1. first ${EVIL}`,
    '| A | B |',
    '|---|---|',
    `| ${EVIL} | **${EVIL}** |`,
    `> quoted ${EVIL}`,
    `A paragraph with \`${EVIL}\` and <img src=x onerror=alert(1)> and [x](javascript:alert(1)).`,
    '```',
    EVIL,
    '```',
  ].join('\n');
  const html = renderMarkdown(md);
  assert.doesNotMatch(html, /<script|<img/i, 'no raw tags');
  // Every construct still shows the text, escaped.
  const shown = (html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g) || []).length;
  assert.ok(shown >= 11, `escaped in each place (${shown})`);
  assert.match(html, /<dl class="ws-md-front">/);
  assert.match(html, /<h2>&lt;script&gt;/);
  assert.match(html, /<td>&lt;script&gt;/);
  assert.match(html, /<blockquote[^>]*>.*quoted &lt;script&gt;/s);
  assert.match(html, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
  assert.doesNotMatch(html, /href="javascript/i, 'no links are made');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('bold formatting stays linear time on a long unclosed ** run (a plugin or note can hand it 20,000 characters)', () => {
  // '**a ' never closes (every '**' is preceded by a space, so none can be a valid closing
  // marker): the previous lazy-quantifier regex was quadratic here, costing ~500ms at this size.
  const text = '**a '.repeat(20000); // 80,000 characters
  const start = Date.now();
  const html = renderMarkdown(text);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 150, `took ${elapsed}ms (expected well under 150ms; the old regex took ~500ms here)`);
  assert.doesNotMatch(html, /<strong>/, 'no valid close exists anywhere, so nothing is bold');
});

test('renders front matter, tables, checkboxes and [mm:ss] buttons', () => {
  const md = [
    '---',
    'title: Weekly sync',
    'tags: [meeting, pilot]',
    'summary: "Two sentences."',
    '---',
    '# Weekly sync',
    '',
    '## TL;DR',
    '- The **export** is ready [00:12].',
    '  - nested detail',
    '- [ ] Ask Legal',
    '- [x] Book the room',
    '',
    '| Owner | Said at |',
    '|---|---|',
    '| Taylor | [01:05:09] |',
    '',
    'A first line',
    'continues here.',
    '',
    '> Hi Jeroen,',
    '> thanks for today.',
    '',
    '---',
    '3. third',
    '4. fourth',
  ].join('\n');
  const html = renderMarkdown(md);
  assert.match(html, /<dl class="ws-md-front"><dt>title<\/dt><dd>Weekly sync<\/dd><dt>tags<\/dt><dd><span class="ws-md-tag">meeting<\/span><span class="ws-md-tag">pilot<\/span><\/dd><dt>summary<\/dt><dd>Two sentences\.<\/dd><\/dl>/);
  assert.match(html, /<h2>Weekly sync<\/h2>/);
  assert.match(html, /<h3>TL;DR<\/h3>/);
  assert.match(html, /<strong>export<\/strong>/);
  assert.match(html, /<button type="button" class="ws-md-ts" data-action="meeting-goto-line" data-t="00:12"[^>]*>00:12<\/button>/);
  assert.match(html, /data-t="01:05:09"/);
  assert.match(html, /<li>The <strong>export<\/strong> is ready <button[^>]*>00:12<\/button>\.<ul><li>nested detail<\/li><\/ul><\/li>/);
  assert.match(html, /<li class="ws-md-check"><span class="ws-md-box" aria-hidden="true"><\/span><span>Ask Legal<\/span><\/li>/);
  assert.match(html, /<li class="ws-md-check ws-md-done"><span class="ws-md-box" aria-hidden="true">/);
  assert.match(html, /<div class="ws-md-table"><table><thead><tr><th>Owner<\/th><th>Said at<\/th><\/tr><\/thead><tbody><tr><td>Taylor<\/td><td><button/);
  assert.match(html, /<p>A first line continues here\.<\/p>/);
  assert.match(html, /<blockquote class="ws-md-quote"><p>Hi Jeroen, thanks for today\.<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<ol start="3"><li>third<\/li><li>fourth<\/li><\/ol>/);
});

// ---------------------------------------------------------------- the notes as a page

const NOTE = `---
title: Philips sync
date: 2026-11-16
tags: [meeting, philips]
summary: "Agreed the export."
---
# Philips sync

## TL;DR
- Done.`;

test('renderMarkdown with front tags draws only the tags', () => {
  const html = renderMarkdown(NOTE, { front: 'tags' });
  assert.match(html, /<p class="ws-md-tags"><span class="ws-md-tag">meeting<\/span><span class="ws-md-tag">philips<\/span><\/p>/);
  assert.doesNotMatch(html, /<dl|Agreed the export|2026-11-16/);
  assert.equal(renderMarkdown('---\ntitle: x\n---\nText', { front: 'tags' }).includes('ws-md-tags'), false, 'no tags: nothing at all');
});

test('renderMarkdown drops the first heading equal to the title', () => {
  const html = renderMarkdown(NOTE, { front: 'tags', dropTitle: '  philips SYNC ' });
  assert.doesNotMatch(html, /<h2>Philips sync<\/h2>/);
  assert.match(html, /<h3>TL;DR<\/h3>/);
  assert.match(renderMarkdown('# Philips sync\n\nText\n\n# Philips sync', { dropTitle: 'Philips sync' }), /<p>Text<\/p><h2>Philips sync<\/h2>/, 'only the first one');
});

test('renderMarkdown keeps a heading that is not the title, and text without front matter', () => {
  assert.match(renderMarkdown(NOTE, { front: 'tags', dropTitle: 'Another meeting' }), /<h2>Philips sync<\/h2>/);
  assert.match(renderMarkdown('# Short summary\n\nText', { front: 'tags', dropTitle: 'Philips sync' }), /<h2>Short summary<\/h2><p>Text<\/p>/);
  assert.match(renderMarkdown('## Only a section\n- a', { dropTitle: 'Philips sync' }), /<h3>Only a section<\/h3>/);
});

test('the default still draws the whole front matter', () => {
  const html = renderMarkdown(NOTE);
  assert.match(html, /<dl class="ws-md-front">[^]*?<dt>summary<\/dt><dd>Agreed the export\.<\/dd>/);
  assert.match(html, /<h2>Philips sync<\/h2>/);
});

// Ask mode (ask-capture design § 7): an answer is plain reading text with bullets. No transcript
// buttons for `[10:00]`, no front matter, no headings or tables; `[m3]` marks become what `cite`
// returns (unknown ids go). The other callers are unchanged.
test('ask mode: no time buttons, front matter, headings or tables; cite marks through `cite`', () => {
  const md = ['---', 'title: x', '---', '# Summary', 'At [10:00] you agreed [m3] and [e9] **this**.', '| A | B |', '|---|---|', '| 1 | 2 |', `- a [t2] ${EVIL}`, '`[m3]` stays code'].join('\n');
  const html = renderMarkdown(md, { mode: 'ask', cite: id => (id === 'm3' ? '<sup>M3</sup>' : id === 't2' ? '<sup>T2</sup>' : '') });
  assert.doesNotMatch(html, /ws-md-ts|<dl|<h\d|<table/);
  assert.match(html, /At \[10:00\] you agreed <sup>M3<\/sup> and  <strong>this<\/strong>\./);
  assert.match(html, /<p>title: x<\/p>|title: x/);
  assert.match(html, /<p>Summary<\/p>/);
  assert.match(html, /<li>a <sup>T2<\/sup> &lt;script&gt;/);
  assert.match(html, /<code>\[m3\]<\/code>/);
  // Without the mode, the same text keeps its notes rendering.
  assert.match(renderMarkdown('At [10:00]'), /ws-md-ts/);
});
