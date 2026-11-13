# Technical Research

**Task**: sidebar unlock home-state shell-nav onboarding
**Generated**: 2026-10-15
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16036 — CodeMie Connect: Unlock the sidebar once sign-in and model are set, not after Health passes.

What is wrong: Until all four first-run checklist steps on Home are complete, sidebar entries Tools, Connections, Health and CLI usage analytics are dimmed and unclickable. The Health step only completes when `codemie doctor` reports no problems; an outdated installed tool (e.g. Pi, GitHub Copilot CLI) keeps the whole menu locked.

Should be: sidebar unlocks as soon as the user is signed in and has a model (checklist steps 1 and 2 complete). Health problems stay visible as a warning on Home's checklist and Health screen but no longer lock the menu.

Acceptance criteria:
1. Signed in with a model set: Tools, Connections, Health, CLI usage analytics clickable, whatever Install a tool and Verify health show.
2. Health reporting problems does not lock the sidebar; Home's Verify health step still shows the warning and its Open Health action.
3. Not signed in, or no model yet: sidebar stays locked as today, Home stays clickable.
4. Returning user who finished onboarding keeps an unlocked sidebar.
5. Unit tests cover the new unlock rule.
Out of scope: what Health reports / doctor ratings; checklist's own completion rule and automatic health check; Windows-specific behaviour.

Known pointers: the rule is ui/home-state.js:254 `unlocked: done || onboarded`, passed by renderer.js:282 to applyOnboardingNav (ui/shell-nav.js). New rule: `onboarded` or sign-in and model items both COMPLETE. Leave `done` alone (automatic health check and checklist-vs-cards switch depend on it). ui/test/home-state.test.mjs:138-139 asserts the old rule (signed in with model but health null => locked) and must change. Comment at ui/home-state.js:77 says sidebar Health stays locked until checklist is done; update wording. Gate is `npm test`; UI logic only, no Rust expected. Also check any other readers of `unlocked` or docs/guides mentioning the old rule.

---

## 2. Codebase Findings

### Existing Implementations
- `ui/home-state.js` — pure `deriveHome()` (line 237). Builds four `items` (sign-in, model, agent, health) via `signInItem`, `modelItem`, `agentItem`, `healthItem`. `complete` = all four COMPLETE (240). `done = !broken && (complete || (onboarded && !signedOut))` (246). Returns `unlocked: done || onboarded` at line 254, with comment at 252-253 ("locks only for a first setup...").
- `signInItem` (32): COMPLETE for `signed_in` and `unknown`; ACTIVE while auth unread (null); else PENDING. `modelItem` (43): COMPLETE only for config `valid`; WARNING for `broken` with a profile; else PENDING.
- `ui/shell-nav.js` — `applyOnboardingNav(root, { done })` toggles `.locked`, `aria-disabled` and `disabled` on `ONBOARDING_LOCKED = sidebar-agents, sidebar-connections, sidebar-health, sidebar-analytics`. The parameter is named `done` but the caller passes `state.unlocked`. Header comment (1-10) says "Until the checklist is done".
- `ui/renderer.js:262-284` — `renderHome()` calls `deriveHome({ ...home, onboarded })`, persists onboarded when `state.done`, then `applyOnboardingNav(document, { done: state.unlocked })` (282). Comment at 280-281 says screens "stay locked until the checklist is first done".
- `ui/onboarding-memory.js` — `readOnboarded` / `rememberOnboarded` (localStorage key `codemie.home.onboarded`).
- `ui/home-view.js:75-80` — Health row shows an Open Health action for WARNING/ERROR; comment at 79 says "the sidebar's Health stays locked until the checklist finishes".
- Only readers of `unlocked`: renderer.js:282 (grep across ui/ and docs/ found no others besides tests). `done` also feeds `autoHealthCheck` (180-186), `applyHomeHeader`, and the checklist-vs-cards switch.

### Architecture and Layers Affected
Frontend UI logic only: pure state derivation (`ui/home-state.js`), DOM nav helper (`ui/shell-nav.js`), renderer wiring (`ui/renderer.js`). No Rust/Tauri backend involvement.

### Integration Points
`deriveHome` inputs: config reader, auth status, agents list, health controller result. Output `unlocked` is consumed solely by `applyOnboardingNav`. `.locked` CSS in `ui/styles.css:339-341`.

### Patterns and Conventions
Pure functions with no DOM; renderer passes derived state to view helpers; comments explain the "why" with ticket references.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (project, quality-gates, architecture, testing, development, standards). A grep for sidebar lock/unlock wording in `.ai-run`, `docs/stories`, `docs/codemie`, `docs/wireframes`, `docs/testing` found no mention of the old rule. Testing guide: `node --test ui/test/*.test.mjs`.

### Architectural Decisions
None found about the sidebar lock rule. Stale prose lives only in code comments: `ui/home-state.js:77`, `ui/home-state.js:252-253`, `ui/home-view.js:79`, `ui/renderer.js:280-281`, `ui/shell-nav.js:1-10`, plus test comments at `ui/test/home-state.test.mjs:114-115` and `:208`, and `ui/test/home-view.test.mjs:173-174`.

### Derived Conventions
Test names are sentence-style; fixtures `valid`, `signedIn`, `agents`, `healthy` at top of home-state.test.mjs.

---

## 4. Testing Landscape

### Existing Coverage
- `ui/test/home-state.test.mjs` — asserts `unlocked` at 119 (onboarded, nothing read), 134 (onboarded, lapsed sign-in), 312 (onboarded expired), and 138-139 (`before setup has ever finished, the sidebar unlocks only with the checklist`: signed in + valid config + agents + health null => `false`; with `healthy` => `true`). Line 138 encodes the old rule and contradicts the ticket.
- `ui/test/shell-nav.test.mjs` — lock/unlock DOM behaviour with `{ done }`, unaffected by the rule change.
- `ui/test/onboarding-memory.test.mjs`, `home-view.test.mjs` (Health row action).

### Testing Framework and Patterns
`node:test` + `node:assert/strict`, run via `npm test`; plain data fixtures, no mocks needed for `deriveHome`.

### Coverage Gaps
No test for: signed in + valid model + health WARNING (problems) => unlocked; `auth: unknown` + valid model; signed in but config not valid (or `no-configuration`) => locked; auth unread (null) => locked; broken profile => locked (first run).

---

## 5. Configuration and Environment

### Environment Variables
None relevant.

### Configuration Files
None governing this. `package.json` `test` script: `node --test ui/test/*.test.mjs`.

### Feature Flags and Deployment Concerns
None. State persisted only via localStorage `codemie.home.onboarded`.

---

## 6. Risk Indicators

- Speculative: the new rule must use item statuses (sign-in and model COMPLETE) rather than `auth`/`config` directly, so `unknown` auth (COMPLETE) and the in-flight auth read (ACTIVE, not COMPLETE) behave consistently; `broken` config yields WARNING, so stays locked on first run.
- `done` is coupled to `broken`; a broken profile with `onboarded` already returns `unlocked` true today via `|| onboarded` and must keep doing so (tests at 134, 312).
- Unlocking while the health step is PENDING/ACTIVE lets users navigate to Health during the automatic check; `autoHealthCheck` and Health controller behaviour on a concurrent visit were not examined (out of scope but worth a glance).
- Stale comments in five source files describe the old rule; easy to miss (listed in Section 3).
- Parameter name `done` in `applyOnboardingNav` is now misleading since it receives `unlocked`; renaming would touch shell-nav.test.mjs (optional).
- Working tree has unrelated modifications (`.ai-run/guides/project.md`, `.codemie/codemie-cli.config.json`, `AGENTS.md`).

---

## 7. Summary for Complexity Assessment

The change is confined to the frontend: one expression in `ui/home-state.js` (`unlocked`, line 254), consumed by a single call at `ui/renderer.js:282` into `applyOnboardingNav`. No other readers of `unlocked` exist, no Rust, config, or docs/guide changes are involved. File surface is roughly 1 production file for logic plus comment updates in 3-4 files and one test file.

There is no technical novelty; the code is pure and already structured around item statuses. Test posture is good: `home-state.test.mjs` already covers `unlocked` for returning users, and one existing test (lines 137-140) encodes the old rule and must be rewritten, with new cases added for the health-problem, unknown-auth, no-model and auth-unread paths.

Main risks are semantic: keeping `done` unchanged while `unlocked` diverges from it, and not regressing the onboarded/broken-profile cases. Overall this reads as a small, low-risk change.

---

## 8. External References

None named by the task
