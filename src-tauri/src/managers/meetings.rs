use anyhow::Result;
use chrono::{DateTime, Local, Utc};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use log::{error, info, warn};
use rodio::{Decoder, Source};
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json;
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, ErrorKind};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::audio_toolkit::get_cpal_host;
use crate::helpers::clamshell;
use crate::llm_client;
use crate::managers::local_llm::LocalLlmManager;
use crate::managers::transcription::TranscriptionManager;
use crate::polish;
use crate::settings::{get_settings, AppSettings, PostProcessProvider, OPENAI_CODEX_PROVIDER_ID};

const MEETING_TARGET_SAMPLE_RATE: u32 = 24_000;
const NAME_SNIPPET_SECONDS: f32 = 20.0;
const TRANSCRIPTION_SAMPLE_RATE: u32 = 16_000;
const MEETING_LIGHTWEIGHT_MODEL_ID: &str = "qwen3.5-0.8b";
const LIVE_TRANSCRIPT_WINDOW_SECONDS: f32 = 8.0;
const LIVE_TRANSCRIPT_MIN_WINDOW_SECONDS: f32 = 3.0;
const LIVE_TRANSCRIPT_STEP_MS: u64 = 700;
const LIVE_TRANSCRIPT_REWRITE_LOOKBACK_SECONDS: f32 = 4.0;
const LIVE_TRANSCRIPT_MIC_PREFER_WINDOW_MS: u64 = 700;
const LIVE_TRANSCRIPT_MIC_SILENCE_HANGOVER_MS: u64 = 420;
const LIVE_TRANSCRIPT_SYSTEM_ACTIVITY_RMS: f32 = 0.006;
const LIVE_TRANSCRIPT_MIC_ACTIVITY_RMS: f32 = 0.003;
const LIVE_TRANSCRIPT_MIC_SILENCE_RMS: f32 = 0.0015;
const LIVE_TRANSCRIPT_TIME_FLOOR_BACKTRACK_SECONDS: f32 = 0.35;
const LIVE_TRANSCRIPT_OVERLAP_WINDOW_TOKENS: usize = 160;
const MEETING_TRANSCRIPT_CHUNK_SECONDS: f32 = 30.0;
const MEETING_TRANSCRIPT_MIN_CHUNK_SECONDS: f32 = 1.0;
const MEETING_TRANSCRIPT_SPLIT_MAX_DEPTH: usize = 3;
const MEETING_TRANSCRIPT_SPLIT_MIN_SECONDS: f32 = 4.0;
const MEETING_TRANSCRIPT_SILENCE_RMS: f32 = 0.0001;
const MEETING_SOFT_DELETE_RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;
const MEETING_TRANSCRIPT_CLEANUP_MAX_CHARS: usize = 120_000;
const MEETING_TRANSCRIPT_CLEANUP_MIN_VALID_SEGMENT_RATIO: f32 = 0.7;
const MEETING_TRANSCRIPT_CLEANUP_MIN_SEGMENT_CHAR_RATIO: f32 = 0.25;
const MEETING_TRANSCRIPT_CLEANUP_MAX_SEGMENT_CHAR_RATIO: f32 = 3.0;
const MEETING_TRANSCRIPT_CLEANUP_DEFAULT_REASONING_EFFORT: Option<&str> = None;
const MEETING_LLM_DEFAULT_REASONING_EFFORT: Option<&str> = Some("low");
fn meeting_transcript_cleanup_system_prompt(remove_filler_words: bool) -> String {
    let filler_rule = if remove_filler_words {
        "Remove non-meaningful filler words and disfluencies."
    } else {
        "Preserve filler words when they appear in the transcript."
    };

    format!(
        "You clean meeting ASR transcripts. \
Return only valid JSON with no markdown. \
Do not add, remove, or infer facts. \
Preserve meaning and language. \
Preserve each placeholder token exactly as provided (for example <<V0>>). \
Never merge, split, reorder, or drop segments. \
Return exactly one segment for every input index. \
If uncertain, keep the original segment text unchanged. \
Only improve segment text quality (punctuation, capitalization, and obvious ASR mistakes). \
{filler_rule} \
Convert spoken punctuation words to symbols when clear. \
Keep numbers faithful to what was spoken; do not perform arithmetic. \
Preserve proper nouns, product names, and technical terms unless the correction is unambiguous."
    )
}
const DIARIZATION_STATUS_IDLE: &str = "idle";
const DIARIZATION_STATUS_RUNNING: &str = "running";
const DIARIZATION_STATUS_COMPLETED: &str = "completed";
const DIARIZATION_STATUS_FAILED: &str = "failed";
const DIARIZATION_SCRIPT_NAME: &str = "meetings_diarize.py";
const DIARIZATION_PYTHON_DEFAULT: &str = "python3";
const DIARIZATION_SAMPLE_RATE: u32 = 16_000;
const DIARIZATION_COLLAR_SECONDS: f32 = 0.05;
const DIARIZATION_STALE_RUNNING_MULTIPLIER: i64 = 6;
const DIARIZATION_STALE_RUNNING_FLOOR_SECONDS: i64 = 180;
const MEETING_BACKGROUND_SCAN_INTERVAL_SECONDS: u64 = 30;
const MEETING_BACKGROUND_MAX_STARTS_PER_SCAN: usize = 2;
const MEETING_BACKGROUND_PIPELINE_STALE_SECONDS: i64 = 20 * 60;
const MEETING_DB_BUSY_TIMEOUT_SECONDS: u64 = 10;
const MEETING_AUDIO_UNAVAILABLE_MESSAGE: &str =
    "Meeting audio file is not available yet. It may still be finishing.";
const SPEAKER_COLOR_PALETTE: &[&str] = &[
    "#0EA5E9", "#22C55E", "#F59E0B", "#EC4899", "#A855F7", "#14B8A6", "#F97316", "#6366F1",
];

static MEETINGS_MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE IF NOT EXISTS meetings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER NOT NULL,
            duration_seconds REAL NOT NULL,
            file_name TEXT NOT NULL,
            include_system_audio BOOLEAN NOT NULL DEFAULT 0
        );",
    ),
    M::up("CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings(started_at DESC);"),
    M::up(
        "CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            normalized TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS meeting_tags (
            meeting_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            UNIQUE(meeting_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tags_normalized ON tags(normalized);
        CREATE INDEX IF NOT EXISTS idx_meeting_tags_meeting_id ON meeting_tags(meeting_id);",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS meeting_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id INTEGER NOT NULL,
            offset_seconds REAL NOT NULL,
            created_at INTEGER NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_notes_meeting_id ON meeting_notes(meeting_id);
        CREATE INDEX IF NOT EXISTS idx_meeting_notes_offset ON meeting_notes(meeting_id, offset_seconds);
        CREATE TABLE IF NOT EXISTS meeting_transcripts (
            meeting_id INTEGER PRIMARY KEY,
            transcript_text TEXT NOT NULL,
            segments_json TEXT NOT NULL
        );",
    ),
    M::up(
        "ALTER TABLE meeting_notes ADD COLUMN start_offset_seconds REAL;
        ALTER TABLE meeting_notes ADD COLUMN end_offset_seconds REAL;
        UPDATE meeting_notes
        SET
            start_offset_seconds = COALESCE(start_offset_seconds, offset_seconds),
            end_offset_seconds = COALESCE(end_offset_seconds, offset_seconds)
        WHERE start_offset_seconds IS NULL OR end_offset_seconds IS NULL;",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            photo_data_url TEXT,
            voice_embedding BLOB,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meeting_participants (
            meeting_id INTEGER NOT NULL,
            participant_id INTEGER NOT NULL,
            PRIMARY KEY (meeting_id, participant_id)
        );
        CREATE INDEX IF NOT EXISTS idx_participants_name ON participants(name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_meeting_participants_meeting_id ON meeting_participants(meeting_id);
        CREATE INDEX IF NOT EXISTS idx_meeting_participants_participant_id ON meeting_participants(participant_id);",
    ),
    M::up(
        "ALTER TABLE meetings ADD COLUMN deleted_at INTEGER;
        CREATE INDEX IF NOT EXISTS idx_meetings_deleted_at ON meetings(deleted_at, ended_at DESC);",
    ),
    M::up(
        "ALTER TABLE meetings ADD COLUMN sync_id TEXT;
        ALTER TABLE meetings ADD COLUMN updated_at INTEGER;
        ALTER TABLE meetings ADD COLUMN is_visible BOOLEAN NOT NULL DEFAULT 1;
        ALTER TABLE meetings ADD COLUMN cloud_audio_key TEXT;
        ALTER TABLE meetings ADD COLUMN cloud_audio_uploaded_at INTEGER;
        UPDATE meetings
        SET sync_id = lower(
          hex(randomblob(4)) || '-' ||
          hex(randomblob(2)) || '-' ||
          '4' || substr(hex(randomblob(2)), 2) || '-' ||
          substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
          hex(randomblob(6))
        )
        WHERE sync_id IS NULL OR trim(sync_id) = '';
        UPDATE meetings
        SET updated_at = COALESCE(updated_at, ended_at, started_at, CAST(strftime('%s','now') AS INTEGER))
        WHERE updated_at IS NULL;
        UPDATE meetings
        SET is_visible = CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END;
        CREATE INDEX IF NOT EXISTS idx_meetings_sync_id ON meetings(sync_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_sync_id_unique ON meetings(sync_id);
        CREATE INDEX IF NOT EXISTS idx_meetings_updated_at ON meetings(updated_at);
        CREATE TABLE IF NOT EXISTS meeting_sync_state (
          user_id TEXT PRIMARY KEY,
          last_sync_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS meeting_sync_device (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          client_id TEXT NOT NULL
        );",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS meeting_diarization_jobs (
            meeting_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            estimated_seconds INTEGER,
            error_message TEXT,
            started_at INTEGER,
            completed_at INTEGER,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_diarization_jobs_status
            ON meeting_diarization_jobs(status);

        CREATE TABLE IF NOT EXISTS meeting_diarization_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id INTEGER NOT NULL,
            start_seconds REAL NOT NULL,
            end_seconds REAL NOT NULL,
            raw_speaker_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_diarization_segments_meeting
            ON meeting_diarization_segments(meeting_id, start_seconds);

        CREATE TABLE IF NOT EXISTS meeting_speaker_mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id INTEGER NOT NULL,
            raw_speaker_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            color TEXT NOT NULL,
            participant_id INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(meeting_id, raw_speaker_id)
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_speaker_mappings_meeting
            ON meeting_speaker_mappings(meeting_id, raw_speaker_id);",
    ),
];

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingEntry {
    pub id: i64,
    pub sync_id: String,
    pub name: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub duration_seconds: f64,
    pub file_name: String,
    pub include_system_audio: bool,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct DeletedMeetingEntry {
    pub id: i64,
    pub name: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub duration_seconds: f64,
    pub file_name: String,
    pub include_system_audio: bool,
    pub tags: Vec<String>,
    pub deleted_at: i64,
    pub purge_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ActiveMeetingInfo {
    pub id: i64,
    pub started_at: i64,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingNote {
    pub id: i64,
    pub meeting_id: i64,
    pub offset_seconds: f64,
    pub start_offset_seconds: f64,
    pub end_offset_seconds: f64,
    pub created_at: i64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingTranscriptSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
    #[serde(default)]
    pub speaker_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingTranscript {
    pub text: String,
    pub segments: Vec<MeetingTranscriptSegment>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingSpeakerMapping {
    pub raw_speaker_id: String,
    pub display_name: String,
    pub color: String,
    pub participant_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingDiarizationStatus {
    pub status: String,
    pub estimated_seconds: Option<i64>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SenkoDiarizationSegment {
    start: f32,
    end: f32,
    speaker: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SenkoDiarizationOutput {
    merged_segments: Vec<SenkoDiarizationSegment>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingLiveTranscriptUpdate {
    pub meeting_id: i64,
    pub transcript: MeetingTranscript,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingPermissionNotice {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingParticipant {
    pub id: i64,
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub photo_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingSummaryResult {
    pub summary: String,
    pub key_points: Vec<String>,
    pub decisions: Vec<String>,
    pub risks: Vec<String>,
    pub follow_ups: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingGeneratedTask {
    pub title: String,
    pub notes: String,
    pub priority: i32,
    pub tags: Vec<String>,
    pub due_hint: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingFollowUpDraft {
    pub subject: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct SyncMeetingEntry {
    pub sync_id: String,
    pub file_name: String,
    pub name: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub duration_seconds: f64,
    pub include_system_audio: bool,
    pub tags: Vec<String>,
    pub audio_s3_key: Option<String>,
    pub audio_uploaded_at: Option<i64>,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub is_visible: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingsSyncPayload {
    pub client_id: String,
    pub last_sync_at: i64,
    pub meetings: Vec<SyncMeetingEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingsSyncResult {
    pub server_time: i64,
    pub meetings: Vec<SyncMeetingEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct PendingMeetingAudioUpload {
    pub sync_id: String,
    pub file_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingAudioDownloadCandidate {
    pub sync_id: String,
    pub file_name: String,
}

#[derive(Debug, Serialize)]
struct MeetingTranscriptCleanupRequest {
    segments: Vec<MeetingTranscriptCleanupRequestSegment>,
}

#[derive(Debug, Serialize)]
struct MeetingTranscriptCleanupRequestSegment {
    index: usize,
    text: String,
}

#[derive(Debug, Deserialize)]
struct MeetingTranscriptCleanupResponse {
    #[serde(default)]
    text: Option<String>,
    segments: Vec<MeetingTranscriptCleanupResponseSegment>,
}

#[derive(Debug, Deserialize)]
struct MeetingTranscriptCleanupResponseSegment {
    index: usize,
    text: String,
}

struct RecordingOutput {
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LiveAudioSource {
    Mic,
    System,
}

#[derive(Debug)]
struct LiveAudioChunk {
    source: LiveAudioSource,
    sample_rate: u32,
    samples: Vec<f32>,
}

#[derive(Default)]
struct LiveResamplerSlot {
    input_sample_rate: Option<u32>,
    resampler: Option<crate::audio_toolkit::audio::FrameResampler>,
}

impl LiveResamplerSlot {
    fn resample(&mut self, samples: Vec<f32>, sample_rate: u32) -> Vec<f32> {
        if sample_rate == TRANSCRIPTION_SAMPLE_RATE {
            return samples;
        }
        if samples.is_empty() || sample_rate == 0 {
            return Vec::new();
        }

        if self.input_sample_rate != Some(sample_rate) || self.resampler.is_none() {
            self.input_sample_rate = Some(sample_rate);
            self.resampler = Some(crate::audio_toolkit::audio::FrameResampler::new(
                sample_rate as usize,
                TRANSCRIPTION_SAMPLE_RATE as usize,
                Duration::from_millis(30),
            ));
        }

        let mut output = Vec::new();
        if let Some(resampler) = self.resampler.as_mut() {
            resampler.push(&samples, |frame| output.extend_from_slice(frame));
        }
        output
    }
}

#[derive(Default)]
struct LiveResamplers {
    mic: LiveResamplerSlot,
    system: LiveResamplerSlot,
}

impl LiveResamplers {
    fn resample(&mut self, chunk: LiveAudioChunk) -> Vec<f32> {
        match chunk.source {
            LiveAudioSource::Mic => self.mic.resample(chunk.samples, chunk.sample_rate),
            LiveAudioSource::System => self.system.resample(chunk.samples, chunk.sample_rate),
        }
    }
}

struct LiveTranscriptRecorder {
    chunk_tx: mpsc::Sender<LiveAudioChunk>,
    stop_tx: mpsc::Sender<()>,
    transcript: Arc<Mutex<MeetingTranscript>>,
    join: thread::JoinHandle<()>,
}

struct MeetingRecording {
    meeting_id: i64,
    started_at: i64,
    initial_name: String,
    file_name: String,
    include_system_audio: bool,
    mic: MicRecording,
    system: Option<SystemRecording>,
    live_transcript: LiveTranscriptRecorder,
}

struct StopFinalizeContext {
    meeting_id: i64,
    started_at: i64,
    ended_at: i64,
    initial_name: String,
    file_name: String,
    output_path: PathBuf,
    resolved_mic_path: PathBuf,
    resolved_system_path: Option<PathBuf>,
    name_override: Option<String>,
}

impl LiveTranscriptRecorder {
    fn start(app_handle: AppHandle, meeting_id: i64, include_system_audio: bool) -> Self {
        let (chunk_tx, chunk_rx) = mpsc::channel::<LiveAudioChunk>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let transcript = Arc::new(Mutex::new(MeetingTranscript {
            text: String::new(),
            segments: Vec::new(),
        }));
        let transcript_for_worker = Arc::clone(&transcript);

        let join = thread::spawn(move || {
            let window_samples =
                (LIVE_TRANSCRIPT_WINDOW_SECONDS * TRANSCRIPTION_SAMPLE_RATE as f32) as usize;
            let min_window_samples =
                (LIVE_TRANSCRIPT_MIN_WINDOW_SECONDS * TRANSCRIPTION_SAMPLE_RATE as f32) as usize;
            let step_samples = (LIVE_TRANSCRIPT_STEP_MS as f32 * TRANSCRIPTION_SAMPLE_RATE as f32
                / 1000.0)
                .round() as usize;
            let lookback_samples = (LIVE_TRANSCRIPT_REWRITE_LOOKBACK_SECONDS
                * TRANSCRIPTION_SAMPLE_RATE as f32)
                .round() as usize;
            let rewrite_interval = Duration::from_millis(LIVE_TRANSCRIPT_STEP_MS);

            let transcription_manager = app_handle.state::<Arc<TranscriptionManager>>();
            if let Err(err) = transcription_manager.ensure_live_model_loaded() {
                warn!(
                    "Unable to load a live transcription model at meeting start: {}",
                    err
                );
                transcription_manager.initiate_model_load();
            }

            let vad_path = app_handle
                .path()
                .resolve(
                    "resources/models/silero_vad_v4.onnx",
                    tauri::path::BaseDirectory::Resource,
                )
                .ok();

            let mut vad: Option<Box<dyn crate::audio_toolkit::VoiceActivityDetector>> =
                if let Some(path) = vad_path {
                    if let Ok(silero) = crate::audio_toolkit::SileroVad::new(
                        path.to_string_lossy().to_string(),
                        0.3,
                    ) {
                        Some(Box::new(crate::audio_toolkit::vad::SmoothedVad::new(
                            Box::new(silero),
                            15,
                            15,
                            2,
                        )))
                    } else {
                        None
                    }
                } else {
                    None
                };
            let mut vad_buffer = Vec::new();

            let mut buffered_samples: Vec<f32> = Vec::new();
            let mut live_resamplers = LiveResamplers::default();
            let mut buffer_start_sample_index: usize = 0;
            let mut total_samples_seen: usize = 0;
            let mut last_transcribed_sample_index: usize = 0;
            let mut stopping = false;
            let mut last_mic_chunk_seen: Option<Instant> = None;
            let mut previous_uncommitted_token_spans: Vec<(String, f32, f32)> = Vec::new();
            let mut last_emit_at = Instant::now()
                .checked_sub(rewrite_interval)
                .unwrap_or_else(Instant::now);

            loop {
                if !stopping && stop_rx.try_recv().is_ok() {
                    stopping = true;
                }

                match chunk_rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(chunk) => {
                        ingest_live_audio_chunk(
                            chunk,
                            include_system_audio,
                            &mut last_mic_chunk_seen,
                            &mut total_samples_seen,
                            &mut buffered_samples,
                            &mut vad,
                            &mut vad_buffer,
                            &mut live_resamplers,
                        );
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        stopping = true;
                    }
                }

                // Drain pending chunks so inference stays near real-time under load.
                while let Ok(chunk) = chunk_rx.try_recv() {
                    ingest_live_audio_chunk(
                        chunk,
                        include_system_audio,
                        &mut last_mic_chunk_seen,
                        &mut total_samples_seen,
                        &mut buffered_samples,
                        &mut vad,
                        &mut vad_buffer,
                        &mut live_resamplers,
                    );
                }

                // Bound memory and keep the working set hot while preserving enough context.
                let keep_samples = window_samples.saturating_add(step_samples.saturating_mul(8));
                if buffered_samples.len() > keep_samples {
                    let drop_count = buffered_samples.len() - keep_samples;
                    buffered_samples.drain(..drop_count);
                    buffer_start_sample_index =
                        buffer_start_sample_index.saturating_add(drop_count);
                }

                let has_min_window = buffered_samples.len() >= min_window_samples;
                let enough_new_audio = total_samples_seen
                    .saturating_sub(last_transcribed_sample_index)
                    >= step_samples;
                let ready_by_time = last_emit_at.elapsed() >= rewrite_interval;

                if has_min_window && ready_by_time && (enough_new_audio || stopping) {
                    let window_start_in_buffer = compute_live_window_start_in_buffer(
                        total_samples_seen,
                        last_transcribed_sample_index,
                        buffer_start_sample_index,
                        buffered_samples.len(),
                        lookback_samples,
                        min_window_samples,
                        window_samples,
                    );
                    let absolute_window_start_samples =
                        buffer_start_sample_index.saturating_add(window_start_in_buffer);
                    let window_start_seconds =
                        absolute_window_start_samples as f32 / TRANSCRIPTION_SAMPLE_RATE as f32;

                    let window = buffered_samples[window_start_in_buffer..].to_vec();
                    process_live_transcript_window(
                        &app_handle,
                        &transcription_manager,
                        meeting_id,
                        window_start_seconds,
                        window,
                        &transcript_for_worker,
                        &mut previous_uncommitted_token_spans,
                        stopping,
                    );

                    last_emit_at = Instant::now();
                    last_transcribed_sample_index = total_samples_seen;
                }

                if stopping {
                    if !buffered_samples.is_empty()
                        && total_samples_seen > last_transcribed_sample_index
                    {
                        let window_start_in_buffer = compute_live_window_start_in_buffer(
                            total_samples_seen,
                            last_transcribed_sample_index,
                            buffer_start_sample_index,
                            buffered_samples.len(),
                            lookback_samples,
                            1,
                            window_samples,
                        );
                        let remaining_start_seconds = (buffer_start_sample_index
                            .saturating_add(window_start_in_buffer))
                            as f32
                            / TRANSCRIPTION_SAMPLE_RATE as f32;
                        process_live_transcript_window(
                            &app_handle,
                            &transcription_manager,
                            meeting_id,
                            remaining_start_seconds,
                            buffered_samples[window_start_in_buffer..].to_vec(),
                            &transcript_for_worker,
                            &mut previous_uncommitted_token_spans,
                            true,
                        );
                    }
                    break;
                }
            }
        });

        Self {
            chunk_tx,
            stop_tx,
            transcript,
            join,
        }
    }

    fn chunk_sender(&self) -> mpsc::Sender<LiveAudioChunk> {
        self.chunk_tx.clone()
    }

    fn snapshot(&self) -> MeetingTranscript {
        self.transcript.lock().unwrap().clone()
    }

    fn stop(self) {
        let _ = self.stop_tx.send(());
        let _ = self.join.join();
    }
}

fn compute_live_window_start_in_buffer(
    total_samples_seen: usize,
    last_transcribed_sample_index: usize,
    buffer_start_sample_index: usize,
    buffered_samples_len: usize,
    lookback_samples: usize,
    min_window_samples: usize,
    max_window_samples: usize,
) -> usize {
    if buffered_samples_len == 0 {
        return 0;
    }

    let bounded_min_window = min_window_samples.clamp(1, buffered_samples_len);
    let bounded_max_window = max_window_samples.max(bounded_min_window);
    let new_audio_samples = total_samples_seen.saturating_sub(last_transcribed_sample_index);
    let target_window_samples = new_audio_samples
        .saturating_add(lookback_samples)
        .max(bounded_min_window)
        .min(bounded_max_window);
    let desired_window_start_samples = total_samples_seen.saturating_sub(target_window_samples);
    let latest_start_for_min_window = buffered_samples_len.saturating_sub(bounded_min_window);

    desired_window_start_samples
        .saturating_sub(buffer_start_sample_index)
        .min(latest_start_for_min_window)
}

fn ingest_live_audio_chunk(
    chunk: LiveAudioChunk,
    include_system_audio: bool,
    last_mic_chunk_seen: &mut Option<Instant>,
    total_samples_seen: &mut usize,
    buffered_samples: &mut Vec<f32>,
    vad: &mut Option<Box<dyn crate::audio_toolkit::VoiceActivityDetector>>,
    vad_buffer: &mut Vec<f32>,
    live_resamplers: &mut LiveResamplers,
) {
    let mut allow_chunk = false;
    let mut is_mic = false;
    let source = chunk.source;

    match source {
        LiveAudioSource::System => {
            let system_is_active = chunk_rms(&chunk.samples) >= LIVE_TRANSCRIPT_SYSTEM_ACTIVITY_RMS;
            if !include_system_audio {
                allow_chunk = false;
            } else {
                match (*last_mic_chunk_seen, system_is_active) {
                    (_, false) => allow_chunk = false,
                    (Some(last_mic_seen), true) => {
                        allow_chunk = last_mic_seen.elapsed()
                            > Duration::from_millis(LIVE_TRANSCRIPT_MIC_PREFER_WINDOW_MS);
                    }
                    (None, true) => allow_chunk = true,
                }
            }
        }
        LiveAudioSource::Mic => {
            is_mic = true;
        }
    };

    if source == LiveAudioSource::System && !allow_chunk {
        return;
    }

    let samples = live_resamplers.resample(chunk);

    if samples.is_empty() {
        return;
    }

    if is_mic {
        if let Some(vad) = vad {
            vad_buffer.extend_from_slice(&samples);
            let mut speech_detected = false;

            while vad_buffer.len() >= 480 {
                let frame: Vec<f32> = vad_buffer.drain(..480).collect();

                match vad.push_frame(&frame) {
                    Ok(crate::audio_toolkit::vad::VadFrame::Speech(speech_buf)) => {
                        speech_detected = true;

                        let frames_yielded = speech_buf.len() / 480;
                        if frames_yielded > 1 {
                            let overwrite_samples = speech_buf.len() - 480;
                            if buffered_samples.len() >= overwrite_samples {
                                let start_idx = buffered_samples.len() - overwrite_samples;
                                buffered_samples[start_idx..]
                                    .copy_from_slice(&speech_buf[..overwrite_samples]);
                            }
                        }

                        let current_frame = &speech_buf[speech_buf.len() - 480..];
                        buffered_samples.extend_from_slice(current_frame);
                    }
                    _ => {
                        buffered_samples.resize(buffered_samples.len() + 480, 0.0);
                    }
                }
                *total_samples_seen = total_samples_seen.saturating_add(480);
            }

            if speech_detected {
                *last_mic_chunk_seen = Some(Instant::now());
            }
            return;
        } else {
            let mic_rms = chunk_rms(&samples);
            let mic_is_active = mic_rms >= LIVE_TRANSCRIPT_MIC_ACTIVITY_RMS;
            if mic_is_active {
                *last_mic_chunk_seen = Some(Instant::now());
                allow_chunk = true;
            } else {
                let recent_mic_activity = last_mic_chunk_seen
                    .as_ref()
                    .map(|last_mic_seen| {
                        last_mic_seen.elapsed()
                            <= Duration::from_millis(LIVE_TRANSCRIPT_MIC_SILENCE_HANGOVER_MS)
                    })
                    .unwrap_or(false);
                allow_chunk = recent_mic_activity || mic_rms >= LIVE_TRANSCRIPT_MIC_SILENCE_RMS;
            }
        }
    }

    *total_samples_seen = total_samples_seen.saturating_add(samples.len());

    if !allow_chunk {
        buffered_samples.resize(buffered_samples.len() + samples.len(), 0.0);
    } else {
        buffered_samples.extend_from_slice(&samples);
    }
}

fn process_live_transcript_window(
    app_handle: &AppHandle,
    transcription_manager: &Arc<TranscriptionManager>,
    meeting_id: i64,
    window_start_seconds: f32,
    samples: Vec<f32>,
    transcript_state: &Arc<Mutex<MeetingTranscript>>,
    previous_uncommitted_token_spans: &mut Vec<(String, f32, f32)>,
    flush_unstable: bool,
) {
    if samples.is_empty() {
        return;
    }

    // Skip transcription if the entire window is basically digital silence.
    // This happens frequently now that we push zeroes during silent chunks.
    if chunk_rms(&samples) < 0.0001 {
        return;
    }

    let duration_seconds = samples.len() as f32 / TRANSCRIPTION_SAMPLE_RATE as f32;
    let window_end_seconds = window_start_seconds + duration_seconds;
    let transcription = match transcribe_live_window(transcription_manager, samples) {
        Ok(result) => result,
        Err(err) => {
            warn!("Live meeting transcription failed: {}", err);
            return;
        }
    };

    let fallback_text = transcription.text.trim().to_string();
    let mut rewritten_window_segments = transcription
        .segments
        .unwrap_or_default()
        .into_iter()
        .map(|segment| MeetingTranscriptSegment {
            start: window_start_seconds + segment.start.max(0.0),
            end: window_start_seconds + segment.end.max(segment.start),
            text: segment.text.trim().to_string(),
            speaker_id: None,
        })
        .filter(|segment| !segment.text.is_empty())
        .collect::<Vec<_>>();

    if rewritten_window_segments.is_empty() && !fallback_text.is_empty() {
        rewritten_window_segments.push(MeetingTranscriptSegment {
            start: window_start_seconds,
            end: window_end_seconds,
            text: fallback_text,
            speaker_id: None,
        });
    }

    if rewritten_window_segments.is_empty() {
        return;
    }

    let incoming_token_spans = tokenize_live_segments(&rewritten_window_segments);
    if incoming_token_spans.is_empty() {
        return;
    }

    let payload = {
        let mut transcript = transcript_state.lock().unwrap();
        let committed_end_seconds = transcript
            .segments
            .last()
            .map(|segment| segment.end)
            .unwrap_or(0.0);
        let time_floor =
            (committed_end_seconds - LIVE_TRANSCRIPT_TIME_FLOOR_BACKTRACK_SECONDS).max(0.0);
        let mut active_token_spans = incoming_token_spans
            .iter()
            .filter(|(_, _, end)| *end > time_floor)
            .cloned()
            .collect::<Vec<_>>();
        if active_token_spans.is_empty() {
            active_token_spans = incoming_token_spans.clone();
        }

        let existing_tokens = transcript
            .text
            .split_whitespace()
            .map(|token| token.to_string())
            .collect::<Vec<_>>();
        let existing_tail = if existing_tokens.len() > LIVE_TRANSCRIPT_OVERLAP_WINDOW_TOKENS {
            existing_tokens[existing_tokens.len() - LIVE_TRANSCRIPT_OVERLAP_WINDOW_TOKENS..]
                .to_vec()
        } else {
            existing_tokens.clone()
        };
        let incoming_tokens = active_token_spans
            .iter()
            .map(|(token, _, _)| token.clone())
            .collect::<Vec<_>>();
        let overlap = count_live_token_overlap(&existing_tail, &incoming_tokens);

        if overlap >= active_token_spans.len() {
            previous_uncommitted_token_spans.clear();
            None
        } else {
            let candidate_token_spans = active_token_spans[overlap..].to_vec();
            let commit_count = if flush_unstable {
                candidate_token_spans.len()
            } else {
                count_live_prefix_agreement(
                    previous_uncommitted_token_spans,
                    &candidate_token_spans,
                )
            };

            if commit_count == 0 {
                *previous_uncommitted_token_spans = candidate_token_spans;
                None
            } else {
                let appended_tokens = &candidate_token_spans[..commit_count];
                let appended_text = appended_tokens
                    .iter()
                    .map(|(token, _, _)| token.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                if appended_text.trim().is_empty() {
                    None
                } else {
                    let appended_start = appended_tokens
                        .first()
                        .map(|(_, start, _)| *start)
                        .unwrap_or(window_start_seconds);
                    let appended_end = appended_tokens
                        .last()
                        .map(|(_, _, end)| *end)
                        .unwrap_or(window_end_seconds)
                        .max(appended_start + 0.01);

                    transcript.segments.push(MeetingTranscriptSegment {
                        start: appended_start,
                        end: appended_end,
                        text: appended_text.clone(),
                        speaker_id: None,
                    });
                    transcript.text = if transcript.text.trim().is_empty() {
                        appended_text
                    } else {
                        format!("{} {}", transcript.text.trim_end(), appended_text)
                    };

                    if flush_unstable {
                        previous_uncommitted_token_spans.clear();
                    } else {
                        *previous_uncommitted_token_spans =
                            candidate_token_spans[commit_count..].to_vec();
                    }

                    Some(MeetingLiveTranscriptUpdate {
                        meeting_id,
                        transcript: transcript.clone(),
                    })
                }
            }
        }
    };

    if let Some(payload) = payload {
        let _ = app_handle.emit("meeting-live-transcript", payload);
    }
}

fn tokenize_live_segments(segments: &[MeetingTranscriptSegment]) -> Vec<(String, f32, f32)> {
    let mut tokens = Vec::new();
    for segment in segments {
        let segment_tokens = segment.text.split_whitespace().collect::<Vec<_>>();
        if segment_tokens.is_empty() {
            continue;
        }

        let start = segment.start.max(0.0);
        let end = segment.end.max(start + 0.01);
        let token_duration = (end - start) / segment_tokens.len() as f32;

        for (index, token) in segment_tokens.iter().enumerate() {
            let token_start = start + token_duration * index as f32;
            let token_end = if index + 1 == segment_tokens.len() {
                end
            } else {
                (token_start + token_duration).min(end)
            };
            tokens.push((
                token.to_string(),
                token_start,
                token_end.max(token_start + 0.001),
            ));
        }
    }
    tokens
}

fn count_live_token_overlap(existing: &[String], incoming: &[String]) -> usize {
    if existing.is_empty() || incoming.is_empty() {
        return 0;
    }

    let max_overlap = existing.len().min(incoming.len());
    for candidate in (1..=max_overlap).rev() {
        let existing_start = existing.len() - candidate;
        let mut match_count = 0usize;
        for index in 0..candidate {
            if live_tokens_match(&existing[existing_start + index], &incoming[index]) {
                match_count += 1;
            }
        }

        let ratio = match_count as f32 / candidate as f32;
        let min_ratio = if candidate >= 10 {
            0.82
        } else if candidate >= 6 {
            0.85
        } else if candidate >= 3 {
            0.9
        } else {
            1.0
        };
        if ratio >= min_ratio {
            return candidate;
        }
    }
    0
}

fn count_live_prefix_agreement(
    previous: &[(String, f32, f32)],
    incoming: &[(String, f32, f32)],
) -> usize {
    let max_agreement = previous.len().min(incoming.len());
    let mut agreement = 0usize;

    for index in 0..max_agreement {
        if live_tokens_match(&previous[index].0, &incoming[index].0) {
            agreement += 1;
        } else {
            break;
        }
    }

    agreement
}

fn live_tokens_match(left: &str, right: &str) -> bool {
    let normalized_left = normalize_live_overlap_token(left);
    let normalized_right = normalize_live_overlap_token(right);

    if normalized_left.is_empty() || normalized_right.is_empty() {
        left.eq_ignore_ascii_case(right)
    } else if normalized_left == normalized_right {
        true
    } else {
        bounded_levenshtein(
            &normalized_left,
            &normalized_right,
            live_token_max_distance(normalized_left.len().max(normalized_right.len())),
        )
        .is_some()
    }
}

fn normalize_live_overlap_token(token: &str) -> String {
    token
        .chars()
        .filter(|ch| ch.is_alphanumeric() || *ch == '\'' || *ch == '’')
        .collect::<String>()
        .to_lowercase()
}

fn live_token_max_distance(length: usize) -> usize {
    if length <= 4 {
        1
    } else if length <= 8 {
        2
    } else {
        3
    }
}

fn bounded_levenshtein(left: &str, right: &str, max_distance: usize) -> Option<usize> {
    let left_len = left.chars().count();
    let right_len = right.chars().count();
    if left_len.abs_diff(right_len) > max_distance {
        return None;
    }

    let left_chars = left.chars().collect::<Vec<_>>();
    let right_chars = right.chars().collect::<Vec<_>>();

    let mut previous = (0..=right_chars.len()).collect::<Vec<_>>();
    let mut current = vec![0usize; right_chars.len() + 1];

    for (i, left_char) in left_chars.iter().enumerate() {
        current[0] = i + 1;
        let mut row_min = current[0];

        for (j, right_char) in right_chars.iter().enumerate() {
            let substitution_cost = if left_char == right_char { 0 } else { 1 };
            let deletion = previous[j + 1] + 1;
            let insertion = current[j] + 1;
            let substitution = previous[j] + substitution_cost;
            let value = deletion.min(insertion).min(substitution);
            current[j + 1] = value;
            if value < row_min {
                row_min = value;
            }
        }

        if row_min > max_distance {
            return None;
        }

        std::mem::swap(&mut previous, &mut current);
    }

    let distance = previous[right_chars.len()];
    if distance <= max_distance {
        Some(distance)
    } else {
        None
    }
}

fn transcribe_live_window(
    transcription_manager: &Arc<TranscriptionManager>,
    samples: Vec<f32>,
) -> Result<transcribe_rs::TranscriptionResult, String> {
    match transcription_manager.transcribe_live_with_segments(samples.clone()) {
        Ok(result) => Ok(result),
        Err(initial_err) => {
            transcription_manager.initiate_model_load();
            transcription_manager
                .transcribe_live_with_segments(samples)
                .map_err(|retry_err| format!("{} (retry failed: {})", initial_err, retry_err))
        }
    }
}

fn chunk_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum = samples.iter().map(|value| value * value).sum::<f32>();
    (sum / samples.len() as f32).sqrt()
}

fn emit_screen_recording_permission_notice(app_handle: &AppHandle) {
    let payload = MeetingPermissionNotice {
        code: "screen_recording_required".to_string(),
        message: "Screen Recording permission is required for system audio. \
The meeting started with microphone only. Allow Screen Recording in System Settings to include system audio."
            .to_string(),
    };
    let _ = app_handle.emit("meeting-permission-notice", payload);
}

struct InflightSetGuard {
    meeting_id: i64,
    registry: Arc<Mutex<HashSet<i64>>>,
}

impl InflightSetGuard {
    fn new(meeting_id: i64, registry: Arc<Mutex<HashSet<i64>>>) -> Self {
        Self {
            meeting_id,
            registry,
        }
    }
}

impl Drop for InflightSetGuard {
    fn drop(&mut self) {
        if let Ok(mut inflight) = self.registry.lock() {
            inflight.remove(&self.meeting_id);
        }
    }
}

struct InflightMapGuard {
    meeting_id: i64,
    registry: Arc<Mutex<HashMap<i64, i64>>>,
}

impl InflightMapGuard {
    fn new(meeting_id: i64, registry: Arc<Mutex<HashMap<i64, i64>>>) -> Self {
        Self {
            meeting_id,
            registry,
        }
    }
}

impl Drop for InflightMapGuard {
    fn drop(&mut self) {
        if let Ok(mut inflight) = self.registry.lock() {
            inflight.remove(&self.meeting_id);
        }
    }
}

pub struct MeetingsManager {
    app_handle: AppHandle,
    db_path: PathBuf,
    meetings_dir: PathBuf,
    tmp_dir: PathBuf,
    active_recording: Arc<Mutex<Option<MeetingRecording>>>,
    background_watchdog_started: Arc<AtomicBool>,
    background_pipeline_inflight: Arc<Mutex<HashMap<i64, i64>>>,
    diarization_inflight: Arc<Mutex<HashSet<i64>>>,
}

impl MeetingsManager {
    pub fn new(app_handle: &AppHandle) -> Self {
        let app_data_dir = match app_handle.path().app_data_dir() {
            Ok(dir) => dir,
            Err(err) => {
                error!(
                    "Failed to resolve app data dir for meetings: {}. Falling back to temp directory.",
                    err
                );
                std::env::temp_dir().join("breezetype")
            }
        };
        let meetings_dir = app_data_dir.join("meetings");
        let tmp_dir = meetings_dir.join("tmp");
        let db_path = app_data_dir.join("meetings.db");

        if let Err(err) = fs::create_dir_all(&meetings_dir) {
            error!(
                "Failed to create meetings directory '{}': {}",
                meetings_dir.display(),
                err
            );
        }
        if let Err(err) = fs::create_dir_all(&tmp_dir) {
            error!(
                "Failed to create meetings tmp directory '{}': {}",
                tmp_dir.display(),
                err
            );
        }

        let manager = Self {
            app_handle: app_handle.clone(),
            db_path,
            meetings_dir,
            tmp_dir,
            active_recording: Arc::new(Mutex::new(None)),
            background_watchdog_started: Arc::new(AtomicBool::new(false)),
            background_pipeline_inflight: Arc::new(Mutex::new(HashMap::new())),
            diarization_inflight: Arc::new(Mutex::new(HashSet::new())),
        };

        if let Err(err) = manager.init_database() {
            error!("Failed to initialize meetings database: {}", err);
        }

        manager.start_background_processing_watchdog();

        manager
    }

    fn init_database(&self) -> Result<()> {
        let mut conn = Connection::open(&self.db_path)?;
        let migrations = Migrations::new(MEETINGS_MIGRATIONS.to_vec());
        #[cfg(debug_assertions)]
        migrations.validate().expect("Invalid meetings migrations");

        // Guard against older builds crashing if the DB has been migrated by a newer build.
        // `rusqlite_migration` may panic/abort when user_version > latest migration.
        let version_before: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let latest_supported_version: i32 = MEETINGS_MIGRATIONS.len() as i32;
        if version_before > latest_supported_version {
            warn!(
                "Meetings DB user_version ({}) is newer than this build supports ({}). \
Skipping migrations to avoid a crash; consider updating BreezeType to a newer build.",
                version_before, latest_supported_version
            );
        } else {
            migrations.to_latest(&mut conn)?;
        }

        if let Err(err) = self.purge_expired_deleted_meetings_with_connection(&mut conn) {
            warn!("Failed to purge expired deleted meetings: {}", err);
        }

        Ok(())
    }

    fn start_background_processing_watchdog(&self) {
        if self
            .background_watchdog_started
            .swap(true, Ordering::SeqCst)
        {
            return;
        }

        let app_handle = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let manager = loop {
                if let Some(state) = app_handle.try_state::<Arc<MeetingsManager>>() {
                    break state.inner().clone();
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            };
            if let Err(err) = manager.scan_and_enqueue_background_processing().await {
                warn!(
                    "Initial meetings background processing scan failed: {}",
                    err
                );
            }

            let mut ticker = tokio::time::interval(Duration::from_secs(
                MEETING_BACKGROUND_SCAN_INTERVAL_SECONDS,
            ));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(state) = app_handle.try_state::<Arc<MeetingsManager>>() else {
                    continue;
                };
                let manager = state.inner().clone();
                if let Err(err) = manager.scan_and_enqueue_background_processing().await {
                    warn!("Meetings background processing scan failed: {}", err);
                }
            }
        });
    }

    async fn scan_and_enqueue_background_processing(&self) -> Result<(), String> {
        let meeting_ids = self.list_meetings_for_background_scan()?;
        let mut started_count = 0usize;
        for meeting_id in meeting_ids {
            if started_count >= MEETING_BACKGROUND_MAX_STARTS_PER_SCAN {
                break;
            }
            let requires = match self.meeting_requires_background_processing(meeting_id) {
                Ok(value) => value,
                Err(err) => {
                    warn!(
                        "Failed to evaluate background processing need for meeting {}: {}",
                        meeting_id, err
                    );
                    continue;
                }
            };
            if !requires {
                continue;
            }
            if self.enqueue_background_pipeline_for_meeting(meeting_id) {
                started_count += 1;
            }
        }
        Ok(())
    }

    fn list_meetings_for_background_scan(&self) -> Result<Vec<i64>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id
                 FROM meetings
                 WHERE ended_at > 0
                   AND deleted_at IS NULL
                   AND is_visible = 1
                 ORDER BY ended_at DESC
                 LIMIT 256",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        for row in rows {
            if let Ok(id) = row {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    fn meeting_requires_background_processing(&self, meeting_id: i64) -> Result<bool, String> {
        let Some(transcript) = self.fetch_meeting_transcript(meeting_id)? else {
            return Ok(true);
        };

        if transcript.segments.is_empty() {
            return Ok(false);
        }

        if self.has_persisted_diarization_output(meeting_id)? {
            return Ok(!transcript_has_any_speaker_assignments(&transcript));
        }

        let now = Utc::now().timestamp();
        if let Some(status) = self.fetch_meeting_diarization_status(meeting_id)? {
            if status.status == DIARIZATION_STATUS_COMPLETED {
                return Ok(!transcript_has_any_speaker_assignments(&transcript));
            }
            if status.status == DIARIZATION_STATUS_RUNNING
                && !is_stale_running_diarization_status(&status, now)
            {
                return Ok(false);
            }
        }

        Ok(true)
    }

    fn enqueue_background_pipeline_for_meeting(&self, meeting_id: i64) -> bool {
        let now = Utc::now().timestamp();
        {
            let mut inflight = match self.background_pipeline_inflight.lock() {
                Ok(value) => value,
                Err(err) => {
                    warn!("Background pipeline lock poisoned: {}", err);
                    return false;
                }
            };
            if let Some(started_at) = inflight.get(&meeting_id).copied() {
                let age_seconds = now.saturating_sub(started_at);
                if age_seconds <= MEETING_BACKGROUND_PIPELINE_STALE_SECONDS {
                    return false;
                }
                warn!(
                    "Background meeting processing appears stuck for meeting {} ({}s); restarting.",
                    meeting_id, age_seconds
                );
            }
            inflight.insert(meeting_id, now);
        }

        let app_handle = self.app_handle.clone();
        let inflight_registry = self.background_pipeline_inflight.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = InflightMapGuard::new(meeting_id, inflight_registry);
            let manager = {
                let state = app_handle.state::<Arc<MeetingsManager>>();
                state.inner().clone()
            };
            if let Err(err) = manager
                .run_background_pipeline_for_meeting(meeting_id)
                .await
            {
                warn!(
                    "Background meeting processing failed for {}: {}",
                    meeting_id, err
                );
            }
        });
        true
    }

    async fn run_background_pipeline_for_meeting(&self, meeting_id: i64) -> Result<(), String> {
        if self.fetch_meeting_transcript(meeting_id)?.is_none() {
            self.precompute_meeting_transcript(meeting_id).await?;
            return Ok(());
        }

        if self.meeting_requires_background_processing(meeting_id)? {
            let _ = self.run_meeting_diarization(meeting_id).await?;
        }

        Ok(())
    }

    fn try_mark_diarization_inflight(&self, meeting_id: i64) -> bool {
        let mut inflight = match self.diarization_inflight.lock() {
            Ok(value) => value,
            Err(err) => {
                warn!("Diarization inflight lock poisoned: {}", err);
                return false;
            }
        };
        inflight.insert(meeting_id)
    }

    fn get_connection(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path)?;
        conn.busy_timeout(Duration::from_secs(MEETING_DB_BUSY_TIMEOUT_SECONDS))?;
        Ok(conn)
    }

    fn touch_meeting_updated_at_with_connection(
        &self,
        conn: &Connection,
        meeting_id: i64,
    ) -> Result<(), String> {
        let now = Utc::now().timestamp();
        conn.execute(
            "UPDATE meetings SET updated_at = ?1 WHERE id = ?2",
            params![now, meeting_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn touch_meeting_updated_at(&self, meeting_id: i64) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        self.touch_meeting_updated_at_with_connection(&conn, meeting_id)
    }

    pub fn is_recording(&self) -> bool {
        self.active_recording.lock().unwrap().is_some()
    }

    pub fn start_recording(
        &self,
        name: Option<String>,
        include_system_audio: bool,
    ) -> Result<ActiveMeetingInfo, String> {
        let mut active = self.active_recording.lock().unwrap();
        if active.is_some() {
            return Err("Meeting recording already in progress".to_string());
        }

        let started_at = Utc::now().timestamp();
        let file_name = format!("meeting-{}.mp3", started_at);
        let trimmed_name = name.as_ref().map(|value| value.trim().to_string());
        let trimmed_name = trimmed_name.filter(|value| !value.is_empty());
        let initial_name = trimmed_name
            .clone()
            .unwrap_or_else(|| default_meeting_name(started_at));

        let meeting_id = match self.insert_meeting(
            &initial_name,
            started_at,
            0,
            0.0,
            file_name.clone(),
            include_system_audio,
        ) {
            Ok(id) => id,
            Err(err) => return Err(err),
        };

        let live_transcript = LiveTranscriptRecorder::start(
            self.app_handle.clone(),
            meeting_id,
            include_system_audio,
        );
        let live_chunk_tx = live_transcript.chunk_sender();

        let mic_path = self.tmp_dir.join(format!("mic-{}.wav", started_at));
        let mic = match MicRecording::start(&self.app_handle, mic_path, Some(live_chunk_tx.clone()))
        {
            Ok(mic) => mic,
            Err(err) => {
                live_transcript.stop();
                let _ = self.delete_meeting_record(meeting_id);
                return Err(err);
            }
        };

        let mut effective_include_system_audio = include_system_audio;
        let system = if include_system_audio {
            match start_system_audio_recording(
                &self.app_handle,
                self.tmp_dir.join(format!("system-{}.wav", started_at)),
                Some(live_chunk_tx),
            ) {
                Ok(system) => Some(system),
                Err(err) => {
                    warn!(
                        "System audio capture unavailable, continuing with microphone only: {}",
                        err
                    );
                    effective_include_system_audio = false;

                    if is_screen_capture_permission_error(&err) {
                        open_screen_recording_settings();
                        emit_screen_recording_permission_notice(&self.app_handle);
                    }

                    None
                }
            }
        } else {
            None
        };

        *active = Some(MeetingRecording {
            meeting_id,
            started_at,
            initial_name: initial_name.clone(),
            file_name: file_name.clone(),
            include_system_audio: effective_include_system_audio,
            mic,
            system,
            live_transcript,
        });

        drop(active);
        let tray_state = crate::tray::get_tray_state(&self.app_handle);
        crate::tray::update_tray_menu(&self.app_handle, &tray_state, None);

        let active_info = ActiveMeetingInfo {
            id: meeting_id,
            started_at,
            name: initial_name,
        };
        let _ = self
            .app_handle
            .emit("meeting-recording-started", active_info.clone());

        Ok(active_info)
    }

    pub async fn stop_recording(
        &self,
        name_override: Option<String>,
    ) -> Result<MeetingEntry, String> {
        let stop_started = Instant::now();
        let recording = {
            let mut active = self.active_recording.lock().unwrap();
            active
                .take()
                .ok_or_else(|| "No meeting recording in progress".to_string())?
        };

        let MeetingRecording {
            meeting_id,
            started_at,
            initial_name,
            file_name,
            include_system_audio,
            mic,
            system,
            live_transcript,
        } = recording;

        let tray_state = crate::tray::get_tray_state(&self.app_handle);
        crate::tray::update_tray_menu(&self.app_handle, &tray_state, None);

        let expected_mic_path = self.tmp_dir.join(format!("mic-{}.wav", started_at));
        let expected_system_path = self.tmp_dir.join(format!("system-{}.wav", started_at));

        let mic_output = match mic.stop() {
            Ok(output) => Some(output),
            Err(err) => {
                warn!(
                    "Failed to stop microphone recording for meeting {}: {}. Attempting recovery from temp audio.",
                    meeting_id, err
                );
                None
            }
        };
        let system_output = match system {
            Some(system) => match system.stop() {
                Ok(output) => Some(output),
                Err(err) => {
                    warn!(
                        "Failed to stop system recording for meeting {}: {}. Falling back to microphone-only finalize.",
                        meeting_id, err
                    );
                    None
                }
            },
            None => None,
        };
        live_transcript.stop();

        let ended_at = Utc::now().timestamp();

        let output_path = self.meetings_dir.join(&file_name);
        let resolved_mic_path = mic_output
            .as_ref()
            .map(|output| output.path.clone())
            .unwrap_or_else(|| expected_mic_path.clone());
        let resolved_system_path = if include_system_audio {
            system_output
                .as_ref()
                .map(|output| output.path.clone())
                .or_else(|| {
                    if expected_system_path.exists() {
                        Some(expected_system_path.clone())
                    } else {
                        None
                    }
                })
        } else {
            None
        };

        let override_name = name_override
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let mut name = override_name
            .clone()
            .unwrap_or_else(|| initial_name.clone());
        if name.trim().is_empty() {
            name = default_meeting_name(started_at);
        }
        let mut duration_seconds = (ended_at - started_at).max(1) as f64;
        if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
            duration_seconds = 1.0;
        }

        self.update_meeting_recording(meeting_id, &name, ended_at, duration_seconds, &file_name)?;
        let sync_id = self.ensure_meeting_sync_id(meeting_id)?;

        let entry = MeetingEntry {
            id: meeting_id,
            sync_id,
            name,
            started_at,
            ended_at,
            duration_seconds,
            file_name: file_name.clone(),
            include_system_audio,
            tags: Vec::new(),
        };
        let _ = self
            .app_handle
            .emit("meeting-recording-stopped", entry.clone());
        let _ = self.app_handle.emit("meetings-updated", ());

        self.spawn_stop_finalize(StopFinalizeContext {
            meeting_id,
            started_at,
            ended_at,
            initial_name,
            file_name: file_name.clone(),
            output_path,
            resolved_mic_path,
            resolved_system_path,
            name_override: override_name,
        });
        info!(
            "Meeting {} stop acknowledged in {}ms; finalization continues in background",
            meeting_id,
            stop_started.elapsed().as_millis()
        );

        Ok(entry)
    }

    fn spawn_stop_finalize(&self, context: StopFinalizeContext) {
        let app_handle = self.app_handle.clone();
        let meeting_id = context.meeting_id;
        tauri::async_runtime::spawn(async move {
            let manager = {
                let state = app_handle.state::<Arc<MeetingsManager>>();
                state.inner().clone()
            };
            if let Err(err) = manager.finalize_stopped_recording(context).await {
                warn!("Meeting {} finalization failed: {}", meeting_id, err);
            }
        });
    }

    async fn finalize_stopped_recording(&self, context: StopFinalizeContext) -> Result<(), String> {
        let finalize_started = Instant::now();
        let StopFinalizeContext {
            meeting_id,
            started_at,
            ended_at,
            initial_name,
            file_name,
            output_path,
            resolved_mic_path,
            resolved_system_path,
            name_override,
        } = context;

        let mut finalize_warnings = Vec::new();
        let mut mixing_result: Option<MixResult> = None;

        if resolved_mic_path.exists() {
            let output_path_for_mix = output_path.clone();
            let mic_path_for_mix = resolved_mic_path.clone();
            let system_path_for_mix = resolved_system_path.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                mix_and_encode_meeting_from_paths(
                    mic_path_for_mix,
                    system_path_for_mix,
                    output_path_for_mix,
                )
            })
            .await
            {
                Ok(Ok(result)) => {
                    mixing_result = Some(result);
                }
                Ok(Err(err)) => {
                    finalize_warnings.push(format!("primary mix failed: {err}"));
                }
                Err(err) => {
                    finalize_warnings.push(format!("failed to join primary mix task: {err}"));
                }
            }

            if mixing_result.is_none() && resolved_system_path.is_some() {
                let output_path_for_mix = output_path.clone();
                let mic_path_for_mix = resolved_mic_path.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    mix_and_encode_meeting_from_paths(mic_path_for_mix, None, output_path_for_mix)
                })
                .await
                {
                    Ok(Ok(result)) => {
                        mixing_result = Some(result);
                        finalize_warnings
                            .push("recovered by encoding microphone audio only".to_string());
                    }
                    Ok(Err(err)) => {
                        finalize_warnings.push(format!("microphone-only fallback failed: {err}"));
                    }
                    Err(err) => {
                        finalize_warnings.push(format!(
                            "failed to join microphone-only fallback task: {err}"
                        ));
                    }
                }
            }
        } else {
            finalize_warnings.push(format!(
                "microphone temp audio missing at {}",
                resolved_mic_path.display()
            ));
        }

        if output_path.exists() {
            if let Some(system_path) = resolved_system_path.as_ref() {
                let _ = fs::remove_file(system_path);
            }
        }

        let mut duration_seconds = mixing_result
            .as_ref()
            .map(|result| result.duration_seconds)
            .or_else(|| estimate_wav_duration_seconds(&resolved_mic_path))
            .or_else(|| {
                resolved_system_path
                    .as_ref()
                    .and_then(|path| estimate_wav_duration_seconds(path))
            })
            .unwrap_or_else(|| (ended_at - started_at).max(1) as f64);
        if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
            duration_seconds = (ended_at - started_at).max(1) as f64;
        }

        self.update_meeting_finalize_metadata(meeting_id, ended_at, duration_seconds, &file_name)?;
        let _ = self.app_handle.emit("meetings-updated", ());

        let default_name = default_meeting_name(started_at);
        let should_auto_name = name_override.is_none() && initial_name == default_name;
        if should_auto_name {
            if let Some(mixed) = mixing_result.as_ref() {
                if let Some(auto_name) = self
                    .generate_meeting_name(&mixed.snippet, MEETING_TARGET_SAMPLE_RATE)
                    .await
                {
                    match self.update_meeting_name_if_current(meeting_id, &initial_name, &auto_name)
                    {
                        Ok(true) => {}
                        Ok(false) => {
                            info!(
                                "Skipped meeting {} auto-rename because name changed after stop",
                                meeting_id
                            );
                        }
                        Err(err) => {
                            finalize_warnings.push(format!("failed to apply auto-name: {err}"));
                        }
                    }
                }
            }
        }

        if !finalize_warnings.is_empty() {
            warn!(
                "Meeting {} finalized with warnings: {}",
                meeting_id,
                finalize_warnings.join(" | ")
            );
        }

        if output_path.exists() {
            self.start_background_transcript_precompute(meeting_id);
        } else {
            warn!(
                "Meeting {} finalize completed without audio file at {}",
                meeting_id,
                output_path.display()
            );
        }

        info!(
            "Meeting {} finalize finished in {}ms",
            meeting_id,
            finalize_started.elapsed().as_millis()
        );
        Ok(())
    }

    fn start_background_transcript_precompute(&self, meeting_id: i64) {
        let _ = self.enqueue_background_pipeline_for_meeting(meeting_id);
    }

    async fn precompute_meeting_transcript(&self, meeting_id: i64) -> Result<(), String> {
        if let Some(transcript) = self.fetch_meeting_transcript(meeting_id)? {
            if transcript_has_spoken_segments(&transcript) {
                self.start_background_diarization(meeting_id, false);
            }
            return Ok(());
        }

        let transcript = self.transcribe_meeting_audio_file(meeting_id).await?;
        let _stored = self.store_meeting_transcript_if_missing(meeting_id, &transcript)?;
        if transcript_has_spoken_segments(&transcript) {
            self.start_background_diarization(meeting_id, false);
        }
        Ok(())
    }

    pub async fn run_meeting_diarization(
        &self,
        meeting_id: i64,
    ) -> Result<MeetingDiarizationStatus, String> {
        self.ensure_meeting_is_ready_for_diarization(meeting_id)?;
        let estimate_seconds = self.estimate_meeting_diarization_seconds(meeting_id)?;
        let now = Utc::now().timestamp();
        if let Some(transcript) = self.fetch_meeting_transcript(meeting_id)? {
            if !transcript_has_spoken_segments(&transcript) {
                return self.store_meeting_diarization_status(
                    meeting_id,
                    DIARIZATION_STATUS_IDLE,
                    Some(estimate_seconds),
                    None,
                    None,
                    None,
                );
            }
        }
        let existing_status = self.fetch_meeting_diarization_status(meeting_id)?;
        if let Some(existing) = existing_status.as_ref() {
            if existing.status == DIARIZATION_STATUS_COMPLETED {
                let has_persisted_output = self.has_persisted_diarization_output(meeting_id)?;
                let has_transcript_speakers = self
                    .fetch_meeting_transcript(meeting_id)?
                    .as_ref()
                    .is_some_and(transcript_has_any_speaker_assignments);
                if has_persisted_output || has_transcript_speakers {
                    if let Err(err) = self
                        .repair_transcript_speakers_from_persisted_diarization_if_needed(meeting_id)
                    {
                        warn!(
                            "Failed to repair transcript speakers from persisted diarization for meeting {}: {}",
                            meeting_id, err
                        );
                    }
                    return Ok(existing.clone());
                }
                let _ = self.store_meeting_diarization_status(
                    meeting_id,
                    DIARIZATION_STATUS_FAILED,
                    Some(estimate_seconds),
                    Some(
                        "Previous diarization marked completed without usable output; restarting.",
                    ),
                    existing.started_at,
                    Some(now),
                );
            }
            if existing.status == DIARIZATION_STATUS_RUNNING {
                if !is_stale_running_diarization_status(existing, now) {
                    return Ok(existing.clone());
                }
                if let Err(err) = self.store_meeting_diarization_status(
                    meeting_id,
                    DIARIZATION_STATUS_FAILED,
                    Some(estimate_seconds),
                    Some("Previous diarization run timed out; restarting."),
                    existing.started_at,
                    Some(now),
                ) {
                    warn!(
                        "Failed to mark stale diarization status as failed for meeting {}: {}",
                        meeting_id, err
                    );
                }
            }
        }

        if self.has_persisted_diarization_output(meeting_id)? {
            if let Err(err) =
                self.repair_transcript_speakers_from_persisted_diarization_if_needed(meeting_id)
            {
                warn!(
                    "Failed to repair transcript speakers from persisted diarization for meeting {}: {}",
                    meeting_id, err
                );
            }
            let completed = self.store_meeting_diarization_status(
                meeting_id,
                DIARIZATION_STATUS_COMPLETED,
                Some(estimate_seconds),
                None,
                existing_status
                    .as_ref()
                    .and_then(|status| status.started_at),
                Some(now),
            )?;
            return Ok(completed);
        }

        let started_at = now;
        let running = self.store_meeting_diarization_status(
            meeting_id,
            DIARIZATION_STATUS_RUNNING,
            Some(estimate_seconds),
            None,
            Some(started_at),
            None,
        )?;
        self.start_background_diarization(meeting_id, true);
        Ok(running)
    }

    pub fn get_meeting_diarization_status(
        &self,
        meeting_id: i64,
    ) -> Result<MeetingDiarizationStatus, String> {
        self.ensure_meeting_is_ready_for_diarization(meeting_id)?;
        let estimate_seconds = self.estimate_meeting_diarization_seconds(meeting_id)?;
        let now = Utc::now().timestamp();
        if let Some(transcript) = self.fetch_meeting_transcript(meeting_id)? {
            if !transcript_has_spoken_segments(&transcript) {
                return self.store_meeting_diarization_status(
                    meeting_id,
                    DIARIZATION_STATUS_IDLE,
                    Some(estimate_seconds),
                    None,
                    None,
                    None,
                );
            }
        }
        if let Some(status) = self.fetch_meeting_diarization_status(meeting_id)? {
            if status.status == DIARIZATION_STATUS_RUNNING
                && is_stale_running_diarization_status(&status, now)
            {
                let failed = self.store_meeting_diarization_status(
                    meeting_id,
                    DIARIZATION_STATUS_FAILED,
                    Some(estimate_seconds),
                    Some("Previous diarization run timed out."),
                    status.started_at,
                    Some(now),
                )?;
                return Ok(failed);
            }
            if status.status == DIARIZATION_STATUS_COMPLETED {
                let has_persisted_output = self.has_persisted_diarization_output(meeting_id)?;
                let has_transcript_speakers = self
                    .fetch_meeting_transcript(meeting_id)?
                    .as_ref()
                    .is_some_and(transcript_has_any_speaker_assignments);
                if has_persisted_output || has_transcript_speakers {
                    if let Err(err) = self
                        .repair_transcript_speakers_from_persisted_diarization_if_needed(meeting_id)
                    {
                        warn!(
                            "Failed to repair transcript speakers from persisted diarization for meeting {}: {}",
                            meeting_id, err
                        );
                    }
                    return Ok(status);
                }
                let failed = self.store_meeting_diarization_status(
                    meeting_id,
                    DIARIZATION_STATUS_FAILED,
                    Some(estimate_seconds),
                    Some("Diarization marked completed without usable output."),
                    status.started_at,
                    Some(now),
                )?;
                return Ok(failed);
            }
            return Ok(status);
        }

        if self.has_persisted_diarization_output(meeting_id)? {
            if let Err(err) =
                self.repair_transcript_speakers_from_persisted_diarization_if_needed(meeting_id)
            {
                warn!(
                    "Failed to repair transcript speakers from persisted diarization for meeting {}: {}",
                    meeting_id, err
                );
            }
            let completed = self.store_meeting_diarization_status(
                meeting_id,
                DIARIZATION_STATUS_COMPLETED,
                Some(estimate_seconds),
                None,
                None,
                Some(now),
            )?;
            return Ok(completed);
        }

        Ok(MeetingDiarizationStatus {
            status: DIARIZATION_STATUS_IDLE.to_string(),
            estimated_seconds: Some(estimate_seconds),
            started_at: None,
            completed_at: None,
            error_message: None,
        })
    }

    pub fn get_meeting_speaker_mappings(
        &self,
        meeting_id: i64,
    ) -> Result<Vec<MeetingSpeakerMapping>, String> {
        self.ensure_meeting_is_ready_for_diarization(meeting_id)?;
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        self.load_meeting_speaker_mappings_with_connection(&conn, meeting_id)
    }

    pub fn update_meeting_speaker_mapping(
        &self,
        meeting_id: i64,
        raw_speaker_id: String,
        display_name: String,
        color: Option<String>,
        participant_id: Option<i64>,
    ) -> Result<Vec<MeetingSpeakerMapping>, String> {
        self.ensure_meeting_is_ready_for_diarization(meeting_id)?;
        let raw = raw_speaker_id.trim();
        if raw.is_empty() {
            return Err("Speaker id cannot be empty".to_string());
        }
        let display = display_name.trim();
        if display.is_empty() {
            return Err("Speaker name cannot be empty".to_string());
        }
        let resolved_color = color
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "#0EA5E9".to_string());
        let now = Utc::now().timestamp();
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO meeting_speaker_mappings (
                meeting_id,
                raw_speaker_id,
                display_name,
                color,
                participant_id,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            ON CONFLICT(meeting_id, raw_speaker_id) DO UPDATE SET
                display_name = excluded.display_name,
                color = excluded.color,
                participant_id = excluded.participant_id,
                updated_at = excluded.updated_at",
            params![
                meeting_id,
                raw,
                display,
                resolved_color,
                participant_id,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        self.touch_meeting_updated_at_with_connection(&conn, meeting_id)?;
        self.load_meeting_speaker_mappings_with_connection(&conn, meeting_id)
    }

    fn start_background_diarization(&self, meeting_id: i64, allow_running_status: bool) {
        if !self.try_mark_diarization_inflight(meeting_id) {
            return;
        }

        let app_handle = self.app_handle.clone();
        let inflight_registry = self.diarization_inflight.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = InflightSetGuard::new(meeting_id, inflight_registry);
            let manager = {
                let state = app_handle.state::<Arc<MeetingsManager>>();
                state.inner().clone()
            };
            let now = Utc::now().timestamp();

            let existing_status = match manager.fetch_meeting_diarization_status(meeting_id) {
                Ok(value) => value,
                Err(err) => {
                    warn!(
                        "Failed to read diarization status for meeting {}: {}",
                        meeting_id, err
                    );
                    return;
                }
            };

            let estimate_seconds = match manager.estimate_meeting_diarization_seconds(meeting_id) {
                Ok(value) => value,
                Err(err) => {
                    warn!("Skipping diarization for meeting {}: {}", meeting_id, err);
                    return;
                }
            };

            let mut should_store_running = true;
            let mut running_started_at = now;
            if let Some(status) = existing_status.as_ref() {
                if status.status == DIARIZATION_STATUS_COMPLETED {
                    let has_persisted_output =
                        match manager.has_persisted_diarization_output(meeting_id) {
                            Ok(value) => value,
                            Err(err) => {
                                warn!(
                                "Failed to inspect persisted diarization output for meeting {}: {}",
                                meeting_id, err
                            );
                                return;
                            }
                        };
                    let has_transcript_speakers = match manager.fetch_meeting_transcript(meeting_id)
                    {
                        Ok(transcript) => transcript
                            .as_ref()
                            .is_some_and(transcript_has_any_speaker_assignments),
                        Err(err) => {
                            warn!(
                                "Failed to inspect transcript speakers for meeting {}: {}",
                                meeting_id, err
                            );
                            false
                        }
                    };
                    if has_persisted_output || has_transcript_speakers {
                        let _ = manager
                            .repair_transcript_speakers_from_persisted_diarization_if_needed(
                                meeting_id,
                            );
                        return;
                    }
                }
                if status.status == DIARIZATION_STATUS_RUNNING {
                    if !is_stale_running_diarization_status(status, now) {
                        if !allow_running_status {
                            return;
                        }
                        should_store_running = false;
                        running_started_at = status.started_at.unwrap_or(now);
                    } else {
                        let _ = manager.store_meeting_diarization_status(
                            meeting_id,
                            DIARIZATION_STATUS_FAILED,
                            Some(estimate_seconds),
                            Some("Previous diarization run timed out."),
                            status.started_at,
                            Some(now),
                        );
                    }
                }
            }

            match manager.has_persisted_diarization_output(meeting_id) {
                Ok(true) => {
                    let _ = manager.store_meeting_diarization_status(
                        meeting_id,
                        DIARIZATION_STATUS_COMPLETED,
                        Some(estimate_seconds),
                        None,
                        existing_status
                            .as_ref()
                            .and_then(|status| status.started_at),
                        Some(now),
                    );
                    return;
                }
                Ok(false) => {}
                Err(err) => {
                    warn!("Skipping diarization for meeting {}: {}", meeting_id, err);
                    return;
                }
            }

            if should_store_running {
                running_started_at = now;
                if let Err(err) = manager.store_meeting_diarization_status(
                    meeting_id,
                    DIARIZATION_STATUS_RUNNING,
                    Some(estimate_seconds),
                    None,
                    Some(running_started_at),
                    None,
                ) {
                    warn!(
                        "Failed to set diarization RUNNING state for meeting {}: {}",
                        meeting_id, err
                    );
                    return;
                }
            }

            match manager.perform_meeting_diarization(meeting_id).await {
                Ok(()) => {
                    let _ = manager.store_meeting_diarization_status(
                        meeting_id,
                        DIARIZATION_STATUS_COMPLETED,
                        Some(estimate_seconds),
                        None,
                        Some(running_started_at),
                        Some(Utc::now().timestamp()),
                    );
                }
                Err(err) => {
                    warn!("Meeting diarization failed for {}: {}", meeting_id, err);
                    let _ = manager.store_meeting_diarization_status(
                        meeting_id,
                        DIARIZATION_STATUS_FAILED,
                        Some(estimate_seconds),
                        Some(err.as_str()),
                        Some(running_started_at),
                        Some(Utc::now().timestamp()),
                    );
                }
            }
        });
    }

    async fn perform_meeting_diarization(&self, meeting_id: i64) -> Result<(), String> {
        self.ensure_meeting_is_ready_for_diarization(meeting_id)?;
        let mut transcript = self.get_meeting_transcript(meeting_id).await?;
        if !transcript_has_spoken_segments(&transcript) {
            return Ok(());
        }

        let audio_path = self.get_meeting_file_path_by_id(meeting_id)?;
        let app_handle = self.app_handle.clone();
        let tmp_dir = self.tmp_dir.clone();
        let diarization_segments = tauri::async_runtime::spawn_blocking(move || {
            run_senko_diarization_pipeline(&app_handle, &audio_path, &tmp_dir)
        })
        .await
        .map_err(|e| format!("Failed to join diarization task: {e}"))??;

        if diarization_segments.is_empty() {
            return Err("Diarization returned no segments".to_string());
        }

        align_transcript_segments_with_diarization(&mut transcript, &diarization_segments);
        self.store_meeting_transcript(meeting_id, &transcript)?;
        self.persist_meeting_diarization(meeting_id, &transcript, &diarization_segments)?;
        Ok(())
    }

    fn ensure_meeting_is_ready_for_diarization(&self, meeting_id: i64) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let row: Option<(i64, i64)> = conn
            .query_row(
                "SELECT id, ended_at
                 FROM meetings
                 WHERE id = ?1 AND deleted_at IS NULL AND is_visible = 1",
                params![meeting_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((_, ended_at)) = row else {
            return Err("Meeting not found".to_string());
        };
        if ended_at <= 0 {
            return Err("Meeting has not finished yet".to_string());
        }
        let audio_path = self.get_meeting_file_path_by_id(meeting_id)?;
        if !audio_path.exists() {
            return Err(MEETING_AUDIO_UNAVAILABLE_MESSAGE.to_string());
        }
        Ok(())
    }

    fn estimate_meeting_diarization_seconds(&self, meeting_id: i64) -> Result<i64, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let duration_seconds: f64 = conn
            .query_row(
                "SELECT duration_seconds FROM meetings WHERE id = ?1",
                params![meeting_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let estimate = (duration_seconds / 90.0).ceil() as i64;
        Ok(estimate.clamp(10, 300))
    }

    fn has_persisted_diarization_output(&self, meeting_id: i64) -> Result<bool, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let segment_count: i64 = conn
            .query_row(
                "SELECT COUNT(1)
                 FROM meeting_diarization_segments
                 WHERE meeting_id = ?1",
                params![meeting_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(segment_count > 0)
    }

    fn load_persisted_diarization_segments(
        &self,
        meeting_id: i64,
    ) -> Result<Vec<SenkoDiarizationSegment>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT start_seconds, end_seconds, raw_speaker_id
                 FROM meeting_diarization_segments
                 WHERE meeting_id = ?1
                 ORDER BY start_seconds ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![meeting_id], |row| {
                Ok(SenkoDiarizationSegment {
                    start: row.get(0)?,
                    end: row.get(1)?,
                    speaker: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut segments = Vec::new();
        for row in rows {
            if let Ok(segment) = row {
                segments.push(segment);
            }
        }
        Ok(segments)
    }

    fn repair_transcript_speakers_from_persisted_diarization_if_needed(
        &self,
        meeting_id: i64,
    ) -> Result<bool, String> {
        let Some(mut transcript) = self.fetch_meeting_transcript(meeting_id)? else {
            return Ok(false);
        };
        if transcript.segments.is_empty() {
            return Ok(false);
        }
        if transcript_has_any_speaker_assignments(&transcript) {
            return Ok(false);
        }

        let diarization_segments = self.load_persisted_diarization_segments(meeting_id)?;
        if diarization_segments.is_empty() {
            return Ok(false);
        }

        align_transcript_segments_with_diarization(&mut transcript, &diarization_segments);
        if !transcript_has_any_speaker_assignments(&transcript) {
            return Ok(false);
        }

        self.store_meeting_transcript(meeting_id, &transcript)?;
        self.persist_meeting_diarization(meeting_id, &transcript, &diarization_segments)?;
        Ok(true)
    }

    fn fetch_meeting_diarization_status(
        &self,
        meeting_id: i64,
    ) -> Result<Option<MeetingDiarizationStatus>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let row: Option<(
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<String>,
        )> = conn
            .query_row(
                "SELECT status, estimated_seconds, started_at, completed_at, error_message
                 FROM meeting_diarization_jobs
                 WHERE meeting_id = ?1",
                params![meeting_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        Ok(row.map(
            |(status, estimated_seconds, started_at, completed_at, error_message)| {
                MeetingDiarizationStatus {
                    status,
                    estimated_seconds,
                    started_at,
                    completed_at,
                    error_message,
                }
            },
        ))
    }

    fn store_meeting_diarization_status(
        &self,
        meeting_id: i64,
        status: &str,
        estimated_seconds: Option<i64>,
        error_message: Option<&str>,
        started_at: Option<i64>,
        completed_at: Option<i64>,
    ) -> Result<MeetingDiarizationStatus, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT INTO meeting_diarization_jobs (
                meeting_id,
                status,
                estimated_seconds,
                error_message,
                started_at,
                completed_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(meeting_id) DO UPDATE SET
                status = excluded.status,
                estimated_seconds = excluded.estimated_seconds,
                error_message = excluded.error_message,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                updated_at = excluded.updated_at",
            params![
                meeting_id,
                status,
                estimated_seconds,
                error_message,
                started_at,
                completed_at,
                now
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(MeetingDiarizationStatus {
            status: status.to_string(),
            estimated_seconds,
            started_at,
            completed_at,
            error_message: error_message.map(|value| value.to_string()),
        })
    }

    fn load_meeting_speaker_mappings_with_connection(
        &self,
        conn: &Connection,
        meeting_id: i64,
    ) -> Result<Vec<MeetingSpeakerMapping>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT raw_speaker_id, display_name, color, participant_id
                 FROM meeting_speaker_mappings
                 WHERE meeting_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![meeting_id], |row| {
                Ok(MeetingSpeakerMapping {
                    raw_speaker_id: row.get(0)?,
                    display_name: row.get(1)?,
                    color: row.get(2)?,
                    participant_id: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut mappings = Vec::new();
        for row in rows {
            if let Ok(mapping) = row {
                mappings.push(mapping);
            }
        }
        Ok(mappings)
    }

    fn persist_meeting_diarization(
        &self,
        meeting_id: i64,
        transcript: &MeetingTranscript,
        diarization_segments: &[SenkoDiarizationSegment],
    ) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM meeting_diarization_segments WHERE meeting_id = ?1",
            params![meeting_id],
        )
        .map_err(|e| e.to_string())?;
        for segment in diarization_segments {
            tx.execute(
                "INSERT INTO meeting_diarization_segments (
                    meeting_id,
                    start_seconds,
                    end_seconds,
                    raw_speaker_id
                ) VALUES (?1, ?2, ?3, ?4)",
                params![meeting_id, segment.start, segment.end, segment.speaker],
            )
            .map_err(|e| e.to_string())?;
        }

        let existing = self.load_meeting_speaker_mappings_with_connection(&tx, meeting_id)?;
        let existing_by_raw = existing
            .iter()
            .map(|mapping| (mapping.raw_speaker_id.clone(), mapping.clone()))
            .collect::<HashMap<_, _>>();
        let ordered_speakers = ordered_unique_speaker_ids(transcript);
        let ordered_set = ordered_speakers.iter().cloned().collect::<HashSet<_>>();

        for mapping in existing {
            if !ordered_set.contains(&mapping.raw_speaker_id) {
                tx.execute(
                    "DELETE FROM meeting_speaker_mappings
                     WHERE meeting_id = ?1 AND raw_speaker_id = ?2",
                    params![meeting_id, mapping.raw_speaker_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        let now = Utc::now().timestamp();
        for (index, raw_speaker_id) in ordered_speakers.iter().enumerate() {
            let default_name = format!("Unassigned Speaker {}", index + 1);
            let default_color = SPEAKER_COLOR_PALETTE[index % SPEAKER_COLOR_PALETTE.len()];
            let preserved = existing_by_raw.get(raw_speaker_id);
            let display_name = preserved
                .map(|mapping| mapping.display_name.trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or(default_name);
            let color = preserved
                .map(|mapping| mapping.color.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| default_color.to_string());
            let participant_id = preserved.and_then(|mapping| mapping.participant_id);
            tx.execute(
                "INSERT INTO meeting_speaker_mappings (
                    meeting_id,
                    raw_speaker_id,
                    display_name,
                    color,
                    participant_id,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                ON CONFLICT(meeting_id, raw_speaker_id) DO UPDATE SET
                    display_name = excluded.display_name,
                    color = excluded.color,
                    participant_id = excluded.participant_id,
                    updated_at = excluded.updated_at",
                params![
                    meeting_id,
                    raw_speaker_id,
                    display_name,
                    color,
                    participant_id,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        self.touch_meeting_updated_at_with_connection(&conn, meeting_id)?;
        Ok(())
    }

    fn insert_meeting(
        &self,
        name: &str,
        started_at: i64,
        ended_at: i64,
        duration_seconds: f64,
        file_name: String,
        include_system_audio: bool,
    ) -> Result<i64, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let sync_id = Uuid::new_v4().to_string();
        let updated_at = Utc::now().timestamp();
        conn.execute(
            "INSERT INTO meetings (
                name,
                started_at,
                ended_at,
                duration_seconds,
                file_name,
                include_system_audio,
                sync_id,
                updated_at,
                is_visible
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)",
            params![
                name,
                started_at,
                ended_at,
                duration_seconds,
                file_name,
                include_system_audio,
                sync_id,
                updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    fn update_meeting_recording(
        &self,
        id: i64,
        name: &str,
        ended_at: i64,
        duration_seconds: f64,
        file_name: &str,
    ) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let updated_at = Utc::now().timestamp();
        conn.execute(
            "UPDATE meetings
             SET name = ?1, ended_at = ?2, duration_seconds = ?3, file_name = ?4, updated_at = ?5
             WHERE id = ?6",
            params![name, ended_at, duration_seconds, file_name, updated_at, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn update_meeting_finalize_metadata(
        &self,
        id: i64,
        ended_at: i64,
        duration_seconds: f64,
        file_name: &str,
    ) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let updated_at = Utc::now().timestamp();
        conn.execute(
            "UPDATE meetings
             SET ended_at = ?1, duration_seconds = ?2, file_name = ?3, updated_at = ?4
             WHERE id = ?5",
            params![ended_at, duration_seconds, file_name, updated_at, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn update_meeting_name_if_current(
        &self,
        id: i64,
        expected_name: &str,
        next_name: &str,
    ) -> Result<bool, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let updated_at = Utc::now().timestamp();
        let rows = conn
            .execute(
                "UPDATE meetings
                 SET name = ?1, updated_at = ?2
                 WHERE id = ?3 AND name = ?4",
                params![next_name, updated_at, id, expected_name],
            )
            .map_err(|e| e.to_string())?;
        Ok(rows > 0)
    }

    fn ensure_meeting_sync_id(&self, meeting_id: i64) -> Result<String, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT sync_id FROM meetings WHERE id = ?1",
                params![meeting_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some(sync_id) = existing {
            let trimmed = sync_id.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }

        let generated = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        conn.execute(
            "UPDATE meetings
             SET sync_id = ?1,
                 updated_at = CASE
                   WHEN updated_at IS NULL OR updated_at < ?2 THEN ?2
                   ELSE updated_at
                 END
             WHERE id = ?3",
            params![generated, now, meeting_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(generated)
    }

    fn delete_meeting_record(&self, id: i64) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn purge_expired_deleted_meetings_with_connection(
        &self,
        conn: &mut Connection,
    ) -> Result<(), String> {
        let cutoff = Utc::now().timestamp() - MEETING_SOFT_DELETE_RETENTION_SECONDS;
        let mut stmt = conn
            .prepare(
                "SELECT id, file_name
                 FROM meetings
                 WHERE deleted_at IS NOT NULL AND deleted_at <= ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![cutoff], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;

        let mut expired = Vec::new();
        for row in rows {
            if let Ok(entry) = row {
                expired.push(entry);
            }
        }
        drop(stmt);

        for (meeting_id, file_name) in expired {
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM meeting_tags WHERE meeting_id = ?1",
                params![meeting_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM meeting_notes WHERE meeting_id = ?1",
                params![meeting_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM meeting_transcripts WHERE meeting_id = ?1",
                params![meeting_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM meeting_diarization_segments WHERE meeting_id = ?1",
                params![meeting_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM meeting_speaker_mappings WHERE meeting_id = ?1",
                params![meeting_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM meeting_diarization_jobs WHERE meeting_id = ?1",
                params![meeting_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM meeting_participants WHERE meeting_id = ?1",
                params![meeting_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM meetings WHERE id = ?1", params![meeting_id])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;

            let path = self.meetings_dir.join(file_name);
            let _ = fs::remove_file(path);
        }

        Ok(())
    }

    fn purge_expired_deleted_meetings(&self) -> Result<(), String> {
        let mut conn = self.get_connection().map_err(|e| e.to_string())?;
        self.purge_expired_deleted_meetings_with_connection(&mut conn)
    }

    fn load_meeting_tags_by_deleted_state(
        &self,
        conn: &Connection,
        deleted: bool,
    ) -> Result<HashMap<i64, Vec<String>>, String> {
        let mut tags_by_meeting: HashMap<i64, Vec<String>> = HashMap::new();
        let deleted_predicate = if deleted {
            "(meetings.deleted_at IS NOT NULL OR meetings.is_visible = 0)"
        } else {
            "meetings.deleted_at IS NULL AND meetings.is_visible = 1"
        };
        let query = format!(
            "SELECT meeting_tags.meeting_id, tags.name
             FROM meeting_tags
             JOIN tags ON tags.id = meeting_tags.tag_id
             JOIN meetings ON meetings.id = meeting_tags.meeting_id
             WHERE {}
             ORDER BY tags.name COLLATE NOCASE ASC",
            deleted_predicate
        );
        let mut tag_stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
        let tag_rows = tag_stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in tag_rows {
            if let Ok((meeting_id, tag_name)) = row {
                tags_by_meeting
                    .entry(meeting_id)
                    .or_default()
                    .push(tag_name);
            }
        }
        Ok(tags_by_meeting)
    }

    fn load_tags_for_meeting(
        &self,
        conn: &Connection,
        meeting_id: i64,
    ) -> Result<Vec<String>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT tags.name
                 FROM meeting_tags
                 JOIN tags ON tags.id = meeting_tags.tag_id
                 WHERE meeting_tags.meeting_id = ?1
                 ORDER BY tags.name COLLATE NOCASE ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![meeting_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;

        let mut tags = Vec::new();
        for row in rows {
            if let Ok(tag) = row {
                tags.push(tag);
            }
        }
        Ok(tags)
    }

    pub fn get_meetings(&self) -> Result<Vec<MeetingEntry>, String> {
        self.purge_expired_deleted_meetings()?;
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut tags_by_meeting = self.load_meeting_tags_by_deleted_state(&conn, false)?;

        let mut stmt = conn
            .prepare(
                "SELECT id, sync_id, name, started_at, ended_at, duration_seconds, file_name, include_system_audio
                 FROM meetings
                 WHERE ended_at > 0 AND deleted_at IS NULL AND is_visible = 1
                 ORDER BY ended_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                Ok(MeetingEntry {
                    id,
                    sync_id: row.get(1)?,
                    name: row.get(2)?,
                    started_at: row.get(3)?,
                    ended_at: row.get(4)?,
                    duration_seconds: row.get(5)?,
                    file_name: row.get(6)?,
                    include_system_audio: row.get(7)?,
                    tags: tags_by_meeting.remove(&id).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            if let Ok(entry) = row {
                entries.push(entry);
            }
        }

        Ok(entries)
    }

    pub fn get_deleted_meetings(&self) -> Result<Vec<DeletedMeetingEntry>, String> {
        self.purge_expired_deleted_meetings()?;
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut tags_by_meeting = self.load_meeting_tags_by_deleted_state(&conn, true)?;

        let mut stmt = conn
            .prepare(
                "SELECT
                    id,
                    name,
                    started_at,
                    ended_at,
                    duration_seconds,
                    file_name,
                    include_system_audio,
                    deleted_at
                 FROM meetings
                 WHERE ended_at > 0 AND (deleted_at IS NOT NULL OR is_visible = 0)
                 ORDER BY deleted_at DESC, ended_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let deleted_at: i64 = row.get(7)?;
                Ok(DeletedMeetingEntry {
                    id,
                    name: row.get(1)?,
                    started_at: row.get(2)?,
                    ended_at: row.get(3)?,
                    duration_seconds: row.get(4)?,
                    file_name: row.get(5)?,
                    include_system_audio: row.get(6)?,
                    tags: tags_by_meeting.remove(&id).unwrap_or_default(),
                    deleted_at,
                    purge_at: deleted_meeting_purge_at(deleted_at),
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            if let Ok(entry) = row {
                entries.push(entry);
            }
        }

        Ok(entries)
    }

    pub fn get_meeting_audio_file_path(&self, file_name: &str) -> PathBuf {
        self.meetings_dir.join(file_name)
    }

    pub fn get_meeting_file_path_by_id(&self, meeting_id: i64) -> Result<PathBuf, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let file_name: String = conn
            .query_row(
                "SELECT file_name FROM meetings WHERE id = ?1",
                params![meeting_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(self.meetings_dir.join(file_name))
    }

    fn get_existing_meeting_file_path_by_id(&self, meeting_id: i64) -> Result<PathBuf, String> {
        let path = self.get_meeting_file_path_by_id(meeting_id)?;
        if path.exists() {
            return Ok(path);
        }
        Err(MEETING_AUDIO_UNAVAILABLE_MESSAGE.to_string())
    }

    pub fn get_meeting_entry(&self, meeting_id: i64) -> Result<MeetingEntry, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let row: Option<(i64, String, String, i64, i64, f64, String, bool)> = conn
            .query_row(
                "SELECT id, sync_id, name, started_at, ended_at, duration_seconds, file_name, include_system_audio
                 FROM meetings WHERE id = ?1 AND deleted_at IS NULL AND is_visible = 1",
                params![meeting_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some((
            id,
            sync_id,
            name,
            started_at,
            ended_at,
            duration_seconds,
            file_name,
            include_system_audio,
        )) = row
        else {
            return Err("Meeting not found".to_string());
        };

        let tags = self.load_tags_for_meeting(&conn, id)?;

        Ok(MeetingEntry {
            id,
            sync_id,
            name,
            started_at,
            ended_at,
            duration_seconds,
            file_name,
            include_system_audio,
            tags,
        })
    }

    pub fn get_meeting_transcript_if_available(
        &self,
        meeting_id: i64,
    ) -> Result<Option<MeetingTranscript>, String> {
        let existing = self.fetch_meeting_transcript(meeting_id)?;
        let Some(transcript) = existing else {
            return Ok(None);
        };
        if transcript_has_any_speaker_assignments(&transcript) {
            return Ok(Some(transcript));
        }
        if self.has_persisted_diarization_output(meeting_id)? {
            let _ =
                self.repair_transcript_speakers_from_persisted_diarization_if_needed(meeting_id);
            return self.fetch_meeting_transcript(meeting_id);
        }
        Ok(Some(transcript))
    }

    pub fn list_participants(&self) -> Result<Vec<MeetingParticipant>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, email, phone, photo_data_url
                 FROM participants
                 ORDER BY name COLLATE NOCASE ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(MeetingParticipant {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    email: row.get(2)?,
                    phone: row.get(3)?,
                    photo_data_url: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut participants = Vec::new();
        for row in rows {
            if let Ok(participant) = row {
                participants.push(participant);
            }
        }
        Ok(participants)
    }

    pub fn create_participant(
        &self,
        name: String,
        email: Option<String>,
        phone: Option<String>,
        photo_data_url: Option<String>,
    ) -> Result<MeetingParticipant, String> {
        let trimmed_name = name.trim();
        if trimmed_name.is_empty() {
            return Err("Participant name cannot be empty".to_string());
        }

        let normalized_email = email
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let normalized_phone = phone
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let normalized_photo = photo_data_url
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let now = Utc::now().timestamp();
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO participants (
                name,
                email,
                phone,
                photo_data_url,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                trimmed_name,
                normalized_email,
                normalized_phone,
                normalized_photo,
                now,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();

        Ok(MeetingParticipant {
            id,
            name: trimmed_name.to_string(),
            email: normalized_email,
            phone: normalized_phone,
            photo_data_url: normalized_photo,
        })
    }

    pub fn get_meeting_participants(
        &self,
        meeting_id: i64,
    ) -> Result<Vec<MeetingParticipant>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT
                    participants.id,
                    participants.name,
                    participants.email,
                    participants.phone,
                    participants.photo_data_url
                 FROM meeting_participants
                 JOIN participants ON participants.id = meeting_participants.participant_id
                 WHERE meeting_participants.meeting_id = ?1
                 ORDER BY participants.name COLLATE NOCASE ASC, participants.id ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![meeting_id], |row| {
                Ok(MeetingParticipant {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    email: row.get(2)?,
                    phone: row.get(3)?,
                    photo_data_url: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut participants = Vec::new();
        for row in rows {
            if let Ok(participant) = row {
                participants.push(participant);
            }
        }
        Ok(participants)
    }

    pub fn set_meeting_participants(
        &self,
        meeting_id: i64,
        participant_ids: Vec<i64>,
    ) -> Result<Vec<MeetingParticipant>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM meeting_participants WHERE meeting_id = ?1",
            params![meeting_id],
        )
        .map_err(|e| e.to_string())?;

        let mut seen = HashSet::new();
        for participant_id in participant_ids {
            if participant_id <= 0 || !seen.insert(participant_id) {
                continue;
            }
            tx.execute(
                "INSERT OR IGNORE INTO meeting_participants (meeting_id, participant_id) VALUES (?1, ?2)",
                params![meeting_id, participant_id],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        self.get_meeting_participants(meeting_id)
    }

    fn insert_meeting_note_span(
        &self,
        meeting_id: i64,
        start_offset_seconds: f64,
        end_offset_seconds: f64,
        text: String,
    ) -> Result<MeetingNote, String> {
        let mut start_offset_seconds = start_offset_seconds.max(0.0);
        let mut end_offset_seconds = end_offset_seconds.max(0.0);
        if end_offset_seconds < start_offset_seconds {
            std::mem::swap(&mut start_offset_seconds, &mut end_offset_seconds);
        }
        let offset_seconds = start_offset_seconds;
        let created_at = Utc::now().timestamp();
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO meeting_notes (
                meeting_id,
                offset_seconds,
                start_offset_seconds,
                end_offset_seconds,
                created_at,
                text
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                meeting_id,
                offset_seconds,
                start_offset_seconds,
                end_offset_seconds,
                created_at,
                text
            ],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        self.touch_meeting_updated_at_with_connection(&conn, meeting_id)?;
        Ok(MeetingNote {
            id,
            meeting_id,
            offset_seconds,
            start_offset_seconds,
            end_offset_seconds,
            created_at,
            text,
        })
    }

    fn fetch_meeting_transcript(
        &self,
        meeting_id: i64,
    ) -> Result<Option<MeetingTranscript>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT transcript_text, segments_json FROM meeting_transcripts WHERE meeting_id = ?1",
                params![meeting_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some((transcript_text, segments_json)) = row else {
            return Ok(None);
        };

        let segments: Vec<MeetingTranscriptSegment> =
            serde_json::from_str(&segments_json).map_err(|e| e.to_string())?;

        Ok(Some(MeetingTranscript {
            text: transcript_text,
            segments,
        }))
    }

    fn store_meeting_transcript(
        &self,
        meeting_id: i64,
        transcript: &MeetingTranscript,
    ) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let segments_json =
            serde_json::to_string(&transcript.segments).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO meeting_transcripts (meeting_id, transcript_text, segments_json)
             VALUES (?1, ?2, ?3)",
            params![meeting_id, transcript.text, segments_json],
        )
        .map_err(|e| e.to_string())?;
        self.touch_meeting_updated_at_with_connection(&conn, meeting_id)?;
        Ok(())
    }

    fn store_meeting_transcript_if_missing(
        &self,
        meeting_id: i64,
        transcript: &MeetingTranscript,
    ) -> Result<bool, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let segments_json =
            serde_json::to_string(&transcript.segments).map_err(|e| e.to_string())?;
        let rows_affected = conn
            .execute(
                "INSERT INTO meeting_transcripts (meeting_id, transcript_text, segments_json)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(meeting_id) DO NOTHING",
                params![meeting_id, transcript.text, segments_json],
            )
            .map_err(|e| e.to_string())?;
        Ok(rows_affected > 0)
    }

    pub fn rename_meeting(&self, id: i64, name: String) -> Result<(), String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Meeting name cannot be empty".to_string());
        }
        {
            let mut active = self.active_recording.lock().unwrap();
            if let Some(recording) = active.as_mut() {
                if recording.meeting_id == id {
                    recording.initial_name = trimmed.to_string();
                }
            }
        }
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let updated_at = Utc::now().timestamp();
        let rows = conn
            .execute(
                "UPDATE meetings
                 SET name = ?1, updated_at = ?2
                 WHERE id = ?3 AND deleted_at IS NULL AND is_visible = 1",
                params![trimmed, updated_at, id],
            )
            .map_err(|e| e.to_string())?;
        if rows == 0 {
            return Err("Meeting not found".to_string());
        }
        Ok(())
    }

    pub fn delete_meeting(&self, id: i64) -> Result<DeletedMeetingEntry, String> {
        self.purge_expired_deleted_meetings()?;
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let now = Utc::now().timestamp();
        let rows = conn
            .execute(
                "UPDATE meetings
                 SET deleted_at = ?1, is_visible = 0, updated_at = ?2
                 WHERE id = ?3 AND ended_at > 0 AND deleted_at IS NULL",
                params![now, now, id],
            )
            .map_err(|e| e.to_string())?;
        if rows == 0 {
            return Err("Meeting not found".to_string());
        }

        let mut tags_by_meeting = self.load_meeting_tags_by_deleted_state(&conn, true)?;
        let row: Option<(i64, String, i64, i64, f64, String, bool, i64)> = conn
            .query_row(
                "SELECT
                    id,
                    name,
                    started_at,
                    ended_at,
                    duration_seconds,
                    file_name,
                    include_system_audio,
                    deleted_at
                 FROM meetings
                 WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some((
            meeting_id,
            name,
            started_at,
            ended_at,
            duration_seconds,
            file_name,
            include_system_audio,
            deleted_at,
        )) = row
        else {
            return Err("Meeting not found".to_string());
        };

        Ok(DeletedMeetingEntry {
            id: meeting_id,
            name,
            started_at,
            ended_at,
            duration_seconds,
            file_name,
            include_system_audio,
            tags: tags_by_meeting.remove(&meeting_id).unwrap_or_default(),
            deleted_at,
            purge_at: deleted_meeting_purge_at(deleted_at),
        })
    }

    pub fn restore_meeting(&self, id: i64) -> Result<MeetingEntry, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let now = Utc::now().timestamp();
        let rows = conn
            .execute(
                "UPDATE meetings
                 SET deleted_at = NULL, is_visible = 1, updated_at = ?1
                 WHERE id = ?2 AND deleted_at IS NOT NULL",
                params![now, id],
            )
            .map_err(|e| e.to_string())?;
        if rows == 0 {
            return Err("Meeting not found".to_string());
        }
        self.get_meeting_entry(id)
    }

    pub fn delete_meeting_permanently(&self, id: i64) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let file_name: String = conn
            .query_row(
                "SELECT file_name FROM meetings WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Meeting not found".to_string())?;

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM meeting_tags WHERE meeting_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM meeting_notes WHERE meeting_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM meeting_transcripts WHERE meeting_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM meeting_diarization_segments WHERE meeting_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM meeting_speaker_mappings WHERE meeting_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM meeting_diarization_jobs WHERE meeting_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM meeting_participants WHERE meeting_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM meetings WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;

        let path = self.meetings_dir.join(file_name);
        let _ = fs::remove_file(path);

        Ok(())
    }

    pub fn list_tags(&self) -> Result<Vec<String>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT tags.name
                 FROM tags
                 JOIN meeting_tags ON meeting_tags.tag_id = tags.id
                 JOIN meetings ON meetings.id = meeting_tags.meeting_id
                 WHERE meetings.deleted_at IS NULL AND meetings.is_visible = 1
                 ORDER BY tags.name COLLATE NOCASE ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;

        let mut tags = Vec::new();
        for row in rows {
            if let Ok(tag) = row {
                tags.push(tag);
            }
        }

        Ok(tags)
    }

    pub fn set_meeting_tags(
        &self,
        meeting_id: i64,
        tags: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let mut conn = self.get_connection().map_err(|e| e.to_string())?;
        let exists: Option<i64> = conn
            .query_row(
                "SELECT id FROM meetings WHERE id = ?1 AND deleted_at IS NULL AND is_visible = 1",
                params![meeting_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            return Err("Meeting not found".to_string());
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let mut normalized_seen = HashSet::new();
        let mut tag_ids = Vec::new();
        let mut display_names = Vec::new();

        for raw in tags {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let normalized = normalize_tag(trimmed);
            if normalized.is_empty() || !normalized_seen.insert(normalized.clone()) {
                continue;
            }

            let existing: Option<(i64, String)> = tx
                .query_row(
                    "SELECT id, name FROM tags WHERE normalized = ?1",
                    params![normalized],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;

            let (tag_id, display_name) = if let Some(existing) = existing {
                existing
            } else {
                tx.execute(
                    "INSERT INTO tags (name, normalized) VALUES (?1, ?2)",
                    params![trimmed, normalized],
                )
                .map_err(|e| e.to_string())?;
                (tx.last_insert_rowid(), trimmed.to_string())
            };

            tag_ids.push(tag_id);
            display_names.push(display_name);
        }

        tx.execute(
            "DELETE FROM meeting_tags WHERE meeting_id = ?1",
            params![meeting_id],
        )
        .map_err(|e| e.to_string())?;

        for tag_id in &tag_ids {
            tx.execute(
                "INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?1, ?2)",
                params![meeting_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        self.touch_meeting_updated_at(meeting_id)?;

        Ok(display_names)
    }

    pub fn get_active_meeting(&self) -> Option<ActiveMeetingInfo> {
        let active = self.active_recording.lock().unwrap();
        active.as_ref().map(|recording| ActiveMeetingInfo {
            id: recording.meeting_id,
            started_at: recording.started_at,
            name: recording.initial_name.clone(),
        })
    }

    pub fn get_active_meeting_live_transcript(&self) -> Option<MeetingTranscript> {
        let active = self.active_recording.lock().unwrap();
        active
            .as_ref()
            .map(|recording| recording.live_transcript.snapshot())
    }

    pub fn add_active_meeting_note(&self, text: String) -> Result<MeetingNote, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Meeting note cannot be empty".to_string());
        }

        let (meeting_id, started_at) = {
            let active = self.active_recording.lock().unwrap();
            let recording = active
                .as_ref()
                .ok_or_else(|| "No active meeting recording".to_string())?;
            (recording.meeting_id, recording.started_at)
        };

        let now_ms = Utc::now().timestamp_millis();
        let offset_seconds = ((now_ms as f64 / 1000.0) - started_at as f64).max(0.0);
        self.insert_meeting_note_span(
            meeting_id,
            offset_seconds,
            offset_seconds,
            trimmed.to_string(),
        )
    }

    pub fn add_active_meeting_note_span(
        &self,
        start_offset_seconds: f64,
        end_offset_seconds: f64,
        text: String,
    ) -> Result<MeetingNote, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Meeting note cannot be empty".to_string());
        }

        let meeting_id = {
            let active = self.active_recording.lock().unwrap();
            let recording = active
                .as_ref()
                .ok_or_else(|| "No active meeting recording".to_string())?;
            recording.meeting_id
        };

        self.insert_meeting_note_span(
            meeting_id,
            start_offset_seconds,
            end_offset_seconds,
            trimmed.to_string(),
        )
    }

    pub fn add_meeting_note_at(
        &self,
        meeting_id: i64,
        offset_seconds: f64,
        text: String,
    ) -> Result<MeetingNote, String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("Meeting note cannot be empty".to_string());
        }
        let offset_seconds = offset_seconds.max(0.0);
        self.insert_meeting_note_span(
            meeting_id,
            offset_seconds,
            offset_seconds,
            trimmed.to_string(),
        )
    }

    pub fn get_meeting_notes(&self, meeting_id: i64) -> Result<Vec<MeetingNote>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT
                    id,
                    meeting_id,
                    offset_seconds,
                    start_offset_seconds,
                    end_offset_seconds,
                    created_at,
                    text
                 FROM meeting_notes
                 WHERE meeting_id = ?1
                 ORDER BY offset_seconds ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![meeting_id], |row| {
                let offset_seconds: f64 = row.get(2)?;
                let start_offset_seconds = row.get::<_, Option<f64>>(3)?.unwrap_or(offset_seconds);
                let end_offset_seconds = row
                    .get::<_, Option<f64>>(4)?
                    .unwrap_or(start_offset_seconds);
                Ok(MeetingNote {
                    id: row.get(0)?,
                    meeting_id: row.get(1)?,
                    offset_seconds,
                    start_offset_seconds,
                    end_offset_seconds,
                    created_at: row.get(5)?,
                    text: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut notes = Vec::new();
        for row in rows {
            if let Ok(note) = row {
                notes.push(note);
            }
        }

        Ok(notes)
    }

    pub async fn get_meeting_transcript(
        &self,
        meeting_id: i64,
    ) -> Result<MeetingTranscript, String> {
        if let Some(existing) = self.fetch_meeting_transcript(meeting_id)? {
            if !transcript_has_any_speaker_assignments(&existing)
                && self.has_persisted_diarization_output(meeting_id)?
            {
                let _ = self
                    .repair_transcript_speakers_from_persisted_diarization_if_needed(meeting_id);
                if let Some(repaired) = self.fetch_meeting_transcript(meeting_id)? {
                    return Ok(repaired);
                }
            }
            return Ok(existing);
        }

        let transcript = self.transcribe_meeting_audio_file(meeting_id).await?;
        let stored = self.store_meeting_transcript_if_missing(meeting_id, &transcript)?;
        if stored {
            return Ok(transcript);
        }
        if let Some(existing) = self.fetch_meeting_transcript(meeting_id)? {
            return Ok(existing);
        }
        Ok(transcript)
    }

    async fn transcribe_meeting_audio_file(
        &self,
        meeting_id: i64,
    ) -> Result<MeetingTranscript, String> {
        let file_path = self.get_existing_meeting_file_path_by_id(meeting_id)?;
        let app_handle = self.app_handle.clone();
        let transcript = tauri::async_runtime::spawn_blocking(move || {
            transcribe_meeting_audio(&app_handle, &file_path)
        })
        .await
        .map_err(|e| format!("Failed to join meeting transcript task: {e}"))??;

        if transcript.segments.is_empty() || transcript.text.trim().is_empty() {
            return Ok(transcript);
        }

        if let Some(cleaned) = self.clean_meeting_transcript_with_llm(&transcript).await {
            return Ok(cleaned);
        }

        Ok(transcript)
    }

    pub async fn update_meeting_transcript_segment(
        &self,
        meeting_id: i64,
        segment_index: usize,
        text: String,
    ) -> Result<MeetingTranscript, String> {
        let mut transcript = self.get_meeting_transcript(meeting_id).await?;
        let segment = transcript
            .segments
            .get_mut(segment_index)
            .ok_or_else(|| "Transcript segment not found".to_string())?;
        segment.text = text.trim().to_string();

        transcript.text = transcript
            .segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");

        self.store_meeting_transcript(meeting_id, &transcript)?;
        Ok(transcript)
    }

    pub async fn update_meeting_transcript_segment_speaker(
        &self,
        meeting_id: i64,
        segment_index: usize,
        speaker_id: Option<String>,
        apply_to_all_with_same_speaker: bool,
    ) -> Result<MeetingTranscript, String> {
        let mut transcript = self.get_meeting_transcript(meeting_id).await?;
        let current_speaker = transcript
            .segments
            .get(segment_index)
            .ok_or_else(|| "Transcript segment not found".to_string())?
            .speaker_id
            .clone();

        if apply_to_all_with_same_speaker {
            match current_speaker {
                Some(target) => {
                    for segment in &mut transcript.segments {
                        if segment.speaker_id.as_deref() == Some(target.as_str()) {
                            segment.speaker_id = speaker_id.clone();
                        }
                    }
                }
                None => {
                    for segment in &mut transcript.segments {
                        if segment.speaker_id.is_none() {
                            segment.speaker_id = speaker_id.clone();
                        }
                    }
                }
            }
        } else if let Some(segment) = transcript.segments.get_mut(segment_index) {
            segment.speaker_id = speaker_id;
        }

        self.store_meeting_transcript(meeting_id, &transcript)?;
        Ok(transcript)
    }

    pub async fn summarize_meeting(&self, meeting_id: i64) -> Result<MeetingSummaryResult, String> {
        let transcript = self.get_meeting_transcript(meeting_id).await?;
        let prompt_transcript = build_meeting_prompt_transcript(&transcript, 12_000);
        if prompt_transcript.trim().is_empty() {
            return Ok(fallback_meeting_summary(&transcript));
        }

        let prompt = format!(
            "Transcript:\n{}\n\nReturn JSON with this exact shape:\n{{\"summary\":\"string\",\"key_points\":[\"string\"],\"decisions\":[\"string\"],\"risks\":[\"string\"],\"follow_ups\":[\"string\"]}}",
            prompt_transcript
        );

        if let Some(parsed) = self
            .request_meeting_llm_json::<MeetingSummaryResult>(
                "You analyze meeting transcripts and produce practical, concise outputs. Return only valid JSON with no markdown.",
                &prompt,
            )
            .await
        {
            return Ok(normalize_meeting_summary(parsed));
        }

        Ok(fallback_meeting_summary(&transcript))
    }

    pub async fn generate_meeting_tasks(
        &self,
        meeting_id: i64,
    ) -> Result<Vec<MeetingGeneratedTask>, String> {
        #[derive(Debug, Deserialize)]
        struct TaskEnvelope {
            tasks: Vec<MeetingGeneratedTask>,
        }

        let transcript = self.get_meeting_transcript(meeting_id).await?;
        let prompt_transcript = build_meeting_prompt_transcript(&transcript, 12_000);
        if prompt_transcript.trim().is_empty() {
            return Ok(fallback_meeting_tasks(&transcript));
        }

        let prompt = format!(
            "Transcript:\n{}\n\nGenerate follow-up tasks from this meeting.\nRules:\n- Focus on concrete owner/action tasks.\n- Priority must be an integer 1 (highest) to 4 (lowest).\n- tags should be short lowercase labels.\n- due_hint is optional natural language like \"tomorrow\" or \"next Monday\".\nReturn JSON with this exact shape:\n{{\"tasks\":[{{\"title\":\"string\",\"notes\":\"string\",\"priority\":3,\"tags\":[\"meeting\"],\"due_hint\":\"string|null\"}}]}}",
            prompt_transcript
        );

        if let Some(parsed) = self.request_meeting_llm_json::<TaskEnvelope>(
            "You convert meeting transcripts into actionable task lists. Return only valid JSON with no markdown.",
            &prompt,
        )
        .await
        {
            let normalized = normalize_generated_tasks(parsed.tasks);
            if !normalized.is_empty() {
                return Ok(normalized);
            }
        }

        Ok(fallback_meeting_tasks(&transcript))
    }

    pub async fn draft_meeting_follow_up(
        &self,
        meeting_id: i64,
    ) -> Result<MeetingFollowUpDraft, String> {
        let transcript = self.get_meeting_transcript(meeting_id).await?;
        let prompt_transcript = build_meeting_prompt_transcript(&transcript, 12_000);
        if prompt_transcript.trim().is_empty() {
            return Ok(fallback_follow_up_draft(&transcript));
        }

        let prompt = format!(
            "Transcript:\n{}\n\nDraft a concise follow-up email.\nReturn JSON with this exact shape:\n{{\"subject\":\"string\",\"body\":\"string\"}}",
            prompt_transcript
        );

        if let Some(parsed) = self
            .request_meeting_llm_json::<MeetingFollowUpDraft>(
                "You write polished post-meeting follow-up emails. Return only valid JSON with no markdown.",
                &prompt,
            )
            .await
        {
            let normalized = normalize_follow_up_draft(parsed);
            if !normalized.subject.is_empty() && !normalized.body.is_empty() {
                return Ok(normalized);
            }
        }

        Ok(fallback_follow_up_draft(&transcript))
    }

    async fn clean_meeting_transcript_with_llm(
        &self,
        transcript: &MeetingTranscript,
    ) -> Option<MeetingTranscript> {
        if transcript.segments.is_empty() {
            return None;
        }

        let settings = get_settings(&self.app_handle);
        let total_segments = transcript.segments.len();
        let mut protected_inputs: Vec<(String, Vec<String>)> = Vec::with_capacity(total_segments);
        let request = MeetingTranscriptCleanupRequest {
            segments: transcript
                .segments
                .iter()
                .enumerate()
                .map(|(index, segment)| {
                    let (protected, replacements) =
                        polish::protect_verbatim_spans(segment.text.trim());
                    protected_inputs.push((protected.clone(), replacements));
                    MeetingTranscriptCleanupRequestSegment {
                        index,
                        text: protected,
                    }
                })
                .collect(),
        };

        let request_json = match serde_json::to_string(&request) {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    "Failed to serialize meeting transcript cleanup payload: {}",
                    err
                );
                return None;
            }
        };

        let payload_chars = request_json.chars().count();
        if payload_chars > MEETING_TRANSCRIPT_CLEANUP_MAX_CHARS {
            warn!(
                "Meeting transcript cleanup skipped: payload too large ({} chars, limit {}).",
                payload_chars, MEETING_TRANSCRIPT_CLEANUP_MAX_CHARS
            );
            return None;
        }

        let prompt = format!(
            "<task>Clean meeting transcript segments from ASR output.</task>\n<rules>\n- Return JSON only.\n- Return exactly one segment object for every input segment index.\n- Keep each segment index unchanged.\n- If uncertain, keep the original segment text unchanged.\n- Do not merge, split, reorder, or remove segments.\n- Do not add facts, speaker names, timestamps, or metadata.\n- Preserve meaning and language.\n- Keep placeholders exactly as-is (for example <<V0>>).\n- Never perform arithmetic; keep numbers as spoken.\n- {}\n</rules>\n<output_json_schema>{{\"text\":\"string\",\"segments\":[{{\"index\":0,\"text\":\"string\"}}]}}</output_json_schema>\n<input_json>{}</input_json>",
            polish::filler_cleanup_rule(settings.post_process_remove_fillers),
            request_json
        );

        let system_prompt =
            meeting_transcript_cleanup_system_prompt(settings.post_process_remove_fillers);
        let raw = self
            .request_meeting_llm_text_with_provider_priority(
                &settings,
                system_prompt.as_str(),
                &prompt,
                true,
                MEETING_TRANSCRIPT_CLEANUP_DEFAULT_REASONING_EFFORT,
            )
            .await?;

        let parsed = parse_meeting_llm_json::<MeetingTranscriptCleanupResponse>(&raw)?;
        if parsed.segments.is_empty() {
            return None;
        }
        let model_text_candidate = parsed.text.unwrap_or_default();

        let mut candidate_by_index: HashMap<usize, String> = HashMap::new();
        for segment in parsed.segments {
            if segment.index >= total_segments {
                warn!(
                    "Meeting transcript cleanup rejected: out-of-range segment index {}.",
                    segment.index
                );
                return None;
            }
            if candidate_by_index
                .insert(segment.index, segment.text)
                .is_some()
            {
                warn!(
                    "Meeting transcript cleanup rejected: duplicate segment index {}.",
                    segment.index
                );
                return None;
            }
        }
        if candidate_by_index.len() != total_segments {
            warn!(
                "Meeting transcript cleanup rejected: expected {} segments, received {}.",
                total_segments,
                candidate_by_index.len()
            );
            return None;
        }

        let mut cleaned_segments = Vec::with_capacity(total_segments);
        let mut valid_segment_count = 0usize;

        for (index, source_segment) in transcript.segments.iter().enumerate() {
            let Some(candidate_raw) = candidate_by_index.get(&index) else {
                cleaned_segments.push(source_segment.clone());
                continue;
            };

            let candidate = candidate_raw.trim();
            if candidate.is_empty() {
                cleaned_segments.push(source_segment.clone());
                continue;
            }

            let (protected_input, replacements) = &protected_inputs[index];
            if let Err(reason) =
                polish::validate_llm_output_with_reason(protected_input, candidate, replacements)
            {
                warn!(
                    "Meeting transcript cleanup rejected segment {} during validation: {}",
                    index, reason
                );
                cleaned_segments.push(source_segment.clone());
                continue;
            }

            let restored = polish::restore_verbatim_spans(candidate, replacements);
            let restored_trimmed = restored.trim().to_string();
            if restored_trimmed.is_empty() {
                cleaned_segments.push(source_segment.clone());
                continue;
            }
            let source_char_count = source_segment.text.trim().chars().count();
            if source_char_count >= 8 {
                let cleaned_char_count = restored_trimmed.chars().count();
                let ratio = cleaned_char_count as f32 / source_char_count as f32;
                if ratio < MEETING_TRANSCRIPT_CLEANUP_MIN_SEGMENT_CHAR_RATIO
                    || ratio > MEETING_TRANSCRIPT_CLEANUP_MAX_SEGMENT_CHAR_RATIO
                {
                    warn!(
                        "Meeting transcript cleanup rejected segment {} due to suspicious length ratio {:.2}.",
                        index, ratio
                    );
                    cleaned_segments.push(source_segment.clone());
                    continue;
                }
            }

            valid_segment_count = valid_segment_count.saturating_add(1);
            cleaned_segments.push(MeetingTranscriptSegment {
                start: source_segment.start,
                end: source_segment.end,
                text: restored_trimmed,
                speaker_id: source_segment.speaker_id.clone(),
            });
        }

        let valid_ratio = valid_segment_count as f32 / total_segments as f32;
        if valid_ratio < MEETING_TRANSCRIPT_CLEANUP_MIN_VALID_SEGMENT_RATIO {
            warn!(
                "Meeting transcript cleanup rejected: valid segment ratio {:.2} below threshold {:.2}.",
                valid_ratio, MEETING_TRANSCRIPT_CLEANUP_MIN_VALID_SEGMENT_RATIO
            );
            return None;
        }

        let cleaned_text = cleaned_segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if cleaned_text.is_empty() {
            return None;
        }

        if let Err(reason) =
            polish::validate_llm_output_with_reason(transcript.text.trim(), &cleaned_text, &[])
        {
            warn!(
                "Meeting transcript cleanup rejected after whole-text validation: {}",
                reason
            );
            return None;
        }

        let model_text_trimmed = model_text_candidate.trim();
        if !model_text_trimmed.is_empty() {
            if let Err(reason) = polish::validate_llm_output_with_reason(
                transcript.text.trim(),
                model_text_trimmed,
                &[],
            ) {
                warn!(
                    "Meeting transcript cleanup rejected model text field during validation: {}",
                    reason
                );
                return None;
            }
        }

        Some(MeetingTranscript {
            text: cleaned_text,
            segments: cleaned_segments,
        })
    }

    async fn request_meeting_llm_json<T: DeserializeOwned>(
        &self,
        system_prompt: &str,
        prompt: &str,
    ) -> Option<T> {
        let raw = self.request_meeting_llm_text(system_prompt, prompt).await?;
        parse_meeting_llm_json::<T>(&raw)
    }

    async fn request_meeting_llm_text(&self, system_prompt: &str, prompt: &str) -> Option<String> {
        let settings = get_settings(&self.app_handle);
        self.request_meeting_llm_text_with_provider_priority(
            &settings,
            system_prompt,
            prompt,
            false,
            MEETING_LLM_DEFAULT_REASONING_EFFORT,
        )
        .await
    }

    async fn request_meeting_llm_text_with_provider_priority(
        &self,
        settings: &AppSettings,
        system_prompt: &str,
        prompt: &str,
        prefer_codex: bool,
        codex_reasoning_effort: Option<&str>,
    ) -> Option<String> {
        let mut provider_ids: Vec<String> = Vec::new();
        if prefer_codex {
            provider_ids.push(OPENAI_CODEX_PROVIDER_ID.to_string());
        }
        if !settings.post_process_provider_id.trim().is_empty() {
            provider_ids.push(settings.post_process_provider_id.clone());
        }
        provider_ids.push("local_llama".to_string());

        let mut seen = HashSet::new();
        for provider_id in provider_ids {
            if !seen.insert(provider_id.clone()) {
                continue;
            }
            let Some(provider) = settings.post_process_provider(&provider_id).cloned() else {
                continue;
            };
            if let Some(content) = self
                .request_meeting_llm_text_with_provider_reasoning(
                    settings,
                    provider,
                    system_prompt,
                    prompt,
                    codex_reasoning_effort,
                )
                .await
            {
                return Some(content);
            }
        }
        None
    }

    async fn request_meeting_llm_text_with_provider(
        &self,
        settings: &AppSettings,
        provider: PostProcessProvider,
        system_prompt: &str,
        prompt: &str,
    ) -> Option<String> {
        self.request_meeting_llm_text_with_provider_reasoning(
            settings,
            provider,
            system_prompt,
            prompt,
            MEETING_LLM_DEFAULT_REASONING_EFFORT,
        )
        .await
    }

    async fn request_meeting_llm_text_with_provider_reasoning(
        &self,
        settings: &AppSettings,
        provider: PostProcessProvider,
        system_prompt: &str,
        prompt: &str,
        codex_reasoning_effort: Option<&str>,
    ) -> Option<String> {
        let mut model_id = settings
            .post_process_models
            .get(&provider.id)
            .cloned()
            .unwrap_or_default();

        if provider.id == "local_llama" && model_id.trim().is_empty() {
            model_id = MEETING_LIGHTWEIGHT_MODEL_ID.to_string();
        }
        if model_id.trim().is_empty() {
            return None;
        }

        if provider.id == "local_llama" {
            let local_llm_manager = self.app_handle.state::<Arc<LocalLlmManager>>();
            if let Err(err) = local_llm_manager.ensure_running(&self.app_handle, &model_id) {
                warn!("Local LLM unavailable for meeting insights: {}", err);
                return None;
            }
            if let Some(active_model_id) = local_llm_manager.active_model_id() {
                model_id = active_model_id;
            }
        }

        let fallback_api_key = settings
            .post_process_api_keys
            .get(&provider.id)
            .cloned()
            .unwrap_or_default();
        let api_key = match crate::openai_codex_oauth::resolve_provider_api_key(
            &self.app_handle,
            &provider.id,
            fallback_api_key,
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    "Failed to resolve API key for provider '{}' while generating meeting insights: {}",
                    provider.id, err
                );
                return None;
            }
        };

        match llm_client::send_chat_completion_with_codex_reasoning(
            &provider,
            api_key,
            &model_id,
            Some(system_prompt),
            prompt,
            codex_reasoning_effort,
        )
        .await
        {
            Ok(Some(content)) => {
                let trimmed = content.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            Ok(None) => None,
            Err(err) => {
                warn!(
                    "Meeting insight generation failed for provider '{}': {}",
                    provider.id, err
                );
                None
            }
        }
    }

    async fn generate_meeting_name(&self, snippet_24k: &[f32], sample_rate: u32) -> Option<String> {
        if snippet_24k.is_empty() {
            return None;
        }

        let snippet_16k = resample_audio(snippet_24k, sample_rate, TRANSCRIPTION_SAMPLE_RATE);
        let app_handle = self.app_handle.clone();
        let transcript = tauri::async_runtime::spawn_blocking(move || {
            let manager = app_handle.state::<Arc<TranscriptionManager>>();
            manager.transcribe(snippet_16k).ok()
        })
        .await
        .ok()
        .flatten()?;

        let trimmed = transcript.trim();
        if trimmed.is_empty() {
            return None;
        }

        let settings = get_settings(&self.app_handle);
        let system_prompt = "You generate concise, descriptive meeting titles.";
        let prompt = format!(
            "Transcript snippet:\n{}\n\nReturn only a meeting title (plain text, no quotes, no markdown).\nConstraints:\n- 6 to 60 characters\n- concise and specific\n- no trailing punctuation",
            trimmed
        );

        let mut provider_ids: Vec<String> = Vec::new();
        provider_ids.push(OPENAI_CODEX_PROVIDER_ID.to_string());
        if !settings.post_process_provider_id.trim().is_empty() {
            provider_ids.push(settings.post_process_provider_id.clone());
        }
        provider_ids.push("local_llama".to_string());

        let mut seen = HashSet::new();
        for provider_id in provider_ids {
            if !seen.insert(provider_id.clone()) {
                continue;
            }
            let Some(provider) = settings.post_process_provider(&provider_id).cloned() else {
                continue;
            };
            if let Some(name) = self
                .request_meeting_llm_text_with_provider(&settings, provider, system_prompt, &prompt)
                .await
            {
                let cleaned = clean_meeting_title(&name);
                if !cleaned.is_empty() {
                    return Some(cleaned);
                }
            }
        }

        None
    }

    pub fn prepare_sync_payload(&self, user_id: &str) -> Result<MeetingsSyncPayload, String> {
        let client_id = self.get_or_create_sync_client_id()?;
        let last_sync_at = self.get_last_sync_at(user_id)?;
        let meetings = self.get_meeting_changes(last_sync_at)?;

        Ok(MeetingsSyncPayload {
            client_id,
            last_sync_at,
            meetings,
        })
    }

    pub fn apply_sync_result(
        &self,
        user_id: &str,
        result: &MeetingsSyncResult,
    ) -> Result<(), String> {
        self.apply_meeting_updates(&result.meetings)?;
        self.set_last_sync_at(user_id, result.server_time)?;

        if !result.meetings.is_empty() {
            let _ = self.app_handle.emit("meetings-updated", ());
        }

        Ok(())
    }

    pub fn list_pending_audio_uploads(&self) -> Result<Vec<PendingMeetingAudioUpload>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sync_id, file_name
                 FROM meetings
                 WHERE ended_at > 0
                   AND deleted_at IS NULL
                   AND is_visible = 1
                   AND sync_id IS NOT NULL
                   AND (
                    cloud_audio_key IS NULL
                    OR trim(cloud_audio_key) = ''
                    OR cloud_audio_uploaded_at IS NULL
                   )
                 ORDER BY ended_at DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(PendingMeetingAudioUpload {
                    sync_id: row.get(0)?,
                    file_name: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut uploads = Vec::new();
        for row in rows {
            let Ok(candidate) = row else {
                continue;
            };
            let path = self.get_meeting_audio_file_path(&candidate.file_name);
            if path.exists() {
                uploads.push(candidate);
            }
        }

        Ok(uploads)
    }

    pub fn mark_audio_uploaded(
        &self,
        sync_id: &str,
        audio_key: String,
        uploaded_at: i64,
    ) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE meetings
             SET cloud_audio_key = ?1,
                 cloud_audio_uploaded_at = ?2,
                 updated_at = CASE
                   WHEN updated_at IS NULL OR updated_at < ?2 THEN ?2
                   ELSE updated_at
                 END,
                 is_visible = 1
             WHERE sync_id = ?3",
            params![audio_key, uploaded_at, sync_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_audio_download_candidates(
        &self,
    ) -> Result<Vec<MeetingAudioDownloadCandidate>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sync_id, file_name
                 FROM meetings
                 WHERE ended_at > 0
                   AND deleted_at IS NULL
                   AND is_visible = 1
                   AND sync_id IS NOT NULL
                   AND cloud_audio_key IS NOT NULL
                   AND trim(cloud_audio_key) <> ''",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(MeetingAudioDownloadCandidate {
                    sync_id: row.get(0)?,
                    file_name: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut downloads = Vec::new();
        for row in rows {
            let Ok(candidate) = row else {
                continue;
            };
            let path = self.get_meeting_audio_file_path(&candidate.file_name);
            if !path.exists() {
                downloads.push(candidate);
            }
        }

        Ok(downloads)
    }

    fn get_or_create_sync_client_id(&self) -> Result<String, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT client_id FROM meeting_sync_device WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some(client_id) = existing {
            return Ok(client_id);
        }

        let client_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO meeting_sync_device (id, client_id) VALUES (1, ?1)",
            params![client_id],
        )
        .map_err(|e| e.to_string())?;

        Ok(client_id)
    }

    fn get_last_sync_at(&self, user_id: &str) -> Result<i64, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let last_sync_at: Option<i64> = conn
            .query_row(
                "SELECT last_sync_at FROM meeting_sync_state WHERE user_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(last_sync_at.unwrap_or(0))
    }

    fn set_last_sync_at(&self, user_id: &str, timestamp: i64) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO meeting_sync_state (user_id, last_sync_at)
             VALUES (?1, ?2)
             ON CONFLICT(user_id) DO UPDATE SET last_sync_at = excluded.last_sync_at",
            params![user_id, timestamp],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn get_meeting_changes(&self, since: i64) -> Result<Vec<SyncMeetingEntry>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT
                    id,
                    sync_id,
                    file_name,
                    name,
                    started_at,
                    ended_at,
                    duration_seconds,
                    include_system_audio,
                    cloud_audio_key,
                    cloud_audio_uploaded_at,
                    updated_at,
                    deleted_at,
                    is_visible
                 FROM meetings
                 WHERE ended_at > 0
                   AND (
                    sync_id IS NULL
                    OR trim(sync_id) = ''
                    OR updated_at IS NULL
                    OR updated_at > ?1
                   )
                 ORDER BY COALESCE(updated_at, ended_at, started_at) ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![since], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, f64>(6)?,
                    row.get::<_, bool>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                    row.get::<_, bool>(12)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        let mut updates: Vec<(i64, String, i64)> = Vec::new();

        for row in rows {
            let (
                id,
                sync_id,
                file_name,
                name,
                started_at,
                ended_at,
                duration_seconds,
                include_system_audio,
                cloud_audio_key,
                cloud_audio_uploaded_at,
                updated_at,
                deleted_at,
                is_visible,
            ) = row.map_err(|e| e.to_string())?;

            let missing_sync_id = sync_id
                .as_ref()
                .map(|value| value.trim().is_empty())
                .unwrap_or(true);
            let sync_id = sync_id
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let updated_at = updated_at.unwrap_or(ended_at.max(started_at));

            if missing_sync_id || updated_at <= 0 {
                updates.push((id, sync_id.clone(), updated_at));
            }

            let tags = self.load_tags_for_meeting(&conn, id)?;
            entries.push(SyncMeetingEntry {
                sync_id,
                file_name,
                name,
                started_at,
                ended_at,
                duration_seconds,
                include_system_audio,
                tags,
                audio_s3_key: cloud_audio_key,
                audio_uploaded_at: cloud_audio_uploaded_at,
                updated_at,
                deleted_at,
                is_visible,
            });
        }

        for (id, sync_id, updated_at) in updates {
            conn.execute(
                "UPDATE meetings
                 SET sync_id = ?1,
                     updated_at = COALESCE(updated_at, ?2)
                 WHERE id = ?3",
                params![sync_id, updated_at, id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(entries)
    }

    fn replace_meeting_tags_with_connection(
        &self,
        conn: &Connection,
        meeting_id: i64,
        tags: &[String],
    ) -> Result<(), String> {
        let mut normalized_seen = HashSet::new();
        let mut tag_ids = Vec::new();

        for raw in tags {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let normalized = normalize_tag(trimmed);
            if normalized.is_empty() || !normalized_seen.insert(normalized.clone()) {
                continue;
            }

            let existing: Option<(i64, String)> = conn
                .query_row(
                    "SELECT id, name FROM tags WHERE normalized = ?1",
                    params![normalized],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;

            let tag_id = if let Some(existing) = existing {
                existing.0
            } else {
                conn.execute(
                    "INSERT INTO tags (name, normalized) VALUES (?1, ?2)",
                    params![trimmed, normalized],
                )
                .map_err(|e| e.to_string())?;
                conn.last_insert_rowid()
            };

            tag_ids.push(tag_id);
        }

        conn.execute(
            "DELETE FROM meeting_tags WHERE meeting_id = ?1",
            params![meeting_id],
        )
        .map_err(|e| e.to_string())?;

        for tag_id in tag_ids {
            conn.execute(
                "INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?1, ?2)",
                params![meeting_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    fn apply_meeting_updates(&self, entries: &[SyncMeetingEntry]) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }

        let conn = self.get_connection().map_err(|e| e.to_string())?;

        for entry in entries {
            let existing: Option<(i64, i64)> = conn
                .query_row(
                    "SELECT id, COALESCE(updated_at, 0) FROM meetings WHERE sync_id = ?1",
                    params![entry.sync_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;

            let normalized_is_visible = if entry.deleted_at.is_some() {
                false
            } else {
                entry.is_visible
            };

            if let Some((id, local_updated_at)) = existing {
                if local_updated_at >= entry.updated_at {
                    continue;
                }

                let deleted_at = if normalized_is_visible {
                    Option::<i64>::None
                } else {
                    Some(entry.deleted_at.unwrap_or(entry.updated_at))
                };

                conn.execute(
                    "UPDATE meetings
                     SET file_name = ?1,
                         name = ?2,
                         started_at = ?3,
                         ended_at = ?4,
                         duration_seconds = ?5,
                         include_system_audio = ?6,
                         cloud_audio_key = ?7,
                         cloud_audio_uploaded_at = ?8,
                         updated_at = ?9,
                         deleted_at = ?10,
                         is_visible = ?11
                     WHERE id = ?12",
                    params![
                        entry.file_name,
                        entry.name,
                        entry.started_at,
                        entry.ended_at,
                        entry.duration_seconds,
                        entry.include_system_audio,
                        entry.audio_s3_key,
                        entry.audio_uploaded_at,
                        entry.updated_at,
                        deleted_at,
                        normalized_is_visible,
                        id
                    ],
                )
                .map_err(|e| e.to_string())?;

                self.replace_meeting_tags_with_connection(&conn, id, &entry.tags)?;
                continue;
            }

            let deleted_at = if normalized_is_visible {
                Option::<i64>::None
            } else {
                Some(entry.deleted_at.unwrap_or(entry.updated_at))
            };

            conn.execute(
                "INSERT INTO meetings (
                    sync_id,
                    file_name,
                    name,
                    started_at,
                    ended_at,
                    duration_seconds,
                    include_system_audio,
                    cloud_audio_key,
                    cloud_audio_uploaded_at,
                    updated_at,
                    deleted_at,
                    is_visible
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    entry.sync_id,
                    entry.file_name,
                    entry.name,
                    entry.started_at,
                    entry.ended_at,
                    entry.duration_seconds,
                    entry.include_system_audio,
                    entry.audio_s3_key,
                    entry.audio_uploaded_at,
                    entry.updated_at,
                    deleted_at,
                    normalized_is_visible
                ],
            )
            .map_err(|e| e.to_string())?;
            let meeting_id = conn.last_insert_rowid();
            self.replace_meeting_tags_with_connection(&conn, meeting_id, &entry.tags)?;
        }

        Ok(())
    }
}

fn build_meeting_prompt_transcript(transcript: &MeetingTranscript, max_chars: usize) -> String {
    let mut text = if !transcript.text.trim().is_empty() {
        transcript.text.trim().to_string()
    } else {
        transcript
            .segments
            .iter()
            .map(|segment| segment.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };

    if text.chars().count() > max_chars {
        text = text.chars().take(max_chars).collect();
    }

    text
}

fn parse_meeting_llm_json<T: DeserializeOwned>(raw: &str) -> Option<T> {
    let trimmed = raw.trim();
    let mut candidates = vec![trimmed.to_string()];

    if trimmed.starts_with("```") {
        let mut lines = trimmed.lines().collect::<Vec<_>>();
        if lines.len() >= 2 {
            lines.remove(0);
            if lines
                .last()
                .map(|line| line.trim_start().starts_with("```"))
                == Some(true)
            {
                lines.pop();
            }
            candidates.push(lines.join("\n").trim().to_string());
        }
    }

    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if end > start {
            candidates.push(trimmed[start..=end].to_string());
        }
    }
    if let (Some(start), Some(end)) = (trimmed.find('['), trimmed.rfind(']')) {
        if end > start {
            candidates.push(trimmed[start..=end].to_string());
        }
    }

    for candidate in candidates {
        if candidate.trim().is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<T>(&candidate) {
            return Some(parsed);
        }
    }

    None
}

fn normalize_list(items: Vec<String>, max_items: usize) -> Vec<String> {
    items
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .take(max_items)
        .collect()
}

fn normalize_meeting_summary(summary: MeetingSummaryResult) -> MeetingSummaryResult {
    MeetingSummaryResult {
        summary: summary.summary.trim().to_string(),
        key_points: normalize_list(summary.key_points, 8),
        decisions: normalize_list(summary.decisions, 8),
        risks: normalize_list(summary.risks, 8),
        follow_ups: normalize_list(summary.follow_ups, 8),
    }
}

fn normalize_generated_tasks(tasks: Vec<MeetingGeneratedTask>) -> Vec<MeetingGeneratedTask> {
    let mut seen_titles = HashSet::new();
    tasks
        .into_iter()
        .map(|task| {
            let title = task.title.trim().to_string();
            let notes = task.notes.trim().to_string();
            let priority = task.priority.clamp(1, 4);
            let due_hint = task
                .due_hint
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            let tags = task
                .tags
                .into_iter()
                .map(|tag| tag.trim().to_lowercase())
                .filter(|tag| !tag.is_empty())
                .collect::<Vec<_>>();
            MeetingGeneratedTask {
                title,
                notes,
                priority,
                tags,
                due_hint,
            }
        })
        .filter(|task| !task.title.is_empty())
        .filter(|task| seen_titles.insert(task.title.to_lowercase()))
        .take(12)
        .collect()
}

fn normalize_follow_up_draft(draft: MeetingFollowUpDraft) -> MeetingFollowUpDraft {
    MeetingFollowUpDraft {
        subject: draft.subject.trim().to_string(),
        body: draft.body.trim().to_string(),
    }
}

fn fallback_meeting_summary(transcript: &MeetingTranscript) -> MeetingSummaryResult {
    let excerpt = build_meeting_prompt_transcript(transcript, 360);
    let summary = if excerpt.is_empty() {
        "No transcript content available yet.".to_string()
    } else {
        format!("Quick summary: {}", excerpt)
    };
    let key_points = transcript
        .segments
        .iter()
        .map(|segment| segment.text.trim().to_string())
        .filter(|text| !text.is_empty())
        .take(5)
        .collect::<Vec<_>>();

    MeetingSummaryResult {
        summary,
        key_points,
        decisions: Vec::new(),
        risks: Vec::new(),
        follow_ups: Vec::new(),
    }
}

fn fallback_meeting_tasks(transcript: &MeetingTranscript) -> Vec<MeetingGeneratedTask> {
    let mut tasks = Vec::new();
    for segment in &transcript.segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let lower = text.to_lowercase();
        if lower.contains("follow up")
            || lower.contains("next step")
            || lower.contains("action item")
            || lower.contains("need to")
            || lower.contains("should")
            || lower.contains("please")
        {
            tasks.push(MeetingGeneratedTask {
                title: text.to_string(),
                notes: "Extracted from meeting transcript.".to_string(),
                priority: 3,
                tags: vec!["meeting".to_string()],
                due_hint: None,
            });
        }
        if tasks.len() >= 8 {
            break;
        }
    }

    if tasks.is_empty() {
        tasks.push(MeetingGeneratedTask {
            title: "Review meeting transcript and capture follow-ups".to_string(),
            notes: "Generated fallback task because no explicit action items were detected."
                .to_string(),
            priority: 3,
            tags: vec!["meeting".to_string()],
            due_hint: None,
        });
    }

    normalize_generated_tasks(tasks)
}

fn fallback_follow_up_draft(transcript: &MeetingTranscript) -> MeetingFollowUpDraft {
    let summary = build_meeting_prompt_transcript(transcript, 480);
    let body = if summary.is_empty() {
        "Hi everyone,\n\nThanks for joining today. Sharing a quick follow-up from our meeting.\n\nPlease reply with any corrections or missing items.\n\nBest,\n"
            .to_string()
    } else {
        format!(
            "Hi everyone,\n\nThanks for joining today. Here's a quick recap:\n\n{}\n\nPlease reply with any corrections or missing items.\n\nBest,\n",
            summary
        )
    };

    MeetingFollowUpDraft {
        subject: "Meeting follow-up".to_string(),
        body,
    }
}

fn default_meeting_name(started_at: i64) -> String {
    let dt: DateTime<Local> = DateTime::<Utc>::from_timestamp(started_at, 0)
        .unwrap_or_else(Utc::now)
        .with_timezone(&Local);
    format!("Meeting · {}", dt.format("%b %-d, %H:%M"))
}

fn deleted_meeting_purge_at(deleted_at: i64) -> i64 {
    deleted_at.saturating_add(MEETING_SOFT_DELETE_RETENTION_SECONDS)
}

fn clean_meeting_title(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut candidate = if trimmed.starts_with('{') {
        serde_json::from_str::<serde_json::Value>(trimmed)
            .ok()
            .and_then(|value| {
                value
                    .get("title")
                    .and_then(|entry| entry.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| trimmed.to_string())
    } else {
        trimmed.to_string()
    };

    candidate = candidate
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
        .trim()
        .to_string();
    if candidate.starts_with("```") {
        let stripped = candidate
            .trim_matches('`')
            .lines()
            .last()
            .map(str::trim)
            .unwrap_or_default();
        candidate = stripped.to_string();
    }

    loop {
        let lower = candidate.to_lowercase();
        let mut stripped = false;
        for prefix in [
            "title:",
            "meeting title:",
            "transcript snippet:",
            "snippet:",
            "response:",
            "output:",
        ] {
            if lower.starts_with(prefix) {
                candidate = candidate[prefix.len()..].trim().to_string();
                stripped = true;
                break;
            }
        }
        if !stripped {
            break;
        }
    }

    let normalized = candidate
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = normalized
        .trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace())
        .to_string();

    let min_chars = 6usize;
    let max_chars = 60usize;
    if normalized.chars().count() < min_chars {
        return String::new();
    }

    if normalized.chars().count() <= max_chars {
        return normalized;
    }

    let mut truncated = normalized.chars().take(max_chars).collect::<String>();
    if let Some(last_space) = truncated.rfind(' ') {
        if last_space >= min_chars {
            truncated.truncate(last_space);
        }
    }
    let truncated = truncated
        .trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace())
        .to_string();
    if truncated.chars().count() < min_chars {
        String::new()
    } else {
        truncated
    }
}

struct MixResult {
    duration_seconds: f64,
    snippet: Vec<f32>,
}

struct EchoReductionResult {
    cleaned_mic: Vec<f32>,
    aligned_system: Vec<f32>,
    system_gain: f32,
}

fn mix_and_encode_meeting(
    mic: &RecordingOutput,
    system: Option<&RecordingOutput>,
    output_path: &Path,
) -> Result<MixResult, String> {
    let (mic_samples, mic_rate) = read_wav_to_f32(&mic.path)?;

    let (system_samples, system_rate) = if let Some(system) = system {
        let (samples, rate) = read_wav_to_f32(&system.path)?;
        (Some(samples), Some(rate))
    } else {
        (None, None)
    };

    let mic_resampled = resample_audio(&mic_samples, mic_rate, MEETING_TARGET_SAMPLE_RATE);
    let system_resampled = system_samples.as_ref().map(|samples| {
        resample_audio(
            samples,
            system_rate.unwrap_or(MEETING_TARGET_SAMPLE_RATE),
            MEETING_TARGET_SAMPLE_RATE,
        )
    });

    let echo = reduce_echo(
        &mic_resampled,
        system_resampled.as_deref(),
        MEETING_TARGET_SAMPLE_RATE,
    );
    let mixed = mix_samples(&echo.cleaned_mic, &echo.aligned_system, echo.system_gain);
    let duration_seconds = mixed.len() as f64 / MEETING_TARGET_SAMPLE_RATE as f64;

    let snippet_len = (MEETING_TARGET_SAMPLE_RATE as f32 * NAME_SNIPPET_SECONDS) as usize;
    let snippet = mixed
        .iter()
        .take(snippet_len.min(mixed.len()))
        .copied()
        .collect::<Vec<f32>>();

    encode_mp3_mono(output_path, &mixed, MEETING_TARGET_SAMPLE_RATE)?;

    // Cleanup temp wav files
    let _ = fs::remove_file(&mic.path);
    if let Some(system) = system {
        let _ = fs::remove_file(&system.path);
    }

    Ok(MixResult {
        duration_seconds,
        snippet,
    })
}

fn mix_and_encode_meeting_from_paths(
    mic_path: PathBuf,
    system_path: Option<PathBuf>,
    output_path: PathBuf,
) -> Result<MixResult, String> {
    let mic = RecordingOutput { path: mic_path };
    let system = system_path.map(|path| RecordingOutput { path });
    mix_and_encode_meeting(&mic, system.as_ref(), &output_path)
}

fn estimate_wav_duration_seconds(path: &Path) -> Option<f64> {
    let reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return None;
    }
    let samples = reader.duration() as f64;
    let channels = spec.channels as f64;
    Some(samples / channels / spec.sample_rate as f64)
}

fn transcribe_meeting_audio(
    app_handle: &AppHandle,
    path: &Path,
) -> Result<MeetingTranscript, String> {
    let (samples, sample_rate) = decode_audio_file_to_f32(path)?;
    let resampled = resample_audio(&samples, sample_rate, TRANSCRIPTION_SAMPLE_RATE);
    drop(samples);

    if resampled.is_empty() || chunk_rms(&resampled) < MEETING_TRANSCRIPT_SILENCE_RMS {
        return Ok(MeetingTranscript {
            text: String::new(),
            segments: Vec::new(),
        });
    }

    let manager = app_handle.state::<Arc<TranscriptionManager>>();
    manager.initiate_model_load();

    // Chunk long recordings to avoid extremely large tensor allocations (especially for
    // Parakeet, which runs inference via ONNX Runtime).
    let chunk_samples =
        (MEETING_TRANSCRIPT_CHUNK_SECONDS * TRANSCRIPTION_SAMPLE_RATE as f32) as usize;
    let min_chunk_samples =
        (MEETING_TRANSCRIPT_MIN_CHUNK_SECONDS * TRANSCRIPTION_SAMPLE_RATE as f32) as usize;
    let total_duration_seconds = resampled.len() as f32 / TRANSCRIPTION_SAMPLE_RATE as f32;

    let mut segments: Vec<MeetingTranscriptSegment> = Vec::new();

    fn append_result(
        result: transcribe_rs::TranscriptionResult,
        base_offset_seconds: f32,
        chunk_duration_seconds: f32,
        total_duration_seconds: f32,
        segments_out: &mut Vec<MeetingTranscriptSegment>,
    ) {
        let mut appended = result
            .segments
            .unwrap_or_default()
            .into_iter()
            .map(|segment| {
                let text = segment.text.trim().to_string();
                let start =
                    (base_offset_seconds + segment.start.max(0.0)).min(total_duration_seconds);
                let end = (base_offset_seconds + segment.end.max(segment.start))
                    .min(total_duration_seconds)
                    .max(start);
                MeetingTranscriptSegment {
                    start,
                    end,
                    text,
                    speaker_id: None,
                }
            })
            .filter(|segment| !segment.text.is_empty())
            .collect::<Vec<_>>();

        if appended.is_empty() {
            let fallback_text = result.text.trim();
            if !fallback_text.is_empty() {
                appended.push(MeetingTranscriptSegment {
                    start: base_offset_seconds,
                    end: (base_offset_seconds + chunk_duration_seconds).min(total_duration_seconds),
                    text: fallback_text.to_string(),
                    speaker_id: None,
                });
            }
        }

        segments_out.extend(appended);
    }

    fn transcribe_with_split(
        manager: &Arc<TranscriptionManager>,
        samples: &[f32],
        base_offset_seconds: f32,
        total_duration_seconds: f32,
        depth: usize,
        segments_out: &mut Vec<MeetingTranscriptSegment>,
    ) -> Result<(), String> {
        if samples.is_empty() {
            return Ok(());
        }

        let duration_seconds = samples.len() as f32 / TRANSCRIPTION_SAMPLE_RATE as f32;

        match manager.transcribe_with_segments(samples.to_vec()) {
            Ok(result) => {
                append_result(
                    result,
                    base_offset_seconds,
                    duration_seconds,
                    total_duration_seconds,
                    segments_out,
                );
                Ok(())
            }
            Err(err) => {
                if chunk_rms(samples) < MEETING_TRANSCRIPT_SILENCE_RMS {
                    return Ok(());
                }

                if depth < MEETING_TRANSCRIPT_SPLIT_MAX_DEPTH
                    && duration_seconds >= MEETING_TRANSCRIPT_SPLIT_MIN_SECONDS
                    && samples.len() >= 2
                {
                    let mid = samples.len() / 2;
                    let left = &samples[..mid];
                    let right = &samples[mid..];
                    let right_offset_seconds =
                        base_offset_seconds + mid as f32 / TRANSCRIPTION_SAMPLE_RATE as f32;
                    transcribe_with_split(
                        manager,
                        left,
                        base_offset_seconds,
                        total_duration_seconds,
                        depth + 1,
                        segments_out,
                    )?;
                    transcribe_with_split(
                        manager,
                        right,
                        right_offset_seconds,
                        total_duration_seconds,
                        depth + 1,
                        segments_out,
                    )?;
                    return Ok(());
                }

                // Retry once after reloading the model to recover from transient ORT failures.
                warn!(
                    "Meeting transcription failed at {:.1}-{:.1}s (attempt 1): {}. Reloading model and retrying.",
                    base_offset_seconds,
                    (base_offset_seconds + duration_seconds).min(total_duration_seconds),
                    err
                );
                if let Err(unload_err) = manager.unload_model() {
                    warn!("Failed to unload model for retry: {}", unload_err);
                }
                manager.initiate_model_load();

                let retry_result =
                    manager
                        .transcribe_with_segments(samples.to_vec())
                        .map_err(|retry_err| {
                            format!(
                                "Meeting transcription failed at {:.1}-{:.1}s: {}",
                                base_offset_seconds,
                                (base_offset_seconds + duration_seconds)
                                    .min(total_duration_seconds),
                                retry_err
                            )
                        })?;

                append_result(
                    retry_result,
                    base_offset_seconds,
                    duration_seconds,
                    total_duration_seconds,
                    segments_out,
                );
                Ok(())
            }
        }
    }

    let mut offset_samples = 0usize;
    while offset_samples < resampled.len() {
        let end_samples = (offset_samples + chunk_samples).min(resampled.len());
        let slice = &resampled[offset_samples..end_samples];
        let mut chunk = slice.to_vec();

        // Tiny trailing chunks can cause some models to error; pad with silence for stability.
        if chunk.len() < min_chunk_samples {
            chunk.resize(min_chunk_samples, 0.0);
        }

        let chunk_start_seconds = offset_samples as f32 / TRANSCRIPTION_SAMPLE_RATE as f32;
        transcribe_with_split(
            manager.inner(),
            &chunk,
            chunk_start_seconds,
            total_duration_seconds,
            0,
            &mut segments,
        )?;

        offset_samples = end_samples;
    }

    let text = segments
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(MeetingTranscript { text, segments })
}

fn run_senko_diarization_pipeline(
    app_handle: &AppHandle,
    audio_path: &Path,
    tmp_dir: &Path,
) -> Result<Vec<SenkoDiarizationSegment>, String> {
    let (repo_root, script_path) = resolve_senko_diarization_script(app_handle)
        .ok_or_else(|| "Unable to locate Senko diarization script".to_string())?;
    let python_bin = resolve_senko_python_bin(&repo_root);
    let temp_wav = tmp_dir.join(format!("diarization-{}.wav", Uuid::new_v4()));
    let (samples, sample_rate) = decode_audio_file_to_f32(audio_path)?;
    let resampled = resample_audio(&samples, sample_rate, DIARIZATION_SAMPLE_RATE);
    if resampled.is_empty() {
        return Err("Audio file is empty".to_string());
    }
    write_mono_pcm16_wav(&temp_wav, &resampled, DIARIZATION_SAMPLE_RATE)?;

    let output = Command::new(&python_bin)
        .arg(&script_path)
        .arg("--input")
        .arg(&temp_wav)
        .arg("--device")
        .arg("auto")
        .arg("--quiet")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONNOUSERSITE", "1")
        .current_dir(&repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run Senko diarization script: {e}"))?;

    let _ = fs::remove_file(&temp_wav);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "Senko diarization command failed. Ensure Senko is installed (scripts/install-senko.sh). {}",
            detail
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed: SenkoDiarizationOutput = serde_json::from_str(&stdout).map_err(|e| {
        format!(
            "Failed to parse Senko diarization output as JSON: {} (output: {})",
            e, stdout
        )
    })?;

    Ok(parsed
        .merged_segments
        .into_iter()
        .filter_map(|segment| {
            if segment.speaker.trim().is_empty() {
                return None;
            }
            let start = segment.start.max(0.0);
            let end = segment.end.max(start);
            if end - start <= 0.01 {
                return None;
            }
            Some(SenkoDiarizationSegment {
                start,
                end,
                speaker: segment.speaker,
            })
        })
        .collect())
}

fn resolve_senko_diarization_script(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        roots.push(current_dir.clone());
        if let Some(parent) = current_dir.parent() {
            roots.push(parent.to_path_buf());
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    roots.push(manifest_dir.clone());
    if let Some(parent) = manifest_dir.parent() {
        roots.push(parent.to_path_buf());
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.clone());
        if let Some(parent) = resource_dir.parent() {
            roots.push(parent.to_path_buf());
        }
    }

    for root in roots {
        for script in [
            root.join("scripts").join(DIARIZATION_SCRIPT_NAME),
            root.join("resources")
                .join("scripts")
                .join(DIARIZATION_SCRIPT_NAME),
        ] {
            if script.is_file() {
                return Some((root, script));
            }
        }
    }

    None
}

fn resolve_senko_python_bin(repo_root: &Path) -> String {
    if let Ok(explicit) = std::env::var("BREEZE_SENKO_PYTHON") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    #[cfg(target_os = "windows")]
    {
        let candidates = [
            repo_root
                .join(".venv-senko")
                .join("Scripts")
                .join("python.exe"),
            repo_root
                .join("resources")
                .join("senko")
                .join(".venv-senko")
                .join("Scripts")
                .join("python.exe"),
            repo_root
                .join("resources")
                .join(".venv-senko")
                .join("Scripts")
                .join("python.exe"),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
        "python".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let candidates = [
            repo_root.join(".venv-senko").join("bin").join("python"),
            repo_root
                .join("resources")
                .join("senko")
                .join(".venv-senko")
                .join("bin")
                .join("python"),
            repo_root
                .join("resources")
                .join(".venv-senko")
                .join("bin")
                .join("python"),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
        if let Some(candidate) = resolve_bundled_senko_python_bin(repo_root) {
            return candidate.to_string_lossy().to_string();
        }
        DIARIZATION_PYTHON_DEFAULT.to_string()
    }
}

#[cfg(not(target_os = "windows"))]
fn resolve_bundled_senko_python_bin(repo_root: &Path) -> Option<PathBuf> {
    let python_root = repo_root.join("resources").join("senko").join("python");
    let entries = fs::read_dir(python_root).ok()?;
    for entry in entries.filter_map(Result::ok) {
        let root = entry.path();
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("cpython-") {
            continue;
        }
        for bin_name in ["python3.10", "python3", "python"] {
            let candidate = root.join("bin").join(bin_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn write_mono_pcm16_wav(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}

fn align_transcript_segments_with_diarization(
    transcript: &mut MeetingTranscript,
    diarization_segments: &[SenkoDiarizationSegment],
) {
    if diarization_segments.is_empty() {
        return;
    }

    for segment in &mut transcript.segments {
        let start = segment.start.max(0.0);
        let end = segment.end.max(start);
        let mut overlap_by_speaker: HashMap<String, f32> = HashMap::new();

        for diar in diarization_segments {
            let overlap = overlap_duration_seconds(start, end, diar.start, diar.end);
            if overlap <= DIARIZATION_COLLAR_SECONDS {
                continue;
            }
            *overlap_by_speaker
                .entry(diar.speaker.clone())
                .or_insert(0.0) += overlap;
        }

        if let Some((speaker, _)) = overlap_by_speaker
            .into_iter()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        {
            segment.speaker_id = Some(speaker);
            continue;
        }

        let center = (start + end) * 0.5;
        if let Some(closest) = diarization_segments.iter().min_by(|left, right| {
            let left_center = (left.start + left.end) * 0.5;
            let right_center = (right.start + right.end) * 0.5;
            let left_dist = (left_center - center).abs();
            let right_dist = (right_center - center).abs();
            left_dist
                .partial_cmp(&right_dist)
                .unwrap_or(std::cmp::Ordering::Equal)
        }) {
            segment.speaker_id = Some(closest.speaker.clone());
        }
    }
}

fn overlap_duration_seconds(
    left_start: f32,
    left_end: f32,
    right_start: f32,
    right_end: f32,
) -> f32 {
    let start = left_start.max(right_start);
    let end = left_end.min(right_end);
    (end - start).max(0.0)
}

fn ordered_unique_speaker_ids(transcript: &MeetingTranscript) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ordered = Vec::new();
    for segment in &transcript.segments {
        let Some(raw) = segment.speaker_id.as_ref() else {
            continue;
        };
        if seen.insert(raw.clone()) {
            ordered.push(raw.clone());
        }
    }
    ordered
}

fn transcript_has_any_speaker_assignments(transcript: &MeetingTranscript) -> bool {
    transcript.segments.iter().any(|segment| {
        segment
            .speaker_id
            .as_ref()
            .is_some_and(|raw| !raw.trim().is_empty())
    })
}

fn transcript_has_spoken_segments(transcript: &MeetingTranscript) -> bool {
    transcript
        .segments
        .iter()
        .any(|segment| !segment.text.trim().is_empty())
}

fn is_stale_running_diarization_status(status: &MeetingDiarizationStatus, now: i64) -> bool {
    if status.status != DIARIZATION_STATUS_RUNNING {
        return false;
    }
    let Some(started_at) = status.started_at else {
        return false;
    };
    if started_at <= 0 || now <= started_at {
        return false;
    }
    let estimate_seconds = status.estimated_seconds.unwrap_or(60).clamp(10, 600);
    let timeout_seconds = (estimate_seconds * DIARIZATION_STALE_RUNNING_MULTIPLIER)
        .max(DIARIZATION_STALE_RUNNING_FLOOR_SECONDS);
    now.saturating_sub(started_at) > timeout_seconds
}

fn decode_audio_file_to_f32(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let file = fs::File::open(path).map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            MEETING_AUDIO_UNAVAILABLE_MESSAGE.to_string()
        } else {
            e.to_string()
        }
    })?;
    let decoder = Decoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels() as usize;
    let samples = decoder.collect::<Vec<f32>>();
    let mono = if channels > 1 {
        interleaved_to_mono_samples(&samples, channels)
    } else {
        samples
    };

    Ok((mono, sample_rate))
}

#[cfg(target_os = "macos")]
fn is_screen_capture_permission_error(error: &str) -> bool {
    let normalized = error.to_lowercase();
    normalized.contains("declined tcc")
        || normalized.contains("content unavailable")
        || normalized.contains("screen recording")
}

#[cfg(not(target_os = "macos"))]
fn is_screen_capture_permission_error(_error: &str) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn open_screen_recording_settings() {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .status();
}

#[cfg(not(target_os = "macos"))]
fn open_screen_recording_settings() {}

fn interleaved_to_mono_samples(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let mut mono = Vec::with_capacity(samples.len() / channels.max(1));
    for frame in samples.chunks_exact(channels) {
        let sum: f32 = frame.iter().sum();
        mono.push(sum / channels as f32);
    }
    mono
}

fn resample_audio(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate {
        return samples.to_vec();
    }

    let mut resampler = crate::audio_toolkit::audio::FrameResampler::new(
        from_rate as usize,
        to_rate as usize,
        Duration::from_millis(20),
    );
    let mut output = Vec::new();
    resampler.push(samples, |frame| output.extend_from_slice(frame));
    resampler.finish(|frame| output.extend_from_slice(frame));
    output
}

fn reduce_echo(mic: &[f32], system: Option<&[f32]>, sample_rate: u32) -> EchoReductionResult {
    let system = match system {
        Some(system) if !system.is_empty() => system,
        _ => {
            return EchoReductionResult {
                cleaned_mic: mic.to_vec(),
                aligned_system: vec![0.0; mic.len()],
                system_gain: 1.0,
            }
        }
    };

    let delay = estimate_delay_samples(mic, system, sample_rate);
    let aligned_system = align_system_to_mic(system, delay, mic.len());

    let frame_size = ((sample_rate as f32) * 0.02) as usize;
    let frame_size = frame_size.max(120);
    let mut cleaned = Vec::with_capacity(mic.len());
    let mut alpha = 0.0f32;
    let alpha_smoothing = 0.8f32;
    let eps = 1e-8f32;
    let max_alpha = 0.65f32;
    let energy_floor = 1e-6f32;

    let mut index = 0;
    while index < mic.len() {
        let end = (index + frame_size).min(mic.len());
        let mic_frame = &mic[index..end];
        let sys_frame = &aligned_system[index..end];

        let mut dot_ms = 0.0f32;
        let mut energy_m = 0.0f32;
        let mut energy_s = 0.0f32;
        for (m, s) in mic_frame.iter().zip(sys_frame.iter()) {
            dot_ms += m * s;
            energy_m += m * m;
            energy_s += s * s;
        }

        let mut target = 0.0f32;
        if energy_s > energy_floor {
            let gain = dot_ms / (energy_s + eps);
            target = gain.clamp(0.0, max_alpha);
        }

        alpha = alpha * alpha_smoothing + target * (1.0 - alpha_smoothing);

        let duck_mic =
            energy_s > energy_floor && energy_m > energy_floor && energy_s > energy_m * 4.0;
        let duck_gain = if duck_mic { 0.6 } else { 1.0 };

        for (m, s) in mic_frame.iter().zip(sys_frame.iter()) {
            cleaned.push((m - alpha * s) * duck_gain);
        }

        index = end;
    }

    let system_gain = estimate_system_gain(&cleaned, &aligned_system, sample_rate);

    EchoReductionResult {
        cleaned_mic: cleaned,
        aligned_system,
        system_gain,
    }
}

fn estimate_delay_samples(mic: &[f32], system: &[f32], sample_rate: u32) -> i32 {
    if mic.is_empty() || system.is_empty() {
        return 0;
    }

    let max_delay_ms = 500.0f32;
    let max_delay_samples = (sample_rate as f32 * max_delay_ms / 1000.0) as i32;
    let downsample = 4usize;
    let segment_len = (sample_rate as usize * 2).min(mic.len().min(system.len()));
    if segment_len < downsample * 8 {
        return 0;
    }

    let step = (sample_rate as usize).min(segment_len);
    let mut best_start = 0usize;
    let mut best_energy = 0.0f32;
    let max_start = mic.len().min(system.len()).saturating_sub(segment_len);
    let mut start = 0usize;
    while start <= max_start {
        let end = start + segment_len;
        let energy = system[start..end].iter().map(|s| s * s).sum::<f32>();
        if energy > best_energy {
            best_energy = energy;
            best_start = start;
        }
        if step == 0 {
            break;
        }
        start = start.saturating_add(step);
        if start > max_start {
            break;
        }
    }

    let mic_seg = &mic[best_start..best_start + segment_len];
    let sys_seg = &system[best_start..best_start + segment_len];

    let mic_ds = downsample_slice(mic_seg, downsample);
    let sys_ds = downsample_slice(sys_seg, downsample);
    if mic_ds.is_empty() || sys_ds.is_empty() {
        return 0;
    }

    let max_lag = (max_delay_samples / downsample as i32).max(0);
    let mut best_corr = 0.0f32;
    let mut best_lag = 0i32;
    let eps = 1e-8f32;

    for lag in -max_lag..=max_lag {
        let mut dot = 0.0f32;
        let mut energy_m = 0.0f32;
        let mut energy_s = 0.0f32;

        for i in 0..mic_ds.len() {
            let sys_index = i as i32 - lag;
            if sys_index < 0 || sys_index >= sys_ds.len() as i32 {
                continue;
            }
            let m = mic_ds[i];
            let s = sys_ds[sys_index as usize];
            dot += m * s;
            energy_m += m * m;
            energy_s += s * s;
        }

        if energy_s <= 1e-6f32 || energy_m <= 1e-6f32 {
            continue;
        }

        let corr = dot / ((energy_m * energy_s).sqrt() + eps);
        if corr > best_corr {
            best_corr = corr;
            best_lag = lag;
        }
    }

    if best_corr < 0.1 {
        return 0;
    }

    best_lag * downsample as i32
}

fn downsample_slice(samples: &[f32], factor: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(samples.len() / factor + 1);
    let mut index = 0;
    while index < samples.len() {
        out.push(samples[index]);
        index += factor;
    }
    out
}

fn align_system_to_mic(system: &[f32], delay: i32, target_len: usize) -> Vec<f32> {
    let mut aligned = vec![0.0f32; target_len];
    for i in 0..target_len {
        let sys_index = i as i32 - delay;
        if sys_index >= 0 && sys_index < system.len() as i32 {
            aligned[i] = system[sys_index as usize];
        }
    }
    aligned
}

fn normalize_tag(tag: &str) -> String {
    tag.trim().to_lowercase()
}

fn estimate_system_gain(mic: &[f32], system: &[f32], sample_rate: u32) -> f32 {
    if mic.is_empty() || system.is_empty() {
        return 1.0;
    }

    let frame_size = ((sample_rate as f32) * 0.02) as usize;
    let frame_size = frame_size.max(120);
    let mut ratios = Vec::new();
    let min_rms = 1e-4f32;
    let mut index = 0;

    while index < mic.len() {
        let end = (index + frame_size).min(mic.len());
        let mic_frame = &mic[index..end];
        let sys_frame = &system[index..end];

        let mic_energy = mic_frame.iter().map(|v| v * v).sum::<f32>() / mic_frame.len() as f32;
        let sys_energy = sys_frame.iter().map(|v| v * v).sum::<f32>() / sys_frame.len() as f32;
        let mic_rms = mic_energy.sqrt();
        let sys_rms = sys_energy.sqrt();

        if sys_rms >= min_rms && mic_rms >= min_rms {
            ratios.push(sys_rms / mic_rms);
        }

        index = end;
    }

    if ratios.is_empty() {
        return 1.0;
    }

    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = ratios[ratios.len() / 2];
    if !median.is_finite() || median <= 0.0 {
        return 1.0;
    }

    let target_ratio = 0.9f32;
    let mut gain = target_ratio / median;
    if gain > 1.0 {
        gain = 1.0;
    }
    if gain < 0.25 {
        gain = 0.25;
    }
    gain
}

fn mix_samples(mic: &[f32], system: &[f32], system_gain: f32) -> Vec<f32> {
    let len = system.len().max(mic.len());
    let mut mixed = Vec::with_capacity(len);

    for i in 0..len {
        let mic_sample = mic.get(i).copied().unwrap_or(0.0);
        let system_sample = system.get(i).copied().unwrap_or(0.0) * system_gain;
        mixed.push(mic_sample + system_sample);
    }

    let mut max = 0.0f32;
    for sample in &mixed {
        max = max.max(sample.abs());
    }

    if max > 1.0 {
        let scale = 1.0 / max;
        for sample in &mut mixed {
            *sample *= scale;
        }
    }

    mixed
}

fn read_wav_to_f32(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;

    let samples = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .filter_map(Result::ok)
            .collect::<Vec<f32>>(),
        hound::SampleFormat::Int => {
            let max = i16::MAX as f32;
            reader
                .samples::<i16>()
                .filter_map(Result::ok)
                .map(|s| s as f32 / max)
                .collect::<Vec<f32>>()
        }
    };

    Ok((samples, sample_rate))
}

fn encode_mp3_mono(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    use mp3lame_encoder::{
        max_required_buffer_size, Bitrate, Builder, FlushNoGap, MonoPcm, Quality,
    };
    use std::fs::File;
    use std::io::Write;

    let mut builder = Builder::new().ok_or("Failed to initialize MP3 encoder".to_string())?;
    builder.set_num_channels(1).map_err(|e| e.to_string())?;
    builder
        .set_sample_rate(sample_rate)
        .map_err(|e| e.to_string())?;
    builder
        .set_brate(Bitrate::Kbps64)
        .map_err(|e| e.to_string())?;
    builder
        .set_quality(Quality::Good)
        .map_err(|e| e.to_string())?;

    let mut encoder = builder.build().map_err(|e| e.to_string())?;
    let mut file = File::create(path).map_err(|e| e.to_string())?;

    let chunk_size = 4096;
    for chunk in samples.chunks(chunk_size) {
        let mut buffer = Vec::with_capacity(max_required_buffer_size(chunk.len()));
        let encoded = encoder
            .encode(MonoPcm(chunk), buffer.spare_capacity_mut())
            .map_err(|e| e.to_string())?;
        unsafe {
            buffer.set_len(encoded);
        }
        file.write_all(&buffer).map_err(|e| e.to_string())?;
    }

    let mut flush_buffer = Vec::with_capacity(max_required_buffer_size(0));
    let encoded = encoder
        .flush::<FlushNoGap>(flush_buffer.spare_capacity_mut())
        .map_err(|e| e.to_string())?;
    unsafe {
        flush_buffer.set_len(encoded);
    }
    file.write_all(&flush_buffer).map_err(|e| e.to_string())?;
    Ok(())
}

struct MicRecording {
    stop_tx: mpsc::Sender<()>,
    join: thread::JoinHandle<Result<RecordingOutput, String>>,
}

impl MicRecording {
    fn start(
        app_handle: &AppHandle,
        path: PathBuf,
        live_chunk_tx: Option<mpsc::Sender<LiveAudioChunk>>,
    ) -> Result<Self, String> {
        let device = select_microphone_device(app_handle)
            .or_else(|| get_cpal_host().default_input_device())
            .ok_or_else(|| "No microphone device available".to_string())?;

        let config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get microphone config: {e}"))?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;

        let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        let join = thread::spawn(move || {
            let mut ready_sent = false;
            let result = (|| -> Result<RecordingOutput, String> {
                let spec = hound::WavSpec {
                    channels: 1,
                    sample_rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let mut writer = hound::WavWriter::create(&path, spec)
                    .map_err(|e| format!("Failed to create WAV: {e}"))?;

                let mut stopping = false;

                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => {
                        build_cpal_stream::<f32>(&device, &config, sample_tx, channels)?
                    }
                    cpal::SampleFormat::I16 => {
                        build_cpal_stream::<i16>(&device, &config, sample_tx, channels)?
                    }
                    cpal::SampleFormat::U16 => {
                        build_cpal_stream::<u16>(&device, &config, sample_tx, channels)?
                    }
                    cpal::SampleFormat::I8 => {
                        build_cpal_stream::<i8>(&device, &config, sample_tx, channels)?
                    }
                    cpal::SampleFormat::U8 => {
                        build_cpal_stream::<u8>(&device, &config, sample_tx, channels)?
                    }
                    cpal::SampleFormat::I32 => {
                        build_cpal_stream::<i32>(&device, &config, sample_tx, channels)?
                    }
                    cpal::SampleFormat::U32 => {
                        build_cpal_stream::<u32>(&device, &config, sample_tx, channels)?
                    }
                    _ => return Err("Unsupported microphone sample format".to_string()),
                };

                stream
                    .play()
                    .map_err(|e| format!("Failed to start microphone stream: {e}"))?;
                let _ = ready_tx.send(Ok(()));
                ready_sent = true;

                loop {
                    if !stopping {
                        if stop_rx.try_recv().is_ok() {
                            stopping = true;
                            let _ = stream.pause();
                        }
                    }

                    match sample_rx.recv_timeout(Duration::from_millis(50)) {
                        Ok(chunk) => {
                            if let Some(tx) = live_chunk_tx.as_ref() {
                                let _ = tx.send(LiveAudioChunk {
                                    source: LiveAudioSource::Mic,
                                    sample_rate,
                                    samples: chunk.clone(),
                                });
                            }
                            for sample in &chunk {
                                let clamped = sample.clamp(-1.0, 1.0);
                                let sample_i16 = (clamped * i16::MAX as f32) as i16;
                                writer
                                    .write_sample(sample_i16)
                                    .map_err(|e| format!("Failed to write WAV: {e}"))?;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if stopping {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }

                writer
                    .finalize()
                    .map_err(|e| format!("Failed to finalize WAV: {e}"))?;

                Ok(RecordingOutput { path })
            })();

            if let Err(ref err) = result {
                if !ready_sent {
                    let _ = ready_tx.send(Err(err.clone()));
                }
            }

            result
        });

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self { stop_tx, join }),
            Ok(Err(err)) => {
                let _ = stop_tx.send(());
                let _ = join.join();
                Err(err)
            }
            Err(_) => {
                let _ = stop_tx.send(());
                let _ = join.join();
                Err("Microphone recording failed to start".to_string())
            }
        }
    }

    fn stop(self) -> Result<RecordingOutput, String> {
        let _ = self.stop_tx.send(());
        Ok(self
            .join
            .join()
            .map_err(|_| "Microphone recording thread panicked".to_string())??)
    }
}

fn select_microphone_device(app_handle: &AppHandle) -> Option<cpal::Device> {
    let settings = get_settings(app_handle);
    let use_clamshell =
        clamshell::is_clamshell().unwrap_or(false) && settings.clamshell_microphone.is_some();

    let device_name = if use_clamshell {
        settings.clamshell_microphone.clone()
    } else {
        settings.selected_microphone.clone()
    }
    .or_else(crate::audio_toolkit::preferred_macos_default_input_device_name)?;

    crate::audio_toolkit::list_input_devices()
        .ok()?
        .into_iter()
        .find(|device| device.name == device_name)
        .map(|device| device.device)
}

fn build_cpal_stream<T>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    sample_tx: mpsc::Sender<Vec<f32>>,
    channels: usize,
) -> Result<cpal::Stream, String>
where
    T: cpal::Sample + cpal::SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let mut output_buffer = Vec::new();

    let stream_cb = move |data: &[T], _: &cpal::InputCallbackInfo| {
        output_buffer.clear();

        if channels == 1 {
            output_buffer.extend(data.iter().map(|&sample| sample.to_sample::<f32>()));
        } else {
            let frame_count = data.len() / channels;
            output_buffer.reserve(frame_count);
            for frame in data.chunks_exact(channels) {
                let mono_sample = frame
                    .iter()
                    .map(|&sample| sample.to_sample::<f32>())
                    .sum::<f32>()
                    / channels as f32;
                output_buffer.push(mono_sample);
            }
        }

        let _ = sample_tx.send(output_buffer.clone());
    };

    device
        .build_input_stream(
            &config.clone().into(),
            stream_cb,
            |err| log::error!("Microphone stream error: {}", err),
            None,
        )
        .map_err(|e| format!("Failed to build microphone stream: {e}"))
}

#[cfg(target_os = "macos")]
struct SystemRecording {
    stop_tx: mpsc::Sender<()>,
    join: thread::JoinHandle<Result<RecordingOutput, String>>,
}

#[cfg(target_os = "macos")]
fn start_system_audio_recording(
    _app_handle: &AppHandle,
    path: PathBuf,
    live_chunk_tx: Option<mpsc::Sender<LiveAudioChunk>>,
) -> Result<SystemRecording, String> {
    use screencapturekit::prelude::*;
    use screencapturekit::stream::configuration::audio::{AudioChannelCount, AudioSampleRate};

    let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    let join = thread::spawn(move || {
        let mut ready_sent = false;
        let result = (|| -> Result<RecordingOutput, String> {
            let content = SCShareableContent::get()
                .map_err(|e| format!("Failed to get shareable content: {e}"))?;
            let displays = content.displays();
            let display = displays
                .first()
                .ok_or_else(|| "No display found for system audio".to_string())?;

            let filter = SCContentFilter::create()
                .with_display(display)
                .with_excluding_windows(&[])
                .build();

            let mut config = SCStreamConfiguration::new();
            config
                .set_captures_audio(true)
                .set_sample_rate(AudioSampleRate::Rate24000)
                .set_channel_count(AudioChannelCount::Mono)
                .set_excludes_current_process_audio(true);

            let mut stream = SCStream::new(&filter, &config);

            let handler_id = stream
                .add_output_handler(
                    move |sample, _| {
                        if let Some(chunk) = cmsample_to_mono(&sample) {
                            let _ = sample_tx.send(chunk);
                        }
                    },
                    SCStreamOutputType::Audio,
                )
                .ok_or_else(|| "Failed to register audio output handler".to_string())?;

            stream
                .start_capture()
                .map_err(|e| format!("Failed to start system audio capture: {e}"))?;
            let _ = ready_tx.send(Ok(()));
            ready_sent = true;

            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: MEETING_TARGET_SAMPLE_RATE,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(&path, spec)
                .map_err(|e| format!("Failed to create system WAV: {e}"))?;

            let mut stopping = false;

            loop {
                if !stopping {
                    if stop_rx.try_recv().is_ok() {
                        stopping = true;
                        let _ = stream.stop_capture();
                        let _ = stream.remove_output_handler(handler_id, SCStreamOutputType::Audio);
                    }
                }

                match sample_rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(chunk) => {
                        if let Some(tx) = live_chunk_tx.as_ref() {
                            let _ = tx.send(LiveAudioChunk {
                                source: LiveAudioSource::System,
                                sample_rate: MEETING_TARGET_SAMPLE_RATE,
                                samples: chunk.clone(),
                            });
                        }
                        for sample in &chunk {
                            let clamped = sample.clamp(-1.0, 1.0);
                            let sample_i16 = (clamped * i16::MAX as f32) as i16;
                            writer
                                .write_sample(sample_i16)
                                .map_err(|e| format!("Failed to write system WAV: {e}"))?;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if stopping {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }

            writer
                .finalize()
                .map_err(|e| format!("Failed to finalize system WAV: {e}"))?;

            Ok(RecordingOutput { path })
        })();

        if let Err(ref err) = result {
            if !ready_sent {
                let _ = ready_tx.send(Err(err.clone()));
            }
        }

        result
    });

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(SystemRecording { stop_tx, join }),
        Ok(Err(err)) => {
            let _ = stop_tx.send(());
            let _ = join.join();
            Err(err)
        }
        Err(_) => {
            let _ = stop_tx.send(());
            let _ = join.join();
            Err("System audio recording failed to start".to_string())
        }
    }
}

#[cfg(target_os = "macos")]
fn cmsample_to_mono(sample: &screencapturekit::cm::CMSampleBuffer) -> Option<Vec<f32>> {
    let _ = sample.make_data_ready();
    let format = sample.format_description()?;
    let channels = format.audio_channel_count().unwrap_or(1) as usize;
    let is_float = format.audio_is_float();
    let bits = format.audio_bits_per_channel().unwrap_or(32);

    let buffer_list = sample.audio_buffer_list()?;
    if buffer_list.num_buffers() == 0 {
        return None;
    }

    if buffer_list.num_buffers() == 1 {
        let buffer = buffer_list.get(0)?;
        let data = buffer.data();
        let mut samples = decode_samples(data, is_float, bits)?;
        if channels > 1 {
            samples = interleaved_to_mono(&samples, channels);
        }
        return Some(samples);
    }

    let mut channel_samples: Vec<Vec<f32>> = Vec::new();
    for buffer in buffer_list.iter() {
        let decoded = decode_samples(buffer.data(), is_float, bits)?;
        channel_samples.push(decoded);
    }
    if channel_samples.is_empty() {
        return None;
    }
    let len = channel_samples[0].len();
    let mut mono = Vec::with_capacity(len);
    for idx in 0..len {
        let mut sum = 0.0f32;
        let mut count = 0.0f32;
        for channel in &channel_samples {
            if let Some(sample) = channel.get(idx) {
                sum += *sample;
                count += 1.0;
            }
        }
        if count > 0.0 {
            mono.push(sum / count);
        }
    }
    Some(mono)
}

#[cfg(target_os = "macos")]
fn decode_samples(data: &[u8], is_float: bool, bits: u32) -> Option<Vec<f32>> {
    if data.is_empty() {
        return Some(Vec::new());
    }
    if is_float && bits == 32 {
        let mut samples = Vec::with_capacity(data.len() / 4);
        for chunk in data.chunks_exact(4) {
            let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            samples.push(value);
        }
        return Some(samples);
    }
    if !is_float && bits == 16 {
        let mut samples = Vec::with_capacity(data.len() / 2);
        for chunk in data.chunks_exact(2) {
            let value = i16::from_le_bytes([chunk[0], chunk[1]]);
            samples.push(value as f32 / i16::MAX as f32);
        }
        return Some(samples);
    }
    None
}

#[cfg(target_os = "macos")]
fn interleaved_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    let mut mono = Vec::with_capacity(samples.len() / channels.max(1));
    for frame in samples.chunks_exact(channels) {
        let sum: f32 = frame.iter().sum();
        mono.push(sum / channels as f32);
    }
    mono
}

#[cfg(target_os = "macos")]
impl SystemRecording {
    fn stop(self) -> Result<RecordingOutput, String> {
        let _ = self.stop_tx.send(());
        Ok(self
            .join
            .join()
            .map_err(|_| "System audio recording thread panicked".to_string())??)
    }
}

#[cfg(target_os = "windows")]
struct SystemRecording {
    stop_tx: mpsc::Sender<()>,
    join: thread::JoinHandle<Result<RecordingOutput, String>>,
}

#[cfg(target_os = "windows")]
fn start_system_audio_recording(
    _app_handle: &AppHandle,
    path: PathBuf,
    live_chunk_tx: Option<mpsc::Sender<LiveAudioChunk>>,
) -> Result<SystemRecording, String> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let join = thread::spawn(move || {
        use wasapi::{
            initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode,
            WaveFormat,
        };

        initialize_mta();
        let mut ready_sent = false;
        let result = (|| -> Result<RecordingOutput, String> {
            let enumerator = DeviceEnumerator::new()
                .map_err(|e| format!("WASAPI device enumerator failed: {e}"))?;
            let device = enumerator
                .get_default_device(&Direction::Render)
                .map_err(|e| format!("Failed to get default render device: {e}"))?;
            let mut audio_client = device
                .get_iaudioclient()
                .map_err(|e| format!("Failed to get IAudioClient: {e}"))?;

            let desired_format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
            let (_def_time, min_time) = audio_client
                .get_device_period()
                .map_err(|e| format!("Failed to get device period: {e}"))?;
            let mode = StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: min_time,
            };

            audio_client
                .initialize_client(&desired_format, &Direction::Render, &mode)
                .map_err(|e| format!("Failed to initialize loopback client: {e}"))?;
            let h_event = audio_client
                .set_get_eventhandle()
                .map_err(|e| format!("Failed to set event handle: {e}"))?;
            let capture_client = audio_client
                .get_audiocaptureclient()
                .map_err(|e| format!("Failed to get capture client: {e}"))?;

            audio_client
                .start_stream()
                .map_err(|e| format!("Failed to start loopback stream: {e}"))?;
            let _ = ready_tx.send(Ok(()));
            ready_sent = true;

            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 48_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(&path, spec)
                .map_err(|e| format!("Failed to create system WAV: {e}"))?;

            let mut stopping = false;
            let block_align = desired_format.get_blockalign() as usize;
            let mut sample_queue: std::collections::VecDeque<u8> =
                std::collections::VecDeque::new();

            loop {
                if !stopping {
                    if stop_rx.try_recv().is_ok() {
                        stopping = true;
                        let _ = audio_client.stop_stream();
                    }
                }

                capture_client
                    .read_from_device_to_deque(&mut sample_queue)
                    .map_err(|e| format!("Loopback capture failed: {e}"))?;

                while sample_queue.len() >= block_align {
                    let mut frame = vec![0u8; block_align];
                    for byte in frame.iter_mut() {
                        *byte = sample_queue.pop_front().unwrap();
                    }
                    let samples = decode_wasapi_frame(&frame, 2);
                    if let Some(tx) = live_chunk_tx.as_ref() {
                        let _ = tx.send(LiveAudioChunk {
                            source: LiveAudioSource::System,
                            sample_rate: 48_000,
                            samples: samples.clone(),
                        });
                    }
                    for sample in &samples {
                        let clamped = sample.clamp(-1.0, 1.0);
                        let sample_i16 = (clamped * i16::MAX as f32) as i16;
                        writer
                            .write_sample(sample_i16)
                            .map_err(|e| format!("Failed to write system WAV: {e}"))?;
                    }
                }

                if h_event.wait_for_event(100_000).is_err() && stopping {
                    break;
                }
                if stopping && sample_queue.is_empty() {
                    break;
                }
            }

            writer
                .finalize()
                .map_err(|e| format!("Failed to finalize system WAV: {e}"))?;

            Ok(RecordingOutput { path })
        })();

        if let Err(ref err) = result {
            if !ready_sent {
                let _ = ready_tx.send(Err(err.clone()));
            }
        }

        result
    });

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(SystemRecording { stop_tx, join }),
        Ok(Err(err)) => {
            let _ = stop_tx.send(());
            let _ = join.join();
            Err(err)
        }
        Err(_) => {
            let _ = stop_tx.send(());
            let _ = join.join();
            Err("System audio recording failed to start".to_string())
        }
    }
}

#[cfg(target_os = "windows")]
fn decode_wasapi_frame(frame: &[u8], channels: usize) -> Vec<f32> {
    let mut samples = Vec::with_capacity(channels);
    for chunk in frame.chunks_exact(4) {
        let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        samples.push(value);
    }
    if channels <= 1 {
        return samples;
    }
    let mut mono = Vec::with_capacity(1);
    let sum: f32 = samples.iter().sum();
    mono.push(sum / channels as f32);
    mono
}

#[cfg(target_os = "windows")]
impl SystemRecording {
    fn stop(self) -> Result<RecordingOutput, String> {
        let _ = self.stop_tx.send(());
        Ok(self
            .join
            .join()
            .map_err(|_| "System audio recording thread panicked".to_string())??)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
struct SystemRecording;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn start_system_audio_recording(
    _app_handle: &AppHandle,
    _path: PathBuf,
    _live_chunk_tx: Option<mpsc::Sender<LiveAudioChunk>>,
) -> Result<SystemRecording, String> {
    Err("System audio recording is only supported on macOS and Windows".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl SystemRecording {
    fn stop(self) -> Result<RecordingOutput, String> {
        Err("System audio recording is not supported".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compute_live_window_start_in_buffer, count_live_prefix_agreement,
        meeting_transcript_cleanup_system_prompt, tokenize_live_segments, MeetingTranscriptSegment,
    };

    fn approx_eq(left: f32, right: f32) -> bool {
        (left - right).abs() < 0.0001
    }

    #[test]
    fn live_window_start_tracks_new_audio_plus_lookback() {
        let start =
            compute_live_window_start_in_buffer(6_000, 5_000, 1_000, 5_000, 900, 700, 3_200);
        assert_eq!(start, 3_100);
    }

    #[test]
    fn live_window_start_clamps_to_buffer_when_history_is_trimmed() {
        let start =
            compute_live_window_start_in_buffer(6_000, 1_000, 4_000, 2_000, 900, 700, 3_200);
        assert_eq!(start, 0);
    }

    #[test]
    fn tokenize_live_segments_spreads_token_timestamps() {
        let tokens = tokenize_live_segments(&[MeetingTranscriptSegment {
            start: 1.0,
            end: 2.0,
            text: "alpha beta gamma".to_string(),
            speaker_id: None,
        }]);

        assert_eq!(tokens.len(), 3);
        assert!(approx_eq(tokens[0].1, 1.0));
        assert!(tokens[0].1 < tokens[0].2);
        assert!(tokens[0].2 <= tokens[1].1);
        assert!(tokens[1].1 < tokens[1].2);
        assert!(tokens[1].2 <= tokens[2].1);
        assert!(tokens[2].1 < tokens[2].2);
        assert!(approx_eq(tokens[2].2, 2.0));
    }

    #[test]
    fn live_prefix_agreement_accepts_stable_fuzzy_tokens() {
        let previous = vec![
            ("transcription".to_string(), 0.0, 0.5),
            ("quality".to_string(), 0.5, 1.0),
            ("matters".to_string(), 1.0, 1.5),
        ];
        let incoming = vec![
            ("Transcription".to_string(), 0.0, 0.5),
            ("quality,".to_string(), 0.5, 1.0),
            ("matter".to_string(), 1.0, 1.5),
            ("here".to_string(), 1.5, 2.0),
        ];

        assert_eq!(count_live_prefix_agreement(&previous, &incoming), 3);
    }

    #[test]
    fn live_prefix_agreement_stops_at_first_unstable_token() {
        let previous = vec![
            ("this".to_string(), 0.0, 0.5),
            ("preview".to_string(), 0.5, 1.0),
            ("breaks".to_string(), 1.0, 1.5),
        ];
        let incoming = vec![
            ("this".to_string(), 0.0, 0.5),
            ("preview".to_string(), 0.5, 1.0),
            ("works".to_string(), 1.0, 1.5),
        ];

        assert_eq!(count_live_prefix_agreement(&previous, &incoming), 2);
    }

    #[test]
    fn meeting_cleanup_system_prompt_respects_filler_setting() {
        assert!(meeting_transcript_cleanup_system_prompt(true)
            .contains("Remove non-meaningful filler words"));
        assert!(meeting_transcript_cleanup_system_prompt(false).contains("Preserve filler words"));
    }
}
