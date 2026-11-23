use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub type Result<T> = std::result::Result<T, WorkspaceError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<i64>,
    /// The Claude error class (DESIGN 6.2) when Claude could not do the work, so a Claude
    /// sign-in problem is never mistaken for a Microsoft one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    /// The form field a validation sentence is about (`name`, `days`, `senders`, ...), so an
    /// editor can show it there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

impl WorkspaceError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retry_after: None,
            class: None,
            field: None,
        }
    }
}
impl WorkspaceError {
    /// The data folder can't be read or written (disk gone, read-only, permission): the UI
    /// shows the recovery page.
    pub fn storage_unavailable() -> Self {
        Self::new(
            "storage_unavailable",
            "Connect lost access to its data folder.",
        )
    }
}
impl From<rusqlite::Error> for WorkspaceError {
    fn from(e: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode::*;
        match e.sqlite_error_code() {
            // The folder or its disk went away, turned read-only or refuses access.
            Some(SystemIoFailure | CannotOpen | ReadOnly | PermissionDenied) => {
                Self::storage_unavailable()
            }
            Some(DiskFull) => Self::new(
                "storage_unavailable",
                "The disk that holds Connect's data folder is full.",
            ),
            _ => Self::new("storage", "Workspace storage could not complete the operation. Your existing tools are still available."),
        }
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
    AiStatus,
    AiSettingsSave,
    AiTest,
    AiUsage,
    AiDraft,
    AiSummarize,
    AutomationSave,
    AutomationDelete,
    AutomationToggle,
    AutomationRunNow,
    AutomationRuns,
    MeetingCheck,
    MeetingDownload,
    MeetingImport,
    MeetingSpeakers,
    MeetingsReveal,
    MeetingRead,
    MeetingNotes,
    MeetingSet,
    MeetingDoc,
    MeetingText,
    MeetingTextSave,
    MeetingSkills,
    TemplateSave,
    TemplateDelete,
    MeetingRuleSave,
    MeetingRuleDelete,
    MeetingRuleOrder,
    TaskSave,
    TaskDelete,
    TaskSyncNow,
    TaskProviderSet,
    TaskWithdraw,
    TaskBulk,
    TaskHandled,
    TaskParked,
    AnalyticsStatus,
    AnalyticsRefresh,
    AnalyticsRetry,
    AnalyticsView,
    AnalyticsSession,
    AnalyticsReport,
    AnalyticsApp,
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
    #[serde(default = "empty_object")]
    pub today: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Microsoft profile fields (`/me`), refreshed at sign-in and at most daily during sync.
    #[serde(default)]
    pub given_name: Option<String>,
    #[serde(default)]
    pub job_title: Option<String>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub office_location: Option<String>,
    /// `data:image/jpeg;base64,...` (or png) of the 120x120 profile photo; None when absent or over 256 KB.
    #[serde(default)]
    pub photo: Option<String>,
    #[serde(default)]
    pub profile_at: Option<i64>,
    #[serde(skip)]
    pub job_fence: Option<(String, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct Settings {
    pub theme: String,
    /// Settings › Appearance › View: "default" or "compact" (app-wide, like theme).
    pub view: String,
    /// Main-menu pages left out of the menu (ids from NAV, in menu order).
    pub hidden_pages: Vec<String>,
    pub time_zone: String,
    pub background: bool,
    pub launch_at_login: bool,
    pub critical_repeat: bool,
    pub sync_days: i64,
    /// Minutes between background syncs while the window is open (Settings › Microsoft 365).
    pub sync_every_min: i64,
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
    pub ai: AiSettings,
    /// Settings › Meetings.
    pub meetings: super::meetings::model::MeetingSettings,
    /// Settings › Tasks: the active task provider (design §2 of the task-provider spec).
    pub tasks: super::task_provider::TaskSettings,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            view: "default".into(),
            hidden_pages: Vec::new(),
            time_zone: "UTC".into(),
            background: false,
            launch_at_login: false,
            critical_repeat: true,
            sync_days: 30,
            sync_every_min: 1,
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
            ai: AiSettings::default(),
            meetings: Default::default(),
            tasks: Default::default(),
        }
    }
}

/// What a Claude run is for; each purpose can be routed to its own profile and model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    MailDraft,
    ChatDraft,
    Summary,
    Automation,
    Plugin,
    /// Notes and summaries from meeting transcripts.
    Meeting,
}
/// An empty route uses the default profile.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Route {
    pub profile: Option<String>,
    pub model: Option<String>,
}

/// `settings.ai`. `default_profile` stays `None` until the user chooses one, so no
/// provider receives message text without an explicit choice.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    pub default_profile: Option<String>,
    pub routes: std::collections::BTreeMap<Purpose, Route>,
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
    /// The Claude error class of the last failure of an AI job (`needs_login`, `needs_choice`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_class: Option<String>,
    /// The machine-readable code of the last failure (`conflict`, `needs_login`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
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
    /// The resolved meetings folder (Settings › Meetings). Filled by `Core` for the window's
    /// snapshot; `None` elsewhere, and when Connect can't find the home folder.
    pub meetings_root: Option<super::meetings::model::MeetingsRoot>,
    /// Every note template: the built-ins (with the person's changes) and the person's own and
    /// skills. Filled by `Core` for the window's snapshot; empty elsewhere.
    pub note_templates: Vec<super::meetings::templates::Template>,
    /// `taskProvider` (task-provider design §2): the active provider, every available one, its
    /// state and the outbox counts. Filled by `Core` for the window's snapshot; `Value::Null`
    /// elsewhere.
    pub task_provider: Value,
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
