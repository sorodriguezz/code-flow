//! The "Notebook" node: runs an `.ipynb` top to bottom on a Jupyter kernel — the editor's own kernel
//! layer (`crate::jupyter`), started for the run and stopped after it.
//!
//! **Papermill's contract, not a new one.** Parameters go in as a cell of their own right after the
//! cell tagged `parameters` (or first, when none is), so a notebook written for papermill runs here
//! unchanged. A failing cell stops the run, as "run all" does; what ran is still saved when the node
//! saves, error included, so the notebook shows where it stopped.
//!
//! **A fresh kernel per run.** Nothing one run leaves in memory reaches the next. The kernel is
//! registered with `crate::jupyter`, so quitting the app stops it like any notebook's, and a guard
//! stops it when the node ends however it ends.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use super::files::expand;
use super::{text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};
use crate::jupyter::kernel::{Channel, Kernel, KernelEvents, Lifecycle};
use crate::jupyter::kernelspec::KernelChoice;
use crate::jupyter::wire::Message;

/// How long a kernel has to leave when the node is done with it.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let once = ctx.param_str("runFor") != "each";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let paired = !ctx.items().is_empty();
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let json = run(ctx, params).await?;
        out.push(if paired { Item::paired(json, index) } else { Item::new(json) });
    }
    Ok(vec![out])
}

/// What the kernel said, as the node reads it.
enum Event {
    Message(Channel, Message),
    Died(String),
}

struct Events {
    tx: mpsc::UnboundedSender<Event>,
}

impl KernelEvents for Events {
    fn message(&self, _kernel_id: &str, channel: Channel, message: &Message) {
        let _ = self.tx.send(Event::Message(channel, message.clone()));
    }

    fn lifecycle(&self, _kernel_id: &str, lifecycle: Lifecycle) {
        if let Lifecycle::Died { code, stderr } = lifecycle {
            let code = code.map(|c| format!(" (code {c})")).unwrap_or_default();
            let _ = self.tx.send(Event::Died(format!("The kernel died{code}: {}", stderr.trim())));
        }
    }
}

/// Stops the kernel when the node is done — returned, failed, cancelled or dropped.
struct Running(Arc<Kernel>);

impl Drop for Running {
    fn drop(&mut self) {
        let kernel = self.0.clone();
        crate::jupyter::remove(&kernel.id);
        tauri::async_runtime::spawn(async move { kernel.shutdown(SHUTDOWN_GRACE).await });
    }
}

async fn run(ctx: &NodeCtx, params: &Value) -> Result<Value, NodeError> {
    let raw_path = text(params, "path");
    if raw_path.trim().is_empty() {
        return Err(NodeError::failed("Write the notebook's path"));
    }
    let path = expand(&raw_path);
    let source = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| NodeError::failed(format!("Could not read {}: {e}", path.display())))?;
    let mut notebook: Value =
        serde_json::from_str(&source).map_err(|e| NodeError::failed(format!("{} is not a notebook: {e}", path.display())))?;
    if notebook.get("nbformat").and_then(Value::as_u64) != Some(4) {
        return Err(NodeError::failed("Only notebooks in Jupyter's format 4 run here"));
    }
    let folder = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));

    let parameters = notebook_parameters(params)?;
    let wanted = text(params, "kernelName");
    let choice = pick_kernel(&folder, wanted.trim(), &notebook).await?;
    if !parameters.is_empty() && choice.language.to_lowercase() != "python" {
        return Err(NodeError::failed(format!("Parameters need a Python kernel; {} is {}", choice.display_name, choice.language)));
    }
    if !parameters.is_empty() {
        insert_parameters(&mut notebook, &parameters);
    }

    crate::jupyter::sweep_stale_connection_files();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = format!("flow-{}", uuid::Uuid::new_v4());
    ctx.log(LogStream::Info, &format!("{} · {}", path.display(), choice.display_name));
    let started = tokio::select! {
        started = Kernel::start(id, choice, folder, crate::jupyter::runtime_dir(), Arc::new(Events { tx })) => started,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    let (kernel, _) = started.map_err(NodeError::Failed)?;
    crate::jupyter::insert(kernel.clone());
    let running = Running(kernel);

    let mut report = Report::default();
    let mut failure = None;
    let count = notebook.get("cells").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    for index in 0..count {
        let cell = &notebook["cells"][index];
        if cell.get("cell_type").and_then(Value::as_str) != Some("code") {
            continue;
        }
        let code = joined(cell.get("source").unwrap_or(&Value::Null));
        if code.trim().is_empty() {
            continue;
        }
        let msg_id = uuid::Uuid::new_v4().to_string();
        running.0.execute(&msg_id, &code, false).await.map_err(NodeError::Failed)?;
        let mut cell_run = CellRun::default();
        loop {
            let event = tokio::select! {
                event = rx.recv() => event,
                _ = ctx.cancel.cancelled() => {
                    let _ = running.0.interrupt().await;
                    return Err(NodeError::Cancelled);
                }
            };
            let Some(event) = event else { return Err(NodeError::failed("The kernel stopped answering")) };
            match event {
                Event::Died(why) => return Err(NodeError::Failed(why)),
                Event::Message(channel, message) => {
                    if message.parent_msg_id() != Some(msg_id.as_str()) {
                        continue;
                    }
                    if let Some((stream, line)) = cell_run.take(channel, &message) {
                        ctx.log(stream, &line);
                    }
                    if cell_run.done {
                        break;
                    }
                }
            }
        }
        report.add(index, &cell_run);
        let cell = &mut notebook["cells"][index];
        cell["outputs"] = Value::Array(cell_run.outputs.clone());
        cell["execution_count"] = cell_run.count.map(Value::from).unwrap_or(Value::Null);
        if let Some(error) = cell_run.error {
            failure = Some(format!("Cell {}: {error}", index + 1));
            break;
        }
    }
    drop(running);

    let saved = match text(params, "saveRun").as_str() {
        "overwrite" => Some(path.clone()),
        "saveCopy" => {
            let target = text(params, "copyPath");
            if target.trim().is_empty() {
                return Err(NodeError::failed("Write where the copy goes"));
            }
            Some(expand(&target))
        }
        _ => None,
    };
    if let Some(target) = &saved {
        if let Some(folder) = target.parent() {
            let _ = tokio::fs::create_dir_all(folder).await;
        }
        tokio::fs::write(target, nbformat_text(&notebook))
            .await
            .map_err(|e| NodeError::failed(format!("Could not save {}: {e}", target.display())))?;
    }
    if let Some(failure) = failure {
        return Err(NodeError::Failed(failure));
    }
    let mut item = report.into_json();
    if let Some(target) = saved {
        item["saved"] = json!(target.to_string_lossy());
    }
    Ok(item)
}

/// The `parameters` field: a JSON object (text or already one), `{}` when empty.
fn notebook_parameters(params: &Value) -> Result<Map<String, Value>, NodeError> {
    let value = match params.get("notebookParams") {
        Some(Value::String(raw)) if raw.trim().is_empty() => return Ok(Map::new()),
        Some(Value::String(raw)) => {
            serde_json::from_str(raw).map_err(|e| NodeError::failed(format!("The parameters are not JSON: {e}")))?
        }
        Some(Value::Null) | None => return Ok(Map::new()),
        Some(other) => other.clone(),
    };
    match value {
        Value::Object(map) => {
            if let Some(bad) = map.keys().find(|name| !is_identifier(name)) {
                return Err(NodeError::failed(format!("“{bad}” cannot be a Python variable name")));
            }
            Ok(map)
        }
        _ => Err(NodeError::failed("The parameters must be a JSON object: {\"name\": value}")),
    }
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c == '_' || c.is_alphabetic()) && chars.all(|c| c == '_' || c.is_alphanumeric())
}

/// The kernel to run on: the one named, else the notebook's own (`metadata.kernelspec.name`), else
/// the first Python kernel this machine has.
async fn pick_kernel(folder: &Path, wanted: &str, notebook: &Value) -> Result<KernelChoice, NodeError> {
    let found = crate::jupyter::kernelspec::discover(folder, folder).await;
    let own = notebook.pointer("/metadata/kernelspec/name").and_then(Value::as_str).unwrap_or_default();
    let named = |name: &str| {
        found.kernels.iter().find(|choice| !name.is_empty() && (choice.name == name || choice.display_name == name)).cloned()
    };
    if !wanted.is_empty() {
        return named(wanted).ok_or_else(|| {
            let known: Vec<&str> = found.kernels.iter().map(|choice| choice.name.as_str()).collect();
            NodeError::failed(format!("No kernel named “{wanted}” on this computer (there is: {})", known.join(", ")))
        });
    }
    named(own)
        .or_else(|| found.kernels.iter().find(|choice| choice.language.eq_ignore_ascii_case("python")).cloned())
        .or_else(|| found.kernels.first().cloned())
        .ok_or_else(|| {
            NodeError::failed("No Jupyter kernel on this computer: install one (for Python, `pip install ipykernel`) and run again")
        })
}

/// Papermill's injected cell: after the one tagged `parameters`, else first.
fn insert_parameters(notebook: &mut Value, parameters: &Map<String, Value>) {
    let encoded = base64::engine::general_purpose::STANDARD.encode(Value::Object(parameters.clone()).to_string());
    let source = format!(
        "# Parameters\nimport base64 as _cf_b64, json as _cf_json\nglobals().update(_cf_json.loads(_cf_b64.b64decode(\"{encoded}\").decode(\"utf-8\")))\ndel _cf_b64, _cf_json\n"
    );
    let cell = json!({
        "cell_type": "code",
        "execution_count": null,
        "id": format!("injected-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
        "metadata": {"tags": ["injected-parameters"]},
        "outputs": [],
        "source": split_lines(&source),
    });
    let Some(cells) = notebook.get_mut("cells").and_then(Value::as_array_mut) else { return };
    let tagged = cells.iter().position(|cell| {
        cell.pointer("/metadata/tags").and_then(Value::as_array).is_some_and(|tags| tags.iter().any(|t| t == "parameters"))
    });
    cells.insert(tagged.map(|i| i + 1).unwrap_or(0), cell);
}

/// A cell's source or an output's text: nbformat keeps either a string or a list of lines.
fn joined(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(lines) => lines.iter().filter_map(Value::as_str).collect(),
        _ => String::new(),
    }
}

/// Text the way nbformat stores it: a list of lines, each keeping its `\n`.
fn split_lines(text: &str) -> Value {
    Value::Array(text.split_inclusive('\n').map(|line| Value::String(line.to_string())).collect())
}

/// A mime bundle with its text entries as lists of lines (images stay base64 strings).
fn stored_bundle(data: &Value) -> Value {
    match data {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(mime, value)| {
                    let keep_whole = !mime.starts_with("text/") && mime != "image/svg+xml";
                    let value = match value {
                        Value::String(text) if !keep_whole => split_lines(text),
                        other => other.clone(),
                    };
                    (mime.clone(), value)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// One cell's execution, assembled from the kernel's messages.
#[derive(Default)]
struct CellRun {
    outputs: Vec<Value>,
    count: Option<u64>,
    /// `ename: evalue` when the cell raised.
    error: Option<String>,
    stdout: String,
    stderr: String,
    result: Option<Value>,
    displays: Vec<Value>,
    idle: bool,
    replied: bool,
    done: bool,
}

impl CellRun {
    /// Takes one message; what it printed comes back to be logged as it happens.
    fn take(&mut self, channel: Channel, message: &Message) -> Option<(LogStream, String)> {
        let content = &message.content;
        let mut logged = None;
        match (channel, message.msg_type()) {
            (Channel::Iopub, "status") => self.idle = content.get("execution_state").and_then(Value::as_str) == Some("idle"),
            (Channel::Iopub, "execute_input") => self.count = content.get("execution_count").and_then(Value::as_u64).or(self.count),
            (Channel::Iopub, "stream") => {
                let name = content.get("name").and_then(Value::as_str).unwrap_or("stdout").to_string();
                let text = content.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
                if name == "stderr" { self.stderr.push_str(&text) } else { self.stdout.push_str(&text) }
                // Consecutive prints of one stream are one output, as Jupyter saves them.
                match self.outputs.last_mut() {
                    Some(last) if last["output_type"] == "stream" && last["name"] == name.as_str() => {
                        let merged = joined(&last["text"]) + &text;
                        last["text"] = split_lines(&merged);
                    }
                    _ => self.outputs.push(json!({"output_type": "stream", "name": name, "text": split_lines(&text)})),
                }
                let stream = if name == "stderr" { LogStream::Stderr } else { LogStream::Stdout };
                logged = Some((stream, text.trim_end_matches('\n').to_string()));
            }
            (Channel::Iopub, "execute_result") => {
                let data = content.get("data").cloned().unwrap_or(json!({}));
                self.count = content.get("execution_count").and_then(Value::as_u64).or(self.count);
                self.result = Some(readable(&data));
                self.outputs.push(json!({
                    "output_type": "execute_result",
                    "execution_count": self.count,
                    "data": stored_bundle(&data),
                    "metadata": content.get("metadata").cloned().unwrap_or(json!({})),
                }));
            }
            (Channel::Iopub, "display_data") => {
                let data = content.get("data").cloned().unwrap_or(json!({}));
                self.displays.push(data.clone());
                self.outputs.push(json!({
                    "output_type": "display_data",
                    "data": stored_bundle(&data),
                    "metadata": content.get("metadata").cloned().unwrap_or(json!({})),
                }));
            }
            (Channel::Iopub, "clear_output") => self.outputs.clear(),
            (Channel::Iopub, "error") => {
                let ename = content.get("ename").and_then(Value::as_str).unwrap_or("Error");
                let evalue = content.get("evalue").and_then(Value::as_str).unwrap_or_default();
                self.error = Some(format!("{ename}: {evalue}"));
                let traceback: Vec<String> =
                    content.get("traceback").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                logged = Some((LogStream::Stderr, crate::services::log::strip_ansi(&traceback.join("\n"))));
                self.outputs.push(json!({"output_type": "error", "ename": ename, "evalue": evalue, "traceback": traceback}));
            }
            (Channel::Shell, "execute_reply") => {
                self.replied = true;
                self.count = content.get("execution_count").and_then(Value::as_u64).or(self.count);
                if content.get("status").and_then(Value::as_str) == Some("aborted") && self.error.is_none() {
                    self.error = Some("the kernel aborted the cell".into());
                }
            }
            _ => {}
        }
        // Done when the reply is in and the kernel went idle for this request: every output of a
        // request is published before its idle status.
        self.done = self.replied && self.idle;
        logged
    }
}

/// What a result is worth handing on: its JSON when it has one, else its plain text.
fn readable(data: &Value) -> Value {
    if let Some(value) = data.get("application/json") {
        return value.clone();
    }
    match data.get("text/plain") {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(Value::Array(lines)) => Value::String(lines.iter().filter_map(Value::as_str).collect()),
        _ => Value::Null,
    }
}

/// The node's item: the last cell's result, everything printed, and the displays (charts, tables).
#[derive(Default)]
struct Report {
    result: Value,
    stdout: String,
    stderr: String,
    displays: Vec<Value>,
    cells: u64,
}

impl Report {
    fn add(&mut self, _index: usize, cell: &CellRun) {
        self.cells += 1;
        if let Some(result) = &cell.result {
            self.result = result.clone();
        }
        self.stdout.push_str(&cell.stdout);
        self.stderr.push_str(&cell.stderr);
        self.displays.extend(cell.displays.iter().cloned());
    }

    fn into_json(self) -> Value {
        json!({"result": self.result, "stdout": self.stdout, "stderr": self.stderr, "displays": self.displays, "cellsRun": self.cells})
    }
}

/// A notebook as Jupyter writes one: keys sorted, one-space indent, a final newline — so saving a
/// run over the notebook changes the outputs, not the whole file.
fn nbformat_text(notebook: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut entries: Vec<(&String, &Value)> = map.iter().collect();
                entries.sort_by(|a, b| a.0.cmp(b.0));
                Value::Object(entries.into_iter().map(|(key, value)| (key.clone(), sorted(value))).collect())
            }
            Value::Array(list) => Value::Array(list.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    serde::Serialize::serialize(&sorted(notebook), &mut serializer).expect("a JSON value serialises");
    let mut text = String::from_utf8(out).expect("serde_json writes UTF-8");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(msg_type: &str, parent: &str, content: Value) -> Message {
        let mut message = Message::request(msg_type, "s", content);
        message.parent_header = json!({"msg_id": parent});
        message
    }

    #[test]
    fn a_cell_run_is_assembled_the_way_jupyter_saves_it() {
        let mut cell = CellRun::default();
        let take = |cell: &mut CellRun, channel, msg_type, content| cell.take(channel, &message(msg_type, "m", content));
        take(&mut cell, Channel::Iopub, "status", json!({"execution_state": "busy"}));
        take(&mut cell, Channel::Iopub, "execute_input", json!({"execution_count": 3, "code": "x"}));
        let logged = take(&mut cell, Channel::Iopub, "stream", json!({"name": "stdout", "text": "uno\n"}));
        assert_eq!(logged, Some((LogStream::Stdout, "uno".to_string())));
        take(&mut cell, Channel::Iopub, "stream", json!({"name": "stdout", "text": "dos\ntres"}));
        take(&mut cell, Channel::Iopub, "display_data", json!({"data": {"text/plain": "<Figure>", "image/png": "iVBOR"}, "metadata": {}}));
        take(&mut cell, Channel::Iopub, "execute_result", json!({"execution_count": 3, "data": {"text/plain": "42", "application/json": {"total": 42}}, "metadata": {}}));
        assert!(!cell.done);
        take(&mut cell, Channel::Shell, "execute_reply", json!({"status": "ok", "execution_count": 3}));
        assert!(!cell.done, "outputs may still be on their way until the kernel is idle");
        take(&mut cell, Channel::Iopub, "status", json!({"execution_state": "idle"}));
        assert!(cell.done);
        assert_eq!(cell.count, Some(3));
        assert_eq!(cell.outputs[0], json!({"output_type": "stream", "name": "stdout", "text": ["uno\n", "dos\n", "tres"]}));
        assert_eq!(cell.outputs[1]["data"], json!({"text/plain": ["<Figure>"], "image/png": "iVBOR"}));
        assert_eq!(cell.outputs[2]["execution_count"], 3);
        assert_eq!(cell.result, Some(json!({"total": 42})));
        assert!(cell.error.is_none());

        let mut failed = CellRun::default();
        let traceback = json!(["\u{1b}[0;31mZeroDivisionError\u{1b}[0m", "division by zero"]);
        let logged = take(&mut failed, Channel::Iopub, "error", json!({"ename": "ZeroDivisionError", "evalue": "division by zero", "traceback": traceback}));
        assert_eq!(logged, Some((LogStream::Stderr, "ZeroDivisionError\ndivision by zero".to_string())));
        assert_eq!(failed.error.as_deref(), Some("ZeroDivisionError: division by zero"));
    }

    #[test]
    fn parameters_go_after_the_tagged_cell_and_must_be_names() {
        let mut notebook = json!({"cells": [
            {"cell_type": "markdown", "metadata": {}, "source": ["# Informe"]},
            {"cell_type": "code", "metadata": {"tags": ["parameters"]}, "source": ["cliente = None\n"], "outputs": [], "execution_count": null},
            {"cell_type": "code", "metadata": {}, "source": ["print(cliente)"], "outputs": [], "execution_count": null},
        ]});
        let parameters = notebook_parameters(&json!({"notebookParams": "{\"cliente\": \"Ñandú \\\"S.A.\\\"\", \"total\": 3}"})).unwrap();
        insert_parameters(&mut notebook, &parameters);
        let injected = &notebook["cells"][2];
        assert_eq!(injected["metadata"]["tags"], json!(["injected-parameters"]));
        let code = joined(&injected["source"]);
        let encoded = code.split('"').nth(1).unwrap();
        let decoded: Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap();
        assert_eq!(decoded, json!({"cliente": "Ñandú \"S.A.\"", "total": 3}));

        let mut untagged = json!({"cells": [{"cell_type": "code", "metadata": {}, "source": "x = 1", "outputs": []}]});
        insert_parameters(&mut untagged, &parameters);
        assert_eq!(untagged["cells"][0]["metadata"]["tags"], json!(["injected-parameters"]));

        assert!(notebook_parameters(&json!({"notebookParams": ""})).unwrap().is_empty());
        assert!(notebook_parameters(&json!({"notebookParams": "{\"a-b\": 1}"})).is_err());
        assert!(notebook_parameters(&json!({"notebookParams": "[1]"})).is_err());
    }

    #[test]
    fn a_saved_notebook_reads_like_jupyter_wrote_it() {
        let notebook = json!({"nbformat": 4, "nbformat_minor": 5, "metadata": {"language_info": {"name": "python"}},
                              "cells": [{"source": ["print(1)"], "cell_type": "code", "outputs": [], "metadata": {}, "execution_count": 1}]});
        assert_eq!(
            nbformat_text(&notebook),
            "{\n \"cells\": [\n  {\n   \"cell_type\": \"code\",\n   \"execution_count\": 1,\n   \"metadata\": {},\n   \"outputs\": [],\n   \"source\": [\n    \"print(1)\"\n   ]\n  }\n ],\n \"metadata\": {\n  \"language_info\": {\n   \"name\": \"python\"\n  }\n },\n \"nbformat\": 4,\n \"nbformat_minor\": 5\n}\n"
        );
    }
}
