use reqwest::Url;
use serde::Deserialize;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

const CALLBACK_PATH: &str = "/auth/callback";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(240);
const DESKTOP_STATE_KEY: &str = "desktop_state";
static AUTH_ATTEMPT_GENERATION: AtomicU64 = AtomicU64::new(0);
const ALLOWED_WEB_ORIGINS: [&str; 2] = ["https://breezetype.com", "https://www.breezetype.com"];

const SUCCESS_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Return to BreezeType</title>
  <style>
    body {
      align-items: center;
      background: #f5f5f7;
      color: #18181b;
      display: flex;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    main {
      background: rgba(255, 255, 255, 0.78);
      border-radius: 28px;
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.08);
      max-width: 420px;
      padding: 32px;
      text-align: center;
    }
    h1 {
      font-size: 22px;
      margin: 0 0 10px;
    }
    p {
      color: #71717a;
      font-size: 15px;
      line-height: 1.55;
      margin: 0;
    }
  </style>
</head>
<body>
  <main>
    <h1>Return to BreezeType</h1>
    <p>You're all set, return back to BreezeType.</p>
  </main>
  <script>
    window.setTimeout(() => {
      window.close();
    }, 650);
  </script>
</body>
</html>"#;

struct GoogleProviderCallback {
    code: String,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStartResponse {
    success: Option<bool>,
    auth_url: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCompleteResponse {
    success: Option<bool>,
    code: Option<String>,
    desktop_state: Option<String>,
    message: Option<String>,
}

fn html_error_body(message: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication Error</title>
</head>
<body>
  <p>{}</p>
</body>
</html>"#,
        message
    )
}

fn is_allowed_web_origin(origin: &str) -> bool {
    if ALLOWED_WEB_ORIGINS.contains(&origin) {
        return true;
    }

    let Ok(url) = Url::parse(origin) else {
        return false;
    };

    url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
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

fn focus_main_window(app: &AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();

        #[cfg(target_os = "macos")]
        {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        }
    }
}

fn get_query_value(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(query_key, _)| query_key == key)
        .map(|(_, value)| value.to_string())
}

fn handle_google_provider_callback_connection(
    mut stream: TcpStream,
) -> Result<Option<GoogleProviderCallback>, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("Failed setting desktop auth callback timeout: {}", e))?;

    let mut buffer = [0_u8; 8192];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(n) => n,
        Err(e) if e.kind() == ErrorKind::WouldBlock => 0,
        Err(e) if e.kind() == ErrorKind::TimedOut => 0,
        Err(e) => return Err(format!("Failed reading desktop auth callback: {}", e)),
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
            &html_error_body("Invalid authentication callback request."),
        );
        return Ok(None);
    }

    let url = Url::parse(&format!("http://127.0.0.1{}", target))
        .map_err(|e| format!("Failed to parse desktop auth callback URL: {}", e))?;

    if url.path() != CALLBACK_PATH {
        send_html_response(
            &mut stream,
            "404 Not Found",
            &html_error_body("Unknown authentication callback route."),
        );
        return Ok(None);
    }

    if get_query_value(&url, "error").is_some() {
        send_html_response(
            &mut stream,
            "400 Bad Request",
            &html_error_body(
                "Authentication could not be completed. Return to BreezeType and try again.",
            ),
        );
        return Err("Google sign-in was canceled or could not be completed.".to_string());
    }

    let Some(code) = get_query_value(&url, "code") else {
        send_html_response(
            &mut stream,
            "400 Bad Request",
            &html_error_body("Authentication did not return a valid code."),
        );
        return Ok(None);
    };

    let Some(state) = get_query_value(&url, "state") else {
        send_html_response(
            &mut stream,
            "400 Bad Request",
            &html_error_body("Authentication did not return a valid state."),
        );
        return Ok(None);
    };

    send_html_response(&mut stream, "200 OK", SUCCESS_HTML);
    Ok(Some(GoogleProviderCallback { code, state }))
}

fn handle_callback_connection(
    mut stream: TcpStream,
    expected_state: &str,
) -> Result<Option<String>, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("Failed setting desktop auth callback timeout: {}", e))?;

    let mut buffer = [0_u8; 8192];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(n) => n,
        Err(e) if e.kind() == ErrorKind::WouldBlock => 0,
        Err(e) if e.kind() == ErrorKind::TimedOut => 0,
        Err(e) => return Err(format!("Failed reading desktop auth callback: {}", e)),
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
            &html_error_body("Invalid authentication callback request."),
        );
        return Ok(None);
    }

    let url = Url::parse(&format!("http://127.0.0.1{}", target))
        .map_err(|e| format!("Failed to parse desktop auth callback URL: {}", e))?;

    if url.path() != CALLBACK_PATH {
        send_html_response(
            &mut stream,
            "404 Not Found",
            &html_error_body("Unknown authentication callback route."),
        );
        return Ok(None);
    }

    if get_query_value(&url, DESKTOP_STATE_KEY).as_deref() != Some(expected_state) {
        send_html_response(
            &mut stream,
            "400 Bad Request",
            &html_error_body(
                "Authentication session did not match the current BreezeType sign-in request.",
            ),
        );
        return Ok(None);
    }

    if let Some(error) = get_query_value(&url, "autherror") {
        send_html_response(
            &mut stream,
            "400 Bad Request",
            &html_error_body(
                "Authentication could not be completed. Return to BreezeType and try again.",
            ),
        );
        return Err(error);
    }

    let Some(auth_code) = get_query_value(&url, "authcode") else {
        send_html_response(
            &mut stream,
            "400 Bad Request",
            &html_error_body("Authentication did not return a valid code."),
        );
        return Ok(None);
    };

    send_html_response(&mut stream, "200 OK", SUCCESS_HTML);
    Ok(Some(auth_code))
}

fn wait_for_callback(
    listener: TcpListener,
    timeout: Duration,
    expected_state: String,
    generation: u64,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to configure desktop auth listener: {}", e))?;

    let deadline = Instant::now() + timeout;

    loop {
        if AUTH_ATTEMPT_GENERATION.load(Ordering::SeqCst) != generation {
            return Err("Browser sign-in was cancelled.".to_string());
        }

        if Instant::now() >= deadline {
            return Err("Timed out waiting for browser sign-in to finish.".to_string());
        }

        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(auth_code) = handle_callback_connection(stream, &expected_state)? {
                    if AUTH_ATTEMPT_GENERATION.load(Ordering::SeqCst) != generation {
                        return Err("Browser sign-in was cancelled.".to_string());
                    }
                    return Ok(auth_code);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(60));
            }
            Err(e) => {
                return Err(format!(
                    "Failed accepting desktop auth callback connection: {}",
                    e
                ));
            }
        }
    }
}

fn wait_for_google_provider_callback(
    listener: TcpListener,
    timeout: Duration,
    generation: u64,
) -> Result<GoogleProviderCallback, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to configure desktop auth listener: {}", e))?;

    let deadline = Instant::now() + timeout;

    loop {
        if AUTH_ATTEMPT_GENERATION.load(Ordering::SeqCst) != generation {
            return Err("Browser sign-in was cancelled.".to_string());
        }

        if Instant::now() >= deadline {
            return Err("Timed out waiting for browser sign-in to finish.".to_string());
        }

        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(callback) = handle_google_provider_callback_connection(stream)? {
                    if AUTH_ATTEMPT_GENERATION.load(Ordering::SeqCst) != generation {
                        return Err("Browser sign-in was cancelled.".to_string());
                    }
                    return Ok(callback);
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(60));
            }
            Err(e) => {
                return Err(format!(
                    "Failed accepting desktop auth callback connection: {}",
                    e
                ));
            }
        }
    }
}

fn normalize_provider(provider: &str) -> Result<&'static str, String> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "apple" => Ok("apple"),
        "google" => Ok("google"),
        _ => Err("Unsupported sign-in provider.".to_string()),
    }
}

fn build_desktop_login_url(
    web_url: &str,
    provider: &str,
    callback_origin: &str,
    desktop_state: &str,
) -> Result<String, String> {
    let normalized_provider = normalize_provider(provider)?;
    let mut url = Url::parse(web_url)
        .map_err(|e| format!("Invalid BreezeType web URL '{}': {}", web_url, e))?;
    let origin = url.origin().ascii_serialization();

    if !is_allowed_web_origin(&origin) {
        return Err(format!("Unsupported BreezeType web origin '{}'.", origin));
    }

    url.set_path("/login");
    url.set_query(None);

    {
        let mut query = url.query_pairs_mut();
        query.append_pair("return_origin", callback_origin);
        query.append_pair("return_path", CALLBACK_PATH);
        if normalized_provider == "apple" {
            query.append_pair("provider", normalized_provider);
        }
        query.append_pair(DESKTOP_STATE_KEY, desktop_state);
    }

    Ok(url.to_string())
}

fn is_loopback_host(host: Option<&str>) -> bool {
    matches!(host, Some("127.0.0.1" | "localhost" | "::1"))
}

fn build_server_endpoint_url(server_url: &str, path: &str) -> Result<Url, String> {
    let mut url = Url::parse(server_url)
        .map_err(|e| format!("Invalid BreezeType server URL '{}': {}", server_url, e))?;
    let is_allowed_server =
        url.scheme() == "https" || (url.scheme() == "http" && is_loopback_host(url.host_str()));

    if !is_allowed_server {
        return Err(format!(
            "Unsupported BreezeType server origin '{}'.",
            url.origin().ascii_serialization()
        ));
    }

    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn fetch_google_desktop_auth_url(
    server_url: &str,
    callback_uri: &str,
    desktop_state: &str,
) -> Result<String, String> {
    let mut start_url = build_server_endpoint_url(server_url, "/account/gg/google/desktop/start")?;
    {
        let mut query = start_url.query_pairs_mut();
        query.append_pair("callback_uri", callback_uri);
        query.append_pair("provider_redirect_uri", callback_uri);
        query.append_pair("client_state", desktop_state);
    }

    let response = reqwest::Client::new()
        .get(start_url)
        .send()
        .await
        .map_err(|e| format!("Failed to start Google sign-in: {}", e))?;
    let status = response.status();
    let payload = response
        .text()
        .await
        .map_err(|e| format!("Failed reading Google sign-in response: {}", e))?;
    let body = serde_json::from_str::<DesktopStartResponse>(&payload).map_err(|_| {
        format!(
            "BreezeType server returned an unexpected Google sign-in response ({}).",
            status
        )
    })?;

    if !status.is_success() || body.success != Some(true) {
        return Err(body
            .message
            .unwrap_or_else(|| "Unable to start Google sign-in.".to_string()));
    }

    let auth_url = body
        .auth_url
        .ok_or_else(|| "BreezeType server did not return a Google sign-in URL.".to_string())?;
    let parsed_auth_url = Url::parse(&auth_url).map_err(|e| {
        format!(
            "BreezeType server returned an invalid Google sign-in URL: {}",
            e
        )
    })?;

    if parsed_auth_url.scheme() != "https"
        || parsed_auth_url.host_str() != Some("accounts.google.com")
    {
        return Err("BreezeType server returned an unexpected Google sign-in URL.".to_string());
    }

    Ok(auth_url)
}

async fn complete_google_desktop_auth(
    server_url: &str,
    callback: GoogleProviderCallback,
    desktop_state: &str,
) -> Result<String, String> {
    let complete_url =
        build_server_endpoint_url(server_url, "/account/gg/google/desktop/complete")?;
    let response = reqwest::Client::new()
        .post(complete_url)
        .json(&serde_json::json!({
            "code": callback.code,
            "state": callback.state,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to complete Google sign-in: {}", e))?;
    let status = response.status();
    let payload = response
        .text()
        .await
        .map_err(|e| format!("Failed reading Google sign-in completion response: {}", e))?;
    let body = serde_json::from_str::<DesktopCompleteResponse>(&payload).map_err(|_| {
        format!(
            "BreezeType server returned an unexpected Google completion response ({}).",
            status
        )
    })?;

    if !status.is_success() || body.success != Some(true) {
        return Err(body
            .message
            .unwrap_or_else(|| "Unable to complete Google sign-in.".to_string()));
    }

    if body.desktop_state.as_deref() != Some(desktop_state) {
        return Err("BreezeType sign-in returned an unexpected state.".to_string());
    }

    body.code
        .ok_or_else(|| "BreezeType sign-in did not return an authorization code.".to_string())
}

async fn begin_google_desktop_account_auth(
    app: AppHandle,
    server_url: String,
) -> Result<String, String> {
    let generation = AUTH_ATTEMPT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to start desktop auth listener: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to resolve desktop auth listener address: {}", e))?
        .port();
    let callback_uri = format!("http://127.0.0.1:{}{}", port, CALLBACK_PATH);
    let desktop_state = Uuid::new_v4().simple().to_string();
    let auth_url =
        fetch_google_desktop_auth_url(&server_url, &callback_uri, &desktop_state).await?;

    app.opener()
        .open_url(auth_url, None::<String>)
        .map_err(|e| format!("Failed to open browser for Google sign-in: {}", e))?;

    let callback = tauri::async_runtime::spawn_blocking(move || {
        wait_for_google_provider_callback(listener, CALLBACK_TIMEOUT, generation)
    })
    .await
    .map_err(|e| format!("Failed waiting for browser sign-in callback: {}", e))??;

    let auth_code = complete_google_desktop_auth(&server_url, callback, &desktop_state).await;
    focus_main_window(&app);
    auth_code
}

#[tauri::command]
#[specta::specta]
pub async fn begin_browser_account_auth(
    app: AppHandle,
    provider: String,
    web_url: String,
) -> Result<String, String> {
    if normalize_provider(&provider)? == "google" {
        return begin_google_desktop_account_auth(app, web_url).await;
    }

    let generation = AUTH_ATTEMPT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to start desktop auth listener: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to resolve desktop auth listener address: {}", e))?
        .port();
    let callback_origin = format!("http://127.0.0.1:{}", port);
    let desktop_state = Uuid::new_v4().simple().to_string();
    let auth_url = build_desktop_login_url(&web_url, &provider, &callback_origin, &desktop_state)?;

    app.opener()
        .open_url(auth_url, None::<String>)
        .map_err(|e| format!("Failed to open browser for BreezeType sign-in: {}", e))?;

    let auth_code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_callback(listener, CALLBACK_TIMEOUT, desktop_state, generation)
    })
    .await
    .map_err(|e| format!("Failed waiting for browser sign-in callback: {}", e))??;
    focus_main_window(&app);
    Ok(auth_code)
}

#[tauri::command]
#[specta::specta]
pub fn cancel_browser_account_auth() -> Result<(), String> {
    AUTH_ATTEMPT_GENERATION.fetch_add(1, Ordering::SeqCst);
    Ok(())
}
