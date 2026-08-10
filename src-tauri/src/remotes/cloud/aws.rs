//! Credentials for an S3 host, and the signed request that carries them.
//!
//! **Two ways in, and the default is the one that isn't a credential at all.**
//!
//! - [`S3Auth::Profile`] shells out to **`aws configure export-credentials`**, which hands back
//!   whatever the named profile currently resolves to. That is the whole point: a profile may be a
//!   static key pair, an SSO session, an assumed role, an IMDS identity or a `credential_process`
//!   of the user's own, and every one of those has already been negotiated in Amazon's own tooling
//!   by the time this runs. CodeFlow stores nothing, expires nothing, and refreshes nothing — the
//!   CLI does, and a session that has lapsed says `aws sso login` in words the user recognises.
//! - [`S3Auth::AccessKey`] reads an access key ID from the spec and its secret from the OS
//!   keychain. For a MinIO box, a machine account, or anyone without the CLI.
//!
//! There is deliberately no third path that reads `~/.aws/credentials` itself. Parsing that file is
//! easy and wrong: the interesting profiles are the ones whose credentials are *not* in it, and a
//! reader that handled only the easy case would silently sign with a stale key for exactly the
//! users whose organisation moved to SSO.
//!
//! **Signing** is [`crate::sigv4`], shared with the API client — see that module for why there is
//! only one copy.

use serde::Deserialize;
use url::Url;

use super::super::{RemoteHostSpec, S3Auth};
use crate::proc::command;
use crate::sigv4::{hex_sha256, sigv4_headers};

/// What S3 assumes when a request arrives with no region routing, and therefore what an
/// unconfigured host has to sign as for the redirect to be accepted.
const DEFAULT_REGION: &str = "us-east-1";

/// The payload hash that says "this body is not signed".
///
/// S3 accepts it over HTTPS, and it is what makes streaming an upload possible: SigV4 otherwise
/// needs the SHA-256 of the whole body *before* the first byte goes out, which for a file means
/// reading it twice. TLS is already protecting the body in transit; the signature still covers the
/// method, path, query and headers, so nothing about *which* object is being written is forgeable.
const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

/// A resolved credential, whatever produced it.
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Empty for a long-lived key pair. Present — and required — for anything temporary.
    pub session_token: String,
}

/// The credentials this host signs with, resolved fresh.
///
/// Not cached, for the same reason [`crate::datasource::entra`] doesn't cache its token: the whole
/// value of the profile path is that the CLI owns expiry, and a cache here would be a second,
/// dumber expiry policy layered on top of a correct one.
pub async fn credentials(host_id: &str, spec: &RemoteHostSpec) -> Result<Credentials, String> {
    // The same keychain entry every other kind's password uses, keyed by host id — a row that
    // changes kind keeps the credential already saved against it.
    let secret = crate::secrets::get_secret(&super::super::password_key(host_id))
        .unwrap_or_default()
        .unwrap_or_default();
    match spec.s3.auth {
        S3Auth::AccessKey => {
            let id = spec.s3.access_key_id.trim();
            if id.is_empty() {
                return Err("This host has no access key ID. Open it and fill one in.".into());
            }
            if secret.trim().is_empty() {
                return Err(
                    "This host has no secret access key saved. Open it and paste one, or switch it \
                     to an AWS profile."
                        .into(),
                );
            }
            Ok(Credentials {
                access_key_id: id.to_string(),
                secret_access_key: secret.trim().to_string(),
                session_token: String::new(),
            })
        }
        S3Auth::Profile => from_cli(spec.s3.profile.trim()).await,
    }
}

/// What `aws configure export-credentials` says the profile currently is.
async fn from_cli(profile: &str) -> Result<Credentials, String> {
    let mut cmd = command(aws_cli());
    cmd.args(["configure", "export-credentials", "--format", "process"]);
    if !profile.is_empty() {
        cmd.args(["--profile", profile]);
    }
    let output = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "The AWS CLI (`aws`) isn't installed, or isn't on this app's PATH. Install it and run \
             `aws configure`, or switch this host to an access key."
                .to_string()
        } else {
            format!("Couldn't run the AWS CLI: {e}")
        }
    })?;

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let lowered = message.to_lowercase();
        // The three failures worth naming, because each has a command the user can run rather than
        // a setting to change in this dialog.
        if lowered.contains("sso session") || lowered.contains("sso login") || lowered.contains("token has expired") {
            let which = if profile.is_empty() { String::new() } else { format!(" --profile {profile}") };
            return Err(format!(
                "This profile's SSO session has expired. Run `aws sso login{which}` and try \
                 again.\n\n{message}"
            ));
        }
        if lowered.contains("could not be found") || lowered.contains("does not exist") {
            return Err(format!(
                "The AWS CLI has no profile called \"{}\". `aws configure list-profiles` shows the \
                 ones it does have.\n\n{message}",
                if profile.is_empty() { "default" } else { profile }
            ));
        }
        return Err(if message.is_empty() {
            "`aws configure export-credentials` failed without saying why.".to_string()
        } else {
            message
        });
    }

    // The `process` format is the credential-process contract: a JSON object on stdout, with the
    // CLI's own warnings kept on stderr.
    #[derive(Deserialize)]
    struct Exported {
        #[serde(rename = "AccessKeyId")]
        access_key_id: String,
        #[serde(rename = "SecretAccessKey")]
        secret_access_key: String,
        #[serde(rename = "SessionToken", default)]
        session_token: String,
    }
    let parsed: Exported = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("The AWS CLI's answer wasn't the JSON we expected: {e}"))?;
    if parsed.access_key_id.is_empty() {
        return Err("The AWS CLI returned an empty credential.".into());
    }
    Ok(Credentials {
        access_key_id: parsed.access_key_id,
        secret_access_key: parsed.secret_access_key,
        session_token: parsed.session_token,
    })
}

/// `aws` on Unix; `aws.exe` on Windows, where the installer puts a real executable on PATH.
fn aws_cli() -> &'static str {
    if cfg!(windows) {
        "aws.exe"
    } else {
        "aws"
    }
}

/// The region this host signs for.
pub fn region(spec: &RemoteHostSpec) -> String {
    let named = spec.s3.region.trim();
    if named.is_empty() {
        DEFAULT_REGION.to_string()
    } else {
        named.to_string()
    }
}

/// The URL for a container and key on this host.
///
/// Two addressing styles, and which one is used is not entirely the user's choice. Virtual-host
/// style (`bucket.s3.region.amazonaws.com/key`) is what AWS prefers and the only style its newer
/// regions accept; path style (`endpoint/bucket/key`) is the only one that can work against a
/// custom endpoint, because there is no wildcard DNS record in front of a MinIO container or a
/// forwarded port. So a custom endpoint forces path style regardless of the toggle.
pub fn url(spec: &RemoteHostSpec, container: &str, key: &str) -> Result<Url, String> {
    let custom = spec.s3.endpoint.trim();
    let region = region(spec);

    let mut url = if custom.is_empty() {
        let host = if region == DEFAULT_REGION {
            "s3.amazonaws.com".to_string()
        } else {
            format!("s3.{region}.amazonaws.com")
        };
        if spec.s3.path_style || container.is_empty() {
            Url::parse(&format!("https://{host}"))
        } else {
            Url::parse(&format!("https://{container}.{host}"))
        }
        .map_err(|e| format!("Couldn't build the S3 endpoint: {e}"))?
    } else {
        let base = if custom.contains("://") { custom.to_string() } else { format!("https://{custom}") };
        Url::parse(&base).map_err(|e| format!("\"{custom}\" is not a valid endpoint: {e}"))?
    };

    // Whether the bucket is still to be added depends on which style the branch above chose.
    let in_path = !custom.is_empty() || spec.s3.path_style || container.is_empty();
    let shown = url.to_string();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| format!("\"{shown}\" cannot carry a path"))?;
        // `Url` keeps the empty segment a base like `https://host/` ends with, and appending to it
        // would produce `//bucket`.
        segments.pop_if_empty();
        if in_path && !container.is_empty() {
            segments.push(container);
        }
        for part in key.split('/').filter(|part| !part.is_empty()) {
            segments.push(part);
        }
        // A key ending in `/` is a folder marker, and the trailing separator is part of its name.
        if key.ends_with('/') {
            segments.push("");
        }
    }
    Ok(url)
}

/// What a request's body is, from the signer's point of view.
pub enum Body {
    /// No body at all — every listing, delete and copy.
    Empty,
    /// Bytes held in memory, signed properly. The folder marker, and nothing else so far.
    Bytes(Vec<u8>),
    /// A body that will be streamed, signed as [`UNSIGNED_PAYLOAD`].
    Streamed(reqwest::Body),
}

/// Signs and sends one request.
///
/// The signature covers the URL *as it will be sent*, which is why the query is built into `url` by
/// the caller rather than added afterwards by reqwest: SigV4 signs the canonical query string, and
/// a parameter appended after signing invalidates it.
pub async fn send(
    spec: &RemoteHostSpec,
    creds: &Credentials,
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    body: Body,
) -> Result<reqwest::Response, String> {
    let (payload_hash, body) = match body {
        Body::Empty => (hex_sha256(b""), None),
        Body::Bytes(bytes) => (hex_sha256(&bytes), Some(reqwest::Body::from(bytes))),
        Body::Streamed(stream) => (UNSIGNED_PAYLOAD.to_string(), Some(stream)),
    };

    let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let signed = sigv4_headers(
        method,
        url,
        headers,
        &payload_hash,
        &creds.access_key_id,
        &creds.secret_access_key,
        &creds.session_token,
        &region(spec),
        "s3",
        &amz_date,
    )?;

    let mut request = super::http()
        .request(
            reqwest::Method::from_bytes(method.as_bytes())
                .map_err(|_| format!("'{method}' is not a valid HTTP method"))?,
            url.clone(),
        );
    for (name, value) in headers.iter().chain(signed.iter()) {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    request.send().await.map_err(|e| format!("Couldn't reach {}: {e}", url.host_str().unwrap_or("S3")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::RemoteKind;

    fn spec() -> RemoteHostSpec {
        RemoteHostSpec { kind: RemoteKind::S3, ..Default::default() }
    }

    #[test]
    fn an_aws_bucket_is_addressed_by_virtual_host_and_region() {
        let mut s = spec();
        s.s3.region = "eu-west-1".into();
        assert_eq!(
            url(&s, "photos", "2024/cat.jpg").unwrap().as_str(),
            "https://photos.s3.eu-west-1.amazonaws.com/2024/cat.jpg"
        );
    }

    /// The one region whose endpoint has no region in it, and the region an unset host signs as.
    #[test]
    fn an_unset_region_is_us_east_1_and_its_endpoint_is_the_bare_one() {
        let s = spec();
        assert_eq!(region(&s), "us-east-1");
        assert_eq!(url(&s, "photos", "").unwrap().as_str(), "https://photos.s3.amazonaws.com/");
    }

    /// Listing the account's buckets is a request to the endpoint itself, with no bucket anywhere.
    #[test]
    fn the_account_root_addresses_the_endpoint_with_no_bucket() {
        assert_eq!(url(&spec(), "", "").unwrap().as_str(), "https://s3.amazonaws.com/");
    }

    /// A MinIO box has no wildcard DNS, so the bucket has to be in the path whatever the toggle
    /// says.
    #[test]
    fn a_custom_endpoint_always_puts_the_bucket_in_the_path() {
        let mut s = spec();
        s.s3.endpoint = "http://localhost:9000".into();
        assert_eq!(
            url(&s, "photos", "2024/cat.jpg").unwrap().as_str(),
            "http://localhost:9000/photos/2024/cat.jpg"
        );
        // And a bare host is assumed to be https, the way every other address field in this app is.
        s.s3.endpoint = "minio.internal".into();
        assert_eq!(url(&s, "b", "k").unwrap().as_str(), "https://minio.internal/b/k");
    }

    #[test]
    fn path_style_moves_the_bucket_into_the_path_on_aws_too() {
        let mut s = spec();
        s.s3.path_style = true;
        assert_eq!(url(&s, "photos", "cat.jpg").unwrap().as_str(), "https://s3.amazonaws.com/photos/cat.jpg");
    }

    /// A folder marker's name ends in a slash, and the URL has to keep it — dropping it would
    /// address the prefix's parent object instead.
    #[test]
    fn a_folder_marker_keeps_its_trailing_slash() {
        assert_eq!(
            url(&spec(), "b", "photos/2024/").unwrap().as_str(),
            "https://b.s3.amazonaws.com/photos/2024/"
        );
    }

    /// Spaces and other awkward characters are the browser's business, not the caller's: the URL
    /// type encodes them, and SigV4 signs the encoded form.
    #[test]
    fn key_segments_are_encoded_rather_than_pasted() {
        assert_eq!(
            url(&spec(), "b", "my folder/a+b.txt").unwrap().as_str(),
            "https://b.s3.amazonaws.com/my%20folder/a+b.txt"
        );
    }
}
