use crate::focus_context::FocusContext;
use crate::input::{self, EnigoState};
use crate::input_focus;
use crate::managers::clipboard_history::ClipboardHistoryManager;
use crate::managers::insertion::{make_transaction, InsertionManager};
use crate::settings::{get_settings, PasteMethod};
use enigo::Enigo;
use log::{info, warn};
use std::sync::Arc;
use tauri::{image::Image, AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[cfg(target_os = "linux")]
use crate::utils::is_wayland;
#[cfg(target_os = "linux")]
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteOutcome {
    Pasted,
    ClipboardOnly,
}

fn record_clipboard_activity(app_handle: &AppHandle) {
    if let Some(manager) = app_handle.try_state::<Arc<ClipboardHistoryManager>>() {
        manager.record_activity_now();
    }
}

fn copy_prepared_text_to_clipboard(text: &str, app_handle: &AppHandle) -> Result<(), String> {
    app_handle
        .clipboard()
        .write_text(text)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;
    record_clipboard_activity(app_handle);
    Ok(())
}

pub fn copy_text_to_clipboard(text: String, app_handle: AppHandle) -> Result<PasteOutcome, String> {
    let settings = get_settings(&app_handle);
    let text = if settings.append_trailing_space {
        format!("{} ", text)
    } else {
        text
    };

    copy_prepared_text_to_clipboard(&text, &app_handle)?;
    Ok(PasteOutcome::ClipboardOnly)
}

fn is_own_app_context(context: &FocusContext) -> bool {
    let id_matches = context
        .app_identifier
        .as_deref()
        .map(|id| id.starts_with("com.pais.breeze"))
        .unwrap_or(false);
    if id_matches {
        return true;
    }

    context
        .app_name
        .as_deref()
        .map(|name| name.eq_ignore_ascii_case("breeze") || name.eq_ignore_ascii_case("breezetype"))
        .unwrap_or(false)
}

fn choose_focus_context(
    expected: Option<FocusContext>,
    live: Option<FocusContext>,
) -> Option<FocusContext> {
    match live {
        Some(live_context) => {
            if !is_own_app_context(&live_context) {
                return Some(live_context);
            }
            expected.or(Some(live_context))
        }
        None => expected,
    }
}

#[cfg(test)]
mod tests {
    use super::{choose_focus_context, FocusContext};

    fn context(app_identifier: Option<&str>, app_name: Option<&str>) -> FocusContext {
        FocusContext {
            app_name: app_name.map(|s| s.to_string()),
            app_identifier: app_identifier.map(|s| s.to_string()),
            window_title: None,
            process_id: None,
            browser_tab_title: None,
            browser_tab_url: None,
        }
    }

    #[test]
    fn prefers_live_context_when_not_own_app() {
        let expected = Some(context(Some("com.openai.codex"), Some("Codex")));
        let live = Some(context(Some("com.apple.finder"), Some("Finder")));
        let chosen = choose_focus_context(expected, live).unwrap();
        assert_eq!(chosen.app_identifier.as_deref(), Some("com.apple.finder"));
    }

    #[test]
    fn prefers_expected_context_when_live_is_own_app() {
        let expected = Some(context(Some("com.openai.codex"), Some("Codex")));
        let live = Some(context(Some("com.pais.breeze.dev"), Some("BreezeType")));
        let chosen = choose_focus_context(expected, live).unwrap();
        assert_eq!(chosen.app_identifier.as_deref(), Some("com.openai.codex"));
    }

    #[test]
    fn keeps_live_context_when_own_app_and_no_expected_context() {
        let live = Some(context(Some("com.pais.breeze.dev"), Some("BreezeType")));
        let chosen = choose_focus_context(None, live).unwrap();
        assert_eq!(
            chosen.app_identifier.as_deref(),
            Some("com.pais.breeze.dev")
        );
    }
}

/// Pastes text using the clipboard: saves current content, writes text, sends paste keystroke, restores clipboard.
fn paste_via_clipboard(
    enigo: &mut Enigo,
    text: &str,
    app_handle: &AppHandle,
    paste_method: &PasteMethod,
) -> Result<(), String> {
    let clipboard = app_handle.clipboard();
    let clipboard_content = clipboard.read_text().unwrap_or_default();

    // Write text to clipboard first
    clipboard
        .write_text(text)
        .map_err(|e| format!("Failed to write to clipboard: {}", e))?;

    std::thread::sleep(std::time::Duration::from_millis(50));

    // Send paste key combo
    #[cfg(target_os = "linux")]
    let key_combo_sent = try_send_key_combo_linux(paste_method)?;

    #[cfg(not(target_os = "linux"))]
    let key_combo_sent = false;

    // Fall back to enigo if no native tool handled it
    if !key_combo_sent {
        match paste_method {
            PasteMethod::CtrlV => input::send_paste_ctrl_v(enigo)?,
            PasteMethod::CtrlShiftV => input::send_paste_ctrl_shift_v(enigo)?,
            PasteMethod::ShiftInsert => input::send_paste_shift_insert(enigo)?,
            _ => return Err("Invalid paste method for clipboard paste".into()),
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(50));

    // Restore original clipboard content
    clipboard
        .write_text(&clipboard_content)
        .map_err(|e| format!("Failed to restore clipboard: {}", e))?;
    record_clipboard_activity(app_handle);

    Ok(())
}

/// Attempts to send a key combination using Linux-native tools.
/// Returns `Ok(true)` if a native tool handled it, `Ok(false)` to fall back to enigo.
#[cfg(target_os = "linux")]
fn try_send_key_combo_linux(paste_method: &PasteMethod) -> Result<bool, String> {
    if is_wayland() {
        // Wayland: prefer wtype, then dotool
        if is_wtype_available() {
            info!("Using wtype for key combo");
            send_key_combo_via_wtype(paste_method)?;
            return Ok(true);
        }
        if is_dotool_available() {
            info!("Using dotool for key combo");
            send_key_combo_via_dotool(paste_method)?;
            return Ok(true);
        }
    } else {
        // X11: prefer xdotool
        if is_xdotool_available() {
            info!("Using xdotool for key combo");
            send_key_combo_via_xdotool(paste_method)?;
            return Ok(true);
        }
    }

    Ok(false)
}

/// Attempts to type text directly using Linux-native tools.
/// Returns `Ok(true)` if a native tool handled it, `Ok(false)` to fall back to enigo.
#[cfg(target_os = "linux")]
fn try_direct_typing_linux(text: &str) -> Result<bool, String> {
    if is_wayland() {
        // Wayland: prefer wtype, then dotool
        if is_wtype_available() {
            info!("Using wtype for direct text input");
            type_text_via_wtype(text)?;
            return Ok(true);
        }
        if is_dotool_available() {
            info!("Using dotool for direct text input");
            type_text_via_dotool(text)?;
            return Ok(true);
        }
    } else {
        // X11: prefer xdotool
        if is_xdotool_available() {
            info!("Using xdotool for direct text input");
            type_text_via_xdotool(text)?;
            return Ok(true);
        }
    }

    Ok(false)
}

/// Check if wtype is available (Wayland text input tool)
#[cfg(target_os = "linux")]
fn is_wtype_available() -> bool {
    Command::new("which")
        .arg("wtype")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Check if dotool is available (another Wayland text input tool)
#[cfg(target_os = "linux")]
fn is_dotool_available() -> bool {
    Command::new("which")
        .arg("dotool")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn is_xdotool_available() -> bool {
    Command::new("which")
        .arg("xdotool")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Type text directly via wtype on Wayland.
#[cfg(target_os = "linux")]
fn type_text_via_wtype(text: &str) -> Result<(), String> {
    let output = Command::new("wtype")
        .arg("--") // Protect against text starting with -
        .arg(text)
        .output()
        .map_err(|e| format!("Failed to execute wtype: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("wtype failed: {}", stderr));
    }

    Ok(())
}

/// Type text directly via xdotool on X11.
#[cfg(target_os = "linux")]
fn type_text_via_xdotool(text: &str) -> Result<(), String> {
    let output = Command::new("xdotool")
        .arg("type")
        .arg("--clearmodifiers")
        .arg("--")
        .arg(text)
        .output()
        .map_err(|e| format!("Failed to execute xdotool: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("xdotool failed: {}", stderr));
    }

    Ok(())
}

/// Type text directly via dotool (works on both Wayland and X11 via uinput).
#[cfg(target_os = "linux")]
fn type_text_via_dotool(text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = Command::new("dotool")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn dotool: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        // dotool uses "type <text>" command
        writeln!(stdin, "type {}", text)
            .map_err(|e| format!("Failed to write to dotool stdin: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for dotool: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("dotool failed: {}", stderr));
    }

    Ok(())
}

/// Send a key combination (e.g., Ctrl+V) via wtype on Wayland.
#[cfg(target_os = "linux")]
fn send_key_combo_via_wtype(paste_method: &PasteMethod) -> Result<(), String> {
    let args: Vec<&str> = match paste_method {
        PasteMethod::CtrlV => vec!["-M", "ctrl", "-k", "v"],
        PasteMethod::ShiftInsert => vec!["-M", "shift", "-k", "Insert"],
        PasteMethod::CtrlShiftV => vec!["-M", "ctrl", "-M", "shift", "-k", "v"],
        _ => return Err("Unsupported paste method".into()),
    };

    let output = Command::new("wtype")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute wtype: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("wtype failed: {}", stderr));
    }

    Ok(())
}

/// Send a key combination (e.g., Ctrl+V) via dotool.
#[cfg(target_os = "linux")]
fn send_key_combo_via_dotool(paste_method: &PasteMethod) -> Result<(), String> {
    let command;
    match paste_method {
        PasteMethod::CtrlV => command = "echo key ctrl+v | dotool",
        PasteMethod::ShiftInsert => command = "echo key shift+insert | dotool",
        PasteMethod::CtrlShiftV => command = "echo key ctrl+shift+v | dotool",
        _ => return Err("Unsupported paste method".into()),
    }
    let output = Command::new("sh")
        .arg("-c")
        .arg(command)
        .output()
        .map_err(|e| format!("Failed to execute dotool: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("dotool failed: {}", stderr));
    }

    Ok(())
}

/// Send a key combination (e.g., Ctrl+V) via xdotool on X11.
#[cfg(target_os = "linux")]
fn send_key_combo_via_xdotool(paste_method: &PasteMethod) -> Result<(), String> {
    let key_combo = match paste_method {
        PasteMethod::CtrlV => "ctrl+v",
        PasteMethod::CtrlShiftV => "ctrl+shift+v",
        PasteMethod::ShiftInsert => "shift+Insert",
        _ => return Err("Unsupported paste method".into()),
    };

    let output = Command::new("xdotool")
        .arg("key")
        .arg("--clearmodifiers")
        .arg(key_combo)
        .output()
        .map_err(|e| format!("Failed to execute xdotool: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("xdotool failed: {}", stderr));
    }

    Ok(())
}

/// Types text directly by simulating individual key presses.
fn paste_direct(enigo: &mut Enigo, text: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if try_direct_typing_linux(text)? {
            return Ok(());
        }
        info!("Falling back to enigo for direct text input");
    }

    input::paste_text_direct(enigo, text)
}

pub fn paste(text: String, app_handle: AppHandle) -> Result<PasteOutcome, String> {
    paste_with_focus_context(text, app_handle, None)
}

pub fn paste_with_focus_context(
    text: String,
    app_handle: AppHandle,
    expected_focus_context: Option<crate::focus_context::FocusContext>,
) -> Result<PasteOutcome, String> {
    let settings = get_settings(&app_handle);
    let paste_method = settings.paste_method;

    // Append trailing space if setting is enabled
    let text = if settings.append_trailing_space {
        format!("{} ", text)
    } else {
        text
    };

    info!("Using paste method: {:?}", paste_method);

    if paste_method == PasteMethod::None {
        copy_prepared_text_to_clipboard(&text, &app_handle)?;
        return Ok(PasteOutcome::ClipboardOnly);
    }

    let focus_context = choose_focus_context(
        expected_focus_context,
        crate::focus_context::get_active_context(),
    );

    #[cfg(target_os = "macos")]
    let focus_state = input_focus::focused_text_input_state_for_process(
        focus_context
            .as_ref()
            .and_then(|context| context.process_id),
    );
    #[cfg(target_os = "macos")]
    let focus_pid = focus_context
        .as_ref()
        .and_then(|context| context.process_id);
    #[cfg(target_os = "macos")]
    let frontmost_pid = crate::focus_context::frontmost_process_id();
    #[cfg(target_os = "macos")]
    let target_is_frontmost = match (focus_pid, frontmost_pid) {
        (Some(target), Some(frontmost)) => target == frontmost,
        _ => true,
    };
    #[cfg(target_os = "macos")]
    let has_focus =
        focus_state == input_focus::FocusDetectionState::TextInput && target_is_frontmost;
    #[cfg(not(target_os = "macos"))]
    let has_focus = true;

    #[cfg(target_os = "macos")]
    {
        let app_label = focus_context
            .as_ref()
            .and_then(|context| {
                context
                    .app_identifier
                    .clone()
                    .or_else(|| context.app_name.clone())
            })
            .unwrap_or_else(|| "unknown app".to_string());
        let app_pid = focus_context
            .as_ref()
            .and_then(|context| context.process_id);
        info!(
            "Paste focus decision: app={} pid={:?} frontmost_pid={:?} target_is_frontmost={} state={:?}",
            app_label, app_pid, frontmost_pid, target_is_frontmost, focus_state
        );
    }

    if !has_focus {
        #[cfg(target_os = "macos")]
        let allow_compat_paste_when_ax_unavailable = {
            let app_id = focus_context
                .as_ref()
                .and_then(|context| context.app_identifier.as_deref());
            focus_state == input_focus::FocusDetectionState::Unavailable
                && matches!(app_id, Some("com.openai.codex") | Some("com.hnc.Discord"))
        };
        #[cfg(not(target_os = "macos"))]
        let allow_compat_paste_when_ax_unavailable = false;

        let app_label = focus_context
            .as_ref()
            .and_then(|context| {
                context
                    .app_identifier
                    .clone()
                    .or_else(|| context.app_name.clone())
            })
            .unwrap_or_else(|| "unknown app".to_string());
        if allow_compat_paste_when_ax_unavailable {
            warn!(
                "AX focus is unavailable for {}. Attempting in-place paste via compatibility fallback.",
                app_label
            );
        } else {
            warn!(
                "No focused text input detected via Accessibility heuristics for {}. Copying to clipboard instead of pasting.",
                app_label
            );
            copy_prepared_text_to_clipboard(&text, &app_handle)?;
            return Ok(PasteOutcome::ClipboardOnly);
        }
    }

    // Get the managed Enigo instance
    let enigo_state = match app_handle.try_state::<EnigoState>() {
        Some(state) => state,
        None => {
            warn!("Enigo state not initialized. Falling back to clipboard.");
            copy_prepared_text_to_clipboard(&text, &app_handle)?;
            return Ok(PasteOutcome::ClipboardOnly);
        }
    };
    let mut enigo = match enigo_state.0.lock() {
        Ok(enigo) => enigo,
        Err(e) => {
            warn!("Failed to lock Enigo ({}). Falling back to clipboard.", e);
            copy_prepared_text_to_clipboard(&text, &app_handle)?;
            return Ok(PasteOutcome::ClipboardOnly);
        }
    };
    if enigo.is_none() {
        match input::create_enigo() {
            Ok(created) => {
                *enigo = Some(created);
            }
            Err(err) => {
                warn!(
                    "Failed to initialize Enigo ({}). Falling back to clipboard.",
                    err
                );
                copy_prepared_text_to_clipboard(&text, &app_handle)?;
                return Ok(PasteOutcome::ClipboardOnly);
            }
        }
    }
    let Some(enigo) = enigo.as_mut() else {
        warn!("Enigo state not initialized. Falling back to clipboard.");
        copy_prepared_text_to_clipboard(&text, &app_handle)?;
        return Ok(PasteOutcome::ClipboardOnly);
    };

    // Perform the paste operation
    let paste_result = match paste_method {
        PasteMethod::Direct => paste_direct(enigo, &text),
        PasteMethod::CtrlV | PasteMethod::CtrlShiftV | PasteMethod::ShiftInsert => {
            paste_via_clipboard(enigo, &text, &app_handle, &paste_method)
        }
        PasteMethod::None => Ok(()),
    };

    if let Err(err) = paste_result {
        warn!("Paste failed ({}). Falling back to clipboard.", err);
        copy_prepared_text_to_clipboard(&text, &app_handle)?;
        return Ok(PasteOutcome::ClipboardOnly);
    }

    // Record insertion for undo/transaction history
    if let Some(manager) = app_handle.try_state::<Arc<InsertionManager>>() {
        manager.record(make_transaction(text.clone(), paste_method, focus_context));
    }

    Ok(PasteOutcome::Pasted)
}

/// Paste a clipboard history entry without restoring prior clipboard contents.
/// This preserves the selected entry as the current clipboard value.
pub fn paste_clipboard_history(text: String, app_handle: AppHandle) -> Result<(), String> {
    let settings = get_settings(&app_handle);
    let paste_method = settings.paste_method;

    // Always set clipboard to the selected entry.
    let clipboard = app_handle.clipboard();
    clipboard
        .write_text(&text)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;
    record_clipboard_activity(&app_handle);

    if paste_method == PasteMethod::None {
        return Ok(());
    }

    // Get the managed Enigo instance
    let enigo_state = app_handle
        .try_state::<EnigoState>()
        .ok_or("Enigo state not initialized")?;
    let mut enigo = enigo_state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock Enigo: {}", e))?;
    if enigo.is_none() {
        *enigo = Some(input::create_enigo()?);
    }
    let enigo = enigo.as_mut().ok_or("Enigo state not initialized")?;

    match paste_method {
        PasteMethod::Direct => {
            paste_direct(enigo, &text)?;
        }
        PasteMethod::CtrlV | PasteMethod::CtrlShiftV | PasteMethod::ShiftInsert => {
            std::thread::sleep(std::time::Duration::from_millis(40));
            #[cfg(target_os = "linux")]
            let key_combo_sent = try_send_key_combo_linux(&paste_method)?;

            #[cfg(not(target_os = "linux"))]
            let key_combo_sent = false;

            if !key_combo_sent {
                match paste_method {
                    PasteMethod::CtrlV => input::send_paste_ctrl_v(enigo)?,
                    PasteMethod::CtrlShiftV => input::send_paste_ctrl_shift_v(enigo)?,
                    PasteMethod::ShiftInsert => input::send_paste_shift_insert(enigo)?,
                    _ => {}
                }
            }
        }
        PasteMethod::None => {}
    }

    Ok(())
}

/// Paste a clipboard history image without restoring prior clipboard contents.
/// Direct text insertion cannot apply to images, so the direct mode falls back to Cmd/Ctrl+V.
pub fn paste_clipboard_history_image(
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    app_handle: AppHandle,
) -> Result<(), String> {
    let settings = get_settings(&app_handle);
    let paste_method = settings.paste_method;
    let clipboard = app_handle.clipboard();
    let image = Image::new_owned(rgba, width, height);

    clipboard
        .write_image(&image)
        .map_err(|e| format!("Failed to copy image to clipboard: {}", e))?;
    record_clipboard_activity(&app_handle);

    if paste_method == PasteMethod::None {
        return Ok(());
    }

    let enigo_state = app_handle
        .try_state::<EnigoState>()
        .ok_or("Enigo state not initialized")?;
    let mut enigo = enigo_state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock Enigo: {}", e))?;
    if enigo.is_none() {
        *enigo = Some(input::create_enigo()?);
    }
    let enigo = enigo.as_mut().ok_or("Enigo state not initialized")?;

    std::thread::sleep(std::time::Duration::from_millis(40));

    #[cfg(target_os = "linux")]
    let key_combo_sent = try_send_key_combo_linux(&PasteMethod::CtrlV)?;

    #[cfg(not(target_os = "linux"))]
    let key_combo_sent = false;

    if !key_combo_sent {
        input::send_paste_ctrl_v(enigo)?;
    }

    Ok(())
}
