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

const tsFile = process.argv[2];
if (!tsFile) { console.error('Usage: node replay-capture.mjs <typescript-file>'); process.exit(1); }
const bytes = readFileSync(tsFile);

const term = new Terminal({ cols: 100, rows: 30, scrollback: 0 });
const snapped = new Set();
let prevQuestion = '';

const CHUNK = 256;
let i = 0;
function next() {
  if (i >= bytes.length) { console.log('Done:', [...snapped].join(', ')); return; }
  const chunk = bytes.slice(i, i + CHUNK);
  i += CHUNK;
  term.write(chunk, () => {
    const lines = readScreen(term);
    const qLine = lines.find(isQuestion) ?? '';
    if (qLine && qLine !== prevQuestion) {
      const id = promptId(qLine);
      if (id && !snapped.has(id)) {
        snapped.add(id);
        writeFileSync(`${FIXTURE_DIR}/${id}.json`, JSON.stringify(lines, null, 2));
        console.log(`Captured: ${id}`);
        // When the first post-provider prompt appears, the answered provider line
        // is already on screen above it — save that composite screen as the
        // answered-detection fixture used by the re-detection test.
        if ((id === 'codemieUrl' || id === 'credential') && !snapped.has('provider-answered-then-next-open')) {
          snapped.add('provider-answered-then-next-open');
          writeFileSync(`${FIXTURE_DIR}/provider-answered-then-next-open.json`, JSON.stringify(lines, null, 2));
          console.log('Captured: provider-answered-then-next-open');
        }
      }
      prevQuestion = qLine;
    }
    next();
  });
}
next();
