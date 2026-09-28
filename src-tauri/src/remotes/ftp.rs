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
//!
//! **A held control connection goes stale in the one way FTP is famous for**: the server closes it
//! after a few idle minutes and says `421` to nobody. So a connection unused for a minute is asked a
//! `NOOP` before it is trusted, and a `421` or a dead socket drops it — see [`super::pool`].

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use suppaftp::list::{File as FtpFile, ListParser};
use suppaftp::tokio::{AsyncRustlsConnector, AsyncRustlsFtpStream};
use suppaftp::types::FileType as TransferType;
use suppaftp::{FtpError, Mode, Status};
use tokio::sync::Mutex;

use super::files::{
    discard_partial_local, join, mode_string, new_parents, plan_upload, pump, sort_entries, Planned,
    RemoteFile, RemoteListing, TRANSFER_CANCELLED,
};
use super::pool::{local, step, Outcome, Pool, Retry};
use super::{RemoteHostSpec, RemoteKind};

/// One host's control connection.
///
/// Every operation takes `&mut` — FTP is a command/response protocol on one socket, and two
/// interleaved commands would read each other's replies. The `Mutex` is what makes "one session per
/// host" mean "one command at a time" as well.
struct Session {
    stream: Mutex<AsyncRustlsFtpStream>,
    /// When the connection last carried a command. See [`IDLE_PROBE`].
    used: std::sync::Mutex<Instant>,
}

impl Session {
    fn touch(&self) {
        if let Ok(mut used) = self.used.lock() {
            *used = Instant::now();
        }
    }

    fn idle(&self) -> Duration {
        self.used.lock().map(|used| used.elapsed()).unwrap_or(Duration::MAX)
    }
}

/// How long a control connection may sit unused before it is asked whether it is still there.
///
/// FTP servers close idle control connections — vsftpd after five minutes, many far sooner — and
/// say so with a `421` nobody reads until the next command. Past this, a `NOOP` goes first, so the
/// command the user actually asked for is sent on a connection known to be alive rather than being
/// the one that discovers it is not.
const IDLE_PROBE: Duration = Duration::from_secs(60);

fn pool() -> &'static Pool<Session> {
    static POOL: std::sync::OnceLock<Pool<Session>> = std::sync::OnceLock::new();
    POOL.get_or_init(Pool::default)
}

/// Runs `op` on this host's control connection, opening one if there isn't a live one. See
/// [`super::pool`] for what happens when it has died.
async fn with_session<T, F, FF>(host_id: &str, spec: &RemoteHostSpec, retry: Retry, op: F) -> Result<T, String>
where
    F: Fn(Arc<Session>) -> FF,
    FF: Future<Output = Outcome<T>>,
{
    pool()
        .run(
            host_id,
            || async move {
                let stream = connect(host_id, spec).await?;
                Ok(Session { stream: Mutex::new(stream), used: std::sync::Mutex::new(Instant::now()) })
            },
            |session| async move { alive(&session).await },
            retry,
            |session| {
                session.touch();
                op(session)
            },
        )
        .await
}

async fn alive(session: &Session) -> bool {
    if session.idle() < IDLE_PROBE {
        return true;
    }
    let answered = session.stream.lock().await.noop().await.is_ok();
    if answered {
        session.touch();
    }
    answered
}

/// Whether an FTP error means the control connection is gone.
///
/// The server refusing something — `550` no such file, `553` not allowed — is the server
/// answering, and the connection is fine. A socket error or TLS failure is not; nor is `421`, the
/// server saying it is closing the connection (an idle timeout, a restart). A reply that does not
/// parse, or a data connection the client still thinks is open, means client and server no longer
/// agree on where they are in the conversation — a connection that would answer every later command
/// with the previous command's reply.
fn lost(error: &FtpError) -> bool {
    match error {
        FtpError::ConnectionError(_)
        | FtpError::SecureError(_)
        | FtpError::BadResponse
        | FtpError::DataConnectionAlreadyOpen => true,
        FtpError::UnexpectedResponse(response) => response.status == Status::NotAvailable,
        _ => false,
    }
}

/// One FTP command, sorted into the three ways it can end.
fn attempt<T>(operation: &str, result: Result<T, FtpError>) -> Outcome<T> {
    Outcome::of(result, lost, |error| explain(operation, error))
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

/// Closes a host's file session. Idempotent — what disconnecting, deleting and editing all call.
///
/// `QUIT` is not sent: it needs the lock and a round trip on a socket that may already be dead,
/// and dropping the stream closes the connection either way. A server notices a closed control
/// connection perfectly well.
pub async fn close(host_id: &str) {
    pool().close(host_id).await;
}

/// Every host currently holding a control socket, for [`super::hold`] to report.
pub async fn open_hosts() -> Vec<String> {
    pool().hosts().await
}

/// Drops every host's control socket — the exit path's. See [`super::forward::close_all`] for why a
/// `static` map needs an explicit drain at all.
pub async fn close_all() {
    pool().close_all().await;
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
    with_session(host_id, spec, Retry::Once, |session| async move {
        let mut stream = session.stream.lock().await;
        let resolved = step!(resolve(&mut stream, path).await);
        let mut entries = step!(read_dir(&mut stream, &resolved).await);
        sort_entries(&mut entries);
        Outcome::Done(RemoteListing { path: resolved, entries, ..Default::default() })
    })
    .await
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
    let files = with_session(host_id, spec, Retry::Once, |session| async move {
        let mut stream = session.stream.lock().await;
        plan_download(&mut stream, remote_path, local_path).await
    })
    .await?;
    let files = &files;
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut stream = session.stream.lock().await;
        let total: u64 = files.iter().map(|file| file.size).sum();
        let mut done = 0u64;

        for (index, file) in files.iter().enumerate() {
            if let Some(parent) = std::path::Path::new(&file.local).parent() {
                step!(local(
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("Couldn't create {}: {e}", parent.display()))
                ));
            }
            // The local file first: once `RETR` has opened a data connection, failing here would
            // leave it open and the control connection a reply behind.
            let mut target = step!(local(
                tokio::fs::File::create(&file.local)
                    .await
                    .map_err(|e| format!("Couldn't write {}: {e}", file.local))
            ));
            let mut source = match stream.retr_as_stream(&file.remote).await {
                Ok(source) => source,
                Err(error) => {
                    drop(target);
                    let _ = tokio::fs::remove_file(&file.local).await;
                    return attempt(&format!("open {}", file.remote), Err(error));
                }
            };
            let copied =
                pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
                    .await;
            if let Err(error) = copied {
                drop(target);
                discard_partial_local(&file.local, &error).await;
                // `ABOR`, so the server stops sending and says so on the control connection — which
                // is read here, leaving the next command to read its own reply. A connection that
                // could not be brought back in step is dropped instead.
                let in_step = stream.abort(source).await.is_ok();
                return if error == TRANSFER_CANCELLED && in_step {
                    Outcome::Failed(error)
                } else {
                    Outcome::Lost(error)
                };
            }
            // Mandatory, not tidiness: the server sends its final reply only once the data
            // connection closes, and skipping this leaves that reply unread in front of the next
            // command's.
            step!(attempt(&format!("finish {}", file.remote), stream.finalize_retr_stream(source).await));
        }
        Outcome::Done(())
    })
    .await
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
    let files = plan_upload(local_path, remote_path)?;
    let files = &files;
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut stream = session.stream.lock().await;
        let total: u64 = files.iter().map(|file| file.size).sum();
        let mut done = 0u64;
        let mut made = std::collections::HashSet::new();

        for (index, file) in files.iter().enumerate() {
            // Every missing directory between the transfer's root and this file, outermost first;
            // an existing one is not an error — an interrupted transfer resumed by re-running it
            // must not fail on its own leftovers.
            for dir in new_parents(remote_path, &file.remote, &mut made) {
                let _ = stream.mkdir(&dir).await;
            }
            let mut source = step!(local(
                tokio::fs::File::open(&file.local)
                    .await
                    .map_err(|e| format!("Couldn't read {}: {e}", file.local))
            ));
            let mut target = step!(attempt(&format!("create {}", file.remote), stream.put_with_stream(&file.remote).await));
            let copied =
                pump(app, id, &mut source, &mut target, &file.name, &mut done, total, index as u64, files.len() as u64)
                    .await;
            if let Err(error) = copied {
                // Closing the data connection ends the upload where it stands; the server reports
                // that on the control connection, and reading it keeps the next reply the next
                // command's. A cancelled upload then leaves nothing behind — a file cut short under
                // the real name is indistinguishable from a finished one.
                return match stream.finalize_put_stream(target).await {
                    Ok(()) => {
                        if error == TRANSFER_CANCELLED {
                            let _ = stream.rm(&file.remote).await;
                        }
                        Outcome::Failed(error)
                    }
                    Err(_) => Outcome::Lost(error),
                };
            }
            // Same reason as the download side, plus one: this is what flushes and shuts the data
            // socket, and without it a truncated upload would look like a finished one.
            step!(attempt(&format!("finish {}", file.remote), stream.finalize_put_stream(target).await));
        }
        Outcome::Done(())
    })
    .await
}

pub async fn make_dir(host_id: &str, spec: &RemoteHostSpec, path: &str) -> Result<(), String> {
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut stream = session.stream.lock().await;
        attempt(&format!("create {path}"), stream.mkdir(path).await)
    })
    .await
}

/// Deletes a file or an empty directory. Not recursive, for the reason [`super::files::remove`]
/// gives.
pub async fn remove(
    host_id: &str,
    spec: &RemoteHostSpec,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut stream = session.stream.lock().await;
        let operation = format!("remove {path}");
        if is_dir {
            attempt(&operation, stream.rmdir(path).await)
        } else {
            attempt(&operation, stream.rm(path).await)
        }
    })
    .await
}

pub async fn rename(
    host_id: &str,
    spec: &RemoteHostSpec,
    from: &str,
    to: &str,
) -> Result<(), String> {
    with_session(host_id, spec, Retry::Never, |session| async move {
        let mut stream = session.stream.lock().await;
        attempt(&format!("rename {from}"), stream.rename(from, to).await)
    })
    .await
}

// ---------------------------------------------------------------------------
// Paths and listings
// ---------------------------------------------------------------------------

/// The absolute form of `path`, by going there and asking where we are.
///
/// FTP has no `realpath`, so `CWD` then `PWD` *is* the canonicalization — and it validates the path
/// on the way, since a `CWD` into something that isn't a directory fails. The moved working
/// directory is not a side effect to undo: browsing is exactly what the caller is doing.
async fn resolve(stream: &mut AsyncRustlsFtpStream, path: &str) -> Outcome<String> {
    let target = path.trim();
    if !target.is_empty() {
        step!(attempt(&format!("open {target}"), stream.cwd(target).await));
    }
    attempt("read the current directory", stream.pwd().await)
}

/// One directory's entries, absolute paths and all.
///
/// `MLSD` first because it is specified and unambiguous; `LIST` after, because plenty of servers
/// still don't implement `MLSD`. Both are parsed leniently — see the module header.
async fn read_dir(stream: &mut AsyncRustlsFtpStream, dir: &str) -> Outcome<Vec<RemoteFile>> {
    match stream.mlsd(Some(dir)).await {
        Ok(lines) => {
            return Outcome::Done(
                lines
                    .iter()
                    .filter_map(|line| ListParser::parse_mlsd(line).ok().map(|file| (file, line.as_str())))
                    // `.` and `..` come back as type=cdir/pdir and are already the breadcrumb's job.
                    .filter(|(file, _)| file.name() != "." && file.name() != "..")
                    .map(|(file, line)| entry(dir, &file, mlsd_permissions(&file, line)))
                    .collect(),
            )
        }
        // No `MLSD` is a server that predates it; a connection that died answering it is not a
        // reason to try `LIST` on the same dead socket.
        Err(error) if lost(&error) => return Outcome::Lost(explain(&format!("read {dir}"), error)),
        Err(_) => {}
    }

    let lines = step!(attempt(&format!("read {dir}"), stream.list(Some(dir)).await));
    Outcome::Done(
        lines
            .iter()
            .filter_map(|line| line.parse::<FtpFile>().ok())
            .filter(|file| file.name() != "." && file.name() != "..")
            .map(|file| {
                let permissions = posix_permissions(&file);
                entry(dir, &file, permissions)
            })
            .collect(),
    )
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
) -> Outcome<Vec<Planned>> {
    // Whether this is a directory, asked the only way FTP answers: try to enter it. Success also
    // hands back the absolute path, which is what the walk below needs.
    match stream.cwd(remote_path).await {
        Ok(()) => {}
        Err(error) if lost(&error) => return Outcome::Lost(explain(&format!("open {remote_path}"), error)),
        Err(_) => {
            let name = remote_path.rsplit('/').next().unwrap_or(remote_path).to_string();
            let size = stream.size(remote_path).await.unwrap_or(0) as u64;
            return Outcome::Done(vec![Planned {
                remote: remote_path.to_string(),
                local: local_path.to_string(),
                name,
                size,
            }]);
        }
    }
    let root = step!(attempt("read the current directory", stream.pwd().await));

    let mut planned = Vec::new();
    let mut queue = vec![(root, local_path.to_string())];
    while let Some((dir, into)) = queue.pop() {
        for file in step!(read_dir(stream, &dir).await) {
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
    Outcome::Done(planned)
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

    /// A refusal is the server answering; a dead socket, a closing `421` or a conversation that has
    /// lost its place is a connection to drop.
    #[test]
    fn only_a_connection_that_is_gone_is_dropped() {
        let reply = |status| FtpError::UnexpectedResponse(suppaftp::types::Response { status, body: Vec::new() });
        assert!(!lost(&reply(Status::FileUnavailable)), "550 is an answer");
        assert!(lost(&reply(Status::NotAvailable)), "421 is the server hanging up");
        assert!(lost(&FtpError::ConnectionError(std::io::Error::from(std::io::ErrorKind::BrokenPipe))));
        assert!(lost(&FtpError::BadResponse));
        assert!(lost(&FtpError::DataConnectionAlreadyOpen));
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
