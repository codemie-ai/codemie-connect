use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub type Result<T> = std::result::Result<T, WorkspaceError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<i64>,
}

impl WorkspaceError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retry_after: None,
        }
    }
}
impl From<rusqlite::Error> for WorkspaceError {
    fn from(_: rusqlite::Error) -> Self {
        Self::new("storage", "Workspace storage could not complete the operation. Your existing tools are still available.")
    }
}
impl From<std::io::Error> for WorkspaceError {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            "io",
            "The local operation failed. Check disk access and try again.",
        )
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub op: Operation,
    pub workspace_id: Option<String>,
    pub expected_revision: Option<i64>,
    pub operation_id: Option<String>,
    #[serde(default = "empty_object")]
    pub data: Value,
}
fn empty_object() -> Value {
    json!({})
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Snapshot,
    WorkspaceCreate,
    WorkspaceUpdate,
    WorkspaceSelect,
    SettingsUpdate,
    LocalSave,
    LocalDelete,
    LayoutSave,
    GraphConnect,
    GraphCancel,
    GraphDisconnect,
    GraphBind,
    SourcesSave,
    SourcesMore,
    SyncRequest,
    CalendarWindow,
    InboxDecision,
    DraftSave,
    ActionPrepare,
    ActionConfirm,
    ScheduleSave,
    ScheduleDelete,
    JobCancel,
    JobRetry,
    NotificationPermission,
    NotificationTest,
    OpenSource,
    Export,
    AiProbe,
    AiDraft,
    BriefGenerate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub color: String,
    pub archived: bool,
    pub is_default: bool,
    pub connection_id: Option<String>,
    pub revision: i64,
    #[serde(default)]
    pub access_revision: i64,
    #[serde(default)]
    pub profile_revision: i64,
    pub sources: Value,
    pub layout: Vec<String>,
    #[serde(default = "empty_object")]
    pub widget_widths: Value,
    pub ai_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub account_key: String,
    pub display_name: String,
    pub email: String,
    pub user_id: String,
    pub generation: i64,
    pub policy_revision: i64,
    #[serde(default)]
    pub source_revision: i64,
    pub scopes: Vec<String>,
    pub enabled: Vec<String>,
    pub status: String,
    pub last_sync: Option<i64>,
    pub sync_error: Option<String>,
    #[serde(default)]
    pub retry_at: Option<i64>,
    #[serde(skip)]
    pub job_fence: Option<(String, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct Settings {
    pub theme: String,
    pub time_zone: String,
    pub background: bool,
    pub launch_at_login: bool,
    pub critical_repeat: bool,
    pub sync_days: i64,
    pub notifications: bool,
    pub notification_preview: bool,
    pub quiet_start: String,
    pub quiet_end: String,
    pub client_id: String,
    pub tenant: String,
    pub active_workspace: String,
    pub active_connection: Option<String>,
    pub notification_permission: String,
    pub focus_until: Option<i64>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            time_zone: "UTC".into(),
            background: false,
            launch_at_login: false,
            critical_repeat: true,
            sync_days: 30,
            notifications: false,
            notification_preview: false,
            quiet_start: "22:00".into(),
            quiet_end: "08:00".into(),
            client_id: "3d7688c6-f449-4d04-8b0d-57d94818e922".into(),
            tenant: "common".into(),
            active_workspace: "personal".into(),
            active_connection: None,
            notification_permission: "not_requested".into(),
            focus_until: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub kind: String,
    pub connection_id: Option<String>,
    pub workspace_id: Option<String>,
    pub source: String,
    pub revision: String,
    pub updated_at: i64,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub workspace_id: Option<String>,
    pub connection_id: Option<String>,
    pub kind: String,
    pub key: String,
    pub state: String,
    pub due_at: i64,
    pub lease_until: Option<i64>,
    pub attempts: i64,
    pub policy: Value,
    pub payload: Value,
    pub result: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: i64,
    pub workspaces: Vec<Workspace>,
    pub settings: Settings,
    pub connection: Option<Connection>,
    pub records: Vec<Record>,
    pub jobs: Vec<Job>,
    pub available: bool,
}

pub fn required<'a>(data: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let v = data[key].as_str().unwrap_or("").trim();
    if v.is_empty() || v.chars().count() > max || v.contains('\0') {
        return Err(WorkspaceError::new(
            "validation",
            format!("Enter a valid {key} (up to {max} characters)."),
        ));
    }
    Ok(v)
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
