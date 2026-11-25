//! `FakeVoice`: a scripted reply-context provider for tests (design "Tests use `fake::FakeVoice`",
//! the `task_provider::fake::FakeProvider` pattern). It records every call and can be told what
//! to answer, fail with, or how long to take.
use super::{VoiceError, VoiceInfo, VoiceProviders};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
struct Inner {
    scripted: HashMap<String, VecDeque<Result<Value, VoiceError>>>,
    calls: Vec<(String, String, Value)>,
    available: Option<Vec<VoiceInfo>>,
    loading: bool,
    delay: HashMap<String, Duration>,
}

pub struct FakeVoice {
    inner: Mutex<Inner>,
}

impl Default for FakeVoice {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeVoice {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// What `available` answers from now on (default: none listed).
    pub fn set_available(&self, available: Vec<VoiceInfo>) {
        self.lock().available = Some(available);
    }

    /// What `loading` answers from now on (default false: the manager has settled, I1).
    pub fn set_loading(&self, loading: bool) {
        self.lock().loading = loading;
    }

    /// The next call of `op` answers `value` instead of `Unavailable`.
    pub fn answer(&self, op: &str, value: Value) {
        self.lock()
            .scripted
            .entry(op.into())
            .or_default()
            .push_back(Ok(value));
    }

    /// The next call of `op` fails, as a provider's thrown message would parse
    /// (`VoiceError::parse`).
    pub fn fail(&self, op: &str, message: &str) {
        self.lock()
            .scripted
            .entry(op.into())
            .or_default()
            .push_back(Err(VoiceError::parse(message)));
    }

    /// Every call of `op` from now on takes `delay` before it answers.
    pub fn delay(&self, op: &str, delay: Duration) {
        self.lock().delay.insert(op.into(), delay);
    }

    /// Every call so far: `(plugin, op, args)`.
    pub fn calls(&self) -> Vec<(String, String, Value)> {
        self.lock().calls.clone()
    }
}

impl VoiceProviders for FakeVoice {
    fn call(
        &self,
        plugin: &str,
        op: &str,
        args: Value,
        _limit: Duration,
    ) -> BoxFuture<'static, Result<Value, VoiceError>> {
        let mut s = self.lock();
        s.calls.push((plugin.into(), op.into(), args));
        let answer = s
            .scripted
            .get_mut(op)
            .and_then(VecDeque::pop_front)
            .unwrap_or(Err(VoiceError::Unavailable));
        let delay = s.delay.get(op).copied();
        drop(s);
        Box::pin(async move {
            if let Some(d) = delay {
                tokio::time::sleep(d).await;
            }
            answer
        })
    }

    fn available(&self) -> Vec<VoiceInfo> {
        self.lock().available.clone().unwrap_or_default()
    }

    fn loading(&self) -> bool {
        self.lock().loading
    }
}
