//! The `codemie` CLI as the analytics source: one process per call, with an argument array and
//! no shell. A call that runs past the timeout is killed with its whole process group.
use crate::ai::profiles::DetectEnv;
use chrono::NaiveDate;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;

/// Every call is killed after this long.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
/// `export` of three days peaks near 4.2 GB; the default heap is 4 GB.
const NODE_OPTIONS: &str = "--max-old-space-size=6144";
/// How much of a failed call's stderr is kept for the message.
const STDERR_TAIL_LINES: usize = 20;
const STDERR_TAIL_CHARS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportOutcome {
    Written,
    /// Exit 0 and no file written: how the CLI says there are no sessions in the window.
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliError {
    NotFound,
    Timeout,
    Failed { code: i32, stderr_tail: String },
}

/// What the analytics page needs from the CLI. Object safe, like `ClaudeRunner`: Core holds an
/// `Arc<dyn AnalyticsCli>`, and tests hold a [`FakeAnalyticsCli`].
#[allow(dead_code)] // used from Task 2
pub trait AnalyticsCli: Send + Sync {
    /// `codemie analytics view --help` exits 0. False too when there is no CLI.
    fn supports_view(&self) -> BoxFuture<'_, bool>;
    /// Writes the sessions that started between `from` and `to` (UTC days, both included) to `out`.
    fn export<'a>(
        &'a self,
        from: NaiveDate,
        to: NaiveDate,
        out: &'a Path,
    ) -> BoxFuture<'a, Result<ExportOutcome, CliError>>;
    /// `analytics view --input <input> <args>`: the JSON it prints.
    fn view<'a>(
        &'a self,
        input: &'a Path,
        args: &'a [String],
    ) -> BoxFuture<'a, Result<Value, CliError>>;
    /// `analytics view --input <input> <args> --export html -o <out>`.
    fn report<'a>(
        &'a self,
        input: &'a Path,
        args: &'a [String],
        out: &'a Path,
    ) -> BoxFuture<'a, Result<(), CliError>>;
}

type Resolver = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;

/// The real CLI. `codemie` is looked up at every call, so installing it needs no restart.
pub struct CodemieCli {
    resolve: Resolver,
    timeout: Duration,
}

#[allow(dead_code)] // used from Task 2
impl CodemieCli {
    /// Finds `codemie` the same way profile detection finds its programs.
    pub fn new(env: DetectEnv) -> Self {
        Self::with_resolver(Arc::new(move || {
            crate::ai::discover::find_program_in(
                "codemie",
                &env.path_var,
                &env.home,
                &env.extra_dirs,
            )
        }))
    }
    pub fn with_resolver(resolve: Resolver) -> Self {
        Self {
            resolve,
            timeout: CALL_TIMEOUT,
        }
    }
    pub fn with_program(program: PathBuf) -> Self {
        Self::with_resolver(Arc::new(move || Some(program.clone())))
    }
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Runs the CLI with `args`; its stdout when it exits 0.
    async fn run(&self, args: &[String]) -> Result<Vec<u8>, CliError> {
        let program = (self.resolve)().ok_or(CliError::NotFound)?;
        let mut cmd = Command::new(program);
        cmd.args(args)
            .env("NODE_OPTIONS", NODE_OPTIONS)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        let child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => CliError::NotFound,
            _ => CliError::Failed {
                code: -1,
                stderr_tail: e.to_string(),
            },
        })?;
        let pid = child.id();
        match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
            Err(_) => {
                #[cfg(unix)]
                if let Some(pid) = pid {
                    // SAFETY: killpg only signals the process group the child leads.
                    unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
                }
                Err(CliError::Timeout)
            }
            Ok(Err(e)) => Err(CliError::Failed {
                code: -1,
                stderr_tail: e.to_string(),
            }),
            Ok(Ok(out)) if out.status.success() => Ok(out.stdout),
            Ok(Ok(out)) => Err(CliError::Failed {
                code: out.status.code().unwrap_or(-1),
                stderr_tail: tail(&String::from_utf8_lossy(&out.stderr)),
            }),
        }
    }
}

/// The last lines of `stderr`, capped, without the trailing newline.
fn tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.trim_end().lines().collect();
    let text = lines[lines.len().saturating_sub(STDERR_TAIL_LINES)..].join("\n");
    let skip = text.chars().count().saturating_sub(STDERR_TAIL_CHARS);
    text.chars().skip(skip).collect()
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

fn view_args(input: &Path, args: &[String]) -> Vec<String> {
    let mut all = strings(&["analytics", "view", "--input"]);
    all.push(input.to_string_lossy().into_owned());
    all.extend(args.iter().cloned());
    all
}

impl AnalyticsCli for CodemieCli {
    fn supports_view(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            self.run(&strings(&["analytics", "view", "--help"]))
                .await
                .is_ok()
        })
    }

    fn export<'a>(
        &'a self,
        from: NaiveDate,
        to: NaiveDate,
        out: &'a Path,
    ) -> BoxFuture<'a, Result<ExportOutcome, CliError>> {
        Box::pin(async move {
            // A file left by an earlier call must not be taken for this call's answer.
            let _ = std::fs::remove_file(out);
            let mut args = strings(&["analytics", "--from"]);
            args.push(from.format("%Y-%m-%d").to_string());
            args.push("--to".into());
            args.push(to.format("%Y-%m-%d").to_string());
            args.extend(strings(&[
                "--include-external",
                "always",
                "--export",
                "json",
                "-o",
            ]));
            args.push(out.to_string_lossy().into_owned());
            self.run(&args).await?;
            Ok(if out.exists() {
                ExportOutcome::Written
            } else {
                ExportOutcome::Empty
            })
        })
    }

    fn view<'a>(
        &'a self,
        input: &'a Path,
        args: &'a [String],
    ) -> BoxFuture<'a, Result<Value, CliError>> {
        Box::pin(async move {
            let stdout = self.run(&view_args(input, args)).await?;
            serde_json::from_slice(&stdout).map_err(|e| CliError::Failed {
                code: 0,
                stderr_tail: format!("view printed no JSON: {e}"),
            })
        })
    }

    fn report<'a>(
        &'a self,
        input: &'a Path,
        args: &'a [String],
        out: &'a Path,
    ) -> BoxFuture<'a, Result<(), CliError>> {
        Box::pin(async move {
            let mut all = view_args(input, args);
            all.extend(strings(&["--export", "html", "-o"]));
            all.push(out.to_string_lossy().into_owned());
            self.run(&all).await.map(|_| ())
        })
    }
}

/// Test double for [`AnalyticsCli`]: plays back scripted outcomes (an empty script answers
/// "nothing found") and records every call.
#[cfg(any(test, feature = "test-support"))]
pub struct FakeAnalyticsCli {
    supports: std::sync::atomic::AtomicBool,
    exports: std::sync::Mutex<std::collections::VecDeque<Result<ExportOutcome, CliError>>>,
    views: std::sync::Mutex<std::collections::VecDeque<Result<Value, CliError>>>,
    reports: std::sync::Mutex<std::collections::VecDeque<Result<(), CliError>>>,
    calls: std::sync::Mutex<Vec<FakeCall>>,
}

/// One call a [`FakeAnalyticsCli`] answered.
#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Clone, PartialEq)]
pub enum FakeCall {
    SupportsView,
    Export {
        from: NaiveDate,
        to: NaiveDate,
        out: PathBuf,
    },
    View {
        input: PathBuf,
        args: Vec<String>,
    },
    Report {
        input: PathBuf,
        args: Vec<String>,
        out: PathBuf,
    },
}

#[cfg(any(test, feature = "test-support"))]
impl Default for FakeAnalyticsCli {
    fn default() -> Self {
        Self {
            supports: true.into(),
            exports: Default::default(),
            views: Default::default(),
            reports: Default::default(),
            calls: Default::default(),
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
#[allow(dead_code)] // the scripting side is used from Task 2
impl FakeAnalyticsCli {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn set_supports_view(&self, yes: bool) {
        self.supports
            .store(yes, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn script_export(&self, r: Result<ExportOutcome, CliError>) {
        self.exports.lock().unwrap().push_back(r);
    }
    pub fn script_view(&self, r: Result<Value, CliError>) {
        self.views.lock().unwrap().push_back(r);
    }
    pub fn script_report(&self, r: Result<(), CliError>) {
        self.reports.lock().unwrap().push_back(r);
    }
    /// Every call, in order.
    pub fn calls(&self) -> Vec<FakeCall> {
        self.calls.lock().unwrap().clone()
    }
}

#[cfg(any(test, feature = "test-support"))]
impl AnalyticsCli for FakeAnalyticsCli {
    fn supports_view(&self) -> BoxFuture<'_, bool> {
        self.calls.lock().unwrap().push(FakeCall::SupportsView);
        let yes = self.supports.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move { yes })
    }
    fn export<'a>(
        &'a self,
        from: NaiveDate,
        to: NaiveDate,
        out: &'a Path,
    ) -> BoxFuture<'a, Result<ExportOutcome, CliError>> {
        self.calls.lock().unwrap().push(FakeCall::Export {
            from,
            to,
            out: out.into(),
        });
        let r = self
            .exports
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(ExportOutcome::Empty));
        Box::pin(async move { r })
    }
    fn view<'a>(
        &'a self,
        input: &'a Path,
        args: &'a [String],
    ) -> BoxFuture<'a, Result<Value, CliError>> {
        self.calls.lock().unwrap().push(FakeCall::View {
            input: input.into(),
            args: args.to_vec(),
        });
        let r = self
            .views
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Ok(Value::Null));
        Box::pin(async move { r })
    }
    fn report<'a>(
        &'a self,
        input: &'a Path,
        args: &'a [String],
        out: &'a Path,
    ) -> BoxFuture<'a, Result<(), CliError>> {
        self.calls.lock().unwrap().push(FakeCall::Report {
            input: input.into(),
            args: args.to_vec(),
            out: out.into(),
        });
        let r = self.reports.lock().unwrap().pop_front().unwrap_or(Ok(()));
        Box::pin(async move { r })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::time::Duration;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// A fake `codemie` that records its argv (one per line) and NODE_OPTIONS next to itself,
    /// then runs `body`.
    fn fake_cli(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("codemie");
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{d}/argv\"\nprintf '%s' \"$NODE_OPTIONS\" > \"{d}/env\"\n{body}\n",
            d = dir.display()
        );
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[tokio::test]
    async fn export_runs_without_a_shell_with_dates_and_raised_heap() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out file.json");
        let cli = CodemieCli::with_program(fake_cli(
            d.path(),
            "for a; do last=\"$a\"; done; echo '{}' > \"$last\"",
        ));
        let r = cli
            .export(date("2026-11-17"), date("2026-11-19"), &out)
            .await;
        assert_eq!(r, Ok(ExportOutcome::Written));
        let argv = std::fs::read_to_string(d.path().join("argv")).unwrap();
        assert_eq!(
            argv.lines().collect::<Vec<_>>(),
            [
                "analytics",
                "--from",
                "2026-11-17",
                "--to",
                "2026-11-19",
                "--include-external",
                "always",
                "--export",
                "json",
                "-o",
                out.to_str().unwrap()
            ]
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("env")).unwrap(),
            "--max-old-space-size=6144"
        );
        assert!(out.exists());
    }

    #[tokio::test]
    async fn export_without_a_written_file_is_empty() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("out.json");
        std::fs::write(&out, "stale").unwrap();
        let cli = CodemieCli::with_program(fake_cli(d.path(), "exit 0"));
        let r = cli
            .export(date("2026-11-17"), date("2026-11-17"), &out)
            .await;
        assert_eq!(r, Ok(ExportOutcome::Empty));
        assert!(
            !out.exists(),
            "a stale file from an earlier call is removed"
        );
    }

    #[tokio::test]
    async fn a_failing_export_keeps_the_last_stderr_lines() {
        let d = tempfile::tempdir().unwrap();
        let body = "i=0; while [ $i -lt 40 ]; do echo \"noise $i\" >&2; i=$((i+1)); done; echo 'heap out of memory' >&2; exit 3";
        let cli = CodemieCli::with_program(fake_cli(d.path(), body));
        let r = cli
            .export(date("2026-11-17"), date("2026-11-17"), &d.path().join("o"))
            .await;
        match r {
            Err(CliError::Failed { code, stderr_tail }) => {
                assert_eq!(code, 3);
                assert!(stderr_tail.ends_with("heap out of memory"), "{stderr_tail}");
                assert!(!stderr_tail.contains("noise 0\n"), "only the tail is kept");
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn view_support_is_the_help_exit_code() {
        let d = tempfile::tempdir().unwrap();
        let ok = CodemieCli::with_program(fake_cli(d.path(), "exit 0"));
        assert!(ok.supports_view().await);
        let argv = std::fs::read_to_string(d.path().join("argv")).unwrap();
        assert_eq!(
            argv.lines().collect::<Vec<_>>(),
            ["analytics", "view", "--help"]
        );
        let old = CodemieCli::with_program(fake_cli(d.path(), "exit 1"));
        assert!(!old.supports_view().await);
        let missing = CodemieCli::with_program(d.path().join("nope"));
        assert!(!missing.supports_view().await);
        let none = CodemieCli::with_resolver(Arc::new(|| None));
        assert!(!none.supports_view().await);
        assert_eq!(
            none.view(Path::new("x.json"), &[]).await,
            Err(CliError::NotFound)
        );
    }

    #[tokio::test]
    async fn a_call_past_the_timeout_is_killed() {
        let d = tempfile::tempdir().unwrap();
        let cli = CodemieCli::with_program(fake_cli(d.path(), "sleep 30"))
            .with_timeout(Duration::from_millis(200));
        let started = std::time::Instant::now();
        let r = cli
            .export(date("2026-11-17"), date("2026-11-17"), &d.path().join("o"))
            .await;
        assert_eq!(r, Err(CliError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn view_and_report_pass_input_and_arguments_and_parse_json() {
        let d = tempfile::tempdir().unwrap();
        let cli = CodemieCli::with_program(fake_cli(
            d.path(),
            "if [ \"$3\" = --input ]; then echo '{\"schema\":\"s\"}'; fi",
        ));
        let v = cli
            .view(
                Path::new("/s/sessions.json"),
                &["--last".into(), "7d".into()],
            )
            .await
            .unwrap();
        assert_eq!(v["schema"], "s");
        let argv = std::fs::read_to_string(d.path().join("argv")).unwrap();
        assert_eq!(
            argv.lines().collect::<Vec<_>>(),
            [
                "analytics",
                "view",
                "--input",
                "/s/sessions.json",
                "--last",
                "7d"
            ]
        );
        cli.report(
            Path::new("/s/sessions.json"),
            &["--agent".into(), "claude".into()],
            Path::new("/o/r.html"),
        )
        .await
        .unwrap();
        let argv = std::fs::read_to_string(d.path().join("argv")).unwrap();
        assert_eq!(
            argv.lines().collect::<Vec<_>>(),
            [
                "analytics",
                "view",
                "--input",
                "/s/sessions.json",
                "--agent",
                "claude",
                "--export",
                "html",
                "-o",
                "/o/r.html"
            ]
        );
        let bad = CodemieCli::with_program(fake_cli(d.path(), "echo not json"));
        assert!(matches!(
            bad.view(Path::new("x"), &[]).await,
            Err(CliError::Failed { .. })
        ));
    }
}
