//! The process runner every AI feature uses (DESIGN 6.2): one headless, tool-free
//! `claude` per call, in its own process group and a throw-away working directory.
use super::command::RunSpec;
use super::profiles::{AiProfile, DetectEnv, ProfileKind};
use super::stream::{AiError, ErrorClass, RunEvent, RunOutcome};
use futures_util::future::BoxFuture;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const MAX_PARALLEL: usize = 2;

/// Runs one Claude call. Object safe: Task 5 holds it as `Arc<dyn ClaudeRunner>`.
pub trait ClaudeRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        spec: RunSpec,
        profile: &'a AiProfile,
        cancel: CancellationToken,
        on_event: Box<dyn Fn(RunEvent) + Send>,
    ) -> BoxFuture<'a, Result<RunOutcome, AiError>>;
}

type Resolver = Arc<dyn Fn(&ProfileKind) -> Option<PathBuf> + Send + Sync>;

pub struct CliRunner {
    #[cfg_attr(not(unix), allow(dead_code))]
    permits: Arc<Semaphore>,
    #[cfg_attr(not(unix), allow(dead_code))]
    resolve: Resolver,
}

impl CliRunner {
    /// Finds `claude` / `codemie-claude` the same way detection does.
    pub fn new(env: DetectEnv) -> Self {
        Self::with_resolver(Arc::new(move |kind| match kind {
            ProfileKind::Native => {
                super::discover::find_program_in("claude", &env.path_var, &env.home, &[])
            }
            ProfileKind::CodeMie { .. } => super::discover::find_program_in(
                "codemie-claude",
                &env.path_var,
                &env.home,
                &env.extra_dirs,
            ),
        }))
    }

    pub fn with_resolver(resolve: Resolver) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(MAX_PARALLEL)),
            resolve,
        }
    }
}

impl ClaudeRunner for CliRunner {
    fn run<'a>(
        &'a self,
        spec: RunSpec,
        profile: &'a AiProfile,
        cancel: CancellationToken,
        on_event: Box<dyn Fn(RunEvent) + Send>,
    ) -> BoxFuture<'a, Result<RunOutcome, AiError>> {
        #[cfg(unix)]
        {
            Box::pin(unix_run::run_one(self, spec, profile, cancel, on_event))
        }
        #[cfg(not(unix))]
        {
            let _ = (spec, profile, cancel, on_event);
            Box::pin(async {
                Err(AiError {
                    class: ErrorClass::Failed,
                    message: "Claude runs are not supported on Windows yet.".to_string(),
                })
            })
        }
    }
}

#[cfg(unix)]
mod unix_run {
    use super::*;
    use crate::ai::command::build_command;
    use crate::ai::stream::StreamParser;
    use std::os::unix::fs::DirBuilderExt;
    use std::path::Path;
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const STDOUT_CAP: usize = 1024 * 1024;
    const STDERR_CAP: usize = 16 * 1024;
    const KILL_GRACE: Duration = Duration::from_secs(3);
    const PROGRESS_EVERY: Duration = Duration::from_secs(1);

    /// Removes the staging directory when dropped, on every path.
    struct Staging(PathBuf);

    impl Drop for Staging {
        fn drop(&mut self) {
            if let Err(e) = std::fs::remove_dir_all(&self.0) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("ai: cannot remove staging dir: {e}");
                }
            }
        }
    }

    fn create_staging(root: &Path) -> std::io::Result<Staging> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)?;
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        Ok(Staging(dir))
    }

    /// Owns the child's process group. Dropping an armed guard (a dropped run future)
    /// sends TERM now and KILL after the grace period.
    struct GroupGuard {
        pgid: i32,
        armed: bool,
    }

    impl GroupGuard {
        fn signal(&self, sig: i32) {
            // SAFETY: killpg takes plain integers; a stale group only yields ESRCH.
            unsafe {
                libc::killpg(self.pgid, sig);
            }
        }

        fn group_alive(&self) -> bool {
            // SAFETY: signal 0 only checks that the group exists.
            unsafe { libc::killpg(self.pgid, 0) == 0 }
        }
    }

    impl Drop for GroupGuard {
        fn drop(&mut self) {
            if !self.armed {
                return;
            }
            self.signal(libc::SIGTERM);
            let pgid = self.pgid;
            std::thread::spawn(move || {
                std::thread::sleep(KILL_GRACE);
                // SAFETY: as above.
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            });
        }
    }

    /// TERM the group and give every member (wrapper children included) the grace
    /// period to leave, then KILL what remains.
    async fn terminate(child: &mut tokio::process::Child, guard: &mut GroupGuard) {
        guard.signal(libc::SIGTERM);
        let all_gone = tokio::time::timeout(KILL_GRACE, async {
            let _ = child.wait().await;
            while guard.group_alive() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok();
        if !all_gone {
            guard.signal(libc::SIGKILL);
            let _ = child.wait().await;
        }
        guard.armed = false;
    }

    fn lines_from(buf: &mut Vec<u8>, parser: &mut StreamParser, on_event: &dyn Fn(RunEvent)) {
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if let Some(ev) = parser.feed(&String::from_utf8_lossy(&line)) {
                on_event(ev);
            }
        }
    }

    pub(super) async fn run_one(
        runner: &CliRunner,
        spec: RunSpec,
        profile: &AiProfile,
        cancel: CancellationToken,
        on_event: Box<dyn Fn(RunEvent) + Send>,
    ) -> Result<RunOutcome, AiError> {
        let err = |c| Err(AiError::new(c));
        let Some(bin) = (runner.resolve)(&profile.kind) else {
            return err(ErrorClass::NotInstalled);
        };
        let _permit = tokio::select! {
            p = runner.permits.clone().acquire_owned() => p.map_err(|_| AiError::new(ErrorClass::Failed))?,
            _ = cancel.cancelled() => return err(ErrorClass::Cancelled),
        };
        let started = tokio::time::Instant::now();
        let sleep = tokio::time::sleep_until(started + spec.timeout);
        tokio::pin!(sleep);

        let staging = create_staging(&spec.staging_root).map_err(|e| {
            log::warn!("ai: cannot create staging dir: {e}");
            AiError::new(ErrorClass::Failed)
        })?;
        let plan = build_command(&spec, profile, &bin, &staging.0);
        let mut cmd = tokio::process::Command::new(&plan.program);
        cmd.args(&plan.args).current_dir(&plan.cwd);
        for k in &plan.env_remove {
            cmd.env_remove(k);
        }
        cmd.envs(plan.env_set.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = cmd.spawn().map_err(|e| {
            log::warn!("ai: cannot start {}: {e}", plan.program.display());
            AiError::new(ErrorClass::Failed)
        })?;
        let mut guard = GroupGuard {
            pgid: child.id().unwrap_or(0) as i32,
            armed: true,
        };
        if guard.pgid <= 0 {
            return err(ErrorClass::Failed);
        }

        // Input is written by its own task, so a child that does not read stdin can
        // never stall cancel or timeout. Stdin closes when the task ends.
        let mut stdin = child.stdin.take().expect("piped");
        let input = spec.input.to_string();
        let stdin_task = tokio::spawn(async move {
            if let Err(e) = stdin.write_all(input.as_bytes()).await {
                log::warn!("ai: cannot write run input: {e}");
            } else if let Err(e) = stdin.shutdown().await {
                log::warn!("ai: cannot close run input: {e}");
            }
        });
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let stderr_task = tokio::spawn(async move {
            let mut kept = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                // Keep draining past the cap so the child never blocks on a full pipe.
                if kept.len() < STDERR_CAP {
                    kept.extend_from_slice(&chunk[..n.min(STDERR_CAP - kept.len())]);
                }
            }
            String::from_utf8_lossy(&kept).into_owned()
        });

        let mut parser = StreamParser::new();
        let mut buf: Vec<u8> = Vec::new();
        let mut total = 0usize;
        let mut chunk = vec![0u8; 8192];
        let mut tick = tokio::time::interval(PROGRESS_EVERY);
        tick.tick().await;

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    terminate(&mut child, &mut guard).await;
                    return err(ErrorClass::Cancelled);
                }
                _ = &mut sleep => {
                    terminate(&mut child, &mut guard).await;
                    return err(ErrorClass::Timeout);
                }
                _ = tick.tick() => {
                    on_event(RunEvent::Progress { elapsed_ms: started.elapsed().as_millis() as u64 });
                }
                n = stdout.read(&mut chunk) => match n {
                    Ok(0) => break,
                    Err(e) => {
                        log::warn!("ai: cannot read run output: {e}");
                        break;
                    }
                    Ok(n) => {
                        total += n;
                        if total > STDOUT_CAP {
                            terminate(&mut child, &mut guard).await;
                            return err(ErrorClass::InvalidOutput);
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        lines_from(&mut buf, &mut parser, &*on_event);
                    }
                },
            }
        }
        if !buf.is_empty() {
            buf.push(b'\n');
            lines_from(&mut buf, &mut parser, &*on_event);
        }
        tokio::select! {
            _ = child.wait() => {}
            _ = cancel.cancelled() => {
                terminate(&mut child, &mut guard).await;
                return err(ErrorClass::Cancelled);
            }
            _ = &mut sleep => {
                terminate(&mut child, &mut guard).await;
                return err(ErrorClass::Timeout);
            }
        }
        guard.armed = false;
        stdin_task.abort();
        let stderr_text = tokio::time::timeout(Duration::from_secs(1), stderr_task)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
        let outcome = parser.finish(&stderr_text)?;
        if spec.schema.is_some() {
            outcome.require_structured_object()
        } else {
            Ok(outcome)
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::ai::profiles::{ProfileState, NATIVE_ID};
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::Duration;

    pub(super) fn native() -> AiProfile {
        AiProfile {
            id: NATIVE_ID.into(),
            kind: ProfileKind::Native,
            label: "x".into(),
            state: ProfileState::Ready,
            version: None,
            account: None,
            models: vec![],
            default_model: None,
            message: None,
        }
    }

    fn spec(root: &Path, timeout: Duration, schema: bool) -> RunSpec {
        RunSpec {
            purpose: "t".into(),
            profile_id: NATIVE_ID.into(),
            model: None,
            system: "s".into(),
            input: json!({"q": 1}),
            schema: schema.then(|| json!({"type": "object"})),
            timeout,
            cap_usd: None,
            staging_root: root.to_path_buf(),
        }
    }

    /// A shell script standing in for `claude`.
    fn script_runner(dir: &Path, body: &str) -> CliRunner {
        let path = dir.join("fake-claude");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        CliRunner::with_resolver(Arc::new(move |_| Some(path.clone())))
    }

    fn noop() -> Box<dyn Fn(RunEvent) + Send> {
        Box::new(|_| {})
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Waits until the script has recorded `<shell pid> <background pid>`.
    async fn wait_pids(file: &Path) -> Vec<i32> {
        loop {
            if let Ok(t) = std::fs::read_to_string(file) {
                let ids: Vec<i32> = t
                    .split_whitespace()
                    .filter_map(|p| p.parse().ok())
                    .collect();
                if ids.len() == 2 {
                    return ids;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn assert_gone_and_clean(pids: &Path, stage: &Path) {
        let ids = wait_pids(pids).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        for id in ids {
            assert!(!alive(id), "pid {id} still alive");
        }
        assert_eq!(std::fs::read_dir(stage).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn run_success_reads_structured_output_and_cleans_staging() {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("stage");
        let r = script_runner(
            dir.path(),
            r#"cat >/dev/null
echo '{"type":"system","subtype":"init","model":"m","claude_code_version":"1"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"hi","structured_output":{"draft":"d"}}'"#,
        );
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let ev = events.clone();
        let out = r
            .run(
                spec(&stage, Duration::from_secs(10), true),
                &native(),
                CancellationToken::new(),
                Box::new(move |e| ev.lock().unwrap().push(e)),
            )
            .await
            .unwrap();
        assert_eq!(out.structured, Some(json!({"draft": "d"})));
        assert!(matches!(
            events.lock().unwrap()[0],
            RunEvent::Started { .. }
        ));
        assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn run_missing_structured_output_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let r = script_runner(
            dir.path(),
            r#"echo '{"type":"result","subtype":"success","is_error":false,"result":"prose"}'"#,
        );
        let e = r
            .run(
                spec(&dir.path().join("s"), Duration::from_secs(10), true),
                &native(),
                CancellationToken::new(),
                noop(),
            )
            .await
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::InvalidOutput);
    }

    #[tokio::test]
    async fn run_classifies_login_failure_from_stdout() {
        let dir = tempfile::tempdir().unwrap();
        let r = script_runner(dir.path(), "echo 'Authentication required'; exit 1");
        let e = r
            .run(
                spec(&dir.path().join("s"), Duration::from_secs(10), false),
                &native(),
                CancellationToken::new(),
                noop(),
            )
            .await
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::NeedsLogin);
    }

    #[tokio::test]
    async fn run_cancel_kills_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let r = script_runner(
            dir.path(),
            &format!("sleep 30 &\necho $$ $! > '{}'\nwait", pids.display()),
        );
        let stage = dir.path().join("s");
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        let waited = pids.clone();
        tokio::spawn(async move {
            // Cancel 200 ms after the script has started and recorded its pids.
            while !std::fs::read_to_string(&waited).is_ok_and(|t| t.contains(' ')) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            c2.cancel();
        });
        let t = std::time::Instant::now();
        let e = r
            .run(
                spec(&stage, Duration::from_secs(60), false),
                &native(),
                cancel,
                noop(),
            )
            .await
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::Cancelled);
        assert!(t.elapsed() < Duration::from_secs(4), "{:?}", t.elapsed());
        assert_gone_and_clean(&pids, &stage).await;
    }

    #[tokio::test]
    async fn run_timeout_with_unread_stdin_returns_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        // Never reads stdin, so a 256 KB input fills the pipe.
        let r = script_runner(
            dir.path(),
            &format!("sleep 30 &\necho $$ $! > '{}'\nwait", pids.display()),
        );
        let stage = dir.path().join("s");
        let mut sp = spec(&stage, Duration::from_millis(800), false);
        sp.input = json!({"big": "x".repeat(256 * 1024)});
        let t = std::time::Instant::now();
        let e = r
            .run(sp, &native(), CancellationToken::new(), noop())
            .await
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::Timeout);
        assert!(t.elapsed() < Duration::from_secs(4), "{:?}", t.elapsed());
        assert_gone_and_clean(&pids, &stage).await;
    }

    #[tokio::test]
    async fn run_output_cap_discards_oversize() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let r = script_runner(
            dir.path(),
            &format!(
                "sleep 30 &\necho $$ $! > '{}'\nhead -c 2000000 /dev/zero | tr '\\0' 'a'\nwait",
                pids.display()
            ),
        );
        let stage = dir.path().join("s");
        let t = std::time::Instant::now();
        let e = r
            .run(
                spec(&stage, Duration::from_secs(20), false),
                &native(),
                CancellationToken::new(),
                noop(),
            )
            .await
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::InvalidOutput);
        assert!(t.elapsed() < Duration::from_secs(8));
        assert_gone_and_clean(&pids, &stage).await;
    }

    #[tokio::test]
    async fn run_dropped_future_kills_group() {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let r = script_runner(
            dir.path(),
            &format!("sleep 30 &\necho $$ $! > '{}'\nwait", pids.display()),
        );
        let stage = dir.path().join("s");
        let sp = spec(&stage, Duration::from_secs(60), false);
        let p = native();
        let mut fut = r.run(sp, &p, CancellationToken::new(), noop());
        let ids = tokio::select! {
            _ = &mut fut => panic!("run ended early"),
            ids = wait_pids(&pids) => ids,
        };
        assert_eq!(ids.len(), 2);
        drop(fut);
        tokio::time::sleep(Duration::from_millis(400)).await;
        for id in ids {
            assert!(!alive(id), "pid {id} still alive");
        }
        assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn run_without_binary_is_not_installed() {
        let r = CliRunner::with_resolver(Arc::new(|_| None));
        let e = r
            .run(
                spec(Path::new("/nonexistent"), Duration::from_secs(1), false),
                &native(),
                CancellationToken::new(),
                noop(),
            )
            .await
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::NotInstalled);
    }
}

/// Real one-word prompts; run by hand with `--ignored` (needs sign-in).
#[cfg(all(test, unix))]
mod live {
    use super::tests::native;
    use super::*;
    use crate::ai::profiles::DetectEnv;
    use serde_json::json;
    use std::time::Duration;

    fn live_spec(profile_id: &str, model: Option<&str>) -> RunSpec {
        RunSpec {
            purpose: "live".into(),
            profile_id: profile_id.into(),
            model: model.map(str::to_string),
            system: "Put a one-word greeting in the draft field.".into(),
            input: json!({"task": "greet"}),
            schema: Some(json!({
                "type": "object",
                "properties": {"draft": {"type": "string"}},
                "required": ["draft"]
            })),
            timeout: Duration::from_secs(120),
            cap_usd: None,
            staging_root: std::env::temp_dir().join("codemie-ai-live"),
        }
    }

    async fn go(profile: AiProfile, model: Option<&str>) {
        let runner = CliRunner::new(DetectEnv::system(vec![]));
        let saw = Arc::new(std::sync::Mutex::new(Vec::new()));
        let s2 = saw.clone();
        let t = std::time::Instant::now();
        let out = runner
            .run(
                live_spec(&profile.id, model),
                &profile,
                CancellationToken::new(),
                Box::new(move |e| s2.lock().unwrap().push(format!("{e:?}"))),
            )
            .await
            .unwrap_or_else(|e| panic!("live run failed: {:?}", e.class));
        println!(
            "duration={:?} structured_output_present={} model={:?} events={}",
            t.elapsed(),
            out.structured.is_some(),
            out.model,
            saw.lock().unwrap().len()
        );
        let draft = out
            .structured
            .as_ref()
            .and_then(|s| s.get("draft"))
            .and_then(|d| d.as_str())
            .unwrap_or("");
        // `structured` is read only from the result's `structured_output` (no text
        // fallback), so reaching here proves stream-json carried it.
        assert!(!draft.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn live_native_isolated_run() {
        go(native(), Some("haiku")).await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_codemie_isolated_run() {
        let mut p = native();
        p.id = "codemie:prod".into();
        p.kind = ProfileKind::CodeMie {
            name: "prod".into(),
        };
        go(p, None).await;
    }
}
