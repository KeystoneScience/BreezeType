use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use crate::settings::{OPENAI_CODEX_DEFAULT_MODEL_ID, OPENAI_CODEX_PROVIDER_ID};

const AUTH_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const AUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";
const OAUTH_STORE_FILE: &str = "openai_codex_oauth.json";

const SUCCESS_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connected</title>
</head>
<body>
  <p>Authentication successful. You can return to BreezeType.</p>
</body>
</html>"#;

const ERROR_HTML_PREFIX: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication Error</title>
</head>
<body>
  <p>"#;

const ERROR_HTML_SUFFIX: &str = r#"</p>
</body>
</html>"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredOpenAICodexCredential {
    access_token: String,
    refresh_token: String,
    expires_at_ms: i64,
    account_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OAuthTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OpenAICodexOAuthStatus {
    pub connected: bool,
    pub account_id: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub default_model: String,
    pub reasoning_effort: String,
}

fn now_ms() -> i64 {
    let now = SystemTime::now();
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn credential_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;
    Ok(app_data_dir.join(OAUTH_STORE_FILE))
}

fn load_credential(app: &AppHandle) -> Result<Option<StoredOpenAICodexCredential>, String> {
    let path = credential_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path).map_err(|e| {
        format!(
            "Failed to read OpenAI OAuth credential file '{}': {}",
            path.display(),
            e
        )
    })?;
    let credential = serde_json::from_str::<StoredOpenAICodexCredential>(&raw).map_err(|e| {
        format!(
            "Failed to parse OpenAI OAuth credential file '{}': {}",
            path.display(),
            e
        )
    })?;
    Ok(Some(credential))
}

fn save_credential(
    app: &AppHandle,
    credential: &StoredOpenAICodexCredential,
) -> Result<(), String> {
    let path = credential_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create OAuth credential directory '{}': {}",
                parent.display(),
                e
            )
        })?;
    }

    let payload = serde_json::to_string_pretty(credential)
        .map_err(|e| format!("Failed to serialize OAuth credential: {}", e))?;
    fs::write(&path, format!("{}\n", payload)).map_err(|e| {
        format!(
            "Failed to write OpenAI OAuth credential file '{}': {}",
            path.display(),
            e
        )
    })
}

pub fn clear_credential(app: &AppHandle) -> Result<(), String> {
    let path = credential_path(app)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| {
            format!(
                "Failed to remove OpenAI OAuth credential file '{}': {}",
                path.display(),
                e
            )
        })?;
    }
    Ok(())
}

fn is_expired(credential: &StoredOpenAICodexCredential) -> bool {
    now_ms() >= credential.expires_at_ms.saturating_sub(60_000)
}

fn create_state() -> String {
    Uuid::new_v4().simple().to_string()
}

fn generate_pkce() -> (String, String) {
    let mut entropy = Vec::with_capacity(32);
    entropy.extend_from_slice(Uuid::new_v4().as_bytes());
    entropy.extend_from_slice(Uuid::new_v4().as_bytes());

    let verifier = URL_SAFE_NO_PAD.encode(entropy);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn build_authorize_url(code_challenge: &str, state: &str) -> Result<String, String> {
    let mut url =
        Url::parse(AUTH_AUTHORIZE_URL).map_err(|e| format!("Failed to parse auth URL: {}", e))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", CLIENT_ID);
        query.append_pair("redirect_uri", REDIRECT_URI);
        query.append_pair("scope", "openid profile email offline_access");
        query.append_pair("code_challenge", code_challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("state", state);
        query.append_pair("id_token_add_organizations", "true");
        query.append_pair("codex_cli_simplified_flow", "true");
        query.append_pair("originator", "breezetype");
    }
    Ok(url.to_string())
}

fn html_error_body(message: &str) -> String {
    format!("{}{}{}", ERROR_HTML_PREFIX, message, ERROR_HTML_SUFFIX)
}

fn send_html_response(stream: &mut TcpStream, status: &str, body: &str) {
    let payload = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        body.as_bytes().len(),
        body
    );
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
}

fn handle_callback_connection(
    mut stream: TcpStream,
    expected_state: &str,
) -> Result<Option<String>, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("Failed setting read timeout for callback socket: {}", e))?;

    let mut buffer = [0_u8; 8192];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(n) => n,
        Err(e) if e.kind() == ErrorKind::WouldBlock => 0,
        Err(e) if e.kind() == ErrorKind::TimedOut => 0,
        Err(e) => return Err(format!("Failed reading OAuth callback request: {}", e)),
    };
    if bytes_read == 0 {
        return Ok(None);
    }

    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let request_line = request.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();

    if method != "GET" {
        send_html_response(
            &mut stream,
            "405 Method Not Allowed",
            &html_error_body("Invalid request method."),
        );
        return Ok(None);
    }

    if !target.starts_with("/auth/callback") {
        send_html_response(
            &mut stream,
            "404 Not Found",
            &html_error_body("Unknown callback route."),
        );
        return Ok(None);
    }

    let url = Url::parse(&format!("http://127.0.0.1{}", target))
        .map_err(|e| format!("Failed to parse callback URL: {}", e))?;
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.to_string());
    let code = url
        .query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.to_string());

    if state.as_deref() != Some(expected_state) {
        send_html_response(
            &mut stream,
            "400 Bad Request",
            &html_error_body("State mismatch. Close this tab and retry from BreezeType."),
        );
        return Ok(None);
    }

    let Some(code) = code else {
        send_html_response(
            &mut stream,
            "400 Bad Request",
            &html_error_body("Missing authorization code in callback URL."),
        );
        return Ok(None);
    };

    send_html_response(&mut stream, "200 OK", SUCCESS_HTML);
    Ok(Some(code))
}

fn wait_for_oauth_callback(expected_state: &str, timeout: Duration) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:1455").map_err(|e| {
        format!(
            "Failed to bind OAuth callback listener on 127.0.0.1:1455: {}",
            e
        )
    })?;
    listener.set_nonblocking(true).map_err(|e| {
        format!(
            "Failed to configure callback listener as non-blocking: {}",
            e
        )
    })?;

    let deadline = Instant::now() + timeout;

    loop {
        if Instant::now() >= deadline {
            return Err("Timed out waiting for OpenAI OAuth callback.".to_string());
        }

        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(code) = handle_callback_connection(stream, expected_state)? {
                    return Ok(code);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(60));
            }
            Err(e) => {
                return Err(format!("Failed accepting OAuth callback connection: {}", e));
            }
        }
    }
}

fn extract_account_id(access_token: &str) -> Option<String> {
    let payload = access_token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload.as_bytes()).ok()?;
    let json = serde_json::from_slice::<serde_json::Value>(&decoded).ok()?;
    json.get(JWT_CLAIM_PATH)?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_string)
}

async fn exchange_authorization_code(
    code: &str,
    verifier: &str,
) -> Result<StoredOpenAICodexCredential, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(AUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(|e| format!("OpenAI OAuth token exchange request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response body".to_string());
        return Err(format!(
            "OpenAI OAuth token exchange failed ({}): {}",
            status, text
        ));
    }

    let body: OAuthTokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse OpenAI OAuth token response: {}", e))?;

    let access = body.access_token.unwrap_or_default().trim().to_string();
    let refresh = body.refresh_token.unwrap_or_default().trim().to_string();
    let expires_in = body.expires_in.unwrap_or_default().max(0);

    if access.is_empty() {
        return Err("OpenAI OAuth token response did not include access_token.".to_string());
    }
    if refresh.is_empty() {
        return Err("OpenAI OAuth token response did not include refresh_token.".to_string());
    }

    let account_id = extract_account_id(&access)
        .ok_or_else(|| "Failed to extract account ID from OpenAI access token.".to_string())?;

    Ok(StoredOpenAICodexCredential {
        access_token: access,
        refresh_token: refresh,
        expires_at_ms: now_ms() + expires_in * 1000,
        account_id,
    })
}

async fn refresh_access_token(
    credential: &StoredOpenAICodexCredential,
) -> Result<StoredOpenAICodexCredential, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(AUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", credential.refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("OpenAI OAuth token refresh request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response body".to_string());
        return Err(format!(
            "OpenAI OAuth token refresh failed ({}): {}",
            status, text
        ));
    }

    let body: OAuthTokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse OpenAI OAuth refresh response: {}", e))?;

    let access = body.access_token.unwrap_or_default().trim().to_string();
    let refresh = body
        .refresh_token
        .unwrap_or_else(|| credential.refresh_token.clone())
        .trim()
        .to_string();
    let expires_in = body.expires_in.unwrap_or_default().max(0);

    if access.is_empty() {
        return Err("OpenAI OAuth refresh response did not include access_token.".to_string());
    }

    let account_id = extract_account_id(&access).unwrap_or_else(|| credential.account_id.clone());

    Ok(StoredOpenAICodexCredential {
        access_token: access,
        refresh_token: if refresh.is_empty() {
            credential.refresh_token.clone()
        } else {
            refresh
        },
        expires_at_ms: now_ms() + expires_in * 1000,
        account_id,
    })
}

pub async fn connect_openai_codex(app: &AppHandle) -> Result<OpenAICodexOAuthStatus, String> {
    // If we're already connected, don't force a browser re-auth. Just refresh if needed.
    if let Ok(Some(mut existing)) = load_credential(app) {
        let has_tokens = !existing.access_token.trim().is_empty()
            && !existing.refresh_token.trim().is_empty()
            && !existing.account_id.trim().is_empty();

        if has_tokens {
            if is_expired(&existing) {
                match refresh_access_token(&existing).await {
                    Ok(refreshed) => {
                        existing = refreshed;
                        save_credential(app, &existing)?;
                    }
                    Err(_) => {
                        // Token refresh can fail if the user revoked access. Clear and proceed
                        // with a full OAuth login below.
                        let _ = clear_credential(app);
                    }
                }
            } else {
                return Ok(OpenAICodexOAuthStatus {
                    connected: true,
                    account_id: Some(existing.account_id),
                    expires_at_ms: Some(existing.expires_at_ms),
                    default_model: OPENAI_CODEX_DEFAULT_MODEL_ID.to_string(),
                    reasoning_effort: "xhigh".to_string(),
                });
            }

            // If refresh succeeded and we're still holding valid tokens, treat as connected.
            if !existing.access_token.trim().is_empty() {
                return Ok(OpenAICodexOAuthStatus {
                    connected: true,
                    account_id: Some(existing.account_id),
                    expires_at_ms: Some(existing.expires_at_ms),
                    default_model: OPENAI_CODEX_DEFAULT_MODEL_ID.to_string(),
                    reasoning_effort: "xhigh".to_string(),
                });
            }
        }
    }

    let (code_verifier, code_challenge) = generate_pkce();
    let state = create_state();
    let auth_url = build_authorize_url(&code_challenge, &state)?;

    app.opener()
        .open_url(auth_url, None::<String>)
        .map_err(|e| format!("Failed to open browser for OpenAI OAuth: {}", e))?;

    let callback_state = state.clone();
    let auth_code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_oauth_callback(&callback_state, Duration::from_secs(240))
    })
    .await
    .map_err(|e| format!("Failed waiting for OAuth callback: {}", e))??;

    let credential = exchange_authorization_code(&auth_code, &code_verifier).await?;
    save_credential(app, &credential)?;

    Ok(OpenAICodexOAuthStatus {
        connected: true,
        account_id: Some(credential.account_id),
        expires_at_ms: Some(credential.expires_at_ms),
        default_model: OPENAI_CODEX_DEFAULT_MODEL_ID.to_string(),
        reasoning_effort: "xhigh".to_string(),
    })
}

pub fn get_openai_codex_status(app: &AppHandle) -> OpenAICodexOAuthStatus {
    match load_credential(app) {
        Ok(Some(credential)) => OpenAICodexOAuthStatus {
            connected: !credential.access_token.trim().is_empty(),
            account_id: Some(credential.account_id),
            expires_at_ms: Some(credential.expires_at_ms),
            default_model: OPENAI_CODEX_DEFAULT_MODEL_ID.to_string(),
            reasoning_effort: "xhigh".to_string(),
        },
        _ => OpenAICodexOAuthStatus {
            connected: false,
            account_id: None,
            expires_at_ms: None,
            default_model: OPENAI_CODEX_DEFAULT_MODEL_ID.to_string(),
            reasoning_effort: "xhigh".to_string(),
        },
    }
}

pub async fn resolve_provider_api_key(
    app: &AppHandle,
    provider_id: &str,
    fallback_api_key: String,
) -> Result<String, String> {
    if provider_id != OPENAI_CODEX_PROVIDER_ID {
        return Ok(fallback_api_key);
    }

    let mut credential = load_credential(app)?.ok_or_else(|| {
        "OpenAI account is not connected. Please connect in Settings.".to_string()
    })?;

    if is_expired(&credential) {
        credential = refresh_access_token(&credential).await?;
        save_credential(app, &credential)?;
    }

    Ok(credential.access_token)
}

pub fn codex_model_options() -> Vec<String> {
    vec![
        OPENAI_CODEX_DEFAULT_MODEL_ID.to_string(),
        "gpt-5.2-codex".to_string(),
        "gpt-5.1-codex".to_string(),
    ]
}
