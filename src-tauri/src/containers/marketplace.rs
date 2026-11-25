//! Contenedores › Catálogo de servicios — the development services a project needs (a database, a
//! broker, an identity provider, a mail catcher), brought up as one Compose project **and wired into
//! the rest of CodeFlow.**
//!
//! A `docker run postgres` is what every tool does, and it leaves the user with the second half of the
//! job: inventing a password, remembering which port it ended up on, typing both into the database
//! client, doing the same for the API client's environment. The catalogue exists for that second half.
//! When the stack is up, the database is already a connection in Base de datos, Keycloak is already an
//! environment (and an OAuth2 preset) in the API client, the consoles are one click away — and every
//! one of those is recorded, so removing the stack can take them back.
//!
//! **Where things live, and why.**
//!
//! - The catalogue is data in this file ([`catalog`]): one entry per service, with its image pinned to
//!   a version (a `latest` that moves under a project is a stack that stops working on a Monday), its
//!   healthcheck, its named volumes and how CodeFlow integrates it. Checked by the tests below, so an
//!   entry cannot name a port its console does not have.
//! - The Compose file is written under the app's state root, one folder per stack ([`stacks_dir`]) — the
//!   stack is the app's, not a project's, and it is not a file anybody commits.
//! - **The passwords are not in it.** Each one is generated here and kept in the Llavero; the file only
//!   names a variable (`${CF_POSTGRES_SECRET:?…}`), and `up` hands the value to Compose in its
//!   environment, read from the Llavero at that moment — the same «la referencia queda en el archivo,
//!   el valor se inyecta al arrancar» the services' `repo_env::inject` follows. Nothing secret is ever
//!   on disk in plain text. Docker Compose reads the files only for `up` and `pull`, so stop, start and
//!   down need no secret; podman-compose and nerdctl read them for everything, so for those the
//!   variable falls back to empty instead of failing (the containers already exist by then).
//! - Ports are published on `127.0.0.1` only: these are development services with development
//!   passwords, and the network the laptop is on is not part of the development environment. A port
//!   already taken — by another program, or by a container the engine already publishes — moves to the
//!   next free one ([`choose_ports`]).
//! - What was provisioned is a row of `container_market_stacks`, machine-local (it names a folder and
//!   an engine of this computer) and therefore never in a backup.
//!
//! The integrations themselves are made by the command layer (`commands::containers_market_cmd`),
//! which can reach the Database, API client and Llavero commands; what they are made *of* — the
//! connection spec, the environment's variables, the collection's auth — is built here, where it can
//! be tested without a window.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::engine::{check_ref, ContainerRow, EngineKind, Target};
use super::{cli, manage};

// ------------------------------------------------------------------------------------ catalogue

/// What CodeFlow does with a service once it is up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationKind {
    /// A connection in Base de datos, its password in the keychain the way that module keeps them.
    Database,
    /// An API client environment, an OAuth2 preset collection, and the admin console.
    Keycloak,
    /// An API client environment pointed at it (WireMock).
    ApiEnvironment,
    /// Its web console, one click away.
    Console,
    /// Nothing beyond the ports and the address to copy.
    None,
}

/// One published port of a service.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortSpec {
    /// How the rest of the entry names it — `{port:<key>}` in a command, a console or a URI.
    pub key: &'static str,
    pub container: u16,
    pub default_host: u16,
    /// What it is for, as the protocol's own name (`PostgreSQL`, `SMTP`, `OTLP gRPC`).
    pub purpose: &'static str,
}

/// Where a variable's value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "from", content = "value")]
pub enum EnvValue {
    Text(&'static str),
    /// The service's generated password, from the Llavero at `up`.
    Secret,
    /// The entry's [`ServiceDef::user`].
    User,
    /// The entry's [`ServiceDef::database`].
    Database,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSpec {
    pub key: &'static str,
    pub value: EnvValue,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSpec {
    /// The volume's suffix: `data` becomes `<service>-data` in the project.
    pub name: &'static str,
    pub target: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSpec {
    pub test: &'static [&'static str],
    pub interval_s: u32,
    pub timeout_s: u32,
    pub retries: u32,
    pub start_period_s: u32,
}

/// One service of the catalogue.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDef {
    /// Also its service name in the Compose file, and the stem of its volumes and secret variable.
    pub id: &'static str,
    pub name: &'static str,
    /// `databases`, `cache`, `identity`, `messaging`, `storage`, `email`, `testing`, `ai`, `observability`.
    pub category: &'static str,
    /// Pinned to a version — never `latest`.
    pub image: &'static str,
    /// For an image built for one architecture only (SQL Server is amd64): emulated elsewhere.
    pub platform: Option<&'static str>,
    pub ports: &'static [PortSpec],
    pub env: &'static [EnvSpec],
    /// The command, when the image's default is not what development wants. May hold `{port:<key>}`.
    pub command: &'static [&'static str],
    pub volumes: &'static [VolumeSpec],
    pub health: HealthSpec,
    /// The web console, as `http://127.0.0.1:{port:<key>}/…`.
    pub console: Option<&'static str>,
    /// How a client reaches it, to copy: a connection URI, a bootstrap address, an endpoint.
    pub address: Option<&'static str>,
    pub integration: IntegrationKind,
    /// The login the service is created with (`app`, `sa`, `admin`), or empty.
    pub user: &'static str,
    /// The database (or realm) it is created with, or empty.
    pub database: &'static str,
    /// Base de datos' engine kind, for [`IntegrationKind::Database`].
    pub db_kind: Option<&'static str>,
}

impl ServiceDef {
    /// Whether it needs a generated password.
    pub fn has_secret(&self) -> bool {
        self.env.iter().any(|e| e.value == EnvValue::Secret)
    }

    pub fn port(&self, key: &str) -> Option<&PortSpec> {
        self.ports.iter().find(|p| p.key == key)
    }
}

const fn port(key: &'static str, container: u16, default_host: u16, purpose: &'static str) -> PortSpec {
    PortSpec { key, container, default_host, purpose }
}

const fn text(key: &'static str, value: &'static str) -> EnvSpec {
    EnvSpec { key, value: EnvValue::Text(value) }
}

const fn from(key: &'static str, value: EnvValue) -> EnvSpec {
    EnvSpec { key, value }
}

const fn volume(name: &'static str, target: &'static str) -> VolumeSpec {
    VolumeSpec { name, target }
}

const fn health(test: &'static [&'static str], start_period_s: u32) -> HealthSpec {
    HealthSpec { test, interval_s: 10, timeout_s: 5, retries: 12, start_period_s }
}

/// A TCP connect from inside the container, for images that carry bash but no HTTP client.
const fn tcp_health(test: &'static [&'static str]) -> HealthSpec {
    health(test, 15)
}

static CATALOG: &[ServiceDef] = &[
    ServiceDef {
        id: "postgres",
        name: "PostgreSQL",
        category: "databases",
        image: "postgres:17.2",
        platform: None,
        ports: &[port("postgres", 5432, 5432, "PostgreSQL")],
        env: &[from("POSTGRES_USER", EnvValue::User), from("POSTGRES_DB", EnvValue::Database), from("POSTGRES_PASSWORD", EnvValue::Secret)],
        command: &[],
        volumes: &[volume("data", "/var/lib/postgresql/data")],
        health: health(&["CMD-SHELL", "pg_isready -U app -d app"], 10),
        console: None,
        address: Some("postgresql://app@127.0.0.1:{port:postgres}/app"),
        integration: IntegrationKind::Database,
        user: "app",
        database: "app",
        db_kind: Some("postgres"),
    },
    ServiceDef {
        id: "mysql",
        name: "MySQL",
        category: "databases",
        image: "mysql:8.4.3",
        platform: None,
        ports: &[port("mysql", 3306, 3306, "MySQL")],
        env: &[
            from("MYSQL_DATABASE", EnvValue::Database),
            from("MYSQL_USER", EnvValue::User),
            from("MYSQL_PASSWORD", EnvValue::Secret),
            from("MYSQL_ROOT_PASSWORD", EnvValue::Secret),
        ],
        command: &[],
        volumes: &[volume("data", "/var/lib/mysql")],
        health: health(&["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p\"$$MYSQL_ROOT_PASSWORD\" --silent"], 20),
        console: None,
        address: Some("mysql://app@127.0.0.1:{port:mysql}/app"),
        integration: IntegrationKind::Database,
        user: "app",
        database: "app",
        db_kind: Some("mysql"),
    },
    ServiceDef {
        id: "sqlserver",
        name: "SQL Server",
        category: "databases",
        image: "mcr.microsoft.com/mssql/server:2022-CU16-ubuntu-22.04",
        // Microsoft publishes it for amd64 only; Apple silicon runs it emulated.
        platform: Some("linux/amd64"),
        ports: &[port("sqlserver", 1433, 1433, "TDS")],
        env: &[text("ACCEPT_EULA", "Y"), text("MSSQL_PID", "Developer"), from("MSSQL_SA_PASSWORD", EnvValue::Secret)],
        command: &[],
        volumes: &[volume("data", "/var/opt/mssql")],
        health: health(&["CMD-SHELL", "/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P \"$$MSSQL_SA_PASSWORD\" -Q \"SELECT 1\" -b -o /dev/null"], 60),
        console: None,
        address: Some("Server=127.0.0.1,{port:sqlserver};User Id=sa;TrustServerCertificate=True"),
        integration: IntegrationKind::Database,
        user: "sa",
        database: "master",
        db_kind: Some("sqlserver"),
    },
    ServiceDef {
        id: "mongodb",
        name: "MongoDB",
        category: "databases",
        image: "mongo:8.0.4",
        platform: None,
        ports: &[port("mongodb", 27017, 27017, "MongoDB")],
        env: &[from("MONGO_INITDB_ROOT_USERNAME", EnvValue::User), from("MONGO_INITDB_ROOT_PASSWORD", EnvValue::Secret)],
        command: &[],
        volumes: &[volume("data", "/data/db")],
        health: health(&["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"], 15),
        console: None,
        address: Some("mongodb://root@127.0.0.1:{port:mongodb}/?authSource=admin"),
        integration: IntegrationKind::Database,
        user: "root",
        database: "admin",
        db_kind: Some("mongodb"),
    },
    ServiceDef {
        id: "valkey",
        name: "Valkey (Redis)",
        category: "cache",
        image: "valkey/valkey:8.0.2",
        platform: None,
        ports: &[port("valkey", 6379, 6379, "RESP")],
        env: &[from("VALKEY_PASSWORD", EnvValue::Secret)],
        command: &["sh", "-c", "exec valkey-server --requirepass \"$$VALKEY_PASSWORD\" --appendonly yes"],
        volumes: &[volume("data", "/data")],
        health: health(&["CMD-SHELL", "valkey-cli -a \"$$VALKEY_PASSWORD\" --no-auth-warning ping | grep -q PONG"], 5),
        console: None,
        address: Some("redis://default@127.0.0.1:{port:valkey}/0"),
        integration: IntegrationKind::Database,
        user: "default",
        database: "0",
        db_kind: Some("redis"),
    },
    ServiceDef {
        id: "keycloak",
        name: "Keycloak",
        category: "identity",
        image: "quay.io/keycloak/keycloak:26.0.7",
        platform: None,
        ports: &[port("http", 8080, 8080, "HTTP")],
        env: &[
            from("KC_BOOTSTRAP_ADMIN_USERNAME", EnvValue::User),
            from("KC_BOOTSTRAP_ADMIN_PASSWORD", EnvValue::Secret),
            text("KC_HEALTH_ENABLED", "true"),
        ],
        command: &["start-dev"],
        volumes: &[volume("data", "/opt/keycloak/data")],
        // No curl in the image; its shell is bash, and bash speaks TCP. Health is on the management
        // port, 9000, which is not published.
        health: health(
            &["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q UP <&3"],
            60,
        ),
        console: Some("http://127.0.0.1:{port:http}/admin/"),
        address: Some("http://127.0.0.1:{port:http}/realms/master"),
        integration: IntegrationKind::Keycloak,
        user: "admin",
        database: "master",
        db_kind: None,
    },
    ServiceDef {
        id: "mailpit",
        name: "Mailpit",
        category: "email",
        image: "axllent/mailpit:v1.21.8",
        platform: None,
        ports: &[port("smtp", 1025, 1025, "SMTP"), port("web", 8025, 8025, "Web UI")],
        env: &[text("MP_DATABASE", "/data/mailpit.db"), text("MP_SMTP_AUTH_ACCEPT_ANY", "1"), text("MP_SMTP_AUTH_ALLOW_INSECURE", "1")],
        command: &[],
        volumes: &[volume("data", "/data")],
        health: health(&["CMD", "/mailpit", "readyz"], 5),
        console: Some("http://127.0.0.1:{port:web}/"),
        address: Some("smtp://127.0.0.1:{port:smtp}"),
        integration: IntegrationKind::Console,
        user: "",
        database: "",
        db_kind: None,
    },
    ServiceDef {
        id: "minio",
        name: "MinIO",
        category: "storage",
        image: "minio/minio:RELEASE.2024-12-18T13-15-44Z",
        platform: None,
        ports: &[port("api", 9000, 9000, "S3 API"), port("console", 9001, 9001, "Console")],
        env: &[from("MINIO_ROOT_USER", EnvValue::User), from("MINIO_ROOT_PASSWORD", EnvValue::Secret)],
        command: &["server", "/data", "--console-address", ":9001"],
        volumes: &[volume("data", "/data")],
        health: health(&["CMD", "mc", "ready", "local"], 10),
        console: Some("http://127.0.0.1:{port:console}/"),
        address: Some("http://127.0.0.1:{port:api}"),
        integration: IntegrationKind::Console,
        user: "codeflow",
        database: "",
        db_kind: None,
    },
    ServiceDef {
        id: "azurite",
        name: "Azurite",
        category: "storage",
        image: "mcr.microsoft.com/azure-storage/azurite:3.33.0",
        platform: None,
        ports: &[port("blob", 10000, 10000, "Blob"), port("queue", 10001, 10001, "Queue"), port("table", 10002, 10002, "Table")],
        env: &[],
        command: &["azurite", "--blobHost", "0.0.0.0", "--queueHost", "0.0.0.0", "--tableHost", "0.0.0.0", "--location", "/data", "--skipApiVersionCheck"],
        volumes: &[volume("data", "/data")],
        health: tcp_health(&["CMD-SHELL", "nc -z 127.0.0.1 10000"]),
        console: None,
        // The emulator's well-known development account: public, the same on every machine.
        address: Some(
            "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:{port:blob}/devstoreaccount1;QueueEndpoint=http://127.0.0.1:{port:queue}/devstoreaccount1;TableEndpoint=http://127.0.0.1:{port:table}/devstoreaccount1;",
        ),
        integration: IntegrationKind::None,
        user: "",
        database: "",
        db_kind: None,
    },
    ServiceDef {
        id: "rabbitmq",
        name: "RabbitMQ",
        category: "messaging",
        image: "rabbitmq:4.0.5-management",
        platform: None,
        ports: &[port("amqp", 5672, 5672, "AMQP"), port("management", 15672, 15672, "Management UI")],
        env: &[from("RABBITMQ_DEFAULT_USER", EnvValue::User), from("RABBITMQ_DEFAULT_PASS", EnvValue::Secret)],
        command: &[],
        volumes: &[volume("data", "/var/lib/rabbitmq")],
        health: health(&["CMD", "rabbitmq-diagnostics", "-q", "ping"], 20),
        console: Some("http://127.0.0.1:{port:management}/"),
        address: Some("amqp://app@127.0.0.1:{port:amqp}/"),
        integration: IntegrationKind::Console,
        user: "app",
        database: "",
        db_kind: None,
    },
    ServiceDef {
        id: "redpanda",
        name: "Redpanda (Kafka API)",
        category: "messaging",
        image: "docker.redpanda.com/redpandadata/redpanda:v24.3.2",
        platform: None,
        ports: &[port("kafka", 19092, 19092, "Kafka API"), port("schema", 18081, 18081, "Schema Registry"), port("admin", 9644, 9644, "Admin API")],
        env: &[],
        // The address it advertises to clients outside the network is this computer's, on the port
        // it was published at — which may not be the default.
        command: &[
            "redpanda",
            "start",
            "--mode",
            "dev-container",
            "--smp",
            "1",
            "--kafka-addr",
            "internal://0.0.0.0:9092,external://0.0.0.0:19092",
            "--advertise-kafka-addr",
            "internal://redpanda:9092,external://127.0.0.1:{port:kafka}",
            "--schema-registry-addr",
            "0.0.0.0:18081",
        ],
        volumes: &[volume("data", "/var/lib/redpanda/data")],
        health: health(&["CMD-SHELL", "rpk cluster health | grep -E 'Healthy:.+true'"], 15),
        console: None,
        address: Some("127.0.0.1:{port:kafka}"),
        integration: IntegrationKind::None,
        user: "",
        database: "",
        db_kind: None,
    },
    ServiceDef {
        id: "wiremock",
        name: "WireMock",
        category: "testing",
        image: "wiremock/wiremock:3.10.0",
        platform: None,
        ports: &[port("http", 8080, 8081, "HTTP")],
        env: &[],
        command: &["--global-response-templating", "--disable-banner"],
        volumes: &[volume("data", "/home/wiremock")],
        health: tcp_health(&["CMD-SHELL", "bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080'"]),
        console: None,
        address: Some("http://127.0.0.1:{port:http}"),
        integration: IntegrationKind::ApiEnvironment,
        user: "",
        database: "",
        db_kind: None,
    },
    ServiceDef {
        id: "qdrant",
        name: "Qdrant",
        category: "ai",
        image: "qdrant/qdrant:v1.12.5",
        platform: None,
        ports: &[port("http", 6333, 6333, "HTTP"), port("grpc", 6334, 6334, "gRPC")],
        env: &[],
        command: &[],
        volumes: &[volume("data", "/qdrant/storage")],
        health: tcp_health(&["CMD-SHELL", "bash -c 'exec 3<>/dev/tcp/127.0.0.1/6333'"]),
        console: Some("http://127.0.0.1:{port:http}/dashboard"),
        address: Some("http://127.0.0.1:{port:http}"),
        integration: IntegrationKind::Console,
        user: "",
        database: "",
        db_kind: None,
    },
    ServiceDef {
        id: "jaeger",
        name: "Jaeger",
        category: "observability",
        image: "jaegertracing/all-in-one:1.64.0",
        platform: None,
        ports: &[port("ui", 16686, 16686, "Web UI"), port("otlpGrpc", 4317, 4317, "OTLP gRPC"), port("otlpHttp", 4318, 4318, "OTLP HTTP")],
        env: &[text("COLLECTOR_OTLP_ENABLED", "true")],
        command: &[],
        volumes: &[],
        health: health(&["CMD-SHELL", "wget -q --spider http://127.0.0.1:14269/"], 5),
        console: Some("http://127.0.0.1:{port:ui}/"),
        address: Some("http://127.0.0.1:{port:otlpHttp}"),
        integration: IntegrationKind::Console,
        user: "",
        database: "",
        db_kind: None,
    },
    ServiceDef {
        id: "lgtm",
        name: "Grafana LGTM (OpenTelemetry)",
        category: "observability",
        image: "grafana/otel-lgtm:0.8.1",
        platform: None,
        ports: &[port("grafana", 3000, 3000, "Grafana"), port("otlpGrpc", 4317, 4317, "OTLP gRPC"), port("otlpHttp", 4318, 4318, "OTLP HTTP")],
        env: &[],
        command: &[],
        volumes: &[volume("data", "/data")],
        health: health(&["CMD-SHELL", "curl -fs http://127.0.0.1:3000/api/health"], 30),
        console: Some("http://127.0.0.1:{port:grafana}/"),
        address: Some("http://127.0.0.1:{port:otlpHttp}"),
        integration: IntegrationKind::Console,
        user: "",
        database: "",
        db_kind: None,
    },
];

pub fn catalog() -> &'static [ServiceDef] {
    CATALOG
}

pub fn find(id: &str) -> Option<&'static ServiceDef> {
    CATALOG.iter().find(|s| s.id == id)
}

/// Every `{port:<key>}` a template names.
fn port_refs(template: &str) -> Vec<&str> {
    template.split("{port:").skip(1).filter_map(|rest| rest.split('}').next()).collect()
}

/// What the tests hold every entry to: a pinned image, a healthcheck, ports that are unique and that
/// every template names correctly. Its own function so a new entry can be checked the same way.
pub fn validate(def: &ServiceDef) -> Result<(), String> {
    let fail = |why: &str| Err(format!("{}: {why}", def.id));
    let tag = def.image.rsplit('/').next().and_then(|last| last.split_once(':')).map(|(_, tag)| tag).unwrap_or_default();
    if tag.is_empty() || tag == "latest" {
        return fail("the image is not pinned to a version");
    }
    if !def.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
        return fail("the id is not lower-case letters and digits");
    }
    if def.health.test.len() < 2 || !matches!(def.health.test[0], "CMD" | "CMD-SHELL") {
        return fail("no healthcheck");
    }
    let mut keys = BTreeSet::new();
    let mut containers = BTreeSet::new();
    for p in def.ports {
        if !keys.insert(p.key) || !containers.insert(p.container) {
            return fail("a port is listed twice");
        }
        if p.default_host == 0 || p.container == 0 {
            return fail("a port is zero");
        }
    }
    let templates = def.command.iter().copied().chain(def.console).chain(def.address);
    for template in templates {
        for key in port_refs(template) {
            if def.port(key).is_none() {
                return fail(&format!("{template} names a port it does not have ({key})"));
            }
        }
    }
    if def.integration == IntegrationKind::Database && def.db_kind.is_none() {
        return fail("a database integration without its engine");
    }
    if matches!(def.integration, IntegrationKind::Console | IntegrationKind::Keycloak) && def.console.is_none() {
        return fail("a console integration without a console");
    }
    if def.env.iter().any(|e| e.value == EnvValue::User) && def.user.is_empty() {
        return fail("a user variable without a user");
    }
    Ok(())
}

// ------------------------------------------------------------------------------------- stacks

/// One published port of a provisioned service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackPort {
    pub key: String,
    pub purpose: String,
    pub container: u16,
    pub host: u16,
}

/// One service of a provisioned stack, as it was planned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackService {
    /// The catalogue entry, which is also its Compose service name.
    pub id: String,
    pub ports: Vec<StackPort>,
    /// The Llavero entry holding its password, when it has one.
    #[serde(default)]
    pub secret_item: Option<String>,
}

impl StackService {
    pub fn host_port(&self, key: &str) -> Option<u16> {
        self.ports.iter().find(|p| p.key == key).map(|p| p.host)
    }
}

/// Something CodeFlow made for a stack, outside the engine — kept so removal can undo exactly that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    /// `dbConnection`, `apiEnvironment`, `apiCollection`, `vaultItem`.
    pub kind: String,
    pub id: String,
    pub label: String,
    /// The service it belongs to.
    pub service: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackRow {
    pub id: String,
    /// The Compose project name.
    pub name: String,
    pub runtime: String,
    pub context: Option<String>,
    /// The workspace its connections and environments were filed under.
    pub workspace_id: String,
    pub dir: String,
    pub services: Vec<StackService>,
    pub integrations: Vec<Created>,
    pub created_at: String,
    pub last_error: String,
}

impl StackRow {
    pub fn compose_file(&self) -> PathBuf {
        Path::new(&self.dir).join(COMPOSE_FILE)
    }

    pub fn target(&self) -> Target {
        Target { runtime: self.runtime.clone(), context: self.context.clone() }
    }

    /// The options `engine::act` takes for this project's files.
    pub fn compose_options(&self) -> Value {
        json!({ "projectDir": self.dir, "configFiles": self.compose_file().to_string_lossy() })
    }
}

pub const COMPOSE_FILE: &str = "compose.yaml";

/// Where the stacks' Compose files are: one folder per stack under the state root.
pub fn stacks_dir() -> PathBuf {
    crate::paths::state_dir().join("service-stacks")
}

/// A stack name is its Compose project name: what Compose itself accepts (lower-case letters, digits,
/// `-` and `_`, a letter or digit first), and never a flag.
pub fn check_stack_name(name: &str) -> Result<(), String> {
    check_ref(name)?;
    manage::check_name(name, "stack")?;
    let valid = name.len() <= 63
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'));
    if valid {
        Ok(())
    } else {
        Err(format!("\"{name}\" is not a stack name: lower-case letters, digits, - and _, a letter or digit first"))
    }
}

// ------------------------------------------------------------------------------------- ports

/// One port to place: where it would like to be, and whether the user typed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortWish {
    pub preferred: u16,
    /// Typed by the user: taken or not, it is not moved — the user is told instead.
    pub explicit: bool,
}

/// How far past its default a port is looked for before giving up.
const PORT_SEARCH: u16 = 400;

/// Host ports for `wishes`, in order. Explicit ones are kept as they are (and refused when taken or
/// asked twice); the rest go to their default, or the next port up that is free and not already
/// handed out in this plan. `is_free` is the probe — a bind on this computer, plus what the engine
/// already publishes.
pub fn choose_ports(wishes: &[PortWish], is_free: &dyn Fn(u16) -> bool) -> Result<Vec<u16>, String> {
    let mut used: BTreeSet<u16> = BTreeSet::new();
    let mut out: Vec<Option<u16>> = vec![None; wishes.len()];
    for (i, wish) in wishes.iter().enumerate().filter(|(_, w)| w.explicit) {
        if wish.preferred == 0 {
            return Err("port 0 cannot be published".into());
        }
        if !used.insert(wish.preferred) {
            return Err(format!("port {} is asked for twice", wish.preferred));
        }
        if !is_free(wish.preferred) {
            return Err(format!("port {} is already in use on this computer", wish.preferred));
        }
        out[i] = Some(wish.preferred);
    }
    for (i, wish) in wishes.iter().enumerate().filter(|(_, w)| !w.explicit) {
        let start = wish.preferred.max(1024);
        let found = (0..=PORT_SEARCH).filter_map(|offset| start.checked_add(offset)).find(|candidate| !used.contains(candidate) && is_free(*candidate));
        let Some(port) = found else {
            return Err(format!("no free port near {}", wish.preferred));
        };
        used.insert(port);
        out[i] = Some(port);
    }
    Ok(out.into_iter().map(|p| p.unwrap_or_default()).collect())
}

/// Whether nothing on this computer listens on `127.0.0.1:port` — the address the stack publishes on.
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The host ports an engine's containers already publish: on macOS the engine's VM holds those, and
/// a bind on this computer can miss one held by a stopped-but-defined container, which would collide
/// the moment it starts.
pub fn published_ports(rows: &[ContainerRow]) -> BTreeSet<u16> {
    rows.iter().flat_map(|r| r.ports.iter().filter_map(|p| p.host_port)).collect()
}

/// The services of a plan in catalogue order, each with its ports chosen. `overrides` are the ports
/// the user typed, by service and port key.
pub fn plan_ports(services: &[&ServiceDef], overrides: &BTreeMap<String, BTreeMap<String, u16>>, is_free: &dyn Fn(u16) -> bool) -> Result<Vec<StackService>, String> {
    let mut wishes = Vec::new();
    for def in services {
        for p in def.ports {
            let typed = overrides.get(def.id).and_then(|m| m.get(p.key)).copied();
            wishes.push(PortWish { preferred: typed.unwrap_or(p.default_host), explicit: typed.is_some() });
        }
    }
    let chosen = choose_ports(&wishes, is_free)?;
    let mut chosen = chosen.into_iter();
    Ok(services
        .iter()
        .map(|def| StackService {
            id: def.id.to_string(),
            ports: def
                .ports
                .iter()
                .map(|p| StackPort { key: p.key.into(), purpose: p.purpose.into(), container: p.container, host: chosen.next().unwrap_or(p.default_host) })
                .collect(),
            secret_item: None,
        })
        .collect())
}

// ----------------------------------------------------------------------------------- compose

/// The variable a service's password reaches Compose in.
pub fn secret_var(service: &str) -> String {
    format!("CF_{}_SECRET", service.to_ascii_uppercase().replace('-', "_"))
}

/// `{port:<key>}` replaced by the host port the service got.
pub fn fill(template: &str, service: &StackService) -> String {
    let mut out = template.to_string();
    for p in &service.ports {
        out = out.replace(&format!("{{port:{}}}", p.key), &p.host.to_string());
    }
    out
}

/// A YAML scalar: JSON's double-quoted string is valid YAML and escapes everything that needs it.
fn q(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// The reference a password is written as. Docker Compose reads the file only for `up` and `pull`,
/// where CodeFlow always passes the value — a `up` from somewhere else fails with the reason instead
/// of creating the service with an empty password. podman-compose and nerdctl read it for every
/// command, stop included, so for them it falls back to empty.
fn secret_ref(service: &str, engine: EngineKind) -> String {
    let var = secret_var(service);
    if engine == EngineKind::Docker {
        format!("${{{var}:?bring this stack up from CodeFlow, which reads its password from the Llavero}}")
    } else {
        format!("${{{var}:-}}")
    }
}

/// The Compose file of a stack. No secret is in it — see the module's notes.
pub fn compose_yaml(stack: &str, stack_id: &str, services: &[StackService], engine: EngineKind) -> Result<String, String> {
    check_stack_name(stack)?;
    let mut out = String::new();
    out.push_str("# Written by CodeFlow (Contenedores › Catálogo de servicios). Edits are kept until the stack is removed.\n");
    out.push_str("# Passwords are not in this file: they are in CodeFlow's Llavero and reach Compose as variables at `up`.\n");
    out.push_str(&format!("name: {}\nservices:\n", q(stack)));
    let mut volumes: Vec<String> = Vec::new();
    for service in services {
        let def = find(&service.id).ok_or_else(|| format!("{} is not in the catalogue", service.id))?;
        out.push_str(&format!("  {}:\n", def.id));
        out.push_str(&format!("    image: {}\n", q(def.image)));
        if let Some(platform) = def.platform {
            out.push_str(&format!("    platform: {}\n", q(platform)));
        }
        out.push_str("    restart: \"unless-stopped\"\n");
        if !def.command.is_empty() {
            let words: Vec<String> = def.command.iter().map(|w| q(&fill(w, service))).collect();
            out.push_str(&format!("    command: [{}]\n", words.join(", ")));
        }
        if !def.env.is_empty() {
            out.push_str("    environment:\n");
            for e in def.env {
                let value = match e.value {
                    EnvValue::Text(v) => v.to_string(),
                    EnvValue::Secret => secret_ref(def.id, engine),
                    EnvValue::User => def.user.to_string(),
                    EnvValue::Database => def.database.to_string(),
                };
                out.push_str(&format!("      {}: {}\n", e.key, q(&value)));
            }
        }
        out.push_str("    ports:\n");
        for p in &service.ports {
            out.push_str(&format!("      - {}\n", q(&format!("127.0.0.1:{}:{}", p.host, p.container))));
        }
        if !def.volumes.is_empty() {
            out.push_str("    volumes:\n");
            for v in def.volumes {
                let name = format!("{}-{}", def.id, v.name);
                out.push_str(&format!("      - {}\n", q(&format!("{name}:{}", v.target))));
                volumes.push(name);
            }
        }
        let h = def.health;
        let test: Vec<String> = h.test.iter().map(|w| q(w)).collect();
        out.push_str("    healthcheck:\n");
        out.push_str(&format!("      test: [{}]\n", test.join(", ")));
        out.push_str(&format!("      interval: {}s\n      timeout: {}s\n      retries: {}\n      start_period: {}s\n", h.interval_s, h.timeout_s, h.retries, h.start_period_s));
        out.push_str("    labels:\n");
        out.push_str(&format!("      dev.codeflow.stack: {}\n", q(stack_id)));
        out.push_str(&format!("      dev.codeflow.service: {}\n", q(def.id)));
    }
    if !volumes.is_empty() {
        out.push_str("volumes:\n");
        for name in volumes {
            out.push_str(&format!("  {name}: {{}}\n"));
        }
    }
    Ok(out)
}

/// Writes the Compose file, creating the stack's folder.
pub fn write_compose(dir: &Path, yaml: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let file = dir.join(COMPOSE_FILE);
    std::fs::write(&file, yaml).map_err(|e| format!("could not write {}: {e}", file.display()))?;
    Ok(file)
}

/// A password every service here accepts: 24 letters and digits, with an upper-case letter, a
/// lower-case one and a digit (SQL Server's policy asks for three classes of four). No symbol, so it
/// survives a URI, a shell healthcheck and a `.env` unquoted.
pub fn generate_secret() -> String {
    use rand::Rng;
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut rng = rand::rng();
    loop {
        let value: String = (0..24).map(|_| CHARSET[rng.random_range(0..CHARSET.len())] as char).collect();
        if value.chars().any(|c| c.is_ascii_uppercase()) && value.chars().any(|c| c.is_ascii_lowercase()) && value.chars().any(|c| c.is_ascii_digit()) {
            return value;
        }
    }
}

// --------------------------------------------------------------------------------- the engine

/// How `up` waits for the healthchecks, so the integrations that follow find the services answering:
/// `--wait` where the engine's Compose has it (Docker Compose 2.1+), with `--wait-timeout` where that
/// exists too (2.17+); podman-compose and nerdctl compose have neither and return once started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpWait {
    No,
    Wait,
    WaitWithTimeout,
}

/// How long `--wait` gives the healthchecks: a first pull of a 1 GB image included.
pub const UP_WAIT_SECONDS: u32 = 600;

/// What `compose up --help` says it takes. No answer (the probe failed): Docker's Compose has had
/// `--wait` for years, so it keeps it; the others go without.
pub fn up_wait_from_help(engine: EngineKind, help: Option<&str>) -> UpWait {
    let Some(text) = help else {
        return if engine == EngineKind::Docker { UpWait::WaitWithTimeout } else { UpWait::No };
    };
    let flags: BTreeSet<&str> = text.split(|c: char| c.is_whitespace() || matches!(c, ',' | '=' | '[' | ']' | '|')).collect();
    match (flags.contains("--wait"), flags.contains("--wait-timeout")) {
        (true, true) => UpWait::WaitWithTimeout,
        (true, false) => UpWait::Wait,
        _ => UpWait::No,
    }
}

/// Asks the engine's Compose which `--wait` it has, once per bring-up — a few hundred milliseconds
/// against minutes of pulling.
pub async fn probe_up_wait(target: &Target) -> UpWait {
    let Ok(engine) = target.engine() else { return UpWait::No };
    let mut args = target.global_args();
    args.extend(["compose".into(), "up".into(), "--help".into()]);
    match cli::run(&engine.program(), &args, None, std::time::Duration::from_secs(15)).await {
        Ok(out) if out.ok() => up_wait_from_help(engine, Some(&format!("{}\n{}", out.stdout, out.stderr))),
        // Some Compose builds print their help to stderr and exit non-zero; what they print still says.
        Ok(out) if out.stdout.contains("--") || out.stderr.contains("--") => up_wait_from_help(engine, Some(&format!("{}\n{}", out.stdout, out.stderr))),
        _ => up_wait_from_help(engine, None),
    }
}

/// `compose … up -d [--wait [--wait-timeout 600]]` for a stack. Its passwords are not here: they
/// reach Compose in the process's environment ([`up_env`]).
pub fn up_args(engine: EngineKind, row: &StackRow, wait: UpWait) -> Vec<String> {
    let mut args = vec!["compose".to_string(), "-p".into(), row.name.clone()];
    if engine != EngineKind::Podman {
        args.extend(["--project-directory".into(), row.dir.clone()]);
    }
    args.extend(["-f".into(), row.compose_file().to_string_lossy().into_owned(), "up".into(), "-d".into()]);
    match wait {
        UpWait::No => {}
        UpWait::Wait => args.push("--wait".into()),
        UpWait::WaitWithTimeout => args.extend(["--wait".into(), "--wait-timeout".into(), UP_WAIT_SECONDS.to_string()]),
    }
    args
}

/// The program and arguments of a stack's `up` job: the engine's global flags (its context), then
/// [`up_args`].
pub fn up_command(row: &StackRow, wait: UpWait) -> Result<(String, Vec<String>), String> {
    check_stack_name(&row.name)?;
    let target = row.target();
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return Err("ctr has no Compose — install nerdctl for it".into());
    }
    let mut args = target.global_args();
    args.extend(up_args(engine, row, wait));
    Ok((engine.program(), args))
}

/// The variables a stack's passwords reach Compose in, by service — for the `up` process alone.
pub fn up_env(passwords: &BTreeMap<String, String>) -> Vec<(String, String)> {
    passwords.iter().map(|(service, value)| (secret_var(service), value.clone())).collect()
}

/// What a stack whose `up` job was closed before it ended keeps as its error. The page says it in
/// the user's language; anything else in `last_error` is shown as it is.
pub const UP_CANCELLED: &str = "cancelled";

/// The most of an `up` job's output kept in memory for its error: its last lines are what say why.
pub const UP_OUTPUT_KEPT: usize = 16 * 1024;

/// Keeps the end of a job's output, at most [`UP_OUTPUT_KEPT`] bytes, cut on a character boundary.
pub fn keep_output_tail(buffer: &mut String, chunk: &str) {
    buffer.push_str(chunk);
    if buffer.len() > UP_OUTPUT_KEPT {
        let mut cut = buffer.len() - UP_OUTPUT_KEPT;
        while !buffer.is_char_boundary(cut) {
            cut += 1;
        }
        buffer.drain(..cut);
    }
}

/// The error a failed `up` leaves on its stack: the exit code and the last lines Compose printed —
/// without its terminal redraws, each line once, and never a password (Compose prints none, and a
/// value is masked here should a service's own output ever echo one).
pub fn up_failure(code: i32, output: &str, secrets: &[&str]) -> String {
    let plain = crate::services::log::strip_ansi(output);
    let mut lines: Vec<&str> = Vec::new();
    for line in plain.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if lines.last() != Some(&line) {
            lines.push(line);
        }
    }
    let tail = lines[lines.len().saturating_sub(8)..].join("\n");
    let mut out = format!("compose up ended with exit code {code}");
    if !tail.is_empty() {
        out.push('\n');
        out.push_str(&tail);
    }
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        out = out.replace(secret, "••••");
    }
    out
}

/// The live state of one service: its container's state and health, or `missing`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceState {
    pub state: String,
    pub health: String,
    pub container: String,
}

/// What the engine says about a stack's services, from its project label.
pub fn states_of(row: &StackRow, containers: &[ContainerRow]) -> BTreeMap<String, ServiceState> {
    row.services
        .iter()
        .map(|service| {
            let found = containers.iter().find(|c| c.project == row.name && c.service == service.id);
            let state = match found {
                Some(c) => ServiceState { state: c.state.clone(), health: c.health.clone(), container: c.name.clone() },
                None => ServiceState { state: "missing".into(), health: String::new(), container: String::new() },
            };
            (service.id.clone(), state)
        })
        .collect()
}

// ------------------------------------------------------------------------------- integrations

/// Base de datos' saved spec for a provisioned database: on `127.0.0.1` at its published port, the
/// password left empty (it goes to the keychain, as every saved connection's does), labelled `dev`.
pub fn db_spec(def: &ServiceDef, service: &StackService) -> Option<Value> {
    let kind = def.db_kind?;
    let port = def.ports.first().and_then(|p| service.host_port(p.key))?;
    // SQL Server's development image has a self-signed certificate: encrypted, not verified.
    let ssl = if kind == "sqlserver" { "require" } else { "disable" };
    let options: Vec<(String, String)> = if kind == "mongodb" { vec![("authSource".into(), "admin".into())] } else { vec![] };
    Some(json!({
        "id": "",
        "kind": kind,
        "host": "127.0.0.1",
        "port": port,
        "database": def.database,
        "user": if kind == "redis" { "" } else { def.user },
        "password": "",
        "auth_method": "password",
        "url": "",
        "ssl": ssl,
        "options": options,
        "read_only": false,
        "environment": "dev",
        "connect_timeout_ms": 15000,
    }))
}

fn variable(key: &str, value: &str, secret: bool, description: &str) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "key": key,
        "initialValue": value,
        "currentValue": value,
        "secret": secret,
        "enabled": true,
        "description": description,
    })
}

/// The API client environment for a Keycloak: where it is, the realm, the token endpoint, and the
/// admin login of the master realm (`admin-cli` is the public client every Keycloak has), so a
/// password-grant token works without configuring anything in Keycloak first.
pub fn keycloak_variables(service: &StackService, def: &ServiceDef, password: &str) -> Value {
    let base = format!("http://127.0.0.1:{}", service.host_port("http").unwrap_or(8080));
    json!([
        variable("baseUrl", &base, false, "Keycloak"),
        variable("realm", def.database, false, ""),
        variable("authUrl", "{{baseUrl}}/realms/{{realm}}/protocol/openid-connect/auth", false, ""),
        variable("tokenUrl", "{{baseUrl}}/realms/{{realm}}/protocol/openid-connect/token", false, ""),
        variable("clientId", "admin-cli", false, ""),
        variable("username", def.user, false, ""),
        variable("password", password, true, "Llavero"),
    ])
}

/// The environment for a plain HTTP service (WireMock): its base URL.
pub fn http_variables(service: &StackService, def: &ServiceDef) -> Value {
    let base = service.ports.first().map(|p| format!("http://127.0.0.1:{}", p.host)).unwrap_or_default();
    json!([variable("baseUrl", &base, false, def.name)])
}

/// An `AuthConfig` as the API client writes it — every field present, `oauth2` the one in use.
pub fn auth_config(kind: &str, oauth2: Value) -> Value {
    let mut base = json!({
        "type": kind,
        "basic": { "username": "", "password": "" },
        "bearer": { "token": "" },
        "apikey": { "key": "", "value": "", "addTo": "header" },
        "digest": { "username": "", "password": "" },
        "jwt": { "algorithm": "HS256", "secret": "", "secretBase64": false, "headerJson": "{}", "payloadJson": "{}", "addTo": "header", "headerPrefix": "Bearer", "queryParamName": "token" },
        "awsv4": { "accessKey": "", "secretKey": "", "sessionToken": "", "region": "", "service": "" },
        "oauth2": {
            "grantType": "client_credentials", "authUrl": "", "accessTokenUrl": "", "clientId": "", "clientSecret": "", "scope": "",
            "state": "", "username": "", "password": "", "redirectUri": "http://localhost:8976/callback", "audience": "", "resource": "",
            "clientAuth": "header", "accessToken": "", "refreshToken": "", "expiresAt": 0, "headerPrefix": "Bearer", "addTo": "header"
        },
    });
    if let (Some(slot), Value::Object(fields)) = (base.get_mut("oauth2").and_then(Value::as_object_mut), oauth2) {
        slot.extend(fields);
    }
    base
}

/// The OAuth2 preset: a collection whose auth is the Keycloak password grant, every value a reference
/// to the environment's variables — so it holds no credential, and follows the stack's port.
pub fn keycloak_collection_auth() -> Value {
    auth_config(
        "oauth2",
        json!({
            "grantType": "password",
            "authUrl": "{{authUrl}}",
            "accessTokenUrl": "{{tokenUrl}}",
            "clientId": "{{clientId}}",
            "username": "{{username}}",
            "password": "{{password}}",
            "scope": "openid",
            "clientAuth": "body",
        }),
    )
}

/// The collection's one request: the realm's OpenID configuration, which answers once Keycloak is up.
pub fn keycloak_request_spec() -> Value {
    json!({
        "protocol": "http",
        "method": "GET",
        "url": "{{baseUrl}}/realms/{{realm}}/.well-known/openid-configuration",
        "params": [],
        "pathVars": [],
        "headers": [],
        "auth": auth_config("inherit", json!({})),
        "description": "",
    })
}

/// The secret a Llavero entry holds for a service: its login, password and where it is.
pub fn vault_secret(def: &ServiceDef, service: &StackService, password: &str) -> Value {
    let port = service.ports.first().map(|p| p.host).unwrap_or_default();
    let mut secret = json!({
        "username": def.user,
        "password": password,
        "host": "127.0.0.1",
        "port": port.to_string(),
        "notes": "CodeFlow · Contenedores › Catálogo de servicios",
    });
    if let Some(kind) = def.db_kind {
        secret["engine"] = json!(kind);
        secret["database"] = json!(def.database);
    }
    if let Some(console) = def.console {
        secret["url"] = json!(fill(console, service));
    }
    secret
}

// ---------------------------------------------------------------------------------- storage

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS container_market_stacks (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            runtime      TEXT NOT NULL,
            context      TEXT,
            workspace_id TEXT NOT NULL DEFAULT '',
            dir          TEXT NOT NULL,
            services     TEXT NOT NULL DEFAULT '[]',
            integrations TEXT NOT NULL DEFAULT '[]',
            created_at   TEXT NOT NULL,
            last_error   TEXT NOT NULL DEFAULT ''
         );",
    )
}

const COLUMNS: &str = "id, name, runtime, context, workspace_id, dir, services, integrations, created_at, last_error";

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<StackRow> {
    Ok(StackRow {
        id: row.get(0)?,
        name: row.get(1)?,
        runtime: row.get(2)?,
        context: row.get(3)?,
        workspace_id: row.get(4)?,
        dir: row.get(5)?,
        services: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
        integrations: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
        created_at: row.get(8)?,
        last_error: row.get(9)?,
    })
}

pub fn insert(conn: &Connection, row: &StackRow) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO container_market_stacks ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"),
        params![
            row.id,
            row.name,
            row.runtime,
            row.context,
            row.workspace_id,
            row.dir,
            serde_json::to_string(&row.services).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&row.integrations).unwrap_or_else(|_| "[]".into()),
            row.created_at,
            row.last_error
        ],
    )?;
    Ok(())
}

/// Saves what changes after the insert: the services (their Llavero entries), what was created, the
/// last error.
pub fn save(conn: &Connection, row: &StackRow) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE container_market_stacks SET services = ?2, integrations = ?3, last_error = ?4 WHERE id = ?1",
        params![
            row.id,
            serde_json::to_string(&row.services).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&row.integrations).unwrap_or_else(|_| "[]".into()),
            row.last_error
        ],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<StackRow>> {
    let mut statement = conn.prepare(&format!("SELECT {COLUMNS} FROM container_market_stacks ORDER BY created_at DESC"))?;
    let rows = statement.query_map([], map_row)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<StackRow>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM container_market_stacks WHERE id = ?1"), params![id], map_row).optional()
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM container_market_stacks WHERE id = ?1", params![id])?;
    Ok(())
}

/// Whether a stack of that name is already on that engine — Compose would merge the two projects.
pub fn name_taken(conn: &Connection, name: &str, runtime: &str, context: Option<&str>) -> rusqlite::Result<bool> {
    let rows = list(conn)?;
    Ok(rows.iter().any(|r| r.name == name && r.runtime == runtime && r.context.as_deref().unwrap_or("") == context.unwrap_or("")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(ids: &[&str]) -> Vec<StackService> {
        let defs: Vec<&ServiceDef> = ids.iter().map(|id| find(id).unwrap()).collect();
        plan_ports(&defs, &BTreeMap::new(), &|_| true).unwrap()
    }

    #[test]
    fn every_entry_of_the_catalogue_holds_together() {
        let mut ids = BTreeSet::new();
        for def in catalog() {
            validate(def).unwrap();
            assert!(ids.insert(def.id), "{} twice", def.id);
        }
        // The fifteen the catalogue promises.
        for id in ["postgres", "mysql", "sqlserver", "mongodb", "valkey", "keycloak", "mailpit", "minio", "azurite", "rabbitmq", "redpanda", "wiremock", "qdrant", "jaeger", "lgtm"] {
            assert!(find(id).is_some(), "{id} is missing");
        }
    }

    #[test]
    fn validation_catches_a_floating_tag_and_a_console_on_no_port() {
        let mut def = *find("postgres").unwrap();
        def.image = "postgres:latest";
        assert!(validate(&def).is_err());
        def.image = "postgres";
        assert!(validate(&def).is_err());
        let mut def = *find("mailpit").unwrap();
        def.console = Some("http://127.0.0.1:{port:nope}/");
        assert!(validate(&def).unwrap_err().contains("nope"));
    }

    #[test]
    fn a_taken_default_moves_up_and_never_onto_a_port_already_handed_out() {
        let taken: BTreeSet<u16> = [5432, 5433].into();
        let wishes = [PortWish { preferred: 5432, explicit: false }, PortWish { preferred: 5432, explicit: false }, PortWish { preferred: 8080, explicit: false }];
        let got = choose_ports(&wishes, &|p| !taken.contains(&p)).unwrap();
        assert_eq!(got, vec![5434, 5435, 8080]);
    }

    #[test]
    fn a_typed_port_is_kept_or_refused_but_never_moved() {
        let taken: BTreeSet<u16> = [9000].into();
        let free = |p: u16| !taken.contains(&p);
        assert!(choose_ports(&[PortWish { preferred: 9000, explicit: true }], &free).unwrap_err().contains("9000"));
        // A typed port wins over a default that wanted it: the default moves.
        let got = choose_ports(&[PortWish { preferred: 7000, explicit: false }, PortWish { preferred: 7000, explicit: true }], &free).unwrap();
        assert_eq!(got, vec![7001, 7000]);
        assert!(choose_ports(&[PortWish { preferred: 7000, explicit: true }, PortWish { preferred: 7000, explicit: true }], &free).is_err());
    }

    #[test]
    fn jaeger_and_lgtm_together_do_not_share_the_otlp_ports() {
        let services = plan(&["jaeger", "lgtm"]);
        let hosts: Vec<u16> = services.iter().flat_map(|s| s.ports.iter().map(|p| p.host)).collect();
        let unique: BTreeSet<u16> = hosts.iter().copied().collect();
        assert_eq!(hosts.len(), unique.len(), "{hosts:?}");
        assert_eq!(services[1].host_port("otlpGrpc"), Some(4319));
    }

    #[test]
    fn overrides_are_applied_by_service_and_key() {
        let defs = vec![find("mailpit").unwrap()];
        let overrides = BTreeMap::from([("mailpit".to_string(), BTreeMap::from([("web".to_string(), 18025u16)]))]);
        let services = plan_ports(&defs, &overrides, &|_| true).unwrap();
        assert_eq!(services[0].host_port("web"), Some(18025));
        assert_eq!(services[0].host_port("smtp"), Some(1025));
    }

    #[test]
    fn the_compose_file_publishes_on_loopback_and_holds_no_password() {
        let mut services = plan(&["postgres", "redpanda", "keycloak"]);
        services[1].ports[0].host = 29092;
        let yaml = compose_yaml("shop-dev", "abc", &services, EngineKind::Docker).unwrap();
        assert!(yaml.contains("\"127.0.0.1:5432:5432\""));
        assert!(!yaml.contains("\"5432:5432\""));
        assert!(yaml.contains("POSTGRES_PASSWORD: \"${CF_POSTGRES_SECRET:?"));
        assert!(yaml.contains("KC_BOOTSTRAP_ADMIN_PASSWORD: \"${CF_KEYCLOAK_SECRET:?"));
        // The advertised Kafka address follows the port it was published at.
        assert!(yaml.contains("external://127.0.0.1:29092"));
        assert!(yaml.contains("postgres-data: {}"));
        assert!(yaml.contains("dev.codeflow.stack: \"abc\""));
        assert!(yaml.contains("image: \"postgres:17.2\""));
        // It is YAML a parser reads, with the services where Compose looks for them.
        let doc = &yaml_rust2::YamlLoader::load_from_str(&yaml).unwrap()[0];
        assert_eq!(doc["name"].as_str(), Some("shop-dev"));
        assert_eq!(doc["services"]["postgres"]["ports"][0].as_str(), Some("127.0.0.1:5432:5432"));
        assert_eq!(doc["services"]["keycloak"]["command"][0].as_str(), Some("start-dev"));
        assert_eq!(doc["services"]["postgres"]["healthcheck"]["test"][0].as_str(), Some("CMD-SHELL"));
    }

    #[test]
    fn podman_falls_back_to_empty_rather_than_failing_a_stop() {
        let yaml = compose_yaml("s", "id", &plan(&["mysql"]), EngineKind::Podman).unwrap();
        assert!(yaml.contains("MYSQL_PASSWORD: \"${CF_MYSQL_SECRET:-}\""));
        assert!(!yaml.contains(":?"));
    }

    #[test]
    fn stack_names_are_compose_project_names() {
        for good in ["shop", "shop-dev", "a1_b"] {
            check_stack_name(good).unwrap();
        }
        for bad in ["", "-p", "Shop", "a b", "../x", "_x", "a.b"] {
            assert!(check_stack_name(bad).is_err(), "{bad}");
        }
        assert!(compose_yaml("Bad", "id", &[], EngineKind::Docker).is_err());
    }

    #[test]
    fn up_passes_the_files_and_waits_where_compose_can() {
        let row = StackRow {
            id: "x".into(),
            name: "shop".into(),
            runtime: "docker".into(),
            context: None,
            workspace_id: String::new(),
            dir: "/s/shop".into(),
            services: vec![],
            integrations: vec![],
            created_at: String::new(),
            last_error: String::new(),
        };
        let file = Path::new("/s/shop").join(COMPOSE_FILE).to_string_lossy().into_owned();
        assert_eq!(up_args(EngineKind::Docker, &row, UpWait::WaitWithTimeout), vec!["compose", "-p", "shop", "--project-directory", "/s/shop", "-f", file.as_str(), "up", "-d", "--wait", "--wait-timeout", "600"]);
        assert_eq!(up_args(EngineKind::Docker, &row, UpWait::Wait), vec!["compose", "-p", "shop", "--project-directory", "/s/shop", "-f", file.as_str(), "up", "-d", "--wait"]);
        assert_eq!(up_args(EngineKind::Podman, &row, UpWait::No), vec!["compose", "-p", "shop", "-f", file.as_str(), "up", "-d"]);
    }

    fn stack_row(runtime: &str, context: Option<&str>) -> StackRow {
        StackRow {
            id: "x".into(),
            name: "shop".into(),
            runtime: runtime.into(),
            context: context.map(str::to_string),
            workspace_id: String::new(),
            dir: "/s/shop".into(),
            services: plan(&["postgres", "keycloak"]),
            integrations: vec![],
            created_at: String::new(),
            last_error: String::new(),
        }
    }

    #[test]
    fn the_wait_flags_follow_what_compose_says_it_takes() {
        let modern = "Usage:  docker compose up [OPTIONS] [SERVICE...]\n  -d, --detach   Detached mode\n      --wait     Wait for services to be running|healthy. Implies detached mode.\n      --wait-timeout int   Maximum duration in seconds to wait\n";
        assert_eq!(up_wait_from_help(EngineKind::Docker, Some(modern)), UpWait::WaitWithTimeout);
        let older = "  -d, --detach   Detached mode\n      --wait     Wait for services to be running|healthy.\n";
        assert_eq!(up_wait_from_help(EngineKind::Docker, Some(older)), UpWait::Wait);
        // podman-compose, nerdctl compose: no `--wait` — `--wait-for` or the like is not it.
        let none = "usage: podman-compose up [-h] [-d] [--no-deps] [--force-recreate] [--wait-for x]\n";
        assert_eq!(up_wait_from_help(EngineKind::Podman, Some(none)), UpWait::No);
        assert_eq!(up_wait_from_help(EngineKind::Docker, None), UpWait::WaitWithTimeout, "no answer: Docker keeps what it has had for years");
        assert_eq!(up_wait_from_help(EngineKind::Nerdctl, None), UpWait::No);
    }

    #[test]
    fn the_up_job_carries_its_passwords_only_in_its_environment() {
        let row = stack_row("docker", Some("orbstack"));
        let passwords = BTreeMap::from([("postgres".to_string(), "Pg9secretValueAbcdEFGH12".to_string()), ("keycloak".to_string(), "Kc7otherValueXyzwQRST34".to_string())]);
        let (program, args) = up_command(&row, UpWait::WaitWithTimeout).unwrap();
        assert!(program.ends_with("docker"), "{program}");
        assert_eq!(&args[..4], &["--context", "orbstack", "compose", "-p"]);
        assert!(args.ends_with(&["up".to_string(), "-d".into(), "--wait".into(), "--wait-timeout".into(), "600".into()]));
        let env = up_env(&passwords);
        assert_eq!(env, vec![("CF_KEYCLOAK_SECRET".to_string(), "Kc7otherValueXyzwQRST34".to_string()), ("CF_POSTGRES_SECRET".to_string(), "Pg9secretValueAbcdEFGH12".to_string())]);
        for (_, value) in &env {
            assert!(args.iter().all(|a| !a.contains(value.as_str())), "a password is never on the command line");
        }
        assert!(up_command(&stack_row("ctr", None), UpWait::No).unwrap_err().contains("nerdctl"));
        let mut bad = stack_row("docker", None);
        bad.name = "-p".into();
        assert!(up_command(&bad, UpWait::No).is_err());
    }

    #[test]
    fn a_failed_up_keeps_compose_s_last_lines_and_no_password() {
        let output = "\x1b[1A\x1b[2K[+] Running 1/2\r\n\x1b[1A\x1b[2K[+] Running 1/2\r\n ✘ Container shop-postgres-1  Error\r\nError response from daemon: password Pg9secretValueAbcdEFGH12 refused\r\n";
        let note = up_failure(1, output, &["Pg9secretValueAbcdEFGH12", ""]);
        assert!(note.starts_with("compose up ended with exit code 1\n"));
        assert_eq!(note.matches("[+] Running 1/2").count(), 1, "a redraw is one line: {note}");
        assert!(note.contains("Error response from daemon"));
        assert!(!note.contains("Pg9secretValueAbcdEFGH12"));
        assert!(!note.contains('\x1b'));
        assert_eq!(up_failure(17, "", &[]), "compose up ended with exit code 17");
        let mut kept = String::new();
        for _ in 0..3000 {
            keep_output_tail(&mut kept, "línea ñ\n");
        }
        assert!(kept.len() <= UP_OUTPUT_KEPT && kept.ends_with("línea ñ\n"));
    }

    #[test]
    fn a_generated_secret_has_every_class_and_nothing_to_escape() {
        for _ in 0..50 {
            let s = generate_secret();
            assert_eq!(s.len(), 24);
            assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
            assert!(s.chars().any(|c| c.is_ascii_uppercase()) && s.chars().any(|c| c.is_ascii_lowercase()) && s.chars().any(|c| c.is_ascii_digit()));
        }
        assert_eq!(secret_var("postgres"), "CF_POSTGRES_SECRET");
    }

    #[test]
    fn the_database_spec_is_one_the_database_module_reads() {
        for id in ["postgres", "mysql", "sqlserver", "mongodb", "valkey"] {
            let def = find(id).unwrap();
            let mut service = plan(&[id]).remove(0);
            service.ports[0].host = 40000;
            let spec = db_spec(def, &service).unwrap();
            let config: crate::datasource::DbConnectionConfig = serde_json::from_value(spec).unwrap_or_else(|e| panic!("{id}: {e}"));
            assert_eq!(config.port, 40000);
            assert_eq!(config.host, "127.0.0.1");
            assert!(config.password.is_empty(), "the password goes to the keychain");
        }
        assert!(db_spec(find("mailpit").unwrap(), &plan(&["mailpit"])[0]).is_none());
    }

    #[test]
    fn the_keycloak_preset_holds_references_and_no_credential() {
        let auth = keycloak_collection_auth();
        assert_eq!(auth["type"], "oauth2");
        assert_eq!(auth["oauth2"]["grantType"], "password");
        assert_eq!(auth["oauth2"]["password"], "{{password}}");
        assert_eq!(auth["oauth2"]["redirectUri"], "http://localhost:8976/callback", "the defaults stay");
        let def = find("keycloak").unwrap();
        let mut service = plan(&["keycloak"]).remove(0);
        service.ports[0].host = 18080;
        let vars = keycloak_variables(&service, def, "pw");
        let by_key = |k: &str| vars.as_array().unwrap().iter().find(|v| v["key"] == k).cloned().unwrap();
        assert_eq!(by_key("baseUrl")["currentValue"], "http://127.0.0.1:18080");
        assert_eq!(by_key("password")["secret"], true);
        assert_eq!(by_key("clientId")["currentValue"], "admin-cli");
    }

    #[test]
    fn the_engine_state_is_read_by_project_and_service() {
        let row = StackRow {
            id: "x".into(),
            name: "shop".into(),
            runtime: "docker".into(),
            context: None,
            workspace_id: String::new(),
            dir: String::new(),
            services: plan(&["postgres", "mailpit"]),
            integrations: vec![],
            created_at: String::new(),
            last_error: String::new(),
        };
        let ps = r#"{"ID":"1","Image":"postgres:17.2","Labels":"com.docker.compose.project=shop,com.docker.compose.service=postgres","Names":"shop-postgres-1","Ports":"127.0.0.1:5432->5432/tcp","State":"running","Status":"Up 2 minutes (healthy)"}
{"ID":"2","Image":"postgres:17.2","Labels":"com.docker.compose.project=other,com.docker.compose.service=postgres","Names":"other-postgres-1","Ports":"","State":"exited","Status":"Exited (0)"}"#;
        let containers = crate::containers::engine::parse_containers(ps);
        let states = states_of(&row, &containers);
        assert_eq!(states["postgres"].state, "running");
        assert_eq!(states["postgres"].health, "healthy");
        assert_eq!(states["mailpit"].state, "missing");
        assert!(published_ports(&containers).contains(&5432));
    }

    #[test]
    fn stacks_are_kept_and_read_back() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let mut row = StackRow {
            id: "s1".into(),
            name: "shop".into(),
            runtime: "docker".into(),
            context: Some("orbstack".into()),
            workspace_id: "w".into(),
            dir: "/d".into(),
            services: plan(&["postgres"]),
            integrations: vec![],
            created_at: "2026-11-24T00:00:00Z".into(),
            last_error: String::new(),
        };
        insert(&conn, &row).unwrap();
        assert!(name_taken(&conn, "shop", "docker", Some("orbstack")).unwrap());
        assert!(!name_taken(&conn, "shop", "docker", None).unwrap());
        row.integrations.push(Created { kind: "dbConnection".into(), id: "c1".into(), label: "shop · PostgreSQL".into(), service: "postgres".into() });
        row.services[0].secret_item = Some("v1".into());
        save(&conn, &row).unwrap();
        let back = get(&conn, "s1").unwrap().unwrap();
        assert_eq!(back.integrations, row.integrations);
        assert_eq!(back.services[0].secret_item.as_deref(), Some("v1"));
        assert_eq!(back.services[0].host_port("postgres"), Some(5432));
        delete(&conn, "s1").unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
}
