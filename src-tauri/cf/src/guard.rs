//! `cf guard`: Claude Code's `PreToolUse` hook for the shell tool. A command that destroys something
//! the user cannot get back waits for their approval in the app, whether or not the agent remembered
//! to `cf ask` first.
//!
//! The system note asks agents to `cf ask` before anything irreversible, and that is a request a
//! model can forget. A hook is not: Claude Code runs it before every tool call and does what it
//! answers. Everything that is not destructive is answered here, with no request to the app — the
//! hook runs on every shell command an agent types, and almost none of them are.
//!
//! The answer is Claude Code's hook JSON on stdout, always with exit code 0:
//!
//! - **approved** in the app → `allow`, so the agent is not asked a second time in its own terminal;
//! - **refused** → `deny`, with the user's words as the reason the agent reads;
//! - **no app to ask** (closed, or a shell it did not open) → `ask`, which hands the decision to
//!   Claude Code's own permission prompt rather than letting the command through unseen.
//!
//! **Codex reads the same hook.** Its `PreToolUse` (0.163) sends Claude Code's payload — `tool_name`
//! `"Bash"`, `tool_input.command` — plus a `turn_id` of its own, and takes the same answer, except
//! that it refuses `ask` ("unsupported permissionDecision:ask"). So for Codex an `ask` becomes a
//! `deny` that tells the agent to put the question to the user with `cf ask` first. Verified against
//! a local fake of the Responses API: a `deny` here blocks the command. Codex runs a hook only once
//! the user has trusted it, which is theirs to do — the app does not bypass that trust.
//!
//! The rules read the command the way a shell would split it — quotes, `&&`, pipes, `sudo`, `env`,
//! `xargs`, `bash -c '…'` — so `git commit -m "rm -rf"` is a commit and `\rm -rf x` is a delete.

use std::io::Read;

use crate::rules::dangerous;
use crate::{call, json_string, quote, Endpoint};

pub fn run() -> ! {
    let mut payload = Vec::new();
    let _ = std::io::stdin().take(4 << 20).read_to_end(&mut payload);
    let payload = String::from_utf8_lossy(&payload);
    let tool = json_string(&payload, "tool_name", 200).unwrap_or_default();
    if tool != "Bash" {
        std::process::exit(0);
    }
    let Some(command) = json_string(&payload, "command", usize::MAX) else { std::process::exit(0) };
    let Some(reason) = dangerous(&command) else { std::process::exit(0) };
    // Codex's payload, which has no `ask` to hand back.
    let codex = json_string(&payload, "turn_id", 200).is_some();
    let unreachable = |reason: &str| -> ! {
        if codex {
            decide("deny", &format!("{reason} — CodeFlow is not reachable to approve it. Ask the user first with cf ask <question>, then run it only if they say yes."))
        }
        decide("ask", &format!("{reason} — CodeFlow is not reachable to approve it"))
    };

    let Some(endpoint) = Endpoint::from_env() else { unreachable(reason) };
    let body = endpoint.body("guard", &command, &[reason.to_string()], "");
    match call(&endpoint.port, &body) {
        Ok(reply) if reply.contains("\"ok\":true") => decide("allow", &format!("Approved in CodeFlow: {reason}")),
        Ok(reply) => {
            let said = crate::field(&reply, "text");
            let said = if said.is_empty() || said == "no" { String::new() } else { format!(" They said: {said}") };
            decide("deny", &format!("The user did not approve this in CodeFlow ({reason}).{said}"))
        }
        Err(_) => unreachable(reason),
    }
}

fn decide(decision: &str, reason: &str) -> ! {
    println!(
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":{},\"permissionDecisionReason\":{}}}}}",
        quote(decision),
        quote(reason)
    );
    std::process::exit(0);
}
