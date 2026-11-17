//! Connect's side of `ctx` (PLUGIN-ENGINE.md §4 and §8, DESIGN 7.2): the services a plugin's host
//! half reaches through `HostServices`. The plugin host names the plugin on every call (never the
//! plugin's own arguments), and every call is checked here, on the Rust side, against the sheet
//! the user agreed to (`Granted`): a plugin's own checks are a courtesy, not protection.
//!
//! Where a plugin's things live (`PluginPaths`):
//! - `<data>/plugins/data/<id>/store/`: its store (`store`).
//! - `<data>/plugins/data/<id>/`: Connect's own files about it, outside the store so the plugin
//!   can't write them: `settings.json`, `folders.json` (the folders it was given).
//! - `<private>/credentials/plugins/<id>/`: its `secret` settings, 0600 in a 0700 folder.
//!
//! The services: `store` (with `package`), `settings`, `fs` (with `system`), `http`, `notify`
//! (with `log`) and `markdown`.
pub mod fs;
pub mod http;
pub mod markdown;
pub mod notify;
pub mod settings;
pub mod store;

use super::host::{ErrorCode, HostError, HostServices};
use super::manifest::{parse_manifest, SettingDef, WidgetDef};
use super::registry::{Installed, PluginPaths};
use crate::workspace::Core;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, PoisonError, RwLock, Weak};

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
        let uses = m
            .uses
            .into_iter()
            .filter(|(k, _)| installed.agreed.iter().any(|a| a == k))
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
}

/// The folder picker `system.pickFolder` opens: the native one in the app, a stand-in in tests.
pub trait FolderPicker: Send + Sync {
    /// The folder the user chose, or `None` when they cancelled.
    fn pick(&self, title: String) -> BoxFuture<'static, Option<PathBuf>>;
}

/// Connect's services for every loaded plugin.
pub struct Services {
    me: Weak<Services>,
    pub(crate) paths: PluginPaths,
    /// The open workspace (records, Claude, notifications); `None` only in tests of services
    /// that don't use it.
    core: Option<Arc<Core>>,
    plugins: RwLock<HashMap<String, Arc<Granted>>>,
    http: http::Client,
    picker: Arc<dyn FolderPicker>,
}

impl Services {
    pub fn new(
        paths: PluginPaths,
        core: Option<Arc<Core>>,
        picker: Arc<dyn FolderPicker>,
    ) -> Arc<Services> {
        Services::with_http(paths, core, picker, http::Client::new())
    }

    pub fn with_http(
        paths: PluginPaths,
        core: Option<Arc<Core>>,
        picker: Arc<dyn FolderPicker>,
        http: http::Client,
    ) -> Arc<Services> {
        Arc::new_cyclic(|me| Services {
            me: me.clone(),
            paths,
            core,
            plugins: RwLock::new(HashMap::new()),
            http,
            picker,
        })
    }

    /// Lets the plugin use its services (it is being loaded).
    pub fn register(&self, granted: Granted) {
        self.plugins
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(granted.id.clone(), Arc::new(granted));
    }

    /// Ends the plugin's services (it was unloaded).
    pub fn forget(&self, id: &str) {
        self.plugins
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
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
}

impl HostServices for Services {
    fn sync(&self, plugin: &str, name: &str, args: Value) -> Result<Value, HostError> {
        let p = self.granted(plugin)?;
        match name {
            "log" => notify::log(&p, &args),
            "notify" => notify::notify(self, &p, &args),
            "markdown" => markdown::render(&args),
            n if n.starts_with("store.") || n.starts_with("package.") => {
                store::call(self, &p, n, &args)
            }
            "settings.get" => Ok(settings::get(self, &p, text(&args, 0, "a setting's key")?)),
            "settings.set" => {
                settings::set(self, &p, text(&args, 0, "a setting's key")?, at(&args, 1))
            }
            "system.which" => fs::which(text(&args, 0, "a program's name")?),
            n if n.starts_with("fs.") => fs::call(self, &p, n, &args),
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
                "fs.readMany" | "fs.walk" => fs::call_async(me, p, &name, args).await,
                "system.pickFolder" => fs::pick_folder(&me, &p, &args).await,
                "http.fetch" => {
                    let url = text(&args, 0, "an address")?.to_string();
                    let listed = settings::listed_addresses(&me, &p);
                    me.http.fetch(&p, &listed, &url, at(&args, 1)).await
                }
                _ => Err(unsupported(&name)),
            }
        })
    }
}

// ------------------------------------------------------------------ shared helpers

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
    use serde_json::json;
    use std::sync::Mutex;

    /// Answers the folder picker with whatever the test put in it.
    #[derive(Default)]
    pub struct Picked(pub Mutex<Option<PathBuf>>);

    impl FolderPicker for Picked {
        fn pick(&self, _title: String) -> BoxFuture<'static, Option<PathBuf>> {
            let picked = self.0.lock().unwrap().take();
            Box::pin(async move { picked })
        }
    }

    pub struct Env {
        pub dir: tempfile::TempDir,
        pub services: Arc<Services>,
        pub picker: Arc<Picked>,
    }

    impl Env {
        pub fn new() -> Env {
            Env::with(None, http::Client::new())
        }

        pub fn with(core: Option<Arc<Core>>, http: http::Client) -> Env {
            let dir = tempfile::tempdir().unwrap();
            let data = dir.path().join("data");
            std::fs::create_dir_all(&data).unwrap();
            let paths = PluginPaths::new(&data, &dir.path().join("private"));
            let picker = Arc::new(Picked::default());
            let services = Services::with_http(paths, core, picker.clone(), http);
            Env {
                dir,
                services,
                picker,
            }
        }

        /// Registers plugin `id` with these agreed `uses` and settings; its package folder holds
        /// `files`.
        pub fn plugin(&self, id: &str, uses: Value, settings: Value) -> Arc<Granted> {
            self.plugin_with(id, uses, settings, json!([]), &[])
        }

        pub fn plugin_with(
            &self,
            id: &str,
            uses: Value,
            settings: Value,
            widgets: Value,
            files: &[(&str, &str)],
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
}
