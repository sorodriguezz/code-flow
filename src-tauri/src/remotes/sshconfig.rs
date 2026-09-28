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
//!
//! **`Include` is followed**, because it is where a tidy config keeps its hosts: a two-line
//! `~/.ssh/config` that says `Include config.d/*` used to import nothing at all. It is read the way
//! `ssh_config(5)` specifies — globs expanded and taken in lexical order, a relative path resolved
//! against `~/.ssh`, `~` expanded — with a guard against the one thing a file of includes can do
//! that a flat file cannot, which is include itself.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::RemoteHostSpec;

/// How deep `Include`s may nest. The number `ssh` itself stops at (`READCONF_MAX_DEPTH`), so a
/// config `ssh` accepts is never one this refuses — and a cycle the visited set somehow missed
/// still ends.
const MAX_INCLUDE_DEPTH: usize = 16;

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

/// Every named host in the user's config, and in every file it includes.
///
/// A missing file is an empty list, not an error: "you have no SSH config" is a normal state, and
/// the caller's empty case already says the right thing.
pub fn scan() -> Result<Vec<ImportedHost>, String> {
    let Some(path) = config_path() else {
        return Ok(Vec::new());
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Couldn't read {}: {e}", path.display())),
    };
    let ssh_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    Ok(parse_file(&text, &path, &ssh_dir, dirs::home_dir().as_deref()))
}

/// Parses the config text with no includes to follow. Separate from the file read so it can be
/// tested without a home directory.
#[cfg(test)]
fn parse(text: &str) -> Vec<ImportedHost> {
    let mut parser = Parser::new(PathBuf::new(), None);
    parser.feed(text, 0);
    parser.hosts
}

/// Parses `text`, read from `path`, following its `Include`s. `ssh_dir` is what a relative include
/// is resolved against — `~/.ssh` for a user config, which is the only kind this reads.
fn parse_file(text: &str, path: &Path, ssh_dir: &Path, home: Option<&Path>) -> Vec<ImportedHost> {
    let mut parser = Parser::new(ssh_dir.to_path_buf(), home.map(Path::to_path_buf));
    // The top file counts as visited, so an include that points back at it is the cycle it is.
    parser.visited.insert(canonical(path));
    parser.feed(text, 0);
    parser.hosts
}

/// The parse in progress. A struct rather than locals because `Include` re-enters it with another
/// file's text, and the two pieces of block state have to survive that round trip.
struct Parser {
    hosts: Vec<ImportedHost>,
    /// Set by `Match`, cleared by the next `Host`. A `Match` block's directives are conditional on
    /// things this parser can't evaluate (the destination being typed, the local user, an arbitrary
    /// command's exit status), so applying them to the preceding host would state as fact something
    /// that is only sometimes true.
    in_match: bool,
    /// The row the directives being read belong to, or `None` under a block that names no host we
    /// import — `Host *`, a pattern, a `Match`. An index rather than "the last row" because an
    /// `Include` appends rows of its own, and the directives after it still belong to the block the
    /// `Include` sat in.
    current: Option<usize>,
    /// Every file already read, canonicalised — the recursion guard. A file included twice from two
    /// places is read once, which for an import is the same answer.
    visited: HashSet<PathBuf>,
    ssh_dir: PathBuf,
    home: Option<PathBuf>,
}

impl Parser {
    fn new(ssh_dir: PathBuf, home: Option<PathBuf>) -> Self {
        Self { hosts: Vec::new(), in_match: false, current: None, visited: HashSet::new(), ssh_dir, home }
    }

    fn feed(&mut self, text: &str, depth: usize) {
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
                self.in_match = false;
                self.current = None;
                for alias in value.split_whitespace() {
                    // A pattern is a rule about other hosts, not a host. `Host *` carrying the
                    // user's global defaults is the usual one, and importing it would produce a row
                    // that connects to a machine literally called `*`.
                    if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                        continue;
                    }
                    self.hosts.push(ImportedHost {
                        name: alias.to_string(),
                        // The alias *is* the address: handing `ssh` the alias is what makes every
                        // directive this parser skipped still apply. `HostName` below only
                        // overrides it when the config names one, and even then the alias would
                        // have worked.
                        spec: RemoteHostSpec { host: alias.to_string(), ..Default::default() },
                    });
                    // The directives that follow apply to the last alias only — which is what `ssh`
                    // does not do, but the alternative is silently inventing identical rows the
                    // user didn't write.
                    self.current = Some(self.hosts.len() - 1);
                }
                continue;
            }

            if key == "match" {
                self.in_match = true;
                self.current = None;
                continue;
            }

            if key == "include" {
                // Inside a `Match` the file is included only when the match holds, which this parser
                // cannot evaluate — the same reason the `Match` block's own directives are skipped.
                if !self.in_match {
                    self.include(value, depth);
                }
                continue;
            }

            if self.in_match {
                continue;
            }

            let Some(current) = self.current.and_then(|at| self.hosts.get_mut(at)) else { continue };
            match key.as_str() {
                "hostname" => current.spec.host = value.to_string(),
                "user" => current.spec.user = value.to_string(),
                "port" => current.spec.port = value.parse().unwrap_or(0),
                // First one wins: `ssh` tries them in order, and a row showing the second would
                // name a key that is not the one being offered.
                "identityfile" if current.spec.key_file.is_empty() => {
                    current.spec.key_file = value.to_string();
                    current.spec.auth = super::RemoteAuth::Key;
                }
                "proxyjump" => current.spec.jump = value.to_string(),
                _ => {}
            }
        }
    }

    /// Reads every file one `Include` line names, in the order `ssh` would.
    ///
    /// The block state is put back afterwards, as `ssh` puts back its own: an included file that
    /// opens a `Host` or a `Match` of its own does not change what the lines after the `Include`
    /// belong to.
    fn include(&mut self, value: &str, depth: usize) {
        if depth >= MAX_INCLUDE_DEPTH {
            return;
        }
        let saved = (self.in_match, self.current);
        for pattern in words(value) {
            for file in expand(&pattern, &self.ssh_dir, self.home.as_deref()) {
                if !self.visited.insert(canonical(&file)) {
                    continue;
                }
                // Unreadable is skipped rather than fatal, as `ssh` skips a glob that matches
                // nothing: one broken fragment must not cost the user every other host.
                if let Ok(text) = std::fs::read_to_string(&file) {
                    self.feed(&text, depth + 1);
                }
                (self.in_match, self.current) = saved;
            }
        }
    }
}

/// A path as the visited set knows it. Falls back to the path as given when it cannot be resolved,
/// which only costs the guard a symlink it could not see through — the depth cap still ends that.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The arguments of one directive: whitespace-separated, with double quotes keeping a path that
/// contains a space in one piece — `Include "~/My Configs/work"`.
fn words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    for ch in value.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    words.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        words.push(current);
    }
    words
}

/// The files an `Include` pattern names, in lexical order.
///
/// `~` means the home directory, and a path that is still relative after that is relative to
/// `~/.ssh` — both straight from `ssh_config(5)`. Any component may be a glob, not only the last
/// (`~/.ssh/*/config` is legal), so the walk goes component by component. Dot-files are left out of
/// a wildcard unless the pattern itself starts with a dot, which is `glob(3)`'s rule and the reason
/// `config.d/*` does not pick up an editor's `.swp` file.
fn expand(pattern: &str, ssh_dir: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let expanded = match (pattern.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            home.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(pattern),
    };
    let path = if expanded.is_absolute() { expanded } else { ssh_dir.join(expanded) };

    if !has_glob(&path.to_string_lossy()) {
        return if path.is_file() { vec![path] } else { Vec::new() };
    }

    let mut found: Vec<PathBuf> = vec![PathBuf::new()];
    for component in path.components() {
        let part = component.as_os_str().to_string_lossy().to_string();
        if !has_glob(&part) {
            for candidate in &mut found {
                candidate.push(component.as_os_str());
            }
            continue;
        }
        let Ok(glob) = globset::GlobBuilder::new(&part).literal_separator(true).build() else {
            return Vec::new();
        };
        let matcher = glob.compile_matcher();
        let mut next = Vec::new();
        for dir in &found {
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') && !part.starts_with('.') {
                    continue;
                }
                if matcher.is_match(&name) {
                    next.push(dir.join(&name));
                }
            }
        }
        next.sort();
        found = next;
    }
    found.retain(|path| path.is_file());
    found
}

fn has_glob(text: &str) -> bool {
    text.contains(['*', '?', '['])
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

    /// The other order: a `Host *` *after* a real host used to hand its defaults to that host,
    /// because "the current block" was whichever row happened to be last.
    #[test]
    fn a_pattern_block_after_a_host_does_not_write_onto_it() {
        let hosts = parse("Host real\n  HostName r.example.com\n\nHost *\n  User default\n");
        assert_eq!(hosts.len(), 1);
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

    /// A throwaway `~/.ssh` with a config and whatever it includes, removed on drop.
    struct Fixture {
        home: PathBuf,
    }

    impl Fixture {
        fn new(files: &[(&str, &str)]) -> Self {
            let home = std::env::temp_dir().join(format!("cf-sshconfig-{}", uuid::Uuid::new_v4()));
            for (path, text) in files {
                let path = home.join(".ssh").join(path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, text).unwrap();
            }
            Self { home }
        }

        fn scan(&self) -> Vec<ImportedHost> {
            let ssh = self.home.join(".ssh");
            let config = ssh.join("config");
            let text = std::fs::read_to_string(&config).unwrap();
            parse_file(&text, &config, &ssh, Some(&self.home))
        }

        fn names(&self) -> Vec<String> {
            self.scan().into_iter().map(|host| host.name).collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }

    #[test]
    fn a_relative_include_glob_is_read_from_ssh_dir_in_lexical_order() {
        let fixture = Fixture::new(&[
            ("config", "Include config.d/*\n\nHost top\n  User me\n"),
            ("config.d/20-db", "Host db\n  HostName 10.0.0.20\n"),
            ("config.d/10-web", "Host web\n  HostName 10.0.0.10\n"),
            // Not matched by `*`, the way glob(3) leaves dot-files alone.
            ("config.d/.20-db.swp", "Host swap\n"),
        ]);
        assert_eq!(fixture.names(), ["web", "db", "top"]);
        let hosts = fixture.scan();
        assert_eq!(hosts[0].spec.host, "10.0.0.10");
        assert_eq!(hosts[2].spec.user, "me");
    }

    #[test]
    fn an_include_with_a_tilde_or_an_absolute_path_is_followed() {
        let fixture = Fixture::new(&[("work/hosts", "Host build\n  User ci\n")]);
        let absolute = fixture.home.join(".ssh/work/hosts");
        std::fs::write(
            fixture.home.join(".ssh/config"),
            format!("Include ~/.ssh/work/hosts \"{}\"\n", absolute.display()),
        )
        .unwrap();
        // Named twice — once by tilde, once absolutely — and read once.
        assert_eq!(fixture.names(), ["build"]);
    }

    #[test]
    fn an_include_that_includes_itself_ends() {
        let fixture = Fixture::new(&[
            ("config", "Include loop\nHost a\n"),
            ("loop", "Include loop config\nHost b\n"),
        ]);
        assert_eq!(fixture.names(), ["b", "a"]);
    }

    /// The directives after an `Include` belong to the block the `Include` sat in, not to the
    /// last host the included file happened to declare.
    #[test]
    fn an_include_inside_a_block_does_not_steal_the_directives_after_it() {
        let fixture = Fixture::new(&[
            ("config", "Host outer\n  Include extra\n  User outer-user\n"),
            ("extra", "Host inner\n  User inner-user\n"),
        ]);
        let hosts = fixture.scan();
        let outer = hosts.iter().find(|h| h.name == "outer").unwrap();
        let inner = hosts.iter().find(|h| h.name == "inner").unwrap();
        assert_eq!(outer.spec.user, "outer-user");
        assert_eq!(inner.spec.user, "inner-user");
    }

    #[test]
    fn an_include_under_a_match_is_conditional_and_skipped() {
        let fixture = Fixture::new(&[
            ("config", "Match exec \"true\"\n  Include maybe\n"),
            ("maybe", "Host sometimes\n"),
        ]);
        assert!(fixture.names().is_empty());
    }

    #[test]
    fn a_glob_in_a_directory_component_is_expanded_too() {
        let fixture = Fixture::new(&[
            ("config", "Include */config\n"),
            ("alpha/config", "Host a\n"),
            ("beta/config", "Host b\n"),
            ("gamma/other", "Host c\n"),
        ]);
        assert_eq!(fixture.names(), ["a", "b"]);
    }

    #[test]
    fn a_missing_include_is_skipped_rather_than_fatal() {
        let fixture = Fixture::new(&[("config", "Include nowhere/*\nInclude gone\nHost kept\n")]);
        assert_eq!(fixture.names(), ["kept"]);
    }

    #[test]
    fn quoted_include_arguments_keep_their_spaces() {
        assert_eq!(words(r#"a "b c" d"#), ["a", "b c", "d"]);
    }
}
