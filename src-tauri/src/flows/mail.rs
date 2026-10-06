//! Incoming mail over IMAP — what the "Correo entrante" trigger watches and the IMAP node reads.
//!
//! **An `imap` credential** holds the server, port, security and user; the password (an app
//! password, for Gmail or Outlook with two-step sign-in) is the keychain secret, as for SMTP.
//!
//! **By UID, peeking.** Messages are found with `UID SEARCH` and read with `BODY.PEEK[]`, so
//! reading one never marks it read by itself — that is an explicit step (the node's option, or its
//! "mark as read" operation). The parsed message is what an automation reads: sender, recipients,
//! subject, date, the plain and HTML bodies, and the attachments, saved to a folder when one is
//! named.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::TryStreamExt;
use mail_parser::{MessageParser, MimeHeaders};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

/// A connection either encrypted or not, behind one type the client takes.
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + std::fmt::Debug> Io for T {}

pub type Session = async_imap::Session<Box<dyn Io>>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Where an IMAP credential signs in.
#[derive(Debug, Clone)]
pub struct Account {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// `tls` (993), `starttls` (143, upgraded) or `none`.
    pub security: String,
}

impl Account {
    pub fn of(meta: &Value, secret: String) -> Result<Account, String> {
        let field = |key: &str| meta.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let host = field("host");
        if host.is_empty() {
            return Err("The IMAP credential has no server".into());
        }
        let security = match field("security").as_str() {
            "starttls" => "starttls",
            "none" => "none",
            _ => "tls",
        }
        .to_string();
        let port = field("port").parse::<u16>().ok().unwrap_or(if security == "tls" { 993 } else { 143 });
        Ok(Account { host, port, user: field("user"), password: secret, security })
    }
}

fn tls_connector() -> tokio_rustls::TlsConnector {
    let mut roots = rustls::RootCertStore::empty();
    for certificate in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(certificate);
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

async fn encrypt(host: &str, stream: TcpStream) -> Result<Box<dyn Io>, String> {
    let name = rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|e| format!("\"{host}\" is not a server name: {e}"))?;
    let tls = tls_connector().connect(name, stream).await.map_err(|e| format!("{host}: the TLS handshake failed: {e}"))?;
    Ok(Box::new(tls))
}

/// Connects and signs in.
pub async fn open(account: &Account) -> Result<Session, String> {
    let work = async {
        let tcp = TcpStream::connect((account.host.as_str(), account.port)).await.map_err(|e| format!("{}:{}: {e}", account.host, account.port))?;
        let stream: Box<dyn Io> = match account.security.as_str() {
            "tls" => encrypt(&account.host, tcp).await?,
            "starttls" => {
                let mut plain = async_imap::Client::new(tcp);
                plain.read_response().await.map_err(|e| e.to_string())?.ok_or("The server closed the connection before greeting")?;
                plain.run_command_and_check_ok("STARTTLS", None).await.map_err(|e| format!("STARTTLS was refused: {e}"))?;
                encrypt(&account.host, plain.into_inner()).await?
            }
            _ => Box::new(tcp),
        };
        let mut client = async_imap::Client::new(stream);
        // No greeting after STARTTLS: the next thing on the wire is the login.
        if account.security != "starttls" {
            client.read_response().await.map_err(|e| e.to_string())?.ok_or("The server closed the connection before greeting")?;
        }
        client.login(&account.user, &account.password).await.map_err(|(e, _)| format!("{} refused the sign-in: {e}", account.host))
    };
    tokio::time::timeout(CONNECT_TIMEOUT, work).await.map_err(|_| format!("{} did not answer in {} s", account.host, CONNECT_TIMEOUT.as_secs()))?
}

/// A mailbox to select — `INBOX` when none is named. The client quotes it; a line break is the one
/// thing that could not be quoted into a single command.
pub fn mailbox_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let name = if name.is_empty() { "INBOX" } else { name };
    if name.contains(['\r', '\n']) {
        return Err(format!("\"{name}\" is not a mailbox name"));
    }
    Ok(name.to_string())
}

/// The criteria of `UID SEARCH`: what the person wrote (`UNSEEN FROM "a@example.com"`), or all.
pub fn criteria(raw: &str) -> Result<String, String> {
    let criteria = raw.trim();
    if criteria.contains(['\r', '\n']) {
        return Err("The search criteria are one line".into());
    }
    Ok(if criteria.is_empty() { "ALL".into() } else { criteria.to_string() })
}

/// UIDs matching `criteria` in the selected mailbox, oldest first.
pub async fn search(session: &mut Session, criteria: &str) -> Result<Vec<u32>, String> {
    let mut uids: Vec<u32> = session.uid_search(criteria).await.map_err(|e| format!("The search failed: {e}"))?.into_iter().collect();
    uids.sort_unstable();
    Ok(uids)
}

/// The raw messages of `uids`, without marking them read.
pub async fn fetch(session: &mut Session, uids: &[u32]) -> Result<Vec<(u32, Vec<u8>, Vec<String>)>, String> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let fetched: Vec<_> = session
        .uid_fetch(&set, "(UID FLAGS BODY.PEEK[])")
        .await
        .map_err(|e| format!("Reading the messages failed: {e}"))?
        .try_collect()
        .await
        .map_err(|e| format!("Reading the messages failed: {e}"))?;
    let mut out: Vec<(u32, Vec<u8>, Vec<String>)> = fetched
        .iter()
        .filter_map(|message| {
            let uid = message.uid?;
            let flags = message.flags().map(|flag| format!("{flag:?}")).collect();
            Some((uid, message.body()?.to_vec(), flags))
        })
        .collect();
    out.sort_by_key(|(uid, _, _)| *uid);
    Ok(out)
}

/// Adds `\Seen` to `uids`.
pub async fn mark_read(session: &mut Session, uids: &[u32]) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let _: Vec<_> = session
        .uid_store(&set, "+FLAGS.SILENT (\\Seen)")
        .await
        .map_err(|e| format!("Marking as read failed: {e}"))?
        .try_collect()
        .await
        .map_err(|e| format!("Marking as read failed: {e}"))?;
    Ok(())
}

/// Moves `uids` to another mailbox.
pub async fn move_to(session: &mut Session, uids: &[u32], mailbox: &str) -> Result<(), String> {
    if uids.is_empty() {
        return Ok(());
    }
    let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let target = mailbox.trim();
    if target.is_empty() || target.contains(['\r', '\n']) {
        return Err(format!("\"{target}\" is not a mailbox name"));
    }
    if let Err(first) = session.uid_mv(&set, target).await {
        // The folder may not exist yet: made, then tried once more.
        if session.create(target).await.is_ok() {
            return session.uid_mv(&set, target).await.map_err(|e| format!("Moving to {target} failed: {e}"));
        }
        return Err(format!("Moving to {target} failed: {first}"));
    }
    Ok(())
}

fn addresses(address: Option<&mail_parser::Address<'_>>) -> Vec<Value> {
    address
        .map(|list| {
            list.iter()
                .map(|addr| json!({"name": addr.name().unwrap_or_default(), "address": addr.address().unwrap_or_default()}))
                .collect()
        })
        .unwrap_or_default()
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() { "attachment".into() } else { trimmed }
}

/// One raw message as an item; attachments are written to `folder` when given (never over an
/// existing file).
pub fn read(uid: u32, raw: &[u8], flags: &[String], mailbox: &str, folder: Option<&Path>) -> Result<Value, String> {
    let message = MessageParser::default().parse(raw).ok_or("The message could not be read")?;
    let first = |list: Option<&mail_parser::Address<'_>>| {
        list.and_then(|a| a.first()).map(|a| a.address().unwrap_or_default().to_string()).unwrap_or_default()
    };
    let mut attachments = Vec::new();
    for part in message.attachments() {
        let name = part.attachment_name().unwrap_or("attachment").to_string();
        let mime = part
            .content_type()
            .map(|ct| match ct.subtype() {
                Some(sub) => format!("{}/{sub}", ct.ctype()),
                None => ct.ctype().to_string(),
            })
            .unwrap_or_default();
        let bytes = part.contents();
        let mut entry = json!({"name": name, "mimeType": mime, "size": bytes.len()});
        if let Some(folder) = folder {
            std::fs::create_dir_all(folder).map_err(|e| format!("Could not create {}: {e}", folder.display()))?;
            let file = safe_file_name(&name);
            let mut path = folder.join(&file);
            let mut n = 2;
            while path.exists() {
                let stem = Path::new(&file).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| file.clone());
                let extension = Path::new(&file).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                path = folder.join(format!("{stem} ({n}){extension}"));
                n += 1;
            }
            std::fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
            entry["path"] = json!(path.to_string_lossy());
        }
        attachments.push(entry);
    }
    Ok(json!({
        "uid": uid,
        "mailbox": mailbox,
        "messageId": message.message_id(),
        "from": first(message.from()),
        "fromName": message.from().and_then(|a| a.first()).and_then(|a| a.name()).unwrap_or_default(),
        "to": addresses(message.to()),
        "cc": addresses(message.cc()),
        "replyTo": first(message.reply_to()),
        "subject": message.subject().unwrap_or_default(),
        "date": message.date().map(|d| d.to_rfc3339()),
        "text": message.body_text(0).map(|t| t.into_owned()).unwrap_or_default(),
        "html": message.body_html(0).map(|t| t.into_owned()).unwrap_or_default(),
        "unread": !flags.iter().any(|f| f.contains("Seen")),
        "attachments": attachments,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "From: Ana <ana@example.com>\r\nTo: equipo@example.com, Bruno <bruno@example.com>\r\nSubject: Factura =?UTF-8?Q?octubre?=\r\nDate: Mon, 05 Oct 2026 09:30:00 -0300\r\nMessage-ID: <m1@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHola, va la factura.\r\n--b1\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"../factura.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b1--\r\n";

    #[test]
    fn a_message_reads_as_its_people_text_and_attachments() {
        let folder = std::env::temp_dir().join(format!("cf-mail-{}", uuid::Uuid::new_v4()));
        let item = read(42, RAW.as_bytes(), &["Seen".into()], "INBOX", Some(&folder)).unwrap();
        assert_eq!((item["uid"].as_u64(), item["from"].as_str(), item["fromName"].as_str()), (Some(42), Some("ana@example.com"), Some("Ana")));
        assert_eq!(item["to"][1]["address"], "bruno@example.com");
        assert_eq!(item["subject"], "Factura octubre");
        assert_eq!(item["text"].as_str().map(str::trim), Some("Hola, va la factura."));
        assert_eq!(item["unread"], false);
        let saved = item["attachments"][0]["path"].as_str().unwrap();
        // The name is the attachment's own, never a path out of the folder.
        assert!(Path::new(saved).starts_with(&folder) && saved.ends_with("_factura.pdf"));
        assert_eq!(std::fs::read(saved).unwrap(), b"%PDF-1.4\n");
        let again = read(42, RAW.as_bytes(), &[], "INBOX", Some(&folder)).unwrap();
        assert!(again["attachments"][0]["path"].as_str().unwrap().ends_with("_factura (2).pdf"));
        assert_eq!(again["unread"], true);
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn mailbox_names_and_criteria_stay_one_command() {
        assert_eq!(mailbox_name("").unwrap(), "INBOX");
        assert_eq!(mailbox_name(" Facturas/2026 ").unwrap(), "Facturas/2026");
        assert!(mailbox_name("a\r\nA1 LOGOUT").is_err());
        assert_eq!(criteria("  ").unwrap(), "ALL");
        assert!(criteria("UNSEEN\r\nA1 LOGOUT").is_err());
        let account = Account::of(&json!({"host": "imap.example.com", "user": "ana"}), "pw".into()).unwrap();
        assert_eq!((account.port, account.security.as_str()), (993, "tls"));
        assert_eq!(Account::of(&json!({"host": "h", "security": "starttls"}), String::new()).unwrap().port, 143);
    }
}
