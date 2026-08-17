//! Who is allowed to drive this install from a phone, and how they proved it.
//!
//! # The shape of the trust
//!
//! There are exactly two credentials here and they have opposite lifetimes:
//!
//! * a **pairing code** — six digits, in memory only, dead after three minutes or five wrong
//!   guesses, whichever comes first. It exists so that a device on the same network can be handed
//!   a real credential without anybody typing a 43-character token on a phone keyboard.
//! * a **device token** — 32 random bytes, minted once when a code is redeemed, presented as a
//!   bearer on every request afterwards. The database keeps only its SHA-256, so this file is the
//!   only place a usable token is ever held, and only for the length of one response.
//!
//! # Why the code has an attempt counter and not just a TTL
//!
//! Six digits is a million possibilities, which sounds like a lot and is not: a script on the same
//! LAN can walk the whole space in well under a minute. A TTL alone would therefore be no defence
//! at all — the attacker does not need three minutes, they need thirty seconds. Counting failures
//! is what actually closes it, because five wrong answers destroy the code and the user has to
//! deliberately produce another one. The window an attacker gets is five guesses out of a million,
//! not three minutes of unlimited ones.
//!
//! Both halves live behind one mutex ([`Pairing`]) so a check and its consequence — burn the code,
//! or count the failure — cannot interleave with another request doing the same.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::{Rng as _, RngCore as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

/// How long an unredeemed pairing code stays good. Long enough to walk to the sofa and type it,
/// short enough that a code left on screen by accident is not a standing invitation.
const PAIRING_TTL: Duration = Duration::from_secs(180);

/// Wrong guesses before the code is destroyed. See the module comment — this, not the TTL, is what
/// makes a six-digit secret defensible.
const MAX_PAIRING_ATTEMPTS: u32 = 5;

/// How stale `last_seen_at` is allowed to get before a request bothers to write it.
///
/// Without this every single RPC would be a database write on a mutex the whole app shares, to
/// record something whose only reader is a settings screen that says "hace un momento" either way.
const LAST_SEEN_THROTTLE: Duration = Duration::from_secs(60);

/// A paired device, as the settings screen shows it. Deliberately carries no token and no hash —
/// there is nothing here that would help anybody who read it.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub revoked: bool,
    /// Whether this device has an event socket open at this instant.
    ///
    /// Not a column, and not derivable from one. `last_seen_at` is written by [`verify`], at most
    /// once a minute, and a WebSocket verifies exactly once — at upgrade. So a phone that has been
    /// driving the machine all afternoon shows a `last_seen_at` from lunchtime, which reads as a
    /// device that connected once and went away. This is the field that answers the question the
    /// settings panel is actually asking; it comes from
    /// [`RemoteCtl::is_connected`](crate::remotectl::RemoteCtl::is_connected).
    pub connected: bool,
}

/// The freshly minted credential, handed to the device once and never reconstructible.
#[derive(Debug, Clone, Serialize)]
pub struct PairedDevice {
    pub device_id: String,
    pub token: String,
}

struct Pending {
    code: String,
    expires_at: Instant,
    attempts: u32,
}

/// The pairing window, plus the throttle clock for `last_seen_at`.
///
/// Managed as Tauri state so that the settings screen (which opens a window) and the HTTP handler
/// (which closes it) are talking about the same one.
#[derive(Default)]
pub struct Pairing {
    pending: Mutex<Option<Pending>>,
    /// Device id -> when this process last wrote its `last_seen_at`. In memory because it is a
    /// throttle, not a fact: losing it on restart costs one extra write.
    seen: Mutex<HashMap<String, Instant>>,
}

/// What a bearer turned out to be.
pub enum Verdict {
    /// A live, unrevoked device. Carries the id so the caller can attribute the action.
    Device(String),
    Rejected,
}

impl Pairing {
    /// Opens a pairing window and returns the code to put on screen.
    ///
    /// Replaces any code already outstanding rather than refusing: the user pressing the button
    /// again means the last code did not reach the device, and leaving the old one alive would be
    /// two valid codes for one intent.
    pub fn open(&self) -> String {
        let code = format!("{:06}", rand::rng().random_range(0..1_000_000u32));
        let mut slot = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(Pending {
            code: code.clone(),
            expires_at: Instant::now() + PAIRING_TTL,
            attempts: 0,
        });
        code
    }

    /// Closes the window without redeeming it — the settings panel navigating away, or the user
    /// pressing cancel. Idempotent.
    pub fn close(&self) {
        let mut slot = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        *slot = None;
    }

    /// Whether a code is outstanding right now, for the settings screen's own display. Also sweeps
    /// an expired one, so the panel stops showing a code that would no longer work.
    pub fn is_open(&self) -> bool {
        let mut slot = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_ref() {
            Some(p) if p.expires_at > Instant::now() => true,
            Some(_) => {
                *slot = None;
                false
            }
            None => false,
        }
    }

    /// Checks a code and, on a match, burns it.
    ///
    /// The burn is unconditional on success — a code redeems exactly once, so two devices racing
    /// the same code cannot both come away with a token.
    ///
    /// Comparison is length-then-bytes rather than constant-time, and that is deliberate: the
    /// attempt counter above bounds an attacker to five tries, which is far too few for a timing
    /// signal to be assembled from. The counter is the defence; nothing here needs to also be.
    fn redeem_code(&self, presented: &str) -> bool {
        let mut slot = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let Some(pending) = slot.as_mut() else {
            return false;
        };
        if pending.expires_at <= Instant::now() {
            *slot = None;
            return false;
        }
        if pending.code == presented {
            *slot = None;
            return true;
        }
        pending.attempts += 1;
        if pending.attempts >= MAX_PAIRING_ATTEMPTS {
            *slot = None;
        }
        false
    }

    /// Whether enough time has passed to be worth writing this device's `last_seen_at`.
    fn should_touch(&self, device_id: &str) -> bool {
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        match seen.get(device_id) {
            Some(last) if now.duration_since(*last) < LAST_SEEN_THROTTLE => false,
            _ => {
                seen.insert(device_id.to_string(), now);
                true
            }
        }
    }
}

/// The hash the database stores. Hex rather than base64 so a row is greppable while debugging.
fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Redeems a pairing code for a device token.
///
/// The token is returned to exactly one caller and never stored in recoverable form — see the
/// `remote_devices` table comment in `db/migrations.rs`.
pub fn pair(
    conn: &Connection,
    pairing: &Pairing,
    code: &str,
    device_name: &str,
) -> Result<PairedDevice, String> {
    if !pairing.redeem_code(code) {
        return Err("invalid or expired pairing code".into());
    }

    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let device_id = Uuid::new_v4().to_string();

    // The name is display-only and comes from the device, so it is clamped here rather than
    // trusted: nothing downstream should have to defend against a megabyte of "name".
    let name: String = device_name.trim().chars().take(64).collect();
    let name = if name.is_empty() { "Dispositivo".to_string() } else { name };

    conn.execute(
        "INSERT INTO remote_devices (id, name, token_hash, created_at, last_seen_at, revoked)
         VALUES (?1, ?2, ?3, ?4, ?4, 0)",
        params![device_id, name, hash_token(&token), crate::db::queries::now()],
    )
    .map_err(|e| e.to_string())?;

    Ok(PairedDevice { device_id, token })
}

/// Resolves a presented bearer to a device, refreshing `last_seen_at` at most once a minute.
///
/// A revoked row is excluded in SQL rather than checked afterwards, so revocation takes effect on
/// the very next request with no cache to invalidate.
pub fn verify(conn: &Connection, pairing: &Pairing, token: &str) -> Verdict {
    if token.is_empty() {
        return Verdict::Rejected;
    }
    let hash = hash_token(token);
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM remote_devices WHERE token_hash = ?1 AND revoked = 0",
            params![hash],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);

    match found {
        Some(id) => {
            if pairing.should_touch(&id) {
                let _ = conn.execute(
                    "UPDATE remote_devices SET last_seen_at = ?2 WHERE id = ?1",
                    params![id, crate::db::queries::now()],
                );
            }
            Verdict::Device(id)
        }
        None => Verdict::Rejected,
    }
}

/// What a device calls itself, for the desktop's notification centre.
///
/// Falls back to a generic label rather than to the id: a UUID in a notification says nothing to
/// anybody, and this is only ever used as display text beside an action.
pub fn device_name(conn: &Connection, id: &str) -> String {
    conn.query_row("SELECT name FROM remote_devices WHERE id = ?1", params![id], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .filter(|name| !name.is_empty())
    .unwrap_or_else(|| "Dispositivo".to_string())
}

/// Every device ever paired, newest first — revoked ones included, so the screen can show that a
/// device *was* cut off rather than quietly omitting it.
///
/// `connected` is a required argument rather than a field this function could leave `false`,
/// because it is the one part of a row that no query can produce: it lives in the process's socket
/// map. Passing it in makes a caller that has no live-connection information say so explicitly —
/// the tests below answer `false` for every id, which is the truth in a test with no server — and
/// makes it impossible to build a list that quietly reports every phone as disconnected.
pub fn list_devices(
    conn: &Connection,
    connected: &dyn Fn(&str) -> bool,
) -> Result<Vec<RemoteDevice>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, created_at, last_seen_at, revoked
             FROM remote_devices ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let revoked = row.get::<_, i64>(4)? != 0;
            Ok(RemoteDevice {
                // A revoked device's socket is closed by `Control::Revoked` the moment the button
                // is pressed, but the close is a round trip and this list is read immediately
                // after. Reporting a cut-off device as connected for those few milliseconds would
                // contradict the very row it sits on.
                connected: !revoked && connected(&id),
                id,
                name: row.get(1)?,
                created_at: row.get(2)?,
                last_seen_at: row.get(3)?,
                revoked,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// Cuts a device off. The row stays (see the table comment) but the hash is blanked to a value no
/// SHA-256 can equal, so even restoring `revoked = 0` by hand would not resurrect the old token.
pub fn revoke_device(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE remote_devices SET revoked = 1, token_hash = 'revoked:' || id WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cuts every device off at once — the "I lost my phone" button, and what turning the server off
/// with *forget devices* checked does.
pub fn revoke_all(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE remote_devices SET revoked = 1, token_hash = 'revoked:' || id WHERE revoked = 0",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Deletes a revoked row for good.
///
/// # Why this only touches revoked rows
///
/// Keeping the row after revocation is what lets the settings screen say "this device *was* cut
/// off, on this date" rather than silently forgetting a device existed — which is the more useful
/// answer in the moment you are revoking something. But "forever" was the wrong length for that:
/// a year of old phones is a list nobody can read, and the record stops being informative long
/// before it stops being long.
///
/// So forgetting is a second, deliberate step rather than a shorter default. The `revoked = 1`
/// clause in the SQL is the guarantee that makes it safe to offer: this can never delete a live
/// device, so it can never silently *un*-revoke one by removing the row that says it was cut off.
/// Cutting a device off and forgetting it remain two distinct acts, in that order.
pub fn forget_device(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM remote_devices WHERE id = ?1 AND revoked = 1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Clears the whole revoked list at once — the "tidy this up" button.
pub fn forget_all_revoked(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM remote_devices WHERE revoked = 1", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn a_code_redeems_exactly_once() {
        let conn = db();
        let pairing = Pairing::default();
        let code = pairing.open();

        assert!(pair(&conn, &pairing, &code, "iPad").is_ok());
        // The second attempt is a different device racing the same code, and it must not win.
        assert!(pair(&conn, &pairing, &code, "iPad").is_err());
    }

    #[test]
    fn five_wrong_guesses_destroy_the_code() {
        let conn = db();
        let pairing = Pairing::default();
        let code = pairing.open();
        let wrong = if code == "000000" { "111111" } else { "000000" };

        for _ in 0..MAX_PAIRING_ATTEMPTS {
            assert!(pair(&conn, &pairing, wrong, "attacker").is_err());
        }
        // The real code is now worthless too — that is the point. An attacker walking the space
        // cannot keep the window open by guessing.
        assert!(pair(&conn, &pairing, &code, "iPad").is_err());
        assert!(!pairing.is_open());
    }

    #[test]
    fn the_stored_row_never_holds_the_token() {
        let conn = db();
        let pairing = Pairing::default();
        let code = pairing.open();
        let paired = pair(&conn, &pairing, &code, "iPhone").unwrap();

        let stored: String = conn
            .query_row("SELECT token_hash FROM remote_devices WHERE id = ?1", params![paired.device_id], |r| r.get(0))
            .unwrap();
        assert_ne!(stored, paired.token, "the token itself must never be written");
        assert_eq!(stored, hash_token(&paired.token));
    }

    #[test]
    fn revoking_rejects_the_next_request() {
        let conn = db();
        let pairing = Pairing::default();
        let code = pairing.open();
        let paired = pair(&conn, &pairing, &code, "iPhone").unwrap();

        assert!(matches!(verify(&conn, &pairing, &paired.token), Verdict::Device(_)));
        revoke_device(&conn, &paired.device_id).unwrap();
        assert!(matches!(verify(&conn, &pairing, &paired.token), Verdict::Rejected));
    }

    /// Forgetting must never be able to resurrect a device by deleting the row that revoked it.
    #[test]
    fn forgetting_cannot_touch_a_live_device() {
        let conn = db();
        let pairing = Pairing::default();
        let code = pairing.open();
        let live = pair(&conn, &pairing, &code, "iPhone").unwrap();

        forget_device(&conn, &live.device_id).unwrap();
        assert_eq!(list_devices(&conn, &|_| false).unwrap().len(), 1, "a live device must survive");
        assert!(matches!(verify(&conn, &pairing, &live.token), Verdict::Device(_)));

        // Once revoked, the same call does remove it.
        revoke_device(&conn, &live.device_id).unwrap();
        forget_device(&conn, &live.device_id).unwrap();
        assert!(list_devices(&conn, &|_| false).unwrap().is_empty());
        // And the token is still worthless, which is the part that must not depend on the row.
        assert!(matches!(verify(&conn, &pairing, &live.token), Verdict::Rejected));
    }

    #[test]
    fn forgetting_all_revoked_leaves_the_live_ones() {
        let conn = db();
        let pairing = Pairing::default();
        let mut ids = Vec::new();
        for name in ["uno", "dos", "tres"] {
            let code = pairing.open();
            ids.push(pair(&conn, &pairing, &code, name).unwrap().device_id);
        }
        revoke_device(&conn, &ids[0]).unwrap();
        revoke_device(&conn, &ids[2]).unwrap();

        forget_all_revoked(&conn).unwrap();
        let left = list_devices(&conn, &|_| false).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, ids[1]);
    }

    /// Revoking closes the device's socket, but the close is a round trip and this list is read on
    /// the very next line of the same command. A row that said "revocado" and "conectado ahora" at
    /// once would contradict itself over the few milliseconds in between.
    #[test]
    fn a_revoked_device_is_never_reported_as_connected() {
        let conn = db();
        let pairing = Pairing::default();
        let code = pairing.open();
        let paired = pair(&conn, &pairing, &code, "iPhone").unwrap();

        // Everything is connected, as far as this closure is concerned.
        let all_live = |_: &str| true;
        assert!(list_devices(&conn, &all_live).unwrap()[0].connected);

        revoke_device(&conn, &paired.device_id).unwrap();
        assert!(!list_devices(&conn, &all_live).unwrap()[0].connected);
    }

    #[test]
    fn an_unknown_or_empty_bearer_is_rejected() {
        let conn = db();
        let pairing = Pairing::default();
        assert!(matches!(verify(&conn, &pairing, ""), Verdict::Rejected));
        assert!(matches!(verify(&conn, &pairing, "not-a-token"), Verdict::Rejected));
    }

    #[test]
    fn an_expired_window_stops_reporting_itself_as_open() {
        let pairing = Pairing::default();
        pairing.open();
        assert!(pairing.is_open());
        // Reach in rather than sleeping three minutes.
        {
            let mut slot = pairing.pending.lock().unwrap();
            slot.as_mut().unwrap().expires_at = Instant::now() - Duration::from_secs(1);
        }
        assert!(!pairing.is_open());
    }
}
