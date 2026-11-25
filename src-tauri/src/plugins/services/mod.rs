//! Connect's side of `ctx` (PLUGIN-ENGINE.md §4 and §8, DESIGN 7.2): the services a plugin's host
//! half reaches through `HostServices`. The plugin host names the plugin on every call (never the
//! plugin's own arguments), and every call is checked here, on the Rust side, against the sheet
//! the user agreed to (`Granted`): a plugin's own checks are a courtesy, not protection.
//!
//! Where a plugin's things live (`PluginPaths`):
//! - `<data>/plugins/data/<id>/store/`: its store (`store`).
//! - `<data>/plugins/data/<id>/`: Connect's own files about it, outside the store so the plugin
//!   can't write them: `settings.json`, `folders.json` (the folders it was given).
//! - `<private>/credentials/plugins/<id>/`: its `secret` settings and sign-ins, 0600 in a 0700
//!   folder.
//! - `<data>/plugins/shared/<namespace>.json`: values a marketplace's plugins share.
//!
//! The services: `store` (with `package`), `settings`, `fs` (with `system`), `http`, `notify`
//! (with `log`), `markdown`; `claude` (with `profiles`), `deliver`, `today` (inbox, widgets,
//! work rows), `echo_read`, `events` (shared values), `signin`, `tasks` (a provider's ops) and
//! `reply_context` (a reply-context provider's ops and the user's sent messages).
pub mod cas;
pub mod claude;
#[cfg(test)]
mod contract_tests;
pub mod deliver;
pub mod echo_read;
pub mod events;
pub mod files;
pub mod fs;
pub mod hidden;
pub mod http;
pub mod m365;
pub mod markdown;
pub mod notify;
pub mod reply_context;
pub mod settings;
pub mod signin;
pub mod skills;
pub mod snapshot;
pub mod store;
pub mod tasks;
pub mod today;
pub mod vault_git;
pub mod web;
pub mod web_page;
pub mod window;

use super::host::{ErrorCode, HostError, HostServices, PluginHost};
use super::manifest::{parse_manifest, SettingDef, WidgetDef};
use super::registry::{Installed, PluginPaths};
use crate::workspace::Core;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, RwLock, Weak};

/// What one loaded plugin may do: its installed package and the `uses` keys the user agreed to.
#[derive(Debug, Clone)]
pub struct Granted {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Its installed package, `<data>/plugins/installed/<id>/<version>/`.
    pub dir: PathBuf,
    /// Its host half, inside `dir`.
    pub main: Option<String>,
    /// Its manifest's `uses`, only the keys the user agreed to.
    pub uses: Map<String, Value>,
    pub settings: Vec<SettingDef>,
    pub widgets: Vec<WidgetDef>,
    /// The roles it takes in Connect (`provides`), only those the user agreed to.
    pub provides: Vec<String>,
    /// The namespace of the values it shares with its marketplace's plugins: the marketplace's
    /// name, lowercase.
    pub namespace: String,
}

impl Granted {
    /// What an install grants: its manifest, read again from the installed package, with only
    /// the `uses` keys the user agreed to.
    pub fn of(paths: &PluginPaths, id: &str, installed: &Installed) -> Result<Granted, String> {
        let dir = paths.installed().join(id).join(&installed.version);
        let m = parse_manifest(&dir).map_err(|e| e.to_string())?;
        if m.id != id {
            return Err(format!("its manifest names it “{}”", m.id));
        }
        let agreed = |k: &str| installed.agreed.iter().any(|a| a == k);
        let uses = m.uses.into_iter().filter(|(k, _)| agreed(k)).collect();
        let provides = m
            .provides
            .into_iter()
            .filter(|r| agreed(&super::capabilities::role_key(r)))
            .collect();
        Ok(Granted {
            id: id.to_string(),
            name: m.name,
            version: m.version.to_string(),
            dir,
            main: m.main,
            uses,
            settings: m.settings,
            widgets: m.widgets,
            provides,
            namespace: installed.market.to_lowercase(),
        })
    }

    /// The agreed `uses.<key>`, or `permission`: it wasn't asked for, or not agreed to.
    pub fn needs(&self, key: &str, what: &str) -> Result<&Value, HostError> {
        self.uses.get(key).ok_or_else(|| {
            permission(format!(
                "{} didn't ask to {what} when it was installed (uses.{key})",
                self.id
            ))
        })
    }

    /// `uses.<key>.<field>` is `true`.
    pub fn flag(&self, key: &str, field: &str) -> bool {
        self.uses.get(key).and_then(|v| v.get(field)) == Some(&Value::Bool(true))
    }

    /// The strings listed in `uses.<key>.<field>`.
    pub fn words(&self, key: &str, field: &str) -> Vec<String> {
        self.uses
            .get(key)
            .and_then(|v| v.get(field))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    }

    pub fn setting(&self, key: &str) -> Option<&SettingDef> {
        self.settings.iter().find(|s| s.key == key)
    }

    /// It takes role `role` in Connect (its manifest's `provides`, agreed to).
    pub fn provides(&self, role: &str) -> bool {
        self.provides.iter().any(|r| r == role)
    }
}

/// The pickers `system.pickFolder` and `system.pickFiles` open: the native ones in the app,
/// stand-ins in tests.
pub trait FolderPicker: Send + Sync {
    /// The folder the user chose, or `None` when they cancelled.
    fn pick(&self, title: String) -> BoxFuture<'static, Option<PathBuf>>;

    /// The address of one web page the user types in Connect's own box for plugin `name`
    /// (`http.askAddress`), `None` when they cancel.
    fn ask_address(&self, _name: String) -> BoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }

    /// The files the user chose (one unless `multiple`; only `exts` when given), none when they
    /// cancelled.
    fn pick_files(
        &self,
        _title: String,
        _multiple: bool,
        _exts: Vec<String>,
    ) -> BoxFuture<'static, Vec<PathBuf>> {
        Box::pin(async { Vec::new() })
    }
}

/// What the services reach outside Connect: the native ones in the app, stand-ins in tests.
pub struct Outside {
    pub picker: Arc<dyn FolderPicker>,
    pub signin: Arc<dyn signin::SignInSource>,
    pub http: http::Client,
}

/// Connect's services for every loaded plugin.
pub struct Services {
    me: Weak<Services>,
    pub(crate) paths: PluginPaths,
    /// The open workspace (records, Claude, notifications); `None` only in tests of services
    /// that don't use it.
    core: Option<Arc<Core>>,
    plugins: RwLock<HashMap<String, Arc<Granted>>>,
    outside: Outside,
    /// The host the plugins run in, for deliveries to another plugin and `shared_changed`.
    host: OnceLock<Weak<PluginHost>>,
    /// The delivery ways plugins add (`deliver.provide`), by kind.
    providers: Mutex<std::collections::BTreeMap<String, deliver::Provider>>,
    /// The widgets and work rows plugins give by `provide`, and which changed.
    today: Mutex<today::Provided>,
    /// The task ops each provider plugin registered (`tasks.provide`), by plugin.
    pub(crate) task_plugins: Mutex<std::collections::BTreeMap<String, Vec<String>>>,
    /// The reply-context ops each provider plugin registered (`replyContext.provide`), by plugin.
    pub(crate) voice_plugins: Mutex<std::collections::BTreeMap<String, Vec<String>>>,
    /// `ctx.profiles()`, refreshed by the plugin manager (detection is too slow for a turn).
    profiles: RwLock<Value>,
    /// Orders guarded writes (`{ifSha, createNew}`): a comparison and its write are one step.
    pub(crate) writes: Mutex<()>,
    /// The file handles plugins were given (`pickFiles`, dropped files).
    pub(crate) files: Mutex<files::Handles>,
    /// The Claude runs going on under a key (`claude.run({key})`, `claude.stop(key)`).
    pub(crate) runs: Mutex<claude::Keyed>,
    /// The addresses the user typed for plugins (`http.askAddress`), each good for one read.
    pub(crate) asked: Mutex<web::Asked>,
}

impl Services {
    pub fn new(paths: PluginPaths, core: Option<Arc<Core>>, outside: Outside) -> Arc<Services> {
        Arc::new_cyclic(|me| Services {
            me: me.clone(),
            paths,
            core,
            plugins: RwLock::new(HashMap::new()),
            outside,
            host: OnceLock::new(),
            providers: Mutex::default(),
            today: Mutex::default(),
            task_plugins: Mutex::default(),
            voice_plugins: Mutex::default(),
            profiles: RwLock::new(serde_json::json!({"default": null, "profiles": []})),
            writes: Mutex::new(()),
            files: Mutex::default(),
            runs: Mutex::default(),
            asked: Mutex::default(),
        })
    }

    /// The host the plugins run in.
    pub fn set_host(&self, host: &Arc<PluginHost>) {
        let _ = self.host.set(Arc::downgrade(host));
    }

    fn host(&self) -> Result<Arc<PluginHost>, HostError> {
        self.host
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| HostError::new(ErrorCode::NotFound, "Connect's plugins have stopped"))
    }

    /// Keeps what `ctx.profiles()` answers.
    pub fn set_profiles(&self, profiles: Value) {
        *self
            .profiles
            .write()
            .unwrap_or_else(PoisonError::into_inner) = profiles;
    }

    /// What `ctx.profiles()` answers now.
    pub(crate) fn profiles_now(&self) -> Value {
        self.profiles
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The providers plugins registered, for the plugin manager to ask.
    pub(crate) fn today(&self) -> &Mutex<today::Provided> {
        &self.today
    }

    /// Every loaded plugin's grants.
    pub fn loaded(&self) -> Vec<Arc<Granted>> {
        self.plugins
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect()
    }

    /// Lets the plugin use its services (it is being loaded).
    pub fn register(&self, granted: Granted) {
        self.plugins
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(granted.id.clone(), Arc::new(granted));
    }

    /// Ends the plugin's services (it was unloaded): its delivery ways, providers, task ops and
    /// reply-context ops go too.
    pub fn forget(&self, id: &str) {
        self.plugins
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
        lock(&self.providers).retain(|_, p| p.plugin != id);
        lock(&self.today).forget(id);
        lock(&self.task_plugins).remove(id);
        lock(&self.voice_plugins).remove(id);
    }

    /// The grants of a loaded plugin.
    pub fn granted(&self, id: &str) -> Result<Arc<Granted>, HostError> {
        self.plugins
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
            .ok_or_else(|| {
                HostError::new(ErrorCode::NotFound, format!("{id} isn't loaded in Connect"))
            })
    }

    fn arc(&self) -> Result<Arc<Services>, HostError> {
        self.me
            .upgrade()
            .ok_or_else(|| HostError::new(ErrorCode::NotFound, "Connect's plugins have stopped"))
    }

    fn core(&self) -> Result<&Arc<Core>, HostError> {
        self.core
            .as_ref()
            .ok_or_else(|| HostError::new(ErrorCode::Unsupported, "Connect's workspace isn't open"))
    }

    /// Plugins write nothing into the data folder while it is being moved.
    fn writable(&self) -> Result<(), HostError> {
        if self.core.as_ref().is_some_and(|c| c.is_held()) {
            return Err(HostError::new(
                ErrorCode::Limit,
                "Connect is moving its data folder; try again after it restarts",
            ));
        }
        Ok(())
    }

    /// A plugin's own folder of Connect's files about it (outside its store).
    pub fn data_of(&self, id: &str) -> PathBuf {
        self.paths.data_of(id)
    }

    /// The native folder picker, for the user's own choices (a marketplace folder).
    pub async fn pick_folder(&self, title: &str) -> Option<PathBuf> {
        self.outside.picker.pick(title.to_string()).await
    }
}

impl HostServices for Services {
    fn sync(&self, plugin: &str, name: &str, args: Value) -> Result<Value, HostError> {
        let p = self.granted(plugin)?;
        match name {
            "log" => notify::log(&p, &args),
            "notify" => notify::notify(self, &p, &args),
            "markdown" => markdown::render(&p.id, &args),
            "markdown.links" => markdown::links(&args),
            "claude.stop" => claude::stop(self, &p, text(&args, 0, "a run's key")?),
            "crypto.sha256" => Ok(Value::from(cas::sha_hex(
                text(&args, 0, "the text to hash")?.as_bytes(),
            ))),
            n if n.starts_with("store.") || n.starts_with("package.") => {
                store::call(self, &p, n, &args)
            }
            "settings.get" => Ok(settings::get(self, &p, text(&args, 0, "a setting's key")?)),
            "settings.set" => {
                settings::set(self, &p, text(&args, 0, "a setting's key")?, at(&args, 1))
            }
            "system.which" => fs::which(text(&args, 0, "a program's name")?),
            n if n.starts_with("fs.") => fs::call(self, &p, n, &args),
            "profiles" => Ok(self
                .profiles
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()),
            n if n.starts_with("inbox.") || n.starts_with("widgets.") || n.starts_with("work.") => {
                today::call(self, &p, n, &args)
            }
            n if n.starts_with("deliver.") => deliver::call(self, &p, n, &args),
            n if n.starts_with("tasks.") => tasks::call(self, &p, n, &args),
            "replyContext.provide" => reply_context::call(self, &p, name, &args),
            "echo.read" => echo_read::read(self, &p, &args),
            "echo.dictionary.add" => echo_read::dictionary_add(self, &p, at(&args, 0)),
            "shared.get" => events::shared_get(self, text(&args, 0, "a shared key")?),
            "shared.set" => {
                events::shared_set(self, &p, text(&args, 0, "a shared key")?, at(&args, 1))
            }
            n if n.starts_with("signin.") => signin::call(self, &p, n, &args),
            _ => Err(unsupported(name)),
        }
    }

    fn spawn_async(
        &self,
        plugin: &str,
        name: &str,
        args: Value,
    ) -> BoxFuture<'static, Result<Value, HostError>> {
        let ready = self.granted(plugin).and_then(|p| Ok((p, self.arc()?)));
        let (p, me) = match ready {
            Ok(ready) => ready,
            Err(e) => return Box::pin(async move { Err(e) }),
        };
        let name = name.to_string();
        Box::pin(async move {
            match name.as_str() {
                "fs.readMany" | "fs.walk" | "fs.search" => fs::call_async(me, p, &name, args).await,
                "store.walk" => store::walk(me, p, args).await,
                "web.read" => web::read(&me, &p, &args).await,
                n if n.starts_with("m365.") => m365::call(&me, &p, n, &args).await,
                "replyContext.sent" => reply_context::sent(&me, &p, &args),
                "http.askAddress" => web::ask_address(&me, &p).await,
                n if n.starts_with("git.") => git(me, p, n, args).await,
                "system.pickFolder" => fs::pick_folder(&me, &p, &args).await,
                "system.pickFiles" => files::pick(&me, &p, &args).await,
                "fs.copyIn" => {
                    tauri::async_runtime::spawn_blocking(move || files::copy_in(&me, &p, &args))
                        .await
                        .map_err(|e| bad(e.to_string()))?
                }
                "http.fetch" => {
                    let url = text(&args, 0, "an address")?.to_string();
                    let listed = settings::listed_addresses(&me, &p);
                    me.outside.http.fetch(&p, &listed, &url, at(&args, 1)).await
                }
                "claude.run" => claude::run(&me, &p, at(&args, 0)).await,
                "deliver.send" => {
                    let kind = text(&args, 0, "a way to send")?.to_string();
                    deliver::send(&me, &p, &kind, at(&args, 1)).await
                }
                "signin.get" => signin::get(&me, &p, &args).await,
                _ => Err(unsupported(&name)),
            }
        })
    }
}

/// `ctx.git.<name>(root, …)` in a folder the user gave the plugin (`init` and `commit` change it:
/// `folders.write`), off the async runtime.
async fn git(
    s: Arc<Services>,
    p: Arc<Granted>,
    name: &str,
    args: Value,
) -> Result<Value, HostError> {
    let op = name.trim_start_matches("git.").to_string();
    let root = text(&args, 0, "a folder")?.to_string();
    let dir = if vault_git::writes(&op) {
        fs::writable_root(&s, &p, &root)?
    } else {
        fs::root_of(&s, &p, &root)?
    };
    tauri::async_runtime::spawn_blocking(move || vault_git::call(&dir, &p.id, &op, &args))
        .await
        .map_err(|e| bad(e.to_string()))?
}

// ------------------------------------------------------------------ shared helpers

/// A lock whose holder panicked is still usable: the state is plain data.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The `i`th argument (missing ones are `null`).
pub(crate) fn at(args: &Value, i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

/// The `i`th argument as text, or `plugin_error` naming `what` it should be.
pub(crate) fn text<'a>(args: &'a Value, i: usize, what: &str) -> Result<&'a str, HostError> {
    at(args, i)
        .as_str()
        .ok_or_else(|| bad(format!("this needs {what} as text")))
}

pub(crate) fn bad(message: impl Into<String>) -> HostError {
    HostError::new(ErrorCode::PluginError, message)
}

pub(crate) fn permission(message: impl Into<String>) -> HostError {
    HostError::new(ErrorCode::Permission, message)
}

pub(crate) fn unsupported(name: &str) -> HostError {
    HostError::new(
        ErrorCode::Unsupported,
        format!("{name} is not available in CodeMie Connect yet"),
    )
}

/// A file-system failure as the plugin hears it.
pub(crate) fn io_failed(what: &str, e: &std::io::Error) -> HostError {
    match e.kind() {
        std::io::ErrorKind::NotFound => {
            HostError::new(ErrorCode::NotFound, format!("{what}: it isn't there"))
        }
        std::io::ErrorKind::PermissionDenied => permission(format!("{what}: access denied")),
        _ => bad(format!("{what}: {e}")),
    }
}

/// Reads a JSON file Connect keeps for a plugin; missing or unreadable reads as `fallback`.
pub(crate) fn read_json(path: &std::path::Path, fallback: Value) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(fallback)
}

/// Writes a JSON file Connect keeps for a plugin, atomically.
pub(crate) fn write_json(path: &std::path::Path, value: &Value) -> Result<(), HostError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| io_failed("save it", &e))?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| bad(e.to_string()))?;
    crate::storage::location::write_atomic(path, &bytes).map_err(|e| io_failed("save it", &e))
}

#[cfg(test)]
pub(crate) mod testing {
    //! A plugin's grants and Connect's services over a temp data root, for the services' tests.
    use super::*;
    use crate::plugins::host::HostServices;
    pub use crate::testing::{FakeGh, Picked};
    use serde_json::json;

    pub struct Env {
        pub dir: tempfile::TempDir,
        pub services: Arc<Services>,
        pub picker: Arc<Picked>,
        pub gh: Arc<FakeGh>,
    }

    impl Env {
        pub fn new() -> Env {
            Env::with(None, http::Client::new())
        }

        pub fn with(core: Option<Arc<Core>>, http: http::Client) -> Env {
            // Not a hidden folder (`.tmpXXXX`): folders given to plugins never are.
            let dir = tempfile::Builder::new()
                .prefix("connect-")
                .tempdir()
                .unwrap();
            let data = dir.path().join("data");
            std::fs::create_dir_all(&data).unwrap();
            let paths = PluginPaths::new(&data, &dir.path().join("private"));
            let picker = Arc::new(Picked::default());
            let gh = Arc::new(FakeGh::default());
            let outside = Outside {
                picker: picker.clone(),
                signin: gh.clone(),
                http,
            };
            let services = Services::new(paths, core, outside);
            Env {
                dir,
                services,
                picker,
                gh,
            }
        }

        /// Registers plugin `id` with these agreed `uses` and settings; its package folder holds
        /// `files`.
        pub fn plugin(&self, id: &str, uses: Value, settings: Value) -> Arc<Granted> {
            self.plugin_with(id, uses, settings, json!([]), &[])
        }

        /// Registers plugin `id` taking these roles (`provides`, agreed to).
        pub fn provider(&self, id: &str, roles: &[&str], settings: Value) -> Arc<Granted> {
            self.register_with(id, json!({}), settings, json!([]), &[], roles)
        }

        pub fn plugin_with(
            &self,
            id: &str,
            uses: Value,
            settings: Value,
            widgets: Value,
            files: &[(&str, &str)],
        ) -> Arc<Granted> {
            self.register_with(id, uses, settings, widgets, files, &[])
        }

        fn register_with(
            &self,
            id: &str,
            uses: Value,
            settings: Value,
            widgets: Value,
            files: &[(&str, &str)],
            roles: &[&str],
        ) -> Arc<Granted> {
            let dir = self.services.paths.installed().join(id).join("1.0.0");
            std::fs::create_dir_all(&dir).unwrap();
            for (name, text) in files {
                let f = dir.join(name);
                std::fs::create_dir_all(f.parent().unwrap()).unwrap();
                std::fs::write(f, text).unwrap();
            }
            self.services.register(Granted {
                id: id.into(),
                name: format!("{id} plugin"),
                version: "1.0.0".into(),
                dir,
                main: Some("main.js".into()),
                uses: serde_json::from_value(uses).unwrap(),
                settings: serde_json::from_value(settings).unwrap(),
                widgets: serde_json::from_value(widgets).unwrap(),
                provides: roles.iter().map(|r| r.to_string()).collect(),
                namespace: "acme".into(),
            });
            self.services.granted(id).unwrap()
        }

        pub fn call(&self, id: &str, name: &str, args: Value) -> Result<Value, HostError> {
            self.services.sync(id, name, args)
        }

        pub async fn call_async(
            &self,
            id: &str,
            name: &str,
            args: Value,
        ) -> Result<Value, HostError> {
            self.services.spawn_async(id, name, args).await
        }
    }

    /// A JSON answer's shape, to compare with what Echo gives: an object's keys with their
    /// shapes, a list's first item's shape (`"empty"` for none), else the type's name.
    pub fn shape(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                Value::Object(m.iter().map(|(k, x)| (k.clone(), shape(x))).collect())
            }
            Value::Array(a) => json!([a.first().map(shape).unwrap_or(json!("empty"))]),
            Value::String(_) => json!("str"),
            Value::Number(_) => json!("num"),
            Value::Bool(_) => json!("bool"),
            Value::Null => json!("null"),
        }
    }

    /// Whether `v` has at least the keys of `want` (a `shape`), each of its shape: Echo's answer,
    /// which may say more. `"empty"` takes any list.
    pub fn has_shape(v: &Value, want: &Value) -> bool {
        match (v, want) {
            (_, Value::String(t)) if t == "empty" => v.is_array(),
            (Value::Object(m), Value::Object(w)) => w
                .iter()
                .all(|(k, x)| m.get(k).is_some_and(|y| has_shape(y, x))),
            (Value::Array(a), Value::Array(w)) => match (a.first(), w.first()) {
                (Some(x), Some(y)) => has_shape(x, y),
                (None, _) => true,
                _ => false,
            },
            _ => shape(v) == *want,
        }
    }
}
