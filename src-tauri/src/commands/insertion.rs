use crate::managers::insertion::InsertionManager;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
#[specta::specta]
pub fn undo_last_insertion(
    app_handle: AppHandle,
    insertion_manager: State<'_, Arc<InsertionManager>>,
) -> Result<(), String> {
    insertion_manager.undo_last(&app_handle)
}
