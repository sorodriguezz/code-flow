//! Settings › IA › Cuentas: adding, naming, removing and checking the accounts of each AI CLI.
//!
//! What an account *is* — and why this app never touches a credential — is `crate::ai_accounts`.
//! This file is only the commands the screen calls. Every write announces itself on
//! `settings:changed` under the key [`CHANGED_KEY`], the same channel a settings row uses, so a
//! detached window re-reads its list instead of offering an account that was just deleted.

use serde::Serialize;
use tauri::{Emitter, State};

use crate::ai_accounts::{self, AccountEnv, AccountStatus, AiAccount, WorkspaceAccount};
use crate::db::Db;

/// The key other windows watch for any change to accounts or their workspace defaults.
const CHANGED_KEY: &str = "ai_accounts";

fn announce(webview: &tauri::Webview) {
    #[derive(Clone, Serialize)]
    struct SettingChanged<'a> {
        key: &'a str,
        origin: &'a str,
    }
    let _ = webview.emit("settings:changed", SettingChanged { key: CHANGED_KEY, origin: webview.label() });
}

/// Every added account plus every workspace's defaults — what the screen and the pickers draw.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsSnapshot {
    pub accounts: Vec<AiAccount>,
    pub workspace_defaults: Vec<WorkspaceAccount>,
}

#[tauri::command]
pub fn ai_accounts_list(db: State<'_, Db>) -> Result<AccountsSnapshot, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(AccountsSnapshot {
        accounts: ai_accounts::list(&conn).map_err(|e| e.to_string())?,
        workspace_defaults: ai_accounts::list_workspace_defaults(&conn).map_err(|e| e.to_string())?,
    })
}

/// Adds an account and prepares its directory. Signing in is a separate step the user watches —
/// the screen opens a terminal as this account and runs the CLI's own login there.
///
/// `copy_config` gives the new account a copy of the user's configuration (never credentials); see
/// [`ai_accounts::prepare_dir`].
#[tauri::command]
pub fn ai_account_create(
    webview: tauri::Webview,
    db: State<'_, Db>,
    provider: String,
    label: String,
    copy_config: Option<bool>,
) -> Result<AiAccount, String> {
    if !ai_accounts::supports_accounts(&provider) {
        return Err(format!("{provider} no admite varias cuentas"));
    }
    let label = label.trim();
    if label.is_empty() {
        return Err("El nombre de la cuenta no puede estar vacío".to_string());
    }
    let account = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ai_accounts::insert(&conn, &provider, label).map_err(|e| e.to_string())?
    };
    if let Err(e) = ai_accounts::prepare_dir(&provider, &account.id, copy_config.unwrap_or(true)) {
        // A row with no directory would sign in nowhere; take it back rather than leave it.
        if let Ok(conn) = db.0.lock() {
            let _ = ai_accounts::delete(&conn, &account.id);
        }
        return Err(format!("No se pudo preparar la carpeta de la cuenta: {e}"));
    }
    announce(&webview);
    Ok(account)
}

#[tauri::command]
pub fn ai_account_rename(
    webview: tauri::Webview,
    db: State<'_, Db>,
    id: String,
    label: String,
) -> Result<(), String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("El nombre de la cuenta no puede estar vacío".to_string());
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ai_accounts::rename(&conn, &id, label).map_err(|e| e.to_string())?;
    }
    announce(&webview);
    Ok(())
}

/// Removes an account: signs its CLI out (so Codex revokes the tokens and Claude drops the keychain
/// item it named after the directory), deletes the row and every preference naming it, and then the
/// directory — which is only ever one under this app's own `ai-accounts` root.
#[tauri::command]
pub async fn ai_account_delete(webview: tauri::Webview, db: State<'_, Db>, id: String) -> Result<(), String> {
    let (account, binary) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let Some(account) = ai_accounts::get(&conn, &id).map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let binary = ai_accounts::binary_for(&conn, &account.provider);
        (account, binary)
    };
    let env = AccountEnv::for_account(&account.provider, &account.id);
    // Best effort: an account that was never signed in, or whose CLI is gone, is still removed.
    let _ = ai_accounts::logout(&binary, &env).await;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ai_accounts::delete(&conn, &id).map_err(|e| e.to_string())?;
    }
    let dir = ai_accounts::account_dir(&account.provider, &account.id);
    let root = crate::paths::state_dir().join("ai-accounts");
    if dir.starts_with(&root) && dir != root {
        let _ = std::fs::remove_dir_all(&dir);
    }
    announce(&webview);
    Ok(())
}

/// The binary and the environment a command about one account runs with — `account_id = None` is
/// the system account. An id that is gone, or another provider's, is refused rather than quietly
/// answered for the system account instead.
fn target(db: &Db, provider: &str, account_id: Option<&str>) -> Result<(String, AccountEnv), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let binary = ai_accounts::binary_for(&conn, provider);
    let env = match account_id.filter(|id| !id.trim().is_empty()) {
        Some(id) => match ai_accounts::get(&conn, id).map_err(|e| e.to_string())? {
            Some(account) if account.provider == provider => AccountEnv::for_account(provider, &account.id),
            _ => return Err("Esa cuenta ya no existe".to_string()),
        },
        None => AccountEnv::system(provider),
    };
    Ok((binary, env))
}

/// Who an account's CLI says it is signed in as — `account_id = None` asks about the system
/// account. Runs the CLI's own status command with the account's environment; spends nothing.
#[tauri::command]
pub async fn ai_account_status(
    db: State<'_, Db>,
    provider: String,
    account_id: Option<String>,
) -> Result<AccountStatus, String> {
    let (binary, env) = target(&db, &provider, account_id.as_deref())?;
    Ok(ai_accounts::probe(&binary, &env).await)
}

/// Signs an account's CLI out and keeps the account, so it can be signed in again from the same
/// row. `account_id = None` is the system account — the login the user's own terminal uses, which
/// is signed out there too; the screen says so before calling this.
#[tauri::command]
pub async fn ai_account_logout(db: State<'_, Db>, provider: String, account_id: Option<String>) -> Result<(), String> {
    let (binary, env) = target(&db, &provider, account_id.as_deref())?;
    ai_accounts::logout(&binary, &env).await
}

/// Sets a workspace's default account for one provider — an id, [`ai_accounts::SYSTEM`], or empty
/// to go back to inheriting the provider's default.
#[tauri::command]
pub fn ai_account_set_workspace_default(
    webview: tauri::Webview,
    db: State<'_, Db>,
    workspace_id: String,
    provider: String,
    account: String,
) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ai_accounts::set_workspace_default(&conn, &workspace_id, &provider, account.trim())
            .map_err(|e| e.to_string())?;
    }
    announce(&webview);
    Ok(())
}

/// The account a run of `provider` for `task` in `workspace_id` would use right now — what the
/// read-only engine chips name, so they agree with what will actually run. `None` in the answer's
/// `account_id` is the system account.
#[tauri::command]
pub fn ai_account_resolve(
    db: State<'_, Db>,
    provider: String,
    task: Option<String>,
    workspace_id: Option<String>,
) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(ai_accounts::resolve(
        &conn,
        &provider,
        task.as_deref(),
        workspace_id.as_deref(),
        ai_accounts::Choice::Auto,
    )
    .account_id)
}
