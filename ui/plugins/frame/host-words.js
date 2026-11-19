// Echo's plugins say "Echo" where they mean the app they run in. In Connect, their own words say
// Connect instead: in the frame (`renameHost` over the phrases Rust read from the plugin's scripts,
// shim.js) and in the window (a plugin's summary on Settings → Plugins, `hostWords`). A user's
// own text that a plugin shows (notes that mention Echo) is never changed.

/** A phrase shorter than this changes only when it is a text node's whole text. */
const SHORT_PHRASE = 12;

/** Echo's name as Connect's: Claude Code opens in Connect's terminal (the dock), as it did in
 *  Echo's panel. */
export function hostWords(text) {
  return String(text ?? '')
    .replace(/\bEcho(['’])s (panel|terminal)\b/g, (_, q) => `Connect${q}s terminal`)
    .replace(/\bEcho(['’]s)?\b/g, (_, s) => `Connect${s || ''}`);
}

/** The phrases that name Echo, longest first, each with its Connect wording. */
export function renameTable(phrases) {
  const list = (Array.isArray(phrases) ? phrases : []).filter(p => typeof p === 'string' && /\bEcho\b/.test(p));
  return [...new Set(list)].sort((a, b) => b.length - a.length).map(p => [p, hostWords(p)]);
}

/** `text` with the plugin's own phrases (`table`) in Connect's words; unchanged when none is in it. */
export function renameHost(text, table) {
  const t = String(text ?? '');
  if (!table?.length || !t.includes('Echo')) return t;
  const folded = t.replace(/\s+/g, ' ');
  const whole = folded.trim();
  let out = folded;
  for (const [phrase, said] of table) {
    if (phrase.length < SHORT_PHRASE) {
      if (whole === phrase) return t.replace(phrase, said);
    } else if (out.includes(phrase)) {
      out = out.split(phrase).join(said);
    }
  }
  return out === folded ? t : out;
}
