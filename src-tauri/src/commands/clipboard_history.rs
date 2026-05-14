use crate::managers::clipboard_history::{
    ClipboardHistoryClearRange, ClipboardHistoryContentKind, ClipboardHistoryEntry,
    ClipboardHistoryEntryMedia, ClipboardHistoryEntrySummary, ClipboardHistoryManager,
};
use crate::managers::history::{HistoryAppFilterOption, HistoryAppFilterType};
use crate::settings;
use log::info;
use std::sync::Arc;
use std::time::Duration;
use tauri::{image::Image, AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[tauri::command]
#[specta::specta]
pub fn get_clipboard_history_entries(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
) -> Result<Vec<ClipboardHistoryEntry>, String> {
    Ok(history_manager.get_entries())
}

#[tauri::command]
#[specta::specta]
pub fn get_clipboard_history_entries_page(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    offset: usize,
    limit: usize,
) -> Result<Vec<ClipboardHistoryEntry>, String> {
    Ok(history_manager.get_page_entries(offset, limit))
}

#[tauri::command]
#[specta::specta]
pub fn get_clipboard_history_entries_page_summary(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    offset: usize,
    limit: usize,
) -> Result<Vec<ClipboardHistoryEntrySummary>, String> {
    Ok(history_manager.get_page_entry_summaries(offset, limit))
}

#[tauri::command]
#[specta::specta]
pub fn get_clipboard_history_entries_page_for_app(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    offset: usize,
    limit: usize,
    filter_type: HistoryAppFilterType,
    filter_value: String,
) -> Result<Vec<ClipboardHistoryEntry>, String> {
    Ok(history_manager.get_page_entries_for_app(offset, limit, filter_type, filter_value))
}

#[tauri::command]
#[specta::specta]
pub fn get_clipboard_history_entries_page_summary_for_app(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    offset: usize,
    limit: usize,
    filter_type: HistoryAppFilterType,
    filter_value: String,
) -> Result<Vec<ClipboardHistoryEntrySummary>, String> {
    Ok(history_manager.get_page_entry_summaries_for_app(offset, limit, filter_type, filter_value))
}

#[tauri::command]
#[specta::specta]
pub fn get_clipboard_history_app_filter_options(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
) -> Result<Vec<HistoryAppFilterOption>, String> {
    Ok(history_manager.get_app_filter_options())
}

#[tauri::command]
#[specta::specta]
pub fn get_clipboard_history_entry_text(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    id: u64,
) -> Result<Option<String>, String> {
    Ok(history_manager.get_entry_text_by_id(id))
}

#[tauri::command]
#[specta::specta]
pub fn get_clipboard_history_entry_media(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    id: u64,
) -> Result<Option<ClipboardHistoryEntryMedia>, String> {
    Ok(history_manager.get_entry_media_by_id(id))
}

#[tauri::command]
#[specta::specta]
pub fn copy_clipboard_history_entry(
    app: AppHandle,
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    id: u64,
) -> Result<(), String> {
    let entry = history_manager
        .get_entry_by_id(id)
        .ok_or_else(|| "Clipboard entry not found".to_string())?;

    history_manager.suspend_tracking(Duration::from_millis(1500));
    history_manager.mark_content_hash_seen(&entry.content_hash);
    history_manager.record_activity_now();

    match entry.content_kind {
        ClipboardHistoryContentKind::Text => {
            let text = history_manager
                .get_entry_text_by_id(id)
                .ok_or_else(|| "Clipboard entry not found".to_string())?;
            if entry.content_hash.trim().is_empty() {
                history_manager.mark_text_seen(&text);
            }
            app.clipboard()
                .write_text(text)
                .map_err(|err| err.to_string())
        }
        ClipboardHistoryContentKind::Image => {
            let image_data = history_manager
                .get_entry_image_data_by_id(id)
                .ok_or_else(|| "Clipboard image entry not found".to_string())?;
            history_manager.mark_content_hash_seen(&image_data.content_hash);
            let image = Image::new_owned(image_data.rgba, image_data.width, image_data.height);
            app.clipboard()
                .write_image(&image)
                .map_err(|err| err.to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn clear_clipboard_history(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
) -> Result<(), String> {
    history_manager.clear()
}

#[tauri::command]
#[specta::specta]
pub fn clear_clipboard_history_range(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    range: ClipboardHistoryClearRange,
) -> Result<(), String> {
    history_manager.clear_range(range)
}

#[tauri::command]
#[specta::specta]
pub fn delete_clipboard_history_entry(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    id: u64,
) -> Result<(), String> {
    history_manager.delete_entry(id)
}

#[tauri::command]
#[specta::specta]
pub async fn paste_clipboard_history_entry(
    app: AppHandle,
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    id: u64,
) -> Result<(), String> {
    let entry = history_manager
        .get_entry_by_id(id)
        .ok_or_else(|| "Clipboard entry not found".to_string())?;

    crate::clipboard_overlay::hide_clipboard_overlay(&app);
    crate::clipboard_overlay::restore_previous_frontmost_app();
    tokio::time::sleep(Duration::from_millis(120)).await;
    history_manager.suspend_tracking(Duration::from_millis(1500));
    history_manager.mark_content_hash_seen(&entry.content_hash);
    history_manager.record_activity_now();
    match entry.content_kind {
        ClipboardHistoryContentKind::Text => {
            crate::clipboard::paste_clipboard_history(entry.text, app)?;
        }
        ClipboardHistoryContentKind::Image => {
            let image_data = history_manager
                .get_entry_image_data_by_id(id)
                .ok_or_else(|| "Clipboard image entry not found".to_string())?;
            history_manager.mark_content_hash_seen(&image_data.content_hash);
            crate::clipboard::paste_clipboard_history_image(
                image_data.rgba,
                image_data.width,
                image_data.height,
                app,
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn paste_clipboard_quick_paste_text(
    app: AppHandle,
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Quick paste text cannot be empty".to_string());
    }

    history_manager.suspend_tracking(Duration::from_millis(1500));
    history_manager.record_activity_now();
    let expected_focus_context = crate::clipboard_overlay::previous_focus_context();
    let expected_pid = expected_focus_context
        .as_ref()
        .and_then(|context| context.process_id);

    info!(
        "Pasting clipboard quick key text ({} chars)",
        text.chars().count()
    );

    crate::clipboard_overlay::hide_clipboard_overlay(&app);
    crate::clipboard_overlay::restore_previous_frontmost_app();
    tokio::time::sleep(Duration::from_millis(120)).await;

    if let Some(pid) = expected_pid {
        for attempt in 0..18 {
            if crate::focus_context::frontmost_process_id() == Some(pid) {
                break;
            }
            if attempt == 6 {
                crate::clipboard_overlay::restore_previous_frontmost_app();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    } else {
        tokio::time::sleep(Duration::from_millis(90)).await;
    }

    tokio::time::sleep(Duration::from_millis(40)).await;

    let mut outcome = crate::clipboard::paste_with_focus_context(
        text.clone(),
        app.clone(),
        expected_focus_context.clone(),
    )?;
    if outcome == crate::clipboard::PasteOutcome::ClipboardOnly {
        crate::clipboard_overlay::restore_previous_frontmost_app();
        tokio::time::sleep(Duration::from_millis(80)).await;
        crate::clipboard::paste_clipboard_history(text, app)?;
        outcome = crate::clipboard::PasteOutcome::Pasted;
    }
    info!("Quick key paste outcome: {:?}", outcome);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn hide_clipboard_overlay(app: AppHandle) -> Result<(), String> {
    crate::clipboard_overlay::hide_clipboard_overlay(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn is_clipboard_recently_active(
    history_manager: State<'_, Arc<ClipboardHistoryManager>>,
    idle_ms: u64,
) -> Result<bool, String> {
    Ok(history_manager.is_recently_active(idle_ms))
}

#[tauri::command]
#[specta::specta]
pub fn set_clipboard_overlay_position(
    app: AppHandle,
    position: settings::WindowPosition,
) -> Result<(), String> {
    let mut settings = settings::get_settings(&app);
    settings.clipboard_overlay_position = Some(position);
    settings::write_settings(&app, settings);
    Ok(())
}
