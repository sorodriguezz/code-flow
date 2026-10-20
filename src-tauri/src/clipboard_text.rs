//! Text on the system clipboard, read and written with the platform's own tool (`pbcopy`/`pbpaste`,
//! `clip`/`Get-Clipboard`, `wl-copy`/`xclip`/`xsel`).
//!
//! # Why the webview's clipboard is not enough
//!
//! WebKit only lets `navigator.clipboard` act inside a user gesture, and decides what counts as one
//! itself: the terminal's copy-on-select runs a tick after the mouse-up (so it does not race xterm's
//! own selection), and by then WebKit refuses it with `NotAllowedError`. A read can also be refused
//! when the user dismisses WebKit's own "Paste" bubble. The page tries the webview first and falls
//! back to these commands (`lib/clipboard.ts`); Flujos' clipboard node and trigger use them directly.

/// Writes `text` to the system clipboard with the platform's own tool.
pub fn copy_to_clipboard(content: &str) -> Result<(), String> {
    use std::io::Write as _;
    let candidates: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
        &[("pbcopy", &[])]
    } else if cfg!(windows) {
        &[("clip", &[])]
    } else {
        &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["--clipboard", "--input"])]
    };
    let mut last = String::from("No clipboard tool was found");
    for (program, args) in candidates {
        let mut command = crate::proc::std_command(program);
        command.args(*args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let Ok(mut child) = command.spawn() else {
            last = format!("{program} is not available");
            continue;
        };
        let bytes: Vec<u8> = if cfg!(windows) {
            // `clip` reads UTF-16 with a byte-order mark; anything else turns accents into noise.
            let mut wide = vec![0xFF, 0xFE];
            for unit in content.encode_utf16() {
                wide.extend_from_slice(&unit.to_le_bytes());
            }
            wide
        } else {
            content.as_bytes().to_vec()
        };
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        last = format!("{program} failed");
    }
    Err(last)
}

/// What is on the clipboard as text, exactly as it is, or `None` when it holds none (or cannot be read).
pub fn read_clipboard() -> Option<String> {
    let candidates: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
        &[("pbpaste", &[])]
    } else if cfg!(windows) {
        &[("powershell", &["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"])]
    } else {
        &[("wl-paste", &["--no-newline"]), ("xclip", &["-selection", "clipboard", "-o"]), ("xsel", &["--clipboard", "--output"])]
    };
    for (program, args) in candidates {
        let mut command = crate::proc::std_command(program);
        command.args(*args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        if let Ok(output) = command.output() {
            if output.status.success() {
                let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
                // PowerShell ends what it prints with a line break of its own. Left in, a paste into a
                // terminal would arrive with an Enter the user never copied.
                if cfg!(windows) && text.ends_with("\r\n") {
                    text.truncate(text.len() - 2);
                }
                return Some(text);
            }
        }
    }
    None
}

/// Puts `text` on the system clipboard.
#[tauri::command]
pub async fn clipboard_write_text(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || copy_to_clipboard(&text)).await.map_err(|e| e.to_string())?
}

/// The clipboard's text, `""` when it holds none.
#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, String> {
    tokio::task::spawn_blocking(read_clipboard).await.map(Option::unwrap_or_default).map_err(|e| e.to_string())
}
