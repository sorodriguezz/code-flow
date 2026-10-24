//! The third `llama-server` slot: embeddings for the knowledge index (`crate::knowledge`).
//!
//! Same lifecycle as the executor — started on first use, one process, a pidfile, retired after a
//! short idle — and the same rule as everything local: the text never leaves the machine. Started
//! with `--embedding` and the pooling its model was trained with; asked on `/v1/embeddings`.
//!
//! Two small Apache-2.0 models, downloaded on demand like every other weight (sizes and digests
//! from the Hugging Face API, 2026-10-19). Each says how queries and documents must be prefixed:
//! an embedding model trained with instructions answers worse without them.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;

use super::catalogue::{ModelSpec, Tier};
use super::engine;

/// One downloadable embedding model.
#[derive(Clone, Copy, Debug)]
pub struct EmbedModelSpec {
    pub spec: ModelSpec,
    pub dims: usize,
    /// `--pooling`: `last` for decoder-style embedders (Qwen3-Embedding), `mean` for BERT-style.
    pub pooling: &'static str,
    /// Put before a search query. The model card's own wording.
    pub query_prefix: &'static str,
    /// Put before a document chunk.
    pub doc_prefix: &'static str,
    /// The context (and batch) the server is started with — a chunk is far shorter, and every token
    /// of batch is GPU memory taken from the executor beside it.
    pub ctx: u32,
    /// Texts are cut to this many characters before they are sent (`0`: as they are) — for a model
    /// trained on shorter inputs than a chunk can be (Nomic v2: 512 tokens).
    pub max_chars: usize,
}

pub const EMBED_CATALOGUE: &[EmbedModelSpec] = &[
    EmbedModelSpec {
        spec: ModelSpec {
            id: "nomic-embed-text-v1.5",
            label: "Nomic Embed Text v1.5",
            tier: Tier::Light,
            repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
            file: "nomic-embed-text-v1.5.Q8_0.gguf",
            size_bytes: 146_146_432,
            sha256: "3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7",
            params: "137M · Q8_0",
            min_ram_gb: 1,
            licence: "Apache-2.0",
        },
        dims: 768,
        pooling: "mean",
        query_prefix: "search_query: ",
        doc_prefix: "search_document: ",
        ctx: 2_048,
        max_chars: 0,
    },
    EmbedModelSpec {
        spec: ModelSpec {
            id: "qwen3-embedding-0.6b",
            label: "Qwen3 Embedding 0.6B",
            tier: Tier::Light,
            repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
            file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
            size_bytes: 639_150_592,
            sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
            params: "0.6B · Q8_0",
            min_ram_gb: 2,
            licence: "Apache-2.0",
        },
        dims: 1024,
        pooling: "last",
        query_prefix: "Instruct: Given a question about a software project, retrieve the passages of its code and documentation that answer it\nQuery: ",
        doc_prefix: "",
        // A chunk is at most ~1,600 characters (~500 tokens): a 2k window holds it with its prefix,
        // and keeps the compute buffers small enough to sit beside the executor on a 16 GB Mac — at
        // 8k, both on the GPU together failed with "Compute error" (measured 2026-10-19).
        ctx: 2_048,
        max_chars: 0,
    },
    // Added 2026-10-23 (the user: «implementa todo» of the three proposed). Sizes and hashes from the
    // Hugging Face API (`/api/models/<repo>/tree/main`, the LFS `oid` is the SHA-256).
    //
    // Nomic v2: the multilingual successor of v1.5 at a similar cost — ~100 languages, a MoE of 475M
    // with 305M active. GGUF from ggml-org, llama.cpp's own organisation. Same prefixes as v1.5. Its
    // training length is 512 tokens, so a chunk is cut to 1,200 characters (~400 tokens of Spanish
    // prose) rather than read past what it learned on.
    EmbedModelSpec {
        spec: ModelSpec {
            id: "nomic-embed-text-v2-moe",
            label: "Nomic Embed Text v2",
            tier: Tier::Light,
            repo: "ggml-org/Nomic-Embed-Text-V2-GGUF",
            file: "nomic-embed-text-v2-moe-q8_0.gguf",
            size_bytes: 512_225_120,
            sha256: "36c5817bc25f379e62021f49efde05b10ed3b0c93ab8059c43173a7a5de73565",
            params: "475M MoE · Q8_0",
            min_ram_gb: 2,
            licence: "Apache-2.0",
        },
        dims: 768,
        pooling: "mean",
        query_prefix: "search_query: ",
        doc_prefix: "search_document: ",
        ctx: 2_048,
        max_chars: 1_200,
    },
    // Harrier OSS v1 0.6B (Microsoft, April 2026): Qwen3's architecture and prompt format, ahead of
    // Qwen3 0.6B on multilingual retrieval at the same size. Microsoft publishes no GGUF; this is a
    // community conversion of its weights, pinned to the exact file by hash — a different file is
    // refused, so what is downloaded is what was checked.
    EmbedModelSpec {
        spec: ModelSpec {
            id: "harrier-oss-v1-0.6b",
            label: "Harrier OSS v1 0.6B",
            tier: Tier::Light,
            repo: "SuperPauly/harrier-oss-v1-0.6b-gguf",
            file: "harrier-oss-v1-0.6B-Q8_0.gguf",
            size_bytes: 639_447_872,
            sha256: "f97092bd73f6814b8b1170ca855071bc468b5fa2cf61a6de7e1d2c4a8a6a50b0",
            params: "0.6B · Q8_0",
            min_ram_gb: 2,
            licence: "MIT",
        },
        dims: 1024,
        pooling: "last",
        query_prefix: "Instruct: Given a question about a software project, retrieve the passages of its code and documentation that answer it\nQuery: ",
        doc_prefix: "",
        ctx: 2_048,
        max_chars: 0,
    },
    // Qwen3 Embedding 4B: the step up in quality, for 16 GB machines and up. Q4_K_M keeps it at
    // 2.5 GB; vectors are 2,560 numbers (an index of ~9,000 prose chunks is ~90 MB of them).
    EmbedModelSpec {
        spec: ModelSpec {
            id: "qwen3-embedding-4b",
            label: "Qwen3 Embedding 4B",
            tier: Tier::Large,
            repo: "Qwen/Qwen3-Embedding-4B-GGUF",
            file: "Qwen3-Embedding-4B-Q4_K_M.gguf",
            size_bytes: 2_496_703_776,
            sha256: "2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b",
            params: "4B · Q4_K_M",
            min_ram_gb: 12,
            licence: "Apache-2.0",
        },
        dims: 2560,
        pooling: "last",
        query_prefix: "Instruct: Given a question about a software project, retrieve the passages of its code and documentation that answer it\nQuery: ",
        doc_prefix: "",
        ctx: 2_048,
        max_chars: 0,
    },
];

/// The model used when none is chosen: the better of the two, still well under a gigabyte.
pub const DEFAULT_EMBED_MODEL_ID: &str = "qwen3-embedding-0.6b";

pub fn find(id: &str) -> Option<&'static EmbedModelSpec> {
    EMBED_CATALOGUE.iter().find(|entry| entry.spec.id == id)
}

const START_BUDGET: Duration = Duration::from_secs(120);
const HEALTH_POLL: Duration = Duration::from_millis(250);
/// Embedding comes in bursts (an indexing pass, a query); between them the memory goes back.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const REAP_INTERVAL: Duration = Duration::from_secs(30);

pub struct Embedder {
    pub model_id: String,
    port: u16,
    client: reqwest::Client,
    child: Mutex<tokio::process::Child>,
    alive: Arc<AtomicBool>,
    last_used: Arc<AtomicU64>,
    in_flight: Arc<AtomicUsize>,
    diagnostics: Arc<Mutex<Vec<String>>>,
}

static SLOT: OnceLock<AsyncMutex<Option<Arc<Embedder>>>> = OnceLock::new();

/// Texts per request: enough to amortise the call, small enough that one request never holds the
/// server for long.
pub const BATCH: usize = 32;

impl Embedder {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Vectors for `texts`, in order. The caller has already added the model's prefix.
    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let _done = Done { count: self.in_flight.clone(), last_used: self.last_used.clone() };
        let mut out = Vec::with_capacity(texts.len());
        for batch in texts.chunks(BATCH) {
            let (url, body) = crate::knowledge::embed::embed_request("openai", &format!("{}/v1", self.base_url()), &self.model_id, batch);
            let response = self.client.post(&url).json(&body).timeout(Duration::from_secs(120)).send().await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("the embedding server answered {}", response.status()));
            }
            let value: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
            let vectors = crate::knowledge::embed::read_vectors("openai", &value);
            if vectors.len() != batch.len() {
                return Err(format!("the embedding server gave {} vectors for {} texts", vectors.len(), batch.len()));
            }
            out.extend(vectors);
        }
        Ok(out)
    }
}

struct Done {
    count: Arc<AtomicUsize>,
    last_used: Arc<AtomicU64>,
}

impl Drop for Done {
    fn drop(&mut self) {
        self.last_used.store(engine::now_millis(), Ordering::Relaxed);
        self.count.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The running embedder for `entry`, starting one when there is none (or another model's).
pub async fn ensure(entry: &EmbedModelSpec) -> Result<Arc<Embedder>, String> {
    let path = super::models::path_of(&entry.spec);
    if !super::models::complete(&entry.spec, &path) {
        return Err(format!("{} isn't downloaded, or its download is incomplete. Download it in Settings › Local intelligence › Knowledge.", entry.spec.label));
    }
    let slot = SLOT.get_or_init(|| AsyncMutex::new(None));
    let mut guard = slot.lock().await;
    if let Some(existing) = guard.as_ref() {
        if existing.is_alive() && existing.model_id == entry.spec.id {
            existing.last_used.store(engine::now_millis(), Ordering::Relaxed);
            return Ok(existing.clone());
        }
        if existing.in_flight.load(Ordering::SeqCst) > 0 {
            return Err("The embedding engine is busy with another model.".to_string());
        }
    }
    stop_locked(&mut guard);
    let embedder = Arc::new(spawn(entry, path).await?);
    *guard = Some(embedder.clone());
    spawn_reaper();
    Ok(embedder)
}

async fn spawn(entry: &EmbedModelSpec, model_path: PathBuf) -> Result<Embedder, String> {
    let binary = engine::locate()?;
    let port = engine::free_port()?;
    let mut command = crate::proc::command(&binary);
    command
        .arg("-m")
        .arg(&model_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--embedding")
        .arg("--pooling")
        .arg(entry.pooling)
        .arg("-c")
        .arg(entry.ctx.to_string())
        // A whole chunk is one sequence: the batch must hold it.
        .arg("-b")
        .arg(entry.ctx.to_string())
        .arg("-ub")
        .arg(entry.ctx.to_string())
        // No prompt cache in RAM. b10587 keeps up to 8 GB of it by default (`--cache-ram 8192`), and
        // with the automatic slots (4, unified KV) every chunk embedded leaves its state there: a
        // vector is never asked for twice, so it is memory that only grows. Measured 2026-10-20 on
        // an M4 with these flags: +95 MB per batch of 32 chunks, 5 GB after 40 — Qwen3-Embedding
        // reached ~9 GB in the app — and flat at 0.9 GB with it off, at the same speed.
        .arg("--cache-ram")
        .arg("0")
        .arg("--no-webui");
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("CodeFlow couldn't start its embedding engine ({}): {e}", binary.display()))?;
    let diagnostics: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        engine::collect_diagnostics(stderr, diagnostics.clone());
    }
    if let Some(pid) = child.id() {
        let _ = std::fs::write(pidfile(), format!("{pid}\n{port}\n"));
        crate::background::adopt(pid, "llama-server", "embeddings", entry.spec.label);
    }
    let client = reqwest::Client::builder().no_proxy().build().map_err(|e| e.to_string())?;
    let embedder = Embedder {
        model_id: entry.spec.id.to_string(),
        port,
        client,
        child: Mutex::new(child),
        alive: Arc::new(AtomicBool::new(true)),
        last_used: Arc::new(AtomicU64::new(engine::now_millis())),
        in_flight: Arc::new(AtomicUsize::new(0)),
        diagnostics,
    };
    let deadline = std::time::Instant::now() + START_BUDGET;
    let health = format!("{}/health", embedder.base_url());
    while std::time::Instant::now() < deadline {
        if let Ok(mut child) = embedder.child.lock() {
            if let Ok(Some(exit)) = child.try_wait() {
                let said = embedder.diagnostics.lock().map(|l| l.join(" / ")).unwrap_or_default();
                return Err(format!("The embedding engine stopped immediately ({exit}). {said}"));
            }
        }
        if let Ok(response) = embedder.client.get(&health).timeout(Duration::from_secs(2)).send().await {
            if response.status().is_success() {
                return Ok(embedder);
            }
        }
        tokio::time::sleep(HEALTH_POLL).await;
    }
    if let Ok(mut child) = embedder.child.lock() {
        crate::background::release_id(child.id());
        let _ = child.start_kill();
    }
    Err(format!("{} didn't finish loading within {} seconds.", entry.spec.label, START_BUDGET.as_secs()))
}

fn stop_locked(guard: &mut Option<Arc<Embedder>>) {
    let Some(embedder) = guard.take() else { return };
    embedder.alive.store(false, Ordering::SeqCst);
    if let Ok(mut child) = embedder.child.lock() {
        crate::background::release_id(child.id());
        let _ = child.start_kill();
    }
    let _ = std::fs::remove_file(pidfile());
}

/// The model the embedder has loaded, if it is running — for Diagnóstico.
pub fn running_model() -> Option<String> {
    let slot = SLOT.get()?;
    let guard = slot.try_lock().ok()?;
    guard.as_ref().filter(|e| e.is_alive()).map(|e| e.model_id.clone())
}

/// Working memory a running embedder takes beyond its weights: measured 2026-10-20 on an M4, the
/// 0.6B Qwen3 embedder sat flat at 0.9 GB with `--cache-ram 0` — its 0.64 GB of weights and the rest.
const RUNNING_OVERHEAD: u64 = 256 * 1024 * 1024;

/// The memory the running embedder holds (0 when it is not running), for the fit estimate of a
/// chat model beside it (`hybrid::runtime::resident_beside`).
pub fn resident_bytes() -> u64 {
    running_model().and_then(|id| find(&id)).map_or(0, |entry| entry.spec.size_bytes + RUNNING_OVERHEAD)
}

pub async fn shutdown() {
    let slot = SLOT.get_or_init(|| AsyncMutex::new(None));
    let mut guard = slot.lock().await;
    stop_locked(&mut guard);
}

/// Stops the embedder unless it is embedding right now — battery saving at Máximo
/// (`crate::power`): a pass the user asked for keeps it, one nobody asked for is paused anyway.
pub async fn shutdown_if_idle() {
    let slot = SLOT.get_or_init(|| AsyncMutex::new(None));
    let mut guard = slot.lock().await;
    if guard.as_ref().is_some_and(|e| e.in_flight.load(Ordering::SeqCst) > 0) {
        return;
    }
    stop_locked(&mut guard);
}

fn spawn_reaper() {
    static ARMED: OnceLock<()> = OnceLock::new();
    if ARMED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(REAP_INTERVAL).await;
            let slot = SLOT.get_or_init(|| AsyncMutex::new(None));
            let mut guard = slot.lock().await;
            let idle = match guard.as_ref() {
                None => continue,
                Some(e) if e.in_flight.load(Ordering::SeqCst) > 0 => continue,
                Some(e) => engine::now_millis().saturating_sub(e.last_used.load(Ordering::Relaxed)),
            };
            if idle >= IDLE_TIMEOUT.as_millis() as u64 {
                stop_locked(&mut guard);
            }
        }
    });
}

fn pidfile() -> PathBuf {
    crate::paths::state_dir().join(".llama-embed.pid")
}

/// Kills an embedder left behind by a previous run. Called once at startup.
pub fn sweep_stale() {
    engine::sweep_pidfile(pidfile());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_is_offerable_and_unique() {
        for entry in EMBED_CATALOGUE {
            assert!(matches!(entry.spec.licence, "Apache-2.0" | "MIT"), "{}", entry.spec.licence);
            assert_eq!(entry.spec.sha256.len(), 64);
            assert!(entry.dims > 0 && entry.ctx >= 2_048);
            assert!(matches!(entry.pooling, "last" | "mean"));
        }
        assert!(find(DEFAULT_EMBED_MODEL_ID).is_some());
        let files: std::collections::HashSet<&str> = super::super::catalogue::CATALOGUE
            .iter()
            .chain(super::super::exec_catalogue::EXEC_CATALOGUE.iter().map(|e| &e.spec))
            .chain(EMBED_CATALOGUE.iter().map(|e| &e.spec))
            .map(|s| s.file)
            .collect();
        let count = super::super::catalogue::CATALOGUE.len() + super::super::exec_catalogue::EXEC_CATALOGUE.len() + EMBED_CATALOGUE.len();
        assert_eq!(files.len(), count, "one folder holds every catalogue's files");
    }
}
