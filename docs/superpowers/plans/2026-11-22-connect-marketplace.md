# Connect marketplace (step 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Connect lists `codemie-ai/codemie-connect-marketplace` as a built-in marketplace, first, next to the existing built-in `onetest`.

**Architecture:** The single built-in (`BUILT_IN_NAME` / `BUILT_IN_REPO` in `src-tauri/src/plugins/registry.rs`) becomes an ordered list. `Registry::load` makes sure each built-in is present, recognising it by source rather than name, and puts the built-ins first in list order. Everything downstream (`built_in` flag, the remove guard, the UI's Built-in badge and hidden remove button) already works per market.

**Tech Stack:** Rust (Tauri v2), `cargo test`; vanilla JS UI, `node:test`; Playwright browser run.

**Spec:** `docs/superpowers/specs/2026-11-22-workspace-next-rollout-design.md` (step 0 and "Definition of done").

## Global Constraints

- Branch: `feat/workspace-next`; one commit per task; Conventional Commit subjects (`.ai-run/guides/standards/git-workflow.md`), trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Built-ins, in this order: `codemie` → `https://github.com/codemie-ai/codemie-connect-marketplace`; `onetest` → `https://github.com/onetest-ai/echo-plugins`.
- Connect still reaches the network only when the user fetches or refreshes a marketplace; a new built-in is listed "Not fetched yet" until then.
- Raw `cargo` runs from `src-tauri/`; `make` and `npm` from the repo root (macOS/zsh syntax).
- After any response shape change: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, commit the JSON.

## Review Focus

1. A user who already added `codemie-ai/codemie-connect-marketplace` by hand while developing: it must become the built-in, not appear twice, and keep its name (installed plugins point at that name).
2. A user market already named `codemie` with another source: it keeps its name and plugins; the built-in is listed as `codemie-2`.
3. An existing registry (only `onetest` built-in, plus user markets): after the update it lists `codemie`, `onetest`, then the user's, in that order; nothing installed changes.
4. Removing either built-in is refused, by name.
5. Typing `codemie` or `onetest` in Add marketplace resolves to that built-in's source, so it is refused as "already added".

---

### Task 1: An ordered list of built-in marketplaces

**Files:**
- Modify: `src-tauri/src/plugins/registry.rs` (constants at :27-30, `Source::built_in` at :133-139, `Registry::load` at :250-276, tests at :430-470)
- Modify: `src-tauri/src/plugins/market.rs` (module doc :9-10, `parse_source` :47-49, `unique_name` :300, `remove` guard :487-489, tests :519-560)
- Modify: `src-tauri/src/plugins/install.rs:873`, `src-tauri/src/plugins/commands.rs:1150`, `src-tauri/tests/echo_plugins.rs:122` only if they break

**Interfaces:**
- Produces:
  - `pub struct BuiltIn { pub name: &'static str, pub repo: &'static str }` and `pub const BUILT_INS: [BuiltIn; 2]` in `registry.rs`, in the order above. `BUILT_IN_NAME` / `BUILT_IN_REPO` are removed; callers use `BUILT_INS`.
  - `Source::built_in(repo: &str) -> Source` (a `Source::Git` with `https://github.com/{repo}` and no ref).
  - `pub(super) fn unique_name(reg: &Registry, wanted: &str) -> Result<String>` moves from `market.rs` to `registry.rs` unchanged, so `load` can use it.

- [ ] **Step 1: Write the failing tests** in `registry.rs` `tests`:

```rust
#[test]
fn every_built_in_is_listed_first_in_order() {
    let reg = Registry::load(&fresh_paths()).unwrap();
    let names: Vec<_> = reg.markets.iter().map(|m| (m.name.as_str(), m.built_in)).collect();
    assert_eq!(names, [("codemie", true), ("onetest", true)]);
    assert_eq!(reg.markets[0].source, Source::built_in("codemie-ai/codemie-connect-marketplace"));
}

#[test]
fn an_older_registry_gets_the_new_built_in_before_the_others() {
    // registry.json with onetest (built_in: true) then a user "acme" market and one installed plugin
    let reg = load_written(json!({"format":1,"markets":[onetest_json(), acme_json()],"installed":{"hello":hello_json("acme")}}));
    let names: Vec<_> = reg.markets.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, ["codemie", "onetest", "acme"]);
    assert_eq!(reg.installed["hello"].market, "acme");
}

#[test]
fn a_hand_added_copy_becomes_the_built_in() {
    // user market "connect" whose source is codemie-ai/codemie-connect-marketplace, built_in: false
    let reg = load_written(json!({"format":1,"markets":[user_market("connect", "https://github.com/codemie-ai/codemie-connect-marketplace")]}));
    let ours: Vec<_> = reg.markets.iter().filter(|m| m.source == Source::built_in("codemie-ai/codemie-connect-marketplace")).collect();
    assert_eq!(ours.len(), 1);
    assert_eq!((ours[0].name.as_str(), ours[0].built_in), ("connect", true));
    assert_eq!(reg.markets[0].name, "connect");
}

#[test]
fn a_user_market_keeps_a_built_in_name() {
    let reg = load_written(json!({"format":1,"markets":[user_market("codemie", "https://github.com/acme/plugins")]}));
    let by_name = |n: &str| reg.market(n).unwrap();
    assert!(!by_name("codemie").built_in);
    assert!(by_name("codemie-2").built_in);
    assert_eq!(reg.markets[0].name, "codemie-2");
}
```

In `market.rs` tests: `parse_source("codemie")` equals `Source::built_in("codemie-ai/codemie-connect-marketplace")`, `parse_source("onetest")` equals `Source::built_in("onetest-ai/echo-plugins")`; `remove(&env.paths, "codemie")` and `remove(&env.paths, "onetest")` both fail with code `invalid`. The existing concurrent-writers test now expects `reg.markets.len() == 2`. Helper functions (`fresh_paths`, `load_written`, `user_market`, …) follow the module's existing test helpers.

- [ ] **Step 2: Run them and see them fail**

Run: `cd src-tauri && cargo test plugins::registry plugins::market`
Expected: FAIL — `BUILT_INS` / `Source::built_in(&str)` not defined.

- [ ] **Step 3: Implement**

`Registry::load`: for each `BuiltIn` in `BUILT_INS`, find a market whose `source` equals `Source::built_in(b.repo)`; if found set `built_in = true`, else insert `Market { name: unique_name(&reg, b.name)?, source, built_in: true, commit: None, fetched_at: None }`. Then reorder with a stable sort: built-ins by their index in `BUILT_INS`, every other market after them in its saved order. A market flagged `built_in` whose source is in no `BuiltIn` (none exist today) is treated as a user market. `parse_source`: a text equal to any `BuiltIn.name` returns that built-in's source. `remove`'s message stays "The built-in marketplace can’t be removed." Update the `market.rs` module doc to name both built-ins.

- [ ] **Step 4: Run the Rust suite**

Run: `cd src-tauri && cargo test`
Expected: PASS. Fix call sites that used `BUILT_IN_NAME` (`install.rs:873` keeps `("onetest", "github", "not_fetched")` and adds `("codemie", "todoist", "not_fetched")`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/plugins
git commit -m "feat(plugins): list the CodeMie Connect marketplace as a built-in, first"
```

### Task 2: Fixtures, the window and the browser run

**Files:**
- Modify: `ui/test/fixtures/contract/plugins-markets.json` (regenerated, not hand-edited) and any other `plugins-*.json` the regeneration changes
- Modify: `ui/test/settings-plugins.test.mjs:187`
- Modify: `ui/test/browser/plugins-checks.mjs` (only where it assumes one built-in)

**Interfaces:**
- Consumes: Task 1's `BUILT_INS`; `markets` answers now start with `{name:"codemie", builtIn:true, kind:"git", ready:false, source:"https://github.com/codemie-ai/codemie-connect-marketplace"}`.

- [ ] **Step 1: Regenerate the contract fixtures**

Run: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`
Expected: `plugins-markets.json` lists `codemie` first, then `onetest`, then `acme`.

- [ ] **Step 2: Write the failing UI assertion** in `settings-plugins.test.mjs` next to line 187:

```js
assert.match(list, /<strong>codemie <span[^>]*>Built-in/, 'the CodeMie marketplace is built in');
assert.doesNotMatch(list, /data-action="market-remove"[^>]*data-market="codemie"/, 'the CodeMie marketplace stays');
assert.ok(list.indexOf('data-market="codemie"') < list.indexOf('data-market="onetest"'), 'listed first');
```

- [ ] **Step 3: Run the UI suite**

Run: `npm test`
Expected: PASS (the window code needs no change; if a test fails, it assumed one built-in — fix the test, not the renderer).

- [ ] **Step 4: Browser run, plugins set**

Run: `PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core WORKSPACE_E2E_ONLY=plugins node ui/test/browser/workspace-e2e.mjs` (outside the sandbox)
Expected: PASS; screenshot of Settings › Plugins shows `codemie  Built-in  git` first with Fetch, then `onetest`.

- [ ] **Step 5: Commit**

```bash
git add ui/test
git commit -m "test(plugins): the CodeMie marketplace in fixtures, Settings and the browser run"
```

### Task 3: Definition of done

**Files:** none changed unless a check fails.

- [ ] **Step 1: Gates** — Run: `make check`. Expected: fmt, clippy, `npm test`, `cargo test` all pass.
- [ ] **Step 2: Whole browser run** — Run the command from Task 2 Step 4 without `WORKSPACE_E2E_ONLY`. Expected: every set passes.
- [ ] **Step 3: The real app** — Build and launch the debug app (`run` skill or `cd src-tauri && cargo tauri dev`) on the user's data. Open Settings › Plugins. Screenshot: `codemie` Built-in first, no remove button. Click Fetch on `codemie`. Screenshot: "This marketplace offers no plugins." Then run `CODEMIE_STATUS_SMOKE=status ./target/debug/app` with Connect closed. Expected: exit 0.
- [ ] **Step 4: Marketplace smoke** — Run: `CODEMIE_PLUGIN_SMOKE=/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect-marketplace ./target/debug/app`. Expected: exit 0 with an empty plugin list in `$TMPDIR/connect-plugin-smoke.json` (if an empty marketplace reports as a failure, record it; Todoist in step 4 makes it non-empty).
- [ ] **Step 5: Show the user** the three screenshots and the smoke results; push `feat/workspace-next`.
