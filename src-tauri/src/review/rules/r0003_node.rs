//! R-0003 — the Node.js runtime a repository declares: vulnerable or out of support.
//!
//! Runs when the PR touches where a Node version is declared: `package.json` (`engines.node`),
//! `.nvmrc`, `.node-version`, a `Dockerfile` (`FROM node:<tag>`) or an Azure pipeline
//! (`NodeTool@0 versionSpec`, `UseNode@1 version`). Each declaration is judged against Node's own
//! data — <https://nodejs.org/dist/index.json> (every release, with a `security` flag) and the
//! release schedule (each line's end of life):
//!
//! - `vulnerable` — an exact version older than its line's latest security release;
//! - `range_allows_vulnerable` — an `engines` range whose floor is older than that release;
//! - `end_of_life` — a line past its end of life: no security fixes at all.
//!
//! So a runtime CVE is caught by the data, not by a hardcoded list. Floating tags (`node:lts`,
//! `lts/*`, `node`) are skipped: they resolve at build time. Both documents are cached for the day
//! ([`super::source::RealNet`]). Port of the reference tool's `rules/R-0003.py`.

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::NaiveDate;
use futures_util::future::BoxFuture;
use regex::Regex;
use serde_json::{json, Value};

use super::{line_of, Facts, Rule, RuleCx, RuleMeta, MAX_NAMES};

pub const INDEX_URL: &str = "https://nodejs.org/dist/index.json";
pub const SCHEDULE_URL: &str = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";

static META: RuleMeta = RuleMeta {
    id: "R-0003",
    title: "Versión de Node.js vulnerable o sin soporte",
    severity: "Info",
    categories: &["vulnerable-runtime", "unsupported-runtime"],
    paths: &["**/package.json", "**/.nvmrc", "**/.node-version", "**/Dockerfile*", "**/azure-pipelines*.yml", "**/azure-pipelines*.yaml"],
    levels: &["completo", "ultra"],
    enabled: true,
    timeout_secs: 60,
    instruction: "Los hechos listan cada versión de Node.js que declara este PR (engines.node, .nvmrc, .node-version, \
FROM node:<tag>, NodeTool/UseNode) que, contra el índice de releases de nodejs.org, es vulnerable (anterior al último \
release de seguridad de su línea), cuyo rango admite versiones vulnerables (range_allows_vulnerable) o cuya línea pasó su \
fin de vida (end_of_life). UN hallazgo por declaración, anclado en su file:line si changed_in_pr es true (si no, en una \
línea cambiada de ese mismo archivo), nombrando el spec, latest_security o line_end, con el arreglo (fix) en la \
sugerencia. vulnerable y end_of_life: tipo Vulnerabilidad, severidad Info, categoría vulnerable-runtime o \
unsupported-runtime, confianza 90. range_allows_vulnerable: tipo Code Smell, severidad Info, confianza 70 (un rango no \
dice qué versión corre). Aclara que una CVE del runtime solo se corrige subiendo Node, no los paquetes npm.",
};

pub struct Node;

impl Rule for Node {
    fn meta(&self) -> &'static RuleMeta {
        &META
    }

    fn evaluate<'a>(&'a self, cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>> {
        Box::pin(collect(cx))
    }
}

type Version = (u64, u64, u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Exact,
    Range,
}

fn version_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$").unwrap())
}

/// `(kind, version)` of a Node version spec, or `None` when it floats (`lts/*`, `node`, `latest`, a
/// Docker tag without a number) or cannot be read. The lowest `||` alternative is the first, by
/// convention; a Docker tag's `-alpine`/`-slim` is not part of the version.
fn parse_spec(spec: &str) -> Option<(Kind, Version)> {
    let text = spec.trim();
    if text.is_empty() {
        return None;
    }
    let text = text.split("||").next().unwrap_or("").trim();
    let ranged = text.starts_with(['^', '~', '>']);
    let stripped = text.trim_start_matches(['^', '~', '>', '=']).trim();
    let first = stripped.split_whitespace().next().unwrap_or("");
    let first = first.split('-').next().unwrap_or("");
    let caps = version_re().captures(first)?;
    let parts: Vec<Option<&str>> = (1..=3).map(|i| caps.get(i).map(|m| m.as_str())).collect();
    let exact = parts.iter().all(|p| p.is_some_and(|s| s.chars().all(|c| c.is_ascii_digit())));
    let num = |p: Option<&str>| p.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let version = (num(parts[0]), num(parts[1]), num(parts[2]));
    Some((if exact && !ranged { Kind::Exact } else { Kind::Range }, version))
}

#[derive(Debug, Clone, PartialEq)]
struct Declaration {
    file: String,
    line: Option<usize>,
    spec: String,
    /// `engines` for package.json — the one place a range is the deployed contract rather than "the
    /// line's newest at build time".
    engines: bool,
}

fn from_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^\s*FROM\s+(?:--platform=\S+\s+)?(?:\S+/)?node:([^\s@]+)").unwrap())
}

fn task_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:NodeTool@|UseNode@)").unwrap())
}

fn pipeline_version_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r##"^\s*(?:versionSpec|version)\s*:\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$"##).unwrap())
}

/// The Node versions a file declares.
fn declarations(path: &str, text: &str) -> Vec<Declaration> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let mut out = Vec::new();
    let decl = |line: Option<usize>, spec: &str, engines: bool| Declaration { file: path.to_string(), line, spec: spec.to_string(), engines };
    if name == "package.json" {
        let spec = serde_json::from_str::<Value>(text).ok().and_then(|v| v.get("engines")?.get("node")?.as_str().map(str::to_string));
        if let Some(spec) = spec {
            out.push(decl(line_of(text, "\"node\""), &spec, true));
        }
    } else if name == ".nvmrc" || name == ".node-version" {
        if let Some((i, line)) = text.lines().enumerate().find(|(_, l)| !l.trim().is_empty() && !l.trim().starts_with('#')) {
            out.push(decl(Some(i + 1), line.trim(), false));
        }
    } else if name.to_lowercase().starts_with("dockerfile") {
        for (i, line) in text.lines().enumerate() {
            if let Some(caps) = from_re().captures(line) {
                out.push(decl(Some(i + 1), &caps[1], false));
            }
        }
    } else if name.ends_with(".yml") || name.ends_with(".yaml") {
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !task_re().is_match(line) {
                continue;
            }
            for (j, next) in lines.iter().enumerate().take((i + 8).min(lines.len())).skip(i + 1) {
                if let Some(caps) = pipeline_version_re().captures(next) {
                    out.push(decl(Some(j + 1), caps[1].trim(), false));
                    break;
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Line {
    latest: Version,
    security: Option<Version>,
}

/// `{major: newest release, newest security release}` over the stable releases of the index.
fn release_lines(index: &Value) -> HashMap<u64, Line> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^v(\d+)\.(\d+)\.(\d+)$").unwrap());
    let mut lines: HashMap<u64, Line> = HashMap::new();
    for release in index.as_array().into_iter().flatten() {
        let version = release.get("version").and_then(Value::as_str).unwrap_or("");
        let Some(caps) = re.captures(version) else { continue };
        let v: Version = (caps[1].parse().unwrap_or(0), caps[2].parse().unwrap_or(0), caps[3].parse().unwrap_or(0));
        let entry = lines.entry(v.0).or_insert(Line { latest: v, security: None });
        entry.latest = entry.latest.max(v);
        let security = release.get("security").and_then(Value::as_bool).unwrap_or(false);
        if security && entry.security.is_none_or(|s| v > s) {
            entry.security = Some(v);
        }
    }
    lines
}

fn v(n: Version) -> String {
    format!("{}.{}.{}", n.0, n.1, n.2)
}

fn date(value: Option<&Value>) -> Option<NaiveDate> {
    value.and_then(Value::as_str).and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
}

/// The declaration's issue, or `None` when it is fine (or floats).
fn judge(decl: &Declaration, lines: &HashMap<u64, Line>, schedule: &Value, today: NaiveDate) -> Option<Value> {
    let (kind, nums) = parse_spec(&decl.spec)?;
    let base = json!({ "file": decl.file, "line": decl.line, "spec": decl.spec });
    let with = |mut base: Value, extra: Value| {
        if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
            b.extend(e.clone());
        }
        base
    };
    if let Some(end) = date(schedule.get(format!("v{}", nums.0)).and_then(|l| l.get("end"))) {
        if end < today {
            let newest_lts = schedule
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(k, line)| {
                    let major: u64 = k.strip_prefix('v')?.parse().ok()?;
                    let (lts, end) = (date(line.get("lts"))?, date(line.get("end"))?);
                    (lts <= today && end >= today).then_some(major)
                })
                .max();
            let mut extra = json!({ "issue": "end_of_life", "line_end": end.format("%Y-%m-%d").to_string() });
            if let Some(n) = newest_lts {
                extra["fix"] = json!(format!("{n}.x (LTS con soporte)"));
            }
            return Some(with(base, extra));
        }
    }
    let line = lines.get(&nums.0)?;
    let security = line.security?;
    if nums >= security {
        return None;
    }
    if kind == Kind::Range && !decl.engines {
        return None; // node:24-alpine, versionSpec 22.x, an .nvmrc "24": the line's newest at build time
    }
    Some(match kind {
        Kind::Exact => with(base, json!({ "issue": "vulnerable", "latest_security": v(security), "fix": v(line.latest) })),
        Kind::Range => with(base, json!({ "issue": "range_allows_vulnerable", "latest_security": v(security), "fix": format!(">={}", v(security)) })),
    })
}

async fn collect(cx: &RuleCx<'_>) -> Result<Facts, String> {
    let mut found = Vec::new();
    for path in cx.matched {
        if let Some(text) = cx.source.read(path).await? {
            found.extend(declarations(path, &text));
        }
    }
    if found.is_empty() {
        return Ok(Facts::NotApplicable("el cambio no declara una versión de Node".into()));
    }
    let index = cx.net.get_json(INDEX_URL, Vec::new()).await.map_err(|e| format!("nodejs.org: {}", e.reason()))?;
    let lines = release_lines(&index);
    // Without the schedule only the end-of-life half is lost; the vulnerable half still stands.
    let (schedule, schedule_problem) = match cx.net.get_json(SCHEDULE_URL, Vec::new()).await {
        Ok(schedule) => (schedule, None),
        Err(e) => (Value::Null, Some(format!("calendario de releases: {}", e.reason()))),
    };
    let mut issues: Vec<Value> = found
        .iter()
        .filter_map(|d| {
            let mut issue = judge(d, &lines, &schedule, cx.today)?;
            let touched = d.line.is_some_and(|n| cx.file(&d.file).is_some_and(|f| f.touched.contains(&n)));
            issue["changed_in_pr"] = json!(touched);
            Some(issue)
        })
        .collect();
    if issues.is_empty() {
        if let Some(problem) = schedule_problem {
            return Err(problem);
        }
        return Ok(Facts::NotApplicable("las versiones de Node declaradas están al día y con soporte".into()));
    }
    issues.truncate(MAX_NAMES);
    let mut facts = json!({ "declarations": issues, "checked": found.len() });
    if let Some(problem) = schedule_problem {
        facts["end_of_life_not_evaluated"] = json!(problem);
    }
    Ok(Facts::Found(facts))
}

#[cfg(test)]
mod tests {
    use super::super::source::fake::{FakeNet, Files};
    use super::super::source::HttpError;
    use super::super::PrFile;
    use super::*;

    fn index() -> Value {
        json!([
            { "version": "v24.3.0", "security": false },
            { "version": "v24.2.1", "security": true },
            { "version": "v24.2.0", "security": false },
            { "version": "v22.20.0", "security": true },
            { "version": "v26.0.0-rc.1", "security": true },
            { "version": "v16.20.2", "security": true },
        ])
    }

    fn schedule() -> Value {
        json!({
            "v16": { "start": "2021-04-20", "lts": "2021-10-26", "end": "2023-09-11" },
            "v22": { "start": "2024-04-24", "lts": "2024-10-29", "end": "2027-04-30" },
            "v24": { "start": "2025-05-06", "lts": "2025-10-28", "end": "2028-04-30" },
        })
    }

    #[test]
    fn specs_parse_like_the_reference() {
        assert_eq!(parse_spec("20.11.1"), Some((Kind::Exact, (20, 11, 1))));
        assert_eq!(parse_spec("v20.11.1"), Some((Kind::Exact, (20, 11, 1))));
        assert_eq!(parse_spec("^24.1"), Some((Kind::Range, (24, 1, 0))));
        assert_eq!(parse_spec(">=22.1.0 <23"), Some((Kind::Range, (22, 1, 0))));
        assert_eq!(parse_spec("24-alpine"), Some((Kind::Range, (24, 0, 0))));
        assert_eq!(parse_spec("22.x"), Some((Kind::Range, (22, 0, 0))));
        assert_eq!(parse_spec("18 || 20"), Some((Kind::Range, (18, 0, 0))));
        assert_eq!(parse_spec("lts/*"), None);
        assert_eq!(parse_spec("node"), None);
        assert_eq!(parse_spec(""), None);
    }

    #[test]
    fn declarations_from_every_place_node_is_named() {
        let pkg = "{\n  \"name\": \"x\",\n  \"engines\": {\n    \"node\": \">=24.0.0\"\n  }\n}";
        assert_eq!(declarations("package.json", pkg)[0].line, Some(4));
        assert_eq!(declarations("app/.nvmrc", "# pinned\n24.2.0\n")[0].spec, "24.2.0");
        let docker = declarations("Dockerfile.prod", "FROM --platform=linux/amd64 docker.io/library/node:24.2.0-alpine AS build\nFROM nginx\n");
        assert_eq!((docker.len(), docker[0].spec.as_str(), docker[0].line), (1, "24.2.0-alpine", Some(1)));
        let yml = "steps:\n- task: NodeTool@0\n  inputs:\n    versionSpec: '22.x' # lts\n";
        assert_eq!(declarations("azure-pipelines.yml", yml)[0].spec, "22.x");
    }

    #[test]
    fn judged_against_the_release_data() {
        let lines = release_lines(&index());
        assert_eq!(lines[&24], Line { latest: (24, 3, 0), security: Some((24, 2, 1)) });
        let today = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
        let d = |spec: &str, engines: bool| Declaration { file: "f".into(), line: Some(1), spec: spec.into(), engines };
        let issue = |spec, engines| judge(&d(spec, engines), &lines, &schedule(), today).map(|v| v["issue"].as_str().unwrap().to_string());
        assert_eq!(issue("24.2.0", false).as_deref(), Some("vulnerable"));
        assert_eq!(judge(&d("24.2.0", false), &lines, &schedule(), today).unwrap()["fix"], "24.3.0");
        assert_eq!(issue("24.2.1", false), None);
        assert_eq!(issue("^24.0.0", true).as_deref(), Some("range_allows_vulnerable"));
        assert_eq!(issue("24-alpine", false), None, "a floating docker line resolves to its newest");
        let eol = judge(&d("16.20.2", false), &lines, &schedule(), today).unwrap();
        assert_eq!((eol["issue"].as_str(), eol["fix"].as_str()), (Some("end_of_life"), Some("24.x (LTS con soporte)")));
    }

    #[tokio::test]
    async fn the_rule_end_to_end_offline() {
        let files = [PrFile { path: ".nvmrc".into(), added: false, touched: [1].into() }];
        let source = Files::with(&[(".nvmrc", "24.2.0\n")]);
        let net = FakeNet::default().answer(INDEX_URL, Ok(index())).answer(SCHEDULE_URL, Ok(schedule()));
        let matched = vec![".nvmrc".to_string()];
        let cx = RuleCx { matched: &matched, files: &files, source: &source, net: &net, today: NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(), now: 0 };
        let Ok(Facts::Found(facts)) = collect(&cx).await else { panic!("expected facts") };
        assert_eq!(facts["declarations"][0]["issue"], "vulnerable");
        assert_eq!(facts["declarations"][0]["changed_in_pr"], true);

        let offline = FakeNet::default().answer(INDEX_URL, Err(HttpError::Unreachable));
        let cx = RuleCx { net: &offline, ..cx };
        assert_eq!(collect(&cx).await.err().as_deref(), Some("nodejs.org: no se pudo conectar"));
    }
}
