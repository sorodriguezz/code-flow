//! What runs in the background on this machine for CodeFlow — the status bar's «motores» marker
//! (the user, 2026-10-23: «un marcador de cuántos llama-server corren… para todos los modelos… alguna
//! manera de reconocer si algo está corriendo en segundo plano») — and the tie that keeps every model
//! server from outliving the app («no deberían quedar llama-server huérfanos jamás»).
//!
//! **Every server process is adopted** ([`adopt`]): the completion engine, the hybrid executor, the
//! embedder (all `llama-server`), the fine-tuning pane's adapter server and its trainer. Adopting
//! registers it, for the marker, and ties its life to this process:
//!
//! - **Unix:** a `/bin/sh` watcher per server, blocked in `read` on a pipe whose other end only this
//!   process holds. It costs nothing while it waits — no polling, no timer. When this process ends
//!   *in any way* (quit, crash, `kill -9`, a test binary returning, `tauri dev` rebuilding) the kernel
//!   closes the pipe, `read` sees end-of-file, and the watcher stops the server: `TERM`, then `KILL`
//!   three seconds later if it is still there. A normal stop ([`release`]) writes a line instead and
//!   the watcher leaves without touching anything. Before it kills, the watcher checks the pid still
//!   names the program it was given, so a pid the system reused for something else is left alone.
//! - **Windows:** one Job Object with `KILL_ON_JOB_CLOSE`, which every adopted process joins. The
//!   handle is never closed by us; the system closes it when this process ends, however it ends,
//!   and the job's processes go with it.
//!
//! The startup sweep (`localai::engine::sweep_orphans`) stays as the backstop for what neither covers
//! (a server started by a build from before this module).
//!
//! **The marker is cheap.** The count comes from the registry, pruned against the live pids of the
//! adopted processes alone; the per-process figures (CPU, memory) and the look for servers nobody
//! adopted are taken only with the panel open (`detail`), the way `sysload` keeps its walk to the
//! panel too. Changes are pushed on [`EVENT`] rather than polled.

use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Emitted whenever something starts or stops; the payload is empty — the bar asks [`status`].
pub const EVENT: &str = "background:changed";

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Tells the windows something in the background changed.
pub fn changed() {
    if let Some(app) = APP.get() {
        let _ = app.emit(EVENT, ());
    }
}

struct Held {
    pid: u32,
    /// `completion` · `executor` · `embeddings` · `adapter` · `training`.
    role: &'static str,
    model: String,
    since: u64,
    #[cfg(unix)]
    watcher: Option<std::process::ChildStdin>,
}

static HELD: Mutex<Vec<Held>> = Mutex::new(Vec::new());

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Registers the server `pid` (which runs `program`, by file name) and ties its life to this
/// process. Call it right after the spawn, before anything that may fail and return.
pub fn adopt(pid: u32, program: &str, role: &'static str, model: &str) {
    #[cfg(unix)]
    let watcher = watch(pid, program);
    #[cfg(windows)]
    {
        let _ = program;
        job::assign(pid);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = program;
    if let Ok(mut held) = HELD.lock() {
        held.retain(|h| h.pid != pid);
        held.push(Held {
            pid,
            role,
            model: model.to_string(),
            since: now_secs(),
            #[cfg(unix)]
            watcher,
        });
    }
    changed();
}

/// The server `pid` was stopped on purpose (or found gone): off the registry, and its watcher told
/// to leave without killing anything.
pub fn release(pid: u32) {
    let gone = HELD.lock().ok().and_then(|mut held| held.iter().position(|h| h.pid == pid).map(|at| held.remove(at)));
    if let Some(held) = gone {
        dismiss(held);
        changed();
    }
}

/// [`release`] for a child that may already be reaped (`Child::id()` is `None` then).
pub fn release_id(pid: Option<u32>) {
    if let Some(pid) = pid {
        release(pid);
    }
}

#[cfg(unix)]
fn dismiss(mut held: Held) {
    use std::io::Write;
    if let Some(mut pipe) = held.watcher.take() {
        let _ = pipe.write_all(b"released\n");
    }
}

#[cfg(not(unix))]
fn dismiss(_held: Held) {}

/// The watcher of `pid`: see the module note. Its stdin is the pipe; the end kept here is returned.
#[cfg(unix)]
fn watch(pid: u32, program: &str) -> Option<std::process::ChildStdin> {
    // The program's name as `ps -o comm=` prints it (a path on macOS, the name on Linux): matched
    // as a substring, and only letters, digits, `-`, `_` and `.` are kept so nothing reaches the
    // shell but a plain word.
    // Lowercased on both sides: macOS prints a framework Python as `…/Python`.
    let name: String = program.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect::<String>().to_ascii_lowercase();
    let script = format!(
        "trap '' INT HUP TERM; \
         if read line; then exit 0; fi; \
         case \"$(ps -o comm= -p {pid} 2>/dev/null | tr A-Z a-z)\" in *{name}*) ;; *) exit 0;; esac; \
         kill {pid} 2>/dev/null; sleep 3; \
         case \"$(ps -o comm= -p {pid} 2>/dev/null | tr A-Z a-z)\" in *{name}*) kill -9 {pid} 2>/dev/null;; esac"
    );
    let spawned = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(mut watcher) => {
            let pipe = watcher.stdin.take();
            // Reaped when it leaves, so a released server's watcher is not a zombie for the session.
            std::thread::spawn(move || {
                let _ = watcher.wait();
            });
            pipe
        }
        Err(e) => {
            crate::applog::warn(&format!("background: no watcher for pid {pid} ({e}); the startup sweep remains its backstop"));
            None
        }
    }
}

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// The job's handle as an integer: never closed by us, closed by the system with the process.
    static JOB: OnceLock<Option<isize>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        let raw = JOB.get_or_init(|| {
            // SAFETY: plain Win32 calls on handles created here; the struct is zero-initialised as
            // the API expects, with only the limit flag set.
            unsafe {
                let job = CreateJobObjectW(None, None).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .ok()?;
                Some(job.0 as isize)
            }
        });
        raw.map(|h| HANDLE(h as *mut core::ffi::c_void))
    }

    pub fn assign(pid: u32) {
        let Some(job) = job() else { return };
        // SAFETY: the process handle is opened, used once and closed.
        unsafe {
            if let Ok(process) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) {
                if let Err(e) = AssignProcessToJobObject(job, process) {
                    crate::applog::warn(&format!("background: pid {pid} could not join the job ({e})"));
                }
                let _ = CloseHandle(process);
            }
        }
    }
}

// ------------------------------------------------------------------------------------- the reading

/// One model server process.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    /// `completion` · `executor` · `embeddings` · `adapter` · `training`, or `other` for one of our
    /// servers nothing here started — another CodeFlow open, or one a crash left behind.
    pub role: String,
    pub model: String,
    /// Unix seconds.
    pub since: u64,
    /// With `detail` only.
    pub cpu: Option<f32>,
    pub memory: Option<u64>,
}

/// A model held in this process's memory: a transcription model, a voice.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    /// `whisper` · `recognizer` · `piper` · `kokoro`.
    pub kind: &'static str,
    /// What holds it: `dictation`, `meetings`, `flows`, `codi`, `voice`.
    pub by: &'static str,
    pub model: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The model servers: what the marker counts.
    pub processes: Vec<Process>,
    pub loaded: Vec<Loaded>,
    pub vectorizing: Option<crate::knowledge::Vectorizing>,
    /// Codi's microphone is open: a listener running all the time it is.
    pub codi_listening: bool,
}

static SYSTEM: Mutex<Option<sysinfo::System>> = Mutex::new(None);

/// What runs now. `detail`: each process's CPU and memory, and our servers nobody here adopted.
pub fn status(app: &AppHandle, detail: bool) -> Status {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let held: Vec<(u32, &'static str, String, u64)> = HELD.lock().map(|h| h.iter().map(|h| (h.pid, h.role, h.model.clone(), h.since)).collect()).unwrap_or_default();
    let mut guard = SYSTEM.lock().unwrap_or_else(|e| e.into_inner());
    let system = guard.get_or_insert_with(System::new);
    let kind = if detail { ProcessRefreshKind::nothing().with_cpu().with_exe(UpdateKind::OnlyIfNotSet) } else { ProcessRefreshKind::nothing() };
    if detail {
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    } else {
        let pids: Vec<Pid> = held.iter().map(|(pid, ..)| Pid::from_u32(*pid)).collect();
        system.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, kind);
    }

    let mut processes = Vec::new();
    let mut gone = Vec::new();
    for (pid, role, model, since) in &held {
        match system.process(Pid::from_u32(*pid)) {
            Some(process) => processes.push(Process {
                pid: *pid,
                role: role.to_string(),
                model: model.clone(),
                since: *since,
                cpu: detail.then(|| process.cpu_usage()),
                memory: detail.then(|| crate::sysload::footprint(Pid::from_u32(*pid)).unwrap_or_else(|| process.memory())),
            }),
            None => gone.push(*pid),
        }
    }
    if detail {
        // Our servers nobody here adopted: by their executable, as the startup sweep finds them.
        let ours = crate::localai::engine::server_binaries();
        for (pid, process) in system.processes() {
            let pid = pid.as_u32();
            if held.iter().any(|(own, ..)| *own == pid) || !process.exe().is_some_and(|exe| ours.iter().any(|own| own == exe)) {
                continue;
            }
            processes.push(Process {
                pid,
                role: "other".into(),
                model: model_of(process.cmd()),
                since: process.start_time(),
                cpu: Some(process.cpu_usage()),
                memory: Some(crate::sysload::footprint(Pid::from_u32(pid)).unwrap_or_else(|| process.memory())),
            });
        }
    }
    drop(guard);
    for pid in gone {
        release(pid);
    }
    processes.sort_by_key(|p| p.since);

    let mut loaded: Vec<Loaded> = Vec::new();
    loaded.extend(crate::dictation::engine::loaded().into_iter().map(|(by, model)| Loaded { kind: "whisper", by, model }));
    loaded.extend(crate::asr::recognizer::loaded().into_iter().map(|(by, model)| Loaded { kind: "recognizer", by, model }));
    if let Some(model) = crate::speech::piper::loaded() {
        loaded.push(Loaded { kind: "piper", by: "voice", model });
    }
    if let Some(model) = crate::speech::kokoro::loaded() {
        loaded.push(Loaded { kind: "kokoro", by: "voice", model });
    }

    Status { processes, loaded, vectorizing: crate::knowledge::vectorizing(), codi_listening: crate::codi::state(app).mic }
}

/// The model file a server's command line names (`-m <path>`), by its file name.
fn model_of(cmd: &[std::ffi::OsString]) -> String {
    cmd.iter()
        .position(|arg| arg == "-m" || arg == "--model")
        .and_then(|at| cmd.get(at + 1))
        .map(|path| std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
        .unwrap_or_default()
}

/// Stops one server: ours by its role's own stop (so its owner knows), anything else of ours by
/// pid. Refuses a pid that is not one of our servers.
pub async fn stop(pid: u32) -> Result<(), String> {
    let role = HELD.lock().ok().and_then(|held| held.iter().find(|h| h.pid == pid).map(|h| h.role));
    match role {
        Some("completion") => crate::localai::engine::shutdown().await,
        Some("executor") => crate::localai::executor::shutdown().await,
        Some("embeddings") => crate::localai::embedder::shutdown().await,
        Some("adapter") => crate::learning::serving::shutdown(),
        Some("training") => crate::learning::trainer::shutdown(),
        _ => {
            use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
            let ours = crate::localai::engine::server_binaries();
            let mut system = System::new();
            let target = Pid::from_u32(pid);
            system.refresh_processes_specifics(ProcessesToUpdate::Some(&[target]), true, ProcessRefreshKind::nothing().with_exe(UpdateKind::Always));
            let process = system.process(target).ok_or("that process is no longer running")?;
            if !process.exe().is_some_and(|exe| ours.iter().any(|own| own == exe)) {
                return Err("that process is not one of CodeFlow's model servers".into());
            }
            process.kill();
        }
    }
    release(pid);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// The tie itself, end to end, with `sleep` standing in for a server: released, it is left
    /// alone; when the pipe closes without a word — what this process ending does — it is stopped.
    #[test]
    fn a_watched_process_is_stopped_when_its_owner_is_gone_and_only_then() {
        let alive = |pid: u32| unsafe { libc::kill(pid as i32, 0) == 0 };
        let mut kept = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let mut dropped = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let keep_pipe = watch(kept.id(), "sleep").unwrap();
        let drop_pipe = watch(dropped.id(), "sleep").unwrap();

        // Released: the watcher reads its line and leaves.
        dismiss(Held { pid: kept.id(), role: "completion", model: String::new(), since: 0, watcher: Some(keep_pipe) });
        // The owner "ends": its end of the pipe closes with nothing written.
        drop(drop_pipe);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while dropped.try_wait().unwrap().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(dropped.try_wait().unwrap().is_some(), "the orphan was not stopped");
        assert!(alive(kept.id()), "a released process was stopped");
        let _ = kept.kill();
        let _ = kept.wait();
    }

    #[test]
    fn a_server_names_its_model_by_file() {
        let cmd: Vec<std::ffi::OsString> = ["llama-server", "-m", "/x/models/Qwen3-Embedding-0.6B-Q8_0.gguf", "--port", "1"].iter().map(Into::into).collect();
        assert_eq!(model_of(&cmd), "Qwen3-Embedding-0.6B-Q8_0.gguf");
        assert_eq!(model_of(&[]), "");
    }
}
