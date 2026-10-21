//! What a resumed engine session has already been told, so a turn does not tell it again.
//!
//! Both chats append blocks to the question that are not the question: the answer-length and
//! question rules, the workspace's repositories and branches, the approved memories, the editor's
//! state. They have to ride the *message* — a resumed session is never sent a system prompt again
//! (`ai::chat_turn`) — and so every turn used to carry all of them, and every copy stayed in the
//! session's history: on a long conversation the same rules and the same unchanged memories were
//! paid for once per turn, each time as fresh input and then for ever as cached context.
//!
//! So a block is sent when the session does not hold it yet, or holds a different version, and is
//! left out when the session already has this exact text from an earlier turn. "Already has" is
//! only ever believed of the session that was resumed and answered as itself: a new session (the
//! first turn, a compaction, a `/clear`, an engine or account switch, a resume the CLI quietly
//! turned into a fresh one) is told everything again. The record lives in memory, so a restart of
//! the app costs one turn of repetition and can never cost a missing block. An engine that does
//! not resume sessions (Cline, the in-process one) replays the conversation from the stored
//! questions, which never contained these blocks, so it is told them on every turn.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{LazyLock, Mutex};

/// Per conversation+session: the hash of the last text of each kind of block it was sent.
static SAID: LazyLock<Mutex<HashMap<String, HashMap<&'static str, u64>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Sessions remembered at most; past it the record starts over, which only means repeating once.
const KEEP: usize = 512;

fn key(conversation: &str, session: &str) -> String {
    format!("{conversation}\u{1}{session}")
}

fn digest(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// One turn's blocks: decided as they are appended, remembered once the turn has answered.
pub struct Blocks {
    conversation: String,
    /// The session being resumed, when the engine resumes sessions at all.
    resumed: Option<String>,
    sent: Vec<(&'static str, u64)>,
    held: Vec<(&'static str, u64)>,
}

impl Blocks {
    /// `resumed`: the engine session this turn resumes — `None` for a new one, or for an engine
    /// that does not keep sessions (then every block is always sent).
    pub fn new(conversation: &str, resumed: Option<&str>) -> Self {
        Blocks { conversation: conversation.to_string(), resumed: resumed.map(str::to_string), sent: Vec::new(), held: Vec::new() }
    }

    /// `text`, or nothing when the resumed session already holds this exact `kind` of block.
    pub fn say<'t>(&mut self, kind: &'static str, text: &'t str) -> &'t str {
        if text.trim().is_empty() {
            return text;
        }
        let hash = digest(text);
        let known = self.resumed.as_deref().is_some_and(|session| {
            SAID.lock().ok().and_then(|said| said.get(&key(&self.conversation, session)).and_then(|kinds| kinds.get(kind)).copied()) == Some(hash)
        });
        if known {
            self.held.push((kind, hash));
            ""
        } else {
            self.sent.push((kind, hash));
            text
        }
    }

    /// The turn answered in `session`. What it now holds is what was sent — plus what was left out
    /// as already held, but only when it really was the resumed session that answered.
    pub fn settle(self, session: Option<&str>) {
        let Some(session) = session.filter(|s| !s.trim().is_empty()) else { return };
        let Ok(mut said) = SAID.lock() else { return };
        if said.len() >= KEEP {
            said.clear();
        }
        let same = self.resumed.as_deref() == Some(session);
        let entry = said.entry(key(&self.conversation, session)).or_default();
        if !same {
            entry.clear();
        }
        let held = if same { self.held } else { Vec::new() };
        for (kind, hash) in self.sent.into_iter().chain(held) {
            entry.insert(kind, hash);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Blocks;

    #[test]
    fn a_block_the_session_already_holds_is_not_said_again() {
        let mut first = Blocks::new("said-test-1", None);
        assert_eq!(first.say("rules", "R"), "R");
        first.settle(Some("s1"));

        let mut second = Blocks::new("said-test-1", Some("s1"));
        assert_eq!(second.say("rules", "R"), "", "same text, same session");
        assert_eq!(second.say("memories", "M"), "M", "never said before");
        second.settle(Some("s1"));

        let mut third = Blocks::new("said-test-1", Some("s1"));
        assert_eq!(third.say("rules", "R2"), "R2", "a changed block is said again");
        assert_eq!(third.say("memories", "M"), "");
    }

    #[test]
    fn a_new_session_is_told_everything_again() {
        let mut first = Blocks::new("said-test-2", None);
        first.say("rules", "R");
        first.settle(Some("s1"));

        let mut fresh = Blocks::new("said-test-2", Some("s2"));
        assert_eq!(fresh.say("rules", "R"), "R", "s2 was never told");

        // A resume the CLI answered as a different session: what was left out is not believed held.
        let mut resumed = Blocks::new("said-test-2", Some("s1"));
        assert_eq!(resumed.say("rules", "R"), "");
        resumed.settle(Some("s3"));
        let mut after = Blocks::new("said-test-2", Some("s3"));
        assert_eq!(after.say("rules", "R"), "R");
    }

    #[test]
    fn an_engine_without_sessions_is_always_told() {
        let mut turn = Blocks::new("said-test-3", None);
        assert_eq!(turn.say("rules", "R"), "R");
        turn.settle(None);
        let mut next = Blocks::new("said-test-3", None);
        assert_eq!(next.say("rules", "R"), "R");
    }
}
