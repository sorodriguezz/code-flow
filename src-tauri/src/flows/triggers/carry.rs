//! What a poller had learnt when it was stopped, for the one that replaces it.
//!
//! Saving a flow re-arms it, so every autosave of the canvas replaces its pollers. A replacement whose first look
//! only learns would miss whatever happened between the old poller's last look and its own first one — a push, a
//! merged pull request, a new issue — on every save. The old one leaves what it knew here, under a key that names
//! everything it was looking at (another repository, event or branch learns afresh), and the new one takes it.

use std::any::Any;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long a stopped poller's memory stays good: a re-arm is immediate; a flow switched off and on again
/// tomorrow starts afresh, as it always did.
const GOOD_FOR: Duration = Duration::from_secs(10 * 60);

static STASH: LazyLock<Mutex<HashMap<String, (Instant, Box<dyn Any + Send>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn stash<T: Any + Send>(key: String, value: T) {
    if let Ok(mut all) = STASH.lock() {
        all.retain(|_, (at, _)| at.elapsed() < GOOD_FOR);
        all.insert(key, (Instant::now(), Box::new(value)));
    }
}

pub(super) fn take<T: Any + Send>(key: &str) -> Option<T> {
    let (at, value) = STASH.lock().ok()?.remove(key)?;
    if at.elapsed() >= GOOD_FOR {
        return None;
    }
    value.downcast::<T>().ok().map(|boxed| *boxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replacement_takes_what_its_predecessor_learnt_once() {
        stash("flow\u{1f}node".to_string(), vec![1, 2, 3]);
        assert_eq!(take::<Vec<i32>>("flow\u{1f}node"), Some(vec![1, 2, 3]));
        assert_eq!(take::<Vec<i32>>("flow\u{1f}node"), None, "taken, not copied");
        stash("a".to_string(), 7u8);
        assert_eq!(take::<String>("a"), None, "another kind of memory is no match");
        assert_eq!(take::<u8>("b"), None);
    }
}
