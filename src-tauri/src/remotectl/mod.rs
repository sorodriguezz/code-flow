//! Driving this install from a phone on the same network.
//!
//! # What this is
//!
//! A small HTTP + WebSocket server, off by default, that lets a paired phone or tablet call a
//! fixed list of commands (`dispatch.rs`) and watch the events the desktop watches (`bridge.rs`).
//!
//! # What it is not
//!
//! It is **not** a second copy of the app. There is no state here, no database of its own, no
//! parallel session — the phone drives *this* process, the same one the window is drawing. That is
//! the entire design, and it is what makes the hard part free: an action taken on the phone runs
//! the same function the desktop button runs, touches the same working copy, emits the same
//! events. The desktop does not have to be *told* about most of it; it finds out the way it
//! already finds out about everything else.
//!
//! Three channels carry that, and only the third needed building:
//!
//! 1. **The filesystem.** A commit or a checkout from the phone moves bytes on disk, `watcher.rs`
//!    sees it and emits `repo:fs-changed`, and `App.tsx` refreshes. Nothing here is involved.
//! 2. **Process events.** A run cancelled from the phone emits `ai:output-batch` and `ai:engine`
//!    exactly as before, and `aiRunStore` is already subscribed. Nothing here is involved either.
//! 3. **The database.** This is the gap: approving a gate writes SQLite and moves nothing on disk,
//!    so no watcher fires and the desktop's zustand copy goes stale. `state:invalidate` is the
//!    answer — see [`dispatch::Invalidate`] and `bridge::emit_invalidation`.
//!
//! # Lifetime
//!
//! The server starts when the setting says so — at boot in `lib.rs`, or when the settings toggle
//! flips — and is stopped by dropping the shutdown sender in [`Running`]. Turning it off does not
//! revoke devices: the user may simply be leaving the café. Revoking is its own explicit action.

pub mod auth;
pub mod bridge;
pub mod dispatch;
pub mod server;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, oneshot};
use tokio_util::sync::CancellationToken;

use crate::db::{queries, Db};

/// `app_settings` key: whether the server comes up at launch.
pub const SETTING_ENABLED: &str = "remotectl_enabled";
/// `app_settings` key: the TCP port to bind.
pub const SETTING_PORT: &str = "remotectl_port";

/// `app_settings` key: whether a paired device may open and drive a shell.
///
/// # Why this is its own switch and not part of the allowlist
///
/// Everything else a phone can reach is *bounded*: it can commit, push, answer a gate, send a chat
/// turn. Each of those is a specific act with a specific blast radius, and the table in
/// `dispatch.rs` is what draws it.
///
/// A shell has no such bound. It is arbitrary code execution as the user, on their machine — it can
/// read the keychain through whatever CLI is installed, exfiltrate a repository, install something.
/// No amount of care in this module changes that, because it is what a terminal *is*. Note that the
/// API itself carries no command line (`open_terminal` takes a working directory and a shell
/// profile id, both resolved on this side), so there is nothing to inject; the execution comes from
/// keystrokes afterwards, which is the same thing by a slower route.
///
/// So it is offered rather than refused — it is the user's machine and their network, and they
/// asked for it — but it is offered *separately*, off by default, and described honestly at the
/// switch. Turning the server on must not silently mean this too.
///
/// Two things read it: the terminal arms in `dispatch.rs`, and — just as importantly — the event
/// bridge, which must not forward `terminal:output` to a device that is not allowed terminals. See
/// `bridge::forwarded_events`.
pub const SETTING_ALLOW_TERMINAL: &str = "remotectl_allow_terminal";

/// Where the server listens when the setting has never been written.
///
/// Above 1024 so no elevation is needed, and outside the ranges the tools a developer is likely to
/// have running already claim — 3000/5173/8080 are somebody's dev server on most machines, and
/// colliding with one would make the feature look broken on first launch.
pub const DEFAULT_PORT: u16 = 8787;

/// How many event frames a slow phone may fall behind before it starts losing the oldest.
///
/// A live agent run is the heaviest producer here, and `ai:output-batch` is already coalesced to
/// ~100 ms by the time it reaches this. 256 frames is therefore around 25 seconds of the worst
/// case — long enough to ride out a phone locking its screen mid-run, short enough that a
/// disconnected client cannot pin megabytes of transcript in memory.
const EVENT_BUFFER: usize = 256;

/// How many revocation notices may queue up before a socket that is not reading loses one.
///
/// Four is generous for a channel whose traffic is "somebody pressed Revoke": the arms in
/// [`server::pump`] treat a `Lagged` as "re-check the database now", so a lost notice costs one
/// query and never a missed revocation.
const CONTROL_BUFFER: usize = 4;

/// Out-of-band orders for live sockets, carried on their own channel rather than as event frames.
///
/// Not a `state:invalidate` and not a forwarded event, because the audience is different: these say
/// something about *the connection itself*, they must reach a socket even when the client has
/// stopped acting on frames, and they end with the socket closed. Putting them on the event channel
/// would mean every phone parsing every other phone's revocation.
/// One serialized event frame on its way to the sockets, and who it is for.
///
/// # Why the fan-out needed an address
///
/// It used to be a bare `String`: every frame went to every connected device, which is right for
/// almost everything here — a commit, a chain step, an agent's output are the same news for anybody
/// watching. `terminal:output` is not. It carries the bytes of one pty, and until this existed
/// **every paired phone received every terminal's output on the machine**, including shells opened
/// at the desk and live `ssh -t` logins into other people's servers, gated on nothing but the global
/// terminal switch. A phone allowed to open *a* shell was thereby shown *every* shell.
///
/// So a frame that belongs to one device says so, and [`server::pump`] drops the ones addressed
/// elsewhere. Addressing at the socket rather than filtering at the client, because the client is the
/// party that must not be trusted with the bytes in the first place.
#[derive(Debug, Clone)]
pub struct Fanout {
    /// The frame, already serialized. See `bridge::frame`.
    pub text: String,
    /// `None` for news everybody gets; `Some(device_id)` for a frame only that device may see.
    pub only: Option<String>,
}

#[derive(Debug, Clone)]
pub enum Control {
    /// This one device's credential is gone. Carries the device id, which is what the socket
    /// compares against — a phone must not be cut off because a *different* one was revoked.
    Revoked(String),
    /// Every device's is. The "I lost my phone" button.
    RevokedAll,
}

/// A running server, held only so it can be stopped.
struct Running {
    port: u16,
    /// Dropping this is what shuts axum down; see [`server::serve`].
    shutdown: Option<oneshot::Sender<()>>,
    /// Cancelled when *this* listener goes away, and the reason `stop()` actually severs sockets.
    ///
    /// `with_graceful_shutdown` cannot reach an upgraded WebSocket: by the time `pump` is running,
    /// hyper has already handed the connection over and stopped tracking it. So turning the server
    /// off — or rebinding to another port — left every phone's stream flowing while the settings
    /// panel said `Detenido`. This token is what the pumps actually wait on.
    ///
    /// Per-instance and never reused: a rebind creates a new one, so cancelling the old server's
    /// token cannot silently poison the sockets of the server that replaced it.
    cancel: CancellationToken,
}

/// Everything the feature owns, managed as Tauri state.
///
/// One struct rather than three so the settings screen, the HTTP handlers and the event bridge are
/// unambiguously talking about the same server — the bug this shape prevents is a toggle that
/// starts a second listener while the first is still bound.
pub struct RemoteCtl {
    pub pairing: auth::Pairing,
    running: Mutex<Option<Running>>,
    /// Serialized event frames, fanned out to every connected socket. Created once and kept for
    /// the process's life: a `broadcast::Sender` with no receivers is nearly free, and keeping it
    /// alive means [`bridge::attach`] can register its listeners once at startup rather than
    /// racing the server's on/off state.
    pub events: broadcast::Sender<Fanout>,
    /// Revocations, addressed at the socket rather than at the client. See [`Control`]. Kept for
    /// the process's life for the same reason `events` is.
    control: broadcast::Sender<Control>,
    /// How many live sockets each device currently holds.
    ///
    /// A count and not a flag, because a phone reconnecting overlaps: the new socket opens before
    /// the old one's close reaches this process, and a boolean would be cleared by the *old*
    /// connection's teardown a moment after the new one set it. Maintained by
    /// [`DeviceConnection`], which is the only thing allowed to touch it.
    connected: Mutex<HashMap<String, usize>>,
    /// Which listener is current, incremented once per bind. Read only by the terminal reap, to
    /// tell a device that left from a port the user moved. See [`reap_terminals_later`].
    generation: AtomicU64,
    /// The disconnection each device's pending reap was armed for. See [`stamp_disconnect`].
    reaps: Mutex<HashMap<String, u64>>,
    /// The source of those stamps. Monotonic for the process; only equality is ever asked of it.
    reap_stamps: AtomicU64,
}

impl Default for RemoteCtl {
    fn default() -> Self {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        let (control, _) = broadcast::channel(CONTROL_BUFFER);
        Self {
            pairing: auth::Pairing::default(),
            running: Mutex::new(None),
            events,
            control,
            connected: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
            reaps: Mutex::new(HashMap::new()),
            reap_stamps: AtomicU64::new(0),
        }
    }
}

impl RemoteCtl {
    /// The port the server is bound to right now, or `None` when it is off.
    pub fn active_port(&self) -> Option<u16> {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|r| r.port)
    }

    /// The cancellation handle of the listener that is up right now, or `None` when none is.
    ///
    /// A socket takes a clone of this at upgrade time and waits on it for the rest of its life, so
    /// `None` here has to refuse the upgrade rather than default to "never cancelled": a stream
    /// nobody can sever is exactly what this whole handle exists to prevent.
    pub fn cancel_token(&self) -> Option<CancellationToken> {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|r| r.cancel.clone())
    }

    /// Records a freshly bound listener, stopping whatever was bound before — including its
    /// sockets, which the dropped shutdown sender alone cannot reach. This is the path a port
    /// change takes (`server::start` calls it after rebinding), and without the cancel the phones
    /// would go on streaming from a listener the user believes they moved.
    fn set_running(&self, port: u16, shutdown: oneshot::Sender<()>, cancel: CancellationToken) {
        let mut slot = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut old) = slot.take() {
            old.cancel.cancel();
            drop(old.shutdown.take());
        }
        // Bumped for every listener this process installs. Its only reader is the terminal reap —
        // see `reap_terminals_later`, which uses it to tell "the phone went away" from "the door
        // moved while the phone stood still".
        self.generation.fetch_add(1, Ordering::SeqCst);
        *slot = Some(Running {
            port,
            shutdown: Some(shutdown),
            cancel,
        });
    }

    /// Which listener is current. See [`set_running`](Self::set_running).
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Stops the server if one is running. Idempotent — the settings screen calls this on a toggle
    /// it may already have applied.
    pub fn stop(&self) {
        let mut slot = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut running) = slot.take() {
            // Before the shutdown sender, because this is the half that reaches the WebSockets.
            // Graceful shutdown ends the *listener*; an already-upgraded connection outlives it.
            running.cancel.cancel();
            drop(running.shutdown.take());
        }
    }

    /// Tells live sockets that a credential is gone, so they close instead of streaming to a phone
    /// whose next RPC would be refused.
    ///
    /// The `Err` a broadcast with no receivers answers is the ordinary case — nobody has a phone
    /// connected — and is dropped rather than reported.
    pub fn announce(&self, control: Control) {
        let _ = self.control.send(control);
    }

    /// A receiver for [`announce`](Self::announce), taken once per socket at upgrade time.
    pub fn control(&self) -> broadcast::Receiver<Control> {
        self.control.subscribe()
    }

    /// Whether this device has an event socket open **right now**.
    ///
    /// The question `last_seen_at` cannot answer, and the settings panel asks it on every poll. A
    /// socket authenticates once at upgrade and then reads for hours, so a phone actively driving
    /// the machine writes `last_seen_at` exactly once and then looks, in that column, like a device
    /// that connected in the morning and left.
    pub fn is_connected(&self, device_id: &str) -> bool {
        self.connected
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(device_id)
            .is_some_and(|n| *n > 0)
    }

    /// Records one more socket for this device. Call [`DeviceConnection::open`] instead — this is
    /// the half without the guarantee that it will be undone.
    fn attach(&self, device_id: &str) {
        *self
            .connected
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(device_id.to_string())
            .or_insert(0) += 1;
        // A reconnect voids whatever reap was armed for the gap that just ended. Dropping the row
        // is what makes an older timer's captured epoch un-matchable when it finally fires.
        self.reaps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(device_id);
    }

    /// Releases one, answering how many this device has left. Removes the row at zero rather than
    /// leaving it, so a device paired and unpaired all day does not grow the map by one entry per
    /// session.
    fn detach(&self, device_id: &str) -> usize {
        let mut map = self.connected.lock().unwrap_or_else(|e| e.into_inner());
        let Some(count) = map.get_mut(device_id) else {
            return 0;
        };
        *count = count.saturating_sub(1);
        let left = *count;
        if left == 0 {
            map.remove(device_id);
        }
        left
    }

    /// Stamps this device's *current* disconnection, and answers with the stamp.
    ///
    /// The stamp is what makes the reap timer safe to overlap. A phone drops at t=0 arming a timer
    /// for t=45, reconnects at t=30, and drops again at t=44 arming a second timer. Without a stamp
    /// the first timer fires at t=45, sees a disconnected device, and kills the shell one second
    /// into a gap it knows nothing about — and since the doc for `TERMINAL_GRACE` says a lock screen
    /// disconnects a phone constantly, that overlap is the ordinary case rather than a corner.
    fn stamp_disconnect(&self, device_id: &str) -> u64 {
        let stamp = self.reap_stamps.fetch_add(1, Ordering::SeqCst) + 1;
        self.reaps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(device_id.to_string(), stamp);
        stamp
    }

    /// Whether the disconnection this stamp names is still the one in effect. False once the device
    /// has reconnected (see [`attach`](Self::attach)) or disconnected again.
    fn reap_still_current(&self, device_id: &str, stamp: u64) -> bool {
        self.reaps
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(device_id)
            == Some(&stamp)
    }
}

/// One live socket's entry in [`RemoteCtl::connected`], released by dropping it.
///
/// A guard and not a pair of statements around the loop because `pump` has several ways out — a
/// close frame, a read error, a failed send, a cancellation, a revocation, and the task simply
/// being dropped at shutdown. Every one of them has to decrement, and the one that gets forgotten
/// is the one that leaves the settings panel showing a green dot for a phone that is in a drawer.
pub struct DeviceConnection {
    app: AppHandle,
    device_id: String,
    /// The listener this socket was accepted by. Compared at reap time — see `Drop`.
    generation: u64,
}

impl DeviceConnection {
    pub fn open(app: &AppHandle, device_id: &str) -> Self {
        let state = app.state::<RemoteCtl>();
        state.attach(device_id);
        let generation = state.generation();
        Self { app: app.clone(), device_id: device_id.to_string(), generation }
    }
}

impl Drop for DeviceConnection {
    fn drop(&mut self) {
        let left = self.app.state::<RemoteCtl>().detach(&self.device_id);
        // The device's *last* socket going away, which is also when its filesystem watchers stop
        // having a reader. Released here rather than anywhere the client could ask, because the
        // ways a phone leaves are the ways that send nothing: a screen lock, a wifi handover, a
        // browser tab evicted in the background.
        //
        // `left > 0` is a reconnect still in progress, and skipping it is load-bearing: the new
        // socket opens before the old one's close reaches this process, so releasing here would
        // tear down the watcher the connection that replaced it had just re-registered — and
        // nothing would put it back until the next project switch.
        if left == 0 {
            crate::watcher::release_holder(
                &self.app.state::<crate::watcher::WatcherRegistry>(),
                &crate::watcher::device_holder(&self.device_id),
            );
            let stamp = self.app.state::<RemoteCtl>().stamp_disconnect(&self.device_id);
            reap_terminals_later(&self.app, &self.device_id, stamp, self.generation);
        }
    }
}

/// How long a device's shells outlive its last socket.
///
/// The number exists because the two failure modes are both real and point opposite ways. Killing on
/// disconnect would mean a phone locking its screen — which happens every thirty seconds, unasked —
/// killing the build somebody opened the terminal to watch. Never killing means a revoked, evicted or
/// out-of-range device leaves processes running that nothing on either side can still reach: the
/// desktop has no tab for them and the phone has no token.
///
/// Three quarters of a minute is longer than every ordinary gap (a lock screen, a wifi handover, a
/// backgrounded tab all reconnect inside the client's 8 s backoff ceiling) and short enough that a
/// phone genuinely gone does not leave a shell running for the rest of the day.
const TERMINAL_GRACE: std::time::Duration = std::time::Duration::from_secs(45);

/// Schedules the reap, and re-checks three things before doing it.
///
/// The re-check is the whole mechanism: a reconnect inside the window puts the device back in
/// [`RemoteCtl::connected`], and this then does nothing at all. Without it the timer would be a
/// delayed version of the same bug — the shell dies, just less predictably. But "is it connected
/// now" alone is not enough, and the two gaps it leaves both end with somebody's build killed:
///
/// * **`stamp`** — timers overlap. A phone that dropped, reconnected and dropped again has two of
///   these in flight, and the older one would fire one second into the newer gap. The stamp names
///   the disconnection this timer was armed for; anything else means it is stale.
/// * **`generation`** — a port change is not a device leaving. `server::start` calls
///   [`RemoteCtl::stop`] before rebinding, which cancels every socket, so editing the port field
///   disconnects every phone at once — and the phone cannot come back, because its URL still names
///   the old port. Reaping then would kill every remote shell for a settings edit, which is exactly
///   the "an unrelated action killed my build" shape [`shutdown`] documents itself as avoiding; the
///   drop guard was defeating that invariant through a second door. Checked at fire time rather than
///   at drop time because the rebind races the teardown: `stop` cancels before `set_running` bumps,
///   so at drop the generation has not moved yet. Forty-five seconds later it has.
fn reap_terminals_later(app: &AppHandle, device_id: &str, stamp: u64, generation: u64) {
    let app = app.clone();
    let device_id = device_id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(TERMINAL_GRACE).await;
        let state = app.state::<RemoteCtl>();
        if state.is_connected(&device_id) {
            return;
        }
        if !state.reap_still_current(&device_id, stamp) {
            return;
        }
        if state.generation() != generation {
            return;
        }
        crate::terminal::close_owned(&app.state::<crate::terminal::TerminalRegistry>(), &device_id);
    });
}

/// Stops the server *and* reaps what the phones left running.
///
/// Separate from [`RemoteCtl::stop`], which it calls, because `stop` is also how a **port change**
/// releases the old listener (`server::start` calls it before rebinding) — and moving the door is not
/// the same as locking it. Reaping inside `stop` would kill every remote shell every time somebody
/// edited the port field, which is precisely the "an unrelated action killed my build" shape this
/// batch exists to remove. Turning the feature off is the act that means "no phone drives this
/// machine any more", so it is the act that reaps.
pub fn shutdown(app: &AppHandle) {
    app.state::<RemoteCtl>().stop();
    crate::terminal::close_all_owned(&app.state::<crate::terminal::TerminalRegistry>());
}

/// The stored configuration, with the defaults applied.
#[derive(Debug, Clone, Copy)]
pub struct Config {
    pub enabled: bool,
    pub port: u16,
    /// See [`SETTING_ALLOW_TERMINAL`]. Independent of `enabled`: turning the server off leaves this
    /// as the user set it, so turning it back on does not silently re-grant shells they revoked.
    pub allow_terminal: bool,
}

/// Whether a paired device may open a shell right now.
///
/// Read per call rather than cached, and that is the point: revoking terminal access has to take
/// effect on the very next request, with no restart and nothing to invalidate. It is one indexed
/// lookup on a connection the command was about to take anyway.
pub fn terminal_allowed(db: &Db) -> bool {
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => e.into_inner(),
    };
    queries::get_setting(&conn, SETTING_ALLOW_TERMINAL)
        .ok()
        .flatten()
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false)
}

/// Reads the configuration out of `app_settings`.
///
/// A malformed or out-of-range port falls back to the default rather than refusing to start: the
/// value can only get there by hand-editing the database, and a server on the wrong port is a far
/// better failure than a feature that silently never comes up.
pub fn read_config(db: &Db) -> Config {
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => e.into_inner(),
    };
    let enabled = queries::get_setting(&conn, SETTING_ENABLED)
        .ok()
        .flatten()
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let port = queries::get_setting(&conn, SETTING_PORT)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|p| *p >= 1024)
        .unwrap_or(DEFAULT_PORT);
    let allow_terminal = queries::get_setting(&conn, SETTING_ALLOW_TERMINAL)
        .ok()
        .flatten()
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    Config { enabled, port, allow_terminal }
}

/// Brings the server up if the stored configuration says it should be, at launch.
///
/// Deliberately silent on failure. A port already taken by something else is a real possibility on
/// somebody's machine, and it must not stop the app from starting — the settings screen will show
/// the server as off, which is the truth, and the user can pick another port.
pub fn autostart(app: &AppHandle) {
    use tauri::Manager;
    let config = read_config(&app.state::<Db>());
    if !config.enabled {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server::start(&app, config.port).await {
            eprintln!("[remotectl] no se pudo iniciar en el puerto {}: {e}", config.port);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;

    fn db() -> Db {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        Db(Mutex::new(conn))
    }

    /// The default that matters most in this whole module.
    ///
    /// A fresh install, and an install upgrading from a version before this setting existed, must
    /// both answer "no shell". Anything else would mean turning the server on silently granting
    /// arbitrary code execution — the exact thing the separate switch exists to prevent.
    #[test]
    fn terminals_are_denied_until_explicitly_granted() {
        let db = db();
        assert!(!terminal_allowed(&db), "an unset setting must deny");

        {
            let conn = db.0.lock().unwrap();
            queries::set_setting(&conn, SETTING_ALLOW_TERMINAL, "1").unwrap();
        }
        assert!(terminal_allowed(&db));

        {
            let conn = db.0.lock().unwrap();
            queries::set_setting(&conn, SETTING_ALLOW_TERMINAL, "0").unwrap();
        }
        assert!(!terminal_allowed(&db), "withdrawing must take effect on the next read");
    }

    /// Turning the server off must not silently re-grant, or silently withdraw, shell access — the
    /// two switches are independent and a user who set one should find it as they left it.
    #[test]
    fn the_two_switches_are_independent() {
        let db = db();
        {
            let conn = db.0.lock().unwrap();
            queries::set_setting(&conn, SETTING_ALLOW_TERMINAL, "1").unwrap();
            queries::set_setting(&conn, SETTING_ENABLED, "0").unwrap();
        }
        let config = read_config(&db);
        assert!(!config.enabled);
        assert!(config.allow_terminal, "the shell grant survives the server being off");
    }

    /// The reason [`RemoteCtl::connected`] counts sockets instead of holding a flag.
    ///
    /// A phone reconnecting overlaps: it opens the new socket and only then does the old one's
    /// close reach this process, so with a boolean the teardown of the *dead* connection would
    /// clear the flag the live one had just set — and the panel would show a device as offline
    /// while it was actively driving the machine.
    #[test]
    fn an_overlapping_reconnect_does_not_report_the_device_as_gone() {
        let state = RemoteCtl::default();
        assert!(!state.is_connected("phone"));

        state.attach("phone");
        // The new socket, opened before the old one's close has reached this process.
        state.attach("phone");

        state.detach("phone");
        assert!(state.is_connected("phone"), "the socket that replaced it is still open");
        state.detach("phone");
        assert!(!state.is_connected("phone"));
        // And a device that comes and goes all day must not leave a row behind each time.
        assert!(state.connected.lock().unwrap().is_empty());
    }

    /// A port that cannot be a real one falls back rather than refusing to start. See `read_config`.
    #[test]
    fn a_nonsense_port_falls_back_to_the_default() {
        let db = db();
        {
            let conn = db.0.lock().unwrap();
            queries::set_setting(&conn, SETTING_PORT, "not-a-port").unwrap();
        }
        assert_eq!(read_config(&db).port, DEFAULT_PORT);

        {
            let conn = db.0.lock().unwrap();
            // Privileged ports would need elevation this app never has.
            queries::set_setting(&conn, SETTING_PORT, "80").unwrap();
        }
        assert_eq!(read_config(&db).port, DEFAULT_PORT);
    }
}
