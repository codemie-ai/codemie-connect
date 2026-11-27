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
    /// Finds `claude` / `codemie-claude` the same way detection does; of several CodeMie
    /// copies, the newest runs.
    pub fn new(env: DetectEnv) -> Self {
        Self::with_resolver(Arc::new(move |kind| match kind {
            ProfileKind::Native => super::discover::find_program_in(
                "claude",
                &env.path_var,
                &env.home,
                &env.system_dirs,
                &[],
            ),
            ProfileKind::CodeMie { .. } => super::discover::find_codemie_program_in(
                "codemie-claude",
                &env.path_var,
                &env.home,
                &env.system_dirs,
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
                    message: "Claude runs are not supported on Windows yet.".to_string(),
                    ..AiError::new(ErrorClass::Failed)
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

    /// Creates only the staging folder itself, never its parents: the data folder it lives in
    /// may be a drive that went away, and must not be recreated empty (DESIGN 8).
    fn create_staging(root: &Path) -> std::io::Result<Staging> {
        match std::fs::DirBuilder::new().mode(0o700).create(root) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
            _ => {}
        }
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        Ok(Staging(dir))
    }

    /// Aborts its task when dropped, so a helper task never outlives the run, on any
    /// exit path or when the run future itself is dropped.
    pub(super) struct AbortOnDrop<T>(pub(super) tokio::task::JoinHandle<T>);

    impl<T> Drop for AbortOnDrop<T> {
        fn drop(&mut self) {
            self.0.abort();
        }
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
            // No pid: the guard must never signal group 0 (our own group).
            guard.armed = false;
            return err(ErrorClass::Failed);
        }

        // Input is written by its own task, so a child that does not read stdin can
        // never stall cancel or timeout. Stdin closes when the task ends.
        let mut stdin = child.stdin.take().expect("piped");
        let input = spec.input.to_string();
        let _stdin_task = AbortOnDrop(tokio::spawn(async move {
            if let Err(e) = stdin.write_all(input.as_bytes()).await {
                log::warn!("ai: cannot write run input: {e}");
            } else if let Err(e) = stdin.shutdown().await {
                log::warn!("ai: cannot close run input: {e}");
            }
        }));
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let mut stderr_task = AbortOnDrop(tokio::spawn(async move {
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
        }));

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
        let stderr_text = tokio::time::timeout(Duration::from_secs(1), &mut stderr_task.0)
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
            provider: None,
            label: "x".into(),
            state: ProfileState::Ready,
            version: None,
            account: None,
            models: vec![],
            default_model: None,
            message: None,
            local: None,
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
            folder: None,
        }
    }

    #[test]
    fn a_codemie_run_starts_the_newest_codemie_claude() {
        // An `npm link` to a 0.17.1 checkout comes first on the PATH; the server refuses it, and
        // the 0.17.2 in ~/.codemie/agents is what runs. The lookup is tested in discover.rs.
        use crate::ai::discover::tests::codemie_package;
        let home = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let npm_bin = tempfile::tempdir().unwrap();
        codemie_package(checkout.path(), "0.17.1", npm_bin.path(), "codemie-claude");
        let agents = home.path().join(".codemie/agents");
        codemie_package(
            &agents.join("lib/node_modules/@codemieai/code"),
            "0.17.2",
            &agents.join("bin"),
            "codemie-claude",
        );
        let runner = CliRunner::new(DetectEnv {
            path_var: npm_bin.path().to_str().unwrap().into(),
            home: home.path().into(),
            system_dirs: vec![],
            extra_dirs: vec![],
            config_path: home.path().join("codemie-cli.config.json"),
        });
        let kind = ProfileKind::CodeMie {
            name: "prod".into(),
        };
        assert_eq!(
            (runner.resolve)(&kind),
            Some(agents.join("bin/codemie-claude"))
        );
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

    /// The tests that start a stand-in `claude` take this first, so they run one at a time: under
    /// a full parallel `cargo test` they starved each other of process start-ups (a script that
    /// hadn't written its pids before its run's timeout, a group not yet reaped when checked).
    static ONE_PROCESS_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn one_at_a_time() -> tokio::sync::MutexGuard<'static, ()> {
        ONE_PROCESS_TEST.lock().await
    }

    /// How long a loaded machine may take to start a process and record its pids. The tests'
    /// bounds stay far below the scripts' 300 s `sleep` and the 60 s run timeouts.
    const SLOW_MACHINE: Duration = Duration::from_secs(30);

    /// How long a killed group may take to be reaped. Far below the scripts' 300 s `sleep`, so
    /// a group the runner failed to kill fails the test rather than ending by itself.
    const REAP: Duration = Duration::from_secs(10);

    /// The stand-in script: a background `sleep` it records with its own pid, then waits.
    fn sleeper(pids: &Path) -> String {
        format!("sleep 300 &\necho $$ $! > '{}'\nwait", pids.display())
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only checks existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// The `<shell pid> <background pid>` a script recorded in `file`, if it has.
    fn recorded(file: &Path) -> Vec<i32> {
        std::fs::read_to_string(file)
            .map(|t| {
                t.split_whitespace()
                    .filter_map(|p| p.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Kills whatever the script recorded in its pids file that is still alive when dropped, so
    /// a test that fails anywhere leaves no 300 s `sleep` behind.
    struct KillLeftovers<'a>(&'a Path);

    impl Drop for KillLeftovers<'_> {
        fn drop(&mut self) {
            for id in recorded(self.0).into_iter().filter(|id| alive(*id)) {
                // SAFETY: a plain signal to a pid this test's script started.
                unsafe {
                    libc::kill(id, libc::SIGKILL);
                }
            }
        }
    }

    /// Waits until each pid is gone; fails the test after `REAP`.
    async fn wait_gone(ids: &[i32]) {
        let deadline = std::time::Instant::now() + REAP;
        while let Some(id) = ids.iter().find(|id| alive(**id)) {
            assert!(
                std::time::Instant::now() < deadline,
                "pid {id} still alive after {REAP:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Waits until the script has recorded `<shell pid> <background pid>`; fails the test after
    /// `SLOW_MACHINE` (a loaded machine is slow, not endless).
    async fn wait_pids(file: &Path) -> Vec<i32> {
        let deadline = std::time::Instant::now() + SLOW_MACHINE;
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "the script never recorded its pids in {} within {SLOW_MACHINE:?}",
                file.display()
            );
            let ids = recorded(file);
            if ids.len() == 2 {
                return ids;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn assert_gone_and_clean(pids: &Path, stage: &Path) {
        let ids = wait_pids(pids).await;
        wait_gone(&ids).await;
        assert_eq!(std::fs::read_dir(stage).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn run_never_creates_the_staging_parent() {
        let _serial = one_at_a_time().await;
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone");
        let r = script_runner(dir.path(), "cat >/dev/null");
        let err = r
            .run(
                spec(&gone.join("ai-staging"), SLOW_MACHINE, false),
                &native(),
                CancellationToken::new(),
                noop(),
            )
            .await
            .unwrap_err();
        assert_eq!(err.class, ErrorClass::Failed);
        assert!(!gone.exists(), "a vanished data folder is never recreated");
    }

    #[tokio::test]
    async fn run_success_reads_structured_output_and_cleans_staging() {
        let _serial = one_at_a_time().await;
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
                spec(&stage, SLOW_MACHINE, true),
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
        let _serial = one_at_a_time().await;
        let dir = tempfile::tempdir().unwrap();
        let r = script_runner(
            dir.path(),
            r#"echo '{"type":"result","subtype":"success","is_error":false,"result":"prose"}'"#,
        );
        let e = r
            .run(
                spec(&dir.path().join("s"), SLOW_MACHINE, true),
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
        let _serial = one_at_a_time().await;
        let dir = tempfile::tempdir().unwrap();
        let r = script_runner(dir.path(), "echo 'Authentication required'; exit 1");
        let e = r
            .run(
                spec(&dir.path().join("s"), SLOW_MACHINE, false),
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
        let _serial = one_at_a_time().await;
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let _leftovers = KillLeftovers(&pids);
        let r = script_runner(dir.path(), &sleeper(&pids));
        let stage = dir.path().join("s");
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        let waited = pids.clone();
        let cancelled_at = Arc::new(std::sync::Mutex::new(None));
        let at = cancelled_at.clone();
        tokio::spawn(async move {
            // Cancel 200 ms after the script has started and recorded its pids.
            while !std::fs::read_to_string(&waited).is_ok_and(|t| t.contains(' ')) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            *at.lock().unwrap() = Some(std::time::Instant::now());
            c2.cancel();
        });
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
        // Well under the script's 300 s sleep: the cancel stopped it, its own end didn't.
        let since = cancelled_at.lock().unwrap().expect("cancelled").elapsed();
        assert!(since < Duration::from_secs(10), "{since:?}");
        assert_gone_and_clean(&pids, &stage).await;
    }

    #[tokio::test]
    async fn run_timeout_with_unread_stdin_returns_timeout() {
        let _serial = one_at_a_time().await;
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let _leftovers = KillLeftovers(&pids);
        // Never reads stdin, so a 256 KB input fills the pipe.
        let r = script_runner(dir.path(), &sleeper(&pids));
        let stage = dir.path().join("s");
        // Long enough for a loaded machine to start the script and record its pids first.
        let timeout = Duration::from_secs(3);
        let mut sp = spec(&stage, timeout, false);
        sp.input = json!({"big": "x".repeat(256 * 1024)});
        let t = std::time::Instant::now();
        let e = r
            .run(sp, &native(), CancellationToken::new(), noop())
            .await
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::Timeout);
        // Well under the script's 300 s sleep: the timeout ended it.
        assert!(
            t.elapsed() < timeout + Duration::from_secs(10),
            "{:?}",
            t.elapsed()
        );
        assert_gone_and_clean(&pids, &stage).await;
    }

    #[tokio::test]
    async fn run_output_cap_discards_oversize() {
        let _serial = one_at_a_time().await;
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let _leftovers = KillLeftovers(&pids);
        let r = script_runner(
            dir.path(),
            &format!(
                "sleep 300 &\necho $$ $! > '{}'\nhead -c 2000000 /dev/zero | tr '\\0' 'a'\nwait",
                pids.display()
            ),
        );
        let stage = dir.path().join("s");
        let t = std::time::Instant::now();
        let e = r
            .run(
                spec(&stage, Duration::from_secs(60), false),
                &native(),
                CancellationToken::new(),
                noop(),
            )
            .await
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::InvalidOutput);
        // Well under the script's 300 s sleep and the 60 s timeout: the cap ended it.
        assert!(t.elapsed() < Duration::from_secs(15), "{:?}", t.elapsed());
        assert_gone_and_clean(&pids, &stage).await;
    }

    #[tokio::test]
    async fn run_dropped_future_kills_group() {
        let _serial = one_at_a_time().await;
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        let _leftovers = KillLeftovers(&pids);
        let r = script_runner(dir.path(), &sleeper(&pids));
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
        wait_gone(&ids).await;
        assert_eq!(std::fs::read_dir(&stage).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn abort_on_drop_stops_the_task() {
        let marker = Arc::new(());
        let held = marker.clone();
        let task = unix_run::AbortOnDrop(tokio::spawn(async move {
            let _held = held;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }));
        tokio::task::yield_now().await;
        assert_eq!(Arc::strong_count(&marker), 2);
        drop(task);
        for _ in 0..50 {
            if Arc::strong_count(&marker) == 1 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the task was not aborted");
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
            folder: None,
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
