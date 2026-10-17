//! «Endpoints del repositorio»: the HTTP routes a repository's code declares, found by reading its
//! source — so a collection can be started from the server being written instead of typed by hand.
//!
//! Pattern matching, not compilation: each framework's way of declaring a route is a recognisable
//! shape (`app.get('/x'`, `@GetMapping("/x")`, `[HttpGet("x")]`, `@router.post("/x")`…), and a
//! class-level prefix (`@Controller('users')`, `@RequestMapping("/api")`, `[Route("api/[controller]")]`,
//! `APIRouter(prefix=…)`) is joined onto the routes under it. What cannot be seen from one file — a
//! router mounted under a prefix somewhere else — is not guessed: the route comes out as declared.
//!
//! Parameters come out in this app's own syntax, `:name`, whatever the framework wrote
//! (`{id}`, `<int:id>`, `{id:int}`), so the request's path-variable table fills itself in.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

/// Files larger than this are not read: no hand-written router is this big.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// At most this many routes are reported.
const MAX_ROUTES: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHit {
    pub method: String,
    /// Starts with `/`; parameters as `:name`.
    pub path: String,
    /// Repo-relative, with `/`.
    pub file: String,
    /// 1-based.
    pub line: u32,
    pub framework: String,
}

/// Every route declared under `root`, in file order. `files` is the repo-relative list to read
/// (what git tracks and does not ignore).
pub fn scan(root: &Path, files: &[String]) -> Vec<RouteHit> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for rel in files {
        if out.len() >= MAX_ROUTES {
            break;
        }
        // `plain_walk` on Windows answers with `\`; every check below reads `/`.
        let rel = &rel.replace('\\', "/");
        if !worth_reading(rel) {
            continue;
        }
        let full = root.join(rel);
        if std::fs::metadata(&full).map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&full) else { continue };
        for hit in scan_text(rel, &text) {
            if seen.insert((hit.method.clone(), hit.path.clone(), hit.file.clone())) {
                out.push(hit);
            }
        }
    }
    out.truncate(MAX_ROUTES);
    out
}

fn worth_reading(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    if !matches!(ext, "js" | "mjs" | "cjs" | "ts" | "mts" | "jsx" | "tsx" | "py" | "java" | "kt" | "cs" | "go" | "php" | "rb" | "rs") {
        return false;
    }
    // Tests declare routes against mocks; what they serve is not the service.
    let tested = lower.contains(".test.") || lower.contains(".spec.") || lower.contains("__tests__/") || lower.contains("_test.go");
    let generated = lower.contains(".min.") || lower.contains("/dist/") || lower.contains("/build/") || lower.contains("node_modules/");
    !tested && !generated
}

/// The routes one file declares.
pub fn scan_text(rel: &str, text: &str) -> Vec<RouteHit> {
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mut hits = Vec::new();
    match ext.as_str() {
        "js" | "mjs" | "cjs" | "ts" | "mts" | "jsx" | "tsx" => {
            nest(rel, text, &mut hits);
            express(rel, text, &mut hits);
        }
        "py" => {
            fastapi(rel, text, &mut hits);
            flask(rel, text, &mut hits);
            if rel.ends_with("urls.py") {
                django(rel, text, &mut hits);
            }
        }
        "java" | "kt" => spring(rel, text, &mut hits),
        "cs" => aspnet(rel, text, &mut hits),
        "go" => go(rel, text, &mut hits),
        "php" => laravel(rel, text, &mut hits),
        "rb" if rel.ends_with("routes.rb") => rails(rel, text, &mut hits),
        "rs" => rust(rel, text, &mut hits),
        _ => {}
    }
    hits.sort_by_key(|hit| hit.line);
    hits
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("route pattern"))
}

fn line_of(text: &str, offset: usize) -> u32 {
    text[..offset.min(text.len())].bytes().filter(|b| *b == b'\n').count() as u32 + 1
}

fn push(out: &mut Vec<RouteHit>, rel: &str, text: &str, offset: usize, method: &str, path: &str, framework: &str) {
    out.push(RouteHit {
        method: method.to_ascii_uppercase(),
        path: normalize(path),
        file: rel.replace('\\', "/"),
        line: line_of(text, offset),
        framework: framework.to_string(),
    });
}

/// Joins a prefix and a route the way the frameworks do: one `/` between them, none doubled.
fn join(prefix: &str, path: &str) -> String {
    let prefix = prefix.trim().trim_end_matches('/');
    let path = path.trim().trim_start_matches('/');
    match (prefix.is_empty(), path.is_empty()) {
        (true, true) => "/".into(),
        (true, false) => format!("/{path}"),
        (false, true) => prefix.to_string(),
        (false, false) => format!("{prefix}/{path}"),
    }
}

/// `{id}`, `{id:int}`, `<int:id>`, `<id>` → `:id`; a leading `/` always.
fn normalize(path: &str) -> String {
    static BRACES: OnceLock<Regex> = OnceLock::new();
    static ANGLES: OnceLock<Regex> = OnceLock::new();
    let braces = re(&BRACES, r"\{\*?([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\??\}");
    let angles = re(&ANGLES, r"<(?:[A-Za-z_]+:)?([A-Za-z_][A-Za-z0-9_]*)>");
    let path = braces.replace_all(path.trim(), ":$1");
    let path = angles.replace_all(&path, ":$1");
    let path = path.trim_start_matches('^').trim_end_matches('$');
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

/// The last prefix declared before `offset`, from `(offset, prefix)` pairs in file order.
fn prefix_before(prefixes: &[(usize, String)], offset: usize) -> &str {
    prefixes.iter().rev().find(|(at, _)| *at < offset).map(|(_, p)| p.as_str()).unwrap_or("")
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------

/// Express, Koa-router, Fastify, Hono: `<router>.get('/path'`. Only receivers named like a server
/// (`app`, `router`, `userRouter`, `server`, `fastify`, `hono`, `routes`) — `axios.get('/x')` and
/// `api.get('/x')` are a client calling out, not a server declaring.
fn express(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static CALL: OnceLock<Regex> = OnceLock::new();
    let call = re(
        &CALL,
        r#"(?i)\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])(/[^'"`]*)['"`]"#,
    );
    for caps in call.captures_iter(text) {
        let receiver = caps[1].to_ascii_lowercase();
        let server = receiver == "app"
            || receiver.ends_with("router")
            || receiver.ends_with("routes")
            || receiver == "route"
            || receiver == "server"
            || receiver == "fastify"
            || receiver == "hono"
            || receiver == "api" && text.contains("new Hono");
        if !server || caps[4].contains("${") {
            continue;
        }
        let method = if caps[2].eq_ignore_ascii_case("all") { "GET" } else { &caps[2] };
        push(out, rel, text, caps.get(0).unwrap().start(), method, &caps[4], "Express");
    }
}

/// NestJS: `@Controller('users')` over `@Get(':id')`.
fn nest(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static CONTROLLER: OnceLock<Regex> = OnceLock::new();
    static ROUTE: OnceLock<Regex> = OnceLock::new();
    let controller = re(&CONTROLLER, r#"@Controller\(\s*(?:\{[^}]*path\s*:\s*)?(?:['"`]([^'"`]*)['"`])?"#);
    let route = re(&ROUTE, r#"@(Get|Post|Put|Patch|Delete|Options|Head|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)"#);
    let prefixes: Vec<(usize, String)> = controller
        .captures_iter(text)
        .map(|c| (c.get(0).unwrap().start(), c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default()))
        .collect();
    if prefixes.is_empty() {
        return;
    }
    for caps in route.captures_iter(text) {
        let at = caps.get(0).unwrap().start();
        let path = join(prefix_before(&prefixes, at), caps.get(2).map_or("", |m| m.as_str()));
        let method = if &caps[1] == "All" { "GET" } else { &caps[1] };
        push(out, rel, text, at, method, &path, "NestJS");
    }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/// FastAPI: `@app.get("/x")`, `@router.post("/x")`, with `router = APIRouter(prefix="/api")`.
fn fastapi(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static ROUTER: OnceLock<Regex> = OnceLock::new();
    static ROUTE: OnceLock<Regex> = OnceLock::new();
    let router = re(&ROUTER, r#"(\w+)\s*=\s*APIRouter\([^)]*?prefix\s*=\s*["']([^"']*)["']"#);
    let route = re(&ROUTE, r#"@(\w+)\.(get|post|put|patch|delete|options|head)\(\s*["']([^"']*)["']"#);
    let prefixes: HashMap<String, String> = router.captures_iter(text).map(|c| (c[1].to_string(), c[2].to_string())).collect();
    for caps in route.captures_iter(text) {
        let prefix = prefixes.get(&caps[1]).map(String::as_str).unwrap_or("");
        push(out, rel, text, caps.get(0).unwrap().start(), &caps[2], &join(prefix, &caps[3]), "FastAPI");
    }
}

/// Flask: `@app.route("/x", methods=["POST"])`, with `bp = Blueprint(..., url_prefix="/api")`.
fn flask(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static BLUEPRINT: OnceLock<Regex> = OnceLock::new();
    static ROUTE: OnceLock<Regex> = OnceLock::new();
    static METHOD: OnceLock<Regex> = OnceLock::new();
    let blueprint = re(&BLUEPRINT, r#"(\w+)\s*=\s*Blueprint\([^)]*?url_prefix\s*=\s*["']([^"']*)["']"#);
    let route = re(&ROUTE, r#"@(\w+)\.route\(\s*["']([^"']*)["']([^)]*)\)"#);
    let method = re(&METHOD, r#"["'](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)["']"#);
    let prefixes: HashMap<String, String> = blueprint.captures_iter(text).map(|c| (c[1].to_string(), c[2].to_string())).collect();
    for caps in route.captures_iter(text) {
        let prefix = prefixes.get(&caps[1]).map(String::as_str).unwrap_or("");
        let path = join(prefix, &caps[2]);
        let at = caps.get(0).unwrap().start();
        let methods: Vec<String> = method.captures_iter(&caps[3]).map(|m| m[1].to_string()).collect();
        if methods.is_empty() {
            push(out, rel, text, at, "GET", &path, "Flask");
        }
        for m in methods {
            push(out, rel, text, at, &m, &path, "Flask");
        }
    }
}

/// Django's `urls.py`: `path("users/<int:pk>/", view)` — the method is the view's business, so GET.
fn django(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static PATH: OnceLock<Regex> = OnceLock::new();
    let path = re(&PATH, r#"\b(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*(\w)"#);
    for caps in path.captures_iter(text) {
        // `include(...)` mounts other urls — not an endpoint of its own.
        let after = &text[caps.get(2).unwrap().start()..];
        if after.starts_with("include") {
            continue;
        }
        push(out, rel, text, caps.get(0).unwrap().start(), "GET", &caps[1], "Django");
    }
}

// ---------------------------------------------------------------------------
// Java / Kotlin — Spring
// ---------------------------------------------------------------------------

fn spring(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static MAPPING: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    static REQUEST_METHOD: OnceLock<Regex> = OnceLock::new();
    let mapping = re(&MAPPING, r#"@(Request|Get|Post|Put|Patch|Delete)Mapping\b(\s*\(([^)]*)\))?"#);
    let path = re(&PATH, r#"(?:(?:value|path)\s*=\s*\{?\s*)?["']([^"']*)["']"#);
    let request_method = re(&REQUEST_METHOD, r"RequestMethod\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)");
    let mut prefixes: Vec<(usize, String)> = Vec::new();
    for caps in mapping.captures_iter(text) {
        let whole = caps.get(0).unwrap();
        let args = caps.get(3).map_or("", |m| m.as_str());
        let route = path.captures(args).map(|c| c[1].to_string()).unwrap_or_default();
        let kind = &caps[1];
        if kind == "Request" {
            // On a class (the next `{` comes after a `class`), it is the prefix for what follows.
            let tail = &text[whole.end()..];
            let brace = tail.find('{').unwrap_or(tail.len());
            if tail[..brace].contains("class ") || tail[..brace].contains("interface ") {
                prefixes.push((whole.start(), route));
                continue;
            }
            let method = request_method.captures(args).map(|c| c[1].to_string()).unwrap_or_else(|| "GET".into());
            let full = join(prefix_before(&prefixes, whole.start()), &route);
            push(out, rel, text, whole.start(), &method, &full, "Spring");
            continue;
        }
        let full = join(prefix_before(&prefixes, whole.start()), &route);
        push(out, rel, text, whole.start(), kind, &full, "Spring");
    }
}

// ---------------------------------------------------------------------------
// C# — ASP.NET Core
// ---------------------------------------------------------------------------

fn aspnet(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static ROUTE: OnceLock<Regex> = OnceLock::new();
    static VERB: OnceLock<Regex> = OnceLock::new();
    static MINIMAL: OnceLock<Regex> = OnceLock::new();
    static CLASS: OnceLock<Regex> = OnceLock::new();
    let route = re(&ROUTE, r#"\[Route\(\s*"([^"]*)"\s*\)\]"#);
    let verb = re(&VERB, r#"\[Http(Get|Post|Put|Patch|Delete|Options|Head)(?:\(\s*"([^"]*)"[^)]*\))?\]"#);
    let minimal = re(&MINIMAL, r#"\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)""#);
    let class = re(&CLASS, r"class\s+(\w+?)(?:Controller)?\b");
    let mut prefixes: Vec<(usize, String)> = Vec::new();
    for caps in route.captures_iter(text) {
        let whole = caps.get(0).unwrap();
        let tail = &text[whole.end()..];
        let brace = tail.find('{').unwrap_or(tail.len());
        if let Some(name) = class.captures(&tail[..brace]) {
            prefixes.push((whole.start(), caps[1].replace("[controller]", &name[1].to_ascii_lowercase())));
        }
    }
    for caps in verb.captures_iter(text) {
        let at = caps.get(0).unwrap().start();
        let full = join(prefix_before(&prefixes, at), caps.get(2).map_or("", |m| m.as_str()));
        push(out, rel, text, at, &caps[1], &full, "ASP.NET");
    }
    for caps in minimal.captures_iter(text) {
        push(out, rel, text, caps.get(0).unwrap().start(), &caps[1], &caps[2], "ASP.NET");
    }
}

// ---------------------------------------------------------------------------
// Go, PHP, Ruby, Rust
// ---------------------------------------------------------------------------

/// gin and echo (`r.GET("/x"`), chi (`r.Get("/x"`), net/http with Go 1.22 patterns
/// (`HandleFunc("POST /x"`).
fn go(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static CALL: OnceLock<Regex> = OnceLock::new();
    static HANDLE: OnceLock<Regex> = OnceLock::new();
    let call = re(&CALL, r#"\b\w+\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(/[^"]*)""#);
    let handle = re(&HANDLE, r#"\bHandle(?:Func)?\(\s*"(?:(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+)?(/[^"]*)""#);
    for caps in call.captures_iter(text) {
        push(out, rel, text, caps.get(0).unwrap().start(), &caps[1], &caps[2], "Go");
    }
    for caps in handle.captures_iter(text) {
        let method = caps.get(1).map_or("GET", |m| m.as_str());
        push(out, rel, text, caps.get(0).unwrap().start(), method, &caps[2], "Go");
    }
}

fn laravel(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static CALL: OnceLock<Regex> = OnceLock::new();
    let call = re(&CALL, r#"Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]*)['"]"#);
    let api = rel.ends_with("api.php");
    for caps in call.captures_iter(text) {
        let method = if &caps[1] == "any" { "GET" } else { &caps[1] };
        // `routes/api.php` is served under `/api` by default.
        let path = if api { join("/api", &caps[2]) } else { caps[2].to_string() };
        push(out, rel, text, caps.get(0).unwrap().start(), method, &path, "Laravel");
    }
}

fn rails(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static CALL: OnceLock<Regex> = OnceLock::new();
    let call = re(&CALL, r#"(?m)^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]"#);
    for caps in call.captures_iter(text) {
        push(out, rel, text, caps.get(0).unwrap().start(), &caps[1], &caps[2], "Rails");
    }
}

/// axum (`.route("/x", get(a).post(b))`) and actix-web (`#[get("/x")]`).
fn rust(rel: &str, text: &str, out: &mut Vec<RouteHit>) {
    static AXUM: OnceLock<Regex> = OnceLock::new();
    static AXUM_METHOD: OnceLock<Regex> = OnceLock::new();
    static ACTIX: OnceLock<Regex> = OnceLock::new();
    let axum = re(&AXUM, r#"\.route\(\s*"([^"]*)"\s*,([^;\n]*)"#);
    let axum_method = re(&AXUM_METHOD, r"\b(get|post|put|patch|delete|options|head)\s*\(");
    let actix = re(&ACTIX, r#"#\[(get|post|put|patch|delete|options|head)\(\s*"([^"]*)""#);
    for caps in axum.captures_iter(text) {
        let at = caps.get(0).unwrap().start();
        let mut any = false;
        // Up to the next route chained on the same line: its methods are its own.
        let handlers = caps[2].split(".route(").next().unwrap_or("");
        for method in axum_method.captures_iter(handlers) {
            any = true;
            push(out, rel, text, at, &method[1], &caps[1], "axum");
        }
        if !any {
            push(out, rel, text, at, "GET", &caps[1], "axum");
        }
    }
    for caps in actix.captures_iter(text) {
        push(out, rel, text, caps.get(0).unwrap().start(), &caps[1], &caps[2], "actix-web");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routes(rel: &str, text: &str) -> Vec<(String, String)> {
        scan_text(rel, text).into_iter().map(|h| (h.method, h.path)).collect()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(m, p)| (m.to_string(), p.to_string())).collect()
    }

    #[test]
    fn express_servers_count_and_clients_do_not() {
        let text = "app.get('/health', h);\nuserRouter.post(\"/users/:id\", h);\naxios.get('/api/users');\nrouter.delete(`/items/${id}`)\n";
        assert_eq!(routes("src/server.ts", text), pairs(&[("GET", "/health"), ("POST", "/users/:id")]));
    }

    #[test]
    fn nest_joins_the_controller_prefix() {
        let text = "@Controller('users')\nexport class UsersController {\n  @Get()\n  all() {}\n  @Get(':id')\n  one() {}\n  @Post()\n  create() {}\n}\n";
        assert_eq!(routes("src/users.controller.ts", text), pairs(&[("GET", "/users"), ("GET", "/users/:id"), ("POST", "/users")]));
    }

    #[test]
    fn spring_reads_class_and_method_mappings() {
        let text = "@RestController\n@RequestMapping(\"/api/orders\")\npublic class OrderController {\n  @GetMapping(\"/{id}\")\n  Order one() {}\n  @PostMapping\n  Order create() {}\n  @RequestMapping(value = \"/bulk\", method = RequestMethod.PUT)\n  void bulk() {}\n}\n";
        assert_eq!(
            routes("src/main/java/OrderController.java", text),
            pairs(&[("GET", "/api/orders/:id"), ("POST", "/api/orders"), ("PUT", "/api/orders/bulk")])
        );
    }

    #[test]
    fn fastapi_and_flask_with_their_prefixes() {
        let fast = "router = APIRouter(prefix=\"/items\")\n@router.get(\"/{item_id}\")\nasync def read(): ...\n@app.post(\"/login\")\ndef login(): ...\n";
        assert_eq!(routes("app/main.py", fast), pairs(&[("GET", "/items/:item_id"), ("POST", "/login")]));
        let flask = "bp = Blueprint('users', __name__, url_prefix='/users')\n@bp.route('/<int:uid>', methods=['GET', 'DELETE'])\ndef user(uid): ...\n";
        assert_eq!(routes("app/views.py", flask), pairs(&[("GET", "/users/:uid"), ("DELETE", "/users/:uid")]));
    }

    #[test]
    fn aspnet_controllers_and_minimal_apis() {
        let text = "[ApiController]\n[Route(\"api/[controller]\")]\npublic class ProductsController : ControllerBase {\n  [HttpGet(\"{id:int}\")]\n  public IActionResult Get(int id) => Ok();\n  [HttpPost]\n  public IActionResult Post() => Ok();\n}\napp.MapGet(\"/ping\", () => \"pong\");\n";
        assert_eq!(
            routes("Controllers/ProductsController.cs", text),
            pairs(&[("GET", "/api/products/:id"), ("POST", "/api/products"), ("GET", "/ping")])
        );
    }

    #[test]
    fn go_laravel_rails_and_rust() {
        assert_eq!(
            routes("main.go", "r.GET(\"/users/:id\", h)\nmux.HandleFunc(\"POST /orders/{id}\", h)\nr.Get(\"/x\", h)\n"),
            pairs(&[("GET", "/users/:id"), ("POST", "/orders/:id"), ("GET", "/x")])
        );
        assert_eq!(routes("routes/api.php", "Route::get('/users/{id}', [C::class, 'show']);"), pairs(&[("GET", "/api/users/:id")]));
        assert_eq!(routes("config/routes.rb", "  get 'health', to: 'h#show'\n"), pairs(&[("GET", "/health")]));
        assert_eq!(
            routes("src/main.rs", "Router::new().route(\"/users/{id}\", get(show).delete(remove));\n#[post(\"/login\")]\nasync fn login() {}\n"),
            pairs(&[("GET", "/users/:id"), ("DELETE", "/users/:id"), ("POST", "/login")])
        );
    }

    #[test]
    fn tests_and_bundles_are_not_read() {
        assert!(!worth_reading("src/server.test.ts"));
        assert!(!worth_reading("dist/app.min.js"));
        assert!(worth_reading("src/server.ts"));
    }
}
