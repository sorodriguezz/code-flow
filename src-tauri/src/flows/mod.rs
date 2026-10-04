//! Flujos ("Flows") — node-based automations, the rail app that brings n8n's model into CodeFlow.
//!
//! A flow is a graph saved as **one JSON document per row** ([`spec`]), the way an API request is
//! one `spec` blob: a new node type or a new parameter never needs a table migration. The node
//! catalogue ([`catalog`]) is the one list both the canvas and the validator read, so a node the
//! palette offers is always a node a saved flow may contain.
//!
//! Everything that runs lives here, in Rust — the engine ([`engine`], [`nodes`]), the runs and their
//! storage ([`runs`]), the triggers and the scheduler ([`triggers`], [`schedule`]) and the AI calls
//! ([`ai_host`]) — for the reason Services moved its executor out of the webview: a run must not
//! depend on a window being open, visible, or the one that started it.

pub mod ai_host;
pub mod catalog;
pub mod engine;
pub mod expr;
pub mod nodes;
pub mod params;
pub mod run;
pub mod runs;
pub mod schedule;
pub mod schema;
pub mod services;
pub mod spec;
pub mod triggers;
pub mod value;
