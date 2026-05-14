#[cfg(target_os = "macos")]
use crate::actions::ACTION_MAP;
#[cfg(target_os = "macos")]
use crate::managers::audio::AudioRecordingManager;
#[cfg(target_os = "macos")]
use crate::settings;
#[cfg(target_os = "macos")]
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
#[cfg(target_os = "macos")]
use core_graphics::event::CGEventFlags;
#[cfg(target_os = "macos")]
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    CallbackResult, EventField, KeyCode,
};
#[cfg(target_os = "macos")]
use log::{debug, error, info};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
static FN_LISTENER_STATE: AtomicU8 = AtomicU8::new(0);
#[cfg(target_os = "macos")]
static FN_ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static PTT_ENABLED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static FN_PRESSED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static FN_PTT_ACTIVE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static FN_HOLD_STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static NON_MODIFIER_KEYS_DOWN: AtomicU32 = AtomicU32::new(0);
#[cfg(target_os = "macos")]
static LAST_NON_MODIFIER_KEY_EVENT_MS: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
static FN_START_TOKEN: AtomicU32 = AtomicU32::new(0);
#[cfg(target_os = "macos")]
const NON_MODIFIER_STALE_RESET_MS: u64 = 5_000;

#[cfg(target_os = "macos")]
fn is_modifier_keycode(keycode: i64) -> bool {
    matches!(
        keycode as u16,
        KeyCode::COMMAND
            | KeyCode::RIGHT_COMMAND
            | KeyCode::SHIFT
            | KeyCode::RIGHT_SHIFT
            | KeyCode::OPTION
            | KeyCode::RIGHT_OPTION
            | KeyCode::CONTROL
            | KeyCode::RIGHT_CONTROL
            | KeyCode::CAPS_LOCK
            | KeyCode::FUNCTION
    )
}

#[cfg(target_os = "macos")]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn mark_non_modifier_key_down(timestamp_ms: u64) {
    LAST_NON_MODIFIER_KEY_EVENT_MS.store(timestamp_ms, Ordering::Relaxed);
    NON_MODIFIER_KEYS_DOWN.fetch_add(1, Ordering::Relaxed);
}

#[cfg(target_os = "macos")]
fn decrement_non_modifier_keys(timestamp_ms: u64) {
    LAST_NON_MODIFIER_KEY_EVENT_MS.store(timestamp_ms, Ordering::Relaxed);
    let mut current = NON_MODIFIER_KEYS_DOWN.load(Ordering::Relaxed);
    while current > 0 {
        match NON_MODIFIER_KEYS_DOWN.compare_exchange(
            current,
            current - 1,
            Ordering::SeqCst,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(updated) => current = updated,
        }
    }
}

#[cfg(target_os = "macos")]
fn reset_non_modifier_keys(reason: &str) {
    let previous = NON_MODIFIER_KEYS_DOWN.swap(0, Ordering::SeqCst);
    LAST_NON_MODIFIER_KEY_EVENT_MS.store(0, Ordering::Relaxed);
    if previous > 0 {
        debug!(
            "Reset Fn non-modifier key state: reason={} previous_count={}",
            reason, previous
        );
    }
}

#[cfg(target_os = "macos")]
fn take_fn_ptt_active() -> bool {
    FN_PTT_ACTIVE.swap(false, Ordering::Relaxed) || FN_HOLD_STARTED.swap(false, Ordering::Relaxed)
}

#[cfg(target_os = "macos")]
fn non_modifier_keys_down(timestamp_ms: u64) -> bool {
    let count = NON_MODIFIER_KEYS_DOWN.load(Ordering::Relaxed);
    if count == 0 {
        return false;
    }

    let last_event_ms = LAST_NON_MODIFIER_KEY_EVENT_MS.load(Ordering::Relaxed);
    let age_ms = timestamp_ms.saturating_sub(last_event_ms);
    if last_event_ms == 0 || age_ms > NON_MODIFIER_STALE_RESET_MS {
        let previous = NON_MODIFIER_KEYS_DOWN.swap(0, Ordering::SeqCst);
        LAST_NON_MODIFIER_KEY_EVENT_MS.store(0, Ordering::Relaxed);
        if previous > 0 {
            info!(
                "Reset stale Fn non-modifier key state: age_ms={} previous_count={}",
                age_ms, previous
            );
        }
        return false;
    }

    true
}

#[cfg(target_os = "macos")]
fn release_fn_ptt(app_handle: &AppHandle, reason: &str) {
    FN_PRESSED.store(false, Ordering::Relaxed);
    FN_START_TOKEN.fetch_add(1, Ordering::SeqCst);

    let recording_active = app_handle
        .try_state::<Arc<AudioRecordingManager>>()
        .map(|audio| audio.is_recording())
        .unwrap_or(false);
    if take_fn_ptt_active() {
        info!(
            "Fn release: triggering transcribe stop (reason={} recording_active={})",
            reason, recording_active
        );
        if let Some(action) = ACTION_MAP.get("transcribe") {
            action.stop(app_handle, "transcribe", "fn");
        }
    } else {
        debug!(
            "Fn release ignored: no active fn ptt to stop (reason={} recording_active={})",
            reason, recording_active
        );
    }

    reset_non_modifier_keys(reason);
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn clear_non_modifier_state() {
        NON_MODIFIER_KEYS_DOWN.store(0, Ordering::SeqCst);
        LAST_NON_MODIFIER_KEY_EVENT_MS.store(0, Ordering::SeqCst);
    }

    #[test]
    fn non_modifier_state_expires_when_stale() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear_non_modifier_state();

        mark_non_modifier_key_down(1_000);

        assert!(non_modifier_keys_down(1_000 + NON_MODIFIER_STALE_RESET_MS));
        assert!(!non_modifier_keys_down(1_001 + NON_MODIFIER_STALE_RESET_MS));
        assert_eq!(NON_MODIFIER_KEYS_DOWN.load(Ordering::SeqCst), 0);
        assert_eq!(LAST_NON_MODIFIER_KEY_EVENT_MS.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn reset_non_modifier_keys_clears_stuck_count() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear_non_modifier_state();

        mark_non_modifier_key_down(2_000);
        mark_non_modifier_key_down(2_010);

        reset_non_modifier_keys("test");

        assert!(!non_modifier_keys_down(2_020));
        assert_eq!(NON_MODIFIER_KEYS_DOWN.load(Ordering::SeqCst), 0);
        assert_eq!(LAST_NON_MODIFIER_KEY_EVENT_MS.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn decrement_non_modifier_keys_saturates_at_zero() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear_non_modifier_state();

        decrement_non_modifier_keys(3_000);
        assert_eq!(NON_MODIFIER_KEYS_DOWN.load(Ordering::SeqCst), 0);

        mark_non_modifier_key_down(3_010);
        decrement_non_modifier_keys(3_020);
        assert_eq!(NON_MODIFIER_KEYS_DOWN.load(Ordering::SeqCst), 0);
        assert_eq!(LAST_NON_MODIFIER_KEY_EVENT_MS.load(Ordering::SeqCst), 3_020);
    }
}

#[cfg(target_os = "macos")]
pub fn set_fn_key_enabled(enabled: bool) {
    FN_ENABLED.store(enabled, Ordering::Relaxed);
}

#[cfg(target_os = "macos")]
pub fn set_ptt_enabled(enabled: bool) {
    PTT_ENABLED.store(enabled, Ordering::Relaxed);
}

#[cfg(target_os = "macos")]
fn ensure_listener_started(app: &AppHandle) {
    let state = FN_LISTENER_STATE.load(Ordering::Relaxed);
    if state != 0 {
        return;
    }

    if FN_LISTENER_STATE
        .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let make_event_tap = |location: CGEventTapLocation| {
            let app_handle = app_handle.clone();
            CGEventTap::new(
                location,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![
                    CGEventType::FlagsChanged,
                    CGEventType::KeyDown,
                    CGEventType::KeyUp,
                ],
                move |_proxy, event_type, event| match event_type {
                    CGEventType::KeyDown => {
                        let is_autorepeat = event
                            .get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT)
                            != 0;
                        if is_autorepeat {
                            return CallbackResult::Keep;
                        }

                        let keycode =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        if is_modifier_keycode(keycode) {
                            return CallbackResult::Keep;
                        }

                        mark_non_modifier_key_down(now_ms());
                        if FN_PRESSED.load(Ordering::Relaxed) {
                            FN_START_TOKEN.fetch_add(1, Ordering::SeqCst);
                            let recording_active = app_handle
                                .try_state::<Arc<AudioRecordingManager>>()
                                .map(|audio| audio.is_recording())
                                .unwrap_or(false);
                            if take_fn_ptt_active() {
                                if let Some(action) = ACTION_MAP.get("transcribe") {
                                    action.stop(&app_handle, "transcribe", "fn");
                                }
                            } else {
                                debug!(
                                    "Fn key combo ignored: no active fn ptt to stop (recording_active={})",
                                    recording_active
                                );
                            }
                        }

                        return CallbackResult::Keep;
                    }
                    CGEventType::KeyUp => {
                        let is_autorepeat = event
                            .get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT)
                            != 0;
                        if is_autorepeat {
                            return CallbackResult::Keep;
                        }

                        let keycode =
                            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        if keycode as u16 == KeyCode::FUNCTION {
                            // Backup release handler: some macOS builds can miss FlagsChanged release events.
                            release_fn_ptt(&app_handle, "fn keyup");
                            return CallbackResult::Keep;
                        }

                        if is_modifier_keycode(keycode) {
                            return CallbackResult::Keep;
                        }

                        decrement_non_modifier_keys(now_ms());
                        return CallbackResult::Keep;
                    }
                    CGEventType::FlagsChanged => {
                        let flags = event.get_flags();
                        let fn_now = flags.contains(CGEventFlags::CGEventFlagSecondaryFn);
                        let was_pressed = FN_PRESSED.swap(fn_now, Ordering::Relaxed);
                        let other_modifiers = flags.intersects(
                            CGEventFlags::CGEventFlagAlphaShift
                                | CGEventFlags::CGEventFlagShift
                                | CGEventFlags::CGEventFlagControl
                                | CGEventFlags::CGEventFlagAlternate
                                | CGEventFlags::CGEventFlagCommand
                                | CGEventFlags::CGEventFlagHelp,
                        );

                        if fn_now && other_modifiers {
                            FN_START_TOKEN.fetch_add(1, Ordering::SeqCst);
                            let recording_active = app_handle
                                .try_state::<Arc<AudioRecordingManager>>()
                                .map(|audio| audio.is_recording())
                                .unwrap_or(false);
                            if take_fn_ptt_active() {
                                if let Some(action) = ACTION_MAP.get("transcribe") {
                                    action.stop(&app_handle, "transcribe", "fn");
                                }
                            } else {
                                debug!(
                                    "Fn modifier combo ignored: no active fn ptt to stop (recording_active={})",
                                    recording_active
                                );
                            }
                        }

                        if fn_now == was_pressed {
                            return CallbackResult::Keep;
                        }

                        debug!(
                            "Fn flags changed: fn_now={} was_pressed={} other_modifiers={} non_modifier_keys_down={} fn_enabled={}",
                            fn_now,
                            was_pressed,
                            other_modifiers,
                            NON_MODIFIER_KEYS_DOWN.load(Ordering::Relaxed),
                            FN_ENABLED.load(Ordering::Relaxed)
                        );

                        if !fn_now {
                            release_fn_ptt(&app_handle, "fn release");
                            return CallbackResult::Keep;
                        }

                        if !PTT_ENABLED.load(Ordering::Relaxed) {
                            info!("Fn ignored: push_to_talk is disabled");
                            return CallbackResult::Keep;
                        }

                        if !FN_ENABLED.load(Ordering::Relaxed) {
                            info!("Fn ignored: fn_key_ptt is disabled");
                            return CallbackResult::Keep;
                        }

                        if ACTION_MAP.contains_key("transcribe") {
                            let other_keys_down = non_modifier_keys_down(now_ms());
                            if other_modifiers || other_keys_down {
                                info!(
                                    "Fn start blocked: other_modifiers={} other_keys_down={}",
                                    other_modifiers, other_keys_down
                                );
                                FN_START_TOKEN.fetch_add(1, Ordering::SeqCst);
                                return CallbackResult::Keep;
                            }
                            let start_token = FN_START_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
                            let app_handle = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(20)).await;
                                if FN_START_TOKEN.load(Ordering::SeqCst) != start_token {
                                    return;
                                }
                                if !FN_PRESSED.load(Ordering::Relaxed) {
                                    return;
                                }
                                if non_modifier_keys_down(now_ms()) {
                                    return;
                                }
                                if !FN_ENABLED.load(Ordering::Relaxed) {
                                    return;
                                }
                                if let Some(action) = ACTION_MAP.get("transcribe") {
                                    info!("Fn start accepted: triggering transcribe start");
                                    FN_HOLD_STARTED.store(true, Ordering::Relaxed);
                                    FN_PTT_ACTIVE.store(true, Ordering::Relaxed);
                                    action.start(&app_handle, "transcribe", "fn");
                                }
                            });
                        }

                        CallbackResult::Keep
                    }
                    _ => CallbackResult::Keep,
                },
            )
        };

        let event_tap = match make_event_tap(CGEventTapLocation::HID) {
            Ok(tap) => tap,
            Err(_) => {
                error!("Failed to create HID event tap for Fn key, retrying with Session tap.");
                match make_event_tap(CGEventTapLocation::Session) {
                    Ok(tap) => tap,
                    Err(_) => {
                        error!(
                            "Failed to create Fn key event tap. Input Monitoring permission is required."
                        );
                        FN_LISTENER_STATE.store(0, Ordering::SeqCst);
                        return;
                    }
                }
            }
        };

        let loop_source = match event_tap.mach_port().create_runloop_source(0) {
            Ok(source) => source,
            Err(_) => {
                error!("Failed to create Fn key event tap runloop source.");
                FN_LISTENER_STATE.store(0, Ordering::SeqCst);
                return;
            }
        };

        CFRunLoop::get_current().add_source(&loop_source, unsafe { kCFRunLoopCommonModes });
        event_tap.enable();
        info!("Fn key event tap enabled");
        FN_LISTENER_STATE.store(2, Ordering::SeqCst);
        CFRunLoop::run_current();
        FN_LISTENER_STATE.store(0, Ordering::SeqCst);
    });
}

#[cfg(target_os = "macos")]
pub fn init(app: &AppHandle) {
    let settings = settings::get_settings(app);
    set_fn_key_enabled(settings.fn_key_ptt_enabled);
    set_ptt_enabled(settings.push_to_talk);
    ensure_listener_started(app);
}

#[cfg(target_os = "macos")]
pub fn ensure_started(app: &AppHandle) {
    ensure_listener_started(app);
}
