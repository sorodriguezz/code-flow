//! HTTP (and therefore GraphQL — it is a POST with a JSON body) transport.
//!
//! Every send builds its own [`reqwest::Client`]: TLS verification, the client certificate, the
//! proxy and the redirect policy are all *builder*-level knobs in reqwest, so a request that
//! disables SSL verification cannot share a client with one that doesn't. Building a client is
//! cheap next to a round trip, and it keeps one request from leaking its transport settings into
//! the next.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use bytes::Bytes;
use chrono::{DateTime, Duration as ChronoDuration, NaiveDateTime, TimeZone, Utc};
use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, CONTENT_LENGTH, HOST, LOCATION,
    SET_COOKIE, WWW_AUTHENTICATE,
};
use reqwest::{redirect, Method};
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncReadExt as _;
use tokio::sync::oneshot;
use url::Url;

use crate::api::{
    BackendAuth, FormPart, HttpResponse, HttpSendRequest, NetworkOptions, ParsedCookie,
    ResponseTimings, SentRequestSummary,
};

/// How much of the request body the console shows. Big enough for a readable JSON payload,
/// small enough that a 200 MB upload doesn't get copied into the response.
const BODY_PREVIEW_LIMIT: usize = 2048;

const FILE_CHUNK_BYTES: usize = 64 * 1024;

/// Content encodings this build of reqwest negotiates, in the order it advertises them. It is
/// inserted by a layer that runs below the `Request` we can inspect, so the console has to
/// reconstruct it rather than read it.
const ADVERTISED_ENCODINGS: &str = "gzip, br, deflate";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn send(
    req: HttpSendRequest,
    cancel: Option<oneshot::Receiver<()>>,
) -> Result<HttpResponse, String> {
    let Some(mut cancel) = cancel else {
        return send_inner(req).await;
    };

    let fut = send_inner(req);
    tokio::pin!(fut);
    let cancelled = tokio::select! {
        result = &mut fut => return result,
        signalled = &mut cancel => signalled.is_ok(),
    };

    if cancelled {
        Err("Request cancelled".to_string())
    } else {
        // The sender was dropped without firing. Nothing can cancel us any more, so finishing is
        // strictly better than reporting a cancellation nobody asked for.
        fut.await
    }
}

async fn send_inner(req: HttpSendRequest) -> Result<HttpResponse, String> {
    let total_started = Instant::now();

    let method = Method::from_bytes(req.method.trim().as_bytes())
        .map_err(|_| format!("'{}' is not a valid HTTP method", req.method))?;
    let start_url = Url::parse(&req.url)
        .map_err(|e| format!("'{}' is not a valid URL: {e}", req.url))?;
    if !matches!(start_url.scheme(), "http" | "https") {
        return Err(format!(
            "{} uses the '{}' scheme; only http and https can be sent here",
            start_url,
            start_url.scheme()
        ));
    }

    let hops: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let client = build_client(&req.options, &hops)?;

    let mut attempt = run_exchange(&client, &req, &method, &start_url, &[], &hops).await?;

    // Digest is a challenge/response scheme: the first send exists only to collect the nonce, and
    // the body has to go out again with the second one (there is no 100-continue dance here).
    if let Some(BackendAuth::Digest { username, password }) = &req.auth {
        if attempt.response.status() == reqwest::StatusCode::UNAUTHORIZED {
            let challenge = digest_challenge(attempt.response.headers()).ok_or_else(|| {
                format!(
                    "{method} {start_url} returned 401 but no 'WWW-Authenticate: Digest' \
                     challenge, so the digest handshake cannot continue"
                )
            })?;
            // Re-challenge against wherever the first attempt actually landed: the nonce and the
            // signed request-target belong to that URL, not to the one originally typed.
            let target = attempt.response.url().clone();
            let header =
                digest_authorization(username, password, method.as_str(), &target, &challenge)?;
            attempt = run_exchange(
                &client,
                &req,
                &method,
                &target,
                &[("authorization".to_string(), header)],
                &hops,
            )
            .await?;
        }
    }

    let Exchange {
        response,
        sent,
        first_byte_ms,
    } = attempt;

    let status = response.status();
    let http_version = format!("{:?}", response.version());
    let final_url = response.url().clone();
    let headers = header_pairs(response.headers());
    let set_cookies = parse_set_cookies(response.headers(), &final_url);

    let download_started = Instant::now();
    let body = read_body(response, req.options.max_response_bytes, &final_url).await?;
    let download_ms = download_started.elapsed().as_millis() as i64;
    let size_bytes = body.len() as u64;

    let (body_text, body_base64) = decode_body(body, response_content_type(&headers).as_deref());

    let mut redirects = hops.lock().map(|h| h.clone()).unwrap_or_default();
    // The contract is "every hop, final URL last" — reqwest's own follower records the *targets*
    // it moved to, which already ends at the final URL, but a manual hop can leave it one short.
    if !redirects.is_empty() && redirects.last().map(String::as_str) != Some(final_url.as_str()) {
        redirects.push(final_url.to_string());
    }

    let total_ms = total_started.elapsed().as_millis() as i64;

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        http_version,
        headers,
        body_text,
        body_base64,
        size_bytes,
        duration_ms: total_ms,
        timings: ResponseTimings {
            // reqwest hands back a `Response`, not a connection trace: the DNS lookup, the TCP
            // handshake and the TLS handshake all happen inside `execute` with no hook to time
            // them separately. -1 is the contract's "unavailable", and inventing a split of
            // `first_byte_ms` would be worse than admitting that.
            dns_ms: -1,
            connect_ms: -1,
            tls_ms: -1,
            first_byte_ms,
            download_ms,
            total_ms,
        },
        redirects,
        set_cookies,
        sent,
    })
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

fn build_client(
    options: &NetworkOptions,
    hops: &Arc<Mutex<Vec<String>>>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(!options.verify_ssl)
        .redirect(redirect_policy(options, hops));

    if options.timeout_ms > 0 {
        builder = builder.timeout(Duration::from_millis(options.timeout_ms));
    }

    if !options.proxy_url.trim().is_empty() {
        let proxy = reqwest::Proxy::all(options.proxy_url.trim())
            .map_err(|e| format!("Proxy '{}' is not usable: {e}", options.proxy_url))?;
        builder = builder.proxy(proxy);
    }

    if !options.ca_cert_path.trim().is_empty() {
        let path = options.ca_cert_path.trim();
        let pem = std::fs::read(path)
            .map_err(|e| format!("Cannot read the CA bundle at '{path}': {e}"))?;
        let certs = reqwest::Certificate::from_pem_bundle(&pem)
            .map_err(|e| format!("'{path}' is not a valid PEM CA bundle: {e}"))?;
        for cert in certs {
            builder = builder.add_root_certificate(cert);
        }
    }

    if !options.client_cert_path.trim().is_empty() {
        builder = builder.identity(client_identity(
            options.client_cert_path.trim(),
            &options.client_cert_password,
        )?);
    }

    builder
        .build()
        .map_err(|e| format!("Could not build the HTTP client: {e}"))
}

/// The TLS backend is rustls, which only accepts a PEM identity — an encrypted key or a PKCS#12
/// container has to be converted first, and saying so beats a handshake failure with no cause.
fn client_identity(path: &str, password: &str) -> Result<reqwest::Identity, String> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".p12") || lower.ends_with(".pfx") {
        return Err(format!(
            "Client certificate '{path}' is a PKCS#12 container. This build uses rustls, which \
             needs an unencrypted PEM bundle (certificate chain + private key in one file). \
             Convert it with: openssl pkcs12 -in '{path}' -out client.pem -nodes"
        ));
    }
    // Refusing beats accepting the passphrase and quietly not using it: rustls cannot decrypt a
    // private key, so a cert that needs one would fail the handshake with no explanation.
    if !password.is_empty() {
        return Err(format!(
            "A passphrase was set for client certificate '{path}', but rustls cannot decrypt a \
             private key. Decrypt it first with: openssl pkcs8 -topk8 -nocrypt -in key.pem \
             -out key-decrypted.pem"
        ));
    }
    let pem = std::fs::read(path)
        .map_err(|e| format!("Cannot read the client certificate at '{path}': {e}"))?;
    reqwest::Identity::from_pem(&pem).map_err(|e| {
        format!(
            "'{path}' is not a usable PEM client identity: {e}. It must hold the certificate \
             chain and an unencrypted PKCS#8 or PKCS#1 private key."
        )
    })
}

fn redirect_policy(options: &NetworkOptions, hops: &Arc<Mutex<Vec<String>>>) -> redirect::Policy {
    if !options.follow_redirects {
        return redirect::Policy::none();
    }

    let hops = Arc::clone(hops);
    let max = options.max_redirects;
    let keep_auth = options.keep_auth_on_redirect;

    redirect::Policy::custom(move |attempt| {
        // `previous` starts with the original URL, so its length is the number of hops already
        // taken — the same accounting `Policy::limited` uses.
        if attempt.previous().len() > max {
            return attempt.error(format!("more than {max} redirects"));
        }

        // reqwest strips Authorization/Cookie/Proxy-Authorization on every cross-host hop and
        // offers no way to opt out, which is exactly right when `keep_auth_on_redirect` is off.
        // When it is on, we hand the 3xx back to `exchange` and re-issue the request ourselves
        // with the credentials still attached.
        if keep_auth {
            let crosses_host = attempt
                .previous()
                .last()
                .is_some_and(|prev| !same_origin(prev, attempt.url()));
            if crosses_host {
                return attempt.stop();
            }
        }

        if let Ok(mut hops) = hops.lock() {
            hops.push(attempt.url().to_string());
        }
        attempt.follow()
    })
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

// ---------------------------------------------------------------------------
// One request/response exchange
// ---------------------------------------------------------------------------

struct Exchange {
    response: reqwest::Response,
    /// The *first* request of the exchange — what the user actually asked to send.
    sent: SentRequestSummary,
    first_byte_ms: i64,
}

/// Sends `req` and follows whatever redirects reqwest handed back to us (see [`redirect_policy`]).
async fn run_exchange(
    client: &reqwest::Client,
    req: &HttpSendRequest,
    method: &Method,
    url: &Url,
    extra_headers: &[(String, String)],
    hops: &Arc<Mutex<Vec<String>>>,
) -> Result<Exchange, String> {
    let mut method = method.clone();
    let mut url = url.clone();
    let mut with_body = true;
    let mut sent: Option<SentRequestSummary> = None;

    loop {
        let built = build_request(client, req, &method, &url, extra_headers, with_body).await?;
        let summary = built.summary;
        if sent.is_none() {
            sent = Some(summary);
        }

        let started = Instant::now();
        let response = client
            .execute(built.request)
            .await
            .map_err(|e| transport_error(&method, &url, &e))?;
        let first_byte_ms = started.elapsed().as_millis() as i64;

        let Some(next) = manual_redirect_target(&req.options, &response, &url)? else {
            return Ok(Exchange {
                response,
                sent: sent.expect("the first iteration always records a summary"),
                first_byte_ms,
            });
        };

        let taken = hops.lock().map(|h| h.len()).unwrap_or(0);
        if taken >= req.options.max_redirects {
            return Err(format!(
                "{method} {url} went through more than {} redirects",
                req.options.max_redirects
            ));
        }
        if let Ok(mut hops) = hops.lock() {
            hops.push(next.to_string());
        }

        // Browsers (and every other client in practice) turn a redirected POST into a bodiless
        // GET for 301/302/303; only 307/308 promise the method and body survive.
        match response.status().as_u16() {
            303 => {
                method = Method::GET;
                with_body = false;
            }
            301 | 302 if method != Method::GET && method != Method::HEAD => {
                method = Method::GET;
                with_body = false;
            }
            _ => {}
        }
        url = next;
    }
}

/// `Some(target)` only when the redirect policy deliberately stopped so we could re-send with the
/// credentials intact; in every other case reqwest has already followed as far as it will go.
fn manual_redirect_target(
    options: &NetworkOptions,
    response: &reqwest::Response,
    current: &Url,
) -> Result<Option<Url>, String> {
    if !options.follow_redirects
        || !options.keep_auth_on_redirect
        || !response.status().is_redirection()
    {
        return Ok(None);
    }
    let Some(location) = response.headers().get(LOCATION) else {
        return Ok(None);
    };
    let location = location
        .to_str()
        .map_err(|_| format!("{current} redirected with a non-ASCII Location header"))?;
    let target = current
        .join(location)
        .map_err(|e| format!("{current} redirected to '{location}', which is not a valid URL: {e}"))?;
    Ok(Some(target))
}

fn transport_error(method: &Method, url: &Url, err: &reqwest::Error) -> String {
    let cause = crate::api::root_cause(err);

    // A cause we recognize is worth more than the generic verb in front of it: the OS's way of
    // reporting an unresolvable hostname ("nodename nor servname provided, or not known") reads
    // like a bug in the app rather than what it is — a typo in the URL, or a host this machine
    // can't see. Anything unrecognized keeps its raw text, which beats paraphrasing it badly.
    if let Some(explained) = cause
        .as_deref()
        .and_then(|c| crate::api::explain_cause(url.host_str().unwrap_or(""), url.port_or_known_default(), c))
    {
        return format!("{method} {url} — {explained}");
    }

    let what = if err.is_timeout() {
        "timed out"
    } else if err.is_connect() {
        "could not connect"
    } else if err.is_redirect() {
        "stopped following redirects"
    } else if err.is_body() || err.is_decode() {
        "failed while reading the response"
    } else {
        "failed"
    };
    match cause {
        Some(cause) => format!("{method} {url} {what}: {cause}"),
        None => format!("{method} {url} {what}: {err}"),
    }
}


// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

struct Built {
    request: reqwest::Request,
    summary: SentRequestSummary,
}

/// Assembles one `reqwest::Request` from scratch. Everything that has to happen per attempt —
/// re-opening a streamed file, re-signing SigV4 against the new target — lives here, which is why
/// digest re-sends and manual redirect hops just call it again instead of cloning a request.
async fn build_request(
    client: &reqwest::Client,
    req: &HttpSendRequest,
    method: &Method,
    url: &Url,
    extra_headers: &[(String, String)],
    with_body: bool,
) -> Result<Built, String> {
    let mut headers: Vec<(String, String)> = Vec::with_capacity(req.headers.len() + 4);
    for (name, value) in &req.headers {
        headers.push((name.trim().to_ascii_lowercase(), value.clone()));
    }

    let has = |headers: &[(String, String)], name: &str| headers.iter().any(|(k, _)| k == name);

    if !req.options.cookies.is_empty() && !has(&headers, "cookie") {
        let jar = req
            .options
            .cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        headers.push(("cookie".to_string(), jar));
    }

    let body = if with_body {
        prepare_body(req).await?
    } else {
        PreparedBody::none()
    };
    if let Some(content_type) = &body.content_type {
        if !has(&headers, "content-type") {
            headers.push(("content-type".to_string(), content_type.clone()));
        }
    }

    if let Some(BackendAuth::Awsv4 {
        access_key,
        secret_key,
        session_token,
        region,
        service,
    }) = &req.auth
    {
        let signed = sigv4_headers(
            method.as_str(),
            url,
            &headers,
            &body.payload_hash,
            access_key,
            secret_key,
            session_token,
            region,
            service,
            &Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
        )?;
        headers.extend(signed);
    }

    for (name, value) in extra_headers {
        headers.retain(|(k, _)| k != name);
        headers.push((name.clone(), value.clone()));
    }

    // The multipart boundary is generated inside the `Form`, so a caller-supplied
    // `Content-Type: multipart/form-data` would describe a body it cannot delimit.
    if matches!(body.payload, Payload::Multipart(_)) {
        headers.retain(|(k, _)| k != "content-type");
    }

    let mut builder = client.request(method.clone(), url.clone());
    let content_length = body.content_length;
    match body.payload {
        Payload::Empty => {}
        Payload::Bytes(bytes) => builder = builder.body(bytes),
        Payload::Stream(stream) => builder = builder.body(stream),
        Payload::Multipart(form) => builder = builder.multipart(form),
    }

    let mut request = builder
        .build()
        .map_err(|e| format!("Could not build the request for {url}: {e}"))?;

    // hyper honours an explicit Content-Length even when the body length is unknown, which is
    // what keeps a streamed file upload out of chunked encoding.
    if let Some(len) = content_length {
        if !has(&headers, "content-length") {
            request
                .headers_mut()
                .insert(CONTENT_LENGTH, HeaderValue::from(len));
        }
    }
    apply_headers(request.headers_mut(), &headers)?;

    let summary = SentRequestSummary {
        method: method.to_string(),
        url: url.to_string(),
        headers: wire_headers(&request, url),
        body_preview: body.preview,
    };

    Ok(Built { request, summary })
}

/// Caller headers win over anything the body builder inserted, but repeats of the same name
/// (several `Cookie`s, several `Accept`s) are all kept.
fn apply_headers(dst: &mut HeaderMap, src: &[(String, String)]) -> Result<(), String> {
    let mut replaced: HashSet<&str> = HashSet::new();
    for (name, value) in src {
        let header = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("'{name}' is not a valid header name"))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| format!("Header '{name}' has a value that cannot be sent: {value:?}"))?;
        if replaced.insert(name.as_str()) {
            dst.insert(header, header_value);
        } else {
            dst.append(header, header_value);
        }
    }
    Ok(())
}

/// The console has to be believable, so this is the built request's own header map plus the two
/// headers the transport adds further down the stack (`Host` from the URL, `Accept-Encoding` from
/// the decoders this build negotiates) — never a guess about anything else.
fn wire_headers(request: &reqwest::Request, url: &Url) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(request.headers().len() + 2);
    if !request.headers().contains_key(HOST) {
        if let Some(host) = url.host_str() {
            let authority = match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            };
            out.push((HOST.to_string(), authority));
        }
    }
    out.extend(header_pairs(request.headers()));
    if !request.headers().contains_key(ACCEPT_ENCODING) {
        out.push((ACCEPT_ENCODING.to_string(), ADVERTISED_ENCODINGS.to_string()));
    }
    out
}

fn header_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            let rendered = match value.to_str() {
                Ok(text) => text.to_string(),
                Err(_) => format!("<{} non-ASCII bytes>", value.len()),
            };
            (name.to_string(), rendered)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

enum Payload {
    Empty,
    Bytes(Vec<u8>),
    Stream(reqwest::Body),
    Multipart(reqwest::multipart::Form),
}

struct PreparedBody {
    payload: Payload,
    content_type: Option<String>,
    content_length: Option<u64>,
    /// Hex SHA-256 of the payload, or `UNSIGNED-PAYLOAD`. Only read for SigV4.
    payload_hash: String,
    preview: String,
}

impl PreparedBody {
    fn none() -> Self {
        Self {
            payload: Payload::Empty,
            content_type: None,
            content_length: None,
            payload_hash: hex_sha256(b""),
            preview: String::new(),
        }
    }
}

async fn prepare_body(req: &HttpSendRequest) -> Result<PreparedBody, String> {
    if let Some(text) = &req.body_text {
        return Ok(PreparedBody {
            payload_hash: hex_sha256(text.as_bytes()),
            content_length: Some(text.len() as u64),
            preview: preview_text(text),
            payload: Payload::Bytes(text.clone().into_bytes()),
            content_type: None,
        });
    }

    if let Some(encoded) = &req.body_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|e| format!("The request body is not valid base64: {e}"))?;
        return Ok(PreparedBody {
            payload_hash: hex_sha256(&bytes),
            content_length: Some(bytes.len() as u64),
            preview: preview_bytes(&bytes),
            payload: Payload::Bytes(bytes),
            content_type: None,
        });
    }

    if let Some(path) = &req.body_file {
        let size = file_len(path).await?;
        // Hashing means a second pass over the file, but SigV4 cannot sign a payload it hasn't
        // seen and both passes stay at one chunk of memory.
        let payload_hash = match &req.auth {
            Some(BackendAuth::Awsv4 { .. }) => hash_file(path).await?,
            _ => String::new(),
        };
        return Ok(PreparedBody {
            payload: Payload::Stream(file_stream(path).await?),
            content_type: None,
            content_length: Some(size),
            payload_hash,
            preview: format!("<{size} bytes streamed from {path}>"),
        });
    }

    if let Some(pairs) = &req.urlencoded {
        let encoded = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs.iter().map(|(k, v)| (k, v)))
            .finish();
        return Ok(PreparedBody {
            payload_hash: hex_sha256(encoded.as_bytes()),
            content_length: Some(encoded.len() as u64),
            preview: preview_text(&encoded),
            payload: Payload::Bytes(encoded.into_bytes()),
            content_type: Some("application/x-www-form-urlencoded".to_string()),
        });
    }

    if let Some(parts) = &req.form_data {
        let (form, preview) = build_multipart(parts).await?;
        return Ok(PreparedBody {
            payload: Payload::Multipart(form),
            content_type: None,
            content_length: None,
            // reqwest assembles the multipart body (and its boundary) internally, so its exact
            // bytes are not knowable here. AWS accepts UNSIGNED-PAYLOAD for precisely this case.
            payload_hash: "UNSIGNED-PAYLOAD".to_string(),
            preview,
        });
    }

    Ok(PreparedBody::none())
}

async fn build_multipart(parts: &[FormPart]) -> Result<(reqwest::multipart::Form, String), String> {
    let mut form = reqwest::multipart::Form::new();
    let mut preview = String::new();

    for part in parts {
        let mut built = match &part.file_path {
            Some(path) => {
                let size = file_len(path).await?;
                let filename = std::path::Path::new(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| part.name.clone());
                preview.push_str(&format!(
                    "{}: <file {filename}, {size} bytes, from {path}>\n",
                    part.name
                ));
                // A known length is what lets `Form::compute_length` set Content-Length instead of
                // falling back to chunked, which some upload endpoints reject.
                reqwest::multipart::Part::stream_with_length(file_stream(path).await?, size)
                    .file_name(filename)
            }
            None => {
                let value = part.value.clone().unwrap_or_default();
                preview.push_str(&format!("{}: {}\n", part.name, preview_text(&value)));
                reqwest::multipart::Part::text(value)
            }
        };

        if let Some(content_type) = &part.content_type {
            built = built.mime_str(content_type).map_err(|e| {
                format!(
                    "'{content_type}' is not a valid content type for form field '{}': {e}",
                    part.name
                )
            })?;
        }
        form = form.part(part.name.clone(), built);
    }

    Ok((form, preview))
}

async fn file_len(path: &str) -> Result<u64, String> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("Cannot read '{path}': {e}"))?;
    if meta.is_dir() {
        return Err(format!("'{path}' is a directory, not a file"));
    }
    Ok(meta.len())
}

/// Streams the file in fixed chunks so a multi-gigabyte upload never lands in memory.
async fn file_stream(path: &str) -> Result<reqwest::Body, String> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Cannot open '{path}': {e}"))?;
    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        let mut chunk = vec![0u8; FILE_CHUNK_BYTES];
        let read = file.read(&mut chunk).await?;
        if read == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        chunk.truncate(read);
        Ok(Some((Bytes::from(chunk), file)))
    });
    Ok(reqwest::Body::wrap_stream(stream))
}

async fn hash_file(path: &str) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Cannot open '{path}': {e}"))?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; FILE_CHUNK_BYTES];
    loop {
        let read = file
            .read(&mut chunk)
            .await
            .map_err(|e| format!("Cannot read '{path}': {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn preview_text(text: &str) -> String {
    if text.len() <= BODY_PREVIEW_LIMIT {
        return text.to_string();
    }
    let mut cut = BODY_PREVIEW_LIMIT;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}… ({} bytes total)", &text[..cut], text.len())
}

fn preview_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => preview_text(text),
        Err(_) => format!("<{} bytes of binary>", bytes.len()),
    }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/// Reads at most `cap` bytes (0 = unlimited) and returns what it got: hitting the cap is a
/// truncation, not a failure — a 2 GB response should still show its first megabyte.
async fn read_body(
    mut response: reqwest::Response,
    cap: u64,
    url: &Url,
) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| match crate::api::root_cause(&e) {
            Some(cause) => format!("Reading the response body from {url} failed: {cause}"),
            None => format!("Reading the response body from {url} failed: {e}"),
        })?
    {
        if cap == 0 {
            body.extend_from_slice(&chunk);
            continue;
        }
        let room = (cap - body.len() as u64) as usize;
        if chunk.len() >= room {
            body.extend_from_slice(&chunk[..room]);
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_set_cookies(headers: &HeaderMap, url: &Url) -> Vec<ParsedCookie> {
    headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| parse_set_cookie(value, url))
        .collect()
}

fn parse_set_cookie(value: &str, url: &Url) -> Option<ParsedCookie> {
    let mut segments = value.split(';');
    let (name, cookie_value) = segments.next()?.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }

    let mut cookie = ParsedCookie {
        name: name.to_string(),
        value: cookie_value.trim().to_string(),
        domain: url.host_str().unwrap_or_default().to_string(),
        path: "/".to_string(),
        expires: None,
        secure: false,
        http_only: false,
    };

    let mut max_age: Option<i64> = None;
    let mut expires: Option<String> = None;
    for segment in segments {
        let segment = segment.trim();
        let (key, attr) = match segment.split_once('=') {
            Some((key, attr)) => (key.trim(), attr.trim()),
            None => (segment, ""),
        };
        match key.to_ascii_lowercase().as_str() {
            // A leading dot is the pre-RFC6265 spelling of "and every subdomain"; the modern
            // semantics are identical without it, and the jar matches on the bare host.
            "domain" if !attr.is_empty() => {
                cookie.domain = attr.trim_start_matches('.').to_string()
            }
            "path" if !attr.is_empty() => cookie.path = attr.to_string(),
            "expires" => expires = Some(attr.to_string()),
            "max-age" => max_age = attr.parse::<i64>().ok(),
            "secure" => cookie.secure = true,
            "httponly" => cookie.http_only = true,
            _ => {}
        }
    }

    // RFC 6265: Max-Age wins over Expires wherever both are present.
    cookie.expires = match max_age {
        Some(seconds) => Some((Utc::now() + ChronoDuration::seconds(seconds)).to_rfc3339()),
        None => expires.and_then(|raw| parse_http_date(&raw)),
    };
    Some(cookie)
}

/// Accepts the three date formats RFC 6265 requires a client to tolerate, and gives up rather
/// than guessing — an unparseable expiry is reported as a session cookie.
fn parse_http_date(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc2822(raw) {
        return Some(parsed.with_timezone(&Utc).to_rfc3339());
    }
    for format in ["%a, %d %b %Y %H:%M:%S GMT", "%A, %d-%b-%y %H:%M:%S GMT", "%a %b %e %H:%M:%S %Y"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, format) {
            return Some(Utc.from_utc_datetime(&naive).to_rfc3339());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Digest (RFC 7616)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum DigestHash {
    Md5,
    Sha256,
}

impl DigestHash {
    fn of(self, data: &str) -> String {
        match self {
            DigestHash::Md5 => hex::encode(md5::Md5::digest(data.as_bytes())),
            DigestHash::Sha256 => hex::encode(Sha256::digest(data.as_bytes())),
        }
    }
}

struct DigestInput<'a> {
    hash: DigestHash,
    /// `MD5-sess`/`SHA-256-sess` fold the nonces into HA1 so a stolen HA1 expires with the nonce.
    session: bool,
    username: &'a str,
    password: &'a str,
    realm: &'a str,
    nonce: &'a str,
    cnonce: &'a str,
    nc: &'a str,
    qop: Option<&'a str>,
    method: &'a str,
    uri: &'a str,
}

fn digest_response(input: &DigestInput) -> String {
    let hash = input.hash;
    let mut ha1 = hash.of(&format!(
        "{}:{}:{}",
        input.username, input.realm, input.password
    ));
    if input.session {
        ha1 = hash.of(&format!("{ha1}:{}:{}", input.nonce, input.cnonce));
    }
    let ha2 = hash.of(&format!("{}:{}", input.method, input.uri));

    match input.qop {
        Some(qop) => hash.of(&format!(
            "{ha1}:{}:{}:{}:{qop}:{ha2}",
            input.nonce, input.nc, input.cnonce
        )),
        // RFC 2069, still what some appliances speak.
        None => hash.of(&format!("{ha1}:{}:{ha2}", input.nonce)),
    }
}

fn digest_challenge(headers: &HeaderMap) -> Option<HashMap<String, String>> {
    headers
        .get_all(WWW_AUTHENTICATE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| {
            // A server may offer several schemes on separate header lines; only the Digest one
            // carries a nonce.
            let trimmed = value.trim_start();
            trimmed.get(..6).filter(|s| s.eq_ignore_ascii_case("Digest"))?;
            Some(parse_auth_params(trimmed[6..].trim_start()))
        })
}

/// `key=value` / `key="value"` pairs, where a quoted value may itself contain commas
/// (`qop="auth,auth-int"`) — which is why this is not a `split(',')`.
fn parse_auth_params(input: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    let mut chars = input.chars().peekable();

    loop {
        let mut key = String::new();
        while let Some(&c) = chars.peek() {
            if c == '=' || c == ',' {
                break;
            }
            key.push(c);
            chars.next();
        }
        let key = key.trim().to_ascii_lowercase();

        let mut value = String::new();
        if chars.peek() == Some(&'=') {
            chars.next();
            if chars.peek() == Some(&'"') {
                chars.next();
                let mut escaped = false;
                for c in chars.by_ref() {
                    if escaped {
                        value.push(c);
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == '"' {
                        break;
                    } else {
                        value.push(c);
                    }
                }
            } else {
                while let Some(&c) = chars.peek() {
                    if c == ',' {
                        break;
                    }
                    value.push(c);
                    chars.next();
                }
            }
        }

        if !key.is_empty() {
            params.insert(key, value.trim().to_string());
        }

        // Skip the separator and any padding before the next key.
        while matches!(chars.peek(), Some(&c) if c == ',' || c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            return params;
        }
    }
}

fn digest_authorization(
    username: &str,
    password: &str,
    method: &str,
    url: &Url,
    challenge: &HashMap<String, String>,
) -> Result<String, String> {
    let realm = challenge.get("realm").map(String::as_str).unwrap_or_default();
    let nonce = challenge
        .get("nonce")
        .map(String::as_str)
        .filter(|n| !n.is_empty())
        .ok_or("The digest challenge has no nonce, so no response can be computed")?;

    let algorithm = challenge
        .get("algorithm")
        .map(String::as_str)
        .unwrap_or("MD5");
    let session = algorithm.to_ascii_uppercase().ends_with("-SESS");
    let hash = match algorithm.to_ascii_uppercase().trim_end_matches("-SESS") {
        "MD5" => DigestHash::Md5,
        "SHA-256" => DigestHash::Sha256,
        other => {
            return Err(format!(
                "The server asked for digest algorithm '{other}', which is not supported \
                 (MD5, MD5-sess, SHA-256 and SHA-256-sess are)"
            ))
        }
    };

    let offered = challenge.get("qop").map(String::as_str).unwrap_or_default();
    let qop = if offered.is_empty() {
        None
    } else if offered.split(',').any(|q| q.trim().eq_ignore_ascii_case("auth")) {
        Some("auth")
    } else {
        return Err(format!(
            "The server only offers digest qop='{offered}'; this client implements qop=auth"
        ));
    };

    let cnonce = hex::encode(rand::random::<[u8; 16]>());
    let nc = "00000001";
    let uri = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };

    let response = digest_response(&DigestInput {
        hash,
        session,
        username,
        password,
        realm,
        nonce,
        cnonce: &cnonce,
        nc,
        qop,
        method,
        uri: &uri,
    });

    let mut header = format!(
        "Digest username=\"{username}\", realm=\"{realm}\", nonce=\"{nonce}\", \
         uri=\"{uri}\", response=\"{response}\""
    );
    if challenge.contains_key("algorithm") {
        header.push_str(&format!(", algorithm={algorithm}"));
    }
    if let Some(opaque) = challenge.get("opaque") {
        header.push_str(&format!(", opaque=\"{opaque}\""));
    }
    if let Some(qop) = qop {
        header.push_str(&format!(", qop={qop}, nc={nc}, cnonce=\"{cnonce}\""));
    }
    Ok(header)
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------

const SIGV4_ALGORITHM: &str = "AWS4-HMAC-SHA256";

/// The only characters SigV4 leaves literal. Everything else is percent-encoded uppercase, and
/// notably `/` is *not* exempt here — the canonical path adds it back deliberately.
const SIGV4_UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

const SIGV4_PATH: &AsciiSet = &SIGV4_UNRESERVED.remove(b'/');

fn hex_sha256(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .expect("HMAC-SHA256 accepts a key of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Everything SigV4 signs, already reduced to strings. Kept separate from the request builder so
/// the algorithm can be tested against AWS's published vectors without a socket.
struct SigV4Request<'a> {
    method: &'a str,
    canonical_uri: &'a str,
    canonical_query: &'a str,
    /// Lowercased names, normalized values, any order.
    headers: &'a [(String, String)],
    payload_hash: &'a str,
}

/// The access key is absent on purpose: it names the credential in the `Authorization` header but
/// never takes part in the signature, so keeping it out means it cannot drift into the maths.
struct SigV4Credentials<'a> {
    secret_key: &'a str,
    region: &'a str,
    service: &'a str,
}

/// Returns `(signed_headers, signature)` for `amz_date` in `YYYYMMDDTHHMMSSZ` form.
fn sigv4_sign(
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
fn sigv4_headers(
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

    /// The worked example from RFC 2617 §3.5, which RFC 7616 keeps for MD5.
    #[test]
    fn digest_matches_the_rfc_2617_example() {
        let response = digest_response(&DigestInput {
            hash: DigestHash::Md5,
            session: false,
            username: "Mufasa",
            password: "Circle Of Life",
            realm: "testrealm@host.com",
            nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
            cnonce: "0a4f113b",
            nc: "00000001",
            qop: Some("auth"),
            method: "GET",
            uri: "/dir/index.html",
        });

        assert_eq!(response, "6629fae49393a05397450978507c4ef1");
    }

    /// Without a `qop` the response collapses to the RFC 2069 form, which drops nc/cnonce/qop.
    #[test]
    fn digest_falls_back_to_the_rfc_2069_form() {
        let response = digest_response(&DigestInput {
            hash: DigestHash::Md5,
            session: false,
            username: "Mufasa",
            password: "Circle Of Life",
            realm: "testrealm@host.com",
            nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
            cnonce: "0a4f113b",
            nc: "00000001",
            qop: None,
            method: "GET",
            uri: "/dir/index.html",
        });

        // MD5("939e7578ed9e3c518a452acee763bce9:dcd98b7102dd2f0e8b11d0f600bfb0c093:
        //      39aff3a2bab6126f332b942af96d3366")
        assert_eq!(response, "670fd8c2df070c60b045671b8b24ff02");
    }

    #[test]
    fn auth_params_survive_commas_inside_quotes() {
        let params = parse_auth_params(
            r#"realm="test@host.com", qop="auth,auth-int", nonce="abc123", algorithm=MD5"#,
        );

        assert_eq!(params.get("realm").unwrap(), "test@host.com");
        assert_eq!(params.get("qop").unwrap(), "auth,auth-int");
        assert_eq!(params.get("nonce").unwrap(), "abc123");
        assert_eq!(params.get("algorithm").unwrap(), "MD5");
    }

    #[test]
    fn canonical_query_sorts_and_encodes() {
        let url = Url::parse("https://example.com/x?b=2&a=1&c=hello world&a=0").unwrap();
        assert_eq!(canonical_query(&url), "a=0&a=1&b=2&c=hello%20world");
    }

    #[test]
    fn set_cookie_defaults_to_the_request_host_and_root_path() {
        let url = Url::parse("https://api.example.com/v1/login").unwrap();
        let cookie = parse_set_cookie("sid=abc123; HttpOnly; Secure", &url).unwrap();

        assert_eq!(cookie.name, "sid");
        assert_eq!(cookie.value, "abc123");
        assert_eq!(cookie.domain, "api.example.com");
        assert_eq!(cookie.path, "/");
        assert!(cookie.secure);
        assert!(cookie.http_only);
        assert!(cookie.expires.is_none());
    }

    #[test]
    fn set_cookie_reads_domain_path_and_expiry() {
        let url = Url::parse("https://api.example.com/v1/login").unwrap();
        let cookie = parse_set_cookie(
            "sid=abc; Domain=.example.com; Path=/app; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
            &url,
        )
        .unwrap();

        assert_eq!(cookie.domain, "example.com");
        assert_eq!(cookie.path, "/app");
        assert_eq!(cookie.expires.unwrap(), "2015-10-21T07:28:00+00:00");
    }
}



// ---------------------------------------------------------------------------
// Deciding whether a response is text
// ---------------------------------------------------------------------------

fn response_content_type(headers: &[(String, String)]) -> Option<String> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.to_ascii_lowercase())
}

/// Whether a media type carries text a human would want to read.
///
/// Structured types are matched by suffix (`+json`, `+xml`) rather than by an exhaustive list,
/// because every vendor type in the wild (`application/vnd.github+json`,
/// `application/problem+json`) is one, and a list would be wrong the day after it was written.
fn is_textual_type(content_type: &str) -> bool {
    let media = content_type.split(';').next().unwrap_or("").trim();
    media.starts_with("text/")
        || media.ends_with("+json")
        || media.ends_with("+xml")
        || matches!(
            media,
            "application/json"
                | "application/xml"
                | "application/javascript"
                | "application/x-javascript"
                | "application/ecmascript"
                | "application/graphql"
                | "application/x-www-form-urlencoded"
                | "application/x-ndjson"
                | "application/ld+json"
                | "application/sql"
                | "image/svg+xml"
        )
}

fn charset_of(content_type: &str) -> Option<String> {
    content_type.split(';').skip(1).find_map(|param| {
        let (key, value) = param.split_once('=')?;
        (key.trim() == "charset").then(|| value.trim().trim_matches('"').to_ascii_lowercase())
    })
}

/// A body with no declared type: treat it as text unless it looks like it isn't.
///
/// A NUL byte is the signal — it cannot appear in any of the text encodings a server would send,
/// and it appears almost immediately in every binary format worth naming. Only the head is
/// examined so a large download isn't scanned twice.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(4096).any(|&b| b == 0)
}

/// Turns the raw body into `(body_text, body_base64)`, exactly one of which is meaningful.
///
/// **Validity is not the test — the declared type is.** A page can be served as `text/html;
/// charset=UTF-8` and still contain a handful of bytes that aren't valid UTF-8 (google.com is one
/// such page). Refusing to show 80 KB of readable HTML because of them is worse in every way than
/// showing it with a replacement character where the bad byte was, which is what every other
/// client does.
///
/// Latin-1 and Windows-1252 are transcoded rather than replaced, since a server that declares them
/// means it, and they are the only legacy charsets common enough to be worth the (tiny) code.
fn decode_body(bytes: Vec<u8>, content_type: Option<&str>) -> (String, Option<String>) {
    let textual = match content_type {
        Some(ct) => is_textual_type(ct),
        None => !looks_binary(&bytes),
    };
    if !textual {
        return (
            String::new(),
            Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        );
    }

    match content_type.and_then(charset_of).as_deref() {
        Some("iso-8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252") => {
            (bytes.iter().map(|&b| b as char).collect(), None)
        }
        _ => (String::from_utf8_lossy(&bytes).into_owned(), None),
    }
}

#[cfg(test)]
mod decode_tests {
    use super::*;

    /// The google.com case: declared HTML, mostly readable, one byte that isn't valid UTF-8.
    #[test]
    fn declared_text_with_an_invalid_byte_is_still_text() {
        let mut bytes = b"<!doctype html><title>hi</title>".to_vec();
        bytes.push(0xFF);
        let (text, base64) = decode_body(bytes, Some("text/html; charset=utf-8"));
        assert!(text.starts_with("<!doctype html>"), "{text}");
        assert!(text.ends_with('\u{FFFD}'), "the bad byte becomes a replacement char");
        assert!(base64.is_none());
    }

    #[test]
    fn binary_types_and_undeclared_binary_go_to_base64() {
        let png = vec![0x89, b'P', b'N', b'G', 0x00, 0x01];
        let (text, base64) = decode_body(png.clone(), Some("image/png"));
        assert!(text.is_empty());
        assert!(base64.is_some());

        let (text, base64) = decode_body(png, None);
        assert!(text.is_empty(), "a NUL byte with no declared type reads as binary");
        assert!(base64.is_some());
    }

    #[test]
    fn undeclared_text_is_shown_and_vendor_json_counts_as_text() {
        let (text, base64) = decode_body(b"plain body".to_vec(), None);
        assert_eq!(text, "plain body");
        assert!(base64.is_none());

        assert!(is_textual_type("application/vnd.github+json"));
        assert!(is_textual_type("application/problem+json; charset=utf-8"));
        assert!(!is_textual_type("application/octet-stream"));
    }

    #[test]
    fn a_declared_legacy_charset_is_transcoded_not_replaced() {
        // 0xF1 is `ñ` in Latin-1 and invalid on its own in UTF-8.
        let (text, _) = decode_body(vec![b'a', 0xF1, b'o'], Some("text/plain; charset=iso-8859-1"));
        assert_eq!(text, "año");
    }
}
