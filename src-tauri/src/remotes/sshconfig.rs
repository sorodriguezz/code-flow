//! Reading `~/.ssh/config`, so nobody's first host has to be typed in.
//!
//! **This is an import, not a sync.** The file stays the user's, CodeFlow never writes to it, and
//! the rows it produces are ordinary editable hosts afterwards. Two-way sync would mean owning the
//! formatting, the comments and the `Match` blocks of a file that other tools also read, to save a
//! step that happens once.
//!
//! It also does not have to be complete, and that is the load-bearing part: because sessions run
//! the real `ssh` ([`super::session`]), a host imported as nothing but its alias still connects
//! correctly — `ssh web-01` reads the same file and applies every directive this parser skipped.
//! What is parsed here only decides how much of the row is filled in for the user to *read*.

use std::path::PathBuf;

use serde::Serialize;

use super::RemoteHostSpec;

/// One `Host` block, ready to become a row.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedHost {
    /// The alias, which is also the name the row gets — it is what the user already calls this
    /// machine, and renaming it would break the link back to the file.
    pub name: String,
    pub spec: RemoteHostSpec,
}

pub fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("config"))
}

/// Every named host in the user's config.
///
/// A missing file is an empty list, not an error: "you have no SSH config" is a normal state, and
/// the caller's empty case already says the right thing.
pub fn scan() -> Result<Vec<ImportedHost>, String> {
    let Some(path) = config_path() else {
        return Ok(Vec::new());
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(parse(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Couldn't read {}: {e}", path.display())),
    }
}

/// Parses the config text. Separate from the file read so it can be tested without a home
/// directory.
fn parse(text: &str) -> Vec<ImportedHost> {
    let mut hosts: Vec<ImportedHost> = Vec::new();
    // Set by `Match`, cleared by the next `Host`. A `Match` block's directives are conditional on
    // things this parser can't evaluate (the destination being typed, the local user, an arbitrary
    // command's exit status), so applying them to the preceding host would state as fact something
    // that is only sometimes true.
    let mut in_match = false;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // `Key value`, `Key=value`, and any amount of whitespace around either.
        let (key, value) = match line.split_once(['=', ' ', '\t']) {
            Some((key, value)) => (key.trim().to_lowercase(), value.trim_matches(['=', ' ', '\t']).trim()),
            None => continue,
        };
        if value.is_empty() {
            continue;
        }

        if key == "host" {
            in_match = false;
            for alias in value.split_whitespace() {
                // A pattern is a rule about other hosts, not a host. `Host *` carrying the user's
                // global defaults is the usual one, and importing it would produce a row that
                // connects to a machine literally called `*`.
                if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                    continue;
                }
                hosts.push(ImportedHost {
                    name: alias.to_string(),
                    // The alias *is* the address: handing `ssh` the alias is what makes every
                    // directive this parser skipped still apply. `HostName` below only overrides it
                    // when the config names one, and even then the alias would have worked.
                    spec: RemoteHostSpec { host: alias.to_string(), ..Default::default() },
                });
            }
            continue;
        }

        if key == "match" {
            in_match = true;
            continue;
        }

        if in_match {
            continue;
        }

        let Some(current) = hosts.last_mut() else { continue };
        match key.as_str() {
            "hostname" => current.spec.host = value.to_string(),
            "user" => current.spec.user = value.to_string(),
            "port" => current.spec.port = value.parse().unwrap_or(0),
            // First one wins: `ssh` tries them in order, and a row showing the second would name a
            // key that is not the one being offered.
            "identityfile" if current.spec.key_file.is_empty() => {
                current.spec.key_file = value.to_string();
                current.spec.auth = super::RemoteAuth::Key;
            }
            "proxyjump" => current.spec.jump = value.to_string(),
            _ => {}
        }
    }

    hosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_becomes_a_host_with_its_directives() {
        let hosts = parse(
            "Host web-01\n  HostName 10.0.0.7\n  User deploy\n  Port 2222\n  ProxyJump bastion\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "web-01");
        assert_eq!(hosts[0].spec.host, "10.0.0.7");
        assert_eq!(hosts[0].spec.user, "deploy");
        assert_eq!(hosts[0].spec.port, 2222);
        assert_eq!(hosts[0].spec.jump, "bastion");
    }

    #[test]
    fn an_alias_with_no_hostname_still_connects_because_the_alias_is_the_address() {
        let hosts = parse("Host prod\n  User deploy\n");
        assert_eq!(hosts[0].spec.host, "prod");
    }

    #[test]
    fn patterns_are_rules_about_hosts_and_not_hosts() {
        let hosts = parse("Host *\n  User default\n\nHost real\n  HostName r.example.com\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "real");
        // And the `User` under `Host *` must not have leaked onto it.
        assert_eq!(hosts[0].spec.user, "");
    }

    #[test]
    fn one_line_can_declare_several_aliases() {
        let hosts = parse("Host a b c\n  User deploy\n");
        assert_eq!(hosts.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        // The directives that follow apply to the last one only — which is what `ssh` does not do,
        // but the alternative is silently inventing three identical rows the user didn't write.
        assert_eq!(hosts[2].spec.user, "deploy");
    }

    #[test]
    fn equals_and_extra_whitespace_parse_the_same_as_spaces() {
        let hosts = parse("Host=web\n\tHostName = 10.0.0.9\n   User\tdeploy\n");
        assert_eq!(hosts[0].name, "web");
        assert_eq!(hosts[0].spec.host, "10.0.0.9");
        assert_eq!(hosts[0].spec.user, "deploy");
    }

    #[test]
    fn a_match_block_does_not_bleed_into_the_host_above_it() {
        let hosts = parse("Host web\n  User deploy\n\nMatch exec \"true\"\n  User root\n");
        assert_eq!(hosts[0].spec.user, "deploy");
    }

    #[test]
    fn the_first_identity_file_is_the_one_reported() {
        let hosts = parse("Host web\n  IdentityFile ~/.ssh/first\n  IdentityFile ~/.ssh/second\n");
        assert_eq!(hosts[0].spec.key_file, "~/.ssh/first");
        assert_eq!(hosts[0].spec.auth, super::super::RemoteAuth::Key);
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        let hosts = parse("# a comment\n\nHost web\n  # another\n  User deploy\n");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].spec.user, "deploy");
    }
}
