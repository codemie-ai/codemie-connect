// The Meetings controller (spec "Meetings page"): opening a meeting from anywhere (`open`), the
// list's filters, selection and ↑/↓, the five tabs, Make notes (one meeting, for all, Try again),
// Check now, Download again, Import, speakers, the template and automatic notes, documents (view,
// Side by side, versions, main, delete, edit against the version it was opened on), files, and
// the right next step for every error. It keeps a per-meeting cache of `meeting_read` answers
// that a change of the meeting record's revision empties. app.js routes the `meeting-*` and
// `doc-*` actions here; everything it touches is injected, so node:test drives it without a
// browser. No optimistic updates: every change is an operation and the snapshot after it.
import { DEFAULT_FILTERS } from './tasks-model.js';
import { formatDate, formatTime } from './format.js';
import {
  TABS, failedNotesJob, laneFor, lineAt, meetingItems, meetingRows, meetingTasks, parseGlossary, resolveTemplate, rulesOf,
} from './meetings-model.js';
import { importBody, makeNotesBody } from './view-meetings.js';

const quoted = value => String(value).replace(/["\\]/g, '\\$&');
const IMPORT_MAX = 5 * 1024 * 1024;
const GLOSSARY_FOR_MS = 60_000;
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
/** A friendly error that keeps the code the next step depends on. */
const problemOf = (code, message) => Object.assign(new Error(message), { code });

/**
 * `state.meetings` is the page's view state (`newMeetingsView()`); `snap()` the snapshot;
 * `store.query(op, data)` a read-only operation; `mutate(op, data)` a fenced write that
 * re-renders; `render()` a re-render; `route(name, tab)` navigation (it writes the hash); the
 * dialogs and `toast(message, tone, {label, run})`; `writeText` the clipboard; `downloadText(name,
 * text)` a file in Downloads; `focus(selectors)` focus after a render; `setPref` remembers whether
 * the list is hidden; `syncHash()` writes `#/meetings/<id>/<tab>` after a selection or tab change;
 * `ensureClaudeChoice()` asks which Claude writes (null when cancelled); `moveTask(id, status,
 * {log})` the Tasks board's move; `connect(capabilities)` a Microsoft sign-in for more access;
 * `showEvent(id)` the calendar's event card; `canRender()` whether a read may re-render now.
 */
export function createMeetingsController({
  state, store, snap, mutate, render, route = async () => {}, openModal = () => null, confirmModal = () => {}, toast = () => {},
  writeText = async () => {}, downloadText = () => {}, focus = () => {}, setPref = () => {}, syncHash = () => {}, now = () => Date.now(),
  ensureClaudeChoice = async () => null, moveTask = null, connect = null, showEvent = null, canRender = () => true,
}) {
  const v = () => state.meetings;
  const items = () => meetingItems(snap(), now());
  const item = id => items().find(m => m.id === id) || null;
  const record = id => snap().records.find(r => r.kind === 'meeting' && r.id === id) || null;
  const docOf = (id, docId) => (record(id)?.data?.docs || []).find(d => d.id === docId) || null;
  const titleOf = id => item(id)?.title || record(id)?.data?.title || 'this meeting';
  const missing = () => new Error('This meeting is no longer in your calendar. Refresh and try again.');

  // ---------------------------------------------------------------- reads

  /** id → {rev, transcript, files, docs: {key: {text}|{error}}, pending}; `rev` is the meeting
   *  record's revision when it was read (a new revision empties it). */
  const cache = new Map();
  let glossaryRead = { at: 0, value: null, pending: false };
  const revOf = id => record(id)?.revision || '';
  function entry(id) {
    let c = cache.get(id);
    if (!c || c.rev !== revOf(id)) {
      c = { rev: revOf(id), transcript: undefined, files: undefined, docs: {}, pending: new Set() };
      cache.set(id, c);
    }
    return c;
  }
  /** What has been read for a meeting (nothing when its record changed since). */
  function data(id) {
    const c = cache.get(id);
    return c && c.rev === revOf(id) ? c : {};
  }
  const docKey = (docId, version) => (version ? `${docId}@${version}` : docId);

  /** Reads one part of a meeting folder into the cache; true when it read something new. */
  async function read(id, key, request) {
    const c = entry(id);
    if (c.pending.has(key)) return false;
    c.pending.add(key);
    let value;
    try {
      value = await store.query('meeting_read', { meetingId: id, ...request });
    } catch (err) {
      value = { error: { code: err?.code || 'error', message: err?.message || String(err) } };
    } finally {
      c.pending.delete(key);
    }
    if (cache.get(id) !== c) return false;
    if (key === 'transcript') c.transcript = value?.error ? value : { segments: Array.isArray(value?.segments) ? value.segments : [] };
    else if (key === 'files') c.files = value?.error ? value : { files: Array.isArray(value?.files) ? value.files : [] };
    else c.docs[key.slice(4)] = value?.error ? value : { text: String(value?.text ?? '') };
    return true;
  }

  const glossary = () => glossaryRead.value;
  /** The glossary changed (Settings › Meetings): the next transcript read takes it again. */
  const forgetGlossary = () => { glossaryRead = { at: 0, value: null, pending: false }; };
  async function loadGlossary() {
    if (glossaryRead.pending || now() - glossaryRead.at < GLOSSARY_FOR_MS) return false;
    glossaryRead.pending = true;
    try {
      const answer = await store.query('meeting_text', { name: 'glossary' });
      glossaryRead = { at: now(), value: parseGlossary(answer?.text || ''), pending: false };
      return true;
    } catch {
      glossaryRead = { at: now(), value: null, pending: false };
      return false;
    }
  }

  /** The selected meeting, or the first in the list when there is none (or it is gone). */
  function ensureSelection() {
    const s = snap();
    const all = meetingItems(s, now());
    if (v().selected && all.some(m => m.id === v().selected)) return v().selected;
    v().selected = meetingRows(s, v().filter, v().q, v().showNone, now(), all)[0]?.id || null;
    return v().selected;
  }

  /** Reads what the open meeting's tab shows that isn't read yet, then re-renders once. */
  async function load() {
    if (state.route !== 'meetings') return;
    const id = v().selected;
    const m = id && item(id);
    if (!m) return;
    const rec = m.rec?.data || {};
    const saved = ['downloaded', 'ready', 'failed'].includes(m.state) && !!rec.folder;
    const c = entry(id);
    const jobs = [];
    if (saved && c.transcript === undefined) jobs.push(read(id, 'transcript', { part: 'transcript' }));
    if (v().tab === 'transcript') jobs.push(loadGlossary());
    if (v().tab === 'files' && rec.folder && c.files === undefined) jobs.push(read(id, 'files', { part: 'files' }));
    if (v().tab === 'notes' && saved) {
      const docs = rec.docs || [];
      const view = docs.find(d => d.id === v().docView[id]) || docs.find(d => d.id === rec.main) || docs[0];
      const shown = view ? [view] : [];
      if (v().compare && docs.length > 1) shown.push(docs.find(d => d.id === v().compareWith[id] && d.id !== view.id) || docs.find(d => d.id !== view.id));
      for (const doc of shown) if (doc && c.docs[doc.id] === undefined) jobs.push(read(id, `doc:${doc.id}`, { part: 'doc', docId: doc.id }));
      const version = view && Number(v().version[`${id}:${view.id}`]);
      if (version && c.docs[docKey(view.id, version)] === undefined) jobs.push(read(id, `doc:${docKey(view.id, version)}`, { part: 'doc', docId: view.id, version }));
    }
    if (!jobs.length) return;
    const results = await Promise.all(jobs);
    if (results.some(Boolean) && state.route === 'meetings' && canRender()) await render();
  }

  /** The text of a document as shown (an earlier version while one is read), read if needed. */
  async function docText(id, docId, version = null) {
    const c = entry(id);
    const key = docKey(docId, version);
    if (!c.docs[key] || c.docs[key].error) await read(id, `doc:${key}`, { part: 'doc', docId, ...(version ? { version } : {}) });
    const got = entry(id).docs[key];
    if (!got || got.error) throw problemOf(got?.error?.code || 'error', got?.error?.message || 'This document couldn’t be read.');
    return got.text;
  }

  // ---------------------------------------------------------------- navigation

  async function rerender() {
    syncHash();
    await render();
  }

  /** Opens a meeting on the Meetings page (Today, the calendar, a task, a notification): the
   *  filter switches when it doesn't show the meeting, `tab` opens (the same meeting keeps its
   *  tab), `line` highlights a transcript line. */
  async function open(id, tab = null, line = null) {
    const m = item(id);
    if (!m) {
      toast('This meeting is no longer in your calendar.', 'error');
      return;
    }
    const view = v();
    const same = view.selected === id;
    if (!same) leave(view.selected);
    Object.assign(view, laneFor(m, view.filter, view.showNone), {
      q: '', selected: id,
      tab: TABS.includes(tab) ? tab : same ? view.tab : 'notes',
      focusLine: Number.isInteger(line) ? line : null,
    });
    if (!same || Number.isInteger(line)) Object.assign(view, { tq: '', speaker: '' });
    if (!same) view.peopleAll = null;
    await route('meetings');
    focus([`[data-action="meeting-select"][data-id="${quoted(id)}"]`]);
  }

  async function select(id) {
    const view = v();
    if (view.selected !== id) {
      leave(view.selected);
      Object.assign(view, { selected: id, tq: '', speaker: '', focusLine: null, peopleAll: null });
    }
    await rerender();
  }

  function setCompare(on) {
    const view = v();
    if (on && !view.compare) {
      view.wideBefore = view.wide;
      view.wide = true;
    }
    if (!on && view.compare) view.wide = !!view.wideBefore;
    view.compare = on;
  }

  /** ↑/↓ on the list moves the selection (not while typing, in a dialog or in the meeting). */
  async function key(ev) {
    if (!['ArrowDown', 'ArrowUp'].includes(ev.key) || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return false;
    const target = ev.target;
    if (target?.closest?.('input, textarea, select, dialog, .ws-mtg-detail, details[open]')) return false;
    const view = v();
    const rows = meetingRows(snap(), view.filter, view.q, view.showNone, now()).map(m => m.id);
    if (!rows.length) return false;
    ev.preventDefault?.();
    const at = rows.indexOf(view.selected);
    const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (ev.key === 'ArrowDown' ? 1 : -1)))];
    if (next !== view.selected) await select(next);
    focus([`[data-action="meeting-select"][data-id="${quoted(next)}"]`]);
    return true;
  }

  // ---------------------------------------------------------------- errors and Claude

  /** Runs an AI operation; when no Claude is chosen yet, asks once and runs it again. */
  async function withChoice(run) {
    try {
      return await run();
    } catch (err) {
      if (err?.code !== 'needs_choice' && err?.class !== 'needs_choice') throw err;
      if (await ensureClaudeChoice()) return run();
      throw problemOf('needs_choice', 'Choose which Claude writes your meeting notes.');
    }
  }

  /** The way on from an error, as a toast with the action that fixes it; other errors go on. */
  function problem(err, id) {
    switch (err?.code) {
      case 'needs_choice':
        return toast('Choose which Claude writes your meeting notes.', 'error', { label: 'Open Settings › Claude', run: () => route('settings', 'ai') });
      case 'folder_missing':
        return toast(`The folder of “${titleOf(id)}” is gone.`, 'error', id && record(id)?.data?.transcriptIds?.length && !record(id)?.data?.imported ? { label: 'Download again', run: () => download(id) } : { label: 'Import', run: () => importDialog(id) });
      case 'folder_unwritable':
        return toast(err.message || 'Connect can’t write to the meetings folder.', 'error', { label: 'Open Settings › Meetings', run: () => route('settings', 'meetings-transcripts') });
      case 'transcript_missing':
        return toast(err.message || 'Teams no longer has this transcript. Import the file instead.', 'error', { label: 'Import', run: () => importDialog(id) });
      case 'transcript_blocked':
        return toast(err.message || 'The organizer’s Teams doesn’t share this transcript.', 'error', { label: 'Import', run: () => importDialog(id) });
      case 'permission_required':
        return toast('Connect needs your permission to read Teams transcripts.', 'error', connect ? { label: 'Turn on', run: () => transcriptsOn() } : null);
      case 'needs_login':
        // A meeting operation answers needs_login for the Microsoft account (target(),
        // active_workspace); only an error that carries Claude's class is Claude's sign-in.
        if (err.class === 'needs_login') return toast(err.message || 'Claude needs you to sign in again.', 'error', { label: 'Open Settings › Claude', run: () => route('settings', 'ai') });
        return toast(err.message || 'Microsoft 365 needs you to sign in again.', 'error', { label: 'Sign in to Microsoft', run: () => (connect ? connect([]) : route('settings', 'microsoft')) });
      default:
        throw err;
    }
  }

  /** Runs a step; a failure shows its next step. True only when it worked, so a success toast
   *  can never follow a failure. */
  async function guarded(id, run) {
    try {
      await run();
      return true;
    } catch (err) {
      problem(err, id);
      return false;
    }
  }

  // ---------------------------------------------------------------- notes

  async function makeNotes(id, { templateId, wishes = '', findTasks = true, remember = false }) {
    if (!templateId) throw new Error('Choose a note template.');
    return withChoice(() => mutate('meeting_notes', { meetingId: id, templateId, wishes, findTasks, remember }));
  }

  const formOptions = f => ({
    templateId: String(f.get('template') || ''),
    wishes: String(f.get('wishes') || '').trim(),
    findTasks: f.get('findTasks') === 'on',
    remember: f.get('remember') === 'on',
  });

  function makeNotesDialog(id) {
    const m = item(id);
    if (!m) throw missing();
    const s = snap();
    const zone = s.settings.timeZone;
    const docs = m.rec?.data?.docs || [];
    const dialog = openModal({
      title: docs.length ? 'Another summary' : 'Make notes',
      subtitle: `${m.title} · ${formatDate(m.start, zone, { weekday: 'short', month: 'short', day: 'numeric' })}, ${formatTime(m.start, zone)}`,
      body: makeNotesBody(s, m, { now: now(), reads: data }),
      submit: 'Make notes', variant: 'magic', size: 'lg',
      onSubmit: async f => {
        const options = formOptions(f);
        await makeNotes(id, options);
        const name = (s.noteTemplates || []).find(t => t.id === options.templateId)?.name || 'notes';
        toast(docs.length ? `Making “${name}” next to your notes` : `Making ${name} for “${m.title}”`, 'success');
      },
    });
    dialog?.classList?.add('ws-mtg-make-modal');
    return dialog;
  }

  /** Make notes for every transcript without notes, each with its own template. */
  async function makeAll() {
    const s = snap();
    const rules = rulesOf(s);
    const todo = meetingItems(s, now()).filter(m => (m.state === 'available' || m.state === 'downloaded') && !m.run);
    let made = 0;
    for (const m of todo) {
      const templateId = resolveTemplate(m.ev, m.rec, s, rules).id;
      // The first failure shows its fix and stops the rest, which would mostly fail the same way
      // (no Claude chosen, signed out); the ones already queued are counted.
      if (!await guarded(m.id, () => makeNotes(m.id, { templateId, wishes: '', findTasks: true, remember: false }))) break;
      made++;
    }
    if (!made) return;
    toast(made === todo.length ? `Making notes for ${plural(made, 'meeting')}. Each uses its own template.` : `Making notes for ${made} of ${plural(todo.length, 'meeting')}. Each uses its own template.`, 'success');
  }

  async function retry(id) {
    const m = item(id);
    if (!m) throw missing();
    const job = failedNotesJob(snap(), id);
    const templateId = job?.payload?.templateId || resolveTemplate(m.ev, m.rec, snap()).id;
    await makeNotes(id, { templateId, wishes: job?.payload?.wishes || '', findTasks: job?.payload?.findTasks !== false, remember: false });
    toast(`Trying “${m.title}” again`, 'success');
  }

  async function download(id) {
    await mutate('meeting_download', { meetingId: id });
    toast(`Getting the transcript of “${titleOf(id)}” from Teams`, 'success');
  }

  // ---------------------------------------------------------------- import

  function wireDrop(dialog) {
    const input = dialog?.querySelector?.('input[type=file]');
    const zone = dialog?.querySelector?.('[data-drop-file]');
    const label = dialog?.querySelector?.('.ws-mtg-drop-file');
    if (!input || !zone || !label) return;
    const show = () => {
      const file = input.files?.[0];
      label.hidden = !file;
      zone.classList.toggle('ws-mtg-has-file', !!file);
      if (file) label.textContent = `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
    };
    input.addEventListener('change', show);
    zone.addEventListener('dragover', ev => { ev.preventDefault(); zone.classList.add('ws-mtg-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('ws-mtg-over'));
    zone.addEventListener('drop', ev => {
      ev.preventDefault();
      zone.classList.remove('ws-mtg-over');
      if (ev.dataTransfer?.files?.length) {
        input.files = ev.dataTransfer.files;
        show();
      }
    });
  }

  function importDialog(id) {
    const m = id ? item(id) : null;
    const dialog = openModal({
      title: 'Import a transcript', subtitle: 'For a meeting Teams won’t give you, or one recorded elsewhere.', size: 'md', submit: 'Import',
      body: importBody(snap(), m, { now: now() }),
      onSubmit: async f => {
        const meetingId = String(f.get('meetingId') || '');
        const file = f.get('file');
        if (!meetingId) throw new Error('Choose the meeting this transcript belongs to.');
        if (!file || typeof file === 'string' || !file.name) throw new Error('Choose a .vtt or .txt file.');
        if (!/\.(vtt|txt)$/i.test(file.name)) throw new Error('Import a Teams .vtt or a .txt transcript.');
        if (file.size > IMPORT_MAX) throw new Error('This file is larger than 5 MB. Import a smaller transcript.');
        await mutate('meeting_import', { meetingId, fileName: file.name, text: await file.text() });
        toast(`Imported ${file.name}. Check the speakers, then make notes.`, 'success');
        await open(meetingId, 'transcript');
      },
    });
    wireDrop(dialog);
    return dialog;
  }

  // ---------------------------------------------------------------- documents

  function startEdit(id, docId) {
    const doc = docOf(id, docId);
    if (!doc) throw new Error('This document is no longer there.');
    return docText(id, docId).then(text => {
      v().editing = { meetingId: id, docId, version: doc.version, rev: doc.rev, draft: text, conflict: null, mine: null };
      return render().then(() => focus('#meeting-doc-editor'));
    });
  }

  async function saveEdit(id, docId) {
    const ed = v().editing;
    if (!ed || ed.meetingId !== id || ed.docId !== docId) return;
    const doc = docOf(id, docId);
    try {
      await mutate('meeting_doc', { meetingId: id, docId, action: 'edit', text: ed.draft, baseVersion: ed.version, baseRev: ed.rev });
    } catch (err) {
      if (err?.code !== 'conflict') throw err;
      // Changed meanwhile: show the newer text; the person's edit stays and nothing is overwritten.
      cache.delete(id);
      const text = await docText(id, docId).catch(() => '');
      const latest = docOf(id, docId) || doc;
      ed.conflict = { text, version: latest?.version, rev: latest?.rev };
      await render();
      return;
    }
    v().editing = null;
    await render();
    toast(`Saved to ${doc?.file || 'the meeting folder'}`, 'success');
  }

  async function deleteDoc(id, docId) {
    const doc = docOf(id, docId);
    if (!doc) throw new Error('This document is no longer there.');
    const kept = (doc.versions || []).length;
    confirmModal({
      title: `Delete “${doc.name}”?`,
      text: `The document${kept ? ` and its ${plural(kept, 'earlier version')}` : ''} move to notes-history in the meeting folder. The transcript, the other documents and the tasks stay.`,
      confirm: 'Delete document', variant: 'danger', initialFocus: 'cancel', guard: true,
      onConfirm: async () => {
        await mutate('meeting_doc', { meetingId: id, docId, action: 'delete' });
        const view = v();
        if (view.docView[id] === docId) delete view.docView[id];
        if ((record(id)?.data?.docs || []).length < 2) setCompare(false);
        toast(`“${doc.name}” moved to notes-history`, 'success');
      },
    });
  }

  // ---------------------------------------------------------------- the rest

  async function transcriptsOn() {
    if (!connect) return route('settings', 'microsoft');
    return confirmModal({
      title: 'Read Teams transcripts?',
      text: 'Microsoft opens in your browser and asks you to allow Connect to find your Teams meetings and read their transcripts. Transcripts are saved in your meetings folder; nothing goes to Claude until you make notes.',
      confirm: 'Continue to Microsoft',
      onConfirm: () => connect(['meetings', 'transcripts']),
    });
  }

  function askMessage(id) {
    const m = item(id);
    const d = m?.ev?.data || {};
    const organizer = d.organizer?.name || 'there';
    const first = organizer.includes(',') ? organizer.split(',')[1].trim().split(/\s+/)[0] : organizer.split(/\s+/)[0];
    const s = snap();
    const when = m ? formatDate(m.start, s.settings.timeZone, { weekday: 'long', month: 'long', day: 'numeric' }) : '';
    const me = s.connection?.givenName || (s.connection?.displayName || '').split(/\s+/)[0] || '';
    return `Hi ${first}, could you send me the transcript of “${m?.title || 'our meeting'}”${when ? ` (${when})` : ''}? In Teams: open the meeting › Recap › Transcript › Download (.vtt). My company’s Teams can’t read yours. Thanks!${me ? ` — ${me}` : ''}`;
  }

  async function gotoLine(id, ref, line) {
    const view = v();
    let index = Number.isInteger(line) ? line : null;
    if (index === null && ref) {
      if (entry(id).transcript === undefined) await read(id, 'transcript', { part: 'transcript' });
      const segments = entry(id).transcript?.segments || [];
      const at = lineAt(segments, ref);
      index = at >= 0 ? at : null;
    }
    Object.assign(view, { selected: id, tab: 'transcript', tq: '', speaker: '', focusLine: index });
    await rerender();
  }

  async function acceptAll(id) {
    const review = meetingTasks(snap(), id).filter(t => t.data.status === 'review');
    for (const t of review) {
      if (moveTask) await moveTask(t.id, 'todo', { log: 'Accepted from review' });
      else await mutate('task_save', { id: t.id, status: 'todo', log: 'Accepted from review' });
    }
    if (review.length) toast(`${plural(review.length, 'task')} accepted. They’re on your board.`, 'success');
  }

  async function addTask(id, f) {
    const text = String(f.get('text') || '').trim();
    if (!text) return focus(`[data-form="meeting-task"][data-id="${quoted(id)}"] [name=text]`);
    const owner = String(f.get('owner') || '').trim();
    const name = owner ? (item(id)?.ev?.data?.attendees || []).concat(item(id)?.ev?.data?.organizer || []).find(p => String(p?.address || '').toLowerCase() === owner.toLowerCase())?.name || null : null;
    await mutate('task_save', { text, owner: owner || null, ownerName: name || (owner === snap().connection?.email ? snap().connection?.displayName : null), status: 'todo', meetingId: id });
    focus(`[data-form="meeting-task"][data-id="${quoted(id)}"] [name=text]`);
    return null;
  }

  async function filePreview(id, name) {
    const text = await fileText(id, name);
    const folder = record(id)?.data?.folder || '';
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    openModal({ title: name, subtitle: folder, size: 'lg', submit: 'Save a copy', cancel: 'Close', body: `<pre class="ws-mtg-pre">${esc(text)}</pre>`, onSubmit: () => { downloadText(name, text); } });
  }

  async function fileText(id, name) {
    const answer = await store.query('meeting_read', { meetingId: id, part: 'file', name });
    return String(answer?.text ?? '');
  }

  /** The `meeting-*` and `doc-*` actions; `el` is the control (its dataset, value, checked). */
  async function handle(action, el) {
    const id = el.dataset?.id || v().selected;
    const docId = el.dataset?.doc;
    el.closest?.('details')?.removeAttribute('open');
    const view = v();
    switch (action) {
      case 'meeting-select': return select(id);
      case 'meeting-filter': {
        view.filter = el.dataset.filter || 'all';
        const rows = meetingRows(snap(), view.filter, view.q, view.showNone, now());
        if (!rows.some(m => m.id === view.selected)) {
          leave(view.selected);
          view.selected = rows[0]?.id || null;
        }
        return rerender();
      }
      case 'meeting-show-none': view.showNone = !!el.checked; return render();
      case 'meeting-tab': {
        if (el.dataset.id) view.selected = el.dataset.id;
        view.tab = TABS.includes(el.dataset.tab) ? el.dataset.tab : 'notes';
        await rerender();
        return focus(`[data-action="meeting-tab"][data-tab="${quoted(view.tab)}"][role="tab"]`);
      }
      case 'meeting-list-toggle':
        view.wide = !view.wide;
        if (!view.wide && view.compare) view.compare = false;
        setPref('codemie.meetings.wide', String(view.wide));
        return render();
      case 'meeting-people-all': view.peopleAll = id; return render();
      case 'meeting-compare': setCompare(el.dataset.v === '1'); return render();
      case 'meeting-open': return open(id);
      case 'meeting-make-notes': return makeNotesDialog(id);
      case 'meeting-make-all': return makeAll();
      case 'meeting-retry': return guarded(id, () => retry(id));
      case 'meeting-check':
        return guarded(id, async () => {
          await mutate('meeting_check', { meetingId: id });
          toast(`Checking Teams for the transcript of “${titleOf(id)}”`, 'success');
        });
      case 'meeting-check-all': {
        const waiting = meetingItems(snap(), now()).filter(m => m.state === 'pending' && !m.run);
        if (!waiting.length) return toast('No meeting is waiting for a transcript.', 'info');
        let checked = 0;
        // As Make notes for all: the first failure shows its fix and stops the rest.
        for (const m of waiting) {
          if (!await guarded(m.id, () => mutate('meeting_check', { meetingId: m.id }))) break;
          checked++;
        }
        return checked ? toast(`Checking Teams for ${checked === waiting.length ? plural(checked, 'transcript') : `${checked} of ${plural(waiting.length, 'transcript')}`}`, 'success') : undefined;
      }
      case 'meeting-download': return guarded(id, () => download(id));
      case 'meeting-import': return importDialog(el.dataset?.id || null);
      case 'meeting-auto': {
        const on = !!el.checked;
        const m = item(id);
        await mutate('meeting_set', { meetingId: id, auto: on });
        return toast(on ? (m?.state === 'pending' ? `Notes for “${m.title}” will be made as soon as Teams has the transcript.` : `Notes for “${m?.title || 'this meeting'}” will be made automatically after it ends.`) : 'You’ll make these notes yourself.', 'success');
      }
      case 'meeting-template': {
        const template = el.dataset.template || null;
        await mutate('meeting_set', { meetingId: id, template });
        const name = (snap().noteTemplates || []).find(t => t.id === template)?.name;
        return toast(template ? `“${titleOf(id)}” will use ${name || 'this template'}` : 'Back to the automatic choice', 'success');
      }
      case 'meeting-template-remember': {
        const m = item(id);
        if (!m) throw missing();
        const tpl = resolveTemplate(m.ev, m.rec, snap());
        const orders = rulesOf(snap()).map(r => Number(r.order) || 0);
        await mutate('meeting_rule_save', { field: 'title', value: m.title.trim().slice(0, 200), template: tpl.id, autoNotes: false, on: true, order: orders.length ? Math.min(...orders) - 1 : 0 });
        if (m.rec?.data?.template) await mutate('meeting_set', { meetingId: id, template: null });
        return toast(`Rule added: “${m.title}” always uses ${tpl.template.name}`, 'success');
      }
      case 'meeting-reveal':
        try {
          await store.query('meetings_reveal', { meetingId: id });
        } catch (err) {
          problem(err, id);
        }
        return undefined;
      case 'meeting-copy-folder': {
        const folder = record(id)?.data?.folder;
        if (!folder) return undefined;
        await writeText(folder);
        return toast('Folder path copied', 'success');
      }
      case 'meeting-copy-ask':
        await writeText(askMessage(id));
        return toast('Message copied — paste it in Teams', 'success');
      case 'meeting-speaker': {
        if (!el.value) return undefined;
        const voice = el.dataset.voice;
        await mutate('meeting_speakers', { meetingId: id, voice, address: el.value });
        const name = el.selectedOptions?.[0]?.textContent || el.value;
        return toast(`${voice} is ${name}`, 'success');
      }
      case 'meeting-speaker-filter': view.speaker = el.dataset.key || ''; return render();
      case 'meeting-goto-line': return gotoLine(id, el.dataset.t || null, el.dataset.line !== undefined && el.dataset.line !== '' ? Number(el.dataset.line) : null);
      case 'meeting-cancel':
        try {
          const kind = (snap().jobs || []).find(j => j.id === el.dataset.id)?.kind;
          await mutate('job_cancel', { id: el.dataset.id });
          // A stopped save is not started again by the round (native keeps it on the meeting).
          toast(kind === 'transcript_download' ? 'Stopped saving the transcript. Connect won’t try again by itself: use Try again when you want it.' : 'Stopped. Nothing in the folder changed.');
        } catch (err) {
          if (err?.code !== 'conflict') throw err;
        }
        return undefined;
      case 'meeting-calendar': return showEvent ? showEvent(id) : route('calendar');
      case 'meeting-board':
        state.tasks.filters = { ...DEFAULT_FILTERS, meeting: id };
        return route('tasks');
      case 'meeting-tasks-accept': return acceptAll(id);
      case 'meeting-reload': cache.delete(id); return load();
      case 'meeting-file-preview': return filePreview(id, el.dataset.file).catch(err => problem(err, id));
      case 'meeting-file-save': {
        const text = await fileText(id, el.dataset.file).catch(err => { problem(err, id); return null; });
        if (text === null) return undefined;
        downloadText(el.dataset.file, text);
        return toast(`Saved ${el.dataset.file} to your Downloads`, 'success');
      }
      case 'meeting-transcripts-on': return transcriptsOn();
      // Documents
      case 'doc-view':
        view.docView[id] = docId;
        setCompare(false);
        return render();
      case 'doc-compare-pick':
        if (el.dataset.side === 'left') view.docView[id] = el.value; else view.compareWith[id] = el.value;
        if (view.docView[id] === view.compareWith[id]) view.compareWith[id] = (record(id)?.data?.docs || []).find(d => d.id !== view.docView[id])?.id;
        return render();
      case 'doc-version': {
        const key = `${id}:${docId}`;
        if (el.value) view.version[key] = Number(el.value); else delete view.version[key];
        return render();
      }
      case 'doc-version-current': delete view.version[`${id}:${docId}`]; return render();
      case 'doc-use-version': {
        const version = Number(el.dataset.version);
        await mutate('meeting_doc', { meetingId: id, docId, action: 'version', version });
        delete view.version[`${id}:${docId}`];
        return toast(`Version ${version} is the current one again. The one it replaced is kept.`, 'success');
      }
      case 'doc-main': {
        const doc = docOf(id, docId);
        if (!await guarded(id, () => mutate('meeting_doc', { meetingId: id, docId, action: 'main' }))) return undefined;
        return toast(`“${doc?.name || 'The document'}” is now the main notes (notes.md)`, 'success');
      }
      case 'doc-again': {
        const template = el.dataset.template;
        await guarded(id, () => makeNotes(id, { templateId: template, wishes: '', findTasks: true, remember: false }));
        return undefined;
      }
      case 'doc-delete': return deleteDoc(id, docId);
      case 'doc-copy':
        await writeText(await docText(id, docId, Number(view.version[`${id}:${docId}`]) || null));
        return toast('Copied as Markdown', 'success');
      case 'doc-save': {
        const doc = docOf(id, docId);
        const version = Number(view.version[`${id}:${docId}`]) || null;
        const folder = String(record(id)?.data?.folder || '').split(/[\\/]/).filter(Boolean).pop() || 'meeting';
        downloadText(`${folder}-${version ? `v${version}-` : ''}${doc?.file || `${docId}.md`}`, await docText(id, docId, version));
        return toast('Saved a copy to your Downloads', 'success');
      }
      case 'doc-edit': return startEdit(id, docId);
      case 'doc-edit-cancel': {
        const ed = view.editing;
        const original = ed ? data(ed.meetingId).docs?.[ed.docId]?.text : null;
        if (ed && original !== undefined && original !== null && ed.draft !== original) {
          return confirmModal({ title: 'Discard your changes?', text: 'Your edit to these notes isn’t saved.', confirm: 'Discard', variant: 'danger', initialFocus: 'cancel', onConfirm: async () => { view.editing = null; await render(); } });
        }
        view.editing = null;
        return render();
      }
      case 'doc-edit-save': return saveEdit(id, docId);
      case 'doc-edit-rebase': {
        const ed = view.editing;
        if (!ed?.conflict) return undefined;
        Object.assign(ed, { mine: ed.draft, draft: ed.conflict.text, version: ed.conflict.version, rev: ed.conflict.rev, conflict: null });
        await render();
        return focus('#meeting-doc-editor');
      }
      case 'doc-edit-copy': {
        const ed = view.editing;
        await writeText(ed?.mine || ed?.draft || '');
        return toast('Your edit is copied', 'success');
      }
      default: return undefined;
    }
  }

  /** Fields typed into: the document editor keeps its draft in the view state, and the Notes
   *  tab's Make notes form (`data-make`) what was chosen and typed, so a render keeps them. */
  function input(el) {
    if (el?.id === 'meeting-doc-editor' && v().editing) {
      v().editing.draft = el.value;
      return true;
    }
    const id = el?.dataset?.make;
    if (!id) return false;
    const view = v();
    if (!view.makeForm) view.makeForm = {};
    const kept = view.makeForm[id] || (view.makeForm[id] = {});
    if (el.name === 'template') {
      if (el.checked) kept.templateId = el.value;
    } else if (el.name === 'wishes') kept.wishes = String(el.value ?? '');
    else if (el.name === 'findTasks' || el.name === 'remember') kept[el.name] = !!el.checked;
    return true;
  }

  /** The person left a meeting: its unsent Make notes form starts afresh next time. */
  function leave(id) {
    if (id && v().makeForm) delete v().makeForm[id];
  }

  /** Forms: the Notes tab's Make notes and a task added from the Tasks tab. */
  async function submit(form, f) {
    const id = form.dataset.id;
    if (form.dataset.form === 'meeting-notes') {
      // What the view state kept wins over the form's fields (a render may have rebuilt them).
      const kept = v().makeForm?.[id] || {};
      const options = { ...formOptions(f), ...kept };
      const queued = await guarded(id, () => makeNotes(id, options));
      const name = (snap().noteTemplates || []).find(t => t.id === options.templateId)?.name || 'notes';
      if (queued) {
        leave(id);
        toast(`Making ${name} for “${titleOf(id)}”`, 'success');
      }
      return undefined;
    }
    if (form.dataset.form === 'meeting-task') return addTask(id, f);
    return undefined;
  }

  return { open, handle, input, submit, key, load, data, glossary, ensureSelection, makeNotesDialog, importDialog, problem, guarded, makeNotes, transcriptsOn, forgetGlossary };
}
