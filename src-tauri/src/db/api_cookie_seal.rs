//! The API client's cookie jar, sealed at rest.
//!
//! `api_cookies.value` held every cookie in the clear — and a cookie is very often a session: the
//! thing a server checks instead of a password. The database ends up in support bundles, in Time
//! Machine and on disk images, so each value is now sealed with AES-256-GCM under one key kept in the
//! OS credential store ([`crate::secrets::api_cookie_key`]):
//!
//! ```text
//! value = "cfck1:" + base64url(nonce ‖ ciphertext ‖ tag)
//! ```
//!
//! The AAD is the cookie's identity on the wire — domain, path and name — so a sealed value cannot be
//! moved to another row by editing the file: a session cookie relabelled for a domain somebody else
//! controls fails its tag instead of being sent there.
//!
//! ## Where sealing happens
//!
//! At the command boundary, like `api_secrets`: the frontend keeps real values (it builds and sends
//! every request itself — the backend is a transport), `api_upsert_cookie` seals on the way down and
//! `api_list_cookies` opens on the way up. The key is read *before* the database lock is taken, never
//! under it: a credential-store read can block on a macOS prompt, and every command waits on that lock.
//!
//! ## The jar that was already there
//!
//! Rows written before this existed are sealed the first time the jar is listed ([`seal_stored`]):
//! idempotent — a sealed value starts with [`PREFIX`] and is skipped — and cheap once done, since the
//! scan only finds the rows that do not. Deliberately not a `migrations.rs` step: migrations run at
//! launch, inside the database's one opening transaction, before any window, and reading the
//! credential store there is the startup prompt `secrets.rs` exists to avoid. A jar nobody opens stays
//! as it was until somebody does.
//!
//! ## Failure is never data loss
//!
//! Same rule as `api_secrets`. A store that will not give up (or take) the key leaves a new cookie in
//! the clear, as every cookie was before, to be sealed by a later list. A sealed value that will not
//! open — the key is missing, or it came from another machine — stays in its row and is left out of
//! the listing: the frontend never sends ciphertext to a server as though it were a cookie, and the
//! next `Set-Cookie` for the same name replaces it.
//!
//! ## Backups
//!
//! The whole-install backup copies rows verbatim, so the key travels with the backup's credentials
//! (`backup::vault::secret_keys`) and a jar restored onto another machine opens there. A restore that
//! brings a *different* key re-seals what this machine already had under the old one ([`reseal`]) —
//! otherwise a merge, or a backup that left the jar out, would orphan every local cookie. A backup
//! taken without credentials carries the jar sealed to the machine that wrote it: cookies are
//! credentials, and somebody who kept those out of the file has kept these out too.

use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use rand::RngCore as _;
use rusqlite::{params, Connection};
use zeroize::Zeroize as _;

use super::api_secrets::SecretStore;
use super::models::ApiCookie;

/// What a sealed value starts with. Versioned, so a different scheme later can tell its values from
/// these without guessing.
pub const PREFIX: &str = "cfck1:";

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// The jar's key. Wiped when dropped, and neither `Clone` nor `Debug`, so it is not copied or printed
/// by accident.
pub struct JarKey([u8; 32]);

impl JarKey {
    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.0))
    }

    /// Whether two keys are the same key — what a restore asks of the key before and after it.
    pub fn same_as(&self, other: &JarKey) -> bool {
        self.0 == other.0
    }
}

impl Drop for JarKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

fn decode_key(encoded: &str) -> Option<JarKey> {
    let bytes = STANDARD.decode(encoded.trim()).ok()?;
    let key: [u8; 32] = bytes.as_slice().try_into().ok()?;
    Some(JarKey(key))
}

/// The jar's key, if one was ever minted.
///
/// A stored value that is not a key is an error rather than `None`: answering "no key" would let the
/// next write mint a new one over it, and whatever the old one sealed would never open again.
pub fn existing_key(store: &dyn SecretStore) -> Result<Option<JarKey>, String> {
    match store.get(&crate::secrets::api_cookie_key())? {
        None => Ok(None),
        Some(encoded) => decode_key(&encoded)
            .map(Some)
            .ok_or_else(|| "the cookie jar's key in the credential store is damaged".to_string()),
    }
}

/// The jar's key, minted and stored the first time one is needed.
///
/// Serialised: two first cookies arriving together must not each mint a key, because whichever is
/// written second makes everything the first one sealed unreadable.
pub fn key_or_create(store: &dyn SecretStore) -> Result<JarKey, String> {
    static MINTING: OnceLock<Mutex<()>> = OnceLock::new();
    let _minting = MINTING.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if let Some(key) = existing_key(store)? {
        return Ok(key);
    }
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut encoded = STANDARD.encode(bytes);
    let stored = store.set(&crate::secrets::api_cookie_key(), &encoded);
    encoded.zeroize();
    stored?;
    Ok(JarKey(bytes))
}

/// The cookie's identity on the wire, as the additional data its value is sealed against. JSON so no
/// separator a domain or a name could contain makes two identities read the same.
fn aad(domain: &str, path: &str, name: &str) -> Vec<u8> {
    serde_json::to_vec(&[domain, path, name]).unwrap_or_default()
}

/// Seals one value for storage.
pub fn seal(value: &str, domain: &str, path: &str, name: &str, key: &JarKey) -> Result<String, String> {
    let mut nonce = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce);
    let sealed = key
        .cipher()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: value.as_bytes(), aad: &aad(domain, path, name) })
        .map_err(|_| "a cookie could not be sealed".to_string())?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&sealed);
    Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(blob)))
}

/// A stored value, readable: a value not sealed yet as it is, a sealed one opened — or `None` when it
/// will not open under `key` (or there is no key to try).
pub fn open(stored: &str, domain: &str, path: &str, name: &str, key: Option<&JarKey>) -> Option<String> {
    let Some(body) = stored.strip_prefix(PREFIX) else {
        return Some(stored.to_string());
    };
    let blob = URL_SAFE_NO_PAD.decode(body).ok()?;
    if blob.len() < NONCE_LEN + TAG_LEN {
        return None;
    }
    let (nonce, sealed) = blob.split_at(NONCE_LEN);
    let plain = key?
        .cipher()
        .decrypt(Nonce::from_slice(nonce), Payload { msg: sealed, aad: &aad(domain, path, name) })
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Seals a cookie's value on its way into the jar. With no key the value goes in as it came — see
/// "Failure is never data loss" — and an empty value is not a secret worth a nonce.
pub fn seal_cookie(cookie: &mut ApiCookie, key: Option<&JarKey>) {
    let Some(key) = key else { return };
    if cookie.value.is_empty() {
        return;
    }
    if let Ok(sealed) = seal(&cookie.value, &cookie.domain, &cookie.path, &cookie.name, key) {
        cookie.value = sealed;
    }
}

/// A listed jar with every value opened, leaving out the ones that will not open.
pub fn open_jar(cookies: Vec<ApiCookie>, key: Option<&JarKey>) -> Vec<ApiCookie> {
    cookies
        .into_iter()
        .filter_map(|mut cookie| {
            cookie.value = open(&cookie.value, &cookie.domain, &cookie.path, &cookie.name, key)?;
            Some(cookie)
        })
        .collect()
}

/// What listing a workspace's jar needs from the credential store, asked of the database first so a
/// jar with nothing in it never touches the store at all.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct JarNeeds {
    /// Some row, in any workspace, still holds a value in the clear — so the key has to exist.
    pub unsealed: bool,
    /// This workspace's jar holds sealed values — so the key has to be read.
    pub sealed: bool,
}

pub fn needs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<JarNeeds> {
    let unsealed: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM api_cookies WHERE value <> '' AND substr(value, 1, ?1) <> ?2)",
        params![PREFIX.len() as i64, PREFIX],
        |row| row.get(0),
    )?;
    let sealed: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM api_cookies WHERE workspace_id = ?1 AND substr(value, 1, ?2) = ?3)",
        params![workspace_id, PREFIX.len() as i64, PREFIX],
        |row| row.get(0),
    )?;
    Ok(JarNeeds { unsealed, sealed })
}

type StoredRow = (String, String, String, String, String);

fn rows(conn: &Connection, sealed: bool) -> rusqlite::Result<Vec<StoredRow>> {
    let sql = if sealed {
        "SELECT id, domain, path, name, value FROM api_cookies WHERE substr(value, 1, ?1) = ?2"
    } else {
        "SELECT id, domain, path, name, value FROM api_cookies WHERE value <> '' AND substr(value, 1, ?1) <> ?2"
    };
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params![PREFIX.len() as i64, PREFIX], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
    })?;
    rows.collect()
}

/// Seals every value still stored in the clear, in every workspace, answering how many.
///
/// Idempotent: a sealed value is never selected. Each row is rewritten only if it still holds what
/// was read, so a cookie updated in between keeps its newer value — which the next pass seals.
pub fn seal_stored(conn: &Connection, key: &JarKey) -> rusqlite::Result<usize> {
    let mut sealed = 0;
    for (id, domain, path, name, value) in rows(conn, false)? {
        let Ok(next) = seal(&value, &domain, &path, &name, key) else { continue };
        sealed += conn.execute(
            "UPDATE api_cookies SET value = ?2 WHERE id = ?1 AND value = ?3",
            params![id, next, value],
        )?;
    }
    Ok(sealed)
}

/// Re-seals under `new` every value that opens under `old` and not under `new`, answering how many.
///
/// For a restore that brought a different key: the rows that came in the backup already open under
/// it, and the ones this machine had before are the ones that would otherwise never open again.
pub fn reseal(conn: &Connection, old: &JarKey, new: &JarKey) -> rusqlite::Result<usize> {
    let mut moved = 0;
    for (id, domain, path, name, value) in rows(conn, true)? {
        if open(&value, &domain, &path, &name, Some(new)).is_some() {
            continue;
        }
        let Some(plain) = open(&value, &domain, &path, &name, Some(old)) else { continue };
        let Ok(next) = seal(&plain, &domain, &path, &name, new) else { continue };
        moved += conn.execute(
            "UPDATE api_cookies SET value = ?2 WHERE id = ?1 AND value = ?3",
            params![id, next, value],
        )?;
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::api_secrets::MemoryStore;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Flow', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
    }

    fn cookie(id: &str, name: &str, value: &str) -> ApiCookie {
        ApiCookie {
            id: id.into(),
            workspace_id: "w1".into(),
            domain: "api.example.test".into(),
            path: "/".into(),
            name: name.into(),
            value: value.into(),
            secure: true,
            http_only: true,
            expires: None,
            updated_at: String::new(),
        }
    }

    fn is_sealed(value: &str) -> bool {
        value.starts_with(PREFIX)
    }

    fn stored_value(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT value FROM api_cookies WHERE id = ?1", [id], |row| row.get(0)).unwrap()
    }

    #[test]
    fn a_value_round_trips_and_is_not_stored_in_the_clear() {
        let store = MemoryStore::default();
        let key = key_or_create(&store).unwrap();
        let sealed = seal("session=abc123", "api.example.test", "/", "sid", &key).unwrap();
        assert!(is_sealed(&sealed));
        assert!(!sealed.contains("abc123"));
        assert_eq!(open(&sealed, "api.example.test", "/", "sid", Some(&key)).as_deref(), Some("session=abc123"));
        // Two seals of one value differ: a fresh nonce each time.
        assert_ne!(sealed, seal("session=abc123", "api.example.test", "/", "sid", &key).unwrap());
    }

    /// The attack the AAD exists for: a sealed session relabelled for another domain — somebody
    /// else's — must not open, or the app would send it there.
    #[test]
    fn a_value_moved_to_another_cookie_does_not_open() {
        let key = key_or_create(&MemoryStore::default()).unwrap();
        let sealed = seal("secret", "api.example.test", "/", "sid", &key).unwrap();
        assert!(open(&sealed, "attacker.example.test", "/", "sid", Some(&key)).is_none());
        assert!(open(&sealed, "api.example.test", "/admin", "sid", Some(&key)).is_none());
        assert!(open(&sealed, "api.example.test", "/", "other", Some(&key)).is_none());
        // And without the key, or under another one, nothing opens either.
        assert!(open(&sealed, "api.example.test", "/", "sid", None).is_none());
        let other = key_or_create(&MemoryStore::default()).unwrap();
        assert!(open(&sealed, "api.example.test", "/", "sid", Some(&other)).is_none());
    }

    /// One key per install: minted once, then read back rather than replaced.
    #[test]
    fn the_key_is_minted_once() {
        let store = MemoryStore::default();
        assert!(existing_key(&store).unwrap().is_none());
        let first = key_or_create(&store).unwrap();
        let again = key_or_create(&store).unwrap();
        assert!(first.same_as(&again));
        assert!(existing_key(&store).unwrap().unwrap().same_as(&first));
        // A damaged key is an error, never quietly replaced — replacing it would orphan the jar.
        store.values.borrow_mut().insert(crate::secrets::api_cookie_key(), "not base64 at all!".into());
        assert!(existing_key(&store).is_err());
        assert!(key_or_create(&store).is_err());
    }

    /// The jar that predates sealing: sealed on the first pass, untouched by the second.
    #[test]
    fn stored_cookies_are_sealed_once_and_empty_ones_left_alone() {
        let conn = db();
        crate::db::api_queries::upsert_cookie(&conn, &cookie("c1", "sid", "plain-session")).unwrap();
        crate::db::api_queries::upsert_cookie(&conn, &cookie("c2", "empty", "")).unwrap();
        let key = key_or_create(&MemoryStore::default()).unwrap();

        assert_eq!(needs(&conn, "w1").unwrap(), JarNeeds { unsealed: true, sealed: false });
        assert_eq!(seal_stored(&conn, &key).unwrap(), 1);
        let stored = stored_value(&conn, "c1");
        assert!(is_sealed(&stored) && !stored.contains("plain-session"));
        assert_eq!(stored_value(&conn, "c2"), "");

        assert_eq!(seal_stored(&conn, &key).unwrap(), 0, "a second pass finds nothing to do");
        assert_eq!(stored_value(&conn, "c1"), stored, "and rewrites nothing");
        assert_eq!(needs(&conn, "w1").unwrap(), JarNeeds { unsealed: false, sealed: true });

        let listed = open_jar(crate::db::api_queries::list_cookies(&conn, "w1").unwrap(), Some(&key));
        let session = listed.iter().find(|c| c.id == "c1").unwrap();
        assert_eq!(session.value, "plain-session");
    }

    /// A value that will not open is left out of the listing — never handed to the frontend as a
    /// cookie to send — and left in its row.
    #[test]
    fn a_value_that_will_not_open_is_not_listed_and_not_deleted() {
        let conn = db();
        let foreign = key_or_create(&MemoryStore::default()).unwrap();
        let mut theirs = cookie("c1", "sid", "from-another-machine");
        seal_cookie(&mut theirs, Some(&foreign));
        crate::db::api_queries::upsert_cookie(&conn, &theirs).unwrap();
        crate::db::api_queries::upsert_cookie(&conn, &cookie("c2", "theme", "dark")).unwrap();

        let mine = key_or_create(&MemoryStore::default()).unwrap();
        let listed = open_jar(crate::db::api_queries::list_cookies(&conn, "w1").unwrap(), Some(&mine));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].value, "dark");
        assert!(is_sealed(&stored_value(&conn, "c1")), "the row is kept");
    }

    /// With no key to be had the cookie is stored as it came — the pre-sealing behaviour — and a
    /// later pass seals it.
    #[test]
    fn with_no_key_a_cookie_is_stored_as_it_came() {
        let mut jar_cookie = cookie("c1", "sid", "value");
        seal_cookie(&mut jar_cookie, None);
        assert_eq!(jar_cookie.value, "value");
    }

    /// A restore that brought another machine's key: this machine's cookies move to it, the restored
    /// ones already open under it, and nothing is lost either way.
    #[test]
    fn a_restore_with_another_key_reseals_what_was_already_here() {
        let conn = db();
        let local = key_or_create(&MemoryStore::default()).unwrap();
        let restored = key_or_create(&MemoryStore::default()).unwrap();
        let mut here = cookie("c1", "sid", "local-session");
        seal_cookie(&mut here, Some(&local));
        let mut arrived = cookie("c2", "other", "restored-session");
        seal_cookie(&mut arrived, Some(&restored));
        crate::db::api_queries::upsert_cookie(&conn, &here).unwrap();
        crate::db::api_queries::upsert_cookie(&conn, &arrived).unwrap();

        assert_eq!(reseal(&conn, &local, &restored).unwrap(), 1);
        let listed = open_jar(crate::db::api_queries::list_cookies(&conn, "w1").unwrap(), Some(&restored));
        let mut values: Vec<_> = listed.iter().map(|c| c.value.as_str()).collect();
        values.sort_unstable();
        assert_eq!(values, ["local-session", "restored-session"]);
        assert_eq!(reseal(&conn, &local, &restored).unwrap(), 0, "idempotent");
    }
}
