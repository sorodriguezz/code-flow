//! The driver catalogue: every database CodeFlow can reach, and what each one needs to be reached.
//!
//! One JSON file, `src/lib/db/driverCatalog.json`, read by both halves of the app. The frontend
//! imports it to draw the driver list and the connection form; this module compiles the same bytes
//! in, to know for a connection which session serves it, which files it needs and how its URL is
//! built. Two copies of the list would drift — the form offering a driver this side has never heard
//! of, or a port the backend dials differently — so there is one, and the build fails if it stops
//! parsing (see the tests at the bottom).
//!
//! A driver is one of two things:
//!
//! - **A native engine** (`engine` names a [`DbKind`]): one of the Rust drivers compiled into the
//!   app. Several catalogue entries can share one — CockroachDB, Greenplum and YugabyteDB are
//!   PostgreSQL on the wire, TiDB and Aurora MySQL are MySQL — and differ only in name, default port
//!   and defaults. Nothing to download.
//! - **A JDBC driver**: jars on Maven Central (or a vendor's own download), fetched on first use into
//!   the app's data directory by [`super::drivers`] and loaded by the Java bridge
//!   ([`super::jvm`]). `engine: "oracle"` and `"iris"` keep their dedicated sessions; everything else
//!   is served by the generic one in [`super::jdbc`], which browses the database through the driver's
//!   own `DatabaseMetaData`.
//!
//! Every downloadable file carries the hash it must have — Maven Central's SHA-1 for an artefact
//! there, a SHA-256 taken when the entry was written for anything else — so a file that arrives
//! different from the one the catalogue names is refused rather than run.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::DbKind;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverDef {
    pub id: String,
    pub name: String,
    /// `complete` or `basic` — whether the explorer has a dedicated driver for it or browses it
    /// through JDBC metadata. Shown as the two groups of the driver list.
    #[serde(default)]
    pub support: String,
    /// The [`DbKind`] whose session serves it, in its wire spelling, or `jdbc`.
    pub engine: String,
    #[serde(default)]
    pub default_port: u16,
    /// JDBC only: the `java.sql.Driver` implementation to instantiate.
    #[serde(default)]
    pub class: Option<String>,
    /// JDBC only: the jars to download, all of them needed.
    #[serde(default)]
    pub files: Vec<DriverFile>,
    /// JDBC only: how a URL is built from the connection's fields. The first is the default.
    #[serde(default)]
    pub urls: Vec<UrlTemplate>,
    /// JDBC connection properties every connection of this driver gets, templated like a URL —
    /// `{user}` and `{password}` included, for the drivers that want credentials under names of
    /// their own (`AccessKey`, `PWD`). One that renders empty is left out.
    #[serde(default)]
    pub properties: BTreeMap<String, String>,
    #[serde(default)]
    pub sql: Option<SqlTraits>,
    /// A vendor page to get the files from, for the drivers nobody may redistribute — the user adds
    /// them by hand, as in any database tool.
    #[serde(default)]
    pub manual: Option<String>,
    /// The database is a file on this machine (`{file}` in the URL), not a server.
    #[serde(default)]
    pub file: bool,
}

/// One downloadable file of a JDBC driver.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverFile {
    /// `group:artifact:version[:classifier]`, for a Maven artefact.
    #[serde(default)]
    pub maven: Option<String>,
    /// The repository a Maven artefact comes from: Central unless named (`elastic`).
    #[serde(default)]
    pub repo: Option<String>,
    /// A direct download, for a vendor that publishes outside Maven.
    #[serde(default)]
    pub url: Option<String>,
    /// The file name it is stored under.
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

impl DriverFile {
    /// Where the file is downloaded from.
    pub fn source_url(&self) -> Result<String, String> {
        if let Some(url) = &self.url {
            return Ok(url.clone());
        }
        let coords = self.maven.as_deref().ok_or_else(|| format!("{} names no source", self.name))?;
        let parts: Vec<&str> = coords.split(':').collect();
        let (group, artifact, version) = match parts.as_slice() {
            [g, a, v] | [g, a, v, _] => (*g, *a, *v),
            _ => return Err(format!("`{coords}` is not group:artifact:version")),
        };
        let base = match self.repo.as_deref() {
            None | Some("central") => "https://repo1.maven.org/maven2",
            Some("elastic") => "https://artifacts.elastic.co/maven",
            Some(other) => return Err(format!("`{other}` is not a repository CodeFlow downloads from")),
        };
        Ok(format!("{base}/{}/{artifact}/{version}/{}", group.replace('.', "/"), self.name))
    }

    /// The version a person reads beside the file — the artefact's, or the file name's.
    pub fn version(&self) -> String {
        self.maven
            .as_deref()
            .and_then(|coords| coords.split(':').nth(2))
            .map(str::to_string)
            .unwrap_or_else(|| self.name.clone())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct UrlTemplate {
    pub name: String,
    pub template: String,
}

/// How a page of rows is asked for. Not derivable from the driver at runtime — `DatabaseMetaData`
/// says nothing about `LIMIT` — so each catalogue entry names its engine's.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Paging {
    /// `LIMIT n OFFSET m`.
    #[default]
    LimitOffset,
    /// `OFFSET m ROWS FETCH NEXT n ROWS ONLY` — the standard's.
    OffsetFetch,
    /// `FETCH FIRST n ROWS ONLY`, with no offset: later pages skip on the client.
    FetchFirst,
    /// `LIMIT n`, with no offset.
    Limit,
    /// `SELECT TOP n`, with no offset.
    Top,
    /// Nothing at all: the row cap is JDBC's `setMaxRows`, and later pages skip on the client.
    None,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SqlTraits {
    /// `ansi` (double quotes, standard literals), `backtick` (backticks, backslash escapes — Hive,
    /// Spark, BigQuery, ClickHouse), `tsql` (SQL Server and Sybase) or `oracle`.
    #[serde(default)]
    pub dialect: String,
    #[serde(default)]
    pub paging: Paging,
    /// `EXPLAIN {sql}`-style, or nothing when the engine has no plan to show.
    #[serde(default)]
    pub explain: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    runtime: RuntimeSpec,
    drivers: Vec<DriverDef>,
}

#[derive(Debug, Deserialize)]
struct RuntimeSpec {
    java: u32,
}

const CATALOG_JSON: &str = include_str!("../../../src/lib/db/driverCatalog.json");

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    // A compile-time constant, and a test below parses it — so this cannot fail at runtime in a
    // build that passed its tests.
    CATALOG.get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("src/lib/db/driverCatalog.json is valid"))
}

pub fn drivers() -> &'static [DriverDef] {
    &catalog().drivers
}

pub fn driver(id: &str) -> Option<&'static DriverDef> {
    drivers().iter().find(|driver| driver.id == id)
}

/// The Java feature release the downloaded runtime is — what every driver in the list is checked
/// against.
pub fn java_release() -> u32 {
    catalog().runtime.java
}

/// The catalogue entry a connection made before drivers existed stands for: its engine's own.
pub fn default_driver_id(kind: DbKind) -> &'static str {
    match kind {
        DbKind::Postgres => "postgresql",
        DbKind::Supabase => "supabase",
        DbKind::Sqlserver => "sqlserver",
        DbKind::Iris => "iris",
        DbKind::Mongodb => "mongodb",
        DbKind::Redis => "redis",
        DbKind::Mysql => "mysql",
        DbKind::Mariadb => "mariadb",
        DbKind::Sqlite => "sqlite",
        DbKind::Oracle => "oracle",
        // There is no "default JDBC database": a JDBC connection always names its driver.
        DbKind::Jdbc => "",
    }
}

// ---------------------------------------------------------------------------
// URL templates
// ---------------------------------------------------------------------------

/// Renders a URL template the way DataGrip's read: `{name}` is a field's value, `{name::default}`
/// falls back to the default when the field is empty, and `[ … ]` is an optional part that is kept
/// only when every field inside it has a value of its own — so
/// `jdbc:db2://{host::localhost}[:{port::50000}]/{database}` loses `:port` rather than gaining a
/// bare colon. Groups nest. Anything else is literal.
///
/// A default never keeps an optional part alive: `[;schema={schema::PUBLIC}]` with no schema given
/// renders nothing, because "use the server's default" is what leaving it out already says.
pub fn render_template(template: &str, value: &dyn Fn(&str) -> String) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut at = 0;
    render_part(&chars, &mut at, value, false).0
}

/// Renders from `at` to the end of the template, or to the `]` that closes the group it was called
/// for. Returns the text and whether every field in it had a value.
fn render_part(chars: &[char], at: &mut usize, value: &dyn Fn(&str) -> String, in_group: bool) -> (String, bool) {
    let mut out = String::new();
    let mut complete = true;
    while *at < chars.len() {
        let c = chars[*at];
        match c {
            '{' => {
                let close = chars[*at..].iter().position(|&ch| ch == '}').map(|offset| *at + offset);
                let Some(close) = close else {
                    out.push(c);
                    *at += 1;
                    continue;
                };
                let inside: String = chars[*at + 1..close].iter().collect();
                let (name, default) = match inside.split_once("::") {
                    Some((name, default)) => (name.trim(), Some(default)),
                    None => (inside.trim(), None),
                };
                let given = value(name);
                if given.is_empty() {
                    complete = false;
                    out.push_str(default.unwrap_or(""));
                } else {
                    out.push_str(&given);
                }
                *at = close + 1;
            }
            '[' => {
                *at += 1;
                let (inner, inner_complete) = render_part(chars, at, value, true);
                if inner_complete {
                    out.push_str(&inner);
                }
            }
            ']' if in_group => {
                *at += 1;
                return (out, complete);
            }
            _ => {
                out.push(c);
                *at += 1;
            }
        }
    }
    (out, complete)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn render(template: &str, values: &[(&str, &str)]) -> String {
        let map: HashMap<&str, &str> = values.iter().copied().collect();
        render_template(template, &|name| map.get(name).copied().unwrap_or_default().to_string())
    }

    #[test]
    fn fields_fill_in_and_defaults_stand_in_for_empty_ones() {
        let template = "jdbc:db2://{host::localhost}[:{port::50000}]/{database}";
        assert_eq!(render(template, &[("host", "db.local"), ("port", "50001"), ("database", "SAMPLE")]), "jdbc:db2://db.local:50001/SAMPLE");
        // No host: the default. No port: the optional part goes, colon and all.
        assert_eq!(render(template, &[("database", "SAMPLE")]), "jdbc:db2://localhost/SAMPLE");
    }

    #[test]
    fn optional_parts_nest_and_drop_from_the_inside_out() {
        let template = "jdbc:trino://{host}[:{port}][/{catalog}[/{database}]]";
        assert_eq!(render(template, &[("host", "h"), ("catalog", "hive"), ("database", "web")]), "jdbc:trino://h/hive/web");
        assert_eq!(render(template, &[("host", "h"), ("catalog", "hive")]), "jdbc:trino://h/hive");
        // A schema without a catalog cannot be written, so the whole tail goes.
        assert_eq!(render(template, &[("host", "h"), ("database", "web")]), "jdbc:trino://h");
    }

    #[test]
    fn a_default_never_keeps_an_optional_part_alive() {
        assert_eq!(render("jdbc:exa:{host}[;schema={database::PUBLIC}]", &[("host", "h")]), "jdbc:exa:h");
    }

    #[test]
    fn stray_braces_are_text() {
        assert_eq!(render("jdbc:{x", &[]), "jdbc:{x");
    }

    /// The catalogue is data the whole app trusts: every id once, every engine one this build has,
    /// and every JDBC driver complete enough to be downloaded and opened.
    #[test]
    fn the_catalogue_is_whole() {
        let mut ids = HashSet::new();
        for driver in drivers() {
            assert!(ids.insert(driver.id.as_str()), "{} is listed twice", driver.id);
            assert!(matches!(driver.support.as_str(), "complete" | "basic"), "{}: support", driver.id);
            let jvm = matches!(driver.engine.as_str(), "jdbc" | "oracle" | "iris");
            if driver.engine != "jdbc" {
                let kind: Result<DbKind, _> = serde_json::from_value(serde_json::Value::String(driver.engine.clone()));
                assert!(kind.is_ok(), "{}: `{}` is not an engine", driver.id, driver.engine);
            }
            if !jvm {
                assert!(driver.files.is_empty() && driver.class.is_none(), "{}: a native engine downloads nothing", driver.id);
                continue;
            }
            assert!(driver.class.as_deref().is_some_and(|c| !c.is_empty()), "{}: no driver class", driver.id);
            assert!(!driver.urls.is_empty(), "{}: no URL template", driver.id);
            assert!(!driver.files.is_empty() || driver.manual.is_some(), "{}: nothing to download and no vendor page", driver.id);
            for file in &driver.files {
                assert!(file.sha1.is_some() || file.sha256.is_some(), "{}: {} is not pinned by a hash", driver.id, file.name);
                assert!(file.size > 0, "{}: {} has no size", driver.id, file.name);
                assert!(file.source_url().is_ok(), "{}: {} has no source", driver.id, file.name);
                assert!(file.name.ends_with(".jar"), "{}: {} is not a jar", driver.id, file.name);
            }
            if driver.engine == "jdbc" {
                assert!(driver.sql.is_some(), "{}: the generic driver needs its SQL traits", driver.id);
            }
        }
        // Every engine that existed before the catalogue still has its entry.
        for kind in [
            DbKind::Postgres, DbKind::Supabase, DbKind::Sqlserver, DbKind::Iris, DbKind::Mongodb,
            DbKind::Redis, DbKind::Mysql, DbKind::Mariadb, DbKind::Sqlite, DbKind::Oracle,
        ] {
            assert!(driver(default_driver_id(kind)).is_some(), "{kind:?} has no default driver");
        }
    }

    #[test]
    fn maven_artefacts_resolve_to_their_repository_path() {
        let file = DriverFile {
            maven: Some("org.apache.hive:hive-jdbc:4.2.1:standalone".into()),
            repo: None,
            url: None,
            name: "hive-jdbc-4.2.1-standalone.jar".into(),
            size: 1,
            sha1: Some("x".into()),
            sha256: None,
        };
        assert_eq!(
            file.source_url().unwrap(),
            "https://repo1.maven.org/maven2/org/apache/hive/hive-jdbc/4.2.1/hive-jdbc-4.2.1-standalone.jar"
        );
        assert_eq!(file.version(), "4.2.1");
    }
}
