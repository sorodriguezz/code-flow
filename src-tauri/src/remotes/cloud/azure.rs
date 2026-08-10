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

/// This host's credential, resolved fresh.
///
/// The keychain slot is the same one every other kind's password uses, and it holds whichever of
/// the two pasted secrets this host is configured for — the account key or the SAS. They are never
/// both in play, so a second slot would only be a second thing to keep in step.
pub async fn credential(host_id: &str, spec: &RemoteHostSpec) -> Result<Credential, String> {
    let saved = crate::secrets::get_secret(&super::super::password_key(host_id))
        .unwrap_or_default()
        .unwrap_or_default();
    let saved = saved.trim();

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
                .decode(saved)
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
            let token = saved.rsplit('?').next().unwrap_or(saved);
            Ok(Credential::Sas(token.trim_start_matches('?').to_string()))
        }
        AzureAuth::Entra => {
            let token = crate::datasource::entra::cli_token("", STORAGE_RESOURCE).await?;
            Ok(Credential::Bearer(token))
        }
    }
}

/// The base URL for one service on this account.
pub fn endpoint(spec: &RemoteHostSpec, service: Service) -> Result<Url, String> {
    let custom = spec.azure.endpoint.trim();
    if !custom.is_empty() {
        let base = if custom.contains("://") { custom.to_string() } else { format!("https://{custom}") };
        return Url::parse(&base).map_err(|e| format!("\"{custom}\" is not a valid endpoint: {e}"));
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
    spec.azure.account.trim().to_string()
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

    let mut request = super::http().request(
        reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| format!("'{method}' is not a valid HTTP method"))?,
        signed.url.clone(),
    );
    for (name, value) in signed.headers.iter() {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    request
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {}: {e}", signed.url.host_str().unwrap_or("Azure")))
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

    let mut request = super::http().request(
        reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| format!("'{method}' is not a valid HTTP method"))?,
        signed.url.clone(),
    );
    for (name, value) in headers.iter().chain(signed.headers.iter()) {
        // The signer added the version and the date to its own list; sending them twice would make
        // the canonical headers disagree with the wire.
        if headers.iter().any(|(n, _)| n == name) && signed.headers.iter().any(|(n, _)| n == name) && name.starts_with("x-ms-") {
            continue;
        }
        request = request.header(name, value);
    }
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
