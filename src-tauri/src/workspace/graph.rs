//! Native public-client Microsoft Graph session. Tokens never cross the webview boundary.
use super::{
    credentials::{self, Credential},
    models::*,
    Core,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use reqwest::{Client, Method};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const BASE_SCOPES: &[&str] = &["openid", "profile", "offline_access", "User.Read"];
pub const CAPABILITIES: &[(&str, &str)] = &[
    ("calendar", "Calendars.Read"),
    ("mail", "Mail.Read"),
    ("chats", "Chat.Read"),
    ("calendar_write", "Calendars.ReadWrite"),
    ("mail_send", "Mail.Send"),
    ("chat_send", "ChatMessage.Send"),
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
            })
        })
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
            let success = parsed.is_ok();
            let message = if success {
                "Sign-in received. You can return to CodeMie Connect."
            } else {
                "This sign-in response was rejected. Return to Connect and try again."
            };
            let nonce = random();
            let body = if success {
                format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>CodeMie Connect sign-in</title></head><body><p>{message}</p><script nonce=\"{nonce}\">history.replaceState(null,'','/complete')</script></body></html>")
            } else {
                message.into()
            };
            let response=format!("HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; script-src 'nonce-{nonce}'; base-uri 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",if success{"200 OK"}else{"400 Bad Request"},body.len(),body);
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
                .get(endpoint(
                    "/me?$select=id,displayName,mail,userPrincipalName",
                ))
                .bearer_auth(&token.access_token)
                .send()
                .await,
        )
        .await?;
        let user_id = required(&me, "id", 200)?.to_string();
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
            &self.data_dir,
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
        let c = Connection {
            id: connection_id.clone(),
            account_key,
            display_name: me["displayName"]
                .as_str()
                .unwrap_or("Microsoft account")
                .into(),
            email: me["mail"]
                .as_str()
                .or(me["userPrincipalName"].as_str())
                .unwrap_or("")
                .into(),
            user_id,
            generation: previous.map(|c| c.generation + 1).unwrap_or(1),
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
            last_sync: None,
            sync_error: None,
            retry_at: None,
            job_fence: None,
        };
        {
            let mut repo = self.repo()?;
            repo.save_connection(&c)?;
            let mut settings = repo.settings()?;
            settings.active_connection = Some(connection_id.clone());
            repo.settings_update(&settings)?;
        }
        *self.session.lock().await = Session {
            access: Some(token.access_token),
            expires: now() + token.expires_in.unwrap_or(3600) - 90,
            connection_id: Some(connection_id),
        };
        *self.auth_error.lock().await = None;
        drop(guard);
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
        let credential = match credentials::load(&self.data_dir, &c.id) {
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
                &self.data_dir,
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
        self.check_backoff(c)?;
        let url = validate_graph_url(url)?;
        if let Some((jid, attempt)) = &c.job_fence {
            let path = url.path();
            let label = if path.contains("/mailFolders/inbox/") {
                "Outlook Inbox"
            } else if path.contains("/mailFolders/sentitems/") {
                "Outlook Sent"
            } else if path.contains("calendarView") {
                "Calendar events"
            } else if path.ends_with("/calendars") {
                "Calendar list"
            } else if path.ends_with("/messages") {
                "Selected Teams conversation"
            } else if path.ends_with("/chats") {
                "Teams source list"
            } else {
                "Microsoft sources"
            };
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
        let token = self.access(c).await?;
        check_connection(&self.repo()?.connection(&c.id)?, c)?;
        #[cfg(target_os = "macos")]
        let result = super::curl::get(self, c, url.as_str(), &token).await;
        #[cfg(not(target_os = "macos"))]
        let result = read_json(
            client()?
                .get(url)
                .bearer_auth(token)
                .header(
                    "Prefer",
                    "IdType=\"ImmutableId\", outlook.timezone=\"UTC\", odata.maxpagesize=50",
                )
                .send()
                .await,
        )
        .await;
        self.remember_backoff(c, &result)?;
        result
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
    fn remember_backoff(&self, c: &Connection, result: &Result<Value>) -> Result<()> {
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
    pub async fn sync(self: &Arc<Self>, c: Connection) -> Result<()> {
        let _serial = self.sync_lock.lock().await;
        let policy = self.repo()?.policy(None, Some(&c.id))?;
        self.repo()?.check_policy(None, Some(&c.id), &policy)?;
        let mut failures = Vec::new();
        if permitted(&c, "calendar") {
            match self
                .graph_get(
                    &c,
                    &endpoint("/me/calendars?$select=id,name,isDefaultCalendar,canEdit,color"),
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
            let fresh = self
                .repo()?
                .record("catalog", "chats", Some(&c.id), None)
                .is_ok_and(|r| r.updated_at > now() - 600);
            if !fresh {
                if let Err(error) = self.discover_chats(&c, false).await {
                    failures.push(error.message);
                }
            }
        }
        let workspaces: Vec<_> = self
            .repo()?
            .workspaces()?
            .into_iter()
            .filter(|w| !w.archived && w.connection_id.as_deref() == Some(&c.id))
            .collect();
        let mut calendars = Vec::new();
        let mut chats = Vec::new();
        let mut mail = false;
        for w in workspaces {
            if let Some(ids) = w.sources["calendars"].as_array() {
                calendars.extend(ids.iter().filter_map(Value::as_str).map(String::from));
            }
            if let Some(ids) = w.sources["chats"].as_array() {
                chats.extend(ids.iter().filter_map(Value::as_str).map(String::from));
            }
            mail |= w.sources["mail"].as_bool().unwrap_or(false);
        }
        calendars.sort();
        calendars.dedup();
        chats.sort();
        chats.dedup();
        for cal in calendars.into_iter().take(30) {
            if permitted(&c, "calendar") {
                if let Err(e) = self.sync_calendar(&c, &cal, None).await {
                    failures.push(e.message);
                }
            }
        }
        if mail && permitted(&c, "mail") {
            for folder in ["inbox", "sentitems"] {
                if let Err(e) = self.sync_mail(&c, folder).await {
                    failures.push(e.message);
                }
            }
        }
        for chat in chats.into_iter().take(50) {
            if permitted(&c, "chats") {
                if let Err(e) = self.sync_chat(&c, &chat).await {
                    failures.push(e.message);
                }
            }
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
            endpoint("/me/chats?$top=20&$orderby=lastMessagePreview/createdDateTime%20desc&$expand=members")
        };
        let page = self.graph_get(c, &url).await?;
        let incoming = page["value"].as_array().ok_or_else(|| {
            WorkspaceError::new(
                "provider",
                "Microsoft returned an incomplete Teams source list.",
            )
        })?;
        let mut values = previous
            .as_ref()
            .and_then(|r| r.data["values"].as_array())
            .cloned()
            .unwrap_or_default();
        for item in incoming {
            if let Some(existing) = values.iter_mut().find(|v| v["id"] == item["id"]) {
                *existing = item.clone();
            } else {
                values.push(item.clone());
            }
        }
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
        let record = Record {
            id: "chats".into(),
            kind: "catalog".into(),
            connection_id: Some(c.id.clone()),
            workspace_id: None,
            source: "catalog".into(),
            revision: id(),
            updated_at: now(),
            data: json!({"values":values,"hasMore":next.is_some()}),
        };
        self.repo()?.commit_chat_catalog(c, &record, next)
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
        let fields="id,subject,start,end,isAllDay,isCancelled,originalStartTimeZone,originalEndTimeZone,location,organizer,webLink,onlineMeeting,bodyPreview,changeKey,type,seriesMasterId";
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
        let since_at = now() - 86400 * self.repo()?.settings()?.sync_days;
        let previous = self.repo()?.cursor(&c.id, &source)?;
        let since = chrono::DateTime::from_timestamp(since_at, 0)
            .ok_or_else(|| WorkspaceError::new("validation", "Invalid sync date."))?
            .to_rfc3339();
        let url=previous.clone().unwrap_or_else(||format!("{GRAPH}/me/mailFolders/{folder}/messages/delta?$top=100&$filter=receivedDateTime%20ge%20{}&$select=id,changeKey,lastModifiedDateTime,subject,bodyPreview,from,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,conversationId,isRead,webLink,internetMessageId",segment(&since)));
        let round = self.pages(c, url).await;
        let (items, removed, cursor) = match round {
            Err(e) if e.code == "resync" => {
                self.repo()?.clear_cursor(&c.id, &source)?;
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
        self.repo()?.commit_sync(
            c,
            &source,
            &records,
            &removed,
            cursor.as_deref(),
            previous.is_none(),
        )
    }
    async fn sync_chat(&self, c: &Connection, chat: &str) -> Result<()> {
        let source = format!("chat:{chat}");
        let since =
            chrono::DateTime::from_timestamp(now() - 86400 * self.repo()?.settings()?.sync_days, 0)
                .ok_or_else(|| WorkspaceError::new("validation", "Invalid date."))?
                .to_rfc3339();
        let url=format!("{GRAPH}/chats/{}/messages?$top=50&$orderby=lastModifiedDateTime%20desc&$filter=lastModifiedDateTime%20gt%20{}",segment(chat),segment(&since));
        let (items, removed, _) = self.pages(c, url).await?;
        let records: Vec<_> = items
            .into_iter()
            .map(|v| normalize_chat(&c.id, &source, v, &c.user_id))
            .collect();
        let removed: Vec<_> = removed
            .iter()
            .map(|id| canonical_id(&source, "message", id))
            .collect();
        self.repo()?
            .commit_sync(c, &source, &records, &removed, None, true)
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
pub(super) fn graph_response(status: u16, retry: &str, bytes: &[u8]) -> Result<Value> {
    if !(200..300).contains(&status) {
        let code = match status {
            401 => "needs_login",
            403 => "permission_required",
            410 => "resync",
            429 => "throttled",
            _ => "provider",
        };
        let mut error = WorkspaceError::new(
            code,
            format!(
                "Microsoft returned {status}. {}",
                if code == "throttled" {
                    format!("Retry after at least {retry} seconds.")
                } else {
                    "Check connection permissions and retry.".into()
                }
            ),
        );
        if code == "throttled" {
            error.retry_after = Some(retry.parse::<i64>().unwrap_or(60).clamp(1, 3600));
        }
        return Err(error);
    }
    if status == 202 || status == 204 {
        return Ok(json!({"accepted":true}));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| WorkspaceError::new("provider", "Microsoft returned invalid resource data."))
}
async fn read_json(
    response: std::result::Result<reqwest::Response, reqwest::Error>,
) -> Result<Value> {
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
    if !(200..300).contains(&status) || status == 202 || status == 204 {
        return graph_response(
            status,
            response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("60"),
            b"",
        );
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| WorkspaceError::new("offline", "Microsoft response was interrupted."))?
    {
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err(WorkspaceError::new(
                "provider",
                "Microsoft response exceeded the safe page limit.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    graph_response(status, "60", &bytes)
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
    let mut record = base_record(
        cid,
        source,
        "event",
        &v,
        json!({"title":v["subject"],"start":if start.ends_with('Z'){start.to_string()}else{format!("{start}Z")},"end":if end.ends_with('Z'){end.to_string()}else{format!("{end}Z")},"originalTimeZone":v["originalStartTimeZone"],"allDay":v["isAllDay"],"cancelled":v["isCancelled"],"location":v["location"]["displayName"],"organizer":v["organizer"]["emailAddress"],"attendees":v["attendees"],"url":v["webLink"],"joinUrl":v["onlineMeeting"]["joinUrl"],"preview":v["bodyPreview"],"calendarId":source.trim_start_matches("calendar:")}),
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
        json!({"channel":"mail","title":v["subject"],"text":v["bodyPreview"],"from":from["name"],"fromAddress":from["address"],"to":v["toRecipients"],"cc":v["ccRecipients"],"replyTo":v["replyTo"],"at":timestamp(received),"conversationId":v["conversationId"],"isMine":from["address"].as_str().is_some_and(|address|address.eq_ignore_ascii_case(me)),"url":v["webLink"]}),
    )
}
fn normalize_chat(cid: &str, source: &str, v: Value, me: &str) -> Record {
    base_record(
        cid,
        source,
        "message",
        &v,
        json!({"channel":"chat","title":"Teams conversation","text":plain_html(v["body"]["content"].as_str().unwrap_or("")),"from":v["from"]["user"]["displayName"],"fromId":v["from"]["user"]["id"],"isMine":v["from"]["user"]["id"].as_str()==Some(me),"at":timestamp(v["createdDateTime"].as_str().unwrap_or("")),"conversationId":source,"mentionsMe":v["mentions"].as_array().is_some_and(|m|m.iter().any(|m|m["mentioned"]["user"]["id"].as_str()==Some(me))),"url":v["webUrl"],"deleted":!v["deletedDateTime"].is_null()}),
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
        );
        assert_eq!(r.data["providerId"], "42");
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
