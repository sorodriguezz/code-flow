//! Microsoft Entra ID access tokens, for the engines that accept one instead of a password.
//!
//! Azure SQL is routinely configured as **Entra-only**: SQL logins are disabled outright, and the
//! only way in is a bearer token for `https://database.windows.net`. Without this the whole engine
//! is unreachable for those users, however correct the rest of the driver is.
//!
//! Two ways to get one, chosen because between them they cover how people actually sign in:
//!
//! - [`DbAuthMethod::EntraCli`] shells out to **`az account get-access-token`**. This is the one
//!   that works for a human being: the Azure CLI already holds the session from `az login`, which
//!   means MFA, conditional access, FIDO keys and whatever else the tenant enforces have already
//!   happened, in Microsoft's own flow. CodeFlow stores no credential at all — it borrows a session
//!   the user established elsewhere, and if that session has expired the CLI says so and this
//!   repeats it.
//! - [`DbAuthMethod::EntraServicePrincipal`] does the **client-credentials** exchange directly. An
//!   application identity has no interactive flow to borrow, so this is a plain POST to the token
//!   endpoint. The client secret is a secret like any other: it lives in the OS keychain, in the
//!   same slot a password would, and is read here through [`DbConnectionConfig::resolve_password`].
//!
//! What is deliberately *not* here is an interactive sign-in of our own. Doing it properly means
//! registering a public client application, and doing it improperly means borrowing some other
//! product's client id — which breaks the moment that tenant blocks it, and misrepresents who is
//! asking for the token. Deferring to `az login` is both simpler and more honest.
//!
//! Tokens are short-lived (about an hour) and are fetched per connect rather than cached. A session
//! authenticates once at login and the server does not re-check the token afterwards, so a cache
//! would save nothing but the occasional subprocess and would introduce a staleness bug.

use serde::Deserialize;

use super::{DbAuthMethod, DbConnectionConfig};
use crate::proc::command;

/// The audience an Azure SQL / SQL Server token has to be issued for. Both the CLI's `--resource`
/// and the OAuth `scope` (as `{resource}/.default`) are built from it.
pub const SQL_RESOURCE: &str = "https://database.windows.net";

/// An access token for `resource`, however this connection is configured to get one.
///
/// `config` must already have been through `resolve_password`, since the service-principal path
/// reads the client secret out of it.
pub async fn access_token(config: &DbConnectionConfig, resource: &str) -> Result<String, String> {
    match config.auth_method {
        DbAuthMethod::Password => Err("This connection isn't set to use Microsoft Entra ID.".into()),
        DbAuthMethod::EntraCli => cli_token(config.tenant_id.trim(), resource).await,
        DbAuthMethod::EntraServicePrincipal => {
            let tenant = config.tenant_id.trim();
            if tenant.is_empty() {
                return Err("A service principal needs its directory (tenant) ID.".into());
            }
            if config.user.trim().is_empty() {
                return Err("A service principal needs its application (client) ID.".into());
            }
            service_principal_token(tenant, config.user.trim(), &config.password, resource).await
        }
    }
}

/// The token the Azure CLI already holds.
///
/// `pub(crate)` because Azure SQL is no longer the only caller: an Azure Storage host whose tenant
/// has disabled account keys borrows the same `az login` session, for the same reason and with the
/// same failure messages — only the `resource` differs.
pub(crate) async fn cli_token(tenant: &str, resource: &str) -> Result<String, String> {
    let mut cmd = command(azure_cli());
    cmd.args(["account", "get-access-token", "--resource", resource, "--output", "json"]);
    if !tenant.is_empty() {
        cmd.args(["--tenant", tenant]);
    }
    // The CLI writes progress and warnings to stderr and the JSON to stdout, so they are read
    // separately: a warning about an upcoming CLI version must not end up parsed as a token.
    let output = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "The Azure CLI (`az`) isn't installed, or isn't on this app's PATH. Install it and run \
             `az login`, or switch this connection to a service principal."
                .to_string()
        } else {
            format!("Couldn't run the Azure CLI: {e}")
        }
    })?;

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // The two failures worth naming, because the fix is a command the user can run rather than
        // anything to change in this dialog.
        if message.contains("az login") || message.to_lowercase().contains("not logged in") {
            return Err(format!(
                "The Azure CLI has no signed-in session. Run `az login` and try again.\n\n{message}"
            ));
        }
        return Err(if message.is_empty() {
            "`az account get-access-token` failed without saying why.".to_string()
        } else {
            message
        });
    }

    #[derive(Deserialize)]
    struct CliToken {
        #[serde(rename = "accessToken")]
        access_token: String,
    }
    let parsed: CliToken = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("The Azure CLI's answer wasn't the JSON we expected: {e}"))?;
    if parsed.access_token.is_empty() {
        return Err("The Azure CLI returned an empty token.".into());
    }
    Ok(parsed.access_token)
}

/// `az` on Unix; `az.cmd` on Windows, where the CLI is a batch shim that `CreateProcess` will not
/// run under its bare name.
fn azure_cli() -> &'static str {
    if cfg!(windows) {
        "az.cmd"
    } else {
        "az"
    }
}

/// The OAuth 2.0 client-credentials grant, straight to the tenant's token endpoint.
async fn service_principal_token(
    tenant: &str,
    client_id: &str,
    secret: &str,
    resource: &str,
) -> Result<String, String> {
    if secret.is_empty() {
        return Err(
            "No client secret is saved for this connection. Enter it in the connection dialog."
                .into(),
        );
    }
    let url = format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token");
    // One client for the process rather than one per token fetch. Tokens are deliberately not
    // cached (see the module docs), so this runs on every connect — and a fresh rustls client each
    // time means a fresh `ClientConfig`, a fresh root certificate store and an empty connection
    // pool, i.e. a full TLS handshake to login.microsoftonline.com every single time. Cloning is
    // free (a `reqwest::Client` is an `Arc` around the inner state) and shares the pool. Nothing
    // varies the transport per call here, so this is behaviour-identical.
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let response = CLIENT
        .get_or_init(reqwest::Client::new)
        .post(&url)
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", client_id),
            ("client_secret", secret),
            ("scope", &format!("{resource}/.default")),
        ])
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the Microsoft Entra ID token endpoint: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // Entra's error body carries `error_description`, which is the one useful sentence in it —
        // "AADSTS7000215: Invalid client secret provided" beats a bare 401.
        #[derive(Deserialize)]
        struct TokenError {
            error_description: Option<String>,
            error: Option<String>,
        }
        let described = serde_json::from_str::<TokenError>(&body)
            .ok()
            .and_then(|e| e.error_description.or(e.error));
        return Err(match described {
            Some(message) => format!("Microsoft Entra ID refused the sign-in: {message}"),
            None => format!("Microsoft Entra ID refused the sign-in ({status})."),
        });
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
    }
    let parsed: TokenResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Microsoft Entra ID's answer wasn't the JSON we expected: {e}"))?;
    Ok(parsed.access_token)
}
