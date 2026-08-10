//! AWS Signature Version 4, the whole algorithm and nothing else.
//!
//! Extracted from the API client, which was the first caller and is no longer the only one: the
//! Remote workspace speaks S3 ([`crate::remotes::cloud::s3`]) and every request it makes is signed
//! the same way. Two copies of a signing algorithm is two things to keep in step with a
//! specification neither of them owns — and a signature that is subtly wrong fails as `403
//! SignatureDoesNotMatch`, which says nothing about *which* of the dozen canonical-form rules was
//! broken. So there is one, and it is the one AWS's own published vectors are asserted against
//! (see the tests).
//!
//! The entry point is [`sigv4_headers`]: hand it a request and credentials, get back the headers to
//! add. [`sigv4_sign`] underneath it is the pure algorithm, taking strings and returning a
//! signature, which is what makes the vectors testable without a socket.

use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};
use url::Url;

const SIGV4_ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// The only characters SigV4 leaves literal. Everything else is percent-encoded uppercase, and
/// notably `/` is *not* exempt here — the canonical path adds it back deliberately.
const SIGV4_UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

const SIGV4_PATH: &AsciiSet = &SIGV4_UNRESERVED.remove(b'/');

pub(crate) fn hex_sha256(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub(crate) fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .expect("HMAC-SHA256 accepts a key of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Everything SigV4 signs, already reduced to strings. Kept separate from the request builder so
/// the algorithm can be tested against AWS's published vectors without a socket.
pub(crate) struct SigV4Request<'a> {
    pub method: &'a str,
    pub canonical_uri: &'a str,
    pub canonical_query: &'a str,
    /// Lowercased names, normalized values, any order.
    pub headers: &'a [(String, String)],
    pub payload_hash: &'a str,
}

/// The access key is absent on purpose: it names the credential in the `Authorization` header but
/// never takes part in the signature, so keeping it out means it cannot drift into the maths.
pub(crate) struct SigV4Credentials<'a> {
    pub secret_key: &'a str,
    pub region: &'a str,
    pub service: &'a str,
}

/// Returns `(signed_headers, signature)` for `amz_date` in `YYYYMMDDTHHMMSSZ` form.
pub(crate) fn sigv4_sign(
    request: &SigV4Request,
    credentials: &SigV4Credentials,
    amz_date: &str,
) -> (String, String) {
    let mut merged: Vec<(String, String)> = Vec::new();
    for (name, value) in request.headers {
        let normalized = normalize_header_value(value);
        match merged.iter_mut().find(|(existing, _)| existing == name) {
            // Repeated headers are signed as one comma-joined value, in the order sent.
            Some((_, existing)) => {
                existing.push(',');
                existing.push_str(&normalized);
            }
            None => merged.push((name.clone(), normalized)),
        }
    }
    merged.sort_by(|a, b| a.0.cmp(&b.0));

    let canonical_headers: String = merged
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let signed_headers = merged
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");

    let canonical_request = format!(
        "{}\n{}\n{}\n{canonical_headers}\n{signed_headers}\n{}",
        request.method, request.canonical_uri, request.canonical_query, request.payload_hash
    );

    let date = &amz_date[..8];
    let scope = format!(
        "{date}/{}/{}/aws4_request",
        credentials.region, credentials.service
    );
    let string_to_sign = format!(
        "{SIGV4_ALGORITHM}\n{amz_date}\n{scope}\n{}",
        hex_sha256(canonical_request.as_bytes())
    );

    let key = hmac_sha256(
        format!("AWS4{}", credentials.secret_key).as_bytes(),
        date.as_bytes(),
    );
    let key = hmac_sha256(&key, credentials.region.as_bytes());
    let key = hmac_sha256(&key, credentials.service.as_bytes());
    let key = hmac_sha256(&key, b"aws4_request");

    (
        signed_headers,
        hex::encode(hmac_sha256(&key, string_to_sign.as_bytes())),
    )
}

fn normalize_header_value(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Headers the transport rewrites or adds after signing would be pointless — or actively harmful —
/// to sign, so they are excluded the way the AWS SDKs exclude them.
fn is_unsignable(name: &str) -> bool {
    matches!(
        name,
        "accept-encoding"
            | "authorization"
            | "connection"
            | "content-length"
            | "expect"
            | "keep-alive"
            | "proxy-authorization"
            | "te"
            | "transfer-encoding"
            | "user-agent"
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sigv4_headers(
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    payload_hash: &str,
    access_key: &str,
    secret_key: &str,
    session_token: &str,
    region: &str,
    service: &str,
    amz_date: &str,
) -> Result<Vec<(String, String)>, String> {
    if access_key.is_empty() || secret_key.is_empty() {
        return Err("AWS SigV4 needs both an access key and a secret key".to_string());
    }
    if region.is_empty() || service.is_empty() {
        return Err("AWS SigV4 needs both a region and a service name".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| format!("{url} has no host to sign"))?;
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };

    let mut extra = vec![
        ("x-amz-date".to_string(), amz_date.to_string()),
        ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
    ];
    if !session_token.is_empty() {
        extra.push(("x-amz-security-token".to_string(), session_token.to_string()));
    }

    let mut to_sign: Vec<(String, String)> = vec![("host".to_string(), authority)];
    to_sign.extend(
        headers
            .iter()
            .filter(|(name, _)| !is_unsignable(name))
            .cloned(),
    );
    to_sign.extend(extra.iter().cloned());

    let (signed_headers, signature) = sigv4_sign(
        &SigV4Request {
            method,
            canonical_uri: &canonical_uri(url, service),
            canonical_query: &canonical_query(url),
            headers: &to_sign,
            payload_hash,
        },
        &SigV4Credentials {
            secret_key,
            region,
            service,
        },
        amz_date,
    );

    let credential = format!(
        "{access_key}/{}/{region}/{service}/aws4_request",
        &amz_date[..8]
    );
    extra.push((
        "authorization".to_string(),
        format!(
            "{SIGV4_ALGORITHM} Credential={credential}, SignedHeaders={signed_headers}, \
             Signature={signature}"
        ),
    ));
    Ok(extra)
}

/// S3 signs the path exactly as it appears on the wire; every other service signs it
/// percent-encoded a second time. `Url::path()` is already encoded once, so re-encoding it here
/// (which turns `%` into `%25`) is that second pass.
fn canonical_uri(url: &Url, service: &str) -> String {
    let path = url.path();
    let path = if path.is_empty() { "/" } else { path };
    if service.eq_ignore_ascii_case("s3") {
        path.to_string()
    } else {
        utf8_percent_encode(path, SIGV4_PATH).to_string()
    }
}

fn canonical_query(url: &Url) -> String {
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| {
            (
                utf8_percent_encode(&key, SIGV4_UNRESERVED).to_string(),
                utf8_percent_encode(&value, SIGV4_UNRESERVED).to_string(),
            )
        })
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// `get-vanilla` from AWS's published aws-sig-v4-test-suite. It signs exactly `host` and
    /// `x-amz-date`, so it exercises the algorithm against a value AWS itself publishes rather
    /// than one this client happens to produce.
    #[test]
    fn sigv4_signature_matches_the_get_vanilla_vector() {
        let (signed_headers, signature) = sigv4_sign(
            &SigV4Request {
                method: "GET",
                canonical_uri: "/",
                canonical_query: "",
                headers: &[
                    ("host".to_string(), "example.amazonaws.com".to_string()),
                    ("x-amz-date".to_string(), "20150830T123600Z".to_string()),
                ],
                payload_hash: &hex_sha256(b""),
            },
            &SigV4Credentials {
                secret_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                region: "us-east-1",
                service: "service",
            },
            "20150830T123600Z",
        );

        assert_eq!(signed_headers, "host;x-amz-date");
        assert_eq!(
            signature,
            "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    /// The wiring around the algorithm: which headers this client decides to sign, and the shape
    /// of the credential scope. The signature is not an AWS-published number — it is the same
    /// vector's credentials re-derived with `x-amz-content-sha256` in the signed set, cross-checked
    /// against an independent implementation.
    #[test]
    fn sigv4_headers_sign_host_date_and_payload_hash() {
        let url = Url::parse("https://example.amazonaws.com/").unwrap();
        let signed = sigv4_headers(
            "GET",
            &url,
            // `accept-encoding` is rewritten by the transport after signing, so it must not appear
            // in SignedHeaders.
            &[("accept-encoding".to_string(), "identity".to_string())],
            &hex_sha256(b""),
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "",
            "us-east-1",
            "service",
            "20150830T123600Z",
        )
        .unwrap();

        let value = |name: &str| {
            signed
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap_or_default()
        };

        assert_eq!(value("x-amz-date"), "20150830T123600Z");
        assert_eq!(value("x-amz-content-sha256"), hex_sha256(b""));
        assert!(!signed.iter().any(|(key, _)| key == "x-amz-security-token"));
        assert_eq!(
            value("authorization"),
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-content-sha256;x-amz-date, \
             Signature=726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642"
        );
    }

    #[test]
    fn canonical_query_sorts_and_encodes() {
        let url = Url::parse("https://example.com/x?b=2&a=1&c=hello world&a=0").unwrap();
        assert_eq!(canonical_query(&url), "a=0&a=1&b=2&c=hello%20world");
    }
}
