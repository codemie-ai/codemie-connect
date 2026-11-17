//! Fetching a marketplace with the `git` command line, apart from everything of the user's.
//!
//! git runs with an empty environment except `PATH` and the locale, a throwaway `HOME` and
//! `XDG_CONFIG_HOME`, and no system or global config (`GIT_CONFIG_NOSYSTEM`,
//! `GIT_CONFIG_GLOBAL=/dev/null`): none of the user's `insteadOf` rewrites, extra headers,
//! credential helpers, proxies-by-config or hooks apply, and no `GIT_*` variable reaches it.
//! On top, every call carries `-c` settings that allow https only (redirects included), verify
//! certificates, run no hooks, store and prompt no credentials, check links out as plain files
//! and never touch submodules. A call that runs past its timeout is killed with everything it
//! started (its process group).
use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long a fetch may take.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(60);

/// Fetches a marketplace. The real one is `CliGit`; tests use a stand-in so they never reach
/// the network.
pub trait Git: Send + Sync {
    /// Clones `url` at `reference` (a branch or tag; the default branch when `None`) into
    /// `dest`, which doesn't exist yet, and returns the commit it checked out. The error is
    /// git's reason, one line.
    fn clone_at(&self, url: &str, reference: Option<&str>, dest: &Path) -> Result<String, String>;
}

/// The `git` command line.
pub struct CliGit {
    pub program: PathBuf,
    pub timeout: Duration,
}

impl Default for CliGit {
    fn default() -> Self {
        Self {
            program: PathBuf::from("git"),
            timeout: GIT_TIMEOUT,
        }
    }
}

#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

/// The settings every git call runs with.
fn hardening() -> Vec<OsString> {
    let hooks = format!("core.hooksPath={NULL_DEVICE}");
    [
        hooks.as_str(),
        "protocol.allow=never",
        "protocol.https.allow=always",
        "http.sslVerify=true",
        "credential.helper=",
        "core.askPass=",
        "core.symlinks=false",
        "core.fsmonitor=false",
        "submodule.recurse=false",
    ]
    .iter()
    .flat_map(|setting| [OsString::from("-c"), OsString::from(setting)])
    .collect()
}

/// `git clone --depth 1` of one branch or tag, never its submodules.
pub fn clone_args(url: &str, reference: Option<&str>, dest: &Path) -> Vec<OsString> {
    let mut args = hardening();
    args.extend(["clone", "--depth", "1", "--no-recurse-submodules"].map(OsString::from));
    if let Some(r) = reference {
        args.extend([OsString::from("--branch"), OsString::from(r)]);
    }
    args.extend([OsString::from("--"), OsString::from(url), dest.into()]);
    args
}

impl Git for CliGit {
    fn clone_at(&self, url: &str, reference: Option<&str>, dest: &Path) -> Result<String, String> {
        let parent = dest.parent().ok_or("no folder to clone into")?;
        let home = throwaway_home(parent)?;
        self.run(&clone_args(url, reference, dest), parent, &home)?;
        self.head(dest, &home)
    }
}

/// `<dir>/git-home`: git's `HOME` and `XDG_CONFIG_HOME`, empty.
fn throwaway_home(dir: &Path) -> Result<PathBuf, String> {
    let home = dir.join("git-home");
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    Ok(home)
}

impl CliGit {
    /// The commit checked out in `repo`.
    fn head(&self, repo: &Path, home: &Path) -> Result<String, String> {
        let mut args = hardening();
        args.extend(["rev-parse", "HEAD"].map(OsString::from));
        let commit = self.run(&args, repo, home)?.trim().to_string();
        let hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit());
        if (commit.len() == 40 || commit.len() == 64) && hex(&commit) {
            Ok(commit.to_ascii_lowercase())
        } else {
            Err("git didn’t say which commit it fetched".into())
        }
    }

    /// git in `cwd`, with only the environment described in the module comment.
    fn command(&self, args: &[OsString], cwd: &Path, home: &Path) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(args).current_dir(cwd).env_clear();
        let passed: &[&str] = if cfg!(windows) {
            &["PATH", "LANG", "LC_ALL", "SystemRoot", "TEMP", "TMP"]
        } else {
            &["PATH", "LANG", "LC_ALL"]
        };
        for key in passed {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        cmd.env("HOME", home)
            .env("XDG_CONFIG_HOME", home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LFS_SKIP_SMUDGE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd
    }

    /// Runs git for at most `timeout`; returns its output, or the last line of its complaint.
    fn run(&self, args: &[OsString], cwd: &Path, home: &Path) -> Result<String, String> {
        let mut child = self.command(args, cwd, home).spawn().map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                "Connect needs git to fetch marketplaces; install it, then try again".into()
            } else {
                e.to_string()
            }
        })?;
        let out = drain(
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        );
        let err = drain(
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        );
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if start.elapsed() > self.timeout => {
                    kill_group(&mut child);
                    return Err(format!(
                        "it took longer than {} seconds",
                        self.timeout.as_secs()
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => return Err(e.to_string()),
            }
        };
        let stdout = out.join().unwrap_or_default();
        let stderr = err.join().unwrap_or_default();
        if status.success() {
            return Ok(String::from_utf8_lossy(&stdout).into_owned());
        }
        let text = String::from_utf8_lossy(&stderr);
        let reason = text
            .lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .unwrap_or("git failed");
        let reason = reason
            .strip_prefix("fatal: ")
            .or_else(|| reason.strip_prefix("error: "))
            .unwrap_or(reason);
        Err(reason
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect())
    }
}

/// Reads a pipe to its end on its own thread, keeping the first 64 KB.
fn drain(pipe: Option<Box<dyn Read + Send>>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = (&mut pipe).take(64 * 1024).read_to_end(&mut kept);
            let _ = io::copy(&mut pipe, &mut io::sink());
        }
        kept
    })
}

/// Kills git and everything it started (`git-remote-https` and the like), then reaps it.
fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    // SAFETY: killpg takes plain integers; the group is the child's own (`process_group(0)`),
    // and a group that is already gone only yields ESRCH.
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    if let Err(e) = child.kill() {
        log::warn!("git: couldn't stop a fetch that ran too long: {e}");
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real_git() -> bool {
        let found = Command::new("git").arg("--version").output();
        if !found.is_ok_and(|o| o.status.success()) {
            eprintln!("skipped: no git on this machine");
            return false;
        }
        true
    }

    #[test]
    fn git_runs_hardened_and_refuses_other_transports() {
        let dest = Path::new("/data/plugins/tmp/u/clone");
        let args: Vec<String> = clone_args("https://github.com/acme/plugins", Some("v1"), dest)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let hooks = format!("core.hooksPath={NULL_DEVICE}");
        assert_eq!(
            args,
            [
                "-c",
                hooks.as_str(),
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.https.allow=always",
                "-c",
                "http.sslVerify=true",
                "-c",
                "credential.helper=",
                "-c",
                "core.askPass=",
                "-c",
                "core.symlinks=false",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "submodule.recurse=false",
                "clone",
                "--depth",
                "1",
                "--no-recurse-submodules",
                "--branch",
                "v1",
                "--",
                "https://github.com/acme/plugins",
                "/data/plugins/tmp/u/clone",
            ]
        );
        // The real git: file, http and ssh are refused before any connection is made (nothing
        // listens at 127.0.0.1:9).
        if !real_git() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let bare = dir.path().join("repo.git");
        let init = Command::new("git")
            .args(["init", "-q", "--bare"])
            .arg(&bare)
            .status()
            .unwrap();
        assert!(init.success());
        let git = CliGit {
            program: "git".into(),
            timeout: Duration::from_secs(20),
        };
        for (url, transport) in [
            (format!("file://{}", bare.display()), "file"),
            ("http://127.0.0.1:9/acme/plugins".to_string(), "http"),
            ("ssh://127.0.0.1:9/acme/plugins".to_string(), "ssh"),
        ] {
            let dest = dir.path().join(format!("c-{transport}"));
            let why = git.clone_at(&url, None, &dest).unwrap_err();
            assert!(
                why.contains(&format!("transport '{transport}' not allowed")),
                "{url}: {why}"
            );
            assert!(!dest.exists());
        }
        // Every hardening setting is one git accepts: the commit lookup runs with all of them.
        let repo = dir.path().join("work");
        let made = Command::new("git")
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success()
            && Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(["commit", "-q", "--allow-empty", "-m", "x"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success();
        assert!(made);
        let home = throwaway_home(dir.path()).unwrap();
        assert_eq!(git.head(&repo, &home).unwrap().len(), 40);
        // A folder that isn't a repository has no commit.
        assert!(!git.head(dir.path(), &home).unwrap_err().is_empty());
    }

    #[cfg(unix)]
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn git_gets_a_clean_environment_and_no_user_config() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("log.txt");
        // A stand-in git that writes down what it was given.
        let fake = script(
            dir.path(),
            "fake-git",
            &format!(
                "{{ printf 'ARGS %s\\n' \"$*\"; env; }} >> '{}'\n\
                 case \"$*\" in *rev-parse*) echo 0123456789abcdef0123456789abcdef01234567 ;; esac\n\
                 case \"$*\" in *' clone '*) for last; do :; done; mkdir -p \"$last\" ;; esac\n",
                log.display()
            ),
        );
        // Something of the user's that must not reach git (a unique name: tests run in parallel).
        std::env::set_var("CONNECT_GIT_LEAK_PROBE", "owner-secret");
        let git = CliGit {
            program: fake,
            timeout: Duration::from_secs(20),
        };
        let dest = dir.path().join("tmp/clone");
        std::fs::create_dir_all(dir.path().join("tmp")).unwrap();
        let commit = git
            .clone_at("https://github.com/acme/plugins", Some("v1"), &dest)
            .unwrap();
        assert_eq!(commit, "0123456789abcdef0123456789abcdef01234567");
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(!text.contains("owner-secret"), "{text}");
        let home = dir.path().join("tmp/git-home");
        let allowed = [
            "PATH",
            "LANG",
            "LC_ALL",
            "HOME",
            "XDG_CONFIG_HOME",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_CONFIG_GLOBAL",
            "GIT_TERMINAL_PROMPT",
            "GIT_LFS_SKIP_SMUDGE",
            // Set by the shell running the stand-in itself.
            "PWD",
            "OLDPWD",
            "SHLVL",
            "_",
        ];
        let mut calls = 0;
        for line in text.lines() {
            if line.starts_with("ARGS ") {
                calls += 1;
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            assert!(allowed.contains(&key), "{key} reached git");
            match key {
                "HOME" | "XDG_CONFIG_HOME" => assert_eq!(Path::new(value), home),
                "GIT_CONFIG_NOSYSTEM" => assert_eq!(value, "1"),
                "GIT_CONFIG_GLOBAL" => assert_eq!(value, "/dev/null"),
                "GIT_TERMINAL_PROMPT" => assert_eq!(value, "0"),
                _ => {}
            }
        }
        assert_eq!(calls, 2, "clone, then rev-parse");
        assert!(text.contains("ARGS -c core.hooksPath=/dev/null"), "{text}");
        assert!(text.contains("http.sslVerify=true"), "{text}");

        // The real git, run the same way, reads no config file at all: only the settings on
        // its command line (so no insteadOf, extraHeader or credential helper of the user's).
        if !real_git() {
            return;
        }
        let git = CliGit {
            program: "git".into(),
            timeout: Duration::from_secs(20),
        };
        let mut args = hardening();
        args.extend(["config", "--list", "--show-origin"].map(OsString::from));
        let listed = git.run(&args, dir.path(), &home).unwrap();
        assert!(!listed.trim().is_empty());
        for line in listed.lines() {
            assert!(line.starts_with("command line:"), "{line}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_fetch_that_runs_too_long_is_killed_with_its_children() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("child.pid");
        // A stand-in git that starts a child of its own and waits for it.
        let slow = script(
            dir.path(),
            "slow-git",
            &format!("sleep 30 &\necho $! > '{}'\nwait\n", pidfile.display()),
        );
        let git = CliGit {
            program: slow,
            timeout: Duration::from_secs(2),
        };
        let started = Instant::now();
        let why = git
            .clone_at(
                "https://github.com/acme/plugins",
                None,
                &dir.path().join("clone"),
            )
            .unwrap_err();
        assert!(why.starts_with("it took longer than"), "{why}");
        assert!(started.elapsed() < Duration::from_secs(10));
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // The grandchild went with the group (it is reaped by init shortly after).
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only checks whether the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < deadline, "the child {pid} still runs");
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
