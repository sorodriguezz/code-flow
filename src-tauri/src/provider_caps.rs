//! What each AI provider can do, in one place.
//!
//! The facts about an engine are scattered by necessity: how to launch it and read its output is the
//! [`AiEngine`](crate::ai::AiEngine) trait's, the picker's labels are the frontend's, and what it
//! takes to *update* its CLI belongs to nobody. Features that need to treat providers differently —
//! the update cards, a fallback model, a reviewer that must not be able to write — each grew their own
//! list of ids, and a new engine had to be remembered in every one of them.
//!
//! This is the single table. The capabilities an engine already declares are **read from the engine**,
//! so they cannot drift from it; what the trait has no room for — the npm package a CLI is published
//! as, and the subcommand it updates itself with — is written here, once, with a test that fails when
//! a provider is added without a row.
//!
//! # The update subcommand, verified
//!
//! Every CLI the app drives has its own self-update command, read from each one's `--help` on
//! 2026-10-27: `claude update`, `codex update`, `grok update`, `cline update` and `opencode upgrade`.
//! That is what makes updating safe: the CLI knows how it was installed (a native installer, npm,
//! Homebrew) and updates itself that way, so the app never has to guess the channel and never leaves a
//! second copy behind. The npm package is only used to learn what the latest version is.
//!
//! `agy` (Gemini's Antigravity) is a native binary with no published package and no update command we
//! could verify, so it has neither: the app can say a CLI is out of date only where it can know.

use serde::Serialize;

use crate::ai::{engine_for, AiEngine};

/// The provider ids the app routes work to, in the order the settings list them.
pub const PROVIDER_IDS: [&str; 8] = [
    "claude",
    "codex",
    "gemini",
    "grok",
    "opencode",
    "cline",
    crate::local_agent::PROVIDER_ID,
    crate::custom::PROVIDER_ID,
];

/// What is not on the engine trait: how a CLI is published and how it updates itself.
struct Install {
    id: &'static str,
    /// The package whose latest version on the npm registry is the CLI's latest version. Not
    /// necessarily how it was installed here.
    npm_package: Option<&'static str>,
    /// The arguments that make the CLI update itself.
    update_args: Option<&'static [&'static str]>,
}

const INSTALLS: [Install; 8] = [
    Install { id: "claude", npm_package: Some("@anthropic-ai/claude-code"), update_args: Some(&["update"]) },
    Install { id: "codex", npm_package: Some("@openai/codex"), update_args: Some(&["update"]) },
    // `agy` is a native binary: no registry to ask and no verified update command.
    Install { id: "gemini", npm_package: None, update_args: None },
    Install { id: "grok", npm_package: Some("@xai-official/grok"), update_args: Some(&["update"]) },
    Install { id: "opencode", npm_package: Some("opencode-ai"), update_args: Some(&["upgrade"]) },
    Install { id: "cline", npm_package: Some("cline"), update_args: Some(&["update"]) },
    // The in-process engine and the user's own command are not CLIs the app can update.
    Install { id: crate::local_agent::PROVIDER_ID, npm_package: None, update_args: None },
    Install { id: crate::custom::PROVIDER_ID, npm_package: None, update_args: None },
];

/// How a CLI that is **not installed yet** gets installed, per platform — the first-launch setup
/// (`crate::tool_setup`) and the «Instalar» button in Settings run exactly these.
///
/// Each line is the vendor's own documented one-liner, checked 2026-10-29: Claude Code's native
/// installer, opencode's and Grok's install scripts, and the npm packages the vendors publish where
/// there is no native installer (or none for Windows). Antigravity (`agy`) documents no command-line
/// install, so it has none and the setup links to its page instead. Unlike updating — which the CLI
/// does by itself, see [`Install::update_args`] — a first install has no CLI yet to ask.
pub struct Setup {
    pub id: &'static str,
    /// macOS and Linux, run by `bash -c`.
    pub unix: Option<&'static str>,
    /// Windows, run by PowerShell.
    pub windows: Option<&'static str>,
    /// The page to send someone to when there is no command, or it failed.
    pub url: &'static str,
}

pub const SETUPS: [Setup; 8] = [
    Setup {
        id: "claude",
        unix: Some("curl -fsSL https://claude.ai/install.sh | bash"),
        windows: Some("irm https://claude.ai/install.ps1 | iex"),
        url: "https://docs.claude.com/en/docs/claude-code/setup",
    },
    Setup {
        id: "codex",
        unix: Some("npm install -g @openai/codex"),
        windows: Some("npm install -g @openai/codex"),
        url: "https://developers.openai.com/codex/",
    },
    Setup { id: "gemini", unix: None, windows: None, url: "https://antigravity.google" },
    Setup {
        id: "grok",
        unix: Some("curl -fsSL https://x.ai/cli/install.sh | bash"),
        windows: Some("npm install -g @xai-official/grok"),
        url: "https://x.ai/cli",
    },
    Setup {
        id: "opencode",
        unix: Some("curl -fsSL https://opencode.ai/install | bash"),
        windows: Some("npm install -g opencode-ai"),
        url: "https://opencode.ai/docs/",
    },
    Setup { id: "cline", unix: Some("npm install -g cline"), windows: Some("npm install -g cline"), url: "https://cline.bot" },
    // Nothing to install: the in-process engine and the user's own command.
    Setup { id: crate::local_agent::PROVIDER_ID, unix: None, windows: None, url: "" },
    Setup { id: crate::custom::PROVIDER_ID, unix: None, windows: None, url: "" },
];

/// The install row of `id`.
pub fn setup_of(id: &str) -> Option<&'static Setup> {
    SETUPS.iter().find(|row| row.id == id)
}

/// One provider's capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCaps {
    pub id: String,
    pub label: String,
    pub default_binary: String,
    /// Runs inside the app: there is no CLI to find, version or update.
    pub in_process: bool,
    pub agentic: bool,
    pub resumes_sessions: bool,
    pub streams_partial: bool,
    /// Whether "read only" is a limit the CLI enforces, rather than a request to the model. A reviewer
    /// that must not write needs this to be true.
    pub enforces_read_only: bool,
    pub supports_extra_dirs: bool,
    /// Where the engine finds skills on its own, relative to a working directory.
    pub native_skills_dir: Option<String>,
    pub npm_package: Option<String>,
    pub update_args: Option<Vec<String>>,
}

impl ProviderCaps {
    /// Whether the app can find out that this CLI is out of date *and* update it.
    pub fn updatable(&self) -> bool {
        !self.in_process && self.npm_package.is_some() && self.update_args.is_some()
    }
}

/// The capabilities of `id`, or `None` for an id that is not a provider.
pub fn caps_of(id: &str) -> Option<ProviderCaps> {
    let known = PROVIDER_IDS.iter().find(|known| **known == id)?;
    let engine: Box<dyn AiEngine> = engine_for(known);
    let install = INSTALLS.iter().find(|row| row.id == *known);
    Some(ProviderCaps {
        id: engine.id().to_string(),
        label: engine.label().to_string(),
        default_binary: engine.default_binary().to_string(),
        in_process: engine.in_process(),
        agentic: engine.agentic(),
        resumes_sessions: engine.resumes_sessions(),
        streams_partial: engine.streams_partial(),
        enforces_read_only: engine.enforces_read_only(),
        supports_extra_dirs: engine.supports_extra_dirs(),
        native_skills_dir: engine.native_skills_dir().map(str::to_string),
        npm_package: install.and_then(|row| row.npm_package).map(str::to_string),
        update_args: install.and_then(|row| row.update_args).map(|args| args.iter().map(|arg| arg.to_string()).collect()),
    })
}

/// Every provider, in settings order.
pub fn all() -> Vec<ProviderCaps> {
    PROVIDER_IDS.iter().filter_map(|id| caps_of(id)).collect()
}

/// The ids whose "read only" is enforced by the CLI itself.
pub fn read_only_ids() -> Vec<String> {
    all().into_iter().filter(|caps| caps.enforces_read_only).map(|caps| caps.id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_has_exactly_one_install_row() {
        for id in PROVIDER_IDS {
            assert_eq!(INSTALLS.iter().filter(|row| row.id == id).count(), 1, "{id} needs one row in INSTALLS");
        }
        assert_eq!(INSTALLS.len(), PROVIDER_IDS.len(), "a row in INSTALLS names no provider");
    }

    #[test]
    fn every_provider_has_exactly_one_setup_row() {
        for id in PROVIDER_IDS {
            assert_eq!(SETUPS.iter().filter(|row| row.id == id).count(), 1, "{id} needs one row in SETUPS");
        }
        assert_eq!(SETUPS.len(), PROVIDER_IDS.len(), "a row in SETUPS names no provider");
    }

    #[test]
    fn every_cli_has_an_install_command_or_a_page_and_only_https_sources() {
        for caps in all() {
            let row = setup_of(&caps.id).unwrap();
            if caps.in_process || caps.id == crate::custom::PROVIDER_ID {
                assert!(row.unix.is_none() && row.windows.is_none(), "{} has nothing to install", caps.id);
                continue;
            }
            assert!(row.url.starts_with("https://"), "{}: a CLI needs a page to fall back to", caps.id);
            for command in [row.unix, row.windows].into_iter().flatten() {
                for word in command.split_whitespace().filter(|word| word.contains("://")) {
                    assert!(word.starts_with("https://"), "{}: {word} is not https", caps.id);
                }
                // The npm route installs the package the update check reads its version from.
                if let Some(rest) = command.strip_prefix("npm install -g ") {
                    assert_eq!(Some(rest), caps.npm_package.as_deref(), "{}: installs another package", caps.id);
                }
            }
        }
        assert!(setup_of("gemini").unwrap().unix.is_none(), "agy documents no command-line install");
        assert_eq!(setup_of("claude").unwrap().unix, Some("curl -fsSL https://claude.ai/install.sh | bash"));
    }

    #[test]
    fn the_ids_are_unique_and_each_answers_to_its_own_engine() {
        let mut seen = std::collections::HashSet::new();
        for id in PROVIDER_IDS {
            assert!(seen.insert(id), "{id} listed twice");
            // `engine_for` falls back to Claude for an id it does not know; this catches a provider
            // added to the list but not to the match.
            assert_eq!(engine_for(id).id(), id, "engine_for({id}) answers to another id");
        }
    }

    #[test]
    fn capabilities_are_read_from_the_engine_not_copied() {
        let caps = caps_of("claude").unwrap();
        let engine = engine_for("claude");
        assert_eq!(caps.enforces_read_only, engine.enforces_read_only());
        assert_eq!(caps.streams_partial, engine.streams_partial());
        assert_eq!(caps.default_binary, engine.default_binary());
        assert!(caps.streams_partial, "the doc on `streams_partial` says Claude is the one that can");
    }

    #[test]
    fn only_a_cli_with_a_registry_package_and_an_update_command_is_updatable() {
        assert!(caps_of("claude").unwrap().updatable());
        assert!(caps_of("opencode").unwrap().updatable());
        assert_eq!(caps_of("opencode").unwrap().update_args, Some(vec!["upgrade".to_string()]));
        assert!(!caps_of("gemini").unwrap().updatable(), "agy has no verified update command");
        assert!(!caps_of(crate::local_agent::PROVIDER_ID).unwrap().updatable(), "the in-process engine has no CLI");
        assert!(caps_of("not-a-provider").is_none());
    }

    #[test]
    fn an_update_command_is_never_a_flag_that_could_become_something_else() {
        for caps in all() {
            for arg in caps.update_args.unwrap_or_default() {
                assert!(arg.chars().all(|c| c.is_ascii_lowercase()), "{arg}: a subcommand is a plain word");
            }
            if let Some(package) = caps.npm_package {
                assert!(crate::npm::valid_package_name(&package), "{package} must be a valid npm name");
            }
        }
    }

    #[test]
    fn the_read_only_list_matches_what_the_engines_say() {
        let ids = read_only_ids();
        for id in PROVIDER_IDS {
            assert_eq!(ids.iter().any(|known| known == id), engine_for(id).enforces_read_only());
        }
    }
}
