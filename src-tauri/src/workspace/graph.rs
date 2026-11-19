//! Native public-client Microsoft Graph session. Tokens never cross the webview boundary.
use super::{
    credentials::{self, Credential},
    models::*,
    Core,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use rand::RngCore;
use reqwest::{Client, Method};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

const GRAPH: &str = "https://graph.microsoft.com/v1.0";
/// Every read: immutable ids, UTC times, 50 items a page.
pub const PREFER: &str = "IdType=\"ImmutableId\", outlook.timezone=\"UTC\", odata.maxpagesize=50";
/// A read that asks for message bodies as plain text instead of HTML.
pub const PREFER_TEXT_BODY: &str = "IdType=\"ImmutableId\", outlook.timezone=\"UTC\", odata.maxpagesize=50, outlook.body-content-type=\"text\"";
const PROFILE_PATH: &str = "/me?$select=id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation";
const PHOTO_LIMIT: usize = 256 * 1024;
const CALENDAR_REFRESH_SECONDS: i64 = 300;
const CHAT_WINDOW_MAX_DAYS: i64 = 14;
const CHAT_SYNC_LIMIT: usize = 40;
/// Newest messages kept per Teams chat: enough for the Inbox thread and reply detection without
/// shipping every group-chat message to the window on each refresh.
pub const CHAT_KEEP_MESSAGES: i64 = 25;
const CHAT_DISCOVERY: &str =
    "/me/chats?$top=50&$orderby=lastMessagePreview/createdDateTime%20desc&$expand=lastMessagePreview";
const CHAT_MEMBERS: &str =
    "/me/chats?$top=50&$orderby=lastMessagePreview/createdDateTime%20desc&$expand=members";
const CHAT_MEMBERS_MAX_AGE: i64 = 1800;
const CALLBACK_TEMPLATE: &str = include_str!("callback.html");
const BASE_SCOPES: &[&str] = &["openid", "profile", "offline_access", "User.Read"];
pub const CAPABILITIES: &[(&str, &str)] = &[
    ("calendar", "Calendars.Read"),
    ("mail", "Mail.Read"),
    ("chats", "Chat.Read"),
    ("calendar_write", "Calendars.ReadWrite"),
    ("mail_send", "Mail.Send"),
    ("chat_send", "ChatMessage.Send"),
    // Find a Teams meeting by its join link, then list and read its transcripts (opt-in).
    ("meetings", "OnlineMeetings.Read"),
    ("transcripts", "OnlineMeetingTranscript.Read.All"),
];

#[derive(Default)]
pub struct Session {
    pub access: Option<String>,
    pub expires: i64,
    pub connection_id: Option<String>,
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
}

fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| {
            WorkspaceError::new(
                "network",
                "Cannot initialize the secure Microsoft connection.",
            )
        })
}
pub fn validate_registration(client_id: &str, tenant: &str) -> Result<()> {
    uuid::Uuid::parse_str(client_id).map_err(|_| {
        WorkspaceError::new("validation", "Microsoft application ID must be a UUID.")
    })?;
    if !matches!(tenant, "common" | "organizations" | "consumers")
        && uuid::Uuid::parse_str(tenant).is_err()
    {
        return Err(WorkspaceError::new(
            "validation",
            "Use a tenant UUID, common, organizations or consumers.",
        ));
    }
    Ok(())
}
fn authority(tenant: &str) -> String {
    format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0")
}
pub fn scope_for(cap: &str) -> Option<&'static str> {
    CAPABILITIES
        .iter()
        .find(|(c, _)| *c == cap)
        .map(|(_, s)| *s)
}
pub fn permitted(c: &Connection, cap: &str) -> bool {
    c.enabled.iter().any(|s| s == cap)
        && scope_for(cap).is_some_and(|scope| {
            c.scopes.iter().any(|s| {
                s.eq_ignore_ascii_case(scope)
                    || cap == "calendar" && s.eq_ignore_ascii_case("Calendars.ReadWrite")
                    || cap == "mail" && s.eq_ignore_ascii_case("Mail.ReadWrite")
                    || cap == "chats" && s.eq_ignore_ascii_case("Chat.ReadWrite")
                    || cap == "meetings" && s.eq_ignore_ascii_case("OnlineMeetings.ReadWrite")
            })
        })
}
/// Teams transcripts can be read: both the meeting lookup and the transcript reads are allowed.
pub fn transcripts_permitted(c: &Connection) -> bool {
    permitted(c, "meetings") && permitted(c, "transcripts")
}
/// What a background read is refreshing, for the job's progress line.
fn read_label(path: &str) -> &'static str {
    if path.contains("/mailFolders/inbox/") {
        "Outlook Inbox"
    } else if path.contains("/mailFolders/sentitems/") {
        "Outlook Sent"
    } else if path.contains("calendarView") {
        "Calendar events"
    } else if path.ends_with("/calendars") {
        "Calendar list"
    } else if path.contains("/onlineMeetings") {
        "Teams transcripts"
    } else if path.ends_with("/messages") {
        "Teams conversations"
    } else if path.ends_with("/chats") {
        "Teams chat list"
    } else {
        "Microsoft sources"
    }
}
pub fn validate_graph_url(input: &str) -> Result<Url> {
    let u = Url::parse(input)
        .map_err(|_| WorkspaceError::new("provider", "Microsoft returned an invalid page URL."))?;
    if u.scheme() != "https"
        || u.host_str() != Some("graph.microsoft.com")
        || u.port_or_known_default() != Some(443)
        || !u.username().is_empty()
        || u.password().is_some()
        || !u.path().starts_with("/v1.0/me") && !u.path().starts_with("/v1.0/chats/")
    {
        return Err(WorkspaceError::new(
            "provider",
            "Microsoft returned an unexpected resource URL.",
        ));
    }
    Ok(u)
}
fn segment(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
pub fn endpoint(path: &str) -> String {
    format!("{GRAPH}{path}")
}

impl Core {
    pub async fn graph_connect(self: &Arc<Self>, capabilities: Vec<String>) -> Result<Value> {
        if capabilities.iter().any(|s| scope_for(s).is_none()) {
            return Err(WorkspaceError::new(
                "validation",
                "Unknown Microsoft capability.",
            ));
        }
        let settings = self.repo()?.settings()?;
        validate_registration(&settings.client_id, &settings.tenant)?;
        let attempt = random();
        *self.auth_attempt.lock().await = Some(attempt.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| {
                WorkspaceError::new(
                    "auth",
                    "Cannot open a local sign-in callback. Check local firewall access.",
                )
            })?;
        let redirect = format!("http://localhost:{}", listener.local_addr()?.port());
        let verifier = random();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random();
        let mut scopes: Vec<String> = BASE_SCOPES.iter().map(|s| s.to_string()).collect();
        scopes.extend(
            capabilities
                .iter()
                .filter_map(|s| scope_for(s))
                .map(String::from),
        );
        scopes.sort();
        scopes.dedup();
        let mut auth = Url::parse(&format!("{}/authorize", authority(&settings.tenant)))
            .map_err(|_| WorkspaceError::new("auth", "Invalid authority."))?;
        auth.query_pairs_mut().extend_pairs([
            ("client_id", settings.client_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", &redirect),
            ("response_mode", "query"),
            ("scope", &scopes.join(" ")),
            ("state", &state),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("prompt", "select_account"),
        ]);
        open_url(auth.as_str())?;
        self.emit("connection:changed");
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = this
                .finish_auth(
                    listener,
                    attempt.clone(),
                    state,
                    verifier,
                    redirect,
                    settings.client_id,
                    settings.tenant,
                    capabilities,
                )
                .await;
            let mut active = this.auth_attempt.lock().await;
            if active.as_deref() == Some(&attempt) {
                *active = None;
                if let Err(e) = result {
                    *this.auth_error.lock().await = Some(e.message);
                }
            }
            drop(active);
            this.emit("connection:changed");
        });
        Ok(json!({"status":"authorizing"}))
    }
    #[allow(clippy::too_many_arguments)]
    async fn finish_auth(
        &self,
        listener: tokio::net::TcpListener,
        attempt: String,
        state: String,
        verifier: String,
        redirect: String,
        client_id: String,
        tenant: String,
        caps: Vec<String>,
    ) -> Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
        let code = loop {
            if self.auth_attempt.lock().await.as_deref() != Some(&attempt) {
                return Err(WorkspaceError::new("cancelled", "Sign-in cancelled."));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(WorkspaceError::new(
                    "auth_timeout",
                    "Sign-in timed out. Try again.",
                ));
            }
            let accepted =
                tokio::time::timeout(Duration::from_millis(400), listener.accept()).await;
            let Ok(Ok((mut socket, peer))) = accepted else {
                continue;
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let mut bytes = vec![0u8; 8192];
            let read = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut bytes)).await;
            let Ok(Ok(n)) = read else { continue };
            let request = String::from_utf8_lossy(&bytes[..n]);
            let parsed = parse_callback(&request, &state);
            let response = callback_response(parsed.is_ok(), &random());
            let _ = socket.write_all(response.as_bytes()).await;
            match parsed {
                Ok(code) => break code,
                Err(e) if e.code == "auth_denied" => return Err(e),
                Err(_) => continue,
            }
        };
        let form = [
            ("client_id", client_id.as_str()),
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("code_verifier", &verifier),
        ];
        let token = token_request(&tenant, &form).await?;
        let me = read_json(
            client()?
                .get(endpoint(PROFILE_PATH))
                .bearer_auth(&token.access_token)
                .send()
                .await,
        )
        .await?;
        let user_id = required(&me, "id", 200)?.to_string();
        // Never fails sign-in: Err keeps any previous photo, Ok(None) means the account has none.
        let photo = fetch_photo(&token.access_token).await;
        let account_key = format!("{:x}", Sha256::digest(format!("{client_id}:{user_id}")));
        let guard = self.auth_attempt.lock().await;
        if guard.as_deref() != Some(&attempt) {
            return Err(WorkspaceError::new("cancelled", "Sign-in cancelled."));
        }
        let previous = self
            .repo()?
            .connections()?
            .into_iter()
            .find(|c| c.account_key == account_key);
        let connection_id = previous.as_ref().map(|c| c.id.clone()).unwrap_or_else(id);
        let refresh = token.refresh_token.ok_or_else(|| {
            WorkspaceError::new(
                "auth",
                "Microsoft did not issue offline access. Reconnect and allow offline access.",
            )
        })?;
        credentials::save(
            &self.paths.private,
            &connection_id,
            &Credential {
                refresh,
                client_id,
                tenant,
            },
        )?;
        let mut enabled = caps;
        enabled.sort();
        enabled.dedup();
        let mut c = Connection {
            id: connection_id.clone(),
            account_key,
            display_name: "Microsoft account".into(),
            email: String::new(),
            user_id,
            generation: previous.as_ref().map(|c| c.generation + 1).unwrap_or(1),
            policy_revision: 1,
            source_revision: 0,
            scopes: token
                .scope
                .unwrap_or_default()
                .split_whitespace()
                .map(String::from)
                .collect(),
            enabled,
            status: "connected".into(),
            photo: match photo {
                Ok(photo) => photo,
                Err(_) => previous.as_ref().and_then(|c| c.photo.clone()),
            },
            ..Default::default()
        };
        apply_profile(&mut c, &me);
        {
            let mut repo = self.repo()?;
            repo.save_connection(&c)?;
            let mut settings = repo.settings()?;
            settings.active_connection = Some(connection_id.clone());
            repo.settings_update(&settings)?;
            // Sign-in is the whole setup: bind workspaces to this account with automatic sources.
            repo.auto_bind(&connection_id)?;
        }
        *self.session.lock().await = Session {
            access: Some(token.access_token),
            expires: now() + token.expires_in.unwrap_or(3600) - 90,
            connection_id: Some(connection_id),
        };
        *self.auth_error.lock().await = None;
        // Data appears right after sign-in; a failed enqueue is retried by the periodic tick.
        let _ = self.queue_sync_with(true);
        drop(guard);
        self.emit("workspace:changed");
        Ok(())
    }
    async fn access(&self, c: &Connection) -> Result<String> {
        let mut session = self.session.lock().await;
        {
            let repo = self.repo()?;
            check_connection(&repo.connection(&c.id)?, c)?;
            let policy = repo.policy(None, Some(&c.id))?;
            repo.check_policy(None, Some(&c.id), &policy)?;
        }
        if session.connection_id.as_deref() == Some(&c.id) && session.expires > now() {
            if let Some(token) = &session.access {
                return Ok(token.clone());
            }
        }
        let credential = match credentials::load(&self.paths.private, &c.id) {
            Ok(credential) => credential,
            Err(error) => {
                self.mark_needs_login(c, &error)?;
                return Err(error);
            }
        };
        let settings = self.repo()?.settings()?;
        if credential.client_id != settings.client_id || credential.tenant != settings.tenant {
            let error = WorkspaceError::new(
                "needs_login",
                "Microsoft application registration changed. Sign in again in Settings.",
            );
            self.mark_needs_login(c, &error)?;
            return Err(error);
        }
        let form = [
            ("client_id", credential.client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", credential.refresh.as_str()),
        ];
        let token = match token_request(&credential.tenant, &form).await {
            Ok(token) => token,
            Err(error) => {
                if error.code == "needs_login" {
                    self.mark_needs_login(c, &error)?;
                }
                return Err(error);
            }
        };
        let current = self.repo()?.connection(&c.id)?;
        if current.generation != c.generation
            || current.policy_revision != c.policy_revision
            || current.status != "connected"
        {
            return Err(WorkspaceError::new(
                "cancelled",
                "Connection changed during refresh.",
            ));
        }
        if let Some(refresh) = token.refresh_token {
            credentials::save(
                &self.paths.private,
                &c.id,
                &Credential {
                    refresh,
                    ..credential
                },
            )?;
        }
        *session = Session {
            access: Some(token.access_token.clone()),
            expires: now() + token.expires_in.unwrap_or(3600) - 90,
            connection_id: Some(c.id.clone()),
        };
        Ok(token.access_token)
    }
    fn mark_needs_login(&self, c: &Connection, error: &WorkspaceError) -> Result<()> {
        let mut repo = self.repo()?;
        let mut current = repo.connection(&c.id)?;
        if current.generation == c.generation && current.status == "connected" {
            current.status = "needs_login".into();
            current.sync_error = Some(error.message.clone());
            repo.save_connection(&current)?;
        }
        Ok(())
    }
    pub async fn graph_get(&self, c: &Connection, url: &str) -> Result<Value> {
        self.graph_get_prefer(c, url, PREFER).await
    }
    /// [`Core::graph_get`] with another `Prefer` header, such as [`PREFER_TEXT_BODY`].
    pub async fn graph_get_prefer(&self, c: &Connection, url: &str, prefer: &str) -> Result<Value> {
        self.graph_read(c, url, prefer, graph_response).await
    }
    /// A read whose answer is text, not JSON (a transcript's WebVTT content). Fenced, throttled
    /// and labelled like [`Core::graph_get`].
    pub async fn graph_get_text(&self, c: &Connection, url: &str) -> Result<String> {
        self.graph_read(c, url, PREFER, graph_text_response).await
    }
    /// One Graph GET: backoff, URL check, the job row's label, a token, the account fence, the
    /// transport (curl on macOS), `decode` for the answer, and the backoff Microsoft asked for.
    async fn graph_read<T>(
        &self,
        c: &Connection,
        url: &str,
        prefer: &str,
        decode: Decoder<T>,
    ) -> Result<T> {
        self.check_backoff(c)?;
        let url = validate_graph_url(url)?;
        self.note_read(c, &url)?;
        let token = self.access(c).await?;
        check_connection(&self.repo()?.connection(&c.id)?, c)?;
        #[cfg(target_os = "macos")]
        let result = super::curl::get_bytes(self, c, url.as_str(), &token, prefer)
            .await
            .and_then(|response| response.decode(decode));
        #[cfg(not(target_os = "macos"))]
        let result = read_body(
            client()?
                .get(url)
                .bearer_auth(token)
                .header("Prefer", prefer)
                .send()
                .await,
        )
        .await
        .and_then(|(status, retry, body)| decode(status, &retry, &body));
        self.remember_backoff(c, &result)?;
        result
    }
    /// Says on a job's row what its read refreshes, while its claim still holds.
    fn note_read(&self, c: &Connection, url: &Url) -> Result<()> {
        if let Some((jid, attempt)) = &c.job_fence {
            let label = read_label(url.path());
            {
                let mut r = self.repo()?;
                r.check_claim(jid, *attempt)?;
                if let Some(mut job) = r.jobs()?.into_iter().find(|j| j.id == *jid) {
                    job.result = Some(format!("Refreshing {label}…"));
                    r.save_job(&job)?;
                }
            }
            self.emit("workspace:changed");
        }
        Ok(())
    }
    pub async fn graph_post(
        &self,
        c: &Connection,
        url: &str,
        body: &Value,
        operation_id: &str,
        wid: &str,
        policy: &Value,
    ) -> Result<Value> {
        self.check_backoff(c)?;
        let url = validate_graph_url(url)?;
        let token = self.access(c).await?;
        self.repo()?.check_policy(Some(wid), Some(&c.id), policy)?;
        check_connection(&self.repo()?.connection(&c.id)?, c)?;
        let result = read_json(
            client()?
                .request(Method::POST, url)
                .bearer_auth(token)
                .header("client-request-id", operation_id)
                .json(body)
                .send()
                .await,
        )
        .await;
        self.remember_backoff(c, &result)?;
        result
    }
    fn check_backoff(&self, c: &Connection) -> Result<()> {
        self.repo()?.validate_claim(c)?;
        if self
            .repo()?
            .connection(&c.id)?
            .retry_at
            .is_some_and(|t| t > now())
        {
            return Err(WorkspaceError::new(
                "throttled",
                "Microsoft requested a pause. Refresh will resume after its retry deadline.",
            ));
        }
        Ok(())
    }
    fn remember_backoff<T>(&self, c: &Connection, result: &Result<T>) -> Result<()> {
        if let Err(error) = result {
            if let Some(seconds) = error.retry_after {
                let mut r = self.repo()?;
                let mut current = r.connection(&c.id)?;
                check_connection(&current, c)?;
                current.retry_at = Some(now() + seconds);
                r.save_connection(&current)?;
            }
        }
        Ok(())
    }
    pub async fn sync(self: &Arc<Self>, c: Connection, force: bool) -> Result<()> {
        let _serial = self.sync_lock.lock().await;
        let policy = self.repo()?.policy(None, Some(&c.id))?;
        self.repo()?.check_policy(None, Some(&c.id), &policy)?;
        let mut failures = Vec::new();
        if permitted(&c, "calendar") {
            match self
                .graph_get(
                    &c,
                    &endpoint(
                        "/me/calendars?$select=id,name,isDefaultCalendar,canEdit,color,hexColor,owner",
                    ),
                )
                .await
            {
                Ok(v) => {
                    let catalog = Record {
                        id: "calendars".into(),
                        kind: "catalog".into(),
                        connection_id: Some(c.id.clone()),
                        workspace_id: None,
                        source: "catalog".into(),
                        revision: id(),
                        updated_at: now(),
                        data: json!({"values":v["value"]}),
                    };
                    self.repo()?
                        .commit_sync(&c, "catalog", &[catalog], &[], None, false)?;
                }
                Err(e) => failures.push(e.message),
            }
        }
        if permitted(&c, "chats") {
            // One cheap request per round finds recently active chats; members refresh separately.
            if let Err(error) = self.discover_chats(&c, false).await {
                failures.push(error.message);
            } else {
                let stale = self
                    .repo()?
                    .record("catalog", "chats", Some(&c.id), None)
                    .map(|r| members_stale(&r.data, now()))
                    .unwrap_or(true);
                if stale {
                    if let Err(error) = self.refresh_chat_members(&c).await {
                        failures.push(error.message);
                    }
                }
            }
        }
        let mut calendars = Vec::new();
        let mut chats = Vec::new();
        let mut all_chats = false;
        let mut mail = false;
        let sync_days = {
            let repo = self.repo()?;
            for w in repo
                .workspaces()?
                .into_iter()
                .filter(|w| !w.archived && w.connection_id.as_deref() == Some(&c.id))
            {
                calendars.extend(repo.workspace_calendars(&w, &c.id));
                if super::repository::sources_all(&w.sources) {
                    all_chats = true;
                    mail = true;
                } else {
                    if let Some(ids) = w.sources["chats"].as_array() {
                        chats.extend(ids.iter().filter_map(Value::as_str).map(String::from));
                    }
                    mail |= w.sources["mail"].as_bool().unwrap_or(false);
                }
            }
            repo.settings()?.sync_days
        };
        let mut seen = std::collections::HashSet::new();
        calendars.retain(|cal| seen.insert(cal.clone()));
        chats.sort();
        chats.dedup();
        let (mut calendars_tried, mut calendars_done) = (0, 0);
        let mut calendar_failure: Option<String> = None;
        for cal in calendars.into_iter().take(30) {
            if !permitted(&c, "calendar") {
                break;
            }
            let key = format!("{}:{cal}", c.id);
            let recent = !force
                && self
                    .calendar_refreshed
                    .lock()
                    .ok()
                    .and_then(|done| done.get(&key).copied())
                    .is_some_and(|at| now() - at < CALENDAR_REFRESH_SECONDS);
            if recent {
                continue;
            }
            calendars_tried += 1;
            match self.sync_calendar(&c, &cal, None).await {
                Ok(()) => {
                    calendars_done += 1;
                    if let Ok(mut done) = self.calendar_refreshed.lock() {
                        done.insert(key, now());
                    }
                }
                Err(e) if e.code == "cancelled" => failures.push(e.message),
                Err(e) => {
                    calendar_failure.get_or_insert(e.message);
                }
            }
        }
        // A single shared or removed calendar (403/404) must not mark every round partial.
        if calendars_tried > 0 && calendars_done == 0 {
            if let Some(message) = calendar_failure {
                failures.push(message);
            }
        }
        if mail && permitted(&c, "mail") {
            for folder in ["inbox", "sentitems"] {
                if let Err(e) = self.sync_mail(&c, folder).await {
                    failures.push(e.message);
                }
            }
        }
        if permitted(&c, "chats") {
            let window_start = now() - 86400 * sync_days.clamp(1, CHAT_WINDOW_MAX_DAYS);
            let catalog = self
                .repo()?
                .record("catalog", "chats", Some(&c.id), None)
                .map(|r| r.data)
                .unwrap_or(Value::Null);
            let mut fetched = 0;
            for (chat_id, chat) in chat_candidates(&catalog, all_chats, &chats, window_start) {
                if fetched >= CHAT_SYNC_LIMIT {
                    break;
                }
                let preview = chat["lastMessagePreview"]["id"].as_str().unwrap_or("");
                let cursor = self
                    .repo()?
                    .cursor(&c.id, &format!("chat:{chat_id}"))?
                    .and_then(|v| parse_chat_cursor(&v));
                if !preview.is_empty() && cursor.as_ref().is_some_and(|(seen, _)| seen == preview) {
                    continue;
                }
                fetched += 1;
                let max_seen = cursor.and_then(|(_, max)| max);
                if let Err(e) = self
                    .sync_chat(&c, &chat_id, &chat, max_seen, window_start)
                    .await
                {
                    failures.push(e.message);
                }
            }
        }
        // Best effort: profile and photo never mark a round partial.
        if c.profile_at.is_none_or(|at| now() - at > 86400) {
            let _ = self.refresh_profile(&c).await;
        }
        {
            let mut repo = self.repo()?;
            repo.validate_claim(&c)?;
            repo.check_policy(None, Some(&c.id), &policy)?;
            let mut current = repo.connection(&c.id)?;
            current.sync_error = (!failures.is_empty()).then(|| failures.join(" "));
            if failures.is_empty() {
                current.last_sync = Some(now());
            }
            repo.save_connection(&current)?;
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(WorkspaceError::new("sync_partial","Some sources could not refresh. Last successful data is retained; see Microsoft settings."))
        }
    }
    async fn refresh_profile(&self, c: &Connection) -> Result<()> {
        let me = self.graph_get(c, &endpoint(PROFILE_PATH)).await?;
        if me["id"].as_str() != Some(c.user_id.as_str()) {
            return Err(WorkspaceError::new(
                "provider",
                "Microsoft returned a different profile.",
            ));
        }
        let photo = {
            let token = self.access(c).await?;
            fetch_photo(&token).await
        };
        let mut repo = self.repo()?;
        repo.validate_claim(c)?;
        let mut current = repo.connection(&c.id)?;
        check_connection(&current, c)?;
        apply_profile(&mut current, &me);
        if let Ok(photo) = photo {
            current.photo = photo;
        }
        repo.save_connection(&current)
    }
    pub async fn discover_chats(&self, c: &Connection, more: bool) -> Result<()> {
        if !permitted(c, "chats") {
            return Err(WorkspaceError::new(
                "permission_required",
                "Enable Teams read access first.",
            ));
        }
        let previous = self
            .repo()?
            .record("catalog", "chats", Some(&c.id), None)
            .ok();
        let url = if more {
            if previous.as_ref().is_none_or(|r| r.data["hasMore"] != true) {
                return Ok(());
            }
            self.repo()?
                .cursor(&c.id, "catalog:chats")?
                .ok_or_else(|| {
                    WorkspaceError::new(
                        "provider",
                        "Refresh Teams source discovery before loading more.",
                    )
                })?
        } else {
            endpoint(CHAT_DISCOVERY)
        };
        let page = self.graph_get(c, &url).await?;
        let incoming = page["value"].as_array().ok_or_else(|| {
            WorkspaceError::new(
                "provider",
                "Microsoft returned an incomplete Teams source list.",
            )
        })?;
        let mut data = previous.map(|r| r.data).unwrap_or_else(|| json!({}));
        let values = merge_chats(
            data["values"].as_array().cloned().unwrap_or_default(),
            incoming,
            false,
        );
        if values.len() > 20000 {
            return Err(WorkspaceError::new(
                "provider",
                "Teams source discovery exceeded its local limit.",
            ));
        }
        let next = page["@odata.nextLink"].as_str();
        if let Some(url) = next {
            validate_graph_url(url)?;
        }
        data["values"] = values.into();
        data["hasMore"] = next.is_some().into();
        self.repo()?
            .commit_chat_catalog(c, &chat_catalog(c, data), next)
    }
    /// Members come from a separate `$expand=members` read: Graph cannot expand both at once.
    async fn refresh_chat_members(&self, c: &Connection) -> Result<()> {
        let page = self.graph_get(c, &endpoint(CHAT_MEMBERS)).await?;
        let incoming = page["value"].as_array().ok_or_else(|| {
            WorkspaceError::new(
                "provider",
                "Microsoft returned an incomplete Teams member list.",
            )
        })?;
        let (previous, cursor) = {
            let repo = self.repo()?;
            (
                repo.record("catalog", "chats", Some(&c.id), None).ok(),
                repo.cursor(&c.id, "catalog:chats")?,
            )
        };
        let mut data = previous
            .map(|r| r.data)
            .unwrap_or_else(|| json!({"hasMore":false}));
        let mut values = merge_chats(
            data["values"].as_array().cloned().unwrap_or_default(),
            incoming,
            true,
        );
        // Recent chats Microsoft returned without members must not retrigger a refresh every round.
        for chat in values.iter_mut().take(50) {
            if !chat["members"].is_array() {
                chat["members"] = json!([]);
            }
        }
        data["values"] = values.into();
        data["membersAt"] = now().into();
        self.repo()?
            .commit_chat_catalog(c, &chat_catalog(c, data), cursor.as_deref())
    }
    async fn pages(
        &self,
        c: &Connection,
        url: String,
    ) -> Result<(Vec<Value>, Vec<String>, Option<String>)> {
        let mut next = Some(url);
        let mut values = Vec::new();
        let mut removed = Vec::new();
        let mut delta = None;
        let mut seen = std::collections::HashSet::new();
        while let Some(url) = next {
            if !seen.insert(url.clone()) || seen.len() > 200 {
                return Err(WorkspaceError::new(
                    "provider",
                    "The resource exceeds this refresh limit. Narrow selected sources.",
                ));
            }
            let page = self.graph_get(c, &url).await?;
            let items = page["value"].as_array().ok_or_else(|| {
                WorkspaceError::new(
                    "provider",
                    "Microsoft returned an incomplete resource page.",
                )
            })?;
            for item in items {
                if item.get("@removed").is_some() {
                    if let Some(id) = item["id"].as_str() {
                        removed.push(id.into());
                    }
                } else {
                    values.push(item.clone());
                }
            }
            if values.len() > 20000 {
                return Err(WorkspaceError::new(
                    "provider",
                    "The selected resource is too large. Narrow the date window.",
                ));
            }
            next = page["@odata.nextLink"].as_str().map(String::from);
            delta = page["@odata.deltaLink"]
                .as_str()
                .map(String::from)
                .or(delta);
        }
        Ok((values, removed, delta))
    }
    pub async fn sync_calendar(
        &self,
        c: &Connection,
        cal: &str,
        window: Option<(i64, i64)>,
    ) -> Result<()> {
        if !permitted(c, "calendar") {
            return Err(WorkspaceError::new(
                "permission_required",
                "Calendar reads are disabled.",
            ));
        }
        use chrono::Datelike;
        let anchor = chrono::Utc::now()
            .date_naive()
            .with_day(1)
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .ok_or_else(|| WorkspaceError::new("validation", "Invalid calendar date."))?
            .and_utc()
            .timestamp();
        let (start_at, end_at) = window.unwrap_or((anchor - 86400 * 7, anchor + 86400 * 62));
        let start = chrono::DateTime::from_timestamp(start_at, 0)
            .ok_or_else(|| WorkspaceError::new("validation", "Invalid date."))?
            .to_rfc3339();
        let end = chrono::DateTime::from_timestamp(end_at, 0)
            .ok_or_else(|| WorkspaceError::new("validation", "Invalid date."))?
            .to_rfc3339();
        let source = format!("calendar:{cal}");
        // CalendarView gives complete occurrence metadata with bounded payloads, including recurring exceptions.
        let fields="id,subject,start,end,isAllDay,isCancelled,originalStartTimeZone,originalEndTimeZone,location,organizer,webLink,onlineMeeting,bodyPreview,changeKey,type,seriesMasterId,attendees,showAs,responseStatus,isOnlineMeeting,onlineMeetingProvider,categories,importance,isOrganizer,sensitivity";
        let url=format!("{GRAPH}/me/calendars/{}/calendarView?startDateTime={}&endDateTime={}&$top=50&$select={fields}",segment(cal),segment(&start),segment(&end));
        let (items, _, _) = self.pages(c, url).await?;
        let records = items
            .into_iter()
            .map(|item| normalize_event(&c.id, &source, item))
            .collect::<Vec<_>>();
        self.repo()?.commit_calendar_round(
            c,
            &source,
            &records,
            &[],
            super::repository::CalendarRound {
                window: (start_at, end_at),
                full: true,
                cursor_key: &format!("calendarView-v2:{source}:{start_at}:{end_at}"),
                cursor: None,
            },
        )
    }
    async fn sync_mail(&self, c: &Connection, folder: &str) -> Result<()> {
        let source = format!("mail:{folder}");
        // Versioned key: an older delta link would keep omitting the newly selected fields.
        let cursor_key = format!("mail-v2:{folder}");
        let since_at = now() - 86400 * self.repo()?.settings()?.sync_days;
        let previous = self.repo()?.cursor(&c.id, &cursor_key)?;
        if previous.is_none() {
            self.repo()?.clear_cursor(&c.id, &source)?;
        }
        let since = chrono::DateTime::from_timestamp(since_at, 0)
            .ok_or_else(|| WorkspaceError::new("validation", "Invalid sync date."))?
            .to_rfc3339();
        let url=previous.clone().unwrap_or_else(||format!("{GRAPH}/me/mailFolders/{folder}/messages/delta?$top=100&$filter=receivedDateTime%20ge%20{}&$select=id,changeKey,lastModifiedDateTime,subject,bodyPreview,from,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,conversationId,isRead,webLink,internetMessageId,importance,hasAttachments,flag",segment(&since)));
        let round = self.pages(c, url).await;
        let (items, removed, cursor) = match round {
            Err(e) if e.code == "resync" => {
                self.repo()?.clear_cursor(&c.id, &cursor_key)?;
                return Err(e);
            }
            other => other?,
        };
        let records: Vec<_> = items
            .into_iter()
            .filter(|v| {
                timestamp(
                    v["receivedDateTime"]
                        .as_str()
                        .or(v["sentDateTime"].as_str())
                        .unwrap_or(""),
                ) >= since_at
            })
            .map(|v| normalize_mail(&c.id, &source, v, &c.email))
            .collect();
        let removed: Vec<_> = removed
            .iter()
            .map(|id| canonical_id(&source, "message", id))
            .collect();
        self.repo()?.commit_keyed_sync(
            c,
            &source,
            &records,
            &removed,
            cursor.as_deref(),
            previous.is_none(),
            &cursor_key,
        )
    }
    /// Incremental chat read: from the stored high-water mark (less a minute of skew) or the
    /// window start. The cursor `{previewId}|{maxLastModifiedDateTime}` lets unchanged chats skip.
    async fn sync_chat(
        &self,
        c: &Connection,
        chat_id: &str,
        chat: &Value,
        max_seen: Option<i64>,
        window_start: i64,
    ) -> Result<()> {
        let source = format!("chat:{chat_id}");
        let since_at = max_seen.map_or(window_start, |max| (max - 60).max(window_start));
        let since = rfc3339(since_at)?;
        let url=format!("{GRAPH}/chats/{}/messages?$top={CHAT_KEEP_MESSAGES}&$orderby=lastModifiedDateTime%20desc&$filter=lastModifiedDateTime%20gt%20{}",segment(chat_id),segment(&since));
        // Newest page only: older messages beyond the kept tail are never shown.
        let page = self.graph_get(c, &url).await?;
        let items = page["value"].as_array().cloned().ok_or_else(|| {
            WorkspaceError::new("provider", "Microsoft returned an incomplete Teams page.")
        })?;
        let removed: Vec<String> = Vec::new();
        let (records, newest) = chat_records(&c.id, &source, items, &c.user_id, chat);
        let removed: Vec<_> = removed
            .iter()
            .map(|id| canonical_id(&source, "message", id))
            .collect();
        let cursor = chat_cursor(
            chat["lastMessagePreview"]["id"].as_str().unwrap_or(""),
            newest.max(max_seen),
        );
        let mut repo = self.repo()?;
        repo.commit_sync(c, &source, &records, &removed, Some(&cursor), true)?;
        repo.prune_chat_messages(Some(&source), CHAT_KEEP_MESSAGES)?;
        Ok(())
    }
}

pub fn parse_callback(request: &str, state: &str) -> Result<String> {
    let first = request.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    if parts.next() != Some("GET") {
        return Err(WorkspaceError::new("auth", "Invalid callback method."));
    }
    let path = parts.next().unwrap_or("");
    if !path.starts_with("/?") || !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
        return Err(WorkspaceError::new("auth", "Invalid callback path."));
    }
    let pairs: Vec<_> =
        url::form_urlencoded::parse(path.trim_start_matches("/?").as_bytes()).collect();
    let states: Vec<_> = pairs.iter().filter(|(k, _)| k == "state").collect();
    if states.len() != 1 || !constant_equal(states[0].1.as_bytes(), state.as_bytes()) {
        return Err(WorkspaceError::new("auth", "Invalid sign-in state."));
    }
    if pairs.iter().any(|(k, _)| k == "error") {
        return Err(WorkspaceError::new(
            "auth_denied",
            "Microsoft sign-in was declined or needs administrator approval.",
        ));
    }
    let codes: Vec<_> = pairs.iter().filter(|(k, _)| k == "code").collect();
    if codes.len() != 1 || codes[0].1.is_empty() {
        return Err(WorkspaceError::new("auth", "Missing sign-in response."));
    }
    Ok(codes[0].1.to_string())
}
fn constant_equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |v, (a, b)| v | (a ^ b)) == 0
}
async fn token_request(tenant: &str, form: &[(&str, &str)]) -> Result<Token> {
    let response = client()?
        .post(format!("{}/token", authority(tenant)))
        .form(form)
        .send()
        .await
        .map_err(|_| WorkspaceError::new("offline", "Microsoft sign-in service is unavailable."))?;
    if !response.status().is_success() {
        return Err(WorkspaceError::new("needs_login","Microsoft authorization expired, was declined or requires organizational approval. Reconnect in Settings."));
    }
    response.json().await.map_err(|_| {
        WorkspaceError::new(
            "auth",
            "Microsoft returned an invalid authorization response.",
        )
    })
}
/// The most of Microsoft's own error text kept in a message.
const GRAPH_REASON_MAX: usize = 500;
/// Microsoft's `{"error":{"code","message"}}` as `"<code>: <message>"`, on one line and short.
fn graph_reason(bytes: &[u8]) -> Option<String> {
    let body: Value = serde_json::from_slice(bytes).ok()?;
    let part = |key: &str| {
        body["error"][key]
            .as_str()
            .map(|s| {
                s.chars()
                    .map(|c| if c.is_control() { ' ' } else { c })
                    .collect::<String>()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|s| !s.is_empty())
    };
    let reason = match (part("code"), part("message")) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        (Some(one), None) | (None, Some(one)) => one,
        (None, None) => return None,
    };
    Some(reason.chars().take(GRAPH_REASON_MAX).collect())
}
/// The error for a status outside 2xx. A 401 or 403 says why in Microsoft's words (a tenant
/// that turned transcripts off says so); other bodies are never shown.
fn graph_error(status: u16, retry: &str, bytes: &[u8]) -> WorkspaceError {
    let code = match status {
        401 => "needs_login",
        403 => "permission_required",
        // Gone: a deleted transcript, a removed calendar.
        404 => "not_found",
        410 => "resync",
        429 => "throttled",
        _ => "provider",
    };
    let reason = matches!(status, 401 | 403)
        .then(|| graph_reason(bytes))
        .flatten();
    let mut error = WorkspaceError::new(
        code,
        reason.unwrap_or_else(|| {
            format!(
                "Microsoft returned {status}. {}",
                if code == "throttled" {
                    format!("Retry after at least {retry} seconds.")
                } else {
                    "Check connection permissions and retry.".into()
                }
            )
        }),
    );
    if code == "throttled" {
        error.retry_after = Some(retry.parse::<i64>().unwrap_or(60).clamp(1, 3600));
    }
    error
}
/// Turns a response's status, `Retry-After` and body into a read's answer.
pub(super) type Decoder<T> = fn(u16, &str, &[u8]) -> Result<T>;
pub(super) fn graph_response(status: u16, retry: &str, bytes: &[u8]) -> Result<Value> {
    if !(200..300).contains(&status) {
        return Err(graph_error(status, retry, bytes));
    }
    if status == 202 || status == 204 {
        return Ok(json!({"accepted":true}));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| WorkspaceError::new("provider", "Microsoft returned invalid resource data."))
}
/// [`graph_response`] for a read whose answer is text: the same status mapping; text that is
/// not UTF-8 is a `provider` error.
pub(super) fn graph_text_response(status: u16, retry: &str, bytes: &[u8]) -> Result<String> {
    if !(200..300).contains(&status) {
        return Err(graph_error(status, retry, bytes));
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| WorkspaceError::new("provider", "Microsoft returned text Connect can’t read."))
}
/// A 401 or 403 body is read (a little of it) for Microsoft's reason.
const ERROR_BODY_MAX: usize = 64 * 1024;
/// The status, `Retry-After` and body of a response; a body over the page limit is refused.
async fn read_body(
    response: std::result::Result<reqwest::Response, reqwest::Error>,
) -> Result<(u16, String, Vec<u8>)> {
    let mut response = response.map_err(|error| {
        WorkspaceError::new(
            if error.is_timeout() {
                "unknown_outcome"
            } else {
                "offline"
            },
            "Microsoft request did not complete. Cached data is retained.",
        )
    })?;
    let status = response.status().as_u16();
    let retry = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("60")
        .to_string();
    let limit = match status {
        200..=299 if status != 202 && status != 204 => 16 * 1024 * 1024,
        401 | 403 => ERROR_BODY_MAX,
        _ => return Ok((status, retry, Vec::new())),
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| WorkspaceError::new("offline", "Microsoft response was interrupted."))?
    {
        if bytes.len() + chunk.len() > limit {
            if limit == ERROR_BODY_MAX {
                // Only the reason was wanted; a huge error body has none worth showing.
                return Ok((status, retry, Vec::new()));
            }
            return Err(WorkspaceError::new(
                "provider",
                "Microsoft response exceeded the safe page limit.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, retry, bytes))
}
async fn read_json(
    response: std::result::Result<reqwest::Response, reqwest::Error>,
) -> Result<Value> {
    let (status, retry, bytes) = read_body(response).await?;
    graph_response(status, &retry, &bytes)
}

pub fn timestamp(v: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(v)
        .map(|d| d.timestamp())
        .unwrap_or(0)
}
pub fn plain_html(v: &str) -> String {
    let mut output = String::new();
    let mut tag = false;
    for ch in v.chars().take(100_000) {
        match ch {
            '<' => tag = true,
            '>' => {
                tag = false;
                output.push(' ');
            }
            _ if !tag => output.push(ch),
            _ => {}
        }
    }
    output
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
}
pub fn canonical_id(source: &str, kind: &str, provider_id: &str) -> String {
    let scope = if source.starts_with("mail:") {
        "mail"
    } else {
        source
    };
    format!(
        "{:x}",
        Sha256::digest(format!("{kind}:{scope}:{provider_id}"))
    )
}
pub(super) fn check_connection(current: &Connection, expected: &Connection) -> Result<()> {
    if current.status != "connected"
        || current.generation != expected.generation
        || current.policy_revision != expected.policy_revision
    {
        return Err(WorkspaceError::new(
            "cancelled",
            "Microsoft access changed during the operation.",
        ));
    }
    Ok(())
}
fn base_record(cid: &str, source: &str, kind: &str, item: &Value, mut data: Value) -> Record {
    data["providerId"] = item["id"].clone();
    Record {
        id: canonical_id(source, kind, item["id"].as_str().unwrap_or("")),
        kind: kind.into(),
        connection_id: Some(cid.into()),
        workspace_id: None,
        source: source.into(),
        revision: item["changeKey"]
            .as_str()
            .or(item["lastModifiedDateTime"].as_str())
            .unwrap_or(item["id"].as_str().unwrap_or(""))
            .into(),
        updated_at: now(),
        data,
    }
}
fn normalize_event(cid: &str, source: &str, v: Value) -> Record {
    let start = v["start"]["dateTime"].as_str().unwrap_or("");
    let end = v["end"]["dateTime"].as_str().unwrap_or("");
    let all_attendees = v["attendees"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    // Large meetings keep the first 50 people; attendeeCount carries the full size.
    let attendees: Vec<Value> = all_attendees
        .iter()
        .take(50)
        .map(|a| {
            json!({"name":a["emailAddress"]["name"],"address":a["emailAddress"]["address"],"type":a["type"],"response":a["status"]["response"]})
        })
        .collect();
    let mut record = base_record(
        cid,
        source,
        "event",
        &v,
        json!({"title":v["subject"],"start":if start.ends_with('Z'){start.to_string()}else{format!("{start}Z")},"end":if end.ends_with('Z'){end.to_string()}else{format!("{end}Z")},"originalTimeZone":v["originalStartTimeZone"],"allDay":v["isAllDay"],"cancelled":v["isCancelled"],"location":v["location"]["displayName"],"organizer":v["organizer"]["emailAddress"],"attendees":attendees,"attendeeCount":all_attendees.len(),"showAs":v["showAs"],"response":v["responseStatus"]["response"],"isOnlineMeeting":v["isOnlineMeeting"]==true,"onlineProvider":v["onlineMeetingProvider"],"categories":v["categories"].as_array().cloned().unwrap_or_default(),"importance":v["importance"],"isOrganizer":v["isOrganizer"]==true,"private":v["sensitivity"]=="private","url":v["webLink"],"joinUrl":v["onlineMeeting"]["joinUrl"],"preview":v["bodyPreview"],"calendarId":source.trim_start_matches("calendar:"),"seriesId":v["seriesMasterId"]}),
    );
    if v["isAllDay"] == true {
        let original = v["originalStartTimeZone"].as_str().unwrap_or("UTC");
        let zone = original.parse::<chrono_tz::Tz>().ok().or_else(|| {
            original
                .parse::<windows_timezones::WindowsTimezone>()
                .ok()
                .and_then(|w| w.tzdb_id().parse::<chrono_tz::Tz>().ok())
        });
        for (key, value) in [("startDate", start), ("endDate", end)] {
            let utc = if value.ends_with('Z') {
                value.to_string()
            } else {
                format!("{value}Z")
            };
            record.data[key] = match (chrono::DateTime::parse_from_rfc3339(&utc), zone) {
                (Ok(dt), Some(zone)) => dt.with_timezone(&zone).date_naive().to_string().into(),
                _ => value.get(..10).unwrap_or(value).into(),
            };
        }
    }
    record
}
fn normalize_mail(cid: &str, source: &str, v: Value, me: &str) -> Record {
    let from = &v["from"]["emailAddress"];
    let received = v["receivedDateTime"]
        .as_str()
        .or(v["sentDateTime"].as_str())
        .unwrap_or("");
    base_record(
        cid,
        source,
        "message",
        &v,
        json!({"channel":"mail","title":v["subject"],"text":v["bodyPreview"],"from":from["name"],"fromAddress":from["address"],"to":v["toRecipients"],"cc":v["ccRecipients"],"replyTo":v["replyTo"],"at":timestamp(received),"conversationId":v["conversationId"],"isMine":from["address"].as_str().is_some_and(|address|address.eq_ignore_ascii_case(me)),"url":v["webLink"],"isRead":v["isRead"],"importance":v["importance"],"hasAttachments":v["hasAttachments"]==true,"flagged":v["flag"]["flagStatus"]=="flagged"}),
    )
}
/// Chat name as Teams shows it: the topic, else the other people in a 1:1 or group chat.
fn chat_title(chat: &Value, me: &str) -> String {
    if let Some(topic) = chat["topic"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        return topic.into();
    }
    if matches!(chat["chatType"].as_str(), Some("oneOnOne" | "group")) {
        let names: Vec<&str> = chat["members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["userId"].as_str() != Some(me))
            .filter_map(|m| m["displayName"].as_str().map(str::trim))
            .filter(|name| !name.is_empty())
            .collect();
        if !names.is_empty() {
            return names.join(", ");
        }
    }
    "Teams chat".into()
}
fn normalize_chat(cid: &str, source: &str, v: Value, me: &str, chat: &Value) -> Record {
    base_record(
        cid,
        source,
        "message",
        &v,
        json!({"channel":"chat","title":chat_title(chat, me),"chatType":chat["chatType"],"chatId":source.strip_prefix("chat:").unwrap_or(source),"text":plain_html(v["body"]["content"].as_str().unwrap_or("")),"from":v["from"]["user"]["displayName"],"fromId":v["from"]["user"]["id"],"isMine":v["from"]["user"]["id"].as_str()==Some(me),"at":timestamp(v["createdDateTime"].as_str().unwrap_or("")),"conversationId":source,"mentionsMe":v["mentions"].as_array().is_some_and(|m|m.iter().any(|m|m["mentioned"]["user"]["id"].as_str()==Some(me))),"url":v["webUrl"],"deleted":!v["deletedDateTime"].is_null()}),
    )
}
/// User messages only (system events such as "member added" are skipped), plus the newest
/// `lastModifiedDateTime` seen across every returned item for the incremental cursor.
fn chat_records(
    cid: &str,
    source: &str,
    items: Vec<Value>,
    me: &str,
    chat: &Value,
) -> (Vec<Record>, Option<i64>) {
    let mut newest: Option<i64> = None;
    let records = items
        .into_iter()
        .filter_map(|v| {
            let modified = timestamp(v["lastModifiedDateTime"].as_str().unwrap_or(""));
            if modified > 0 {
                newest = Some(newest.map_or(modified, |n| n.max(modified)));
            }
            (v["messageType"] == "message").then(|| normalize_chat(cid, source, v, me, chat))
        })
        .collect();
    (records, newest)
}
pub fn parse_chat_cursor(value: &str) -> Option<(String, Option<i64>)> {
    let (preview, max) = value.split_once('|')?;
    Some((preview.to_string(), Some(timestamp(max)).filter(|t| *t > 0)))
}
fn chat_cursor(preview: &str, max: Option<i64>) -> String {
    format!(
        "{preview}|{}",
        max.and_then(|t| rfc3339(t).ok()).unwrap_or_default()
    )
}
fn rfc3339(at: i64) -> Result<String> {
    Ok(chrono::DateTime::from_timestamp(at, 0)
        .ok_or_else(|| WorkspaceError::new("validation", "Invalid date."))?
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}
/// Chats to read this round, newest activity first: automatic sources take every catalog chat
/// whose last message is inside the window; explicit legacy chats without a preview still read.
fn chat_candidates(
    catalog: &Value,
    all: bool,
    explicit: &[String],
    window_start: i64,
) -> Vec<(String, Value)> {
    let values = catalog["values"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut ids: Vec<&str> = Vec::new();
    if all {
        ids.extend(values.iter().filter_map(|v| v["id"].as_str()));
    }
    ids.extend(explicit.iter().map(String::as_str));
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<(i64, String, Value)> = ids
        .into_iter()
        .filter(|id| !id.is_empty() && seen.insert(*id))
        .filter_map(|id| {
            let chat = values
                .iter()
                .find(|v| v["id"].as_str() == Some(id))
                .cloned()
                .unwrap_or(Value::Null);
            let at = timestamp(
                chat["lastMessagePreview"]["createdDateTime"]
                    .as_str()
                    .unwrap_or(""),
            );
            let wanted = if at > 0 {
                at >= window_start
            } else {
                explicit.iter().any(|e| e == id)
            };
            wanted.then(|| (at, id.to_string(), chat))
        })
        .collect();
    out.sort_by_key(|(at, _, _)| std::cmp::Reverse(*at));
    out.into_iter().map(|(_, id, chat)| (id, chat)).collect()
}
/// Discovery replaces a chat's fields but keeps its members; a members read only sets members.
/// Members kept per cached chat: enough for titles; replies re-read members from Graph.
const CHAT_MEMBERS_KEPT: usize = 25;
/// The cached catalog keeps only what titles, change detection and links need. Graph returns
/// full member objects (roles, tenant, history dates) that made large group chats megabytes.
fn slim_chat(item: &Value) -> Value {
    let mut chat = json!({
        "id": item["id"],
        "topic": item["topic"],
        "chatType": item["chatType"],
        "webUrl": item["webUrl"],
    });
    if item["lastMessagePreview"].is_object() {
        chat["lastMessagePreview"] = json!({
            "id": item["lastMessagePreview"]["id"],
            "createdDateTime": item["lastMessagePreview"]["createdDateTime"],
        });
    }
    if let Some(members) = item["members"].as_array() {
        chat["members"] = members
            .iter()
            .take(CHAT_MEMBERS_KEPT)
            .map(|m| json!({"userId": m["userId"], "displayName": m["displayName"]}))
            .collect::<Vec<_>>()
            .into();
        chat["memberCount"] = item["memberCount"]
            .as_u64()
            .map_or_else(|| members.len().into(), Value::from);
    }
    chat
}
fn merge_chats(values: Vec<Value>, incoming: &[Value], members_only: bool) -> Vec<Value> {
    let mut values: Vec<Value> = values.iter().map(slim_chat).collect();
    for item in incoming {
        if item["id"].as_str().is_none() {
            continue;
        }
        let item = &slim_chat(item);
        if let Some(existing) = values.iter_mut().find(|v| v["id"] == item["id"]) {
            if members_only {
                existing["members"] = item["members"].clone();
                existing["memberCount"] = item["memberCount"].clone();
            } else {
                let members = existing["members"].clone();
                let count = existing["memberCount"].clone();
                *existing = item.clone();
                if !existing["members"].is_array() && members.is_array() {
                    existing["members"] = members;
                    existing["memberCount"] = count;
                }
            }
        } else {
            values.push(item.clone());
        }
    }
    values.sort_by_key(|v| {
        std::cmp::Reverse(timestamp(
            v["lastMessagePreview"]["createdDateTime"]
                .as_str()
                .unwrap_or(""),
        ))
    });
    values
}
fn members_stale(catalog: &Value, at: i64) -> bool {
    catalog["membersAt"]
        .as_i64()
        .is_none_or(|t| at - t > CHAT_MEMBERS_MAX_AGE)
        || catalog["values"]
            .as_array()
            .is_some_and(|v| v.iter().take(50).any(|chat| !chat["members"].is_array()))
}
fn chat_catalog(c: &Connection, data: Value) -> Record {
    Record {
        id: "chats".into(),
        kind: "catalog".into(),
        connection_id: Some(c.id.clone()),
        workspace_id: None,
        source: "catalog".into(),
        revision: id(),
        updated_at: now(),
        data,
    }
}
fn apply_profile(c: &mut Connection, me: &Value) {
    let text = |key: &str| {
        me[key]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(200).collect::<String>())
    };
    if let Some(name) = text("displayName") {
        c.display_name = name;
    }
    if let Some(email) = text("mail").or_else(|| text("userPrincipalName")) {
        c.email = email;
    }
    c.given_name = text("givenName");
    c.job_title = text("jobTitle");
    c.department = text("department");
    c.office_location = text("officeLocation");
    c.profile_at = Some(now());
}
/// JPEG/PNG only, at most 256 KB raw; anything else is treated as "no photo".
pub fn photo_data_url(content_type: Option<&str>, bytes: &[u8]) -> Option<String> {
    let mime = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    if !matches!(mime.as_str(), "image/jpeg" | "image/png")
        || bytes.is_empty()
        || bytes.len() > PHOTO_LIMIT
    {
        return None;
    }
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
/// `Ok(None)`: the account has no usable photo. `Err`: transient; callers keep the previous one.
async fn fetch_photo(token: &str) -> Result<Option<String>> {
    let paths = ["/me/photos/120x120/$value", "/me/photo/$value"];
    for (index, path) in paths.iter().enumerate() {
        let url = validate_graph_url(&endpoint(path))?;
        let mut response = client()?
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| {
                WorkspaceError::new("offline", "Microsoft profile photo is unavailable.")
            })?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) || status == 204 {
            if index + 1 < paths.len() {
                continue;
            }
            return if status == 404 || status == 204 {
                Ok(None)
            } else {
                Err(WorkspaceError::new(
                    "provider",
                    "Microsoft profile photo is unavailable.",
                ))
            };
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            WorkspaceError::new("offline", "Microsoft profile photo was interrupted.")
        })? {
            if bytes.len() + chunk.len() > PHOTO_LIMIT {
                return Ok(None);
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(photo_data_url(content_type.as_deref(), &bytes));
    }
    Ok(None)
}
fn escape_html(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for ch in v.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}
/// Sign-in result page shown in the system browser. Pure: template placeholders only.
pub fn callback_page(success: bool, nonce: &str) -> String {
    let (state, title, message) = if success {
        (
            "success",
            "You're signed in",
            "CodeMie Connect is now connected to your Microsoft 365 account. You can close this tab and return to the app.",
        )
    } else {
        (
            "error",
            "Sign-in didn't complete",
            "This sign-in response was rejected. Return to CodeMie Connect and try again.",
        )
    };
    // Title and message go last so their text can never introduce another placeholder.
    CALLBACK_TEMPLATE
        .replace("{{NONCE}}", &escape_html(nonce))
        .replace("{{STATE}}", state)
        .replace("{{TITLE}}", &escape_html(title))
        .replace("{{MESSAGE}}", &escape_html(message))
}
fn callback_response(success: bool, nonce: &str) -> String {
    let body = callback_page(success, nonce);
    format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        if success { "200 OK" } else { "400 Bad Request" },
        body.len(),
        body
    )
}

pub fn open_url(url: &str) -> Result<()> {
    let parsed =
        Url::parse(url).map_err(|_| WorkspaceError::new("validation", "Invalid external link."))?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(WorkspaceError::new(
            "validation",
            "Only secure provider links can be opened.",
        ));
    }
    // A Teams link goes to the Teams app first; when nothing owns `msteams:` (Teams is not
    // installed), `open` fails and the link goes to the browser as before. Windows keeps the
    // browser: `rundll32` reports success even when no app owns the scheme, so the fallback
    // would never run.
    if !cfg!(windows) {
        if let Some(app) = teams_app_link(&parsed) {
            if launch_url(&app).is_ok() {
                return Ok(());
            }
        }
    }
    launch_url(url)
}

/// `https://teams.microsoft.com/l/…` (a meeting's join link, a chat message's link) as the
/// `msteams:/l/…` address the Teams app opens directly; `None` for any other link.
fn teams_app_link(link: &Url) -> Option<String> {
    (link.host_str() == Some("teams.microsoft.com")
        && link.port().is_none()
        && link.path().starts_with("/l/"))
    .then(|| format!("msteams:{}", &link[url::Position::BeforePath..]))
}

/// Opens an address with the system's handler (the browser, or the app that owns its scheme).
/// The address goes to it as one argument, never through a shell; callers check it first.
pub fn launch_url(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status();
    #[cfg(windows)]
    let status = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .status();
    #[cfg(not(any(target_os = "macos", windows)))]
    let status = std::process::Command::new("xdg-open").arg(url).status();
    if !status?.success() {
        return Err(WorkspaceError::new("io", "Cannot open the system browser."));
    }
    Ok(())
}
pub fn delete_secret(dir: &std::path::Path, cid: &str) -> Result<()> {
    super::credentials::delete(dir, cid)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn message_identity_includes_teams_chat_and_mail_moves_preserve_identity() {
        assert_ne!(
            canonical_id("chat:a", "message", "42"),
            canonical_id("chat:b", "message", "42")
        );
        assert_eq!(
            canonical_id("mail:inbox", "message", "immutable-id"),
            canonical_id("mail:sentitems", "message", "immutable-id")
        );
        let r = normalize_chat(
            "account",
            "chat:a",
            json!({"id":"42","body":{"content":"hi"},"createdDateTime":"2026-11-16T10:00:00Z"}),
            "me",
            &Value::Null,
        );
        assert_eq!(r.data["providerId"], "42");
        assert_eq!(r.data["title"], "Teams chat");
        assert_eq!(r.data["chatId"], "a");
    }
    #[test]
    fn cached_chats_keep_only_slim_members_and_their_true_count() {
        let big: Vec<Value> = (0..40)
            .map(|i| json!({"userId":format!("u{i}"),"displayName":format!("Person {i}"),"email":"x@example.test","roles":["owner"],"tenantId":"t"}))
            .collect();
        let incoming = vec![
            json!({"id":"c","topic":null,"chatType":"group","members":big,"lastMessagePreview":{"id":"p","createdDateTime":"2026-11-16T10:00:00Z","body":{"content":"long html"}}}),
        ];
        let merged = merge_chats(Vec::new(), &incoming, false);
        let chat = &merged[0];
        assert_eq!(chat["members"].as_array().unwrap().len(), CHAT_MEMBERS_KEPT);
        assert_eq!(chat["memberCount"], 40);
        assert!(chat["members"][0].get("email").is_none());
        assert!(chat["lastMessagePreview"].get("body").is_none());
        let again = merge_chats(
            merged.clone(),
            &[json!({"id":"c","lastMessagePreview":{"id":"q"}})],
            false,
        );
        assert_eq!(
            again[0]["memberCount"], 40,
            "count survives later discovery rounds"
        );
        assert_eq!(again[0]["lastMessagePreview"]["id"], "q");
    }
    #[test]
    fn chat_title_uses_topic_then_other_members_excluding_me() {
        let members = json!([
            {"userId":"me","displayName":"Me Myself"},
            {"userId":"u1","displayName":"Ada Lovelace"},
            {"userId":"u2","displayName":"  "},
            {"userId":"u3","displayName":"Alan Turing"}
        ]);
        let group = json!({"id":"g","chatType":"group","members":members});
        let r = normalize_chat(
            "account",
            "chat:g",
            json!({"id":"1","body":{"content":"hi"}}),
            "me",
            &group,
        );
        assert_eq!(r.data["title"], "Ada Lovelace, Alan Turing");
        assert_eq!(r.data["chatType"], "group");
        assert_eq!(r.data["chatId"], "g");
        let one = json!({"chatType":"oneOnOne","members":[{"userId":"me","displayName":"Me"}]});
        assert_eq!(chat_title(&one, "me"), "Teams chat");
        let topic = json!({"chatType":"group","topic":" Launch ","members":members});
        assert_eq!(chat_title(&topic, "me"), "Launch");
        let meeting = json!({"chatType":"meeting","members":members});
        assert_eq!(chat_title(&meeting, "me"), "Teams chat");
    }
    #[test]
    fn chat_rounds_skip_system_messages_but_advance_the_high_water_mark() {
        let items = vec![
            json!({"id":"1","messageType":"message","body":{"content":"Hello"},"lastModifiedDateTime":"2026-11-16T10:00:00Z"}),
            json!({"id":"2","messageType":"systemEventMessage","body":{"content":"<systemEventMessage/>"},"lastModifiedDateTime":"2026-11-16T11:00:00.250Z"}),
            json!({"id":"3","messageType":"unknownFutureValue","lastModifiedDateTime":"bad"}),
        ];
        let (records, newest) = chat_records("a", "chat:c", items, "me", &Value::Null);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].data["providerId"], "1");
        assert_eq!(newest, Some(timestamp("2026-11-16T11:00:00Z")));
    }
    #[test]
    fn chat_cursor_round_trips_preview_and_high_water_mark() {
        let at = timestamp("2026-11-16T11:00:00Z");
        let cursor = chat_cursor("1731754800000", Some(at));
        assert_eq!(cursor, "1731754800000|2026-11-16T11:00:00Z");
        assert_eq!(
            parse_chat_cursor(&cursor),
            Some(("1731754800000".into(), Some(at)))
        );
        assert_eq!(parse_chat_cursor("p|"), Some(("p".into(), None)));
        assert_eq!(chat_cursor("p", None), "p|");
        assert_eq!(parse_chat_cursor("legacy-without-separator"), None);
    }
    #[test]
    fn chat_candidates_follow_window_preview_order_and_legacy_selection() {
        let window = timestamp("2026-11-10T00:00:00Z");
        let catalog = json!({"values":[
            {"id":"old","lastMessagePreview":{"id":"o","createdDateTime":"2026-10-01T00:00:00Z"}},
            {"id":"recent","lastMessagePreview":{"id":"r","createdDateTime":"2026-11-15T00:00:00Z"}},
            {"id":"newest","lastMessagePreview":{"id":"n","createdDateTime":"2026-11-16T00:00:00Z"}},
            {"id":"no-preview"}
        ]});
        let ids = |all: bool, explicit: &[String]| {
            chat_candidates(&catalog, all, explicit, window)
                .into_iter()
                .map(|(id, _)| id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(true, &[]), vec!["newest", "recent"]);
        assert_eq!(
            ids(false, &["no-preview".into(), "old".into(), "recent".into()]),
            vec!["recent", "no-preview"]
        );
    }
    #[test]
    fn chat_discovery_keeps_members_and_members_refresh_only_sets_members() {
        let existing = vec![json!({"id":"a","topic":"Old","members":[{"userId":"u"}]})];
        let merged = merge_chats(
            existing,
            &[
                json!({"id":"a","topic":"New","lastMessagePreview":{"createdDateTime":"2026-11-15T00:00:00Z"}}),
                json!({"id":"b","lastMessagePreview":{"createdDateTime":"2026-11-16T00:00:00Z"}}),
            ],
            false,
        );
        assert_eq!(merged[0]["id"], "b");
        assert_eq!(merged[1]["topic"], "New");
        assert_eq!(merged[1]["members"][0]["userId"], "u");
        let merged = merge_chats(
            merged,
            &[json!({"id":"b","topic":"ignored","members":[]})],
            true,
        );
        assert_eq!(merged[0]["members"], json!([]));
        assert!(merged[0]["topic"].is_null());
        let at = now();
        assert!(members_stale(&json!({"values":merged}), at));
        let mut fresh = json!({"values":merged,"membersAt":at});
        assert!(!members_stale(&fresh, at));
        assert!(members_stale(&fresh, at + CHAT_MEMBERS_MAX_AGE + 1));
        fresh["values"][0]
            .as_object_mut()
            .unwrap()
            .remove("members");
        assert!(members_stale(&fresh, at));
    }
    #[test]
    fn event_and_mail_records_carry_presence_and_triage_fields() {
        let event = normalize_event(
            "a",
            "calendar:primary",
            json!({"id":"e","subject":"Sync","start":{"dateTime":"2026-11-16T10:00:00"},"end":{"dateTime":"2026-11-16T10:30:00"},
                "attendees":[{"type":"required","status":{"response":"accepted"},"emailAddress":{"name":"Ada","address":"ada@example.test"}}],
                "showAs":"busy","responseStatus":{"response":"organizer"},"isOnlineMeeting":true,"onlineMeetingProvider":"teamsForBusiness",
                "categories":["Blue"],"importance":"high","isOrganizer":true,"sensitivity":"private"}),
        );
        assert_eq!(
            event.data["attendees"],
            json!([{"name":"Ada","address":"ada@example.test","type":"required","response":"accepted"}])
        );
        assert_eq!(event.data["showAs"], "busy");
        assert_eq!(event.data["response"], "organizer");
        assert_eq!(event.data["isOnlineMeeting"], true);
        assert_eq!(event.data["onlineProvider"], "teamsForBusiness");
        assert_eq!(event.data["categories"], json!(["Blue"]));
        assert_eq!(event.data["importance"], "high");
        assert_eq!(event.data["isOrganizer"], true);
        assert_eq!(event.data["private"], true);
        let mail = normalize_mail(
            "a",
            "mail:inbox",
            json!({"id":"m","isRead":false,"importance":"high","hasAttachments":true,"flag":{"flagStatus":"flagged"}}),
            "me@example.test",
        );
        assert_eq!(mail.data["isRead"], false);
        assert_eq!(mail.data["importance"], "high");
        assert_eq!(mail.data["hasAttachments"], true);
        assert_eq!(mail.data["flagged"], true);
    }
    #[test]
    fn normalize_event_keeps_series_id() {
        let occurrence = normalize_event(
            "a",
            "calendar:primary",
            json!({"id":"e","subject":"Weekly sync","start":{"dateTime":"2026-11-16T10:00:00"},"end":{"dateTime":"2026-11-16T10:30:00"},
                "type":"occurrence","seriesMasterId":"series-1"}),
        );
        assert_eq!(occurrence.data["seriesId"], "series-1");
        let single = normalize_event(
            "a",
            "calendar:primary",
            json!({"id":"s","subject":"One-off","start":{"dateTime":"2026-11-16T10:00:00"},"end":{"dateTime":"2026-11-16T10:30:00"}}),
        );
        assert!(single.data["seriesId"].is_null());
    }
    #[test]
    fn graph_response_keeps_the_graph_error_on_403() {
        let body = br#"{"error":{"code":"Forbidden","message":"GraphAccessToTranscriptsDisabled: transcripts are off."}}"#;
        let e = graph_response(403, "60", body).unwrap_err();
        assert_eq!(e.code, "permission_required");
        assert_eq!(
            e.message,
            "Forbidden: GraphAccessToTranscriptsDisabled: transcripts are off."
        );
        let e = graph_text_response(401, "60", br#"{"error":{"code":"InvalidAuthenticationToken","message":"Access token is empty."}}"#).unwrap_err();
        assert_eq!(e.code, "needs_login");
        assert_eq!(
            e.message,
            "InvalidAuthenticationToken: Access token is empty."
        );
        // Only one of the two, control characters dropped, kept short.
        let e = graph_response(403, "60", br#"{"error":{"code":"Forbidden"}}"#).unwrap_err();
        assert_eq!(e.message, "Forbidden");
        let long = format!(
            r#"{{"error":{{"code":"X","message":"line\nbreak {}"}}}}"#,
            "y".repeat(2000)
        );
        let e = graph_response(403, "60", long.as_bytes()).unwrap_err();
        assert!(e.message.starts_with("X: line break y"), "{}", e.message);
        assert!(e.message.chars().count() <= 500);
        // Anything else keeps the plain message, and other statuses never show the body.
        for body in [&b"PRIVATE_PROVIDER_ERROR"[..], b"{\"error\":{}}", b""] {
            let e = graph_response(403, "60", body).unwrap_err();
            assert_eq!(
                e.message,
                "Microsoft returned 403. Check connection permissions and retry."
            );
        }
        let e = graph_response(
            503,
            "60",
            br#"{"error":{"code":"ServiceUnavailable","message":"PRIVATE"}}"#,
        )
        .unwrap_err();
        assert!(!e.message.contains("PRIVATE"));
    }
    #[test]
    fn graph_text_response_maps_statuses_like_json_reads() {
        assert_eq!(
            graph_text_response(
                200,
                "60",
                "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi ✓".as_bytes()
            )
            .unwrap(),
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi ✓"
        );
        assert_eq!(graph_text_response(204, "60", b"").unwrap(), "");
        let e = graph_text_response(200, "60", &[0xff, 0xfe, 0x00]).unwrap_err();
        assert_eq!(e.code, "provider");
        for (status, code) in [
            (403, "permission_required"),
            (410, "resync"),
            (404, "not_found"),
            (500, "provider"),
        ] {
            assert_eq!(
                graph_text_response(status, "60", b"").unwrap_err().code,
                code
            );
        }
        let e = graph_text_response(429, "17", b"").unwrap_err();
        assert_eq!((e.code.as_str(), e.retry_after), ("throttled", Some(17)));
    }
    #[test]
    fn transcript_reads_are_labelled_and_allowed() {
        assert!(
            validate_graph_url(&crate::workspace::meetings::transcripts::lookup_url(
                "https://teams.microsoft.com/l/meetup-join/x"
            ))
            .is_ok()
        );
        assert_eq!(scope_for("meetings"), Some("OnlineMeetings.Read"));
        assert_eq!(
            scope_for("transcripts"),
            Some("OnlineMeetingTranscript.Read.All")
        );
        let mut c = Connection {
            enabled: vec!["meetings".into(), "transcripts".into()],
            scopes: vec![
                "OnlineMeetings.Read".into(),
                "OnlineMeetingTranscript.Read.All".into(),
            ],
            ..Default::default()
        };
        assert!(transcripts_permitted(&c));
        c.scopes = vec![
            "OnlineMeetings.ReadWrite".into(),
            "OnlineMeetingTranscript.Read.All".into(),
        ];
        assert!(transcripts_permitted(&c), "read-write covers reading");
        c.enabled = vec!["meetings".into()];
        assert!(!transcripts_permitted(&c));
        c.enabled = vec!["meetings".into(), "transcripts".into()];
        c.scopes = vec!["OnlineMeetings.Read".into()];
        assert!(!transcripts_permitted(&c));
        assert_eq!(
            read_label("/v1.0/me/onlineMeetings/x/transcripts"),
            "Teams transcripts"
        );
        assert_eq!(
            read_label("/v1.0/me/calendars/x/calendarView"),
            "Calendar events"
        );
    }
    #[test]
    fn callback_page_escapes_text_and_binds_nonce_to_csp() {
        let page = callback_page(true, "n0nce_-");
        assert!(page.contains("nonce=\"n0nce_-\""));
        assert!(page.contains("You&#39;re signed in"));
        assert!(!page.contains("You're signed in"));
        assert!(page.contains("success"));
        assert!(!page.contains("{{"));
        let error = callback_page(false, "abc");
        assert!(error.contains("Sign-in didn&#39;t complete"));
        assert!(error.contains("error"));
        let escaped = callback_page(true, "<script>");
        assert!(!escaped.contains("<script>\""));
        assert!(escaped.contains("&lt;script&gt;"));
        let response = callback_response(false, "abc");
        assert!(response.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        assert!(response.contains("Content-Type: text/html"));
        assert!(response.contains("default-src 'none'; style-src 'nonce-abc'; script-src 'nonce-abc'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"));
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(head.contains(&format!("Content-Length: {}", body.len())));
    }
    #[test]
    fn profile_photo_is_a_bounded_jpeg_or_png_data_url() {
        assert_eq!(
            photo_data_url(Some("image/jpeg"), b"jpg").as_deref(),
            Some("data:image/jpeg;base64,anBn")
        );
        assert!(photo_data_url(Some("Image/PNG; charset=binary"), b"png")
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(photo_data_url(Some("image/svg+xml"), b"<svg/>").is_none());
        assert!(photo_data_url(None, b"jpg").is_none());
        assert!(photo_data_url(Some("image/jpeg"), &[]).is_none());
        assert!(photo_data_url(Some("image/jpeg"), &vec![0; PHOTO_LIMIT + 1]).is_none());
        let mut c = Connection {
            display_name: "Old".into(),
            email: "old@example.test".into(),
            photo: Some("data:image/png;base64,AA==".into()),
            ..Default::default()
        };
        apply_profile(
            &mut c,
            &json!({"displayName":"Ada Lovelace","givenName":"Ada","userPrincipalName":"ada@example.test","jobTitle":"Engineer","department":null,"officeLocation":" "}),
        );
        assert_eq!(c.display_name, "Ada Lovelace");
        assert_eq!(c.email, "ada@example.test");
        assert_eq!(c.given_name.as_deref(), Some("Ada"));
        assert_eq!(c.job_title.as_deref(), Some("Engineer"));
        assert!(c.department.is_none() && c.office_location.is_none());
        assert!(c.profile_at.is_some());
        assert!(c.photo.is_some());
        let json = serde_json::to_value(&c).unwrap();
        for key in [
            "givenName",
            "jobTitle",
            "department",
            "officeLocation",
            "photo",
            "profileAt",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
        let legacy: Connection = serde_json::from_value(json!({"id":"a","accountKey":"k","displayName":"QA","email":"","userId":"u","generation":1,"policyRevision":1,"scopes":[],"enabled":[],"status":"connected","lastSync":null,"syncError":null})).unwrap();
        assert!(legacy.photo.is_none() && legacy.profile_at.is_none());
    }
    #[test]
    fn callback_rejects_wrong_state_duplicates_and_paths() {
        assert_eq!(
            parse_callback("GET /?state=abc&code=x HTTP/1.1\r\n", "abc").unwrap(),
            "x"
        );
        for request in [
            "POST /?state=abc&code=x HTTP/1.1",
            "GET /else?state=abc&code=x HTTP/1.1",
            "GET /?state=wrong&code=x HTTP/1.1",
            "GET /?state=abc&state=abc&code=x HTTP/1.1",
        ] {
            assert!(parse_callback(request, "abc").is_err());
        }
    }
    #[test]
    fn paging_never_leaks_bearer_to_other_origins() {
        for url in [
            "https://evil.example/v1.0/me",
            "http://graph.microsoft.com/v1.0/me",
            "https://graph.microsoft.com.evil.test/v1.0/me",
            "https://user@graph.microsoft.com/v1.0/me",
            "https://graph.microsoft.com/beta/me",
            "https://graph.microsoft.com/v1.0/users/all",
        ] {
            assert!(validate_graph_url(url).is_err());
        }
        assert!(validate_graph_url(
            "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=opaque"
        )
        .is_ok());
    }
    #[test]
    fn provider_html_is_rendered_as_text() {
        assert_eq!(
            plain_html("<b>Review</b> &amp; approve"),
            " Review  & approve"
        );
    }
    async fn local_response(status: &str, headers: &str, body: Vec<u8>) -> Result<Value> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request).await;
            let _ = stream.write_all(header.as_bytes()).await;
            let _ = stream.write_all(&body).await;
        });
        let result = read_json(client().unwrap().get(url).send().await).await;
        server.await.unwrap();
        result
    }
    #[tokio::test]
    async fn controlled_http_maps_permissions_cursor_expiry_and_backoff_without_retaining_provider_body(
    ) {
        for (status, code) in [
            ("401 Unauthorized", "needs_login"),
            ("403 Forbidden", "permission_required"),
            ("410 Gone", "resync"),
            ("503 Unavailable", "provider"),
        ] {
            let e = local_response(status, "", b"PRIVATE_PROVIDER_ERROR".to_vec())
                .await
                .unwrap_err();
            assert_eq!(e.code, code);
            assert!(!e.message.contains("PRIVATE_PROVIDER_ERROR"));
        }
        let e = local_response("429 Too Many Requests", "Retry-After: 17\r\n", vec![])
            .await
            .unwrap_err();
        assert_eq!(e.retry_after, Some(17));
        // A 403 says why in Microsoft's words; an error body too large to be a reason is not read.
        let e = local_response(
            "403 Forbidden",
            "",
            br#"{"error":{"code":"Forbidden","message":"GraphAccessToTranscriptsDisabled"}}"#
                .to_vec(),
        )
        .await
        .unwrap_err();
        assert_eq!(e.message, "Forbidden: GraphAccessToTranscriptsDisabled");
        let e = local_response("403 Forbidden", "", vec![b' '; ERROR_BODY_MAX + 1])
            .await
            .unwrap_err();
        assert_eq!(
            e.message,
            "Microsoft returned 403. Check connection permissions and retry."
        );
    }
    #[tokio::test]
    async fn controlled_http_rejects_redirect_invalid_json_and_oversized_pages() {
        assert_eq!(
            local_response("302 Found", "Location: http://127.0.0.1:1/\r\n", vec![])
                .await
                .unwrap_err()
                .code,
            "provider"
        );
        assert_eq!(
            local_response("200 OK", "", b"invalid".to_vec())
                .await
                .unwrap_err()
                .code,
            "provider"
        );
        let e = local_response("200 OK", "", vec![b' '; 16 * 1024 * 1024 + 1])
            .await
            .unwrap_err();
        assert!(e.message.contains("page limit"));
        assert_eq!(
            local_response("202 Accepted", "", vec![]).await.unwrap()["accepted"],
            true
        );
    }
}
