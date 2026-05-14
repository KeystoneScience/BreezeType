use anyhow::Result;
use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use log::{debug, error, info, warn};
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::audio_toolkit::save_wav_file;
use crate::focus_context::FocusContext;

/// Database migrations for transcription history.
/// Each migration is applied in order. The library tracks which migrations
/// have been applied using SQLite's user_version pragma.
///
/// Note: For users upgrading from tauri-plugin-sql, migrate_from_tauri_plugin_sql()
/// converts the old _sqlx_migrations table tracking to the user_version pragma,
/// ensuring migrations don't re-run on existing databases.
static MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE IF NOT EXISTS transcription_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            saved BOOLEAN NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            transcription_text TEXT NOT NULL
        );",
    ),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_processed_text TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_prompt TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN source_app_name TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN source_app_identifier TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN source_window_title TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN source_process_id INTEGER;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN audio_duration_seconds REAL;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN source_browser_tab_title TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN source_browser_tab_url TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN original_transcription_text TEXT;"),
    M::up(
        "CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    ),
    M::up("CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);"),
    M::up("ALTER TABLE transcription_history ADD COLUMN sync_id TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN updated_at INTEGER;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN deleted_at INTEGER;"),
    M::up("CREATE INDEX IF NOT EXISTS idx_transcription_history_sync_id ON transcription_history(sync_id);"),
    M::up("CREATE INDEX IF NOT EXISTS idx_transcription_history_updated_at ON transcription_history(updated_at);"),
    M::up("ALTER TABLE notes ADD COLUMN sync_id TEXT;"),
    M::up("ALTER TABLE notes ADD COLUMN deleted_at INTEGER;"),
    M::up("CREATE INDEX IF NOT EXISTS idx_notes_sync_id ON notes(sync_id);"),
    M::up(
        "CREATE TABLE IF NOT EXISTS sync_state (
            user_id TEXT PRIMARY KEY,
            last_sync_at INTEGER NOT NULL DEFAULT 0
        );",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS sync_device (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            client_id TEXT NOT NULL
        );",
    ),
    M::up(
        "CREATE INDEX IF NOT EXISTS idx_transcription_history_deleted_timestamp
         ON transcription_history(deleted_at, timestamp DESC);",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS history_metrics (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            total_words INTEGER NOT NULL DEFAULT 0,
            total_words_with_duration INTEGER NOT NULL DEFAULT 0,
            total_audio_seconds REAL NOT NULL DEFAULT 0.0,
            first_timestamp INTEGER,
            entry_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );",
    ),
    M::up(
        "CREATE INDEX IF NOT EXISTS idx_transcription_history_app_options
         ON transcription_history(deleted_at, source_app_identifier, source_app_name, timestamp DESC);",
    ),
];

const HISTORY_COMPACT_TEXT_PREVIEW_CHARS: i64 = 600;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryEntry {
    pub id: i64,
    pub file_name: String,
    pub timestamp: i64,
    pub saved: bool,
    pub title: String,
    pub transcription_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub source_app_name: Option<String>,
    pub source_app_identifier: Option<String>,
    pub source_window_title: Option<String>,
    pub source_process_id: Option<i64>,
    pub source_browser_tab_title: Option<String>,
    pub source_browser_tab_url: Option<String>,
    pub audio_duration_seconds: Option<f64>,
}

/// A lightweight history entry optimized for list views (History tab).
/// Avoids shipping large/unused fields over the Tauri IPC bridge.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryEntrySummary {
    pub id: i64,
    pub timestamp: i64,
    pub title: String,
    /// Either `post_processed_text` when available, otherwise `transcription_text`.
    pub text: String,
    pub source_app_name: Option<String>,
    pub source_app_identifier: Option<String>,
    pub source_window_title: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryAppFilterType {
    Identifier,
    Name,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct HistoryAppFilterOption {
    pub filter_type: HistoryAppFilterType,
    pub value: String,
    pub label: String,
    pub icon_identifier: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryStats {
    pub total_words: u64,
    pub total_words_with_duration: u64,
    pub total_audio_seconds: f64,
    pub first_timestamp: Option<i64>,
    pub entry_count: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryStreak {
    pub streak: u64,
    pub is_today: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct NoteEntry {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct SyncHistoryEntry {
    pub sync_id: String,
    pub file_name: String,
    pub timestamp: i64,
    pub saved: bool,
    pub title: String,
    pub transcription_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub source_app_name: Option<String>,
    pub source_app_identifier: Option<String>,
    pub source_window_title: Option<String>,
    pub source_process_id: Option<i64>,
    pub source_browser_tab_title: Option<String>,
    pub source_browser_tab_url: Option<String>,
    pub audio_duration_seconds: Option<f64>,
    pub original_transcription_text: Option<String>,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct SyncNoteEntry {
    pub sync_id: String,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct SyncPayload {
    pub client_id: String,
    pub last_sync_at: i64,
    pub history: Vec<SyncHistoryEntry>,
    pub notes: Vec<SyncNoteEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct SyncResult {
    pub server_time: i64,
    pub history: Vec<SyncHistoryEntry>,
    pub notes: Vec<SyncNoteEntry>,
}

#[derive(Clone, Debug)]
struct HistoryMetricsEntry {
    id: i64,
    file_name: String,
    transcription_text: String,
    post_processed_text: Option<String>,
    audio_duration_seconds: Option<f64>,
}

#[derive(Clone)]
pub struct HistoryManager {
    app_handle: AppHandle,
    recordings_dir: PathBuf,
    db_path: PathBuf,
    active_note_id: Arc<Mutex<Option<i64>>>,
}

impl HistoryManager {
    pub fn new(app_handle: &AppHandle) -> Self {
        // Create recordings directory in app data dir (or fall back to temp dir).
        let app_data_dir = match app_handle.path().app_data_dir() {
            Ok(dir) => dir,
            Err(err) => {
                error!(
                    "Failed to resolve app data dir for history: {}. Falling back to temp directory.",
                    err
                );
                std::env::temp_dir().join("breezetype")
            }
        };
        let recordings_dir = app_data_dir.join("recordings");
        let db_path = app_data_dir.join("history.db");

        // Ensure recordings directory exists
        if let Err(err) = fs::create_dir_all(&recordings_dir) {
            error!(
                "Failed to create recordings directory '{}': {}",
                recordings_dir.display(),
                err
            );
        } else {
            debug!("Recordings directory: {:?}", recordings_dir);
        }

        let manager = Self {
            app_handle: app_handle.clone(),
            recordings_dir,
            db_path,
            active_note_id: Arc::new(Mutex::new(None)),
        };

        // Initialize database and run migrations synchronously (best-effort).
        if let Err(err) = manager.init_database() {
            error!("Failed to initialize history database: {}", err);
        }

        // Avoid blocking startup on potentially heavy metrics reconciliation.
        manager.refresh_history_metrics_in_background();

        manager
    }

    fn init_database(&self) -> Result<()> {
        info!("Initializing database at {:?}", self.db_path);

        let mut conn = Connection::open(&self.db_path)?;

        // Handle migration from tauri-plugin-sql to rusqlite_migration
        // tauri-plugin-sql used _sqlx_migrations table, rusqlite_migration uses user_version pragma
        self.migrate_from_tauri_plugin_sql(&conn)?;

        // Create migrations object and run to latest version
        let migrations = Migrations::new(MIGRATIONS.to_vec());

        // Validate migrations in debug builds
        #[cfg(debug_assertions)]
        migrations.validate().expect("Invalid migrations");

        // Get current version before migration
        let version_before: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        debug!("Database version before migration: {}", version_before);

        // Avoid panicking/aborting when the DB version is newer than the compiled migrations.
        // This can happen if the user runs an older build after a newer build has already
        // migrated the database forward (e.g. dev build vs. installed app).
        //
        // NOTE: `rusqlite_migration` may panic in this scenario; guard proactively.
        let latest_supported_version: i32 = MIGRATIONS.len() as i32;
        if version_before > latest_supported_version {
            warn!(
                "History DB user_version ({}) is newer than this build supports ({}). \
Skipping migrations to avoid a crash; consider updating BreezeType to a newer build.",
                version_before, latest_supported_version
            );
        } else {
            // Apply any pending migrations
            migrations.to_latest(&mut conn)?;
        }

        // Get version after migration
        let version_after: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if version_after > version_before {
            info!(
                "Database migrated from version {} to {}",
                version_before, version_after
            );
        } else {
            debug!("Database already at latest version {}", version_after);
        }

        Ok(())
    }

    fn refresh_history_metrics_in_background(&self) {
        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(err) = manager.refresh_history_metrics() {
                warn!("Async history metrics refresh failed: {}", err);
            }
        });
    }

    fn refresh_history_metrics(&self) -> Result<()> {
        let conn = self.get_connection()?;
        self.ensure_history_metrics_uptodate(&conn)
    }

    /// Migrate from tauri-plugin-sql's migration tracking to rusqlite_migration's.
    /// tauri-plugin-sql used a _sqlx_migrations table, while rusqlite_migration uses
    /// SQLite's user_version pragma. This function checks if the old system was in use
    /// and sets the user_version accordingly so migrations don't re-run.
    fn migrate_from_tauri_plugin_sql(&self, conn: &Connection) -> Result<()> {
        // Check if the old _sqlx_migrations table exists
        let has_sqlx_migrations: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_sqlx_migrations {
            return Ok(());
        }

        // Check current user_version
        let current_version: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if current_version > 0 {
            // Already migrated to rusqlite_migration system
            return Ok(());
        }

        // Get the highest version from the old migrations table
        let old_version: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if old_version > 0 {
            info!(
                "Migrating from tauri-plugin-sql (version {}) to rusqlite_migration",
                old_version
            );

            // Set user_version to match the old migration state
            conn.pragma_update(None, "user_version", old_version)?;

            // Optionally drop the old migrations table (keeping it doesn't hurt)
            // conn.execute("DROP TABLE IF EXISTS _sqlx_migrations", [])?;

            info!(
                "Migration tracking converted: user_version set to {}",
                old_version
            );
        }

        Ok(())
    }

    fn get_connection(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    fn ensure_history_metrics_row(&self, conn: &Connection) -> Result<()> {
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT OR IGNORE INTO history_metrics (
                id,
                total_words,
                total_words_with_duration,
                total_audio_seconds,
                first_timestamp,
                entry_count,
                updated_at
            ) VALUES (1, 0, 0, 0.0, NULL, 0, ?1)",
            params![now],
        )?;
        Ok(())
    }

    fn ensure_history_metrics_uptodate(&self, conn: &Connection) -> Result<()> {
        self.ensure_history_metrics_row(conn)?;

        let metrics_entry_count: i64 = conn.query_row(
            "SELECT entry_count FROM history_metrics WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let actual_entry_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM transcription_history WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )?;

        if metrics_entry_count != actual_entry_count {
            info!(
                "History metrics out of date (metrics_count={}, actual_count={}), rebuilding",
                metrics_entry_count, actual_entry_count
            );
            self.rebuild_history_metrics_with_connection(conn)?;
        }

        Ok(())
    }

    fn word_count_for_entry(transcription_text: &str, post_processed_text: Option<&str>) -> i64 {
        let text = post_processed_text.unwrap_or(transcription_text);
        text.split_whitespace().count() as i64
    }

    fn metrics_duration_deltas(audio_duration_seconds: Option<f64>, word_count: i64) -> (i64, f64) {
        match audio_duration_seconds {
            Some(duration) if duration > 0.0 => (word_count, duration),
            _ => (0, 0.0),
        }
    }

    fn increment_history_metrics_for_entry(
        &self,
        conn: &Connection,
        timestamp: i64,
        transcription_text: &str,
        post_processed_text: Option<&str>,
        audio_duration_seconds: Option<f64>,
    ) -> Result<()> {
        self.ensure_history_metrics_row(conn)?;

        let total_words_delta = Self::word_count_for_entry(transcription_text, post_processed_text);
        let (words_with_duration_delta, audio_seconds_delta) =
            Self::metrics_duration_deltas(audio_duration_seconds, total_words_delta);
        let now = Utc::now().timestamp();

        conn.execute(
            "UPDATE history_metrics
             SET total_words = total_words + ?1,
                 total_words_with_duration = total_words_with_duration + ?2,
                 total_audio_seconds = total_audio_seconds + ?3,
                 entry_count = entry_count + 1,
                 first_timestamp = CASE
                     WHEN first_timestamp IS NULL OR ?4 < first_timestamp THEN ?4
                     ELSE first_timestamp
                 END,
                 updated_at = ?5
             WHERE id = 1",
            params![
                total_words_delta,
                words_with_duration_delta,
                audio_seconds_delta,
                timestamp,
                now
            ],
        )?;

        Ok(())
    }

    fn decrement_history_metrics_for_entries(
        &self,
        conn: &Connection,
        entries: &[HistoryMetricsEntry],
    ) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }

        self.ensure_history_metrics_row(conn)?;

        let mut total_words_delta = 0i64;
        let mut words_with_duration_delta = 0i64;
        let mut audio_seconds_delta = 0.0f64;

        for entry in entries {
            let word_count = Self::word_count_for_entry(
                &entry.transcription_text,
                entry.post_processed_text.as_deref(),
            );
            let (words_with_duration, audio_seconds) =
                Self::metrics_duration_deltas(entry.audio_duration_seconds, word_count);
            total_words_delta += word_count;
            words_with_duration_delta += words_with_duration;
            audio_seconds_delta += audio_seconds;
        }

        let now = Utc::now().timestamp();
        conn.execute(
            "UPDATE history_metrics
             SET total_words = MAX(0, total_words - ?1),
                 total_words_with_duration = MAX(0, total_words_with_duration - ?2),
                 total_audio_seconds = MAX(0.0, total_audio_seconds - ?3),
                 entry_count = MAX(0, entry_count - ?4),
                 updated_at = ?5
             WHERE id = 1",
            params![
                total_words_delta,
                words_with_duration_delta,
                audio_seconds_delta,
                entries.len() as i64,
                now
            ],
        )?;

        let first_timestamp: Option<i64> = conn.query_row(
            "SELECT MIN(timestamp) FROM transcription_history WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        conn.execute(
            "UPDATE history_metrics SET first_timestamp = ?1, updated_at = ?2 WHERE id = 1",
            params![first_timestamp, now],
        )?;

        Ok(())
    }

    fn rebuild_history_metrics_with_connection(&self, conn: &Connection) -> Result<()> {
        self.ensure_history_metrics_row(conn)?;

        let mut stmt = conn.prepare(
            "SELECT timestamp, transcription_text, post_processed_text, audio_duration_seconds
             FROM transcription_history
             WHERE deleted_at IS NULL",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>("timestamp")?,
                row.get::<_, String>("transcription_text")?,
                row.get::<_, Option<String>>("post_processed_text")?,
                row.get::<_, Option<f64>>("audio_duration_seconds")?,
            ))
        })?;

        let mut total_words = 0i64;
        let mut total_words_with_duration = 0i64;
        let mut total_audio_seconds = 0.0f64;
        let mut first_timestamp: Option<i64> = None;
        let mut entry_count = 0i64;

        for row in rows {
            let (timestamp, transcription_text, post_processed_text, audio_duration_seconds) = row?;
            let word_count =
                Self::word_count_for_entry(&transcription_text, post_processed_text.as_deref());
            let (words_with_duration, audio_seconds) =
                Self::metrics_duration_deltas(audio_duration_seconds, word_count);

            total_words += word_count;
            total_words_with_duration += words_with_duration;
            total_audio_seconds += audio_seconds;
            entry_count += 1;
            first_timestamp = match first_timestamp {
                Some(existing) => Some(existing.min(timestamp)),
                None => Some(timestamp),
            };
        }

        let now = Utc::now().timestamp();
        conn.execute(
            "UPDATE history_metrics
             SET total_words = ?1,
                 total_words_with_duration = ?2,
                 total_audio_seconds = ?3,
                 first_timestamp = ?4,
                 entry_count = ?5,
                 updated_at = ?6
             WHERE id = 1",
            params![
                total_words,
                total_words_with_duration,
                total_audio_seconds,
                first_timestamp,
                entry_count,
                now
            ],
        )?;

        Ok(())
    }

    fn load_history_stats_from_metrics(&self, conn: &Connection) -> Result<HistoryStats> {
        self.ensure_history_metrics_row(conn)?;

        let stats = conn.query_row(
            "SELECT total_words, total_words_with_duration, total_audio_seconds, first_timestamp, entry_count
             FROM history_metrics
             WHERE id = 1",
            [],
            |row| {
                Ok(HistoryStats {
                    total_words: row.get::<_, i64>(0)?.max(0) as u64,
                    total_words_with_duration: row.get::<_, i64>(1)?.max(0) as u64,
                    total_audio_seconds: row.get::<_, f64>(2)?.max(0.0),
                    first_timestamp: row.get(3)?,
                    entry_count: row.get::<_, i64>(4)?.max(0) as u64,
                })
            },
        )?;

        Ok(stats)
    }

    fn to_metrics_entry(entry: &HistoryEntry) -> HistoryMetricsEntry {
        HistoryMetricsEntry {
            id: entry.id,
            file_name: entry.file_name.clone(),
            transcription_text: entry.transcription_text.clone(),
            post_processed_text: entry.post_processed_text.clone(),
            audio_duration_seconds: entry.audio_duration_seconds,
        }
    }

    pub fn set_active_note_id(&self, id: Option<i64>) {
        let mut active = self.active_note_id.lock().unwrap();
        *active = id;
    }

    pub fn get_active_note_id(&self) -> Option<i64> {
        let active = self.active_note_id.lock().unwrap();
        *active
    }

    /// Save a transcription to history (both database and WAV file)
    pub async fn save_transcription(
        &self,
        audio_samples: Vec<f32>,
        audio_duration_seconds: f64,
        transcription_text: String,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
        focus_context: Option<FocusContext>,
    ) -> Result<()> {
        let timestamp = Utc::now().timestamp();
        let file_name = format!("breeze-{}.wav", timestamp);
        let title = self.format_timestamp_title(timestamp);

        // Save WAV file (temporary) then remove after transcription is stored
        let file_path = self.recordings_dir.join(&file_name);
        save_wav_file(file_path.clone(), &audio_samples).await?;

        // Save to database
        if let Err(e) = self.save_to_database(
            file_name.clone(),
            timestamp,
            title,
            transcription_text,
            if audio_duration_seconds > 0.0 {
                Some(audio_duration_seconds)
            } else {
                None
            },
            post_processed_text,
            post_process_prompt,
            focus_context,
        ) {
            if file_path.exists() {
                if let Err(remove_err) = fs::remove_file(&file_path) {
                    error!(
                        "Failed to delete temporary recording {}: {}",
                        file_name, remove_err
                    );
                }
            }
            return Err(e);
        }

        if file_path.exists() {
            if let Err(e) = fs::remove_file(&file_path) {
                error!("Failed to delete temporary recording {}: {}", file_name, e);
            }
        }

        // Clean up old entries
        self.cleanup_old_entries()?;

        // Emit history updated event
        if let Err(e) = self.app_handle.emit("history-updated", ()) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    fn save_to_database(
        &self,
        file_name: String,
        timestamp: i64,
        title: String,
        transcription_text: String,
        audio_duration_seconds: Option<f64>,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
        focus_context: Option<FocusContext>,
    ) -> Result<()> {
        let source_app_name = focus_context.as_ref().and_then(|ctx| ctx.app_name.clone());
        let source_app_identifier = focus_context
            .as_ref()
            .and_then(|ctx| ctx.app_identifier.clone());
        let source_window_title = focus_context
            .as_ref()
            .and_then(|ctx| ctx.window_title.clone());
        let source_process_id = focus_context.as_ref().and_then(|ctx| ctx.process_id);
        let source_browser_tab_title = focus_context
            .as_ref()
            .and_then(|ctx| ctx.browser_tab_title.clone());
        let source_browser_tab_url = focus_context
            .as_ref()
            .and_then(|ctx| ctx.browser_tab_url.clone());
        let original_transcription_text = transcription_text.clone();
        let metrics_transcription_text = transcription_text.clone();
        let metrics_post_processed_text = post_processed_text.clone();

        let sync_id = Uuid::new_v4().to_string();
        let updated_at = Utc::now().timestamp();

        let mut conn = self.get_connection()?;
        let tx = conn.transaction()?;

        tx.execute(
            "INSERT INTO transcription_history (sync_id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, source_app_name, source_app_identifier, source_window_title, source_process_id, source_browser_tab_title, source_browser_tab_url, audio_duration_seconds, original_transcription_text, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                sync_id,
                file_name,
                timestamp,
                false,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                source_app_name,
                source_app_identifier,
                source_window_title,
                source_process_id,
                source_browser_tab_title,
                source_browser_tab_url,
                audio_duration_seconds,
                original_transcription_text,
                updated_at,
                Option::<i64>::None
            ],
        )?;

        self.increment_history_metrics_for_entry(
            &tx,
            timestamp,
            &metrics_transcription_text,
            metrics_post_processed_text.as_deref(),
            audio_duration_seconds,
        )?;
        tx.commit()?;

        debug!("Saved transcription to database");
        Ok(())
    }

    pub fn cleanup_old_entries(&self) -> Result<()> {
        let retention_period = crate::settings::get_recording_retention_period(&self.app_handle);

        match retention_period {
            crate::settings::RecordingRetentionPeriod::Never => {
                // Don't delete anything
                return Ok(());
            }
            crate::settings::RecordingRetentionPeriod::PreserveLimit => {
                // Use the old count-based logic with history_limit
                let limit = crate::settings::get_history_limit(&self.app_handle);
                return self.cleanup_by_count(limit);
            }
            _ => {
                // Use time-based logic
                return self.cleanup_by_time(retention_period);
            }
        }
    }

    fn delete_entries_and_files(&self, entries: &[HistoryMetricsEntry]) -> Result<usize> {
        if entries.is_empty() {
            return Ok(0);
        }

        let mut conn = self.get_connection()?;
        let tx = conn.transaction()?;
        let now = Utc::now().timestamp();
        let mut deleted_entries: Vec<HistoryMetricsEntry> = Vec::new();

        for entry in entries {
            // Soft delete database entry
            let updated_rows = tx.execute(
                "UPDATE transcription_history SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                params![now, now, entry.id],
            )?;
            if updated_rows > 0 {
                deleted_entries.push(entry.clone());
            }
        }

        self.decrement_history_metrics_for_entries(&tx, &deleted_entries)?;
        tx.commit()?;

        let mut deleted_file_count = 0;
        for entry in &deleted_entries {
            // Delete WAV file
            let file_path = self.recordings_dir.join(&entry.file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete WAV file {}: {}", entry.file_name, e);
                } else {
                    debug!("Deleted old WAV file: {}", entry.file_name);
                    deleted_file_count += 1;
                }
            }
        }

        if deleted_file_count > 0 {
            debug!("Deleted {} old history audio files", deleted_file_count);
        }

        Ok(deleted_entries.len())
    }

    fn cleanup_by_count(&self, limit: usize) -> Result<()> {
        let conn = self.get_connection()?;

        // Get all entries that are not saved, ordered by timestamp desc
        let mut stmt = conn.prepare(
            "SELECT id, file_name, transcription_text, post_processed_text, audio_duration_seconds
             FROM transcription_history
             WHERE saved = 0 AND deleted_at IS NULL
             ORDER BY timestamp DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(HistoryMetricsEntry {
                id: row.get("id")?,
                file_name: row.get("file_name")?,
                transcription_text: row.get("transcription_text")?,
                post_processed_text: row.get("post_processed_text")?,
                audio_duration_seconds: row.get("audio_duration_seconds")?,
            })
        })?;

        let mut entries: Vec<HistoryMetricsEntry> = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        if entries.len() > limit {
            let entries_to_delete = &entries[limit..];
            let deleted_count = self.delete_entries_and_files(entries_to_delete)?;

            if deleted_count > 0 {
                debug!("Cleaned up {} old history entries by count", deleted_count);
            }
        }

        Ok(())
    }

    fn cleanup_by_time(
        &self,
        retention_period: crate::settings::RecordingRetentionPeriod,
    ) -> Result<()> {
        let conn = self.get_connection()?;

        // Calculate cutoff timestamp (current time minus retention period)
        let now = Utc::now().timestamp();
        let cutoff_timestamp = match retention_period {
            crate::settings::RecordingRetentionPeriod::Days3 => now - (3 * 24 * 60 * 60), // 3 days in seconds
            crate::settings::RecordingRetentionPeriod::Weeks2 => now - (2 * 7 * 24 * 60 * 60), // 2 weeks in seconds
            crate::settings::RecordingRetentionPeriod::Months3 => now - (3 * 30 * 24 * 60 * 60), // 3 months in seconds (approximate)
            _ => unreachable!("Should not reach here"),
        };

        // Get all unsaved entries older than the cutoff timestamp
        let mut stmt = conn.prepare(
            "SELECT id, file_name, transcription_text, post_processed_text, audio_duration_seconds
             FROM transcription_history
             WHERE saved = 0 AND deleted_at IS NULL AND timestamp < ?1",
        )?;

        let rows = stmt.query_map(params![cutoff_timestamp], |row| {
            Ok(HistoryMetricsEntry {
                id: row.get("id")?,
                file_name: row.get("file_name")?,
                transcription_text: row.get("transcription_text")?,
                post_processed_text: row.get("post_processed_text")?,
                audio_duration_seconds: row.get("audio_duration_seconds")?,
            })
        })?;

        let mut entries_to_delete: Vec<HistoryMetricsEntry> = Vec::new();
        for row in rows {
            entries_to_delete.push(row?);
        }

        let deleted_count = self.delete_entries_and_files(&entries_to_delete)?;

        if deleted_count > 0 {
            debug!(
                "Cleaned up {} old history entries based on retention period",
                deleted_count
            );
        }

        Ok(())
    }

    pub async fn get_history_entries(&self) -> Result<Vec<HistoryEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, source_app_name, source_app_identifier, source_window_title, source_process_id, source_browser_tab_title, source_browser_tab_url, audio_duration_seconds FROM transcription_history WHERE deleted_at IS NULL ORDER BY timestamp DESC"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(HistoryEntry {
                id: row.get("id")?,
                file_name: row.get("file_name")?,
                timestamp: row.get("timestamp")?,
                saved: row.get("saved")?,
                title: row.get("title")?,
                transcription_text: row.get("transcription_text")?,
                post_processed_text: row.get("post_processed_text")?,
                post_process_prompt: row.get("post_process_prompt")?,
                source_app_name: row.get("source_app_name")?,
                source_app_identifier: row.get("source_app_identifier")?,
                source_window_title: row.get("source_window_title")?,
                source_process_id: row.get("source_process_id")?,
                source_browser_tab_title: row.get("source_browser_tab_title")?,
                source_browser_tab_url: row.get("source_browser_tab_url")?,
                audio_duration_seconds: row.get("audio_duration_seconds")?,
            })
        })?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        Ok(entries)
    }

    pub async fn get_history_entries_page(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, source_app_name, source_app_identifier, source_window_title, source_process_id, source_browser_tab_title, source_browser_tab_url, audio_duration_seconds FROM transcription_history WHERE deleted_at IS NULL ORDER BY timestamp DESC LIMIT ?1 OFFSET ?2"
        )?;

        let rows = stmt.query_map(params![limit as i64, offset as i64], |row| {
            Ok(HistoryEntry {
                id: row.get("id")?,
                file_name: row.get("file_name")?,
                timestamp: row.get("timestamp")?,
                saved: row.get("saved")?,
                title: row.get("title")?,
                transcription_text: row.get("transcription_text")?,
                post_processed_text: row.get("post_processed_text")?,
                post_process_prompt: row.get("post_process_prompt")?,
                source_app_name: row.get("source_app_name")?,
                source_app_identifier: row.get("source_app_identifier")?,
                source_window_title: row.get("source_window_title")?,
                source_process_id: row.get("source_process_id")?,
                source_browser_tab_title: row.get("source_browser_tab_title")?,
                source_browser_tab_url: row.get("source_browser_tab_url")?,
                audio_duration_seconds: row.get("audio_duration_seconds")?,
            })
        })?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        Ok(entries)
    }

    pub async fn get_history_entries_page_compact(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<HistoryEntrySummary>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id,
                    timestamp,
                    title,
                    substr(COALESCE(post_processed_text, transcription_text), 1, ?1) AS text,
                    source_app_name,
                    source_app_identifier,
                    source_window_title
             FROM transcription_history
             WHERE deleted_at IS NULL
             ORDER BY timestamp DESC
             LIMIT ?2 OFFSET ?3",
        )?;

        let rows = stmt.query_map(
            params![
                HISTORY_COMPACT_TEXT_PREVIEW_CHARS,
                limit as i64,
                offset as i64
            ],
            |row| {
                Ok(HistoryEntrySummary {
                    id: row.get("id")?,
                    timestamp: row.get("timestamp")?,
                    title: row.get("title")?,
                    text: row.get("text")?,
                    source_app_name: row.get("source_app_name")?,
                    source_app_identifier: row.get("source_app_identifier")?,
                    source_window_title: row.get("source_window_title")?,
                })
            },
        )?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        Ok(entries)
    }

    pub async fn get_history_entries_page_compact_for_app(
        &self,
        offset: usize,
        limit: usize,
        filter_type: HistoryAppFilterType,
        filter_value: String,
    ) -> Result<Vec<HistoryEntrySummary>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let Some(filter_value) = normalize_app_option_value(&filter_value) else {
            return Ok(Vec::new());
        };

        let conn = self.get_connection()?;
        let sql = match filter_type {
            HistoryAppFilterType::Identifier => {
                "SELECT id,
                        timestamp,
                        title,
                        substr(COALESCE(post_processed_text, transcription_text), 1, ?1) AS text,
                        source_app_name,
                        source_app_identifier,
                        source_window_title
                 FROM transcription_history
                 WHERE deleted_at IS NULL
                   AND LOWER(TRIM(source_app_identifier)) = LOWER(TRIM(?4))
                 ORDER BY timestamp DESC
                 LIMIT ?2 OFFSET ?3"
            }
            HistoryAppFilterType::Name => {
                "SELECT id,
                        timestamp,
                        title,
                        substr(COALESCE(post_processed_text, transcription_text), 1, ?1) AS text,
                        source_app_name,
                        source_app_identifier,
                        source_window_title
                 FROM transcription_history
                 WHERE deleted_at IS NULL
                   AND NULLIF(TRIM(source_app_identifier), '') IS NULL
                   AND LOWER(TRIM(source_app_name)) = LOWER(TRIM(?4))
                 ORDER BY timestamp DESC
                 LIMIT ?2 OFFSET ?3"
            }
        };

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(
            params![
                HISTORY_COMPACT_TEXT_PREVIEW_CHARS,
                limit as i64,
                offset as i64,
                filter_value
            ],
            |row| {
                Ok(HistoryEntrySummary {
                    id: row.get("id")?,
                    timestamp: row.get("timestamp")?,
                    title: row.get("title")?,
                    text: row.get("text")?,
                    source_app_name: row.get("source_app_name")?,
                    source_app_identifier: row.get("source_app_identifier")?,
                    source_window_title: row.get("source_window_title")?,
                })
            },
        )?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        Ok(entries)
    }

    pub async fn get_history_app_filter_options(&self) -> Result<Vec<HistoryAppFilterOption>> {
        let conn = self.get_connection()?;
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
                    FROM transcription_history
                    WHERE deleted_at IS NULL
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

        Ok(unique_history_app_filter_options(options))
    }

    pub async fn get_history_stats(&self) -> Result<HistoryStats> {
        let conn = self.get_connection()?;
        self.load_history_stats_from_metrics(&conn)
    }

    pub async fn get_history_entry_text(&self, id: i64) -> Result<Option<String>> {
        let conn = self.get_connection()?;
        let text = conn
            .query_row(
                "SELECT COALESCE(post_processed_text, transcription_text)
                 FROM transcription_history
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(text)
    }

    pub async fn get_history_streak(&self) -> Result<HistoryStreak> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT date(datetime(timestamp, 'unixepoch', 'localtime')) AS day
             FROM transcription_history
             WHERE deleted_at IS NULL
             ORDER BY day DESC",
        )?;

        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        let today = Local::now().date_naive();
        let mut streak: u64 = 0;
        let mut cursor = today;
        let mut is_today = false;

        for row in rows {
            let day_str = row?;
            let day = match NaiveDate::parse_from_str(&day_str, "%Y-%m-%d") {
                Ok(value) => value,
                Err(_) => continue,
            };

            if day > cursor {
                continue;
            }

            if day == cursor {
                if streak == 0 {
                    is_today = true;
                }
                streak += 1;
                cursor = cursor - Duration::days(1);
            } else {
                break;
            }
        }

        Ok(HistoryStreak { streak, is_today })
    }

    pub async fn toggle_saved_status(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get current saved status
        let current_saved: bool = conn.query_row(
            "SELECT saved FROM transcription_history WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get("saved"),
        )?;

        let new_saved = !current_saved;

        let now = Utc::now().timestamp();
        conn.execute(
            "UPDATE transcription_history SET saved = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![new_saved, now, id],
        )?;

        debug!("Toggled saved status for entry {}: {}", id, new_saved);

        // Emit history updated event
        if let Err(e) = self.app_handle.emit("history-updated", ()) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    pub fn get_audio_file_path(&self, file_name: &str) -> PathBuf {
        self.recordings_dir.join(file_name)
    }

    pub async fn get_entry_by_id(&self, id: i64) -> Result<Option<HistoryEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, source_app_name, source_app_identifier, source_window_title, source_process_id, source_browser_tab_title, source_browser_tab_url, audio_duration_seconds
             FROM transcription_history WHERE id = ?1",
        )?;

        let entry = stmt
            .query_row([id], |row| {
                Ok(HistoryEntry {
                    id: row.get("id")?,
                    file_name: row.get("file_name")?,
                    timestamp: row.get("timestamp")?,
                    saved: row.get("saved")?,
                    title: row.get("title")?,
                    transcription_text: row.get("transcription_text")?,
                    post_processed_text: row.get("post_processed_text")?,
                    post_process_prompt: row.get("post_process_prompt")?,
                    source_app_name: row.get("source_app_name")?,
                    source_app_identifier: row.get("source_app_identifier")?,
                    source_window_title: row.get("source_window_title")?,
                    source_process_id: row.get("source_process_id")?,
                    source_browser_tab_title: row.get("source_browser_tab_title")?,
                    source_browser_tab_url: row.get("source_browser_tab_url")?,
                    audio_duration_seconds: row.get("audio_duration_seconds")?,
                })
            })
            .optional()?;

        Ok(entry)
    }

    pub async fn delete_entry(&self, id: i64) -> Result<()> {
        let Some(entry) = self.get_entry_by_id(id).await? else {
            return Ok(());
        };

        let metrics_entry = Self::to_metrics_entry(&entry);
        let mut conn = self.get_connection()?;
        let tx = conn.transaction()?;

        let now = Utc::now().timestamp();
        let updated_rows = tx.execute(
            "UPDATE transcription_history SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![now, now, id],
        )?;
        if updated_rows > 0 {
            self.decrement_history_metrics_for_entries(&tx, &[metrics_entry.clone()])?;
        }
        tx.commit()?;

        // Delete the audio file after the database transaction.
        let file_path = self.get_audio_file_path(&metrics_entry.file_name);
        if file_path.exists() {
            if let Err(e) = fs::remove_file(&file_path) {
                error!(
                    "Failed to delete audio file {}: {}",
                    metrics_entry.file_name, e
                );
                // Continue even if file deletion fails
            }
        }

        debug!("Deleted history entry with id: {}", id);

        // Emit history updated event
        if let Err(e) = self.app_handle.emit("history-updated", ()) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    fn format_timestamp_title(&self, timestamp: i64) -> String {
        if let Some(utc_datetime) = DateTime::from_timestamp(timestamp, 0) {
            // Convert UTC to local timezone
            let local_datetime = utc_datetime.with_timezone(&Local);
            local_datetime.format("%B %e, %Y - %l:%M%p").to_string()
        } else {
            format!("Recording {}", timestamp)
        }
    }

    pub async fn get_notes(&self) -> Result<Vec<NoteEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, body, created_at, updated_at FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(NoteEntry {
                id: row.get("id")?,
                title: row.get("title")?,
                body: row.get("body")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?;

        let mut notes = Vec::new();
        for row in rows {
            notes.push(row?);
        }

        Ok(notes)
    }

    pub async fn get_note_by_id(&self, id: i64) -> Result<NoteEntry> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, body, created_at, updated_at FROM notes WHERE id = ?1 AND deleted_at IS NULL",
        )?;
        let entry = stmt.query_row(params![id], |row| {
            Ok(NoteEntry {
                id: row.get("id")?,
                title: row.get("title")?,
                body: row.get("body")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?;
        Ok(entry)
    }

    pub async fn create_note(&self, title: String, body: String) -> Result<NoteEntry> {
        let now = Utc::now().timestamp();
        let sync_id = Uuid::new_v4().to_string();
        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO notes (sync_id, title, body, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![sync_id, title, body, now, now, Option::<i64>::None],
        )?;

        let id = conn.last_insert_rowid();
        let entry = NoteEntry {
            id,
            title,
            body,
            created_at: now,
            updated_at: now,
        };

        if let Err(e) = self.app_handle.emit("notes-updated", ()) {
            error!("Failed to emit notes-updated event: {}", e);
        }

        Ok(entry)
    }

    pub async fn update_note(&self, id: i64, title: String, body: String) -> Result<NoteEntry> {
        let now = Utc::now().timestamp();
        let conn = self.get_connection()?;
        let updated = conn.execute(
            "UPDATE notes SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4 AND deleted_at IS NULL",
            params![title, body, now, id],
        )?;

        if updated == 0 {
            return Err(anyhow::anyhow!("Note not found"));
        }

        let mut stmt = conn.prepare(
            "SELECT id, title, body, created_at, updated_at FROM notes WHERE id = ?1 AND deleted_at IS NULL",
        )?;
        let entry = stmt.query_row(params![id], |row| {
            Ok(NoteEntry {
                id: row.get("id")?,
                title: row.get("title")?,
                body: row.get("body")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?;

        if let Err(e) = self.app_handle.emit("notes-updated", ()) {
            error!("Failed to emit notes-updated event: {}", e);
        }

        Ok(entry)
    }

    pub async fn update_note_title(&self, id: i64, title: String) -> Result<NoteEntry> {
        let now = Utc::now().timestamp();
        let conn = self.get_connection()?;
        let updated = conn.execute(
            "UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![title, now, id],
        )?;

        if updated == 0 {
            return Err(anyhow::anyhow!("Note not found"));
        }

        let entry = self.get_note_by_id(id).await?;

        if let Err(e) = self.app_handle.emit("notes-updated", ()) {
            error!("Failed to emit notes-updated event: {}", e);
        }

        Ok(entry)
    }

    pub async fn append_to_note(&self, id: i64, text: String) -> Result<NoteEntry> {
        let text = text.trim();
        if text.is_empty() {
            return self.get_note_by_id(id).await;
        }

        let existing = self.get_note_by_id(id).await?;
        let mut combined = existing.body.trim_end().to_string();
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(text);

        self.update_note(id, existing.title, combined).await
    }

    pub async fn delete_note(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;
        let now = Utc::now().timestamp();
        conn.execute(
            "UPDATE notes SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![now, now, id],
        )?;
        debug!("Deleted note with id: {}", id);
        if self.get_active_note_id() == Some(id) {
            self.set_active_note_id(None);
        }

        if let Err(e) = self.app_handle.emit("notes-updated", ()) {
            error!("Failed to emit notes-updated event: {}", e);
        }

        Ok(())
    }

    pub fn prepare_sync_payload(&self, user_id: &str) -> Result<SyncPayload> {
        let client_id = self.get_or_create_client_id()?;
        let last_sync_at = self.get_last_sync_at(user_id)?;
        let history = self.get_history_changes(last_sync_at)?;
        let notes = self.get_note_changes(last_sync_at)?;

        Ok(SyncPayload {
            client_id,
            last_sync_at,
            history,
            notes,
        })
    }

    pub fn apply_sync_result(&self, user_id: &str, result: &SyncResult) -> Result<()> {
        self.apply_history_updates(&result.history)?;
        self.apply_note_updates(&result.notes)?;
        self.set_last_sync_at(user_id, result.server_time)?;

        if !result.history.is_empty() {
            if let Err(e) = self.app_handle.emit("history-updated", ()) {
                error!("Failed to emit history-updated event: {}", e);
            }
        }

        if !result.notes.is_empty() {
            if let Err(e) = self.app_handle.emit("notes-updated", ()) {
                error!("Failed to emit notes-updated event: {}", e);
            }
        }

        Ok(())
    }

    fn get_or_create_client_id(&self) -> Result<String> {
        let conn = self.get_connection()?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT client_id FROM sync_device WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(client_id) = existing {
            return Ok(client_id);
        }

        let client_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO sync_device (id, client_id) VALUES (1, ?1)",
            params![client_id],
        )?;
        Ok(client_id)
    }

    fn get_last_sync_at(&self, user_id: &str) -> Result<i64> {
        let conn = self.get_connection()?;
        let last_sync_at: Option<i64> = conn
            .query_row(
                "SELECT last_sync_at FROM sync_state WHERE user_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(last_sync_at.unwrap_or(0))
    }

    fn set_last_sync_at(&self, user_id: &str, timestamp: i64) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO sync_state (user_id, last_sync_at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET last_sync_at = excluded.last_sync_at",
            params![user_id, timestamp],
        )?;
        Ok(())
    }

    fn get_history_changes(&self, since: i64) -> Result<Vec<SyncHistoryEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, sync_id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, source_app_name, source_app_identifier, source_window_title, source_process_id, source_browser_tab_title, source_browser_tab_url, audio_duration_seconds, original_transcription_text, updated_at, deleted_at FROM transcription_history WHERE sync_id IS NULL OR updated_at IS NULL OR updated_at > ?1 ORDER BY COALESCE(updated_at, timestamp) DESC",
        )?;

        let rows = stmt.query_map(params![since], |row| {
            Ok((
                row.get::<_, i64>("id")?,
                row.get::<_, Option<String>>("sync_id")?,
                row.get::<_, String>("file_name")?,
                row.get::<_, i64>("timestamp")?,
                row.get::<_, bool>("saved")?,
                row.get::<_, String>("title")?,
                row.get::<_, String>("transcription_text")?,
                row.get::<_, Option<String>>("post_processed_text")?,
                row.get::<_, Option<String>>("post_process_prompt")?,
                row.get::<_, Option<String>>("source_app_name")?,
                row.get::<_, Option<String>>("source_app_identifier")?,
                row.get::<_, Option<String>>("source_window_title")?,
                row.get::<_, Option<i64>>("source_process_id")?,
                row.get::<_, Option<String>>("source_browser_tab_title")?,
                row.get::<_, Option<String>>("source_browser_tab_url")?,
                row.get::<_, Option<f64>>("audio_duration_seconds")?,
                row.get::<_, Option<String>>("original_transcription_text")?,
                row.get::<_, Option<i64>>("updated_at")?,
                row.get::<_, Option<i64>>("deleted_at")?,
            ))
        })?;

        let mut entries = Vec::new();
        let mut updates: Vec<(i64, String, i64)> = Vec::new();

        for row in rows {
            let (
                id,
                sync_id,
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                source_app_name,
                source_app_identifier,
                source_window_title,
                source_process_id,
                source_browser_tab_title,
                source_browser_tab_url,
                audio_duration_seconds,
                original_transcription_text,
                updated_at,
                deleted_at,
            ) = row?;

            let missing_sync_id = sync_id.is_none();
            let missing_updated_at = updated_at.is_none();
            let sync_id = sync_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            let updated_at = updated_at.unwrap_or(timestamp);

            if missing_sync_id || missing_updated_at {
                updates.push((id, sync_id.clone(), updated_at));
            }

            entries.push(SyncHistoryEntry {
                sync_id,
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                source_app_name,
                source_app_identifier,
                source_window_title,
                source_process_id,
                source_browser_tab_title,
                source_browser_tab_url,
                audio_duration_seconds,
                original_transcription_text,
                updated_at,
                deleted_at,
            });
        }

        for (id, sync_id, updated_at) in updates {
            conn.execute(
                "UPDATE transcription_history SET sync_id = ?1, updated_at = COALESCE(updated_at, ?2) WHERE id = ?3",
                params![sync_id, updated_at, id],
            )?;
        }

        Ok(entries)
    }

    fn get_note_changes(&self, since: i64) -> Result<Vec<SyncNoteEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, sync_id, title, body, created_at, updated_at, deleted_at FROM notes WHERE sync_id IS NULL OR updated_at IS NULL OR updated_at > ?1 ORDER BY COALESCE(updated_at, created_at) DESC",
        )?;

        let rows = stmt.query_map(params![since], |row| {
            Ok((
                row.get::<_, i64>("id")?,
                row.get::<_, Option<String>>("sync_id")?,
                row.get::<_, String>("title")?,
                row.get::<_, String>("body")?,
                row.get::<_, i64>("created_at")?,
                row.get::<_, i64>("updated_at")?,
                row.get::<_, Option<i64>>("deleted_at")?,
            ))
        })?;

        let mut notes = Vec::new();
        let mut updates: Vec<(i64, String)> = Vec::new();

        for row in rows {
            let (id, sync_id, title, body, created_at, updated_at, deleted_at) = row?;
            let missing_sync_id = sync_id.is_none();
            let sync_id = sync_id.unwrap_or_else(|| Uuid::new_v4().to_string());

            if missing_sync_id {
                updates.push((id, sync_id.clone()));
            }

            notes.push(SyncNoteEntry {
                sync_id,
                title,
                body,
                created_at,
                updated_at,
                deleted_at,
            });
        }

        for (id, sync_id) in updates {
            conn.execute(
                "UPDATE notes SET sync_id = ?1 WHERE id = ?2",
                params![sync_id, id],
            )?;
        }

        Ok(notes)
    }

    fn apply_history_updates(&self, entries: &[SyncHistoryEntry]) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }

        let conn = self.get_connection()?;

        for entry in entries {
            let existing: Option<(i64, i64, String)> = conn
                .query_row(
                    "SELECT id, updated_at, file_name FROM transcription_history WHERE sync_id = ?1",
                    params![entry.sync_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;

            if let Some((id, local_updated_at, local_file_name)) = existing {
                if local_updated_at >= entry.updated_at {
                    continue;
                }

                if entry.deleted_at.is_some() {
                    conn.execute(
                        "UPDATE transcription_history SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                        params![entry.deleted_at.unwrap_or(entry.updated_at), entry.updated_at, id],
                    )?;

                    let file_name = if entry.file_name.is_empty() {
                        local_file_name
                    } else {
                        entry.file_name.clone()
                    };
                    let file_path = self.recordings_dir.join(file_name);
                    if file_path.exists() {
                        if let Err(e) = fs::remove_file(&file_path) {
                            error!("Failed to delete audio file during sync: {}", e);
                        }
                    }

                    continue;
                }

                conn.execute(
                    "UPDATE transcription_history SET file_name = ?1, timestamp = ?2, saved = ?3, title = ?4, transcription_text = ?5, post_processed_text = ?6, post_process_prompt = ?7, source_app_name = ?8, source_app_identifier = ?9, source_window_title = ?10, source_process_id = ?11, source_browser_tab_title = ?12, source_browser_tab_url = ?13, audio_duration_seconds = ?14, original_transcription_text = ?15, updated_at = ?16, deleted_at = NULL WHERE id = ?17",
                    params![
                        entry.file_name,
                        entry.timestamp,
                        entry.saved,
                        entry.title,
                        entry.transcription_text,
                        entry.post_processed_text,
                        entry.post_process_prompt,
                        entry.source_app_name,
                        entry.source_app_identifier,
                        entry.source_window_title,
                        entry.source_process_id,
                        entry.source_browser_tab_title,
                        entry.source_browser_tab_url,
                        entry.audio_duration_seconds,
                        entry.original_transcription_text,
                        entry.updated_at,
                        id
                    ],
                )?;
            } else {
                if entry.deleted_at.is_some() {
                    continue;
                }

                conn.execute(
                    "INSERT INTO transcription_history (sync_id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, source_app_name, source_app_identifier, source_window_title, source_process_id, source_browser_tab_title, source_browser_tab_url, audio_duration_seconds, original_transcription_text, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                    params![
                        entry.sync_id,
                        entry.file_name,
                        entry.timestamp,
                        entry.saved,
                        entry.title,
                        entry.transcription_text,
                        entry.post_processed_text,
                        entry.post_process_prompt,
                        entry.source_app_name,
                        entry.source_app_identifier,
                        entry.source_window_title,
                        entry.source_process_id,
                        entry.source_browser_tab_title,
                        entry.source_browser_tab_url,
                        entry.audio_duration_seconds,
                        entry.original_transcription_text,
                        entry.updated_at,
                        entry.deleted_at
                    ],
                )?;
            }
        }

        self.rebuild_history_metrics_with_connection(&conn)?;

        Ok(())
    }

    fn apply_note_updates(&self, entries: &[SyncNoteEntry]) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }

        let conn = self.get_connection()?;

        for entry in entries {
            let existing: Option<(i64, i64)> = conn
                .query_row(
                    "SELECT id, updated_at FROM notes WHERE sync_id = ?1",
                    params![entry.sync_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;

            if let Some((id, local_updated_at)) = existing {
                if local_updated_at >= entry.updated_at {
                    continue;
                }

                if entry.deleted_at.is_some() {
                    conn.execute(
                        "UPDATE notes SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
                        params![
                            entry.deleted_at.unwrap_or(entry.updated_at),
                            entry.updated_at,
                            id
                        ],
                    )?;
                    if self.get_active_note_id() == Some(id) {
                        self.set_active_note_id(None);
                    }
                    continue;
                }

                conn.execute(
                    "UPDATE notes SET title = ?1, body = ?2, created_at = ?3, updated_at = ?4, deleted_at = NULL WHERE id = ?5",
                    params![
                        entry.title,
                        entry.body,
                        entry.created_at,
                        entry.updated_at,
                        id
                    ],
                )?;
            } else {
                if entry.deleted_at.is_some() {
                    continue;
                }
                conn.execute(
                    "INSERT INTO notes (sync_id, title, body, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        entry.sync_id,
                        entry.title,
                        entry.body,
                        entry.created_at,
                        entry.updated_at,
                        entry.deleted_at
                    ],
                )?;
            }
        }

        Ok(())
    }
}

fn normalize_app_option_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn app_option_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn unique_history_app_filter_options(
    candidates: Vec<HistoryAppFilterOption>,
) -> Vec<HistoryAppFilterOption> {
    let identifier_label_keys: HashSet<String> = candidates
        .iter()
        .filter(|option| option.filter_type == HistoryAppFilterType::Identifier)
        .filter_map(|option| normalize_app_option_value(&option.label))
        .map(|label| app_option_key(&label))
        .collect();

    let mut seen = HashSet::new();
    let mut options = Vec::new();

    for mut option in candidates {
        let Some(value) = normalize_app_option_value(&option.value) else {
            continue;
        };
        let Some(label) = normalize_app_option_value(&option.label) else {
            continue;
        };

        option.value = value;
        option.label = label;
        option.icon_identifier = option
            .icon_identifier
            .and_then(|identifier| normalize_app_option_value(&identifier));

        if option.filter_type == HistoryAppFilterType::Name
            && identifier_label_keys.contains(&app_option_key(&option.label))
        {
            continue;
        }

        let kind = match option.filter_type {
            HistoryAppFilterType::Identifier => "identifier",
            HistoryAppFilterType::Name => "name",
        };
        let key = format!("{}:{}", kind, app_option_key(&option.value));
        if seen.insert(key) {
            options.push(option);
        }
    }

    options
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_option(
        filter_type: HistoryAppFilterType,
        value: &str,
        label: &str,
        icon_identifier: Option<&str>,
    ) -> HistoryAppFilterOption {
        HistoryAppFilterOption {
            filter_type,
            value: value.to_string(),
            label: label.to_string(),
            icon_identifier: icon_identifier.map(str::to_string),
        }
    }

    #[test]
    fn unique_history_app_filter_options_removes_duplicate_apps() {
        let options = unique_history_app_filter_options(vec![
            app_option(
                HistoryAppFilterType::Identifier,
                "com.acme.crm",
                "Acme CRM",
                Some("com.acme.crm"),
            ),
            app_option(
                HistoryAppFilterType::Identifier,
                " com.acme.crm ",
                "Acme CRM",
                Some(" com.acme.crm "),
            ),
            app_option(HistoryAppFilterType::Name, "Acme CRM", "Acme CRM", None),
            app_option(HistoryAppFilterType::Name, "Slack", "Slack", None),
            app_option(HistoryAppFilterType::Name, "slack", "slack", None),
            app_option(
                HistoryAppFilterType::Identifier,
                "com.apple.Safari",
                "com.apple.Safari",
                Some("com.apple.Safari"),
            ),
        ]);

        assert_eq!(
            options,
            vec![
                app_option(
                    HistoryAppFilterType::Identifier,
                    "com.acme.crm",
                    "Acme CRM",
                    Some("com.acme.crm"),
                ),
                app_option(HistoryAppFilterType::Name, "Slack", "Slack", None),
                app_option(
                    HistoryAppFilterType::Identifier,
                    "com.apple.Safari",
                    "com.apple.Safari",
                    Some("com.apple.Safari"),
                ),
            ]
        );
    }
}
