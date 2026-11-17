//! The workspace's side of the plugin host (DESIGN 7.2): what `plugins::services` asks of `Core`.
use super::Core;
use tauri_plugin_notification::NotificationExt;

impl Core {
    /// A plugin's notification, shown only while the user lets Connect notify.
    pub(crate) fn plugin_notify(&self, title: &str, body: &str) {
        let allowed = self
            .repo()
            .and_then(|r| r.settings())
            .is_ok_and(|s| s.notifications);
        let Some(app) = self.app.as_ref().filter(|_| allowed) else {
            return;
        };
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            log::warn!("plugins: a notification wasn't shown: {e}");
        }
    }
}
