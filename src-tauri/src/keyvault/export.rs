//! Getting the keyring out — so a keyring that can import from Bitwarden and 1Password is not a
//! keyring that can only be left by retyping it.
//!
//! Two exports, for two different jobs:
//!
//! - **The encrypted CodeFlow export** (`.cfkeyring`): everything — folders, entries, attachments —
//!   sealed under a passphrase the user chooses, and read back by [`restore`]. The envelope is the
//!   full backup's construction (`backup::envelope`): Argon2id derives the key from the passphrase,
//!   AES-256-GCM seals the deflated JSON, and the plaintext header — KDF parameters and nonce, no
//!   user data — is the AEAD's associated data, so lowering the Argon2 cost in the header fails the
//!   tag rather than producing a weaker file. Its own magic and format name, so a keyring export and
//!   a full backup can never be mistaken for each other.
//! - **The unencrypted Bitwarden-compatible export** (JSON or CSV): what other password managers
//!   import. Plain text by definition, so the command in front of it asks for the master password
//!   again and the dialog says what it leaves out: attachments (Bitwarden's unencrypted exports have
//!   no room for them), tags, workspace filing, folder colours — and it flattens the kinds Bitwarden
//!   has no type for into secure notes with custom fields.
//!
//! **Nothing here crosses the IPC bridge in the clear.** The commands take a path the user picked in
//! a save dialog and write the file themselves; the plaintext keyring exists only in this process,
//! for as long as it takes to seal or write it. That is the same rule `keyvault_get_item` keeps by
//! returning exactly one entry: a compromised renderer cannot drain the vault through an export.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use flate2::write::{ZlibDecoder, ZlibEncoder};
use flate2::Compression;
use rand::TryRngCore as _;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write as _;
use zeroize::Zeroize as _;

use super::crypto::{self, KdfParams, KEY_LEN, NONCE_LEN, SALT_LEN};
use crate::db::keyvault_queries as queries;

/// Identifies the file before anything else is read, so picking the wrong one says so rather than
/// failing later as "wrong passphrase". The extension, `.cfkeyring`, is the frontend's to propose
/// (`lib/vault/exportFile.ts`); the magic is what decides.
const MAGIC: &[u8; 8] = b"CFKEYX\x01\n";

pub const FORMAT: &str = "codeflow-keyring-export";

/// Bumped only when a reader of this version could no longer make sense of the file; a newer file is
/// refused rather than half-restored.
pub const FORMAT_VERSION: u32 = 1;

/// A wrong export passphrase — its own code, because "that is not the master password" would be the
/// wrong sentence: an export is sealed under a passphrase chosen for it. Mapped in
/// `lib/vault/errors.ts`.
pub const CODE_WRONG_PASSPHRASE: &str = "cf-keyvault/wrong-passphrase";

/// A ceiling on the header, so a corrupt length cannot allocate a gigabyte first.
const MAX_HEADER_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// The keyring, in the clear
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportedFolder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportedAttachment {
    pub name: String,
    pub mime: String,
    /// The file's bytes, base64.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportedItem {
    pub id: String,
    pub folder_id: Option<String>,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub site: String,
    /// JSON array of strings, verbatim as stored.
    #[serde(default = "empty_tags")]
    pub tags: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub workspace_id: String,
    /// The decrypted payload: the same JSON object `keyvault_get_item` returns as `secret`.
    pub secret: Value,
    #[serde(default)]
    pub attachments: Vec<ExportedAttachment>,
}

fn empty_tags() -> String {
    "[]".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyringExport {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub folders: Vec<ExportedFolder>,
    pub items: Vec<ExportedItem>,
}

/// Every folder and every live entry, decrypted with `dek`, attachments included. The trash is left
/// out: an export is "what I have", and restoring deleted entries into another vault is not what
/// anybody means by it.
pub fn collect(conn: &Connection, dek: &[u8; KEY_LEN]) -> Result<KeyringExport, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, parent_id, name, color, workspace_id FROM vault_folders \
             ORDER BY sort_order, name",
        )
        .map_err(|e| e.to_string())?;
    let folders = statement
        .query_map([], |row| {
            Ok(ExportedFolder {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                color: row.get(3)?,
                workspace_id: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for (id, _, _, nonce, blob) in queries::list_sealed_for_audit(conn).map_err(|e| e.to_string())? {
        let Some(meta) = queries::meta_of(conn, &id).map_err(|e| e.to_string())? else {
            continue;
        };
        let secret = if nonce.is_empty() || blob.is_empty() {
            Value::Object(Default::default())
        } else {
            let mut plain = crypto::open(dek, &id, &nonce, &blob).map_err(String::from)?;
            let value = serde_json::from_slice(&plain)
                .map_err(|e| format!("“{}” could not be read back: {e}", meta.title));
            plain.zeroize();
            value?
        };
        let mut attachments = Vec::new();
        for blob_meta in queries::list_blobs(conn, &id).map_err(|e| e.to_string())? {
            let Some((stored, nonce, data)) =
                queries::get_sealed_blob(conn, &blob_meta.id).map_err(|e| e.to_string())?
            else {
                continue;
            };
            let mut bytes = crypto::open(dek, &stored.id, &nonce, &data).map_err(String::from)?;
            attachments.push(ExportedAttachment {
                name: stored.name,
                mime: stored.mime,
                data: B64.encode(&bytes),
            });
            bytes.zeroize();
        }
        items.push(ExportedItem {
            id: meta.id,
            folder_id: meta.folder_id,
            kind: meta.kind,
            title: meta.title,
            subtitle: meta.subtitle,
            site: meta.site,
            tags: meta.tags,
            favorite: meta.favorite,
            workspace_id: meta.workspace_id,
            secret,
            attachments,
        });
    }

    Ok(KeyringExport {
        format: FORMAT.to_string(),
        version: FORMAT_VERSION,
        exported_at: crate::db::queries::now(),
        folders,
        items,
    })
}

// ---------------------------------------------------------------------------
// The encrypted file
// ---------------------------------------------------------------------------

/// Everything readable without the passphrase — what is needed to derive the key, and nothing about
/// what is inside.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Header {
    format: String,
    version: u32,
    created_at: String,
    app_version: String,
    kdf: HeaderKdf,
    cipher: HeaderCipher,
    compression: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HeaderKdf {
    name: String,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    lanes: u32,
    salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HeaderCipher {
    name: String,
    nonce: String,
}

/// Why an encrypted export could not be opened, in the three ways a person can do something about.
#[derive(Debug, PartialEq)]
pub enum OpenError {
    NotAnExport,
    TooNew(u32),
    /// The tag did not verify: a wrong passphrase or an altered file, indistinguishable by design.
    WrongPassphrase,
    Other(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAnExport => write!(f, "this file is not a CodeFlow keyring export"),
            Self::TooNew(v) => write!(f, "keyring export format {v} is newer than this version of CodeFlow"),
            Self::WrongPassphrase => write!(f, "{CODE_WRONG_PASSPHRASE}"),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

fn random(len: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; len];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| format!("the system random number generator failed: {e}"))?;
    Ok(bytes)
}

/// Seals a keyring under `passphrase`. ~100 ms of Argon2 by design: run it off the async runtime.
pub fn seal(export: &KeyringExport, passphrase: &str, app_version: &str) -> Result<Vec<u8>, String> {
    if passphrase.chars().count() < crypto::MIN_MASTER_LENGTH {
        return Err(crypto::CODE_TOO_SHORT.to_string());
    }
    let mut plaintext = serde_json::to_vec(export).map_err(|e| e.to_string())?;
    let compressed = {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        let written = encoder.write_all(&plaintext).and_then(|_| encoder.finish());
        plaintext.zeroize();
        written.map_err(|e| e.to_string())?
    };

    let salt = random(SALT_LEN)?;
    let nonce = random(NONCE_LEN)?;
    let header = Header {
        format: FORMAT.to_string(),
        version: FORMAT_VERSION,
        created_at: chrono::Utc::now().to_rfc3339(),
        app_version: app_version.to_string(),
        kdf: HeaderKdf {
            name: "argon2id".into(),
            version: 19,
            memory_kib: crypto::ARGON_MEMORY_KIB,
            iterations: crypto::ARGON_ITERATIONS,
            lanes: crypto::ARGON_LANES,
            salt: B64.encode(&salt),
        },
        cipher: HeaderCipher { name: "AES-256-GCM".into(), nonce: B64.encode(&nonce) },
        compression: "deflate".into(),
    };
    let header_bytes = serde_json::to_vec(&header).map_err(|e| e.to_string())?;

    let mut key = crypto::derive_kek(passphrase, &kdf_of(&header.kdf)).map_err(String::from)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string());
    key.zeroize();
    let sealed = cipher?
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &compressed, aad: &header_bytes })
        .map_err(|_| "the keyring could not be encrypted".to_string())?;

    let mut out = Vec::with_capacity(MAGIC.len() + 4 + header_bytes.len() + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn kdf_of(header: &HeaderKdf) -> KdfParams {
    KdfParams {
        memory_kib: header.memory_kib,
        iterations: header.iterations,
        lanes: header.lanes,
        salt: header.salt.clone(),
    }
}

/// Whether these bytes start like an encrypted keyring export — what the import screen sniffs.
pub fn is_export(bytes: &[u8]) -> bool {
    bytes.len() >= MAGIC.len() && &bytes[..MAGIC.len()] == MAGIC
}

/// Verifies, decrypts and decompresses an export. ~100 ms of Argon2: off the async runtime.
pub fn open(bytes: &[u8], passphrase: &str) -> Result<KeyringExport, OpenError> {
    if !is_export(bytes) || bytes.len() < MAGIC.len() + 4 {
        return Err(OpenError::NotAnExport);
    }
    let mut length = [0u8; 4];
    length.copy_from_slice(&bytes[MAGIC.len()..MAGIC.len() + 4]);
    let header_len = u32::from_le_bytes(length) as usize;
    let start = MAGIC.len() + 4;
    if header_len == 0 || header_len > MAX_HEADER_BYTES || start + header_len > bytes.len() {
        return Err(OpenError::NotAnExport);
    }
    let header_bytes = &bytes[start..start + header_len];
    let header: Header = serde_json::from_slice(header_bytes).map_err(|_| OpenError::NotAnExport)?;
    if header.format != FORMAT {
        return Err(OpenError::NotAnExport);
    }
    if header.version > FORMAT_VERSION {
        return Err(OpenError::TooNew(header.version));
    }
    if header.kdf.name != "argon2id" || header.cipher.name != "AES-256-GCM" || header.compression != "deflate" {
        return Err(OpenError::Other("this keyring export uses a scheme CodeFlow does not know".into()));
    }
    let nonce = B64.decode(&header.cipher.nonce).map_err(|_| OpenError::NotAnExport)?;
    if nonce.len() != NONCE_LEN {
        return Err(OpenError::NotAnExport);
    }

    let mut key = crypto::derive_kek(passphrase, &kdf_of(&header.kdf))
        .map_err(|e| OpenError::Other(e.to_string()))?;
    let cipher = Aes256Gcm::new_from_slice(&key);
    key.zeroize();
    let compressed = cipher
        .map_err(|e| OpenError::Other(e.to_string()))?
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: &bytes[start + header_len..], aad: header_bytes },
        )
        .map_err(|_| OpenError::WrongPassphrase)?;

    let mut decoder = ZlibDecoder::new(Vec::new());
    decoder.write_all(&compressed).map_err(|e| OpenError::Other(e.to_string()))?;
    let mut plaintext = decoder.finish().map_err(|e| OpenError::Other(e.to_string()))?;
    let parsed = serde_json::from_slice::<KeyringExport>(&plaintext);
    plaintext.zeroize();
    let export = parsed.map_err(|e| OpenError::Other(format!("the export's contents are not readable: {e}")))?;
    if export.format != FORMAT {
        return Err(OpenError::NotAnExport);
    }
    Ok(export)
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/// What a restore wrote.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct RestoreCounts {
    pub folders: usize,
    pub items: usize,
    pub attachments: usize,
}

/// Writes an export into the open vault, sealing everything under its `dek`.
///
/// **Added, never merged over.** Every entry arrives as a new one, like an import from Bitwarden —
/// the file is somebody's keyring at a moment, and deciding which of its entries "are" which of the
/// vault's would be a guess made about passwords. Folders are the exception: a folder of the same
/// name under the same parent is reused, so restoring twice does not grow a second tree of empty
/// folders beside the first. Entries keep their workspace filing only when that workspace exists
/// here; otherwise they are global, which is where a new entry lives anyway.
pub fn restore(conn: &Connection, dek: &[u8; KEY_LEN], export: &KeyringExport) -> Result<RestoreCounts, String> {
    let mut counts = RestoreCounts::default();
    let workspace_exists = |id: &str| -> bool {
        !id.is_empty()
            && conn
                .query_row("SELECT 1 FROM workspaces WHERE id = ?1", params![id], |_| Ok(()))
                .is_ok()
    };

    // Folders parents-first, so each one's new parent id is known when it is made. A folder whose
    // parent is not in the file lands at the root; a cycle cannot occur in a tree read from a table
    // whose writer refuses one, and the loop is bounded anyway.
    let mut folder_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut pending: Vec<&ExportedFolder> = export.folders.iter().collect();
    for _ in 0..=export.folders.len() {
        if pending.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for folder in pending {
            let parent = match &folder.parent_id {
                Some(parent) if export.folders.iter().any(|f| &f.id == parent) => match folder_ids.get(parent) {
                    Some(new_parent) => Some(new_parent.clone()),
                    None => {
                        next.push(folder);
                        continue;
                    }
                },
                _ => None,
            };
            let workspace = if workspace_exists(&folder.workspace_id) { folder.workspace_id.as_str() } else { "" };
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM vault_folders WHERE name = ?1 AND parent_id IS ?2 LIMIT 1",
                    params![folder.name, parent],
                    |row| row.get(0),
                )
                .ok();
            let id = match existing {
                Some(id) => id,
                None => {
                    counts.folders += 1;
                    queries::create_folder(conn, parent.as_deref(), &folder.name, workspace)
                        .map_err(|e| e.to_string())?
                        .id
                }
            };
            folder_ids.insert(folder.id.clone(), id);
        }
        pending = next;
    }

    for item in &export.items {
        let folder = item.folder_id.as_ref().and_then(|id| folder_ids.get(id)).map(String::as_str);
        let workspace = if workspace_exists(&item.workspace_id) { item.workspace_id.as_str() } else { "" };
        let created = queries::create_item(
            conn,
            queries::NewItem {
                folder_id: folder,
                kind: &item.kind,
                title: &item.title,
                subtitle: &item.subtitle,
                site: &item.site,
                tags: &item.tags,
                workspace_id: workspace,
                secret_nonce: "",
                secret_blob: "",
            },
        )
        .map_err(|e| e.to_string())?;
        // Sealed under the *new* id: the id is the AAD, so a payload cannot be carried across rows.
        let mut payload = serde_json::to_vec(&item.secret).map_err(|e| e.to_string())?;
        let sealed = crypto::seal(dek, &created.id, &payload).map_err(String::from);
        payload.zeroize();
        let (nonce, blob) = sealed?;
        queries::update_item(
            conn,
            &created.id,
            &item.title,
            &item.subtitle,
            &item.site,
            &item.tags,
            &nonce,
            &blob,
        )
        .map_err(|e| e.to_string())?;
        if item.favorite {
            queries::set_favorite(conn, &created.id, true).map_err(|e| e.to_string())?;
        }
        for attachment in &item.attachments {
            let mut bytes = B64
                .decode(&attachment.data)
                .map_err(|_| format!("an attachment of “{}” is not readable", item.title))?;
            let blob_id = uuid::Uuid::new_v4().to_string();
            let sealed = crypto::seal(dek, &blob_id, &bytes).map_err(String::from);
            let size = bytes.len() as i64;
            bytes.zeroize();
            let (nonce, data) = sealed?;
            queries::add_blob(conn, &blob_id, &created.id, &attachment.name, &attachment.mime, size, &nonce, &data)
                .map_err(|e| e.to_string())?;
            counts.attachments += 1;
        }
        counts.items += 1;
    }
    Ok(counts)
}

// ---------------------------------------------------------------------------
// Bitwarden
// ---------------------------------------------------------------------------

/// What a Bitwarden export leaves behind, counted — the dialog says it before, the summary after.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct LeftOut {
    pub attachments: usize,
    pub tagged: usize,
    /// Entries of a kind Bitwarden has no type for, exported as secure notes with custom fields.
    pub flattened: usize,
}

pub fn left_out(export: &KeyringExport) -> LeftOut {
    LeftOut {
        attachments: export.items.iter().map(|item| item.attachments.len()).sum(),
        tagged: export.items.iter().filter(|item| tags_of(item).len() > 0).count(),
        flattened: export
            .items
            .iter()
            .filter(|item| matches!(item.kind.as_str(), "key" | "storage" | "file"))
            .count(),
    }
}

fn tags_of(item: &ExportedItem) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&item.tags).unwrap_or_default()
}

fn text(secret: &Value, key: &str) -> Option<String> {
    secret.get(key).and_then(Value::as_str).map(str::to_string).filter(|value| !value.is_empty())
}

/// A folder's full path, `Parent/Child` — Bitwarden's way of nesting, since its folders are flat.
fn folder_path(folders: &[ExportedFolder], id: &str) -> String {
    let mut names = Vec::new();
    let mut current = folders.iter().find(|folder| folder.id == id);
    for _ in 0..=folders.len() {
        let Some(folder) = current else { break };
        names.push(folder.name.replace('/', "-"));
        current = folder.parent_id.as_ref().and_then(|parent| folders.iter().find(|f| &f.id == parent));
    }
    names.reverse();
    names.join("/")
}

/// The secret fields a kind puts in Bitwarden's own slots; everything else becomes a custom field.
fn claimed(kind: &str) -> &'static [&'static str] {
    match kind {
        "login" | "database" | "server" => &["username", "password", "totp", "notes", "custom"],
        "card" => &["cardholder", "cardNumber", "cvv", "expiry", "notes", "custom"],
        "identity" => &["fullName", "documentNumber", "notes", "custom"],
        _ => &["notes", "custom"],
    }
}

/// Which fields hold secrets, for Bitwarden's hidden (1) versus text (0) custom field type — the
/// same list the app masks by (`SECRET_FIELDS` in the frontend).
fn is_secret_field(name: &str) -> bool {
    matches!(
        name,
        "password"
            | "totp"
            | "recoveryCodes"
            | "apiKey"
            | "privateKey"
            | "passphrase"
            | "connectionString"
            | "secretAccessKey"
            | "token"
            | "cardNumber"
            | "cvv"
            | "pin"
            | "documentNumber"
    )
}

/// Custom fields: the entry's own, then every secret field no Bitwarden slot took, in a stable order.
fn custom_fields(item: &ExportedItem) -> Vec<(String, String, bool)> {
    let mut fields: Vec<(String, String, bool)> = Vec::new();
    if let Some(Value::Array(own)) = item.secret.get("custom") {
        for field in own {
            let name = field.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let value = field.get("value").and_then(Value::as_str).unwrap_or("").to_string();
            let secret = field.get("secret").and_then(Value::as_bool).unwrap_or(false);
            if !name.is_empty() || !value.is_empty() {
                fields.push((name, value, secret));
            }
        }
    }
    let taken = claimed(&item.kind);
    if let Value::Object(map) = &item.secret {
        let mut rest: Vec<(&String, &Value)> = map.iter().filter(|(key, _)| !taken.contains(&key.as_str())).collect();
        rest.sort_by(|a, b| a.0.cmp(b.0));
        for (key, value) in rest {
            if let Some(value) = value.as_str().filter(|v| !v.is_empty()) {
                fields.push((key.clone(), value.to_string(), is_secret_field(key)));
            }
        }
    }
    fields
}

/// Bitwarden's type for an entry: 1 login, 2 secure note, 3 card, 4 identity.
fn bitwarden_type(kind: &str) -> u8 {
    match kind {
        "login" | "database" | "server" => 1,
        "card" => 3,
        "identity" => 4,
        _ => 2,
    }
}

/// The unencrypted Bitwarden JSON export. Pretty-printed, keys in a stable order.
pub fn to_bitwarden_json(export: &KeyringExport) -> String {
    let folders: Vec<Value> = export
        .folders
        .iter()
        .map(|folder| json!({ "id": folder.id, "name": folder_path(&export.folders, &folder.id) }))
        .collect();
    let items: Vec<Value> = export
        .items
        .iter()
        .map(|item| {
            let kind = bitwarden_type(&item.kind);
            let secret = &item.secret;
            let fields: Vec<Value> = custom_fields(item)
                .into_iter()
                .map(|(name, value, hidden)| {
                    json!({ "name": name, "value": value, "type": if hidden { 1 } else { 0 }, "linkedId": null })
                })
                .collect();
            let mut entry = json!({
                "id": item.id,
                "organizationId": null,
                "folderId": item.folder_id,
                "type": kind,
                "reprompt": 0,
                "name": item.title,
                "notes": text(secret, "notes"),
                "favorite": item.favorite,
                "fields": fields,
                "collectionIds": null,
            });
            let object = entry.as_object_mut().expect("json! built an object");
            match kind {
                1 => {
                    let uris: Vec<Value> = if item.site.is_empty() {
                        Vec::new()
                    } else {
                        vec![json!({ "match": null, "uri": item.site })]
                    };
                    object.insert(
                        "login".into(),
                        json!({
                            "uris": uris,
                            "username": text(secret, "username"),
                            "password": text(secret, "password"),
                            "totp": text(secret, "totp"),
                        }),
                    );
                }
                3 => {
                    let expiry = text(secret, "expiry").unwrap_or_default();
                    let (month, year) = expiry.split_once('/').unwrap_or((expiry.as_str(), ""));
                    object.insert(
                        "card".into(),
                        json!({
                            "cardholderName": text(secret, "cardholder"),
                            "brand": null,
                            "number": text(secret, "cardNumber"),
                            "expMonth": Some(month.trim()).filter(|v| !v.is_empty()),
                            "expYear": Some(year.trim()).filter(|v| !v.is_empty()),
                            "code": text(secret, "cvv"),
                        }),
                    );
                }
                4 => {
                    let full = text(secret, "fullName").unwrap_or_default();
                    let (first, last) = full.split_once(' ').unwrap_or((full.as_str(), ""));
                    object.insert(
                        "identity".into(),
                        json!({
                            "firstName": Some(first.trim()).filter(|v| !v.is_empty()),
                            "lastName": Some(last.trim()).filter(|v| !v.is_empty()),
                            "passportNumber": text(secret, "documentNumber"),
                        }),
                    );
                }
                _ => {
                    object.insert("secureNote".into(), json!({ "type": 0 }));
                }
            }
            entry
        })
        .collect();
    let document = json!({ "encrypted": false, "folders": folders, "items": items });
    serde_json::to_string_pretty(&document).expect("a JSON value serialises") + "\n"
}

/// One CSV cell, quoted when it has to be — the quote doubled, as every CSV reader expects.
fn cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// The unencrypted Bitwarden CSV export. Bitwarden's CSV holds logins and notes only, so a card or
/// an identity travels as a note whose custom fields carry its values.
pub fn to_bitwarden_csv(export: &KeyringExport) -> String {
    let mut out = String::from(
        "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n",
    );
    for item in &export.items {
        let login = bitwarden_type(&item.kind) == 1;
        let mut fields = custom_fields(item);
        if !login {
            // The slots a note has none of: carried as fields rather than dropped.
            for key in ["username", "password", "totp", "cardholder", "cardNumber", "cvv", "expiry", "fullName", "documentNumber"] {
                if let Some(value) = text(&item.secret, key) {
                    if !fields.iter().any(|(name, _, _)| name == key) {
                        fields.push((key.to_string(), value, is_secret_field(key)));
                    }
                }
            }
        }
        let fields_cell = fields
            .iter()
            .map(|(name, value, _)| format!("{name}: {value}"))
            .collect::<Vec<_>>()
            .join("\n");
        let folder = item
            .folder_id
            .as_ref()
            .map(|id| folder_path(&export.folders, id))
            .unwrap_or_default();
        let row = [
            cell(&folder),
            if item.favorite { "1".into() } else { String::new() },
            if login { "login".into() } else { "note".into() },
            cell(&item.title),
            cell(&text(&item.secret, "notes").unwrap_or_default()),
            cell(&fields_cell),
            "0".into(),
            cell(if login { &item.site } else { "" }),
            cell(&if login { text(&item.secret, "username").unwrap_or_default() } else { String::new() }),
            cell(&if login { text(&item.secret, "password").unwrap_or_default() } else { String::new() }),
            cell(&if login { text(&item.secret, "totp").unwrap_or_default() } else { String::new() }),
        ];
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keyring the golden files were written from. Fixed ids, so the output is byte-stable.
    pub(super) fn sample() -> KeyringExport {
        KeyringExport {
            format: FORMAT.into(),
            version: FORMAT_VERSION,
            exported_at: "2026-09-28T12:00:00+00:00".into(),
            folders: vec![
                ExportedFolder { id: "f-work".into(), parent_id: None, name: "Trabajo".into(), color: "#f00".into(), workspace_id: String::new() },
                ExportedFolder { id: "f-db".into(), parent_id: Some("f-work".into()), name: "Bases".into(), color: String::new(), workspace_id: String::new() },
            ],
            items: vec![
                ExportedItem {
                    id: "i-login".into(),
                    folder_id: Some("f-work".into()),
                    kind: "login".into(),
                    title: "Correo, del equipo".into(),
                    subtitle: "ana@example.test".into(),
                    site: "https://mail.example.test".into(),
                    tags: "[\"correo\"]".into(),
                    favorite: true,
                    workspace_id: String::new(),
                    secret: json!({
                        "username": "ana@example.test",
                        "password": "p\"ss,word",
                        "totp": "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
                        "notes": "línea 1\nlínea 2",
                        "custom": [{ "name": "PIN", "value": "1234", "secret": true }]
                    }),
                    attachments: vec![ExportedAttachment { name: "qr.png".into(), mime: "image/png".into(), data: B64.encode([1u8, 2, 3]) }],
                },
                ExportedItem {
                    id: "i-db".into(),
                    folder_id: Some("f-db".into()),
                    kind: "database".into(),
                    title: "Prod".into(),
                    subtitle: String::new(),
                    site: String::new(),
                    tags: "[]".into(),
                    favorite: false,
                    workspace_id: String::new(),
                    secret: json!({ "engine": "postgres", "host": "db.example.test", "username": "app", "password": "s3cret" }),
                    attachments: vec![],
                },
                ExportedItem {
                    id: "i-card".into(),
                    folder_id: None,
                    kind: "card".into(),
                    title: "Visa".into(),
                    subtitle: "Ana".into(),
                    site: String::new(),
                    tags: "[]".into(),
                    favorite: false,
                    workspace_id: String::new(),
                    secret: json!({ "cardholder": "Ana Pérez", "cardNumber": "4111111111111111", "cvv": "123", "expiry": "08/29" }),
                    attachments: vec![],
                },
                ExportedItem {
                    id: "i-key".into(),
                    folder_id: None,
                    kind: "key".into(),
                    title: "API".into(),
                    subtitle: String::new(),
                    site: String::new(),
                    tags: "[]".into(),
                    favorite: false,
                    workspace_id: String::new(),
                    secret: json!({ "apiKey": "sk-test-123", "notes": "rotar en enero" }),
                    attachments: vec![],
                },
            ],
        }
    }

    const GOLDEN_JSON: &str = include_str!("../../../src/lib/vault/fixtures/codeflow-export.bitwarden.json");
    const GOLDEN_CSV: &str = include_str!("../../../src/lib/vault/fixtures/codeflow-export.bitwarden.csv");

    /// Rewrites the golden files from `sample()`. Run on purpose, after a deliberate change to the
    /// export's shape: `UPDATE_GOLDEN=1 cargo test --lib keyvault::export` — then read the diff.
    #[test]
    fn write_golden_files_when_asked() {
        if std::env::var("UPDATE_GOLDEN").is_err() {
            return;
        }
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/lib/vault/fixtures");
        std::fs::write(format!("{dir}/codeflow-export.bitwarden.json"), to_bitwarden_json(&sample())).unwrap();
        std::fs::write(format!("{dir}/codeflow-export.bitwarden.csv"), to_bitwarden_csv(&sample())).unwrap();
    }

    /// The Bitwarden files are pinned byte for byte, and the frontend's importer reads the very same
    /// files back (`lib/vault/export.test.ts`) — so "our export is something Bitwarden's format
    /// reader accepts" is checked across the language boundary, not assumed on each side.
    #[test]
    fn the_bitwarden_json_is_the_golden_file() {
        assert_eq!(to_bitwarden_json(&sample()), GOLDEN_JSON);
    }

    #[test]
    fn the_bitwarden_csv_is_the_golden_file() {
        assert_eq!(to_bitwarden_csv(&sample()), GOLDEN_CSV);
    }

    #[test]
    fn it_counts_what_a_bitwarden_export_leaves_behind() {
        assert_eq!(left_out(&sample()), LeftOut { attachments: 1, tagged: 1, flattened: 1 });
    }

    #[test]
    fn an_encrypted_export_comes_back_exactly_and_only_with_its_passphrase() {
        let sealed = seal(&sample(), "correct horse battery", "1.0.0").unwrap();
        assert!(is_export(&sealed));
        assert_eq!(open(&sealed, "correct horse battery").unwrap(), sample());
        assert_eq!(open(&sealed, "wrong horse battery").unwrap_err(), OpenError::WrongPassphrase);
        // Nothing recognisable in the file: not a title, not a password.
        let haystack = String::from_utf8_lossy(&sealed);
        for needle in ["Correo", "p\"ss", "sk-test", "Trabajo", "4111"] {
            assert!(!haystack.contains(needle), "{needle} leaked into the file");
        }
    }

    #[test]
    fn an_altered_header_fails_the_tag_instead_of_weakening_the_file() {
        let mut sealed = seal(&sample(), "correct horse battery", "1.0.0").unwrap();
        let text = String::from_utf8_lossy(&sealed).to_string();
        let at = text.find("\"iterations\":3").expect("the header states its cost");
        // Same length, so the frame still parses: 3 → 1 iteration.
        sealed[at + "\"iterations\":".len()] = b'1';
        assert_eq!(open(&sealed, "correct horse battery").unwrap_err(), OpenError::WrongPassphrase);
    }

    #[test]
    fn a_short_passphrase_and_a_file_that_is_not_one_are_refused() {
        assert_eq!(seal(&sample(), "short", "1").unwrap_err(), crypto::CODE_TOO_SHORT);
        assert_eq!(open(b"CFBKUP\x01\nnot ours", "x").unwrap_err(), OpenError::NotAnExport);
        assert_eq!(open(b"{}", "x").unwrap_err(), OpenError::NotAnExport);
    }

    /// The round trip through a real vault: collect from one database, restore into another, and
    /// read every secret and attachment back out under the second vault's key.
    #[test]
    fn a_keyring_restored_from_an_export_opens_under_the_new_vault_key() {
        let source = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&source).unwrap();
        let dek = [9u8; KEY_LEN];
        restore(&source, &dek, &sample()).unwrap();
        let collected = collect(&source, &dek).unwrap();
        assert_eq!(collected.items.len(), 4);

        let target = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&target).unwrap();
        let other = [4u8; KEY_LEN];
        let counts = restore(&target, &other, &collected).unwrap();
        assert_eq!(counts, RestoreCounts { folders: 2, items: 4, attachments: 1 });
        // Restoring again reuses the folders rather than growing a second tree.
        assert_eq!(restore(&target, &other, &collected).unwrap().folders, 0);

        let back = collect(&target, &other).unwrap();
        let login = back.items.iter().find(|item| item.title == "Correo, del equipo").unwrap();
        assert_eq!(login.secret, sample().items[0].secret);
        assert_eq!(login.attachments[0].data, B64.encode([1u8, 2, 3]));
        assert!(login.favorite);
        let db = back.items.iter().find(|item| item.title == "Prod").unwrap();
        let folder = back.folders.iter().find(|folder| Some(&folder.id) == db.folder_id.as_ref()).unwrap();
        assert_eq!(folder.name, "Bases");
        assert!(folder.parent_id.is_some(), "nesting survives the round trip");
    }
}
