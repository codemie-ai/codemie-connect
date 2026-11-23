// The Settings › Meetings controller (spec "Settings › Meetings"): settings saved one field at a
// time with each refusal shown next to its field; the meetings folder; reading Teams
// transcripts (the Meetings page's own connect path); note templates (the editor, Save, Discard,
// Duplicate, Reset to built-in with Undo, Make default, Delete, skills, Try on a meeting);
// automatic rules (add, change, order, delete with Undo, the tester); the glossary and the tag
// list (saved as you type, Restore the example with Undo, linked files read-only). app.js routes
// the `meetings-settings-*` actions here. Typing never re-renders: the dirty bar, the summary,
// the save status and the tester's answer are patched in place. No optimistic updates.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { formatDate, formatTime } from './format.js';
import { COLUMN_NAMES } from './tasks-model.js';
import { quoted } from './tasks-controller.js';
import { templatesOf } from './meetings-model.js';
import { pinShows, storedPins } from './meeting-view-model.js';
import { badge, select } from './ui.js';
import {
  draftOf, editorBar, exampleText, isDirty, latestCard, latestDoc, latestKey, mdEditor, mdStatus, mdSummary, ruleTestResult, sortedRules, swatches, templateOf, wordsHint,
} from './settings-meetings-editors.js';
import { newMeetingsSettingsView, tryableMeetings } from './view-settings-meetings.js';
import { plural } from './view-meeting-tabs.js';

export { newMeetingsSettingsView };

const NUMBERS = new Set(['checkEveryMin', 'waitMin', 'doneDays']);
const TEXT_SAVE_MS = 600;
const LINKED_READ_MS = 15_000;
/** Where the template editor puts a refused field (`field` of the error → its control). */
const TPL_FIELDS = { name: '[data-ms-input="tpl-name"]', blurb: '[data-ms-input="tpl-blurb"]', prompt: '[data-ms-input="tpl-prompt"]', skillPath: '[data-ms-input="tpl-skill"]', color: '.ws-ms-swatch[aria-pressed="true"]', sections: '[data-action="meetings-settings-tpl-section"]' };
/** The name a skill gets as a template: its folder name in sentence case. */
const skillName = name => {
  const words = String(name || 'skill').replace(/[-_]+/g, ' ').trim();
  return (words[0] || 'S').toUpperCase() + words.slice(1);
};

/**
 * `state.meetingsSettings` is the view state (`newMeetingsSettingsView()`); `snap()` the
 * snapshot; `store.query` a read-only operation; `mutate(op, data)` a fenced write that
 * re-renders; `save(op, data)` the same without a re-render (the glossary while it is typed);
 * `render()`; `patch(selector, html)` replaces one element in place; `route(name, tab)`; the
 * dialogs and `toast(message, tone, {label, run})`; `focus(selectors)` after a render;
 * `insertText(selector, text)` types at a field's caret and returns its value; `pickRoot()` the
 * native folder picker; `transcriptsOn()` the Meetings page's Turn on; `makeNotes(id, options)`
 * and `guarded(id, run)` from the Meetings controller; `openMeeting(id, tab)`; `glossaryChanged()`
 * tells the Meetings page to read the glossary again; `plugins()` the summary plugins installed
 * and on (`[{id, name}]`, for the pins the "Pin a summary" menu offers); `later`/`cancel`
 * timers; `now()`.
 */
export function createMeetingsSettingsController({
  state, store, snap, mutate, save = mutate, render, patch = () => {}, route = async () => {}, openModal = () => null, confirmModal = () => {}, toast = () => {},
  focus = () => {}, writeText = async () => {}, insertText = () => null, pickRoot = async () => null, transcriptsOn = async () => {},
  makeNotes = async () => {}, guarded = async (id, run) => { await run(); return true; }, openMeeting = async () => {}, glossaryChanged = () => {},
  later = (fn, ms) => setTimeout(fn, ms), cancel = handle => clearTimeout(handle), now = () => Date.now(), plugins = () => [],
}) {
  const v = () => {
    if (!state.meetingsSettings) state.meetingsSettings = newMeetingsSettingsView();
    return state.meetingsSettings;
  };
  const meetings = () => snap().settings.meetings || {};
  const tpl = id => templateOf(snap(), id);
  const fieldOf = err => (err?.code === 'validation' && err.field ? err.field : null);

  // ---------------------------------------------------------------- refusals by field

  function clearError(key) {
    if (!(key in v().errors)) return;
    delete v().errors[key];
    patch(`[data-error-for="${quoted(key)}"]`, '');
  }
  const clearErrors = prefix => { for (const key of Object.keys(v().errors)) if (key.startsWith(prefix)) delete v().errors[key]; };

  /** Saves one meeting setting. A refusal is kept for its field (and a switch goes back); true
   *  when it was saved. */
  async function saveSetting(key, value, { errorKey = `meetings.${key}`, el = null, payload = { [key]: value }, typed } = {}) {
    let answer;
    try {
      answer = await mutate('settings_update', { meetings: payload });
    } catch (err) {
      if (!fieldOf(err)) throw err;
      if (el?.type === 'checkbox') el.checked = !el.checked;
      v().errors[errorKey] = err.message;
      // A refused text stays in its field to be fixed.
      if (typed !== undefined) v().drafts[errorKey] = typed;
      await render();
      return false;
    }
    const shown = errorKey in v().errors || errorKey in v().drafts;
    delete v().errors[errorKey];
    delete v().drafts[errorKey];
    if (shown) await render();
    return answer && typeof answer === 'object' ? answer : true;
  }

  /** What a new meetings folder means, in one toast: where new folders go, and which of the
   *  glossary and the tag list came along (native copies them, never over a file the folder
   *  has: `texts {copied, kept, failed}`). */
  function rootMoved(where, answer, undo) {
    const { copied = [], kept = [], failed = [] } = answer?.texts || {};
    const both = copied.length === 2 ? 'Your glossary and tag list were copied there.' : copied.length ? `${copied[0]} was copied there.` : '';
    const had = kept.length ? `The folder already had its own ${kept.join(' and ')}, so Connect kept ${kept.length > 1 ? 'them as they are' : 'it as it is'}.` : '';
    const lost = failed.length ? `Connect couldn’t copy ${failed.join(' and ')} there: copy ${failed.length > 1 ? 'them' : 'it'} from the old folder yourself.` : '';
    if (copied.length || failed.length) {
      v().textsKey = '';
      glossaryChanged();
    }
    const message = [`New meeting folders go to ${where}. Meetings saved before keep their folders.`, both, had, lost].filter(Boolean).join(' ');
    toast(message, failed.length ? 'info' : 'success', { label: 'Undo', run: undo });
  }

  function valueOf(el) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') return el.checked;
    return NUMBERS.has(key) ? Number(el.value) : el.value;
  }

  /** A typed field saved when it is left: a column name or a linked file's path. */
  async function commitField(el) {
    const key = el.dataset.key;
    const value = String(el.value ?? '').trim();
    if (key.startsWith('columns.')) {
      const status = key.slice(8);
      const stored = meetings().columns?.[status] || '';
      const next = value === COLUMN_NAMES[status] ? '' : value;
      if (next === stored && !(`meetings.${key}` in v().drafts)) return;
      await saveSetting('columns', null, { errorKey: `meetings.${key}`, payload: { columns: { [status]: next || null } }, typed: value });
      return;
    }
    if (!['glossaryFile', 'tagsFile'].includes(key)) return;
    if ((meetings()[key] || '') === value && !(`meetings.${key}` in v().drafts)) return;
    if (await saveSetting(key, value || null, { typed: value })) {
      v().textsKey = '';
      glossaryChanged();
    }
  }

  // ---------------------------------------------------------------- the meetings folder

  async function pickFolder() {
    const picked = await pickRoot();
    if (!picked) return;
    const before = meetings().root ?? null;
    const answer = await saveSetting('root', picked);
    if (!answer) return;
    rootMoved(picked, answer, async () => {
      if (await saveSetting('root', before)) toast('The meetings folder is back as it was.', 'success');
    });
  }

  async function reveal() {
    try {
      await store.query('meetings_reveal', {});
    } catch (err) {
      if (err?.code !== 'folder_unwritable') throw err;
      v().errors['meetings.root'] = err.message;
      await render();
    }
  }

  // ---------------------------------------------------------------- Teams transcripts

  async function transcripts(el) {
    const s = snap();
    if (el.checked) {
      // Stays off until Microsoft says yes: the Meetings page's own connect path asks.
      el.checked = false;
      return transcriptsOn();
    }
    const enabled = s.connection?.enabled || [];
    await mutate('settings_update', { capabilities: enabled.filter(x => x !== 'meetings' && x !== 'transcripts') });
    return toast('Connect stopped reading Teams transcripts. Transcripts and notes already saved stay in their folders.', 'success');
  }

  // ---------------------------------------------------------------- "When you open a meeting"

  // Pin, unpin and move each send the whole next array, built on every stored entry — a pin of a
  // plugin that is off or not loaded yet, or of another workspace's template, is not shown here but
  // must survive an edit made while it is out of sight. Only the list drawn filters (`pinsOf`).
  // A fast click on a second pin control before the first's `settings_update` round-trip lands
  // must build on that first click's result, not the snapshot it was sent from (still stale at
  // that point) — the same shape dock-controller.js's `commit()` keeps for layouts. `pendingPins`,
  // once set, is what `pins()` reads instead of the snapshot; a read reconciles it away once the
  // snapshot itself catches up, and a refusal clears it back to whatever the snapshot holds.
  let pendingPins = null;
  function pins() {
    const real = storedPins(snap());
    if (pendingPins && JSON.stringify(pendingPins) === JSON.stringify(real)) pendingPins = null;
    return pendingPins || real;
  }
  async function sendPins(next) {
    pendingPins = next;
    const ok = await saveSetting('summaryTabs', next);
    // Only undo this call's own pending value: an earlier call refused after a later one has
    // already moved `pendingPins` on must not wipe out that later, still-in-flight (or already
    // landed) array.
    if (!ok && pendingPins === next) pendingPins = null;
    return ok;
  }

  /** Pins a template or a plugin (`id`, or `plugin:<id>`) last; a refusal (over 4) shows under
   *  the card. */
  async function pinTab(id) {
    if (!id || pins().includes(id)) return;
    await sendPins([...pins(), id]);
  }

  async function unpinTab(id) {
    if (!id || !pins().includes(id)) return;
    await sendPins(pins().filter(x => x !== id));
  }

  /** Swaps a pin with the shown pin before (`d` -1) or after (+1) it, as the card lists them;
   *  the hidden ones keep their places. */
  async function movePin(id, d) {
    const ids = pins();
    const shown = ids.filter(pinShows(snap(), plugins()));
    const at = shown.indexOf(id);
    const to = at + d;
    if (at < 0 || to < 0 || to >= shown.length) return;
    const next = [...ids];
    const [i, j] = [ids.indexOf(id), ids.indexOf(shown[to])];
    [next[i], next[j]] = [next[j], next[i]];
    await sendPins(next);
  }

  // ---------------------------------------------------------------- the template editor

  const editing = () => v().edit;
  function liveEditor() {
    const ed = editing();
    if (!ed) return;
    patch('.ws-ms-editor-bar', editorBar(snap(), ed));
    patch('[data-ms-title]', `<h2 data-ms-title>${e(ed.draft.name || 'New template')}</h2>`);
  }

  /** Opens a template in the editor (from Settings, or a document's “Edit the template”). */
  async function editTemplate(id) {
    const t = tpl(id);
    if (!t) {
      toast('This template is no longer there.', 'error');
      return;
    }
    const show = async () => {
      if (editing()?.id !== id) v().edit = { id, isNew: false, draft: draftOf(t) };
      clearErrors('tpl.');
      if (state.route === 'settings' && state.settingsTab === 'meetings-templates') await render();
      else await route('settings', 'meetings-templates');
      focus('[data-ms-input="tpl-name"]');
    };
    const ed = editing();
    if (ed && ed.id !== id && isDirty(snap(), ed)) {
      // Another template's changes aren't saved: ask first, then open once the dialog is gone.
      let go = false;
      return confirmModal({
        title: 'Discard your changes?', text: `Your changes to “${ed.draft.name || 'a template'}” aren’t saved. Open “${t.name}” anyway?`, confirm: 'Discard and open', variant: 'danger', initialFocus: 'cancel',
        onConfirm: () => { go = true; },
        onClose: () => { if (go) show().catch(() => {}); },
      });
    }
    return show();
  }

  /** Note templates opened again: an editor without changes closes; one with changes stays. */
  function leaveEditor(tab) {
    if (tab === 'meetings-templates' && editing() && !isDirty(snap(), editing())) v().edit = null;
  }

  async function closeEditor() {
    const ed = editing();
    if (!ed) return;
    const back = () => focus([...(ed.id ? [`.ws-ms-tpl-open[data-id="${quoted(ed.id)}"]`] : []), '[data-action="meetings-settings-tpl-new"]']);
    const done = async () => {
      v().edit = null;
      clearErrors('tpl.');
      await render();
    };
    if (isDirty(snap(), ed)) {
      // Focus moves once the dialog has closed (it gives focus back as it closes).
      let discarded = false;
      return confirmModal({
        title: 'Discard your changes?', text: `Your changes to “${ed.draft.name || 'this template'}” aren’t saved.`, confirm: 'Discard', variant: 'danger', initialFocus: 'cancel',
        onConfirm: async () => { discarded = true; await done(); },
        onClose: () => { if (discarded) back(); },
      });
    }
    await done();
    return back();
  }

  function newTemplate() {
    const base = tpl('short-summary');
    v().edit = { id: null, isNew: true, draft: { name: 'New template', blurb: '', prompt: base?.prompt || 'Write a short summary of "{{title}}" ({{date}}).\n\nTranscript:\n{{transcript}}', sections: ['summary', 'decisions', 'actions'], extractTasks: true, color: '#2297F6', icon: 'note', skillPath: '' } };
    clearErrors('tpl.');
    return render().then(() => focus('[data-ms-input="tpl-name"]'));
  }

  /** What `template_save` gets from a draft. */
  function body(d, kind) {
    return {
      name: d.name.trim(), blurb: d.blurb.trim(),
      ...(kind === 'skill' ? { skillPath: d.skillPath.trim() } : { prompt: d.prompt }),
      sections: d.sections, extractTasks: d.extractTasks, color: d.color, icon: d.icon,
    };
  }

  /** Saves the editor. A refusal shows next to its field and focuses it; true when saved. */
  async function saveTemplate() {
    const ed = editing();
    if (!ed) return false;
    const t = ed.isNew ? null : tpl(ed.id);
    if (!ed.isNew && !t) throw new Error('This template is no longer there.');
    const kind = t?.kind || 'custom';
    let saved;
    try {
      saved = await mutate('template_save', { ...(ed.isNew ? { kind: 'custom' } : { id: ed.id }), ...body(ed.draft, kind) });
    } catch (err) {
      const field = fieldOf(err);
      if (!field || !TPL_FIELDS[field]) throw err;
      clearErrors('tpl.');
      v().errors[`tpl.${field}`] = err.message;
      await render();
      focus(TPL_FIELDS[field]);
      return false;
    }
    const id = saved?.id || ed.id;
    if (editing() === ed) {
      v().edit = { id, isNew: false, draft: draftOf(tpl(id) || { ...ed.draft, kind }) };
      clearErrors('tpl.');
      await render();
    }
    toast(`Saved “${ed.draft.name.trim()}”. New notes use it; notes already made don’t change.`, 'success');
    return true;
  }

  async function discard() {
    const ed = editing();
    if (!ed) return;
    if (ed.isNew) return closeEditor();
    ed.draft = draftOf(tpl(ed.id));
    clearErrors('tpl.');
    await render();
    return focus(['[data-action="meetings-settings-tpl-dup"]', '[data-ms-input="tpl-name"]']);
  }

  /** A copy of a template (of what the editor shows, when it is open on it); the original stays. */
  async function duplicate(id) {
    const t = tpl(id);
    if (!t) throw new Error('This template is no longer there.');
    const d = editing()?.id === id ? editing().draft : draftOf(t);
    const kind = t.kind === 'skill' ? 'skill' : 'custom';
    const name = `${(d.name.trim() || t.name)} (copy)`.slice(0, 80);
    const saved = await mutate('template_save', { kind, ...body({ ...d, name }, kind) });
    v().edit = { id: saved.id, isNew: false, draft: draftOf(tpl(saved.id) || { ...d, name, kind }) };
    clearErrors('tpl.');
    await render();
    focus('[data-ms-input="tpl-name"]');
    toast(`Made a copy: “${name}”. “${t.name}” is as it was.`, 'success');
  }

  /** Where focus goes after a ⋯ menu's step on a template: its ⋯ again, or the editor. */
  const cardFocus = id => [`.ws-ms-tpl-card[data-template="${quoted(id)}"] .ws-menu > summary`, '[data-ms-input="tpl-prompt"]', '[data-ms-input="tpl-name"]'];

  async function makeDefault(id) {
    const t = tpl(id);
    if (!await saveSetting('defaultTemplate', id)) return;
    focus(cardFocus(id));
    toast(`${t?.name || 'This template'} is now the default`, 'success');
  }

  async function reset(id) {
    const t = tpl(id);
    if (!t) return;
    const before = { ...draftOf(t) };
    const unsaved = editing()?.id === id && isDirty(snap(), editing()) ? { ...editing().draft, sections: [...editing().draft.sections] } : null;
    await mutate('template_delete', { id });
    const refresh = async () => {
      if (editing()?.id === id) {
        editing().draft = draftOf(tpl(id));
        clearErrors('tpl.');
        await render();
      }
    };
    await refresh();
    focus(cardFocus(id));
    toast(`“${t.name}” is back to the built-in version`, 'success', {
      label: 'Undo',
      run: async () => {
        await mutate('template_save', { id, ...body(before, 'builtin') });
        await refresh();
        if (unsaved && editing()?.id === id) {
          editing().draft = unsaved;
          await render();
        }
        focus(cardFocus(id));
        toast(`Your version of “${before.name}” is back`, 'success');
      },
    });
  }

  function remove(id) {
    const t = tpl(id);
    if (!t) return undefined;
    const used = sortedRules(snap()).filter(r => r.template === id).length;
    const skill = t.kind === 'skill';
    let deleted = false;
    return confirmModal({
      title: `${skill ? 'Remove' : 'Delete'} “${t.name}”?`,
      text: `Notes already written stay as they are.${used ? ` ${plural(used, 'rule')} using it will switch to your default template.` : ''}`,
      confirm: skill ? 'Remove' : 'Delete', variant: 'danger', initialFocus: 'cancel', guard: true,
      onConfirm: async () => {
        await mutate('template_delete', { id });
        deleted = true;
        if (editing()?.id === id) v().edit = null;
        await render();
        toast(`${skill ? 'Removed' : 'Deleted'} “${t.name}”`, 'success');
      },
      // Once the dialog has closed: New template after a delete, the card's ⋯ otherwise.
      onClose: () => focus(deleted ? '[data-action="meetings-settings-tpl-new"]' : `.ws-ms-tpl-card[data-template="${quoted(id)}"] .ws-menu > summary`),
    });
  }

  // ---------------------------------------------------------------- skills

  async function addSkill() {
    let skills = [];
    try {
      const answer = await store.query('meeting_skills', {});
      skills = Array.isArray(answer) ? answer : [];
    } catch {
      skills = [];
    }
    const have = new Set(templatesOf(snap()).filter(t => t.kind === 'skill').map(t => t.skillPath));
    const free = skills.filter(x => !have.has(x.path));
    const list = skills.length
      ? `<div class="ws-ms-skill-list" role="radiogroup" aria-label="Skills on this Mac">${skills.map(x => {
        const added = have.has(x.path);
        return `<label class="ws-ms-skill-opt${added ? ' ws-ms-off' : ''}"><input type="radio" name="skill" value="${e(x.path)}"${added ? ' disabled' : x === free[0] ? ' checked' : ''}><span class="ws-tpl-icon">${icon('skill')}</span><span><strong>${e(x.name)}${added ? badge('Added', 'success') : ''}</strong>${x.description ? `<small>${e(x.description)}</small>` : ''}<code>${e(x.path)}</code></span></label>`;
      }).join('')}</div>`
      : '<p class="ws-muted ws-hint">No Claude Code skills in ~/.claude/skills yet. Type the full path of a skill’s SKILL.md below.</p>';
    return openModal({
      title: 'Use a skill as a note template', subtitle: 'Claude Code skills on this Mac. A skill’s own instructions decide the notes.', size: 'md', submit: 'Add as template',
      body: `${list}
        <label class="ws-field ws-ms-skill-path"><span class="ws-field-label">${skills.length ? 'Or the full path of a SKILL.md' : 'Full path of a SKILL.md'}</span><input class="ws-input ws-ms-mono" name="path" placeholder="/Users/you/.claude/skills/my-skill/SKILL.md" spellcheck="false" autocomplete="off"><p class="ws-field-error" role="alert" data-error-for="skillPath" hidden></p></label>
        <p class="ws-hint ws-muted">It runs with the Claude chosen for Meeting notes, with the meeting’s transcript as its input. Its output becomes the notes, and tasks are read from it the same way.</p>`,
      onSubmit: async (f, dialog) => {
        const typed = String(f.get('path') || '').trim();
        const path = typed || String(f.get('skill') || '');
        if (!path) throw new Error(skills.length ? 'Choose a skill, or type the path of its SKILL.md.' : 'Type the full path of the skill’s SKILL.md.');
        const known = skills.find(x => x.path === path);
        const name = skillName(known?.name || path.split(/[\\/]/).slice(-2, -1)[0]).slice(0, 80);
        try {
          const saved = await mutate('template_save', { kind: 'skill', name, blurb: String(known?.description || '').slice(0, 300), skillPath: path, sections: [], extractTasks: true });
          toast(`“${name}” is now a note template`, 'success', { label: 'Edit', run: () => editTemplate(saved.id) });
        } catch (err) {
          const shown = fieldOf(err) === 'skillPath' && dialog?.querySelector?.('[data-error-for="skillPath"]');
          if (!shown) throw err;
          shown.textContent = err.message;
          shown.hidden = false;
          dialog.querySelector?.('[name="path"]')?.focus?.();
          return false;
        }
        return true;
      },
    });
  }

  // ---------------------------------------------------------------- Try on a meeting

  async function tryOn() {
    const ed = editing();
    if (!ed || ed.isNew) return undefined;
    const s = snap();
    const t = tpl(ed.id);
    const items = tryableMeetings(s, now());
    if (!items.length) return toast('No meeting has a transcript yet.', 'info');
    const zone = s.settings.timeZone;
    const latest = latestDoc(s, ed.id);
    const pick = latest && items.some(m => m.id === latest.meeting.id) ? latest.meeting.id : items[0].id;
    const dirty = isDirty(s, ed);
    return openModal({
      title: `Try “${t.name}” on a meeting`, subtitle: 'Connect makes notes with this template. Notes made before stay; the same template again adds a version.', size: 'sm',
      submit: dirty ? 'Save and make notes' : 'Make notes', variant: 'magic',
      body: `<label class="ws-field"><span class="ws-field-label">Meeting</span>${select(items.map(m => [m.id, `${m.title} · ${formatDate(m.start, zone, { month: 'short', day: 'numeric' })}, ${formatTime(m.start, zone)}`]), pick, { name: 'meetingId' })}</label>${dirty ? '<p class="ws-hint ws-muted">Your changes are saved first.</p>' : ''}`,
      onSubmit: async f => {
        const meetingId = String(f.get('meetingId') || '');
        const m = items.find(x => x.id === meetingId);
        if (!m) throw new Error('Choose a meeting with a transcript.');
        if (isDirty(snap(), editing()) && !await saveTemplate()) return true;
        const options = { templateId: ed.id, wishes: '', findTasks: tpl(ed.id)?.extractTasks !== false, remember: false };
        if (!await guarded(meetingId, () => makeNotes(meetingId, options))) return true;
        toast(`Making “${tpl(ed.id)?.name || t.name}” for “${m.title}”`, 'success', { label: 'Open meeting', run: () => openMeeting(meetingId, 'notes') });
        return true;
      },
    });
  }

  // ---------------------------------------------------------------- rules

  const ruleSelector = (action, id) => `[data-action="${action}"][data-id="${quoted(id)}"]`;

  /** Saves part of a rule; a refusal shows under the rule's row. */
  async function saveRule(id, data, field) {
    try {
      await mutate('meeting_rule_save', { id, ...data });
    } catch (err) {
      const f = fieldOf(err) || field;
      if (!fieldOf(err)) throw err;
      v().errors[`rule.${id}.${f}`] = err.message;
      if (typeof data.value === 'string') v().drafts[`rule.${id}.value`] = data.value;
      await render();
      return false;
    }
    let changed = false;
    for (const f of Object.keys(data)) {
      const key = `rule.${id}.${f}`;
      if (key in v().errors || key in v().drafts) changed = true;
      delete v().errors[key];
      delete v().drafts[key];
    }
    if (changed) await render();
    return true;
  }

  async function addRule() {
    const saved = await mutate('meeting_rule_save', { field: 'title', value: '', template: meetings().defaultTemplate || 'meeting-notes', autoNotes: false, on: true });
    focus(`[data-commit="meetings-settings-rule-value"][data-id="${quoted(saved.id)}"]`);
  }

  async function moveRule(id, d) {
    const ids = sortedRules(snap()).map(r => r.id);
    const at = ids.indexOf(id);
    const to = at + d;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    await mutate('meeting_rule_order', { ids });
    const action = 'meetings-settings-rule-move';
    focus([`${ruleSelector(action, id)}[data-d="${d}"]:not(:disabled)`, `${ruleSelector(action, id)}[data-d="${-d}"]`]);
  }

  async function deleteRule(id) {
    const list = sortedRules(snap());
    const at = list.findIndex(r => r.id === id);
    const answer = await mutate('meeting_rule_delete', { id });
    clearErrors(`rule.${id}.`);
    const next = list[at + 1] || list[at - 1];
    focus([...(next ? [ruleSelector('meetings-settings-rule-delete', next.id)] : []), '[data-action="meetings-settings-rule-add"]']);
    toast('Rule deleted', 'info', {
      label: 'Undo',
      run: async () => {
        await mutate('meeting_rule_save', { id, ...(answer?.body || {}) });
        focus(ruleSelector('meetings-settings-rule-delete', id));
      },
    });
  }

  function testInput(key, value) {
    const t = v().test;
    if (key === 'test-title') t.title = String(value ?? '');
    else t.people = Math.max(1, Math.min(500, Math.floor(Number(value)) || 1));
    patch('.ws-ms-test-result', ruleTestResult(snap(), t));
  }

  // ---------------------------------------------------------------- glossary and tags

  const timers = {};
  const linked = () => meetings().glossarySource === 'file';
  const textsKey = () => JSON.stringify([meetings().glossarySource, meetings().glossaryFile, meetings().tagsFile, snap().meetingsRoot?.path]);

  /** One text as native read it. `read` is `ok` (all of it: it can be edited), `cut` (longer
   *  than 100 KB: its first 100 KB, read-only) or `failed` (nothing read: never written over). */
  async function readText(name) {
    try {
      const answer = await store.query('meeting_text', { name });
      return { text: String(answer?.text ?? ''), path: answer?.path || null, linked: !!answer?.linked, read: answer?.cut ? 'cut' : 'ok', state: 'idle' };
    } catch (err) {
      return { text: '', path: null, linked: linked(), read: 'failed', readError: err?.message || String(err), state: 'idle' };
    }
  }
  /** Whether a text was read whole, so what is typed may be saved over it. */
  const editable = t => !!t && t.read === 'ok' && !linked();

  async function readTexts() {
    const key = textsKey();
    const view = v();
    const stale = view.textsKey !== key || (linked() && now() - view.textsAt > LINKED_READ_MS);
    if (!stale || Object.values(timers).some(Boolean)) return false;
    view.textsKey = key;
    view.textsAt = now();
    const [glossary, tags] = [await readText('glossary'), await readText('tags')];
    // Typed meanwhile: what was typed stays.
    for (const [name, value] of [['glossary', glossary], ['tags', tags]]) if (!timers[name] && view.texts[name]?.state !== 'saving') view.texts[name] = value;
    return true;
  }

  /** Try again on a text that was not read whole: read it once more and show it. */
  async function rereadText(kind) {
    const view = v();
    if (timers[kind] || !view.texts[kind] || editable(view.texts[kind])) return;
    view.texts[kind] = null;
    patch(`[data-md-card="${kind}"]`, mdEditor(kind, snap(), view));
    const value = await readText(kind);
    if (view.texts[kind] !== null) return;
    view.texts[kind] = value;
    if (state.route === 'settings' && state.settingsTab === 'meetings-glossary') patch(`[data-md-card="${kind}"]`, mdEditor(kind, snap(), view));
    focus([`[data-ms-input="md"][data-k="${kind}"]`, `[data-action="meetings-settings-md-reread"][data-k="${kind}"]`]);
  }

  /** Saves what is typed now; the editor is never re-rendered. */
  async function saveText(kind) {
    timers[kind] = null;
    const t = v().texts[kind];
    if (!editable(t)) return;
    const text = t.text;
    t.state = 'saving';
    patch(`[data-md-status="${kind}"]`, mdStatus(kind, t));
    try {
      const answer = await save('meeting_text_save', { name: kind, text });
      if (v().texts[kind] !== t) return;
      glossaryChanged();
      if (t.text === text) Object.assign(t, { state: 'saved', path: answer?.path || t.path, error: null });
    } catch (err) {
      if (v().texts[kind] !== t) return;
      Object.assign(t, { state: 'error', error: err?.message || String(err) });
    }
    patch(`[data-md-status="${kind}"]`, mdStatus(kind, t));
  }

  function typed(kind, value) {
    const t = v().texts[kind];
    if (!editable(t)) return;
    t.text = String(value ?? '');
    t.state = 'saving';
    patch(`[data-md-summary="${kind}"]`, mdSummary(kind, t.text));
    patch(`[data-md-status="${kind}"]`, mdStatus(kind, t));
    if (timers[kind]) cancel(timers[kind]);
    timers[kind] = later(() => saveText(kind), TEXT_SAVE_MS);
  }

  /** Left the editor: what is typed is saved now. */
  async function flushText(kind) {
    if (!timers[kind]) return;
    cancel(timers[kind]);
    await saveText(kind);
  }

  async function restoreExample(kind) {
    const t = v().texts[kind];
    if (!editable(t)) return;
    if (timers[kind]) {
      cancel(timers[kind]);
      timers[kind] = null;
    }
    const before = t.text;
    const text = exampleText(kind, snap());
    if (before === text) return;
    const answer = await mutate('meeting_text_save', { name: kind, text });
    glossaryChanged();
    Object.assign(t, { text, state: 'saved', path: answer?.path || t.path, error: null });
    await render();
    const what = kind === 'tags' ? 'tag list' : 'glossary';
    toast(`The ${what} is back to the example`, 'success', {
      label: 'Undo',
      run: async () => {
        // Read again since and not read whole: nothing is written over it.
        if (!editable(v().texts[kind])) {
          toast(`Connect can’t read ${kind}.md just now, so Undo didn’t change it. Use Try again on the ${what} first.`, 'error');
          return;
        }
        await mutate('meeting_text_save', { name: kind, text: before });
        glossaryChanged();
        Object.assign(v().texts[kind] || {}, { text: before, state: 'saved' });
        await render();
      },
    });
  }

  // ---------------------------------------------------------------- reads

  /** Reads what the open tab shows and isn't read yet (the texts, the latest document) and puts
   *  it in place: only those cards are replaced, so a field being typed in is never touched. */
  async function load() {
    if (state.route !== 'settings') return;
    const tab = state.settingsTab;
    const here = () => state.route === 'settings' && state.settingsTab === tab;
    if (tab === 'meetings-glossary' && await readTexts() && here()) {
      for (const kind of ['glossary', 'tags']) patch(`[data-md-card="${kind}"]`, mdEditor(kind, snap(), v()));
    }
    const ed = editing();
    if (tab !== 'meetings-templates' || !ed || ed.isNew) return;
    const found = latestDoc(snap(), ed.id);
    const key = found && latestKey(found);
    if (!found || key in v().latest) return;
    v().latest[key] = null;
    try {
      const answer = await store.query('meeting_read', { meetingId: found.meeting.id, part: 'doc', docId: found.doc.id });
      v().latest[key] = { text: String(answer?.text ?? '') };
    } catch (err) {
      v().latest[key] = { error: { code: err?.code || 'error', message: err?.message || String(err) } };
    }
    if (here() && editing() === ed) patch('.ws-ms-latest', latestCard(snap(), ed, { v: v(), now: now(), tryable: tryableMeetings(snap(), now()).length }));
  }

  // ---------------------------------------------------------------- events

  /** The `meetings-settings-*` actions; `el` is the control. */
  async function handle(action, el) {
    const id = el.dataset?.id;
    const ed = editing();
    el.closest?.('details')?.removeAttribute('open');
    switch (action) {
      case 'meetings-settings-set': {
        const key = el.dataset.key;
        if (el.type === 'radio' && !el.checked) return undefined;
        const ok = await saveSetting(key, valueOf(el), { el });
        if (ok && key === 'glossarySource') {
          v().textsKey = '';
          glossaryChanged();
          toast(el.value === 'file' ? 'Connect reads the glossary and tags from your own files.' : 'The glossary and tags live here in Connect again.', 'success');
        }
        return undefined;
      }
      case 'meetings-settings-field': return commitField(el);
      case 'meetings-settings-transcripts': return transcripts(el);
      case 'meetings-settings-root-pick': return pickFolder();
      case 'meetings-settings-root-default': {
        const before = meetings().root ?? null;
        const answer = await saveSetting('root', null);
        if (!answer) return undefined;
        return rootMoved('the default folder again', answer, () => saveSetting('root', before));
      }
      case 'meetings-settings-root-reveal': return reveal();
      // "When you open a meeting"
      case 'meetings-settings-open-on': return saveSetting('openOn', el.dataset.v);
      case 'meetings-settings-pin': return pinTab(el.dataset.pin);
      case 'meetings-settings-unpin': return unpinTab(el.dataset.pin);
      case 'meetings-settings-pin-move': return movePin(el.dataset.pin, Number(el.dataset.d) < 0 ? -1 : 1);
      // Templates
      case 'meetings-settings-tpl-edit': return editTemplate(id);
      case 'meetings-settings-tpl-new': return newTemplate();
      case 'meetings-settings-tpl-close': return closeEditor();
      case 'meetings-settings-tpl-save': return saveTemplate();
      case 'meetings-settings-tpl-discard': return discard();
      case 'meetings-settings-tpl-dup': return duplicate(id || ed?.id);
      case 'meetings-settings-tpl-default': return makeDefault(id);
      case 'meetings-settings-tpl-reset': return reset(id);
      case 'meetings-settings-tpl-delete': return remove(id);
      case 'meetings-settings-tpl-try': return tryOn();
      case 'meetings-settings-tpl-color':
        if (!ed) return undefined;
        ed.draft.color = el.dataset.c;
        clearError('tpl.color');
        patch('.ws-ms-swatches', swatches(ed.draft.color));
        return liveEditor();
      case 'meetings-settings-tpl-section': {
        if (!ed) return undefined;
        const section = el.dataset.s;
        ed.draft.sections = el.checked ? [...ed.draft.sections.filter(x => x !== section), section] : ed.draft.sections.filter(x => x !== section);
        clearError('tpl.sections');
        return liveEditor();
      }
      case 'meetings-settings-tpl-tasks':
        if (!ed) return undefined;
        ed.draft.extractTasks = !!el.checked;
        return liveEditor();
      case 'meetings-settings-tpl-var': {
        if (!ed) return undefined;
        const value = insertText('[data-ms-input="tpl-prompt"]', el.dataset.v);
        if (value === null || value === undefined) return undefined;
        ed.draft.prompt = value;
        clearError('tpl.prompt');
        patch('[data-ms-words]', wordsHint(value));
        return liveEditor();
      }
      case 'meetings-settings-skill-add': return addSkill();
      case 'meetings-settings-copy':
        await writeText(el.dataset.text || '');
        return toast('Path copied', 'success');
      case 'meetings-settings-open-doc': return openMeeting(id, 'notes');
      case 'meetings-settings-open-line': return openMeeting(id, 'transcript', el.dataset.t || null);
      // Rules
      case 'meetings-settings-rule-add': return addRule();
      case 'meetings-settings-rule-set': return saveRule(id, { [el.dataset.k]: el.value }, el.dataset.k);
      case 'meetings-settings-rule-flag': return saveRule(id, { [el.dataset.k]: !!el.checked }, el.dataset.k);
      case 'meetings-settings-rule-value': {
        const value = String(el.value ?? '').trim();
        const rule = sortedRules(snap()).find(r => r.id === id);
        if (!rule || (String(rule.value ?? '') === value && !(`rule.${id}.value` in v().drafts))) return undefined;
        return saveRule(id, { value }, 'value');
      }
      case 'meetings-settings-rule-move': return moveRule(id, Number(el.dataset.d) < 0 ? -1 : 1);
      case 'meetings-settings-rule-delete': return deleteRule(id);
      // Glossary and tags
      case 'meetings-settings-md-tab':
        v().mdTab[el.dataset.k] = el.dataset.v === 'preview' ? 'preview' : 'write';
        await flushText(el.dataset.k);
        await render();
        return focus(`[data-action="meetings-settings-md-tab"][data-k="${quoted(el.dataset.k)}"][data-v="${quoted(v().mdTab[el.dataset.k])}"]`);
      case 'meetings-settings-md-flush': return flushText(el.dataset.k);
      case 'meetings-settings-md-reset': return restoreExample(el.dataset.k);
      case 'meetings-settings-md-reread': return rereadText(el.dataset.k);
      default: return undefined;
    }
  }

  /** Typing: the template editor, the Markdown editors and the rule tester update in place. */
  function input(el) {
    const kind = el?.dataset?.msInput;
    if (!kind) return false;
    const ed = editing();
    switch (kind) {
      case 'tpl-name': case 'tpl-blurb': case 'tpl-prompt': case 'tpl-skill': {
        if (!ed) return true;
        const field = { 'tpl-name': 'name', 'tpl-blurb': 'blurb', 'tpl-prompt': 'prompt', 'tpl-skill': 'skillPath' }[kind];
        ed.draft[field] = String(el.value ?? '');
        clearError(`tpl.${field}`);
        if (field === 'prompt') patch('[data-ms-words]', wordsHint(ed.draft.prompt));
        liveEditor();
        return true;
      }
      case 'md': typed(el.dataset.k, el.value); return true;
      case 'test-title': case 'test-people': testInput(kind, el.value); return true;
      default: return false;
    }
  }

  return { handle, input, load, editTemplate, leaveEditor };
}
