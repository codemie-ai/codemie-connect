// Install-plan model + loader. Ports src/main/steps.js + models.js (data half).
// The plan is embedded at compile time and parsed with serde_yaml.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
pub struct Step {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub requires_approval: bool,
    pub approval_message: String,
    pub is_sub_step: bool,
    pub parent_id: Option<String>,
    pub spinner: bool,
    pub interactive: bool,
    pub fatal: bool,
    pub fatal_recommendation: String,
}

#[derive(Deserialize)]
struct StepsDoc {
    steps: Vec<RawStep>,
}

#[derive(Deserialize)]
struct RawStep {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    requires_approval: bool,
    #[serde(default)]
    approval_message: String,
    #[serde(default)]
    is_sub_step: bool,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    spinner: bool,
    #[serde(default)]
    interactive: bool,
    #[serde(default)]
    fatal: bool,
    #[serde(default)]
    fatal_recommendation: String,
}

const STEPS_YAML: &str = include_str!("../../config/steps.yaml");

fn make_step(r: RawStep) -> Step {
    Step {
        id: r.id,
        title: r.title,
        description: r.description,
        status: "PENDING".to_string(),
        requires_approval: r.requires_approval,
        approval_message: r.approval_message,
        is_sub_step: r.is_sub_step,
        parent_id: r.parent_id,
        spinner: r.spinner,
        interactive: r.interactive,
        fatal: r.fatal,
        fatal_recommendation: r.fatal_recommendation,
    }
}

pub fn load_steps() -> Vec<Step> {
    let doc: StepsDoc = serde_yaml::from_str(STEPS_YAML).expect("config/steps.yaml must parse");
    doc.steps.into_iter().map(make_step).collect()
}

#[tauri::command]
pub fn get_steps() -> Vec<Step> {
    load_steps()
}

/// The logo is shipped as a same-origin static asset in the frontend dir, so the
/// renderer can load it directly (CSP img-src 'self'); no asset protocol needed.
#[tauri::command]
pub fn get_logo_path() -> String {
    "codemie-logo.svg".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/steps.test.js (loadSteps half).
    #[test]
    fn loads_eight_steps_with_defaults() {
        let steps = load_steps();
        let ids: Vec<&str> = steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            ["1.1", "1.1.1", "1.2", "1.2.1", "1.3", "2.3.3", "2.3.5", "2.4"]
        );

        let git = steps.iter().find(|s| s.id == "1.1").unwrap();
        assert!(git.fatal);
        assert!(!git.requires_approval);
        assert!(!git.is_sub_step);
        assert_eq!(git.status, "PENDING");

        let sub = steps.iter().find(|s| s.id == "1.1.1").unwrap();
        assert!(sub.is_sub_step);
        assert_eq!(sub.parent_id.as_deref(), Some("1.1"));
        assert!(sub.requires_approval);
        assert!(!sub.approval_message.is_empty());

        let setup = steps.iter().find(|s| s.id == "2.3.3").unwrap();
        assert!(setup.interactive);
    }
}
