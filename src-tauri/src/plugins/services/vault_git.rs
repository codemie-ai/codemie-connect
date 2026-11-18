//! `ctx.git` (Echo's plugin API, "Folders and files"): a plugin's history, status, restore and
//! commits in a folder the user gave it, by the system `git`. The caller has checked the grant
//! (`folders`, and `folders.write` for what `writes` names) and resolved the folder to its
//! canonical path; this module runs git there, blocking, and answers in Echo's shapes.
//!
//! Every run is hardened: `git` from an absolute `PATH` folder outside the granted one, 2.31 or
//! newer, stopped after 20 s; no prompt, hook, pager, editor, signing, credential helper, external
//! diff, fsmonitor or network; the system config skipped and the inherited `GIT_*` environment
//! dropped; only the subcommands below. Output is parsed only in formats asked for explicitly
//! (`-z`, `--porcelain=v1`, `--format`), so the user's own config can't change it. Paths a plugin
//! names are relative plain names inside the folder, never through a link, and reach git after
//! `--` as literal pathspecs.
use super::store::{inside, relative};
use super::{at, bad, permission, unsupported};
use crate::plugins::host::{ErrorCode, HostError};
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const NOT_INSTALLED: &str =
    "git isn't installed: install it (xcode-select --install) to use history";
/// The oldest git Connect runs.
const MIN_VERSION: (u32, u32) = (2, 31);
const TIMEOUT: Duration = Duration::from_secs(20);
/// More output than this from one run is refused (a file is checked for 16 MB before it's read).
const OUT_MAX: usize = 64 << 20;
/// `log`: 50 commits unless asked, 1,000 at most.
const LOG_DEFAULT: u64 = 50;
const LOG_MAX: u64 = 1000;
/// `show`: 1 MB of a file unless asked, 4 MB at most; a file over 16 MB isn't read.
const SHOW_DEFAULT: usize = 1 << 20;
const SHOW_MAX: usize = 4 << 20;
const BLOB_MAX: u64 = 16 << 20;
/// `status` and `commit` take 1–1,000 paths; a message is 1–5,000 characters.
const PATHS_MAX: usize = 1000;
const MESSAGE_MAX: usize = 5000;
/// The committer's address of a plugin's commit, in Connect and in Echo.
const CONNECT_MAIL: &str = "@plugins.connect.invalid";
const ECHO_MAIL: &str = "@plugins.echo.invalid";
/// Settings given on every run, over whatever the user's or the repository's config says.
const CONFIG: &[&str] = &[
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "core.pager=cat",
    "commit.gpgsign=false",
    "tag.gpgsign=false",
    "credential.helper=",
    "protocol.allow=never",
    "core.editor=true",
    "diff.external=",
    "log.showSignature=false",
    // `log -- .` must not turn into following one file.
    "log.follow=false",
];
/// The environment of every run (after the inherited `GIT_*` variables are dropped). Optional
/// locks off: a status doesn't rewrite the user's index.
const ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_NO_REPLACE_OBJECTS", "1"),
    ("GIT_LITERAL_PATHSPECS", "1"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("LC_ALL", "C"),
];
/// The only subcommands Connect runs (none of them reaches the network).
const SUBCOMMANDS: &[&str] = &[
    "--version",
    "rev-parse",
    "symbolic-ref",
    "status",
    "log",
    "cat-file",
    "check-ignore",
    "add",
    "diff",
    "commit",
    "config",
    "init",
];

/// `ctx.git.<name>` for plugin `plugin` in `root` (a granted folder, canonical, already checked).
/// `args` is the plugin's whole argument array, root first:
///   info [root] · status [root, {paths}] · log [root, {path, max}] · show [root, rev, path, {max, strict}]
///   commit [root, {paths, message}] · init [root, {branch}]
///
/// Blocking.
pub fn call(root: &Path, plugin: &str, name: &str, args: &Value) -> Result<Value, HostError> {
    if !matches!(name, "info" | "status" | "log" | "show" | "commit" | "init") {
        return Err(unsupported(name));
    }
    Git::system(root)?.call(root, plugin, name, args)
}

/// Whether `name` changes the folder (commit, init).
pub fn writes(name: &str) -> bool {
    matches!(name, "commit" | "init")
}

/// The system `git`, and in tests extra environment (an isolated `HOME` and config).
struct Git {
    bin: PathBuf,
    env: Vec<(String, String)>,
}

/// What one git run left.
struct Ran {
    code: Option<i32>,
    out: Vec<u8>,
    err: String,
}

impl Ran {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// Git's own complaint, as the plugin hears it.
    fn failure(&self) -> HostError {
        let said: Vec<&str> = self
            .err
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
            .collect();
        let said = said.join(" ");
        if said.is_empty() {
            bad("git failed")
        } else {
            bad(format!(
                "git: {}",
                said.chars().take(500).collect::<String>()
            ))
        }
    }
}

/// `git` in an absolute `PATH` folder; never one inside `root` (a granted folder supplies no
/// programs).
fn locate(path_var: &OsStr, root: &Path) -> Result<PathBuf, HostError> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    std::env::split_paths(path_var)
        .filter(|dir| {
            dir.is_absolute()
                && !dir.starts_with(root)
                && dunce::canonicalize(dir).map_or(true, |real| !real.starts_with(root))
        })
        .map(|dir| dir.join(name))
        .find(|p| is_program(p))
        .ok_or_else(|| bad(NOT_INSTALLED))
}

fn is_program(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// `(major, minor)` of `git --version`'s answer.
fn version_of(said: &str) -> Option<(u32, u32)> {
    let v = said.trim().strip_prefix("git version ")?;
    let mut parts = v.split(['.', ' ']).map(|n| n.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??))
}

/// The text of a one-line answer (its final newline dropped).
fn line(out: &[u8]) -> String {
    let out = out.strip_suffix(b"\n").unwrap_or(out);
    String::from_utf8_lossy(out).into_owned()
}

/// A pipe read to its end on its own thread; `None` when it held over `OUT_MAX` (the rest is
/// drained so git isn't left blocked).
fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Option<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.by_ref().take(OUT_MAX as u64 + 1).read_to_end(&mut buf);
            if buf.len() > OUT_MAX {
                let _ = std::io::copy(&mut pipe, &mut std::io::sink());
                let _ = tx.send(None);
                return;
            }
        }
        let _ = tx.send(Some(buf));
    });
    rx
}

fn timed_out() -> HostError {
    HostError::new(ErrorCode::Timeout, "git took over 20 s and was stopped")
}

impl Git {
    /// The system git, 2.31 or newer.
    fn system(root: &Path) -> Result<Git, HostError> {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let git = Git {
            bin: locate(&path, root)?,
            env: Vec::new(),
        };
        let ran = git.exec(root, &["--version"], &[])?;
        if !ran.ok() {
            // macOS's `/usr/bin/git` without the command line tools.
            return Err(bad(NOT_INSTALLED));
        }
        let said = line(&ran.out);
        match version_of(&said) {
            Some(v) if v >= MIN_VERSION => Ok(git),
            _ => Err(bad(format!(
                "{said} is too old: history needs git 2.31 or newer"
            ))),
        }
    }

    /// Runs one of `SUBCOMMANDS`.
    fn run(&self, cwd: &Path, args: &[&str]) -> Result<Ran, HostError> {
        self.run_env(cwd, args, &[])
    }

    fn run_env(&self, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<Ran, HostError> {
        match args.first() {
            Some(sub) if SUBCOMMANDS.contains(sub) => self.exec(cwd, args, env),
            _ => Err(bad(format!(
                "Connect doesn't run git {}",
                args.first().unwrap_or(&"")
            ))),
        }
    }

    /// `run`'s output when git succeeded, else git's complaint.
    fn ok(&self, cwd: &Path, args: &[&str]) -> Result<Vec<u8>, HostError> {
        let ran = self.run(cwd, args)?;
        if ran.ok() {
            Ok(ran.out)
        } else {
            Err(ran.failure())
        }
    }

    /// Runs git hardened, in `cwd`, for 20 s at most.
    fn exec(&self, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<Ran, HostError> {
        let mut cmd = Command::new(&self.bin);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                cmd.env_remove(key);
            }
        }
        cmd.envs(ENV.iter().copied())
            .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .envs(env.iter().copied());
        for c in CONFIG {
            cmd.args(["-c", c]);
        }
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            if !cwd.is_dir() {
                HostError::new(ErrorCode::NotFound, "the folder isn't there any more")
            } else if e.kind() == std::io::ErrorKind::NotFound {
                bad(NOT_INSTALLED)
            } else {
                bad(format!("git couldn't start: {e}"))
            }
        })?;
        let out = drain(child.stdout.take());
        let err = drain(child.stderr.take());
        let deadline = Instant::now() + TIMEOUT;
        let left = || deadline.saturating_duration_since(Instant::now());
        let done = (|| {
            let out = out.recv_timeout(left()).ok()?;
            let err = err.recv_timeout(left()).ok()?;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => return Some((status, out, err)),
                    Ok(None) if !left().is_zero() => std::thread::sleep(Duration::from_millis(1)),
                    _ => return None,
                }
            }
        })();
        let Some((status, out, err)) = done else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(timed_out());
        };
        let out = out.ok_or_else(|| bad("git's answer is over 64 MB"))?;
        let err = String::from_utf8_lossy(&err.unwrap_or_default()).into_owned();
        Ok(Ran {
            code: status.code(),
            out,
            err,
        })
    }

    fn call(
        &self,
        root: &Path,
        plugin: &str,
        name: &str,
        args: &Value,
    ) -> Result<Value, HostError> {
        match name {
            "info" => self.info(root),
            "status" => self.status(root, at(args, 1)),
            "log" => self.log(root, at(args, 1)),
            "show" => self.show(root, args),
            "commit" => self.commit(root, plugin, at(args, 1)),
            "init" => self.init(root, at(args, 1)),
            _ => Err(unsupported(name)),
        }
    }

    /// Where `root` sits in its repository, or `None` when it isn't in one.
    fn repo(&self, root: &Path) -> Result<Option<Repo>, HostError> {
        let ran = self.run(root, &["rev-parse", "--show-prefix"])?;
        if !ran.ok() {
            return if ran.err.contains("not a git repository") {
                Ok(None)
            } else {
                Err(ran.failure())
            };
        }
        let git_dir = self.ok(root, &["rev-parse", "--absolute-git-dir"])?;
        Ok(Some(Repo {
            prefix: line(&ran.out),
            git_dir: PathBuf::from(line(&git_dir)),
        }))
    }

    fn need(&self, root: &Path) -> Result<Repo, HostError> {
        self.repo(root)?
            .ok_or_else(|| bad("this folder isn't in a git repository"))
    }

    /// The commit `HEAD` names; `None` before the first one.
    fn head(&self, root: &Path) -> Result<Option<String>, HostError> {
        let ran = self.run(root, &["rev-parse", "-q", "--verify", "HEAD^{commit}"])?;
        Ok(ran.ok().then(|| line(&ran.out)))
    }

    fn info(&self, root: &Path) -> Result<Value, HostError> {
        let Some(repo) = self.repo(root)? else {
            return Ok(json!({"repo": false}));
        };
        let r = self.run(root, &["symbolic-ref", "-q", "HEAD"])?;
        let branch = r.ok().then(|| {
            let full = line(&r.out);
            full.strip_prefix("refs/heads/")
                .map_or(full.clone(), str::to_string)
        });
        Ok(json!({
            "repo": true,
            "detached": branch.is_none(),
            "branch": branch,
            "head": self.head(root)?,
            "busy": busy(&repo.git_dir),
            "subfolder": !repo.prefix.is_empty(),
        }))
    }

    fn status(&self, root: &Path, o: &Value) -> Result<Value, HostError> {
        let repo = self.need(root)?;
        let paths = match o.get("paths") {
            None | Some(Value::Null) => vec![".".to_string()],
            Some(list) => paths_of(root, list)?,
        };
        let args = with_paths(
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            &paths,
        );
        let out = self.ok(root, &args)?;
        let mut entries = out.split(|b| *b == 0).filter(|e| !e.is_empty());
        let mut list = Vec::new();
        // `XY <path>`, then a rename's or copy's old path as an entry of its own.
        while let Some(entry) = entries.next() {
            let entry = String::from_utf8_lossy(entry);
            let (Some(code), Some(" "), Some(path)) =
                (entry.get(..2), entry.get(2..3), entry.get(3..))
            else {
                continue;
            };
            let from = code
                .contains(['R', 'C'])
                .then(|| entries.next())
                .flatten()
                .map(String::from_utf8_lossy);
            let Some(path) = path.strip_prefix(repo.prefix.as_str()) else {
                continue;
            };
            let mut item = json!({"path": path, "code": code});
            if let Some(from) = from
                .as_deref()
                .and_then(|f| f.strip_prefix(repo.prefix.as_str()))
            {
                item["from"] = json!(from);
            }
            list.push(item);
        }
        Ok(Value::Array(list))
    }

    fn log(&self, root: &Path, o: &Value) -> Result<Value, HostError> {
        let repo = self.need(root)?;
        let path = match o.get("path").and_then(Value::as_str) {
            Some(p) if !p.is_empty() => Some(plain(p)?),
            _ => None,
        };
        if self.head(root)?.is_none() {
            return Ok(json!([]));
        }
        let max = o
            .get("max")
            .and_then(Value::as_u64)
            .filter(|m| *m > 0)
            .unwrap_or(LOG_DEFAULT)
            .min(LOG_MAX);
        let count = format!("--max-count={max}");
        let mut args = vec![
            "log",
            "-z",
            "--encoding=UTF-8",
            "--no-notes",
            "--no-show-signature",
            "--format=%H%x00%an%x00%ae%x00%aI%x00%ce%x00%s",
            &count,
        ];
        if path.is_some() {
            args.extend(["--follow", "--name-only", "--no-relative"]);
        }
        args.extend(["--", path.as_deref().unwrap_or(".")]);
        let out = self.ok(root, &args)?;
        // Each commit: its six fields, each ended by NUL; with `--name-only` then a newline and
        // the file's name at that commit, ended by NUL.
        let fields: Vec<String> = out
            .split(|b| *b == 0)
            .map(|f| String::from_utf8_lossy(f).into_owned())
            .collect();
        let mut list = Vec::new();
        let mut i = 0;
        while i < fields.len() {
            let rev = fields[i].trim_start_matches('\n');
            i += 1;
            if rev.is_empty() {
                continue;
            }
            let Some([author, email, date, committer, subject]) = fields.get(i..i + 5) else {
                break;
            };
            i += 5;
            let mut item = json!({
                "rev": rev, "author": author, "email": email, "date": date,
                "subject": subject, "echo": echo_of(committer),
            });
            if path.is_some() {
                if let Some(name) = fields.get(i).and_then(|f| f.strip_prefix('\n')) {
                    i += 1;
                    item["path"] = name
                        .strip_prefix(repo.prefix.as_str())
                        .map_or(Value::Null, |p| json!(p));
                }
            }
            list.push(item);
        }
        Ok(Value::Array(list))
    }

    fn show(&self, root: &Path, args: &Value) -> Result<Value, HostError> {
        let rev = at(args, 1).as_str().unwrap_or("");
        if !is_version(rev) {
            return Err(bad(format!(
                "“{rev}” isn't a version: HEAD, HEAD~N or a commit's id"
            )));
        }
        let path = plain(at(args, 2).as_str().unwrap_or(""))?;
        let o = at(args, 3);
        self.need(root)?;
        let kind = self.run(root, &["cat-file", "-t", rev])?;
        if !kind.ok() {
            return Ok(Value::Null);
        }
        if line(&kind.out) != "commit" {
            return Err(bad(format!("“{rev}” isn't a commit")));
        }
        // `./`: the path from the root, which may sit below the repository's top.
        let spec = format!("{rev}:./{path}");
        let kind = self.run(root, &["cat-file", "-t", &spec])?;
        if !kind.ok() {
            return Ok(Value::Null);
        }
        match line(&kind.out).as_str() {
            "blob" => {}
            "tree" => return Err(bad(format!("“{path}” is a folder at that version"))),
            _ => return Err(bad(format!("“{path}” isn't a file at that version"))),
        }
        let size: u64 = line(&self.ok(root, &["cat-file", "-s", &spec])?)
            .parse()
            .map_err(|_| bad("git didn't say the file's size"))?;
        if size > BLOB_MAX {
            return Err(bad(format!("“{path}” is over 16 MB at that version")));
        }
        let blob = self.ok(root, &["cat-file", "blob", &spec])?;
        if o.get("strict") == Some(&Value::Bool(true)) && std::str::from_utf8(&blob).is_err() {
            return Err(bad(format!("“{path}” is not UTF-8 text at that version")));
        }
        let max = o
            .get("max")
            .and_then(Value::as_u64)
            .filter(|m| *m > 0)
            .map_or(SHOW_DEFAULT, |m| m.min(SHOW_MAX as u64) as usize);
        Ok(json!({
            "text": String::from_utf8_lossy(cut(&blob, max)),
            "size": blob.len(),
            "truncated": blob.len() > max,
        }))
    }

    fn init(&self, root: &Path, o: &Value) -> Result<Value, HostError> {
        if self.repo(root)?.is_some() {
            return Err(bad("this folder is already in a git repository"));
        }
        let branch = match o.get("branch") {
            None | Some(Value::Null) => "main",
            Some(b) => b
                .as_str()
                .filter(|b| {
                    (1..=100).contains(&b.len())
                        && b.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"._-/".contains(&c))
                })
                .ok_or_else(|| bad("a branch's name is letters, digits, . _ - and /"))?,
        };
        let initial = format!("--initial-branch={branch}");
        self.ok(root, &["init", "-q", "--template=", &initial])?;
        self.info(root)
    }

    fn commit(&self, root: &Path, plugin: &str, o: &Value) -> Result<Value, HostError> {
        if plugin.is_empty()
            || plugin.len() > 64
            || !plugin
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(bad(format!("“{plugin}” can't be named in a commit")));
        }
        let repo = self.need(root)?;
        if let Some(what) = busy(&repo.git_dir) {
            return Err(bad(format!(
                "a {what} is under way in this repository: finish it before committing"
            )));
        }
        let message = o
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|m| (1..=MESSAGE_MAX).contains(&m.chars().count()) && !m.contains('\0'))
            .ok_or_else(|| bad("a commit's message is plain text of 1 to 5,000 characters"))?;
        let paths = paths_of(root, o.get("paths").unwrap_or(&Value::Null))?;
        for p in &paths {
            // Hidden files only as `fs.write` takes them (`.gitignore`, `.obsidian/<name>.json`, a
            // skill's Markdown), and a skill only when it runs nothing.
            if !super::hidden::hidden_ok(p, false) {
                return Err(permission(format!(
                    "“{p}” is hidden: a plugin commits notes, not other programs' files"
                )));
            }
            if super::hidden::in_skills(p) {
                let text = std::fs::read_to_string(root.join(p)).unwrap_or_default();
                if let Some(why) = super::hidden::skill_md_problem(&text) {
                    return Err(bad(format!("“{p}”: {why}")));
                }
            }
            if std::fs::symlink_metadata(root.join(p)).is_ok_and(|m| m.is_dir()) {
                return Err(bad(format!("“{p}” is a folder: commit names files")));
            }
        }
        // Before anything is staged (`git add` would stage the others, then refuse). Exit 0:
        // some are ignored, listed a line each; 1: none. `check-ignore` takes no `literal`
        // magic, and matches its paths as written: `./` keeps a leading `:` from reading as magic.
        let dotted: Vec<String> = paths.iter().map(|p| format!("./{p}")).collect();
        let ignored = self.run_env(
            root,
            &with_paths(&["check-ignore"], &dotted),
            &[("GIT_LITERAL_PATHSPECS", "0")],
        )?;
        match ignored.code {
            Some(1) => {}
            Some(0) => {
                let listed = String::from_utf8_lossy(&ignored.out);
                let first = listed.lines().next().unwrap_or_default();
                return Err(bad(format!(
                    "“{}” is ignored by the repository",
                    first.trim_start_matches("./")
                )));
            }
            _ => return Err(ignored.failure()),
        }
        self.ok(root, &with_paths(&["add"], &paths))?;
        if self.head(root)?.is_some() {
            let diff = self.run(
                root,
                &with_paths(
                    &[
                        "diff",
                        "--cached",
                        "--quiet",
                        "--no-ext-diff",
                        "--no-textconv",
                        "HEAD",
                    ],
                    &paths,
                ),
            )?;
            match diff.code {
                Some(0) => return Ok(json!({"rev": null})),
                Some(1) => {}
                _ => return Err(diff.failure()),
            }
        }

        let ours = format!("{plugin}{CONNECT_MAIL}");
        let (name, email) = self
            .identity(root)?
            .unwrap_or_else(|| ("CodeMie Connect".to_string(), ours.clone()));
        let committer = format!("CodeMie Connect ({plugin})");
        let env = [
            ("GIT_AUTHOR_NAME", name.as_str()),
            ("GIT_AUTHOR_EMAIL", email.as_str()),
            ("GIT_COMMITTER_NAME", committer.as_str()),
            ("GIT_COMMITTER_EMAIL", ours.as_str()),
        ];
        let args = with_paths(
            &[
                "commit",
                "-q",
                "--no-verify",
                "--no-gpg-sign",
                "--cleanup=whitespace",
                "--only",
                "-m",
                message,
            ],
            &paths,
        );
        let ran = self.run_env(root, &args, &env)?;
        if !ran.ok() {
            return Err(ran.failure());
        }
        Ok(json!({"rev": self.head(root)?}))
    }

    /// The user's own name and address as their git config has them, when it has both.
    fn identity(&self, root: &Path) -> Result<Option<(String, String)>, HostError> {
        let get = |key: &str| -> Result<Option<String>, HostError> {
            let ran = self.run(root, &["config", "--get", key])?;
            Ok(ran
                .ok()
                .then(|| line(&ran.out))
                .filter(|v| !v.trim().is_empty()))
        };
        Ok(get("user.name")?.zip(get("user.email")?))
    }
}

/// Where a root sits: its path below the repository's top (`""` or ending in `/`), and the
/// repository's own folder.
struct Repo {
    prefix: String,
    git_dir: PathBuf,
}

/// What is under way in the repository: a merge, rebase, cherry-pick, revert or bisect.
fn busy(git_dir: &Path) -> Option<&'static str> {
    [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ]
    .into_iter()
    .find(|(file, _)| git_dir.join(file).exists())
    .map(|(_, what)| what)
}

/// `first`, then `--` and the paths (pathspecs, literal by `GIT_LITERAL_PATHSPECS`).
fn with_paths<'a>(first: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut args = first.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    args
}

/// `rel` as git takes it from the root: relative plain names, no `.`/`..`.
fn plain(rel: &str) -> Result<String, HostError> {
    Ok(relative(rel, false)?.join("/"))
}

/// The paths a plugin named (1–1,000), each a plain relative path that reaches no link on the
/// disk.
fn paths_of(root: &Path, list: &Value) -> Result<Vec<String>, HostError> {
    let list = list
        .as_array()
        .filter(|l| (1..=PATHS_MAX).contains(&l.len()))
        .ok_or_else(|| bad("this needs 1 to 1,000 paths"))?;
    list.iter()
        .map(|p| {
            let p = p.as_str().ok_or_else(|| bad("a path is text"))?;
            inside(root, p, false)?;
            plain(p)
        })
        .collect()
}

/// `HEAD`, `HEAD~N` or a commit's id (4–64 hex).
fn is_version(rev: &str) -> bool {
    rev == "HEAD"
        || rev
            .strip_prefix("HEAD~")
            .is_some_and(|n| (1..=6).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
        || ((4..=64).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The plugin that committed through Connect or Echo, by the committer's address.
fn echo_of(committer: &str) -> Option<&str> {
    [CONNECT_MAIL, ECHO_MAIL]
        .iter()
        .find_map(|mail| committer.strip_suffix(mail))
        .filter(|id| !id.is_empty())
}

/// The first `max` bytes, ending before a character `max` would split.
fn cut(bytes: &[u8], max: usize) -> &[u8] {
    if bytes.len() <= max {
        return bytes;
    }
    let mut end = max;
    while end > 0 && max - end < 3 && bytes[end] & 0xC0 == 0x80 {
        end -= 1;
    }
    &bytes[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp folder, and a git that reads only the config written there: the developer's own
    /// `~/.gitconfig`, ignore and attributes files are never read, and no repository above the
    /// temp folder is found.
    struct T {
        dir: tempfile::TempDir,
        git: Git,
    }

    const SAM: &str = "[user]\n\tname = Sam Rivera\n\temail = sam@example.test\n";

    impl T {
        fn new() -> T {
            T::with_config(SAM)
        }

        fn with_config(config: &str) -> T {
            let dir = tempfile::tempdir().unwrap();
            let base = dunce::canonicalize(dir.path()).unwrap();
            let home = base.join("home");
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("gitconfig"), config).unwrap();
            let mut git = Git::system(&base).expect("the tests need git");
            let at = |p: &Path| p.display().to_string();
            git.env = vec![
                ("HOME".into(), at(&home)),
                ("XDG_CONFIG_HOME".into(), at(&home.join(".config"))),
                ("GIT_CONFIG_GLOBAL".into(), at(&home.join("gitconfig"))),
                ("GIT_CEILING_DIRECTORIES".into(), at(&base)),
            ];
            T { dir, git }
        }

        fn base(&self) -> PathBuf {
            dunce::canonicalize(self.dir.path()).unwrap()
        }

        /// A new empty folder in the temp folder.
        fn folder(&self, name: &str) -> PathBuf {
            let p = self.base().join(name);
            std::fs::create_dir_all(&p).unwrap();
            p
        }

        fn call(&self, root: &Path, name: &str, args: Value) -> Result<Value, HostError> {
            self.git.call(root, "knowledge", name, &args)
        }

        /// A fixture's git run (any subcommand), which must work; its output, trimmed.
        fn sh_env(&self, cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
            let ran = self.git.exec(cwd, args, env).unwrap();
            assert!(ran.ok(), "git {args:?}: {}", ran.err);
            String::from_utf8_lossy(&ran.out).trim().to_string()
        }

        fn sh(&self, cwd: &Path, args: &[&str]) -> String {
            self.sh_env(cwd, args, &[])
        }

        /// A repository `name` whose first commit, by the user, holds `files`.
        fn repo(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
            let root = self.folder(name);
            self.sh(&root, &["init", "-q", "--initial-branch=main"]);
            for (path, text) in files {
                write(&root, path, text.as_bytes());
            }
            self.sh(&root, &["add", "-A"]);
            self.sh(&root, &["commit", "-q", "-m", "first"]);
            root
        }
    }

    fn write(root: &Path, path: &str, bytes: &[u8]) {
        let f = root.join(path);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, bytes).unwrap();
    }

    fn by_path(v: Value) -> Vec<Value> {
        let mut list = v.as_array().unwrap().clone();
        list.sort_by_key(|e| e["path"].as_str().unwrap().to_string());
        list
    }

    fn field(log: &Value, key: &str) -> Vec<Value> {
        log.as_array()
            .unwrap()
            .iter()
            .map(|c| c[key].clone())
            .collect()
    }

    #[test]
    fn info_of_a_plain_folder_a_new_repository_and_one_with_a_commit() {
        let t = T::new();
        let plain = t.folder("plain");
        assert_eq!(
            t.call(&plain, "info", json!([plain])).unwrap(),
            json!({"repo": false})
        );

        let fresh = t.folder("fresh");
        t.sh(&fresh, &["init", "-q", "--initial-branch=main"]);
        assert_eq!(
            t.call(&fresh, "info", json!([fresh])).unwrap(),
            json!({"repo": true, "branch": "main", "head": null, "detached": false,
                   "busy": null, "subfolder": false})
        );
        // No commit yet: no history.
        assert_eq!(t.call(&fresh, "log", json!([fresh])).unwrap(), json!([]));

        let root = t.repo("r", &[("a.md", "a")]);
        let head = t.sh(&root, &["rev-parse", "HEAD"]);
        let info = t.call(&root, "info", json!([root])).unwrap();
        assert_eq!(info["head"], json!(head));
        assert_eq!(info["branch"], json!("main"));
    }

    #[test]
    fn info_of_a_subfolder_root_and_a_detached_head() {
        let t = T::new();
        let repo = t.repo("r", &[("notes/a.md", "a")]);
        let sub = repo.join("notes");
        let info = t.call(&sub, "info", json!([sub])).unwrap();
        assert_eq!(info["subfolder"], json!(true));
        assert_eq!(info["repo"], json!(true));

        t.sh(&repo, &["checkout", "-q", "--detach"]);
        let head = t.sh(&repo, &["rev-parse", "HEAD"]);
        assert_eq!(
            t.call(&repo, "info", json!([repo])).unwrap(),
            json!({"repo": true, "branch": null, "head": head, "detached": true,
                   "busy": null, "subfolder": false})
        );
    }

    #[test]
    fn a_merge_under_way_shows_as_busy_and_holds_commits_back() {
        let t = T::new();
        let repo = t.repo("r", &[("a.md", "a")]);
        let head = t.sh(&repo, &["rev-parse", "HEAD"]);
        std::fs::write(repo.join(".git/MERGE_HEAD"), format!("{head}\n")).unwrap();
        let info = t.call(&repo, "info", json!([repo])).unwrap();
        assert_eq!(info["busy"], json!("merge"));
        write(&repo, "a.md", b"a2");
        let e = t
            .call(
                &repo,
                "commit",
                json!([repo, {"paths": ["a.md"], "message": "x"}]),
            )
            .unwrap_err();
        assert!(e.message.contains("merge"), "{e}");
    }

    #[test]
    fn status_lists_changed_and_untracked_files_relative_to_the_root() {
        let t = T::new();
        let repo = t.repo(
            "r",
            &[("top.md", "t"), ("notes/a.md", "a"), ("notes/b.md", "b")],
        );
        write(&repo, "notes/a.md", b"a2");
        write(&repo, "notes/new/c.md", b"c");
        write(&repo, "top.md", b"t2");
        assert_eq!(
            by_path(t.call(&repo, "status", json!([repo])).unwrap()),
            vec![
                json!({"path": "notes/a.md", "code": " M"}),
                json!({"path": "notes/new/c.md", "code": "??"}),
                json!({"path": "top.md", "code": " M"}),
            ]
        );
        // `paths` limits it.
        assert_eq!(
            t.call(
                &repo,
                "status",
                json!([repo, {"paths": ["notes/a.md", "notes/b.md"]}])
            )
            .unwrap(),
            json!([{"path": "notes/a.md", "code": " M"}])
        );
        // A root below the repository's top: its paths, nothing outside it.
        let sub = repo.join("notes");
        assert_eq!(
            by_path(t.call(&sub, "status", json!([sub])).unwrap()),
            vec![
                json!({"path": "a.md", "code": " M"}),
                json!({"path": "new/c.md", "code": "??"}),
            ]
        );
        // A plain folder has no status.
        let plain = t.folder("plain");
        assert!(t.call(&plain, "status", json!([plain])).is_err());
    }

    #[test]
    fn commit_commits_only_its_paths_by_the_user_and_connect() {
        let t = T::new();
        let repo = t.repo("r", &[("a.md", "a"), ("c.md", "c")]);
        write(&repo, "a.md", b"a2");
        write(&repo, "new.md", b"n");
        write(&repo, "c.md", b"c2");
        let r = t
            .call(
                &repo,
                "commit",
                json!([repo, {"paths": ["a.md", "new.md"], "message": "  Edit two pages \n"}]),
            )
            .unwrap();
        let head = t.sh(&repo, &["rev-parse", "HEAD"]);
        assert_eq!(r, json!({"rev": head}));
        assert_eq!(
            t.sh(&repo, &["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"]),
            "Sam Rivera <sam@example.test>|CodeMie Connect (knowledge) \
             <knowledge@plugins.connect.invalid>|Edit two pages"
        );
        assert_eq!(
            t.sh(&repo, &["show", "--name-only", "--format=", "HEAD"]),
            "a.md\nnew.md"
        );
        // The user's other change is left as it was.
        assert_eq!(
            t.call(&repo, "status", json!([repo])).unwrap(),
            json!([{"path": "c.md", "code": " M"}])
        );
        // Nothing changed since: no commit.
        let again = t
            .call(
                &repo,
                "commit",
                json!([repo, {"paths": ["a.md", "new.md"], "message": "Again"}]),
            )
            .unwrap();
        assert_eq!(again, json!({"rev": null}));
        assert_eq!(t.sh(&repo, &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn without_a_git_identity_connect_is_the_author_too() {
        let t = T::with_config("");
        let repo = t.folder("r");
        t.sh(&repo, &["init", "-q", "--initial-branch=main"]);
        write(&repo, "a.md", b"a");
        let r = t
            .call(
                &repo,
                "commit",
                json!([repo, {"paths": ["a.md"], "message": "First"}]),
            )
            .unwrap();
        assert_eq!(r["rev"], json!(t.sh(&repo, &["rev-parse", "HEAD"])));
        assert_eq!(
            t.sh(&repo, &["log", "-1", "--format=%an <%ae>"]),
            "CodeMie Connect <knowledge@plugins.connect.invalid>"
        );
    }

    #[test]
    fn commit_refuses_ignored_hidden_and_folder_paths_and_bad_messages() {
        let t = T::new();
        let repo = t.repo("r", &[(".gitignore", "*.log\n"), ("a.md", "a")]);
        write(&repo, "x.log", b"x");
        write(&repo, ".env", b"SECRET=1");
        write(&repo, "a.md", b"a2");
        write(&repo, "notes/b.md", b"b");
        let commit = |paths: Value, message: &str| {
            t.call(
                &repo,
                "commit",
                json!([repo, {"paths": paths, "message": message}]),
            )
        };
        let e = commit(json!(["x.log"]), "m").unwrap_err();
        assert!(e.message.contains("ignored"), "{e}");
        assert!(commit(json!([".env"]), "m").is_err());
        assert!(commit(json!(["notes"]), "m").is_err());
        assert!(commit(json!([]), "m").is_err());
        assert!(commit(json!(["a.md"]), "  \n ").is_err());
        assert!(commit(json!(["a.md"]), &"x".repeat(5001)).is_err());
        // Nothing was committed or staged by the refusals.
        assert_eq!(t.sh(&repo, &["rev-list", "--count", "HEAD"]), "1");
        assert_eq!(t.sh(&repo, &["diff", "--cached", "--name-only"]), "");
        // The hidden files `fs.write` takes are committed too; a skill only when it runs nothing.
        write(&repo, ".gitignore", b"*.log\n.DS_Store\n");
        write(&repo, ".obsidian/app.json", b"{}");
        write(
            &repo,
            ".claude/skills/twin/SKILL.md",
            b"---\nname: twin\n---\n# Twin\n",
        );
        let r = commit(
            json!([
                ".gitignore",
                ".obsidian/app.json",
                ".claude/skills/twin/SKILL.md"
            ]),
            "Twin preset",
        )
        .unwrap();
        assert!(r["rev"].is_string(), "{r}");
        write(&repo, ".claude/skills/twin/SKILL.md", b"Run !`ls`\n");
        let e = commit(json!([".claude/skills/twin/SKILL.md"]), "m").unwrap_err();
        assert!(e.message.contains("can't run commands"), "{e}");
        assert!(commit(json!([".obsidian/community-plugins.json"]), "m").is_err());
    }

    #[test]
    fn log_follows_a_page_through_its_rename_and_names_plugin_commits() {
        let t = T::new();
        let repo = t.repo("r", &[("notes/a.md", "line one\nline two\nline three\n")]);
        std::fs::rename(repo.join("notes/a.md"), repo.join("notes/b.md")).unwrap();
        let commit = |paths: Value, message: &str| {
            t.call(
                &repo,
                "commit",
                json!([repo, {"paths": paths, "message": message}]),
            )
            .unwrap()
        };
        commit(json!(["notes/a.md", "notes/b.md"]), "Rename");
        write(
            &repo,
            "notes/b.md",
            b"line one\nline two\nline three\nline four\n",
        );
        commit(json!(["notes/b.md"]), "Edit");
        write(&repo, "other.md", b"o");
        t.sh(&repo, &["add", "other.md"]);
        t.sh_env(
            &repo,
            &["commit", "-q", "-m", "From Echo"],
            &[("GIT_COMMITTER_EMAIL", "obsidian@plugins.echo.invalid")],
        );

        let log = t.call(&repo, "log", json!([repo])).unwrap();
        assert_eq!(
            field(&log, "subject"),
            vec![
                json!("From Echo"),
                json!("Edit"),
                json!("Rename"),
                json!("first")
            ]
        );
        assert_eq!(
            field(&log, "echo"),
            vec![
                json!("obsidian"),
                json!("knowledge"),
                json!("knowledge"),
                json!(null)
            ]
        );
        let first = &log[3];
        assert_eq!(first["author"], json!("Sam Rivera"));
        assert_eq!(first["email"], json!("sam@example.test"));
        assert_eq!(first["rev"].as_str().unwrap().len(), 40);
        let date = first["date"].as_str().unwrap();
        assert_eq!(&date[10..11], "T", "{date}");
        assert!(first.get("path").is_none());
        assert_eq!(
            t.call(&repo, "log", json!([repo, {"max": 1}]))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // The page's own history, through its rename, with its path at each commit.
        let log = t
            .call(&repo, "log", json!([repo, {"path": "notes/b.md"}]))
            .unwrap();
        assert_eq!(
            field(&log, "subject"),
            vec![json!("Edit"), json!("Rename"), json!("first")]
        );
        assert_eq!(
            field(&log, "path"),
            vec![
                json!("notes/b.md"),
                json!("notes/b.md"),
                json!("notes/a.md")
            ]
        );

        // A root below the repository's top: its commits, paths relative to it.
        let sub = repo.join("notes");
        let log = t.call(&sub, "log", json!([sub])).unwrap();
        assert_eq!(
            field(&log, "subject"),
            vec![json!("Edit"), json!("Rename"), json!("first")]
        );
        let log = t.call(&sub, "log", json!([sub, {"path": "b.md"}])).unwrap();
        assert_eq!(
            field(&log, "path"),
            vec![json!("b.md"), json!("b.md"), json!("a.md")]
        );
    }

    #[test]
    fn show_reads_a_file_at_a_version() {
        let t = T::new();
        let repo = t.repo("r", &[("notes/a.md", "one\n")]);
        let first = t.sh(&repo, &["rev-parse", "HEAD"]);
        write(&repo, "notes/a.md", b"two\n");
        t.sh(&repo, &["commit", "-q", "-am", "second"]);
        let show =
            |rev: &str, path: &str, o: Value| t.call(&repo, "show", json!([repo, rev, path, o]));

        assert_eq!(
            show("HEAD", "notes/a.md", json!({})).unwrap(),
            json!({"text": "two\n", "size": 4, "truncated": false})
        );
        assert_eq!(
            show("HEAD~1", "notes/a.md", json!(null)).unwrap()["text"],
            json!("one\n")
        );
        assert_eq!(
            show(&first, "notes/a.md", json!({})).unwrap()["text"],
            json!("one\n")
        );
        assert_eq!(
            show(&first[..7], "notes/a.md", json!({})).unwrap()["text"],
            json!("one\n")
        );
        assert_eq!(
            show("HEAD", "notes/a.md", json!({"max": 2})).unwrap(),
            json!({"text": "tw", "size": 4, "truncated": true})
        );
        // Not there: the file, or the commit.
        assert_eq!(show("HEAD", "missing.md", json!({})).unwrap(), json!(null));
        assert_eq!(
            show("HEAD~5", "notes/a.md", json!({})).unwrap(),
            json!(null)
        );
        // Not a version, a folder, or not a commit.
        assert_eq!(
            show("main", "notes/a.md", json!({})).unwrap_err().message,
            "“main” isn't a version: HEAD, HEAD~N or a commit's id"
        );
        assert!(show("HEAD^", "notes/a.md", json!({})).is_err());
        assert!(show("HEAD", "notes", json!({}))
            .unwrap_err()
            .message
            .contains("folder"));
        let blob = t.sh(&repo, &["rev-parse", "HEAD:notes/a.md"]);
        assert!(show(&blob, "notes/a.md", json!({}))
            .unwrap_err()
            .message
            .contains("commit"));
        // A root below the repository's top reads its own files.
        let sub = repo.join("notes");
        assert_eq!(
            t.call(&sub, "show", json!([sub, "HEAD", "a.md", {}]))
                .unwrap()["text"],
            json!("two\n")
        );
    }

    #[test]
    fn show_strict_refuses_bytes_that_are_not_utf8() {
        let t = T::new();
        let repo = t.repo("r", &[("a.md", "a")]);
        write(&repo, "l.txt", b"caf\xe9\n");
        t.sh(&repo, &["add", "l.txt"]);
        t.sh(&repo, &["commit", "-q", "-m", "latin-1"]);
        assert_eq!(
            t.call(
                &repo,
                "show",
                json!([repo, "HEAD", "l.txt", {"strict": true}])
            )
            .unwrap_err()
            .message,
            "“l.txt” is not UTF-8 text at that version"
        );
        assert_eq!(
            t.call(&repo, "show", json!([repo, "HEAD", "l.txt"]))
                .unwrap()["text"],
            json!("caf\u{FFFD}\n")
        );
    }

    #[test]
    fn init_makes_a_repository_on_its_branch_and_never_inside_one() {
        let t = T::new();
        let vault = t.folder("vault");
        assert_eq!(
            t.call(&vault, "init", json!([vault])).unwrap(),
            json!({"repo": true, "branch": "main", "head": null, "detached": false,
                   "busy": null, "subfolder": false})
        );
        // No template: no sample hooks.
        assert!(!vault.join(".git/hooks").exists());
        // Inside a repository: refused, the folder itself or one below it.
        assert!(t.call(&vault, "init", json!([vault])).is_err());
        let sub = vault.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(t.call(&sub, "init", json!([sub])).is_err());
        assert!(!sub.join(".git").exists());

        let other = t.folder("other");
        let info = t
            .call(&other, "init", json!([other, {"branch": "trunk"}]))
            .unwrap();
        assert_eq!(info["branch"], json!("trunk"));
        let bad_name = t.folder("bad");
        assert!(t
            .call(&bad_name, "init", json!([bad_name, {"branch": "a b"}]))
            .is_err());
        assert!(!bad_name.join(".git").exists());
    }

    #[test]
    fn paths_leading_out_of_the_folder_are_refused() {
        let t = T::new();
        let repo = t.repo("r", &[("a.md", "a")]);
        let status = |p: &str| t.call(&repo, "status", json!([repo, {"paths": [p]}]));
        assert_eq!(status("../x.md").unwrap_err().code, ErrorCode::Permission);
        assert!(status("/etc/hosts").is_err());
        assert!(t
            .call(&repo, "show", json!([repo, "HEAD", "../r/a.md"]))
            .is_err());
        assert!(t
            .call(&repo, "log", json!([repo, {"path": "x/../../a.md"}]))
            .is_err());
        assert!(t
            .call(
                &repo,
                "commit",
                json!([repo, {"paths": ["x/../../a.md"], "message": "m"}])
            )
            .is_err());
        #[cfg(unix)]
        {
            let outside = t.folder("outside");
            write(&outside, "x.md", b"x");
            std::os::unix::fs::symlink(&outside, repo.join("out")).unwrap();
            assert!(status("out/x.md").is_err());
            assert!(t
                .call(
                    &repo,
                    "commit",
                    json!([repo, {"paths": ["out/x.md"], "message": "m"}])
                )
                .is_err());
        }
    }

    #[test]
    fn writes_names_the_calls_that_change_the_folder() {
        assert!(writes("commit") && writes("init"));
        assert!(!["info", "status", "log", "show", "push"]
            .iter()
            .any(|n| writes(n)));
    }

    #[test]
    fn an_unknown_call_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let e = call(dir.path(), "knowledge", "push", &json!([dir.path()])).unwrap_err();
        assert_eq!(e.code, ErrorCode::Unsupported);
    }

    #[test]
    fn git_is_looked_for_on_path_but_never_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let e = locate(empty.as_os_str(), &root).unwrap_err();
        assert_eq!(
            e.message,
            "git isn't installed: install it (xcode-select --install) to use history"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let bin = root.join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("git"), "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(bin.join("git"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
            assert!(locate(bin.as_os_str(), &root).is_err());
            assert_eq!(locate(bin.as_os_str(), &empty).unwrap(), bin.join("git"));
        }
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        assert_eq!(cut("aé".as_bytes(), 2), b"a");
        assert_eq!(cut("a€b".as_bytes(), 3), b"a");
        assert_eq!(cut("a€b".as_bytes(), 4), "a€".as_bytes());
        assert_eq!(cut(b"abc", 9), b"abc");
    }

    #[test]
    fn versions_before_2_31_are_too_old() {
        assert_eq!(
            version_of("git version 2.39.5 (Apple Git-154)"),
            Some((2, 39))
        );
        assert_eq!(version_of("git version 2.45.1.windows.1\n"), Some((2, 45)));
        assert!(version_of("git version 2.30.9").unwrap() < MIN_VERSION);
        assert_eq!(version_of("not git"), None);
    }
}
