use crate::managers::meetings::MeetingsManager;
use crate::settings::{self, AppThemePreference};
use crate::tray_i18n::get_tray_translations;
use crate::ManagedTrayState;
use log::{error, warn};
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Theme};

#[derive(Clone, Debug, PartialEq)]
pub enum TrayIconState {
    Idle,
    Recording,
    Transcribing,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AppTheme {
    Dark,
    Light,
    Colored, // Pink/colored theme for Linux
}

/// Gets the current app theme, with Linux defaulting to Colored theme
pub fn get_current_theme(app: &AppHandle) -> AppTheme {
    if cfg!(target_os = "linux") {
        // On Linux, always use the colored theme
        AppTheme::Colored
    } else {
        let settings = settings::get_settings(app);
        match settings.app_theme {
            AppThemePreference::Light => AppTheme::Light,
            AppThemePreference::Dark => AppTheme::Dark,
            AppThemePreference::System => {
                if let Some(main_window) = app.get_webview_window("main") {
                    match main_window.theme().unwrap_or(Theme::Dark) {
                        Theme::Light => AppTheme::Light,
                        Theme::Dark => AppTheme::Dark,
                        _ => AppTheme::Dark, // Default fallback
                    }
                } else {
                    AppTheme::Dark
                }
            }
        }
    }
}

/// Gets the icon path for the tray/menu bar based on theme and state.
pub fn get_icon_path(theme: AppTheme, state: TrayIconState) -> &'static str {
    if cfg!(target_os = "macos") {
        let dark = matches!(theme, AppTheme::Dark);
        return match (state, dark) {
            (TrayIconState::Idle, true) => "resources/tray_idle_dark.png",
            (TrayIconState::Recording, true) => "resources/tray_recording_dark.png",
            (TrayIconState::Transcribing, true) => "resources/tray_transcribing_dark.png",
            (TrayIconState::Idle, false) => "resources/tray_idle.png",
            (TrayIconState::Recording, false) => "resources/tray_recording.png",
            (TrayIconState::Transcribing, false) => "resources/tray_transcribing.png",
        };
    }

    match state {
        TrayIconState::Idle => "resources/breeze.png",
        TrayIconState::Recording => "resources/recording.png",
        TrayIconState::Transcribing => "resources/transcribing.png",
    }
}

pub fn change_tray_icon(app: &AppHandle, icon: TrayIconState) {
    if let Ok(mut state) = app.state::<ManagedTrayState>().lock() {
        *state = icon.clone();
    }

    let Some(tray) = app.try_state::<TrayIcon>() else {
        warn!("Tray icon not initialized; skipping tray icon update");
        return;
    };
    let theme = get_current_theme(app);

    let icon_path = get_icon_path(theme, icon.clone());

    let resolved_path = match app
        .path()
        .resolve(icon_path, tauri::path::BaseDirectory::Resource)
    {
        Ok(path) => path,
        Err(err) => {
            error!(
                "Failed to resolve tray icon resource '{}': {}",
                icon_path, err
            );
            return;
        }
    };

    let image = match Image::from_path(&resolved_path) {
        Ok(image) => image,
        Err(err) => {
            error!(
                "Failed to load tray icon image '{}': {}",
                resolved_path.display(),
                err
            );
            return;
        }
    };

    if let Err(err) = tray.set_icon(Some(image)) {
        error!("Failed to set tray icon: {}", err);
    }

    // Update menu based on state
    update_tray_menu(app, &icon, None);
}

pub fn get_tray_state(app: &AppHandle) -> TrayIconState {
    match app.state::<ManagedTrayState>().lock() {
        Ok(state) => state.clone(),
        Err(_) => TrayIconState::Idle,
    }
}

pub fn update_tray_menu(app: &AppHandle, state: &TrayIconState, locale: Option<&str>) {
    let settings = settings::get_settings(app);

    let locale = locale.unwrap_or(&settings.app_language);
    let strings = get_tray_translations(Some(locale.to_string()));
    let meetings_manager = app.state::<Arc<MeetingsManager>>();
    let is_meeting_recording = meetings_manager.is_recording();

    // Platform-specific accelerators
    #[cfg(target_os = "macos")]
    let (settings_accelerator, create_task_accelerator, quit_accelerator) =
        (Some("Cmd+,"), Some("Cmd+Shift+C"), Some("Cmd+Q"));
    #[cfg(not(target_os = "macos"))]
    let (settings_accelerator, create_task_accelerator, quit_accelerator) =
        (Some("Ctrl+,"), Some("Ctrl+Shift+C"), Some("Ctrl+Q"));

    // Create common menu items
    let settings_i = match MenuItem::with_id(
        app,
        "settings",
        &strings.settings,
        true,
        settings_accelerator,
    ) {
        Ok(item) => item,
        Err(err) => {
            error!("Failed to create tray settings menu item: {}", err);
            return;
        }
    };
    let meeting_recording_label = if is_meeting_recording {
        &strings.stop_meeting_recording
    } else {
        &strings.start_meeting_recording
    };
    let meeting_recording_i = match MenuItem::with_id(
        app,
        "meeting_recording",
        meeting_recording_label,
        true,
        None::<&str>,
    ) {
        Ok(item) => item,
        Err(err) => {
            error!("Failed to create tray meeting-recording menu item: {}", err);
            return;
        }
    };
    let create_task_i = match MenuItem::with_id(
        app,
        "create_task",
        &strings.create_task,
        true,
        create_task_accelerator,
    ) {
        Ok(item) => item,
        Err(err) => {
            error!("Failed to create tray create-task menu item: {}", err);
            return;
        }
    };
    let quit_i = match MenuItem::with_id(app, "quit", &strings.quit, true, quit_accelerator) {
        Ok(item) => item,
        Err(err) => {
            error!("Failed to create tray quit menu item: {}", err);
            return;
        }
    };

    let menu = match state {
        TrayIconState::Recording | TrayIconState::Transcribing => {
            let cancel_i =
                match MenuItem::with_id(app, "cancel", &strings.cancel, true, None::<&str>) {
                    Ok(item) => item,
                    Err(err) => {
                        error!("Failed to create tray cancel menu item: {}", err);
                        return;
                    }
                };
            let separator1 = match PredefinedMenuItem::separator(app) {
                Ok(item) => item,
                Err(err) => {
                    error!("Failed to create tray separator: {}", err);
                    return;
                }
            };
            let separator2 = match PredefinedMenuItem::separator(app) {
                Ok(item) => item,
                Err(err) => {
                    error!("Failed to create tray separator: {}", err);
                    return;
                }
            };
            let menu = match Menu::with_items(
                app,
                &[
                    &cancel_i,
                    &meeting_recording_i,
                    &create_task_i,
                    &separator1,
                    &settings_i,
                    &separator2,
                    &quit_i,
                ],
            ) {
                Ok(menu) => menu,
                Err(err) => {
                    error!("Failed to create tray menu: {}", err);
                    return;
                }
            };
            menu
        }
        TrayIconState::Idle => {
            let separator1 = match PredefinedMenuItem::separator(app) {
                Ok(item) => item,
                Err(err) => {
                    error!("Failed to create tray separator: {}", err);
                    return;
                }
            };
            let separator2 = match PredefinedMenuItem::separator(app) {
                Ok(item) => item,
                Err(err) => {
                    error!("Failed to create tray separator: {}", err);
                    return;
                }
            };
            let menu = match Menu::with_items(
                app,
                &[
                    &meeting_recording_i,
                    &create_task_i,
                    &separator1,
                    &settings_i,
                    &separator2,
                    &quit_i,
                ],
            ) {
                Ok(menu) => menu,
                Err(err) => {
                    error!("Failed to create tray menu: {}", err);
                    return;
                }
            };
            menu
        }
    };

    let Some(tray) = app.try_state::<TrayIcon>() else {
        warn!("Tray icon not initialized; skipping tray menu update");
        return;
    };
    if let Err(err) = tray.set_menu(Some(menu)) {
        error!("Failed to set tray menu: {}", err);
    }
    #[cfg(target_os = "macos")]
    let _ = tray.set_icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let _ = tray.set_icon_as_template(false);
}
