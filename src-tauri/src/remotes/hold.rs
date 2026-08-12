//! What a host is holding open, and letting go of it.
//!
//! **Why this file exists.** The things a host keeps alive on somebody else's machine live in three
//! different maps, keyed three different ways, each with its own closer: `ssh -N` children by forward
//! id ([`super::forward`]), file sessions by host id ([`super::sftp`] and [`super::ftp`]), and a
//! screen's loopback bridge token by host id ([`super::screen`]). Until this file, nothing could
//! answer either of the two questions the UI actually has — *is this host holding anything* and *let
//! go of all of it* — so the composed teardown lived in the frontend store. That left two holes worth
//! closing: the backend could not release anything on quit, and no row could honestly offer a
//! disconnect, because "live" was only ever computed from what had a tab.
//!
//! **What is deliberately not here.**
//!
//! - *Shells.* A remote session is a terminal-registry entry keyed by its own `Uuid` with no host id
//!   on it, so this process cannot say which host a pty belongs to. The frontend's tabs are the
//!   authority for that, and a second host→terminal map here would be a copy that could disagree
//!   with the tab strip. `close_terminal` ends a shell; [`release`] does not.
//! - *The viewer window.* Killing the user's own VNC/RDP window would be a surprise, not a cleanup —
//!   the reasoning [`super::screen::close`] already carries.
//! - *The wsbridge listener.* Its port is a `OnceLock` and its accept loop is spawned with no handle
//!   kept, so nothing can stop it; revoking a token also does not tear down a stream already
//!   established, because the target is copied out at handshake time. Both are loopback-only and
//!   token-gated, so this is a resource note rather than a hole.
//! - *Cloud accounts.* They hold nothing between requests, on purpose. What outlives a request is the
//!   shared HTTP pool, which belongs to no host — see `cloud::http`.

use serde::Serialize;

/// What one host is holding open, as the UI needs to know it.
///
/// A host holding nothing is **absent** from [`all`] rather than present with zeros, so the map the
/// frontend builds from this is exactly "who has something to disconnect" — which is the question
/// both the dot and the menu entry ask.
#[derive(Debug, Clone, Serialize)]
pub struct HostHold {
    pub host_id: String,
    /// A file session: an `ssh -s … sftp` child ([`super::sftp`]) or a logged-in FTP control socket
    /// ([`super::ftp`]). One flag for both, because the browser in front of them does not know which
    /// it got and [`super::files::close`] closes both regardless.
    pub files: bool,
    /// Standalone `ssh -N` children. The screen's own `-L` is **not** counted here even though it
    /// lives in the same registry: somebody who opened a screen did not open a port forward, and a
    /// row reading "1 tunnel" for it would be answering a question nobody asked.
    pub forwards: usize,
    /// The screen's `-L`, its loopback bridge route, or both.
    pub screen: bool,
}

/// What every host is holding, right now.
///
/// Forwards come through [`super::forward::list`] rather than the raw map so this inherits that
/// function's reap of children that have already died — a tunnel whose `ssh` was killed by a dropped
/// network must not keep a row lit, or Disconnect becomes the button that does nothing.
pub async fn all() -> Vec<HostHold> {
    let mut holds: Vec<HostHold> = Vec::new();

    /// The row for this host, appended if it is the first thing found for it. A free function rather
    /// than a closure so the returned index can be used to write to the vector it came from.
    fn entry(holds: &mut Vec<HostHold>, host_id: &str) -> usize {
        if let Some(at) = holds.iter().position(|hold| hold.host_id == host_id) {
            return at;
        }
        holds.push(HostHold {
            host_id: host_id.to_string(),
            files: false,
            forwards: 0,
            screen: false,
        });
        holds.len() - 1
    }

    for forward in super::forward::list() {
        let at = entry(&mut holds, &forward.host_id);
        // The screen's tunnel is in this registry under a deterministic id, which is exactly what
        // `tunnel_id` being public is for: it is the one forward that is not a port forward.
        if forward.id == super::screen::tunnel_id(&forward.host_id) {
            holds[at].screen = true;
        } else {
            holds[at].forwards += 1;
        }
    }

    for host_id in super::screen::bridged_hosts() {
        let at = entry(&mut holds, &host_id);
        holds[at].screen = true;
    }

    for host_id in super::files::open_hosts().await {
        let at = entry(&mut holds, &host_id);
        holds[at].files = true;
    }

    holds
}

/// Lets go of everything one host is holding. Idempotent, like the three closers it calls.
///
/// One honest limit, stated rather than papered over: [`super::sftp::close`] de-registers a session,
/// it does not kill it. A transfer already running holds its own handle on the session for the length
/// of the copy, so that `ssh` child outlives this call — bounded by the transfer, but unreachable
/// from any command while it lasts. Cancelling a transfer is a different feature with its own UI
/// question.
pub async fn release(host_id: &str) {
    // Forwards first, and synchronously: this is the step that gives a listening port back, and
    // dropping the entry is what kills the `ssh`. The screen's tunnel is in this registry too.
    super::forward::close_host(host_id);
    // Then the bridge token. This closes the tunnel again — idempotent by design — and calling it
    // anyway keeps the token's owner responsible for revoking it, rather than making this file know
    // about `wsbridge`.
    super::screen::close(host_id);
    // Last, because it is the only step that awaits a lock. A file session whose lock is held by an
    // in-flight transfer must not delay handing a port back.
    super::files::close(host_id).await;
}

/// The same for every host at once.
///
/// The exit path's, and it is the only thing that can reach a host whose workspace was switched away
/// from: the registries are process-wide and carry no workspace id.
pub async fn release_all() {
    super::forward::close_all();
    super::screen::close_all();
    super::files::close_all().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_host_holding_nothing_is_absent_rather_than_zeroed() {
        // Nothing has been opened in this test process, so the honest answer is an empty list — not
        // one row per configured host with zeros in it. The frontend reads presence as "has something
        // to disconnect", so a zeroed row would put a Disconnect entry on an idle host.
        release_all().await;
        assert!(all().await.is_empty());
    }
}
