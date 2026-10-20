//! One queue per local model server, with priority: what a person is waiting on goes first.
//!
//! The bundled engine serves one request at a time (`-np 1`), and Ollama serving two models at
//! once is two models resident at once. So every request to a local server waits its turn here —
//! [`super::local_llm::chat`] and [`super::local_llm::converse`] take a [`Permit`] before they send.
//! The turn is per *request*, not per run: a hybrid task's twenty executor calls interleave with a
//! chat's, instead of the chat waiting for the whole task. It replaced the hybrid task's own
//! one-slot semaphore, which only hybrid tasks took — the agent, Flujos and meetings went around it.
//!
//! Priority is a task-local ([`background`]): a request is interactive unless the work that sent it
//! said otherwise, so a new caller is never starved by default.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Mutex, OnceLock};

use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    /// A chat, a fix, an inline edit: somebody is looking at a spinner.
    Interactive,
    /// A hybrid task, a flow, a meeting summary, the bench: nobody is waiting on this one request.
    Background,
}

tokio::task_local! {
    static PRIORITY: Priority;
}

/// Runs `work` with every local-model request it sends queued as background work.
pub async fn background<F: Future>(work: F) -> F::Output {
    PRIORITY.scope(Priority::Background, work).await
}

fn current() -> Priority {
    PRIORITY.try_with(|p| *p).unwrap_or(Priority::Interactive)
}

#[derive(Default)]
struct Gate {
    busy: bool,
    waiting: VecDeque<(Priority, oneshot::Sender<()>)>,
}

fn gates() -> &'static Mutex<HashMap<String, Gate>> {
    static GATES: OnceLock<Mutex<HashMap<String, Gate>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A turn at one server. Dropping it hands the turn to the next waiter.
pub struct Permit {
    key: String,
}

impl Drop for Permit {
    fn drop(&mut self) {
        release(&self.key);
    }
}

fn release(key: &str) {
    let Ok(mut gates) = gates().lock() else { return };
    let Some(gate) = gates.get_mut(key) else { return };
    // Hand the turn straight to the next live waiter; one whose request was dropped (cancelled)
    // has a closed channel and is skipped.
    while let Some((_, waiter)) = gate.waiting.pop_front() {
        if waiter.send(()).is_ok() {
            return;
        }
    }
    gate.busy = false;
}

/// Waits for a turn at the server `key` names (its base URL), at the current [`Priority`].
pub async fn acquire(key: &str) -> Permit {
    acquire_as(key, current()).await
}

pub async fn acquire_as(key: &str, priority: Priority) -> Permit {
    let rx = {
        let mut gates = gates().lock().expect("scheduler lock");
        let gate = gates.entry(key.to_string()).or_default();
        if !gate.busy {
            gate.busy = true;
            None
        } else {
            let (tx, rx) = oneshot::channel();
            // Interactive requests overtake every waiting background one, keeping order among
            // themselves.
            let at = match priority {
                Priority::Interactive => gate.waiting.iter().position(|(p, _)| *p == Priority::Background).unwrap_or(gate.waiting.len()),
                Priority::Background => gate.waiting.len(),
            };
            gate.waiting.insert(at, (priority, tx));
            Some(rx)
        }
    };
    if let Some(rx) = rx {
        // The sender is only dropped unused if the map entry is dropped, which never happens; an
        // error here still means "go", rather than a request that waits forever.
        let _ = rx.await;
    }
    Permit { key: key.to_string() }
}

/// How many requests are waiting for `key` — for the run log's "waiting for the local model" line.
pub fn waiting(key: &str) -> usize {
    gates().lock().ok().and_then(|g| g.get(key).map(|gate| gate.waiting.len())).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn one_turn_at_a_time_per_server() {
        let key = format!("test-{}", uuid::Uuid::new_v4());
        let first = acquire_as(&key, Priority::Background).await;
        let other_server = tokio::time::timeout(Duration::from_millis(50), acquire_as("another-server-x", Priority::Background)).await;
        assert!(other_server.is_ok(), "another server is not queued behind this one");
        let waiting = tokio::spawn({
            let key = key.clone();
            async move { acquire_as(&key, Priority::Background).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiting.is_finished());
        drop(first);
        let second = tokio::time::timeout(Duration::from_millis(200), waiting).await.expect("handed over").unwrap();
        drop(second);
    }

    #[tokio::test]
    async fn interactive_overtakes_background() {
        let key = format!("test-{}", uuid::Uuid::new_v4());
        let holder = acquire_as(&key, Priority::Background).await;
        let order = Arc::new(Mutex::new(Vec::new()));
        let spawn = |priority: Priority, label: &'static str| {
            let key = key.clone();
            let order = order.clone();
            tokio::spawn(async move {
                let permit = acquire_as(&key, priority).await;
                order.lock().unwrap().push(label);
                tokio::time::sleep(Duration::from_millis(5)).await;
                drop(permit);
            })
        };
        let a = spawn(Priority::Background, "bg1");
        tokio::time::sleep(Duration::from_millis(10)).await;
        let b = spawn(Priority::Background, "bg2");
        tokio::time::sleep(Duration::from_millis(10)).await;
        let c = spawn(Priority::Interactive, "chat");
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(waiting(&key), 3);
        drop(holder);
        for task in [a, b, c] {
            task.await.unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec!["chat", "bg1", "bg2"]);
    }

    #[tokio::test]
    async fn a_cancelled_waiter_is_skipped() {
        let key = format!("test-{}", uuid::Uuid::new_v4());
        let holder = acquire_as(&key, Priority::Interactive).await;
        let gone = tokio::spawn({
            let key = key.clone();
            async move { acquire_as(&key, Priority::Interactive).await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        gone.abort();
        let _ = gone.await;
        drop(holder);
        let next = tokio::time::timeout(Duration::from_millis(100), acquire_as(&key, Priority::Interactive)).await;
        assert!(next.is_ok(), "the turn was not lost to the cancelled waiter");
    }

    #[tokio::test]
    async fn the_default_priority_is_interactive_and_background_scopes_it() {
        assert_eq!(current(), Priority::Interactive);
        let inside = background(async { current() }).await;
        assert_eq!(inside, Priority::Background);
    }
}
