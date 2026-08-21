//! The keyring — CodeFlow's own password manager.
//!
//! Named `keyvault` and not `vault`, which would collide with [`crate::backup::vault`] (the
//! credential half of the full backup), nor `keyring`, which is the name of the crate `secrets.rs`
//! uses for the OS credential store. Three things in this codebase are about secrets and they are
//! genuinely different things; the names have to say which is which.
//!
//! **What this is, against the other two.** [`crate::secrets`] holds the app's *own* credentials —
//! the tokens it needs to reach Azure DevOps or a database — in the OS store, unlocked whenever the
//! OS session is. This holds the *user's* credentials, encrypted at rest under a password the app
//! never stores, and locks itself when they stop using it. A backup file, meanwhile, is sealed once
//! and read once.
//!
//! **The vault is global.** Its tables carry no foreign key to `workspaces`, and that is the single
//! most important line in the schema: a password must not be deleted as a side effect of tidying up
//! a workspace. Items may still be *filed* under one — `workspace_id` is a plain string where `''`
//! means "everywhere" — and `queries::rehome_global_rows` moves a deleted workspace's items back to
//! global rather than removing them.
//!
//! Read [`crypto`] before changing anything here; the key hierarchy is stated there.

pub mod crypto;
pub mod session;
pub mod totp;

/// The OS-store key the master password is written under, when — and only when — the user asks this
/// machine to remember it.
///
/// Off by default, and the UI says plainly what turning it on means: the keyring becomes exactly as
/// strong as the OS credential store, which on macOS is one Keychain item this app shares with
/// every other token it holds. That is a reasonable trade on a laptop that locks itself and a bad
/// one on a shared machine, and it is not this code's decision to make.
///
/// Deliberately **not** added to `backup::vault::secret_keys`, so it never travels in a backup: a
/// file holding both the sealed vault and the password that opens it is a file with no encryption
/// at all. The vault's rows are in the backup; the key to them is not.
pub fn master_password_key() -> String {
    "keyvault-master-password".to_string()
}
