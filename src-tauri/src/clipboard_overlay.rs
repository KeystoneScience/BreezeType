use crate::input;
use crate::settings;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::window::EffectState;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::window::{Effect, EffectsBuilder};
#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};
#[cfg(target_os = "macos")]
use tauri::{LogicalSize, Size, WebviewUrl};
#[cfg(target_os = "macos")]
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt as _, PanelBuilder, PanelLevel, StyleMask,
};

const OVERLAY_WIDTH: f64 = 600.0;
const OVERLAY_HEIGHT: f64 = 380.0;
const OVERLAY_BLUR_RADIUS: f64 = 1.0;

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(ClipboardOverlayPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
    })
}

#[cfg(target_os = "macos")]
static PREVIOUS_FRONTMOST_PID: Lazy<Mutex<Option<i64>>> = Lazy::new(|| Mutex::new(None));
static PREVIOUS_FOCUS_CONTEXT: Lazy<Mutex<Option<crate::focus_context::FocusContext>>> =
    Lazy::new(|| Mutex::new(None));
static CLIPBOARD_OVERLAY_TRANSITION_TOKEN: AtomicU64 = AtomicU64::new(0);

fn remember_previous_focus_context() {
    let current_pid = std::process::id() as i64;
    let previous = crate::focus_context::get_active_context().and_then(|ctx| {
        if ctx.process_id == Some(current_pid) {
            None
        } else {
            Some(ctx)
        }
    });

    if let Ok(mut guard) = PREVIOUS_FOCUS_CONTEXT.lock() {
        *guard = previous;
    }
}

pub fn previous_focus_context() -> Option<crate::focus_context::FocusContext> {
    PREVIOUS_FOCUS_CONTEXT
        .lock()
        .ok()
        .and_then(|guard| (*guard).clone())
}

#[cfg(target_os = "macos")]
fn remember_previous_frontmost_app() {
    let current_pid = std::process::id() as i64;
    let previous = crate::focus_context::frontmost_process_id().and_then(|pid| {
        if pid == current_pid {
            None
        } else {
            Some(pid)
        }
    });
    if let Ok(mut guard) = PREVIOUS_FRONTMOST_PID.lock() {
        *guard = previous;
    }
}

#[cfg(target_os = "macos")]
fn activate_process_by_pid(pid: i64) {
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as _) {
        let _ = app.activateWithOptions(NSApplicationActivationOptions::empty());
    }
}

pub fn restore_previous_frontmost_app() {
    #[cfg(target_os = "macos")]
    {
        let pid = PREVIOUS_FRONTMOST_PID
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        if let Some(pid) = pid {
            activate_process_by_pid(pid);
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn build_clipboard_effects() -> tauri::utils::config::WindowEffectsConfig {
    #[cfg(target_os = "macos")]
    {
        return EffectsBuilder::new()
            .effect(Effect::Popover)
            .state(EffectState::Active)
            .radius(OVERLAY_BLUR_RADIUS)
            .build();
    }

    #[cfg(target_os = "windows")]
    {
        return EffectsBuilder::new().effect(Effect::Blur).build();
    }
}

fn get_monitor_with_cursor(app_handle: &AppHandle) -> Option<tauri::Monitor> {
    if let Some(mouse_location) = input::get_cursor_position(app_handle) {
        if let Ok(monitors) = app_handle.available_monitors() {
            for monitor in monitors {
                if is_mouse_within_monitor(mouse_location, monitor.position(), monitor.size()) {
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

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

fn clamp_position_to_monitor(
    position: settings::WindowPosition,
    monitor: &tauri::Monitor,
) -> Option<(f64, f64)> {
    let work_area = monitor.work_area();
    let scale = monitor.scale_factor();
    let work_area_width = work_area.size.width as f64 / scale;
    let work_area_height = work_area.size.height as f64 / scale;
    let work_area_x = work_area.position.x as f64 / scale;
    let work_area_y = work_area.position.y as f64 / scale;

    let within_bounds = position.x >= work_area_x
        && position.x <= (work_area_x + work_area_width)
        && position.y >= work_area_y
        && position.y <= (work_area_y + work_area_height);

    if !within_bounds {
        return None;
    }

    let max_x = work_area_x + work_area_width - OVERLAY_WIDTH;
    let max_y = work_area_y + work_area_height - OVERLAY_HEIGHT;

    let x = clamp(position.x, work_area_x, max_x.max(work_area_x));
    let y = clamp(position.y, work_area_y, max_y.max(work_area_y));

    Some((x, y))
}

fn calculate_clipboard_overlay_position(app_handle: &AppHandle) -> Option<(f64, f64)> {
    let settings = settings::get_settings(app_handle);
    let monitor = get_monitor_with_cursor(app_handle)?;

    if let Some(position) = settings.clipboard_overlay_position {
        if let Some(clamped) = clamp_position_to_monitor(position, &monitor) {
            return Some(clamped);
        }
    }

    let work_area = monitor.work_area();
    let scale = monitor.scale_factor();
    let work_area_width = work_area.size.width as f64 / scale;
    let work_area_height = work_area.size.height as f64 / scale;
    let work_area_x = work_area.position.x as f64 / scale;
    let work_area_y = work_area.position.y as f64 / scale;

    let mut x = work_area_x + (work_area_width - OVERLAY_WIDTH) / 2.0;
    let mut y = work_area_y + (work_area_height - OVERLAY_HEIGHT) / 2.0;

    let max_x = work_area_x + work_area_width - OVERLAY_WIDTH;
    let max_y = work_area_y + work_area_height - OVERLAY_HEIGHT;

    x = clamp(x, work_area_x, max_x.max(work_area_x));
    y = clamp(y, work_area_y, max_y.max(work_area_y));

    Some((x, y))
}

pub fn create_clipboard_overlay(app_handle: &AppHandle) {
    if app_handle.get_webview_window("clipboard_overlay").is_some() {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let builder =
            PanelBuilder::<_, ClipboardOverlayPanel>::new(app_handle, "clipboard_overlay")
                .url(WebviewUrl::App("src/clipboard-overlay/index.html".into()))
                .title("Clipboard")
                .size(Size::Logical(LogicalSize {
                    width: OVERLAY_WIDTH,
                    height: OVERLAY_HEIGHT,
                }))
                .level(PanelLevel::Floating)
                .has_shadow(true)
                .corner_radius(20.0)
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
                        .visible(false)
                });

        if let Err(e) = builder.build() {
            log::error!("Failed to create clipboard overlay panel: {}", e);
        }

        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let builder = WebviewWindowBuilder::new(
            app_handle,
            "clipboard_overlay",
            tauri::WebviewUrl::App("src/clipboard-overlay/index.html".into()),
        )
        .title("Clipboard")
        .resizable(false)
        .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
        .shadow(true)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .accept_first_mouse(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(true)
        .visible(false);

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let builder = builder.effects(build_clipboard_effects());

        if let Err(e) = builder.build() {
            log::error!("Failed to create clipboard overlay window: {}", e);
        }
    }
}

pub fn show_clipboard_overlay(app_handle: &AppHandle) {
    let transition_token = CLIPBOARD_OVERLAY_TRANSITION_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;

    if app_handle.get_webview_window("clipboard_overlay").is_none() {
        create_clipboard_overlay(app_handle);
    }

    remember_previous_focus_context();

    if let Some(overlay_window) = app_handle.get_webview_window("clipboard_overlay") {
        #[cfg(target_os = "macos")]
        remember_previous_frontmost_app();

        if let Some((x, y)) = calculate_clipboard_overlay_position(app_handle) {
            let _ = overlay_window
                .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let _ = overlay_window.set_effects(build_clipboard_effects());
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(panel) = app_handle.get_webview_panel("clipboard_overlay") {
                let window = overlay_window.clone();
                let panel_for_show = panel.clone();
                let _ = window.run_on_main_thread(move || {
                    panel_for_show.show_and_make_key();
                });
                let _ = overlay_window.emit("clipboard-overlay-show", ());
                let window = overlay_window.clone();
                let panel_for_focus = panel.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(110)).await;
                    if CLIPBOARD_OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token
                    {
                        return;
                    }
                    let _ = window.run_on_main_thread(move || {
                        panel_for_focus.make_key_window();
                    });
                });
                return;
            }
        }

        let _ = overlay_window.show();
        let _ = overlay_window.set_focus();
        let _ = overlay_window.emit("clipboard-overlay-show", ());
        let window = overlay_window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(110)).await;
            if CLIPBOARD_OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token {
                return;
            }
            let _ = window.set_focus();
        });
    }
}

pub fn hide_clipboard_overlay(app_handle: &AppHandle) {
    let transition_token = CLIPBOARD_OVERLAY_TRANSITION_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;

    if let Some(overlay_window) = app_handle.get_webview_window("clipboard_overlay") {
        if let (Ok(position), Ok(scale_factor)) = (
            overlay_window.outer_position(),
            overlay_window.scale_factor(),
        ) {
            let mut app_settings = settings::get_settings(app_handle);
            app_settings.clipboard_overlay_position = Some(settings::WindowPosition {
                x: position.x as f64 / scale_factor,
                y: position.y as f64 / scale_factor,
            });
            settings::write_settings(app_handle, app_settings);
        }

        let _ = overlay_window.emit("clipboard-overlay-hide", ());

        #[cfg(target_os = "macos")]
        {
            if let Ok(panel) = app_handle.get_webview_panel("clipboard_overlay") {
                let panel = panel.clone();
                let window = overlay_window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(62)).await;
                    if CLIPBOARD_OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token
                    {
                        return;
                    }
                    let _ = window.set_effects(None);
                    let _ = window.run_on_main_thread(move || {
                        panel.hide();
                    });
                });
                return;
            }
        }

        let window = overlay_window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(62)).await;
            if CLIPBOARD_OVERLAY_TRANSITION_TOKEN.load(Ordering::SeqCst) != transition_token {
                return;
            }
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                let _ = window.set_effects(None);
            }
            let _ = window.hide();
        });
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(main_window) = app_handle.get_webview_window("main") {
            let main_visible = main_window.is_visible().unwrap_or(false);
            if !main_visible {
                let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        }
    }
}
