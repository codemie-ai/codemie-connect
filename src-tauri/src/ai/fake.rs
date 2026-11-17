//! Test double for [`ClaudeRunner`]: plays back scripted outcomes and records specs.
use super::command::RunSpec;
use super::profiles::AiProfile;
use super::runner::ClaudeRunner;
use super::stream::{AiError, ErrorClass, RunEvent, RunOutcome};
use futures_util::future::BoxFuture;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Holds a run open: `started` is notified when a run begins, and the run returns only after
/// `release` is notified (or it is cancelled).
#[derive(Clone, Default)]
pub struct Gate {
    pub started: Arc<Notify>,
    pub release: Arc<Notify>,
}

#[derive(Default)]
pub struct FakeRunner {
    script: Mutex<VecDeque<Result<RunOutcome, AiError>>>,
    calls: Mutex<Vec<RunSpec>>,
    gate: Option<Gate>,
}

impl FakeRunner {
    pub fn new(script: Vec<Result<RunOutcome, AiError>>) -> Self {
        Self {
            script: Mutex::new(script.into()),
            calls: Mutex::new(Vec::new()),
            gate: None,
        }
    }

    /// A runner whose runs wait at the returned [`Gate`].
    pub fn gated(script: Vec<Result<RunOutcome, AiError>>) -> (Self, Gate) {
        let gate = Gate::default();
        let runner = Self {
            gate: Some(gate.clone()),
            ..Self::new(script)
        };
        (runner, gate)
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
        let gate = self.gate.clone();
        Box::pin(async move {
            on_event(RunEvent::Started {
                version: None,
                model: None,
            });
            if let Some(gate) = gate {
                gate.started.notify_one();
                tokio::select! {
                    _ = gate.release.notified() => {}
                    _ = cancel.cancelled() => {}
                }
            }
            if cancel.is_cancelled() {
                return Err(AiError::new(ErrorClass::Cancelled));
            }
            next.unwrap_or_else(|| Err(AiError::new(ErrorClass::Failed)))
        })
    }
}
