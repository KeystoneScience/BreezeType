use crate::voice_commands;
use log::debug;
#[cfg(target_os = "linux")]
use log::{info, warn};
use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use strsim::levenshtein;
use tauri::AppHandle;

#[derive(Clone, Debug)]
struct AppCandidate {
    name: String,
    path: PathBuf,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    desktop_id: Option<String>,
}

pub fn open_app_from_command(app: &AppHandle, query: &str) -> Result<(), String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Open command missing app name".into());
    }

    let mut lookup = query.to_string();
    if let Some(target) = voice_commands::resolve_open_command(app, query) {
        if Path::new(&target).exists() {
            return open_path(Path::new(&target));
        }
        lookup = target;
    }

    let lookup = normalize_open_query(&lookup);
    if lookup.is_empty() {
        return Err("Open command missing app name".into());
    }

    let candidates = list_installed_apps()?;
    let matched = find_best_match(&lookup, &candidates)
        .ok_or_else(|| format!("No application found matching '{}'", lookup))?;
    open_candidate(matched)
}

fn list_installed_apps() -> Result<Vec<AppCandidate>, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(collect_macos_apps());
    }
    #[cfg(target_os = "windows")]
    {
        return Ok(collect_windows_apps());
    }
    #[cfg(target_os = "linux")]
    {
        return Ok(collect_linux_apps());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Unsupported platform for open command".into())
    }
}

fn open_candidate(candidate: &AppCandidate) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if let Some(id) = candidate.desktop_id.as_ref() {
            if try_gtk_launch(id) {
                info!("Opened app via gtk-launch: {}", candidate.name);
                return Ok(());
            }
        }
    }

    open_path(&candidate.path)
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(path)
            .status()
            .map_err(|e| format!("Failed to run open: {}", e))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("Failed to open {}", path.display()));
    }
    #[cfg(target_os = "windows")]
    {
        let path_str = path
            .to_str()
            .ok_or_else(|| "Invalid path for open command".to_string())?;
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "", path_str])
            .status()
            .map_err(|e| format!("Failed to run start: {}", e))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("Failed to open {}", path.display()));
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|e| format!("Failed to run xdg-open: {}", e))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("Failed to open {}", path.display()));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err("Unsupported platform for open command".into())
    }
}

#[cfg(target_os = "linux")]
fn try_gtk_launch(id: &str) -> bool {
    std::process::Command::new("gtk-launch")
        .arg(id)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn find_best_match<'a>(query: &str, candidates: &'a [AppCandidate]) -> Option<&'a AppCandidate> {
    let query_key = normalize_match_key(query);
    if query_key.is_empty() {
        return None;
    }

    let mut best: Option<(&AppCandidate, usize, usize)> = None;
    for candidate in candidates {
        let name_key = normalize_match_key(&candidate.name);
        if name_key.is_empty() {
            continue;
        }
        let token_match = tokenize_name(&candidate.name)
            .iter()
            .any(|token| token == &query_key);
        let distance = if token_match {
            0
        } else {
            levenshtein(&query_key, &name_key)
        };

        match best {
            None => best = Some((candidate, distance, name_key.len())),
            Some((_, best_distance, best_len)) => {
                if distance < best_distance
                    || (distance == best_distance && name_key.len() < best_len)
                {
                    best = Some((candidate, distance, name_key.len()));
                }
            }
        }
    }

    let (candidate, distance, candidate_len) = best?;
    let max_len = query_key.len().max(candidate_len);
    let ratio = if max_len > 0 {
        distance as f32 / max_len as f32
    } else {
        1.0
    };
    let acceptable = distance == 0 || distance <= 2 || ratio <= 0.2;
    if acceptable {
        return Some(candidate);
    }

    let candidate_key = normalize_match_key(&candidate.name);
    if candidate_len >= query_key.len()
        && candidate_key.contains(&query_key)
        && query_key.len() >= 4
    {
        return Some(candidate);
    }

    debug!(
        "Open command match rejected for '{}': best '{}' distance {}",
        query, candidate.name, distance
    );
    None
}

fn normalize_match_key(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn tokenize_name(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in input.chars() {
        if ch.is_alphanumeric() {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            tokens.push(current);
            current = String::new();
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn normalize_open_query(query: &str) -> String {
    let mut parts: Vec<&str> = query.split_whitespace().collect();
    while let Some(last) = parts.last() {
        if last.eq_ignore_ascii_case("app") || last.eq_ignore_ascii_case("application") {
            parts.pop();
        } else {
            break;
        }
    }
    parts.join(" ")
}

#[cfg(target_os = "macos")]
fn collect_macos_apps() -> Vec<AppCandidate> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Ok(home) = env::var("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }

    let mut candidates = Vec::new();
    let mut queue = VecDeque::new();
    for root in roots {
        if root.exists() {
            queue.push_back(root);
        }
    }

    while let Some(dir) = queue.pop_front() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) => {
                debug!("Failed to read app directory {}: {}", dir.display(), err);
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let is_app_bundle = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("app"))
                    .unwrap_or(false);
                if is_app_bundle {
                    if let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) {
                        candidates.push(AppCandidate {
                            name: name.to_string(),
                            path,
                            desktop_id: None,
                        });
                    }
                } else {
                    queue.push_back(path);
                }
            }
        }
    }

    candidates
}

#[cfg(target_os = "windows")]
fn collect_windows_apps() -> Vec<AppCandidate> {
    let mut roots = Vec::new();
    if let Ok(program_data) = env::var("ProgramData") {
        roots.push(PathBuf::from(program_data).join("Microsoft/Windows/Start Menu/Programs"));
    } else {
        roots.push(PathBuf::from(
            "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
        ));
    }
    if let Ok(app_data) = env::var("APPDATA") {
        roots.push(PathBuf::from(app_data).join("Microsoft/Windows/Start Menu/Programs"));
    }
    collect_apps_with_extension(roots, "lnk", None)
}

#[cfg(target_os = "linux")]
fn collect_linux_apps() -> Vec<AppCandidate> {
    let mut roots = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
    ];
    if let Ok(home) = env::var("HOME") {
        roots.push(PathBuf::from(home).join(".local/share/applications"));
    }

    let candidates = collect_apps_with_extension(roots, "desktop", Some(parse_desktop_name));
    if candidates.is_empty() {
        warn!("No desktop entries found for open command");
    }
    candidates
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn collect_apps_with_extension(
    roots: Vec<PathBuf>,
    extension: &str,
    name_loader: Option<fn(&Path) -> Option<String>>,
) -> Vec<AppCandidate> {
    let mut candidates = Vec::new();
    let mut queue = VecDeque::new();
    for root in roots {
        if root.exists() {
            queue.push_back(root);
        }
    }

    while let Some(dir) = queue.pop_front() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) => {
                debug!("Failed to read app directory {}: {}", dir.display(), err);
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push_back(path);
                continue;
            }
            let ext_matches = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case(extension))
                .unwrap_or(false);
            if !ext_matches {
                continue;
            }

            let name = if let Some(loader) = name_loader {
                loader(&path)
            } else {
                None
            }
            .or_else(|| {
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(|stem| stem.to_string())
            });

            let Some(name) = name else { continue };
            let desktop_id = if extension.eq_ignore_ascii_case("desktop") {
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(|stem| stem.to_string())
            } else {
                None
            };
            candidates.push(AppCandidate {
                name,
                path,
                desktop_id,
            });
        }
    }

    candidates
}

#[cfg(target_os = "linux")]
fn parse_desktop_name(path: &Path) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with("Name=") {
            return Some(line.trim_start_matches("Name=").trim().to_string());
        }
    }
    None
}
