//! The «Dependencias» settings, one JSON row (`deps_config`) in the settings table.
//!
//! One row rather than five because every reader wants all of it at once — an analysis needs the
//! age, the TTL and the licence policy together — and the Settings pane saves it whole.

use serde::{Deserialize, Serialize};

pub const SETTING_KEY: &str = "deps_config";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DepsConfig {
    /// Days a release must have been public before it is suggested.
    pub min_release_age_days: u32,
    /// How long a registry answer is reused before it is asked again.
    pub cache_ttl_hours: u32,
    /// The daily check for new advisories.
    pub alerts: bool,
    /// Licences that are fine whatever the other lists say. Empty means "no allow-list".
    pub license_allowed: Vec<String>,
    /// Licences to review. `*` matches any suffix (`GPL-*`).
    pub license_flagged: Vec<String>,
    /// Licences worth a look but not a block.
    pub license_warn: Vec<String>,
    /// A package with no declared licence is flagged (otherwise a warning).
    pub flag_unknown_license: bool,
}

impl Default for DepsConfig {
    fn default() -> Self {
        Self {
            min_release_age_days: 7,
            cache_ttl_hours: 12,
            alerts: true,
            license_allowed: vec![],
            license_flagged: ["GPL-*", "AGPL-*", "SSPL-*", "BUSL-*"].map(String::from).to_vec(),
            license_warn: ["LGPL-*"].map(String::from).to_vec(),
            flag_unknown_license: true,
        }
    }
}

impl DepsConfig {
    pub fn load(conn: &rusqlite::Connection) -> Self {
        crate::db::queries::get_setting(conn, SETTING_KEY)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_fall_back_to_the_defaults() {
        let c: DepsConfig = serde_json::from_str(r#"{"minReleaseAgeDays":3}"#).unwrap();
        assert_eq!(c.min_release_age_days, 3);
        assert_eq!(c.cache_ttl_hours, 12);
        assert!(c.license_flagged.contains(&"AGPL-*".to_string()));
    }
}
