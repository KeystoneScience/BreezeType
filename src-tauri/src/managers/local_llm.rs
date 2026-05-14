use futures_util::StreamExt;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

#[cfg(not(target_os = "windows"))]
use flate2::read::GzDecoder;

const DEFAULT_MODEL_ID: &str = "qwen3.5-0.8b";
const DEFAULT_MODEL_FILE_NAME: &str = "Qwen3.5-0.8B-Q8_0.gguf";
const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/lmstudio-community/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf";
const DEFAULT_MODEL_CONTEXT_SIZE: Option<u32> = Some(16_384);
const QWEN3_0_6B_MODEL_ID: &str = "qwen3-0.6b";
const QWEN3_0_6B_MODEL_FILE_NAME: &str = "Qwen3-0.6B-Q8_0.gguf";
const QWEN3_0_6B_MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf";
const QWEN3_1_7B_MODEL_ID: &str = "qwen3-1.7b";
const QWEN3_1_7B_MODEL_FILE_NAME: &str = "Qwen3-1.7B-Q8_0.gguf";
const QWEN3_1_7B_MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf";
const QWEN3_4B_MODEL_ID: &str = "qwen3-4b";
const QWEN3_4B_MODEL_FILE_NAME: &str = "Qwen3-4B-Q4_K_M.gguf";
const QWEN3_4B_MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf";
const QWEN3_8B_MODEL_ID: &str = "qwen3-8b";
const QWEN3_8B_MODEL_FILE_NAME: &str = "Qwen3-8B-Q4_K_M.gguf";
const QWEN3_8B_MODEL_URL: &str =
    "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf";
const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(30);
const LOCAL_LLM_HOST: &str = "127.0.0.1";
// Settings may still contain this legacy URL as a fallback, but runtime launches
// ask the OS for a loopback-only ephemeral port to avoid colliding with other apps.
const DEFAULT_LOCAL_LLM_PORT: u16 = 45871;
const LOCAL_LLM_BASE_URL_ENV: &str = "BREEZE_LOCAL_LLM_BASE_URL";
const LLAMA_SERVER_RELEASE_TAG: &str = "b8892";
// Keep this in sync with the bundled `resources/llm/*` assets when those are refreshed.
const BUNDLED_LLAMA_SERVER_RELEASE_TAG: &str = "b7622";

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const LLAMA_SERVER_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b8892/llama-b8892-bin-macos-arm64.tar.gz";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const LLAMA_SERVER_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b8892/llama-b8892-bin-macos-x64.tar.gz";
#[cfg(target_os = "linux")]
const LLAMA_SERVER_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b8892/llama-b8892-bin-ubuntu-x64.tar.gz";
#[cfg(target_os = "windows")]
const LLAMA_SERVER_URL: &str =
    "https://github.com/ggml-org/llama.cpp/releases/download/b8892/llama-b8892-bin-win-cpu-x64.zip";

struct LocalLlmModelDefinition {
    id: &'static str,
    label: &'static str,
    file_name: &'static str,
    url: &'static str,
    context_size: Option<u32>,
}

const LOCAL_LLM_MODELS: [LocalLlmModelDefinition; 5] = [
    LocalLlmModelDefinition {
        id: DEFAULT_MODEL_ID,
        label: "Qwen 0.9B (Qwen3.5 0.8B Q8_0)",
        file_name: DEFAULT_MODEL_FILE_NAME,
        url: DEFAULT_MODEL_URL,
        context_size: DEFAULT_MODEL_CONTEXT_SIZE,
    },
    LocalLlmModelDefinition {
        id: QWEN3_0_6B_MODEL_ID,
        label: "Qwen 0.8B (Qwen3 0.6B Q8_0)",
        file_name: QWEN3_0_6B_MODEL_FILE_NAME,
        url: QWEN3_0_6B_MODEL_URL,
        context_size: None,
    },
    LocalLlmModelDefinition {
        id: QWEN3_1_7B_MODEL_ID,
        label: "Qwen 2B Weak (Qwen3 1.7B Q8_0)",
        file_name: QWEN3_1_7B_MODEL_FILE_NAME,
        url: QWEN3_1_7B_MODEL_URL,
        context_size: None,
    },
    LocalLlmModelDefinition {
        id: QWEN3_4B_MODEL_ID,
        label: "Qwen 4B (Qwen3 4B Q4_K_M)",
        file_name: QWEN3_4B_MODEL_FILE_NAME,
        url: QWEN3_4B_MODEL_URL,
        context_size: None,
    },
    LocalLlmModelDefinition {
        id: QWEN3_8B_MODEL_ID,
        label: "Qwen 9B (Qwen3 8B Q4_K_M)",
        file_name: QWEN3_8B_MODEL_FILE_NAME,
        url: QWEN3_8B_MODEL_URL,
        context_size: None,
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LocalLlmModelStatus {
    pub id: String,
    pub label: String,
    pub is_downloaded: bool,
    pub is_downloading: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LocalLlmStatus {
    pub binary_present: bool,
    pub model_present: bool,
    pub server_running: bool,
    pub downloading: bool,
    pub download_stage: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress_percent: Option<f64>,
    pub server_starting: bool,
    pub server_error: Option<String>,
    pub last_error: Option<String>,
    pub model_id: String,
    pub models: Vec<LocalLlmModelStatus>,
    pub base_url: String,
    pub server_log_path: String,
}

struct DownloadState {
    in_progress: bool,
    last_error: Option<String>,
    downloaded_bytes: u64,
    total_bytes: u64,
    stage: Option<String>,
    model_id: Option<String>,
}

struct ServerState {
    starting: bool,
    last_error: Option<String>,
}

pub struct LocalLlmManager {
    child: Mutex<Option<Child>>,
    download_state: Mutex<DownloadState>,
    server_state: Mutex<ServerState>,
    active_model_id: Mutex<Option<String>>,
    active_port: Mutex<u16>,
}

impl LocalLlmManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            download_state: Mutex::new(DownloadState {
                in_progress: false,
                last_error: None,
                downloaded_bytes: 0,
                total_bytes: 0,
                stage: None,
                model_id: None,
            }),
            server_state: Mutex::new(ServerState {
                starting: false,
                last_error: None,
            }),
            active_model_id: Mutex::new(None),
            active_port: Mutex::new(0),
        }
    }

    pub fn ensure_running(
        self: &Arc<Self>,
        app_handle: &AppHandle,
        selected_model_id: &str,
    ) -> Result<(), String> {
        let selected_model = resolve_model_definition(selected_model_id);
        let effective_model = resolve_effective_model(app_handle, selected_model);
        let active_port = self.active_port();

        if self.is_running() {
            let active_model = self
                .active_model_id
                .lock()
                .ok()
                .and_then(|guard| guard.clone());
            if active_model.as_deref() == Some(effective_model.id) {
                if active_port == 0 {
                    return Err("Local LLM server port is not available".to_string());
                }
                if wait_for_server(LOCAL_LLM_HOST, active_port, SERVER_READY_TIMEOUT) {
                    set_local_llm_base_url_env(active_port);
                    return Ok(());
                }
                return Err("Local LLM server not ready yet".to_string());
            }
            self.stop_server();
        }

        let server_path = resolve_server_path(app_handle);
        let model_path = resolve_model_path_for(app_handle, effective_model);
        let server_port = choose_ephemeral_loopback_port()
            .map_err(|e| format!("Failed to resolve local LLM port: {}", e))?;
        self.set_active_port(server_port);

        self.ensure_assets_async(app_handle, selected_model.id);

        if !server_assets_present(app_handle) {
            return Err("Local LLM server binary is not ready yet".to_string());
        }
        if !model_path.exists() {
            return Err("Local LLM model is not ready yet".to_string());
        }

        cleanup_stale_server_processes(app_handle, &server_path);

        info!("Starting local LLM server: {}", server_path.display());

        let mut command = Command::new(&server_path);
        let server_dir = server_path
            .parent()
            .ok_or("Failed to resolve server directory")?;
        let log_path = server_log_path(app_handle);
        if let Ok(log_file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            if let Ok(err_file) = log_file.try_clone() {
                command
                    .stdout(Stdio::from(log_file))
                    .stderr(Stdio::from(err_file));
            }
        }
        #[cfg(target_os = "macos")]
        {
            command.env(
                "DYLD_LIBRARY_PATH",
                server_dir.to_string_lossy().to_string(),
            );
            command.env(
                "DYLD_FALLBACK_LIBRARY_PATH",
                server_dir.to_string_lossy().to_string(),
            );
        }
        #[cfg(target_os = "linux")]
        {
            command.env("LD_LIBRARY_PATH", server_dir.to_string_lossy().to_string());
        }
        #[cfg(target_os = "windows")]
        {
            command.env(
                "PATH",
                format!(
                    "{};{}",
                    server_dir.to_string_lossy(),
                    std::env::var("PATH").unwrap_or_default()
                ),
            );
        }
        command
            .arg("--model")
            .arg(model_path)
            .arg("--host")
            .arg(LOCAL_LLM_HOST)
            .arg("--port")
            .arg(server_port.to_string())
            .arg("--no-webui");
        if let Some(context_size) = effective_model.context_size {
            command.arg("--ctx-size").arg(context_size.to_string());
        }

        let child = command
            .spawn()
            .map_err(|e| format!("Failed to start local LLM server: {}", e))?;

        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }
        if let Ok(mut guard) = self.active_model_id.lock() {
            *guard = Some(effective_model.id.to_string());
        }

        if !wait_for_server(LOCAL_LLM_HOST, server_port, SERVER_READY_TIMEOUT) {
            let exit_status = self.child.lock().ok().and_then(|mut guard| {
                guard
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten())
            });
            if let Some(status) = exit_status {
                return Err(format!("Local LLM server exited with status {}", status));
            }
            warn!("Local LLM server did not become ready before timeout");
            return Err("Local LLM server not ready yet".to_string());
        }

        info!(
            "Local LLM server is ready at {}",
            local_llm_base_url(server_port)
        );
        set_local_llm_base_url_env(server_port);
        Ok(())
    }

    pub fn ensure_running_async(self: &Arc<Self>, app_handle: &AppHandle, selected_model_id: &str) {
        let should_start = {
            let mut state = match self.server_state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            if state.starting {
                return;
            }
            state.starting = true;
            state.last_error = None;
            true
        };

        if !should_start {
            return;
        }

        let app_handle = app_handle.clone();
        let manager = Arc::clone(self);
        let selected_model_id = selected_model_id.to_string();
        async_runtime::spawn(async move {
            let result = manager.ensure_running(&app_handle, &selected_model_id);
            let mut state = match manager.server_state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            state.starting = false;
            state.last_error = result.err();
        });
    }

    pub fn ensure_assets_async(self: &Arc<Self>, app_handle: &AppHandle, selected_model_id: &str) {
        let selected_model = resolve_model_definition(selected_model_id);
        let default_model = default_model_definition();
        let missing = !server_assets_present(app_handle)
            || !resolve_model_path_for(app_handle, default_model).exists()
            || (selected_model.id != default_model.id
                && !resolve_model_path_for(app_handle, selected_model).exists());
        if !missing {
            return;
        }

        let should_start = {
            let mut state = match self.download_state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            if state.in_progress {
                return;
            }
            state.in_progress = true;
            state.last_error = None;
            state.downloaded_bytes = 0;
            state.total_bytes = 0;
            state.stage = None;
            state.model_id = None;
            true
        };

        if !should_start {
            return;
        }

        let app_handle = app_handle.clone();
        let manager = Arc::clone(self);
        let selected_model_id = selected_model_id.to_string();

        async_runtime::spawn(async move {
            let result = download_assets(&manager, &app_handle, &selected_model_id).await;
            let mut state = match manager.download_state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            state.in_progress = false;
            state.last_error = result.err();
            state.downloaded_bytes = 0;
            state.total_bytes = 0;
            state.stage = None;
            state.model_id = None;
        });
    }

    pub fn status(&self, app_handle: &AppHandle, selected_model_id: &str) -> LocalLlmStatus {
        let selected_model = resolve_model_definition(selected_model_id);
        let selected_path = resolve_model_path_for(app_handle, selected_model);
        let active_port = self.active_port();
        let server_state = self
            .server_state
            .lock()
            .map(|state| (state.starting, state.last_error.clone()))
            .unwrap_or((false, Some("Failed to read server state".into())));

        let download_state = self
            .download_state
            .lock()
            .map(|state| {
                (
                    state.in_progress,
                    state.last_error.clone(),
                    state.downloaded_bytes,
                    state.total_bytes,
                    state.stage.clone(),
                    state.model_id.clone(),
                )
            })
            .unwrap_or((
                false,
                Some("Failed to read download state".into()),
                0,
                0,
                None,
                None,
            ));

        let progress_percent = if download_state.3 > 0 {
            Some((download_state.2 as f64 / download_state.3 as f64) * 100.0)
        } else {
            None
        };

        let models = LOCAL_LLM_MODELS
            .iter()
            .map(|model| LocalLlmModelStatus {
                id: model.id.to_string(),
                label: model.label.to_string(),
                is_downloaded: resolve_model_path_for(app_handle, model).exists(),
                is_downloading: download_state.0
                    && download_state.5.as_deref().is_some_and(|id| id == model.id),
            })
            .collect();

        LocalLlmStatus {
            binary_present: server_assets_present(app_handle),
            model_present: selected_path.exists(),
            server_running: self.is_running()
                || (active_port != 0
                    && wait_for_server(LOCAL_LLM_HOST, active_port, Duration::from_millis(50))),
            downloading: download_state.0,
            download_stage: download_state.4,
            downloaded_bytes: download_state.2,
            total_bytes: download_state.3,
            progress_percent,
            server_starting: server_state.0,
            server_error: server_state.1,
            last_error: download_state.1,
            model_id: selected_model.id.to_string(),
            models,
            base_url: self.base_url(),
            server_log_path: server_log_path(app_handle).to_string_lossy().to_string(),
        }
    }

    pub fn active_model_id(&self) -> Option<String> {
        self.active_model_id
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub fn base_url(&self) -> String {
        let active_port = self.active_port();
        if active_port == 0 {
            return local_llm_base_url(DEFAULT_LOCAL_LLM_PORT);
        }
        local_llm_base_url(active_port)
    }

    fn stop_server(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
        if let Ok(mut active) = self.active_model_id.lock() {
            *active = None;
        }
        self.clear_active_port();
    }

    fn is_running(&self) -> bool {
        let Ok(mut guard) = self.child.lock() else {
            return false;
        };

        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    if let Ok(mut active) = self.active_model_id.lock() {
                        *active = None;
                    }
                    self.clear_active_port();
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            }
        } else {
            false
        }
    }

    fn active_port(&self) -> u16 {
        self.active_port
            .lock()
            .map(|guard| *guard)
            .unwrap_or(DEFAULT_LOCAL_LLM_PORT)
    }

    fn set_active_port(&self, port: u16) {
        if let Ok(mut guard) = self.active_port.lock() {
            *guard = port;
        }
    }

    fn clear_active_port(&self) {
        if let Ok(mut guard) = self.active_port.lock() {
            *guard = 0;
        }
    }
}

impl Drop for LocalLlmManager {
    fn drop(&mut self) {
        self.stop_server();
    }
}

fn default_model_definition() -> &'static LocalLlmModelDefinition {
    &LOCAL_LLM_MODELS[0]
}

fn resolve_model_definition(model_id: &str) -> &'static LocalLlmModelDefinition {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return default_model_definition();
    }
    LOCAL_LLM_MODELS
        .iter()
        .find(|model| model.id == trimmed)
        .unwrap_or_else(default_model_definition)
}

fn resolve_effective_model<'a>(
    app_handle: &AppHandle,
    selected_model: &'a LocalLlmModelDefinition,
) -> &'a LocalLlmModelDefinition {
    if resolve_model_path_for(app_handle, selected_model).exists() {
        return selected_model;
    }
    let fallback = default_model_definition();
    if resolve_model_path_for(app_handle, fallback).exists() {
        return fallback;
    }
    selected_model
}

fn resolve_server_path(app_handle: &AppHandle) -> PathBuf {
    #[cfg(target_os = "windows")]
    let filename = "llama-server.exe";
    #[cfg(not(target_os = "windows"))]
    let filename = "llama-server";
    local_llm_dir(app_handle).join(filename)
}

fn resolve_model_path_for(app_handle: &AppHandle, model: &LocalLlmModelDefinition) -> PathBuf {
    local_llm_dir(app_handle)
        .join("models")
        .join(model.file_name)
}

fn local_llm_dir(app_handle: &AppHandle) -> PathBuf {
    app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("llm")
}

fn server_log_path(app_handle: &AppHandle) -> PathBuf {
    local_llm_dir(app_handle).join("llama-server.log")
}

fn server_release_marker_path(app_handle: &AppHandle) -> PathBuf {
    local_llm_dir(app_handle).join("llama-server.release")
}

#[cfg(target_os = "macos")]
fn cleanup_stale_server_processes(app_handle: &AppHandle, server_path: &Path) {
    let server_path = server_path.to_string_lossy().to_string();
    let local_llm_dir = local_llm_dir(app_handle).to_string_lossy().to_string();
    let Ok(output) = Command::new("pgrep").arg("-f").arg("llama-server").output() else {
        return;
    };
    if !output.status.success() {
        return;
    }

    let current_pid = std::process::id();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(pid) = line.trim().parse::<u32>() else {
            continue;
        };
        if pid == current_pid {
            continue;
        }

        let pid_text = pid.to_string();
        let Ok(ps_output) = Command::new("ps")
            .args(["-p", &pid_text, "-o", "command="])
            .output()
        else {
            continue;
        };
        if !ps_output.status.success() {
            continue;
        }

        let command = String::from_utf8_lossy(&ps_output.stdout);
        let belongs_to_breeze =
            command.contains(&server_path) || command.contains(&local_llm_dir);
        if !belongs_to_breeze {
            continue;
        }

        warn!("Stopping stale local LLM server process: {}", pid);
        let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
    }
}

#[cfg(not(target_os = "macos"))]
fn cleanup_stale_server_processes(_app_handle: &AppHandle, _server_path: &Path) {}

fn local_llm_base_url(port: u16) -> String {
    format!("http://{}:{}/v1", LOCAL_LLM_HOST, port)
}

fn set_local_llm_base_url_env(port: u16) {
    std::env::set_var(LOCAL_LLM_BASE_URL_ENV, local_llm_base_url(port));
}

fn server_release_matches_expected(app_handle: &AppHandle) -> bool {
    std::fs::read_to_string(server_release_marker_path(app_handle))
        .map(|contents| contents.trim() == LLAMA_SERVER_RELEASE_TAG)
        .unwrap_or(false)
}

fn bundled_server_matches_expected_release() -> bool {
    BUNDLED_LLAMA_SERVER_RELEASE_TAG == LLAMA_SERVER_RELEASE_TAG
}

fn write_server_release_marker(app_handle: &AppHandle) -> Result<(), String> {
    let marker_path = server_release_marker_path(app_handle);
    if let Some(parent) = marker_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create local LLM dir: {}", e))?;
    }
    std::fs::write(&marker_path, LLAMA_SERVER_RELEASE_TAG)
        .map_err(|e| format!("Failed to persist local LLM server release: {}", e))
}

fn server_assets_present(app_handle: &AppHandle) -> bool {
    let server_path = resolve_server_path(app_handle);
    if !server_path.exists() {
        return false;
    }
    if !server_release_matches_expected(app_handle) {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        let lib_path = server_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("libmtmd.0.dylib");
        if !lib_path.exists() {
            return false;
        }
    }
    true
}

fn choose_ephemeral_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind((LOCAL_LLM_HOST, 0))
        .map_err(|e| format!("Failed to find an available loopback port: {}", e))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("Failed to resolve loopback port address: {}", e))
}

fn wait_for_server(host: &str, port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect((host, port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_llm_base_url_is_loopback_only() {
        assert_eq!(local_llm_base_url(12345), "http://127.0.0.1:12345/v1");
    }

    #[test]
    fn chooses_nonzero_ephemeral_loopback_port() {
        let port = choose_ephemeral_loopback_port().expect("expected a loopback port");
        assert_ne!(port, 0);
    }
}

async fn download_assets(
    manager: &Arc<LocalLlmManager>,
    app_handle: &AppHandle,
    selected_model_id: &str,
) -> Result<(), String> {
    let base_dir = local_llm_dir(app_handle);
    let model_dir = base_dir.join("models");
    std::fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create LLM directories: {}", e))?;

    let server_path = resolve_server_path(app_handle);
    let default_model = default_model_definition();
    let selected_model = resolve_model_definition(selected_model_id);
    let default_model_path = resolve_model_path_for(app_handle, default_model);

    if !server_assets_present(app_handle) || !default_model_path.exists() {
        let used_bundled =
            migrate_bundled_llm_assets(app_handle, &server_path, &default_model_path)?;
        if used_bundled && server_assets_present(app_handle) && default_model_path.exists() {
            // Continue to ensure selected model is present.
        }
    }

    if !server_assets_present(app_handle) {
        info!("Downloading local LLM server...");
        set_stage(manager, Some("Downloading server"));
        set_download_model(manager, None);
        download_and_extract_server(manager, &server_path).await?;
        set_stage(manager, Some("Extracting server"));
        clear_progress(manager);
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&server_path)
                .map_err(|e| format!("Failed to read server permissions: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&server_path, perms)
                .map_err(|e| format!("Failed to set server permissions: {}", e))?;
        }
        write_server_release_marker(app_handle)?;
    }

    let mut required_models = vec![default_model];
    if selected_model.id != default_model.id {
        required_models.push(selected_model);
    }

    for model in required_models {
        let model_path = resolve_model_path_for(app_handle, model);
        if model_path.exists() {
            continue;
        }
        info!("Downloading local LLM model: {}", model.id);
        set_stage(manager, Some(&format!("Downloading {}", model.label)));
        set_download_model(manager, Some(model.id));
        download_to_path(manager, model.url, &model_path).await?;
        clear_progress(manager);
        set_download_model(manager, None);
    }

    Ok(())
}

async fn download_and_extract_server(
    manager: &Arc<LocalLlmManager>,
    destination: &Path,
) -> Result<(), String> {
    let temp_dir = destination
        .parent()
        .ok_or("Missing destination directory")?
        .join("tmp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let archive_path = temp_dir.join("llama-server-archive");
    download_to_path(manager, LLAMA_SERVER_URL, &archive_path).await?;

    #[cfg(target_os = "windows")]
    {
        extract_zip(&archive_path, &temp_dir)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        extract_tar_gz(&archive_path, &temp_dir)?;
    }

    let filename = destination
        .file_name()
        .ok_or("Missing destination filename")?
        .to_string_lossy();
    let extracted = find_file_recursive(&temp_dir, &filename)
        .ok_or("Failed to locate llama-server in archive")?;

    let source_dir = extracted
        .parent()
        .ok_or("Failed to locate llama-server directory")?;
    let dest_dir = destination
        .parent()
        .ok_or("Failed to locate destination directory")?;

    copy_directory_files(source_dir, dest_dir)?;

    let _ = std::fs::remove_file(&archive_path);
    Ok(())
}

async fn download_to_path(
    manager: &Arc<LocalLlmManager>,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create download dir: {}", e))?;
    }

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download {}: {}", url, e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    update_progress(manager, 0, total);

    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read download chunk: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write download chunk: {}", e))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        update_progress(manager, downloaded, total);
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn extract_tar_gz(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive_file =
        std::fs::File::open(archive_path).map_err(|e| format!("Failed to open archive: {}", e))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(destination)
        .map_err(|e| format!("Failed to extract archive: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn extract_zip(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file =
        std::fs::File::open(archive_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {}", e))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;
        let out_path = destination.join(file.mangled_name());
        if file.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir: {}", e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create dir: {}", e))?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            std::io::copy(&mut file, &mut out_file)
                .map_err(|e| format!("Failed to extract zip file: {}", e))?;
        }
    }
    Ok(())
}

fn migrate_bundled_llm_assets(
    app_handle: &AppHandle,
    server_path: &Path,
    model_path: &Path,
) -> Result<bool, String> {
    let mut copied_any = false;
    let mut copied_server_assets = false;

    if !server_assets_present(app_handle) && bundled_server_matches_expected_release() {
        if let Some(bundled_dir) = bundled_llm_dir(app_handle) {
            if bundled_dir.exists() && bundled_dir.is_dir() {
                let dest_dir = server_path
                    .parent()
                    .ok_or("Failed to resolve local LLM dir")?;
                copy_dir_recursive(&bundled_dir, dest_dir)?;
                copied_any = true;
                copied_server_assets = true;
            }
        }
    }

    if copied_server_assets {
        write_server_release_marker(app_handle)?;
    }

    if !model_path.exists() {
        let default_model = default_model_definition();
        let bundled_model = app_handle.path().resolve(
            &format!("resources/models/{}", default_model.file_name),
            tauri::path::BaseDirectory::Resource,
        );
        if let Ok(bundled_model) = bundled_model {
            if bundled_model.exists() {
                if let Some(parent) = model_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create model dir: {}", e))?;
                }
                std::fs::copy(&bundled_model, model_path)
                    .map_err(|e| format!("Failed to copy bundled model: {}", e))?;
                copied_any = true;
            }
        }
    }

    Ok(copied_any)
}

fn bundled_llm_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let dir = "resources/llm/macos";
    #[cfg(target_os = "windows")]
    let dir = "resources/llm/windows";
    #[cfg(target_os = "linux")]
    let dir = "resources/llm/linux";

    app_handle
        .path()
        .resolve(dir, tauri::path::BaseDirectory::Resource)
        .ok()
}

fn find_file_recursive(root: &Path, filename: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, filename) {
                return Some(found);
            }
        } else if path
            .file_name()
            .map(|name| name == filename)
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

fn copy_directory_files(source_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create destination dir: {}", e))?;
    for entry in
        std::fs::read_dir(source_dir).map_err(|e| format!("Failed to read source dir: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let dest_path = dest_dir.join(file_name);
        std::fs::copy(&path, &dest_path)
            .map_err(|e| format!("Failed to copy {:?}: {}", path, e))?;
    }
    Ok(())
}

fn copy_dir_recursive(source_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create destination dir: {}", e))?;
    for entry in
        std::fs::read_dir(source_dir).map_err(|e| format!("Failed to read source dir: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let path = entry.path();
        let dest_path = dest_dir.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else {
            std::fs::copy(&path, &dest_path)
                .map_err(|e| format!("Failed to copy {:?}: {}", path, e))?;
        }
    }
    Ok(())
}
fn set_stage(manager: &Arc<LocalLlmManager>, stage: Option<&str>) {
    if let Ok(mut state) = manager.download_state.lock() {
        state.stage = stage.map(|value| value.to_string());
    }
}

fn set_download_model(manager: &Arc<LocalLlmManager>, model_id: Option<&str>) {
    if let Ok(mut state) = manager.download_state.lock() {
        state.model_id = model_id.map(|value| value.to_string());
    }
}

fn update_progress(manager: &Arc<LocalLlmManager>, downloaded: u64, total: u64) {
    if let Ok(mut state) = manager.download_state.lock() {
        state.downloaded_bytes = downloaded;
        state.total_bytes = total;
    }
}

fn clear_progress(manager: &Arc<LocalLlmManager>) {
    if let Ok(mut state) = manager.download_state.lock() {
        state.downloaded_bytes = 0;
        state.total_bytes = 0;
    }
}
