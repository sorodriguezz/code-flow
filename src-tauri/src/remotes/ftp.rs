//! Files on the far side: FTP and FTPS.
//!
//! **This is the module's one exception, and it is a deliberate one.** Everywhere else in
//! [`super`], the transport is the user's own `ssh` — see that module's header for why. FTP has no
//! `ssh` to borrow: it is a different protocol on a socket of its own, so this is the one file
//! here that opens a connection itself.
//!
//! The exception is contained by making it *visible* rather than clever. A host declares its
//! [`RemoteKind`], the kind decides which capabilities exist ([`RemoteKind::has_shell`] and
//! friends), and an FTP host therefore never reaches a code path that would have spawned `ssh` —
//! there is no shell to open, no forward to raise and no screen to tunnel, because the type says
//! so. What is left is files, which is all FTP ever offered.
//!
//! **One stream type for all three modes.** Plain FTP, explicit FTPS (`AUTH TLS` on port 21) and
//! implicit FTPS (TLS from the first byte, port 990) are the same `AsyncRustlsFtpStream` here.
//! `suppaftp` starts that type unencrypted and upgrades in place, so the alternative — a plain
//! type and a TLS type — would be an enum wrapper duplicating every method for no gain.
//!
//! **Listing is the part with no standard.** FTP never specified what `LIST` returns, so servers
//! answer in `ls -l`'s shape, in DOS's shape, or in something else. `MLSD` (RFC 3659) is the
//! machine-readable answer and is tried first; `LIST` is the fallback, parsed heuristically. A line
//! neither one can parse is skipped rather than failed on — one unreadable entry must not cost the
//! user the other two hundred.

use std::collections::HashMap;
use std::sync::Arc;

use suppaftp::list::{File as FtpFile, ListParser};
use suppaftp::tokio::{AsyncRustlsConnector, AsyncRustlsFtpStream};
use suppaftp::types::FileType as TransferType;
use suppaftp::{FtpError, Mode};
use tokio::sync::Mutex;

use super::files::{join, mode_string, plan_upload, pump, sort_entries, Planned, RemoteFile, RemoteListing};
use super::{RemoteHostSpec, RemoteKind};

/// Every operation takes `&mut` — FTP is a command/response protocol on one socket, and two
/// interleaved commands would read each other's replies. The `Mutex` is what makes "one session per
/// host" mean "one command at a time" as well.
type Sessions = Mutex<HashMap<String, Arc<Mutex<AsyncRustlsFtpStream>>>>;

fn sessions() -> &'static Sessions {
    static SESSIONS: std::sync::OnceLock<Sessions> = std::sync::OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The session for this host, opening one if there isn't a live one.
async fn session(
    host_id: &str,
    spec: &RemoteHostSpec,
) -> Result<Arc<Mutex<AsyncRustlsFtpStream>>, String> {
    if let Some(existing) = sessions().lock().await.get(host_id).cloned() {
        return Ok(existing);
    }
    let opened = Arc::new(Mutex::new(connect(host_id, spec).await?));
    sessions().lock().await.insert(host_id.to_string(), opened.clone());
    Ok(opened)
}

async fn connect(host_id: &str, spec: &RemoteHostSpec) -> Result<AsyncRustlsFtpStream, String> {
    spec.require_host()?;

    let host = spec.host.trim();
    let address = format!("{host}:{}", spec.effective_port());
    let secure = spec.kind == RemoteKind::Ftps;

    let mut stream = if secure && spec.ftp.implicit_tls {
        // Implicit FTPS: TLS before a byte of FTP is spoken. Deprecated by RFC and still what a
        // decade-old appliance answers on 990.
        AsyncRustlsFtpStream::connect_secure_implicit(
            &address,
            connector(spec)?,
            host,
        )
        .await
        .map_err(|e| explain(&format!("connect to {address} over FTPS"), e))?
    } else {
        let stream = AsyncRustlsFtpStream::connect(&address)
            .await
            .map_err(|e| explain(&format!("connect to {address}"), e))?;
        if secure {
            // Explicit FTPS: `AUTH TLS` on the control connection, then PBSZ/PROT so the *data*
            // connection is encrypted too. `into_secure` sends both — without them the login would
            // be private and every file would still cross in the clear.
            stream
                .into_secure(connector(spec)?, host)
                .await
                .map_err(|e| explain(&format!("start TLS on {address}"), e))?
        } else {
            stream
        }
    };

    // Passive by default, and it matters: active mode asks the *server* to open a connection back
    // to this machine, which any NAT or local firewall between them will drop.
    stream.set_mode(if spec.ftp.passive { Mode::Passive } else { Mode::Active });

    let (user, password) = credentials(host_id, spec)?;
    stream
        .login(&user, &password)
        .await
        .map_err(|e| explain(&format!("log in to {host} as {user}"), e))?;

    // Binary, always. The default is ASCII, which rewrites line endings in transit — invisible on a
    // text file and fatal to every other kind.
    stream
        .transfer_type(TransferType::Binary)
        .await
        .map_err(|e| explain("switch to binary mode", e))?;

    Ok(stream)
}

/// Who to log in as. Anonymous is a real mode rather than a blank password: servers that offer it
/// want the literal user `anonymous`, and conventionally an email-shaped string as the password.
fn credentials(host_id: &str, spec: &RemoteHostSpec) -> Result<(String, String), String> {
    if spec.ftp.anonymous {
        return Ok(("anonymous".into(), "anonymous@".into()));
    }
    let user = match spec.user.trim() {
        "" => "anonymous".to_string(),
        named => named.to_string(),
    };
    // Same keychain entry an SSH host's password uses — keyed by host id, so a row that changes
    // kind keeps the credential the user already saved against it.
    let password = crate::secrets::get_secret(&super::password_key(host_id))
        .unwrap_or_default()
        .unwrap_or_default();
    Ok((user, password))
}

/// The TLS connector, built on the same `ring` provider every other TLS caller in this binary
/// resolves — see `Cargo.toml`'s note on why a second crypto provider is not an option.
fn connector(spec: &RemoteHostSpec) -> Result<AsyncRustlsConnector, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = if spec.ftp.accept_invalid_certs {
        rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
            .with_no_client_auth()
    } else {
        let mut roots = rustls::RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth()
    };
    Ok(AsyncRustlsConnector::from(tokio_rustls::TlsConnector::from(Arc::new(config))))
}

/// Closes a host's file session. Idempotent — what disconnecting and deleting both call.
///
/// `QUIT` is not sent: it needs the lock and a round trip on a socket that may already be dead,
/// and dropping the stream closes the connection either way. A server notices a closed control
/// connection perfectly well.
pub async fn close(host_id: &str) {
    sessions().lock().await.remove(host_id);
}

// ---------------------------------------------------------------------------
// The seven verbs
// ---------------------------------------------------------------------------

/// Lists a directory. An empty `path` means wherever the login left us, which is where a browser
/// should open.
pub async fn list(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
) -> Result<RemoteListing, String> {
    let session = session(host_id, spec).await?;
    let mut stream = session.lock().await;

    let resolved = resolve(&mut stream, path).await?;
    let mut entries = read_dir(&mut stream, &resolved).await?;
    sort_entries(&mut entries);

    Ok(RemoteListing { path: resolved, entries, ..Default::default() })
}

/// One file or one whole directory, from the far side to here.
pub async fn download(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let mut stream = session.lock().await;

    let files = plan_download(&mut stream, remote_path, local_path).await?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        if let Some(parent) = std::path::Path::new(&file.local).parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))?;
        }
        let mut source = stream
            .retr_as_stream(&file.remote)
            .await
            .map_err(|e| explain(&format!("open {}", file.remote), e))?;
        let mut target = tokio::fs::File::create(&file.local)
            .await
            .map_err(|e| format!("Couldn't write {}: {e}", file.local))?;
        pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
            .await?;
        // Mandatory, not tidiness: the server sends its final reply only once the data connection
        // closes, and skipping this leaves that reply unread in front of the next command's.
        stream
            .finalize_retr_stream(source)
            .await
            .map_err(|e| explain(&format!("finish {}", file.remote), e))?;
    }
    Ok(())
}

/// One file or one whole directory, from here to the far side.
pub async fn upload(
    app: &tauri::AppHandle,
    id: &str,
    host_id: &str,
    spec: &RemoteHostSpec,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let mut stream = session.lock().await;

    let files = plan_upload(local_path, remote_path)?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    let mut done = 0u64;

    for (index, file) in files.iter().enumerate() {
        // Created before the file that goes in it, and an existing directory is not an error — an
        // interrupted transfer resumed by re-running it must not fail on its own leftovers.
        if let Some((parent, _)) = file.remote.rsplit_once('/') {
            if !parent.is_empty() {
                let _ = stream.mkdir(parent).await;
            }
        }
        let mut source = tokio::fs::File::open(&file.local)
            .await
            .map_err(|e| format!("Couldn't read {}: {e}", file.local))?;
        let mut target = stream
            .put_with_stream(&file.remote)
            .await
            .map_err(|e| explain(&format!("create {}", file.remote), e))?;
        pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
            .await?;
        // Same reason as the download side, plus one: this is what flushes and shuts the data
        // socket, and without it a truncated upload would look like a finished one.
        stream
            .finalize_put_stream(target)
            .await
            .map_err(|e| explain(&format!("finish {}", file.remote), e))?;
    }
    Ok(())
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let mut stream = session.lock().await;
    stream.mkdir(path).await.map_err(|e| explain(&format!("create {path}"), e))
}

/// Deletes a file or an empty directory. Not recursive, for the reason [`super::files::remove`]
/// gives.
pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let mut stream = session.lock().await;
    if is_dir {
        stream.rmdir(path).await.map_err(|e| explain(&format!("remove {path}"), e))
    } else {
        stream.rm(path).await.map_err(|e| explain(&format!("remove {path}"), e))
    }
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let session = session(host_id, spec).await?;
    let mut stream = session.lock().await;
    stream.rename(from, to).await.map_err(|e| explain(&format!("rename {from}"), e))
}

// ---------------------------------------------------------------------------
// Paths and listings
// ---------------------------------------------------------------------------

/// The absolute form of `path`, by going there and asking where we are.
///
/// FTP has no `realpath`, so `CWD` then `PWD` *is* the canonicalization — and it validates the path
/// on the way, since a `CWD` into something that isn't a directory fails. The moved working
/// directory is not a side effect to undo: browsing is exactly what the caller is doing.
async fn resolve(stream: &mut AsyncRustlsFtpStream, path: &str) -> Result<String, String> {
    let target = path.trim();
    if !target.is_empty() {
        stream.cwd(target).await.map_err(|e| explain(&format!("open {target}"), e))?;
    }
    stream.pwd().await.map_err(|e| explain("read the current directory", e))
}

/// One directory's entries, absolute paths and all.
///
/// `MLSD` first because it is specified and unambiguous; `LIST` after, because plenty of servers
/// still don't implement `MLSD`. Both are parsed leniently — see the module header.
async fn read_dir(
    stream: &mut AsyncRustlsFtpStream,
    dir: &str,
) -> Result<Vec<RemoteFile>, String> {
    if let Ok(lines) = stream.mlsd(Some(dir)).await {
        return Ok(lines
            .iter()
            .filter_map(|line| ListParser::parse_mlsd(line).ok().map(|file| (file, line.as_str())))
            // `.` and `..` come back as type=cdir/pdir and are already the breadcrumb's job.
            .filter(|(file, _)| file.name() != "." && file.name() != "..")
            .map(|(file, line)| entry(dir, &file, mlsd_permissions(&file, line)))
            .collect());
    }

    let lines = stream
        .list(Some(dir))
        .await
        .map_err(|e| explain(&format!("read {dir}"), e))?;
    Ok(lines
        .iter()
        .filter_map(|line| line.parse::<FtpFile>().ok())
        .filter(|file| file.name() != "." && file.name() != "..")
        .map(|file| {
            let permissions = posix_permissions(&file);
            entry(dir, &file, permissions)
        })
        .collect())
}

/// One parsed line as the frontend's entry shape.
fn entry(dir: &str, file: &FtpFile, permissions: String) -> RemoteFile {
    let name = file.name().to_string();
    RemoteFile {
        path: join(dir, &name),
        is_dir: file.is_directory(),
        is_link: file.is_symlink(),
        size: file.size() as u64,
        modified: file
            .modified()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        permissions,
        name,
        ..Default::default()
    }
}

/// The `drwxr-xr-x` string for a `LIST` entry, whose permissions were in the line itself.
fn posix_permissions(file: &FtpFile) -> String {
    use suppaftp::list::PosixPexQuery::{Group, Others, Owner};
    let mut mode = 0u32;
    for (index, who) in [Owner, Group, Others].into_iter().enumerate() {
        let shift = 6 - index as u32 * 3;
        if file.can_read(who) {
            mode |= 4 << shift;
        }
        if file.can_write(who) {
            mode |= 2 << shift;
        }
        if file.can_execute(who) {
            mode |= 1 << shift;
        }
    }
    mode_string(kind_char(file), mode)
}

/// The same for an `MLSD` entry — but only when the server actually sent `UNIX.mode`.
///
/// The parser defaults a missing mode to `0o777`, which would render as `rwxrwxrwx` on every entry
/// from every server that omits the fact. An empty string is the honest answer: the column simply
/// stays blank rather than claiming a permission nobody reported.
fn mlsd_permissions(file: &FtpFile, line: &str) -> String {
    if !line.to_lowercase().contains("unix.mode=") {
        return String::new();
    }
    posix_permissions(file)
}

fn kind_char(file: &FtpFile) -> char {
    if file.is_directory() {
        'd'
    } else if file.is_symlink() {
        'l'
    } else {
        '-'
    }
}

/// Walks the far side, collecting every file under `remote_path`.
///
/// Iterative rather than recursive for the reason the SFTP side gives: `async fn` recursion needs
/// boxing, and a deep tree would be a stack of futures. Symlinks are fetched as whatever they point
/// at and never descended into, which is what stops a link back to `/` becoming an infinite walk.
async fn plan_download(
    stream: &mut AsyncRustlsFtpStream,
    remote_path: &str,
    local_path: &str,
) -> Result<Vec<Planned>, String> {
    // Whether this is a directory, asked the only way FTP answers: try to enter it. Success also
    // hands back the absolute path, which is what the walk below needs.
    let entered = stream.cwd(remote_path).await.is_ok();
    if !entered {
        let name = remote_path.rsplit('/').next().unwrap_or(remote_path).to_string();
        let size = stream.size(remote_path).await.unwrap_or(0) as u64;
        return Ok(vec![Planned {
            remote: remote_path.to_string(),
            local: local_path.to_string(),
            name,
            size,
        }]);
    }
    let root = stream.pwd().await.map_err(|e| explain("read the current directory", e))?;

    let mut planned = Vec::new();
    let mut queue = vec![(root, local_path.to_string())];
    while let Some((dir, into)) = queue.pop() {
        for file in read_dir(stream, &dir).await? {
            let local = format!("{into}{}{}", std::path::MAIN_SEPARATOR, file.name);
            if file.is_dir {
                queue.push((file.path, local));
            } else {
                planned.push(Planned {
                    remote: file.path,
                    local,
                    name: file.name,
                    size: file.size,
                });
            }
        }
    }
    Ok(planned)
}

/// Puts the operation in front of the server's reply, so the message names what was being attempted
/// rather than only what the server thought of it.
fn explain(operation: &str, error: FtpError) -> String {
    format!("Couldn't {operation}: {error}")
}

/// Reachable only when the host asked to accept any certificate.
#[derive(Debug)]
struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: RemoteKind) -> RemoteHostSpec {
        RemoteHostSpec { kind, host: "files.example.com".into(), ..Default::default() }
    }

    #[test]
    fn a_plain_ftp_host_defaults_to_21_and_ftps_to_21_or_990() {
        assert_eq!(spec(RemoteKind::Ftp).effective_port(), 21);
        // Explicit FTPS upgrades in place, so it stays on the control port.
        assert_eq!(spec(RemoteKind::Ftps).effective_port(), 21);

        let mut implicit = spec(RemoteKind::Ftps);
        implicit.ftp.implicit_tls = true;
        assert_eq!(implicit.effective_port(), 990);

        // An explicit port always wins over the protocol's default.
        let mut named = spec(RemoteKind::Ftp);
        named.port = 2121;
        assert_eq!(named.effective_port(), 2121);
    }

    #[test]
    fn anonymous_ignores_whatever_user_the_host_carries() {
        let mut anon = spec(RemoteKind::Ftp);
        anon.user = "sam".into();
        anon.ftp.anonymous = true;
        let (user, password) = credentials("host-1", &anon).unwrap();
        assert_eq!(user, "anonymous");
        assert!(!password.is_empty(), "servers expect a non-empty anonymous password");
    }

    /// A host with no user named is the anonymous case in everything but the checkbox — which is
    /// what an FTP client is expected to do, and what a blank `USER` would not achieve.
    #[test]
    fn an_unnamed_user_falls_back_to_anonymous_rather_than_sending_an_empty_one() {
        let (user, _) = credentials("host-2", &spec(RemoteKind::Ftp)).unwrap();
        assert_eq!(user, "anonymous");
    }

    #[test]
    fn a_posix_list_line_becomes_the_entry_the_browser_draws() {
        let file: FtpFile = "-rw-r--r-- 1 sam staff 1234 Nov 5 13:46 notes.txt".parse().unwrap();
        let entry = entry("/srv", &file, posix_permissions(&file));
        assert_eq!(entry.name, "notes.txt");
        assert_eq!(entry.path, "/srv/notes.txt");
        assert_eq!(entry.size, 1234);
        assert!(!entry.is_dir);
        assert_eq!(entry.permissions, "-rw-r--r--");
    }

    #[test]
    fn a_directory_list_line_is_marked_as_one() {
        let file: FtpFile = "drwxr-xr-x 2 sam staff 4096 Nov 5 13:46 uploads".parse().unwrap();
        let entry = entry("/srv", &file, posix_permissions(&file));
        assert!(entry.is_dir);
        assert_eq!(entry.permissions, "drwxr-xr-x");
        assert_eq!(entry.path, "/srv/uploads");
    }

    /// The fabrication guard: `MLSD` without `UNIX.mode` must not render the parser's 0o777
    /// placeholder as though the server had reported it.
    #[test]
    fn an_mlsd_entry_without_a_mode_reports_no_permissions_rather_than_inventing_them() {
        let line = "type=file;size=42;modify=20240118120000; report.pdf";
        let file = ListParser::parse_mlsd(line).unwrap();
        assert_eq!(mlsd_permissions(&file, line), "");

        let with_mode = "type=dir;size=0;modify=20240118120000;UNIX.mode=0755; logs";
        let file = ListParser::parse_mlsd(with_mode).unwrap();
        assert_eq!(mlsd_permissions(&file, with_mode), "drwxr-xr-x");
    }

    #[test]
    fn an_mlsd_entry_carries_its_size_and_type_across() {
        let line = "type=file;size=42;modify=20240118120000; report.pdf";
        let file = ListParser::parse_mlsd(line).unwrap();
        let entry = entry("/pub", &file, String::new());
        assert_eq!(entry.name, "report.pdf");
        assert_eq!(entry.path, "/pub/report.pdf");
        assert_eq!(entry.size, 42);
        assert!(!entry.is_dir);
    }
}
