//! «Salud de dependencias» — the Revisor's «Dependencias» section (user, 2026-10-23: «En Revisor,
//! la pestaña de calidad de proyecto, como sección «Dependencias», más una vista de todo el
//! workspace»).
//!
//! Per repository: what is out of date (patch / minor / major), what is vulnerable and what carries
//! a licence the policy flags. Across the workspace: the same dependency in every repository and who
//! is behind. Then a batch update that opens one pull request per repository, and a daily check that
//! says when a new advisory lands on something already in use.
//!
//! - [`manifests`] reads manifests and lockfiles of npm/pnpm/yarn, Cargo, NuGet, PyPI, Go and Maven
//!   (pure functions, fixture-tested; nothing is executed to read them).
//! - [`registry`] asks each public registry over HTTPS for versions, dates and licences, cached on
//!   disk with a TTL and tolerant of being offline.
//! - [`osv`] asks OSV.dev — one source for every ecosystem, so no `npm audit` / `cargo audit` binary
//!   is ever run.
//! - [`license`] applies the licence policy, [`bump`] rewrites manifests textually, [`update`] runs the
//!   confirmed batch update, [`alerts`] remembers which advisories were already seen.
//!
//! Private registries are not supported yet: they need credentials from the Llavero, a scope map and
//! an `.npmrc`/`nuget.config` reader, and half of that would report the public version of a package
//! the user does not actually install (the same reasoning `npm.rs` gives).

pub mod alerts;
pub mod analysis;
pub mod bump;
pub mod config;
pub mod license;
pub mod manifests;
pub mod minitoml;
pub mod osv;
pub mod registry;
pub mod update;
pub mod version;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ecosystem {
    Npm,
    Cargo,
    Nuget,
    Pypi,
    Go,
    Maven,
}

impl Ecosystem {
    /// The ecosystem's name in OSV's schema.
    pub fn osv(self) -> &'static str {
        match self {
            Ecosystem::Npm => "npm",
            Ecosystem::Cargo => "crates.io",
            Ecosystem::Nuget => "NuGet",
            Ecosystem::Pypi => "PyPI",
            Ecosystem::Go => "Go",
            Ecosystem::Maven => "Maven",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Ecosystem::Npm => "npm",
            Ecosystem::Cargo => "cargo",
            Ecosystem::Nuget => "nuget",
            Ecosystem::Pypi => "pypi",
            Ecosystem::Go => "go",
            Ecosystem::Maven => "maven",
        }
    }

    /// Names that are the same package under different spellings: npm and Cargo are exact, NuGet is
    /// case-insensitive, PyPI folds case and `-_.` (PEP 503).
    pub fn normalize(self, name: &str) -> String {
        match self {
            Ecosystem::Nuget => name.to_ascii_lowercase(),
            Ecosystem::Pypi => {
                let lower = name.to_ascii_lowercase();
                let mut out = String::with_capacity(lower.len());
                let mut last_sep = false;
                for c in lower.chars() {
                    if matches!(c, '-' | '_' | '.') {
                        if !last_sep {
                            out.push('-');
                        }
                        last_sep = true;
                    } else {
                        out.push(c);
                        last_sep = false;
                    }
                }
                out
            }
            _ => name.to_string(),
        }
    }
}

/// A dependency as one manifest declares it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Declared {
    pub ecosystem: Ecosystem,
    /// The registry's name for it.
    pub name: String,
    /// The name as the manifest spells it — differs for a Cargo rename (`package = "…"`), and is
    /// what the bump has to find.
    pub key: String,
    /// Repository-relative, `/`-separated.
    pub manifest: String,
    /// `dependencies`, `devDependencies`, `dev-dependencies`, `require`, `PackageReference`…
    pub section: String,
    /// As written: `^1.2.3`, `>=2.0`, `[1.0.0]`, `v1.4.0`.
    pub requirement: String,
    /// What the lockfile resolved it to, when there is one that says.
    pub resolved: Option<String>,
    /// The Maven property the version came from (`${jackson.version}`), which is what a bump edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property: Option<String>,
}

/// A package a lockfile pins — direct or transitive.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Locked {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    pub lockfile: String,
}

/// A lockfile found, and what refreshes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lockfile {
    pub path: String,
    pub kind: LockKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LockKind {
    NpmLock,
    PnpmLock,
    YarnLock,
    CargoLock,
    NugetLock,
    PoetryLock,
    UvLock,
    PipfileLock,
    GoSum,
}

/// Everything read from one repository's files.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub manifests: Vec<String>,
    pub lockfiles: Vec<Lockfile>,
    pub declared: Vec<Declared>,
    pub locked: Vec<Locked>,
    pub warnings: Vec<String>,
}

pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `2026-10-23T10:00:00Z`-ish → Unix ms. Every registry here speaks RFC 3339 except PyPI's older
/// fields, which drop the zone.
pub(crate) fn parse_time(raw: &str) -> Option<i64> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(t.timestamp_millis());
    }
    chrono::NaiveDateTime::parse_from_str(raw.trim_end_matches('Z'), "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .map(|t| t.and_utc().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_names_per_ecosystem() {
        assert_eq!(Ecosystem::Pypi.normalize("Django_REST.framework"), "django-rest-framework");
        assert_eq!(Ecosystem::Nuget.normalize("Newtonsoft.Json"), "newtonsoft.json");
        assert_eq!(Ecosystem::Npm.normalize("@Scope/Pkg"), "@Scope/Pkg");
    }

    #[test]
    fn reads_registry_timestamps() {
        assert_eq!(parse_time("1970-01-02T00:00:00.000Z"), Some(86_400_000));
        assert_eq!(parse_time("1970-01-02T00:00:00"), Some(86_400_000));
        assert_eq!(parse_time("nope"), None);
    }
}
