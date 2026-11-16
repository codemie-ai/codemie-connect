// Strips complete ANSI/VT escape sequences and normalises line endings for a
// flat, append-only text log (not a screen-relative terminal emulator).
//
// Cursor-down / cursor-next-line CSI sequences (\x1b[nB, \x1b[nE) are how many
// interactive CLIs (ink, spinners, boxed "next step" output, ...) advance past
// blank lines instead of writing literal "\n" — a real terminal renders them as
// line breaks, so a log that just deletes them loses every blank line and the
// line break before it. They are converted to n "\n" characters instead of
// being dropped. Every other escape sequence carries no line-break meaning for
// a flat log and is stripped as before.
//
// Partial escapes at end-of-string are left unchanged (boundary-safe, stateless).
const CSI = /\x1b\[([?!>]?)([0-9;:]*)([A-Za-z])/g;
const OTHER_ESCAPE = /\x1b(?:\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)|[^[\]])/g;

function stripEscapes(text) {
  return text
    .replace(CSI, (_m, priv, params, final) => {
      if (!priv && (final === 'B' || final === 'E')) {
        return '\n'.repeat(parseInt(params, 10) || 1);
      }
      return '';
    })
    .replace(OTHER_ESCAPE, '');
}

export default function stripAnsi(text) {
  // "\r\n" -> "\n"; never touches lone "\n" so consecutive newlines (blank
  // lines) are preserved.
  return stripEscapes(text).replace(/\r\n/g, '\n');
}
