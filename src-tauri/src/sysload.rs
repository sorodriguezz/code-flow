//! What this machine is doing right now — and how much of it is us.
//!
//! Two readings in one struct on purpose. The status bar shows the machine's figures, because that
//! is the question someone glances down to ask ("why is the fan on?"), and the panel behind them
//! shows this app's share, because that is the *follow-up* — and an answer that arrives in a
//! separate poll, a second later, is an answer to a different moment. They are read from the same
//! refresh so the two numbers always describe the same instant.
//!
//! **"This app" means every process that is ours, not the one we happen to be running in.** A Tauri
//! app is never a single process — there is a webview beside the main one — and this one launches
//! more: every agent turn is a CLI subprocess, every terminal is a shell. Reporting our own pid
//! alone answers 0.3% while an agent run has three cores busy, which is exactly the moment someone
//! opens this panel.
//!
//! Finding them takes more than the parent-child tree, because on macOS that tree is not enough:
//! WKWebView runs its content, GPU and networking processes as XPC services, which launchd spawns
//! and adopts, so they come back with a parent of 1 and no link to us at all. Measured on this app
//! they were 393 MB of a 572 MB footprint — the tree alone was reporting under a third of it. What
//! does relate them is the *responsible process*, the same attribution macOS uses to decide which
//! app a TCC prompt names and which app Activity Monitor files a helper under. See [`ours`] for the
//! two rules that come out of it and [`responsible_for`] for the call behind them.
//!
//! **The memory figure is a sum of resident sizes, so it reads a little high.** Pages shared between
//! processes — the frameworks all four of ours map — are counted once per process, where Activity
//! Monitor's own column uses a footprint that excludes them. The alternative is per-process Mach
//! calls for `phys_footprint`, which is a lot of machinery for a status bar; over-reporting the app
//! slightly is the safer direction for a number whose job is to answer "is it us?".
//!
//! Read natively, like [`crate::power`] beside it: no `top`, no `wmic`, no subprocess to flash a
//! console window over the user's work on Windows.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Disks, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// What the status bar draws, and what its panel says when you hover it.
///
/// Percentages are 0–100 and already normalised against the whole machine — including
/// [`Self::app_cpu_percent`], which sysinfo reports per-core (400% on four busy cores). A panel
/// whose "this app" figure can exceed the machine figure above it is a panel that reads as broken,
/// however defensible the units are.
#[derive(Debug, Clone, Serialize)]
pub struct SystemLoad {
    pub cpu_percent: f32,
    /// What [`Self::cpu_percent`] is a percentage *of*, and what the app's per-core figure was
    /// divided by. Sent rather than guessed in the webview: `navigator.hardwareConcurrency` is a
    /// fingerprinting surface browsers are free to round down, and this is the same count the
    /// normalisation above used, so the caption can never disagree with the number it explains.
    pub cpu_cores: usize,
    pub mem_percent: f32,
    /// Bytes, so the frontend picks the unit in the reader's locale rather than parsing "3.4 GB".
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_percent: f32,
    pub disk_used: u64,
    pub disk_total: u64,
    /// Which volume [`Self::disk_percent`] is about — named, because a machine has several and a
    /// bare percentage is a number about nothing.
    pub disk_mount: String,
    /// This app and everything it launched. See the module note.
    pub app_cpu_percent: f32,
    pub app_mem: u64,
    /// [`Self::app_mem`] as a share of [`Self::mem_total`] — us against everything else on the
    /// machine. Computed here rather than in the webview so it is the same division the CPU figure
    /// beside it already went through, against the same total.
    pub app_mem_percent: f32,
    /// How many processes that tree came to. It is the line that explains the two figures above
    /// it: "42%, across 9 processes" is an agent run, "1 process" is the app sitting idle.
    pub app_processes: usize,
}

/// The live `System`, kept between calls because it is what makes a CPU reading possible at all.
///
/// CPU usage is a *delta*: sysinfo computes it from the difference between two refreshes, so a
/// fresh `System` per call would report 0% for ever. Holding one costs a few hundred kilobytes and
/// is the only shape that answers the question.
static STATE: Mutex<Option<System>> = Mutex::new(None);

/// Reads the machine, and us.
///
/// Never fails: a status bar has nothing useful to do with an error about a detail nobody asked to
/// be told, so anything unreadable comes back as zero — the same way [`crate::power`] answers
/// `None` for a machine with no battery rather than inventing a level.
pub fn read() -> SystemLoad {
    // `into_inner` rather than a propagated panic: a poisoned lock here means a previous read
    // panicked, and refusing every future reading because of it would turn one bad refresh into a
    // permanently dead widget.
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let first = guard.is_none();
    let system = guard.get_or_insert_with(System::new);

    // Only what is drawn. The default refresh also walks components (thermals), users and network
    // interfaces, none of which anything here reads.
    //
    // `OnlyIfNotSet` for the executable path: it is read once per process and never again, because
    // a process cannot change what it is running. `is_webview_helper` is the only reader.
    let processes = ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_exe(UpdateKind::OnlyIfNotSet);

    system.refresh_cpu_usage();
    system.refresh_memory();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, processes);

    // The very first reading has no previous one to subtract, so every CPU figure would be 0. One
    // short sleep and a second refresh buys a real number on the first frame instead of a widget
    // that shows 0% until its second poll — which, at a poll every few seconds, is long enough to
    // be read as "this is broken". Only ever paid once per process, on a blocking command thread.
    if first {
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        system.refresh_cpu_usage();
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, processes);
    }

    let cores = system.cpus().len().max(1);
    let mem_total = system.total_memory();
    let mem_used = system.used_memory();

    let (app_cpu_raw, app_mem, app_processes) = app_share(system);
    let (disk_mount, disk_total, disk_used) = disk();

    SystemLoad {
        cpu_percent: clamp(system.global_cpu_usage()),
        cpu_cores: cores,
        mem_percent: percent(mem_used, mem_total),
        mem_used,
        mem_total,
        disk_percent: percent(disk_used, disk_total),
        disk_used,
        disk_total,
        disk_mount,
        // Per-core to whole-machine: see the note on the struct.
        app_cpu_percent: clamp(app_cpu_raw / cores as f32),
        app_mem,
        app_mem_percent: percent(app_mem, mem_total),
        app_processes,
    }
}

/// Us: every process this app is accountable for.
///
/// Two passes, in this order, and the order is what makes the second rule pay off:
///
/// 1. **Adoption.** Anything the OS holds *us* responsible for is ours even though nothing links it
///    to us — the webview's XPC services (see [`responsible_for`]).
/// 2. **Descent.** Then the parent-child tree is walked from everything gathered so far, which
///    picks up the agent CLIs, the shells and anything those spawned in turn — including children
///    of a process adopted in the first pass.
///
/// The tree is walked to a fixed point rather than recursively because sysinfo's map is flat: pid →
/// process with a `parent()` on each and no children index. It converges in as many passes as the
/// tree is deep, which for "app → shell → command" is three.
fn app_share(system: &System) -> (f32, u64, usize) {
    let Ok(me) = sysinfo::get_current_pid() else {
        return (0.0, 0, 0);
    };
    let mine = ours(system, me);

    let mut cpu = 0.0_f32;
    let mut memory = 0_u64;
    let mut count = 0_usize;
    for pid in &mine {
        if let Some(process) = system.process(*pid) {
            cpu += process.cpu_usage();
            memory += process.memory();
            count += 1;
        }
    }
    (cpu, memory, count)
}

/// The pid set behind [`app_share`], split out so it can be aimed at a pid other than this process
/// — which is the only way to check the rules against a *running app* from a test binary that is
/// not one.
fn ours(system: &System, me: Pid) -> HashSet<Pid> {
    // Ours, per the OS. For a packaged app this is the app itself, so rule 1 below is the whole
    // story; under `tauri dev` it is the terminal that started us, which is what rule 2 is for.
    let my_responsible = responsible_for(me.as_u32());

    let mut mine: HashSet<Pid> = HashSet::from([me]);
    for (pid, process) in system.processes() {
        // Only the orphans are asked about, which on macOS is what an adopted XPC service looks
        // like — a parent of 1, or none at all. Every other process already has a parent chain that
        // the walk below can follow, and asking about all six hundred of them would be six hundred
        // syscalls per poll to learn what the tree already knows.
        if !process.parent().is_none_or(|parent| parent.as_u32() <= 1) {
            continue;
        }
        let responsible = responsible_for(pid.as_u32());

        // 1. The OS holds *us* accountable for it. True of the webview's XPC services under a
        //    packaged app, and of anything of ours that daemonised itself out of the tree.
        let ours_outright = responsible == Some(me.as_u32());

        // 2. …or it is a webview helper and we share a responsible process. This is the development
        //    build: launched from a terminal, the app and its webview are both filed under that
        //    terminal, so rule 1 finds nothing and the reading was a quarter of the truth — 162 MB
        //    of a real 630 MB, measured. Matching on the shared responsible process *alone* would
        //    be far worse than the problem: it would claim every other command that terminal ever
        //    ran. Restricted to processes that are webview helpers by executable, the only thing it
        //    can over-claim is a second webview app launched from the same terminal.
        let shared_webview =
            my_responsible.is_some() && responsible == my_responsible && is_webview_helper(process);

        if ours_outright || shared_webview {
            mine.insert(*pid);
        }
    }

    loop {
        let before = mine.len();
        for (pid, process) in system.processes() {
            if let Some(parent) = process.parent() {
                if mine.contains(&parent) {
                    mine.insert(*pid);
                }
            }
        }
        if mine.len() == before {
            break;
        }
    }
    mine
}

/// Whether a process is a webview process rather than something the user is running.
///
/// Matched on the executable path, which for these is inside the OS framework that owns them —
/// `WebKit.framework/…/com.apple.WebKit.WebContent` on macOS, `msedgewebview2.exe` on Windows,
/// `WebKitWebProcess` on Linux. Only ever consulted alongside a responsible-process match (see
/// rule 2 in [`ours`]), so this is the narrowing half of a test and never a claim on its own:
/// "every WebContent process on the machine" would collect Safari's.
fn is_webview_helper(process: &sysinfo::Process) -> bool {
    let path = process
        .exe()
        .map(|exe| exe.to_string_lossy().into_owned())
        .unwrap_or_else(|| process.name().to_string_lossy().into_owned());
    path.contains("WebKit.framework")
        || path.contains("com.apple.WebKit.")
        || path.contains("msedgewebview2")
        || path.contains("WebKitWebProcess")
        || path.contains("WebKitNetworkProcess")
}

/// Which process macOS holds accountable for `pid` — the app a helper is filed under.
///
/// This is the attribution behind "Terminal wants to access your Contacts" when it was a script
/// that asked, and behind Activity Monitor nesting helpers under their app. It is what relates the
/// WebKit XPC services to us: launchd is their parent, we are their responsible process.
///
/// **Deliberately compared against our own pid, never against our own responsible process.** For a
/// packaged app the two are the same thing — a bundle launched from Finder is responsible for
/// itself — so production gets the whole footprint. Under `tauri dev` the app is a child of the
/// terminal that started it, so *that* is the responsible process, and matching on it would sweep
/// in every unrelated command the same terminal ever ran. Matching on our own pid instead simply
/// finds nothing extra there, and the reading falls back to the process tree: a development build
/// under-reports its webview, which is a great deal better than a production one over-reporting
/// somebody else's compiler.
///
/// The symbol is macOS SPI — it has no public header, which is why it is declared here by hand. It
/// has been in libsystem since 10.12 and is what every process monitor on the platform uses; if it
/// ever went away or refused, it answers `-1` and this returns `None`, leaving pass 2 to do the
/// whole job exactly as it did before this existed.
#[cfg(target_os = "macos")]
fn responsible_for(pid: u32) -> Option<u32> {
    extern "C" {
        fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
    }
    // Safe: one scalar in, one scalar out, no pointers and no ownership. A pid that has exited
    // since the snapshot answers -1, which is the same "don't know" as the symbol failing.
    let answer = unsafe { responsibility_get_pid_responsible_for_pid(pid as i32) };
    (answer > 0).then_some(answer as u32)
}

/// Everywhere else the process tree is the whole answer: Windows launches its WebView2 processes as
/// real children, and so does WebKitGTK on Linux.
#[cfg(not(target_os = "macos"))]
fn responsible_for(_pid: u32) -> Option<u32> {
    None
}

/// The volume worth reporting: the one the user's home directory is on.
///
/// Not `/` by name and not the biggest — the question behind "disk 92%" is "can I still clone
/// this repository", and repositories live under home. Falls back to the largest volume when home
/// matches nothing, which is the sane answer for a container or an unusual mount layout.
fn disk() -> (String, u64, u64) {
    let disks = Disks::new_with_refreshed_list();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));

    let mut best: Option<(&sysinfo::Disk, usize)> = None;
    for candidate in disks.list() {
        if candidate.total_space() == 0 {
            continue;
        }
        let mount = candidate.mount_point();
        // Longest match wins: on a machine where home sits on its own volume, both `/` and that
        // volume are prefixes of it, and the specific one is the one with the real numbers.
        if home.starts_with(mount) {
            let depth = mount.components().count();
            if best.is_none_or(|(_, deepest)| depth > deepest) {
                best = Some((candidate, depth));
            }
        }
    }

    let chosen = best.map(|(disk, _)| disk).or_else(|| {
        disks
            .list()
            .iter()
            .filter(|disk| disk.total_space() > 0)
            .max_by_key(|disk| disk.total_space())
    });

    match chosen {
        Some(disk) => (
            disk.mount_point().to_string_lossy().into_owned(),
            disk.total_space(),
            disk.total_space().saturating_sub(disk.available_space()),
        ),
        None => (String::new(), 0, 0),
    }
}

fn percent(part: u64, whole: u64) -> f32 {
    if whole == 0 {
        return 0.0;
    }
    clamp((part as f64 / whole as f64) as f32 * 100.0)
}

/// Into 0–100. sysinfo can hand back a hair over 100 on a busy machine (the deltas are sampled
/// independently per core), and a status bar reading "101%" is a status bar nobody trusts again.
fn clamp(value: f32) -> f32 {
    if value.is_nan() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape of the answer, on whatever machine this runs on. Deliberately not asserting on
    /// *levels* — CI runners idle and CI runners thrash, and a test that failed because the box was
    /// busy would be a test everyone learns to re-run.
    #[test]
    fn reads_this_machine_and_this_app() {
        let load = read();

        for value in [
            load.cpu_percent,
            load.mem_percent,
            load.disk_percent,
            load.app_cpu_percent,
            load.app_mem_percent,
        ] {
            assert!((0.0..=100.0).contains(&value), "percentage out of range: {value}");
        }
        // The app's share is a share *of the machine*, so it can never be the larger of the two —
        // which is the whole reason the backend does the division rather than the webview.
        assert!(load.app_mem <= load.mem_used, "the app cannot use more than the machine");
        assert!(load.cpu_cores >= 1, "a machine with no CPU is not running this test");
        assert!(load.mem_total > 0, "a machine with no memory is not running this test");
        assert!(load.mem_used <= load.mem_total);
        assert!(load.disk_used <= load.disk_total);
        // The test binary is itself the process tree's root, so this can never legitimately be 0.
        assert!(load.app_processes >= 1);
        assert!(load.app_mem > 0);
    }

    /// The second read is the one that matters: it is the first that can carry a CPU delta, and the
    /// stored `System` is the only reason it can.
    #[test]
    fn survives_a_second_reading() {
        let _ = read();
        let load = read();
        assert!(load.mem_total > 0);
        assert!((0.0..=100.0).contains(&load.cpu_percent));
    }
}

