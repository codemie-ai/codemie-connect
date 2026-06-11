// PATH management. Port of src/main/pathman.js.
use std::collections::HashSet;

use tauri::State;

use crate::error::CmdResult;
use crate::state::AppState;

const MARKER: &str = "# Added by CodeMie Installer";
const PATH_MARKER: &str = "__CODEMIE_PATH_MARKER__";

/// Candidate dirs where git/node/npm live on macOS, plus the common user npm prefix.
pub fn candidate_dirs() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        format!("{home}/.npm-global/bin"),
    ]
}

/// Dedupe a ':'-joined PATH, preserving first-occurrence order and dropping empties.
pub fn dedupe_path(path_str: &str) -> String {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in path_str.split(':') {
        if p.is_empty() || !seen.insert(p) {
            continue;
        }
        out.push(p);
    }
    out.join(":")
}

/// Return only the entries not already present in `path_str`.
pub fn missing_entries(path_str: &str, entries: &[String]) -> Vec<String> {
    let present: HashSet<&str> = path_str.split(':').filter(|p| !p.is_empty()).collect();
    entries
        .iter()
        .filter(|e| !present.contains(e.as_str()))
        .cloned()
        .collect()
}

/// Merge the user's resolved shell PATH (highest priority) with the current PATH
/// and candidate dirs, deduped.
pub fn merge_shell_path(shell_path: &str, current_path: &str, candidates: &[String]) -> String {
    let mut joined = format!("{shell_path}:{current_path}");
    for c in candidates {
        joined.push(':');
        joined.push_str(c);
    }
    dedupe_path(&joined)
}

/// PATH used by run_fresh_env: current PATH + remembered install dirs + candidates.
pub fn fresh_env_path(remembered: &[String]) -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut joined = current;
    for d in remembered {
        joined.push(':');
        joined.push_str(d);
    }
    for c in candidate_dirs() {
        joined.push(':');
        joined.push_str(&c);
    }
    dedupe_path(&joined)
}

/// Resolve the user's interactive-login shell PATH. Runs `$SHELL -ilc` with a marker
/// trick (brace-delimited ${PATH}) and a hard 8s timeout via a worker thread.
pub fn resolve_shell_path() -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let script = format!("printf '%s' \"{PATH_MARKER}${{PATH}}{PATH_MARKER}\"");
        let res = std::process::Command::new(&shell)
            .arg("-ilc")
            .arg(&script)
            .output();
        let _ = tx.send(res);
    });
    match rx.recv_timeout(std::time::Duration::from_secs(8)) {
        Ok(Ok(out)) => {
            let s = String::from_utf8_lossy(&out.stdout);
            let parts: Vec<&str> = s.split(PATH_MARKER).collect();
            if parts.len() >= 3 && parts[1].contains('/') {
                return Some(parts[1].to_string());
            }
            None
        }
        _ => None,
    }
}

/// Resolve and apply the user's shell PATH to this process so child processes inherit it.
pub fn apply_resolved_shell_path() -> String {
    let shell_path = resolve_shell_path().unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    let merged = merge_shell_path(&shell_path, &current, &candidate_dirs());
    std::env::set_var("PATH", &merged);
    merged
}

/// Persist entries to ~/.zprofile, idempotently (skip entries already referenced).
fn persist(entries: &[String]) -> std::io::Result<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let file = format!("{home}/.zprofile");
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let to_add: Vec<&String> = entries
        .iter()
        .filter(|e| !e.is_empty() && !existing.contains(e.as_str()))
        .collect();
    if to_add.is_empty() {
        return Ok(file);
    }
    let joined: Vec<String> = to_add.iter().map(|s| s.to_string()).collect();
    let block = format!("\n{MARKER}\nexport PATH=\"{}:$PATH\"\n", joined.join(":"));
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)?;
    f.write_all(block.as_bytes())?;
    Ok(file)
}

// ---- Tauri commands ----

#[tauri::command]
pub fn persist_to_zprofile(entries: Vec<String>) -> CmdResult<String> {
    persist(&entries).map_err(Into::into)
}

/// Remember freshly-installed tool dirs for subsequent run_fresh_env calls.
#[tauri::command]
pub fn augment_path(state: State<AppState>, dirs: Vec<String>) {
    let mut remembered = state.remembered.lock().unwrap();
    let clean: Vec<String> = dirs.into_iter().filter(|d| !d.is_empty()).collect();
    for d in missing_entries(&remembered.join(":"), &clean) {
        if !remembered.contains(&d) {
            remembered.push(d);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/pathman.test.js.
    #[test]
    fn dedupe_path_preserves_first_occurrence_and_drops_empties() {
        assert_eq!(dedupe_path("/a:/b:/a:/c"), "/a:/b:/c");
        assert_eq!(dedupe_path("/a::/b:"), "/a:/b");
    }

    #[test]
    fn missing_entries_returns_only_entries_not_present() {
        let e = vec!["/b".to_string(), "/c".to_string(), "/d".to_string()];
        assert_eq!(missing_entries("/a:/b", &e), vec!["/c", "/d"]);
        let e2 = vec!["/a".to_string(), "/b".to_string()];
        assert!(missing_entries("/a:/b", &e2).is_empty());
    }

    #[test]
    fn merge_shell_path_orders_shell_then_current_then_candidates_deduped() {
        let cand = vec!["/d".to_string(), "/a".to_string()];
        assert_eq!(merge_shell_path("/a:/b", "/b:/c", &cand), "/a:/b:/c:/d");
        let cand2 = vec!["/y".to_string()];
        assert_eq!(merge_shell_path("", "/x", &cand2), "/x:/y");
    }

    // Regression: resolveShellPath must brace-delimit ${PATH} and strip markers.
    #[test]
    fn resolve_shell_path_captures_real_login_shell_path() {
        let r = resolve_shell_path().expect("resolved shell PATH on a macOS box");
        assert!(r.contains('/'), "resolved PATH should contain directories");
        assert!(!r.contains(PATH_MARKER), "markers must be stripped");
    }
}
