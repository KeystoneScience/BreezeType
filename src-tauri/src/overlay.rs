use crate::input;
use crate::settings;
use crate::settings::OverlayPosition;
use log::debug;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};
#[cfg(target_os = "macos")]
use tauri::{LogicalSize, Size};
#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt as _, PanelBuilder, PanelLevel, StyleMask,
};

const OVERLAY_WIDTH: f64 = 172.0;
const OVERLAY_HEIGHT: f64 = 36.0;
static MIC_LEVEL_EMIT_ERROR_COUNT: AtomicUsize = AtomicUsize::new(0);
static LAST_MIC_LEVELS: Lazy<Mutex<Vec<f32>>> = Lazy::new(|| Mutex::new(vec![0.0; 16]));
static OVERLAY_TRANSITION_TOKEN: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(RecordingOverlayPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
    })
}

#[cfg(target_os = "macos")]
const OVERLAY_TOP_OFFSET: f64 = 46.0;
#[cfg(any(target_os = "windows", target_os = "linux"))]
const OVERLAY_TOP_OFFSET: f64 = 4.0;

#[cfg(target_os = "macos")]
const OVERLAY_BOTTOM_OFFSET: f64 = 15.0;

#[cfg(any(target_os = "windows", target_os = "linux"))]
const OVERLAY_BOTTOM_OFFSET: f64 = 40.0;

/// Forces a window to be topmost using Win32 API (Windows only)
/// This is more reliable than Tauri's set_always_on_top which can be overridden
#[cfg(target_os = "windows")]
fn force_overlay_topmost(overlay_window: &tauri::webview::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };

    // Clone because run_on_main_thread takes 'static
    let overlay_clone = overlay_window.clone();

    // Make sure the Win32 call happens on the UI thread
    let _ = overlay_clone.clone().run_on_main_thread(move || {
        if let Ok(hwnd) = overlay_clone.hwnd() {
            unsafe {
                // Force Z-order: make this window topmost without changing size/pos or stealing focus
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }
    });
}

fn get_monitor_with_cursor(app_handle: &AppHandle) -> Option<tauri::Monitor> {
    if let Some(mouse_location) = input::get_cursor_position(app_handle) {
        if let Ok(monitors) = app_handle.available_monitors() {
            for monitor in monitors {
                let is_within =
                    is_mouse_within_monitor(mouse_location, monitor.position(), monitor.size());
                if is_within {
                    return Some(monitor);
                }
            }
        }
    }

    app_handle.primary_monitor().ok().flatten()
}

fn is_mouse_within_monitor(
    mouse_pos: (i32, i32),
    monitor_pos: &PhysicalPosition<i32>,
    monitor_size: &PhysicalSize<u32>,
) -> bool {
    let (mouse_x, mouse_y) = mouse_pos;
    let PhysicalPosition {
        x: monitor_x,
        y: monitor_y,
    } = *monitor_pos;
    let PhysicalSize {
        width: monitor_width,
        height: monitor_height,
    } = *monitor_size;

    mouse_x >= monitor_x
        && mouse_x < (monitor_x + monitor_width as i32)
        && mouse_y >= monitor_y
        && mouse_y < (monitor_y + monitor_height as i32)
}

fn calculate_overlay_position(app_handle: &AppHandle) -> Option<(f64, f64)> {
    if let Some(monitor) = get_monitor_with_cursor(app_handle) {
        let work_area = monitor.work_area();
        let scale = monitor.scale_factor();
        let work_area_width = work_area.size.width as f64 / scale;
        let work_area_height = work_area.size.height as f64 / scale;
        let work_area_x = work_area.position.x as f64 / scale;
        let work_area_y = work_area.position.y as f64 / scale;

        let settings = settings::get_settings(app_handle);

        let x = work_area_x + (work_area_width - OVERLAY_WIDTH) / 2.0;
        let y = match settings.overlay_position {
            OverlayPosition::Top => work_area_y + OVERLAY_TOP_OFFSET,
            OverlayPosition::Bottom | OverlayPosition::None => {
                // don't subtract the overlay height it puts it too far up
                work_area_y + work_area_height - OVERLAY_BOTTOM_OFFSET
            }
        };

        return Some((x, y));
    }
    None
}

/// Creates the recording overlay window and keeps it hidden by default.
pub fn create_recording_overlay(app_handle: &AppHandle) {
    if app_handle.get_webview_window("recording_overlay").is_some() {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let builder =
            PanelBuilder::<_, RecordingOverlayPanel>::new(app_handle, "recording_overlay")
                .url(WebviewUrl::App("src/overlay/index.html".into()))
                .title("Recording")
                .size(Size::Logical(LogicalSize {
                    width: OVERLAY_WIDTH,
                    height: OVERLAY_HEIGHT,
                }))
                .level(PanelLevel::Floating)
                .has_shadow(false)
                .collection_behavior(
                    CollectionBehavior::new()
                        .full_screen_auxiliary()
                        .can_join_all_spaces(),
                )
                .hides_on_deactivate(false)
                .works_when_modal(true)
                .style_mask(StyleMask::empty().borderless().nonactivating_panel())
                .no_activate(true)
                .with_window(|window| {
                    window
                        .resizable(false)
                        .accept_first_mouse(true)
                        .maximizable(false)
                        .minimizable(false)
                        .closable(false)
                        .decorations(false)
                        .always_on_top(true)
                        .skip_taskbar(true)
                        .transparent(true)
                        .visible_on_all_workspaces(true)
                        .focused(false)
                        .visible(false)
                });

        match builder.build() {
            Ok(_window) => {
                debug!("Recording overlay panel created successfully (hidden)");
            }
            Err(e) => {
                log::error!("Failed to create recording overlay panel: {}", e);
            }
        }

        return;
    }

    #[cfg(not(target_os = "macos"))]
    match WebviewWindowBuilder::new(
        app_handle,
        "recording_overlay",
        WebviewUrl::App("src/overlay/index.html".into()),
    )
    .title("Recording")
    .resizable(false)
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .shadow(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .accept_first_mouse(true)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .transparent(true)
    .focused(false)
    .visible(false)
    .build()
    {
        Ok(_window) => {
            debug!("Recording overlay window created successfully (hidden)");
        }
        Err(e) => {
            log::error!("Failed to create recording overlay window: {}", e);
        }
    }
}

/// Shows the recording overlay window with fade-in animation
pub fn show_recording_overlay(app_handle: &AppHandle) {
    let transition_token = OVERLAY_TRANSITION_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;

    // Check if overlay should be shown based on position setting
    let settings = settings::get_settings(app_handle);
    debug!(
        "show_recording_overlay called (position: {:?})",
        settings.overlay_position
    );
    if settings.overlay_position == OverlayPosition::None {
        return;
    }

    if app_handle.get_webview_window("recording_overlay").is_none() {
        create_recording_overlay(app_handle);
    }

    if let Some(overlay_window) = app_handle.get_webview_window("recording_overlay") {
        // Update position before showing to prevent flicker from position changes
        if let Some((x, y)) = calculate_overlay_position(app_handle) {
            if let Err(err) = overlay_window
                .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
            {
                log::warn!("Failed to position recording overlay window: {}", err);
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(panel) = app_handle.get_webview_panel("recording_overlay") {
                let window = overlay_window.clone();
                let panel = panel.clone();
                let _ = window.run_on_main_thread(move || {
                    panel.show();
                });
                if let Err(err) = overlay_window.emit("show-overlay", "recording") {
                    log::warn!(
                        "Failed to emit recording state to recording overlay window: {}",
                        err
                    );
                } else {
                    debug!(
                        "Recording overlay shown in recording state (token={})",
                        transition_token
                    );
                }
                return;
            }
        }

        if let Err(err) = overlay_window.show() {
            log::warn!("Failed to show recording overlay window: {}", err);
        }

        // On Windows, aggressively re-assert "topmost" in the native Z-order after showing
        #[cfg(target_os = "windows")]
        force_overlay_topmost(&overlay_window);

        // Emit event to trigger fade-in animation with recording state
        if let Err(err) = overlay_window.emit("show-overlay", "recording") {
            log::warn!(
                "Failed to emit recording state to recording overlay window: {}",
                err
            );
        } else {
            debug!(
                "Recording overlay shown in recording state (token={})",
                transition_token
            );
        }
    } else {
        log::warn!("Recording overlay window missing when trying to show recording state");
    }
}

/// Shows the transcribing overlay window
pub fn show_transcribing_overlay(app_handle: &AppHandle) {
    let transition_token = OVERLAY_TRANSITION_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;

    // Check if overlay should be shown based on position setting
    let settings = settings::get_settings(app_handle);
    debug!(
        "show_transcribing_overlay called (position: {:?})",
        settings.overlay_position
    );
    if settings.overlay_position == OverlayPosition::None {
        return;
    }

    if app_handle.get_webview_window("recording_overlay").is_none() {
        create_recording_overlay(app_handle);
    }

    update_overlay_position(app_handle);

    if let Some(overlay_window) = app_handle.get_webview_window("recording_overlay") {
        #[cfg(target_os = "macos")]
        {
            if let Ok(panel) = app_handle.get_webview_panel("recording_overlay") {
                let window = overlay_window.clone();
                let panel = panel.clone();
                let _ = window.run_on_main_thread(move || {
                    panel.show();
                });
                if let Err(err) = overlay_window.emit("show-overlay", "transcribing") {
                    log::warn!(
                        "Failed to emit transcribing state to recording overlay window: {}",
                        err
                    );
                } else {
                    debug!(
                        "Recording overlay shown in transcribing state (token={})",
                        transition_token
                    );
                }
                return;
            }
        }

        if let Err(err) = overlay_window.show() {
            log::warn!("Failed to show transcribing overlay window: {}", err);
        }

        // On Windows, aggressively re-assert "topmost" in the native Z-order after showing
        #[cfg(target_os = "windows")]
        force_overlay_topmost(&overlay_window);

        // Emit event to switch to transcribing state
        if let Err(err) = overlay_window.emit("show-overlay", "transcribing") {
            log::warn!(
                "Failed to emit transcribing state to recording overlay window: {}",
                err
            );
        } else {
            debug!(
                "Recording overlay shown in transcribing state (token={})",
                transition_token
            );
        }
    } else {
        log::warn!("Recording overlay window missing when trying to show transcribing state");
    }
}

/// Shows a short clipboard confirmation overlay.
pub fn show_clipboard_notice_overlay(app_handle: &AppHandle) -> bool {
    let transition_token = OVERLAY_TRANSITION_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;

    // Check if overlay should be shown based on position setting
    let settings = settings::get_settings(app_handle);
    debug!(
        "show_clipboard_notice_overlay called (position: {:?})",
        settings.overlay_position
    );
    if settings.overlay_position == OverlayPosition::None {
        return false;
    }

    if app_handle.get_webview_window("recording_overlay").is_none() {
        create_recording_overlay(app_handle);
    }

    update_overlay_position(app_handle);

    if let Some(overlay_window) = app_handle.get_webview_window("recording_overlay") {
        #[cfg(target_os = "macos")]
        {
            if let Ok(panel) = app_handle.get_webview_panel("recording_overlay") {
                let window = overlay_window.clone();
                let panel_for_show = panel.clone();
                let _ = window.run_on_main_thread(move || {
                    panel_for_show.show();
                });

                if let Err(err) = overlay_window.emit("show-overlay", "clipboard") {
                    log::warn!(
                        "Failed to emit clipboard state to recording overlay window: {}",
                        err
                    );
                    return false;
                }

                let panel_for_hide = panel.clone();
                let window = overlay_window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(920)).await;
                    if OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token {
                        return;
                    }
                    if let Err(err) = window.emit("hide-overlay", ()) {
                        log::warn!(
                            "Failed to emit hide-overlay event for clipboard notice: {}",
                            err
                        );
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(260)).await;
                    if OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token {
                        return;
                    }
                    let _ = window.run_on_main_thread(move || {
                        panel_for_hide.hide();
                    });
                });

                return true;
            }
        }

        if let Err(err) = overlay_window.show() {
            log::warn!("Failed to show clipboard notice overlay window: {}", err);
            return false;
        }

        #[cfg(target_os = "windows")]
        force_overlay_topmost(&overlay_window);

        if let Err(err) = overlay_window.emit("show-overlay", "clipboard") {
            log::warn!(
                "Failed to emit clipboard state to recording overlay window: {}",
                err
            );
            return false;
        }
        let window = overlay_window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(920)).await;
            if OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token {
                return;
            }
            if let Err(err) = window.emit("hide-overlay", ()) {
                log::warn!(
                    "Failed to emit hide-overlay event for clipboard notice: {}",
                    err
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(260)).await;
            if OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token {
                return;
            }
            if let Err(err) = window.hide() {
                log::warn!("Failed to hide clipboard notice overlay window: {}", err);
            }
        });

        return true;
    }

    false
}

/// Updates the overlay window position based on current settings
pub fn update_overlay_position(app_handle: &AppHandle) {
    if let Some(overlay_window) = app_handle.get_webview_window("recording_overlay") {
        if let Some((x, y)) = calculate_overlay_position(app_handle) {
            if let Err(err) = overlay_window
                .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
            {
                log::warn!("Failed to update recording overlay position: {}", err);
            }
        }
    }
}

/// Hides the recording overlay window with fade-out animation
pub fn hide_recording_overlay(app_handle: &AppHandle) {
    let transition_token = OVERLAY_TRANSITION_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;

    // Always hide the overlay regardless of settings - if setting was changed while recording,
    // we still want to hide it properly
    if let Some(overlay_window) = app_handle.get_webview_window("recording_overlay") {
        // Emit event to trigger fade-out animation
        if let Err(err) = overlay_window.emit("hide-overlay", ()) {
            log::warn!("Failed to emit hide-overlay event: {}", err);
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(panel) = app_handle.get_webview_panel("recording_overlay") {
                let panel = panel.clone();
                let window = overlay_window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token {
                        return;
                    }
                    let _ = window.run_on_main_thread(move || {
                        panel.hide();
                    });
                });
                return;
            }
        }

        let window = overlay_window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token {
                return;
            }
            if let Err(err) = window.hide() {
                log::warn!("Failed to hide recording overlay window: {}", err);
            }
        });
    }
}

pub fn emit_levels(app_handle: &AppHandle, levels: &Vec<f32>) {
    let should_log_error = || {
        let attempts = MIC_LEVEL_EMIT_ERROR_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
        attempts <= 3 || attempts % 1000 == 0
    };

    if let Ok(mut last_levels) = LAST_MIC_LEVELS.lock() {
        *last_levels = levels.clone();
    }

    // emit levels to main app
    if let Err(err) = app_handle.emit("mic-level", levels) {
        if should_log_error() {
            log::warn!("Failed to emit app mic-level event: {}", err);
        }
    }

    // also emit to the recording overlay if it's open
    if let Some(overlay_window) = app_handle.get_webview_window("recording_overlay") {
        if let Err(err) = overlay_window.emit("mic-level", levels) {
            if should_log_error() {
                log::warn!("Failed to emit overlay mic-level event: {}", err);
            }
        }
    }
}

pub fn latest_levels() -> Vec<f32> {
    LAST_MIC_LEVELS
        .lock()
        .map(|levels| levels.clone())
        .unwrap_or_else(|_| vec![0.0; 16])
}
