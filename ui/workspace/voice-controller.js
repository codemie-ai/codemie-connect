// The Settings › Your voice controller (reply voice design §5, §6, §11): the provider radio and
// the facts checkbox (`voice_set`), the style card and instruction editors (`voice_save`), delete
// with Undo (`voice_delete`, Undo saves the rule back), Refresh now (`voice_refresh`), a person's
// profile (`voice_read`, read on demand: the snapshot carries no profile text), Delete Connect's
// copy (`voice_forget`, after its dialog), Turn on and Set up, and the skill import (the folder
// pick, `voice_import_scan`, Shorten with AI's `voice_import_distil`, `voice_import`). app.js
// routes the `voice-*` actions here and the editors' typing through `input()`.
//
// Writes go through the store's `mutate`; reads through `query`. No optimistic updates. What the
// user typed lives in `state.voice` (not in the DOM), so a refusal or a background render keeps
// it. The import preview lives here only: nothing about it is stored.
import { escapeHtml as e } from './store.js';
import { nextVoiceImport, nextVoiceSave, providerName, RULE_KINDS, RULE_CHANNELS } from './settings-voice.js';

/** The view state this controller keeps in `state.voice`. */
export function newVoiceView() {
  return { style: null, rule: null, import: null, busy: {} };
}

const KINDS = new Set(RULE_KINDS.map(([kind]) => kind));
const CHANNELS = new Set(RULE_CHANNELS.map(([c]) => c));
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const fieldOf = err => (err?.code === 'validation' && err.field ? err.field : null);
const messageOf = err => err?.message || String(err);

/**
 * `state.voice` is the view state (`newVoiceView()`); `snap()` the snapshot; `mutate(op, data)` a
 * fenced write that re-renders; `query(op, data)` a read; `pluginsRequest(op, data)` is
 * `plugins_request` (`pick_folder`, `set_enabled`); `render()`; `openModal` the dialog (the
 * delete confirm and the profile dialog); `toast(message, tone, {label, run})`; `go(hash)` opens
 * a Connect hash (a plugin's page); `focus(selectors)` moves focus after a render.
 */
export function createVoiceController({
  state, snap, mutate, query = async () => null, pluginsRequest = async () => null, render = async () => {},
  openModal = () => null, toast = () => {}, go = () => {}, focus = () => {},
}) {
  const v = () => {
    if (!state.voice) state.voice = newVoiceView();
    return state.voice;
  };
  const rv = () => snap().replyVoice || { provider: 'off', available: [], rules: [], people: [] };
  const chosen = () => {
    const p = rv().provider;
    return p && p !== 'off' ? p : null;
  };
  const name = () => {
    const r = rv();
    return providerName(r, (r.available || []).find(a => a.id === r.provider));
  };

  /** `voice_set`; a refusal puts the control back (`undo`: the checkbox; the radio is drawn
   *  again from the snapshot). */
  async function setVoice(data, undo = () => {}) {
    try {
      await mutate('voice_set', data);
    } catch (err) {
      undo();
      toast(messageOf(err), 'error');
      await render();
    }
  }

  // ---------------------------------------------------------------- style card

  function editStyle() {
    v().rule = null;
    v().style = { text: rv().style?.text ?? '', error: null, saving: false };
    return render().then(() => focus('#ws-voice-style-text'));
  }

  async function saveStyle() {
    const s = v().style;
    if (!s || s.saving) return;
    s.saving = true;
    s.error = null;
    try {
      await mutate('voice_save', nextVoiceSave({ style: s.text }));
      v().style = null;
      await render();
      focus('[data-action="voice-edit-style"]');
    } catch (err) {
      s.saving = false;
      s.error = messageOf(err);
      await render();
      focus('#ws-voice-style-text');
    }
  }

  // ---------------------------------------------------------------- instructions

  function openRule(rule) {
    v().style = null;
    const a = rule?.applies || {};
    v().rule = rule
      ? { id: rule.id, scope: KINDS.has(a.kind) ? a.kind : 'everyone', value: a.value ?? '', channel: a.channel || '', text: rule.text ?? '', error: null }
      : { id: null, scope: 'everyone', value: '', channel: '', text: '', error: null };
    return render().then(() => focus('#ws-voice-rule-kind'));
  }

  async function saveRule() {
    const r = v().rule;
    if (!r || r.saving) return;
    r.saving = true;
    r.error = null;
    try {
      await mutate('voice_save', nextVoiceSave({ rule: r }));
      v().rule = null;
      await render();
    } catch (err) {
      delete r.saving;
      r.error = { field: fieldOf(err), message: messageOf(err) };
      await render();
      // Focus on the refused field (or the text), so the sentence beside it is read and Esc works.
      focus(r.error.field === 'applies' ? ['#ws-voice-rule-value', '#ws-voice-rule-kind'] : '#ws-voice-rule-text');
    }
  }

  async function deleteRule(id) {
    let answer;
    try {
      answer = await mutate('voice_delete', { id });
    } catch (err) {
      toast(messageOf(err), 'error');
      return;
    }
    const removed = answer?.removed;
    // Undo saves the rule back (as a new instruction: the provider gave its id up).
    const undo = removed?.applies
      ? { label: 'Undo', run: () => mutate('voice_save', nextVoiceSave({ rule: { id: null, scope: removed.applies.kind, value: removed.applies.value, channel: removed.applies.channel, text: removed.text } })) }
      : null;
    toast('Instruction deleted.', 'success', undo);
  }

  function cancel() {
    const had = v().style ? '[data-action="voice-edit-style"]' : v().rule?.id ? `[data-voice-rule="${CSS_ESCAPE(v().rule.id)}"] [data-action="voice-edit-rule"]` : '[data-action="voice-add-rule"]';
    v().style = null;
    v().rule = null;
    return render().then(() => focus(had));
  }

  // ---------------------------------------------------------------- people, copy

  async function person(id) {
    let p;
    try {
      p = await query('voice_read', { id });
    } catch (err) {
      // Shown near the Profile button that was pressed, not through the global failure handler.
      toast(messageOf(err), 'error');
      return;
    }
    const section = (title, body) => (body ? `<h3 class="ws-voice-dialog-head">${e(title)}</h3><p class="ws-voice-text">${e(body)}</p>` : '');
    openModal({
      title: p?.name || 'Profile',
      body: `${section('How to write to them', p?.text)}${section('About them', p?.about)}<p class="ws-muted ws-hint">${e(`From ${p?.source || ''}. Edit it in ${name()}.`)}</p>`,
      submit: '',
      cancel: 'Close',
      initialFocus: 'cancel',
      size: 'md',
    });
  }

  function forget() {
    const n = chosen() ? name() : rv().name;
    const body = n
      ? `Connect stops adding your voice to drafts, turns it off and clears your Ask history, whose answers may quote it. Your ${n} folder is not touched; choose ${n} again to make a new copy.`
      : 'Connect stops adding your voice to drafts, turns it off and clears your Ask history, whose answers may quote it. The provider\'s folder is not touched; choose it again to make a new copy.';
    openModal({
      title: 'Delete Connect\'s copy of your voice?',
      body: `<p class="ws-modal-text">${e(body)}</p>`,
      submit: 'Delete copy',
      cancel: 'Cancel',
      variant: 'danger',
      size: 'sm',
      returnCancels: true,
      onSubmit: async () => {
        await mutate('voice_forget', {});
        v().style = null;
        v().rule = null;
        v().import = null;
      },
    });
  }

  async function refresh() {
    v().busy.refresh = true;
    await render();
    try {
      await query('voice_refresh', {});
    } catch (err) {
      toast(messageOf(err), 'error');
    } finally {
      v().busy.refresh = false;
      await render();
    }
  }

  async function turnOn(provider) {
    v().busy.turnOn = true;
    await render();
    try {
      await pluginsRequest('set_enabled', { id: String(provider).replace(/^plugin:/, ''), enabled: true });
    } catch (err) {
      toast(messageOf(err), 'error');
    } finally {
      v().busy.turnOn = false;
      await render();
    }
  }

  // ---------------------------------------------------------------- the import

  /** Opens the preview for a scan answer (the tour hands one over: no picker). */
  async function openImport(preview, path = '') {
    v().style = null;
    v().rule = null;
    v().import = {
      path,
      preview: { ...preview, items: [...(preview.items || [])], skipped: [...(preview.skipped || [])], ai: [...(preview.ai || [])] },
      checked: Object.fromEntries((preview.items || []).map(i => [i.key, true])),
      busy: {},
      error: null,
      saving: false,
    };
    await render();
    focus('#ws-voice-import-title');
  }

  async function startImport() {
    if (!chosen()) return;
    // Both the pick and the scan are shown near Import from skills…, not through the global
    // failure handler (Task 9 review minor 4).
    let picked;
    try {
      picked = await pluginsRequest('pick_folder', { purpose: 'skills' });
    } catch (err) {
      toast(messageOf(err), 'error');
      return;
    }
    const path = picked?.path;
    if (!path) return;
    let preview;
    try {
      preview = await query('voice_import_scan', { path });
    } catch (err) {
      toast(messageOf(err), 'error');
      return;
    }
    await openImport(preview, path);
  }

  async function distil(skill) {
    const im = v().import;
    if (!im || im.busy[skill]) return;
    const p = im.preview;
    const dir = p.items.find(i => i.skill === skill)?.dir ?? p.skipped.find(s => s.skill === skill)?.dir ?? skill;
    im.busy[skill] = true;
    im.error = null;
    await render();
    try {
      const answer = await query('voice_import_distil', { path: im.path, skill, dir });
      if (v().import !== im) return;
      const rows = (answer?.items || []).map((item, n) => ({ key: `${skill}#ai${n + 1}`, skill, dir, applies: item.applies, text: item.text, ai: true }));
      // The skill's rows are replaced where they stood (or added after the rest).
      const at = p.items.findIndex(i => i.skill === skill);
      const rest = p.items.filter(i => i.skill !== skill);
      for (const key of Object.keys(im.checked)) if (key.startsWith(`${skill}#`)) delete im.checked[key];
      p.items = at < 0 ? [...rest, ...rows] : [...rest.slice(0, at), ...rows, ...rest.slice(at)];
      for (const row of rows) im.checked[row.key] = true;
      p.skipped = p.skipped.filter(s => s.skill !== skill);
      p.ai = p.ai.filter(s => s !== skill);
    } catch (err) {
      if (v().import === im) im.error = messageOf(err);
    } finally {
      delete im.busy[skill];
      await render();
    }
  }

  async function saveImport() {
    const im = v().import;
    if (!im || im.saving) return;
    const data = nextVoiceImport(im.preview, im);
    if (!data.items.length) return;
    im.saving = true;
    im.error = null;
    await render();
    try {
      const answer = await mutate('voice_import', data);
      v().import = null;
      const added = Number(answer?.added) || 0;
      toast(`Added ${plural(added, 'instruction')} to ${name()}.`, 'success');
      await render();
      focus('[data-action="voice-import"]');
    } catch (err) {
      im.saving = false;
      im.error = messageOf(err);
      await render();
    }
  }

  async function cancelImport() {
    v().import = null;
    await render();
    focus('[data-action="voice-import"]');
  }

  // ---------------------------------------------------------------- routing

  /** Typing in an editor (`data-voice-input`): kept in the view state, no render. */
  function input(el) {
    const which = el.dataset?.voiceInput;
    if (which === 'style' && v().style) v().style.text = el.value;
    const r = v().rule;
    if (!r) return;
    if (which === 'rule-value') r.value = el.value;
    if (which === 'rule-text') r.text = el.value;
    if (which === 'rule-channel' && CHANNELS.has(el.value)) r.channel = el.value;
  }

  async function handle(action, el = { dataset: {} }) {
    const d = el.dataset || {};
    switch (action) {
      case 'voice-provider': {
        const provider = d.provider || el.value;
        if (!provider || provider === rv().provider) return undefined;
        return setVoice({ provider });
      }
      case 'voice-facts':
        if (!chosen()) return undefined;
        return setVoice({ provider: chosen(), facts: !!el.checked }, () => { el.checked = !el.checked; });
      case 'voice-turn-on': return turnOn(d.provider || chosen());
      case 'voice-setup': return go(`#/p/${String(d.provider || chosen() || '').replace(/^plugin:/, '')}/home`);
      case 'voice-edit-style': return editStyle();
      case 'voice-save-style': return saveStyle();
      case 'voice-cancel': return cancel();
      case 'voice-add-rule': return openRule(null);
      case 'voice-edit-rule': {
        const rule = (rv().rules || []).find(r => r.id === d.id);
        return rule ? openRule(rule) : undefined;
      }
      case 'voice-rule-kind':
        if (v().rule && KINDS.has(el.value)) v().rule.scope = el.value;
        return render();
      case 'voice-save-rule': return saveRule();
      case 'voice-delete-rule': return deleteRule(d.id);
      case 'voice-person': return person(d.id);
      case 'voice-refresh': return refresh();
      case 'voice-forget': return forget();
      case 'voice-import': return startImport();
      case 'voice-import-toggle':
        if (v().import) v().import.checked[d.key] = !!el.checked;
        return render();
      case 'voice-import-distil': return distil(d.skill);
      case 'voice-import-save': return saveImport();
      case 'voice-import-cancel': return cancelImport();
      default: return undefined;
    }
  }

  // `cancel` is also Esc in an editor (app.js): focus goes back on Edit or Add.
  return { handle, input, openImport, cancel };
}

/** A value inside a CSS attribute selector's quotes. */
const CSS_ESCAPE = value => String(value).replace(/["\\]/g, '\\$&');
