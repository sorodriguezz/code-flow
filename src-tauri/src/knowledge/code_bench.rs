//! Do vectors help find **code**, and how should they be fused with the words and the map? (the
//! user, 2026-10-22: «armo esa prueba con preguntas reales».) This measures it on a real checkout,
//! and only that — nothing here changes what the app does.
//!
//! Two sets of questions, each with the file that answers it, in Spanish and in English (the models
//! that call `search_knowledge` usually ask in English):
//!
//! - **described:** what the code does, without naming it — what the words and the map are worst at;
//! - **named:** a question that names an identifier (`pending_vectors`, `UpdateNotesModal`) — what
//!   agents ask most, and what the words and the map are best at. It is here so that giving the
//!   vectors more say never costs what already worked.
//!
//! Ways to rank files for each, all over the same folders of the checkout:
//!
//! - **today:** the word index and the code map (`super::lexical`) — what the app did before code had
//!   vectors;
//! - **vectors:** the code chunks of those folders embedded with the local model, ranked by cosine;
//! - **both:** the two lists fused by reciprocal rank, as `super::fuse` fuses the retrievers;
//! - **variants** of that fusion for a question that names no identifier ([`super::identifiers`]) —
//!   a named one is fused as **both** whatever the variant, as the app would ([`VARIANTS`]).
//!
//! Measured 2026-11-17 (harrier-oss-v1-0.6b and qwen3-embedding-0.6b), described questions, hit@5:
//! today 22% es / 61% en, vectors 83% / 83–89%, both 67–72% / 78–83%; named questions stay at 100%
//! with both, and their MRR rises (0.70–0.75 → 0.91–1.00 in Spanish). Code vectors went on.
//!
//! Measured and dropped the same day:
//! - **the import graph as a third voter** — the importers and imports of the first three files
//!   voting again. Files like `mod.rs` import nearly everything, so whatever hung from one moved up
//!   whether it answered or not: hit@5 fell from 67% to 44% (Spanish) and from 78% to 67% (English).
//!   The graph is shown to the model beside each code result instead (`super::Found::links`);
//! - **the words weighed down** (0.5, 0.25) for a question that names no identifier, to close the gap
//!   between both and vectors alone: hit@5 did not move for either model, MRR moved by ±0.05. With
//!   k = 60 a file both lists hold anywhere outvotes one the vectors put first, whatever the weight.
//!
//! Then on 43 described questions (the first 18 and 25 more), 2026-11-17, hit@5 · MRR:
//!
//! | described | qwen3 es | qwen3 en | harrier es | harrier en |
//! |---|---|---|---|---|
//! | today | 14% · 0.05 | 86% · 0.68 | 14% · 0.05 | 86% · 0.68 |
//! | vectors | 88% · 0.71 | 93% · 0.81 | 79% · 0.44 | 93% · 0.83 |
//! | both | 81% · 0.36 | 93% · 0.82 | 67% · 0.28 | 91% · 0.81 |
//! | lex top5 | 81% · 0.36 | 88% · 0.82 | 67% · 0.28 | 88% · 0.81 |
//! | **vec k=10** | **86% · 0.65** | **95% · 0.80** | **72% · 0.36** | **91% · 0.81** |
//! | agree 10 | 86% · 0.46 | 95% · 0.83 | 67% · 0.31 | 91% · 0.81 |
//!
//! Named questions: 100% hit@5 for every way, both models. **Kept: vec k=10** — the only variant
//! that gained on both models (Spanish +5 points each, qwen3's MRR 0.36 → 0.65) and lost nothing in
//! English (`super::DESCRIBED_SEMANTIC_K`; a second run: Spanish 81% → 86% and 65% → 72%, English
//! equal, MRR −0.02). Dropped: cutting the lexical list to five (it lost English answers it alone
//! held) and agree-10 (no gain on harrier). Embedding, with nothing else running: 204–208 ms a
//! chunk (qwen3), 192–222 ms (harrier).
//!
//! **The semantic floor** (`super::COSINE_FLOOR`, 0.25): every answer's best cosine is above 0.45 on
//! both models; 0.55 drops 4–5 of 54 Spanish answers, 0.65 half or more. The notes eval's question
//! nothing answers (`evals`, `retrieval-absent`) still lists passages with qwen3: its nearest, the
//! README, scores 0.63, above what half the real code answers score — no floor separates them, so
//! the floor stays where it is and that eval is a known failure of the vectors, not of this fusion
//! (it failed the same before code had vectors and before `vec k=10`).
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

/// Described: `(Spanish, English, the file that answers)`.
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
    // Added 2026-11-17 so a fusion rule is not tuned on 18: each from what its file's own header
    // says it does.
    ("qué impide que el motor local se arranque una y otra vez cuando no puede arrancar", "what stops the app from starting a local engine over and over when it cannot start", "src-tauri/src/localai/breaker.rs"),
    ("cómo se convierte la posición del cursor en texto fantasma sugerido", "how is a caret position turned into a few tokens of ghost text", "src-tauri/src/localai/complete.rs"),
    ("con qué servidor de modelos habla el ejecutor de las tareas híbridas", "which model server does the hybrid task's executor talk to", "src-tauri/src/localai/executor.rs"),
    ("qué modelos se ofrecen para descargar para el autocompletado", "which models are offered for download for inline completion", "src-tauri/src/localai/catalogue.rs"),
    ("dónde se decide si un modelo cuenta como instalado y cuánto ocupa", "where is it decided whether a model counts as installed and what it costs on disk", "src-tauri/src/localai/models.rs"),
    ("qué modelos de instrucciones puede descargar y correr el ejecutor", "which instruct models can the executor download and run", "src-tauri/src/localai/exec_catalogue.rs"),
    ("cómo funciona mantener una tecla presionada para hablarle a Codi desde otra aplicación", "how does holding a key in another application let Codi hear", "src-tauri/src/codi/hotkey.rs"),
    ("cómo se sabe si una frase va dirigida a Codi por su nombre", "how is it decided whether an utterance is addressed to Codi by name", "src-tauri/src/codi/wake.rs"),
    ("dónde se detecta dónde empieza y termina una frase mientras se habla", "where are the start and end of an utterance found as it is spoken", "src-tauri/src/codi/vad.rs"),
    ("cómo responde Codi en segundo plano preguntas sobre el código de un repositorio", "how does Codi answer a question about a repository's code in the background", "src-tauri/src/codi/research.rs"),
    ("qué guarda Codi de lo preguntado y respondido durante la sesión actual", "what does Codi keep of what was asked and answered in the current session", "src-tauri/src/codi/memory.rs"),
    ("cómo elige Codi entre su propio enrutador, un modelo local y la nube", "how does Codi choose between its own router, a local model and a cloud model", "src-tauri/src/codi/brain.rs"),
    ("cómo se ejecutan las acciones de la interfaz desde un agente o desde Codi", "how are the interface's actions run by an agent or by Codi", "src-tauri/src/codi/ui.rs"),
    ("cómo se lee el texto de la ventana de otra app en un Mac con accesibilidad", "how is another app's window text read on a Mac through accessibility", "src-tauri/src/desktop/read_macos.rs"),
    ("cómo sabe el índice qué cambió en un repositorio vigilado", "how does the index know what changed in a watched repository", "src-tauri/src/knowledge/fresh.rs"),
    ("dónde se convierten las notas, reuniones y mensajes de commit en conocimiento buscable", "where are notes, meetings and commit messages turned into searchable knowledge", "src-tauri/src/knowledge/sources.rs"),
    ("dónde se arma la petición de embeddings para cada proveedor", "where is the embeddings request shaped for each provider", "src-tauri/src/knowledge/embed.rs"),
    ("la ventana que queda siempre encima con los planes que esperan a una persona", "the small always-on-top window listing the plans waiting for a person", "src/components/layout/AttentionWindow.tsx"),
    ("dónde se muestra en la barra la reunión que se está grabando", "where is the meeting being recorded shown in the bar", "src/components/layout/MeetingActivity.tsx"),
    ("la pantalla del primer inicio que instala git y las herramientas de IA", "the first-launch screen that installs git and the AI command-line tools", "src/components/layout/RequirementsModal.tsx"),
    ("dónde se ve cuánto del plan de cada proveedor se ha gastado", "where is how far through each provider's plan you are shown", "src/components/layout/UsageMeter.tsx"),
    ("la tarjeta con todo el proceso de actualizar la aplicación", "the card that holds the app's whole update flow", "src/components/layout/UpdateAlert.tsx"),
    ("dónde se elige qué motor ejecuta cada tarea de IA y qué se le dice", "where is it chosen which engine runs each AI task and what it is told", "src/components/settings/AiTasksSettings.tsx"),
    ("dónde se configura el respaldo automático programado de toda la instalación", "where is the scheduled automatic backup of the whole install set up", "src/components/settings/BackupAutomatic.tsx"),
    ("dónde se elige con qué modelo escribe el dictado y su atajo", "where is the model dictation writes with, and its shortcut, chosen", "src/components/settings/DictationSettings.tsx"),
];

/// Named: `(Spanish, English, the file that declares the identifier)`. Each identifier is declared
/// once under [`FOLDERS`] (checked 2026-11-17).
const NAMED: &[(&str, &str, &str)] = &[
    ("qué cuenta word_score al comparar un recuerdo con la orden", "what does word_score count when it compares a recollection with the order", "src-tauri/src/codi/recollections.rs"),
    ("cuándo answer_with deja la respuesta en esta máquina", "when does answer_with keep the answer on this machine", "src-tauri/src/codi/web.rs"),
    ("qué lee explain_pipeline para explicar una ejecución fallida", "what does explain_pipeline read to explain a failed run", "src-tauri/src/codi/research.rs"),
    ("para qué sirve THRESHOLD_SPEAKING mientras Codi habla", "what is THRESHOLD_SPEAKING for while Codi speaks", "src-tauri/src/codi/listen.rs"),
    ("quién usa resident_bytes del embedder", "who uses the embedder's resident_bytes", "src-tauri/src/localai/embedder.rs"),
    ("qué espera ensure_ready antes de arrancar el ejecutor", "what does ensure_ready wait for before starting the executor", "src-tauri/src/localai/executor.rs"),
    ("qué procesos mata sweep_orphans al iniciar", "which processes does sweep_orphans kill at startup", "src-tauri/src/localai/engine.rs"),
    ("cuándo se abre UpdateNotesModal", "when does UpdateNotesModal open", "src/components/layout/UpdateNotesModal.tsx"),
    ("qué muestra WorkspaceOverlay al cambiar de workspace", "what does WorkspaceOverlay show when the workspace changes", "src/components/layout/SwitchMotion.tsx"),
    ("en qué orden devuelve pending_vectors los pedazos sin vector", "in what order does pending_vectors return the chunks without a vector", "src-tauri/src/knowledge/index.rs"),
    ("qué guarda CodiState", "what does CodiState hold", "src-tauri/src/codi/mod.rs"),
];

const TOP: usize = 5;
/// Semantic floors whose cost to the code's answers is reported.
const FLOORS: &[f32] = &[0.25, 0.35, 0.45, 0.55, 0.65];

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

/// A way to fuse the words' list (`lexical`) and the vectors' (`vectors`) for a question that names
/// no identifier.
#[derive(Clone, Copy)]
enum Variant {
    /// The lexical list cut to its first `n` before the usual fusion: a lexical hit deep in its list
    /// matched incidental words.
    LexicalTop(usize),
    /// The vectors' list fused with a smaller `k` — its first places count for more than the
    /// lexical list's, where k = 60 makes rank 1 and rank 30 nearly equal.
    VectorK(f64),
    /// The vectors' order, the lexical list voting only for files both lists hold in their first
    /// `n`; files only the lexical list found come after.
    Agree(usize),
}

/// The variants measured, with their names.
const VARIANTS: &[(&str, Variant)] = &[("lex top5", Variant::LexicalTop(5)), ("vec k=10", Variant::VectorK(10.0)), ("agree 10", Variant::Agree(10))];

/// The methods, in the order they are reported.
fn methods() -> Vec<&'static str> {
    ["today", "vectors", "both"].into_iter().chain(VARIANTS.iter().map(|(name, _)| *name)).collect()
}

/// Reciprocal-rank fusion with a `k` per list.
fn fused_k(lists: &[(&[String], f64)]) -> Vec<String> {
    let mut score: HashMap<&str, f64> = HashMap::new();
    for (list, k) in lists {
        for (i, path) in list.iter().enumerate() {
            *score.entry(path.as_str()).or_default() += 1.0 / (k + i as f64 + 1.0);
        }
    }
    let mut out: Vec<(&str, f64)> = score.into_iter().collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(b.0)));
    out.into_iter().map(|(p, _)| p.to_string()).collect()
}

/// `variant`'s ranking of the two lists.
fn variant(lexical: &[String], vectors: &[String], how: Variant) -> Vec<String> {
    match how {
        Variant::LexicalTop(n) => fused(&[&lexical[..lexical.len().min(n)], vectors]),
        Variant::VectorK(k) => fused_k(&[(lexical, 60.0), (vectors, k)]),
        Variant::Agree(n) => {
            let top_lexical = &lexical[..lexical.len().min(n)];
            let mut scored: Vec<(f64, &String)> = vectors
                .iter()
                .enumerate()
                .map(|(i, path)| {
                    let vote = if i < n { top_lexical.iter().position(|p| p == path).map_or(0.0, |r| 1.0 / (60.0 + r as f64 + 1.0)) } else { 0.0 };
                    (1.0 / (60.0 + i as f64 + 1.0) + vote, path)
                })
                .collect();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut out: Vec<String> = scored.into_iter().map(|(_, p)| p.clone()).collect();
            out.extend(lexical.iter().filter(|p| !vectors.contains(p)).cloned());
            out
        }
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

#[test]
fn the_variants_rank_as_described() {
    let s = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
    // The vectors put the answer first; the words found a noise file first and, deep down, the
    // answer's neighbour that the vectors also hold far down.
    let lexical = s(&["noise", "a", "b", "c", "d", "e", "deep"]);
    let vectors = s(&["answer", "x", "y", "z", "w", "v", "u", "t", "r", "q", "deep"]);
    assert_eq!(variant(&lexical, &vectors, Variant::Agree(10))[0], "answer", "a file only the words found never outranks the vectors' first");
    assert_eq!(*variant(&lexical, &vectors, Variant::Agree(10)).last().unwrap(), "e", "the words' own files come after");
    assert_eq!(variant(&lexical, &vectors, Variant::VectorK(10.0))[0], "answer");
    let both = s(&["shared", "noise"]);
    let near = s(&["answer", "shared"]);
    assert_eq!(variant(&both, &near, Variant::Agree(10))[0], "shared", "agreement inside both tops still wins");
    assert_eq!(variant(&lexical, &vectors, Variant::LexicalTop(1)).len(), vectors.len() + 1);
}

#[test]
fn the_questions_are_sorted_into_the_right_set() {
    for (es, en, _) in QUESTIONS {
        assert!(identifiers(es).is_empty() && identifiers(en).is_empty(), "a described question names no identifier: {en}");
    }
    for (es, en, _) in NAMED {
        assert!(!identifiers(es).is_empty() && !identifiers(en).is_empty(), "a named question names one: {en}");
    }
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

    // The code chunks of the folders, from the (temporary) index — embedded as the app embeds them,
    // heading and text ([`index::pending_vectors`]).
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

    let methods = methods();
    let mut tallies: HashMap<(&str, &str, &str), Tally> = HashMap::new();
    // The answer's best cosine per question, by language: what a semantic floor (`COSINE_FLOOR`)
    // would cost the code, which the rankings above never filter.
    let mut answer_cosines: HashMap<&str, Vec<f32>> = HashMap::new();
    for (set, questions) in [("described", QUESTIONS), ("named", NAMED)] {
        for (es, en, want) in questions {
            for (lang, question) in [("es", *es), ("en", *en)] {
                let scope_for_lexical = scope.clone();
                let q = question.to_string();
                let today = files(&tokio::task::spawn_blocking(move || lexical(&scope_for_lexical, &q, 40, MapUse::Build)).await.unwrap());

                let query = space.embed_query(question).await.unwrap();
                let mut scored: Vec<(f32, &str)> = vectors.iter().zip(&chunks).map(|(v, (path, _))| (embed::cosine(&query, v), path.as_str())).collect();
                scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                answer_cosines.entry(lang).or_default().push(scored.iter().find(|(_, path)| path == want).map_or(0.0, |(c, _)| *c));
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
                let named = !identifiers(question).is_empty();
                let mut ranks = vec![rank(&today, want), rank(&by_vector, want), rank(&both, want)];
                for (_, how) in VARIANTS {
                    ranks.push(if named { rank(&both, want) } else { rank(&variant(&today, &by_vector, *how), want) });
                }
                for (method, at) in methods.iter().zip(&ranks) {
                    tallies.entry((set, lang, *method)).or_default().add(*at);
                }
                let shown: Vec<String> = ranks.iter().map(|r| r.map(|r| r.to_string()).unwrap_or_else(|| "–".into())).map(|r| format!("{r:<4}")).collect();
                eprintln!("[{set} {lang}] {}  {question}", shown.join(" "));
            }
        }
    }
    eprintln!("\n        rank: {} (– = not in the first 40)", methods.join(" · "));
    for lang in ["es", "en"] {
        let cosines = &answer_cosines[lang];
        let kept: Vec<String> = FLOORS.iter().map(|floor| format!("{floor}: {}/{}", cosines.iter().filter(|c| **c > *floor).count(), cosines.len())).collect();
        eprintln!("{lang} answers above a cosine floor — {}", kept.join(" · "));
    }
    for set in ["described", "named"] {
        for lang in ["es", "en"] {
            for method in &methods {
                eprintln!("{set:<9} {lang} {method:<8} {}", tallies[&(set, lang, *method)].line());
            }
        }
    }
}
