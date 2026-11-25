//! What the runner needs from wherever it runs.
//!
//! The runner used to reach for the app directly: its database, its windows and, through
//! `send_chat_message`, the engine. That made its whole path — claim, wait for a slot, run the
//! turn, settle, move the run on — impossible to exercise without a window and a real CLI. A
//! [`Host`] is those few things by name. The app is one ([`AppHost`]); a test brings its own, with
//! a scripted engine, and drives a run from its first claim to its delivery.

use std::future::Future;

use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use super::governor::Slots;
use crate::db::Db;

/// One turn handed to the engine.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Read by whichever engine needs it: the app's takes the ids, a scripted one the folder and the token.
pub struct Turn {
    /// Its id in `ai_runs`: what a Stop is addressed to.
    pub turn_id: String,
    pub team_run_id: String,
    pub item_id: String,
    pub project_id: String,
    pub conversation_id: String,
    /// The engine's own session of the conversation's last turn, to pick it up.
    pub session: Option<String>,
    pub message: String,
    pub prompt: String,
    pub provider: String,
    pub model: String,
    pub account_id: Option<String>,
    pub effort: Option<String>,
    /// Where the member works: the item's worktree.
    pub cwd: String,
    /// Fires when the run is stopped. The app's engine hears a Stop through `ai_runs`; an engine
    /// without it listens here.
    pub cancel: CancellationToken,
}

#[derive(Debug, Clone, Default)]
pub struct TurnReply {
    pub text: String,
    /// The model that answered, when the engine said.
    pub model: Option<String>,
}

pub trait Host: Clone + Send + Sync + 'static {
    fn db(&self) -> &Db;

    /// The slots turns queue for. One per app; a test brings its own so it never waits behind
    /// another test's turns.
    fn slots(&self) -> &Slots;

    /// Tells every window.
    fn emit(&self, event: &str, payload: serde_json::Value);

    /// Tells the main window alone — it owns the terminal bench.
    fn emit_to_main(&self, event: &str, payload: serde_json::Value);

    /// Keeps `turn_id` stoppable from now until what comes back is dropped, engine started or not.
    fn reserve(&self, turn_id: &str) -> Option<Box<dyn std::any::Any + Send>>;

    /// Stops the turn if it runs.
    fn stop(&self, turn_id: &str);

    /// Runs the turn to its end. An error that carries [`crate::ai_runs::CANCELLED_MARKER`] is a
    /// turn someone stopped; one with [`crate::ai_locks::BUSY_MARKER`] found the conversation or
    /// the repository taken.
    fn turn(&self, turn: Turn) -> impl Future<Output = Result<TurnReply, String>> + Send;
}

/// The app itself.
#[derive(Clone)]
pub struct AppHost(pub AppHandle);

impl Host for AppHost {
    fn db(&self) -> &Db {
        self.0.state::<Db>().inner()
    }

    fn slots(&self) -> &Slots {
        super::governor::app_slots()
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }

    fn emit_to_main(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit_to("main", event, payload);
    }

    fn reserve(&self, turn_id: &str) -> Option<Box<dyn std::any::Any + Send>> {
        crate::ai_runs::reserve(&self.0, Some(turn_id)).map(|held| Box::new(held) as Box<dyn std::any::Any + Send>)
    }

    fn stop(&self, turn_id: &str) {
        crate::ai_runs::cancel(turn_id);
    }

    async fn turn(&self, turn: Turn) -> Result<TurnReply, String> {
        let reply = crate::commands::claude_cmd::send_chat_message(
            self.0.clone(),
            self.0.state::<Db>(),
            turn.project_id,
            turn.message,
            turn.session,
            Some(turn.conversation_id),
            Some(turn.turn_id),
            Some(turn.provider),
            Some(turn.model),
            Some(turn.prompt),
            turn.account_id,
            None,
            None,
            None,
            turn.effort,
            Some(false),
            None,
            None,
        )
        .await?;
        Ok(TurnReply { model: reply.model.clone(), text: reply.text })
    }
}
