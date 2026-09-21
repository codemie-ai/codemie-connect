# EPMCDME-14513: Guided setup, setup-view UI

## Goal

Render `codemie setup` as a graphical, step-by-step flow inside the existing empty `setup-view`
container (`ui/index.html:177`), driven entirely by the already-landed `ui/setup-driver.js`
(`startSetup`). No PTY, no parser, no changes to `setup-driver.js`, `steps-ui.js`, or the legacy
wizard.

## New module

`ui/setup-view.js`, following the factory pattern established by `ui/steps-ui.js`:

```
export function createSetupView(container, deps = {}) {
  // deps.startSetup defaults to setup-driver.js's startSetup (lazy dynamic import,
  // same pattern setup-driver.js itself uses for window-touching deps)
  // deps.readConfig defaults to runner-bridge.js's codemieConfig.read
  return { start }; // start(): Promise<void>
}
```

`start()` creates its own `createStepsUi()` instance, wires it to `startSetup`'s `onPrompt`
callback, and on overall resolution verifies success via `deps.readConfig()`. Each call to
`start()` is a fresh, independent run — no resume/replay logic (that's EPMCDME-14656).

## Wiring

`ui/renderer.js`'s existing `CODEMIE_DEV` block (line ~488) gains one additional export,
`window.__codemie.startGuidedSetup`, which calls `showView('setup')` then
`createSetupView(document.getElementById('setup-view')).start()`. The existing
`window.__codemie.startSetup` (raw driver call, no UI) is untouched. No sidebar entry is added;
this dev hook remains the only production trigger for this ticket.

## Rendering strategy

`steps-ui.js`'s `renderSteps(container, list)` fully clears and rebuilds the DOM; `insertSubStep`
is the only incremental primitive. **Call `renderSteps(container, [])` once at `start()`** to bind
the container and clear stale state, then use `insertSubStep` to append each new row — flicker-free,
state-preserving growth. This is an accepted incidental use of a primitive named for sub-steps, not
a change to `steps-ui.js`.

## Layout and copy (literal, from `docs/wireframes/02-setup.png`)

The wireframe is the literal spec for this ticket's layout and copy for the six steps it actually
draws — both in-scope panels ("Set up CodeMie" — provider selection, and model selection) are
transcribed here verbatim. Two prompts the CLI asks that the wireframe does not draw at all
(`codemieUrl`, `credential`) are specified separately below, per round-2 feedback.

**Header.** Every panel shows the title "Set up CodeMie".

**Steps, in the CLI's actual order** (headings and helper lines exactly as drawn where the
wireframe draws them; input-row titles for the two undrawn steps are specified explicitly):

1. **Storage** — driver-fixed, never a live prompt (see below). Collapsed label "Where to store
   it", value "This computer".
2. **Provider** — heading "How should CodeMie reach a model?", helper "You can change this
   later." Collapsed label "How to reach a model".
3. **CodeMie organization URL** (`id: codemieUrl`, CodeMie-backed provider paths only) — not
   drawn in the wireframe; the CLI asks it as a real input prompt (`ui/setup-parse.js:22`)
   immediately after the provider step, before the SSO-wait transient spinner. The real prompt's
   `message` carries a CLI-provided default hint (e.g. "CodeMie organization URL:
   (https://codemie.lab.epam.com)"); title and default value are derived per the general
   input-row title rule below.
4. **Credential** (`id: credential`, API-key and local-model provider paths only) — also not
   drawn in the wireframe; a real input prompt between the provider step and the
   project/model steps. Row title and default value are derived from that prompt's own `message`
   per the same general rule. (The `credential` id is a catch-all and can fire more than once per
   run — see
   [Step sequence and rows](#step-sequence-and-rows-one-row-per-prompt-occurrence) below for how
   each occurrence gets its own row.)
5. **SSO sign-in** (SSO path only) — the browser-wait phase renders as the transient spinner and
   only the transient spinner: there is no "Signed in" collapsed row, ever, on this path. The
   wireframe's "Signed in" row is not renderable by this ticket (the vendored CLI never prints the
   user's email during SSO login — see the Divergence note below), so the spinner is the entire
   treatment for this phase; the next real prompt's row is simply the first new row that appears
   after it.
6. **CodeMie project** — collapsed label "CodeMie project".
7. **Model** — heading "Which model?", helper "These are the models your account can use."
   Collapsed label is "Model" (distinct from step 2's "How to reach a model" — the two labels
   must never be swapped), value is the chosen model's id/name once answered.
8. **Profile name** — trailing text field, label "Profile name" (placeholder style in the
   wireframe — a plain `input` prompt like any other once it actually arrives). This prompt also
   carries a CLI-provided default (vendored CLI `setup.js:489-490`), so its title and default value
   are derived per the same general rule below.

**Input-row title rule (general).** The wireframe gives explicit heading text for only one
input-kind step, "Profile name", and that heading is fixed copy (PROMPT_COPY). For every other
input-kind row — `codemieUrl`, `credential`, and any other input prompt not drawn in the wireframe — derive the
row's title and the row's text field default from that prompt's own `message` (the driver passes
`prompt.message` through untouched, `ui/setup-driver.js:504`), as follows:

1. Strip a trailing `(...)` hint group and its surrounding whitespace from `message`. Inquirer
   appends this parenthetical to the end of an open input prompt's message when the prompt has a
   default value. Use the same regex shape as the driver's own `DEFAULT_HINT`
   (`ui/setup-driver.js:108`, `/\s*\([^()]*\)\s*$/`), applied independently here — this module
   doesn't import setup-driver.js's internals, it just mirrors the same well-documented pattern
   (see `ui/setup-driver.js:92-104, 387-390, 509`).
2. Strip a trailing colon from what remains. The result is the row's title.
3. If step 1 stripped a hint, its inner text (the content between the parens) is the pre-filled
   default value of the row's text input field, so that a user who presses Continue without typing
   anything gets the same outcome as pressing Enter at the real CLI prompt (which accepts the
   default). A message with no hint leaves the field's default value empty, as before.

Example: `"CodeMie organization URL: (https://codemie.lab.epam.com)"` → strip hint →
`"CodeMie organization URL:"` → strip colon → title `"CodeMie organization URL"`, text field
pre-filled with `"https://codemie.lab.epam.com"`. A message with no hint (most `credential`
occurrences) just has its trailing colon stripped, exactly as before.

**Collapsed-row shape:** label on the left, the chosen value in bold on the same line, a
checkmark/tick icon on the right (e.g. "Where to store it — **This computer** ✓").

**Option cards (list-kind prompts): render the CLI's own flat option list, not the wireframe's
illustrative grouping.** Each option string is one card, split at the first `" - "` into title
(display name) and description (the rest of the string), per
[Provider/model string handling](#providermodel-string-handling-list-prompts) below — e.g. a
provider list renders one card per option such as "CodeMie SSO", "Anthropic Subscription", "AWS
Bedrock", "LiteLLM", "Ollama" (whatever the driver actually returns, in the order it returns
them). **The wireframe's three-card illustration — "EPAM AI/Run CodeMie" grouped separately from
"I have an API key" (with OpenAI/Azure OpenAI/AWS Bedrock/LiteLLM nested under it) and "A model
running on this computer" (Ollama) — is that panel's own UX grouping, not the list of options to
render, and must not be followed as an example.** The CLI asks these as one flat, independent list
of options; rendering the wireframe's three-card grouping instead would merge decisions the CLI
asks separately and would fail the ticket's DoD requirement to run `codemie setup --force`
side-by-side and confirm nothing is merged/reordered/invented.

A "recommended" badge renders next to the option that is this ticket's recommended pick per
[Provider/model string handling](#providermodel-string-handling-list-prompts) below — never as
literal text inside the title/description.

**Continue button:** one per active step, submitting the currently-selected option/value (matches
the wireframe's `list`-kind steps; `confirm`/`input` steps get their own submit control per
[Controls per prompt kind](#controls-per-prompt-kind)).

**Explicitly out of scope, not rendered by this ticket:**
- The **Back** button (deferred to EPMCDME-14656 — step revisit).
- The **progress dots** (e.g. "2 of 6"). This ticket's actual step count varies by path (SSO vs.
  credential adds/removes the credential row; single- vs. multi-project may add/remove the project
  row), so a fixed dot count would misrepresent the flow. Omit entirely.
- The two lower failure panels ("Rejected credentials", "CodeMie unreachable") — EPMCDME-14588's.

## Step sequence and rows — one row per prompt occurrence

The driver's fixed-policy `storage` prompt is answered internally and **never** reaches `onPrompt`
(`setup-driver.js:415-426`) — its value is static ("global" / "This computer"). **`setup-view.js`
inserts this one row positionally**, collapsed/COMPLETE, at the very start of `start()`, before
calling `startSetup`. `gate` is never rendered — it carries no user decision.

**The `activate` row is dropped entirely — never rendered, in or out of collapsed form.** The
vendored CLI only asks the "Switch to profile" confirm when the newly-created profile is not
already the active one (`setup.js:419`), and `saveProfile` makes the very first profile on a
machine active automatically (`utils/config.js:491-494`) — so on a fresh machine (the DoD's
`codemie setup --force` comparison run) this prompt is never asked at all. A fixed `activate` row
would render a step the CLI didn't ask on that path, would fail the DoD's "nothing
added/reordered" check, and isn't one of the wireframe's drawn steps. `storage` is unaffected by
this — it is asked on every add path and drawn first in every wireframe panel — and stays exactly
as specified above.

**Every other prompt is one new row per live `onPrompt` call. Each row's DOM/steps-ui id is the
prompt's own id plus an occurrence counter (e.g. `credential-1`, `credential-2`, ...), not the
bare prompt id** — `steps-ui.js`'s rows are keyed by `step.id`, and `insertSubStep` no-ops on a
duplicate id (`ui/steps-ui.js:98`), so a second row for the same prompt id could not exist under
that bare id. The exact naming scheme is a plan-level detail as long as each occurrence's id is
unique and traceable back to its prompt id (e.g. by splitting on the last `-<n>` suffix).

Reopen logic, restated against occurrence ids:
- A new prompt is a **new row** (new occurrence id) unless it repeats the same prompt id *and*
  its message is either identical to, or an extension of, the previous message rendered under
  that prompt id — in which case it targets the **latest occurrence-row for that prompt id**.
- When it repeats: **reopen that latest occurrence-row** instead of inserting a new one — bring
  its control back, set its status back to ACTIVE. Do not call `insertSubStep` again for it.
- A **different** message under the same prompt id is a new row (a new occurrence id).
- This matters because the `credential` id is the parser's catch-all and legitimately fires
  multiple times within one run for some providers (LiteLLM: proxy URL then API key, two prompts
  under `credential`; Bedrock: three prompts in a row under `credential`) — each of those is a new
  row (`credential-1`, `credential-2`, `credential-3`, ...), not a reopen, because each message
  differs. Separately, a **validation failure** (duplicate profile name, a rejected credential)
  re-asks under the *same* prompt id and must reopen the latest occurrence-row rather than insert
  a new one for it.
- Two concrete reopen cases, both must work:
  - Plain/masked input re-ask: the driver's own re-ask rule appends the rejected value to the
    message (`setup-driver.js:519-524`) — the message *grows*, counts as "extension", reopens the
    latest occurrence-row for that prompt id.
  - Unmasked-password re-ask: the message is the byte-identical `"[input is hidden]"` line every
    time (inquirer's own password-prompt rendering, `password.js:71-77`; the driver passes it
    through once the CLI goes idle, `setup-driver.js:667-681`) — identical message also counts as
    "same", also reopens the latest occurrence-row. Do not special-case password prompts as
    always-new.
- **Implementation note for the plan:** `setSubtitle` ignores empty-string text
  (`ui/steps-ui.js:70-73`), so clearing a reopened row's old collapsed value has to bypass
  `setSubtitle` and clear the DOM node directly.

Automatic no-prompt gaps (model list collection, an SSO browser wait, etc.) have no distinguishable
driver signal beyond "the next `onPrompt` or the overall settle hasn't fired yet." **One generic
transient spinner row** ("Working…") is inserted after each such step completes and removed the
instant the next `onPrompt` fires or `startSetup` settles. The exact render/remove mechanism (a
fresh id per gap plus `stopSpinner`+remove, vs. one reused row re-appended) is left as a plan-level
implementation decision, not pinned here. **Exception:** this generic spinner is never inserted
after answering the `installClaude` confirm with "yes" — see
[`installClaude` is the exception](#installclaude-is-the-exception-driven-by-onlog-not-resolution)
below for why that row's own spinner already covers that gap.

**Divergence from the wireframe — SSO "Signed in" row.** The wireframe draws a "Signed in" row
with the user's email as a collapsed step. The vendored CLI never prints the email during SSO
login — the only lines are "Opening browser for authentication..." and "Authentication
successful!" (`sso.auth.js:98`, `sso.setup-steps.js:57`). The email is not obtainable mid-flow, so
this ticket renders a transient spinner in its place (the same automatic-phase pattern used for
other no-prompt gaps) instead of a collapsed row with the email as its value. This is a documented,
accepted divergence, not a defect. The credential step being absent on the SSO path entirely is
already correct per the ticket and is unaffected.

## Controls per prompt kind

For each `onPrompt`, mark the row ACTIVE and append a control into its `.step-main` (located via
the row's public `data-id` and `.step-main` class — the same DOM contract `showApproval` already
uses externally) inside `container`:
- `kind: 'list'` — a selectable list of `prompt.options` (radio-style, option cards per
  [Layout and copy](#layout-and-copy-literal-from-docswireframes02-setuppng)), full-length
  regardless of count (15+ models supported), never free text.
- `kind: 'input'` — a text field with a submit action. If the row's title was derived from a
  message carrying a stripped `(...)` hint (per
  [Input-row title rule](#layout-and-copy-literal-from-docswireframes02-setuppng) above), the
  field's initial value is that hint's inner text; otherwise the field starts empty.
- `kind: 'confirm'` — a Yes/No control, Yes pre-selected (matches the CLI's own `(Y/n)` default;
  this is the only user-facing confirm, `installClaude`).

On submit: resolve `onPrompt`'s promise with the driver's expected shape (index/string/boolean),
remove the control markup, `setStatus(id, 'COMPLETE')`, `setSubtitle(id, <human value>)`.

### `installClaude` is the exception — driven by `onLog`, not resolution

The vendored CLI prints "Failed to install Claude Code" plus a manual-install command and then
exits normally (`setup.js:737-742`) — the CLI's only `process.exit(1)` is at `setup.js:97` and is
unrelated to install. **The driver's overall promise still resolves even when the install failed**
— resolution is not a valid COMPLETE signal for this one row. Instead, wire `onLog` specifically
for this row, matching against the **accumulated `onLog` text seen so far** (concatenate each new
chunk onto a running buffer for this row and match against the buffer, not against each incoming
chunk in isolation) — a PTY chunk can split any of these three trigger lines mid-way, and a
per-chunk match would silently miss a line that straddles a chunk boundary:
- "Installing Claude Code (supported version)..." (`setup.js:717`) → row goes ACTIVE with a
  spinner.
- "Claude Code vX installed successfully" (`setup.js:728`) → row goes COMPLETE, subtitle is the
  version string.
- "Failed to install Claude Code" (`setup.js:737`) → row goes ERROR.

Answering the confirm "no" marks the row COMPLETE with subtitle "Skipped" immediately, no `onLog`
involved. Answering "yes" leaves the row ACTIVE with its own spinner and inserts no other row for
this gap — do not also insert the generic transient "Working…" spinner described above; the
installClaude row's spinner already covers it, and showing both at once would look broken.

**Safety net:** if `startSetup`'s overall promise settles — resolves or rejects — while this row
is still ACTIVE (none of the three trigger lines above was ever matched against the accumulated
text), mark the row ERROR rather than leaving it spinning with no terminal state.

This is the **only** row in the design that listens to `onLog`; every other row stays
`onPrompt`-only as specified above.

## Provider/model string handling (list prompts)

- **Provider options** arrive as e.g. `"CodeMie SSO - Enterprise SSO Authentication with
  centralized model management"` (`providers/integration/setup-ui.js:17-19`,
  `sso.template.js:16-17`). Split at the **first** `" - "`: everything before is the option card's
  title, everything after is its description. Never render the raw joined string.
- **Model options** arrive as raw model ids/names; the CLI's recommended model carries a literal
  `"⭐ "` prefix (`ui/test/fixtures/setup/model.json:16`, `setup-ui.js:161`). Strip that leading
  star+space before rendering the title, and use its presence — not its text — to drive the
  "recommended" badge.
- **Provider lists specifically:** the CLI's own default is always the first option in the list
  (`setup.js:246`), and the driver never forwards a `selectedIndex` for providers. Badge index 0 as
  "recommended" for provider option lists only. Models get their badge from the star-prefix, not
  from index.

## Success and failure

On `{ profileName }` resolution: call `deps.readConfig()`. Success is
`state === 'valid' && profile === profileName` (`profile` is already the active profile name per
`codemie_config.rs:66-75` — there is no `activeProfile` field on the returned object,
`ui/runner-bridge.js:47-52` / `src-tauri/src/commands/codemie_config.rs:36-42`). If it mismatches,
mark the last step ERROR (that's a driver/config bug, not this ticket's failure UI).

On rejection `{ step, message, raw }`, map explicitly:
- `step` names a prompt id with a rendered row → mark the **latest occurrence-row for that prompt
  id** ERROR (not a literal bare-id match — see
  [Step sequence and rows](#step-sequence-and-rows-one-row-per-prompt-occurrence) for why the
  actual row id carries an occurrence suffix).
- `step === 'model'` and no model row exists yet (rejection from inside `collectModelOptions`,
  before any model row is inserted — `setup-driver.js:180, 200, 408`) → insert a new model row
  directly in ERROR state. Surfacing this model-fetch failure is this ticket's responsibility per
  the ticket text, not EPMCDME-14588's.
- `step === null` (non-zero exit, spawn failure, a stalled run, or a failed auto-answer write —
  `setup-driver.js:583, 593, 760, 764`) → mark whichever row is currently ACTIVE, or the
  transient/automatic-phase row if that's what's showing, as ERROR.

No retry, no resume, no failure-detail rendering beyond the ERROR row itself (EPMCDME-14588).

## Non-goals

- No sidebar/Home entry point (dev hook only).
- No `activate` row, ever, in any state — dropped from this ticket's scope entirely (see Step
  sequence above).
- No Back button and no progress-dot indicator (see Layout and copy).
- No failure-detail UI beyond marking the failing row ERROR (EPMCDME-14588's rejected-credential
  and CodeMie-unreachable panels).
- No retry-with-resume or step revisit/replay (EPMCDME-14656).
- No changes to `setup-driver.js`, `steps-ui.js`, `models.js`, or the legacy wizard/engine.
- No new `StepStatus` values — PENDING/ACTIVE/COMPLETE/ERROR from the existing enum suffice.
- No Windows support.
- No config surface beyond the one profile (timeouts, analytics, debug logging, etc.).
- No rendering of the wireframe's illustrative provider grouping (SSO / API-key submenu /
  local-model) as the option-card list — the CLI's own flat option list is what renders (see
  Layout and copy).

## Testing

New `ui/test/setup-view.test.mjs`, following `steps-ui.test.mjs`'s hand-rolled DOM stub and
`setup-driver.test.mjs`'s injected-`deps` fake-driver idiom. Cover at least: one round trip per
prompt kind, the positional `storage` insertion (and the confirmed absence of any `activate` row,
including on a simulated fresh-machine/first-profile path), the `codemieUrl` and `credential` rows
rendering with their prompt-message-derived titles, a message carrying a default hint (e.g.
`"CodeMie organization URL: (https://codemie.lab.epam.com)"`) producing a clean title with no
parenthetical and no trailing colon, with the text field's initial/default value equal to the
hint's inner content (`"https://codemie.lab.epam.com"`), the transient spinner insertion/removal
(and its absence after an `installClaude` "yes" answer), the reopen-vs-new-row logic for a
repeated prompt id under the occurrence-id scheme (both the "message grows" input case, the
byte-identical password case, and a same-id-different-message case producing a new occurrence
row), the `installClaude` row driven by `onLog` matched against accumulated text — including a
chunk that splits a trigger line mid-way, both success and failure lines, independent of overall
resolution, and the safety-net ERROR transition when the overall promise settles with the row
still ACTIVE — the provider title/description split and index-0 badge against the CLI's actual
flat option list, the model star-prefix strip and badge, the `state === 'valid' && profile ===
profileName` success assertion, and the three-way rejection mapping (named prompt id resolved to
its latest occurrence row, `model`-before-row-exists, and `step: null`). Plus a mutation-check pass
at the stage's later gate.
