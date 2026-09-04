/**
 * Pure prompt parser for the codemie setup CLI.
 * @param {string[]} screenLines  30-element array — current viewport, no scrollback.
 * @returns {{ kind, id, message, options?, selectedIndex? } | null}
 */

// A line is an open question iff it starts with '?' (ignoring leading whitespace).
// Answered inquirer lines begin with '✔' or similar — never '?'.
const isQuestion = (l) => l.trimStart().startsWith('?');

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
  // credential: provider-specific message; detected when no other anchor appears on an open line.
  { id: 'credential',    kind: 'input',   anchor: null },
];

export function detectPrompt(screenLines) {
  for (const spec of PROMPTS) {
    const result = _tryDetect(screenLines, spec);
    if (result) return result;
  }
  return null;
}

function _tryDetect(lines, spec) {
  let anchorIdx, message;

  if (spec.id === 'credential') {
    // Only match when no other spec's anchor appears on an open question line.
    // Answered lines (✔ prefix) are ignored — they may still contain anchor text.
    if (PROMPTS.some(p => p.anchor && lines.some(l => isQuestion(l) && l.includes(p.anchor)))) {
      return null;
    }
    anchorIdx = lines.findIndex(isQuestion);
    if (anchorIdx === -1) return null;
    message = _promptMessage(lines[anchorIdx]);
  } else {
    // Match only on open question lines — skip answered lines that share anchor text.
    anchorIdx = lines.findIndex(l => isQuestion(l) && l.includes(spec.anchor));
    if (anchorIdx === -1) return null;
    message = _promptMessage(lines[anchorIdx]);
  }

  if (spec.kind === 'list') {
    const { options, selectedIndex } = _parseListOptions(lines, anchorIdx);
    if (options.length === 0) return null; // no visible options → not a real open list
    return { kind: 'list', id: spec.id, message, options, selectedIndex };
  }

  return { kind: spec.kind, id: spec.id, message };
}

/** Strip the leading '? ' from an inquirer prompt line to get the display message. */
function _promptMessage(line) {
  return line.replace(/^\s*\?\s*/, '').trim();
}

function _parseListOptions(lines, anchorIdx) {
  const options = [];
  let selectedIndex = 0;
  for (let r = anchorIdx + 1; r < lines.length; r++) {
    const raw = lines[r];
    const trimmed = raw.trim();
    if (!trimmed) break;
    // Inquirer navigation hints — end of option block.
    if (trimmed.startsWith('(')) break;
    // Exclude the trailing "Custom model (manual entry)..." row.
    if (/custom model/i.test(trimmed) && /manual/i.test(trimmed)) continue;
    const isSelected = /^[>❯]/.test(raw.trimStart());
    const label = trimmed.replace(/^[>❯]\s*/, '').trim();
    if (!label) continue;
    if (isSelected) selectedIndex = options.length;
    options.push(label);
  }
  return { options, selectedIndex };
}
