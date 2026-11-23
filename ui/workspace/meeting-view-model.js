// The meeting section's pure rules (spec "The strip", "Summary tabs", "The action items column"):
// which tabs the strip shows for a meeting (its pinned templates and plugins, else its own
// documents), which one is shown, the strip's one primary action, the header's "with …" line, an
// action item's owner line, which To review items tick themselves, and the To review / In Tasks
// split for the action items column. Pure: takes the snapshot (`s`), one meeting's context (`mc`,
// `meetingContext` in view-meeting-tabs.js), the page's plugin call slots (`slots`) and the
// plugins installed and on (`plugins`, `[{id, name}]`).
import { dateFromKey, formatDate } from './format.js';
import { isMine, ownerOf, taskOrder, taskStatus } from './tasks-model.js';
import { hasTranscript, templatesOf } from './meetings-model.js';

const dataOf = t => (t && typeof t === 'object' && 'data' in t ? t.data : t) || {};
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A person's short name: first name and last initial ("Jeroen V."), the last word's initial
 *  whatever the name has after it ("Anouk de Vries" → "Anouk V."); "Last, First" reads as First
 *  Last ("Vermeer, Jeroen" → "Jeroen V."). */
export function shortName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  if (raw.includes(',')) {
    const [last, rest] = raw.split(',', 2).map(s => s.trim());
    const first = rest.split(/\s+/).filter(Boolean)[0] || '';
    return first && last ? `${first} ${last.charAt(0).toUpperCase()}.` : first || last;
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return raw;
  return `${parts[0]} ${parts.at(-1).charAt(0).toUpperCase()}.`;
}

/** The header's "with …" line (spec "Header"): up to three other people by short name, else a
 *  count. `people` are names (strings) or `{name, me}` objects (`peopleOf`'s shape); `me` is the
 *  current user's name, for a plain list that still carries it. */
export function withLine(people, me) {
  const meName = (typeof me === 'string' ? me : me?.name || '').trim();
  const names = (people || [])
    .map(p => (typeof p === 'string' ? { name: p } : p || {}))
    .filter(p => !p.me && String(p.name || '').trim() && String(p.name || '').trim() !== meName)
    .map(p => shortName(p.name));
  if (names.length === 0) return '';
  if (names.length === 1) return `with ${names[0]}`;
  if (names.length === 2) return `with ${names[0]} and ${names[1]}`;
  if (names.length === 3) return `with ${names[0]}, ${names[1]} and ${names[2]}`;
  return `with ${names.length} people`;
}

/** The pins that still apply (spec "Pins"): `settings.meetings.summaryTabs`, in order, minus a
 *  deleted template's id or an off (or uninstalled) plugin's. */
export function pinsOf(s, plugins = []) {
  const raw = Array.isArray(s?.settings?.meetings?.summaryTabs) ? s.settings.meetings.summaryTabs : [];
  const templates = templatesOf(s);
  const on = new Set(plugins.map(p => p.id));
  return raw.filter(id => (id.startsWith('plugin:') ? on.has(id.slice('plugin:'.length)) : templates.some(t => t.id === id)));
}

/**
 * The summary tabs (spec "Summary tabs"): the pins (a template pin's document, by `template` or
 * `id`; a plugin pin's minutes text from `slots`), then the meeting's other documents, main
 * first. With no pin and no document, one tab for the template the meeting would use. At most
 * four show; the rest come back as `more`, in the same order.
 */
export function summaryTabs(s, mc, { slots = [], plugins = [] } = {}) {
  const pins = pinsOf(s, plugins);
  const templates = templatesOf(s);
  const used = new Set();
  const pinTabs = pins.map(pin => {
    if (pin.startsWith('plugin:')) {
      const pluginId = pin.slice('plugin:'.length);
      const plugin = plugins.find(p => p.id === pluginId);
      const slot = slots.find(x => x.plugin === pluginId);
      const text = (slot?.minutes || []).filter(Boolean).join('\n\n');
      return { key: `plugin:${pluginId}`, label: plugin?.name || pluginId, kind: 'plugin', templateId: null, doc: null, pluginId, text: text || null };
    }
    const tpl = templates.find(t => t.id === pin);
    const doc = mc.docs.find(d => (d.template || d.id) === pin) || null;
    if (doc) used.add(doc.id);
    return { key: `tpl:${pin}`, label: tpl?.name || pin, kind: 'template', templateId: pin, doc, pluginId: null, text: null };
  });
  const mainId = mc.main?.id;
  const rest = mc.docs.filter(d => !used.has(d.id)).sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));
  const docTabs = rest.map(d => ({ key: `doc:${d.id}`, label: d.name, kind: 'doc', templateId: d.template || d.id, doc: d, pluginId: null, text: null }));
  const all = pinTabs.length || docTabs.length
    ? [...pinTabs, ...docTabs]
    : [{ key: `tpl:${mc.tpl.id}`, label: mc.tpl.template.name, kind: 'template', templateId: mc.tpl.id, doc: null, pluginId: null, text: null }];
  return { tabs: all.slice(0, 4), more: all.slice(4) };
}

/** The tab shown: the chosen one (`v.summaryTab[id]`) while it still exists (`tabs` or `more`),
 *  else the first with a document or minutes, else the first. */
export function shownTab(tabs, more, chosenKey) {
  const all = [...(tabs || []), ...(more || [])];
  if (chosenKey) {
    const chosen = all.find(t => t.key === chosenKey);
    if (chosen) return chosen;
  }
  return all.find(t => t.doc || t.text) || all[0] || null;
}

/** The strip's one primary action for the tab shown (spec "The primary in the summary"); none in
 *  a pane other than the summary. */
export function stripPrimary(mc, tab, { pane = 'summary', runningTemplateId = null, failedTemplateId = null } = {}) {
  const none = { kind: 'none', label: '' };
  if (pane && pane !== 'summary') return none;
  if (!tab) return none;
  if (tab.doc) return { kind: 'copy', label: 'Copy' };
  if (tab.kind === 'plugin') return tab.text ? { kind: 'copy', label: 'Copy' } : none;
  if (tab.kind !== 'template') return none;
  if (runningTemplateId && runningTemplateId === tab.templateId) return { kind: 'writing', label: `Writing ${tab.label}…` };
  if (failedTemplateId && failedTemplateId === tab.templateId) return { kind: 'retry', label: 'Try again' };
  return hasTranscript(mc.m) ? { kind: 'make', label: `Make ${tab.label}` } : none;
}

/** An action item's owner line (spec "To add"): "you · <date>" or "you · no date" for mine
 *  ("Fri 20 Nov", `formatDate` weekday short, day, month short); a named, unconfirmed owner reads
 *  "<Name> · not sure of the owner"; no owner, "Nobody named". `now` is unused: the date is
 *  always absolute, never relative to it; kept for a caller that passes it along with `zone`. */
export function ownerLine(t, me, zone, now) {
  if (isMine(t, me)) {
    const due = dataOf(t).due;
    const date = DAY_KEY.test(String(due || '')) ? formatDate(dateFromKey(due), zone, { weekday: 'short', day: 'numeric', month: 'short' }) : null;
    return date ? `you · ${date}` : 'you · no date';
  }
  const owner = ownerOf(t, me);
  if (!owner.key) return 'Nobody named';
  return `${shortName(owner.name)} · not sure of the owner`;
}

/** The To review tasks that tick themselves when the column first shows a meeting: mine, with an
 *  owner Connect is sure of (not `confidence === 'low'`). */
export function defaultTicks(tasks, me) {
  return (tasks || []).filter(t => taskStatus(t) === 'review' && isMine(t, me) && dataOf(t).confidence !== 'low').map(t => t.id);
}

/** The action items column's two lists (spec "The action items column"): `toAdd`, the meeting's
 *  To review tasks in transcript order; `inTasks`, To do / In progress / Waiting by board order,
 *  then Done. */
export function itemsOf(mc) {
  const tasks = mc?.tasks || [];
  const byOrder = (a, b) => taskOrder(a) - taskOrder(b) || String(a.id).localeCompare(String(b.id));
  const toAdd = tasks.filter(t => taskStatus(t) === 'review').sort((a, b) => {
    const la = Number(dataOf(a).line);
    const lb = Number(dataOf(b).line);
    return (Number.isFinite(la) ? la : Infinity) - (Number.isFinite(lb) ? lb : Infinity) || String(a.id).localeCompare(String(b.id));
  });
  const open = tasks.filter(t => ['todo', 'doing', 'waiting'].includes(taskStatus(t))).sort(byOrder);
  const done = tasks.filter(t => taskStatus(t) === 'done').sort(byOrder);
  return { toAdd, inTasks: [...open, ...done] };
}
