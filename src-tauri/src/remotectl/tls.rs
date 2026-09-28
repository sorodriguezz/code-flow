//! HTTPS for the phone server: one self-signed certificate per install, and a listener that speaks
//! TLS in front of the same router.
//!
//! # Why this exists
//!
//! The server listens on the LAN (see `server::start`), and until this module every byte of it was
//! plaintext: the bearer token on every RPC, the token in the event socket's URL, every diff and every
//! chat turn. On a home network that is a risk; on a café's or an office's shared wifi it is anybody
//! with a packet capture holding a credential that commits and pushes as you.
//!
//! # Why self-signed, and what the user is asked to do
//!
//! There is no name a public authority could vouch for — the phone reaches this machine by whatever
//! LAN address DHCP handed out — so the certificate is minted here, once, and the phone's browser
//! warns about it the first time. That warning is the moment the fingerprint matters: the desktop's
//! pairing pane shows the SHA-256 of *this* certificate, the browser's warning shows the SHA-256 of
//! the one it was handed, and the two matching is what rules out somebody in between. The phone's
//! own pairing screen repeats the value the server reports, as a convenience; on its own it proves
//! nothing, since an impostor's page reports whatever it likes.
//!
//! # Why the key is a file and not a keychain item
//!
//! The server comes up at launch when the setting says so (`remotectl::autostart`), before anybody
//! has asked for anything — and on macOS a keychain read by a build whose signature changed with the
//! last update pops the login-password prompt, at startup, with nothing on screen to explain it. A
//! file in the state root that only this user can read ([`write_private`]) needs no prompt, and a
//! reset takes it with every other piece of state: the next start mints a new one.
//!
//! # One port, two answers
//!
//! A TLS connection opens with a handshake record (`0x16`); an HTTP request opens with an ASCII
//! method. So the port tells them apart from the first byte, and while TLS is on a plain request is
//! still answered — never by the app or the API, only by [`plain_reply`], which sends the phone to
//! the `https://` address and carries its pairing across (see [`HANDOFF_PAGE`]).

use std::io::{self, Write as _};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::Datelike as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

/// The certificate, as PEM. Nothing in it is secret — every phone is handed it during the handshake.
const CERT_FILE: &str = "phone-cert.pem";
/// The private key, as PKCS#8 PEM. Owner-only; see [`write_private`].
const KEY_FILE: &str = "phone-key.pem";

/// How long a minted certificate is valid.
///
/// Under the 825 days iOS accepts for a TLS server certificate. Past that Safari does not offer the
/// warning the user can click through — it refuses the connection, which on a phone reads as the
/// desktop being unreachable.
const VALIDITY_DAYS: u64 = 800;
/// How close to its expiry a certificate is replaced, at the next start. A month, so a machine left
/// running for weeks never serves one that expires under it.
const RENEW_WITHIN_DAYS: u64 = 30;
const DAY: Duration = Duration::from_secs(86_400);

/// How long a connection may take to say what it is and finish the handshake. A client that
/// connects and sends nothing must not hold a task forever.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Finished handshakes waiting for the server to take them.
const PENDING: usize = 64;
/// The most of a plain request's head [`answer_plain`] reads before answering anyway.
const MAX_PLAIN_HEAD: usize = 8 * 1024;
/// The first byte of every TLS connection: a handshake record.
const TLS_HANDSHAKE: u8 = 0x16;

/// This install's certificate and key, and the fingerprint the desktop shows for them.
pub struct Identity {
    cert: CertificateDer<'static>,
    key: PrivatePkcs8KeyDer<'static>,
    /// The SHA-256 of the certificate, as [`fingerprint`] spells it.
    pub fingerprint: String,
    /// When the certificate stops being valid — read back out of it rather than remembered, so a copy
    /// restored from somewhere else is judged by what it actually says.
    pub expires: SystemTime,
}

impl Identity {
    /// The server half of the handshake.
    ///
    /// Built on an explicit `ring` provider rather than the process default, for the reason the
    /// manifest gives: a second provider in the binary is a runtime panic for every other TLS caller.
    /// `http/1.1` only — the WebSocket upgrade the event stream depends on is an HTTP/1.1 affair.
    pub fn server_config(&self) -> Result<Arc<rustls::ServerConfig>, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_no_client_auth()
            .with_single_cert(vec![self.cert.clone()], PrivateKeyDer::Pkcs8(self.key.clone_key()))
            .map_err(|e| e.to_string())?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Arc::new(config))
    }
}

/// The certificate in `dir`, minting one when there is none, it cannot be read, or it is close to
/// expiring.
///
/// Minted once and then reused on purpose: every phone that has accepted the warning accepted *this*
/// certificate, and a new one — a new fingerprint — means each of them being warned again.
pub fn load_or_create(dir: &Path) -> Result<Identity, String> {
    load_or_create_at(dir, SystemTime::now())
}

fn load_or_create_at(dir: &Path, now: SystemTime) -> Result<Identity, String> {
    if let Some(identity) = read(dir) {
        // `server_config` doubles as the consistency check: rustls refuses a key that does not match
        // the certificate, which is what a crash between the two writes would leave behind.
        if identity.expires > now + DAY * RENEW_WITHIN_DAYS as u32 && identity.server_config().is_ok() {
            return Ok(identity);
        }
    }
    let (cert_pem, key_pem) = mint(now)?;
    store(dir, &cert_pem, &key_pem).map_err(|e| format!("could not save the certificate: {e}"))?;
    read(dir).ok_or_else(|| "the certificate just written could not be read back".to_string())
}

/// The pair on disk, or `None` for anything short of a whole, parseable one.
fn read(dir: &Path) -> Option<Identity> {
    let cert_pem = std::fs::read(dir.join(CERT_FILE)).ok()?;
    let key_pem = std::fs::read(dir.join(KEY_FILE)).ok()?;
    let cert = rustls_pemfile::certs(&mut cert_pem.as_slice()).next()?.ok()?;
    let key = rustls_pemfile::pkcs8_private_keys(&mut key_pem.as_slice()).next()?.ok()?;
    let expires = expiry(&cert)?;
    Some(Identity { fingerprint: fingerprint(&cert), cert, key, expires })
}

/// A new self-signed certificate and its key, as PEM.
///
/// What is in it is shaped by what a phone's browser will still let the user click through:
/// ECDSA P-256 over SHA-256, an `id-kp-serverAuth` extended key usage, names in the subject
/// alternative name rather than the common name, and a validity under [`VALIDITY_DAYS`] — iOS 13
/// and later refuse a server certificate missing any of those outright, warning or not.
fn mint(now: SystemTime) -> Result<(String, String), String> {
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| e.to_string())?;
    let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()]).map_err(|e| e.to_string())?;
    params.subject_alt_names.push(rcgen::SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    params.subject_alt_names.push(rcgen::SanType::IpAddress(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    // The address the phone is told to open, as it is today. It will not match forever — DHCP moves
    // it — and nothing breaks when it stops: the certificate is self-signed, so the browser warns
    // either way, and the fingerprint rather than the name is what the user compares.
    if let Some(ip) = super::lan_address() {
        params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
    }
    params.distinguished_name = rcgen::DistinguishedName::new();
    params.distinguished_name.push(rcgen::DnType::CommonName, "CodeFlow");
    params.distinguished_name.push(rcgen::DnType::OrganizationName, "CodeFlow remote control");
    params.is_ca = rcgen::IsCa::ExplicitNoCa;
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    // Whole days, from yesterday: a phone whose clock runs a few hours behind this machine's must not
    // be handed a certificate that is not valid yet.
    let midnight = |at: SystemTime| {
        let day = chrono::DateTime::<chrono::Utc>::from(at);
        rcgen::date_time_ymd(day.year(), day.month() as u8, day.day() as u8)
    };
    params.not_before = midnight(now - DAY);
    params.not_after = midnight(now + DAY * VALIDITY_DAYS as u32);
    let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
    Ok((cert.pem(), key.serialize_pem()))
}

/// Writes the pair, key first.
fn store(dir: &Path, cert_pem: &str, key_pem: &str) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    write_private(&dir.join(KEY_FILE), key_pem.as_bytes())?;
    write_private(&dir.join(CERT_FILE), cert_pem.as_bytes())
}

/// Writes a file only its owner can read, replacing any previous one in a single rename.
///
/// Created `0600` from the start rather than written and then narrowed: between those two steps the
/// key would be readable by anybody on the machine. On Windows the state root is already the user's
/// own (`%LOCALAPPDATA%`), which is the same guarantee by the platform's route.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let staging = path.with_extension("pem.new");
    let _ = std::fs::remove_file(&staging);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&staging)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&staging, path)
}

/// When a DER certificate stops being valid.
fn expiry(der: &[u8]) -> Option<SystemTime> {
    use x509_cert::der::Decode as _;
    let cert = x509_cert::Certificate::from_der(der).ok()?;
    Some(UNIX_EPOCH + cert.tbs_certificate.validity.not_after.to_unix_duration())
}

/// The SHA-256 of a certificate, as upper-case hex pairs joined by colons.
///
/// The spelling Firefox, Chrome's certificate viewer and `openssl x509 -fingerprint -sha256` all
/// print, so the user compares two strings that look alike rather than translating between formats
/// in their head.
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

/// A TCP listener whose connections arrive at axum already decrypted.
///
/// The handshakes happen on tasks of their own, not in `accept`: axum accepts one connection at a
/// time, so a handshake inside it would let one slow phone — or one client that connects and says
/// nothing — hold the door shut for everybody else.
pub struct TlsListener {
    incoming: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    local: SocketAddr,
}

impl TlsListener {
    pub fn new(tcp: TcpListener, config: Arc<rustls::ServerConfig>) -> io::Result<Self> {
        let local = tcp.local_addr()?;
        let (sender, incoming) = mpsc::channel(PENDING);
        tokio::spawn(accept_loop(tcp, TlsAcceptor::from(config), sender));
        Ok(Self { incoming, local })
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.incoming.recv().await {
            Some(connection) => connection,
            // The accept loop is gone, which only happens when it lost its socket for good. Nothing
            // will ever arrive again; graceful shutdown is still what ends the server.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(self.local)
    }
}

/// Accepts until the [`TlsListener`] is dropped — which is what stopping the server does — and then
/// returns, releasing the port with it.
///
/// Waiting on `closed()` rather than finding out on the next `send` is the difference between the
/// port coming free now and coming free whenever the next phone happens to knock: a rebind to the
/// same port (turning TLS off and on) is waiting for exactly this.
async fn accept_loop(
    tcp: TcpListener,
    acceptor: TlsAcceptor,
    sender: mpsc::Sender<(TlsStream<TcpStream>, SocketAddr)>,
) {
    loop {
        let accepted = tokio::select! {
            () = sender.closed() => return,
            accepted = tcp.accept() => accepted,
        };
        let (stream, peer) = match accepted {
            Ok(pair) => pair,
            Err(e) => {
                // A peer that gave up mid-accept is ordinary; anything else is usually the process
                // out of descriptors, and hammering `accept` again at once would only spin.
                if !matches!(
                    e.kind(),
                    io::ErrorKind::ConnectionRefused
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::ConnectionReset
                ) {
                    eprintln!("[remotectl] accept failed: {e}");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                continue;
            }
        };
        let acceptor = acceptor.clone();
        let sender = sender.clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(HANDSHAKE_TIMEOUT, admit(stream, peer, acceptor, sender)).await;
        });
    }
}

/// Reads the first byte without consuming it and routes the connection by it.
async fn admit(
    stream: TcpStream,
    peer: SocketAddr,
    acceptor: TlsAcceptor,
    sender: mpsc::Sender<(TlsStream<TcpStream>, SocketAddr)>,
) {
    let mut first = [0u8; 1];
    match stream.peek(&mut first).await {
        Ok(1) if first[0] == TLS_HANDSHAKE => {
            // A failed handshake is somebody's browser declining the certificate, or a scanner. It
            // ends here; there is nobody to report it to.
            if let Ok(tls) = acceptor.accept(stream).await {
                let _ = sender.send((tls, peer)).await;
            }
        }
        Ok(1) => answer_plain(stream).await,
        // Closed before saying anything.
        _ => {}
    }
}

/// Answers one plain-HTTP request on a port that now speaks TLS, and hangs up.
async fn answer_plain(mut stream: TcpStream) {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while head.len() < MAX_PLAIN_HEAD && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => head.extend_from_slice(&chunk[..read]),
        }
    }
    let target = request_target(&head).unwrap_or_else(|| "/".to_string());
    let _ = stream.write_all(plain_reply(&target).as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// The path a request line names — `GET /api/hello HTTP/1.1` → `/api/hello`.
fn request_target(head: &[u8]) -> Option<String> {
    let line = head.split(|byte| *byte == b'\n').next()?;
    let line = std::str::from_utf8(line).ok()?;
    line.split_whitespace().nth(1).map(str::to_string)
}

/// What a plain request gets while TLS is on: the complete HTTP response.
///
/// Three answers, and each one is chosen for a client that already exists:
///
/// * **`/api/hello`** — what a phone left open on the old `http://` page asks on every reconnect, to
///   learn whether the desktop was rebuilt under it (`reloadIfStale` in `transport.ts`). A `bundle`
///   no build ever has makes it reload itself — onto [`HANDOFF_PAGE`].
/// * **Any other `/api` route** — refused, and with a 503 rather than a 401: the old client deletes
///   its token on a 401, and the token is exactly what the handoff is about to carry across.
/// * **Anything else** — the handoff page.
pub(crate) fn plain_reply(target: &str) -> String {
    let path = target.split(['?', '#']).next().unwrap_or("/");
    let (status, content_type, body) = if path == "/api/hello" {
        ("200 OK", "application/json", HELLO_OVER_PLAIN)
    } else if path == "/api" || path.starts_with("/api/") {
        ("503 Service Unavailable", "application/json", r#"{"ok":false,"error":"tls_required"}"#)
    } else {
        ("200 OK", "text/html; charset=utf-8", HANDOFF_PAGE)
    };
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// `/api/hello` over plain HTTP. See [`plain_reply`].
const HELLO_OVER_PLAIN: &str = r#"{"app":"codeflow","pairing":false,"bundle":"https","tls":true}"#;

/// Moves a phone from the `http://` address to the `https://` one without unpairing it.
///
/// The token a paired phone holds lives in the `http://` origin's storage, and the `https://` origin
/// is a different origin: it cannot see it, so the phone would open the secure address unpaired. So
/// this page — served only by this module, never the app — reads the three keys `transport.ts`
/// writes and hands them to the secure page in the URL's *fragment*, which the browser never sends
/// to any server. The secure page adopts them only when it holds no pairing of its own, and wipes
/// the fragment from its history entry before anything else runs (`adoptHandoff` in `transport.ts`).
///
/// Nothing is exposed that was not already: this page is served over the same plaintext the token
/// has been travelling in on every request until now, and it is the last time it does.
const HANDOFF_PAGE: &str = r##"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeFlow</title>
</head>
<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.5">
<p>CodeFlow &rarr; <a id="go" href="/">https://</a></p>
<noscript>Abre esta dirección con https:// &middot; Open this address with https://</noscript>
<script>
(function () {
  var secure = "https://" + location.host + "/";
  var link = document.getElementById("go");
  if (link) { link.href = secure; link.textContent = secure; }
  var carry = "";
  try {
    var token = localStorage.getItem("codeflow.remote.token");
    if (token) {
      carry = "#cf-handoff=" + encodeURIComponent(JSON.stringify({
        t: token,
        n: localStorage.getItem("codeflow.remote.name") || "",
        d: localStorage.getItem("codeflow.remote.device") || ""
      }));
    }
  } catch (e) {}
  location.replace(secure + carry);
})();
</script>
</body>
</html>
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::{ServerName, UnixTime};

    /// A directory of its own under the system temp dir, removed when the guard goes.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            Self(std::env::temp_dir().join(format!("codeflow-tls-{name}-{}", uuid::Uuid::new_v4())))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The spelling is the contract: the user compares it character by character against what the
    /// phone's browser prints.
    #[test]
    fn the_fingerprint_is_upper_case_hex_pairs_joined_by_colons() {
        // SHA-256("abc"), the FIPS 180-2 test vector.
        assert_eq!(
            fingerprint(b"abc"),
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"
        );
        assert_eq!(fingerprint(b"").len(), 32 * 3 - 1);
    }

    /// Minted once: a second start must serve the certificate every phone already accepted.
    #[test]
    fn a_certificate_is_minted_once_and_read_back() {
        let dir = Scratch::new("once");
        let first = load_or_create(&dir.0).unwrap();
        let second = load_or_create(&dir.0).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.fingerprint, fingerprint(&second.cert));
        assert!(second.server_config().is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = |name: &str| std::fs::metadata(dir.0.join(name)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(KEY_FILE), 0o600, "the private key must be the owner's alone");
            assert_eq!(std::fs::metadata(&dir.0).unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    /// Anything short of a whole pair is replaced rather than served — or refused at every start.
    #[test]
    fn a_damaged_pair_is_replaced() {
        let dir = Scratch::new("damaged");
        let original = load_or_create(&dir.0).unwrap();
        std::fs::write(dir.0.join(KEY_FILE), "not a key").unwrap();
        let replaced = load_or_create(&dir.0).unwrap();
        assert_ne!(original.fingerprint, replaced.fingerprint);
        assert!(replaced.server_config().is_ok());

        // A key that parses but belongs to another certificate: what a crash between the two writes
        // would leave. rustls refuses the pair, so it is minted again.
        let other = Scratch::new("other");
        load_or_create(&other.0).unwrap();
        std::fs::copy(other.0.join(KEY_FILE), dir.0.join(KEY_FILE)).unwrap();
        let mismatched = read(&dir.0).unwrap();
        assert!(mismatched.server_config().is_err(), "a key from another pair must not be accepted");
        let healed = load_or_create(&dir.0).unwrap();
        assert!(healed.server_config().is_ok());
    }

    /// Renewed before it expires, and never valid for longer than iOS accepts.
    #[test]
    fn a_certificate_close_to_expiry_is_renewed() {
        let dir = Scratch::new("renew");
        let now = SystemTime::now();
        let old = load_or_create_at(&dir.0, now - DAY * (VALIDITY_DAYS as u32 - 10)).unwrap();
        assert!(old.expires < now + DAY * RENEW_WITHIN_DAYS as u32);

        let fresh = load_or_create_at(&dir.0, now).unwrap();
        assert_ne!(old.fingerprint, fresh.fingerprint, "an expiring certificate must be replaced");
        let lifetime = fresh.expires.duration_since(now).unwrap();
        assert!(lifetime <= DAY * 825, "iOS refuses a server certificate valid for more than 825 days");
        assert!(lifetime >= DAY * (VALIDITY_DAYS as u32 - 2));
    }

    /// The three answers a plain request can get while TLS is on — and the one it must never get: a
    /// 401, which an old client answers by deleting the token the handoff is carrying across.
    #[test]
    fn a_plain_request_is_sent_to_https_and_never_told_it_is_unpaired() {
        let page = plain_reply("/");
        assert!(page.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(page.contains("text/html"));
        assert!(page.contains("cf-handoff"));
        assert!(page.contains("codeflow.remote.token"), "must read the key transport.ts writes");

        let hello = plain_reply("/api/hello");
        assert!(hello.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(hello.contains(r#""bundle":"https""#), "an old client must see a new build and reload");

        for target in ["/api/rpc", "/api/events?token=secret", "/api/pair"] {
            let refused = plain_reply(target);
            assert!(refused.starts_with("HTTP/1.1 503 "), "{target}");
            assert!(!refused.contains("401"));
            assert!(!refused.contains("secret"), "nothing from the request is echoed back");
        }

        // A deep link, a manifest, an asset: all the handoff page, never the app over plaintext.
        assert!(plain_reply("/assets/index-a1b2.js").contains("cf-handoff"));
        assert!(plain_reply("/manifest.webmanifest").contains("cf-handoff"));
    }

    #[test]
    fn the_request_line_names_the_target() {
        assert_eq!(request_target(b"GET /api/hello HTTP/1.1\r\nHost: x\r\n\r\n").as_deref(), Some("/api/hello"));
        assert_eq!(request_target(b"").as_deref(), None);
        assert_eq!(request_target(b"\xff\xfe").as_deref(), None);
    }

    /// Accepts exactly the certificate whose fingerprint the desktop shows, and checks the handshake
    /// signatures against it — what the user does by eye, done by the test.
    #[derive(Debug)]
    struct Pinned {
        fingerprint: String,
        provider: Arc<rustls::crypto::CryptoProvider>,
    }

    impl ServerCertVerifier for Pinned {
        fn verify_server_cert(
            &self,
            end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            if fingerprint(end_entity) == self.fingerprint {
                Ok(ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::General("not the certificate the desktop shows".into()))
            }
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.provider.signature_verification_algorithms.supported_schemes()
        }
    }

    async fn roundtrip<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(stream: &mut S, path: &str) -> String {
        stream
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut bytes = Vec::new();
        // A peer that hangs up without `close_notify` is an error to rustls; what arrived before it is
        // still the response.
        let _ = stream.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// The whole path a phone takes: a TLS handshake against this certificate, an HTTP request through
    /// axum on the other side — and, on the same port, a plain request sent to the handoff.
    #[tokio::test]
    async fn the_listener_speaks_tls_and_still_answers_plain_http() {
        let dir = Scratch::new("listener");
        let identity = load_or_create(&dir.0).unwrap();
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listener = TlsListener::new(tcp, identity.server_config().unwrap()).unwrap();
        let addr = axum::serve::Listener::local_addr(&listener).unwrap();
        let app = axum::Router::new().route("/api/hello", axum::routing::get(|| async { "over tls" }));
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pinned { fingerprint: identity.fingerprint.clone(), provider }))
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
        let tcp = TcpStream::connect(addr).await.unwrap();
        let mut tls = connector.connect(ServerName::try_from("localhost").unwrap(), tcp).await.unwrap();
        let response = roundtrip(&mut tls, "/api/hello").await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.ends_with("over tls"), "{response}");

        let mut plain = TcpStream::connect(addr).await.unwrap();
        let refused = roundtrip(&mut plain, "/api/rpc").await;
        assert!(refused.starts_with("HTTP/1.1 503"), "{refused}");
        assert!(refused.contains("tls_required"));

        server.abort();
    }

    /// Dropping the listener — what stopping the server does — gives the port back promptly, so the
    /// rebind that turning TLS on or off performs finds it free.
    #[tokio::test]
    async fn dropping_the_listener_releases_the_port() {
        let dir = Scratch::new("release");
        let identity = load_or_create(&dir.0).unwrap();
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp.local_addr().unwrap();
        let listener = TlsListener::new(tcp, identity.server_config().unwrap()).unwrap();
        drop(listener);

        let mut rebound = None;
        for _ in 0..40 {
            match TcpListener::bind(addr).await {
                Ok(listener) => {
                    rebound = Some(listener);
                    break;
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
            }
        }
        assert!(rebound.is_some(), "the port was still held after the listener went away");
    }
}
