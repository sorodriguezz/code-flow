//! The API client's credentials, kept in the OS credential store instead of the `api_*` tables.
//!
//! Every auth token, password, API key, OAuth access/refresh token, value of a variable marked
//! secret and client-certificate passphrase used to sit in SQLite in plain text — a file that ends
//! up in support bundles, in Time Machine and on any disk image of the machine. They now live where
//! the database connections' passwords already do (`crate::secrets`), and the row keeps a **marker**
//! in the slot the value came from:
//!
//! ```text
//! "bearer": { "token": "cf-keychain:auth.bearer.token" }
//! ```
//!
//! The marker carries the slot's path; the credential key is that path plus the row that owns it —
//! `api-secret:request:<id>:auth.bearer.token` (see `secrets::api_secret_key`). Deriving the key
//! from the row rather than storing a random handle is what lets the whole-install backup list every
//! one of them without being able to enumerate the credential store (`backup::vault`), and what lets
//! a deleted row take its credentials with it.
//!
//! ## Where sealing happens
//!
//! At the command boundary, never inside `api_queries`: the frontend keeps working with real values
//! (it has to — it resolves and sends every request, see the API client's "backend is a transport"
//! rule), the commands that write a row seal it on the way down, and the commands that read one
//! unseal it on the way up. `api_queries`, `api_sync` and `api_backup` only ever see markers, which
//! is also why the collaboration layer needs no credential store at all: a marker sits in a slot the
//! push blanks anyway.
//!
//! ## What is *not* sealed
//!
//! A `{{variable}}` reference. `{{token}}` in a bearer field is not a credential, it is the pattern
//! that keeps the credential in an environment — and it has to keep travelling to teammates, which
//! a sealed value never does.
//!
//! ## Failure is never data loss
//!
//! A value the store refuses stays in the row as it was (and is retried on the next write). A marker
//! whose credential cannot be *read* stays a marker rather than becoming `""`: the frontend then
//! shows it, a save writes it back unchanged, and nothing is deleted over a keychain prompt someone
//! dismissed. Only a credential the store positively does not have reads back as empty.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::{params, Connection};
use serde_json::Value;

use super::models::{ApiCollection, ApiEnvironment, ApiFolder, ApiRequestRow, ApiTree};
use super::queries;
use super::Db;

/// The fields of an `AuthConfig` that hold a credential, per scheme. One list for sealing, for the
/// collaboration push (`api_sync`) and for history redaction: three lists would drift, and the one
/// that fell behind would be the one publishing a token.
pub const AUTH_SECRET_FIELDS: &[(&str, &[&str])] = &[
    ("basic", &["password"]),
    ("digest", &["password"]),
    ("bearer", &["token"]),
    ("apikey", &["value"]),
    ("jwt", &["secret"]),
    ("awsv4", &["secretKey", "sessionToken"]),
    ("oauth2", &["clientSecret", "password", "accessToken", "refreshToken"]),
];

/// What a sealed slot holds: this prefix and the slot's path.
pub const MARKER: &str = "cf-keychain:";

/// What history keeps in place of a credential.
pub const REDACTED: &str = "•••";

/// Headers whose value is a credential whatever it looks like.
const SENSITIVE_HEADERS: &[&str] = &["authorization", "proxy-authorization", "cookie", "set-cookie"];

/// Below this a "secret" matches inside ordinary words and numbers all over a response, and history
/// would come back as a field of dots. A three-character credential is not one worth that.
const MIN_SCRUB_LEN: usize = 4;

/// Set once every stored row has been sealed and old history redacted — see [`seal_stored`].
pub const SEALED_FLAG: &str = "api_secrets_sealed";

const SETTINGS_KEY: &str = "api_settings";
const OPEN_TABS_PREFIX: &str = "api_open_tabs:";

// ---------------------------------------------------------------------------
// Owners, shapes and slots
// ---------------------------------------------------------------------------

/// What a credential belongs to — the first half of its key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Owner {
    Collection,
    Folder,
    Request,
    Environment,
    /// An open editor tab's draft, persisted in `api_open_tabs:<workspace>`.
    Tab,
    /// A client certificate in `api_settings`.
    Cert,
}

impl Owner {
    pub fn tag(self) -> &'static str {
        match self {
            Owner::Collection => "collection",
            Owner::Folder => "folder",
            Owner::Request => "request",
            Owner::Environment => "environment",
            Owner::Tab => "tab",
            Owner::Cert => "cert",
        }
    }
}

pub fn secret_key(owner: Owner, id: &str, path: &str) -> String {
    crate::secrets::api_secret_key(owner.tag(), id, path)
}

/// Where the credential slots sit inside one stored blob.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// An `AuthConfig` — a collection's or folder's `auth` column.
    Auth,
    /// An `ApiVariable[]` — a collection's or environment's `variables` column.
    Variables,
    /// An `ApiRequestSpec` — a request's `spec`, or a request tab's draft: its auth block and the
    /// MQTT password.
    Spec,
    /// A collection or folder tab's draft: an `auth` object and a `variables` array.
    EntityDraft,
    /// One `ClientCert` of `api_settings`: its passphrase.
    Cert,
}

/// Which slots a walk visits. Sealing only lifts variables flagged secret; everything that *reads*
/// markers looks in every variable, because a teammate can unflag one whose value is sealed here.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reach {
    Sealable,
    Any,
}

type Visit<'a> = dyn FnMut(&str, &mut Value) + 'a;

fn string_slot(path: &str, slot: &mut Value, visit: &mut Visit<'_>) {
    if slot.is_string() {
        visit(path, slot);
    }
}

fn auth_slots(auth: &mut Value, visit: &mut Visit<'_>) {
    for (scheme, fields) in AUTH_SECRET_FIELDS {
        let Some(block) = auth.get_mut(*scheme) else { continue };
        for field in *fields {
            if let Some(slot) = block.get_mut(*field) {
                string_slot(&format!("auth.{scheme}.{field}"), slot, visit);
            }
        }
    }
}

/// A variable's slot is named by its `id`, so the credential follows the variable through a rename
/// or a reorder. An id that is missing or shared by two variables of the same list cannot name
/// either of them, and the position does instead.
fn variable_slots(variables: &mut Value, reach: Reach, visit: &mut Visit<'_>) {
    let Some(list) = variables.as_array_mut() else { return };
    let ids: Vec<String> = list
        .iter()
        .map(|variable| variable.get("id").and_then(Value::as_str).unwrap_or_default().to_string())
        .collect();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for id in &ids {
        *counts.entry(id.as_str()).or_default() += 1;
    }
    for (index, variable) in list.iter_mut().enumerate() {
        let secret = variable.get("secret").and_then(Value::as_bool) == Some(true);
        if reach == Reach::Sealable && !secret {
            continue;
        }
        let id = &ids[index];
        let name = if !id.is_empty() && counts.get(id.as_str()) == Some(&1) {
            id.clone()
        } else {
            format!("#{index}")
        };
        for field in ["initialValue", "currentValue"] {
            if let Some(slot) = variable.get_mut(field) {
                string_slot(&format!("var.{name}.{field}"), slot, visit);
            }
        }
    }
}

fn visit_slots(shape: Shape, value: &mut Value, reach: Reach, visit: &mut Visit<'_>) {
    match shape {
        Shape::Auth => auth_slots(value, visit),
        Shape::Variables => variable_slots(value, reach, visit),
        Shape::Spec => {
            if let Some(auth) = value.get_mut("auth") {
                auth_slots(auth, visit);
            }
            if let Some(slot) = value.get_mut("mqtt").and_then(|mqtt| mqtt.get_mut("password")) {
                string_slot("mqtt.password", slot, visit);
            }
        }
        Shape::EntityDraft => {
            if let Some(auth) = value.get_mut("auth") {
                auth_slots(auth, visit);
            }
            if let Some(variables) = value.get_mut("variables") {
                variable_slots(variables, reach, visit);
            }
        }
        Shape::Cert => {
            if let Some(slot) = value.get_mut("passphrase") {
                string_slot("passphrase", slot, visit);
            }
        }
    }
}

/// The slots of a request spec the collaboration push blanks — the same ones sealing lifts.
pub fn spec_secret_slots(spec: &mut Value, visit: &mut Visit<'_>) {
    visit_slots(Shape::Spec, spec, Reach::Sealable, visit);
}

/// The slots of an `AuthConfig` that hold a credential.
pub fn auth_secret_slots(auth: &mut Value, visit: &mut Visit<'_>) {
    auth_slots(auth, visit);
}

// ---------------------------------------------------------------------------
// What a value is
// ---------------------------------------------------------------------------

pub fn is_marker(value: &str) -> bool {
    value.starts_with(MARKER)
}

/// A value that only points at variables: `{{token}}`, `{{user}}:{{pass}}`. Nothing outside the
/// braces but punctuation and space, so there is no credential in it to protect — and it has to
/// keep travelling, because it is how a team shares a request without sharing the token.
///
/// The token grammar is the frontend's (`VARIABLE_PATTERN` in `lib/api/variables.ts`): `{{`, a name
/// with no braces in it, `}}`.
pub fn is_reference(value: &str) -> bool {
    let mut rest = value;
    let mut outside = String::new();
    let mut found = false;
    while let Some(start) = rest.find("{{") {
        outside.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) if !after[..end].contains(['{', '}']) && !after[..end].trim().is_empty() => {
                found = true;
                rest = &after[end + 2..];
            }
            _ => {
                outside.push_str("{{");
                rest = after;
            }
        }
    }
    outside.push_str(rest);
    found && !outside.chars().any(char::is_alphanumeric)
}

/// A credential typed in as itself: not empty, not already sealed, not a reference.
pub fn is_literal(value: &str) -> bool {
    !value.is_empty() && !is_marker(value) && !is_reference(value)
}

// ---------------------------------------------------------------------------
// Where the values go
// ---------------------------------------------------------------------------

/// The three things sealing needs from a credential store. The OS one in the app ([`OsStore`]); a
/// map in the tests, which must never write to the developer's real keychain.
pub trait SecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// `crate::secrets`, as a store.
pub struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        crate::secrets::get_secret(key)
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        crate::secrets::set_secret(key, value)
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        crate::secrets::delete_secret(key)
    }
}

/// What a split value's own entry holds: this prefix and how many pieces follow it.
pub const CHUNK_HEADER: &str = "cf-chunks:";

/// Characters per piece. Windows' Credential Manager caps one credential at 2560 bytes and the
/// `keyring` crate stores it as UTF-16, so 600 characters fit even when every one of them takes two
/// code units.
const CHUNK_CHARS: usize = 600;

/// Past this the value is not a credential anybody types — and a store that cannot hold it keeps it
/// in the row, as before, rather than in fifty entries.
const MAX_CHUNKS: usize = 64;

pub fn chunk_key(key: &str, index: usize) -> String {
    format!("{key}#{index}")
}

/// The number of pieces a header announces, or `None` for an ordinary value.
pub fn chunk_count(head: &str) -> Option<usize> {
    head.strip_prefix(CHUNK_HEADER)?
        .parse::<usize>()
        .ok()
        .filter(|count| (1..=MAX_CHUNKS).contains(count))
}

/// A store that splits what the one beneath it refuses as too long.
///
/// Only on refusal. macOS keeps every credential in one Keychain item and Linux's secret service has
/// no small cap, so a value is split only where it has to be — in practice an OAuth access token or a
/// PEM signing key on Windows, both routinely past the 1280 characters one entry holds there.
pub struct Chunked<S>(pub S);

impl<S: SecretStore> Chunked<S> {
    fn pieces_behind(&self, key: &str) -> usize {
        self.0.get(key).ok().flatten().and_then(|head| chunk_count(&head)).unwrap_or(0)
    }
}

impl<S: SecretStore> SecretStore for Chunked<S> {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let Some(head) = self.0.get(key)? else { return Ok(None) };
        let Some(count) = chunk_count(&head) else { return Ok(Some(head)) };
        let mut whole = String::new();
        for index in 0..count {
            match self.0.get(&chunk_key(key, index))? {
                Some(piece) => whole.push_str(&piece),
                // A piece gone missing leaves nothing worth returning: half a token authenticates
                // no better than none, and reads back as missing instead of as a wrong value.
                None => return Ok(None),
            }
        }
        Ok(Some(whole))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let before = self.pieces_behind(key);
        let written = match self.0.set(key, value) {
            Ok(()) => 0,
            Err(error) => {
                let chars: Vec<char> = value.chars().collect();
                if chars.len() <= CHUNK_CHARS || chars.len() > CHUNK_CHARS * MAX_CHUNKS {
                    return Err(error);
                }
                let pieces: Vec<String> =
                    chars.chunks(CHUNK_CHARS).map(|piece| piece.iter().collect()).collect();
                // The pieces first and the header last: a header written ahead of its pieces would
                // announce a value that is not there yet.
                for (index, piece) in pieces.iter().enumerate() {
                    self.0.set(&chunk_key(key, index), piece)?;
                }
                self.0.set(key, &format!("{CHUNK_HEADER}{}", pieces.len()))?;
                pieces.len()
            }
        };
        // The pieces of a longer value this one replaced.
        for index in written..before {
            let _ = self.0.delete(&chunk_key(key, index));
        }
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        for index in 0..self.pieces_behind(key) {
            self.0.delete(&chunk_key(key, index))?;
        }
        self.0.delete(key)
    }
}

/// The store every command uses.
pub type OsStore = Chunked<Keychain>;

pub fn os_store() -> OsStore {
    Chunked(Keychain)
}

/// An in-memory store for the tests of this module and of the ones that seal through it.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    pub values: std::cell::RefCell<HashMap<String, String>>,
    /// Refuses values longer than this, the way a size-capped platform store does.
    pub limit: Option<usize>,
    /// Refuses every read, the way a store the user has not let the app into does.
    pub unreadable: bool,
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        if self.unreadable {
            return Err("the store is locked".into());
        }
        Ok(self.values.borrow().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if self.limit.is_some_and(|limit| value.chars().count() > limit) {
            return Err("value too long for this store".into());
        }
        self.values.borrow_mut().insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.values.borrow_mut().remove(key);
        Ok(())
    }
}

/// Serialises every "write the credential, then write the row" sequence in the process.
///
/// Two of them interleaving on the same slot is the one way this module could put the wrong value
/// behind a marker: an older value written to the store *after* a newer one, with the newer row
/// already in place. Always taken before the database lock, never while holding it.
pub fn seal_guard() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Sealing and unsealing one blob
// ---------------------------------------------------------------------------

/// What sealing one blob produced.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// The blob to store: literals replaced by markers, everything else as it was.
    pub text: String,
    /// Every credential key the stored blob refers to, including markers it already had.
    pub keys: BTreeSet<String>,
    /// Literals moved into the store by this call.
    pub lifted: usize,
    /// Literals the store refused, left in the blob as they were.
    pub failed: usize,
}

/// Moves every literal credential of `raw` into `store` and returns the blob with markers instead.
///
/// A blob that is empty or not JSON has no slots and comes back untouched — `""` is how an
/// unconfigured auth column is stored. The blob is only re-serialised when a slot actually changed,
/// so a row with nothing to seal is written back byte for byte.
pub fn seal_text(raw: &str, shape: Shape, owner: Owner, id: &str, store: &dyn SecretStore) -> Sealed {
    let mut outcome = Sealed { text: raw.to_string(), ..Default::default() };
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return outcome };
    let mut changed = false;
    // Markers anywhere, so a slot sealed before a teammate unflagged its variable still counts as
    // referenced — dropping its key would lose the value the row still points at.
    visit_slots(shape, &mut value, Reach::Any, &mut |_, slot| {
        if let Some(path) = slot.as_str().and_then(|text| text.strip_prefix(MARKER)) {
            outcome.keys.insert(secret_key(owner, id, path));
        }
    });
    visit_slots(shape, &mut value, Reach::Sealable, &mut |path, slot| {
        let Some(text) = slot.as_str() else { return };
        if !is_literal(text) {
            return;
        }
        let key = secret_key(owner, id, path);
        // A value the store already holds is not written again — on macOS every write rewrites the
        // one Keychain item all of the app's credentials live in.
        let stored = matches!(store.get(&key), Ok(Some(ref current)) if current == text);
        if stored || store.set(&key, text).is_ok() {
            *slot = Value::String(format!("{MARKER}{path}"));
            outcome.keys.insert(key);
            outcome.lifted += 1;
            changed = true;
        } else {
            outcome.failed += 1;
        }
    });
    if changed {
        outcome.text = serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string());
    }
    outcome
}

/// Whether sealing `raw` would move anything — a pure check, for deciding which rows to open.
pub fn has_literals(raw: &str, shape: Shape) -> bool {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return false };
    let mut found = false;
    visit_slots(shape, &mut value, Reach::Sealable, &mut |_, slot| {
        found |= slot.as_str().is_some_and(is_literal);
    });
    found
}

/// Puts the stored credentials back where `raw`'s markers are.
///
/// A credential the store does not have reads back as `""`; one it cannot be *asked* about right
/// now keeps its marker — see the module docs for why that difference matters.
pub fn unseal_text(raw: &str, shape: Shape, owner: Owner, id: &str, store: &dyn SecretStore) -> String {
    if !raw.contains(MARKER) {
        return raw.to_string();
    }
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return raw.to_string() };
    let mut changed = false;
    visit_slots(shape, &mut value, Reach::Any, &mut |_, slot| {
        let Some(path) = slot.as_str().and_then(|text| text.strip_prefix(MARKER)) else { return };
        match store.get(&secret_key(owner, id, path)) {
            Ok(Some(secret)) => *slot = Value::String(secret),
            Ok(None) => *slot = Value::String(String::new()),
            Err(_) => return,
        }
        changed = true;
    });
    if !changed {
        return raw.to_string();
    }
    serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

/// Every credential key `raw` refers to.
pub fn keys_in(raw: &str, shape: Shape, owner: Owner, id: &str) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    if !raw.contains(MARKER) {
        return keys;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return keys };
    visit_slots(shape, &mut value, Reach::Any, &mut |_, slot| {
        if let Some(path) = slot.as_str().and_then(|text| text.strip_prefix(MARKER)) {
            keys.insert(secret_key(owner, id, path));
        }
    });
    keys
}

/// Copies the credentials `raw` refers to from one owner to another, so a duplicated row's markers
/// resolve under its own id. The copy has to be real: markers shared between two rows would have
/// the original's delete take the copy's credentials with it.
pub fn copy_credentials(raw: &str, shape: Shape, owner: Owner, from: &str, to: &str, store: &dyn SecretStore) {
    if !raw.contains(MARKER) {
        return;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return };
    visit_slots(shape, &mut value, Reach::Any, &mut |_, slot| {
        let Some(path) = slot.as_str().and_then(|text| text.strip_prefix(MARKER)) else { return };
        if let Ok(Some(secret)) = store.get(&secret_key(owner, from, path)) {
            let _ = store.set(&secret_key(owner, to, path), &secret);
        }
    });
}

/// Deletes the credentials a write left unreferenced. Best-effort: an orphan in the store costs a
/// few bytes, and failing the save that produced it would cost the user their edit.
pub fn forget(store: &dyn SecretStore, keys: impl IntoIterator<Item = String>) {
    for key in keys {
        let _ = store.delete(&key);
    }
}

pub fn forget_stale(store: &dyn SecretStore, before: &BTreeSet<String>, after: &BTreeSet<String>) {
    forget(store, before.difference(after).cloned());
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// What sealing one row came to: the keys it now refers to, and how many values the store refused.
#[derive(Debug, Default)]
pub struct RowSeal {
    pub keys: BTreeSet<String>,
    pub failed: usize,
}

impl RowSeal {
    fn of(parts: impl IntoIterator<Item = Sealed>) -> RowSeal {
        let mut seal = RowSeal::default();
        for part in parts {
            seal.keys.extend(part.keys);
            seal.failed += part.failed;
        }
        seal
    }
}

pub fn seal_collection(collection: &mut ApiCollection, store: &dyn SecretStore) -> RowSeal {
    let auth = seal_text(&collection.auth, Shape::Auth, Owner::Collection, &collection.id, store);
    let variables = seal_text(&collection.variables, Shape::Variables, Owner::Collection, &collection.id, store);
    collection.auth = auth.text.clone();
    collection.variables = variables.text.clone();
    RowSeal::of([auth, variables])
}

pub fn seal_folder(folder: &mut ApiFolder, store: &dyn SecretStore) -> RowSeal {
    let auth = seal_text(&folder.auth, Shape::Auth, Owner::Folder, &folder.id, store);
    folder.auth = auth.text.clone();
    RowSeal::of([auth])
}

pub fn seal_request(request: &mut ApiRequestRow, store: &dyn SecretStore) -> RowSeal {
    let spec = seal_text(&request.spec, Shape::Spec, Owner::Request, &request.id, store);
    request.spec = spec.text.clone();
    RowSeal::of([spec])
}

pub fn seal_environment(environment: &mut ApiEnvironment, store: &dyn SecretStore) -> RowSeal {
    let variables = seal_text(&environment.variables, Shape::Variables, Owner::Environment, &environment.id, store);
    environment.variables = variables.text.clone();
    RowSeal::of([variables])
}

/// Forgets that a previous launch finished sealing, so the next one looks again. Called whenever the
/// store refuses a value: that value is still in a row, and nothing else would ever go back for it.
pub fn retry_later(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM app_settings WHERE key = ?1", params![SEALED_FLAG])?;
    Ok(())
}

pub fn unseal_collection(collection: &mut ApiCollection, store: &dyn SecretStore) {
    collection.auth = unseal_text(&collection.auth, Shape::Auth, Owner::Collection, &collection.id, store);
    collection.variables =
        unseal_text(&collection.variables, Shape::Variables, Owner::Collection, &collection.id, store);
}

pub fn unseal_folder(folder: &mut ApiFolder, store: &dyn SecretStore) {
    folder.auth = unseal_text(&folder.auth, Shape::Auth, Owner::Folder, &folder.id, store);
}

pub fn unseal_request(request: &mut ApiRequestRow, store: &dyn SecretStore) {
    request.spec = unseal_text(&request.spec, Shape::Spec, Owner::Request, &request.id, store);
}

pub fn unseal_environment(environment: &mut ApiEnvironment, store: &dyn SecretStore) {
    environment.variables =
        unseal_text(&environment.variables, Shape::Variables, Owner::Environment, &environment.id, store);
}

pub fn unseal_tree(tree: &mut ApiTree, store: &dyn SecretStore) {
    for collection in &mut tree.collections {
        unseal_collection(collection, store);
    }
    for folder in &mut tree.folders {
        unseal_folder(folder, store);
    }
    for request in &mut tree.requests {
        unseal_request(request, store);
    }
}

/// The table, and each secret-bearing column with its shape, of one owner kind.
fn columns_of(owner: Owner) -> Option<(&'static str, &'static [(&'static str, Shape)])> {
    match owner {
        Owner::Collection => {
            Some(("api_collections", &[("auth", Shape::Auth), ("variables", Shape::Variables)]))
        }
        Owner::Folder => Some(("api_folders", &[("auth", Shape::Auth)])),
        Owner::Request => Some(("api_requests", &[("spec", Shape::Spec)])),
        Owner::Environment => Some(("api_environments", &[("variables", Shape::Variables)])),
        Owner::Tab | Owner::Cert => None,
    }
}

/// The credential keys one stored row refers to — what a write compares against to find the ones
/// it has just left behind.
pub fn row_keys(conn: &Connection, owner: Owner, id: &str) -> rusqlite::Result<BTreeSet<String>> {
    let mut keys = BTreeSet::new();
    let Some((table, columns)) = columns_of(owner) else { return Ok(keys) };
    for (column, shape) in columns {
        let raw: Option<String> = conn
            .query_row(&format!("SELECT {column} FROM {table} WHERE id = ?1"), params![id], |row| row.get(0))
            .ok();
        if let Some(raw) = raw {
            keys.extend(keys_in(&raw, *shape, owner, id));
        }
    }
    Ok(keys)
}

fn keys_of_rows(
    conn: &Connection,
    sql: &str,
    id: &str,
    owner: Owner,
    shape: Shape,
    into: &mut BTreeSet<String>,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (row_id, raw) = row?;
        into.extend(keys_in(&raw, shape, owner, &row_id));
    }
    Ok(())
}

/// Every credential a collection and everything beneath it refer to — what deleting it has to take
/// out of the store after the cascade has taken the rows.
pub fn collection_tree_keys(conn: &Connection, collection_id: &str) -> rusqlite::Result<BTreeSet<String>> {
    let mut keys = row_keys(conn, Owner::Collection, collection_id)?;
    keys_of_rows(
        conn,
        "SELECT id, auth FROM api_folders WHERE collection_id = ?1",
        collection_id,
        Owner::Folder,
        Shape::Auth,
        &mut keys,
    )?;
    keys_of_rows(
        conn,
        "SELECT id, spec FROM api_requests WHERE collection_id = ?1",
        collection_id,
        Owner::Request,
        Shape::Spec,
        &mut keys,
    )?;
    Ok(keys)
}

/// The same for one folder: itself, its descendants and every request in any of them.
pub fn folder_tree_keys(conn: &Connection, folder_id: &str) -> rusqlite::Result<BTreeSet<String>> {
    const SUBTREE: &str = "WITH RECURSIVE subtree(id) AS (
             SELECT ?1
             UNION
             SELECT f.id FROM api_folders f JOIN subtree ON f.parent_id = subtree.id
         )";
    let mut keys = BTreeSet::new();
    keys_of_rows(
        conn,
        &format!("{SUBTREE} SELECT id, auth FROM api_folders WHERE id IN (SELECT id FROM subtree)"),
        folder_id,
        Owner::Folder,
        Shape::Auth,
        &mut keys,
    )?;
    keys_of_rows(
        conn,
        &format!("{SUBTREE} SELECT id, spec FROM api_requests WHERE folder_id IN (SELECT id FROM subtree)"),
        folder_id,
        Owner::Request,
        Shape::Spec,
        &mut keys,
    )?;
    Ok(keys)
}

/// Seals one stored row in place: the rows an import or a pull wrote with literals in them, and the
/// rows the first launch after this change finds.
///
/// Read, sealed and written back under [`seal_guard`], and the write is conditional on the column
/// still holding what was read — an edit that landed in between wins, and the literal it replaced
/// is simply not this call's business any more.
pub fn seal_row(db: &Db, owner: Owner, id: &str, store: &dyn SecretStore) -> Result<Sealed, String> {
    let _guard = seal_guard();
    let mut total = Sealed::default();
    let Some((table, columns)) = columns_of(owner) else { return Ok(total) };
    let current: Vec<(&str, Shape, String)> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (column, shape) in columns {
            let raw: Option<String> = conn
                .query_row(&format!("SELECT {column} FROM {table} WHERE id = ?1"), params![id], |row| {
                    row.get(0)
                })
                .ok();
            if let Some(raw) = raw {
                out.push((*column, *shape, raw));
            }
        }
        out
    };
    let mut writes = Vec::new();
    for (column, shape, raw) in current {
        if !has_literals(&raw, shape) {
            continue;
        }
        let sealed = seal_text(&raw, shape, owner, id, store);
        total.lifted += sealed.lifted;
        total.failed += sealed.failed;
        if sealed.text != raw {
            writes.push((column, raw, sealed.text));
        }
    }
    if total.failed > 0 {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        retry_later(&conn).map_err(|e| e.to_string())?;
    }
    if writes.is_empty() {
        return Ok(total);
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for (column, before, after) in writes {
        conn.execute(
            &format!("UPDATE {table} SET {column} = ?1 WHERE id = ?2 AND {column} = ?3"),
            params![after, id, before],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Settings and open tabs
// ---------------------------------------------------------------------------

/// Applies `each` to every client certificate of an `api_settings` blob.
fn for_each_cert(settings: &mut Value, each: &mut dyn FnMut(&str, &mut Value)) {
    let Some(certs) = settings.get_mut("clientCerts").and_then(Value::as_array_mut) else { return };
    for cert in certs {
        let id = cert.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        if !id.is_empty() {
            each(&id, cert);
        }
    }
}

/// Applies `each` to every draft of an `api_open_tabs` blob, with the owner id and shape it seals
/// under. Request tabs hold a spec; collection and folder tabs hold an entity draft.
fn for_each_draft(tabs: &mut Value, each: &mut dyn FnMut(&str, Shape, &mut Value)) {
    for (list, shape) in [("tabs", Shape::Spec), ("entityTabs", Shape::EntityDraft)] {
        let Some(entries) = tabs.get_mut(list).and_then(Value::as_array_mut) else { continue };
        for entry in entries {
            let id = entry.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            if id.is_empty() {
                continue;
            }
            if let Some(draft) = entry.get_mut("draft") {
                each(&id, shape, draft);
            }
        }
    }
}

/// Seals every value inside a container of several owners — settings, open tabs — by sealing each
/// part as its own blob. Re-serialised only when something moved.
fn seal_container(
    raw: &str,
    store: &dyn SecretStore,
    walk: fn(&mut Value, &mut dyn FnMut(&str, Shape, &mut Value)),
    owner: Owner,
) -> Sealed {
    let mut outcome = Sealed { text: raw.to_string(), ..Default::default() };
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return outcome };
    let mut changed = false;
    walk(&mut value, &mut |id, shape, part| {
        let text = part.to_string();
        let sealed = seal_text(&text, shape, owner, id, store);
        outcome.keys.extend(sealed.keys);
        outcome.lifted += sealed.lifted;
        outcome.failed += sealed.failed;
        if sealed.text != text {
            if let Ok(next) = serde_json::from_str::<Value>(&sealed.text) {
                *part = next;
                changed = true;
            }
        }
    });
    if changed {
        outcome.text = serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string());
    }
    outcome
}

fn unseal_container(
    raw: &str,
    store: &dyn SecretStore,
    walk: fn(&mut Value, &mut dyn FnMut(&str, Shape, &mut Value)),
    owner: Owner,
) -> String {
    if !raw.contains(MARKER) {
        return raw.to_string();
    }
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return raw.to_string() };
    walk(&mut value, &mut |id, shape, part| {
        let text = part.to_string();
        let open = unseal_text(&text, shape, owner, id, store);
        if open != text {
            if let Ok(next) = serde_json::from_str::<Value>(&open) {
                *part = next;
            }
        }
    });
    serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

fn container_keys(raw: &str, walk: fn(&mut Value, &mut dyn FnMut(&str, Shape, &mut Value)), owner: Owner) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    if !raw.contains(MARKER) {
        return keys;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return keys };
    walk(&mut value, &mut |id, shape, part| {
        keys.extend(keys_in(&part.to_string(), shape, owner, id));
    });
    keys
}

fn cert_walk(value: &mut Value, each: &mut dyn FnMut(&str, Shape, &mut Value)) {
    for_each_cert(value, &mut |id, cert| each(id, Shape::Cert, cert));
}

fn tab_walk(value: &mut Value, each: &mut dyn FnMut(&str, Shape, &mut Value)) {
    for_each_draft(value, each);
}

/// `api_settings` with every client-certificate passphrase moved into the store.
pub fn seal_settings(raw: &str, store: &dyn SecretStore) -> Sealed {
    seal_container(raw, store, cert_walk, Owner::Cert)
}

pub fn unseal_settings(raw: &str, store: &dyn SecretStore) -> String {
    unseal_container(raw, store, cert_walk, Owner::Cert)
}

pub fn settings_keys(raw: &str) -> BTreeSet<String> {
    container_keys(raw, cert_walk, Owner::Cert)
}

/// `api_open_tabs:<workspace>` with every draft's credentials moved into the store. A request open
/// in a tab carries the same token its row does — sealing the row and not the tab would only have
/// moved the plaintext copy from one table to another.
pub fn seal_tabs(raw: &str, store: &dyn SecretStore) -> Sealed {
    seal_container(raw, store, tab_walk, Owner::Tab)
}

pub fn unseal_tabs(raw: &str, store: &dyn SecretStore) -> String {
    unseal_container(raw, store, tab_walk, Owner::Tab)
}

pub fn tabs_keys(raw: &str) -> BTreeSet<String> {
    container_keys(raw, tab_walk, Owner::Tab)
}

pub fn open_tabs_key(workspace_id: &str) -> String {
    format!("{OPEN_TABS_PREFIX}{workspace_id}")
}

/// Seals and writes one settings row, deleting the credentials the previous version referred to and
/// this one no longer does. Returns the stored text.
fn write_sealed_setting(
    db: &Db,
    key: &str,
    raw: &str,
    seal: fn(&str, &dyn SecretStore) -> Sealed,
    keys_of: fn(&str) -> BTreeSet<String>,
    store: &dyn SecretStore,
) -> Result<String, String> {
    let _guard = seal_guard();
    let sealed = seal(raw, store);
    let before = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let previous = queries::get_setting(&conn, key).map_err(|e| e.to_string())?.unwrap_or_default();
        queries::set_setting(&conn, key, &sealed.text).map_err(|e| e.to_string())?;
        if sealed.failed > 0 {
            retry_later(&conn).map_err(|e| e.to_string())?;
        }
        keys_of(&previous)
    };
    forget_stale(store, &before, &sealed.keys);
    Ok(sealed.text)
}

/// Seals one settings row where it lies — the first launch's version of [`write_sealed_setting`]. It
/// writes back only if the row still holds what it read, for the reason [`seal_row`] gives: a save
/// from the UI in between is newer, and must not be replaced by the copy this read.
fn seal_setting_in_place(
    db: &Db,
    key: &str,
    seal: fn(&str, &dyn SecretStore) -> Sealed,
    store: &dyn SecretStore,
) -> Result<Sealed, String> {
    let _guard = seal_guard();
    let raw = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_setting(&conn, key).map_err(|e| e.to_string())?
    };
    let Some(raw) = raw else { return Ok(Sealed::default()) };
    let sealed = seal(&raw, store);
    if sealed.text != raw {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE app_settings SET value = ?1 WHERE key = ?2 AND value = ?3",
            params![sealed.text, key, raw],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(sealed)
}

pub fn save_settings(db: &Db, raw: &str, store: &dyn SecretStore) -> Result<String, String> {
    write_sealed_setting(db, SETTINGS_KEY, raw, seal_settings, settings_keys, store)
}

pub fn save_open_tabs(db: &Db, workspace_id: &str, raw: &str, store: &dyn SecretStore) -> Result<(), String> {
    write_sealed_setting(db, &open_tabs_key(workspace_id), raw, seal_tabs, tabs_keys, store).map(|_| ())
}

pub fn load_setting_unsealed(
    db: &Db,
    key: &str,
    unseal: fn(&str, &dyn SecretStore) -> String,
    store: &dyn SecretStore,
) -> Result<Option<String>, String> {
    let raw = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_setting(&conn, key).map_err(|e| e.to_string())?
    };
    Ok(raw.map(|raw| unseal(&raw, store)))
}

pub fn load_settings(db: &Db, store: &dyn SecretStore) -> Result<Option<String>, String> {
    load_setting_unsealed(db, SETTINGS_KEY, unseal_settings, store)
}

pub fn load_open_tabs(db: &Db, workspace_id: &str, store: &dyn SecretStore) -> Result<Option<String>, String> {
    load_setting_unsealed(db, &open_tabs_key(workspace_id), unseal_tabs, store)
}

// ---------------------------------------------------------------------------
// Every key, for the backup
// ---------------------------------------------------------------------------

/// Every credential key the stored API data refers to. The credential store cannot be listed, so
/// the backup reconstructs its list from the rows — see `backup::vault`.
pub fn all_keys(conn: &Connection) -> Vec<String> {
    let mut keys = BTreeSet::new();
    let mut scan = |sql: &str, owner: Owner, shapes: &[Shape]| {
        let Ok(mut stmt) = conn.prepare(sql) else { return };
        let Ok(rows) = stmt.query_map([], |row| {
            let mut columns = vec![row.get::<_, String>(0)?];
            for index in 1..=shapes.len() {
                columns.push(row.get::<_, String>(index)?);
            }
            Ok(columns)
        }) else {
            return;
        };
        for row in rows.flatten() {
            let id = &row[0];
            for (index, shape) in shapes.iter().enumerate() {
                keys.extend(keys_in(&row[index + 1], *shape, owner, id));
            }
        }
    };
    scan("SELECT id, auth, variables FROM api_collections", Owner::Collection, &[Shape::Auth, Shape::Variables]);
    scan("SELECT id, auth FROM api_folders", Owner::Folder, &[Shape::Auth]);
    scan("SELECT id, spec FROM api_requests", Owner::Request, &[Shape::Spec]);
    scan("SELECT id, variables FROM api_environments", Owner::Environment, &[Shape::Variables]);

    if let Ok(Some(settings)) = queries::get_setting(conn, SETTINGS_KEY) {
        keys.extend(settings_keys(&settings));
    }
    if let Ok(mut stmt) = conn.prepare("SELECT value FROM app_settings WHERE key LIKE 'api_open_tabs:%'") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for raw in rows.flatten() {
                keys.extend(tabs_keys(&raw));
            }
        }
    }
    keys.into_iter().collect()
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/// The credentials among the auth blocks and variable lists the frontend hands over with a send:
/// every literal in a credential slot of an `AuthConfig`, and both values of every variable marked
/// secret. What [`redact_history`] scrubs out of the stored snapshot.
pub fn secret_values(auths: &[String], variables: &[String]) -> Vec<String> {
    let mut out = BTreeSet::new();
    let mut collect = |raw: &str, shape: Shape| {
        let Ok(mut value) = serde_json::from_str::<Value>(raw) else { return };
        visit_slots(shape, &mut value, Reach::Sealable, &mut |_, slot| {
            if let Some(text) = slot.as_str().filter(|text| is_literal(text)) {
                out.insert(text.to_string());
            }
        });
    };
    for raw in auths {
        collect(raw, Shape::Auth);
    }
    for raw in variables {
        collect(raw, Shape::Variables);
    }
    out.into_iter().collect()
}

fn is_sensitive_header(name: &str) -> bool {
    SENSITIVE_HEADERS.contains(&name.trim().to_ascii_lowercase().as_str())
}

/// `[[name, value], …]` — the wire shape of headers in a response and in what was sent.
fn redact_header_pairs(headers: Option<&mut Value>) {
    let Some(pairs) = headers.and_then(Value::as_array_mut) else { return };
    for pair in pairs {
        let Some(pair) = pair.as_array_mut() else { continue };
        let sensitive = pair.first().and_then(Value::as_str).is_some_and(is_sensitive_header);
        if let (true, Some(value)) = (sensitive, pair.get_mut(1)) {
            if value.as_str().is_some_and(|text| !text.is_empty()) {
                *value = Value::String(REDACTED.into());
            }
        }
    }
}

fn scrub(text: &str, secrets: &[String]) -> Option<String> {
    let mut out: Option<String> = None;
    for secret in secrets {
        let current = out.as_deref().unwrap_or(text);
        if current.contains(secret.as_str()) {
            out = Some(current.replace(secret.as_str(), REDACTED));
        }
    }
    out
}

fn scrub_strings(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => {
            if let Some(clean) = scrub(text, secrets) {
                *text = clean;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| scrub_strings(item, secrets)),
        Value::Object(map) => map.values_mut().for_each(|item| scrub_strings(item, secrets)),
        _ => {}
    }
}

/// A history entry's snapshot and URL with every credential taken out.
///
/// - `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` keep their name and lose
///   their value to `•••`, in what was sent and in what came back.
/// - The request as it was typed loses the literals in its own credential slots, and a sensitive
///   header typed in as a literal — `{{references}}` stay, they are not credentials.
/// - Every value in `secrets`, and every one found in those slots, is replaced wherever it appears:
///   in a query string an API key was added to, in a body that echoed it, in a console line.
///
/// Idempotent, which is what lets the first launch run it over history written before this existed.
pub fn redact_history(snapshot: &str, url: &str, secrets: &[String]) -> (String, String) {
    let mut values: Vec<String> = secrets.to_vec();
    let redacted = match serde_json::from_str::<Value>(snapshot) {
        Ok(mut value) => {
            if let Some(request) = value.get_mut("request") {
                visit_slots(Shape::Spec, request, Reach::Sealable, &mut |_, slot| {
                    if let Some(text) = slot.as_str().filter(|text| is_literal(text)) {
                        values.push(text.to_string());
                        *slot = Value::String(String::new());
                    }
                });
                if let Some(headers) = request.get_mut("headers").and_then(Value::as_array_mut) {
                    for header in headers {
                        let sensitive = header.get("key").and_then(Value::as_str).is_some_and(is_sensitive_header);
                        if !sensitive {
                            continue;
                        }
                        if let Some(slot) = header.get_mut("value") {
                            if slot.as_str().is_some_and(|text| !text.is_empty() && !text.contains("{{")) {
                                *slot = Value::String(REDACTED.into());
                            }
                        }
                    }
                }
            }
            if let Some(response) = value.get_mut("response") {
                redact_header_pairs(response.get_mut("headers"));
                if let Some(sent) = response.get_mut("sent") {
                    redact_header_pairs(sent.get_mut("headers"));
                }
            }
            let values = scrub_list(values.clone());
            scrub_strings(&mut value, &values);
            serde_json::to_string(&value).unwrap_or_else(|_| snapshot.to_string())
        }
        Err(_) => scrub(snapshot, &scrub_list(values.clone())).unwrap_or_else(|| snapshot.to_string()),
    };
    let url = scrub(url, &scrub_list(values)).unwrap_or_else(|| url.to_string());
    (redacted, url)
}

/// Long enough to be worth scrubbing, each once, longest first — so a token that contains another
/// secret is replaced whole instead of leaving its tail behind.
fn scrub_list(mut values: Vec<String>) -> Vec<String> {
    values.retain(|value| value.chars().count() >= MIN_SCRUB_LEN && value != REDACTED);
    values.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    values.dedup();
    values
}

// ---------------------------------------------------------------------------
// The first launch
// ---------------------------------------------------------------------------

/// What [`seal_stored`] did.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct SealReport {
    /// Rows and settings whose credentials moved into the store.
    pub sealed: usize,
    /// Credentials the store refused; they stay where they were and the next launch tries again.
    pub failed: usize,
    /// History entries rewritten without their credentials.
    pub history: usize,
    /// Nothing to do: a previous launch finished the job.
    pub skipped: bool,
}

/// Moves every credential still stored in the clear into the store, and takes them out of the
/// history written before this existed.
///
/// Idempotent — a sealed row has nothing left to lift — and cheap once done: the flag it sets on a
/// run that finished without a refusal short-circuits every later launch. A row is only rewritten
/// after its credentials are in the store (see [`seal_row`]), so a store that refuses leaves the
/// row exactly as it was, to be retried.
///
/// The flag lives in `app_settings`, which travels in the whole-install backup: restoring a backup
/// taken before this change brings back plaintext rows *and* the absence of the flag, so the next
/// launch seals them again.
pub fn seal_stored(db: &Db, store: &dyn SecretStore) -> Result<SealReport, String> {
    let mut report = SealReport::default();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if queries::get_setting(&conn, SEALED_FLAG).map_err(|e| e.to_string())?.as_deref() == Some("1") {
            report.skipped = true;
            return Ok(report);
        }
    }

    // Which rows hold a literal at all. Most do not, and only those are opened for writing.
    let candidates: Vec<(Owner, String)> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for owner in [Owner::Collection, Owner::Folder, Owner::Request, Owner::Environment] {
            let Some((table, columns)) = columns_of(owner) else { continue };
            let names: Vec<&str> = columns.iter().map(|(column, _)| *column).collect();
            let mut stmt = conn
                .prepare(&format!("SELECT id, {} FROM {table}", names.join(", ")))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    let mut values = vec![row.get::<_, String>(0)?];
                    for index in 1..=names.len() {
                        values.push(row.get::<_, String>(index)?);
                    }
                    Ok(values)
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let row = row.map_err(|e| e.to_string())?;
                if columns.iter().enumerate().any(|(index, (_, shape))| has_literals(&row[index + 1], *shape)) {
                    out.push((owner, row[0].clone()));
                }
            }
        }
        out
    };
    for (owner, id) in candidates {
        let sealed = seal_row(db, owner, &id, store)?;
        if sealed.lifted > 0 {
            report.sealed += 1;
        }
        report.failed += sealed.failed;
    }

    // The two settings families.
    let tab_keys: Vec<String> = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT key FROM app_settings WHERE key LIKE 'api_open_tabs:%'")
            .map_err(|e| e.to_string())?;
        let keys = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        keys
    };
    for (key, seal) in std::iter::once((SETTINGS_KEY.to_string(), seal_settings as fn(&str, &dyn SecretStore) -> Sealed))
        .chain(tab_keys.into_iter().map(|key| (key, seal_tabs as fn(&str, &dyn SecretStore) -> Sealed)))
    {
        let sealed = seal_setting_in_place(db, &key, seal, store)?;
        report.failed += sealed.failed;
        if sealed.lifted > 0 {
            report.sealed += 1;
        }
    }

    report.history = redact_stored_history(db, store)?;

    if report.failed == 0 {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, SEALED_FLAG, "1").map_err(|e| e.to_string())?;
    }
    Ok(report)
}

/// The credentials history could hold: the auth blocks of every collection and folder, and the
/// variables of every collection and environment, read back through the store.
fn stored_secret_values(db: &Db, store: &dyn SecretStore) -> Result<Vec<String>, String> {
    let (collections, folders, environments, requests) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let read = |sql: &str| -> rusqlite::Result<Vec<Vec<String>>> {
            let mut stmt = conn.prepare(sql)?;
            let count = stmt.column_count();
            let rows = stmt
                .query_map([], |row| {
                    (0..count).map(|index| row.get::<_, String>(index)).collect::<rusqlite::Result<Vec<String>>>()
                })?
                .collect::<rusqlite::Result<Vec<_>>>();
            rows
        };
        (
            read("SELECT id, auth, variables FROM api_collections").map_err(|e| e.to_string())?,
            read("SELECT id, auth FROM api_folders").map_err(|e| e.to_string())?,
            read("SELECT id, variables FROM api_environments").map_err(|e| e.to_string())?,
            read("SELECT id, spec FROM api_requests").map_err(|e| e.to_string())?,
        )
    };
    let mut auths = Vec::new();
    let mut variables = Vec::new();
    for row in collections {
        auths.push(unseal_text(&row[1], Shape::Auth, Owner::Collection, &row[0], store));
        variables.push(unseal_text(&row[2], Shape::Variables, Owner::Collection, &row[0], store));
    }
    for row in folders {
        auths.push(unseal_text(&row[1], Shape::Auth, Owner::Folder, &row[0], store));
    }
    for row in environments {
        variables.push(unseal_text(&row[1], Shape::Variables, Owner::Environment, &row[0], store));
    }
    let mut values = secret_values(&auths, &variables);
    // A request carries credentials of its own — its auth block, an MQTT password, an
    // `Authorization` header typed in as itself. Leaving them out is how a request's Basic
    // password reached a model through `api_load_tree` (2026-11-25): nothing knew it was one.
    for row in requests {
        let spec = unseal_text(&row[1], Shape::Spec, Owner::Request, &row[0], store);
        let Ok(mut spec) = serde_json::from_str::<Value>(&spec) else { continue };
        model_slots(Shape::Spec, &mut spec, Reach::Sealable, &mut |path, slot| {
            if let Some(text) = slot.as_str().filter(|text| shown_masked(path, text)) {
                values.push(text.to_string());
            }
        });
    }
    Ok(values)
}

// ---------------------------------------------------------------------------
// What a model is shown
// ---------------------------------------------------------------------------
//
// The window needs the credentials back in place to send a request; a model never does — it sends
// one through `http_request`, where the app puts them in. So everything the API client hands a
// model (`app_gateway`) goes through `mask_for_model`, which blanks the slots by where they are,
// not by what they hold: a list of known values misses the ones nobody listed, and anything
// shorter than `MIN_SCRUB_LEN`. And since a model that reads a record sends it back whole to change
// one field, `restore_masked` puts the stored credential back wherever the mask returns, so the
// mask is never what gets saved.

/// The slots of one blob a model is not shown: the ones sealing knows, and — in a request — a
/// header whose value is a credential whatever it looks like.
fn model_slots(shape: Shape, value: &mut Value, reach: Reach, visit: &mut Visit<'_>) {
    visit_slots(shape, value, reach, visit);
    if shape != Shape::Spec {
        return;
    }
    let Some(headers) = value.get_mut("headers").and_then(Value::as_array_mut) else { return };
    let mut seen: HashMap<String, usize> = HashMap::new();
    for header in headers {
        let Some(key) = header.get("key").and_then(Value::as_str).map(|key| key.trim().to_ascii_lowercase()) else { continue };
        if !is_sensitive_header(&key) {
            continue;
        }
        let nth = seen.entry(key.clone()).or_default();
        let path = format!("header.{key}.{nth}");
        *nth += 1;
        if let Some(slot) = header.get_mut("value") {
            string_slot(&path, slot, visit);
        }
    }
}

/// Whether the text in a slot is hidden from a model: a credential typed in as itself. A header
/// that only carries a variable (`Bearer {{token}}`) holds none.
fn shown_masked(path: &str, text: &str) -> bool {
    is_literal(text) && text != REDACTED && !(path.starts_with("header.") && text.contains("{{"))
}

/// The keys the API client's records keep a credential blob under.
fn blob_shape(key: &str) -> Option<Shape> {
    match key {
        "auth" => Some(Shape::Auth),
        "variables" => Some(Shape::Variables),
        "spec" => Some(Shape::Spec),
        _ => None,
    }
}

/// Runs `each` over a record's blob — JSON text, as a row stores it, or already parsed — and
/// writes it back when `each` says it changed.
fn with_blob(item: &mut Value, each: &mut dyn FnMut(&mut Value) -> bool) {
    match item {
        Value::String(raw) => {
            let Ok(mut parsed) = serde_json::from_str::<Value>(raw) else { return };
            if !(parsed.is_object() || parsed.is_array()) {
                return;
            }
            if each(&mut parsed) {
                if let Ok(text) = serde_json::to_string(&parsed) {
                    *raw = text;
                }
            }
        }
        Value::Object(_) | Value::Array(_) => {
            each(item);
        }
        _ => {}
    }
}

/// `scheme://user:password@host` with the password masked, or `None` when there is none.
fn mask_url_password(url: &str) -> Option<String> {
    let start = url.find("://")? + 3;
    let rest = &url[start..];
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let at = authority.rfind('@')?;
    let colon = authority[..at].find(':')?;
    let password = &authority[colon + 1..at];
    if password.is_empty() || password == REDACTED || password.contains("{{") {
        return None;
    }
    Some(format!("{}{}:{REDACTED}{}", &url[..start], &authority[..colon], &rest[at..]))
}

/// An answer of the API client's as a model may read it: every credential slot of every record in
/// it — a collection's, a folder's or a request's auth, a secret variable, a sensitive header, a
/// certificate's passphrase, a password inside a URL — reads `•••`.
pub(crate) fn mask_for_model(value: &mut Value) {
    // A blob handed over as text — the open tabs with their drafts, the settings with their
    // certificates — is read as what it is.
    if let Value::String(raw) = value {
        let Ok(mut parsed) = serde_json::from_str::<Value>(raw) else { return };
        if parsed.is_object() || parsed.is_array() {
            let before = parsed.clone();
            mask_records(&mut parsed);
            if parsed != before {
                if let Ok(text) = serde_json::to_string(&parsed) {
                    *raw = text;
                }
            }
        }
        return;
    }
    mask_records(value);
}

fn mask_records(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(mask_records),
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if let Some(shape) = blob_shape(key) {
                    with_blob(item, &mut |blob| {
                        let mut changed = false;
                        model_slots(shape, blob, Reach::Sealable, &mut |path, slot| {
                            if slot.as_str().is_some_and(|text| shown_masked(path, text)) {
                                *slot = Value::String(REDACTED.into());
                                changed = true;
                            }
                        });
                        // The URL inside a request's spec.
                        if let Some(masked) = blob.get("url").and_then(Value::as_str).and_then(mask_url_password) {
                            blob["url"] = Value::String(masked);
                            changed = true;
                        }
                        changed
                    });
                } else if key == "draft" {
                    // An open request tab's unsaved spec: its MQTT password and its headers (the
                    // auth and the variables inside it are met on the way down).
                    with_blob(item, &mut |blob| {
                        let mut changed = false;
                        model_slots(Shape::Spec, blob, Reach::Sealable, &mut |path, slot| {
                            if slot.as_str().is_some_and(|text| shown_masked(path, text)) {
                                *slot = Value::String(REDACTED.into());
                                changed = true;
                            }
                        });
                        changed
                    });
                } else if key == "passphrase" {
                    if item.as_str().is_some_and(|text| is_literal(text) && text != REDACTED) {
                        *item = Value::String(REDACTED.into());
                    }
                } else if key == "url" {
                    if let Some(masked) = item.as_str().and_then(mask_url_password) {
                        *item = Value::String(masked);
                    }
                }
                mask_records(item);
            }
        }
        _ => {}
    }
}

/// The credentials a stored record holds, by slot: what [`restore_masked`] puts back.
fn stored_slots(db: &Db, store: &dyn SecretStore, shape: Shape, id: &str) -> HashMap<String, String> {
    let owners: &[Owner] = match shape {
        Shape::Spec => &[Owner::Request],
        Shape::Auth => &[Owner::Collection, Owner::Folder],
        Shape::Variables => &[Owner::Collection, Owner::Environment],
        _ => &[],
    };
    let mut slots = HashMap::new();
    if id.is_empty() {
        return slots;
    }
    for owner in owners {
        let Some((table, columns)) = columns_of(*owner) else { continue };
        let Some((column, _)) = columns.iter().find(|(_, of)| *of == shape) else { continue };
        let raw: Option<String> = db.0.lock().ok().and_then(|conn| conn.query_row(&format!("SELECT {column} FROM {table} WHERE id = ?1"), params![id], |row| row.get(0)).ok());
        let Some(raw) = raw else { continue };
        let text = unseal_text(&raw, shape, *owner, id, store);
        let Ok(mut value) = serde_json::from_str::<Value>(&text) else { continue };
        model_slots(shape, &mut value, Reach::Any, &mut |path, slot| {
            if let Some(text) = slot.as_str().filter(|text| !text.is_empty() && *text != REDACTED && !is_marker(text)) {
                slots.insert(path.to_string(), text.to_string());
            }
        });
        break;
    }
    slots
}

/// What a model sends to the API client, before it is saved: wherever a credential slot holds the
/// mask it was shown, the stored credential goes back in its place. A mask with nothing behind it
/// — a new record, a slot that had no credential, a URL's password — is refused, because saving it
/// would replace a credential with three dots.
pub(crate) fn restore_masked(db: &Db, store: &dyn SecretStore, value: &mut Value) -> Result<(), String> {
    const WHY: &str = "holds the mask ••• where a credential goes, and there is no stored credential to keep in its place. Send it back only on the record you read it from, or put a {{variable}} there";
    match value {
        Value::Array(items) => items.iter_mut().try_for_each(|item| restore_masked(db, store, item)),
        Value::Object(map) => {
            let id = map.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            for (key, item) in map.iter_mut() {
                if let Some(shape) = blob_shape(key) {
                    let mut lost: Option<String> = None;
                    with_blob(item, &mut |blob| {
                        let mut masked = false;
                        model_slots(shape, blob, Reach::Any, &mut |_, slot| masked |= slot.as_str() == Some(REDACTED));
                        if blob.get("url").and_then(Value::as_str).is_some_and(|url| url.contains(&format!(":{REDACTED}@"))) {
                            lost = Some("url".into());
                        }
                        if !masked {
                            return false;
                        }
                        let stored = stored_slots(db, store, shape, &id);
                        model_slots(shape, blob, Reach::Any, &mut |path, slot| {
                            if slot.as_str() == Some(REDACTED) {
                                match stored.get(path) {
                                    Some(kept) => *slot = Value::String(kept.clone()),
                                    None => lost = Some(path.to_string()),
                                }
                            }
                        });
                        true
                    });
                    if let Some(path) = lost {
                        return Err(format!("{key}.{path} {WHY}"));
                    }
                } else if (key == "passphrase" && item.as_str() == Some(REDACTED)) || (key == "url" && item.as_str().is_some_and(|url| url.contains(&format!(":{REDACTED}@")))) {
                    return Err(format!("{key} {WHY}"));
                } else if key == "value" && item.as_str().is_some_and(|raw| raw.contains(&format!("\"{REDACTED}\"")) && serde_json::from_str::<Value>(raw).is_ok_and(|v| v.is_object())) {
                    // The open tabs or the settings, whole, as text: nothing here says which
                    // record each mask came from.
                    return Err(format!("{key} {WHY}"));
                }
                restore_masked(db, store, item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Every stored API credential, longest first — what `cf http` scrubs from a response before an agent
/// sees it (`agentcli::vault`), the same list stored history is redacted with.
pub(crate) fn stored_secrets(db: &Db) -> Vec<String> {
    stored_secret_values(db, &os_store()).map(scrub_list).unwrap_or_default()
}

/// Rewrites stored history without its credentials, a page at a time so the database lock is never
/// held across the parsing. Conditional on the snapshot being unchanged since it was read.
fn redact_stored_history(db: &Db, store: &dyn SecretStore) -> Result<usize, String> {
    const PAGE: i64 = 50;
    let secrets = stored_secret_values(db, store)?;
    let mut after: i64 = 0;
    let mut rewritten = 0;
    loop {
        let page: Vec<(i64, String, String, String)> = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT rowid, id, url, snapshot FROM api_history WHERE rowid > ?1 ORDER BY rowid LIMIT ?2")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![after, PAGE], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        let Some(last) = page.last().map(|row| row.0) else { break };
        after = last;
        let mut writes = Vec::new();
        for (_, id, url, snapshot) in page {
            let (clean, clean_url) = redact_history(&snapshot, &url, &secrets);
            if clean != snapshot || clean_url != url {
                writes.push((id, snapshot, clean, clean_url));
            }
        }
        if writes.is_empty() {
            continue;
        }
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        for (id, before, clean, clean_url) in writes {
            rewritten += conn
                .execute(
                    "UPDATE api_history SET snapshot = ?1, url = ?2 WHERE id = ?3 AND snapshot = ?4",
                    params![clean, clean_url, id, before],
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(rewritten)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_db() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Flow', '', '', 0, '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();
        Db::new(conn)
    }

    fn text(db: &Db, sql: &str) -> String {
        db.0.lock().unwrap().query_row(sql, [], |row| row.get(0)).unwrap()
    }

    const SPEC: &str = r#"{"url":"https://api.example.com","auth":{"type":"bearer","bearer":{"token":"tok-123456"},"basic":{"username":"u","password":"{{pass}}"}},"mqtt":{"password":"mq-secret"}}"#;

    /// The tree a model reads through the app's gateway: two requests with Basic auth of their
    /// own (one sealed, one still a literal in its row), a folder with a bearer token, a secret
    /// variable and a short password nothing would list.
    fn tree_with_credentials(db: &Db, store: &MemoryStore) -> Value {
        let qa = r#"{"url":"https://qa.example.com/v1","headers":[{"key":"Accept","value":"application/json"},{"key":"Authorization","value":"Basic cWE6cWEtcGFzcw=="},{"key":"Cookie","value":"sid={{session}}"}],"auth":{"type":"basic","basic":{"username":"svc-qa","password":"qa-Passw0rd"}}}"#;
        let prod = r#"{"url":"https://admin:ur1-pass@prod.example.com/v1","auth":{"type":"basic","basic":{"username":"svc-prod","password":"x1"}}}"#;
        let sealed = seal_text(qa, Shape::Spec, Owner::Request, "qa", store);
        let conn = db.0.lock().unwrap();
        conn.execute(
            "INSERT INTO api_collections (id, workspace_id, name, auth, variables, created_at, updated_at) VALUES ('c1', 'w1', 'C', '{}', ?1, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')",
            params![r#"[{"id":"v1","key":"apiKey","initialValue":"key-777777","currentValue":"","secret":true},{"id":"v2","key":"host","initialValue":"qa.example.com","currentValue":""}]"#],
        )
        .unwrap();
        conn.execute("INSERT INTO api_folders (id, collection_id, name, auth, created_at, updated_at) VALUES ('f1', 'c1', 'F', ?1, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')", params![r#"{"type":"bearer","bearer":{"token":"tok-folder-1"}}"#]).unwrap();
        for (id, spec) in [("qa", sealed.text.as_str()), ("prod", prod)] {
            conn.execute("INSERT INTO api_requests (id, collection_id, folder_id, name, url, spec, created_at, updated_at) VALUES (?1, 'c1', NULL, ?1, '', ?2, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')", params![id, spec]).unwrap();
        }
        let mut tree = super::super::api_queries::load_tree(&conn, "w1").unwrap();
        drop(conn);
        unseal_tree(&mut tree, store);
        serde_json::to_value(&tree).unwrap()
    }

    /// The leak of 2026-11-25: `api_load_tree` hands the window the credentials back in place, and
    /// a model calling it through the gateway read two requests' Basic passwords. Nothing a model
    /// is shown holds one now — wherever it sat, however short it is.
    #[test]
    fn a_model_reads_the_tree_without_a_single_credential() {
        let (db, store) = (fresh_db(), MemoryStore::default());
        let mut tree = tree_with_credentials(&db, &store);
        let before = tree.to_string();
        for secret in ["qa-Passw0rd", "x1\"", "cWE6cWEtcGFzcw==", "ur1-pass", "tok-folder-1", "key-777777"] {
            assert!(before.contains(&secret.replace('"', "\\\"")), "the window's tree has {secret}");
        }

        mask_for_model(&mut tree);
        let shown = tree.to_string();
        for secret in ["qa-Passw0rd", "cWE6cWEtcGFzcw==", "ur1-pass", "tok-folder-1", "key-777777"] {
            assert!(!shown.contains(secret), "{secret} reached the model: {shown}");
        }
        let spec = |id: &str| -> Value {
            let row = tree["requests"].as_array().unwrap().iter().find(|r| r["id"] == id).unwrap();
            serde_json::from_str(row["spec"].as_str().unwrap()).unwrap()
        };
        // A two-character password is masked like any other: by where it is, not by what it is.
        assert_eq!(spec("prod")["auth"]["basic"]["password"], REDACTED);
        assert_eq!(spec("prod")["url"], format!("https://admin:{REDACTED}@prod.example.com/v1"));
        // What is not a credential stays readable: who it logs in as, a plain header, a variable
        // nobody marked secret, and a header that only points at one.
        assert_eq!(spec("qa")["auth"]["basic"]["username"], "svc-qa");
        assert_eq!(spec("qa")["headers"][0]["value"], "application/json");
        assert_eq!(spec("qa")["headers"][1]["value"], REDACTED);
        assert_eq!(spec("qa")["headers"][2]["value"], "sid={{session}}");
        assert!(shown.contains("qa.example.com"));
        // Masking twice changes nothing.
        let once = tree.clone();
        mask_for_model(&mut tree);
        assert_eq!(tree, once);
    }

    /// The values the gateway scrubs out of every other answer — a response that echoes a
    /// password, an error that quotes a header — now include the requests' own.
    #[test]
    fn a_requests_own_credentials_are_among_the_ones_scrubbed_everywhere() {
        let (db, store) = (fresh_db(), MemoryStore::default());
        tree_with_credentials(&db, &store);
        let known = stored_secret_values(&db, &store).unwrap();
        for secret in ["qa-Passw0rd", "Basic cWE6cWEtcGFzcw==", "tok-folder-1", "key-777777", "x1"] {
            assert!(known.iter().any(|k| k == secret), "{secret} is not in {known:?}");
        }
        assert!(!known.iter().any(|k| k.contains("{{")), "a reference is not a credential: {known:?}");
    }

    /// A model that reads a request and saves it back to change its URL sends the mask where the
    /// password was: the password it had is what gets saved.
    #[test]
    fn a_record_saved_back_with_the_mask_keeps_its_credential() {
        let (db, store) = (fresh_db(), MemoryStore::default());
        let mut tree = tree_with_credentials(&db, &store);
        mask_for_model(&mut tree);
        let mut request = tree["requests"].as_array().unwrap().iter().find(|r| r["id"] == "qa").unwrap().clone();
        let mut spec: Value = serde_json::from_str(request["spec"].as_str().unwrap()).unwrap();
        spec["url"] = json_text("https://qa.example.com/v2");
        request["spec"] = json_text(&spec.to_string());
        let mut args = serde_json::json!({ "request": request });
        restore_masked(&db, &store, &mut args).unwrap();
        let saved: Value = serde_json::from_str(args["request"]["spec"].as_str().unwrap()).unwrap();
        assert_eq!(saved["url"], "https://qa.example.com/v2");
        assert_eq!(saved["auth"]["basic"]["password"], "qa-Passw0rd");
        assert_eq!(saved["headers"][1]["value"], "Basic cWE6cWEtcGFzcw==");

        // A collection's secret variable and a folder's token come back the same way.
        let mut collection = serde_json::json!({ "collection": tree["collections"][0].clone() });
        restore_masked(&db, &store, &mut collection).unwrap();
        assert!(collection["collection"]["variables"].as_str().unwrap().contains("key-777777"));
        let mut folder = serde_json::json!({ "folder": tree["folders"][0].clone() });
        restore_masked(&db, &store, &mut folder).unwrap();
        assert!(folder["folder"]["auth"].as_str().unwrap().contains("tok-folder-1"));

        // A mask with nothing behind it is refused rather than saved: a new request, and a URL.
        let mut fresh = serde_json::json!({ "request": { "id": "nuevo", "spec": format!(r#"{{"auth":{{"basic":{{"username":"u","password":"{REDACTED}"}}}}}}"#) } });
        assert!(restore_masked(&db, &store, &mut fresh).unwrap_err().contains("no stored credential"));
        let mut url = serde_json::json!({ "request": { "id": "prod", "spec": format!(r#"{{"url":"https://admin:{REDACTED}@prod.example.com"}}"#) } });
        assert!(restore_masked(&db, &store, &mut url).is_err());
        // Nothing masked, nothing touched.
        let mut plain = serde_json::json!({ "request": { "id": "qa", "spec": r#"{"url":"https://x","auth":{"basic":{"username":"u","password":"nueva-clave"}}}"# } });
        let untouched = plain.clone();
        restore_masked(&db, &store, &mut plain).unwrap();
        assert_eq!(plain, untouched);
    }

    /// The open tabs and the settings reach a model as one string of JSON each.
    #[test]
    fn the_open_tabs_and_the_settings_are_masked_inside_their_text() {
        let mut tabs = json_text(r#"{"tabs":[{"id":"t1","draft":{"url":"https://x","headers":[{"key":"Authorization","value":"Bearer live-token-1"}],"auth":{"type":"basic","basic":{"username":"u","password":"tab-pass-1"}},"mqtt":{"password":"mq-pass-1"}}}],"entityTabs":[{"id":"c1","draft":{"auth":{"type":"bearer","bearer":{"token":"ent-token-1"}},"variables":[{"id":"v","key":"k","initialValue":"var-secret-1","secret":true}]}}]}"#);
        mask_for_model(&mut tabs);
        let shown = tabs.as_str().unwrap();
        for secret in ["live-token-1", "tab-pass-1", "mq-pass-1", "ent-token-1", "var-secret-1"] {
            assert!(!shown.contains(secret), "{secret} reached the model: {shown}");
        }
        assert!(shown.contains(r#""username":"u""#));

        let mut settings = json_text(r#"{"clientCerts":[{"id":"k1","host":"api.example.com","passphrase":"cert-pass-1"}],"timeout":30}"#);
        mask_for_model(&mut settings);
        assert!(!settings.as_str().unwrap().contains("cert-pass-1") && settings.as_str().unwrap().contains("api.example.com"));
        // Text that is not a record is left exactly as it was.
        let mut note = json_text("una nota cualquiera con ••• dentro");
        mask_for_model(&mut note);
        assert_eq!(note, "una nota cualquiera con ••• dentro");

        // Saved back with the masks in it, either would lose every credential it held.
        let (db, store) = (fresh_db(), MemoryStore::default());
        let mut save = serde_json::json!({ "workspaceId": "w1", "value": tabs });
        assert!(restore_masked(&db, &store, &mut save).is_err());
    }

    fn json_text(text: &str) -> Value {
        Value::String(text.to_string())
    }

    #[test]
    fn references_are_not_credentials() {
        assert!(is_reference("{{token}}"));
        assert!(is_reference(" {{user}}:{{pass}} "));
        assert!(!is_reference("Bearer {{token}}"), "a literal word outside the braces");
        assert!(!is_reference("sk-live-123"));
        assert!(!is_reference("{{}}"), "an empty name points at nothing");
        assert!(!is_reference("{{a{b}}"));
        assert!(!is_literal("{{token}}"));
        assert!(!is_literal(""));
        assert!(!is_literal("cf-keychain:auth.bearer.token"));
        assert!(is_literal("hunter2"));
    }

    /// Sealing, then unsealing with the same store, gives the row back exactly — the re-injection
    /// every read depends on.
    #[test]
    fn a_sealed_spec_unseals_to_what_it_was() {
        let store = MemoryStore::default();
        let sealed = seal_text(SPEC, Shape::Spec, Owner::Request, "r1", &store);

        assert!(!sealed.text.contains("tok-123456"));
        assert!(!sealed.text.contains("mq-secret"));
        assert!(sealed.text.contains("cf-keychain:auth.bearer.token"));
        // A reference is not a credential and stays in the row.
        assert!(sealed.text.contains("{{pass}}"));
        assert_eq!(sealed.lifted, 2);
        assert_eq!(
            store.values.borrow().get("api-secret:request:r1:auth.bearer.token").map(String::as_str),
            Some("tok-123456")
        );

        let open: Value = serde_json::from_str(&unseal_text(&sealed.text, Shape::Spec, Owner::Request, "r1", &store)).unwrap();
        let original: Value = serde_json::from_str(SPEC).unwrap();
        assert_eq!(open, original);
    }

    #[test]
    fn sealing_twice_changes_nothing_the_second_time() {
        let store = MemoryStore::default();
        let first = seal_text(SPEC, Shape::Spec, Owner::Request, "r1", &store);
        let second = seal_text(&first.text, Shape::Spec, Owner::Request, "r1", &store);
        assert_eq!(second.text, first.text);
        assert_eq!(second.lifted, 0);
        assert_eq!(second.keys, first.keys, "markers already there still count as referenced");
    }

    /// A store that says no must not cost the user their credential.
    #[test]
    fn a_refused_value_stays_where_it_was() {
        let store = MemoryStore { limit: Some(3), ..Default::default() };
        let sealed = seal_text(SPEC, Shape::Spec, Owner::Request, "r1", &store);
        assert_eq!(sealed.failed, 2);
        assert!(sealed.text.contains("tok-123456"));
        assert_eq!(sealed.text, SPEC, "nothing moved, so nothing is rewritten");
    }

    /// A marker whose credential cannot be read right now must survive the round trip untouched,
    /// or the next save of that row would write an empty value over the real one.
    #[test]
    fn an_unreadable_store_keeps_the_marker() {
        let store = MemoryStore::default();
        let sealed = seal_text(SPEC, Shape::Spec, Owner::Request, "r1", &store);
        let locked = MemoryStore { unreadable: true, ..Default::default() };
        let open = unseal_text(&sealed.text, Shape::Spec, Owner::Request, "r1", &locked);
        assert!(open.contains("cf-keychain:auth.bearer.token"));
        // And a missing one reads back as empty rather than as a marker.
        let empty = MemoryStore::default();
        let open = unseal_text(&sealed.text, Shape::Spec, Owner::Request, "r1", &empty);
        assert!(!open.contains(MARKER));
    }

    /// Only variables marked secret are lifted, and a variable's credential follows its id.
    #[test]
    fn secret_variables_are_sealed_by_id() {
        let store = MemoryStore::default();
        let raw = r#"[{"id":"v1","key":"apiKey","initialValue":"AKIA-REAL","currentValue":"live","secret":true},
                     {"id":"v2","key":"baseUrl","initialValue":"https://api.example.com","currentValue":"","secret":false}]"#;
        let sealed = seal_text(raw, Shape::Variables, Owner::Environment, "e1", &store);
        assert!(!sealed.text.contains("AKIA-REAL"));
        assert!(!sealed.text.contains("\"live\""));
        assert!(sealed.text.contains("https://api.example.com"));
        assert!(sealed.keys.contains("api-secret:environment:e1:var.v1.initialValue"));
        assert!(sealed.keys.contains("api-secret:environment:e1:var.v1.currentValue"));
    }

    #[test]
    fn a_long_value_is_split_where_the_store_caps_it_and_read_back_whole() {
        let store = Chunked(MemoryStore { limit: Some(CHUNK_CHARS), ..Default::default() });
        let long: String = "x".repeat(CHUNK_CHARS * 2 + 7);
        store.set("k", &long).unwrap();
        assert_eq!(store.get("k").unwrap().as_deref(), Some(long.as_str()));
        assert_eq!(store.0.values.borrow().get("k").map(String::as_str), Some("cf-chunks:3"));
        // Replaced by a short one, the old pieces go.
        store.set("k", "short").unwrap();
        assert_eq!(store.get("k").unwrap().as_deref(), Some("short"));
        assert!(store.0.values.borrow().keys().all(|key| !key.starts_with("k#")));
        store.set("k", &long).unwrap();
        store.delete("k").unwrap();
        assert!(store.0.values.borrow().is_empty());
    }

    /// The migration: keychain first, then the row; a second run does nothing; and the row reads
    /// back through the store as it was.
    #[test]
    fn stored_rows_are_sealed_once_and_read_back_whole() {
        let db = fresh_db();
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch(&format!(
                r#"
                INSERT INTO api_collections (id, workspace_id, name, auth, variables, created_at, updated_at)
                    VALUES ('c1', 'w1', 'C', '{{"type":"basic","basic":{{"username":"u","password":"pw-9999"}}}}',
                            '[{{"id":"v1","key":"k","initialValue":"sec-1111","currentValue":"","secret":true}}]',
                            '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
                INSERT INTO api_requests (id, collection_id, folder_id, name, url, spec, created_at, updated_at)
                    VALUES ('r1', 'c1', NULL, 'R', '', '{SPEC}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
                INSERT INTO api_history (id, workspace_id, request_id, name, protocol, method, url, status, duration_ms, size_bytes, snapshot, created_at)
                    VALUES ('h1', 'w1', 'r1', 'R', 'http', 'GET', 'https://api.example.com/?key=sec-1111', 200, 1, 1,
                            '{{"request":{{"auth":{{"bearer":{{"token":"tok-123456"}}}}}},"response":{{"sent":{{"headers":[["Authorization","Bearer tok-123456"]]}}}}}}',
                            '2026-01-01T00:00:00+00:00');
                INSERT OR REPLACE INTO app_settings (key, value)
                    VALUES ('api_settings', '{{"clientCerts":[{{"id":"cert1","host":"api.example.com","passphrase":"p12-pass"}}]}}');
                "#
            ))
            .unwrap();
        }
        let store = MemoryStore::default();

        let report = seal_stored(&db, &store).unwrap();
        assert_eq!(report.failed, 0);
        assert!(report.sealed >= 3);
        assert_eq!(report.history, 1);

        let spec = text(&db, "SELECT spec FROM api_requests WHERE id = 'r1'");
        assert!(!spec.contains("tok-123456") && !spec.contains("mq-secret"));
        let auth = text(&db, "SELECT auth FROM api_collections WHERE id = 'c1'");
        assert!(!auth.contains("pw-9999"));
        let variables = text(&db, "SELECT variables FROM api_collections WHERE id = 'c1'");
        assert!(!variables.contains("sec-1111"));
        let settings = text(&db, "SELECT value FROM app_settings WHERE key = 'api_settings'");
        assert!(!settings.contains("p12-pass"));
        let history = text(&db, "SELECT snapshot FROM api_history WHERE id = 'h1'");
        assert!(!history.contains("tok-123456"));
        assert!(history.contains("Authorization"), "the header keeps its name");
        assert!(!text(&db, "SELECT url FROM api_history WHERE id = 'h1'").contains("sec-1111"));

        // Re-injection: what the tree hands the frontend is what was there before.
        let mut tree = api_tree(&db);
        unseal_tree(&mut tree, &store);
        assert!(tree.requests[0].spec.contains("tok-123456"));
        assert!(tree.collections[0].auth.contains("pw-9999"));
        assert!(load_settings(&db, &store).unwrap().unwrap().contains("p12-pass"));

        // The backup can name every one of them.
        let keys = all_keys(&db.0.lock().unwrap());
        for key in [
            "api-secret:request:r1:auth.bearer.token",
            "api-secret:request:r1:mqtt.password",
            "api-secret:collection:c1:auth.basic.password",
            "api-secret:collection:c1:var.v1.initialValue",
            "api-secret:cert:cert1:passphrase",
        ] {
            assert!(keys.contains(&key.to_string()), "{key} missing from {keys:?}");
        }

        // Done once; the next launch does not even look.
        assert!(seal_stored(&db, &store).unwrap().skipped);
    }

    /// A store that refuses leaves the rows as they were and the flag unset, so the next launch
    /// tries again rather than calling the job done.
    #[test]
    fn a_refusing_store_leaves_the_migration_to_run_again() {
        let db = fresh_db();
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch(&format!(
                r#"
                INSERT INTO api_collections (id, workspace_id, name, created_at, updated_at)
                    VALUES ('c1', 'w1', 'C', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
                INSERT INTO api_requests (id, collection_id, folder_id, name, url, spec, created_at, updated_at)
                    VALUES ('r1', 'c1', NULL, 'R', '', '{SPEC}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
                "#
            ))
            .unwrap();
        }
        let store = MemoryStore { limit: Some(2), ..Default::default() };
        let report = seal_stored(&db, &store).unwrap();
        assert!(report.failed > 0);
        assert!(text(&db, "SELECT spec FROM api_requests WHERE id = 'r1'").contains("tok-123456"));
        assert!(!seal_stored(&db, &MemoryStore::default()).unwrap().skipped);
    }

    #[test]
    fn open_tabs_are_sealed_per_tab_and_closed_tabs_take_their_keys() {
        let db = fresh_db();
        let store = MemoryStore::default();
        let tabs = format!(
            r#"{{"version":2,"tabs":[{{"id":"t1","draft":{SPEC}}}],"entityTabs":[{{"id":"t2","draft":{{"auth":{{"bearer":{{"token":"ent-7777"}}}},"variables":[]}}}}],"order":["t1","t2"],"activeTabId":"t1"}}"#
        );
        save_open_tabs(&db, "w1", &tabs, &store).unwrap();
        let stored = text(&db, "SELECT value FROM app_settings WHERE key = 'api_open_tabs:w1'");
        assert!(!stored.contains("tok-123456") && !stored.contains("ent-7777"));
        let open = load_open_tabs(&db, "w1", &store).unwrap().unwrap();
        assert!(open.contains("tok-123456") && open.contains("ent-7777"));

        // The request tab closes: its credentials leave the store with it.
        let fewer = r#"{"version":2,"tabs":[],"entityTabs":[],"order":[],"activeTabId":null}"#;
        save_open_tabs(&db, "w1", fewer, &store).unwrap();
        assert!(store.values.borrow().keys().all(|key| !key.starts_with("api-secret:tab:")));
    }

    #[test]
    fn history_keeps_header_names_and_references_and_loses_values() {
        let snapshot = r#"{
            "request": {
                "headers": [
                    {"key": "Authorization", "value": "Bearer typed-in-token"},
                    {"key": "Cookie", "value": "session={{sid}}"},
                    {"key": "X-Trace", "value": "abc"}
                ],
                "auth": {"type": "apikey", "apikey": {"key": "X-API-Key", "value": "key-5555", "addTo": "query"}}
            },
            "response": {
                "headers": [["Set-Cookie", "session=s3cr3t-cookie"], ["Content-Type", "application/json"]],
                "sent": {
                    "url": "https://api.example.com/v1/orders?X-API-Key=key-5555",
                    "headers": [["Authorization", "Bearer typed-in-token"], ["Proxy-Authorization", "Basic abc"]],
                    "body_preview": "{\"password\":\"env-secret-8888\"}"
                },
                "body_text": "echo env-secret-8888"
            }
        }"#;
        let (clean, url) = redact_history(
            snapshot,
            "https://api.example.com/v1/orders?X-API-Key=key-5555",
            &["env-secret-8888".to_string()],
        );
        for gone in ["typed-in-token", "key-5555", "s3cr3t-cookie", "env-secret-8888", "Basic abc"] {
            assert!(!clean.contains(gone), "{gone} must not be stored: {clean}");
        }
        assert!(!url.contains("key-5555"));
        let value: Value = serde_json::from_str(&clean).unwrap();
        assert_eq!(value["response"]["sent"]["headers"][0][0], "Authorization");
        assert_eq!(value["response"]["sent"]["headers"][0][1], REDACTED);
        // A header built from a reference is kept — it is the reason the value is safe to keep.
        assert_eq!(value["request"]["headers"][1]["value"], "session={{sid}}");
        assert_eq!(value["request"]["headers"][2]["value"], "abc");
        // Idempotent.
        let (again, _) = redact_history(&clean, &url, &["env-secret-8888".to_string()]);
        assert_eq!(again, clean);
    }

    #[test]
    fn the_values_scrubbed_from_history_are_the_literal_credentials() {
        let values = secret_values(
            &[
                r#"{"bearer":{"token":"tok-aaaa"},"basic":{"password":"{{pass}}"}}"#.to_string(),
                String::new(),
            ],
            &[r#"[{"key":"a","initialValue":"sec-bbbb","currentValue":"","secret":true},
                   {"key":"b","initialValue":"public","currentValue":"","secret":false}]"#
                .to_string()],
        );
        assert_eq!(values, vec!["sec-bbbb".to_string(), "tok-aaaa".to_string()]);
    }

    fn api_tree(db: &Db) -> ApiTree {
        super::super::api_queries::load_tree(&db.0.lock().unwrap(), "w1").unwrap()
    }
}
