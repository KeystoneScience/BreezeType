use log::{error, warn};
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::actions::ACTION_MAP;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::local_llm::LocalLlmManager;
use crate::settings::ShortcutBinding;
use crate::settings::{
    self, get_settings, AppThemePreference, ClipboardHandling, LLMPrompt, OverlayPosition,
    PasteMethod, RecordingOutputMode, SoundTheme, APPLE_INTELLIGENCE_DEFAULT_MODEL_ID,
    APPLE_INTELLIGENCE_PROVIDER_ID, OPENAI_CODEX_DEFAULT_MODEL_ID, OPENAI_CODEX_PROVIDER_ID,
};
use crate::tray;
use crate::ManagedToggleState;

static CANCEL_SHORTCUT_DESIRED: AtomicBool = AtomicBool::new(false);
static CANCEL_SHORTCUT_REGISTERED: AtomicBool = AtomicBool::new(false);
static SHORTCUT_PRESSED_STATE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

fn update_shortcut_edge_state(binding_id: &str, state: ShortcutState) -> bool {
    let state_map = SHORTCUT_PRESSED_STATE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut lock = match state_map.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            error!("shortcut edge state lock poisoned; recovering");
            poisoned.into_inner()
        }
    };

    let pressed = lock.entry(binding_id.to_string()).or_insert(false);
    match state {
        ShortcutState::Pressed => {
            if *pressed {
                false
            } else {
                *pressed = true;
                true
            }
        }
        ShortcutState::Released => {
            if !*pressed {
                false
            } else {
                *pressed = false;
                true
            }
        }
    }
}

fn reset_shortcut_edge_state(binding_id: &str) {
    let state_map = SHORTCUT_PRESSED_STATE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut lock = match state_map.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            error!("shortcut edge state lock poisoned during reset; recovering");
            poisoned.into_inner()
        }
    };
    lock.insert(binding_id.to_string(), false);
}

pub fn init_shortcuts(app: &AppHandle) {
    CANCEL_SHORTCUT_DESIRED.store(false, Ordering::SeqCst);
    CANCEL_SHORTCUT_REGISTERED.store(false, Ordering::SeqCst);
    let default_bindings = settings::get_default_settings().bindings;
    let user_settings = settings::load_or_create_app_settings(app);

    // Register all default shortcuts, applying user customizations
    for (id, default_binding) in default_bindings {
        if id == "cancel" {
            continue; // Skip cancel shortcut, it will be registered dynamically
        }
        let binding = user_settings
            .bindings
            .get(&id)
            .cloned()
            .unwrap_or(default_binding);

        if let Err(e) = register_shortcut(app, binding) {
            error!("Failed to register shortcut {} during init: {}", id, e);
        }
    }
}

#[derive(Serialize, Type)]
pub struct BindingResponse {
    success: bool,
    binding: Option<ShortcutBinding>,
    error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn change_binding(
    app: AppHandle,
    id: String,
    binding: String,
) -> Result<BindingResponse, String> {
    let mut settings = settings::get_settings(&app);
    let is_clipboard_history = id == "clipboard_history";

    // Get the binding to modify
    let binding_to_modify = match settings.bindings.get(&id) {
        Some(binding) => binding.clone(),
        None => {
            let error_msg = format!("Binding with id '{}' not found", id);
            warn!("change_binding error: {}", error_msg);
            return Ok(BindingResponse {
                success: false,
                binding: None,
                error: Some(error_msg),
            });
        }
    };
    // If this is the cancel binding, just update the settings and return
    // It's managed dynamically, so we don't register/unregister here
    if id == "cancel" {
        if let Some(mut b) = settings.bindings.get(&id).cloned() {
            b.current_binding = binding;
            settings.bindings.insert(id.clone(), b.clone());
            settings::write_settings(&app, settings);
            return Ok(BindingResponse {
                success: true,
                binding: Some(b.clone()),
                error: None,
            });
        }
    }

    // Unregister the existing binding
    if let Err(e) = unregister_shortcut(&app, binding_to_modify.clone()) {
        let error_msg = format!("Failed to unregister shortcut: {}", e);
        error!("change_binding error: {}", error_msg);
    }

    // Validate the new shortcut before we touch the current registration
    if let Err(e) = validate_shortcut_string(&binding) {
        warn!("change_binding validation error: {}", e);
        return Err(e);
    }
    if id == "transcribe" && binding.to_ascii_lowercase().contains("tab") {
        return Err(
            "Tab-based transcribe shortcuts are not supported because they can change text focus. Use a non-Tab shortcut (for example, cmd+shift+x)."
                .to_string(),
        );
    }

    // Create an updated binding
    let mut updated_binding = binding_to_modify;
    updated_binding.current_binding = binding;

    // Register the new binding
    if let Err(e) = register_shortcut(&app, updated_binding.clone()) {
        let error_msg = format!("Failed to register shortcut: {}", e);
        error!("change_binding error: {}", error_msg);
        return Ok(BindingResponse {
            success: false,
            binding: None,
            error: Some(error_msg),
        });
    }

    // Update the binding in the settings
    settings.bindings.insert(id, updated_binding.clone());
    if is_clipboard_history {
        settings.clipboard_quick_pastes = settings::sanitize_clipboard_quick_pastes(
            &settings.clipboard_quick_pastes,
            &updated_binding.current_binding,
        );
    }

    // Save the settings
    settings::write_settings(&app, settings);

    // Return the updated binding
    Ok(BindingResponse {
        success: true,
        binding: Some(updated_binding),
        error: None,
    })
}

#[tauri::command]
#[specta::specta]
pub fn reset_binding(app: AppHandle, id: String) -> Result<BindingResponse, String> {
    let binding = settings::get_stored_binding(&app, &id);

    return change_binding(app, id, binding.default_binding);
}

#[tauri::command]
#[specta::specta]
pub fn change_ptt_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let fn_key_enabled = settings.fn_key_ptt_enabled;

    // TODO if the setting is currently false, we probably want to
    // cancel any ongoing recordings or actions
    settings.push_to_talk = enabled;

    settings::write_settings(&app, settings);

    #[cfg(target_os = "macos")]
    {
        crate::macos_fn_key::set_ptt_enabled(enabled);
        if enabled && fn_key_enabled {
            crate::macos_fn_key::ensure_started(&app);
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_fn_key_ptt_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.fn_key_ptt_enabled = enabled;
    settings::write_settings(&app, settings);

    #[cfg(target_os = "macos")]
    {
        crate::macos_fn_key::set_fn_key_enabled(enabled);
        if enabled {
            crate::macos_fn_key::ensure_started(&app);
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_audio_feedback_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.audio_feedback = enabled;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_audio_feedback_volume_setting(app: AppHandle, volume: f32) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.audio_feedback_volume = volume;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_sound_theme_setting(app: AppHandle, theme: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let parsed = match theme.as_str() {
        "marimba" => SoundTheme::Marimba,
        "pop" => SoundTheme::Pop,
        "custom" => SoundTheme::Custom,
        other => {
            warn!("Invalid sound theme '{}', defaulting to marimba", other);
            SoundTheme::Marimba
        }
    };
    settings.sound_theme = parsed;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_app_theme_setting(app: AppHandle, theme: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let parsed = match theme.as_str() {
        "system" => AppThemePreference::System,
        "light" => AppThemePreference::Light,
        "dark" => AppThemePreference::Dark,
        other => {
            warn!("Invalid app theme '{}', defaulting to system", other);
            AppThemePreference::System
        }
    };
    settings.app_theme = parsed;
    settings::write_settings(&app, settings);

    crate::utils::change_tray_icon(&app, crate::tray::TrayIconState::Idle);

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_translate_to_english_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.translate_to_english = enabled;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_selected_language_setting(app: AppHandle, language: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.selected_language = language;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_overlay_position_setting(app: AppHandle, position: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let parsed = match position.as_str() {
        "none" => OverlayPosition::None,
        "top" => OverlayPosition::Top,
        "bottom" => OverlayPosition::Bottom,
        other => {
            warn!("Invalid overlay position '{}', defaulting to bottom", other);
            OverlayPosition::Bottom
        }
    };
    settings.overlay_position = parsed;
    settings::write_settings(&app, settings);

    // Update overlay position without recreating window
    crate::utils::update_overlay_position(&app);

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_meeting_detection_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.meeting_detection_enabled = enabled;
    settings::write_settings(&app, settings);

    if !enabled {
        crate::meeting_prompt::hide_meeting_prompt(&app);
        let manager = app
            .state::<std::sync::Arc<crate::managers::meeting_detection::MeetingDetectionManager>>();
        manager.reset_state();
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_debug_mode_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.debug_mode = enabled;
    settings::write_settings(&app, settings);

    // Emit event to notify frontend of debug mode change
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({
            "setting": "debug_mode",
            "value": enabled
        }),
    );

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_start_hidden_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.start_hidden = enabled;
    settings::write_settings(&app, settings);

    // Notify frontend
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({
            "setting": "start_hidden",
            "value": enabled
        }),
    );

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_autostart_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.autostart_enabled = enabled;
    settings::write_settings(&app, settings);

    // Apply the autostart setting immediately
    let autostart_manager = app.autolaunch();
    if enabled {
        let _ = autostart_manager.enable();
    } else {
        let _ = autostart_manager.disable();
    }

    // Notify frontend
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({
            "setting": "autostart_enabled",
            "value": enabled
        }),
    );

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_update_checks_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.update_checks_enabled = enabled;
    settings::write_settings(&app, settings);

    let _ = app.emit(
        "settings-changed",
        serde_json::json!({
            "setting": "update_checks_enabled",
            "value": enabled
        }),
    );

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_app_profile_override(
    app: AppHandle,
    key: String,
    profile: String,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings
        .app_profile_overrides
        .insert(key.to_lowercase(), profile);
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn remove_app_profile_override(app: AppHandle, key: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.app_profile_overrides.remove(&key.to_lowercase());
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn update_custom_words(app: AppHandle, words: Vec<String>) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let mut next_words = Vec::new();
    let mut next_dictionary = Vec::new();
    for word in words {
        let trimmed = word.trim();
        if trimmed.is_empty() {
            continue;
        }
        let definition = settings
            .custom_dictionary
            .iter()
            .find(|entry| entry.term.eq_ignore_ascii_case(trimmed))
            .map(|entry| entry.definition.clone())
            .unwrap_or_default();
        next_words.push(trimmed.to_string());
        next_dictionary.push(settings::DictionaryEntry {
            term: trimmed.to_string(),
            definition,
        });
    }
    settings.custom_words = next_words;
    settings.custom_dictionary = next_dictionary;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn update_custom_dictionary(
    app: AppHandle,
    entries: Vec<settings::DictionaryEntry>,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let mut next_entries = Vec::new();
    let mut next_words = Vec::new();

    for entry in entries {
        let term = entry.term.trim();
        if term.is_empty() {
            continue;
        }
        next_entries.push(settings::DictionaryEntry {
            term: term.to_string(),
            definition: entry.definition.trim().to_string(),
        });
        next_words.push(term.to_string());
    }

    settings.custom_dictionary = next_entries;
    settings.custom_words = next_words;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_word_correction_threshold_setting(
    app: AppHandle,
    threshold: f64,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.word_correction_threshold = threshold;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_paste_method_setting(app: AppHandle, method: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let parsed = match method.as_str() {
        "ctrl_v" => PasteMethod::CtrlV,
        "direct" => PasteMethod::Direct,
        "none" => PasteMethod::None,
        "shift_insert" => PasteMethod::ShiftInsert,
        "ctrl_shift_v" => PasteMethod::CtrlShiftV,
        other => {
            warn!("Invalid paste method '{}', defaulting to ctrl_v", other);
            PasteMethod::CtrlV
        }
    };
    settings.paste_method = parsed;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_clipboard_handling_setting(app: AppHandle, handling: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let parsed = match handling.as_str() {
        "dont_modify" => ClipboardHandling::DontModify,
        "copy_to_clipboard" => ClipboardHandling::CopyToClipboard,
        other => {
            warn!(
                "Invalid clipboard handling '{}', defaulting to dont_modify",
                other
            );
            ClipboardHandling::DontModify
        }
    };
    settings.clipboard_handling = parsed;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_clipboard_quick_pastes_setting(
    app: AppHandle,
    mappings: HashMap<String, String>,
) -> Result<(), String> {
    const MAX_QUICK_PASTE_CHARS: usize = 20_000;

    let mut settings = settings::get_settings(&app);
    let shortcut = settings
        .bindings
        .get("clipboard_history")
        .map(|binding| binding.current_binding.clone())
        .unwrap_or_else(|| "ctrl+shift+v".to_string());
    let reserved = settings::reserved_clipboard_shortcut_keys(&shortcut);
    let mut normalized = HashMap::new();

    for (raw_key, raw_text) in mappings {
        let key = settings::normalize_clipboard_quick_paste_key(&raw_key)
            .ok_or_else(|| format!("Invalid quick paste key '{}'", raw_key))?;

        if reserved.contains(&key) {
            return Err(format!(
                "Key '{}' is already used by clipboard history shortcut '{}'",
                key, shortcut
            ));
        }

        if raw_text.trim().is_empty() {
            return Err(format!(
                "Quick paste text for key '{}' cannot be empty",
                key
            ));
        }

        if raw_text.chars().count() > MAX_QUICK_PASTE_CHARS {
            return Err(format!(
                "Quick paste text for key '{}' exceeds {} characters",
                key, MAX_QUICK_PASTE_CHARS
            ));
        }

        if normalized.insert(key.clone(), raw_text).is_some() {
            return Err(format!("Duplicate quick paste key '{}'", key));
        }
    }

    settings.clipboard_quick_pastes = normalized;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_enabled_setting(app: AppHandle, _enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.post_process_enabled = true;
    let provider_id = settings.post_process_provider_id.clone();
    let selected_model_id = settings
        .post_process_models
        .get("local_llama")
        .cloned()
        .unwrap_or_default();
    settings::write_settings(&app, settings);

    if provider_id == "local_llama" {
        if let Some(manager) = app.try_state::<Arc<LocalLlmManager>>() {
            manager.ensure_assets_async(&app, &selected_model_id);
            manager.ensure_running_async(&app, &selected_model_id);
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_remove_fillers_setting(
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.post_process_remove_fillers = enabled;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_base_url_setting(
    app: AppHandle,
    provider_id: String,
    base_url: String,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let label = settings
        .post_process_provider(&provider_id)
        .map(|provider| provider.label.clone())
        .ok_or_else(|| format!("Provider '{}' not found", provider_id))?;

    let provider = settings
        .post_process_provider_mut(&provider_id)
        .expect("Provider looked up above must exist");

    if provider.id != "custom" {
        return Err(format!(
            "Provider '{}' does not allow editing the base URL",
            label
        ));
    }

    provider.base_url = base_url;
    settings::write_settings(&app, settings);
    Ok(())
}

/// Generic helper to validate provider exists
fn validate_provider_exists(
    settings: &settings::AppSettings,
    provider_id: &str,
) -> Result<(), String> {
    if !settings
        .post_process_providers
        .iter()
        .any(|provider| provider.id == provider_id)
    {
        return Err(format!("Provider '{}' not found", provider_id));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_api_key_setting(
    app: AppHandle,
    provider_id: String,
    api_key: String,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    validate_provider_exists(&settings, &provider_id)?;
    settings.post_process_api_keys.insert(provider_id, api_key);
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_post_process_model_setting(
    app: AppHandle,
    provider_id: String,
    model: String,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    validate_provider_exists(&settings, &provider_id)?;
    let is_local_provider = provider_id == "local_llama";
    settings
        .post_process_models
        .insert(provider_id.clone(), model);
    let selected_model_id = settings
        .post_process_models
        .get("local_llama")
        .cloned()
        .unwrap_or_default();
    let should_start = settings.post_process_provider_id == "local_llama";
    settings::write_settings(&app, settings);
    if is_local_provider {
        if let Some(manager) = app.try_state::<Arc<LocalLlmManager>>() {
            manager.ensure_assets_async(&app, &selected_model_id);
            if should_start {
                manager.ensure_running_async(&app, &selected_model_id);
            }
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_post_process_provider(app: AppHandle, provider_id: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    validate_provider_exists(&settings, &provider_id)?;
    settings.post_process_provider_id = provider_id;
    let provider_id = settings.post_process_provider_id.clone();
    let selected_model_id = settings
        .post_process_models
        .get("local_llama")
        .cloned()
        .unwrap_or_default();
    settings::write_settings(&app, settings);

    if provider_id == "local_llama" {
        if let Some(manager) = app.try_state::<Arc<LocalLlmManager>>() {
            manager.ensure_assets_async(&app, &selected_model_id);
            manager.ensure_running_async(&app, &selected_model_id);
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn connect_openai_codex_oauth(
    app: AppHandle,
) -> Result<crate::openai_codex_oauth::OpenAICodexOAuthStatus, String> {
    let status = crate::openai_codex_oauth::connect_openai_codex(&app).await?;

    let mut settings = settings::get_settings(&app);
    settings.post_process_models.insert(
        OPENAI_CODEX_PROVIDER_ID.to_string(),
        OPENAI_CODEX_DEFAULT_MODEL_ID.to_string(),
    );
    settings::write_settings(&app, settings);

    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub fn disconnect_openai_codex_oauth(app: AppHandle) -> Result<(), String> {
    crate::openai_codex_oauth::clear_credential(&app)?;

    let mut settings = settings::get_settings(&app);
    if settings.post_process_provider_id == OPENAI_CODEX_PROVIDER_ID {
        settings.post_process_provider_id = "local_llama".to_string();
    }
    settings::write_settings(&app, settings);

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_openai_codex_oauth_status(
    app: AppHandle,
) -> Result<crate::openai_codex_oauth::OpenAICodexOAuthStatus, String> {
    Ok(crate::openai_codex_oauth::get_openai_codex_status(&app))
}

#[tauri::command]
#[specta::specta]
pub fn add_post_process_prompt(
    app: AppHandle,
    name: String,
    prompt: String,
) -> Result<LLMPrompt, String> {
    let mut settings = settings::get_settings(&app);

    // Generate unique ID using timestamp and random component
    let id = format!("prompt_{}", chrono::Utc::now().timestamp_millis());

    let new_prompt = LLMPrompt {
        id: id.clone(),
        name,
        prompt,
    };

    settings.post_process_prompts.push(new_prompt.clone());
    settings::write_settings(&app, settings);

    Ok(new_prompt)
}

#[tauri::command]
#[specta::specta]
pub fn update_post_process_prompt(
    app: AppHandle,
    id: String,
    name: String,
    prompt: String,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);

    if let Some(existing_prompt) = settings
        .post_process_prompts
        .iter_mut()
        .find(|p| p.id == id)
    {
        existing_prompt.name = name;
        existing_prompt.prompt = prompt;
        settings::write_settings(&app, settings);
        Ok(())
    } else {
        Err(format!("Prompt with id '{}' not found", id))
    }
}

#[tauri::command]
#[specta::specta]
pub fn delete_post_process_prompt(app: AppHandle, id: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);

    // Don't allow deleting the last prompt
    if settings.post_process_prompts.len() <= 1 {
        return Err("Cannot delete the last prompt".to_string());
    }

    // Find and remove the prompt
    let original_len = settings.post_process_prompts.len();
    settings.post_process_prompts.retain(|p| p.id != id);

    if settings.post_process_prompts.len() == original_len {
        return Err(format!("Prompt with id '{}' not found", id));
    }

    // If the deleted prompt was selected, select the first one or None
    if settings.post_process_selected_prompt_id.as_ref() == Some(&id) {
        settings.post_process_selected_prompt_id =
            settings.post_process_prompts.first().map(|p| p.id.clone());
    }

    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_post_process_models(
    app: AppHandle,
    provider_id: String,
) -> Result<Vec<String>, String> {
    let settings = settings::get_settings(&app);

    // Find the provider
    let provider = settings
        .post_process_providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("Provider '{}' not found", provider_id))?;

    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            return Ok(vec![APPLE_INTELLIGENCE_DEFAULT_MODEL_ID.to_string()]);
        }

        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            return Err("Apple Intelligence is only available on Apple silicon Macs running macOS 15 or later.".to_string());
        }
    }

    if provider.id == OPENAI_CODEX_PROVIDER_ID {
        let status = crate::openai_codex_oauth::get_openai_codex_status(&app);
        if !status.connected {
            return Err(
                "OpenAI account is not connected. Connect your account in Settings first."
                    .to_string(),
            );
        }
        return Ok(crate::openai_codex_oauth::codex_model_options());
    }

    // Get API key
    let api_key = settings
        .post_process_api_keys
        .get(&provider_id)
        .cloned()
        .unwrap_or_default();

    // Skip fetching if no API key for providers that typically need one
    if api_key.trim().is_empty() && provider.id != "custom" {
        return Err(format!(
            "API key is required for {}. Please add an API key to list available models.",
            provider.label
        ));
    }

    crate::llm_client::fetch_models(provider, api_key).await
}

#[tauri::command]
#[specta::specta]
pub fn set_post_process_selected_prompt(app: AppHandle, id: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);

    // Verify the prompt exists
    if !settings.post_process_prompts.iter().any(|p| p.id == id) {
        return Err(format!("Prompt with id '{}' not found", id));
    }

    settings.post_process_selected_prompt_id = Some(id);
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_mute_while_recording_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.mute_while_recording = enabled;
    settings.recording_output_mode = if enabled {
        RecordingOutputMode::Mute
    } else {
        RecordingOutputMode::Off
    };
    settings.recording_duck_level = if enabled { 0.0 } else { 1.0 };
    settings::write_settings(&app, settings);

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_recording_output_mode_setting(app: AppHandle, mode: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    let parsed = match mode.as_str() {
        "off" => RecordingOutputMode::Off,
        "mute" => RecordingOutputMode::Mute,
        "duck" => RecordingOutputMode::Duck,
        other => {
            warn!(
                "Invalid recording output mode '{}', defaulting to off",
                other
            );
            RecordingOutputMode::Off
        }
    };
    settings.recording_duck_level = match parsed {
        RecordingOutputMode::Off => 1.0,
        RecordingOutputMode::Mute => 0.0,
        RecordingOutputMode::Duck => {
            let current = settings.recording_duck_level.clamp(0.0, 1.0);
            if current >= 0.999 || current <= 0.0001 {
                0.22
            } else {
                current
            }
        }
    };
    let effective_mode = settings::recording_output_mode_from_level(settings.recording_duck_level);
    settings.recording_output_mode = effective_mode;
    settings.mute_while_recording = effective_mode == RecordingOutputMode::Mute;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_recording_duck_level_setting(app: AppHandle, level: f32) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.recording_duck_level = level.clamp(0.0, 1.0);
    let effective_mode = settings::recording_output_mode_from_level(settings.recording_duck_level);
    settings.recording_output_mode = effective_mode;
    settings.mute_while_recording = effective_mode == RecordingOutputMode::Mute;
    settings::write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_append_trailing_space_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.append_trailing_space = enabled;
    settings::write_settings(&app, settings);

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_app_language_setting(app: AppHandle, language: String) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.app_language = language.clone();
    settings::write_settings(&app, settings);

    // Refresh the tray menu with the new language
    let tray_state = tray::get_tray_state(&app);
    tray::update_tray_menu(&app, &tray_state, Some(&language));

    Ok(())
}

/// Determine whether a shortcut string contains at least one non-modifier key.
/// We allow single non-modifier keys (e.g. "f5" or "space") but disallow
/// modifier-only combos (e.g. "ctrl" or "ctrl+shift").
fn validate_shortcut_string(raw: &str) -> Result<(), String> {
    let modifiers = [
        "ctrl", "control", "shift", "alt", "option", "meta", "command", "cmd", "super", "win",
        "windows",
    ];
    let has_non_modifier = raw
        .split('+')
        .any(|part| !modifiers.contains(&part.trim().to_lowercase().as_str()));
    if has_non_modifier {
        Ok(())
    } else {
        Err("Shortcut must contain at least one non-modifier key".into())
    }
}

/// Temporarily unregister a binding while the user is editing it in the UI.
/// This avoids firing the action while keys are being recorded.
#[tauri::command]
#[specta::specta]
pub fn suspend_binding(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(b) = settings::get_bindings(&app).get(&id).cloned() {
        if let Err(e) = unregister_shortcut(&app, b) {
            error!("suspend_binding error for id '{}': {}", id, e);
            return Err(e);
        }
    }
    Ok(())
}

/// Re-register the binding after the user has finished editing.
#[tauri::command]
#[specta::specta]
pub fn resume_binding(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(b) = settings::get_bindings(&app).get(&id).cloned() {
        if let Err(e) = register_shortcut(&app, b) {
            error!("resume_binding error for id '{}': {}", id, e);
            return Err(e);
        }
    }
    Ok(())
}

pub fn register_cancel_shortcut(app: &AppHandle) {
    // Cancel shortcut is disabled on Linux due to instability with dynamic shortcut registration
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return;
    }

    #[cfg(not(target_os = "linux"))]
    {
        CANCEL_SHORTCUT_DESIRED.store(true, Ordering::SeqCst);
        if CANCEL_SHORTCUT_REGISTERED.load(Ordering::SeqCst) {
            return;
        }

        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            if !CANCEL_SHORTCUT_DESIRED.load(Ordering::SeqCst) {
                return;
            }
            if CANCEL_SHORTCUT_REGISTERED.load(Ordering::SeqCst) {
                return;
            }
            if let Some(cancel_binding) = get_settings(&app_clone).bindings.get("cancel").cloned() {
                if let Ok(shortcut) = cancel_binding.current_binding.parse::<Shortcut>() {
                    if app_clone.global_shortcut().is_registered(shortcut) {
                        CANCEL_SHORTCUT_REGISTERED.store(true, Ordering::SeqCst);
                        return;
                    }
                }
                if let Err(e) = register_shortcut(&app_clone, cancel_binding) {
                    if e.contains("already in use") {
                        CANCEL_SHORTCUT_REGISTERED.store(true, Ordering::SeqCst);
                        return;
                    }
                    CANCEL_SHORTCUT_DESIRED.store(false, Ordering::SeqCst);
                    eprintln!("Failed to register cancel shortcut: {}", e);
                } else {
                    CANCEL_SHORTCUT_REGISTERED.store(true, Ordering::SeqCst);
                }
            }
        });
    }
}

pub fn unregister_cancel_shortcut(app: &AppHandle) {
    // Cancel shortcut is disabled on Linux due to instability with dynamic shortcut registration
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return;
    }

    #[cfg(not(target_os = "linux"))]
    {
        CANCEL_SHORTCUT_DESIRED.store(false, Ordering::SeqCst);
        if !CANCEL_SHORTCUT_REGISTERED.load(Ordering::SeqCst) {
            return;
        }

        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(180)).await;
            if CANCEL_SHORTCUT_DESIRED.load(Ordering::SeqCst) {
                return;
            }
            if let Some(cancel_binding) = get_settings(&app_clone).bindings.get("cancel").cloned() {
                // We ignore errors here as it might already be unregistered
                let _ = unregister_shortcut(&app_clone, cancel_binding);
            }
            CANCEL_SHORTCUT_REGISTERED.store(false, Ordering::SeqCst);
        });
    }
}

pub fn register_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    // Validate human-level rules first
    if let Err(e) = validate_shortcut_string(&binding.current_binding) {
        warn!(
            "_register_shortcut validation error for binding '{}': {}",
            binding.current_binding, e
        );
        return Err(e);
    }

    // Parse shortcut and return error if it fails
    let shortcut = match binding.current_binding.parse::<Shortcut>() {
        Ok(s) => s,
        Err(e) => {
            let error_msg = format!(
                "Failed to parse shortcut '{}': {}",
                binding.current_binding, e
            );
            error!("_register_shortcut parse error: {}", error_msg);
            return Err(error_msg);
        }
    };

    // Prevent duplicate registrations that would silently shadow one another
    if app.global_shortcut().is_registered(shortcut) {
        let error_msg = format!("Shortcut '{}' is already in use", binding.current_binding);
        warn!("_register_shortcut duplicate error: {}", error_msg);
        return Err(error_msg);
    }

    reset_shortcut_edge_state(&binding.id);

    // Clone binding.id for use in the closure
    let binding_id_for_closure = binding.id.clone();

    app.global_shortcut()
        .on_shortcut(shortcut, move |ah, scut, event| {
            if scut == &shortcut {
                let shortcut_string = scut.into_string();
                let settings = get_settings(ah);
                let edge_changed = update_shortcut_edge_state(&binding_id_for_closure, event.state);

                if let Some(action) = ACTION_MAP.get(&binding_id_for_closure) {
                    if binding_id_for_closure == "cancel" {
                        if !edge_changed && event.state == ShortcutState::Pressed {
                            return;
                        }
                        let audio_manager = ah.state::<Arc<AudioRecordingManager>>();
                        if event.state == ShortcutState::Pressed && audio_manager.is_recording() {
                            action.start(ah, &binding_id_for_closure, &shortcut_string);
                        }
                        return;
                    } else if binding_id_for_closure == "clipboard_history" {
                        if !edge_changed {
                            return;
                        }
                        if event.state == ShortcutState::Pressed {
                            action.start(ah, &binding_id_for_closure, &shortcut_string);
                        } else if event.state == ShortcutState::Released {
                            action.stop(ah, &binding_id_for_closure, &shortcut_string);
                        }
                        return;
                    } else if binding_id_for_closure == "quick_task" {
                        if !edge_changed {
                            return;
                        }
                        if event.state == ShortcutState::Pressed {
                            action.start(ah, &binding_id_for_closure, &shortcut_string);
                        }
                        return;
                    } else if settings.push_to_talk {
                        if !edge_changed {
                            return;
                        }
                        if event.state == ShortcutState::Pressed {
                            action.start(ah, &binding_id_for_closure, &shortcut_string);
                        } else if event.state == ShortcutState::Released {
                            action.stop(ah, &binding_id_for_closure, &shortcut_string);
                        }
                    } else {
                        // Toggle mode: toggle on press only
                        if !edge_changed {
                            return;
                        }
                        if event.state == ShortcutState::Pressed {
                            // Determine action and update state while holding the lock,
                            // but RELEASE the lock before calling the action to avoid deadlocks.
                            // (Actions may need to acquire the lock themselves, e.g., cancel_current_operation)
                            let should_start: bool;
                            {
                                let toggle_state_manager = ah.state::<ManagedToggleState>();
                                let mut states = toggle_state_manager
                                    .lock()
                                    .expect("Failed to lock toggle state manager");

                                let is_currently_active = states
                                    .active_toggles
                                    .entry(binding_id_for_closure.clone())
                                    .or_insert(false);

                                should_start = !*is_currently_active;
                                *is_currently_active = should_start;
                            } // Lock released here

                            // Now call the action without holding the lock
                            if should_start {
                                action.start(ah, &binding_id_for_closure, &shortcut_string);
                            } else {
                                action.stop(ah, &binding_id_for_closure, &shortcut_string);
                            }
                        }
                    }
                } else {
                    warn!(
                        "No action defined in ACTION_MAP for shortcut ID '{}'. Shortcut: '{}', State: {:?}",
                        binding_id_for_closure, shortcut_string, event.state
                    );
                }
            }
        })
        .map_err(|e| {
            let error_msg = format!("Couldn't register shortcut '{}': {}", binding.current_binding, e);
            error!("_register_shortcut registration error: {}", error_msg);
            error_msg
        })?;

    Ok(())
}

pub fn unregister_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    let shortcut = match binding.current_binding.parse::<Shortcut>() {
        Ok(s) => s,
        Err(e) => {
            let error_msg = format!(
                "Failed to parse shortcut '{}' for unregistration: {}",
                binding.current_binding, e
            );
            error!("_unregister_shortcut parse error: {}", error_msg);
            return Err(error_msg);
        }
    };

    app.global_shortcut().unregister(shortcut).map_err(|e| {
        let error_msg = format!(
            "Failed to unregister shortcut '{}': {}",
            binding.current_binding, e
        );
        error!("_unregister_shortcut error: {}", error_msg);
        error_msg
    })?;

    reset_shortcut_edge_state(&binding.id);

    Ok(())
}
