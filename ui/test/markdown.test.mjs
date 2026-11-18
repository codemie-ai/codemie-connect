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
