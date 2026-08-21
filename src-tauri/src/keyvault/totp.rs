//! Time-based one-time passwords (RFC 6238), for the entries that carry a 2FA secret.
//!
//! No crate for this, and it is not a case of not-invented-here: TOTP is HMAC over a big-endian
//! counter, truncated — about thirty lines — and every primitive it needs is already a dependency
//! for the API client's auth schemes (`hmac`, `sha1`, `sha2`). A crate here would be a supply-chain
//! surface for code the reader can check by eye.
//!
//! **The secret never leaves the backend as a secret.** The frontend asks for a *code*, and gets
//! six digits plus the seconds remaining. That keeps the shared secret out of the webview's memory
//! and out of any renderer bug's reach, which is the whole reason the code is generated here rather
//! than in TypeScript where the countdown lives.

use hmac::{Hmac, Mac};

/// Which hash the authenticator uses. Almost every one is SHA-1 — the RFC's default, and what
/// Google Authenticator emits — but `otpauth://` can name the others and a few enterprise IdPs do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TotpAlgorithm {
    Sha1,
    Sha256,
    Sha512,
}

impl TotpAlgorithm {
    fn parse(name: &str) -> Self {
        match name.to_ascii_uppercase().as_str() {
            "SHA256" => Self::Sha256,
            "SHA512" => Self::Sha512,
            _ => Self::Sha1,
        }
    }
}

/// One entry's TOTP settings, as parsed from an `otpauth://` URI or filled in by hand.
#[derive(Debug, Clone)]
pub struct TotpConfig {
    /// The shared secret, already base32-decoded.
    pub secret: Vec<u8>,
    pub digits: u32,
    pub period: u64,
    pub algorithm: TotpAlgorithm,
}

impl Default for TotpConfig {
    fn default() -> Self {
        // The RFC's defaults, which is what an authenticator assumes when the URI omits them.
        Self { secret: Vec::new(), digits: 6, period: 30, algorithm: TotpAlgorithm::Sha1 }
    }
}

/// Reads either a whole `otpauth://totp/...` URI or a bare base32 secret.
///
/// Both are accepted because both are what a user has to hand: the URI is what a QR code decodes
/// to, and the bare secret is what the "can't scan it?" link shows. Refusing either would send them
/// to a text editor to convert one into the other.
pub fn parse(input: &str) -> Result<TotpConfig, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("There is no 2FA secret here.".to_string());
    }
    if !trimmed.to_ascii_lowercase().starts_with("otpauth://") {
        return Ok(TotpConfig { secret: decode_secret(trimmed)?, ..TotpConfig::default() });
    }

    // Hand-parsed rather than through `url`: the crate is here, but an `otpauth://` URI is a
    // scheme it has no opinion about and the query string is all that matters.
    let query = trimmed.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut config = TotpConfig::default();
    let mut secret = None;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        let value = percent_decode(value);
        match key.to_ascii_lowercase().as_str() {
            "secret" => secret = Some(value),
            "digits" => {
                if let Ok(digits) = value.parse::<u32>() {
                    config.digits = digits.clamp(6, 10);
                }
            }
            "period" => {
                if let Ok(period) = value.parse::<u64>() {
                    config.period = period.max(1);
                }
            }
            "algorithm" => config.algorithm = TotpAlgorithm::parse(&value),
            _ => {}
        }
    }
    let secret = secret.ok_or_else(|| {
        "This otpauth link has no `secret` in it, so there is nothing to generate codes from."
            .to_string()
    })?;
    config.secret = decode_secret(&secret)?;
    Ok(config)
}

/// Base32, RFC 4648, case-insensitive and padding-optional.
///
/// Authenticator secrets are handed out in every combination of those — lower case with spaces
/// every four characters is what a "can't scan it?" panel usually shows — so all of it is
/// normalised rather than refused.
fn decode_secret(raw: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let unpadded = cleaned.trim_end_matches('=');
    data_encoding::BASE32_NOPAD
        .decode(unpadded.as_bytes())
        .map_err(|_| {
            "This does not look like a 2FA secret. It should be the base32 code the site showed \
             beside the QR, or the whole otpauth:// link."
                .to_string()
        })
}

fn percent_decode(value: &str) -> String {
    percent_encoding::percent_decode_str(value)
        .decode_utf8_lossy()
        .into_owned()
}

/// The current code and how long it lasts.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TotpCode {
    pub code: String,
    /// Seconds until this code stops working. What the ring around the code counts down.
    pub seconds_remaining: u64,
    pub period: u64,
}

/// Generates the code for `unix_seconds`.
///
/// Taking the time as an argument rather than reading the clock is what makes this testable against
/// the RFC's own vectors — which is the only way to be sure an implementation of this is right.
pub fn code_at(config: &TotpConfig, unix_seconds: u64) -> TotpCode {
    let counter = unix_seconds / config.period;
    let digest = match config.algorithm {
        TotpAlgorithm::Sha1 => hmac_sha1(&config.secret, counter),
        TotpAlgorithm::Sha256 => hmac_sha256(&config.secret, counter),
        TotpAlgorithm::Sha512 => hmac_sha512(&config.secret, counter),
    };

    // Dynamic truncation, RFC 4226 §5.4: the low nibble of the last byte picks where to read four
    // bytes from, and the top bit is masked off so the result is positive in every language.
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((digest[offset] & 0x7f) as u64) << 24
        | (digest[offset + 1] as u64) << 16
        | (digest[offset + 2] as u64) << 8
        | (digest[offset + 3] as u64);
    let modulus = 10u64.pow(config.digits);

    TotpCode {
        code: format!("{:0width$}", binary % modulus, width = config.digits as usize),
        seconds_remaining: config.period - (unix_seconds % config.period),
        period: config.period,
    }
}

/// HMAC over the counter, per algorithm.
///
/// Three concrete functions rather than one generic over `Digest`: the bounds that would make a
/// single version compile (`CoreProxy`, `EagerHash`, `BlockSizeUser`) are four lines of trait
/// plumbing that say nothing, and `digest` is not even a direct dependency here. Three two-line
/// functions are the honest amount of code for three algorithms.
fn hmac_sha1(secret: &[u8], counter: u64) -> Vec<u8> {
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(&counter.to_be_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hmac_sha256(secret: &[u8], counter: u64) -> Vec<u8> {
    let mut mac =
        Hmac::<sha2::Sha256>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(&counter.to_be_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hmac_sha512(secret: &[u8], counter: u64) -> Vec<u8> {
    let mut mac =
        Hmac::<sha2::Sha512>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(&counter.to_be_bytes());
    mac.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238's own test vectors, on the RFC's secret (`"12345678901234567890"`).
    ///
    /// This is the only way to know an implementation of this is correct rather than merely
    /// plausible: a truncation that is off by one byte still produces six believable digits.
    #[test]
    fn rfc_6238_vectors_match() {
        let secret = b"12345678901234567890".to_vec();
        let sha1 = TotpConfig { secret: secret.clone(), digits: 8, period: 30, algorithm: TotpAlgorithm::Sha1 };
        for (at, expected) in [
            (59u64, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
            (20_000_000_000, "65353130"),
        ] {
            assert_eq!(code_at(&sha1, at).code, expected, "SHA-1 at {at}");
        }

        let sha256 = TotpConfig {
            secret: b"12345678901234567890123456789012".to_vec(),
            digits: 8,
            period: 30,
            algorithm: TotpAlgorithm::Sha256,
        };
        assert_eq!(code_at(&sha256, 59).code, "46119246");

        let sha512 = TotpConfig {
            secret: b"1234567890123456789012345678901234567890123456789012345678901234".to_vec(),
            digits: 8,
            period: 30,
            algorithm: TotpAlgorithm::Sha512,
        };
        assert_eq!(code_at(&sha512, 59).code, "90693936");
    }

    #[test]
    fn the_countdown_is_what_is_left_of_the_period() {
        let config = TotpConfig { secret: b"1234567890".to_vec(), ..TotpConfig::default() };
        assert_eq!(code_at(&config, 0).seconds_remaining, 30);
        assert_eq!(code_at(&config, 29).seconds_remaining, 1);
        assert_eq!(code_at(&config, 30).seconds_remaining, 30);
    }

    /// The code must not change within its window, and must change at the boundary.
    #[test]
    fn a_code_holds_for_its_whole_period() {
        let config = TotpConfig { secret: b"12345678901234567890".to_vec(), ..TotpConfig::default() };
        assert_eq!(code_at(&config, 60).code, code_at(&config, 89).code);
        assert_ne!(code_at(&config, 89).code, code_at(&config, 90).code);
    }

    #[test]
    fn an_otpauth_uri_is_read_whole() {
        let config = parse(
            "otpauth://totp/CodeFlow:ana@example.test?secret=JBSWY3DPEHPK3PXP&issuer=CodeFlow&digits=8&period=60&algorithm=SHA256",
        )
        .unwrap();
        assert_eq!(config.digits, 8);
        assert_eq!(config.period, 60);
        assert_eq!(config.algorithm, TotpAlgorithm::Sha256);
        assert!(!config.secret.is_empty());
    }

    /// A URI with no options takes the RFC's defaults, which is what an authenticator assumes.
    #[test]
    fn a_bare_uri_takes_the_standard_defaults() {
        let config = parse("otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP").unwrap();
        assert_eq!((config.digits, config.period, config.algorithm), (6, 30, TotpAlgorithm::Sha1));
    }

    /// What the "can't scan the code?" panel shows: lower case, spaced, sometimes padded.
    #[test]
    fn a_secret_is_accepted_however_the_site_spelled_it() {
        let canonical = parse("JBSWY3DPEHPK3PXP").unwrap().secret;
        for spelling in ["jbswy3dpehpk3pxp", "JBSW Y3DP EHPK 3PXP", "JBSWY3DPEHPK3PXP======", "jbsw-y3dp-ehpk-3pxp"] {
            assert_eq!(parse(spelling).unwrap().secret, canonical, "{spelling}");
        }
    }

    #[test]
    fn something_that_is_not_a_secret_says_so() {
        assert!(parse("").is_err());
        assert!(parse("not base32 !!!").is_err());
        assert!(parse("otpauth://totp/Example?issuer=NoSecret").is_err());
    }
}
