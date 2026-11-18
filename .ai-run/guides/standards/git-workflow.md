# Git Workflow

**Project**: CodeMie Connect (`codemie-ai/codemie-connect`) · **Stack**: Rust + JavaScript (Tauri v2) · **Scope**: branch names, commit subjects, merge policy and their recovery steps; exact gate commands live in `.ai-run/guides/quality-gates.md`, the PR adapter in `.ai-run/guides/project.md`

---

## Branch Naming Convention

- base branch: main
- pattern: `<type>/EPMCDME-<number>-<kebab-slug>`

### Rules
- R1. Cut a ticket branch from `main` and name it `<type>/EPMCDME-<number>-<kebab-slug>` (`feat/EPMCDME-16171-update-manifest-from-releases`) or keep the `EPMCDME-<number>-<Title-Words>` name Jira's create-branch gives (`EPMCDME-16925-Add-a-Claude-Desktop-disconnect-action`); work with no ticket uses `<type>/<kebab-slug>` (`docs/readme-release-badge`, `ci/concurrency-fix`). This is the team's convention: no hook or CI job reads branch names. Evidence: `git branch -r` sample
- R2. Cut workspace-milestone work from the integration branch `workspace-app` and merge it back there; `workspace-app` reaches `main` later through its own PR. Evidence: merge commit `004c37e` ("merge: native CodeMie settings into workspace-app")

---

## Commit Message Format

```
<type>(<optional scope>): <subject>

[optional body: why the change, not what it does]
```

Examples: `fix: page the transcripts list, carry the glossary to a new folder, and put drafts before batch notes` · `feat: add Claude Desktop disconnect action (EPMCDME-16925) (#88)` · `fix(health): offer sign-in when the SSO API returns the HTML sign-in page (#87)`

### Rules
- R1. Write each subject as a Conventional Commit, `<type>(<optional scope>): <subject>`, with a type from `type-enum` in `commitlint.config.cjs` (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `revert`), the subject at most 100 characters and body and footer lines at most 300; the config allows a scope and any subject case. Evidence: `commitlint.config.cjs::type-enum`
- R2. Put the Jira key of ticket work in the PR title, which becomes the squash subject on `main`, as `(EPMCDME-<number>)` before GitHub's `(#<PR>)`; commits on a working branch may leave it out. Evidence: `git log main` sample (`feat: add Claude Desktop disconnect action (EPMCDME-16925) (#88)`)
- R3. Expect the PR title to be linted, not each commit: `pr-title-lint.yml` runs the shared `reusable-commit-lint.yml` on PRs into `main`, and the repository has no commit-msg hook. Evidence: `.github/workflows/pr-title-lint.yml::pr-title`

## Anti-Patterns

| Do not | Do instead | Why |
|---|---|---|
| Commit `fix stuff`, `WIP` or a subject off the format | `fix: pty output truncated on macOS Sequoia` | the PR title becomes the subject `main` keeps |
| Use a type outside `type-enum` (`feature:`, `bugfix:`) | one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `revert` | `commitlint.config.cjs` rejects other types |
| Push to `main` directly | open a PR from a branch | `ci.yaml`, the PR title lint and CodeQL run on pull requests |
| Force-push a shared branch with `--force` | `git push --force-with-lease`, on your own branch | a teammate's commits survive |

---

## Merge Strategy

**Squash merge** — one commit per PR on `main`, its subject the PR title followed by `(#<PR>)`. Keeps history linear.

### Rules
- R1. Merge a PR into `main` once the `CI` workflow's `Lint & Tests (macOS)` job (format, clippy, `npm test`, `cargo test`, app and DMG build) and its `Security` secrets job pass on it. Evidence: `.github/workflows/ci.yaml::jobs.test`

After merge: delete the feature branch.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Tauri dev fails after branch switch | `cd src-tauri && cargo clean && cargo tauri dev` |
| `cargo build` picks up stale generated code | Delete `src-tauri/target/` and rebuild |
| `git status` shows icon files dirty | These are binary assets; verify they were intentionally regenerated with `cargo tauri icon` |
