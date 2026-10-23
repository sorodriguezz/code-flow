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
//!
//! **Where the time and the tokens go, and what this does about it.** A review is a handful of
//! model invocations, and each one costs a process start, the CLI's own system prompt and whatever
//! it reads. So:
//! - every reviewer gets only the context about *its* files ([`context`]), not N copies of all of it;
//! - the workers run through one bounded pool (a slow group no longer holds up a whole batch), and
//!   the cross-file pass — which needs nothing the workers produce — runs beside them, not after;
//! - the closing pass is skipped outright when there is nothing to summarise or answer, runs on the
//!   engine's fast model when it only summarises, and doubles as the verification when it must judge;
//! - each pass thinks as hard as the level pays for ([`LevelContract::effort`]).

use std::collections::BTreeMap;

use futures_util::stream::{self, StreamExt};

use crate::ai;
use crate::ai_runs;
use crate::db::queries;
use crate::git;
use crate::review::bundle;
use crate::review::context::{self, Audience, ReviewInputs};
use crate::review::contract::{resolve_level_contract, LevelContract, ReviewEngineConfig, DEFAULT_LENSES};
use crate::review::graph::{self, Impact};
use crate::review::hints;
use crate::review::merge::{self, Discarded, Finding};
use crate::review::outline::{self, same_path, ChangedFile};
use crate::review::plan::{self, PlanMode, ReviewPlan, Skip};
use crate::review::render::Checking;
use crate::review::verify::{self, Sources};
use crate::review_memory::FpSuppression;

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
    /// How many reviewers actually ran, cross-file and closing passes included.
    pub workers: usize,
    /// The model the CLI reported it actually ran, when it said. `None` when nothing was configured
    /// and the CLI picked its own default — a real state, and the review's signature says so rather
    /// than guessing.
    pub model: Option<String>,
    /// Files whose reviewer failed. Their earlier findings must not be read as fixed.
    pub unreviewed: Vec<String>,
    /// The other passes that failed, by name — said in the report.
    pub failed_passes: Vec<String>,
    /// Whether findings with no file could have been lost to a failure (see `review_memory::Unread`).
    pub unlocated_unread: bool,
    /// What the checks between the reviewers and the report did.
    pub checking: Checking,
    /// What the run spent, every pass summed.
    pub cost: crate::review_memory::RunCost,
}

/// A review that stopped before spending anything, because the plan says it probably should not run.
pub enum Pipeline {
    Reviewed(Box<PipelineOutcome>),
    Skipped(Skip),
}

/// Everything the pipeline needs that isn't the diff.
pub struct ReviewRequest<'a> {
    pub config: &'a AiConfig,
    /// The user's clone — where the outline, the blast radius and every git read come from.
    pub repo_path: &'a str,
    /// Where the reviewers run: a checkout of the PR's head (see `review::checkout`), so whatever
    /// they open beyond their bundle is the PR's code. The clone itself when that could not be made.
    pub tools_cwd: &'a str,
    /// The ref the pull request's head resolves to — what the new side of every file is read from.
    pub head_ref: &'a str,
    /// The target branch, for the blast radius: a caller matters because it exists in the code this
    /// pull request is merging *into*.
    pub target_ref: &'a str,
    pub pr_title: &'a str,
    pub pr_description: &'a str,
    /// `open` · `draft` · `merged` · `closed`, as the VCS layer already buckets it.
    pub pr_status: &'a str,
    /// Everything known besides the code, uncut — each reviewer gets its own share.
    pub inputs: ReviewInputs,
    pub prompts: ReviewPrompts,
    pub engine: ReviewEngineConfig,
    pub contract: LevelContract,
    /// On a re-review, the files that moved since the previous run.
    pub changed_since: Option<Vec<String>>,
    /// Whether the human already said "review it anyway" to a skip that asks.
    pub force: bool,
    /// What the passes spent so far — every pass adds to it, the concurrent ones included.
    pub cost: std::sync::Mutex<crate::review_memory::RunCost>,
}

fn log(line: &str) {
    if let Some(ctx) = ai_runs::current() {
        ai_runs::emit_line(&ctx, "stdout", line);
    }
}

/// The outline handed to the cross-file pass: every touched file with its symbols, and no code —
/// plus what the PR deleted outright, which no other reader sees.
///
/// Code is deliberately absent. The per-file reviewers already read it; this pass is looking for
/// what happens *between* files, and re-sending the bodies would buy nothing but tokens.
fn outline_payload(files: &[ChangedFile], deleted: &[ChangedFile]) -> String {
    let mut out = String::from("=== OUTLINE DEL PR ===\n\n");
    for file in files {
        out.push_str(&format!("{} · {} · {} líneas\n", file.path, file.status, file.lines));
        for symbol in &file.symbols {
            out.push_str(&format!("  {}-{}  {}\n", symbol.start, symbol.end, symbol.label));
        }
        if file.symbols.is_empty() {
            out.push_str(&format!("  (sin símbolos reconocidos · {} líneas cambiadas)\n", file.changed.len()));
        }
        if file.deletions > 0 {
            out.push_str(&format!("  ({} línea(s) eliminadas)\n", file.deletions));
        }
        out.push('\n');
    }
    if let Some(block) = bundle::deleted_block(deleted) {
        out.push_str(&block);
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
            "- {} [{} · {}] {} · {} — {}\n",
            finding.id,
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

/// What one pass came back with. A failure is data rather than an error, so one reviewer that died
/// cannot take the others' work down with it — but it is *recorded*, never quietly turned into an
/// empty answer that reads as "found nothing".
struct Reply {
    text: String,
    model: Option<String>,
    failed: Option<String>,
}

/// Which model and how much thought a pass gets.
struct PassModel<'a> {
    model: &'a str,
    effort: Option<&'a str>,
}

/// One pass, or the reason it produced nothing. `Err` only for a cancellation: the user stopped the
/// run, so it propagates.
async fn run_pass(request: &ReviewRequest<'_>, prompt: &str, payload: &str, label: &str, with: PassModel<'_>) -> Result<Reply, String> {
    let run = ai::review_pass(
        &*request.config.engine,
        &request.config.binary,
        prompt,
        payload,
        ai::ReviewPass { model: with.model, effort: with.effort, cwd: request.tools_cwd, fallback_tools: &request.config.tools },
    )
    .await;
    match run {
        Ok(run) => {
            let count = merge::parse(&run.text).len();
            log(&format!("✔ {label} · {count} hallazgo(s)"));
            if let Ok(mut cost) = request.cost.lock() {
                cost.add(run.usage.as_ref());
            }
            Ok(Reply { text: run.text, model: run.model, failed: None })
        }
        Err(e) if e.starts_with(ai_runs::CANCELLED_MARKER) => Err(e),
        Err(e) => {
            log(&format!("✘ {label} · falló: {e}"));
            // A pass that failed may well have spent something — but it said nothing to count.
            if let Ok(mut cost) = request.cost.lock() {
                cost.add(None);
            }
            Ok(Reply { text: String::new(), model: None, failed: Some(e) })
        }
    }
}

/// One unit of the fan-out.
enum Job {
    Group(usize),
    CrossFile,
}

/// The impacts one group's reviewer is told about: the ones declared in its files — plus, for the
/// first group when no cross-file pass will run, the ones declared in files nobody reviews (the
/// deleted ones), so a removed function's callers still reach somebody.
fn impacts_for(impacts: &[Impact], paths: &[String], orphans: bool, reviewed: &[String]) -> Vec<Impact> {
    impacts
        .iter()
        .filter(|i| {
            paths.iter().any(|p| same_path(p, &i.file)) || (orphans && !reviewed.iter().any(|p| same_path(p, &i.file)))
        })
        .cloned()
        .collect()
}

/// The repository's standing rule that denies this finding, unless the finding argues it is a
/// different case — which the rule's own prompt invites it to do, in its "why".
fn denied_by<'a>(finding: &Finding, rules: &'a [FpSuppression]) -> Option<&'a FpSuppression> {
    let argues = {
        let why = finding.por_que.to_lowercase();
        ["descart", "falso positivo", "a diferencia", "distinto del", "regla"].iter().any(|w| why.contains(w))
    };
    if argues {
        return None;
    }
    rules.iter().find(|r| r.matches(&finding.categoria, finding.archivo.as_deref()))
}

/// Runs one review end to end, up to (but not including) reconciliation.
pub async fn run(
    request: ReviewRequest<'_>,
    diff_files: &[git::diff::FileDiffInfo],
) -> Result<Pipeline, String> {
    let started = std::time::Instant::now();
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
    if plan.files.is_empty() && plan.deleted.is_empty() {
        return Ok(Pipeline::Skipped(Skip {
            reason: "No hay archivos con contenido para revisar en este PR.".to_string(),
            requires_confirmation: false,
        }));
    }

    log(&format!(
        "▶ Plan: {} archivo(s) en {} grupo(s) · nivel {} · lentes {} · umbral {} (Blocker {}){}",
        plan.files.len(),
        plan.groups.len(),
        contract.level,
        contract.lenses.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(","),
        contract.min_confidence,
        contract.min_confidence_blocker,
        if contract.effort.is_empty() { String::new() } else { format!(" · esfuerzo {}", contract.effort) },
    ));
    if !plan.deleted.is_empty() {
        log(&format!("  {} archivo(s) eliminados", plan.deleted.len()));
    }
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
    if request.tools_cwd != request.repo_path {
        log("  los revisores leen una copia del commit del PR (solo lectura)");
    }

    // 3. Who else calls the symbols being touched — deleted files included, whose every symbol is
    //    removed. Off the async worker: the first review of a branch parses its tree (`codemap`).
    let impacts = {
        let mut touched = plan.files.clone();
        touched.extend(plan.deleted.iter().cloned());
        let (repo, target, scope, cfg, references) = (
            request.repo_path.to_string(),
            request.target_ref.to_string(),
            request.engine.scope.clone(),
            request.engine.graph.clone(),
            request.inputs.references.clone(),
        );
        tokio::task::spawn_blocking(move || graph::blast_radius(&repo, &target, &touched, &scope, &cfg, &references)).await.unwrap_or_default()
    };
    let in_references = impacts.iter().filter(|impact| impact.repo.is_some()).count();
    if impacts.len() > in_references {
        let contracts = impacts.iter().filter(|impact| impact.repo.is_none() && impact.change.is_some()).count();
        log(&format!(
            "  {} símbolo(s) con referencias fuera del PR{}",
            impacts.len() - in_references,
            if contracts > 0 { format!(" · {contracts} con cambio de firma o eliminados") } else { String::new() }
        ));
    }
    if in_references > 0 {
        log(&format!("  {in_references} contrato(s) que cambian también se usan en repositorios de referencia"));
    }
    if !request.inputs.hints.is_empty() {
        log(&format!("  {} pista(s) históricas sobre estos archivos", request.inputs.hints.len()));
    }

    // 4. One bundle per group.
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
    let cross_file = contract.cross_file && plan.files.len() + plan.deleted.len() > 1;
    let effort = Some(contract.effort.as_str()).filter(|e| !e.is_empty());
    let review_model = PassModel { model: &request.config.model, effort };
    let reviewed: Vec<String> = plan.files.iter().map(|f| f.path.clone()).collect();

    let mut replies: Vec<String> = Vec::new();
    let mut model: Option<String> = None;
    let mut unreviewed: Vec<String> = Vec::new();
    let mut failed_passes: Vec<String> = Vec::new();
    let mut workers = 0usize;
    let single_reply: Option<Reply>;

    if parallel {
        // One bounded pool for every pass that reads code: the groups, and the cross-file pass,
        // which needs nothing the groups produce and so starts with them instead of after them.
        // Bounded because each is a full model invocation (cost and rate limits, not CPU); a pool
        // rather than batches so one slow group no longer holds the next batch back.
        let limit = request.engine.workers.max_parallel.max(1);
        let mut jobs: Vec<Job> = Vec::new();
        if cross_file {
            jobs.push(Job::CrossFile);
        }
        jobs.extend((0..bundles.len()).map(Job::Group));
        log(&format!(
            "▶ {} revisores en paralelo (hasta {limit} a la vez){}",
            bundles.len(),
            if cross_file { " + pase cruzado" } else { "" }
        ));
        let worker_prompt = request.prompts.for_role(Some(request.prompts.worker.as_str()));
        let cross_prompt = request.prompts.for_role(Some(request.prompts.crossfile.as_str()));
        let request_ref = &request;
        let results: Vec<(Job, Result<Reply, String>)> = stream::iter(jobs)
            .map(|job| {
                let (prompt, payload, label) = match &job {
                    Job::Group(i) => {
                        let b = &bundles[*i];
                        let group_impacts = impacts_for(&impacts, &b.files, *i == 0 && !cross_file, &reviewed);
                        let contexts = context::contexts_for(&request_ref.inputs, &group_impacts, Audience::Group(&b.files));
                        let mut payload = ai::review_preamble(request_ref.pr_title, request_ref.pr_description, &contexts);
                        payload.push_str(&b.text);
                        if *i == 0 && !cross_file {
                            if let Some(block) = bundle::deleted_block(&plan.deleted) {
                                payload.push_str(&block);
                            }
                        }
                        (worker_prompt.clone(), payload, format!("Grupo {}/{}", b.group_id, bundles.len()))
                    }
                    Job::CrossFile => {
                        let contexts = context::contexts_for(&request_ref.inputs, &impacts, Audience::CrossFile);
                        let mut payload = ai::review_preamble(request_ref.pr_title, request_ref.pr_description, &contexts);
                        payload.push_str(&outline_payload(&plan.files, &plan.deleted));
                        (cross_prompt.clone(), payload, "Pase cruzado".to_string())
                    }
                };
                let with = PassModel { model: &request_ref.config.model, effort };
                async move {
                    let reply = run_pass(request_ref, &prompt, &payload, &label, with).await;
                    (job, reply)
                }
            })
            .buffered(limit)
            .collect()
            .await;

        let mut groups_failed = 0usize;
        let mut first_error: Option<String> = None;
        for (job, reply) in results {
            let reply = reply?;
            workers += 1;
            if let Some(error) = reply.failed {
                first_error.get_or_insert(error);
                match job {
                    Job::Group(i) => {
                        groups_failed += 1;
                        unreviewed.extend(bundles[i].files.iter().cloned());
                    }
                    Job::CrossFile => failed_passes.push("pase cruzado".to_string()),
                }
                continue;
            }
            model = model.or(reply.model);
            replies.push(reply.text);
        }
        // Nothing reviewed at all is a failed review, not an empty one. Returned as an error so no
        // run is saved — saving it would resolve every open finding of this PR.
        if groups_failed == bundles.len() && !bundles.is_empty() {
            return Err(format!(
                "Ningún revisor pudo terminar ({groups_failed} de {}). {}",
                bundles.len(),
                first_error.unwrap_or_default()
            ));
        }
        single_reply = None;
    } else {
        // One reviewer: it sees every bundle at once — after ONE header rather than one per group —
        // and writes the report's prose too, so it gets no worker role: the role's whole job is to
        // stop a reviewer from summarising work it only did part of.
        let contexts = context::contexts_for(&request.inputs, &impacts, Audience::All);
        let mut payload = ai::review_preamble(request.pr_title, request.pr_description, &contexts);
        payload.push_str(&bundle::header(1, 1, plan.files.len(), &contract, &request.prompts.lenses));
        for b in &bundles {
            payload.push_str(&b.body);
            payload.push('\n');
        }
        if let Some(block) = bundle::deleted_block(&plan.deleted) {
            payload.push_str(&block);
        }
        let prompt = request.prompts.for_role(None);
        // A level that reviews in one pass but still looks across files (completo on a small PR):
        // the cross-file pass reads only the outline, so it runs beside the reviewer, not after it —
        // unless the workspace caps the parallelism at one.
        let cross = cross_file.then(|| {
            let contexts = context::contexts_for(&request.inputs, &impacts, Audience::CrossFile);
            let mut payload = ai::review_preamble(request.pr_title, request.pr_description, &contexts);
            payload.push_str(&outline_payload(&plan.files, &plan.deleted));
            (request.prompts.for_role(Some(&request.prompts.crossfile)), payload)
        });
        let together = cross.is_some() && request.engine.workers.max_parallel >= 2;
        log(match (&cross, together) {
            (Some(_), true) => "▶ 1 revisor + pase cruzado, en paralelo",
            (Some(_), false) => "▶ 1 revisor, luego el pase cruzado",
            (None, _) => "▶ 1 revisor (una sola pasada)",
        });
        let run_cross = || async {
            match &cross {
                Some((prompt, payload)) => {
                    Some(run_pass(&request, prompt, payload, "Pase cruzado", PassModel { model: &request.config.model, effort }).await)
                }
                None => None,
            }
        };
        let (reply, cross_reply) = if together {
            tokio::join!(run_pass(&request, &prompt, &payload, "Revisión", review_model), run_cross())
        } else {
            let reply = run_pass(&request, &prompt, &payload, "Revisión", review_model).await;
            let failed = !matches!(&reply, Ok(r) if r.failed.is_none());
            (reply, if failed { None } else { run_cross().await })
        };
        let reply = reply?;
        workers += 1;
        if let Some(error) = &reply.failed {
            // The only reviewer failed: there is no review. Never saved as an empty one.
            return Err(error.clone());
        }
        model = model.or(reply.model.clone());
        replies.push(reply.text.clone());
        if let Some(cross) = cross_reply {
            let cross = cross?;
            workers += 1;
            match cross.failed {
                Some(_) => failed_passes.push("pase cruzado".to_string()),
                None => {
                    model = model.or(cross.model);
                    replies.push(cross.text);
                }
            }
        }
        single_reply = Some(reply);
    }

    // 5. Merge and dedupe, then hold every finding to the code it names, then the contract.
    let mut all: Vec<Finding> = replies.iter().flat_map(|r| merge::parse(r)).collect();
    for finding in all.iter_mut() {
        finding.id.clear();
    }
    let (deduped, merged) = merge::dedupe(all);
    if merged > 0 {
        log(&format!("  {merged} hallazgo(s) duplicados fusionados"));
    }
    let outside = |path: &str| git::diff::file_at_ref(request.repo_path, request.head_ref, path).ok();
    let sources = Sources { files: &plan.files, deleted: &plan.deleted, outside: &outside };
    let grounding = verify::ground(deduped, &sources, &contract);
    for (what, from, to) in &grounding.relocated {
        log(&format!("  ubicación corregida por su evidencia: {what} {from} → {to}"));
    }
    let mut checking = Checking { ungrounded: grounding.discarded.len(), relocated: grounding.relocated.len(), ..Default::default() };
    let (survivors, mut discarded) = merge::filter(grounding.findings, &contract);
    discarded.extend(grounding.discarded);

    // The repository's standing false positives, enforced here rather than only asked for in the
    // prompt: a model that ignores the rule should not cost a human the same ruling twice.
    let mut findings: Vec<Finding> = Vec::with_capacity(survivors.len());
    for finding in survivors {
        match denied_by(&finding, &request.inputs.rules) {
            Some(rule) => discarded.push(Discarded {
                reason: format!("regla de falso positivo del repositorio ({}): {}", rule.categoria, rule.motivo),
                finding,
            }),
            None => findings.push(finding),
        }
    }
    merge::sort(&mut findings);
    merge::number(&mut findings, 1);

    // 6. The second look the level pays for, and the report's opening prose.
    let picks = verify::candidates(&findings, &contract);
    let pick_ids: Vec<String> = picks.iter().map(|i| findings[*i].id.clone()).collect();
    let closing_contexts = context::contexts_for(&request.inputs, &[], Audience::Closing);
    let mut narrative = String::new();

    if parallel {
        let has_conversation = context::has_conversation(&request.inputs);
        if findings.is_empty() && !has_conversation {
            // Nothing to summarise and nobody to answer: a fixed sentence (the report's own) costs
            // nothing, and a model call to write it would.
            log("  sin hallazgos ni conversación: el cierre no necesita al modelo");
        } else {
            let mut prompt = request.prompts.summary.clone();
            let mut payload = ai::review_preamble(request.pr_title, request.pr_description, &closing_contexts);
            payload.push_str(&findings_digest(&findings));
            // Judging needs the review model; summarising does not — the engine's fast model writes
            // three sentences as well, in a fraction of the time.
            let fast = request.config.engine.commit_message_model();
            let with = if picks.is_empty() {
                PassModel { model: if fast.is_empty() { request.config.model.as_str() } else { fast }, effort: Some(ai::effort::LOW) }
            } else {
                prompt.push_str(verify::CLOSING_VERIFY_NOTE);
                payload.push('\n');
                payload.push_str(&verify::payload(&findings, &picks, &sources));
                PassModel { model: &request.config.model, effort }
            };
            let label = if picks.is_empty() { "Resumen".to_string() } else { format!("Verificación ({}) y resumen", picks.len()) };
            let reply = run_pass(&request, &prompt, &payload, &label, with).await?;
            workers += 1;
            match reply.failed {
                Some(_) => failed_passes.push(if picks.is_empty() { "resumen" } else { "verificación y resumen" }.to_string()),
                None => {
                    if !picks.is_empty() {
                        let verdicts = verify::parse_verdicts(&reply.text);
                        let (kept, refuted) = verify::apply(findings, &pick_ids, &verdicts);
                        checking.verified = picks.len();
                        checking.refuted = refuted.len();
                        discarded.extend(refuted);
                        findings = kept;
                    }
                    narrative = crate::review::render::strip_grades(&merge::preamble(&verify::strip_verdicts(&reply.text)));
                }
            }
        }
    } else {
        let reply = single_reply.expect("a single reviewer's reply");
        narrative = crate::review::render::strip_grades(&merge::preamble(&reply.text));
        if !picks.is_empty() {
            let contexts = &request.inputs.contexts;
            let mut payload = ai::review_preamble(request.pr_title, request.pr_description, contexts);
            payload.push_str(&verify::payload(&findings, &picks, &sources));
            let label = format!("Verificación ({})", picks.len());
            let reply = run_pass(&request, verify::VERIFY_ROLE, &payload, &label, PassModel { model: &request.config.model, effort }).await?;
            workers += 1;
            match reply.failed {
                Some(_) => failed_passes.push("verificación".to_string()),
                None => {
                    let verdicts = verify::parse_verdicts(&reply.text);
                    let (kept, refuted) = verify::apply(findings, &pick_ids, &verdicts);
                    checking.verified = picks.len();
                    checking.refuted = refuted.len();
                    discarded.extend(refuted);
                    findings = kept;
                }
            }
        }
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
    log(&format!("▶ {} hallazgo(s) tras consolidar y verificar", findings.len()));

    let unlocated_unread = !unreviewed.is_empty() || failed_passes.iter().any(|p| p == "pase cruzado");
    let mut cost = request.cost.lock().map(|cost| cost.clone()).unwrap_or_default();
    cost.duration_ms = started.elapsed().as_millis() as u64;
    if cost.passes > 0 {
        log(&format!("💸 {}", cost.line()));
    }
    Ok(Pipeline::Reviewed(Box::new(PipelineOutcome {
        findings,
        narrative,
        plan,
        degraded,
        workers,
        model,
        unreviewed,
        failed_passes,
        unlocated_unread,
        checking,
        cost,
    })))
}

/// What a review would read and roughly cost, without running it — shown beside the level picker so
/// "ultra" on a 90-file PR is a choice made knowing its price.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPreview {
    pub files: usize,
    pub deleted: usize,
    pub out_of_scope: usize,
    pub groups: usize,
    /// Model invocations it will make at most: the reviewers, the cross-file pass, the closing pass.
    pub passes: usize,
    /// Files whose content will not fit their group's budget.
    pub degraded: usize,
    /// What CodeFlow itself sends, in tokens (roughly) — not what the model reads on its own after.
    pub input_tokens: usize,
    /// A re-review bounded to what changed since the last run.
    pub delta: bool,
    /// The plan would stop to ask (a draft, an enormous PR) or skip.
    pub skip: Option<Skip>,
}

/// Characters per token, roughly, for the mix a review sends (Spanish prose and code).
const CHARS_PER_TOKEN: usize = 4;

/// The plan and the bundles of a review, measured instead of sent.
#[allow(clippy::too_many_arguments)]
pub fn preview(
    repo_path: &str,
    head_ref: &str,
    diff_files: &[git::diff::FileDiffInfo],
    contract: &LevelContract,
    engine: &ReviewEngineConfig,
    prompts: &ReviewPrompts,
    pr_status: &str,
    changed_since: Option<&[String]>,
    preamble_chars: usize,
) -> ReviewPreview {
    let files = outline::build(repo_path, head_ref, diff_files);
    let plan = plan::build(files, contract.clone(), &engine.scope, pr_status, changed_since);
    let bundles: Vec<bundle::Bundle> = plan
        .groups
        .iter()
        .map(|g| bundle::render_group(g.id, plan.groups.len(), &plan.files_of(g), contract, &prompts.lenses, &engine.bundles))
        .collect();
    let parallel = plan.parallel();
    let cross_file = contract.cross_file && plan.files.len() + plan.deleted.len() > 1;
    let mut chars = 0usize;
    let mut passes = 0usize;
    if parallel {
        let prompt = prompts.for_role(Some(&prompts.worker)).len();
        for b in &bundles {
            chars += prompt + preamble_chars + b.text.len();
            passes += 1;
        }
        // The closing pass: the summary prompt and a digest of the findings — a few hundred characters each.
        chars += prompts.summary.len() + preamble_chars + 3_000;
        passes += 1;
    } else if !bundles.is_empty() {
        chars += prompts.for_role(None).len() + preamble_chars + bundles.iter().map(|b| b.body.len()).sum::<usize>() + 2_000;
        passes += 1;
    }
    if cross_file {
        chars += prompts.for_role(Some(&prompts.crossfile)).len() + preamble_chars + outline_payload(&plan.files, &plan.deleted).len();
        passes += 1;
    }
    ReviewPreview {
        files: plan.files.len(),
        deleted: plan.deleted.len(),
        out_of_scope: plan.out_of_scope.len(),
        groups: plan.groups.len(),
        passes,
        degraded: bundles.iter().map(|b| b.degraded.len()).sum(),
        input_tokens: chars / CHARS_PER_TOKEN,
        delta: plan.mode == PlanMode::Delta,
        skip: plan.skip.clone(),
    }
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
            removed: vec![],
        };
        let payload = outline_payload(&[file], &[]);
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
            removed: vec![],
        };
        let payload = outline_payload(&[file], &[]);
        assert!(payload.contains("config.json"));
        assert!(payload.contains("sin símbolos reconocidos"));
    }

    fn rule(categoria: &str) -> FpSuppression {
        FpSuppression {
            id: "r".into(),
            repo_key: "github:github.com/acme/app".into(),
            categoria: categoria.into(),
            archivo: None,
            motivo: "se valida en el middleware".into(),
            pr_id: 1,
            created_at: String::new(),
        }
    }

    /// A standing false positive silences its category in code — unless the finding makes the case
    /// that this one is different, which is what the rule's prompt asks of it.
    #[test]
    fn a_repository_rule_is_enforced_unless_the_finding_argues_otherwise() {
        let parse_one = |why: &str| {
            merge::parse(&format!("### ⚠️ [Mayor · Bug] Missing validation · F-001\n\nx\n\n📍 Ubicación: a.ts:1\n\n💭 Por qué: {why}\n\n🎯 Confianza: 80")).remove(0)
        };
        let rules = vec![rule("missing-validation")];
        assert!(denied_by(&parse_one("no valida el monto"), &rules).is_some());
        assert!(denied_by(&parse_one("A diferencia del descarte previo, aquí no pasa por el middleware"), &rules).is_none());
        assert!(denied_by(&parse_one("no valida el monto"), &[rule("sql-injection")]).is_none());
    }

    #[test]
    fn a_group_hears_about_its_own_impacts_and_the_first_one_about_the_orphans() {
        let impact = |file: &str| Impact { symbol: "s".into(), file: file.into(), callers: vec![], callers_total: 0, change: None, repo: None };
        let all = vec![impact("src/a.ts"), impact("src/b.ts"), impact("src/gone.ts")];
        let reviewed = vec!["src/a.ts".to_string(), "src/b.ts".to_string()];
        let mine = vec!["src/a.ts".to_string()];
        assert_eq!(impacts_for(&all, &mine, false, &reviewed).len(), 1);
        let with_orphans = impacts_for(&all, &mine, true, &reviewed);
        assert_eq!(with_orphans.iter().map(|i| i.file.as_str()).collect::<Vec<_>>(), vec!["src/a.ts", "src/gone.ts"]);
    }
}

/// The pipeline run against a scripted engine — real processes, real parsing, no model. Unix-only:
/// the script is a `/bin/sh` one-liner that answers by what it is asked.
#[cfg(all(test, unix))]
mod pipeline_tests {
    use super::*;
    use crate::ai::{AiEngine, AiInvocation, AiRun};
    use crate::git::diff::{DiffHunkInfo, DiffLine, FileDiffInfo};
    use tokio::process::Command;

    /// Replies with whatever `script` prints; a non-zero exit is a failed run.
    struct ScriptEngine {
        script: String,
    }

    impl AiEngine for ScriptEngine {
        fn id(&self) -> &'static str {
            "script"
        }
        fn label(&self) -> &'static str {
            "Script"
        }
        fn default_binary(&self) -> &'static str {
            "/bin/sh"
        }
        fn commit_message_model(&self) -> &'static str {
            "fast"
        }
        fn fix_tools(&self) -> Vec<String> {
            Vec::new()
        }
        fn build_command(&self, _binary: &str, inv: &AiInvocation) -> Command {
            let mut cmd = crate::proc::command("/bin/sh");
            // The ask goes in as an argument and the data on stdin, as with the real CLIs.
            cmd.arg("-c").arg(&self.script).arg("sh").arg(inv.prompt);
            cmd
        }
        fn interpret(&self, success: bool, _status: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
            if !success {
                return Err(format!("script failed: {}", stderr.trim()));
            }
            Ok(AiRun { text: stdout.to_string(), session_id: None, model: Some("script-1".into()), usage: None, context_tokens: None })
        }
    }

    fn config(script: &str) -> AiConfig {
        AiConfig {
            engine: Box::new(ScriptEngine { script: script.into() }),
            provider: "script".into(),
            account: crate::ai_accounts::AccountEnv::default(),
            binary: "/bin/sh".into(),
            model: "review-model".into(),
            tools: Vec::new(),
        }
    }

    fn prompts() -> ReviewPrompts {
        ReviewPrompts {
            standard: "ESTANDAR".into(),
            level: "NIVEL".into(),
            worker: "ROL-WORKER".into(),
            crossfile: "ROL-CRUZADO".into(),
            summary: "ROL-RESUMEN".into(),
            lenses: crate::review::contract::parse_lenses(DEFAULT_LENSES),
        }
    }

    /// A throwaway repository whose `head` adds `pagar` to `src/a.ts` and `cobrar` to `src/b.ts`.
    fn repo() -> (std::path::PathBuf, Vec<FileDiffInfo>) {
        let dir = std::env::temp_dir().join(format!("codeflow-pipeline-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("src/a.ts"), "export function pagar(dto) {\n  return cuenta.saldo;\n}\n").unwrap();
        std::fs::write(dir.join("src/b.ts"), "export function cobrar(x) {\n  return x * 2;\n}\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "head"]);
        let line = |n: u32, text: &str| DiffLine { origin: "+".into(), content: format!("{text}\n"), old_lineno: None, new_lineno: Some(n) };
        let diff = |path: &str, lines: Vec<DiffLine>| FileDiffInfo {
            old_path: None,
            new_path: Some(path.into()),
            status: "added".into(),
            binary: false,
            hunks: vec![DiffHunkInfo { header: "@@ -0,0 +1,3 @@".into(), lines }],
        };
        let files = vec![
            diff("src/a.ts", vec![line(1, "export function pagar(dto) {"), line(2, "  return cuenta.saldo;"), line(3, "}")]),
            diff("src/b.ts", vec![line(1, "export function cobrar(x) {"), line(2, "  return x * 2;"), line(3, "}")]),
        ];
        (dir, files)
    }

    fn request<'a>(config: &'a AiConfig, repo: &'a str, level: &str, contract_edit: impl FnOnce(&mut LevelContract)) -> ReviewRequest<'a> {
        let mut contract = resolve_level_contract(level, &ReviewEngineConfig::default());
        contract_edit(&mut contract);
        ReviewRequest {
            config,
            repo_path: repo,
            tools_cwd: repo,
            head_ref: "HEAD",
            target_ref: "HEAD",
            pr_title: "Pagos",
            pr_description: "",
            pr_status: "open",
            inputs: ReviewInputs::default(),
            prompts: prompts(),
            engine: ReviewEngineConfig::default(),
            contract,
            changed_since: None,
            force: false,
            cost: Default::default(),
        }
    }

    const FINDING_A: &str = "### 🚨 [Crítico · Bug] null-dereference · F-001\\n\\nSe lee saldo sin validar.\\n\\n📍 Ubicación: src/a.ts:2\\n\\n💭 Por qué: la cuenta puede no existir.\\n\\n🔎 Evidencia: \\`return cuenta.saldo;\\`\\n\\n🎯 Confianza: 85/100\\n";

    /// One group's reviewer dies: the review still lands with the other's findings, says the run is
    /// incomplete, and names the file nobody re-read — so reconciliation will keep its findings open.
    #[tokio::test]
    async fn a_failed_worker_is_reported_and_its_files_are_unreviewed() {
        let (dir, files) = repo();
        // Group with b.ts fails; group with a.ts reports one finding; the closing pass refutes nothing.
        let script = format!(
            "input=$(cat); case \"$input\" in *'=== src/b.ts'*) echo boom >&2; exit 3;; *'HALLAZGOS A VERIFICAR'*) printf 'VERIFICACIÓN F-001: CONFIRMADO\\nEl PR agrega pagos.\\n';; *'=== src/a.ts'*) printf \"{FINDING_A}\";; *) printf 'SIN HALLAZGOS';; esac"
        );
        let cfg = config(&script);
        let repo_path = dir.to_string_lossy().into_owned();
        let req = request(&cfg, &repo_path, "completo", |c| {
            c.files_per_group = 1;
            c.cross_file = false;
        });
        let Pipeline::Reviewed(outcome) = run(req, &files).await.expect("a review") else { panic!("skipped") };
        assert_eq!(outcome.findings.len(), 1);
        assert_eq!(outcome.findings[0].archivo.as_deref(), Some("src/a.ts"));
        assert_eq!(outcome.unreviewed, vec!["src/b.ts".to_string()]);
        assert!(outcome.unlocated_unread);
        assert_eq!(outcome.checking.verified, 1, "completo verifies its Crítico");
        assert_eq!(outcome.narrative, "El PR agrega pagos.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every reviewer failing is a failed review — never an empty one that resolves everything.
    #[tokio::test]
    async fn when_every_worker_fails_the_review_fails() {
        let (dir, files) = repo();
        let cfg = config("cat >/dev/null; echo down >&2; exit 1");
        let repo_path = dir.to_string_lossy().into_owned();
        let req = request(&cfg, &repo_path, "completo", |c| {
            c.files_per_group = 1;
            c.cross_file = false;
        });
        let error = run(req, &files).await.err().expect("an error");
        assert!(error.contains("Ningún revisor"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The verifier refutes; the finding is gone and the count says so. Basic triage with one
    /// reviewer and a single extra call only because there is something serious to check.
    #[tokio::test]
    async fn a_refuted_finding_never_reaches_the_report() {
        let (dir, files) = repo();
        let script = format!(
            "input=$(cat); case \"$input\" in *'HALLAZGOS A VERIFICAR'*) printf 'VERIFICACIÓN F-001: REFUTADO — se valida antes';; *) printf \"Resumen corto.\\n\\n{FINDING_A}\";; esac"
        );
        let cfg = config(&script);
        let repo_path = dir.to_string_lossy().into_owned();
        let req = request(&cfg, &repo_path, "basico", |c| c.verify = vec![crate::review::contract::Severity::Critico]);
        let Pipeline::Reviewed(outcome) = run(req, &files).await.expect("a review") else { panic!("skipped") };
        assert!(outcome.findings.is_empty());
        assert_eq!((outcome.checking.verified, outcome.checking.refuted), (1, 1));
        assert_eq!(outcome.workers, 2, "the reviewer and the verifier");
        assert_eq!(outcome.narrative, "Resumen corto.");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A finding whose evidence is nowhere in its file, from a model working from memory, is
    /// dropped before anyone reads it — at no cost.
    #[tokio::test]
    async fn an_ungrounded_finding_is_dropped_for_free() {
        let (dir, files) = repo();
        let invented = FINDING_A.replace("return cuenta.saldo;", "await db.dropDatabase();");
        let script = format!("cat >/dev/null; printf \"{invented}\"");
        let cfg = config(&script);
        let repo_path = dir.to_string_lossy().into_owned();
        let req = request(&cfg, &repo_path, "basico", |_| {});
        let Pipeline::Reviewed(outcome) = run(req, &files).await.expect("a review") else { panic!("skipped") };
        assert!(outcome.findings.is_empty());
        assert_eq!(outcome.checking.ungrounded, 1);
        assert_eq!(outcome.workers, 1, "basico verifies nothing with the model");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A clean fan-out with nobody to answer closes without a model call.
    #[tokio::test]
    async fn a_clean_fan_out_skips_the_closing_call() {
        let (dir, files) = repo();
        let cfg = config("cat >/dev/null; printf 'SIN HALLAZGOS'");
        let repo_path = dir.to_string_lossy().into_owned();
        let req = request(&cfg, &repo_path, "ultra", |c| c.files_per_group = 1);
        let Pipeline::Reviewed(outcome) = run(req, &files).await.expect("a review") else { panic!("skipped") };
        assert!(outcome.findings.is_empty());
        assert_eq!(outcome.workers, 3, "two groups and the cross-file pass — no closing pass");
        assert!(outcome.failed_passes.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
