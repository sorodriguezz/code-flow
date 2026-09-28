//! One held connection per host, for the file transports that keep one open — and what to do when
//! it has quietly died.
//!
//! **Why this exists.** SFTP holds an `ssh` child, FTP a logged-in control socket, SMB a negotiated
//! session, each cached per host so browsing is a round trip rather than a handshake per click. The
//! three caches used to hand back whatever they held without asking whether it still worked, and to
//! keep it after it had failed. So a laptop that slept, or an FTP server's idle timeout, left the
//! browser failing on every click — "Retry" included, since it asked the same cache for the same
//! dead session — until the user found Disconnect.
//!
//! The rules, in the order they apply:
//!
//! 1. **A held session is checked before it is used**, with whatever that transport can answer
//!    without the network or with one cheap round trip: the `ssh` child having exited, a `NOOP` after
//!    a long idle, the SMB client's own disconnected flag. A dead one is dropped and a new one
//!    opened, and the operation never sees it.
//! 2. **An operation that fails because the connection went away drops the session**, whatever the
//!    operation was — see [`Outcome::Lost`]. The next one therefore connects afresh, which is what
//!    makes Retry mean something.
//! 3. **A read on a session that turns out to be dead is run once more**, transparently, on a new
//!    one. Only a read, and only when the session was a held one: a listing is safe to repeat, while
//!    a rename or a delete that failed half way may already have happened, and repeating it would
//!    turn a success into a confusing "no such file". And a session opened for this very call that
//!    fails at once is a failure to report, not a stale connection to recover from.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use tokio::sync::Mutex;

/// How an operation on a held session ended, from the *session's* point of view.
#[derive(Debug)]
pub(super) enum Outcome<T> {
    Done(T),
    /// It failed, and the session is fine: no such file, permission denied, a full disk. The
    /// connection stays held, because the next click has every reason to work.
    Failed(String),
    /// It failed because the connection under it is gone — the socket closed, the `ssh` died, the
    /// server hung up. The session is dropped, and a read is tried once more on a new one.
    Lost(String),
}

impl<T> Outcome<T> {
    /// The usual way to build one: the result of a call, the transport's own test for "the
    /// connection is gone", and the sentence that names what was being attempted.
    pub(super) fn of<E>(result: Result<T, E>, lost: impl Fn(&E) -> bool, explain: impl Fn(E) -> String) -> Self {
        match result {
            Ok(value) => Self::Done(value),
            Err(error) if lost(&error) => Self::Lost(explain(error)),
            Err(error) => Self::Failed(explain(error)),
        }
    }
}

/// Short-circuits an [`Outcome`] the way `?` short-circuits a `Result`, inside a function that
/// itself returns one.
macro_rules! step {
    ($outcome:expr) => {
        match $outcome {
            $crate::remotes::pool::Outcome::Done(value) => value,
            $crate::remotes::pool::Outcome::Failed(error) => {
                return $crate::remotes::pool::Outcome::Failed(error)
            }
            $crate::remotes::pool::Outcome::Lost(error) => {
                return $crate::remotes::pool::Outcome::Lost(error)
            }
        }
    };
}
pub(super) use step;

/// Turns a local failure — a file on *this* machine that could not be read or written — into an
/// [`Outcome`]. Never `Lost`: nothing about the far side is in question.
pub(super) fn local<T>(result: Result<T, String>) -> Outcome<T> {
    match result {
        Ok(value) => Outcome::Done(value),
        Err(error) => Outcome::Failed(error),
    }
}

/// Whether [`Pool::run`] may repeat an operation on a fresh session after the held one was found
/// dead. See rule 3 in the module header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Retry {
    /// A read: listing, planning a download. Safe to run twice.
    Once,
    /// Anything that writes. Reported, and the session dropped, but never repeated.
    Never,
}

/// The held sessions of one transport, by host id.
pub(super) struct Pool<S> {
    sessions: Mutex<HashMap<String, Arc<S>>>,
}

impl<S> Default for Pool<S> {
    fn default() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

impl<S> Pool<S> {
    /// Runs `op` on this host's session.
    ///
    /// `open` makes a new session; `alive` is the transport's cheap check on a held one (rule 1);
    /// `retry` decides rule 3.
    pub(super) async fn run<T, O, OF, A, AF, F, FF>(
        &self,
        host_id: &str,
        open: O,
        alive: A,
        retry: Retry,
        op: F,
    ) -> Result<T, String>
    where
        O: Fn() -> OF,
        OF: Future<Output = Result<S, String>>,
        A: Fn(Arc<S>) -> AF,
        AF: Future<Output = bool>,
        F: Fn(Arc<S>) -> FF,
        FF: Future<Output = Outcome<T>>,
    {
        let (session, fresh) = self.acquire(host_id, &open, &alive).await?;
        let error = match op(session.clone()).await {
            Outcome::Done(value) => return Ok(value),
            Outcome::Failed(error) => return Err(error),
            Outcome::Lost(error) => error,
        };
        self.evict(host_id, &session).await;
        if fresh || retry == Retry::Never {
            return Err(error);
        }
        let (session, _) = self.acquire(host_id, &open, &alive).await?;
        match op(session.clone()).await {
            Outcome::Done(value) => Ok(value),
            Outcome::Failed(error) => Err(error),
            Outcome::Lost(error) => {
                self.evict(host_id, &session).await;
                Err(error)
            }
        }
    }

    /// The held session if it is still alive, a new one otherwise — and which of the two it was.
    async fn acquire<O, OF, A, AF>(&self, host_id: &str, open: &O, alive: &A) -> Result<(Arc<S>, bool), String>
    where
        O: Fn() -> OF,
        OF: Future<Output = Result<S, String>>,
        A: Fn(Arc<S>) -> AF,
        AF: Future<Output = bool>,
    {
        let held = self.sessions.lock().await.get(host_id).cloned();
        if let Some(session) = held {
            if alive(session.clone()).await {
                return Ok((session, false));
            }
            self.evict(host_id, &session).await;
        }
        let opened = Arc::new(open().await?);
        self.sessions.lock().await.insert(host_id.to_string(), opened.clone());
        Ok((opened, true))
    }

    /// Drops `session` — only if it is still the one held. Another call may already have replaced
    /// it with a live one, and evicting *that* would throw away a working connection.
    pub(super) async fn evict(&self, host_id: &str, session: &Arc<S>) {
        let mut sessions = self.sessions.lock().await;
        if sessions.get(host_id).is_some_and(|held| Arc::ptr_eq(held, session)) {
            sessions.remove(host_id);
        }
    }

    /// Closes a host's session. Idempotent — what disconnecting, deleting and editing all call.
    pub(super) async fn close(&self, host_id: &str) {
        self.sessions.lock().await.remove(host_id);
    }

    /// Every host holding a session, for [`super::hold`] to report.
    pub(super) async fn hosts(&self) -> Vec<String> {
        self.sessions.lock().await.keys().cloned().collect()
    }

    /// Drops every session — the exit path's. See [`super::forward::close_all`] for why a `static`
    /// map needs an explicit drain at all.
    pub(super) async fn close_all(&self) {
        self.sessions.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// A session that knows which connection it is and can be told it has died.
    struct Fake {
        serial: usize,
        dead: AtomicBool,
    }

    struct Harness {
        pool: Pool<Fake>,
        opened: AtomicUsize,
    }

    impl Harness {
        fn new() -> Self {
            Self { pool: Pool::default(), opened: AtomicUsize::new(0) }
        }

        async fn run(&self, retry: Retry, op: impl Fn(Arc<Fake>) -> Outcome<usize>) -> Result<usize, String> {
            self.pool
                .run(
                    "h",
                    || async move {
                        let serial = self.opened.fetch_add(1, Ordering::SeqCst) + 1;
                        Ok(Fake { serial, dead: AtomicBool::new(false) })
                    },
                    |session: Arc<Fake>| async move { !session.dead.load(Ordering::SeqCst) },
                    retry,
                    |session| std::future::ready(op(session)),
                )
                .await
        }
    }

    #[tokio::test]
    async fn a_live_session_is_reused() {
        let h = Harness::new();
        assert_eq!(h.run(Retry::Once, |s| Outcome::Done(s.serial)).await, Ok(1));
        assert_eq!(h.run(Retry::Once, |s| Outcome::Done(s.serial)).await, Ok(1));
        assert_eq!(h.opened.load(Ordering::SeqCst), 1);
    }

    /// Rule 1: what the laptop's sleep leaves behind is found before anything is sent on it.
    #[tokio::test]
    async fn a_held_session_that_died_is_replaced_before_use() {
        let h = Harness::new();
        h.run(Retry::Never, |s| Outcome::Done(s.serial)).await.unwrap();
        h.pool.sessions.lock().await.get("h").unwrap().dead.store(true, Ordering::SeqCst);
        // `Never` — even a write gets a live session when the death was visible up front.
        assert_eq!(h.run(Retry::Never, |s| Outcome::Done(s.serial)).await, Ok(2));
    }

    /// Rules 2 and 3: a read on a connection that turns out to be gone is repeated once on a new
    /// one, and the dead one is not what the next call gets.
    #[tokio::test]
    async fn a_read_on_a_lost_connection_is_retried_once_on_a_new_one() {
        let h = Harness::new();
        h.run(Retry::Once, |s| Outcome::Done(s.serial)).await.unwrap();
        let answer = h
            .run(Retry::Once, |s| if s.serial == 1 { Outcome::Lost("gone".into()) } else { Outcome::Done(s.serial) })
            .await;
        assert_eq!(answer, Ok(2));
        assert_eq!(h.run(Retry::Once, |s| Outcome::Done(s.serial)).await, Ok(2));
    }

    /// A write is never repeated — but the dead session still goes, so the next click works.
    #[tokio::test]
    async fn a_write_on_a_lost_connection_is_reported_and_the_session_dropped() {
        let h = Harness::new();
        h.run(Retry::Never, |s| Outcome::Done(s.serial)).await.unwrap();
        let calls = AtomicUsize::new(0);
        let answer = h
            .run(Retry::Never, |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                Outcome::Lost("broken pipe".into())
            })
            .await;
        assert_eq!(answer, Err("broken pipe".into()));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "a write must not run twice");
        assert!(h.pool.hosts().await.is_empty(), "the dead session is gone");
        assert_eq!(h.run(Retry::Never, |s| Outcome::Done(s.serial)).await, Ok(2));
    }

    /// A session opened for this very call that fails at once is a real failure — wrong password,
    /// host down — and retrying it would only double the wait for the same message.
    #[tokio::test]
    async fn a_fresh_session_that_fails_is_not_retried() {
        let h = Harness::new();
        let calls = AtomicUsize::new(0);
        let answer = h
            .run(Retry::Once, |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                Outcome::Lost("refused".into())
            })
            .await;
        assert_eq!(answer, Err("refused".into()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// An ordinary failure keeps the connection: a missing file says nothing about the socket.
    #[tokio::test]
    async fn a_failure_that_is_not_the_connection_keeps_the_session() {
        let h = Harness::new();
        let answer = h.run(Retry::Once, |_| Outcome::Failed("no such file".into())).await;
        assert_eq!(answer, Err("no such file".into()));
        assert_eq!(h.pool.hosts().await, vec!["h".to_string()]);
        assert_eq!(h.run(Retry::Once, |s| Outcome::Done(s.serial)).await, Ok(1));
    }

    #[tokio::test]
    async fn evicting_a_session_that_was_already_replaced_keeps_the_new_one() {
        let h = Harness::new();
        h.run(Retry::Once, |s| Outcome::Done(s.serial)).await.unwrap();
        let stale = h.pool.sessions.lock().await.get("h").cloned().unwrap();
        h.pool.close("h").await;
        h.run(Retry::Once, |s| Outcome::Done(s.serial)).await.unwrap();
        h.pool.evict("h", &stale).await;
        assert_eq!(h.run(Retry::Once, |s| Outcome::Done(s.serial)).await, Ok(2));
    }

    #[test]
    fn an_outcome_sorts_a_result_by_the_transports_own_test() {
        let lost = |e: &&str| e.starts_with("io");
        assert!(matches!(Outcome::of(Ok::<_, &str>(1), lost, str::to_string), Outcome::Done(1)));
        assert!(matches!(Outcome::of(Err::<u8, _>("io: reset"), lost, str::to_string), Outcome::Lost(_)));
        assert!(matches!(Outcome::of(Err::<u8, _>("no such file"), lost, str::to_string), Outcome::Failed(_)));
    }
}
