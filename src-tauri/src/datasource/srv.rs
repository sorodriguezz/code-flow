//! Expanding a `mongodb+srv://` URL by hand, for the machines where the driver cannot.
//!
//! **Why this exists.** `mongodb+srv://` is not an address, it is an instruction to go and find
//! one: the driver looks up `_mongodb._tcp.<host>` for the members and a `TXT` on `<host>` for the
//! options, then connects to what comes back. It does that with its own bundled resolver, which
//! reads the system's nameserver list — and on macOS that list routinely contains a link-local
//! IPv6 address with a zone index, `fe80::1%en0`, which is the router. The resolver's parser
//! rejects the `%en0`, and the whole connection dies before a single query goes out, with:
//!
//! ```text
//! failed to parse nameserver address: invalid IP address syntax, labels: {}
//! ```
//!
//! Nothing is wrong with the network, the URL or Atlas. `dig` on the same machine answers fine.
//!
//! **What this does about it.** Reads the same file, keeps the nameservers that *are* usable,
//! performs the two lookups itself, and hands the driver an ordinary `mongodb://` URL with the
//! members already in it. Only as a fallback: the driver's own path runs first, and this is reached
//! only once that has failed with exactly this class of error.
//!
//! **Deliberately not a public resolver.** Falling back to 1.1.1.1 would be three lines and would
//! also send the name of the user's cluster to a third party they never chose — and, worse, would
//! fail anyway for anyone whose cluster is on split-horizon DNS or behind a private endpoint, which
//! is precisely the population that has a custom nameserver in the first place. Their own resolver
//! is both the private answer and the correct one.

use std::net::IpAddr;

use hickory_resolver::config::{NameServerConfig, ResolverConfig};
use hickory_resolver::proto::rr::RData;
use hickory_resolver::TokioResolver;

/// Whether a failure from the driver is the one this module can do something about.
///
/// Matched on the message because that is all the driver hands back — the resolver's error is
/// flattened into a string long before it reaches here. Narrow on purpose: a DNS failure that is a
/// real DNS failure (no such cluster, no network) must keep its own message rather than being
/// retried and then reported as something else.
pub fn is_unreadable_resolver_config(error: &str) -> bool {
    error.contains("failed to parse nameserver address")
        || error.contains("no nameservers found in config")
}

/// The system's usable nameservers.
///
/// `/etc/resolv.conf`, read directly and filtered rather than handed to a parser: the whole problem
/// is that the strict parse rejects the file wholesale over one entry it dislikes, when the entries
/// beside it are perfectly good. A zone-indexed link-local address is dropped — not because it is
/// wrong, but because it cannot be reached without binding to the named interface, which is a
/// different piece of machinery than this needs.
#[cfg(unix)]
fn system_nameservers() -> Vec<IpAddr> {
    let Ok(text) = std::fs::read_to_string("/etc/resolv.conf") else { return Vec::new() };
    text.lines()
        .filter_map(|line| {
            let line = line.split('#').next().unwrap_or("").trim();
            let address = line.strip_prefix("nameserver")?.trim();
            // `fe80::1%en0` and friends. `parse` would reject these anyway; skipping them
            // explicitly is what keeps the rest of the file usable.
            if address.contains('%') {
                return None;
            }
            address.parse::<IpAddr>().ok()
        })
        .collect()
}

/// Windows and the rest keep their nameservers somewhere this doesn't read, and don't have the
/// zone-index problem in the first place — so there is nothing to recover here.
#[cfg(not(unix))]
fn system_nameservers() -> Vec<IpAddr> {
    Vec::new()
}

/// The pieces of a `mongodb+srv://` URL, split so the members can be substituted in.
struct Parts<'a> {
    /// `user:pass@`, with its `@`, or empty.
    userinfo: &'a str,
    host: &'a str,
    /// Everything from the `/` after the host onwards — the database and the query string.
    tail: &'a str,
}

fn split(url: &str) -> Option<Parts<'_>> {
    let rest = url.strip_prefix("mongodb+srv://")?;
    let (authority, tail) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    // The *last* `@` — a password may legitimately contain one, and splitting at the first would
    // cut the credential in half and produce a hostname that is really part of the password.
    let (userinfo, host) = match authority.rfind('@') {
        Some(at) => (&authority[..=at], &authority[at + 1..]),
        None => ("", authority),
    };
    // A `+srv` URL may not carry a port: the port is what the SRV records are for.
    if host.is_empty() || host.contains(':') {
        return None;
    }
    Some(Parts { userinfo, host, tail })
}

/// Turns a `mongodb+srv://` URL into a plain `mongodb://` one, doing the two lookups here.
///
/// Follows the same rules the driver would: the members come from `_mongodb._tcp.<host>`, the
/// default options from a `TXT` on `<host>`, and TLS is on unless the URL says otherwise — `+srv`
/// implies it, which is why an expanded URL that dropped it would connect in the clear to a cluster
/// that refuses plaintext.
pub async fn expand(url: &str) -> Result<String, String> {
    let Some(parts) = split(url) else {
        return Err("That doesn't look like a mongodb+srv:// URL.".to_string());
    };

    let nameservers = system_nameservers();
    if nameservers.is_empty() {
        return Err(
            "This machine's DNS configuration couldn't be read, and the only nameservers in it are \
             ones that can't be used directly (a link-local address like fe80::1%en0). Add a \
             normal DNS server in Network settings, or use the non-SRV connection string Atlas \
             offers under \"Connect → Drivers → older driver version\"."
                .to_string(),
        );
    }

    let config = ResolverConfig::from_parts(
        None,
        Vec::new(),
        nameservers.into_iter().map(NameServerConfig::udp_and_tcp).collect(),
    );
    let resolver = TokioResolver::builder_with_config(config, Default::default())
        .build()
        .map_err(|e| format!("Couldn't start a DNS resolver: {e}"))?;

    let srv_name = format!("_mongodb._tcp.{}.", parts.host);
    let records = resolver
        .srv_lookup(srv_name.as_str())
        .await
        .map_err(|e| format!("Couldn't look up the cluster's members ({srv_name}): {e}"))?;

    let mut members: Vec<String> = records
        .answers()
        .iter()
        .filter_map(|record| match &record.data {
            RData::SRV(srv) => Some(format!(
                "{}:{}",
                srv.target.to_utf8().trim_end_matches('.'),
                srv.port
            )),
            _ => None,
        })
        .collect();
    if members.is_empty() {
        return Err(format!("{} has no SRV records, so there is nothing to connect to.", parts.host));
    }
    // Sorted so two expansions of one URL produce the same string. DNS hands these back in whatever
    // order it likes, and an unstable target is a connection that looks different every time it is
    // reported in the log.
    members.sort();

    // The TXT record carries the options the cluster wants applied by default — `authSource` and
    // `replicaSet`, in practice. Absent is normal, not an error.
    let defaults = resolver
        .txt_lookup(format!("{}.", parts.host).as_str())
        .await
        .ok()
        .and_then(|txt| {
            txt.answers()
                .iter()
                .filter_map(|record| match &record.data {
                    // A TXT record arrives as a list of chunks that have to be joined back —
                    // anything over 255 bytes is split, and reading only the first would truncate
                    // a long `replicaSet=` silently.
                    RData::TXT(value) => Some(
                        value
                            .txt_data
                            .iter()
                            .map(|chunk| String::from_utf8_lossy(chunk).to_string())
                            .collect::<String>(),
                    ),
                    _ => None,
                })
                .find(|value| !value.trim().is_empty())
        })
        .unwrap_or_default();

    // `tls=true` first so anything the TXT record or the user's own query says can override it —
    // last writer wins in a query string, and the user's intent should outrank ours.
    let mut query = vec!["tls=true".to_string()];
    if !defaults.trim().is_empty() {
        query.push(defaults.trim().to_string());
    }

    let (path, existing) = match parts.tail.split_once('?') {
        Some((path, existing)) => (path, existing),
        None => (parts.tail, ""),
    };
    if !existing.is_empty() {
        query.push(existing.to_string());
    }
    let path = if path.is_empty() { "/" } else { path };

    Ok(format!(
        "mongodb://{}{}{}?{}",
        parts.userinfo,
        members.join(","),
        path,
        query.join("&")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_driver_s_own_resolver_failure_is_retried() {
        assert!(is_unreadable_resolver_config(
            "Kind: An error occurred during DNS resolution: protocol error: failed to parse \
             nameserver address: invalid IP address syntax"
        ));
        // A cluster that genuinely isn't there keeps its own message.
        assert!(!is_unreadable_resolver_config("no record found for Query { name: nope.mongodb.net }"));
        assert!(!is_unreadable_resolver_config("Authentication failed."));
    }

    #[test]
    fn the_authority_splits_into_credentials_and_host() {
        let parts = split("mongodb+srv://user:pw@cluster.example.net/").unwrap();
        assert_eq!(parts.userinfo, "user:pw@");
        assert_eq!(parts.host, "cluster.example.net");
        assert_eq!(parts.tail, "/");

        let bare = split("mongodb+srv://cluster.example.net").unwrap();
        assert_eq!(bare.userinfo, "");
        assert_eq!(bare.host, "cluster.example.net");
        assert_eq!(bare.tail, "");
    }

    /// A password may contain `@`, and splitting at the first one would read half of it as the
    /// hostname — which is a lookup for something that does not exist, reported as a DNS failure.
    #[test]
    fn an_at_sign_inside_the_password_does_not_end_the_credential() {
        let parts = split("mongodb+srv://user:p@ss@cluster.example.net/db").unwrap();
        assert_eq!(parts.userinfo, "user:p@ss@");
        assert_eq!(parts.host, "cluster.example.net");
        assert_eq!(parts.tail, "/db");
    }

    /// `+srv` gets its port from the SRV records, so one carrying a port is not a URL this can
    /// expand — better to leave it to the driver's own error than to guess.
    #[test]
    fn a_url_with_a_port_or_the_wrong_scheme_is_refused() {
        assert!(split("mongodb+srv://cluster.example.net:27017/").is_none());
        assert!(split("mongodb://cluster.example.net/").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_zone_indexed_nameserver_is_skipped_and_the_rest_survive() {
        // The exact shape macOS writes, which is what breaks the driver.
        let text = "# comment\nnameserver fe80::1%en0\nnameserver 192.168.100.1\nsearch lan\n";
        let found: Vec<IpAddr> = text
            .lines()
            .filter_map(|line| {
                let line = line.split('#').next().unwrap_or("").trim();
                let address = line.strip_prefix("nameserver")?.trim();
                if address.contains('%') {
                    return None;
                }
                address.parse::<IpAddr>().ok()
            })
            .collect();
        assert_eq!(found, vec!["192.168.100.1".parse::<IpAddr>().unwrap()]);
    }
}

