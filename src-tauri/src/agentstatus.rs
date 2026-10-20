//! What an agent CLI running in one of the app's terminals is doing, read from what it prints.
//!
//! # Why this exists
//!
//! The «Worktrees» rail draws, for every working copy, the agents at work in it and whether each
//! one is writing, waiting on the user or finished. The headless tasks already say so through their
//! own events. An agent the user runs in a terminal — `claude`, `codex`, `grok`, `agy`, `cline`… —
//! says nothing to the app unless the app reads the terminal, and that is this module.
//!
//! # The three things a terminal stream carries
//!
//! - **OSC 7501**, the Program Status Protocol: the program reports `idle`, `working`, `blocked`
//!   (with a `kind`: permission, question, auth), `done` or `error`, with an optional one-line
//!   message. Claude Code and Grok send it only once the terminal answers the probe
//!   `ESC ] 7501 ; ? ST` — [`QUERY_REPLY`] is that answer, written back into the pty by the reader
//!   (see `terminal.rs`). Codex sends it unasked.
//! - **The window title** (OSC 0/2). Before the protocol, the only signal: Claude Code puts a braille
//!   spinner in front of its title while it works and `✳` when it rests. Read only while the program
//!   reports nothing through OSC 7501 — a program that answers the probe stops drawing the glyph.
//! - **A new prompt** (OSC 133/633 `A`) or a full reset: the shell is back, so whatever was running
//!   in the foreground has ended and its records go with it.
//!
//! Hooks (`cf hook`, see `agentcli.rs`) arrive through another door and outrank all three; they are
//! folded into the same [`Tracker`] so there is one place that decides what a row says.
//!
//! For agents that speak none of it (Gemini's `agy`, Cline, OpenCode) the last resort is activity:
//! output that is not the echo of a keystroke means it is writing, a quiet terminal after that means
//! it finished. Which agent it is comes from the command line the shell integration reports
//! (`OSC 633 ; E`), from the protocol's `app`, from a hook, or from the window when it launches one.
//!
//! # What it costs
//!
//! The scanner looks at bytes only when a chunk holds an ESC, keeps at most one unfinished frame
//! (capped at [`MAX_FRAME`]) between chunks, and allocates nothing for output that has no OSC in it —
//! which is nearly all of it. A [`Snapshot`] is emitted only when what a card would draw changes. The
//! one timer — turning "writing" into "finished" for an agent read by activity — is a single thread
//! that sleeps on a condvar whenever no such agent is writing.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;

/// The terminal's answer to `OSC 7501 ; ?`: the states and kinds it understands, ST-terminated.
pub const QUERY_REPLY: &str = "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";

/// A whole OSC frame, introducer to terminator. Past this an unterminated frame is dropped rather
/// than carried, so a program that never terminates one cannot make the reader hold its output.
pub const MAX_FRAME: usize = 4096;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const MAX_MSG_ENCODED: usize = 2732;
const MAX_MSG: usize = 2048;
const MAX_TITLE_ENCODED: usize = 256;
const MAX_TITLE: usize = 192;
/// A window title is free text from any program; this is plenty for a line on a card.
const MAX_WINDOW_TITLE: usize = 256;

/// What an agent is doing, in the protocol's words.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Idle,
    Working,
    Blocked,
    Done,
    Error,
}

impl AgentState {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "idle" => Self::Idle,
            "working" => Self::Working,
            "blocked" => Self::Blocked,
            "done" => Self::Done,
            "error" => Self::Error,
            _ => return None,
        })
    }
}

/// Why a `blocked` agent is waiting on the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Permission,
    Question,
    Auth,
}

impl BlockKind {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "permission" => Self::Permission,
            "question" => Self::Question,
            "auth" => Self::Auth,
            _ => return None,
        })
    }
}

/// One OSC 7501 report. `state: None` is `clear`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// `None` addresses the program itself; anything else is a child (a subagent).
    pub id: Option<String>,
    pub state: Option<AgentState>,
    pub kind: Option<BlockKind>,
    pub app: Option<String>,
    pub title: Option<String>,
    pub msg: Option<String>,
}

/// Something in the stream that moves an agent's state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OscEvent {
    /// OSC 0 or 2.
    Title(String),
    /// `OSC 7501 ; ?` — answer with [`QUERY_REPLY`].
    Query,
    Status(Report),
    /// OSC 133/633 `A`: the shell drew a prompt, so the foreground program is gone.
    PromptStart,
    /// OSC 133 `D`: the command the shell ran has finished.
    CommandEnd,
    /// OSC 633 `E`: the command line the shell is about to run.
    Command(String),
    /// OSC 7: the folder the shell is in now.
    Cwd(String),
    /// `ESC c`.
    Reset,
}

/// Finds the OSC frames in one pty stream, across chunk boundaries. Strips nothing: the bytes still
/// go to the terminal exactly as they came.
#[derive(Default)]
pub struct OscScanner {
    /// The start of a frame the last chunk ended inside.
    pending: Vec<u8>,
}

enum End {
    /// The terminator starts at `at` and is `len` bytes long (0: an ESC that begins the next
    /// sequence, which xterm also takes as the end of the string). `aborted`: CAN or SUB.
    Found { at: usize, len: usize, aborted: bool },
    /// The data ran out before a terminator.
    More,
    /// No terminator within the cap.
    TooLong,
}

fn find_end(data: &[u8], from: usize) -> End {
    let limit = (from + MAX_FRAME).min(data.len());
    for at in from..limit {
        match data[at] {
            BEL => return End::Found { at, len: 1, aborted: false },
            0x18 | 0x1a => return End::Found { at, len: 1, aborted: true },
            ESC => {
                return match data.get(at + 1) {
                    Some(b'\\') => End::Found { at, len: 2, aborted: false },
                    Some(_) => End::Found { at, len: 0, aborted: false },
                    None => End::More,
                }
            }
            _ => {}
        }
    }
    if limit == from + MAX_FRAME {
        End::TooLong
    } else {
        End::More
    }
}

impl OscScanner {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<OscEvent> {
        if self.pending.is_empty() && !chunk.contains(&ESC) {
            return Vec::new();
        }
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(chunk);
        let mut events = Vec::new();
        let mut cursor = 0;
        while let Some(offset) = data[cursor..].iter().position(|&byte| byte == ESC) {
            let esc = cursor + offset;
            let Some(&next) = data.get(esc + 1) else {
                self.pending = data[esc..].to_vec();
                break;
            };
            if next == b'c' {
                events.push(OscEvent::Reset);
                cursor = esc + 2;
                continue;
            }
            if next != b']' {
                cursor = esc + 1;
                continue;
            }
            let body = esc + 2;
            match find_end(&data, body) {
                End::Found { at, len, aborted } => {
                    if !aborted {
                        if let Some(event) = classify(&data[body..at]) {
                            events.push(event);
                        }
                    }
                    // A zero-length end leaves the ESC for the next turn of the loop.
                    cursor = at + len;
                }
                End::More => {
                    self.pending = data[esc..].to_vec();
                    break;
                }
                End::TooLong => cursor = body,
            }
        }
        events
    }
}

/// What one OSC body means here, or `None` for the many this module has no use for.
fn classify(body: &[u8]) -> Option<OscEvent> {
    if let Some(rest) = body.strip_prefix(b"0;").or_else(|| body.strip_prefix(b"2;")) {
        let title = String::from_utf8_lossy(rest);
        let title: String = title.chars().filter(|c| !c.is_control()).take(MAX_WINDOW_TITLE).collect();
        return Some(OscEvent::Title(title.trim().to_string()));
    }
    if let Some(rest) = body.strip_prefix(b"7501;") {
        return parse_status(std::str::from_utf8(rest).ok()?);
    }
    for mark in [&b"133;A"[..], &b"633;A"[..]] {
        if let Some(rest) = body.strip_prefix(mark) {
            // `133;AB` would be some other mark; options follow a `;`.
            if rest.is_empty() || rest[0] == b';' {
                return Some(OscEvent::PromptStart);
            }
        }
    }
    for mark in [&b"133;D"[..], &b"633;D"[..]] {
        if let Some(rest) = body.strip_prefix(mark) {
            if rest.is_empty() || rest[0] == b';' {
                return Some(OscEvent::CommandEnd);
            }
        }
    }
    if let Some(rest) = body.strip_prefix(b"633;E;") {
        // The line is base64 in this app's own integration scripts; anything else is not ours.
        let encoded = std::str::from_utf8(rest).ok()?.split(';').next()?.trim();
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
        let line = String::from_utf8(bytes).ok()?;
        return Some(OscEvent::Command(line.trim().to_string()));
    }
    if let Some(rest) = body.strip_prefix(b"7;") {
        return parse_cwd(std::str::from_utf8(rest).ok()?).map(OscEvent::Cwd);
    }
    None
}

/// The path out of `file://host/path`, percent-decoded.
fn parse_cwd(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[at + 1..at + 3]).ok()?, 16) {
                out.push(byte);
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    let path = String::from_utf8(out).ok()?;
    // `file:///C:/Users/…` on Windows: the drive letter comes after the slash.
    let path = match path.as_bytes() {
        [b'/', drive, b':', ..] if drive.is_ascii_alphabetic() => path[1..].to_string(),
        _ => path,
    };
    (!path.is_empty()).then_some(path)
}

fn valid_value(value: &str) -> bool {
    value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.,+/=-".contains(&b))
}

fn valid_id(id: &str) -> bool {
    let segments: Vec<&str> = id.split('/').collect();
    id.len() <= 128
        && segments.len() <= 8
        && segments.iter().all(|segment| {
            (1..=32).contains(&segment.len()) && segment.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
        })
}

/// Base64 text of one line, or `None` when the whole report must be thrown away.
fn decode_text(encoded: &str, max_encoded: usize, max: usize) -> Option<String> {
    if encoded.len() > max_encoded {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD.decode(encoded.trim_end_matches('=')).ok()?;
    if bytes.len() > max {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    if text.chars().any(char::is_control) {
        return None;
    }
    Some(text)
}

/// The body after `7501;`. Malformed pairs are skipped; a broken cap, a bad id or no state voids the
/// report — the protocol's own rules, so a later revision's extra keys are ignored rather than fatal.
pub fn parse_status(body: &str) -> Option<OscEvent> {
    if body.len() > MAX_FRAME {
        return None;
    }
    if body.trim() == "?" {
        return Some(OscEvent::Query);
    }
    let mut state = None;
    let mut cleared = false;
    let mut report = Report { id: None, state: None, kind: None, app: None, title: None, msg: None };
    let mut kind = None;
    for pair in body.split(':') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim());
        if key.len() > 16 || (key == "app" && value.len() > 32) || (key == "id" && !valid_id(value)) {
            return None;
        }
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase()) || !valid_value(value) {
            continue;
        }
        match key {
            "state" if value == "clear" => cleared = true,
            "state" => state = Some(AgentState::parse(value)?),
            "kind" => kind = BlockKind::parse(value),
            "id" => report.id = Some(value.to_string()),
            "app" => report.app = Some(value.to_string()),
            "msg" => report.msg = Some(decode_text(value, MAX_MSG_ENCODED, MAX_MSG)?),
            "title" => report.title = Some(decode_text(value, MAX_TITLE_ENCODED, MAX_TITLE)?),
            _ => {}
        }
    }
    if state.is_none() && !cleared {
        return None;
    }
    report.state = state;
    report.kind = if state == Some(AgentState::Blocked) { kind } else { None };
    Some(OscEvent::Status(report))
}

/// What a window title says about the agent that set it, when it says anything.
///
/// Claude Code: a spinner in front while it works — braille, or since 2.1.228 a quarter circle —
/// and `✳` while it rests. Gemini: `✦` (or `⏲`, working quietly) while it works, `✋` when it needs
/// permission, `◇` at rest. Other titles say nothing — a shell's `user@host: ~/dir` must not read as
/// an agent at rest.
pub fn title_state(title: &str) -> Option<AgentState> {
    let first = title.trim_start().chars().next()?;
    match first {
        '\u{2801}'..='\u{28ff}' | '\u{25d0}'..='\u{25d3}' | '✦' | '⏲' => Some(AgentState::Working),
        '✳' | '◇' => Some(AgentState::Idle),
        '✋' => Some(AgentState::Blocked),
        _ => None,
    }
}

/// A title with its status glyph taken off — what the card shows as the agent's own summary.
pub fn title_text(title: &str) -> String {
    let trimmed = title.trim_start();
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) if title_state(trimmed).is_some() || first == '\u{2800}' => chars.as_str().trim().to_string(),
        _ => trimmed.trim_end().to_string(),
    }
}

// ── The tracker ───────────────────────────────────────────────────────────────────────────────

/// Output this soon after a keystroke is the keystroke's echo, not the agent writing.
const ECHO: Duration = Duration::from_millis(400);
/// An agent read by activity is writing while it printed something this recently.
const ACTIVE: Duration = Duration::from_millis(2000);
/// How often the sweeper looks again at an agent read by activity while it writes.
const SWEEP: Duration = Duration::from_millis(700);
/// How much of a prompt or a reply a card can use.
const MAX_TEXT: usize = 600;

/// Binary → provider id: the catalogue's `defaultBinary`s (`src/lib/aiProviders.ts`), plus `gemini`,
/// the name Gemini's CLI had before `agy`.
const BINARIES: &[(&str, &str)] = &[
    ("claude", "claude"),
    ("codex", "codex"),
    ("agy", "gemini"),
    ("gemini", "gemini"),
    ("grok", "grok"),
    ("opencode", "opencode"),
    ("cline", "cline"),
];

/// A command line in words, quotes honoured (no escapes — this only has to find the first word).
fn words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in line.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => word.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            None => {
                word.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(word);
    }
    out
}

/// The agent a command line starts, or `None` — `agentFromCommand` on the window's side, kept to
/// the same rules: `VAR=value` and a few wrappers are stepped over, a path-qualified binary counts.
pub fn agent_from_command(line: &str) -> Option<&'static str> {
    const WRAPPERS: &[&str] = &["sudo", "env", "nohup", "command", "time", "exec", "&"];
    let is_assignment = |word: &str| {
        word.split_once('=').is_some_and(|(key, _)| {
            !key.is_empty()
                && !key.starts_with(|c: char| c.is_ascii_digit())
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    };
    let all = words(line);
    let command = all.iter().find(|word| !is_assignment(word) && !WRAPPERS.contains(&word.as_str()))?;
    let leaf = command.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let leaf = [".exe", ".cmd", ".bat", ".ps1"].iter().find_map(|ext| leaf.strip_suffix(ext)).unwrap_or(&leaf);
    BINARIES.iter().find(|(binary, _)| *binary == leaf).map(|(_, provider)| *provider)
}

/// The provider a protocol `app` names.
fn agent_from_app(app: &str) -> String {
    match app {
        "claude-code" | "claude" => "claude",
        "grok-build" | "grok" => "grok",
        "codex" | "codex-cli" => "codex",
        "gemini" | "gemini-cli" | "agy" | "antigravity" => "gemini",
        other => other,
    }
    .to_string()
}

/// The agent a title glyph belongs to, for a program nothing else has named.
fn agent_from_title(title: &str) -> Option<&'static str> {
    match title.trim_start().chars().next()? {
        '\u{2801}'..='\u{28ff}' | '\u{25d0}'..='\u{25d3}' | '✳' => Some("claude"),
        '✦' | '⏲' | '✋' | '◇' => Some("gemini"),
        _ => None,
    }
}

/// One line, at most [`MAX_TEXT`] characters.
fn clip(text: &str) -> String {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
        if out.chars().count() >= MAX_TEXT {
            return out.chars().take(MAX_TEXT).collect();
        }
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// What the rail draws for one terminal: emitted as `terminal:agent` whenever it changes, and a
/// snapshot with no `agent` and no `state` when the agent left (or the terminal closed).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    /// The pty session (`BenchTerminal.session_id`).
    pub session_id: String,
    /// Provider id — `claude`, `codex`, `gemini`, `grok`, `opencode`, `cline` — or `None` for a
    /// program that reports a state without saying what it is.
    pub agent: Option<String>,
    pub state: Option<AgentState>,
    pub kind: Option<BlockKind>,
    /// The program's own line: its OSC 7501 `msg`, else its title without the glyph.
    pub summary: String,
    /// What the user last asked it, when a hook said so.
    pub prompt: String,
    /// Its last answer, when a hook said so.
    pub reply: String,
    /// Where the shell is — the folder the card it belongs to is found by.
    pub cwd: String,
    /// Unix ms when `state` last changed.
    pub since: u64,
    /// Unix ms when the current turn started — what "unread" is measured against.
    pub turn: u64,
}

#[derive(Clone, Copy, Debug)]
struct Explicit {
    state: AgentState,
    kind: Option<BlockKind>,
    at: Instant,
}

/// One terminal's agent, as everything it printed and every hook it sent has described it.
#[derive(Default)]
struct Tracker {
    agent: Option<String>,
    cwd: String,
    /// The program's own root record (OSC 7501).
    program: Option<Explicit>,
    /// The last hook.
    hook: Option<Explicit>,
    msg: String,
    title: String,
    prompt: String,
    reply: String,
    /// A turn has run since this agent started — so "at rest" now means "finished".
    worked: bool,
    last_input: Option<Instant>,
    /// The last output that was not the echo of a keystroke.
    last_work: Option<Instant>,
    published: Option<Snapshot>,
}

impl Tracker {
    fn new(cwd: &str) -> Self {
        Tracker { cwd: cwd.to_string(), ..Tracker::default() }
    }

    /// A new program in the foreground, or none: nothing about the last one carries over.
    fn begin(&mut self, agent: Option<String>) {
        let cwd = std::mem::take(&mut self.cwd);
        let last_input = self.last_input;
        let published = self.published.take();
        *self = Tracker { agent, cwd, last_input, published, ..Tracker::default() };
    }

    fn active(&self) -> bool {
        self.agent.is_some() || self.program.is_some() || self.hook.is_some()
    }

    fn apply(&mut self, event: &OscEvent, now: Instant) {
        match event {
            OscEvent::Title(title) => self.title = title.clone(),
            OscEvent::Query => {}
            OscEvent::Status(report) => {
                // A child record is a subagent: the card draws the agent, not its helpers.
                if report.id.is_some() {
                    return;
                }
                match report.state {
                    None => {
                        self.program = None;
                        self.msg.clear();
                    }
                    Some(state) => {
                        self.program = Some(Explicit { state, kind: report.kind, at: now });
                        self.msg = report.msg.as_deref().map(clip).unwrap_or_default();
                        if self.agent.is_none() {
                            self.agent = report.app.as_deref().map(agent_from_app);
                        }
                    }
                }
            }
            OscEvent::PromptStart | OscEvent::CommandEnd => {
                if self.active() {
                    self.begin(None);
                }
            }
            OscEvent::Command(line) => self.begin(agent_from_command(line).map(str::to_string)),
            OscEvent::Cwd(cwd) => self.cwd = cwd.clone(),
            OscEvent::Reset => {
                self.program = None;
                self.msg.clear();
            }
        }
    }

    /// A hook from `cf hook <agent> <event>`. The event names are Claude Code's; another agent's
    /// hook only has to use the same words.
    fn hooked(&mut self, agent: &str, event: &str, prompt: &str, reply: &str, tool: &str, now: Instant) {
        if !agent.is_empty() && self.agent.as_deref() != Some(agent) {
            self.agent = Some(agent.to_string());
        }
        let set = |state, kind| Some(Explicit { state, kind, at: now });
        match event {
            "SessionStart" => {
                self.hook = set(AgentState::Idle, None);
                self.worked = false;
                self.prompt.clear();
                self.reply.clear();
            }
            "UserPromptSubmit" => {
                self.hook = set(AgentState::Working, None);
                if !prompt.trim().is_empty() {
                    self.prompt = clip(prompt);
                }
                self.reply.clear();
            }
            // The agent asking its own question is waiting on the user, whatever the event's name.
            "PreToolUse" if tool == "AskUserQuestion" || tool == "request_user_input" => {
                self.hook = set(AgentState::Blocked, Some(BlockKind::Question));
            }
            "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "SubagentStart" | "SubagentStop" => {
                self.hook = set(AgentState::Working, None);
            }
            "PermissionRequest" => self.hook = set(AgentState::Blocked, Some(BlockKind::Permission)),
            "Stop" => {
                self.hook = set(AgentState::Done, None);
                if !reply.trim().is_empty() {
                    self.reply = clip(reply);
                }
            }
            "StopFailure" => self.hook = set(AgentState::Error, None),
            "SessionEnd" => self.begin(None),
            _ => {}
        }
    }

    /// The state the card should wear, before "at rest after a turn" is read as finished. The newest
    /// explicit word wins — a hook or the program's own report — then the title glyph, then activity.
    fn resolve(&self, now: Instant) -> Option<(AgentState, Option<BlockKind>)> {
        let explicit = match (self.hook, self.program) {
            (Some(hook), Some(program)) => Some(if hook.at >= program.at { hook } else { program }),
            (hook, program) => hook.or(program),
        };
        if let Some(explicit) = explicit {
            return Some((explicit.state, explicit.kind));
        }
        if let Some(state) = title_state(&self.title) {
            return Some((state, (state == AgentState::Blocked).then_some(BlockKind::Permission)));
        }
        self.agent.as_ref()?;
        Some((if self.writing(now) { AgentState::Working } else { AgentState::Idle }, None))
    }

    fn writing(&self, now: Instant) -> bool {
        self.last_work.is_some_and(|at| now.saturating_duration_since(at) < ACTIVE)
    }

    /// Read by activity, so only time can end its "writing" — the sweeper's to look at again.
    fn timed(&self, now: Instant) -> bool {
        self.hook.is_none() && self.program.is_none() && title_state(&self.title).is_none() && self.agent.is_some() && self.writing(now)
    }

    /// Output arrived. Echo of a keystroke is not work.
    fn output(&mut self, now: Instant) {
        if self.last_input.is_some_and(|at| now.saturating_duration_since(at) < ECHO) {
            return;
        }
        self.last_work = Some(now);
    }

    /// The snapshot, when it differs from the last one published.
    fn publish(&mut self, session: &str, now: Instant) -> Option<Snapshot> {
        if self.agent.is_none() {
            self.agent = agent_from_title(&self.title).map(str::to_string);
        }
        let resolved = self.resolve(now);
        if matches!(resolved, Some((AgentState::Working, _))) {
            self.worked = true;
        }
        let next = resolved.map(|(state, kind)| {
            let state = if state == AgentState::Idle && self.worked { AgentState::Done } else { state };
            let previous = self.published.as_ref();
            let changed = previous.and_then(|p| p.state) != Some(state);
            let stamp = now_ms();
            let since = if changed { stamp } else { previous.map(|p| p.since).unwrap_or(stamp) };
            let starts_turn = state == AgentState::Working && previous.and_then(|p| p.state) != Some(AgentState::Working);
            let turn = if starts_turn { stamp } else { previous.map(|p| p.turn).unwrap_or(0) };
            let summary = if !self.msg.is_empty() {
                self.msg.clone()
            } else if title_state(&self.title).is_some() {
                clip(&title_text(&self.title))
            } else {
                String::new()
            };
            Snapshot {
                session_id: session.to_string(),
                agent: self.agent.clone(),
                state: Some(state),
                kind,
                summary,
                prompt: self.prompt.clone(),
                reply: self.reply.clone(),
                cwd: self.cwd.clone(),
                since,
                turn,
            }
        });
        if next == self.published {
            return None;
        }
        let out = match &next {
            Some(snapshot) => snapshot.clone(),
            None => gone(session, &self.cwd),
        };
        self.published = next;
        Some(out)
    }
}

/// The snapshot that says "no agent here any more".
fn gone(session: &str, cwd: &str) -> Snapshot {
    Snapshot {
        session_id: session.to_string(),
        agent: None,
        state: None,
        kind: None,
        summary: String::new(),
        prompt: String::new(),
        reply: String::new(),
        cwd: cwd.to_string(),
        since: now_ms(),
        turn: 0,
    }
}

// ── The registry ──────────────────────────────────────────────────────────────────────────────

/// How a session's snapshots leave: `app.emit("terminal:agent", …)` in the app, a recorder in tests.
pub type Emit = Arc<dyn Fn(Snapshot) + Send + Sync>;

struct Watched {
    tracker: Tracker,
    emit: Emit,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Watched>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

fn lock() -> std::sync::MutexGuard<'static, Registry> {
    registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts following a session. Called by `terminal.rs` for desk terminals only.
pub fn watch(session: &str, cwd: &str, emit: Emit) {
    lock().sessions.insert(session.to_string(), Watched { tracker: Tracker::new(cwd), emit });
}

/// Runs `change` on a session's tracker and sends what it changed — outside the lock.
fn with(session: &str, change: impl FnOnce(&mut Tracker, Instant)) -> bool {
    let now = Instant::now();
    let sent = {
        let mut registry = lock();
        let Some(watched) = registry.sessions.get_mut(session) else { return false };
        change(&mut watched.tracker, now);
        let snapshot = watched.tracker.publish(session, now);
        if watched.tracker.timed(now) {
            wake();
        }
        snapshot.map(|snapshot| (Arc::clone(&watched.emit), snapshot))
    };
    if let Some((emit, snapshot)) = sent {
        emit(snapshot);
    }
    true
}

/// One chunk of a session's output, scanned. Answers whether it held the protocol's probe — the
/// caller then writes [`QUERY_REPLY`] into the pty.
pub fn observe(session: &str, events: &[OscEvent]) -> bool {
    let query = events.iter().any(|event| matches!(event, OscEvent::Query));
    with(session, |tracker, now| {
        tracker.output(now);
        for event in events {
            tracker.apply(event, now);
        }
    });
    query
}

/// The user typed into the session — so the next output is its echo.
pub fn input(session: &str) {
    if let Some(watched) = lock().sessions.get_mut(session) {
        watched.tracker.last_input = Some(Instant::now());
    }
}

/// A hook, from `cf hook`. Answers whether the session is one this app is following.
pub fn hook(session: &str, agent: &str, event: &str, prompt: &str, reply: &str, tool: &str) -> bool {
    with(session, |tracker, now| tracker.hooked(agent, event, prompt, reply, tool, now))
}

/// The window launched `agent` in this session — say so before the program has a chance to.
pub fn set_agent(session: &str, agent: &str) -> bool {
    with(session, |tracker, _| {
        if tracker.agent.as_deref() != Some(agent) {
            tracker.agent = Some(agent.to_string());
        }
    })
}

/// `cf progress <text>`: the agent's own words for where it is ("3/7 tests"), as the card's line.
/// A later report from the program itself (OSC 7501) replaces it, which is the newer word.
pub fn progress(session: &str, text: &str) -> bool {
    with(session, |tracker, now| {
        tracker.msg = clip(text);
        tracker.hook = Some(Explicit { state: AgentState::Working, kind: None, at: now });
    })
}

/// `cf done [text]`: the agent says its work is finished — the card goes to Done with its words.
pub fn done(session: &str, text: &str) -> bool {
    with(session, |tracker, now| {
        tracker.hook = Some(Explicit { state: AgentState::Done, kind: None, at: now });
        tracker.worked = true;
        if !text.trim().is_empty() {
            tracker.msg = clip(text);
            tracker.reply = clip(text);
        }
    })
}

/// The session ended: its card line goes.
pub fn forget(session: &str) {
    let gone_snapshot = {
        let mut registry = lock();
        let Some(watched) = registry.sessions.remove(session) else { return };
        watched.tracker.published.is_some().then(|| (watched.emit, gone(session, &watched.tracker.cwd)))
    };
    if let Some((emit, snapshot)) = gone_snapshot {
        emit(snapshot);
    }
}

/// Every session with an agent in it, for a window that just opened.
pub fn states() -> Vec<Snapshot> {
    lock().sessions.values().filter_map(|watched| watched.tracker.published.clone()).collect()
}

/// Wakes the sweeper. Called with the registry lock held, which is what makes a wake impossible to
/// lose: the sweeper only goes back to sleep while holding the same lock.
fn wake() {
    let (flag, ready) = sweeper();
    *flag.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
    ready.notify_one();
}

/// The flag the sweeper sleeps on, and its thread — started the first time anything is timed.
fn sweeper() -> &'static (Mutex<bool>, Condvar) {
    static SWEEPER: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();
    SWEEPER.get_or_init(|| {
        std::thread::spawn(sweep);
        (Mutex::new(false), Condvar::new())
    })
}

fn sweep() {
    loop {
        {
            let (flag, ready) = sweeper();
            let mut needed = flag.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            while !*needed {
                needed = ready.wait(needed).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        std::thread::sleep(SWEEP);
        let now = Instant::now();
        let sent: Vec<(Emit, Snapshot)> = {
            let mut registry = lock();
            let mut sent = Vec::new();
            let mut any = false;
            for (session, watched) in registry.sessions.iter_mut() {
                if let Some(snapshot) = watched.tracker.publish(session, now) {
                    sent.push((Arc::clone(&watched.emit), snapshot));
                }
                any |= watched.tracker.timed(now);
            }
            if !any {
                *sweeper().0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = false;
            }
            sent
        };
        for (emit, snapshot) in sent {
            emit(snapshot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    #[test]
    fn a_report_carries_its_state_kind_and_message() {
        let body = format!("state=blocked:kind=question:app=claude-code:msg={}", b64("¿Borro la columna?"));
        let Some(OscEvent::Status(report)) = parse_status(&body) else { panic!("not a report") };
        assert_eq!(report.state, Some(AgentState::Blocked));
        assert_eq!(report.kind, Some(BlockKind::Question));
        assert_eq!(report.app.as_deref(), Some("claude-code"));
        assert_eq!(report.msg.as_deref(), Some("¿Borro la columna?"));
        assert_eq!(report.id, None);
    }

    #[test]
    fn the_protocol_rules_decide_what_is_dropped() {
        // No state: nothing to apply.
        assert_eq!(parse_status("kind=question"), None);
        // An unknown state voids the report.
        assert_eq!(parse_status("state=sleeping"), None);
        // A kind only means something on `blocked`.
        let Some(OscEvent::Status(report)) = parse_status("state=working:kind=question") else { panic!() };
        assert_eq!(report.kind, None);
        // A malformed id must not overwrite the program's own record.
        assert_eq!(parse_status("state=done:id=a b"), None);
        // A message that is not base64 of clean text voids it; a pair with characters the grammar
        // does not allow is skipped, and so is an unknown key.
        assert_eq!(parse_status("state=done:msg=a"), None);
        assert_eq!(parse_status(&format!("state=done:msg={}", b64("a\u{7}b"))), None);
        assert!(parse_status("state=done:msg=@@@").is_some());
        assert!(parse_status("state=done:future=1").is_some());
        // Clear has no state of its own.
        let Some(OscEvent::Status(report)) = parse_status("state=clear") else { panic!() };
        assert_eq!(report.state, None);
        assert_eq!(parse_status(" ? "), Some(OscEvent::Query));
    }

    #[test]
    fn frames_are_found_with_either_terminator_and_across_chunks() {
        let mut scanner = OscScanner::default();
        let stream = format!(
            "plain\x1b]0;✳ Fix login\x07more\x1b]7501;?\x1b\\\x1b[c\x1b]7501;state=working\x1b\\\x1b]133;A\x07"
        );
        let bytes = stream.as_bytes();
        // Cut the stream at every byte: the events must come out the same.
        for cut in 0..bytes.len() {
            let mut scanner_cut = OscScanner::default();
            let mut events = scanner_cut.feed(&bytes[..cut]);
            events.extend(scanner_cut.feed(&bytes[cut..]));
            assert_eq!(events.len(), 4, "cut at {cut}: {events:?}");
        }
        let events = scanner.feed(bytes);
        assert_eq!(events[0], OscEvent::Title("✳ Fix login".into()));
        assert_eq!(events[1], OscEvent::Query);
        assert!(matches!(&events[2], OscEvent::Status(report) if report.state == Some(AgentState::Working)));
        assert_eq!(events[3], OscEvent::PromptStart);
    }

    #[test]
    fn output_without_frames_costs_nothing_and_runaway_frames_are_dropped() {
        let mut scanner = OscScanner::default();
        assert!(scanner.feed(b"no escapes here").is_empty());
        assert!(scanner.pending.is_empty());
        // A colour code is an ESC but not an OSC.
        assert!(scanner.feed(b"\x1b[31mred\x1b[0m").is_empty());
        // An unterminated frame past the cap is not carried forever.
        let mut long = b"\x1b]0;".to_vec();
        long.extend(std::iter::repeat_n(b'x', MAX_FRAME + 10));
        assert!(scanner.feed(&long).is_empty());
        assert!(scanner.pending.len() <= MAX_FRAME);
        // …and the scanner still works afterwards.
        assert_eq!(scanner.feed(b"\x07\x1b]2;next\x07"), vec![OscEvent::Title("next".into())]);
    }

    #[test]
    fn a_reset_and_other_marks_are_told_apart() {
        let mut scanner = OscScanner::default();
        assert_eq!(scanner.feed(b"\x1bc"), vec![OscEvent::Reset]);
        // `133;B` (command start) is not a new prompt.
        assert!(scanner.feed(b"\x1b]133;B\x07").is_empty());
        assert_eq!(scanner.feed(b"\x1b]633;A;cl=m\x07"), vec![OscEvent::PromptStart]);
        // CAN aborts a frame.
        assert!(scanner.feed(b"\x1b]0;half\x18").is_empty());
    }

    #[test]
    fn titles_say_working_or_resting_only_with_a_glyph() {
        assert_eq!(title_state("⠐ Refactor auth"), Some(AgentState::Working));
        assert_eq!(title_state("✳ Refactor auth"), Some(AgentState::Idle));
        assert_eq!(title_state("user@host: ~/code"), None);
        assert_eq!(title_state(""), None);
        assert_eq!(title_text("⠐ Refactor auth"), "Refactor auth");
        assert_eq!(title_text("✳ Refactor auth"), "Refactor auth");
        assert_eq!(title_text("vim notes.md"), "vim notes.md");
    }

    fn state_of(tracker: &mut Tracker, now: Instant) -> Option<AgentState> {
        tracker.publish("s", now);
        tracker.published.as_ref().and_then(|snapshot| snapshot.state)
    }

    #[test]
    fn the_command_line_names_the_agent_and_wrappers_do_not_hide_it() {
        assert_eq!(agent_from_command("claude --resume abc"), Some("claude"));
        assert_eq!(agent_from_command("FOO=1 nohup /usr/local/bin/agy"), Some("gemini"));
        assert_eq!(agent_from_command("& 'C:\\Program Files\\Codex\\codex.exe' \"fix it\""), Some("codex"));
        assert_eq!(agent_from_command("'/Users/me/Application Support/bin/grok'"), Some("grok"));
        assert_eq!(agent_from_command("ls -la"), None);
        assert_eq!(agent_from_command(""), None);
    }

    #[test]
    fn an_agent_read_by_activity_writes_then_finishes() {
        let start = Instant::now();
        let mut tracker = Tracker::new("/repo");
        tracker.apply(&OscEvent::Command("cline".into()), start);
        // At rest before anything was asked: idle, not finished.
        assert_eq!(state_of(&mut tracker, start), Some(AgentState::Idle));
        tracker.output(start);
        assert_eq!(state_of(&mut tracker, start), Some(AgentState::Working));
        assert!(tracker.timed(start));
        let later = start + ACTIVE + Duration::from_millis(1);
        assert_eq!(state_of(&mut tracker, later), Some(AgentState::Done));
        assert!(!tracker.timed(later));
        // The echo of a keystroke is not work.
        tracker.last_input = Some(later);
        tracker.output(later + Duration::from_millis(50));
        assert_eq!(state_of(&mut tracker, later + Duration::from_millis(60)), Some(AgentState::Done));
        // The shell's prompt is back: the agent is gone.
        tracker.apply(&OscEvent::PromptStart, later);
        tracker.publish("s", later);
        assert_eq!(tracker.published, None);
    }

    #[test]
    fn hooks_carry_the_prompt_and_the_reply_and_the_newest_word_wins() {
        let start = Instant::now();
        let mut tracker = Tracker::new("/repo");
        tracker.hooked("claude", "UserPromptSubmit", "arregla   el\nlogin", "", "", start);
        assert_eq!(state_of(&mut tracker, start), Some(AgentState::Working));
        assert_eq!(tracker.prompt, "arregla el login");
        tracker.hooked("claude", "PermissionRequest", "", "", "Bash", start + Duration::from_millis(1));
        tracker.publish("s", start + Duration::from_millis(1));
        let snapshot = tracker.published.clone().unwrap();
        assert_eq!((snapshot.state, snapshot.kind), (Some(AgentState::Blocked), Some(BlockKind::Permission)));
        // The user approved: no hook says so, the program's own report does.
        let report = Report { id: None, state: Some(AgentState::Working), kind: None, app: None, title: None, msg: None };
        tracker.apply(&OscEvent::Status(report), start + Duration::from_millis(2));
        assert_eq!(state_of(&mut tracker, start + Duration::from_millis(2)), Some(AgentState::Working));
        tracker.hooked("claude", "Stop", "", "Listo: el login\nya funciona.", "", start + Duration::from_millis(3));
        tracker.publish("s", start + Duration::from_millis(3));
        let snapshot = tracker.published.clone().unwrap();
        assert_eq!(snapshot.state, Some(AgentState::Done));
        assert_eq!(snapshot.reply, "Listo: el login ya funciona.");
        assert_eq!(snapshot.prompt, "arregla el login");
        // The agent's own question is waiting on the user too.
        tracker.hooked("claude", "PreToolUse", "", "", "AskUserQuestion", start + Duration::from_millis(4));
        tracker.publish("s", start + Duration::from_millis(4));
        assert_eq!(tracker.published.as_ref().unwrap().kind, Some(BlockKind::Question));
    }

    #[test]
    fn a_title_glyph_names_the_agent_and_its_state_until_the_program_reports() {
        let start = Instant::now();
        let mut tracker = Tracker::new("/repo");
        tracker.apply(&OscEvent::Title("◐ Fix login".into()), start);
        assert_eq!(state_of(&mut tracker, start), Some(AgentState::Working));
        assert_eq!(tracker.published.as_ref().unwrap().agent.as_deref(), Some("claude"));
        assert_eq!(tracker.published.as_ref().unwrap().summary, "Fix login");
        tracker.apply(&OscEvent::Title("✳ Fix login".into()), start);
        // At rest after working is finished.
        assert_eq!(state_of(&mut tracker, start), Some(AgentState::Done));
    }

    #[test]
    fn the_registry_answers_the_probe_and_says_when_an_agent_leaves() {
        let sent: Arc<Mutex<Vec<Snapshot>>> = Arc::default();
        let record = Arc::clone(&sent);
        let session = "registry-test-session";
        watch(session, "/repo", Arc::new(move |snapshot| record.lock().unwrap().push(snapshot)));
        let mut scanner = OscScanner::default();
        let events = scanner.feed(b"\x1b]633;E;Y2xhdWRl\x07\x1b]7501;?\x1b\\");
        assert!(observe(session, &events));
        let report = scanner.feed(format!("\x1b]7501;state=working:app=claude-code:msg={}\x1b\\", b64("Leyendo src/")).as_bytes());
        assert!(!observe(session, &report));
        {
            let sent = sent.lock().unwrap();
            let last = sent.last().unwrap();
            assert_eq!(last.agent.as_deref(), Some("claude"));
            assert_eq!(last.state, Some(AgentState::Working));
            assert_eq!(last.summary, "Leyendo src/");
        }
        assert!(states().iter().any(|snapshot| snapshot.session_id == session));
        forget(session);
        let last = sent.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.agent, last.state), (None, None));
        assert!(!hook(session, "claude", "Stop", "", "", ""));
    }

    #[test]
    fn a_cwd_mark_moves_the_session() {
        let mut scanner = OscScanner::default();
        assert_eq!(
            scanner.feed(b"\x1b]7;file://host/Users/me/My%20Repo\x07"),
            vec![OscEvent::Cwd("/Users/me/My Repo".into())]
        );
        assert_eq!(parse_cwd("file:///C:/work/repo").as_deref(), Some("C:/work/repo"));
    }
}
