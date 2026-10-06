//! Hito 8 — utilities: HTTP pagination, web pages, PDF, waiting until, only-if-changed, templates,
//! site checks, JSON, crypto (JWT, encryption), images and QR, SQL over items.

use super::*;

/// A loopback server answering `GET path?query` with what `answer` says: `(extra headers, body)`.
async fn serve(answer: fn(&str) -> (String, String)) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 16 * 1024];
                let mut read = 0;
                loop {
                    let n = socket.read(&mut buffer[read..]).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    read += n;
                    if String::from_utf8_lossy(&buffer[..read]).contains("\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let target = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (headers, body) = answer(&target);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    port
}

fn query_value(target: &str, name: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    query.split('&').find_map(|pair| pair.split_once('=').filter(|(k, _)| *k == name).map(|(_, v)| v.to_string()))
}

fn one(type_id: &str, params: Value) -> FlowSpec {
    flow(vec![node("start", "trigger.manual", json!({})), node("it", type_id, params)], vec![wire("start", 0, "it", 0)])
}

fn pages(target: &str) -> (String, String) {
    if target.starts_with("/numbered") {
        let page: u32 = query_value(target, "p").and_then(|p| p.parse().ok()).unwrap_or(1);
        let body = if page <= 2 { format!("{{\"data\":[{{\"n\":{}}},{{\"n\":{}}}]}}", page * 10, page * 10 + 1) } else { "{\"data\":[]}".into() };
        (String::new(), body)
    } else if target.starts_with("/cursor") {
        match query_value(target, "after").as_deref() {
            None => (String::new(), "{\"items\":[{\"id\":\"a\"}],\"meta\":{\"next\":\"k1\"}}".into()),
            Some("k1") => (String::new(), "{\"items\":[{\"id\":\"b\"}],\"meta\":{\"next\":null}}".into()),
            _ => (String::new(), "{\"items\":[]}".into()),
        }
    } else if target == "/linked" {
        ("Link: </linked2>; rel=\"next\", </linked>; rel=\"first\"\r\n".into(), "[{\"id\":1}]".into())
    } else {
        (String::new(), "[{\"id\":2},{\"id\":3}]".into())
    }
}

#[tokio::test]
async fn pages_are_followed_by_number_cursor_and_link_header() {
    let port = serve(pages).await;
    let base = format!("http://127.0.0.1:{port}");

    let ran = run(one("net.http", json!({"url": format!("{base}/numbered"), "pagination": "pageNumber", "pageParam": "p", "itemsField": "data"}))).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let numbers: Vec<i64> = ran.output("it", 0).iter().map(|item| item["n"].as_i64().unwrap()).collect();
    assert_eq!(numbers, vec![10, 11, 20, 21], "until a page comes back empty");

    let ran = run(one(
        "net.http",
        json!({"url": format!("{base}/cursor"), "pagination": "cursor", "cursorField": "meta.next", "cursorParam": "after", "itemsField": "items"}),
    ))
    .await;
    let ids: Vec<String> = ran.output("it", 0).iter().map(|item| item["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, vec!["a", "b"], "until the cursor runs out");

    let ran = run(one("net.http", json!({"url": format!("{base}/linked"), "pagination": "nextUrl"}))).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let ids: Vec<i64> = ran.output("it", 0).iter().map(|item| item["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![1, 2, 3], "the Link header's rel=next, then no more");

    let ran = run(one("net.http", json!({"url": format!("{base}/numbered"), "pagination": "pageNumber", "pageParam": "p", "itemsField": "data", "maxPages": 1}))).await;
    assert_eq!(ran.output("it", 0).len(), 2, "never past maxPages");
}

fn site(target: &str) -> (String, String) {
    if target == "/page" {
        (String::new(), "<html><head><title>Precios</title></head><body><nav>menú</nav><main><h1>Plan Pro</h1><p class=\"price\">$ 20</p><a href=\"/buy\">Comprar</a></main></body></html>".into())
    } else if target == "/health" {
        static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        (String::new(), if n < 2 { "{\"status\":\"starting\"}".into() } else { "{\"status\":\"ok\"}".into() })
    } else {
        (String::new(), "{}".into())
    }
}

#[tokio::test]
async fn a_page_is_read_as_markdown_and_as_fields() {
    let port = serve(site).await;
    let url = format!("http://127.0.0.1:{port}/page");
    let ran = run(one("net.webPage", json!({"url": url, "mode": "markdown"}))).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let page = &ran.output("it", 0)[0];
    assert_eq!(page["title"], "Precios");
    let markdown = page["markdown"].as_str().unwrap();
    assert!(markdown.contains("# Plan Pro") && !markdown.contains("menú"), "{markdown}");

    let ran = run(one(
        "net.webPage",
        json!({"url": url, "mode": "extract", "fieldsToExtract": [
            {"name": "plan", "selector": "h1"},
            {"name": "price", "selector": ".price"},
            {"name": "buy", "selector": "main a", "attribute": "href"},
        ]}),
    ))
    .await;
    let fields = &ran.output("it", 0)[0];
    assert_eq!((fields["plan"].as_str(), fields["price"].as_str()), (Some("Plan Pro"), Some("$ 20")));
    assert_eq!(fields["buy"], format!("http://127.0.0.1:{port}/buy"));
}

#[tokio::test]
async fn a_site_is_checked_without_failing_the_run() {
    let port = serve(site).await;
    let ran = run(one("net.check", json!({"check": "httpCheck", "siteTarget": format!("http://127.0.0.1:{port}/page")}))).await;
    let up = &ran.output("it", 0)[0];
    assert_eq!((up["ok"].as_bool(), up["status"].as_u64()), (Some(true), Some(200)));
    let ran = run(one("net.check", json!({"check": "portCheck", "siteTarget": "127.0.0.1", "port": port}))).await;
    assert_eq!(ran.output("it", 0)[0]["open"], true);
    // A closed port: the finding is `ok: false`, not a failed run.
    let ran = run(one("net.check", json!({"check": "portCheck", "siteTarget": "127.0.0.1", "port": 9, "timeoutMs": 1000}))).await;
    assert_eq!(ran.outcome.status, RunStatus::Success);
    assert_eq!(ran.output("it", 0)[0]["ok"], false);
}

#[tokio::test]
async fn waiting_until_asks_again_until_it_holds() {
    let port = serve(site).await;
    let ran = run(one(
        "logic.until",
        json!({"check": "httpUntil", "url": format!("http://127.0.0.1:{port}/health"), "bodyContains": "\"ok\"", "intervalSec": 1, "timeoutSec": 20}),
    ))
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    let until = &ran.output("it", 0)[0]["until"];
    assert_eq!(until["ok"], true);
    assert_eq!(until["attempts"], 3, "starting, starting, ok");

    let ran = run(one("logic.until", json!({"check": "commandUntil", "command": "exit 1", "intervalSec": 1, "timeoutSec": 2}))).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.as_deref().unwrap_or("").contains("Still not there"));
}

#[tokio::test]
async fn only_what_changed_since_the_last_run_goes_through() {
    let changes = |items: &str| {
        flow(
            vec![
                node("start", "trigger.manual", json!({})),
                code("data", items),
                node("it", "transform.changes", json!({"key": "={{ $json.id }}"})),
            ],
            vec![wire("start", 0, "data", 0), wire("data", 0, "it", 0)],
        )
    };
    let first = run_scripted(
        changes("return [{id: 1, price: 10}, {id: 2, price: 5}];"),
        RunMode::Full,
        HashMap::new(),
        CancellationToken::new(),
        Arc::new(Script::default()),
        Memory::default(),
        "flow-8",
        0,
    )
    .await;
    assert_eq!(first.output("it", 0).len(), 2, "the first run lets everything through");
    let remembered = first.memory.state.lock().unwrap().clone();
    let memory = Memory::default();
    *memory.state.lock().unwrap() = remembered;
    let second = run_scripted(
        changes("return [{id: 1, price: 10}, {id: 2, price: 7}, {id: 3, price: 1}];"),
        RunMode::Full,
        HashMap::new(),
        CancellationToken::new(),
        Arc::new(Script::default()),
        memory,
        "flow-8",
        0,
    )
    .await;
    let changed: Vec<i64> = second.output("it", 0).iter().map(|item| item["id"].as_i64().unwrap()).collect();
    assert_eq!(changed, vec![2, 3], "#2 moved, #3 is new");
    assert_eq!(second.output("it", 1).len(), 1, "#1 is the same");
}

#[tokio::test]
async fn templates_json_and_sql_shape_the_items() {
    let items = "return [{nombre: 'Ana', total: 10, region: 'norte'}, {nombre: 'Luis', total: 5, region: 'sur'}, {nombre: 'Eva', total: 2, region: 'norte'}];";
    let chain = |type_id: &str, params: Value| {
        flow(
            vec![node("start", "trigger.manual", json!({})), code("data", items), node("it", type_id, params)],
            vec![wire("start", 0, "data", 0), wire("data", 0, "it", 0)],
        )
    };
    let ran = run(chain("transform.template", json!({"template": "Hola {{ json.nombre }} ({{ json.total }})"}))).await;
    assert_eq!(ran.output("it", 0)[1]["text"], "Hola Luis (5)");
    let ran = run(chain(
        "transform.template",
        json!({"runFor": "once", "target": "informe", "template": "{% for i in items %}- {{ i.nombre }}\n{% endfor %}"}),
    ))
    .await;
    assert_eq!(ran.output("it", 0)[0]["informe"], "- Ana\n- Luis\n- Eva\n");
    // Written the way every other field of Flujos is — `$json`, `$items` — and opening with `=`.
    let ran = run(chain(
        "transform.template",
        json!({"runFor": "once", "template": "=== {{ $items|length }} ===\n{% for i in $items %}{{ i.nombre }}{% if not loop.last %}, {% endif %}{% endfor %}"}),
    ))
    .await;
    assert_eq!(ran.output("it", 0)[0]["text"], "=== 3 ===\nAna, Luis, Eva");
    let ran = run(chain("transform.template", json!({"template": "{{ $json.nombre }}: {% for c in $json.nombre|list %}{{ c }}.{% endfor %}"}))).await;
    assert_eq!(ran.output("it", 0)[2]["text"], "Eva: E.v.a.");

    let ran = run(chain("transform.sql", json!({"itemsQuery": "SELECT region, SUM(total) AS total FROM items GROUP BY region ORDER BY total DESC"}))).await;
    assert_eq!(ran.output("it", 0), vec![json!({"region": "norte", "total": 12}), json!({"region": "sur", "total": 5})]);

    let schema = r#"{"type": "object", "required": ["nombre", "total"], "properties": {"total": {"type": "number", "minimum": 3}}}"#;
    let ran = run(chain("transform.json", json!({"operation": "validate", "schema": schema}))).await;
    let verdicts: Vec<bool> = ran.output("it", 0).iter().map(|item| item["validation"]["valid"].as_bool().unwrap()).collect();
    assert_eq!(verdicts, vec![true, true, false], "Eva's total is under the minimum");
    let ran = run(chain("transform.json", json!({"operation": "jsonPath", "jsonPathExpr": "$.nombre"}))).await;
    assert_eq!(ran.output("it", 0)[0]["result"], json!(["Ana"]));
}

#[tokio::test]
async fn a_pdf_is_written_from_markdown_and_read_back() {
    let dir = std::env::temp_dir().join(format!("cf-pdf-{}", uuid::Uuid::new_v4()));
    let output = dir.join("informe.pdf");
    let ran = run(one(
        "files.pdf",
        json!({"operation": "createPdf", "title": "Ventas", "markdown": "# Resumen\n\nTodo en orden, señor.", "savePath": output.to_string_lossy()}),
    ))
    .await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    assert_eq!(ran.output("it", 0)[0]["pages"], 1);
    let ran = run(one("files.pdf", json!({"operation": "readPdf", "path": output.to_string_lossy()}))).await;
    let text = ran.output("it", 0)[0]["text"].as_str().unwrap().to_string();
    assert!(text.contains("Resumen") && text.contains("señor"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}
