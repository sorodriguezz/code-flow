//! R-0001 — `@achs/env`: every environment complete and conforming to its schema, Key Vault included.
//!
//! For each env root the PR touches (the folder holding `env/settings/settings.json`, so `src/env`
//! in a monorepo works), at the PR's source commit:
//!
//! - **app-settings** — `|DEFAULT|` + `|ENV|.<env>` (+ `appsettings.<env>.json`) against the
//!   schema's `app-settings` section: missing keys, null where not nullable, wrong type, and keys the
//!   schema does not declare (a schema nobody regenerated).
//! - **Key Vault** — every environment with a `vaultUrl`: the secrets the schema's
//!   `azure-key-vault` section declares, named as `@achs/azure-key-vault` names them
//!   (`project-group-env-key`; a shared `$KEY` drops the group): missing, disabled, expired or
//!   expiring within 30 days, empty, of the wrong type, and the project-group-env secrets the schema
//!   does not declare. The token comes from `az account get-access-token`; without `az` (or a
//!   session) that environment is `not_evaluated` and the review goes on.
//!
//! **Values are read only in memory, judged and dropped**: the facts name a secret and what is
//! wrong with it, never its value. A scaffold (`package.json`'s `project` or `name` still a
//! `(((placeholder)))`) has no real environments: its root is skipped. Port of the reference tool's
//! `rules/R-0001.py`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use regex::Regex;
use serde_json::{json, Map, Value};

use super::source::{HttpError, Net};
use super::{capped, join, read_json, Facts, Rule, RuleCx, RuleMeta};

const SETTINGS_REL: &str = "env/settings/settings.json";
const SCHEMA_REL: &str = "env/settings/schema.json";
const APPSETTINGS_REL: &str = "env/appsettings.json";
const KV_PROVIDER: &str = "azure-key-vault";
const KV_API: &str = "api-version=7.4";
const JSON_CONTENT_TYPE: &str = "application/json";
const EXPIRY_WARNING_DAYS: i64 = 30;
const CONCURRENCY: usize = 8;
/// A vault with more pages than this is a vault the rule stops listing rather than loops on.
const MAX_PAGES: usize = 200;

static META: RuleMeta = RuleMeta {
    id: "R-0001",
    title: "Variables de entorno completas y conformes al schema (@achs/env + Key Vault)",
    severity: "Info",
    categories: &["env-misconfiguration"],
    paths: &["**/env/**", "**/package.json"],
    levels: &["completo", "ultra"],
    enabled: true,
    timeout_secs: 120,
    instruction: "Los hechos vienen de una herramienta que leyó la configuración @achs/env de este PR en su commit \
(env/settings/settings.json, settings/schema.json, appsettings*.json, package.json) y el Azure Key Vault de cada ambiente \
(nombres y atributos; los valores se validaron en memoria y nunca se muestran). Por cada raíz env y ambiente con un \
problema, reporta UN hallazgo: app_settings missing/null/type (claves que a ese ambiente le faltan o le llegan mal contra \
el schema), not_in_schema (claves que el schema no declara: no se regeneró con `env schema`), key_vault \
missing/disabled/expired/expiring/empty/type/json_invalid (sus secretos), orphans (secretos de ese proyecto-grupo-ambiente \
que el schema no declara) y un `schema` ausente o vacío. Nombra el ambiente, el vault y las claves en el porqué (nunca un \
valor); ánclalo en una línea cambiada de los archivos env/ de esa raíz o de su package.json en este PR. Severidad Info; \
tipo Bug cuando rompe ese ambiente (un valor faltante, vacío o con tipo incorrecto), Code Smell en \
otro caso. Un ambiente not_evaluated o values_not_evaluated: un hallazgo diciendo qué no se pudo verificar y por qué, \
severidad Info, confianza 60. Todo completo: ningún hallazgo.",
};

pub struct Env;

impl Rule for Env {
    fn meta(&self) -> &'static RuleMeta {
        &META
    }

    fn evaluate<'a>(&'a self, cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>> {
        Box::pin(collect(cx))
    }
}

// --- @achs/azure-key-vault's naming, ported (src/secret-name.ts, src/flatten.util.ts) ----------

fn key_split_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r":|--").unwrap())
}

/// A project-wide (`$`) secret: its last segment starts with `$`.
fn is_shared_key(key: &str) -> bool {
    key_split_re().split(key).last().unwrap_or("").starts_with('$')
}

/// `project-group-env-path--key`, lowercase; a shared secret drops the group.
fn to_secret_name(project: &str, group: &str, env: &str, key: &str) -> String {
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let parts: Vec<&str> = if is_shared_key(key) { vec![project, env] } else { vec![project, group, env] };
    let prefix = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let name = SPACES.get_or_init(|| Regex::new(r"[ _]+").unwrap()).replace_all(&format!("{prefix}-{key}"), "-").to_string();
    name.replace(':', "--").replace('$', "").to_lowercase()
}

fn is_object_schema(node: &Value) -> bool {
    match node.get("type") {
        Some(Value::String(t)) => t == "object",
        Some(Value::Array(ts)) => ts.iter().any(|t| t == "object"),
        _ => false,
    }
}

fn has_properties(node: &Value) -> bool {
    node.get("properties").and_then(Value::as_object).is_some_and(|p| !p.is_empty())
}

/// `{key path: leaf schema}` of a JSON-schema section, nested keys joined by `delimiter` — an object
/// with properties is walked, anything else is a leaf.
fn schema_leaves(node: &Value, delimiter: &str, prefix: &str) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (key, sub) in node.get("properties").and_then(Value::as_object).into_iter().flatten() {
        if !sub.is_object() {
            continue;
        }
        let path = format!("{prefix}{key}");
        if is_object_schema(sub) && has_properties(sub) {
            out.extend(schema_leaves(sub, delimiter, &format!("{path}{delimiter}")));
        } else {
            out.insert(path, sub.clone());
        }
    }
    out
}

fn types_of(leaf: &Value) -> Vec<String> {
    match leaf.get("type") {
        Some(Value::String(t)) => vec![t.clone()],
        Some(Value::Array(ts)) => ts.iter().filter_map(|t| t.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `null` · `empty` · `type`, or `None`, for a value against its leaf schema — never the value.
/// `empty_is_problem`: an empty string counts (a secret); in app-settings it is a valid string.
fn type_problem(value: &Value, leaf: &Value, nullable_default: bool, empty_is_problem: bool) -> Option<&'static str> {
    let nullable = leaf.get("nullable").map(truthy).unwrap_or(nullable_default);
    let types = types_of(leaf);
    if value.is_null() {
        return if nullable || types.iter().any(|t| t == "null") { None } else { Some("null") };
    }
    if value.as_str() == Some("") && empty_is_problem && !nullable {
        return Some("empty");
    }
    let test = |t: &str| -> Option<bool> {
        Some(match t {
            "string" => value.is_string(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "object" => value.is_object(),
            "array" => value.is_array(),
            "null" => value.is_null(),
            _ => return None,
        })
    };
    let known: Vec<bool> = types.iter().filter_map(|t| test(t)).collect();
    (!known.is_empty() && !known.iter().any(|ok| *ok)).then_some("type")
}

// --- app-settings ------------------------------------------------------------------------------

fn deep_merge(base: &Value, over: &Value) -> Value {
    let mut out = base.as_object().cloned().unwrap_or_default();
    for (key, value) in over.as_object().into_iter().flatten() {
        match (value, out.get(key)) {
            (Value::Object(_), Some(existing @ Value::Object(_))) => {
                let merged = deep_merge(existing, value);
                out.insert(key.clone(), merged);
            }
            _ => {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

fn leaves(doc: &Value, prefix: &str) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (key, value) in doc.as_object().into_iter().flatten() {
        if key.starts_with('$') {
            continue;
        }
        match value {
            Value::Object(o) if !o.is_empty() => out.extend(leaves(value, &format!("{prefix}{key}."))),
            _ => {
                out.insert(format!("{prefix}{key}"), value.clone());
            }
        }
    }
    out
}

fn obj<'a>(v: Option<&'a Value>) -> &'a Value {
    static EMPTY: OnceLock<Value> = OnceLock::new();
    v.filter(|v| v.is_object()).unwrap_or_else(|| EMPTY.get_or_init(|| Value::Object(Map::new())))
}

/// What `env` lacks or gets wrong against the schema's app-settings section.
fn check_app_settings(appsettings: &Value, split: &Value, schema: &Value, env: &str, nullable: bool) -> Map<String, Value> {
    let mut out = Map::new();
    let section = obj(schema.get("app-settings"));
    if !has_properties(section) {
        return out;
    }
    let merged = deep_merge(obj(appsettings.get("|DEFAULT|")), obj(obj(appsettings.get("|ENV|")).get(env)));
    let merged = deep_merge(&merged, split);
    let values = leaves(&merged, "");
    let mut in_modes: BTreeSet<String> = BTreeSet::new();
    for mode in obj(appsettings.get("|MODE|")).as_object().into_iter().flatten().map(|(_, m)| m) {
        in_modes.extend(leaves(obj(Some(mode)), "").into_keys());
    }
    let expected = schema_leaves(section, ".", "");
    let missing: Vec<String> = expected.keys().filter(|k| !values.contains_key(*k) && !in_modes.contains(*k)).cloned().collect();
    let mut problems: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (key, leaf) in &expected {
        if let Some(value) = values.get(key) {
            if let Some(kind) = type_problem(value, leaf, nullable, false) {
                problems.entry(kind).or_default().push(key.clone());
            }
        }
    }
    let undeclared: Vec<String> = values
        .keys()
        .filter(|k| !expected.contains_key(*k) && !expected.keys().any(|e| e.starts_with(&format!("{k}."))))
        .cloned()
        .collect();
    if !missing.is_empty() {
        out.insert("missing".into(), json!(capped(missing)));
    }
    for kind in ["null", "empty", "type"] {
        if let Some(keys) = problems.remove(kind) {
            out.insert(kind.into(), json!(capped(keys)));
        }
    }
    if !undeclared.is_empty() {
        out.insert("not_in_schema".into(), json!(capped(undeclared)));
    }
    out
}

// --- Key Vault ---------------------------------------------------------------------------------

fn secret_name(item: &Value) -> String {
    item.get("id").and_then(Value::as_str).unwrap_or("").trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

fn bearer(token: &str) -> Vec<(String, String)> {
    vec![("Authorization".to_string(), format!("Bearer {token}"))]
}

fn vault_reason(e: &HttpError) -> String {
    match e {
        HttpError::Status(401) => "sin autorización (token rechazado)".into(),
        other => other.reason(),
    }
}

/// `{name: attributes item}` of a vault, following `nextLink`. Names and attributes only.
async fn list_secrets(vault_url: &str, token: &str, net: &dyn Net) -> Result<BTreeMap<String, Value>, String> {
    let mut out = BTreeMap::new();
    let mut url = Some(format!("{}/secrets?{KV_API}&maxresults=25", vault_url.trim_end_matches('/')));
    let mut pages = 0usize;
    while let Some(next) = url.take() {
        pages += 1;
        if pages > MAX_PAGES {
            break;
        }
        let page = net.get_json(&next, bearer(token)).await.map_err(|e| vault_reason(&e))?;
        for item in page.get("value").and_then(Value::as_array).into_iter().flatten() {
            out.insert(secret_name(item), item.clone());
        }
        url = page.get("nextLink").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    }
    Ok(out)
}

/// What a secret's value is wrong about, the value dropped before this returns.
enum Verdict {
    Fine,
    Problem(&'static str),
    Denied(String),
}

async fn judge_secret(base: &str, name: &str, leaf: &Value, nullable: bool, token: &str, net: &dyn Net) -> Verdict {
    let url = format!("{base}/secrets/{}?{KV_API}", crate::ado::encode_segment(name));
    let secret = match net.get_json(&url, bearer(token)).await {
        Ok(s) => s,
        Err(e) => return Verdict::Denied(vault_reason(&e)),
    };
    let raw = secret.get("value").cloned().unwrap_or(Value::Null);
    let tagged_json = secret.get("contentType").and_then(Value::as_str) == Some(JSON_CONTENT_TYPE)
        || secret.get("tags").and_then(|t| t.get("serialized")).and_then(Value::as_str) == Some("1");
    // Parsed only when tagged as JSON — what @achs/azure-key-vault hands the app.
    let value = match (&raw, tagged_json) {
        (Value::String(s), true) if !s.is_empty() => match serde_json::from_str::<Value>(s) {
            Ok(parsed) => parsed,
            Err(_) => return Verdict::Problem("json_invalid"),
        },
        _ => raw,
    };
    match type_problem(&value, leaf, nullable, true) {
        Some("null") => Verdict::Problem("empty"),
        Some(kind) => Verdict::Problem(kind),
        None => Verdict::Fine,
    }
    // `value` and `secret` drop here: only the verdict leaves.
}

struct Scope {
    project: String,
    group: String,
}

/// The facts of one environment's vault. `expected` = `{key: leaf schema}`.
#[allow(clippy::too_many_arguments)]
async fn check_vault(vault_url: &str, expected: &BTreeMap<String, Value>, scope: &Scope, env: &str, nullable: bool, token: &str, net: &dyn Net, now: i64) -> Value {
    let listed = match list_secrets(vault_url, token, net).await {
        Ok(l) => l,
        Err(reason) => return json!({ "not_evaluated": format!("listar secretos: {reason}") }),
    };
    let names: BTreeMap<String, &Value> = expected.iter().map(|(k, leaf)| (to_secret_name(&scope.project, &scope.group, env, k), leaf)).collect();
    let missing: Vec<String> = names.keys().filter(|n| !listed.contains_key(*n)).cloned().collect();
    let (mut disabled, mut expired, mut expiring) = (Vec::new(), Vec::new(), Vec::new());
    for name in names.keys() {
        let Some(item) = listed.get(name) else { continue };
        let attrs = item.get("attributes");
        if attrs.and_then(|a| a.get("enabled")).and_then(Value::as_bool) == Some(false) {
            disabled.push(name.clone());
        }
        if let Some(exp) = attrs.and_then(|a| a.get("exp")).and_then(Value::as_f64) {
            let exp = exp as i64;
            if exp <= now {
                expired.push(name.clone());
            } else if exp <= now + EXPIRY_WARNING_DAYS * 86_400 {
                expiring.push(name.clone());
            }
        }
    }
    let own = to_secret_name(&scope.project, &scope.group, env, "x");
    let own_prefix = &own[..own.len() - 1];
    let orphans: Vec<String> = listed.keys().filter(|n| n.starts_with(own_prefix) && !names.contains_key(*n)).cloned().collect();

    let base = vault_url.trim_end_matches('/').to_string();
    let readable: Vec<(&String, &&Value)> = names.iter().filter(|(n, _)| listed.contains_key(*n) && !disabled.contains(n)).collect();
    // Boxed as they are built: a stream of closures over borrowed names trips the compiler's
    // higher-ranked `Send` check, and the future has to be `Send` to run on the review's task.
    let jobs: Vec<BoxFuture<'_, (String, Verdict)>> = readable
        .into_iter()
        .map(|(name, leaf)| {
            let (base, name, leaf) = (base.clone(), name.clone(), (*leaf).clone());
            Box::pin(async move {
                let verdict = judge_secret(&base, &name, &leaf, nullable, token, net).await;
                (name, verdict)
            }) as BoxFuture<'_, (String, Verdict)>
        })
        .collect();
    let verdicts: Vec<(String, Verdict)> = futures_util::stream::iter(jobs)
    .buffer_unordered(CONCURRENCY)
    .collect()
    .await;

    let mut out = Map::new();
    for (key, list) in [("missing", missing), ("disabled", disabled), ("expired", expired), ("expiring", expiring), ("orphans", orphans)] {
        if !list.is_empty() {
            out.insert(key.into(), json!(capped(list)));
        }
    }
    let mut problems: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let mut denied: Vec<String> = Vec::new();
    for (name, verdict) in verdicts {
        match verdict {
            Verdict::Fine => {}
            Verdict::Problem(kind) => problems.entry(kind).or_default().push(name),
            Verdict::Denied(reason) => denied.push(reason),
        }
    }
    for kind in ["empty", "type", "json_invalid"] {
        if let Some(list) = problems.remove(kind) {
            out.insert(kind.into(), json!(capped(list)));
        }
    }
    if !denied.is_empty() {
        let first = denied.iter().collect::<BTreeSet<_>>().into_iter().next().cloned().unwrap_or_default();
        out.insert("values_not_evaluated".into(), json!(format!("leer valores: {first} ({} secreto(s))", denied.len())));
    }
    Value::Object(out)
}

// --- per env root ------------------------------------------------------------------------------

/// The folders whose `env/` or `package.json` the PR touches (`""` = the repository root).
fn env_roots(paths: &[String]) -> Vec<String> {
    let mut roots = BTreeSet::new();
    for path in paths {
        let parts: Vec<&str> = path.split('/').collect();
        let (dirs, last) = parts.split_at(parts.len().saturating_sub(1));
        if let Some(i) = dirs.iter().position(|p| *p == "env") {
            roots.insert(parts[..i].join("/"));
        } else if last.first() == Some(&"package.json") {
            roots.insert(dirs.join("/"));
        }
    }
    roots.into_iter().collect()
}

/// `{env: vaultUrl}` of the azure-key-vault provider.
fn vault_environments(settings: &Value) -> BTreeMap<String, String> {
    for provider in settings.get("providers").and_then(Value::as_array).into_iter().flatten() {
        if provider.get("path").and_then(Value::as_str) == Some(KV_PROVIDER) {
            return provider
                .get("config")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(|(env, cfg)| cfg.get("vaultUrl").and_then(Value::as_str).map(|u| (env.clone(), u.to_string())))
                .collect();
        }
    }
    BTreeMap::new()
}

fn placeholder_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(\(\(.+?\)\)\)").unwrap())
}

/// A template: `package.json`'s `project` or `name` is still a `(((placeholder)))`.
fn is_scaffold(pkg: &Value) -> bool {
    ["project", "name"].iter().any(|k| placeholder_re().is_match(pkg.get(*k).and_then(Value::as_str).unwrap_or("")))
}

fn vault_host(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| url.to_string())
}

/// The token, asked for at most once per run and only when a vault actually needs it.
type Token = Option<Result<String, String>>;

/// The facts of one env root, or `None` when it has no @achs/env settings. A scaffold's root is
/// only `{root, scaffold: true}`: no token, no vault.
async fn check_root(root: &str, cx: &RuleCx<'_>, token: &mut Token) -> Result<Option<Value>, String> {
    let Some(settings) = read_json(cx.source, &join(root, SETTINGS_REL)).await?.filter(Value::is_object) else {
        return Ok(None);
    };
    let label = if root.is_empty() { "/".to_string() } else { root.to_string() };
    let pkg = read_json(cx.source, &join(root, "package.json")).await?.filter(Value::is_object).unwrap_or_else(|| json!({}));
    if is_scaffold(&pkg) {
        return Ok(Some(json!({ "root": label, "scaffold": true })));
    }
    let mut facts = Map::new();
    facts.insert("root".into(), json!(label));
    let schema = match read_json(cx.source, &join(root, SCHEMA_REL)).await?.filter(Value::is_object) {
        None => {
            facts.insert("schema".into(), json!("falta env/settings/schema.json (env schema -e <env> -m build)"));
            json!({})
        }
        Some(schema) => {
            if !schema.as_object().into_iter().flatten().any(|(_, v)| has_properties(v)) {
                facts.insert("schema".into(), json!("vacío: schemaValidate no valida nada y pull no trae ningún secreto"));
            }
            schema
        }
    };
    let nullable = settings.get("nullable").and_then(Value::as_bool).unwrap_or(false);
    let appsettings = read_json(cx.source, &join(root, APPSETTINGS_REL)).await?.filter(Value::is_object).unwrap_or_else(|| json!({}));
    let vaults = vault_environments(&settings);
    let mut envs: BTreeSet<String> = vaults.keys().cloned().collect();
    envs.extend(obj(appsettings.get("|ENV|")).as_object().into_iter().flatten().map(|(k, _)| k.clone()));
    static SCOPE_RE: OnceLock<Regex> = OnceLock::new();
    let scope = Scope {
        project: pkg.get("project").and_then(Value::as_str).unwrap_or("").to_string(),
        group: SCOPE_RE
            .get_or_init(|| Regex::new(r"^@[^/]+/").unwrap())
            .replace(pkg.get("name").and_then(Value::as_str).unwrap_or(""), "")
            .to_string(),
    };
    let expected = schema_leaves(obj(schema.get(KV_PROVIDER)), "--", "");
    if !vaults.is_empty() && scope.project.is_empty() {
        facts.insert("scope".into(), json!("package.json sin `project`: los nombres de secreto no se pueden armar"));
    }
    let mut environments = Map::new();
    for env in &envs {
        let mut entry = Map::new();
        let split = read_json(cx.source, &join(root, &format!("env/appsettings.{env}.json"))).await?.filter(Value::is_object).unwrap_or_else(|| json!({}));
        let app = check_app_settings(&appsettings, &split, &schema, env, nullable);
        if !app.is_empty() {
            entry.insert("app_settings".into(), Value::Object(app));
        }
        if let Some(vault_url) = vaults.get(env) {
            entry.insert("vault".into(), json!(vault_host(vault_url)));
            if !expected.is_empty() && scope.project.is_empty() {
                entry.insert("key_vault".into(), json!({ "not_evaluated": "sin project en package.json" }));
            } else if !expected.is_empty() {
                if token.is_none() {
                    *token = Some(cx.net.vault_token().await);
                }
                let kv = match token.as_ref() {
                    Some(Ok(t)) => check_vault(vault_url, &expected, &scope, env, nullable, t, cx.net, cx.now).await,
                    Some(Err(problem)) => json!({ "not_evaluated": problem }),
                    None => json!({ "not_evaluated": "sin token de Key Vault" }),
                };
                entry.insert("key_vault".into(), kv);
            }
        }
        environments.insert(env.clone(), Value::Object(entry));
    }
    facts.insert("environments".into(), Value::Object(environments));
    facts.insert("expected_secrets".into(), json!(expected.len()));
    Ok(Some(Value::Object(facts)))
}

async fn collect(cx: &RuleCx<'_>) -> Result<Facts, String> {
    let mut token: Token = None;
    let mut found = Vec::new();
    for root in env_roots(cx.matched) {
        if let Some(facts) = check_root(&root, cx, &mut token).await? {
            found.push(facts);
        }
    }
    let real: Vec<Value> = found.iter().filter(|f| f.get("scaffold").is_none()).cloned().collect();
    if real.is_empty() {
        return Ok(Facts::NotApplicable(if found.is_empty() {
            "el cambio no toca un env/ de @achs/env (sin env/settings/settings.json)".into()
        } else {
            "template/scaffold: package.json con placeholders (((...))); no hay ambientes reales que validar".into()
        }));
    }
    Ok(Facts::Found(json!({ "roots": real })))
}

#[cfg(test)]
mod tests {
    use super::super::source::fake::{FakeNet, Files};
    use super::super::PrFile;
    use super::*;

    #[test]
    fn secret_names_follow_achs_azure_key_vault() {
        assert_eq!(to_secret_name("crm", "api", "dev", "db:password"), "crm-api-dev-db--password");
        assert_eq!(to_secret_name("crm", "api", "dev", "Mail Server_Key"), "crm-api-dev-mail-server-key");
        assert_eq!(to_secret_name("crm", "api", "dev", "shared--$TOKEN"), "crm-dev-shared--token");
        assert_eq!(to_secret_name("crm", "", "qa", "x"), "crm-qa-x");
    }

    #[test]
    fn type_problems_never_carry_the_value() {
        let s = json!({ "type": "string" });
        assert_eq!(type_problem(&json!(null), &s, false, false), Some("null"));
        assert_eq!(type_problem(&json!(null), &s, true, false), None);
        assert_eq!(type_problem(&json!(""), &s, false, true), Some("empty"));
        assert_eq!(type_problem(&json!(""), &s, false, false), None);
        assert_eq!(type_problem(&json!(3), &s, false, false), Some("type"));
        assert_eq!(type_problem(&json!(3), &json!({ "type": ["integer", "null"] }), false, false), None);
        assert_eq!(type_problem(&json!(3.5), &json!({ "type": "integer" }), false, false), Some("type"));
        assert_eq!(type_problem(&json!(true), &json!({}), false, false), None);
    }

    fn schema() -> Value {
        json!({
            "app-settings": { "type": "object", "properties": {
                "PORT": { "type": "integer" },
                "API": { "type": "object", "properties": { "URL": { "type": "string" }, "TIMEOUT": { "type": "number", "nullable": true } } },
                "MODE_ONLY": { "type": "string" }
            }},
            "azure-key-vault": { "type": "object", "properties": {
                "DB": { "type": "object", "properties": { "PASSWORD": { "type": "string" } } },
                "CONFIG": { "type": "object" },
                "$SHARED": { "type": "string" }
            }}
        })
    }

    #[test]
    fn app_settings_against_the_schema() {
        let appsettings = json!({
            "|DEFAULT|": { "PORT": 3000, "API": { "URL": "http://x", "TIMEOUT": null } },
            "|ENV|": { "dev": { "PORT": "3000", "EXTRA": 1 }, "prod": { "API": { "URL": null } } },
            "|MODE|": { "debug": { "MODE_ONLY": "x" } }
        });
        let dev = check_app_settings(&appsettings, &json!({}), &schema(), "dev", false);
        assert_eq!(Value::Object(dev), json!({ "type": ["PORT"], "not_in_schema": ["EXTRA"] }));
        let prod = check_app_settings(&appsettings, &json!({ "PORT": 80 }), &schema(), "prod", false);
        assert_eq!(Value::Object(prod), json!({ "null": ["API.URL"] }));
    }

    #[test]
    fn roots_and_scaffolds() {
        let paths = vec!["src/env/settings/settings.json".to_string(), "package.json".into(), "apps/web/README.md".into()];
        assert_eq!(env_roots(&paths), ["", "src"]);
        assert!(is_scaffold(&json!({ "name": "@achs/(((app-name)))" })));
        assert!(!is_scaffold(&json!({ "name": "@achs/crm", "project": "crm" })));
    }

    fn settings() -> &'static str {
        r#"{ "providers": [ { "path": "azure-key-vault", "config": { "dev": { "vaultUrl": "https://kv-dev.vault.azure.net" } } } ] }"#
    }

    #[tokio::test]
    async fn key_vault_facts_name_secrets_and_never_values() {
        let schema_text = schema().to_string();
        let source = Files::with(&[
            ("env/settings/settings.json", settings()),
            ("env/settings/schema.json", &schema_text),
            ("env/appsettings.json", r#"{ "|DEFAULT|": { "PORT": 1, "API": { "URL": "u" }, "MODE_ONLY": "m" } }"#),
            ("package.json", r#"{ "name": "@achs/api", "project": "crm" }"#),
        ]);
        let vault = "https://kv-dev.vault.azure.net";
        let list = format!("{vault}/secrets?{KV_API}&maxresults=25");
        let now = 1_800_000_000i64;
        let net = FakeNet { token: Some("tok".into()), ..Default::default() }
            .answer(
                &list,
                Ok(json!({ "value": [
                    { "id": format!("{vault}/secrets/crm-api-dev-db--password"), "attributes": { "enabled": true, "exp": now + 86_400 } },
                    { "id": format!("{vault}/secrets/crm-api-dev-config"), "attributes": { "enabled": true } },
                    { "id": format!("{vault}/secrets/crm-api-dev-old-key"), "attributes": { "enabled": true } }
                ], "nextLink": null })),
            )
            .answer(&format!("{vault}/secrets/crm-api-dev-db--password?{KV_API}"), Ok(json!({ "value": "" })))
            .answer(&format!("{vault}/secrets/crm-api-dev-config?{KV_API}"), Ok(json!({ "value": "{not json", "contentType": "application/json" })));
        let files = [PrFile { path: "env/settings/settings.json".into(), ..Default::default() }];
        let matched = vec!["env/settings/settings.json".to_string()];
        let cx = RuleCx { matched: &matched, files: &files, source: &source, net: &net, today: chrono::NaiveDate::MIN, now };
        let Ok(Facts::Found(facts)) = collect(&cx).await else { panic!("expected facts") };
        let kv = &facts["roots"][0]["environments"]["dev"]["key_vault"];
        assert_eq!(
            kv,
            &json!({
                "missing": ["crm-dev-shared"],
                "expiring": ["crm-api-dev-db--password"],
                "orphans": ["crm-api-dev-old-key"],
                "empty": ["crm-api-dev-db--password"],
                "json_invalid": ["crm-api-dev-config"]
            })
        );
        assert_eq!(facts["roots"][0]["environments"]["dev"]["vault"], "kv-dev.vault.azure.net");
        assert!(!facts.to_string().contains("{not json"));
    }

    #[tokio::test]
    async fn no_az_is_not_evaluated_and_a_scaffold_does_not_apply() {
        let schema_text = schema().to_string();
        let source = Files::with(&[
            ("env/settings/settings.json", settings()),
            ("env/settings/schema.json", &schema_text),
            ("package.json", r#"{ "name": "@achs/api", "project": "crm" }"#),
        ]);
        let net = FakeNet::default();
        let files = [PrFile { path: "package.json".into(), ..Default::default() }];
        let matched = vec!["package.json".to_string()];
        let cx = RuleCx { matched: &matched, files: &files, source: &source, net: &net, today: chrono::NaiveDate::MIN, now: 0 };
        let Ok(Facts::Found(facts)) = collect(&cx).await else { panic!("expected facts") };
        assert_eq!(facts["roots"][0]["environments"]["dev"]["key_vault"]["not_evaluated"], "no se encontró 'az' en el PATH");

        let scaffold = Files::with(&[("env/settings/settings.json", settings()), ("package.json", r#"{ "name": "(((app-name)))" }"#)]);
        let cx = RuleCx { source: &scaffold, ..cx };
        assert!(matches!(collect(&cx).await, Ok(Facts::NotApplicable(r)) if r.starts_with("template/scaffold")));
    }
}
