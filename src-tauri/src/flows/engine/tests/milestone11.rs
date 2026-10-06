//! Hito 11 — ports that follow their settings (a Switch's cases, a Merge's inputs, a classifier's
//! categories), the digest, hiding sensitive data, and macOS's own automation and OCR.

use super::*;

fn start() -> FlowNode {
    node("start", "trigger.manual", json!({}))
}

#[tokio::test]
async fn a_switch_has_as_many_outputs_as_its_cases() {
    let spec = flow(
        vec![
            start(),
            code("data", "return [0, 1, 2, 3, 4, 5, 6].map((n) => ({ n }));"),
            node("route", "logic.switch", json!({"caseCount": 5, "mode": "expression", "output": "={{ $json.n }}"})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "route", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    for case in 0..5 {
        assert_eq!(ran.output("route", case), vec![json!({"n": case})], "case {case}");
    }
    assert_eq!(ran.output("route", 5), vec![json!({"n": 5}), json!({"n": 6})], "past the last case is «other»");
}

#[tokio::test]
async fn a_merge_joins_as_many_inputs_as_it_has() {
    let joined = |params: Value| {
        flow(
            vec![
                start(),
                code("a", "return [{ a: 1, id: 7 }];"),
                code("b", "return [{ b: 2, id: 7 }];"),
                code("c", "return [{ c: 3, id: 7 }];"),
                node("join", "logic.merge", params),
            ],
            vec![
                wire("start", 0, "a", 0),
                wire("start", 0, "b", 0),
                wire("start", 0, "c", 0),
                wire("a", 0, "join", 0),
                wire("b", 0, "join", 1),
                wire("c", 0, "join", 2),
            ],
        )
    };
    let ran = run(joined(json!({"inputCount": 3, "mode": "append"}))).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("join", 0), vec![json!({"a": 1, "id": 7}), json!({"b": 2, "id": 7}), json!({"c": 3, "id": 7})]);

    let ran = run(joined(json!({"inputCount": 3, "mode": "position"}))).await;
    assert_eq!(ran.output("join", 0), vec![json!({"a": 1, "b": 2, "c": 3, "id": 7})], "folded left to right");

    let ran = run(joined(json!({"inputCount": 3, "mode": "field", "field1": "id", "field2": "id", "join": "inner"}))).await;
    assert_eq!(ran.output("join", 0), vec![json!({"a": 1, "b": 2, "c": 3, "id": 7})]);

    let ran = run(joined(json!({"inputCount": 3, "mode": "choose", "choose": "input3"}))).await;
    assert_eq!(ran.output("join", 0), vec![json!({"c": 3, "id": 7})]);
}

#[tokio::test]
async fn a_classifier_can_send_each_item_out_of_its_category() {
    let spec = flow(
        vec![
            start(),
            code("mail", "return [{ text: 'me cobraron dos veces' }, { text: 'la app se cae' }, { text: 'hola' }];"),
            node(
                "kind",
                "ai.classify",
                json!({"categories": [{"name": "cobros"}, {"name": "errores"}], "routing": "routeBranch", "allowOther": true}),
            ),
        ],
        vec![wire("start", 0, "mail", 0), wire("mail", 0, "kind", 0)],
    );
    let script = Script::answering(vec![
        Ok("{\"category\": \"cobros\", \"reason\": \"x\"}"),
        Ok("{\"category\": \"errores\", \"reason\": \"x\"}"),
        Ok("{\"category\": \"other\", \"reason\": \"x\"}"),
    ]);
    let ran = run_ai(spec, script).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("kind", 0)[0]["text"], "me cobraron dos veces");
    assert_eq!(ran.output("kind", 1)[0]["text"], "la app se cae");
    assert_eq!(ran.output("kind", 2)[0]["text"], "hola", "«other» is the last port");
}

#[tokio::test]
async fn a_digest_collects_and_hands_everything_over_once() {
    let spec = flow(
        vec![
            start(),
            code("events", "return [{ pr: 1 }, { pr: 2 }, { pr: 3 }];"),
            node("keep", "data.state", json!({"operation": "collect", "key": "prs", "keepAtMost": 2})),
            node("all", "data.state", json!({"operation": "takeAll", "key": "prs", "target": "prs", "runFor": "once"})),
        ],
        vec![wire("start", 0, "events", 0), wire("events", 0, "keep", 0), wire("keep", 0, "all", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("keep", 0).len(), 3, "collecting passes the items on");
    let handed = ran.output("all", 0);
    assert_eq!(handed.len(), 1, "one item with everything");
    assert_eq!(handed[0]["count"], 2);
    assert_eq!(handed[0]["prs"], json!([{"pr": 2}, {"pr": 3}]), "the oldest dropped past «keep at most»");
}

#[tokio::test]
async fn sensitive_data_is_hidden_and_counted() {
    let spec = flow(
        vec![
            start(),
            code("data", "return [{ text: 'Escríbeme a ana@example.com o al +56 9 8765 4321', id: 4111111111111111 }];"),
            node("hide", "transform.redact", json!({"detect": ["piiEmail", "piiPhone", "piiCard"], "redactMode": "redactHash", "reportField": "_redacted"})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "hide", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = &ran.output("hide", 0)[0];
    let text = out["text"].as_str().unwrap();
    assert!(text.starts_with("Escríbeme a [EMAIL:") && text.contains("o al [PHONE:"), "{text}");
    assert_eq!(out["_redacted"], json!({"email": 1, "phone": 1}));
    assert_eq!(out["id"], json!(4111111111111111u64), "numbers are not text: left alone");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn applescript_and_jxa_get_the_item_and_answer_items() {
    let spec = flow(
        vec![
            start(),
            code("data", "return [{ name: 'Ana' }];"),
            node(
                "jxa",
                "code.osascript",
                json!({"osaKind": "jxa", "jxaScript": "function run(argv) { const item = JSON.parse(argv[0]); return JSON.stringify({ hello: item.name }); }", "runFor": "each"}),
            ),
            node(
                "apple",
                "code.osascript",
                json!({"osaKind": "applescript", "appleScript": "on run argv\n  return \"recibido: \" & (item 1 of argv)\nend run", "runFor": "each", "output": "text"}),
            ),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "jxa", 0), wire("jxa", 0, "apple", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("jxa", 0), vec![json!({"hello": "Ana"})]);
    let said = ran.output("apple", 0);
    assert_eq!(said[0]["stdout"], "recibido: {\"hello\":\"Ana\"}");
}

/// Draws a line of text into a PNG with AppKit — so the OCR test needs no fixture file.
#[cfg(target_os = "macos")]
fn png_with_text(path: &std::path::Path, text: &str) {
    let script = format!(
        "ObjC.import('AppKit');\n\
         const image = $.NSImage.alloc.initWithSize($.NSMakeSize(900, 200));\n\
         image.lockFocus;\n\
         $.NSColor.whiteColor.setFill;\n\
         $.NSRectFill($.NSMakeRect(0, 0, 900, 200));\n\
         const attrs = $.NSDictionary.dictionaryWithObjectsForKeys($([$.NSFont.systemFontOfSize(56), $.NSColor.blackColor]), $([$.NSFontAttributeName, $.NSForegroundColorAttributeName]));\n\
         $({text:?}).drawAtPointWithAttributes($.NSMakePoint(40, 70), attrs);\n\
         image.unlockFocus;\n\
         const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);\n\
         rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({{}})).writeToFileAtomically({path:?}, true);\n",
        path = path.to_string_lossy()
    );
    let status = std::process::Command::new("osascript").args(["-l", "JavaScript", "-e", &script]).status().unwrap();
    assert!(status.success() && path.is_file(), "the test image was drawn");
}

/// Slow (Vision loads its model, ~20 s cold) and macOS-only: run with `--ignored`.
#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore]
async fn the_macs_own_ocr_reads_an_image_with_no_model() {
    let image = std::env::temp_dir().join(format!("cf-ocr-{}.png", uuid::Uuid::new_v4()));
    png_with_text(&image, "Factura 4521 total 129990");
    let spec = flow(
        vec![start(), node("look", "ai.vision", json!({"imagePath": image.to_string_lossy(), "visionEngine": "visionSystem", "visionTask": "visionOcr"}))],
        vec![wire("start", 0, "look", 0)],
    );
    let ran = run(spec).await;
    let _ = std::fs::remove_file(&image);
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = &ran.output("look", 0)[0];
    assert!(out["vision"].as_str().unwrap().contains("4521"), "{out}");
    assert_eq!(out["ai"]["engine"], "system");
}

/// A retry «from where it failed»: what succeeded the first time stands in for its node (`Reused`,
/// not run again), and the nodes after it run on that output.
#[tokio::test]
async fn a_retry_reuses_what_succeeded_and_runs_the_rest() {
    let spec = flow(
        vec![start(), code("fetch", "throw new Error('should not run again');"), code("after", "return $input.all().map((i) => ({ json: { seen: i.json.n * 2 } }));")],
        vec![wire("start", 0, "fetch", 0), wire("fetch", 0, "after", 0)],
    );
    let memory = Arc::new(Memory::default());
    let dir = std::env::temp_dir().join(format!("cf-flow-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let host = Arc::new(Host { memory: memory.clone(), dir: dir.clone(), script: Arc::new(Script::default()) });
    let mut plan = plan(&spec, &RunMode::Full, None, &HashMap::new(), &HashMap::new()).expect("a plan");
    // What `runs::retry` hands the start: the earlier run's output of every node that succeeded.
    plan.seeds.insert("fetch".into(), (vec![vec![Item::new(json!({"n": 21}))]], false));
    let run = Arc::new(RunContext {
        run_id: "run-2".into(),
        flow_id: "flow-1".into(),
        flow_name: "Prueba".into(),
        workspace_id: "w1".into(),
        mode: "retry".into(),
        vars: serde_json::Map::new(),
        timezone: None,
        locale: "es".into(),
        host,
        cancel: CancellationToken::new(),
        respond: Mutex::new(None),
        depth: 0,
        ai_per_hour: 0,
    });
    let outcome = execute(Arc::new(spec), plan, run).await;
    let _ = std::fs::remove_dir_all(&dir);
    let ran = Ran { outcome, memory, elapsed: Duration::ZERO };
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.status("fetch"), NodeStatus::Reused);
    assert_eq!(ran.output("after", 0), vec![json!({"seen": 42})]);
}

/// A tiny HTTP server answering every request with `body` as `content_type`, once per connection.
fn serve_bytes(body: &'static [u8], content_type: &'static str) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(4) {
            let Ok(mut stream) = stream else { continue };
            use std::io::{Read, Write};
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nContent-Disposition: attachment; filename=\"logo.png\"\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
        }
    });
    format!("http://{address}/descarga")
}

/// A binary answer travels as a file reference, and a file node writes it out byte for byte.
#[tokio::test]
async fn binary_answers_travel_as_file_references() {
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01";
    let url = serve_bytes(PNG, "image/png");
    let target = std::env::temp_dir().join(format!("cf-ref-{}.png", uuid::Uuid::new_v4()));
    let spec = flow(
        vec![
            start(),
            node("get", "net.http", json!({"method": "GET", "url": url})),
            node("save", "files.file", json!({"operation": "write", "path": target.to_string_lossy(), "content": "={{ $json.file }}"})),
        ],
        vec![wire("start", 0, "get", 0), wire("get", 0, "save", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let got = &ran.output("get", 0)[0];
    assert_eq!(got["binary"], true);
    assert_eq!(got["file"]["name"], "logo.png");
    assert_eq!(got["file"]["size"], PNG.len());
    assert!(got.get("data").is_none(), "no base64 in the item");
    assert_eq!(std::fs::read(&target).unwrap(), PNG);
    let _ = std::fs::remove_file(&target);
}
