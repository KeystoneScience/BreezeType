use log::{debug, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const COMMANDS_STORE_PATH: &str = "commands_store.json";
const OPEN_COMMANDS_KEY: &str = "open_commands";
const SNIPPETS_KEY: &str = "snippets";

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct OpenCommand {
    pub phrase: String,
    pub target: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
#[serde(rename_all = "snake_case")]
pub enum SnippetKind {
    TextExpand,
    PromptExpand,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct SnippetDefinition {
    pub id: String,
    pub triggers: Vec<String>,
    pub kind: SnippetKind,
    pub description: String,
    pub template: String,
    pub variables: Vec<String>,
    pub enabled: bool,
}

#[tauri::command]
#[specta::specta]
pub fn get_open_commands(app: AppHandle) -> Result<Vec<OpenCommand>, String> {
    Ok(load_open_commands(&app))
}

#[tauri::command]
#[specta::specta]
pub fn set_open_commands(app: AppHandle, commands: Vec<OpenCommand>) -> Result<(), String> {
    save_open_commands(&app, commands)
}

#[tauri::command]
#[specta::specta]
pub fn get_snippets(app: AppHandle) -> Result<Vec<SnippetDefinition>, String> {
    Ok(load_snippets(&app))
}

#[tauri::command]
#[specta::specta]
pub fn set_snippets(app: AppHandle, snippets: Vec<SnippetDefinition>) -> Result<(), String> {
    save_snippets(&app, snippets)
}

pub fn resolve_open_command(app: &AppHandle, query: &str) -> Option<String> {
    let query_key = normalize_match_key(query);
    let query_trimmed_key = normalize_match_key(&normalize_open_query(query));
    if query_key.is_empty() && query_trimmed_key.is_empty() {
        return None;
    }

    let commands = load_open_commands(app);
    for command in commands {
        let phrase_key = normalize_match_key(&command.phrase);
        let phrase_trimmed_key = normalize_match_key(&normalize_open_query(&command.phrase));
        if (!query_key.is_empty() && (phrase_key == query_key || phrase_trimmed_key == query_key))
            || (!query_trimmed_key.is_empty()
                && (phrase_key == query_trimmed_key || phrase_trimmed_key == query_trimmed_key))
        {
            return Some(command.target);
        }
    }

    None
}

fn load_open_commands(app: &AppHandle) -> Vec<OpenCommand> {
    let store = match app.store(COMMANDS_STORE_PATH) {
        Ok(store) => store,
        Err(err) => {
            warn!("Failed to init commands store: {}", err);
            return Vec::new();
        }
    };

    if let Some(value) = store.get(OPEN_COMMANDS_KEY) {
        serde_json::from_value::<Vec<OpenCommand>>(value).unwrap_or_else(|err| {
            warn!("Failed to parse open commands: {}", err);
            Vec::new()
        })
    } else {
        Vec::new()
    }
}

fn save_open_commands(app: &AppHandle, commands: Vec<OpenCommand>) -> Result<(), String> {
    let store = app
        .store(COMMANDS_STORE_PATH)
        .map_err(|e| format!("Failed to init commands store: {}", e))?;

    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();
    for command in commands {
        let phrase = command.phrase.trim();
        let target = command.target.trim();
        if phrase.is_empty() || target.is_empty() {
            continue;
        }
        let key = normalize_match_key(phrase);
        if key.is_empty() {
            continue;
        }
        if seen.insert(key) {
            cleaned.push(OpenCommand {
                phrase: phrase.to_string(),
                target: target.to_string(),
            });
        } else {
            debug!("Skipping duplicate open command phrase: {}", phrase);
        }
    }

    store.set(
        OPEN_COMMANDS_KEY,
        serde_json::to_value(cleaned).map_err(|e| e.to_string())?,
    );
    Ok(())
}

fn load_snippets(app: &AppHandle) -> Vec<SnippetDefinition> {
    let store = match app.store(COMMANDS_STORE_PATH) {
        Ok(store) => store,
        Err(err) => {
            warn!("Failed to init commands store: {}", err);
            return default_snippets();
        }
    };

    if let Some(value) = store.get(SNIPPETS_KEY) {
        serde_json::from_value::<Vec<SnippetDefinition>>(value).unwrap_or_else(|err| {
            warn!("Failed to parse snippets: {}", err);
            default_snippets()
        })
    } else {
        default_snippets()
    }
}

fn save_snippets(app: &AppHandle, snippets: Vec<SnippetDefinition>) -> Result<(), String> {
    let store = app
        .store(COMMANDS_STORE_PATH)
        .map_err(|e| format!("Failed to init commands store: {}", e))?;

    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();
    for snippet in snippets {
        let id = snippet.id.trim();
        if id.is_empty() {
            continue;
        }
        if !seen.insert(id.to_string()) {
            debug!("Skipping duplicate snippet id: {}", id);
            continue;
        }
        let triggers: Vec<String> = snippet
            .triggers
            .into_iter()
            .map(|trigger| trigger.trim().to_string())
            .filter(|trigger| !trigger.is_empty())
            .collect();
        if triggers.is_empty() {
            continue;
        }
        let template = snippet.template.trim().to_string();
        if template.is_empty() {
            continue;
        }
        cleaned.push(SnippetDefinition {
            id: id.to_string(),
            triggers,
            kind: snippet.kind,
            description: snippet.description.trim().to_string(),
            template,
            variables: snippet
                .variables
                .into_iter()
                .map(|var| var.trim().to_string())
                .filter(|var| !var.is_empty())
                .collect(),
            enabled: snippet.enabled,
        });
    }

    store.set(
        SNIPPETS_KEY,
        serde_json::to_value(cleaned).map_err(|e| e.to_string())?,
    );
    Ok(())
}

fn normalize_match_key(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn normalize_open_query(query: &str) -> String {
    let mut parts: Vec<&str> = query.split_whitespace().collect();
    while let Some(last) = parts.last() {
        if last.eq_ignore_ascii_case("app") || last.eq_ignore_ascii_case("application") {
            parts.pop();
        } else {
            break;
        }
    }
    parts.join(" ")
}

fn default_snippets() -> Vec<SnippetDefinition> {
    use SnippetKind::{PromptExpand, TextExpand};

    vec![
        SnippetDefinition {
            id: "calendar_link".to_string(),
            triggers: vec![
                "calendar".to_string(),
                "schedule 30 minutes".to_string(),
                "scheduling link".to_string(),
                "c30".to_string(),
            ],
            kind: TextExpand,
            description: "Insert scheduling link message".to_string(),
            template: "You can book {DURATION} with me here: {CAL_URL}".to_string(),
            variables: vec!["DURATION".to_string(), "CAL_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "careers_link".to_string(),
            triggers: vec!["careers link".to_string()],
            kind: TextExpand,
            description: "Drops your jobs page link".to_string(),
            template: "We're hiring - see open roles: {CAREERS_URL}".to_string(),
            variables: vec!["CAREERS_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "media_kit".to_string(),
            triggers: vec!["media kit".to_string()],
            kind: TextExpand,
            description: "Insert press/brand assets link".to_string(),
            template: "Here's our media kit: {MEDIA_KIT_URL}".to_string(),
            variables: vec!["MEDIA_KIT_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "merch_store_link".to_string(),
            triggers: vec!["merch store link".to_string()],
            kind: TextExpand,
            description: "Drop merch store URL".to_string(),
            template: "Merch store: {MERCH_URL}".to_string(),
            variables: vec!["MERCH_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "affiliate_links".to_string(),
            triggers: vec!["affiliate links".to_string()],
            kind: TextExpand,
            description: "Insert affiliate link and disclosure".to_string(),
            template:
                "My affiliate link: {AFFILIATE_URL}\n(Disclosure: I may earn a commission.)"
                    .to_string(),
            variables: vec!["AFFILIATE_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "elevator_pitch".to_string(),
            triggers: vec!["elevator pitch".to_string(), "short pitch".to_string()],
            kind: TextExpand,
            description: "Insert a 1-2 sentence product pitch".to_string(),
            template: "{COMPANY} helps {WHO} achieve {VALUE} by {HOW}.".to_string(),
            variables: vec![
                "COMPANY".to_string(),
                "WHO".to_string(),
                "VALUE".to_string(),
                "HOW".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "company_pitch".to_string(),
            triggers: vec!["company pitch".to_string()],
            kind: TextExpand,
            description: "Insert a longer pitch block".to_string(),
            template: "{COMPANY} is {ONE_LINER}\n\nWhy it matters:\n- {BULLET1}\n- {BULLET2}\n- {BULLET3}".to_string(),
            variables: vec![
                "COMPANY".to_string(),
                "ONE_LINER".to_string(),
                "BULLET1".to_string(),
                "BULLET2".to_string(),
                "BULLET3".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "founder_intro".to_string(),
            triggers: vec!["founder intro".to_string()],
            kind: TextExpand,
            description: "Insert founder introduction".to_string(),
            template: "Hi - I'm {NAME}, {ROLE} at {COMPANY}. {ONE_SENTENCE_MISSION}".to_string(),
            variables: vec![
                "NAME".to_string(),
                "ROLE".to_string(),
                "COMPANY".to_string(),
                "ONE_SENTENCE_MISSION".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "mission_statement".to_string(),
            triggers: vec!["mission statement".to_string()],
            kind: TextExpand,
            description: "Insert mission statement".to_string(),
            template: "Our mission: {MISSION}".to_string(),
            variables: vec!["MISSION".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "short_company_explainer".to_string(),
            triggers: vec!["short company explainer".to_string()],
            kind: TextExpand,
            description: "Insert a longer about-us paragraph".to_string(),
            template:
                "{COMPANY} is {DESCRIPTION}. Available on {PLATFORMS}. {SECURITY_LINE}"
                    .to_string(),
            variables: vec![
                "COMPANY".to_string(),
                "DESCRIPTION".to_string(),
                "PLATFORMS".to_string(),
                "SECURITY_LINE".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "intro".to_string(),
            triggers: vec!["intro".to_string()],
            kind: TextExpand,
            description: "Insert your personal or company intro".to_string(),
            template: "{BIO_OR_COMPANY_INTRO}".to_string(),
            variables: vec!["BIO_OR_COMPANY_INTRO".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "address".to_string(),
            triggers: vec!["address".to_string(), "office address".to_string()],
            kind: TextExpand,
            description: "Insert office mailing address".to_string(),
            template: "{STREET}\n{CITY}, {STATE} {ZIP}\n{COUNTRY}".to_string(),
            variables: vec![
                "STREET".to_string(),
                "CITY".to_string(),
                "STATE".to_string(),
                "ZIP".to_string(),
                "COUNTRY".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "hours".to_string(),
            triggers: vec![
                "hours".to_string(),
                "business hours".to_string(),
            ],
            kind: TextExpand,
            description: "Insert support hours and timezone".to_string(),
            template: "Our hours are {HOURS} ({TZ}).".to_string(),
            variables: vec!["HOURS".to_string(), "TZ".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "faq".to_string(),
            triggers: vec!["faq".to_string()],
            kind: TextExpand,
            description: "Insert FAQ list or link".to_string(),
            template: "FAQ: {FAQ_URL}\n\nTop answers:\n- {Q1} - {A1}\n- {Q2} - {A2}"
                .to_string(),
            variables: vec![
                "FAQ_URL".to_string(),
                "Q1".to_string(),
                "A1".to_string(),
                "Q2".to_string(),
                "A2".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "support_intro".to_string(),
            triggers: vec!["support intro".to_string()],
            kind: TextExpand,
            description: "Insert a support opener request".to_string(),
            template:
                "Thanks for reaching out - happy to help. Can you share {INFO_REQUEST_LIST}?"
                    .to_string(),
            variables: vec!["INFO_REQUEST_LIST".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "hiring_pitch".to_string(),
            triggers: vec!["hiring".to_string(), "hiring pitch".to_string()],
            kind: TextExpand,
            description: "Insert a hiring message".to_string(),
            template: "We're hiring for {ROLES}. Details: {CAREERS_URL}".to_string(),
            variables: vec!["ROLES".to_string(), "CAREERS_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "meeting_confirmation".to_string(),
            triggers: vec!["meeting confirmation".to_string()],
            kind: TextExpand,
            description: "Confirm time, agenda, and attendees".to_string(),
            template: "Confirmed for {DATE_TIME} ({TZ}). Agenda: {AGENDA}. Attendees: {ATTENDEES}."
                .to_string(),
            variables: vec![
                "DATE_TIME".to_string(),
                "TZ".to_string(),
                "AGENDA".to_string(),
                "ATTENDEES".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "recap_intro".to_string(),
            triggers: vec!["recap intro".to_string()],
            kind: TextExpand,
            description: "Insert meeting recap header".to_string(),
            template: "Recap from {MEETING_NAME} ({DATE}):\n\nKey points:\n-".to_string(),
            variables: vec!["MEETING_NAME".to_string(), "DATE".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "contract_reminder".to_string(),
            triggers: vec!["contract reminder".to_string()],
            kind: TextExpand,
            description: "Insert contract reminder".to_string(),
            template:
                "Quick reminder: the agreement is ready here: {CONTRACT_URL}. Happy to answer questions."
                    .to_string(),
            variables: vec!["CONTRACT_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "qbr_template".to_string(),
            triggers: vec!["qbr template".to_string()],
            kind: TextExpand,
            description: "Insert QBR outline".to_string(),
            template: "QBR ({CUSTOMER}) - {QUARTER}\n\n1) Goals\n2) Usage & outcomes\n3) Wins\n4) Issues / risks\n5) Roadmap\n6) Next steps"
                .to_string(),
            variables: vec!["CUSTOMER".to_string(), "QUARTER".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "after_demo".to_string(),
            triggers: vec!["after demo".to_string()],
            kind: TextExpand,
            description: "Insert demo follow-up".to_string(),
            template:
                "Thanks for the time today. Highlights: {HIGHLIGHTS}. Next steps: {NEXT_STEPS}."
                    .to_string(),
            variables: vec!["HIGHLIGHTS".to_string(), "NEXT_STEPS".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "refund_timing".to_string(),
            triggers: vec!["refund timing".to_string()],
            kind: TextExpand,
            description: "Insert refund timing response".to_string(),
            template: "Your refund is processed. It can take {DAYS_RANGE} business days to show up, depending on your bank."
                .to_string(),
            variables: vec!["DAYS_RANGE".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "feedback_request".to_string(),
            triggers: vec!["feedback request".to_string()],
            kind: TextExpand,
            description: "Request feedback with link".to_string(),
            template: "If you have a moment, could you rate your experience here? {FEEDBACK_URL}"
                .to_string(),
            variables: vec!["FEEDBACK_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "update_subscription".to_string(),
            triggers: vec!["update subscription".to_string()],
            kind: TextExpand,
            description: "Provide billing update link".to_string(),
            template: "You can update your subscription here: {BILLING_URL}. If you get stuck, tell me what you see."
                .to_string(),
            variables: vec!["BILLING_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "password_reset".to_string(),
            triggers: vec!["password reset".to_string()],
            kind: TextExpand,
            description: "Provide password reset steps".to_string(),
            template: "Reset your password here: {RESET_URL}. If you don't see the email, check spam or try again in {MINUTES} min."
                .to_string(),
            variables: vec!["RESET_URL".to_string(), "MINUTES".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "forgot_username".to_string(),
            triggers: vec!["forgot username".to_string()],
            kind: TextExpand,
            description: "Provide username recovery steps".to_string(),
            template:
                "If you forgot your username, use {RECOVERY_URL}. If that doesn't work, share {VERIFICATION_FIELDS}."
                    .to_string(),
            variables: vec![
                "RECOVERY_URL".to_string(),
                "VERIFICATION_FIELDS".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "bug_acknowledgement".to_string(),
            triggers: vec!["bug acknowledgement".to_string()],
            kind: TextExpand,
            description: "Acknowledge bug report".to_string(),
            template:
                "Thanks for the report - I'm sorry about this. We can reproduce it and are investigating. Can you share {REPRO_INFO}?"
                    .to_string(),
            variables: vec!["REPRO_INFO".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "support_response".to_string(),
            triggers: vec!["support response".to_string()],
            kind: TextExpand,
            description: "Provide preferred support channel".to_string(),
            template:
                "The best way to report an issue is {PREFERRED_CHANNEL}. That includes {CONTEXT_CAPTURED}."
                    .to_string(),
            variables: vec![
                "PREFERRED_CHANNEL".to_string(),
                "CONTEXT_CAPTURED".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "pr_checklist".to_string(),
            triggers: vec!["pr checklist".to_string()],
            kind: TextExpand,
            description: "Insert PR checklist".to_string(),
            template: "PR Checklist:\n- [ ] Tests added/updated\n- [ ] Docs updated\n- [ ] Screenshots (if UI)\n- [ ] Verified locally\n- [ ] Linked issue: {ISSUE}"
                .to_string(),
            variables: vec!["ISSUE".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "environment_setup".to_string(),
            triggers: vec!["environment setup".to_string()],
            kind: TextExpand,
            description: "Insert setup steps".to_string(),
            template:
                "Setup:\n1) Install {DEPS}\n2) Copy .env.example -> .env\n3) Set {ENV_VARS}\n4) Run {COMMANDS}"
                    .to_string(),
            variables: vec![
                "DEPS".to_string(),
                "ENV_VARS".to_string(),
                "COMMANDS".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "internal_api_docs".to_string(),
            triggers: vec!["internal api docs".to_string()],
            kind: TextExpand,
            description: "Insert internal API docs link".to_string(),
            template: "Internal API docs: {API_DOCS_URL}".to_string(),
            variables: vec!["API_DOCS_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "naming_convention".to_string(),
            triggers: vec!["naming convention".to_string()],
            kind: TextExpand,
            description: "Insert naming rules".to_string(),
            template:
                "Naming:\n- Files: {FILE_RULE}\n- Vars: {VAR_RULE}\n- Branches: {BRANCH_RULE}"
                    .to_string(),
            variables: vec![
                "FILE_RULE".to_string(),
                "VAR_RULE".to_string(),
                "BRANCH_RULE".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "onboarding_instructions".to_string(),
            triggers: vec!["onboarding instructions".to_string()],
            kind: TextExpand,
            description: "Insert onboarding steps".to_string(),
            template:
                "Onboarding:\n1) Read {HANDBOOK_URL}\n2) Get access to {TOOLS}\n3) Run {SETUP}\n4) First task: {FIRST_TASK}"
                    .to_string(),
            variables: vec![
                "HANDBOOK_URL".to_string(),
                "TOOLS".to_string(),
                "SETUP".to_string(),
                "FIRST_TASK".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "architecture_review_template".to_string(),
            triggers: vec!["architecture review template".to_string()],
            kind: TextExpand,
            description: "Insert architecture review questions".to_string(),
            template: "Architecture review:\n- Problem statement\n- Constraints\n- Proposed design\n- Alternatives considered\n- Failure modes\n- Observability\n- Security/privacy\n- Rollout plan"
                .to_string(),
            variables: Vec::new(),
            enabled: false,
        },
        SnippetDefinition {
            id: "collab_request".to_string(),
            triggers: vec!["collab request".to_string()],
            kind: TextExpand,
            description: "Insert collaboration response".to_string(),
            template:
                "Thanks for reaching out! I'm open to collaborations. Can you share {DETAILS_NEEDED}?"
                    .to_string(),
            variables: vec!["DETAILS_NEEDED".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "partner_faqs".to_string(),
            triggers: vec!["partner faqs".to_string()],
            kind: TextExpand,
            description: "Insert partner FAQs".to_string(),
            template: "Partner FAQs:\n1) {Q1}\nA: {A1}\n2) {Q2}\nA: {A2}".to_string(),
            variables: vec![
                "Q1".to_string(),
                "A1".to_string(),
                "Q2".to_string(),
                "A2".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "giveaway_template".to_string(),
            triggers: vec!["giveaway template".to_string()],
            kind: TextExpand,
            description: "Insert giveaway template".to_string(),
            template:
                "GIVEAWAY!\nPrize: {PRIZE}\nHow to enter:\n1) {STEP1}\n2) {STEP2}\nEnds: {END_DATE}\nRules: {RULES_URL}"
                    .to_string(),
            variables: vec![
                "PRIZE".to_string(),
                "STEP1".to_string(),
                "STEP2".to_string(),
                "END_DATE".to_string(),
                "RULES_URL".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "newsletter_outro".to_string(),
            triggers: vec!["newsletter outro".to_string()],
            kind: TextExpand,
            description: "Insert newsletter closing".to_string(),
            template: "Thanks for reading!\nIf you enjoyed this, {CTA}.\nSee you next time,\n{NAME}"
                .to_string(),
            variables: vec!["CTA".to_string(), "NAME".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "confidentiality_clause".to_string(),
            triggers: vec!["confidentiality clause".to_string()],
            kind: TextExpand,
            description: "Insert confidentiality clause".to_string(),
            template: "{CONFIDENTIALITY_CLAUSE_TEXT}".to_string(),
            variables: vec!["CONFIDENTIALITY_CLAUSE_TEXT".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "standard_nda_clause".to_string(),
            triggers: vec!["standard nda clause".to_string()],
            kind: TextExpand,
            description: "Insert NDA clause".to_string(),
            template: "{NDA_CLAUSE_TEXT}".to_string(),
            variables: vec!["NDA_CLAUSE_TEXT".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "hourly_billing_terms".to_string(),
            triggers: vec!["hourly billing terms".to_string()],
            kind: TextExpand,
            description: "Insert billing terms".to_string(),
            template:
                "Billing terms: {RATE} per hour, billed in {INCREMENTS}, invoices {SCHEDULE}, payable {TERMS}."
                    .to_string(),
            variables: vec![
                "RATE".to_string(),
                "INCREMENTS".to_string(),
                "SCHEDULE".to_string(),
                "TERMS".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "privacy_policy".to_string(),
            triggers: vec!["privacy policy".to_string()],
            kind: TextExpand,
            description: "Insert privacy policy link".to_string(),
            template: "Privacy policy: {PRIVACY_URL}".to_string(),
            variables: vec!["PRIVACY_URL".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "case_update_template".to_string(),
            triggers: vec!["case update template".to_string()],
            kind: TextExpand,
            description: "Insert case update outline".to_string(),
            template:
                "Case update - {MATTER}\nStatus: {STATUS}\nRecent activity: {RECENT}\nNext steps: {NEXT}\nAsks/needs: {ASKS}"
                    .to_string(),
            variables: vec![
                "MATTER".to_string(),
                "STATUS".to_string(),
                "RECENT".to_string(),
                "NEXT".to_string(),
                "ASKS".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "court_appearance_notice".to_string(),
            triggers: vec!["court appearance notice".to_string()],
            kind: TextExpand,
            description: "Insert court appearance notice".to_string(),
            template:
                "Notice: Court appearance for {MATTER} on {DATE_TIME} at {LOCATION}."
                    .to_string(),
            variables: vec![
                "MATTER".to_string(),
                "DATE_TIME".to_string(),
                "LOCATION".to_string(),
            ],
            enabled: false,
        },
        SnippetDefinition {
            id: "attorney_client_privilege_disclaimer".to_string(),
            triggers: vec!["attorney-client privilege disclaimer".to_string()],
            kind: TextExpand,
            description: "Insert privilege/confidentiality footer".to_string(),
            template:
                "This message may contain privileged/confidential information intended only for the recipient(s). {MORE}"
                    .to_string(),
            variables: vec!["MORE".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "signature".to_string(),
            triggers: vec!["sig".to_string()],
            kind: TextExpand,
            description: "Insert default sign-off".to_string(),
            template: "{SIGN_OFF} - {NAME}".to_string(),
            variables: vec!["SIGN_OFF".to_string(), "NAME".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "taney_typo".to_string(),
            triggers: vec!["taney".to_string()],
            kind: TextExpand,
            description: "Auto-correct a spelling".to_string(),
            template: "{CORRECT_SPELLING}".to_string(),
            variables: vec!["CORRECT_SPELLING".to_string()],
            enabled: false,
        },
        SnippetDefinition {
            id: "meeting_follow_up_prompt".to_string(),
            triggers: vec!["meeting follow-up prompt".to_string()],
            kind: PromptExpand,
            description: "Insert AI prompt for meeting follow-ups".to_string(),
            template: "Analyze this meeting transcript. Summarize key updates/risks/next steps. Draft follow-ups for {PEOPLE_OR_ROLES}."
                .to_string(),
            variables: vec!["PEOPLE_OR_ROLES".to_string()],
            enabled: false,
        },
    ]
}
