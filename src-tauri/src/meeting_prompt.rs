use crate::input;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

const PROMPT_WIDTH: f64 = 320.0;
const PROMPT_HEIGHT: f64 = 96.0;

#[cfg(target_os = "macos")]
const PROMPT_TOP_OFFSET: f64 = 56.0;

#[cfg(any(target_os = "windows", target_os = "linux"))]
const PROMPT_TOP_OFFSET: f64 = 14.0;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeetingPromptPayload {
    pub source: String,
    pub detail: Option<String>,
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

fn calculate_prompt_position(app_handle: &AppHandle) -> Option<(f64, f64)> {
    let monitor = get_monitor_with_cursor(app_handle)?;
    let work_area = monitor.work_area();
    let scale = monitor.scale_factor();
    let work_area_width = work_area.size.width as f64 / scale;
    let work_area_x = work_area.position.x as f64 / scale;
    let work_area_y = work_area.position.y as f64 / scale;

    let x = work_area_x + (work_area_width - PROMPT_WIDTH) / 2.0;
    let y = work_area_y + PROMPT_TOP_OFFSET;

    Some((x, y))
}

pub fn create_meeting_prompt_overlay(app_handle: &AppHandle) {
    if app_handle.get_webview_window("meeting_prompt").is_some() {
        return;
    }

    if let Some((x, y)) = calculate_prompt_position(app_handle) {
        let builder = WebviewWindowBuilder::new(
            app_handle,
            "meeting_prompt",
            WebviewUrl::App("src/meeting-prompt/index.html".into()),
        )
        .title("Meeting prompt")
        .position(x, y)
        .resizable(false)
        .inner_size(PROMPT_WIDTH, PROMPT_HEIGHT)
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

        if let Err(e) = builder.build() {
            log::error!("Failed to create meeting prompt window: {}", e);
        }
    }
}

pub fn show_meeting_prompt(app_handle: &AppHandle, payload: MeetingPromptPayload) {
    if app_handle.get_webview_window("meeting_prompt").is_none() {
        create_meeting_prompt_overlay(app_handle);
    }

    if let Some(window) = app_handle.get_webview_window("meeting_prompt") {
        if let Some((x, y)) = calculate_prompt_position(app_handle) {
            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }

        let _ = window.show();
        let _ = window.emit("meeting-prompt-show", payload);
    }
}

pub fn hide_meeting_prompt(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("meeting_prompt") {
        let _ = window.emit("meeting-prompt-hide", ());
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(160)).await;
            let _ = window.hide();
        });
    }
}
