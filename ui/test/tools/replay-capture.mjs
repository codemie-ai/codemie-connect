import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Terminal } from '../../vendor/xterm.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/setup/', import.meta.url));
mkdirSync(FIXTURE_DIR, { recursive: true });

// Ordered: specific anchors first, catch-all credential last.
const ANCHOR_MAP = [
  ['What would you like to do?',                 'gate'],
  ['Where would you like to store this',         'storage'],
  ['Choose your LLM provider:',                  'provider'],
  ['CodeMie organization URL:',                  'codemieUrl'],
  ['Select your project:',                       'codemieProject'],
  ['Choose a model',                             'model'],
  ['Enter model name:',                          'customModel'],
  ['No models found. Enter model name manually:','modelManual'],
  ['Enter a name for this profile:',             'profileName'],
  ['Switch to profile',                          'activate'],
  ['Would you like to install Claude Code now?', 'installClaude'],
];

const isQuestion = (l) => l.trimStart().startsWith('?');

function promptId(line) {
  for (const [anchor, id] of ANCHOR_MAP) {
    if (line.includes(anchor)) return id;
  }
  // A yes/no prompt is a confirm, never a credential input. Without this the consent
  // prompt "Login to CodeMie platform to enable analytics sync? (y/N)" is captured as
  // credential.json and the real credential prompt never gets a fixture.
  if (/\([yn]\/[yn]\)\s*$/i.test(line)) return null;
  // credential catch-all: any remaining question line; the caller gates on having seen
  // provider first, to prevent false positives from partial renders.
  if (isQuestion(line)) return 'credential';
  return null;
}

function readScreen(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let r = buf.baseY; r < buf.baseY + 30; r++) {
    lines.push(buf.getLine(r)?.translateToString(true) ?? '');
  }
  return lines;
}

// Each recording is accompanied by <log>.marks.json: the byte offsets at which the
// recorder pressed a key. Replaying up to a mark reproduces exactly the screen the CLI
// had settled on when it was waiting for that answer, which is the screen a fixture
// should hold. Scanning chunk by chunk and guessing instead is what produced the earlier
// torn fixtures: it caught provider mid-render with 3 of 6 options, the last cut mid-word.
const tsFiles = process.argv.slice(2);
if (tsFiles.length === 0) {
  console.error('Usage: node replay-capture.mjs <recording> [more-recordings...]');
  console.error('Each <recording> must have a sibling <recording>.marks.json listing keypress byte offsets.');
  process.exit(1);
}

const written = new Set();

function writeFixture(id, lines) {
  if (written.has(id)) return;
  written.add(id);
  writeFileSync(`${FIXTURE_DIR}/${id}.json`, JSON.stringify(lines, null, 2));
  console.log(`Captured: ${id}`);
}

async function captureFrom(file) {
  const bytes = readFileSync(file);
  const marks = JSON.parse(readFileSync(`${file}.marks.json`, 'utf8'));
  const term = new Terminal({ cols: 100, rows: 30, scrollback: 0 });
  const write = (buf) => new Promise((resolve) => term.write(new Uint8Array(buf), resolve));

  let pos = 0;
  let sawProvider = false;
  for (const [offset] of marks) {
    await write(bytes.subarray(pos, offset));
    pos = offset;
    const lines = readScreen(term);
    const qLine = [...lines].reverse().find(isQuestion);
    if (!qLine) continue;
    const id = promptId(qLine);
    if (!id) continue;
    // credential is the catch-all, so only trust it once provider has been answered.
    if (id === 'credential' && !sawProvider) continue;
    if (id === 'provider') sawProvider = true;
    writeFixture(id, lines);
    // The same screen doubles as the answered-detection fixture when a previous prompt's
    // anchor is still visible above the open one.
    if ((id === 'codemieUrl' || id === 'credential') &&
        lines.some((l) => l.includes('Choose your LLM provider:'))) {
      writeFixture('provider-answered-then-next-open', lines);
    }
  }
}

for (const file of tsFiles) await captureFrom(file);
