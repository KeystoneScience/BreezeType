use crate::managers::history::{HistoryManager, NoteEntry};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub async fn get_notes(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<Vec<NoteEntry>, String> {
    history_manager.get_notes().await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn create_note(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    title: String,
    body: String,
) -> Result<NoteEntry, String> {
    history_manager
        .create_note(title, body)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_note(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
    title: String,
    body: String,
) -> Result<NoteEntry, String> {
    history_manager
        .update_note(id, title, body)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_note(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: i64,
) -> Result<(), String> {
    history_manager
        .delete_note(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn set_active_note(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
    id: Option<i64>,
) -> Result<(), String> {
    history_manager.set_active_note_id(id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_active_note(
    _app: AppHandle,
    history_manager: State<'_, Arc<HistoryManager>>,
) -> Result<Option<i64>, String> {
    Ok(history_manager.get_active_note_id())
}
