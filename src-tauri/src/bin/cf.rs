//! `cf` — the command an agent runs to reach the CodeFlow window it is working inside.
//!
//! ```text
//!   cf notify "tests are green"   a line in the app, wherever the user is
//!   cf ask "drop the column?"     blocks until the user says yes or no; prints what they typed
//!   cf status                     what the app has in focus, as JSON
//!   cf review                     opens the diff of the task this folder belongs to
//!   cf hook <agent> <event>       an agent's status hook: reads its JSON on stdin, prints nothing
//! ```
//!
//! Exit code `0` when the app answered yes, `1` otherwise — so `cf ask "go ahead?" && rm -rf …` is
//! a sentence a shell understands.
//!
//! # Why it speaks HTTP by hand
//!
//! It is one request to `127.0.0.1` and it must start instantly, on two platforms, from inside a
//! shell that is already waiting on it. Linking an HTTP client (and a TLS stack behind it) for that
//! would make the binary tens of megabytes and its first run measurably slow. This is sixty lines of
//! `std::net`, no dependencies at all, and it does exactly one thing.
//!
//! # Where the port comes from
//!
//! `CODEFLOW_PORT` and `CODEFLOW_TOKEN`, which the app puts into the environment of every shell it
//! opens (`agentcli::shell_env`). A process started any other way has neither, and says so rather
//! than failing obscurely — that message is the one a user is most likely to see, because running
//! `cf` in an ordinary terminal is the obvious first thing to try.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let verb = args.next().unwrap_or_default();
    let rest: Vec<String> = args.collect();
    if verb == "hook" {
        hook(&rest);
    }
    // The rest of the line, joined: `cf notify tests are green` means the same as the quoted form,
    // because the first thing anyone does is forget the quotes.
    let text = rest.join(" ");

    if verb.is_empty() || verb == "-h" || verb == "--help" {
        println!("{USAGE}");
        std::process::exit(if verb.is_empty() { 1 } else { 0 });
    }

    let (port, token) = match (std::env::var("CODEFLOW_PORT"), std::env::var("CODEFLOW_TOKEN")) {
        (Ok(port), Ok(token)) if !port.is_empty() && !token.is_empty() => (port, token),
        _ => {
            eprintln!("cf: not running inside a CodeFlow terminal (no CODEFLOW_PORT)");
            std::process::exit(1);
        }
    };

    let cwd = std::env::current_dir().map(|path| path.display().to_string()).unwrap_or_default();
    let body = format!(
        "{{\"token\":{},\"verb\":{},\"text\":{},\"cwd\":{}}}",
        quote(&token),
        quote(&verb),
        quote(&text),
        quote(&cwd)
    );

    match call(&port, &body) {
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

const USAGE: &str = "cf — talk to the CodeFlow window this shell is in\n\n\
     cf notify <text>   put a line in the app\n\
     cf ask <question>  ask the user; exits 0 on Yes, 1 on No; prints what they typed\n\
     cf status          what the app has in focus, as JSON\n\
     cf review          open the diff of the task this folder belongs to";

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
    let mut reply = String::new();
    stream.read_to_string(&mut reply).map_err(|e| e.to_string())?;
    Ok(reply)
}

/// A string field out of the reply, unescaped enough to print. Hand-rolled for the same reason the
/// HTTP is: a JSON crate here would be the only dependency in the binary.
fn field(reply: &str, name: &str) -> String {
    let key = format!("\"{name}\":\"");
    let Some(start) = reply.find(&key) else { return String::new() };
    let rest = &reply[start + key.len()..];
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => {}
                Some(other) => out.push(other),
                None => break,
            },
            other => out.push(other),
        }
    }
    out
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
    let pick = |keys: &[&str]| keys.iter().find_map(|key| json_string(&payload, key)).unwrap_or_default();
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

/// The first string value under `key` in a JSON text, unescaped — at most [`HOOK_FIELD`] characters.
/// Hand-rolled for the same reason the HTTP is; a key inside a string value is escaped (`\"key\"`)
/// and so never matches.
fn json_string(text: &str, key: &str) -> Option<String> {
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
        return Some(unescape(rest));
    }
    None
}

/// A JSON string body up to its closing quote.
fn unescape(rest: &str) -> String {
    let mut out = String::new();
    let mut count = 0;
    let mut chars = rest.chars();
    let mut push = |out: &mut String, ch: char| {
        if count < HOOK_FIELD {
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
        assert_eq!(json_string(payload, "prompt").as_deref(), Some("arregla el \"login\"\nya é 😀"));
        assert_eq!(json_string(payload, "missing"), None);
        assert_eq!(json_string(r#"{"tool_name":"AskUserQuestion","tool_input":{}}"#, "tool_name").as_deref(), Some("AskUserQuestion"));
    }
}
