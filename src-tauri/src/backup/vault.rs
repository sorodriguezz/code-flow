//! The credentials half of the backup: everything CodeFlow keeps in the OS credential store.
//!
//! This is the part that makes a restored machine *work* rather than merely look right. Without it
//! the user lands on the other computer with every repository, collection and database connection
//! in place and not one of them able to authenticate — which is the same as not having restored.
//!
//! **The store cannot be listed.** Neither the Windows Credential Manager nor the macOS Keychain
//! offers "give me every entry this application wrote" through the `keyring` crate, and enumerating
//! the platform APIs directly would mean reading entries belonging to other applications. So the
//! key list is *reconstructed* instead: every key CodeFlow can mint is a deterministic function of
//! something in the database or in `app_settings` (an org, a host, a connection id, a provider),
//! and this module walks those and rebuilds the list.
//!
//! The consequence to keep in mind when adding a credential anywhere in the app: if its key isn't
//! derivable from something here, it will not be backed up, and nothing will say so. That is why
//! [`secret_keys`] is written as one exhaustive match over `secrets.rs` rather than as a helper
//! each call site remembers to update.

use rusqlite::Connection;
use serde_json::Value;

use crate::db::queries;
use crate::secrets;

use super::snapshot::SecretEntry;

/// The AI providers a key can be stored for. Mirrors `AI_PROVIDERS` in `src/lib/aiProviders.ts`;
/// the subscription-based engines are listed too because an install can be pointed at an
/// OpenAI-compatible endpoint for any of them.
const AI_PROVIDERS: &[&str] = &["claude", "gemini", "codex", "grok", "opencode", "ollama", "openai"];

/// Reads a JSON `app_settings` blob and pulls one string field out of each of its entries — the
/// shape both `ado_connections` (`[{org}]`) and `github_connections` (`[{host}]`) use.
fn field_of_each(conn: &Connection, key: &str, field: &str) -> Vec<String> {
    let Ok(Some(raw)) = queries::get_setting(conn, key) else {
        return Vec::new();
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.get(field).and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .collect()
}

fn column(conn: &Connection, sql: &str) -> Vec<String> {
    conn.prepare(sql)
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, Option<String>>(0))?
                .collect::<rusqlite::Result<Vec<Option<String>>>>()
        })
        .unwrap_or_default()
        .into_iter()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .collect()
}

fn push_unique(into: &mut Vec<String>, key: String) {
    if !into.contains(&key) {
        into.push(key);
    }
}

/// Every credential key this install could have written, whether or not one is actually stored
/// under it. Reading a key that holds nothing costs one miss and yields nothing, which is far
/// cheaper than the alternative — a backup silently missing the one token the user needed.
pub fn secret_keys(conn: &Connection) -> Vec<String> {
    let mut keys = Vec::new();

    // Azure DevOps: one PAT per organization.
    let mut orgs = field_of_each(conn, "ado_connections", "org");
    if let Ok(Some(legacy)) = queries::get_setting(conn, "ado_default_org") {
        orgs.push(legacy);
    }
    orgs.extend(column(conn, "SELECT DISTINCT ado_org FROM projects"));
    for org in orgs {
        push_unique(&mut keys, secrets::ado_pat_key(org.trim()));
    }

    // GitHub: one token per host, github.com included whether or not it was ever listed — it is
    // the host a connection is created under by default.
    let mut hosts = field_of_each(conn, "github_connections", "host");
    hosts.push("github.com".to_string());
    hosts.extend(column(conn, "SELECT DISTINCT github_host FROM projects"));
    for host in hosts {
        push_unique(&mut keys, secrets::github_token_key(&host.trim().to_ascii_lowercase()));
    }

    // GitLab: one token per host, gitlab.com included for the same reason as github.com.
    let mut gitlab_hosts = field_of_each(conn, "gitlab_connections", "host");
    gitlab_hosts.push("gitlab.com".to_string());
    gitlab_hosts.extend(column(conn, "SELECT DISTINCT gitlab_host FROM projects"));
    for host in gitlab_hosts {
        push_unique(&mut keys, secrets::gitlab_token_key(&host.trim().to_ascii_lowercase()));
    }

    // AI providers: the API key of every HTTP-based engine.
    for provider in AI_PROVIDERS {
        push_unique(&mut keys, secrets::ai_api_key(provider));
    }

    // The backup's own passphrase, and the one it replaced. Circular only in appearance: whoever
    // can open the file already knows it, and carrying it is what lets the restored machine keep
    // backing itself up without being set up again.
    push_unique(&mut keys, secrets::backup_passphrase_key());
    push_unique(&mut keys, secrets::api_backup_passphrase_key());

    // The user's own Google OAuth client, and the grant it obtained.
    push_unique(&mut keys, secrets::gdrive_client_secret_key());
    push_unique(&mut keys, secrets::gdrive_refresh_token_key());

    // The OneDrive grant. No client secret to carry — that registration is a public client.
    push_unique(&mut keys, secrets::onedrive_refresh_token_key());

    // Shared collections: the anon key of every Supabase project involved, plus one share token per
    // collection.
    push_unique(&mut keys, secrets::supabase_legacy_anon_key());
    for url in column(conn, "SELECT DISTINCT project_url FROM api_shared_collections") {
        push_unique(&mut keys, secrets::supabase_anon_key(&url));
    }
    for id in column(conn, "SELECT collection_id FROM api_shared_collections") {
        push_unique(&mut keys, secrets::supabase_share_token(&id));
    }

    // Database passwords — the column the schema deliberately doesn't have.
    for id in column(conn, "SELECT id FROM db_connections") {
        push_unique(&mut keys, crate::datasource::password_key(&id));
    }

    keys
}

/// Reads each key, skipping the ones holding nothing.
///
/// A read that *errors* is skipped too rather than failing the backup: on macOS a Keychain item
/// whose ACL doesn't recognise the app's signature prompts for the login password, and a user who
/// dismisses one prompt should end up with a backup missing that credential — not with no backup.
/// The count in the result is what tells them how many travelled.
pub fn collect(conn: &Connection) -> Vec<SecretEntry> {
    secret_keys(conn)
        .into_iter()
        .filter_map(|key| match secrets::get_secret(&key) {
            Ok(Some(value)) if !value.is_empty() => Some(SecretEntry { key, value }),
            _ => None,
        })
        .collect()
}

/// Writes every credential from a backup into this machine's store, returning how many landed.
///
/// Failures are counted rather than raised for the same reason as above, and because the tables
/// have already been restored by the time this runs: aborting here would leave a machine with the
/// configuration and none of the credentials, and no way to retry the second half alone.
pub fn restore(entries: &[SecretEntry]) -> (i64, Vec<String>) {
    let mut written = 0i64;
    let mut failed = Vec::new();
    for entry in entries {
        if entry.value.is_empty() {
            continue;
        }
        match secrets::set_secret(&entry.key, &entry.value) {
            Ok(()) => written += 1,
            // The key, never the value — this string ends up in a toast and in the log.
            Err(_) => failed.push(entry.key.clone()),
        }
    }
    (written, failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            r#"
            DELETE FROM workspaces;
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Flow', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO projects (id, workspace_id, name, local_path, ado_org, github_host, sort_order, created_at)
                VALUES ('p1', 'w1', 'api', '/tmp/api', 'contoso', 'github.acme.com', 0, '2026-01-01T00:00:00+00:00');
            INSERT INTO db_connections (id, workspace_id, name, kind, spec, created_at, updated_at)
                VALUES ('d1', 'w1', 'prod', 'postgres', '{}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            INSERT INTO api_shared_collections (collection_id, workspace_id, project_url, created_at)
                VALUES ('c1', 'w1', 'https://abc.supabase.co', '2026-01-01T00:00:00+00:00');
            INSERT INTO app_settings (key, value)
                VALUES ('ado_connections', '[{"org":"fabrikam"}]');
            INSERT INTO app_settings (key, value)
                VALUES ('github_connections', '[{"host":"github.com"}]');
            "#,
        )
        .unwrap();
        conn
    }

    /// Every family of credential the app can mint has to be reachable from the database, because
    /// the credential store itself cannot be asked what is in it.
    #[test]
    fn every_credential_family_is_reconstructed() {
        let keys = secret_keys(&seeded());
        for expected in [
            "ado-pat:contoso",
            "ado-pat:fabrikam",
            "github-token:github.com",
            "github-token:github.acme.com",
            "gitlab-token:gitlab.com",
            "ai-api-key:claude",
            "ai-api-key:openai",
            "gdrive-client-secret",
            "gdrive-refresh-token",
            "onedrive-refresh-token",
            "db-password:d1",
            "supabase-collection:c1",
            "supabase-anon:abc.supabase.co",
        ] {
            assert!(keys.contains(&expected.to_string()), "missing {expected} in {keys:?}");
        }
    }

    #[test]
    fn a_key_named_twice_is_only_read_once() {
        let keys = secret_keys(&seeded());
        let github: Vec<_> = keys.iter().filter(|k| k.as_str() == "github-token:github.com").collect();
        assert_eq!(github.len(), 1);
    }

    /// A fresh install has no projects and no connections, and must still produce the fixed keys
    /// rather than an empty list.
    #[test]
    fn an_empty_install_still_lists_the_fixed_keys() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let keys = secret_keys(&conn);
        assert!(keys.contains(&"github-token:github.com".to_string()));
        assert!(keys.contains(&"gitlab-token:gitlab.com".to_string()));
        assert!(keys.contains(&secrets::backup_passphrase_key()));
    }
}
