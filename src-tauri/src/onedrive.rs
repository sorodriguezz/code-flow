//! OneDrive as a backup destination, using the *user's own* Entra ID app registration.
//!
//! This is the destination iCloud cannot be. Apple publishes no service API for iCloud Drive at
//! all — CloudKit stores records in an app's own container, not in the user's Drive, and needs a
//! paid developer membership belonging to *us* — so iCloud stays a folder. Microsoft does publish
//! one, it is free to register against, and it works the same on Windows and macOS. So the account
//! users actually wanted to connect is this one.
//!
//! Three things differ from [`crate::gdrive`], and each of them is why this isn't a copy of it:
//!
//! - **No client secret.** Registered as a public client, the flow is `client_id` plus PKCE, which
//!   is what RFC 8252 asks for and one fewer field for the user to paste. Google's "Desktop app"
//!   client type demands a secret anyway; Microsoft's doesn't.
//! - **The redirect is spelled `localhost`.** The Azure portal will not accept an
//!   `http://127.0.0.1` redirect URI through its UI — only by hand-editing the app manifest — and
//!   documents `http://localhost` instead. Microsoft also ignores the *port* when matching a
//!   loopback redirect, so a single registered `http://localhost` covers every ephemeral port this
//!   ever binds. (The listener is still IPv4: `[::1]` is explicitly unsupported.)
//! - **The refresh token rotates.** Every refresh returns a fresh one carrying a fresh 90-day
//!   lifetime, so [`access_token`] writes the replacement back before returning. Google reuses the
//!   same token indefinitely; storing Microsoft's once and never again would work for three months
//!   and then stop, however often the app ran in between.
//!
//! Scope is `Files.ReadWrite.AppFolder` — the app folder, `Apps/<app name>` in the user's OneDrive,
//! reached through the `approot` alias so no path has to be localised or looked up. It is the exact
//! counterpart of Drive's `drive.file`: this cannot see anything in OneDrive it did not put there.
//! And because the folder belongs to the app registration, a second machine signing in with the
//! same client id finds the first one's backup rather than starting a rival copy.

use serde::Serialize;

use crate::oauth::{self, urlencode};
use crate::secrets;

/// `common` accepts both personal Microsoft accounts and work or school ones; which of those the
/// user can actually pick is decided by the audience they chose when registering the app, not here.
const AUTH_ENDPOINT: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_ENDPOINT: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";

const SERVICE: &str = "OneDrive";

/// See the module note: the portal refuses `http://127.0.0.1`, and the port is ignored when
/// matching a `localhost` redirect.
const LOOPBACK_HOST: &str = "localhost";

/// `Files.ReadWrite.AppFolder` is the least-privileged permission that can reach `approot` on a
/// personal Microsoft account. `User.Read` is only so the UI can name the connected account, and
/// `offline_access` is what makes Microsoft issue a refresh token at all.
const SCOPES: &str = "https://graph.microsoft.com/Files.ReadWrite.AppFolder https://graph.microsoft.com/User.Read offline_access";

/// Simple `PUT` uploads are documented up to 250 MB, which a sealed configuration will not come
/// close to — but a backup that fails at the size limit with Graph's own wording would be a
/// mystery, so the check is here and says what it means.
const MAX_SIMPLE_UPLOAD: usize = 250 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct OneDriveAccount {
    pub email: String,
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Exchanges the stored refresh token for a short-lived access token, and stores the refresh token
/// that comes back with it.
///
/// That second half is not optional. Microsoft replaces the refresh token on every use, and the
/// replacement is what carries a new 90-day lifetime; the original's own 90 days keep running out
/// regardless of how often it is redeemed. Keeping it — which is what the Google code next door
/// correctly does for Google — would give an install that backs up faithfully for three months and
/// then fails every scheduled run with `invalid_grant`.
///
/// Spending a token does *not* revoke it, which is what makes the grant safe to carry inside the
/// backup: the machine restored from the file and the machine that wrote it both keep working.
async fn access_token(client_id: &str) -> Result<String, String> {
    let refresh_token = secrets::get_secret(&secrets::onedrive_refresh_token_key())?
        .filter(|token| !token.trim().is_empty())
        .ok_or("OneDrive is not connected")?;

    let payload = oauth::post_form(
        TOKEN_ENDPOINT,
        &[
            ("client_id", client_id),
            ("refresh_token", &refresh_token),
            ("grant_type", "refresh_token"),
            ("scope", SCOPES),
        ],
    )
    .await
    .map_err(expired)?;

    // Written before the access token is handed out, so a failure here can't leave the process
    // using a grant whose replacement was never saved.
    if let Some(rotated) = oauth::field(&payload, "refresh_token") {
        if !rotated.trim().is_empty() && rotated != refresh_token {
            secrets::set_secret(&secrets::onedrive_refresh_token_key(), &rotated)?;
        }
    }

    oauth::field(&payload, "access_token")
        .ok_or_else(|| "Microsoft's token response had no access_token".to_string())
}

/// A dead grant is the one failure here a user can act on, and `invalid_grant` on its own doesn't
/// tell them what to do. Microsoft expires a public client's refresh token after 90 days of
/// inactivity, so an install left alone over a quiet quarter lands exactly here.
fn expired(message: String) -> String {
    if message.contains("invalid_grant") || message.contains("AADSTS70008") {
        return format!("{message} (reconnect OneDrive in Settings — the sign-in has expired)");
    }
    message
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

pub fn is_connected() -> Result<bool, String> {
    Ok(secrets::get_secret(&secrets::onedrive_refresh_token_key())?
        .filter(|token| !token.trim().is_empty())
        .is_some())
}

pub fn disconnect() -> Result<(), String> {
    secrets::delete_secret(&secrets::onedrive_refresh_token_key())
}

/// Runs the full consent flow and returns the account that granted it.
pub async fn connect(client_id: String) -> Result<OneDriveAccount, String> {
    if client_id.trim().is_empty() {
        return Err("no Microsoft application (client) id is configured".into());
    }

    // `prompt=select_account` rather than the default: someone with a personal and a work account
    // signed into the same browser would otherwise be silently connected as whichever one the
    // browser happened to be holding, with no indication that a choice was made for them.
    let grant = oauth::consent(SERVICE, LOOPBACK_HOST, |redirect_uri, challenge, state| {
        format!(
            "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&response_mode=query&scope={}&code_challenge={}&code_challenge_method=S256&state={}&prompt=select_account",
            urlencode(&client_id),
            urlencode(redirect_uri),
            urlencode(SCOPES),
            urlencode(challenge),
            urlencode(state),
        )
    })
    .await?;

    let payload = oauth::post_form(
        TOKEN_ENDPOINT,
        &[
            ("client_id", &client_id),
            ("code", &grant.code),
            ("code_verifier", &grant.verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &grant.redirect_uri),
            ("scope", SCOPES),
        ],
    )
    .await?;

    let refresh_token = oauth::field(&payload, "refresh_token")
        .filter(|token| !token.trim().is_empty())
        .ok_or("Microsoft did not return a refresh token — check that offline_access is among the app registration's delegated permissions, then connect again")?;
    secrets::set_secret(&secrets::onedrive_refresh_token_key(), &refresh_token)?;

    let access = oauth::field(&payload, "access_token").unwrap_or_default();
    Ok(OneDriveAccount { email: fetch_email(&access).await.unwrap_or_default() })
}

/// The signed-in account's address, for the line that says *which* OneDrive this is.
///
/// A personal Microsoft account leaves `mail` null and puts the address in `userPrincipalName`; a
/// work account usually fills both. The display name is the last resort rather than nothing at all,
/// because "connected as Sebastián" still answers the question the label exists to answer.
async fn fetch_email(access_token: &str) -> Result<String, String> {
    let response = oauth::client()?
        .get(format!("{GRAPH}/me"))
        .bearer_auth(access_token)
        .query(&[("$select", "displayName,mail,userPrincipalName")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body = response.text().await.map_err(|e| e.to_string())?;
    let payload: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(oauth::field(&payload, "mail")
        .or_else(|| oauth::field(&payload, "userPrincipalName"))
        .or_else(|| oauth::field(&payload, "displayName"))
        .unwrap_or_default())
}

// ---------------------------------------------------------------------------
// The app folder
// ---------------------------------------------------------------------------

/// A file inside the app folder, addressed by name.
///
/// Path addressing rather than an item id, which is the one simplification OneDrive allows over
/// Drive: `approot` is a stable alias Graph resolves per user, so the same name means the same file
/// on every machine and there is no id to learn, store or lose. It is also why `BackupSettings` has
/// no OneDrive counterpart to `drive_file_id`.
fn item_url(name: &str, suffix: &str) -> String {
    format!("{GRAPH}/me/drive/special/approot:/{}:{suffix}", urlencode(name))
}

/// Creates the backup file or overwrites the existing one.
///
/// Bytes rather than a `String`, for the same reason as in Drive's uploader: what goes up is a
/// sealed binary envelope, and text would mean either lossy UTF-8 or a base64 round trip inflating
/// it by a third for a file about to cross a network.
pub async fn upload_bytes(client_id: String, name: String, contents: Vec<u8>) -> Result<(), String> {
    if contents.len() > MAX_SIMPLE_UPLOAD {
        return Err(format!(
            "the backup is {} MB, past the {} MB a single upload to OneDrive can carry",
            contents.len() / (1024 * 1024),
            MAX_SIMPLE_UPLOAD / (1024 * 1024)
        ));
    }
    let token = access_token(&client_id).await?;

    let response = oauth::client()?
        .put(format!(
            "{}?%40microsoft.graph.conflictBehavior=replace",
            item_url(&name, "/content")
        ))
        .bearer_auth(&token)
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(contents)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    Err(oauth::describe(status, &body))
}

/// The sealed backup in the app folder, or `None` when there isn't one there yet.
///
/// A missing file is not an error: it is the normal state of a freshly connected account, and both
/// callers — "what is at my destination?" and "restore from it" — want to say something specific
/// about it rather than surface Graph's `itemNotFound`.
///
/// Graph answers the content request with a redirect to a short-lived, pre-authenticated download
/// URL. `reqwest` follows it and drops the `Authorization` header on the way, which is what that
/// URL expects — sending a bearer token to the storage backend is how this fails with a 401 that
/// makes no sense.
pub async fn download_bytes(client_id: String, name: String) -> Result<Option<Vec<u8>>, String> {
    let token = access_token(&client_id).await?;
    let response = oauth::client()?
        .get(item_url(&name, "/content"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let body = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // A read-only-ish grant that has never written gets a 403 for an app folder that was never
        // created, which means the same thing to the user as a 404.
        if status == reqwest::StatusCode::FORBIDDEN {
            return Ok(None);
        }
        return Err(oauth::describe(status, &String::from_utf8_lossy(&body)));
    }
    Ok(Some(body.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two shapes every Graph call here is built from. Getting the colon placement wrong is the
    /// classic way to address the *drive root* instead of the app folder, which would silently ask
    /// for a permission this app deliberately never requests.
    #[test]
    fn files_are_addressed_inside_the_app_folder() {
        assert_eq!(
            item_url("codeflow-backup.cfbackup", ""),
            "https://graph.microsoft.com/v1.0/me/drive/special/approot:/codeflow-backup.cfbackup:"
        );
        assert_eq!(
            item_url("codeflow-backup.cfbackup", "/content"),
            "https://graph.microsoft.com/v1.0/me/drive/special/approot:/codeflow-backup.cfbackup:/content"
        );
    }

    /// A name is one path segment. Dots are unreserved and stay dots, so what has to be encoded is
    /// the separator: with it intact, a crafted name would traverse out of the app folder and ask
    /// for something the granted scope deliberately cannot reach.
    #[test]
    fn a_name_cannot_escape_the_app_folder() {
        let url = item_url("../../evil.cfbackup", "/content");
        let name = url.trim_start_matches(&format!("{GRAPH}/me/drive/special/approot:/"));
        assert_eq!(name, "..%2F..%2Fevil.cfbackup:/content");
    }

    /// The dot in `.cfbackup` and the dashes in the dated names are unreserved, and encoding them
    /// would change the file's name in the user's OneDrive.
    #[test]
    fn ordinary_backup_names_pass_through_untouched() {
        assert!(item_url("codeflow-backup-2026-08-01-1432.cfbackup", "").ends_with(
            "codeflow-backup-2026-08-01-1432.cfbackup:"
        ));
    }

    /// The one error worth rewriting, and only that one.
    #[test]
    fn an_expired_grant_says_what_to_do_about_it() {
        let rewritten = expired("invalid_grant — token expired".into());
        assert!(rewritten.contains("reconnect OneDrive"), "{rewritten}");
        assert_eq!(expired("network unreachable".into()), "network unreachable");
    }

    /// The scope list is load-bearing in three separate places — consent, both token calls — and a
    /// missing `offline_access` produces a connection that works once and never again.
    #[test]
    fn the_scopes_cover_the_app_folder_and_the_refresh() {
        assert!(SCOPES.contains("Files.ReadWrite.AppFolder"));
        assert!(SCOPES.contains("offline_access"));
        // Fully qualified for Graph's own permissions, bare for the OIDC one — mixing that up is
        // an `invalid_scope` at the authorization endpoint.
        assert!(!SCOPES.contains("https://graph.microsoft.com/offline_access"));
    }
}
