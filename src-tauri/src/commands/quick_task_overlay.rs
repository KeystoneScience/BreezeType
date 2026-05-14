use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct QuickTaskRequest {
    pub title: String,
    pub due_at: Option<i64>,
    pub priority: Option<u8>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    pub important: Option<bool>,
    pub urgent: Option<bool>,
    pub recurrence: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn hide_quick_task_overlay(app: AppHandle) -> Result<(), String> {
    crate::quick_task_overlay::hide_quick_task_overlay(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_quick_task_overlay(app: AppHandle) -> Result<(), String> {
    crate::quick_task_overlay::dismiss_quick_task_overlay(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn submit_quick_task(app: AppHandle, request: QuickTaskRequest) -> Result<(), String> {
    if request.title.trim().is_empty() {
        return Err("Task title cannot be empty".to_string());
    }

    app.emit("quick-task-create", request)
        .map_err(|e| format!("Failed to emit quick task event: {}", e))?;

    crate::quick_task_overlay::hide_quick_task_overlay(&app);
    Ok(())
}
