//! The keyring's cryptography: a two-tier key, and one sealed record at a time.
//!
//! ```text
//! master password ──Argon2id(salt, 64 MiB / 3 / 1)──▶ KEK (32 B, wiped immediately)
//!                                                       │
//!                                    AES-256-GCM unwrap ▼
//!                                   wrapped DEK + nonce ──▶ DEK (32 B, held while unlocked)
//!                                                             │
//!                                per-record AES-256-GCM ──────▶ item secrets, attachment bytes
//! ```
//!
//! **Why two tiers rather than deriving a key straight from the password.** Changing the master
//! password re-wraps one 32-byte key instead of re-encrypting every record — which matters because
//! a re-encrypt that is interrupted half-way leaves a vault whose two halves need two different
//! passwords, and there is no honest way to recover from that. Here a failed re-wrap changes
//! nothing at all.
//!
//! **There is no stored verifier, and that is deliberate.** A wrong password fails the GCM tag on
//! the wrapped DEK, and that failure *is* the check. Nothing in the database can be compared
//! against a password, so nothing in the database can be used to test guesses offline any faster
//! than by running Argon2. Note what this is not: `backup_cmd::backup_passphrase_matches` compares
//! a passphrase against a stored string. Do not copy that here.
//!
//! **Why not [`crate::backup::envelope`], which already does Argon2id + AES-256-GCM.** That module
//! seals a whole file in one shot and derives a fresh key on every call. Sealing four hundred vault
//! records through it would be four hundred × ~100 ms of Argon2. The constants are shared with it
//! on purpose (see below); the shape is not.
//!
//! **The AAD is the record's id.** A ciphertext lifted out of one row and pasted into another fails
//! to open, so someone with write access to the database file cannot move a password from an item
//! labelled "staging" onto one labelled "production" and have it decrypt.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::TryRngCore as _;
use zeroize::Zeroize as _;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
pub const SALT_LEN: usize = 16;

/// The same 64 MiB / 3 passes / 1 lane the full backup uses — a little above the OWASP floor for
/// Argon2id, and about 100 ms on a current laptop.
///
/// Recorded in `vault_meta` rather than assumed, exactly as the backup records them in its header,
/// so raising these later cannot strand a vault created today: an existing vault keeps unwrapping
/// with the parameters it was built with.
pub const ARGON_MEMORY_KIB: u32 = 64 * 1024;
pub const ARGON_ITERATIONS: u32 = 3;
pub const ARGON_LANES: u32 = 1;

/// Short enough to be typed daily, long enough that Argon2 at these parameters is the only way
/// through. Counted in `chars()`, not bytes — a passphrase in any language should count the same.
pub const MIN_MASTER_LENGTH: usize = 10;

/// Stable codes for the failures the UI has to *say something about*.
///
/// The rest of this app hands a backend error straight to the user, which works because those are
/// mostly a server's own words. These are not: they are this app's own sentences, and this app is
/// translated. So the three failures a person actually meets come back as a code the frontend maps
/// to its dictionary (`lib/vault/errors.ts`), and everything else stays prose.
///
/// The `cf-keyvault/` prefix is what makes the two tellable apart, and is deliberately not
/// something a server or an OS could produce.
pub const CODE_WRONG_PASSWORD: &str = "cf-keyvault/wrong-password";
pub const CODE_LOCKED: &str = "cf-keyvault/locked";
pub const CODE_NOT_INITIALISED: &str = "cf-keyvault/not-initialised";
pub const CODE_ALREADY_INITIALISED: &str = "cf-keyvault/already-initialised";
pub const CODE_TOO_SHORT: &str = "cf-keyvault/too-short";

#[derive(Debug)]
pub enum VaultError {
    /// No vault has been created on this machine yet.
    NotInitialised,
    /// The vault exists but is locked — no key in memory.
    Locked,
    /// The GCM tag did not verify. A wrong password and a tampered record are indistinguishable
    /// here, and neither is recoverable.
    WrongPassword,
    Other(String),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInitialised => write!(
                f,
                "there is no keyring on this machine yet — set a master password to create one"
            ),
            Self::Locked => write!(f, "the keyring is locked"),
            Self::WrongPassword => write!(f, "wrong master password"),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

/// Codes for the three typed variants, prose for `Other`.
///
/// Note this is *not* `Display`, which stays English and is what a log wants. Only what crosses the
/// IPC bridge is coded.
impl From<VaultError> for String {
    fn from(error: VaultError) -> Self {
        match error {
            VaultError::WrongPassword => CODE_WRONG_PASSWORD.to_string(),
            VaultError::Locked => CODE_LOCKED.to_string(),
            VaultError::NotInitialised => CODE_NOT_INITIALISED.to_string(),
            VaultError::Other(message) => message,
        }
    }
}

type Result<T> = std::result::Result<T, VaultError>;

fn other(message: impl std::fmt::Display) -> VaultError {
    VaultError::Other(message.to_string())
}

/// Cryptographically strong bytes, or a hard failure.
///
/// `try_fill_bytes` rather than the infallible `fill_bytes`: on the one platform where the OS
/// entropy source can fail, a vault key must not be built from whatever a fallback produced. There
/// is no safe way to continue, so this is an error and never a silent degradation.
fn random(len: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0u8; len];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|e| other(format!("the system random number generator failed: {e}")))?;
    Ok(bytes)
}

/// The parameters one vault was built with, as they are stored.
#[derive(Debug, Clone)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub lanes: u32,
    /// Base64, [`SALT_LEN`] bytes.
    pub salt: String,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            memory_kib: ARGON_MEMORY_KIB,
            iterations: ARGON_ITERATIONS,
            lanes: ARGON_LANES,
            salt: String::new(),
        }
    }
}

/// What a freshly created vault needs written to `vault_meta`.
pub struct NewVault {
    pub kdf: KdfParams,
    pub dek_nonce: String,
    pub dek_wrapped: String,
    /// Held by the caller for the rest of the session; wiped on lock.
    pub dek: [u8; KEY_LEN],
}

/// Turns the master password into the key-encryption key.
///
/// ~100 ms by design. The caller must not hold the database lock across it — see the note in
/// `commands::keyvault_cmd`.
pub fn derive_kek(password: &str, kdf: &KdfParams) -> Result<[u8; KEY_LEN]> {
    let salt = B64
        .decode(&kdf.salt)
        .map_err(|_| other("the stored key-derivation salt is not readable"))?;
    if salt.len() != SALT_LEN {
        return Err(other("the stored key-derivation salt is the wrong length"));
    }
    let params = Params::new(kdf.memory_kib, kdf.iterations, kdf.lanes, Some(KEY_LEN))
        .map_err(|e| other(format!("bad key-derivation parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|e| other(format!("could not derive the key: {e}")))?;
    Ok(key)
}

/// Creates a vault: a random data key, wrapped under a key derived from the password.
pub fn initialise(password: &str) -> Result<NewVault> {
    if password.chars().count() < MIN_MASTER_LENGTH {
        return Err(other(CODE_TOO_SHORT));
    }
    let salt = random(SALT_LEN)?;
    let kdf = KdfParams { salt: B64.encode(&salt), ..KdfParams::default() };

    let mut dek = [0u8; KEY_LEN];
    dek.copy_from_slice(&random(KEY_LEN)?);

    let mut kek = derive_kek(password, &kdf)?;
    let wrapped = wrap(&kek, &dek);
    kek.zeroize();
    let (dek_nonce, dek_wrapped) = wrapped?;

    Ok(NewVault { kdf, dek_nonce, dek_wrapped, dek })
}

/// Unwraps the data key. **A wrong password fails here, and that is the only check there is.**
pub fn unwrap_dek(
    kdf: &KdfParams,
    dek_nonce: &str,
    dek_wrapped: &str,
    password: &str,
) -> Result<[u8; KEY_LEN]> {
    let mut kek = derive_kek(password, kdf)?;
    let opened = open_raw(&kek, WRAP_AAD, dek_nonce, dek_wrapped);
    // Unconditionally, and *before* the `?` below — the same order `envelope::seal` uses, so an
    // error path cannot leave the derived key in freed memory.
    kek.zeroize();
    let mut plain = opened?;
    if plain.len() != KEY_LEN {
        plain.zeroize();
        return Err(other("the stored data key is the wrong length"));
    }
    let mut dek = [0u8; KEY_LEN];
    dek.copy_from_slice(&plain);
    plain.zeroize();
    Ok(dek)
}

/// Re-wraps the *same* data key under a new password.
///
/// Nothing else changes, which is the point: every sealed record still opens with the same key, so
/// changing the master password touches one row and cannot half-succeed.
pub fn rewrap(
    kdf: &KdfParams,
    dek_nonce: &str,
    dek_wrapped: &str,
    old: &str,
    new: &str,
) -> Result<(KdfParams, String, String)> {
    if new.chars().count() < MIN_MASTER_LENGTH {
        return Err(other(CODE_TOO_SHORT));
    }
    let mut dek = unwrap_dek(kdf, dek_nonce, dek_wrapped, old)?;

    // A fresh salt with the new password: reusing the old one would leak that the two derive from
    // the same salt, and costs nothing to avoid.
    let salt = random(SALT_LEN);
    let result = (|| {
        let salt = salt?;
        let next = KdfParams { salt: B64.encode(&salt), ..KdfParams::default() };
        let mut kek = derive_kek(new, &next)?;
        let wrapped = wrap(&kek, &dek);
        kek.zeroize();
        let (nonce, blob) = wrapped?;
        Ok((next, nonce, blob))
    })();
    dek.zeroize();
    result
}

/// The AAD binding the wrapped data key to its purpose, so it cannot be pasted into a record slot.
const WRAP_AAD: &str = "codeflow-keyvault-dek";

fn wrap(kek: &[u8; KEY_LEN], dek: &[u8; KEY_LEN]) -> Result<(String, String)> {
    seal_raw(kek, WRAP_AAD, dek)
}

/// Seals one record. Returns `(nonce, ciphertext)`, both base64.
///
/// `aad` is the row's id — see the module docs for what that buys.
pub fn seal(dek: &[u8; KEY_LEN], aad: &str, plaintext: &[u8]) -> Result<(String, String)> {
    seal_raw(dek, aad, plaintext)
}

/// Opens one record.
pub fn open(dek: &[u8; KEY_LEN], aad: &str, nonce: &str, ciphertext: &str) -> Result<Vec<u8>> {
    open_raw(dek, aad, nonce, ciphertext)
}

fn seal_raw(key: &[u8; KEY_LEN], aad: &str, plaintext: &[u8]) -> Result<(String, String)> {
    // A fresh random nonce per seal, never a counter. 96 bits of randomness is the standard GCM
    // construction; a repeated nonce under the same key is what breaks GCM outright.
    let nonce_bytes = random(NONCE_LEN)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload { msg: plaintext, aad: aad.as_bytes() },
        )
        .map_err(|_| other("could not encrypt this entry"))?;
    Ok((B64.encode(&nonce_bytes), B64.encode(&ciphertext)))
}

fn open_raw(key: &[u8; KEY_LEN], aad: &str, nonce: &str, ciphertext: &str) -> Result<Vec<u8>> {
    let nonce_bytes = B64
        .decode(nonce)
        .map_err(|_| other("this entry's nonce is not readable"))?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(other("this entry's nonce is the wrong length"));
    }
    let blob = B64
        .decode(ciphertext)
        .map_err(|_| other("this entry's contents are not readable"))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload { msg: &blob, aad: aad.as_bytes() },
        )
        // Every failure here is the same failure: the tag did not verify. Wrong key, altered
        // ciphertext and a record moved between rows are indistinguishable, and saying which would
        // be telling an attacker which of their guesses was closest.
        .map_err(|_| VaultError::WrongPassword)
}

// ---------------------------------------------------------------------------
// Generating passwords
// ---------------------------------------------------------------------------

/// What the generator was asked for.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PasswordRecipe {
    pub length: usize,
    #[serde(default)]
    pub uppercase: bool,
    #[serde(default)]
    pub digits: bool,
    #[serde(default)]
    pub symbols: bool,
    /// Include characters that are easy to misread — `l1I`, `O0`. Off by default, because the
    /// password most often typed by hand is the one being read off another screen.
    #[serde(default)]
    pub ambiguous: bool,
}

impl Default for PasswordRecipe {
    fn default() -> Self {
        Self { length: 20, uppercase: true, digits: true, symbols: true, ambiguous: false }
    }
}

const LOWER: &str = "abcdefghijkmnopqrstuvwxyz";
const LOWER_AMBIGUOUS: &str = "l";
const UPPER: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const UPPER_AMBIGUOUS: &str = "IO";
const DIGITS: &str = "23456789";
const DIGITS_AMBIGUOUS: &str = "01";
const SYMBOLS: &str = "!@#$%^&*()-_=+[]{};:,.?";

/// A password from the OS random number generator.
///
/// **Never `Math.random`,** which is what `lib/api/variables.ts`'s `$randomPassword` uses and says
/// so in its own comment — that one is a test fixture. This is the real thing, and it is generated
/// in Rust rather than in the webview so there is one implementation to get right.
///
/// Rejection sampling, not `% alphabet.len()`: the modulo is biased toward the first characters of
/// the alphabet whenever 256 is not a multiple of its length, which for a 23-character symbol set
/// is a real skew in the first few characters.
pub fn generate_password(recipe: &PasswordRecipe) -> Result<String> {
    let mut alphabet = String::from(LOWER);
    if recipe.ambiguous {
        alphabet.push_str(LOWER_AMBIGUOUS);
    }
    if recipe.uppercase {
        alphabet.push_str(UPPER);
        if recipe.ambiguous {
            alphabet.push_str(UPPER_AMBIGUOUS);
        }
    }
    if recipe.digits {
        alphabet.push_str(DIGITS);
        if recipe.ambiguous {
            alphabet.push_str(DIGITS_AMBIGUOUS);
        }
    }
    if recipe.symbols {
        alphabet.push_str(SYMBOLS);
    }

    let chars: Vec<char> = alphabet.chars().collect();
    let length = recipe.length.clamp(4, 256);
    let limit = (256 / chars.len() * chars.len()) as u16;
    let mut out = String::with_capacity(length);
    while out.len() < length {
        for byte in random(length)? {
            if (byte as u16) >= limit {
                // Would be biased — draw again rather than fold it in.
                continue;
            }
            out.push(chars[byte as usize % chars.len()]);
            if out.chars().count() >= length {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_round_trips() {
        let vault = initialise("correct horse battery").unwrap();
        let (nonce, blob) = seal(&vault.dek, "item-1", b"hunter2").unwrap();
        let opened = open(&vault.dek, "item-1", &nonce, &blob).unwrap();
        assert_eq!(opened, b"hunter2");
    }

    /// The only check there is. Nothing stored can be compared against a password.
    #[test]
    fn the_wrong_master_password_fails_to_unwrap() {
        let vault = initialise("correct horse battery").unwrap();
        let wrong = unwrap_dek(&vault.kdf, &vault.dek_nonce, &vault.dek_wrapped, "wrong password");
        assert!(matches!(wrong, Err(VaultError::WrongPassword)));

        let right =
            unwrap_dek(&vault.kdf, &vault.dek_nonce, &vault.dek_wrapped, "correct horse battery")
                .unwrap();
        assert_eq!(right, vault.dek);
    }

    /// Someone with write access to the database file must not be able to move a password from one
    /// item onto another and have it decrypt. This is what the AAD is for.
    #[test]
    fn a_record_moved_to_another_row_does_not_open() {
        let vault = initialise("correct horse battery").unwrap();
        let (nonce, blob) = seal(&vault.dek, "item-staging", b"hunter2").unwrap();
        let moved = open(&vault.dek, "item-production", &nonce, &blob);
        assert!(matches!(moved, Err(VaultError::WrongPassword)));
    }

    #[test]
    fn a_tampered_record_does_not_open() {
        let vault = initialise("correct horse battery").unwrap();
        let (nonce, blob) = seal(&vault.dek, "item-1", b"hunter2").unwrap();
        let mut bytes = B64.decode(&blob).unwrap();
        bytes[0] ^= 0xff;
        let tampered = open(&vault.dek, "item-1", &nonce, &B64.encode(&bytes));
        assert!(matches!(tampered, Err(VaultError::WrongPassword)));
    }

    /// The whole reason for the two-tier key: changing the password re-wraps 32 bytes, and every
    /// record sealed before it still opens.
    #[test]
    fn changing_the_password_keeps_every_sealed_record_readable() {
        let vault = initialise("first password!").unwrap();
        let (nonce, blob) = seal(&vault.dek, "item-1", b"hunter2").unwrap();

        let (kdf, dek_nonce, dek_wrapped) = rewrap(
            &vault.kdf,
            &vault.dek_nonce,
            &vault.dek_wrapped,
            "first password!",
            "second password!",
        )
        .unwrap();

        let dek = unwrap_dek(&kdf, &dek_nonce, &dek_wrapped, "second password!").unwrap();
        assert_eq!(dek, vault.dek, "the data key is the same one");
        assert_eq!(open(&dek, "item-1", &nonce, &blob).unwrap(), b"hunter2");

        // …and the old password no longer works.
        assert!(unwrap_dek(&kdf, &dek_nonce, &dek_wrapped, "first password!").is_err());
    }

    #[test]
    fn the_old_password_must_be_right_to_change_it() {
        let vault = initialise("first password!").unwrap();
        let refused = rewrap(
            &vault.kdf,
            &vault.dek_nonce,
            &vault.dek_wrapped,
            "not the old one",
            "second password!",
        );
        assert!(matches!(refused, Err(VaultError::WrongPassword)));
    }

    #[test]
    fn a_short_master_password_is_refused_on_both_paths() {
        assert!(initialise("short").is_err());
        let vault = initialise("long enough password").unwrap();
        assert!(rewrap(
            &vault.kdf,
            &vault.dek_nonce,
            &vault.dek_wrapped,
            "long enough password",
            "short"
        )
        .is_err());
    }

    /// Two seals of the same plaintext must not produce the same ciphertext, or the database would
    /// say which entries share a password without anything being decrypted.
    #[test]
    fn sealing_the_same_value_twice_gives_different_ciphertext() {
        let vault = initialise("correct horse battery").unwrap();
        let (first_nonce, first) = seal(&vault.dek, "a", b"same").unwrap();
        let (second_nonce, second) = seal(&vault.dek, "a", b"same").unwrap();
        assert_ne!(first_nonce, second_nonce);
        assert_ne!(first, second);
    }

    #[test]
    fn a_generated_password_honours_its_recipe() {
        let recipe = PasswordRecipe { length: 40, uppercase: false, digits: false, symbols: false, ambiguous: false };
        let password = generate_password(&recipe).unwrap();
        assert_eq!(password.chars().count(), 40);
        assert!(password.chars().all(|c| LOWER.contains(c)));

        let full = generate_password(&PasswordRecipe::default()).unwrap();
        assert_eq!(full.chars().count(), 20);
    }

    /// The characters that are misread when a password is copied off another screen by hand.
    #[test]
    fn ambiguous_characters_are_left_out_unless_asked_for() {
        for _ in 0..20 {
            let password = generate_password(&PasswordRecipe {
                length: 64,
                uppercase: true,
                digits: true,
                symbols: false,
                ambiguous: false,
            })
            .unwrap();
            assert!(
                !password.contains(['l', 'I', 'O', '0', '1']),
                "{password} contains a character that is easy to misread"
            );
        }
    }

    #[test]
    fn two_generated_passwords_are_not_the_same() {
        let a = generate_password(&PasswordRecipe::default()).unwrap();
        let b = generate_password(&PasswordRecipe::default()).unwrap();
        assert_ne!(a, b);
    }
}
