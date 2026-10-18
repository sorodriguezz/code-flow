//! PuTTY's `.ppk` keys, read and handed to OpenSSH — the way a Windows user's existing keys reach
//! the system `ssh` this app runs, which cannot read them.
//!
//! Both formats PuTTY has written: version 2 (SHA-1 key stretch, HMAC-SHA-1) and version 3
//! (Argon2, HMAC-SHA-256), encrypted with AES-256-CBC or not at all. The key is checked against its
//! MAC before anything is done with it — a wrong passphrase is told apart from a damaged file.
//!
//! Where the converted key goes is the caller's choice and the reason this exists at all:
//! **the agent** (`ssh-add -`, from standard input, so the unprotected key never touches the disk),
//! or **a file** in `~/.ssh` beside the `.ppk`, which OpenSSH then reads like any other — written
//! without a passphrase, which the UI says before it is chosen.

use std::path::{Path, PathBuf};

use base64::Engine;
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use sha1::{Digest, Sha1};

/// A `.ppk` read into its parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PpkFile {
    pub version: u8,
    pub algorithm: String,
    pub encryption: String,
    pub comment: String,
    pub public: Vec<u8>,
    pub private: Vec<u8>,
    pub mac: Vec<u8>,
    /// Version 3's Argon2 settings: variant, memory (KiB), passes, parallelism, salt.
    pub argon: Option<(String, u32, u32, u32, Vec<u8>)>,
}

fn hex(text: &str) -> Result<Vec<u8>, String> {
    let text = text.trim();
    if text.len() % 2 != 0 {
        return Err("a hexadecimal field has an odd length".into());
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|_| "a hexadecimal field is not hexadecimal".to_string())).collect()
}

/// The value of the next line, which must be `name: value`.
fn take<'a>(lines: &mut impl Iterator<Item = &'a str>, name: &str) -> Result<String, String> {
    let line = lines.next().ok_or_else(|| format!("the key ends before its {name}"))?;
    line.strip_prefix(&format!("{name}:")).map(|v| v.trim().to_string()).ok_or_else(|| format!("expected {name}, found «{line}»"))
}

/// The next `count` lines, joined and base64-decoded.
fn take_block<'a>(lines: &mut impl Iterator<Item = &'a str>, count: usize) -> Result<Vec<u8>, String> {
    let joined: String = (0..count).map(|_| lines.next().unwrap_or_default().trim().to_string()).collect();
    base64::engine::general_purpose::STANDARD.decode(joined).map_err(|_| "a key block is not base64".to_string())
}

/// Reads the text of a `.ppk`.
pub fn parse(text: &str) -> Result<PpkFile, String> {
    let mut lines = text.lines().map(str::trim_end);
    let first = lines.next().ok_or("the file is empty")?;
    let (version, algorithm) = if let Some(rest) = first.strip_prefix("PuTTY-User-Key-File-3:") {
        (3, rest.trim().to_string())
    } else if let Some(rest) = first.strip_prefix("PuTTY-User-Key-File-2:") {
        (2, rest.trim().to_string())
    } else {
        return Err("not a PuTTY key (.ppk) of version 2 or 3".into());
    };
    let encryption = take(&mut lines, "Encryption")?;
    let comment = take(&mut lines, "Comment")?;
    let public_lines: usize = take(&mut lines, "Public-Lines")?.parse().map_err(|_| "Public-Lines is not a number")?;
    let public = take_block(&mut lines, public_lines)?;
    let argon = if version == 3 && encryption != "none" {
        let variant = take(&mut lines, "Key-Derivation")?;
        let memory = take(&mut lines, "Argon2-Memory")?.parse().map_err(|_| "Argon2-Memory is not a number")?;
        let passes = take(&mut lines, "Argon2-Passes")?.parse().map_err(|_| "Argon2-Passes is not a number")?;
        let parallelism = take(&mut lines, "Argon2-Parallelism")?.parse().map_err(|_| "Argon2-Parallelism is not a number")?;
        let salt = hex(&take(&mut lines, "Argon2-Salt")?)?;
        Some((variant, memory, passes, parallelism, salt))
    } else {
        None
    };
    let private_lines: usize = take(&mut lines, "Private-Lines")?.parse().map_err(|_| "Private-Lines is not a number")?;
    let private = take_block(&mut lines, private_lines)?;
    let mac = hex(&take(&mut lines, "Private-MAC")?)?;
    if encryption != "none" && encryption != "aes256-cbc" {
        return Err(format!("unknown encryption «{encryption}»"));
    }
    Ok(PpkFile { version, algorithm, encryption, comment, public, private, mac, argon })
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// Reads SSH wire strings (and mpints, which are strings) off a blob, in order.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn string(&mut self) -> Result<&'a [u8], String> {
        if self.0.len() < 4 {
            return Err("the key data ends early".into());
        }
        let len = u32::from_be_bytes([self.0[0], self.0[1], self.0[2], self.0[3]]) as usize;
        let rest = &self.0[4..];
        if rest.len() < len {
            return Err("the key data ends early".into());
        }
        self.0 = &rest[len..];
        Ok(&rest[..len])
    }
}

/// The private blob, decrypted and checked against the MAC. A MAC that does not match is a wrong
/// passphrase on an encrypted key, and a damaged file on a plain one.
pub fn unlock(ppk: &PpkFile, passphrase: &str) -> Result<Vec<u8>, String> {
    let encrypted = ppk.encryption != "none";
    let (cipher_key, iv, mac_key): (Vec<u8>, Vec<u8>, Vec<u8>) = match (ppk.version, encrypted) {
        (3, true) => {
            let (variant, memory, passes, parallelism, salt) = ppk.argon.clone().ok_or("the key has no Argon2 settings")?;
            let algorithm = match variant.as_str() {
                "Argon2id" => argon2::Algorithm::Argon2id,
                "Argon2i" => argon2::Algorithm::Argon2i,
                "Argon2d" => argon2::Algorithm::Argon2d,
                other => return Err(format!("unknown key derivation «{other}»")),
            };
            let params = argon2::Params::new(memory, passes, parallelism, Some(80)).map_err(|e| e.to_string())?;
            let mut out = [0u8; 80];
            argon2::Argon2::new(algorithm, argon2::Version::V0x13, params)
                .hash_password_into(passphrase.as_bytes(), &salt, &mut out)
                .map_err(|e| e.to_string())?;
            (out[..32].to_vec(), out[32..48].to_vec(), out[48..].to_vec())
        }
        (3, false) => (Vec::new(), Vec::new(), Vec::new()),
        (_, _) => {
            let block = |n: u32| {
                let mut hash = Sha1::new();
                hash.update(n.to_be_bytes());
                hash.update(passphrase.as_bytes());
                hash.finalize().to_vec()
            };
            let mut key = block(0);
            key.extend(block(1));
            key.truncate(32);
            let mut mac = Sha1::new();
            mac.update(b"putty-private-key-file-mac-key");
            if encrypted {
                mac.update(passphrase.as_bytes());
            }
            (key, vec![0u8; 16], mac.finalize().to_vec())
        }
    };
    let mut private = ppk.private.clone();
    if encrypted {
        if private.len() % 16 != 0 {
            return Err("the encrypted part is not a whole number of blocks".into());
        }
        let decryptor = cbc::Decryptor::<aes::Aes256>::new_from_slices(&cipher_key, &iv).map_err(|e| e.to_string())?;
        decryptor.decrypt_padded_mut::<NoPadding>(&mut private).map_err(|_| "the key could not be decrypted".to_string())?;
    }
    let mut data = Vec::new();
    put_string(&mut data, ppk.algorithm.as_bytes());
    put_string(&mut data, ppk.encryption.as_bytes());
    put_string(&mut data, ppk.comment.as_bytes());
    put_string(&mut data, &ppk.public);
    put_string(&mut data, &private);
    let matches = if ppk.version == 3 {
        let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(&mac_key).map_err(|e| e.to_string())?;
        mac.update(&data);
        mac.verify_slice(&ppk.mac).is_ok()
    } else {
        let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(&mac_key).map_err(|e| e.to_string())?;
        mac.update(&data);
        mac.verify_slice(&ppk.mac).is_ok()
    };
    if !matches {
        return Err(if encrypted { "wrong passphrase".into() } else { "the key file is damaged (its MAC does not match)".into() });
    }
    Ok(private)
}

/// The key as OpenSSH's own private key file (`openssh-key-v1`, unencrypted) and its `.pub` line.
pub fn to_openssh(ppk: &PpkFile, private: &[u8]) -> Result<(String, String), String> {
    let mut public = Reader(&ppk.public);
    let algorithm = std::str::from_utf8(public.string()?).map_err(|_| "the key type is not text")?.to_string();
    let mut secret = Reader(private);
    let mut body = Vec::new();
    put_string(&mut body, algorithm.as_bytes());
    match algorithm.as_str() {
        "ssh-rsa" => {
            let (e, n) = (public.string()?, public.string()?);
            let (d, p, q, iqmp) = (secret.string()?, secret.string()?, secret.string()?, secret.string()?);
            for part in [n, e, d, iqmp, p, q] {
                put_string(&mut body, part);
            }
        }
        "ssh-ed25519" => {
            let point = public.string()?;
            let seed = secret.string()?;
            put_string(&mut body, point);
            let mut both = seed.to_vec();
            both.extend_from_slice(point);
            put_string(&mut body, &both);
        }
        curve if curve.starts_with("ecdsa-sha2-") => {
            let (name, point) = (public.string()?, public.string()?);
            let d = secret.string()?;
            for part in [name, point, d] {
                put_string(&mut body, part);
            }
        }
        other => return Err(format!("«{other}» keys are not converted (RSA, Ed25519 and ECDSA are)")),
    }
    put_string(&mut body, ppk.comment.as_bytes());

    let check: u32 = rand::random();
    let mut section = Vec::new();
    section.extend_from_slice(&check.to_be_bytes());
    section.extend_from_slice(&check.to_be_bytes());
    section.extend_from_slice(&body);
    let mut pad = 1u8;
    while section.len() % 8 != 0 {
        section.push(pad);
        pad += 1;
    }

    let mut file = b"openssh-key-v1\0".to_vec();
    put_string(&mut file, b"none");
    put_string(&mut file, b"none");
    put_string(&mut file, b"");
    file.extend_from_slice(&1u32.to_be_bytes());
    put_string(&mut file, &ppk.public);
    put_string(&mut file, &section);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&file);
    let wrapped: Vec<&str> = encoded.as_bytes().chunks(70).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
    let pem = format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\n", wrapped.join("\n"));
    let pub_line = format!("{algorithm} {} {}\n", base64::engine::general_purpose::STANDARD.encode(&ppk.public), ppk.comment).replace(" \n", "\n");
    Ok((pem, pub_line))
}

/// Where a converted key went.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// The private key file written, when the key went to a file.
    pub path: Option<String>,
    pub comment: String,
    pub algorithm: String,
}

/// Reads `path`, unlocks it and either adds it to the running agent or writes it beside itself as
/// an OpenSSH key (`id.ppk` → `id`, refusing to overwrite).
pub async fn import(path: &Path, passphrase: &str, to_agent: bool) -> Result<Imported, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let ppk = parse(&text)?;
    let private = unlock(&ppk, passphrase)?;
    let (pem, pub_line) = to_openssh(&ppk, &private)?;
    if to_agent {
        add_to_agent(&pem).await?;
        return Ok(Imported { path: None, comment: ppk.comment, algorithm: ppk.algorithm });
    }
    let target: PathBuf = path.with_extension("");
    if target.exists() {
        return Err(format!("{} already exists — it is not overwritten", target.display()));
    }
    write_private(&target, &pem)?;
    let _ = std::fs::write(target.with_extension("pub"), pub_line);
    Ok(Imported { path: Some(target.to_string_lossy().into_owned()), comment: ppk.comment, algorithm: ppk.algorithm })
}

/// A private key file the owner alone can read — what OpenSSH insists on before it will use one.
fn write_private(path: &Path, pem: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        file.write_all(pem.as_bytes()).map_err(|e| e.to_string())
    }
    #[cfg(not(unix))]
    {
        // A file in the user's own profile inherits an owner-only ACL, which is what Windows'
        // OpenSSH checks for.
        std::fs::write(path, pem).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// `ssh-add -`: the key read from standard input, so the unprotected copy never touches the disk.
async fn add_to_agent(pem: &str) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut cmd = crate::proc::command("ssh-add");
    cmd.arg("-").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("could not run ssh-add: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(pem.as_bytes()).await.map_err(|e| e.to_string())?;
        drop(stdin);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| "ssh-add did not answer".to_string())?
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let said = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if said.contains("Could not open a connection") || said.contains("Error connecting to agent") {
            "no SSH agent is running (on Windows: start the «OpenSSH Authentication Agent» service)".into()
        } else {
            format!("ssh-add: {said}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway Ed25519 key, version 3, written by puttygen with no passphrase.
    const PLAIN_V3: &str = "PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: cf-test
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIDkOTDB8Kz5b9qLxMmwSvjkOkmaeSuDl6P1BqTyR
Q7lB
Private-Lines: 1
AAAAIBgk8AXcl80qBwbrMqm6nkQPqSs3K8bx0hhexhhWlmYM
Private-MAC: 0000000000000000000000000000000000000000000000000000000000000000
";

    #[test]
    fn a_ppk_is_read_into_its_parts() {
        let ppk = parse(PLAIN_V3).unwrap();
        assert_eq!((ppk.version, ppk.algorithm.as_str(), ppk.encryption.as_str(), ppk.comment.as_str()), (3, "ssh-ed25519", "none", "cf-test"));
        assert_eq!(ppk.public.len(), 51);
        assert_eq!(ppk.private.len(), 36);
        assert!(parse("-----BEGIN OPENSSH PRIVATE KEY-----").is_err());
    }

    #[test]
    fn a_mac_that_does_not_match_is_refused_and_a_matching_one_converts() {
        let mut ppk = parse(PLAIN_V3).unwrap();
        assert!(unlock(&ppk, "").unwrap_err().contains("damaged"));
        // Sign it the way PuTTY does, then it opens and converts.
        let mut data = Vec::new();
        put_string(&mut data, ppk.algorithm.as_bytes());
        put_string(&mut data, ppk.encryption.as_bytes());
        put_string(&mut data, ppk.comment.as_bytes());
        put_string(&mut data, &ppk.public);
        put_string(&mut data, &ppk.private);
        let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(&[]).unwrap();
        mac.update(&data);
        ppk.mac = mac.finalize().into_bytes().to_vec();
        let private = unlock(&ppk, "").unwrap();
        let (pem, pub_line) = to_openssh(&ppk, &private).unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        assert!(pub_line.starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"));
        assert!(pub_line.trim_end().ends_with("cf-test"));
        let body = base64::engine::general_purpose::STANDARD
            .decode(pem.lines().filter(|l| !l.starts_with("-----")).collect::<String>())
            .unwrap();
        assert!(body.starts_with(b"openssh-key-v1\0"));
    }
}
