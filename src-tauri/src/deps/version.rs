//! Versions and version requirements across six ecosystems, read with one tolerant grammar.
//!
//! npm and Cargo speak SemVer, NuGet nearly does, PyPI has PEP 440, Go puts a `v` in front and Maven
//! accepts almost anything (`31.1-jre`, `5.3.20.RELEASE`, `2.0-M1`). A strict parser per ecosystem
//! would be six parsers that each refuse the other five's habits; what the dependency report needs
//! is narrower — *which of two versions is newer*, *is this a pre-release*, and *how big is the jump*
//! — and that much reads the same everywhere once the numbers are separated from the qualifier.
//!
//! Cargo requirements are matched with the `semver` crate where it matters (picking which of several
//! locked versions a manifest means); everything else here is ecosystem-neutral on purpose.

use std::cmp::Ordering;

use super::Ecosystem;

/// One version, split into its numeric release and whatever follows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub nums: Vec<u64>,
    /// The qualifier after the numbers, without its separator: `beta.2`, `rc1`, `jre`, `post1`.
    pub pre: String,
    pub raw: String,
}

/// Qualifiers that name a *release*, not a preview of one. Maven's `-jre`/`.Final`/`.RELEASE` and
/// PEP 440's `.postN` would otherwise read as pre-releases and hide the newest Guava or Hibernate.
const RELEASE_QUALIFIERS: &[&str] = &["final", "release", "ga", "jre", "android", "sp", "r"];

impl Version {
    pub fn is_prerelease(&self) -> bool {
        if self.pre.is_empty() {
            return false;
        }
        let lower = self.pre.to_ascii_lowercase();
        let head: String = lower.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        if head == "post" || RELEASE_QUALIFIERS.contains(&head.as_str()) {
            return false;
        }
        true
    }

    /// 0 = pre-release, 1 = release, 2 = post-release — how the qualifier ranks against the bare
    /// release with the same numbers.
    fn rank(&self) -> u8 {
        if self.pre.is_empty() {
            return 1;
        }
        if self.pre.to_ascii_lowercase().starts_with("post") {
            return 2;
        }
        if self.is_prerelease() { 0 } else { 1 }
    }

    fn num(&self, i: usize) -> u64 {
        self.nums.get(i).copied().unwrap_or(0)
    }
}

/// Reads a version. `None` for anything that does not start with a number once a `v` or `=` is
/// stripped — a dist-tag, a git URL, a `${property}`.
pub fn parse(raw: &str) -> Option<Version> {
    let original = raw.trim();
    let mut s = original.trim_start_matches('=').trim();
    if let Some(rest) = s.strip_prefix(['v', 'V']) {
        if rest.starts_with(|c: char| c.is_ascii_digit()) {
            s = rest;
        }
    }
    // Build metadata never orders (SemVer §10).
    let s = s.split('+').next().unwrap_or("");
    if !s.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let mut nums = Vec::new();
    let mut rest = s;
    loop {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            break;
        }
        nums.push(digits.parse::<u64>().ok()?);
        rest = &rest[digits.len()..];
        // Another component only when a dot is followed by a digit: `1.0.dev1` stops before `dev1`.
        match rest.strip_prefix('.') {
            Some(after) if after.starts_with(|c: char| c.is_ascii_digit()) => rest = after,
            _ => break,
        }
    }
    let pre = rest.trim_start_matches(['-', '.', '_']).to_string();
    Some(Version { nums, pre, raw: original.to_string() })
}

/// Splits a qualifier into comparable pieces: `rc.10` → [rc, 10], `beta2` → [beta, 2].
fn pieces(pre: &str) -> Vec<Result<u64, String>> {
    let mut out = Vec::new();
    for chunk in pre.split(|c: char| !c.is_ascii_alphanumeric()).filter(|c| !c.is_empty()) {
        let mut current = String::new();
        let mut digit = None;
        for c in chunk.chars() {
            let is_digit = c.is_ascii_digit();
            if digit.is_some_and(|d| d != is_digit) {
                out.push(piece(&current));
                current.clear();
            }
            digit = Some(is_digit);
            current.push(c);
        }
        if !current.is_empty() {
            out.push(piece(&current));
        }
    }
    out
}

fn piece(s: &str) -> Result<u64, String> {
    s.parse::<u64>().map_err(|_| s.to_ascii_lowercase())
}

pub fn compare(a: &Version, b: &Version) -> Ordering {
    let len = a.nums.len().max(b.nums.len());
    for i in 0..len {
        match a.num(i).cmp(&b.num(i)) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    match a.rank().cmp(&b.rank()) {
        Ordering::Equal => {}
        other => return other,
    }
    let (pa, pb) = (pieces(&a.pre), pieces(&b.pre));
    for (x, y) in pa.iter().zip(pb.iter()) {
        let order = match (x, y) {
            (Ok(x), Ok(y)) => x.cmp(y),
            // SemVer §11: numeric identifiers sort below alphanumeric ones.
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(x), Err(y)) => x.cmp(y),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    pa.len().cmp(&pb.len())
}

/// How far an update reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateKind {
    None,
    Patch,
    Minor,
    Major,
}

/// The size of the jump from `from` to `to`.
///
/// Below 1.0 the first non-zero number is the one that breaks: `^0.3` will not take `0.4`, and
/// `^0.0.3` will not take `0.0.4`. Calling those "minor"/"patch" would put a breaking change in the
/// «menores y parches» batch, which is the one the user expects to be safe.
pub fn classify(from: &Version, to: &Version) -> UpdateKind {
    if compare(to, from) != Ordering::Greater {
        return UpdateKind::None;
    }
    let (a0, a1, a2) = (from.num(0), from.num(1), from.num(2));
    let (b0, b1, b2) = (to.num(0), to.num(1), to.num(2));
    if a0 != b0 || (a0 == 0 && a1 != b1) || (a0 == 0 && a1 == 0 && a2 != b2) {
        UpdateKind::Major
    } else if a1 != b1 {
        UpdateKind::Minor
    } else {
        UpdateKind::Patch
    }
}

/// A requirement as written in a manifest, split into its operator and its version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    /// `^`, `~`, `>=`, `==`, `~=`, `[` … or empty for a bare version.
    pub op: String,
    /// The version token as written (`1.2`, `v1.4.0`).
    pub version: String,
    /// What closes it — `]` for NuGet's `[1.2.3]`.
    pub suffix: String,
    /// One operator and one version, nothing else: the only shape we rewrite. `>=1, <2`, `1.x`,
    /// `^1 || ^2` still give a version to compare against but are left to the user to edit.
    pub simple: bool,
}

const OPERATORS: &[&str] = &["===", "==", "~=", ">=", "<=", "!=", "^", "~", ">", "<", "="];

/// Reads a requirement. `None` for what is not a registry version at all — a path, a git URL, a
/// workspace link, an npm alias, `*`, `latest`.
pub fn requirement(eco: Ecosystem, raw: &str) -> Option<Requirement> {
    let s = raw.trim();
    let lower = s.to_ascii_lowercase();
    if s.is_empty()
        || s == "*"
        || lower == "latest"
        || lower == "next"
        || ["workspace:", "file:", "link:", "git", "http:", "https:", "github:", "npm:", "portal:", "patch:", "catalog:", "${"]
            .iter()
            .any(|p| lower.starts_with(p))
    {
        return None;
    }
    // NuGet's exact pin `[1.2.3]`; an interval `[1.0,2.0)` is not simple.
    if eco == Ecosystem::Nuget && s.starts_with('[') {
        let inner = s.trim_start_matches('[').trim_end_matches([']', ')']);
        let first = inner.split(',').next().unwrap_or("").trim();
        parse(first)?;
        let simple = !inner.contains(',') && s.ends_with(']');
        return Some(Requirement { op: "[".into(), version: first.into(), suffix: "]".into(), simple });
    }
    let op = OPERATORS.iter().find(|op| s.starts_with(**op)).copied().unwrap_or("");
    let rest = s[op.len()..].trim_start();
    let token: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != ',' && *c != '|' && *c != ';')
        .collect();
    let wildcard = token.contains(['x', 'X', '*']) && !token.chars().any(|c| c.is_ascii_alphabetic() && c != 'x' && c != 'X');
    let normalized = if wildcard {
        token.split('.').map(|p| if matches!(p, "x" | "X" | "*") { "0" } else { p }).collect::<Vec<_>>().join(".")
    } else {
        token.clone()
    };
    parse(&normalized)?;
    let simple = !wildcard && token.len() == rest.trim_end().len() && op != "<" && op != "<=" && op != "!=";
    Some(Requirement { op: op.into(), version: normalized, suffix: String::new(), simple })
}

/// Rewrites `raw` to admit `new`, keeping its operator and — where the operator makes it safe — its
/// precision: `^1.2` → `^1.5`, `~=2.31` → `~=2.32`, `1.2.3` → `1.4.0`. `None` when the requirement
/// is not one we rewrite (see [`Requirement::simple`]).
///
/// Precision is only kept where a shorter version still admits the new one: `==1.2` is an exact pin
/// to `1.2.0` in PEP 440, so truncating `1.5.3` to `==1.5` would pin the wrong release.
pub fn bump(eco: Ecosystem, raw: &str, new: &str) -> Option<String> {
    let req = requirement(eco, raw)?;
    if !req.simple {
        return None;
    }
    let old = parse(&req.version)?;
    let target = parse(new)?;
    let ranged = matches!(req.op.as_str(), "^" | "~" | "~=" | ">=") || (eco == Ecosystem::Cargo && req.op.is_empty());
    let mut token = if ranged && target.pre.is_empty() && old.pre.is_empty() && old.nums.len() < target.nums.len() {
        let keep = old.nums.len().max(if req.op == "~=" { 2 } else { 1 });
        let short = target.nums[..keep.min(target.nums.len())].iter().map(|n| n.to_string()).collect::<Vec<_>>().join(".");
        // `^1.2` with a patch-only update would truncate back to itself; spell the patch out instead.
        if parse(&short).is_some_and(|s| compare(&s, &old) == Ordering::Equal) { strip_v(&target.raw) } else { short }
    } else {
        strip_v(&target.raw)
    };
    if req.version.starts_with('v') {
        token = format!("v{token}");
    }
    let leading = &raw.trim()[..raw.trim().find(&req.version).unwrap_or(req.op.len())];
    Some(format!("{leading}{token}{}", req.suffix))
}

fn strip_v(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).to_string()
}

/// One published version, as a registry reports it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub version: String,
    /// Unix milliseconds. `None` when the registry does not say — such a version is never held back
    /// by the release-age rule, because there is nothing to hold it back with.
    pub published: Option<i64>,
    /// Yanked, unlisted or deprecated: never suggested.
    pub yanked: bool,
}

/// What to suggest for one dependency.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Candidates {
    /// The newest version old enough to suggest.
    pub latest: Option<String>,
    /// The newest one that is not a major jump from `current`.
    pub compatible: Option<String>,
    /// A newer release still inside the minimum-age window — shown, not suggested.
    pub too_recent: Option<String>,
}

pub const DAY_MS: i64 = 86_400_000;

/// Picks the suggestions for `current` out of `versions`.
///
/// The minimum release age is the user's guard against a compromised publish (user, 2026-10-23:
/// «respetar una edad mínima de publicación»): a version published yesterday is the one most likely
/// to be pulled tomorrow, and the attack window of a hijacked package is measured in days.
/// Pre-releases are offered only to someone already on one.
pub fn pick(current: &Version, versions: &[Published], now_ms: i64, min_age_days: u32) -> Candidates {
    let cutoff = now_ms - i64::from(min_age_days) * DAY_MS;
    let allow_pre = current.is_prerelease();
    let mut out = Candidates::default();
    let mut best: Option<Version> = None;
    let mut best_compat: Option<Version> = None;
    let mut best_young: Option<Version> = None;
    for entry in versions {
        if entry.yanked {
            continue;
        }
        let Some(v) = parse(&entry.version) else { continue };
        if v.is_prerelease() && !allow_pre {
            continue;
        }
        if compare(&v, current) != Ordering::Greater {
            continue;
        }
        let mature = entry.published.is_none_or(|p| p <= cutoff);
        if !mature {
            if best_young.as_ref().is_none_or(|b| compare(&v, b) == Ordering::Greater) {
                best_young = Some(v);
            }
            continue;
        }
        if classify(current, &v) != UpdateKind::Major && best_compat.as_ref().is_none_or(|b| compare(&v, b) == Ordering::Greater) {
            best_compat = Some(v.clone());
        }
        if best.as_ref().is_none_or(|b| compare(&v, b) == Ordering::Greater) {
            best = Some(v);
        }
    }
    if let Some(young) = &best_young {
        if best.as_ref().is_none_or(|b| compare(young, b) == Ordering::Greater) {
            out.too_recent = Some(young.raw.clone());
        }
    }
    out.latest = best.map(|v| v.raw);
    out.compatible = best_compat.map(|v| v.raw);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        parse(s).unwrap()
    }

    #[test]
    fn orders_semver_pep440_and_maven_versions() {
        assert_eq!(compare(&v("1.10.0"), &v("1.9.0")), Ordering::Greater);
        assert_eq!(compare(&v("1.0.0-beta.2"), &v("1.0.0-beta.10")), Ordering::Less);
        assert_eq!(compare(&v("1.0.0-rc.1"), &v("1.0.0")), Ordering::Less);
        assert_eq!(compare(&v("2.0rc1"), &v("2.0")), Ordering::Less);
        assert_eq!(compare(&v("2.0.post1"), &v("2.0")), Ordering::Greater);
        assert_eq!(compare(&v("v1.2.3"), &v("1.2.3")), Ordering::Equal);
        assert_eq!(compare(&v("1.2"), &v("1.2.0")), Ordering::Equal);
        assert_eq!(compare(&v("32.1.3-jre"), &v("31.1-jre")), Ordering::Greater);
    }

    #[test]
    fn tells_previews_from_release_qualifiers() {
        assert!(v("1.0.0-alpha.1").is_prerelease());
        assert!(v("2.0b3").is_prerelease());
        assert!(v("6.0.0-preview.7.21377.19").is_prerelease());
        assert!(v("3.0-M1").is_prerelease());
        assert!(!v("31.1-jre").is_prerelease());
        assert!(!v("5.3.20.RELEASE").is_prerelease());
        assert!(!v("2.0.post1").is_prerelease());
        assert!(!v("1.2.3+build.7").is_prerelease());
    }

    #[test]
    fn classifies_jumps_with_zero_major_as_breaking() {
        assert_eq!(classify(&v("1.2.3"), &v("1.2.4")), UpdateKind::Patch);
        assert_eq!(classify(&v("1.2.3"), &v("1.3.0")), UpdateKind::Minor);
        assert_eq!(classify(&v("1.2.3"), &v("2.0.0")), UpdateKind::Major);
        assert_eq!(classify(&v("0.3.1"), &v("0.4.0")), UpdateKind::Major);
        assert_eq!(classify(&v("0.3.1"), &v("0.3.2")), UpdateKind::Patch);
        assert_eq!(classify(&v("0.0.3"), &v("0.0.4")), UpdateKind::Major);
        assert_eq!(classify(&v("1.2.3"), &v("1.2.3")), UpdateKind::None);
        assert_eq!(classify(&v("1.2.3-rc.1"), &v("1.2.3")), UpdateKind::Patch);
    }

    #[test]
    fn reads_requirements_of_every_ecosystem() {
        let r = requirement(Ecosystem::Npm, "^1.2.3").unwrap();
        assert_eq!((r.op.as_str(), r.version.as_str(), r.simple), ("^", "1.2.3", true));
        let r = requirement(Ecosystem::Npm, "1.x").unwrap();
        assert_eq!((r.version.as_str(), r.simple), ("1.0", false));
        let r = requirement(Ecosystem::Npm, ">=1.2.0 <2").unwrap();
        assert!(!r.simple);
        assert!(requirement(Ecosystem::Npm, "workspace:*").is_none());
        assert!(requirement(Ecosystem::Npm, "github:user/repo").is_none());
        assert!(requirement(Ecosystem::Npm, "npm:other@^1").is_none());
        let r = requirement(Ecosystem::Pypi, "~=2.31").unwrap();
        assert_eq!((r.op.as_str(), r.version.as_str()), ("~=", "2.31"));
        let r = requirement(Ecosystem::Pypi, ">=1.0,<2").unwrap();
        assert!(!r.simple);
        let r = requirement(Ecosystem::Nuget, "[13.0.1]").unwrap();
        assert_eq!((r.op.as_str(), r.version.as_str(), r.simple), ("[", "13.0.1", true));
        assert!(!requirement(Ecosystem::Nuget, "[1.0,2.0)").unwrap().simple);
        assert!(requirement(Ecosystem::Maven, "${spring.version}").is_none());
    }

    #[test]
    fn bumps_keep_the_operator_and_the_precision() {
        assert_eq!(bump(Ecosystem::Npm, "^1.2.3", "1.5.0").as_deref(), Some("^1.5.0"));
        assert_eq!(bump(Ecosystem::Npm, "~1.2.3", "1.2.9").as_deref(), Some("~1.2.9"));
        assert_eq!(bump(Ecosystem::Npm, "1.2.3", "2.0.0").as_deref(), Some("2.0.0"));
        assert_eq!(bump(Ecosystem::Cargo, "1.2", "1.5.3").as_deref(), Some("1.5"));
        assert_eq!(bump(Ecosystem::Cargo, "1.2", "1.2.7").as_deref(), Some("1.2.7"));
        assert_eq!(bump(Ecosystem::Cargo, "=0.4.1", "0.4.3").as_deref(), Some("=0.4.3"));
        assert_eq!(bump(Ecosystem::Pypi, "==1.2", "1.5.3").as_deref(), Some("==1.5.3"));
        assert_eq!(bump(Ecosystem::Pypi, "~=2.31", "2.32.3").as_deref(), Some("~=2.32"));
        assert_eq!(bump(Ecosystem::Pypi, ">= 2.0", "2.4.1").as_deref(), Some(">= 2.4"));
        assert_eq!(bump(Ecosystem::Nuget, "[13.0.1]", "13.0.3").as_deref(), Some("[13.0.3]"));
        assert_eq!(bump(Ecosystem::Go, "v1.8.0", "v1.9.1").as_deref(), Some("v1.9.1"));
        assert_eq!(bump(Ecosystem::Npm, "^1 || ^2", "3.0.0"), None);
        assert_eq!(bump(Ecosystem::Npm, "1.x", "1.4.0"), None);
    }

    #[test]
    fn release_age_holds_back_fresh_versions_and_previews() {
        let now = 100 * DAY_MS;
        let list = vec![
            Published { version: "1.2.0".into(), published: Some(10 * DAY_MS), yanked: false },
            Published { version: "1.3.0".into(), published: Some(50 * DAY_MS), yanked: false },
            Published { version: "1.4.0".into(), published: Some(60 * DAY_MS), yanked: true },
            Published { version: "2.0.0".into(), published: Some(80 * DAY_MS), yanked: false },
            Published { version: "2.1.0".into(), published: Some(98 * DAY_MS), yanked: false },
            Published { version: "3.0.0-beta.1".into(), published: Some(70 * DAY_MS), yanked: false },
        ];
        let c = pick(&v("1.2.0"), &list, now, 7);
        assert_eq!(c.latest.as_deref(), Some("2.0.0"));
        assert_eq!(c.compatible.as_deref(), Some("1.3.0"));
        assert_eq!(c.too_recent.as_deref(), Some("2.1.0"));
        let c = pick(&v("1.2.0"), &list, now, 0);
        assert_eq!(c.latest.as_deref(), Some("2.1.0"));
        assert_eq!(c.too_recent, None);
        // Someone on a preview is offered the next one.
        let c = pick(&v("3.0.0-alpha.1"), &list, now, 7);
        assert_eq!(c.latest.as_deref(), Some("3.0.0-beta.1"));
        // An unknown publish date never holds a version back.
        let undated = vec![Published { version: "1.9.0".into(), published: None, yanked: false }];
        assert_eq!(pick(&v("1.2.0"), &undated, now, 30).latest.as_deref(), Some("1.9.0"));
    }
}
