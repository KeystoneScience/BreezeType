use crate::audio_toolkit::{
    list_input_devices, preferred_macos_default_input_device_name, vad::SmoothedVad, AudioRecorder,
    SileroVad,
};
use crate::helpers::clamshell;
use crate::settings::{get_settings, AppSettings, RecordingOutputMode};
use crate::utils;
use log::{debug, error, info};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use tauri::Manager;

fn lock_or_recover<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            error!("Audio manager mutex '{}' poisoned; recovering", name);
            poisoned.into_inner()
        }
    }
}

fn set_mute(mute: bool) {
    // Expected behavior:
    // - Windows: works on most systems using standard audio drivers.
    // - Linux: works on many systems (PipeWire, PulseAudio, ALSA),
    //   but some distros may lack the tools used.
    // - macOS: works on most standard setups via AppleScript.
    // If unsupported, fails silently.

    #[cfg(target_os = "windows")]
    {
        unsafe {
            use windows::Win32::{
                Media::Audio::{
                    eMultimedia, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
                    MMDeviceEnumerator,
                },
                System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED},
            };

            macro_rules! unwrap_or_return {
                ($expr:expr) => {
                    match $expr {
                        Ok(val) => val,
                        Err(_) => return,
                    }
                };
            }

            // Initialize the COM library for this thread.
            // If already initialized (e.g., by another library like Tauri), this does nothing.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let all_devices: IMMDeviceEnumerator =
                unwrap_or_return!(CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL));
            let default_device =
                unwrap_or_return!(all_devices.GetDefaultAudioEndpoint(eRender, eMultimedia));
            let volume_interface = unwrap_or_return!(
                default_device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            );

            let _ = volume_interface.SetMute(mute, std::ptr::null());
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        let mute_val = if mute { "1" } else { "0" };
        let amixer_state = if mute { "mute" } else { "unmute" };

        // Try multiple backends to increase compatibility
        // 1. PipeWire (wpctl)
        if Command::new("wpctl")
            .args(["set-mute", "@DEFAULT_AUDIO_SINK@", mute_val])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return;
        }

        // 2. PulseAudio (pactl)
        if Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", mute_val])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return;
        }

        // 3. ALSA (amixer)
        let _ = Command::new("amixer")
            .args(["set", "Master", amixer_state])
            .output();
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let script = format!(
            "set volume output muted {}",
            if mute { "true" } else { "false" }
        );
        let _ = Command::new("osascript").args(["-e", &script]).output();
    }
}

#[derive(Clone, Copy, Debug)]
struct SystemOutputState {
    volume_percent: i32,
    muted: bool,
}

#[cfg(target_os = "macos")]
fn get_system_output_state() -> Option<SystemOutputState> {
    use std::process::Command;

    let output = Command::new("osascript")
        .args([
            "-e",
            "set v to output volume of (get volume settings)",
            "-e",
            "set m to output muted of (get volume settings)",
            "-e",
            "return (v as text) & \"|\" & (m as text)",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim();
    let mut parts = trimmed.split('|');
    let volume_percent = parts.next()?.trim().parse::<i32>().ok()?.clamp(0, 100);
    let muted = matches!(
        parts.next().map(|value| value.trim().to_lowercase()),
        Some(value) if value == "true"
    );
    Some(SystemOutputState {
        volume_percent,
        muted,
    })
}

#[cfg(not(target_os = "macos"))]
fn get_system_output_state() -> Option<SystemOutputState> {
    None
}

#[cfg(target_os = "macos")]
fn set_output_volume_percent(volume_percent: i32) {
    use std::process::Command;

    let clamped = volume_percent.clamp(0, 100);
    let script = format!("set volume output volume {}", clamped);
    let _ = Command::new("osascript").args(["-e", &script]).output();
}

#[cfg(not(target_os = "macos"))]
fn set_output_volume_percent(_volume_percent: i32) {}

fn restore_system_output_state(state: SystemOutputState) {
    // If baseline was muted, never touch output volume on restore.
    // This avoids a release-time spike caused by macOS volume writes.
    if state.muted {
        set_mute(true);
    } else {
        set_output_volume_percent(state.volume_percent);
        set_mute(false);
    }
}

const WHISPER_SAMPLE_RATE: usize = 16000;

/* ──────────────────────────────────────────────────────────────── */

#[derive(Clone, Debug)]
pub enum RecordingState {
    Idle,
    Recording { binding_id: String },
}

#[derive(Clone, Debug)]
pub enum MicrophoneMode {
    AlwaysOn,
    OnDemand,
}

/* ──────────────────────────────────────────────────────────────── */

fn create_audio_recorder(
    vad_path: &str,
    app_handle: &tauri::AppHandle,
) -> Result<AudioRecorder, anyhow::Error> {
    let silero = SileroVad::new(vad_path, 0.3)
        .map_err(|e| anyhow::anyhow!("Failed to create SileroVad: {}", e))?;
    let smoothed_vad = SmoothedVad::new(Box::new(silero), 15, 15, 2);

    // Recorder with VAD plus a spectrum-level callback that forwards updates to
    // the frontend.
    let recorder = AudioRecorder::new()
        .map_err(|e| anyhow::anyhow!("Failed to create AudioRecorder: {}", e))?
        .with_vad(Box::new(smoothed_vad))
        .with_level_callback({
            let app_handle = app_handle.clone();
            move |levels| {
                utils::emit_levels(&app_handle, &levels);
            }
        });

    Ok(recorder)
}

/* ──────────────────────────────────────────────────────────────── */

#[derive(Clone)]
pub struct AudioRecordingManager {
    state: Arc<Mutex<RecordingState>>,
    mode: Arc<Mutex<MicrophoneMode>>,
    app_handle: tauri::AppHandle,

    recorder: Arc<Mutex<Option<AudioRecorder>>>,
    cached_input_device: Arc<Mutex<Option<CachedInputDevice>>>,
    is_open: Arc<Mutex<bool>>,
    is_recording: Arc<Mutex<bool>>,
    did_mute: Arc<Mutex<bool>>,
    duck_restore_state: Arc<Mutex<Option<SystemOutputState>>>,
    recording_generation: Arc<AtomicU64>,
}

#[derive(Clone)]
struct CachedInputDevice {
    name: String,
    device: cpal::Device,
}

#[derive(Clone, Debug)]
pub struct RecordedAudio {
    pub samples: Vec<f32>,
    pub duration_seconds: f64,
}

impl AudioRecordingManager {
    /* ---------- construction ------------------------------------------------ */

    pub fn new(app: &tauri::AppHandle) -> Self {
        let settings = get_settings(app);
        let mode = if settings.always_on_microphone {
            MicrophoneMode::AlwaysOn
        } else {
            MicrophoneMode::OnDemand
        };

        let manager = Self {
            state: Arc::new(Mutex::new(RecordingState::Idle)),
            mode: Arc::new(Mutex::new(mode.clone())),
            app_handle: app.clone(),

            recorder: Arc::new(Mutex::new(None)),
            cached_input_device: Arc::new(Mutex::new(None)),
            is_open: Arc::new(Mutex::new(false)),
            is_recording: Arc::new(Mutex::new(false)),
            did_mute: Arc::new(Mutex::new(false)),
            duck_restore_state: Arc::new(Mutex::new(None)),
            recording_generation: Arc::new(AtomicU64::new(0)),
        };

        // Always-on?  Open immediately.
        if matches!(mode, MicrophoneMode::AlwaysOn) {
            if let Err(err) = manager.start_microphone_stream() {
                // Never crash the app on startup due to audio/permission issues.
                // Fall back to on-demand mode; the user can re-enable always-on later.
                error!(
                    "Failed to start always-on microphone stream; falling back to on-demand: {}",
                    err
                );
                if let Ok(mut guard) = manager.mode.lock() {
                    *guard = MicrophoneMode::OnDemand;
                }
            }
        }

        manager
    }

    /* ---------- helper methods --------------------------------------------- */

    fn get_effective_microphone_name(&self, settings: &AppSettings) -> Option<String> {
        // Avoid expensive clamshell checks unless a clamshell microphone is configured.
        if let Some(clamshell_name) = settings.clamshell_microphone.as_ref() {
            if clamshell::is_clamshell().unwrap_or(false) {
                return Some(clamshell_name.clone());
            }
        }

        if let Some(selected_name) = settings.selected_microphone.clone() {
            return Some(selected_name);
        }

        #[cfg(target_os = "macos")]
        {
            // No explicit selection: prefer built-in/non-Bluetooth mic on macOS.
            // Reuse cached auto-selected device if present to keep startup fast.
            if let Some(cached) =
                lock_or_recover(&self.cached_input_device, "cached_input_device").as_ref()
            {
                return Some(cached.name.clone());
            }
            return preferred_macos_default_input_device_name();
        }

        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    fn get_effective_microphone_device(&self, settings: &AppSettings) -> Option<cpal::Device> {
        let device_name = self.get_effective_microphone_name(settings)?;

        // Fast path: use cached device when the configured microphone name hasn't changed.
        if let Some(cached) =
            lock_or_recover(&self.cached_input_device, "cached_input_device").as_ref()
        {
            if cached.name == device_name {
                return Some(cached.device.clone());
            }
        }

        // Slow path: enumerate devices by name and refresh cache.
        let resolved = match list_input_devices() {
            Ok(devices) => devices
                .into_iter()
                .find(|d| d.name == device_name)
                .map(|d| d.device),
            Err(e) => {
                debug!("Failed to list devices, using default: {}", e);
                None
            }
        };

        let mut cache = lock_or_recover(&self.cached_input_device, "cached_input_device");
        *cache = resolved.as_ref().map(|device| CachedInputDevice {
            name: device_name,
            device: device.clone(),
        });

        resolved
    }

    /* ---------- microphone life-cycle -------------------------------------- */

    /// Applies the configured output-audio behavior while recording (off/mute/duck).
    pub fn apply_mute(&self) {
        if !*lock_or_recover(&self.is_recording, "is_recording") {
            debug!("Skipping output-mode apply because recording is inactive");
            return;
        }

        let settings = get_settings(&self.app_handle);
        match crate::settings::recording_output_mode_from_level(settings.recording_duck_level) {
            RecordingOutputMode::Off => {
                self.remove_mute();
            }
            RecordingOutputMode::Mute => {
                self.restore_ducking_state();
                let mut did_mute_guard = lock_or_recover(&self.did_mute, "did_mute");
                let baseline_state = get_system_output_state();
                let should_restore_unmute =
                    baseline_state.map(|state| !state.muted).unwrap_or(false);
                set_mute(true);
                *did_mute_guard = should_restore_unmute;
                debug!(
                    "Mute applied (restore_unmute: {}, baseline_known: {})",
                    should_restore_unmute,
                    baseline_state.is_some()
                );
            }
            RecordingOutputMode::Duck => {
                let mut did_mute_guard = lock_or_recover(&self.did_mute, "did_mute");
                // Never force an unmute before ducking. If output is already muted or
                // below target volume, leave it as-is.
                *did_mute_guard = false;
                drop(did_mute_guard);
                self.apply_ducking_level(settings.recording_duck_level);
            }
        }
    }

    pub fn apply_mute_if_generation(&self, generation: u64) {
        if self.current_recording_generation() != generation {
            debug!(
                "Skipping stale output-mode apply (expected generation {}, current {})",
                generation,
                self.current_recording_generation()
            );
            return;
        }
        self.apply_mute();
    }

    pub fn current_recording_generation(&self) -> u64 {
        self.recording_generation.load(Ordering::SeqCst)
    }

    /// Always applies output mute while the microphone stream is open.
    pub fn apply_mute_force(&self) {
        if !*lock_or_recover(&self.is_recording, "is_recording") {
            debug!("Skipping forced mute because recording is inactive");
            return;
        }

        self.restore_ducking_state();
        let mut did_mute_guard = lock_or_recover(&self.did_mute, "did_mute");
        if *lock_or_recover(&self.is_open, "is_open") {
            let baseline_state = get_system_output_state();
            let should_restore_unmute = baseline_state.map(|state| !state.muted).unwrap_or(false);
            set_mute(true);
            *did_mute_guard = should_restore_unmute;
            debug!(
                "Forced mute applied (restore_unmute: {}, baseline_known: {})",
                should_restore_unmute,
                baseline_state.is_some()
            );
        }
    }

    /// Removes mute if it was applied
    pub fn remove_mute(&self) {
        let mut did_mute_guard = lock_or_recover(&self.did_mute, "did_mute");
        if *did_mute_guard {
            set_mute(false);
            *did_mute_guard = false;
            debug!("Mute removed");
        }
        drop(did_mute_guard);
        self.restore_ducking_state();
    }

    pub fn start_microphone_stream(&self) -> Result<(), anyhow::Error> {
        let mut open_flag = lock_or_recover(&self.is_open, "is_open");
        if *open_flag {
            debug!("Microphone stream already active");
            return Ok(());
        }

        let start_time = Instant::now();

        // Don't mute immediately - caller will handle muting after audio feedback
        let mut did_mute_guard = lock_or_recover(&self.did_mute, "did_mute");
        *did_mute_guard = false;

        let vad_path = self
            .app_handle
            .path()
            .resolve(
                "resources/models/silero_vad_v4.onnx",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| anyhow::anyhow!("Failed to resolve VAD path: {}", e))?;
        let mut recorder_opt = lock_or_recover(&self.recorder, "recorder");

        if recorder_opt.is_none() {
            let vad_path_string = vad_path.to_string_lossy().to_string();
            *recorder_opt = Some(create_audio_recorder(&vad_path_string, &self.app_handle)?);
        }

        // Get the selected device from settings, considering clamshell mode
        let settings = get_settings(&self.app_handle);
        let selected_device = self.get_effective_microphone_device(&settings);

        if let Some(rec) = recorder_opt.as_mut() {
            if let Err(first_err) = rec.open(selected_device.clone()) {
                // Cached device handles can go stale after hardware changes.
                // Clear cache and retry once with a freshly enumerated device.
                if selected_device.is_some() {
                    *lock_or_recover(&self.cached_input_device, "cached_input_device") = None;
                    let refreshed_device = self.get_effective_microphone_device(&settings);
                    rec.open(refreshed_device)
                        .map_err(|e| anyhow::anyhow!("Failed to open recorder: {}", e))?;
                    debug!(
                        "Recovered from stale cached microphone handle: {}",
                        first_err
                    );
                } else {
                    return Err(anyhow::anyhow!("Failed to open recorder: {}", first_err));
                }
            }
        }

        *open_flag = true;
        info!(
            "Microphone stream initialized in {:?}",
            start_time.elapsed()
        );
        Ok(())
    }

    fn stop_microphone_stream_internal(&self, restore_output_state: bool) {
        let mut open_flag = lock_or_recover(&self.is_open, "is_open");
        if !*open_flag {
            return;
        }

        let mut did_mute_guard = lock_or_recover(&self.did_mute, "did_mute");
        if *did_mute_guard && restore_output_state {
            set_mute(false);
        }
        *did_mute_guard = false;
        drop(did_mute_guard);
        if restore_output_state {
            self.restore_ducking_state();
        }

        if let Some(rec) = lock_or_recover(&self.recorder, "recorder").as_mut() {
            // If still recording, stop first.
            if *lock_or_recover(&self.is_recording, "is_recording") {
                let _ = rec.stop();
                *lock_or_recover(&self.is_recording, "is_recording") = false;
            }
            let _ = rec.close();
        }

        *open_flag = false;
        debug!("Microphone stream stopped");
    }

    pub fn stop_microphone_stream(&self) {
        self.stop_microphone_stream_internal(true);
    }

    fn apply_ducking_level(&self, level: f32) {
        let mut restore_guard = lock_or_recover(&self.duck_restore_state, "duck_restore_state");
        if restore_guard.is_none() {
            *restore_guard = get_system_output_state();
        }
        let Some(baseline_state) = *restore_guard else {
            debug!("Could not capture current output state; skipping ducking");
            return;
        };
        drop(restore_guard);

        if baseline_state.muted {
            // User started muted; do not alter volume while speaking.
            set_mute(true);
            debug!("Baseline output is muted; skipping ducking volume change");
            return;
        }

        let requested_percent = (level.clamp(0.0, 1.0) * 100.0).round() as i32;
        let target_percent = requested_percent.min(baseline_state.volume_percent);

        // Never raise output volume while speaking; only lower it.
        if target_percent < baseline_state.volume_percent {
            set_output_volume_percent(target_percent);
        }
        debug!(
            "Ducking applied at {}% (requested {}%, baseline {}%, muted: {})",
            target_percent, requested_percent, baseline_state.volume_percent, baseline_state.muted
        );
    }

    fn restore_ducking_state(&self) {
        let previous_state = lock_or_recover(&self.duck_restore_state, "duck_restore_state").take();
        if let Some(previous) = previous_state {
            restore_system_output_state(previous);
            debug!(
                "Ducking restored to {}% (muted: {})",
                previous.volume_percent, previous.muted
            );
        }
    }

    /* ---------- mode switching --------------------------------------------- */

    pub fn update_mode(&self, new_mode: MicrophoneMode) -> Result<(), anyhow::Error> {
        let mode_guard = lock_or_recover(&self.mode, "mode");
        let cur_mode = mode_guard.clone();

        match (cur_mode, &new_mode) {
            (MicrophoneMode::AlwaysOn, MicrophoneMode::OnDemand) => {
                if matches!(*lock_or_recover(&self.state, "state"), RecordingState::Idle) {
                    drop(mode_guard);
                    self.stop_microphone_stream();
                }
            }
            (MicrophoneMode::OnDemand, MicrophoneMode::AlwaysOn) => {
                drop(mode_guard);
                self.start_microphone_stream()?;
            }
            _ => {}
        }

        *lock_or_recover(&self.mode, "mode") = new_mode;
        Ok(())
    }

    /* ---------- recording --------------------------------------------------- */

    pub fn try_start_recording(&self, binding_id: &str) -> bool {
        let mut state = lock_or_recover(&self.state, "state");

        if let RecordingState::Idle = *state {
            // Recover from any stale output state left by rapid edge churn
            // before beginning a fresh capture cycle.
            self.remove_mute();

            // Ensure microphone is open in on-demand mode
            if matches!(
                *lock_or_recover(&self.mode, "mode"),
                MicrophoneMode::OnDemand
            ) {
                if let Err(e) = self.start_microphone_stream() {
                    error!("Failed to open microphone stream: {e}");
                    return false;
                }
            }

            if let Some(rec) = lock_or_recover(&self.recorder, "recorder").as_ref() {
                if rec.start().is_ok() {
                    *lock_or_recover(&self.is_recording, "is_recording") = true;
                    self.recording_generation.fetch_add(1, Ordering::SeqCst);
                    *state = RecordingState::Recording {
                        binding_id: binding_id.to_string(),
                    };
                    debug!("Recording started for binding {binding_id}");
                    return true;
                }
            }
            error!("Recorder not available");
            false
        } else {
            false
        }
    }

    pub fn update_selected_device(&self) -> Result<(), anyhow::Error> {
        // Device selection changed; invalidate name->device cache.
        *lock_or_recover(&self.cached_input_device, "cached_input_device") = None;

        // If currently open, restart the microphone stream to use the new device
        if *lock_or_recover(&self.is_open, "is_open") {
            self.stop_microphone_stream();
            self.start_microphone_stream()?;
        }
        Ok(())
    }

    pub fn stop_recording_with_output_restore(
        &self,
        binding_id: &str,
        restore_output_state: bool,
    ) -> Option<RecordedAudio> {
        let mut state = lock_or_recover(&self.state, "state");

        match *state {
            RecordingState::Recording {
                binding_id: ref active,
            } if active == binding_id => {
                *state = RecordingState::Idle;
                self.recording_generation.fetch_add(1, Ordering::SeqCst);
                drop(state);

                let samples =
                    if let Some(rec) = lock_or_recover(&self.recorder, "recorder").as_ref() {
                        match rec.stop() {
                            Ok(buf) => buf,
                            Err(e) => {
                                error!("stop() failed: {e}");
                                Vec::new()
                            }
                        }
                    } else {
                        error!("Recorder not available");
                        Vec::new()
                    };

                *lock_or_recover(&self.is_recording, "is_recording") = false;

                // In on-demand mode turn the mic off again
                if matches!(
                    *lock_or_recover(&self.mode, "mode"),
                    MicrophoneMode::OnDemand
                ) {
                    self.stop_microphone_stream_internal(restore_output_state);
                }

                // Pad if very short (duration measured before padding)
                let s_len = samples.len();
                let duration_seconds = if s_len > 0 {
                    s_len as f64 / WHISPER_SAMPLE_RATE as f64
                } else {
                    0.0
                };
                if s_len < WHISPER_SAMPLE_RATE && s_len > 0 {
                    let mut padded = samples;
                    padded.resize(WHISPER_SAMPLE_RATE * 5 / 4, 0.0);
                    Some(RecordedAudio {
                        samples: padded,
                        duration_seconds,
                    })
                } else {
                    Some(RecordedAudio {
                        samples,
                        duration_seconds,
                    })
                }
            }
            _ => None,
        }
    }

    pub fn stop_recording(&self, binding_id: &str) -> Option<RecordedAudio> {
        self.stop_recording_with_output_restore(binding_id, true)
    }
    pub fn is_recording(&self) -> bool {
        matches!(
            *lock_or_recover(&self.state, "state"),
            RecordingState::Recording { .. }
        )
    }

    /// Cancel any ongoing recording without returning audio samples
    pub fn cancel_recording(&self) {
        let mut canceled = false;
        let mut state = lock_or_recover(&self.state, "state");

        if let RecordingState::Recording { .. } = *state {
            *state = RecordingState::Idle;
            self.recording_generation.fetch_add(1, Ordering::SeqCst);
            canceled = true;
            drop(state);

            if let Some(rec) = lock_or_recover(&self.recorder, "recorder").as_ref() {
                let _ = rec.stop(); // Discard the result
            }

            *lock_or_recover(&self.is_recording, "is_recording") = false;

            // In on-demand mode turn the mic off again
            if matches!(
                *lock_or_recover(&self.mode, "mode"),
                MicrophoneMode::OnDemand
            ) {
                self.stop_microphone_stream();
            }
        }

        if canceled || !self.is_recording() {
            // Ensure any temporary mute/duck state is restored even during cancellation races.
            self.remove_mute();
        }
    }
}
