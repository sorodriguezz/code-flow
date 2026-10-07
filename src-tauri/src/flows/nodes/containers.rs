//! «Contenedor» and «Kubernetes»: the Contenedores panel's operations as flow nodes, on the same
//! code (`crate::containers`) — so a flow lists, starts, reads the logs of or runs a command in a
//! container exactly the way the panel does, through the engine's own CLI.
//!
//! **A node cut short cleans up after itself.** Stopping the run (or the node's time limit) kills the
//! CLI, and that alone leaves a `run`'s container and an `exec`'s processes running. So each is marked
//! when it starts — a label on the container, a variable in the processes' environment, unique to that
//! node's run — and what carries the mark is ended before the node answers. Only that: never a
//! container that merely shares its name.

use std::future::Future;
use std::time::Duration;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{flag, number, pairs, strings, text, NodeCtx, NodeError};
use crate::containers::{cli, engine, kube};
use crate::flows::run::{Item, Ports};

const RUN_TIMEOUT: Duration = Duration::from_secs(600);

/// The label on a container a «Contenedor» node runs; its value is unique to that run.
const RUN_LABEL: &str = "codeflow.node-run";

/// The variable in the environment of what an exec node starts (and of everything that starts in
/// turn); its value is unique to that exec.
const EXEC_MARK: &str = "CODEFLOW_EXEC";

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "code.container" => container(ctx).await,
        "code.k8s" => kubernetes(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

/// The parameters per item (`each`) or once — and the input index each answer pairs to.
async fn resolved(ctx: &NodeCtx) -> Result<Vec<(Value, Option<usize>)>, NodeError> {
    let each = ctx.param_str("runFor") == "each" && !ctx.items().is_empty();
    if each {
        Ok(ctx.resolve_each().await?.into_iter().enumerate().map(|(i, p)| (p, Some(i))).collect())
    } else {
        Ok(vec![(ctx.resolve_once().await?, if ctx.items().is_empty() { None } else { Some(0) })])
    }
}

fn item(json: Value, index: Option<usize>) -> Item {
    match index {
        Some(i) => Item::paired(json, i),
        None => Item::new(json),
    }
}

/// Waits for `future`, or for the run to stop — the child process dies with the dropped future.
async fn cancellable<T>(ctx: &NodeCtx, future: impl Future<Output = Result<T, String>>) -> Result<T, NodeError> {
    tokio::select! {
        result = future => result.map_err(NodeError::Failed),
        _ = ctx.cancel.cancelled() => Err(NodeError::Cancelled),
    }
}

/// [`cancellable`] for a command that leaves something behind when it is cut short: when the run
/// stops, the node times out or the tool hits its own limit, `cleanup` ends what it started before
/// the node answers. A command that finished, however it went, needs none.
async fn owned<T>(cancel: &CancellationToken, work: impl Future<Output = Result<T, String>>, cleanup: impl Future<Output = ()>) -> Result<T, NodeError> {
    let result = tokio::select! {
        result = work => result.map_err(NodeError::Failed),
        _ = cancel.cancelled() => Err(NodeError::Cancelled),
    };
    if result.is_err() {
        // Bounded: an attempt that timed out is given five seconds to stop what it started.
        let _ = tokio::time::timeout(Duration::from_secs(5), cleanup).await;
    }
    result
}

/// Removes the containers carrying `mark` (`codeflow.node-run=…`): the one a cut-short `run` started.
async fn remove_marked(target: &engine::Target, mark: &str) {
    let filter = format!("label={mark}");
    let Ok(listed) = target.run(&["ps", "-a", "-q", "--filter", &filter], Duration::from_secs(5)).await else { return };
    let ids: Vec<String> = listed.split_whitespace().map(str::to_string).collect();
    if ids.is_empty() {
        return;
    }
    let mut args = vec!["rm".to_string(), "-f".into()];
    args.extend(ids);
    let _ = target.run_owned(args, Duration::from_secs(5)).await;
}

/// A shell line, run inside the container, that ends every process carrying `mark` (`NAME=value`) in
/// its environment. Plain `grep` on `/proc/<pid>/environ` — busybox and coreutils alike read it.
fn reap_script(mark: &str) -> String {
    format!("for p in /proc/[0-9]*; do grep -q '{mark}' \"$p/environ\" 2>/dev/null && kill -TERM \"${{p#/proc/}}\" 2>/dev/null; done; true")
}

/// A mark of its own for one run or exec: `NAME=<32 hex digits>`.
fn new_mark(name: &str) -> String {
    format!("{name}={}", uuid::Uuid::new_v4().simple())
}

/// `api-*` style patterns: `*` any run, `?` one character, case-insensitive.
pub fn glob_match(pattern: &str, value: &str) -> bool {
    crate::containers::glob_match(pattern, value)
}

fn target_of(params: &Value) -> engine::Target {
    let context = text(params, "containerContext");
    engine::Target { runtime: text(params, "engineKind"), context: (!context.trim().is_empty()).then(|| context.trim().to_string()) }
}

fn need(params: &Value, name: &str, what: &str) -> Result<String, NodeError> {
    let value = text(params, name).trim().to_string();
    if value.is_empty() {
        Err(NodeError::failed(format!("Write the {what}")))
    } else {
        Ok(value)
    }
}

/// A container or an image named by a field — refused when it could be read as a flag: the field is
/// often an expression (`{{ $json.name }}`), and an upstream item's data is not ours to vouch for.
fn need_ref(params: &Value, name: &str, what: &str) -> Result<String, NodeError> {
    let value = need(params, name, what)?;
    engine::check_ref(&value).map_err(NodeError::Failed)?;
    Ok(value)
}

async fn container(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mut out = Vec::new();
    for (params, index) in resolved(ctx).await? {
        let target = target_of(&params);
        target.engine().map_err(NodeError::Failed)?;
        let op = text(&params, "containerOp");
        match op.as_str() {
            "ctrList" => {
                let rows = cancellable(ctx, engine::list_containers(&target)).await?;
                let state = text(&params, "ctrState");
                let pattern = text(&params, "nameFilter");
                for row in rows.iter().filter(|r| match state.as_str() {
                    "runningOnly" => r.state == "running",
                    "stoppedOnly" => r.state != "running",
                    _ => true,
                }) {
                    if glob_match(&pattern, &row.name) {
                        out.push(item(engine::row_item(row), index));
                    }
                }
            }
            "ctrStart" | "ctrStop" | "ctrRestart" | "ctrRemove" => {
                let name = need_ref(&params, "container", "container's name")?;
                let action = match op.as_str() {
                    "ctrStart" => "start",
                    "ctrStop" => "stop",
                    "ctrRestart" => "restart",
                    _ => "remove",
                };
                let options = json!({"volumes": flag(&params, "removeVolumes")});
                let said = cancellable(ctx, engine::act(&target, "container", action, std::slice::from_ref(&name), &options)).await?;
                ctx.log(crate::flows::engine::LogStream::Stdout, &said);
                out.push(item(json!({"container": name, "action": action, "ok": true}), index));
            }
            "ctrLogs" => {
                let name = need_ref(&params, "container", "container's name")?;
                let lines = number(&params, "lines").unwrap_or(200.0).clamp(1.0, 100_000.0) as u32;
                let mut args = vec!["logs".to_string(), "--tail".into(), lines.to_string()];
                let since = text(&params, "logsSince");
                if !since.trim().is_empty() {
                    args.extend(["--since".into(), since.trim().to_string()]);
                }
                args.push(name.clone());
                let output = cancellable(ctx, target.run_owned(args, Duration::from_secs(60))).await?;
                if !output.ok() {
                    return Err(NodeError::failed(output.complaint()));
                }
                // A container's stdout and stderr both go to its log; the CLI hands them back apart.
                let text_out = format!("{}{}", output.stdout, output.stderr);
                out.push(item(json!({"container": name, "logs": text_out, "lines": text_out.lines().count()}), index));
            }
            "ctrExec" => {
                let name = need_ref(&params, "container", "container's name")?;
                let command = need(&params, "command", "command to run")?;
                let mark = new_mark(EXEC_MARK);
                let args = vec!["exec".to_string(), "-e".into(), mark.clone(), name.clone(), "sh".into(), "-c".into(), command];
                let reap = vec!["exec".to_string(), name.clone(), "sh".into(), "-c".into(), reap_script(&mark)];
                let output = owned(&ctx.cancel, target.run_owned(args, ctx.timeout.unwrap_or(RUN_TIMEOUT)), async {
                    let _ = target.run_owned(reap, Duration::from_secs(5)).await;
                })
                .await?;
                if flag(&params, "failOnExit") && !output.ok() {
                    return Err(NodeError::failed(format!("exited with {}: {}", output.code.unwrap_or(-1), output.complaint())));
                }
                out.push(item(json!({"container": name, "exitCode": output.code, "stdout": output.stdout, "stderr": output.stderr}), index));
            }
            "ctrInspect" => {
                let name = need_ref(&params, "container", "container's name")?;
                let doc = cancellable(ctx, engine::inspect(&target, "container", &name)).await?;
                let doc: Value = serde_json::from_str(&doc).unwrap_or(Value::Null);
                let mut summary = engine::summary_of_inspect(&doc);
                summary["inspect"] = doc;
                out.push(item(summary, index));
            }
            "ctrStats" => {
                let name = need_ref(&params, "container", "container's name")?;
                let mut stats = cancellable(ctx, engine::stats(&target, &name)).await?;
                stats["container"] = json!(name);
                out.push(item(stats, index));
            }
            "ctrPull" => {
                let image = need_ref(&params, "image", "image to pull")?;
                let said = cancellable(ctx, engine::act(&target, "image", "pull", std::slice::from_ref(&image), &json!({}))).await?;
                out.push(item(json!({"image": image, "output": said}), index));
            }
            "ctrRun" => {
                let image = need_ref(&params, "image", "image to run")?;
                let detach = flag(&params, "detach");
                let mark = new_mark(RUN_LABEL);
                let mut args = vec!["run".to_string(), "--label".into(), mark.clone()];
                if detach {
                    args.push("-d".into());
                }
                if flag(&params, "remove") {
                    args.push("--rm".into());
                }
                let name = text(&params, "ctrName");
                if !name.trim().is_empty() {
                    args.extend(["--name".into(), name.trim().to_string()]);
                }
                for port in strings(&params, "publishPorts") {
                    args.extend(["-p".into(), port]);
                }
                for (key, value) in pairs(&params, "env") {
                    args.extend(["-e".into(), format!("{key}={value}")]);
                }
                for (host, inside) in pairs(&params, "volumes") {
                    args.extend(["-v".into(), format!("{}:{inside}", super::expand_path(&host).display())]);
                }
                args.push(image.clone());
                args.extend(strings(&params, "args"));
                // The image may have to be pulled first: the long limit, unless the node set its own.
                let output = owned(&ctx.cancel, target.run_owned(args, ctx.timeout.unwrap_or(engine::PULL_TIMEOUT)), remove_marked(&target, &mark)).await?;
                if !output.ok() {
                    return Err(NodeError::failed(output.complaint()));
                }
                let result = if detach {
                    json!({"image": image, "id": output.stdout.trim(), "name": name.trim()})
                } else {
                    json!({"image": image, "stdout": output.stdout, "stderr": output.stderr, "exitCode": output.code})
                };
                out.push(item(result, index));
            }
            "composeUp" | "composeDown" | "composeRestart" | "composePs" => {
                let file = text(&params, "composeFile");
                let project = text(&params, "composeProject");
                if file.trim().is_empty() && project.trim().is_empty() {
                    return Err(NodeError::failed("Choose the compose file or write the project's name"));
                }
                let mut args = vec!["compose".to_string()];
                if !project.trim().is_empty() {
                    args.extend(["-p".into(), project.trim().to_string()]);
                }
                if !file.trim().is_empty() {
                    args.extend(["-f".into(), super::expand_path(&file).to_string_lossy().into_owned()]);
                }
                match op.as_str() {
                    "composeUp" => args.extend(["up".into(), "-d".into()]),
                    "composeDown" => args.push("down".into()),
                    "composeRestart" => args.push("restart".into()),
                    _ => {
                        args.extend(["ps".into(), "-a".into(), "--format".into(), "json".into()]);
                    }
                }
                // `up` pulls what is missing: the long limit, unless the node set its own.
                let limit = if op == "composeUp" { engine::PULL_TIMEOUT } else { RUN_TIMEOUT };
                let output = cancellable(ctx, target.run_owned(args, ctx.timeout.unwrap_or(limit))).await?;
                if !output.ok() {
                    return Err(NodeError::failed(output.complaint()));
                }
                if op == "composePs" {
                    for value in cli::json_values(&output.stdout) {
                        out.push(item(value, index));
                    }
                } else {
                    out.push(item(json!({"action": op, "output": format!("{}{}", output.stdout.trim(), output.stderr.trim())}), index));
                }
            }
            other => return Err(NodeError::failed(format!("Unknown operation {other}"))),
        }
    }
    Ok(vec![out])
}

async fn kubernetes(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let mut out = Vec::new();
    for (params, index) in resolved(ctx).await? {
        let context = text(&params, "kubeContext");
        let namespace = text(&params, "namespace");
        let target = kube::KubeTarget {
            context: (!context.trim().is_empty()).then(|| context.trim().to_string()),
            namespace: (!namespace.trim().is_empty()).then(|| namespace.trim().to_string()),
        };
        let kind = text(&params, "k8sKind");
        let name = text(&params, "k8sName").trim().to_string();
        let op = text(&params, "k8sOp");
        match op.as_str() {
            "k8sGet" => {
                let mut rows = cancellable(ctx, kube::list(&target, &kind)).await?;
                if !name.is_empty() {
                    rows.retain(|r| r.name == name);
                }
                let selector = text(&params, "labelSelector");
                let wanted: Vec<(String, String)> = selector
                    .split(',')
                    .filter_map(|pair| pair.split_once('=').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
                    .filter(|(k, _)| !k.is_empty())
                    .collect();
                rows.retain(|r| wanted.iter().all(|(k, v)| r.labels.get(k) == Some(v)));
                for row in rows {
                    out.push(item(serde_json::to_value(row).unwrap_or(Value::Null), index));
                }
            }
            "k8sDescribe" => {
                let text_out = cancellable(ctx, kube::text(&target, &kind, &name, "describe", false)).await?;
                out.push(item(json!({"kind": kind, "name": name, "describe": text_out}), index));
            }
            "k8sLogs" => {
                if name.is_empty() {
                    return Err(NodeError::failed("Write the pod's name"));
                }
                let lines = number(&params, "lines").unwrap_or(200.0).clamp(1.0, 100_000.0) as u32;
                let container = text(&params, "container");
                let logs = cancellable(ctx, kube::logs(&target, &name, Some(container.as_str()), lines, flag(&params, "previous"))).await?;
                out.push(item(json!({"pod": name, "logs": logs, "lines": logs.lines().count()}), index));
            }
            "k8sExec" => {
                if name.is_empty() {
                    return Err(NodeError::failed("Write the pod's name"));
                }
                let command = need(&params, "command", "command to run")?;
                let container = text(&params, "container");
                let mark = new_mark(EXEC_MARK);
                let output = owned(&ctx.cancel, kube::exec(&target, &name, Some(container.as_str()), &command, Some(&mark), ctx.timeout.unwrap_or(RUN_TIMEOUT)), async {
                    let _ = kube::exec(&target, &name, Some(container.as_str()), &reap_script(&mark), None, Duration::from_secs(5)).await;
                })
                .await?;
                if flag(&params, "failOnExit") && !output.ok() {
                    return Err(NodeError::failed(format!("exited with {}: {}", output.code.unwrap_or(-1), output.complaint())));
                }
                out.push(item(json!({"pod": name, "exitCode": output.code, "stdout": output.stdout, "stderr": output.stderr}), index));
            }
            "k8sScale" | "k8sRestart" | "k8sDelete" => {
                if name.is_empty() {
                    return Err(NodeError::failed("Write the object's name"));
                }
                let action = match op.as_str() {
                    "k8sScale" => "scale",
                    "k8sRestart" => "restart",
                    _ => "delete",
                };
                let options = json!({"replicas": number(&params, "replicas").map(|n| n.max(0.0) as i64)});
                let said = cancellable(ctx, kube::act(&target, &kind, std::slice::from_ref(&name), action, &options)).await?;
                out.push(item(json!({"kind": kind, "name": name, "action": action, "output": said}), index));
            }
            "k8sRolloutStatus" => {
                if name.is_empty() {
                    return Err(NodeError::failed("Write the object's name"));
                }
                let seconds = number(&params, "timeoutSec").unwrap_or(300.0).clamp(5.0, 3600.0) as u64;
                let said = cancellable(ctx, kube::rollout_status(&target, &kind, &name, seconds)).await?;
                out.push(item(json!({"kind": kind, "name": name, "ready": true, "output": said}), index));
            }
            "k8sApply" => {
                let manifest = need(&params, "manifest", "manifest")?;
                let said = cancellable(ctx, kube::apply(&target, &manifest)).await?;
                let changed: Vec<Value> = said
                    .lines()
                    .filter_map(|line| line.split_once(' ').map(|(object, verb)| json!({"object": object, "result": verb.trim()})))
                    .collect();
                out.push(item(json!({"applied": changed, "output": said}), index));
            }
            other => return Err(NodeError::failed(format!("Unknown operation {other}"))),
        }
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_a_command_cut_short_is_cleaned_up_after() {
        let cleaned = std::sync::atomic::AtomicUsize::new(0);
        let cleanup = || async { cleaned.fetch_add(1, std::sync::atomic::Ordering::SeqCst); };
        let cancel = CancellationToken::new();
        assert_eq!(owned(&cancel, async { Ok::<_, String>(7) }, cleanup()).await, Ok(7));
        assert_eq!(cleaned.load(std::sync::atomic::Ordering::SeqCst), 0, "a command that finished leaves nothing to clean");
        // The tool's own time limit (or a failure to start) is cut short too.
        assert!(owned(&cancel, async { Err::<u8, _>("docker did not answer within 600 s".to_string()) }, cleanup()).await.is_err());
        assert_eq!(cleaned.load(std::sync::atomic::Ordering::SeqCst), 1);
        cancel.cancel();
        assert_eq!(owned(&cancel, std::future::pending::<Result<u8, String>>(), cleanup()).await, Err(NodeError::Cancelled));
        assert_eq!(cleaned.load(std::sync::atomic::Ordering::SeqCst), 2, "a stopped run ends what it started");
    }

    #[test]
    fn marks_are_unique_and_the_reaper_looks_for_exactly_one() {
        let (a, b) = (new_mark(EXEC_MARK), new_mark(EXEC_MARK));
        assert_ne!(a, b);
        assert!(a.starts_with("CODEFLOW_EXEC=") && a.len() == "CODEFLOW_EXEC=".len() + 32);
        let script = reap_script(&a);
        assert!(script.contains(&format!("grep -q '{a}'")) && !script.contains(&b));
    }

    #[test]
    fn globs_match_like_a_shell() {
        assert!(glob_match("api-*", "api-1"));
        assert!(glob_match("API-*", "api-worker"));
        assert!(!glob_match("api-*", "web"));
        assert!(glob_match("", "anything"));
        assert!(glob_match("*db*", "shop-db-1"));
    }
}
