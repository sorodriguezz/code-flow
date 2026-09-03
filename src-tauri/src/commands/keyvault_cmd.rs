//! The keyring's IPC surface — and the only place in the app that holds the vault key.
//!
//! Three rules hold this module together. They are not style preferences; each one closes a way the
//! vault could leak.
//!
//! **1. There is no `keyvault_get_key`, and no generic `keyvault_get_secret(key)`.** Every command
//! here names the exact thing it does. `secrets_cmd` is written the same way — eighteen hand-rolled
//! per-family commands and no general verb — precisely so that a bug in the webview cannot ask the
//! backend for arbitrary secrets. The key never crosses the bridge in any form.
//!
//! **2. Argon2 runs outside the database lock.** Deriving the key is ~100 ms of deliberate work,
//! and `Db` is one `Mutex<Connection>` shared by every command in the app. Holding it across the
//! derivation freezes the whole UI. So each of these reads the row in a scoped block, drops the
//! guard, derives on a blocking thread, and only then takes the lock again to write.
//!
//! **3. Every read and write goes through [`VaultSession::with_key`].** That call is both the
//! authorisation check and the idle heartbeat, so "is the vault open?" is one fact in one place
//! rather than a flag each command remembers to test.

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::db::keyvault_queries as queries;
use crate::db::models::{
    VaultAuditRow, VaultBlobMeta, VaultFolderRow, VaultItemMeta, VaultItemPlain, VaultStatus,
    VaultTree,
};
use crate::db::Db;
use crate::keyvault::crypto::{self, PasswordRecipe, VaultError};
use crate::keyvault::session::{VaultSession, LOCKED_EVENT};
use crate::keyvault::{master_password_key, totp};
use crate::secrets;

/// The biggest file that can be attached.
///
/// Bytes cross the IPC bridge as a JSON array of numbers — four to six bytes of JSON per byte of
/// file — so this is a limit on the *bridge* as much as on the database. A photo of a document or a
/// `.pem` is well inside it; a video is not what a keyring is for.
const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

/// How many audit rows the panel asks for.
const AUDIT_LIMIT: i64 = 200;

/// The biggest export file the import screen will read.
///
/// Its own cap rather than reusing `api_read_text_file`, which has none: an unencrypted vault export
/// is a file a user picks by hand from a Downloads folder, and picking the wrong one should say so
/// rather than pulling a gigabyte into memory. Generous for what it is — a Bitwarden JSON export of
/// a thousand entries is a few megabytes.
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;

/// Entries a `.1pux` may hold, and how much it may unpack to. A three-kilobyte archive can declare
/// a petabyte — see `skills_cmd` for the same guard and the same reasoning.
const MAX_1PUX_ENTRIES: usize = 20_000;

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn keyvault_status(
    db: State<'_, Db>,
    session: State<'_, VaultSession>,
) -> Result<VaultStatus, String> {
    // The guard is dropped at the end of this block, before the keychain read below, and that is
    // the whole reason the block exists. On macOS the first read of an item in the credential
    // store pops a system permission dialog and **blocks until it is answered** — which may be a
    // long time, because the dialog can open behind the app's own window. Holding
    // `Mutex<Connection>` across that freezes every other command in the app behind a prompt the
    // user has not necessarily noticed. Same rule as Argon2; see `keyvault_unlock`.
    let (initialised, autolock_minutes) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let meta = queries::get_meta(&conn).map_err(|e| e.to_string())?;
        (
            meta.is_some(),
            meta.as_ref().map(|m| m.autolock_minutes).unwrap_or(15),
        )
    };
    let unlocked = session.is_unlocked();
    // And off the runtime's worker, for the same reason: a blocking call of unbounded duration.
    let remembered = tokio::task::spawn_blocking(|| {
        secrets::get_secret(&master_password_key())
            .ok()
            .flatten()
            .is_some()
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(VaultStatus {
        initialised,
        unlocked,
        autolock_minutes,
        remembered,
    })
}

/// Creates the vault and leaves it open.
///
/// Refuses if one already exists: "create" must never be a path that could overwrite the wrapped
/// key, because doing so would make every sealed record in the database permanently unreadable with
/// no warning and no undo.
#[tauri::command]
pub async fn keyvault_initialise(
    db: State<'_, Db>,
    session: State<'_, VaultSession>,
    password: String,
    remember: bool,
) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if queries::get_meta(&conn).map_err(|e| e.to_string())?.is_some() {
            return Err(crypto::CODE_ALREADY_INITIALISED.to_string());
        }
    }

    let secret = password_for(&password);
    let attempt = secret.clone();
    let created = blocking(move || crypto::initialise(&attempt))
        .await?
        .map_err(String::from)?;

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::put_meta(
            &conn,
            &queries::VaultMeta {
                kdf_memory_kib: created.kdf.memory_kib,
                kdf_iterations: created.kdf.iterations,
                kdf_lanes: created.kdf.lanes,
                kdf_salt: created.kdf.salt.clone(),
                dek_nonce: created.dek_nonce.clone(),
                dek_wrapped: created.dek_wrapped.clone(),
                autolock_minutes: 15,
            },
        )
        .map_err(|e| e.to_string())?;
        queries::record_audit(&conn, "", "create");
    }

    session.unlock(created.dek, 15);
    remember_or_forget(&secret, remember)?;
    Ok(())
}

/// Opens the vault. A wrong password fails the GCM tag on the wrapped key — see `crypto`.
#[tauri::command]
pub async fn keyvault_unlock(
    db: State<'_, Db>,
    session: State<'_, VaultSession>,
    password: String,
    remember: bool,
) -> Result<(), String> {
    let stored = read_meta(&db)?;
    let autolock = stored.autolock_minutes;

    let kdf = stored.kdf();
    let nonce = stored.dek_nonce.clone();
    let wrapped = stored.dek_wrapped.clone();
    let attempt = password.clone();
    let dek = blocking(move || crypto::unwrap_dek(&kdf, &nonce, &wrapped, &attempt))
        .await?
        .map_err(String::from)?;

    session.unlock(dek, autolock);
    remember_or_forget(&password, remember)?;

    if let Ok(conn) = db.0.lock() {
        queries::record_audit(&conn, "", "unlock");
    }
    Ok(())
}

/// Opens the vault with the password this machine was asked to remember.
///
/// A separate command from [`keyvault_unlock`] rather than a flag on it, so the stored password is
/// read in exactly one place and never travels to the webview to be handed back.
#[tauri::command]
pub async fn keyvault_unlock_remembered(
    db: State<'_, Db>,
    session: State<'_, VaultSession>,
) -> Result<bool, String> {
    // Off the runtime's worker threads, for the same reason `keyvault_status` does it: reading an
    // item from the OS credential store is a blocking call of unbounded duration — on macOS the
    // first one puts a permission dialog in front of the answer and waits for it, and that dialog
    // can open behind the app's window. This is the app's first act on a launch where the password
    // is remembered, so a stall here is a stall in front of everything else.
    let stored = tokio::task::spawn_blocking(|| secrets::get_secret(&master_password_key()))
        .await
        .map_err(|e| e.to_string())??;
    let Some(password) = stored else {
        return Ok(false);
    };
    let meta = read_meta(&db)?;
    let autolock = meta.autolock_minutes;
    let kdf = meta.kdf();
    let nonce = meta.dek_nonce.clone();
    let wrapped = meta.dek_wrapped.clone();

    let dek = match blocking(move || crypto::unwrap_dek(&kdf, &nonce, &wrapped, &password)).await? {
        Ok(dek) => dek,
        // The remembered password no longer opens the vault — it was changed on another machine,
        // or the entry is stale. Forget it rather than failing on every launch from now on.
        Err(_) => {
            let _ = secrets::delete_secret(&master_password_key());
            return Ok(false);
        }
    };
    session.unlock(dek, autolock);
    if let Ok(conn) = db.0.lock() {
        queries::record_audit(&conn, "", "unlock");
    }
    Ok(true)
}

#[tauri::command]
pub fn keyvault_lock(db: State<Db>, session: State<VaultSession>, app: AppHandle) {
    session.lock();
    if let Ok(conn) = db.0.lock() {
        queries::record_audit(&conn, "", "lock");
    }
    // Told rather than polled, so every view showing a secret drops it at the same moment.
    let _ = app.emit(LOCKED_EVENT, ());
}

/// The idle heartbeat. Called from the UI on real activity, throttled there.
#[tauri::command]
pub fn keyvault_touch(session: State<VaultSession>) {
    session.touch();
}

/// Re-wraps the data key under a new password. Nothing else is re-encrypted — see `crypto::rewrap`.
#[tauri::command]
pub async fn keyvault_change_password(
    db: State<'_, Db>,
    session: State<'_, VaultSession>,
    old: String,
    new: String,
) -> Result<(), String> {
    let stored = read_meta(&db)?;
    let kdf = stored.kdf();
    let nonce = stored.dek_nonce.clone();
    let wrapped = stored.dek_wrapped.clone();
    let (previous, next) = (old.clone(), new.clone());

    let (kdf, dek_nonce, dek_wrapped) =
        blocking(move || crypto::rewrap(&kdf, &nonce, &wrapped, &previous, &next))
            .await?
            .map_err(String::from)?;

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::put_meta(
            &conn,
            &queries::VaultMeta {
                kdf_memory_kib: kdf.memory_kib,
                kdf_iterations: kdf.iterations,
                kdf_lanes: kdf.lanes,
                kdf_salt: kdf.salt,
                dek_nonce,
                dek_wrapped,
                autolock_minutes: stored.autolock_minutes,
            },
        )
        .map_err(|e| e.to_string())?;
    }

    // The remembered copy is now the old password. Rewrite it if the machine was remembering one,
    // and leave it absent otherwise — silently *starting* to remember here would be a security
    // decision the user did not make.
    if secrets::get_secret(&master_password_key())?.is_some() {
        secrets::set_secret(&master_password_key(), &new)?;
    }
    // The session keeps the same data key, so it stays open — the key did not change, only its
    // wrapping did.
    let _ = session;
    Ok(())
}

#[tauri::command]
pub fn keyvault_set_autolock(
    db: State<Db>,
    session: State<VaultSession>,
    minutes: u32,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_autolock(&conn, minutes).map_err(|e| e.to_string())?;
    session.set_autolock(minutes);
    Ok(())
}

/// **Destroys the keyring and everything in it**, and forgets the remembered password with it.
///
/// The way out of the one dead end this design has: a forgotten master password cannot be
/// recovered, so without this the vault would be permanently unopenable *and* permanently
/// un-replaceable — "there is already a keyring on this machine" forever, with no way past it but a
/// text editor and the database file.
///
/// Takes no confirmation argument: the UI double-confirms and types the word back, which is where
/// that belongs. What this owes is that it either does all of it or none of it.
#[tauri::command]
pub fn keyvault_reset(db: State<Db>, session: State<VaultSession>) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::reset(&conn).map_err(|e| e.to_string())?;
    }
    // The key in memory is now a key to nothing. Wiped before returning, so a session that was open
    // when this ran cannot go on answering with it.
    session.lock();
    // Best effort: a keyring entry that outlives the vault it opened is harmless, and failing the
    // whole reset over it would leave the far worse half-done state.
    let _ = secrets::delete_secret(&master_password_key());
    Ok(())
}

/// Stops this machine remembering the master password.
#[tauri::command]
pub fn keyvault_forget_password() -> Result<(), String> {
    secrets::delete_secret(&master_password_key())
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn keyvault_load_tree(
    db: State<Db>,
    session: State<VaultSession>,
    workspace_id: String,
) -> Result<VaultTree, String> {
    // The list carries no ciphertext, so it needs no key — but it is still gated on the vault being
    // open, because "what is in the keyring" is itself something a locked app should not answer.
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::load_tree(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyvault_list_trash(
    db: State<Db>,
    session: State<VaultSession>,
) -> Result<Vec<VaultItemMeta>, String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_trash(&conn).map_err(|e| e.to_string())
}

/// One entry, decrypted. The only command that returns a plaintext secret, and it returns exactly
/// one — which is what keeps a compromised renderer from draining the vault in a single call.
#[tauri::command]
pub fn keyvault_get_item(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
) -> Result<Option<VaultItemPlain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some((meta, nonce, blob)) = queries::get_sealed(&conn, &id).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let secret = open_secret(&session, &id, &nonce, &blob)?;
    queries::record_audit(&conn, &id, "reveal");
    Ok(Some(VaultItemPlain { meta, secret }))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn keyvault_create_item(
    db: State<Db>,
    session: State<VaultSession>,
    folder_id: Option<String>,
    kind: String,
    title: String,
    subtitle: String,
    site: String,
    tags: String,
    workspace_id: String,
    secret: Value,
) -> Result<VaultItemMeta, String> {
    let payload = serde_json::to_vec(&secret).map_err(|e| e.to_string())?;
    // The id has to exist before the payload can be sealed, because the id *is* the AAD — a
    // ciphertext is bound to its row. So the row is created with an empty payload and immediately
    // updated with the sealed one, in one transaction's worth of work.
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let created = queries::create_item(
        &conn,
        queries::NewItem {
            folder_id: folder_id.as_deref(),
            kind: &kind,
            title: &title,
            subtitle: &subtitle,
            site: &site,
            tags: &tags,
            workspace_id: &workspace_id,
            secret_nonce: "",
            secret_blob: "",
        },
    )
    .map_err(|e| e.to_string())?;

    let sealed = session.with_key(|dek| crypto::seal(dek, &created.id, &payload))?;
    let (nonce, blob) = sealed.map_err(String::from)?;
    let updated = queries::update_item(
        &conn, &created.id, &title, &subtitle, &site, &tags, &nonce, &blob,
    )
    .map_err(|e| e.to_string())?;
    queries::record_audit(&conn, &created.id, "create");
    Ok(updated.unwrap_or(created))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn keyvault_update_item(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    title: String,
    subtitle: String,
    site: String,
    tags: String,
    secret: Value,
) -> Result<Option<VaultItemMeta>, String> {
    let payload = serde_json::to_vec(&secret).map_err(|e| e.to_string())?;
    let sealed = session.with_key(|dek| crypto::seal(dek, &id, &payload))?;
    let (nonce, blob) = sealed.map_err(String::from)?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let updated = queries::update_item(&conn, &id, &title, &subtitle, &site, &tags, &nonce, &blob)
        .map_err(|e| e.to_string())?;
    queries::record_audit(&conn, &id, "update");
    Ok(updated)
}

#[tauri::command]
pub fn keyvault_move_item(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::move_item(&conn, &id, folder_id.as_deref()).map_err(|e| e.to_string())
}

/// Files an entry under a workspace, or under none — `""` is everywhere.
#[tauri::command]
pub fn keyvault_set_item_workspace(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    workspace_id: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_item_workspace(&conn, &id, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyvault_set_favorite(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_favorite(&conn, &id, favorite).map_err(|e| e.to_string())
}

/// Moves an entry to the trash. Recoverable — see `keyvault_purge_item` for the one that is not.
#[tauri::command]
pub fn keyvault_delete_item(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::soft_delete_item(&conn, &id).map_err(|e| e.to_string())?;
    queries::record_audit(&conn, &id, "delete");
    Ok(())
}

#[tauri::command]
pub fn keyvault_restore_item(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::restore_item(&conn, &id).map_err(|e| e.to_string())?;
    queries::record_audit(&conn, &id, "restore");
    Ok(())
}

#[tauri::command]
pub fn keyvault_purge_item(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::purge_item(&conn, &id).map_err(|e| e.to_string())?;
    queries::record_audit(&conn, &id, "purge");
    Ok(())
}

#[tauri::command]
pub fn keyvault_empty_trash(db: State<Db>, session: State<VaultSession>) -> Result<usize, String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let removed = queries::empty_trash(&conn).map_err(|e| e.to_string())?;
    queries::record_audit(&conn, "", "purge");
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn keyvault_create_folder(
    db: State<Db>,
    session: State<VaultSession>,
    parent_id: Option<String>,
    name: String,
    workspace_id: String,
) -> Result<VaultFolderRow, String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_folder(&conn, parent_id.as_deref(), &name, &workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyvault_rename_folder(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    name: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_folder(&conn, &id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyvault_set_folder_color(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    color: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_folder_color(&conn, &id, &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyvault_set_folder_workspace(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    workspace_id: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_folder_workspace(&conn, &id, &workspace_id).map_err(|e| e.to_string())
}

/// `false` means the drop was refused: it would have put the folder inside its own subtree.
#[tauri::command]
pub fn keyvault_move_folder(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    parent_id: Option<String>,
) -> Result<bool, String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::move_folder(&conn, &id, parent_id.as_deref()).map_err(|e| e.to_string())
}

/// Deletes a folder. Its entries survive, at the root — see the query's comment.
#[tauri::command]
pub fn keyvault_delete_folder(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_folder(&conn, &id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/// The attachment list. Needs no key and returns no bytes.
#[tauri::command]
pub fn keyvault_list_blobs(
    db: State<Db>,
    session: State<VaultSession>,
    item_id: String,
) -> Result<Vec<VaultBlobMeta>, String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_blobs(&conn, &item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyvault_add_blob(
    db: State<Db>,
    session: State<VaultSession>,
    item_id: String,
    name: String,
    mime: String,
    bytes: Vec<u8>,
) -> Result<VaultBlobMeta, String> {
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "This file is {} MB. Attachments are capped at {} MB — they travel encrypted inside the \
             database and inside every backup of it.",
            bytes.len() / (1024 * 1024),
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let size = bytes.len() as i64;
    // Minted here rather than by the query, because the id is the AAD the bytes are sealed under —
    // it has to exist before the sealing.
    let blob_id = uuid::Uuid::new_v4().to_string();
    let sealed = session.with_key(|dek| crypto::seal(dek, &blob_id, &bytes))?;
    let (nonce, data) = sealed.map_err(String::from)?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::add_blob(&conn, &blob_id, &item_id, &name, &mime, size, &nonce, &data)
        .map_err(|e| e.to_string())
}

/// One attachment's bytes, base64, for the webview to turn into a `data:` URI.
///
/// Base64 and not a file path: this app has no `assetProtocol` and `convertFileSrc` appears nowhere
/// in it, so a `data:` URI is the only way an image reaches the screen — and writing a decrypted
/// copy to disk to serve it would defeat the point of the vault.
#[tauri::command]
pub fn keyvault_read_blob(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some((meta, nonce, data)) = queries::get_sealed_blob(&conn, &id).map_err(|e| e.to_string())?
    else {
        return Err("That attachment is no longer here.".to_string());
    };
    let opened = session.with_key(|dek| crypto::open(dek, &meta.id, &nonce, &data))?;
    let bytes = opened.map_err(String::from)?;
    queries::record_audit(&conn, &meta.item_id, "reveal");
    Ok(B64.encode(&bytes))
}

/// Writes an attachment back out to a file the user chose.
#[tauri::command]
pub fn keyvault_save_blob(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
    path: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some((meta, nonce, data)) = queries::get_sealed_blob(&conn, &id).map_err(|e| e.to_string())?
    else {
        return Err("That attachment is no longer here.".to_string());
    };
    let opened = session.with_key(|dek| crypto::open(dek, &meta.id, &nonce, &data))?;
    let bytes = opened.map_err(String::from)?;
    std::fs::write(&path, &bytes).map_err(|e| format!("{path}: {e}"))?;
    queries::record_audit(&conn, &meta.item_id, "reveal");
    Ok(())
}

#[tauri::command]
pub fn keyvault_delete_blob(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
) -> Result<(), String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_blob(&conn, &id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/// A password from the OS random number generator. Needs no vault — generating one before there is
/// somewhere to put it is an ordinary thing to want.
#[tauri::command]
pub fn keyvault_generate_password(recipe: PasswordRecipe) -> Result<String, String> {
    crypto::generate_password(&recipe).map_err(String::from)
}

/// The current 2FA code for an entry.
///
/// The *code*, never the secret. The shared secret stays in the backend, so the countdown in the UI
/// costs one small call every 30 seconds and a renderer bug cannot walk away with something that
/// generates codes forever.
#[tauri::command]
pub fn keyvault_totp_code(
    db: State<Db>,
    session: State<VaultSession>,
    id: String,
) -> Result<Option<totp::TotpCode>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some((_, nonce, blob)) = queries::get_sealed(&conn, &id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let secret = open_secret(&session, &id, &nonce, &blob)?;
    let Some(raw) = secret.get("totp").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
    else {
        return Ok(None);
    };
    let config = totp::parse(raw)?;
    let seconds = chrono::Utc::now().timestamp().max(0) as u64;
    Ok(Some(totp::code_at(&config, seconds)))
}

#[tauri::command]
pub fn keyvault_audit(
    db: State<Db>,
    session: State<VaultSession>,
) -> Result<Vec<VaultAuditRow>, String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_audit(&conn, AUDIT_LIMIT).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/// Reads an export file for the import screen, and returns its **text**.
///
/// One command for all four supported shapes because only one of them needs the backend at all: a
/// `.1pux` is a zip, and there is no zip reader on the frontend (the `zip` crate is Rust-only, and
/// this is the second place in the app to use it). The other three — Bitwarden JSON, Bitwarden CSV,
/// 1Password CSV — are plain text and simply come back as they are.
///
/// **Needs no vault key and does not touch the vault.** Reading a file the user picked is not a
/// secret operation; writing what is in it is, and that goes through `keyvault_create_item` like
/// everything else. Keeping them apart means the preview screen can show what would be imported
/// while the keyring is still locked.
///
/// What comes back for a `.1pux` is the contents of `export.data`, which is the JSON the frontend
/// parser understands. The `files/` half of the archive — 1Password's own attachments — is
/// deliberately ignored: they are referenced by a document id the export does not resolve, and a
/// half-attached file is worse than an absent one. The parser says so in a warning.
#[tauri::command]
pub fn keyvault_read_import_file(path: String) -> Result<String, String> {
    let source = std::path::Path::new(&path);
    let meta = std::fs::metadata(source).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "That file is {} MB, which is far larger than any keyring export. Check it is the right \
             file.",
            meta.len() / (1024 * 1024)
        ));
    }

    let bytes = std::fs::read(source).map_err(|e| format!("{path}: {e}"))?;
    // A zip's magic, the same three spellings `skills_cmd::not_a_zip` recognises. Sniffed rather
    // than trusting the extension: a `.1pux` renamed to `.json` is still a zip, and a `.json`
    // renamed to `.1pux` is still text.
    let is_zip = bytes.len() >= 4
        && (bytes.starts_with(b"PK\x03\x04")
            || bytes.starts_with(b"PK\x05\x06")
            || bytes.starts_with(b"PK\x07\x08"));

    if !is_zip {
        return String::from_utf8(bytes)
            .map_err(|_| format!("{path} is not readable as text. A keyring export is JSON or CSV."));
    }

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| {
        format!("{path} looks like a .1pux but the zip inside it is damaged or truncated.")
    })?;
    if archive.len() > MAX_1PUX_ENTRIES {
        return Err("That archive has far more files in it than a 1Password export.".to_string());
    }

    // `export.data` is at the archive root in every 1PUX 1Password has produced, but it is looked
    // up by suffix rather than by exact name so a re-zipped folder (`Export.1pux/export.data`)
    // still works — the same tolerance `find_skill_root` has, and for the same reason.
    let name = (0..archive.len())
        .filter_map(|index| archive.by_index(index).ok().map(|entry| entry.name().to_string()))
        .find(|entry| entry == "export.data" || entry.ends_with("/export.data"))
        .ok_or_else(|| {
            "That .1pux has no `export.data` in it, so there is nothing to read. Export again from \
             1Password with \"Export data\" rather than a CSV."
                .to_string()
        })?;

    let mut entry = archive
        .by_name(&name)
        .map_err(|_| "That .1pux could not be unpacked.".to_string())?;
    if entry.size() > MAX_IMPORT_BYTES {
        return Err("The export inside that .1pux is larger than any keyring export.".to_string());
    }
    let mut text = String::new();
    std::io::Read::read_to_string(&mut entry, &mut text)
        .map_err(|_| "The export inside that .1pux is not valid UTF-8 text.".to_string())?;
    Ok(text)
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

impl queries::VaultMeta {
    fn kdf(&self) -> crypto::KdfParams {
        crypto::KdfParams {
            memory_kib: self.kdf_memory_kib,
            iterations: self.kdf_iterations,
            lanes: self.kdf_lanes,
            salt: self.kdf_salt.clone(),
        }
    }
}

/// Reads the vault's key material, holding the database lock only for the read.
fn read_meta(db: &State<'_, Db>) -> Result<queries::VaultMeta, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_meta(&conn)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| String::from(VaultError::NotInitialised))
}

/// Runs the Argon2 work off the async runtime's worker threads.
///
/// Deriving a key is ~100 ms of deliberate CPU. On the runtime's own threads that is 100 ms during
/// which nothing else in the app makes progress; here it is 100 ms on a blocking thread that exists
/// for exactly this.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("the key derivation could not be run: {e}"))
}

/// The password as it will be used. A separate function so the trim rule is stated once.
///
/// Trailing whitespace from a paste is invisible and would make the vault permanently unopenable by
/// a password the user believes they know — but leading and interior spaces are legitimate in a
/// passphrase, so only the ends are touched, and only here.
fn password_for(raw: &str) -> String {
    raw.trim().to_string()
}

/// Writes or clears the remembered master password.
fn remember_or_forget(password: &str, remember: bool) -> Result<(), String> {
    if remember {
        secrets::set_secret(&master_password_key(), &password_for(password))
    } else {
        secrets::delete_secret(&master_password_key())
    }
}

/// Opens one entry's payload and parses it back into JSON.
fn open_secret(
    session: &State<'_, VaultSession>,
    id: &str,
    nonce: &str,
    blob: &str,
) -> Result<Value, String> {
    if nonce.is_empty() || blob.is_empty() {
        // An entry mid-creation, before its payload was written. Not an error — an empty secret.
        return Ok(Value::Object(Default::default()));
    }
    let opened = session.with_key(|dek| crypto::open(dek, id, nonce, blob))?;
    let bytes = opened.map_err(String::from)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| format!("this entry's contents could not be read back: {e}"))
}

// ---------------------------------------------------------------------------
// Password health
// ---------------------------------------------------------------------------

/// One entry's verdict. **No password, and no hash of one, ever leaves this module.**
///
/// That is the whole design constraint of this feature and the reason it lives in Rust rather than
/// being computed in the renderer from a list of decrypted items: answering "are any of my
/// passwords reused?" needs every password in memory at once, and the frontend is the one place
/// this app has decided they must never all be. So the comparison happens here, and what crosses
/// the boundary is three booleans and a group number.
#[derive(serde::Serialize)]
pub struct PasswordVerdict {
    pub item_id: String,
    pub title: String,
    /// Shared with at least one other entry. The number identifies *which* group, so the UI can say
    /// "these three share a password" without being told what it is.
    pub reuse_group: Option<u32>,
    /// Short, or drawn from too small an alphabet. See `password_strength`.
    pub weak: bool,
    /// Not changed in over a year, counted from `updated_at`.
    pub stale: bool,
    /// Days since the entry was last modified, for the "changed 400 days ago" line.
    pub age_days: i64,
}

#[derive(serde::Serialize)]
pub struct PasswordHealth {
    /// Entries that carry a password at all — the denominator of "3 of 24 are weak".
    pub checked: usize,
    pub verdicts: Vec<PasswordVerdict>,
}

/// The same three-step scale the unlock screen's meter uses, kept deliberately crude.
///
/// It is not an entropy estimate and does not pretend to be: length dominates, variety helps, and
/// anything under twelve characters is called weak regardless. A cleverer score would disagree with
/// the meter the user already saw when they created the password, and two different verdicts on the
/// same string is worse than one blunt one.
fn is_weak(password: &str) -> bool {
    let length = password.chars().count();
    if length < 12 {
        return true;
    }
    let classes = [
        password.chars().any(|c| c.is_ascii_lowercase()),
        password.chars().any(|c| c.is_ascii_uppercase()),
        password.chars().any(|c| c.is_ascii_digit()),
        password.chars().any(|c| !c.is_alphanumeric()),
    ]
    .iter()
    .filter(|present| **present)
    .count();
    // Sixteen characters of one class (a passphrase in lower case) is fine; twelve of one is not.
    classes < 2 && length < 16
}

/// Days between an ISO timestamp and now, or 0 when it cannot be read.
fn days_since(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|then| (chrono::Utc::now() - then.with_timezone(&chrono::Utc)).num_days())
        .unwrap_or(0)
}

/// Reused, weak and stale passwords across the whole keyring.
///
/// Requires the vault to be unlocked, like everything else that touches a payload. Entries with no
/// password field — a note, a card, a bare TOTP seed — are skipped rather than reported as fine:
/// they are not part of the question.
#[tauri::command]
pub fn keyvault_password_health(
    db: State<Db>,
    session: State<VaultSession>,
) -> Result<PasswordHealth, String> {
    session.with_key(|_| ())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let rows = queries::list_sealed_for_audit(&conn).map_err(|e| e.to_string())?;

    // Password → the rows carrying it. The map is dropped at the end of this function, and nothing
    // derived from its keys is returned.
    let mut by_password: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut verdicts: Vec<PasswordVerdict> = Vec::new();

    for (id, title, updated_at, nonce, blob) in rows {
        let secret = open_secret(&session, &id, &nonce, &blob)?;
        let password = secret
            .get("password")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if password.is_empty() {
            continue;
        }
        let age_days = days_since(&updated_at);
        by_password
            .entry(password.to_string())
            .or_default()
            .push(verdicts.len());
        verdicts.push(PasswordVerdict {
            item_id: id,
            title,
            reuse_group: None,
            weak: is_weak(password),
            stale: age_days > 365,
            age_days,
        });
    }

    // Group numbers are assigned in a stable order — by the position of each group's first entry —
    // so the report does not renumber itself between runs over unchanged data.
    let mut groups: Vec<Vec<usize>> = by_password
        .into_values()
        .filter(|indices| indices.len() > 1)
        .collect();
    groups.sort_by_key(|indices| indices[0]);
    for (group, indices) in groups.iter().enumerate() {
        for index in indices {
            verdicts[*index].reuse_group = Some(group as u32);
        }
    }

    Ok(PasswordHealth {
        checked: verdicts.len(),
        verdicts,
    })
}

#[cfg(test)]
mod health_tests {
    use super::is_weak;

    #[test]
    fn short_passwords_are_weak_however_varied() {
        assert!(is_weak("aA1!aA1!"));
        assert!(is_weak("Tr0ub4dor"));
    }

    #[test]
    fn a_long_generated_password_is_not_weak() {
        assert!(!is_weak("k7Qz-vR2m-Xp9L-td4W"));
    }

    #[test]
    fn a_long_single_class_passphrase_is_accepted() {
        // Sixteen or more characters of one class is a passphrase, not a weak password.
        assert!(!is_weak("correcthorsebatterystaple"));
        // Twelve of one class is still weak.
        assert!(is_weak("correcthors"));
    }

    #[test]
    fn twelve_characters_of_two_classes_passes() {
        assert!(!is_weak("abcdefgh1234"));
    }
}
