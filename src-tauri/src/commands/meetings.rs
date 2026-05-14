use chrono::{DateTime, Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::managers::meetings::{
    ActiveMeetingInfo, DeletedMeetingEntry, MeetingDiarizationStatus, MeetingEntry,
    MeetingFollowUpDraft, MeetingGeneratedTask, MeetingNote, MeetingParticipant,
    MeetingSpeakerMapping, MeetingSummaryResult, MeetingTranscript, MeetingsManager,
};

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct StartMeetingRecordingRequest {
    pub name: Option<String>,
    pub include_system_audio: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct StopMeetingRecordingRequest {
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct DownloadMeetingResult {
    pub destination_path: String,
    pub has_transcript: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct CreateMeetingParticipantRequest {
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub photo_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct UpdateMeetingSpeakerMappingRequest {
    pub raw_speaker_id: String,
    pub display_name: String,
    pub color: Option<String>,
    pub participant_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct UpdateMeetingTranscriptSpeakerRequest {
    pub segment_index: usize,
    pub speaker_id: Option<String>,
    pub apply_to_all_with_same_speaker: bool,
}

fn sanitize_export_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            '\n' | '\r' | '\t' => ' ',
            _ => c,
        })
        .collect();
    let collapsed = cleaned
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return "Meeting".to_string();
    }
    let mut output = trimmed.to_string();
    const MAX_LEN: usize = 80;
    if output.chars().count() > MAX_LEN {
        output = output.chars().take(MAX_LEN).collect();
    }
    output
}

fn format_meeting_date(timestamp: i64) -> String {
    let utc = Utc
        .timestamp_opt(timestamp, 0)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
    let local: DateTime<Local> = DateTime::from(utc);
    local.format("%Y-%m-%d").to_string()
}

fn build_export_base_name(name: &str, timestamp: i64) -> String {
    let safe_name = sanitize_export_name(name);
    let date = format_meeting_date(timestamp);
    format!("{safe_name} - {date}")
}

fn unique_dir_path(base_dir: &Path, base_name: &str) -> PathBuf {
    let mut candidate = base_dir.join(base_name);
    let mut counter = 1;
    while candidate.exists() {
        candidate = base_dir.join(format!("{base_name} ({counter})"));
        counter += 1;
    }
    candidate
}

fn unique_file_path(base_dir: &Path, base_name: &str, extension: &str) -> PathBuf {
    let mut candidate = base_dir.join(format!("{base_name}.{extension}"));
    let mut counter = 1;
    while candidate.exists() {
        candidate = base_dir.join(format!("{base_name} ({counter}).{extension}"));
        counter += 1;
    }
    candidate
}

#[tauri::command]
#[specta::specta]
pub fn start_meeting_recording(
    app: AppHandle,
    request: StartMeetingRecordingRequest,
) -> Result<ActiveMeetingInfo, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    let active = manager.start_recording(request.name, request.include_system_audio)?;
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    let _ = app.emit("navigate-to", "meetings");
    Ok(active)
}

#[tauri::command]
#[specta::specta]
pub async fn stop_meeting_recording(
    app: AppHandle,
    request: StopMeetingRecordingRequest,
) -> Result<MeetingEntry, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.stop_recording(request.name).await
}

#[tauri::command]
#[specta::specta]
pub fn get_meetings(app: AppHandle) -> Result<Vec<MeetingEntry>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.get_meetings()
}

#[tauri::command]
#[specta::specta]
pub fn get_deleted_meetings(app: AppHandle) -> Result<Vec<DeletedMeetingEntry>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.get_deleted_meetings()
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_audio_file_path(app: AppHandle, file_name: String) -> Result<String, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    let path = manager.get_meeting_audio_file_path(&file_name);
    if !path.exists() {
        return Err(
            "Meeting audio file is not available yet. It may still be finishing.".to_string(),
        );
    }
    path.to_str()
        .ok_or_else(|| "Invalid meeting file path".to_string())
        .map(|s| s.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn rename_meeting(app: AppHandle, id: i64, name: String) -> Result<(), String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.rename_meeting(id, name)
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_tags(app: AppHandle) -> Result<Vec<String>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.list_tags()
}

#[tauri::command]
#[specta::specta]
pub fn set_meeting_tags(app: AppHandle, id: i64, tags: Vec<String>) -> Result<Vec<String>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.set_meeting_tags(id, tags)
}

#[tauri::command]
#[specta::specta]
pub fn get_participants(app: AppHandle) -> Result<Vec<MeetingParticipant>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.list_participants()
}

#[tauri::command]
#[specta::specta]
pub fn create_participant(
    app: AppHandle,
    request: CreateMeetingParticipantRequest,
) -> Result<MeetingParticipant, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.create_participant(
        request.name,
        request.email,
        request.phone,
        request.photo_data_url,
    )
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_participants(
    app: AppHandle,
    id: i64,
) -> Result<Vec<MeetingParticipant>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.get_meeting_participants(id)
}

#[tauri::command]
#[specta::specta]
pub fn set_meeting_participants(
    app: AppHandle,
    id: i64,
    participant_ids: Vec<i64>,
) -> Result<Vec<MeetingParticipant>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.set_meeting_participants(id, participant_ids)
}

#[tauri::command]
#[specta::specta]
pub fn delete_meeting(app: AppHandle, id: i64) -> Result<DeletedMeetingEntry, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.delete_meeting(id)
}

#[tauri::command]
#[specta::specta]
pub fn restore_meeting(app: AppHandle, id: i64) -> Result<MeetingEntry, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.restore_meeting(id)
}

#[tauri::command]
#[specta::specta]
pub fn delete_meeting_permanently(app: AppHandle, id: i64) -> Result<(), String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.delete_meeting_permanently(id)
}

#[tauri::command]
#[specta::specta]
pub fn is_meeting_recording(app: AppHandle) -> Result<bool, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    Ok(manager.is_recording())
}

#[tauri::command]
#[specta::specta]
pub fn get_active_meeting(app: AppHandle) -> Result<Option<ActiveMeetingInfo>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    Ok(manager.get_active_meeting())
}

#[tauri::command]
#[specta::specta]
pub fn get_active_meeting_live_transcript(
    app: AppHandle,
) -> Result<Option<MeetingTranscript>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    Ok(manager.get_active_meeting_live_transcript())
}

#[tauri::command]
#[specta::specta]
pub fn add_meeting_note(app: AppHandle, text: String) -> Result<MeetingNote, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.add_active_meeting_note(text)
}

#[tauri::command]
#[specta::specta]
pub fn add_meeting_note_span(
    app: AppHandle,
    start_offset_seconds: f64,
    end_offset_seconds: f64,
    text: String,
) -> Result<MeetingNote, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.add_active_meeting_note_span(start_offset_seconds, end_offset_seconds, text)
}

#[tauri::command]
#[specta::specta]
pub fn add_meeting_note_at(
    app: AppHandle,
    id: i64,
    offset_seconds: f64,
    text: String,
) -> Result<MeetingNote, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.add_meeting_note_at(id, offset_seconds, text)
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_notes(app: AppHandle, id: i64) -> Result<Vec<MeetingNote>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.get_meeting_notes(id)
}

#[tauri::command]
#[specta::specta]
pub async fn get_meeting_transcript(app: AppHandle, id: i64) -> Result<MeetingTranscript, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.get_meeting_transcript(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_meeting_transcript_segment(
    app: AppHandle,
    id: i64,
    segment_index: usize,
    text: String,
) -> Result<MeetingTranscript, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager
        .update_meeting_transcript_segment(id, segment_index, text)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn update_meeting_transcript_segment_speaker(
    app: AppHandle,
    id: i64,
    request: UpdateMeetingTranscriptSpeakerRequest,
) -> Result<MeetingTranscript, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager
        .update_meeting_transcript_segment_speaker(
            id,
            request.segment_index,
            request.speaker_id,
            request.apply_to_all_with_same_speaker,
        )
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn run_meeting_diarization(
    app: AppHandle,
    id: i64,
) -> Result<MeetingDiarizationStatus, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.run_meeting_diarization(id).await
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_diarization_status(
    app: AppHandle,
    id: i64,
) -> Result<MeetingDiarizationStatus, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.get_meeting_diarization_status(id)
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_speaker_mappings(
    app: AppHandle,
    id: i64,
) -> Result<Vec<MeetingSpeakerMapping>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.get_meeting_speaker_mappings(id)
}

#[tauri::command]
#[specta::specta]
pub fn update_meeting_speaker_mapping(
    app: AppHandle,
    id: i64,
    request: UpdateMeetingSpeakerMappingRequest,
) -> Result<Vec<MeetingSpeakerMapping>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.update_meeting_speaker_mapping(
        id,
        request.raw_speaker_id,
        request.display_name,
        request.color,
        request.participant_id,
    )
}

#[tauri::command]
#[specta::specta]
pub async fn summarize_meeting(app: AppHandle, id: i64) -> Result<MeetingSummaryResult, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.summarize_meeting(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn generate_meeting_tasks(
    app: AppHandle,
    id: i64,
) -> Result<Vec<MeetingGeneratedTask>, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.generate_meeting_tasks(id).await
}

#[tauri::command]
#[specta::specta]
pub async fn draft_meeting_follow_up(
    app: AppHandle,
    id: i64,
) -> Result<MeetingFollowUpDraft, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    manager.draft_meeting_follow_up(id).await
}

#[tauri::command]
#[specta::specta]
pub fn download_meeting(app: AppHandle, id: i64) -> Result<DownloadMeetingResult, String> {
    let manager = app.state::<Arc<MeetingsManager>>();
    let meeting = manager.get_meeting_entry(id)?;
    let transcript = manager.get_meeting_transcript_if_available(id)?;

    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Failed to get downloads directory: {}", e))?;

    let base_name = build_export_base_name(&meeting.name, meeting.ended_at);
    let audio_path = manager.get_meeting_file_path_by_id(id)?;
    if !audio_path.exists() {
        return Err("Meeting audio file not found".to_string());
    }

    let audio_extension = audio_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("mp3");

    if let Some(transcript) = transcript {
        let folder_path = unique_dir_path(&downloads_dir, &base_name);
        fs::create_dir_all(&folder_path).map_err(|e| e.to_string())?;

        let audio_destination = unique_file_path(&folder_path, &base_name, audio_extension);
        fs::copy(&audio_path, &audio_destination).map_err(|e| e.to_string())?;

        let transcript_destination = unique_file_path(&folder_path, &base_name, "txt");
        let transcript_text =
            if transcript.text.trim().is_empty() && !transcript.segments.is_empty() {
                transcript
                    .segments
                    .iter()
                    .map(|segment| segment.text.trim())
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                transcript.text
            };
        fs::write(&transcript_destination, transcript_text).map_err(|e| e.to_string())?;

        Ok(DownloadMeetingResult {
            destination_path: folder_path.to_string_lossy().as_ref().to_string(),
            has_transcript: true,
        })
    } else {
        let audio_destination = unique_file_path(&downloads_dir, &base_name, audio_extension);
        fs::copy(&audio_path, &audio_destination).map_err(|e| e.to_string())?;

        Ok(DownloadMeetingResult {
            destination_path: audio_destination.to_string_lossy().as_ref().to_string(),
            has_transcript: false,
        })
    }
}
