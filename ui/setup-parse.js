/**
 * Pure prompt parser for the codemie setup CLI.
 * @param {string[]} screenLines  30-element array — current viewport, no scrollback.
 * @returns {{ kind, id, message, options?, selectedIndex? } | null}
 */

// A line is an open question iff it starts with '?' (ignoring leading whitespace).
// Answered inquirer lines also keep their '?' prefix — so the OPEN prompt is always the
// LAST question line on screen, not the first.
// Exported so setup-driver.js's idle-check (CR-004 fix) can reuse this exact predicate to
// tell "no question is on screen at all" (CLI still doing background work) apart from
// "a question is on screen that detectPrompt just didn't classify" (a real stall), instead
// of reimplementing a second, possibly-divergent rule.
export const isQ = (l) => l.trimStart().startsWith('?');

// Ordered: all named anchors first; credential catch-all last.
const PROMPTS = [
  { id: 'gate',          kind: 'list',    anchor: 'What would you like to do?' },
  { id: 'storage',       kind: 'list',    anchor: 'Where would you like to store this configuration?' },
  { id: 'provider',      kind: 'list',    anchor: 'Choose your LLM provider:' },
  { id: 'codemieUrl',    kind: 'input',   anchor: 'CodeMie organization URL:' },
  { id: 'codemieProject',kind: 'list',    anchor: 'Select your project:' },
  { id: 'model',         kind: 'list',    anchor: 'Choose a model' },
  { id: 'customModel',   kind: 'input',   anchor: 'Enter model name:' },
  { id: 'modelManual',   kind: 'input',   anchor: 'No models found. Enter model name manually:' },
  { id: 'profileName',   kind: 'input',   anchor: 'Enter a name for this profile:' },
  { id: 'activate',      kind: 'confirm', anchor: 'Switch to profile' },
  { id: 'installClaude', kind: 'confirm', anchor: 'Would you like to install Claude Code now?' },
  // credential: provider-specific message; detected when no other anchor appears on the open line.
  { id: 'credential',    kind: 'input',   anchor: null },
];

export function detectPrompt(lines) {
  // Answered prompts keep their '?' prefix, so the OPEN prompt is the LAST question line.
  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (isQ(lines[i])) idx = i;
  if (idx === -1) return null;
  const line = lines[idx];
  const named = PROMPTS.find(p => p.anchor && line.includes(p.anchor));
  // If no named anchor matched, check whether the line is an unrecognized confirm-style prompt
  // (ends with a yes/no hint like "(y/N)" or "(Y/n)"). Those must return null — returning
  // 'credential' for a consent/confirm question would cause a driver to type an API key into it.
  if (!named && /\(y\/N\)\s*$|\(Y\/n\)\s*$|\(Y\/N\)\s*$|\(y\/n\)\s*$/i.test(line)) return null;
  const spec = named ?? { id: 'credential', kind: 'input' };
  let message = line.replace(/^\s*\?\s*/, '').trim();
  // CR-003: for confirm-kind prompts, strip trailing yes/no hint text (e.g. "(Y/n)", "(y/N)").
  // Only exact yes/no patterns — never a general trailing-parens strip, which would destroy
  // parenthesized default values that input-kind prompts carry (e.g. "(sonnet)", "(anthropic-subscription)").
  if (spec.kind === 'confirm') message = message.replace(/\s*\([yn]\/[yn]\)\s*$/i, '').trim();
  // New defect fix: credential catch-all must refuse an incomplete/partial line. A genuinely
  // complete credential prompt always includes a ':' in its label (e.g. "? API key:", "? Ollama base URL:").
  // A line like "? CodeMie organization" (truncated mid-word at a chunk boundary) has no ':', so
  // returning 'credential' for it would cause a driver to type an API key into an unfinished prompt.
  if (spec.id === 'credential' && !message.includes(':')) return null;
  if (spec.kind !== 'list') return { kind: spec.kind, id: spec.id, message };
  const { options, selectedIndex } = parseOptions(lines, idx);
  return options.length ? { kind: 'list', id: spec.id, message, options, selectedIndex } : null;
}

// EPMCDME-14588. Failures the CLI puts on screen. They are not prompts and so
// never come back from detectPrompt: the auth timeout is a warning the flow
// carries on past (setup.js:60), and Ollama's precedes exit 1
// (ollama.setup-steps.js:49-60). Nothing else in the CLI reports a failure
// visibly -- its fatal handler logs to file only (logger.js:278 gates the
// console on CODEMIE_DEBUG) -- so this is the whole set, measured 2026-09-15.
//
// Both screens are captured from the real CLI: test/fixtures/setup/authTimeout.json
// and ollamaNotRunning.json.
const FAILURES = [
  {
    id: 'authTimeout',
    anchor: 'Could not check for mandatory integrations',
    // The CLI's own reason is parenthesised on the anchor row. The sentence
    // around it wraps at the terminal's width; the reason itself does not.
    reason: (line) => line.match(/\(([^()]*)\)/)?.[1] ?? null,
    fallback: 'CodeMie could not be reached',
  },
  {
    id: 'ollamaDown',
    anchor: 'Ollama is not running',
    reason: () => 'Ollama is not running',
  },
];

/**
 * Classify a visible CLI failure on the current screen.
 *
 * Returns `null` or `{ id, message, line }`, where `message` is the CLI's own
 * words and `line` is the row the anchor was found on.
 *
 * The anchor stays on screen after the flow moves on, so this is edge-triggered
 * by nature: act on an occurrence once, keyed on `line`, rather than on every
 * chunk that still shows it.
 */
export function detectFailure(lines) {
  for (const f of FAILURES) {
    const line = lines.findIndex((l) => l.includes(f.anchor));
    if (line === -1) continue;
    return { id: f.id, message: f.reason(lines[line]) ?? f.fallback, line };
  }
  return null;
}

function parseOptions(lines, idx) {
  const options = []; let selectedIndex = 0; let seenSel = false;
  for (let r = idx + 1; r < lines.length; r++) {
    const raw = lines[r], t = raw.trim();
    if (!t) break;
    if (isQ(raw)) break;                        // next prompt begins
    if (/^\(.*\)$/.test(t)) continue;           // skip lines that are entirely a parenthesized hint (e.g. '(Use arrow keys)')
    if (/custom model/i.test(t) && /manual/i.test(t)) continue;
    const sel = /^[>❯]/.test(raw.trimStart());
    const label = t.replace(/^[>❯]\s*/, '').trim();
    if (!label) continue;
    // CR-005: only the FIRST selection marker wins; ignore subsequent markers
    // (guards against partial terminal renders that can produce multiple '>' rows)
    if (sel && !seenSel) { selectedIndex = options.length; seenSel = true; }
    options.push(label);
  }
  return { options, selectedIndex };
}
