//! How far away a host is, in milliseconds.
//!
//! **What this measures, exactly.** The time to complete a TCP handshake against the host's SSH
//! port. Not an ICMP ping — those need raw sockets and a privilege this app doesn't have, and half
//! the internet drops them anyway. Not the SSH handshake either: that includes key exchange and
//! authentication, which is dominated by crypto and by the server's own load rather than by
//! distance, and doing it repeatedly against a server that counts authentication attempts is rude.
//!
//! A TCP connect is the honest middle: it is one round trip, it proves something is *listening*
//! there, and it is the number people mean when they say a box "feels far away".
//!
//! **It returns `None` more often than you'd expect, and that is correct.** A host reached through
//! a jump host has no route from here at all, and a host whose SSH is behind a firewall that only
//! the bastion can cross is the same. Reporting a made-up number for those, or the latency to the
//! bastion instead, would be worse than reporting nothing — so the UI shows nothing.

use std::time::{Duration, Instant};

use tokio::net::TcpStream;

/// How long to wait before calling it unreachable. Short: this runs on a poll, and a host that
/// takes two seconds to answer a TCP connect is one the user already knows is in trouble.
const TIMEOUT: Duration = Duration::from_millis(1500);

/// Round-trip time to the host's SSH port, or `None` when there is no direct route.
pub async fn measure(spec: &super::RemoteHostSpec) -> Option<u32> {
    let host = spec.host.trim();
    if host.is_empty() {
        return None;
    }
    // A jump host means the address is resolved and reachable *from the bastion*, not from here.
    // Measuring anyway would time out every poll for a host that is working perfectly.
    if !spec.jump.trim().is_empty() {
        return None;
    }

    let address = format!("{host}:{}", spec.effective_port());
    let started = Instant::now();
    match tokio::time::timeout(TIMEOUT, TcpStream::connect(&address)).await {
        Ok(Ok(_)) => Some(started.elapsed().as_millis().min(u32::MAX as u128) as u32),
        // A refused connection and a timeout are both "no number to show". They differ in what
        // they mean, but not in what this can report — and the session's own error message is
        // where the difference actually gets explained.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remotes::RemoteHostSpec;

    fn spec(host: &str) -> RemoteHostSpec {
        RemoteHostSpec { host: host.into(), ..Default::default() }
    }

    #[tokio::test]
    async fn a_host_with_no_address_is_not_measured() {
        assert!(measure(&spec("")).await.is_none());
    }

    #[tokio::test]
    async fn a_jump_host_is_skipped_rather_than_timed_out_every_poll() {
        let mut s = spec("db.internal");
        s.jump = "bastion".into();
        // Returns immediately: if this were actually attempting a connection the test would sit
        // here for the full timeout.
        let started = Instant::now();
        assert!(measure(&s).await.is_none());
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[tokio::test]
    async fn a_listening_port_reports_a_number() {
        // A real listener on loopback, so this asserts the happy path rather than only the
        // refusals — the connect has to actually complete for a duration to mean anything.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let mut s = spec("127.0.0.1");
        s.port = port;
        assert!(measure(&s).await.is_some());
    }

    #[tokio::test]
    async fn a_closed_port_is_none_not_zero() {
        // Bound then dropped: the port is free, so nothing answers on it.
        let port = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let mut s = spec("127.0.0.1");
        s.port = port;
        assert_eq!(measure(&s).await, None);
    }
}
