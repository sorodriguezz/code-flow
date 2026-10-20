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
    pub fn configured(setting: Option<&str>, ollama_url: &str) -> Option<Self> {
        match setting.map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) if raw.starts_with("ollama:") => {
                let model = raw.trim_start_matches("ollama:").to_string();
                if crate::hybrid::local_llm::is_cloud_name(&model) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
