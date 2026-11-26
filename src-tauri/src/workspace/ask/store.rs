//! Ask's threads (ask-capture design § 5): one bookkeeping record of kind `ask_thread` per
//! conversation in `workspace.sqlite` — `connection_id` and `workspace_id` both `None`, `source`
//! `"local"` — so `Repository::snapshot`'s record queries never admit one (they let a
//! workspace-less, connection-less row in only as `plugin_item` or `plugin_widget`), the same way
//! the voice copy stays out (`voice::copy`). The snapshot carries titles only (`super::snapshot`);
//! the whole thread is read by `ask_read`.
//!
//! Kept 30 days after the last turn, at most 50 threads (the least recently updated go first) of
//! 20 turns each; `prune` runs on every `ask_start` and once at start-up.
use crate::workspace::models::{id, Record, Result, WorkspaceError};
use crate::workspace::repository::Repository;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const KIND: &str = "ask_thread";
/// Days a thread is kept after its last turn.
pub const KEEP_DAYS: i64 = 30;
/// Threads kept at most; the least recently updated go first.
pub const MAX_THREADS: usize = 50;
/// Turns a thread holds at most; the 21st question is refused.
pub const MAX_TURNS: usize = 20;
/// A thread's title: its first question cut to this many characters.
pub const TITLE_MAX: usize = 80;

/// One conversation (design § 5). `next_ref` is the per-conversation counter context item ids
/// come from, never reused (ruling 33); it starts at 1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub next_ref: u32,
    #[serde(default)]
    pub turns: Vec<Turn>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    Queued,
    Running,
    Done,
    Failed,
    Stopped,
}

/// One question and its answer (design § 5).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub at: i64,
    pub question: String,
    pub about: Option<RefItem>,
    pub state: TurnState,
    pub answer: Option<String>,
    #[serde(default)]
    pub cites: Vec<Cite>,
    #[serde(default)]
    pub actions: Vec<Value>,
    pub searched: Option<String>,
    #[serde(default)]
    pub cut: bool,
    /// Seconds from the question to the answer (the page's meta line), set when the turn is
    /// `done`; older records read `null`.
    #[serde(default)]
    pub took: Option<i64>,
    pub profile: Option<String>,
    pub model: Option<String>,
    pub fell_back_from: Option<String>,
    pub error: Option<TurnError>,
    pub job_id: Option<String>,
}

/// The record a question is About (design § 5). `gone` is `true` when the record was missing
/// when the job ran (ruling 34): the About keeps its label and says so.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefItem {
    pub kind: String,
    pub record_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub gone: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One citation an answer kept (design § 8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cite {
    pub id: String,
    pub kind: String,
    pub record_id: Option<String>,
    pub label: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnError {
    pub code: String,
    pub message: String,
}

impl Thread {
    /// The thread's first question cut to `TITLE_MAX` characters; empty with no turn.
    pub fn title(&self) -> String {
        self.turns
            .first()
            .map(|t| {
                t.question
                    .trim()
                    .chars()
                    .take(TITLE_MAX)
                    .collect::<String>()
            })
            .map(|t| t.trim_end().to_string())
            .unwrap_or_default()
    }
}

fn record(t: &Thread) -> Result<Record> {
    Ok(Record {
        id: t.id.clone(),
        kind: KIND.into(),
        connection_id: None,
        workspace_id: None,
        source: "local".into(),
        revision: id(),
        updated_at: t.updated_at,
        data: serde_json::to_value(t).map_err(|_| unreadable())?,
    })
}

/// A thread that doesn't read back: the same storage error a bad document gives elsewhere,
/// never its text.
fn unreadable() -> WorkspaceError {
    WorkspaceError::new(
        "storage",
        "Workspace data needs recovery. The database has been retained.",
    )
}

fn decode(r: Record) -> Result<Thread> {
    serde_json::from_value(r.data).map_err(|_| unreadable())
}

/// The thread `id`, or `None` when there is none.
pub fn read(r: &Repository, id: &str) -> Result<Option<Thread>> {
    match r.record(KIND, id, None, None) {
        Ok(rec) => decode(rec).map(Some),
        Err(e) if e.code == "not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

/// Writes `t` whole (one revision bump: the snapshot's `ask` changes with it).
pub fn write(r: &mut Repository, t: &Thread) -> Result<()> {
    r.put_global_records(&[record(t)?])
}

/// Every thread, the most recently updated first (ties by id, newest first).
pub fn list(r: &Repository) -> Result<Vec<Thread>> {
    let mut threads = r
        .plugin_records(KIND)?
        .into_iter()
        .map(decode)
        .collect::<Result<Vec<_>>>()?;
    threads.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(threads)
}

/// Deletes the thread `id`; answers how many went (0 or 1).
pub fn delete(r: &mut Repository, id: &str) -> Result<usize> {
    r.delete_global_records(KIND, &[id.to_string()])
}

/// Deletes every thread; answers how many went.
pub fn delete_all(r: &mut Repository) -> Result<usize> {
    let ids: Vec<String> = list(r)?.into_iter().map(|t| t.id).collect();
    r.delete_global_records(KIND, &ids)
}

/// Deletes the threads last updated more than `KEEP_DAYS` before `now`, then all but the
/// `MAX_THREADS` most recently updated; answers how many went.
pub fn prune(r: &mut Repository, now: i64) -> Result<usize> {
    let cutoff = now - KEEP_DAYS * 86_400;
    let gone: Vec<String> = list(r)?
        .into_iter()
        .enumerate()
        .filter(|(n, t)| t.updated_at < cutoff || *n >= MAX_THREADS)
        .map(|(_, t)| t.id)
        .collect();
    if gone.is_empty() {
        return Ok(0);
    }
    r.delete_global_records(KIND, &gone)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn turn(n: usize, at: i64, question: &str, state: TurnState) -> Turn {
        Turn {
            id: format!("turn-{n}"),
            at,
            question: question.into(),
            about: None,
            state,
            answer: None,
            cites: Vec::new(),
            actions: Vec::new(),
            searched: None,
            cut: false,
            took: None,
            profile: None,
            model: None,
            fell_back_from: None,
            error: None,
            job_id: None,
        }
    }

    pub(crate) fn thread(id: &str, at: i64, turns: Vec<Turn>) -> Thread {
        Thread {
            id: id.into(),
            created_at: turns.first().map(|t| t.at).unwrap_or(at),
            updated_at: at,
            next_ref: 1,
            turns,
        }
    }

    fn repo(dir: &std::path::Path) -> Repository {
        Repository::open(&dir.join("workspace.sqlite")).unwrap()
    }

    #[test]
    fn a_thread_round_trips_with_its_turns() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = repo(dir.path());
        assert_eq!(read(&r, "ask-1").unwrap(), None);
        let mut t = thread(
            "ask-1",
            100,
            vec![turn(1, 100, "When is the QBR?", TurnState::Done)],
        );
        t.next_ref = 7;
        t.turns[0].about = Some(RefItem {
            kind: "message".into(),
            record_id: "m-1".into(),
            label: "Jordan Lee".into(),
            gone: false,
        });
        write(&mut r, &t).unwrap();
        assert_eq!(read(&r, "ask-1").unwrap(), Some(t.clone()));
        let stored = r.record(KIND, "ask-1", None, None).unwrap();
        assert_eq!(stored.source, "local");
        assert_eq!(stored.data["nextRef"], 7);
        // `gone` is written only when true.
        assert!(stored.data["turns"][0]["about"].get("gone").is_none());
        t.turns[0].about.as_mut().unwrap().gone = true;
        write(&mut r, &t).unwrap();
        let stored = r.record(KIND, "ask-1", None, None).unwrap();
        assert_eq!(stored.data["turns"][0]["about"]["gone"], true);
    }

    #[test]
    fn title_is_the_first_question_cut_to_80() {
        let long = format!("  {}", "é".repeat(120));
        let t = thread(
            "ask-1",
            1,
            vec![
                turn(1, 1, &long, TurnState::Done),
                turn(2, 2, "And the second?", TurnState::Done),
            ],
        );
        assert_eq!(t.title(), "é".repeat(TITLE_MAX));
        let short = thread(
            "ask-2",
            1,
            vec![turn(1, 1, "When is the QBR?", TurnState::Done)],
        );
        assert_eq!(short.title(), "When is the QBR?");
        assert_eq!(thread("ask-3", 1, Vec::new()).title(), "");
    }

    #[test]
    fn list_is_newest_first_and_deletes_answer_counts() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = repo(dir.path());
        for (id, at) in [("ask-a", 10), ("ask-b", 30), ("ask-c", 20)] {
            write(&mut r, &thread(id, at, Vec::new())).unwrap();
        }
        let ids: Vec<String> = list(&r).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, ["ask-b", "ask-c", "ask-a"]);
        assert_eq!(delete(&mut r, "ask-c").unwrap(), 1);
        assert_eq!(delete(&mut r, "ask-c").unwrap(), 0);
        assert_eq!(delete_all(&mut r).unwrap(), 2);
        assert!(list(&r).unwrap().is_empty());
    }

    #[test]
    fn prune_drops_old_and_excess_threads() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = repo(dir.path());
        let now = 1_795_000_000;
        let day = 86_400;
        write(&mut r, &thread("ask-old", now - 31 * day, Vec::new())).unwrap();
        write(&mut r, &thread("ask-kept", now - 29 * day, Vec::new())).unwrap();
        assert_eq!(prune(&mut r, now).unwrap(), 1);
        assert_eq!(read(&r, "ask-old").unwrap(), None);
        assert!(read(&r, "ask-kept").unwrap().is_some());

        delete_all(&mut r).unwrap();
        for n in 0..52 {
            write(&mut r, &thread(&format!("ask-{n:02}"), now - n, Vec::new())).unwrap();
        }
        assert_eq!(prune(&mut r, now).unwrap(), 2);
        let left = list(&r).unwrap();
        assert_eq!(left.len(), MAX_THREADS);
        assert_eq!(left.first().unwrap().id, "ask-00");
        assert_eq!(left.last().unwrap().id, "ask-49");
        assert_eq!(prune(&mut r, now).unwrap(), 0);
    }
}
