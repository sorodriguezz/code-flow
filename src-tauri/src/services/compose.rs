//! Docker Compose, which is the one kind of service whose ports its own process tree cannot show.
//!
//! `docker compose up` is a client. The containers belong to the Docker daemon, and so do the
//! published ports — on macOS they are held by Docker Desktop's backend, nowhere near the process we
//! started. So for a compose service the supervisor asks Compose itself: `docker compose ps` names
//! every container of the project, its state, its health, and what it publishes. "Ready" is then
//! what `docker compose up --wait` means by it: everything running, and healthy where a healthcheck
//! exists.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::Value;

/// What `ps` needs to address the same project the service's `up` started.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ComposeTarget {
    /// `docker` for the plugin, `docker-compose` for the standalone binary.
    pub program: String,
    /// Everything before the subcommand that selects the project: `-f`, `-p`, `--profile`, …
    pub global_args: Vec<String>,
    /// The services named after `up`, or empty for all of them.
    pub services: Vec<String>,
}

/// Whether `command` is a `docker compose up`, and if so how to ask about it.
///
/// Read from the command line rather than from the service's `kind`, because the command is the
/// truth: a service made by hand as a plain command that runs `docker compose up db` is exactly as
/// much a compose service as one created from the detector's suggestion.
pub fn target_of(command: &str) -> Option<ComposeTarget> {
    let words = split_words(command);
    // The last `&&`-separated segment that mentions compose: `cd infra && docker compose up` is a
    // compose service run from another folder.
    let start = words
        .iter()
        .rposition(|w| w == "docker-compose" || w == "compose")
        .map(|i| if words[i] == "compose" && i > 0 && words[i - 1].ends_with("docker") { i - 1 } else { i })?;
    let segment: Vec<&String> = words[start..].iter().take_while(|w| !matches!(w.as_str(), "&&" | "||" | ";" | "|")).collect();

    let (program, rest) = if segment.first().is_some_and(|w| w.ends_with("docker-compose")) {
        ("docker-compose".to_string(), &segment[1..])
    } else if segment.len() >= 2 && segment[1] == "compose" {
        ("docker".to_string(), &segment[2..])
    } else {
        return None;
    };

    let up = rest.iter().position(|w| *w == "up")?;
    let mut global_args = Vec::new();
    let mut i = 0;
    while i < up {
        let word = rest[i].as_str();
        global_args.push(word.to_string());
        // Flags that take a value as the next word. `--file=x` forms carry it inline.
        if matches!(word, "-f" | "--file" | "-p" | "--project-name" | "--project-directory" | "--env-file" | "--profile")
            && i + 1 < up
        {
            global_args.push(rest[i + 1].to_string());
            i += 1;
        }
        i += 1;
    }

    let mut services = Vec::new();
    let mut j = up + 1;
    while j < rest.len() {
        let word = rest[j].as_str();
        if word.starts_with('-') {
            // `up` flags that take a value; everything else is a switch.
            if matches!(word, "--scale" | "-t" | "--timeout" | "--wait-timeout" | "--exit-code-from" | "--attach" | "--no-attach" | "--pull")
            {
                j += 1;
            }
        } else {
            services.push(word.to_string());
        }
        j += 1;
    }

    Some(ComposeTarget { program, global_args, services })
}

/// A compose project's state, as far as the gate and the port chips care.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ComposeStatus {
    /// At least one container, every one running and healthy — or, for a one-shot container,
    /// exited cleanly.
    pub ready: bool,
    /// Every host port published by the project's containers, sorted, without duplicates.
    pub ports: Vec<u16>,
}

/// Runs `ps` for `target` in `cwd` and reads the answer. `None` when Compose could not be asked at
/// all — Docker not running, the binary missing, a timeout — which is "not ready yet", not "failed".
pub fn status(target: &ComposeTarget, cwd: Option<&Path>, env: &[(String, String)]) -> Option<ComposeStatus> {
    let mut cmd = crate::proc::std_command(&target.program);
    if target.program == "docker" {
        cmd.arg("compose");
    }
    cmd.args(&target.global_args);
    cmd.args(["ps", "--all", "--format", "json"]);
    cmd.args(&target.services);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().ok()?;

    // Bounded: a daemon that is starting up can leave `ps` hanging, and this is polled.
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut stdout = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut stdout).ok()?;
    Some(parse_ps(&stdout))
}

/// Parses `docker compose ps --format json`, which is a JSON array on Compose before 2.21 and one
/// object per line since. Both are accepted.
pub fn parse_ps(text: &str) -> ComposeStatus {
    let trimmed = text.trim();
    let containers: Vec<Value> = if trimmed.starts_with('[') {
        serde_json::from_str::<Vec<Value>>(trimmed).unwrap_or_default()
    } else {
        trimmed.lines().filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok()).collect()
    };

    let mut ports: Vec<u16> = Vec::new();
    let mut ready = !containers.is_empty();
    for container in &containers {
        let state = container.get("State").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        let health = container.get("Health").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        let exit_code = container.get("ExitCode").and_then(Value::as_i64).unwrap_or(0);
        let up = match state.as_str() {
            "running" => health.is_empty() || health == "healthy",
            // An init container that ran and finished is done, not down.
            "exited" => exit_code == 0,
            _ => false,
        };
        ready &= up;
        if let Some(publishers) = container.get("Publishers").and_then(Value::as_array) {
            for publisher in publishers {
                let published = publisher.get("PublishedPort").and_then(Value::as_u64).unwrap_or(0);
                if published > 0 && published <= u16::MAX as u64 {
                    ports.push(published as u16);
                }
            }
        }
    }
    ports.sort_unstable();
    ports.dedup();
    ComposeStatus { ready, ports }
}

/// Splits a command line into words, honouring quotes — enough to find flags in it, not a shell.
fn split_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut has_word = false;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                has_word = true;
            }
            None if c.is_whitespace() => {
                if has_word {
                    words.push(std::mem::take(&mut current));
                    has_word = false;
                }
            }
            None => {
                current.push(c);
                has_word = true;
            }
        }
    }
    if has_word {
        words.push(current);
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_up_addresses_the_whole_project() {
        let target = target_of("docker compose up").unwrap();
        assert_eq!(target.program, "docker");
        assert!(target.global_args.is_empty());
        assert!(target.services.is_empty());
    }

    #[test]
    fn project_flags_are_kept_and_services_are_read() {
        let target = target_of("docker compose -f infra/dev.yml -p shop up --build db redis").unwrap();
        assert_eq!(target.global_args, vec!["-f", "infra/dev.yml", "-p", "shop"]);
        assert_eq!(target.services, vec!["db", "redis"]);
    }

    #[test]
    fn the_standalone_binary_and_a_leading_cd_are_understood() {
        let target = target_of("cd infra && docker-compose --profile dev up -t 5 api").unwrap();
        assert_eq!(target.program, "docker-compose");
        assert_eq!(target.global_args, vec!["--profile", "dev"]);
        assert_eq!(target.services, vec!["api"]);
    }

    #[test]
    fn commands_that_are_not_an_up_are_not_compose_services() {
        assert!(target_of("pnpm dev").is_none());
        assert!(target_of("docker compose logs -f").is_none());
        assert!(target_of("docker run -p 5432:5432 postgres").is_none());
    }

    #[test]
    fn line_delimited_ps_output_is_read() {
        let text = r#"{"Name":"shop-db-1","Service":"db","State":"running","Health":"healthy","ExitCode":0,"Publishers":[{"URL":"0.0.0.0","TargetPort":5432,"PublishedPort":5432,"Protocol":"tcp"},{"URL":"::","TargetPort":5432,"PublishedPort":5432,"Protocol":"tcp"}]}
{"Name":"shop-cache-1","Service":"cache","State":"running","Health":"","ExitCode":0,"Publishers":[{"URL":"0.0.0.0","TargetPort":6379,"PublishedPort":6380,"Protocol":"tcp"},{"URL":"","TargetPort":9999,"PublishedPort":0,"Protocol":"tcp"}]}"#;
        assert_eq!(parse_ps(text), ComposeStatus { ready: true, ports: vec![5432, 6380] });
    }

    #[test]
    fn a_container_still_starting_its_healthcheck_is_not_ready() {
        let text = r#"[{"Service":"db","State":"running","Health":"starting","Publishers":[]},{"Service":"web","State":"running","Health":"","Publishers":[]}]"#;
        assert!(!parse_ps(text).ready);
    }

    #[test]
    fn an_init_container_that_finished_cleanly_counts_as_up() {
        let text = r#"[{"Service":"migrate","State":"exited","ExitCode":0},{"Service":"db","State":"running","Health":"healthy"}]"#;
        assert!(parse_ps(text).ready);
        let failed = r#"[{"Service":"migrate","State":"exited","ExitCode":1}]"#;
        assert!(!parse_ps(failed).ready);
    }

    #[test]
    fn no_containers_yet_is_not_ready() {
        assert_eq!(parse_ps(""), ComposeStatus::default());
        assert!(!parse_ps("[]").ready);
    }
}
