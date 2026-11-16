//! Connect-owned additive SQLite repository. No CLI or Echo configuration is migrated here.
use super::models::*;
use rusqlite::{params, Connection as Sqlite, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub struct Repository {
    db: Sqlite,
}
pub struct CalendarRound<'a> {
    pub window: (i64, i64),
    pub full: bool,
    pub cursor_key: &'a str,
    pub cursor: Option<&'a str>,
}
fn encode<T: Serialize>(v: &T) -> Result<String> {
    serde_json::to_string(v)
        .map_err(|_| WorkspaceError::new("storage", "Cannot encode workspace data."))
}
fn decode<T: DeserializeOwned>(s: String) -> Result<T> {
    serde_json::from_str(&s).map_err(|_| {
        WorkspaceError::new(
            "storage",
            "Workspace data needs recovery. The database has been retained.",
        )
    })
}

impl Repository {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Sqlite::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 1 {
            return Err(WorkspaceError::new("newer_schema", "This workspace was opened by a newer Connect version. Open that version to recover it."));
        }
        db.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, settings TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS records (id TEXT NOT NULL, kind TEXT NOT NULL, connection_id TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,kind,connection_id,workspace_id));
            CREATE INDEX IF NOT EXISTS record_scope ON records(workspace_id,connection_id,kind);
            CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, execution_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, due_at INTEGER NOT NULL, lease_until INTEGER, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due_at);
            CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT);
            CREATE TABLE IF NOT EXISTS reservation_scopes (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, scope TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cursors (connection_id TEXT NOT NULL, resource TEXT NOT NULL, cursor TEXT NOT NULL, PRIMARY KEY(connection_id,resource));
            PRAGMA user_version=1; COMMIT;")?;
        db.execute(
            "INSERT OR IGNORE INTO meta VALUES(1,0,?1)",
            [encode(&Settings::default())?],
        )?;
        let personal = Workspace {
            id: "personal".into(),
            name: "Personal".into(),
            color: "#2297f6".into(),
            archived: false,
            is_default: true,
            connection_id: None,
            revision: 0,
            access_revision: 0,
            profile_revision: 0,
            sources: json!({"calendars":[],"mail":false,"chats":[]}),
            layout: vec![
                "brief".into(),
                "focus".into(),
                "calendar".into(),
                "inbox".into(),
                "commitments".into(),
            ],
            widget_widths: json!({}),
            ai_profile: None,
        };
        db.execute(
            "INSERT OR IGNORE INTO workspaces VALUES('personal',?1)",
            [encode(&personal)?],
        )?;
        // Core holds the exclusive owner.lock before opening this repository. No old executor can survive here.
        db.execute("UPDATE jobs SET state='failed',lease_until=NULL,body=json_set(body,'$.state','failed','$.leaseUntil',NULL,'$.result','Interrupted OS/network submission; check Activity before creating a new occurrence') WHERE state='running' AND json_extract(body,'$.kind') IN ('notification','reminder','send')",[])?;
        db.execute("UPDATE jobs SET state='queued',lease_until=NULL,body=json_set(body,'$.state','queued','$.leaseUntil',NULL,'$.result','Recovered after app restart') WHERE state='running'",[])?;
        db.execute("UPDATE records SET body=json_set(body,'$.state','unknown_outcome','$.message','Interrupted during dispatch. Check the provider before creating another action.') WHERE kind='action' AND json_extract(body,'$.state')='dispatching'",[])?;
        let mut repo = Self { db };
        // Earlier builds required manual binding and source picking. Best effort: never blocks opening.
        let _ = repo.bind_default_to_active();
        // Earlier builds kept every Teams message in the window; keep each chat's newest tail.
        let _ = repo.prune_chat_messages(None, super::graph::CHAT_KEEP_MESSAGES);
        Ok(repo)
    }
    /// Upgrade on open: earlier builds required manual binding and per-workspace source picking,
    /// which no longer has any UI. Every workspace on the active connected account switches to
    /// automatic sources. Idempotent afterwards.
    pub fn bind_default_to_active(&mut self) -> Result<bool> {
        let Some(cid) = self.settings()?.active_connection else {
            return Ok(false);
        };
        if !self.connection(&cid).is_ok_and(|c| c.status == "connected") {
            return Ok(false);
        }
        Ok(self.auto_bind(&cid)? > 0)
    }
    /// The default workspace always follows the signed-in account; other live workspaces that are
    /// unbound or already on this account are bound too. All of them use automatic sources.
    /// Workspaces explicitly bound to another account keep that binding.
    pub fn auto_bind(&mut self, cid: &str) -> Result<usize> {
        let mut changed = 0;
        for mut w in self.workspaces()? {
            let same = w.connection_id.as_deref() == Some(cid);
            if same && sources_all(&w.sources) {
                continue;
            }
            let default = w.is_default || w.id == "personal";
            if !default && (w.archived || !(w.connection_id.is_none() || same)) {
                continue;
            }
            w.connection_id = Some(cid.into());
            w.sources = json!({"all":true});
            w.revision += 1;
            self.save_workspace(&w)?;
            changed += 1;
        }
        Ok(changed)
    }
    /// Keeps the newest `keep` messages of one Teams chat (or every chat when `source` is None).
    /// Messages a person acted on (decision, draft, commitment or prepared action) are kept.
    pub fn prune_chat_messages(&mut self, source: Option<&str>, keep: i64) -> Result<usize> {
        let removed = self.db.execute(
            "DELETE FROM records WHERE rowid IN (
               SELECT rowid FROM (
                 SELECT rowid, id, ROW_NUMBER() OVER (PARTITION BY connection_id, source ORDER BY CAST(json_extract(body,'$.at') AS INTEGER) DESC) AS rn
                 FROM records WHERE kind='message' AND source LIKE 'chat:%' AND (?1 IS NULL OR source=?1))
               WHERE rn > ?2
                 AND id NOT IN (SELECT id FROM records WHERE kind='decision')
                 AND id NOT IN (SELECT ifnull(json_extract(body,'$.sourceId'),'') FROM records WHERE kind IN ('draft','commitment','action')))",
            params![source, keep],
        )?;
        if removed > 0 {
            self.db
                .execute("UPDATE meta SET revision=revision+1 WHERE id=1", [])?;
        }
        Ok(removed)
    }
    /// Whether a workspace may act on a calendar: any catalog calendar for automatic sources.
    pub fn calendar_selected(&self, w: &Workspace, cid: &str, cal: &str) -> bool {
        let ids = if sources_all(&w.sources) {
            self.record("catalog", "calendars", Some(cid), None)
                .ok()
                .map(|r| r.data["values"].clone())
        } else {
            Some(w.sources["calendars"].clone())
        };
        ids.as_ref()
            .and_then(Value::as_array)
            .is_some_and(|values| {
                values
                    .iter()
                    .any(|v| v.as_str().or(v["id"].as_str()) == Some(cal))
            })
    }
    /// Calendar ids a workspace reads: every catalog calendar for automatic sources, else the
    /// legacy explicit selection. Capped at 30.
    pub fn workspace_calendars(&self, w: &Workspace, cid: &str) -> Vec<String> {
        let ids: Vec<String> = if sources_all(&w.sources) {
            self.record("catalog", "calendars", Some(cid), None)
                .ok()
                .and_then(|r| {
                    r.data["values"].as_array().map(|values| {
                        values
                            .iter()
                            .filter_map(|v| v["id"].as_str())
                            .map(String::from)
                            .collect()
                    })
                })
                .unwrap_or_default()
        } else {
            w.sources["calendars"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default()
        };
        let mut seen = std::collections::HashSet::new();
        ids.into_iter()
            .filter(|id| seen.insert(id.clone()))
            .take(30)
            .collect()
    }
    pub fn revision(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT revision FROM meta WHERE id=1", [], |r| r.get(0))?)
    }
    pub fn settings(&self) -> Result<Settings> {
        decode(
            self.db
                .query_row("SELECT settings FROM meta WHERE id=1", [], |r| r.get(0))?,
        )
    }
    pub fn workspace(&self, id: &str) -> Result<Workspace> {
        decode(
            self.db
                .query_row("SELECT body FROM workspaces WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .optional()?
                .ok_or_else(|| WorkspaceError::new("not_found", "Workspace no longer exists."))?,
        )
    }
    pub fn connection(&self, id: &str) -> Result<Connection> {
        decode(
            self.db
                .query_row("SELECT body FROM connections WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .optional()?
                .ok_or_else(|| {
                    WorkspaceError::new("needs_login", "Connect Microsoft 365 in Settings.")
                })?,
        )
    }
    pub fn connections(&self) -> Result<Vec<Connection>> {
        self.documents("SELECT body FROM connections")
    }
    pub fn workspaces(&self) -> Result<Vec<Workspace>> {
        self.documents("SELECT body FROM workspaces ORDER BY id='personal' DESC,json_extract(body,'$.name') COLLATE NOCASE")
    }
    fn documents<T: DeserializeOwned>(&self, query: &str) -> Result<Vec<T>> {
        let mut stmt = self.db.prepare(query)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter().map(decode).collect()
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let settings = self.settings()?;
        let workspaces: Vec<Workspace> = self.documents("SELECT body FROM workspaces ORDER BY id='personal' DESC,json_extract(body,'$.name') COLLATE NOCASE")?;
        let active = workspaces
            .iter()
            .find(|w| w.id == settings.active_workspace)
            .ok_or_else(|| WorkspaceError::new("storage", "Active workspace is unavailable."))?;
        let connection = settings
            .active_connection
            .as_ref()
            .and_then(|s| self.connection(s).ok());
        let visible = connection
            .as_ref()
            .filter(|c| c.status == "connected" && active.connection_id.as_ref() == Some(&c.id));
        let cid = visible.map(|c| c.id.as_str()).unwrap_or("__unavailable__");
        let mut local_stmt=self.db.prepare("SELECT id,kind,connection_id,workspace_id,source,revision,updated_at,body FROM records WHERE connection_id='' AND workspace_id=?1 ORDER BY updated_at DESC")?;
        let mut raw = local_stmt
            .query_map([&active.id], record_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut provider_stmt=self.db.prepare("SELECT id,kind,connection_id,workspace_id,source,revision,updated_at,body FROM records WHERE connection_id=?1 AND (workspace_id='' OR workspace_id=?2) AND (kind IN ('catalog','incident','action') OR (json_extract(?3,'$.all')=1 AND (source LIKE 'mail:%' OR source LIKE 'chat:%' OR source LIKE 'calendar:%')) OR (source LIKE 'mail:%' AND json_extract(?3,'$.mail')=1) OR source IN(SELECT 'chat:'||value FROM json_each(?3,'$.chats')) OR source IN(SELECT 'calendar:'||value FROM json_each(?3,'$.calendars'))) ORDER BY updated_at DESC")?;
        raw.extend(
            provider_stmt
                .query_map(
                    params![cid, active.id, encode(&active.sources)?],
                    record_row,
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?,
        );
        let mut records = Vec::new();
        for r in raw {
            if r.kind == "brief"
                && r.data.get("policy").is_some_and(|p| {
                    self.policy(Some(&active.id), active.connection_id.as_deref())
                        .ok()
                        .as_ref()
                        != Some(p)
                })
            {
                continue;
            }
            if r.kind == "brief"
                && r.data["connectionId"]
                    .as_str()
                    .is_some_and(|id| Some(id) != visible.map(|c| c.id.as_str()))
            {
                continue;
            }
            if r.connection_id.is_none()
                || visible.is_some_and(|c| source_permitted(&r, c)) && record_selected(&r, active)
            {
                records.push(r);
            }
        }
        super::inbox::project(self, active, visible, &mut records)?;
        let jobs: Vec<Job> =
            self.documents("SELECT body FROM jobs ORDER BY due_at DESC LIMIT 300")?;
        let jobs = jobs
            .into_iter()
            .filter(|j| {
                (j.workspace_id.is_none() || j.workspace_id.as_deref() == Some(&active.id))
                    && (j.connection_id.is_none() || j.connection_id.as_deref() == Some(cid))
            })
            .collect();
        let available = visible.is_some();
        Ok(Snapshot {
            revision: self.revision()?,
            workspaces,
            settings,
            connection,
            records,
            jobs,
            available,
        })
    }
    pub fn record(
        &self,
        kind: &str,
        id: &str,
        cid: Option<&str>,
        wid: Option<&str>,
    ) -> Result<Record> {
        self.db.query_row("SELECT id,kind,connection_id,workspace_id,source,revision,updated_at,body FROM records WHERE kind=?1 AND id=?2 AND connection_id=?3 AND workspace_id=?4", params![kind,id,cid.unwrap_or(""),wid.unwrap_or("")], record_row).optional()?.ok_or_else(|| WorkspaceError::new("not_found", "This item is no longer available."))
    }
    pub fn put_record(&mut self, record: &Record) -> Result<()> {
        let tx = self.db.transaction()?;
        put_record(&tx, record)?;
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn settings_update(&mut self, settings: &Settings) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE meta SET settings=?1,revision=revision+1 WHERE id=1",
            [encode(settings)?],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn save_workspace(&mut self, ws: &Workspace) -> Result<()> {
        let previous = self.workspace(&ws.id).ok();
        let scope_changed = previous.as_ref().is_some_and(|old| {
            old.sources != ws.sources
                || old.connection_id != ws.connection_id
                || old.archived != ws.archived
        });
        let mut saved = ws.clone();
        saved.access_revision =
            previous.as_ref().map(|w| w.access_revision).unwrap_or(0) + i64::from(scope_changed);
        saved.profile_revision = previous.as_ref().map(|w| w.profile_revision).unwrap_or(0)
            + i64::from(
                previous
                    .as_ref()
                    .is_some_and(|old| old.ai_profile != ws.ai_profile),
            );
        let mut connections = Vec::new();
        if scope_changed {
            for cid in previous
                .as_ref()
                .and_then(|w| w.connection_id.as_ref())
                .into_iter()
                .chain(ws.connection_id.as_ref())
            {
                if !connections.iter().any(|c: &Connection| c.id == *cid) {
                    if let Ok(mut c) = self.connection(cid) {
                        c.source_revision += 1;
                        connections.push(c);
                    }
                }
            }
        }
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO workspaces VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            params![ws.id, encode(&saved)?],
        )?;
        for c in connections {
            tx.execute(
                "UPDATE connections SET body=?2 WHERE id=?1",
                params![c.id, encode(&c)?],
            )?;
        }
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn save_connection(&mut self, c: &Connection) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO connections VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![c.id,encode(c)?])?;
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn check_request(&self, request: &Request) -> Result<bool> {
        let opid = request
            .operation_id
            .as_deref()
            .ok_or_else(|| WorkspaceError::new("validation", "An operation ID is required."))?;
        uuid::Uuid::parse_str(opid)
            .map_err(|_| WorkspaceError::new("validation", "Invalid operation ID."))?;
        use sha2::{Digest, Sha256};
        let hash = format!(
            "{:x}",
            Sha256::digest(encode(
                &json!({"op":request.op,"workspaceId":request.workspace_id,"data":request.data})
            )?)
        );
        let existing: Option<String> = self
            .db
            .query_row(
                "SELECT request_hash FROM reservations WHERE id=?1",
                [opid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            if existing != hash {
                return Err(WorkspaceError::new(
                    "conflict",
                    "This operation ID belongs to different content.",
                ));
            }
            if let Some(scope) = self
                .db
                .query_row(
                    "SELECT scope FROM reservation_scopes WHERE id=?1",
                    [opid],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                if self.request_scope(request)? != decode::<Value>(scope)? {
                    return Err(WorkspaceError::new(
                        "permission_required",
                        "This saved operation belongs to a different account or access policy.",
                    ));
                }
            }
            return Ok(false);
        }
        if request.expected_revision != Some(self.revision()?) {
            return Err(WorkspaceError::new(
                "stale_view",
                "This view changed. Refresh and review the current values before saving.",
            ));
        }
        self.db.execute(
            "INSERT INTO reservations VALUES(?1,?2,NULL)",
            params![opid, hash],
        )?;
        // Reserve a revision as well as the operation ID before any asynchronous work.
        self.db
            .execute("UPDATE meta SET revision=revision+1 WHERE id=1", [])?;
        if matches!(
            request.op,
            Operation::ActionPrepare
                | Operation::ActionConfirm
                | Operation::AiDraft
                | Operation::CalendarWindow
        ) {
            let scope = self.request_scope(request)?;
            let cid = scope["connectionId"].as_str().unwrap_or("");
            self.db.execute(
                "INSERT INTO reservation_scopes VALUES(?1,?2,?3)",
                params![opid, cid, encode(&scope)?],
            )?;
        }
        Ok(true)
    }
    fn request_scope(&self, request: &Request) -> Result<Value> {
        let s = self.settings()?;
        let cid = s.active_connection.as_deref().ok_or_else(|| {
            WorkspaceError::new(
                "needs_login",
                "The operation requires its original Microsoft connection.",
            )
        })?;
        let policy = self.policy(request.workspace_id.as_deref(), Some(cid))?;
        self.check_policy(request.workspace_id.as_deref(), Some(cid), &policy)?;
        Ok(json!({"connectionId":cid,"policy":policy}))
    }
    pub fn operation_result(&self, opid: &str) -> Result<Value> {
        let result: Option<String> =
            self.db
                .query_row("SELECT result FROM reservations WHERE id=?1", [opid], |r| {
                    r.get(0)
                })?;
        match result{Some(value)=>decode(value),None=>Err(WorkspaceError::new("in_progress","This operation is already reserved. Refresh the view and check Activity; it will not be dispatched twice."))}
    }
    pub fn finish_operation(&self, opid: &str, result: &Value) -> Result<()> {
        self.db.execute(
            "UPDATE reservations SET result=?2 WHERE id=?1",
            params![opid, encode(result)?],
        )?;
        self.db.execute(
            "INSERT OR IGNORE INTO operations VALUES(?1,?2)",
            params![opid, now()],
        )?;
        self.db.execute(
            "DELETE FROM operations WHERE created_at<?1",
            [now() - 86400 * 30],
        )?;
        Ok(())
    }
    pub fn delete_local(&mut self, kind: &str, id: &str, wid: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "DELETE FROM records WHERE id=?1 AND kind=?2 AND workspace_id=?3 AND connection_id=''",
            params![id, kind, wid],
        )?;
        if kind == "schedule" {
            tx.execute("UPDATE jobs SET state='cancelled',lease_until=NULL,body=json_set(body,'$.state','cancelled','$.leaseUntil',NULL,'$.result','Schedule removed') WHERE state IN ('queued','running') AND json_extract(body,'$.workspaceId')=?1 AND json_extract(body,'$.payload.scheduleId')=?2", params![wid,id])?;
        }
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn cursor(&self, cid: &str, resource: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT cursor FROM cursors WHERE connection_id=?1 AND resource=?2",
                params![cid, resource],
                |r| r.get(0),
            )
            .optional()?)
    }
    /// A completed resource round is committed with its cursor. Partial/failing HTTP rounds never remove good data.
    pub fn commit_sync(
        &mut self,
        c: &Connection,
        resource: &str,
        records: &[Record],
        removed: &[String],
        cursor: Option<&str>,
        reconcile: bool,
    ) -> Result<()> {
        self.commit_resource(c, resource, records, removed, cursor, reconcile, None, None)
    }
    pub fn commit_calendar_round(
        &mut self,
        c: &Connection,
        resource: &str,
        records: &[Record],
        removed: &[String],
        round: CalendarRound<'_>,
    ) -> Result<()> {
        let mut complete = records.to_vec();
        complete.push(Record {
            id: super::graph::canonical_id(
                resource,
                "calendar_window",
                &format!("{}:{}", round.window.0, round.window.1),
            ),
            kind: "calendar_window".into(),
            connection_id: Some(c.id.clone()),
            workspace_id: None,
            source: resource.into(),
            revision: id(),
            updated_at: now(),
            data: json!({"start":round.window.0,"end":round.window.1}),
        });
        self.commit_resource(
            c,
            resource,
            &complete,
            removed,
            round.cursor,
            round.full,
            Some(round.window),
            Some(round.cursor_key),
        )
    }
    #[cfg(test)]
    pub fn commit_calendar_sync(
        &mut self,
        c: &Connection,
        resource: &str,
        records: &[Record],
        removed: &[String],
        cursor: Option<&str>,
        range: Option<(i64, i64)>,
    ) -> Result<()> {
        self.commit_resource(
            c,
            resource,
            records,
            removed,
            cursor,
            range.is_some(),
            range,
            None,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn commit_resource(
        &mut self,
        c: &Connection,
        resource: &str,
        records: &[Record],
        removed: &[String],
        cursor: Option<&str>,
        reconcile: bool,
        range: Option<(i64, i64)>,
        cursor_resource: Option<&str>,
    ) -> Result<()> {
        let current = self.connection(&c.id)?;
        self.validate_claim(c)?;
        if current.generation != c.generation
            || current.policy_revision != c.policy_revision
            || current.source_revision != c.source_revision
            || current.status != "connected"
            || self.settings()?.active_connection.as_deref() != Some(&c.id)
        {
            return Err(WorkspaceError::new(
                "cancelled",
                "Connection policy changed during sync.",
            ));
        }
        let tx = self.db.transaction()?;
        if reconcile {
            if let Some((start, end)) = range {
                tx.execute("DELETE FROM records WHERE connection_id=?1 AND source=?2 AND kind='event' AND CAST(strftime('%s',json_extract(body,'$.start')) AS INTEGER) < ?4 AND CAST(strftime('%s',json_extract(body,'$.end')) AS INTEGER) > ?3",params![c.id,resource,start,end])?;
            } else {
                tx.execute("DELETE FROM records WHERE connection_id=?1 AND source=?2 AND kind IN ('event','message') AND EXISTS(SELECT 1 FROM records d WHERE d.kind='decision' AND d.connection_id=records.connection_id AND d.id=records.id AND json_extract(d.body,'$.lifecycle') IN ('archived','resolved')) AND NOT EXISTS(SELECT 1 FROM workspaces w WHERE json_extract(w.body,'$.connectionId')=records.connection_id AND ((json_extract(w.body,'$.sources.all')=1 AND (records.source LIKE 'mail:%' OR records.source LIKE 'chat:%' OR records.source LIKE 'calendar:%')) OR (records.source LIKE 'mail:%' AND json_extract(w.body,'$.sources.mail')=1) OR records.source IN(SELECT 'chat:'||value FROM json_each(w.body,'$.sources.chats'))) AND NOT EXISTS(SELECT 1 FROM records own WHERE own.kind='decision' AND own.id=records.id AND own.connection_id=records.connection_id AND own.workspace_id=w.id AND json_extract(own.body,'$.lifecycle') IN ('archived','resolved')))",params![c.id,resource])?;
            }
        }
        for id in removed {
            if let Some((start, end)) = range {
                tx.execute("DELETE FROM records WHERE connection_id=?1 AND source=?2 AND id=?3 AND kind='event' AND CAST(strftime('%s',json_extract(body,'$.start')) AS INTEGER) < ?5 AND CAST(strftime('%s',json_extract(body,'$.end')) AS INTEGER) > ?4",params![c.id,resource,id,start,end])?;
            } else {
                tx.execute("UPDATE records SET body=json_set(body,'$.unavailable',json('true')) WHERE connection_id=?1 AND source=?2 AND id=?3 AND kind='message'",params![c.id,resource,id])?;
            }
        }
        for r in records {
            put_record(&tx, r)?;
        }
        if let Some(key) = cursor_resource {
            tx.execute(
                "DELETE FROM cursors WHERE connection_id=?1 AND resource=?2",
                params![c.id, key],
            )?;
        }
        if let Some(cursor) = cursor {
            tx.execute("INSERT INTO cursors VALUES(?1,?2,?3) ON CONFLICT(connection_id,resource) DO UPDATE SET cursor=excluded.cursor",params![c.id,cursor_resource.unwrap_or(resource),cursor])?;
        }
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn commit_chat_catalog(
        &mut self,
        c: &Connection,
        record: &Record,
        next: Option<&str>,
    ) -> Result<()> {
        self.commit_resource(
            c,
            "catalog",
            std::slice::from_ref(record),
            &[],
            next,
            false,
            None,
            Some("catalog:chats"),
        )
    }
    /// Mail delta round whose cursor lives under a versioned key, so a changed `$select` starts a
    /// fresh delta instead of continuing an old link that omits the new fields.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_keyed_sync(
        &mut self,
        c: &Connection,
        resource: &str,
        records: &[Record],
        removed: &[String],
        cursor: Option<&str>,
        reconcile: bool,
        cursor_key: &str,
    ) -> Result<()> {
        self.commit_resource(
            c,
            resource,
            records,
            removed,
            cursor,
            reconcile,
            None,
            Some(cursor_key),
        )
    }
    pub fn clear_cursor(&self, cid: &str, resource: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM cursors WHERE connection_id=?1 AND resource=?2",
            params![cid, resource],
        )?;
        Ok(())
    }
    pub fn clear_cursor_prefix(&self, cid: &str, prefix: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM cursors WHERE connection_id=?1 AND substr(resource,1,length(?2))=?2",
            params![cid, prefix],
        )?;
        Ok(())
    }
    pub fn purge_connection(&mut self, cid: &str, retain: bool) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute("DELETE FROM reservations WHERE id IN(SELECT id FROM reservation_scopes WHERE connection_id=?1)",[cid])?;
        tx.execute(
            "DELETE FROM reservation_scopes WHERE connection_id=?1",
            [cid],
        )?;
        if !retain {
            tx.execute("DELETE FROM records WHERE connection_id=?1", [cid])?;
            tx.execute(
                "DELETE FROM records WHERE kind='brief' AND json_extract(body,'$.connectionId')=?1",
                [cid],
            )?;
        }
        tx.execute("DELETE FROM cursors WHERE connection_id=?1", [cid])?;
        tx.execute("UPDATE jobs SET state='cancelled',body=json_set(body,'$.state','cancelled','$.result','Disconnected') WHERE json_extract(body,'$.connectionId')=?1 AND state IN ('queued','running')",[cid])?;
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn enqueue(&mut self, job: &Job) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO jobs VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                job.id,
                job.key,
                job.state,
                job.due_at,
                job.lease_until,
                encode(job)?
            ],
        )?;
        Ok(())
    }
    pub fn commit_incident(&mut self, incident: &Record, jobs: &[Job]) -> Result<()> {
        let tx = self.db.transaction()?;
        put_record(&tx, incident)?;
        for job in jobs {
            tx.execute(
                "INSERT OR IGNORE INTO jobs VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    job.id,
                    job.key,
                    job.state,
                    job.due_at,
                    job.lease_until,
                    encode(job)?
                ],
            )?;
        }
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn defer_claim(&mut self, job: &Job, due: i64) -> Result<()> {
        self.check_claim(&job.id, job.attempts)?;
        let mut deferred = job.clone();
        deferred.state = "queued".into();
        deferred.due_at = due;
        deferred.lease_until = None;
        deferred.result = Some("Deferred by global incident snooze".into());
        self.save_job(&deferred)
    }
    pub fn jobs(&self) -> Result<Vec<Job>> {
        self.documents("SELECT body FROM jobs ORDER BY due_at")
    }
    pub fn local_records(&self, wid: &str, kind: &str) -> Result<Vec<Record>> {
        let mut stmt=self.db.prepare("SELECT id,kind,connection_id,workspace_id,source,revision,updated_at,body FROM records WHERE workspace_id=?1 AND kind=?2 AND connection_id='' ORDER BY updated_at DESC")?;
        let rows = stmt
            .query_map(params![wid, kind], record_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn provider_records(&self, cid: &str, kind: &str) -> Result<Vec<Record>> {
        let mut stmt=self.db.prepare("SELECT id,kind,connection_id,workspace_id,source,revision,updated_at,body FROM records WHERE connection_id=?1 AND kind=?2 AND workspace_id='' ORDER BY updated_at DESC")?;
        let rows = stmt
            .query_map(params![cid, kind], record_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn account_workspace_records(&self, cid: &str, wid: &str) -> Result<Vec<Record>> {
        let workspace = self.workspace(wid)?;
        let mut stmt=self.db.prepare("SELECT id,kind,connection_id,workspace_id,source,revision,updated_at,body FROM records WHERE connection_id=?1 AND (workspace_id='' OR workspace_id=?2) AND (kind IN ('catalog','incident','action','decision') OR (json_extract(?3,'$.all')=1 AND (source LIKE 'mail:%' OR source LIKE 'chat:%' OR source LIKE 'calendar:%')) OR (source LIKE 'mail:%' AND json_extract(?3,'$.mail')=1) OR source IN(SELECT 'chat:'||value FROM json_each(?3,'$.chats')) OR source IN(SELECT 'calendar:'||value FROM json_each(?3,'$.calendars'))) ORDER BY updated_at DESC")?;
        let records = stmt
            .query_map(params![cid, wid, encode(&workspace.sources)?], record_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(records)
    }
    pub fn save_job(&mut self, job: &Job) -> Result<()> {
        self.db.execute(
            "UPDATE jobs SET state=?2,due_at=?3,lease_until=?4,body=?5 WHERE id=?1",
            params![job.id, job.state, job.due_at, job.lease_until, encode(job)?],
        )?;
        Ok(())
    }
    /// Keep a local job result and its terminal state on the same crash boundary.
    /// The caller validates claim/policy while holding the repository guard.
    pub fn commit_job_record(&mut self, job: &Job, record: &Record) -> Result<()> {
        self.check_claim(&job.id, job.attempts)?;
        let mut done = job.clone();
        done.state = "succeeded".into();
        done.lease_until = None;
        done.result = Some(
            if record.kind == "draft" {
                "AI draft ready for review"
            } else {
                "Daily brief updated"
            }
            .into(),
        );
        let tx = self.db.transaction()?;
        put_record(&tx, record)?;
        tx.execute(
            "UPDATE jobs SET state='succeeded',lease_until=NULL,body=?2 WHERE id=?1",
            params![job.id, encode(&done)?],
        )?;
        bump(&tx)?;
        tx.commit()?;
        Ok(())
    }
    #[cfg(test)]
    pub fn claim(&mut self, at: i64) -> Result<Option<Job>> {
        self.claim_ready(at, true)
    }
    pub fn claim_ready(&mut self, at: i64, allow_sync: bool) -> Result<Option<Job>> {
        let tx = self.db.transaction()?;
        // Ambiguous OS/network dispatch is never automatically repeated after a crash.
        tx.execute("UPDATE jobs SET state='failed',body=json_set(body,'$.state','failed','$.result','Interrupted after dispatch; check Activity before retrying') WHERE state='running' AND lease_until<?1 AND json_extract(body,'$.kind') IN ('send','notification','reminder')",[at])?;
        tx.execute("UPDATE jobs SET state='queued',body=json_set(body,'$.state','queued','$.leaseUntil',NULL) WHERE state='running' AND lease_until<?1",[at])?;
        let raw: Option<String> = tx
            .query_row(
                "SELECT body FROM jobs WHERE state='queued' AND due_at<=?1 AND (?2 OR json_extract(body,'$.kind')!='sync') AND (json_extract(body,'$.kind')!='calendar_window' OR NOT EXISTS(SELECT 1 FROM jobs busy WHERE busy.state='running' AND busy.lease_until>=?1 AND json_extract(busy.body,'$.kind')='calendar_window')) AND (json_extract(body,'$.kind')!='ai_draft' OR NOT EXISTS(SELECT 1 FROM jobs busy WHERE busy.state='running' AND busy.lease_until>=?1 AND json_extract(busy.body,'$.kind')='ai_draft')) ORDER BY CASE WHEN json_extract(body,'$.kind') IN ('notification','reminder') THEN 0 ELSE 1 END,due_at LIMIT 1",
                params![at,allow_sync],
                |r| r.get(0),
            )
            .optional()?;
        let mut job = match raw {
            Some(v) => decode::<Job>(v)?,
            None => {
                tx.commit()?;
                return Ok(None);
            }
        };
        job.state = "running".into();
        job.attempts += 1;
        job.lease_until = Some(at + 300);
        tx.execute(
            "UPDATE jobs SET state='running',lease_until=?2,body=?3 WHERE id=?1 AND state='queued'",
            params![job.id, job.lease_until, encode(&job)?],
        )?;
        tx.commit()?;
        Ok(Some(job))
    }
    pub fn policy(&self, wid: Option<&str>, cid: Option<&str>) -> Result<Value> {
        let w = wid.map(|s| self.workspace(s)).transpose()?;
        let c = cid.map(|s| self.connection(s)).transpose()?;
        Ok(
            json!({"workspaceRevision":w.as_ref().map(|w|w.access_revision),"generation":c.as_ref().map(|c|c.generation),"policyRevision":c.as_ref().map(|c|c.policy_revision),"sourceRevision":if wid.is_none(){c.as_ref().map(|c|c.source_revision)}else{None}}),
        )
    }
    pub fn validate_claim(&self, c: &Connection) -> Result<()> {
        if self.settings()?.active_connection.as_deref() != Some(&c.id) {
            return Err(WorkspaceError::new(
                "cancelled",
                "The active Microsoft account changed.",
            ));
        }
        if let Some((id, attempt)) = &c.job_fence {
            self.check_claim(id, *attempt)?;
            let job = self
                .jobs()?
                .into_iter()
                .find(|j| j.id == *id)
                .ok_or_else(|| WorkspaceError::new("cancelled", "Job no longer exists."))?;
            self.check_policy(
                job.workspace_id.as_deref(),
                job.connection_id.as_deref(),
                &job.policy,
            )?;
        }
        Ok(())
    }
    pub fn ai_job_source(&self, job: &Job) -> Result<Record> {
        self.check_claim(&job.id, job.attempts)?;
        self.check_policy(
            job.workspace_id.as_deref(),
            job.connection_id.as_deref(),
            &job.policy,
        )?;
        let wid = job
            .workspace_id
            .as_deref()
            .ok_or_else(|| WorkspaceError::new("cancelled", "Missing AI workspace."))?;
        let cid = job
            .connection_id
            .as_deref()
            .ok_or_else(|| WorkspaceError::new("cancelled", "Missing AI account."))?;
        let w = self.workspace(wid)?;
        let c = self.connection(cid)?;
        if w.profile_revision != job.payload["profileRevision"].as_i64().unwrap_or(-1)
            || w.ai_profile.as_deref() != job.payload["profile"].as_str()
        {
            return Err(WorkspaceError::new(
                "cancelled",
                "The queued AI profile changed.",
            ));
        }
        let source = self.record(
            "message",
            required(&job.payload["request"], "sourceId", 2000)?,
            Some(cid),
            None,
        )?;
        if !source_available(&source)
            || source.revision != job.payload["sourceRevision"].as_str().unwrap_or("")
            || !record_selected(&source, &w)
            || !source_permitted(&source, &c)
        {
            return Err(WorkspaceError::new(
                "cancelled",
                "The queued AI source changed.",
            ));
        }
        Ok(source)
    }
    pub fn check_claim(&self, id: &str, attempt: i64) -> Result<()> {
        let valid:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND state='running' AND lease_until>=?2 AND json_extract(body,'$.attempts')=?3)",params![id,now(),attempt],|r|r.get(0))?;
        if !valid {
            return Err(WorkspaceError::new(
                "cancelled",
                "The job claim is no longer active.",
            ));
        }
        Ok(())
    }
    pub fn check_policy(&self, wid: Option<&str>, cid: Option<&str>, policy: &Value) -> Result<()> {
        if self.policy(wid, cid)? != *policy {
            return Err(WorkspaceError::new(
                "cancelled",
                "Access or source selection changed.",
            ));
        }
        if let Some(wid) = wid {
            let w = self.workspace(wid)?;
            if w.archived {
                return Err(WorkspaceError::new(
                    "archived",
                    "Restore this workspace before running actions.",
                ));
            }
        }
        if let Some(cid) = cid {
            let s = self.settings()?;
            let c = self.connection(cid)?;
            if c.status != "connected" || s.active_connection.as_deref() != Some(cid) {
                return Err(WorkspaceError::new(
                    "needs_login",
                    "This Microsoft connection is unavailable.",
                ));
            }
            if let Some(wid) = wid {
                if self.workspace(wid)?.connection_id.as_deref() != Some(cid) {
                    return Err(WorkspaceError::new(
                        "permission_required",
                        "This workspace is bound to another account.",
                    ));
                }
            }
        }
        Ok(())
    }
}
fn bump(tx: &Transaction<'_>) -> Result<()> {
    tx.execute("UPDATE meta SET revision=revision+1 WHERE id=1", [])?;
    Ok(())
}
fn put_record(tx: &Transaction<'_>, r: &Record) -> Result<()> {
    tx.execute("INSERT INTO records VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id,kind,connection_id,workspace_id) DO UPDATE SET source=excluded.source,revision=excluded.revision,updated_at=excluded.updated_at,body=excluded.body",params![r.id,r.kind,r.connection_id.as_deref().unwrap_or(""),r.workspace_id.as_deref().unwrap_or(""),r.source,r.revision,r.updated_at,encode(&r.data)?])?;
    Ok(())
}
fn record_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Record> {
    let cid: String = row.get(2)?;
    let wid: String = row.get(3)?;
    let body: String = row.get(7)?;
    Ok(Record {
        id: row.get(0)?,
        kind: row.get(1)?,
        connection_id: (!cid.is_empty()).then_some(cid),
        workspace_id: (!wid.is_empty()).then_some(wid),
        source: row.get(4)?,
        revision: row.get(5)?,
        updated_at: row.get(6)?,
        data: serde_json::from_str(&body).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(e))
        })?,
    })
}
/// Automatic sources (`{"all":true}`): every catalog calendar, Outlook mail and recent Teams chats.
pub fn sources_all(sources: &Value) -> bool {
    sources["all"] == true
}
/// A legacy explicit selection with nothing ticked (or no selection at all).
pub fn sources_empty(sources: &Value) -> bool {
    !sources_all(sources)
        && sources["calendars"].as_array().is_none_or(|a| a.is_empty())
        && sources["chats"].as_array().is_none_or(|a| a.is_empty())
        && sources["mail"] != true
}
pub fn record_selected(r: &Record, w: &Workspace) -> bool {
    if r.workspace_id.as_deref() == Some(&w.id) && (r.connection_id.is_none() || r.kind == "action")
    {
        return true;
    }
    if r.kind == "catalog" {
        return true;
    }
    if sources_all(&w.sources)
        && (r.source.starts_with("calendar:")
            || r.source.starts_with("chat:")
            || r.source.starts_with("mail:"))
    {
        return true;
    }
    if r.source.starts_with("calendar:") {
        return w.sources["calendars"].as_array().is_some_and(|a| {
            a.iter()
                .any(|v| v.as_str() == r.source.strip_prefix("calendar:"))
        });
    }
    if r.source.starts_with("chat:") {
        return w.sources["chats"].as_array().is_some_and(|a| {
            a.iter()
                .any(|v| v.as_str() == r.source.strip_prefix("chat:"))
        });
    }
    if r.source.starts_with("mail:") {
        return w.sources["mail"].as_bool().unwrap_or(false);
    }
    matches!(r.kind.as_str(), "incident" | "action")
}
pub fn source_available(record: &Record) -> bool {
    record.data["unavailable"] != true && record.data["deleted"] != true
}
pub fn source_permitted(r: &Record, c: &Connection) -> bool {
    if r.kind == "catalog" && r.id == "chats" {
        return super::graph::permitted(c, "chats");
    }
    if r.kind == "catalog" && r.id == "calendars" {
        return super::graph::permitted(c, "calendar");
    }
    if r.source.starts_with("calendar:") {
        super::graph::permitted(c, "calendar")
    } else if r.source.starts_with("mail:") {
        super::graph::permitted(c, "mail")
    } else if r.source.starts_with("chat:") {
        super::graph::permitted(c, "chats")
    } else {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unselected_provider_volume_never_hides_local_notes() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let mut note = item(
            "a",
            "my-note",
            "note",
            "local",
            json!({"text":"Keep this local note"}),
        );
        note.connection_id = None;
        note.workspace_id = Some("personal".into());
        note.updated_at = 0;
        r.put_record(&note).unwrap();
        r.db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO records SELECT 'unselected-'||x,'message','a','','chat:unselected','v1',100,'{\"text\":\"not selected\"}' FROM n;").unwrap();
        let s = r.snapshot().unwrap();
        assert!(s.records.iter().any(|r| r.id == "my-note"));
        assert!(!s.records.iter().any(|r| r.source == "chat:unselected"));
    }
    #[test]
    fn archiving_in_one_workspace_preserves_another_workspaces_open_item() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let mut b = r.workspace("personal").unwrap();
        b.id = "second".into();
        b.is_default = false;
        r.save_workspace(&b).unwrap();
        r.put_record(&item(
            "a",
            "shared",
            "message",
            "chat:chat-a",
            json!({"text":"Shared follow-up"}),
        ))
        .unwrap();
        let mut decision = item(
            "a",
            "shared",
            "decision",
            "chat:chat-a",
            json!({"lifecycle":"archived"}),
        );
        decision.workspace_id = Some("personal".into());
        r.put_record(&decision).unwrap();
        r.commit_sync(&c, "chat:chat-a", &[], &[], None, true)
            .unwrap();
        assert!(r.record("message", "shared", Some("a"), None).is_ok());
        decision.workspace_id = Some("second".into());
        r.put_record(&decision).unwrap();
        r.commit_sync(&c, "chat:chat-a", &[], &[], None, true)
            .unwrap();
        assert!(r.record("message", "shared", Some("a"), None).is_err());
    }
    #[test]
    fn presentation_changes_preserve_armed_reminder_policy() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let policy = r.policy(Some("personal"), Some("a")).unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.name = "Renamed".into();
        w.color = "#123456".into();
        w.layout.reverse();
        w.revision += 1;
        r.save_workspace(&w).unwrap();
        r.check_policy(Some("personal"), Some("a"), &policy)
            .unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.sources["mail"] = false.into();
        r.save_workspace(&w).unwrap();
        assert!(r
            .check_policy(Some("personal"), Some("a"), &policy)
            .is_err());
    }
    #[test]
    fn saved_provider_results_cannot_replay_after_account_switch_or_purge() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let request = Request {
            op: Operation::ActionPrepare,
            workspace_id: Some("personal".into()),
            expected_revision: Some(r.revision().unwrap()),
            operation_id: Some(id()),
            data: json!({"body":"QA"}),
        };
        assert!(r.check_request(&request).unwrap());
        let opid = request.operation_id.as_deref().unwrap();
        r.finish_operation(opid, &json!({"review":"account-a-content"}))
            .unwrap();
        assert!(!r.check_request(&request).unwrap());
        let b = connection("b");
        r.save_connection(&b).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some("b".into());
        r.settings_update(&s).unwrap();
        assert!(r.check_request(&request).is_err());
        r.purge_connection("a", false).unwrap();
        assert!(r.operation_result(opid).is_err());
    }
    #[test]
    fn source_removal_hides_derived_workspace_records() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let mut draft = item(
            "a",
            "ai-draft",
            "draft",
            "chat:chat-a",
            json!({"text":"Derived source text"}),
        );
        draft.workspace_id = Some("personal".into());
        r.put_record(&draft).unwrap();
        assert!(r
            .snapshot()
            .unwrap()
            .records
            .iter()
            .any(|r| r.id == "ai-draft"));
        let mut w = r.workspace("personal").unwrap();
        w.sources["chats"] = json!([]);
        r.save_workspace(&w).unwrap();
        assert!(!r
            .snapshot()
            .unwrap()
            .records
            .iter()
            .any(|r| r.id == "ai-draft"));
    }
    #[test]
    fn delta_tombstones_are_window_scoped_and_cursor_is_atomic() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        r.put_record(&item(
            "a",
            "outside",
            "event",
            "calendar:primary",
            json!({"start":"2027-02-01T09:00:00Z","end":"2027-02-01T10:00:00Z"}),
        ))
        .unwrap();
        let start = super::super::graph::timestamp("2026-11-16T00:00:00Z");
        r.commit_calendar_round(
            &c,
            "calendar:primary",
            &[],
            &["outside".into()],
            CalendarRound {
                window: (start, start + 86400),
                full: false,
                cursor_key: "window:nov",
                cursor: Some("cursor-2"),
            },
        )
        .unwrap();
        assert!(r.record("event", "outside", Some("a"), None).is_ok());
        assert_eq!(
            r.cursor("a", "window:nov").unwrap().as_deref(),
            Some("cursor-2")
        );
        let mut changed = c.clone();
        changed.policy_revision += 1;
        r.save_connection(&changed).unwrap();
        assert!(r
            .commit_calendar_round(
                &c,
                "calendar:primary",
                &[],
                &[],
                CalendarRound {
                    window: (start, start + 86400),
                    full: false,
                    cursor_key: "window:nov",
                    cursor: Some("cursor-3")
                }
            )
            .is_err());
        assert_eq!(
            r.cursor("a", "window:nov").unwrap().as_deref(),
            Some("cursor-2")
        );
    }
    #[test]
    fn unresolved_untriaged_messages_survive_rolling_sync() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        r.put_record(&item(
            "a",
            "untriaged",
            "message",
            "chat:chat-a",
            json!({"text":"still waiting","at":now()-86400*31}),
        ))
        .unwrap();
        r.commit_sync(&c, "chat:chat-a", &[], &[], None, true)
            .unwrap();
        assert!(r.record("message", "untriaged", Some("a"), None).is_ok());
    }
    #[test]
    fn cancellation_and_claim_fencing_block_late_commits() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let mut c = connection("a");
        bind(&mut r, &c);
        let j = Job {
            id: id(),
            kind: "sync".into(),
            key: id(),
            state: "queued".into(),
            workspace_id: None,
            connection_id: Some(c.id.clone()),
            due_at: now(),
            lease_until: None,
            attempts: 0,
            policy: r.policy(None, Some(&c.id)).unwrap(),
            payload: json!({}),
            result: None,
        };
        r.enqueue(&j).unwrap();
        let mut claim = r.claim(now()).unwrap().unwrap();
        c.job_fence = Some((claim.id.clone(), claim.attempts));
        r.validate_claim(&c).unwrap();
        claim.state = "cancelled".into();
        r.save_job(&claim).unwrap();
        assert_eq!(
            r.check_claim(&claim.id, claim.attempts).unwrap_err().code,
            "cancelled"
        );
        assert!(r
            .commit_sync(&c, "chat:chat-a", &[], &[], None, true)
            .is_err());
    }
    fn connection(cid: &str) -> Connection {
        Connection {
            id: cid.into(),
            account_key: cid.into(),
            display_name: "QA".into(),
            email: "qa@example.test".into(),
            user_id: cid.into(),
            generation: 1,
            policy_revision: 1,
            source_revision: 0,
            scopes: vec![
                "Calendars.Read".into(),
                "Mail.Read".into(),
                "Chat.Read".into(),
            ],
            enabled: vec!["calendar".into(), "mail".into(), "chats".into()],
            status: "connected".into(),
            ..Default::default()
        }
    }
    fn bind_all(r: &mut Repository, c: &Connection) {
        bind(r, c);
        let mut w = r.workspace("personal").unwrap();
        w.sources = json!({"all":true});
        r.save_workspace(&w).unwrap();
    }
    fn workspace_with(sources: Value) -> Workspace {
        Workspace {
            id: "w".into(),
            name: "W".into(),
            color: "#2297f6".into(),
            archived: false,
            is_default: false,
            connection_id: Some("a".into()),
            revision: 0,
            access_revision: 0,
            profile_revision: 0,
            sources,
            layout: vec![],
            widget_widths: json!({}),
            ai_profile: None,
        }
    }
    #[test]
    fn automatic_sources_select_every_provider_source_and_legacy_form_still_works() {
        let all = workspace_with(json!({"all":true}));
        let legacy =
            workspace_with(json!({"calendars":["primary"],"chats":["chat-a"],"mail":false}));
        for source in ["calendar:any", "chat:any", "mail:inbox", "mail:sentitems"] {
            let r = item("a", "x", "message", source, json!({}));
            assert!(record_selected(&r, &all), "{source}");
        }
        assert!(record_selected(
            &item("a", "x", "event", "calendar:primary", json!({})),
            &legacy
        ));
        assert!(!record_selected(
            &item("a", "x", "event", "calendar:other", json!({})),
            &legacy
        ));
        assert!(!record_selected(
            &item("a", "x", "message", "mail:inbox", json!({})),
            &legacy
        ));
        assert!(!record_selected(
            &item("a", "x", "message", "chat:any", json!({})),
            &workspace_with(json!({"all":false}))
        ));
        assert!(sources_empty(
            &json!({"calendars":[],"mail":false,"chats":[]})
        ));
        assert!(sources_empty(&json!({})));
        assert!(!sources_empty(&json!({"all":true})));
        assert!(!sources_empty(&json!({"mail":true})));
    }
    #[test]
    fn automatic_sources_include_provider_records_in_snapshot_and_account_queries() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind_all(&mut r, &c);
        for (rid, kind, source) in [
            ("m", "message", "mail:inbox"),
            ("s", "message", "mail:sentitems"),
            ("t", "message", "chat:never-ticked"),
            ("e", "event", "calendar:never-ticked"),
        ] {
            r.put_record(&item(
                "a",
                rid,
                kind,
                source,
                json!({"text":"x","at":now(),"start":"2026-11-16T09:00:00Z","end":"2026-11-16T10:00:00Z"}),
            ))
            .unwrap();
        }
        let snap = r.snapshot().unwrap();
        assert!(snap.available);
        for rid in ["m", "s", "t", "e"] {
            assert!(snap.records.iter().any(|r| r.id == rid), "snapshot {rid}");
        }
        let rows = r.account_workspace_records("a", "personal").unwrap();
        for rid in ["m", "s", "t", "e"] {
            assert!(rows.iter().any(|r| r.id == rid), "account {rid}");
        }
        // Another account's records stay out even with automatic sources.
        r.put_record(&item("b", "other", "message", "mail:inbox", json!({})))
            .unwrap();
        assert!(!r
            .account_workspace_records("a", "personal")
            .unwrap()
            .iter()
            .any(|r| r.id == "other"));
    }
    #[test]
    fn automatic_sources_reconcile_keeps_items_another_workspace_still_wants() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let mut second = r.workspace("personal").unwrap();
        second.id = "second".into();
        second.is_default = false;
        second.sources = json!({"all":true});
        r.save_workspace(&second).unwrap();
        let c = r.connection("a").unwrap();
        r.put_record(&item("a", "kept", "message", "chat:unticked", json!({})))
            .unwrap();
        let mut decision = item(
            "a",
            "kept",
            "decision",
            "chat:unticked",
            json!({"lifecycle":"archived"}),
        );
        decision.workspace_id = Some("personal".into());
        r.put_record(&decision).unwrap();
        r.commit_sync(&c, "chat:unticked", &[], &[], None, true)
            .unwrap();
        assert!(r.record("message", "kept", Some("a"), None).is_ok());
    }
    #[test]
    fn open_binds_default_workspace_to_active_connection_once() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let mut r = Repository::open(&path).unwrap();
        let c = connection("a");
        r.save_connection(&c).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some("a".into());
        r.settings_update(&s).unwrap();
        drop(r);
        let mut r = Repository::open(&path).unwrap();
        let w = r.workspace("personal").unwrap();
        assert_eq!(w.connection_id.as_deref(), Some("a"));
        assert_eq!(w.sources, json!({"all":true}));
        assert!(!r.bind_default_to_active().unwrap());
        // A legacy explicit selection (one Teams chat, picked in the old Settings) upgrades too.
        let mut legacy = w.clone();
        legacy.sources = json!({"calendars":["primary"],"mail":false,"chats":["one-chat"]});
        r.save_workspace(&legacy).unwrap();
        drop(r);
        let mut r = Repository::open(&path).unwrap();
        assert_eq!(
            r.workspace("personal").unwrap().sources,
            json!({"all":true})
        );
        assert!(!r.bind_default_to_active().unwrap());
    }
    #[test]
    fn sign_in_auto_bind_makes_every_same_account_workspace_automatic() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let base = r.workspace("personal").unwrap();
        for (wid, cid, sources, archived) in [
            (
                "unbound",
                None,
                json!({"calendars":[],"mail":false,"chats":[]}),
                false,
            ),
            (
                "explicit",
                Some("a"),
                json!({"calendars":["primary"],"mail":true,"chats":[]}),
                false,
            ),
            (
                "empty",
                Some("a"),
                json!({"calendars":[],"mail":false,"chats":[]}),
                false,
            ),
            ("foreign", Some("b"), json!({"all":true}), false),
            ("archived", None, json!({}), true),
        ] {
            let mut w = base.clone();
            w.id = wid.into();
            w.is_default = false;
            w.connection_id = cid.map(String::from);
            w.sources = sources;
            w.archived = archived;
            r.save_workspace(&w).unwrap();
        }
        r.auto_bind("a").unwrap();
        let get = |id: &str| r.workspace(id).unwrap();
        assert_eq!(get("personal").sources, json!({"all":true}));
        assert_eq!(get("unbound").connection_id.as_deref(), Some("a"));
        assert_eq!(get("unbound").sources, json!({"all":true}));
        assert_eq!(get("explicit").sources, json!({"all":true}));
        assert_eq!(get("empty").sources, json!({"all":true}));
        assert_eq!(get("foreign").connection_id.as_deref(), Some("b"));
        assert!(get("archived").connection_id.is_none());
        r.auto_bind("b").unwrap();
        assert_eq!(
            r.workspace("personal").unwrap().connection_id.as_deref(),
            Some("b")
        );
    }
    #[test]
    fn automatic_calendar_selection_reads_the_catalog() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind_all(&mut r, &c);
        let values: Vec<Value> = (0..40).map(|n| json!({"id":format!("cal-{n}")})).collect();
        r.put_record(&item(
            "a",
            "calendars",
            "catalog",
            "catalog",
            json!({"values":values}),
        ))
        .unwrap();
        let w = r.workspace("personal").unwrap();
        let ids = r.workspace_calendars(&w, "a");
        assert_eq!(ids.len(), 30);
        assert_eq!(ids[0], "cal-0");
        let legacy = workspace_with(json!({"calendars":["primary"]}));
        assert_eq!(r.workspace_calendars(&legacy, "a"), vec!["primary"]);
    }
    fn bind(r: &mut Repository, c: &Connection) {
        r.save_connection(c).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some(c.id.clone());
        r.settings_update(&s).unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.connection_id = Some(c.id.clone());
        w.sources = json!({"calendars":["primary"],"chats":["chat-a","chat-b"],"mail":true});
        r.save_workspace(&w).unwrap();
        r.save_connection(c).unwrap();
    }
    fn item(cid: &str, rid: &str, kind: &str, source: &str, data: Value) -> Record {
        Record {
            id: rid.into(),
            kind: kind.into(),
            connection_id: Some(cid.into()),
            workspace_id: None,
            source: source.into(),
            revision: "v1".into(),
            updated_at: now(),
            data,
        }
    }
    #[test]
    fn chat_pruning_keeps_the_newest_tail_and_anything_acted_on() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        for i in 0..30 {
            r.put_record(&item(
                "a",
                &format!("m{i}"),
                "message",
                "chat:busy",
                json!({"at": 1000 + i}),
            ))
            .unwrap();
        }
        r.put_record(&item("a", "q0", "message", "chat:quiet", json!({"at": 1})))
            .unwrap();
        r.put_record(&item(
            "a",
            "m0",
            "decision",
            "chat:busy",
            json!({"lane":"reply"}),
        ))
        .unwrap();
        let mut draft = item("a", "manual:m1", "draft", "local", json!({"sourceId":"m1"}));
        draft.connection_id = None;
        draft.workspace_id = Some("personal".into());
        r.put_record(&draft).unwrap();
        assert_eq!(r.prune_chat_messages(Some("chat:busy"), 25).unwrap(), 3);
        let kept = |id: &str| r.record("message", id, Some("a"), None).is_ok();
        assert!(kept("m29") && kept("m5"), "newest 25 stay");
        assert!(!kept("m2") && !kept("m4"), "older ones go");
        assert!(kept("m0"), "a message with a decision stays");
        assert!(kept("m1"), "a message with a draft stays");
        assert!(kept("q0"), "other chats are untouched");
        assert_eq!(r.prune_chat_messages(None, 25).unwrap(), 0, "idempotent");
    }
    #[test]
    fn accounts_and_disabled_capabilities_never_share_cached_content() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let a = connection("a");
        bind(&mut r, &a);
        r.put_record(&item(
            "a",
            "m",
            "message",
            "mail:inbox",
            json!({"text":"private-a","at":now()}),
        ))
        .unwrap();
        assert!(r.snapshot().unwrap().records.iter().any(|r| r.id == "m"));
        let mut disabled = a.clone();
        disabled.enabled.clear();
        disabled.policy_revision += 1;
        r.save_connection(&disabled).unwrap();
        assert!(!r.snapshot().unwrap().records.iter().any(|r| r.id == "m"));
        let b = connection("b");
        r.save_connection(&b).unwrap();
        let mut s = r.settings().unwrap();
        s.active_connection = Some("b".into());
        r.settings_update(&s).unwrap();
        let snap = r.snapshot().unwrap();
        assert!(!snap.available);
        assert!(snap.records.is_empty());
        assert_eq!(
            r.workspace("personal").unwrap().connection_id,
            Some("a".into())
        );
        assert_eq!(
            r.commit_sync(&a, "mail:inbox", &[], &[], None, true)
                .unwrap_err()
                .code,
            "cancelled"
        );
    }
    #[test]
    fn calendar_reconciliation_preserves_other_windows_and_human_decisions() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let first = item(
            "a",
            "today",
            "event",
            "calendar:primary",
            json!({"start":"2026-11-16T09:00:00Z","end":"2026-11-16T10:00:00Z"}),
        );
        let second = item(
            "a",
            "future",
            "event",
            "calendar:primary",
            json!({"start":"2027-02-01T09:00:00Z","end":"2027-02-01T10:00:00Z"}),
        );
        r.put_record(&first).unwrap();
        r.put_record(&second).unwrap();
        let start = super::super::graph::timestamp("2027-02-01T00:00:00Z");
        r.commit_calendar_sync(
            &c,
            "calendar:primary",
            &[],
            &[],
            None,
            Some((start, start + 86400)),
        )
        .unwrap();
        assert!(r.record("event", "today", Some("a"), None).is_ok());
        assert!(r.record("event", "future", Some("a"), None).is_err());
    }
    #[test]
    fn operation_ids_are_reserved_before_await_and_bound_to_content() {
        let d = tempfile::tempdir().unwrap();
        let r = Repository::open(&d.path().join("db")).unwrap();
        let mut q = Request {
            op: Operation::SettingsUpdate,
            workspace_id: Some("personal".into()),
            expected_revision: Some(r.revision().unwrap()),
            operation_id: Some(id()),
            data: json!({"body":"first"}),
        };
        assert!(r.check_request(&q).unwrap());
        assert!(!r.check_request(&q).unwrap());
        assert_eq!(
            r.operation_result(q.operation_id.as_deref().unwrap())
                .unwrap_err()
                .code,
            "in_progress"
        );
        r.finish_operation(
            q.operation_id.as_deref().unwrap(),
            &json!({"id":"action-1"}),
        )
        .unwrap();
        assert_eq!(
            r.operation_result(q.operation_id.as_deref().unwrap())
                .unwrap()["id"],
            "action-1"
        );
        q.data = json!({"body":"different"});
        assert_eq!(r.check_request(&q).unwrap_err().code, "conflict");
    }
    #[test]
    fn interrupted_reminders_and_provider_actions_do_not_replay() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db");
        let mut r = Repository::open(&path).unwrap();
        let job = Job {
            id: id(),
            workspace_id: None,
            connection_id: None,
            kind: "reminder".into(),
            key: "reminder-1".into(),
            state: "queued".into(),
            due_at: 0,
            lease_until: None,
            attempts: 0,
            policy: json!({}),
            payload: json!({}),
            result: None,
        };
        r.enqueue(&job).unwrap();
        assert!(r.claim(1).unwrap().is_some());
        assert!(r.claim(400).unwrap().is_none());
        assert_eq!(r.jobs().unwrap()[0].state, "failed");
        r.put_record(&item(
            "a",
            "send",
            "action",
            "action",
            json!({"state":"dispatching"}),
        ))
        .unwrap();
        drop(r);
        let r = Repository::open(&path).unwrap();
        assert_eq!(
            r.record("action", "send", Some("a"), None).unwrap().data["state"],
            "unknown_outcome"
        );
    }
    #[test]
    fn stalled_sync_does_not_block_reminder_claim() {
        let d = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&d.path().join("db")).unwrap();
        for (kind, due) in [("sync", 0), ("reminder", 10)] {
            r.enqueue(&Job {
                id: id(),
                workspace_id: None,
                connection_id: None,
                kind: kind.into(),
                key: kind.into(),
                state: "queued".into(),
                due_at: due,
                lease_until: None,
                attempts: 0,
                policy: json!({}),
                payload: json!({}),
                result: None,
            })
            .unwrap();
        }
        assert_eq!(r.claim_ready(1, true).unwrap().unwrap().kind, "sync");
        assert_eq!(r.claim_ready(10, false).unwrap().unwrap().kind, "reminder");
    }
    #[test]
    fn migrations_restart_and_revision_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut repo = Repository::open(&path).unwrap();
        let mut w = repo.workspace("personal").unwrap();
        w.name = "Renamed".into();
        repo.save_workspace(&w).unwrap();
        let rev = repo.revision().unwrap();
        drop(repo);
        let repo = Repository::open(&path).unwrap();
        assert_eq!(repo.workspace("personal").unwrap().name, "Renamed");
        assert_eq!(repo.revision().unwrap(), rev);
        let req = Request {
            op: Operation::SettingsUpdate,
            workspace_id: None,
            expected_revision: Some(rev - 1),
            operation_id: Some(id()),
            data: json!({}),
        };
        assert_eq!(repo.check_request(&req).unwrap_err().code, "stale_view");
    }
    #[test]
    fn stale_revision_returns_stale_view_code() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::open(&dir.path().join("db")).unwrap();
        let rev = repo.revision().unwrap();
        let req = |expected| Request {
            op: Operation::SettingsUpdate,
            workspace_id: None,
            expected_revision: Some(expected),
            operation_id: Some(id()),
            data: json!({}),
        };
        assert_eq!(
            repo.check_request(&req(rev.wrapping_sub(1)))
                .unwrap_err()
                .code,
            "stale_view"
        );
        assert!(repo.check_request(&req(rev)).unwrap());
    }
    #[test]
    fn job_claim_is_unique_and_recovers_only_safe_work() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        for kind in ["sync", "notification"] {
            let j = Job {
                id: id(),
                workspace_id: None,
                connection_id: None,
                kind: kind.into(),
                key: kind.into(),
                state: "queued".into(),
                due_at: 10,
                lease_until: None,
                attempts: 0,
                policy: json!({}),
                payload: json!({}),
                result: None,
            };
            r.enqueue(&j).unwrap();
            r.enqueue(&j).unwrap();
        }
        let a = r.claim(10).unwrap().unwrap();
        let b = r.claim(10).unwrap().unwrap();
        assert_ne!(a.id, b.id);
        assert!(r.claim(11).unwrap().is_none());
        let c = r.claim(400).unwrap().unwrap();
        assert_eq!(c.kind, "sync");
        assert_eq!(c.attempts, 2);
        assert!(r
            .jobs()
            .unwrap()
            .iter()
            .any(|j| j.kind == "notification" && j.state == "failed"));
    }
    #[test]
    fn newer_schema_is_retained() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let r = Repository::open(&path).unwrap();
        r.db.execute_batch("PRAGMA user_version=99").unwrap();
        drop(r);
        assert!(matches!(Repository::open(&path),Err(e) if e.code=="newer_schema"));
        assert_eq!(
            Sqlite::open(&path)
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            99
        );
    }
    #[test]
    fn deleting_schedule_fences_claimed_work_and_preserves_other_schedules() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        for sid in ["removed", "kept"] {
            let job = Job {
                id: sid.into(),
                workspace_id: Some("personal".into()),
                connection_id: None,
                kind: "brief".into(),
                key: sid.into(),
                state: "queued".into(),
                due_at: now() - 1,
                lease_until: None,
                attempts: 0,
                policy: r.policy(Some("personal"), None).unwrap(),
                payload: json!({"scheduleId":sid}),
                result: None,
            };
            r.enqueue(&job).unwrap();
        }
        let running = r.claim(now()).unwrap().unwrap();
        r.delete_local("schedule", &running.id, "personal").unwrap();
        assert_eq!(
            r.check_claim(&running.id, running.attempts)
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert!(r.claim(now()).unwrap().is_some());
    }
    #[test]
    fn brief_result_and_job_completion_commit_together_and_reject_cancelled_claim() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let job = Job {
            id: id(),
            workspace_id: Some("personal".into()),
            connection_id: None,
            kind: "brief".into(),
            key: id(),
            state: "queued".into(),
            due_at: now() - 1,
            lease_until: None,
            attempts: 0,
            policy: r.policy(Some("personal"), None).unwrap(),
            payload: json!({}),
            result: None,
        };
        r.enqueue(&job).unwrap();
        let mut claimed = r.claim(now()).unwrap().unwrap();
        let record = Record {
            id: "daily".into(),
            kind: "brief".into(),
            workspace_id: Some("personal".into()),
            connection_id: None,
            source: "deterministic".into(),
            revision: id(),
            updated_at: now(),
            data: json!({"text":"confirmed"}),
        };
        r.commit_job_record(&claimed, &record).unwrap();
        assert_eq!(r.jobs().unwrap()[0].state, "succeeded");
        assert_eq!(
            r.record("brief", "daily", None, Some("personal"))
                .unwrap()
                .data["text"],
            "confirmed"
        );
        claimed.state = "cancelled".into();
        r.save_job(&claimed).unwrap();
        assert_eq!(
            r.commit_job_record(&claimed, &record).unwrap_err().code,
            "cancelled"
        );
    }
    #[test]
    fn incident_and_alert_occurrences_roll_back_as_one_unit() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let incident = item(
            "a",
            "incident",
            "incident",
            "chat:chat-a",
            json!({"acknowledgedAt":null}),
        );
        let job = Job {
            id: id(),
            kind: "notification".into(),
            key: id(),
            state: "queued".into(),
            workspace_id: Some("personal".into()),
            connection_id: Some("a".into()),
            due_at: now(),
            lease_until: None,
            attempts: 0,
            policy: json!({}),
            payload: json!({"incidentId":"incident"}),
            result: None,
        };
        r.db.execute_batch("CREATE TRIGGER reject_alert BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'simulated interruption'); END").unwrap();
        assert!(r
            .commit_incident(&incident, std::slice::from_ref(&job))
            .is_err());
        assert!(r.record("incident", "incident", Some("a"), None).is_err());
        assert!(r.jobs().unwrap().is_empty());
        r.db.execute_batch("DROP TRIGGER reject_alert").unwrap();
        r.commit_incident(&incident, &[job]).unwrap();
        assert_eq!(r.jobs().unwrap().len(), 1);
    }
    #[test]
    fn snooze_defers_claim_without_allowing_old_attempt_to_finish() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let job = Job {
            id: id(),
            kind: "notification".into(),
            key: id(),
            state: "queued".into(),
            workspace_id: Some("personal".into()),
            connection_id: None,
            due_at: now(),
            lease_until: None,
            attempts: 0,
            policy: json!({}),
            payload: json!({}),
            result: None,
        };
        r.enqueue(&job).unwrap();
        let claimed = r.claim(now()).unwrap().unwrap();
        let later = now() + 3600;
        r.defer_claim(&claimed, later).unwrap();
        assert!(r.check_claim(&claimed.id, claimed.attempts).is_err());
        assert!(r.claim(now()).unwrap().is_none());
        let next = r.claim(later).unwrap().unwrap();
        assert_eq!(next.attempts, 2);
    }
    #[test]
    fn manual_calendar_round_rejects_source_change_before_commit() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let captured = r.connection("a").unwrap();
        let mut w = r.workspace("personal").unwrap();
        w.sources["calendars"] = json!([]);
        r.save_workspace(&w).unwrap();
        let e = item(
            "a",
            "late",
            "event",
            "calendar:primary",
            json!({"title":"late"}),
        );
        assert_eq!(
            r.commit_sync(
                &captured,
                "calendar:primary",
                &[e],
                &[],
                Some("late-cursor"),
                true
            )
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert!(r.cursor("a", "calendar:primary").unwrap().is_none());
        assert!(r.provider_records("a", "event").unwrap().is_empty());
    }
    #[test]
    fn critical_source_query_is_scoped_before_account_volume() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let mut message = item(
            "a",
            "selected-critical",
            "message",
            "chat:chat-a",
            json!({"text":"urgent outage","at":1}),
        );
        message.updated_at = 1;
        r.put_record(&message).unwrap();
        r.db.execute_batch("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<20001) INSERT INTO records SELECT 'unselected-'||x,'message','a','','chat:unselected','v1',100,'{}' FROM n").unwrap();
        let rows = r.account_workspace_records("a", "personal").unwrap();
        assert_eq!(rows.iter().filter(|m| m.kind == "message").count(), 1);
        assert!(rows.iter().any(|m| m.id == "selected-critical"));
    }
    #[test]
    fn inbox_exclusions_manual_overrides_rules_and_sent_fallback_have_explicit_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let w = r.workspace("personal").unwrap();
        let mut rule = item(
            "a",
            "urgent-rule",
            "rule",
            "local",
            json!({"text":"Urgent","keyword":"urgent","lane":"critical","enabled":true}),
        );
        rule.connection_id = None;
        rule.workspace_id = Some(w.id.clone());
        r.put_record(&rule).unwrap();
        let automated = item(
            "a",
            "automated",
            "message",
            "mail:inbox",
            json!({"text":"urgent","fromAddress":"no-reply@example.test","conversationId":"a"}),
        );
        let ordinary = item(
            "a",
            "ordinary",
            "message",
            "mail:inbox",
            json!({"text":"urgent","fromAddress":"person@example.test","conversationId":"b"}),
        );
        let mine = item(
            "a",
            "mine",
            "message",
            "mail:sentitems",
            json!({"text":"Sent by me","isMine":true,"conversationId":"c"}),
        );
        let mut decision = item(
            "a",
            "automated",
            "decision",
            "mail:inbox",
            json!({"lane":"critical"}),
        );
        decision.workspace_id = Some(w.id.clone());
        let mut rows = vec![automated, ordinary, mine, decision];
        super::super::inbox::project(&r, &w, Some(&c), &mut rows).unwrap();
        assert_eq!(rows[0].data["lane"], "low");
        assert_eq!(rows[1].data["lane"], "critical");
        assert_eq!(rows[2].data["lane"], "fyi");
        rows[3].id = "ordinary".into();
        rows[3].data = json!({"lane":"waiting"});
        super::super::inbox::project(&r, &w, Some(&c), &mut rows).unwrap();
        assert_eq!(rows[1].data["lane"], "waiting");
    }
    #[test]
    fn one_ai_claim_leaves_capacity_for_due_reminders_and_preserves_queued_profile() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let at = now();
        for n in 0..3 {
            let job = Job {
                id: id(),
                kind: "ai_draft".into(),
                key: format!("ai-{n}"),
                state: "queued".into(),
                workspace_id: Some("personal".into()),
                connection_id: None,
                due_at: at,
                lease_until: None,
                attempts: 0,
                policy: json!({}),
                payload: json!({"profile":"claude-api","profileRevision":17}),
                result: None,
            };
            r.enqueue(&job).unwrap();
        }
        let first = r.claim(at).unwrap().unwrap();
        assert_eq!(first.kind, "ai_draft");
        assert!(r.claim(at).unwrap().is_none());
        let reminder = Job {
            id: id(),
            kind: "reminder".into(),
            key: "urgent-reminder".into(),
            state: "queued".into(),
            workspace_id: Some("personal".into()),
            connection_id: None,
            due_at: at,
            lease_until: None,
            attempts: 0,
            policy: json!({}),
            payload: json!({}),
            result: None,
        };
        r.enqueue(&reminder).unwrap();
        assert_eq!(r.claim(at).unwrap().unwrap().kind, "reminder");
        assert_eq!(
            r.jobs()
                .unwrap()
                .iter()
                .filter(|j| j.kind == "ai_draft"
                    && j.state == "queued"
                    && j.payload["profileRevision"] == 17)
                .count(),
            2
        );
    }
    #[tokio::test]
    async fn cancellation_during_ai_probe_prevents_dispatch_and_source_write() {
        use std::sync::{Arc, Mutex};
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let mut w = r.workspace("personal").unwrap();
        w.ai_profile = Some("claude-api".into());
        r.save_workspace(&w).unwrap();
        let w = r.workspace("personal").unwrap();
        r.put_record(&item(
            "a",
            "source",
            "message",
            "chat:chat-a",
            json!({"text":"Synthetic private source"}),
        ))
        .unwrap();
        let job = Job {
            id: id(),
            kind: "ai_draft".into(),
            key: id(),
            state: "queued".into(),
            workspace_id: Some(w.id.clone()),
            connection_id: Some(c.id.clone()),
            due_at: now(),
            lease_until: None,
            attempts: 0,
            policy: r.policy(Some(&w.id), Some(&c.id)).unwrap(),
            payload: json!({"profile":"claude-api","profileRevision":w.profile_revision,"sourceRevision":"v1","request":{"sourceId":"source"}}),
            result: None,
        };
        r.enqueue(&job).unwrap();
        let claim = r.claim(now()).unwrap().unwrap();
        assert!(r.ai_job_source(&claim).is_ok());
        let mut unavailable = r.record("message", "source", Some("a"), None).unwrap();
        unavailable.data["unavailable"] = true.into();
        r.put_record(&unavailable).unwrap();
        assert!(r.ai_job_source(&claim).is_err());
        unavailable.data["unavailable"] = false.into();
        r.put_record(&unavailable).unwrap();
        let repo = Arc::new(Mutex::new(r));
        let observed = Arc::new(Mutex::new(Vec::new()));
        let (release, probe) = tokio::sync::oneshot::channel();
        let worker_repo = repo.clone();
        let written = observed.clone();
        let worker_claim = claim.clone();
        let worker = tokio::spawn(async move {
            probe.await.unwrap();
            let r = worker_repo.lock().unwrap();
            let source = r.ai_job_source(&worker_claim)?;
            written
                .lock()
                .unwrap()
                .extend_from_slice(source.data["text"].as_str().unwrap().as_bytes());
            Ok::<_, WorkspaceError>(())
        });
        let mut cancelled = claim;
        cancelled.state = "cancelled".into();
        repo.lock().unwrap().save_job(&cancelled).unwrap();
        release.send(()).unwrap();
        assert_eq!(worker.await.unwrap().unwrap_err().code, "cancelled");
        assert!(observed.lock().unwrap().is_empty());
    }
    #[test]
    fn paged_chat_discovery_commits_catalog_with_cursor_and_clears_terminal_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let catalog = item(
            "a",
            "chats",
            "catalog",
            "catalog",
            json!({"values":[{"id":"chat-a"}],"hasMore":true}),
        );
        r.commit_chat_catalog(&c, &catalog, Some("page-two"))
            .unwrap();
        assert_eq!(
            r.cursor("a", "catalog:chats").unwrap().as_deref(),
            Some("page-two")
        );
        let mut complete = catalog.clone();
        complete.data["hasMore"] = false.into();
        r.commit_chat_catalog(&c, &complete, None).unwrap();
        assert!(r.cursor("a", "catalog:chats").unwrap().is_none());
        assert_eq!(
            r.record("catalog", "chats", Some("a"), None).unwrap().data["hasMore"],
            false
        );
        let mut revoked = r.connection("a").unwrap();
        revoked.generation += 1;
        r.save_connection(&revoked).unwrap();
        assert!(r
            .commit_chat_catalog(&c, &catalog, Some("late-page"))
            .is_err());
        assert!(r.cursor("a", "catalog:chats").unwrap().is_none());
    }
    #[test]
    fn exclusive_owner_restart_recovers_safe_work_immediately_without_waiting_for_old_lease() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let mut r = Repository::open(&path).unwrap();
        for kind in ["sync", "notification"] {
            let job = Job {
                id: id(),
                kind: kind.into(),
                key: kind.into(),
                state: "running".into(),
                workspace_id: None,
                connection_id: None,
                due_at: now(),
                lease_until: Some(now() + 300),
                attempts: 1,
                policy: json!({}),
                payload: json!({}),
                result: None,
            };
            r.enqueue(&job).unwrap();
        }
        drop(r);
        let mut reopened = Repository::open(&path).unwrap();
        assert_eq!(reopened.claim(now()).unwrap().unwrap().kind, "sync");
        assert!(reopened
            .jobs()
            .unwrap()
            .iter()
            .any(|j| j.kind == "notification" && j.state == "failed"));
    }
    #[test]
    fn direct_mail_requires_a_request_while_waiting_responses_reopen_for_review() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        let w = r.workspace("personal").unwrap();
        let addressed = json!([{"emailAddress":{"address":c.email}}]);
        let newsletter = item(
            "a",
            "news",
            "message",
            "mail:inbox",
            json!({"title":"A webinar invitation","text":"Join our upcoming webinar https://example.test/?p=1","to":addressed,"conversationId":"news","at":10}),
        );
        let question = item(
            "a",
            "question",
            "message",
            "mail:inbox",
            json!({"text":"Could you review the proposal?","to":addressed,"conversationId":"question","at":10}),
        );
        let sent = item(
            "a",
            "sent",
            "message",
            "mail:sentitems",
            json!({"text":"Awaiting your response","isMine":true,"conversationId":"waiting","at":10}),
        );
        let response = item(
            "a",
            "response",
            "message",
            "mail:inbox",
            json!({"text":"Done","conversationId":"waiting","at":30}),
        );
        for m in [&newsletter, &question, &sent, &response] {
            r.put_record(m).unwrap();
        }
        let mut decision = item(
            "a",
            "sent",
            "decision",
            "mail:sentitems",
            json!({"lane":"waiting","waitingSince":20}),
        );
        decision.workspace_id = Some(w.id.clone());
        let mut rows = vec![newsletter, question, sent, response, decision];
        super::super::inbox::project(&r, &w, Some(&c), &mut rows).unwrap();
        assert_eq!(rows[0].data["lane"], "fyi");
        assert_eq!(rows[1].data["lane"], "reply");
        assert_eq!(rows[2].data["lane"], "waiting");
        assert_eq!(rows[2].data["responseSourceId"], "response");
        assert_eq!(rows[3].data["lane"], "reply");
    }
    #[test]
    fn disabling_read_capability_hides_its_source_catalog_too() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Repository::open(&dir.path().join("db")).unwrap();
        let c = connection("a");
        bind(&mut r, &c);
        r.put_record(&item(
            "a",
            "chats",
            "catalog",
            "catalog",
            json!({"values":[{"id":"chat-a"}]}),
        ))
        .unwrap();
        assert!(r
            .snapshot()
            .unwrap()
            .records
            .iter()
            .any(|v| v.kind == "catalog" && v.id == "chats"));
        let mut current = r.connection("a").unwrap();
        current.enabled.retain(|cap| cap != "chats");
        r.save_connection(&current).unwrap();
        assert!(!r
            .snapshot()
            .unwrap()
            .records
            .iter()
            .any(|v| v.kind == "catalog" && v.id == "chats"));
    }
}
