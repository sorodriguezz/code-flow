//! Which ports a service is listening on, found by asking the machine rather than the service.
//!
//! # Why this is discovered and no longer declared
//!
//! The first version of Services asked for ports to be typed in, on the argument that reading them
//! out of the log is a guess — and it is: "listening on 3000" turns up in proxy logs, test output
//! and dependency banners. But the log was never the only other source. The operating system knows
//! exactly which sockets are in `LISTEN` and which process holds each one, and a service is a
//! process tree whose root we started. Intersect the two and the answer is a fact, not a guess:
//! every port anything in that tree is accepting connections on, including the one a dev server
//! picked because its default was taken — which is the case typing it in got wrong.
//!
//! # How, per platform
//!
//! - **macOS** (and the BSDs): `lsof -iTCP -sTCP:LISTEN`, restricted to the tree's pids. It ships
//!   with the OS and answers in a couple of tens of milliseconds for a handful of pids.
//! - **Linux**: `/proc/net/tcp{,6}` for the listening sockets' inodes, and `/proc/<pid>/fd` for
//!   which process holds each inode. No subprocess at all.
//! - **Windows**: `netstat -ano`, read by shape rather than by its (localised) state column.
//!
//! The process tree itself comes from `sysinfo`, which is already how the status bar reads the
//! machine.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// One listening TCP socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub port: u16,
    /// What it is bound to, as the OS printed it: `*`, `127.0.0.1`, `[::1]`.
    pub address: String,
    pub pid: u32,
    /// The process's short name, where the platform's answer carries one.
    pub process: String,
}

/// A process, named by its pid *and* its start time — because a pid on its own is only a name for
/// as long as the process lives, and this is used to decide what to kill a moment after the tree
/// was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProcId {
    pub pid: u32,
    pub start: u64,
}

/// The machine's process list, refreshed on demand.
pub struct ProcessTable {
    system: System,
}

impl Default for ProcessTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessTable {
    pub fn new() -> Self {
        Self { system: System::new() }
    }

    /// Re-reads every process: pid, parent and start time, nothing else. `without_tasks` so that
    /// Linux threads are not listed as children of their own process.
    pub fn refresh(&mut self) {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
    }

    /// `root` and everything below it, root first.
    ///
    /// sysinfo's map is flat — every process knows its parent, none knows its children — so the
    /// index is built once per call. Walked breadth-first with a visited set, which also makes a
    /// cycle (a pid reused while this was being read) harmless.
    pub fn tree(&self, root: u32) -> Vec<ProcId> {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, process) in self.system.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent.as_u32()).or_default().push(pid.as_u32());
            }
        }
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([root]);
        while let Some(pid) = queue.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            let Some(process) = self.system.process(Pid::from_u32(pid)) else { continue };
            out.push(ProcId { pid, start: process.start_time() });
            if let Some(kids) = children.get(&pid) {
                queue.extend(kids.iter().copied());
            }
        }
        out
    }

    /// Whether `id` is still the process it was — alive, and not a newer process wearing its pid.
    pub fn is_alive(&self, id: ProcId) -> bool {
        self.system
            .process(Pid::from_u32(id.pid))
            .is_some_and(|process| process.start_time() == id.start)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn name(&self, pid: u32) -> Option<String> {
        self.system
            .process(Pid::from_u32(pid))
            .map(|process| process.name().to_string_lossy().into_owned())
    }
}

/// The listening sockets held by any of `pids`. One call for every service being watched, rather
/// than one per service: the cost is almost all process startup, whatever the list is.
pub fn listeners_of(pids: &[u32]) -> Vec<Listener> {
    if pids.is_empty() {
        return Vec::new();
    }
    platform::listeners(Some(pids))
}

/// Every listening socket this user can see — the Ports view.
pub fn all_listeners() -> Vec<Listener> {
    platform::listeners(None)
}

/// The ports in `listeners` held by a process in `tree`, sorted and without duplicates — a socket
/// bound on both IPv4 and IPv6 is one port to a person.
pub fn ports_of(listeners: &[Listener], tree: &[ProcId]) -> Vec<u16> {
    let pids: HashSet<u32> = tree.iter().map(|p| p.pid).collect();
    let mut ports: Vec<u16> =
        listeners.iter().filter(|l| pids.contains(&l.pid)).map(|l| l.port).collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// Parses `lsof -F pcn` output. Its own function so the format is tested without `lsof`.
///
/// `-F` prints one field per line, prefixed by its letter: `p` opens a process, `c` names it, and
/// each `n` after that is one of its files — for a listening socket, `ADDRESS:PORT`.
#[cfg_attr(not(any(test, target_os = "macos", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd", target_os = "dragonfly")), allow(dead_code))]
pub fn parse_lsof(text: &str) -> Vec<Listener> {
    let mut out: Vec<Listener> = Vec::new();
    let mut pid: Option<u32> = None;
    let mut process = String::new();
    for line in text.lines() {
        let Some(tag) = line.chars().next() else { continue };
        let value = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                pid = value.trim().parse().ok();
                process.clear();
            }
            'c' => process = value.to_string(),
            'n' => {
                let (Some(pid), Some((address, port))) = (pid, value.rsplit_once(':')) else { continue };
                // A connected socket reads `a:1->b:2`; with `-sTCP:LISTEN` there are none, but a
                // stray one must not be read as a port.
                if address.contains("->") || port.contains("->") {
                    continue;
                }
                let Ok(port) = port.trim().parse::<u16>() else { continue };
                if !out.iter().any(|l| l.pid == pid && l.port == port) {
                    out.push(Listener { port, address: address.to_string(), pid, process: process.clone() });
                }
            }
            _ => {}
        }
    }
    out
}

/// Parses `netstat -ano` output into listening TCP sockets.
///
/// Read by *shape* rather than by the state column, because that column is localised — it says
/// `LISTENING` in English Windows and `ESCUCHANDO` in Spanish. A listening socket is the one whose
/// foreign address is the unspecified one (`0.0.0.0:0`, `[::]:0`, `*:*`), in any language.
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
pub fn parse_netstat(text: &str) -> Vec<Listener> {
    let mut out: Vec<Listener> = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 || !fields[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        let foreign = fields[2];
        if !matches!(foreign, "0.0.0.0:0" | "[::]:0" | "*:*") {
            continue;
        }
        let Some((address, port)) = fields[1].rsplit_once(':') else { continue };
        let (Ok(port), Ok(pid)) = (port.parse::<u16>(), fields[fields.len() - 1].parse::<u32>()) else {
            continue;
        };
        if !out.iter().any(|l| l.pid == pid && l.port == port) {
            out.push(Listener { port, address: address.to_string(), pid, process: String::new() });
        }
    }
    out
}

/// Parses one `/proc/net/tcp{,6}` table into `inode → (address, port)` for the sockets in `LISTEN`.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
pub fn parse_proc_net_tcp(text: &str) -> HashMap<u64, (String, u16)> {
    let mut out = HashMap::new();
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // sl, local, remote, st, tx:rx, tr:when, retrnsmt, uid, timeout, inode
        if fields.len() < 10 || fields[3] != "0A" {
            continue;
        }
        let Some((address, port)) = fields[1].split_once(':') else { continue };
        let (Ok(port), Ok(inode)) = (u16::from_str_radix(port, 16), fields[9].parse::<u64>()) else {
            continue;
        };
        out.insert(inode, (decode_proc_address(address), port));
    }
    out
}

/// A `/proc/net/tcp` address — hex, in 32-bit words of host byte order — as the text people read.
#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
fn decode_proc_address(hex: &str) -> String {
    let words: Vec<u32> = (0..hex.len() / 8)
        .filter_map(|i| u32::from_str_radix(&hex[i * 8..i * 8 + 8], 16).ok())
        .collect();
    match words.as_slice() {
        [v4] => {
            let bytes = v4.to_le_bytes();
            if bytes == [0, 0, 0, 0] {
                "*".to_string()
            } else {
                std::net::Ipv4Addr::from(bytes).to_string()
            }
        }
        [a, b, c, d] => {
            let mut bytes = [0u8; 16];
            for (i, word) in [a, b, c, d].iter().enumerate() {
                bytes[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
            }
            let v6 = std::net::Ipv6Addr::from(bytes);
            if v6.is_unspecified() {
                "*".to_string()
            } else {
                format!("[{v6}]")
            }
        }
        _ => hex.to_string(),
    }
}

/// Sends `signal` to one process and, on Unix, to its whole process group when it leads one.
///
/// Every service's root leads its own group — `portable_pty` makes it a session leader — so the
/// group signal reaches everything that stayed in it, which is almost everything a dev command
/// starts.
#[cfg(unix)]
pub fn signal(pid: u32, signal: i32, whole_group: bool) {
    // SAFETY: `kill` takes integers and is async-signal-safe. A process that has already gone
    // answers ESRCH, which is exactly "nothing left to do" — so the result is not checked.
    unsafe {
        if whole_group {
            libc::kill(-(pid as i32), signal);
        }
        libc::kill(pid as i32, signal);
    }
}

/// Ends a process that is not ours — the Ports view's "free this port". Politely first.
pub fn terminate(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        signal(pid, libc::SIGTERM, false);
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            // SAFETY: signal 0 only asks whether the process exists.
            if unsafe { libc::kill(pid as i32, 0) } != 0 {
                return Ok(());
            }
        }
        signal(pid, libc::SIGKILL, false);
        Ok(())
    }
    #[cfg(windows)]
    {
        let status = crate::proc::std_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("taskkill exited with {status}"))
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd", target_os = "dragonfly"))]
mod platform {
    use super::{parse_lsof, Listener};

    pub fn listeners(pids: Option<&[u32]>) -> Vec<Listener> {
        let mut cmd = crate::proc::std_command("lsof");
        cmd.args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
        if let Some(pids) = pids {
            let list: Vec<String> = pids.iter().map(u32::to_string).collect();
            // `-a` ANDs the selections: listening TCP sockets *of these pids*, rather than either.
            cmd.args(["-a", "-p", &list.join(",")]);
        }
        // lsof exits 1 when nothing matched, which is the common answer while a service is still
        // starting — so the status is ignored and whatever it printed is read.
        match cmd.stderr(std::process::Stdio::null()).output() {
            Ok(output) => parse_lsof(&String::from_utf8_lossy(&output.stdout)),
            Err(_) => Vec::new(),
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{parse_proc_net_tcp, Listener};
    use std::collections::HashMap;

    pub fn listeners(pids: Option<&[u32]>) -> Vec<Listener> {
        let mut sockets: HashMap<u64, (String, u16)> = HashMap::new();
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(text) = std::fs::read_to_string(table) {
                sockets.extend(parse_proc_net_tcp(&text));
            }
        }
        if sockets.is_empty() {
            return Vec::new();
        }
        let candidates: Vec<u32> = match pids {
            Some(pids) => pids.to_vec(),
            None => std::fs::read_dir("/proc")
                .map(|entries| {
                    entries
                        .flatten()
                        .filter_map(|e| e.file_name().to_str().and_then(|n| n.parse().ok()))
                        .collect()
                })
                .unwrap_or_default(),
        };
        let mut out: Vec<Listener> = Vec::new();
        for pid in candidates {
            let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
            let process = std::fs::read_to_string(format!("/proc/{pid}/comm"))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else { continue };
                let target = target.to_string_lossy();
                let Some(inode) = target
                    .strip_prefix("socket:[")
                    .and_then(|rest| rest.strip_suffix(']'))
                    .and_then(|n| n.parse::<u64>().ok())
                else {
                    continue;
                };
                if let Some((address, port)) = sockets.get(&inode) {
                    if !out.iter().any(|l| l.pid == pid && l.port == *port) {
                        out.push(Listener { port: *port, address: address.clone(), pid, process: process.clone() });
                    }
                }
            }
        }
        out
    }
}

#[cfg(windows)]
mod platform {
    use super::{parse_netstat, Listener, ProcessTable};

    pub fn listeners(pids: Option<&[u32]>) -> Vec<Listener> {
        let Ok(output) = crate::proc::std_command("netstat").args(["-ano", "-p", "TCP"]).output() else {
            return Vec::new();
        };
        let mut found = parse_netstat(&String::from_utf8_lossy(&output.stdout));
        if let Ok(output6) = crate::proc::std_command("netstat").args(["-ano", "-p", "TCPv6"]).output() {
            for listener in parse_netstat(&String::from_utf8_lossy(&output6.stdout)) {
                if !found.iter().any(|l| l.pid == listener.pid && l.port == listener.port) {
                    found.push(listener);
                }
            }
        }
        if let Some(pids) = pids {
            found.retain(|l| pids.contains(&l.pid));
        }
        let mut table = ProcessTable::new();
        table.refresh();
        for listener in &mut found {
            listener.process = table.name(listener.pid).unwrap_or_default();
        }
        found
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use super::Listener;
    pub fn listeners(_pids: Option<&[u32]>) -> Vec<Listener> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsof_output_is_read_per_process_and_deduplicated() {
        let text = "p630\ncrapportd\nf11\nn*:49152\nf12\nn*:49152\np641\ncnode\nf9\nn[::1]:5173\nf10\nn127.0.0.1:24678\n";
        let found = parse_lsof(text);
        assert_eq!(
            found,
            vec![
                Listener { port: 49152, address: "*".into(), pid: 630, process: "rapportd".into() },
                Listener { port: 5173, address: "[::1]".into(), pid: 641, process: "node".into() },
                Listener { port: 24678, address: "127.0.0.1".into(), pid: 641, process: "node".into() },
            ]
        );
    }

    #[test]
    fn a_connected_socket_is_not_a_port() {
        assert!(parse_lsof("p1\ncx\nn127.0.0.1:5000->127.0.0.1:61000\n").is_empty());
    }

    /// The state column is localised, so a Spanish Windows must parse exactly like an English one.
    #[test]
    fn netstat_is_read_by_shape_in_any_language() {
        let english = "\n  Proto  Local Address          Foreign Address        State           PID\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044\n  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       8812\n  TCP    127.0.0.1:5173         127.0.0.1:61234        ESTABLISHED     8812\n  TCP    [::1]:3000             [::]:0                 LISTENING       912\n";
        let spanish = english.replace("LISTENING", "ESCUCHANDO").replace("ESTABLISHED", "ESTABLECIDO");
        for text in [english.to_string(), spanish] {
            let ports: Vec<(u16, u32)> = parse_netstat(&text).iter().map(|l| (l.port, l.pid)).collect();
            assert_eq!(ports, vec![(135, 1044), (5173, 8812), (3000, 912)]);
        }
    }

    #[test]
    fn proc_net_tcp_keeps_only_listening_sockets() {
        let text = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 43210 1 0000000000000000 100 0 0 10 0\n   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 43211 1 0000000000000000 20 4 30 10 -1\n   2: 00000000:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 43212 1 0000000000000000 100 0 0 10 0\n";
        let found = parse_proc_net_tcp(text);
        assert_eq!(found.get(&43210), Some(&("127.0.0.1".to_string(), 8080)));
        assert_eq!(found.get(&43212), Some(&("*".to_string(), 5432)));
        assert!(!found.contains_key(&43211), "an established socket is not listening");
    }

    #[test]
    fn proc_net_tcp6_addresses_are_decoded() {
        assert_eq!(decode_proc_address("00000000000000000000000001000000"), "[::1]");
        assert_eq!(decode_proc_address("00000000000000000000000000000000"), "*");
    }

    #[test]
    fn ports_of_a_tree_ignore_everyone_else() {
        let listeners = vec![
            Listener { port: 5173, address: "*".into(), pid: 10, process: String::new() },
            Listener { port: 5173, address: "[::1]".into(), pid: 11, process: String::new() },
            Listener { port: 3000, address: "*".into(), pid: 99, process: String::new() },
            Listener { port: 24678, address: "*".into(), pid: 11, process: String::new() },
        ];
        let tree = [ProcId { pid: 10, start: 1 }, ProcId { pid: 11, start: 1 }];
        assert_eq!(ports_of(&listeners, &tree), vec![5173, 24678]);
    }

    /// A real socket, found through the real platform path — the whole point of the module.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_listening_socket_of_this_process_is_found() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        let found = listeners_of(&[me]);
        assert!(found.iter().any(|l| l.port == port && l.pid == me), "{found:?} should hold {port}");
    }

    #[test]
    fn the_tree_of_this_process_starts_with_it() {
        let mut table = ProcessTable::new();
        table.refresh();
        let me = std::process::id();
        let tree = table.tree(me);
        assert_eq!(tree.first().map(|p| p.pid), Some(me));
        assert!(table.is_alive(tree[0]));
        assert!(!table.is_alive(ProcId { pid: me, start: tree[0].start + 1 }), "a reused pid is not the same process");
    }
}
