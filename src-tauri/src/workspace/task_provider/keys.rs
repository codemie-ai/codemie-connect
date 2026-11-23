//! Idempotent keys (design §3, §9): every task carries a stable key derived from where it came
//! from and its text, so a retry, a rerun or a crash between "sent" and "acknowledged" never
//! makes a second task. The ledger (kind `task_key`) remembers, per provider and key, the remote
//! id a create got and its state, so a task completed or deleted in the provider is not made
//! again by a rerun.
use crate::workspace::models::{Record, Result, WorkspaceError};
use crate::workspace::repository::Repository;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use unicode_normalization::UnicodeNormalization;

/// Bookkeeping (kind `task_key`, id `<provider>|<key>`, unversioned, no workspace: the id is
/// already unique). Read and written by the outbox and sync job (Task 4); until then
/// `ledger_get`/`ledger_put` are exercised only by this module's own tests.
const LEDGER_KIND: &str = "task_key";

/// Naya's normalization (`commitmentKey`): NFKC, lower case, letters, digits and `#` kept,
/// spaces collapsed to one, leading and trailing space dropped. Everything else (punctuation,
/// dashes, emoji) is dropped without leaving a gap.
pub(crate) fn normalize(text: &str) -> String {
    let folded: String = text.nfkc().collect::<String>().to_lowercase();
    let mut out = String::with_capacity(folded.len());
    let mut pending_space = false;
    for ch in folded.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if ch.is_alphanumeric() || ch == '#' {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }
    out
}

/// `sha1("<source>#<normalized text>")`, the first 16 hex characters (design §3, §9).
pub(crate) fn task_key(source: &str, text: &str) -> String {
    let input = format!("{source}#{}", normalize(text));
    let digest = Sha1::digest(input.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[allow(dead_code)] // called by ledger_get/ledger_put, which the outbox and sync job (Task 4) use
fn ledger_id(provider: &str, key: &str) -> String {
    format!("{provider}|{key}")
}

/// The ledger entry for `provider`'s `key` (`{remoteId, state, at}`), or `None` when the key was
/// never created for that provider.
#[allow(dead_code)] // the outbox and sync job (Task 4) check the ledger before a create
pub(crate) fn ledger_get(r: &Repository, provider: &str, key: &str) -> Result<Option<Value>> {
    match r.record(LEDGER_KIND, &ledger_id(provider, key), None, None) {
        Ok(record) => Ok(Some(record.data)),
        Err(WorkspaceError { code, .. }) if code == "not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

/// Remembers `key`'s outcome with `provider`: `state` is `created`, `done`, `withdrawn` or
/// `removed` (design §3); `remote_id` is the provider's task id, when there is one.
#[allow(dead_code)] // the outbox and sync job (Task 4) record a create's remote id this way
pub(crate) fn ledger_put(
    r: &mut Repository,
    provider: &str,
    key: &str,
    remote_id: Option<&str>,
    state: &str,
    now: i64,
) -> Result<()> {
    r.put_record_unversioned(&Record {
        id: ledger_id(provider, key),
        kind: LEDGER_KIND.into(),
        connection_id: None,
        workspace_id: None,
        source: "local".into(),
        revision: crate::workspace::models::id(),
        updated_at: now,
        data: json!({"remoteId": remote_id, "state": state, "at": now}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_core;

    #[test]
    fn task_key_matches_nayas_normalization() {
        let a = task_key("meeting:m1:4", "I'll send you the names by Friday.");
        let b = task_key("meeting:m1:4", "  i'll SEND you the names, by friday ");
        assert_eq!(
            a, b,
            "same source and the same text, differently cased and punctuated"
        );
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "{a}");
        let c = task_key("message:m-1", "I'll send you the names by Friday.");
        assert_ne!(a, c, "another source gives another key");
        assert_eq!(normalize("Ёлка — #2!"), "ёлка #2");
    }

    #[test]
    fn ledger_remembers_a_keys_outcome_per_provider() {
        let dir = tempfile::tempdir().unwrap();
        let core = test_core(
            dir.path(),
            std::sync::Arc::new(crate::ai::fake::FakeRunner::new(vec![])),
            crate::workspace::ai::tests::ready(),
        );
        let mut r = core.repo().unwrap();
        assert_eq!(ledger_get(&r, "plugin:todoist", "abc123").unwrap(), None);
        ledger_put(
            &mut r,
            "plugin:todoist",
            "abc123",
            Some("8124"),
            "created",
            1_795_000_000,
        )
        .unwrap();
        let entry = ledger_get(&r, "plugin:todoist", "abc123").unwrap().unwrap();
        assert_eq!(entry["remoteId"], "8124");
        assert_eq!(entry["state"], "created");
        // Another provider's ledger for the same key is separate.
        assert_eq!(ledger_get(&r, "local", "abc123").unwrap(), None);
    }
}
