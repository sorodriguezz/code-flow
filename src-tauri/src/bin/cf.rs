//! `cf` — the command an agent runs to reach the CodeFlow window it is working inside.
//!
//! ```text
//!   cf notify "tests are green"   a line in the app, wherever the user is
//!   cf ask "drop the column?"     blocks until the user answers; prints the answer
//!   cf status                     what the app has in focus, as JSON
//!   cf review                     opens the diff of the task this folder belongs to
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

fn main() {
    let mut args = std::env::args().skip(1);
    let verb = args.next().unwrap_or_default();
    // The rest of the line, joined: `cf notify tests are green` means the same as the quoted form,
    // because the first thing anyone does is forget the quotes.
    let text = args.collect::<Vec<_>>().join(" ");

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
     cf ask <question>  ask the user; prints the answer, exits 1 if dismissed\n\
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
