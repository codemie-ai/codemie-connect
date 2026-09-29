status: DONE

## Commit

`eb5863e606698e44b12110096210bced8dc6c133` — "EPMCDME-14982 : Add captured Windows PTY fixtures"

`git show --stat HEAD` confirms exactly two files changed, nothing else:
```
 ui/test/fixtures/setup/windows-activate-confirm.json       | 157 ++++++++++++
 ui/test/fixtures/setup/windows-profile-name-correction.json| 107 ++++++++++
 2 files changed, 264 insertions(+)
```

## Method

Reconstructed all 57 raw PTY chunks from `windows-capture-raw.log` into full 30-line screen frames using the real headless xterm.js `Terminal` (`ui/vendor/xterm.mjs`, `new Terminal({ cols: 100, rows: 30, scrollback: 0 })`), decoding each chunk's base64 the same way `ui/setup-driver.js`'s `decode()` does, writing it with `term.write(bytes, callback)` and awaiting the callback before reading `term.buffer.active.getLine(r).translateToString(true)` for all 30 rows — the exact contract `setup-driver.js`'s own `readScreen()` uses. This was done in a temporary script at repo root, never committed, deleted before finishing (see Cleanup below).

Both fixtures were additionally sanity-checked end-to-end by replaying them through the REAL `startSetup()`/`detectPrompt()` from `ui/setup-driver.js` (not just eyeballed) via a second temporary script, also deleted before finishing.

## Fixtures created

1. **`ui/test/fixtures/setup/windows-profile-name-correction.json`** — 6 frames, built from reconstructed raw-log frames [41..46]. Each frame trimmed of trailing empty rows only (leading content, including the whole visible banner/auth-flow scrollback, kept verbatim). Covers: open profile-name prompt with default hint `(codemie-sso)` → typed "default" rejected (`>> A profile with this name already exists`) → same rejected state repeated → Ctrl-U + corrected name `epmcdme-14982-capture-2784` accepted, no error → "saved to global config" + activate-confirm prompt appearing in the same chunk.
2. **`ui/test/fixtures/setup/windows-activate-confirm.json`** — 8 frames, built from reconstructed raw-log frames [41..48] (must start from the same early open-prompt frame as fixture 1 — see Errors/Fixes note below). Frame lengths: `[15,14,16,16,15,17,16,30]`. Extends fixture 1's sequence through two more frames: a partial/dropped redraw missing the confirm line, then the full jump to final success (`Switch to profile ... as active? Yes`, `Switched to profile...`, `✅ ... configured successfully!`, provider/model info, next-steps list).

Both verified via sanity replay with answers `['default', 'epmcdme-14982-capture-2784']`: `writes: ["default\r","epmcdme-14982-capture-2784\r","y\r"]`, `result: {"profileName":"epmcdme-14982-capture-2784"}`.

Note on why fixture 2 isn't just [46,47,48]: starting mid-flow at an already-answered profile-name screen (no default hint present) gives `handleDetectedPrompt` no prior `lastAnsweredInput` state, so it misclassifies the answered line as a fresh OPEN prompt and re-asks it. All existing macOS "real stream" tests in `ui/test/setup-driver.test.mjs` likewise always start `frames[0]` at the open/hinted prompt, never mid-flow — fixture 2 follows that same convention, hence the overlap with fixture 1.

## Six-axis diagnosis (verbatim, matches commit body)

1. **Chunk/echo/repaint order** — diverges: the macOS-derived comment above `replay()`/`typedOut()` describes four distinct stages (unrepainted answered screen, ctrl-U's bare repaint, the answer typed out one character at a time, then the verdict). The Windows capture shows the CLI's redraw collapsing several of those stages into ONE PTY chunk instead: chunk 43 already carries both the typed "default" echo AND the `>> A profile with this name already exists` rejection together, and chunk 46 carries both "saved to global config" AND the "Switch to profile ... as active?" confirm question together. No intermediate character-by-character typing chunks were observed for either the rejected or corrected name. This is likely because this capture's harness wrote each whole answer string in one PTY write (matching how the real driver itself submits an answer via a single `innerDeps.input(answer + '\r')` call) rather than forwarding individual keystrokes the way the app's UI does when a human types interactively — so it is not proven to be a ConPTY-vs-PTY difference, but the driver's own dedup/signature logic never assumes any particular chunk granularity (it re-parses and re-dedupes after every chunk), so this collapsing is functionally harmless. Flagging for Task 5 to confirm no logic implicitly relies on multi-chunk typing.
2. **Ctrl-U line-clear** — matches macOS: the decision log confirms the harness sent `"\x15"` then the full corrected name then `"\r"` as a single write, exactly the pattern `setup-driver.js`'s `ans()` helper (`\x15${text}\r`) already produces for a re-answer. The resulting screen (chunk 45) shows the corrected name `epmcdme-14982-capture-2784` cleanly replacing `default` with no error and no leftover characters — consistent with ctrl-U's "delete to start of line" semantics assumed in `setup-driver.js`.
3. **Arrow-key list nav (model list)** — matches macOS: chunks 36→37 (Down arrow on "Choose a model") show the classic inquirer redraw pattern assumed by `collectModelOptions()`'s comments — the cursor marker `❯` moves from `⭐ claude-sonnet-5` to `claude-4-5-sonnet` one line down, the option list itself stays in the same order/position, and a "(Move up and down to reveal more choices)" hint line appears/persists, i.e. cursor movement without the options list being reordered.
4. **AUTO_LIST/AUTO_CONFIRM regex matches** — matches macOS, with one confirmed absence: the storage prompt's "❯ Global (~/.codemie/) - Available across all repositories" option text really does match `AUTO_LIST.storage = /global/i` (chunk 2). The activate confirm's actual captured text `? Switch to profile "epmcdme-14982-capture-2784" as active? (Y/n) ` does contain `setup-parse.js`'s PROMPTS anchor `'Switch to profile'` and is correctly classified `kind:'confirm'`, `id:'activate'` (verified by replaying the fixture through the real `detectPrompt`/`startSetup`: the confirm is auto-answered `"y\r"` with no `onPrompt` call, as `AUTO_CONFIRM.activate` intends). Separately: the real captured session shows NO "gate" screen at all — confirmed directly against all 57 reconstructed frames, not just the task-3-report narrative; the very first prompt to appear (chunk 2) is already `? Where would you like to store this configuration?`, never `What would you like to do?` / "add a new profile". This is a harmless non-issue for the driver: `AUTO_LIST.gate` and the gate branch in `handleDetectedPrompt` only ever fire if `detectPrompt` classifies a 'gate' prompt on some screen, and since this flow never renders one, that branch simply never runs — nothing observable changes. Agreed with the reasoning in the task brief; found nothing that contradicts it.
5. **VALIDATION_ERROR_MARKER=/^>>/ positioning** — matches macOS: in the real rejection chunk (43/44), `>> A profile with this name already exists` is the line directly below the question line (0 rows between), well within `VALIDATION_ERROR_WINDOW`'s 3-row lookahead and matching the input.js-derived assumption that a plain input prompt's error has no blank row before it (unlike the password-prompt case the comment carves out separately).
6. **CRLF vs LF** — matches macOS assumption of being a no-op for the driver: decoding the raw bytes of chunk 43 directly shows literal `\r\n` between the question line and the `>>` error line, and no bare LF-only line endings anywhere in that chunk. This axis is irrelevant to the driver's actual behavior regardless: it only ever reads the terminal's already-parsed screen buffer via `term.buffer.active.getLine(r).translateToString(true)`, never the raw byte/text stream, so CRLF-vs-LF differences are absorbed by xterm.js's own parser before the driver ever sees a line.

## Cleanup confirmation

- Temporary reconstruction script (imported `Terminal` from `ui/vendor/xterm.mjs`, decoded all 57 chunks, wrote frames to a temp JSON file) — deleted.
- Temporary sanity-test script (replayed both fixtures through the real `startSetup()`) — deleted.
- Temporary intermediate frames JSON file — deleted.
- `git status --porcelain` after the commit shows only the pre-existing untracked `docs/superpowers/tasks/2026-09-23-guided-setup-windows/` directory (Task 3's artifacts, not mine to touch/commit) — no other untracked or modified files, no leftover temp scripts.
