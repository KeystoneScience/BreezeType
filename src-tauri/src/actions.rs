use crate::app_launcher;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::clipboard_overlay;
use crate::glossary;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::managers::insertion::InsertionManager;
use crate::managers::local_llm::LocalLlmManager;
use crate::managers::transcription::TranscriptionManager;
use crate::polish::{self, AppProfile};
use crate::quick_task_overlay;
use crate::settings::{
    get_settings, AppSettings, APPLE_INTELLIGENCE_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID,
};
use crate::shortcut;
use crate::tray::{change_tray_icon, TrayIconState};
use crate::utils::{self, show_recording_overlay, show_transcribing_overlay};
use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use log::{debug, error, info};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Transcribe Action
struct TranscribeAction;

struct LlmPostProcessResult {
    text: String,
    prompt: String,
}

const TRANSCRIBE_ACTION_IDLE: u8 = 0;
const TRANSCRIBE_ACTION_RECORDING: u8 = 1;
const TRANSCRIBE_ACTION_STOPPING: u8 = 2;

static TRANSCRIBE_ACTION_STATE: AtomicU8 = AtomicU8::new(TRANSCRIBE_ACTION_IDLE);
static ACTIVE_TRANSCRIPTION_TASKS: AtomicUsize = AtomicUsize::new(0);
static LAST_TRANSCRIBE_STOP_MS: AtomicU64 = AtomicU64::new(0);
const TRANSCRIBE_RESTART_DEBOUNCE_MS: u64 = 140;
const TRANSCRIBE_STOP_STALE_RESET_MS: u64 = 2_000;

struct TranscriptionActivityGuard;

impl TranscriptionActivityGuard {
    fn new() -> Self {
        ACTIVE_TRANSCRIPTION_TASKS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for TranscriptionActivityGuard {
    fn drop(&mut self) {
        ACTIVE_TRANSCRIPTION_TASKS.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn is_transcribe_action_active() -> bool {
    TRANSCRIBE_ACTION_STATE.load(Ordering::SeqCst) != TRANSCRIBE_ACTION_IDLE
        || ACTIVE_TRANSCRIPTION_TASKS.load(Ordering::SeqCst) > 0
}

fn should_attempt_transcription_paste(
    focus_state: crate::input_focus::FocusDetectionState,
) -> bool {
    focus_state != crate::input_focus::FocusDetectionState::NotTextInput
}

#[cfg(test)]
mod tests {
    use super::{post_process_system_prompt, should_attempt_transcription_paste};
    use crate::input_focus::FocusDetectionState;

    #[test]
    fn skips_transcription_paste_when_focus_is_not_text_input() {
        assert!(!should_attempt_transcription_paste(
            FocusDetectionState::NotTextInput
        ));
    }

    #[test]
    fn allows_transcription_paste_when_focus_is_text_input_or_unavailable() {
        assert!(should_attempt_transcription_paste(
            FocusDetectionState::TextInput
        ));
        assert!(should_attempt_transcription_paste(
            FocusDetectionState::Unavailable
        ));
    }

    #[test]
    fn post_process_system_prompt_respects_filler_setting() {
        assert!(post_process_system_prompt(true).contains("Remove filler words."));
        assert!(post_process_system_prompt(false).contains("Preserve filler words"));
    }
}

fn transcribe_action_state_name(state: u8) -> &'static str {
    match state {
        TRANSCRIBE_ACTION_IDLE => "idle",
        TRANSCRIBE_ACTION_RECORDING => "recording",
        TRANSCRIBE_ACTION_STOPPING => "stopping",
        _ => "unknown",
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn post_process_system_prompt(remove_filler_words: bool) -> String {
    let filler_rule = if remove_filler_words {
        "Remove filler words."
    } else {
        "Preserve filler words when they appear in the transcript."
    };

    format!(
        "You are a transcript post-processor. \
Fix casing, punctuation, and obvious speech errors without changing meaning. \
Fix obvious homophones/ASR confusions when context makes it clear (e.g., park -> part, hairs -> errors). \
{filler_rule} Convert spoken punctuation to symbols. \
Remove obvious repeated words or phrases, especially consecutive repeats. \
Convert obvious numbers to digits (e.g., twenty five -> 25, ten percent -> 10%, five dollars -> $5). \
Do not perform arithmetic or combine repeated numbers; keep numbers exactly as spoken. \
Preserve the original word order and do not add new information. \
Return only the cleaned transcript text."
    )
}

const NOTE_TITLE_SYSTEM_PROMPT: &str = "You are a note title generator. \
Create a concise title (max 6 words) that summarizes the note. \
Return only the title.";

async fn maybe_post_process_transcription(
    app: &AppHandle,
    settings: &AppSettings,
    transcription: &str,
    focus_context: Option<&crate::focus_context::FocusContext>,
    profile: AppProfile,
    glossary_block: Option<&str>,
) -> Option<LlmPostProcessResult> {
    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => {
            info!("Post-processing skipped: no provider selected");
            return None;
        }
    };

    let mut model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        info!(
            "Post-processing skipped: provider '{}' has no model configured",
            provider.id
        );
        return None;
    }

    let selected_prompt_id = match &settings.post_process_selected_prompt_id {
        Some(id) => id.clone(),
        None => {
            info!("Post-processing skipped: no prompt selected");
            return None;
        }
    };

    let prompt = match settings
        .post_process_prompts
        .iter()
        .find(|prompt| prompt.id == selected_prompt_id)
    {
        Some(prompt) => prompt.prompt.clone(),
        None => {
            info!(
                "Post-processing skipped: prompt '{}' not found",
                selected_prompt_id
            );
            return None;
        }
    };

    if prompt.trim().is_empty() {
        info!("Post-processing skipped: selected prompt is empty");
        return None;
    }

    let (protected_text, replacements) = polish::protect_verbatim_spans(transcription);
    let should_fallback_to_local_llama = provider.id == OPENAI_CODEX_PROVIDER_ID;

    info!(
        "Starting LLM post-processing with provider '{}' (model: {})",
        provider.id, model
    );

    // Replace ${output} variable in the prompt with the actual text
    let mut processed_prompt = polish::build_prompt(
        &prompt,
        &protected_text,
        focus_context,
        profile,
        glossary_block.unwrap_or(""),
        settings.post_process_remove_fillers,
    );
    if !prompt.contains("${glossary}") {
        if let Some(block) = glossary_block {
            if !block.trim().is_empty() {
                processed_prompt = format!("{}\n\n{}", processed_prompt, block);
            }
        }
    }
    debug!("Processed prompt length: {} chars", processed_prompt.len());

    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            if !apple_intelligence::check_apple_intelligence_availability() {
                debug!("Apple Intelligence selected but not currently available on this device");
                return None;
            }

            let token_limit = model.trim().parse::<i32>().unwrap_or(0);
            return match apple_intelligence::process_text(&processed_prompt, token_limit) {
                Ok(result) => {
                    if result.trim().is_empty() {
                        debug!("Apple Intelligence returned an empty response");
                        None
                    } else {
                        if let Err(reason) = polish::validate_llm_output_with_reason(
                            &protected_text,
                            &result,
                            &replacements,
                        ) {
                            info!("Apple Intelligence output failed validation: {}", reason);
                            return None;
                        }

                        let restored = polish::restore_verbatim_spans(&result, &replacements);
                        debug!(
                            "Apple Intelligence post-processing succeeded. Output length: {} chars",
                            restored.len()
                        );
                        Some(LlmPostProcessResult {
                            text: restored,
                            prompt: processed_prompt,
                        })
                    }
                }
                Err(err) => {
                    error!("Apple Intelligence post-processing failed: {}", err);
                    None
                }
            };
        }

        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            debug!("Apple Intelligence provider selected on unsupported platform");
            return None;
        }
    }

    if provider.id == "local_llama" {
        let manager = app.state::<Arc<LocalLlmManager>>();
        let selected_model_id = model.clone();
        if let Err(err) = manager.ensure_running(app, &selected_model_id) {
            info!("Local LLM unavailable: {}", err);
            return None;
        }
        if let Some(active_model_id) = manager.active_model_id() {
            model = active_model_id;
        }
    }

    let fallback_api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    let api_key = match crate::openai_codex_oauth::resolve_provider_api_key(
        app,
        &provider.id,
        fallback_api_key,
    )
    .await
    {
        Ok(api_key) => api_key,
        Err(err) => {
            error!(
                "Failed to resolve credentials for provider '{}': {}",
                provider.id, err
            );
            if should_fallback_to_local_llama {
                return try_post_process_with_local_llama(
                    app,
                    settings,
                    &processed_prompt,
                    &protected_text,
                    &replacements,
                )
                .await;
            }
            return None;
        }
    };

    // Send the chat completion request
    let system_prompt = post_process_system_prompt(settings.post_process_remove_fillers);
    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        Some(system_prompt.as_str()),
        &processed_prompt,
    )
    .await
    {
        Ok(Some(content)) => {
            if let Err(reason) =
                polish::validate_llm_output_with_reason(&protected_text, &content, &replacements)
            {
                info!("LLM post-processing output failed validation: {}", reason);
                return None;
            }
            let restored = polish::restore_verbatim_spans(&content, &replacements);
            info!(
                "LLM post-processing succeeded for provider '{}'. Output length: {} chars",
                provider.id,
                restored.len()
            );
            Some(LlmPostProcessResult {
                text: restored,
                prompt: processed_prompt,
            })
        }
        Ok(None) => {
            error!("LLM API response has no content");
            if should_fallback_to_local_llama {
                return try_post_process_with_local_llama(
                    app,
                    settings,
                    &processed_prompt,
                    &protected_text,
                    &replacements,
                )
                .await;
            }
            None
        }
        Err(e) => {
            error!(
                "LLM post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id,
                e
            );
            if should_fallback_to_local_llama {
                return try_post_process_with_local_llama(
                    app,
                    settings,
                    &processed_prompt,
                    &protected_text,
                    &replacements,
                )
                .await;
            }
            None
        }
    }
}

async fn try_post_process_with_local_llama(
    app: &AppHandle,
    settings: &AppSettings,
    processed_prompt: &str,
    protected_text: &str,
    replacements: &[String],
) -> Option<LlmPostProcessResult> {
    let provider = settings.post_process_provider("local_llama")?.clone();
    let mut model = settings
        .post_process_models
        .get("local_llama")
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        info!("Codex fallback skipped: local model is not configured");
        return None;
    }

    let manager = app.state::<Arc<LocalLlmManager>>();
    let selected_model_id = model.clone();
    if let Err(err) = manager.ensure_running(app, &selected_model_id) {
        info!("Codex fallback skipped: local LLM unavailable: {}", err);
        return None;
    }
    if let Some(active_model_id) = manager.active_model_id() {
        model = active_model_id;
    }

    info!(
        "Falling back to local LLM post-processing (model: {}) due to Codex unavailability",
        model
    );

    let system_prompt = post_process_system_prompt(settings.post_process_remove_fillers);
    match crate::llm_client::send_chat_completion(
        &provider,
        String::new(),
        &model,
        Some(system_prompt.as_str()),
        processed_prompt,
    )
    .await
    {
        Ok(Some(content)) => {
            if let Err(reason) =
                polish::validate_llm_output_with_reason(protected_text, &content, replacements)
            {
                info!("Local fallback output failed validation: {}", reason);
                return None;
            }
            let restored = polish::restore_verbatim_spans(&content, replacements);
            Some(LlmPostProcessResult {
                text: restored,
                prompt: processed_prompt.to_string(),
            })
        }
        Ok(None) => None,
        Err(err) => {
            error!("Local fallback post-processing failed: {}", err);
            None
        }
    }
}

fn sanitize_note_title(title: &str) -> String {
    let trimmed = title
        .trim()
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '“' | '”'));
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    let without_trailing = first_line
        .trim_end_matches(|c: char| matches!(c, ':' | '.' | '-' | '—' | ','))
        .trim();
    if without_trailing.is_empty() {
        return String::new();
    }
    let mut words: Vec<&str> = without_trailing.split_whitespace().collect();
    if words.len() > 6 {
        words.truncate(6);
    }
    words.join(" ")
}

fn fallback_note_title(body: &str) -> String {
    let first_line = body.lines().find(|line| !line.trim().is_empty());
    let candidate = first_line.unwrap_or("").trim();
    if candidate.is_empty() {
        return String::new();
    }
    let mut words: Vec<&str> = candidate.split_whitespace().collect();
    if words.len() > 6 {
        words.truncate(6);
    }
    words.join(" ")
}

fn truncate_note_body(body: &str, max_chars: usize) -> String {
    if body.chars().count() <= max_chars {
        return body.to_string();
    }
    body.chars().take(max_chars).collect()
}

async fn maybe_generate_note_title(
    app: &AppHandle,
    settings: &AppSettings,
    note_body: &str,
) -> Option<String> {
    let body = note_body.trim();
    if body.is_empty() {
        return None;
    }
    let body = truncate_note_body(body, 1200);

    if !settings.post_process_enabled {
        return Some(fallback_note_title(&body));
    }

    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => return Some(fallback_note_title(&body)),
    };
    let should_fallback_to_local_llama = provider.id == OPENAI_CODEX_PROVIDER_ID;

    let mut model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        return Some(fallback_note_title(&body));
    }

    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            if !apple_intelligence::check_apple_intelligence_availability() {
                return Some(fallback_note_title(&body));
            }
            let prompt = format!("{}\n\nNote:\n{}", NOTE_TITLE_SYSTEM_PROMPT, body);
            return match apple_intelligence::process_text(&prompt, 24) {
                Ok(result) => {
                    let cleaned = sanitize_note_title(&result);
                    if cleaned.is_empty() {
                        Some(fallback_note_title(&body))
                    } else {
                        Some(cleaned)
                    }
                }
                Err(_) => Some(fallback_note_title(&body)),
            };
        }

        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            return Some(fallback_note_title(&body));
        }
    }

    if provider.id == "local_llama" {
        let manager = app.state::<Arc<LocalLlmManager>>();
        let selected_model_id = model.clone();
        if manager.ensure_running(app, &selected_model_id).is_err() {
            return Some(fallback_note_title(&body));
        }
        if let Some(active_model_id) = manager.active_model_id() {
            model = active_model_id;
        }
    }

    let fallback_api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    let api_key = match crate::openai_codex_oauth::resolve_provider_api_key(
        app,
        &provider.id,
        fallback_api_key,
    )
    .await
    {
        Ok(api_key) => api_key,
        Err(err) => {
            error!(
                "Failed to resolve credentials for note title provider '{}': {}",
                provider.id, err
            );
            if should_fallback_to_local_llama {
                if let Some(title) =
                    try_generate_note_title_with_local_llama(app, settings, &body).await
                {
                    return Some(title);
                }
            }
            return Some(fallback_note_title(&body));
        }
    };

    let prompt = format!("Note:\n{}", body);
    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        Some(NOTE_TITLE_SYSTEM_PROMPT),
        &prompt,
    )
    .await
    {
        Ok(Some(content)) => {
            let cleaned = sanitize_note_title(&content);
            if cleaned.is_empty() {
                Some(fallback_note_title(&body))
            } else {
                Some(cleaned)
            }
        }
        Ok(None) => {
            if should_fallback_to_local_llama {
                if let Some(title) =
                    try_generate_note_title_with_local_llama(app, settings, &body).await
                {
                    return Some(title);
                }
            }
            Some(fallback_note_title(&body))
        }
        Err(err) => {
            error!(
                "Note title generation failed for provider '{}': {}",
                provider.id, err
            );
            if should_fallback_to_local_llama {
                if let Some(title) =
                    try_generate_note_title_with_local_llama(app, settings, &body).await
                {
                    return Some(title);
                }
            }
            Some(fallback_note_title(&body))
        }
    }
}

async fn try_generate_note_title_with_local_llama(
    app: &AppHandle,
    settings: &AppSettings,
    body: &str,
) -> Option<String> {
    let provider = settings.post_process_provider("local_llama")?.clone();
    let mut model = settings
        .post_process_models
        .get("local_llama")
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        return None;
    }

    let manager = app.state::<Arc<LocalLlmManager>>();
    let selected_model_id = model.clone();
    if manager.ensure_running(app, &selected_model_id).is_err() {
        return None;
    }
    if let Some(active_model_id) = manager.active_model_id() {
        model = active_model_id;
    }

    let prompt = format!("Note:\n{}", body);
    match crate::llm_client::send_chat_completion(
        &provider,
        String::new(),
        &model,
        Some(NOTE_TITLE_SYSTEM_PROMPT),
        &prompt,
    )
    .await
    {
        Ok(Some(content)) => {
            let cleaned = sanitize_note_title(&content);
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        }
        _ => None,
    }
}

async fn ensure_note_title(
    app: &AppHandle,
    settings: &AppSettings,
    history_manager: &Arc<HistoryManager>,
    note: &crate::managers::history::NoteEntry,
) {
    if !note.title.trim().is_empty() || note.body.trim().is_empty() {
        return;
    }

    if let Some(title) = maybe_generate_note_title(app, settings, &note.body).await {
        if title.trim().is_empty() {
            return;
        }
        if let Ok(current) = history_manager.get_note_by_id(note.id).await {
            if !current.title.trim().is_empty() {
                return;
            }
        }
        if let Err(err) = history_manager.update_note_title(note.id, title).await {
            error!("Failed to update note title: {}", err);
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
        #[cfg(target_os = "macos")]
        {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        }
    }
}

async fn handle_take_note_command(
    app: &AppHandle,
    history_manager: &Arc<HistoryManager>,
    content: Option<String>,
) -> Result<(), String> {
    show_main_window(app);
    let _ = app.emit("navigate-to", "notes");

    let raw_body = content.unwrap_or_default();
    let settings = get_settings(app);
    let body = if raw_body.trim().is_empty() {
        raw_body
    } else {
        polish::deterministic_polish_with_options(
            &raw_body,
            AppProfile::Default,
            settings.post_process_remove_fillers,
        )
    };
    let note = history_manager
        .create_note(String::new(), body)
        .await
        .map_err(|e| e.to_string())?;

    history_manager.set_active_note_id(Some(note.id));
    let _ = app.emit("notes-focus", note.id);

    ensure_note_title(app, &settings, history_manager, &note).await;

    Ok(())
}

async fn maybe_convert_chinese_variant(
    settings: &AppSettings,
    transcription: &str,
) -> Option<String> {
    // Check if language is set to Simplified or Traditional Chinese
    let is_simplified = settings.selected_language == "zh-Hans";
    let is_traditional = settings.selected_language == "zh-Hant";

    if !is_simplified && !is_traditional {
        debug!("selected_language is not Simplified or Traditional Chinese; skipping translation");
        return None;
    }

    debug!(
        "Starting Chinese translation using OpenCC for language: {}",
        settings.selected_language
    );

    // Use OpenCC to convert based on selected language
    let config = if is_simplified {
        // Convert Traditional Chinese to Simplified Chinese
        BuiltinConfig::Tw2sp
    } else {
        // Convert Simplified Chinese to Traditional Chinese
        BuiltinConfig::S2twp
    };

    match OpenCC::from_config(config) {
        Ok(converter) => {
            let converted = converter.convert(transcription);
            debug!(
                "OpenCC translation completed. Input length: {}, Output length: {}",
                transcription.len(),
                converted.len()
            );
            Some(converted)
        }
        Err(e) => {
            error!("Failed to initialize OpenCC converter: {}. Falling back to original transcription.", e);
            None
        }
    }
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);
        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let now_ms = unix_time_ms();
        let since_stop_ms = now_ms.saturating_sub(LAST_TRANSCRIBE_STOP_MS.load(Ordering::SeqCst));
        if since_stop_ms < TRANSCRIBE_RESTART_DEBOUNCE_MS {
            debug!(
                "TranscribeAction::start ignored due debounce ({}ms since stop)",
                since_stop_ms
            );
            return;
        }

        let state_before = TRANSCRIBE_ACTION_STATE.load(Ordering::SeqCst);
        if state_before == TRANSCRIBE_ACTION_STOPPING {
            if since_stop_ms > TRANSCRIBE_STOP_STALE_RESET_MS && !rm.is_recording() {
                debug!(
                    "TranscribeAction::start recovered stale stopping state after {}ms; forcing idle",
                    since_stop_ms
                );
                TRANSCRIBE_ACTION_STATE.store(TRANSCRIBE_ACTION_IDLE, Ordering::SeqCst);
            } else {
                debug!(
                    "TranscribeAction::start ignored (state=stopping, {}ms since stop)",
                    since_stop_ms
                );
                return;
            }
        }
        if TRANSCRIBE_ACTION_STATE
            .compare_exchange(
                TRANSCRIBE_ACTION_IDLE,
                TRANSCRIBE_ACTION_RECORDING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            let state_now = TRANSCRIBE_ACTION_STATE.load(Ordering::SeqCst);
            debug!(
                "TranscribeAction::start ignored (state={})",
                transcribe_action_state_name(state_now)
            );
            return;
        }

        let suppress_feedback_audio = false;

        // Load model in the background
        let tm = app.state::<Arc<TranscriptionManager>>();
        tm.initiate_model_load();

        let binding_id = binding_id.to_string();

        // Get the microphone mode to determine audio feedback timing
        let settings = get_settings(app);
        let is_always_on = settings.always_on_microphone;
        debug!("Microphone mode - always_on: {}", is_always_on);

        let mut recording_started = false;
        if is_always_on {
            recording_started = rm.try_start_recording(&binding_id);
            if recording_started {
                let recording_generation = rm.current_recording_generation();
                if suppress_feedback_audio {
                    rm.apply_mute_force();
                } else {
                    // Always-on mode: Play audio feedback immediately, then apply mute after sound finishes
                    debug!("Always-on mode: Playing audio feedback immediately");
                    let rm_clone = Arc::clone(&rm);
                    let app_clone = app.clone();
                    // The blocking helper exits immediately if audio feedback is disabled,
                    // so we can always reuse this thread to ensure mute happens right after playback.
                    std::thread::spawn(move || {
                        play_feedback_sound_blocking(&app_clone, SoundType::Start);
                        rm_clone.apply_mute_if_generation(recording_generation);
                    });
                }
            }
            debug!("Recording started: {}", recording_started);
        } else {
            // On-demand mode: Start recording first, then play audio feedback, then apply mute
            // This allows the microphone to be activated before playing the sound
            debug!("On-demand mode: Starting recording first, then audio feedback");
            let recording_start_time = Instant::now();
            if rm.try_start_recording(&binding_id) {
                recording_started = true;
                let recording_generation = rm.current_recording_generation();
                debug!("Recording started in {:?}", recording_start_time.elapsed());
                if suppress_feedback_audio {
                    rm.apply_mute_force();
                } else {
                    // Small delay to ensure microphone stream is active
                    let app_clone = app.clone();
                    let rm_clone = Arc::clone(&rm);
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        debug!("Handling delayed audio feedback/mute sequence");
                        // Helper handles disabled audio feedback by returning early, so we reuse it
                        // to keep mute sequencing consistent in every mode.
                        play_feedback_sound_blocking(&app_clone, SoundType::Start);
                        rm_clone.apply_mute_if_generation(recording_generation);
                    });
                }
            } else {
                debug!("Failed to start recording");
            }
        }

        if recording_started {
            // Start capture first, then update UI. This avoids UI work delaying input.
            change_tray_icon(app, TrayIconState::Recording);
            show_recording_overlay(app);

            // Dynamically register the cancel shortcut in a separate task to avoid deadlock.
            shortcut::register_cancel_shortcut(app);
        } else {
            debug!("Recording did not start; skipping recording UI state update");
            TRANSCRIBE_ACTION_STATE.store(TRANSCRIBE_ACTION_IDLE, Ordering::SeqCst);
        }

        debug!(
            "TranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let transitioned_to_stopping = match TRANSCRIBE_ACTION_STATE.compare_exchange(
            TRANSCRIBE_ACTION_RECORDING,
            TRANSCRIBE_ACTION_STOPPING,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(state_before) => {
                if rm.is_recording() && state_before != TRANSCRIBE_ACTION_STOPPING {
                    let previous =
                        TRANSCRIBE_ACTION_STATE.swap(TRANSCRIBE_ACTION_STOPPING, Ordering::SeqCst);
                    if previous != TRANSCRIBE_ACTION_STOPPING {
                        debug!(
                            "TranscribeAction::stop recovered state transition from {}",
                            transcribe_action_state_name(previous)
                        );
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
        };

        if !transitioned_to_stopping {
            let state_now = TRANSCRIBE_ACTION_STATE.load(Ordering::SeqCst);
            debug!(
                "TranscribeAction::stop ignored (state={}, recording_active={})",
                transcribe_action_state_name(state_now),
                rm.is_recording()
            );
            return;
        }
        LAST_TRANSCRIBE_STOP_MS.store(unix_time_ms(), Ordering::SeqCst);

        shortcut::unregister_cancel_shortcut(app);

        let stop_time = Instant::now();
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let ah = app.clone();
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());
        let suppress_feedback_audio = false;

        show_transcribing_overlay(app);
        change_tray_icon(app, TrayIconState::Transcribing);

        if !suppress_feedback_audio {
            // On macOS, restoring mute/duck state can block on AppleScript volume calls.
            // Keep that work off the release hot path so the overlay can switch to the
            // transcribing spinner immediately when the shortcut is released.
            let app_for_feedback = app.clone();
            let rm_for_feedback = Arc::clone(&rm);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(12));
                // Unmute before playing audio feedback so the stop sound is audible.
                rm_for_feedback.remove_mute();
                // Play audio feedback for recording stop.
                play_feedback_sound(&app_for_feedback, SoundType::Stop);
            });
        }

        let binding_id = binding_id.to_string(); // Clone binding_id for the async task

        tauri::async_runtime::spawn(async move {
            let _activity_guard = TranscriptionActivityGuard::new();
            let binding_id = binding_id.clone(); // Clone for the inner async task
            debug!(
                "Starting async transcription task for binding: {}",
                binding_id
            );

            let stop_recording_time = Instant::now();
            let stopped_recording = rm.stop_recording(&binding_id);
            TRANSCRIBE_ACTION_STATE.store(TRANSCRIBE_ACTION_IDLE, Ordering::SeqCst);
            if !rm.is_recording() {
                // Always restore any duck/mute state once recording is fully idle.
                rm.remove_mute();
            }

            if let Some(recording) = stopped_recording {
                if suppress_feedback_audio {
                    rm.remove_mute();
                }
                debug!(
                    "Recording stopped and samples retrieved in {:?}, sample count: {}",
                    stop_recording_time.elapsed(),
                    recording.samples.len()
                );

                let transcription_time = Instant::now();
                let samples_clone = recording.samples.clone(); // Clone for history saving
                let duration_seconds = recording.duration_seconds;
                match tm.transcribe(recording.samples) {
                    Ok(transcription) => {
                        debug!(
                            "Transcription completed in {:?}: '{}'",
                            transcription_time.elapsed(),
                            transcription
                        );
                        if !transcription.is_empty() {
                            if let Some(command) =
                                polish::detect_spoken_command(transcription.as_str())
                            {
                                if let polish::SpokenCommand::TakeNote { content } = command {
                                    let ah_clone = ah.clone();
                                    let hm_clone = Arc::clone(&hm);
                                    tauri::async_runtime::spawn(async move {
                                        if let Err(e) =
                                            handle_take_note_command(&ah_clone, &hm_clone, content)
                                                .await
                                        {
                                            error!("Failed to handle take note command: {}", e);
                                        }
                                        utils::hide_recording_overlay(&ah_clone);
                                        change_tray_icon(&ah_clone, TrayIconState::Idle);
                                    });
                                    return;
                                }

                                let ah_clone = ah.clone();
                                let insertion_manager =
                                    Arc::clone(&ah.state::<Arc<InsertionManager>>());
                                ah.run_on_main_thread(move || {
                                    let result = match command {
                                        polish::SpokenCommand::UndoLast => {
                                            insertion_manager.undo_last(&ah_clone)
                                        }
                                        polish::SpokenCommand::InsertNewLine => {
                                            utils::paste("\n".to_string(), ah_clone.clone())
                                                .map(|_| ())
                                        }
                                        polish::SpokenCommand::InsertNewParagraph => {
                                            utils::paste("\n\n".to_string(), ah_clone.clone())
                                                .map(|_| ())
                                        }
                                        polish::SpokenCommand::DeleteLastSentence => {
                                            insertion_manager.delete_last_sentence(&ah_clone)
                                        }
                                        polish::SpokenCommand::OpenApp { query } => {
                                            app_launcher::open_app_from_command(&ah_clone, &query)
                                        }
                                        polish::SpokenCommand::TakeNote { .. } => Ok(()),
                                    };
                                    if let Err(e) = result {
                                        error!("Failed to handle spoken command: {}", e);
                                    }
                                    utils::hide_recording_overlay(&ah_clone);
                                    change_tray_icon(&ah_clone, TrayIconState::Idle);
                                })
                                .unwrap_or_else(|e| {
                                    error!("Failed to run command on main thread: {:?}", e);
                                    utils::hide_recording_overlay(&ah);
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                });
                                return;
                            }

                            let settings = get_settings(&ah);
                            let focus_context = crate::focus_context::get_active_context();
                            let app_profile = polish::resolve_profile(
                                focus_context.as_ref(),
                                &settings.app_profile_overrides,
                            );
                            let mut final_text = transcription.clone();
                            let mut post_processed_text: Option<String> = None;
                            let mut post_process_prompt: Option<String> = None;

                            let glossary_data = glossary::build_glossary(
                                &settings,
                                focus_context.as_ref(),
                                &final_text,
                            );
                            let glossary_block =
                                glossary::format_glossary_block(&glossary_data, 24);

                            let glossary_applied = glossary::apply_glossary(
                                &final_text,
                                &glossary_data,
                                settings.word_correction_threshold,
                            );
                            if glossary_applied != final_text {
                                final_text = glossary_applied.clone();
                                post_processed_text = Some(glossary_applied);
                            }

                            let cleaned = polish::deterministic_polish_with_options(
                                &final_text,
                                app_profile,
                                settings.post_process_remove_fillers,
                            );
                            if cleaned != final_text {
                                final_text = cleaned.clone();
                                post_processed_text = Some(cleaned);
                            }

                            let glossary_after_polish = glossary::apply_glossary(
                                &final_text,
                                &glossary_data,
                                settings.word_correction_threshold,
                            );
                            if glossary_after_polish != final_text {
                                final_text = glossary_after_polish.clone();
                                post_processed_text = Some(glossary_after_polish);
                            }

                            // First, check if Chinese variant conversion is needed
                            if let Some(converted_text) =
                                maybe_convert_chinese_variant(&settings, &final_text).await
                            {
                                final_text = converted_text.clone();
                                post_processed_text = Some(converted_text);
                            }
                            // Then apply regular post-processing
                            else {
                                if let Some(processed_text) = maybe_post_process_transcription(
                                    &ah,
                                    &settings,
                                    &final_text,
                                    focus_context.as_ref(),
                                    app_profile,
                                    if glossary_block.trim().is_empty() {
                                        None
                                    } else {
                                        Some(glossary_block.as_str())
                                    },
                                )
                                .await
                                {
                                    final_text = processed_text.text.clone();
                                    post_processed_text = Some(processed_text.text);
                                    post_process_prompt = Some(processed_text.prompt);
                                }
                            }

                            let glossary_after_llm = glossary::apply_glossary(
                                &final_text,
                                &glossary_data,
                                settings.word_correction_threshold,
                            );
                            if glossary_after_llm != final_text {
                                final_text = glossary_after_llm.clone();
                                post_processed_text = Some(glossary_after_llm);
                            }

                            let active_note_id = hm.get_active_note_id();
                            if let Some(note_id) = active_note_id {
                                match hm.append_to_note(note_id, final_text.clone()).await {
                                    Ok(note) => {
                                        ensure_note_title(&ah, &settings, &hm, &note).await;
                                        let _ = ah.emit("notes-focus", note.id);
                                    }
                                    Err(e) => {
                                        error!("Failed to append to note: {}", e);
                                        hm.set_active_note_id(None);
                                    }
                                }

                                let hm_clone = Arc::clone(&hm);
                                let transcription_for_history = transcription.clone();
                                let post_processed_for_history = post_processed_text.clone();
                                let post_process_prompt_for_history = post_process_prompt.clone();
                                let samples_for_history = samples_clone;
                                let duration_for_history = duration_seconds;
                                let focus_context_for_history = focus_context.clone();
                                let ah_clone = ah.clone();
                                ah.run_on_main_thread(move || {
                                    let hm_clone = Arc::clone(&hm_clone);
                                    tauri::async_runtime::spawn(async move {
                                        if let Err(e) = hm_clone
                                            .save_transcription(
                                                samples_for_history,
                                                duration_for_history,
                                                transcription_for_history,
                                                post_processed_for_history,
                                                post_process_prompt_for_history,
                                                focus_context_for_history,
                                            )
                                            .await
                                        {
                                            error!(
                                                "Failed to save transcription to history: {}",
                                                e
                                            );
                                        }
                                    });

                                    utils::hide_recording_overlay(&ah_clone);
                                    change_tray_icon(&ah_clone, TrayIconState::Idle);
                                })
                                .unwrap_or_else(|e| {
                                    error!("Failed to run note capture on main thread: {:?}", e);
                                    utils::hide_recording_overlay(&ah);
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                });
                                return;
                            }

                            let hm_clone = Arc::clone(&hm);
                            let transcription_for_history = transcription.clone();
                            let post_processed_for_history = post_processed_text.clone();
                            let post_process_prompt_for_history = post_process_prompt.clone();
                            let samples_for_history = samples_clone;
                            let duration_for_history = duration_seconds;
                            let focus_context_for_history = focus_context.clone();
                            let focus_context_for_paste = focus_context.clone();

                            // Paste the final text (either processed or original)
                            let ah_clone = ah.clone();
                            let paste_time = Instant::now();
                            ah.run_on_main_thread(move || {
                                let hm_clone = Arc::clone(&hm_clone);
                                tauri::async_runtime::spawn(async move {
                                    if let Err(e) = hm_clone
                                        .save_transcription(
                                            samples_for_history,
                                            duration_for_history,
                                            transcription_for_history,
                                            post_processed_for_history,
                                            post_process_prompt_for_history,
                                            focus_context_for_history,
                                        )
                                        .await
                                    {
                                        error!("Failed to save transcription to history: {}", e);
                                    }
                                });

                                let mut show_clipboard_notice = false;
                                let target_pid = focus_context_for_paste
                                    .as_ref()
                                    .and_then(|context| context.process_id);
                                let focus_state =
                                    crate::input_focus::focused_text_input_state_for_process(
                                        target_pid,
                                    );
                                let should_attempt_paste =
                                    should_attempt_transcription_paste(focus_state);

                                info!(
                                    "Insertion focus decision: target_pid={:?} focus_state={:?} should_attempt_paste={}",
                                    target_pid, focus_state, should_attempt_paste
                                );

                                let insertion_outcome = if should_attempt_paste {
                                    utils::paste_with_focus_context(
                                        final_text.clone(),
                                        ah_clone.clone(),
                                        focus_context_for_paste,
                                    )
                                } else {
                                    info!(
                                        "No focused text input detected. Copying transcription to clipboard without paste attempt."
                                    );
                                    utils::copy_text_to_clipboard(final_text.clone(), ah_clone.clone())
                                };

                                match insertion_outcome {
                                    Ok(crate::clipboard::PasteOutcome::Pasted) => {
                                        info!(
                                            "Transcription pasted in {:?} (focus_state={:?})",
                                            paste_time.elapsed(),
                                            focus_state
                                        );
                                    }
                                    Ok(crate::clipboard::PasteOutcome::ClipboardOnly) => {
                                        show_clipboard_notice = true;
                                        info!(
                                            "Transcription fell back to clipboard in {:?} (focus_state={:?})",
                                            paste_time.elapsed(),
                                            focus_state
                                        );
                                    }
                                    Err(e) => error!("Failed to paste transcription: {}", e),
                                }
                                if show_clipboard_notice {
                                    if !utils::show_clipboard_notice_overlay(&ah_clone) {
                                        utils::hide_recording_overlay(&ah_clone);
                                    }
                                } else {
                                    // Hide the overlay after transcription is complete
                                    utils::hide_recording_overlay(&ah_clone);
                                }
                                change_tray_icon(&ah_clone, TrayIconState::Idle);
                            })
                            .unwrap_or_else(|e| {
                                error!("Failed to run paste on main thread: {:?}", e);
                                utils::hide_recording_overlay(&ah);
                                change_tray_icon(&ah, TrayIconState::Idle);
                            });
                        } else {
                            utils::hide_recording_overlay(&ah);
                            change_tray_icon(&ah, TrayIconState::Idle);
                        }
                    }
                    Err(err) => {
                        debug!("Global Shortcut Transcription error: {}", err);
                        utils::hide_recording_overlay(&ah);
                        change_tray_icon(&ah, TrayIconState::Idle);
                    }
                }
            } else {
                if suppress_feedback_audio {
                    rm.remove_mute();
                }
                debug!("No samples retrieved from recording stop");
                utils::hide_recording_overlay(&ah);
                change_tray_icon(&ah, TrayIconState::Idle);
            }
        });

        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}

// Cancel Action
struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        utils::cancel_current_operation(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for cancel
    }
}

// Test Action
struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Started - {} (App: {})", // Changed "Pressed" to "Started" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Stopped - {} (App: {})", // Changed "Released" to "Stopped" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}

// Clipboard History Action
struct ClipboardHistoryAction;

impl ShortcutAction for ClipboardHistoryAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        clipboard_overlay::show_clipboard_overlay(app);
    }

    fn stop(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        if let Some(overlay_window) = app.get_webview_window("clipboard_overlay") {
            if overlay_window.is_visible().unwrap_or(false) {
                let _ = overlay_window.emit("clipboard-overlay-hotkey-released", ());
            }
        }
    }
}

// Quick Task Action
struct QuickTaskAction;

impl ShortcutAction for QuickTaskAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        quick_task_overlay::show_quick_task_overlay(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // One-shot action on key press
    }
}

// Static Action Map
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "transcribe".to_string(),
        Arc::new(TranscribeAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "clipboard_history".to_string(),
        Arc::new(ClipboardHistoryAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "quick_task".to_string(),
        Arc::new(QuickTaskAction) as Arc<dyn ShortcutAction>,
    );
    map
});
