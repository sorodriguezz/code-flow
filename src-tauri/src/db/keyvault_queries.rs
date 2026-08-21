//! SQL for the keyring. Shaped like `note_queries`: column-list consts, private row mappers, one
//! `pub fn` per operation, `&Connection` in, `rusqlite::Result` out, and never a mutex.
//!
//! **This module does no cryptography.** It stores and returns `secret_nonce`/`secret_blob` as the
//! opaque strings they are; sealing and opening happen in `commands::keyvault_cmd`, which is the
//! only place that holds the key. Keeping the split means a bug here cannot leak a plaintext,
//! because there is never a plaintext in scope.
//!
//! **`ITEM_META_COLUMNS` has no ciphertext in it, and that is enforced by the type it maps to.**
//! `VaultItemMeta` has no such field, so `load_tree` physically cannot return one — the same
//! compiler-enforced rule that keeps note bodies out of the note list.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    VaultAuditRow, VaultBlobMeta, VaultFolderRow, VaultItemMeta, VaultTree,
};
use super::queries::now;

/// Everything except the sealed payload. What the list is built from.
const ITEM_META_COLUMNS: &str = "id, folder_id, kind, title, subtitle, site, tags, favorite, \
                                 workspace_id, sort_order, created_at, updated_at, deleted_at";
const FOLDER_COLUMNS: &str =
    "id, parent_id, name, color, workspace_id, sort_order, created_at, updated_at";
const BLOB_META_COLUMNS: &str = "id, item_id, name, mime, size_bytes, created_at";

/// A backstop on the audit log, so it cannot grow without bound over the app's lifetime.
const AUDIT_HARD_CAP: i64 = 5000;

/// The single `vault_meta` row's id. One vault per install.
pub const META_ID: &str = "vault";

fn map_folder(row: &rusqlite::Row) -> rusqlite::Result<VaultFolderRow> {
    Ok(VaultFolderRow {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        color: row.get(3)?,
        workspace_id: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_item_meta(row: &rusqlite::Row) -> rusqlite::Result<VaultItemMeta> {
    Ok(VaultItemMeta {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        subtitle: row.get(4)?,
        site: row.get(5)?,
        tags: row.get(6)?,
        favorite: row.get(7)?,
        workspace_id: row.get(8)?,
        sort_order: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        deleted_at: row.get(12)?,
        // Filled by `load_tree`'s own count query; zero everywhere else, where nothing draws it.
        attachments: 0,
    })
}

fn map_blob_meta(row: &rusqlite::Row) -> rusqlite::Result<VaultBlobMeta> {
    Ok(VaultBlobMeta {
        id: row.get(0)?,
        item_id: row.get(1)?,
        name: row.get(2)?,
        mime: row.get(3)?,
        size_bytes: row.get(4)?,
        created_at: row.get(5)?,
    })
}

// ---------------------------------------------------------------------------
// The vault itself
// ---------------------------------------------------------------------------

/// The stored key material and KDF parameters, or `None` on a machine with no vault yet.
pub struct VaultMeta {
    pub kdf_memory_kib: u32,
    pub kdf_iterations: u32,
    pub kdf_lanes: u32,
    pub kdf_salt: String,
    pub dek_nonce: String,
    pub dek_wrapped: String,
    pub autolock_minutes: u32,
}

pub fn get_meta(conn: &Connection) -> rusqlite::Result<Option<VaultMeta>> {
    conn.query_row(
        "SELECT kdf_memory_kib, kdf_iterations, kdf_lanes, kdf_salt, dek_nonce, dek_wrapped, \
         autolock_minutes FROM vault_meta WHERE id = ?1",
        params![META_ID],
        |row| {
            Ok(VaultMeta {
                kdf_memory_kib: row.get(0)?,
                kdf_iterations: row.get(1)?,
                kdf_lanes: row.get(2)?,
                kdf_salt: row.get(3)?,
                dek_nonce: row.get(4)?,
                dek_wrapped: row.get(5)?,
                autolock_minutes: row.get(6)?,
            })
        },
    )
    .optional()
}

/// Writes the vault's key material. Used both to create one and to re-wrap it under a new password.
pub fn put_meta(conn: &Connection, meta: &VaultMeta) -> rusqlite::Result<()> {
    let timestamp = now();
    conn.execute(
        "INSERT INTO vault_meta \
           (id, kdf, kdf_memory_kib, kdf_iterations, kdf_lanes, kdf_salt, dek_nonce, dek_wrapped, \
            autolock_minutes, created_at, updated_at) \
         VALUES (?1, 'argon2id', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) \
         ON CONFLICT(id) DO UPDATE SET \
           kdf_memory_kib = excluded.kdf_memory_kib, \
           kdf_iterations = excluded.kdf_iterations, \
           kdf_lanes = excluded.kdf_lanes, \
           kdf_salt = excluded.kdf_salt, \
           dek_nonce = excluded.dek_nonce, \
           dek_wrapped = excluded.dek_wrapped, \
           autolock_minutes = excluded.autolock_minutes, \
           updated_at = excluded.updated_at",
        params![
            META_ID,
            meta.kdf_memory_kib,
            meta.kdf_iterations,
            meta.kdf_lanes,
            meta.kdf_salt,
            meta.dek_nonce,
            meta.dek_wrapped,
            meta.autolock_minutes,
            timestamp
        ],
    )?;
    Ok(())
}

pub fn set_autolock(conn: &Connection, minutes: u32) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE vault_meta SET autolock_minutes = ?2, updated_at = ?3 WHERE id = ?1",
        params![META_ID, minutes, now()],
    )?;
    Ok(())
}

/// Destroys the keyring: the wrapped key, every entry, every attachment, the folders and the log.
///
/// **There is no undo and no partial version of this.** It exists because the alternative is worse:
/// a master password nobody remembers leaves a vault that cannot be opened, cannot be changed and
/// cannot be replaced, and the only way out would be editing the database file by hand. A door that
/// is hard to open on purpose is better than no door.
///
/// One transaction, and `vault_meta` goes last: if anything fails part-way, what survives is a
/// vault whose key still matches its contents rather than one with entries it can no longer read.
pub fn reset(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // `vault_blobs` cascades from `vault_items`, but it is named anyway: relying on the cascade
    // here would make this silently incomplete if that foreign key were ever relaxed.
    for table in ["vault_blobs", "vault_items", "vault_folders", "vault_audit", "vault_meta"] {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    }
    tx.commit()
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// The whole keyring in one round trip — folders, entry metadata, attachment counts. **No sealed
/// payloads and no attachment bytes.**
///
/// `workspace_id` narrows it the way the rest of the app does: entries filed under this workspace,
/// plus the global ones. The trash is left out; it has its own call.
pub fn load_tree(conn: &Connection, workspace_id: &str) -> rusqlite::Result<VaultTree> {
    let mut statement = conn.prepare(&format!(
        "SELECT {FOLDER_COLUMNS} FROM vault_folders \
         WHERE workspace_id = ?1 OR workspace_id = '' ORDER BY sort_order, name"
    ))?;
    let folders = statement
        .query_map(params![workspace_id], map_folder)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut statement = conn.prepare(&format!(
        "SELECT {ITEM_META_COLUMNS} FROM vault_items \
         WHERE deleted_at = '' AND (workspace_id = ?1 OR workspace_id = '') \
         ORDER BY favorite DESC, updated_at DESC"
    ))?;
    let mut items = statement
        .query_map(params![workspace_id], map_item_meta)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // One grouped count rather than one query per entry: a vault where every entry costs a round
    // trip to find out it has no attachments is a vault that opens slowly for no reason.
    let mut statement =
        conn.prepare("SELECT item_id, COUNT(*) FROM vault_blobs GROUP BY item_id")?;
    let counts: std::collections::HashMap<String, i64> = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for item in &mut items {
        item.attachments = counts.get(&item.id).copied().unwrap_or(0);
    }

    Ok(VaultTree { folders, items })
}

/// The soft-deleted entries, newest first.
pub fn list_trash(conn: &Connection) -> rusqlite::Result<Vec<VaultItemMeta>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {ITEM_META_COLUMNS} FROM vault_items WHERE deleted_at != '' \
         ORDER BY deleted_at DESC"
    ))?;
    let rows = statement
        .query_map([], map_item_meta)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// One entry's metadata and its **sealed** payload, for the caller to open.
pub fn get_sealed(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<(VaultItemMeta, String, String)>> {
    conn.query_row(
        &format!("SELECT {ITEM_META_COLUMNS}, secret_nonce, secret_blob FROM vault_items WHERE id = ?1"),
        params![id],
        |row| Ok((map_item_meta(row)?, row.get(13)?, row.get(14)?)),
    )
    .optional()
}

pub fn meta_of(conn: &Connection, id: &str) -> rusqlite::Result<Option<VaultItemMeta>> {
    conn.query_row(
        &format!("SELECT {ITEM_META_COLUMNS} FROM vault_items WHERE id = ?1"),
        params![id],
        map_item_meta,
    )
    .optional()
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

pub struct NewItem<'a> {
    pub folder_id: Option<&'a str>,
    pub kind: &'a str,
    pub title: &'a str,
    pub subtitle: &'a str,
    pub site: &'a str,
    pub tags: &'a str,
    pub workspace_id: &'a str,
    pub secret_nonce: &'a str,
    pub secret_blob: &'a str,
}

/// Creates an entry. The caller has already sealed the payload — this never sees a plaintext.
pub fn create_item(conn: &Connection, item: NewItem<'_>) -> rusqlite::Result<VaultItemMeta> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM vault_items WHERE folder_id IS ?1",
            params![item.folder_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        &format!(
            "INSERT INTO vault_items ({ITEM_META_COLUMNS}, secret_nonce, secret_blob) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?10, '', ?11, ?12)"
        ),
        params![
            id,
            item.folder_id,
            item.kind,
            item.title,
            item.subtitle,
            item.site,
            item.tags,
            item.workspace_id,
            sort_order,
            timestamp,
            item.secret_nonce,
            item.secret_blob
        ],
    )?;
    meta_of(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Saves an entry: its visible fields and its freshly sealed payload, in one statement.
///
/// The payload is always rewritten, even when only the title changed, and that is deliberate: a
/// fresh nonce on every save means two versions of the same entry never share one, and the cost is
/// a few hundred bytes.
pub fn update_item(
    conn: &Connection,
    id: &str,
    title: &str,
    subtitle: &str,
    site: &str,
    tags: &str,
    secret_nonce: &str,
    secret_blob: &str,
) -> rusqlite::Result<Option<VaultItemMeta>> {
    let changed = conn.execute(
        "UPDATE vault_items SET title = ?2, subtitle = ?3, site = ?4, tags = ?5, \
         secret_nonce = ?6, secret_blob = ?7, updated_at = ?8 WHERE id = ?1",
        params![id, title, subtitle, site, tags, secret_nonce, secret_blob, now()],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    meta_of(conn, id)
}

/// Refiles an entry into another folder. `updated_at` is left alone — filing is not writing, the
/// same rule `note_queries::move_note` states.
pub fn move_item(conn: &Connection, id: &str, folder_id: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE vault_items SET folder_id = ?2 WHERE id = ?1",
        params![id, folder_id],
    )?;
    Ok(())
}

/// Files an entry under a workspace, or under none (`""` — everywhere).
pub fn set_item_workspace(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE vault_items SET workspace_id = ?2 WHERE id = ?1",
        params![id, workspace_id],
    )?;
    Ok(())
}

pub fn set_favorite(conn: &Connection, id: &str, favorite: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE vault_items SET favorite = ?2 WHERE id = ?1",
        params![id, favorite],
    )?;
    Ok(())
}

/// Moves an entry to the trash. **Never deletes.**
///
/// A password removed by a mis-click and gone for good is the worst thing this feature can do, and
/// it is a single keystroke away in any list. `purge_item` is the one that really removes.
pub fn soft_delete_item(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE vault_items SET deleted_at = ?2 WHERE id = ?1 AND deleted_at = ''",
        params![id, now()],
    )?;
    Ok(())
}

pub fn restore_item(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE vault_items SET deleted_at = '' WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Really removes an entry, and its attachments with it through the foreign key's cascade.
pub fn purge_item(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM vault_items WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn empty_trash(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM vault_items WHERE deleted_at != ''", [])
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

pub fn create_folder(
    conn: &Connection,
    parent_id: Option<&str>,
    name: &str,
    workspace_id: &str,
) -> rusqlite::Result<VaultFolderRow> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let sort_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM vault_folders WHERE parent_id IS ?1",
            params![parent_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        &format!("INSERT INTO vault_folders ({FOLDER_COLUMNS}) VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?6)"),
        params![id, parent_id, name, workspace_id, sort_order, timestamp],
    )?;
    Ok(VaultFolderRow {
        id,
        parent_id: parent_id.map(str::to_string),
        name: name.to_string(),
        color: String::new(),
        workspace_id: workspace_id.to_string(),
        sort_order,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    })
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE vault_folders SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, now()],
    )?;
    Ok(())
}

pub fn set_folder_color(conn: &Connection, id: &str, color: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE vault_folders SET color = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, color, now()],
    )?;
    Ok(())
}

pub fn set_folder_workspace(
    conn: &Connection,
    id: &str,
    workspace_id: &str,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // The entries in it go too: a folder visible only in one workspace whose entries are visible
    // everywhere would show as empty from every other one.
    tx.execute(
        "UPDATE vault_items SET workspace_id = ?2 WHERE folder_id = ?1",
        params![id, workspace_id],
    )?;
    tx.execute(
        "UPDATE vault_folders SET workspace_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, workspace_id, now()],
    )?;
    tx.commit()
}

/// Whether `folder_id` is `ancestor_id` or sits underneath it — the guard on [`move_folder`].
///
/// Bounded by the row count, the same way `note_queries::is_within` is: a database that already
/// contains a cycle must not spin here.
fn is_within(conn: &Connection, folder_id: &str, ancestor_id: &str) -> rusqlite::Result<bool> {
    let depth: i64 = conn.query_row("SELECT COUNT(*) FROM vault_folders", [], |row| row.get(0))?;
    let mut current = Some(folder_id.to_string());
    for _ in 0..=depth {
        let Some(id) = current else { return Ok(false) };
        if id == ancestor_id {
            return Ok(true);
        }
        current = conn
            .query_row(
                "SELECT parent_id FROM vault_folders WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
    }
    Ok(false)
}

/// `Ok(false)` means the move was refused because it would put the folder inside itself — a
/// legitimate thing for a drag to attempt, not an error to raise.
pub fn move_folder(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
) -> rusqlite::Result<bool> {
    if let Some(parent) = parent_id {
        if parent == id || is_within(conn, parent, id)? {
            return Ok(false);
        }
    }
    conn.execute(
        "UPDATE vault_folders SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, parent_id, now()],
    )?;
    Ok(true)
}

/// Deletes a folder and its subfolders — and **keeps every entry**, moving them to the root.
///
/// The opposite of `note_queries::delete_book`, deliberately. There, a note outside a book has no
/// surface to be reached from, so deleting the book has to take the notes. Here an entry with no
/// folder is an ordinary entry in an ordinary list, and the alternative — a folder delete that
/// silently takes six passwords with it — is not a trade worth making in a vault.
pub fn delete_folder(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 \
             UNION ALL \
             SELECT folder.id FROM vault_folders folder JOIN subtree ON folder.parent_id = subtree.id \
         ) \
         UPDATE vault_items SET folder_id = NULL WHERE folder_id IN (SELECT id FROM subtree)",
        params![id],
    )?;
    tx.execute("DELETE FROM vault_folders WHERE id = ?1", params![id])?;
    tx.commit()
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

pub fn list_blobs(conn: &Connection, item_id: &str) -> rusqlite::Result<Vec<VaultBlobMeta>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {BLOB_META_COLUMNS} FROM vault_blobs WHERE item_id = ?1 ORDER BY created_at"
    ))?;
    let rows = statement
        .query_map(params![item_id], map_blob_meta)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Stores an attachment.
///
/// `id` is minted by the *caller*, not here, and that is not arbitrary: the id is the AAD the bytes
/// were sealed under, so it has to exist before the sealing. A query that minted its own would
/// force the caller to seal twice.
pub fn add_blob(
    conn: &Connection,
    id: &str,
    item_id: &str,
    name: &str,
    mime: &str,
    size_bytes: i64,
    nonce: &str,
    data: &str,
) -> rusqlite::Result<VaultBlobMeta> {
    let timestamp = now();
    conn.execute(
        "INSERT INTO vault_blobs (id, item_id, name, mime, size_bytes, nonce, data, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, item_id, name, mime, size_bytes, nonce, data, timestamp],
    )?;
    Ok(VaultBlobMeta {
        id: id.to_string(),
        item_id: item_id.to_string(),
        name: name.to_string(),
        mime: mime.to_string(),
        size_bytes,
        created_at: timestamp,
    })
}

/// One attachment's sealed bytes, for the caller to open.
pub fn get_sealed_blob(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<(VaultBlobMeta, String, String)>> {
    conn.query_row(
        &format!("SELECT {BLOB_META_COLUMNS}, nonce, data FROM vault_blobs WHERE id = ?1"),
        params![id],
        |row| Ok((map_blob_meta(row)?, row.get(6)?, row.get(7)?)),
    )
    .optional()
}

pub fn delete_blob(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM vault_blobs WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/// Records that something happened. Never fails the operation it is recording — a vault that
/// refuses to open a password because its log is full would be absurd.
pub fn record_audit(conn: &Connection, item_id: &str, action: &str) {
    let _ = conn.execute(
        "INSERT INTO vault_audit (id, item_id, action, at) VALUES (?1, ?2, ?3, ?4)",
        params![Uuid::new_v4().to_string(), item_id, action, now()],
    );
    // Trimmed inline rather than on a schedule, the way `datasource_queries::add_history` does it.
    let _ = conn.execute(
        "DELETE FROM vault_audit WHERE id NOT IN \
           (SELECT id FROM vault_audit ORDER BY at DESC LIMIT ?1)",
        params![AUDIT_HARD_CAP],
    );
}

pub fn list_audit(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<VaultAuditRow>> {
    let mut statement = conn
        .prepare("SELECT id, item_id, action, at FROM vault_audit ORDER BY at DESC LIMIT ?1")?;
    let rows = statement
        .query_map(params![limit], |row| {
            Ok(VaultAuditRow {
                id: row.get(0)?,
                item_id: row.get(1)?,
                action: row.get(2)?,
                at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn item(conn: &Connection, title: &str, workspace_id: &str) -> VaultItemMeta {
        create_item(
            conn,
            NewItem {
                folder_id: None,
                kind: "login",
                title,
                subtitle: "ana@example.test",
                site: "example.test",
                tags: "[]",
                workspace_id,
                secret_nonce: "nonce",
                secret_blob: "sealed",
            },
        )
        .unwrap()
    }

    /// The rule the type system is enforcing, asserted anyway: what the list returns has no
    /// ciphertext in it. A future refactor that widened `VaultItemMeta` would fail here.
    #[test]
    fn the_tree_carries_no_sealed_payloads() {
        let conn = setup();
        item(&conn, "GitHub", "");
        let tree = load_tree(&conn, "w1").unwrap();
        assert_eq!(tree.items.len(), 1);
        let json = serde_json::to_string(&tree).unwrap();
        assert!(!json.contains("sealed"), "the tree must not carry ciphertext: {json}");
        assert!(!json.contains("secret_blob"));
    }

    /// Global entries are on every workspace's list; filed ones are not.
    #[test]
    fn an_entry_filed_under_a_workspace_is_only_listed_there() {
        let conn = setup();
        item(&conn, "Everywhere", "");
        item(&conn, "Only w1", "w1");

        let w1: Vec<String> = load_tree(&conn, "w1").unwrap().items.into_iter().map(|i| i.title).collect();
        assert_eq!(w1.len(), 2);
        let w2: Vec<String> = load_tree(&conn, "w2").unwrap().items.into_iter().map(|i| i.title).collect();
        assert_eq!(w2, ["Everywhere"]);
    }

    /// A mis-click must be recoverable. Deleting moves to the trash; only a purge really removes.
    #[test]
    fn deleting_an_entry_puts_it_in_the_trash_rather_than_removing_it() {
        let conn = setup();
        let entry = item(&conn, "GitHub", "");
        soft_delete_item(&conn, &entry.id).unwrap();

        assert!(load_tree(&conn, "").unwrap().items.is_empty(), "gone from the list");
        assert_eq!(list_trash(&conn).unwrap().len(), 1, "…but in the trash");

        restore_item(&conn, &entry.id).unwrap();
        assert_eq!(load_tree(&conn, "").unwrap().items.len(), 1, "and it comes back");

        purge_item(&conn, &entry.id).unwrap();
        assert!(load_tree(&conn, "").unwrap().items.is_empty());
        assert!(list_trash(&conn).unwrap().is_empty());
    }

    /// The opposite of `delete_book`, and the comment on `delete_folder` says why: a folder delete
    /// that silently took six passwords with it is not a trade worth making.
    #[test]
    fn deleting_a_folder_keeps_its_entries() {
        let conn = setup();
        let folder = create_folder(&conn, None, "Work", "").unwrap();
        let entry = item(&conn, "GitHub", "");
        move_item(&conn, &entry.id, Some(&folder.id)).unwrap();

        delete_folder(&conn, &folder.id).unwrap();

        let tree = load_tree(&conn, "").unwrap();
        assert!(tree.folders.is_empty());
        assert_eq!(tree.items.len(), 1, "the entry survived");
        assert_eq!(tree.items[0].folder_id, None, "…at the root");
    }

    #[test]
    fn a_folder_cannot_be_dropped_inside_itself() {
        let conn = setup();
        let parent = create_folder(&conn, None, "Work", "").unwrap();
        let child = create_folder(&conn, Some(&parent.id), "Cloud", "").unwrap();
        assert!(!move_folder(&conn, &parent.id, Some(&child.id)).unwrap());
        assert!(!move_folder(&conn, &parent.id, Some(&parent.id)).unwrap());
        assert!(move_folder(&conn, &child.id, None).unwrap(), "an ordinary move still works");
    }

    /// Purging takes the attachments with it, through the foreign key.
    #[test]
    fn purging_an_entry_takes_its_attachments() {
        let conn = setup();
        let entry = item(&conn, "Passport", "");
        add_blob(&conn, "blob-1", &entry.id, "passport.jpg", "image/jpeg", 1024, "nonce", "sealed")
            .unwrap();
        assert_eq!(list_blobs(&conn, &entry.id).unwrap().len(), 1);

        purge_item(&conn, &entry.id).unwrap();
        assert!(list_blobs(&conn, &entry.id).unwrap().is_empty());
    }

    #[test]
    fn the_tree_says_how_many_files_an_entry_has_without_reading_them() {
        let conn = setup();
        let entry = item(&conn, "Passport", "");
        add_blob(&conn, "blob-1", &entry.id, "front.jpg", "image/jpeg", 10, "n", "sealed").unwrap();
        add_blob(&conn, "blob-2", &entry.id, "back.jpg", "image/jpeg", 10, "n", "sealed").unwrap();

        let tree = load_tree(&conn, "").unwrap();
        assert_eq!(tree.items[0].attachments, 2);
        assert!(!serde_json::to_string(&tree).unwrap().contains("sealed"));
    }

    /// Filing a folder under a workspace has to carry its entries, or the folder shows as empty
    /// from everywhere else.
    #[test]
    fn filing_a_folder_under_a_workspace_carries_its_entries() {
        let conn = setup();
        let folder = create_folder(&conn, None, "Work", "").unwrap();
        let entry = item(&conn, "GitHub", "");
        move_item(&conn, &entry.id, Some(&folder.id)).unwrap();

        set_folder_workspace(&conn, &folder.id, "w1").unwrap();

        assert_eq!(load_tree(&conn, "w1").unwrap().items.len(), 1);
        assert!(load_tree(&conn, "w2").unwrap().items.is_empty());
    }

    /// A password must not disappear because a workspace was tidied up. The vault's tables carry no
    /// foreign key, so nothing would *delete* it — the failure would be quieter: a row pointing at
    /// a workspace that no longer exists, which no view lists.
    #[test]
    fn deleting_a_workspace_makes_its_entries_global_rather_than_unreachable() {
        let conn = setup();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) \
               VALUES ('w1', 'One', '', '', 0, 't');
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) \
               VALUES ('w2', 'Two', '', '', 1, 't');",
        )
        .unwrap();
        let entry = item(&conn, "Filed", "w1");

        crate::db::queries::delete_workspace(&conn, "w1").unwrap();

        let still_there = meta_of(&conn, &entry.id).unwrap().expect("the entry survived");
        assert_eq!(still_there.workspace_id, "", "and it is reachable from everywhere");
        assert_eq!(load_tree(&conn, "w2").unwrap().items.len(), 1);
    }

    /// The escape hatch has to actually clear everything, or "create a new keyring" would keep
    /// refusing — which is the dead end it exists to open.
    #[test]
    fn resetting_leaves_a_machine_with_no_keyring_at_all() {
        let conn = setup();
        put_meta(
            &conn,
            &VaultMeta {
                kdf_memory_kib: 1,
                kdf_iterations: 1,
                kdf_lanes: 1,
                kdf_salt: "salt".into(),
                dek_nonce: "nonce".into(),
                dek_wrapped: "wrapped".into(),
                autolock_minutes: 15,
            },
        )
        .unwrap();
        let folder = create_folder(&conn, None, "Work", "").unwrap();
        let entry = item(&conn, "GitHub", "");
        move_item(&conn, &entry.id, Some(&folder.id)).unwrap();
        add_blob(&conn, "b1", &entry.id, "f.jpg", "image/jpeg", 10, "n", "sealed").unwrap();
        record_audit(&conn, &entry.id, "reveal");
        // …and one in the trash, which a naive delete over the live list would miss.
        let binned = item(&conn, "Old", "");
        soft_delete_item(&conn, &binned.id).unwrap();

        reset(&conn).unwrap();

        assert!(get_meta(&conn).unwrap().is_none(), "the wrapped key is gone");
        let tree = load_tree(&conn, "").unwrap();
        assert!(tree.items.is_empty() && tree.folders.is_empty());
        assert!(list_trash(&conn).unwrap().is_empty(), "including the trash");
        assert!(list_blobs(&conn, &entry.id).unwrap().is_empty());
        assert!(list_audit(&conn, 100).unwrap().is_empty());
    }

    #[test]
    fn the_audit_log_is_capped() {
        let conn = setup();
        for _ in 0..(AUDIT_HARD_CAP + 20) {
            record_audit(&conn, "item", "reveal");
        }
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_audit", [], |row| row.get(0))
            .unwrap();
        assert_eq!(total, AUDIT_HARD_CAP);
    }
}
