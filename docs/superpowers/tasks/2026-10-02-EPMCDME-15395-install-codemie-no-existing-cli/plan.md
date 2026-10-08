# EPMCDME-15395: Real-Filesystem Tests for find_working_global_codemie

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the real-subprocess coverage gap by adding two #[cfg(not(windows))] tests that call find_working_global_codemie with an actual filesystem binary — one that exits 1, one that echoes a version.

**Architecture:** New test module appended to `src-tauri/src/commands/handshake.rs`; no production code changes. tempfile is already a dev-dep. Tests verify the real `std::process::Command` path, not the mock-closure path.

**Tech Stack:** Rust, tempfile 3, std::os::unix::fs::PermissionsExt

**Spec:** requirements inline (see task_dir/spec.md)

## Global Constraints

- Module gated `#[cfg(not(windows))]` — these tests spawn real sh scripts, macOS/Linux only.
- No changes to production code; implementation is already correct (EPMCDME-15257).
- Commit per task using the repository's existing conventional-commit convention.

---

## Acceptance criteria

- Broken shim binary (exits 1) on PATH → `find_working_global_codemie` returns `None`.
- Working binary (echoes `codemie 1.2.3`) on PATH → returns `Some("1.2.3")`.
- All `cargo test` invocations pass (new tests included).
- No test calls a mock closure — both tests exercise the real subprocess path.

---

### Task 1: Add tests_find_working_global module to handshake.rs

**Files:**
- Modify: `src-tauri/src/commands/handshake.rs:228` (append after the closing `}` of the existing `#[cfg(test)] mod tests` block)

**Interfaces:**
- Consumes: `find_working_global_codemie(path_env: &str) -> Option<String>` (handshake.rs:40)
- Produces: two test functions visible to `cargo test`

**Test-first: yes — add the module with both tests, confirm they compile and pass; no production code change required**

- [ ] **Step 1: Append the test module**

Add at the end of `src-tauri/src/commands/handshake.rs` (after line 227):

```rust
#[cfg(test)]
#[cfg(not(windows))]
mod tests_find_working_global {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    #[test]
    fn broken_binary_returns_none() {
        let dir = TempDir::new().unwrap();
        let bin = dir.path().join("codemie");
        fs::write(&bin, b"#!/bin/sh\nexit 1").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = dir.path().to_str().unwrap().to_string();
        assert!(
            find_working_global_codemie(&path_env).is_none(),
            "a binary that exits 1 must not count as a working global CLI"
        );
    }

    #[test]
    fn working_binary_returns_version() {
        let dir = TempDir::new().unwrap();
        let bin = dir.path().join("codemie");
        fs::write(&bin, b"#!/bin/sh\necho 'codemie 1.2.3'").unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let path_env = dir.path().to_str().unwrap().to_string();
        assert_eq!(
            find_working_global_codemie(&path_env),
            Some("1.2.3".to_string()),
            "a binary that exits 0 and prints a semver must be returned"
        );
    }
}
```

- [ ] **Step 2: Run the new tests**

From `src-tauri/`:
```
cargo test tests_find_working_global
```
Expected: both tests PASS. No production code change is needed.

- [ ] **Step 3: Run the full handshake test suite**

```
cargo test commands::handshake
```
Expected: all 10 tests pass (8 existing + 2 new).

---

## Negative-constraint pass

Out-of-scope items from the requirements: UI messaging for "bundled CLI in use", automatic CLI install at startup, checkHandshakeState frontend plumbing. No task in this plan touches any of those surfaces. No task emits a whole-suite quality gate.

negative-constraints: none stated as formal "must not" rules; the three out-of-scope items have no corresponding task in this plan and no task violates them.
