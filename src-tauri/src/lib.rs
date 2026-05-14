mod actions;
mod app_icon;
mod app_launcher;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod apple_intelligence;
mod audio_feedback;
pub mod audio_toolkit;
mod browser_account_auth;
mod clipboard;
mod clipboard_overlay;
mod commands;
mod focus_context;
mod glossary;
mod helpers;
mod input;
mod input_focus;
mod llm_client;
#[cfg(target_os = "macos")]
mod macos_fn_key;
mod managers;
mod meeting_prompt;
mod model_context;
mod openai_codex_oauth;
mod overlay;
mod polish;
mod quick_task_overlay;
mod settings;
mod shortcut;
mod signal_handle;
mod tray;
mod tray_i18n;
mod utils;
mod voice_commands;
use specta_typescript::{BigIntExportBehavior, Typescript};
use tauri_specta::{collect_commands, Builder};

use env_filter::Builder as EnvFilterBuilder;
use managers::audio::AudioRecordingManager;
use managers::clipboard_history::ClipboardHistoryManager;
use managers::history::HistoryManager;
use managers::insertion::InsertionManager;
use managers::local_llm::LocalLlmManager;
use managers::meeting_detection::MeetingDetectionManager;
use managers::meetings::MeetingsManager;
use managers::model::ModelManager;
use managers::transcription::TranscriptionManager;
#[cfg(unix)]
use signal_hook::consts::SIGUSR2;
#[cfg(unix)]
use signal_hook::iterator::Signals;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::image::Image;

use tauri::tray::TrayIconBuilder;
use tauri::Emitter;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};

use crate::settings::get_settings;

// Global atomic to store the file log level filter
// We use u8 to store the log::LevelFilter as a number
pub static FILE_LOG_LEVEL: AtomicU8 = AtomicU8::new(log::LevelFilter::Debug as u8);

fn level_filter_from_u8(value: u8) -> log::LevelFilter {
    match value {
        0 => log::LevelFilter::Off,
        1 => log::LevelFilter::Error,
        2 => log::LevelFilter::Warn,
        3 => log::LevelFilter::Info,
        4 => log::LevelFilter::Debug,
        5 => log::LevelFilter::Trace,
        _ => log::LevelFilter::Trace,
    }
}

fn build_console_filter() -> env_filter::Filter {
    let mut builder = EnvFilterBuilder::new();

    match std::env::var("RUST_LOG") {
        Ok(spec) if !spec.trim().is_empty() => {
            if let Err(err) = builder.try_parse(&spec) {
                log::warn!(
                    "Ignoring invalid RUST_LOG value '{}': {}. Falling back to info-level console logging",
                    spec,
                    err
                );
                builder.filter_level(log::LevelFilter::Info);
            }
        }
        _ => {
            builder.filter_level(log::LevelFilter::Info);
        }
    }

    builder.build()
}

#[derive(Default)]
struct ShortcutToggleStates {
    // Map: shortcut_binding_id -> is_active
    active_toggles: HashMap<String, bool>,
}

type ManagedToggleState = Mutex<ShortcutToggleStates>;
type ManagedTrayState = Mutex<tray::TrayIconState>;

fn show_main_window(app: &AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        // First, ensure the window is visible
        if let Err(e) = main_window.show() {
            log::error!("Failed to show window: {}", e);
        }
        // Then, bring it to the front and give it focus
        if let Err(e) = main_window.set_focus() {
            log::error!("Failed to focus window: {}", e);
        }
        // Optional: On macOS, ensure the app becomes active if it was an accessory
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                log::error!("Failed to set activation policy to Regular: {}", e);
            }
        }
    } else {
        log::error!("Main window not found.");
    }
}

fn initialize_core_logic(app_handle: &AppHandle) {
    // Initialize the input state lazily.
    // Input simulation is created on first use so startup doesn't trigger
    // platform permission checks/dialogs.
    app_handle.manage(input::EnigoState::empty());

    // Initialize the managers
    let recording_manager = Arc::new(AudioRecordingManager::new(app_handle));
    let model_manager = Arc::new(ModelManager::new(app_handle));
    let transcription_manager =
        Arc::new(TranscriptionManager::new(app_handle, model_manager.clone()));
    let history_manager = Arc::new(HistoryManager::new(app_handle));
    let insertion_manager = Arc::new(InsertionManager::new());
    let local_llm_manager = Arc::new(LocalLlmManager::new());
    let clipboard_history_manager = Arc::new(ClipboardHistoryManager::new(app_handle));
    let meetings_manager = Arc::new(MeetingsManager::new(app_handle));

    // Add managers to Tauri's managed state
    app_handle.manage(recording_manager.clone());
    app_handle.manage(model_manager.clone());
    app_handle.manage(transcription_manager.clone());
    app_handle.manage(history_manager.clone());
    app_handle.manage(insertion_manager.clone());
    app_handle.manage(local_llm_manager.clone());
    app_handle.manage(clipboard_history_manager.clone());
    app_handle.manage(meetings_manager.clone());

    let meeting_detection_manager = Arc::new(MeetingDetectionManager::new(app_handle));
    meeting_detection_manager.clone().start();
    app_handle.manage(meeting_detection_manager);
    ClipboardHistoryManager::start_monitoring(clipboard_history_manager.clone());
    if let Err(err) = model_context::initialize(app_handle) {
        log::warn!("Failed to initialize model context manifest: {}", err);
    }

    // Kick off local LLM asset download when using the local provider
    let settings = settings::get_settings(app_handle);
    if settings.post_process_provider_id == "local_llama" {
        let selected_model_id = settings
            .post_process_models
            .get("local_llama")
            .map(String::as_str)
            .unwrap_or("");
        local_llm_manager.ensure_assets_async(app_handle, selected_model_id);
        local_llm_manager.ensure_running_async(app_handle, selected_model_id);
    }

    // Initialize the shortcuts
    shortcut::init_shortcuts(app_handle);

    // Initialize macOS Fn key listener (optional push-to-talk trigger)
    #[cfg(target_os = "macos")]
    macos_fn_key::init(app_handle);

    #[cfg(unix)]
    #[cfg(unix)]
    {
        // Set up SIGUSR2 signal handler for toggling transcription (best-effort).
        match Signals::new(&[SIGUSR2]) {
            Ok(signals) => signal_handle::setup_signal_handler(app_handle.clone(), signals),
            Err(err) => log::warn!("Failed to set up SIGUSR2 signal handler: {}", err),
        }
    }

    // Apply macOS Accessory policy if starting hidden
    #[cfg(target_os = "macos")]
    {
        let settings = settings::get_settings(app_handle);
        if settings.start_hidden {
            let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }
    // Get the current theme to set the appropriate initial icon
    let initial_theme = tray::get_current_theme(app_handle);

    // Choose the appropriate initial icon based on theme
    let initial_icon_path = tray::get_icon_path(initial_theme, tray::TrayIconState::Idle);

    let tray_icon = match app_handle
        .path()
        .resolve(initial_icon_path, tauri::path::BaseDirectory::Resource)
    {
        Ok(path) => match Image::from_path(path) {
            Ok(image) => Some(image),
            Err(err) => {
                log::error!(
                    "Failed to load tray icon image '{}': {}",
                    initial_icon_path,
                    err
                );
                None
            }
        },
        Err(err) => {
            log::error!(
                "Failed to resolve tray icon resource '{}': {}",
                initial_icon_path,
                err
            );
            None
        }
    };

    let tray_builder = TrayIconBuilder::new();
    let tray_builder = if let Some(image) = tray_icon {
        tray_builder.icon(image)
    } else {
        tray_builder
    };

    let tray = tray_builder
        .show_menu_on_left_click(true)
        .icon_as_template(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                show_main_window(app);
            }
            "check_updates" => {
                let settings = settings::get_settings(app);
                if settings.update_checks_enabled {
                    show_main_window(app);
                    let _ = app.emit("check-for-updates", ());
                }
            }
            "meeting_recording" => {
                let meetings_manager = app.state::<Arc<MeetingsManager>>();
                if meetings_manager.is_recording() {
                    show_main_window(app);
                    let _ = app.emit("navigate-to", "meetings");
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let meetings_manager = app_handle.state::<Arc<MeetingsManager>>();
                        match meetings_manager.stop_recording(None).await {
                            Ok(_) => {
                                show_main_window(&app_handle);
                                let _ = app_handle.emit("navigate-to", "meetings");
                            }
                            Err(err) => {
                                log::error!("Failed to stop meeting recording: {}", err);
                            }
                        }
                    });
                } else if let Err(err) = meetings_manager.start_recording(None, true) {
                    log::error!("Failed to start meeting recording: {}", err);
                } else {
                    show_main_window(app);
                    let _ = app.emit("navigate-to", "meetings");
                }
            }
            "create_task" => {
                crate::quick_task_overlay::show_quick_task_overlay(app);
            }
            "cancel" => {
                use crate::utils::cancel_current_operation;

                // Use centralized cancellation that handles all operations
                cancel_current_operation(app);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app_handle);
    match tray {
        Ok(tray) => {
            app_handle.manage(tray);
        }
        Err(err) => {
            log::error!("Failed to create tray icon: {}", err);
        }
    }

    // Initialize tray menu with idle state
    utils::update_tray_menu(app_handle, &utils::TrayIconState::Idle, None);

    // Get the autostart manager and configure based on user setting
    let autostart_manager = app_handle.autolaunch();
    let settings = settings::get_settings(&app_handle);

    if settings.autostart_enabled {
        // Enable autostart if user has opted in
        let _ = autostart_manager.enable();
    } else {
        // Disable autostart if user has opted out
        let _ = autostart_manager.disable();
    }

    // Create the recording overlay window (hidden by default)
    utils::create_recording_overlay(app_handle);
    // Create the clipboard overlay window (hidden by default)
    utils::create_clipboard_overlay(app_handle);
    // Create the quick task overlay window (hidden by default)
    utils::create_quick_task_overlay(app_handle);
    // Create the meeting prompt window (hidden by default)
    utils::create_meeting_prompt_overlay(app_handle);
}

#[tauri::command]
#[specta::specta]
fn trigger_update_check(app: AppHandle) -> Result<(), String> {
    let settings = settings::get_settings(&app);
    if !settings.update_checks_enabled {
        return Ok(());
    }
    app.emit("check-for-updates", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse console logging directives from RUST_LOG, falling back to info-level logging
    // when the variable is unset
    let console_filter = build_console_filter();

    let specta_builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        shortcut::change_binding,
        shortcut::reset_binding,
        shortcut::change_ptt_setting,
        shortcut::change_fn_key_ptt_setting,
        shortcut::change_audio_feedback_setting,
        shortcut::change_audio_feedback_volume_setting,
        shortcut::change_sound_theme_setting,
        shortcut::change_app_theme_setting,
        shortcut::change_start_hidden_setting,
        shortcut::change_autostart_setting,
        shortcut::change_translate_to_english_setting,
        shortcut::change_selected_language_setting,
        shortcut::change_overlay_position_setting,
        shortcut::change_meeting_detection_setting,
        shortcut::change_debug_mode_setting,
        shortcut::change_word_correction_threshold_setting,
        shortcut::change_paste_method_setting,
        shortcut::change_clipboard_handling_setting,
        shortcut::change_clipboard_quick_pastes_setting,
        shortcut::change_post_process_enabled_setting,
        shortcut::change_post_process_remove_fillers_setting,
        shortcut::change_post_process_base_url_setting,
        shortcut::change_post_process_api_key_setting,
        shortcut::change_post_process_model_setting,
        shortcut::set_post_process_provider,
        shortcut::fetch_post_process_models,
        shortcut::connect_openai_codex_oauth,
        shortcut::disconnect_openai_codex_oauth,
        shortcut::get_openai_codex_oauth_status,
        browser_account_auth::begin_browser_account_auth,
        browser_account_auth::cancel_browser_account_auth,
        shortcut::add_post_process_prompt,
        shortcut::update_post_process_prompt,
        shortcut::delete_post_process_prompt,
        shortcut::set_post_process_selected_prompt,
        shortcut::update_custom_words,
        shortcut::update_custom_dictionary,
        shortcut::suspend_binding,
        shortcut::resume_binding,
        shortcut::change_mute_while_recording_setting,
        shortcut::change_recording_output_mode_setting,
        shortcut::change_recording_duck_level_setting,
        shortcut::change_append_trailing_space_setting,
        shortcut::change_app_language_setting,
        shortcut::change_update_checks_setting,
        shortcut::set_app_profile_override,
        shortcut::remove_app_profile_override,
        trigger_update_check,
        commands::cancel_operation,
        commands::get_app_dir_path,
        commands::get_app_settings,
        commands::get_default_settings,
        commands::get_log_dir_path,
        commands::set_log_level,
        commands::snooze_meeting_prompt,
        commands::open_recordings_folder,
        commands::open_log_dir,
        commands::open_app_data_dir,
        model_context::sync_tasks_snapshot,
        voice_commands::get_open_commands,
        voice_commands::set_open_commands,
        voice_commands::get_snippets,
        voice_commands::set_snippets,
        commands::models::get_available_models,
        commands::models::get_model_info,
        commands::models::download_model,
        commands::models::delete_model,
        commands::models::cancel_download,
        commands::models::set_active_model,
        commands::models::get_current_model,
        commands::models::get_transcription_model_status,
        commands::models::is_model_loading,
        commands::models::has_any_models_available,
        commands::models::has_any_models_or_downloads,
        commands::models::get_recommended_first_model,
        commands::audio::update_microphone_mode,
        commands::audio::get_microphone_mode,
        commands::audio::get_available_microphones,
        commands::audio::set_selected_microphone,
        commands::audio::get_selected_microphone,
        commands::audio::get_available_output_devices,
        commands::audio::set_selected_output_device,
        commands::audio::get_selected_output_device,
        commands::audio::play_test_sound,
        commands::audio::check_custom_sounds,
        commands::audio::set_clamshell_microphone,
        commands::audio::get_clamshell_microphone,
        commands::audio::is_recording,
        commands::audio::is_voice_activity_active,
        commands::audio::get_overlay_meter_levels,
        commands::transcription::set_model_unload_timeout,
        commands::transcription::get_model_load_status,
        commands::transcription::unload_model_manually,
        commands::local_llm::get_local_llm_status,
        commands::insertion::undo_last_insertion,
        commands::history::get_history_entries,
        commands::history::get_history_entries_page,
        commands::history::get_history_entries_page_compact,
        commands::history::get_history_entries_page_compact_for_app,
        commands::history::get_history_app_filter_options,
        commands::history::get_history_stats,
        commands::history::get_history_entry_text,
        commands::history::get_history_streak,
        commands::history::toggle_history_entry_saved,
        commands::history::get_audio_file_path,
        commands::history::delete_history_entry,
        commands::history::update_history_limit,
        commands::history::update_recording_retention_period,
        commands::history::get_app_icon,
        commands::clipboard_history::get_clipboard_history_entries,
        commands::clipboard_history::get_clipboard_history_entries_page,
        commands::clipboard_history::get_clipboard_history_entries_page_summary,
        commands::clipboard_history::get_clipboard_history_entries_page_for_app,
        commands::clipboard_history::get_clipboard_history_entries_page_summary_for_app,
        commands::clipboard_history::get_clipboard_history_app_filter_options,
        commands::clipboard_history::get_clipboard_history_entry_text,
        commands::clipboard_history::get_clipboard_history_entry_media,
        commands::clipboard_history::copy_clipboard_history_entry,
        commands::clipboard_history::clear_clipboard_history,
        commands::clipboard_history::clear_clipboard_history_range,
        commands::clipboard_history::delete_clipboard_history_entry,
        commands::clipboard_history::paste_clipboard_history_entry,
        commands::clipboard_history::paste_clipboard_quick_paste_text,
        commands::clipboard_history::hide_clipboard_overlay,
        commands::clipboard_history::is_clipboard_recently_active,
        commands::clipboard_history::set_clipboard_overlay_position,
        commands::quick_task_overlay::hide_quick_task_overlay,
        commands::quick_task_overlay::dismiss_quick_task_overlay,
        commands::quick_task_overlay::submit_quick_task,
        commands::notes::get_notes,
        commands::notes::create_note,
        commands::notes::update_note,
        commands::notes::delete_note,
        commands::notes::set_active_note,
        commands::notes::get_active_note,
        commands::sync::sync_with_server,
        commands::sync::sync_meetings_with_server,
        commands::meetings::start_meeting_recording,
        commands::meetings::stop_meeting_recording,
        commands::meetings::get_meetings,
        commands::meetings::get_deleted_meetings,
        commands::meetings::get_meeting_audio_file_path,
        commands::meetings::rename_meeting,
        commands::meetings::get_meeting_tags,
        commands::meetings::set_meeting_tags,
        commands::meetings::get_participants,
        commands::meetings::create_participant,
        commands::meetings::get_meeting_participants,
        commands::meetings::set_meeting_participants,
        commands::meetings::delete_meeting,
        commands::meetings::restore_meeting,
        commands::meetings::delete_meeting_permanently,
        commands::meetings::is_meeting_recording,
        commands::meetings::get_active_meeting,
        commands::meetings::get_active_meeting_live_transcript,
        commands::meetings::add_meeting_note,
        commands::meetings::add_meeting_note_span,
        commands::meetings::add_meeting_note_at,
        commands::meetings::get_meeting_notes,
        commands::meetings::get_meeting_transcript,
        commands::meetings::update_meeting_transcript_segment,
        commands::meetings::update_meeting_transcript_segment_speaker,
        commands::meetings::run_meeting_diarization,
        commands::meetings::get_meeting_diarization_status,
        commands::meetings::get_meeting_speaker_mappings,
        commands::meetings::update_meeting_speaker_mapping,
        commands::meetings::summarize_meeting,
        commands::meetings::generate_meeting_tasks,
        commands::meetings::draft_meeting_follow_up,
        commands::meetings::download_meeting,
        helpers::clamshell::is_laptop,
    ]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::Number),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    let mut builder = tauri::Builder::default().plugin(
        LogBuilder::new()
            .level(log::LevelFilter::Trace) // Set to most verbose level globally
            .max_file_size(500_000)
            .rotation_strategy(RotationStrategy::KeepOne)
            .clear_targets()
            .targets([
                // Console output respects RUST_LOG environment variable
                Target::new(TargetKind::Stdout).filter({
                    let console_filter = console_filter.clone();
                    move |metadata| console_filter.enabled(metadata)
                }),
                // File logs respect the user's settings (stored in FILE_LOG_LEVEL atomic)
                Target::new(TargetKind::LogDir {
                    file_name: Some("breezetype".into()),
                })
                .filter(|metadata| {
                    let file_level = FILE_LOG_LEVEL.load(Ordering::Relaxed);
                    metadata.level() <= level_filter_from_u8(file_level)
                }),
            ])
            .build(),
    );

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_auth_session::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(Mutex::new(ShortcutToggleStates::default()))
        .manage(Mutex::new(tray::TrayIconState::Idle))
        .setup(move |app| {
            let settings = get_settings(&app.handle());
            let tauri_log_level: tauri_plugin_log::LogLevel = settings.log_level.into();
            let file_log_level: log::Level = tauri_log_level.into();
            // Store the file log level in the atomic for the filter to use
            FILE_LOG_LEVEL.store(file_log_level.to_level_filter() as u8, Ordering::Relaxed);
            let app_handle = app.handle().clone();

            initialize_core_logic(&app_handle);

            // Show main window only if not starting hidden
            if !settings.start_hidden {
                show_main_window(&app_handle);
            }

            #[cfg(debug_assertions)]
            {
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let window = main_window.clone();
                    let dev_url = app_handle
                        .config()
                        .build
                        .dev_url
                        .clone()
                        .unwrap_or_else(|| Url::parse("http://127.0.0.1:1420/").unwrap());
                    let dev_url_string = dev_url.as_str().to_string();
                    tauri::async_runtime::spawn(async move {
                        if dev_url.scheme() != "http" && dev_url.scheme() != "https" {
                            return;
                        }
                        for _ in 0..50 {
                            if reqwest::get(&dev_url_string).await.is_ok() {
                                let _ = window.navigate(dev_url.clone());
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    });
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _res = window.hide();
                #[cfg(target_os = "macos")]
                {
                    let res = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                    if let Err(e) = res {
                        log::error!("Failed to set activation policy: {}", e);
                    }
                }
            }
            tauri::WindowEvent::ThemeChanged(theme) => {
                log::info!("Theme changed to: {:?}", theme);
                // Update tray icon to match new theme, maintaining idle state
                utils::change_tray_icon(&window.app_handle(), utils::TrayIconState::Idle);
            }
            _ => {}
        })
        .invoke_handler(specta_builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
