//! Client certificates, trust roots and HTTP proxies for the transports that don't get them from
//! reqwest — and the one decoder every transport shares for the identity itself.
//!
//! rustls, the TLS stack under reqwest, tokio-tungstenite and tonic here, only reads an identity as
//! PEM with an *unencrypted* key. What people hold is often something else: a PKCS#12 bundle
//! exported from a keychain (`.p12`/`.pfx`), a key protected by a passphrase — PKCS#8's
//! `ENCRYPTED PRIVATE KEY`, or OpenSSL's older `Proc-Type: 4,ENCRYPTED` headers — or a certificate
//! and its key in two files. [`load_client_identity`] turns each of those into DER once, and the
//! transports take it in the shape they want: a PEM pair for reqwest and tonic, a rustls
//! `ClientConfig` for WebSocket.

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, InnerIvInit, KeyIvInit};
use der::asn1::{ContextSpecific, OctetString};
use der::oid::ObjectIdentifier;
use der::{Decode, Encode};
use hmac::{Hmac, Mac};
use pkcs12::kdf::{derive_key, Pkcs12KeyType};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use sha1::Sha1;
use sha2::{Sha256, Sha384, Sha512};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::NetworkOptions;

// ---------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------

/// A client certificate chain (leaf first) and its private key, decoded.
pub struct ClientIdentity {
    pub certs: Vec<CertificateDer<'static>>,
    pub key: PrivateKeyDer<'static>,
}

impl ClientIdentity {
    pub fn cert_pem(&self) -> String {
        self.certs.iter().map(|cert| pem("CERTIFICATE", cert)).collect()
    }

    /// The key re-armoured in its own format, so nothing is converted that didn't have to be.
    pub fn key_pem(&self) -> String {
        match &self.key {
            PrivateKeyDer::Pkcs1(key) => pem("RSA PRIVATE KEY", key.secret_pkcs1_der()),
            PrivateKeyDer::Sec1(key) => pem("EC PRIVATE KEY", key.secret_sec1_der()),
            other => pem("PRIVATE KEY", other.secret_der()),
        }
    }

    pub fn reqwest(&self) -> Result<reqwest::Identity, String> {
        reqwest::Identity::from_pem(format!("{}{}", self.cert_pem(), self.key_pem()).as_bytes())
            .map_err(|e| format!("the client certificate was decoded but not accepted: {e}"))
    }

    pub fn tonic(&self) -> tonic::transport::Identity {
        tonic::transport::Identity::from_pem(self.cert_pem(), self.key_pem())
    }
}

fn pem(label: &str, der: &[u8]) -> String {
    let body = B64.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in body.as_bytes().chunks(64) {
        out.push_str(&String::from_utf8_lossy(line));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// The identity `options` names, or `None` when it names none.
pub fn identity_for(options: &NetworkOptions) -> Result<Option<ClientIdentity>, String> {
    let cert = options.client_cert_path.trim();
    if cert.is_empty() {
        return Ok(None);
    }
    load_client_identity(cert, options.client_key_path.trim(), &options.client_cert_password).map(Some)
}

/// Reads a client identity from disk, whatever shape it is in.
///
/// - A PKCS#12 file — recognised by its content, not its extension — carries its own key and
///   needs `password`; `key_path` is ignored.
/// - Otherwise `cert_path` is PEM holding the chain, and the key comes from `key_path` when one is
///   given, or from the same file when it isn't. An encrypted key needs `password`; a password
///   given for a key that isn't encrypted is simply not needed.
pub fn load_client_identity(cert_path: &str, key_path: &str, password: &str) -> Result<ClientIdentity, String> {
    let bytes = std::fs::read(cert_path)
        .map_err(|e| format!("Cannot read the client certificate at '{cert_path}': {e}"))?;
    let text = std::str::from_utf8(&bytes).ok().filter(|text| text.contains("-----BEGIN "));
    let Some(text) = text else {
        return from_pkcs12(&bytes, password, cert_path);
    };

    let blocks = pem_blocks(text, cert_path)?;
    let certs: Vec<CertificateDer<'static>> = blocks
        .iter()
        .filter(|block| block.label == "CERTIFICATE")
        .map(|block| CertificateDer::from(block.der.clone()))
        .collect();
    if certs.is_empty() {
        return Err(format!("'{cert_path}' holds no certificate."));
    }

    let key = if key_path.is_empty() {
        key_from_blocks(&blocks, password, cert_path)?
    } else {
        let key_bytes = std::fs::read(key_path)
            .map_err(|e| format!("Cannot read the private key at '{key_path}': {e}"))?;
        match std::str::from_utf8(&key_bytes).ok().filter(|text| text.contains("-----BEGIN ")) {
            Some(text) => key_from_blocks(&pem_blocks(text, key_path)?, password, key_path)?,
            // A DER key file: PKCS#8 is the only binary form with nothing to tell it apart by.
            None => Some(PrivateKeyDer::Pkcs8(key_bytes.into())),
        }
    };
    let key = key.ok_or_else(|| {
        format!(
            "No private key was found for '{cert_path}'. Choose the key file, or a certificate file \
             that includes its key."
        )
    })?;
    Ok(ClientIdentity { certs, key })
}

// ---------------------------------------------------------------------------
// PEM
// ---------------------------------------------------------------------------

struct PemBlock {
    label: String,
    /// RFC 1421 headers — only OpenSSL's traditional encrypted keys still write them.
    headers: Vec<(String, String)>,
    der: Vec<u8>,
}

/// Every `-----BEGIN …-----` block in `text`, headers included, which is what the stricter RFC 7468
/// readers refuse and a traditional encrypted key needs.
fn pem_blocks(text: &str, source: &str) -> Result<Vec<PemBlock>, String> {
    let mut out = Vec::new();
    let mut lines = text.lines().map(str::trim);
    while let Some(line) = lines.next() {
        let Some(label) = line.strip_prefix("-----BEGIN ").and_then(|rest| rest.strip_suffix("-----")) else {
            continue;
        };
        let end = format!("-----END {label}-----");
        let mut headers = Vec::new();
        let mut body = String::new();
        let mut in_headers = true;
        let mut closed = false;
        for line in lines.by_ref() {
            if line == end {
                closed = true;
                break;
            }
            if in_headers {
                // Base64 has no colon, so a colon line can only be a header; the blank line after
                // the headers is where the body starts.
                if let Some((name, value)) = line.split_once(':') {
                    headers.push((name.trim().to_string(), value.trim().to_string()));
                    continue;
                }
                in_headers = false;
                if line.is_empty() {
                    continue;
                }
            }
            body.push_str(line);
        }
        if !closed {
            return Err(format!("'{source}' has a PEM block ({label}) that never ends."));
        }
        let der = B64
            .decode(body.as_bytes())
            .map_err(|e| format!("'{source}' has a PEM block ({label}) that isn't valid base64: {e}"))?;
        out.push(PemBlock { label: label.to_string(), headers, der });
    }
    Ok(out)
}

fn key_from_blocks(blocks: &[PemBlock], password: &str, source: &str) -> Result<Option<PrivateKeyDer<'static>>, String> {
    for block in blocks {
        match block.label.as_str() {
            "PRIVATE KEY" => return Ok(Some(PrivateKeyDer::Pkcs8(block.der.clone().into()))),
            "ENCRYPTED PRIVATE KEY" => return decrypt_pkcs8(&block.der, password, source).map(Some),
            "RSA PRIVATE KEY" | "EC PRIVATE KEY" => {
                let encrypted = block
                    .headers
                    .iter()
                    .any(|(name, value)| name.eq_ignore_ascii_case("Proc-Type") && value.contains("ENCRYPTED"));
                let der = if encrypted { decrypt_traditional(block, password, source)? } else { block.der.clone() };
                return Ok(Some(if block.label.starts_with("RSA") {
                    PrivateKeyDer::Pkcs1(der.into())
                } else {
                    PrivateKeyDer::Sec1(der.into())
                }));
            }
            _ => {}
        }
    }
    Ok(None)
}

fn needs_password(source: &str) -> String {
    format!("The private key in '{source}' is encrypted — enter its passphrase.")
}

fn wrong_password(source: &str) -> String {
    format!("The passphrase doesn't open '{source}'.")
}

/// PKCS#8 `ENCRYPTED PRIVATE KEY` — PBES2 (PBKDF2 or scrypt, AES or 3DES), what `openssl pkcs8
/// -topk8` and every modern tool write.
fn decrypt_pkcs8(der: &[u8], password: &str, source: &str) -> Result<PrivateKeyDer<'static>, String> {
    if password.is_empty() {
        return Err(needs_password(source));
    }
    let info = pkcs8::EncryptedPrivateKeyInfo::try_from(der)
        .map_err(|e| format!("The encrypted key in '{source}' can't be read: {e}"))?;
    let document = info.decrypt(password).map_err(|_| wrong_password(source))?;
    Ok(PrivateKeyDer::Pkcs8(document.as_bytes().to_vec().into()))
}

/// OpenSSL's traditional encrypted key: a PKCS#1 or SEC1 key under `DEK-Info: <cipher>,<iv>`, with
/// the key derived by `EVP_BytesToKey` (MD5, one round, the IV's first 8 bytes as salt).
fn decrypt_traditional(block: &PemBlock, password: &str, source: &str) -> Result<Vec<u8>, String> {
    if password.is_empty() {
        return Err(needs_password(source));
    }
    let info = block
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("DEK-Info"))
        .map(|(_, value)| value.as_str())
        .ok_or_else(|| format!("The encrypted key in '{source}' has no DEK-Info header."))?;
    let (cipher, iv_hex) = info
        .split_once(',')
        .ok_or_else(|| format!("The encrypted key in '{source}' has a malformed DEK-Info header."))?;
    let iv = hex::decode(iv_hex.trim())
        .map_err(|_| format!("The encrypted key in '{source}' has a malformed IV."))?;
    if iv.len() < 8 {
        return Err(format!("The encrypted key in '{source}' has a malformed IV."));
    }
    let cipher = cipher.trim().to_ascii_uppercase();
    let key_len = match cipher.as_str() {
        "AES-128-CBC" => 16,
        "AES-192-CBC" | "DES-EDE3-CBC" => 24,
        "AES-256-CBC" => 32,
        other => {
            return Err(format!(
                "The key in '{source}' is encrypted with {other}, which isn't supported. Re-encrypt it with \
                 AES: openssl pkcs8 -topk8 -v2 aes-256-cbc -in key.pem -out key-aes.pem"
            ))
        }
    };
    let key = evp_bytes_to_key(password.as_bytes(), &iv[..8], key_len);
    let plain = match cipher.as_str() {
        "AES-128-CBC" => cbc_decrypt::<aes::Aes128>(&key, &iv, &block.der),
        "AES-192-CBC" => cbc_decrypt::<aes::Aes192>(&key, &iv, &block.der),
        "AES-256-CBC" => cbc_decrypt::<aes::Aes256>(&key, &iv, &block.der),
        _ => cbc_decrypt::<des::TdesEde3>(&key, &iv, &block.der),
    };
    // A wrong passphrase usually fails the padding; the SEQUENCE check catches the 1-in-256 that
    // doesn't, before rustls reports it as a malformed key.
    plain
        .filter(|der| der.first() == Some(&0x30))
        .ok_or_else(|| wrong_password(source))
}

fn evp_bytes_to_key(password: &[u8], salt: &[u8], len: usize) -> Vec<u8> {
    use md5::Digest as _;
    let mut out = Vec::with_capacity(len + 16);
    let mut previous: Vec<u8> = Vec::new();
    while out.len() < len {
        let mut hasher = md5::Md5::new();
        hasher.update(&previous);
        hasher.update(password);
        hasher.update(salt);
        previous = hasher.finalize().to_vec();
        out.extend_from_slice(&previous);
    }
    out.truncate(len);
    out
}

fn cbc_decrypt<C>(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>>
where
    C: cbc::cipher::BlockDecrypt + cbc::cipher::BlockCipher + cbc::cipher::KeyInit,
    cbc::Decryptor<C>: KeyIvInit,
{
    cbc::Decryptor::<C>::new_from_slices(key, iv)
        .ok()?
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .ok()
}

// ---------------------------------------------------------------------------
// PKCS#12
// ---------------------------------------------------------------------------

const ID_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.1");
const ID_ENCRYPTED_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.6");
const PBES2: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.5.13");
const LOCAL_KEY_ID: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.21");
const SHA1_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.14.3.2.26");
const SHA256_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1");
const SHA384_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.2");
const SHA512_OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.3");

fn der_error(source: &str) -> impl Fn(der::Error) -> String + '_ {
    move |e| format!("'{source}' is not a readable PKCS#12 file: {e}")
}

/// The password as RFC 7292's KDF wants it: UTF-16BE with a two-byte terminator. An empty password
/// is ambiguous in the wild — some tools write the terminator alone, some nothing at all — so both
/// are candidates, and the MAC says which one was used.
fn bmp_candidates(password: &str) -> Vec<Vec<u8>> {
    let mut bmp: Vec<u8> = password.encode_utf16().flat_map(u16::to_be_bytes).collect();
    bmp.extend([0, 0]);
    if password.is_empty() {
        vec![bmp, Vec::new()]
    } else {
        vec![bmp]
    }
}

/// A PFX in password-integrity mode — what every keychain export, `openssl pkcs12 -export` and
/// Java's keytool write. Both the modern ciphers (PBES2: PBKDF2 + AES) and the legacy PKCS#12 ones
/// (SHA-1 with 3DES or RC2) are read.
fn from_pkcs12(bytes: &[u8], password: &str, source: &str) -> Result<ClientIdentity, String> {
    let pfx = pkcs12::pfx::Pfx::from_der(bytes).map_err(der_error(source))?;
    if pfx.auth_safe.content_type != ID_DATA {
        return Err(format!(
            "'{source}' is protected with a public key rather than a password, which isn't supported. \
             Export it again with a password."
        ));
    }
    let safe = OctetString::from_der(&pfx.auth_safe.content.to_der().map_err(der_error(source))?)
        .map_err(der_error(source))?
        .into_bytes();

    // The MAC is the one check that tells a wrong password from a corrupt file, so it goes first —
    // and it settles which spelling of an empty password the file was written with.
    let bmp = match &pfx.mac_data {
        Some(mac) => bmp_candidates(password)
            .into_iter()
            .find(|candidate| mac_matches(mac, &safe, candidate))
            .ok_or_else(|| wrong_password(source))?,
        None => bmp_candidates(password).remove(0),
    };

    let safes = pkcs12::authenticated_safe::AuthenticatedSafe::from_der(&safe).map_err(der_error(source))?;
    let mut certs: Vec<(Option<Vec<u8>>, Vec<u8>)> = Vec::new();
    let mut keys: Vec<(Option<Vec<u8>>, Vec<u8>)> = Vec::new();

    for info in safes.iter() {
        let contents = if info.content_type == ID_DATA {
            OctetString::from_der(&info.content.to_der().map_err(der_error(source))?)
                .map_err(der_error(source))?
                .into_bytes()
        } else if info.content_type == ID_ENCRYPTED_DATA {
            let encrypted = cms::encrypted_data::EncryptedData::from_der(&info.content.to_der().map_err(der_error(source))?)
                .map_err(der_error(source))?;
            let data = encrypted
                .enc_content_info
                .encrypted_content
                .map(OctetString::into_bytes)
                .unwrap_or_default();
            decrypt_pbe(&encrypted.enc_content_info.content_enc_alg, &data, password, &bmp, source)?
        } else {
            // Enveloped data is sealed to a recipient's key, not to a password: nothing to read here.
            continue;
        };

        for bag in pkcs12::safe_bag::SafeContents::from_der(&contents).map_err(der_error(source))? {
            let id = local_key_id(&bag);
            if bag.bag_id == pkcs12::PKCS_12_CERT_BAG_OID {
                let cert: ContextSpecific<pkcs12::cert_type::CertBag> =
                    ContextSpecific::from_der(&bag.bag_value).map_err(der_error(source))?;
                if cert.value.cert_id == pkcs12::PKCS_12_X509_CERT_OID {
                    certs.push((id, cert.value.cert_value.into_bytes()));
                }
            } else if bag.bag_id == pkcs12::PKCS_12_PKCS8_KEY_BAG_OID {
                let shrouded: ContextSpecific<pkcs12::pbe_params::EncryptedPrivateKeyInfo> =
                    ContextSpecific::from_der(&bag.bag_value).map_err(der_error(source))?;
                let key = decrypt_pbe(
                    &shrouded.value.encryption_algorithm,
                    shrouded.value.encrypted_data.as_bytes(),
                    password,
                    &bmp,
                    source,
                )?;
                keys.push((id, key));
            } else if bag.bag_id == pkcs12::PKCS_12_KEY_BAG_OID {
                let plain: ContextSpecific<der::Any> =
                    ContextSpecific::from_der(&bag.bag_value).map_err(der_error(source))?;
                keys.push((id, plain.value.to_der().map_err(der_error(source))?));
            }
        }
    }

    let (key_id, key) = keys
        .into_iter()
        .next()
        .ok_or_else(|| format!("'{source}' holds no private key."))?;
    if certs.is_empty() {
        return Err(format!("'{source}' holds no certificate."));
    }
    // The leaf is the certificate the key's bag names; the rest ride along as its chain.
    let leaf = key_id
        .as_ref()
        .and_then(|wanted| certs.iter().position(|(id, _)| id.as_ref() == Some(wanted)))
        .unwrap_or(0);
    let leaf_cert = certs.remove(leaf).1;
    let mut chain = vec![CertificateDer::from(leaf_cert)];
    chain.extend(certs.into_iter().map(|(_, der)| CertificateDer::from(der)));
    Ok(ClientIdentity { certs: chain, key: PrivateKeyDer::Pkcs8(key.into()) })
}

fn local_key_id(bag: &pkcs12::safe_bag::SafeBag) -> Option<Vec<u8>> {
    let attributes = bag.bag_attributes.as_ref()?;
    let attribute = attributes.iter().find(|attribute| attribute.oid == LOCAL_KEY_ID)?;
    attribute.values.iter().next().map(|value| value.value().to_vec())
}

fn mac_matches(mac: &pkcs12::mac_data::MacData, data: &[u8], bmp: &[u8]) -> bool {
    let salt = mac.mac_salt.as_bytes();
    let rounds = mac.iterations;
    let expected = mac.mac.digest.as_bytes();
    macro_rules! check {
        ($digest:ty, $len:expr) => {{
            let key = derive_key::<$digest>(bmp, salt, Pkcs12KeyType::Mac, rounds, $len);
            let Ok(mut hmac) = <Hmac<$digest> as Mac>::new_from_slice(&key) else { return false };
            hmac.update(data);
            hmac.verify_slice(expected).is_ok()
        }};
    }
    match mac.mac.algorithm.oid {
        oid if oid == SHA1_OID => check!(Sha1, 20),
        oid if oid == SHA256_OID => check!(Sha256, 32),
        oid if oid == SHA384_OID => check!(Sha384, 48),
        oid if oid == SHA512_OID => check!(Sha512, 64),
        _ => false,
    }
}

/// One encrypted blob inside the PFX: PBES2 takes the password as UTF-8 (as OpenSSL writes it), the
/// legacy PKCS#12 PBEs take the BMP form through RFC 7292's own KDF.
fn decrypt_pbe(
    algorithm: &pkcs8::spki::AlgorithmIdentifierOwned,
    data: &[u8],
    password: &str,
    bmp: &[u8],
    source: &str,
) -> Result<Vec<u8>, String> {
    let params = algorithm
        .parameters
        .as_ref()
        .ok_or_else(|| format!("'{source}' names a cipher with no parameters."))?
        .to_der()
        .map_err(der_error(source))?;

    if algorithm.oid == PBES2 {
        let params = pkcs8::pkcs5::pbes2::Parameters::from_der(&params).map_err(der_error(source))?;
        let scheme = pkcs8::pkcs5::EncryptionScheme::from(params);
        let mut buffer = data.to_vec();
        return scheme
            .decrypt_in_place(password, &mut buffer)
            .map(<[u8]>::to_vec)
            .map_err(|_| wrong_password(source));
    }

    let params = pkcs12::pbe_params::Pkcs12PbeParams::from_der(&params).map_err(der_error(source))?;
    let salt = params.salt.as_bytes();
    let rounds = params.iterations;
    let derive = |len: usize| {
        (
            derive_key::<Sha1>(bmp, salt, Pkcs12KeyType::EncryptionKey, rounds, len),
            derive_key::<Sha1>(bmp, salt, Pkcs12KeyType::Iv, rounds, 8),
        )
    };
    let plain = match algorithm.oid {
        oid if oid == pkcs12::PKCS_12_PBE_WITH_SHAAND3_KEY_TRIPLE_DES_CBC => {
            let (key, iv) = derive(24);
            cbc_decrypt::<des::TdesEde3>(&key, &iv, data)
        }
        oid if oid == pkcs12::PKCS_12_PBE_WITH_SHAAND2_KEY_TRIPLE_DES_CBC => {
            let (key, iv) = derive(16);
            cbc_decrypt::<des::TdesEde2>(&key, &iv, data)
        }
        oid if oid == pkcs12::PKCS_12_PBE_WITH_SHAAND128_BIT_RC2_CBC => {
            let (key, iv) = derive(16);
            rc2_decrypt(&key, 128, &iv, data)
        }
        oid if oid == pkcs12::PKCS_12_PBEWITH_SHAAND40_BIT_RC2_CBC => {
            let (key, iv) = derive(5);
            rc2_decrypt(&key, 40, &iv, data)
        }
        other => {
            return Err(format!(
                "'{source}' is encrypted with {other}, which isn't supported. Export it again with AES \
                 (the default of OpenSSL 3 and of current keychains)."
            ))
        }
    };
    plain.ok_or_else(|| wrong_password(source))
}

/// RC2's effective key length is a parameter of its own, which is what makes 40-bit RC2 (the
/// certificate cipher of every legacy PKCS#12) a different cipher from 128-bit with the same key.
fn rc2_decrypt(key: &[u8], effective_bits: usize, iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let cipher = rc2::Rc2::new_with_eff_key_len(key, effective_bits);
    cbc::Decryptor::<rc2::Rc2>::inner_iv_slice_init(cipher, iv)
        .ok()?
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .ok()
}

// ---------------------------------------------------------------------------
// rustls, for the transports that build their own
// ---------------------------------------------------------------------------

/// A rustls config honouring `options`' CA bundle, client certificate and verification switch —
/// or `None` when none of them is set, so the caller keeps its own default connector.
pub fn rustls_config(options: &NetworkOptions) -> Result<Option<Arc<rustls::ClientConfig>>, String> {
    let ca_path = options.ca_cert_path.trim();
    let identity = identity_for(options)?;
    if options.verify_ssl && ca_path.is_empty() && identity.is_none() {
        return Ok(None);
    }

    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;
    let builder = if options.verify_ssl {
        builder.with_root_certificates(root_store(ca_path)?)
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
    };
    let config = match identity {
        Some(identity) => builder
            .with_client_auth_cert(identity.certs, identity.key)
            .map_err(|e| format!("The client certificate can't be used: {e}"))?,
        None => builder.with_no_client_auth(),
    };
    Ok(Some(Arc::new(config)))
}

/// The platform's roots plus the CA bundle — *plus*, not instead of: a private CA is an addition to
/// the public ones, as `datasource::postgres` reasons too.
fn root_store(ca_path: &str) -> Result<rustls::RootCertStore, String> {
    let mut roots = rustls::RootCertStore::empty();
    for certificate in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(certificate);
    }
    if !ca_path.is_empty() {
        let bytes = std::fs::read(ca_path).map_err(|e| format!("Cannot read the CA bundle at '{ca_path}': {e}"))?;
        let text = String::from_utf8_lossy(&bytes);
        let mut added = 0usize;
        for block in pem_blocks(&text, ca_path)? {
            if block.label == "CERTIFICATE" {
                roots
                    .add(CertificateDer::from(block.der))
                    .map_err(|e| format!("'{ca_path}' was rejected: {e}"))?;
                added += 1;
            }
        }
        if added == 0 {
            return Err(format!("'{ca_path}' holds no certificates."));
        }
    }
    Ok(roots)
}

/// Reachable only when the request explicitly turned verification off — the point of that toggle
/// is talking to a staging box with a self-signed certificate. Signature checking stays intact so
/// the handshake still fails on a genuinely broken peer rather than on a name mismatch alone.
#[derive(Debug)]
pub(crate) struct AcceptAnyServerCert(pub(crate) Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

// ---------------------------------------------------------------------------
// HTTP proxies, for the sockets reqwest doesn't open
// ---------------------------------------------------------------------------

/// Bytes read of a proxy's answer to `CONNECT` before it is given up on.
const PROXY_HEAD_LIMIT: usize = 16 * 1024;

/// Opens a tunnel to `host:port` through an `http://` proxy (`CONNECT`, RFC 9110 §9.3.6), with
/// Basic credentials when the proxy URL carries them. What comes back is a plain TCP stream to the
/// target — TLS, if any, is negotiated through it by the caller, end to end.
pub async fn connect_via_proxy(proxy_url: &str, host: &str, port: u16) -> Result<TcpStream, String> {
    let proxy = url::Url::parse(proxy_url.trim()).map_err(|e| format!("Proxy '{proxy_url}' is not usable: {e}"))?;
    match proxy.scheme() {
        "http" => {}
        "https" => {
            return Err(format!(
                "Proxy '{proxy_url}' is https://, which this connection can't tunnel through — use the \
                 proxy's http:// address."
            ))
        }
        other => return Err(format!("Proxy '{proxy_url}' uses '{other}', which this connection can't tunnel through.")),
    }
    let proxy_host = proxy
        .host_str()
        .ok_or_else(|| format!("Proxy '{proxy_url}' has no host."))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let proxy_port = proxy.port_or_known_default().unwrap_or(80);

    let mut stream = TcpStream::connect((proxy_host.as_str(), proxy_port))
        .await
        .map_err(|e| format!("Couldn't reach the proxy {proxy_host}:{proxy_port}: {e}"))?;

    let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if !proxy.username().is_empty() {
        let decode = |value: &str| percent_encoding::percent_decode_str(value).decode_utf8_lossy().into_owned();
        let credentials = format!("{}:{}", decode(proxy.username()), decode(proxy.password().unwrap_or("")));
        request.push_str(&format!("Proxy-Authorization: Basic {}\r\n", B64.encode(credentials)));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("The proxy closed the connection: {e}"))?;

    // Byte by byte, so nothing past the proxy's own answer is read out of what becomes the tunnel.
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > PROXY_HEAD_LIMIT {
            return Err("The proxy's answer to CONNECT never ended.".to_string());
        }
        let read = stream
            .read(&mut byte)
            .await
            .map_err(|e| format!("The proxy closed the connection: {e}"))?;
        if read == 0 {
            return Err("The proxy closed the connection before answering CONNECT.".to_string());
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head);
    let status_line = head.lines().next().unwrap_or("").trim().to_string();
    let status = status_line.split_whitespace().nth(1).unwrap_or("");
    if !status.starts_with('2') {
        return Err(if status == "407" {
            format!("The proxy wants credentials (407). Put them in the proxy URL: http://user:password@host:port — it answered: {status_line}")
        } else {
            format!("The proxy refused the tunnel to {authority}: {status_line}")
        });
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The fixtures are one throwaway P-256 key and its self-signed certificate
    // (`CN=client.example.test`), in each shape a user might hold them, generated with OpenSSL 3.6:
    // `ecparam -genkey`, `pkcs12 -export` (PBES2/AES-256 + SHA-256 MAC), `pkcs12 -export -legacy`
    // (3DES key, 40-bit RC2 certificates, SHA-1 MAC), `pkcs8 -topk8 -v2 aes-256-cbc` and `ec
    // -aes-256-cbc` (traditional). Passphrase `s3cret` throughout. Stored as base64 of the files so
    // no PEM private-key header appears in the source — the app's own secret scanner flags those.
    const CERT_PEM: &str = "\
        LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJrakNDQVRtZ0F3SUJBZ0lVV0RFUjJJeTUvdnNVTHF2RzhxZit1N2FS\
        YXFnd0NnWUlLb1pJemowRUF3SXcKSGpFY01Cb0dBMVVFQXd3VFkyeHBaVzUwTG1WNFlXMXdiR1V1ZEdWemREQWdGdzB5TmpB\
        NU1qZ3hNVFV5TURsYQpHQTh5TVRJMk1Ea3dOREV4TlRJd09Wb3dIakVjTUJvR0ExVUVBd3dUWTJ4cFpXNTBMbVY0WVcxd2JH\
        VXVkR1Z6CmREQlpNQk1HQnlxR1NNNDlBZ0VHQ0NxR1NNNDlBd0VIQTBJQUJCazgrWXA0eHhFV2wrbHQvSXVvTGNMQm1iVDIK\
        VmhDMG4rL0hpaFpiL2J4eXhNUis0RmpiNEduV2RpUUZSMU9VeVdSSDExczNaSU9aZGdIN1lBVW5TMXFqVXpCUgpNQjBHQTFV\
        ZERnUVdCQlFpZ0t6eHpoR00yVXhRWVNlQzJCSlZadWFGbnpBZkJnTlZIU01FR0RBV2dCUWlnS3p4CnpoR00yVXhRWVNlQzJC\
        SlZadWFGbnpBUEJnTlZIUk1CQWY4RUJUQURBUUgvTUFvR0NDcUdTTTQ5QkFNQ0EwY0EKTUVRQ0lHSlVBalBKd3NCWjV3TTg4\
        QTArbWw3a1NkMHBKZUhGNC8rTnJhdGRaa0VvQWlCWXZDVTZwSVJHSkpDMQo3RnpLbUZMWC9XSjFFQjVXRm1DTThOMFh3cTQ1\
        eVE9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==";

    const KEY_PKCS8_PEM: &str = "\
        LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JR0hBZ0VBTUJNR0J5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEJHMHdhd0lC\
        QVFRZzJKR3pXeEhkaGRCRmhYVTcKK2Q0bDI3TG9aYWVHaGp2WmhiQTQ0ZE1ESEJXaFJBTkNBQVFaUFBtS2VNY1JGcGZwYmZ5\
        THFDM0N3Wm0wOWxZUQp0Si92eDRvV1cvMjhjc1RFZnVCWTIrQnAxbllrQlVkVGxNbGtSOWRiTjJTRG1YWUIrMkFGSjB0YQot\
        LS0tLUVORCBQUklWQVRFIEtFWS0tLS0tCg==";

    const KEY_SEC1_PEM: &str = "\
        LS0tLS1CRUdJTiBFQyBQUklWQVRFIEtFWS0tLS0tCk1IY0NBUUVFSU5pUnMxc1IzWVhRUllWMU8vbmVKZHV5NkdXbmhvWTcy\
        WVd3T09IVEF4d1ZvQW9HQ0NxR1NNNDkKQXdFSG9VUURRZ0FFR1R6NWluakhFUmFYNlczOGk2Z3R3c0dadFBaV0VMU2Y3OGVL\
        Rmx2OXZITEV4SDdnV052ZwphZFoySkFWSFU1VEpaRWZYV3pka2c1bDJBZnRnQlNkTFdnPT0KLS0tLS1FTkQgRUMgUFJJVkFU\
        RSBLRVktLS0tLQo=";

    const KEY_ENCRYPTED_PKCS8_PEM: &str = "\
        LS0tLS1CRUdJTiBFTkNSWVBURUQgUFJJVkFURSBLRVktLS0tLQpNSUgwTUY4R0NTcUdTSWIzRFFFRkRUQlNNREVHQ1NxR1NJ\
        YjNEUUVGRERBa0JCQmIyazFxR3FkMTFMZmQyVVJKCnVxNWlBZ0lJQURBTUJnZ3Foa2lHOXcwQ0NRVUFNQjBHQ1dDR1NBRmxB\
        d1FCS2dRUXJPNlFlNUZLdFZFZlFaV08KS29QQy9nU0JrQVd3MzN3b1B0SDhCN0hPR1hFdHM5bTk3UGdSWHdPZUZRbXNIenlp\
        dVlVeDJVTHhQK1A1OWhsVgpZeDEwTVNMMGlrTUpocFRHWmVsRW8zb1hJczNVaXlkM0FCK01RckhRZzFVc2I4T3ZCRmFpeFBw\
        YnBGeHlSbmlZCk5BcmlzUHAydFBBenZmZzNoWERBbVhid1NCRWpLN0d5Z1FpbGt5ZmJMdEtEalA4QXlmM0lJUGpaMXRRSEJY\
        NlgKNjdZVitwTHZkdz09Ci0tLS0tRU5EIEVOQ1JZUFRFRCBQUklWQVRFIEtFWS0tLS0tCg==";

    const KEY_ENCRYPTED_TRADITIONAL_PEM: &str = "\
        LS0tLS1CRUdJTiBFQyBQUklWQVRFIEtFWS0tLS0tClByb2MtVHlwZTogNCxFTkNSWVBURUQKREVLLUluZm86IEFFUy0yNTYt\
        Q0JDLDhDN0VBNTQ5QjNGNkUxNTNGNzIyRDg2RjIxMjcwNkQ4CgoxN0tuRlk2UTJtVEZrV1lCNE85aUJJajluR2ExK3Y0YWdN\
        TEhuUUs0VVFTMFF4a3M1QjNyOHpEbk1NN2wyeFcwCnd3Rm1qNkVHeklZd3lEUFNsNG5POFFhZWRGcWVFeVBobXpsL2hyMjZ4\
        Vkc3QXdCQ2dmMlZLdkNDV3NCT1FwOC8Kc2VINUxwZVJPeGl1elRQTlFFNEcwc2dwaDhmNVpqZFlEcVZ6b0ZkUExLVT0KLS0t\
        LS1FTkQgRUMgUFJJVkFURSBLRVktLS0tLQo=";

    const P12_MODERN: &str = "\
        MIIENAIBAzCCA+IGCSqGSIb3DQEHAaCCA9MEggPPMIIDyzCCAnoGCSqGSIb3DQEHBqCCAmswggJnAgEAMIICYAYJKoZIhvcN\
        AQcBMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBAWUdjVMR1MpNoypneoLdGGAgIIADAMBggqhkiG9w0CCQUAMB0G\
        CWCGSAFlAwQBKgQQgXgBk9c8EK9w65rcEQz+sYCCAfDF3We/QjMbb/46uIRpOHyyN6c805BPpbdODOzUk9Md0Is3XaLon6Qq\
        FApS1BUb7Wp+COnoM/7bNVhGyYo1f1+7x/wupzJqqN9qUnRTbv11ECn8TOe6A50bKr2KjRm3Y9MWwt3D8Yvj3zvYUw5H1FWm\
        hIcQoq+4Mrr/jzrkRww41uq9Bn52V/p97rYd+Dpt/zD2Lxo5QcLSUGlqP5lwuepFgVC/5e94edbr/15ZCcX2vohjTNr9G5yh\
        CAmI3jh4Rb9GaZMrnuYGJy6Cjq62I5Yxf+tFMomSDhIQUi5hDtrHHEqcAvk0ZGVprJWkNbM9DddDtFHGF41IPEx85kY3Im5O\
        xc5vM+rXKsdIwQeNBVv/vGcODCiTon4Fcr9EMX66ClQdg605Dn4E+DUZH2febU0c32rXQ7UEEmfDc62hQfoLDwiksLE6FsFG\
        kwGcHH0/g0MMqJEC4czALyLMhOLpZNsm//Orz5VtVZOsCytbrMpmJhBLxk97//2CPfAf93v0CniUsNhpnrgRJDjSWnbJcJ9l\
        sTJ2MvoeBboNGn0yC2GegCBx6wwGcUvVUOGjw7b2gHmqC4IMdbr3zkJqdg7O3dSBN3MF2ohoxleqvLRsPlCucI0LRxhQ0pXr\
        68wz/F6vOAoWN3ACf0z+O5kVrMN+ZXujMIIBSQYJKoZIhvcNAQcBoIIBOgSCATYwggEyMIIBLgYLKoZIhvcNAQwKAQKggfcw\
        gfQwXwYJKoZIhvcNAQUNMFIwMQYJKoZIhvcNAQUMMCQEECVI0kf3QE5jWP28BJbRpQECAggAMAwGCCqGSIb3DQIJBQAwHQYJ\
        YIZIAWUDBAEqBBAxAabYv/GoRoDc/sOhS+KaBIGQVPwFcouhz6Z8bxGxOWkT/P8GKpzGXng0GC8+awfrbpzQYZ+FJ1bg7Aal\
        6LXJ67wpqC5Tc1sWguhJUcvyrf5I9nKZuLzvNai4YBj+l3NSa/qCUX6YVQZYujVIQtWNqUjkC9AjiJGKFeb2uk2fHmQyxCym\
        SmrRwGrgiM81h9yl8NJmxFX9V0hRqDP4Y+3OSiLbMSUwIwYJKoZIhvcNAQkVMRYEFA6OdB49uXG2TcuD/deqFQqQha1ZMEkw\
        MTANBglghkgBZQMEAgEFAAQgNAAm6pha3dE1fFJYENkEQoiE1wrMiSW+MeZnE5W1kW0EEPZhdeVQpCt4XDHD+09VsnACAggA";

    const P12_LEGACY: &str = "\
        MIIDmgIBAzCCA1gGCSqGSIb3DQEHAaCCA0kEggNFMIIDQTCCAjcGCSqGSIb3DQEHBqCCAigwggIkAgEAMIICHQYJKoZIhvcN\
        AQcBMBwGCiqGSIb3DQEMAQYwDgQIreuUSZWS33sCAggAgIIB8ADddX2on0rcX2Vu64sKZGTJ/Z3Yx4U9QruLiRrnwA+a5swD\
        dTuBXQFoLY0Rm6tmvCN4MGzeLpGpEEMuD6W+4BB3affwNMuy34m4VG1w6P0TGpuu52CjRJLlht1kPyew2+mzqoWFAK6oanlE\
        o5Y7t4kVljb0ZqbCVCKtz9tSskwXZO+FoGuB1LbJLjQ5ffnPWPf3xEYSevejlCjOz8puxQyrod3x3arAxJR3m5ri86UAjfei\
        kbXvSAIrJW2AYNeVnivqyw+axjM+iO8TRkU+fgMUBavC30SuPux1ugUEea7YcXjHSpAWruYEedZw5JypgBaeV+LC7XcFsDVz\
        UFhDTBg3lazAMWBbQ6HPO5OkCIEOeo+fuTpnsDYIo9xdYdAtThfokfHq6N/aXGeBTjGzeEHtPqeOWMKd0ypaHru57JYs9nW8\
        hDr3uZ2lscYkSkV9wVbsDoS6AOGpiMiOczJeInS1Kc242eVbVr+oxFKDQ8A8BG1ATrnSSinwJV3lUK8EAVatM6mbhRYC81E3\
        8v8pNQdqe3Ak1ItZTpPJJEj+o22klG3q7w4cwdr2dkr2+9jqqnvLV6yEQQpWoJYhbwnpesuEmzojwmEhpj+L/mlriHtxM1P8\
        hfA9BgeaJIRIAD/1Ctr973xvo91hfIYTHEUULE8wggECBgkqhkiG9w0BBwGggfQEgfEwge4wgesGCyqGSIb3DQEMCgECoIG0\
        MIGxMBwGCiqGSIb3DQEMAQMwDgQIJWvW7jbJirsCAggABIGQUwT2RbCIuqfO388tUapfSk4YOewUnhk+rAlV1ecO3bHTks+l\
        aBtmCtecrEA9R1E/PA710mQRYk0v8yYtKQUaBo9ihEPKf8FnjExa1HMQJTDdsN91579kXd8TRA+dc9+Za+6BWkjyrZHkimz/\
        TtKW1OY+33OdSRyimG69dY33MZVRQ6xXehJx3J+hW/0JbPUzMSUwIwYJKoZIhvcNAQkVMRYEFA6OdB49uXG2TcuD/deqFQqQ\
        ha1ZMDkwITAJBgUrDgMCGgUABBTRNWvsPOb8SHiB+XcQHbdTKn3RmgQQ0n01CS4TQwuOvHQ3UVMJIwICCAA=";

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn new(files: &[(&str, &str)]) -> Self {
            let dir = std::env::temp_dir().join(format!("cf-tls-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            for (name, encoded) in files {
                std::fs::write(dir.join(name), B64.decode(encoded).unwrap()).unwrap();
            }
            Fixture(dir)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn cert_der() -> Vec<u8> {
        let text = String::from_utf8(B64.decode(CERT_PEM).unwrap()).unwrap();
        pem_blocks(&text, "cert").unwrap().remove(0).der
    }

    fn pkcs8_der() -> Vec<u8> {
        let text = String::from_utf8(B64.decode(KEY_PKCS8_PEM).unwrap()).unwrap();
        pem_blocks(&text, "key").unwrap().remove(0).der
    }

    /// Every decoded shape must come out as the same key and the same certificate — and be one
    /// rustls accepts as a client identity.
    fn assert_is_the_fixture(identity: &ClientIdentity, expect_pkcs8: bool) {
        assert_eq!(identity.certs.len(), 1);
        assert_eq!(identity.certs[0].as_ref(), cert_der().as_slice());
        if expect_pkcs8 {
            assert_eq!(identity.key.secret_der(), pkcs8_der().as_slice());
        }
        identity.reqwest().expect("reqwest takes the re-armoured PEM");
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_client_auth_cert(identity.certs.clone(), identity.key.clone_key())
            .expect("rustls takes the decoded key");
    }

    #[test]
    fn a_pem_certificate_with_a_separate_unencrypted_key() {
        let files = Fixture::new(&[("cert.pem", CERT_PEM), ("key.pem", KEY_PKCS8_PEM)]);
        let identity = load_client_identity(&files.path("cert.pem"), &files.path("key.pem"), "").unwrap();
        assert_is_the_fixture(&identity, true);
        // A passphrase nobody needed is not an error.
        load_client_identity(&files.path("cert.pem"), &files.path("key.pem"), "unused").unwrap();
    }

    #[test]
    fn a_bundle_with_certificate_and_key_in_one_file() {
        let bundle = B64.encode(
            [B64.decode(CERT_PEM).unwrap(), B64.decode(KEY_SEC1_PEM).unwrap()].concat(),
        );
        let files = Fixture::new(&[("bundle.pem", &bundle)]);
        let identity = load_client_identity(&files.path("bundle.pem"), "", "").unwrap();
        assert!(matches!(identity.key, PrivateKeyDer::Sec1(_)));
        assert_is_the_fixture(&identity, false);
    }

    #[test]
    fn an_encrypted_pkcs8_key_opens_with_its_passphrase_only() {
        let files = Fixture::new(&[("cert.pem", CERT_PEM), ("key.pem", KEY_ENCRYPTED_PKCS8_PEM)]);
        let identity = load_client_identity(&files.path("cert.pem"), &files.path("key.pem"), "s3cret").unwrap();
        assert_is_the_fixture(&identity, true);

        let missing = load_client_identity(&files.path("cert.pem"), &files.path("key.pem"), "").err().unwrap();
        assert!(missing.contains("enter its passphrase"), "{missing}");
        let wrong = load_client_identity(&files.path("cert.pem"), &files.path("key.pem"), "nope").err().unwrap();
        assert!(wrong.contains("doesn't open"), "{wrong}");
    }

    #[test]
    fn a_traditional_encrypted_key_opens_with_its_passphrase() {
        let files = Fixture::new(&[("cert.pem", CERT_PEM), ("key.pem", KEY_ENCRYPTED_TRADITIONAL_PEM)]);
        let identity = load_client_identity(&files.path("cert.pem"), &files.path("key.pem"), "s3cret").unwrap();
        assert!(matches!(identity.key, PrivateKeyDer::Sec1(_)));
        assert_is_the_fixture(&identity, false);
        assert!(load_client_identity(&files.path("cert.pem"), &files.path("key.pem"), "nope").is_err());
    }

    #[test]
    fn a_modern_pkcs12_bundle() {
        let files = Fixture::new(&[("client.p12", P12_MODERN)]);
        let identity = load_client_identity(&files.path("client.p12"), "", "s3cret").unwrap();
        assert_is_the_fixture(&identity, true);
        let wrong = load_client_identity(&files.path("client.p12"), "", "nope").err().unwrap();
        assert!(wrong.contains("doesn't open"), "{wrong}");
    }

    #[test]
    fn a_legacy_pkcs12_bundle_with_3des_and_rc2() {
        // Named `.pfx` and read by content either way.
        let files = Fixture::new(&[("client.pfx", P12_LEGACY)]);
        let identity = load_client_identity(&files.path("client.pfx"), "", "s3cret").unwrap();
        assert_is_the_fixture(&identity, true);
    }

    #[test]
    fn a_certificate_with_no_key_anywhere_says_what_is_missing() {
        let files = Fixture::new(&[("cert.pem", CERT_PEM)]);
        let error = load_client_identity(&files.path("cert.pem"), "", "").err().unwrap();
        assert!(error.contains("No private key"), "{error}");
    }

    #[test]
    fn the_websocket_config_carries_the_client_certificate() {
        let files = Fixture::new(&[("client.p12", P12_MODERN)]);
        let options = NetworkOptions {
            client_cert_path: files.path("client.p12"),
            client_cert_password: "s3cret".into(),
            ..NetworkOptions::default()
        };
        let config = rustls_config(&options).unwrap().expect("a client certificate needs a config of its own");
        assert!(config.client_auth_cert_resolver.has_certs());
        // Nothing set: the transport keeps its own default connector.
        assert!(rustls_config(&NetworkOptions::default()).unwrap().is_none());
    }

    /// A proxy that answers `CONNECT` with `status`, then echoes the tunnel.
    async fn fake_proxy(status: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            socket.write_all(format!("HTTP/1.1 {status}\r\n\r\n").as_bytes()).await.unwrap();
            let mut echo = [0u8; 5];
            if status.starts_with('2') && socket.read_exact(&mut echo).await.is_ok() {
                socket.write_all(&echo).await.unwrap();
            }
            String::from_utf8(head).unwrap()
        });
        (port, task)
    }

    #[tokio::test]
    async fn a_connect_tunnel_carries_bytes_and_credentials() {
        let (port, proxy) = fake_proxy("200 Connection established").await;
        let mut tunnel = connect_via_proxy(&format!("http://me:p%40ss@127.0.0.1:{port}"), "api.example.test", 443)
            .await
            .unwrap();
        tunnel.write_all(b"hello").await.unwrap();
        let mut back = [0u8; 5];
        tunnel.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"hello");

        let head = proxy.await.unwrap();
        assert!(head.starts_with("CONNECT api.example.test:443 HTTP/1.1\r\n"), "{head}");
        assert!(head.contains(&format!("Proxy-Authorization: Basic {}", B64.encode("me:p@ss"))), "{head}");
    }

    #[tokio::test]
    async fn a_refused_tunnel_is_an_error_that_names_the_answer() {
        let (port, _proxy) = fake_proxy("407 Proxy Authentication Required").await;
        let error = connect_via_proxy(&format!("http://127.0.0.1:{port}"), "api.example.test", 443)
            .await
            .err()
            .unwrap();
        assert!(error.contains("407"), "{error}");
        assert!(connect_via_proxy("socks5://127.0.0.1:1080", "api.example.test", 443).await.is_err());
    }
}
