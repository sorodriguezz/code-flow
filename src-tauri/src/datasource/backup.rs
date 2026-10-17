//! Backing a database up to a file, and restoring one from it, with the engine's own tools.
//!
//! **Why the vendors' binaries and not a dump written here.** A logical backup is the engine's
//! business: `pg_dump` knows the order a schema has to be recreated in, which extensions own which
//! objects, and how to take a consistent snapshot without locking writers out; `mysqldump` and
//! `mongodump` know the same about theirs. A dump CodeFlow wrote itself would be a second, worse
//! implementation of each, and its files would only restore through CodeFlow. These ones restore
//! anywhere — which is the point of a backup. The cost is a dependency on the binary, and a machine
//! without it is told which one is missing and how to install it ([`MissingTool`]), and nothing else
//! happens. SQLite is the exception: the engine is linked in, and `VACUUM INTO` is its backup.
//!
//! **Credentials never touch argv.** A process's arguments are readable by every user of the
//! machine (`ps`, Task Manager), so the password travels the way each tool reads it privately:
//! `PGPASSWORD` for libpq, a `0600` option file for the MySQL clients (`MYSQL_PWD` is deprecated),
//! and a `--config` YAML holding the URI for the Mongo tools. The files are deleted when the run
//! ends, however it ends ([`SecretFile`]).
//!
//! **Tunnels.** A connection through SSH reaches the database at the tunnel's local end, exactly as
//! a driver session does (`Session::open_tagged`): the tunnel is raised, the config re-pointed at
//! `127.0.0.1:<local port>`, and the tool never knows.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Notify;

use super::{tunnel, DbConnectionConfig, DbKind, DbSslMode};

/// What the last lines of a failed run are cut to, for the error the dialog shows. The whole log
/// has already streamed by; this is the part that says why it stopped.
const ERROR_TAIL: usize = 20;

/// The error a cancelled run answers with.
pub const CANCELLED: &str = "Cancelled";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Backup,
    Restore,
}

impl Mode {
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "backup" => Ok(Mode::Backup),
            "restore" => Ok(Mode::Restore),
            other => Err(format!("`{other}` isn't backup or restore.")),
        }
    }
}

/// Postgres' two dump formats: a `.sql` script `psql` replays, or the custom archive `pg_restore`
/// reads (compressed, and selective on the way back in).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PgFormat {
    Plain,
    Custom,
}

impl PgFormat {
    pub fn parse(text: &str) -> Self {
        if text == "custom" {
            PgFormat::Custom
        } else {
            PgFormat::Plain
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub path: String,
    pub bytes: u64,
    pub duration_ms: u64,
}

/// A tool the operation needs and this machine doesn't have. `install` is a command to paste into a
/// terminal, `docs` the vendor's page for the rest.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissingTool {
    pub tool: String,
    pub install: String,
    pub docs: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub run_id: String,
    pub line: String,
}

// ---------------------------------------------------------------------------
// Which tool
// ---------------------------------------------------------------------------

/// Why an engine has no backup here, or `None` when it has one.
pub fn unsupported(kind: DbKind) -> Option<String> {
    let reason = match kind {
        DbKind::Postgres | DbKind::Supabase | DbKind::Mysql | DbKind::Mariadb | DbKind::Mongodb | DbKind::Sqlite => {
            return None
        }
        DbKind::Sqlserver => "SQL Server backs up on the server (BACKUP DATABASE), to a path the server writes.",
        DbKind::Oracle => "Oracle's Data Pump writes on the server, not on this machine.",
        DbKind::Iris => "IRIS backs up from its own management portal.",
        DbKind::Redis => "Redis persists with its own RDB/AOF files on the server.",
        DbKind::Jdbc => "there is no portable dump tool for JDBC drivers.",
    };
    Some(format!("Backup for {} isn't available: {reason}", kind.label()))
}

/// The tools an operation needs, each as the names to try in order. Every group must be found.
///
/// MariaDB renamed its clients (`mariadb-dump`, `mariadb`) and keeps the MySQL names as links, so
/// each engine tries its own name first and the other's second.
pub fn tools(kind: DbKind, mode: Mode) -> Result<Vec<&'static [&'static str]>, String> {
    if let Some(reason) = unsupported(kind) {
        return Err(reason);
    }
    Ok(match (kind, mode) {
        (DbKind::Postgres | DbKind::Supabase, Mode::Backup) => vec![&["pg_dump"]],
        (DbKind::Postgres | DbKind::Supabase, Mode::Restore) => vec![&["psql"], &["pg_restore"]],
        (DbKind::Mysql, Mode::Backup) => vec![&["mysqldump", "mariadb-dump"]],
        (DbKind::Mysql, Mode::Restore) => vec![&["mysql", "mariadb"]],
        (DbKind::Mariadb, Mode::Backup) => vec![&["mariadb-dump", "mysqldump"]],
        (DbKind::Mariadb, Mode::Restore) => vec![&["mariadb", "mysql"]],
        (DbKind::Mongodb, Mode::Backup) => vec![&["mongodump"]],
        (DbKind::Mongodb, Mode::Restore) => vec![&["mongorestore"]],
        _ => Vec::new(),
    })
}

/// How to install a missing tool on this OS: a command, and the page that explains the rest.
pub fn install_hint(kind: DbKind, os: &str) -> (String, String) {
    let (mac, windows, linux, docs) = match kind {
        DbKind::Postgres | DbKind::Supabase => (
            "brew install libpq",
            "winget install PostgreSQL.PostgreSQL.17",
            "sudo apt install postgresql-client",
            "https://www.postgresql.org/download/",
        ),
        DbKind::Mysql => (
            "brew install mysql-client",
            "winget install Oracle.MySQL",
            "sudo apt install mysql-client",
            "https://dev.mysql.com/downloads/",
        ),
        DbKind::Mariadb => (
            "brew install mariadb",
            "winget install MariaDB.Server",
            "sudo apt install mariadb-client",
            "https://mariadb.org/download/",
        ),
        DbKind::Mongodb => (
            "brew install mongodb/brew/mongodb-database-tools",
            "winget install MongoDB.DatabaseTools",
            "sudo apt install mongodb-database-tools",
            "https://www.mongodb.com/try/download/database-tools",
        ),
        _ => ("", "", "", ""),
    };
    let install = match os {
        "macos" => mac,
        "windows" => windows,
        _ => linux,
    };
    (install.to_string(), docs.to_string())
}

/// The first of `names` found on `path` (a `PATH`-style list).
pub fn find_tool(names: &[&str], path: &str) -> Option<PathBuf> {
    names.iter().find_map(|name| crate::scaffold::tools::which_in(path, name))
}

/// `base` followed by the folders the vendors' installers use, which a GUI app's `PATH` often
/// doesn't name: Homebrew's keg-only `libpq` and `mysql-client`, Postgres.app, and on Windows the
/// versioned folders under Program Files, newest first.
pub fn search_path(base: &str) -> String {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut entries: Vec<String> = base.split(separator).filter(|e| !e.is_empty()).map(str::to_string).collect();
    for dir in install_dirs() {
        let text = dir.to_string_lossy().into_owned();
        if !entries.contains(&text) {
            entries.push(text);
        }
    }
    entries.join(&separator.to_string())
}

fn install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        for root in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            let Some(root) = std::env::var_os(root).map(PathBuf::from) else { continue };
            dirs.extend(versioned(&root.join("PostgreSQL"), "", "bin"));
            dirs.extend(versioned(&root.join("MySQL"), "", "bin"));
            dirs.extend(versioned(&root, "MariaDB", "bin"));
            dirs.extend(versioned(&root.join("MongoDB").join("Tools"), "", "bin"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        for fixed in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/homebrew/opt/libpq/bin",
            "/usr/local/opt/libpq/bin",
            "/opt/homebrew/opt/mysql-client/bin",
            "/usr/local/opt/mysql-client/bin",
            "/Applications/Postgres.app/Contents/Versions/latest/bin",
        ] {
            dirs.push(PathBuf::from(fixed));
        }
        for opt in ["/opt/homebrew/opt", "/usr/local/opt"] {
            dirs.extend(versioned(Path::new(opt), "postgresql@", "bin"));
            dirs.extend(versioned(Path::new(opt), "mysql-client@", "bin"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for fixed in ["/usr/bin", "/usr/local/bin", "/snap/bin"] {
            dirs.push(PathBuf::from(fixed));
        }
        dirs.extend(versioned(Path::new("/usr/lib/postgresql"), "", "bin"));
    }
    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

/// `root/<entry starting with prefix>/suffix` for each entry, the highest version first — so a
/// machine with PostgreSQL 14 and 17 installed side by side uses 17's `pg_dump`, which can dump
/// from either server (an older one refuses a newer server).
fn versioned(root: &Path, prefix: &str, suffix: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut found: Vec<(Vec<u64>, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with(prefix).then(|| (version_key(&name[prefix.len()..]), entry.path().join(suffix)))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, path)| path).collect()
}

/// The numbers in a folder name, in order: `17`, `8.0`, `MariaDB 11.4` → `[17]`, `[8, 0]`, `[11, 4]`.
fn version_key(name: &str) -> Vec<u64> {
    name.split(|c: char| !c.is_ascii_digit()).filter_map(|part| part.parse().ok()).collect()
}

/// The tools for an operation, resolved — or the first one that is missing.
///
/// Blocking: the user's `PATH` comes from a login shell (`scaffold::tools::current_path`).
pub fn locate(kind: DbKind, mode: Mode) -> Result<Result<Vec<PathBuf>, MissingTool>, String> {
    let groups = tools(kind, mode)?;
    let path = search_path(&crate::scaffold::tools::current_path(false));
    let mut found = Vec::new();
    for names in groups {
        match find_tool(names, &path) {
            Some(program) => found.push(program),
            None => {
                let (install, docs) = install_hint(kind, std::env::consts::OS);
                return Ok(Err(MissingTool { tool: names[0].to_string(), install, docs }));
            }
        }
    }
    Ok(Ok(found))
}

/// What the dialog asks before anything else: is the tool there? `None` when it is (or when the
/// engine needs none).
pub async fn check(kind: DbKind, mode: Mode) -> Result<Option<MissingTool>, String> {
    let located = tokio::task::spawn_blocking(move || locate(kind, mode)).await.map_err(|e| e.to_string())??;
    Ok(located.err())
}

async fn require(kind: DbKind, mode: Mode) -> Result<Vec<PathBuf>, String> {
    let located = tokio::task::spawn_blocking(move || locate(kind, mode)).await.map_err(|e| e.to_string())??;
    located.map_err(|missing| {
        format!("{} isn't installed on this machine. Install it with: {}", missing.tool, missing.install)
    })
}

// ---------------------------------------------------------------------------
// Connection URIs
// ---------------------------------------------------------------------------

/// A `scheme://[user[:password]@]hosts[/database][?query]` URI, split without being normalised —
/// Postgres and Mongo both allow several comma-separated hosts, which a general URL parser rejects.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Uri {
    scheme: String,
    user: Option<String>,
    password: Option<String>,
    hosts: String,
    database: String,
    query: String,
}

impl Uri {
    fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        let (scheme, rest) = text.split_once("://").ok_or_else(|| "That connection URL has no scheme.".to_string())?;
        // The authority ends at the first `/` or `?` after the *last* `@` — a password may hold
        // either, and `@` itself (see `postgres::normalize_url_credentials`).
        let after_at = rest.rfind('@').map(|at| at + 1).unwrap_or(0);
        let end = rest[after_at..].find(['/', '?']).map(|at| at + after_at).unwrap_or(rest.len());
        let authority = &rest[..end];
        let (userinfo, hosts) = match authority.rfind('@') {
            Some(at) => (Some(&authority[..at]), &authority[at + 1..]),
            None => (None, authority),
        };
        let decode = |part: &str| percent_decode_str(part).decode_utf8_lossy().into_owned();
        let (user, password) = match userinfo {
            Some(info) => match info.split_once(':') {
                Some((user, password)) => (Some(decode(user)), Some(decode(password))),
                None => (Some(decode(info)), None),
            },
            None => (None, None),
        };
        let tail = &rest[end..];
        let (path, query) = tail.split_once('?').unwrap_or((tail, ""));
        Ok(Uri {
            scheme: scheme.to_string(),
            user,
            password,
            hosts: hosts.to_string(),
            database: decode(path.trim_start_matches('/')),
            query: query.to_string(),
        })
    }

    fn param(&self, key: &str) -> Option<&str> {
        self.query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v)
    }

    fn add_param(&mut self, key: &str, value: &str) {
        if !self.query.is_empty() {
            self.query.push('&');
        }
        self.query.push_str(key);
        self.query.push('=');
        self.query.push_str(&encode(value));
    }

    /// Back to text. `with_password` false leaves the password out — for a URI that goes on argv.
    fn render(&self, with_password: bool) -> String {
        let mut out = format!("{}://", self.scheme);
        if let Some(user) = &self.user {
            out.push_str(&encode(user));
            if let (true, Some(password)) = (with_password, &self.password) {
                out.push(':');
                out.push_str(&encode(password));
            }
            out.push('@');
        }
        out.push_str(&self.hosts);
        if !self.database.is_empty() {
            out.push('/');
            out.push_str(&encode(&self.database));
        } else if !self.query.is_empty() {
            out.push('/');
        }
        if !self.query.is_empty() {
            out.push('?');
            out.push_str(&self.query);
        }
        out
    }
}

fn encode(text: &str) -> String {
    utf8_percent_encode(text, NON_ALPHANUMERIC).to_string()
}

/// The config as the tool should see it: through the tunnel when there is one. The tunnel handle is
/// returned so the caller holds it for the whole run.
async fn through_tunnel(config: &DbConnectionConfig) -> Result<(DbConnectionConfig, Option<Arc<tunnel::Tunnel>>), String> {
    if !config.ssh_enabled || config.kind == DbKind::Sqlite {
        return Ok((config.clone(), None));
    }
    if !config.url.trim().is_empty() {
        return Err("A connection through an SSH tunnel has to be defined by fields, not by a URL: the \
                    URL names the host to connect to directly, which is what the tunnel exists to avoid."
            .to_string());
    }
    let tunnel = tunnel::open(config).await?;
    let mut through = config.clone();
    through.host = "127.0.0.1".to_string();
    through.port = tunnel.local_port;
    Ok((through, Some(tunnel)))
}

fn refuse_entra(config: &DbConnectionConfig) -> Result<(), String> {
    if config.auth_method.is_entra() {
        return Err("Backup and restore sign in with a password; Microsoft Entra ID sign-in isn't supported here.".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

/// What a Postgres tool is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PgOp<'a> {
    Dump(PgFormat, &'a str),
    /// A `.sql` script, through `psql`.
    Script(&'a str),
    /// A custom-format archive, through `pg_restore`.
    Archive(&'a str),
}

/// Arguments and environment for one Postgres tool run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub fn pg_invocation(config: &DbConnectionConfig, database: Option<&str>, op: PgOp) -> Result<Invocation, String> {
    refuse_entra(config)?;
    let database = database.filter(|d| !d.is_empty());
    let mut args: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();
    let mut password = config.password.clone();

    match op {
        PgOp::Dump(format, path) => {
            args.push(format!("--format={}", if format == PgFormat::Custom { "custom" } else { "plain" }));
            args.push(format!("--file={path}"));
            args.push("--verbose".into());
        }
        PgOp::Script(_) => {
            // One transaction, stopped at the first error: a script half-applied is the worst state
            // to leave a database in, and the one psql leaves by default.
            args.extend(["--quiet", "--single-transaction", "--set=ON_ERROR_STOP=1"].map(String::from));
        }
        PgOp::Archive(_) => {
            args.extend(["--verbose", "--single-transaction", "--exit-on-error"].map(String::from));
        }
    }
    args.push("--no-password".into());

    if config.url.trim().is_empty() {
        args.push(format!("--host={}", config.host));
        args.push(format!("--port={}", config.effective_port()));
        if !config.user.is_empty() {
            args.push(format!("--username={}", config.user));
        }
        let name = database.unwrap_or(config.database.as_str());
        if !name.is_empty() {
            args.push(format!("--dbname={name}"));
        }
    } else {
        // libpq takes a URI as the database name. It goes on argv, so its password comes out of it
        // and into the environment.
        let mut uri = Uri::parse(&config.url)?;
        if let Some(inline) = uri.password.take().filter(|p| !p.is_empty()) {
            password = inline;
        }
        if let Some(name) = database {
            uri.database = name.to_string();
        }
        args.push(format!("--dbname={}", uri.render(false)));
    }

    match op {
        PgOp::Dump(..) => {}
        PgOp::Script(path) => args.push(format!("--file={path}")),
        PgOp::Archive(path) => args.push(path.to_string()),
    }

    if !password.is_empty() {
        env.push(("PGPASSWORD".into(), password));
    }
    // `Disable` is what the driver treats as "prefer": TLS when the server offers it.
    let mode = match config.ssl {
        DbSslMode::Disable => "prefer",
        DbSslMode::Require => "require",
        DbSslMode::VerifyFull => "verify-full",
    };
    env.push(("PGSSLMODE".into(), mode.into()));
    let ca = config.ssl_ca_file.trim();
    if !ca.is_empty() {
        env.push(("PGSSLROOTCERT".into(), ca.into()));
    } else if config.ssl == DbSslMode::VerifyFull {
        // libpq 16+: the OS trust store, which is what the driver verifies against too.
        env.push(("PGSSLROOTCERT".into(), "system".into()));
    }
    if !config.ssl_cert_file.trim().is_empty() {
        env.push(("PGSSLCERT".into(), config.ssl_cert_file.trim().into()));
    }
    if !config.ssl_key_file.trim().is_empty() {
        env.push(("PGSSLKEY".into(), config.ssl_key_file.trim().into()));
    }
    env.push(("PGCONNECT_TIMEOUT".into(), config.connect_timeout().as_secs().max(2).to_string()));
    env.push(("PGAPPNAME".into(), "CodeFlow".into()));
    Ok(Invocation { args, env })
}

/// Whether a file is a `pg_dump` custom archive (`PGDMP` magic) rather than a script.
fn is_pg_archive(path: &Path) -> bool {
    use std::io::Read;
    let mut magic = [0u8; 5];
    std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut magic)).is_ok() && &magic == b"PGDMP"
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB
// ---------------------------------------------------------------------------

/// The `[client]` option file that carries the login, so the password is never on argv.
///
/// The TLS settings are written for both families at once, each behind `loose-`: MySQL reads
/// `ssl-mode` and MariaDB doesn't know it, MariaDB reads `ssl`/`ssl-verify-server-cert` and MySQL 8
/// has dropped them. `loose-` makes a client skip the option it doesn't know instead of failing —
/// and `mysqldump` on a Homebrew MariaDB is MariaDB's, so the binary's name says nothing.
pub fn mysql_option_file(config: &DbConnectionConfig) -> Result<String, String> {
    refuse_entra(config)?;
    let (host, port, user, mut password) = if config.url.trim().is_empty() {
        (config.host.clone(), config.effective_port(), config.user.clone(), String::new())
    } else {
        let uri = Uri::parse(&config.url)?;
        let (host, port) = match uri.hosts.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() => {
                (host.to_string(), port.parse().unwrap_or(3306))
            }
            _ => (uri.hosts.clone(), 3306),
        };
        (host, port, uri.user.unwrap_or_default(), uri.password.unwrap_or_default())
    };
    if password.is_empty() {
        password = config.password.clone();
    }

    let mut lines = vec!["[client]".to_string()];
    let quoted = |key: &str, value: &str| format!("{key}=\"{}\"", option_escape(value));
    if !user.is_empty() {
        lines.push(quoted("user", &user));
    }
    if !password.is_empty() {
        lines.push(quoted("password", &password));
    }
    lines.push(quoted("host", &host));
    lines.push(format!("port={port}"));
    // `localhost` means the Unix socket to these clients, not TCP — and the socket is rarely where a
    // Docker container's server is listening.
    lines.push("protocol=tcp".into());
    lines.push(format!("connect-timeout={}", config.connect_timeout().as_secs().max(2)));
    match config.ssl {
        DbSslMode::Disable => {
            lines.push("loose-ssl-mode=PREFERRED".into());
            lines.push("loose-disable-ssl-verify-server-cert".into());
        }
        DbSslMode::Require => {
            lines.push("loose-ssl-mode=REQUIRED".into());
            lines.push("loose-ssl".into());
            lines.push("loose-disable-ssl-verify-server-cert".into());
        }
        DbSslMode::VerifyFull => {
            lines.push("loose-ssl-mode=VERIFY_IDENTITY".into());
            lines.push("loose-ssl".into());
            lines.push("loose-ssl-verify-server-cert".into());
        }
    }
    for (key, value) in [("ssl-ca", &config.ssl_ca_file), ("ssl-cert", &config.ssl_cert_file), ("ssl-key", &config.ssl_key_file)] {
        if !value.trim().is_empty() {
            lines.push(quoted(key, value.trim()));
        }
    }
    // A dump of a GTID server otherwise starts with `SET @@GLOBAL.GTID_PURGED`, which a restore
    // into anything but an empty replica refuses. MySQL only; MariaDB skips it.
    lines.push(String::new());
    lines.push("[mysqldump]".into());
    lines.push("loose-set-gtid-purged=OFF".into());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// A value inside double quotes in a MySQL option file.
fn option_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

/// The database a MySQL tool targets: the one asked for, the connection's, or the URL's.
fn mysql_database(config: &DbConnectionConfig, database: Option<&str>) -> String {
    if let Some(name) = database.filter(|d| !d.is_empty()) {
        return name.to_string();
    }
    if !config.database.is_empty() {
        return config.database.clone();
    }
    Uri::parse(&config.url).map(|uri| uri.database).unwrap_or_default()
}

pub fn mysql_dump_args(options: &str, database: &str, out: &str) -> Vec<String> {
    // `--defaults-extra-file` has to be the first argument, or the clients ignore it.
    let mut args = vec![
        format!("--defaults-extra-file={options}"),
        "--single-transaction".into(),
        "--routines".into(),
        "--triggers".into(),
        "--hex-blob".into(),
        "--verbose".into(),
        format!("--result-file={out}"),
    ];
    if database.is_empty() {
        args.push("--all-databases".into());
    } else {
        args.push(database.to_string());
    }
    args
}

pub fn mysql_restore_args(options: &str, database: &str) -> Vec<String> {
    let mut args = vec![format!("--defaults-extra-file={options}")];
    if !database.is_empty() {
        args.push(database.to_string());
    }
    args
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

/// The URI the Mongo tools connect with, credentials included — it only ever goes into the
/// `--config` file.
///
/// A backup names the database in the path, which is how `mongodump` scopes itself to one. Replacing
/// a URI's database moves the default auth source with it, so the old one is pinned as `authSource`
/// first. A restore leaves the path empty: the archive names its own namespaces.
pub fn mongo_uri(config: &DbConnectionConfig, database: Option<&str>, mode: Mode) -> Result<String, String> {
    let wanted = database.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| config.database.clone());
    let mut uri = if config.url.trim().is_empty() {
        let mut uri = Uri {
            scheme: "mongodb".into(),
            user: None,
            password: None,
            hosts: format!("{}:{}", config.host, config.effective_port()),
            database: String::new(),
            query: String::new(),
        };
        if !config.user.is_empty() {
            uri.user = Some(config.user.clone());
            uri.password = Some(config.password.clone()).filter(|p| !p.is_empty());
            uri.add_param("authSource", config.option("authSource").unwrap_or("admin"));
        }
        uri
    } else {
        let mut uri = Uri::parse(&config.url)?;
        if uri.user.is_some() && uri.password.as_deref().unwrap_or("").is_empty() && !config.password.is_empty() {
            uri.password = Some(config.password.clone());
        }
        uri
    };

    let target = if mode == Mode::Backup { wanted } else { String::new() };
    if uri.database != target {
        if uri.user.is_some() && uri.param("authSource").is_none() {
            let source = if uri.database.is_empty() { "admin".to_string() } else { uri.database.clone() };
            uri.add_param("authSource", &source);
        }
        uri.database = target;
    }

    let has_tls = uri.param("tls").is_some() || uri.param("ssl").is_some();
    if config.ssl != DbSslMode::Disable && !has_tls {
        uri.add_param("tls", "true");
        if config.ssl == DbSslMode::Require {
            uri.add_param("tlsInsecure", "true");
        }
    }
    if !config.ssl_ca_file.trim().is_empty() && uri.param("tlsCAFile").is_none() {
        uri.add_param("tlsCAFile", config.ssl_ca_file.trim());
    }
    if !config.ssl_cert_file.trim().is_empty() && uri.param("tlsCertificateKeyFile").is_none() {
        uri.add_param("tlsCertificateKeyFile", config.ssl_cert_file.trim());
    }
    if uri.param("appName").is_none() {
        uri.add_param("appName", "CodeFlow");
    }
    Ok(uri.render(true))
}

/// The `--config` file for `mongodump`/`mongorestore`: YAML with the URI as a double-quoted string.
pub fn mongo_config(uri: &str) -> String {
    format!("uri: \"{}\"\n", uri.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn mongo_args(config_file: &str, archive: &str, mode: Mode) -> Vec<String> {
    let mut args = vec![format!("--config={config_file}"), format!("--archive={archive}"), "--gzip".into()];
    if mode == Mode::Restore {
        args.push("--stopOnError".into());
    }
    args
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/// The database file of a SQLite connection — `sqlite::database_path`'s rules.
fn sqlite_path(config: &DbConnectionConfig) -> Result<String, String> {
    let named = config.database.trim();
    let raw = if !named.is_empty() {
        named.to_string()
    } else {
        let url = config.url.trim();
        url.strip_prefix("sqlite://")
            .or_else(|| url.strip_prefix("sqlite:"))
            .or_else(|| url.strip_prefix("file://"))
            .or_else(|| url.strip_prefix("file:"))
            .unwrap_or(url)
            .to_string()
    };
    if raw.is_empty() || raw == ":memory:" {
        return Err("This SQLite connection has no database file to back up.".to_string());
    }
    let path = match (raw.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => raw,
    };
    if !Path::new(&path).is_file() {
        return Err(format!("There is no SQLite database at {path}."));
    }
    Ok(path)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// `VACUUM INTO` on a read-only connection: a consistent copy, compacted, taken without blocking
/// writers for longer than a read does. The path is a bound parameter, so no quoting can go wrong.
fn sqlite_backup(source: &str, out: &Path, notify: Arc<Notify>) -> Result<(), String> {
    use rusqlite::{Connection, OpenFlags};
    if same_file(Path::new(source), out) {
        return Err("The backup can't overwrite the database it is a backup of.".to_string());
    }
    // The save dialog already asked about overwriting, and VACUUM INTO refuses an existing file.
    if out.exists() {
        std::fs::remove_file(out).map_err(|e| format!("{}: {e}", out.display()))?;
    }
    let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("SQLite could not open {source}: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
    let _watch = interrupt_on(notify, conn.get_interrupt_handle());
    conn.execute("VACUUM INTO ?1", [out.to_string_lossy().as_ref()]).map_err(sqlite_error)?;
    Ok(())
}

/// Runs a `.sql` script into the database file, in one transaction — unless the script brings its
/// own (`sqlite3 .dump` writes `BEGIN TRANSACTION … COMMIT`), which cannot nest inside ours.
fn sqlite_script(target: &str, script_path: &Path, notify: Arc<Notify>) -> Result<(), String> {
    use rusqlite::{Connection, OpenFlags};
    let mut head = [0u8; 16];
    {
        use std::io::Read;
        let mut file = std::fs::File::open(script_path).map_err(|e| format!("{}: {e}", script_path.display()))?;
        let read = file.read(&mut head).unwrap_or(0);
        if read == 16 && &head == b"SQLite format 3\0" {
            return Err("That file is a SQLite database, not a script. Restoring a file over the open \
                        database isn't supported; choose a .sql script to run into it."
                .to_string());
        }
    }
    let script = std::fs::read_to_string(script_path).map_err(|e| format!("{}: {e}", script_path.display()))?;
    let mut conn = Connection::open_with_flags(target, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("SQLite could not open {target}: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
    let _watch = interrupt_on(notify, conn.get_interrupt_handle());
    let outcome = (|| -> rusqlite::Result<()> {
        let tx = conn.transaction()?;
        tx.execute_batch(&script)?;
        tx.commit()
    })();
    match outcome {
        Ok(()) => Ok(()),
        Err(error) if error.to_string().contains("within a transaction") => conn.execute_batch(&script).map_err(sqlite_error),
        Err(error) => Err(sqlite_error(error)),
    }
}

fn sqlite_error(error: rusqlite::Error) -> String {
    if matches!(&error, rusqlite::Error::SqliteFailure(e, _) if e.code == rusqlite::ErrorCode::OperationInterrupted) {
        return CANCELLED.to_string();
    }
    error.to_string()
}

/// Aborts a task when dropped.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Interrupts the connection when the run is cancelled; the watcher ends when the guard drops.
/// Called from `spawn_blocking`, which runs inside the runtime, so `Handle::current` is there.
fn interrupt_on(notify: Arc<Notify>, handle: rusqlite::InterruptHandle) -> AbortOnDrop {
    AbortOnDrop(tokio::runtime::Handle::current().spawn(async move {
        notify.notified().await;
        handle.interrupt();
    }))
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

fn runs() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A run's place in the cancel map, for as long as it is running.
struct Registered {
    id: String,
    notify: Arc<Notify>,
}

impl Registered {
    fn new(id: &str) -> Self {
        let notify = Arc::new(Notify::new());
        if let Ok(mut map) = runs().lock() {
            map.insert(id.to_string(), notify.clone());
        }
        Registered { id: id.to_string(), notify }
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        if let Ok(mut map) = runs().lock() {
            map.remove(&self.id);
        }
    }
}

/// Stops a run. An unknown id is fine — the run may have finished a moment earlier.
pub fn cancel(run_id: &str) {
    if let Some(notify) = runs().lock().ok().and_then(|map| map.get(run_id).cloned()) {
        // `notify_one` keeps a permit when nobody is waiting yet, so an early cancel isn't lost.
        notify.notify_one();
    }
}

/// A file holding a credential, readable by this user only, deleted when dropped.
struct SecretFile(PathBuf);

impl SecretFile {
    fn write(extension: &str, contents: &str) -> Result<Self, String> {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("codeflow-backup-{}.{extension}", uuid::Uuid::new_v4().simple()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let written = file.write_all(contents.as_bytes()).and_then(|_| file.sync_all());
        let secret = SecretFile(path);
        written.map_err(|e| e.to_string())?;
        Ok(secret)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

struct ToolRun {
    program: PathBuf,
    args: Vec<String>,
    env: Vec<(String, String)>,
    stdin: Option<PathBuf>,
}

/// Runs a tool to the end, streaming every output line to `on_line`. A non-zero exit is an error
/// carrying the last lines it printed; a cancel kills the whole process tree.
async fn run_tool(run: ToolRun, notify: &Notify, on_line: &(dyn Fn(String) + Send + Sync)) -> Result<(), String> {
    use std::process::Stdio;
    let name = run.program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut command = crate::proc::command(&run.program);
    command.args(&run.args).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (key, value) in &run.env {
        command.env(key, value);
    }
    command.stdin(match &run.stdin {
        Some(path) => Stdio::from(std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?),
        None => Stdio::null(),
    });
    crate::proc::own_process_group(&mut command);
    let mut child = command.spawn().map_err(|e| format!("{name} couldn't be started: {e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    fn pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(reader: R, tx: tokio::sync::mpsc::UnboundedSender<String>) {
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buffer).trim_end().to_string();
                        if !line.is_empty() && tx.send(line).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        pump(stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        pump(stderr, tx.clone());
    }
    drop(tx);

    let mut tail: VecDeque<String> = VecDeque::new();
    let keep = |line: String, tail: &mut VecDeque<String>| {
        if tail.len() == ERROR_TAIL {
            tail.pop_front();
        }
        tail.push_back(line.clone());
        on_line(line);
    };
    let status = loop {
        tokio::select! {
            Some(line) = rx.recv() => keep(line, &mut tail),
            status = child.wait() => break status.map_err(|e| e.to_string())?,
            _ = notify.notified() => {
                crate::ai_runs::kill_tree(&mut child).await;
                return Err(CANCELLED.to_string());
            }
        }
    };
    // What the tool printed just before exiting is usually why it exited.
    while let Ok(Some(line)) = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await {
        keep(line, &mut tail);
    }
    if status.success() {
        return Ok(());
    }
    let said: Vec<String> = tail.into_iter().collect();
    let code = status.code().map(|c| format!(" (exit {c})")).unwrap_or_default();
    if said.is_empty() {
        Err(format!("{name} failed{code}."))
    } else {
        Err(format!("{name} failed{code}:\n{}", said.join("\n")))
    }
}

fn outcome(path: &str, started: Instant) -> Outcome {
    Outcome {
        path: path.to_string(),
        bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

/// Backs the database up to `path`. A failed or cancelled backup removes the partial file.
pub async fn backup(
    config: &DbConnectionConfig,
    database: Option<&str>,
    path: &str,
    format: PgFormat,
    run_id: &str,
    on_line: &(dyn Fn(String) + Send + Sync),
) -> Result<Outcome, String> {
    if let Some(reason) = unsupported(config.kind) {
        return Err(reason);
    }
    let started = Instant::now();
    let registered = Registered::new(run_id);
    // Only a file this run wrote is removed on failure. A run refused before it started — a missing
    // tool, or a SQLite backup pointed at the database itself — must leave whatever is there alone.
    let stamp = |path: &str| std::fs::metadata(path).ok().map(|m| (m.len(), m.modified().ok()));
    let before = stamp(path);
    let result = backup_inner(config, database, path, format, &registered.notify, on_line).await;
    if result.is_err() && stamp(path) != before {
        let _ = std::fs::remove_file(path);
    }
    result.map(|()| outcome(path, started))
}

async fn backup_inner(
    config: &DbConnectionConfig,
    database: Option<&str>,
    path: &str,
    format: PgFormat,
    notify: &Arc<Notify>,
    on_line: &(dyn Fn(String) + Send + Sync),
) -> Result<(), String> {
    if config.kind == DbKind::Sqlite {
        let source = sqlite_path(config)?;
        on_line(format!("VACUUM INTO {path}"));
        let (out, notify) = (PathBuf::from(path), notify.clone());
        return tokio::task::spawn_blocking(move || sqlite_backup(&source, &out, notify))
            .await
            .map_err(|e| e.to_string())?;
    }
    let tools = require(config.kind, Mode::Backup).await?;
    let (config, _tunnel) = through_tunnel(config).await?;
    let run = match config.kind {
        DbKind::Postgres | DbKind::Supabase => {
            let invocation = pg_invocation(&config, database, PgOp::Dump(format, path))?;
            ToolRun { program: tools[0].clone(), args: invocation.args, env: invocation.env, stdin: None }
        }
        DbKind::Mysql | DbKind::Mariadb => {
            let options = SecretFile::write("cnf", &mysql_option_file(&config)?)?;
            let args = mysql_dump_args(&options.path(), &mysql_database(&config, database), path);
            return run_tool(ToolRun { program: tools[0].clone(), args, env: Vec::new(), stdin: None }, notify, on_line).await;
        }
        DbKind::Mongodb => {
            let file = SecretFile::write("yaml", &mongo_config(&mongo_uri(&config, database, Mode::Backup)?))?;
            let args = mongo_args(&file.path(), path, Mode::Backup);
            return run_tool(ToolRun { program: tools[0].clone(), args, env: Vec::new(), stdin: None }, notify, on_line).await;
        }
        _ => return Err(unsupported(config.kind).unwrap_or_default()),
    };
    run_tool(run, notify, on_line).await
}

/// Restores `path` into the database. Writes, so the caller has already refused a read-only
/// connection and the user has already confirmed.
pub async fn restore(
    config: &DbConnectionConfig,
    database: Option<&str>,
    path: &str,
    run_id: &str,
    on_line: &(dyn Fn(String) + Send + Sync),
) -> Result<Outcome, String> {
    if let Some(reason) = unsupported(config.kind) {
        return Err(reason);
    }
    if !Path::new(path).is_file() {
        return Err(format!("There is no file at {path}."));
    }
    let started = Instant::now();
    let registered = Registered::new(run_id);
    let notify = &registered.notify;

    if config.kind == DbKind::Sqlite {
        let target = sqlite_path(config)?;
        on_line(format!("{path} → {target}"));
        let (script, notify) = (PathBuf::from(path), notify.clone());
        tokio::task::spawn_blocking(move || sqlite_script(&target, &script, notify))
            .await
            .map_err(|e| e.to_string())??;
        return Ok(outcome(path, started));
    }

    let tools = require(config.kind, Mode::Restore).await?;
    let (config, _tunnel) = through_tunnel(config).await?;
    match config.kind {
        DbKind::Postgres | DbKind::Supabase => {
            let archive = is_pg_archive(Path::new(path));
            let op = if archive { PgOp::Archive(path) } else { PgOp::Script(path) };
            let invocation = pg_invocation(&config, database, op)?;
            let program = if archive { tools[1].clone() } else { tools[0].clone() };
            run_tool(ToolRun { program, args: invocation.args, env: invocation.env, stdin: None }, notify, on_line).await?;
        }
        DbKind::Mysql | DbKind::Mariadb => {
            let options = SecretFile::write("cnf", &mysql_option_file(&config)?)?;
            let args = mysql_restore_args(&options.path(), &mysql_database(&config, database));
            let run = ToolRun { program: tools[0].clone(), args, env: Vec::new(), stdin: Some(PathBuf::from(path)) };
            run_tool(run, notify, on_line).await?;
        }
        DbKind::Mongodb => {
            let file = SecretFile::write("yaml", &mongo_config(&mongo_uri(&config, database, Mode::Restore)?))?;
            let args = mongo_args(&file.path(), path, Mode::Restore);
            run_tool(ToolRun { program: tools[0].clone(), args, env: Vec::new(), stdin: None }, notify, on_line).await?;
        }
        _ => return Err(unsupported(config.kind).unwrap_or_default()),
    }
    Ok(outcome(path, started))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(kind: &str, extra: serde_json::Value) -> DbConnectionConfig {
        let mut base = serde_json::json!({
            "id": "c1",
            "kind": kind,
            "host": "db.example.com",
            "port": 0,
            "database": "shop",
            "user": "app",
            "password": "s3cr\"et",
            "ssl": "disable",
        });
        if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        serde_json::from_value(base).unwrap()
    }

    fn env<'a>(invocation: &'a Invocation, key: &str) -> Option<&'a str> {
        invocation.env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// The whole point of the env var: no argument may carry the password.
    #[test]
    fn pg_dump_keeps_the_password_off_argv() {
        let c = config("postgres", serde_json::json!({}));
        let run = pg_invocation(&c, None, PgOp::Dump(PgFormat::Custom, "/tmp/out.dump")).unwrap();
        assert!(run.args.contains(&"--format=custom".to_string()));
        assert!(run.args.contains(&"--file=/tmp/out.dump".to_string()));
        assert!(run.args.contains(&"--host=db.example.com".to_string()));
        assert!(run.args.contains(&"--port=5432".to_string()));
        assert!(run.args.contains(&"--dbname=shop".to_string()));
        assert!(run.args.iter().all(|arg| !arg.contains("s3cr")), "{:?}", run.args);
        assert_eq!(env(&run, "PGPASSWORD"), Some("s3cr\"et"));
        assert_eq!(env(&run, "PGSSLMODE"), Some("prefer"));
    }

    #[test]
    fn pg_url_password_moves_to_the_environment() {
        let c = config(
            "supabase",
            serde_json::json!({ "url": "postgresql://postgres.ref:p%40ss@pooler.example.com:6543/postgres?sslmode=require", "ssl": "verify_full" }),
        );
        let run = pg_invocation(&c, Some("other"), PgOp::Dump(PgFormat::Plain, "/tmp/x.sql")).unwrap();
        let dbname = run.args.iter().find(|a| a.starts_with("--dbname=")).unwrap();
        assert_eq!(dbname, "--dbname=postgresql://postgres%2Eref@pooler.example.com:6543/other?sslmode=require");
        assert_eq!(env(&run, "PGPASSWORD"), Some("p@ss"));
        assert_eq!(env(&run, "PGSSLMODE"), Some("verify-full"));
        assert_eq!(env(&run, "PGSSLROOTCERT"), Some("system"));
    }

    #[test]
    fn pg_restore_picks_its_tool_flags() {
        let c = config("postgres", serde_json::json!({ "port": 6000 }));
        let script = pg_invocation(&c, None, PgOp::Script("/tmp/a.sql")).unwrap();
        assert!(script.args.contains(&"--set=ON_ERROR_STOP=1".to_string()));
        assert_eq!(script.args.last().unwrap(), "--file=/tmp/a.sql");
        let archive = pg_invocation(&c, None, PgOp::Archive("/tmp/a.dump")).unwrap();
        assert!(archive.args.contains(&"--exit-on-error".to_string()));
        assert!(archive.args.contains(&"--port=6000".to_string()));
        assert_eq!(archive.args.last().unwrap(), "/tmp/a.dump");
    }

    #[test]
    fn entra_sign_in_is_refused() {
        let c = config("postgres", serde_json::json!({ "auth_method": "entra_cli" }));
        assert!(pg_invocation(&c, None, PgOp::Script("/x")).is_err());
    }

    #[test]
    fn mysql_option_file_carries_the_login() {
        let c = config("mysql", serde_json::json!({ "host": "localhost", "ssl": "require", "ssl_ca_file": "C:\\certs\\ca.pem" }));
        let text = mysql_option_file(&c).unwrap();
        assert!(text.starts_with("[client]\n"), "{text}");
        assert!(text.contains("user=\"app\""));
        assert!(text.contains("password=\"s3cr\\\"et\""), "{text}");
        assert!(text.contains("port=3306"));
        assert!(text.contains("protocol=tcp"));
        assert!(text.contains("loose-ssl-mode=REQUIRED"));
        assert!(text.contains("ssl-ca=\"C:\\\\certs\\\\ca.pem\""), "{text}");
        assert!(text.contains("[mysqldump]\nloose-set-gtid-purged=OFF"));
    }

    #[test]
    fn mysql_url_is_split_into_fields() {
        let c = config("mariadb", serde_json::json!({ "url": "mariadb://root:pw%2F1@10.0.0.5:3307/app", "password": "" }));
        let text = mysql_option_file(&c).unwrap();
        assert!(text.contains("host=\"10.0.0.5\""), "{text}");
        assert!(text.contains("port=3307"));
        assert!(text.contains("password=\"pw/1\""));
        assert_eq!(mysql_database(&config("mysql", serde_json::json!({ "database": "", "url": "mysql://h/app" })), None), "app");
    }

    #[test]
    fn mysql_args_put_the_defaults_file_first() {
        let args = mysql_dump_args("/tmp/x.cnf", "shop", "/tmp/out.sql");
        assert_eq!(args[0], "--defaults-extra-file=/tmp/x.cnf");
        assert_eq!(args.last().unwrap(), "shop");
        assert!(args.contains(&"--result-file=/tmp/out.sql".to_string()));
        assert_eq!(mysql_dump_args("/tmp/x.cnf", "", "/o").last().unwrap(), "--all-databases");
        assert_eq!(mysql_restore_args("/tmp/x.cnf", "shop"), vec!["--defaults-extra-file=/tmp/x.cnf", "shop"]);
    }

    #[test]
    fn mongo_uri_from_fields_and_from_a_url() {
        let c = config("mongodb", serde_json::json!({ "ssl": "require" }));
        assert_eq!(
            mongo_uri(&c, None, Mode::Backup).unwrap(),
            "mongodb://app:s3cr%22et@db.example.com:27017/shop?authSource=admin&tls=true&tlsInsecure=true&appName=CodeFlow"
        );
        // A restore has no database in the path, and the URI's own database stays the auth source.
        let c = config("mongodb", serde_json::json!({ "url": "mongodb+srv://u@cluster0.example.net/sales?retryWrites=true", "database": "" }));
        assert_eq!(
            mongo_uri(&c, None, Mode::Restore).unwrap(),
            "mongodb+srv://u:s3cr%22et@cluster0.example.net/?retryWrites=true&authSource=sales&appName=CodeFlow"
        );
        assert_eq!(mongo_config("mongodb://a\"b"), "uri: \"mongodb://a\\\"b\"\n");
        assert_eq!(mongo_args("/c.yaml", "/a.gz", Mode::Backup), vec!["--config=/c.yaml", "--archive=/a.gz", "--gzip"]);
    }

    #[test]
    fn unsupported_engines_say_so() {
        for kind in [DbKind::Sqlserver, DbKind::Oracle, DbKind::Iris, DbKind::Redis, DbKind::Jdbc] {
            let reason = unsupported(kind).unwrap();
            assert!(reason.starts_with("Backup for "), "{reason}");
            assert!(tools(kind, Mode::Backup).is_err());
        }
        assert!(unsupported(DbKind::Sqlite).is_none());
        assert!(tools(DbKind::Sqlite, Mode::Backup).unwrap().is_empty());
        assert_eq!(tools(DbKind::Postgres, Mode::Restore).unwrap(), vec![&["psql"][..], &["pg_restore"][..]]);
    }

    #[test]
    fn install_hints_follow_the_os() {
        assert_eq!(install_hint(DbKind::Postgres, "macos").0, "brew install libpq");
        assert!(install_hint(DbKind::Mongodb, "windows").0.starts_with("winget"));
        assert!(install_hint(DbKind::Mysql, "linux").0.contains("apt"));
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-backup-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_tool(dir: &Path, name: &str) -> PathBuf {
        let file = if cfg!(windows) { dir.join(format!("{name}.exe")) } else { dir.join(name) };
        std::fs::write(&file, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        file
    }

    #[test]
    fn finds_a_tool_by_its_first_available_name() {
        let (a, b) = (scratch(), scratch());
        let separator = if cfg!(windows) { ";" } else { ":" };
        let path = format!("{}{separator}{}", a.display(), b.display());
        assert_eq!(find_tool(&["mariadb-dump", "mysqldump"], &path), None);
        let dump = fake_tool(&b, "mysqldump");
        assert_eq!(find_tool(&["mariadb-dump", "mysqldump"], &path), Some(dump));
        let maria = fake_tool(&a, "mariadb-dump");
        assert_eq!(find_tool(&["mariadb-dump", "mysqldump"], &path), Some(maria));
        let _ = (std::fs::remove_dir_all(a), std::fs::remove_dir_all(b));
    }

    #[test]
    fn versioned_folders_newest_first() {
        let root = scratch();
        for name in ["9.6", "17", "14", "notes"] {
            std::fs::create_dir_all(root.join(name).join("bin")).unwrap();
        }
        let found: Vec<String> = versioned(&root, "", "bin")
            .iter()
            .map(|p| p.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(&found[..3], ["17", "14", "9.6"]);
        assert_eq!(version_key("MariaDB 11.4"), vec![11, 4]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn search_path_keeps_the_users_path_first() {
        let separator = if cfg!(windows) { ';' } else { ':' };
        let joined = search_path(&format!("/first{separator}/second"));
        assert!(joined.starts_with(&format!("/first{separator}/second")), "{joined}");
    }

    #[test]
    fn uri_round_trips_hosts_and_query() {
        let uri = Uri::parse("mongodb://a:b@h1:1,h2:2/db?replicaSet=rs").unwrap();
        assert_eq!(uri.hosts, "h1:1,h2:2");
        assert_eq!(uri.database, "db");
        assert_eq!(uri.param("replicaset"), Some("rs"));
        assert_eq!(uri.render(true), "mongodb://a:b@h1:1,h2:2/db?replicaSet=rs");
        assert_eq!(uri.render(false), "mongodb://a@h1:1,h2:2/db?replicaSet=rs");
    }

    #[test]
    fn secret_file_is_private_and_removed() {
        let path;
        {
            let file = SecretFile::write("cnf", "[client]\n").unwrap();
            path = PathBuf::from(file.path());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "[client]\n");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        assert!(!path.exists());
    }

    #[test]
    fn sqlite_backup_and_script() {
        let dir = scratch();
        let db = dir.join("a.db");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);").unwrap();
        }
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();
        let out = dir.join("it's a copy.db");
        sqlite_backup(db.to_str().unwrap(), &out, Arc::new(Notify::new())).unwrap();
        let copy = rusqlite::Connection::open(&out).unwrap();
        let n: i64 = copy.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert!(sqlite_backup(db.to_str().unwrap(), &db, Arc::new(Notify::new())).is_err());

        let script = dir.join("s.sql");
        std::fs::write(&script, "INSERT INTO t VALUES (2);").unwrap();
        sqlite_script(db.to_str().unwrap(), &script, Arc::new(Notify::new())).unwrap();
        // A script that brings its own transaction, the way `sqlite3 .dump` writes one.
        std::fs::write(&script, "BEGIN TRANSACTION; INSERT INTO t VALUES (3); COMMIT;").unwrap();
        sqlite_script(db.to_str().unwrap(), &script, Arc::new(Notify::new())).unwrap();
        // A failing script leaves nothing behind.
        std::fs::write(&script, "INSERT INTO t VALUES (4); INSERT INTO nope VALUES (1);").unwrap();
        assert!(sqlite_script(db.to_str().unwrap(), &script, Arc::new(Notify::new())).is_err());
        assert!(sqlite_script(db.to_str().unwrap(), &out, Arc::new(Notify::new())).is_err());
        let conn = rusqlite::Connection::open(&db).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
        drop((copy, conn));
        let _ = std::fs::remove_dir_all(dir);
    }
}
