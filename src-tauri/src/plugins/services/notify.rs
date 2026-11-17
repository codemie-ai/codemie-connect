//! `ctx.notify(title, body)`: a system notification, when the user lets Connect notify; and
//! `ctx.log(...)`: a line `[plugin:<id>] …` in the app log.
use super::{at, Granted, Services};
use crate::plugins::host::HostError;
use serde_json::Value;

const MAX_LOG: usize = 2000;
const MAX_TITLE: usize = 120;
const MAX_BODY: usize = 400;

/// One line of plain text: control characters dropped, at most `max` characters.
fn line(v: &Value, max: usize) -> String {
    let text = match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    text.chars()
        .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}

pub fn log(p: &Granted, args: &Value) -> Result<Value, HostError> {
    log::info!("[plugin:{}] {}", p.id, line(at(args, 0), MAX_LOG));
    Ok(Value::Null)
}

pub fn notify(s: &Services, p: &Granted, args: &Value) -> Result<Value, HostError> {
    let title = line(at(args, 0), MAX_TITLE);
    let body = line(at(args, 1), MAX_BODY);
    let title = if title.is_empty() {
        p.name.clone()
    } else {
        title
    };
    if let Ok(core) = s.core() {
        core.plugin_notify(&title, &body);
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn log_and_notify_text_is_one_bounded_line() {
        assert_eq!(line(&json!("a\nb\u{7}c\td"), 10), "a bc d");
        assert_eq!(line(&json!("x".repeat(50)), 5), "xxxxx");
        assert_eq!(line(&json!({"a": 1}), 20), "{\"a\":1}");
        assert_eq!(line(&Value::Null, 20), "");
    }
}
