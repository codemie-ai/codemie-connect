//! macOS Graph read transport, matching Echo's system-curl integration. Secrets use stdin only.
use super::{graph, models::*, Core};
use serde_json::Value;
use std::{collections::HashMap, process::Stdio, sync::Mutex, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};
const LIMIT: usize = 16 * 1024 * 1024;
struct OwnedRead<'a> {
    children: &'a Mutex<HashMap<String, Child>>,
    key: String,
}
impl Drop for OwnedRead<'_> {
    fn drop(&mut self) {
        if let Ok(mut children) = self.children.lock() {
            if let Some(mut child) = children.remove(&self.key) {
                let _ = child.start_kill();
            }
        }
    }
}
fn config(url: &str, token: &str, prefer: &str) -> Result<String> {
    if token.contains(['\r', '\n']) {
        return Err(WorkspaceError::new(
            "auth",
            "Microsoft returned an invalid access token.",
        ));
    }
    let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    Ok(format!(
        "url = {}\nheader = {}\nheader = {}\n",
        quote(url),
        quote(&format!("Authorization: Bearer {token}")),
        quote(&format!("Prefer: {prefer}"))
    ))
}
/// One answer from curl: its HTTP status, response headers and body.
pub(super) struct Response {
    pub status: u16,
    pub headers: String,
    pub body: Vec<u8>,
}
impl Response {
    /// Splits curl's output, the body followed by `\n%{http_code}`.
    fn framed(mut output: Vec<u8>, headers: String) -> Result<Self> {
        if output.len() < 4 || output[output.len() - 4] != b'\n' {
            return Err(WorkspaceError::new(
                "offline",
                "Microsoft read did not return a complete response.",
            ));
        }
        let status = std::str::from_utf8(&output[output.len() - 3..])
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .filter(|s| (100..=599).contains(s))
            .ok_or_else(|| {
                WorkspaceError::new("offline", "Microsoft read did not return an HTTP status.")
            })?;
        output.truncate(output.len() - 4);
        Ok(Self {
            status,
            headers,
            body: output,
        })
    }
    /// The last `Retry-After` (proxies add their own header blocks first).
    fn retry(&self) -> &str {
        self.headers
            .lines()
            .rev()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(key, _)| key.eq_ignore_ascii_case("retry-after"))
                    .map(|(_, value)| value.trim())
            })
            .unwrap_or("60")
    }
}
/// A JSON answer.
fn decode(response: &Response) -> Result<Value> {
    graph::graph_response(response.status, response.retry(), &response.body)
}
/// A text answer (a transcript's WebVTT).
fn decode_text(response: &Response) -> Result<String> {
    graph::graph_text_response(response.status, response.retry(), &response.body)
}
pub(super) fn cleanup(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name
                .strip_prefix("graph-read-")
                .and_then(|s| s.strip_suffix(".headers"))
                .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
pub(super) async fn get(
    core: &Core,
    c: &Connection,
    url: &str,
    token: &str,
    prefer: &str,
) -> Result<Value> {
    decode(&get_bytes(core, c, url, token, prefer).await?)
}
pub(super) async fn get_text(
    core: &Core,
    c: &Connection,
    url: &str,
    token: &str,
    prefer: &str,
) -> Result<String> {
    decode_text(&get_bytes(core, c, url, token, prefer).await?)
}
/// One Graph GET through `/usr/bin/curl`: the bearer goes in on stdin, never on the command
/// line, and the read stops with the job that made it.
pub(super) async fn get_bytes(
    core: &Core,
    c: &Connection,
    url: &str,
    token: &str,
    prefer: &str,
) -> Result<Response> {
    if core.stopping() {
        return Err(WorkspaceError::new("cancelled", "Microsoft reads stopped."));
    }
    let url = graph::validate_graph_url(url)?;
    let input = config(url.as_str(), token, prefer)?;
    let key = format!(
        "{}:{}",
        c.job_fence
            .as_ref()
            .map(|(id, _)| id.as_str())
            .unwrap_or("manual"),
        id()
    );
    let owned = OwnedRead {
        children: &core.graph_children,
        key: key.clone(),
    };
    let mut command = Command::new("/usr/bin/curl");
    // -q must be first: ignore user curlrc (including redirects, output files or insecure TLS options).
    command
        .args([
            "-q",
            "--silent",
            "--proto",
            "=https",
            "--connect-timeout",
            "15",
            "--max-time",
            "45",
            "--max-filesize",
            "16777216",
            "--dump-header",
            "/dev/stderr",
        ])
        .args(["--write-out", "\n%{http_code}", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = {
        let repo = core.repo()?;
        repo.validate_claim(c)?;
        graph::check_connection(&repo.connection(&c.id)?, c)?;
        command.spawn().map_err(|_| {
            WorkspaceError::new(
                "offline",
                "The macOS Microsoft read transport could not start.",
            )
        })?
    };
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| WorkspaceError::new("offline", "Microsoft read output is unavailable."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| WorkspaceError::new("offline", "Microsoft read headers are unavailable."))?;
    {
        let mut children = core.graph_children.lock().map_err(|_| {
            WorkspaceError::new("offline", "Microsoft transport needs an app restart.")
        })?;
        if core.stopping() {
            return Err(WorkspaceError::new("cancelled", "Microsoft reads stopped."));
        }
        children.insert(key.clone(), child);
    }
    core.repo()?.validate_claim(c)?;
    let result = tokio::time::timeout(Duration::from_secs(65), async {
        if let Some(mut stdin) = stdin {
            stdin.write_all(input.as_bytes()).await?;
        }
        // Drain both pipes together: headers cannot block the body; neither persists to disk.
        let mut bytes = Vec::new();
        let mut header_bytes = Vec::new();
        let mut body_pipe = stdout.take((LIMIT + 5) as u64);
        let mut header_pipe = stderr.take(131073);
        tokio::try_join!(
            body_pipe.read_to_end(&mut bytes),
            header_pipe.read_to_end(&mut header_bytes)
        )?;
        if bytes.len() > LIMIT + 4 {
            return Err(WorkspaceError::new(
                "provider",
                "Microsoft response exceeded the safe page limit.",
            ));
        }
        if header_bytes.len() > 131072 {
            return Err(WorkspaceError::new(
                "provider",
                "Microsoft response headers exceeded their safe limit.",
            ));
        }
        let status = loop {
            let status = core
                .graph_children
                .lock()
                .map_err(|_| {
                    WorkspaceError::new("offline", "Microsoft transport needs an app restart.")
                })?
                .get_mut(&key)
                .ok_or_else(|| WorkspaceError::new("cancelled", "Microsoft read stopped."))?
                .try_wait()?;
            if let Some(status) = status {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        if !status.success() {
            let message = match status.code() {
                Some(60) => {
                    "Microsoft TLS verification failed. Check the system trust and proxy settings."
                }
                Some(28) => "Microsoft read timed out. Cached data is retained.",
                _ => "Microsoft read was interrupted. Cached data is retained.",
            };
            return Err(WorkspaceError::new("offline", message));
        }
        Response::framed(bytes, String::from_utf8_lossy(&header_bytes).into_owned())
    })
    .await
    .map_err(|_| {
        WorkspaceError::new(
            "offline",
            "Microsoft read timed out. Cached data is retained.",
        )
    })?;
    drop(owned);
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn response_framing_preserves_backoff_and_never_displays_provider_error_body() {
        let framed =
            |output: &[u8], headers: &str| Response::framed(output.to_vec(), headers.to_string());
        let e = decode(
            &framed(
                b"PRIVATE_ERROR\n429",
                "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 429\r\nretry-after: 17\r\n",
            )
            .unwrap(),
        )
        .unwrap_err();
        assert_eq!(e.retry_after, Some(17));
        assert!(!e.message.contains("PRIVATE_ERROR"));
        assert_eq!(
            decode(&framed(b"{\"value\":[]}\n200", "").unwrap()).unwrap()["value"],
            serde_json::json!([])
        );
        assert!(framed(b"truncated", "").is_err());
        // Text answers share the framing and status mapping; a 403 keeps Microsoft's reason.
        assert_eq!(
            decode_text(&framed(b"WEBVTT\n\n200", "").unwrap()).unwrap(),
            "WEBVTT\n"
        );
        let e = decode_text(
            &framed(
                b"{\"error\":{\"code\":\"Forbidden\",\"message\":\"GraphAccessToTranscriptsDisabled\"}}\n403",
                "",
            )
            .unwrap(),
        )
        .unwrap_err();
        assert_eq!(e.code, "permission_required");
        assert_eq!(e.message, "Forbidden: GraphAccessToTranscriptsDisabled");
    }
    #[test]
    fn bearer_config_rejects_newline_injection() {
        assert!(config(
            "https://graph.microsoft.com/v1.0/me",
            "synthetic\nurl = evil",
            graph::PREFER
        )
        .is_err());
        let value = config(
            "https://graph.microsoft.com/v1.0/me",
            "synthetic",
            graph::PREFER,
        )
        .unwrap();
        assert!(value.contains("Authorization: Bearer synthetic"));
        // The default reads ask for no body format.
        assert!(value.contains("odata.maxpagesize=50\"\n"));
        let text = config(
            "https://graph.microsoft.com/v1.0/me/messages/1",
            "synthetic",
            graph::PREFER_TEXT_BODY,
        )
        .unwrap();
        assert!(text.contains("outlook.body-content-type=\\\"text\\\""));
        assert!(!value.contains("insecure"));
    }
}
