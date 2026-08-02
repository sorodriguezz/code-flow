//! The backup file itself: one sealed envelope, and nothing readable outside it.
//!
//! The whole payload is encrypted as a unit — configuration, settings and every credential in the
//! OS store together. Encrypting only the fields that *look* like secrets is the mistake this
//! deliberately doesn't make: a bearer token pasted into a header value, a connection string with a
//! password in it, an OAuth client secret inside a request's `spec` — none of them carry a flag
//! saying so, and a file that hides three of them while publishing the fourth is worse than one
//! that hides nothing, because it reads as safe.
//!
//! Layout on disk:
//!
//! ```text
//! 0..8    magic                  b"CFBKUP\x01\n"
//! 8..12   header length (u32 LE)
//! 12..N   header JSON            plaintext, and the AEAD's associated data
//! N..     ciphertext             AES-256-GCM over deflate(JSON(payload))
//! ```
//!
//! The header is in the clear because it has to be: it carries the KDF parameters needed to derive
//! the key, so nothing can be decrypted before it is read. It carries no user data — a timestamp,
//! an app version, a platform name, a salt and a nonce — and it is fed to the cipher as associated
//! data, so editing it (say, lowering the Argon2 cost to make a crack cheap) fails the tag instead
//! of producing a weaker but valid file.
//!
//! Argon2id rather than PBKDF2. This file is meant to sit in Google Drive or iCloud, which means
//! the threat is an offline attack against a copy of it, and PBKDF2's only cost is time — exactly
//! the axis a GPU flattens. Argon2id's memory cost is what makes each guess expensive to parallelise.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use flate2::write::{ZlibDecoder, ZlibEncoder};
use flate2::Compression;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use zeroize::Zeroize as _;

/// Identifies the file before anything else is parsed, so picking the wrong file says so rather
/// than failing later as "wrong passphrase".
const MAGIC: &[u8; 8] = b"CFBKUP\x01\n";

pub const FORMAT: &str = "codeflow-full-backup";

/// Bumped only when a reader of this version could no longer make sense of the file. A newer file
/// is refused outright rather than half-read: a partial restore of a configuration is worse than
/// none, because the user believes it worked.
pub const FORMAT_VERSION: u32 = 1;

/// Deliberately not `.json` or `.zip` — the file is opaque, and an extension suggesting otherwise
/// invites someone to try opening it in a text editor and conclude it is corrupt.
pub const FILE_EXTENSION: &str = "cfbackup";

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// 64 MiB / 3 passes / 1 lane — a little above the OWASP floor for Argon2id, and about 100 ms on a
/// current laptop. Recorded in every file rather than assumed, so raising it later can't strand a
/// backup written today.
const ARGON_MEMORY_KIB: u32 = 64 * 1024;
const ARGON_ITERATIONS: u32 = 3;
const ARGON_LANES: u32 = 1;

/// A ceiling on the header so a corrupt or hostile length can't make us allocate a gigabyte before
/// discovering the file is nonsense.
const MAX_HEADER_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// The failures a caller has to tell apart. Everything else collapses into `Other`, because the
/// user can do nothing different about a compression error than about a serialisation one.
#[derive(Debug)]
pub enum EnvelopeError {
    /// Not a CodeFlow backup at all — wrong file picked, or a truncated download.
    NotABackup,
    /// Written by a newer build than this one.
    TooNew(u32),
    /// The tag didn't verify: a wrong passphrase, or a file that was altered in transit. GCM
    /// authenticates as it decrypts, so the two are indistinguishable — and neither is recoverable.
    WrongPassphrase,
    Other(String),
}

impl std::fmt::Display for EnvelopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotABackup => write!(f, "this file is not a CodeFlow backup"),
            Self::TooNew(v) => write!(f, "backup format {v} is newer than this version of CodeFlow"),
            Self::WrongPassphrase => write!(f, "wrong password, or the file has been altered"),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

impl From<EnvelopeError> for String {
    fn from(error: EnvelopeError) -> Self {
        error.to_string()
    }
}

type Result<T> = std::result::Result<T, EnvelopeError>;

fn other(message: impl std::fmt::Display) -> EnvelopeError {
    EnvelopeError::Other(message.to_string())
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParams {
    pub name: String,
    pub version: u32,
    pub memory_kib: u32,
    pub iterations: u32,
    pub lanes: u32,
    pub salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CipherParams {
    pub name: String,
    pub nonce: String,
}

/// Everything readable without the passphrase. Kept to what a person needs in order to decide
/// whether this is the file they meant to restore: nothing here names a workspace, a host or an
/// account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupHeader {
    pub format: String,
    pub version: u32,
    /// ISO-8601, so "is this the backup from before I broke everything?" is answerable in the
    /// import dialog rather than by restoring and looking.
    pub created_at: String,
    pub app_version: String,
    /// `windows` / `macos` / `linux` — the restore screen says where the file came from, which is
    /// the one thing that explains why the project paths inside it don't exist here.
    pub os: String,
    pub kdf: KdfParams,
    pub cipher: CipherParams,
    pub compression: String,
}

fn current_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

fn derive_key(passphrase: &str, kdf: &KdfParams) -> Result<[u8; KEY_LEN]> {
    if kdf.name != "argon2id" {
        return Err(other(format!("unsupported key derivation: {}", kdf.name)));
    }
    let salt = B64
        .decode(&kdf.salt)
        .map_err(|_| EnvelopeError::NotABackup)?;
    let params = Params::new(kdf.memory_kib, kdf.iterations, kdf.lanes, Some(KEY_LEN))
        .map_err(|e| other(format!("bad key-derivation parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .map_err(|e| other(format!("could not derive the key: {e}")))?;
    Ok(key)
}

fn random(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

// ---------------------------------------------------------------------------
// Seal / open
// ---------------------------------------------------------------------------

/// Compresses, encrypts and frames a payload into the bytes that get written to disk or uploaded.
///
/// `plaintext` is consumed and wiped: it is the one copy of every credential on the machine in a
/// single contiguous buffer, and leaving it in freed memory for the rest of the session would undo
/// the point of the exercise.
pub fn seal(mut plaintext: Vec<u8>, passphrase: &str, app_version: &str) -> Result<Vec<u8>> {
    let sealed = seal_inner(&plaintext, passphrase, app_version);
    plaintext.zeroize();
    sealed
}

fn seal_inner(plaintext: &[u8], passphrase: &str, app_version: &str) -> Result<Vec<u8>> {
    // Compress first. After encryption the bytes are indistinguishable from noise and compress to
    // nothing, so this is the only order in which it does anything at all.
    let compressed = {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(plaintext).map_err(other)?;
        encoder.finish().map_err(other)?
    };

    let salt = random(SALT_LEN);
    let nonce = random(NONCE_LEN);

    let header = BackupHeader {
        format: FORMAT.to_string(),
        version: FORMAT_VERSION,
        created_at: chrono::Utc::now().to_rfc3339(),
        app_version: app_version.to_string(),
        os: current_os().to_string(),
        kdf: KdfParams {
            name: "argon2id".into(),
            version: 19,
            memory_kib: ARGON_MEMORY_KIB,
            iterations: ARGON_ITERATIONS,
            lanes: ARGON_LANES,
            salt: B64.encode(&salt),
        },
        cipher: CipherParams { name: "AES-256-GCM".into(), nonce: B64.encode(&nonce) },
        compression: "deflate".into(),
    };
    let header_bytes = serde_json::to_vec(&header).map_err(other)?;

    let mut key = derive_key(passphrase, &header.kdf)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| other(e))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            // The header travels as associated data: it is not secret, but it must not be editable.
            Payload { msg: &compressed, aad: &header_bytes },
        )
        .map_err(|_| other("the backup could not be encrypted"));
    key.zeroize();
    let ciphertext = ciphertext?;

    let mut out = Vec::with_capacity(MAGIC.len() + 4 + header_bytes.len() + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Splits a file into its header and the ciphertext after it, verifying the frame but not the tag.
fn split(bytes: &[u8]) -> Result<(BackupHeader, &[u8], &[u8])> {
    if bytes.len() < MAGIC.len() + 4 || &bytes[..MAGIC.len()] != MAGIC {
        return Err(EnvelopeError::NotABackup);
    }
    let mut length = [0u8; 4];
    length.copy_from_slice(&bytes[MAGIC.len()..MAGIC.len() + 4]);
    let header_len = u32::from_le_bytes(length) as usize;
    let start = MAGIC.len() + 4;
    if header_len == 0 || header_len > MAX_HEADER_BYTES || start + header_len > bytes.len() {
        return Err(EnvelopeError::NotABackup);
    }
    let header_bytes = &bytes[start..start + header_len];
    let header: BackupHeader =
        serde_json::from_slice(header_bytes).map_err(|_| EnvelopeError::NotABackup)?;
    if header.format != FORMAT {
        return Err(EnvelopeError::NotABackup);
    }
    if header.version > FORMAT_VERSION {
        return Err(EnvelopeError::TooNew(header.version));
    }
    Ok((header, header_bytes, &bytes[start + header_len..]))
}

/// What the file says about itself, without the passphrase — what the import screen shows before
/// asking for one, so the prompt is about a file the user has already recognised.
pub fn read_header(bytes: &[u8]) -> Result<BackupHeader> {
    Ok(split(bytes)?.0)
}

/// Verifies, decrypts and decompresses. `WrongPassphrase` covers both a bad password and a
/// tampered file — GCM cannot tell them apart, and neither can be recovered from.
pub fn open(bytes: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    let (header, header_bytes, ciphertext) = split(bytes)?;
    if header.compression != "deflate" {
        return Err(other(format!("unsupported compression: {}", header.compression)));
    }
    if header.cipher.name != "AES-256-GCM" {
        return Err(other(format!("unsupported cipher: {}", header.cipher.name)));
    }
    let nonce = B64
        .decode(&header.cipher.nonce)
        .map_err(|_| EnvelopeError::NotABackup)?;
    if nonce.len() != NONCE_LEN {
        return Err(EnvelopeError::NotABackup);
    }

    let mut key = derive_key(passphrase, &header.kdf)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| other(e))?;
    let opened = cipher.decrypt(
        Nonce::from_slice(&nonce),
        Payload { msg: ciphertext, aad: header_bytes },
    );
    key.zeroize();
    let compressed = opened.map_err(|_| EnvelopeError::WrongPassphrase)?;

    let mut decoder = ZlibDecoder::new(Vec::new());
    decoder.write_all(&compressed).map_err(other)?;
    decoder.finish().map_err(other)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = br#"{"secrets":[{"key":"github-token:github.com","value":"ghp_hunter2"}]}"#;

    #[test]
    fn a_sealed_payload_comes_back_exactly() {
        let sealed = seal(SECRET.to_vec(), "correct horse", "1.0.0").unwrap();
        assert_eq!(open(&sealed, "correct horse").unwrap(), SECRET);
    }

    /// The whole point of the file: nothing in it is readable without the passphrase, including the
    /// parts that are only *shaped* like a credential.
    #[test]
    fn nothing_recognisable_survives_into_the_file() {
        let sealed = seal(SECRET.to_vec(), "correct horse", "1.0.0").unwrap();
        let window = sealed.windows(SECRET.len());
        assert!(window.count() > 0);
        assert!(
            !sealed.windows(11).any(|w| w == b"ghp_hunter2"),
            "the token must not appear in the file"
        );
        assert!(
            !sealed.windows(12).any(|w| w == b"github-token"),
            "not even the key names travel in the clear"
        );
    }

    #[test]
    fn a_wrong_passphrase_is_reported_as_one() {
        let sealed = seal(SECRET.to_vec(), "correct horse", "1.0.0").unwrap();
        assert!(matches!(
            open(&sealed, "correct hors"),
            Err(EnvelopeError::WrongPassphrase)
        ));
    }

    /// The header is authenticated, so lowering the Argon2 cost to make a crack cheap breaks the
    /// file rather than weakening it.
    #[test]
    fn editing_the_header_invalidates_the_file() {
        let mut sealed = seal(SECRET.to_vec(), "correct horse", "1.0.0").unwrap();
        let header_len =
            u32::from_le_bytes(sealed[MAGIC.len()..MAGIC.len() + 4].try_into().unwrap()) as usize;
        let start = MAGIC.len() + 4;
        let mut header: BackupHeader =
            serde_json::from_slice(&sealed[start..start + header_len]).unwrap();
        header.app_version = "9.9.9".into();
        let edited = serde_json::to_vec(&header).unwrap();
        assert_eq!(edited.len(), header_len, "the test needs an equal-length edit");
        sealed[start..start + header_len].copy_from_slice(&edited);
        assert!(matches!(
            open(&sealed, "correct horse"),
            Err(EnvelopeError::WrongPassphrase)
        ));
    }

    #[test]
    fn a_flipped_byte_of_ciphertext_is_caught() {
        let mut sealed = seal(SECRET.to_vec(), "correct horse", "1.0.0").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(matches!(
            open(&sealed, "correct horse"),
            Err(EnvelopeError::WrongPassphrase)
        ));
    }

    #[test]
    fn some_other_file_is_recognised_as_some_other_file() {
        assert!(matches!(
            open(b"{\"format\":\"codeflow-backup\"}", "x"),
            Err(EnvelopeError::NotABackup)
        ));
        assert!(matches!(open(b"", "x"), Err(EnvelopeError::NotABackup)));
    }

    #[test]
    fn the_header_reads_without_the_passphrase() {
        let sealed = seal(SECRET.to_vec(), "correct horse", "1.10.2").unwrap();
        let header = read_header(&sealed).unwrap();
        assert_eq!(header.format, FORMAT);
        assert_eq!(header.version, FORMAT_VERSION);
        assert_eq!(header.app_version, "1.10.2");
        assert!(!header.created_at.is_empty());
    }

    /// A file from a future format is refused whole rather than read as far as it parses.
    #[test]
    fn a_newer_format_is_refused() {
        let sealed = seal(SECRET.to_vec(), "pw", "1.0.0").unwrap();
        let header_len =
            u32::from_le_bytes(sealed[MAGIC.len()..MAGIC.len() + 4].try_into().unwrap()) as usize;
        let start = MAGIC.len() + 4;
        let mut header: BackupHeader =
            serde_json::from_slice(&sealed[start..start + header_len]).unwrap();
        header.version = FORMAT_VERSION + 1;
        let edited = serde_json::to_vec(&header).unwrap();
        let mut rebuilt = sealed[..MAGIC.len()].to_vec();
        rebuilt.extend_from_slice(&(edited.len() as u32).to_le_bytes());
        rebuilt.extend_from_slice(&edited);
        rebuilt.extend_from_slice(&sealed[start + header_len..]);
        assert!(matches!(open(&rebuilt, "pw"), Err(EnvelopeError::TooNew(_))));
    }

    /// Two backups of the same data must not produce the same bytes: a fixed salt or nonce would
    /// let an observer of a synced folder tell that nothing changed, and worse, reuse a nonce.
    #[test]
    fn every_file_gets_a_fresh_salt_and_nonce() {
        let a = read_header(&seal(SECRET.to_vec(), "pw", "1.0.0").unwrap()).unwrap();
        let b = read_header(&seal(SECRET.to_vec(), "pw", "1.0.0").unwrap()).unwrap();
        assert_ne!(a.kdf.salt, b.kdf.salt);
        assert_ne!(a.cipher.nonce, b.cipher.nonce);
    }

    /// Highly repetitive JSON is what a configuration export actually looks like.
    #[test]
    fn the_payload_is_compressed_before_it_is_sealed() {
        let repetitive = SECRET.repeat(200);
        let sealed = seal(repetitive.clone(), "pw", "1.0.0").unwrap();
        assert!(
            sealed.len() < repetitive.len() / 2,
            "expected compression, got {} bytes from {}",
            sealed.len(),
            repetitive.len()
        );
        assert_eq!(open(&sealed, "pw").unwrap(), repetitive);
    }
}
