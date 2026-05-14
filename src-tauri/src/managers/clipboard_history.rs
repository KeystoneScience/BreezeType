use base64::{engine::general_purpose, Engine as _};
use log::{debug, error};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{image::Image, AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::managers::history::{HistoryAppFilterOption, HistoryAppFilterType};

const CLIPBOARD_POLL_INTERVAL_MS: u64 = 400;
const CLIPBOARD_RECENT_HISTORY_LIMIT: usize = 38;
const CLIPBOARD_PAGE_QUERY_LIMIT: usize = 200;
const CLIPBOARD_MAX_ENTRY_CHARS: usize = 20_000;
const CLIPBOARD_MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const CLIPBOARD_MAX_PERSISTED_IMAGE_ENTRIES: usize = 200;
const CLIPBOARD_MAX_PERSISTED_IMAGE_BYTES: u64 = 512 * 1024 * 1024;
const CLIPBOARD_PAGE_PREVIEW_CHARS: usize = 600;
const CLIPBOARD_IMAGE_PREVIEW_MAX_DIMENSION: u32 = 640;
const CLIPBOARD_IMAGE_POLL_BACKOFF_MS: u64 = 1200;
const CLIPBOARD_DAY_MS: i64 = 24 * 60 * 60 * 1000;
const CLIPBOARD_WEEK_MS: i64 = 7 * CLIPBOARD_DAY_MS;
const CLIPBOARD_IMAGE_FILE_EXTENSION: &str = "rgba";

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardHistoryContentKind {
    Text,
    Image,
}

impl ClipboardHistoryContentKind {
    fn as_str(&self) -> &'static str {
        match self {
            ClipboardHistoryContentKind::Text => "text",
            ClipboardHistoryContentKind::Image => "image",
        }
    }

    fn from_db(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "image" => ClipboardHistoryContentKind::Image,
            _ => ClipboardHistoryContentKind::Text,
        }
    }
}

fn default_clipboard_content_kind() -> ClipboardHistoryContentKind {
    ClipboardHistoryContentKind::Text
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardHistoryClearRange {
    PastDay,
    PastWeek,
    All,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ClipboardHistoryEntry {
    pub id: u64,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default = "default_clipboard_content_kind")]
    pub content_kind: ClipboardHistoryContentKind,
    pub text: String,
    pub timestamp: i64,
    pub source_app_name: Option<String>,
    pub source_app_identifier: Option<String>,
    #[serde(default)]
    pub media_width: Option<u32>,
    #[serde(default)]
    pub media_height: Option<u32>,
    #[serde(default)]
    pub media_byte_len: Option<u64>,
}

/// A lightweight clipboard entry optimized for the Clipboard history page.
/// Avoids sending full clipboard text over IPC until the user copies an entry.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ClipboardHistoryEntrySummary {
    pub id: u64,
    pub content_hash: String,
    pub content_kind: ClipboardHistoryContentKind,
    pub text: String,
    pub timestamp: i64,
    pub source_app_name: Option<String>,
    pub source_app_identifier: Option<String>,
    pub media_width: Option<u32>,
    pub media_height: Option<u32>,
    pub media_byte_len: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ClipboardHistoryEntryMedia {
    pub content_kind: ClipboardHistoryContentKind,
    pub image_data_base64: Option<String>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
}

pub struct ClipboardHistoryImageData {
    pub content_hash: String,
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

struct ClipboardHistoryMediaMetadata {
    content_hash: String,
    content_kind: ClipboardHistoryContentKind,
    media_file_name: Option<String>,
    media_width: Option<u32>,
    media_height: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ClipboardSnapshot {
    entries: Vec<ClipboardHistoryEntry>,
}

pub struct ClipboardHistoryManager {
    app_handle: AppHandle,
    db_path: PathBuf,
    media_dir: PathBuf,
    entries: Mutex<Vec<ClipboardHistoryEntry>>,
    last_seen: Mutex<Option<String>>,
    suspend_until: Mutex<Option<Instant>>,
    image_poll_backoff_until: Mutex<Option<Instant>>,
    last_activity_at_ms: AtomicU64,
    next_id: AtomicU64,
}

impl ClipboardHistoryManager {
    pub fn new(app_handle: &AppHandle) -> Self {
        let app_data_dir = match app_handle.path().app_data_dir() {
            Ok(dir) => dir,
            Err(err) => {
                error!(
                    "Failed to resolve app data dir for clipboard history: {}. Falling back to temp directory.",
                    err
                );
                std::env::temp_dir().join("breezetype")
            }
        };

        if let Err(err) = fs::create_dir_all(&app_data_dir) {
            error!(
                "Failed to create app data directory for clipboard history '{}': {}",
                app_data_dir.display(),
                err
            );
        }

        let media_dir = app_data_dir.join("clipboard_media");
        if let Err(err) = fs::create_dir_all(&media_dir) {
            error!(
                "Failed to create clipboard media directory '{}': {}",
                media_dir.display(),
                err
            );
        }

        let db_path = app_data_dir.join("clipboard_history.db");
        if let Err(err) = init_clipboard_history_database(&db_path) {
            error!("Failed to initialize clipboard history database: {}", err);
        }

        let mut recent_entries = load_recent_persisted_entries(&db_path).unwrap_or_else(|err| {
            error!("Failed to load recent persisted clipboard history: {}", err);
            Vec::new()
        });
        if recent_entries.is_empty() {
            recent_entries = load_clipboard_snapshot_entries(&app_data_dir).unwrap_or_else(|err| {
                debug!(
                    "No clipboard snapshot available for persistence seed: {}",
                    err
                );
                Vec::new()
            });
            for entry in &mut recent_entries {
                normalize_entry_metadata(entry);
                if let Err(err) = persist_entry(&db_path, entry, None) {
                    error!("Failed to seed persisted clipboard history: {}", err);
                    break;
                }
            }
        }
        recent_entries.iter_mut().for_each(normalize_entry_metadata);
        let last_seen = recent_entries
            .first()
            .map(|entry| content_hash_for_entry(entry));
        let next_id = load_next_clipboard_history_id(&db_path).unwrap_or_else(|err| {
            error!("Failed to load clipboard history id cursor: {}", err);
            recent_entries
                .iter()
                .map(|entry| entry.id)
                .max()
                .unwrap_or(0)
                .saturating_add(1)
        });

        Self {
            app_handle: app_handle.clone(),
            db_path,
            media_dir,
            entries: Mutex::new(recent_entries),
            last_seen: Mutex::new(last_seen),
            suspend_until: Mutex::new(None),
            image_poll_backoff_until: Mutex::new(None),
            last_activity_at_ms: AtomicU64::new(current_timestamp_ms().max(0) as u64),
            next_id: AtomicU64::new(next_id),
        }
    }

    pub fn suspend_tracking(&self, duration: Duration) {
        let mut suspended = lock_recover(&self.suspend_until, "clipboard history suspend_until");
        *suspended = Some(Instant::now() + duration);
    }

    pub fn mark_text_seen(&self, text: &str) {
        self.mark_content_hash_seen(&hash_clipboard_text(text));
    }

    pub fn mark_content_hash_seen(&self, content_hash: &str) {
        let content_hash = content_hash.trim();
        if content_hash.is_empty() {
            return;
        }

        let mut last_seen = lock_recover(&self.last_seen, "clipboard history last_seen");
        *last_seen = Some(content_hash.to_string());
    }

    pub fn record_activity_now(&self) {
        self.last_activity_at_ms
            .store(current_timestamp_ms().max(0) as u64, Ordering::SeqCst);
    }

    pub fn is_recently_active(&self, idle_ms: u64) -> bool {
        let last_activity_at_ms = self.last_activity_at_ms.load(Ordering::SeqCst);
        if last_activity_at_ms == 0 {
            return false;
        }

        let now = current_timestamp_ms().max(0) as u64;
        now.saturating_sub(last_activity_at_ms) < idle_ms
    }

    pub fn start_monitoring(manager: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                if let Err(err) = manager.poll_clipboard_once() {
                    debug!("Clipboard poll failed: {}", err);
                }
                tokio::time::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS)).await;
            }
        });
    }

    pub fn get_entries(&self) -> Vec<ClipboardHistoryEntry> {
        let entries = lock_recover(&self.entries, "clipboard history entries");
        entries.clone()
    }

    pub fn get_page_entries(&self, offset: usize, limit: usize) -> Vec<ClipboardHistoryEntry> {
        if limit == 0 {
            return Vec::new();
        }

        let limit = limit.min(CLIPBOARD_PAGE_QUERY_LIMIT);
        load_entries_page(&self.db_path, offset, limit).unwrap_or_else(|err| {
            error!("Failed to load clipboard history page: {}", err);
            let entries = lock_recover(&self.entries, "clipboard history entries");
            entries.iter().skip(offset).take(limit).cloned().collect()
        })
    }

    pub fn get_page_entry_summaries(
        &self,
        offset: usize,
        limit: usize,
    ) -> Vec<ClipboardHistoryEntrySummary> {
        if limit == 0 {
            return Vec::new();
        }

        let limit = limit.min(CLIPBOARD_PAGE_QUERY_LIMIT);
        load_entry_summaries_page(&self.db_path, offset, limit).unwrap_or_else(|err| {
            error!("Failed to load clipboard history summary page: {}", err);
            let entries = lock_recover(&self.entries, "clipboard history entries");
            entries
                .iter()
                .skip(offset)
                .take(limit)
                .map(summarize_clipboard_entry)
                .collect()
        })
    }

    pub fn get_page_entries_for_app(
        &self,
        offset: usize,
        limit: usize,
        filter_type: HistoryAppFilterType,
        filter_value: String,
    ) -> Vec<ClipboardHistoryEntry> {
        if limit == 0 {
            return Vec::new();
        }

        let Some(filter_value) = normalize_app_option_value(&filter_value) else {
            return Vec::new();
        };

        let limit = limit.min(CLIPBOARD_PAGE_QUERY_LIMIT);
        load_entries_page_for_app(&self.db_path, offset, limit, filter_type, &filter_value)
            .unwrap_or_else(|err| {
                error!("Failed to load filtered clipboard history page: {}", err);
                Vec::new()
            })
    }

    pub fn get_page_entry_summaries_for_app(
        &self,
        offset: usize,
        limit: usize,
        filter_type: HistoryAppFilterType,
        filter_value: String,
    ) -> Vec<ClipboardHistoryEntrySummary> {
        if limit == 0 {
            return Vec::new();
        }

        let Some(filter_value) = normalize_app_option_value(&filter_value) else {
            return Vec::new();
        };

        let limit = limit.min(CLIPBOARD_PAGE_QUERY_LIMIT);
        load_entry_summaries_page_for_app(&self.db_path, offset, limit, filter_type, &filter_value)
            .unwrap_or_else(|err| {
                error!(
                    "Failed to load filtered clipboard history summary page: {}",
                    err
                );
                Vec::new()
            })
    }

    pub fn get_app_filter_options(&self) -> Vec<HistoryAppFilterOption> {
        load_app_filter_options(&self.db_path).unwrap_or_else(|err| {
            error!("Failed to load clipboard app filter options: {}", err);
            Vec::new()
        })
    }

    pub fn clear(&self) -> Result<(), String> {
        self.clear_range(ClipboardHistoryClearRange::All)
    }

    pub fn delete_entry(&self, id: u64) -> Result<(), String> {
        let media_file_names = delete_persisted_entry_by_id(&self.db_path, id)
            .map_err(|err| format!("Failed to delete clipboard history entry: {}", err))?;
        delete_media_files(&self.media_dir, media_file_names);

        let next_entries = load_recent_persisted_entries(&self.db_path).map_err(|err| {
            format!(
                "Failed to reload clipboard history after deleting entry: {}",
                err
            )
        })?;

        {
            let mut entries = lock_recover(&self.entries, "clipboard history entries");
            *entries = next_entries;
        }

        {
            let entries = lock_recover(&self.entries, "clipboard history entries");
            if let Err(err) =
                crate::model_context::sync_clipboard_snapshot(&self.app_handle, &entries)
            {
                return Err(format!("Failed to sync clipboard snapshot: {}", err));
            }
        }

        let _ = self.app_handle.emit("clipboard-history-updated", ());
        Ok(())
    }

    pub fn clear_range(&self, range: ClipboardHistoryClearRange) -> Result<(), String> {
        let media_file_names = clear_persisted_entries_for_range(&self.db_path, range)
            .map_err(|err| format!("Failed to clear persisted clipboard history: {}", err))?;
        delete_media_files(&self.media_dir, media_file_names);

        let next_entries = load_recent_persisted_entries(&self.db_path)
            .map_err(|err| format!("Failed to reload clipboard history after clear: {}", err))?;

        {
            let mut entries = lock_recover(&self.entries, "clipboard history entries");
            *entries = next_entries;
        }

        {
            let mut last_seen = lock_recover(&self.last_seen, "clipboard history last_seen");
            *last_seen = None;
        }
        self.remember_current_clipboard_content();

        {
            let entries = lock_recover(&self.entries, "clipboard history entries");
            if let Err(err) =
                crate::model_context::sync_clipboard_snapshot(&self.app_handle, &entries)
            {
                return Err(format!("Failed to sync clipboard snapshot: {}", err));
            }
        }

        let _ = self.app_handle.emit("clipboard-history-updated", ());
        Ok(())
    }

    pub fn get_entry_by_id(&self, id: u64) -> Option<ClipboardHistoryEntry> {
        {
            let entries = lock_recover(&self.entries, "clipboard history entries");
            if let Some(entry) = entries.iter().find(|entry| entry.id == id).cloned() {
                return Some(entry);
            }
        }

        load_entry_by_id(&self.db_path, id).unwrap_or_else(|err| {
            error!("Failed to load clipboard history entry by id: {}", err);
            None
        })
    }

    pub fn get_entry_text_by_id(&self, id: u64) -> Option<String> {
        {
            let entries = lock_recover(&self.entries, "clipboard history entries");
            if let Some(text) = entries
                .iter()
                .find(|entry| entry.id == id)
                .map(|entry| entry.text.clone())
            {
                return Some(text);
            }
        }

        load_entry_text_by_id(&self.db_path, id).unwrap_or_else(|err| {
            error!("Failed to load clipboard history entry text by id: {}", err);
            None
        })
    }

    pub fn get_entry_media_by_id(&self, id: u64) -> Option<ClipboardHistoryEntryMedia> {
        let image_data = self.get_entry_image_data_by_id(id)?;
        let (preview_rgba, preview_width, preview_height) = thumbnail_rgba(
            &image_data.rgba,
            image_data.width,
            image_data.height,
            CLIPBOARD_IMAGE_PREVIEW_MAX_DIMENSION,
        );
        Some(ClipboardHistoryEntryMedia {
            content_kind: ClipboardHistoryContentKind::Image,
            image_data_base64: Some(general_purpose::STANDARD.encode(preview_rgba)),
            image_width: Some(preview_width),
            image_height: Some(preview_height),
        })
    }

    pub fn get_entry_image_data_by_id(&self, id: u64) -> Option<ClipboardHistoryImageData> {
        let metadata = load_entry_media_metadata(&self.db_path, id).unwrap_or_else(|err| {
            error!("Failed to load clipboard history media metadata: {}", err);
            None
        })?;

        if metadata.content_kind != ClipboardHistoryContentKind::Image {
            return None;
        }

        let media_file_name = metadata.media_file_name?;
        let media_path = media_path(&self.media_dir, &media_file_name)?;
        let rgba = fs::read(&media_path)
            .map_err(|err| {
                error!(
                    "Failed to read clipboard image media '{}': {}",
                    media_path.display(),
                    err
                );
            })
            .ok()?;
        let width = metadata.media_width?;
        let height = metadata.media_height?;

        Some(ClipboardHistoryImageData {
            content_hash: metadata.content_hash,
            rgba,
            width,
            height,
        })
    }

    fn poll_clipboard_once(&self) -> Result<(), String> {
        let clipboard = self.app_handle.clipboard();
        if let Ok(text) = clipboard.read_text() {
            if self.maybe_store_text(text) {
                return Ok(());
            }
        }

        if !self.should_skip_image_poll() {
            if let Ok(image) = clipboard.read_image() {
                self.maybe_store_image(image);
                self.backoff_image_poll();
            }
        }
        Ok(())
    }

    fn should_skip_tracking(&self) -> bool {
        let mut suspended = lock_recover(&self.suspend_until, "clipboard history suspend_until");
        if let Some(until) = *suspended {
            if Instant::now() < until {
                return true;
            }
            *suspended = None;
        }
        false
    }

    fn mark_seen_if_new(&self, content_hash: &str) -> bool {
        let mut last_seen = lock_recover(&self.last_seen, "clipboard history last_seen");
        if last_seen.as_deref() == Some(content_hash) {
            return false;
        }
        *last_seen = Some(content_hash.to_string());
        true
    }

    fn should_skip_image_poll(&self) -> bool {
        let mut backoff = lock_recover(
            &self.image_poll_backoff_until,
            "clipboard history image_poll_backoff_until",
        );
        if let Some(until) = *backoff {
            if Instant::now() < until {
                return true;
            }
            *backoff = None;
        }
        false
    }

    fn backoff_image_poll(&self) {
        let mut backoff = lock_recover(
            &self.image_poll_backoff_until,
            "clipboard history image_poll_backoff_until",
        );
        *backoff = Some(Instant::now() + Duration::from_millis(CLIPBOARD_IMAGE_POLL_BACKOFF_MS));
    }

    fn maybe_store_text(&self, text: String) -> bool {
        if self.should_skip_tracking() {
            return true;
        }

        let normalized = text.trim();
        if normalized.is_empty() {
            return false;
        }
        if text.len() > CLIPBOARD_MAX_ENTRY_CHARS {
            debug!(
                "Clipboard entry too large ({} chars). Skipping.",
                text.len()
            );
            return false;
        }

        let content_hash = hash_clipboard_text(&text);
        if !self.mark_seen_if_new(&content_hash) {
            return true;
        }

        let (source_app_name, source_app_identifier) = active_source_app();
        let entry = ClipboardHistoryEntry {
            id: self.next_id.fetch_add(1, Ordering::SeqCst),
            content_hash,
            content_kind: ClipboardHistoryContentKind::Text,
            text,
            timestamp: current_timestamp_ms(),
            source_app_name,
            source_app_identifier,
            media_width: None,
            media_height: None,
            media_byte_len: None,
        };
        self.store_entry(entry, None);
        true
    }

    fn maybe_store_image(&self, image: Image<'_>) -> bool {
        if self.should_skip_tracking() {
            return true;
        }

        let width = image.width();
        let height = image.height();
        let rgba = image.rgba().to_vec();
        if width == 0 || height == 0 || rgba.is_empty() {
            return false;
        }
        if rgba.len() > CLIPBOARD_MAX_IMAGE_BYTES {
            debug!(
                "Clipboard image too large ({} bytes). Skipping image history entry.",
                rgba.len()
            );
            return false;
        }

        let content_hash = hash_clipboard_image(&rgba, width, height);
        if !self.mark_seen_if_new(&content_hash) {
            return true;
        }

        let media_file_name = media_file_name_for_hash(&content_hash);
        let Some(media_path) = media_path(&self.media_dir, &media_file_name) else {
            return true;
        };
        if let Err(err) = fs::write(&media_path, &rgba) {
            error!(
                "Failed to write clipboard image media '{}': {}",
                media_path.display(),
                err
            );
            return true;
        }

        let (source_app_name, source_app_identifier) = active_source_app();
        let entry = ClipboardHistoryEntry {
            id: self.next_id.fetch_add(1, Ordering::SeqCst),
            content_hash,
            content_kind: ClipboardHistoryContentKind::Image,
            text: clipboard_image_label(width, height),
            timestamp: current_timestamp_ms(),
            source_app_name,
            source_app_identifier,
            media_width: Some(width),
            media_height: Some(height),
            media_byte_len: Some(rgba.len() as u64),
        };
        self.store_entry(entry, Some(media_file_name.as_str()));
        true
    }

    fn store_entry(&self, entry: ClipboardHistoryEntry, media_file_name: Option<&str>) {
        self.record_activity_now();

        let mut entries = lock_recover(&self.entries, "clipboard history entries");
        entries.retain(|existing| content_hash_for_entry(existing) != entry.content_hash);
        entries.insert(0, entry.clone());
        if entries.len() > CLIPBOARD_RECENT_HISTORY_LIMIT {
            entries.truncate(CLIPBOARD_RECENT_HISTORY_LIMIT);
        }

        if let Err(err) = persist_entry(&self.db_path, &entry, media_file_name) {
            error!("Failed to persist clipboard history entry: {}", err);
        }
        if entry.content_kind == ClipboardHistoryContentKind::Image {
            match prune_persisted_image_entries(&self.db_path) {
                Ok(media_file_names) => delete_media_files(&self.media_dir, media_file_names),
                Err(err) => error!("Failed to prune persisted clipboard images: {}", err),
            }
        }

        if let Err(err) = crate::model_context::sync_clipboard_snapshot(&self.app_handle, &entries)
        {
            error!("Failed to sync clipboard snapshot: {}", err);
        }

        if let Err(err) = self.app_handle.emit("clipboard-history-updated", ()) {
            error!("Failed to emit clipboard-history-updated: {}", err);
        }
    }

    fn remember_current_clipboard_content(&self) {
        let clipboard = self.app_handle.clipboard();
        if let Ok(text) = clipboard.read_text() {
            let normalized = text.trim();
            if !normalized.is_empty() && text.len() <= CLIPBOARD_MAX_ENTRY_CHARS {
                self.mark_content_hash_seen(&hash_clipboard_text(&text));
                return;
            }
        }

        if let Ok(image) = clipboard.read_image() {
            let width = image.width();
            let height = image.height();
            let rgba = image.rgba();
            if width > 0
                && height > 0
                && !rgba.is_empty()
                && rgba.len() <= CLIPBOARD_MAX_IMAGE_BYTES
            {
                self.mark_content_hash_seen(&hash_clipboard_image(rgba, width, height));
            }
        }
    }
}

fn init_clipboard_history_database(db_path: &Path) -> rusqlite::Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS clipboard_history (
            id INTEGER PRIMARY KEY,
            content_hash TEXT,
            content_kind TEXT NOT NULL DEFAULT 'text',
            text TEXT NOT NULL DEFAULT '',
            timestamp INTEGER NOT NULL,
            source_app_name TEXT,
            source_app_identifier TEXT,
            media_file_name TEXT,
            media_width INTEGER,
            media_height INTEGER,
            media_byte_len INTEGER
        );",
    )?;

    ensure_clipboard_history_column(&conn, "content_hash", "TEXT")?;
    ensure_clipboard_history_column(&conn, "content_kind", "TEXT NOT NULL DEFAULT 'text'")?;
    ensure_clipboard_history_column(&conn, "media_file_name", "TEXT")?;
    ensure_clipboard_history_column(&conn, "media_width", "INTEGER")?;
    ensure_clipboard_history_column(&conn, "media_height", "INTEGER")?;
    ensure_clipboard_history_column(&conn, "media_byte_len", "INTEGER")?;
    backfill_clipboard_content_hashes(&conn)?;
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_clipboard_history_text;
        CREATE INDEX IF NOT EXISTS idx_clipboard_history_text
            ON clipboard_history(text);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clipboard_history_content_hash
            ON clipboard_history(content_hash)
            WHERE content_hash IS NOT NULL AND TRIM(content_hash) <> '';
        CREATE INDEX IF NOT EXISTS idx_clipboard_history_timestamp
            ON clipboard_history(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_clipboard_history_app_options
            ON clipboard_history(source_app_identifier, source_app_name, timestamp DESC);",
    )?;
    Ok(())
}

fn ensure_clipboard_history_column(
    conn: &Connection,
    column_name: &str,
    column_definition: &str,
) -> rusqlite::Result<()> {
    if clipboard_history_column_exists(conn, column_name)? {
        return Ok(());
    }

    conn.execute(
        &format!("ALTER TABLE clipboard_history ADD COLUMN {column_name} {column_definition}"),
        [],
    )?;
    Ok(())
}

fn clipboard_history_column_exists(conn: &Connection, column_name: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare("PRAGMA table_info(clipboard_history)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>("name"))?;
    for row in rows {
        if row?.eq_ignore_ascii_case(column_name) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn backfill_clipboard_content_hashes(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(text, '') AS text, COALESCE(content_kind, 'text') AS content_kind
         FROM clipboard_history
         WHERE content_hash IS NULL OR TRIM(content_hash) = ''",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>("id")?,
            row.get::<_, String>("text")?,
            row.get::<_, String>("content_kind")?,
        ))
    })?;

    let mut updates = Vec::new();
    for row in rows {
        let (id, text, content_kind) = row?;
        if ClipboardHistoryContentKind::from_db(&content_kind) == ClipboardHistoryContentKind::Text
        {
            updates.push((id, hash_clipboard_text(&text)));
        }
    }
    drop(stmt);

    for (id, content_hash) in updates {
        conn.execute(
            "UPDATE clipboard_history SET content_hash = ?1 WHERE id = ?2",
            params![content_hash, id],
        )?;
    }
    Ok(())
}

fn load_recent_persisted_entries(db_path: &Path) -> rusqlite::Result<Vec<ClipboardHistoryEntry>> {
    load_entries_page(db_path, 0, CLIPBOARD_RECENT_HISTORY_LIMIT)
}

fn clipboard_entry_select_columns() -> &'static str {
    "id,
     COALESCE(content_hash, '') AS content_hash,
     COALESCE(content_kind, 'text') AS content_kind,
     COALESCE(text, '') AS text,
     timestamp,
     source_app_name,
     source_app_identifier,
     media_width,
     media_height,
     media_byte_len"
}

fn load_entries_page(
    db_path: &Path,
    offset: usize,
    limit: usize,
) -> rusqlite::Result<Vec<ClipboardHistoryEntry>> {
    let conn = Connection::open(db_path)?;
    let sql = format!(
        "SELECT {}
         FROM clipboard_history
         ORDER BY timestamp DESC, id DESC
         LIMIT ?1 OFFSET ?2",
        clipboard_entry_select_columns()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit as i64, offset as i64], row_to_clipboard_entry)?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

fn load_entry_summaries_page(
    db_path: &Path,
    offset: usize,
    limit: usize,
) -> rusqlite::Result<Vec<ClipboardHistoryEntrySummary>> {
    Ok(load_entries_page(db_path, offset, limit)?
        .iter()
        .map(summarize_clipboard_entry)
        .collect())
}

fn load_entries_page_for_app(
    db_path: &Path,
    offset: usize,
    limit: usize,
    filter_type: HistoryAppFilterType,
    filter_value: &str,
) -> rusqlite::Result<Vec<ClipboardHistoryEntry>> {
    let conn = Connection::open(db_path)?;
    let sql = match filter_type {
        HistoryAppFilterType::Identifier => format!(
            "SELECT {}
             FROM clipboard_history
             WHERE LOWER(TRIM(source_app_identifier)) = LOWER(TRIM(?1))
             ORDER BY timestamp DESC, id DESC
             LIMIT ?2 OFFSET ?3",
            clipboard_entry_select_columns()
        ),
        HistoryAppFilterType::Name => format!(
            "SELECT {}
             FROM clipboard_history
             WHERE NULLIF(TRIM(source_app_identifier), '') IS NULL
               AND LOWER(TRIM(source_app_name)) = LOWER(TRIM(?1))
             ORDER BY timestamp DESC, id DESC
             LIMIT ?2 OFFSET ?3",
            clipboard_entry_select_columns()
        ),
    };

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        params![filter_value, limit as i64, offset as i64],
        row_to_clipboard_entry,
    )?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

fn load_entry_summaries_page_for_app(
    db_path: &Path,
    offset: usize,
    limit: usize,
    filter_type: HistoryAppFilterType,
    filter_value: &str,
) -> rusqlite::Result<Vec<ClipboardHistoryEntrySummary>> {
    Ok(
        load_entries_page_for_app(db_path, offset, limit, filter_type, filter_value)?
            .iter()
            .map(summarize_clipboard_entry)
            .collect(),
    )
}

fn load_app_filter_options(db_path: &Path) -> rusqlite::Result<Vec<HistoryAppFilterOption>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT filter_type, value, label, icon_identifier
         FROM (
            SELECT
                CASE
                    WHEN normalized_identifier IS NOT NULL THEN 'identifier'
                    ELSE 'name'
                END AS filter_type,
                COALESCE(normalized_identifier, normalized_name) AS value,
                COALESCE(normalized_name, normalized_identifier) AS label,
                normalized_identifier AS icon_identifier,
                timestamp,
                ROW_NUMBER() OVER (
                    PARTITION BY CASE
                        WHEN normalized_identifier IS NOT NULL
                            THEN 'identifier:' || LOWER(normalized_identifier)
                        ELSE 'name:' || LOWER(normalized_name)
                    END
                    ORDER BY timestamp DESC, id DESC
                ) AS row_number
            FROM (
                SELECT
                    id,
                    timestamp,
                    NULLIF(TRIM(source_app_name), '') AS normalized_name,
                    NULLIF(TRIM(source_app_identifier), '') AS normalized_identifier
                FROM clipboard_history
            )
            WHERE normalized_identifier IS NOT NULL OR normalized_name IS NOT NULL
         )
         WHERE row_number = 1
         ORDER BY timestamp DESC, label COLLATE NOCASE ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        let filter_type: String = row.get("filter_type")?;
        let filter_type = match filter_type.as_str() {
            "identifier" => HistoryAppFilterType::Identifier,
            _ => HistoryAppFilterType::Name,
        };

        Ok(HistoryAppFilterOption {
            filter_type,
            value: row.get("value")?,
            label: row.get("label")?,
            icon_identifier: row.get("icon_identifier")?,
        })
    })?;

    let mut options = Vec::new();
    for row in rows {
        options.push(row?);
    }
    Ok(options)
}

fn load_entry_by_id(db_path: &Path, id: u64) -> rusqlite::Result<Option<ClipboardHistoryEntry>> {
    let conn = Connection::open(db_path)?;
    let sql = format!(
        "SELECT {}
         FROM clipboard_history
         WHERE id = ?1",
        clipboard_entry_select_columns()
    );
    conn.query_row(&sql, params![id as i64], row_to_clipboard_entry)
        .optional()
}

fn load_entry_text_by_id(db_path: &Path, id: u64) -> rusqlite::Result<Option<String>> {
    let conn = Connection::open(db_path)?;
    conn.query_row(
        "SELECT text FROM clipboard_history WHERE id = ?1",
        params![id as i64],
        |row| row.get("text"),
    )
    .optional()
}

fn load_entry_media_metadata(
    db_path: &Path,
    id: u64,
) -> rusqlite::Result<Option<ClipboardHistoryMediaMetadata>> {
    let conn = Connection::open(db_path)?;
    conn.query_row(
        "SELECT
            COALESCE(content_hash, '') AS content_hash,
            COALESCE(content_kind, 'text') AS content_kind,
            media_file_name,
            media_width,
            media_height
         FROM clipboard_history
         WHERE id = ?1",
        params![id as i64],
        |row| {
            let content_kind: String = row.get("content_kind")?;
            Ok(ClipboardHistoryMediaMetadata {
                content_hash: row.get("content_hash")?,
                content_kind: ClipboardHistoryContentKind::from_db(&content_kind),
                media_file_name: row.get("media_file_name")?,
                media_width: row
                    .get::<_, Option<i64>>("media_width")?
                    .and_then(|value| u32::try_from(value).ok()),
                media_height: row
                    .get::<_, Option<i64>>("media_height")?
                    .and_then(|value| u32::try_from(value).ok()),
            })
        },
    )
    .optional()
}

fn row_to_clipboard_entry(row: &Row<'_>) -> rusqlite::Result<ClipboardHistoryEntry> {
    let id = row.get::<_, i64>("id")?;
    let content_kind: String = row.get("content_kind")?;
    let mut entry = ClipboardHistoryEntry {
        id: id.max(0) as u64,
        content_hash: row.get("content_hash")?,
        content_kind: ClipboardHistoryContentKind::from_db(&content_kind),
        text: row.get("text")?,
        timestamp: row.get("timestamp")?,
        source_app_name: row.get("source_app_name")?,
        source_app_identifier: row.get("source_app_identifier")?,
        media_width: row
            .get::<_, Option<i64>>("media_width")?
            .and_then(|value| u32::try_from(value).ok()),
        media_height: row
            .get::<_, Option<i64>>("media_height")?
            .and_then(|value| u32::try_from(value).ok()),
        media_byte_len: row
            .get::<_, Option<i64>>("media_byte_len")?
            .and_then(|value| u64::try_from(value).ok()),
    };
    normalize_entry_metadata(&mut entry);
    Ok(entry)
}

fn load_clipboard_snapshot_entries(
    app_data_dir: &Path,
) -> Result<Vec<ClipboardHistoryEntry>, String> {
    let path = app_data_dir.join("mcp").join("clipboard.json");
    let bytes =
        fs::read(&path).map_err(|err| format!("Failed to read '{}': {}", path.display(), err))?;
    let snapshot = serde_json::from_slice::<ClipboardSnapshot>(&bytes)
        .map_err(|err| format!("Failed to parse '{}': {}", path.display(), err))?;
    Ok(snapshot.entries)
}

fn load_next_clipboard_history_id(db_path: &Path) -> rusqlite::Result<u64> {
    let conn = Connection::open(db_path)?;
    let max_id = conn
        .query_row("SELECT MAX(id) FROM clipboard_history", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .optional()?
        .flatten()
        .unwrap_or(0)
        .max(0) as u64;
    Ok(max_id.saturating_add(1))
}

fn persist_entry(
    db_path: &Path,
    entry: &ClipboardHistoryEntry,
    media_file_name: Option<&str>,
) -> rusqlite::Result<()> {
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    let content_hash = content_hash_for_entry(entry);
    tx.execute(
        "DELETE FROM clipboard_history WHERE content_hash = ?1",
        params![&content_hash],
    )?;
    tx.execute(
        "INSERT INTO clipboard_history (
            id,
            content_hash,
            content_kind,
            text,
            timestamp,
            source_app_name,
            source_app_identifier,
            media_file_name,
            media_width,
            media_height,
            media_byte_len
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            entry.id as i64,
            content_hash,
            entry.content_kind.as_str(),
            &entry.text,
            entry.timestamp,
            entry.source_app_name.as_deref(),
            entry.source_app_identifier.as_deref(),
            media_file_name,
            entry.media_width.map(|value| value as i64),
            entry.media_height.map(|value| value as i64),
            entry
                .media_byte_len
                .and_then(|value| i64::try_from(value).ok()),
        ],
    )?;
    tx.commit()?;
    Ok(())
}

fn prune_persisted_image_entries(db_path: &Path) -> rusqlite::Result<Vec<String>> {
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    let pruned_rows = {
        let mut stmt = tx.prepare(
            "SELECT id, media_file_name, COALESCE(media_byte_len, 0) AS media_byte_len
             FROM clipboard_history
             WHERE content_kind = 'image'
             ORDER BY timestamp DESC, id DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let media_byte_len = row.get::<_, i64>("media_byte_len")?.try_into().unwrap_or(0);
            Ok((
                row.get::<_, i64>("id")?,
                row.get::<_, Option<String>>("media_file_name")?,
                media_byte_len,
            ))
        })?;

        let mut pruned_rows = Vec::new();
        let mut retained_count = 0usize;
        let mut retained_bytes = 0u64;
        for row in rows {
            let (id, media_file_name, media_byte_len) = row?;
            let can_retain_count = retained_count < CLIPBOARD_MAX_PERSISTED_IMAGE_ENTRIES;
            let can_retain_bytes = retained_bytes
                .checked_add(media_byte_len)
                .map(|total| total <= CLIPBOARD_MAX_PERSISTED_IMAGE_BYTES)
                .unwrap_or(false);

            if can_retain_count && can_retain_bytes {
                retained_count += 1;
                retained_bytes = retained_bytes.saturating_add(media_byte_len);
            } else {
                pruned_rows.push((id, media_file_name));
            }
        }
        pruned_rows
    };

    if pruned_rows.is_empty() {
        tx.commit()?;
        return Ok(Vec::new());
    }

    let ids: Vec<i64> = pruned_rows.iter().map(|(id, _)| *id).collect();
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    tx.execute(
        &format!("DELETE FROM clipboard_history WHERE id IN ({placeholders})"),
        params_from_iter(ids.iter()),
    )?;
    tx.commit()?;

    Ok(pruned_rows
        .into_iter()
        .filter_map(|(_, media_file_name)| media_file_name)
        .collect())
}

fn delete_persisted_entry_by_id(db_path: &Path, id: u64) -> rusqlite::Result<Vec<String>> {
    let id = i64::try_from(id).unwrap_or(i64::MAX);
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    let media_file_name = tx
        .query_row(
            "SELECT media_file_name FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>("media_file_name"),
        )
        .optional()?
        .flatten();
    tx.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(media_file_name.into_iter().collect())
}

fn clear_persisted_entries_for_range(
    db_path: &Path,
    range: ClipboardHistoryClearRange,
) -> rusqlite::Result<Vec<String>> {
    let mut conn = Connection::open(db_path)?;
    let tx = conn.transaction()?;
    let media_file_names = load_media_file_names_for_clear(&tx, range)?;
    match clear_cutoff_timestamp(range) {
        Some(cutoff) => {
            tx.execute(
                "DELETE FROM clipboard_history WHERE timestamp >= ?1",
                params![cutoff],
            )?;
        }
        None => {
            tx.execute("DELETE FROM clipboard_history", [])?;
        }
    }
    tx.commit()?;
    Ok(media_file_names)
}

fn load_media_file_names_for_clear(
    conn: &Connection,
    range: ClipboardHistoryClearRange,
) -> rusqlite::Result<Vec<String>> {
    let cutoff = clear_cutoff_timestamp(range);
    let mut stmt = match cutoff {
        Some(_) => conn.prepare(
            "SELECT media_file_name
             FROM clipboard_history
             WHERE media_file_name IS NOT NULL
               AND timestamp >= ?1",
        )?,
        None => conn.prepare(
            "SELECT media_file_name
             FROM clipboard_history
             WHERE media_file_name IS NOT NULL",
        )?,
    };

    let mut names = Vec::new();
    match cutoff {
        Some(cutoff) => {
            let rows = stmt.query_map(params![cutoff], |row| row.get::<_, String>(0))?;
            for row in rows {
                names.push(row?);
            }
        }
        None => {
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            for row in rows {
                names.push(row?);
            }
        }
    }
    Ok(names)
}

fn summarize_clipboard_entry(entry: &ClipboardHistoryEntry) -> ClipboardHistoryEntrySummary {
    ClipboardHistoryEntrySummary {
        id: entry.id,
        content_hash: content_hash_for_entry(entry),
        content_kind: entry.content_kind.clone(),
        text: clipboard_preview_text(&entry.text),
        timestamp: entry.timestamp,
        source_app_name: entry.source_app_name.clone(),
        source_app_identifier: entry.source_app_identifier.clone(),
        media_width: entry.media_width,
        media_height: entry.media_height,
        media_byte_len: entry.media_byte_len,
    }
}

fn clipboard_preview_text(text: &str) -> String {
    let mut preview = String::new();
    let mut previous_was_whitespace = false;
    let mut count = 0usize;
    let mut truncated = false;

    for ch in text.chars() {
        let normalized = if ch.is_whitespace() { ' ' } else { ch };
        if normalized == ' ' {
            if previous_was_whitespace || preview.is_empty() {
                continue;
            }
            previous_was_whitespace = true;
        } else {
            previous_was_whitespace = false;
        }

        if count >= CLIPBOARD_PAGE_PREVIEW_CHARS {
            truncated = true;
            break;
        }

        preview.push(normalized);
        count += 1;
    }

    let trimmed_len = preview.trim_end().len();
    preview.truncate(trimmed_len);

    if truncated {
        preview.push_str("...");
    }

    preview
}

fn normalize_entry_metadata(entry: &mut ClipboardHistoryEntry) {
    if entry.content_hash.trim().is_empty() {
        entry.content_hash = content_hash_for_entry(entry);
    }

    if entry.content_kind == ClipboardHistoryContentKind::Text {
        entry.media_width = None;
        entry.media_height = None;
        entry.media_byte_len = None;
    }
}

fn content_hash_for_entry(entry: &ClipboardHistoryEntry) -> String {
    if !entry.content_hash.trim().is_empty() {
        return entry.content_hash.clone();
    }

    match entry.content_kind {
        ClipboardHistoryContentKind::Text => hash_clipboard_text(&entry.text),
        ClipboardHistoryContentKind::Image => {
            let seed = format!(
                "{}:{}:{}:{}",
                entry.text,
                entry.media_width.unwrap_or(0),
                entry.media_height.unwrap_or(0),
                entry.timestamp
            );
            hash_with_prefix("image", seed.as_bytes())
        }
    }
}

fn hash_clipboard_text(text: &str) -> String {
    hash_with_prefix("text", text.as_bytes())
}

fn hash_clipboard_image(rgba: &[u8], width: u32, height: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(rgba);
    let digest = hasher.finalize();
    format_hash("image", &digest)
}

fn hash_with_prefix(prefix: &str, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    format_hash(prefix, &digest)
}

fn format_hash(prefix: &str, bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut hex, "{:02x}", byte);
    }
    format!("{prefix}:{hex}")
}

fn media_file_name_for_hash(content_hash: &str) -> String {
    let safe_hash: String = content_hash
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe_hash}.{CLIPBOARD_IMAGE_FILE_EXTENSION}")
}

fn media_path(media_dir: &Path, media_file_name: &str) -> Option<PathBuf> {
    let path = Path::new(media_file_name);
    if path.components().count() != 1 {
        return None;
    }
    Some(media_dir.join(path))
}

fn delete_media_files(media_dir: &Path, media_file_names: Vec<String>) {
    for media_file_name in media_file_names {
        let Some(path) = media_path(media_dir, &media_file_name) else {
            continue;
        };
        if let Err(err) = fs::remove_file(&path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                error!(
                    "Failed to delete clipboard media file '{}': {}",
                    path.display(),
                    err
                );
            }
        }
    }
}

fn clipboard_image_label(width: u32, height: u32) -> String {
    format!("Image {width} x {height}")
}

fn thumbnail_rgba(rgba: &[u8], width: u32, height: u32, max_dimension: u32) -> (Vec<u8>, u32, u32) {
    if width == 0 || height == 0 || max_dimension == 0 {
        return (Vec::new(), 0, 0);
    }

    let expected_len = width as usize * height as usize * 4;
    if rgba.len() < expected_len {
        return (Vec::new(), 0, 0);
    }

    let largest_dimension = width.max(height);
    if largest_dimension <= max_dimension {
        return (rgba[..expected_len].to_vec(), width, height);
    }

    let scale = max_dimension as f64 / largest_dimension as f64;
    let preview_width = ((width as f64 * scale).round() as u32).max(1);
    let preview_height = ((height as f64 * scale).round() as u32).max(1);
    let mut preview = vec![0; preview_width as usize * preview_height as usize * 4];

    for y in 0..preview_height {
        let source_y = ((y as u64 * height as u64) / preview_height as u64) as u32;
        for x in 0..preview_width {
            let source_x = ((x as u64 * width as u64) / preview_width as u64) as u32;
            let source_index = ((source_y * width + source_x) as usize) * 4;
            let target_index = ((y * preview_width + x) as usize) * 4;
            preview[target_index..target_index + 4]
                .copy_from_slice(&rgba[source_index..source_index + 4]);
        }
    }

    (preview, preview_width, preview_height)
}

fn active_source_app() -> (Option<String>, Option<String>) {
    let focus_context = crate::focus_context::get_active_context();
    let source_app_name = focus_context.as_ref().and_then(|ctx| ctx.app_name.clone());
    let source_app_identifier = focus_context
        .as_ref()
        .and_then(|ctx| ctx.app_identifier.clone());
    (source_app_name, source_app_identifier)
}

fn clear_cutoff_timestamp(range: ClipboardHistoryClearRange) -> Option<i64> {
    let now = current_timestamp_ms();
    match range {
        ClipboardHistoryClearRange::PastDay => Some(now.saturating_sub(CLIPBOARD_DAY_MS)),
        ClipboardHistoryClearRange::PastWeek => Some(now.saturating_sub(CLIPBOARD_WEEK_MS)),
        ClipboardHistoryClearRange::All => None,
    }
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_app_option_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn lock_recover<'a, T>(mutex: &'a Mutex<T>, context: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            error!("Poisoned lock recovered for {}", context);
            poisoned.into_inner()
        }
    }
}
