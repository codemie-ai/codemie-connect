//! `ctx.tasks` (task-provider design §5): `provide({status, list, changedSince, create, update,
//! complete, remove})` registers the plugin as a task provider. Only a plugin whose manifest
//! `provides: ["tasks"]` (agreed to on its sheet) may; each function it gives becomes the provider
//! `tasks:<op>` in its prelude, and Connect records which ops it has here. The record goes when the
//! plugin unloads (`Services::forget`). The core reaches the ops through the plugin manager's
//! `TaskProviders`.
use super::{at, lock, permission, Granted, Services};
use crate::plugins::host::HostError;
use serde_json::Value;

/// The ops a task provider can give.
pub const OPS: [&str; 7] = [
    "status",
    "list",
    "changedSince",
    "create",
    "update",
    "complete",
    "remove",
];

pub fn call(s: &Services, p: &Granted, name: &str, args: &Value) -> Result<Value, HostError> {
    match name {
        "tasks.provide" => {
            if !p.provides("tasks") {
                return Err(permission(format!(
                    "{} doesn't provide tasks (provides in its manifest)",
                    p.id
                )));
            }
            let given: Vec<&str> = at(args, 0)
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let ops = OPS
                .iter()
                .filter(|op| given.contains(op))
                .map(|op| op.to_string())
                .collect();
            lock(&s.task_plugins).insert(p.id.clone(), ops);
            Ok(Value::Null)
        }
        _ => Err(super::unsupported(name)),
    }
}

/// The ops plugin `id` registered, `None` when it hasn't (or isn't loaded).
pub fn ops_of(s: &Services, id: &str) -> Option<Vec<String>> {
    lock(&s.task_plugins).get(id).cloned()
}

#[cfg(test)]
mod tests {
    use super::super::testing::Env;
    use super::*;
    use crate::plugins::host::ErrorCode;
    use serde_json::json;

    #[test]
    fn provide_records_the_known_ops_and_unloading_drops_them() {
        let env = Env::new();
        env.provider("todoist", &["tasks"], json!([]));
        let out = env.call(
            "todoist",
            "tasks.provide",
            json!([["status", "list", "teleport"]]),
        );
        assert_eq!(out, Ok(Value::Null));
        assert_eq!(
            ops_of(&env.services, "todoist"),
            Some(vec!["status".to_string(), "list".to_string()])
        );
        env.services.forget("todoist");
        assert_eq!(ops_of(&env.services, "todoist"), None);
    }

    #[test]
    fn provide_is_refused_without_the_role() {
        let env = Env::new();
        env.plugin("sneaky", json!({}), json!([]));
        let e = env
            .call("sneaky", "tasks.provide", json!([["status"]]))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Permission);
        assert_eq!(
            e.message,
            "sneaky doesn't provide tasks (provides in its manifest)"
        );
        assert_eq!(ops_of(&env.services, "sneaky"), None);
    }
}
