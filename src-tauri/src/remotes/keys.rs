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
    fn a_public_key_line_splits_into_kind_blob_and_comment() {
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 sam@laptop";
        let mut parts = line.split_whitespace();
        assert_eq!(parts.next(), Some("ssh-ed25519"));
        assert_eq!(parts.next(), Some("AAAAC3NzaC1lZDI1NTE5"));
        assert_eq!(parts.collect::<Vec<_>>().join(" "), "sam@laptop");
    }
}
