//! `cf` — the command an agent runs to reach the CodeFlow window it is working inside.
//!
//! ```text
//!   cf notify "tests are green"   a line in the app, wherever the user is
//!   cf ask "drop the column?"     blocks until the user says yes or no; prints what they typed
//!   cf choose "which db?" pg my   blocks until the user picks one; prints it
//!   cf logs api --tail 50         what a service the app runs has printed
//!   cf help                       every verb (see `USAGE`)
//!   cf hook <agent> <event>       an agent's status hook: reads its JSON on stdin, prints nothing
//!   cf guard                      Claude Code's PreToolUse hook: holds a destructive command for
//!                                 the user's approval (see `guard.rs`)
//! ```
//!
//! Exit code `0` when the app answered yes, `1` otherwise — so `cf ask "go ahead?" && rm -rf …` is
//! a sentence a shell understands.
//!
//! # Why it speaks HTTP by hand
//!
//! It is one request to `127.0.0.1` and it must start instantly, on two platforms, from inside a
//! shell that is already waiting on it. Linking an HTTP client (and a TLS stack behind it) for that
//! would make the binary tens of megabytes and its first run measurably slow. This is a few hundred
//! lines of `std::net`, no dependencies at all.
//!
//! # Where the port comes from
//!
//! `CODEFLOW_PORT` and `CODEFLOW_TOKEN`, which the app puts into the environment of every shell it
//! opens (`agentcli::shell_env`). A process started any other way has neither, and says so rather
//! than failing obscurely — that message is the one a user is most likely to see, because running
//! `cf` in an ordinary terminal is the obvious first thing to try.
//!
//! # What goes over the wire
//!
//! One JSON object: the verb, the arguments both joined (`text`, for the verbs that take a sentence)
//! and as given (`args`, for the ones that take several), the folder `cf` ran in, the terminal
//! session it runs in, and — for `cf llm` only — whatever was piped into it. The answer is
//! `{"ok":…,"text":…}`; `ok` is the exit code, `text` is printed.

mod guard;
mod rules;

use std::io::{IsTerminal, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let verb = args.next().unwrap_or_default();
    let rest: Vec<String> = args.collect();
    match verb.as_str() {
        "hook" => hook(&rest),
        "guard" => guard::run(),
        // From outside the app: a script or a CI job starting a saved plan (see `outside`).
        "templates" | "run" | "status" if std::env::var("CODEFLOW_PORT").is_err() || verb != "status" => outside(&verb, &rest),
        "" => {
            println!("{USAGE}");
            std::process::exit(1);
        }
        "help" | "-h" | "--help" => {
            println!("{USAGE}");
            std::process::exit(0);
        }
        _ => {}
    }
    // The rest of the line, joined: `cf notify tests are green` means the same as the quoted form,
    // because the first thing anyone does is forget the quotes.
    let text = rest.join(" ");

    let Some(endpoint) = Endpoint::from_env() else {
        eprintln!("cf: not running inside a CodeFlow terminal (no CODEFLOW_PORT)");
        std::process::exit(1);
    };

    // The material for the local model, when something is piped in. Never read from a terminal: a
    // `cf llm` typed by hand would otherwise sit waiting for an end-of-file nobody knows to send.
    let stdin = if verb == "llm" && !std::io::stdin().is_terminal() {
        let mut bytes = Vec::new();
        let _ = std::io::stdin().take(STDIN_LIMIT as u64 + 1).read_to_end(&mut bytes);
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if bytes.len() > STDIN_LIMIT {
            truncate_at_char(&mut text, STDIN_LIMIT);
            text.push_str("\n[… input cut by cf at 2 MB]");
        }
        text
    } else {
        String::new()
    };

    let body = endpoint.body(&verb, &text, &rest, &stdin);
    match call(&endpoint.port, &body) {
        Ok(reply) => {
            let text = field(&reply, "text");
            if !text.is_empty() {
                println!("{text}");
            }
            // `"ok":true` is the whole protocol on the way back; anything else is a no.
            std::process::exit(if reply.contains("\"ok\":true") { 0 } else { 1 });
        }
        Err(error) => {
            eprintln!("cf: {error}");
            std::process::exit(1);
        }
    }
}

// ------------------------------------------------------------------------------------ outside

/// Exit codes of the verbs that run from outside CodeFlow. A script branches on these, so they are a
/// contract: `3` is "a person has to decide" and `4` is "still going, I stopped waiting" — the two
/// that a plain pass/fail could not tell apart from a failure.
mod exit {
    pub const DONE: i32 = 0;
    pub const FAILED: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const NEEDS_PERSON: i32 = 3;
    pub const TIMED_OUT: i32 = 4;
    pub const NO_APP: i32 = 5;
}

/// Where the app wrote how to reach it, for a process it did not start. `CODEFLOW_AUTOMATION_DIR` wins;
/// otherwise the app's state folder (`paths::state_dir` in the app) under `automation`.
fn automation_dir() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("CODEFLOW_AUTOMATION_DIR").filter(|dir| !dir.is_empty()) {
        return Some(dir.into());
    }
    let home = || std::env::var_os("HOME").map(std::path::PathBuf::from);
    let base = if cfg!(target_os = "macos") {
        home()?.join("Library/Application Support")
    } else if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)?
    } else {
        std::env::var_os("XDG_DATA_HOME").filter(|dir| !dir.is_empty()).map(std::path::PathBuf::from).or_else(|| home().map(|h| h.join(".local/share")))?
    };
    Some(base.join("CodeFlow").join("automation"))
}

/// `(port, token)` out of `connection.json`.
fn read_connection(text: &str) -> Option<(String, String)> {
    let port: String = text.split("\"port\"").nth(1)?.trim_start().strip_prefix(':')?.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    let token = json_string(text, "token", 200)?;
    (!port.is_empty() && !token.is_empty()).then_some((port, token))
}

/// `30m`, `90s`, `2h`, or bare seconds. `None` for anything else — a typo must not become "wait forever".
fn parse_duration(text: &str) -> Option<Duration> {
    let text = text.trim();
    let (number, unit) = match text.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((at, _)) => text.split_at(at),
        None => (text, "s"),
    };
    let amount: u64 = number.parse().ok()?;
    let seconds = match unit {
        "s" | "" => amount,
        "m" => amount.checked_mul(60)?,
        "h" => amount.checked_mul(3600)?,
        _ => return None,
    };
    (seconds > 0).then(|| Duration::from_secs(seconds))
}

/// How a chain's `status` reply maps to an exit code, or `None` while it is still going.
fn exit_for(reply: &str) -> Option<i32> {
    if reply.contains("\"needs_person\":true") {
        return Some(exit::NEEDS_PERSON);
    }
    match json_string(reply, "status", 40).as_deref() {
        Some("done") => Some(exit::DONE),
        Some("failed") | Some("aborted") => Some(exit::FAILED),
        _ => None,
    }
}

/// `cf templates | run <template> [--repo p] [--goal g] [--wait] [--timeout 30m] | status <chain>`,
/// from a process CodeFlow did not start. Reads the connection file the app wrote when the person
/// turned this on; with it off, or the app closed, there is no file and the exit code says so (`5`).
fn outside(verb: &str, args: &[String]) -> ! {
    let Some(dir) = automation_dir() else { fail("cf: cannot tell where CodeFlow keeps its connection file", exit::NO_APP) };
    let Ok(text) = std::fs::read_to_string(dir.join("connection.json")) else {
        fail("cf: CodeFlow is not running, or running plans from outside is off (Ajustes › Herramientas de IA)", exit::NO_APP)
    };
    let Some((port, token)) = read_connection(&text) else { fail("cf: the connection file is unreadable", exit::NO_APP) };

    // Flags that are this client's own, taken out before the rest goes to the app.
    let mut rest = Vec::new();
    let (mut wait, mut timeout) = (false, Duration::from_secs(30 * 60));
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--wait" => wait = true,
            "--timeout" => {
                let Some(parsed) = iter.next().and_then(|value| parse_duration(value)) else {
                    fail("cf: --timeout takes a duration like 90s, 30m or 2h", exit::USAGE)
                };
                timeout = parsed;
            }
            _ => rest.push(arg.clone()),
        }
    }
    if (verb == "run" || verb == "status") && rest.is_empty() {
        fail(if verb == "run" { "usage: cf run <template> [--repo <path>] [--goal <text>] [--wait] [--timeout 30m]" } else { "usage: cf status <chain>" }, exit::USAGE);
    }

    let ask = |verb: &str, args: &[String]| -> Result<(bool, String), String> {
        let endpoint = Endpoint { port: port.clone(), token: token.clone(), session: String::new() };
        let reply = call(&endpoint.port, &endpoint.body(verb, &args.join(" "), args, ""))?;
        Ok((reply.contains("\"ok\":true"), field(&reply, "text")))
    };
    let answer = |verb: &str, args: &[String]| match ask(verb, args) {
        Ok((true, text)) => text,
        Ok((false, text)) => fail(&format!("cf: {}", if text.is_empty() { "refused" } else { &text }), if text == "not from this app" { exit::NO_APP } else { exit::FAILED }),
        Err(error) => fail(&format!("cf: {error}"), exit::NO_APP),
    };

    match verb {
        "templates" => {
            println!("{}", answer("templates", &[]));
            std::process::exit(exit::DONE);
        }
        "status" => {
            let text = answer("status", &rest);
            println!("{text}");
            // Still going is `4`, the same word a `--wait` that gave up says.
            std::process::exit(exit_for(&text).unwrap_or(exit::TIMED_OUT));
        }
        _ => {
            let started = answer("run", &rest);
            println!("{started}");
            if !wait {
                std::process::exit(exit::DONE);
            }
            let chain = json_string(&started, "chain", 80).unwrap_or_default();
            let until = std::time::Instant::now() + timeout;
            loop {
                let text = answer("status", &[chain.clone()]);
                if let Some(code) = exit_for(&text) {
                    println!("{text}");
                    std::process::exit(code);
                }
                if std::time::Instant::now() >= until {
                    println!("{text}");
                    std::process::exit(exit::TIMED_OUT);
                }
                std::thread::sleep(Duration::from_secs(3));
            }
        }
    }
}

fn fail(message: &str, code: i32) -> ! {
    eprintln!("{message}");
    std::process::exit(code)
}

/// The most of a pipe `cf llm` sends. The app cuts it again to what the local model can read; this
/// only keeps a `cat` of something enormous from becoming an enormous request.
const STDIN_LIMIT: usize = 2 << 20;

const USAGE: &str = "cf — talk to the CodeFlow window this shell is in

Asking the user
  cf ask <question>                 yes or no; exits 0 on Yes, 1 on No; prints what they typed
  cf choose <question> <a> <b> ...  the user picks one; prints it; exits 1 if dismissed
  cf notify <text>                  put a line in the app, wherever the user is
  cf progress <text>                your status line on this terminal's agent card (3/7 tests)
  cf done [text]                    your work is finished: marks the card and tells the user

From outside CodeFlow (a script, CI; turn it on in Ajustes › Herramientas de IA)
  cf templates                      the saved plans, as JSON
  cf run <plan> [--repo <path>] [--goal <text>] [--wait] [--timeout 30m]
                                    start one in a repository CodeFlow has; --wait blocks until it ends
  cf status <chain>                 how it is going, as JSON
                                    exit: 0 done · 1 failed · 2 usage · 3 needs a person · 4 still going / timed out · 5 app unreachable

Driving the app's interface
  cf ui state                       what every window shows, as JSON
  cf ui actions [area]              what it can do: `id {params} — what it does`
  cf ui <action> ['{json}']         do one (cf ui app.open '{\"app\":\"flows\"}'); destructive ones ask first

Showing things to the user
  cf review                         open the diff of the task this folder belongs to
  cf open <file>[:line]             open a file of the project in the app's editor
  cf status                         what the app has in focus, as JSON

What is running
  cf logs [service] [--tail N]      a service's recent output; no name lists the services
  cf restart <service>              restart a service the app runs
  cf wait <service> [--timeout S]   block until it is ready; exits 1 if it fails or times out
  cf term [panel] [--tail N]        another terminal's recent output; no name lists them

Clusters and Azure, looked at (never changed; defaults: what the Contenedores panel has picked)
  cf k8s get <kind> [name]          pods, deploy, svc, ing, events… [--context C] [-n ns | -A]
  cf k8s describe|yaml <kind> <name>  one object (a Secret's values masked)
  cf k8s logs <pod> [-c c] [--tail N] [--previous]   a deployment's name or part of one works too
  cf k8s top [pods|nodes] [name]    CPU and memory now (needs the cluster's metrics server)
  cf k8s topology                   how ingresses, services, workloads and config connect; problems
  cf k8s contexts                   the clusters there are
  cf azure resources|health         the resources with their state and Resource Health [--sub S] [-g G]
  cf azure show <name|id>           one resource's properties (secrets dropped)
  cf azure activity [name] [--hours H]  the activity log: who changed what, what failed
  cf azure logs <name> [--tail N]   an App Service, Container App or Container Instance's logs
  cf azure metrics <name> [--hours H] [--metric a,b]  CPU, memory, requests, errors: last, avg, peak
  cf azure query <workspace> <KQL>  a Log Analytics query [--hours H]; cf azure workspaces lists them
  cf azure topology                 how the resources connect (ids, hosts, settings by name)
  cf azure subscriptions|groups
  cf containers ps|images|volumes|networks|compose   the local engines' (Docker, Podman, nerdctl) [--engine E]
  cf containers inspect <name> | logs <name> [--tail N] | stats [name]   env values masked

The code, and what the app knows about it
  cf symbol <name>                  where a symbol is defined
  cf usages <name>                  where it is used
  cf outline <file>                 a file's symbols, with lines
  cf map                            the project's map
  cf search <question>              the project's code, docs and notes, ranked
  cf recall <question>              what the app remembers about this project
  cf remember <fact>                propose a memory; the user approves it in the app
                                    [--kind decision|convention|fact|preference]
  cf contradict <memory> -- <why>   tell the user an approved memory is contradicted by the code
                                    [--evidence <path:line>]
  cf task <title> [-- <what to do>] a draft task in the project's task tree [--agent <name>]

The local model (nothing leaves the machine)
  cf llm <instruction> [< file]     ask the local model; what is piped in is the material

Databases the user opened to AI (Acceso de IA): reads run at once, each write is approved
  cf dbs                            the connections open to AI, and what you may do on each
  cf dbschema <connection> [table]  tables, columns, keys and relationships [--database D] [--schema S]
  cf db <connection> <SQL>          run it: a read at once (read-only session), a write once the
                                    user approves it [--read refuses writes] [--max-rows N]

Saved credentials: the app uses them and never shows them; every use is approved by the user
  cf http <request> [--env <name>]  send a request saved in the API client (Collection/Folder/Name)
  cf secret <NAME> -- '<command>'   the app runs the command with the Llavero entry NAME in an
                                    environment variable named after it (GitHub token: $GITHUB_TOKEN;
                                    --env VAR picks another, --field KEY another field) and prints its
                                    output with the secret removed; single quotes keep your shell from
                                    expanding the variable before the app has set it";

/// Where the app is listening, and what a request carries besides its verb.
struct Endpoint {
    port: String,
    token: String,
    session: String,
}

impl Endpoint {
    fn from_env() -> Option<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Some(Endpoint { port: var("CODEFLOW_PORT")?, token: var("CODEFLOW_TOKEN")?, session: var("CODEFLOW_SESSION").unwrap_or_default() })
    }

    fn body(&self, verb: &str, text: &str, args: &[String], stdin: &str) -> String {
        let cwd = std::env::current_dir().map(|path| path.display().to_string()).unwrap_or_default();
        let args = args.iter().map(|arg| quote(arg)).collect::<Vec<_>>().join(",");
        format!(
            "{{\"token\":{},\"verb\":{},\"text\":{},\"cwd\":{},\"session\":{},\"args\":[{}],\"stdin\":{}}}",
            quote(&self.token),
            quote(verb),
            quote(text),
            quote(&cwd),
            quote(&self.session),
            args,
            quote(stdin)
        )
    }
}

/// One request, one answer, connection closed. No timeout of its own: `cf ask` is *meant* to wait
/// for a human, and the app's own timeout is what ends an unanswered one.
fn call(port: &str, body: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port.parse::<u16>().map_err(|_| "bad port")?))
        .map_err(|e| format!("the app is not listening ({e})"))?;
    let request = format!(
        "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&reply).into_owned())
}

/// A string field out of the reply, unescaped in full. Hand-rolled for the same reason the HTTP is:
/// a JSON crate here would be the only dependency in the binary.
fn field(reply: &str, name: &str) -> String {
    let key = format!("\"{name}\":\"");
    let Some(start) = reply.find(&key) else { return String::new() };
    unescape(&reply[start + key.len()..], usize::MAX)
}

/// A JSON string. Only the escapes a command line can contain — quotes, backslashes, newlines and
/// the control characters a pasted message can carry.
fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn truncate_at_char(text: &mut String, limit: usize) {
    let mut cut = limit.min(text.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
}

/// The most of one field a hook sends — the app keeps less than this for a card line anyway.
const HOOK_FIELD: usize = 2000;

/// `cf hook <agent> <event>`: an agent's status hook, for its line on the «Worktrees» rail.
///
/// **Silent, and always exit 0.** Whatever a hook prints on stdout Claude Code adds to the
/// conversation, and exit code 2 blocks the agent: a status line must never do either. No app, no
/// session, an app that is slow to answer — it gives up quietly, in well under the hook's own timeout.
///
/// The payload is read here and only the fields a card shows are sent on, so a long reply never has
/// to fit in the endpoint's request cap.
fn hook(args: &[String]) -> ! {
    let quiet = || std::process::exit(0);
    let (Some(agent), Some(event)) = (args.first(), args.get(1)) else { quiet() };
    let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let (Some(port), Some(token), Some(session)) = (var("CODEFLOW_PORT"), var("CODEFLOW_TOKEN"), var("CODEFLOW_SESSION")) else {
        quiet()
    };
    let mut payload = Vec::new();
    let _ = std::io::stdin().take(16 << 20).read_to_end(&mut payload);
    let payload = String::from_utf8_lossy(&payload);
    let pick = |keys: &[&str]| keys.iter().find_map(|key| json_string(&payload, key, HOOK_FIELD)).unwrap_or_default();
    let prompt = if event == "UserPromptSubmit" { pick(&["prompt", "user_prompt"]) } else { String::new() };
    let reply = if event == "Stop" { pick(&["last_assistant_message"]) } else { String::new() };
    let tool = if event.starts_with("PreToolUse") { pick(&["tool_name"]) } else { String::new() };
    let cwd = std::env::current_dir().map(|path| path.display().to_string()).unwrap_or_default();
    let body = format!(
        "{{\"token\":{},\"verb\":\"hook\",\"text\":{},\"cwd\":{},\"session\":{},\"agent\":{},\"prompt\":{},\"reply\":{},\"tool\":{}}}",
        quote(&token),
        quote(event),
        quote(&cwd),
        quote(&session),
        quote(agent),
        quote(&prompt),
        quote(&reply),
        quote(&tool)
    );
    let _ = call_quick(&port, &body);
    quiet()
}

/// [`call`] with deadlines: a hook runs on every turn of the agent, and must never be what slows it.
fn call_quick(port: &str, body: &str) -> Result<(), String> {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port.parse::<u16>().map_err(|_| "bad port")?));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500)).map_err(|e| e.to_string())?;
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let request = format!(
        "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut reply = Vec::new();
    let _ = stream.read_to_end(&mut reply);
    Ok(())
}

/// The first string value under `key` in a JSON text, unescaped — at most `limit` characters.
/// Hand-rolled for the same reason the HTTP is; a key inside a string value is escaped (`\"key\"`)
/// and so never matches.
fn json_string(text: &str, key: &str, limit: usize) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut from = 0;
    while let Some(found) = text[from..].find(&needle) {
        let at = from + found;
        from = at + needle.len();
        if text[..at].ends_with('\\') {
            continue;
        }
        let rest = text[from..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else { continue };
        let Some(rest) = rest.trim_start().strip_prefix('"') else { continue };
        return Some(unescape(rest, limit));
    }
    None
}

/// A JSON string body up to its closing quote, at most `limit` characters of it.
fn unescape(rest: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    let mut chars = rest.chars();
    let mut push = |out: &mut String, ch: char| {
        if count < limit {
            out.push(ch);
            count += 1;
        }
    };
    while let Some(ch) = chars.next() {
        match ch {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') => push(&mut out, '\n'),
                Some('t') => push(&mut out, '\t'),
                Some('r') | Some('b') | Some('f') => {}
                Some('u') => {
                    let code: String = chars.by_ref().take(4).collect();
                    let Ok(mut unit) = u32::from_str_radix(&code, 16) else { break };
                    // A surrogate pair is two escapes: the high half first.
                    if (0xd800..0xdc00).contains(&unit) {
                        let tail: String = chars.by_ref().take(6).collect();
                        if let Some(low) = tail.strip_prefix("\\u").and_then(|hex| u32::from_str_radix(hex, 16).ok()) {
                            unit = 0x10000 + ((unit - 0xd800) << 10) + (low.wrapping_sub(0xdc00) & 0x3ff);
                        }
                    }
                    if let Some(ch) = char::from_u32(unit) {
                        push(&mut out, ch);
                    }
                }
                Some(other) => push(&mut out, other),
                None => break,
            },
            ch => push(&mut out, ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hook_field_is_read_with_its_escapes_and_never_from_inside_a_string() {
        let payload = r#"{"session_id":"x","hook_event_name":"UserPromptSubmit","note":"say \"prompt\": no","prompt" : "arregla el \"login\"\nya é 😀"}"#;
        assert_eq!(json_string(payload, "prompt", HOOK_FIELD).as_deref(), Some("arregla el \"login\"\nya é 😀"));
        assert_eq!(json_string(payload, "missing", HOOK_FIELD), None);
        assert_eq!(
            json_string(r#"{"tool_name":"AskUserQuestion","tool_input":{}}"#, "tool_name", HOOK_FIELD).as_deref(),
            Some("AskUserQuestion")
        );
    }

    /// serde_json writes control characters as `\u00XX`; the old reader printed them as `u001b`.
    #[test]
    fn a_reply_is_unescaped_in_full_including_unicode_escapes() {
        let reply = "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"text\":\"a\\u0009b \\\"q\\\" \\u00e9\\nlast\"}";
        assert_eq!(field(reply, "text"), "a\tb \"q\" é\nlast");
        assert_eq!(field("{\"ok\":false}", "text"), "");
    }

    #[test]
    fn durations_are_read_strictly() {
        assert_eq!(parse_duration("90s"), Some(Duration::from_secs(90)));
        assert_eq!(parse_duration("30m"), Some(Duration::from_secs(1800)));
        assert_eq!(parse_duration("2h"), Some(Duration::from_secs(7200)));
        assert_eq!(parse_duration("45"), Some(Duration::from_secs(45)));
        // A typo is an error, never "forever".
        for bad in ["", "m", "0s", "-5s", "3d", "1.5m", "soon"] {
            assert_eq!(parse_duration(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_chains_status_becomes_an_exit_code_and_a_person_is_not_a_failure() {
        assert_eq!(exit_for(r#"{"status":"done","needs_person":false}"#), Some(exit::DONE));
        assert_eq!(exit_for(r#"{"status":"failed","needs_person":false}"#), Some(exit::FAILED));
        assert_eq!(exit_for(r#"{"status":"aborted","needs_person":false}"#), Some(exit::FAILED));
        assert_eq!(exit_for(r#"{"status":"gated","needs_person":true}"#), Some(exit::NEEDS_PERSON));
        assert_eq!(exit_for(r#"{"status":"paused","needs_person":true}"#), Some(exit::NEEDS_PERSON));
        assert_eq!(exit_for(r#"{"status":"running","needs_person":false}"#), None);
        assert_eq!(exit_for(r#"{"status":"queued","needs_person":false}"#), None);
    }

    #[test]
    fn the_connection_file_is_read_for_its_port_and_token() {
        assert_eq!(read_connection(r#"{"port":51234,"token":"abc-123"}"#), Some(("51234".into(), "abc-123".into())));
        assert_eq!(read_connection(r#"{"port": 7 , "token" : "t"}"#), Some(("7".into(), "t".into())));
        assert_eq!(read_connection("{}"), None);
        assert_eq!(read_connection(r#"{"port":1,"token":""}"#), None);
    }

    #[test]
    fn the_automation_folder_can_be_overridden_and_otherwise_follows_the_platform() {
        std::env::set_var("CODEFLOW_AUTOMATION_DIR", "/tmp/somewhere");
        assert_eq!(automation_dir(), Some(std::path::PathBuf::from("/tmp/somewhere")));
        std::env::remove_var("CODEFLOW_AUTOMATION_DIR");
        let dir = automation_dir().unwrap();
        assert!(dir.ends_with("CodeFlow/automation") || dir.ends_with("CodeFlow\\automation"), "{dir:?}");
    }

    #[test]
    fn the_request_carries_every_argument_as_given() {
        let endpoint = Endpoint { port: "1".into(), token: "t".into(), session: "s".into() };
        let body = endpoint.body("choose", "which? a b", &["which?".into(), "a \"b\"".into()], "");
        assert!(body.contains("\"args\":[\"which?\",\"a \\\"b\\\"\"]"), "{body}");
        assert!(body.contains("\"session\":\"s\""));
    }
}
