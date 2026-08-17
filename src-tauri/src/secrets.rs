//! Credentials, in the OS-native store.
//!
//! Three calls — [`get_secret`], [`set_secret`], [`delete_secret`] — over a key built by one of the
//! functions at the bottom of this file. What sits underneath them differs by platform, and the
//! reason is macOS's authorization prompt.
//!
//! **The prompt.** macOS asks for the login password whenever an app reads a Keychain item whose
//! ACL doesn't recognize the app's code signature, and it records "Always Allow" **per item**. Two
//! things follow. The first is that an app signed ad-hoc — which is every build not signed with a
//! real certificate — has a designated requirement that is a bare hash of the executable, so it
//! stops matching at the next rebuild and "Always Allow" quietly means "until the next update".
//! That one cannot be fixed here; it is fixed by signing with a Developer ID. The second *is* fixed
//! here: with one item per credential, authorizing the app was never a single act. This install
//! reached eighteen items — a token per Git host, a key per Supabase project, a passphrase, two
//! cloud grants, one per database connection — and the scheduled backup, which walks all of them
//! unattended, turned that into a burst of prompts a minute after launch with nothing on screen to
//! explain it.
//!
//! So **on macOS every secret lives in one Keychain item**, a JSON map read once per process. One
//! item is one ACL is one authorization: the prompt the user answers covers the whole app rather
//! than whichever credential happened to be needed first. Everywhere else the per-credential items
//! stay: Windows' Credential Manager never prompts and caps a credential at 2560 bytes, which a
//! combined blob would eventually exceed and start failing writes for; Linux's secret-service
//! unlocks the collection as a whole, so it has nothing to gain either.
//!
//! **What the session cache buys on top.** Values read or written stay in memory for the life of
//! the process, so nothing goes back to the OS store twice. On macOS that is now a small
//! optimisation rather than the load-bearing part it used to be. A missing entry is cached as
//! `None` too — "is a token saved?" is asked as often as "what is it?" — but a read that *errors*
//! (including the user dismissing the prompt) is deliberately not cached, so the next attempt asks
//! again rather than inheriting a false miss. The trade is that tokens are resident in the process
//! rather than only for the length of a request.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use keyring::Entry;

#[cfg(not(test))]
const SERVICE: &str = "com.codeflow.app";

/// The tests below write to a real OS credential store — there is no in-memory backend to point
/// them at — so they get a service of their own. That was merely tidy while each credential had its
/// own item; with a single vault it is the difference between a test writing one throwaway entry
/// and a test writing a two-key blob over the eighteen credentials on the developer's own machine.
#[cfg(test)]
const SERVICE: &str = "com.codeflow.app.test";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// Everything read or written this session — and, on macOS, whether the one item it all lives in
/// has been read yet. `loaded` is tracked separately from the map being non-empty, because a fresh
/// install legitimately has nothing in it and must not go back to the Keychain on every miss.
#[derive(Default)]
struct Store {
    values: HashMap<String, Option<String>>,
    #[cfg(target_os = "macos")]
    loaded: bool,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

/// A panic anywhere while this lock is held would poison it. Recovering rather than propagating is
/// deliberate: on macOS the alternative is re-reading the Keychain item, which is the prompt this
/// module exists to ask for once.
fn locked() -> MutexGuard<'static, Store> {
    store().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The one item, on macOS. The name is a key no builder below can produce, so it can never collide
/// with a credential of its own.
#[cfg(target_os = "macos")]
const VAULT_ACCOUNT: &str = "codeflow-secrets";

/// Reads the vault item into `values`, once.
///
/// A blob that exists but does not parse is an error and leaves `loaded` false — on purpose. Every
/// write path calls this first, so treating a damaged blob as "empty" would mean the next
/// `set_secret` overwrote every other credential in it with a single key.
#[cfg(target_os = "macos")]
fn ensure_loaded(store: &mut Store) -> Result<(), String> {
    if store.loaded {
        return Ok(());
    }
    match entry(VAULT_ACCOUNT)?.get_password() {
        Ok(raw) => {
            let map: HashMap<String, String> = serde_json::from_str(&raw).map_err(|e| {
                // Named, because the only way out of this is by hand and the user needs to know
                // which item to look at. Deleting it discards every credential in it, which is why
                // this refuses rather than starting over on its own.
                format!(
                    "the credential store (Keychain item \"{VAULT_ACCOUNT}\" under \"{SERVICE}\") \
                     could not be read: {e}"
                )
            })?;
            for (key, value) in map {
                // Never over something set this session: that value is the newer one.
                store.values.entry(key).or_insert(Some(value));
            }
        }
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    store.loaded = true;
    Ok(())
}

/// Writes the whole map back. Cached *absences* are not credentials and are left out.
#[cfg(target_os = "macos")]
fn persist(store: &Store) -> Result<(), String> {
    let map: HashMap<&str, &str> = store
        .values
        .iter()
        .filter_map(|(key, value)| value.as_deref().map(|value| (key.as_str(), value)))
        .collect();
    let raw = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    entry(VAULT_ACCOUNT)?.set_password(&raw).map_err(|e| e.to_string())
}

/// Puts a value into the map and writes the vault, putting the previous entry back if the write
/// fails.
///
/// The rollback is the point. Serialising happens from the map, so the new value has to be in it
/// before the write — and a `set_secret` that returned an error while leaving the process convinced
/// the credential was saved is the worst of both: the token works until the next launch and then
/// silently doesn't.
#[cfg(target_os = "macos")]
fn commit(store: &mut Store, key: &str, value: Option<String>) -> Result<(), String> {
    let previous = store.values.insert(key.to_string(), value);
    if let Err(e) = persist(store) {
        match previous {
            Some(entry) => store.values.insert(key.to_string(), entry),
            None => store.values.remove(key),
        };
        return Err(e);
    }
    Ok(())
}

/// Reads one pre-vault item — the shape every credential had before this file kept a single one.
///
/// An item that does not exist answers without a prompt, so this costs the user nothing for the
/// keys they never stored; the ones they did cost one prompt each, once, and are folded into the
/// vault so the next launch asks only for the vault itself.
fn read_own_item(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Stores a secret (PAT, token, etc.) in the OS-native credential store
/// (Windows Credential Manager / macOS Keychain). Never touches disk in plain text.
#[cfg(target_os = "macos")]
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    let mut store = locked();
    ensure_loaded(&mut store)?;
    commit(&mut store, key, Some(value.to_string()))
}

#[cfg(not(target_os = "macos"))]
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())?;
    locked().values.insert(key.to_string(), Some(value.to_string()));
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    let mut store = locked();
    ensure_loaded(&mut store)?;
    if let Some(hit) = store.values.get(key) {
        return Ok(hit.clone());
    }
    // Not in the vault. It may be a credential from before there was one — look at the old item,
    // and fold what it holds in, so this is the last time anyone asks for it.
    let legacy = read_own_item(key)?;
    store.values.insert(key.to_string(), legacy.clone());
    if legacy.is_some() {
        // A failed fold is not a failed read: the value is in hand and the caller is owed it. The
        // migration simply happens again next launch, at the cost of the one prompt it was going
        // to save.
        let _ = persist(&store);
        // The old item is left where it is rather than deleted: an install rolled back to a
        // previous version has to still find its tokens. It is never read again once the value is
        // in the vault, so it costs no further prompts — only `delete_secret` clears it, because
        // there "delete my token" has to mean it.
    }
    Ok(legacy)
}

#[cfg(not(target_os = "macos"))]
pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    if let Some(hit) = locked().values.get(key) {
        return Ok(hit.clone());
    }
    let value = read_own_item(key)?;
    // `or_insert`, not `insert`: the lock is not held across the read above, so a `set_secret` from
    // another thread may have landed in the meantime — and that value is the newer one.
    locked().values.entry(key.to_string()).or_insert(value.clone());
    Ok(value)
}

#[cfg(target_os = "macos")]
pub fn delete_secret(key: &str) -> Result<(), String> {
    let mut store = locked();
    ensure_loaded(&mut store)?;
    // The pre-vault copy goes first, and the order is the whole point. Removing the vault entry
    // first and failing here would report "not deleted" with the vault entry already gone and the
    // old item still holding the token — which the next launch folds straight back in, showing the
    // account connected again with a credential the user revoked. Failing in this direction leaves
    // a credential that is still there and still reported as still there.
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    commit(&mut store, key, None)
}

#[cfg(not(target_os = "macos"))]
pub fn delete_secret(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            locked().values.insert(key.to_string(), None);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Deterministic key naming so callers don't have to remember conventions.
///
/// Case-folded, because Azure is: `dev.azure.com/MyOrg` and `dev.azure.com/myorg` name one
/// organisation, and the two spellings arrive here from different places — Settings takes the one
/// the user typed, auto-linking takes the one in the git remote URL. Keyed verbatim those were two
/// Keychain items, and the second was always empty: "No Azure DevOps token saved for organization
/// X" for an organisation that *is* connected. Sticky, too, because [`get_secret`] caches the miss,
/// so re-saving the PAT in Settings did not clear it — only restarting the app did, until the next
/// auto-link put it back.
pub fn ado_pat_key(org: &str) -> String {
    format!("ado-pat:{}", org.trim().to_ascii_lowercase())
}

/// The verbatim shape the key had before it was case-folded. Read only when the folded key holds
/// nothing, and written by nothing — see [`ado_pat`].
pub fn ado_pat_legacy_key(org: &str) -> String {
    format!("ado-pat:{}", org.trim())
}

/// The PAT for one Azure DevOps organisation, wherever it happens to be filed.
///
/// Every read goes through here rather than through `get_secret(&ado_pat_key(org))`, so a PAT saved
/// before the key was case-folded is found once and moved forward instead of being invisible. The
/// old item is left where it is, for the same reason the vault leaves its own: an install rolled
/// back to a previous version has to still find its token.
pub fn ado_pat(org: &str) -> Result<Option<String>, String> {
    let key = ado_pat_key(org);
    let legacy = ado_pat_legacy_key(org);
    if legacy != key {
        // The pre-fold item wins *while it exists*, and it exists only until the first fold — which
        // is what makes winning safe. Before folding, the verbatim key was the one every save
        // wrote, so it holds the newest PAT for this spelling; after folding, nothing writes there
        // at all. Reading the folded key first instead would let a PAT saved long ago under
        // `ado-pat:myorg` shadow the one saved yesterday under `ado-pat:MyOrg`, forever.
        if let Some(value) = get_secret(&legacy)? {
            // Neither failure is the caller's problem: the token is in hand and is owed to them.
            // A fold that did not stick simply happens again on the next read.
            let _ = set_secret(&key, &value);
            // Removed, unlike the pre-vault items the macOS store leaves alone. Leaving it would
            // make the next read prefer it again — and once the user rotates the PAT, "it" is the
            // revoked one.
            let _ = delete_secret(&legacy);
            return Ok(Some(value));
        }
    }
    get_secret(&key)
}

/// Removes the PAT under both spellings. Deleting only the folded one would leave the pre-fold item
/// for [`ado_pat`] to find and quietly reconnect an organisation the user just disconnected.
pub fn delete_ado_pat(org: &str) -> Result<(), String> {
    let key = ado_pat_key(org);
    let legacy = ado_pat_legacy_key(org);
    // Pre-fold item first, for the reason spelled out in `delete_secret`: a failure after the
    // folded entry is gone leaves exactly the state [`ado_pat`] would read as authoritative and
    // fold back in — the revoked token, reconnecting an organisation the user just removed.
    if legacy != key {
        delete_secret(&legacy)?;
    }
    delete_secret(&key)
}

/// GitHub's REST API authenticates one token against every repo/org the account can see, so
/// the token is stored per host (`github.com`) rather than per owner the way Azure DevOps is
/// keyed per org — leaving room for a GitHub Enterprise host later without changing the shape.
pub fn github_token_key(host: &str) -> String {
    format!("github-token:{host}")
}

/// GitLab's API authenticates one personal access token against every project the account can see,
/// so it is keyed per host exactly like GitHub — leaving room for a self-managed GitLab instance
/// alongside gitlab.com without changing the shape.
pub fn gitlab_token_key(host: &str) -> String {
    format!("gitlab-token:{host}")
}

/// Jira's API token, keyed per site, so a work account and a personal one can be connected at once.
///
/// Only the token lives here. Jira Cloud authenticates it against the account **e-mail**, and that
/// address is not a credential — it sits with the rest of the connection in `app_settings`, the same
/// split the Azure DevOps organisation list already uses.
pub fn jira_token_key(site: &str) -> String {
    format!("jira-token:{site}")
}

/// monday.com's personal API token, keyed by account slug.
///
/// Unlike the four above there is no host to key by — every monday customer is served from the same
/// API endpoint, so the token *is* the identity of the connection. The slug is read back from the
/// host when the token is saved rather than typed, which is what stops two accounts colliding under
/// a name the user invented.
pub fn monday_token_key(slug: &str) -> String {
    format!("monday-token:{slug}")
}

/// Passphrase the whole-install backup is sealed with. In the credential store rather than in
/// `app_settings` for the obvious reason, and there is exactly one: the scheduled backup has to be
/// able to write the file unattended, which it cannot do if the only copy is in the user's head.
///
/// Storing it here is deliberately *not* a weakening of the file. The threat the encryption answers
/// is a copy of the backup sitting in Google Drive or iCloud, where the credential store is not; on
/// the machine itself an attacker who can read the Keychain can already read everything the backup
/// contains.
pub fn backup_passphrase_key() -> String {
    "codeflow-backup-passphrase".to_string()
}

/// Where that passphrase lived when the backup covered only the API client. Still read, once, so an
/// existing setup carries over instead of asking the user for a passphrase they already chose.
pub fn api_backup_passphrase_key() -> String {
    "api-backup-passphrase".to_string()
}

/// The user's own Google OAuth client secret. For an installed app this is not a secret in the
/// cryptographic sense — Google says as much — but it is still theirs, and `app_settings` is a
/// plain SQLite file that ends up in a support bundle far more easily than the credential store.
pub fn gdrive_client_secret_key() -> String {
    "gdrive-client-secret".to_string()
}

/// The long-lived grant. This one *is* a credential: it can mint access tokens for the backup file
/// until the user revokes it.
pub fn gdrive_refresh_token_key() -> String {
    "gdrive-refresh-token".to_string()
}

/// The OneDrive grant. There is no client-secret counterpart: the Entra app registration is a
/// public client, so the whole of that setup is an id the user pastes into a plain settings field.
///
/// Rewritten on every refresh rather than only at connect time — Microsoft rotates these, and the
/// value stored here after a week is not the one the user's browser originally granted.
pub fn onedrive_refresh_token_key() -> String {
    "onedrive-refresh-token".to_string()
}

/// The anon key of one Supabase project, keyed by its host.
///
/// Per project, not per install. A person can host their own shared collections *and* accept
/// invitations to collections living on somebody else's project — a client's, a second team's —
/// and a single stored key would mean the most recent invitation silently revoked access to
/// everything that came before it.
pub fn supabase_anon_key(project_url: &str) -> String {
    format!("supabase-anon:{}", project_host(project_url))
}

/// The single key of the days when one install meant one project. Still read as a fallback, so an
/// existing setup keeps working without asking the user to paste their key again.
pub fn supabase_legacy_anon_key() -> String {
    "supabase-anon-key".to_string()
}

/// The host, as the key to file a project's credential under: the same project reached as
/// `https://x.supabase.co` and `https://x.supabase.co/` must not become two entries.
fn project_host(project_url: &str) -> String {
    project_url
        .trim()
        .trim_end_matches('/')
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .to_ascii_lowercase()
}

/// The share token for one shared collection — the whole credential for reaching it, so keyed per
/// collection: hosting one and being a guest in another are the normal case, not an edge one.
///
/// The prefix is deliberately not the `supabase-share:` of the workspace-shaped share it replaced.
/// Both are keyed by a v4 uuid, and a stale workspace token left in the credential store must not
/// be able to resolve as a collection's.
pub fn supabase_share_token(collection_id: &str) -> String {
    format!("supabase-collection:{collection_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Store` is process-global and, on macOS, every write rewrites the whole vault — so two tests
    /// running at once are two tests writing over each other. Serialised rather than made
    /// independent because the thing under test *is* the global.
    fn serially() -> MutexGuard<'static, ()> {
        static ORDER: OnceLock<Mutex<()>> = OnceLock::new();
        ORDER
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Drops one key from the session cache so a test exercises the OS store itself. On macOS that
    /// means the *vault* is re-read, not a per-key item — which is exactly what should happen.
    fn forget(key: &str) {
        let mut store = locked();
        store.values.remove(key);
        #[cfg(target_os = "macos")]
        {
            store.loaded = false;
        }
    }

    /// Leaves no item behind, and that is not tidiness.
    ///
    /// A test binary is signed ad-hoc, so its designated requirement is a hash of itself and every
    /// `cargo test` produces a different one. An item left in the Keychain by the previous build is
    /// therefore an item *this* build is not on the ACL of — and the next run stops for a password
    /// dialog on the developer's screen instead of finishing. Creating the item fresh needs no
    /// authorization; inheriting one does.
    fn drop_test_store() {
        let mut store = locked();
        store.values.clear();
        #[cfg(target_os = "macos")]
        {
            store.loaded = false;
            if let Ok(vault) = entry(VAULT_ACCOUNT) {
                let _ = vault.delete_credential();
            }
        }
    }

    #[test]
    fn roundtrip() {
        let _order = serially();
        let key = ado_pat_key("diagnostic-test-org");
        set_secret(&key, "hello-token-123").expect("set_secret failed");
        // Evict first, so this exercises the OS store itself rather than the session cache
        // sitting in front of it.
        forget(&key);
        let got = get_secret(&key).expect("get_secret errored");
        assert_eq!(got, Some("hello-token-123".to_string()));
        delete_secret(&key).expect("delete_secret failed");
        forget(&key);
        assert_eq!(get_secret(&key).expect("get_secret errored"), None);
        drop_test_store();
    }

    /// Two spellings of one Azure organisation must not become two Keychain items — that is the
    /// whole of the bug this folding fixes. No OS store is touched here; the key builder is the
    /// thing under test.
    #[test]
    fn ado_pat_keys_fold_case() {
        assert_eq!(ado_pat_key("MyOrg"), "ado-pat:myorg");
        assert_eq!(ado_pat_key(" MyOrg "), ado_pat_key("myorg"));
        // ...and the pre-folding shape stays verbatim, because it is what the old item is filed
        // under and reading it is the only reason it still exists.
        assert_eq!(ado_pat_legacy_key(" MyOrg "), "ado-pat:MyOrg");
        assert_eq!(ado_pat_legacy_key("myorg"), ado_pat_key("myorg"));
    }

    /// The pre-fold item wins while it exists, and stops existing the moment it is folded. That
    /// pair of facts is the whole of the precedence rule: without the first, a PAT saved yesterday
    /// under `MyOrg` is shadowed by one saved a year ago under `myorg`; without the second, a PAT
    /// rotated after the fold is shadowed by the revoked one every read from then on.
    #[test]
    fn the_pre_fold_pat_wins_once_and_then_is_gone() {
        let _order = serially();
        let org = "FoldTestOrg";
        // The shape a pre-fold install is in: both spellings present, the verbatim one the newer.
        set_secret(&ado_pat_key(org), "stale-lowercase").expect("set folded");
        set_secret(&ado_pat_legacy_key(org), "current-verbatim").expect("set verbatim");

        assert_eq!(ado_pat(org).expect("read").as_deref(), Some("current-verbatim"));
        assert_eq!(get_secret(&ado_pat_legacy_key(org)).expect("read verbatim"), None, "folded away");
        assert_eq!(
            get_secret(&ado_pat_key(org)).expect("read folded").as_deref(),
            Some("current-verbatim"),
        );

        set_secret(&ado_pat_key(org), "rotated").expect("rotate");
        assert_eq!(ado_pat(org).expect("read").as_deref(), Some("rotated"), "no resurrection");

        delete_ado_pat(org).expect("delete");
        assert_eq!(ado_pat(org).expect("read"), None);
        drop_test_store();
    }

    /// The cache is what keeps macOS from asking for the login password on every repo switch, so
    /// it gets its own test: a key never written to the OS store still reads back once cached.
    #[test]
    fn reads_are_served_from_the_session_cache() {
        let _order = serially();
        let key = ado_pat_key("cache-only-test-org");
        {
            let mut store = locked();
            store.values.insert(key.clone(), Some("cached-value".to_string()));
            // Pretend the vault has been read, or the lookup goes to the Keychain first and the
            // cached value is never consulted.
            #[cfg(target_os = "macos")]
            {
                store.loaded = true;
            }
        }
        assert_eq!(get_secret(&key).expect("get_secret errored"), Some("cached-value".to_string()));
        drop_test_store();
    }
}
