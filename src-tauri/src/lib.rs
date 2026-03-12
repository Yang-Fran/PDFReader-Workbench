use serde::{Deserialize, Serialize};
use std::{
  ffi::OsStr,
  fs,
  path::{Path, PathBuf},
  process::Command,
};

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
  app.exit(0);
}

#[tauri::command]
fn log_event(line: String) {
  println!("{line}");
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
  fs::read(path).map_err(|e| format!("read file error: {e}"))
}

#[tauri::command]
fn read_text_file_any(path: String) -> Result<String, String> {
  fs::read_to_string(path).map_err(|e| format!("read text file error: {e}"))
}

#[tauri::command]
fn write_text_file_any(path: String, content: String) -> Result<(), String> {
  if let Some(parent) = Path::new(&path).parent() {
    fs::create_dir_all(parent).map_err(|e| format!("create parent dir error: {e}"))?;
  }
  fs::write(path, content).map_err(|e| format!("write text file error: {e}"))
}

#[tauri::command]
fn get_startup_project_path() -> Option<String> {
  std::env::args()
    .skip(1)
    .find(|arg| arg.to_ascii_lowercase().ends_with(".pdfwb") && Path::new(arg).is_file())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  if !(url.starts_with("http://") || url.starts_with("https://")) {
    return Err("only http/https urls are allowed".into());
  }

  Command::new("cmd")
    .args(["/C", "start", "", &url])
    .spawn()
    .map_err(|e| format!("open url error: {e}"))?;
  Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
struct LlmMessage {
  role: String,
  content: String,
}

#[derive(Debug, Deserialize)]
struct LlmChoiceMessage {
  content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LlmChoice {
  message: Option<LlmChoiceMessage>,
}

#[derive(Debug, Deserialize)]
struct LlmResponse {
  choices: Option<Vec<LlmChoice>>,
}

#[tauri::command]
async fn llm_chat_proxy(endpoint: String, api_key: String, model: String, messages: Vec<LlmMessage>) -> Result<String, String> {
  let client = reqwest::Client::new();
  let payload = serde_json::json!({
    "model": model,
    "messages": messages
  });

  let response = client
    .post(endpoint)
    .bearer_auth(api_key)
    .header("Content-Type", "application/json")
    .json(&payload)
    .send()
    .await
    .map_err(|e| format!("network error: {e}"))?;

  let status = response.status();
  let text = response.text().await.map_err(|e| format!("read body error: {e}"))?;
  if !status.is_success() {
    return Err(format!("http {} {}", status.as_u16(), text));
  }

  let parsed: LlmResponse = serde_json::from_str(&text).map_err(|e| format!("json parse error: {e}; body={text}"))?;
  let content = parsed
    .choices
    .and_then(|v| v.into_iter().next())
    .and_then(|c| c.message)
    .and_then(|m| m.content)
    .unwrap_or_default();
  Ok(content)
}

#[derive(Debug, Deserialize)]
struct NamedTextFile {
  name: String,
  content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheFileRecord {
  name: String,
  bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheSummary {
  translation_cache_bytes: u64,
  translation_cache_files: usize,
  llm_cache_bytes: u64,
  llm_cache_files: usize,
  translation_files: Vec<CacheFileRecord>,
  llm_files: Vec<CacheFileRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileRef {
  id: String,
  path: String,
  name: String,
  relative_path: String,
  kind: String,
  mounted: bool,
}

fn project_dir_from_path(project_path: &str) -> Result<PathBuf, String> {
  let project = PathBuf::from(project_path);
  let parent = project
    .parent()
    .map(Path::to_path_buf)
    .ok_or_else(|| "project path has no parent directory".to_string())?;
  Ok(fs::canonicalize(&parent).unwrap_or(parent))
}

fn cache_dir(project_path: &str, kind: &str) -> Result<PathBuf, String> {
  let project_dir = project_dir_from_path(project_path)?;
  let dir_name = match kind {
    "translation" => "translation_cache",
    "llm" => "llm_cache",
    _ => return Err("invalid cache kind".into()),
  };
  Ok(project_dir.join(dir_name))
}

fn ensure_dir(path: &Path) -> Result<(), String> {
  fs::create_dir_all(path).map_err(|e| format!("create dir error: {e}"))
}

fn scan_supported_files(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
  if !root.exists() {
    return Ok(());
  }

  for entry in fs::read_dir(root).map_err(|e| format!("read dir error: {e}"))? {
    let entry = entry.map_err(|e| format!("dir entry error: {e}"))?;
    let path = entry.path();
    if path.is_dir() {
      if let Some(name) = path.file_name().and_then(OsStr::to_str) {
        if name.eq_ignore_ascii_case("translation_cache") || name.eq_ignore_ascii_case("llm_cache") {
          continue;
        }
      }
      scan_supported_files(&path, out)?;
      continue;
    }

    if let Some(ext) = path.extension().and_then(OsStr::to_str) {
      let lower = ext.to_ascii_lowercase();
      if lower == "pdf" || lower == "md" {
        out.push(path);
      }
    }
  }

  Ok(())
}

fn file_size(path: &Path) -> u64 {
  fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn cache_summary_for_dir(path: &Path) -> Result<(u64, Vec<CacheFileRecord>), String> {
  ensure_dir(path)?;
  let mut total = 0_u64;
  let mut files = Vec::new();

  for entry in fs::read_dir(path).map_err(|e| format!("read cache dir error: {e}"))? {
    let entry = entry.map_err(|e| format!("cache entry error: {e}"))?;
    let file_path = entry.path();
    if !file_path.is_file() {
      continue;
    }
    let bytes = file_size(&file_path);
    total += bytes;
    files.push(CacheFileRecord {
      name: file_path.file_name().and_then(OsStr::to_str).unwrap_or_default().to_string(),
      bytes,
    });
  }

  files.sort_by(|a, b| a.name.cmp(&b.name));
  Ok((total, files))
}

#[tauri::command]
fn sync_project_cache(project_path: String, kind: String, files: Vec<NamedTextFile>) -> Result<Vec<String>, String> {
  let dir = cache_dir(&project_path, &kind)?;
  ensure_dir(&dir)?;

  for entry in fs::read_dir(&dir).map_err(|e| format!("read cache dir error: {e}"))? {
    let entry = entry.map_err(|e| format!("cache entry error: {e}"))?;
    let path = entry.path();
    if path.is_file() {
      fs::remove_file(path).map_err(|e| format!("remove cache file error: {e}"))?;
    }
  }

  let mut written = Vec::new();
  for file in files {
    let target = dir.join(&file.name);
    fs::write(&target, file.content).map_err(|e| format!("write cache file error: {e}"))?;
    written.push(file.name);
  }

  Ok(written)
}

#[tauri::command]
fn get_project_cache_summary(project_path: String) -> Result<CacheSummary, String> {
  let translation_dir = cache_dir(&project_path, "translation")?;
  let llm_dir = cache_dir(&project_path, "llm")?;
  let (translation_cache_bytes, translation_files) = cache_summary_for_dir(&translation_dir)?;
  let (llm_cache_bytes, llm_files) = cache_summary_for_dir(&llm_dir)?;

  Ok(CacheSummary {
    translation_cache_bytes,
    translation_cache_files: translation_files.len(),
    llm_cache_bytes,
    llm_cache_files: llm_files.len(),
    translation_files,
    llm_files,
  })
}

#[tauri::command]
fn clear_project_cache(project_path: String, kind: String) -> Result<CacheSummary, String> {
  let dir = cache_dir(&project_path, &kind)?;
  ensure_dir(&dir)?;

  for entry in fs::read_dir(&dir).map_err(|e| format!("read cache dir error: {e}"))? {
    let entry = entry.map_err(|e| format!("cache entry error: {e}"))?;
    let path = entry.path();
    if path.is_file() {
      fs::remove_file(path).map_err(|e| format!("remove cache file error: {e}"))?;
    }
  }

  get_project_cache_summary(project_path)
}

#[tauri::command]
fn list_project_library(project_path: String, mounted_paths: Vec<String>) -> Result<Vec<WorkspaceFileRef>, String> {
  let project_dir = project_dir_from_path(&project_path)?;
  ensure_dir(&project_dir)?;

  let mut files = Vec::new();
  scan_supported_files(&project_dir, &mut files)?;

  for mounted in mounted_paths {
    let path = PathBuf::from(mounted);
    if path.is_file() {
      files.push(path);
    }
  }

  let mut unique = std::collections::BTreeMap::new();
  for path in files {
    let canonical = fs::canonicalize(&path).unwrap_or(path.clone());
    let canonical_str = canonical.to_string_lossy().to_string();
    let name = canonical.file_name().and_then(OsStr::to_str).unwrap_or_default().to_string();
    let extension = canonical
      .extension()
      .and_then(OsStr::to_str)
      .unwrap_or_default()
      .to_ascii_lowercase();
    if extension != "pdf" && extension != "md" {
      continue;
    }
    let relative_path = canonical
      .strip_prefix(&project_dir)
      .map(|value| value.to_string_lossy().to_string())
      .unwrap_or_else(|_| format!("mounted/{}", name));
    unique.insert(
      canonical_str.clone(),
      WorkspaceFileRef {
        id: canonical_str.clone(),
        path: canonical_str,
        name,
        relative_path,
        kind: extension,
        mounted: canonical.strip_prefix(&project_dir).is_err(),
      },
    );
  }

  Ok(unique.into_values().collect())
}

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .invoke_handler(tauri::generate_handler![
      quit_app,
      log_event,
      llm_chat_proxy,
      read_binary_file,
      read_text_file_any,
      write_text_file_any,
      get_startup_project_path,
      open_external_url,
      sync_project_cache,
      get_project_cache_summary,
      clear_project_cache,
      list_project_library
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
