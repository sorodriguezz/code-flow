//! What the settings screen can do to the remote-control server — and the one thing the rest of the
//! window can.
//!
//! Everything here is desktop-only by construction: none of it appears in `remotectl/dispatch.rs`,
//! so a paired phone cannot open a pairing window, change the port, or revoke the device sitting
//! next to it. Administering the feature is a thing you do at the machine.
//!
//! [`notify_state_change`] is the exception to "settings screen" and not to "desktop-only": it is
//! the outbound half of the sync channel, called from the stores when this window changes something
//! a phone is looking at.

use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{queries, Db};
use crate::remotectl::{self, auth, bridge, dispatch::Invalidate, RemoteCtl};

/// Everything the settings panel draws, in one read.
#[derive(Debug, serde::Serialize)]
pub struct RemoteStatus {
    /// What the stored setting says — which is what will happen at the next launch.
    pub enabled: bool,
    /// Whether a listener is actually bound *right now*. Can disagree with `enabled` when the port
    /// was taken at startup, and the panel says so rather than pretending.
    pub running: bool,
    pub port: u16,
    /// The address to type into a phone, when one could be worked out.
    pub url: Option<String>,
    /// Whether a pairing code is on screen.
    pub pairing: bool,
    /// Whether paired devices may open a shell. Its own switch, independent of `enabled` — see
    /// [`crate::remotectl::SETTING_ALLOW_TERMINAL`].
    pub allow_terminal: bool,
}

/// This machine's address on the network the default route goes out of.
///
/// # Why a UDP socket for something that sends nothing
///
/// The standard library cannot enumerate interfaces, and the answer we want is not "every address
/// this machine has" — a laptop has half a dozen, most of them loopback, VPN or a Docker bridge,
/// and showing the user a list to guess from is worse than showing nothing.
///
/// What we want is the one address a device *on the same network* would reach us at, and that is
/// exactly the source address the OS would pick for outbound traffic. `connect` on a UDP socket
/// asks the routing table that question and puts the answer in `local_addr` — with no packet sent,
/// no name resolved and no reachability implied. The peer is a well-known address chosen only
/// because it is off-link, so the route lookup lands on the real interface; the machine works fine
/// offline, because nothing is ever transmitted.
fn lan_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?.ip();
    if addr.is_loopback() || addr.is_unspecified() {
        return None;
    }
    Some(addr.to_string())
}

#[tauri::command]
pub fn remotectl_status(app: AppHandle, db: State<Db>) -> RemoteStatus {
    let config = remotectl::read_config(&db);
    let state = app.state::<RemoteCtl>();
    let active = state.active_port();
    // The bound port, not the configured one: after changing the port without restarting, the URL
    // has to be the one that currently answers.
    let port = active.unwrap_or(config.port);
    RemoteStatus {
        enabled: config.enabled,
        running: active.is_some(),
        port,
        url: active
            .is_some()
            .then(lan_address)
            .flatten()
            .map(|ip| format!("http://{ip}:{port}")),
        pairing: state.pairing.is_open(),
        allow_terminal: config.allow_terminal,
    }
}

/// Tells every connected phone that this window changed something they hold a copy of.
///
/// The desktop half of `state:invalidate`. See [`bridge::emit_desktop_change`] for why the emit
/// lives behind a command the webview calls rather than inside the commands it is calling — the
/// short version is that the chain executor is in `chainStore.ts`, not in Rust, and that emitting
/// from both places would make every phone refetch on its own taps.
///
/// An unknown domain is refused rather than dropped. This is called from a dozen places in the
/// stores, and a typo that quietly emits nothing is a sync bug that presents as a network problem —
/// the phone simply stays stale, with nothing anywhere saying why.
#[tauri::command]
pub fn notify_state_change(
    app: AppHandle,
    domain: String,
    project_id: Option<String>,
    conversation_id: Option<String>,
) -> Result<(), String> {
    let inv = Invalidate::from_key(&domain).ok_or_else(|| format!("dominio desconocido: {domain}"))?;
    bridge::emit_desktop_change(&app, inv, project_id.as_deref(), conversation_id.as_deref());
    Ok(())
}

/// Grants or withdraws shell access for every paired device at once.
///
/// Not per-device on purpose. A per-device grant would read as finer control and deliver the
/// opposite: the question a person actually asks themselves is "do I want my phone able to run
/// commands on this machine", and answering it once is clearer than answering it per device and
/// then having to remember which of three phones is the dangerous one.
///
/// Takes effect immediately in both directions — the dispatch gate and the event bridge both re-read
/// the setting per call, so nothing has to be restarted and no session has to be torn down.
#[tauri::command]
pub fn remotectl_set_allow_terminal(app: AppHandle, allowed: bool) -> Result<RemoteStatus, String> {
    let db = app.state::<Db>();
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(
            &conn,
            remotectl::SETTING_ALLOW_TERMINAL,
            if allowed { "1" } else { "0" },
        )
        .map_err(|e| e.to_string())?;
    }
    if !allowed {
        // Withdrawing the permission has to reach the shells that were opened under it. It did not:
        // the setting stopped new sessions and the event bridge stopped their output, and the
        // processes went on running with nothing on the desktop drawing them and no client left that
        // could reach them — a `cargo watch` invisible to both ends until the app was quit.
        crate::terminal::close_all_owned(&app.state::<crate::terminal::TerminalRegistry>());
    }
    // **Pushed, not polled.** The phone hides or shows its Shell tab from this flag, and it has no
    // way to discover a change: it learned the value once, in `remote_bootstrap`, and re-probing was
    // the exact mistake that cost this feature its pairing (see `dispatch::remote_bootstrap`). So
    // the grant is announced on the channel every device is already reading — `INVALIDATE_EVENT` is
    // in `bridge::FORWARDED`, so this needs no plumbing of its own.
    //
    // Stamped `DESKTOP_ORIGIN` because that is exactly what it is, and it is what makes this window
    // skip its own echo: the command's return value already carries the new status to the panel that
    // pressed the switch.
    let _ = app.emit(
        bridge::INVALIDATE_EVENT,
        serde_json::json!({
            "domain": "remote",
            "origin": bridge::DESKTOP_ORIGIN,
            "allowTerminal": allowed,
        }),
    );
    Ok(remotectl_status(app.clone(), app.state::<Db>()))
}

/// The shells paired devices have running on this machine right now.
///
/// # Why the desktop needs a list at all
///
/// A phone's terminal is a real pty on this computer, started by somebody who may now be on a train.
/// Nothing in this window drew it: the dock is per-project and per-pane, the bench is the agent
/// console's, and a remote session belongs to neither. So the only trace of a shell opened from a
/// pocket was the CPU it was using.
///
/// Listed here — beside the device that opened it — with a kill button, which is the smallest thing
/// that makes the person at the machine able to answer "what is running on my computer".
///
/// Deliberately **not** adopted into `terminalStore` as dock tabs. That store's tabs assume a mounted
/// `TerminalPane` owns the byte stream and closes the session when the pane goes away, so adopting a
/// remote session without moving ownership at the same time would mean the phone switching tabs
/// killing a shell the person at the desk is typing into — the same bug as the one this batch removes
/// from the phone, rebuilt on the other side.
#[tauri::command]
pub fn remotectl_list_terminals(app: AppHandle) -> Vec<crate::terminal::TerminalInfo> {
    crate::terminal::list_owned(&app.state::<crate::terminal::TerminalRegistry>(), None)
}

/// Turns the server on or off, and records the choice for the next launch.
///
/// The setting is written first and the listener moved second, so a bind that fails leaves a
/// stored `enabled` the user can act on (pick another port, press it again) rather than a toggle
/// that silently reverted.
#[tauri::command]
pub async fn remotectl_set_enabled(app: AppHandle, enabled: bool) -> Result<RemoteStatus, String> {
    let port = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, remotectl::SETTING_ENABLED, if enabled { "1" } else { "0" })
            .map_err(|e| e.to_string())?;
        queries::get_setting(&conn, remotectl::SETTING_PORT)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(remotectl::DEFAULT_PORT)
    };

    if enabled {
        remotectl::server::start(&app, port).await?;
    } else {
        // `shutdown` and not `RemoteCtl::stop`: turning the feature off also reaps the shells the
        // phones left running, which `stop` deliberately does not do because a port change goes
        // through it too. See `remotectl::shutdown`.
        remotectl::shutdown(&app);
        // A server that is off cannot be paired with, and leaving a code alive across the gap
        // would be a credential outstanding for a door that is shut.
        app.state::<RemoteCtl>().pairing.close();
    }
    let db = app.state::<Db>();
    Ok(remotectl_status(app.clone(), db))
}

/// Changes the port, rebinding immediately when the server is already up.
#[tauri::command]
pub async fn remotectl_set_port(app: AppHandle, port: u16) -> Result<RemoteStatus, String> {
    if port < 1024 {
        return Err("elige un puerto por encima de 1024".into());
    }
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::set_setting(&conn, remotectl::SETTING_PORT, &port.to_string())
            .map_err(|e| e.to_string())?;
    }
    if app.state::<RemoteCtl>().active_port().is_some() {
        remotectl::server::start(&app, port).await?;
    }
    let db = app.state::<Db>();
    Ok(remotectl_status(app.clone(), db))
}

/// Opens a pairing window and returns the six digits to put on screen.
#[tauri::command]
pub fn remotectl_start_pairing(app: AppHandle) -> Result<String, String> {
    let state = app.state::<RemoteCtl>();
    if state.active_port().is_none() {
        return Err("enciende el servidor antes de emparejar".into());
    }
    Ok(state.pairing.open())
}

#[tauri::command]
pub fn remotectl_cancel_pairing(app: AppHandle) {
    app.state::<RemoteCtl>().pairing.close();
}

/// The device list, with each row's live-socket state filled in from this process.
///
/// Every command below returns the list, and every one of them has to answer `connected` from the
/// same place — the socket map `pump` maintains, which no query can see. One helper rather than
/// five closures so there is a single definition of what the panel is being told.
fn devices(app: &AppHandle, conn: &rusqlite::Connection) -> Result<Vec<auth::RemoteDevice>, String> {
    let state = app.state::<RemoteCtl>();
    auth::list_devices(conn, &|id| state.is_connected(id))
}

#[tauri::command]
pub fn remotectl_list_devices(app: AppHandle, db: State<Db>) -> Result<Vec<auth::RemoteDevice>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    devices(&app, &conn)
}

/// Cuts one device off, and severs the stream it is holding.
///
/// The second half is why this takes an `AppHandle`. Revoking used to be a database write and
/// nothing else: the next *request* from that phone was refused, but its event socket had
/// authenticated once at upgrade and went on receiving every frame the desktop emitted — a revoked
/// device watching the machine indefinitely, with this panel showing it as cut off. See
/// [`crate::remotectl::Control`].
#[tauri::command]
pub fn remotectl_revoke_device(
    app: AppHandle,
    db: State<Db>,
    id: String,
) -> Result<Vec<auth::RemoteDevice>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    auth::revoke_device(&conn, &id)?;
    // Immediately, with none of the grace a dropped socket gets: a device losing its wifi may well be
    // back in ten seconds, and a device somebody just revoked is never coming back. Leaving its
    // shells alive would leave arbitrary processes running under a credential the user has explicitly
    // withdrawn — the exact thing they pressed the button about.
    crate::terminal::close_owned(&app.state::<crate::terminal::TerminalRegistry>(), &id);
    app.state::<RemoteCtl>().announce(remotectl::Control::Revoked(id));
    devices(&app, &conn)
}

/// The "I lost my phone" button.
#[tauri::command]
pub fn remotectl_revoke_all(app: AppHandle, db: State<Db>) -> Result<Vec<auth::RemoteDevice>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    auth::revoke_all(&conn)?;
    crate::terminal::close_all_owned(&app.state::<crate::terminal::TerminalRegistry>());
    app.state::<RemoteCtl>().announce(remotectl::Control::RevokedAll);
    devices(&app, &conn)
}

/// Removes one already-revoked device from the list for good.
///
/// A second step rather than a shorter default for revocation — see [`auth::forget_device`], whose
/// SQL is what makes this incapable of touching a live device.
#[tauri::command]
pub fn remotectl_forget_device(
    app: AppHandle,
    db: State<Db>,
    id: String,
) -> Result<Vec<auth::RemoteDevice>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    auth::forget_device(&conn, &id)?;
    devices(&app, &conn)
}

/// Clears every revoked row at once.
#[tauri::command]
pub fn remotectl_forget_all_revoked(
    app: AppHandle,
    db: State<Db>,
) -> Result<Vec<auth::RemoteDevice>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    auth::forget_all_revoked(&conn)?;
    devices(&app, &conn)
}
