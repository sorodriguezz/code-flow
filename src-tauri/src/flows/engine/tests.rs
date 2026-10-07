//! Whole runs, in memory: real processes, a real HTTP server on a loopback port, real QuickJS.
//! Each test builds a small flow, runs it through [`execute`] and reads what the host was told.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::flows::run::{plan, Item, RunMode};
use crate::flows::spec::{Connection, FlowNode, FlowSpec};

#[derive(Default)]
struct Memory {
    reports: Mutex<Vec<NodeReport>>,
    logs: Mutex<Vec<(String, LogStream, String)>>,
    notes: Mutex<Vec<(String, String)>>,
    state: Mutex<HashMap<String, Value>>,
    vars: Mutex<HashMap<String, String>>,
    started: Mutex<Vec<String>>,
}

/// What a test's models answer, in order, and what they were asked.
#[derive(Default)]
struct Script {
    answers: Mutex<std::collections::VecDeque<Result<String, String>>>,
    calls: Mutex<Vec<AiCall>>,
    local_calls: Mutex<Vec<LocalCall>>,
    quota: Mutex<Option<(f64, String)>>,
    projects: Mutex<HashMap<String, String>>,
    edits: Mutex<Vec<String>>,
    /// A file an editing agent appends to, relative to its folder — to have something to undo.
    touch: Mutex<Option<String>>,
    /// How the waits of a run end, in order, and what they asked.
    waits: Mutex<std::collections::VecDeque<WaitAnswer>>,
    wait_calls: Mutex<Vec<WaitRequest>>,
    /// What the app's operations (`app_call`) answer, in order, and what they were asked.
    app_answers: Mutex<std::collections::VecDeque<Result<Value, String>>>,
    app_calls: Mutex<Vec<(String, Value)>>,
}

impl Script {
    fn answering(answers: Vec<Result<&str, &str>>) -> Arc<Self> {
        let script = Script::default();
        *script.answers.lock().unwrap() =
            answers.into_iter().map(|answer| answer.map(str::to_string).map_err(str::to_string)).collect();
        Arc::new(script)
    }

    fn next(&self) -> Result<String, String> {
        self.answers.lock().unwrap().pop_front().unwrap_or_else(|| Err("the script ran out of answers".into()))
    }
}

struct Host {
    memory: Arc<Memory>,
    dir: PathBuf,
    script: Arc<Script>,
}

impl RunHost for Host {
    fn node_started(&self, node: &FlowNode, _seq: u32, _items_in: usize, _started_at: &str) {
        self.memory.started.lock().unwrap().push(node.id.clone());
    }
    fn node_finished(&self, _node: &FlowNode, report: NodeReport) {
        self.memory.reports.lock().unwrap().push(report);
    }
    fn log(&self, node_id: &str, stream: LogStream, text: &str) {
        self.memory.logs.lock().unwrap().push((node_id.into(), stream, text.into()));
    }
    fn notify(&self, title: &str, body: &str) {
        self.memory.notes.lock().unwrap().push((title.into(), body.into()));
    }
    fn state_get(&self, key: &str) -> Result<Option<Value>, String> {
        Ok(self.memory.state.lock().unwrap().get(key).cloned())
    }
    fn state_set(&self, key: &str, value: Option<&Value>) -> Result<(), String> {
        let mut state = self.memory.state.lock().unwrap();
        match value {
            Some(value) => state.insert(key.into(), value.clone()),
            None => state.remove(key),
        };
        Ok(())
    }
    fn var_get(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.memory.vars.lock().unwrap().get(name).cloned())
    }
    fn var_set(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        let mut vars = self.memory.vars.lock().unwrap();
        match value {
            Some(value) => vars.insert(name.into(), value.into()),
            None => vars.remove(name),
        };
        Ok(())
    }
    fn credential(&self, id: &str) -> Result<Credential, String> {
        match id {
            "token" => Ok(Credential { kind: "bearer".into(), meta: json!({}), secret: "s3cret".into() }),
            // An OAuth 2 credential: what is stored is never sent; `oauth_token` hands out the token.
            "oauth" => Ok(Credential { kind: "oauth2".into(), meta: json!({"provider": "google", "account": "ana@example.com"}), secret: "{\"refreshToken\":\"r\"}".into() }),
            "basic" => Ok(Credential { kind: "basic".into(), meta: json!({"user": "ana"}), secret: "pw".into() }),
            // The live services of `milestone9`: GreenMail (any password), RabbitMQ, ElasticMQ.
            "greenmail" => Ok(Credential {
                kind: "imap".into(),
                meta: json!({"host": "127.0.0.1", "port": "53143", "user": "ana@example.com", "security": "none"}),
                secret: "ana@example.com".into(),
            }),
            "rabbit" => Ok(Credential { kind: "basic".into(), meta: json!({"user": "flujos"}), secret: "flujos".into() }),
            "aws" => Ok(Credential { kind: "aws".into(), meta: json!({"user": "AKIAEXAMPLE", "region": "elasticmq"}), secret: "x".into() }),
            "signing" => Ok(Credential { kind: "hmac".into(), meta: json!({}), secret: "key".into() }),
            // A webhook URL credential pointing wherever the test's own server listens.
            hook if hook.starts_with("webhook:") => {
                Ok(Credential { kind: "webhook".into(), meta: json!({}), secret: hook["webhook:".len()..].into() })
            }
            // The SMTP catcher of the live tests (see `milestone4`): no login, no TLS.
            "mail" => Ok(Credential {
                kind: "smtp".into(),
                meta: json!({"host": "127.0.0.1", "port": "51025", "security": "none", "from": "Flujos <flujos@example.com>"}),
                secret: String::new(),
            }),
            _ => Err(format!("No credential {id}")),
        }
    }
    fn db_connection(&self, connection_id: &str) -> Result<crate::datasource::DbConnectionConfig, String> {
        milestone4::connection(connection_id)
    }
    fn remote_host(&self, host_id: &str) -> Result<crate::remotes::RemoteHostSpec, String> {
        milestone4::remote(host_id)
    }
    fn wait_for(&self, request: WaitRequest, _cancel: CancellationToken) -> HostFuture<'_, Result<WaitAnswer, String>> {
        Box::pin(async move {
            self.script.wait_calls.lock().unwrap().push(request);
            self.script.waits.lock().unwrap().pop_front().ok_or_else(|| "the script has no decision".to_string())
        })
    }
    fn resume_url(&self) -> Option<String> {
        Some("http://127.0.0.1:47811/resume/run-1".into())
    }
    fn work_dir(&self) -> PathBuf {
        self.dir.clone()
    }
    fn oauth_token(&self, id: &str, _meta: &Value) -> HostFuture<'_, Result<String, String>> {
        let id = id.to_string();
        Box::pin(async move { if id == "oauth" { Ok("ya29.fresh".to_string()) } else { Err(format!("{id} is not OAuth")) } })
    }
    fn vectors_path(&self) -> PathBuf {
        self.dir.join("vectors.sqlite")
    }
    fn subflow(&self, flow_id: &str, items: Vec<Item>, wait: bool) -> HostFuture<'_, Result<Vec<Item>, String>> {
        let flow_id = flow_id.to_string();
        Box::pin(async move {
            if flow_id != "child" {
                return Err(format!("No flow {flow_id}"));
            }
            if !wait {
                return Ok(items);
            }
            Ok(items.into_iter().map(|item| Item::new(json!({"child": true, "got": item.json}))).collect())
        })
    }
    fn service(&self, _service_id: &str, action: &str, _wait: bool, _timeout: Duration) -> HostFuture<'_, Result<Value, String>> {
        let action = action.to_string();
        Box::pin(async move { Ok(json!({"status": if action == "stop" { "stopped" } else { "ready" }})) })
    }
    fn ai(&self, call: AiCall, _cancel: CancellationToken) -> HostFuture<'_, Result<AiAnswer, String>> {
        Box::pin(async move {
            if call.can_edit {
                if let (Some(cwd), Some(file)) = (&call.cwd, self.script.touch.lock().unwrap().clone()) {
                    let path = std::path::Path::new(cwd).join(file);
                    let before = std::fs::read_to_string(&path).unwrap_or_default();
                    std::fs::write(&path, format!("{before}edited by the agent\n")).unwrap();
                }
            }
            let provider = if call.engine.provider.is_empty() { "claude".to_string() } else { call.engine.provider.clone() };
            self.script.calls.lock().unwrap().push(call);
            let text = self.script.next()?;
            Ok(AiAnswer {
                text,
                provider,
                model: "test-model".into(),
                account: None,
                session: Some("sess-1".into()),
                usage: Some(json!({"inputTokens": 10, "outputTokens": 5})),
            })
        })
    }
    fn local_ai(&self, call: LocalCall, _cancel: CancellationToken) -> HostFuture<'_, Result<LocalAnswer, String>> {
        Box::pin(async move {
            self.script.local_calls.lock().unwrap().push(call);
            let text = self.script.next()?;
            Ok(LocalAnswer { text, server: "ollama".into(), model: "qwen".into(), prompt_tokens: Some(7), completion_tokens: Some(3), ..Default::default() })
        })
    }
    fn project_path(&self, project_id: &str) -> Result<String, String> {
        self.script.projects.lock().unwrap().get(project_id).cloned().ok_or_else(|| format!("Unknown repository {project_id}"))
    }
    fn quota(&self, _engine: &EngineChoice) -> Option<(f64, String)> {
        self.script.quota.lock().unwrap().clone()
    }
    fn edits_recorded(&self, path: &str) {
        self.script.edits.lock().unwrap().push(path.to_string());
    }
    fn app_call(&self, op: &str, args: Value, _cancel: CancellationToken) -> HostFuture<'_, Result<Value, String>> {
        let op = op.to_string();
        Box::pin(async move {
            self.script.app_calls.lock().unwrap().push((op.clone(), args));
            self.script.app_answers.lock().unwrap().pop_front().unwrap_or_else(|| Err(format!("the script has no answer for {op}")))
        })
    }
}

fn node(id: &str, type_id: &str, params: Value) -> FlowNode {
    FlowNode {
        id: id.into(),
        type_id: type_id.into(),
        name: id.to_string(),
        pos: [0.0, 0.0],
        params,
        settings: json!({}),
        disabled: false,
    }
}

fn wire(from: &str, out: u8, to: &str, input: u8) -> Connection {
    Connection { from: from.into(), out, to: to.into(), input }
}

fn flow(nodes: Vec<FlowNode>, connections: Vec<Connection>) -> FlowSpec {
    let spec = FlowSpec { schema: 1, nodes, connections, notes: vec![], settings: json!({}) };
    crate::flows::spec::validate(&spec).expect("a valid flow");
    spec
}

struct Ran {
    outcome: RunOutcome,
    memory: Arc<Memory>,
    elapsed: Duration,
}

impl Ran {
    fn report(&self, id: &str) -> NodeReport {
        self.memory
            .reports
            .lock()
            .unwrap()
            .iter()
            .find(|report| report.node_id == id)
            .cloned()
            .unwrap_or_else(|| panic!("no report for {id}"))
    }

    fn output(&self, id: &str, port: usize) -> Vec<Value> {
        self.report(id).outputs.get(port).map(|items| items.iter().map(|item| item.json.clone()).collect()).unwrap_or_default()
    }

    fn status(&self, id: &str) -> NodeStatus {
        self.report(id).status
    }

    /// Every report a node sent, in order — one per batch inside a loop.
    fn reports_of(&self, id: &str) -> Vec<NodeReport> {
        self.memory.reports.lock().unwrap().iter().filter(|report| report.node_id == id).cloned().collect()
    }

    /// A node's last report: inside a loop, its last batch's.
    fn last(&self, id: &str) -> NodeReport {
        self.reports_of(id).pop().unwrap_or_else(|| panic!("no report for {id}"))
    }
}

async fn run_with(spec: FlowSpec, mode: RunMode, pins: HashMap<String, Ports>, cancel: CancellationToken) -> Ran {
    run_scripted(spec, mode, pins, cancel, Arc::new(Script::default()), Memory::default(), "flow-1", 0).await
}

#[allow(clippy::too_many_arguments)]
async fn run_scripted(
    spec: FlowSpec,
    mode: RunMode,
    pins: HashMap<String, Ports>,
    cancel: CancellationToken,
    script: Arc<Script>,
    memory: Memory,
    flow_id: &str,
    ai_per_hour: u32,
) -> Ran {
    let memory = Arc::new(memory);
    let dir = std::env::temp_dir().join(format!("cf-flow-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let host = Arc::new(Host { memory: memory.clone(), dir: dir.clone(), script });
    let plan = plan(&spec, &mode, None, &pins, &HashMap::new()).expect("a plan");
    let run = Arc::new(RunContext {
        run_id: "run-1".into(),
        flow_id: flow_id.into(),
        flow_name: "Prueba".into(),
        workspace_id: "w1".into(),
        mode: mode.label().into(),
        vars: serde_json::Map::from_iter([("region".to_string(), json!("cl"))]),
        timezone: Some("America/Santiago".into()),
        locale: "es".into(),
        host,
        cancel,
        respond: Mutex::new(None),
        depth: 0,
        ai_per_hour,
    });
    let started = Instant::now();
    let outcome = execute(Arc::new(spec), plan, run).await;
    let elapsed = started.elapsed();
    let _ = std::fs::remove_dir_all(&dir);
    Ran { outcome, memory, elapsed }
}

async fn run(spec: FlowSpec) -> Ran {
    run_with(spec, RunMode::Full, HashMap::new(), CancellationToken::new()).await
}

fn code(id: &str, source: &str) -> FlowNode {
    node(id, "code.js", json!({"mode": "all", "code": source}))
}

#[tokio::test]
async fn branches_route_skip_and_merge() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("data", "return [{n: 1}, {n: 5}, {n: 9}];"),
            node(
                "big",
                "logic.if",
                json!({"conditions": {"combinator": "and", "conditions": [{"left": "={{ $json.n }}", "op": "gt", "right": "3"}]}}),
            ),
            node(
                "tag",
                "transform.set",
                json!({"assignments": [{"name": "size", "type": "string", "value": "=grande-{{ $json.n }}"}]}),
            ),
            node("small", "transform.set", json!({"assignments": [{"name": "size", "type": "string", "value": "chico"}]})),
            node("join", "logic.merge", json!({"mode": "append"})),
            node("none", "transform.set", json!({})),
        ],
        vec![
            wire("start", 0, "data", 0),
            wire("data", 0, "big", 0),
            wire("big", 0, "tag", 0),
            wire("big", 1, "small", 0),
            wire("tag", 0, "join", 0),
            wire("small", 0, "join", 1),
            // Nothing is ever below 0, so this branch goes quiet.
            wire("small", 0, "none", 0),
        ],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    assert_eq!(ran.output("big", 0).len(), 2);
    assert_eq!(ran.output("tag", 0), vec![json!({"n": 5, "size": "grande-5"}), json!({"n": 9, "size": "grande-9"})]);
    assert_eq!(ran.output("join", 0).len(), 3);
    assert_eq!(ran.output("join", 0)[2], json!({"n": 1, "size": "chico"}));
}

#[tokio::test]
async fn an_empty_branch_is_skipped_all_the_way_down() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("data", "return [{n: 1}];"),
            node(
                "check",
                "logic.if",
                json!({"conditions": {"conditions": [{"left": "={{ $json.n }}", "op": "gt", "right": "100"}]}}),
            ),
            node("yes", "transform.set", json!({})),
            node("after", "transform.set", json!({})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "check", 0), wire("check", 0, "yes", 0), wire("yes", 0, "after", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success);
    assert_eq!(ran.status("yes"), NodeStatus::Skipped);
    assert_eq!(ran.status("after"), NodeStatus::Skipped);
    assert!(!ran.memory.started.lock().unwrap().contains(&"after".to_string()), "a skipped node never starts");
}

/// `$('Datos').item` finds the item a row came from even after a Filter changed the positions.
#[tokio::test]
async fn paired_items_survive_a_filter() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("Datos", "return [{id: 'a', keep: false}, {id: 'b', keep: true}, {id: 'c', keep: true}];"),
            node(
                "keep",
                "transform.filter",
                json!({"conditions": {"conditions": [{"left": "={{ $json.keep }}", "op": "isTrue", "right": ""}]}}),
            ),
            node("strip", "transform.set", json!({"include": "none", "assignments": [{"name": "n", "value": "={{ $itemIndex }}"}]})),
            node(
                "look",
                "transform.set",
                json!({"assignments": [{"name": "source", "value": "={{ $('Datos').item.json.id }}"}, {"name": "prev", "value": "={{ $prevNode.name }}"}]}),
            ),
        ],
        vec![wire("start", 0, "Datos", 0), wire("Datos", 0, "keep", 0), wire("keep", 0, "strip", 0), wire("strip", 0, "look", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    assert_eq!(
        ran.output("look", 0),
        vec![json!({"n": 0, "source": "b", "prev": "strip"}), json!({"n": 1, "source": "c", "prev": "strip"})]
    );
}

/// The milestone's real flow: bash → Python → HTTP against a local server.
#[tokio::test]
async fn bash_then_python_then_http() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let log = log.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 16 * 1024];
                let mut read = 0;
                loop {
                    let n = socket.read(&mut buffer[read..]).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    read += n;
                    let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                    if let Some(head_end) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if read >= head_end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                log.lock().unwrap().push(request.clone());
                let body = request.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                let answer = format!("{{\"ok\":true,\"echo\":{}}}", if body.is_empty() { "null".into() } else { body });
                let response = format!(
                    "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    answer.len(),
                    answer
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });

    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node(
                "bash",
                "code.shell",
                json!({"shell": "auto", "script": "printf '[{\"n\":2},{\"n\":3}]'", "output": "auto"}),
            ),
            node(
                "python",
                "code.python",
                json!({"code": "print(json.dumps([{'n': i['n'], 'square': i['n'] ** 2} for i in items]))", "output": "json"}),
            ),
            node(
                "post",
                "net.http",
                json!({
                    "method": "POST",
                    "url": format!("http://127.0.0.1:{port}/items"),
                    "credential": "token",
                    "body": "json",
                    "bodyJson": "={{ JSON.stringify({ square: $json.square }) }}"
                }),
            ),
        ],
        vec![wire("start", 0, "bash", 0), wire("bash", 0, "python", 0), wire("python", 0, "post", 0)],
    );
    let ran = run(spec).await;
    if ran.outcome.status != RunStatus::Success && ran.report("python").error.as_deref().is_some_and(|e| e.contains("No Python")) {
        eprintln!("skipping: no python3 here");
        return;
    }
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?} {:?}", ran.outcome, ran.memory.logs.lock().unwrap());
    assert_eq!(ran.output("bash", 0), vec![json!({"n": 2}), json!({"n": 3})]);
    assert_eq!(ran.output("python", 0), vec![json!({"n": 2, "square": 4}), json!({"n": 3, "square": 9})]);
    assert_eq!(
        ran.output("post", 0),
        vec![json!({"ok": true, "echo": {"square": 4}}), json!({"ok": true, "echo": {"square": 9}})]
    );
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].contains("authorization: Bearer s3cret") || requests[0].contains("Authorization: Bearer s3cret"));
    let logs = ran.memory.logs.lock().unwrap();
    assert!(logs.iter().any(|(_, stream, text)| *stream == LogStream::Info && text.contains("→ 201")));
    assert!(!logs.iter().any(|(_, _, text)| text.contains("s3cret")), "the secret is never logged");
}

#[tokio::test]
async fn a_failure_stops_the_run_unless_told_to_continue() {
    let failing = || node("fail", "code.shell", json!({"script": "echo boom >&2; exit 3"}));
    let spec = flow(
        vec![node("start", "trigger.manual", json!({})), failing(), node("after", "transform.set", json!({}))],
        vec![wire("start", 0, "fail", 0), wire("fail", 0, "after", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert_eq!(ran.outcome.error_node.as_deref(), Some("fail"));
    assert!(ran.outcome.error.as_deref().unwrap().contains("exited with code 3"));
    assert!(ran.outcome.error.as_deref().unwrap().contains("boom"));

    let mut carry_on = failing();
    carry_on.settings = json!({"onError": "continue"});
    let spec = flow(
        vec![node("start", "trigger.manual", json!({})), carry_on, node("after", "transform.set", json!({}))],
        vec![wire("start", 0, "fail", 0), wire("fail", 0, "after", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success);
    assert_eq!(ran.status("fail"), NodeStatus::Error);
    assert!(ran.output("after", 0)[0]["error"].as_str().unwrap().contains("exited with code 3"));

    let mut routed = failing();
    routed.settings = json!({"onError": "errorOutput"});
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            routed,
            node("ok", "transform.set", json!({})),
            node("handler", "transform.set", json!({})),
        ],
        vec![wire("start", 0, "fail", 0), wire("fail", 0, "ok", 0), wire("fail", 1, "handler", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success);
    assert_eq!(ran.status("ok"), NodeStatus::Skipped);
    assert_eq!(ran.output("handler", 0).len(), 1);
}

#[tokio::test]
async fn retries_try_again_until_it_works() {
    let marker = std::env::temp_dir().join(format!("cf-retry-{}", uuid::Uuid::new_v4()));
    let script = format!(
        "if [ -f '{0}' ]; then echo '{{\"ok\":true}}'; else touch '{0}'; exit 1; fi",
        marker.display()
    );
    let mut flaky = node("flaky", "code.shell", json!({"script": script}));
    flaky.settings = json!({"retryOnFail": true, "maxTries": 3, "waitBetweenTries": 10});
    let spec = flow(vec![node("start", "trigger.manual", json!({})), flaky], vec![wire("start", 0, "flaky", 0)]);
    let ran = run(spec).await;
    let _ = std::fs::remove_file(&marker);
    assert_eq!(ran.outcome.status, RunStatus::Success);
    assert_eq!(ran.report("flaky").attempts, 2);
    assert_eq!(ran.output("flaky", 0), vec![json!({"ok": true})]);
}

#[cfg(unix)]
fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Stop ends the run promptly and takes the process tree with it — the child the script started
/// included, which is the part a plain `Child::kill` leaves running.
#[cfg(unix)]
#[tokio::test]
async fn cancel_stops_the_whole_process_tree() {
    let pid_file = std::env::temp_dir().join(format!("cf-pid-{}", uuid::Uuid::new_v4()));
    let script = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
    let spec = flow(
        vec![node("start", "trigger.manual", json!({})), node("slow", "code.shell", json!({"shell": "sh", "script": script}))],
        vec![wire("start", 0, "slow", 0)],
    );
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    let waiter = pid_file.clone();
    tokio::spawn(async move {
        for _ in 0..100 {
            if waiter.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        stopper.cancel();
    });
    let ran = run_with(spec, RunMode::Full, HashMap::new(), cancel).await;
    assert_eq!(ran.outcome.status, RunStatus::Canceled);
    assert!(ran.elapsed < Duration::from_secs(10), "took {:?}", ran.elapsed);
    assert_eq!(ran.status("slow"), NodeStatus::Canceled);
    let grandchild: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    let _ = std::fs::remove_file(&pid_file);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!alive(grandchild), "the sleep the script started is gone too");
}

#[tokio::test]
async fn a_time_limit_fails_the_attempt() {
    let mut slow = node("slow", "code.shell", json!({"script": "sleep 20"}));
    slow.settings = json!({"timeoutSec": 0.5});
    let spec = flow(vec![node("start", "trigger.manual", json!({})), slow], vec![wire("start", 0, "slow", 0)]);
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.as_deref().unwrap().contains("Timed out"), "{:?}", ran.outcome);
    assert!(ran.elapsed < Duration::from_secs(8), "took {:?}", ran.elapsed);
}

/// Two waits side by side take as long as one.
#[tokio::test]
async fn parallel_branches_run_together() {
    let wait = |id: &str| node(id, "logic.wait", json!({"mode": "duration", "amount": 0.4, "unit": "seconds"}));
    let spec = flow(
        vec![node("start", "trigger.manual", json!({})), wait("a"), wait("b"), node("join", "logic.merge", json!({}))],
        vec![wire("start", 0, "a", 0), wire("start", 0, "b", 0), wire("a", 0, "join", 0), wire("b", 0, "join", 1)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success);
    assert_eq!(ran.output("join", 0).len(), 2, "the merge waited for both");
    assert!(ran.elapsed < Duration::from_millis(750), "took {:?}", ran.elapsed);
}

#[tokio::test]
async fn pins_stand_in_and_a_step_reads_its_parents() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("api", "code.shell", json!({"script": "exit 9"})),
            node("shape", "transform.set", json!({"assignments": [{"name": "double", "value": "={{ $json.n * 2 }}"}]})),
        ],
        vec![wire("start", 0, "api", 0), wire("api", 0, "shape", 0)],
    );
    let pins = HashMap::from([("api".to_string(), vec![vec![Item::new(json!({"n": 21}))]])]);
    let ran = run_with(spec.clone(), RunMode::Full, pins.clone(), CancellationToken::new()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "the failing script never ran");
    assert_eq!(ran.status("api"), NodeStatus::Pinned);
    assert_eq!(ran.output("shape", 0), vec![json!({"n": 21, "double": 42})]);

    let ran = run_with(spec, RunMode::Step { node: "shape".into() }, pins, CancellationToken::new()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success);
    assert!(!ran.memory.started.lock().unwrap().contains(&"start".to_string()), "a step runs one node");
    assert_eq!(ran.output("shape", 0), vec![json!({"n": 21, "double": 42})]);
}

#[tokio::test]
async fn state_vars_text_date_and_notify() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("count", "data.state", json!({"operation": "increment", "key": "runs", "amount": 2, "target": "runs"})),
            node("remember", "data.vars", json!({"operation": "set", "name": "LAST", "value": "={{ $json.runs }}"})),
            node("read", "data.vars", json!({"operation": "get", "name": "LAST", "target": "last"})),
            node("slug", "transform.text", json!({"operation": "case", "value": "=Hola Mundo {{ $vars.region }}", "style": "slug", "target": "slug"})),
            node("when", "transform.date", json!({"operation": "format", "value": "2026-10-04T15:00:00Z", "zone": "UTC", "format": "custom", "customFormat": "dd/MM/yyyy", "target": "day"})),
            node("ping", "app.notify", json!({"title": "Listo", "body": "={{ $json.slug }} {{ $json.day }}"})),
        ],
        vec![
            wire("start", 0, "count", 0),
            wire("count", 0, "remember", 0),
            wire("remember", 0, "read", 0),
            wire("read", 0, "slug", 0),
            wire("slug", 0, "when", 0),
            wire("when", 0, "ping", 0),
        ],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    assert_eq!(
        ran.output("ping", 0),
        vec![json!({"runs": 2, "last": "2", "slug": "hola-mundo-cl", "day": "04/10/2026"})]
    );
    assert_eq!(ran.memory.notes.lock().unwrap()[0], ("Listo".to_string(), "hola-mundo-cl 04/10/2026".to_string()));
    assert_eq!(ran.memory.state.lock().unwrap()["runs"], json!(2));
}

#[tokio::test]
async fn sort_split_aggregate_and_dedupe() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("orders", "return [{c: 'b', lines: [{q: 2}, {q: 3}]}, {c: 'a', lines: [{q: 5}]}, {c: 'b', lines: []}];"),
            node("lines", "transform.split", json!({"field": "lines", "include": "all", "destination": "line"})),
            node("totals", "transform.aggregate", json!({"mode": "summarize", "groupBy": ["c"], "aggregations": [{"op": "sum", "field": "line.q", "as": "q"}, {"op": "count", "field": "", "as": "n"}]})),
            node("order", "transform.sort", json!({"keys": [{"field": "c", "order": "asc"}]})),
            node("unique", "transform.dedupe", json!({"compare": "fields", "fields": ["c"]})),
        ],
        vec![
            wire("start", 0, "orders", 0),
            wire("orders", 0, "lines", 0),
            wire("lines", 0, "totals", 0),
            wire("totals", 0, "order", 0),
            wire("order", 0, "unique", 0),
        ],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    assert_eq!(ran.output("lines", 0).len(), 3, "the empty list made no items");
    assert_eq!(ran.output("order", 0), vec![json!({"c": "a", "q": 5, "n": 1}), json!({"c": "b", "q": 5, "n": 2})]);
    assert_eq!(ran.output("unique", 0).len(), 2);
}

/// Milestone 6 brought the last nodes: the whole catalogue runs, the notebook (the last to arrive)
/// reaching its own executor rather than the "arrives in milestone" refusal.
#[tokio::test]
async fn every_node_of_the_catalogue_runs() {
    let later: Vec<&str> = crate::flows::catalog::CATALOG
        .iter()
        .filter(|descriptor| descriptor.milestone > crate::flows::catalog::RUNS_THROUGH)
        .map(|descriptor| descriptor.type_id)
        .collect();
    assert!(later.is_empty(), "not running yet: {later:?}");
    let spec = flow(
        vec![node("start", "trigger.manual", json!({})), node("book", "code.notebook", json!({}))],
        vec![wire("start", 0, "book", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.as_deref().unwrap().contains("notebook's path"), "{:?}", ran.outcome.error);
}

/// A run something outside started: the trigger's output is what the event gave.
#[tokio::test]
async fn a_fired_trigger_hands_on_what_the_event_gave() {
    let spec = flow(
        vec![
            node("hook", "trigger.webhook", json!({})),
            node("shape", "transform.set", json!({"assignments": [{"name": "who", "value": "={{ $json.body.user }}"}]})),
            node("answer", "net.respond", json!({"status": 201, "body": "={{ JSON.stringify({ hello: $json.who }) }}", "contentType": "application/json"})),
        ],
        vec![wire("hook", 0, "shape", 0), wire("shape", 0, "answer", 0)],
    );
    let memory = Arc::new(Memory::default());
    let dir = std::env::temp_dir().join(format!("cf-flow-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut plan = plan(&spec, &RunMode::Full, Some("hook"), &HashMap::new(), &HashMap::new()).unwrap();
    plan.trigger_output = Some(vec![vec![Item::new(json!({"body": {"user": "ana"}}))]]);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let run = Arc::new(RunContext {
        run_id: "run-2".into(),
        flow_id: "flow-1".into(),
        flow_name: "Webhook".into(),
        workspace_id: "w1".into(),
        mode: "trigger".into(),
        vars: serde_json::Map::new(),
        timezone: None,
        locale: "es".into(),
        host: Arc::new(Host { memory: memory.clone(), dir: dir.clone(), script: Arc::new(Script::default()) }),
        cancel: CancellationToken::new(),
        respond: Mutex::new(Some(tx)),
        depth: 0,
        ai_per_hour: 0,
    });
    let outcome = execute(Arc::new(spec), plan, run).await;
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(outcome.status, RunStatus::Success, "{outcome:?}");
    let reply = rx.await.expect("the respond node answered");
    assert_eq!(reply.status, 201);
    assert_eq!(serde_json::from_slice::<Value>(&reply.body).unwrap(), json!({"hello": "ana"}));
    assert_eq!(outcome.last_output.len(), 1, "the last node's output is the run's answer");
    let reports = memory.reports.lock().unwrap();
    let hook = reports.iter().find(|r| r.node_id == "hook").unwrap();
    assert_eq!(hook.status, NodeStatus::Success);
}

#[tokio::test]
async fn execute_flow_and_service_go_through_the_host() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("data", "return [{n: 1}, {n: 2}];"),
            node("call", "logic.subflow", json!({"flow": "child", "mode": "wait"})),
            node("api", "code.service", json!({"service": "svc-1", "action": "start"})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "call", 0), wire("call", 0, "api", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome);
    assert_eq!(ran.output("call", 0), vec![json!({"child": true, "got": {"n": 1}}), json!({"child": true, "got": {"n": 2}})]);
    assert_eq!(ran.output("api", 0), vec![json!({"status": "ready"})]);
}

// ------------------------------------------------------------------------------------------- AI

async fn run_ai(spec: FlowSpec, script: Arc<Script>) -> Ran {
    run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script, Memory::default(), "flow-ai", 0).await
}

fn logs_of(ran: &Ran, id: &str) -> Vec<String> {
    ran.memory.logs.lock().unwrap().iter().filter(|(node, _, _)| node == id).map(|(_, _, text)| text.clone()).collect()
}

#[tokio::test]
async fn an_agent_answer_that_misses_its_schema_is_asked_once_more() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("data", "return [{ticket: 'A-1'}];"),
            node(
                "agent",
                "ai.agent",
                json!({
                    "engine": {"provider": "claude", "model": "claude-sonnet-5-5"},
                    "prompt": "=Cuenta los errores de {{ $json.ticket }}",
                    "data": "registro",
                    "output": "json",
                    "schemaFields": [{"name": "count", "type": "integer"}, {"name": "note", "type": "string", "required": false}],
                }),
            ),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "agent", 0)],
    );
    let script = Script::answering(vec![Ok("Hay tres errores."), Ok("{\"count\": 3, \"note\": null}")]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("agent", 0);
    assert_eq!(out[0]["data"], json!({"count": 3, "note": null}));
    assert_eq!(out[0]["engine"], "claude");
    assert_eq!(out[0]["sessionId"], "sess-1");
    let calls = script.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].prompt.starts_with("Cuenta los errores de A-1"), "{}", calls[0].prompt);
    assert!(calls[0].prompt.contains("JSON Schema"));
    assert_eq!(calls[0].data, "registro");
    assert!(calls[0].schema.is_some(), "the schema goes to the CLIs that enforce one");
    assert!(!calls[0].can_edit, "read-only by default");
    assert!(calls[1].prompt.contains("no cumplió el esquema"), "{}", calls[1].prompt);
    assert!(calls[1].prompt.contains("Hay tres errores."));
    assert_eq!(ran.report("agent").outputs[0][0].paired, Some(0));
}

#[tokio::test]
async fn a_schema_missed_twice_fails_the_node() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("agent", "ai.agent", json!({"prompt": "Dame JSON", "output": "json", "schemaFields": [{"name": "ok", "type": "boolean"}]})),
        ],
        vec![wire("start", 0, "agent", 0)],
    );
    let script = Script::answering(vec![Ok("{\"ok\": \"yes\"}"), Ok("{\"ok\": \"still yes\"}")]);
    let ran = run_ai(spec, script).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    let error = ran.outcome.error.unwrap_or_default();
    assert!(error.contains("even after a retry") && error.contains("$.ok: expected boolean"), "{error}");
}

#[tokio::test]
async fn out_of_quota_falls_back_to_the_next_engine_but_never_to_another_account() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node(
                "agent",
                "ai.agent",
                json!({
                    "engine": {"provider": "claude", "account": "work"},
                    "fallbackEngines": [{"provider": "claude", "account": "personal"}, {"provider": "codex", "model": "gpt-5.6"}],
                    "prompt": "Hola",
                    "session": "continue",
                }),
            ),
        ],
        vec![wire("start", 0, "agent", 0)],
    );
    let script = Script::answering(vec![
        Err("QUOTA_EXCEEDED::You've hit your session limit · resets 12am (America/Santiago)"),
        Ok("respuesta de codex"),
    ]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("agent", 0);
    assert_eq!(out[0]["engine"], "codex");
    assert_eq!(out[0]["text"], "respuesta de codex");
    let calls = script.calls.lock().unwrap();
    let asked: Vec<(&str, &str)> = calls.iter().map(|c| (c.engine.provider.as_str(), c.engine.account.as_str())).collect();
    assert_eq!(asked, vec![("claude", "work"), ("codex", "")], "the second Claude account is not a fallback");
    assert!(calls[1].session.is_none(), "a session belongs to the engine that opened it");
    assert!(logs_of(&ran, "agent").iter().any(|line| line.contains("out of quota — asking Codex")));
    // A fallback's session is not kept as the node's.
    assert!(ran.memory.state.lock().unwrap().get("ai-session:agent").is_none());
}

#[tokio::test]
async fn out_of_quota_with_no_fallback_waits_for_the_plan_to_reopen() {
    let spec = flow(
        vec![node("start", "trigger.manual", json!({})), node("agent", "ai.agent", json!({"prompt": "Hola"}))],
        vec![wire("start", 0, "agent", 0)],
    );
    let reopens = chrono::Utc::now().timestamp() + 2;
    let refusal = format!("QUOTA_EXCEEDED::Claude AI usage limit reached|{reopens}");
    let script = Script::answering(vec![Err(refusal.as_str()), Ok("ya hay cuota")]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("agent", 0)[0]["text"], "ya hay cuota");
    assert!(ran.elapsed >= Duration::from_secs(1), "it waited: {:?}", ran.elapsed);
    assert!(logs_of(&ran, "agent").iter().any(|line| line.contains("waits until")));
    assert_eq!(script.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_quota_that_reopens_too_late_fails_now_and_says_why() {
    let spec = flow(
        vec![node("start", "trigger.manual", json!({})), node("agent", "ai.agent", json!({"prompt": "Hola"}))],
        vec![wire("start", 0, "agent", 0)],
    );
    let script = Script::answering(vec![Err("QUOTA_EXCEEDED::You've hit your weekly limit · resets Mon 9am")]);
    *script.quota.lock().unwrap() = Some((100.0, (chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339()));
    let ran = run_ai(spec, script).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.unwrap_or_default().contains("weekly limit"));
}

#[tokio::test]
async fn the_hourly_cap_stops_a_runaway_loop() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("data", "return [{n: 1}, {n: 2}, {n: 3}];"),
            node("agent", "ai.agent", json!({"prompt": "=Item {{ $json.n }}"})),
        ],
        vec![wire("start", 0, "data", 0), wire("data", 0, "agent", 0)],
    );
    let script = Script::answering(vec![Ok("uno"), Ok("dos"), Ok("tres")]);
    *script.quota.lock().unwrap() = Some((85.0, String::new()));
    let ran = run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script.clone(), Memory::default(), "flow-cap", 2).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.clone().unwrap_or_default().contains("cap of 2 AI calls an hour"));
    assert_eq!(script.calls.lock().unwrap().len(), 2);
    assert!(logs_of(&ran, "agent").iter().any(|line| line.contains("used 85 % of its plan")));
}

#[tokio::test]
async fn a_kept_session_is_resumed_and_saved() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("agent", "ai.agent", json!({"engine": {"provider": "claude"}, "prompt": "Sigue", "session": "continue"})),
        ],
        vec![wire("start", 0, "agent", 0)],
    );
    let memory = Memory::default();
    memory.state.lock().unwrap().insert("ai-session:agent".into(), json!({"provider": "claude", "account": "", "session": "old"}));
    let script = Script::answering(vec![Ok("listo")]);
    let ran = run_scripted(spec, RunMode::Full, HashMap::new(), CancellationToken::new(), script.clone(), memory, "flow-ai", 0).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(script.calls.lock().unwrap()[0].session.as_deref(), Some("old"));
    assert_eq!(ran.memory.state.lock().unwrap()["ai-session:agent"]["session"], "sess-1");
}

#[tokio::test]
async fn an_editing_agent_leaves_a_restore_point_the_run_can_undo() {
    let repo_dir = std::env::temp_dir().join(format!("cf-flow-repo-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&repo_dir).unwrap();
    let repo = git2::Repository::init(&repo_dir).unwrap();
    std::fs::write(repo_dir.join("a.txt"), "original\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("a.txt")).unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test", "test@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
    let root = repo_dir.canonicalize().unwrap().to_string_lossy().into_owned();

    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node(
                "agent",
                "ai.agent",
                json!({"prompt": "Arregla a.txt", "workIn": "project", "project": "p1", "access": "edit", "mcp": ["github"]}),
            ),
        ],
        vec![wire("start", 0, "agent", 0)],
    );
    let script = Script::answering(vec![Ok("Listo, edité a.txt")]);
    script.projects.lock().unwrap().insert("p1".into(), root.clone());
    *script.touch.lock().unwrap() = Some("a.txt".into());
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let out = ran.output("agent", 0);
    assert_eq!(out[0]["changedFiles"], json!(["a.txt"]));
    {
        let calls = script.calls.lock().unwrap();
        assert!(calls[0].can_edit);
        assert_eq!(calls[0].mcp, vec!["github".to_string()]);
        assert_eq!(calls[0].cwd.as_deref(), Some(root.as_str()));
    }
    let recorded = script.edits.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    let recorded_root = recorded[0].clone();
    assert!(std::fs::read_to_string(repo_dir.join("a.txt")).unwrap().contains("edited by the agent"));
    let touched = crate::git::checkpoint::restore_flow(&recorded_root, "run-1").unwrap();
    assert_eq!(touched, vec!["a.txt".to_string()]);
    assert_eq!(std::fs::read_to_string(repo_dir.join("a.txt")).unwrap(), "original\n");
    crate::git::checkpoint::remove_flow_baseline(&recorded_root, "run-1");
    let _ = std::fs::remove_dir_all(&repo_dir);
}

#[tokio::test]
async fn classify_and_extract_write_onto_the_item() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("mail", "return [{id: 1, text: 'Me cobraron dos veces la cuota de octubre por 45.990'}];"),
            node(
                "kind",
                "ai.classify",
                json!({"categories": [{"name": "cobros", "description": "pagos y facturas"}, {"name": "errores"}], "allowOther": true}),
            ),
            node(
                "fields",
                "ai.extract",
                json!({"schemaFields": [{"name": "amount", "type": "number"}, {"name": "month", "type": "string"}]}),
            ),
        ],
        vec![wire("start", 0, "mail", 0), wire("mail", 0, "kind", 0), wire("kind", 0, "fields", 0)],
    );
    let script = Script::answering(vec![
        Ok("{\"category\": \"cobros\", \"reason\": \"habla de un cobro\"}"),
        Ok("```json\n{\"amount\": 45990, \"month\": \"octubre\"}\n```"),
    ]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let classified = ran.output("kind", 0);
    assert_eq!(classified[0]["category"], "cobros");
    assert_eq!(classified[0]["id"], 1, "the item's own fields stay");
    let extracted = ran.output("fields", 0);
    assert_eq!(extracted[0]["data"], json!({"amount": 45990, "month": "octubre"}));
    assert_eq!(extracted[0]["category"], "cobros");
    let calls = script.calls.lock().unwrap();
    let enum_values = &calls[0].schema.as_ref().unwrap()["properties"]["category"]["enum"];
    assert_eq!(enum_values, &json!(["cobros", "errores", "other"]));
    assert!(calls[0].data.contains("dos veces"), "the text goes on stdin");
    assert!(!calls[0].can_edit);
}

#[tokio::test]
async fn a_local_model_answers_as_a_node_and_as_a_fallback() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node(
                "local",
                "ai.local",
                json!({"server": "ollama", "model": "qwen2.5-coder:7b", "prompt": "Saluda", "output": "json", "schemaFields": [{"name": "greeting"}]}),
            ),
            node(
                "summary",
                "ai.summarize",
                json!({"text": "=texto largo", "engine": {"provider": "claude"}, "fallbackEngines": [{"provider": "local"}]}),
            ),
        ],
        vec![wire("start", 0, "local", 0), wire("local", 0, "summary", 0)],
    );
    let script = Script::answering(vec![Ok("{\"greeting\": \"hola\"}"), Err("Not logged in · Please run /login"), Ok("Un resumen.")]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    assert_eq!(ran.output("local", 0)[0]["data"], json!({"greeting": "hola"}));
    let summary = ran.output("summary", 0);
    assert_eq!(summary[0]["summary"], "Un resumen.");
    assert_eq!(summary[0]["ai"]["engine"], "local");
    let local_calls = script.local_calls.lock().unwrap();
    assert_eq!(local_calls.len(), 2);
    assert_eq!(local_calls[0].server, "ollama");
    assert_eq!(local_calls[0].model, "qwen2.5-coder:7b");
    assert!(local_calls[0].schema.is_some());
    assert_eq!(local_calls[1].server, "auto", "a fallback uses Settings' local model");
    assert!(local_calls[1].prompt.contains("texto largo"), "the text rides in the prompt for a local model");
}

#[tokio::test]
async fn review_and_commit_read_their_answers() {
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("review", "ai.review", json!({"diffSource": "diffText", "diff": "+let token = 'abc';"})),
            node("commit", "ai.commit", json!({"diffSource": "diffText", "diff": "+let token = 'abc';"})),
            node("empty", "ai.review", json!({"diffSource": "diffText", "diff": "  "})),
        ],
        vec![wire("start", 0, "review", 0), wire("review", 0, "commit", 0), wire("start", 0, "empty", 0)],
    );
    let script = Script::answering(vec![
        Ok("📈 CALIDAD: Fiabilidad=A Seguridad=D Mantenibilidad=A\n\n### 🚨 [Crítico · Seguridad] Token en el código · F-001\n\n📍 Ubicación: src/a.ts:1-1\n"),
        Ok("feat: add token handling"),
    ]);
    let ran = run_ai(spec, script.clone()).await;
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
    let review = ran.output("review", 0);
    assert_eq!(review[0]["findingCount"], 1);
    assert_eq!(review[0]["quality"]["security"], "D");
    assert_eq!(review[0]["findings"][0]["location"], "src/a.ts:1-1");
    assert_eq!(ran.output("commit", 0)[0]["message"], "feat: add token handling");
    assert_eq!(ran.output("empty", 0)[0]["empty"], true);
    let calls = script.calls.lock().unwrap();
    assert_eq!(calls.len(), 2, "an empty diff asks nobody");
    assert!(calls[0].data.starts_with("DIFF:\n+let token"));
}

mod milestone4;
mod milestone5;
mod milestone6;
mod milestone7;
mod milestone8;
mod milestone9;
mod milestone10;
mod milestone11;
