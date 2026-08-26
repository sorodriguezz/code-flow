//! The two directions state travels between the desktop window and a paired phone.
//!
//! # Desktop → phone
//!
//! [`attach`] subscribes, in Rust, to the same global events the webview subscribes to in
//! JavaScript, and republishes each one onto the broadcast channel every WebSocket client reads
//! from. The phone therefore sees a live agent run through exactly the emits that already existed —
//! no feature had to learn that a phone might be watching.
//!
//! The forwarded list is deliberately short. Every event here costs a JSON frame per connected
//! device, and a phone has no use for most of what the app emits: a debugger's stack frames, a
//! database stream, a file-transfer progress bar and a PTY's output all belong to screens the
//! mobile client does not have. `terminal:output` in particular is excluded on volume grounds
//! alone — a `yarn build` scrolling past is thousands of frames nobody is reading.
//!
//! Republishing is not enough on its own, though. A change the *window* makes to the database emits
//! nothing anybody was already listening for — approving a gate is one SQL statement — so
//! [`emit_desktop_change`] is the other half, called from the stores that make those changes. Until
//! it existed this heading was only two thirds true.
//!
//! # Phone → desktop
//!
//! [`emit_invalidation`] is the third sync channel described in the module docs — the one that had
//! to be built, because the other two already existed. See there for why.
//!
//! Both directions ride the same event and the same `origin` field, and each client drops the frames
//! whose origin is itself. That symmetry is the point: there is one channel here, not two.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};

use super::dispatch::{Announce, Invalidate};
use super::{Fanout, RemoteCtl};
use crate::db::Db;

/// The event name both clients listen on to learn that somebody else changed something.
pub const INVALIDATE_EVENT: &str = "state:invalidate";

/// The `origin` a change made **at the desk** carries.
///
/// Not a device id, because the desktop is not a device — it is the process every device is talking
/// to. A literal rather than an absent field so the filter reads the same on both sides: each client
/// skips the frames whose origin is *itself* and acts on everything else, which is one rule instead
/// of one rule and an exception.
pub const DESKTOP_ORIGIN: &str = "desktop";

/// The events every connected phone is given unconditionally.
///
/// Two more reach a phone under conditions of their own — [`TERMINAL_EVENTS`] behind the shell
/// switch and [`FS_EVENT`] behind which repository the device asked about — and nothing else does.
///
/// `ai:output-batch` and not `ai:output`: they carry the identical lines, and the batch is already
/// coalesced to ~100 ms upstream (see `events.ts`). Forwarding both would send every line twice,
/// and the per-line one is the shape that made the desktop slow enough to need the batch in the
/// first place — over a phone's wifi it would be worse.
///
/// `state:invalidate` is in the list because it now has two emitters: `server::rpc` for what a phone
/// did, and [`emit_desktop_change`] for what this window did. A device does not hear its own action
/// echoed as a reload, because the client filters on the `origin` this module stamps.
const FORWARDED: &[&str] = &[
    "git:progress",
    "git:done",
    "ai:output-batch",
    "ai:engine",
    // The mirror of the desktop's own problem, on the phone. A mobile client registers a run from
    // `ai:engine` and appends its output from `ai:output-batch`; without this it has nothing that
    // says the run ended, so the spinner in its Runs tab would turn forever. Its `fetch` for the
    // *command* does resolve — but only for the one command it issued, and a phone watching a run
    // somebody started at the desk issued none.
    "ai:done",
    INVALIDATE_EVENT,
];

/// Events forwarded **only to the device whose shell they came from**.
///
/// This list is a leak to guard, not a feature to enable, and the distinction is easy to miss: these
/// events carry the bytes of one pty, and the switch alone is not enough to route them. Gated on the
/// switch and fanned out to everybody — which is what this did — a phone allowed to open *a* shell
/// received *every* shell on the machine: the one somebody at the desk is typing into, and every
/// live `ssh -t` in the Remote workspace, whose whole point is that it is out of the control
/// surface's scope.
///
/// So each frame is addressed by looking the session's owner up in the registry (see
/// `terminal::Origin::owner`). A session with no owner was opened at the desk and is forwarded to
/// nobody at all. The switch is still re-read per event on top of that, because withdrawing terminal
/// access has to stop the stream on the next line printed rather than on the next restart.
const TERMINAL_EVENTS: &[&str] = &["terminal:output", "terminal:exit"];

/// Filesystem churn, forwarded only for repositories a **device** asked to be told about.
///
/// Not in [`FORWARDED`] because it is the one event whose audience depends on which repository it
/// names. A machine with several projects open at the desk emits this for all of them, and the
/// phone is looking at one — so an unconditional forward is a frame per burst, per device, for
/// working copies nobody on the other end has on screen. `watcher::watched_by_a_device` answers the
/// question directly, because a phone's `watch_project` call is what put the claim there.
///
/// Fails closed on an unreadable payload rather than open: an event that does not name a repository
/// is one nothing here can route, and forwarding it to everybody would be guessing.
const FS_EVENT: &str = "repo:fs-changed";

/// Wires the Rust-side listeners that feed the WebSocket fan-out.
///
/// Called once from `lib.rs` setup, *not* per server start: the listeners are cheap when nothing is
/// connected (a broadcast send with no receivers is a length check and a drop), and registering
/// them once means toggling the server on and off cannot leak a subscription or miss one.
///
/// # The one assumption
///
/// This depends on `Emitter::emit` reaching Rust listeners registered via `listen_any`, not only
/// the webviews — which is what Tauri v2's "any target" delivery means. It is the first thing to
/// check if a phone connects, authenticates, and then sees nothing: if the events never arrive but
/// RPC calls work, this is why, and the fix is to tee at the emit sites rather than here.
pub fn attach(app: &AppHandle) {
    for name in FORWARDED {
        let app_for_handler = app.clone();
        let name = *name;
        app.listen_any(name, move |event| {
            let state = app_for_handler.state::<RemoteCtl>();
            // No receivers is the normal case — nobody has a phone open. `send` answering `Err`
            // for that is not a failure, so it is dropped rather than logged.
            let _ = state.events.send(everyone(frame(name, event.payload())));
        });
    }

    {
        let app_for_handler = app.clone();
        app.listen_any(FS_EVENT, move |event| {
            let Some(repo_path) = repo_path_of(event.payload()) else {
                return;
            };
            if !crate::watcher::watched_by_a_device(
                &app_for_handler.state::<crate::watcher::WatcherRegistry>(),
                &repo_path,
            ) {
                return;
            }
            let state = app_for_handler.state::<RemoteCtl>();
            let _ = state.events.send(everyone(frame(FS_EVENT, event.payload())));
        });
    }

    for name in TERMINAL_EVENTS {
        let app_for_handler = app.clone();
        let name = *name;
        app.listen_any(name, move |event| {
            let state = app_for_handler.state::<RemoteCtl>();
            // Nobody is connected, so there is nothing to authorise and nowhere to send.
            //
            // This guard is first because everything after it is expensive on a path that is *not*:
            // this handler runs once per terminal frame — up to 60 a second, per terminal — and the
            // permission check below takes the database mutex and runs a SELECT. A desk with no
            // phone paired was paying for a SQLite read on every frame of every build log, and
            // contending the same mutex every other command needs. A `broadcast::Sender` with no
            // receivers is nearly free (see `RemoteCtl::events`), so asking it first costs an
            // atomic load and answers the common case.
            if state.events.receiver_count() == 0 {
                return;
            }
            // The check that keeps terminal output off an unauthorised phone. Deliberately inside
            // the handler and not around the registration — see `TERMINAL_EVENTS`. Read live rather
            // than cached: revoking a phone's terminal access has to take effect on the next frame,
            // not on the next cache expiry.
            if !crate::remotectl::terminal_allowed(&app_for_handler.state::<Db>()) {
                return;
            }
            // Whose shell this is, read off the frame itself. A missing or null owner is a shell
            // opened at the desk — or a payload this code cannot parse — and both fail closed:
            // nobody on a phone is entitled to bytes that do not name them.
            let Some(owner) = terminal_owner_of(event.payload()) else {
                return;
            };
            let _ = state
                .events
                .send(addressed(frame(name, event.payload()), owner));
        });
    }
}

/// A frame everybody connected should see.
fn everyone(text: String) -> Fanout {
    Fanout { text, only: None }
}

/// A frame only `device_id` may see. See [`Fanout`].
fn addressed(text: String, device_id: String) -> Fanout {
    Fanout { text, only: Some(device_id) }
}

/// The device a `terminal:output` / `terminal:exit` payload belongs to.
///
/// The routing key, stamped at the pty by `terminal::open_pty` rather than looked up here — see
/// `TerminalOutputEvent` for why a lookup could not answer for the exit frame at all. Parsed rather
/// than pattern-matched for the same reason [`repo_path_of`] is: the payload is JSON and reading it
/// as text would be guessing.
fn terminal_owner_of(payload: &str) -> Option<String> {
    serde_json::from_str::<Value>(payload)
        .ok()?
        .get("owner")?
        .as_str()
        .map(str::to_string)
}

/// One WebSocket frame.
///
/// The payload is spliced in as raw text rather than parsed and re-serialized: it arrives from
/// Tauri already serialized, and a run emitting batches several times a second does not need a
/// round trip through `serde_json::Value` to say the same thing. The event name is one of the
/// literals in [`FORWARDED`], so there is nothing here that could need escaping.
///
/// An empty payload (an event emitted with `()`) is normalized to `null`, because `"payload":`
/// followed by nothing is not JSON.
/// The repository a [`FS_EVENT`] payload names. Parsed rather than pattern-matched because the
/// path is user data and can contain anything a filesystem allows, quotes included.
fn repo_path_of(payload: &str) -> Option<String> {
    serde_json::from_str::<Value>(payload)
        .ok()?
        .get("repo_path")?
        .as_str()
        .map(str::to_string)
}

fn frame(event: &str, payload: &str) -> String {
    let payload = if payload.trim().is_empty() { "null" } else { payload };
    format!(r#"{{"event":"{event}","payload":{payload}}}"#)
}

/// Which rows a call named, for the listeners that have to find them again.
///
/// Grouped into a struct rather than threaded through as five more `Option<&str>` parameters, which
/// is a shape where transposing two arguments compiles and is then wrong at runtime in a way only a
/// phone in another room can see. Every field is "the caller said so" — nothing here is inferred,
/// and `None` means the call did not name one.
#[derive(Default, Clone, Copy)]
pub struct Subject<'a> {
    /// Which project the call was about, when it named one.
    ///
    /// The job history and the chat transcript are both stored *per project*, so a domain alone is
    /// not enough to reload them — "reviews are stale" without saying whose leaves the desktop able
    /// to know something happened and unable to go and read it. That was the gap that made a pull
    /// request reviewed from a phone produce a notification and nothing else.
    pub project: Option<&'a str>,
    /// The job id a review or an analysis filed its output under, so the notification the desktop
    /// raises can *open* the result rather than merely mention it.
    pub job: Option<&'a str>,
    /// Which conversation a chat turn was filed under.
    ///
    /// A project holds dozens, and the desktop keeps whichever ones it has opened in memory. Without
    /// this it can know a turn happened somewhere and not whether it is the transcript on screen —
    /// so it reloaded the Activity list and left the open conversation missing the turn.
    pub conversation: Option<&'a str>,
    /// Which chain moved, and the workspace it belongs to.
    ///
    /// Both halves are needed and neither is enough alone. The desktop is the thing that actually
    /// advances a chain (the executor is `chainStore.ts`), and it holds one workspace at a time: the
    /// id says *what* to advance, and the workspace says whether reloading the list it already has
    /// would even find it. A gate approved from a phone on another workspace used to reload a list
    /// the chain is not in and then look for queued chains in it, so nothing ran.
    pub chain: Option<&'a str>,
    pub workspace: Option<&'a str>,
}

/// Tells everyone that a phone's action made their copy of `domain` stale.
///
/// Emitted globally, so it lands in three places at once: the desktop webview (which refreshes the
/// matching store), any *other* connected device, and — harmlessly — the device that caused it,
/// which filters it out by `origin`.
///
/// `origin` is the device id, and it is the only reason this is not simply the dispatcher calling
/// `app.emit` itself: without it, a phone that stages a file would be told to reload the repository
/// it just drew, one round trip after drawing it.
pub fn emit_invalidation(
    app: &AppHandle,
    inv: Invalidate,
    announce: Announce,
    origin: &str,
    device_name: &str,
    subject: Subject<'_>,
    failed: bool,
) {
    // An action can be worth announcing without invalidating anything — opening a terminal changes
    // no store — so the payload is built from whichever half exists rather than from the
    // invalidation alone. Bailing out early on `Invalidate::None`, as this used to, is what made a
    // phone's terminal session invisible on the desktop.
    let mut payload = inv.as_payload().unwrap_or_else(|| json!({}));
    if let Value::Object(map) = &mut payload {
        map.insert("origin".into(), Value::String(origin.to_string()));
        map.insert("device".into(), Value::String(device_name.to_string()));
        if let Some(key) = announce.0 {
            map.insert("action".into(), Value::String(key.to_string()));
        }
        // See [`Subject`] for what each of these is for. Absent fields are simply left out rather
        // than written as `null`: every listener treats a missing key as "not said", and a `null`
        // that means the same thing is one more shape for them to handle.
        for (key, value) in [
            ("project", subject.project),
            ("job", subject.job),
            ("conversation", subject.conversation),
            ("chain", subject.chain),
            ("workspace", subject.workspace),
        ] {
            if let Some(id) = value {
                map.insert(key.into(), Value::String(id.to_string()));
            }
        }
        // Only ever present when something went wrong, so a listener that has never heard of this
        // field keeps behaving exactly as it did.
        //
        // A failed review or analysis is still worth both halves of this event: it writes a durable
        // `job_history` row with the engine's error in it, and the desktop's copy of that history
        // is as stale after a failure as after a success. Announcing it as an ordinary success —
        // which is what a missing status meant — put "PR revisado" in the notification centre for a
        // run that produced an error row.
        if failed {
            map.insert("status".into(), Value::String("error".into()));
        }
    }
    // Nothing to say and nothing to reload: a read, or a keystroke. Emitting would wake every
    // listener to hand them an empty object.
    if inv == Invalidate::None && announce.0.is_none() {
        return;
    }
    let _ = app.emit(INVALIDATE_EVENT, payload);
}

/// The mirror of [`emit_invalidation`]: something changed **at the desk**, tell the phones.
///
/// # Why this direction had to be built too
///
/// The module docs describe three channels carrying state to a phone, and two of them are free: a
/// commit moves bytes and `repo:fs-changed` fires, a run prints and `ai:output-batch` fires. The
/// third — a row in SQLite and nothing else — was built for the phone→desktop direction and left
/// with exactly one emitter, on the phone's own RPC path. So a gate approved *at the desk* moved no
/// files, printed no output and emitted no invalidation, and every phone watching that chain went
/// on showing a gate that had been answered ten minutes earlier. "Si hago algo en la app debería
/// verlo en el celu" was, mechanically, not implemented.
///
/// # Why the caller is the webview and not the command it just ran
///
/// Emitting from inside `approve_chain_gate` and friends would be one source for both clients,
/// which is the tidier shape — and it would double up. A phone reaches those same functions through
/// `dispatch.rs`, so every remote call would produce two frames: the command's, stamped
/// [`DESKTOP_ORIGIN`], and the server's, stamped with the device id. The phone filters only its own,
/// so it would refetch on its own taps — the exact cost the origin field exists to avoid. Beyond
/// that, the chain executor is not a command at all: it lives in `chainStore.ts` and settles its
/// steps from the webview, so a Rust-only emitter could not see the moves that matter most.
///
/// No `action` and no `device`: the person who caused this is sitting in front of the window, and
/// telling them what they just did is not a notification, it is an echo.
pub fn emit_desktop_change(
    app: &AppHandle,
    inv: Invalidate,
    project_id: Option<&str>,
    conversation_id: Option<&str>,
) {
    if let Some(payload) = desktop_payload(inv, project_id, conversation_id) {
        let _ = app.emit(INVALIDATE_EVENT, payload);
    }
}

/// The frame [`emit_desktop_change`] sends, or `None` when there is nothing to say.
///
/// Split out from the emit so it can be asserted on: an `AppHandle` cannot be built outside a
/// running Tauri app, and the shape of this payload is the entire contract the echo filter on both
/// clients is written against.
fn desktop_payload(
    inv: Invalidate,
    project_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Option<Value> {
    // `Invalidate::None` has no domain, and a frame that names nothing to reload is one every
    // listener wakes up for and does nothing with.
    let mut payload = inv.as_payload()?;
    if let Value::Object(map) = &mut payload {
        map.insert("origin".into(), Value::String(DESKTOP_ORIGIN.to_string()));
        if let Some(id) = project_id {
            map.insert("project".into(), Value::String(id.to_string()));
        }
        // Which conversation a chat turn belongs to. A project can hold dozens, and "chat is stale"
        // without saying whose leaves a client able to know something happened and unable to tell
        // whether it is the transcript on screen.
        if let Some(id) = conversation_id {
            map.insert("conversation".into(), Value::String(id.to_string()));
        }
    }
    Some(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_carries_the_payload_verbatim() {
        let f = frame("ai:engine", r#"{"run_id":"r1","engine":"Claude"}"#);
        assert_eq!(
            f,
            r#"{"event":"ai:engine","payload":{"run_id":"r1","engine":"Claude"}}"#
        );
        // And it has to actually parse, which is the point of splicing rather than concatenating
        // something hand-built.
        let parsed: Value = serde_json::from_str(&f).unwrap();
        assert_eq!(parsed["event"], "ai:engine");
        assert_eq!(parsed["payload"]["engine"], "Claude");
    }

    /// `app:foreground` and friends are emitted with `()`, which Tauri hands over as an empty
    /// string. Splicing that straight in would produce `{"payload":}`.
    #[test]
    fn an_empty_payload_becomes_null() {
        let f = frame("git:done", "");
        let parsed: Value = serde_json::from_str(&f).unwrap();
        assert!(parsed["payload"].is_null());
    }

    #[test]
    fn a_read_only_call_produces_no_invalidation_payload() {
        assert!(Invalidate::None.as_payload().is_none());
    }

    #[test]
    fn an_invalidation_names_its_domain() {
        let payload = Invalidate::Chains.as_payload().unwrap();
        assert_eq!(payload["domain"], "chains");
    }

    /// The whole of the echo filter, on the side that produces it.
    ///
    /// Both clients decide whether to act by comparing `origin` against their own identity, so a
    /// desktop change that arrived without one — or with a device id — would be acted on by the
    /// window that made it, reloading each store on top of its own in-flight write.
    #[test]
    fn a_desktop_change_is_stamped_so_the_window_can_skip_its_own_echo() {
        let payload = desktop_payload(Invalidate::Chat, Some("proj-1"), Some("conv-9")).unwrap();
        assert_eq!(payload["origin"], DESKTOP_ORIGIN);
        assert_eq!(payload["domain"], "chat");
        assert_eq!(payload["project"], "proj-1");
        assert_eq!(payload["conversation"], "conv-9");
        // The person who caused this is at the keyboard. Announcing it back to them would be an
        // echo, not a notification.
        assert!(payload.get("action").is_none());
        assert!(payload.get("device").is_none());
    }

    /// A frame that names nothing to reload is one every listener wakes for and does nothing with.
    #[test]
    fn a_desktop_change_with_no_domain_is_not_emitted() {
        assert!(desktop_payload(Invalidate::None, None, None).is_none());
    }

    /// The routing key for [`TERMINAL_EVENTS`], and the three answers that must all mean "forward
    /// this to nobody".
    ///
    /// This is the guard that stopped every paired phone receiving every pty on the machine, so its
    /// fail-closed cases are worth pinning: a shell opened at the desk serializes `"owner":null`, an
    /// older payload has no such field, and an unparseable one is not routable at all.
    #[test]
    fn terminal_output_names_the_only_device_entitled_to_it() {
        assert_eq!(
            terminal_owner_of(r#"{"id":"s1","data":"$ ","owner":"dev-7"}"#).as_deref(),
            Some("dev-7")
        );
        assert_eq!(terminal_owner_of(r#"{"id":"s1","data":"$ ","owner":null}"#), None);
        assert_eq!(terminal_owner_of(r#"{"id":"s1","data":"$ "}"#), None);
        assert_eq!(terminal_owner_of(""), None);
    }

    /// An addressed frame carries its address and an ordinary one does not — the distinction
    /// `server::pump` filters on, and the reason the fan-out is not a bare `String` any more.
    #[test]
    fn only_an_addressed_frame_names_a_device() {
        assert_eq!(everyone("{}".into()).only, None);
        assert_eq!(addressed("{}".into(), "dev-7".into()).only.as_deref(), Some("dev-7"));
    }

    /// The routing key for [`FS_EVENT`], read off the payload `watcher.rs` serializes.
    #[test]
    fn a_filesystem_event_names_the_repository_it_is_about() {
        assert_eq!(
            repo_path_of(r#"{"repo_path":"/home/dev/repo"}"#).as_deref(),
            Some("/home/dev/repo")
        );
        // Nothing to route by, so nothing is forwarded — see `FS_EVENT`.
        assert_eq!(repo_path_of("null"), None);
        assert_eq!(repo_path_of(""), None);
    }

    /// **The assumption the whole event channel rests on.**
    ///
    /// [`attach`] republishes app events onto the WebSocket fan-out by listening for them *in
    /// Rust*, with `listen_any`. That only works if `Emitter::emit` delivers to Rust listeners and
    /// not merely to the webviews — a property of Tauri's "any target" delivery that this feature
    /// takes entirely on faith everywhere else.
    ///
    /// It is worth a real app because the failure is silent and points the wrong way: pairing
    /// would work, RPC calls would work, and a phone would sit on a connected socket that never
    /// receives a frame — which reads as a networking bug, not as a delivery-semantics one. If
    /// this test ever fails after a Tauri upgrade, the fix is to tee at the emit sites rather than
    /// to debug the socket.
    #[test]
    fn emit_reaches_a_rust_listener_and_not_only_the_webviews() {
        use std::sync::mpsc;
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let (tx, rx) = mpsc::channel::<String>();

        app.handle().listen_any("ai:engine", move |event| {
            let _ = tx.send(event.payload().to_string());
        });

        app.handle()
            .emit("ai:engine", serde_json::json!({ "run_id": "r1", "engine": "Claude" }))
            .unwrap();

        let payload = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("emit did not reach the Rust listener — see this test's doc comment");
        let parsed: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["engine"], "Claude");
        assert_eq!(parsed["run_id"], "r1");
    }
}
