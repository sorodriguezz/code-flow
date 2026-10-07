//! `kubectl port-forward`, kept running for as long as the user wants it: a pod's or a service's
//! port on `127.0.0.1`. Each forward is a child process we own; closing it (or quitting the app)
//! ends it, and one that dies on its own says why.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::{cli, kube};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRequest {
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    /// `pods` or `services` (a deployment works too: kubectl picks one of its pods).
    pub kind: String,
    pub name: String,
    /// `0` lets kubectl pick a free local port.
    #[serde(default)]
    pub local_port: u16,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardView {
    pub id: String,
    pub context: String,
    pub namespace: String,
    pub kind: String,
    pub name: String,
    pub local_port: u16,
    pub remote_port: u16,
    /// `starting`, `active`, `failed`.
    pub status: String,
    pub error: Option<String>,
}

struct Forward {
    view: Arc<Mutex<ForwardView>>,
    cancel: CancellationToken,
    /// kubectl's pid while it runs — the quit path ends it directly, with no runtime left to run the
    /// task that would have. Cleared the moment kubectl is seen to end: a pid outlives its process
    /// and is handed out again, and a stale one would have the quit path signal some other program.
    pid: Arc<Mutex<Option<u32>>>,
}

impl Forward {
    /// The pid to end at quit: none once kubectl has ended — a failed forward's is long gone.
    fn live_pid(&self) -> Option<u32> {
        if self.view.lock().map(|v| v.status == "failed").unwrap_or(true) {
            return None;
        }
        self.pid.lock().ok().and_then(|pid| *pid)
    }
}

fn forget_pid(pid: &Mutex<Option<u32>>) {
    if let Ok(mut pid) = pid.lock() {
        *pid = None;
    }
}

fn kill_pid(pid: u32) {
    #[cfg(unix)]
    // SAFETY: `kill` takes integers; a process that has already gone answers ESRCH.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = crate::proc::std_command("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
    }
}

static FORWARDS: LazyLock<Mutex<HashMap<String, Forward>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn list() -> Vec<ForwardView> {
    let mut out: Vec<ForwardView> = FORWARDS.lock().map(|map| map.values().filter_map(|f| f.view.lock().ok().map(|v| v.clone())).collect()).unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.remote_port.cmp(&b.remote_port)));
    out
}

pub fn close(id: &str) {
    if let Some(forward) = FORWARDS.lock().ok().and_then(|mut map| map.remove(id)) {
        forward.cancel.cancel();
    }
}

/// Every forward ends with the app.
pub fn shutdown() {
    if let Ok(mut map) = FORWARDS.lock() {
        for (_, forward) in map.drain() {
            forward.cancel.cancel();
            if let Some(pid) = forward.live_pid() {
                kill_pid(pid);
            }
        }
    }
}

/// `Forwarding from 127.0.0.1:54321 -> 8080`: the local port kubectl bound.
fn bound_port(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("Forwarding from ")?;
    let address = rest.split(" -> ").next()?;
    address.rsplit(':').next()?.trim().parse().ok()
}

/// Starts a forward and answers once kubectl says it is listening (or why it is not).
pub async fn open(request: ForwardRequest) -> Result<ForwardView, String> {
    if request.name.trim().is_empty() || request.name.starts_with('-') || request.name.contains(char::is_whitespace) {
        return Err("choose what to forward".into());
    }
    if request.remote_port == 0 {
        return Err("say which port to reach".into());
    }
    let kind = match request.kind.as_str() {
        "pods" => "pod",
        "services" => "service",
        "deployments" => "deployment",
        "statefulsets" => "statefulset",
        other => return Err(format!("a {other} cannot be forwarded")),
    };
    let target = kube::KubeTarget { context: request.context.clone(), namespace: request.namespace.clone() };
    let mut args = target.context_args();
    args.extend([
        "port-forward".into(),
        "--address".into(),
        "127.0.0.1".into(),
        format!("{kind}/{}", request.name.trim()),
        format!("{}:{}", if request.local_port == 0 { String::new() } else { request.local_port.to_string() }, request.remote_port),
    ]);
    if let Some(ns) = target.namespace() {
        args.extend(["-n".into(), ns.to_string()]);
    }
    let mut cmd = crate::proc::command(kube::program());
    cmd.args(&args)
        .env("PATH", cli::search_path())
        .envs(cli::engine_env().await.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| format!("could not start kubectl: {e}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let (view, ready_rx) = track(
        ForwardView {
            id: id.clone(),
            context: request.context.clone().unwrap_or_default(),
            namespace: request.namespace.clone().unwrap_or_default(),
            kind: request.kind.clone(),
            name: request.name.trim().to_string(),
            local_port: request.local_port,
            remote_port: request.remote_port,
            status: "starting".into(),
            error: None,
        },
        child,
    );
    match tokio::time::timeout(Duration::from_secs(20), ready_rx).await {
        Ok(Ok(Ok(_))) => Ok(view.lock().map(|v| v.clone()).map_err(|e| e.to_string())?),
        Ok(Ok(Err(reason))) => Err(reason),
        Ok(Err(_)) => Err("kubectl ended before it was listening".into()),
        Err(_) => {
            close(&id);
            Err("kubectl did not start forwarding within 20 s".into())
        }
    }
}

/// Lists a started kubectl and watches it: the port it bound, why it failed, when it ended. Listed
/// *before* the watch starts, so a kubectl that dies at once is taken out again rather than left
/// behind as a failed row nobody asked for.
fn track(view: ForwardView, mut child: tokio::process::Child) -> (Arc<Mutex<ForwardView>>, tokio::sync::oneshot::Receiver<Result<u16, String>>) {
    let id = view.id.clone();
    let view = Arc::new(Mutex::new(view));
    let cancel = CancellationToken::new();
    let pid = Arc::new(Mutex::new(child.id()));
    if let Ok(mut map) = FORWARDS.lock() {
        map.insert(id.clone(), Forward { view: view.clone(), cancel: cancel.clone(), pid: pid.clone() });
    }
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<u16, String>>();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let watch_view = view.clone();
    let forget = id;
    tokio::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        let mut out_lines = stdout.map(|s| BufReader::new(s).lines());
        let mut err_lines = stderr.map(|s| BufReader::new(s).lines());
        let mut last_error = String::new();
        let note = |text: &str, last_error: &mut String| {
            if !text.trim().is_empty() {
                *last_error = text.trim().trim_start_matches("error: ").to_string();
            }
        };
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = child.kill().await;
                    forget_pid(&pid);
                    return;
                }
                line = async { match out_lines.as_mut() { Some(l) => l.next_line().await, None => std::future::pending().await } } => {
                    match line {
                        Ok(Some(text)) => {
                            if let Some(port) = bound_port(&text) {
                                if let Ok(mut v) = watch_view.lock() {
                                    v.local_port = port;
                                    v.status = "active".into();
                                }
                                if let Some(tx) = ready_tx.take() {
                                    let _ = tx.send(Ok(port));
                                }
                            }
                        }
                        _ => out_lines = None,
                    }
                }
                line = async { match err_lines.as_mut() { Some(l) => l.next_line().await, None => std::future::pending().await } } => {
                    match line {
                        Ok(Some(text)) => note(&text, &mut last_error),
                        _ => err_lines = None,
                    }
                }
                status = child.wait() => {
                    forget_pid(&pid);
                    // Its last words may still be in the pipe when its end is seen first.
                    if let Some(lines) = err_lines.as_mut() {
                        while let Ok(Ok(Some(text))) = tokio::time::timeout(Duration::from_millis(200), lines.next_line()).await {
                            note(&text, &mut last_error);
                        }
                    }
                    let reason = if last_error.is_empty() { format!("kubectl ended ({})", status.map(|s| s.to_string()).unwrap_or_default()) } else { last_error.clone() };
                    if let Ok(mut v) = watch_view.lock() {
                        v.status = "failed".into();
                        v.error = Some(reason.clone());
                    }
                    if let Some(tx) = ready_tx.take() {
                        // Never listed: it never came up. Out of the list before the caller hears why.
                        if let Ok(mut map) = FORWARDS.lock() {
                            map.remove(&forget);
                        }
                        let _ = tx.send(Err(reason));
                    }
                    return;
                }
            }
        }
    });
    (view, ready_rx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bound_port_is_read_from_kubectl() {
        assert_eq!(bound_port("Forwarding from 127.0.0.1:54321 -> 8080"), Some(54321));
        assert_eq!(bound_port("Forwarding from [::1]:8080 -> 80"), Some(8080));
        assert_eq!(bound_port("Handling connection for 8080"), None);
    }

    /// A stand-in kubectl: `sh` printing what kubectl would, then ending.
    #[cfg(unix)]
    fn fake_kubectl(script: &str) -> tokio::process::Child {
        crate::proc::command("sh").args(["-c", script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().unwrap()
    }

    #[cfg(unix)]
    fn starting(id: &str) -> ForwardView {
        ForwardView { id: id.into(), context: String::new(), namespace: String::new(), kind: "pods".into(), name: "api".into(), local_port: 0, remote_port: 80, status: "starting".into(), error: None }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_kubectl_that_never_listened_says_why_and_is_not_listed() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let (_, ready) = track(starting(&id), fake_kubectl("echo 'error: unable to forward port because pod is not running' >&2; exit 1"));
        assert_eq!(ready.await.unwrap(), Err("unable to forward port because pod is not running".to_string()));
        assert!(FORWARDS.lock().unwrap().get(&id).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_ended_kubectl_leaves_no_pid_for_the_quit_path() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let (shown, ready) = track(starting(&id), fake_kubectl("echo 'Forwarding from 127.0.0.1:5555 -> 80'; sleep 0.2; echo 'error: lost connection to pod' >&2; exit 1"));
        assert_eq!(ready.await.unwrap(), Ok(5555));
        for _ in 0..200 {
            if shown.lock().unwrap().status == "failed" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(shown.lock().unwrap().error.as_deref(), Some("lost connection to pod"));
        {
            let map = FORWARDS.lock().unwrap();
            let forward = map.get(&id).expect("a forward that was up stays listed, as failed");
            assert_eq!(*forward.pid.lock().unwrap(), None, "the pid is forgotten with its process");
            assert_eq!(forward.live_pid(), None);
        }
        close(&id);
    }
}
