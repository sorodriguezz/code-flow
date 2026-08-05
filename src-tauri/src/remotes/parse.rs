//! Turning a typed or pasted `ssh` command line into a host spec.
//!
//! **Why this exists.** The address of a machine almost never arrives as a form. It arrives as a
//! line in a ticket, a paragraph of onboarding docs, or a message from whoever set the box up — and
//! it is always shaped like `ssh deploy@10.0.0.7 -p 2222`. Retyping that into six fields is work
//! the app can do, and getting it wrong is a failure the user can see and fix in one place.
//!
//! **Why it is in Rust.** It is a parser, and this is where the test harness is. The frontend has
//! no test runner, and a parser without tests is a parser that quietly mis-handles `-p2222`.
//!
//! It is deliberately forgiving about *shape* and strict about *meaning*: a bare `user@host` parses,
//! a missing `ssh` prefix parses, flags in any order parse — but an unrecognised flag is reported
//! rather than dropped, because silently ignoring `-L 5432:db:5432` would produce a session the
//! user believes has a tunnel.

use serde::Serialize;

use super::{RemoteAuth, RemoteHostSpec};

/// What a line parsed to, plus what could not be honoured.
#[derive(Debug, Clone, Serialize)]
pub struct ParsedCommand {
    pub spec: RemoteHostSpec,
    /// A name to offer if the user saves this — the bare hostname, which is what they would have
    /// typed anyway.
    pub name: String,
    /// Flags recognised as flags but not modelled, kept verbatim. Surfaced so "I pasted a command
    /// with `-D 1080` and got no proxy" is answered before it is asked, rather than after.
    pub ignored: Vec<String>,
}

/// Parses a command line. `None` when there is no destination in it at all.
///
/// Anything this understands ends up in the spec; anything it recognises as a flag but doesn't
/// model ends up in `ignored`; anything that looks like a plain `-o Key=Value` is passed straight
/// through to `options`, since that is the escape hatch the spec already has.
pub fn parse_ssh_command(line: &str) -> Option<ParsedCommand> {
    let tokens = tokenize(line);
    if tokens.is_empty() {
        return None;
    }

    let mut tokens = tokens.into_iter().peekable();
    // The `ssh` itself is optional: people paste the whole line as often as just the destination.
    if tokens.peek().map(|t| t.as_str()) == Some("ssh") {
        tokens.next();
    }

    let mut spec = RemoteHostSpec::default();
    let mut ignored = Vec::new();
    let mut destination: Option<String> = None;
    let mut command_parts: Vec<String> = Vec::new();

    while let Some(token) = tokens.next() {
        // What happens *after* the destination is the one place this deliberately disagrees with
        // `ssh`.
        //
        // OpenSSH takes everything past the host as the remote command, so `ssh web-01 -p 2222`
        // tries to run `-p 2222` over there. But `ssh user@host -p port` is how people write it —
        // it is Termius's own placeholder, and it is what lands in a ticket — so a field whose
        // whole job is accepting pasted text has to understand it.
        //
        // The rule that serves both: past the destination, only a *known value-taking option*
        // stays an option. Anything else begins the remote command, and from there every token is
        // verbatim — which is what keeps `ssh web-01 tail -f /var/log/app.log` from losing its
        // `-f`.
        if destination.is_some() && !command_parts.is_empty() {
            command_parts.push(token);
            continue;
        }
        if destination.is_some() && !is_value_option(&token) {
            command_parts.push(token);
            continue;
        }

        if let Some(rest) = token.strip_prefix('-') {
            if rest.is_empty() {
                continue;
            }
            let (flag, attached) = split_flag(rest);
            let mut value = || -> Option<String> {
                attached.clone().or_else(|| tokens.next())
            };
            match flag {
                'p' => {
                    if let Some(port) = value().and_then(|v| v.parse::<u16>().ok()) {
                        spec.port = port;
                    }
                }
                'i' => {
                    if let Some(path) = value() {
                        spec.key_file = path;
                        spec.auth = RemoteAuth::Key;
                    }
                }
                'J' => {
                    if let Some(jump) = value() {
                        spec.jump = jump;
                    }
                }
                'l' => {
                    if let Some(user) = value() {
                        spec.user = user;
                    }
                }
                'o' => {
                    if let Some(option) = value() {
                        spec.options.push(option);
                    }
                }
                // Flags that take no argument and change nothing we model.
                't' | 'T' | 'v' | 'q' | 'A' | 'C' | 'N' | 'n' | 'f' | 'X' | 'Y' | '4' | '6' => {
                    ignored.push(token.clone());
                }
                // Everything else is assumed to take a value, which is the safe assumption: eating
                // one token too many loses a flag, eating one too few turns its value into the
                // destination and connects to a machine called `5432:db:5432`.
                _ => {
                    ignored.push(token.clone());
                    if attached.is_none() {
                        if let Some(taken) = tokens.next() {
                            ignored.push(taken);
                        }
                    }
                }
            }
            continue;
        }

        destination = Some(token);
    }

    let destination = destination?;
    // `user@host` — rsplit, so an `@` inside the username (an Azure/Entra-style login) keeps the
    // last one as the separator, which is what `ssh` does too.
    let (user, host) = match destination.rsplit_once('@') {
        Some((user, host)) => (Some(user.to_string()), host.to_string()),
        None => (None, destination),
    };
    if let Some(user) = user {
        if !user.is_empty() {
            spec.user = user;
        }
    }
    // A trailing `:2222` is not `ssh` syntax, but it is how everyone writes an address — and it is
    // unambiguous here because a bare host with a colon in it is not a thing.
    let host = match host.rsplit_once(':') {
        Some((name, port)) if !name.is_empty() && port.parse::<u16>().is_ok() => {
            spec.port = port.parse().unwrap_or(0);
            name.to_string()
        }
        _ => host,
    };
    if host.is_empty() {
        return None;
    }
    spec.host = host.clone();
    spec.command = command_parts.join(" ");

    Some(ParsedCommand { spec, name: host, ignored })
}

/// Whether a token is one of the options that carries a value, in the forms `-p 2222` and `-p2222`.
///
/// Only consulted after the destination has been seen; before it, every `-x` is an option because
/// that is unambiguous.
fn is_value_option(token: &str) -> bool {
    let Some(rest) = token.strip_prefix('-') else { return false };
    matches!(split_flag(rest).0, 'p' | 'i' | 'J' | 'l' | 'o')
}

/// Splits `-p2222` into (`p`, Some("2222")) and `-p` into (`p`, None).
///
/// Long flags (`--foo`) come through here as flag `-` with the rest attached, which falls into the
/// catch-all arm and is reported rather than misread.
fn split_flag(rest: &str) -> (char, Option<String>) {
    let mut chars = rest.chars();
    let flag = chars.next().unwrap_or('-');
    let attached: String = chars.collect();
    (flag, if attached.is_empty() { None } else { Some(attached) })
}

/// Splits on whitespace, honouring single and double quotes. Not a shell — no expansion, no
/// operators; a pasted command line is data here, never something to execute.
fn tokenize(line: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in line.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started {
                    parts.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => {
                current.push(ch);
                started = true;
            }
        }
    }
    if started {
        parts.push(current);
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> ParsedCommand {
        parse_ssh_command(line).expect("should parse")
    }

    #[test]
    fn the_plain_form() {
        let out = parse("ssh deploy@web-01");
        assert_eq!(out.spec.host, "web-01");
        assert_eq!(out.spec.user, "deploy");
        assert_eq!(out.name, "web-01");
    }

    #[test]
    fn the_ssh_prefix_is_optional_because_people_paste_just_the_destination() {
        assert_eq!(parse("deploy@web-01").spec.user, "deploy");
        assert_eq!(parse("web-01").spec.host, "web-01");
    }

    #[test]
    fn a_port_parses_before_or_after_the_destination_attached_or_not() {
        assert_eq!(parse("ssh -p 2222 web-01").spec.port, 2222);
        assert_eq!(parse("ssh web-01 -p 2222").spec.port, 2222);
        assert_eq!(parse("ssh -p2222 web-01").spec.port, 2222);
    }

    #[test]
    fn the_host_colon_port_form_everyone_writes_but_ssh_does_not_accept() {
        let out = parse("deploy@10.0.0.7:2222");
        assert_eq!(out.spec.host, "10.0.0.7");
        assert_eq!(out.spec.port, 2222);
    }

    #[test]
    fn an_identity_file_also_sets_the_auth_mode() {
        let out = parse("ssh -i ~/.ssh/prod deploy@web-01");
        assert_eq!(out.spec.key_file, "~/.ssh/prod");
        assert_eq!(out.spec.auth, RemoteAuth::Key);
    }

    #[test]
    fn jump_and_login_name_and_options_are_understood() {
        let out = parse("ssh -J bastion -l deploy -o Compression=yes web-01");
        assert_eq!(out.spec.jump, "bastion");
        assert_eq!(out.spec.user, "deploy");
        assert_eq!(out.spec.options, vec!["Compression=yes"]);
    }

    #[test]
    fn a_destination_user_beats_the_l_flag_because_it_is_written_closer_to_the_host() {
        assert_eq!(parse("ssh -l root deploy@web-01").spec.user, "deploy");
    }

    #[test]
    fn a_remote_command_keeps_its_own_flags_verbatim() {
        let out = parse("ssh web-01 tail -f /var/log/app.log");
        assert_eq!(out.spec.command, "tail -f /var/log/app.log");
        assert!(out.ignored.is_empty());
        assert_eq!(out.spec.port, 0);
    }

    /// The disagreement with OpenSSH, pinned: a value-taking option after the host is still an
    /// option here, because that is the form people actually paste.
    #[test]
    fn a_known_option_after_the_destination_is_still_an_option() {
        let out = parse("ssh deploy@web-01 -p 2222 -i ~/.ssh/prod");
        assert_eq!(out.spec.port, 2222);
        assert_eq!(out.spec.key_file, "~/.ssh/prod");
        assert_eq!(out.spec.command, "");
    }

    /// ...and the moment a remote command starts, it swallows everything, options included.
    #[test]
    fn once_the_remote_command_starts_a_later_dash_p_belongs_to_it() {
        let out = parse("ssh web-01 docker run -p 8080:80 nginx");
        assert_eq!(out.spec.command, "docker run -p 8080:80 nginx");
        assert_eq!(out.spec.port, 0);
    }

    #[test]
    fn an_unmodelled_flag_is_reported_with_its_value_rather_than_silently_dropped() {
        let out = parse("ssh -L 5432:db:5432 web-01");
        assert_eq!(out.spec.host, "web-01");
        assert_eq!(out.ignored, vec!["-L", "5432:db:5432"]);
    }

    #[test]
    fn a_valueless_flag_does_not_eat_the_destination() {
        let out = parse("ssh -v -C web-01");
        assert_eq!(out.spec.host, "web-01");
        assert_eq!(out.ignored, vec!["-v", "-C"]);
    }

    #[test]
    fn a_quoted_remote_command_survives_as_one_piece_of_text() {
        let out = parse(r#"ssh web-01 "systemctl status nginx""#);
        assert_eq!(out.spec.command, "systemctl status nginx");
    }

    #[test]
    fn nothing_to_connect_to_is_none_rather_than_a_blank_host() {
        assert!(parse_ssh_command("").is_none());
        assert!(parse_ssh_command("ssh").is_none());
        assert!(parse_ssh_command("ssh -v").is_none());
    }

    #[test]
    fn an_at_inside_the_username_keeps_the_last_one_as_the_separator() {
        let out = parse("ssh sam@corp.com@bastion.example.com");
        assert_eq!(out.spec.user, "sam@corp.com");
        assert_eq!(out.spec.host, "bastion.example.com");
    }

    #[test]
    fn an_ipv4_address_is_not_mistaken_for_a_host_colon_port() {
        assert_eq!(parse("ssh 10.0.0.7").spec.host, "10.0.0.7");
        assert_eq!(parse("ssh 10.0.0.7").spec.port, 0);
    }
}
