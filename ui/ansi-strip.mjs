// Strips complete ANSI/VT escape sequences. Partial escapes at end-of-string
// are left unchanged (boundary-safe, stateless).
const RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|[^[\]])/g;
export default function stripAnsi(text) { return text.replace(RE, ''); }
