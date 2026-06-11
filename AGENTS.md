# AGENTS.md

Primary AI entrypoint for `codemie-claude-installer-macos-tauri`. Load the relevant `.ai-run/guides/` file before changing code.

## Guide Imports

<!-- ai-run-init:guide-imports start -->
| Category | Guide Path | Purpose |
|---|---|---|
| Project | .ai-run/guides/project.md | Project identity, Jira adapter (brianna), GitLab remote, MR workflow |
| Architecture | .ai-run/guides/architecture/architecture.md | Frontend-brain + thin Rust backend (Option B), IPC pattern, component map |
| Testing | .ai-run/guides/testing/testing-patterns.md | Rust inline tests + JS node:test patterns, smoke modes |
| Development | .ai-run/guides/development/development-practices.md | Error handling, logging, async patterns, naming conventions |
| Git Workflow | .ai-run/guides/standards/git-workflow.md | Branch naming, conventional commits, squash merge |
| Quality Gates | .ai-run/guides/quality-gates.md | cargo fmt, cargo clippy, cargo test, npm test, build |
<!-- ai-run-init:guide-imports end -->

## Task Classifier

<!-- ai-run-init:task-classifier start -->
| Category | User Intent | Example Requests | P0 Guide | P1 Guide |
|---|---|---|---|---|
| Architecture | Understand code structure or IPC flow | "how does the frontend call Rust?", "where is the install logic?" | .ai-run/guides/architecture/architecture.md | - |
| Testing | Write or run tests | "add a test for X", "run the test suite" | .ai-run/guides/testing/testing-patterns.md | .ai-run/guides/quality-gates.md |
| Development | Add features, fix bugs, follow conventions | "add a new Rust command", "fix this error handler" | .ai-run/guides/development/development-practices.md | .ai-run/guides/architecture/architecture.md |
| Git / Review | Branch, commit, push, open MR | "commit this", "open an MR", "what's the branch format?" | .ai-run/guides/standards/git-workflow.md | .ai-run/guides/project.md |
| Quality | Lint, format, build, verify | "check formatting", "run all tests", "build the DMG" | .ai-run/guides/quality-gates.md | - |
<!-- ai-run-init:task-classifier end -->

## Critical Rules

<!-- ai-run-init:critical-rules start -->
| Rule | Trigger | Action |
|---|---|---|
| Check Guides First | ANY task | Match request to category → load P0 guide BEFORE searching the codebase |
| Testing | "write tests" / "run tests" | Load `.ai-run/guides/testing/testing-patterns.md` first |
| Git Operations | "commit" / "push" / "MR" | Load `.ai-run/guides/standards/git-workflow.md` first |
| Shell | ANY shell command | Use macOS/zsh-compatible syntax; Rust commands run from `src-tauri/` |
| New Rust Command | Any system op added to backend | Register in `src-tauri/src/lib.rs` invoke_handler; see architecture guide |
<!-- ai-run-init:critical-rules end -->

## Commands

<!-- ai-run-init:commands start -->
| Need | Source Guide | Source Evidence | Notes |
|---|---|---|---|
| Lint / format / test / build | .ai-run/guides/quality-gates.md | `package.json`, `src-tauri/Cargo.toml` | Load guide before running |
| Git / MR workflow | .ai-run/guides/standards/git-workflow.md | git log, GitLab remote | Load guide before git operations |
| Ticket / work-item lookup | .ai-run/guides/project.md | `brianna` skill, EPM-CDME Jira | Load project.md for adapter instructions |
<!-- ai-run-init:commands end -->
