//! The Reviewer ("Revisor"): a project's quality pipeline — build, tests with coverage, a SonarQube
//! analysis and its Quality Gate — run on this machine, the way a company's CI runs it, whenever the
//! user asks.
//!
//! Opt-in twice over. The tab beside Editor exists only while it is switched on in Settings, and
//! nothing it needs ships with the app: a JDK, SonarQube Community Build and its scanner are
//! downloaded the first time the user asks for them (≈ 1.2 GB), and the local server runs only while
//! it is used.
//!
//! - [`install`] — downloads, verifies and unpacks the three pieces ([`catalog`] pins them).
//! - [`server`] — the local SonarQube's life: started on demand, bound to the loopback, stopped when
//!   idle and when the app quits.
//! - [`rules`] — the rules and the Quality Gate it applies: SonarQube's, CodeFlow's stricter ones, or
//!   a connected company server's, copied in.
//! - [`analysis`] — one review: the stages, the scanner, the results.
//! - [`detect`] / [`reports`] — the commands a repository's pipeline would run, and the coverage and
//!   test reports those commands leave behind.
//!
//! Nothing here touches the repository it reviews: the scanner's working directory, its cache and
//! every report the suggested commands write live in the app's own folder (`paths::reviewer_dir`).

pub mod analysis;
pub mod api;
pub mod catalog;
pub mod config;
pub mod detect;
pub mod download;
pub mod install;
pub mod reports;
pub mod rules;
pub mod server;

use config::{RemoteServer, ReviewerConfig};

/// The two settings rows a start or a review needs, read once by the command that asks.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    pub config: ReviewerConfig,
    pub servers: Vec<RemoteServer>,
}

impl Settings {
    pub fn load(conn: &rusqlite::Connection) -> Self {
        Settings { config: config::load(conn), servers: config::servers(conn) }
    }
}

/// A connected server's token, from the keychain.
pub fn remote_token(server_id: &str) -> Option<String> {
    #[cfg(test)]
    {
        let _ = server_id;
        None
    }
    #[cfg(not(test))]
    {
        crate::secrets::get_secret(&crate::secrets::sonar_server_token_key(server_id)).ok().flatten()
    }
}

/// For the app's exit: the review in flight and the local server, which would otherwise outlive it.
pub fn shutdown(budget: std::time::Duration) {
    analysis::cancel_all();
    server::shutdown_blocking(budget);
}
