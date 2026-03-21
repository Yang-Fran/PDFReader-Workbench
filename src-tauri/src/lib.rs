use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsStr,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

#[cfg(target_os = "windows")]
mod native_pdf_export_windows;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDebugEvent {
    stage: String,
    detail: String,
    at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDebugStatus {
    ready: bool,
    error: String,
    stage: String,
    events: Vec<ExportDebugEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePdfExportResult {
    runtime_label: String,
    status: ExportDebugStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePdfExportFailure {
    message: String,
    status: Option<ExportDebugStatus>,
}

#[cfg(target_os = "windows")]
fn check_native_pdf_export_runtime() -> Result<String, String> {
    native_pdf_export_windows::check_runtime()
}

#[cfg(not(target_os = "windows"))]
fn check_native_pdf_export_runtime() -> Result<String, String> {
    Err("Native WebView PDF export is currently implemented for Windows only.".into())
}

#[cfg(target_os = "windows")]
fn export_html_via_native_webview(
    app: &tauri::AppHandle,
    html_path: &Path,
    output_path: &Path,
    options: &PdfExportOptions,
) -> Result<NativePdfExportResult, NativePdfExportFailure> {
    native_pdf_export_windows::export_html_file_to_pdf(app, html_path, output_path, options)
}

#[cfg(not(target_os = "windows"))]
fn export_html_via_native_webview(
    _app: &tauri::AppHandle,
    _html_path: &Path,
    _output_path: &Path,
    _options: &PdfExportOptions,
) -> Result<NativePdfExportResult, NativePdfExportFailure> {
    Err(NativePdfExportFailure {
        message: "Native WebView PDF export is currently implemented for Windows only."
            .into(),
        status: None,
    })
}

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

fn export_debug_log_path() -> PathBuf {
    env::temp_dir().join("pdfreader-export-debug.log")
}

fn append_export_debug_log(message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let line = format!("[{timestamp}] {message}\n");
    print!("{line}");
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(export_debug_log_path())
    {
        let _ = file.write_all(line.as_bytes());
    }
}

fn create_export_session_dir(stamp: u128) -> Result<PathBuf, String> {
    let session_dir = env::temp_dir().join(format!("pdfreader-export-session-{stamp}"));
    fs::create_dir_all(&session_dir)
        .map_err(|e| format!("create export session dir error: {e}"))?;
    Ok(session_dir)
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|e| format!("serialize debug json error: {e}"))?;
    fs::write(path, serialized).map_err(|e| format!("write debug json error: {e}"))
}

fn describe_export_status(status: &ExportDebugStatus) -> String {
    let stage = if status.stage.is_empty() {
        "unknown"
    } else {
        &status.stage
    };
    let tail = status
        .events
        .iter()
        .rev()
        .take(3)
        .map(|event| format!("{}@{}ms({})", event.stage, event.at_ms, event.detail))
        .collect::<Vec<_>>()
        .join(", ");
    if tail.is_empty() {
        format!("stage={stage}")
    } else {
        format!("stage={stage}; recent_events=[{tail}]")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfExportMargins {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfExportNativeHeaderFooter {
    enabled: bool,
    header_title: String,
    footer_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfExportOptions {
    page_size: String,
    landscape: bool,
    scale: f64,
    margins: PdfExportMargins,
    native_header_footer: Option<PdfExportNativeHeaderFooter>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportSessionRequest {
    output_path: String,
    options: PdfExportOptions,
}

#[derive(Debug, Serialize)]
struct PdfExportEnvironmentCheckResult {
    checked: bool,
    runtime_label: Option<String>,
    ok: bool,
    error: Option<String>,
}

#[tauri::command]
fn check_pdf_export_environment(
    options: PdfExportOptions,
) -> Result<PdfExportEnvironmentCheckResult, String> {
    append_export_debug_log(&format!(
        "Environment check start page_size={} landscape={} native_header_footer={} output_mode=native-webview",
        options.page_size,
        options.landscape,
        options
            .native_header_footer
            .as_ref()
            .map(|value| value.enabled)
            .unwrap_or(false)
    ));
    let mut runtime_label = None;
    let (ok, error) = match check_native_pdf_export_runtime() {
        Ok(label) => {
            runtime_label = Some(label.clone());
            (true, None)
        }
        Err(error) => (false, Some(error)),
    };
    Ok(PdfExportEnvironmentCheckResult {
        checked: true,
        runtime_label,
        ok,
        error,
    })
}

#[tauri::command]
async fn export_markdown_pdf(
    app: tauri::AppHandle,
    html: String,
    output_path: String,
    options: PdfExportOptions,
) -> Result<(), String> {
    append_export_debug_log(&format!(
        "Export start page_size={} landscape={} scale={} native_header_footer={} backend=native-webview output={}",
        options.page_size,
        options.landscape,
        options.scale,
        options
            .native_header_footer
            .as_ref()
            .map(|value| value.enabled)
            .unwrap_or(false),
        output_path
    ));
    let output = PathBuf::from(&output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create output dir error: {e}"))?;
    }

    let size_lower = options.page_size.to_ascii_lowercase();
    let supported_page_size = size_lower == "a4" || size_lower == "letter";
    if !supported_page_size {
        return Err("unsupported PDF export settings".into());
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("clock error: {e}"))?
        .as_millis();
    let session_dir = create_export_session_dir(stamp)?;

    let temp_html = session_dir.join("notes-export.html");
    fs::write(&temp_html, html).map_err(|e| format!("write temp html error: {e}"))?;
    write_json_file(
        &session_dir.join("export-request.json"),
        &ExportSessionRequest {
            output_path: output.to_string_lossy().to_string(),
            options: options.clone(),
        },
    )?;
    append_export_debug_log(&format!(
        "Native export session={} html={} output={}",
        session_dir.to_string_lossy(),
        temp_html.to_string_lossy(),
        output.to_string_lossy()
    ));

    match export_html_via_native_webview(&app, &temp_html, &output, &options) {
        Ok(result) => {
            write_json_file(&session_dir.join("native-export-result.json"), &result)?;
            append_export_debug_log(&format!(
                "Native export success runtime={} output={} {}",
                result.runtime_label,
                output.to_string_lossy()
                ,
                describe_export_status(&result.status)
            ));
            Ok(())
        }
        Err(error) => {
            write_json_file(&session_dir.join("native-export-error.json"), &error)?;
            append_export_debug_log(&format!(
                "Native export failure html={} output={} error={} {}",
                temp_html.to_string_lossy(),
                output.to_string_lossy()
                ,
                error.message,
                error
                    .status
                    .as_ref()
                    .map(describe_export_status)
                    .unwrap_or_else(|| "stage=unknown".to_string())
            ));
            let debug_log = export_debug_log_path().to_string_lossy().to_string();
            let status_detail = error
                .status
                .as_ref()
                .map(describe_export_status)
                .unwrap_or_else(|| "stage=unknown".to_string());
            Err(format!(
                "native export failed: {} ({status_detail}). Session: {}. HTML: {}. Debug log: {debug_log}.",
                error.message,
                session_dir.to_string_lossy(),
                temp_html.to_string_lossy()
            ))
        }
    }
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

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim().trim_matches('"'));
    if !target.exists() {
        return Err("path does not exist".into());
    }

    Command::new("cmd")
        .args(["/C", "start", "", &target.to_string_lossy()])
        .spawn()
        .map_err(|e| format!("open path error: {e}"))?;
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

#[derive(Debug, Deserialize)]
struct LlmStreamDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LlmStreamChoice {
    delta: Option<LlmStreamDelta>,
}

#[derive(Debug, Deserialize)]
struct LlmStreamResponse {
    choices: Option<Vec<LlmStreamChoice>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LlmStreamEvent {
    request_id: String,
    content: Option<String>,
    reasoning: Option<String>,
    done: bool,
    error: Option<String>,
}

#[tauri::command]
async fn llm_chat_proxy(
    endpoint: String,
    api_key: String,
    model: String,
    messages: Vec<LlmMessage>,
) -> Result<String, String> {
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
    let text = response
        .text()
        .await
        .map_err(|e| format!("read body error: {e}"))?;
    if !status.is_success() {
        return Err(format!("http {} {}", status.as_u16(), text));
    }

    let parsed: LlmResponse =
        serde_json::from_str(&text).map_err(|e| format!("json parse error: {e}; body={text}"))?;
    let content = parsed
        .choices
        .and_then(|v| v.into_iter().next())
        .and_then(|c| c.message)
        .and_then(|m| m.content)
        .unwrap_or_default();
    Ok(content)
}

fn emit_llm_stream_event(app: &tauri::AppHandle, event: LlmStreamEvent) {
    let _ = app.emit("llm-stream-chunk", event);
}

fn process_sse_block(app: &tauri::AppHandle, request_id: &str, block: &str) -> Result<(), String> {
    let data_lines = block
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();

    for data in data_lines {
        if data == "[DONE]" {
            emit_llm_stream_event(
                app,
                LlmStreamEvent {
                    request_id: request_id.to_string(),
                    content: None,
                    reasoning: None,
                    done: true,
                    error: None,
                },
            );
            continue;
        }

        let parsed: LlmStreamResponse = serde_json::from_str(data)
            .map_err(|e| format!("stream json parse error: {e}; chunk={data}"))?;
        let delta = parsed
            .choices
            .and_then(|choices| choices.into_iter().next())
            .and_then(|choice| choice.delta);
        let content = delta.as_ref().and_then(|item| item.content.clone());
        let reasoning = delta.and_then(|item| item.reasoning_content);

        if content.as_deref().unwrap_or("").is_empty()
            && reasoning.as_deref().unwrap_or("").is_empty()
        {
            continue;
        }

        emit_llm_stream_event(
            app,
            LlmStreamEvent {
                request_id: request_id.to_string(),
                content,
                reasoning,
                done: false,
                error: None,
            },
        );
    }

    Ok(())
}

#[tauri::command]
async fn llm_chat_proxy_stream(
    app: tauri::AppHandle,
    request_id: String,
    endpoint: String,
    api_key: String,
    model: String,
    messages: Vec<LlmMessage>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
      "model": model,
      "messages": messages,
      "stream": true
    });

    let mut response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .map_err(|e| format!("read body error: {e}"))?;
        return Err(format!("http {} {}", status.as_u16(), text));
    }

    let mut buffer = String::new();
    let mut done_emitted = false;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("stream read error: {e}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
        while let Some(boundary) = buffer.find("\n\n") {
            let block = buffer[..boundary].to_string();
            buffer = buffer[boundary + 2..].to_string();
            process_sse_block(&app, &request_id, &block)?;
            if block.lines().any(|line| line.trim() == "data: [DONE]") {
                done_emitted = true;
            }
        }
    }

    if !buffer.trim().is_empty() {
        process_sse_block(&app, &request_id, &buffer)?;
        if buffer.lines().any(|line| line.trim() == "data: [DONE]") {
            done_emitted = true;
        }
    }

    if !done_emitted {
        emit_llm_stream_event(
            &app,
            LlmStreamEvent {
                request_id,
                content: None,
                reasoning: None,
                done: true,
                error: None,
            },
        );
    }

    Ok(())
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
                if name.eq_ignore_ascii_case("translation_cache")
                    || name.eq_ignore_ascii_case("llm_cache")
                {
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
            name: file_path
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or_default()
                .to_string(),
            bytes,
        });
    }

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((total, files))
}

#[tauri::command]
fn sync_project_cache(
    project_path: String,
    kind: String,
    files: Vec<NamedTextFile>,
) -> Result<Vec<String>, String> {
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
fn list_project_library(
    project_path: String,
    mounted_paths: Vec<String>,
) -> Result<Vec<WorkspaceFileRef>, String> {
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
        let name = canonical
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_string();
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
            llm_chat_proxy_stream,
            read_binary_file,
            read_text_file_any,
            write_text_file_any,
            check_pdf_export_environment,
            export_markdown_pdf,
            get_startup_project_path,
            open_external_url,
            open_path,
            sync_project_cache,
            get_project_cache_summary,
            clear_project_cache,
            list_project_library
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
