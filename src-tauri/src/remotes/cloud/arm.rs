//! Finding the storage accounts a Microsoft account can see.
//!
//! **Why this exists at all.** Every other way into this app is "know the address, paste the
//! secret". Storage Explorer's actual trick is that you never do either: you sign in once and your
//! accounts are simply *there*, across every subscription, with no endpoint typed and no key on the
//! clipboard. That is not a storage feature — it is Azure Resource Manager, a completely different
//! API on a completely different host, and this module is the only place in the app that talks to
//! it.
//!
//! **The sign-in is borrowed, not built.** The token comes from the Azure CLI's session
//! ([`crate::datasource::entra::cli_token`]) — the same one the Entra credential already uses for
//! the data plane, only asked for a different resource. A sign-in of our own would need an Entra
//! *app registration*: a client ID to run the device-code flow against. Storage Explorer and the
//! CLI each use a first-party Microsoft one, and helping ourselves to either would be pretending to
//! be an application we are not. Until CodeFlow has a registration of its own, `az login` is the
//! honest way in — and the discovery below, which is the half people actually notice, needs no
//! registration at all.
//!
//! **What is discovered is a host, not a credential.** The rows this produces are configured for
//! [`AzureAuth::Entra`], so nothing here ever reads an account key: the same signed-in identity that
//! listed the accounts is the one that will read the blobs. No secret is fetched, so none can leak.

use serde::Deserialize;

use super::super::{AzureAuth, RemoteHostSpec};

/// ARM's own audience. Not the storage one — a token for `storage.azure.com` is rejected here, and
/// the resulting 401 says nothing about which audience was wanted.
const RESOURCE: &str = "https://management.azure.com";

/// The version pins the response shape. Two are needed because the subscriptions endpoint and the
/// storage provider version independently.
const SUBSCRIPTIONS_API: &str = "2020-01-01";
const STORAGE_API: &str = "2023-01-01";

/// One storage account, as much of it as is worth carrying back.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DiscoveredAccount {
    pub name: String,
    /// Which subscription it was found in — the label a person recognises, not the GUID.
    pub subscription: String,
    pub resource_group: String,
    pub location: String,
    /// The blob endpoint the service itself reports. Read rather than assembled, because a sovereign
    /// cloud or an account with a custom domain does not follow the `{name}.blob.core.windows.net`
    /// pattern that building it here would assume.
    pub blob_endpoint: String,
    /// The DNS suffix pulled back out of that endpoint, which is what the spec stores.
    pub suffix: String,
}

impl DiscoveredAccount {
    /// The host row this account becomes.
    ///
    /// Entra, always: the identity that could list the account is the identity that should read it,
    /// and asking ARM for the account keys — which this deliberately does not do — would put a
    /// secret in the keychain that nobody asked to store.
    pub fn spec(&self) -> RemoteHostSpec {
        let mut spec =
            RemoteHostSpec { kind: super::super::RemoteKind::Azure, ..Default::default() };
        spec.azure.auth = AzureAuth::Entra;
        spec.azure.account = self.name.clone();
        spec.azure.endpoint_suffix = self.suffix.clone();
        spec
    }
}

#[derive(Deserialize)]
struct Page<T> {
    // `default` on a `Vec<T>` would demand `T: Default`, which none of these are and none need to
    // be — the empty page is the empty vec, spelled without a bound.
    #[serde(default = "Vec::new")]
    value: Vec<T>,
    #[serde(rename = "nextLink", default)]
    next_link: Option<String>,
}

#[derive(Deserialize)]
struct Subscription {
    #[serde(rename = "subscriptionId")]
    id: String,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
struct StorageAccount {
    #[serde(default)]
    name: String,
    /// `/subscriptions/…/resourceGroups/rg/providers/…` — the resource group is a segment of it,
    /// and ARM does not return it as a field of its own.
    #[serde(default)]
    id: String,
    #[serde(default)]
    location: String,
    #[serde(default)]
    properties: StorageProperties,
}

#[derive(Deserialize, Default)]
struct StorageProperties {
    #[serde(rename = "primaryEndpoints", default)]
    primary_endpoints: Endpoints,
}

#[derive(Deserialize, Default)]
struct Endpoints {
    #[serde(default)]
    blob: String,
}

/// Every storage account in every enabled subscription this identity can see.
///
/// `tenant` is optional and passed straight through to the CLI: an account that belongs to several
/// directories has a different set of subscriptions in each, and the empty string means whichever
/// one `az login` last selected.
pub async fn discover(tenant: &str) -> Result<Vec<DiscoveredAccount>, String> {
    let token = crate::datasource::entra::cli_token(tenant, RESOURCE).await?;

    let subscriptions: Vec<Subscription> = fetch_all(
        &token,
        &format!("{RESOURCE}/subscriptions?api-version={SUBSCRIPTIONS_API}"),
        "subscriptions",
    )
    .await?;

    let mut found = Vec::new();
    for subscription in subscriptions {
        // A disabled or expired subscription answers every storage call with a 403 that names the
        // subscription and not the reason. Skipping them keeps that out of the list entirely.
        if !subscription.state.is_empty() && !subscription.state.eq_ignore_ascii_case("Enabled") {
            continue;
        }
        let label = if subscription.display_name.is_empty() {
            subscription.id.clone()
        } else {
            subscription.display_name.clone()
        };
        let url = format!(
            "{RESOURCE}/subscriptions/{}/providers/Microsoft.Storage/storageAccounts?api-version={STORAGE_API}",
            subscription.id
        );
        // One failed subscription must not lose the others: a tenant where one of five has the
        // provider unregistered is common, and an error there is not an error about the rest.
        let accounts: Vec<StorageAccount> = match fetch_all(&token, &url, "storage accounts").await {
            Ok(accounts) => accounts,
            Err(_) => continue,
        };
        for account in accounts {
            let blob_endpoint = account.properties.primary_endpoints.blob.clone();
            found.push(DiscoveredAccount {
                suffix: suffix_of(&blob_endpoint),
                name: account.name,
                subscription: label.clone(),
                resource_group: resource_group_of(&account.id),
                location: account.location,
                blob_endpoint,
            });
        }
    }
    found.sort_by(|a, b| (&a.subscription, &a.name).cmp(&(&b.subscription, &b.name)));
    Ok(found)
}

/// Follows `nextLink` until ARM stops offering one.
///
/// Unlike a container listing this is bounded by how many subscriptions a person has, so reading it
/// whole is the right shape — there is no page for the user to scroll.
async fn fetch_all<T: serde::de::DeserializeOwned>(
    token: &str,
    start: &str,
    what: &str,
) -> Result<Vec<T>, String> {
    let mut url = start.to_string();
    let mut all = Vec::new();
    // A guard rather than a `while true`: a service that kept handing back the same link would
    // otherwise loop for as long as the app is open.
    for _ in 0..50 {
        let response = super::http()
            .get(&url)
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Azure Resource Manager: {e}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|parsed| parsed["error"]["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| body.chars().take(200).collect());
            return Err(if detail.trim().is_empty() {
                format!("Couldn't list {what}: {status}")
            } else {
                format!("Couldn't list {what}: {status} — {}", detail.trim())
            });
        }
        let page: Page<T> = response
            .json()
            .await
            .map_err(|e| format!("Couldn't read the list of {what}: {e}"))?;
        all.extend(page.value);
        match page.next_link {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(all)
}

/// `https://contoso.blob.core.windows.net/` → `core.windows.net`. Empty when it isn't that shape,
/// which leaves the spec's own default in place rather than storing a guess.
fn suffix_of(endpoint: &str) -> String {
    let Ok(url) = url::Url::parse(endpoint) else { return String::new() };
    let host = url.host_str().unwrap_or_default();
    let mut parts = host.splitn(3, '.');
    let (_account, service, suffix) = (parts.next(), parts.next(), parts.next());
    match (service, suffix) {
        (Some("blob"), Some(suffix)) if !suffix.is_empty() => suffix.to_string(),
        _ => String::new(),
    }
}

/// The `resourceGroups/<name>` segment of an ARM resource id, which is where the group lives.
fn resource_group_of(id: &str) -> String {
    let mut parts = id.split('/');
    while let Some(part) = parts.next() {
        if part.eq_ignore_ascii_case("resourceGroups") {
            return parts.next().unwrap_or_default().to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blob_endpoint_gives_up_its_dns_suffix() {
        assert_eq!(suffix_of("https://contoso.blob.core.windows.net/"), "core.windows.net");
        // A sovereign cloud is the whole reason this is read rather than assumed.
        assert_eq!(suffix_of("https://contoso.blob.core.chinacloudapi.cn/"), "core.chinacloudapi.cn");
        // Anything that is not an account's own endpoint leaves the default alone.
        assert_eq!(suffix_of("https://storage.internal/"), "");
        assert_eq!(suffix_of("not a url"), "");
    }

    #[test]
    fn a_resource_id_gives_up_its_group() {
        assert_eq!(
            resource_group_of(
                "/subscriptions/0000/resourceGroups/team-rg/providers/Microsoft.Storage/storageAccounts/contoso"
            ),
            "team-rg",
        );
        // ARM has spelled it both ways over the years, and the casing is not ours to depend on.
        assert_eq!(resource_group_of("/subscriptions/0000/resourcegroups/team-rg/providers/x"), "team-rg");
        assert_eq!(resource_group_of("/subscriptions/0000"), "");
    }
}
