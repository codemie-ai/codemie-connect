// Parses `codemie doctor`'s text output into structured records.
//
// Grammar produced by the formatter (see doctor fixtures under
// ui/test/fixtures/doctor/): a bold "Name:" header line, followed by one or
// more "  <icon> <message>" detail lines, each optionally followed by a
// "      <hint>" line. Blocks are separated by a blank line. A trailing
// summary line (e.g. "✓ All checks passed!") sits outside any header and is
// intentionally dropped — currentName is null at that point.
const ICONS = { '✓': 'ok', '⚠': 'warn', '✗': 'error', '○': 'info', '•': 'info' };

export function parseDoctorOutput(raw) {
  const lines = raw.split(/\r?\n/);
  const records = [];
  let currentName = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      currentName = null;
      continue;
    }
    const detail = line.match(/^\s{2}([✓⚠✗○•])\s+(.+)$/);
    if (detail && currentName) {
      const [, icon, message] = detail;
      let hint;
      const hintMatch = lines[i + 1] && lines[i + 1].match(/^\s{6}(.+)$/);
      if (hintMatch) {
        hint = hintMatch[1].trim();
        i += 1;
      }
      records.push({ name: currentName, status: ICONS[icon] || 'info', message: message.trim(), hint });
      continue;
    }
    if (/^\S.*:\s*$/.test(line)) currentName = line.replace(/:\s*$/, '').trim();
  }
  return records;
}
