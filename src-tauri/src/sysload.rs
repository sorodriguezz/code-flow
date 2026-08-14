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
//! **The memory figure is what the OS itself bills each process for**, because that is the only
//! definition anyone can check. On macOS it is `ri_phys_footprint`, the column Activity Monitor
//! labels "Memory"; on Windows it is the private working set, the column Task Manager labels the
//! same. Add up the rows either tool shows for the processes found below and the total is the number
//! this panel draws.
//!
//! The obvious alternative — sysinfo's `memory()`, the resident size — is not wrong by a rounding
//! error but by a factor: pages a process shares with its siblings are counted once *per process*,
//! and a webview is six processes mapping the same runtime. Measured on Windows it answered 505 MB
//! where Task Manager's own rows for those same seven processes summed to 211 MB, and a panel that
//! cannot be reconciled with the tool the user already has open is a panel that is simply not
//! believed. It stays on as the fallback in [`footprint`], for a process the native read cannot
//! answer for and for the platforms with no implementation of it.
//!
//! What error is left runs the other way and is much smaller: a page shared between two of *our own*
//! processes is private to neither, so Windows attributes it to nobody and the figure reads a little
//! low. That is the same page Task Manager declines to bill anyone for, and agreeing with the OS is
//! worth more here than a truer number that matches nothing on screen.
//!
//! Read natively, like [`crate::power`] beside it: no `top`, no `wmic`, no subprocess to flash a
//! console window over the user's work on Windows.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{DiskRefreshKind, Disks, Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

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

/// Everything that has to survive between polls.
///
/// The `System` is here because CPU usage is a *delta*: sysinfo computes it from the difference
/// between two refreshes, so a fresh one per call would report 0% for ever. Holding it costs a few
/// hundred kilobytes and is the only shape that answers the question.
///
/// The rest is here because a poll every 2.5 seconds is a thing that runs for as long as the window
/// is open, and each field is work it no longer repeats — see [`read`].
struct State {
    system: System,
    /// Kept and refreshed in place rather than rebuilt. `Disks::new_with_refreshed_list()` per tick
    /// re-enumerated every mount point and re-probed each one's kind, filesystem and I/O counters
    /// to read two numbers off one volume.
    disks: Disks,
    /// Polls since start, so the disk can be re-read on a slower cadence than the CPU.
    ticks: u64,
    /// The last real answer from [`app_share`], reused on the polls that skip the process walk.
    /// See [`read`] — this is what lets the panel open on a figure rather than on a zero.
    app: (f32, u64, usize),
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// How many polls apart the disk is re-read. Free space does not move in two and a half seconds,
/// and the mount list moves even less; ten seconds is still far quicker than anyone notices a
/// volume filling up.
const DISK_EVERY: u64 = 4;

/// Reads the machine, and — when asked — us.
///
/// **`detail` is what decides whether the process table is walked.** The machine's own figures come
/// from `refresh_cpu_usage` and `refresh_memory`, which are two cheap system calls; everything that
/// costs is [`app_share`], which needs every process on the box and is the most expensive thing
/// this app does on a timer. Those figures are drawn in exactly one place — the panel behind the
/// status bar pills, which is open only while the pointer is resting on them (see `SystemMeter`) —
/// so walking the table on every poll spent milliseconds several hundred times an hour to compute
/// numbers that were on screen for none of it.
///
/// When `detail` is false the last real answer is reused, clamped so it can never exceed the
/// machine figures it is being drawn against. That matters: the panel opens on a *value*, two and a
/// half seconds old at worst, and is corrected by the refresh the act of opening triggers — rather
/// than opening on three zeroes and filling in.
///
/// Never fails: a status bar has nothing useful to do with an error about a detail nobody asked to
/// be told, so anything unreadable comes back as zero — the same way [`crate::power`] answers
/// `None` for a machine with no battery rather than inventing a level.
pub fn read(detail: bool) -> SystemLoad {
    // `into_inner` rather than a propagated panic: a poisoned lock here means a previous read
    // panicked, and refusing every future reading because of it would turn one bad refresh into a
    // permanently dead widget.
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let first = guard.is_none();
    let state = guard.get_or_insert_with(|| State {
        system: System::new(),
        disks: Disks::new_with_refreshed_list(),
        ticks: 0,
        app: (0.0, 0, 0),
    });

    // Only what is drawn. The default refresh also walks components (thermals), users and network
    // interfaces, none of which anything here reads.
    //
    // `OnlyIfNotSet` for the executable path: it is read once per process and never again, because
    // a process cannot change what it is running. `is_webview_helper` is the only reader.
    let processes = ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_exe(UpdateKind::OnlyIfNotSet);

    // The first poll is always detailed, whatever the caller asked for: it is what seeds `app` so a
    // panel opened before any detailed poll has a figure to draw.
    let walk = detail || first;

    state.system.refresh_cpu_usage();
    state.system.refresh_memory();
    if walk {
        state
            .system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, processes);
    }

    // The very first reading has no previous one to subtract, so every CPU figure would be 0. One
    // short sleep and a second refresh buys a real number on the first frame instead of a widget
    // that shows 0% until its second poll — which, at a poll every few seconds, is long enough to
    // be read as "this is broken". Only ever paid once per process, on a blocking command thread.
    if first {
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        state.system.refresh_cpu_usage();
        state
            .system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, processes);
    }

    let cores = state.system.cpus().len().max(1);
    let mem_total = state.system.total_memory();
    let mem_used = state.system.used_memory();

    if walk {
        state.app = app_share(&state.system);
    }
    // Clamped against *this* poll's machine figures rather than the ones it was measured with. The
    // panel's whole job is the comparison "the box is at 71%, and 4 of that is us", and a reading
    // that claims the app uses more than the machine reads as broken however defensible its
    // provenance.
    let (app_cpu_raw, app_mem_raw, app_processes) = state.app;
    let app_mem = app_mem_raw.min(mem_used);

    if state.ticks % DISK_EVERY == 0 {
        // `remove_not_listed_disks: true` so a volume that was unmounted since the last refresh
        // stops being listed, and `.with_storage()` because total/available space is all `disk()`
        // reads — not the kind, the filesystem or the I/O counters a full refresh also collects.
        state
            .disks
            .refresh_specifics(true, DiskRefreshKind::nothing().with_storage());
    }
    state.ticks = state.ticks.wrapping_add(1);
    let (disk_mount, disk_total, disk_used) = disk(&state.disks);

    SystemLoad {
        cpu_percent: clamp(state.system.global_cpu_usage()),
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
            // Resident size only when the OS declines to answer — see [`footprint`] and the module
            // note above for why that is the fallback and not the reading.
            memory += footprint(*pid).unwrap_or_else(|| process.memory());
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

/// What the OS bills `pid` for, in bytes — the figure its own process monitor prints in that
/// process's row. See the module note for why this and not the resident size beside it.
///
/// `None` means "ask sysinfo instead", and covers all three ways this can decline: a process that
/// exited between the snapshot and this call, one this app is not allowed to open, and a platform
/// with no implementation below. A hole in the sum would be a worse answer than a resident size.
///
/// Only ever called over the pid set in [`app_share`] — ours, so a handful — and only on polls that
/// walk it at all, which are the ones with the panel open. That is what makes a per-process syscall
/// affordable here when doing it for every process on the machine would not be.
#[cfg(target_os = "macos")]
fn footprint(pid: Pid) -> Option<u64> {
    /// `struct rusage_info_v0` from `<sys/resource.h>`, field for field. Only the footprint is read;
    /// the rest is here to put it at the offset the kernel writes it to.
    #[repr(C)]
    #[derive(Default)]
    // Every field but one is here for its offset alone, which is not a thing the lint can see.
    #[allow(dead_code)]
    struct RusageInfoV0 {
        ri_uuid: [u8; 16],
        ri_user_time: u64,
        ri_system_time: u64,
        ri_pkg_idle_wkups: u64,
        ri_interrupt_wkups: u64,
        ri_pageins: u64,
        ri_wired_size: u64,
        ri_resident_size: u64,
        ri_phys_footprint: u64,
        ri_proc_start_abstime: u64,
        ri_proc_exit_abstime: u64,
    }

    /// `RUSAGE_INFO_V0`. Asked for rather than the newest flavour because the footprint is already
    /// in v0 and every later version only appends to it: the smallest structure that answers the
    /// question is the one with the least surface to disagree with a future SDK over.
    const RUSAGE_INFO_V0: i32 = 0;

    // Public API since 10.9, and permitted for any process of the same user — which every process
    // in our set is, the adopted XPC services included.
    extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut std::ffi::c_void) -> i32;
    }

    let mut info = RusageInfoV0::default();
    // Safe: the buffer is exactly the flavour being asked for, and it outlives the call. A pid that
    // has exited answers non-zero rather than writing anywhere.
    let ok = unsafe {
        proc_pid_rusage(pid.as_u32() as i32, RUSAGE_INFO_V0, (&mut info as *mut RusageInfoV0).cast())
    };
    (ok == 0 && info.ri_phys_footprint > 0).then_some(info.ri_phys_footprint)
}

/// Windows: `PrivateWorkingSetSize` — the memory that is both resident and private to the process,
/// which is what Task Manager's "Memory" column has shown since Windows 10.
///
/// **The zero is the version check.** `PROCESS_MEMORY_COUNTERS_EX2` is newer than the call that
/// fills it, and `GetProcessMemoryInfo` writes only as far as the `cb` it is handed describes, so an
/// older Windows fills the `EX` prefix it knows and leaves this field at the zero it was initialised
/// to. Reading that as "no answer" costs nothing and needs no `GetVersionEx` and no manifest — and
/// it can never discard a real reading, since a running process always has private pages.
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` rather than `PROCESS_QUERY_INFORMATION`: it is all this call
/// needs, and it is the one that still opens a process running at a different integrity level.
#[cfg(windows)]
fn footprint(pid: Pid) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    // Safe: a pid in, a handle or null out. Null for a process that has exited since the snapshot,
    // or one this app may not open.
    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid.as_u32()) };
    if process.is_null() {
        return None;
    }

    let mut counters = PROCESS_MEMORY_COUNTERS_EX2 {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
        ..Default::default()
    };
    // Safe: the cast to the base structure is the one the API is documented to take — `cb` is how
    // it is told which one it was really given — and the handle is live until it is closed below.
    let ok = unsafe {
        GetProcessMemoryInfo(
            process,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
    };
    // Closed on the failing path too: one leaked handle per process per poll, on a timer that runs
    // for as long as the window is open, is a leak that outlives anything it was measuring.
    unsafe { CloseHandle(process) };

    (ok != 0 && counters.PrivateWorkingSetSize > 0).then_some(counters.PrivateWorkingSetSize as u64)
}

/// Everywhere else the resident sum stands, with the sibling double-count the module note describes.
/// Linux can answer this exactly and cheaply — `Pss` in `/proc/<pid>/smaps_rollup` divides each
/// shared page among the processes mapping it, so summing it over a tree counts every page once —
/// and that is where this goes next.
#[cfg(not(any(target_os = "macos", windows)))]
fn footprint(_pid: Pid) -> Option<u64> {
    None
}

/// The volume worth reporting: the one the user's home directory is on.
///
/// Not `/` by name and not the biggest — the question behind "disk 92%" is "can I still clone
/// this repository", and repositories live under home. Falls back to the largest volume when home
/// matches nothing, which is the sane answer for a container or an unusual mount layout.
fn disk(disks: &Disks) -> (String, u64, u64) {
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
        let load = read(true);

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

    /// The native read has to actually answer, on the platform the test is running on.
    ///
    /// [`footprint`] falling back is silent by design — that is what makes it a fallback — so a
    /// broken call, a revoked permission or a struct that drifted out of step with the SDK would put
    /// the panel back on resident sizes and over-report the app by a factor without anything here
    /// failing. This is the assertion that notices.
    #[test]
    #[cfg(any(target_os = "macos", windows))]
    fn the_os_bills_this_process() {
        let me = sysinfo::get_current_pid().expect("a running process has a pid");
        let bytes = footprint(me).expect("the OS attributes memory to this test binary");

        // A ceiling as well as a floor, because the failure worth catching here is a field read at
        // the wrong offset, and that does not answer a wrong number — it answers a wild one. A test
        // binary is megabytes: never kilobytes, and never sixteen gigabytes.
        assert!(
            ((1 << 20)..(1 << 34)).contains(&bytes),
            "implausible footprint for this process: {bytes} bytes"
        );
    }

    /// Prints the breakdown behind the panel's one figure, process by process, so it can be held up
    /// against Activity Monitor or Task Manager *row for row*. An assertion can tell that
    /// [`footprint`] answered; only this can tell that it answered the same thing the OS tells
    /// everybody else, which is the entire claim the panel makes.
    ///
    /// Aimed at the test binary by default — a tree of one — so point it at a running app to see
    /// the rules in [`ours`] collect a webview:
    ///
    /// ```text
    /// SYSLOAD_PID=$(pgrep -x CodeFlow) \
    ///   cargo test --lib sysload::tests::what_this_app_is_billed_for -- --ignored --nocapture
    /// ```
    ///
    /// ```text
    /// $env:SYSLOAD_PID = (Get-Process CodeFlow).Id
    /// cargo test --lib sysload::tests::what_this_app_is_billed_for -- --ignored --nocapture
    /// ```
    ///
    /// The rows to check it against are in Task Manager's *Details* tab, which needs the column
    /// added by hand: right-click the header, *Select columns*, "Memory (private working set)". The
    /// Processes tab shows the same figure, and its group total is a plain sum of these rows.
    #[test]
    #[ignore = "a report to read beside the OS's own tool, not an assertion"]
    fn what_this_app_is_billed_for() {
        let root = match std::env::var("SYSLOAD_PID") {
            Ok(pid) => Pid::from_u32(pid.trim().parse().expect("SYSLOAD_PID is a pid")),
            Err(_) => sysinfo::get_current_pid().expect("a running process has a pid"),
        };

        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory().with_exe(UpdateKind::OnlyIfNotSet),
        );

        let mb = |bytes: u64| format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0);
        println!("{:>8}  {:>12}  {:>12}   process", "pid", "OS-billed", "resident");

        let (mut billed_total, mut resident_total) = (0_u64, 0_u64);
        for pid in ours(&system, root) {
            let Some(process) = system.process(pid) else {
                continue;
            };
            let billed = footprint(pid);
            billed_total += billed.unwrap_or_else(|| process.memory());
            resident_total += process.memory();
            println!(
                "{:>8}  {:>12}  {:>12}   {}",
                pid.as_u32(),
                billed.map_or_else(|| "(fallback)".to_string(), mb),
                mb(process.memory()),
                process.name().to_string_lossy(),
            );
        }
        println!("{:>8}  {:>12}  {:>12}", "total", mb(billed_total), mb(resident_total));
        println!("\nthe left column is the panel's figure; the right one is what it used to report");
    }

    /// The second read is the one that matters: it is the first that can carry a CPU delta, and the
    /// stored `System` is the only reason it can.
    #[test]
    fn survives_a_second_reading() {
        let _ = read(true);
        let load = read(true);
        assert!(load.mem_total > 0);
        assert!((0.0..=100.0).contains(&load.cpu_percent));
    }
}

