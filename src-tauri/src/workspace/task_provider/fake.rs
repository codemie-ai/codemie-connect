//! `FakeProvider`: a scripted task provider for tests (design §5 "Tests use `FakeProvider`").
//! It keeps an in-memory, Todoist-like store (`create` adopts an open task with the same key,
//! `changedSince` answers from a version cursor), records every call, and can be told to fail:
//! every call (`fail_all`), the next call of one op (`answer`), or the next call of one op after
//! the store already did the work (`lose_answer`, a create that timed out after Todoist made it).
use super::{ProviderError, ProviderInfo, TaskProviders};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Mutex;

/// Wed 18 Nov 2026, 12:00 UTC: when the fake's tasks were last changed, unless `set_time` says.
const T0: i64 = 1_795_003_200;

#[derive(Default)]
struct Inner {
    scripted: HashMap<String, VecDeque<Result<Value, ProviderError>>>,
    lose: HashMap<String, usize>,
    failing: Option<ProviderError>,
    calls: Vec<(String, Value)>,
    times: Vec<tokio::time::Instant>,
    /// Remote id -> `(version, task)`.
    tasks: BTreeMap<String, (u64, Value)>,
    removed: Vec<(u64, String)>,
    version: u64,
    next_id: u64,
    time: i64,
    available: Option<Vec<ProviderInfo>>,
    /// What `loading` answers (default false: the manager has settled).
    loading: bool,
    /// Runs once at the next call of an op, while that call is on its way.
    during: HashMap<String, Box<dyn FnOnce() + Send>>,
    /// How long each answer takes (tokio's clock).
    delay: Option<std::time::Duration>,
    secret: Option<String>,
    fingerprint: Option<String>,
}

pub struct FakeProvider {
    inner: Mutex<Inner>,
}

impl Default for FakeProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn at(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

impl FakeProvider {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                next_id: 8124,
                time: T0,
                ..Default::default()
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The next call of `op` answers `result` instead of the store.
    pub fn answer(&self, op: &str, result: Result<Value, ProviderError>) {
        self.lock()
            .scripted
            .entry(op.into())
            .or_default()
            .push_back(result);
    }

    /// The next call of `op` is done by the store, but its answer is lost (`Offline`).
    pub fn lose_answer(&self, op: &str) {
        *self.lock().lose.entry(op.into()).or_default() += 1;
    }

    /// Every call fails with `error` until called again with `None`.
    pub fn fail_all(&self, error: Option<ProviderError>) {
        self.lock().failing = error;
    }

    /// Every call so far: `(op, args)`.
    pub fn calls(&self) -> Vec<(String, Value)> {
        self.lock().calls.clone()
    }

    /// The ops called so far, in order.
    pub fn ops(&self) -> Vec<String> {
        self.lock().calls.iter().map(|(op, _)| op.clone()).collect()
    }

    /// When each call was made (tokio's clock, so a paused test clock counts).
    pub fn call_times(&self) -> Vec<tokio::time::Instant> {
        self.lock().times.clone()
    }

    /// The tasks the store holds, by id.
    pub fn tasks(&self) -> Vec<Value> {
        self.lock().tasks.values().map(|(_, t)| t.clone()).collect()
    }

    /// The time the store stamps on what changes next.
    pub fn set_time(&self, t: i64) {
        self.lock().time = t;
    }

    /// A change made in the provider itself: `task` (with its `id`) is stored as given, stamped
    /// with the store's time.
    pub fn put_remote(&self, mut task: Value) {
        let mut s = self.lock();
        s.version += 1;
        task["updatedAt"] = at(s.time).into();
        let id = task["id"].as_str().unwrap_or_default().to_string();
        let v = s.version;
        s.tasks.insert(id, (v, task));
    }

    /// A task deleted in the provider itself.
    pub fn remove_remote(&self, id: &str) {
        let mut s = self.lock();
        s.version += 1;
        let v = s.version;
        s.tasks.remove(id);
        s.removed.push((v, id.into()));
    }

    /// A task the full list holds that no `changedSince` with a cursor reports (one of another
    /// project, now the chosen one): stored unchanged since the beginning.
    pub fn put_remote_unchanged(&self, mut task: Value) {
        let mut s = self.lock();
        task["updatedAt"] = at(s.time).into();
        let id = task["id"].as_str().unwrap_or_default().to_string();
        s.tasks.insert(id, (0, task));
    }

    /// A task the provider stops listing without reporting it removed (moved to another project,
    /// or the project setting now names another one).
    pub fn forget_remote(&self, id: &str) {
        self.lock().tasks.remove(id);
    }

    /// What `available` lists (default: Todoist, on and ready).
    pub fn set_available(&self, available: Vec<ProviderInfo>) {
        self.lock().available = Some(available);
    }

    /// What `loading` answers from now on (default false): simulates a reload still under way
    /// (I1), so a provider that isn't `ready` yet is not called failed.
    pub fn set_loading(&self, loading: bool) {
        self.lock().loading = loading;
    }

    /// Runs `f` once, at the next call of `op`, before that call answers: an edit made while
    /// the call is on its way.
    pub fn during(&self, op: &str, f: impl FnOnce() + Send + 'static) {
        self.lock().during.insert(op.into(), Box::new(f));
    }

    /// Every answer takes `delay` from now on.
    pub fn set_delay(&self, delay: std::time::Duration) {
        self.lock().delay = Some(delay);
    }

    /// What `fingerprint` answers from now on (default `None`: no fingerprint kept).
    pub fn set_fingerprint(&self, fingerprint: Option<&str>) {
        self.lock().fingerprint = fingerprint.map(str::to_string);
    }

    /// The provider's stored secret, for `secret_matches`.
    pub fn set_secret(&self, secret: &str) {
        self.lock().secret = Some(secret.into());
    }

    fn touch(s: &mut Inner, id: &str, change: impl FnOnce(&mut Value)) -> Option<Value> {
        s.version += 1;
        let (v, time) = (s.version, at(s.time));
        let (version, task) = s.tasks.get_mut(id)?;
        change(task);
        task["updatedAt"] = time.into();
        *version = v;
        Some(task.clone())
    }

    fn perform(s: &mut Inner, op: &str, args: &Value) -> Result<Value, ProviderError> {
        let gone = || ProviderError::NotFound("Todoist doesn't have this task any more".into());
        let id = args["id"].as_str().unwrap_or_default().to_string();
        match op {
            "status" => Ok(json!({"ok": true, "account": "Taylor Morgan", "project": "Connect"})),
            "list" => Ok(json!({"tasks": s.tasks.values()
                .filter(|(_, t)| t["done"] != true).map(|(_, t)| t.clone()).collect::<Vec<_>>()})),
            "create" => {
                let key = args["key"].clone();
                if let Some((_, open)) = s
                    .tasks
                    .values()
                    .find(|(_, t)| t["key"] == key && t["done"] != true)
                {
                    let mut adopted = open.clone();
                    adopted["adopted"] = true.into();
                    return Ok(adopted);
                }
                let rid = s.next_id.to_string();
                s.next_id += 1;
                s.version += 1;
                let mut task = args["task"].clone();
                task["id"] = rid.clone().into();
                task["key"] = key;
                task["url"] = format!("https://app.todoist.com/app/task/{rid}").into();
                let mut labels: Vec<Value> = task["labels"].as_array().cloned().unwrap_or_default();
                for label in ["connect", task["kind"].as_str().unwrap_or("task")] {
                    if label != "task" && !labels.iter().any(|l| l == label) {
                        labels.push(label.into());
                    }
                }
                task["labels"] = labels.into();
                task["updatedAt"] = at(s.time).into();
                let v = s.version;
                s.tasks.insert(rid, (v, task.clone()));
                Ok(task)
            }
            "update" => Self::touch(s, &id, |t| {
                for (k, v) in args["patch"].as_object().into_iter().flatten() {
                    t[k] = v.clone();
                }
            })
            .ok_or_else(gone),
            "complete" => {
                let done = args["done"] == true;
                Self::touch(s, &id, |t| t["done"] = done.into()).ok_or_else(gone)
            }
            "remove" => {
                // As the real plugin: a task the provider no longer has is removed already.
                if s.tasks.remove(&id).is_none() {
                    return Ok(json!({"removed": true}));
                }
                s.version += 1;
                let v = s.version;
                s.removed.push((v, id));
                Ok(json!({"removed": true}))
            }
            "changedSince" => {
                let since: Option<u64> = args["cursor"].as_str().and_then(|c| c.parse().ok());
                let tasks: Vec<Value> = s
                    .tasks
                    .values()
                    .filter(|(v, t)| match since {
                        None => t["done"] != true,
                        Some(c) => *v > c,
                    })
                    .map(|(_, t)| t.clone())
                    .collect();
                let removed: Vec<&String> = s
                    .removed
                    .iter()
                    .filter(|(v, _)| since.is_some_and(|c| *v > c))
                    .map(|(_, id)| id)
                    .collect();
                Ok(json!({"tasks": tasks, "removed": removed, "cursor": s.version.to_string()}))
            }
            _ => Err(ProviderError::Offline),
        }
    }
}

impl TaskProviders for FakeProvider {
    fn call(
        &self,
        _plugin: &str,
        op: &str,
        args: Value,
    ) -> BoxFuture<'static, Result<Value, ProviderError>> {
        let mut s = self.lock();
        s.calls.push((op.into(), args.clone()));
        s.times.push(tokio::time::Instant::now());
        let answer = if let Some(e) = s.failing.clone() {
            Err(e)
        } else if let Some(scripted) = s.scripted.get_mut(op).and_then(VecDeque::pop_front) {
            scripted
        } else if s.lose.get(op).is_some_and(|n| *n > 0) {
            *s.lose.get_mut(op).expect("counted") -= 1;
            let _ = Self::perform(&mut s, op, &args);
            Err(ProviderError::Offline)
        } else {
            Self::perform(&mut s, op, &args)
        };
        let (during, delay) = (s.during.remove(op), s.delay);
        drop(s);
        if let Some(f) = during {
            f();
        }
        Box::pin(async move {
            if let Some(d) = delay {
                tokio::time::sleep(d).await;
            }
            answer
        })
    }

    fn available(&self) -> Vec<ProviderInfo> {
        self.lock().available.clone().unwrap_or_else(|| {
            vec![ProviderInfo {
                id: "plugin:todoist".into(),
                name: "Todoist".into(),
                on: true,
                ready: true,
            }]
        })
    }

    fn loading(&self) -> bool {
        self.lock().loading
    }

    fn secret_matches(&self, _plugin: &str, text: &str) -> bool {
        self.lock()
            .secret
            .as_deref()
            .is_some_and(|secret| text.contains(secret))
    }

    fn fingerprint(&self, _plugin: &str) -> Option<String> {
        self.lock().fingerprint.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// As the real Todoist plugin: removing a task the provider no longer has is done already.
    #[tokio::test]
    async fn removing_a_task_already_gone_counts_as_removed() {
        let fake = FakeProvider::new();
        let answer = fake.call("todoist", "remove", json!({"id": "nope"})).await;
        assert_eq!(answer, Ok(json!({"removed": true})));
    }
}
