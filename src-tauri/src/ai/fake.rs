//! Test double for [`ClaudeRunner`]: plays back scripted outcomes and records specs.
use super::command::RunSpec;
use super::profiles::AiProfile;
use super::runner::ClaudeRunner;
use super::stream::{AiError, RunEvent, RunOutcome};
use futures_util::future::BoxFuture;
use std::collections::VecDeque;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[allow(dead_code)] // used from Task 5 tests
#[derive(Default)]
pub struct FakeRunner {
    script: Mutex<VecDeque<Result<RunOutcome, AiError>>>,
    calls: Mutex<Vec<RunSpec>>,
}

#[allow(dead_code)] // used from Task 5 tests
impl FakeRunner {
    pub fn new(script: Vec<Result<RunOutcome, AiError>>) -> Self {
        Self {
            script: Mutex::new(script.into()),
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Every spec that was run, in order.
    pub fn calls(&self) -> Vec<RunSpec> {
        self.calls.lock().unwrap().clone()
    }
}

impl ClaudeRunner for FakeRunner {
    fn run<'a>(
        &'a self,
        spec: RunSpec,
        _profile: &'a AiProfile,
        cancel: CancellationToken,
        on_event: Box<dyn Fn(RunEvent) + Send>,
    ) -> BoxFuture<'a, Result<RunOutcome, AiError>> {
        self.calls.lock().unwrap().push(spec);
        let next = self.script.lock().unwrap().pop_front();
        Box::pin(async move {
            on_event(RunEvent::Started {
                version: None,
                model: None,
            });
            if cancel.is_cancelled() {
                return Err(AiError::new(super::stream::ErrorClass::Cancelled));
            }
            next.unwrap_or_else(|| Err(AiError::new(super::stream::ErrorClass::Failed)))
        })
    }
}
