//! Services: named commands that come up in dependency order, and everything it takes to run them
//! honestly — the supervisor, the ports they open, Compose's containers, and a first guess at what
//! a folder can run. The definitions themselves live in `db/service_queries.rs`; the commands the
//! frontend calls, in `commands/services_cmd.rs`.

pub mod compose;
pub mod detect;
pub mod log;
pub mod ports;
pub mod supervisor;

pub use supervisor::Supervisor;
