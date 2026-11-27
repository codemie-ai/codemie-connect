//! Reads Claude's `stream-json` output (one JSON object per line) into events and a
//! final outcome, and sorts failures into the classes of DESIGN 6.2.
use serde::Serialize;
use serde_json::Value;

/// Keeps non-JSON lines and stderr only for classification.
const NOISE_CAP: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    NotInstalled,
    TooOld,
    NeedsLogin,
    NotConfigured,
    /// The CodeMie server no longer takes this CodeMie CLI (HTTP 426): updating CodeMie fixes it.
    CodemieOutdated,
    /// No profile chosen yet (set by the caller, never by the runner).
    NeedsChoice,
    RateLimited,
    Timeout,
    Cancelled,
    InvalidOutput,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiError {
    pub class: ErrorClass,
    /// One sentence for the user. Never raw process output.
    pub message: String,
    /// What a run that ended in an error still reported (cost, tokens, duration, model), so
    /// the ledger counts it: a CodeMie run stopped by `--max-budget-usd` was still paid for.
    pub spent: Option<Box<RunOutcome>>,
}

impl AiError {
    pub fn new(class: ErrorClass) -> Self {
        let message = match class {
            ErrorClass::NotInstalled => "Claude Code is not installed.",
            ErrorClass::TooOld => "This Claude Code is too old for AI features.",
            ErrorClass::NeedsLogin => "Claude is not signed in.",
            ErrorClass::NotConfigured => "The CodeMie profile is not fully configured.",
            ErrorClass::CodemieOutdated => "This CodeMie CLI is too old for CodeMie. Update CodeMie in Settings › CodeMie, then try again.",
            ErrorClass::NeedsChoice => "Choose which Claude should write for you.",
            ErrorClass::RateLimited => "Claude is rate limited right now.",
            ErrorClass::Timeout => "Claude took too long to answer.",
            ErrorClass::Cancelled => "The request was cancelled.",
            ErrorClass::InvalidOutput => "Claude returned an answer that could not be used.",
            ErrorClass::Failed => "Claude could not complete the request.",
        };
        Self {
            class,
            message: message.to_string(),
            spent: None,
        }
    }

    /// The error with what the run reported before it failed.
    pub fn with_spent(mut self, outcome: RunOutcome) -> Self {
        self.spent = Some(Box::new(outcome));
        self
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEvent {
    Started {
        version: Option<String>,
        model: Option<String>,
    },
    RateLimit {
        status: String,
        kind: Option<String>,
    },
    Progress {
        elapsed_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    pub structured: Option<Value>,
    pub text: String,
    pub usage: Usage,
    pub cost_usd: Option<f64>,
    pub duration_ms: u64,
    pub model: Option<String>,
}

/// Sorts error text (a result message, a CodeMie message, stderr) into a class.
pub fn classify_text(text: &str) -> Option<ErrorClass> {
    let t = text.to_lowercase();
    let has = |n: &str| t.contains(n);
    if has("unsupported codemie cli version") {
        Some(ErrorClass::CodemieOutdated)
    } else if has("configuration incomplete") {
        Some(ErrorClass::NotConfigured)
    } else if has("not logged in")
        || has("/login")
        || has("oauth token has expired")
        || has("authentication_error")
        || has("authentication required")
    {
        Some(ErrorClass::NeedsLogin)
    } else if has("rate limit") || has("rate_limit") || has_http_429(&t) {
        Some(ErrorClass::RateLimited)
    } else {
        None
    }
}

/// A standalone `429` next to HTTP-ish words; digits inside other numbers (a node
/// warning like `(node:42913)`) do not count.
fn has_http_429(t: &str) -> bool {
    let b = t.as_bytes();
    let standalone = t.match_indices("429").any(|(i, _)| {
        let before = i == 0 || !b[i - 1].is_ascii_alphanumeric();
        let after = i + 3 >= b.len() || !b[i + 3].is_ascii_alphanumeric();
        before && after
    });
    standalone
        && ["status", "http", "error", "too many", "rate"]
            .iter()
            .any(|w| t.contains(w))
}

fn status_blocks(status: &str) -> bool {
    !matches!(status, "allowed" | "allowed_warning")
}

fn u64_at(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// Incremental reader: feed lines as they arrive, then `finish`.
#[derive(Default)]
pub struct StreamParser {
    model: Option<String>,
    rate_limited: bool,
    result: Option<Value>,
    noise: String,
}

impl StreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads one line; returns an event when the line carries one. Lines that are not
    /// JSON objects are tolerated and kept (capped) for classification.
    pub fn feed(&mut self, line: &str) -> Option<RunEvent> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v @ Value::Object(_)) => v,
            _ => {
                self.add_noise(line);
                return None;
            }
        };
        match v.get("type").and_then(Value::as_str) {
            Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
                let model = v.get("model").and_then(Value::as_str).map(str::to_string);
                self.model = model.clone();
                Some(RunEvent::Started {
                    version: v
                        .get("claude_code_version")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model,
                })
            }
            Some("rate_limit_event") => {
                let info = v.get("rate_limit_info").unwrap_or(&v);
                let status = info.get("status").and_then(Value::as_str)?.to_string();
                if status_blocks(&status) {
                    self.rate_limited = true;
                }
                let kind = info
                    .get("rateLimitType")
                    .or_else(|| info.get("kind"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Some(RunEvent::RateLimit { status, kind })
            }
            Some("result") => {
                self.result = Some(v);
                None
            }
            _ => None,
        }
    }

    pub fn add_noise(&mut self, text: &str) {
        if self.noise.len() < NOISE_CAP {
            self.noise.push_str(text);
            self.noise.push('\n');
        }
    }

    /// The outcome, or the classified error. `extra` is more text to classify from,
    /// typically stderr.
    pub fn finish(self, extra: &str) -> Result<RunOutcome, AiError> {
        let classify = || classify_text(&self.noise).or_else(|| classify_text(extra));
        let Some(r) = &self.result else {
            let class = classify().or(self.rate_limited.then_some(ErrorClass::RateLimited));
            return Err(AiError::new(class.unwrap_or(ErrorClass::Failed)));
        };
        let is_error = r.get("is_error").and_then(Value::as_bool).unwrap_or(false)
            || r.get("subtype").and_then(Value::as_str) != Some("success");
        let text = r
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let usage = r
            .get("usage")
            .map(|u| Usage {
                input_tokens: u64_at(u, "input_tokens"),
                output_tokens: u64_at(u, "output_tokens"),
                cache_read_tokens: u64_at(u, "cache_read_input_tokens"),
                cache_creation_tokens: u64_at(u, "cache_creation_input_tokens"),
            })
            .unwrap_or_default();
        // The init event names the model; otherwise the one that wrote the most.
        let model = self.model.clone().or_else(|| {
            r.get("modelUsage")
                .and_then(Value::as_object)?
                .iter()
                .max_by_key(|(_, u)| u64_at(u, "outputTokens"))
                .map(|(k, _)| k.clone())
        });
        let outcome = RunOutcome {
            structured: r.get("structured_output").filter(|s| !s.is_null()).cloned(),
            text,
            usage,
            cost_usd: r.get("total_cost_usd").and_then(Value::as_f64),
            duration_ms: u64_at(r, "duration_ms"),
            model,
        };
        if is_error {
            let class = classify_text(&outcome.text)
                .or_else(classify)
                .or(self.rate_limited.then_some(ErrorClass::RateLimited));
            let spent = RunOutcome {
                structured: None,
                ..outcome
            };
            return Err(AiError::new(class.unwrap_or(ErrorClass::Failed)).with_spent(spent));
        }
        Ok(outcome)
    }
}

impl RunOutcome {
    /// For runs that asked for a schema: `structured` must be present and an object.
    pub fn require_structured_object(self) -> Result<Self, AiError> {
        match &self.structured {
            Some(Value::Object(_)) => Ok(self),
            _ => Err(AiError::new(ErrorClass::InvalidOutput).with_spent(self)),
        }
    }
}

/// Whole-output convenience over [`StreamParser`].
#[cfg(test)]
pub fn parse_stream<'a>(lines: impl IntoIterator<Item = &'a str>) -> Result<RunOutcome, AiError> {
    let mut p = StreamParser::new();
    for l in lines {
        p.feed(l);
    }
    p.finish("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(s: &str) -> Vec<&str> {
        s.lines().collect()
    }

    #[test]
    fn parse_stream_success_with_structured_output() {
        let out = parse_stream(lines(include_str!("testdata/success.jsonl"))).unwrap();
        assert_eq!(out.structured, Some(json!({"draft": "Hello"})));
        assert_eq!(out.text, "done");
        assert_eq!(out.model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(out.cost_usd, Some(0.0123));
        assert_eq!(out.duration_ms, 2500);
        assert_eq!(out.usage.input_tokens, 10);
        assert_eq!(out.usage.output_tokens, 20);
        assert_eq!(out.usage.cache_read_tokens, 5);
    }

    #[test]
    fn parse_stream_emits_events() {
        let mut p = StreamParser::new();
        let evs: Vec<_> = include_str!("testdata/success.jsonl")
            .lines()
            .filter_map(|l| p.feed(l))
            .collect();
        assert_eq!(
            evs,
            vec![
                RunEvent::Started {
                    version: Some("2.1.322".into()),
                    model: Some("claude-haiku-4-5".into())
                },
                RunEvent::RateLimit {
                    status: "allowed".into(),
                    kind: Some("five_hour".into())
                }
            ]
        );
    }

    #[test]
    fn parse_stream_tolerates_non_json_lines() {
        let out = parse_stream(lines(include_str!("testdata/noisy.jsonl"))).unwrap();
        assert_eq!(out.text, "ok");
        assert!(out.structured.is_none());
    }

    #[test]
    fn a_codemie_cli_the_server_no_longer_takes_is_named() {
        // What CodeMie answered every run once it required CLI 0.17.2 (2026-11-24): the run
        // ends at once with an error result naming the fix.
        let e = parse_stream([
            r#"{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}"#,
            r#"{"type":"result","subtype":"success","is_error":true,"result":"API Error: 426 {\"detail\":\"Unsupported CodeMie CLI version '0.17.1'. Please upgrade to CodeMie CLI 0.17.2 or higher. Run: npm install -g @codemieai/code\"}","duration_ms":1484}"#,
        ])
        .unwrap_err();
        assert_eq!(e.class, ErrorClass::CodemieOutdated);
        assert_eq!(e.message, "This CodeMie CLI is too old for CodeMie. Update CodeMie in Settings › CodeMie, then try again.");
        // Said on stderr only, as some CLI builds do.
        assert_eq!(
            classify_text("Error: 426 Upgrade Required: unsupported CodeMie CLI version"),
            Some(ErrorClass::CodemieOutdated)
        );
        // Another 426 is not this.
        assert_eq!(classify_text("HTTP 426 from a proxy"), None);
    }

    #[test]
    fn a_failed_result_keeps_what_the_run_cost() {
        // A CodeMie run stopped by `--max-budget-usd` ends in an error result that still says
        // what was spent; the ledger must count it.
        let e = parse_stream([
            r#"{"type":"system","subtype":"init","model":"claude-sonnet-4-5"}"#,
            r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"","total_cost_usd":0.52,"duration_ms":4100,"usage":{"input_tokens":3000,"output_tokens":400}}"#,
        ])
        .unwrap_err();
        assert_eq!(e.class, ErrorClass::Failed);
        let spent = e.spent.expect("the error keeps the run's cost");
        assert_eq!(spent.cost_usd, Some(0.52));
        assert_eq!(spent.duration_ms, 4100);
        assert_eq!(spent.usage.input_tokens, 3000);
        assert_eq!(spent.model.as_deref(), Some("claude-sonnet-4-5"));
        assert!(spent.structured.is_none());
        // An answer without the structured output it was asked for is invalid, and still cost.
        let e = parse_stream([
            r#"{"type":"result","subtype":"success","is_error":false,"result":"prose","total_cost_usd":0.01}"#,
        ])
        .and_then(RunOutcome::require_structured_object)
        .unwrap_err();
        assert_eq!(e.class, ErrorClass::InvalidOutput);
        assert_eq!(e.spent.unwrap().cost_usd, Some(0.01));
        // No result at all: nothing was reported.
        assert!(parse_stream(["noise"]).unwrap_err().spent.is_none());
    }

    #[test]
    fn classify_auth_and_rate_limit_streams() {
        let class = |s: &[&str]| parse_stream(s.iter().copied()).unwrap_err().class;
        assert_eq!(
            class(&[
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#
            ]),
            ErrorClass::NeedsLogin
        );
        assert_eq!(class(&["Authentication required"]), ErrorClass::NeedsLogin);
        assert_eq!(
            class(&["Configuration incomplete"]),
            ErrorClass::NotConfigured
        );
        assert_eq!(
            class(&[
                r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}"#,
                r#"{"type":"result","subtype":"success","is_error":true,"result":"limit"}"#
            ]),
            ErrorClass::RateLimited
        );
        assert_eq!(
            class(&[r#"{"type":"result","subtype":"success","is_error":true,"result":"boom"}"#]),
            ErrorClass::Failed
        );
        assert_eq!(class(&[]), ErrorClass::Failed);
    }

    #[test]
    fn rejected_limit_does_not_fail_a_successful_result() {
        let out = parse_stream(lines(include_str!("testdata/warning.jsonl"))).unwrap();
        assert_eq!(out.text, "fine");
    }

    #[test]
    fn node_warning_in_stderr_is_not_a_rate_limit() {
        let mut p = StreamParser::new();
        let e = p
            .finish("(node:42913) Warning: something deprecated")
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::Failed);
        let e = StreamParser::new()
            .finish("API Error: status 429 Too Many Requests")
            .unwrap_err();
        assert_eq!(e.class, ErrorClass::RateLimited);
        p = StreamParser::new();
        p.feed("noise");
        assert_eq!(p.finish("").unwrap_err().class, ErrorClass::Failed);
    }

    #[test]
    fn successful_text_mentioning_login_stays_ok() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"user is not logged in /login"}"#;
        assert!(parse_stream([line]).is_ok());
    }

    #[test]
    fn schema_requested_needs_a_structured_object() {
        let missing = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"draft\":\"x\"}"}"#;
        let e = parse_stream([missing]).and_then(RunOutcome::require_structured_object);
        assert_eq!(e.unwrap_err().class, ErrorClass::InvalidOutput);
        let scalar = r#"{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":"text"}"#;
        let e = parse_stream([scalar]).and_then(RunOutcome::require_structured_object);
        assert_eq!(e.unwrap_err().class, ErrorClass::InvalidOutput);
        let ok = parse_stream(lines(include_str!("testdata/success.jsonl")))
            .and_then(RunOutcome::require_structured_object);
        assert!(ok.is_ok());
    }

    #[test]
    fn model_comes_from_init_then_busiest_model_usage() {
        let r = r#"{"type":"result","subtype":"success","is_error":false,"result":"","modelUsage":{"a-small":{"outputTokens":1},"z-big":{"outputTokens":9}}}"#;
        assert_eq!(parse_stream([r]).unwrap().model.as_deref(), Some("z-big"));
        let init = r#"{"type":"system","subtype":"init","model":"from-init"}"#;
        assert_eq!(
            parse_stream([init, r]).unwrap().model.as_deref(),
            Some("from-init")
        );
    }

    #[test]
    fn needs_choice_is_a_distinct_class() {
        assert_eq!(
            AiError::new(ErrorClass::NeedsChoice).class,
            ErrorClass::NeedsChoice
        );
    }
}
