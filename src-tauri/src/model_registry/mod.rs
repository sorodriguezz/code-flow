//! What CodeFlow knows about each local model — owned by the app, not by whichever model is loaded.
//!
//! Three things live here, each decided in one place instead of at every call site:
//!
//! * **Identity.** A model is its content: the GGUF's SHA-256 for the bundled engine, Ollama's
//!   digest otherwise ([`digest_of`]). Two names for the same bytes are the same model; a re-pull
//!   that changed the bytes is a different one and loses its verification.
//! * **Capabilities, declared and verified.** The server *declares* (`/api/show`'s `capabilities`,
//!   or the catalogue entry); the bench's conformance suite *verifies* tool calling
//!   ([`crate::evals::conformance`]) and [`store`] keeps the verdict per digest. A model that was
//!   tested and failed does not drive the agent with write tools ([`agent_refusal`]).
//! * **Reasoning.** One policy ([`Reasoning`], the `local_exec_reasoning` setting) turned into the
//!   per-request switch for each class of task ([`think_for`]) and into how the bundled engine is
//!   launched ([`server_reasoning`]). It replaced four hard-coded `Some(false)`s.

pub mod store;

use serde::{Deserialize, Serialize};

use crate::ai::task;
use crate::hybrid::local_llm::{self, BackendKind, Endpoint};
use crate::hybrid::runtime::Resolved;
use crate::localai::exec_catalogue;

/// The setting that holds [`Reasoning`].
pub const KEY_REASONING: &str = "local_exec_reasoning";

/// What kind of work a request is, as far as reasoning and routing care.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskClass {
    /// The tool loop: chats, fixes, chain steps — many short steps where thinking multiplies time.
    Agent,
    /// One-shot answers whose material is in the request: commit messages, titles, JSON.
    Text,
    /// Reading something and judging it: reviews, analyses, verifications. Where reasoning pays.
    Analysis,
    /// The hybrid task's executor: a bounded rewrite of one region.
    Executor,
}

/// The class of `task` when it runs in agent (`true`) or text mode.
pub fn class_of(task_id: &str, agent_mode: bool) -> TaskClass {
    const ANALYSIS: &[&str] = &[
        task::ANALYZE,
        task::REVIEW_PR,
        task::WORK_ITEM_REVIEW,
        task::STORIES_VERIFY,
        task::PIPELINE_ANALYZE,
        task::LOGS_ANALYZE,
        task::CONFLICT,
    ];
    if task_id == task::HYBRID_EXECUTE {
        TaskClass::Executor
    } else if ANALYSIS.contains(&task_id) {
        TaskClass::Analysis
    } else if agent_mode {
        TaskClass::Agent
    } else {
        TaskClass::Text
    }
}

/// When a thinking model may think.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reasoning {
    /// Never — the measured default: qwen3:8b took 338 s to fix a one-line bug thinking, 35 s not.
    #[default]
    Off,
    /// Only for [`TaskClass::Analysis`], where a slower, more careful answer is worth it.
    Analysis,
    /// Always.
    Always,
}

impl Reasoning {
    pub fn from_setting(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("analysis") => Reasoning::Analysis,
            Some("always") => Reasoning::Always,
            _ => Reasoning::Off,
        }
    }

    pub fn wants(self, class: TaskClass) -> bool {
        match self {
            Reasoning::Off => false,
            Reasoning::Analysis => class == TaskClass::Analysis,
            Reasoning::Always => true,
        }
    }
}

/// The user's policy, read from the app database (`Off` when there is none, as in tests).
pub fn reasoning() -> Reasoning {
    Reasoning::from_setting(crate::ai_usage::setting(KEY_REASONING).as_deref())
}

/// The per-request switch for a model that can think: `Some(true|false)`, or `None` for a model
/// with no thinking phase (sending the field would be noise, and some templates mis-read it).
pub fn think_switch(policy: Reasoning, can_think: bool, class: TaskClass) -> Option<bool> {
    can_think.then(|| policy.wants(class))
}

/// [`think_switch`] for the model `resolved` names, under the user's policy.
pub fn think_for(resolved: &Resolved, class: TaskClass) -> Option<bool> {
    think_switch(reasoning(), resolved.details.thinking, class)
}

/// Whether the bundled engine starts with reasoning available. With the policy off it is launched
/// with `--reasoning-budget 0`, so not even a template that ignores the per-request switch thinks;
/// otherwise every request says for itself ([`think_for`]).
pub fn server_reasoning() -> bool {
    reasoning() != Reasoning::Off
}

/// The content identity of `model` on this backend: the catalogue file's SHA-256, Ollama's digest,
/// or `None` for a server that publishes neither.
pub async fn digest_of(kind: BackendKind, url: &str, model: &str) -> Option<String> {
    match kind {
        BackendKind::Bundled => exec_catalogue::find(model).map(|entry| entry.spec.sha256.to_string()),
        BackendKind::Ollama => {
            let endpoint = Endpoint::new(kind, url, None);
            local_llm::list_models(&endpoint).await.ok()?.into_iter().find(|m| m.id == model)?.digest
        }
        BackendKind::Openai => None,
    }
}

/// What a model declares it can do.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Declared {
    pub tools: bool,
    pub thinking: bool,
    pub vision: bool,
    pub insert: bool,
    pub embedding: bool,
}

impl Declared {
    pub fn from_capabilities(caps: &[String]) -> Self {
        let has = |name: &str| caps.iter().any(|c| c == name);
        Self { tools: has("tools"), thinking: has("thinking"), vision: has("vision"), insert: has("insert"), embedding: has("embedding") }
    }

    pub fn of_entry(entry: &exec_catalogue::ExecModelSpec) -> Self {
        Self { tools: entry.tools, thinking: entry.thinking, vision: false, insert: false, embedding: false }
    }
}

/// The registry key of a model on a backend. The digest is a column, not part of the key: the row
/// follows the name, and a changed digest is how a stale verification is noticed.
pub fn registry_id(kind: BackendKind, model: &str) -> String {
    format!("{}|{}", kind.as_str(), model)
}

/// The family a model's name says it belongs to, for servers whose listing has no catalogue entry.
pub fn family_guess(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    if name.contains("nemotron") {
        Some("nemotron")
    } else if name.contains("qwen") {
        Some("qwen")
    } else if name.contains("phi") {
        Some("phi")
    } else {
        None
    }
}

/// Files what `resolved` says about `model` in the registry and returns the tool verdict for these
/// exact bytes. Called when a run opens its model, so the registry fills itself with what is used.
/// `None` without an app database (tests) or when the model was never verified.
pub fn note_model(resolved: &Resolved, model: &str) -> Option<bool> {
    let entry = (resolved.kind == BackendKind::Bundled).then(|| exec_catalogue::find(model)).flatten();
    let digest = match entry {
        Some(entry) => Some(entry.spec.sha256.to_string()),
        None => resolved.available.iter().find(|m| m.id == model).and_then(|m| m.digest.clone()),
    };
    let declared = match entry {
        Some(entry) => Declared::of_entry(entry),
        None => Declared::from_capabilities(&resolved.details.capabilities),
    };
    let family = match entry {
        Some(entry) => Some(match entry.family {
            exec_catalogue::Family::Qwen => "qwen",
            exec_catalogue::Family::Phi => "phi",
            exec_catalogue::Family::Nemotron => "nemotron",
        }),
        None => family_guess(model),
    };
    let id = registry_id(resolved.kind, model);
    crate::ai_usage::with_conn(|conn| {
        let _ = store::upsert_declared(conn, &id, resolved.kind.as_str(), model, digest.as_deref(), family, &declared);
        store::get(conn, &id).ok().flatten().and_then(|record| record.current_verdict())
    })
    .flatten()
}

/// Why the agent may not drive `model` with write tools, if it may not: its tool calling was tested
/// against these exact bytes and failed. Untested models run (the agent repairs written calls and
/// nudges); a failed verification is a measured "this one cannot".
pub fn agent_refusal(verified: Option<bool>, spanish: bool) -> Option<String> {
    (verified == Some(false)).then(|| {
        if spanish {
            "Este modelo falló la verificación de herramientas, así que no se usa para editar archivos. Elige otro modelo o vuelve a verificarlo en Configuración › Motores de IA › Modelo local.".to_string()
        } else {
            "This model failed the tool-calling check, so it isn't used to edit files. Choose another model or verify it again in Settings › AI engines › Local model.".to_string()
        }
    })
}

/// The model id a task pinned to «auto» asks for.
pub const AUTO: &str = "auto";

/// One local model as `auto` weighs it.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub model: String,
    /// The latest bench score of this model on a machine like this one (same arch, RAM within 10 %).
    pub score: Option<f64>,
    pub gen_tps: Option<f64>,
    pub tools: Option<bool>,
    /// Fits this machine comfortably or tightly (false: spills to the CPU or does not fit).
    pub fits: bool,
}

/// What `auto` picks for `class` among `candidates`: never a model that failed tool calling for an
/// agent run, never one that does not fit; the best measured score, then the fastest. `None` when
/// nothing was ever measured — the caller keeps the pane's model then, not a guess.
pub fn pick_auto(candidates: &[Candidate], class: TaskClass) -> Option<String> {
    let mut usable: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| c.fits && c.score.is_some())
        .filter(|c| !(class == TaskClass::Agent && c.tools == Some(false)))
        .collect();
    usable.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.gen_tps.partial_cmp(&a.gen_tps).unwrap_or(std::cmp::Ordering::Equal))
    });
    usable.first().map(|c| c.model.clone())
}

/// The candidates `resolved`'s server offers, weighed with what the bench measured on this machine.
pub fn candidates(conn: &rusqlite::Connection, resolved: &Resolved) -> Vec<Candidate> {
    let machine = crate::evals::report::MachineSummary::of(&resolved.machine);
    let models: Vec<String> = match resolved.kind {
        BackendKind::Bundled => exec_catalogue::EXEC_CATALOGUE
            .iter()
            .filter(|e| !e.cuda_only && crate::localai::models::is_installed(&e.spec))
            .map(|e| e.spec.id.to_string())
            .collect(),
        _ => resolved.available.iter().map(|m| m.id.clone()).collect(),
    };
    let evaluations = store::evaluations(conn, 200).unwrap_or_default();
    models
        .into_iter()
        .map(|model| {
            let latest = evaluations.iter().find(|e| {
                e.model == model
                    && e.backend == resolved.kind.as_str()
                    && e.adapter_id.is_none()
                    && e.report.machine.arch == machine.arch
                    && (e.report.machine.ram_gb - machine.ram_gb).abs() <= machine.ram_gb * 0.1
            });
            let fits = match exec_catalogue::find(&model).filter(|_| resolved.kind == BackendKind::Bundled) {
                Some(entry) => {
                    let need = crate::hybrid::budget::memory_need(entry.spec.size_bytes, entry.kv_bytes_per_token, resolved.ctx);
                    matches!(
                        crate::hybrid::budget::fit(need, resolved.also_resident, &resolved.machine),
                        crate::hybrid::budget::Fit::Comfortable | crate::hybrid::budget::Fit::Tight
                    )
                }
                // A server's model is running already, or loads at the server's own judgment.
                None => true,
            };
            let tools = store::get(conn, &registry_id(resolved.kind, &model)).ok().flatten().and_then(|r| r.current_verdict());
            Candidate {
                score: latest.map(|e| e.score),
                gen_tps: latest.and_then(|e| e.report.speed.as_ref().and_then(|s| s.gen_tps)),
                tools,
                fits,
                model,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_classes() {
        assert_eq!(class_of(task::REVIEW_PR, false), TaskClass::Analysis);
        assert_eq!(class_of(task::ANALYZE, true), TaskClass::Analysis);
        assert_eq!(class_of(task::HYBRID_EXECUTE, false), TaskClass::Executor);
        assert_eq!(class_of(task::CHAT, true), TaskClass::Agent);
        assert_eq!(class_of(task::COMMIT, false), TaskClass::Text);
    }

    #[test]
    fn the_policy_decides_per_class_and_only_for_models_that_think() {
        assert_eq!(think_switch(Reasoning::Off, true, TaskClass::Analysis), Some(false));
        assert_eq!(think_switch(Reasoning::Analysis, true, TaskClass::Analysis), Some(true));
        assert_eq!(think_switch(Reasoning::Analysis, true, TaskClass::Agent), Some(false));
        assert_eq!(think_switch(Reasoning::Always, true, TaskClass::Executor), Some(true));
        assert_eq!(think_switch(Reasoning::Always, false, TaskClass::Analysis), None, "a model without a phase gets no switch");
    }

    #[test]
    fn the_setting_defaults_to_off() {
        assert_eq!(Reasoning::from_setting(None), Reasoning::Off);
        assert_eq!(Reasoning::from_setting(Some("bogus")), Reasoning::Off);
        assert_eq!(Reasoning::from_setting(Some("analysis")), Reasoning::Analysis);
        assert_eq!(Reasoning::from_setting(Some(" always ")), Reasoning::Always);
    }

    #[test]
    fn declared_capabilities_read_every_name() {
        let caps: Vec<String> = ["completion", "tools", "vision"].iter().map(|s| s.to_string()).collect();
        let declared = Declared::from_capabilities(&caps);
        assert!(declared.tools && declared.vision && !declared.thinking);
        let nemotron = exec_catalogue::find("nemotron-3-nano-4b").unwrap();
        assert!(Declared::of_entry(nemotron).thinking);
    }

    #[test]
    fn only_a_failed_verification_refuses() {
        assert!(agent_refusal(None, true).is_none());
        assert!(agent_refusal(Some(true), true).is_none());
        assert!(agent_refusal(Some(false), false).unwrap().contains("tool-calling"));
    }

    #[test]
    fn auto_picks_the_best_measured_model_that_may_run_the_task() {
        let c = |model: &str, score: Option<f64>, tps: f64, tools: Option<bool>, fits: bool| Candidate {
            model: model.into(),
            score,
            gen_tps: Some(tps),
            tools,
            fits,
        };
        let all = vec![
            c("big", Some(1.0), 8.0, Some(true), false),
            c("failed-tools", Some(1.0), 30.0, Some(false), true),
            c("qwen", Some(0.89), 29.0, Some(true), true),
            c("nemotron", Some(0.89), 23.0, Some(true), true),
            c("never-measured", None, 50.0, None, true),
        ];
        assert_eq!(pick_auto(&all, TaskClass::Agent).as_deref(), Some("qwen"), "same score, faster wins; no failed tools, no misfit");
        assert_eq!(pick_auto(&all, TaskClass::Text).as_deref(), Some("failed-tools"), "text needs no tools");
        assert_eq!(pick_auto(&[c("x", None, 1.0, None, true)], TaskClass::Agent), None, "nothing measured: no guess");
    }
}

