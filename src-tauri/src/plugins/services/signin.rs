//! `ctx.signin` for the hosts the sheet named (`uses.signin.hosts`); Connect provides GitHub only
//! (DESIGN 7.2). Connect never reads a sign-in on a plugin's behalf by itself: the GitHub CLI's
//! token is read only when the user presses Sign in on the plugin's settings (`allow`, a host
//! operation the window calls, never a plugin), and is then kept as the plugin's secret in
//! `<private>/credentials/plugins/<id>/signin.json` (0600). `get({fresh: true})` reads the CLI
//! again only for a sign-in the user allowed. With `uses.signin.keep`, a plugin may keep a
//! sign-in it made itself (`keep`, `forget`), handed back as `from: "echo"` (Echo's word, which
//! plugins test for). A sign-in grants no network: the API host must be in `network.hosts`.
use super::settings::write_private;
use super::{at, bad, permission, read_json, text, Granted, Services};
use crate::plugins::host::{ErrorCode, HostError};
use futures_util::future::BoxFuture;
use serde_json::{json, Map, Value};
use std::time::Duration;

/// The only sign-in Connect provides.
pub const GITHUB: &str = "github.com";
const MAX_TOKEN: usize = 8 * 1024;

/// Where sign-ins come from on this computer.
pub trait SignInSource: Send + Sync {
    /// The GitHub CLI's token for `host`, read now; `None` when it has none.
    fn gh_token(&self, host: &str) -> BoxFuture<'static, Result<Option<String>, String>>;
    /// Whether a program (`gh`, `git`) is installed.
    fn installed(&self, program: &str) -> bool;
}

/// The real GitHub CLI.
pub struct GhCli;

impl SignInSource for GhCli {
    fn gh_token(&self, host: &str) -> BoxFuture<'static, Result<Option<String>, String>> {
        let host = host.to_string();
        Box::pin(async move {
            let Some(gh) = crate::ai::discover::find_program("gh", &[]) else {
                return Ok(None);
            };
            let run = tokio::process::Command::new(gh)
                .args(["auth", "token", "--hostname", &host])
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output();
            let out = tokio::time::timeout(Duration::from_secs(15), run)
                .await
                .map_err(|_| "the GitHub CLI didn't answer".to_string())?
                .map_err(|e| format!("the GitHub CLI didn't run: {e}"))?;
            let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(
                (out.status.success() && !token.is_empty() && !token.contains(char::is_whitespace))
                    .then_some(token),
            )
        })
    }

    fn installed(&self, program: &str) -> bool {
        crate::ai::discover::find_program(program, &[]).is_some()
    }
}

fn file(s: &Services, id: &str) -> std::path::PathBuf {
    s.paths.secrets_of(id).join("signin.json")
}

fn kept(s: &Services, id: &str) -> Map<String, Value> {
    match read_json(&file(s, id), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn keep_entry(s: &Services, id: &str, host: &str, entry: Option<Value>) -> Result<(), HostError> {
    let mut all = kept(s, id);
    match entry {
        Some(e) => all.insert(host.to_string(), e),
        None => all.remove(host),
    };
    write_private(&file(s, id), &Value::Object(all))
}

/// The host, if the sheet named it and Connect provides it.
fn host_of<'a>(p: &Granted, host: &'a str) -> Result<&'a str, HostError> {
    p.needs("signin", "use your sign-in")?;
    if !p
        .words("signin", "hosts")
        .iter()
        .any(|h| h.eq_ignore_ascii_case(host))
    {
        return Err(permission(format!(
            "{} didn't name “{host}” for sign-in when it was installed (uses.signin.hosts)",
            p.id
        )));
    }
    if !host.eq_ignore_ascii_case(GITHUB) {
        return Err(HostError::new(
            ErrorCode::Unsupported,
            "only GitHub sign-in is available in CodeMie Connect",
        ));
    }
    Ok(GITHUB)
}

pub fn call(s: &Services, p: &Granted, name: &str, args: &Value) -> Result<Value, HostError> {
    let host = host_of(p, text(args, 0, "a host")?)?;
    match name {
        "signin.sources" => Ok(json!({
            "gh": s.outside.signin.installed("gh"),
            "git": s.outside.signin.installed("git"),
        })),
        "signin.keep" | "signin.forget" => {
            if !p.flag("signin", "keep") {
                return Err(permission(format!(
                    "{} didn't ask Connect to keep a sign-in it makes (uses.signin.keep)",
                    p.id
                )));
            }
            s.writable()?;
            if name == "signin.forget" {
                let had = kept(s, &p.id)
                    .get(host)
                    .is_some_and(|e| e["from"] == "echo");
                if had {
                    keep_entry(s, &p.id, host, None)?;
                }
                return Ok(json!(had));
            }
            let token = at(args, 1)
                .as_str()
                .filter(|t| !t.is_empty() && t.len() <= MAX_TOKEN && !t.contains(['\r', '\n']))
                .ok_or_else(|| bad("a sign-in is one line of text, 8 KB at most"))?;
            keep_entry(
                s,
                &p.id,
                host,
                Some(json!({"token": token, "from": "echo"})),
            )?;
            Ok(Value::Bool(true))
        }
        _ => Err(super::unsupported(name)),
    }
}

/// `signin.get(host, {fresh})`: the sign-in the user allowed (or the plugin kept), else
/// `permission` asking the user to sign in from the plugin's settings.
pub async fn get(s: &Services, p: &Granted, args: &Value) -> Result<Value, HostError> {
    let host = host_of(p, text(args, 0, "a host")?)?;
    let Some(entry) = kept(s, &p.id).get(host).cloned() else {
        return Err(permission(format!(
            "sign in to {host} from {}'s settings in Connect first",
            p.name
        )));
    };
    if at(args, 1)["fresh"] == true && entry["from"] == "gh" {
        // The user allowed the GitHub CLI's sign-in: it may have been renewed since.
        if let Ok(Some(token)) = s.outside.signin.gh_token(host).await {
            if entry["token"] != token.as_str() {
                keep_entry(s, &p.id, host, Some(json!({"token": token, "from": "gh"})))?;
            }
            return Ok(json!({"token": token, "from": "gh"}));
        }
    }
    Ok(json!({"token": entry["token"], "from": entry["from"]}))
}

/// The user pressed Sign in on the plugin's settings: reads the GitHub CLI's token now and keeps
/// it for the plugin.
pub async fn allow(s: &Services, p: &Granted, host: &str) -> Result<Value, HostError> {
    let host = host_of(p, host)?;
    let token = s
        .outside
        .signin
        .gh_token(host)
        .await
        .map_err(bad)?
        .ok_or_else(|| {
            HostError::new(
                ErrorCode::NotFound,
                "the GitHub CLI isn't signed in on this computer: run gh auth login, then try again",
            )
        })?;
    keep_entry(s, &p.id, host, Some(json!({"token": token, "from": "gh"})))?;
    Ok(json!({"signedIn": true, "host": host, "from": "gh"}))
}

/// The user signed the plugin out of `host`.
pub fn revoke(s: &Services, p: &Granted, host: &str) -> Result<Value, HostError> {
    let host = host_of(p, host)?;
    keep_entry(s, &p.id, host, None)?;
    Ok(json!({"signedIn": false, "host": host}))
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn signin_without_user_click_returns_permission() {
        let env = Env::new();
        *env.gh.token.lock().unwrap() = Some("gho_secret".into());
        let p = env.plugin(
            "github",
            json!({"signin": {"hosts": ["github.com"], "keep": true}, "network": {"hosts": ["api.github.com"]}}),
            json!([]),
        );
        env.plugin("plain", json!({}), json!([]));
        // Before the user's Sign in: refused, and the CLI isn't even asked.
        for fresh in [json!({}), json!({"fresh": true})] {
            let e = env
                .call_async("github", "signin.get", json!(["github.com", fresh]))
                .await
                .unwrap_err();
            assert_eq!(e.code, ErrorCode::Permission, "{e}");
            assert!(e.message.contains("settings"), "{e}");
        }
        assert_eq!(env.gh.reads.load(Ordering::SeqCst), 0);
        assert_eq!(
            env.call("github", "signin.sources", json!(["github.com"]))
                .unwrap(),
            json!({"gh": true, "git": false})
        );
        assert_eq!(env.gh.reads.load(Ordering::SeqCst), 0);

        // The user's Sign in reads it once and keeps it, owner-only.
        allow(&env.services, &p, "github.com").await.unwrap();
        assert_eq!(env.gh.reads.load(Ordering::SeqCst), 1);
        let got = env
            .call_async("github", "signin.get", json!(["github.com"]))
            .await
            .unwrap();
        assert_eq!(got, json!({"token": "gho_secret", "from": "gh"}));
        let kept = env
            .dir
            .path()
            .join("private/credentials/plugins/github/signin.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&kept).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert!(
            !std::fs::read_to_string(env.services.data_of("github").join("settings.json"))
                .unwrap_or_default()
                .contains("gho_secret")
        );
        // Fresh: the CLI again (renewed); signed out: refused again.
        *env.gh.token.lock().unwrap() = Some("gho_renewed".into());
        let fresh = env
            .call_async(
                "github",
                "signin.get",
                json!(["github.com", {"fresh": true}]),
            )
            .await
            .unwrap();
        assert_eq!(fresh["token"], "gho_renewed");
        revoke(&env.services, &p, "github.com").unwrap();
        assert!(env
            .call_async("github", "signin.get", json!(["github.com"]))
            .await
            .is_err());

        // A sign-in it made itself, kept and forgotten.
        env.call("github", "signin.keep", json!(["github.com", "gho_own"]))
            .unwrap();
        let own = env
            .call_async("github", "signin.get", json!(["github.com"]))
            .await
            .unwrap();
        assert_eq!(own, json!({"token": "gho_own", "from": "echo"}));
        assert_eq!(
            env.call("github", "signin.forget", json!(["github.com"]))
                .unwrap(),
            json!(true)
        );

        // Other hosts and plugins without the grant are refused.
        let e = env
            .call_async("github", "signin.get", json!(["gitlab.com"]))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        let e = env
            .call_async("plain", "signin.get", json!(["github.com"]))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert!(env
            .call("github", "signin.keep", json!(["github.com", "a\nb"]))
            .is_err());
    }

    /// The answers of Settings' Sign in and Sign out (`plugins_request` `signin`/`signout`),
    /// and a Sign in when the GitHub CLI isn't signed in, for the window's fixtures.
    #[tokio::test]
    async fn contract_fixtures_match_the_real_signin() {
        let env = Env::new();
        let p = env.plugin(
            "github",
            json!({"signin": {"hosts": ["github.com"]}, "network": {"hosts": ["api.github.com"]}}),
            json!([]),
        );
        let no_cli = allow(&env.services, &p, "github.com").await.unwrap_err();
        *env.gh.token.lock().unwrap() = Some("gho_secret".into());
        let signin = allow(&env.services, &p, "github.com").await.unwrap();
        let signout = revoke(&env.services, &p, "github.com").unwrap();
        assert!(!signin.to_string().contains("gho_secret"));
        crate::plugins::testkit::contract_fixture(
            "plugins-signin.json",
            &json!({
                "signin": signin,
                "signout": signout,
                "notSignedIn": {"code": no_cli.code.as_str(), "message": no_cli.message},
            }),
        );
    }
}
