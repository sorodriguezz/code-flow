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
//! The fifth is **Grok Build**, which has no such back end and is read by running its own `/usage`
//! panel in a pseudo-terminal and scraping the frame — see [`grok`], which documents both why every
//! quieter option was ruled out first and why scraping is allowed to come up empty.
//!
//! Everything else is **absent on purpose**, and absence here is a claim this module is willing to
//! make. Ollama runs on the user's own machine and has no plan to be out of; an OpenAI-compatible
//! endpoint on an API key is metered, not capped, so a percentage would be an invention.
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

/// Why a provider has nothing to show. Stable keys, translated in the frontend: the difference
/// between "sign in" and "run it once" is the difference between a broken panel and a panel
/// waiting for something ordinary to happen.
pub mod reason {
    /// The CLI is not signed in on this machine — no credential where it keeps one.
    pub const SIGNED_OUT: &str = "signed_out";
    /// A credential is there but has expired. The CLI refreshes it whenever it runs, and this app
    /// deliberately will not do it on the CLI's behalf, so the way out is to use the engine once.
    pub const STALE: &str = "stale";
}

/// Providers whose back end publishes a plan limit at all. Everything outside this list is absent
/// from the panel entirely rather than shown empty — see the module docs.
pub const QUOTA_PROVIDERS: &[&str] = &["claude", "codex", "gemini", "grok", "opencode"];

/// How long a successful read stays good, for the providers answered by one HTTP request.
///
/// These back ends are rate-limited and none of the numbers moves quickly: a five-hour window
/// shifts by a third of a percent a minute at full tilt. A minute of cache turns a panel left open,
/// a settings screen and a status pill into one request between them.
const FRESH_FOR: Duration = Duration::from_secs(60);

/// How long Grok's reading stays good, which is much longer and has to be.
///
/// Every other provider costs one HTTPS call. Grok costs a **terminal user interface**: a pty, the
/// whole TUI booting inside it, a wait for it to paint, and a Ctrl+C to end it — seconds of work
/// and a real process, for a weekly number that moves by fractions of a percent an hour. Polling
/// that on the minute would spawn Grok sixty times an hour to watch a bar not move.
const GROK_FRESH_FOR: Duration = Duration::from_secs(300);

fn fresh_for(provider: &str) -> Duration {
    match provider {
        "grok" => GROK_FRESH_FOR,
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

fn remember(provider: &str, quota: ProviderQuota) {
    if let Ok(mut guard) = CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(provider.to_string(), (Instant::now(), quota));
    }
}

/// One client for the process, cloned per call — same reasoning as [`crate::ollama::client`]: a
/// fresh `reqwest::Client` per request rebuilds the whole rustls config and throws away the
/// connection pool.
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
pub async fn fetch_all() -> Vec<ProviderQuota> {
    let mut running = Vec::with_capacity(QUOTA_PROVIDERS.len());
    for provider in QUOTA_PROVIDERS {
        running.push(tokio::spawn(fetch(provider)));
    }
    let mut out = Vec::with_capacity(running.len());
    for (provider, handle) in QUOTA_PROVIDERS.iter().zip(running) {
        // A panicked task is reported as a failed provider rather than propagated: the panel is
        // still owed the other engine's numbers.
        out.push(handle.await.unwrap_or_else(|e| failed(provider, &e.to_string())));
    }
    out
}

/// One provider, through the cache.
pub async fn fetch(provider: &str) -> ProviderQuota {
    if let Some((at, hit)) = cached(provider) {
        if at.elapsed() < fresh_for(provider) {
            return hit;
        }
    }

    // The slow one never makes the caller wait. Grok's reading costs a whole TUI booting in a pty,
    // and on an account with nothing to report it costs the full deadline before coming back
    // empty — twenty seconds during which every other provider's numbers were sitting ready and
    // the panel still said "reading". So it refreshes *behind* the answer: this call returns what
    // is already known (usually nothing, the first time) and the next poll finds the fresh value
    // waiting in the cache. Eventually consistent, which a five-minute window can well afford.
    if fresh_for(provider) > FRESH_FOR {
        refresh_detached(provider);
        return cached(provider)
            .map(|(_, previous)| previous)
            .unwrap_or_else(|| pending(provider));
    }

    read_now(provider).await
}

/// A provider that has not answered yet. No limits and no error, so the UI leaves it out entirely
/// rather than showing a row that is about to change — the alternative, a spinner per provider,
/// would be a moving part in a panel that is read at a glance.
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
/// The guard is the point: without it every poll while a twenty-second read is in flight would
/// start another, and a panel left open would have a queue of Grok processes behind it.
fn refresh_detached(provider: &str) {
    static IN_FLIGHT: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

    {
        let Ok(mut guard) = IN_FLIGHT.lock() else { return };
        let running = guard.get_or_insert_with(std::collections::HashSet::new);
        if !running.insert(provider.to_string()) {
            return;
        }
    }

    let provider = provider.to_string();
    tokio::spawn(async move {
        read_now(&provider).await;
        if let Ok(mut guard) = IN_FLIGHT.lock() {
            if let Some(running) = guard.as_mut() {
                running.remove(&provider);
            }
        }
    });
}

/// Reads one provider for real and files the result.
async fn read_now(provider: &str) -> ProviderQuota {
    let fresh = match provider {
        "claude" => claude::quota().await,
        "codex" => codex::quota().await,
        "gemini" => gemini::quota().await,
        "grok" => grok::quota().await,
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
        for quota in super::fetch_all().await {
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

        let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
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
    use super::*;

    /// Google's Code Assist back end, the one `agy` itself calls — its `quota_manager` refreshes
    /// against this RPC.
    const QUOTA_URL: &str = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
    const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

    /// The shapes that make an OAuth client findable inside a binary. Format, not credential:
    /// every Google client id ends with the one, every installed-app secret begins with the other.
    const CLIENT_ID_SUFFIX: &[u8] = b".apps.googleusercontent.com";
    const CLIENT_SECRET_PREFIX: &[u8] = b"GOCSPX-";
    /// Google issues an installed-app secret as its prefix plus exactly this many characters. That
    /// fixed length is the *only* right-hand boundary available — see [`scan`] for why there is no
    /// other one to find.
    const CLIENT_SECRET_BODY: usize = 28;
    /// How far back the walk for a client id will go. Real ones run to about forty-six characters;
    /// this is loose enough never to clip one and tight enough that a long run of alphanumerics in
    /// a neighbouring literal cannot become a candidate hundreds of bytes long.
    const MAX_CLIENT_ID_HEAD: usize = 128;
    /// The longest a Google project number is in practice, and the shortest — the bounds within
    /// which [`harvest`] offers trimmed readings of a digit run it cannot cut unambiguously.
    const PLAUSIBLE_PROJECT_DIGITS: usize = 13;
    const MIN_PROJECT_DIGITS: usize = 11;
    /// A ceiling on how many client/secret combinations are put to Google before giving up. Two
    /// clients and two secrets is four; the rest of the allowance covers a build that ships another
    /// pair or a run that had to be offered trimmed, and it exists so that a scan which somehow
    /// harvested junk cannot turn one refresh into a burst of requests.
    const MAX_ATTEMPTS: usize = 12;

    #[derive(Deserialize)]
    struct TokenFile {
        token: Option<Token>,
    }

    #[derive(Deserialize)]
    struct Token {
        access_token: Option<String>,
        refresh_token: Option<String>,
        /// RFC 3339 with an offset, as the Go CLI writes it.
        expiry: Option<String>,
    }

    #[derive(Deserialize)]
    struct RefreshResponse {
        access_token: Option<String>,
    }

    #[derive(Deserialize)]
    struct QuotaResponse {
        #[serde(default)]
        buckets: Vec<Bucket>,
    }

    #[derive(Deserialize)]
    struct Bucket {
        #[serde(rename = "modelId", default)]
        model_id: String,
        /// How much of this model's allowance is **left**, 0–1 — the opposite direction from the
        /// one this module reports in, so it is inverted on the way through.
        #[serde(rename = "remainingFraction", default)]
        remaining_fraction: f64,
        #[serde(rename = "resetTime", default)]
        reset_time: Option<String>,
    }

    fn token_path() -> Option<std::path::PathBuf> {
        Some(
            dirs::home_dir()?
                .join(".gemini")
                .join("antigravity-cli")
                .join("antigravity-oauth-token"),
        )
    }

    fn stored() -> Option<Token> {
        let raw = std::fs::read_to_string(token_path()?).ok()?;
        serde_json::from_str::<TokenFile>(&raw).ok()?.token
    }

    /// Every OAuth client id and secret `agy` ships, with no claim about which goes with which.
    #[derive(Clone, Default)]
    struct Candidates {
        ids: Vec<String>,
        secrets: Vec<String>,
    }

    /// The scan's result, kept for the life of the process — it is a linear pass over a hundred and
    /// seventy megabytes of CLI, and nothing it reads changes underneath a running app.
    ///
    /// Only success is cached. A failure is usually "Antigravity is not installed", which can stop
    /// being true while this app is open, and re-checking that costs a path lookup.
    static CANDIDATES: Mutex<Option<Candidates>> = Mutex::new(None);

    /// The pair that last worked, so the resolution below happens once rather than every refresh.
    static RESOLVED: Mutex<Option<(String, String)>> = Mutex::new(None);

    /// Antigravity's own installed-app OAuth client, read out of the copy of `agy` on this machine.
    ///
    /// A refresh token is only redeemable by the client it was issued to. The token on disk belongs
    /// to Antigravity, so refreshing it means presenting Antigravity's client — and an "installed
    /// application" client secret is not a secret in the sense that word usually carries: it is
    /// published inside every copy of the CLI, and Google's flow rests on the user's consent, not
    /// on the client's confidentiality, to authorise the call.
    ///
    /// It is *read* rather than written down here. Copying another project's credential into this
    /// repository would republish it from somewhere with no standing to do so and no way to retract
    /// it when Antigravity rotates. Read from the binary it is always exactly as current as the CLI
    /// the user actually runs, and this repository carries none of it.
    async fn candidates() -> Result<Candidates, String> {
        if let Some(known) = CANDIDATES.lock().ok().and_then(|guard| guard.clone()) {
            return Ok(known);
        }

        let binary = crate::ai::find_on_path("agy").ok_or_else(|| reason::SIGNED_OUT.to_string())?;
        // A linear read of a 170 MB file has no business on an async worker.
        let found = tokio::task::spawn_blocking(move || scan(&binary))
            .await
            .map_err(|e| e.to_string())??;

        if found.ids.is_empty() || found.secrets.is_empty() {
            // A build that stores its client somewhere this cannot see. Nothing is invented from
            // that: the provider goes quiet, exactly as it would if the CLI were signed out.
            return Err(reason::SIGNED_OUT.to_string());
        }
        if let Ok(mut guard) = CANDIDATES.lock() {
            *guard = Some(found.clone());
        }
        Ok(found)
    }

    /// Harvests the OAuth clients embedded in `binary`.
    ///
    /// `agy` is a Go program, and a Go binary keeps its string literals in one unseparated blob
    /// addressed by (pointer, length) pairs. There are no terminators to scan for — the two secrets
    /// it ships sit immediately against each other, as one run of characters — and nothing in the
    /// blob ties a secret to the id it belongs with. So each is found by its own fixed shape, and
    /// the two are deliberately *not* paired here: the CLI carries a client for consumer accounts
    /// and one for enterprise, and they cannot be told apart by position. [`access_token`] settles
    /// it by asking Google, the only party that can actually answer.
    fn scan(binary: &std::path::Path) -> Result<Candidates, String> {
        use std::io::Read as _;

        // The binary goes past in windows rather than into memory whole, each overlapping the last
        // by more than the longest thing being looked for so no match can fall down the gap.
        const CHUNK: usize = 4 << 20;
        let overlap = MAX_CLIENT_ID_HEAD + CLIENT_ID_SUFFIX.len();

        let mut file = std::fs::File::open(binary).map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; CHUNK];
        let mut window: Vec<u8> = Vec::with_capacity(CHUNK + overlap);
        let mut found = Candidates::default();

        loop {
            let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            window.extend_from_slice(&buffer[..read]);
            harvest(&window, &mut found);
            let consumed = window.len().saturating_sub(overlap);
            window.drain(..consumed);
        }

        // Overlapping windows see the same match twice, which is the price of not missing one.
        // Deduped in place rather than by sorting, because the order is a preference: the reading
        // [`harvest`] is most confident in is the one it pushed first.
        for list in [&mut found.ids, &mut found.secrets] {
            let mut seen = std::collections::HashSet::new();
            list.retain(|candidate| seen.insert(candidate.clone()));
        }
        Ok(found)
    }

    fn harvest(window: &[u8], found: &mut Candidates) {
        for at in occurrences(window, CLIENT_ID_SUFFIX) {
            // There is no left-hand delimiter, so walking back to the first character that cannot
            // belong to a client id runs straight into whatever literal precedes it — in a real
            // `agy` the id sits against the tail of an unrelated sentence. What bounds it instead
            // is the id's own shape, `<project number>-<random>`: find the separator, then take
            // only the digits in front of it.
            let floor = at.saturating_sub(MAX_CLIENT_ID_HEAD);
            let mut run = at;
            while run > floor && is_client_char(window[run - 1]) {
                run -= 1;
            }
            // The random half is alphanumeric, so the last dash in the run is the separator.
            let Some(dash) = window[run..at].iter().rposition(|byte| *byte == b'-').map(|at| run + at)
            else {
                continue;
            };
            let mut start = dash;
            while start > run && window[start - 1].is_ascii_digit() {
                start -= 1;
            }
            // Both halves have to be there: a dash with no project number in front of it, or none
            // with nothing behind it, is some other string come to rest against the suffix.
            if start == dash || dash + 1 == at {
                continue;
            }
            let Ok(text) = std::str::from_utf8(&window[start..at + CLIENT_ID_SUFFIX.len()]) else {
                continue;
            };
            found.ids.push(text.to_string());

            // The one ambiguity this cannot read its way out of: when the literal in front happens
            // to *end* in digits, they are indistinguishable from the project number and come along
            // with it. A run too long to be a project number is therefore also offered trimmed —
            // one of the variants is the real client, and Google says which.
            let digits = dash - start;
            if digits > PLAUSIBLE_PROJECT_DIGITS {
                for length in (MIN_PROJECT_DIGITS..=PLAUSIBLE_PROJECT_DIGITS).rev() {
                    if let Ok(text) = std::str::from_utf8(&window[dash - length..at + CLIENT_ID_SUFFIX.len()]) {
                        found.ids.push(text.to_string());
                    }
                }
            }
        }

        for at in occurrences(window, CLIENT_SECRET_PREFIX) {
            let from = at + CLIENT_SECRET_PREFIX.len();
            let Some(body) = window.get(from..from + CLIENT_SECRET_BODY) else {
                continue;
            };
            if !body.iter().copied().all(is_client_char) {
                continue;
            }
            if let Ok(text) = std::str::from_utf8(&window[at..from + CLIENT_SECRET_BODY]) {
                found.secrets.push(text.to_string());
            }
        }
    }

    fn occurrences(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
        if haystack.len() < needle.len() {
            return Vec::new();
        }
        haystack
            .windows(needle.len())
            .enumerate()
            .filter(|(_, candidate)| *candidate == needle)
            .map(|(at, _)| at)
            .collect()
    }

    fn is_client_char(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
    }

    /// A usable access token, refreshing when the stored one has aged out.
    ///
    /// Refreshing here is safe in a way it is not for Claude Code: Google's installed-app flow
    /// hands back a new access token and leaves the refresh token alone, so nothing the CLI holds
    /// is invalidated by asking. It has to happen almost every time regardless — `agy`'s access
    /// tokens last an hour, which is shorter than the gap between two sessions of anything.
    ///
    /// The refreshed token is kept **in memory only**. Writing it back into the CLI's file would
    /// mean this app owning a credential it merely borrowed, and the cache above already keeps the
    /// request rate low enough that re-refreshing costs nothing worth saving.
    async fn access_token() -> Result<String, String> {
        let token = stored().ok_or_else(|| reason::SIGNED_OUT.to_string())?;

        let still_valid = token
            .expiry
            .as_deref()
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
            .is_some_and(|at| at > chrono::Utc::now());
        if still_valid {
            if let Some(access) = token.access_token.filter(|t| !t.is_empty()) {
                return Ok(access);
            }
        }

        let refresh = token
            .refresh_token
            .filter(|t| !t.is_empty())
            .ok_or_else(|| reason::SIGNED_OUT.to_string())?;

        // The pair that worked last time first, after which this costs one request like every other
        // provider here. It is retried from scratch if it stops working, because the CLI can be
        // updated — and its client changed — under a running app.
        if let Some((id, secret)) = RESOLVED.lock().ok().and_then(|guard| guard.clone()) {
            if let Some(access) = refresh_with(&id, &secret, &refresh).await? {
                return Ok(access);
            }
            if let Ok(mut guard) = RESOLVED.lock() {
                *guard = None;
            }
        }

        let candidates = candidates().await?;
        let mut pairs: Vec<(String, String)> = Vec::new();
        for id in &candidates.ids {
            for secret in &candidates.secrets {
                pairs.push((id.clone(), secret.clone()));
            }
        }
        pairs.truncate(MAX_ATTEMPTS);

        for (id, secret) in pairs {
            let Some(access) = refresh_with(&id, &secret, &refresh).await? else {
                continue;
            };
            if let Ok(mut guard) = RESOLVED.lock() {
                *guard = Some((id, secret));
            }
            return Ok(access);
        }

        // Every client the CLI ships was refused. Either this refresh token was issued by none of
        // them or the CLI's own session is gone — and both end the same way, with `agy` having to
        // sign in again.
        Err(reason::SIGNED_OUT.to_string())
    }

    /// One refresh attempt as one client. `Ok(None)` is Google declining this client — the next
    /// pair gets a turn; `Err` is the request never landing, which no other pair would survive
    /// either and so ends the search.
    async fn refresh_with(
        client_id: &str,
        client_secret: &str,
        refresh: &str,
    ) -> Result<Option<String>, String> {
        let response = client()
            .post(TOKEN_URL)
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("refresh_token", refresh),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Ok(None);
        }

        Ok(response
            .json::<RefreshResponse>()
            .await
            .map_err(|e| e.to_string())?
            .access_token
            .filter(|t| !t.is_empty()))
    }

    pub async fn quota() -> ProviderQuota {
        let token = match access_token().await {
            Ok(token) => token,
            Err(e) => return failed("gemini", &e),
        };

        let response = client()
            .post(QUOTA_URL)
            .bearer_auth(&token)
            .json(&serde_json::json!({}))
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            Err(e) => return failed("gemini", &e.to_string()),
        };
        if !response.status().is_success() {
            return failed("gemini", &format!("HTTP {}", response.status().as_u16()));
        }

        let parsed: QuotaResponse = match response.json().await {
            Ok(parsed) => parsed,
            Err(e) => return failed("gemini", &e.to_string()),
        };

        // An empty `buckets` is not an error and not a zero: it is this account having no
        // per-model allowance to report. Saying so as [`reason::STALE`] would be wrong, so it
        // comes back as a provider with no limits and no error, which the UI omits entirely.
        ProviderQuota {
            provider: "gemini".to_string(),
            limits: tighten(map_buckets(parsed)),
            plan: String::new(),
            error: String::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// Google's `buckets[]` in this module's terms: a remaining fraction becomes a used percentage.
    fn map_buckets(parsed: QuotaResponse) -> Vec<QuotaLimit> {
        parsed
            .buckets
            .into_iter()
            // A bucket with no model is a row with nothing to label it — the model id *is* its
            // name, since these windows have no other identity.
            .filter(|bucket| !bucket.model_id.is_empty())
            .map(|bucket| QuotaLimit {
                kind: "model".to_string(),
                scope: bucket.model_id,
                used_percent: (1.0 - bucket.remaining_fraction) * 100.0,
                resets_at: bucket.reset_time.unwrap_or_default(),
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A real `v1internal:retrieveUserQuota` answer, with one bucket edited to a partial
        /// fraction — a full account reports every bucket at 1.0 and would not exercise the maths.
        const REAL: &str = r#"{
          "buckets": [
            {"resetTime":"2026-08-14T02:41:25Z","tokenType":"REQUESTS",
             "modelId":"gemini-2.5-flash","remainingFraction":1},
            {"resetTime":"2026-08-14T02:41:25Z","tokenType":"REQUESTS",
             "modelId":"gemini-2.5-pro","remainingFraction":0.125},
            {"resetTime":"2026-08-14T02:41:25Z","tokenType":"REQUESTS","remainingFraction":0.5}
          ]
        }"#;

        #[test]
        fn a_remaining_fraction_becomes_a_percentage_used() {
            let limits = tighten(map_buckets(serde_json::from_str(REAL).unwrap()));
            // The unnamed bucket is dropped, so two survive — fullest first.
            assert_eq!(limits.len(), 2);
            assert_eq!(limits[0].scope, "gemini-2.5-pro");
            assert_eq!(limits[0].kind, "model");
            assert_eq!(limits[0].used_percent, 87.5);
            assert_eq!(limits[1].scope, "gemini-2.5-flash");
            assert_eq!(limits[1].used_percent, 0.0);
        }

        /// Fixtures are built from the constants under test rather than pasted in. That keeps the
        /// shapes and the assertions from drifting apart — and means this file holds no string
        /// that looks like somebody's credential.
        fn fake_secret(body: &str) -> String {
            assert_eq!(body.len(), CLIENT_SECRET_BODY);
            format!("{}{body}", String::from_utf8_lossy(CLIENT_SECRET_PREFIX))
        }

        fn fake_id(project: &str, random: &str) -> String {
            format!("{project}-{random}{}", String::from_utf8_lossy(CLIENT_ID_SUFFIX))
        }

        /// A Go binary's string blob: literals packed end to end with nothing between them.
        fn blob(parts: &[&str]) -> Vec<u8> {
            parts.concat().into_bytes()
        }

        #[test]
        fn finds_both_clients_in_an_unseparated_blob() {
            let first = fake_id("1071006060591", "tmhssin2h21lcre235vtolojh4g403ep");
            let second = fake_id("884354919052", "36trc1jjb3tguiac32ov6cod268c5blh");
            let raw = blob(&[
                "runtime.Goexit called in a thread",
                &first,
                "[AuthProvider] SetUserTier called with",
                &second,
                "Warning: Shell profile target %s exists",
            ]);

            let mut found = Candidates::default();
            harvest(&raw, &mut found);

            assert_eq!(found.ids, vec![first, second]);
        }

        /// The reason the secret's length is a constant: `agy` stores its two secrets against each
        /// other, so the end of the first is only findable by counting.
        #[test]
        fn splits_two_secrets_stored_back_to_back() {
            let first = fake_secret("K00XXX000XxXX0xXX0xXX0x0XXXX");
            let second = fake_secret("0XXXxX0XXXX0000XXxj-XxXXxX0Z");
            let raw = blob(&["https://auth.cloud.google/authorize", &first, &second, "https://x"]);

            let mut found = Candidates::default();
            harvest(&raw, &mut found);

            assert_eq!(found.secrets, vec![first, second]);
        }

        #[test]
        fn a_suffix_without_a_client_id_in_front_of_it_is_not_one() {
            // A bare mention of the domain, then one carrying a head with no leading project
            // number — neither is a client id.
            let suffix = String::from_utf8_lossy(CLIENT_ID_SUFFIX).into_owned();
            let raw = blob(&["see ", &suffix, " for details, or not-a-project", &suffix]);

            let mut found = Candidates::default();
            harvest(&raw, &mut found);

            assert!(found.ids.is_empty());
        }

        /// The neighbouring literal ends in digits, so the project number cannot be cut with
        /// certainty — every plausible reading is offered, the real one among them.
        #[test]
        fn a_digit_run_too_long_to_be_a_project_number_is_also_offered_trimmed() {
            let real = fake_id("1071006060591", "tmhssin2h21lcre235vtolojh4g403ep");
            let raw = blob(&["heap arena is 4096", &real]);

            let mut found = Candidates::default();
            harvest(&raw, &mut found);

            assert_eq!(found.ids[0], format!("4096{real}"));
            assert!(found.ids.contains(&real), "the real client id is among the readings");
        }

        #[test]
        fn a_truncated_secret_at_the_end_of_a_window_is_not_harvested() {
            let whole = fake_secret("K00XXX000XxXX0xXX0xXX0x0XXXX");
            let clipped = &whole[..whole.len() - 1];

            let mut found = Candidates::default();
            harvest(clipped.as_bytes(), &mut found);

            // It is the overlap between windows that gets it, on the next pass, whole.
            assert!(found.secrets.is_empty());
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
        // without the subscription. Same answer as having no key: this provider has no windows,
        // rather than having windows it cannot read.
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            return silent();
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

    fn auth_path() -> Option<std::path::PathBuf> {
        Some(dirs::home_dir()?.join(".codex").join("auth.json"))
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

// ---------------------------------------------------------------------------------------------
// Grok Build
// ---------------------------------------------------------------------------------------------

mod grok {
    //! The odd one out: Grok publishes no quota an HTTP client can ask for, so this reads the one
    //! surface that does have it — its own `/usage` panel — by running the TUI in a pseudo-terminal
    //! and scraping what it paints. The approach is borrowed from `sammwyy/orquester`, which solved
    //! the same problem the same way.
    //!
    //! **Everything else was ruled out first**, on a signed-in account: no quota route in the
    //! binary (only a billing *web* link), OIDC discovery with nothing past the standard endpoints,
    //! `cli-chat-proxy.grok.com/v1/{usage,quota,limits,rate_limits,me,subscription,account}` all
    //! 404 with a valid token, `/v1/models` 200 with no rate-limit headers, and — the one that
    //! settles it — `grok -p --output-format json` reporting `usage` and `total_cost_usd` with no
    //! limit field at all. Since this app drives Grok as a subprocess, even rate-limit headers on
    //! the wire would never reach it. The TUI is the only place the number exists.
    //!
    //! **It is scraping, and it is treated as such.** No recognised line means no rows, never a
    //! zero: on an account without a paid plan `/usage` paints an upgrade offer, and inventing
    //! "0% used" from that would be a fabricated limit. When Grok changes the wording this goes
    //! quiet, which is the correct failure for a screen-scraper to have.

    use super::*;

    /// How long to let the TUI run before giving up. It has to boot, authenticate and paint; the
    /// stop pattern below normally ends it in two or three seconds. This is the backstop for a
    /// build that paints something neither pattern recognises — and it is also, on quit, how long
    /// a read already in flight can hold the process, which is why it is not generous.
    const DEADLINE: Duration = Duration::from_secs(15);
    /// Enough to hold the painted frame. A TUI repaints constantly, so this keeps the *newest*
    /// bytes and drops the oldest — the last frame is the one that has the numbers.
    const MAX_OUTPUT: usize = 96_000;

    pub async fn quota() -> ProviderQuota {
        let Some(binary) = crate::ai::find_on_path("grok") else {
            return silent();
        };

        // A pty, a whole TUI and a blocking read loop have no business on an async worker.
        let output = match tokio::task::spawn_blocking(move || capture(&binary)).await {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => return failed("grok", &e),
            Err(e) => return failed("grok", &e.to_string()),
        };

        let limits = parse(&strip_ansi(&output));
        if limits.is_empty() {
            // Nothing recognisable. Overwhelmingly this is an account with no paid plan, where
            // `/usage` paints an upsell rather than a limit — not a failure worth explaining, and
            // certainly not a zero.
            return silent();
        }

        ProviderQuota {
            provider: "grok".to_string(),
            limits: tighten(limits),
            plan: String::new(),
            error: String::new(),
            fetched_at: now_rfc3339(),
        }
    }

    fn silent() -> ProviderQuota {
        ProviderQuota {
            provider: "grok".to_string(),
            limits: Vec::new(),
            plan: String::new(),
            error: String::new(),
            fetched_at: now_rfc3339(),
        }
    }

    /// Runs `grok --minimal /usage` in a pty and returns what it painted.
    ///
    /// **The pty must be given a real size.** This is not a detail: a pty created at the default
    /// 0×0 leaves the TUI with no room to draw, so it boots, emits its terminal-setup escapes and
    /// then paints precisely nothing, for ever — which reads exactly like a hang. 40×120 is enough
    /// for the usage panel to fit on one screen without wrapping the numbers.
    ///
    /// `--minimal` renders into normal scrollback instead of the alternate screen, so the frame
    /// survives in the captured bytes rather than being addressed away by cursor moves.
    fn capture(binary: &std::path::Path) -> Result<String, String> {
        use std::io::Read as _;

        let pty = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        let mut command = portable_pty::CommandBuilder::new(binary);
        command.arg("--minimal");
        command.arg("/usage");
        // Without this the CLI cannot tell it is on a terminal that understands colour, and some
        // builds fall back to a layout this parser has never seen.
        command.env("TERM", "xterm-256color");

        let mut child = pty.slave.spawn_command(command).map_err(|e| e.to_string())?;
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pty.master.take_writer().map_err(|e| e.to_string())?;

        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(read) = reader.read(&mut chunk) {
                if read == 0 || tx.send(chunk[..read].to_vec()).is_err() {
                    break;
                }
            }
        });

        let stop = stop_pattern();
        let mut output: Vec<u8> = Vec::new();
        let deadline = Instant::now() + DEADLINE;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let Ok(chunk) = rx.recv_timeout(remaining) else { break };
            output.extend_from_slice(&chunk);
            if output.len() > MAX_OUTPUT {
                let excess = output.len() - MAX_OUTPUT;
                output.drain(0..excess);
            }
            if stop.is_match(&String::from_utf8_lossy(&output)) {
                // Let the frame finish painting before pulling the rug: the percentage and its
                // reset label are often on separate lines of the same repaint.
                std::thread::sleep(Duration::from_millis(400));
                while let Ok(chunk) = rx.try_recv() {
                    output.extend_from_slice(&chunk);
                }
                break;
            }
        }

        // Ctrl+C rather than a kill, so the TUI restores the terminal it thinks it owns and exits
        // on its own; the kill is the backstop for when it does not.
        use std::io::Write as _;
        let _ = writer.write_all(b"\x03");
        std::thread::sleep(Duration::from_millis(200));
        let _ = child.kill();
        let _ = child.wait();

        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    /// What tells us there is nothing more to wait for.
    ///
    /// Two ways that happens, and recognising the second is worth as much as the first. Either the
    /// usage panel painted — *then* stop, having got what we came for — or the account has no paid
    /// plan and Grok painted its upgrade modal instead, in which case waiting out the deadline is
    /// fifteen seconds spent confirming an answer already on screen.
    ///
    /// The upsell pattern is the modal's own heading and not merely the word "upgrade": a paid
    /// account still carries a `[Click here to Upgrade]` chip in its status bar, and matching that
    /// would abandon the read before the numbers arrived.
    fn stop_pattern() -> &'static regex::Regex {
        static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        PATTERN.get_or_init(|| {
            regex::Regex::new(
                r"(?i)(next reset|current week|weekly limit|% used|unlock all features)",
            )
            .unwrap()
        })
    }

    /// Removes the escape sequences a TUI is mostly made of, leaving the text it painted.
    ///
    /// Order matters: OSC (`ESC ] … BEL`/`ST`) and DCS (`ESC P … ST`) carry their own terminators
    /// and have to go before the CSI sweep, or the sweep eats their opening and leaves the payload
    /// — window titles and colour reports — sitting in the text as if it had been printed.
    fn strip_ansi(raw: &str) -> String {
        static OSC: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static DCS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static CSI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static CHARSET: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let osc = OSC.get_or_init(|| regex::Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap());
        let dcs = DCS.get_or_init(|| regex::Regex::new(r"\x1bP[^\x1b]*\x1b\\").unwrap());
        let csi = CSI.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;?<>!]*[a-zA-Z]").unwrap());
        let charset = CHARSET.get_or_init(|| regex::Regex::new(r"\x1b[()][B0]").unwrap());

        let text = osc.replace_all(raw, "");
        let text = dcs.replace_all(&text, "");
        let text = csi.replace_all(&text, "");
        let text = charset.replace_all(&text, "");
        text.chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .collect()
    }

    /// Pulls the weekly window out of the painted panel.
    ///
    /// Two shapes, because the CLI has used both: `Current week: N% used · resets <when>` carries
    /// its own reset label, while a bare `Weekly limit: N%` does not and takes the `Next reset:`
    /// line near it. Anything else is ignored rather than guessed at.
    fn parse(clean: &str) -> Vec<QuotaLimit> {
        static CURRENT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static WEEKLY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static RESET: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let current = CURRENT.get_or_init(|| {
            regex::Regex::new(
                r"(?i)current week(?:\s*\([^)]*\))?\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used\s*[·\-–]\s*resets?\s+([^\n│┃|]+)",
            )
            .unwrap()
        });
        let weekly =
            WEEKLY.get_or_init(|| regex::Regex::new(r"(?i)weekly limit\s*:\s*(\d+(?:\.\d+)?)\s*%").unwrap());
        let reset = RESET
            .get_or_init(|| regex::Regex::new(r"(?i)next reset\s*:\s*([^\n│┃|]+)").unwrap());

        let mut limits: Vec<QuotaLimit> = Vec::new();
        let mut pending_reset: Option<String> = None;

        for line in clean.lines() {
            let line_reset = reset.captures(line).map(|c| c[1].trim().to_string());

            let found = current
                .captures(line)
                .map(|c| {
                    (
                        c[1].parse::<f64>().unwrap_or(0.0),
                        Some(c[2].trim().to_string()),
                    )
                })
                .or_else(|| {
                    weekly.captures(line).map(|c| {
                        (
                            c[1].parse::<f64>().unwrap_or(0.0),
                            line_reset.clone().or_else(|| pending_reset.clone()),
                        )
                    })
                });

            if let Some((used, label)) = found {
                limits.push(QuotaLimit {
                    kind: "weekly".to_string(),
                    scope: String::new(),
                    used_percent: used,
                    resets_at: label.as_deref().and_then(reset_instant).unwrap_or_default(),
                });
                pending_reset = None;
                continue;
            }

            if let Some(label) = line_reset {
                // A reset line can arrive *after* the percentage it belongs to, so it back-fills
                // the row above when that row still has no instant.
                if let Some(last) = limits.last_mut() {
                    if last.resets_at.is_empty() {
                        last.resets_at = reset_instant(&label).unwrap_or_default();
                    }
                }
                pending_reset = Some(label);
            }
        }

        limits
    }

    /// Turns Grok's reset label into an RFC 3339 instant.
    ///
    /// Two forms, both seen in the wild. `Mon D, H:MM` is an absolute local time with **no year**
    /// — the current one is assumed, and a label that lands in the past is rolled forward a year so
    /// a reset on 2 January read on 31 December is not reported as eleven months ago. `in 2d 17h
    /// 49m` is relative and resolved against now.
    fn reset_instant(label: &str) -> Option<String> {
        use chrono::{Datelike, TimeZone};

        static ABSOLUTE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        static RELATIVE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let absolute = ABSOLUTE.get_or_init(|| {
            regex::Regex::new(r"(?i)^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})").unwrap()
        });
        let relative = RELATIVE.get_or_init(|| {
            regex::Regex::new(r"(?i)(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?").unwrap()
        });

        let label = label.trim();

        if let Some(captures) = absolute.captures(label) {
            const MONTHS: [&str; 12] = [
                "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
            ];
            let wanted = captures[1].to_lowercase();
            let month = MONTHS.iter().position(|m| wanted.starts_with(m))? as u32 + 1;
            let day: u32 = captures[2].parse().ok()?;
            let hour: u32 = captures[3].parse().ok()?;
            let minute: u32 = captures[4].parse().ok()?;

            let now = chrono::Local::now();
            for year in [now.year(), now.year() + 1] {
                let naive = chrono::NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, 0)?;
                // The label carries no zone, and the CLI prints it for the person reading the
                // terminal — so it is local time, and is converted rather than assumed to be UTC.
                let Some(local) = chrono::Local.from_local_datetime(&naive).single() else { continue };
                if local >= now - chrono::Duration::hours(1) {
                    return Some(local.to_utc().to_rfc3339());
                }
            }
            return None;
        }

        // Relative: only accept it when the label actually said "in", so a stray number elsewhere
        // on the line cannot be read as a countdown.
        let rest = label.strip_prefix("in ").or_else(|| label.strip_prefix("In "))?;
        let captures = relative.captures(rest)?;
        let part = |i: usize| -> i64 { captures.get(i).and_then(|m| m.as_str().parse().ok()).unwrap_or(0) };
        let (days, hours, minutes) = (part(1), part(2), part(3));
        if days == 0 && hours == 0 && minutes == 0 {
            return None;
        }
        let at = chrono::Utc::now()
            + chrono::Duration::days(days)
            + chrono::Duration::hours(hours)
            + chrono::Duration::minutes(minutes);
        Some(at.to_rfc3339())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn strips_the_escapes_a_tui_is_made_of() {
            let raw = "\x1b]0;grok\x07\x1b[?25l\x1bP>|xterm\x1b\\\x1b[1;1HWeekly limit: 42%\x1b[0m";
            assert_eq!(strip_ansi(raw), "Weekly limit: 42%");
        }

        #[test]
        fn reads_a_weekly_limit_with_its_own_reset() {
            let limits = parse("  Current week: 35% used · resets Aug 17, 13:00\n");
            assert_eq!(limits.len(), 1);
            assert_eq!(limits[0].kind, "weekly");
            assert_eq!(limits[0].used_percent, 35.0);
            assert!(!limits[0].resets_at.is_empty());
        }

        /// The bare form takes the `Next reset:` line beside it, whichever side it lands on.
        #[test]
        fn a_bare_weekly_limit_borrows_the_reset_line() {
            let after = parse("Weekly limit: 8%\nNext reset: Aug 17, 13:00\n");
            assert_eq!(after.len(), 1);
            assert!(!after[0].resets_at.is_empty());

            let before = parse("Next reset: Aug 17, 13:00\nWeekly limit: 8%\n");
            assert_eq!(before.len(), 1);
            assert_eq!(before[0].used_percent, 8.0);
            assert!(!before[0].resets_at.is_empty());
        }

        /// What an account with no paid plan actually paints: an upsell. It must produce no rows —
        /// a "0% used" invented from this would be a limit that does not exist.
        #[test]
        fn an_upgrade_panel_is_not_a_limit() {
            let upsell = "Unlock all features with SuperGrok.\n\
                          1 (o) Upgrade to SuperGrok        For everyday coding tasks\n\
                          2 (o) Upgrade to SuperGrok Heavy  Highest usage limits.\n";
            assert!(parse(upsell).is_empty());
        }

        #[test]
        fn a_relative_reset_label_resolves_against_now() {
            let at = reset_instant("in 2d 17h 49m").expect("relative label");
            let parsed = chrono::DateTime::parse_from_rfc3339(&at).unwrap();
            let hours = (parsed.to_utc() - chrono::Utc::now()).num_hours();
            assert!((64..=66).contains(&hours), "expected ~65h, got {hours}");
        }

        #[test]
        fn a_label_with_no_recognisable_time_is_no_instant() {
            assert!(reset_instant("soon").is_none());
            assert!(reset_instant("in a while").is_none());
        }
    }
}

