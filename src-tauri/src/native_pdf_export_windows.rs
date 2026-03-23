use crate::{ExportDebugStatus, NativePdfExportFailure, NativePdfExportResult, PdfExportOptions};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::{
    env, fs,
    io::Write,
    path::Path,
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR, ExecuteScriptCompletedHandler,
    PrintToPdfCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
        ICoreWebView2, ICoreWebView2_2, ICoreWebView2_7, ICoreWebView2Environment6,
        ICoreWebView2PrintSettings,
    },
};
use windows::core::Interface;

#[derive(Deserialize)]
struct DevToolsPrintToPdfResult {
    data: String,
}

fn append_native_export_log(message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let line = format!("[{timestamp}] [native] {message}\n");
    print!("{line}");
    let path = env::temp_dir().join("pdfreader-export-debug.log");
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn file_url(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let prefixed = if raw.starts_with('/') {
        raw
    } else {
        format!("/{raw}")
    };
    format!(
        "file://{}",
        prefixed
            .replace('%', "%25")
            .replace(' ', "%20")
            .replace('#', "%23")
            .replace('?', "%3F")
    )
}

fn execute_script_string(webview: &ICoreWebView2, script: &str) -> Result<String, String> {
    let webview = webview.clone();
    let script = script.to_string();
    let (tx, rx) = mpsc::channel();

    ExecuteScriptCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            let script = CoTaskMemPWSTR::from(script.as_str());
            webview
                .ExecuteScript(*script.as_ref().as_pcwstr(), &handler)
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error_code, result| {
            error_code?;
            let _ = tx.send(result);
            Ok(())
        }),
    )
    .map_err(|error| format!("execute WebView2 script error: {error}"))?;

    rx.recv()
        .map_err(|_| "receive WebView2 script result error".to_string())
}

fn execute_script_json<T: DeserializeOwned>(
    webview: &ICoreWebView2,
    script: &str,
) -> Result<T, String> {
    let raw = execute_script_string(webview, script)?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("parse WebView2 script result error: {error}; raw={raw}"))
}

fn read_export_status(webview: &ICoreWebView2) -> Result<ExportDebugStatus, String> {
    execute_script_json(
        webview,
        r#"(() => {
            const status = window.__PDF_EXPORT_STATUS__ || {};
            const events = Array.isArray(status.events) ? status.events : [];
            return {
                ready: Boolean(window.__PDF_EXPORT_READY__ || status.ready),
                error: String(window.__PDF_EXPORT_ERROR__ || status.error || ""),
                stage: String(status.stage || ""),
                events: events.map((event) => ({
                    stage: String(event && event.stage ? event.stage : ""),
                    detail: String(event && event.detail ? event.detail : ""),
                    atMs: Number(event && event.atMs ? event.atMs : 0)
                }))
            };
        })()"#,
    )
}

fn wait_for_export_ready(webview: &ICoreWebView2) -> Result<ExportDebugStatus, String> {
    append_native_export_log("wait_for_export_ready:start");
    let started = Instant::now();
    let timeout = Duration::from_secs(60);

    loop {
        let status = read_export_status(webview)?;

        if !status.error.is_empty() {
            let stage = if status.stage.is_empty() {
                "unknown"
            } else {
                &status.stage
            };
            return Err(format!(
                "export page reported an error at stage {stage}: {}",
                status.error
            ));
        }

        if status.ready {
            append_native_export_log(&format!(
                "wait_for_export_ready:done stage={} error={}",
                status.stage, status.error
            ));
            return Ok(status);
        }

        if started.elapsed() > timeout {
            let stage = if status.stage.is_empty() {
                "unknown"
            } else {
                &status.stage
            };
            return Err(format!(
                "timed out waiting for export page readiness at stage {stage}"
            ));
        }

        thread::sleep(Duration::from_millis(150));
    }
}

fn mm_to_inches(value: f64) -> f64 {
    value / 25.4
}

fn page_dimensions_in_inches(page_size: &str, landscape: bool) -> (f64, f64) {
    let (width_mm, height_mm) = if page_size.eq_ignore_ascii_case("letter") {
        (215.9, 279.4)
    } else {
        (210.0, 297.0)
    };

    if landscape {
        (mm_to_inches(height_mm), mm_to_inches(width_mm))
    } else {
        (mm_to_inches(width_mm), mm_to_inches(height_mm))
    }
}

fn decode_base64_value(value: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut quartet = [0u8; 4];
    let mut quartet_len = 0usize;
    let mut saw_padding = false;

    for byte in value.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        let next = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => return Err(format!("unexpected base64 character: {}", byte as char)),
        };

        if saw_padding && next != 64 {
            return Err("unexpected data after base64 padding".into());
        }

        quartet[quartet_len] = next;
        quartet_len += 1;

        if quartet_len == 4 {
            if quartet[0] == 64 || quartet[1] == 64 {
                return Err("invalid base64 padding placement".into());
            }

            output.push((quartet[0] << 2) | (quartet[1] >> 4));

            if quartet[2] == 64 {
                if quartet[3] != 64 {
                    return Err("invalid base64 padding placement".into());
                }
                saw_padding = true;
            } else {
                output.push((quartet[1] << 4) | (quartet[2] >> 2));
                if quartet[3] == 64 {
                    saw_padding = true;
                } else {
                    output.push((quartet[2] << 6) | quartet[3]);
                }
            }

            quartet_len = 0;
        }
    }

    if quartet_len != 0 {
        return Err("invalid base64 length".into());
    }

    Ok(output)
}

fn call_devtools_protocol_method(
    webview: &ICoreWebView2,
    method_name: &str,
    parameters: &str,
) -> Result<String, String> {
    let webview = webview.clone();
    let method_name = method_name.to_string();
    let parameters = parameters.to_string();
    let (tx, rx) = mpsc::channel();

    CallDevToolsProtocolMethodCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            let method_name = CoTaskMemPWSTR::from(method_name.as_str());
            let parameters = CoTaskMemPWSTR::from(parameters.as_str());
            webview
                .CallDevToolsProtocolMethod(
                    *method_name.as_ref().as_pcwstr(),
                    *parameters.as_ref().as_pcwstr(),
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error_code, result| {
            error_code?;
            let _ = tx.send(result);
            Ok(())
        }),
    )
    .map_err(|error| format!("CallDevToolsProtocolMethod failed: {error}"))?;

    rx.recv()
        .map_err(|_| "receive CallDevToolsProtocolMethod result error".to_string())
}

fn create_print_settings(
    webview: &ICoreWebView2,
    options: &PdfExportOptions,
) -> Result<ICoreWebView2PrintSettings, String> {
    append_native_export_log("create_print_settings:start");
    let webview: ICoreWebView2_2 = webview
        .cast()
        .map_err(|error| format!("WebView2 environment API unavailable: {error}"))?;
    let environment = unsafe { webview.Environment() }
        .map_err(|error| format!("read WebView2 environment error: {error}"))?;
    let environment: ICoreWebView2Environment6 = environment
        .cast()
        .map_err(|error| format!("WebView2 print settings API unavailable: {error}"))?;
    let settings = unsafe { environment.CreatePrintSettings() }
        .map_err(|error| format!("create WebView2 print settings error: {error}"))?;

    let (page_width, page_height) =
        page_dimensions_in_inches(&options.page_size, options.landscape);
    let orientation = if options.landscape {
        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
    } else {
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
    };

    unsafe {
        settings
            .SetShouldPrintBackgrounds(true)
            .map_err(|error| format!("set print backgrounds error: {error}"))?;
        settings
            .SetOrientation(orientation)
            .map_err(|error| format!("set print orientation error: {error}"))?;
        settings
            .SetPageWidth(page_width)
            .map_err(|error| format!("set print page width error: {error}"))?;
        settings
            .SetPageHeight(page_height)
            .map_err(|error| format!("set print page height error: {error}"))?;
        settings
            .SetMarginTop(mm_to_inches(options.margins.top))
            .map_err(|error| format!("set print top margin error: {error}"))?;
        settings
            .SetMarginRight(mm_to_inches(options.margins.right))
            .map_err(|error| format!("set print right margin error: {error}"))?;
        settings
            .SetMarginBottom(mm_to_inches(options.margins.bottom))
            .map_err(|error| format!("set print bottom margin error: {error}"))?;
        settings
            .SetMarginLeft(mm_to_inches(options.margins.left))
            .map_err(|error| format!("set print left margin error: {error}"))?;
    }

    if let Some(native_header_footer) = options
        .native_header_footer
        .as_ref()
        .filter(|value| value.enabled)
    {
        unsafe {
            settings
                .SetShouldPrintHeaderAndFooter(true)
                .map_err(|error| format!("enable native print header/footer error: {error}"))?;

            let header_title = CoTaskMemPWSTR::from(native_header_footer.header_title.as_str());
            settings
                .SetHeaderTitle(*header_title.as_ref().as_pcwstr())
                .map_err(|error| format!("set native print header title error: {error}"))?;

            let footer_uri = CoTaskMemPWSTR::from(native_header_footer.footer_uri.as_str());
            settings
                .SetFooterUri(*footer_uri.as_ref().as_pcwstr())
                .map_err(|error| format!("set native print footer uri error: {error}"))?;
        }
    } else {
        unsafe {
            settings
                .SetShouldPrintHeaderAndFooter(false)
                .map_err(|error| format!("disable native print header/footer error: {error}"))?;
        }
    }

    append_native_export_log("create_print_settings:done");
    Ok(settings)
}

fn print_to_pdf_with_webview_api(
    webview: &ICoreWebView2,
    output_path: &Path,
    options: &PdfExportOptions,
) -> Result<(), String> {
    append_native_export_log(&format!(
        "print_to_pdf_with_webview_api:start output={}",
        output_path.to_string_lossy()
    ));
    let output = output_path.to_string_lossy().to_string();
    let print_settings = create_print_settings(webview, options)?;
    let webview: ICoreWebView2_7 = webview
        .cast()
        .map_err(|error| format!("WebView2 PrintToPdf API unavailable: {error}"))?;
    let (tx, rx) = mpsc::channel();

    PrintToPdfCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            let output = CoTaskMemPWSTR::from(output.as_str());
            webview
                .PrintToPdf(
                    *output.as_ref().as_pcwstr(),
                    &print_settings,
                    &handler,
                )
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error_code, completed| {
            error_code?;
            let _ = tx.send(completed);
            Ok(())
        }),
    )
    .map_err(|error| format!("PrintToPdf failed: {error}"))?;

    let result = match rx.recv() {
        Ok(true) => Ok(()),
        Ok(false) => Err("WebView2 PrintToPdf returned false".into()),
        Err(_) => Err("receive PrintToPdf completion result error".into()),
    };
    append_native_export_log(match &result {
        Ok(_) => "print_to_pdf_with_webview_api:done",
        Err(_) => "print_to_pdf_with_webview_api:error",
    });
    result
}

fn print_to_pdf_via_devtools(
    webview: &ICoreWebView2,
    output_path: &Path,
    options: &PdfExportOptions,
) -> Result<(), String> {
    append_native_export_log(&format!(
        "print_to_pdf_via_devtools:start output={} generate_outline={}",
        output_path.to_string_lossy(),
        options.generate_outline
    ));

    let (paper_width, paper_height) =
        page_dimensions_in_inches(&options.page_size, options.landscape);
    let parameters = serde_json::json!({
        "landscape": options.landscape,
        "displayHeaderFooter": false,
        "printBackground": true,
        "preferCSSPageSize": true,
        "paperWidth": paper_width,
        "paperHeight": paper_height,
        "marginTop": mm_to_inches(options.margins.top),
        "marginRight": mm_to_inches(options.margins.right),
        "marginBottom": mm_to_inches(options.margins.bottom),
        "marginLeft": mm_to_inches(options.margins.left),
        "scale": options.scale.clamp(0.1, 2.0),
        "generateTaggedPDF": true,
        "generateDocumentOutline": options.generate_outline
    });

    let raw_response =
        call_devtools_protocol_method(webview, "Page.printToPDF", &parameters.to_string())?;
    let response: DevToolsPrintToPdfResult = serde_json::from_str(&raw_response)
        .map_err(|error| format!("parse Page.printToPDF result error: {error}; raw={raw_response}"))?;
    let pdf_bytes = decode_base64_value(response.data.trim())?;
    if pdf_bytes.is_empty() {
        return Err("Page.printToPDF returned an empty PDF".into());
    }

    fs::write(output_path, pdf_bytes)
        .map_err(|error| format!("write Page.printToPDF output error: {error}"))?;
    append_native_export_log("print_to_pdf_via_devtools:done");
    Ok(())
}

fn print_to_pdf(
    webview: &ICoreWebView2,
    output_path: &Path,
    options: &PdfExportOptions,
) -> Result<(), String> {
    if options
        .native_header_footer
        .as_ref()
        .map(|value| value.enabled)
        .unwrap_or(false)
    {
        append_native_export_log(
            "print_to_pdf:native_header_footer_enabled_use_webview_api",
        );
        return print_to_pdf_with_webview_api(webview, output_path, options);
    }

    match print_to_pdf_via_devtools(webview, output_path, options) {
        Ok(()) => Ok(()),
        Err(error) => {
            append_native_export_log(&format!(
                "print_to_pdf:devtools_failed fallback=PrintToPdf error={error}"
            ));
            print_to_pdf_with_webview_api(webview, output_path, options)
        }
    }
}

fn build_export_window(
    app: &tauri::AppHandle,
    label: &str,
    html_path: &Path,
) -> Result<WebviewWindow<Wry>, String> {
    append_native_export_log("build_export_window:start");
    let url = Url::parse(&file_url(html_path))
        .map_err(|error| format!("parse export html file URL error: {error}"))?;

    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .visible(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(false)
        .inner_size(1280.0, 960.0)
        .position(-32000.0, -32000.0)
        .build()
        .map_err(|error| format!("build export webview window error: {error}"))?;

    append_native_export_log("build_export_window:done");
    Ok(window)
}

fn export_window_to_pdf(
    window: WebviewWindow<Wry>,
    output_path: &Path,
    options: &PdfExportOptions,
) -> Result<NativePdfExportResult, NativePdfExportFailure> {
    let output_path = output_path.to_path_buf();
    let options = options.clone();
    let close_window = window.clone();
    let (tx, rx) = mpsc::channel();

    window
        .with_webview(move |webview| {
            append_native_export_log("with_webview:start");
            let result = (|| -> Result<NativePdfExportResult, NativePdfExportFailure> {
                let controller = webview.controller();
                let core = unsafe {
                    controller
                        .CoreWebView2()
                        .map_err(|error| NativePdfExportFailure {
                            message: format!("obtain CoreWebView2 instance error: {error}"),
                            status: None,
                        })?
                };

                let ready_status = match wait_for_export_ready(&core) {
                    Ok(status) => status,
                    Err(message) => {
                        return Err(NativePdfExportFailure {
                            message,
                            status: read_export_status(&core).ok(),
                        });
                    }
                };

                if let Err(message) = print_to_pdf(&core, &output_path, &options) {
                    return Err(NativePdfExportFailure {
                        message,
                        status: read_export_status(&core)
                            .ok()
                            .or_else(|| Some(ready_status.clone())),
                    });
                }

                if !output_path.is_file() {
                    return Err(NativePdfExportFailure {
                        message: "PrintToPdf finished but no PDF file was produced".into(),
                        status: Some(ready_status),
                    });
                }

                Ok(NativePdfExportResult {
                    runtime_label: "System WebView2 Runtime".to_string(),
                    status: read_export_status(&core).unwrap_or_default(),
                })
            })();

            let _ = tx.send(result);
            append_native_export_log("with_webview:done");
        })
        .map_err(|error| NativePdfExportFailure {
            message: format!("schedule export webview access error: {error}"),
            status: None,
        })?;

    let result = rx
        .recv_timeout(Duration::from_secs(120))
        .map_err(|_| NativePdfExportFailure {
            message: "timed out waiting for export webview result".into(),
            status: None,
        });

    let _ = close_window.close();
    result.and_then(|value| value)
}

pub fn check_runtime() -> Result<String, String> {
    append_native_export_log("check_runtime:done");
    Ok("System WebView2 Runtime".to_string())
}

pub fn export_html_file_to_pdf(
    app: &tauri::AppHandle,
    html_path: &Path,
    output_path: &Path,
    options: &PdfExportOptions,
) -> Result<NativePdfExportResult, NativePdfExportFailure> {
    append_native_export_log(&format!(
        "export_html_file_to_pdf:start html={} output={} generate_outline={} native_header_footer={}",
        html_path.to_string_lossy(),
        output_path.to_string_lossy(),
        options.generate_outline,
        options
            .native_header_footer
            .as_ref()
            .map(|value| value.enabled)
            .unwrap_or(false)
    ));

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let label = format!("pdf-export-{stamp}");
    let window = build_export_window(app, &label, html_path).map_err(|message| {
        NativePdfExportFailure {
            message,
            status: None,
        }
    })?;

    let result = export_window_to_pdf(window, output_path, options);
    append_native_export_log(match &result {
        Ok(_) => "export_html_file_to_pdf:done",
        Err(_) => "export_html_file_to_pdf:error",
    });
    result
}
