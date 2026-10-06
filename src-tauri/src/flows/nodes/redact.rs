//! «Ocultar datos sensibles» (`transform.redact`): personal data and secrets taken out of the items'
//! text before it reaches a model, a log, a ticket or a chat.
//!
//! **Found, then checked.** A pattern only proposes: a card number must pass Luhn, a RUT its check
//! digit, an IBAN its mod 97 and an IPv6 address the parser — so an order number or a time of day is
//! left alone. Secrets are the shapes providers give their keys (GitHub, GitLab, Slack, Stripe,
//! AWS, Google, OpenAI/Anthropic, JWTs, private key blocks) plus `password=…`-style assignments,
//! whose name is kept and value hidden.
//!
//! **Four ways to hide.** A placeholder (`[EMAIL]`), a mask that keeps the shape and the last digits
//! people check (`•••• •••• •••• 1111`), a stable hash (`[EMAIL:3f2a9c1b]` — the same address gives
//! the same tag in every run of the flow, so items can still be grouped), or nothing at all.

use std::collections::BTreeMap;
use std::net::Ipv6Addr;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{strings, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};
use crate::flows::value::{get_path, set_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Placeholder,
    Mask,
    Hash,
    Remove,
}

impl Mode {
    pub fn of(raw: &str) -> Mode {
        match raw {
            "redactMask" => Mode::Mask,
            "redactHash" => Mode::Hash,
            "redactRemove" => Mode::Remove,
            _ => Mode::Placeholder,
        }
    }
}

/// One kind of thing to hide: its name (the report's key and the placeholder) and how it is found.
pub struct Detector {
    pub kind: String,
    pattern: Regex,
    /// The capture group that is the secret part — `password=` keeps its name.
    group: Option<&'static str>,
    check: fn(&str) -> bool,
}

fn always(_: &str) -> bool {
    true
}

fn digits(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).collect()
}

/// Luhn, the check every payment card number passes.
pub fn luhn(number: &str) -> bool {
    let digits = digits(number);
    if !(13..=19).contains(&digits.len()) {
        return false;
    }
    let sum: u32 = digits
        .chars()
        .rev()
        .enumerate()
        .map(|(i, c)| {
            let d = c.to_digit(10).unwrap_or(0);
            if i % 2 == 1 {
                let doubled = d * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                d
            }
        })
        .sum();
    sum % 10 == 0
}

/// A Chilean RUT's check digit (módulo 11): `12.345.678-5`.
pub fn rut_ok(rut: &str) -> bool {
    let Some((body, check)) = rut.rsplit_once('-') else { return false };
    let body = digits(body);
    if body.is_empty() || body.len() > 8 {
        return false;
    }
    let mut factor = 2;
    let mut sum = 0;
    for c in body.chars().rev() {
        sum += c.to_digit(10).unwrap_or(0) * factor;
        factor = if factor == 7 { 2 } else { factor + 1 };
    }
    let expected = match 11 - (sum % 11) {
        11 => '0',
        10 => 'K',
        n => char::from_digit(n, 10).unwrap_or('0'),
    };
    check.trim().to_ascii_uppercase().starts_with(expected)
}

/// An IBAN's mod 97 check.
pub fn iban_ok(iban: &str) -> bool {
    let compact: String = iban.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_uppercase();
    if compact.len() < 15 || compact.len() > 34 {
        return false;
    }
    let rearranged = format!("{}{}", &compact[4..], &compact[..4]);
    let mut remainder: u64 = 0;
    for c in rearranged.chars() {
        let value = match c {
            '0'..='9' => c as u64 - '0' as u64,
            'A'..='Z' => c as u64 - 'A' as u64 + 10,
            _ => return false,
        };
        remainder = if value > 9 { (remainder * 100 + value) % 97 } else { (remainder * 10 + value) % 97 };
    }
    remainder == 1
}

fn phone_ok(phone: &str) -> bool {
    (8..=15).contains(&digits(phone).len())
}

fn ipv6_ok(candidate: &str) -> bool {
    candidate.matches(':').count() >= 2 && candidate.parse::<Ipv6Addr>().is_ok()
}

fn detector(kind: &str, pattern: &str, check: fn(&str) -> bool) -> Detector {
    Detector { kind: kind.to_string(), pattern: Regex::new(pattern).expect("a shipped pattern compiles"), group: None, check }
}

/// The provider key shapes, then the `name = value` assignments.
static SECRETS: LazyLock<Vec<Detector>> = LazyLock::new(|| {
    vec![
        detector("secret", r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", always),
        detector("secret", r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+", always),
        detector("secret", r"https://(?:discord|discordapp)\.com/api/webhooks/\d+/[A-Za-z0-9_-]+", always),
        detector("secret", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", always),
        detector("secret", r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b", always),
        detector("secret", r"\bgithub_pat_[A-Za-z0-9_]{22,}\b", always),
        detector("secret", r"\bglpat-[A-Za-z0-9_-]{20,}\b", always),
        detector("secret", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", always),
        detector("secret", r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b", always),
        detector("secret", r"\bAIza[0-9A-Za-z_-]{35}\b", always),
        detector("secret", r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b", always),
        detector("secret", r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", always),
        detector("secret", r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b", always),
        Detector {
            kind: "secret".into(),
            pattern: Regex::new(r"(?i)\bbearer\s+(?P<v>[A-Za-z0-9._~+/-]{20,}=*)").expect("a shipped pattern compiles"),
            group: Some("v"),
            check: always,
        },
        Detector {
            kind: "secret".into(),
            pattern: Regex::new(r#"(?i)\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*["']?(?P<v>[^\s"',;]{6,})"#)
                .expect("a shipped pattern compiles"),
            group: Some("v"),
            check: always,
        },
    ]
});

/// The detectors of `kinds` (the node's choices, `pii*`), in the order that keeps them apart:
/// secrets before everything (a token can look like a number), RUTs and cards before phones.
pub fn detectors(kinds: &[String], custom: &[String]) -> Result<Vec<&'static Detector>, String> {
    static OTHERS: LazyLock<Vec<Detector>> = LazyLock::new(|| {
        vec![
            detector("email", r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b", always),
            detector("iban", r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b", iban_ok),
            detector("card", r"\b\d(?:[ -]?\d){12,18}\b", luhn),
            detector("rut", r"\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b", rut_ok),
            detector("phone", r"\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}\b", phone_ok),
            detector("phone", r"\(?\b\d{2,4}\)?[ -]\d{3,4}[ -]\d{3,4}\b", phone_ok),
            detector("ip", r"\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b", always),
            detector("ip", r"[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}", ipv6_ok),
        ]
    });
    let wanted = |kind: &str| kinds.iter().any(|k| k.trim_start_matches("pii").eq_ignore_ascii_case(kind));
    let mut out: Vec<&'static Detector> = Vec::new();
    if wanted("secret") {
        out.extend(SECRETS.iter());
    }
    out.extend(OTHERS.iter().filter(|d| wanted(&d.kind)));
    // A custom pattern is compiled per call — it is the flow's, not the app's, so it is leaked
    // into a 'static only through this cache, keyed by its text.
    static CUSTOM: LazyLock<std::sync::Mutex<std::collections::HashMap<String, &'static Detector>>> = LazyLock::new(Default::default);
    for pattern in custom.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        let mut cache = CUSTOM.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(found) = cache.get(pattern) {
            out.push(found);
            continue;
        }
        if cache.len() > 256 {
            return Err("Too many different custom patterns in one session".into());
        }
        let regex = Regex::new(pattern).map_err(|e| format!("“{pattern}” is not a valid pattern: {e}"))?;
        let leaked: &'static Detector = Box::leak(Box::new(Detector { kind: "custom".into(), pattern: regex, group: None, check: always }));
        cache.insert(pattern.to_string(), leaked);
        out.push(leaked);
    }
    Ok(out)
}

/// `value` shown with only its shape: letters and digits as `•`, the last `keep` of them as written.
fn mask_keeping(value: &str, keep: usize) -> String {
    let total = value.chars().filter(|c| c.is_alphanumeric()).count();
    let mut seen = 0;
    value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                seen += 1;
                if seen > total.saturating_sub(keep) { c } else { '•' }
            } else {
                c
            }
        })
        .collect()
}

fn mask(kind: &str, value: &str) -> String {
    match kind {
        "email" => {
            let (user, domain) = value.split_once('@').unwrap_or((value, ""));
            let tld = domain.rsplit('.').next().unwrap_or_default();
            format!("{}•••@{}•••.{tld}", user.chars().next().unwrap_or('•'), domain.chars().next().unwrap_or('•'))
        }
        "card" | "iban" => mask_keeping(value, 4),
        "phone" => mask_keeping(value, 2),
        "rut" => {
            // The check digit says nothing on its own: the body goes, the check stays.
            let (body, check) = value.rsplit_once('-').unwrap_or((value, ""));
            format!("{}-{check}", mask_keeping(body, 0))
        }
        "secret" => format!("{}••••", value.chars().take(4).collect::<String>()),
        _ => mask_keeping(value, 0),
    }
}

fn tag(kind: &str) -> String {
    match kind {
        "custom" => "REDACTED".into(),
        other => other.to_ascii_uppercase(),
    }
}

/// What a found value becomes.
pub fn replacement(kind: &str, value: &str, mode: Mode, salt: &str) -> String {
    match mode {
        Mode::Placeholder => format!("[{}]", tag(kind)),
        Mode::Mask => mask(kind, value),
        Mode::Hash => {
            let normalized: String = value.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
            let digest = Sha256::digest(format!("{salt}\u{1f}{kind}\u{1f}{normalized}").as_bytes());
            let short: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("[{}:{short}]", tag(kind))
        }
        Mode::Remove => String::new(),
    }
}

/// `text` with everything the detectors find (and their checks confirm) replaced; `found` counts
/// what was, by kind.
pub fn redact_text(text: &str, detectors: &[&Detector], mode: Mode, salt: &str, found: &mut BTreeMap<String, usize>) -> String {
    let mut current = text.to_string();
    for detector in detectors {
        let mut out = String::with_capacity(current.len());
        let mut last = 0;
        for captures in detector.pattern.captures_iter(&current) {
            let Some(span) = (match detector.group {
                Some(name) => captures.name(name),
                None => captures.get(0),
            }) else {
                continue;
            };
            let value = span.as_str().trim_end_matches([' ', '-']);
            if value.is_empty() || !(detector.check)(value) {
                continue;
            }
            let end = span.start() + value.len();
            out.push_str(&current[last..span.start()]);
            out.push_str(&replacement(&detector.kind, value, mode, salt));
            last = end;
            *found.entry(detector.kind.clone()).or_default() += 1;
        }
        if last > 0 {
            out.push_str(&current[last..]);
            current = out;
        }
    }
    current
}

/// Every string inside `value`, redacted in place.
pub fn redact_value(value: &mut Value, detectors: &[&Detector], mode: Mode, salt: &str, found: &mut BTreeMap<String, usize>) {
    match value {
        Value::String(s) => {
            let redacted = redact_text(s, detectors, mode, salt, found);
            if redacted != *s {
                *s = redacted;
            }
        }
        Value::Array(list) => list.iter_mut().for_each(|entry| redact_value(entry, detectors, mode, salt, found)),
        Value::Object(map) => map.values_mut().for_each(|entry| redact_value(entry, detectors, mode, salt, found)),
        _ => {}
    }
}

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let kinds = strings(&ctx.params, "detect");
    let custom = strings(&ctx.params, "customPatterns");
    if kinds.is_empty() && custom.is_empty() {
        return Err(NodeError::failed("Choose what to hide, or write a pattern of your own"));
    }
    let detectors = detectors(&kinds, &custom).map_err(NodeError::Failed)?;
    let mode = Mode::of(&ctx.param_str("redactMode"));
    let report = ctx.param_str("reportField");
    // The flow's id seasons the hash: the same value tags alike in this flow, and only here.
    let salt = ctx.run.flow_id.clone();
    let items = ctx.items();
    let resolved = if items.is_empty() { Vec::new() } else { ctx.resolve_each().await? };
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let params = &resolved[index.min(resolved.len().saturating_sub(1))];
        let fields = strings(params, "redactFields");
        let mut json = item.json.clone();
        let mut found = BTreeMap::new();
        if fields.is_empty() {
            redact_value(&mut json, &detectors, mode, &salt, &mut found);
        } else {
            for field in &fields {
                if let Some(mut value) = get_path(&json, field).cloned() {
                    redact_value(&mut value, &detectors, mode, &salt, &mut found);
                    set_path(&mut json, field, value);
                }
            }
        }
        if !report.trim().is_empty() {
            set_path(&mut json, report.trim(), json!(found));
        }
        out.push(Item::paired(json, index));
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<&'static Detector> {
        let kinds: Vec<String> = ["piiEmail", "piiPhone", "piiRut", "piiCard", "piiIban", "piiIp", "piiSecret"].iter().map(|s| s.to_string()).collect();
        detectors(&kinds, &[]).unwrap()
    }

    fn redacted(text: &str, mode: Mode) -> (String, BTreeMap<String, usize>) {
        let mut found = BTreeMap::new();
        let out = redact_text(text, &all(), mode, "flow-1", &mut found);
        (out, found)
    }

    #[test]
    fn checks_keep_look_alikes_untouched() {
        assert!(luhn("4111 1111 1111 1111"));
        assert!(!luhn("4111 1111 1111 1112"));
        assert!(rut_ok("12.345.678-5"));
        assert!(!rut_ok("12.345.678-4"));
        assert!(rut_ok("10.000.013-k"));
        assert!(iban_ok("GB82 WEST 1234 5698 7654 32"));
        assert!(!iban_ok("GB82 WEST 1234 5698 7654 33"));

        let (out, found) = redacted("Pedido 4111111111111112 del 2026-10-06 a las 10:30:45, total $12.990", Mode::Placeholder);
        assert_eq!(out, "Pedido 4111111111111112 del 2026-10-06 a las 10:30:45, total $12.990", "{found:?}");
        assert!(found.is_empty());
    }

    #[test]
    fn personal_data_is_found_and_replaced_by_kind() {
        let text = "Ana (ana.perez@example.com, +56 9 8765 4321, RUT 12.345.678-5) pagó con 4111 1111 1111 1111 desde 192.168.1.20";
        let (out, found) = redacted(text, Mode::Placeholder);
        assert_eq!(out, "Ana ([EMAIL], [PHONE], RUT [RUT]) pagó con [CARD] desde [IP]");
        assert_eq!(found.get("email"), Some(&1));
        assert_eq!(found.get("card"), Some(&1));

        let (out, _) = redacted("tarjeta 4111 1111 1111 1111, rut 12.345.678-5, ana@example.com", Mode::Mask);
        assert_eq!(out, "tarjeta •••• •••• •••• 1111, rut ••.•••.•••-5, a•••@e•••.com");
    }

    #[test]
    fn secrets_keep_the_name_of_an_assignment() {
        let (out, found) = redacted("token=abcdef123456 y la clave ghp_0123456789abcdefghijABCDEFGHIJ012345", Mode::Placeholder);
        assert_eq!(out, "token=[SECRET] y la clave [SECRET]");
        assert_eq!(found.get("secret"), Some(&2));
        let (out, _) = redacted("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", Mode::Mask);
        assert_eq!(out, "Authorization: Bearer abcd••••");
    }

    #[test]
    fn hashes_are_stable_per_flow_and_custom_patterns_join_in() {
        let a = replacement("email", "Ana@Example.com", Mode::Hash, "flow-1");
        assert_eq!(a, replacement("email", "ana@example.com", Mode::Hash, "flow-1"), "the same address, the same tag");
        assert_ne!(a, replacement("email", "ana@example.com", Mode::Hash, "flow-2"), "another flow, another tag");
        assert!(a.starts_with("[EMAIL:") && a.len() == "[EMAIL:12345678]".len());

        let custom = detectors(&[], &["PED-\\d{5}".to_string()]).unwrap();
        let mut found = BTreeMap::new();
        assert_eq!(redact_text("Ver PED-12345", &custom, Mode::Placeholder, "f", &mut found), "Ver [REDACTED]");
        assert!(detectors(&[], &["(".to_string()]).is_err());

        let mut value = json!({"cliente": {"correo": "bo@example.com"}, "notas": ["llamar al +56 2 2345 6789"], "n": 3});
        let mut found = BTreeMap::new();
        redact_value(&mut value, &all(), Mode::Remove, "f", &mut found);
        assert_eq!(value, json!({"cliente": {"correo": ""}, "notas": ["llamar al "], "n": 3}));
    }
}
