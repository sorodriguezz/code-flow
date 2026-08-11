//! Credentials, endpoints and signing for the Azure Storage services.
//!
//! One module for all of them because they genuinely share this half: Blob, Files, Queue and Table
//! are four endpoints on one account, reached with one of the same three credentials and — for two
//! of those three — signed by the same canonical form. Only the endpoint subdomain and the resource
//! path differ, which is what [`endpoint`] takes as an argument.
//!
//! **Three ways in.**
//!
//! - [`AzureAuth::AccountKey`] — Shared Key, the scheme the portal's "access keys" blade exists to
//!   feed. Signed here ([`shared_key`]); the key itself is base64 in the keychain.
//! - [`AzureAuth::Sas`] — a shared access signature. Not signed at all: the token *is* the
//!   signature, already computed by whoever issued it, and it rides in the query string. This is
//!   the one to hand somebody else, because it is scoped and it expires.
//! - [`AzureAuth::Entra`] — a bearer token from `az account get-access-token`, for the tenants
//!   where account keys are disabled by policy and Shared Key therefore cannot work at all. Borrows
//!   the session `az login` established, exactly as [`crate::datasource::entra`] does for Azure SQL
//!   — the same function, in fact, with a different resource.
//!
//! **Why the version header matters.** Every request carries `x-ms-version`, and the service
//! behaves like the version it is told: an older one silently lacks features, and Entra
//! authentication is rejected outright below 2017-11-09. It is pinned here rather than per call so
//! all four services move together.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use url::Url;

use super::super::{AzureAuth, RemoteHostSpec};

/// The REST API version every request declares. See the module comment.
pub const VERSION: &str = "2021-08-06";

/// The default DNS suffix. Sovereign clouds differ — `core.chinacloudapi.cn`,
/// `core.usgovcloudapi.net` — which is why the spec carries it.
const DEFAULT_SUFFIX: &str = "core.windows.net";

/// The audience an Azure Storage token has to be issued for.
const STORAGE_RESOURCE: &str = "https://storage.azure.com";

/// Which of the four services a request is for. Decides the endpoint subdomain and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    Blob,
    File,
    Queue,
    Table,
}

impl Service {
    fn subdomain(self) -> &'static str {
        match self {
            Self::Blob => "blob",
            Self::File => "file",
            Self::Queue => "queue",
            Self::Table => "table",
        }
    }
}

/// The credential a request will carry, resolved.
pub enum Credential {
    /// The decoded account key, ready to sign with.
    Key(Vec<u8>),
    /// The query string of a SAS, without its leading `?`.
    Sas(String),
    /// A bearer token.
    Bearer(String),
}

/// A pasted secret with every space and line break taken out of it.
///
/// **Wrapping is the whole reason this exists.** An account key is base64 and a SAS is a query
/// string; neither can legitimately contain whitespace, and both are routinely copied out of
/// something that wrapped them — a terminal, a README, a chat message, a portal page that hands
/// back a non-breaking space. Trimming is not enough, because the break lands in the *middle* of
/// the value: what comes out is a base64 error that reads as "you copied the wrong thing" to
/// somebody who copied exactly the right thing.
fn unwrapped(secret: &str) -> String {
    secret.chars().filter(|c| !c.is_whitespace()).collect()
}

/// This host's credential, resolved fresh.
///
/// The keychain slot is the same one every other kind's password uses, and it holds whichever of
/// the two pasted secrets this host is configured for — the account key or the SAS. They are never
/// both in play, so a second slot would only be a second thing to keep in step.
pub async fn credential(host_id: &str, spec: &RemoteHostSpec) -> Result<Credential, String> {
    // The one gate every Azure request passes through, wherever it came from — files, queues or
    // tables. Without it a row of the wrong kind reaches the signer and fails with a signature
    // error, which says nothing about the actual mistake.
    if !spec.kind.is_azure() {
        return Err(spec.kind.refuses("reach Azure Storage"));
    }
    let saved = crate::secrets::get_secret(&super::super::password_key(host_id))
        .unwrap_or_default()
        .unwrap_or_default();
    // Here rather than only where it is pasted, because the keychain already holds the secrets
    // pasted before this line existed, and a key that was saved wrapped is a key that would
    // otherwise stay broken until somebody thought to paste it again.
    let saved = unwrapped(&saved);

    match spec.azure.auth {
        AzureAuth::AccountKey => {
            if saved.is_empty() {
                return Err(
                    "This host has no account key saved. Open it and paste one from the storage \
                     account's \"Access keys\" blade, or switch it to a SAS or Entra ID."
                        .into(),
                );
            }
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(&saved)
                .map_err(|_| {
                    "That account key isn't valid base64. Copy it again from the portal — the whole \
                     value, including any trailing `==`."
                        .to_string()
                })?;
            Ok(Credential::Key(decoded))
        }
        AzureAuth::Sas => {
            if saved.is_empty() {
                return Err("This host has no SAS token saved. Open it and paste one.".into());
            }
            // Pasted from the portal it may be a whole URL, or start with `?`. What is wanted is
            // the query string, and taking it apart here means the user does not have to.
            let token = saved.rsplit('?').next().unwrap_or(saved.as_str());
            Ok(Credential::Sas(token.trim_start_matches('?').to_string()))
        }
        AzureAuth::Entra => {
            let token = crate::datasource::entra::cli_token("", STORAGE_RESOURCE).await?;
            Ok(Credential::Bearer(token))
        }
    }
}

/// The default emulator ports, in [`Service`] order. Azurite listens on one port per service — the
/// convention every Azure SDK hard-codes, and the reason a single custom endpoint can still serve
/// all four here.
const EMULATOR_PORTS: [(Service, u16); 4] = [
    (Service::Blob, 10000),
    (Service::Queue, 10001),
    (Service::Table, 10002),
    // Azurite has no file service; 10003 is what the older emulator used and costs nothing to map.
    (Service::File, 10003),
];

/// The base URL for one service on this account.
pub fn endpoint(spec: &RemoteHostSpec, service: Service) -> Result<Url, String> {
    let custom = spec.azure.endpoint.trim();
    if !custom.is_empty() {
        let base = if custom.contains("://") { custom.to_string() } else { format!("https://{custom}") };
        let mut url =
            Url::parse(&base).map_err(|e| format!("\"{custom}\" is not a valid endpoint: {e}"))?;
        // An emulator endpoint names *one* service by its port, and the spec holds one endpoint for
        // all four. Moving the port is what makes a single pasted `UseDevelopmentStorage=true` — or
        // an Azurite blob URL — reach the queues and the tables too. A real custom endpoint (a
        // private endpoint, a custom domain) has no port in this range and is left exactly as typed.
        if let Some(port) = url.port() {
            if EMULATOR_PORTS.iter().any(|(_, known)| *known == port) {
                let wanted = EMULATOR_PORTS
                    .iter()
                    .find(|(named, _)| *named == service)
                    .map(|(_, port)| *port);
                if let Some(wanted) = wanted {
                    url.set_port(Some(wanted))
                        .map_err(|_| format!("\"{custom}\" can't carry a port"))?;
                }
            }
        }
        return Ok(url);
    }

    let account = spec.azure.account.trim();
    if account.is_empty() {
        return Err("This host has no storage account name. Open it and fill one in.".into());
    }
    let suffix = match spec.azure.endpoint_suffix.trim() {
        "" => DEFAULT_SUFFIX,
        named => named,
    };
    Url::parse(&format!("https://{account}.{}.{suffix}", service.subdomain()))
        .map_err(|e| format!("Couldn't build the endpoint for {account}: {e}"))
}

/// The account name a signature is computed against.
///
/// Read from the spec, except when a custom endpoint is in play: Azurite and the emulators put the
/// account in the *first path segment* (`http://127.0.0.1:10000/devstoreaccount1`), and a signature
/// naming the wrong account is rejected with no hint as to why.
pub fn account(spec: &RemoteHostSpec) -> String {
    let named = spec.azure.account.trim();
    if !named.is_empty() {
        return named.to_string();
    }
    // The emulator case the doc comment describes: nothing in the account field, and the account
    // sitting in the endpoint's first path segment. Signing as "" is rejected with no hint as to
    // why, so it is read back out here rather than left to the user to type twice.
    Url::parse(spec.azure.endpoint.trim())
        .ok()
        .and_then(|url| url.path_segments().and_then(|mut parts| parts.next().map(str::to_string)))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Connection strings
// ---------------------------------------------------------------------------

/// The emulator's fixed account, published by Microsoft and identical in every SDK — it is what
/// `UseDevelopmentStorage=true` expands to, not a credential anybody owns.
const EMULATOR_ACCOUNT: &str = "devstoreaccount1";
const EMULATOR_KEY: &str = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const EMULATOR_ENDPOINT: &str = "http://127.0.0.1:10000/devstoreaccount1";

/// What a pasted connection string was understood to mean.
///
/// The secret is deliberately *not* part of it as far as storage is concerned: the caller puts
/// `secret` in the keychain and the rest in the spec, which is the same split every other host kind
/// makes. Keeping them in one struct only says they were read from one line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectionString {
    pub account: String,
    /// The account key, base64 as the portal gives it. Empty when the string carried a SAS instead.
    pub key: String,
    /// A shared access signature's query string, without its `?`. Empty when the string carried a
    /// key instead.
    pub sas: String,
    /// The DNS suffix. Empty means `core.windows.net`.
    pub suffix: String,
    /// A whole endpoint, when the string named one that isn't the account's own — an emulator, a
    /// private endpoint. Empty means "build it from the account".
    pub endpoint: String,
}

/// Reads the one line the portal actually hands out.
///
/// **Three shapes arrive, and all three are this function's job**, because the person pasting has
/// no reason to know which one they were given:
///
/// - `DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…;EndpointSuffix=…` — the "Access
///   keys" blade's connection string.
/// - The same with `SharedAccessSignature=…` and per-service `…Endpoint=` entries instead of an
///   account and a key — what "Shared access signature" produces.
/// - A SAS *URL*: `https://contoso.blob.core.windows.net/photos?sv=…&sig=…`, which is what the
///   context menu on a container copies.
///
/// `UseDevelopmentStorage=true` expands to Azurite's fixed account, since a string that short says
/// nothing else and refusing it would be refusing the one form that needs no thought at all.
///
/// Returns `None` for anything that names neither an account nor an endpoint — the normal state of
/// a field being typed into, not an error.
pub fn parse_connection_string(text: &str) -> Option<ConnectionString> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }

    // A URL rather than a `;`-separated list. Taken first because a SAS URL contains no `=`-keyed
    // segments at all and would otherwise parse as nothing.
    if text.starts_with("http://") || text.starts_with("https://") {
        return parse_sas_url(text);
    }

    let mut parsed = ConnectionString::default();
    let mut endpoints: Vec<(Service, String)> = Vec::new();
    let mut found = false;

    for part in text.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        // The *first* `=` only: an account key is base64 and ends in `=` padding, and splitting on
        // every one of them is the classic way to hand Azure three quarters of a key.
        let Some((name, value)) = part.split_once('=') else { continue };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "usedevelopmentstorage" if value.eq_ignore_ascii_case("true") => {
                parsed.account = EMULATOR_ACCOUNT.to_string();
                parsed.key = EMULATOR_KEY.to_string();
                parsed.endpoint = EMULATOR_ENDPOINT.to_string();
                found = true;
            }
            "accountname" => {
                parsed.account = value.to_string();
                found = true;
            }
            // The two secrets are the two values a wrapped paste destroys silently — see
            // [`unwrapped`]. Everything else on the line either survives a stray space or fails
            // with a message that names the field.
            "accountkey" => {
                parsed.key = unwrapped(value);
                found = true;
            }
            "sharedaccesssignature" => {
                parsed.sas = unwrapped(value.trim_start_matches('?'));
                found = true;
            }
            "endpointsuffix" => parsed.suffix = value.to_string(),
            "blobendpoint" => endpoints.push((Service::Blob, value.to_string())),
            "fileendpoint" => endpoints.push((Service::File, value.to_string())),
            "queueendpoint" => endpoints.push((Service::Queue, value.to_string())),
            "tableendpoint" => endpoints.push((Service::Table, value.to_string())),
            // `DefaultEndpointsProtocol`, and anything a future SDK adds. The scheme is already in
            // every endpoint we build (https) or in the explicit one, so there is nothing to keep.
            _ => {}
        }
    }

    // Only one endpoint fits in a spec, so the blob one wins and the rest are re-derived — see
    // `endpoint`, which moves an emulator port per service. A canonical endpoint is dropped
    // entirely: `https://contoso.blob.core.windows.net` is exactly what the account name already
    // builds, and storing it would pin every service to the blob subdomain.
    if let Some((_, url)) = endpoints
        .iter()
        .find(|(service, _)| *service == Service::Blob)
        .or_else(|| endpoints.first())
    {
        match split_account_host(url) {
            Some((account, suffix)) => {
                if parsed.account.is_empty() {
                    parsed.account = account;
                    found = true;
                }
                if parsed.suffix.is_empty() {
                    parsed.suffix = suffix;
                }
            }
            None => {
                if parsed.endpoint.is_empty() {
                    parsed.endpoint = url.clone();
                }
                found = true;
            }
        }
    }

    if !found || (parsed.account.is_empty() && parsed.endpoint.is_empty()) {
        return None;
    }
    Some(parsed)
}

/// A SAS URL, as the portal's "Copy" button produces it.
fn parse_sas_url(text: &str) -> Option<ConnectionString> {
    let url = Url::parse(text).ok()?;
    let query = url.query().unwrap_or_default();
    // No signature, no credential — a bare service URL says where, never who, and a host built from
    // it would fail at the first request with a 403 instead of here.
    if !query.contains("sig=") {
        return None;
    }
    let host = url.host_str().unwrap_or_default();
    let (account, suffix) = split_host(host)?;
    Some(ConnectionString { account, sas: query.to_string(), suffix, ..Default::default() })
}

/// `https://contoso.blob.core.windows.net` → `("contoso", "core.windows.net")`. `None` for anything
/// that isn't an account's own endpoint — an emulator, an IP, a private endpoint with its own name.
fn split_account_host(url: &str) -> Option<(String, String)> {
    let parsed = Url::parse(url).ok()?;
    // A path means the account is in the path, which is the emulator's shape and not this one.
    if parsed.path().trim_matches('/') != "" {
        return None;
    }
    split_host(parsed.host_str().unwrap_or_default())
}

/// The account and suffix in `contoso.blob.core.windows.net`, if the middle label is a service.
fn split_host(host: &str) -> Option<(String, String)> {
    let (account, rest) = host.split_once('.')?;
    let (service, suffix) = rest.split_once('.')?;
    if !matches!(service, "blob" | "file" | "queue" | "table" | "dfs") {
        return None;
    }
    if account.is_empty() || suffix.is_empty() {
        return None;
    }
    Some((account.to_string(), suffix.to_string()))
}

/// A signed, sendable request.
///
/// The three credentials diverge entirely here, which is why this returns the pieces rather than
/// mutating a builder: a SAS changes the *URL*, Shared Key adds an `Authorization` computed from
/// the URL and the headers, and a bearer token is just a header. Anything that tried to be one code
/// path would be a chain of `if`s over an enum with nothing in common.
pub struct Signed {
    pub url: Url,
    pub headers: Vec<(String, String)>,
}

/// Signs one request.
///
/// `headers` are the ones the caller needs on the wire; everything Azure requires — the date, the
/// version — is added here so no call site can forget one.
pub fn sign(
    spec: &RemoteHostSpec,
    credential: &Credential,
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    content_length: Option<u64>,
) -> Result<Signed, String> {
    let mut url = url.clone();
    let now = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();

    let mut all: Vec<(String, String)> = headers.to_vec();
    all.push(("x-ms-version".to_string(), VERSION.to_string()));

    match credential {
        Credential::Sas(token) => {
            // Merged rather than replaced: a listing already carries `restype`/`comp`, and
            // overwriting the query with the SAS would throw those away.
            let existing: Vec<(String, String)> = url
                .query_pairs()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            let mut merged = url.clone();
            merged.set_query(None);
            {
                let mut query = merged.query_pairs_mut();
                for (key, value) in &existing {
                    query.append_pair(key, value);
                }
                for (key, value) in url::form_urlencoded::parse(token.as_bytes()) {
                    query.append_pair(&key, &value);
                }
            }
            url = merged;
        }
        Credential::Bearer(token) => {
            all.push(("authorization".to_string(), format!("Bearer {token}")));
            all.push(("x-ms-date".to_string(), now.clone()));
        }
        Credential::Key(key) => {
            all.push(("x-ms-date".to_string(), now.clone()));
            let account = account(spec);
            let signature = shared_key(key, &account, method, &url, &all, content_length);
            all.push((
                "authorization".to_string(),
                format!("SharedKey {account}:{signature}"),
            ));
        }
    }

    Ok(Signed { url, headers: all })
}

/// The Shared Key signature for a request.
///
/// The canonical form is fixed by Azure and is unforgiving in three specific ways, each of which
/// produces the same opaque 403:
///
/// - **`Content-Length` is the empty string when it is zero**, not `0`. This changed in version
///   2015-02-21 and is the single most common reason a hand-rolled signer fails.
/// - **Every `x-ms-*` header takes part**, lowercased and sorted, including the ones the caller
///   added for its own reasons. Adding a header after signing therefore breaks the signature.
/// - **The canonical resource is the account plus the *decoded* path**, followed by every query
///   parameter lowercased and sorted, one per line.
fn shared_key(
    key: &[u8],
    account: &str,
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    content_length: Option<u64>,
) -> String {
    let header = |name: &str| -> String {
        headers
            .iter()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    };

    // Zero is the empty string. See the doc comment — this line is the one that bites.
    let length = match content_length {
        Some(0) | None => String::new(),
        Some(bytes) => bytes.to_string(),
    };

    let mut ms: Vec<(String, String)> = headers
        .iter()
        .filter(|(name, _)| name.to_lowercase().starts_with("x-ms-"))
        .map(|(name, value)| (name.to_lowercase(), value.split_whitespace().collect::<Vec<_>>().join(" ")))
        .collect();
    ms.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String =
        ms.iter().map(|(name, value)| format!("{name}:{value}\n")).collect();

    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| (key.to_lowercase(), value.to_string()))
        .collect();
    pairs.sort();
    let canonical_query: String = pairs
        .iter()
        .map(|(key, value)| format!("\n{key}:{value}"))
        .collect();
    let path = percent_encoding::percent_decode_str(url.path()).decode_utf8_lossy();
    let canonical_resource = format!("/{account}{path}{canonical_query}");

    let string_to_sign = format!(
        "{method}\n{}\n{}\n{length}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{canonical_headers}{canonical_resource}",
        header("content-encoding"),
        header("content-language"),
        header("content-md5"),
        header("content-type"),
        // Blank because `x-ms-date` is present and takes precedence — sending both is what the
        // service documents, and it is already in the canonical headers above.
        "",
        header("if-modified-since"),
        header("if-match"),
        header("if-none-match"),
        header("if-unmodified-since"),
        header("range"),
    );

    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .expect("HMAC-SHA256 accepts a key of any length");
    mac.update(string_to_sign.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// The Shared Key signature for a **Table service** request.
///
/// A different canonical form from [`shared_key`], and not a simplification of it — the Table
/// service predates the others and never adopted the long header block:
///
/// ```text
/// VERB \n Content-MD5 \n Content-Type \n Date \n CanonicalizedResource
/// ```
///
/// Two consequences that produce silent 403s if missed. The date line is the **`x-ms-date` value**,
/// not a blank standing in for it as in the blob form. And the canonical resource carries only the
/// `comp` query parameter, if there is one — every other parameter, `$filter` and `$top` included,
/// is left out entirely.
fn shared_key_table(
    key: &[u8],
    account: &str,
    method: &str,
    url: &Url,
    headers: &[(String, String)],
) -> String {
    let header = |name: &str| -> String {
        headers
            .iter()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    };

    let comp = url
        .query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case("comp"))
        .map(|(_, value)| format!("?comp={value}"))
        .unwrap_or_default();
    let path = percent_encoding::percent_decode_str(url.path()).decode_utf8_lossy();
    let string_to_sign = format!(
        "{method}\n{}\n{}\n{}\n/{account}{path}{comp}",
        header("content-md5"),
        header("content-type"),
        header("x-ms-date"),
    );

    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .expect("HMAC-SHA256 accepts a key of any length");
    mac.update(string_to_sign.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// Signs one Table service request.
///
/// Separate from [`sign`] because the canonical form is, and because the Table service also wants
/// `Accept` and `DataServiceVersion` on every call — it speaks OData JSON where its siblings speak
/// XML, and the shape of the answer depends on the `odata=` level asked for.
pub fn sign_table(
    spec: &RemoteHostSpec,
    credential: &Credential,
    method: &str,
    url: &Url,
    headers: &[(String, String)],
) -> Result<Signed, String> {
    let mut url = url.clone();
    let now = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();

    let mut all: Vec<(String, String)> = headers.to_vec();
    all.push(("x-ms-version".to_string(), VERSION.to_string()));
    // `nometadata` because the grid wants values, not type annotations and edit links — it is the
    // difference between a row of data and a row of data wrapped in three times its weight in URLs.
    all.push(("accept".to_string(), "application/json;odata=nometadata".to_string()));
    all.push(("dataserviceversion".to_string(), "3.0;NetFx".to_string()));

    match credential {
        Credential::Sas(token) => {
            let existing: Vec<(String, String)> = url
                .query_pairs()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            let mut merged = url.clone();
            merged.set_query(None);
            {
                let mut query = merged.query_pairs_mut();
                for (key, value) in &existing {
                    query.append_pair(key, value);
                }
                for (key, value) in url::form_urlencoded::parse(token.as_bytes()) {
                    query.append_pair(&key, &value);
                }
            }
            url = merged;
        }
        Credential::Bearer(token) => {
            all.push(("authorization".to_string(), format!("Bearer {token}")));
            all.push(("x-ms-date".to_string(), now));
        }
        Credential::Key(key) => {
            all.push(("x-ms-date".to_string(), now));
            let account = account(spec);
            let signature = shared_key_table(key, &account, method, &url, &all);
            all.push(("authorization".to_string(), format!("SharedKey {account}:{signature}")));
        }
    }

    Ok(Signed { url, headers: all })
}

/// Signs and sends one Table service request.
pub async fn send_table(
    spec: &RemoteHostSpec,
    credential: &Credential,
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response, String> {
    let mut headers = headers.to_vec();
    if body.is_some() {
        headers.push(("content-type".to_string(), "application/json".to_string()));
    }
    let signed = sign_table(spec, credential, method, url, &headers)?;

    let mut request = wire(method, &signed)?;
    if let Some(body) = body {
        request = request.body(body);
    }
    request
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {}: {e}", signed.url.host_str().unwrap_or("Azure")))
}

/// The request exactly as it will leave, headers and all, short of its body.
///
/// **`signed.headers` is the whole set and the only list to walk** — what the caller asked for,
/// plus the version, the date and the authorization the signer added. Sending the caller's list
/// *and* the signed one broke twice over, and neither break says anything in the response:
/// `reqwest::header` appends rather than replaces, so `content-length` went out twice and the
/// request died at the HTTP framing layer with a bodyless 400; and the dedup written to stop that
/// tested a name against both lists, which is true in both passes, so `x-ms-blob-type` was dropped
/// from *every* one — signed into the canonical headers, absent from the wire, which real Azure
/// answers with the same opaque 403 as any other signature failure.
///
/// Split out from [`send`] so a test can look at the result. A header sent twice and a header not
/// sent at all are both invisible from the far side's reply.
fn wire(method: &str, signed: &Signed) -> Result<reqwest::RequestBuilder, String> {
    let mut request = super::http().request(
        reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| format!("'{method}' is not a valid HTTP method"))?,
        signed.url.clone(),
    );
    for (name, value) in signed.headers.iter() {
        request = request.header(name, value);
    }
    Ok(request)
}

/// Signs and sends one request.
pub async fn send(
    spec: &RemoteHostSpec,
    credential: &Credential,
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    body: Option<(reqwest::Body, u64)>,
) -> Result<reqwest::Response, String> {
    let length = body.as_ref().map(|(_, bytes)| *bytes);
    let mut headers = headers.to_vec();
    if let Some(bytes) = length {
        headers.push(("content-length".to_string(), bytes.to_string()));
    }
    let signed = sign(spec, credential, method, url, &headers, length)?;

    let mut request = wire(method, &signed)?;
    if let Some((body, _)) = body {
        request = request.body(body);
    }
    request
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {}: {e}", signed.url.host_str().unwrap_or("Azure")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::RemoteKind;

    fn spec() -> RemoteHostSpec {
        let mut s = RemoteHostSpec { kind: RemoteKind::AzureBlob, ..Default::default() };
        s.azure.account = "contoso".into();
        s
    }

    #[test]
    fn each_service_gets_its_own_subdomain() {
        let s = spec();
        assert_eq!(endpoint(&s, Service::Blob).unwrap().as_str(), "https://contoso.blob.core.windows.net/");
        assert_eq!(endpoint(&s, Service::File).unwrap().as_str(), "https://contoso.file.core.windows.net/");
        assert_eq!(endpoint(&s, Service::Queue).unwrap().as_str(), "https://contoso.queue.core.windows.net/");
        assert_eq!(endpoint(&s, Service::Table).unwrap().as_str(), "https://contoso.table.core.windows.net/");
    }

    #[test]
    fn a_sovereign_cloud_only_changes_the_suffix() {
        let mut s = spec();
        s.azure.endpoint_suffix = "core.chinacloudapi.cn".into();
        assert_eq!(
            endpoint(&s, Service::Blob).unwrap().as_str(),
            "https://contoso.blob.core.chinacloudapi.cn/"
        );
    }

    #[test]
    fn a_custom_endpoint_replaces_the_whole_host() {
        let mut s = spec();
        s.azure.endpoint = "http://127.0.0.1:10000/devstoreaccount1".into();
        assert_eq!(
            endpoint(&s, Service::Blob).unwrap().as_str(),
            "http://127.0.0.1:10000/devstoreaccount1"
        );
    }

    /// The canonical form, asserted end to end against a signature computed by hand from the
    /// documented rules. It pins the three things the doc comment calls out as unforgiving: the
    /// empty `Content-Length`, the sorted `x-ms-*` block, and the query lines on the resource.
    #[test]
    fn shared_key_signs_the_documented_canonical_form() {
        let key = base64::engine::general_purpose::STANDARD.encode(b"secret-key-bytes");
        let decoded = base64::engine::general_purpose::STANDARD.decode(&key).unwrap();
        let url = Url::parse(
            "https://contoso.blob.core.windows.net/photos?restype=container&comp=list&prefix=2024/",
        )
        .unwrap();
        let headers = vec![
            ("x-ms-version".to_string(), VERSION.to_string()),
            ("x-ms-date".to_string(), "Wed, 21 Oct 2015 07:28:00 GMT".to_string()),
        ];

        let expected = {
            let string_to_sign = format!(
                "GET\n\n\n\n\n\n\n\n\n\n\n\n\
                 x-ms-date:Wed, 21 Oct 2015 07:28:00 GMT\nx-ms-version:{VERSION}\n\
                 /contoso/photos\ncomp:list\nprefix:2024/\nrestype:container"
            );
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&decoded).unwrap();
            mac.update(string_to_sign.as_bytes());
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
        };

        assert_eq!(shared_key(&decoded, "contoso", "GET", &url, &headers, None), expected);
    }

    /// Zero has to sign as the empty string, not as "0". Getting this wrong is a 403 with no
    /// explanation, so it gets a test of its own.
    #[test]
    fn a_zero_length_body_signs_as_an_empty_string() {
        let key = b"k".to_vec();
        let url = Url::parse("https://contoso.blob.core.windows.net/c/b").unwrap();
        let headers = vec![("x-ms-date".to_string(), "d".to_string())];
        assert_eq!(
            shared_key(&key, "contoso", "PUT", &url, &headers, Some(0)),
            shared_key(&key, "contoso", "PUT", &url, &headers, None),
        );
        assert_ne!(
            shared_key(&key, "contoso", "PUT", &url, &headers, Some(0)),
            shared_key(&key, "contoso", "PUT", &url, &headers, Some(7)),
        );
    }

    /// The line off the "Access keys" blade, which is what people actually paste.
    #[test]
    fn the_portals_connection_string_becomes_an_account_and_a_key() {
        let parsed = parse_connection_string(
            "DefaultEndpointsProtocol=https;AccountName=contoso;\
             AccountKey=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=;EndpointSuffix=core.windows.net",
        )
        .expect("a full connection string names an account");
        assert_eq!(parsed.account, "contoso");
        // The whole key, padding included: splitting on every `=` is how three quarters of one
        // reaches Azure and comes back a 403.
        assert_eq!(parsed.key, "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=");
        assert_eq!(parsed.suffix, "core.windows.net");
        assert!(parsed.endpoint.is_empty(), "an account's own endpoint is not worth storing");
        assert!(parsed.sas.is_empty());
    }

    /// A SAS string names endpoints instead of an account, and the account is inside them.
    #[test]
    fn a_sas_connection_string_reads_the_account_out_of_its_endpoint() {
        let parsed = parse_connection_string(
            "BlobEndpoint=https://contoso.blob.core.windows.net;\
             QueueEndpoint=https://contoso.queue.core.windows.net;\
             SharedAccessSignature=sv=2021-08-06&ss=b&sig=abc",
        )
        .unwrap();
        assert_eq!(parsed.account, "contoso");
        assert_eq!(parsed.suffix, "core.windows.net");
        assert_eq!(parsed.sas, "sv=2021-08-06&ss=b&sig=abc");
        assert!(parsed.endpoint.is_empty());
    }

    #[test]
    fn a_sas_url_is_a_connection_string_too() {
        let parsed =
            parse_connection_string("https://contoso.blob.core.windows.net/photos?sv=2021-08-06&sig=abc")
                .unwrap();
        assert_eq!(parsed.account, "contoso");
        assert_eq!(parsed.sas, "sv=2021-08-06&sig=abc");
        // A URL with no signature is an address, not a credential.
        assert!(parse_connection_string("https://contoso.blob.core.windows.net/photos").is_none());
    }

    #[test]
    fn the_emulator_shorthand_expands_to_azurite() {
        let parsed = parse_connection_string("UseDevelopmentStorage=true").unwrap();
        assert_eq!(parsed.account, EMULATOR_ACCOUNT);
        assert_eq!(parsed.endpoint, EMULATOR_ENDPOINT);
        assert!(!parsed.key.is_empty());
    }

    /// An explicit emulator string keeps its endpoint, because that one is *not* the account's own.
    #[test]
    fn an_emulator_endpoint_is_kept_and_a_canonical_one_is_not() {
        let parsed = parse_connection_string(
            "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=a2V5;\
             BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;",
        )
        .unwrap();
        assert_eq!(parsed.endpoint, "http://127.0.0.1:10000/devstoreaccount1");
        assert_eq!(parsed.account, "devstoreaccount1");
    }

    /// The shape a connection string arrives in when it was copied out of anything that wraps:
    /// entries on their own lines, and the break landing inside the key itself. Every character of
    /// the key is there — putting it back together is not the user's job.
    #[test]
    fn a_key_that_arrived_wrapped_is_still_one_key() {
        let parsed = parse_connection_string(
            "DefaultEndpointsProtocol=http;\n\
             AccountName=devstoreaccount1;\n\
             AccountKey=YWJjZGVmZ2hpamts\n  bW5vcHFyc3R1dnd4eXo=;\n\
             BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;\n",
        )
        .expect("a wrapped connection string still names an account");
        assert_eq!(parsed.key, "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=");
        assert!(
            base64::engine::general_purpose::STANDARD.decode(&parsed.key).is_ok(),
            "the whole point: what comes out of the parser is what the signer can decode",
        );
        assert_eq!(parsed.account, "devstoreaccount1");
        assert_eq!(parsed.endpoint, "http://127.0.0.1:10000/devstoreaccount1");
    }

    /// A SAS breaks the same way, one step later: whitespace inside the query is not a decode
    /// error, it is a 403 from the far side with nothing in it to work back from.
    #[test]
    fn a_sas_that_arrived_wrapped_is_still_one_token() {
        let parsed = parse_connection_string(
            "BlobEndpoint=https://contoso.blob.core.windows.net;\n\
             SharedAccessSignature=sv=2021-08-06&ss=b&\n  sig=abc",
        )
        .unwrap();
        assert_eq!(parsed.sas, "sv=2021-08-06&ss=b&sig=abc");
    }

    #[test]
    fn a_line_that_names_nothing_is_not_a_connection_string() {
        assert!(parse_connection_string("").is_none());
        assert!(parse_connection_string("ssh deploy@10.0.0.7 -p 2222").is_none());
        assert!(parse_connection_string("DefaultEndpointsProtocol=https").is_none());
    }

    /// One endpoint in the spec, four services on the far side. The emulator is the case where the
    /// port has to move, and the case where getting it wrong means the queues silently 404.
    #[test]
    fn an_emulator_endpoint_moves_its_port_per_service() {
        let mut s = spec();
        s.azure.endpoint = "http://127.0.0.1:10000/devstoreaccount1".into();
        assert_eq!(endpoint(&s, Service::Blob).unwrap().port(), Some(10000));
        assert_eq!(endpoint(&s, Service::Queue).unwrap().port(), Some(10001));
        assert_eq!(endpoint(&s, Service::Table).unwrap().port(), Some(10002));
        // The account stays in the path, which is where the emulator wants it.
        assert_eq!(endpoint(&s, Service::Queue).unwrap().path(), "/devstoreaccount1");
    }

    /// A private endpoint is not an emulator: nothing about it should be rewritten.
    #[test]
    fn a_custom_endpoint_with_no_emulator_port_is_left_alone() {
        let mut s = spec();
        s.azure.endpoint = "https://storage.internal:8443/".into();
        for service in [Service::Blob, Service::Queue, Service::Table, Service::File] {
            assert_eq!(endpoint(&s, service).unwrap().as_str(), "https://storage.internal:8443/");
        }
    }

    /// Signing as the empty account is a 403 with no explanation, so an emulator endpoint's first
    /// path segment stands in for the account field nobody filled.
    #[test]
    fn an_emulator_account_is_read_out_of_its_endpoint() {
        let mut s = spec();
        s.azure.account = String::new();
        s.azure.endpoint = "http://127.0.0.1:10000/devstoreaccount1".into();
        assert_eq!(account(&s), "devstoreaccount1");
    }

    /// The invariant `send` rests on: what comes back from the signer is the *whole* request's
    /// headers, each exactly once.
    ///
    /// Worth pinning down because both ways of getting it wrong are silent and neither looks like a
    /// header bug. A name sent twice is a bodyless 400 from the HTTP layer — `Content-Length`
    /// appearing twice is a framing violation, not an Azure error, so nothing in the response says
    /// what happened. A name signed but not sent is a 403 with the same opaque text every other
    /// signature failure has.
    #[test]
    fn the_signer_returns_every_header_the_request_will_carry_exactly_once() {
        let spec = spec();
        let credential = Credential::Key(b"secret".to_vec());
        let url = Url::parse("https://contoso.blob.core.windows.net/pics/a.png").unwrap();
        // What an upload passes: one `x-ms-` header of its own, plus the length `send` appends.
        let asked = vec![
            ("x-ms-blob-type".to_string(), "BlockBlob".to_string()),
            ("content-length".to_string(), "4".to_string()),
        ];

        let signed = sign(&spec, &credential, "PUT", &url, &asked, Some(4)).unwrap();

        for (name, value) in &asked {
            let seen: Vec<_> = signed.headers.iter().filter(|(n, _)| n == name).collect();
            assert_eq!(seen.len(), 1, "{name} should appear once, found {}", seen.len());
            assert_eq!(&seen[0].1, value);
        }
        for expected in ["x-ms-version", "x-ms-date", "authorization"] {
            let seen = signed.headers.iter().filter(|(n, _)| n == expected).count();
            assert_eq!(seen, 1, "the signer owes exactly one {expected}");
        }
        let mut names: Vec<&str> = signed.headers.iter().map(|(n, _)| n.as_str()).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before, "no header may be listed twice: {names:?}");
    }

    /// The same invariant one step further along — on the built request, which is what the far side
    /// actually receives.
    ///
    /// This is the one that catches the upload bug: the signer was always right, and the request
    /// built from it carried `content-length` twice (a bodyless 400, from the HTTP layer rather
    /// than from Azure) and `x-ms-blob-type` not at all.
    #[test]
    fn an_upload_carries_its_length_once_and_its_blob_type_at_all() {
        let spec = spec();
        let credential = Credential::Key(b"secret".to_vec());
        let url = Url::parse("https://contoso.blob.core.windows.net/pics/a.png").unwrap();
        let asked = vec![
            ("x-ms-blob-type".to_string(), "BlockBlob".to_string()),
            ("content-length".to_string(), "4".to_string()),
        ];
        let signed = sign(&spec, &credential, "PUT", &url, &asked, Some(4)).unwrap();

        let request = wire("PUT", &signed).unwrap().build().unwrap();
        let sent = request.headers();

        assert_eq!(
            sent.get_all("content-length").iter().count(),
            1,
            "two Content-Length headers is a framing violation, and the 400 it earns has no body \
             to explain itself",
        );
        assert_eq!(
            sent.get("x-ms-blob-type").map(|value| value.to_str().unwrap()),
            Some("BlockBlob"),
            "Put Blob requires it, and it was signed — leaving it off the wire is a 403",
        );
        assert!(sent.contains_key("authorization"));
        assert_eq!(sent.get_all("x-ms-date").iter().count(), 1);
    }

    /// A key pasted with its `?`, or as a whole URL, is still a key. The user should not have to
    /// know which part of what the portal gave them we wanted.
    #[test]
    fn a_sas_is_taken_apart_however_it_was_pasted() {
        for pasted in [
            "sv=2021-08-06&sig=abc",
            "?sv=2021-08-06&sig=abc",
            "https://contoso.blob.core.windows.net/?sv=2021-08-06&sig=abc",
        ] {
            let token = pasted.rsplit('?').next().unwrap().trim_start_matches('?');
            assert_eq!(token, "sv=2021-08-06&sig=abc");
        }
    }
}
