//! «Políticas de seguridad» — what a workspace allows a container to be, written down once and
//! enforced by this code rather than asked of whoever starts the container (a person in the Run
//! dialog, a flow, an agent through the sandbox broker).
//!
//! **Built on the hardening rules, not beside them.** [`hardening::audit`] already reads what weakens
//! a container's isolation out of an `inspect` document. A policy is the user's answer to "which of
//! those may happen here", so the same findings are checked against it: a running container by its
//! own inspect document ([`check_container`]), and a container not started yet by the document its
//! [`RunSpec`] would produce ([`spec_document`], [`check_spec`]) — one set of rules, two moments.
//! What the hardening rules cannot know is added here: which host folders are the system's or the
//! user's secrets (a bind of `/etc/ssl` or `~/.ssh`, not just `/etc`), the image's latest kept scan,
//! whether its signature verifies, and whether the network it joins reaches the internet.
//!
//! **A required check that cannot be made blocks, and says why.** Signed images are verified with
//! `cosign verify` when cosign is installed; a policy that requires signatures on a machine without
//! cosign does not quietly pass — the image is refused with "cosign is not installed". An image with
//! no kept scan is the one exception: it is an advisory, not a block, because a scan is a command
//! away and the page says so.
//!
//! Policies are per workspace with a global default (the row whose `workspace_id` is empty); a
//! workspace without its own row follows the default, and without either the built-in [`Default`].

use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::engine::Target;
use super::hardening::{self, HardeningFinding};
use super::run::RunSpec;
use super::scan::{self, ScanSummary};
use super::cli;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SecurityPolicy {
    /// No `--privileged`, and no capability that amounts to it (`ALL`, `SYS_ADMIN`…).
    pub no_privileged: bool,
    /// No bind mount of a host system folder (`/etc`, `/proc`, `/var/run`…) or of the user's home
    /// itself and its secret folders (`~/.ssh`, `~/.aws`…).
    pub no_host_mounts: bool,
    pub require_non_root: bool,
    /// Refuse an image whose latest kept scan found a critical vulnerability.
    pub block_critical_vulns: bool,
    pub require_signed: bool,
    /// A cosign public key to verify against; empty accepts any keyless (Sigstore) signature.
    pub signing_key: String,
    /// No outbound internet: the container joins no network, or an internal one only.
    pub restrict_network: bool,
    /// No engine socket inside (`docker.sock`, `podman.sock`…): with it a container commands the engine.
    pub no_engine_socket: bool,
    /// Memory and CPU limits are set.
    pub require_limits: bool,
    /// The Flows container nodes are held to this policy too (a hard block), not only sandboxes.
    pub enforce_in_flows: bool,
    /// The image an agent sandbox starts from when none is chosen.
    pub sandbox_image: String,
}

/// The image a sandbox runs when nothing else is said: Microsoft's dev container base — Debian with
/// git, curl, a non-root user and nothing else, small enough to pull on demand.
pub const DEFAULT_SANDBOX_IMAGE: &str = "mcr.microsoft.com/devcontainers/base:bookworm";

impl Default for SecurityPolicy {
    /// What a machine that never opened the settings gets: the three rules no legitimate container
    /// of a developer needs broken (privileged, the engine's socket, the host's system folders).
    fn default() -> Self {
        SecurityPolicy {
            no_privileged: true,
            no_host_mounts: true,
            require_non_root: false,
            block_critical_vulns: false,
            require_signed: false,
            signing_key: String::new(),
            restrict_network: false,
            no_engine_socket: true,
            require_limits: false,
            enforce_in_flows: false,
            sandbox_image: DEFAULT_SANDBOX_IMAGE.to_string(),
        }
    }
}

impl SecurityPolicy {
    pub fn sandbox_image(&self) -> String {
        let image = self.sandbox_image.trim();
        if image.is_empty() { DEFAULT_SANDBOX_IMAGE.to_string() } else { image.to_string() }
    }
}

/// A workspace's policy as the settings show it: the one in force, and where it comes from.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredPolicy {
    /// The workspace asked about (`""` for the default itself).
    pub workspace_id: String,
    pub policy: SecurityPolicy,
    /// `own` (the workspace's row), `default` (the global row) or `builtIn`.
    pub source: String,
    pub updated_at: String,
}

/// One thing a container would do, or does, that the policy forbids.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    /// `privileged`, `hostMount`, `engineSocket`, `rootUser`, `noMemoryLimit`, `noCpuLimit`,
    /// `criticalVulns`, `notScanned`, `unsigned`, `network`.
    pub rule: String,
    /// What triggered it: a path, a capability, a count, a network, a reason.
    pub detail: String,
    /// False only for an advisory (`notScanned`): shown, never refused for.
    pub blocking: bool,
}

impl Violation {
    fn block(rule: &str, detail: impl Into<String>) -> Self {
        Violation { rule: rule.into(), detail: detail.into(), blocking: true }
    }

    /// The violation in a sentence, for an error a flow or an agent reads.
    pub fn sentence(&self) -> String {
        let what = match self.rule.as_str() {
            "privileged" => "privileged mode or a capability that amounts to it",
            "hostMount" => "a mount of a host system folder",
            "engineSocket" => "the container engine's socket mounted inside",
            "rootUser" => "running as root",
            "noMemoryLimit" => "no memory limit",
            "noCpuLimit" => "no CPU limit",
            "criticalVulns" => "critical vulnerabilities in the image's latest scan",
            "notScanned" => "an image never scanned",
            "unsigned" => "an image whose signature does not verify",
            "network" => "a network that reaches the internet",
            other => other,
        };
        if self.detail.is_empty() { what.to_string() } else { format!("{what} ({})", self.detail) }
    }
}

/// Whether any of `violations` is a refusal.
pub fn blocks(violations: &[Violation]) -> bool {
    violations.iter().any(|v| v.blocking)
}

/// The refusal a flow or the broker answers with.
pub fn refusal(violations: &[Violation]) -> String {
    let list: Vec<String> = violations.iter().filter(|v| v.blocking).map(Violation::sentence).collect();
    format!("the workspace's security policy does not allow {}", list.join("; "))
}

/// Whether an image's signature verified, as far as this machine could tell.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Signature {
    /// The policy does not ask, so nobody looked.
    #[default]
    NotChecked,
    Verified,
    /// cosign ran and refused it.
    Failed { reason: String },
    /// It could not be checked here: no cosign, no registry copy, no network.
    Unavailable { reason: String },
}

/// What the policy needs to know beyond the run's own settings.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub latest_scan: Option<ScanSummary>,
    pub signature: Signature,
    /// The image's own `USER`, for a run that does not set one; empty when it has none (root) or
    /// could not be read.
    pub image_user: String,
    /// The networks known to be internal (`--internal`: no route out).
    pub internal_networks: Vec<String>,
}

// ------------------------------------------------------------------------------------- the check

/// Host folders that are the system's, bound by themselves or anything under them. `/` alone is
/// matched exactly — everything is under it.
const SYSTEM_DIRS: [&str; 20] = [
    "/etc", "/proc", "/sys", "/boot", "/dev", "/root", "/var/run", "/run", "/var/lib/docker", "/var/lib/containers", "/usr", "/bin", "/sbin",
    "/lib", "/System", "/Library", "/private/etc", "/private/var/run", "/Applications", "/var/log",
];

/// Folders of the home that hold the user's credentials.
const HOME_SECRETS: [&str; 9] = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gcloud", ".azure", ".netrc", ".git-credentials"];

fn under(path: &str, dir: &str) -> bool {
    path == dir || path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// Whether a bind's source is the host's system or the user's secrets. `home` is passed in so the
/// rule can be tested on any machine.
pub fn system_path(source: &str, home: Option<&Path>) -> bool {
    let source = source.trim().trim_end_matches('/');
    if source.is_empty() {
        return true; // `/`, trimmed
    }
    if SYSTEM_DIRS.iter().any(|dir| under(source, dir)) {
        return true;
    }
    if let Some(home) = home.and_then(|h| h.to_str()).map(|h| h.trim_end_matches('/')).filter(|h| !h.is_empty()) {
        if source == home || source == "/Users" || source == "/home" {
            return true;
        }
        return HOME_SECRETS.iter().any(|secret| under(source, &format!("{home}/{secret}")));
    }
    source == "/Users" || source == "/home"
}

/// Whether a network reaches the internet: anything but no network at all or an internal one.
pub fn network_allowed(network: &str, internal: &[String]) -> bool {
    let network = network.trim();
    network == "none" || internal.iter().any(|n| n == network)
}

/// The bind mounts a run spec makes, as `(source, writable)`.
fn spec_binds(spec: &RunSpec) -> Vec<(String, bool)> {
    spec.volumes
        .iter()
        .filter(|v| {
            let source = v.source.trim();
            match v.kind.trim() {
                "bind" => true,
                "" => source.starts_with('/') || Path::new(source).is_absolute(),
                _ => false,
            }
        })
        .filter(|v| !v.source.trim().is_empty())
        .map(|v| (v.source.trim().to_string(), !v.read_only))
        .collect()
}

/// The inspect document `spec` would produce once run — the fields [`hardening::audit`] reads, so
/// the same rules judge a container before it exists. `image_user` stands in for a run that keeps
/// the image's user.
pub fn spec_document(spec: &RunSpec, image_user: &str) -> Value {
    let user = if spec.user.trim().is_empty() { image_user.trim() } else { spec.user.trim() };
    let mounts: Vec<Value> = spec_binds(spec).into_iter().map(|(source, rw)| json!({"Type": "bind", "Source": source, "RW": rw})).collect();
    let mut security: Vec<String> = Vec::new();
    if spec.no_new_privileges {
        security.push("no-new-privileges".into());
    }
    if spec.seccomp.trim() == "unconfined" {
        security.push("seccomp=unconfined".into());
    }
    let network = spec.network.trim();
    json!({
        "Config": {"User": user, "Healthcheck": if spec.health.command.trim().is_empty() { Value::Null } else { json!({"Test": ["CMD-SHELL", spec.health.command.trim()]}) }},
        "HostConfig": {
            "Privileged": false,
            "NetworkMode": if network.is_empty() { "default" } else { network },
            "CapAdd": spec.cap_add.iter().filter(|c| !c.trim().is_empty()).cloned().collect::<Vec<_>>(),
            "SecurityOpt": security,
            "ReadonlyRootfs": spec.read_only,
            "Memory": spec.memory_mb.filter(|m| *m > 0.0).map(|m| (m * 1024.0 * 1024.0) as i64).unwrap_or(0),
            "NanoCpus": spec.cpus.filter(|c| *c > 0.0).map(|c| (c * 1e9) as i64).unwrap_or(0),
            "PidsLimit": spec.pids_limit.filter(|p| *p > 0.0).map(|p| p as i64).unwrap_or(0),
        },
        "Mounts": mounts,
    })
}

/// The policy's verdict on hardening findings plus the facts beside them. `binds` are the bind
/// sources (for the wider host-path rule) and `networks` the networks the container is on.
fn judge(policy: &SecurityPolicy, findings: &[HardeningFinding], binds: &[String], networks: &[String], facts: &Facts, home: Option<&Path>) -> Vec<Violation> {
    let mut out: Vec<Violation> = Vec::new();
    let mut push = |v: Violation| {
        if !out.contains(&v) {
            out.push(v);
        }
    };
    for finding in findings {
        match finding.rule.as_str() {
            "privileged" if policy.no_privileged => push(Violation::block("privileged", "")),
            "dangerousCap" if policy.no_privileged => push(Violation::block("privileged", finding.detail.clone())),
            "engineSocket" if policy.no_engine_socket => push(Violation::block("engineSocket", finding.detail.clone())),
            "hostMount" if policy.no_host_mounts => push(Violation::block("hostMount", finding.detail.clone())),
            "hostNetwork" | "hostPid" if policy.no_privileged => push(Violation::block("privileged", finding.rule.clone())),
            "rootUser" if policy.require_non_root => push(Violation::block("rootUser", "")),
            "noMemoryLimit" if policy.require_limits => push(Violation::block("noMemoryLimit", "")),
            "noCpuLimit" if policy.require_limits => push(Violation::block("noCpuLimit", "")),
            _ => {}
        }
    }
    if policy.no_host_mounts {
        for source in binds {
            let trimmed = source.trim_end_matches('/');
            let socket = ["docker.sock", "podman.sock", "containerd.sock", "buildkitd.sock", "crio.sock"].iter().any(|s| trimmed.ends_with(s));
            if !socket && system_path(source, home) {
                push(Violation::block("hostMount", if trimmed.is_empty() { "/".to_string() } else { trimmed.to_string() }));
            }
        }
    }
    if policy.restrict_network {
        for network in networks {
            if !network_allowed(network, &facts.internal_networks) {
                push(Violation::block("network", network.clone()));
            }
        }
    }
    if policy.block_critical_vulns {
        match &facts.latest_scan {
            Some(scan) if scan.critical > 0 => push(Violation::block("criticalVulns", scan.critical.to_string())),
            Some(_) => {}
            None => push(Violation { rule: "notScanned".into(), detail: String::new(), blocking: false }),
        }
    }
    if policy.require_signed {
        match &facts.signature {
            Signature::Verified => {}
            Signature::Failed { reason } | Signature::Unavailable { reason } => push(Violation::block("unsigned", reason.clone())),
            Signature::NotChecked => push(Violation::block("unsigned", "the signature was not checked")),
        }
    }
    out
}

/// A container not started yet, judged by the document its spec would produce.
pub fn check_spec(policy: &SecurityPolicy, spec: &RunSpec, facts: &Facts) -> Vec<Violation> {
    check_spec_at(policy, spec, facts, dirs::home_dir().as_deref())
}

pub fn check_spec_at(policy: &SecurityPolicy, spec: &RunSpec, facts: &Facts, home: Option<&Path>) -> Vec<Violation> {
    let doc = spec_document(spec, &facts.image_user);
    let findings = hardening::audit(&doc);
    let binds: Vec<String> = spec_binds(spec).into_iter().map(|(source, _)| source).collect();
    let network = spec.network.trim();
    let networks = vec![if network.is_empty() { "bridge".to_string() } else { network.to_string() }];
    judge(policy, &findings, &binds, &networks, facts, home)
}

/// A running (or stopped) container, judged by its own inspect document.
pub fn check_container(policy: &SecurityPolicy, doc: &Value, facts: &Facts) -> Vec<Violation> {
    check_container_at(policy, doc, facts, dirs::home_dir().as_deref())
}

pub fn check_container_at(policy: &SecurityPolicy, doc: &Value, facts: &Facts, home: Option<&Path>) -> Vec<Violation> {
    let findings = hardening::audit(doc);
    let binds: Vec<String> = doc
        .get("Mounts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| m.get("Type").and_then(Value::as_str) == Some("bind"))
        .filter_map(|m| m.get("Source").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut networks: Vec<String> = doc
        .pointer("/NetworkSettings/Networks")
        .and_then(Value::as_object)
        .map(|nets| nets.keys().cloned().collect())
        .unwrap_or_default();
    if networks.is_empty() {
        let mode = doc.pointer("/HostConfig/NetworkMode").and_then(Value::as_str).unwrap_or("default");
        networks.push(mode.to_string());
    }
    judge(policy, &findings, &binds, &networks, facts, home)
}

// ------------------------------------------------------------------------------------- storage

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS container_security_policies (
            -- '' is the default every workspace without a row of its own follows.
            workspace_id TEXT PRIMARY KEY,
            policy       TEXT NOT NULL,
            updated_at   TEXT NOT NULL
         );",
    )
}

fn row(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Option<(SecurityPolicy, String)>> {
    conn.query_row("SELECT policy, updated_at FROM container_security_policies WHERE workspace_id = ?1", params![workspace_id], |r| {
        let text: String = r.get(0)?;
        Ok((serde_json::from_str(&text).unwrap_or_default(), r.get(1)?))
    })
    .optional()
}

/// The policy in force for `workspace_id`: its own, else the default, else the built-in one.
pub fn load(conn: &Connection, workspace_id: &str) -> rusqlite::Result<StoredPolicy> {
    let workspace_id = workspace_id.trim();
    if !workspace_id.is_empty() {
        if let Some((policy, updated_at)) = row(conn, workspace_id)? {
            return Ok(StoredPolicy { workspace_id: workspace_id.into(), policy, source: "own".into(), updated_at });
        }
    }
    Ok(match row(conn, "")? {
        Some((policy, updated_at)) => StoredPolicy { workspace_id: workspace_id.into(), policy, source: "default".into(), updated_at },
        None => StoredPolicy { workspace_id: workspace_id.into(), policy: SecurityPolicy::default(), source: "builtIn".into(), updated_at: String::new() },
    })
}

/// Keeps `policy` for `workspace_id` (`""` = the default).
pub fn save(conn: &Connection, workspace_id: &str, policy: &SecurityPolicy) -> rusqlite::Result<StoredPolicy> {
    let text = serde_json::to_string(policy).unwrap_or_else(|_| "{}".into());
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO container_security_policies (workspace_id, policy, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(workspace_id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at",
        params![workspace_id.trim(), text, now],
    )?;
    load(conn, workspace_id)
}

/// Drops a workspace's own policy, so it follows the default again (or the default itself, so the
/// built-in one applies).
pub fn reset(conn: &Connection, workspace_id: &str) -> rusqlite::Result<StoredPolicy> {
    conn.execute("DELETE FROM container_security_policies WHERE workspace_id = ?1", params![workspace_id.trim()])?;
    load(conn, workspace_id)
}

/// The latest kept scan of `image` — by the name it was scanned as, or with `:latest` added, the way
/// the engines read a bare name.
pub fn latest_scan(conn: &Connection, image: &str) -> Option<ScanSummary> {
    let image = image.trim();
    let first = scan::history(conn, image).ok().and_then(|h| h.into_iter().next());
    first.or_else(|| {
        let tagged = image.rsplit('/').next().is_some_and(|last| last.contains(':') || last.contains('@'));
        (!tagged).then(|| scan::history(conn, &format!("{image}:latest")).ok().and_then(|h| h.into_iter().next())).flatten()
    })
}

// ------------------------------------------------------------------------------------- the facts

const COSIGN_TIMEOUT: Duration = Duration::from_secs(90);
const FACT_TIMEOUT: Duration = Duration::from_secs(15);

pub fn cosign() -> Option<String> {
    cli::find("cosign").map(|p| p.to_string_lossy().into_owned())
}

/// `cosign verify`'s arguments: against a key when one is set, else any keyless Sigstore signature
/// (an identity and an issuer are required by cosign 2; any of each is the policy "signed at all").
pub fn verify_args(image: &str, key: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["verify".into()];
    let key = key.trim();
    if key.is_empty() {
        args.extend(["--certificate-identity-regexp=.*".into(), "--certificate-oidc-issuer-regexp=.*".into()]);
    } else {
        args.push(format!("--key={key}"));
    }
    args.extend(["--output=json".into(), image.trim().to_string()]);
    args
}

/// Verifies `image`'s signature with cosign, or says why it could not be.
pub async fn verify_signature(image: &str, key: &str) -> Signature {
    let Some(program) = cosign() else {
        return Signature::Unavailable { reason: "cosign is not installed".into() };
    };
    if !key.trim().is_empty() && !Path::new(key.trim()).is_file() {
        return Signature::Unavailable { reason: format!("the key {} is not a file on this computer", key.trim()) };
    }
    match cli::run(&program, &verify_args(image, key), None, COSIGN_TIMEOUT).await {
        Ok(out) if out.ok() => Signature::Verified,
        Ok(out) => Signature::Failed { reason: out.complaint() },
        Err(e) => Signature::Unavailable { reason: e },
    }
}

/// The image's own `USER`, from the engine's copy; empty when it has none or is not here.
async fn image_user(target: &Target, image: &str) -> String {
    let args: Vec<String> = vec!["image".into(), "inspect".into(), "--format".into(), "{{json .Config.User}}".into(), image.trim().into()];
    match target.run_owned(args, FACT_TIMEOUT).await {
        Ok(out) if out.ok() => serde_json::from_str::<String>(out.stdout.trim()).unwrap_or_else(|_| out.stdout.trim().trim_matches('"').to_string()),
        _ => String::new(),
    }
}

/// Whether the engine's network `name` is internal (no route out).
pub async fn is_internal_network(target: &Target, name: &str) -> bool {
    let args: Vec<String> = vec!["network".into(), "inspect".into(), "--format".into(), "{{.Internal}}".into(), name.trim().into()];
    matches!(target.run_owned(args, FACT_TIMEOUT).await, Ok(out) if out.ok() && out.stdout.trim() == "true")
}

/// What the policy needs to know about running `image` on `network`, asked only for the rules it
/// has on: no cosign call for a policy that does not require signatures.
pub async fn facts_for(target: &Target, image: &str, networks: &[String], policy: &SecurityPolicy, latest_scan: Option<ScanSummary>) -> Facts {
    let mut facts = Facts { latest_scan, ..Default::default() };
    if policy.require_signed {
        facts.signature = verify_signature(image, &policy.signing_key).await;
    }
    if policy.require_non_root {
        facts.image_user = image_user(target, image).await;
    }
    if policy.restrict_network {
        for network in networks {
            let name = network.trim();
            if !name.is_empty() && !matches!(name, "none" | "host" | "bridge" | "default") && super::engine::check_ref(name).is_ok() && is_internal_network(target, name).await {
                facts.internal_networks.push(name.to_string());
            }
        }
    }
    facts
}

/// The policy check a form shows: the policy in force and what `spec` breaks of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyCheck {
    pub policy: StoredPolicy,
    pub violations: Vec<Violation>,
    pub blocked: bool,
    pub signature: Signature,
}

/// What `spec` breaks of `workspace_id`'s policy — the Run dialog's warnings, before it runs.
pub async fn check_run(db: &crate::db::Db, workspace_id: &str, target: &Target, spec: &RunSpec) -> Result<PolicyCheck, String> {
    let (stored, scan) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (load(&conn, workspace_id).map_err(|e| e.to_string())?, latest_scan(&conn, &spec.image))
    };
    let facts = facts_for(target, &spec.image, std::slice::from_ref(&spec.network), &stored.policy, scan).await;
    let violations = check_spec(&stored.policy, spec, &facts);
    Ok(PolicyCheck { blocked: blocks(&violations), policy: stored, violations, signature: facts.signature })
}

/// What an existing container breaks of `workspace_id`'s policy, from its inspect document.
pub async fn check_existing(db: &crate::db::Db, workspace_id: &str, target: &Target, id: &str) -> Result<PolicyCheck, String> {
    let doc_text = super::engine::inspect(target, "container", id).await?;
    let doc: Value = serde_json::from_str(&doc_text).map_err(|_| "the engine's inspect document could not be read".to_string())?;
    let image = doc.pointer("/Config/Image").and_then(Value::as_str).unwrap_or_default().to_string();
    let networks: Vec<String> = doc.pointer("/NetworkSettings/Networks").and_then(Value::as_object).map(|n| n.keys().cloned().collect()).unwrap_or_default();
    let (stored, scan) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (load(&conn, workspace_id).map_err(|e| e.to_string())?, latest_scan(&conn, &image))
    };
    let mut facts = facts_for(target, &image, &networks, &stored.policy, scan).await;
    // The container's own user is in its document; the image's is not needed.
    facts.image_user.clear();
    let violations = check_container(&stored.policy, &doc, &facts);
    Ok(PolicyCheck { blocked: blocks(&violations), policy: stored, violations, signature: facts.signature })
}

/// The Flows container nodes' gate: `Err` with the refusal when the workspace's policy is enforced
/// on flows and `spec` breaks it. Without the app (a test) or without a policy, nothing is checked.
pub async fn enforce_for_flow(workspace_id: &str, target: &Target, spec: &RunSpec) -> Result<(), String> {
    use tauri::Manager;
    let Some(app) = crate::ai_usage::app() else { return Ok(()) };
    let Some(db) = app.try_state::<crate::db::Db>() else { return Ok(()) };
    let (stored, scan) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (load(&conn, workspace_id).map_err(|e| e.to_string())?, latest_scan(&conn, &spec.image))
    };
    if !stored.policy.enforce_in_flows {
        return Ok(());
    }
    let networks = vec![spec.network.clone()];
    let facts = facts_for(target, &spec.image, &networks, &stored.policy, scan).await;
    let violations = check_spec(&stored.policy, spec, &facts);
    if blocks(&violations) {
        Err(refusal(&violations))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::containers::run::RunVolume;
    use std::path::PathBuf;

    fn home() -> PathBuf {
        PathBuf::from("/Users/me")
    }

    fn strict() -> SecurityPolicy {
        SecurityPolicy {
            no_privileged: true,
            no_host_mounts: true,
            require_non_root: true,
            block_critical_vulns: true,
            require_signed: false,
            signing_key: String::new(),
            restrict_network: true,
            no_engine_socket: true,
            require_limits: true,
            enforce_in_flows: true,
            sandbox_image: String::new(),
        }
    }

    fn bind(source: &str, read_only: bool) -> RunVolume {
        RunVolume { kind: "bind".into(), source: source.into(), target: "/mnt".into(), read_only }
    }

    fn hardened() -> RunSpec {
        RunSpec {
            image: "app:1".into(),
            user: "1000:1000".into(),
            network: "none".into(),
            memory_mb: Some(512.0),
            cpus: Some(1.0),
            pids_limit: Some(256.0),
            read_only: true,
            no_new_privileges: true,
            cap_drop: vec!["ALL".into()],
            volumes: vec![bind("/Users/me/code/app", false)],
            ..Default::default()
        }
    }

    fn scanned(critical: u32) -> Option<ScanSummary> {
        Some(ScanSummary { id: "s".into(), image: "app:1".into(), image_id: String::new(), scanner: "trivy".into(), scanned_at: "t".into(), critical, high: 0, medium: 0, low: 0, unknown: 0 })
    }

    fn rules(v: &[Violation]) -> Vec<&str> {
        v.iter().map(|v| v.rule.as_str()).collect()
    }

    fn check(policy: &SecurityPolicy, spec: &RunSpec, facts: &Facts) -> Vec<Violation> {
        check_spec_at(policy, spec, facts, Some(&home()))
    }

    #[test]
    fn a_hardened_spec_passes_the_strictest_policy() {
        let facts = Facts { latest_scan: scanned(0), ..Default::default() };
        assert_eq!(check(&strict(), &hardened(), &facts), vec![]);
    }

    #[test]
    fn a_default_run_breaks_every_rule_a_strict_policy_has() {
        let spec = RunSpec { image: "app:1".into(), ..Default::default() };
        let found = check(&strict(), &spec, &Facts::default());
        assert_eq!(rules(&found), vec!["rootUser", "noMemoryLimit", "noCpuLimit", "network", "notScanned"]);
        assert!(blocks(&found));
        // The advisory alone is never a refusal.
        let only = vec![Violation { rule: "notScanned".into(), detail: String::new(), blocking: false }];
        assert!(!blocks(&only));
    }

    #[test]
    fn the_built_in_policy_only_minds_the_ways_out() {
        let spec = RunSpec { image: "app:1".into(), ..Default::default() };
        assert_eq!(check(&SecurityPolicy::default(), &spec, &Facts::default()), vec![]);
        let escape = RunSpec { volumes: vec![bind("/var/run/docker.sock", false), bind("/etc", true)], cap_add: vec!["SYS_ADMIN".into()], ..spec };
        let found = check(&SecurityPolicy::default(), &escape, &Facts::default());
        assert!(found.contains(&Violation::block("engineSocket", "/var/run/docker.sock")));
        assert!(found.contains(&Violation::block("hostMount", "/etc")));
        assert!(found.contains(&Violation::block("privileged", "SYS_ADMIN")));
    }

    #[test]
    fn a_switched_off_rule_says_nothing() {
        let open = SecurityPolicy { no_privileged: false, no_host_mounts: false, no_engine_socket: false, ..Default::default() };
        let escape = RunSpec { image: "x".into(), volumes: vec![bind("/var/run/docker.sock", false), bind("/etc", false)], cap_add: vec!["ALL".into()], ..Default::default() };
        assert_eq!(check(&open, &escape, &Facts::default()), vec![]);
    }

    #[test]
    fn host_paths_are_the_system_and_the_users_secrets_not_their_projects() {
        let home = home();
        for path in ["/", "/etc", "/etc/ssl", "/proc/1", "/var/run", "/usr/local", "/Users/me", "/Users/me/.ssh", "/Users/me/.aws/credentials", "/Users/me/.config/gcloud", "/Users", "/home", "/private/etc/hosts"] {
            assert!(system_path(path, Some(&home)), "{path} is the host's");
        }
        for path in ["/Users/me/code/app", "/Users/me/.sshkeys-notes", "/tmp/work", "/opt/data", "/etcetera", "/Users/me/.config/app"] {
            assert!(!system_path(path, Some(&home)), "{path} is not the host's");
        }
        let spec = RunSpec { image: "x".into(), volumes: vec![bind("/Users/me/.ssh", true), bind("/Users/me/code/app", false)], ..Default::default() };
        let found = check(&SecurityPolicy::default(), &spec, &Facts::default());
        assert_eq!(found, vec![Violation::block("hostMount", "/Users/me/.ssh")], "a read-only mount of the keys is still the keys");
        // A named volume is never the host's, whatever it is called.
        let named = RunSpec { image: "x".into(), volumes: vec![RunVolume { kind: "volume".into(), source: "etc".into(), target: "/etc".into(), read_only: false }], ..Default::default() };
        assert_eq!(check(&SecurityPolicy::default(), &named, &Facts::default()), vec![]);
    }

    #[test]
    fn non_root_is_the_runs_user_or_else_the_images() {
        let policy = SecurityPolicy { require_non_root: true, ..Default::default() };
        let spec = RunSpec { image: "x".into(), ..Default::default() };
        assert_eq!(rules(&check(&policy, &spec, &Facts::default())), vec!["rootUser"], "no user anywhere is root");
        let facts = Facts { image_user: "node".into(), ..Default::default() };
        assert_eq!(check(&policy, &spec, &facts), vec![], "the image runs as node");
        let as_root = RunSpec { user: "0:0".into(), ..spec.clone() };
        assert_eq!(rules(&check(&policy, &as_root, &facts)), vec!["rootUser"], "the run's user wins over the image's");
        let root_image = Facts { image_user: "root".into(), ..Default::default() };
        assert_eq!(rules(&check(&policy, &spec, &root_image)), vec!["rootUser"]);
    }

    #[test]
    fn limits_are_both_memory_and_cpu() {
        let policy = SecurityPolicy { require_limits: true, ..Default::default() };
        let memory_only = RunSpec { image: "x".into(), memory_mb: Some(256.0), ..Default::default() };
        assert_eq!(rules(&check(&policy, &memory_only, &Facts::default())), vec!["noCpuLimit"]);
        let zero = RunSpec { image: "x".into(), memory_mb: Some(0.0), cpus: Some(0.0), ..Default::default() };
        assert_eq!(rules(&check(&policy, &zero, &Facts::default())), vec!["noMemoryLimit", "noCpuLimit"], "a zero is no limit");
    }

    #[test]
    fn the_network_rule_allows_none_and_internal_networks_only() {
        let policy = SecurityPolicy { restrict_network: true, ..Default::default() };
        let on = |network: &str, internal: &[&str]| {
            let spec = RunSpec { image: "x".into(), network: network.into(), ..Default::default() };
            let facts = Facts { internal_networks: internal.iter().map(|s| s.to_string()).collect(), ..Default::default() };
            check(&policy, &spec, &facts)
        };
        assert_eq!(on("none", &[]), vec![]);
        assert_eq!(on("sbx", &["sbx"]), vec![]);
        assert_eq!(on("sbx", &[]), vec![Violation::block("network", "sbx")]);
        assert_eq!(on("", &[]), vec![Violation::block("network", "bridge")], "the default network reaches out");
        let host = on("host", &[]);
        assert!(host.contains(&Violation::block("network", "host")));
        assert!(host.contains(&Violation::block("privileged", "hostNetwork")), "the host's network is the host");
    }

    #[test]
    fn critical_vulnerabilities_block_and_no_scan_only_advises() {
        let policy = SecurityPolicy { block_critical_vulns: true, ..Default::default() };
        let spec = RunSpec { image: "x".into(), ..Default::default() };
        assert_eq!(check(&policy, &spec, &Facts { latest_scan: scanned(3), ..Default::default() }), vec![Violation::block("criticalVulns", "3")]);
        assert_eq!(check(&policy, &spec, &Facts { latest_scan: scanned(0), ..Default::default() }), vec![]);
        let none = check(&policy, &spec, &Facts::default());
        assert_eq!(rules(&none), vec!["notScanned"]);
        assert!(!blocks(&none));
    }

    #[test]
    fn a_required_signature_that_cannot_be_checked_blocks_and_says_why() {
        let policy = SecurityPolicy { require_signed: true, ..Default::default() };
        let spec = RunSpec { image: "x".into(), ..Default::default() };
        let with = |signature: Signature| check(&policy, &spec, &Facts { signature, ..Default::default() });
        assert_eq!(with(Signature::Verified), vec![]);
        assert_eq!(with(Signature::Unavailable { reason: "cosign is not installed".into() }), vec![Violation::block("unsigned", "cosign is not installed")]);
        assert_eq!(with(Signature::Failed { reason: "no matching signatures".into() }), vec![Violation::block("unsigned", "no matching signatures")]);
        assert!(blocks(&with(Signature::NotChecked)), "never checked is never verified");
        let refused = refusal(&with(Signature::Unavailable { reason: "cosign is not installed".into() }));
        assert!(refused.contains("cosign is not installed"), "{refused}");
    }

    #[test]
    fn cosign_is_asked_for_a_key_or_any_sigstore_identity() {
        assert_eq!(verify_args("ghcr.io/acme/app:1", ""), vec!["verify", "--certificate-identity-regexp=.*", "--certificate-oidc-issuer-regexp=.*", "--output=json", "ghcr.io/acme/app:1"]);
        assert_eq!(verify_args(" app:1 ", "/keys/cosign.pub"), vec!["verify", "--key=/keys/cosign.pub", "--output=json", "app:1"]);
    }

    #[test]
    fn a_running_container_is_judged_by_its_inspect_document() {
        let doc = json!({
            "Config": {"User": ""},
            "HostConfig": {"Privileged": true, "NetworkMode": "bridge", "Memory": 0},
            "Mounts": [{"Type": "bind", "Source": "/var/run/docker.sock", "RW": true}, {"Type": "bind", "Source": "/Users/me/.kube", "RW": false}],
            "NetworkSettings": {"Networks": {"bridge": {}, "sbx": {}}}
        });
        let facts = Facts { internal_networks: vec!["sbx".into()], latest_scan: scanned(1), ..Default::default() };
        let found = check_container_at(&strict(), &doc, &facts, Some(&home()));
        let names = rules(&found);
        for rule in ["privileged", "engineSocket", "hostMount", "rootUser", "noMemoryLimit", "noCpuLimit", "network", "criticalVulns"] {
            assert!(names.contains(&rule), "{rule} in {names:?}");
        }
        assert!(found.contains(&Violation::block("network", "bridge")));
        assert!(!found.contains(&Violation::block("network", "sbx")));
        assert!(!found.iter().any(|v| v.rule == "hostMount" && v.detail.contains("docker.sock")), "the socket is its own rule");
    }

    #[test]
    fn the_spec_document_is_what_the_hardening_rules_read() {
        let doc = spec_document(&hardened(), "");
        assert_eq!(doc["Config"]["User"], "1000:1000");
        assert_eq!(doc["HostConfig"]["Memory"], 512 * 1024 * 1024);
        assert_eq!(doc["HostConfig"]["NanoCpus"], 1_000_000_000i64);
        assert_eq!(doc["HostConfig"]["NetworkMode"], "none");
        assert_eq!(doc["Mounts"][0]["Source"], "/Users/me/code/app");
        let found: Vec<String> = hardening::audit(&doc).into_iter().map(|f| f.rule).collect();
        assert_eq!(found, vec!["noHealthcheck"], "only what a sandbox does not need");
    }

    #[test]
    fn policies_are_the_workspaces_else_the_default_else_built_in() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let first = load(&conn, "w1").unwrap();
        assert_eq!((first.source.as_str(), first.policy.clone()), ("builtIn", SecurityPolicy::default()));
        let global = SecurityPolicy { require_limits: true, ..Default::default() };
        save(&conn, "", &global).unwrap();
        let inherited = load(&conn, "w1").unwrap();
        assert_eq!((inherited.source.as_str(), inherited.policy.require_limits), ("default", true));
        let own = SecurityPolicy { require_non_root: true, ..Default::default() };
        let saved = save(&conn, "w1", &own).unwrap();
        assert_eq!((saved.source.as_str(), saved.policy.require_non_root, saved.policy.require_limits), ("own", true, false));
        assert_eq!(load(&conn, "w2").unwrap().source, "default", "another workspace still follows the default");
        assert_eq!(reset(&conn, "w1").unwrap().source, "default");
        assert_eq!(reset(&conn, "").unwrap().source, "builtIn");
        // A row from an older build without some field reads it as its default.
        conn.execute("INSERT INTO container_security_policies VALUES ('w3', '{\"requireLimits\":true}', 't')", []).unwrap();
        let old = load(&conn, "w3").unwrap().policy;
        assert!(old.require_limits && old.no_privileged, "a field it lacks takes the built-in policy's value");
    }

    #[test]
    fn the_sandbox_image_falls_back_to_the_dev_base() {
        assert_eq!(SecurityPolicy { sandbox_image: "  ".into(), ..Default::default() }.sandbox_image(), DEFAULT_SANDBOX_IMAGE);
        assert_eq!(SecurityPolicy { sandbox_image: "node:22".into(), ..Default::default() }.sandbox_image(), "node:22");
    }
}
