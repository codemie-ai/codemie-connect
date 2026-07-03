# Git Workflow

Git conventions for `codemie-claude-installer-macos-tauri`: branching, commits, and merge strategy.

---

## Branch Naming Convention

| Branch type | Pattern | Example |
|---|---|---|
| Feature | `feat/<slug>` | `feat/tauri-macos-installer` |
| Fix | `fix/<slug>` | `fix/pty-resize-crash` |
| Chore | `chore/<slug>` | `chore/update-tauri-deps` |
| Docs | `docs/<slug>` | `docs/update-readme` |

Use lowercase kebab-case slugs. No ticket prefix required in branch names (commits carry context).

---

## Commit Message Format

Conventional Commits — type-only (no scope required):

```
<type>: <short description>
```

**Types**: `feat` | `fix` | `docs` | `test` | `chore` | `refactor`

**Examples from this repo** (`git log --oneline`):
- `feat: connect-desktop screen + live profile-status auth check`
- `chore: rebrand footer + bundle copyright to "EPAM AI/Run CodeMie ©"`
- `docs: complete README — home launcher, connect/analytics actions`
- `test: SMOKE exercises run_stream + computed-style check`

### Anti-Patterns

| Avoid | Prefer |
|---|---|
| `fix stuff` | `fix: pty output truncated on macOS Sequoia` |
| `WIP` | Stage as a commit only when the change is complete |
| `feat(auth): add login` with scope | `feat: add login` — scope is optional, omit unless project conventions evolve |

---

## Merge Strategy

**Squash merge** — one commit per MR on `main`. Keeps history linear; MR description becomes the squash commit body.

After merge: delete the feature branch.

Open MR against `main` via `glab mr create` with `--remove-source-branch`:

```bash
glab mr create \
  --title "<type>: Capital sentence" \
  --target-branch main \
  --remove-source-branch \
  --yes
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Tauri dev fails after branch switch | `cd src-tauri && cargo clean && cargo tauri dev` |
| `cargo build` picks up stale generated code | Delete `src-tauri/target/` and rebuild |
| `git status` shows icon files dirty | These are binary assets; verify they were intentionally regenerated with `cargo tauri icon` |
