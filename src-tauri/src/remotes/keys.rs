//! What identities this machine already has: the keys in `~/.ssh` and whatever the agent is holding.
//!
//! **Read-only, and that is the whole point.** Termius ships a keychain of its own — it generates
//! keys, stores them, and adds FIDO2 and Secure Enclave keys. Copying that here would put a second
//! key store next to `~/.ssh`, and then every "which key is this host using?" would have two
//! possible answers. The decision that makes this app's hosts work at all is that `ssh` reads the
//! user's real configuration; a private key we owned would be the one thing `ssh` could not see.
//!
//! So this module discovers and never writes. What it buys is small and real: the key field in the
//! host editor becomes a list of the keys you actually have instead of a path you have to remember,
//! and the agent's identities are visible so "why is it not offering my key?" is answerable.
//!
//! **Discovery is by public key, not by private key.** A `.pub` file is safe to read, names its own
//! type and comment, and sits beside the private key it belongs to. Reading private keys to
//! enumerate them would mean touching (and possibly being prompted for) material this app has no
//! business holding.
//!
//! **Generating one is the exception that keeps the rule.** [`generate`] runs `ssh-keygen` — the
//! tool the user would have run — and the key it writes lands in `~/.ssh` like any other, owned by
//! the user and read by `ssh`, never by this app. CodeFlow does not see the private half and keeps
//! no copy; it only saves someone the trip to a terminal and the flags they would have looked up.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// One identity offered to the picker.
#[derive(Debug, Clone, Serialize)]
pub struct SshKey {
    /// Absolute path to the *private* key — what `-i` wants. Empty for an agent-only identity,
    /// whose private half this machine may not have on disk at all (a hardware key, or one added
    /// from elsewhere).
    pub path: String,
    /// The filename, or the agent's comment — what the user recognises it by.
    pub label: String,
    /// `ssh-ed25519`, `ssh-rsa`, … as the key itself declares.
    pub kind: String,
    /// The trailing comment from the `.pub` file, usually `user@machine`.
    pub comment: String,
    /// Whether the agent is currently holding this key. The useful column: a key the agent has
    /// needs no `-i` at all, and a key it doesn't is why a connection is asking for a passphrase.
    pub in_agent: bool,
}

fn ssh_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh"))
}

/// Every identity worth offering, agent-held ones first.
///
/// A missing `~/.ssh` or a missing agent are both normal states, not errors — a machine with
/// neither is exactly the machine that most needs the rest of the app to keep working.
pub fn list() -> Vec<SshKey> {
    let agent = agent_identities();
    let mut keys = disk_keys(&agent);

    // Anything the agent holds that has no `.pub` beside it — a hardware key, or one added from a
    // path outside `~/.ssh`. Worth listing precisely because it explains a connection that works
    // with no key configured.
    for (blob, comment) in &agent {
        if keys.iter().any(|key| &key.comment == comment) {
            continue;
        }
        keys.push(SshKey {
            path: String::new(),
            label: comment.clone(),
            kind: kind_of(blob),
            comment: comment.clone(),
            in_agent: true,
        });
    }

    // Agent-held first: those are the ones that will just work.
    keys.sort_by(|a, b| b.in_agent.cmp(&a.in_agent).then_with(|| a.label.cmp(&b.label)));
    keys
}

/// The keys on disk, found by their `.pub` files.
fn disk_keys(agent: &[(String, String)]) -> Vec<SshKey> {
    let Some(dir) = ssh_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };

    let mut keys = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pub") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let mut parts = text.split_whitespace();
        let (Some(kind), Some(blob)) = (parts.next(), parts.next()) else { continue };
        let comment = parts.collect::<Vec<_>>().join(" ");

        // The private key is the same path without `.pub`. Skipped when it isn't there: a lone
        // public key can't be passed to `-i`, and offering it would produce a connection that
        // fails for a reason the picker implied was fine.
        let private = path.with_extension("");
        if !private.is_file() {
            continue;
        }

        keys.push(SshKey {
            path: private.to_string_lossy().to_string(),
            label: file_label(&private),
            kind: kind.to_string(),
            comment: comment.clone(),
            // Matched on the base64 blob, which is the key's actual identity — comments are
            // editable text and two machines' keys routinely share one.
            in_agent: agent.iter().any(|(agent_blob, _)| agent_blob == blob),
        });
    }
    keys
}

fn file_label(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// `ssh-add -l` gives fingerprints; `-L` gives the full public keys, which is what lets a disk key
/// be matched to an agent entry by blob rather than by comment.
///
/// Returns `(blob, comment)` pairs. An absent agent, a refused connection or no `ssh-add` at all
/// are all the same answer here: an empty list.
fn agent_identities() -> Vec<(String, String)> {
    let Ok(output) = crate::proc::std_command("ssh-add").arg("-L").output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let _kind = parts.next()?;
            let blob = parts.next()?;
            Some((blob.to_string(), parts.collect::<Vec<_>>().join(" ")))
        })
        .collect()
}

/// Makes a new ed25519 key pair at `~/.ssh/<name>` and returns it as the picker lists it.
///
/// `passphrase` may be empty, for a key that is protected by the disk it sits on and nothing else —
/// `ssh-keygen`'s own default when you press Enter twice. **An existing file is never touched**:
/// the name is refused if either half already exists, and `ssh-keygen` is not given the chance to
/// ask "Overwrite (y/n)?" either — its answer would be read from the same pipe as the passphrase.
pub fn generate(name: &str, passphrase: &str, comment: &str) -> Result<SshKey, String> {
    let dir = ssh_dir().ok_or("There is no home directory to put ~/.ssh in.")?;
    generate_in(&dir, name, passphrase, comment)
}

/// [`generate`] into any directory, so it can be tested without touching the real `~/.ssh`.
fn generate_in(dir: &Path, name: &str, passphrase: &str, comment: &str) -> Result<SshKey, String> {
    let name = checked_name(name)?;
    let path = dir.join(name);
    // Appended rather than `with_extension`, which would *replace* an extension the name already
    // has (`work.key` → `work.pub`) and name a file `ssh-keygen` never writes.
    let public = PathBuf::from(format!("{}.pub", path.display()));
    if path.exists() || public.exists() {
        return Err(format!("{} already exists — pick another name. Nothing was overwritten.", path.display()));
    }
    ensure_private_dir(dir)?;

    let mut command = crate::proc::std_command("ssh-keygen");
    command
        .args(["-q", "-t", "ed25519", "-f"])
        .arg(&path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    // Left out when blank, so the key gets `ssh-keygen`'s own `user@machine` rather than nothing.
    if !comment.trim().is_empty() {
        command.args(["-C", comment.trim()]);
    }
    // The passphrase goes in on stdin, twice (entered and confirmed), never as `-N` — an argument
    // is on show to every `ps` on the machine for as long as the process runs. `ssh-keygen` reads
    // stdin when it has no terminal, and a session of its own guarantees it has none even when
    // CodeFlow was started from one. Windows has neither `setsid` nor that fallback, so there the
    // passphrase rides `-N`, where only this user's processes can read a command line.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.stdin(std::process::Stdio::piped());
        // SAFETY: `setsid` is async-signal-safe and affects only the child.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    command.args(["-N", passphrase]).stdin(std::process::Stdio::null());

    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut child = command.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "`ssh-keygen` isn't on PATH. It ships with the OpenSSH client.".to_string(),
        _ => format!("couldn't run ssh-keygen: {e}"),
    })?;
    #[cfg(unix)]
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write as _;
        let _ = stdin.write_all(format!("{passphrase}\n{passphrase}\n").as_bytes());
    }
    let output = child.wait_with_output().map_err(|e| format!("ssh-keygen didn't finish: {e}"))?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if said.is_empty() { "ssh-keygen failed without saying why.".to_string() } else { said });
    }

    let text = std::fs::read_to_string(&public).map_err(|e| format!("Couldn't read {}: {e}", public.display()))?;
    let mut parts = text.split_whitespace();
    let kind = parts.next().unwrap_or("ssh-ed25519").to_string();
    let _blob = parts.next();
    Ok(SshKey {
        path: path.to_string_lossy().to_string(),
        label: file_label(&path),
        kind,
        comment: parts.collect::<Vec<_>>().join(" "),
        in_agent: false,
    })
}

/// A key's file name: one path segment of letters, digits, `.`, `_` and `-`, not starting with a
/// dot. Anything else is refused rather than cleaned up — the user should see the name they get.
fn checked_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let valid = !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with(".pub")
        && name.len() <= 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(name)
    } else {
        Err(format!(
            "\"{name}\" can't be a key file name. Use letters, digits, dots, dashes and underscores — \
             it is saved in ~/.ssh under exactly that name."
        ))
    }
}

/// `~/.ssh`, created 0700 when it does not exist — the mode `ssh` insists on for the directory its
/// keys live in.
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// The key type as the agent reported it, for an identity with no file beside it.
fn kind_of(_blob: &str) -> String {
    // The type is the first field of the `ssh-add -L` line, which `agent_identities` drops because
    // disk keys carry their own. Rather than thread it through for the rare agent-only case, this
    // stays deliberately vague: the label and comment are what the user picks by.
    "agent".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_never_panics_on_a_machine_with_no_ssh_setup() {
        // Whatever this machine has, the contract is that it answers rather than fails: the picker
        // has to render on a box with no `~/.ssh`, no agent and no `ssh-add`.
        let keys = list();
        for key in &keys {
            assert!(!key.label.is_empty(), "every offered identity needs something to click");
        }
    }

    #[test]
    fn a_key_name_is_one_plain_segment_or_it_is_refused() {
        for good in ["id_ed25519_work", "deploy-2026", "github.personal"] {
            assert!(checked_name(good).is_ok(), "{good}");
        }
        for bad in ["", "../escape", "a/b", ".hidden", "id.pub", "with space", "ñandú"] {
            assert!(checked_name(bad).is_err(), "{bad}");
        }
    }

    /// Real `ssh-keygen`, into a throwaway directory: the pair is made, the passphrase went in by
    /// stdin (the private key only opens with it), and a second key under the same name is refused
    /// without the first changing by a byte.
    #[test]
    fn a_key_is_generated_with_its_passphrase_and_never_over_an_existing_one() {
        if crate::proc::std_command("ssh-keygen").arg("-?").output().is_err() {
            eprintln!("no ssh-keygen on this machine; skipping");
            return;
        }
        let dir = std::env::temp_dir().join(format!("cf-keys-{}", uuid::Uuid::new_v4()));
        let key = generate_in(&dir, "test_key", "correct horse", "deploy@example.test").unwrap();
        assert_eq!(key.kind, "ssh-ed25519");
        assert_eq!(key.comment, "deploy@example.test");
        assert_eq!(key.label, "test_key");
        let private = dir.join("test_key");
        let before = std::fs::read(&private).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&private).unwrap().permissions().mode() & 0o077, 0, "private");
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
            let opens = crate::proc::std_command("ssh-keygen")
                .args(["-y", "-P", "correct horse", "-f"])
                .arg(&private)
                .output()
                .unwrap();
            assert!(opens.status.success(), "the passphrase is the one that was typed");
            let wrong = crate::proc::std_command("ssh-keygen")
                .args(["-y", "-P", "", "-f"])
                .arg(&private)
                .stdin(std::process::Stdio::null())
                .output()
                .unwrap();
            assert!(!wrong.status.success(), "and the key is not left unprotected");
        }

        let again = generate_in(&dir, "test_key", "", "").unwrap_err();
        assert!(again.contains("already exists"), "{again}");
        assert_eq!(std::fs::read(&private).unwrap(), before, "nothing was overwritten");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_public_key_line_splits_into_kind_blob_and_comment() {
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 sam@laptop";
        let mut parts = line.split_whitespace();
        assert_eq!(parts.next(), Some("ssh-ed25519"));
        assert_eq!(parts.next(), Some("AAAAC3NzaC1lZDI1NTE5"));
        assert_eq!(parts.collect::<Vec<_>>().join(" "), "sam@laptop");
    }
}
