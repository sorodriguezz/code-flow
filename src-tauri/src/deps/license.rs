//! The licence policy: an SPDX expression in, `ok` / `warn` / `flag` out.
//!
//! `MIT OR GPL-3.0` is fine — the user picks MIT; `MIT AND GPL-3.0` is not — both apply. So an `OR`
//! takes the best of its sides and an `AND` the worst, which is the whole of SPDX that matters here.

use serde::{Deserialize, Serialize};

use super::config::DepsConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LicenseStatus {
    Ok,
    Warn,
    Flag,
    /// The registry has no licence field at all (the Go proxy, Maven Central's search): nothing to
    /// judge, and nothing to blame the package for.
    Unavailable,
}

fn matches(pattern: &str, id: &str) -> bool {
    let (p, i) = (pattern.trim().to_ascii_uppercase(), id.trim().to_ascii_uppercase());
    match p.strip_suffix('*') {
        Some(prefix) => i.starts_with(prefix),
        None => p == i,
    }
}

fn unknown(id: &str) -> bool {
    let u = id.trim().to_ascii_uppercase();
    u.is_empty() || u == "UNKNOWN" || u == "NOASSERTION" || u == "NONE" || u == "UNLICENSED" || u.starts_with("SEE LICENSE")
}

fn judge_id(id: &str, config: &DepsConfig) -> LicenseStatus {
    // `Apache-2.0 WITH LLVM-exception` is judged by its licence; an exception only ever loosens it.
    let id = id.split(" WITH ").next().unwrap_or(id).trim().trim_end_matches('+');
    if unknown(id) {
        return if config.flag_unknown_license { LicenseStatus::Flag } else { LicenseStatus::Warn };
    }
    if config.license_allowed.iter().any(|p| matches(p, id)) {
        return LicenseStatus::Ok;
    }
    if config.license_flagged.iter().any(|p| matches(p, id)) {
        return LicenseStatus::Flag;
    }
    if config.license_warn.iter().any(|p| matches(p, id)) {
        return LicenseStatus::Warn;
    }
    // With an allow-list, anything off it deserves a look.
    if !config.license_allowed.is_empty() {
        return LicenseStatus::Warn;
    }
    LicenseStatus::Ok
}

struct Parser<'a> {
    tokens: Vec<&'a str>,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn expr(&mut self, config: &DepsConfig) -> LicenseStatus {
        let mut best = self.term(config);
        while self.tokens.get(self.pos).is_some_and(|t| t.eq_ignore_ascii_case("OR")) {
            self.pos += 1;
            best = best.min(self.term(config));
        }
        best
    }

    fn term(&mut self, config: &DepsConfig) -> LicenseStatus {
        let mut worst = self.factor(config);
        while self.tokens.get(self.pos).is_some_and(|t| t.eq_ignore_ascii_case("AND")) {
            self.pos += 1;
            worst = worst.max(self.factor(config));
        }
        worst
    }

    fn factor(&mut self, config: &DepsConfig) -> LicenseStatus {
        match self.tokens.get(self.pos).copied() {
            Some("(") => {
                self.pos += 1;
                let inner = self.expr(config);
                if self.tokens.get(self.pos) == Some(&")") {
                    self.pos += 1;
                }
                inner
            }
            Some(id) => {
                self.pos += 1;
                let mut full = id.to_string();
                if self.tokens.get(self.pos).is_some_and(|t| t.eq_ignore_ascii_case("WITH")) {
                    full.push_str(" WITH ");
                    full.push_str(self.tokens.get(self.pos + 1).copied().unwrap_or(""));
                    self.pos += 2;
                }
                judge_id(&full, config)
            }
            None => judge_id("", config),
        }
    }
}

/// Judges a licence. `None` is "the registry said nothing", which the unknown rule decides.
pub fn judge(license: Option<&str>, config: &DepsConfig) -> LicenseStatus {
    let text = license.unwrap_or("").replace('(', " ( ").replace(')', " ) ").replace('/', " OR ");
    let tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.is_empty() {
        return judge_id("", config);
    }
    Parser { tokens, pos: 0 }.expr(config)
}

/// Free text and Trove classifiers → an SPDX id, for PyPI, whose `license` field is whatever the
/// author typed. Unrecognised text is returned as written: the user can still read it.
pub fn normalize(raw: &str) -> String {
    let t = raw.trim();
    let lower = t.to_ascii_lowercase();
    let known: &[(&str, &str)] = &[
        ("gnu affero general public license v3", "AGPL-3.0"),
        ("gnu lesser general public license v3", "LGPL-3.0"),
        ("gnu lesser general public license v2", "LGPL-2.1"),
        ("gnu library or lesser general public license", "LGPL-2.1"),
        ("gnu general public license v3", "GPL-3.0"),
        ("gnu general public license v2", "GPL-2.0"),
        ("gnu general public license", "GPL-3.0"),
        ("apache software license", "Apache-2.0"),
        ("apache license 2.0", "Apache-2.0"),
        ("apache 2.0", "Apache-2.0"),
        ("apache-2", "Apache-2.0"),
        ("mozilla public license 2.0", "MPL-2.0"),
        ("bsd 3-clause", "BSD-3-Clause"),
        ("bsd 2-clause", "BSD-2-Clause"),
        ("bsd license", "BSD-3-Clause"),
        ("mit license", "MIT"),
        ("isc license", "ISC"),
        ("python software foundation license", "PSF-2.0"),
        ("the unlicense", "Unlicense"),
    ];
    let body = lower.rsplit(" :: ").next().unwrap_or(&lower);
    for (needle, spdx) in known {
        if body.starts_with(needle) {
            return (*spdx).to_string();
        }
    }
    match body {
        "mit" => "MIT".into(),
        "bsd" => "BSD-3-Clause".into(),
        "apache" | "apache2" => "Apache-2.0".into(),
        "gpl" | "gplv3" => "GPL-3.0".into(),
        "lgpl" => "LGPL-3.0".into(),
        _ => t.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_the_default_policy() {
        let c = DepsConfig::default();
        assert_eq!(judge(Some("MIT"), &c), LicenseStatus::Ok);
        assert_eq!(judge(Some("GPL-3.0-only"), &c), LicenseStatus::Flag);
        assert_eq!(judge(Some("AGPL-3.0-or-later"), &c), LicenseStatus::Flag);
        assert_eq!(judge(Some("LGPL-2.1"), &c), LicenseStatus::Warn);
        assert_eq!(judge(Some("SSPL-1.0"), &c), LicenseStatus::Flag);
        assert_eq!(judge(Some("BUSL-1.1"), &c), LicenseStatus::Flag);
        assert_eq!(judge(None, &c), LicenseStatus::Flag);
        assert_eq!(judge(Some("UNLICENSED"), &c), LicenseStatus::Flag);
        assert_eq!(judge(Some("Apache-2.0 WITH LLVM-exception"), &c), LicenseStatus::Ok);
    }

    #[test]
    fn or_takes_the_best_side_and_and_the_worst() {
        let c = DepsConfig::default();
        assert_eq!(judge(Some("MIT OR GPL-3.0"), &c), LicenseStatus::Ok);
        assert_eq!(judge(Some("MIT/Apache-2.0"), &c), LicenseStatus::Ok);
        assert_eq!(judge(Some("MIT AND GPL-3.0"), &c), LicenseStatus::Flag);
        assert_eq!(judge(Some("(MIT AND LGPL-3.0) OR GPL-2.0"), &c), LicenseStatus::Warn);
    }

    #[test]
    fn honours_an_allow_list_and_a_soft_unknown() {
        let c = DepsConfig { license_allowed: vec!["MIT".into(), "Apache-*".into()], flag_unknown_license: false, ..Default::default() };
        assert_eq!(judge(Some("Apache-2.0"), &c), LicenseStatus::Ok);
        assert_eq!(judge(Some("BSD-3-Clause"), &c), LicenseStatus::Warn);
        assert_eq!(judge(None, &c), LicenseStatus::Warn);
    }

    #[test]
    fn reads_pypi_classifiers_and_free_text() {
        assert_eq!(normalize("License :: OSI Approved :: MIT License"), "MIT");
        assert_eq!(normalize("License :: OSI Approved :: GNU General Public License v3 (GPLv3)"), "GPL-3.0");
        assert_eq!(normalize("License :: OSI Approved :: Apache Software License"), "Apache-2.0");
        assert_eq!(normalize("BSD"), "BSD-3-Clause");
        assert_eq!(normalize("Custom EULA"), "Custom EULA");
    }
}
