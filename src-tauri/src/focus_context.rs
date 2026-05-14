use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct FocusContext {
    pub app_name: Option<String>,
    pub app_identifier: Option<String>,
    pub window_title: Option<String>,
    pub process_id: Option<i64>,
    pub browser_tab_title: Option<String>,
    pub browser_tab_url: Option<String>,
}

pub fn get_active_context() -> Option<FocusContext> {
    #[cfg(target_os = "macos")]
    {
        return macos::get_active_context();
    }

    #[cfg(target_os = "windows")]
    {
        return windows::get_active_context();
    }

    #[cfg(target_os = "linux")]
    {
        return linux::get_active_context();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

pub fn frontmost_process_id() -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        return macos::frontmost_process_id();
    }

    #[cfg(target_os = "windows")]
    {
        return windows::frontmost_process_id();
    }

    #[cfg(target_os = "linux")]
    {
        return linux::frontmost_process_id();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::FocusContext;
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowOwnerName, kCGWindowOwnerPID,
    };
    use log::info;
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};
    use std::ffi::c_void;
    use std::process::Command;

    pub fn get_active_context() -> Option<FocusContext> {
        let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
        let array = copy_window_info(options, kCGNullWindowID)?;
        let array: CFArray<CFDictionary<*const c_void, *const c_void>> =
            unsafe { CFArray::wrap_under_get_rule(array.as_concrete_TypeRef()) };

        let our_pid = std::process::id() as i64;
        let frontmost_pid = frontmost_app_pid();

        if let Some(frontmost_pid) = frontmost_pid {
            if let Some(context) = find_context(&array, our_pid, Some(frontmost_pid)) {
                return Some(context);
            }
            return context_from_pid(frontmost_pid);
        }

        find_context(&array, our_pid, None)
    }

    fn find_context(
        array: &CFArray<CFDictionary<*const c_void, *const c_void>>,
        our_pid: i64,
        pid_filter: Option<i64>,
    ) -> Option<FocusContext> {
        for dict_ref in array.iter() {
            let dict: CFDictionary<*const c_void, *const c_void> =
                unsafe { CFDictionary::wrap_under_get_rule(dict_ref.as_concrete_TypeRef()) };

            if let Some(layer) = number_from_dict(&dict, unsafe { kCGWindowLayer }) {
                if layer != 0 {
                    continue;
                }
            }

            let pid = number_from_dict(&dict, unsafe { kCGWindowOwnerPID });
            if pid == Some(our_pid) {
                continue;
            }
            if let Some(filter) = pid_filter {
                if pid != Some(filter) {
                    continue;
                }
            }

            let mut app_name = string_from_dict(&dict, unsafe { kCGWindowOwnerName });
            let (localized_name, bundle_id) =
                pid.and_then(running_app_info).unwrap_or((None, None));
            if let Some(name) = localized_name {
                app_name = Some(name);
            }
            if app_name.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
                continue;
            }

            let window_title = string_from_dict(&dict, unsafe { kCGWindowName });

            let mut context = FocusContext {
                app_name,
                app_identifier: bundle_id,
                window_title,
                process_id: pid,
                browser_tab_title: None,
                browser_tab_url: None,
            };

            if let Some(bundle_id) = context.app_identifier.as_deref() {
                if let Some((title, url)) = get_browser_tab_info(bundle_id) {
                    context.browser_tab_title = Some(title.clone());
                    context.browser_tab_url = Some(url.clone());
                    let app_label = context
                        .app_name
                        .as_deref()
                        .or(context.app_identifier.as_deref())
                        .unwrap_or("Unknown");
                    info!(
                        "Active browser context: app='{}' title='{}' url='{}'",
                        app_label, title, url
                    );
                }
            }

            return Some(context);
        }

        None
    }

    fn frontmost_app_pid() -> Option<i64> {
        autoreleasepool(|_pool| {
            let workspace = NSWorkspace::sharedWorkspace();
            let app = workspace.frontmostApplication()?;
            Some(app.processIdentifier() as i64)
        })
    }

    pub fn frontmost_process_id() -> Option<i64> {
        frontmost_app_pid()
    }

    fn string_from_dict(
        dict: &CFDictionary<*const c_void, *const c_void>,
        key: CFStringRef,
    ) -> Option<String> {
        let value = dict.find(key as *const c_void)?;
        let cf_type = unsafe { CFType::wrap_under_get_rule(*value as CFTypeRef) };
        let cf_string = cf_type.downcast::<CFString>()?;
        Some(cf_string.to_string())
    }

    fn number_from_dict(
        dict: &CFDictionary<*const c_void, *const c_void>,
        key: CFStringRef,
    ) -> Option<i64> {
        let value = dict.find(key as *const c_void)?;
        let cf_type = unsafe { CFType::wrap_under_get_rule(*value as CFTypeRef) };
        let cf_number = cf_type.downcast::<CFNumber>()?;
        cf_number.to_i64()
    }

    fn running_app_info(pid: i64) -> Option<(Option<String>, Option<String>)> {
        autoreleasepool(|_pool| {
            let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as _)?;
            let localized_name = app.localizedName().map(|s| s.to_string());
            let bundle_id = app.bundleIdentifier().map(|s| s.to_string());
            Some((localized_name, bundle_id))
        })
    }

    fn context_from_pid(pid: i64) -> Option<FocusContext> {
        let (app_name, app_identifier) = running_app_info(pid)?;
        Some(FocusContext {
            app_name,
            app_identifier,
            window_title: None,
            process_id: Some(pid),
            browser_tab_title: None,
            browser_tab_url: None,
        })
    }

    fn get_browser_tab_info(bundle_id: &str) -> Option<(String, String)> {
        #[derive(Clone, Copy)]
        enum ScriptKind {
            Chromium,
            Safari,
        }

        let (app_name, script_kind) = match bundle_id {
            "com.google.Chrome" => ("Google Chrome", ScriptKind::Chromium),
            "com.google.Chrome.canary" => ("Google Chrome Canary", ScriptKind::Chromium),
            "org.chromium.Chromium" => ("Chromium", ScriptKind::Chromium),
            "com.microsoft.Edge" => ("Microsoft Edge", ScriptKind::Chromium),
            "com.brave.Browser" => ("Brave Browser", ScriptKind::Chromium),
            "com.apple.Safari" => ("Safari", ScriptKind::Safari),
            _ => return None,
        };

        let script = match script_kind {
            ScriptKind::Chromium => format!(
                r#"tell application "{}"
if (count of windows) = 0 then return ""
set theTab to active tab of front window
return (title of theTab) & "|||" & (URL of theTab)
end tell"#,
                app_name
            ),
            ScriptKind::Safari => r#"tell application "Safari"
if (count of windows) = 0 then return ""
set theTab to current tab of front window
return (name of theTab) & "|||" & (URL of theTab)
end tell"#
                .to_string(),
        };

        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let raw = String::from_utf8_lossy(&output.stdout);
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let mut parts = trimmed.splitn(2, "|||");
        let title = parts.next().unwrap_or("").trim().to_string();
        let url = parts.next().unwrap_or("").trim().to_string();

        if title.is_empty() && url.is_empty() {
            None
        } else {
            Some((title, url))
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::FocusContext;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::Path;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    pub fn get_active_context() -> Option<FocusContext> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd == HWND(0) {
            return None;
        }

        let window_title = get_window_title(hwnd);
        let pid = get_window_pid(hwnd);
        let app_identifier = pid.and_then(get_process_image_path);
        let app_name = app_identifier
            .as_ref()
            .and_then(|path| Path::new(path).file_stem())
            .map(|stem| stem.to_string_lossy().to_string())
            .or_else(|| pid.map(|p| format!("pid-{}", p)));

        Some(FocusContext {
            app_name,
            app_identifier,
            window_title,
            process_id: pid.map(|p| p as i64),
            browser_tab_title: None,
            browser_tab_url: None,
        })
    }

    pub fn frontmost_process_id() -> Option<i64> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd == HWND(0) {
            return None;
        }
        get_window_pid(hwnd).map(|pid| pid as i64)
    }

    fn get_window_pid(hwnd: HWND) -> Option<u32> {
        let mut pid: u32 = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if pid == 0 {
            None
        } else {
            Some(pid)
        }
    }

    fn get_window_title(hwnd: HWND) -> Option<String> {
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length == 0 {
            return None;
        }
        let mut buffer = vec![0u16; (length + 1) as usize];
        let copied = unsafe {
            GetWindowTextW(
                hwnd,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                buffer.len() as i32,
            )
        };
        if copied == 0 {
            return None;
        }
        Some(
            OsString::from_wide(&buffer[..copied as usize])
                .to_string_lossy()
                .to_string(),
        )
    }

    fn get_process_image_path(pid: u32) -> Option<String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };

        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        let success = unsafe {
            QueryFullProcessImageNameW(
                handle,
                0,
                windows::core::PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
        };

        unsafe {
            let _ = CloseHandle(handle);
        }

        if !success.as_bool() || size == 0 {
            return None;
        }

        Some(
            OsString::from_wide(&buffer[..size as usize])
                .to_string_lossy()
                .to_string(),
        )
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::FocusContext;
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    pub fn get_active_context() -> Option<FocusContext> {
        if crate::utils::is_wayland() {
            return None;
        }

        let window_id = run_xdotool(&["getactivewindow"])?.trim().to_string();
        if window_id.is_empty() {
            return None;
        }

        let window_title = run_xdotool(&["getwindowname", &window_id])
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty());

        let pid = run_xdotool(&["getwindowpid", &window_id])
            .and_then(|pid| pid.trim().parse::<i64>().ok());

        let (app_name, app_identifier) = pid
            .and_then(|pid| get_process_metadata(pid).map(|(name, id)| (Some(name), id)))
            .unwrap_or((None, None));

        Some(FocusContext {
            app_name,
            app_identifier,
            window_title,
            process_id: pid,
            browser_tab_title: None,
            browser_tab_url: None,
        })
    }

    fn run_xdotool(args: &[&str]) -> Option<String> {
        let output = Command::new("xdotool").args(args).output().ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    }

    fn get_process_metadata(pid: i64) -> Option<(String, Option<String>)> {
        let comm_path = format!("/proc/{}/comm", pid);
        let comm = fs::read_to_string(&comm_path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let exe_path = fs::read_link(format!("/proc/{}/exe", pid))
            .ok()
            .map(|path| path.to_string_lossy().to_string());

        let app_name = comm.or_else(|| {
            exe_path
                .as_ref()
                .and_then(|path| Path::new(path).file_stem())
                .map(|stem| stem.to_string_lossy().to_string())
        })?;

        Some((app_name, exe_path))
    }

    pub fn frontmost_process_id() -> Option<i64> {
        get_active_context().and_then(|ctx| ctx.process_id)
    }
}
