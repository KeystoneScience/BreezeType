use log::{debug, warn};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

pub const APPLE_INTELLIGENCE_PROVIDER_ID: &str = "apple_intelligence";
pub const APPLE_INTELLIGENCE_DEFAULT_MODEL_ID: &str = "Apple Intelligence";
pub const OPENAI_CODEX_PROVIDER_ID: &str = "openai-codex";
pub const OPENAI_CODEX_DEFAULT_MODEL_ID: &str = "gpt-5.3-codex";

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

// Custom deserializer to handle both old numeric format (1-5) and new string format ("trace", "debug", etc.)
impl<'de> Deserialize<'de> for LogLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LogLevelVisitor;

        impl<'de> Visitor<'de> for LogLevelVisitor {
            type Value = LogLevel;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a string or integer representing log level")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<LogLevel, E> {
                match value.to_lowercase().as_str() {
                    "trace" => Ok(LogLevel::Trace),
                    "debug" => Ok(LogLevel::Debug),
                    "info" => Ok(LogLevel::Info),
                    "warn" => Ok(LogLevel::Warn),
                    "error" => Ok(LogLevel::Error),
                    _ => Err(E::unknown_variant(
                        value,
                        &["trace", "debug", "info", "warn", "error"],
                    )),
                }
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<LogLevel, E> {
                match value {
                    1 => Ok(LogLevel::Trace),
                    2 => Ok(LogLevel::Debug),
                    3 => Ok(LogLevel::Info),
                    4 => Ok(LogLevel::Warn),
                    5 => Ok(LogLevel::Error),
                    _ => Err(E::invalid_value(de::Unexpected::Unsigned(value), &"1-5")),
                }
            }
        }

        deserializer.deserialize_any(LogLevelVisitor)
    }
}

impl From<LogLevel> for tauri_plugin_log::LogLevel {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Trace => tauri_plugin_log::LogLevel::Trace,
            LogLevel::Debug => tauri_plugin_log::LogLevel::Debug,
            LogLevel::Info => tauri_plugin_log::LogLevel::Info,
            LogLevel::Warn => tauri_plugin_log::LogLevel::Warn,
            LogLevel::Error => tauri_plugin_log::LogLevel::Error,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct ShortcutBinding {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_binding: String,
    pub current_binding: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct LLMPrompt {
    pub id: String,
    pub name: String,
    pub prompt: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct DictionaryEntry {
    pub term: String,
    pub definition: String,
}

const SHIPPED_DICTIONARY_ENTRIES: &[(&str, &str)] = &[("BreezeType", "Name of the app")];

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct PostProcessProvider {
    pub id: String,
    pub label: String,
    pub base_url: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum OverlayPosition {
    None,
    Top,
    Bottom,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ModelUnloadTimeout {
    Never,
    Immediately,
    Min2,
    Min5,
    Min10,
    Min15,
    Hour1,
    Sec5, // Debug mode only
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum PasteMethod {
    CtrlV,
    Direct,
    None,
    ShiftInsert,
    CtrlShiftV,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardHandling {
    DontModify,
    CopyToClipboard,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum RecordingRetentionPeriod {
    Never,
    PreserveLimit,
    Days3,
    Weeks2,
    Months3,
}

impl Default for ModelUnloadTimeout {
    fn default() -> Self {
        ModelUnloadTimeout::Never
    }
}

impl Default for PasteMethod {
    fn default() -> Self {
        // Default to CtrlV for macOS and Windows, Direct for Linux
        #[cfg(target_os = "linux")]
        return PasteMethod::Direct;
        #[cfg(not(target_os = "linux"))]
        return PasteMethod::CtrlV;
    }
}

impl Default for ClipboardHandling {
    fn default() -> Self {
        ClipboardHandling::DontModify
    }
}

impl ModelUnloadTimeout {
    pub fn to_minutes(self) -> Option<u64> {
        match self {
            ModelUnloadTimeout::Never => None,
            ModelUnloadTimeout::Immediately => Some(0), // Special case for immediate unloading
            ModelUnloadTimeout::Min2 => Some(2),
            ModelUnloadTimeout::Min5 => Some(5),
            ModelUnloadTimeout::Min10 => Some(10),
            ModelUnloadTimeout::Min15 => Some(15),
            ModelUnloadTimeout::Hour1 => Some(60),
            ModelUnloadTimeout::Sec5 => Some(0), // Special case for debug - handled separately
        }
    }

    pub fn to_seconds(self) -> Option<u64> {
        match self {
            ModelUnloadTimeout::Never => None,
            ModelUnloadTimeout::Immediately => Some(0), // Special case for immediate unloading
            ModelUnloadTimeout::Sec5 => Some(5),
            _ => self.to_minutes().map(|m| m * 60),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum SoundTheme {
    Marimba,
    Pop,
    Custom,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum RecordingOutputMode {
    Off,
    Mute,
    Duck,
}

impl Default for RecordingOutputMode {
    fn default() -> Self {
        RecordingOutputMode::Off
    }
}

pub fn recording_output_mode_from_level(level: f32) -> RecordingOutputMode {
    if level >= 0.999 {
        RecordingOutputMode::Off
    } else if level <= 0.0001 {
        RecordingOutputMode::Mute
    } else {
        RecordingOutputMode::Duck
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum AppThemePreference {
    System,
    Light,
    Dark,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, Type)]
pub struct WindowPosition {
    pub x: f64,
    pub y: f64,
}

impl SoundTheme {
    fn as_str(&self) -> &'static str {
        match self {
            SoundTheme::Marimba => "marimba",
            SoundTheme::Pop => "pop",
            SoundTheme::Custom => "custom",
        }
    }

    pub fn to_start_path(&self) -> String {
        format!("resources/{}_start.wav", self.as_str())
    }

    pub fn to_stop_path(&self) -> String {
        format!("resources/{}_stop.wav", self.as_str())
    }
}

/* still handy for composing the initial JSON in the store ------------- */
#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct AppSettings {
    pub bindings: HashMap<String, ShortcutBinding>,
    pub push_to_talk: bool,
    #[serde(default = "default_fn_key_ptt_enabled")]
    pub fn_key_ptt_enabled: bool,
    pub audio_feedback: bool,
    #[serde(default = "default_audio_feedback_volume")]
    pub audio_feedback_volume: f32,
    #[serde(default = "default_sound_theme")]
    pub sound_theme: SoundTheme,
    #[serde(default = "default_app_theme_preference")]
    pub app_theme: AppThemePreference,
    #[serde(default = "default_start_hidden")]
    pub start_hidden: bool,
    #[serde(default = "default_autostart_enabled")]
    pub autostart_enabled: bool,
    #[serde(default = "default_update_checks_enabled")]
    pub update_checks_enabled: bool,
    #[serde(default = "default_model")]
    pub selected_model: String,
    #[serde(default = "default_always_on_microphone")]
    pub always_on_microphone: bool,
    #[serde(default)]
    pub selected_microphone: Option<String>,
    #[serde(default)]
    pub clamshell_microphone: Option<String>,
    #[serde(default)]
    pub selected_output_device: Option<String>,
    #[serde(default = "default_translate_to_english")]
    pub translate_to_english: bool,
    #[serde(default = "default_selected_language")]
    pub selected_language: String,
    #[serde(default = "default_overlay_position")]
    pub overlay_position: OverlayPosition,
    #[serde(default)]
    pub clipboard_overlay_position: Option<WindowPosition>,
    #[serde(default = "default_clipboard_quick_pastes")]
    pub clipboard_quick_pastes: HashMap<String, String>,
    #[serde(default = "default_meeting_detection_enabled")]
    pub meeting_detection_enabled: bool,
    #[serde(default = "default_debug_mode")]
    pub debug_mode: bool,
    #[serde(default = "default_log_level")]
    pub log_level: LogLevel,
    #[serde(default)]
    pub custom_words: Vec<String>,
    #[serde(default)]
    pub custom_dictionary: Vec<DictionaryEntry>,
    #[serde(default)]
    pub model_unload_timeout: ModelUnloadTimeout,
    #[serde(default = "default_word_correction_threshold")]
    pub word_correction_threshold: f64,
    #[serde(default = "default_history_limit")]
    pub history_limit: usize,
    #[serde(default = "default_recording_retention_period")]
    pub recording_retention_period: RecordingRetentionPeriod,
    #[serde(default)]
    pub paste_method: PasteMethod,
    #[serde(default)]
    pub clipboard_handling: ClipboardHandling,
    #[serde(default = "default_post_process_enabled")]
    pub post_process_enabled: bool,
    #[serde(default = "default_post_process_remove_fillers")]
    pub post_process_remove_fillers: bool,
    #[serde(default = "default_post_process_provider_id")]
    pub post_process_provider_id: String,
    #[serde(default = "default_post_process_providers")]
    pub post_process_providers: Vec<PostProcessProvider>,
    #[serde(default = "default_post_process_api_keys")]
    pub post_process_api_keys: HashMap<String, String>,
    #[serde(default = "default_post_process_models")]
    pub post_process_models: HashMap<String, String>,
    #[serde(default = "default_post_process_prompts")]
    pub post_process_prompts: Vec<LLMPrompt>,
    #[serde(default)]
    pub post_process_selected_prompt_id: Option<String>,
    #[serde(default = "default_app_profile_overrides")]
    pub app_profile_overrides: HashMap<String, String>,
    #[serde(default = "default_recording_output_mode")]
    pub recording_output_mode: RecordingOutputMode,
    #[serde(default = "default_recording_duck_level")]
    pub recording_duck_level: f32,
    #[serde(default)]
    pub mute_while_recording: bool,
    #[serde(default)]
    pub append_trailing_space: bool,
    #[serde(default = "default_app_language")]
    pub app_language: String,
}

fn default_model() -> String {
    "".to_string()
}

fn default_always_on_microphone() -> bool {
    false
}

fn default_fn_key_ptt_enabled() -> bool {
    cfg!(target_os = "macos")
}

fn default_translate_to_english() -> bool {
    false
}

fn default_start_hidden() -> bool {
    false
}

fn default_autostart_enabled() -> bool {
    false
}

fn default_update_checks_enabled() -> bool {
    true
}

fn default_selected_language() -> String {
    "auto".to_string()
}

fn default_overlay_position() -> OverlayPosition {
    #[cfg(target_os = "linux")]
    return OverlayPosition::None;
    #[cfg(not(target_os = "linux"))]
    return OverlayPosition::Bottom;
}

fn default_meeting_detection_enabled() -> bool {
    true
}

fn default_debug_mode() -> bool {
    false
}

fn default_log_level() -> LogLevel {
    LogLevel::Debug
}

fn default_word_correction_threshold() -> f64 {
    0.18
}

fn default_history_limit() -> usize {
    500
}

fn default_recording_retention_period() -> RecordingRetentionPeriod {
    RecordingRetentionPeriod::PreserveLimit
}

fn default_clipboard_quick_pastes() -> HashMap<String, String> {
    HashMap::new()
}

fn default_audio_feedback_volume() -> f32 {
    0.38
}

fn default_sound_theme() -> SoundTheme {
    SoundTheme::Marimba
}

fn default_app_theme_preference() -> AppThemePreference {
    AppThemePreference::System
}

fn default_post_process_enabled() -> bool {
    true
}

fn default_post_process_remove_fillers() -> bool {
    true
}

fn default_app_profile_overrides() -> HashMap<String, String> {
    HashMap::new()
}

fn default_app_language() -> String {
    tauri_plugin_os::locale()
        .and_then(|l| l.split(['-', '_']).next().map(String::from))
        .unwrap_or_else(|| "en".to_string())
}

fn default_recording_output_mode() -> RecordingOutputMode {
    RecordingOutputMode::Off
}

fn default_recording_duck_level() -> f32 {
    0.09
}

fn default_post_process_provider_id() -> String {
    "local_llama".to_string()
}

fn default_post_process_providers() -> Vec<PostProcessProvider> {
    let mut providers = vec![
        PostProcessProvider {
            id: "local_llama".to_string(),
            label: "Local (llama.cpp)".to_string(),
            base_url: "http://127.0.0.1:45871/v1".to_string(),
        },
        PostProcessProvider {
            id: "openai".to_string(),
            label: "OpenAI".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
        },
        PostProcessProvider {
            id: OPENAI_CODEX_PROVIDER_ID.to_string(),
            label: "OpenAI Codex (OAuth)".to_string(),
            base_url: "https://chatgpt.com/backend-api".to_string(),
        },
        PostProcessProvider {
            id: "openrouter".to_string(),
            label: "OpenRouter".to_string(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
        },
        PostProcessProvider {
            id: "anthropic".to_string(),
            label: "Anthropic".to_string(),
            base_url: "https://api.anthropic.com/v1".to_string(),
        },
        PostProcessProvider {
            id: "groq".to_string(),
            label: "Groq".to_string(),
            base_url: "https://api.groq.com/openai/v1".to_string(),
        },
        PostProcessProvider {
            id: "cerebras".to_string(),
            label: "Cerebras".to_string(),
            base_url: "https://api.cerebras.ai/v1".to_string(),
        },
        PostProcessProvider {
            id: "custom".to_string(),
            label: "Custom".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
        },
    ];

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        if crate::apple_intelligence::check_apple_intelligence_availability() {
            providers.push(PostProcessProvider {
                id: APPLE_INTELLIGENCE_PROVIDER_ID.to_string(),
                label: "Apple Intelligence".to_string(),
                base_url: "apple-intelligence://local".to_string(),
            });
        }
    }

    providers
}

fn default_post_process_api_keys() -> HashMap<String, String> {
    let mut map = HashMap::new();
    for provider in default_post_process_providers() {
        map.insert(provider.id, String::new());
    }
    map
}

fn default_model_for_provider(provider_id: &str) -> String {
    if provider_id == "local_llama" {
        return "qwen3.5-0.8b".to_string();
    }
    if provider_id == OPENAI_CODEX_PROVIDER_ID {
        return OPENAI_CODEX_DEFAULT_MODEL_ID.to_string();
    }
    if provider_id == APPLE_INTELLIGENCE_PROVIDER_ID {
        return APPLE_INTELLIGENCE_DEFAULT_MODEL_ID.to_string();
    }
    String::new()
}

fn default_post_process_models() -> HashMap<String, String> {
    let mut map = HashMap::new();
    for provider in default_post_process_providers() {
        map.insert(
            provider.id.clone(),
            default_model_for_provider(&provider.id),
        );
    }
    map
}

pub fn normalize_clipboard_quick_paste_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let mut chars = trimmed.chars();
    let first = chars.next()?;

    if chars.next().is_some() || first.is_control() || first.is_whitespace() {
        return None;
    }

    Some(first.to_lowercase().to_string())
}

pub fn reserved_clipboard_shortcut_keys(shortcut: &str) -> HashSet<String> {
    shortcut
        .split('+')
        .filter_map(normalize_clipboard_quick_paste_key)
        .collect()
}

pub fn sanitize_clipboard_quick_pastes(
    mappings: &HashMap<String, String>,
    clipboard_shortcut: &str,
) -> HashMap<String, String> {
    const MAX_QUICK_PASTE_CHARS: usize = 20_000;

    let reserved = reserved_clipboard_shortcut_keys(clipboard_shortcut);
    let mut sanitized = HashMap::new();

    for (raw_key, raw_value) in mappings {
        let Some(key) = normalize_clipboard_quick_paste_key(raw_key) else {
            continue;
        };
        if reserved.contains(&key) {
            continue;
        }
        if raw_value.trim().is_empty() || raw_value.chars().count() > MAX_QUICK_PASTE_CHARS {
            continue;
        }
        sanitized.insert(key, raw_value.clone());
    }

    sanitized
}

fn default_post_process_prompts() -> Vec<LLMPrompt> {
    vec![LLMPrompt {
        id: "default_improve_transcriptions".to_string(),
        name: "Improve Transcriptions".to_string(),
        prompt: DEFAULT_POST_PROCESS_PROMPT_V9.to_string(),
    }]
}

const DEFAULT_POST_PROCESS_PROMPT_V1: &str = "Context:\nApp: ${app_name}\nProfile: ${app_profile}\nWindow: ${window_title}\n\nClean this transcript:\n1. Fix spelling, capitalization, and punctuation errors\n2. Convert number words to digits (twenty-five → 25, ten percent → 10%, five dollars → $5)\n3. Replace spoken punctuation with symbols (period → ., comma → ,, question mark → ?)\n4. Remove filler words (um, uh, like as filler)\n5. Keep the language in the original version (if it was french, keep it in french for example)\n\nPreserve exact meaning and word order. Do not paraphrase or reorder content.\n\nReturn only the cleaned transcript.\n\nTranscript:\n${output}";

const DEFAULT_POST_PROCESS_PROMPT_V2: &str = "Context: App: ${app_name} | Profile: ${app_profile} | Window: ${window_title}\nTask: Clean the transcript for dictation.\nRules:\n- Fix spelling, capitalization, and punctuation.\n- Convert spoken punctuation to symbols (\"period\" -> ., \"comma\" -> , \"question mark\" -> ?).\n- Remove filler words (um, uh, like when filler).\n- Convert obvious numbers to digits (twenty five -> 25, ten percent -> 10%, five dollars -> $5).\n- Preserve wording and order; do not add new info.\nReturn only the cleaned transcript.\nTranscript:\n${output}";

const DEFAULT_POST_PROCESS_PROMPT_V3: &str = "Context: App: ${app_name} | Profile: ${app_profile} | Window: ${window_title}\nTask: Clean the transcript for dictation.\nRules:\n- Fix spelling, capitalization, and punctuation.\n- Convert spoken punctuation to symbols (\"period\" -> ., \"comma\" -> , \"question mark\" -> ?).\n- Remove filler words (um, uh, like when filler).\n- Convert obvious numbers to digits (twenty five -> 25, ten percent -> 10%, five dollars -> $5).\n- Never do arithmetic or combine repeated numbers; keep numbers exactly as spoken (\"ten ten\" -> \"10 10\").\n- Preserve wording and order; do not add new info.\nReturn only the cleaned transcript.\nTranscript:\n${output}";

const DEFAULT_POST_PROCESS_PROMPT_V4: &str = "Context: App: ${app_name} | Profile: ${app_profile} | Bundle: ${app_identifier} | Window: ${window_title} | Tab: ${browser_tab_title} | URL: ${browser_tab_url}\nGlossary: ${glossary}\nTask: Clean the transcript for dictation.\nRules:\n- Fix spelling, capitalization, and punctuation.\n- Convert spoken punctuation to symbols (\"period\" -> ., \"comma\" -> , \"question mark\" -> ?).\n- Remove filler words (um, uh, like when filler).\n- Convert obvious numbers to digits (twenty five -> 25, ten percent -> 10%, five dollars -> $5).\n- Never do arithmetic or combine repeated numbers; keep numbers exactly as spoken (\"ten ten\" -> \"10 10\").\n- Preserve wording and order; do not add new info.\n- If a glossary is provided, use the exact glossary forms for those terms.\nReturn only the cleaned transcript.\nTranscript:\n${output}";

const DEFAULT_POST_PROCESS_PROMPT_V5: &str = "Context: App: ${app_name} | Profile: ${app_profile} | Bundle: ${app_identifier} | Window: ${window_title} | Tab: ${browser_tab_title} | URL: ${browser_tab_url}\nGlossary: ${glossary}\nTask: Clean the transcript for dictation.\nRules:\n- Fix spelling, capitalization, and punctuation.\n- Fix obvious homophones/ASR confusions when context makes it clear (e.g., \"park\" -> \"part\", \"hairs\" -> \"errors\").\n- Convert spoken punctuation to symbols (\"period\" -> ., \"comma\" -> , \"question mark\" -> ?).\n- Remove filler words (um, uh, like when filler).\n- Convert obvious numbers to digits (twenty five -> 25, ten percent -> 10%, five dollars -> $5).\n- Never do arithmetic or combine repeated numbers; keep numbers exactly as spoken (\"ten ten\" -> \"10 10\").\n- Preserve wording and order; do not add new info.\n- If a glossary is provided, use the exact glossary forms for those terms.\nReturn only the cleaned transcript.\nTranscript:\n${output}";

const DEFAULT_POST_PROCESS_PROMPT_V6: &str = r#"You are an expert, precise ASR transcript cleaner specialized in Whisper-like outputs. Make ONLY the minimal necessary edits for accuracy and readability.

Clean this transcript according to these rules:

1. Fix spelling errors, apply correct sentence capitalization, proper nouns, and acronyms (e.g., nasa → NASA, i → I).
2. Convert number words to digits/symbols where natural for readability:
   - twenty-five → 25
   - ten percent → 10%
   - five dollars → $5
   - two thousand twenty-four → 2024
   - march fifteenth two thousand twenty-five → March 15, 2025
   - ten thirty a.m. → 10:30 a.m.
   - one point five → 1.5
3. Insert natural punctuation (periods, commas, question marks, exclamation points, dashes, quotes) to form clear sentences. Replace spoken punctuation words with symbols (period → ., comma → ,, question mark → ?, new paragraph → paragraph break).
4. Remove filler words and disfluencies: um, uh, ah, er, hmm, like (as filler), you know, I mean, well (as filler), so (as filler), basically, actually. Remove repetitions/stutters/false starts and keep only the final intended phrasing (e.g., "I I think" → "I think"; "go to the sto- store" → "go to the store").
5. Preserve the exact original language(s) — keep French, code-switching, slang, etc., unchanged. Do not translate.
6. Remove non-content artifacts like [inaudible], [laughter], [music].
7. Strictly preserve exact meaning, intent, and sequential word order. Make no paraphrasing, summarization, reordering, or content changes beyond the rules above. This is cleaning, not rewriting.

Return ONLY the cleaned transcript text. No explanations, quotes, labels, or extra content whatsoever.

Transcript:
${output}"#;

const DEFAULT_POST_PROCESS_PROMPT_V7: &str = r#"You are an expert, precise ASR transcript cleaner specialized in Whisper-like outputs. Make ONLY the minimal necessary edits for accuracy and readability.

Context (for disambiguation only):
- App name: ${app_name}
- App identifier: ${app_identifier}
- App profile: ${app_profile}
- Window title: ${window_title}
- Browser tab title: ${browser_tab_title}
- Browser tab URL: ${browser_tab_url}
- Glossary: ${glossary}

Use context only to resolve ambiguous words, casing, punctuation, and terminology.
Never add facts that are not present in the transcript.

Clean this transcript according to these rules:

1. Fix spelling errors, apply correct sentence capitalization, proper nouns, and acronyms (e.g., nasa → NASA, i → I).
2. Convert number words to digits/symbols where natural for readability:
   - twenty-five → 25
   - ten percent → 10%
   - five dollars → $5
   - two thousand twenty-four → 2024
   - march fifteenth two thousand twenty-five → March 15, 2025
   - ten thirty a.m. → 10:30 a.m.
   - one point five → 1.5
3. Insert natural punctuation (periods, commas, question marks, exclamation points, dashes, quotes) to form clear sentences. Replace spoken punctuation words with symbols (period → ., comma → ,, question mark → ?, new paragraph → paragraph break).
4. Remove filler words and disfluencies: um, uh, ah, er, hmm, like (as filler), you know, I mean, well (as filler), so (as filler), basically, actually. Remove repetitions/stutters/false starts and keep only the final intended phrasing (e.g., "I I think" → "I think"; "go to the sto- store" → "go to the store").
5. Preserve the exact original language(s) — keep French, code-switching, slang, etc., unchanged. Do not translate.
6. Remove non-content artifacts like [inaudible], [laughter], [music].
7. Strictly preserve exact meaning, intent, and sequential word order. Make no paraphrasing, summarization, reordering, or content changes beyond the rules above. This is cleaning, not rewriting.

Return ONLY the cleaned transcript text. No explanations, quotes, labels, or extra content whatsoever.

Transcript:
${output}"#;

const DEFAULT_POST_PROCESS_PROMPT_V8: &str = r#"You are an expert, precise ASR transcript cleaner. Make only minimal edits for accuracy and readability.

Context (for disambiguation only):
- App name: ${app_name}
- App identifier: ${app_identifier}
- App profile: ${app_profile}
- Window title: ${window_title}
- Browser tab title: ${browser_tab_title}
- Browser tab URL: ${browser_tab_url}
- Glossary: ${glossary}

Use context/glossary only to resolve likely transcript errors. Do not add unsupported terms or facts. When rules conflict, preserving meaning and protected tokens wins.

Clean this transcript according to these rules:
1. Preserve meaning and word order. Do not paraphrase, summarize, reorder, translate, or add information.
2. Preserve every protected token exactly, such as <<V0>> or <<V1>>. Keep each token present and in the same relative position when possible.
3. Remove non-meaningful fillers and disfluencies: um, uh, ah, er, hmm, you know, filler-only like, repeated fragments, and abandoned false starts.
4. Fix spelling, casing, spacing, and punctuation after cleanup.
5. Preserve numbers, dates, times, amounts, measurements, and model names unless the correction is exact, unambiguous, and context-supported. If uncertain, keep the original form. If "twenty twenty-five" clearly means a year, use "2025"; otherwise keep the words. Never output "45" for a spoken year.
6. Use glossary spellings only when the transcript is clearly referring to that term.

Return ONLY the cleaned transcript text. No explanations, labels, quotes, or extra content.

Transcript:
${output}"#;

const DEFAULT_POST_PROCESS_PROMPT_V9: &str = r#"You are an expert, precise ASR transcript cleaner. Make only minimal edits for accuracy and readability.

Context (for disambiguation only):
- App name: ${app_name}
- App identifier: ${app_identifier}
- App profile: ${app_profile}
- Window title: ${window_title}
- Browser tab title: ${browser_tab_title}
- Browser tab URL: ${browser_tab_url}
- Glossary: ${glossary}

Use context/glossary only to resolve likely transcript errors. Do not add unsupported terms or facts. When rules conflict, preserving meaning and protected tokens wins.

Clean this transcript according to these rules:
1. Preserve meaning and word order. Do not paraphrase, summarize, reorder, translate, or add information.
2. Preserve every protected token exactly, such as <<V0>> or <<V1>>. Keep each token present and in the same relative position when possible.
3. ${filler_cleanup_rule}
4. Fix spelling, casing, spacing, and punctuation after cleanup.
5. Preserve numbers, dates, times, amounts, measurements, and model names unless the correction is exact, unambiguous, and context-supported. If uncertain, keep the original form. If "twenty twenty-five" clearly means a year, use "2025"; otherwise keep the words. Never output "45" for a spoken year.
6. Use glossary spellings only when the transcript is clearly referring to that term.

Return ONLY the cleaned transcript text. No explanations, labels, quotes, or extra content.

Transcript:
${output}"#;

const DEFAULT_POST_PROCESS_PROMPT_V1_CONTEXT_PREFIX: &str =
    "Context:\nApp: ${app_name}\nProfile: ${app_profile}\nWindow: ${window_title}\n\n";

fn legacy_post_process_prompt_v1_without_context() -> &'static str {
    DEFAULT_POST_PROCESS_PROMPT_V1
        .strip_prefix(DEFAULT_POST_PROCESS_PROMPT_V1_CONTEXT_PREFIX)
        .unwrap_or(DEFAULT_POST_PROCESS_PROMPT_V1)
}

fn is_known_default_post_process_prompt(prompt: &str) -> bool {
    prompt == DEFAULT_POST_PROCESS_PROMPT_V1
        || prompt == DEFAULT_POST_PROCESS_PROMPT_V2
        || prompt == DEFAULT_POST_PROCESS_PROMPT_V3
        || prompt == DEFAULT_POST_PROCESS_PROMPT_V4
        || prompt == DEFAULT_POST_PROCESS_PROMPT_V5
        || prompt == DEFAULT_POST_PROCESS_PROMPT_V6
        || prompt == DEFAULT_POST_PROCESS_PROMPT_V7
        || prompt == DEFAULT_POST_PROCESS_PROMPT_V8
        || prompt == legacy_post_process_prompt_v1_without_context()
}

fn ensure_post_process_defaults(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    for provider in default_post_process_providers() {
        if settings
            .post_process_providers
            .iter()
            .all(|existing| existing.id != provider.id)
        {
            settings.post_process_providers.push(provider.clone());
            changed = true;
        }

        if let Some(existing_provider) = settings
            .post_process_providers
            .iter_mut()
            .find(|existing| existing.id == provider.id)
        {
            if provider.id == "local_llama" {
                let current = existing_provider.base_url.trim();
                if current.is_empty()
                    || current == "http://127.0.0.1:8080/v1"
                    || current == "http://localhost:8080/v1"
                {
                    if existing_provider.base_url != provider.base_url {
                        existing_provider.base_url = provider.base_url.clone();
                        changed = true;
                    }
                }
            }
        }

        if !settings.post_process_api_keys.contains_key(&provider.id) {
            settings
                .post_process_api_keys
                .insert(provider.id.clone(), String::new());
            changed = true;
        }

        let default_model = default_model_for_provider(&provider.id);
        match settings.post_process_models.get_mut(&provider.id) {
            Some(existing) => {
                if existing.is_empty() && !default_model.is_empty() {
                    *existing = default_model.clone();
                    changed = true;
                } else if provider.id == "local_llama"
                    && existing == "qwen2.5-0.5b-instruct"
                    && !default_model.is_empty()
                {
                    // Migrate removed local model ID to the new lightweight default.
                    *existing = default_model.clone();
                    changed = true;
                } else if provider.id == "local_llama"
                    && existing == "qwen3-0.6b"
                    && !default_model.is_empty()
                {
                    // Migrate the prior lightweight default to the newer Qwen 3.5 default.
                    *existing = default_model.clone();
                    changed = true;
                } else if provider.id == OPENAI_CODEX_PROVIDER_ID
                    && existing == "gpt-5.3-codex-spark"
                    && !default_model.is_empty()
                {
                    // Migrate prior Spark default to the codex 5.3 default.
                    *existing = default_model.clone();
                    changed = true;
                }
            }
            None => {
                settings
                    .post_process_models
                    .insert(provider.id.clone(), default_model);
                changed = true;
            }
        }
    }

    if settings.post_process_selected_prompt_id.is_none()
        && !settings.post_process_prompts.is_empty()
    {
        settings.post_process_selected_prompt_id =
            Some(settings.post_process_prompts[0].id.clone());
        changed = true;
    }

    if let Some(prompt) = settings
        .post_process_prompts
        .iter_mut()
        .find(|prompt| prompt.id == "default_improve_transcriptions")
    {
        if is_known_default_post_process_prompt(&prompt.prompt) {
            prompt.prompt = DEFAULT_POST_PROCESS_PROMPT_V9.to_string();
            changed = true;
        }
    }

    changed
}

fn ensure_fixed_defaults(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    let default_local_post_process_model = default_model_for_provider("local_llama");

    let selected_model = settings.selected_model.trim();
    let is_supported_transcription_model = selected_model == "parakeet-tdt-0.6b-v3";

    // Whisper model IDs are migrated to Parakeet-only defaults.
    if selected_model.is_empty() || !is_supported_transcription_model {
        settings.selected_model = "parakeet-tdt-0.6b-v3".to_string();
        changed = true;
    }
    if settings.clipboard_handling != ClipboardHandling::DontModify {
        settings.clipboard_handling = ClipboardHandling::DontModify;
        changed = true;
    }
    if settings.model_unload_timeout != ModelUnloadTimeout::Never {
        settings.model_unload_timeout = ModelUnloadTimeout::Never;
        changed = true;
    }
    if !settings.post_process_enabled {
        settings.post_process_enabled = true;
        changed = true;
    }
    if settings.post_process_provider_id != "local_llama" {
        settings.post_process_provider_id = "local_llama".to_string();
        changed = true;
    }
    let current_local_post_process_model = settings
        .post_process_models
        .get("local_llama")
        .map(String::as_str)
        .unwrap_or("");
    if current_local_post_process_model != default_local_post_process_model {
        settings.post_process_models.insert(
            "local_llama".to_string(),
            default_local_post_process_model.clone(),
        );
        changed = true;
    }
    if settings.history_limit == 5
        && settings.recording_retention_period == RecordingRetentionPeriod::PreserveLimit
    {
        settings.history_limit = default_history_limit();
        changed = true;
    }
    #[cfg(target_os = "macos")]
    if matches!(
        settings.paste_method,
        PasteMethod::CtrlShiftV | PasteMethod::ShiftInsert
    ) {
        settings.paste_method = PasteMethod::CtrlV;
        changed = true;
    }
    #[cfg(target_os = "macos")]
    {
        let is_legacy_transcribe_binding = |binding: &str| {
            binding.eq_ignore_ascii_case("shift+tab")
                || binding.eq_ignore_ascii_case("option+space")
                || binding.eq_ignore_ascii_case("alt+space")
        };

        let mut migrated_transcribe_current = false;
        if let Some(transcribe_binding) = settings.bindings.get_mut("transcribe") {
            let current_is_legacy =
                is_legacy_transcribe_binding(transcribe_binding.current_binding.as_str());
            let default_is_legacy =
                is_legacy_transcribe_binding(transcribe_binding.default_binding.as_str());

            if current_is_legacy && default_is_legacy {
                transcribe_binding.current_binding = "cmd+shift+x".to_string();
                migrated_transcribe_current = true;
                changed = true;
            }
            if default_is_legacy {
                transcribe_binding.default_binding = "cmd+shift+x".to_string();
                changed = true;
            }
        }

        if migrated_transcribe_current && !settings.fn_key_ptt_enabled {
            settings.fn_key_ptt_enabled = true;
            changed = true;
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(quick_task_binding) = settings.bindings.get_mut("quick_task") {
        if quick_task_binding
            .current_binding
            .eq_ignore_ascii_case("cmd+shift+t")
            || quick_task_binding
                .current_binding
                .eq_ignore_ascii_case("command+shift+t")
        {
            quick_task_binding.current_binding = "cmd+shift+c".to_string();
            changed = true;
        }
        if quick_task_binding
            .default_binding
            .eq_ignore_ascii_case("cmd+shift+t")
            || quick_task_binding
                .default_binding
                .eq_ignore_ascii_case("command+shift+t")
        {
            quick_task_binding.default_binding = "cmd+shift+c".to_string();
            changed = true;
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(quick_task_binding) = settings.bindings.get_mut("quick_task") {
        if quick_task_binding
            .current_binding
            .eq_ignore_ascii_case("ctrl+shift+t")
            || quick_task_binding
                .current_binding
                .eq_ignore_ascii_case("control+shift+t")
        {
            quick_task_binding.current_binding = "ctrl+shift+c".to_string();
            changed = true;
        }
        if quick_task_binding
            .default_binding
            .eq_ignore_ascii_case("ctrl+shift+t")
            || quick_task_binding
                .default_binding
                .eq_ignore_ascii_case("control+shift+t")
        {
            quick_task_binding.default_binding = "ctrl+shift+c".to_string();
            changed = true;
        }
    }
    let clamped_duck_level = if settings.recording_duck_level.is_finite() {
        settings.recording_duck_level.clamp(0.0, 1.0)
    } else {
        default_recording_duck_level()
    };
    if settings.recording_duck_level != clamped_duck_level {
        settings.recording_duck_level = clamped_duck_level;
        changed = true;
    }

    // Migrate legacy "mute while recording" to slider semantics.
    if settings.mute_while_recording && settings.recording_duck_level >= 0.999 {
        settings.recording_duck_level = 0.0;
        changed = true;
    }

    // Migrate legacy mode values if slider still looks unset.
    if settings.recording_output_mode == RecordingOutputMode::Mute
        && settings.recording_duck_level >= 0.999
    {
        settings.recording_duck_level = 0.0;
        changed = true;
    }
    if settings.recording_output_mode == RecordingOutputMode::Duck
        && (settings.recording_duck_level >= 0.999 || settings.recording_duck_level <= 0.0001)
    {
        settings.recording_duck_level = default_recording_duck_level();
        changed = true;
    }

    let effective_mode = recording_output_mode_from_level(settings.recording_duck_level);
    if settings.recording_output_mode != effective_mode {
        settings.recording_output_mode = effective_mode;
        changed = true;
    }
    let effective_legacy_mute = effective_mode == RecordingOutputMode::Mute;
    if settings.mute_while_recording != effective_legacy_mute {
        settings.mute_while_recording = effective_legacy_mute;
        changed = true;
    }
    changed
}

fn ensure_dictionary_defaults(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    let mut normalized_entries = Vec::new();
    let mut entries_changed = false;

    for entry in &settings.custom_dictionary {
        let term = entry.term.trim();
        if term.is_empty() {
            entries_changed = true;
            continue;
        }

        let definition = entry.definition.trim();
        if term != entry.term || definition != entry.definition {
            entries_changed = true;
        }
        normalized_entries.push(DictionaryEntry {
            term: term.to_string(),
            definition: definition.to_string(),
        });
    }

    if entries_changed {
        settings.custom_dictionary = normalized_entries;
        changed = true;
    }

    if settings.custom_dictionary.is_empty() && !settings.custom_words.is_empty() {
        settings.custom_dictionary = settings
            .custom_words
            .iter()
            .filter(|word| !word.trim().is_empty())
            .map(|word| DictionaryEntry {
                term: word.trim().to_string(),
                definition: String::new(),
            })
            .collect();
        changed = true;
    }

    for (term, definition) in SHIPPED_DICTIONARY_ENTRIES {
        if let Some(entry) = settings
            .custom_dictionary
            .iter_mut()
            .find(|entry| entry.term.eq_ignore_ascii_case(term))
        {
            if entry.term != *term {
                entry.term = (*term).to_string();
                changed = true;
            }
            if entry.definition.trim().is_empty() {
                entry.definition = (*definition).to_string();
                changed = true;
            }
            continue;
        }

        settings.custom_dictionary.push(DictionaryEntry {
            term: (*term).to_string(),
            definition: (*definition).to_string(),
        });
        changed = true;
    }

    let dictionary_terms: Vec<String> = settings
        .custom_dictionary
        .iter()
        .map(|entry| entry.term.clone())
        .collect();

    if dictionary_terms != settings.custom_words {
        settings.custom_words = dictionary_terms;
        changed = true;
    }

    changed
}

fn default_custom_dictionary() -> Vec<DictionaryEntry> {
    SHIPPED_DICTIONARY_ENTRIES
        .iter()
        .map(|(term, definition)| DictionaryEntry {
            term: (*term).to_string(),
            definition: (*definition).to_string(),
        })
        .collect()
}

fn default_custom_words() -> Vec<String> {
    default_custom_dictionary()
        .into_iter()
        .map(|entry| entry.term)
        .collect()
}

fn ensure_clipboard_quick_paste_defaults(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    let shortcut = settings
        .bindings
        .get("clipboard_history")
        .map(|binding| binding.current_binding.as_str())
        .unwrap_or("ctrl+shift+v");
    let sanitized = sanitize_clipboard_quick_pastes(&settings.clipboard_quick_pastes, shortcut);

    if sanitized != settings.clipboard_quick_pastes {
        settings.clipboard_quick_pastes = sanitized;
        changed = true;
    }

    changed
}

pub const SETTINGS_STORE_PATH: &str = "settings_store.json";

pub fn get_default_settings() -> AppSettings {
    #[cfg(target_os = "windows")]
    let default_shortcut = "shift+tab";
    #[cfg(target_os = "windows")]
    let default_clipboard_shortcut = "ctrl+shift+v";
    #[cfg(target_os = "windows")]
    let default_quick_task_shortcut = "ctrl+shift+c";
    #[cfg(target_os = "macos")]
    let default_shortcut = "cmd+shift+x";
    #[cfg(target_os = "macos")]
    let default_clipboard_shortcut = "cmd+shift+v";
    #[cfg(target_os = "macos")]
    let default_quick_task_shortcut = "cmd+shift+c";
    #[cfg(target_os = "linux")]
    let default_shortcut = "shift+tab";
    #[cfg(target_os = "linux")]
    let default_clipboard_shortcut = "ctrl+shift+v";
    #[cfg(target_os = "linux")]
    let default_quick_task_shortcut = "ctrl+shift+c";
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let default_shortcut = "shift+tab";
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let default_clipboard_shortcut = "ctrl+shift+v";
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let default_quick_task_shortcut = "ctrl+shift+c";

    let mut bindings = HashMap::new();
    bindings.insert(
        "transcribe".to_string(),
        ShortcutBinding {
            id: "transcribe".to_string(),
            name: "Transcribe".to_string(),
            description: "Converts your speech into text.".to_string(),
            default_binding: default_shortcut.to_string(),
            current_binding: default_shortcut.to_string(),
        },
    );
    bindings.insert(
        "cancel".to_string(),
        ShortcutBinding {
            id: "cancel".to_string(),
            name: "Cancel".to_string(),
            description: "Cancels the current recording.".to_string(),
            default_binding: "escape".to_string(),
            current_binding: "escape".to_string(),
        },
    );
    bindings.insert(
        "clipboard_history".to_string(),
        ShortcutBinding {
            id: "clipboard_history".to_string(),
            name: "Clipboard History".to_string(),
            description: "Opens the clipboard history picker.".to_string(),
            default_binding: default_clipboard_shortcut.to_string(),
            current_binding: default_clipboard_shortcut.to_string(),
        },
    );
    bindings.insert(
        "quick_task".to_string(),
        ShortcutBinding {
            id: "quick_task".to_string(),
            name: "Quick Task".to_string(),
            description: "Opens the quick task composer.".to_string(),
            default_binding: default_quick_task_shortcut.to_string(),
            current_binding: default_quick_task_shortcut.to_string(),
        },
    );

    AppSettings {
        bindings,
        push_to_talk: true,
        fn_key_ptt_enabled: default_fn_key_ptt_enabled(),
        audio_feedback: false,
        audio_feedback_volume: default_audio_feedback_volume(),
        sound_theme: default_sound_theme(),
        app_theme: default_app_theme_preference(),
        start_hidden: default_start_hidden(),
        autostart_enabled: default_autostart_enabled(),
        update_checks_enabled: default_update_checks_enabled(),
        selected_model: "parakeet-tdt-0.6b-v3".to_string(),
        always_on_microphone: false,
        selected_microphone: None,
        clamshell_microphone: None,
        selected_output_device: None,
        translate_to_english: false,
        selected_language: "auto".to_string(),
        overlay_position: default_overlay_position(),
        clipboard_overlay_position: None,
        clipboard_quick_pastes: default_clipboard_quick_pastes(),
        meeting_detection_enabled: default_meeting_detection_enabled(),
        debug_mode: false,
        log_level: default_log_level(),
        custom_words: default_custom_words(),
        custom_dictionary: default_custom_dictionary(),
        model_unload_timeout: ModelUnloadTimeout::Never,
        word_correction_threshold: default_word_correction_threshold(),
        history_limit: default_history_limit(),
        recording_retention_period: default_recording_retention_period(),
        paste_method: PasteMethod::default(),
        clipboard_handling: ClipboardHandling::default(),
        post_process_enabled: default_post_process_enabled(),
        post_process_remove_fillers: default_post_process_remove_fillers(),
        post_process_provider_id: default_post_process_provider_id(),
        post_process_providers: default_post_process_providers(),
        post_process_api_keys: default_post_process_api_keys(),
        post_process_models: default_post_process_models(),
        post_process_prompts: default_post_process_prompts(),
        post_process_selected_prompt_id: None,
        app_profile_overrides: default_app_profile_overrides(),
        recording_output_mode: default_recording_output_mode(),
        recording_duck_level: default_recording_duck_level(),
        mute_while_recording: false,
        append_trailing_space: false,
        app_language: default_app_language(),
    }
}

impl AppSettings {
    pub fn active_post_process_provider(&self) -> Option<&PostProcessProvider> {
        self.post_process_providers
            .iter()
            .find(|provider| provider.id == self.post_process_provider_id)
    }

    pub fn post_process_provider(&self, provider_id: &str) -> Option<&PostProcessProvider> {
        self.post_process_providers
            .iter()
            .find(|provider| provider.id == provider_id)
    }

    pub fn post_process_provider_mut(
        &mut self,
        provider_id: &str,
    ) -> Option<&mut PostProcessProvider> {
        self.post_process_providers
            .iter_mut()
            .find(|provider| provider.id == provider_id)
    }
}

pub fn load_or_create_app_settings(app: &AppHandle) -> AppSettings {
    // Initialize store
    let store = match app.store(SETTINGS_STORE_PATH) {
        Ok(store) => store,
        Err(err) => {
            warn!(
                "Failed to initialize settings store '{}': {}. Using default settings.",
                SETTINGS_STORE_PATH, err
            );
            return get_default_settings();
        }
    };

    let mut settings = if let Some(settings_value) = store.get("settings") {
        // Parse the entire settings object
        match serde_json::from_value::<AppSettings>(settings_value) {
            Ok(mut settings) => {
                debug!("Found existing settings: {:?}", settings);
                let default_settings = get_default_settings();
                let mut updated = false;

                // Merge default bindings into existing settings
                for (key, value) in default_settings.bindings {
                    if !settings.bindings.contains_key(&key) {
                        debug!("Adding missing binding: {}", key);
                        settings.bindings.insert(key, value);
                        updated = true;
                    }
                }

                if updated {
                    debug!("Settings updated with new bindings");
                    if let Ok(value) = serde_json::to_value(&settings) {
                        store.set("settings", value);
                    } else {
                        warn!("Failed to serialize updated settings; changes not persisted");
                    }
                }

                settings
            }
            Err(e) => {
                warn!("Failed to parse settings: {}", e);
                // Fall back to default settings if parsing fails
                let default_settings = get_default_settings();
                if let Ok(value) = serde_json::to_value(&default_settings) {
                    store.set("settings", value);
                } else {
                    warn!("Failed to serialize default settings; settings not persisted");
                }
                default_settings
            }
        }
    } else {
        let default_settings = get_default_settings();
        if let Ok(value) = serde_json::to_value(&default_settings) {
            store.set("settings", value);
        } else {
            warn!("Failed to serialize default settings; settings not persisted");
        }
        default_settings
    };

    let mut updated = false;
    if ensure_post_process_defaults(&mut settings) {
        updated = true;
    }
    if ensure_fixed_defaults(&mut settings) {
        updated = true;
    }
    if ensure_dictionary_defaults(&mut settings) {
        updated = true;
    }
    if ensure_clipboard_quick_paste_defaults(&mut settings) {
        updated = true;
    }
    if updated {
        if let Ok(value) = serde_json::to_value(&settings) {
            store.set("settings", value);
        } else {
            warn!("Failed to serialize updated settings; changes not persisted");
        }
    }

    settings
}

pub fn get_settings(app: &AppHandle) -> AppSettings {
    let store = match app.store(SETTINGS_STORE_PATH) {
        Ok(store) => store,
        Err(err) => {
            warn!(
                "Failed to initialize settings store '{}': {}. Using default settings.",
                SETTINGS_STORE_PATH, err
            );
            return get_default_settings();
        }
    };

    let mut settings = if let Some(settings_value) = store.get("settings") {
        serde_json::from_value::<AppSettings>(settings_value).unwrap_or_else(|_| {
            let default_settings = get_default_settings();
            if let Ok(value) = serde_json::to_value(&default_settings) {
                store.set("settings", value);
            } else {
                warn!("Failed to serialize default settings; settings not persisted");
            }
            default_settings
        })
    } else {
        let default_settings = get_default_settings();
        if let Ok(value) = serde_json::to_value(&default_settings) {
            store.set("settings", value);
        } else {
            warn!("Failed to serialize default settings; settings not persisted");
        }
        default_settings
    };

    let mut updated = false;
    if ensure_post_process_defaults(&mut settings) {
        updated = true;
    }
    if ensure_fixed_defaults(&mut settings) {
        updated = true;
    }
    if ensure_dictionary_defaults(&mut settings) {
        updated = true;
    }
    if ensure_clipboard_quick_paste_defaults(&mut settings) {
        updated = true;
    }
    if updated {
        if let Ok(value) = serde_json::to_value(&settings) {
            store.set("settings", value);
        } else {
            warn!("Failed to serialize updated settings; changes not persisted");
        }
    }

    settings
}

pub fn write_settings(app: &AppHandle, settings: AppSettings) {
    let store = match app.store(SETTINGS_STORE_PATH) {
        Ok(store) => store,
        Err(err) => {
            warn!(
                "Failed to initialize settings store '{}': {}. Settings not persisted.",
                SETTINGS_STORE_PATH, err
            );
            return;
        }
    };

    match serde_json::to_value(&settings) {
        Ok(value) => store.set("settings", value),
        Err(err) => warn!(
            "Failed to serialize settings; settings not persisted: {}",
            err
        ),
    }
}

pub fn get_bindings(app: &AppHandle) -> HashMap<String, ShortcutBinding> {
    let settings = get_settings(app);

    settings.bindings
}

pub fn get_stored_binding(app: &AppHandle, id: &str) -> ShortcutBinding {
    let bindings = get_bindings(app);

    let binding = bindings.get(id).unwrap().clone();

    binding
}

pub fn get_history_limit(app: &AppHandle) -> usize {
    let settings = get_settings(app);
    settings.history_limit
}

pub fn get_recording_retention_period(app: &AppHandle) -> RecordingRetentionPeriod {
    let settings = get_settings(app);
    settings.recording_retention_period
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with_default_prompt(prompt_text: &str) -> AppSettings {
        let mut settings = get_default_settings();
        settings.post_process_prompts = vec![LLMPrompt {
            id: "default_improve_transcriptions".to_string(),
            name: "Improve Transcriptions".to_string(),
            prompt: prompt_text.to_string(),
        }];
        settings.post_process_selected_prompt_id =
            Some("default_improve_transcriptions".to_string());
        settings
    }

    #[test]
    fn default_post_process_prompt_uses_v9() {
        let settings = get_default_settings();
        let prompt = settings
            .post_process_prompts
            .iter()
            .find(|prompt| prompt.id == "default_improve_transcriptions")
            .expect("default prompt should exist");

        assert_eq!(prompt.prompt, DEFAULT_POST_PROCESS_PROMPT_V9);
    }

    #[test]
    fn default_settings_remove_fillers_by_default() {
        let settings = get_default_settings();

        assert!(settings.post_process_remove_fillers);
    }

    #[test]
    fn default_settings_ship_breezetype_dictionary_entry() {
        let settings = get_default_settings();

        assert!(settings
            .custom_dictionary
            .iter()
            .any(|entry| { entry.term == "BreezeType" && entry.definition == "Name of the app" }));
        assert!(settings
            .custom_words
            .iter()
            .any(|word| word == "BreezeType"));
    }

    #[test]
    fn dictionary_defaults_add_breezetype_without_dropping_custom_terms() {
        let mut settings = get_default_settings();
        settings.custom_dictionary = vec![DictionaryEntry {
            term: "DittoDub".to_string(),
            definition: "Video dubbing company".to_string(),
        }];
        settings.custom_words = vec!["DittoDub".to_string()];

        assert!(ensure_dictionary_defaults(&mut settings));
        assert!(settings
            .custom_dictionary
            .iter()
            .any(|entry| { entry.term == "BreezeType" && entry.definition == "Name of the app" }));
        assert!(settings.custom_dictionary.iter().any(|entry| {
            entry.term == "DittoDub" && entry.definition == "Video dubbing company"
        }));
        assert_eq!(
            settings.custom_words,
            vec!["DittoDub".to_string(), "BreezeType".to_string()]
        );
    }

    #[test]
    fn dictionary_defaults_fill_empty_breezetype_definition() {
        let mut settings = get_default_settings();
        settings.custom_dictionary = vec![DictionaryEntry {
            term: "breezetype".to_string(),
            definition: String::new(),
        }];
        settings.custom_words = vec!["breezetype".to_string()];

        assert!(ensure_dictionary_defaults(&mut settings));
        assert_eq!(settings.custom_dictionary.len(), 1);
        assert_eq!(settings.custom_dictionary[0].term, "BreezeType");
        assert_eq!(settings.custom_dictionary[0].definition, "Name of the app");
        assert_eq!(settings.custom_words, vec!["BreezeType".to_string()]);
    }

    #[test]
    fn deserializes_missing_post_process_remove_fillers_as_enabled() {
        let mut value =
            serde_json::to_value(get_default_settings()).expect("default settings serialize");
        value
            .as_object_mut()
            .expect("settings should serialize to an object")
            .remove("post_process_remove_fillers");

        let settings: AppSettings =
            serde_json::from_value(value).expect("settings should deserialize");

        assert!(settings.post_process_remove_fillers);
    }

    #[test]
    fn preserves_disabled_post_process_remove_fillers_during_defaults() {
        let mut settings = get_default_settings();
        settings.post_process_remove_fillers = false;

        ensure_post_process_defaults(&mut settings);
        ensure_fixed_defaults(&mut settings);

        assert!(!settings.post_process_remove_fillers);
    }

    #[test]
    fn v9_prompt_contains_current_guardrails() {
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${app_name}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${app_identifier}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${app_profile}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${window_title}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${browser_tab_title}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${browser_tab_url}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${glossary}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${filler_cleanup_rule}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("${output}"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("<<V0>>"));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("Never output \"45\""));
        assert!(DEFAULT_POST_PROCESS_PROMPT_V9.contains("Return ONLY the cleaned transcript text"));
    }

    #[test]
    fn migrates_known_default_post_process_prompts_to_v9() {
        let known_defaults = [
            DEFAULT_POST_PROCESS_PROMPT_V1,
            DEFAULT_POST_PROCESS_PROMPT_V2,
            DEFAULT_POST_PROCESS_PROMPT_V3,
            DEFAULT_POST_PROCESS_PROMPT_V4,
            DEFAULT_POST_PROCESS_PROMPT_V5,
            DEFAULT_POST_PROCESS_PROMPT_V6,
            DEFAULT_POST_PROCESS_PROMPT_V7,
            DEFAULT_POST_PROCESS_PROMPT_V8,
            legacy_post_process_prompt_v1_without_context(),
        ];

        for old_prompt in known_defaults {
            let mut settings = settings_with_default_prompt(old_prompt);

            assert!(
                ensure_post_process_defaults(&mut settings),
                "known default should migrate"
            );
            assert_eq!(
                settings.post_process_prompts[0].prompt,
                DEFAULT_POST_PROCESS_PROMPT_V9
            );
        }
    }

    #[test]
    fn preserves_custom_default_post_process_prompt() {
        let custom_prompt = "Clean this transcript, but keep my custom product spelling.";
        let mut settings = settings_with_default_prompt(custom_prompt);

        assert!(!ensure_post_process_defaults(&mut settings));
        assert_eq!(settings.post_process_prompts[0].prompt, custom_prompt);
    }

    #[test]
    fn does_not_treat_v9_as_legacy_prompt() {
        let mut settings = settings_with_default_prompt(DEFAULT_POST_PROCESS_PROMPT_V9);

        assert!(!ensure_post_process_defaults(&mut settings));
        assert_eq!(
            settings.post_process_prompts[0].prompt,
            DEFAULT_POST_PROCESS_PROMPT_V9
        );
    }
}
