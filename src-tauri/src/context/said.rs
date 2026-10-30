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
//!
//! One thing can empty a session of its blocks without changing its id: the CLI's own
//! auto-compaction, which summarises the history in place. It cannot be seen directly, but the
//! context it leaves behind can: a turn whose prompt is far smaller than the previous turn's
//! ([`COMPACTION_DROP`]) means the history was cut, and the record of that session is forgotten so
//! the next turn says everything again (see [`Blocks::settle_with`]).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{LazyLock, Mutex};

/// Per conversation+session: the hash of the last text of each kind of block it was sent.
static SAID: LazyLock<Mutex<HashMap<String, HashMap<&'static str, u64>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Per conversation+session: the prompt size (tokens) the engine reported on its last turn.
static LAST_CONTEXT: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A turn whose context is below this fraction of the previous turn's is read as the CLI having
/// compacted the session. A conversation's context only grows between turns; 60 % is far outside
/// the noise of cache accounting and well inside what an auto-compaction (which keeps a summary of
/// a few thousand tokens) leaves.
const COMPACTION_DROP: f64 = 0.6;

/// Below this the previous context is too small for a drop to mean anything: a first turn that was
/// big because of a pasted file, then an ordinary one, is not a compaction.
const COMPACTION_MIN_BEFORE: i64 = 20_000;

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
    #[cfg(test)]
    pub fn settle(self, session: Option<&str>) {
        self.settle_with(session, None)
    }

    /// [`Blocks::settle`] with the prompt size the engine reported for the turn. A sharp fall from
    /// the previous turn's size (see [`COMPACTION_DROP`]) means the CLI compacted the session in
    /// place: nothing is believed held any more, this turn's blocks included (the compaction may
    /// have summarised them), and the next turn says everything again. One turn late by nature —
    /// this turn already left out what it believed held — which is why it is a cheap record reset
    /// and not a retry.
    pub fn settle_with(self, session: Option<&str>, context_tokens: Option<i64>) {
        let Some(session) = session.filter(|s| !s.trim().is_empty()) else { return };
        if let Some(now) = context_tokens.filter(|tokens| *tokens > 0) {
            let key = key(&self.conversation, session);
            let compacted = LAST_CONTEXT.lock().ok().is_some_and(|mut last| {
                if last.len() >= KEEP {
                    last.clear();
                }
                last.insert(key.clone(), now).is_some_and(|before| before >= COMPACTION_MIN_BEFORE && (now as f64) < before as f64 * COMPACTION_DROP)
            });
            if compacted {
                if let Ok(mut said) = SAID.lock() {
                    said.remove(&key);
                }
                return;
            }
        }
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
    fn a_sharp_fall_in_context_means_the_cli_compacted_and_everything_is_said_again() {
        let mut first = Blocks::new("said-test-4", None);
        first.say("rules", "R");
        first.settle_with(Some("s1"), Some(80_000));

        let mut second = Blocks::new("said-test-4", Some("s1"));
        assert_eq!(second.say("rules", "R"), "", "context grew: the session still holds it");
        second.settle_with(Some("s1"), Some(90_000));

        // The CLI summarised the history in place: same session id, a fraction of the context.
        let mut compacted = Blocks::new("said-test-4", Some("s1"));
        assert_eq!(compacted.say("rules", "R"), "");
        compacted.settle_with(Some("s1"), Some(12_000));

        let mut after = Blocks::new("said-test-4", Some("s1"));
        assert_eq!(after.say("rules", "R"), "R", "forgotten, so told again");
        after.settle_with(Some("s1"), Some(14_000));
        let mut next = Blocks::new("said-test-4", Some("s1"));
        assert_eq!(next.say("rules", "R"), "");
    }

    #[test]
    fn a_small_or_unmeasured_context_never_resets() {
        let mut first = Blocks::new("said-test-5", None);
        first.say("rules", "R");
        first.settle_with(Some("s1"), Some(8_000));
        let mut second = Blocks::new("said-test-5", Some("s1"));
        assert_eq!(second.say("rules", "R"), "");
        second.settle_with(Some("s1"), Some(1_000));
        let mut third = Blocks::new("said-test-5", Some("s1"));
        assert_eq!(third.say("rules", "R"), "", "8k to 1k is below the floor");
        third.settle_with(Some("s1"), None);
        let mut fourth = Blocks::new("said-test-5", Some("s1"));
        assert_eq!(fourth.say("rules", "R"), "", "no figure, no conclusion");
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
