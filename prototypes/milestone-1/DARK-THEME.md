# Corrected CodeMie dark theme

Measured in the real CodeMie preview through the Chrome extension on 16 November 2026. The original Light preference was restored after inspection. Only visual tokens are retained; no account content or credentials are stored.

The previous prototype used `#C5A9FA` as the general accent. In the real `codemieDark` theme it is a **status accent**. Ordinary links use `#F2F0EF`; navigation selection uses `#212224`; active/focus outlines are white. That semantic mismatch made the prototype look like a different design system.

| Role | Correct value |
|---|---|
| Page / navigation / card | #1A1A1A / #000000 / #151515 |
| Header / secondary / elevated | #1C1C1C / #212224 / #2E2E2E |
| Main / secondary-link text | #FFFFFF / #F2F0EF |
| Tertiary / muted | #CCCCCC / #BBBBBB |
| Borders / hover border / focus | #333436 / #47484A / #FFFFFF |
| Status accent | #C5A9FA, reserved for status/AI badges |
| Primary action | #20222E, hover #262941; #993EC7 → #5677C8 outline |
| Success / error / warning | #259F4C / #FE3B4C / #F5A534 |
| Chart data | #06B6D4 and other semantic series colors |

The correction is applied only to `../assets/codemie.css`. Light mode is unchanged. Main app implementation waits for approval. In Task 1, map these roles into the existing `ui/codemie-tokens.css` design system and bundle the local Geist fonts; do not copy the prototype's accumulated CSS overrides into production.

The app title scale can vary by surface: the live Profile h1 is 18 px, while the earlier inspected main catalogue pages used 24 px. Choose 24 px for workspace page titles and 18 px for Settings subsections; both use GeistMono. Use Geist for longer reading.

Verification evidence: [token snapshot](evidence/live-codemie-dark-tokens.json). Corrected prototype screenshots and browser results are recorded in BASELINE-VALIDATION.md.
