//! SSH host-key trust, for every part of the app that connects through the system's `ssh`.
//!
//! Generic on purpose — the database tunnel is the first caller, the Remote workspace the next —
//! so nothing here knows about connections: a host, a port and the user `~/.ssh/config` rules may
//! match on. See [`crate::known_hosts`] for why a scan and a trust are two separate calls.

use crate::known_hosts::{self, HostKeyScan};

/// The keys a host presents, with their SHA256 fingerprints and whether each is already trusted.
/// Reads nothing but the host's public keys; writes nothing.
#[tauri::command]
pub async fn ssh_scan_host_key(
    host: String,
    port: Option<u16>,
    user: Option<String>,
) -> Result<HostKeyScan, String> {
    known_hosts::scan(&host, port.unwrap_or(0), user.as_deref().unwrap_or("")).await
}

/// Adds one scanned key to the known-hosts file `ssh` reads. Only ever called after the user has
/// compared its fingerprint with one obtained out of band. Returns the file written.
#[tauri::command]
pub async fn ssh_trust_host_key(
    host: String,
    port: Option<u16>,
    user: Option<String>,
    key_type: String,
    key: String,
) -> Result<String, String> {
    known_hosts::trust(&host, port.unwrap_or(0), user.as_deref().unwrap_or(""), &key_type, &key).await
}
