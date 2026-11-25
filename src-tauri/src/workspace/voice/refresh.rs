//! The `voice_refresh` job (reply-voice design §2, ruling 3): it asks the chosen provider's
//! `export` (30 s) and replaces Connect's copy in one transaction. It is queued when the user
//! chooses a provider, on Refresh now (`Core::voice_refresh_now`, at most once in 30 s), after a
//! voice save or delete, when the plugin manager (re)loads the chosen provider
//! (`Core::voice_reloaded`), and every 30 minutes while a provider is chosen
//! (`Core::voice_refresh_round`, window open or closed).
//!
//! A refresh that fails keeps the copy and records `needs_setup` or `unavailable`; the job itself
//! still succeeds, so a voice problem never shows as a failed job (ruling 15). A refresh whose
//! provider is no longer the chosen one — the user chose another, chose Off or deleted the copy
//! while it ran — asks nothing and writes nothing (Review Focus 3). The job's result and the log
//! carry codes and counts only, never voice text (ruling 22).
use super::{copy, ops::plugin_of, VoiceError, VoiceState};
use crate::workspace::models::{id, now, Result};
use crate::workspace::repository::Repository;
use crate::workspace::{new_job, Core};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) const JOB_KIND: &str = "voice_refresh";
/// `export`'s limit (design §1).
const EXPORT_LIMIT: Duration = Duration::from_secs(30);
/// Refresh now queues at most once in this many seconds (design §7).
const NOW_EVERY: i64 = 30;
/// The background refresh while a provider is chosen (design §2).
pub(crate) const EVERY: i64 = 30 * 60;

fn of_provider(job: &crate::workspace::models::Job, provider: &str) -> bool {
    job.kind == JOB_KIND && job.payload["provider"] == provider
}

/// Queues a `voice_refresh` of `provider` due at `due`, unless one of it is queued already (at
/// most one queued; one may run beside it, so a save made while an export runs is read again).
/// Answers whether it queued one.
pub(crate) fn queue(r: &mut Repository, provider: &str, due: i64) -> Result<bool> {
    if r.jobs()?
        .iter()
        .any(|j| of_provider(j, provider) && j.state == "queued")
    {
        return Ok(false);
    }
    let policy = r.policy(None, None)?;
    r.enqueue(&new_job(
        JOB_KIND,
        format!("{JOB_KIND}:{}", id()),
        None,
        None,
        due,
        policy,
        json!({"provider": provider}),
    ))?;
    Ok(true)
}

/// The job's executor: one `export` of `provider` (`plugin:<id>`) into the copy, at `now`.
/// Answers a code for the job's result: `ready`, `needs_setup`, `unavailable` or `skipped`.
pub(crate) async fn run(core: &Core, provider: &str, now: i64) -> Result<String> {
    if core.repo()?.settings()?.voice.provider != provider {
        return Ok("skipped".into());
    }
    let listed = core
        .voice_providers
        .get()
        .map(|p| p.available())
        .unwrap_or_default();
    let on = listed.iter().any(|p| p.id == provider && p.on);
    let answer: std::result::Result<Value, VoiceError> = match core.voice_providers.get() {
        Some(providers) if on => tokio::time::timeout(
            EXPORT_LIMIT,
            providers.call(plugin_of(provider), "export", json!({}), EXPORT_LIMIT),
        )
        .await
        .unwrap_or(Err(VoiceError::Unavailable)),
        _ => Err(VoiceError::Unavailable),
    };
    let mut r = core.repo()?;
    // Checked again under the same guard as the write: Off, another provider or Delete Connect's
    // copy while the export ran leaves the copy as the user left it.
    if r.settings()?.voice.provider != provider {
        return Ok("skipped".into());
    }
    let code = match answer {
        Ok(v) => {
            let c = copy::from_export(&v);
            copy::replace(&mut r, provider, &c, now)?;
            log::info!(
                "voice: refreshed, {} people, {} instructions, style card {}",
                c.people.len(),
                c.rules.len(),
                c.style.is_some()
            );
            VoiceState::Ready
        }
        Err(e) => {
            let state = if e == VoiceError::NeedsSetup {
                VoiceState::NeedsSetup
            } else {
                VoiceState::Unavailable
            };
            copy::set_state(&mut r, provider, state, now)?;
            log::info!("voice: refresh kept the copy: {}", state.as_str());
            state
        }
    };
    Ok(code.as_str().into())
}

impl Core {
    /// `voice_refresh {}` (read-style, no operation id, design §7): queues a refresh of the chosen
    /// provider unless one was queued in the last 30 s. Answers `{queued}`.
    pub(crate) fn voice_refresh_now(&self) -> Result<Value> {
        let now = now();
        let mut r = self.repo()?;
        let provider = r.settings()?.voice.provider;
        if provider == "off" {
            return Ok(json!({"queued": false}));
        }
        let recent = r
            .jobs()?
            .iter()
            .any(|j| of_provider(j, &provider) && j.due_at > now - NOW_EVERY);
        if recent {
            return Ok(json!({"queued": false}));
        }
        let queued = queue(&mut r, &provider, now)?;
        drop(r);
        if queued {
            self.emit("workspace:changed");
        }
        Ok(json!({"queued": queued}))
    }

    /// The background loop's part (window open or closed): every 30 minutes while a provider is
    /// chosen, a refresh; finished refresh jobs older than a day go.
    pub(crate) fn voice_refresh_round(&self, now: i64) -> Result<()> {
        let mut r = self.repo()?;
        let provider = r.settings()?.voice.provider;
        if provider == "off" {
            return Ok(());
        }
        // Queued, running, or due in the last 30 minutes whatever became of it.
        let busy = r.jobs()?.iter().any(|j| {
            of_provider(j, &provider)
                && (matches!(j.state.as_str(), "queued" | "running") || j.due_at > now - EVERY)
        });
        if !busy {
            r.prune_finished_jobs(&[JOB_KIND], now - 86_400)?;
            queue(&mut r, &provider, now)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::ops::tests::{env, Env, KNOWLEDGE};
    use super::*;
    use crate::workspace::models::Operation;

    fn queued(e: &Env) -> usize {
        e.core
            .repo()
            .unwrap()
            .jobs()
            .unwrap()
            .iter()
            .filter(|j| j.kind == JOB_KIND && j.state == "queued")
            .count()
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_copy_and_records_the_state() {
        let e = env();
        e.choose_with_copy().await;
        let before = e.copy().unwrap();
        assert_eq!(before.people.len(), 3);

        e.fake.fail(
            "export",
            "needs_setup: Choose your knowledge folder in Knowledge.",
        );
        assert_eq!(run(&e.core, KNOWLEDGE, 2_000).await.unwrap(), "needs_setup");
        let after = e.copy().unwrap();
        assert_eq!(after.state, VoiceState::NeedsSetup);
        assert_eq!(after.people, before.people, "the copy is kept");
        assert_eq!(after.refreshed_at, before.refreshed_at);
        assert_eq!(e.snapshot()["state"], "needs_setup");

        e.fake.fail("export", "boom");
        assert_eq!(run(&e.core, KNOWLEDGE, 3_000).await.unwrap(), "unavailable");
        let after = e.copy().unwrap();
        assert_eq!(after.state, VoiceState::Unavailable);
        assert_eq!(after.people, before.people);
        assert_eq!(e.snapshot()["state"], "unavailable");

        // No answer within 30 s reads as unavailable too.
        e.fake.delay("export", Duration::from_secs(31));
        e.fake
            .answer("export", super::super::ops::tests::export_answer(""));
        tokio::time::pause();
        assert_eq!(run(&e.core, KNOWLEDGE, 4_000).await.unwrap(), "unavailable");
    }

    /// A first refresh that fails, before any export succeeded, records `needs_setup` (Task 1b).
    #[tokio::test]
    async fn a_first_failed_refresh_records_needs_setup() {
        let e = env();
        e.fake.fail("export", "needs_setup: no folder");
        e.op(Operation::VoiceSet, json!({"provider": KNOWLEDGE}))
            .await
            .unwrap();
        e.run_jobs().await;
        assert_eq!(e.snapshot()["state"], "needs_setup");
    }

    #[tokio::test]
    async fn refresh_now_queues_at_most_once_in_30s() {
        let e = env();
        assert_eq!(
            e.core.voice_refresh_now().unwrap(),
            json!({"queued": false}),
            "Off refreshes nothing"
        );
        e.choose_with_copy().await;
        assert_eq!(queued(&e), 0);
        // The choice's own refresh ran a moment ago.
        assert_eq!(
            e.core.voice_refresh_now().unwrap(),
            json!({"queued": false})
        );
        // 30 s later, one; a second press queues no other.
        {
            let mut r = e.core.repo().unwrap();
            for mut j in r.jobs().unwrap() {
                j.due_at -= NOW_EVERY;
                r.save_job(&j).unwrap();
            }
        }
        assert_eq!(e.core.voice_refresh_now().unwrap(), json!({"queued": true}));
        assert_eq!(
            e.core.voice_refresh_now().unwrap(),
            json!({"queued": false})
        );
        assert_eq!(queued(&e), 1);
        // Through `workspace_request`: read-style, no operation id needed.
        let answer = e
            .core
            .request(crate::workspace::models::Request {
                op: Operation::VoiceRefresh,
                workspace_id: None,
                expected_revision: None,
                operation_id: None,
                data: json!({}),
            })
            .await
            .unwrap();
        assert_eq!(answer, json!({"queued": false}));
    }

    #[tokio::test]
    async fn the_schedule_refreshes_every_30_minutes_only_while_chosen() {
        let e = env();
        let t = now();
        e.core.voice_refresh_round(t).unwrap();
        assert_eq!(queued(&e), 0, "Off: no schedule");
        e.choose_with_copy().await;
        e.core.voice_refresh_round(t + 60).unwrap();
        assert_eq!(queued(&e), 0, "refreshed a minute ago");
        e.core.voice_refresh_round(t + EVERY + 1).unwrap();
        assert_eq!(queued(&e), 1);
        e.core.voice_refresh_round(t + EVERY + 2).unwrap();
        assert_eq!(queued(&e), 1, "at most one queued");
    }

    /// The plugin manager (re)loaded the chosen provider (including its first load at startup):
    /// a refresh is queued.
    #[tokio::test]
    async fn a_reload_of_the_chosen_provider_queues_a_refresh() {
        use std::sync::atomic::Ordering;
        let e = env();
        e.core.voice_reloaded();
        assert_eq!(queued(&e), 0, "Off: nothing to refresh");
        e.choose_with_copy().await;
        let reloads = e.core.voice_reloads.load(Ordering::SeqCst);
        e.core.voice_reloaded();
        assert_eq!(e.core.voice_reloads.load(Ordering::SeqCst), reloads + 1);
        assert_eq!(queued(&e), 1);
        e.fake
            .answer("export", super::super::ops::tests::export_answer(""));
        e.run_jobs().await;
        let exports = e
            .fake
            .calls()
            .iter()
            .filter(|(p, op, _)| p == "knowledge" && op == "export")
            .count();
        assert_eq!(exports, 2, "the choice's refresh and the reload's");
    }

    /// A refresh that runs after the user chose another provider or deleted the copy writes
    /// nothing, even when its export was already under way.
    #[tokio::test]
    async fn a_refresh_overtaken_by_forget_writes_nothing() {
        let e = env();
        e.choose_with_copy().await;
        e.fake.delay("export", Duration::from_millis(200));
        e.fake
            .answer("export", super::super::ops::tests::export_answer(""));
        let core = e.core.clone();
        let running = tokio::spawn(async move { run(&core, KNOWLEDGE, 9_000).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        e.op(Operation::VoiceForget, json!({})).await.unwrap();
        assert_eq!(running.await.unwrap().unwrap(), "skipped");
        assert!(e.copy().is_none());
    }
}
