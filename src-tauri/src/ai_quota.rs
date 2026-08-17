//! How much of each provider's plan has been **used** — the other half of the AI meter.
//!
//! [`crate::ai_usage`] answers "what have I spent", in tokens and dollars measured from what each
//! run reported. This answers the question that one deliberately refused: "how far through my plan
//! am I". It can now be answered for five of the engines, four of them by asking a back end with
//! the credential the CLI already keeps on this machine:
//!
//! - **Claude Code** — `GET https://api.anthropic.com/api/oauth/usage`, the endpoint behind the
//!   CLI's own `/usage` panel. Returns a `limits[]` of `{kind, group, percent, resets_at, scope}`:
//!   the five-hour session window, the weekly one, and a weekly bucket per scoped model.
//! - **Codex** — `GET https://chatgpt.com/backend-api/wham/usage` with the token from
//!   `~/.codex/auth.json`. One or two windows under `rate_limit`, named `primary`/`secondary` —
//!   positions, not lengths, so they are re-labelled from `limit_window_seconds` (a free account's
//!   "primary" is a month; a paid one's is five hours). Carries `plan_type` too, so this is the
//!   one provider whose plan name arrives with its limits.
//! - **Gemini / Antigravity (`agy`)** — `POST …/v1internal:retrieveUserQuota` on Google's Code
//!   Assist back end, which answers with a bucket per model carrying `remainingFraction` and
//!   `resetTime`.
//! - **opencode Go** — `GET https://opencode.ai/zen/go/v1/usage` with the `opencode-go` key from
//!   opencode's own `auth.json`. Three dollar-denominated windows (5-hour rolling, weekly,
//!   monthly), each already reported as a percentage consumed. Only the *Go* subscription has
//!   these: opencode Zen is pay-as-you-go credits and publishes nothing, which is correct — a
//!   prepaid balance has no window to be a fraction of.
//!
//! Everything else is **absent on purpose**, and absence here is a claim this module is willing to
//! make.
//!
//! - **Grok Build** publishes no quota anything can ask for. Every quieter route was ruled out on a
//!   signed-in account — no quota route in the binary, OIDC discovery with nothing past the
//!   standard endpoints, `cli-chat-proxy.grok.com/v1/{usage,quota,limits,rate_limits,me,
//!   subscription,account}` all 404 with a valid token, `/v1/models` with no rate-limit headers,
//!   and `grok -p --output-format json` reporting `usage` and `total_cost_usd` with no limit field.
//!   The number exists in exactly one place: the TUI's own `/usage` panel. This module *did* scrape
//!   it — `grok --minimal /usage` in a pty, frame regexed — and that came out in favour of not
//!   having it: a whole terminal UI booting per read, a console window this app cannot suppress on
//!   Windows (portable-pty's ConPTY backend takes no `CREATE_NO_WINDOW`), and a reading that goes
//!   quiet the day Grok rewords a label, in a panel whose entire value is being trusted. What Grok
//!   spends is still measured per run and lives in Uso.
//! - **Cline** drives whatever provider `cline auth` configured, and none of them is a window: its
//!   own account is a prepaid **balance** (`api.cline.bot/api/v1/users/{id}/balance` — money, no
//!   denominator, no reset), a metered API key has no cap, Ollama is local, and a Cline pointed at
//!   a Claude or Gemini plan would duplicate the row that plan already has under its own name.
//!
//! **Two rules this file does not break.**
//!
//! 1. *Nothing is computed from spend.* Every percentage here came from the provider. The moment
//!    one is derived from [`crate::ai_usage`]'s rows it stops being a limit and becomes a guess
//!    wearing a limit's clothes.
//! 2. *Never refresh a credential this app does not own.* See [`claude`] — Anthropic rotates
//!    refresh tokens, so spending one behind Claude Code's back would sign the user out of their
//!    own CLI. Google's installed-app flow does not rotate, which is the whole reason [`gemini`]
//!    is allowed to refresh and [`claude`] is not.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// One window of one provider's plan, as the provider itself described it.
#[derive(Debug, Clone, Serialize)]
pub struct QuotaLimit {
    /// What kind of window this is, as a stable key the frontend translates: `"session"`,
    /// `"weekly"`, `"monthly"`, or `"model"` for a per-model bucket that has no window of its own.
    pub kind: String,
    /// The provider's own name for this bucket — a model id, a scope label — when the kind alone
    /// does not identify it. Empty when it does.
    pub scope: String,
    /// How much of this limit has been **consumed**, 0–100. Used rather than remaining because
    /// that is the question being asked — "how much have I got through" — and providers report it
    /// both ways, so it is normalised here and the surfaces that draw it cannot disagree.
    pub used_percent: f64,
    /// RFC 3339 instant the window rolls over. Empty when the provider did not say — which some
    /// buckets genuinely do not, and a countdown invented for them would be a lie with a clock on
    /// it.
    pub resets_at: String,
}

/// Every limit one provider published, or why there are none.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderQuota {
    pub provider: String,
    /// Tightest limit first — the one about to run out is the one worth reading.
    pub limits: Vec<QuotaLimit>,
    /// The plan these limits belong to (`"max"`, `"pro"`…), when the provider names it. Empty
    /// otherwise.
    pub plan: String,
    /// Why `limits` is empty, when it is. One of the [`reason`] constants, or a transport error.
    /// Empty when the read succeeded.
    pub error: String,
    /// RFC 3339 of when these numbers were actually read from the provider — not of this call.
    /// A cached answer says so by carrying its original timestamp.
    pub fetched_at: String,
}

/// One reading of every provider that could be asked, plus which of them this install routes work
/// to.
///
/// The two halves feed two surfaces that want different answers to "whose plan is this". The panel
/// draws `providers` whole: the engines installed on the machine are the ones the user thinks of as
/// theirs, and one nothing is routed to today is one that may be routed to this afternoon — hiding
/// it made the panel look like it had lost an engine. The status pill is a single worst number, and
/// *that* one cannot be a plan nobody is spending, so it compares only what `routed` names.
#[derive(Debug, Clone, Serialize)]
pub struct QuotaReport {
    /// Every installed provider that publishes limits, in [`QUOTA_PROVIDERS`] order.
    pub providers: Vec<ProviderQuota>,
    /// The provider ids the global default or some per-task override points at — a subset of the
    /// ids in `providers`, except for the routed engines that are not installed.
    pub routed: Vec<String>,
}

/// Why a provider has nothing to show. Stable keys, translated in the frontend: the difference
/// between "sign in" and "run it once" is the difference between a broken panel and a panel
/// waiting for something ordinary to happen.
pub mod reason {
    /// The CLI is not signed in on this machine — no credential where it keeps one.
    pub const SIGNED_OUT: &str = "signed_out";
    /// A credential is there but has expired. The CLI refreshes it whenever it runs, and this app
    /// deliberately will not do it on the CLI's behalf, so the way out is to use the engine once.
    pub const STALE: &str = "stale";
    /// Signed in, read fine, and the account has no paid plan behind it — opencode answering
    /// `403 EntitlementError` to a key with no Go subscription.
    ///
    /// **Not the same as publishing nothing**, which is what an empty `error` means. opencode on
    /// Zen credits has no window to report and never will; the same account on a lapsed Go plan has
    /// windows that exist and are simply not yours today. Both used to come out as the same shrug,
    /// and the two facts point at different next steps — one at the pricing page, one at nowhere.
    pub const NO_PLAN: &str = "no_plan";
    /// The provider answered with something this could not make sense of: a CLI too old to have a
    /// `/usage` command, a TUI whose wording moved under the scraper. Distinct from every reason
    /// above because it is *this app's* problem to fix, and distinct from an empty `error` because
    /// "I could not read it" must never be reported as "there is nothing to read".
    pub const UNREADABLE: &str = "unreadable";
}

/// Providers whose back end publishes a plan limit at all. Everything outside this list is absent
/// from the panel entirely rather than shown empty — see the module docs.
pub const QUOTA_PROVIDERS: &[&str] = &["claude", "codex", "gemini", "opencode"];

/// One engine to ask, as the caller resolved it.
///
/// The caller decides *who* gets asked, and the rule is that an engine whose CLI is not installed
/// is not asked at all. That is not tidiness — it is what keeps the panel's advice followable. A
/// leftover `auth.json` from an uninstalled CLI (the desktop app leaves one; so does an install
/// that has since been removed) still answers "your token expired", and the panel then told the
/// user to *run that engine once to renew it* for an engine that is not on the machine.
#[derive(Debug, Clone)]
pub struct QuotaEngine {
    pub provider: String,
    /// The resolved, existing path to the CLI — already found, so a module that has to launch one
    /// does not go looking again and cannot end up running a different binary than the rest of the
    /// app would.
    pub binary: std::path::PathBuf,
}

/// Who asked for a reading, which governs two decisions the caller cannot make for itself.
///
/// The distinction that matters is **may this start a process**. Reading Claude's, Codex's or
/// opencode's quota is one HTTPS call and can happen on a timer without anyone noticing; reading
/// Gemini's runs its CLI, which on Windows flashes a console window as it starts. A timer doing
/// that every few minutes is the app interrupting the user to answer a question nobody asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// The background poll. Serves cache, and never starts a CLI.
    Poll,
    /// The panel was opened, or the settings screen shown. The user is looking, so a CLI may run.
    Open,
    /// The Refresh button. Same as [`Trigger::Open`] but bypasses the cache — without that, the
    /// button re-reads a cache and hands back identical numbers, which is not a slow refresh but no
    /// refresh, presented as one.
    Refresh,
}

/// Where each CLI keeps its state.
///
/// **Not derived from where the binary is installed, because it cannot be.** Moving `claude.exe` to
/// `D:\tools\` does not move `~/.claude`; these CLIs keep their credentials in a *home directory*
/// that is independent of the executable and is relocated with an environment variable, not by
/// installing elsewhere. So the honest way to follow a user who has moved things is to read the
/// same variable the CLI reads — `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME` — and fall back
/// to the same default it falls back to. Gemini's CLI exposes no such override, so `~/.gemini` is
/// its own answer rather than an assumption of ours.
///
/// **One limit worth knowing.** [`crate::shell_env`] imports the login shell's `PATH` and nothing
/// else, so a variable exported from `.zshrc` rather than set for the desktop session is invisible
/// here — the app would look in the default location while the CLI uses the moved one. Widening
/// that import is the fix, and it is a change to how the app starts, not to this module.
mod homes {
    /// A directory named by an environment variable, when it is set to something non-blank.
    pub fn from_env(name: &str) -> Option<std::path::PathBuf> {
        let value = std::env::var_os(name)?;
        let path = std::path::PathBuf::from(value);
        (!path.as_os_str().is_empty()).then_some(path)
    }
}

/// How long a successful read stays good, for the providers answered by one HTTP request.
///
/// These back ends are rate-limited and none of the numbers moves quickly: a five-hour window
/// shifts by a third of a percent a minute at full tilt. A minute of cache turns a panel left open,
/// a settings screen and a status pill into one request between them.
const FRESH_FOR: Duration = Duration::from_secs(60);

/// How long a CLI-driven reading stays good, which is much longer and has to be.
///
/// Every other provider costs one HTTPS call. Gemini costs a **process** — its CLI booting and
/// reaching the back end, seconds of work for a weekly number that moves by fractions of a percent
/// an hour. Half an hour, and only when the panel is open (see [`Trigger`]), is what keeps a
/// Windows user from being shown a console window flashing over their work to re-read a bar that
/// has not moved.
const CLI_FRESH_FOR: Duration = Duration::from_secs(1800);

fn fresh_for(provider: &str) -> Duration {
    match provider {
        // The one that reads its quota by *running the CLI* rather than by asking a back end.
        "gemini" => CLI_FRESH_FOR,
        _ => FRESH_FOR,
    }
}

/// The last answer from each provider, good or bad.
///
/// The cache holds failures too, and holding them is the point: a network blip must not empty a
/// panel that was correct thirty seconds ago. A failed refresh keeps serving the previous good
/// reading — with its original `fetched_at`, so the UI can age it — and only reports the failure
/// once there is nothing better to say.
static CACHE: Mutex<Option<HashMap<String, (Instant, ProviderQuota)>>> = Mutex::new(None);

fn cached(provider: &str) -> Option<(Instant, ProviderQuota)> {
    let guard = CACHE.lock().ok()?;
    guard.as_ref()?.get(provider).cloned()
}

/// Drops one provider's cached answer, so the next read has to go and ask.
fn forget(provider: &str) {
    if let Ok(mut guard) = CACHE.lock() {
        if let Some(all) = guard.as_mut() {
            all.remove(provider);
        }
    }
}

fn remember(provider: &str, quota: ProviderQuota) {
    if let Ok(mut guard) = CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(provider.to_string(), (Instant::now(), quota));
    }
}

/// One client for the process, cloned per call: a fresh `reqwest::Client` per request rebuilds the
/// whole rustls config and throws away the connection pool.
///
/// The timeout is short and deliberate. This is a status widget: an answer that arrives after the
/// user has closed the panel is worth nothing, and hanging on a stalled provider would hold the
/// other one's row hostage.
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn failed(provider: &str, error: &str) -> ProviderQuota {
    ProviderQuota {
        provider: provider.to_string(),
        limits: Vec::new(),
        plan: String::new(),
        error: error.to_string(),
        fetched_at: now_rfc3339(),
    }
}

/// Reads every provider that publishes a limit, concurrently.
///
/// Concurrent because they are independent network calls to different companies and the slowest
/// one should not set the latency of the panel. Each provider's failure is its own — one signed-out
/// engine must not take the other's numbers off the screen, which is why nothing here returns
/// `Result`.
/// `trigger` says who asked, which decides two different things — see [`Trigger`].
pub async fn fetch_all(engines: Vec<QuotaEngine>, trigger: Trigger) -> Vec<ProviderQuota> {
    let names: Vec<String> = engines.iter().map(|e| e.provider.clone()).collect();
    let mut running = Vec::with_capacity(engines.len());
    for engine in engines {
        running.push(tokio::spawn(fetch(engine, trigger)));
    }
    let mut out = Vec::with_capacity(running.len());
    for (provider, handle) in names.iter().zip(running) {
        // A panicked task is reported as a failed provider rather than propagated: the panel is
        // still owed the other engine's numbers.
        out.push(handle.await.unwrap_or_else(|e| failed(provider, &e.to_string())));
    }
    out
}

/// One provider, through the cache.
pub async fn fetch(engine: QuotaEngine, trigger: Trigger) -> ProviderQuota {
    let provider = engine.provider.as_str();
    if trigger != Trigger::Refresh {
        if let Some((at, hit)) = cached(provider) {
            if at.elapsed() < fresh_for(provider) {
                return hit;
            }
        }
    }

    // Nothing that costs a process is started by a timer. The CLI-driven providers launch a real
    // executable, and on Windows a console-mode child flashes a window on screen as it starts —
    // once every five minutes, unprompted, at whatever the user was actually doing. Attaching that
    // to the panel being open makes it something the user caused and is watching for, and cuts the
    // spawns to the moments the answer is on screen. The background poll keeps serving the cache,
    // so an already-read number stays visible and merely ages.
    if trigger == Trigger::Poll && fresh_for(provider) > FRESH_FOR {
        return cached(provider)
            .map(|(_, previous)| previous)
            .unwrap_or_else(|| pending(provider));
    }

    // The slow one never makes the caller wait. Gemini's reading costs its CLI booting and
    // reaching the back end — seconds during which every other provider's numbers are already
    // sitting ready, with the panel still saying "reading". So it refreshes *behind* the answer:
    // this call returns what is already known (usually nothing, the first time) and the next poll
    // finds the fresh value waiting in the cache. Eventually consistent, which a weekly window can
    // well afford.
    //
    // A forced refresh does not change that — waiting fifteen seconds on a button press is worse
    // than updating a second later — but it does drop the cached copy first, so the detached read
    // that follows genuinely re-runs instead of finding its own answer still fresh.
    if fresh_for(provider) > FRESH_FOR {
        if trigger == Trigger::Refresh {
            forget(provider);
        }
        refresh_detached(engine.clone());
        return cached(provider)
            .map(|(_, previous)| previous)
            .unwrap_or_else(|| pending(provider));
    }

    read_now(&engine).await
}

/// A provider whose request is still out.
///
/// **The empty `fetched_at` is the signal, and it is load-bearing.** No limits, no error and no read
/// time is the one combination that means "not answered yet"; everything else carries the instant it
/// was read, even when what it read was nothing at all. The UI draws it as a "reading…" row.
///
/// It used to be drawn as nothing, on the reasoning that a row about to change is a moving part in
/// a panel read at a glance. That was wrong in the only way that matters: on the first open the
/// CLI-driven providers take seconds, and a working engine that is merely *absent* for a minute is
/// indistinguishable from one that is broken. Reported from a second machine as exactly that.
fn pending(provider: &str) -> ProviderQuota {
    ProviderQuota {
        provider: provider.to_string(),
        limits: Vec::new(),
        plan: String::new(),
        error: String::new(),
        fetched_at: String::new(),
    }
}

/// Starts a background read, unless one is already running.
///
/// The guard is the point: without it every poll while a multi-second read is in flight would
/// start another, and a panel left open would have a queue of CLI processes behind it.
fn refresh_detached(engine: QuotaEngine) {
    static IN_FLIGHT: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

    {
        let Ok(mut guard) = IN_FLIGHT.lock() else { return };
        let running = guard.get_or_insert_with(std::collections::HashSet::new);
        if !running.insert(engine.provider.clone()) {
            return;
        }
    }

    tokio::spawn(async move {
        let _ = read_now(&engine).await;
        if let Ok(mut guard) = IN_FLIGHT.lock() {
            if let Some(running) = guard.as_mut() {
                running.remove(&engine.provider);
            }
        }
    });
}

/// Reads one provider for real and files the result.
async fn read_now(engine: &QuotaEngine) -> ProviderQuota {
    let provider = engine.provider.as_str();
    let fresh = match provider {
        "claude" => claude::quota().await,
        "codex" => codex::quota().await,
        // The only one handed the binary: it is the only provider whose quota is read by launching
        // the CLI rather than by asking a back end.
        "gemini" => gemini::quota(&engine.binary).await,
        "opencode" => opencode::quota().await,
        other => failed(other, "unsupported"),
    };

    // A failed read falls back to the last good one rather than blanking the row. The stale answer
    // keeps its own `fetched_at`, so "these numbers are from four minutes ago" is visible rather
    // than implied — and the cache clock is *not* reset, so the next poll tries again immediately
    // instead of serving the stale copy for another minute.
    if !fresh.error.is_empty() {
        if let Some((_, previous)) = cached(provider) {
            if !previous.limits.is_empty() {
                return previous;
            }
        }
        return fresh;
    }

    remember(provider, fresh.clone());
    fresh
}

/// Orders a provider's limits for reading, and clamps them to something a bar can honestly claim.
///
/// **By window first, fullness second.** Sorting purely by how full each bar is looked right until
/// Anthropic's three arrived: the week at 46%, the session at 10% and one model's slice of that
/// same week at 0% came out interleaved, so the two halves of the weekly group sat either side of
/// an unrelated row. Grouping by kind keeps a family together — which is the whole reason the
/// scoped row is legible at all — and sorting by fullness inside it still leads with the one about
/// to run out. Within a kind, the unscoped total (the whole week) comes before its per-model
/// slices regardless of fullness, because it is the one the others are a part of.
///
/// The status pill does *not* read this order — it takes the fullest limit across every provider,
/// which is a different question and is sorted separately in `quotaStore`.
fn tighten(mut limits: Vec<QuotaLimit>) -> Vec<QuotaLimit> {
    for limit in &mut limits {
        limit.used_percent = limit.used_percent.clamp(0.0, 100.0);
    }
    limits.sort_by(|a, b| {
        kind_rank(&a.kind)
            .cmp(&kind_rank(&b.kind))
            .then(a.scope.is_empty().cmp(&b.scope.is_empty()).reverse())
            .then(
                b.used_percent
                    .partial_cmp(&a.used_percent)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    limits
}

/// Shortest window first: a session runs out today, a week this week, a month this month — and a
/// per-model bucket is only meaningful once you know which window it sits in.
fn kind_rank(kind: &str) -> u8 {
    match kind {
        "session" => 0,
        "weekly" => 1,
        "monthly" => 2,
        _ => 3,
    }
}

#[cfg(test)]
mod live {
    //! The one test that proves the endpoints are still there.
    //!
    //! `#[ignore]` because it needs the network, the machine's own signed-in CLIs, and — on macOS —
    //! permission to read Claude Code's keychain item, none of which belong in a normal test run.
    //! Run it by hand when a provider changes something:
    //!
    //! ```text
    //! cargo test --lib ai_quota::live -- --ignored --nocapture
    //! ```
    //!
    //! It asserts almost nothing on purpose. A signed-out machine is a legitimate outcome and would
    //! make a strict assertion fail for the wrong reason; what this is for is *reading* the output.

    #[tokio::test]
    #[ignore = "hits the providers' live endpoints"]
    async fn what_the_providers_actually_say() {
        // Resolved the same way the command does, so this exercises the real thing: an engine that
        // is not installed on this machine is not asked, and simply does not appear below.
        let engines: Vec<super::QuotaEngine> = super::QUOTA_PROVIDERS
            .iter()
            .filter_map(|provider| {
                let binary = crate::ai::engine_for(provider).default_binary().to_string();
                crate::ai::find_on_path(&binary).map(|binary| super::QuotaEngine {
                    provider: provider.to_string(),
                    binary,
                })
            })
            .collect();
        println!("asking: {:?}", engines.iter().map(|e| &e.provider).collect::<Vec<_>>());

        // Forced, so a cache left warm by an earlier read cannot pass off a stale answer as a live
        // one — which is the whole point of this test.
        let first = super::fetch_all(engines.clone(), super::Trigger::Refresh).await;

        // The CLI-driven providers answer *behind* that call, so the forced pass only started them.
        // Waiting and asking again is the only way this test sees their numbers at all — without
        // it Gemini always prints as pending and a broken subprocess path would look exactly like
        // a working one. `Open` and not `Poll`: a poll deliberately never starts a CLI read, so
        // polling here would wait for something nobody asked for.
        let slow: Vec<&str> = first
            .iter()
            .filter(|quota| quota.fetched_at.is_empty())
            .map(|quota| quota.provider.as_str())
            .collect();
        let report = if slow.is_empty() {
            first
        } else {
            println!("waiting on: {slow:?}");
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            super::fetch_all(engines, super::Trigger::Open).await
        };

        for quota in report {
            println!("\n{} (read {})", quota.provider, quota.fetched_at);
            if !quota.error.is_empty() {
                println!("  no limits: {}", quota.error);
            }
            for limit in &quota.limits {
                println!(
                    "  {:<9} {:<24} {:>6.1}% used  resets {}",
                    limit.kind,
                    if limit.scope.is_empty() { "—" } else { &limit.scope },
                    limit.used_percent,
                    if limit.resets_at.is_empty() { "—" } else { &limit.resets_at },
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------

mod claude {
    use super::*;

    /// The endpoint behind the CLI's own `/usage`. Same OAuth token, same beta header.
    const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
    /// The keychain item Claude Code writes on macOS. Reading it prompts the user once, the first
    /// time — which is why the frontend only asks for quota after a deliberate action (opening the
    /// panel), never at startup.
    #[cfg(target_os = "macos")]
    const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

    #[derive(Deserialize)]
    struct Credentials {
        #[serde(rename = "claudeAiOauth")]
        oauth: Option<Oauth>,
    }

    #[derive(Deserialize)]
    struct Oauth {
        #[serde(rename = "accessToken")]
        access_token: String,
        /// Milliseconds since the epoch. Checked before the request purely to tell a *stale*
        /// credential apart from a *rejected* one — a 401 alone cannot say which, and the two have
        /// completely different answers ("run it once" vs "sign in again").
        #[serde(rename = "expiresAt")]
        expires_at: Option<i64>,
    }

    #[derive(Deserialize)]
    struct UsageResponse {
        #[serde(default)]
        limits: Vec<Limit>,
    }

    #[derive(Deserialize)]
    struct Limit {
        /// `session`, `weekly_all` or `weekly_scoped` — the last two collapse into one kind, see
        /// [`map_limits`].
        #[serde(default)]
        kind: String,
        /// How much of the window has been used, 0–100 — already the direction this module reports
        /// in.
        #[serde(default)]
        percent: f64,
        #[serde(default)]
        resets_at: Option<String>,
        /// Present on `weekly_scoped`: which model this slice of the week belongs to. Its `id` is
        /// routinely null while `display_name` is not, so the name is the only usable handle.
        #[serde(default)]
        scope: Option<Scope>,
    }

    #[derive(Deserialize)]
    struct Scope {
        model: Option<ScopeModel>,
    }

    #[derive(Deserialize)]
    struct ScopeModel {
        display_name: Option<String>,
    }

    /// Where Claude Code keeps its OAuth token on this platform.
    ///
    /// macOS puts it in the login keychain; the other platforms write
    /// `~/.claude/.credentials.json`. The file is tried on every platform anyway, because a macOS
    /// install configured with `CLAUDE_CODE_USE_KEYCHAIN=0` writes it too and the file costs
    /// nothing to miss.
    fn credentials() -> Option<Credentials> {
        #[cfg(target_os = "macos")]
        {
            let account = std::env::var("USER")
                .or_else(|_| std::env::var("LOGNAME"))
                .unwrap_or_default();
            if !account.is_empty() {
                if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &account) {
                    if let Ok(raw) = entry.get_password() {
                        if let Ok(parsed) = serde_json::from_str::<Credentials>(&raw) {
                            return Some(parsed);
                        }
                    }
                }
            }
        }

        let raw = std::fs::read_to_string(config_dir()?.join(".credentials.json")).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Claude Code's state directory: `$CLAUDE_CONFIG_DIR` when the user has moved it, else
    /// `~/.claude`. The CLI's own resolution, in its own order — see [`super::homes`] for why this
    /// is asked of an environment variable rather than derived from where the binary happens to
    /// live.
    fn config_dir() -> Option<std::path::PathBuf> {
        super::homes::from_env("CLAUDE_CONFIG_DIR").or_else(|| Some(dirs::home_dir()?.join(".claude")))
    }

    /// Reads the plan limits.
    ///
    /// **This never refreshes the token, and that is a decision rather than an omission.** Anthropic
    /// rotates refresh tokens: spending Claude Code's on its behalf and keeping the replacement
    /// here would invalidate the copy the CLI still holds, and the user would find themselves
    /// signed out of their own terminal by a status widget. So an expired credential is reported as
    /// [`reason::STALE`] and left alone — Claude Code refreshes it the next time it runs, including
    /// every time this app runs it, which makes the panel correct exactly when the engine is in use.
    pub async fn quota() -> ProviderQuota {
        // Off the runtime, and not as a micro-optimisation: on macOS the first read raises a
        // system dialog asking the user to let this app open Claude Code's keychain item, and
        // `get_password` does not return until they answer it. That is an unbounded wait on a
        // blocking call — left on an async worker it parks one of the runtime's threads for as
        // long as the dialog is on screen.
        let credentials = tokio::task::spawn_blocking(credentials).await.ok().flatten();

        let Some(oauth) = credentials.and_then(|c| c.oauth) else {
            return failed("claude", reason::SIGNED_OUT);
        };

        if let Some(expires_at) = oauth.expires_at {
            if expires_at <= chrono::Utc::now().timestamp_millis() {
                return failed("claude", reason::STALE);
            }
        }

        let response = client()
            .get(USAGE_URL)
            .bearer_auth(&oauth.access_token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(e) => return failed("claude", &e.to_string()),
        };

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            // The token was inside its stated lifetime and still refused — a revoked session or a
            // sign-out elsewhere, which is a different problem from an expired one.
            return failed("claude", reason::SIGNED_OUT);
        }
        if !response.status().is_success() {
            return failed("claude", &format!("HTTP {}", response.status().as_u16()));
        }

        let parsed: UsageResponse = match response.json().await {
            Ok(parsed) => parsed,
            Err(e) => return failed("claude", &e.to_string()),
        };

        ProviderQuota {
            provider: "claude".to_string(),
            limits: tighten(map_limits(parsed)),
            plan: String::new(),
            error: String::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// Anthropic's `limits[]` in this module's terms — a straight pass-through of `percent`, which
    /// already reports consumption, plus the grouping that makes three rows legible.
    ///
    /// **The shape is the CLI's own `/usage`, on purpose.** That panel reads: one *Current session*
    /// window, then a *Weekly limits* group holding *All models* and a row per scoped model. All
    /// three arrive here flat and differing only in a `kind` string, which is how they briefly got
    /// drawn as three unrelated bars — two of which appeared to be the same week twice. So
    /// `weekly_all` and `weekly_scoped` both become `weekly` and are told apart by `scope`: empty
    /// means the whole week, a model name means that model's slice of it. The frontend prints
    /// "Weekly · All models" from exactly that, so the two are visibly the same family.
    fn map_limits(parsed: UsageResponse) -> Vec<QuotaLimit> {
        parsed
            .limits
            .into_iter()
            .filter(|limit| !limit.kind.is_empty())
            .map(|limit| QuotaLimit {
                kind: if limit.kind == "session" { "session" } else { "weekly" }.to_string(),
                scope: limit
                    .scope
                    .and_then(|s| s.model)
                    .and_then(|m| m.display_name)
                    .unwrap_or_default(),
                used_percent: limit.percent,
                resets_at: limit.resets_at.unwrap_or_default(),
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Trimmed from a real `GET /api/oauth/usage` on a Max plan — the three shapes the endpoint
        /// actually returns, including the scoped bucket whose `scope.model.id` is null while its
        /// `display_name` is not.
        const REAL: &str = r#"{
          "limits": [
            {"kind":"session","group":"session","percent":2,"severity":"normal",
             "resets_at":"2026-08-13T07:29:59.657336+00:00","scope":null,"is_active":false},
            {"kind":"weekly_all","group":"weekly","percent":45,"severity":"normal",
             "resets_at":"2026-08-17T17:00:00.657365+00:00","scope":null,"is_active":true},
            {"kind":"weekly_scoped","group":"weekly","percent":0,"severity":"normal",
             "resets_at":"2026-08-17T16:59:59.657601+00:00",
             "scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}
          ]
        }"#;

        /// The order and the grouping the CLI's own `/usage` uses: session, then the week, then the
        /// week's per-model slices — not three bars sorted by how full they happen to be.
        #[test]
        fn groups_the_week_with_its_model_slices_and_reports_consumption() {
            let limits = tighten(map_limits(serde_json::from_str(REAL).unwrap()));
            assert_eq!(limits.len(), 3);

            assert_eq!(limits[0].kind, "session");
            assert_eq!(limits[0].scope, "");
            assert_eq!(limits[0].used_percent, 2.0);

            // The whole week leads its group even though the slice below is not fuller.
            assert_eq!(limits[1].kind, "weekly");
            assert_eq!(limits[1].scope, "");
            assert_eq!(limits[1].used_percent, 45.0);
            assert_eq!(limits[1].resets_at, "2026-08-17T17:00:00.657365+00:00");

            assert_eq!(limits[2].kind, "weekly");
            assert_eq!(limits[2].scope, "Fable");
            assert_eq!(limits[2].used_percent, 0.0);
        }

        /// A response with no `limits` is a provider that said nothing, not a provider at zero —
        /// the UI draws no rows for it rather than an empty bar.
        #[test]
        fn missing_limits_is_empty_not_zero() {
            let limits = map_limits(serde_json::from_str("{}").unwrap());
            assert!(limits.is_empty());
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Gemini / Antigravity
// ---------------------------------------------------------------------------------------------

mod gemini {
    //! Read by **asking the CLI**, not its back end.
    //!
    //! This module used to call Google's Code Assist RPC directly
    //! (`v1internal:retrieveUserQuota`) with a token lifted from agy's own credential file. That
    //! worked, and then stopped: on 2026-08-13 `loadCodeAssist` began answering `currentTier: null`
    //! with `free-tier → UNSUPPORTED_CLIENT` ("this client is no longer supported for Gemini Code
    //! Assist for individuals"), so the RPC returned 403 `SUBSCRIPTION_REQUIRED` — while `agy`
    //! itself went on reporting a perfectly good quota in its `/usage` panel. The back end had not
    //! gone away; the *client* had been retired underneath us.
    //!
    //! `agy -p "/usage" --output-format json` is the answer, and is better than the RPC ever was:
    //! it needs no OAuth client, no borrowed refresh token and no assumption about which tier the
    //! account is on, because the CLI resolves all of that itself. It also returns the numbers agy
    //! actually shows — weekly limits **grouped** ("Gemini Models", "Claude and GPT models") —
    //! rather than the per-model Code Assist buckets, which were a different and staler picture.
    //!
    //! It costs a subprocess (~5s) and **spends nothing**: the run reports `num_turns: 0` and zero
    //! tokens, because a slash command never reaches a model. That is why it is read behind the
    //! answer, on a long window, rather than on every panel open — it is the only provider left
    //! that costs a process at all.

    use super::*;

    /// Long enough for a cold CLI to start and reach the back end, short enough that a hung one
    /// does not sit in the process table. The CLI takes the same value, so it gives up on itself
    /// first and the outer guard is only for a CLI that ignores it.
    const PRINT_TIMEOUT: &str = "45s";
    const DEADLINE: Duration = Duration::from_secs(60);

    /// The closing envelope of a print-mode run. Only `command` matters: a slash command puts its
    /// structured result there, while `response` carries the same thing rendered as tab-separated
    /// text — parsing the text would work today and break the first time a column moves.
    #[derive(Deserialize)]
    struct Envelope {
        command: Option<Command>,
    }

    #[derive(Deserialize)]
    struct Command {
        #[serde(default)]
        name: String,
        data: Option<Data>,
    }

    #[derive(Deserialize)]
    struct Data {
        #[serde(default)]
        groups: Vec<Group>,
    }

    /// A family of models that share one allowance — which is the unit agy bills in, so it is the
    /// unit reported here. `"Gemini Models"`, `"Claude and GPT models"`.
    #[derive(Deserialize)]
    struct Group {
        #[serde(default)]
        name: String,
        #[serde(default)]
        buckets: Vec<Bucket>,
    }

    #[derive(Deserialize)]
    struct Bucket {
        /// `weekly`, and whatever else a paid tier reports. Mapped rather than trusted verbatim so
        /// an unknown window still draws with a sensible label.
        #[serde(default)]
        window: String,
        /// How much is **left**, 0–1 — the opposite direction this module reports in.
        #[serde(default)]
        remaining_fraction: f64,
        #[serde(default)]
        reset_time: Option<String>,
    }

    pub async fn quota(binary: &std::path::Path) -> ProviderQuota {
        // Built the way a real run builds one: resolved extension, widened `PATH`, and no console
        // window on Windows. Assembling it here instead is exactly how a spawn site drifts — this
        // one already lacked the `PATH` the CLI needs to find its own helpers.
        let mut command = crate::ai::aux_command(&binary.to_string_lossy());
        command
            .arg("-p")
            .arg("/usage")
            .arg("--output-format")
            .arg("json")
            .arg("--print-timeout")
            .arg(PRINT_TIMEOUT)
            .stdin(std::process::Stdio::null());

        let run = tokio::time::timeout(DEADLINE, command.output()).await;
        let output = match run {
            Ok(Ok(output)) => output,
            // A CLI that will not start is not a signed-out account, and saying so would send the
            // user to re-authenticate something that is working.
            Ok(Err(e)) => return failed("gemini", &e.to_string()),
            Err(_) => return failed("gemini", "timeout"),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let Some(limits) = parse(&stdout) else {
            // The CLI answered with something this does not recognise — an older build without the
            // `/usage` command, or a sign-in prompt. Nothing to draw, and the one thing that must
            // not be drawn is a claim: this is "could not read", never "has no limits", which is
            // the sentence the empty answer below earns by actually containing a usage payload.
            return failed("gemini", reason::UNREADABLE);
        };

        ProviderQuota {
            provider: "gemini".to_string(),
            limits: tighten(limits),
            plan: String::new(),
            error: String::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// The `/usage` envelope in this module's terms.
    ///
    /// `None` means no usage payload was found at all, which is different from finding one that is
    /// empty: the first is "this CLI cannot tell us", the second is "this account has no windows".
    /// Only the first deserves to be indistinguishable from a provider that was never asked.
    fn parse(stdout: &str) -> Option<Vec<QuotaLimit>> {
        // Two shapes, because print mode has both: one JSON object for the whole run (what it
        // actually emits today, on a single very long line), or that object preceded by progress
        // lines. Whole-input first so a pretty-printed payload parses at all — a line scan would
        // reject every line of it — then a line scan for the prefixed case.
        if let Some(limits) = usage_payload(stdout.trim()) {
            return Some(limits);
        }
        let mut found = None;
        for line in stdout.lines().map(str::trim).filter(|line| line.starts_with('{')) {
            if let Some(limits) = usage_payload(line) {
                // The last one wins: the closing envelope is the one carrying the final answer.
                found = Some(limits);
            }
        }
        found
    }

    /// One candidate JSON blob, if it is a `/usage` result.
    fn usage_payload(candidate: &str) -> Option<Vec<QuotaLimit>> {
        let command = serde_json::from_str::<Envelope>(candidate).ok()?.command?;
        (command.name == "usage")
            .then(|| map_groups(command.data.map(|data| data.groups).unwrap_or_default()))
    }

    fn map_groups(groups: Vec<Group>) -> Vec<QuotaLimit> {
        groups
            .into_iter()
            .flat_map(|group| {
                let name = group.name;
                group.buckets.into_iter().map(move |bucket| QuotaLimit {
                    kind: kind_for(&bucket.window).to_string(),
                    // The group is the scope: two weekly windows that differ only by which models
                    // they cover have to say which, or they read as the same week listed twice.
                    scope: name.clone(),
                    used_percent: (1.0 - bucket.remaining_fraction) * 100.0,
                    resets_at: bucket.reset_time.unwrap_or_default(),
                })
            })
            .collect()
    }

    /// agy's own word for the window, in this module's vocabulary. An unrecognised one falls back
    /// to `model`, which the UI labels by its scope alone — wrong-ish, but never a *wrong window*.
    fn kind_for(window: &str) -> &'static str {
        match window.to_ascii_lowercase().as_str() {
            "weekly" | "week" => "weekly",
            "monthly" | "month" => "monthly",
            "session" | "rolling" | "five_hour" | "5h" => "session",
            _ => "model",
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Captured verbatim from `agy -p "/usage" --output-format json` on 1.1.12.
        const REAL: &str = r#"{"conversation_id":"","status":"SUCCESS",
          "response":"Gemini Models\tWeekly Limit Remaining\t95%\t2026-08-17T16:17:01Z\n",
          "duration_seconds":0,"num_turns":0,
          "usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},
          "command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit.",
            "groups":[
              {"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro",
               "buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","description":"…",
                           "window":"weekly","remaining_fraction":0.9543591737747192,
                           "reset_time":"2026-08-17T16:17:01Z"}]},
              {"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
               "buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","description":"…",
                           "window":"weekly","remaining_fraction":0.9323989748954773,
                           "reset_time":"2026-08-14T00:50:48Z"}]}
            ]}}}"#;

        #[test]
        fn each_group_becomes_a_named_weekly_window() {
            let limits = tighten(parse(REAL).expect("a usage payload"));
            assert_eq!(limits.len(), 2);

            // Fullest first, and the fraction is inverted: 0.9324 left is 6.76% used.
            assert_eq!(limits[0].scope, "Claude and GPT models");
            assert_eq!(limits[0].kind, "weekly");
            assert!((limits[0].used_percent - 6.76).abs() < 0.01);
            assert_eq!(limits[0].resets_at, "2026-08-14T00:50:48Z");

            assert_eq!(limits[1].scope, "Gemini Models");
            assert!((limits[1].used_percent - 4.56).abs() < 0.01);
        }

        /// Output with no usage command at all — an older CLI, or a sign-in prompt. It must be
        /// "cannot tell", not "no windows", so the caller can stay silent rather than assert.
        #[test]
        fn output_without_a_usage_command_is_unknown() {
            assert!(parse(r#"{"status":"SUCCESS","response":"hi","command":null}"#).is_none());
            assert!(parse("not json at all").is_none());
        }

        /// A usage command that carries no groups is an account with no windows — a real answer,
        /// and a different one from not having asked.
        #[test]
        fn a_usage_command_with_no_groups_is_an_empty_answer() {
            let empty = r#"{"command":{"name":"usage","data":{"groups":[]}}}"#;
            assert_eq!(parse(empty).map(|l| l.len()), Some(0));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// opencode Go
// ---------------------------------------------------------------------------------------------

mod opencode {
    use super::*;

    /// opencode's own subscription tier. The path is the tell: `zen/go` is the Go plan, while
    /// plain `zen/v1` is the pay-as-you-go one and has no `usage` route at all — asked for it, it
    /// serves the marketing site's 404 page.
    const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

    /// The key opencode files under this name once `opencode auth login` has added the Go plan.
    /// `opencode` (Zen) and any model provider the user configured sit in the same file and are
    /// deliberately not read: only Go has windows.
    const GO_CREDENTIAL: &str = "opencode-go";

    #[derive(Deserialize)]
    struct Credential {
        key: Option<String>,
    }

    #[derive(Deserialize)]
    struct UsageResponse {
        usage: Option<Windows>,
    }

    #[derive(Deserialize)]
    struct Windows {
        /// The five-hour rolling window.
        rolling: Option<Window>,
        weekly: Option<Window>,
        monthly: Option<Window>,
    }

    #[derive(Deserialize)]
    struct Window {
        /// Consumed, 0–100, already floored server-side. Same direction this module reports in.
        #[serde(default)]
        percent: f64,
        #[serde(rename = "resetsAt", default)]
        resets_at: Option<String>,
    }

    /// Where opencode keeps its credentials.
    ///
    /// It is an XDG data directory, so `XDG_DATA_HOME` wins where it is set and the conventional
    /// `~/.local/share` is the fallback — including on Windows, which is what opencode itself
    /// does rather than using `%APPDATA%`.
    fn auth_path() -> Option<std::path::PathBuf> {
        let base = match std::env::var("XDG_DATA_HOME") {
            Ok(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir),
            _ => dirs::home_dir()?.join(".local").join("share"),
        };
        Some(base.join("opencode").join("auth.json"))
    }

    fn go_key() -> Option<String> {
        let raw = std::fs::read_to_string(auth_path()?).ok()?;
        let all: std::collections::HashMap<String, Credential> = serde_json::from_str(&raw).ok()?;
        all.get(GO_CREDENTIAL)?.key.clone().filter(|k| !k.is_empty())
    }

    pub async fn quota() -> ProviderQuota {
        let Some(key) = go_key() else {
            // opencode is installed and possibly signed in to Zen or to a model provider of its
            // own, none of which have a window. Not an error — just nothing to draw, so the panel
            // leaves opencode out entirely.
            return silent();
        };

        let response = match client().get(USAGE_URL).bearer_auth(&key).send().await {
            Ok(response) => response,
            Err(e) => return failed("opencode", &e.to_string()),
        };

        // 403 is `EntitlementError: OpenCode Go subscription required` — a valid key on an account
        // whose subscription is not active. **Not** the same answer as having no key at all: this
        // account has windows waiting behind a subscription, where a Zen-only install has none to
        // wait for. Saying so is the difference between a dead end and a next step.
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            return failed("opencode", reason::NO_PLAN);
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return failed("opencode", reason::SIGNED_OUT);
        }
        if !response.status().is_success() {
            return failed("opencode", &format!("HTTP {}", response.status().as_u16()));
        }

        let parsed: UsageResponse = match response.json().await {
            Ok(parsed) => parsed,
            Err(e) => return failed("opencode", &e.to_string()),
        };

        ProviderQuota {
            provider: "opencode".to_string(),
            limits: tighten(map_windows(parsed)),
            plan: String::new(),
            error: String::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// A provider with nothing to say and nothing wrong. Distinct from [`failed`]: an empty `error`
    /// is what tells the UI to omit the block rather than explain it.
    fn silent() -> ProviderQuota {
        ProviderQuota {
            provider: "opencode".to_string(),
            limits: Vec::new(),
            plan: String::new(),
            error: String::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// The three named windows in this module's terms. Named rather than a list because that is how
    /// they arrive — three fields, not an array — and each maps to a kind the frontend already
    /// knows how to label.
    fn map_windows(parsed: UsageResponse) -> Vec<QuotaLimit> {
        let Some(usage) = parsed.usage else { return Vec::new() };
        [
            ("session", usage.rolling),
            ("weekly", usage.weekly),
            ("monthly", usage.monthly),
        ]
        .into_iter()
        .filter_map(|(kind, window)| {
            window.map(|window| QuotaLimit {
                kind: kind.to_string(),
                scope: String::new(),
                used_percent: window.percent,
                resets_at: window.resets_at.unwrap_or_default(),
            })
        })
        .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The exact shape `packages/console/app/src/routes/zen/go/v1/usage.ts` returns.
        const REAL: &str = r#"{
          "usage": {
            "rolling": {"status":"ok","percent":12,"resetsAt":"2026-08-13T08:00:00.000Z"},
            "weekly":  {"status":"ok","percent":40,"resetsAt":"2026-08-17T00:00:00.000Z"},
            "monthly": {"status":"rate-limited","percent":100,"resetsAt":"2026-09-01T00:00:00.000Z"}
          }
        }"#;

        #[test]
        fn three_windows_shortest_first() {
            let limits = tighten(map_windows(serde_json::from_str(REAL).unwrap()));
            assert_eq!(limits.len(), 3);
            // Ordered by window length, not by fullness — the exhausted month comes last even
            // though it is the one at 100%.
            assert_eq!(limits[0].kind, "session");
            assert_eq!(limits[0].used_percent, 12.0);
            assert_eq!(limits[1].kind, "weekly");
            assert_eq!(limits[1].used_percent, 40.0);
            assert_eq!(limits[2].kind, "monthly");
            assert_eq!(limits[2].used_percent, 100.0);
            assert_eq!(limits[2].resets_at, "2026-09-01T00:00:00.000Z");
        }

        /// A 200 that carries no `usage` object is no windows, not three at zero.
        #[test]
        fn no_usage_object_is_no_rows() {
            assert!(map_windows(serde_json::from_str("{}").unwrap()).is_empty());
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

mod codex {
    use super::*;

    /// The endpoint the Codex CLI itself reads its limits from. Note the path says `wham`, not
    /// `codex`: `backend-api/codex/usage` exists too and answers 403 to a CLI token, which is the
    /// sort of near-miss that looks like an auth problem and is not one.
    const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

    #[derive(Deserialize)]
    struct AuthFile {
        tokens: Option<Tokens>,
    }

    #[derive(Deserialize)]
    struct Tokens {
        access_token: Option<String>,
        /// The ChatGPT workspace the key belongs to. Sent as its own header; the token alone is
        /// accepted but answers for no account in particular.
        account_id: Option<String>,
    }

    #[derive(Deserialize)]
    struct UsageResponse {
        /// `free`, `plus`, `pro`… Reported straight through as the plan name, since unlike
        /// Anthropic's this arrives with the limits rather than needing a second request.
        #[serde(default)]
        plan_type: String,
        rate_limit: Option<RateLimit>,
    }

    #[derive(Deserialize)]
    struct RateLimit {
        primary_window: Option<Window>,
        /// Null on plans with a single window — a free account has only the monthly one.
        secondary_window: Option<Window>,
    }

    #[derive(Deserialize)]
    struct Window {
        #[serde(default)]
        used_percent: f64,
        /// How long the window is. This is what names it: the payload calls its windows "primary"
        /// and "secondary", which say nothing about their length and swap meaning between plans.
        #[serde(default)]
        limit_window_seconds: i64,
        /// Unix epoch seconds.
        #[serde(default)]
        reset_at: Option<i64>,
        #[serde(default)]
        reset_after_seconds: Option<i64>,
    }

    /// `$CODEX_HOME`, else `~/.codex` — borrowed from [`crate::codex::codex_home`] rather than
    /// spelled out again, so the directory the quota reads can never drift from the one the engine
    /// reads its model catalogue out of.
    fn auth_path() -> Option<std::path::PathBuf> {
        Some(crate::codex::codex_home()?.join("auth.json"))
    }

    fn tokens() -> Option<Tokens> {
        let raw = std::fs::read_to_string(auth_path()?).ok()?;
        serde_json::from_str::<AuthFile>(&raw).ok()?.tokens
    }

    pub async fn quota() -> ProviderQuota {
        let Some(tokens) = tokens() else {
            return failed("codex", reason::SIGNED_OUT);
        };
        let Some(access) = tokens.access_token.filter(|t| !t.is_empty()) else {
            return failed("codex", reason::SIGNED_OUT);
        };

        let mut request = client().get(USAGE_URL).bearer_auth(&access);
        if let Some(account) = tokens.account_id.filter(|a| !a.is_empty()) {
            request = request.header("chatgpt-account-id", account);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(e) => return failed("codex", &e.to_string()),
        };

        // The body says `{"code":"token_expired"}` — an ordinary expiry, not a revoked session.
        // Codex refreshes on its next run, so this is the same "use it once" state Claude Code
        // reaches, and this app will not spend the CLI's refresh token for it either.
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return failed("codex", reason::STALE);
        }
        if !response.status().is_success() {
            return failed("codex", &format!("HTTP {}", response.status().as_u16()));
        }

        let parsed: UsageResponse = match response.json().await {
            Ok(parsed) => parsed,
            Err(e) => return failed("codex", &e.to_string()),
        };

        let plan = parsed.plan_type.clone();
        ProviderQuota {
            provider: "codex".to_string(),
            limits: tighten(map_windows(parsed)),
            plan,
            error: String::new(),
            fetched_at: now_rfc3339(),
        }
    }

    fn map_windows(parsed: UsageResponse) -> Vec<QuotaLimit> {
        let Some(rate_limit) = parsed.rate_limit else { return Vec::new() };
        [rate_limit.primary_window, rate_limit.secondary_window]
            .into_iter()
            .flatten()
            .map(|window| QuotaLimit {
                kind: kind_for(window.limit_window_seconds).to_string(),
                scope: String::new(),
                used_percent: window.used_percent,
                resets_at: reset_instant(&window),
            })
            .collect()
    }

    /// Names a window by how long it is.
    ///
    /// The payload's own names are positional — a free account's "primary" is a *month*, while a
    /// paid one's is five hours — so labelling off `primary`/`secondary` would put "Current
    /// session" on a thirty-day window. The boundaries are wide because the server's numbers are
    /// round but not exact (a "weekly" window has arrived as slightly under seven days).
    fn kind_for(window_seconds: i64) -> &'static str {
        match window_seconds {
            s if s <= 0 => "model",
            s if s <= 60 * 60 * 24 => "session",
            s if s <= 60 * 60 * 24 * 10 => "weekly",
            _ => "monthly",
        }
    }

    /// The reset instant as RFC 3339.
    ///
    /// `reset_at` is preferred — an absolute instant survives the trip and the cache — with the
    /// relative `reset_after_seconds` as the fallback, resolved against now at the moment of the
    /// read rather than of the render.
    fn reset_instant(window: &Window) -> String {
        if let Some(at) = window.reset_at.filter(|at| *at > 0) {
            if let Some(at) = chrono::DateTime::from_timestamp(at, 0) {
                return at.to_rfc3339();
            }
        }
        match window.reset_after_seconds.filter(|s| *s > 0) {
            Some(seconds) => (chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339(),
            None => String::new(),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A real answer from a free account: one monthly window, no secondary.
        const FREE: &str = r#"{
          "plan_type": "free",
          "rate_limit": {
            "allowed": true,
            "limit_reached": false,
            "primary_window": {"used_percent":0,"limit_window_seconds":2592000,
                               "reset_after_seconds":2592000,"reset_at":1789183766},
            "secondary_window": null
          }
        }"#;

        /// The two-window shape a paid plan reports — five hours and a week.
        const PAID: &str = r#"{
          "plan_type": "plus",
          "rate_limit": {
            "primary_window": {"used_percent":63,"limit_window_seconds":18000,"reset_at":1789183766},
            "secondary_window": {"used_percent":21,"limit_window_seconds":604800,"reset_at":1789583766}
          }
        }"#;

        #[test]
        fn a_free_accounts_primary_window_is_a_month_not_a_session() {
            let limits = tighten(map_windows(serde_json::from_str(FREE).unwrap()));
            assert_eq!(limits.len(), 1);
            // Named by its length, not by being called "primary".
            assert_eq!(limits[0].kind, "monthly");
            assert_eq!(limits[0].used_percent, 0.0);
            assert!(limits[0].resets_at.starts_with("2026-"));
        }

        #[test]
        fn a_paid_accounts_two_windows_are_a_session_and_a_week() {
            let limits = tighten(map_windows(serde_json::from_str(PAID).unwrap()));
            assert_eq!(limits.len(), 2);
            assert_eq!(limits[0].kind, "session");
            assert_eq!(limits[0].used_percent, 63.0);
            assert_eq!(limits[1].kind, "weekly");
            assert_eq!(limits[1].used_percent, 21.0);
        }
    }
}


