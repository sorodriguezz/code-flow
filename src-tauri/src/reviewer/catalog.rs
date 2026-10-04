//! What the Reviewer downloads, pinned.
//!
//! Nothing here ships in the installer: SonarQube is close to a gigabyte, and most people never turn
//! the Reviewer on. Each artefact is fetched from its vendor the first time the user asks for it in
//! Settings, and kept only if its SHA-256 is the one written below — the same rule the JDBC drivers
//! follow (`datasource/drivers.rs`): a file that exists is a file that was verified.
//!
//! Pinned rather than "latest" for the reason the driver catalogue gives: an update of SonarQube is a
//! change to what the user runs, and it should arrive the way every other change does — in a release
//! of CodeFlow, where it was tried first. The Java runtime is the exception, as it is for the
//! drivers: Adoptium's API names the newest build of the release below together with its checksum,
//! so security fixes to the JDK arrive without a CodeFlow release while every byte is still checked
//! against what Adoptium itself published.

/// One downloadable archive.
#[derive(Debug, Clone, Copy)]
pub struct Artifact {
    /// Stable id — what progress events and the status call it.
    pub id: &'static str,
    pub version: &'static str,
    /// The archive's own file name, kept as the vendor spells it.
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    /// The single folder the archive unpacks into.
    pub top_dir: &'static str,
}

/// SonarQube Community Build, the free edition: one main branch per project, no pull-request
/// analysis — which is the shape of a "review the whole project" run anyway.
///
/// 26.9 needs a **JDK** 21 or 25 to run; a JRE is no longer enough (its release notes, and the host
/// requirements page). That is why the Reviewer downloads its own JDK instead of sharing the JRE the
/// database drivers use.
pub const SONARQUBE: Artifact = Artifact {
    id: "sonarqube",
    version: "26.9.0.129388",
    file: "sonarqube-26.9.0.129388.zip",
    url: "https://binaries.sonarsource.com/Distribution/sonarqube/sonarqube-26.9.0.129388.zip",
    sha256: "b7306f5ecfa6806753bc0eb0dc4ea11fe0ddd2c5a346592718814d6ec35b88cb",
    size: 946_639_592,
    top_dir: "sonarqube-26.9.0.129388",
};

/// The scanner, in its platform-independent build: it runs on the same JDK as the server, so the
/// variant that bundles a JRE of its own (six times the size) would only duplicate it.
pub const SCANNER: Artifact = Artifact {
    id: "scanner",
    version: "8.1.0.6389",
    file: "sonar-scanner-cli-8.1.0.6389.zip",
    url: "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-8.1.0.6389.zip",
    sha256: "ab76ab3c360025e9108be5b55be066f304a164f8b2850d2f2f333915db51bc1b",
    size: 9_224_839,
    top_dir: "sonar-scanner-8.1.0.6389",
};

/// The JDK release SonarQube is run on.
pub const JAVA_RELEASE: u32 = 21;

/// Roughly what Temurin's JDK archive weighs, for the line that says how much a download will be
/// before Adoptium has been asked. The real figure replaces it once the download starts.
pub const JDK_APPROX_SIZE: u64 = 205_000_000;

/// The JaCoCo Maven plugin a Maven project's suggested test command runs by its full coordinates,
/// so coverage works on a `pom.xml` that never declared the plugin — nothing in the repository has
/// to change for the Reviewer to measure it.
pub const JACOCO_VERSION: &str = "0.8.13";

/// The jar inside SonarQube that is the server's launcher.
pub fn sonar_application_jar() -> String {
    format!("lib/sonar-application-{}.jar", SONARQUBE.version)
}

/// The jar inside SonarQube that asks a running server to stop (Windows has no SIGTERM).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn sonar_shutdowner_jar() -> String {
    format!("lib/sonar-shutdowner-{}.jar", SONARQUBE.version)
}

/// The scanner's own jar.
pub fn scanner_jar() -> String {
    format!("lib/sonar-scanner-cli-{}.jar", SCANNER.version)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pin whose parts disagree — a URL bumped and a hash or a folder left behind — would download
    /// one version and look for another, and fail only on the machine of whoever runs it first.
    #[test]
    fn every_pin_agrees_with_itself() {
        for artifact in [SONARQUBE, SCANNER] {
            assert!(artifact.url.ends_with(artifact.file), "{} url/file", artifact.id);
            assert!(artifact.file.contains(artifact.version), "{} file/version", artifact.id);
            assert!(artifact.top_dir.contains(artifact.version), "{} folder/version", artifact.id);
            assert_eq!(artifact.sha256.len(), 64, "{} sha256 length", artifact.id);
            assert!(artifact.sha256.chars().all(|c| c.is_ascii_hexdigit()), "{} sha256 hex", artifact.id);
            assert!(artifact.url.starts_with("https://"), "{} https", artifact.id);
            assert!(artifact.size > 0);
        }
        assert!(sonar_application_jar().contains(SONARQUBE.version));
        assert!(scanner_jar().contains(SCANNER.version));
    }
}
