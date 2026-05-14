use crate::focus_context::get_active_context;
use crate::focus_context::FocusContext;
use crate::managers::meetings::MeetingsManager;
use crate::meeting_prompt::{hide_meeting_prompt, show_meeting_prompt, MeetingPromptPayload};
use crate::settings;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Manager;

const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MIN_PROMPT_INTERVAL: Duration = Duration::from_secs(45);
const SAME_CONTEXT_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const MIN_DETECTION_DWELL_HIGH: Duration = Duration::from_secs(3);
const MIN_DETECTION_DWELL_MED: Duration = Duration::from_secs(6);
const MIN_DETECTION_DWELL_LOW: Duration = Duration::from_secs(12);
pub const DISMISS_SNOOZE: Duration = Duration::from_secs(30 * 60);

#[derive(Default)]
struct MeetingDetectionState {
    last_signature: Option<String>,
    last_prompt_at: Option<Instant>,
    candidate_signature: Option<String>,
    candidate_first_seen: Option<Instant>,
    snoozed_until: HashMap<String, Instant>,
}

#[derive(Clone, Debug)]
struct DetectionResult {
    payload: MeetingPromptPayload,
    signature: String,
    confidence: u8,
}

pub struct MeetingDetectionManager {
    app_handle: AppHandle,
    state: Arc<Mutex<MeetingDetectionState>>,
}

impl MeetingDetectionManager {
    pub fn new(app_handle: &AppHandle) -> Self {
        Self {
            app_handle: app_handle.clone(),
            state: Arc::new(Mutex::new(MeetingDetectionState::default())),
        }
    }

    pub fn snooze_last_prompt(&self, duration: Duration) {
        let mut guard = self.state.lock().unwrap();
        if let Some(signature) = guard.last_signature.clone() {
            guard
                .snoozed_until
                .insert(signature, Instant::now() + duration);
        }
    }

    pub fn reset_state(&self) {
        let mut guard = self.state.lock().unwrap();
        guard.last_signature = None;
        guard.last_prompt_at = None;
        guard.candidate_signature = None;
        guard.candidate_first_seen = None;
        guard.snoozed_until.clear();
    }

    pub fn start(self: Arc<Self>) {
        let app_handle = self.app_handle.clone();
        let state = self.state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(POLL_INTERVAL).await;

                let meetings_manager = app_handle.state::<Arc<MeetingsManager>>();
                if meetings_manager.is_recording() {
                    hide_meeting_prompt(&app_handle);
                    continue;
                }

                let settings = settings::get_settings(&app_handle);
                if !settings.meeting_detection_enabled {
                    hide_meeting_prompt(&app_handle);
                    let mut guard = state.lock().unwrap();
                    guard.candidate_signature = None;
                    guard.candidate_first_seen = None;
                    continue;
                }

                let detection = get_active_context().and_then(|context| detect_meeting(&context));

                if detection.is_none() {
                    hide_meeting_prompt(&app_handle);
                    let mut guard = state.lock().unwrap();
                    guard.candidate_signature = None;
                    guard.candidate_first_seen = None;
                    continue;
                }

                let detection = detection.unwrap();
                let now = Instant::now();

                let should_show = {
                    let mut guard = state.lock().unwrap();
                    if let Some(until) = guard.snoozed_until.get(detection.signature.as_str()) {
                        if now < *until {
                            false
                        } else {
                            guard.snoozed_until.remove(detection.signature.as_str());
                            true
                        }
                    } else {
                        true
                    }
                };

                if !should_show {
                    continue;
                }

                let should_show = {
                    let mut guard = state.lock().unwrap();
                    if guard.candidate_signature.as_deref() != Some(detection.signature.as_str()) {
                        guard.candidate_signature = Some(detection.signature.clone());
                        guard.candidate_first_seen = Some(now);
                    }

                    let dwell = guard
                        .candidate_first_seen
                        .map(|t| now.duration_since(t))
                        .unwrap_or_default();

                    let min_dwell = match detection.confidence {
                        3 => MIN_DETECTION_DWELL_HIGH,
                        2 => MIN_DETECTION_DWELL_MED,
                        _ => MIN_DETECTION_DWELL_LOW,
                    };

                    if dwell < min_dwell {
                        return false;
                    }

                    let last_prompt = guard.last_prompt_at;
                    let same_signature =
                        guard.last_signature.as_deref() == Some(detection.signature.as_str());
                    let too_soon = last_prompt
                        .map(|t| now.duration_since(t) < MIN_PROMPT_INTERVAL)
                        .unwrap_or(false);
                    let same_recent = same_signature
                        && last_prompt
                            .map(|t| now.duration_since(t) < SAME_CONTEXT_COOLDOWN)
                            .unwrap_or(false);

                    if same_recent || (!same_signature && too_soon) {
                        false
                    } else {
                        guard.last_signature = Some(detection.signature.clone());
                        guard.last_prompt_at = Some(now);
                        true
                    }
                };

                if should_show {
                    show_meeting_prompt(&app_handle, detection.payload);
                }
            }
        });
    }
}

fn detect_meeting(context: &FocusContext) -> Option<DetectionResult> {
    let title = context
        .browser_tab_title
        .as_deref()
        .or(context.window_title.as_deref());

    if title.map(detect_inactive_title).unwrap_or(false) {
        return None;
    }

    let (provider, confidence) = detect_from_url(context.browser_tab_url.as_deref())
        .map(|provider| (provider, 3))
        .or_else(|| detect_from_text(context.browser_tab_title.as_deref()).map(|p| (p, 2)))
        .or_else(|| detect_from_text(context.window_title.as_deref()).map(|p| (p, 2)))
        .or_else(|| {
            let app_provider = detect_from_app(context.app_name.as_deref())
                .or_else(|| detect_from_app(context.app_identifier.as_deref()))?;
            let meeting_like = title.map(|t| is_meeting_like_title(t)).unwrap_or(false);
            if meeting_like {
                Some((app_provider, 1))
            } else {
                None
            }
        })?;

    let detail = detail_from_context(context, provider);
    let signature = build_signature(context, provider);

    Some(DetectionResult {
        payload: MeetingPromptPayload {
            source: provider.to_string(),
            detail,
        },
        signature,
        confidence,
    })
}

fn detect_from_url(url: Option<&str>) -> Option<&'static str> {
    let url = url?.to_lowercase();
    if url.contains("meet.google.com") {
        return Some("Google Meet");
    }
    if url.contains("teams.microsoft.com") {
        return Some("Microsoft Teams");
    }
    if url.contains("zoom.us") || url.contains("zoom.com") || url.contains("zoommtg") {
        return Some("Zoom");
    }
    if url.contains("webex.com") {
        return Some("Webex");
    }
    if url.contains("bluejeans.com") {
        return Some("BlueJeans");
    }
    if url.contains("gotomeeting.com") {
        return Some("GoToMeeting");
    }
    if url.contains("chime.aws") {
        return Some("Amazon Chime");
    }
    if url.contains("whereby.com") {
        return Some("Whereby");
    }
    if url.contains("meet.jit.si") {
        return Some("Jitsi Meet");
    }
    if url.contains("app.slack.com") && url.contains("huddle") {
        return Some("Slack Huddle");
    }
    None
}

fn detect_from_text(text: Option<&str>) -> Option<&'static str> {
    let text = text?.to_lowercase();
    if text.contains("zoom meeting") || (text.contains("zoom") && text.contains("meeting")) {
        return Some("Zoom");
    }
    if text.contains("microsoft teams") || text.contains("teams meeting") {
        return Some("Microsoft Teams");
    }
    if text.contains("google meet") || text.contains("meet.google.com") {
        return Some("Google Meet");
    }
    if text.contains("webex") {
        return Some("Webex");
    }
    if text.contains("bluejeans") {
        return Some("BlueJeans");
    }
    if text.contains("gotomeeting") || text.contains("go to meeting") {
        return Some("GoToMeeting");
    }
    if text.contains("chime") && text.contains("meeting") {
        return Some("Amazon Chime");
    }
    if text.contains("whereby") {
        return Some("Whereby");
    }
    if text.contains("jitsi") {
        return Some("Jitsi Meet");
    }
    if text.contains("huddle") {
        return Some("Slack Huddle");
    }
    None
}

fn detect_from_app(app: Option<&str>) -> Option<&'static str> {
    let app = app?.to_lowercase();
    if app.contains("zoom") {
        return Some("Zoom");
    }
    if app.contains("teams") || app.contains("microsoft teams") || app.contains("msteams") {
        return Some("Microsoft Teams");
    }
    if app.contains("webex") {
        return Some("Webex");
    }
    if app.contains("bluejeans") {
        return Some("BlueJeans");
    }
    if app.contains("gotomeeting") || app.contains("go to meeting") {
        return Some("GoToMeeting");
    }
    if app.contains("chime") {
        return Some("Amazon Chime");
    }
    if app.contains("whereby") {
        return Some("Whereby");
    }
    if app.contains("jitsi") {
        return Some("Jitsi Meet");
    }
    if app.contains("meet") && app.contains("google") {
        return Some("Google Meet");
    }
    if app.contains("slack") {
        return Some("Slack Huddle");
    }
    None
}

fn detail_from_context(context: &FocusContext, provider: &str) -> Option<String> {
    let candidate = context
        .browser_tab_title
        .as_deref()
        .or(context.window_title.as_deref())?;
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed.to_lowercase();
    let provider_lower = provider.to_lowercase();
    if normalized == provider_lower {
        return None;
    }

    Some(trimmed.to_string())
}

fn build_signature(context: &FocusContext, provider: &str) -> String {
    if let Some(url) = context.browser_tab_url.as_deref() {
        return format!("{}|{}", provider, url);
    }
    if let Some(title) = context.browser_tab_title.as_deref() {
        return format!("{}|{}", provider, title);
    }
    if let Some(title) = context.window_title.as_deref() {
        return format!("{}|{}", provider, title);
    }
    if let Some(identifier) = context.app_identifier.as_deref() {
        return format!("{}|{}", provider, identifier);
    }
    if let Some(app_name) = context.app_name.as_deref() {
        return format!("{}|{}", provider, app_name);
    }
    provider.to_string()
}

fn is_meeting_like_title(title: &str) -> bool {
    let text = title.to_lowercase();
    [
        "meeting",
        "call",
        "huddle",
        "webinar",
        "conference",
        "standup",
        "sync",
        "interview",
        "workshop",
        "retro",
        "town hall",
        "all hands",
        "daily",
        "scrum",
        "stand up",
        "lobby",
        "waiting",
        "join",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn detect_inactive_title(title: &str) -> bool {
    let text = title.to_lowercase();
    let inactive = [
        "meeting ended",
        "call ended",
        "you left",
        "left the meeting",
        "ended",
        "has ended",
        "is over",
        "ended meeting",
        "no longer in",
        "meeting has ended",
    ]
    .iter()
    .any(|needle| text.contains(needle));
    inactive
}
