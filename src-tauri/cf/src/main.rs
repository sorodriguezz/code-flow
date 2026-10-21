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

Showing things to the user
  cf review                         open the diff of the task this folder belongs to
  cf open <file>[:line]             open a file of the project in the app's editor
  cf status                         what the app has in focus, as JSON

What is running
  cf logs [service] [--tail N]      a service's recent output; no name lists the services
  cf restart <service>              restart a service the app runs
  cf wait <service> [--timeout S]   block until it is ready; exits 1 if it fails or times out
  cf term [panel] [--tail N]        another terminal's recent output; no name lists them

The code, and what the app knows about it
  cf symbol <name>                  where a symbol is defined
  cf usages <name>                  where it is used
  cf outline <file>                 a file's symbols, with lines
  cf map                            the project's map
  cf search <question>              the project's code, docs and notes, ranked
  cf recall <question>              what the app remembers about this project
  cf remember <fact>                propose a memory; the user approves it in the app
                                    [--kind decision|convention|fact|preference]
  cf task <title> [-- <what to do>] a draft task in the project's task tree [--agent <name>]

The local model (nothing leaves the machine)
  cf llm <instruction> [< file]     ask the local model; what is piped in is the material

Saved credentials: the app uses them and never shows them; every use is approved by the user
  cf db <connection> <SQL>          run SQL on a saved database connection [--max-rows N]
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
    fn the_request_carries_every_argument_as_given() {
        let endpoint = Endpoint { port: "1".into(), token: "t".into(), session: "s".into() };
        let body = endpoint.body("choose", "which? a b", &["which?".into(), "a \"b\"".into()], "");
        assert!(body.contains("\"args\":[\"which?\",\"a \\\"b\\\"\"]"), "{body}");
        assert!(body.contains("\"session\":\"s\""));
    }
}
