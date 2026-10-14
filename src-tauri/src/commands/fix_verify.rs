//! Checking a fix before calling it one.
//!
//! "Corregir con IA" used to end when the model said it was done: an edit nobody compiled, handed
//! back as a proposal. The edit is usually right, and when it is not, the cheapest moment to find out
//! is right then — with the agent still warm and the failure one command away. So a fix can name a
//! command (the project's type check or build, by default the one the Reviewer would run), and the
//! fix is only reported as verified when that command passes. When it fails, the agent gets **one**
//! more turn with the command's own output, and the command runs again. Never more than one: a second
//! failure is a human's to read, not a loop's to burn tokens on.
//!
//! The command is the user's, per project, kept in the settings table under
//! [`setting_key`] — this only proposes a default and runs it.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tauri::State;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::ai_runs;
use crate::db::{queries, Db};

/// The longest a verification may take. A type check or a build, not a test suite's worth of time —
/// and a bound on one that hung, not an estimate of one that works.
const TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// How much of a failed command's output the repair turn is shown — the end, where compilers and
/// test runners say what went wrong.
pub const TAIL_CHARS: usize = 4_000;

/// Where a project's verification command is kept.
pub fn setting_key(project_id: &str) -> String {
    format!("fix_verify_command:{project_id}")
}

/// What one verification did.
#[derive(Debug, Clone)]
pub struct Check {
    pub passed: bool,
    /// The end of what it printed, stdout and stderr interleaved as they came.
    pub tail: String,
    pub timed_out: bool,
}

/// The last `max` characters of `text`, on a line boundary when there is one nearby.
fn tail_of(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let cut: String = text.chars().skip(count - max).collect();
    match cut.find('\n') {
        Some(at) if at < 200 => cut[at + 1..].to_string(),
        _ => cut,
    }
}

fn shell(command: &str, cwd: &Path, path: Option<String>) -> tokio::process::Command {
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = crate::proc::command("cmd");
        // `/S /C "…"`: cmd strips the outer quotes and runs the rest exactly as typed.
        cmd.as_std_mut().raw_arg(format!("/D /S /C \"{command}\""));
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = crate::proc::command("/bin/sh");
        cmd.arg("-c").arg(command);
        cmd
    };
    cmd.current_dir(cwd)
        // What a CI sets: no watchers, no prompts, no colour codes in the output the model reads.
        .env("CI", "true")
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path {
        cmd.env("PATH", path);
    }
    crate::proc::hide_console(&mut cmd);
    crate::proc::own_process_group(&mut cmd);
    cmd
}

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

/// Runs `command` in `cwd`, streaming its output into the current run's log. `Err` only for a
/// cancellation (the user pressed Stop, which also stops the command) or a command that could not
/// start at all.
pub async fn run(command: &str, cwd: &Path) -> Result<Check, String> {
    let ctx = ai_runs::current();
    let mut cancel = ctx.as_ref().and_then(|c| ai_runs::subscribe(&c.run_id));
    let say = |line: &str| {
        if let Some(ctx) = &ctx {
            ai_runs::emit_line(ctx, "stdout", line);
        }
    };
    say(&format!("$ {command}"));

    // The user's login PATH — where `pnpm`, `cargo` and `mvn` live — read off the async worker.
    let path = tokio::task::spawn_blocking(crate::shell_env::fresh_path).await.ok().flatten();
    let mut child = shell(command, cwd, path).spawn().map_err(|e| format!("no se pudo ejecutar `{command}`: {e}"))?;
    let _live = child.id().map(|pid| ai_runs::register_process(pid, ctx.as_ref().map(|c| c.run_id.as_str())));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>), child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)].into_iter().flatten() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let mut output = String::new();
    let deadline = tokio::time::sleep(TIMEOUT);
    tokio::pin!(deadline);
    let mut timed_out = false;
    let mut open = true;
    let status = loop {
        tokio::select! {
            line = rx.recv(), if open => match line {
                Some(line) => {
                    say(&line);
                    output.push_str(&line);
                    output.push('\n');
                    // Only the end is ever read; don't hold a build log of hundreds of megabytes.
                    if output.len() > TAIL_CHARS * 8 {
                        output = tail_of(&output, TAIL_CHARS * 2);
                    }
                }
                None => open = false,
            },
            status = child.wait(), if !open => break status.ok(),
            () = &mut deadline => {
                timed_out = true;
                ai_runs::kill_tree(&mut child).await;
                break None;
            }
            () = ai_runs::cancelled(&mut cancel) => {
                ai_runs::kill_tree(&mut child).await;
                return Err(ai_runs::CANCELLED_MARKER.to_string());
            }
        }
    };
    let passed = !timed_out && status.is_some_and(|s| s.success());
    say(if passed { "✔ verificación OK" } else if timed_out { "✘ verificación: tiempo agotado" } else { "✘ verificación falló" });
    Ok(Check { passed, tail: tail_of(output.trim_end(), TAIL_CHARS), timed_out })
}

/// The repair turn's ask: the finding again, what the fix broke, and the rule that the finding's own
/// fix stays.
pub fn repair_prompt(finding_prompt: &str, command: &str, check: &Check) -> String {
    format!(
        "{finding_prompt}\n\n---\nYa aplicaste una corrección para este hallazgo, pero la verificación del proyecto \
         falló después:\n\n$ {command}\n```\n{}\n```\n\nArregla lo que la rompió SIN deshacer la corrección del hallazgo. \
         Si el fallo no tiene relación con tu cambio, no toques nada y dilo.",
        check.tail
    )
}

/// The project's verification command: the one saved for it, or what the Reviewer would build it
/// with. Empty when neither exists — the fix then runs unverified, as before.
#[tauri::command]
pub fn fix_verify_command(db: State<Db>, project_id: String) -> Result<String, String> {
    let (stored, project) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (
            queries::get_setting(&conn, &setting_key(&project_id)).ok().flatten(),
            queries::get_project(&conn, &project_id).map_err(|e| e.to_string())?,
        )
    };
    if let Some(stored) = stored {
        return Ok(stored);
    }
    let Some(project) = project else { return Ok(String::new()) };
    let suggestion = crate::reviewer::detect::suggest(Path::new(&project.local_path), &project.name, "");
    Ok(suggestion.build)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_tail_keeps_the_end_on_a_line_boundary() {
        let text = (0..100).map(|i| format!("línea {i}")).collect::<Vec<_>>().join("\n");
        let tail = tail_of(&text, 30);
        assert!(tail.ends_with("línea 99"));
        assert!(!tail.starts_with("nea"), "cut at a line, not mid-word: {tail:?}");
        assert_eq!(tail_of("corto", 30), "corto");
    }

    #[tokio::test]
    async fn a_passing_and_a_failing_command_are_told_apart_with_their_output() {
        let dir = std::env::temp_dir();
        let ok = run("echo todo bien", &dir).await.unwrap();
        assert!(ok.passed);
        assert!(ok.tail.contains("todo bien"));
        let bad = run("echo 'error TS2322: tipo' >&2; exit 2", &dir).await.unwrap();
        assert!(!bad.passed);
        assert!(bad.tail.contains("TS2322"), "stderr reaches the repair turn");
        let prompt = repair_prompt("Hallazgo F-001", "tsc --noEmit", &bad);
        assert!(prompt.contains("TS2322") && prompt.contains("SIN deshacer"));
    }
}
