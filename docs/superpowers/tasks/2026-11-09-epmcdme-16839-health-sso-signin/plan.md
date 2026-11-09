# Health SSO sign-in HTML response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A Health row whose CLI hint is the Keycloak HTML parse failure gets the sign-in action instead of the VPN text (EPMCDME-16839).

**Architecture:** One new branch in the pure function `remedyFor`; `health-ui.js` and `health-controller.js` already handle `kind: 'signin'` (sign in, then re-run doctor).

**Tech Stack:** Plain JS, node:test (`npm test`).

**Spec:** requirements in the task prompt; research in `technical-analysis.md` (same dir).

Commit per task using the repository's existing convention: `fix(health): subject`, ticket EPMCDME-16839 in the body, no Co-Authored-By. Stage files by name only (`ui/doctor-groups.js`, `ui/test/doctor-groups.test.mjs`); never stage `.ai-run/guides/project.md`, `.codemie/codemie-cli.config.json`, `AGENTS.md`.

## Task 1: Recognise the HTML sign-in parse failure in remedyFor

**Files:**
- Modify: `ui/doctor-groups.js:78-87` (insert after the `codemie profile login` branch, before the `unreachable|cannot connect` branch)
- Test: `ui/test/doctor-groups.test.mjs` (next to the existing unreachable-provider test, ~line 120)

Test-first: yes — a 'Cannot connect to provider' item with the ticket hint currently returns the VPN/recheck remedy, so the signin assertion fails.

- [ ] **Step 1: Write failing tests** (model on the unreachable test; inline records)
  - Test A, real ticket hint: items `error 'Cannot connect to provider'` plus `error 'Provider unreachable'` with hint `Failed to fetch models from SSO API: Unexpected token '<', "<!-- Keycl"... is not valid JSON`. Assert action `{ kind: 'signin', label: 'Sign in again' }`, remedyText `Your CodeMie sign-in has expired or is missing. Sign in again to continue.`, remedyDetail equals the hint, and remedyText does not match `/network|VPN/i`.
  - Test B, older Node wording: hint `Unexpected token < in JSON at position 0` gives the same signin action.
  - The existing `fetch failed` unreachable test stays unchanged and must stay green.
- [ ] **Step 2: Run** `npm test`. Expected: A and B fail, all others pass.
- [ ] **Step 3: Add the branch in `remedyFor`.** If any hint matches a tolerant case-insensitive regex, return `{ remedyText, remedyDetail, action: { kind: 'signin', label: 'Sign in again' } }` with the remedyText above. The regex needs the `<` token (`Unexpected token '<'`, `Unexpected token <`, `<!DOCTYPE`, `<!--`) followed by `not valid JSON` or `in JSON`, e.g. `/(unexpected token\s+'?<'?|<!doctype|<!--)[^]*(not valid json|in json)/i`. Add a one-line comment on why (a 200 Keycloak sign-in page parsed as JSON means an expired session, not the network).
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Mutation check.** Temporarily delete the new branch, run `npm test`: exactly the new tests fail, existing ones pass. Restore the branch and re-run.

## Self-review

- negative-constraints: (1) must NOT match `fetch failed`: honored by the `<` token requirement, pinned by the existing unreachable test in Task 1. (2) No change to health-controller, Rust, guided setup or the CLI repo: Task 1 touches only the two files above. (3) Never stage the three dirty files: stated in the header.
- Coverage: branch placement, wording, remedyDetail, both Node wordings and the mutation check are all in Task 1.
