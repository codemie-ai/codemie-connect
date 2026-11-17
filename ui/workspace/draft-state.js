// Reply drafts with Claude (DESIGN 6.4): the options, the words the composer shows, and what
// happens to the reply box when a draft arrives. Pure, so every decision is unit tested.

export const INTENTS = [['reply', 'Reply'], ['acknowledge', 'Acknowledge'], ['decline', 'Decline politely'], ['ask', 'Ask for details'], ['propose_times', 'Propose times']];
export const TONES = [['neutral', 'Neutral'], ['friendly', 'Friendly'], ['formal', 'Formal']];
export const LENGTHS = [['short', 'Short'], ['medium', 'Medium'], ['detailed', 'Detailed']];
export const MAX_INSTRUCTIONS = 1000;
/** CodeMie takes 12–18 s to start; until then the composer says so instead of "Drafting". */
export const CODEMIE_STARTUP_SECONDS = 12;

const CHOICES = { intent: INTENTS, tone: TONES, length: LENGTHS };
const valid = (field, value) => CHOICES[field].some(([v]) => v === value);

// ---------------------------------------------------------------- options

/** `localStorage` key of the options last used for a channel. */
export const optionsKey = channel => `codemie.draft.options.${channel === 'chat' ? 'chat' : 'mail'}`;

export function defaultOptions(channel) {
  return { intent: 'reply', tone: 'neutral', length: channel === 'chat' ? 'short' : 'medium', includeFreeTimes: false };
}

/** Options from anything stored or recorded; unknown choices fall back to the channel default. */
export function sanitizeOptions(raw, channel) {
  const base = defaultOptions(channel);
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = { ...base };
  for (const field of ['intent', 'tone', 'length']) if (valid(field, o[field])) out[field] = o[field];
  out.includeFreeTimes = typeof o.includeFreeTimes === 'boolean' ? o.includeFreeTimes : out.intent === 'propose_times';
  return out;
}

/** Remembered options: the JSON string kept in `localStorage` (or null). */
export function readOptions(raw, channel) {
  try {
    return sanitizeOptions(raw ? JSON.parse(raw) : null, channel);
  } catch {
    return defaultOptions(channel);
  }
}

/** Options after one choice in the popover. Propose times suggests free times; other intents stop. */
export function pickOption(options, field, value) {
  if (!CHOICES[field] || !valid(field, value)) return options;
  return field === 'intent' ? { ...options, intent: value, includeFreeTimes: value === 'propose_times' } : { ...options, [field]: value };
}

/** The `ai_draft` request for a message. */
export function draftRequest(message, options, instructions = '') {
  const o = sanitizeOptions(options, message.data.channel);
  const request = { sourceId: message.id, intent: o.intent, tone: o.tone, length: o.length, includeFreeTimes: o.includeFreeTimes };
  const text = String(instructions || '').trim().slice(0, MAX_INSTRUCTIONS);
  if (text) request.instructions = text;
  return request;
}

// ---------------------------------------------------------------- labels

const isCodeMie = profileId => String(profileId || '').startsWith('codemie:');
export const profileName = profileId => (isCodeMie(profileId) ? 'CodeMie' : 'Claude Code');

/** Who reads the conversation: "Claude Code (Anthropic)" or the CodeMie profile, "CodeMie · prod". */
export function providerLabel(profileId, profiles = []) {
  if (!profileId) return 'the Claude you choose';
  if (!isCodeMie(profileId)) return 'Claude Code (Anthropic)';
  return profiles.find(p => p.id === profileId)?.label || `CodeMie · ${profileId.slice(8)}`;
}

/** "claude-sonnet-4-5-20250929" → "Sonnet 4.5"; aliases → "Sonnet"; anything else as given. */
export function modelLabel(model) {
  const id = String(model || '').trim();
  const family = id.toLowerCase().match(/haiku|sonnet|opus/)?.[0];
  if (!family) return id;
  const version = id.replace(/\[.*\]$/, '').replace(/-\d{8}.*$/, '').match(/\d{1,2}/g) || [];
  return `${family[0].toUpperCase()}${family.slice(1)}${version.length ? ` ${version.join('.')}` : ''}`;
}

/** Whether a Claude could draft: false only once detection says none is ready. */
export function claudeAvailable(ai) {
  if (ai?.status !== 'ready' || !Array.isArray(ai.profiles)) return true;
  return ai.profiles.some(p => p.state === 'ready');
}

/** Detection runs the Claude CLIs, so it happens at most this often. */
export const CLAUDE_RECHECK_MS = 15_000;

/**
 * Whether to read which Claude profiles are ready (`read`), and whether to detect them again
 * instead of using native's 30-second cache (`detect`). A render reads on first use, then only
 * while nothing is ready, every 15 s; `now` (window focus) reads at once. Detection, whether
 * asked for (`detect`, after Copy sign-in steps) or because nothing is ready, keeps its 15 s
 * pace everywhere.
 */
export function claudeCheck({ status, noneReady, now = false, detect = false, nowMs, readAt = 0, detectAt = 0 }) {
  const read = now || status === 'idle' || (noneReady && nowMs - readAt > CLAUDE_RECHECK_MS);
  return { read, detect: read && (detect || noneReady) && nowMs - detectAt > CLAUDE_RECHECK_MS };
}

/**
 * The running row: "Drafting with Claude Code · Sonnet… 6 s", or "Starting CodeMie… 4 s".
 * The model is the one Claude reported at start (`runModel`), else the one the route asked
 * for, else none yet. `label` is the words without the seconds (announced once; the seconds
 * tick silently).
 */
export function runningLabel(job, { nowMs = Date.now(), verb = 'Drafting' } = {}) {
  const p = job?.payload || {};
  if (job?.state !== 'running' || !p.startedAt) return { text: 'Waiting to start…', label: 'Waiting to start…', seconds: null, starting: false };
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - p.startedAt));
  const starting = isCodeMie(p.profile) && seconds < CODEMIE_STARTUP_SECONDS;
  const model = modelLabel(p.runModel || p.model);
  const label = starting ? 'Starting CodeMie…' : `${verb} with ${[profileName(p.profile), model].filter(Boolean).join(' · ')}…`;
  return { text: `${label} ${seconds} s`, label, seconds, starting };
}

/**
 * "Drafted with Claude Code · Sonnet · 4 s · from 5 messages" (`verb` "Summarized" for a
 * summary). `by` names the automation that prepared it: "Drafted by “Morning brief” with …".
 */
export function provenanceLabel(p = {}, verb = 'Drafted', by = '') {
  const n = (p.messageIds || []).length;
  const parts = [profileName(p.profile), modelLabel(p.model)];
  if (p.durationMs != null) parts.push(`${Math.max(1, Math.round(p.durationMs / 1000))} s`);
  if (n) parts.push(`from ${n} message${n === 1 ? '' : 's'}`);
  return `${verb}${by ? ` by ${by}` : ''} with ${parts.filter(Boolean).join(' · ')}`;
}

// ---------------------------------------------------------------- errors (DESIGN 6.2)

const RETRY = { draft: 'ai-draft-retry', summary: 'ai-summarize-retry', automation: 'automation-run' };
// An automation runs again as a whole (Run now); drafts and summaries retry their own job.
const retry = (job, label = 'Try again', kind = 'draft') => ({
  label: kind === 'automation' ? 'Run again' : label, action: RETRY[kind] || RETRY.draft, iconName: 'refresh',
  attrs: { 'data-id': kind === 'automation' ? job.payload?.automationId : job.id },
});
const CHOOSE = { draft: 'ai-draft-choose', summary: 'ai-summarize-choose', automation: 'automation-choose' };
const settingsAction = { label: 'Open Claude settings', action: 'ai-open-settings', iconName: 'settings' };
const toolsAction = { label: 'Open CodeMie tools', action: 'setup-tools', iconName: 'tools' };

/**
 * One sentence and one action for a failed draft job (or, with `kind: 'summary'`, a failed
 * summary job; with `kind: 'automation'`, a failed automation run shaped as a job whose
 * `payload.automationId` names it), keyed on its error class and code (never on its state
 * text). Null for a job that did not fail (stopped, running, done).
 */
export function draftError(job, { profiles = [], settings = {}, kind = 'draft' } = {}) {
  if (!job || !['failed', 'blocked'].includes(job.state)) return null;
  const summary = kind === 'summary';
  const automation = kind === 'automation';
  const task = summary ? 'summarize conversations' : automation ? 'run automations' : 'draft replies';
  const code = job.errorCode;
  // A run of an automation has no conversation of its own: its class (or the default) says why.
  if (code === 'conflict' && summary) return { tone: 'warning', sentence: 'The conversation changed while summarizing.', action: retry(job, 'Summarize again', 'summary') };
  if (code === 'conflict' && !automation) return { tone: 'warning', sentence: 'The conversation changed while drafting.', action: retry(job, 'Draft again') };
  const cls = job.errorClass || code;
  const profileId = job.payload?.profile || settings.routes?.[job.payload?.purpose]?.profile || settings.defaultProfile || 'claude';
  const label = profiles.find(p => p.id === profileId)?.label || (isCodeMie(profileId) ? `CodeMie · ${profileId.slice(8)}` : 'Claude Code');
  switch (cls) {
    case 'needs_choice': return { tone: 'info', sentence: 'Choose which Claude writes for you.', action: { label: 'Choose Claude', action: CHOOSE[kind] || CHOOSE.draft, iconName: 'spark', attrs: { 'data-id': automation ? job.payload?.automationId : job.id } } };
    case 'needs_login':
      return isCodeMie(profileId)
        ? { tone: 'warning', sentence: `${label} isn't signed in.`, action: toolsAction }
        : { tone: 'warning', sentence: "Claude Code isn't signed in.", action: { label: 'Copy sign-in steps', action: 'ai-copy-login', iconName: 'link' } };
    case 'not_installed': return { tone: 'warning', sentence: "Claude Code isn't installed on this Mac.", action: settingsAction };
    case 'too_old': return { tone: 'warning', sentence: `This Claude Code is too old to ${task}.`, action: settingsAction };
    case 'not_configured': return { tone: 'warning', sentence: "This CodeMie profile isn't fully set up.", action: toolsAction };
    case 'rate_limited': return { tone: 'warning', sentence: "Claude's usage limit was reached. Try again later.", action: null };
    case 'permission_required': return { tone: 'warning', sentence: automation ? 'Connect may no longer read what this automation needs.' : `This conversation is no longer available to ${summary ? 'summarize' : 'draft from'}.`, action: null };
    case 'timeout': return { tone: 'error', sentence: 'Claude took too long to answer.', action: retry(job, 'Try again', kind) };
    case 'invalid_output': return { tone: 'error', sentence: "Claude's answer couldn't be used.", action: retry(job, 'Try again', kind) };
    default: return { tone: 'error', sentence: summary ? "Claude couldn't summarize this conversation." : automation ? "Claude couldn't finish this run." : "Claude couldn't write this draft.", action: retry(job, 'Try again', kind) };
  }
}

// ---------------------------------------------------------------- bracketed choices and gaps

// "[Yes, I can / Unfortunately, I can't]" and "[date]"; never a Markdown link "[text](url)".
const BRACKETS = /\[([^[\]\n]{1,300})\](?!\()/g;
const brackets = text => [...String(text || '').matchAll(BRACKETS)].map(m => ({ start: m.index, end: m.index + m[0].length, raw: m[0], inner: m[1].trim() }));

/** Choices Claude left for the user, each with its options. */
export function choicesIn(text) {
  return brackets(text)
    .map(({ inner, ...b }) => ({ ...b, options: inner.includes('://') ? [] : inner.split('/').map(x => x.trim()) }))
    .filter(b => b.options.length >= 2 && b.options.length <= 4 && b.options.every(Boolean));
}

/** Gaps Claude marked because it was not told, such as "[date]". Numbers ("[1]") are not gaps. */
export function gapsIn(text) {
  return brackets(text)
    .filter(b => b.inner && !b.inner.includes('/') && b.inner.length <= 60 && !/^\d+$/.test(b.inner))
    .map(({ inner, ...b }) => b);
}

/**
 * The choices and gaps Claude left in its draft (`aiText`) that are still in the reply. The
 * user's own brackets, such as "[EPMCDME-1234]" or "[WIP]", never count; nor does anything
 * when there is no draft.
 */
export function draftChoices(text, aiText) {
  const fromClaude = new Set(choicesIn(aiText).map(c => c.raw));
  return choicesIn(text).filter(c => fromClaude.has(c.raw));
}

export function draftGaps(text, aiText) {
  const fromClaude = new Set(gapsIn(aiText).map(g => g.raw));
  return gapsIn(text).filter(g => fromClaude.has(g.raw));
}

/** The text with Claude's `index`-th choice replaced by one of its options. */
export function chooseOption(text, index, option, aiText) {
  const choice = draftChoices(text, aiText)[index];
  return choice ? `${text.slice(0, choice.start)}${option}${text.slice(choice.end)}` : text;
}

/** Claude's choices and gaps still in a reply, in reading order; Review & send and Copy ask first. */
export function unfinishedParts(text, aiText) {
  return [...draftChoices(text, aiText), ...draftGaps(text, aiText)].sort((a, b) => a.start - b.start).map(x => x.raw);
}

// ---------------------------------------------------------------- the reply box

/**
 * What a finished draft does to the reply box: fill it when it is empty or still holds an
 * untouched draft (`dirty` false), otherwise ask before replacing the user's words.
 */
export function applyDraftResult({ current, dirty, result }) {
  const text = result?.text ?? '';
  return { action: !String(current ?? '').trim() || !dirty ? 'fill' : 'confirm', text };
}

/** The user's words from before a replace. */
export function restoreText(state) {
  return state?.previous ?? '';
}

/**
 * A draft that arrived for the open reply box (`live` is the box's current text): fill the box
 * when it is empty or still holds Claude's earlier text untouched (`ui.baseline`), otherwise
 * ask. A Restore offered for an earlier replace ends here. Returns the next `ui`, the action,
 * the box text and the text to save (the saved reply follows a fill), or null when nothing is
 * new.
 */
export function reconcile({ ui = {}, ai, manual, live }) {
  if (!ai || live == null || [ui.seen, ui.confirm, ui.kept].includes(ai.revision)) return null;
  const { action, text } = applyDraftResult({ current: live, dirty: live !== (ui.baseline ?? ''), result: ai.data });
  if (action === 'confirm') return { ui: { ...ui, confirm: ai.revision, restore: null }, action, text: live, save: null };
  const saved = manual?.data?.text;
  return { ui: { ...ui, seen: ai.revision, confirm: null, kept: null, restore: null, baseline: text }, action, text, save: saved != null && saved !== text ? text : null };
}

/**
 * The user's answer about Claude's draft: `keep` their words, `replace` them with the draft
 * (Restore can bring them back), `restore` them, or `forget` the Restore offer. Returns the
 * next `ui`, the box text and the text to save (null: nothing to save).
 */
export function answer(ui = {}, ai, choice, current) {
  const draft = ai?.data?.text ?? '';
  switch (choice) {
    case 'keep': return { ui: { ...ui, kept: ai?.revision ?? null, confirm: null, restore: null, baseline: null }, text: current, save: current };
    case 'replace': return { ui: { ...ui, seen: ai?.revision ?? null, kept: null, confirm: null, restore: { previous: current }, baseline: draft }, text: draft, save: draft };
    case 'restore': {
      // No offer (already restored, or a stale click): nothing changes and nothing is saved.
      if (!ui.restore) return { ui, text: current, save: null };
      const previous = restoreText(ui.restore);
      return { ui: { ...ui, seen: null, kept: ai?.revision ?? null, restore: null, baseline: null }, text: previous, save: previous };
    }
    default: return { ui: { ...ui, restore: null }, text: current, save: null };
  }
}

/**
 * What the reply box shows, from the saved records and this session's decisions (`ui`): the
 * user's saved reply unless Claude's draft is newer; a newer draft over the user's own words
 * waits for "Replace your text?" (`confirm`), also after a reload.
 *   ui.seen    draft revision already put in the box
 *   ui.confirm draft revision waiting for an answer
 *   ui.kept    draft revision the user declined (Keep mine)
 */
export function replyBox({ manual, ai, ui = {} }) {
  const mine = manual?.data?.text || '';
  if (!ai) return { text: mine, fromAi: false };
  const draft = ai.data?.text || '';
  if (ui.kept === ai.revision) return { text: mine, fromAi: false };
  if (ui.confirm === ai.revision) return { text: mine, fromAi: false, confirm: draft };
  // Times are whole seconds: a reply saved in the same second as the draft (Replace, Restore) wins.
  const aiNewer = !manual || (ai.updatedAt || 0) > (manual.updatedAt || 0);
  if (!aiNewer) return { text: mine, fromAi: mine === draft };
  if (!mine.trim() || mine === draft || ui.seen === ai.revision) return { text: draft, fromAi: true };
  return { text: mine, fromAi: false, confirm: draft };
}
