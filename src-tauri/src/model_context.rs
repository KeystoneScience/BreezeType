use crate::managers::clipboard_history::ClipboardHistoryEntry;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MODEL_CONTEXT_DIR_NAME: &str = "mcp";
const MANIFEST_FILE_NAME: &str = "manifest.json";
const TASKS_SNAPSHOT_FILE_NAME: &str = "tasks.json";
const CLIPBOARD_SNAPSHOT_FILE_NAME: &str = "clipboard.json";

fn timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create model context directory '{}': {}",
                parent.display(),
                err
            )
        })?;
    }
    Ok(())
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    ensure_parent_dir(path)?;
    let data = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("Failed to serialize model context JSON: {}", err))?;
    fs::write(path, data).map_err(|err| {
        format!(
            "Failed to write model context file '{}': {}",
            path.display(),
            err
        )
    })
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve BreezeType app data directory: {}", err))
}

fn model_context_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(MODEL_CONTEXT_DIR_NAME))
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(model_context_dir(app)?.join(MANIFEST_FILE_NAME))
}

fn tasks_snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(model_context_dir(app)?.join(TASKS_SNAPSHOT_FILE_NAME))
}

fn clipboard_snapshot_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(model_context_dir(app)?.join(CLIPBOARD_SNAPSHOT_FILE_NAME))
}

fn build_manifest(app: &AppHandle) -> Result<Value, String> {
    let app_data = app_data_dir(app)?;
    let tasks_path = tasks_snapshot_path(app)?;
    let clipboard_path = clipboard_snapshot_path(app)?;

    Ok(json!({
        "schemaVersion": 1,
        "generatedAt": timestamp_ms(),
        "appDataDir": app_data,
        "server": {
            "name": "breeze-local-context",
            "version": 1,
            "transport": "stdio",
            "entrypointScript": "scripts/breeze-mcp.mjs",
            "description": "Read-only MCP surface for local BreezeType tasks, clipboard history, transcription history, and meeting data."
        },
        "datasets": {
            "tasks": {
                "kind": "json",
                "path": tasks_path,
                "readOnly": true,
                "description": "Snapshot of BreezeType tasks, habits, smart filters, and focus sessions mirrored from the local tasks store."
            },
            "clipboard": {
                "kind": "json",
                "path": clipboard_path,
                "readOnly": true,
                "sessionScoped": true,
                "limit": 38,
                "description": "Recent clipboard entries captured by the running BreezeType app session."
            },
            "history": {
                "kind": "sqlite",
                "path": app_data.join("history.db"),
                "table": "transcription_history",
                "readOnly": true,
                "description": "Voice transcription history, including post-processed text and source-app metadata."
            },
            "meetings": {
                "kind": "sqlite",
                "path": app_data.join("meetings.db"),
                "tables": ["meetings", "meeting_transcripts", "meeting_notes", "participants", "meeting_participants", "tags", "meeting_tags"],
                "readOnly": true,
                "description": "Meeting metadata, transcripts, notes, tags, and participant relationships."
            }
        },
        "resourceUris": [
            "breeze://manifest",
            "breeze://tasks/all",
            "breeze://clipboard/recent",
            "breeze://history/recent",
            "breeze://meetings/recent",
            "breeze://history/entry/{id}",
            "breeze://meetings/{id}",
            "breeze://meetings/{id}/transcript"
        ],
        "toolNames": [
            "list_tasks",
            "search_tasks",
            "list_clipboard_history",
            "search_clipboard_history",
            "list_transcription_history",
            "search_transcription_history",
            "list_meetings",
            "search_meetings"
        ]
    }))
}

fn write_default_tasks_snapshot(app: &AppHandle) -> Result<(), String> {
    let path = tasks_snapshot_path(app)?;
    if path.exists() {
        return Ok(());
    }
    write_json_file(
        &path,
        &json!({
            "schemaVersion": 1,
            "updatedAt": timestamp_ms(),
            "tasks": [],
            "habits": [],
            "smartFilters": [],
            "focusSessions": []
        }),
    )
}

pub fn sync_clipboard_snapshot(
    app: &AppHandle,
    entries: &[ClipboardHistoryEntry],
) -> Result<(), String> {
    let path = clipboard_snapshot_path(app)?;
    write_json_file(
        &path,
        &json!({
            "schemaVersion": 1,
            "updatedAt": timestamp_ms(),
            "entries": entries
        }),
    )?;
    refresh_manifest(app)
}

pub fn refresh_manifest(app: &AppHandle) -> Result<(), String> {
    let path = manifest_path(app)?;
    let manifest = build_manifest(app)?;
    write_json_file(&path, &manifest)
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    write_default_tasks_snapshot(app)?;
    sync_clipboard_snapshot(app, &[])
}

#[tauri::command]
#[specta::specta]
pub fn sync_tasks_snapshot(app: AppHandle, snapshot: String) -> Result<(), String> {
    let path = tasks_snapshot_path(&app)?;
    let parsed: serde_json::Value = serde_json::from_str(&snapshot)
        .map_err(|err| format!("Failed to parse tasks snapshot JSON: {}", err))?;
    write_json_file(&path, &parsed)?;
    refresh_manifest(&app)
}
