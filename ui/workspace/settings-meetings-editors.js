// The live parts of Settings › Meetings: the note template editor (its dirty bar, the
// instructions and the latest document made with it), the two Markdown editors with what Connect
// picks up from them, and the rule tester's answer. The controller patches the bar, the summary,
// the save status and the answer in place while the person types, so an editor is never
// re-rendered under the caret. Pure: every person-supplied string is escaped here.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { avatar, button, checkbox, emptyState, spinner, toggle } from './ui.js';
import { agoLabel, formatDate } from './format.js';
import { renderMarkdown } from './markdown.js';
import { columnName } from './tasks-model.js';
import { parseGlossary, parseTags, resolveTemplate, ruleText, rulesOf, templatesOf } from './meetings-model.js';
import { plural, tplColor } from './view-meeting-tabs.js';

/** What a template's sections are called (the prototype's labels). */
export const SECTION_LABELS = {
  frontmatter: 'Front matter', tldr: 'TL;DR', summary: 'Summary', context: 'Context', knowledge: 'Knowledge by topic', discussion: 'Discussion',
  attendees: 'Attendees', decisions: 'Decisions', plan: 'Plan', actions: 'Action items', questions: 'Open questions', transcriptNotes: 'Transcript notes',
  asks: 'Client asks', commitments: 'Commitments (we owe / they owe)', risks: 'Risks', followup: 'Follow-up email', feedback: 'Feedback',
  standup: 'Per-person digest', blockers: 'Blockers', assessment: 'Assessment', evidence: 'Evidence by area', alternatives: 'Alternatives', consequences: 'Consequences', waiting: 'Who waits on whom',
};
/** The variables notes.rs fills in for each meeting. */
export const VARIABLES = [
  ['{{title}}', 'Meeting title'], ['{{date}}', 'Meeting date'], ['{{participants}}', 'Attendees with roles'], ['{{me}}', 'You — “we” becomes you'],
  ['{{glossary}}', 'Your glossary (Markdown)'], ['{{tags}}', 'Your tag list (Markdown)'], ['{{wishes}}', 'What you typed for this run'], ['{{transcript}}', 'The transcript, line by line'],
];
export const SWATCHES = ['#5677C8', '#259F4C', '#C084FC', '#F5A534', '#E65100', '#2297F6', '#FE3B4C', '#00796B', '#7B3FBF'];
const ICONS = ['note', 'list', 'users', 'sparkles', 'quote', 'tasks', 'transcript'];
const tplIcon = t => (t?.kind === 'skill' ? 'skill' : ICONS.includes(t?.icon) ? t.icon : 'note');

/** A refusal shown under the field it is about (`key`: `meetings.root`, `tpl.name`, …). */
export const fieldError = (v, key) => (v?.errors?.[key] ? `<p class="ws-field-error" role="alert" data-error-for="${e(key)}">${e(v.errors[key])}</p>` : '');

/** A card whose header has a line under the title. */
export function subCard({ title, iconName, sub = '', actions = '', body = '', footer = '', className = '', attrs = '' }) {
  return `<section class="ws-card${className ? ` ${className}` : ''}"${attrs}>
    <header class="ws-card-header"><div class="ws-mtg-card-head"><h2 class="ws-card-title"><span class="ws-card-icon">${icon(iconName)}</span>${e(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${actions ? `<div class="ws-card-actions">${actions}</div>` : ''}</header>
    <div class="ws-card-body">${body}</div>${footer ? `<footer class="ws-card-footer">${footer}</footer>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- templates

export const templateOf = (s, id) => templatesOf(s).find(t => t.id === id) || null;

/** What the editor edits, from a template. */
export const draftOf = t => ({
  name: t?.name || '', blurb: t?.blurb || '', prompt: t?.prompt || '', sections: [...(Array.isArray(t?.sections) ? t.sections : [])],
  extractTasks: t?.extractTasks !== false, color: tplColor(t), icon: t?.icon || 'note', skillPath: t?.skillPath || '',
});

/** Whether the editor holds changes the template doesn't have (a new one always does). */
export function isDirty(s, edit) {
  if (!edit) return false;
  if (edit.isNew) return true;
  const t = templateOf(s, edit.id);
  if (!t) return false;
  const saved = draftOf(t);
  const d = edit.draft;
  return d.name !== saved.name || d.blurb !== saved.blurb || d.color !== saved.color || d.extractTasks !== saved.extractTasks
    || d.sections.join() !== saved.sections.join() || (t.kind === 'skill' ? d.skillPath !== saved.skillPath : d.prompt !== saved.prompt);
}

/** The newest document made with a template: `{meeting, doc}` (a document's id is its template's). */
export function latestDoc(s, templateId) {
  let best = null;
  for (const r of s.records || []) {
    if (r.kind !== 'meeting') continue;
    for (const doc of Array.isArray(r.data?.docs) ? r.data.docs : []) {
      if (doc.id !== templateId && doc.template !== templateId) continue;
      const at = Number(doc.updatedAt) || Number(doc.createdAt) || 0;
      if (!best || at > best.at) best = { meeting: r, doc, at };
    }
  }
  return best;
}
/** Where the latest document's text is kept in the view state (a new revision reads it again). */
export const latestKey = found => `${found.meeting.id}:${found.doc.id}:${found.doc.rev ?? found.doc.version ?? ''}`;

const words = text => String(text || '').split(/\s+/).filter(Boolean).length;
export const wordsHint = prompt => `<small class="ws-field-hint" data-ms-words>${plural(words(prompt), 'word')} · sent with the transcript text, never the audio.</small>`;

/** The bar above the editor: saved or not, Discard, Duplicate, Save. */
export function editorBar(s, edit) {
  const dirty = isDirty(s, edit);
  const state = dirty ? `${icon('edit')}${edit.isNew ? 'Not saved yet' : 'Unsaved changes'}` : `${icon('check-circle')}Saved`;
  return `<div class="ws-ms-editor-bar${dirty ? ' ws-ms-dirty' : ''}"><span class="ws-ms-editor-state" role="status">${state}</span><span class="ws-spacer"></span>${dirty ? button('Discard', { action: 'meetings-settings-tpl-discard', variant: 'ghost', size: 'sm' }) : ''}${edit.isNew ? '' : button('Duplicate', { action: 'meetings-settings-tpl-dup', variant: 'ghost', size: 'sm', iconName: 'copy', attrs: { 'data-id': edit.id } })}${button('Save', { action: 'meetings-settings-tpl-save', variant: 'primary', size: 'sm', iconName: 'check', disabled: !dirty })}</div>`;
}

export const swatches = color => `<div class="ws-ms-swatches" role="group" aria-label="Colour">${SWATCHES.map(c => `<button type="button" class="ws-ms-swatch" style="--c:${c}" data-action="meetings-settings-tpl-color" data-c="${c}" aria-pressed="${c.toLowerCase() === String(color).toLowerCase()}" aria-label="Colour ${c}"></button>`).join('')}</div>`;

/** Static `[hh:mm]` chips (a preview outside its meeting), or ones that open the meeting's line. */
const timesIn = (html, meetingId) => html.replace(/<button type="button" class="ws-md-ts" data-action="meeting-goto-line" data-t="([^"]*)" title="Show in the transcript">/g, (_, t) => (meetingId
  ? `<button type="button" class="ws-md-ts" data-action="meetings-settings-open-line" data-id="${e(meetingId)}" data-t="${t}" title="Show in the transcript">`
  : `<button type="button" class="ws-md-ts" disabled data-t="${t}">`));

/** The newest notes made with the template being edited, and Try on a meeting. */
export function latestCard(s, edit, ctx) {
  const id = edit.isNew ? null : edit.id;
  const found = id ? latestDoc(s, id) : null;
  const read = found ? ctx.v.latest?.[latestKey(found)] : null;
  const canTry = ctx.tryable > 0;
  const tryButton = button('Try on a meeting', { action: 'meetings-settings-tpl-try', variant: found ? 'ghost' : 'primary', size: 'sm', iconName: 'sparkles', disabled: !canTry, title: canTry ? undefined : 'No meeting has a transcript yet' });
  if (!found) {
    return subCard({
      title: 'Latest notes made with it', iconName: 'eye', className: 'ws-ms-latest',
      body: emptyState({ iconName: 'note', title: edit.isNew ? 'Save it first' : 'Nothing made with it yet', text: canTry ? 'Try it on a meeting with a transcript to see what it writes.' : 'Once a meeting has a transcript, try it there to see what it writes.', actions: edit.isNew ? '' : tryButton }),
    });
  }
  const zone = s.settings.timeZone;
  const m = found.meeting.data || {};
  const when = Date.parse(m.start);
  const meta = [m.title || 'A meeting', Number.isFinite(when) ? formatDate(when, zone, { weekday: 'short', month: 'short', day: 'numeric' }) : '', `made ${agoLabel(found.at, zone, ctx.now)}`, found.doc.edited ? 'edited since' : ''].filter(Boolean).map(x => e(x)).join(' · ');
  const body = !read ? `<div class="ws-ms-latest-wait">${spinner('Reading the notes')}</div>`
    : read.error ? `<p class="ws-inline-note ws-warning">${icon('alert')}<span>${e(read.error.message || 'These notes couldn’t be read.')}</span></p>`
      : `<article class="ws-md ws-md-compact">${timesIn(renderMarkdown(read.text), found.meeting.id)}</article>`;
  return subCard({
    title: 'Latest notes made with it', iconName: 'eye', className: 'ws-ms-latest', sub: meta,
    body,
    footer: `<small class="ws-muted">${read?.text ? `${plural(words(read.text), 'word')} · ${e(found.doc.file || '')}` : ''}</small><span class="ws-spacer"></span>${button('Open the meeting', { action: 'meetings-settings-open-doc', variant: 'ghost', size: 'sm', attrs: { 'data-id': found.meeting.id, 'data-doc': found.doc.id } })}${tryButton}`,
  });
}

/** The editor of one template: About, Instructions (or the skill it runs), sections and tasks on
 *  the left; the latest notes made with it and Try on a meeting on the right. */
export function templateEditor(s, v, ctx) {
  const edit = v.edit;
  const t = edit.isNew ? { kind: 'custom' } : templateOf(s, edit.id);
  if (!t) return emptyState({ iconName: 'note', title: 'This template is no longer there', text: 'It was deleted. Your other templates are as they were.', actions: button('Note templates', { action: 'meetings-settings-tpl-close', iconName: 'chevron-left' }) });
  const d = edit.draft;
  const settings = s.settings.meetings || {};
  const skill = t.kind === 'skill';
  const about = subCard({
    title: 'About', iconName: tplIcon(t),
    body: `<div class="ws-ms-form-rows">
      <label class="ws-field"><span class="ws-field-label">Name</span><input class="ws-input" data-ms-input="tpl-name" value="${e(d.name)}" maxlength="80" autocomplete="off">${fieldError(v, 'tpl.name')}</label>
      <label class="ws-field"><span class="ws-field-label">What it gives you</span><input class="ws-input" data-ms-input="tpl-blurb" value="${e(d.blurb)}" maxlength="300" autocomplete="off"><small class="ws-field-hint">Shown when people pick a template for a meeting.</small>${fieldError(v, 'tpl.blurb')}</label>
      <div class="ws-field"><span class="ws-field-label">Colour</span>${swatches(d.color)}${fieldError(v, 'tpl.color')}</div>
    </div>`,
  });
  const reset = t.kind === 'builtin' && t.edited ? button('Reset to built-in', { action: 'meetings-settings-tpl-reset', variant: 'ghost', size: 'sm', iconName: 'undo', attrs: { 'data-id': t.id } }) : '';
  const instructions = skill
    ? subCard({
      title: 'Runs a skill', iconName: 'skill', sub: 'The skill’s own instructions decide the notes. Edit it where it lives; Connect reads it again on every run. Wishes you type for a meeting are passed to it too.',
      body: `<label class="ws-field"><span class="ws-field-label">SKILL.md</span><input class="ws-input ws-ms-mono" data-ms-input="tpl-skill" value="${e(d.skillPath)}" spellcheck="false" autocomplete="off"><small class="ws-field-hint">The full path. Runs with the Claude chosen for Meeting notes in Settings › Claude, with the meeting’s transcript as its input.</small>${fieldError(v, 'tpl.skillPath')}</label>`,
      footer: `<span class="ws-spacer"></span>${button('Copy path', { action: 'meetings-settings-copy', variant: 'ghost', size: 'sm', iconName: 'copy', attrs: { 'data-text': d.skillPath } })}`,
    })
    : subCard({
      title: 'Instructions', iconName: 'edit', actions: reset,
      sub: t.kind !== 'builtin' ? 'Plain language works. The variables are filled in for each meeting.' : t.edited ? 'You changed the built-in instructions; “Reset to built-in” brings the original back.' : 'Written for you. Change anything; the original can always come back.',
      body: `<div class="ws-ms-vars" role="group" aria-label="Insert a variable">${VARIABLES.map(([name, label]) => `<button type="button" class="ws-ms-var" data-action="meetings-settings-tpl-var" data-v="${e(name)}" title="${e(label)}">${e(name)}</button>`).join('')}</div>
        <textarea class="ws-textarea ws-ms-prompt" data-ms-input="tpl-prompt" spellcheck="false" rows="22" aria-label="Instructions">${e(d.prompt)}</textarea>
        ${fieldError(v, 'tpl.prompt')}${wordsHint(d.prompt)}`,
    });
  const known = Object.keys(SECTION_LABELS);
  const sectionIds = [...known, ...d.sections.filter(x => !known.includes(x))];
  const review = settings.review !== false;
  const contents = subCard({
    title: 'What the notes contain', iconName: 'list', sub: 'Listed on the template’s card. The instructions decide what goes in each.',
    body: `<div class="ws-ms-sec-grid">${sectionIds.map(id => checkbox({ action: 'meetings-settings-tpl-section', checked: d.sections.includes(id), label: SECTION_LABELS[id] || id, attrs: { 'data-s': id } })).join('')}</div>${fieldError(v, 'tpl.sections')}
      <div class="ws-ms-tasks-row">${toggle({ action: 'meetings-settings-tpl-tasks', checked: d.extractTasks, attrs: { 'aria-label': 'Find tasks' } })}<div><strong>Find tasks</strong><small>Owner from the attendees, “we” becomes you, due date only when someone said one. They go to “${e(columnName(review ? 'review' : 'todo', s.settings))}”.</small></div></div>`,
  });
  return `<div class="ws-ms-editor" style="--tpl:${tplColor(d)}">
    ${editorBar(s, edit)}
    <div class="ws-ms-editor-grid"><div class="ws-ms-editor-left">${about}${instructions}${contents}</div><div class="ws-ms-editor-right">${latestCard(s, edit, ctx)}</div></div>
  </div>`;
}

// ---------------------------------------------------------------- glossary and tags

/** The example documents of the prototype; the glossary's `## Me` names the signed-in person. */
const EXAMPLE_GLOSSARY = `# Glossary

Spellings and names the AI should get right. Write it the way you would brief a new colleague — Connect picks up the **bold** terms and whatever follows “heard as”.

## Me
**Taylor Morgan** — also “Taylor”, “Тейлор”, “TM”. When the team says “we will…”, the task is mine.

## Products and tools
- **CodeMie** — EPAM’s AI platform; heard as “code me”, “code mie”
- **AI/Run** — the EPAM AI programme; heard as “air run”
- **LiteLLM** — the model proxy behind CodeMie budgets; heard as “light LLM”, “lite LLM”
- **Bedrock** — AWS models; heard as “bedrox”
- **Entra ID** — Microsoft identity, where Philips keeps its groups; heard as “entra id”

## People and roles
- **Jeroen de Vries** — Philips, product owner
- **Anouk Bakker** — Philips, solution architect
- **Priya Raman** — delivery manager, runs the weekly and the stand-ups
- **Hannah Lee**, **Marco Rossi** — Northwind (partner), partnerships and security
`;
export const EXAMPLE_TAGS = `# Tags

Notes get tags from this list only, \`meeting\` first. When nothing fits a topic, the AI uses fewer tags and says which one was missing.

- \`meeting\` — every meeting note
- \`philips\` — the Philips account
- \`compliance\` — audits, retention, legal hold
- \`pilot\` — pilots and rollouts
- \`release\` — releases and go/no-go decisions
- \`codemie-connect\` — the Connect desktop app
- \`architecture\` — design reviews and technical decisions
- \`interview\` — interviews I ran
- \`stand-up\` — daily stand-ups
- \`partner\` — partners and resellers
`;
export { EXAMPLE_GLOSSARY };

/** The example to start from. The glossary's `## Me` is the signed-in person (the example's
 *  Taylor Morgan otherwise), so “we” never becomes someone else. */
export function exampleText(kind, s) {
  if (kind === 'tags') return EXAMPLE_TAGS;
  const name = String(s?.connection?.displayName || '').trim().replace(/[*\n“”"]/g, '');
  if (!name) return EXAMPLE_GLOSSARY;
  const first = String(s.connection.givenName || name.split(/\s+/)[0] || '').replace(/[*\n“”"]/g, '');
  const aliases = first && first !== name ? ` — also “${first}”` : '';
  return EXAMPLE_GLOSSARY.replace(/^\*\*Taylor Morgan\*\*.*$/m, `**${name}**${aliases}. When the team says “we will…”, the task is mine.`);
}

/** What Connect picks up from a document, live beside its editor. */
export function mdSummary(kind, text) {
  if (kind === 'tags') {
    const tags = parseTags(text);
    return `<div class="ws-ms-md-summary" data-md-summary="tags"><strong>${plural(tags.length, 'tag')}</strong>${tags.length ? `<div class="ws-ms-md-chips">${tags.map(t => `<code>${e(t)}</code>`).join('')}</div>` : ''}<small class="ws-muted">Any \`tag\` that starts a list item. Notes use only these; a missing one is named in Transcript notes.</small></div>`;
  }
  const g = parseGlossary(text);
  const me = g.me
    ? `<div class="ws-ms-md-me">${avatar({ name: g.me.name, size: 24 })}<span><strong>${e(g.me.name)}</strong><small>${g.me.aliases.length ? `also ${e(g.me.aliases.join(', '))}` : 'no other names'}</small></span></div>`
    : `<p class="ws-ms-md-warn">${icon('alert')}<span>No “## Me” section — Connect won’t know which voice is yours.</span></p>`;
  return `<div class="ws-ms-md-summary" data-md-summary="glossary">${me}
    <strong>${plural(g.pairs.length, 'spelling fix', 'spelling fixes')}</strong>
    ${g.pairs.length ? `<ul class="ws-ms-md-pairs">${g.pairs.map(([heard, written]) => `<li><span>${e(heard)}</span>${icon('arrow')}<strong>${e(written)}</strong></li>`).join('')}</ul>` : ''}
    <strong>${plural(g.terms.length, 'term')} · ${plural(g.people.length, 'person', 'people')}</strong>
    <small class="ws-muted">Bold names are terms or people; quotes after “heard as” are what speech-to-text writes instead.</small></div>`;
}

/** Saving as you type: idle, saving, saved, or why it wasn't. */
export function mdStatus(kind, t) {
  const at = `data-md-status="${kind}"`;
  if (t?.state === 'error') return `<small class="ws-ms-md-status ws-ms-md-error" ${at} role="alert">${icon('alert')}<span>${e(t.error || 'Not saved.')} Your text is still here.</span></small>`;
  if (t?.state === 'saving') return `<small class="ws-ms-md-status" ${at}>${icon('refresh', 'ws-spin')}<span>Saving…</span></small>`;
  if (t?.state === 'saved') return `<small class="ws-ms-md-status ws-ms-md-saved" ${at}>${icon('check-circle')}<span>Saved${t.path ? ` to ${e(String(t.path).split(/[\\/]/).pop())}` : ''}</span></small>`;
  return `<small class="ws-ms-md-status" ${at}>${icon('info')}<span>Plain Markdown, any structure. Saved as you type.</span></small>`;
}

const DOCS = {
  glossary: { title: 'Glossary', iconName: 'book', sub: 'Who you are, how products and people are spelled, and what speech-to-text writes instead. Passed to every template as <code>{{glossary}}</code>.' },
  tags: { title: 'Tags', iconName: 'list', sub: 'The only tags notes may use. Passed as <code>{{tags}}</code>.' },
};

/** One Markdown document: Write / Preview, or the linked file read-only, and what Connect picks up. */
export function mdEditor(kind, s, v) {
  const doc = DOCS[kind];
  const settings = s.settings.meetings || {};
  const linked = settings.glossarySource === 'file';
  const t = v.texts?.[kind] || null;
  const text = t?.text ?? '';
  const path = linked ? (kind === 'glossary' ? settings.glossaryFile : settings.tagsFile) || t?.path || '' : '';
  const file = linked ? (path ? String(path).split(/[\\/]/).pop() : 'not chosen') : `${kind}.md`;
  const tab = v.mdTab?.[kind] === 'preview' ? 'preview' : 'write';
  const preview = () => (text.trim() ? `<article class="ws-md ws-ms-md-preview">${timesIn(renderMarkdown(text), null)}</article>` : `<p class="ws-muted ws-ms-md-empty">${linked ? 'This file is empty, or Connect can’t read it.' : 'Nothing written yet.'}</p>`);
  const editor = !t ? `<div class="ws-ms-latest-wait">${spinner(`Reading the ${doc.title.toLowerCase()}`)}</div>`
    : linked ? (path ? `<div class="ws-ms-md-linked">${icon('link')}<div><strong>Read from <code>${e(path)}</code></strong><small>Connect reads the file before every run. Edit it where it lives — in your editor or your knowledge base.</small></div></div>${preview()}`
      : `<p class="ws-inline-note ws-warning">${icon('alert')}<span>Choose the ${kind === 'glossary' ? 'glossary' : 'tags'} file above.</span></p>`)
      : tab === 'preview' ? preview()
        : `<textarea class="ws-textarea ws-ms-md-text" data-ms-input="md" data-k="${kind}" data-commit="meetings-settings-md-flush" spellcheck="true" rows="20" aria-label="${e(doc.title)} (Markdown)" placeholder="${kind === 'glossary' ? '## Me&#10;**Your Name** — also “Nickname”' : '- `meeting` — every meeting note'}">${e(text)}</textarea>`;
  const tabs = linked ? '' : `<div class="ws-segmented" role="tablist" aria-label="${e(doc.title)} view"><button type="button" role="tab" data-action="meetings-settings-md-tab" data-k="${kind}" data-v="write" aria-selected="${tab === 'write'}">${icon('edit')}Write</button><button type="button" role="tab" data-action="meetings-settings-md-tab" data-k="${kind}" data-v="preview" aria-selected="${tab === 'preview'}">${icon('eye')}Preview</button></div>`;
  return `<section class="ws-card ws-ms-md-card" data-md-card="${kind}">
    <header class="ws-card-header"><div class="ws-mtg-card-head"><h2 class="ws-card-title"><span class="ws-card-icon">${icon(doc.iconName)}</span>${e(doc.title)} <code class="ws-ms-md-file">${e(file)}</code></h2><p>${doc.sub}</p></div>${tabs}</header>
    <div class="ws-ms-md-grid">
      <div class="ws-ms-md-main">${editor}</div>
      <aside class="ws-ms-md-side"><span class="ws-field-label">What Connect picks up</span>${mdSummary(kind, text)}</aside>
    </div>
    ${linked ? '' : `<footer class="ws-card-footer">${mdStatus(kind, t)}<span class="ws-spacer"></span>${button('Restore the example', { action: 'meetings-settings-md-reset', variant: 'ghost', size: 'sm', iconName: 'undo', attrs: { 'data-k': kind } })}</footer>`}
  </section>`;
}

// ---------------------------------------------------------------- rules

/** The rules in the order they are tried. */
export const sortedRules = s => rulesOf(s).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A meeting called `title` with `people` people (you organize it), as the tester tries it. */
function testEvent(s, { title, people }) {
  const n = Math.max(1, Math.min(500, Math.floor(Number(people) || 1)));
  const me = { name: s.connection?.displayName || 'You', address: s.connection?.email || 'you@example.invalid' };
  return { title: String(title || ''), organizer: me, attendees: Array.from({ length: n - 1 }, (_, i) => ({ name: `Guest ${i + 1}`, address: `guest${i + 1}@example.invalid`, type: 'required' })) };
}

/** Which template a meeting with this title and this many people would get, and why. */
export function ruleTestResult(s, test) {
  const rules = sortedRules(s);
  const r = resolveTemplate(testEvent(s, test), null, s, rules);
  const reason = r.why === 'rule' ? `Rule ${rules.findIndex(x => x.id === r.rule) + 1}: ${ruleText(r.ruleRecord)}` : 'No rule matches — your default template';
  return `<div class="ws-ms-test-result" style="--tpl:${tplColor(r.template)}" role="status" aria-live="polite"><span class="ws-tpl-dot"></span><div><strong>${e(r.template.name)}</strong><small>${e(`${reason}${r.auto ? ' · notes made automatically' : ''}`)}</small></div></div>`;
}

export { tplIcon };
