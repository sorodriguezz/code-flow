use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalRegistry(Mutex<HashMap<String, TerminalSession>>);

#[derive(Clone, Serialize)]
struct TerminalOutputEvent {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExitEvent {
    id: String,
}

#[cfg(target_os = "windows")]
fn windows_git_bash() -> Option<std::path::PathBuf> {
    // Common install locations; also honor where the `git` on PATH actually lives,
    // since Git for Windows ships bash.exe alongside it under mingw64\bin or usr\bin.
    let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for candidate in candidates {
        let path = std::path::PathBuf::from(candidate);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn default_shell() -> CommandBuilder {
    if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        if let Some(bash) = windows_git_bash() {
            let mut cmd = CommandBuilder::new(bash);
            cmd.arg("--login");
            cmd.arg("-i");
            return cmd;
        }
        CommandBuilder::new("powershell.exe")
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        CommandBuilder::new(shell)
    }
}

pub fn open_terminal(app: AppHandle, registry: &TerminalRegistry, cwd: String) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = default_shell();
    cmd.cwd(&cwd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = Uuid::new_v4().to_string();

    {
        let mut sessions = registry.0.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id.clone(),
            TerminalSession {
                writer,
                master: pair.master,
                child,
            },
        );
    }

    let reader_id = id.clone();
    let reader_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = reader_app.emit(
                        "terminal:output",
                        TerminalOutputEvent {
                            id: reader_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = reader_app.emit("terminal:exit", TerminalExitEvent { id: reader_id });
    });

    Ok(id)
}

pub fn write_terminal(registry: &TerminalRegistry, id: &str, data: &str) -> Result<(), String> {
    let mut sessions = registry.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(id).ok_or("no such terminal session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn resize_terminal(registry: &TerminalRegistry, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = registry.0.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(id).ok_or("no such terminal session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn close_terminal(registry: &TerminalRegistry, id: &str) -> Result<(), String> {
    let mut sessions = registry.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(id) {
        let _ = session.child.kill();
    }
    Ok(())
}
