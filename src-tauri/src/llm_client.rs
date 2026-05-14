use crate::settings::PostProcessProvider;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use log::debug;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, REFERER, USER_AGENT};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const OPENAI_CODEX_PROVIDER_ID: &str = "openai-codex";
const OPENAI_CODEX_DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_REASONING_EFFORT: &str = "xhigh";
const OPENAI_CODEX_JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";
const LOCAL_LLM_PROVIDER_ID: &str = "local_llama";
const LOCAL_LLM_BASE_URL_ENV: &str = "BREEZE_LOCAL_LLM_BASE_URL";
const LOCAL_LLM_FALLBACK_BASE_URL: &str = "http://127.0.0.1:45871/v1";

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_template_kwargs: Option<ChatTemplateKwargs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_format: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatTemplateKwargs {
    enable_thinking: bool,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessageResponse,
}

#[derive(Debug, Deserialize)]
struct ChatMessageResponse {
    content: Option<String>,
}

fn extract_openai_codex_account_id(access_token: &str) -> Option<String> {
    let payload = access_token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload.as_bytes()).ok()?;
    let json = serde_json::from_slice::<Value>(&decoded).ok()?;
    json.get(OPENAI_CODEX_JWT_CLAIM_PATH)?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_string)
}

fn resolve_openai_codex_responses_url(base_url: &str) -> String {
    let normalized = if base_url.trim().is_empty() {
        OPENAI_CODEX_DEFAULT_BASE_URL
    } else {
        base_url.trim()
    }
    .trim_end_matches('/');

    if normalized.ends_with("/codex/responses") {
        normalized.to_string()
    } else if normalized.ends_with("/codex") {
        format!("{}/responses", normalized)
    } else {
        format!("{}/codex/responses", normalized)
    }
}

fn extract_openai_codex_output_text(parsed: &Value) -> Option<String> {
    if let Some(text) = parsed.get("output_text").and_then(|value| value.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let mut chunks: Vec<String> = Vec::new();

    if let Some(output_items) = parsed.get("output").and_then(|value| value.as_array()) {
        for item in output_items {
            if let Some(content_items) = item.get("content").and_then(|value| value.as_array()) {
                for content in content_items {
                    if let Some(text) = content.get("text").and_then(|value| value.as_str()) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            chunks.push(trimmed.to_string());
                        }
                        continue;
                    }

                    if let Some(text_value) = content
                        .get("text")
                        .and_then(|value| value.get("value"))
                        .and_then(|value| value.as_str())
                    {
                        let trimmed = text_value.trim();
                        if !trimmed.is_empty() {
                            chunks.push(trimmed.to_string());
                        }
                    }
                }
            }
        }
    }

    if chunks.is_empty() {
        None
    } else {
        Some(chunks.join("\n"))
    }
}

fn extract_openai_codex_stream_output_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return extract_openai_codex_output_text(&parsed);
    }

    let mut deltas = String::new();
    let mut completed: Option<String> = None;

    for line in raw.lines() {
        let stripped = line.trim();
        if stripped.is_empty() {
            continue;
        }
        if stripped.starts_with(':') {
            continue;
        }

        let payload = if let Some(data) = stripped.strip_prefix("data:") {
            data.trim()
        } else {
            stripped
        };
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }

        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            continue;
        };

        if let Some(text) = extract_openai_codex_output_text(&event) {
            completed = Some(text);
        }
        if let Some(response) = event.get("response") {
            if let Some(text) = extract_openai_codex_output_text(response) {
                completed = Some(text);
            }
        }

        if let Some(delta) = event.get("delta").and_then(|value| value.as_str()) {
            deltas.push_str(delta);
            continue;
        }

        if let Some(event_type) = event.get("type").and_then(|value| value.as_str()) {
            if event_type.ends_with(".done") {
                if let Some(text) = event
                    .get("text")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    completed = Some(text.to_string());
                }
            }
        }
    }

    if let Some(text) = completed {
        let clean = text.trim();
        if !clean.is_empty() {
            return Some(clean.to_string());
        }
    }

    let clean_deltas = deltas.trim();
    if clean_deltas.is_empty() {
        None
    } else {
        Some(clean_deltas.to_string())
    }
}

fn is_loopback_http_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw.trim()) else {
        return false;
    };
    if url.scheme() != "http" {
        return false;
    }
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
}

fn normalize_local_llm_base_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !is_loopback_http_url(trimmed) {
        return None;
    }
    Some(trimmed.trim_end_matches('/').to_string())
}

fn resolve_local_llm_base_url(provider_base_url: &str, runtime_base_url: Option<&str>) -> String {
    runtime_base_url
        .and_then(normalize_local_llm_base_url)
        .or_else(|| normalize_local_llm_base_url(provider_base_url))
        .unwrap_or_else(|| LOCAL_LLM_FALLBACK_BASE_URL.to_string())
}

fn resolve_provider_base_url(provider: &PostProcessProvider) -> String {
    if provider.id == LOCAL_LLM_PROVIDER_ID {
        let runtime_base_url = std::env::var(LOCAL_LLM_BASE_URL_ENV).ok();
        return resolve_local_llm_base_url(&provider.base_url, runtime_base_url.as_deref());
    }

    provider.base_url.trim_end_matches('/').to_string()
}

fn local_llm_chat_template_kwargs(
    provider: &PostProcessProvider,
    model: &str,
) -> Option<ChatTemplateKwargs> {
    if is_local_qwen35_model(provider, model) {
        return Some(ChatTemplateKwargs {
            enable_thinking: false,
        });
    }

    None
}

fn is_local_qwen35_model(provider: &PostProcessProvider, model: &str) -> bool {
    provider.id == LOCAL_LLM_PROVIDER_ID
        && model.trim().to_ascii_lowercase().starts_with("qwen3.5-")
}

fn sanitize_local_llm_output(provider: &PostProcessProvider, model: &str, content: &str) -> String {
    if !is_local_qwen35_model(provider, model) {
        return content.to_string();
    }

    let mut sanitized = content.trim_start().to_string();
    loop {
        let next = if let Some(rest) = sanitized.strip_prefix("<think>\n\n</think>\n\n") {
            Some(rest)
        } else if let Some(rest) = sanitized.strip_prefix("<think>\n</think>\n\n") {
            Some(rest)
        } else if let Some(rest) = sanitized.strip_prefix("<think></think>\n\n") {
            Some(rest)
        } else if let Some(rest) = sanitized.strip_prefix("<think>\n\n</think>") {
            Some(rest)
        } else if let Some(rest) = sanitized.strip_prefix("<think></think>") {
            Some(rest)
        } else if let Some(rest) = sanitized.strip_prefix("</think>\n\n") {
            Some(rest)
        } else if let Some(rest) = sanitized.strip_prefix("</think>") {
            Some(rest)
        } else {
            None
        };

        let Some(rest) = next else {
            break;
        };
        sanitized = rest.trim_start().to_string();
    }

    sanitized
}

async fn send_openai_codex_response(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    system_prompt: Option<&str>,
    prompt: &str,
    reasoning_effort: Option<&str>,
) -> Result<Option<String>, String> {
    let url = resolve_openai_codex_responses_url(&provider.base_url);
    debug!("Sending OpenAI Codex responses request to: {}", url);

    let client = create_client(provider, &api_key)?;

    let mut request_body = json!({
        "model": model,
        "store": false,
        "stream": true,
        "input": [{
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": prompt
            }]
        }],
        "text": {
            "verbosity": "low"
        }
    });

    if let Some(effort) = reasoning_effort {
        let trimmed = effort.trim();
        if !trimmed.is_empty() {
            request_body["reasoning"] = json!({
                "effort": trimmed
            });
        }
    }

    if let Some(system_prompt) = system_prompt {
        let trimmed = system_prompt.trim();
        if !trimmed.is_empty() {
            request_body["instructions"] = Value::String(trimmed.to_string());
        }
    }

    let response = client
        .post(url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("OpenAI Codex request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!(
            "OpenAI Codex request failed with status {}: {}",
            status, error_text
        ));
    }

    let mut stream = response.bytes_stream();
    let mut raw = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Failed to read OpenAI Codex stream: {}", e))?;
        raw.push_str(&String::from_utf8_lossy(&bytes));
    }

    Ok(extract_openai_codex_stream_output_text(&raw))
}

/// Build headers for API requests based on provider type
fn build_headers(provider: &PostProcessProvider, api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    // Common headers
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(REFERER, HeaderValue::from_static("https://breezetype.com"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("BreezeType/1.0 (+https://breezetype.com)"),
    );
    headers.insert("X-Title", HeaderValue::from_static("BreezeType"));

    if provider.id == OPENAI_CODEX_PROVIDER_ID {
        if api_key.trim().is_empty() {
            return Err("OpenAI account is not connected.".to_string());
        }
        let account_id = extract_openai_codex_account_id(api_key)
            .ok_or_else(|| "Failed to extract ChatGPT account ID from OAuth token.".to_string())?;
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", api_key))
                .map_err(|e| format!("Invalid authorization header value: {}", e))?,
        );
        headers.insert(
            "chatgpt-account-id",
            HeaderValue::from_str(&account_id)
                .map_err(|e| format!("Invalid account id header value: {}", e))?,
        );
        headers.insert(
            "OpenAI-Beta",
            HeaderValue::from_static("responses=experimental"),
        );
        headers.insert("originator", HeaderValue::from_static("breezetype"));
        return Ok(headers);
    }

    // Provider-specific auth headers
    if !api_key.is_empty() {
        if provider.id == "anthropic" {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(api_key)
                    .map_err(|e| format!("Invalid API key header value: {}", e))?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        } else {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", api_key))
                    .map_err(|e| format!("Invalid authorization header value: {}", e))?,
            );
        }
    }

    Ok(headers)
}

/// Create an HTTP client with provider-specific headers
fn create_client(provider: &PostProcessProvider, api_key: &str) -> Result<reqwest::Client, String> {
    let headers = build_headers(provider, api_key)?;
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Send a chat completion request to an OpenAI-compatible API
/// Returns Ok(Some(content)) on success, Ok(None) if response has no content,
/// or Err on actual errors (HTTP, parsing, etc.)
pub async fn send_chat_completion(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    system_prompt: Option<&str>,
    prompt: &str,
) -> Result<Option<String>, String> {
    send_chat_completion_with_codex_reasoning(
        provider,
        api_key,
        model,
        system_prompt,
        prompt,
        Some(OPENAI_CODEX_REASONING_EFFORT),
    )
    .await
}

pub async fn send_chat_completion_with_codex_reasoning(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    system_prompt: Option<&str>,
    prompt: &str,
    codex_reasoning_effort: Option<&str>,
) -> Result<Option<String>, String> {
    if provider.id == OPENAI_CODEX_PROVIDER_ID {
        return send_openai_codex_response(
            provider,
            api_key,
            model,
            system_prompt,
            prompt,
            codex_reasoning_effort,
        )
        .await;
    }

    let base_url = resolve_provider_base_url(provider);
    let url = format!("{}/chat/completions", base_url);

    debug!("Sending chat completion request to: {}", url);

    let client = create_client(provider, &api_key)?;

    let mut messages = Vec::with_capacity(2);
    if let Some(system_prompt) = system_prompt {
        if !system_prompt.trim().is_empty() {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
            });
        }
    }
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: prompt.to_string(),
    });

    let request_body = ChatCompletionRequest {
        model: model.to_string(),
        messages,
        temperature: Some(0.0),
        max_tokens: Some(256),
        top_p: Some(1.0),
        chat_template_kwargs: local_llm_chat_template_kwargs(provider, model),
        reasoning_format: if is_local_qwen35_model(provider, model) {
            Some("none".to_string())
        } else {
            None
        },
    };

    let response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error response".to_string());
        return Err(format!(
            "API request failed with status {}: {}",
            status, error_text
        ));
    }

    let completion: ChatCompletionResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse API response: {}", e))?;

    Ok(completion
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .map(|content| sanitize_local_llm_output(provider, model, content)))
}

/// Fetch available models from an OpenAI-compatible API
/// Returns a list of model IDs
pub async fn fetch_models(
    provider: &PostProcessProvider,
    api_key: String,
) -> Result<Vec<String>, String> {
    let base_url = resolve_provider_base_url(provider);
    let url = format!("{}/models", base_url);

    debug!("Fetching models from: {}", url);

    let client = create_client(provider, &api_key)?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!(
            "Model list request failed ({}): {}",
            status, error_text
        ));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mut models = Vec::new();

    // Handle OpenAI format: { data: [ { id: "..." }, ... ] }
    if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
        for entry in data {
            if let Some(id) = entry.get("id").and_then(|i| i.as_str()) {
                models.push(id.to_string());
            } else if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
                models.push(name.to_string());
            }
        }
    }
    // Handle array format: [ "model1", "model2", ... ]
    else if let Some(array) = parsed.as_array() {
        for entry in array {
            if let Some(model) = entry.as_str() {
                models.push(model.to_string());
            }
        }
    }

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_codex_text_from_stream_events() {
        let raw = r#"data: {"type":"response.output_text.delta","delta":"Hello "}
data: {"type":"response.output_text.delta","delta":"world"}
data: {"type":"response.completed","response":{"output_text":"Hello world"}}
data: [DONE]
"#;

        let output =
            extract_openai_codex_stream_output_text(raw).expect("expected stream output text");
        assert_eq!(output, "Hello world");
    }

    #[test]
    fn extracts_codex_text_from_json_payload() {
        let raw = r#"{"output_text":"Direct output"}"#;
        let output =
            extract_openai_codex_stream_output_text(raw).expect("expected json output text");
        assert_eq!(output, "Direct output");
    }

    #[test]
    fn disables_thinking_for_qwen35_local_llm() {
        let provider = PostProcessProvider {
            id: LOCAL_LLM_PROVIDER_ID.to_string(),
            label: "Local".to_string(),
            base_url: "http://127.0.0.1:1/v1".to_string(),
        };

        let kwargs = local_llm_chat_template_kwargs(&provider, "qwen3.5-0.8b")
            .expect("expected qwen3.5 local kwargs");
        assert!(!kwargs.enable_thinking);
    }

    #[test]
    fn leaves_other_local_models_unchanged() {
        let provider = PostProcessProvider {
            id: LOCAL_LLM_PROVIDER_ID.to_string(),
            label: "Local".to_string(),
            base_url: "http://127.0.0.1:1/v1".to_string(),
        };

        assert!(local_llm_chat_template_kwargs(&provider, "qwen3-0.6b").is_none());
    }

    #[test]
    fn accepts_only_loopback_urls_for_local_llm() {
        assert_eq!(
            normalize_local_llm_base_url("http://127.0.0.1:45871/v1/"),
            Some("http://127.0.0.1:45871/v1".to_string())
        );
        assert_eq!(
            normalize_local_llm_base_url("http://localhost:45871/v1"),
            Some("http://localhost:45871/v1".to_string())
        );
        assert!(normalize_local_llm_base_url("http://0.0.0.0:45871/v1").is_none());
        assert!(normalize_local_llm_base_url("http://192.168.1.10:45871/v1").is_none());
    }

    #[test]
    fn falls_back_to_loopback_for_invalid_local_llm_base_url() {
        assert_eq!(
            resolve_local_llm_base_url("http://0.0.0.0:45871/v1", None),
            LOCAL_LLM_FALLBACK_BASE_URL
        );
        assert_eq!(
            resolve_local_llm_base_url(
                "http://127.0.0.1:45871/v1",
                Some("http://192.168.1.10:45871/v1"),
            ),
            "http://127.0.0.1:45871/v1"
        );
        assert_eq!(
            resolve_local_llm_base_url(
                "http://127.0.0.1:45871/v1",
                Some("http://127.0.0.1:49152/v1"),
            ),
            "http://127.0.0.1:49152/v1"
        );
    }

    #[test]
    fn strips_empty_qwen35_think_blocks() {
        let provider = PostProcessProvider {
            id: LOCAL_LLM_PROVIDER_ID.to_string(),
            label: "Local".to_string(),
            base_url: "http://127.0.0.1:1/v1".to_string(),
        };

        let sanitized =
            sanitize_local_llm_output(&provider, "qwen3.5-0.8b", "<think>\n\n</think>\n\nhello");
        assert_eq!(sanitized, "hello");
    }
}
