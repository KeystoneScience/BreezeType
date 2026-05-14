use crate::managers::local_llm::{LocalLlmManager, LocalLlmStatus};
use crate::settings;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub fn get_local_llm_status(
    app_handle: AppHandle,
    local_llm: State<'_, Arc<LocalLlmManager>>,
) -> Result<LocalLlmStatus, String> {
    let settings = settings::get_settings(&app_handle);
    let selected_model_id = settings
        .post_process_models
        .get("local_llama")
        .map(String::as_str)
        .unwrap_or("");
    if settings.post_process_provider_id == "local_llama" {
        local_llm.ensure_assets_async(&app_handle, selected_model_id);
        local_llm.ensure_running_async(&app_handle, selected_model_id);
    }
    Ok(local_llm.status(&app_handle, selected_model_id))
}
