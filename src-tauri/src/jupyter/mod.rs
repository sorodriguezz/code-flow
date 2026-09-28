//! Jupyter kernels for the editor's notebooks (`.ipynb`).
//!
//! The notebook itself — cells, outputs, the file — lives in the webview; this side only runs
//! kernels and carries their messages. One kernel per open notebook, started on its first run and
//! addressed by an id the notebook minted (so its first events can never beat the notebook's own
//! bookkeeping), stopped when its tab closes, and every one of them stopped when the app quits
//! ([`shutdown_all`], from `shutdown::shutdown_cleanup`).
//!
//! - [`wire`] — the signed multipart message format.
//! - [`connection`] — ports, key, the connection file.
//! - [`kernelspec`] — which kernels exist: Jupyter's list, the kernelspec folders, virtualenvs.
//! - [`kernel`] — one running kernel.
//! - [`assist`] — the notebook's AI actions (explain, fix, document, generate), text in and out.

pub mod assist;
pub mod connection;
pub mod kernel;
pub mod kernelspec;
pub mod wire;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use kernel::{Channel, Kernel, KernelEvents, Lifecycle};
use kernelspec::KernelChoice;
use wire::Message;

/// The event every kernel message and lifecycle change reaches the webview on, in batches.
pub const EVENTS: &str = "notebook:kernel-events";

/// Running kernels by id.
static KERNELS: LazyLock<Mutex<HashMap<String, Arc<Kernel>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The kernels the last discoveries offered, by choice id. A start names one of these rather than
/// passing a command line: what a notebook can launch is what discovery found on this machine, and
/// nothing a webview hands over.
static CHOICES: LazyLock<Mutex<HashMap<String, KernelChoice>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn remember_choices(choices: &[KernelChoice]) {
    if let Ok(mut known) = CHOICES.lock() {
        for choice in choices {
            known.insert(choice.id.clone(), choice.clone());
        }
    }
}

pub fn choice(id: &str) -> Option<KernelChoice> {
    CHOICES.lock().ok()?.get(id).cloned()
}

pub fn kernel(id: &str) -> Option<Arc<Kernel>> {
    KERNELS.lock().ok()?.get(id).cloned()
}

pub fn insert(kernel: Arc<Kernel>) {
    if let Ok(mut kernels) = KERNELS.lock() {
        kernels.insert(kernel.id.clone(), kernel);
    }
}

pub fn remove(id: &str) -> Option<Arc<Kernel>> {
    KERNELS.lock().ok()?.remove(id)
}

/// Where connection files go: the app's cache, never Jupyter's own runtime folder. The files hold
/// signing keys and live exactly as long as their kernel.
pub fn runtime_dir() -> PathBuf {
    crate::paths::cache_dir().join("jupyter")
}

/// Clears the connection files an earlier session left behind — it can only have been one that
/// ended without its exit cleanup. Once per process, before the first kernel of this one.
pub fn sweep_stale_connection_files() {
    static SWEPT: OnceLock<()> = OnceLock::new();
    SWEPT.get_or_init(|| {
        let Ok(entries) = std::fs::read_dir(runtime_dir()) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("kernel-") && name.ends_with(".json") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    });
}

/// Stops every kernel — the app is quitting. Each is asked to shut down and given a moment; what
/// has not left by then has its process group killed. Concurrent, so the budget is per app, not
/// per kernel.
pub async fn shutdown_all(grace: Duration) {
    let kernels: Vec<Arc<Kernel>> = match KERNELS.lock() {
        Ok(mut kernels) => kernels.drain().map(|(_, kernel)| kernel).collect(),
        Err(_) => return,
    };
    futures_util::future::join_all(kernels.iter().map(|kernel| kernel.shutdown(grace))).await;
}

/// One entry of an [`EVENTS`] batch.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum KernelEvent {
    Message {
        kernel_id: String,
        channel: Channel,
        msg_type: String,
        msg_id: String,
        parent_msg_id: Option<String>,
        content: Value,
        metadata: Value,
    },
    Lifecycle {
        kernel_id: String,
        lifecycle: Lifecycle,
    },
}

/// The app's [`KernelEvents`]: batches everything into [`EVENTS`].
///
/// Batched because a kernel printing in a loop produces thousands of messages a second, and one IPC
/// event per message is thousands of JSON round trips into a webview that repaints on each. What
/// arrives while a batch is being emitted rides in the next one; nothing is held back when there is
/// nothing else to wait for.
pub struct AppEvents {
    tx: mpsc::UnboundedSender<KernelEvent>,
}

impl AppEvents {
    /// The one instance, started on first use with the app's handle.
    pub fn shared(app: &AppHandle) -> Arc<AppEvents> {
        static SHARED: OnceLock<Arc<AppEvents>> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                let (tx, mut rx) = mpsc::unbounded_channel::<KernelEvent>();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    while let Some(first) = rx.recv().await {
                        let mut batch = vec![first];
                        while batch.len() < 500 {
                            match rx.try_recv() {
                                Ok(next) => batch.push(next),
                                Err(_) => break,
                            }
                        }
                        let crowded = batch.len() > 1;
                        let _ = app.emit(EVENTS, &batch);
                        // Under a flood, a few milliseconds of gathering turns thousands of events
                        // into dozens; a lone message is not kept waiting.
                        if crowded {
                            tokio::time::sleep(Duration::from_millis(16)).await;
                        }
                    }
                });
                Arc::new(AppEvents { tx })
            })
            .clone()
    }
}

impl KernelEvents for AppEvents {
    fn message(&self, kernel_id: &str, channel: Channel, message: &Message) {
        let _ = self.tx.send(KernelEvent::Message {
            kernel_id: kernel_id.to_string(),
            channel,
            msg_type: message.msg_type().to_string(),
            msg_id: message.msg_id().to_string(),
            parent_msg_id: message.parent_msg_id().map(str::to_string),
            content: message.content.clone(),
            metadata: message.metadata.clone(),
        });
    }

    fn lifecycle(&self, kernel_id: &str, lifecycle: Lifecycle) {
        let _ = self.tx.send(KernelEvent::Lifecycle { kernel_id: kernel_id.to_string(), lifecycle });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The shape the notebook store reads — `type`, camelCase fields, the lifecycle's `state`.
    #[test]
    fn events_serialize_the_way_the_notebook_reads_them() {
        let message = KernelEvent::Message {
            kernel_id: "k".into(),
            channel: Channel::Iopub,
            msg_type: "stream".into(),
            msg_id: "m".into(),
            parent_msg_id: Some("p".into()),
            content: json!({"name": "stdout", "text": "hi"}),
            metadata: json!({}),
        };
        assert_eq!(
            serde_json::to_value(&message).unwrap(),
            json!({"type": "message", "kernelId": "k", "channel": "iopub", "msgType": "stream", "msgId": "m",
                   "parentMsgId": "p", "content": {"name": "stdout", "text": "hi"}, "metadata": {}})
        );
        let died = KernelEvent::Lifecycle {
            kernel_id: "k".into(),
            lifecycle: Lifecycle::Died { code: Some(1), stderr: "boom".into() },
        };
        assert_eq!(
            serde_json::to_value(&died).unwrap(),
            json!({"type": "lifecycle", "kernelId": "k", "lifecycle": {"state": "died", "code": 1, "stderr": "boom"}})
        );
        let ready = KernelEvent::Lifecycle { kernel_id: "k".into(), lifecycle: Lifecycle::Ready { info: json!({}) } };
        assert_eq!(serde_json::to_value(&ready).unwrap()["lifecycle"]["state"], "ready");
    }
}
