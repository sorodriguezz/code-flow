//! The PR review pipeline: from a diff to a set of judged findings.
//!
//! [`crate::review`] owns the mechanics — the contract, the outline, the bundles, the merge. This
//! module is what drives them: it loads the workspace's prompts and policy, decides how many
//! reviewers to run and what each one reads, runs them, and consolidates what they return.
//!
//! It stops one step short of the report on purpose. Reconciliation against the pull request's
//! saved memory is what assigns a finding its **stable** id, and the report has to carry that id
//! rather than a provisional one — so the caller reconciles, and only then renders. Everything
//! before that point is identical whether the review was launched from the panel, from a link, or
//! by an agent, which is why it lives here instead of in the command that happens to start it.

use std::collections::BTreeMap;

use futures_util::future::join_all;

use crate::ai;
use crate::db::queries;
use crate::review::bundle;
use crate::review::contract::{
    resolve_level_contract, LevelContract, ReviewEngineConfig, DEFAULT_LENSES,
};
use crate::review::merge::{self, Finding};
use crate::review::outline::{self, ChangedFile};
use crate::review::plan::{self, PlanMode, ReviewPlan, Skip};
use crate::review::{graph, hints};
use crate::ai_runs;
use crate::git;

use super::claude_cmd::AiConfig;

/// Prefix on the message a review returns when it stopped to ask. The frontend renders it as a
/// question with a "review anyway" action rather than as a failure — the same trick
/// [`ai_runs::CANCELLED_MARKER`] and [`ai::QUOTA_MARKER`] use.
pub const SKIP_MARKER: &str = "REVIEW_SKIPPED::";

/// How many past runs of the repository are read for historical hints. Well above the 25 hints that
/// survive deduplication, since one long-lived pull request can contribute several rows that
/// collapse into one hint.
const HINT_RUN_LIMIT: i64 = 120;

/// The four editable prompts a review runs on, already resolved for this workspace and level.
pub struct ReviewPrompts {
    /// The methodology and — critically — the output format. Everything else is layered on top.
    pub standard: String,
    /// The level's depth directive, with the contract's numbers already substituted in.
    pub level: String,
    /// What each parallel reviewer is told on top of the standard.
    pub worker: String,
    /// The cross-file pass.
    pub crossfile: String,
    /// The closing synthesis, for a review that fanned out.
    pub summary: String,
    /// The lens catalog, by number.
    pub lenses: BTreeMap<u8, String>,
}

/// Substitutes a level directive's placeholders with the contract's real numbers.
///
/// The numbers live in the contract and the prose lives in the prompt, so editing the wording can
/// never put the instruction and the filter that enforces it out of step — which is exactly what a
/// hand-written "confianza ≥ 60" does the first time somebody changes the threshold in settings.
fn apply_placeholders(text: &str, contract: &LevelContract) -> String {
    text.replace("{{NIVEL}}", &contract.level)
        .replace("{{MIN_CONFIANZA_BLOCKER}}", &contract.min_confidence_blocker.to_string())
        .replace("{{MIN_CONFIANZA}}", &contract.min_confidence.to_string())
        .replace("{{SEVERIDADES}}", &contract.severity_labels().join("/"))
        .replace(
            "{{LENTES}}",
            &contract.lenses.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", "),
        )
}

impl ReviewPrompts {
    /// Loads every review prompt of a workspace and resolves the level's placeholders.
    pub fn load(
        conn: &rusqlite::Connection,
        workspace_id: &str,
        contract: &LevelContract,
    ) -> Result<Self, String> {
        let get = |kind: &str| queries::get_workspace_prompt(conn, workspace_id, kind).map_err(|e| e.to_string());
        let level_kind = format!("review_level_{}", contract.level);
        let lenses_text = get("review_lenses").unwrap_or_else(|_| DEFAULT_LENSES.to_string());
        Ok(Self {
            standard: get("review_standard")?,
            level: apply_placeholders(&get(&level_kind)?, contract),
            worker: get("review_worker")?,
            crossfile: get("review_crossfile")?,
            summary: get("review_summary")?,
            lenses: crate::review::contract::parse_lenses(&lenses_text),
        })
    }

    /// The prompt one reviewer gets: the methodology, then the level's depth, then its role.
    ///
    /// The order is the contract between the three. The standard describes *how* to review, the
    /// level tunes *how deep*, and the role narrows *what this one reviewer owns* — so each layer
    /// has to be able to override the one before it.
    pub fn for_role(&self, role: Option<&str>) -> String {
        let mut out = format!("{}\n\n{}", self.standard, self.level);
        if let Some(role) = role {
            out.push_str("\n\n");
            out.push_str(role);
        }
        out
    }
}

/// What one review produced, before it is reconciled against the pull request's memory.
pub struct PipelineOutcome {
    pub findings: Vec<Finding>,
    /// The model's own prose from the pass that wrote any — the summary the report opens with.
    pub narrative: String,
    pub plan: ReviewPlan,
    /// Files whose content had to be trimmed out of a bundle to fit its budget.
    pub degraded: Vec<String>,
    /// How many reviewers actually ran, cross-file pass included.
    pub workers: usize,
    /// The model the CLI reported it actually ran, when it said. `None` when nothing was configured
    /// and the CLI picked its own default — a real state, and the review's signature says so rather
    /// than guessing.
    pub model: Option<String>,
}

/// A review that stopped before spending anything, because the plan says it probably should not run.
pub enum Pipeline {
    Reviewed(Box<PipelineOutcome>),
    Skipped(Skip),
}

/// Everything the pipeline needs that isn't the diff.
pub struct ReviewRequest<'a> {
    pub config: &'a AiConfig,
    pub repo_path: &'a str,
    /// The ref the pull request's head resolves to — what the new side of every file is read from.
    pub head_ref: &'a str,
    /// The target branch, for the blast radius: a caller matters because it exists in the code this
    /// pull request is merging *into*.
    pub target_ref: &'a str,
    pub pr_title: &'a str,
    pub pr_description: &'a str,
    /// `open` · `draft` · `merged` · `closed`, as the VCS layer already buckets it.
    pub pr_status: &'a str,
    pub contexts: Vec<(String, String)>,
    pub prompts: ReviewPrompts,
    pub engine: ReviewEngineConfig,
    pub contract: LevelContract,
    /// On a re-review, the files that moved since the previous run.
    pub changed_since: Option<Vec<String>>,
    /// Findings this repository already closed on these files, in other pull requests.
    pub hints: Vec<hints::Hint>,
    /// Whether the human already said "review it anyway" to a skip that asks.
    pub force: bool,
}

fn log(line: &str) {
    if let Some(ctx) = ai_runs::current() {
        ai_runs::emit_line(&ctx, "stdout", line);
    }
}

/// The outline handed to the cross-file pass: every touched file with its symbols, and no code.
///
/// Code is deliberately absent. The per-file reviewers already read it; this pass is looking for
/// what happens *between* files, and re-sending the bodies would buy nothing but tokens.
fn outline_payload(files: &[ChangedFile]) -> String {
    let mut out = String::from("=== OUTLINE DEL PR ===\n\n");
    for file in files {
        out.push_str(&format!("{} · {} · {} líneas\n", file.path, file.status, file.lines));
        for symbol in &file.symbols {
            out.push_str(&format!("  {}-{}  {}\n", symbol.start, symbol.end, symbol.label));
        }
        if file.symbols.is_empty() {
            out.push_str(&format!("  (sin símbolos reconocidos · {} líneas cambiadas)\n", file.changed.len()));
        }
        out.push('\n');
    }
    out
}

/// The consolidated findings, as the closing synthesis reads them: what each one is and why, and
/// none of the code they came from.
fn findings_digest(findings: &[Finding]) -> String {
    if findings.is_empty() {
        return "HALLAZGOS CONSOLIDADOS: ninguno.\n".to_string();
    }
    let mut out = String::from("HALLAZGOS CONSOLIDADOS:\n");
    for finding in findings {
        out.push_str(&format!(
            "- [{} · {}] {} · {} — {}\n",
            finding.severity.label(),
            finding.tipo.label(),
            finding.categoria,
            finding.archivo.as_deref().unwrap_or("sin ubicación"),
            finding.subtitulo,
        ));
        if !finding.por_que.is_empty() {
            out.push_str(&format!("  {}\n", finding.por_que));
        }
    }
    out
}

/// The findings of one reviewer, or the reason it produced none.
async fn run_reviewer(
    request: &ReviewRequest<'_>,
    prompt: &str,
    payload: &str,
    label: &str,
) -> Result<(String, Option<String>), String> {
    let run = ai::review_chunk(
        &*request.config.engine,
        &request.config.binary,
        &request.config.model,
        prompt,
        payload,
        &request.config.tools,
        request.repo_path,
    )
    .await;
    match run {
        Ok(run) => {
            let count = merge::parse(&run.text).len();
            log(&format!("✔ {label} · {count} hallazgo(s)"));
            Ok((run.text, run.model))
        }
        // A reviewer that failed must not take the whole review with it — the other groups looked
        // at real code and their findings are worth keeping. Cancellation is the exception: the user
        // stopped the run, so it propagates.
        Err(e) if e.starts_with(ai_runs::CANCELLED_MARKER) => Err(e),
        Err(e) => {
            log(&format!("✘ {label} · falló: {e}"));
            Ok((String::new(), None))
        }
    }
}

/// Runs one review end to end, up to (but not including) reconciliation.
pub async fn run(
    request: ReviewRequest<'_>,
    diff_files: &[git::diff::FileDiffInfo],
) -> Result<Pipeline, String> {
    let contract = request.contract.clone();

    // 1. What each changed file is: its content on the PR's side, the lines it moved, its symbols.
    let files = outline::build(request.repo_path, request.head_ref, diff_files);

    // 2. Scope, triage and the split into groups.
    let plan = plan::build(
        files,
        contract.clone(),
        &request.engine.scope,
        request.pr_status,
        request.changed_since.as_deref(),
    );

    if let Some(skip) = &plan.skip {
        if !skip.requires_confirmation || !request.force {
            return Ok(Pipeline::Skipped(skip.clone()));
        }
    }
    if plan.files.is_empty() {
        return Ok(Pipeline::Skipped(Skip {
            reason: "No hay archivos con contenido para revisar en este PR.".to_string(),
            requires_confirmation: false,
        }));
    }

    log(&format!(
        "▶ Plan: {} archivo(s) en {} grupo(s) · nivel {} · lentes {} · umbral {} (Blocker {})",
        plan.files.len(),
        plan.groups.len(),
        contract.level,
        contract.lenses.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(","),
        contract.min_confidence,
        contract.min_confidence_blocker,
    ));
    if !plan.out_of_scope.is_empty() {
        log(&format!("  {} archivo(s) fuera del alcance configurado", plan.out_of_scope.len()));
    }
    if plan.mode == PlanMode::Delta {
        log(&format!(
            "  re-revisión acotada a {} archivo(s) modificados · {} sin cambios desde la última corrida",
            plan.files.len(),
            plan.outside_delta.len(),
        ));
    }

    // 3. Extra context, gathered before anything is spent: what the repository's memory already
    //    settled about these files, and who else calls the symbols being touched.
    let mut contexts = request.contexts.clone();
    if let Some(block) = hints::block(&request.hints) {
        log(&format!("  {} pista(s) históricas sobre estos archivos", request.hints.len()));
        contexts.push(("Hallazgos ya evaluados en otros PRs de este repo".to_string(), block));
    }
    let impacts = graph::blast_radius(
        request.repo_path,
        request.target_ref,
        &plan.files,
        &request.engine.scope,
        &request.engine.graph,
    );
    if let Some(block) = graph::block(&impacts) {
        log(&format!("  {} símbolo(s) con referencias fuera del PR", impacts.len()));
        contexts.push(("Impacto fuera del PR (referencias)".to_string(), block));
    }
    let preamble = ai::review_preamble(request.pr_title, request.pr_description, &contexts);

    // 4. One bundle per group, then the reviewers.
    let bundles: Vec<bundle::Bundle> = plan
        .groups
        .iter()
        .map(|group| {
            bundle::render_group(
                group.id,
                plan.groups.len(),
                &plan.files_of(group),
                &contract,
                &request.prompts.lenses,
                &request.engine.bundles,
            )
        })
        .collect();
    for bundle in &bundles {
        log(&format!("  grupo {}: {}", bundle.group_id, bundle.files.join(", ")));
    }
    let degraded: Vec<String> = bundles.iter().flat_map(|b| b.degraded.clone()).collect();
    if !degraded.is_empty() {
        log(&format!("  contexto recortado por presupuesto en: {}", degraded.join(", ")));
    }

    let parallel = plan.parallel();
    let role = parallel.then_some(request.prompts.worker.as_str());
    let prompt = request.prompts.for_role(role);

    let mut replies: Vec<String> = Vec::new();
    let mut model: Option<String> = None;
    if parallel {
        // Batched rather than all at once: every worker is a full model invocation, so the cap is
        // about cost and rate limits, not about CPU.
        let limit = request.engine.workers.max_parallel.max(1);
        log(&format!("▶ {} revisores en paralelo (de a {limit})", bundles.len()));
        for batch in bundles.chunks(limit) {
            let running = batch.iter().map(|b| {
                let payload = format!("{preamble}{}", b.text);
                let label = format!("Grupo {}/{}", b.group_id, bundles.len());
                let prompt = prompt.clone();
                let request = &request;
                async move { run_reviewer(request, &prompt, &payload, &label).await }
            });
            for reply in join_all(running).await {
                let (text, ran) = reply?;
                model = model.or(ran);
                replies.push(text);
            }
        }
    } else {
        // One reviewer: it sees every bundle at once and writes the report's prose too, so it gets
        // no worker role — the role's whole job is to stop a reviewer from summarising work it only
        // did part of.
        let payload = bundles.iter().fold(preamble.clone(), |mut acc, b| {
            acc.push_str(&b.text);
            acc.push('\n');
            acc
        });
        log("▶ 1 revisor (una sola pasada)");
        let (text, ran) = run_reviewer(&request, &prompt, &payload, "Revisión").await?;
        model = model.or(ran);
        replies.push(text);
    }

    // 5. The pass no single-file reviewer can do. Only worth it once there is more than one file to
    //    be inconsistent *between*.
    let mut workers = replies.len();
    if contract.cross_file && plan.files.len() > 1 {
        let payload = format!("{preamble}{}", outline_payload(&plan.files));
        let prompt = request.prompts.for_role(Some(&request.prompts.crossfile));
        let (text, ran) = run_reviewer(&request, &prompt, &payload, "Pase cruzado").await?;
        model = model.or(ran);
        replies.push(text);
        workers += 1;
    }

    // 6. Merge, dedupe, apply the contract, order, number.
    let (findings, discarded, merged) = merge::consolidate(&replies, &contract, 1);
    if merged > 0 {
        log(&format!("  {merged} hallazgo(s) duplicados fusionados"));
    }
    for drop in &discarded {
        log(&format!(
            "  descartado: {}:{} ({}) — {}",
            drop.finding.archivo.as_deref().unwrap_or("?"),
            drop.finding.lineas.as_deref().unwrap_or("?"),
            if drop.finding.categoria.is_empty() { "sin categoría" } else { &drop.finding.categoria },
            drop.reason,
        ));
    }
    log(&format!("▶ {} hallazgo(s) tras consolidar", findings.len()));

    // 7. The report's opening prose. With one reviewer it is free — it saw everything, so it wrote
    //    the summary as part of its answer. With several, nobody is in a position to: each saw a
    //    slice, and a summary written from a slice describes the whole pull request wrongly. So it
    //    becomes its own small pass over the consolidated findings, with no code in it.
    let narrative = if !parallel {
        crate::review::render::strip_grades(&merge::preamble(replies.first().map(String::as_str).unwrap_or("")))
    } else {
        let payload = format!("{preamble}{}", findings_digest(&findings));
        let (text, ran) = run_reviewer(&request, &request.prompts.summary, &payload, "Resumen").await?;
        model = model.or(ran);
        workers += 1;
        crate::review::render::strip_grades(&merge::preamble(&text))
    };

    Ok(Pipeline::Reviewed(Box::new(PipelineOutcome {
        findings,
        narrative,
        plan,
        degraded,
        workers,
        model,
    })))
}

/// Resolves the level's contract for a workspace, reading its stored engine configuration.
pub fn contract_for(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    level: &str,
) -> (ReviewEngineConfig, LevelContract) {
    let config = queries::get_review_engine_config(conn, workspace_id);
    let contract = resolve_level_contract(level, &config);
    (config, contract)
}

/// The historical hints for the files a pull request touches — what this repository already settled
/// about them, in other pull requests.
pub fn hints_for(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    repo_key: &str,
    pr_id: i64,
    paths: &[String],
) -> Vec<hints::Hint> {
    let runs = queries::review_runs_for_repo(conn, workspace_id, repo_key, pr_id, HINT_RUN_LIMIT)
        .unwrap_or_default();
    hints::for_paths(&runs, paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::contract::ReviewEngineConfig;

    fn contract(level: &str) -> LevelContract {
        resolve_level_contract(level, &ReviewEngineConfig::default())
    }

    #[test]
    fn a_level_directive_carries_the_contracts_real_numbers() {
        let text = "Nivel {{NIVEL}}: reporta {{SEVERIDADES}} con confianza >= {{MIN_CONFIANZA}} \
                    (Blocker >= {{MIN_CONFIANZA_BLOCKER}}). Lentes {{LENTES}}.";
        let out = apply_placeholders(text, &contract("completo"));
        assert!(out.contains("Nivel completo"));
        assert!(out.contains("confianza >= 60"));
        assert!(out.contains("Blocker >= 50"));
        assert!(out.contains("Blocker/Crítico/Mayor/Menor"));
        assert!(out.contains("Lentes 1, 2, 3, 4, 5"));
        assert!(!out.contains("{{"), "no placeholder survives");
    }

    /// `{{MIN_CONFIANZA}}` is a prefix of `{{MIN_CONFIANZA_BLOCKER}}`, so the order of the
    /// replacements is load-bearing.
    #[test]
    fn the_blocker_threshold_is_not_eaten_by_the_general_one() {
        let out = apply_placeholders("{{MIN_CONFIANZA_BLOCKER}}", &contract("completo"));
        assert_eq!(out, "50");
    }

    #[test]
    fn the_prompt_layers_the_role_last_so_it_can_override() {
        let prompts = ReviewPrompts {
            standard: "ESTÁNDAR".into(),
            level: "NIVEL".into(),
            worker: "ROL".into(),
            crossfile: "CRUZADO".into(),
            summary: "RESUMEN".into(),
            lenses: BTreeMap::new(),
        };
        let solo = prompts.for_role(None);
        assert_eq!(solo, "ESTÁNDAR\n\nNIVEL");
        let worker = prompts.for_role(Some(&prompts.worker));
        assert!(worker.starts_with("ESTÁNDAR\n\nNIVEL"));
        assert!(worker.ends_with("ROL"));
    }

    #[test]
    fn the_cross_file_payload_carries_symbols_and_no_code() {
        use crate::review::outline::Symbol;
        let file = ChangedFile {
            path: "src/a.ts".into(),
            status: "modified".into(),
            content: "const secreto = 1;\n".into(),
            lines: 1,
            changed: [1].into_iter().collect(),
            deletions: 0,
            symbols: vec![Symbol { start: 1, end: 1, label: "function pagar()".into() }],
        };
        let payload = outline_payload(&[file]);
        assert!(payload.contains("src/a.ts"));
        assert!(payload.contains("function pagar()"));
        assert!(!payload.contains("const secreto"), "the bodies stay out");
    }

    #[test]
    fn a_file_with_no_symbols_still_appears_in_the_outline() {
        let file = ChangedFile {
            path: "config.json".into(),
            status: "modified".into(),
            content: "{}\n".into(),
            lines: 1,
            changed: [1].into_iter().collect(),
            deletions: 0,
            symbols: vec![],
        };
        let payload = outline_payload(&[file]);
        assert!(payload.contains("config.json"));
        assert!(payload.contains("sin símbolos reconocidos"));
    }
}
