use cpal::traits::{DeviceTrait, HostTrait};

pub struct CpalDeviceInfo {
    pub index: String,
    pub name: String,
    pub is_default: bool,
    pub device: cpal::Device,
}

pub fn list_input_devices() -> Result<Vec<CpalDeviceInfo>, Box<dyn std::error::Error>> {
    let host = crate::audio_toolkit::get_cpal_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());

    let mut out = Vec::<CpalDeviceInfo>::new();

    for (index, device) in host.input_devices()?.enumerate() {
        let name = device.name().unwrap_or_else(|_| "Unknown".into());

        let is_default = Some(name.clone()) == default_name;

        out.push(CpalDeviceInfo {
            index: index.to_string(),
            name,
            is_default,
            device,
        });
    }

    Ok(out)
}

pub fn list_output_devices() -> Result<Vec<CpalDeviceInfo>, Box<dyn std::error::Error>> {
    let host = crate::audio_toolkit::get_cpal_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());

    let mut out = Vec::<CpalDeviceInfo>::new();

    for (index, device) in host.output_devices()?.enumerate() {
        let name = device.name().unwrap_or_else(|_| "Unknown".into());

        let is_default = Some(name.clone()) == default_name;

        out.push(CpalDeviceInfo {
            index: index.to_string(),
            name,
            is_default,
            device,
        });
    }

    Ok(out)
}

#[cfg(target_os = "macos")]
fn score_preferred_macos_default_input(name: &str) -> i32 {
    let normalized = name.to_ascii_lowercase();

    // Avoid common Bluetooth headset inputs in auto-selection mode.
    if normalized.contains("airpods")
        || normalized.contains("bluetooth")
        || normalized.contains("headset")
        || normalized.contains("hands-free")
        || normalized.contains("earbuds")
        || normalized.contains("beats")
    {
        return -100;
    }

    let has_mic = normalized.contains("microphone") || normalized.contains(" mic");
    let has_macbook = normalized.contains("macbook");
    let has_builtin = normalized.contains("built-in") || normalized.contains("builtin");
    let has_internal = normalized.contains("internal");

    if has_macbook && has_mic {
        return 200;
    }
    if (has_builtin || has_internal) && has_mic {
        return 180;
    }
    if has_mic {
        return 20;
    }

    0
}

/// Returns the preferred input-device name for macOS when no microphone is explicitly configured.
/// Preference order:
/// 1. Built-in MacBook/internal microphones
/// 2. Any non-Bluetooth microphone
#[cfg(target_os = "macos")]
pub fn preferred_macos_default_input_device_name() -> Option<String> {
    let devices = list_input_devices().ok()?;
    devices
        .into_iter()
        .filter_map(|device| {
            let score = score_preferred_macos_default_input(&device.name);
            (score > 0).then_some((score, device.name))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, name)| name)
}

#[cfg(not(target_os = "macos"))]
pub fn preferred_macos_default_input_device_name() -> Option<String> {
    None
}
