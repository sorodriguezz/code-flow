//! Redis, the sixth engine — and the second that is not a database of tables.
//!
//! MongoDB is the precedent to read before this file, not the three SQL drivers: like Mongo, Redis
//! has no catalog to query, no schema to introspect and no statement language to generate. What it
//! has instead is a keyspace, and the whole design here is about presenting one honestly.
//!
//! **The one rule this module is built around: never enumerate the keyspace.**
//!
//! `KEYS *` is a single command that blocks the entire server — every client, every request — for
//! as long as it takes to walk every key. On a production instance with ten million keys that is
//! seconds of total outage, caused by opening a tree node. So there is no code path in this file
//! that can emit `KEYS`, the console refuses the command outright (see [`refusal_for`]), and every
//! listing goes through a *bounded* `SCAN` sweep: at most [`SCAN_BUDGET`] cursor round trips, after
//! which the sweep stops and the tree **says it stopped**. A partial answer that admits it is
//! partial is the correct behaviour here; a complete answer that costs an outage is not.
//!
//! **How the tree maps onto a keyspace.** Redis has no collections, so the levels are invented from
//! the convention every real keyspace already uses — colon-separated namespaces:
//!
//! ```text
//! connection ──▶ db0, db1, …          Database    (INFO keyspace)
//!                  └─▶ user, session   Collection  (bounded SCAN, one namespace segment)
//!                        └─▶ user:42   Collection  (nested namespaces, recursive)
//!                              └─▶ profile  Table  (an actual key — the thing you open)
//!                                    ├─▶ Fields   ColumnFolder (synthetic, 0 round trips)
//!                                    └─▶ Details  IndexFolder  (synthetic, 0 round trips)
//! ```
//!
//! No new `DbNodeKind` variant is introduced, deliberately: `Collection` and `Table` already land
//! in the frontend's `isRelation` set, which is exactly right — both are things you can "Open data"
//! on — and adding a variant would force an entry in four exhaustive frontend maps for cosmetics.
//! Mongo made the same choice.
//!
//! **The key is the table.** Opening a *key* shows its value as rows, shaped by its type — a hash
//! is field/value, a zset is member/score, a list is index/value. Opening a *namespace* shows the
//! keys under it, one row per key, with type/TTL/encoding. Those are two different grids from one
//! [`table_data`], chosen by `node.kind`, and it is why `row_count` can be O(1) on a key and has to
//! refuse on a namespace: counting keys under a prefix means scanning the keyspace, which is the
//! one thing this module will not do.
//!
//! **Binary safety.** Redis values are bytes, not text. A value that is not valid UTF-8 is rendered
//! in `redis-cli`'s own escaped form (`\x00\xff`) and typed `binary` — never through
//! `from_utf8_lossy`, which would put U+FFFD in a grid the user is about to edit and write that
//! back over their data. This is the module-level rule stated in `datasource/mod.rs` applied to the
//! one engine where it bites hardest.
//!
//! **Why `ConnectionManager` and not `aio::Connection`.** The manager multiplexes: it tags requests
//! and its background actor consumes every response whether or not a caller is still waiting. That
//! is what makes `DbRegistry::run` dropping a cancelled future *safe*, and therefore why
//! `Session::poisoned_by_cancel` can keep returning false for Redis. A plain connection would have
//! SQL Server's exact problem — a socket left mid-response and the next command reading the
//! previous answer — and would need the same poison treatment. Do not swap it.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

// `use ::redis as client` rather than `use redis::…`: this module is *itself* `datasource::redis`,
// and inside `datasource/mod.rs` the bare path `redis::` resolves to this sibling module while a
// `use redis::…` here resolves to the crate. Both are legal and the difference is invisible at the
// call site, so the alias removes the question entirely.
use ::redis as client;
use client::{IntoConnectionInfo, Value};

use super::{
    describe_db_error, read_only_refusal, DbCell, DbColumn, DbColumnInfo, DbConnectionConfig,
    DbDiagramColumn, DbDiagramTable, DbEditResult, DbExecContext, DbExecuteResult, DbKind, DbNode,
    DbNodeKind, DbNodeRef, DbObjectInfo, DbRowEdit, DbRowEditKind, DbSchemaDiagram, DbServerInfo,
    DbSslMode, DbStatementResult, DbTableDataRequest,
};

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
//
// Every one of these exists to bound a sweep. They are the numbers that make "the tree never costs
// an outage" true, and they mirror `mongo.rs`'s `FIELD_SAMPLE` / `DIAGRAM_COLLECTIONS` /
// `DIAGRAM_SAMPLE` in both spirit and honesty: when one is hit, the result says so.

/// `COUNT` hint per `SCAN` iteration. A hint, not a limit — the server may return more or fewer.
const SCAN_COUNT: usize = 500;

/// How many cursor round trips one listing may cost. With `SCAN_COUNT` above this examines roughly
/// 20 000 keys, which is tens of milliseconds on a LAN and bounded on a keyspace of any size.
const SCAN_BUDGET: usize = 40;

/// Namespace nodes returned by one expansion.
const TREE_GROUPS_MAX: usize = 500;

/// Leaf key nodes returned by one expansion.
const TREE_KEYS_MAX: usize = 1000;

/// How much of a string value is read into a cell. A cached HTML page or a serialised blob can be
/// megabytes, and the grid renders text.
const STRING_MAX_BYTES: usize = 1 << 20;

/// Namespaces drawn on a schema diagram, and keys sampled per namespace for its field list.
const DIAGRAM_NAMESPACES: usize = 40;
const DIAGRAM_SAMPLE: usize = 20;

/// Keys sampled to describe a namespace in `schema_objects`.
const OBJECT_SAMPLE: usize = 300;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

pub struct RedisSession {
    /// `Clone` and cheap: every call clones it and issues on the clone. The manager multiplexes
    /// behind the handle, so this is not a pool of one — see the module docs.
    manager: client::aio::ConnectionManager,
    /// The db *index*, as a string — `"0"`, `"3"`.
    ///
    /// A string and not an integer because it has to be the same spelling as `DbNode.database`,
    /// `DbNodeRef.database` and `DbServerInfo.database`, which `scope_to_current_database` compares
    /// exactly. Spelling it `"db0"` here and `"0"` there is a tree whose root never narrows and a
    /// second session opened under a different registry key for the same database.
    database: String,
    user: String,
    version: String,
    read_only: bool,
    /// What splits a key into namespace segments. `:` by convention; a driver option because some
    /// keyspaces use `/` or `.`, and a tree that split on the wrong character would be one flat
    /// list of a million keys.
    separator: String,
    notes: Vec<String>,
    /// `COMMAND INFO` answers, cached per session.
    ///
    /// This is how read-only is enforced: the *server* is asked whether a command writes, rather
    /// than a hand-kept list being consulted. That covers modules, `EVAL_RO`, `GETEX` and every
    /// command added after this code was written — none of which a list here would know about.
    /// One round trip per distinct command name per session.
    flags: Mutex<HashMap<String, CommandFlags>>,
}

/// What the server says about a command. `None` for a command it does not know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CommandFlags {
    write: bool,
    admin: bool,
}

impl RedisSession {
    pub async fn open(config: &DbConnectionConfig, database: Option<&str>) -> Result<Self, String> {
        let mut config = config.clone();
        config.resolve_password();

        let index = database
            .filter(|d| !d.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_database(&config));
        let db: i64 = index
            .parse()
            .map_err(|_| format!("\"{index}\" is not a Redis database number. Redis numbers its databases 0, 1, 2 …"))?;

        let client = build_client(&config, db)?;
        let manager = client::aio::ConnectionManager::new(client)
            .await
            .map_err(|e| describe_db_error(&config, "Connecting", &redis_error(&e)))?;

        let mut session = Self {
            manager,
            database: index,
            user: if config.user.is_empty() { "default".to_string() } else { config.user.clone() },
            version: "Redis".to_string(),
            read_only: config.read_only,
            separator: config.option("namespace_separator").unwrap_or(":").to_string(),
            notes: Vec::new(),
            flags: Mutex::new(HashMap::new()),
        };

        // `ConnectionManager::new` does dial, but a handshake is not a working session: the
        // password may be wrong for the ACL user, or the server may be loading a dump. Asking for
        // `INFO` here is what makes "Test connection" fail on the form rather than on the first
        // query — the same reason Mongo runs `buildInfo` in its `open`.
        let info = session
            .text_command(&["INFO", "server"])
            .await
            .map_err(|e| describe_db_error(&config, "Connecting", &e))?;
        if let Some(version) = info_field(&info, "redis_version") {
            session.version = format!("Redis {version}");
        }
        if let Some(mode) = info_field(&info, "redis_mode") {
            if mode == "cluster" {
                session.notes.push(
                    "This node is part of a cluster. Only the keys in its own slots are listed — \
                     the explorer talks to this node, not to the cluster as a whole."
                        .to_string(),
                );
            }
        }
        if let Ok(replication) = session.text_command(&["INFO", "replication"]).await {
            if info_field(&replication, "role").as_deref() == Some("slave") {
                session.notes.push(
                    "This node is a replica, so the server itself refuses writes — a failed write \
                     here is the server's answer, not this connection's read-only setting."
                        .to_string(),
                );
            }
        }
        Ok(session)
    }

    pub fn info(&self) -> DbServerInfo {
        DbServerInfo {
            kind: DbKind::Redis,
            version: self.version.clone(),
            database: self.database.clone(),
            user: self.user.clone(),
            notes: self.notes.clone(),
        }
    }

    // ------------------------------------------------------------- plumbing

    /// One command, as raw argv. The single place a command reaches the server.
    async fn raw(&self, argv: &[&[u8]]) -> Result<Value, String> {
        let Some((name, args)) = argv.split_first() else {
            return Err("An empty command has nothing to send.".to_string());
        };
        let mut command = client::cmd(&String::from_utf8_lossy(name));
        for arg in args {
            command.arg(*arg);
        }
        let mut connection = self.manager.clone();
        command
            .query_async::<Value>(&mut connection)
            .await
            .map_err(|e| redis_error(&e))
    }

    /// The `&str` spelling of [`Self::raw`], for the many internal commands whose arguments are
    /// known to be text.
    async fn command(&self, argv: &[&str]) -> Result<Value, String> {
        let bytes: Vec<&[u8]> = argv.iter().map(|a| a.as_bytes()).collect();
        self.raw(&bytes).await
    }

    /// A command whose answer is a bulk string, as text. For `INFO` and friends.
    async fn text_command(&self, argv: &[&str]) -> Result<String, String> {
        match self.command(argv).await? {
            Value::BulkString(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            Value::SimpleString(text) => Ok(text),
            Value::VerbatimString { text, .. } => Ok(text),
            other => Ok(scalar_text(&other).unwrap_or_default()),
        }
    }

    async fn int_command(&self, argv: &[&str]) -> Result<i64, String> {
        match self.command(argv).await? {
            Value::Int(n) => Ok(n),
            Value::Nil => Ok(0),
            other => scalar_text(&other)
                .and_then(|t| t.parse().ok())
                .ok_or_else(|| format!("Expected a number from {}.", argv.join(" "))),
        }
    }

    /// Whether the server says this command writes. Cached; falls back to a built-in list when
    /// `COMMAND INFO` is unavailable, which managed Redis and restrictive ACLs both do.
    async fn command_flags(&self, name: &str) -> CommandFlags {
        let key = name.to_ascii_uppercase();
        if let Some(hit) = self.flags.lock().ok().and_then(|map| map.get(&key).copied()) {
            return hit;
        }
        let answered = match self.command(&["COMMAND", "INFO", &key]).await {
            Ok(Value::Array(items)) => items.first().and_then(parse_command_info),
            _ => None,
        };
        let flags = answered.unwrap_or_else(|| CommandFlags {
            write: FALLBACK_WRITES.contains(&key.as_str()),
            admin: FALLBACK_ADMIN.contains(&key.as_str()),
        });
        if let Ok(mut map) = self.flags.lock() {
            map.insert(key, flags);
        }
        flags
    }
}

/// `COMMAND INFO`'s reply row: `[name, arity, [flags…], …]`.
fn parse_command_info(entry: &Value) -> Option<CommandFlags> {
    let Value::Array(fields) = entry else { return None };
    let Some(Value::Array(flags)) = fields.get(2) else { return None };
    let named: HashSet<String> = flags
        .iter()
        .filter_map(scalar_text)
        .map(|f| f.to_ascii_lowercase())
        .collect();
    Some(CommandFlags {
        write: named.contains("write") || named.contains("denyoom"),
        admin: named.contains("admin"),
    })
}

/// Used only when the server will not answer `COMMAND INFO`. Deliberately short: it covers the
/// commands a person actually types, and anything unknown is treated as a write under read-only,
/// which is the safe direction to be wrong in.
const FALLBACK_WRITES: &[&str] = &[
    "SET", "SETEX", "SETNX", "PSETEX", "GETSET", "GETDEL", "GETEX", "APPEND", "SETRANGE", "INCR",
    "DECR", "INCRBY", "DECRBY", "INCRBYFLOAT", "DEL", "UNLINK", "EXPIRE", "PEXPIRE", "EXPIREAT",
    "PEXPIREAT", "PERSIST", "RENAME", "RENAMENX", "MOVE", "COPY", "RESTORE", "MSET", "MSETNX",
    "HSET", "HSETNX", "HDEL", "HINCRBY", "HINCRBYFLOAT", "LPUSH", "RPUSH", "LPUSHX", "RPUSHX",
    "LPOP", "RPOP", "LSET", "LINSERT", "LREM", "LTRIM", "LMOVE", "RPOPLPUSH", "SADD", "SREM",
    "SPOP", "SMOVE", "SINTERSTORE", "SUNIONSTORE", "SDIFFSTORE", "ZADD", "ZREM", "ZINCRBY",
    "ZPOPMIN", "ZPOPMAX", "ZREMRANGEBYRANK", "ZREMRANGEBYSCORE", "ZREMRANGEBYLEX", "XADD", "XDEL",
    "XTRIM", "XSETID", "XGROUP", "XACK", "XCLAIM", "XAUTOCLAIM", "SETBIT", "BITFIELD", "PFADD",
    "PFMERGE", "GEOADD", "EVAL", "EVALSHA", "FCALL", "SCRIPT", "FUNCTION", "JSON.SET", "JSON.DEL",
];

const FALLBACK_ADMIN: &[&str] = &[
    "CONFIG", "ACL", "CLIENT", "CLUSTER", "REPLICAOF", "SLAVEOF", "FAILOVER", "BGSAVE",
    "BGREWRITEAOF", "SAVE", "LASTSAVE", "LATENCY", "SLOWLOG", "MEMORY", "MODULE", "DEBUG",
];

// ---------------------------------------------------------------------------
// Connection plumbing
// ---------------------------------------------------------------------------

fn default_database(config: &DbConnectionConfig) -> String {
    let named = config.database.trim();
    if named.is_empty() {
        "0".to_string()
    } else {
        named.to_string()
    }
}

/// Builds the client, TLS and all.
///
/// The db index goes into the `ConnectionInfo` rather than being reached with a `SELECT`, and that
/// is not a style preference: `ConnectionManager` reconnects transparently, and a `SELECT` sent
/// once would be forgotten by the reconnect, silently re-pointing the session at db0. It is also
/// why `SELECT` is a refused command — see [`refusal_for`].
fn build_client(config: &DbConnectionConfig, db: i64) -> Result<client::Client, String> {
    let base: client::ConnectionInfo = if config.url.trim().is_empty() {
        format!("redis://{}:{}", config.host, config.effective_port())
            .into_connection_info()
            .map_err(|e| redis_error(&e))?
    } else {
        // A pasted `redis://` / `rediss://` URL wins over the fields, the same rule every other
        // driver here follows — that is how these credentials are handed out.
        config
            .url
            .trim()
            .into_connection_info()
            .map_err(|e| format!("This Redis URL could not be read: {}", redis_error(&e)))?
    };

    let mut settings = client::RedisConnectionInfo::default().set_db(db);
    // Only override what the form actually filled in, so a URL carrying its own credentials keeps
    // them.
    if !config.user.is_empty() {
        settings = settings.set_username(&config.user);
    } else if let Some(existing) = base.redis_settings().username() {
        settings = settings.set_username(existing);
    }
    if !config.password.is_empty() {
        settings = settings.set_password(&config.password);
    } else if let Some(existing) = base.redis_settings().password() {
        settings = settings.set_password(existing);
    }
    // RESP3 renders much better in the console — maps stay maps, doubles stay doubles — but it
    // needs Redis 6+ and some proxies refuse `HELLO`. Off unless asked for, by the same option
    // mechanism Mongo's `authSource` uses.
    if config.option("protocol") == Some("3") {
        settings = settings.set_protocol(client::ProtocolVersion::RESP3);
    }

    let (host, port) = match base.addr() {
        client::ConnectionAddr::Tcp(host, port) => (host.clone(), *port),
        client::ConnectionAddr::TcpTls { host, port, .. } => (host.clone(), *port),
        // `ConnectionAddr` is `#[non_exhaustive]`, so this arm also catches whatever the crate
        // adds next. Passing the address through untouched is the right answer for any of them:
        // the credentials and db index above still apply, and only the TLS rewrite below is
        // address-specific.
        other => {
            let path = matches!(other, client::ConnectionAddr::Unix(_));
            // Kept whole: a unix socket has no TLS and no host to verify, so the address passes
            // through untouched and the settings above still apply.
            let _ = path;
            let info = base.clone().set_redis_settings(settings);
            return client::Client::open(info).map_err(|e| redis_error(&e));
        }
    };

    // A `rediss://` URL means TLS whatever the form's dropdown says — the URL is the more specific
    // instruction, and silently downgrading it to plaintext would send the password in the clear.
    let url_is_tls = matches!(base.addr(), client::ConnectionAddr::TcpTls { .. });
    let ssl = if url_is_tls && config.ssl == DbSslMode::Disable {
        DbSslMode::Require
    } else {
        config.ssl
    };

    let info = base.clone().set_redis_settings(settings);
    match ssl {
        DbSslMode::Disable => {
            client::Client::open(info.set_addr(client::ConnectionAddr::Tcp(host, port)))
                .map_err(|e| redis_error(&e))
        }
        DbSslMode::Require | DbSslMode::VerifyFull => {
            let insecure = ssl == DbSslMode::Require;
            let info = info.set_addr(client::ConnectionAddr::TcpTls {
                host,
                port,
                insecure,
                tls_params: None,
            });
            let certificates = tls_certificates(config)?;
            match certificates {
                Some(certificates) => {
                    client::Client::build_with_tls(info, certificates).map_err(|e| redis_error(&e))
                }
                None => client::Client::open(info).map_err(|e| redis_error(&e)),
            }
        }
    }
}

/// Reads the PEM files the connection names, if any.
///
/// Bytes rather than paths: the crate wants the contents, and reading them here means a missing or
/// unreadable file is an error naming *that file* rather than an opaque TLS failure later.
fn tls_certificates(config: &DbConnectionConfig) -> Result<Option<client::TlsCertificates>, String> {
    let read = |path: &str, what: &str| -> Result<Vec<u8>, String> {
        std::fs::read(path).map_err(|e| format!("The {what} at {path} could not be read: {e}"))
    };
    let ca = config.option("sslca").or_else(|| config.option("ssl_ca_file"));
    let cert = config.option("sslcert").or_else(|| config.option("ssl_cert_file"));
    let key = config.option("sslkey").or_else(|| config.option("ssl_key_file"));

    let root_cert = match ca {
        Some(path) => Some(read(path, "certificate authority file")?),
        None => None,
    };
    let client_tls = match (cert, key) {
        (Some(cert), Some(key)) => Some(client::ClientTlsConfig {
            client_cert: read(cert, "client certificate")?,
            client_key: read(key, "client key")?,
        }),
        (Some(_), None) => {
            return Err("A client certificate was given without its key. Both are needed for \
                        mutual TLS."
                .to_string())
        }
        (None, Some(_)) => {
            return Err("A client key was given without its certificate. Both are needed for \
                        mutual TLS."
                .to_string())
        }
        (None, None) => None,
    };
    if root_cert.is_none() && client_tls.is_none() {
        return Ok(None);
    }
    Ok(Some(client::TlsCertificates { client_tls, root_cert }))
}

// ---------------------------------------------------------------------------
// Errors and rendering
// ---------------------------------------------------------------------------

fn redis_error(error: &client::RedisError) -> String {
    let detail = error.detail().unwrap_or("");
    let code = error.code().unwrap_or("");
    if detail.is_empty() {
        error.to_string()
    } else if code.is_empty() {
        detail.to_string()
    } else {
        format!("{code} {detail}")
    }
}

/// A scalar `Value` as the text a person would see in `redis-cli`. `None` for anything with
/// structure, which the callers render themselves.
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::Nil => None,
        Value::Int(n) => Some(n.to_string()),
        Value::Double(d) => Some(format_double(*d)),
        Value::Boolean(b) => Some(if *b { "1".to_string() } else { "0".to_string() }),
        Value::SimpleString(s) => Some(s.clone()),
        Value::Okay => Some("OK".to_string()),
        Value::BulkString(bytes) => Some(bulk_text(bytes).0),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        Value::BigNumber(n) => Some(escape_binary(n)),
        _ => None,
    }
}

/// Redis returns doubles as text and takes them as text; going through `f64` and back must not
/// turn `1` into `1.0`, because that is a different member score to write back.
fn format_double(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// A bulk string as text, plus the type name that says whether the text is the value or a rendering
/// of it.
///
/// **Never `from_utf8_lossy`.** A U+FFFD written into a grid cell and applied back through `SET`
/// destroys the value — this is the one engine where every value is bytes and a lossy decode is a
/// data-loss bug rather than a display glitch. Non-UTF-8 gets `redis-cli`'s escaped form, and the
/// `binary` type name is what tells the editor to refuse it rather than round-trip it.
fn bulk_text(bytes: &[u8]) -> (String, &'static str) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), "string"),
        Err(_) => (escape_binary(bytes), "binary"),
    }
}

/// `redis-cli`'s rendering of a non-UTF-8 value: printable ASCII verbatim, everything else `\xHH`.
fn escape_binary(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for byte in bytes {
        match byte {
            b'\\' => out.push_str("\\\\"),
            b'"' => out.push_str("\\\""),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7e => out.push(*byte as char),
            _ => out.push_str(&format!("\\x{byte:02x}")),
        }
    }
    out
}

/// One field out of an `INFO` reply.
fn info_field(info: &str, field: &str) -> Option<String> {
    info.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.trim() == field)
        .map(|(_, value)| value.trim().to_string())
}

// ---------------------------------------------------------------------------
// Keys and namespaces
// ---------------------------------------------------------------------------

/// One bounded `SCAN` sweep.
struct Sweep {
    keys: Vec<String>,
    /// The sweep ran out of budget before the cursor came back to 0 — there are more keys under
    /// this prefix than were looked at. Every caller must surface this rather than presenting the
    /// result as complete.
    truncated: bool,
    examined: usize,
}

impl RedisSession {
    /// Walks the keyspace under `pattern`, within budget.
    ///
    /// The only enumeration primitive in this module. It stops at whichever comes first: the cursor
    /// returning to 0 (a complete answer), `want` keys collected, or [`SCAN_BUDGET`] round trips —
    /// and records which, so the caller can say so instead of implying it saw everything.
    async fn scan_sweep(&self, pattern: &str, want: usize) -> Result<Sweep, String> {
        let mut cursor = "0".to_string();
        let mut keys = Vec::new();
        let mut examined = 0usize;
        let count = SCAN_COUNT.to_string();

        for _ in 0..SCAN_BUDGET {
            let reply = self
                .command(&["SCAN", &cursor, "MATCH", pattern, "COUNT", &count])
                .await?;
            let Value::Array(parts) = reply else {
                return Err("SCAN answered with something other than a cursor and a list.".to_string());
            };
            let next = parts.first().and_then(scalar_text).unwrap_or_else(|| "0".to_string());
            if let Some(Value::Array(batch)) = parts.get(1) {
                examined += batch.len();
                for entry in batch {
                    if let Some(key) = scalar_text(entry) {
                        keys.push(key);
                    }
                }
            }
            cursor = next;
            if cursor == "0" {
                return Ok(Sweep { keys, truncated: false, examined });
            }
            if keys.len() >= want {
                return Ok(Sweep { keys, truncated: true, examined });
            }
        }
        Ok(Sweep { keys, truncated: true, examined })
    }

    /// The children of a database or a namespace: the next segment down, plus the keys that end
    /// here.
    async fn namespace(&self, node: &DbNodeRef, prefix: &str) -> Result<Vec<DbNode>, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let pattern = format!("{prefix}*");
        let sweep = self.scan_sweep(&pattern, TREE_GROUPS_MAX + TREE_KEYS_MAX).await?;

        // A `BTreeMap` so namespaces come out in a stable order without a sort afterwards, and so
        // "how many keys are under this segment" is counted in the same pass that finds it.
        let mut groups: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        let mut leaves: Vec<String> = Vec::new();
        for key in &sweep.keys {
            let Some(rest) = key.strip_prefix(prefix) else { continue };
            match rest.split_once(self.separator.as_str()) {
                Some((segment, _)) if !segment.is_empty() => {
                    *groups.entry(segment.to_string()).or_insert(0) += 1;
                }
                _ => leaves.push(key.clone()),
            }
        }

        let more_groups = groups.len() > TREE_GROUPS_MAX;
        let more_leaves = leaves.len() > TREE_KEYS_MAX;
        let mut nodes: Vec<DbNode> = Vec::with_capacity(groups.len().min(TREE_GROUPS_MAX) + 1);

        for (segment, count) in groups.into_iter().take(TREE_GROUPS_MAX) {
            let full = format!("{prefix}{segment}");
            nodes.push(DbNode {
                id: format!("ns:{database}:{full}"),
                kind: DbNodeKind::Collection,
                name: segment,
                detail: if sweep.truncated {
                    format!("≥{count} keys")
                } else {
                    format!("{count} keys")
                },
                database: Some(database.clone()),
                // The parent prefix, *without* its trailing separator: `schema` and `name` are what
                // the frontend hands back verbatim, and `full_key` rejoins them with one separator.
                schema: Some(trim_separator(prefix, &self.separator).to_string()),
                table: None,
                has_children: true,
                column: None,
            });
        }

        leaves.sort();
        for key in leaves.into_iter().take(TREE_KEYS_MAX) {
            let name = key.strip_prefix(prefix).unwrap_or(&key).to_string();
            nodes.push(DbNode {
                id: format!("key:{database}:{key}"),
                kind: DbNodeKind::Table,
                name,
                detail: String::new(),
                database: Some(database.clone()),
                schema: Some(trim_separator(prefix, &self.separator).to_string()),
                table: None,
                has_children: true,
                column: None,
            });
        }

        // Mongo's rule: when a budget cut the answer short, say so in the tree rather than letting
        // a partial list read as a complete one. A disabled row, never an error.
        if sweep.truncated || more_groups || more_leaves {
            nodes.push(DbNode {
                id: format!("more:{database}:{prefix}"),
                kind: DbNodeKind::Collection,
                name: format!(
                    "… more than the {} keys that were scanned",
                    sweep.examined
                ),
                detail: "Redis is scanned in bounded steps, never listed whole".to_string(),
                database: Some(database.clone()),
                schema: None,
                table: None,
                has_children: false,
                column: None,
            });
        }
        Ok(nodes)
    }

    /// `db0 … dbN`, from `INFO keyspace` and `CONFIG GET databases`. Both are O(1).
    async fn databases(&self) -> Result<Vec<DbNode>, String> {
        let keyspace = self.text_command(&["INFO", "keyspace"]).await.unwrap_or_default();
        let mut counts: HashMap<i64, String> = HashMap::new();
        for line in keyspace.lines() {
            let Some((name, rest)) = line.split_once(':') else { continue };
            let Some(index) = name.trim().strip_prefix("db").and_then(|n| n.parse::<i64>().ok())
            else {
                continue;
            };
            let keys = rest
                .split(',')
                .filter_map(|part| part.trim().strip_prefix("keys=").map(str::to_string))
                .next()
                .unwrap_or_default();
            counts.insert(index, keys);
        }

        // How many databases the server has. `CONFIG GET` is often disabled on managed Redis, in
        // which case only the databases that already hold keys are listed — plus the one this
        // session is on, which must always be reachable even when it is empty.
        let configured = match self.command(&["CONFIG", "GET", "databases"]).await {
            Ok(Value::Array(pair)) => pair.get(1).and_then(scalar_text).and_then(|n| n.parse::<i64>().ok()),
            Ok(Value::Map(pairs)) => pairs
                .first()
                .and_then(|(_, value)| scalar_text(value))
                .and_then(|n| n.parse::<i64>().ok()),
            _ => None,
        };

        let current: i64 = self.database.parse().unwrap_or(0);
        let mut indexes: Vec<i64> = match configured {
            Some(total) if total > 0 => (0..total).collect(),
            _ => {
                let mut seen: Vec<i64> = counts.keys().copied().collect();
                if !seen.contains(&current) {
                    seen.push(current);
                }
                seen.sort_unstable();
                seen
            }
        };
        indexes.dedup();

        Ok(indexes
            .into_iter()
            .map(|index| {
                let keys = counts.get(&index).cloned().unwrap_or_else(|| "0".to_string());
                DbNode {
                    id: format!("db:{index}"),
                    kind: DbNodeKind::Database,
                    // Displayed as `db0`, addressed as `"0"` — see the `database` field's comment
                    // for why the two must not be the same string.
                    name: format!("db{index}"),
                    detail: format!("{keys} keys"),
                    database: Some(index.to_string()),
                    schema: None,
                    table: None,
                    has_children: true,
                    column: None,
                }
            })
            .collect())
    }

    /// A key's two synthetic folders. No round trip — the folders always exist, and what is in them
    /// is only fetched when one is opened.
    fn key_folders(&self, node: &DbNodeRef) -> Vec<DbNode> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let key = full_key(node, &self.separator);
        [(DbNodeKind::ColumnFolder, "Fields"), (DbNodeKind::IndexFolder, "Details")]
            .into_iter()
            .map(|(kind, name)| DbNode {
                id: format!("folder:{database}:{key}:{name}"),
                kind,
                name: name.to_string(),
                detail: String::new(),
                database: Some(database.clone()),
                schema: node.schema.clone(),
                table: Some(key.clone()),
                has_children: true,
                column: None,
            })
            .collect()
    }

    /// The columns a key's value has, which is decided by its type.
    ///
    /// The `primary_key` flag set here is what makes the grid editable *correctly*: `buildEdits` on
    /// the frontend takes a row's identity from the columns marked with it, and without one it
    /// falls back to matching on every column — which for a hash would put the old value in the
    /// match and silently update nothing after a concurrent write.
    async fn value_fields(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let key = full_key(node, &self.separator);
        let kind = self.key_type(&key).await?;
        let database = node.db().unwrap_or(&self.database).to_string();
        let columns: Vec<(&str, &str, bool)> = match kind.as_str() {
            // (name, type, is-identity)
            "string" => vec![("value", "string", false)],
            "list" => vec![("index", "integer", true), ("value", "string", false)],
            "set" => vec![("member", "string", true)],
            "zset" => vec![("member", "string", true), ("score", "double", false)],
            "hash" => vec![("field", "string", true), ("value", "string", false)],
            "stream" => vec![("id", "stream-id", true)],
            "none" => return Err(format!("The key {key} no longer exists.")),
            _ => vec![("value", "string", false)],
        };
        Ok(columns
            .into_iter()
            .enumerate()
            .map(|(position, (name, data_type, identity))| DbNode {
                id: format!("col:{database}:{key}:{name}"),
                kind: DbNodeKind::Column,
                name: name.to_string(),
                detail: data_type.to_string(),
                database: Some(database.clone()),
                schema: node.schema.clone(),
                table: Some(key.clone()),
                has_children: false,
                column: Some(DbColumnInfo {
                    data_type: data_type.to_string(),
                    nullable: false,
                    primary_key: identity,
                    default_value: None,
                    position: position as i64,
                }),
            })
            .collect())
    }

    /// A key's metadata, as leaf rows under "Details". Five O(1) commands.
    async fn key_details(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        let key = full_key(node, &self.separator);
        let database = node.db().unwrap_or(&self.database).to_string();
        let kind = self.key_type(&key).await?;
        let ttl = self.int_command(&["TTL", &key]).await.unwrap_or(-1);
        let encoding = self
            .text_command(&["OBJECT", "ENCODING", &key])
            .await
            .unwrap_or_default();
        let memory = self.int_command(&["MEMORY", "USAGE", &key]).await.ok();
        let length = self.key_length(&key, &kind).await.ok();

        let mut rows = vec![
            ("Type", kind.clone()),
            (
                "TTL",
                match ttl {
                    -1 => "no expiry".to_string(),
                    -2 => "expired".to_string(),
                    seconds => format!("{seconds}s"),
                },
            ),
        ];
        if !encoding.is_empty() {
            rows.push(("Encoding", encoding));
        }
        if let Some(length) = length {
            rows.push(("Length", length.to_string()));
        }
        if let Some(bytes) = memory {
            rows.push(("Memory", format!("{bytes} bytes")));
        }

        Ok(rows
            .into_iter()
            .map(|(name, detail)| DbNode {
                id: format!("detail:{database}:{key}:{name}"),
                kind: DbNodeKind::Index,
                name: name.to_string(),
                detail,
                database: Some(database.clone()),
                schema: node.schema.clone(),
                table: Some(key.clone()),
                has_children: false,
                column: None,
            })
            .collect())
    }

    async fn key_type(&self, key: &str) -> Result<String, String> {
        Ok(self.text_command(&["TYPE", key]).await?.trim().to_string())
    }

    /// The number of elements in a key. O(1) for every type Redis has — which is what lets
    /// `row_count` be honest on a key and refuse on a namespace.
    async fn key_length(&self, key: &str, kind: &str) -> Result<i64, String> {
        match kind {
            "string" => Ok(1),
            "list" => self.int_command(&["LLEN", key]).await,
            "set" => self.int_command(&["SCARD", key]).await,
            "zset" => self.int_command(&["ZCARD", key]).await,
            "hash" => self.int_command(&["HLEN", key]).await,
            "stream" => self.int_command(&["XLEN", key]).await,
            _ => Ok(1),
        }
    }

    pub async fn children(&self, node: &DbNodeRef) -> Result<Vec<DbNode>, String> {
        match node.kind {
            DbNodeKind::Root => self.databases().await,
            DbNodeKind::Database => self.namespace(node, "").await,
            DbNodeKind::Collection => {
                let prefix = format!("{}{}", full_key(node, &self.separator), self.separator);
                self.namespace(node, &prefix).await
            }
            DbNodeKind::Table => Ok(self.key_folders(node)),
            DbNodeKind::ColumnFolder => self.value_fields(node).await,
            DbNodeKind::IndexFolder => self.key_details(node).await,
            _ => Ok(Vec::new()),
        }
    }
}

/// The full Redis key a node names.
///
/// `DbNodeRef` carries only `{kind, database, schema, name}` and the frontend sends back whatever
/// the driver put there, so a key of any depth travels through a four-field struct with no frontend
/// change at all. What it does *not* carry is which of two shapes `name` is in, and that is the
/// whole of this function:
///
/// * a **namespace or key node** — the rows `namespace` builds — carries only its own last segment
///   in `name`, with the parent prefix in `schema` (`table: None`). `av:v3:dec5_valid` arrives as
///   `schema = "av:v3"`, `name = "dec5_valid"`, and the two are rejoined here.
/// * everything **under** a key — the `Fields` and `Details` folders and the columns inside them —
///   is built with `table: Some(<the whole key>)`, and `refOf` on the frontend deliberately sends
///   `table` as the ref's `name` so a child can name the relation it belongs to. `name` is then
///   already the entire key.
///
/// Rejoining in the second case is what produced *"The key av:v3:av:v3:dec5_valid no longer
/// exists."* the moment anybody expanded **Fields** on a nested key: the prefix was concatenated
/// onto a value that already contained it, and every command underneath — `TYPE`, `TTL`, `OBJECT
/// ENCODING`, `MEMORY USAGE` — then answered honestly about a key nobody has. Hence `none`,
/// `expired` and `0 bytes` in the Details rows beside it: not a stale tree, a fabricated key.
///
/// Keyed on the node's kind rather than on "does `name` already start with `schema`", because that
/// test is a guess: `av:v3:av:v3:x` is a perfectly legal Redis key, and a heuristic that strips it
/// would break the one user who has one. The kind is a fact.
fn full_key(node: &DbNodeRef, separator: &str) -> String {
    let name = node.name.clone().unwrap_or_default();
    match node.kind {
        // Already whole — see above.
        DbNodeKind::ColumnFolder
        | DbNodeKind::IndexFolder
        | DbNodeKind::KeyFolder
        | DbNodeKind::Column
        | DbNodeKind::Index
        | DbNodeKind::Key => name,
        _ => match node.schema() {
            Some(prefix) if !prefix.is_empty() => format!("{prefix}{separator}{name}"),
            _ => name,
        },
    }
}

fn trim_separator<'a>(prefix: &'a str, separator: &str) -> &'a str {
    prefix.strip_suffix(separator).unwrap_or(prefix)
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/// Splits a console buffer into commands: **one per line**.
///
/// Deliberately does *not* call `super::split_statements`, which splits on `;` — a byte that is
/// perfectly legal inside a Redis key or value, so that scanner would cut `SET a "x;y"` in half.
/// Mongo wraps it for the same reason; Redis must not use it at all.
///
/// `#` at the start of a line is a comment. `redis-cli` has no such rule, so this is a deliberate
/// addition: a console you keep a scratch buffer in needs a way to label things, and no Redis
/// command begins with `#`.
fn split_redis_statements(input: &str) -> Vec<String> {
    input
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// Splits one line into arguments, the way `redis-cli`'s own `sdssplitargs` does.
///
/// Hand-written rather than a regex, for the reason `mongo.rs::parse_chain` gives: a regex works on
/// the examples and fails on the value someone actually has. `Vec<u8>` and not `String` because
/// `\xHH` can produce a byte that is not valid UTF-8 and Redis is binary-safe — a key or value the
/// user can store is a key or value they must be able to type.
fn parse_argv(line: &str) -> Result<Vec<Vec<u8>>, String> {
    let bytes = line.as_bytes();
    let mut argv: Vec<Vec<u8>> = Vec::new();
    let mut at = 0usize;

    while at < bytes.len() {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at >= bytes.len() {
            break;
        }
        let mut current: Vec<u8> = Vec::new();
        match bytes[at] {
            b'"' => {
                at += 1;
                loop {
                    if at >= bytes.len() {
                        return Err("This line ends inside an unclosed double quote.".to_string());
                    }
                    match bytes[at] {
                        b'\\' if at + 3 < bytes.len() && bytes[at + 1] == b'x'
                            && bytes[at + 2].is_ascii_hexdigit()
                            && bytes[at + 3].is_ascii_hexdigit() =>
                        {
                            let hex = std::str::from_utf8(&bytes[at + 2..at + 4]).unwrap_or("00");
                            current.push(u8::from_str_radix(hex, 16).unwrap_or(0));
                            at += 4;
                        }
                        b'\\' if at + 1 < bytes.len() => {
                            current.push(match bytes[at + 1] {
                                b'n' => b'\n',
                                b'r' => b'\r',
                                b't' => b'\t',
                                b'b' => 0x08,
                                b'a' => 0x07,
                                other => other,
                            });
                            at += 2;
                        }
                        b'"' => {
                            at += 1;
                            break;
                        }
                        other => {
                            current.push(other);
                            at += 1;
                        }
                    }
                }
            }
            b'\'' => {
                at += 1;
                loop {
                    if at >= bytes.len() {
                        return Err("This line ends inside an unclosed single quote.".to_string());
                    }
                    match bytes[at] {
                        b'\\' if at + 1 < bytes.len() && bytes[at + 1] == b'\'' => {
                            current.push(b'\'');
                            at += 2;
                        }
                        b'\'' => {
                            at += 1;
                            break;
                        }
                        other => {
                            current.push(other);
                            at += 1;
                        }
                    }
                }
            }
            _ => {
                while at < bytes.len() && !bytes[at].is_ascii_whitespace() {
                    current.push(bytes[at]);
                    at += 1;
                }
                argv.push(current);
                continue;
            }
        }
        // A closing quote has to end the argument. `"a"b` is a typo, and guessing at what it meant
        // is how a console writes to the wrong key — redis-cli refuses it too.
        if at < bytes.len() && !bytes[at].is_ascii_whitespace() {
            return Err("There is no space after the closing quote.".to_string());
        }
        argv.push(current);
    }
    Ok(argv)
}

/// Commands refused whatever the connection's settings say.
///
/// Not a permissions check — the connection may well have every right to run these. It is the
/// `unguardedDelete` rule from the SQL side: some things no console typo should be able to do, and
/// each refusal names where to do it deliberately instead.
///
/// The list is short on purpose. Three reasons appear in it and nothing else does: it takes the
/// server down, it blocks the server, or it breaks the *multiplexed connection* every other tab on
/// this session is sharing.
fn refusal_for(argv: &[Vec<u8>]) -> Option<String> {
    let name = argv
        .first()
        .map(|a| String::from_utf8_lossy(a).to_ascii_uppercase())
        .unwrap_or_default();
    let second = argv
        .get(1)
        .map(|a| String::from_utf8_lossy(a).to_ascii_uppercase())
        .unwrap_or_default();

    let blocking_stream = matches!(name.as_str(), "XREAD" | "XREADGROUP")
        && argv
            .iter()
            .any(|a| a.eq_ignore_ascii_case(b"BLOCK"));

    match name.as_str() {
        "FLUSHALL" | "FLUSHDB" | "SWAPDB" => Some(format!(
            "{name} destroys a whole keyspace and Redis has no undo, so this console refuses it. \
             Run it from redis-cli if that is really what you want."
        )),
        "KEYS" => Some(
            "KEYS blocks the entire server — every client — until it has walked every key, so this \
             console refuses it. Use SCAN 0 MATCH pattern COUNT 100 instead, or just expand the \
             tree: the explorer already scans in bounded steps."
                .to_string(),
        ),
        "SELECT" => Some(
            "SELECT would silently re-point every other tab sharing this connection, because the \
             connection is multiplexed. The database is part of the connection — pick another one \
             from the tree instead."
                .to_string(),
        ),
        "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "MONITOR" | "SYNC" | "PSYNC" | "RESET" => {
            Some(format!(
                "{name} puts the connection into a mode it cannot leave, and this connection is \
                 shared with every other tab on it. Use redis-cli for this."
            ))
        }
        "BLPOP" | "BRPOP" | "BLMOVE" | "BRPOPLPUSH" | "BLMPOP" | "BZPOPMIN" | "BZPOPMAX"
        | "BZMPOP" | "WAIT" | "WAITAOF" => Some(format!(
            "{name} blocks until it has something to return, and it would stall every other tab \
             sharing this connection while it waits. Use the non-blocking form, or redis-cli."
        )),
        "MULTI" | "EXEC" | "DISCARD" | "WATCH" => Some(format!(
            "{name} needs a connection of its own — transaction state belongs to one connection, \
             and this one is shared. The data editor uses MULTI/EXEC internally where it needs to."
        )),
        "SHUTDOWN" => Some("SHUTDOWN stops the server. This console refuses it.".to_string()),
        "DEBUG" if second == "SLEEP" => {
            Some("DEBUG SLEEP blocks the server for the duration. This console refuses it.".to_string())
        }
        "CLIENT" if second == "PAUSE" => {
            Some("CLIENT PAUSE stops the server answering anyone. This console refuses it.".to_string())
        }
        _ if blocking_stream => Some(format!(
            "{name} with BLOCK would stall every other tab sharing this connection. Drop the BLOCK \
             argument to read what is already there."
        )),
        _ => None,
    }
}

/// One command rendered as a person would type it into `redis-cli`, quoted where it has to be.
fn render_command(argv: &[Vec<u8>]) -> String {
    argv.iter()
        .map(|arg| {
            let (text, kind) = bulk_text(arg);
            let needs_quotes = kind == "binary"
                || text.is_empty()
                || text.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'');
            if !needs_quotes {
                return text;
            }
            // A binary value is already in `\xHH` form from `bulk_text`. Valid text is quoted as
            // itself with only the characters that would end the argument escaped — running it
            // through `escape_binary` would spell `é` as `\xc3\xa9`, which is a statement the user
            // cannot recognise as the value they typed.
            let inner = if kind == "binary" {
                text
            } else {
                text.chars()
                    .map(|c| match c {
                        '\\' => "\\\\".to_string(),
                        '"' => "\\\"".to_string(),
                        '\n' => "\\n".to_string(),
                        '\r' => "\\r".to_string(),
                        '\t' => "\\t".to_string(),
                        other => other.to_string(),
                    })
                    .collect()
            };
            format!("\"{inner}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Commands whose integer reply is a count of what changed, so the UI can say "3 rows affected"
/// rather than showing a bare number in a grid.
const COUNTING: &[&str] = &[
    "DEL", "UNLINK", "HSET", "HDEL", "SADD", "SREM", "ZADD", "ZREM", "LPUSH", "RPUSH", "LPUSHX",
    "RPUSHX", "LREM", "XDEL", "XTRIM", "SETRANGE", "APPEND", "PFADD", "GEOADD", "EXPIRE",
    "PEXPIRE", "PERSIST", "COPY", "MOVE", "RENAMENX", "SETNX", "HSETNX", "SINTERSTORE",
    "SUNIONSTORE", "SDIFFSTORE",
];

impl RedisSession {
    pub async fn execute(&self, input: &str, ctx: &DbExecContext) -> Result<DbExecuteResult, String> {
        let started = std::time::Instant::now();
        let mut results = Vec::new();

        for line in split_redis_statements(input) {
            let argv = match parse_argv(&line) {
                Ok(argv) if argv.is_empty() => continue,
                Ok(argv) => argv,
                Err(error) => {
                    results.push(DbStatementResult::failed(&line, error));
                    break;
                }
            };
            if let Some(refusal) = refusal_for(&argv) {
                results.push(DbStatementResult::failed(&line, refusal));
                break;
            }
            let name = String::from_utf8_lossy(&argv[0]).to_ascii_uppercase();
            if self.read_only {
                let flags = self.command_flags(&name).await;
                if flags.write || flags.admin {
                    results.push(DbStatementResult::failed(&line, read_only_refusal()));
                    break;
                }
            }

            let at = std::time::Instant::now();
            let borrowed: Vec<&[u8]> = argv.iter().map(|a| a.as_slice()).collect();
            let mut result = match self.raw(&borrowed).await {
                Ok(value) => render_value(&line, &name, value, ctx.max_rows),
                Err(error) => DbStatementResult::failed(&line, error),
            };
            result.duration_ms = at.elapsed().as_millis() as u64;
            let failed = result.error.is_some();
            results.push(result);
            // The same rule every other driver here follows: a failed statement stops the batch,
            // because the ones after it were written expecting this one to have worked.
            if failed {
                break;
            }
        }

        Ok(DbExecuteResult { results, duration_ms: started.elapsed().as_millis() as u64 })
    }

    pub async fn explain(&self, input: &str, _ctx: &DbExecContext) -> Result<String, String> {
        let Some(line) = split_redis_statements(input).into_iter().next() else {
            return Err("There is no command to explain.".to_string());
        };
        let argv = parse_argv(&line)?;
        let Some(first) = argv.first() else {
            return Err("There is no command to explain.".to_string());
        };
        let name = String::from_utf8_lossy(first).to_ascii_uppercase();

        // Redis has no planner, so there is nothing to explain in the SQL sense. What it does have
        // is a self-describing command table, and the Explain button is unconditional in the
        // toolbar — so it answers with the true, useful thing rather than an error.
        let mut out = format!("# {name}\n");
        match self.command(&["COMMAND", "INFO", &name]).await {
            Ok(Value::Array(items)) => match items.first() {
                Some(Value::Array(fields)) => {
                    let arity = fields.get(1).and_then(scalar_text).unwrap_or_default();
                    let flags = match fields.get(2) {
                        Some(Value::Array(list)) => list
                            .iter()
                            .filter_map(scalar_text)
                            .collect::<Vec<_>>()
                            .join(", "),
                        _ => String::new(),
                    };
                    out.push_str(&format!("# arity: {arity}\n# flags: {flags}\n"));
                }
                _ => out.push_str("# The server does not know this command.\n"),
            },
            _ => out.push_str("# COMMAND INFO is not available on this server.\n"),
        }
        if let Ok(docs) = self.text_command(&["COMMAND", "DOCS", &name]).await {
            if !docs.trim().is_empty() {
                out.push_str("\n# COMMAND DOCS\n");
                out.push_str(docs.trim());
                out.push('\n');
            }
        }

        // The first argument of most commands is a key, and what the user usually wants to know is
        // how it is stored and what it costs.
        if let Some(key) = argv.get(1) {
            let key = String::from_utf8_lossy(key).into_owned();
            if let Ok(kind) = self.key_type(&key).await {
                if kind != "none" {
                    out.push_str(&format!("\n# {key}\n# type: {kind}\n"));
                    if let Ok(encoding) = self.text_command(&["OBJECT", "ENCODING", &key]).await {
                        out.push_str(&format!("# encoding: {encoding}\n"));
                    }
                    if let Ok(bytes) = self.int_command(&["MEMORY", "USAGE", &key]).await {
                        out.push_str(&format!("# memory: {bytes} bytes\n"));
                    }
                }
            }
        }
        out.push_str("\n# Redis has no query planner, so there is no plan to show.\n");
        Ok(out)
    }
}

/// Turns one reply into a grid.
fn render_value(statement: &str, name: &str, value: Value, max_rows: u32) -> DbStatementResult {
    let mut result = DbStatementResult::empty(statement);
    match value {
        Value::Nil => {
            result.messages.push("(nil)".to_string());
        }
        Value::ServerError(error) => {
            let detail = error.details().unwrap_or("").to_string();
            result.error = Some(if detail.is_empty() {
                error.code().to_string()
            } else {
                format!("{} {detail}", error.code())
            });
        }
        Value::Int(number) => {
            if COUNTING.contains(&name) {
                result.rows_affected = Some(number);
            }
            result.columns = vec![DbColumn::new("result", "integer")];
            result.rows = vec![vec![Some(number.to_string())]];
        }
        Value::Array(items) | Value::Set(items) => {
            render_list(&mut result, name, items, max_rows);
        }
        Value::Map(pairs) => {
            result.columns =
                vec![DbColumn::new("field", "string"), DbColumn::new("value", "string")];
            result.rows = pairs
                .iter()
                .take(max_rows as usize)
                .map(|(key, value)| {
                    vec![scalar_text(key), scalar_text(value).or_else(|| Some(compact_json(value)))]
                })
                .collect();
            result.truncated = pairs.len() > max_rows as usize;
        }
        scalar => {
            let (text, type_name) = match &scalar {
                Value::BulkString(bytes) => bulk_text(bytes),
                other => (scalar_text(other).unwrap_or_default(), "string"),
            };
            let column = if matches!(scalar, Value::BulkString(_)) { "value" } else { "result" };
            result.columns = vec![DbColumn::new(column, type_name)];
            result.rows = vec![vec![Some(text)]];
        }
    }
    result
}

/// An array reply. Three shapes, distinguished by what is in it.
fn render_list(result: &mut DbStatementResult, name: &str, items: Vec<Value>, max_rows: u32) {
    let limit = max_rows as usize;
    let flat = items.iter().all(|item| scalar_text(item).is_some() || matches!(item, Value::Nil));

    // `HGETALL`, `CONFIG GET` and friends answer with a flat `[k, v, k, v]` on RESP2. Rendering
    // that as a numbered list is technically true and useless; as two columns it is the table the
    // user came for. Keyed on the command name as well as the shape, so a genuine list that
    // happens to have an even number of elements is not folded in half.
    const PAIRED: &[&str] = &[
        "HGETALL", "CONFIG", "XINFO", "CLIENT", "MEMORY", "LATENCY", "HRANDFIELD", "ZPOPMIN",
        "ZPOPMAX",
    ];
    if flat && items.len() % 2 == 0 && !items.is_empty() && PAIRED.contains(&name) {
        result.columns = vec![DbColumn::new("field", "string"), DbColumn::new("value", "string")];
        result.rows = items
            .chunks(2)
            .take(limit)
            .map(|pair| vec![scalar_text(&pair[0]), scalar_text(&pair[1])])
            .collect();
        result.truncated = items.len() / 2 > limit;
        return;
    }

    if flat {
        result.columns = vec![DbColumn::new("#", "integer"), DbColumn::new("value", "string")];
        result.rows = items
            .iter()
            .take(limit)
            .enumerate()
            .map(|(at, item)| vec![Some((at + 1).to_string()), scalar_text(item)])
            .collect();
        result.truncated = items.len() > limit;
        return;
    }

    // Nested. There is no honest flattening, so each element goes through as compact JSON — and
    // into `documents`, which is what gives the console its JSON view. The field is doc-labelled
    // "Mongo only" but the switcher it drives fires on `documents.length > 0` for any engine, so
    // this is the escape hatch working as intended rather than a borrowed one.
    result.columns = vec![DbColumn::new("#", "integer"), DbColumn::new("value", "json")];
    result.rows = items
        .iter()
        .take(limit)
        .enumerate()
        .map(|(at, item)| vec![Some((at + 1).to_string()), Some(compact_json(item))])
        .collect();
    result.documents = items.iter().take(limit).map(compact_json).collect();
    result.truncated = items.len() > limit;
}

/// A reply as JSON text, for the shapes a grid cannot hold.
///
/// Written by hand rather than through `serde_json::Value` for the reason `bson_to_json_text` gives
/// in `mongo.rs`: a `Value`'s object map sorts its keys, and the order Redis answered in is
/// information — `XINFO STREAM` is read top to bottom.
fn compact_json(value: &Value) -> String {
    match value {
        Value::Nil => "null".to_string(),
        Value::Int(n) => n.to_string(),
        Value::Double(d) => format_double(*d),
        Value::Boolean(b) => b.to_string(),
        Value::Okay => "\"OK\"".to_string(),
        Value::SimpleString(s) => json_string(s),
        Value::VerbatimString { text, .. } => json_string(text),
        Value::BulkString(bytes) => json_string(&bulk_text(bytes).0),
        Value::BigNumber(n) => json_string(&escape_binary(n)),
        Value::Array(items) | Value::Set(items) => {
            format!("[{}]", items.iter().map(compact_json).collect::<Vec<_>>().join(","))
        }
        Value::Map(pairs) => format!(
            "{{{}}}",
            pairs
                .iter()
                .map(|(key, value)| format!(
                    "{}:{}",
                    json_string(&scalar_text(key).unwrap_or_default()),
                    compact_json(value)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::ServerError(error) => json_string(error.code()),
        _ => "null".to_string(),
    }
}

fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

impl RedisSession {
    /// Several commands in one round trip. The key browser would otherwise be four round trips per
    /// key, which on a page of a hundred keys over the internet is minutes.
    async fn pipeline(&self, commands: &[Vec<String>]) -> Result<Vec<Value>, String> {
        if commands.is_empty() {
            return Ok(Vec::new());
        }
        let mut pipe = client::pipe();
        for argv in commands {
            let Some((name, args)) = argv.split_first() else { continue };
            let command = pipe.cmd(name);
            for arg in args {
                command.arg(arg.as_bytes());
            }
        }
        let mut connection = self.manager.clone();
        pipe.query_async::<Vec<Value>>(&mut connection)
            .await
            .map_err(|e| redis_error(&e))
    }

    pub async fn table_data(&self, request: &DbTableDataRequest) -> Result<DbStatementResult, String> {
        match request.node.kind {
            DbNodeKind::Table => self.key_data(request).await,
            // A namespace or a whole database: the browser over the keys under it.
            _ => self.key_browser(request).await,
        }
    }

    /// One key's value, as rows shaped by its type.
    async fn key_data(&self, request: &DbTableDataRequest) -> Result<DbStatementResult, String> {
        let key = full_key(&request.node, &self.separator);
        let kind = self.key_type(&key).await?;
        let offset = request.offset as i64;
        let limit = request.limit.max(1) as i64;
        let last = offset + limit - 1;
        let mut result = DbStatementResult::empty(&format!("{} {key}", read_verb(&kind)));

        match kind.as_str() {
            "none" => {
                result.messages.push(format!("The key {key} does not exist."));
            }
            "string" => {
                let length = self.int_command(&["STRLEN", &key]).await.unwrap_or(0);
                let value = if length as usize > STRING_MAX_BYTES {
                    result.truncated = true;
                    result.messages.push(format!(
                        "This value is {length} bytes; the first {STRING_MAX_BYTES} are shown."
                    ));
                    self.command(&["GETRANGE", &key, "0", &(STRING_MAX_BYTES - 1).to_string()])
                        .await?
                } else {
                    self.command(&["GET", &key]).await?
                };
                let (text, type_name) = match &value {
                    Value::BulkString(bytes) => bulk_text(bytes),
                    other => (scalar_text(other).unwrap_or_default(), "string"),
                };
                result.columns = vec![DbColumn::new("value", type_name)];
                result.rows = vec![vec![Some(text)]];
            }
            "list" => {
                result.columns =
                    vec![DbColumn::new("index", "integer"), DbColumn::new("value", "string")];
                let items = self
                    .command(&["LRANGE", &key, &offset.to_string(), &last.to_string()])
                    .await?;
                if let Value::Array(items) = items {
                    result.rows = items
                        .iter()
                        .enumerate()
                        .map(|(at, item)| {
                            vec![Some((offset + at as i64).to_string()), scalar_text(item)]
                        })
                        .collect();
                }
            }
            "hash" | "set" => {
                // `HSCAN`/`SSCAN` are cursor-based and unordered, so an offset has to be reached by
                // sweeping past it. Bounded like every other sweep here, and it says so when the
                // budget ran out rather than presenting a short page as the end of the data.
                let paired = kind == "hash";
                result.columns = if paired {
                    vec![DbColumn::new("field", "string"), DbColumn::new("value", "string")]
                } else {
                    vec![DbColumn::new("member", "string")]
                };
                let (entries, truncated) = self
                    .scan_collection(&key, if paired { "HSCAN" } else { "SSCAN" }, (offset + limit) as usize)
                    .await?;
                let step = if paired { 2 } else { 1 };
                result.rows = entries
                    .chunks(step)
                    .skip(offset as usize)
                    .take(limit as usize)
                    .map(|chunk| chunk.iter().map(|v| Some(v.clone())).collect())
                    .collect();
                result.truncated = truncated;
                if truncated {
                    result.messages.push(
                        "Redis walks a hash or a set with a cursor, so this page was reached by \
                         scanning. There is more here than was scanned."
                            .to_string(),
                    );
                }
            }
            "zset" => {
                result.columns =
                    vec![DbColumn::new("member", "string"), DbColumn::new("score", "double")];
                let reply = self
                    .command(&[
                        "ZRANGE",
                        &key,
                        &offset.to_string(),
                        &last.to_string(),
                        "WITHSCORES",
                    ])
                    .await?;
                if let Value::Array(items) = reply {
                    result.rows = items
                        .chunks(2)
                        .filter(|pair| pair.len() == 2)
                        .map(|pair| vec![scalar_text(&pair[0]), scalar_text(&pair[1])])
                        .collect();
                }
            }
            "stream" => {
                let reply = self
                    .command(&["XRANGE", &key, "-", "+", "COUNT", &(offset + limit).to_string()])
                    .await?;
                fill_from_stream(&mut result, reply, offset as usize, limit as usize);
            }
            other => {
                // A module type (`ReJSON-RL`, `TSDB-TYPE`, …). There is no generic way to read one,
                // and guessing at a module's own commands would be worse than saying so.
                result.columns = vec![DbColumn::new("value", other)];
                result.messages.push(format!(
                    "{key} holds a {other}, which is a module type this grid cannot read. Its own \
                     commands work in the console."
                ));
            }
        }
        Ok(result)
    }

    /// Sweeps `HSCAN`/`SSCAN` until it has `want` entries or runs out of budget.
    async fn scan_collection(
        &self,
        key: &str,
        command: &str,
        want: usize,
    ) -> Result<(Vec<String>, bool), String> {
        let mut cursor = "0".to_string();
        let mut out: Vec<String> = Vec::new();
        let count = SCAN_COUNT.to_string();
        for _ in 0..SCAN_BUDGET {
            let reply = self
                .command(&[command, key, &cursor, "COUNT", &count])
                .await?;
            let Value::Array(parts) = reply else { break };
            cursor = parts.first().and_then(scalar_text).unwrap_or_else(|| "0".to_string());
            if let Some(Value::Array(batch)) = parts.get(1) {
                for entry in batch {
                    out.push(scalar_text(entry).unwrap_or_default());
                }
            }
            if cursor == "0" {
                return Ok((out, false));
            }
            if out.len() >= want {
                return Ok((out, true));
            }
        }
        Ok((out, true))
    }

    /// The keys under a namespace, one row each.
    async fn key_browser(&self, request: &DbTableDataRequest) -> Result<DbStatementResult, String> {
        let prefix = match request.node.kind {
            DbNodeKind::Database | DbNodeKind::Root => String::new(),
            _ => format!("{}{}", full_key(&request.node, &self.separator), self.separator),
        };
        // The filter box is the MATCH glob — which is what a Redis user reaches for anyway, and it
        // costs no new wire field. `*` on both sides so a bare word finds keys containing it.
        let filter = request.filter.trim();
        let pattern = if filter.is_empty() {
            format!("{prefix}*")
        } else if filter.contains('*') || filter.contains('?') || filter.contains('[') {
            format!("{prefix}{filter}")
        } else {
            format!("{prefix}*{filter}*")
        };

        let offset = request.offset as usize;
        let limit = request.limit.max(1) as usize;
        let sweep = self.scan_sweep(&pattern, offset + limit).await?;
        let mut keys = sweep.keys;
        keys.sort();
        let page: Vec<String> = keys.into_iter().skip(offset).take(limit).collect();

        let mut result = DbStatementResult::empty(&format!("SCAN 0 MATCH {pattern} COUNT {SCAN_COUNT}"));
        result.columns = vec![
            DbColumn::new("key", "string"),
            DbColumn::new("type", "string"),
            DbColumn::new("ttl", "integer"),
            DbColumn::new("encoding", "string"),
        ];
        if page.is_empty() {
            result.truncated = sweep.truncated;
            return Ok(result);
        }

        // Three commands per key, in one round trip for the whole page.
        let mut commands: Vec<Vec<String>> = Vec::with_capacity(page.len() * 3);
        for key in &page {
            commands.push(vec!["TYPE".into(), key.clone()]);
            commands.push(vec!["TTL".into(), key.clone()]);
            commands.push(vec!["OBJECT".into(), "ENCODING".into(), key.clone()]);
        }
        let replies = self.pipeline(&commands).await.unwrap_or_default();

        result.rows = page
            .iter()
            .enumerate()
            .map(|(at, key)| {
                let read = |offset: usize| replies.get(at * 3 + offset).and_then(scalar_text);
                vec![
                    Some(key.clone()),
                    read(0),
                    read(1),
                    read(2),
                ]
            })
            .collect();
        result.truncated = sweep.truncated;
        if sweep.truncated {
            result.messages.push(format!(
                "Redis is scanned in bounded steps, never listed whole — {} keys were examined. \
                 Narrow the filter to reach the rest.",
                sweep.examined
            ));
        }
        Ok(result)
    }

    pub async fn row_count(&self, node: &DbNodeRef, _filter: &str) -> Result<i64, String> {
        match node.kind {
            DbNodeKind::Table => {
                let key = full_key(node, &self.separator);
                let kind = self.key_type(&key).await?;
                self.key_length(&key, &kind).await
            }
            DbNodeKind::Database | DbNodeKind::Root => self.int_command(&["DBSIZE"]).await,
            // The honest answer, and the reason the pager simply shows no total here: counting the
            // keys under a prefix means walking the whole keyspace, which is the one thing this
            // module will not do. The frontend swallows this error by design.
            _ => Err(
                "Counting the keys under a namespace would mean scanning the whole keyspace, so \
                 Redis does not offer a total here."
                    .to_string(),
            ),
        }
    }
}

/// The command a page of this type is read with, for the `statement` line the grid shows.
fn read_verb(kind: &str) -> &'static str {
    match kind {
        "list" => "LRANGE",
        "set" => "SSCAN",
        "zset" => "ZRANGE",
        "hash" => "HSCAN",
        "stream" => "XRANGE",
        _ => "GET",
    }
}

/// A stream's entries: `id` plus the union of field names across the page, in first-seen order.
///
/// The same shape `mongo.rs::fill_from_documents` produces for documents, and for the same reason —
/// entries are not rows and the only truthful flattening is "every field anyone had".
fn fill_from_stream(result: &mut DbStatementResult, reply: Value, offset: usize, limit: usize) {
    let Value::Array(entries) = reply else { return };
    let entries: Vec<&Value> = entries.iter().skip(offset).take(limit).collect();

    let mut names: Vec<String> = Vec::new();
    let mut parsed: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for entry in &entries {
        let Value::Array(parts) = entry else { continue };
        let id = parts.first().and_then(scalar_text).unwrap_or_default();
        let mut fields = Vec::new();
        if let Some(Value::Array(flat)) = parts.get(1) {
            for pair in flat.chunks(2) {
                if pair.len() != 2 {
                    continue;
                }
                let name = scalar_text(&pair[0]).unwrap_or_default();
                let value = scalar_text(&pair[1]).unwrap_or_else(|| compact_json(&pair[1]));
                if !names.contains(&name) {
                    names.push(name.clone());
                }
                fields.push((name, value));
            }
        }
        parsed.push((id, fields));
    }

    result.columns = std::iter::once(DbColumn::new("id", "stream-id"))
        .chain(names.iter().map(|name| DbColumn::new(name.clone(), "string")))
        .collect();
    result.rows = parsed
        .iter()
        .map(|(id, fields)| {
            std::iter::once(Some(id.clone()))
                .chain(names.iter().map(|name| {
                    fields.iter().find(|(f, _)| f == name).map(|(_, value)| value.clone())
                }))
                .collect()
        })
        .collect();
    result.documents = parsed
        .iter()
        .map(|(id, fields)| {
            format!(
                "{{{}:{},{}}}",
                json_string("id"),
                json_string(id),
                fields
                    .iter()
                    .map(|(name, value)| format!("{}:{}", json_string(name), json_string(value)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .collect();
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/// The value of one cell in an edit, or `""` when it is absent.
fn cell(cells: &[DbCell], column: &str) -> Option<String> {
    cells
        .iter()
        .find(|c| c.column.eq_ignore_ascii_case(column))
        .and_then(|c| c.value.clone())
}

impl RedisSession {
    /// Applies the grid's staged edits.
    ///
    /// Each edit becomes one or two commands, and the two-command idioms (renaming a hash field,
    /// changing a set member) go through `MULTI`/`EXEC` so the value is never briefly missing —
    /// which is exactly the case the console refuses `MULTI` for: this is the driver, on its own
    /// pipeline, not a shared console line.
    pub async fn apply_edits(
        &self,
        node: &DbNodeRef,
        edits: &[DbRowEdit],
    ) -> Result<DbEditResult, String> {
        if self.read_only {
            return Err(read_only_refusal());
        }
        let mut applied = 0u32;
        let mut statements: Vec<String> = Vec::new();

        for edit in edits {
            let plan = match node.kind {
                DbNodeKind::Table => {
                    let key = full_key(node, &self.separator);
                    let kind = self.key_type(&key).await?;
                    plan_value_edit(&key, &kind, edit)
                }
                _ => plan_key_edit(edit),
            };
            let commands = match plan {
                Ok(commands) => commands,
                Err(error) => {
                    return Ok(DbEditResult { applied, statements, error: Some(error) });
                }
            };

            let atomic = commands.len() > 1;
            for argv in &commands {
                statements.push(render_command(argv));
            }
            let result = if atomic {
                self.atomic(&commands).await
            } else {
                let borrowed: Vec<&[u8]> = commands[0].iter().map(|a| a.as_slice()).collect();
                self.raw(&borrowed).await.map(|_| ())
            };
            match result {
                Ok(()) => applied += 1,
                Err(error) => {
                    return Ok(DbEditResult {
                        applied,
                        statements,
                        error: Some(format!("{error}\n\n{}", render_command(&commands[0]))),
                    });
                }
            }
        }
        Ok(DbEditResult { applied, statements, error: None })
    }

    /// Several commands as one transaction.
    async fn atomic(&self, commands: &[Vec<Vec<u8>>]) -> Result<(), String> {
        let mut pipe = client::pipe();
        pipe.atomic();
        for argv in commands {
            let Some((name, args)) = argv.split_first() else { continue };
            let command = pipe.cmd(&String::from_utf8_lossy(name));
            for arg in args {
                command.arg(arg.as_slice());
            }
        }
        let mut connection = self.manager.clone();
        pipe.query_async::<Vec<Value>>(&mut connection)
            .await
            .map(|_| ())
            .map_err(|e| redis_error(&e))
    }
}

fn bytes(text: &str) -> Vec<u8> {
    text.as_bytes().to_vec()
}

/// An edit to one key's value, by the key's type.
fn plan_value_edit(key: &str, kind: &str, edit: &DbRowEdit) -> Result<Vec<Vec<Vec<u8>>>, String> {
    let k = bytes(key);
    match (kind, edit.kind) {
        // ---- string
        ("string", DbRowEditKind::Update) => {
            let value = cell(&edit.values, "value")
                .ok_or_else(|| "There is no new value to write.".to_string())?;
            // `KEEPTTL` so editing a cached value does not quietly make it permanent.
            Ok(vec![vec![bytes("SET"), k, bytes(&value), bytes("KEEPTTL")]])
        }
        ("string", DbRowEditKind::Insert) => Err(
            "A string key holds exactly one value, so there is no row to add. Change the value \
             instead, or create another key from the console."
                .to_string(),
        ),
        ("string", DbRowEditKind::Delete) => Ok(vec![vec![bytes("DEL"), k]]),

        // ---- list
        ("list", DbRowEditKind::Update) => {
            let index = cell(&edit.keys, "index")
                .ok_or_else(|| "This row has no index to write back to.".to_string())?;
            let value = cell(&edit.values, "value")
                .ok_or_else(|| "There is no new value to write.".to_string())?;
            Ok(vec![vec![bytes("LSET"), k, bytes(&index), bytes(&value)]])
        }
        ("list", DbRowEditKind::Insert) => {
            let value = cell(&edit.values, "value").unwrap_or_default();
            Ok(vec![vec![bytes("RPUSH"), k, bytes(&value)]])
        }
        ("list", DbRowEditKind::Delete) => {
            let index = cell(&edit.keys, "index")
                .ok_or_else(|| "This row has no index to delete.".to_string())?;
            // Redis has no "delete by index". The tombstone idiom is what redis-cli users write:
            // overwrite the slot with a value nothing else can hold, then remove that value. Both
            // in one transaction, so no reader ever sees the tombstone.
            let tombstone = format!("__codeflow_deleted_{}__", uuid::Uuid::new_v4());
            Ok(vec![
                vec![bytes("LSET"), k.clone(), bytes(&index), bytes(&tombstone)],
                vec![bytes("LREM"), k, bytes("1"), bytes(&tombstone)],
            ])
        }

        // ---- set
        ("set", DbRowEditKind::Update) => {
            let old = cell(&edit.keys, "member")
                .ok_or_else(|| "This row has no member to replace.".to_string())?;
            let new = cell(&edit.values, "member")
                .ok_or_else(|| "There is no new member to write.".to_string())?;
            Ok(vec![
                vec![bytes("SREM"), k.clone(), bytes(&old)],
                vec![bytes("SADD"), k, bytes(&new)],
            ])
        }
        ("set", DbRowEditKind::Insert) => {
            let member = cell(&edit.values, "member").unwrap_or_default();
            Ok(vec![vec![bytes("SADD"), k, bytes(&member)]])
        }
        ("set", DbRowEditKind::Delete) => {
            let member = cell(&edit.keys, "member")
                .ok_or_else(|| "This row has no member to delete.".to_string())?;
            Ok(vec![vec![bytes("SREM"), k, bytes(&member)]])
        }

        // ---- zset
        ("zset", DbRowEditKind::Update) => {
            let old = cell(&edit.keys, "member")
                .ok_or_else(|| "This row has no member to write back to.".to_string())?;
            let member = cell(&edit.values, "member").unwrap_or_else(|| old.clone());
            let score = cell(&edit.values, "score")
                .or_else(|| cell(&edit.keys, "score"))
                .unwrap_or_else(|| "0".to_string());
            if member == old {
                // `XX` so an edit cannot silently create a member that a concurrent delete removed.
                Ok(vec![vec![bytes("ZADD"), k, bytes("XX"), bytes("CH"), bytes(&score), bytes(&member)]])
            } else {
                Ok(vec![
                    vec![bytes("ZREM"), k.clone(), bytes(&old)],
                    vec![bytes("ZADD"), k, bytes(&score), bytes(&member)],
                ])
            }
        }
        ("zset", DbRowEditKind::Insert) => {
            let member = cell(&edit.values, "member").unwrap_or_default();
            let score = cell(&edit.values, "score").unwrap_or_else(|| "0".to_string());
            Ok(vec![vec![bytes("ZADD"), k, bytes(&score), bytes(&member)]])
        }
        ("zset", DbRowEditKind::Delete) => {
            let member = cell(&edit.keys, "member")
                .ok_or_else(|| "This row has no member to delete.".to_string())?;
            Ok(vec![vec![bytes("ZREM"), k, bytes(&member)]])
        }

        // ---- hash
        ("hash", DbRowEditKind::Update) => {
            let old = cell(&edit.keys, "field")
                .ok_or_else(|| "This row has no field to write back to.".to_string())?;
            let field = cell(&edit.values, "field").unwrap_or_else(|| old.clone());
            let value = cell(&edit.values, "value")
                .or_else(|| cell(&edit.keys, "value"))
                .unwrap_or_default();
            if field == old {
                Ok(vec![vec![bytes("HSET"), k, bytes(&field), bytes(&value)]])
            } else {
                Ok(vec![
                    vec![bytes("HDEL"), k.clone(), bytes(&old)],
                    vec![bytes("HSET"), k, bytes(&field), bytes(&value)],
                ])
            }
        }
        ("hash", DbRowEditKind::Insert) => {
            let field = cell(&edit.values, "field").unwrap_or_default();
            let value = cell(&edit.values, "value").unwrap_or_default();
            if field.is_empty() {
                return Err("A hash entry needs a field name.".to_string());
            }
            Ok(vec![vec![bytes("HSET"), k, bytes(&field), bytes(&value)]])
        }
        ("hash", DbRowEditKind::Delete) => {
            let field = cell(&edit.keys, "field")
                .ok_or_else(|| "This row has no field to delete.".to_string())?;
            Ok(vec![vec![bytes("HDEL"), k, bytes(&field)]])
        }

        // ---- stream
        ("stream", DbRowEditKind::Update) => Err(
            "A stream is append-only, so an entry cannot be edited in place. Add a new one with \
             XADD from the console, or delete this one."
                .to_string(),
        ),
        ("stream", DbRowEditKind::Insert) => Err(
            "A stream entry has fields this grid cannot name. Add it with XADD from the console."
                .to_string(),
        ),
        ("stream", DbRowEditKind::Delete) => {
            let id = cell(&edit.keys, "id")
                .ok_or_else(|| "This row has no entry id to delete.".to_string())?;
            Ok(vec![vec![bytes("XDEL"), k, bytes(&id)]])
        }

        (other, _) => Err(format!(
            "{key} holds a {other}, which this grid cannot edit. Its own commands work in the \
             console."
        )),
    }
}

/// An edit made in the key browser — the grid over a namespace, where a row is a whole key.
fn plan_key_edit(edit: &DbRowEdit) -> Result<Vec<Vec<Vec<u8>>>, String> {
    let key = cell(&edit.keys, "key")
        .ok_or_else(|| "This row does not name a key.".to_string())?;
    match edit.kind {
        DbRowEditKind::Delete => Ok(vec![vec![bytes("DEL"), bytes(&key)]]),
        DbRowEditKind::Insert => Err(
            "A key comes into being by writing a value into it, so there is no empty row to add. \
             Use SET, HSET or RPUSH in the console."
                .to_string(),
        ),
        DbRowEditKind::Update => {
            if let Some(renamed) = cell(&edit.values, "key") {
                if renamed != key {
                    return Ok(vec![vec![bytes("RENAME"), bytes(&key), bytes(&renamed)]]);
                }
            }
            if let Some(ttl) = cell(&edit.values, "ttl") {
                let seconds: i64 = ttl
                    .trim()
                    .parse()
                    .map_err(|_| format!("\"{ttl}\" is not a number of seconds."))?;
                return Ok(if seconds < 0 {
                    vec![vec![bytes("PERSIST"), bytes(&key)]]
                } else {
                    vec![vec![bytes("EXPIRE"), bytes(&key), bytes(&seconds.to_string())]]
                });
            }
            Err(
                "Only a key's name and its TTL can be edited here. Its type, length and encoding \
                 are what Redis reports, not settings — open the key to change what is in it."
                    .to_string(),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Describing things
// ---------------------------------------------------------------------------

impl RedisSession {
    /// A key has no DDL, so this answers with the nearest true thing: what it is, and the commands
    /// that would recreate it. Same `#`-commented shape Mongo's `object_ddl` uses.
    pub async fn object_ddl(&self, node: &DbNodeRef) -> Result<String, String> {
        let key = full_key(node, &self.separator);
        if key.is_empty() {
            return Err("There is no key here to describe.".to_string());
        }
        let kind = self.key_type(&key).await?;
        if kind == "none" {
            return Err(format!("The key {key} does not exist."));
        }
        let ttl = self.int_command(&["TTL", &key]).await.unwrap_or(-1);
        let encoding = self.text_command(&["OBJECT", "ENCODING", &key]).await.unwrap_or_default();
        let length = self.key_length(&key, &kind).await.unwrap_or(0);
        let memory = self.int_command(&["MEMORY", "USAGE", &key]).await.ok();

        let mut out = format!(
            "# Key\n#   {key}\n#   type: {kind}\n#   length: {length}\n#   encoding: {encoding}\n"
        );
        out.push_str(&match ttl {
            -1 => "#   ttl: none\n".to_string(),
            -2 => "#   ttl: expired\n".to_string(),
            seconds => format!("#   ttl: {seconds}s\n"),
        });
        if let Some(bytes) = memory {
            out.push_str(&format!("#   memory: {bytes} bytes\n"));
        }

        out.push_str("\n# Recreate\n");
        let request = DbTableDataRequest {
            node: node.clone(),
            offset: 0,
            limit: 200,
            sort: Vec::new(),
            filter: String::new(),
            options: Default::default(),
        };
        let page = self.key_data(&request).await?;
        let quoted = |value: &Option<String>| -> String {
            format!("\"{}\"", value.clone().unwrap_or_default().replace('\\', "\\\\").replace('"', "\\\""))
        };
        for row in &page.rows {
            let line = match kind.as_str() {
                "string" => format!("SET {key} {}", quoted(row.first().unwrap_or(&None))),
                "list" => format!("RPUSH {key} {}", quoted(row.get(1).unwrap_or(&None))),
                "set" => format!("SADD {key} {}", quoted(row.first().unwrap_or(&None))),
                "zset" => format!(
                    "ZADD {key} {} {}",
                    row.get(1).cloned().flatten().unwrap_or_default(),
                    quoted(row.first().unwrap_or(&None))
                ),
                "hash" => format!(
                    "HSET {key} {} {}",
                    quoted(row.first().unwrap_or(&None)),
                    quoted(row.get(1).unwrap_or(&None))
                ),
                _ => continue,
            };
            out.push_str(&line);
            out.push('\n');
        }
        if page.truncated || page.rows.len() >= 200 {
            out.push_str("# … only the first 200 entries are shown.\n");
        }
        if ttl > 0 {
            out.push_str(&format!("EXPIRE {key} {ttl}\n"));
        }
        Ok(out)
    }

    /// The namespaces under a database, with what is in them — the `schema_objects` a keyspace can
    /// honestly answer. Bounded by one sweep, like everything else here.
    pub async fn schema_objects(&self, node: &DbNodeRef) -> Result<Vec<DbObjectInfo>, String> {
        let prefix = match node.kind {
            DbNodeKind::Collection => format!("{}{}", full_key(node, &self.separator), self.separator),
            _ => String::new(),
        };
        let sweep = self.scan_sweep(&format!("{prefix}*"), OBJECT_SAMPLE).await?;
        let mut counts: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
        for key in &sweep.keys {
            let Some(rest) = key.strip_prefix(prefix.as_str()) else { continue };
            let segment = rest
                .split_once(self.separator.as_str())
                .map(|(head, _)| head.to_string())
                .unwrap_or_else(|| rest.to_string());
            *counts.entry(segment).or_insert(0) += 1;
        }
        Ok(counts
            .into_iter()
            .map(|(name, rows)| DbObjectInfo {
                name,
                kind: DbNodeKind::Collection,
                object_type: "NAMESPACE".to_string(),
                // Redis records neither, and an invented timestamp is worse than an absent one.
                created_at: None,
                modified_at: None,
                rows: Some(rows),
                total_bytes: None,
                used_bytes: None,
                comment: String::new(),
            })
            .collect())
    }

    /// A diagram of the keyspace's shape — **with no edges, ever**.
    ///
    /// Implemented rather than refused because the right-click that reaches it appears on a `db0`
    /// node exactly as it does on a Mongo database, so an `Err` here would turn an ordinary click
    /// into an error tab.
    ///
    /// Mongo guesses at references (`user_id` → `users`) because that convention is universal in
    /// its ODMs and because a diagram is read, not navigated. Redis's equivalent guess would have
    /// to match on *values* — "this hash field looks like another key's name" — which is precisely
    /// what Mongo's own `infer_references` doc rules out. So: no edges, and the notes say why.
    pub async fn schema_diagram(&self, node: &DbNodeRef) -> Result<DbSchemaDiagram, String> {
        let database = node.db().unwrap_or(&self.database).to_string();
        let sweep = self.scan_sweep("*", TREE_GROUPS_MAX + TREE_KEYS_MAX).await?;

        let mut namespaces: std::collections::BTreeMap<String, Vec<String>> =
            std::collections::BTreeMap::new();
        for key in &sweep.keys {
            let segment = key
                .split_once(self.separator.as_str())
                .map(|(head, _)| head.to_string())
                .unwrap_or_else(|| key.clone());
            namespaces.entry(segment).or_default().push(key.clone());
        }
        let total = namespaces.len();

        let mut tables = Vec::new();
        for (name, keys) in namespaces.into_iter().take(DIAGRAM_NAMESPACES) {
            let mut columns: Vec<DbDiagramColumn> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            for key in keys.iter().take(DIAGRAM_SAMPLE) {
                let kind = self.key_type(key).await.unwrap_or_default();
                if kind == "hash" {
                    if let Ok(Value::Array(fields)) = self.command(&["HKEYS", key]).await {
                        for field in fields.iter().filter_map(scalar_text) {
                            if seen.insert(field.clone()) {
                                columns.push(DbDiagramColumn {
                                    name: field,
                                    data_type: "string".to_string(),
                                    nullable: true,
                                    primary_key: false,
                                    foreign_key: false,
                                });
                            }
                        }
                    }
                } else if seen.insert(kind.clone()) && !kind.is_empty() && kind != "none" {
                    columns.push(DbDiagramColumn {
                        name: format!("({kind})"),
                        data_type: kind,
                        nullable: false,
                        primary_key: false,
                        foreign_key: false,
                    });
                }
            }
            let rows = keys.len() as i64;
            tables.push(DbDiagramTable {
                name,
                schema: None,
                kind: DbNodeKind::Collection,
                columns,
                row_estimate: Some(rows),
            });
        }

        let mut notes = vec![
            "Redis declares no relationships between keys, so no links are drawn. Guessing at one \
             would mean matching on values, which points at the wrong key as often as the right one."
                .to_string(),
            format!(
                "Fields come from a sample of up to {DIAGRAM_SAMPLE} keys per namespace, so a field \
                 that only a few keys carry may be missing."
            ),
        ];
        if total > DIAGRAM_NAMESPACES {
            notes.push(format!("Showing the first {DIAGRAM_NAMESPACES} of {total} namespaces."));
        }
        if sweep.truncated {
            notes.push(format!(
                "The keyspace is scanned in bounded steps, never listed whole — this is built from \
                 the {} keys that were examined.",
                sweep.examined
            ));
        }

        Ok(DbSchemaDiagram {
            database: Some(database),
            schema: None,
            tables,
            edges: Vec::new(),
            notes,
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Everything here is the pure half of the driver: the argv parser, the refusal table, the edit
// planner and the renderers. None of it needs a server, and all of it is where a mistake would be
// silent — a mis-parsed quote writes to the wrong key, a missing refusal blocks the server, a
// wrong identity column updates nothing.

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(line: &str) -> Vec<String> {
        parse_argv(line)
            .unwrap()
            .iter()
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect()
    }

    #[test]
    fn a_plain_line_splits_on_whitespace() {
        assert_eq!(argv("GET  user:42   "), ["GET", "user:42"]);
    }

    #[test]
    fn double_quotes_keep_spaces_and_take_escapes() {
        assert_eq!(argv(r#"SET name "Ana Pérez""#), ["SET", "name", "Ana Pérez"]);
        assert_eq!(argv(r#"SET a "line\nbreak""#), ["SET", "a", "line\nbreak"]);
    }

    #[test]
    fn single_quotes_are_literal_except_for_an_escaped_quote() {
        assert_eq!(argv(r#"SET a 'c:\path\n'"#), ["SET", "a", r"c:\path\n"]);
        assert_eq!(argv(r#"SET a 'it\'s'"#), ["SET", "a", "it's"]);
    }

    /// A `\xHH` escape can produce a byte that is not valid UTF-8, which is exactly why arguments
    /// are bytes all the way to the socket.
    #[test]
    fn hex_escapes_produce_raw_bytes() {
        let parsed = parse_argv(r#"SET k "\xff\x00""#).unwrap();
        assert_eq!(parsed[2], vec![0xff, 0x00]);
    }

    /// redis-cli refuses this too. Guessing at what `"a"b` meant is how a console writes to a key
    /// the user did not name.
    #[test]
    fn a_closing_quote_must_end_the_argument() {
        assert!(parse_argv(r#"SET "a"b c"#).is_err());
        assert!(parse_argv(r#"SET "unclosed"#).is_err());
        assert!(parse_argv("SET 'unclosed").is_err());
    }

    fn node(kind: DbNodeKind, schema: &str, name: &str) -> DbNodeRef {
        DbNodeRef {
            kind,
            database: Some("0".to_string()),
            schema: Some(schema.to_string()),
            name: Some(name.to_string()),
        }
    }

    /// The two shapes a ref's `name` arrives in, and the bug that came of treating them alike.
    ///
    /// A key node carries its last segment and needs the prefix rejoined; everything under it
    /// carries the whole key already, because `refOf` on the frontend sends the relation's name so
    /// a child can say what it belongs to. Rejoining there produced `av:v3:av:v3:dec5_valid`, and
    /// every command on that key then reported it missing.
    #[test]
    fn a_key_is_rejoined_but_its_children_are_not() {
        assert_eq!(full_key(&node(DbNodeKind::Table, "av:v3", "dec5_valid"), ":"), "av:v3:dec5_valid");
        assert_eq!(full_key(&node(DbNodeKind::Collection, "av", "v3"), ":"), "av:v3");

        for kind in [DbNodeKind::ColumnFolder, DbNodeKind::IndexFolder, DbNodeKind::Column] {
            assert_eq!(full_key(&node(kind, "av:v3", "av:v3:dec5_valid"), ":"), "av:v3:dec5_valid");
        }
    }

    /// A top-level key has no prefix to rejoin, and must not gain a leading separator.
    #[test]
    fn a_key_with_no_namespace_is_left_alone() {
        assert_eq!(full_key(&node(DbNodeKind::Table, "", "session"), ":"), "session");
    }

    /// The reason this module does not use `super::split_statements`: `;` is a legal byte in a
    /// Redis key and value, and that scanner would cut this line in half.
    #[test]
    fn statements_split_on_lines_not_on_semicolons() {
        let split = split_redis_statements("SET a \"x;y\"\n# a note\n\nGET a\n");
        assert_eq!(split, ["SET a \"x;y\"", "GET a"]);
    }

    #[test]
    fn the_commands_that_would_take_the_server_down_are_refused() {
        for line in [
            "FLUSHALL",
            "flushdb",
            "KEYS *",
            "SELECT 3",
            "SUBSCRIBE news",
            "MONITOR",
            "BLPOP q 0",
            "MULTI",
            "SHUTDOWN",
            "DEBUG SLEEP 10",
            "CLIENT PAUSE 1000",
            "XREAD BLOCK 0 STREAMS s $",
        ] {
            assert!(
                refusal_for(&parse_argv(line).unwrap()).is_some(),
                "{line} should be refused"
            );
        }
    }

    #[test]
    fn ordinary_commands_are_not_refused() {
        for line in ["GET a", "SCAN 0 MATCH user:* COUNT 100", "HSET h f v", "XREAD STREAMS s 0"] {
            assert!(refusal_for(&parse_argv(line).unwrap()).is_none(), "{line} should be allowed");
        }
    }

    /// A non-UTF-8 value must never reach a grid cell as U+FFFD: the user would edit it and write
    /// the replacement character back over their data.
    #[test]
    fn binary_values_are_escaped_rather_than_lossily_decoded() {
        let (text, kind) = bulk_text(&[0xff, 0x41, 0x00]);
        assert_eq!(kind, "binary");
        assert_eq!(text, r"\xffA\x00");
        assert!(!text.contains('\u{fffd}'));
    }

    #[test]
    fn utf8_values_pass_through_as_themselves() {
        let (text, kind) = bulk_text("Ana Pérez".as_bytes());
        assert_eq!((text.as_str(), kind), ("Ana Pérez", "string"));
    }

    /// Scores round-trip as text. `1` becoming `1.0` is a different value to write back.
    #[test]
    fn whole_doubles_do_not_grow_a_decimal_point() {
        assert_eq!(format_double(1.0), "1");
        assert_eq!(format_double(1.5), "1.5");
    }

    fn key_ref(schema: &str, name: &str) -> DbNodeRef {
        DbNodeRef {
            kind: DbNodeKind::Table,
            database: Some("0".into()),
            schema: if schema.is_empty() { None } else { Some(schema.into()) },
            name: Some(name.into()),
        }
    }

    /// The whole trick that lets a key of any depth travel through a four-field `DbNodeRef`.
    #[test]
    fn a_key_is_rebuilt_from_its_prefix_and_its_last_segment() {
        assert_eq!(full_key(&key_ref("user:42", "profile"), ":"), "user:42:profile");
        assert_eq!(full_key(&key_ref("", "session"), ":"), "session");
    }

    fn edit(kind: DbRowEditKind, values: &[(&str, &str)], keys: &[(&str, &str)]) -> DbRowEdit {
        let cells = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(column, value)| DbCell {
                    column: column.to_string(),
                    value: Some(value.to_string()),
                    type_name: String::new(),
                })
                .collect()
        };
        DbRowEdit { kind, values: cells(values), keys: cells(keys), document: None }
    }

    fn rendered(commands: &[Vec<Vec<u8>>]) -> Vec<String> {
        commands.iter().map(|c| render_command(c)).collect()
    }

    #[test]
    fn a_hash_value_edit_is_one_hset() {
        let plan =
            plan_value_edit("user:42", "hash", &edit(DbRowEditKind::Update, &[("value", "Ana")], &[("field", "name")]))
                .unwrap();
        assert_eq!(rendered(&plan), ["HSET user:42 name Ana"]);
    }

    /// Renaming a field is two commands, and they have to be atomic — otherwise a reader between
    /// them sees the field missing.
    #[test]
    fn renaming_a_hash_field_deletes_and_sets_together() {
        let plan = plan_value_edit(
            "user:42",
            "hash",
            &edit(DbRowEditKind::Update, &[("field", "fullname"), ("value", "Ana")], &[("field", "name")]),
        )
        .unwrap();
        assert_eq!(rendered(&plan), ["HDEL user:42 name", "HSET user:42 fullname Ana"]);
    }

    /// `KEEPTTL` so editing a cached value does not silently make it permanent.
    #[test]
    fn editing_a_string_keeps_its_expiry() {
        let plan =
            plan_value_edit("page", "string", &edit(DbRowEditKind::Update, &[("value", "hi")], &[])).unwrap();
        assert_eq!(rendered(&plan), ["SET page hi KEEPTTL"]);
    }

    /// Redis has no delete-by-index, so this is the tombstone idiom — and it must stay two
    /// commands, which is what makes `apply_edits` run it in a transaction.
    #[test]
    fn deleting_a_list_row_overwrites_then_removes() {
        let plan =
            plan_value_edit("q", "list", &edit(DbRowEditKind::Delete, &[], &[("index", "3")])).unwrap();
        assert_eq!(plan.len(), 2);
        assert!(rendered(&plan)[0].starts_with("LSET q 3 __codeflow_deleted_"));
        assert!(rendered(&plan)[1].starts_with("LREM q 1 __codeflow_deleted_"));
    }

    /// `XX` so an edit cannot resurrect a member a concurrent delete removed.
    #[test]
    fn changing_a_zset_score_will_not_create_the_member() {
        let plan = plan_value_edit(
            "board",
            "zset",
            &edit(DbRowEditKind::Update, &[("score", "10")], &[("member", "ana")]),
        )
        .unwrap();
        assert_eq!(rendered(&plan), ["ZADD board XX CH 10 ana"]);
    }

    #[test]
    fn a_stream_entry_cannot_be_edited_in_place() {
        let refused =
            plan_value_edit("events", "stream", &edit(DbRowEditKind::Update, &[("f", "v")], &[("id", "1-1")]));
        assert!(refused.is_err());
        // …but deleting one is ordinary.
        let plan =
            plan_value_edit("events", "stream", &edit(DbRowEditKind::Delete, &[], &[("id", "1-1")])).unwrap();
        assert_eq!(rendered(&plan), ["XDEL events 1-1"]);
    }

    #[test]
    fn a_string_key_has_no_row_to_add() {
        assert!(plan_value_edit("k", "string", &edit(DbRowEditKind::Insert, &[("value", "x")], &[])).is_err());
    }

    /// In the key browser a row is a whole key, so only its name and its TTL are editable — and
    /// deleting a row deletes the key.
    #[test]
    fn the_key_browser_renames_expires_and_deletes() {
        let renamed =
            plan_key_edit(&edit(DbRowEditKind::Update, &[("key", "b")], &[("key", "a")])).unwrap();
        assert_eq!(rendered(&renamed), ["RENAME a b"]);

        let expires =
            plan_key_edit(&edit(DbRowEditKind::Update, &[("ttl", "60")], &[("key", "a")])).unwrap();
        assert_eq!(rendered(&expires), ["EXPIRE a 60"]);

        let persists =
            plan_key_edit(&edit(DbRowEditKind::Update, &[("ttl", "-1")], &[("key", "a")])).unwrap();
        assert_eq!(rendered(&persists), ["PERSIST a"]);

        let deleted = plan_key_edit(&edit(DbRowEditKind::Delete, &[], &[("key", "a")])).unwrap();
        assert_eq!(rendered(&deleted), ["DEL a"]);

        // The columns Redis reports rather than stores are refused, by name.
        assert!(plan_key_edit(&edit(DbRowEditKind::Update, &[("type", "hash")], &[("key", "a")])).is_err());
    }

    /// A value with a space in it has to come back quoted, or the statement shown to the user is
    /// one they could not paste into redis-cli.
    #[test]
    fn rendered_commands_are_quoted_the_way_redis_cli_would_take_them() {
        let command = vec![bytes("HSET"), bytes("user:42"), bytes("name"), bytes("Ana Pérez")];
        assert_eq!(render_command(&command), "HSET user:42 name \"Ana Pérez\"");
    }

    #[test]
    fn a_flat_pair_reply_becomes_two_columns_only_for_the_commands_that_mean_it() {
        let reply = Value::Array(vec![
            Value::BulkString(b"maxmemory".to_vec()),
            Value::BulkString(b"0".to_vec()),
        ]);
        let paired = render_value("CONFIG GET maxmemory", "CONFIG", reply.clone(), 100);
        assert_eq!(
            paired.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["field", "value"]
        );

        // The same shape from a command that means a list stays a list.
        let listed = render_value("LRANGE q 0 1", "LRANGE", reply, 100);
        assert_eq!(
            listed.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["#", "value"]
        );
        assert_eq!(listed.rows.len(), 2);
    }

    #[test]
    fn a_counting_command_reports_rows_affected() {
        let result = render_value("DEL a b", "DEL", Value::Int(2), 100);
        assert_eq!(result.rows_affected, Some(2));
        // …while a command whose integer is a value, not a count, does not.
        let length = render_value("LLEN q", "LLEN", Value::Int(2), 100);
        assert_eq!(length.rows_affected, None);
    }

    #[test]
    fn a_nil_reply_says_so_rather_than_showing_an_empty_grid() {
        let result = render_value("GET missing", "GET", Value::Nil, 100);
        assert!(result.rows.is_empty());
        assert_eq!(result.messages, ["(nil)"]);
    }

    /// Key order is information — `XINFO STREAM` is read top to bottom — so the JSON writer must
    /// not sort, which is why it is hand-written rather than going through `serde_json::Value`.
    #[test]
    fn compact_json_keeps_the_order_the_server_answered_in() {
        let value = Value::Map(vec![
            (Value::SimpleString("zeta".into()), Value::Int(1)),
            (Value::SimpleString("alpha".into()), Value::Int(2)),
        ]);
        assert_eq!(compact_json(&value), r#"{"zeta":1,"alpha":2}"#);
    }
}
