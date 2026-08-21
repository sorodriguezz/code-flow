//! The unlocked vault: where the data key lives, and what takes it away again.
//!
//! **The key exists in exactly one place — here.** It is never returned from a command, never
//! serialised, and never crosses the IPC bridge. Every read and write goes through
//! [`VaultSession::with_key`], which hands the key to a closure and gets a result back. That is the
//! whole reason this is Tauri managed state rather than a value the commands pass around: a key
//! that can be moved is a key that can be moved somewhere it shouldn't be.
//!
//! **Why not [`crate::secrets`]'s session cache.** That cache never expires and has no public way
//! to forget a value, which is right for a token the app needs all day and exactly wrong for a
//! vault key — "lock the keyring" would be unable to evict anything.
//!
//! **Auto-lock is checked on use, not only on a tick.** A laptop asleep for two hours runs no
//! timers; if locking depended on the ticker alone, waking up would find the vault still open. So
//! `with_key` compares the idle window itself and locks on the way out. The ticker
//! ([`spawn_autolock`]) exists on top of that to make the *UI* lock while the user is looking at
//! it, rather than at their next click.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use zeroize::Zeroize as _;

use super::crypto::{VaultError, KEY_LEN};

/// How often the ticker looks. Matches `backup::auto`'s cadence closely enough; the exact number
/// only decides how promptly a *visible* lock happens, never whether one happens.
const TICK: Duration = Duration::from_secs(30);

/// Emitted when the vault locks itself, so the UI can drop what it is showing rather than poll.
pub const LOCKED_EVENT: &str = "keyvault:locked";

struct Unlocked {
    dek: [u8; KEY_LEN],
    last_touch: Instant,
    /// `None` means "never lock on idle", which is what a zero-minute setting means.
    idle_limit: Option<Duration>,
}

impl Drop for Unlocked {
    /// Belt and braces: [`VaultSession::lock`] wipes the key explicitly, and this catches every
    /// other way the value could go away — a replacement on re-unlock, or the state being dropped
    /// at shutdown.
    fn drop(&mut self) {
        self.dek.zeroize();
    }
}

#[derive(Default)]
pub struct VaultSession {
    inner: Mutex<Option<Unlocked>>,
}

impl VaultSession {
    /// A panic elsewhere while this lock is held would poison it. Recovering rather than
    /// propagating matches `secrets.rs`'s reasoning: the alternative is a vault that cannot be
    /// locked or unlocked for the rest of the process, which is worse than either.
    fn locked(&self) -> std::sync::MutexGuard<'_, Option<Unlocked>> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn unlock(&self, dek: [u8; KEY_LEN], autolock_minutes: u32) {
        *self.locked() = Some(Unlocked {
            dek,
            last_touch: Instant::now(),
            idle_limit: (autolock_minutes > 0)
                .then(|| Duration::from_secs(autolock_minutes as u64 * 60)),
        });
    }

    /// Wipes the key. Safe to call when already locked.
    pub fn lock(&self) {
        if let Some(mut open) = self.locked().take() {
            open.dek.zeroize();
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.locked().as_ref().is_some_and(|open| !open.is_expired())
    }

    /// Records activity, so the idle clock starts again.
    pub fn touch(&self) {
        if let Some(open) = self.locked().as_mut() {
            open.last_touch = Instant::now();
        }
    }

    /// Changes the idle window without re-unlocking.
    pub fn set_autolock(&self, minutes: u32) {
        if let Some(open) = self.locked().as_mut() {
            open.idle_limit = (minutes > 0).then(|| Duration::from_secs(minutes as u64 * 60));
        }
    }

    /// Runs `f` with the data key, if the vault is open.
    ///
    /// This is both the authorisation check and the idle heartbeat: an expired session is locked
    /// here, on the way out, rather than waiting for the ticker. Every read and write in
    /// `keyvault_cmd` goes through it, which is what makes "the vault is locked" a single fact
    /// rather than a flag each command remembers to check.
    pub fn with_key<T>(&self, f: impl FnOnce(&[u8; KEY_LEN]) -> T) -> Result<T, VaultError> {
        let mut guard = self.locked();
        let Some(open) = guard.as_mut() else {
            return Err(VaultError::Locked);
        };
        if open.is_expired() {
            if let Some(mut expired) = guard.take() {
                expired.dek.zeroize();
            }
            return Err(VaultError::Locked);
        }
        open.last_touch = Instant::now();
        Ok(f(&open.dek))
    }

    /// Whether the idle window has passed, without changing anything. For the ticker.
    fn expired(&self) -> bool {
        self.locked().as_ref().is_some_and(Unlocked::is_expired)
    }
}

impl Unlocked {
    fn is_expired(&self) -> bool {
        self.idle_limit
            .is_some_and(|limit| self.last_touch.elapsed() >= limit)
    }
}

/// Locks the vault when it has been idle too long, and tells the UI.
///
/// The ticker is not what enforces auto-lock — [`VaultSession::with_key`] is, and it would be
/// enough on its own. This exists so the lock is *visible*: without it a vault left open on screen
/// stays looking open, with secrets revealed in the panel, until something is clicked.
pub fn spawn_autolock(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            let session = app.state::<VaultSession>();
            if session.expired() {
                session.lock();
                // Best effort: a webview that has gone away is not a reason to stop the loop.
                let _ = app.emit(LOCKED_EVENT, ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; KEY_LEN] {
        [7u8; KEY_LEN]
    }

    #[test]
    fn a_locked_session_hands_out_nothing() {
        let session = VaultSession::default();
        assert!(!session.is_unlocked());
        assert!(matches!(session.with_key(|_| ()), Err(VaultError::Locked)));
    }

    #[test]
    fn unlocking_then_locking_takes_the_key_away_again() {
        let session = VaultSession::default();
        session.unlock(key(), 15);
        assert!(session.is_unlocked());
        assert!(session.with_key(|dek| *dek == key()).unwrap());

        session.lock();
        assert!(!session.is_unlocked());
        assert!(matches!(session.with_key(|_| ()), Err(VaultError::Locked)));
    }

    /// The case the ticker cannot cover: a machine that was asleep ran no timers, so the check has
    /// to happen on use.
    #[test]
    fn an_idle_session_locks_itself_on_the_next_use() {
        let session = VaultSession::default();
        session.unlock(key(), 1);
        // Reach in and age the session rather than sleeping a minute in a test.
        if let Some(open) = session.locked().as_mut() {
            open.last_touch = Instant::now() - Duration::from_secs(120);
        }
        assert!(matches!(session.with_key(|_| ()), Err(VaultError::Locked)));
        assert!(!session.is_unlocked(), "and it stays locked afterwards");
    }

    #[test]
    fn using_the_vault_restarts_the_idle_clock() {
        let session = VaultSession::default();
        session.unlock(key(), 1);
        if let Some(open) = session.locked().as_mut() {
            open.last_touch = Instant::now() - Duration::from_secs(50);
        }
        assert!(session.with_key(|_| ()).is_ok(), "50s of a 60s window is still open");
        let restarted = {
            let guard = session.locked();
            guard
                .as_ref()
                .map(|open| open.last_touch.elapsed() < Duration::from_secs(1))
        };
        assert_eq!(restarted, Some(true), "the clock restarted");
    }

    /// Zero minutes means "stay open", which is a setting a desktop user is entitled to.
    #[test]
    fn a_zero_minute_window_never_expires() {
        let session = VaultSession::default();
        session.unlock(key(), 0);
        if let Some(open) = session.locked().as_mut() {
            open.last_touch = Instant::now() - Duration::from_secs(60 * 60 * 24);
        }
        assert!(session.with_key(|_| ()).is_ok());
    }

    #[test]
    fn the_idle_window_can_be_changed_without_re_unlocking() {
        let session = VaultSession::default();
        session.unlock(key(), 0);
        session.set_autolock(1);
        if let Some(open) = session.locked().as_mut() {
            open.last_touch = Instant::now() - Duration::from_secs(120);
        }
        assert!(matches!(session.with_key(|_| ()), Err(VaultError::Locked)));
    }
}
