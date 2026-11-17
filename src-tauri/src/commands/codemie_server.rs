// Two questions the CodeMie CLI cannot answer for Settings → CodeMie:
//
// - Does an address someone typed belong to a CodeMie server? Asked before
//   `codemie setup` runs, so a typo never leaves a half-made profile.
// - Did the organisation's IT preset a CodeMie address for this Mac? An admin
//   writes `connect-defaults.json`; Connect only reads it.
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// What `codemie_url_check` found. `verdict` is one of `codemie`,
/// `not_codemie`, `unreachable`, `invalid`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct UrlCheck {
    pub verdict: String,
    pub status: Option<u16>,
    pub detail: String,
}

/// The organisation's preset CodeMie address.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrgDefaults {
    pub codemie_url: String,
    pub organization_name: Option<String>,
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// The API root the CLI talks to, as its `ensureApiBase` builds it: a local dev
/// server serves the API at its root, every other host under
/// `/code-assistant-api`.
pub fn api_base(origin: &str) -> String {
    let origin = origin.trim_end_matches('/');
    let host = url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    if host == "localhost" || host == "127.0.0.1" {
        origin.to_string()
    } else {
        format!("{origin}/code-assistant-api")
    }
}

/// Observed on codemie.lab.epam.com (2026-11-17):
/// `GET /code-assistant-api/v1/auth/login/53117` → `302` with
/// `Location: https://codemie.lab.epam.com/oauth2/start?rd=…`.
/// A CodeMie server sends the browser on to sign in; anything else is not one.
pub fn classify(status: u16, has_location: bool) -> &'static str {
    if (300..400).contains(&status) && has_location {
        "codemie"
    } else {
        "not_codemie"
    }
}

/// The origin of `input` when it is an address Connect may sign in to:
/// `https`, or `http` on this machine only, with nothing after the host.
fn valid_origin(input: &str) -> Option<String> {
    let u = url::Url::parse(input.trim()).ok()?;
    let host = u.host_str()?.to_string();
    let secure = u.scheme() == "https" || (u.scheme() == "http" && is_loopback(&host));
    let bare = matches!(u.path(), "" | "/") && u.query().is_none() && u.fragment().is_none();
    (secure && bare && u.username().is_empty() && u.password().is_none())
        .then(|| u.origin().ascii_serialization())
}

fn error_text(e: &reqwest::Error) -> String {
    let mut text = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        text.push_str(": ");
        text.push_str(&s.to_string());
        source = s.source();
    }
    text
}

fn unreachable(detail: String) -> UrlCheck {
    UrlCheck {
        verdict: "unreachable".into(),
        status: None,
        detail,
    }
}

/// Ask the server whether it is CodeMie. Never fails: every outcome is a verdict.
#[tauri::command]
pub async fn codemie_url_check(url: String) -> UrlCheck {
    let Some(origin) = valid_origin(&url) else {
        return UrlCheck {
            verdict: "invalid".into(),
            status: None,
            detail: "The address must be https:// and contain only the server name.".into(),
        };
    };
    let target = format!("{}/v1/auth/login/53117", api_base(&origin));
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => return unreachable(error_text(&e)),
    };
    match client.get(&target).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let has_location = resp.headers().contains_key(reqwest::header::LOCATION);
            UrlCheck {
                verdict: classify(status, has_location).into(),
                status: Some(status),
                detail: format!("GET {target} → {status}"),
            }
        }
        Err(e) => unreachable(error_text(&e)),
    }
}

/// Parse `connect-defaults.json`. Only an `https` address is accepted, reduced
/// to its origin; anything else is no preset at all.
pub fn parse_org_defaults(text: &str) -> Option<OrgDefaults> {
    let raw: OrgDefaults = serde_json::from_str(text).ok()?;
    let u = url::Url::parse(raw.codemie_url.trim()).ok()?;
    if u.scheme() != "https" || u.host_str().is_none() {
        return None;
    }
    Some(OrgDefaults {
        codemie_url: u.origin().ascii_serialization(),
        organization_name: raw
            .organization_name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty()),
    })
}

fn org_defaults_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some("/Library/Application Support/CodeMie/connect-defaults.json".into())
    }
    #[cfg(windows)]
    {
        std::env::var_os("ProgramData").map(|d| {
            std::path::PathBuf::from(d)
                .join("CodeMie")
                .join("connect-defaults.json")
        })
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

/// The CodeMie address IT preset for this machine, if any. Read-only.
#[tauri::command]
pub fn codemie_org_defaults() -> Option<OrgDefaults> {
    let text = std::fs::read_to_string(org_defaults_path()?).ok()?;
    parse_org_defaults(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_base_adds_prefix_except_localhost() {
        assert_eq!(
            api_base("https://codemie.acme.com"),
            "https://codemie.acme.com/code-assistant-api"
        );
        assert_eq!(api_base("http://localhost:8080"), "http://localhost:8080");
    }

    #[test]
    fn classify_redirect_is_codemie() {
        assert_eq!(classify(302, true), "codemie");
        assert_eq!(classify(302, false), "not_codemie");
        assert_eq!(classify(404, false), "not_codemie");
        assert_eq!(classify(200, false), "not_codemie");
    }

    #[test]
    fn org_defaults_require_https() {
        assert!(parse_org_defaults(
            r#"{"codemieUrl":"https://codemie.acme-bank.com","organizationName":"Acme Bank"}"#
        )
        .is_some());
        assert!(parse_org_defaults(r#"{"codemieUrl":"http://codemie.acme-bank.com"}"#).is_none());
        assert!(parse_org_defaults("not json").is_none());
    }

    #[tokio::test]
    async fn url_check_rejects_plain_http_remote() {
        assert_eq!(
            codemie_url_check("http://codemie.acme.com".into())
                .await
                .verdict,
            "invalid"
        );
    }
}
