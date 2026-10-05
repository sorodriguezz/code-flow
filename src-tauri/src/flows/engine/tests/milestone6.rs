//! Milestone 6's nodes: the declarative connectors and the notebook.
//!
//! The notebook tests need a Python with ipykernel and say "skipped" without one — nothing is ever
//! installed for them. Point `CODEFLOW_TEST_VENV` at a virtualenv that has it to run them:
//!
//! ```sh
//! uv venv /tmp/cf-kernel && uv pip install --python /tmp/cf-kernel/bin/python ipykernel
//! CODEFLOW_TEST_VENV=/tmp/cf-kernel cargo test --lib milestone6
//! ```

use std::path::{Path, PathBuf};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;

fn succeeded(ran: &Ran) {
    assert_eq!(ran.outcome.status, RunStatus::Success, "{:?}", ran.outcome.error);
}

/// A server for exactly one request: answers `status` with `body`, and hands back what it got.
async fn one_request(status: &'static str, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&received).into_owned();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                if received.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let reply =
            format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        socket.write_all(reply.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&received).into_owned()
    });
    (address, task)
}

fn discord(webhook: &str, fields: Value) -> FlowNode {
    node(
        "post",
        "net.connector",
        json!({"call": {"connector": "discord", "operation": "webhookMessage", "fields": fields}, "credential": format!("webhook:{webhook}")}),
    )
}

#[tokio::test]
async fn a_connector_fills_its_fields_from_the_item_and_calls_the_service() {
    let (address, server) = one_request("204 No Content", "").await;
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("order", "return [{ id: 7, customer: 'Ana' }];"),
            discord(&format!("{address}/api/webhooks/1/tok"), json!({"content": "=Pedido {{ $json.id }} de {{ $json.customer }}"})),
        ],
        vec![wire("start", 0, "order", 0), wire("order", 0, "post", 0)],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    assert_eq!(ran.output("post", 0), vec![json!({"ok": true, "status": 204})]);
    let request = server.await.unwrap();
    assert!(request.starts_with("POST /api/webhooks/1/tok HTTP/1.1"), "{request}");
    assert!(request.ends_with(r#"{"content":"Pedido 7 de Ana"}"#), "the empty username is left out: {request}");
}

#[tokio::test]
async fn a_connector_says_what_is_missing() {
    let spec = flow(
        vec![node("start", "trigger.manual", json!({})), discord("https://discord.example.com/api/webhooks/1/x", json!({"content": " "}))],
        vec![wire("start", 0, "post", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.as_deref().unwrap().contains("Fill in “Message”"), "{:?}", ran.outcome.error);

    let slack = node("post", "net.connector", json!({"call": {"connector": "slack", "operation": "postMessage", "fields": {"channel": "#c", "text": "x"}}}));
    let ran = run(flow(vec![node("start", "trigger.manual", json!({})), slack], vec![wire("start", 0, "post", 0)])).await;
    assert!(ran.outcome.error.as_deref().unwrap().contains("credential for Slack"), "{:?}", ran.outcome.error);
}

/// The virtualenv with ipykernel the notebook tests run on, if this machine was given one.
fn test_venv() -> Option<PathBuf> {
    let venv = PathBuf::from(std::env::var_os("CODEFLOW_TEST_VENV")?);
    let python = venv.join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" });
    python.is_file().then_some(venv)
}

/// A folder holding `notebook` (as `informe.ipynb`) and a `.venv` that is the test virtualenv —
/// where the node's kernel discovery looks first.
fn notebook_folder(venv: &Path, cells: Value) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cf-notebook-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(venv, dir.join(".venv")).unwrap();
    let notebook = json!({
        "cells": cells,
        "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    });
    std::fs::write(dir.join("informe.ipynb"), serde_json::to_string_pretty(&notebook).unwrap()).unwrap();
    dir
}

fn cell(source: &str, tags: &[&str]) -> Value {
    json!({"cell_type": "code", "execution_count": null, "id": uuid::Uuid::new_v4().simple().to_string()[..8], "metadata": {"tags": tags}, "outputs": [], "source": source})
}

#[tokio::test]
async fn a_notebook_runs_with_its_parameters_and_saves_what_it_printed() {
    let Some(venv) = test_venv() else {
        eprintln!("skipped: CODEFLOW_TEST_VENV is not a virtualenv with ipykernel");
        return;
    };
    let dir = notebook_folder(
        &venv,
        json!([
            cell("cliente = 'nadie'\ntotal = 0", &["parameters"]),
            cell("print(f'{cliente}: {total}')", &[]),
            json!({"cell_type": "markdown", "id": "md", "metadata": {}, "source": "# Resultado"}),
            cell("{'doble': total * 2}", &[]),
        ]),
    );
    let book = dir.join("informe.ipynb");
    let copy = dir.join("salida/informe-ejecutado.ipynb");
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            code("order", "return [{ customer: 'Ana', total: 21 }];"),
            node(
                "book",
                "code.notebook",
                json!({
                    "path": book.to_string_lossy(),
                    "notebookParams": "={{ JSON.stringify({ cliente: $json.customer, total: $json.total }) }}",
                    "saveRun": "saveCopy",
                    "copyPath": copy.to_string_lossy(),
                }),
            ),
        ],
        vec![wire("start", 0, "order", 0), wire("order", 0, "book", 0)],
    );
    let ran = run(spec).await;
    succeeded(&ran);
    let item = &ran.output("book", 0)[0];
    assert_eq!(item["stdout"], "Ana: 21\n");
    assert_eq!(item["result"], "{'doble': 42}");
    assert_eq!(item["cellsRun"], 4, "the injected cell counts");
    assert!(logs_of(&ran, "book").iter().any(|line| line == "Ana: 21"), "{:?}", logs_of(&ran, "book"));

    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&copy).unwrap()).unwrap();
    let cells = saved["cells"].as_array().unwrap();
    assert_eq!(cells.len(), 5);
    assert_eq!(cells[1]["metadata"]["tags"], json!(["injected-parameters"]), "right after the parameters cell");
    assert_eq!(cells[2]["outputs"][0]["text"], json!(["Ana: 21\n"]));
    assert_eq!(cells[4]["outputs"][0]["output_type"], "execute_result");
    let original: Value = serde_json::from_str(&std::fs::read_to_string(&book).unwrap()).unwrap();
    assert_eq!(original["cells"].as_array().unwrap().len(), 4, "the notebook itself is left as it was");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_failing_cell_stops_the_notebook_and_the_saved_run_shows_where() {
    let Some(venv) = test_venv() else {
        eprintln!("skipped: CODEFLOW_TEST_VENV is not a virtualenv with ipykernel");
        return;
    };
    let dir = notebook_folder(&venv, json!([cell("x = 1", &[]), cell("x / 0", &[]), cell("print('never')", &[])]));
    let book = dir.join("informe.ipynb");
    let spec = flow(
        vec![
            node("start", "trigger.manual", json!({})),
            node("book", "code.notebook", json!({"path": book.to_string_lossy(), "saveRun": "overwrite"})),
        ],
        vec![wire("start", 0, "book", 0)],
    );
    let ran = run(spec).await;
    assert_eq!(ran.outcome.status, RunStatus::Error);
    assert!(ran.outcome.error.as_deref().unwrap().contains("Cell 2: ZeroDivisionError: division by zero"), "{:?}", ran.outcome.error);
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&book).unwrap()).unwrap();
    assert_eq!(saved["cells"][1]["outputs"][0]["ename"], "ZeroDivisionError");
    assert_eq!(saved["cells"][2]["outputs"], json!([]), "nothing after the failure ran");
    assert!(std::fs::read_to_string(&book).unwrap().starts_with("{\n \"cells\": [\n  {\n"), "Jupyter's own layout");
    let _ = std::fs::remove_dir_all(&dir);
}
