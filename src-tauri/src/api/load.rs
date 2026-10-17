//! «Prueba de carga»: one resolved request sent over and over by N concurrent users for a while,
//! measured — throughput, latency percentiles, status codes, errors — and reported twice a second.
//!
//! Like the rest of `api`, a transport: the frontend resolved the request (variables, auth) once,
//! and every user sends exactly that. Pre-request scripts do not run per send — a load test that
//! ran a sandbox per request would be measuring the sandbox.
//!
//! **One client for the whole test**, unlike a single send: users keep their connections alive and
//! reuse them, the way real clients hit a server. Each request is still built afresh by
//! `http::build_request`, so a file body is re-opened and SigV4 is signed again for every send.
//! Digest is refused: its challenge/response doubles every request and measures the handshake.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::Method;
use serde::{Deserialize, Serialize};
use url::Url;

use super::http::{build_client, build_request, transport_error, Phases};
use super::{BackendAuth, HttpSendRequest};

/// The most concurrent users one test may run — a client tool, not a load generator farm.
pub const MAX_USERS: u32 = 500;
/// The longest a test may run.
pub const MAX_DURATION_MS: u64 = 30 * 60 * 1000;
/// How often progress is reported.
const TICK: Duration = Duration::from_millis(500);
/// How long users still sending when the time is up are waited for before they are dropped.
const GRACE: Duration = Duration::from_secs(10);
/// Latencies kept for the percentiles; past this, every other one is let go (a uniform thinning).
const LATENCY_CAP: usize = 400_000;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadPlan {
    pub users: u32,
    pub duration_ms: u64,
    /// Users start spread over this long rather than all at once.
    #[serde(default)]
    pub ramp_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Percentiles {
    pub min: f64,
    pub avg: f64,
    pub p50: f64,
    pub p90: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
}

/// One second of the test, for the charts.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSecond {
    pub second: u64,
    pub requests: u64,
    pub failures: u64,
    pub avg_ms: f64,
    pub p95_ms: f64,
    pub users: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadReport {
    pub elapsed_ms: u64,
    pub finished: bool,
    /// Stopped by the user before its time was up.
    pub stopped: bool,
    pub requests: u64,
    /// Transport errors plus responses with a 4xx/5xx status.
    pub failures: u64,
    pub bytes: u64,
    /// Requests per second over the whole test so far.
    pub rps: f64,
    pub latency: Percentiles,
    /// Status code → how many, in code order.
    pub statuses: Vec<(u16, u64)>,
    /// Transport error → how many, most frequent first.
    pub errors: Vec<(String, u64)>,
    pub series: Vec<LoadSecond>,
    pub active_users: u32,
}

#[derive(Default)]
struct Stats {
    latencies: Vec<f32>,
    thinned: bool,
    statuses: BTreeMap<u16, u64>,
    errors: HashMap<String, u64>,
    requests: u64,
    failures: u64,
    bytes: u64,
    seconds: Vec<Bucket>,
}

#[derive(Default)]
struct Bucket {
    requests: u64,
    failures: u64,
    latencies: Vec<f32>,
    users: u32,
}

impl Stats {
    fn record(&mut self, second: usize, users: u32, latency_ms: f32, outcome: Result<(u16, u64), String>) {
        self.requests += 1;
        let failed = match outcome {
            Ok((status, bytes)) => {
                *self.statuses.entry(status).or_default() += 1;
                self.bytes += bytes;
                status >= 400
            }
            Err(error) => {
                *self.errors.entry(error).or_default() += 1;
                true
            }
        };
        if failed {
            self.failures += 1;
        }
        if self.latencies.len() >= LATENCY_CAP {
            let mut keep = false;
            self.latencies.retain(|_| {
                keep = !keep;
                keep
            });
            self.thinned = true;
        }
        if !self.thinned || self.requests % 2 == 0 {
            self.latencies.push(latency_ms);
        }
        while self.seconds.len() <= second {
            self.seconds.push(Bucket::default());
        }
        let bucket = &mut self.seconds[second];
        bucket.requests += 1;
        bucket.users = bucket.users.max(users);
        if failed {
            bucket.failures += 1;
        }
        bucket.latencies.push(latency_ms);
    }

    fn report(&self, elapsed: Duration, active_users: u32) -> LoadReport {
        let elapsed_ms = elapsed.as_millis() as u64;
        let mut errors: Vec<(String, u64)> = self.errors.iter().map(|(k, v)| (k.clone(), *v)).collect();
        errors.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        LoadReport {
            elapsed_ms,
            finished: false,
            stopped: false,
            requests: self.requests,
            failures: self.failures,
            bytes: self.bytes,
            rps: if elapsed_ms == 0 { 0.0 } else { self.requests as f64 * 1000.0 / elapsed_ms as f64 },
            latency: percentiles(&self.latencies),
            statuses: self.statuses.iter().map(|(k, v)| (*k, *v)).collect(),
            errors,
            series: self
                .seconds
                .iter()
                .enumerate()
                .map(|(second, bucket)| {
                    let p = percentiles(&bucket.latencies);
                    LoadSecond {
                        second: second as u64,
                        requests: bucket.requests,
                        failures: bucket.failures,
                        avg_ms: p.avg,
                        p95_ms: p.p95,
                        users: bucket.users,
                    }
                })
                .collect(),
            active_users,
        }
    }
}

fn percentiles(values: &[f32]) -> Percentiles {
    if values.is_empty() {
        return Percentiles::default();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let at = |q: f64| f64::from(sorted[((sorted.len() as f64 - 1.0) * q).round() as usize]);
    let round = |v: f64| (v * 10.0).round() / 10.0;
    Percentiles {
        min: round(f64::from(sorted[0])),
        avg: round(sorted.iter().map(|v| f64::from(*v)).sum::<f64>() / sorted.len() as f64),
        p50: round(at(0.50)),
        p90: round(at(0.90)),
        p95: round(at(0.95)),
        p99: round(at(0.99)),
        max: round(f64::from(sorted[sorted.len() - 1])),
    }
}

/// Running tests, by id, so `stop` can reach one.
fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// Ends the test `id` early; what it measured so far is its report.
pub fn stop(id: &str) {
    if let Some(flag) = running().lock().ok().and_then(|map| map.get(id).cloned()) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Runs `req` under `plan`, reporting through `on_progress` every [`TICK`]; the final report when
/// the time is up or [`stop`] was called.
pub async fn run(
    id: &str,
    req: HttpSendRequest,
    plan: LoadPlan,
    on_progress: impl Fn(LoadReport) + Send + Sync + 'static,
) -> Result<LoadReport, String> {
    if plan.users == 0 || plan.users > MAX_USERS {
        return Err(format!("Between 1 and {MAX_USERS} users"));
    }
    if plan.duration_ms == 0 || plan.duration_ms > MAX_DURATION_MS {
        return Err(format!("Between 1 ms and {} minutes", MAX_DURATION_MS / 60_000));
    }
    if matches!(req.auth, Some(BackendAuth::Digest { .. })) {
        return Err("Digest authentication cannot be load-tested: each request would be two".into());
    }
    let method = Method::from_bytes(req.method.trim().as_bytes()).map_err(|_| format!("'{}' is not a valid HTTP method", req.method))?;
    let url = Url::parse(&req.url).map_err(|e| format!("'{}' is not a valid URL: {e}", req.url))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{url} is not http or https"));
    }
    let client = build_client(&req.options, &Arc::new(Mutex::new(Vec::new())), &Phases::default())?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = running().lock() {
        map.insert(id.to_string(), stop_flag.clone());
    }
    let report = drive(client, Arc::new(req), method, url, plan, stop_flag.clone(), on_progress).await;
    if let Ok(mut map) = running().lock() {
        map.remove(id);
    }
    Ok(report)
}

async fn drive(
    client: reqwest::Client,
    req: Arc<HttpSendRequest>,
    method: Method,
    url: Url,
    plan: LoadPlan,
    stop: Arc<AtomicBool>,
    on_progress: impl Fn(LoadReport) + Send + Sync + 'static,
) -> LoadReport {
    let started = Instant::now();
    let deadline = Duration::from_millis(plan.duration_ms);
    let stats = Arc::new(Mutex::new(Stats::default()));
    let active = Arc::new(AtomicU32::new(0));

    let mut users = Vec::with_capacity(plan.users as usize);
    for user in 0..plan.users {
        let delay = Duration::from_millis(plan.ramp_ms.min(plan.duration_ms) * u64::from(user) / u64::from(plan.users));
        let (client, req, method, url) = (client.clone(), req.clone(), method.clone(), url.clone());
        let (stats, stop, active) = (stats.clone(), stop.clone(), active.clone());
        users.push(tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if stop.load(Ordering::SeqCst) || started.elapsed() >= deadline {
                return;
            }
            active.fetch_add(1, Ordering::SeqCst);
            while !stop.load(Ordering::SeqCst) && started.elapsed() < deadline {
                let sent = Instant::now();
                let outcome = once(&client, &req, &method, &url).await;
                let latency = sent.elapsed().as_secs_f32() * 1000.0;
                let second = (sent.duration_since(started).as_secs()) as usize;
                let users_now = active.load(Ordering::SeqCst);
                if let Ok(mut stats) = stats.lock() {
                    stats.record(second, users_now, latency, outcome);
                }
            }
            active.fetch_sub(1, Ordering::SeqCst);
        }));
    }

    // Progress until the time is up (or a stop), then the stragglers are given their grace.
    loop {
        tokio::time::sleep(TICK).await;
        let snapshot = stats.lock().map(|s| s.report(started.elapsed(), active.load(Ordering::SeqCst))).unwrap_or_default();
        on_progress(snapshot);
        if stop.load(Ordering::SeqCst) || started.elapsed() >= deadline {
            break;
        }
    }
    let stopped = stop.load(Ordering::SeqCst) && started.elapsed() < deadline;
    stop.store(true, Ordering::SeqCst);
    let joined = futures_util::future::join_all(users.iter_mut());
    if tokio::time::timeout(GRACE, joined).await.is_err() {
        for user in &users {
            user.abort();
        }
    }
    // The rate is over the test's length, not over the grace spent waiting for the last answers.
    let elapsed = started.elapsed().min(deadline.max(Duration::from_millis(1)));
    let mut report = stats.lock().map(|s| s.report(elapsed, 0)).unwrap_or_default();
    report.finished = true;
    report.stopped = stopped;
    on_progress(report.clone());
    report
}

/// One send, read to its end: the status and how many bytes came, or why not.
async fn once(client: &reqwest::Client, req: &HttpSendRequest, method: &Method, url: &Url) -> Result<(u16, u64), String> {
    let built = build_request(client, req, method, url, &[], true).await?;
    let mut response = client.execute(built.request).await.map_err(|e| short_error(&transport_error(method, url, &e)))?;
    let status = response.status().as_u16();
    let mut bytes = 0u64;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => bytes += chunk.len() as u64,
            Ok(None) => break,
            Err(e) => return Err(short_error(&e.to_string())),
        }
    }
    Ok((status, bytes))
}

/// An error's message without the request it is about — the same failure, counted once.
fn short_error(message: &str) -> String {
    let text = message.lines().next().unwrap_or(message);
    let text = text.split_once(": ").map(|(head, tail)| if head.contains("://") { tail } else { text }).unwrap_or(text);
    text.chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::NetworkOptions;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Answers every request on every connection with a 200 (or a 500 for `/fail`).
    async fn serve() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let mut pending = Vec::new();
                    loop {
                        let Ok(read) = socket.read(&mut buf).await else { return };
                        if read == 0 {
                            return;
                        }
                        pending.extend_from_slice(&buf[..read]);
                        while let Some(end) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&pending[..end]).to_string();
                            pending.drain(..end + 4);
                            let status = if head.contains("/fail") { "500 Internal Server Error" } else { "200 OK" };
                            let reply = format!("HTTP/1.1 {status}\r\nContent-Length: 5\r\n\r\nhello");
                            if socket.write_all(reply.as_bytes()).await.is_err() {
                                return;
                            }
                        }
                    }
                });
            }
        });
        port
    }

    fn get(url: String) -> HttpSendRequest {
        HttpSendRequest {
            method: "GET".into(),
            url,
            headers: Vec::new(),
            body_text: None,
            body_base64: None,
            body_file: None,
            form_data: None,
            urlencoded: None,
            auth: None,
            options: NetworkOptions { timeout_ms: 5_000, ..NetworkOptions::default() },
        }
    }

    #[tokio::test]
    async fn users_send_until_the_time_is_up_and_the_report_adds_up() {
        let port = serve().await;
        let ticks = Arc::new(AtomicU32::new(0));
        let seen = ticks.clone();
        let plan = LoadPlan { users: 4, duration_ms: 700, ramp_ms: 0 };
        let report = run("t1", get(format!("http://127.0.0.1:{port}/ok")), plan, move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .unwrap();
        assert!(report.finished && !report.stopped);
        assert!(report.requests > 10, "{report:?}");
        assert_eq!(report.failures, 0);
        assert_eq!(report.statuses, vec![(200, report.requests)]);
        assert_eq!(report.bytes, report.requests * 5);
        assert!(report.latency.p50 <= report.latency.p99 && report.latency.min <= report.latency.max);
        assert_eq!(report.series.iter().map(|s| s.requests).sum::<u64>(), report.requests);
        assert!(ticks.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn error_statuses_and_refused_connections_are_failures() {
        let port = serve().await;
        let plan = LoadPlan { users: 2, duration_ms: 300, ramp_ms: 0 };
        let report = run("t2", get(format!("http://127.0.0.1:{port}/fail")), plan, |_| {}).await.unwrap();
        assert!(report.requests > 0 && report.failures == report.requests);

        // Nothing listens on port 9 here.
        let plan = LoadPlan { users: 1, duration_ms: 200, ramp_ms: 0 };
        let report = run("t3", get("http://127.0.0.1:9/".into()), plan, |_| {}).await.unwrap();
        assert!(report.requests > 0 && report.failures == report.requests && !report.errors.is_empty());
    }

    #[tokio::test]
    async fn a_stop_ends_the_test_early() {
        let port = serve().await;
        let plan = LoadPlan { users: 2, duration_ms: 20_000, ramp_ms: 0 };
        let started = Instant::now();
        let handle = tokio::spawn(run("t4", get(format!("http://127.0.0.1:{port}/ok")), plan, |_| {}));
        tokio::time::sleep(Duration::from_millis(300)).await;
        stop("t4");
        let report = handle.await.unwrap().unwrap();
        assert!(report.stopped && started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn plans_out_of_range_are_refused() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let bad = LoadPlan { users: 0, duration_ms: 1000, ramp_ms: 0 };
        assert!(rt.block_on(run("t5", get("http://127.0.0.1:9/".into()), bad, |_| {})).is_err());
    }
}
