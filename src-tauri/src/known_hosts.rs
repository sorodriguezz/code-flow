//! SSH host-key trust: what a host's keys are, and adding one to `~/.ssh/known_hosts`.
//!
//! Every SSH connection this app makes goes through the system's `ssh` with `BatchMode=yes` (see
//! `datasource::tunnel`, and the Remote workspace for the same reason), which is right — nothing may
//! wait on a prompt with no terminal behind it — and has one consequence: the very first connection
//! to a host fails with "Host key verification failed", because the question `ssh` would have asked
//! ("are you sure you want to continue connecting?") had nobody to ask. The fix used to be "go and
//! run ssh in a terminal once". This module asks that question in the app instead.
//!
//! Two operations, deliberately apart, so the user decides between them:
//!
//! - [`scan`] reads what the host presents (`ssh-keyscan`) and says, per key, its type, its SHA256
//!   fingerprint — the form `ssh` prints and hosting providers publish — and whether it is already
//!   trusted.
//! - [`trust`] appends one of those keys to the known-hosts file, and only ever after the user has
//!   compared the fingerprint with one obtained some other way. A scan is not authentication: on a
//!   network with somebody in the middle, the key scanned *is* the attacker's. That is why the
//!   dialog says to verify it out of band, and why this never trusts on its own.
//!
//! Like the tunnel, it defers to the user's SSH setup rather than second-guessing it: `ssh -G` says
//! which host name an alias from `~/.ssh/config` really means, which file keys are kept in, and
//! whether they are hashed — so the line written is the one `ssh` itself would have written.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Digest as _;

/// Starts the message of a tunnel that failed because the host isn't in known_hosts yet — the one
/// failure the app can offer to fix. Part of the wire contract: the frontend matches this exact text
/// (`HOST_KEY_UNKNOWN` in `src/lib/hostKey.ts`) to offer the trust dialog.
pub const HOST_KEY_UNKNOWN: &str = "SSH host key not trusted yet";

/// The other host-key failure, and the opposite case: a key that *changed*. Never offered a
/// one-click trust — that is exactly what an interception looks like.
pub const HOST_KEY_CHANGED: &str = "SSH host key has changed";

/// What `ssh` said about the host key when it refused to connect, if that is why it refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyProblem {
    Unknown,
    Changed,
}

pub fn host_key_problem(ssh_stderr: &str) -> Option<HostKeyProblem> {
    if ssh_stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        return Some(HostKeyProblem::Changed);
    }
    // With `BatchMode=yes` an unknown host fails with this line alone ("No … host key is known")
    // where an interactive `ssh` would have asked.
    if ssh_stderr.contains("Host key verification failed") {
        return Some(HostKeyProblem::Unknown);
    }
    None
}

/// How long `ssh-keyscan` may take. Generous for a distant host, bounded because the dialog is
/// waiting on it.
const SCAN_TIMEOUT: Duration = Duration::from_secs(15);

/// The key types `ssh` itself can pin. Checked before anything is written, so the known-hosts file
/// can only ever gain a well-formed line.
const KEY_TYPES: &[&str] = &[
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
];

/// One key a host presented.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScannedKey {
    pub key_type: String,
    /// The public key blob, base64 — what goes into the known-hosts line.
    pub key: String,
    /// `SHA256:…`, the way `ssh` prints it.
    pub fingerprint: String,
    /// Already in the known-hosts file for this host.
    pub trusted: bool,
}

/// What a scan found, and where a key would be written.
#[derive(Debug, Clone, Serialize)]
pub struct HostKeyScan {
    /// The host as it was asked about — possibly an alias from `~/.ssh/config`.
    pub host: String,
    pub port: u16,
    /// The name `ssh` really dials.
    pub hostname: String,
    /// How the host is recorded in the known-hosts file: `host`, `[host]:port`, or a
    /// `HostKeyAlias`.
    pub known_as: String,
    pub known_hosts_file: String,
    /// Whether a new entry is written hashed (`HashKnownHosts`, or a file that is already hashed).
    pub hashed: bool,
    pub keys: Vec<ScannedKey>,
}

/// What `ssh -G` says about a destination.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Resolved {
    hostname: String,
    port: u16,
    alias: Option<String>,
    known_hosts: Vec<PathBuf>,
    hash: bool,
}

/// Reads the keys `host` presents. `user` only matters for `~/.ssh/config` rules that match on it.
pub async fn scan(host: &str, port: u16, user: &str) -> Result<HostKeyScan, String> {
    let host = checked_host(host)?;
    let resolved = resolve(host, port, user).await;
    let known_as = known_hosts_pattern(&resolved.hostname, resolved.port, resolved.alias.as_deref());
    let file = resolved.known_hosts.first().cloned().unwrap_or_else(default_known_hosts);
    let existing = std::fs::read_to_string(&file).unwrap_or_default();

    let mut command = crate::proc::command("ssh-keyscan");
    command
        .args(["-T", "10", "-p", &resolved.port.to_string(), &resolved.hostname])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(SCAN_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("{} didn't answer within {}s.", resolved.hostname, SCAN_TIMEOUT.as_secs()))?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                "`ssh-keyscan` isn't on PATH. It ships with the OpenSSH client.".to_string()
            }
            _ => format!("couldn't run ssh-keyscan: {e}"),
        })?;

    let mut keys: Vec<ScannedKey> = parse_keyscan(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .map(|(key_type, key)| {
            let fingerprint = fingerprint(&key).unwrap_or_default();
            let trusted = is_trusted(&existing, &known_as, &key_type, &key);
            ScannedKey { key_type, key, fingerprint, trusted }
        })
        .filter(|key| !key.fingerprint.is_empty())
        .collect();
    // The strongest, most common type first — the one the dialog preselects.
    keys.sort_by_key(|key| KEY_TYPES.iter().position(|kind| *kind == key.key_type).unwrap_or(usize::MAX));
    if keys.is_empty() {
        let said = String::from_utf8_lossy(&output.stderr);
        let said = said.lines().filter(|line| !line.starts_with('#')).collect::<Vec<_>>().join(" ");
        return Err(format!(
            "{}:{} presented no SSH host key.{}",
            resolved.hostname,
            resolved.port,
            if said.trim().is_empty() { String::new() } else { format!(" ssh-keyscan said: {}", said.trim()) }
        ));
    }

    Ok(HostKeyScan {
        host: host.to_string(),
        port: resolved.port,
        hostname: resolved.hostname,
        known_as,
        known_hosts_file: file.display().to_string(),
        hashed: resolved.hash || all_hashed(&existing),
        keys,
    })
}

/// Adds one key to the known-hosts file. The caller has shown the user this key's fingerprint and
/// the user has said yes; the key arrives back verbatim, so what is written is what was shown.
pub async fn trust(host: &str, port: u16, user: &str, key_type: &str, key: &str) -> Result<String, String> {
    let host = checked_host(host)?;
    validate_key(key_type, key)?;
    let resolved = resolve(host, port, user).await;
    let known_as = known_hosts_pattern(&resolved.hostname, resolved.port, resolved.alias.as_deref());
    let file = resolved.known_hosts.first().cloned().unwrap_or_else(default_known_hosts);

    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    if is_trusted(&existing, &known_as, key_type, key) {
        return Ok(file.display().to_string());
    }
    let hashed = resolved.hash || all_hashed(&existing);
    let salt: [u8; 20] = rand::random();
    let line = known_hosts_line(&known_as, key_type, key, hashed.then_some(&salt[..]));
    append_line(&file, &existing, &line)?;
    Ok(file.display().to_string())
}

/// Asks `ssh -G` what a destination resolves to. Falls back to the plain reading — the host as
/// given, `~/.ssh/known_hosts`, unhashed — when it can't answer (an `ssh` older than 6.8).
async fn resolve(host: &str, port: u16, user: &str) -> Resolved {
    let destination = if user.trim().is_empty() { host.to_string() } else { format!("{}@{host}", user.trim()) };
    let mut command = crate::proc::command("ssh");
    command.arg("-G");
    if port != 0 {
        command.args(["-p", &port.to_string()]);
    }
    command.arg(&destination).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let answered = tokio::time::timeout(Duration::from_secs(5), command.output()).await;
    let fallback = Resolved {
        hostname: host.to_string(),
        port: if port == 0 { 22 } else { port },
        alias: None,
        known_hosts: vec![default_known_hosts()],
        hash: false,
    };
    match answered {
        Ok(Ok(output)) if output.status.success() => {
            parse_ssh_config(&String::from_utf8_lossy(&output.stdout)).unwrap_or(fallback)
        }
        _ => fallback,
    }
}

/// The fields of `ssh -G`'s output this module needs.
fn parse_ssh_config(text: &str) -> Option<Resolved> {
    let mut hostname = None;
    let mut port = 22u16;
    let mut alias = None;
    let mut known_hosts = Vec::new();
    let mut hash = false;
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once(' ') else { continue };
        let value = value.trim();
        match key.to_ascii_lowercase().as_str() {
            "hostname" => hostname = Some(value.to_string()),
            "port" => port = value.parse().unwrap_or(22),
            "hostkeyalias" if !value.eq_ignore_ascii_case("none") => alias = Some(value.to_string()),
            "userknownhostsfile" => {
                known_hosts = value.split_whitespace().filter(|path| *path != "none").map(expand_home).collect();
            }
            "hashknownhosts" => hash = value.eq_ignore_ascii_case("yes"),
            _ => {}
        }
    }
    Some(Resolved {
        hostname: hostname?,
        port,
        alias,
        known_hosts: if known_hosts.is_empty() { vec![default_known_hosts()] } else { known_hosts },
        hash,
    })
}

fn default_known_hosts() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh").join("known_hosts")
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(path),
    }
}

/// A host name is going into a file `ssh` parses, so it has to be one token: no whitespace, no
/// comma (the pattern separator) and nothing that starts a comment or a marker.
fn checked_host(host: &str) -> Result<&str, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("There is no SSH host to check.".to_string());
    }
    if host.chars().any(|c| c.is_whitespace() || matches!(c, ',' | '#' | '|' | '*' | '?' | '!')) {
        return Err(format!("\"{host}\" isn't a host name ssh could look up."));
    }
    Ok(host)
}

/// How `ssh` records a host: the name alone on port 22, `[name]:port` otherwise. A `HostKeyAlias`
/// replaces the name and keeps the port rule.
pub fn known_hosts_pattern(hostname: &str, port: u16, alias: Option<&str>) -> String {
    let name = alias.unwrap_or(hostname);
    if port == 22 || port == 0 {
        name.to_string()
    } else {
        format!("[{name}]:{port}")
    }
}

/// `SHA256:…` for a base64 public-key blob — base64 of the digest without padding, as `ssh-keygen -l`
/// prints it.
pub fn fingerprint(key: &str) -> Option<String> {
    let blob = base64::engine::general_purpose::STANDARD.decode(key.trim()).ok()?;
    let digest = sha2::Sha256::digest(&blob);
    Some(format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)))
}

/// `|1|salt|hash`: the `HashKnownHosts` form, an HMAC-SHA1 of the pattern keyed by a random salt.
fn hashed_pattern(pattern: &str, salt: &[u8]) -> String {
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(salt).expect("HMAC takes a key of any length");
    mac.update(pattern.as_bytes());
    let engine = base64::engine::general_purpose::STANDARD;
    format!("|1|{}|{}", engine.encode(salt), engine.encode(mac.finalize().into_bytes()))
}

/// One known-hosts line. `salt` hashes the host part.
pub fn known_hosts_line(pattern: &str, key_type: &str, key: &str, salt: Option<&[u8]>) -> String {
    let host = match salt {
        Some(salt) => hashed_pattern(pattern, salt),
        None => pattern.to_string(),
    };
    format!("{host} {key_type} {}", key.trim())
}

/// Whether the file already pins this key for this host, hashed or not.
fn is_trusted(contents: &str, pattern: &str, key_type: &str, key: &str) -> bool {
    contents.lines().any(|line| {
        let mut fields = line.split_whitespace();
        let Some(hosts) = fields.next() else { return false };
        // A comment, or a `@cert-authority` / `@revoked` marker — which pin something else entirely.
        if hosts.starts_with('#') || hosts.starts_with('@') {
            return false;
        }
        let (Some(kind), Some(blob)) = (fields.next(), fields.next()) else { return false };
        if kind != key_type || blob != key.trim() {
            return false;
        }
        if let Some(rest) = hosts.strip_prefix("|1|") {
            let Some((salt, _)) = rest.split_once('|') else { return false };
            let Ok(salt) = base64::engine::general_purpose::STANDARD.decode(salt) else { return false };
            return hashed_pattern(pattern, &salt) == hosts;
        }
        hosts.split(',').any(|entry| entry == pattern)
    })
}

/// A file whose every entry is hashed was written by somebody who wants it that way, whatever
/// `ssh -G` says about the current config.
fn all_hashed(contents: &str) -> bool {
    let mut entries = contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .peekable();
    entries.peek().is_some() && entries.all(|line| line.starts_with("|1|"))
}

/// `host keytype key` lines from `ssh-keyscan`'s stdout; its `#` banner lines go to stderr, but are
/// skipped here too in case a version mixes them.
fn parse_keyscan(text: &str) -> Vec<(String, String)> {
    let mut keys: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let (Some(_host), Some(kind), Some(key)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        if KEY_TYPES.contains(&kind) && !keys.iter().any(|(_, existing)| existing == key) {
            keys.push((kind.to_string(), key.to_string()));
        }
    }
    keys
}

/// The key must be a type `ssh` pins and a blob whose own type string says the same — the SSH wire
/// format opens with it — so no line this writes can carry anything but a key.
fn validate_key(key_type: &str, key: &str) -> Result<(), String> {
    if !KEY_TYPES.contains(&key_type) {
        return Err(format!("{key_type} isn't a host key type ssh can pin."));
    }
    let blob = base64::engine::general_purpose::STANDARD
        .decode(key.trim())
        .map_err(|_| "That host key isn't valid base64.".to_string())?;
    let length = blob.get(..4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize);
    let named = length.and_then(|length| blob.get(4..4 + length));
    if named != Some(key_type.as_bytes()) {
        return Err("That host key's contents don't match its type.".to_string());
    }
    Ok(())
}

/// Appends a line, creating `~/.ssh` (0700) and the file (0600) when they don't exist yet — the
/// modes `ssh` itself uses, and the ones its strict-mode checks expect.
fn append_line(file: &Path, existing: &str, line: &str) -> Result<(), String> {
    use std::io::Write as _;
    if let Some(dir) = file.parent() {
        if !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut handle = options.open(file).map_err(|e| format!("couldn't open {}: {e}", file.display()))?;
    // A file whose last line has no newline would have this one glued onto it.
    let separator = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    handle
        .write_all(format!("{separator}{line}\n").as_bytes())
        .map_err(|e| format!("couldn't write {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generated with `ssh-keygen -t ed25519`; `ssh-keygen -lf` printed this fingerprint for it.
    const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIN2XE8WAmiYry3XweAN3SVDDPzoCFQSEAbVZIkD5GzY9";
    const FINGERPRINT: &str = "SHA256:ayctR8Sqv4CFiPOvXgXIkUGYpjOaPV3O0LNm4E+Tm+M";

    #[test]
    fn a_host_key_failure_is_told_apart_from_a_changed_key() {
        assert_eq!(
            host_key_problem("No ED25519 host key is known for db.example.com and you have requested strict checking.\r\nHost key verification failed."),
            Some(HostKeyProblem::Unknown)
        );
        assert_eq!(
            host_key_problem("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."),
            Some(HostKeyProblem::Changed)
        );
        assert_eq!(host_key_problem("Permission denied (publickey)."), None);
    }

    #[test]
    fn the_fingerprint_is_the_one_ssh_keygen_prints() {
        assert_eq!(fingerprint(KEY).as_deref(), Some(FINGERPRINT));
        assert_eq!(fingerprint("not base64!"), None);
    }

    #[test]
    fn a_host_is_recorded_the_way_ssh_records_it() {
        assert_eq!(known_hosts_pattern("db.example.com", 22, None), "db.example.com");
        assert_eq!(known_hosts_pattern("db.example.com", 2222, None), "[db.example.com]:2222");
        assert_eq!(known_hosts_pattern("10.0.0.5", 2222, Some("bastion")), "[bastion]:2222");
        assert_eq!(
            known_hosts_line("db.example.com", "ssh-ed25519", KEY, None),
            format!("db.example.com ssh-ed25519 {KEY}")
        );
    }

    /// Checked against a line `ssh-keygen -H` hashed: the same salt must give the same hash.
    #[test]
    fn a_hashed_entry_matches_what_ssh_keygen_writes() {
        let salt = base64::engine::general_purpose::STANDARD.decode("k1gWSU6C7w+Cj3Lp+AcjlyA0PXo=").unwrap();
        let line = known_hosts_line("[bastion.example.com]:2222", "ssh-ed25519", KEY, Some(&salt));
        assert_eq!(
            line,
            format!("|1|k1gWSU6C7w+Cj3Lp+AcjlyA0PXo=|0Adc3ia53DhIvNrDJI8Y7sCQyi0= ssh-ed25519 {KEY}")
        );
        assert!(is_trusted(&line, "[bastion.example.com]:2222", "ssh-ed25519", KEY));
        assert!(!is_trusted(&line, "bastion.example.com", "ssh-ed25519", KEY));
    }

    #[test]
    fn a_pinned_key_is_recognised_and_a_different_one_is_not() {
        let file = format!("# comment\nother.example.com,db.example.com ssh-ed25519 {KEY}\n");
        assert!(is_trusted(&file, "db.example.com", "ssh-ed25519", KEY));
        assert!(!is_trusted(&file, "db.example.com", "ssh-rsa", KEY));
        assert!(!is_trusted(&file, "[db.example.com]:2222", "ssh-ed25519", KEY));
        assert!(!is_trusted(&format!("@revoked db.example.com ssh-ed25519 {KEY}"), "db.example.com", "ssh-ed25519", KEY));
        assert!(all_hashed("|1|a|b ssh-ed25519 x\n\n|1|c|d ssh-rsa y\n"));
        assert!(!all_hashed("|1|a|b ssh-ed25519 x\nplain ssh-rsa y\n"));
        assert!(!all_hashed("# only a comment\n"));
    }

    #[test]
    fn keyscan_output_becomes_keys_and_nothing_else() {
        let output = format!(
            "# db.example.com:22 SSH-2.0-OpenSSH_9.6\ndb.example.com ssh-rsa AAAAB3Nza\ndb.example.com ssh-ed25519 {KEY}\n\
             db.example.com ssh-ed25519 {KEY}\ngarbage\ndb.example.com ssh-dss AAAAB3NzaC1kc3M\n"
        );
        let keys = parse_keyscan(&output);
        assert_eq!(keys, vec![("ssh-rsa".to_string(), "AAAAB3Nza".to_string()), ("ssh-ed25519".to_string(), KEY.to_string())]);
    }

    #[test]
    fn ssh_config_output_names_the_real_host_the_file_and_the_hashing() {
        let resolved = parse_ssh_config(
            "user deploy\nhostname 10.0.0.5\nport 2222\nhostkeyalias bastion\n\
             userknownhostsfile /home/u/.ssh/known_hosts /home/u/.ssh/known_hosts2\nhashknownhosts yes\n",
        )
        .unwrap();
        assert_eq!(resolved.hostname, "10.0.0.5");
        assert_eq!(resolved.port, 2222);
        assert_eq!(resolved.alias.as_deref(), Some("bastion"));
        assert_eq!(resolved.known_hosts[0], PathBuf::from("/home/u/.ssh/known_hosts"));
        assert!(resolved.hash);
        assert!(parse_ssh_config("port 22\n").is_none(), "no hostname, no answer");
    }

    #[test]
    fn only_a_real_key_of_the_named_type_can_be_written() {
        assert!(validate_key("ssh-ed25519", KEY).is_ok());
        assert!(validate_key("ssh-rsa", KEY).is_err(), "type and contents disagree");
        assert!(validate_key("ssh-ed25519", "AAAA\nmalicious").is_err());
        assert!(validate_key("x-unknown", KEY).is_err());
        assert!(checked_host("db.example.com").is_ok());
        assert!(checked_host("db.example.com\n@cert-authority *").is_err());
        assert!(checked_host("a,b").is_err());
    }

    #[test]
    fn appending_creates_the_file_private_and_keeps_lines_apart() {
        let dir = std::env::temp_dir().join(format!("cf-known-hosts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join(".ssh").join("known_hosts");
        append_line(&file, "", "first ssh-ed25519 AAAA").unwrap();
        let existing = std::fs::read_to_string(&file).unwrap();
        append_line(&file, &existing, "second ssh-ed25519 BBBB").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "first ssh-ed25519 AAAA\nsecond ssh-ed25519 BBBB\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
