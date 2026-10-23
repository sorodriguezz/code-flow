//! Would vectors help find **code**? (the user, 2026-10-22: «armo esa prueba con preguntas reales».)
//! Code chunks get no vectors today: the map and exact search find code, and nobody had measured
//! whether embeddings find more. This measures it on a real checkout, and only that — nothing here
//! changes what the app does.
//!
//! Questions say what the code does without naming it, each with the file that answers it, in
//! Spanish and in English (the models that call `search_knowledge` usually ask in English). Three
//! ways rank files for each, all over the same folders of the checkout:
//!
//! - **today:** what the app does for code — the word index and the code map (`super::lexical`);
//! - **vectors:** the code chunks of those folders embedded with the local model, ranked by cosine;
//! - **both:** the two lists fused by reciprocal rank, as `super::fuse` fuses the retrievers.
//!
//! Reported: the share of questions whose file is in the first five (hit@5), and the mean
//! reciprocal rank. Ignored: it embeds a few thousand chunks (minutes on the GPU) — run it plugged in:
//!
//! `CODEFLOW_TEST_KNOW_REPO=<this checkout> cargo test --lib code_vectors_against_the_map -- --ignored --nocapture`
//!
//! `CODEFLOW_TEST_EMBED=<catalogue id>` picks another downloaded embedding model.

use std::collections::HashMap;

use super::*;

/// The folders searched, relative to the checkout: Codi, the desktop reader, the knowledge engine,
/// the local models, and the settings and status-bar UI — a few thousand chunks.
const FOLDERS: &[&str] = &[
    "src-tauri/src/codi/",
    "src-tauri/src/desktop/",
    "src-tauri/src/knowledge/",
    "src-tauri/src/localai/",
    "src/components/layout/",
    "src/components/settings/",
];

/// `(Spanish, English, the file that answers)`.
const QUESTIONS: &[(&str, &str, &str)] = &[
    ("cómo decide Codi qué hacer con una orden de voz sin preguntarle a un modelo", "how does Codi decide what to do with a spoken order without asking a model", "src-tauri/src/codi/router.rs"),
    ("dónde se borran las capturas de pantalla después de leer otra aplicación", "where are screenshots deleted after reading another application", "src-tauri/src/desktop/read.rs"),
    ("qué abre una app instalada aunque el dictado haya escrito mal su nombre", "what opens an installed app even when dictation misspelled its name", "src-tauri/src/desktop/apps.rs"),
    ("cómo se corta un documento markdown en pedazos por sus títulos", "how is a markdown document cut into pieces at its headings", "src-tauri/src/knowledge/chunker.rs"),
    ("dónde se busca en internet para responder una rutina", "where does a routine search the internet to answer", "src-tauri/src/codi/web.rs"),
    ("cómo recuerda Codi lo que pasó en sesiones anteriores", "how does Codi remember what happened in earlier sessions", "src-tauri/src/codi/recollections.rs"),
    ("dónde se descarga un modelo y se comprueba que el archivo no esté corrupto", "where is a model downloaded and the file checked for corruption", "src-tauri/src/localai/download.rs"),
    ("qué apaga el motor de embeddings cuando lleva un rato sin usarse", "what stops the embedding engine after it sits unused for a while", "src-tauri/src/localai/embedder.rs"),
    ("dónde se muestra la carga de la batería en la barra inferior", "where is the battery charge shown in the bottom bar", "src/components/layout/BatteryMeter.tsx"),
    ("la pantalla para editar los pasos de las rutinas de Codi", "the screen for editing the steps of Codi's routines", "src/components/settings/CodiRoutines.tsx"),
    ("dónde se ve cuánta CPU y memoria usa la máquina", "where is the machine's CPU and memory use shown", "src/components/layout/SystemMeter.tsx"),
    ("cómo se elige un puerto libre para el servidor de completado local", "how is a free port chosen for the local completion server", "src-tauri/src/localai/engine.rs"),
    ("dónde se guardan y validan las rutinas como configuración", "where are routines saved and validated as a setting", "src-tauri/src/codi/routines.rs"),
    ("cómo se lee el texto de una ventana de otra app en Windows", "how is the text of another app's window read on Windows", "src-tauri/src/desktop/read_windows.rs"),
    ("dónde se elige y descarga el modelo para la búsqueda por significado", "where is the model for search by meaning chosen and downloaded", "src/components/settings/AiKnowledgeSettings.tsx"),
    ("cómo se juntan los resultados de varios buscadores en una sola lista", "how are the results of several retrievers merged into one list", "src-tauri/src/knowledge/mod.rs"),
    ("dónde se elige la voz con la que habla Codi", "where is the voice Codi speaks with chosen", "src/components/settings/CodiSettings.tsx"),
    ("qué abre una consulta rápida con lo que pidió Codi", "what opens a quick ask with what Codi was asked", "src-tauri/src/codi/native.rs"),
];

const TOP: usize = 5;

/// The files a ranked list names, in order, first appearance only, within [`FOLDERS`].
fn files(found: &[Found]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in found {
        if FOLDERS.iter().any(|folder| f.path.starts_with(folder)) && !out.contains(&f.path) {
            out.push(f.path.clone());
        }
    }
    out
}

/// 1-based rank of `want` in `ranked`, if it is there.
fn rank(ranked: &[String], want: &str) -> Option<usize> {
    ranked.iter().position(|p| p == want).map(|i| i + 1)
}

/// Reciprocal-rank fusion of file lists (k = 60, as the retrievers are fused).
fn fused(lists: &[&[String]]) -> Vec<String> {
    let mut score: HashMap<&str, f64> = HashMap::new();
    for list in lists {
        for (i, path) in list.iter().enumerate() {
            *score.entry(path.as_str()).or_default() += 1.0 / (60.0 + i as f64 + 1.0);
        }
    }
    let mut out: Vec<(&str, f64)> = score.into_iter().collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(b.0)));
    out.into_iter().map(|(p, _)| p.to_string()).collect()
}

#[derive(Default)]
struct Tally {
    hits: usize,
    reciprocal: f64,
    n: usize,
}

impl Tally {
    fn add(&mut self, at: Option<usize>) {
        self.n += 1;
        if let Some(at) = at {
            self.reciprocal += 1.0 / at as f64;
            if at <= TOP {
                self.hits += 1;
            }
        }
    }

    fn line(&self) -> String {
        format!("hit@{TOP} {:>2}/{} ({:>3.0}%) · MRR {:.2}", self.hits, self.n, 100.0 * self.hits as f64 / self.n.max(1) as f64, self.reciprocal / self.n.max(1) as f64)
    }
}

#[test]
fn the_fusion_rewards_agreement_and_ranks_are_one_based() {
    let a = vec!["x".to_string(), "y".to_string()];
    let b = vec!["y".to_string(), "z".to_string()];
    assert_eq!(fused(&[&a, &b])[0], "y");
    assert_eq!(rank(&a, "y"), Some(2));
    assert_eq!(rank(&a, "q"), None);
}

#[tokio::test]
#[ignore]
async fn code_vectors_against_the_map() {
    // The embedder lives in a static a test binary never drops; `crate::background` already ties
    // it to this process, and this stops it at once when the test ends, panic or not.
    struct StopEmbedder;
    impl Drop for StopEmbedder {
        fn drop(&mut self) {
            let _ = std::thread::spawn(|| tauri::async_runtime::block_on(crate::localai::embedder::shutdown())).join();
        }
    }
    let _stop = StopEmbedder;

    let root = std::env::var("CODEFLOW_TEST_KNOW_REPO").expect("CODEFLOW_TEST_KNOW_REPO=<a checkout>");
    let model = std::env::var("CODEFLOW_TEST_EMBED").ok();
    let space = embed::Space::configured(model.as_deref(), "http://127.0.0.1:11434").expect("a downloaded embedding model");
    eprintln!("model: {}", space.name);
    let scope = Scope { repos: vec![(format!("path:{root}"), "repo".into(), PathBuf::from(&root))], cloud: false, ..Default::default() };

    let started = std::time::Instant::now();
    let scope_for_walk = scope.clone();
    tokio::task::spawn_blocking(move || refresh_blocking(&scope_for_walk, true)).await.unwrap().unwrap();
    eprintln!("index: {:.1} s", started.elapsed().as_secs_f64());

    // The code chunks of the folders, from the (temporary) index.
    let keys = scope.keys();
    let chunks: Vec<(String, String)> = {
        let index = index::global().unwrap();
        let mut stmt = index
            .prepare(&format!(
                "SELECT s.path, c.heading || char(10) || c.text FROM chunks c JOIN sources s ON s.id = c.source_id
                 WHERE c.prose = 0 AND s.collection IN ({})",
                keys.iter().map(|_| "?").collect::<Vec<_>>().join(",")
            ))
            .unwrap();
        let params: Vec<&dyn rusqlite::ToSql> = keys.iter().map(|k| k as &dyn rusqlite::ToSql).collect();
        stmt.query_map(params.as_slice(), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|(path, _)| FOLDERS.iter().any(|f| path.starts_with(f)))
            .collect()
    };
    assert!(!chunks.is_empty(), "no code chunks under the folders — is CODEFLOW_TEST_KNOW_REPO this checkout?");

    let started = std::time::Instant::now();
    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(chunks.len());
    for batch in chunks.chunks(64) {
        let texts: Vec<String> = batch.iter().map(|(_, text)| text.clone()).collect();
        vectors.extend(space.embed_documents(&texts).await.unwrap());
    }
    let embed_secs = started.elapsed().as_secs_f64();
    eprintln!("embedded {} code chunks in {:.0} s ({:.0} ms each)", chunks.len(), embed_secs, 1000.0 * embed_secs / chunks.len() as f64);

    let mut tallies: HashMap<(&str, &str), Tally> = HashMap::new();
    for (es, en, want) in QUESTIONS {
        for (lang, question) in [("es", *es), ("en", *en)] {
            let scope_for_lexical = scope.clone();
            let q = question.to_string();
            let today = files(&tokio::task::spawn_blocking(move || lexical(&scope_for_lexical, &q, 40, MapUse::Build)).await.unwrap());

            let query = space.embed_query(question).await.unwrap();
            let mut scored: Vec<(f32, &str)> = vectors.iter().zip(&chunks).map(|(v, (path, _))| (embed::cosine(&query, v), path.as_str())).collect();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut by_vector: Vec<String> = Vec::new();
            for (_, path) in scored {
                if !by_vector.iter().any(|p| p == path) {
                    by_vector.push(path.to_string());
                }
                if by_vector.len() >= 40 {
                    break;
                }
            }
            let both = fused(&[&today, &by_vector]);

            let ranks = [rank(&today, want), rank(&by_vector, want), rank(&both, want)];
            for (method, at) in ["today", "vectors", "both"].into_iter().zip(ranks) {
                tallies.entry((lang, method)).or_default().add(at);
            }
            let shown = |r: Option<usize>| r.map(|r| r.to_string()).unwrap_or_else(|| "–".into());
            eprintln!("[{lang}] {:<4} {:<4} {:<4}  {question}", shown(ranks[0]), shown(ranks[1]), shown(ranks[2]));
        }
    }
    eprintln!("\n        rank: today vectors both (– = not in the first 40)");
    for lang in ["es", "en"] {
        for method in ["today", "vectors", "both"] {
            eprintln!("{lang} {method:<8} {}", tallies[&(lang, method)].line());
        }
    }
}
