//! What another app's window says — «Codi, ¿tengo mensajes nuevos en Teams?».
//!
//! **Text first, read where it is.** The system's accessibility API (Accessibility on macOS, UI
//! Automation on Windows) hands over a window's text the way a screen reader gets it: under a second,
//! on this machine, nothing drawn or saved. Electron and Chromium apps (Teams, Slack) build that tree
//! only when asked, so they are asked (`AXManualAccessibility`) and read again.
//!
//! **A screenshot only when the text is not there**, and read by the system's own OCR (Vision,
//! `Windows.Media.Ocr`) — never sent anywhere as an image. The user, 2026-10-22: «que las capturas se
//! usen y se borren para no acumular basura». On Windows the capture never leaves memory; on macOS
//! `screencapture` has to write a file, which is read and deleted at once (a guard deletes it on
//! every path), and the folder is swept of anything an interrupted read left behind.
//!
//! **Never a secret.** Password fields are skipped by role on both systems, and the text is
//! redacted before any model reads it (`codi::web::answer`).

use serde::Serialize;

use super::apps::{pick, Picked};

/// A window on screen, belonging to an app.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindow {
    /// The app's name as the system shows it («Microsoft Teams», «ms-teams»).
    pub app: String,
    /// Its title, when the system lets it be read.
    pub title: String,
    pub pid: i32,
    /// `CGWindowID` on macOS, the `HWND` on Windows.
    pub id: u64,
}

/// What [`read`] read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub app: String,
    pub title: String,
    pub text: String,
    /// `accessibility` · `ocr`.
    pub via: &'static str,
}

/// What reading other apps needs that the system has to grant — macOS only; Windows asks nothing.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// Reading another app's text (Privacy › Accessibility).
    pub accessibility: bool,
    /// The screenshot fallback (Privacy › Screen Recording).
    pub screen: bool,
    /// Whether this system can read other apps at all.
    pub supported: bool,
}

/// The most text a reading keeps: the end of a chat is what is asked about, so it is the start that
/// goes when there is too much.
pub const MAX_TEXT: usize = 16_000;
/// Below this many characters the accessible text is taken as "not there" and the screenshot is read.
const TOO_LITTLE: usize = 60;

#[cfg(target_os = "macos")]
#[path = "read_macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "read_windows.rs"]
mod platform;

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::*;
    pub fn permissions() -> Permissions {
        Permissions { accessibility: false, screen: false, supported: false }
    }
    pub fn ask(_kind: &str) {}
    pub fn windows() -> Result<Vec<OpenWindow>, String> {
        Err("reading other apps is not available on this system".into())
    }
    pub fn accessible_text(_window: &OpenWindow) -> Result<String, String> {
        Err("reading other apps is not available on this system".into())
    }
    pub fn screenshot_text(_window: &OpenWindow) -> Result<String, String> {
        Err("reading other apps is not available on this system".into())
    }
}

pub fn permissions() -> Permissions {
    platform::permissions()
}

/// Asks the system for `kind` (`accessibility` · `screen`): its own prompt where it has one, and its
/// settings pane opened at the right list.
pub fn ask(kind: &str) {
    platform::ask(kind)
}

/// The windows on screen, front to back, without this app's own.
pub fn windows() -> Result<Vec<OpenWindow>, String> {
    let own = std::process::id() as i32;
    Ok(platform::windows()?.into_iter().filter(|w| w.pid != own && !w.app.trim().is_empty()).collect())
}

/// The front window of the app `spoken` names, read. Errors say what to do: open the app, grant a
/// permission, say which of several.
pub fn read(spoken: &str) -> Result<Reading, String> {
    let open = windows()?;
    let window = pick_window(&open, spoken)?;
    let accessible = platform::accessible_text(&window);
    let text = match &accessible {
        Ok(text) if text.chars().count() >= TOO_LITTLE => return Ok(finish(&window, text, "accessibility")),
        _ => platform::screenshot_text(&window),
    };
    match (text, accessible) {
        (Ok(text), _) if !text.trim().is_empty() => Ok(finish(&window, &text, "ocr")),
        (_, Ok(text)) if !text.trim().is_empty() => Ok(finish(&window, &text, "accessibility")),
        (Err(shot), Err(ax)) => Err(format!("{ax}; {shot}")),
        (Err(error), _) | (_, Err(error)) => Err(error),
        _ => Err(format!("{}'s window shows no text", window.app)),
    }
}

fn pick_window(open: &[OpenWindow], spoken: &str) -> Result<OpenWindow, String> {
    // By the app's name first, then by the window's title («el chat con Juan»).
    let apps: Vec<&str> = open.iter().map(|w| w.app.as_str()).collect();
    let titles: Vec<&str> = open.iter().map(|w| w.title.as_str()).collect();
    let mut nearest = Vec::new();
    for names in [&apps, &titles] {
        match pick(names, spoken) {
            Picked::One(i) => return Ok(open[i].clone()),
            // Front to back: several windows of the same app — the front one.
            Picked::Several(found) if found.iter().all(|&i| open[i].app == open[found[0]].app) => return Ok(open[found[0]].clone()),
            Picked::Several(found) => {
                let mut said: Vec<String> = found.iter().map(|&i| open[i].app.clone()).collect();
                said.dedup();
                return Err(format!("«{spoken}» could be {}: say which", said.join(", ")));
            }
            Picked::None(near) => nearest.extend(near.into_iter().map(|i| open[i].app.clone())),
        }
    }
    nearest.dedup();
    if nearest.is_empty() {
        Err(format!("no open window belongs to «{spoken}» — open it first"))
    } else {
        Err(format!("no open window belongs to «{spoken}»; open are {}", nearest.join(", ")))
    }
}

fn finish(window: &OpenWindow, text: &str, via: &'static str) -> Reading {
    Reading { app: window.app.clone(), title: window.title.clone(), text: tidy(text), via }
}

/// Lines trimmed, blank and repeated ones dropped (a tree says a label as its own text and again
/// as its container's), and only the end kept past [`MAX_TEXT`].
pub fn tidy(text: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if lines.last() != Some(&line) {
            lines.push(line);
        }
    }
    let joined = lines.join("\n");
    let count = joined.chars().count();
    if count <= MAX_TEXT {
        return joined;
    }
    let tail: String = joined.chars().skip(count - MAX_TEXT).collect();
    format!("…{}", tail.split_once('\n').map(|(_, rest)| rest).unwrap_or(&tail))
}

/// A file `screencapture` writes, deleted when this is dropped — whatever happens between.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct Shot(pub std::path::PathBuf);

impl Drop for Shot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Where a screenshot is written for the moment it takes to read it, swept of leftovers first.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn shot_path(pid: i32) -> Result<Shot, String> {
    let dir = std::env::temp_dir().join("codeflow-codi-shots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    sweep(&dir);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    Ok(Shot(dir.join(format!("{pid}-{nanos}.png"))))
}

/// Deletes whatever an earlier read left behind (a crash between the write and the delete).
pub fn sweep(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// At launch: nothing from an earlier session stays on disk.
pub fn sweep_at_launch() {
    sweep(&std::env::temp_dir().join("codeflow-codi-shots"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(app: &str, title: &str) -> OpenWindow {
        OpenWindow { app: app.into(), title: title.into(), pid: 1, id: 1 }
    }

    #[test]
    fn a_window_is_picked_by_its_app_or_its_title() {
        let open = [window("Microsoft Teams", "Chat | Juan Pérez"), window("Google Chrome", "Noticias"), window("Microsoft Teams", "Calendario")];
        assert_eq!(pick_window(&open, "teams").unwrap().title, "Chat | Juan Pérez", "the front one of the app");
        assert_eq!(pick_window(&open, "chrome").unwrap().app, "Google Chrome");
        assert_eq!(pick_window(&open, "noticias").unwrap().app, "Google Chrome");
        assert!(pick_window(&open, "outlook").unwrap_err().contains("open it first"));
    }

    #[test]
    fn the_text_is_tidied_and_its_end_kept() {
        assert_eq!(tidy("  Juan \n\nJuan\nHola\n Hola \nchao"), "Juan\nHola\nchao");
        let long = (0..5000).map(|n| format!("mensaje {n}")).collect::<Vec<_>>().join("\n");
        let kept = tidy(&long);
        assert!(kept.chars().count() <= MAX_TEXT + 1);
        assert!(kept.ends_with("mensaje 4999"));
        assert!(kept.starts_with("…mensaje "), "{}", &kept[..30]);
    }

    #[test]
    fn a_shot_is_gone_when_dropped() {
        let shot = shot_path(7).unwrap();
        std::fs::write(&shot.0, b"png").unwrap();
        let path = shot.0.clone();
        drop(shot);
        assert!(!path.exists());
    }
}
