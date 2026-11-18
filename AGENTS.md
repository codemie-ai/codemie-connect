# AGENTS.md

Primary AI entrypoint for `CodeMie Connect`. Load the relevant `.ai-run/guides/` file before changing code.

## Guide Imports

<!-- ai-run-init:guide-imports start -->
| Category | Guide Path | Purpose |
|---|---|---|
| Architecture | `.ai-run/guides/architecture/architecture.md` | Module map (commands, workspace, ai, storage, plugins, ui), the workspace request flow, caller checks and extension points |
| Development | `.ai-run/guides/development/development-practices.md` | Naming, error types, logging, async and lock order, configuration and dependency conventions |
| Git / Review | `.ai-run/guides/standards/git-workflow.md` | Branch names, commit subjects, PR merge policy |
| Quality | `.ai-run/guides/quality-gates.md` | Exact lint, format, test and build commands with what passes and fails |
| Testing | `.ai-run/guides/testing/testing-patterns.md` | Where tests live, contract fixtures, fakes, the browser run and the smoke modes |
| Tickets | `.ai-run/guides/project.md` | Project identity, the Jira ticket adapter and the pull request adapter |
<!-- ai-run-init:guide-imports end -->

## Task Classifier

<!-- ai-run-init:task-classifier start -->
| Category | User Intent | Example Requests | P0 Guide | P1 Guide |
|---|---|---|---|---|
| Architecture | Understand where code lives, how the window reaches Rust, or where a new command, operation or plugin service goes | "where does the meetings logic live?", "how does the UI save a task?", "add a new workspace operation", "add a plugin ctx service" | `.ai-run/guides/architecture/architecture.md` | - |
| Development | Write or fix Rust or JavaScript code the way this codebase does it | "fix this error handler", "add a log line", "bump the bundled CLI version", "add a Rust dependency" | `.ai-run/guides/development/development-practices.md` | - |
| Git / Review | Branch, commit, push or open a pull request | "commit this", "open a PR", "what is the branch format?" | `.ai-run/guides/standards/git-workflow.md` | - |
| Quality | Lint, format, test, build or verify a change | "check formatting", "run all tests", "build the DMG" | `.ai-run/guides/quality-gates.md` | - |
| Testing | Write, run or fix tests | "add a test for the tasks controller", "the contract fixture test says stale", "run the browser checks for meetings" | `.ai-run/guides/testing/testing-patterns.md` | - |
| Tickets | Look up, create or comment on a ticket, or find which tracker and remote the repository uses | "what does the ticket say?", "create a Jira story for this", "which remote do we push to?" | `.ai-run/guides/project.md` | - |
<!-- ai-run-init:task-classifier end -->

## Critical Rules

<!-- ai-run-init:critical-rules start -->
| Rule | Trigger | Action |
|---|---|---|
| Check Guides First | ANY task | Match request to category and load the P0 guide before searching broadly |
| Testing | "write tests" / "run tests" | Only when asked or a flow requires it; load `.ai-run/guides/testing/testing-patterns.md` first |
| Git Operations | "commit" / "push" / "PR" / "MR" | Only then; load `.ai-run/guides/standards/git-workflow.md` |
| Shell | ANY shell command | Use macOS/zsh-compatible syntax (BSD `sed`, `find`); raw `cargo` runs from `src-tauri/`, `make` targets from the repo root |
| After a native response or record shape changes, regenerate the contract fixtures and commit the JSON with the change | Changing a `workspace_request`, data-location or `plugins_request` response | load `.ai-run/guides/testing/testing-patterns.md` |
| Keep Microsoft tokens and plugin secrets out of snapshot types and the webview; they live under the private root | Touching sign-in, credentials, plugin secrets or the snapshot | load `.ai-run/guides/architecture/architecture.md` |
| Make the caller check the first statement of a Tauri command that reads workspace, plugin or data-folder state, and register the command inside `app_page_only` in `lib.rs` | Adding or changing a Tauri command | load `.ai-run/guides/architecture/architecture.md` |
| Run Claude through `ClaudeRunner`; tests use `FakeRunner`, and the `live_*` tests are run by hand | Code or tests that run Claude | load `.ai-run/guides/architecture/architecture.md` |
| Send workspace changes through the store's `mutate` (operation id and snapshot revision), not a direct invoke | UI code that changes workspace data | load `.ai-run/guides/architecture/architecture.md` |
<!-- ai-run-init:critical-rules end -->

## Commands

<!-- ai-run-init:commands start -->
| Need | Source Guide | Source Evidence | Notes |
|---|---|---|---|
| Quality gates (format, lint, test, build) | `.ai-run/guides/quality-gates.md` | each gate's Run, Pass and Fail in the guide | Load guide before running |
| Git / review workflow | .ai-run/guides/standards/git-workflow.md | git history and project context | Load guide before git operations |
<!-- ai-run-init:commands end -->

## Behavioral Defaults

<!-- ai-run-init:behavioral-defaults start -->
Behavioral guidelines to reduce common LLM coding mistakes. The Critical Rules above take precedence where they differ.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask; in an unattended run, record the assumption where the run records its decisions.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing before you go on.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals; write or run tests only as the Critical Rules allow:
- "Add validation" → "Name the invalid inputs it must reject and how each is checked"
- "Fix the bug" → "Reproduce it, then show it no longer happens"
- "Refactor X" → "Show the behavior is the same before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

Source: [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills).
<!-- ai-run-init:behavioral-defaults end -->
