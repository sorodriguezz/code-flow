//! What a repository offers to draw, for the dialog that asks what a diagram should be *about*.
//!
//! A sequence of "the API" is not a diagram — a sequence of `POST /orders` is — and nobody should have
//! to remember the route to ask for it. So each diagram type that needs a subject lists the ones the
//! working tree already names:
//!
//! - **sequence**: the HTTP routes (NestJS, Express and its cousins, FastAPI, Flask, Spring, Go,
//!   axum, actix, Next.js route files, Laravel);
//! - **lifecycle**: the enums, unions and state machines whose name says a *status* or a *state*;
//! - **workflow**: CI workflows, the scripts and make targets a project is run by, and the classes
//!   and functions named after a process (checkout, onboarding, release…);
//! - **dataflow**: the entities — ORM models, Prisma models, `CREATE TABLE`s.
//!
//! An architecture needs no subject and gets no list.
//!
//! **Detection by pattern, not by parsing**, like the code map's own import edges: a regular expression
//! per framework over the files that could hold it. It misses what is registered dynamically and may
//! name a route a test double declares, which is why the list is *offered* — one click or ignored,
//! never assumed — and why test files and vendored code are skipped. Bounded by files, bytes and time,
//! so a monorepo costs a fraction of a second rather than a wait.

use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Serialize;

/// One thing the repository offers to draw.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Suggestion {
    /// What the chip says: `POST /orders`, `OrderStatus`, `npm run release`.
    pub label: String,
    /// Where it was found.
    pub hint: String,
    /// What is handed to the engine as the subject.
    pub value: String,
}

const MAX_FILE_BYTES: u64 = 400 * 1024;
const MAX_FILES: usize = 6_000;
const BUDGET: Duration = Duration::from_millis(1_800);
const MAX_ROUTES: usize = 24;
const MAX_OTHERS: usize = 16;

/// A path that is not the repository's own behaviour: tests, fixtures, vendored and built code.
fn skipped(path: &str) -> bool {
    static NOISE: OnceLock<Regex> = OnceLock::new();
    NOISE
        .get_or_init(|| {
            Regex::new(
                r"(?i)(^|/)(node_modules|vendor|dist|build|target|\.next|\.git|coverage|__pycache__|venv|\.venv|tests?|__tests__|specs?|e2e|fixtures?|mocks?|examples?|docs?)(/|$)|\.(test|spec)\.|\.min\.|_test\.(go|py)$",
            )
            .unwrap()
        })
        .is_match(path)
}

fn files(root: &str) -> Vec<String> {
    let path = Path::new(root);
    let listed = if path.join(".git").exists() {
        crate::search::list_files(root).unwrap_or_default()
    } else {
        crate::local_agent::tools::plain_walk(path, MAX_FILES)
    };
    let mut out: Vec<String> = listed.into_iter().filter(|p| !skipped(p)).take(MAX_FILES).collect();
    // A workflow lives in a hidden folder, which a plain walk of a tree without git passes over.
    if let Ok(entries) = std::fs::read_dir(path.join(".github/workflows")) {
        for entry in entries.flatten() {
            let rel = format!(".github/workflows/{}", entry.file_name().to_string_lossy());
            if !out.contains(&rel) {
                out.push(rel);
            }
        }
    }
    out
}

fn read(root: &str, rel: &str) -> Option<String> {
    let full = Path::new(root).join(rel);
    let meta = std::fs::metadata(&full).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(full).ok()
}

fn ext(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or("")
}

/// Compiles a pattern once, for the life of the process.
macro_rules! re {
    ($pattern:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        CELL.get_or_init(|| Regex::new($pattern).unwrap())
    }};
}

// ---------------------------------------------------------------------------------------------
// sequence: HTTP routes
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Route {
    method: String,
    path: String,
    file: String,
}

fn join_path(prefix: &str, path: &str) -> String {
    let mut out = String::from("/");
    for part in prefix.split('/').chain(path.split('/')) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if !out.ends_with('/') {
            out.push('/');
        }
        out.push_str(part);
    }
    out
}

fn route(found: &mut Vec<Route>, method: &str, path: &str, file: &str) {
    let path = join_path("", path);
    if path.len() > 90 {
        return;
    }
    found.push(Route { method: method.to_uppercase(), path, file: file.to_string() });
}

/// A Next.js route file's URL: the folders under `app/` (or `pages/api`), groups dropped, `[id]` as `:id`.
fn next_route(path: &str) -> Option<String> {
    let after = if let Some(at) = path.find("app/") {
        &path[at + 4..]
    } else if let Some(at) = path.find("pages/") {
        &path[at + 6..]
    } else {
        return None;
    };
    let folder = after.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let url: Vec<String> = folder
        .split('/')
        .filter(|segment| !segment.is_empty() && !(segment.starts_with('(') && segment.ends_with(')')))
        .map(|segment| match segment.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            Some(name) => format!(":{}", name.trim_start_matches("...")),
            None => segment.to_string(),
        })
        .collect();
    Some(join_path("", &url.join("/")))
}

fn routes_in(rel: &str, text: &str, found: &mut Vec<Route>) {
    let language = ext(rel);
    // Next.js: the file *is* the route, and its exports are the methods.
    if matches!(language, "ts" | "js" | "tsx" | "jsx" | "mjs") {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if name.starts_with("route.") && rel.contains("app/") {
            if let Some(url) = next_route(rel) {
                for m in re!(r"export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b").captures_iter(text) {
                    route(found, &m[1], &url, rel);
                }
            }
        } else if rel.contains("pages/api/") {
            if let Some(url) = next_route(rel) {
                let url = if url.starts_with("/api") { url } else { join_path("/api", &url) };
                route(found, "ANY", &url, rel);
            }
        }
    }

    match language {
        "ts" | "js" | "mjs" | "cjs" | "tsx" | "jsx" => {
            // NestJS: a controller's prefix and each decorated method.
            if let Some(controller) = re!(r#"@Controller\(\s*(?:['"`]([^'"`]*)['"`])?"#).captures(text) {
                let prefix = controller.get(1).map_or("", |m| m.as_str());
                for m in re!(r#"@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)"#).captures_iter(text) {
                    route(found, &m[1], &join_path(prefix, m.get(2).map_or("", |p| p.as_str())), rel);
                }
            }
            // Express, Fastify, Koa, Hono and the like.
            for m in re!(r#"\b(?:app|router|server|api|fastify|route|routes|r)\.(get|post|put|patch|delete)\(\s*['"`](/[^'"`]*)['"`]"#).captures_iter(text) {
                route(found, &m[1], &m[2], rel);
            }
        }
        "py" => {
            for m in re!(r#"@\w+\.(get|post|put|patch|delete)\(\s*['"](/[^'"]*)['"]"#).captures_iter(text) {
                route(found, &m[1], &m[2], rel);
            }
            for m in re!(r#"@\w+\.route\(\s*['"](/[^'"]*)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?"#).captures_iter(text) {
                let methods = m.get(2).map_or(String::new(), |g| g.as_str().replace(['"', '\'', ' '], ""));
                let first = methods.split(',').next().filter(|s| !s.is_empty()).unwrap_or("GET");
                route(found, first, &m[1], rel);
            }
        }
        "java" | "kt" => {
            let prefix = re!(r#"@RequestMapping\(\s*(?:value\s*=\s*)?\{?\s*"([^"]*)""#).captures(text).map_or(String::new(), |m| m[1].to_string());
            for m in re!(r#"@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)""#).captures_iter(text) {
                route(found, &m[1], &join_path(&prefix, &m[2]), rel);
            }
        }
        "go" => {
            for m in re!(r#"\.(GET|POST|PUT|PATCH|DELETE)\(\s*"(/[^"]*)""#).captures_iter(text) {
                route(found, &m[1], &m[2], rel);
            }
            for m in re!(r#"Handle(?:Func)?\(\s*"(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(/[^"]*)""#).captures_iter(text) {
                route(found, m.get(1).map_or("ANY", |g| g.as_str()), &m[2], rel);
            }
        }
        "rs" => {
            for m in re!(r#"\.route\(\s*"(/[^"]*)"\s*,\s*(get|post|put|patch|delete)\b"#).captures_iter(text) {
                route(found, &m[2], &m[1], rel);
            }
            for m in re!(r#"#\[(get|post|put|patch|delete)\(\s*"(/[^"]*)""#).captures_iter(text) {
                route(found, &m[1], &m[2], rel);
            }
        }
        "php" => {
            for m in re!(r#"Route::(get|post|put|patch|delete)\(\s*['"]/?([^'"]*)['"]"#).captures_iter(text) {
                route(found, &m[1], &m[2], rel);
            }
        }
        "rb" => {
            for m in re!(r#"^\s*(get|post|put|patch|delete)\s+['"]/?([^'"]*)['"]"#).captures_iter(text) {
                route(found, &m[1], &m[2], rel);
            }
        }
        _ => {}
    }
}

/// The routes worth offering first: the ones that change something, then the rest, shortest paths
/// leading, and the ones every service has (health checks) last.
fn rank_routes(mut found: Vec<Route>) -> Vec<Route> {
    let mut seen = HashSet::new();
    found.retain(|r| seen.insert(format!("{} {}", r.method, r.path)));
    let boring = |r: &Route| {
        let p = r.path.to_lowercase();
        ["/health", "/healthz", "/ping", "/metrics", "/favicon", "/ready", "/live", "/status", "/version"]
            .iter()
            .any(|b| p == *b || p.starts_with(&format!("{b}/")))
    };
    let weight = |r: &Route| {
        let method = match r.method.as_str() {
            "POST" => 0,
            "PUT" | "PATCH" | "DELETE" => 1,
            "ANY" => 2,
            _ => 3,
        };
        (boring(r) as u8, method, r.path.matches('/').count())
    };
    found.sort_by_key(|r| (weight(r), r.path.clone()));
    found
}

// ---------------------------------------------------------------------------------------------
// lifecycle: status and state types
// ---------------------------------------------------------------------------------------------

fn named_like_a_state(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["status", "state", "phase", "stage", "lifecycle", "estado"].iter().any(|w| lower.contains(w))
}

fn too_generic(name: &str) -> bool {
    matches!(name.to_lowercase().as_str(), "status" | "state" | "phase" | "stage" | "estado" | "loadingstate" | "uistate" | "appstate")
}

fn state(found: &mut Vec<Suggestion>, rel: &str, name: &str) {
    if named_like_a_state(name) && name.len() > 3 {
        found.push(Suggestion { label: name.to_string(), hint: rel.to_string(), value: format!("{name} ({rel})") });
    }
}

fn states_in(rel: &str, text: &str, found: &mut Vec<Suggestion>) {
    match ext(rel) {
        "ts" | "tsx" | "js" | "jsx" | "mjs" => {
            for m in re!(r"\benum\s+(\w+)").captures_iter(text) {
                state(found, rel, &m[1]);
            }
            for m in re!(r#"\btype\s+(\w+)\s*=\s*['"]"#).captures_iter(text) {
                state(found, rel, &m[1]);
            }
            for m in re!(r"export\s+const\s+(\w+)\s*=\s*\{").captures_iter(text) {
                state(found, rel, &m[1]);
            }
            for m in re!(r#"createMachine\(\s*\{\s*(?:id:\s*['"]([^'"]+)['"])?"#).captures_iter(text) {
                if let Some(id) = m.get(1) {
                    found.push(Suggestion { label: format!("{} (xstate)", id.as_str()), hint: rel.to_string(), value: format!("{} ({rel})", id.as_str()) });
                }
            }
        }
        "py" => {
            for m in re!(r"class\s+(\w+)\((?:[\w.]*\s*,\s*)?(?:[\w.]*)?(?:Enum|StrEnum|IntEnum|TextChoices|IntegerChoices)\)").captures_iter(text) {
                state(found, rel, &m[1]);
            }
        }
        "java" | "kt" | "cs" | "swift" => {
            for m in re!(r"\benum\s+(?:class\s+)?(\w+)").captures_iter(text) {
                state(found, rel, &m[1]);
            }
        }
        "rs" => {
            for m in re!(r"\benum\s+(\w+)").captures_iter(text) {
                state(found, rel, &m[1]);
            }
        }
        "go" => {
            for m in re!(r"\btype\s+(\w+)\s+(?:string|int|uint|int32|uint8)\b").captures_iter(text) {
                state(found, rel, &m[1]);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------------------------
// workflow: processes
// ---------------------------------------------------------------------------------------------

fn processes_in(rel: &str, text: &str, found: &mut Vec<Suggestion>) {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if rel.starts_with(".github/workflows/") && (name.ends_with(".yml") || name.ends_with(".yaml")) {
        let title = re!(r#"(?m)^name:\s*['"]?([^'"\n#]+?)['"]?\s*$"#).captures(text).map_or(name.to_string(), |m| m[1].trim().to_string());
        found.push(Suggestion { label: format!("CI: {title}"), hint: rel.to_string(), value: format!("el workflow de CI \"{title}\" ({rel})") });
        return;
    }
    if name == "package.json" && !rel.contains('/') {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
            if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                for key in scripts.keys() {
                    let lower = key.to_lowercase();
                    if ["build", "release", "deploy", "publish", "migrate", "seed", "ci", "start", "package", "bundle"].iter().any(|w| lower.starts_with(w)) {
                        found.push(Suggestion { label: format!("npm run {key}"), hint: rel.to_string(), value: format!("el proceso de \"npm run {key}\" (package.json)") });
                    }
                }
            }
        }
        return;
    }
    if matches!(name, "Makefile" | "makefile" | "Justfile" | "justfile") {
        for m in re!(r"(?m)^([A-Za-z][\w-]*)\s*:(?:[^=]|$)").captures_iter(text) {
            let target = &m[1];
            if ["all", "build", "release", "deploy", "publish", "install", "test", "ci", "migrate", "package", "docker"].iter().any(|w| target.starts_with(w)) {
                found.push(Suggestion { label: format!("{} {}", if name.to_lowercase() == "makefile" { "make" } else { "just" }, target), hint: rel.to_string(), value: format!("el proceso de \"{target}\" ({rel})") });
            }
        }
        return;
    }
    if matches!(ext(rel), "ts" | "tsx" | "js" | "py" | "java" | "kt" | "go" | "rs" | "rb" | "php" | "cs") {
        for m in re!(r"\b(?:class|function|def|fn|func)\s+(\w*(?:Checkout|Onboarding|Signup|SignUp|Register|Payment|Billing|Invoice|Import|Export|Sync|Release|Deploy|Migration|Fulfil+ment|Subscription|Refund)\w*)").captures_iter(text) {
            found.push(Suggestion { label: m[1].to_string(), hint: rel.to_string(), value: format!("{} ({rel})", &m[1]) });
        }
    }
}

// ---------------------------------------------------------------------------------------------
// dataflow: entities
// ---------------------------------------------------------------------------------------------

fn entities_in(rel: &str, text: &str, found: &mut Vec<Suggestion>) {
    let mut add = |name: &str| {
        if name.len() > 2 {
            found.push(Suggestion { label: name.to_string(), hint: rel.to_string(), value: format!("los datos de {name} ({rel})") });
        }
    };
    match ext(rel) {
        "prisma" => {
            for m in re!(r"(?m)^model\s+(\w+)\s*\{").captures_iter(text) {
                add(&m[1]);
            }
        }
        "sql" => {
            for m in re!(r#"(?i)create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[\w"`\[\]]+\.)?["`\[]?(\w+)"#).captures_iter(text) {
                add(&m[1]);
            }
        }
        "ts" | "js" | "mjs" => {
            for m in re!(r"@Entity\([^)]*\)\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)").captures_iter(text) {
                add(&m[1]);
            }
            for m in re!(r#"mongoose\.model(?:<[^>]*>)?\(\s*['"](\w+)['"]"#).captures_iter(text) {
                add(&m[1]);
            }
            for m in re!(r#"sequelize\.define\(\s*['"](\w+)['"]"#).captures_iter(text) {
                add(&m[1]);
            }
        }
        "py" => {
            for m in re!(r"class\s+(\w+)\((?:models\.Model|db\.Model|Base|SQLModel|DeclarativeBase)\b[^)]*\)").captures_iter(text) {
                add(&m[1]);
            }
        }
        "java" | "kt" => {
            for m in re!(r"@Entity\b[^{;]*?\bclass\s+(\w+)").captures_iter(text) {
                add(&m[1]);
            }
        }
        "rb" => {
            for m in re!(r"class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)").captures_iter(text) {
                add(&m[1]);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------------------------

/// The subjects the repository offers for a diagram of `kind` — empty for an architecture, and for
/// a kind it does not know.
pub fn suggestions(root: &str, kind: &str) -> Vec<Suggestion> {
    if !matches!(kind, "sequence" | "lifecycle" | "workflow" | "dataflow") {
        return Vec::new();
    }
    let started = Instant::now();
    let mut routes = Vec::new();
    let mut others: Vec<Suggestion> = Vec::new();
    for rel in files(root) {
        if started.elapsed() > BUDGET {
            break;
        }
        let relevant = match kind {
            "sequence" => matches!(ext(&rel), "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "java" | "kt" | "go" | "rs" | "php" | "rb"),
            "lifecycle" => matches!(ext(&rel), "ts" | "tsx" | "js" | "jsx" | "mjs" | "py" | "java" | "kt" | "cs" | "swift" | "rs" | "go"),
            "workflow" => {
                let name = rel.rsplit('/').next().unwrap_or(&rel);
                rel.starts_with(".github/workflows/")
                    || matches!(name, "package.json" | "Makefile" | "makefile" | "Justfile" | "justfile")
                    || matches!(ext(&rel), "ts" | "tsx" | "js" | "py" | "java" | "kt" | "go" | "rs" | "rb" | "php" | "cs")
            }
            _ => matches!(ext(&rel), "prisma" | "sql" | "ts" | "js" | "mjs" | "py" | "java" | "kt" | "rb"),
        };
        // `.github/` is hidden but is exactly where a workflow lives; `skipped` does not touch it.
        if !relevant {
            continue;
        }
        let Some(text) = read(root, &rel) else { continue };
        match kind {
            "sequence" => routes_in(&rel, &text, &mut routes),
            "lifecycle" => states_in(&rel, &text, &mut others),
            "workflow" => processes_in(&rel, &text, &mut others),
            _ => entities_in(&rel, &text, &mut others),
        }
    }

    if kind == "sequence" {
        return rank_routes(routes)
            .into_iter()
            .take(MAX_ROUTES)
            .map(|r| Suggestion { label: format!("{} {}", r.method, r.path), hint: r.file, value: format!("{} {}", r.method, r.path).replace("ANY ", "") })
            .collect();
    }
    let mut seen = HashSet::new();
    others.retain(|s| seen.insert(s.label.clone()));
    // Specific names before the bare `Status`; the rest in the order the tree lists them.
    others.sort_by_key(|s| too_generic(&s.label));
    others.truncate(MAX_OTHERS);
    others
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(files: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("cf-suggest-{}", uuid::Uuid::new_v4()));
        for (path, text) in files {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
        }
        root
    }

    fn labels(root: &std::path::Path, kind: &str) -> Vec<String> {
        suggestions(root.to_str().unwrap(), kind).into_iter().map(|s| s.label).collect()
    }

    #[test]
    fn an_architecture_gets_no_list() {
        let root = tree(&[("src/a.ts", "app.get('/x', h)")]);
        assert!(suggestions(root.to_str().unwrap(), "architecture").is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn routes_are_found_in_each_framework_and_the_ones_that_change_something_lead() {
        let root = tree(&[
            ("src/orders.controller.ts", "@Controller('orders')\nexport class C {\n  @Get(':id') one() {}\n  @Post() create() {}\n  @Delete(':id') remove() {}\n}"),
            ("src/server.js", "app.get('/health', ok);\nrouter.post(\"/login\", login);\nfastify.put('/users/:id', u);"),
            ("api/main.py", "@app.get(\"/items\")\n@router.post(\"/items\")\n@bp.route('/legacy', methods=['PUT', 'GET'])"),
            ("src/main/java/Api.java", "@RequestMapping(\"/v1/pets\")\nclass Api {\n  @GetMapping(\"/{id}\") void a() {}\n  @PostMapping(\"\") void b() {}\n}"),
            ("cmd/main.go", "r.GET(\"/ping\", p)\nmux.HandleFunc(\"POST /orders/refund\", f)"),
            ("src/lib.rs", ".route(\"/api/jobs\", post(create))\n#[get(\"/api/jobs/{id}\")]"),
            ("src/app/api/users/[id]/route.ts", "export async function GET() {}\nexport async function PATCH() {}"),
            ("tests/api.test.ts", "app.post('/only-in-a-test', h)"),
            ("node_modules/x/index.js", "app.post('/vendored', h)"),
        ]);
        let found = labels(&root, "sequence");
        for expected in [
            "POST /orders", "GET /orders/:id", "DELETE /orders/:id", "POST /login", "PUT /users/:id", "POST /items", "GET /items",
            "PUT /legacy", "POST /v1/pets", "GET /v1/pets/{id}", "POST /orders/refund", "POST /api/jobs", "GET /api/jobs/{id}",
            "GET /api/users/:id", "PATCH /api/users/:id",
        ] {
            assert!(found.contains(&expected.to_string()), "{expected} in {found:?}");
        }
        assert!(!found.iter().any(|l| l.contains("only-in-a-test") || l.contains("vendored")), "{found:?}");
        // Mutating first, the health check and the ping last.
        let at = |label: &str| found.iter().position(|l| l == label).unwrap();
        assert!(at("POST /login") < at("GET /items"));
        assert!(at("GET /items") < at("GET /health"));
        assert!(at("GET /health") > at("GET /orders/:id"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_route_declared_twice_is_offered_once() {
        let root = tree(&[("a.js", "app.post('/x', a);"), ("b.js", "router.post('/x', b);")]);
        assert_eq!(labels(&root, "sequence"), vec!["POST /x"]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn state_types_are_found_by_what_their_name_says() {
        let root = tree(&[
            ("src/order.ts", "export enum OrderStatus { New, Paid }\ntype JobState = 'queued' | 'done';\nenum Color { Red }"),
            ("app/models.py", "class SubscriptionStatus(str, Enum):\n    ACTIVE = 'a'\nclass Plan(Enum):\n    A = 1"),
            ("src/main/Ticket.java", "public enum TicketPhase { OPEN, CLOSED }"),
            ("src/lib.rs", "pub enum SyncState { Idle, Running }"),
            ("pkg/job.go", "type JobStage int"),
            ("src/status.ts", "enum Status { A }"),
        ]);
        let found = labels(&root, "lifecycle");
        for expected in ["OrderStatus", "JobState", "SubscriptionStatus", "TicketPhase", "SyncState", "JobStage"] {
            assert!(found.contains(&expected.to_string()), "{expected} in {found:?}");
        }
        assert!(!found.contains(&"Color".to_string()) && !found.contains(&"Plan".to_string()));
        // The bare `Status` is last, not lost.
        assert_eq!(found.last().map(String::as_str), Some("Status"));
        let hit = suggestions(root.to_str().unwrap(), "lifecycle").into_iter().find(|s| s.label == "OrderStatus").unwrap();
        assert_eq!(hit.hint, "src/order.ts");
        assert_eq!(hit.value, "OrderStatus (src/order.ts)");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn processes_come_from_ci_scripts_targets_and_names() {
        let root = tree(&[
            (".github/workflows/release.yml", "name: Release pipeline\non: push\n"),
            ("package.json", "{\"scripts\":{\"build\":\"x\",\"lint\":\"y\",\"release\":\"z\"}}"),
            ("Makefile", "all: build\nbuild:\n\tcc\nclean:\n\trm\n"),
            ("src/billing.ts", "export class CheckoutService {}\nfunction renderButton() {}"),
        ]);
        let found = labels(&root, "workflow");
        for expected in ["CI: Release pipeline", "npm run build", "npm run release", "make all", "make build", "CheckoutService"] {
            assert!(found.contains(&expected.to_string()), "{expected} in {found:?}");
        }
        assert!(!found.contains(&"npm run lint".to_string()) && !found.contains(&"make clean".to_string()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn entities_come_from_orm_models_and_ddl() {
        let root = tree(&[
            ("prisma/schema.prisma", "model User {\n  id Int\n}\nmodel Order {\n  id Int\n}"),
            ("db/schema.sql", "CREATE TABLE IF NOT EXISTS public.invoices (id int);\ncreate table \"payments\" (id int);"),
            ("src/user.entity.ts", "@Entity('users')\nexport class UserEntity {}"),
            ("app/models.py", "class Product(models.Model):\n    pass\nclass Base2(object):\n    pass"),
            ("src/main/Pet.java", "@Entity\npublic class Pet {}"),
        ]);
        let found = labels(&root, "dataflow");
        for expected in ["User", "Order", "invoices", "payments", "UserEntity", "Product", "Pet"] {
            assert!(found.contains(&expected.to_string()), "{expected} in {found:?}");
        }
        assert!(!found.contains(&"Base2".to_string()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_folder_with_nothing_to_offer_offers_nothing() {
        let root = tree(&[("README.md", "hello")]);
        for kind in ["sequence", "lifecycle", "workflow", "dataflow"] {
            assert!(labels(&root, kind).is_empty(), "{kind}");
        }
        std::fs::remove_dir_all(&root).ok();
    }
}
