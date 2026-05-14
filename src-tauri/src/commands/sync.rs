use crate::managers::history::{HistoryManager, SyncResult};
use crate::managers::meetings::{MeetingsManager, MeetingsSyncResult};
use log::warn;
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn sync_with_server(
    history_manager: State<'_, Arc<HistoryManager>>,
    server_url: String,
    auth_token: String,
    user_id: String,
) -> Result<SyncResult, String> {
    let payload = history_manager
        .prepare_sync_payload(&user_id)
        .map_err(|e| e.to_string())?;

    let base = server_url.trim_end_matches('/');
    let url = format!("{}/sync", base);

    let client = Client::new();
    let response = client
        .post(url)
        .header("Authorization", auth_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Sync failed: {} {}", status, body));
    }

    let result: SyncResult = response.json().await.map_err(|e| e.to_string())?;
    history_manager
        .apply_sync_result(&user_id, &result)
        .map_err(|e| e.to_string())?;

    Ok(result)
}

#[derive(Debug, Deserialize)]
struct MeetingAudioUploadResponse {
    audio_s3_key: String,
    audio_uploaded_at: i64,
}

#[derive(Debug, Deserialize)]
struct MeetingAudioUrlResponse {
    url: String,
}

async fn sync_meetings_once(
    meetings_manager: &Arc<MeetingsManager>,
    client: &Client,
    base: &str,
    auth_token: &str,
    user_id: &str,
) -> Result<MeetingsSyncResult, String> {
    let payload = meetings_manager.prepare_sync_payload(user_id)?;
    let url = format!("{}/sync/meetings", base);

    let response = client
        .post(url)
        .header("Authorization", auth_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Meeting sync failed: {} {}", status, body));
    }

    response.json().await.map_err(|e| e.to_string())
}

async fn upload_pending_meeting_audio(
    meetings_manager: &Arc<MeetingsManager>,
    client: &Client,
    base: &str,
    auth_token: &str,
) {
    let pending = match meetings_manager.list_pending_audio_uploads() {
        Ok(items) => items,
        Err(err) => {
            warn!("Failed to list pending meeting audio uploads: {}", err);
            return;
        }
    };

    for entry in pending {
        let file_path = meetings_manager.get_meeting_audio_file_path(&entry.file_name);
        let bytes = match tokio::fs::read(&file_path).await {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    "Skipping audio upload for {} ({}): {}",
                    entry.sync_id,
                    file_path.display(),
                    err
                );
                continue;
            }
        };

        if bytes.is_empty() {
            continue;
        }

        let content_type = if entry.file_name.to_lowercase().ends_with(".wav") {
            "audio/wav"
        } else {
            "audio/mpeg"
        };
        let url = format!("{}/meetings/{}/audio", base, entry.sync_id);

        let response = match client
            .put(url)
            .header("Authorization", auth_token)
            .header("Content-Type", content_type)
            .header("x-file-name", entry.file_name.clone())
            .body(bytes)
            .send()
            .await
        {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    "Meeting audio upload request failed for {}: {}",
                    entry.sync_id, err
                );
                continue;
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            warn!(
                "Meeting audio upload failed for {}: {} {}",
                entry.sync_id, status, body
            );
            continue;
        }

        let payload: MeetingAudioUploadResponse = match response.json().await {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    "Failed parsing meeting upload response for {}: {}",
                    entry.sync_id, err
                );
                continue;
            }
        };

        if let Err(err) = meetings_manager.mark_audio_uploaded(
            &entry.sync_id,
            payload.audio_s3_key,
            payload.audio_uploaded_at,
        ) {
            warn!(
                "Failed to update local audio metadata for {}: {}",
                entry.sync_id, err
            );
        }
    }
}

async fn download_missing_meeting_audio(
    meetings_manager: &Arc<MeetingsManager>,
    client: &Client,
    base: &str,
    auth_token: &str,
) {
    let candidates = match meetings_manager.list_audio_download_candidates() {
        Ok(items) => items,
        Err(err) => {
            warn!("Failed to list meeting audio download candidates: {}", err);
            return;
        }
    };

    for candidate in candidates {
        let url = format!("{}/meetings/{}/audio-url", base, candidate.sync_id);
        let metadata_response = match client
            .get(url)
            .header("Authorization", auth_token)
            .send()
            .await
        {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    "Failed requesting meeting audio URL for {}: {}",
                    candidate.sync_id, err
                );
                continue;
            }
        };

        if !metadata_response.status().is_success() {
            continue;
        }

        let payload: MeetingAudioUrlResponse = match metadata_response.json().await {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    "Failed parsing meeting audio URL response for {}: {}",
                    candidate.sync_id, err
                );
                continue;
            }
        };

        if payload.url.trim().is_empty() {
            continue;
        }

        let bytes = match client.get(payload.url).send().await {
            Ok(response) => match response.bytes().await {
                Ok(content) => content,
                Err(err) => {
                    warn!(
                        "Failed reading downloaded meeting audio bytes for {}: {}",
                        candidate.sync_id, err
                    );
                    continue;
                }
            },
            Err(err) => {
                warn!(
                    "Meeting audio download request failed for {}: {}",
                    candidate.sync_id, err
                );
                continue;
            }
        };

        if bytes.is_empty() {
            continue;
        }

        let file_path = meetings_manager.get_meeting_audio_file_path(&candidate.file_name);
        if let Some(parent) = file_path.parent() {
            if let Err(err) = tokio::fs::create_dir_all(parent).await {
                warn!(
                    "Failed creating directory for {}: {}",
                    file_path.display(),
                    err
                );
                continue;
            }
        }

        if let Err(err) = tokio::fs::write(&file_path, &bytes).await {
            warn!(
                "Failed writing downloaded meeting audio {}: {}",
                file_path.display(),
                err
            );
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn sync_meetings_with_server(
    meetings_manager: State<'_, Arc<MeetingsManager>>,
    server_url: String,
    auth_token: String,
    user_id: String,
) -> Result<MeetingsSyncResult, String> {
    let base = server_url.trim_end_matches('/');
    let client = Client::new();

    let first = sync_meetings_once(
        &meetings_manager,
        &client,
        base,
        auth_token.as_str(),
        user_id.as_str(),
    )
    .await?;

    meetings_manager.apply_sync_result(&user_id, &first)?;

    upload_pending_meeting_audio(&meetings_manager, &client, base, auth_token.as_str()).await;

    let second = sync_meetings_once(
        &meetings_manager,
        &client,
        base,
        auth_token.as_str(),
        user_id.as_str(),
    )
    .await?;

    meetings_manager.apply_sync_result(&user_id, &second)?;
    download_missing_meeting_audio(&meetings_manager, &client, base, auth_token.as_str()).await;

    Ok(second)
}
