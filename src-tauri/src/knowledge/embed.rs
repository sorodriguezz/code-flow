//! Embeddings: the request shapes of every provider CodeFlow speaks to (shared with Flujos' AI
//! nodes), vector maths, and the local embedding space the knowledge index uses.
//!
//! The space is always local — the bundled embedder (`crate::localai::embedder`) or an embedding
//! model the user's Ollama serves. A vector is only comparable with vectors of the same model and
//! weights, so every stored vector names its [`Space`]; changing the model starts a new space instead
//! of mixing two.

use serde_json::{json, Value};

pub fn embed_request(provider: &str, base: &str, model: &str, texts: &[String]) -> (String, Value) {
    match provider {
        "gemini" => {
            let model = model.trim_start_matches("models/");
            let requests: Vec<Value> = texts.iter().map(|t| json!({"model": format!("models/{model}"), "content": {"parts": [{"text": t}]}})).collect();
            (format!("{base}/models/{model}:batchEmbedContents"), json!({"requests": requests}))
        }
        "ollama" => (format!("{base}/api/embed"), json!({"model": model, "input": texts})),
        _ => (format!("{base}/embeddings"), json!({"model": model, "input": texts})),
    }
}

pub fn read_vectors(provider: &str, answer: &Value) -> Vec<Vec<f32>> {
    let floats = |v: &Value| v.as_array().map(|list| list.iter().filter_map(Value::as_f64).map(|f| f as f32).collect::<Vec<f32>>());
    match provider {
        "gemini" => answer["embeddings"].as_array().into_iter().flatten().filter_map(|e| floats(&e["values"])).collect(),
        "ollama" => answer["embeddings"].as_array().into_iter().flatten().filter_map(floats).collect(),
        _ => {
            let mut data: Vec<&Value> = answer["data"].as_array().into_iter().flatten().collect();
            data.sort_by_key(|d| d["index"].as_u64().unwrap_or(0));
            data.into_iter().filter_map(|d| floats(&d["embedding"])).collect()
        }
    }
}


/// Cosine similarity; 0 for vectors that cannot be compared.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0f32, 0f32, 0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na.sqrt() * nb.sqrt()) }
}

pub fn to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|f| f.to_le_bytes()).collect()
}

pub fn from_blob(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

/// The setting that names the embedding model: a bundled catalogue id, or `ollama:<model>`.
pub const KEY_EMBED_MODEL: &str = "knowledge_embed_model";

/// Which embedding model the index uses, and how to ask it.
#[derive(Clone, Debug)]
pub struct Space {
    /// Stored with every vector: `<model>@<first 12 of its digest>`.
    pub name: String,
    pub provider: Provider,
}

#[derive(Clone, Debug)]
pub enum Provider {
    Bundled(&'static crate::localai::embedder::EmbedModelSpec),
    Ollama { url: String, model: String },
}

impl Space {
    /// The space the settings name — or, with none chosen, the default bundled model when it is
    /// downloaded. `None`: no local embedding model is available, and search stays lexical.
    ///
    /// An Ollama space is named here without its weights' digest — [`Space::resolve`] asks the
    /// server for it. Never a cloud model, and never a server off this machine and the user's own
    /// network: the knowledge is embedded where it lives ([`crate::hybrid::local_llm::cloud_refusal`]).
    pub fn configured(setting: Option<&str>, ollama_url: &str) -> Option<Self> {
        match setting.map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) if raw.starts_with("ollama:") => {
                let model = raw.trim_start_matches("ollama:").to_string();
                if crate::hybrid::local_llm::cloud_refusal(ollama_url, &model).is_some() {
                    return None;
                }
                Some(Self { name: format!("ollama:{model}"), provider: Provider::Ollama { url: ollama_url.to_string(), model } })
            }
            Some(id) => crate::localai::embedder::find(id).filter(|e| crate::localai::models::is_installed(&e.spec)).map(Self::bundled),
            None => crate::localai::embedder::find(crate::localai::embedder::DEFAULT_EMBED_MODEL_ID)
                .filter(|e| crate::localai::models::is_installed(&e.spec))
                .map(Self::bundled),
        }
    }

    /// [`Space::configured`], with an Ollama model named by its weights too:
    /// `ollama:<model>@<first 12 of its digest>`. A re-pull that changed the bytes is then a new
    /// space, as a bundled model's new file is, instead of new vectors compared with old ones. `None`
    /// when Ollama does not list the model (it is gone, or the server is down — embedding would fail
    /// either way). A server that publishes no digest keeps the bare name.
    pub async fn resolve(setting: Option<&str>, ollama_url: &str) -> Option<Self> {
        let mut space = Self::configured(setting, ollama_url)?;
        if let Provider::Ollama { url, model } = &space.provider {
            match ollama_digest(url, model).await {
                Digest::Of(digest) => space.name = ollama_space(model, Some(&digest)),
                Digest::Unpublished => {}
                Digest::Absent => return None,
            }
        }
        Some(space)
    }

    pub fn bundled(entry: &'static crate::localai::embedder::EmbedModelSpec) -> Self {
        Self { name: format!("{}@{}", entry.spec.id, &entry.spec.sha256[..12]), provider: Provider::Bundled(entry) }
    }

    fn prefixes(&self) -> (&str, &str) {
        match &self.provider {
            Provider::Bundled(entry) => (entry.query_prefix, entry.doc_prefix),
            Provider::Ollama { .. } => ("", ""),
        }
    }

    async fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        match &self.provider {
            Provider::Bundled(entry) => crate::localai::embedder::ensure(entry).await?.embed(&texts).await,
            Provider::Ollama { url, model } => {
                let client = reqwest::Client::builder().no_proxy().build().map_err(|e| e.to_string())?;
                let mut out = Vec::with_capacity(texts.len());
                for batch in texts.chunks(crate::localai::embedder::BATCH) {
                    let (endpoint, body) = embed_request("ollama", url, model, batch);
                    let answer: Value = client
                        .post(&endpoint)
                        .json(&body)
                        .timeout(std::time::Duration::from_secs(120))
                        .send()
                        .await
                        .map_err(|e| e.to_string())?
                        .json()
                        .await
                        .map_err(|e| e.to_string())?;
                    let vectors = read_vectors("ollama", &answer);
                    if vectors.len() != batch.len() {
                        return Err(format!("Ollama gave {} vectors for {} texts", vectors.len(), batch.len()));
                    }
                    out.extend(vectors);
                }
                Ok(out)
            }
        }
    }

    pub async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let (_, doc) = self.prefixes();
        self.embed(texts.iter().map(|t| format!("{doc}{t}")).collect()).await
    }

    pub async fn embed_query(&self, text: &str) -> Result<Vec<f32>, String> {
        let (query, _) = self.prefixes();
        self.embed(vec![format!("{query}{text}")]).await?.into_iter().next().ok_or_else(|| "no vector".to_string())
    }
}

/// What Ollama says about one model's weights.
#[derive(Clone, Debug, PartialEq)]
enum Digest {
    Of(String),
    /// Listed, without a digest.
    Unpublished,
    /// Not listed, or the server did not answer.
    Absent,
}

/// The space name of an Ollama model: its digest's first 12 characters when there is one.
pub fn ollama_space(model: &str, digest: Option<&str>) -> String {
    match digest.map(|d| d.trim_start_matches("sha256:")).filter(|d| d.len() >= 12) {
        Some(digest) => format!("ollama:{model}@{}", &digest[..12]),
        None => format!("ollama:{model}"),
    }
}

/// Whether a listed Ollama name is the model the setting names (`nomic-embed-text` is listed as
/// `nomic-embed-text:latest`).
fn same_model(listed: &str, model: &str) -> bool {
    listed == model || listed.strip_suffix(":latest") == Some(model) || model.strip_suffix(":latest") == Some(listed)
}

/// The models a local Ollama lists, `(name, digest)`, or `None` when it cannot be asked (a URL off
/// this machine is never asked) or did not answer.
pub async fn ollama_models(url: &str) -> Option<Vec<(String, Option<String>)>> {
    if crate::hybrid::local_llm::cloud_refusal(url, "").is_some() {
        return None;
    }
    let endpoint = crate::hybrid::local_llm::Endpoint::new(crate::hybrid::local_llm::BackendKind::Ollama, url, None);
    let listed = crate::hybrid::local_llm::list_models(&endpoint).await.ok()?;
    Some(listed.into_iter().map(|m| (m.id, m.digest)).collect())
}

/// One answer per minute per model: a search should not ask Ollama its listing every time.
static DIGESTS: std::sync::Mutex<Vec<(String, String, Digest, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

async fn ollama_digest(url: &str, model: &str) -> Digest {
    if let Ok(cache) = DIGESTS.lock() {
        if let Some((_, _, digest, _)) = cache.iter().find(|(u, m, _, at)| u == url && m == model && at.elapsed() < std::time::Duration::from_secs(60)) {
            return digest.clone();
        }
    }
    let digest = match ollama_models(url).await {
        Some(models) => match models.into_iter().find(|(name, _)| same_model(name, model)) {
            Some((_, Some(digest))) => Digest::Of(digest),
            Some((_, None)) => Digest::Unpublished,
            None => Digest::Absent,
        },
        None => Digest::Absent,
    };
    if let Ok(mut cache) = DIGESTS.lock() {
        cache.retain(|(u, m, _, _)| !(u == url && m == model));
        cache.push((url.to_string(), model.to_string(), digest.clone(), std::time::Instant::now()));
    }
    digest
}

/// The Ollama spaces of `spaces` nothing can query any more, given what the server lists now: a
/// model no longer pulled, a digest the model no longer has (re-pulled), and the bare
/// `ollama:<model>` of older builds once the model publishes a digest — its vectors were made
/// before the name carried the weights, and the digest-named space replaces them.
pub fn ollama_orphans(spaces: &[String], listed: &[(String, Option<String>)]) -> Vec<String> {
    spaces
        .iter()
        .filter(|space| {
            let Some(rest) = space.strip_prefix("ollama:") else { return false };
            let (model, digest) = match rest.rsplit_once('@') {
                Some((model, digest)) => (model, Some(digest)),
                None => (rest, None),
            };
            let current = listed.iter().find(|(name, _)| same_model(name, model));
            match (current, digest) {
                (None, _) => true,
                (Some((_, Some(now))), Some(then)) => !now.trim_start_matches("sha256:").starts_with(then),
                (Some((_, Some(_))), None) => true,
                (Some((_, None)), Some(_)) => true,
                (Some((_, None)), None) => false,
            }
        })
        .cloned()
        .collect()
}

/// The bundled spaces of `spaces` nothing can query: a model no longer downloaded, or a file that
/// changed under the same id (its digest moved).
pub fn bundled_orphans(spaces: &[String]) -> Vec<String> {
    spaces
        .iter()
        .filter(|space| !space.starts_with("ollama:"))
        .filter(|space| {
            let Some((id, sha)) = space.rsplit_once('@') else { return false };
            match crate::localai::embedder::find(id) {
                Some(entry) => !crate::localai::models::is_installed(&entry.spec) || !entry.spec.sha256.starts_with(sha),
                None => true,
            }
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ollama_space_names_its_weights_and_the_stale_ones_are_found() {
        assert_eq!(ollama_space("nomic-embed-text", Some("sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f")), "ollama:nomic-embed-text@0a109f422b47");
        assert_eq!(ollama_space("m", None), "ollama:m");
        let spaces: Vec<String> = [
            "ollama:nomic-embed-text@0a109f422b47",
            "ollama:nomic-embed-text@ffffffffffff",
            "ollama:nomic-embed-text",
            "ollama:gone-model@0a109f422b47",
            "ollama:no-digest",
            "qwen3-embedding-0.6b@abc",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let listed = vec![
            ("nomic-embed-text:latest".to_string(), Some("0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f".to_string())),
            ("no-digest".to_string(), None),
        ];
        assert_eq!(
            ollama_orphans(&spaces, &listed),
            vec!["ollama:nomic-embed-text@ffffffffffff", "ollama:nomic-embed-text", "ollama:gone-model@0a109f422b47"],
            "a re-pull, the bare name of older builds and a removed model; bundled spaces are not Ollama's"
        );
    }

    #[test]
    fn a_remote_ollama_is_never_an_embedding_space() {
        assert!(Space::configured(Some("ollama:nomic-embed-text"), "https://ollama.example.com").is_none());
        assert!(Space::configured(Some("ollama:nomic-embed-text"), "http://127.0.0.1:11434").is_some());
    }

    #[test]
    fn blobs_round_trip() {
        let v = vec![0.5f32, -1.25, 3.0];
        assert_eq!(from_blob(&to_blob(&v)), v);
    }

    #[test]
    fn cloud_embedders_are_refused() {
        assert!(Space::configured(Some("ollama:embeddinggemma:cloud"), "http://127.0.0.1:11434").is_none());
        let local = Space::configured(Some("ollama:nomic-embed-text"), "http://127.0.0.1:11434").unwrap();
        assert_eq!(local.name, "ollama:nomic-embed-text");
    }

    #[test]
    fn request_shapes() {
        let (url, body) = embed_request("ollama", "http://h", "m", &["a".to_string()]);
        assert_eq!(url, "http://h/api/embed");
        assert_eq!(body["input"][0], "a");
        let answer = json!({"data": [{"index": 1, "embedding": [2.0]}, {"index": 0, "embedding": [1.0]}]});
        assert_eq!(read_vectors("openai", &answer), vec![vec![1.0], vec![2.0]]);
    }
}
