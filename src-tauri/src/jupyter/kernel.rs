//! One running kernel: the process, its five sockets, and what it says on them.
//!
//! **The process.** Spawned from its kernelspec's `argv` into a process group of its own
//! (`proc::own_process_group`), in the notebook's folder, with `JPY_PARENT_PID` set so ipykernel's
//! parent poller ends it if this app dies without asking — the same arrangement `jupyter_client`
//! makes. Interrupting a signal-mode kernel is SIGINT to that group (what Ctrl-C in a terminal
//! does: the kernel and whatever `subprocess` it is waiting on); stopping one is a
//! `shutdown_request`, then the group's SIGTERM/SIGKILL (`ai_runs::kill_tree`) when it does not
//! leave by itself.
//!
//! **The sockets.** DEALERs for shell, control and stdin — shell and stdin under one routing
//! identity, because that is how the kernel finds where to send an `input_request` — a SUB on
//! iopub subscribed to everything, a REQ for the heartbeat. Each DEALER is split into a writer task
//! fed by a channel and a reader task, so sending never waits behind a receive.
//!
//! **What comes back** goes to [`KernelEvents`] untouched, except replies to the requests this
//! module makes for itself (`kernel_info`, `shutdown`, `interrupt`), which are awaited here.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};
use zeromq::{Socket, SocketRecv, SocketSend};

use super::connection::{self, ConnectionInfo};
use super::kernelspec::{InterruptMode, KernelChoice};
use super::wire::{self, Message, Signer};

/// How long a kernel may take from spawn to answering `kernel_info` — a first import of a large
/// scientific stack on a cold disk is well over ten seconds.
const START_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a kernel asked to shut down is given to leave by itself before its group is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(5);
/// Missed heartbeats in a row before the kernel is reported as not answering.
const HEARTBEAT_MISSES: u32 = 3;
/// What is kept of the kernel's own stdout/stderr, for the report when it dies.
const TAIL_LINES: usize = 60;
const TAIL_LINE_CHARS: usize = 1000;

const STATE_STARTING: u8 = 0;
const STATE_RUNNING: u8 = 1;
const STATE_STOPPING: u8 = 2;
/// Exited without being asked: nothing left for the heartbeat to probe.
const STATE_DEAD: u8 = 3;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Shell,
    Iopub,
    Stdin,
    Control,
}

/// What happened to the kernel *process*, as opposed to what the kernel said.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Lifecycle {
    Starting,
    /// Answering: `info` is its `kernel_info_reply` content (language, version, banner).
    Ready { info: Value },
    Restarting,
    /// The heartbeat stopped answering — a kernel stuck below Python, or a machine under water.
    Unresponsive,
    Responsive,
    /// It exited without being asked to. `stderr` is the tail of what it printed on the way out.
    Died { code: Option<i32>, stderr: String },
    Stopped,
}

/// Where a kernel's messages and lifecycle go. The app's implementation emits Tauri events
/// (`jupyter::AppEvents`); the tests collect them.
pub trait KernelEvents: Send + Sync + 'static {
    fn message(&self, kernel_id: &str, channel: Channel, message: &Message);
    fn lifecycle(&self, kernel_id: &str, lifecycle: Lifecycle);
}

type Waiters = Arc<Mutex<HashMap<String, oneshot::Sender<Message>>>>;

/// The last lines a kernel printed, for the report when it dies.
#[derive(Default)]
struct Tail {
    lines: VecDeque<String>,
}

impl Tail {
    fn push(&mut self, line: &str) {
        let line: String = line.chars().take(TAIL_LINE_CHARS).collect();
        if self.lines.len() == TAIL_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    fn text(&self) -> String {
        self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

/// The process behind a kernel this app started. Absent for a kernel it only connected to.
struct Process {
    pid: Option<u32>,
    /// `Some(code)` once it has exited.
    exit: watch::Receiver<Option<Option<i32>>>,
    kill: Option<oneshot::Sender<()>>,
    tail: Arc<Mutex<Tail>>,
    task: tokio::task::JoinHandle<()>,
}

/// One incarnation of a kernel — a restart replaces the whole of it.
struct Live {
    session: String,
    file: Option<PathBuf>,
    shell: mpsc::UnboundedSender<Message>,
    control: mpsc::UnboundedSender<Message>,
    stdin: mpsc::UnboundedSender<Message>,
    waiters: Waiters,
    /// The `input_request` the kernel is waiting on, answered by [`Kernel::input_reply`].
    pending_input: Arc<Mutex<Option<Message>>>,
    iopub_seen: Arc<AtomicU64>,
    state: Arc<AtomicU8>,
    process: Option<Process>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

/// The socket tasks go with the incarnation. Dropping a `JoinHandle` detaches its task rather than
/// stopping it, so without this a start that failed half-way — sockets connected, no answer — would
/// leave readers parked on dead sockets for the life of the app. The process task is not among
/// them: it owns the child, and only `stop` decides when that goes.
impl Drop for Live {
    fn drop(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}

pub struct Kernel {
    pub id: String,
    pub choice: KernelChoice,
    cwd: PathBuf,
    runtime_dir: PathBuf,
    events: Arc<dyn KernelEvents>,
    live: tokio::sync::Mutex<Option<Live>>,
    incarnation: AtomicU64,
}

impl Kernel {
    /// Starts `choice` in `cwd` and waits until it answers. The connection file goes in
    /// `runtime_dir`.
    pub async fn start(
        id: String,
        choice: KernelChoice,
        cwd: PathBuf,
        runtime_dir: PathBuf,
        events: Arc<dyn KernelEvents>,
    ) -> Result<(Arc<Kernel>, Value), String> {
        let kernel = Arc::new(Kernel {
            id,
            choice,
            cwd,
            runtime_dir,
            events,
            live: tokio::sync::Mutex::new(None),
            incarnation: AtomicU64::new(0),
        });
        let info = {
            let mut guard = kernel.live.lock().await;
            kernel.events.lifecycle(&kernel.id, Lifecycle::Starting);
            let (live, info) = kernel.launch().await?;
            *guard = Some(live);
            info
        };
        kernel.events.lifecycle(&kernel.id, Lifecycle::Ready { info: info.clone() });
        Ok((kernel, info))
    }

    /// Connects to a kernel that is already running — nothing is spawned, and stopping it only
    /// asks. What the tests drive a kernel of their own through.
    #[cfg(test)]
    pub async fn attach(
        id: String,
        info: ConnectionInfo,
        events: Arc<dyn KernelEvents>,
    ) -> Result<(Arc<Kernel>, Value), String> {
        let choice = KernelChoice {
            id: "attached".into(),
            name: info.kernel_name.clone(),
            display_name: info.kernel_name.clone(),
            language: String::new(),
            argv: Vec::new(),
            env: Default::default(),
            interrupt_mode: InterruptMode::Message,
            source: super::kernelspec::KernelSource::Directory,
            resource_dir: None,
            python: None,
        };
        let kernel = Arc::new(Kernel {
            id,
            choice,
            cwd: PathBuf::new(),
            runtime_dir: PathBuf::new(),
            events,
            live: tokio::sync::Mutex::new(None),
            incarnation: AtomicU64::new(0),
        });
        let state = Arc::new(AtomicU8::new(STATE_STARTING));
        let mut live = connect(&kernel.id, &info, &kernel.events, state, None, None).await?;
        let reply = handshake(&mut live, START_TIMEOUT).await?;
        live.state.store(STATE_RUNNING, Ordering::SeqCst);
        *kernel.live.lock().await = Some(live);
        Ok((kernel, reply))
    }

    /// Spawns the process, connects, and waits for its first answer.
    async fn launch(&self) -> Result<(Live, Value), String> {
        let (ports, listeners) = connection::reserve_ports().map_err(|e| format!("No hay puertos libres para el kernel: {e}"))?;
        let info = ConnectionInfo::loopback(ports, &self.choice.name);
        let n = self.incarnation.fetch_add(1, Ordering::SeqCst);
        let file = connection::write_connection_file(&self.runtime_dir, &format!("{}-{n}", self.id), &info)
            .map_err(|e| format!("No se pudo escribir el archivo de conexión del kernel: {e}"))?;
        let argv = expand_argv(&self.choice.argv, &file, self.choice.resource_dir.as_deref());

        let mut cmd = crate::proc::command(&argv[0]);
        cmd.args(&argv[1..])
            .current_dir(&self.cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &self.choice.env {
            cmd.env(key, value);
        }
        // ipykernel's parent poller: with this set, a kernel whose parent went away (this app
        // killed, crashed) exits by itself instead of living on reparented to init. Windows wants a
        // handle there, not a pid, so it is left out.
        #[cfg(unix)]
        cmd.env("JPY_PARENT_PID", std::process::id().to_string());
        // debugpy's "frozen modules" warning, printed on every start — noise in the one place
        // (the report of a kernel that died) where the kernel's own output is shown.
        cmd.env("PYDEVD_DISABLE_FILE_VALIDATION", "1");
        crate::proc::own_process_group(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            let _ = std::fs::remove_file(&file);
            format!("No se pudo iniciar el kernel ({}): {e}", argv[0])
        })?;
        // Released now, before the kernel gets as far as binding them — see `reserve_ports`.
        drop(listeners);

        let tail = Arc::new(Mutex::new(Tail::default()));
        let mut readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            readers.push(spawn_tail_reader(stdout, tail.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(spawn_tail_reader(stderr, tail.clone()));
        }

        let state = Arc::new(AtomicU8::new(STATE_STARTING));
        let pid = child.id();
        let (exit_tx, exit_rx) = watch::channel(None);
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let task = {
            let events = self.events.clone();
            let id = self.id.clone();
            let state = state.clone();
            let tail = tail.clone();
            tokio::spawn(async move {
                let code = tokio::select! {
                    status = child.wait() => status.ok().and_then(|s| s.code()),
                    _ = kill_rx => {
                        crate::ai_runs::kill_tree(&mut child).await;
                        child.try_wait().ok().flatten().and_then(|s| s.code())
                    }
                };
                let _ = exit_tx.send(Some(code));
                // Only a kernel that was running and not being stopped has *died*; one that exits
                // while starting is reported by the start that was waiting on it.
                if state.compare_exchange(STATE_RUNNING, STATE_DEAD, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                    // Give the readers a moment to drain what it printed on the way out.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let stderr = tail.lock().map(|t| t.text()).unwrap_or_default();
                    events.lifecycle(&id, Lifecycle::Died { code, stderr });
                }
            })
        };
        let process = Process { pid, exit: exit_rx, kill: Some(kill_tx), tail, task };

        let mut exit = process.exit.clone();
        let started = async {
            wait_for_ports(&info, START_TIMEOUT).await?;
            let mut live = connect(&self.id, &info, &self.events, state.clone(), Some(file.clone()), None).await?;
            let reply = handshake(&mut live, START_TIMEOUT).await?;
            Ok::<_, String>((live, reply))
        };
        let outcome = tokio::select! {
            outcome = started => outcome,
            _ = exit.wait_for(|code| code.is_some()) => Err(String::new()),
        };
        match outcome {
            Ok((mut live, reply)) => {
                live.tasks.extend(readers);
                live.process = Some(process);
                live.state.store(STATE_RUNNING, Ordering::SeqCst);
                Ok((live, reply))
            }
            Err(reason) => {
                let exited = process.exit.borrow().clone();
                let mut process = process;
                if exited.is_none() {
                    if let Some(kill) = process.kill.take() {
                        let _ = kill.send(());
                    }
                    let mut exit = process.exit.clone();
                    let _ = tokio::time::timeout(SHUTDOWN_GRACE, exit.wait_for(|code| code.is_some())).await;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                let stderr = process.tail.lock().map(|t| t.text()).unwrap_or_default();
                let _ = std::fs::remove_file(&file);
                Err(start_failure(&argv[0], exited.flatten(), &reason, &stderr))
            }
        }
    }

    /// Sends an `execute_request` under the id the caller chose, so every output it produces can
    /// be told apart by that id before any of them arrives.
    pub async fn execute(&self, msg_id: &str, code: &str, allow_stdin: bool) -> Result<(), String> {
        let (session, shell) = {
            let guard = self.live.lock().await;
            let live = guard.as_ref().ok_or_else(not_running)?;
            (live.session.clone(), live.shell.clone())
        };
        let message = Message::with_id(
            "execute_request",
            &session,
            msg_id,
            json!({
                "code": code,
                "silent": false,
                "store_history": true,
                "user_expressions": {},
                "allow_stdin": allow_stdin,
                // A failing cell aborts the ones queued behind it — "run all" stops at the first
                // error, as it does in Jupyter.
                "stop_on_error": true,
            }),
        );
        shell.send(message).map_err(|_| not_running())
    }

    /// Answers the `input_request` the kernel is waiting on.
    pub async fn input_reply(&self, value: &str) -> Result<(), String> {
        let guard = self.live.lock().await;
        let live = guard.as_ref().ok_or_else(not_running)?;
        let request = live
            .pending_input
            .lock()
            .map_err(|e| e.to_string())?
            .take()
            .ok_or_else(|| "El kernel no está esperando una entrada".to_string())?;
        let reply = Message::reply_to(&request, "input_reply", &live.session, json!({ "value": value }));
        live.stdin.send(reply).map_err(|_| not_running())
    }

    /// Interrupts what the kernel is running: SIGINT to its process group for a signal-mode kernel
    /// this app started, an `interrupt_request` otherwise.
    pub async fn interrupt(&self) -> Result<(), String> {
        let guard = self.live.lock().await;
        let live = guard.as_ref().ok_or_else(not_running)?;
        #[cfg(unix)]
        if self.choice.interrupt_mode == InterruptMode::Signal {
            if let Some(pid) = live.process.as_ref().and_then(|p| p.pid) {
                // The pid is the group id — `proc::own_process_group`. SAFETY: `kill` takes integers.
                let sent = unsafe { libc::kill(-(pid as i32), libc::SIGINT) };
                return if sent == 0 { Ok(()) } else { Err(std::io::Error::last_os_error().to_string()) };
            }
        }
        let request = Message::request("interrupt_request", &live.session, json!({}));
        let reply = await_reply(&live.waiters, &live.control, request, Duration::from_secs(5)).await;
        reply.map(|_| ()).ok_or_else(|| "El kernel no respondió a la interrupción".to_string())
    }

    /// Stops the kernel and starts it again from the same kernelspec, in the same folder. Its
    /// state is gone; the notebook's outputs are the notebook's business.
    pub async fn restart(&self) -> Result<Value, String> {
        let mut guard = self.live.lock().await;
        self.events.lifecycle(&self.id, Lifecycle::Restarting);
        if let Some(live) = guard.take() {
            stop(live, true, SHUTDOWN_GRACE).await;
        }
        let (live, info) = self.launch().await.inspect_err(|error| {
            self.events.lifecycle(&self.id, Lifecycle::Died { code: None, stderr: error.clone() });
        })?;
        *guard = Some(live);
        drop(guard);
        self.events.lifecycle(&self.id, Lifecycle::Ready { info: info.clone() });
        Ok(info)
    }

    /// Asks the kernel to leave, and makes sure it has within `grace` (plus the kill's own grace).
    pub async fn shutdown(&self, grace: Duration) {
        let live = self.live.lock().await.take();
        if let Some(live) = live {
            stop(live, false, grace).await;
        }
        self.events.lifecycle(&self.id, Lifecycle::Stopped);
    }
}

fn not_running() -> String {
    "El kernel no está en marcha".to_string()
}

/// `{connection_file}` and `{resource_dir}` substituted into a kernelspec's `argv`, the way
/// `jupyter_client` formats it — an unknown `{name}` is left as written.
pub fn expand_argv(argv: &[String], connection_file: &Path, resource_dir: Option<&str>) -> Vec<String> {
    let file = connection_file.to_string_lossy();
    argv.iter()
        .map(|arg| {
            let mut arg = arg.replace("{connection_file}", &file);
            if let Some(dir) = resource_dir {
                arg = arg.replace("{resource_dir}", dir);
            }
            arg
        })
        .collect()
}

/// Why a kernel did not come up, in words the notebook can show as they are.
fn start_failure(program: &str, code: Option<i32>, reason: &str, stderr: &str) -> String {
    let mut message = match code {
        Some(code) => format!("El kernel terminó al iniciar (código {code})."),
        None if !reason.is_empty() => reason.to_string(),
        None => format!("El kernel ({program}) terminó al iniciar."),
    };
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        message.push_str("\n\n");
        message.push_str(stderr);
    }
    message
}

fn spawn_tail_reader<R>(stream: R, tail: Arc<Mutex<Tail>>) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(mut tail) = tail.lock() {
                tail.push(&line);
            }
        }
    })
}

/// Waits until every port of the connection accepts a TCP connection — the kernel has bound them.
///
/// The ZeroMQ connect retries on its own, but with a backoff that starts at 1.4 s; polling here
/// every 50 ms is what makes a kernel that is up in 800 ms usable in 800 ms.
async fn wait_for_ports(info: &ConnectionInfo, limit: Duration) -> Result<(), String> {
    let ports = [info.shell_port, info.iopub_port, info.stdin_port, info.control_port, info.hb_port];
    let deadline = tokio::time::Instant::now() + limit;
    for port in ports {
        loop {
            if tokio::net::TcpStream::connect((info.ip.as_str(), port)).await.is_ok() {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("El kernel no abrió sus puertos a tiempo".to_string());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    Ok(())
}

fn socket_options(identity: Option<&str>) -> zeromq::SocketOptions {
    let mut options = zeromq::SocketOptions::default();
    options.connect_timeout(Duration::from_secs(20));
    if let Some(identity) = identity {
        if let Ok(peer) = zeromq::util::PeerIdentity::try_from(identity.as_bytes().to_vec()) {
            options.peer_identity(peer);
        }
    }
    options
}

/// Opens the five sockets and starts the tasks that serve them.
async fn connect(
    kernel_id: &str,
    info: &ConnectionInfo,
    events: &Arc<dyn KernelEvents>,
    state: Arc<AtomicU8>,
    file: Option<PathBuf>,
    session: Option<String>,
) -> Result<Live, String> {
    let session = session.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let signer = Signer::new(&info.key);
    let waiters: Waiters = Arc::new(Mutex::new(HashMap::new()));
    let pending_input = Arc::new(Mutex::new(None));
    let iopub_seen = Arc::new(AtomicU64::new(0));
    let failed = |what: &str, e: zeromq::ZmqError| format!("No se pudo conectar con el kernel ({what}): {e}");
    let mut tasks = Vec::new();

    // iopub first, so the subscription is in place before anything is asked.
    let mut iopub = zeromq::SubSocket::with_options(socket_options(None));
    iopub.connect(&info.endpoint(info.iopub_port)).await.map_err(|e| failed("iopub", e))?;
    iopub.subscribe("").await.map_err(|e| failed("iopub", e))?;
    tasks.push({
        let signer = signer.clone();
        let events = events.clone();
        let kernel_id = kernel_id.to_string();
        let seen = iopub_seen.clone();
        tokio::spawn(async move {
            while let Ok(frames) = iopub.recv().await {
                let Ok(message) = wire::decode(frames.into_vec(), &signer) else { continue };
                seen.fetch_add(1, Ordering::SeqCst);
                events.message(&kernel_id, Channel::Iopub, &message);
            }
        })
    });

    let mut open = |channel: Channel, socket: zeromq::DealerSocket| -> mpsc::UnboundedSender<Message> {
        let (send, recv) = socket.split();
        let (tx, rx) = mpsc::unbounded_channel();
        tasks.push(spawn_writer(send, rx, signer.clone()));
        tasks.push(spawn_reader(
            recv,
            channel,
            signer.clone(),
            kernel_id.to_string(),
            events.clone(),
            waiters.clone(),
            pending_input.clone(),
        ));
        tx
    };

    let mut shell = zeromq::DealerSocket::with_options(socket_options(Some(&session)));
    shell.connect(&info.endpoint(info.shell_port)).await.map_err(|e| failed("shell", e))?;
    let shell = open(Channel::Shell, shell);
    let mut control = zeromq::DealerSocket::with_options(socket_options(Some(&session)));
    control.connect(&info.endpoint(info.control_port)).await.map_err(|e| failed("control", e))?;
    let control = open(Channel::Control, control);
    // The same identity as shell: an `input_request` is routed to the stdin socket of whoever sent
    // the execution.
    let mut stdin = zeromq::DealerSocket::with_options(socket_options(Some(&session)));
    stdin.connect(&info.endpoint(info.stdin_port)).await.map_err(|e| failed("stdin", e))?;
    let stdin = open(Channel::Stdin, stdin);

    tasks.push(tokio::spawn(heartbeat(
        info.endpoint(info.hb_port),
        kernel_id.to_string(),
        events.clone(),
        state.clone(),
    )));

    Ok(Live {
        session,
        file,
        shell,
        control,
        stdin,
        waiters,
        pending_input,
        iopub_seen,
        state,
        process: None,
        tasks,
    })
}

fn spawn_writer(
    mut socket: zeromq::DealerSendHalf,
    mut rx: mpsc::UnboundedReceiver<Message>,
    signer: Signer,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Ok(frames) = zeromq::ZmqMessage::try_from(wire::encode(&message, &signer)) else { continue };
            if socket.send(frames).await.is_err() {
                break;
            }
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_reader(
    mut socket: zeromq::DealerRecvHalf,
    channel: Channel,
    signer: Signer,
    kernel_id: String,
    events: Arc<dyn KernelEvents>,
    waiters: Waiters,
    pending_input: Arc<Mutex<Option<Message>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Ok(frames) = socket.recv().await {
            // A frame list that does not verify is not the kernel speaking; it is dropped.
            let Ok(message) = wire::decode(frames.into_vec(), &signer) else { continue };
            if channel == Channel::Stdin && message.msg_type() == "input_request" {
                if let Ok(mut pending) = pending_input.lock() {
                    *pending = Some(message.clone());
                }
            }
            if let Some(parent) = message.parent_msg_id() {
                let waiter = waiters.lock().ok().and_then(|mut w| w.remove(parent));
                if let Some(waiter) = waiter {
                    let _ = waiter.send(message);
                    continue;
                }
            }
            events.message(&kernel_id, channel, &message);
        }
    })
}

/// Sends `request` and waits for the reply to it, which then goes to the caller instead of to the
/// events.
async fn await_reply(
    waiters: &Waiters,
    channel: &mpsc::UnboundedSender<Message>,
    request: Message,
    limit: Duration,
) -> Option<Message> {
    let (tx, rx) = oneshot::channel();
    let id = request.msg_id().to_string();
    waiters.lock().ok()?.insert(id.clone(), tx);
    if channel.send(request).is_err() {
        waiters.lock().ok()?.remove(&id);
        return None;
    }
    let reply = tokio::time::timeout(limit, rx).await.ok().and_then(Result::ok);
    if reply.is_none() {
        if let Ok(mut waiters) = waiters.lock() {
            waiters.remove(&id);
        }
    }
    reply
}

/// Asks for `kernel_info` until the kernel answers **and** iopub has carried something.
///
/// The second half is ZeroMQ's slow-joiner problem: a SUB socket's subscription reaches the
/// publisher a moment after the connect, and whatever is published in that moment is gone — which
/// would be the first cell's first output. The kernel publishes a busy/idle pair around every
/// request, so seeing any iopub traffic after a reply proves the subscription is live.
async fn handshake(live: &mut Live, limit: Duration) -> Result<Value, String> {
    let deadline = tokio::time::Instant::now() + limit;
    let mut info = None;
    while tokio::time::Instant::now() < deadline {
        let seen_before = live.iopub_seen.load(Ordering::SeqCst);
        let request = Message::request("kernel_info_request", &live.session, json!({}));
        let wait = if info.is_none() {
            deadline.saturating_duration_since(tokio::time::Instant::now())
        } else {
            Duration::from_secs(2)
        };
        if let Some(reply) = await_reply(&live.waiters, &live.shell, request, wait).await {
            info = Some(reply.content);
        }
        if info.is_some() {
            // Wait briefly for the status pair of that request to come through iopub.
            for _ in 0..20 {
                if live.iopub_seen.load(Ordering::SeqCst) > seen_before {
                    return Ok(info.take().unwrap_or(Value::Null));
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
    match info {
        // It answers, and iopub never carried a thing: usable, but outputs may be lost. Better a
        // kernel than none.
        Some(info) => Ok(info),
        None => Err("El kernel no respondió a tiempo".to_string()),
    }
}

async fn heartbeat(endpoint: String, kernel_id: String, events: Arc<dyn KernelEvents>, state: Arc<AtomicU8>) {
    let mut socket: Option<zeromq::ReqSocket> = None;
    let mut misses = 0;
    let mut unresponsive = false;
    loop {
        tokio::time::sleep(HEARTBEAT_INTERVAL).await;
        if state.load(Ordering::SeqCst) != STATE_RUNNING {
            continue;
        }
        if socket.is_none() {
            let mut fresh = zeromq::ReqSocket::with_options(socket_options(None));
            if tokio::time::timeout(HEARTBEAT_TIMEOUT, fresh.connect(&endpoint)).await.is_ok_and(|r| r.is_ok()) {
                socket = Some(fresh);
            }
        }
        let answered = match socket.as_mut() {
            Some(sock) => {
                sock.send(zeromq::ZmqMessage::from("ping")).await.is_ok()
                    && tokio::time::timeout(HEARTBEAT_TIMEOUT, sock.recv()).await.is_ok_and(|r| r.is_ok())
            }
            None => false,
        };
        if answered {
            misses = 0;
            if unresponsive {
                unresponsive = false;
                events.lifecycle(&kernel_id, Lifecycle::Responsive);
            }
        } else {
            // A REQ that sent and never heard back cannot send again; start over with a new one.
            socket = None;
            misses += 1;
            if misses >= HEARTBEAT_MISSES && !unresponsive && state.load(Ordering::SeqCst) == STATE_RUNNING {
                unresponsive = true;
                events.lifecycle(&kernel_id, Lifecycle::Unresponsive);
            }
        }
    }
}

/// Stops one incarnation: `shutdown_request`, a grace period to leave by itself, then the group's
/// kill. The sockets go last, so the reply can still be read.
async fn stop(mut live: Live, restart: bool, grace: Duration) {
    live.state.store(STATE_STOPPING, Ordering::SeqCst);
    let request = Message::request("shutdown_request", &live.session, json!({ "restart": restart }));
    match live.process.as_mut() {
        Some(process) => {
            let _ = live.control.send(request);
            let mut exit = process.exit.clone();
            let left = tokio::time::timeout(grace, exit.wait_for(|code| code.is_some())).await.is_ok();
            if !left {
                if let Some(kill) = process.kill.take() {
                    let _ = kill.send(());
                }
                let _ = tokio::time::timeout(SHUTDOWN_GRACE + Duration::from_secs(1), exit.wait_for(|code| code.is_some())).await;
            }
            if process.exit.borrow().is_none() {
                process.task.abort();
            }
        }
        None => {
            let _ = await_reply(&live.waiters, &live.control, request, grace).await;
        }
    }
    for task in live.tasks.drain(..) {
        task.abort();
    }
    if let Some(file) = &live.file {
        let _ = std::fs::remove_file(file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    /// The events a kernel reported, in order.
    #[derive(Default)]
    struct Collected {
        messages: Mutex<Vec<(Channel, Message)>>,
        lifecycle: Mutex<Vec<Lifecycle>>,
        notify: tokio::sync::Notify,
    }

    impl KernelEvents for Collected {
        fn message(&self, _kernel_id: &str, channel: Channel, message: &Message) {
            self.messages.lock().unwrap().push((channel, message.clone()));
            self.notify.notify_waiters();
        }
        fn lifecycle(&self, _kernel_id: &str, lifecycle: Lifecycle) {
            self.lifecycle.lock().unwrap().push(lifecycle);
            self.notify.notify_waiters();
        }
    }

    impl Collected {
        async fn wait_for(&self, what: impl Fn(&[(Channel, Message)]) -> bool) {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                if what(&self.messages.lock().unwrap()) {
                    return;
                }
                assert!(tokio::time::Instant::now() < deadline, "timed out waiting for kernel messages");
                let _ = tokio::time::timeout(Duration::from_millis(50), self.notify.notified()).await;
            }
        }
    }

    #[test]
    fn expands_the_placeholders_jupyter_client_does() {
        let argv: Vec<String> = ["{resource_dir}/run", "-f", "{connection_file}", "{unknown}"].map(String::from).to_vec();
        let expanded = expand_argv(&argv, Path::new("/rt/kernel-1.json"), Some("/k/r"));
        assert_eq!(expanded, ["/k/r/run", "-f", "/rt/kernel-1.json", "{unknown}"]);
    }

    #[test]
    fn a_start_failure_carries_what_the_kernel_printed() {
        let message = start_failure("python3", Some(1), "", "Traceback…\nModuleNotFoundError: No module named 'ipykernel_launcher'");
        assert!(message.starts_with("El kernel terminó al iniciar (código 1)."));
        assert!(message.ends_with("No module named 'ipykernel_launcher'"));
    }

    #[test]
    fn the_tail_keeps_the_last_lines() {
        let mut tail = Tail::default();
        for n in 0..(TAIL_LINES + 5) {
            tail.push(&format!("line {n}"));
        }
        let text = tail.text();
        assert!(text.starts_with("line 5\n"));
        assert!(text.ends_with(&format!("line {}", TAIL_LINES + 4)));
    }

    /// A kernel of our own, on real ZeroMQ sockets: it answers `kernel_info`, runs "code" by
    /// echoing it to stdout, asks for input when told to, and publishes what a real kernel
    /// publishes around each request. Enough to drive every path of the client end to end.
    async fn fake_kernel(info: ConnectionInfo) {
        let signer = Signer::new(&info.key);
        let mut shell = zeromq::RouterSocket::new();
        shell.bind(&info.endpoint(info.shell_port)).await.unwrap();
        let mut control = zeromq::RouterSocket::new();
        control.bind(&info.endpoint(info.control_port)).await.unwrap();
        let mut stdin = zeromq::RouterSocket::new();
        stdin.bind(&info.endpoint(info.stdin_port)).await.unwrap();
        let mut iopub = zeromq::PubSocket::new();
        iopub.bind(&info.endpoint(info.iopub_port)).await.unwrap();
        let mut hb = zeromq::RepSocket::new();
        hb.bind(&info.endpoint(info.hb_port)).await.unwrap();
        tokio::spawn(async move {
            while let Ok(ping) = hb.recv().await {
                if hb.send(ping).await.is_err() {
                    break;
                }
            }
        });

        let session = "fake-kernel";
        let mut count = 0;
        // Published the way ipykernel does it: a topic frame before the delimiter.
        let publish = |parent: &Message, msg_type: &str, content: Value| {
            let mut message = Message::reply_to(parent, msg_type, session, content);
            message.identities = vec![Bytes::from(format!("kernel.{msg_type}"))];
            zeromq::ZmqMessage::try_from(wire::encode(&message, &signer)).unwrap()
        };
        loop {
            tokio::select! {
                request = shell.recv() => {
                    let Ok(request) = request else { break };
                    let request = wire::decode(request.into_vec(), &signer).expect("the client signs what it sends");
                    iopub.send(publish(&request, "status", json!({"execution_state": "busy"}))).await.unwrap();
                    let reply = match request.msg_type() {
                        "kernel_info_request" => {
                            Message::reply_to(&request, "kernel_info_reply", session, json!({
                                "status": "ok", "protocol_version": "5.3", "implementation": "fake",
                                "language_info": {"name": "python", "version": "3.12.0", "file_extension": ".py"},
                                "banner": "fake kernel"
                            }))
                        }
                        "execute_request" => {
                            count += 1;
                            let code = request.content["code"].as_str().unwrap_or_default().to_string();
                            iopub.send(publish(&request, "execute_input", json!({"code": code, "execution_count": count}))).await.unwrap();
                            let text = if code == "input()" {
                                let mut ask = Message::reply_to(&request, "input_request", session, json!({"prompt": "name? ", "password": false}));
                                ask.identities = request.identities.clone();
                                stdin.send(zeromq::ZmqMessage::try_from(wire::encode(&ask, &signer)).unwrap()).await.unwrap();
                                let answer = wire::decode(stdin.recv().await.unwrap().into_vec(), &signer).unwrap();
                                assert_eq!(answer.msg_type(), "input_reply");
                                assert_eq!(answer.parent_msg_id(), Some(ask.msg_id()));
                                format!("hello {}\n", answer.content["value"].as_str().unwrap_or_default())
                            } else {
                                format!("{code}\n")
                            };
                            iopub.send(publish(&request, "stream", json!({"name": "stdout", "text": text}))).await.unwrap();
                            Message::reply_to(&request, "execute_reply", session, json!({"status": "ok", "execution_count": count}))
                        }
                        other => Message::reply_to(&request, &other.replace("_request", "_reply"), session, json!({"status": "ok"})),
                    };
                    shell.send(zeromq::ZmqMessage::try_from(wire::encode(&reply, &signer)).unwrap()).await.unwrap();
                    iopub.send(publish(&request, "status", json!({"execution_state": "idle"}))).await.unwrap();
                }
                request = control.recv() => {
                    let Ok(request) = request else { break };
                    let request = wire::decode(request.into_vec(), &signer).unwrap();
                    let msg_type = request.msg_type().replace("_request", "_reply");
                    let reply = Message::reply_to(&request, &msg_type, session, json!({"status": "ok"}));
                    control.send(zeromq::ZmqMessage::try_from(wire::encode(&reply, &signer)).unwrap()).await.unwrap();
                    if request.msg_type() == "shutdown_request" {
                        break;
                    }
                }
            }
        }
    }

    /// A kernel whose process exits while starting — the classic being a Python without ipykernel
    /// — fails the start with its exit code and what it printed, and leaves no connection file.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_kernel_that_dies_on_start_says_why() {
        let choice = KernelChoice {
            id: "dies".into(),
            name: "dies".into(),
            display_name: "Dies".into(),
            language: "python".into(),
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                "echo \"No module named ipykernel_launcher\" >&2; exit 3".into(),
                "{connection_file}".into(),
            ],
            env: Default::default(),
            interrupt_mode: InterruptMode::Signal,
            source: super::super::kernelspec::KernelSource::Directory,
            resource_dir: None,
            python: None,
        };
        let runtime = std::env::temp_dir().join(format!("cf-dying-kernel-{}", uuid::Uuid::new_v4()));
        let events = Arc::new(Collected::default());
        let error = match Kernel::start("dies".into(), choice, std::env::temp_dir(), runtime.clone(), events.clone()).await {
            Ok(_) => panic!("a kernel that exits cannot have started"),
            Err(error) => error,
        };
        assert!(error.contains("(código 3)"), "{error}");
        assert!(error.contains("No module named ipykernel_launcher"), "{error}");
        let leftovers = std::fs::read_dir(&runtime).map(|dir| dir.count()).unwrap_or(0);
        assert_eq!(leftovers, 0, "the connection file goes with the kernel");
        // Reported by the start that failed, not as a death afterwards.
        assert!(!events.lifecycle.lock().unwrap().iter().any(|l| matches!(l, Lifecycle::Died { .. })));
        let _ = std::fs::remove_dir_all(&runtime);
    }

    /// A real ipykernel, when this machine has one: start, run, read input, interrupt, restart,
    /// shut down. Skipped (and says so) where `python3 -c "import ipykernel"` fails — nothing is
    /// ever installed for it.
    #[tokio::test]
    async fn live_ipykernel_round_trip() {
        let Some(python) = std::env::var_os("PATH")
            .and_then(|path| std::env::split_paths(&path).map(|dir| dir.join("python3")).find(|p| p.is_file()))
        else {
            eprintln!("skipped: no python3 on PATH");
            return;
        };
        let Some(probe) = super::super::kernelspec::probe_python(&python).await else {
            eprintln!("skipped: python3 did not run");
            return;
        };
        if !probe.has_ipykernel {
            eprintln!("skipped: ipykernel is not installed for {}", python.display());
            return;
        }
        let choice = super::super::kernelspec::python_kernel(
            &python,
            "PATH",
            &probe.version,
            super::super::kernelspec::KernelSource::Path,
        );
        let runtime = std::env::temp_dir().join(format!("cf-live-kernel-{}", uuid::Uuid::new_v4()));
        let events = Arc::new(Collected::default());
        let (kernel, info) = Kernel::start("live".into(), choice, std::env::temp_dir(), runtime.clone(), events.clone())
            .await
            .expect("ipykernel starts");
        assert_eq!(info["language_info"]["name"], "python");

        kernel.execute("m1", "print(1 + 1)", true).await.unwrap();
        events
            .wait_for(|all| all.iter().any(|(_, m)| m.msg_type() == "stream" && m.parent_msg_id() == Some("m1")))
            .await;
        assert!(events
            .messages
            .lock()
            .unwrap()
            .iter()
            .any(|(_, m)| m.msg_type() == "stream" && m.content["text"] == "2\n"));

        kernel.execute("m2", "name = input('who? ')\nprint('hi', name)", true).await.unwrap();
        events
            .wait_for(|all| all.iter().any(|(ch, m)| *ch == Channel::Stdin && m.msg_type() == "input_request"))
            .await;
        kernel.input_reply("Ana").await.unwrap();
        events
            .wait_for(|all| all.iter().any(|(_, m)| m.msg_type() == "stream" && m.content["text"] == "hi Ana\n"))
            .await;

        // Interrupted mid-sleep: the reply says it was, and the kernel is still usable.
        kernel.execute("m3", "import time\ntime.sleep(30)", true).await.unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        kernel.interrupt().await.unwrap();
        events
            .wait_for(|all| {
                all.iter().any(|(_, m)| m.msg_type() == "error" && m.parent_msg_id() == Some("m3") && m.content["ename"] == "KeyboardInterrupt")
            })
            .await;

        let restarted = kernel.restart().await.expect("restarts");
        assert_eq!(restarted["language_info"]["name"], "python");
        kernel.execute("m4", "print('after')", true).await.unwrap();
        events
            .wait_for(|all| all.iter().any(|(_, m)| m.msg_type() == "stream" && m.content["text"] == "after\n"))
            .await;

        kernel.shutdown(Duration::from_secs(3)).await;
        assert!(!events.lifecycle.lock().unwrap().iter().any(|l| matches!(l, Lifecycle::Died { .. })));
        let _ = std::fs::remove_dir_all(&runtime);
    }

    #[tokio::test]
    async fn drives_a_kernel_over_real_sockets() {
        let (ports, listeners) = connection::reserve_ports().unwrap();
        drop(listeners);
        let info = ConnectionInfo::loopback(ports, "fake");
        let server = tokio::spawn(fake_kernel(info.clone()));

        let events = Arc::new(Collected::default());
        let (kernel, reply) = Kernel::attach("k1".into(), info, events.clone()).await.unwrap();
        assert_eq!(reply["language_info"]["name"], "python");
        assert_eq!(reply["implementation"], "fake");

        // An execution: its outputs arrive on iopub under the id the caller chose, its reply on shell.
        kernel.execute("cell-1", "print(1)", true).await.unwrap();
        events
            .wait_for(|all| all.iter().any(|(ch, m)| *ch == Channel::Shell && m.msg_type() == "execute_reply"))
            .await;
        {
            let all = events.messages.lock().unwrap();
            let stream = all
                .iter()
                .find(|(ch, m)| *ch == Channel::Iopub && m.msg_type() == "stream" && m.parent_msg_id() == Some("cell-1"))
                .expect("the output is attributed to its execution");
            assert_eq!(stream.1.content["text"], "print(1)\n");
            let reply = all.iter().find(|(_, m)| m.msg_type() == "execute_reply").unwrap();
            assert_eq!(reply.1.parent_msg_id(), Some("cell-1"));
            assert_eq!(reply.1.content["execution_count"], 1);
            // The handshake's own kernel_info reply went to the handshake, not to the events.
            assert!(!all.iter().any(|(_, m)| m.msg_type() == "kernel_info_reply"));
        }

        // input(): the request arrives on stdin, the reply goes back to the kernel that asked.
        kernel.execute("cell-2", "input()", true).await.unwrap();
        events
            .wait_for(|all| all.iter().any(|(ch, m)| *ch == Channel::Stdin && m.msg_type() == "input_request"))
            .await;
        kernel.input_reply("Ana").await.unwrap();
        events
            .wait_for(|all| {
                all.iter().any(|(_, m)| m.msg_type() == "stream" && m.content["text"] == "hello Ana\n")
            })
            .await;
        assert!(kernel.input_reply("again").await.is_err(), "nothing is waiting for input any more");

        // Interrupting an attached (message-mode) kernel asks over control and waits for the answer.
        kernel.interrupt().await.unwrap();

        kernel.shutdown(Duration::from_secs(2)).await;
        assert_eq!(events.lifecycle.lock().unwrap().last(), Some(&Lifecycle::Stopped));
        tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
        assert!(kernel.execute("cell-3", "x", true).await.is_err(), "a stopped kernel runs nothing");
    }
}
