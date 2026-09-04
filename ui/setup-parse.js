/**
 * Pure prompt parser for the codemie setup CLI.
 * @param {string[]} screenLines  30-element array — current viewport, no scrollback.
 * @returns {{ kind, id, message, options?, selectedIndex? } | null}
 */

// A line is an open question iff it starts with '?' (ignoring leading whitespace).
// Answered inquirer lines also keep their '?' prefix — so the OPEN prompt is always the
// LAST question line on screen, not the first.
const isQ = (l) => l.trimStart().startsWith('?');

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
  const message = line.replace(/^\s*\?\s*/, '').trim();
  if (spec.kind !== 'list') return { kind: spec.kind, id: spec.id, message };
  const { options, selectedIndex } = parseOptions(lines, idx);
  return options.length ? { kind: 'list', id: spec.id, message, options, selectedIndex } : null;
}

function parseOptions(lines, idx) {
  const options = []; let selectedIndex = 0;
  for (let r = idx + 1; r < lines.length; r++) {
    const raw = lines[r], t = raw.trim();
    if (!t) break;
    if (isQ(raw)) break;                        // next prompt begins
    if (t.startsWith('(')) continue;            // '(Use arrow keys)' sits on its own line
    if (/custom model/i.test(t) && /manual/i.test(t)) continue;
    const sel = /^[>❯]/.test(raw.trimStart());
    const label = t.replace(/^[>❯]\s*/, '').trim();
    if (!label) continue;
    if (sel) selectedIndex = options.length;
    options.push(label);
  }
  return { options, selectedIndex };
}
