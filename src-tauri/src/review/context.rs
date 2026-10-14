//! What each reviewer is told besides its code — and only what concerns its code.
//!
//! Every block here used to be rendered once and handed to every reviewer: the historical hints,
//! the blast radius, the open conversation, the findings a human already discarded, the repository's
//! standing false positives. With four groups that was four copies of all of it, and three quarters
//! of each copy was about files the reviewer receiving it would never see — paid for in tokens on
//! every worker, and read as noise by every one of them ("comment on this thread about a file you
//! don't have").
//!
//! So the inputs travel raw and are cut per [`Audience`]: a worker gets what is about *its* files,
//! the cross-file pass what spans files, the closing pass what it has to answer. The rendering of
//! each block is unchanged; only who receives which lines of it is new.

use std::collections::HashSet;

use super::graph::{self, Impact};
use super::hints::{self, Hint};
use super::outline::same_path;
use crate::ado::{PrChecks, PrCommentThread};
use crate::review_memory::{self, FpSuppression, MemoryFinding};

/// How much of one comment's text is carried into the prompt. Enough to know what was asked;
/// short enough that twenty threads don't crowd out the diff.
const COMMENT_EXCERPT: usize = 500;

/// At most this many host threads are carried. Past it the conversation is long enough that the
/// tail adds noise rather than context, and the truncation is stated in the block itself.
const MAX_THREADS: usize = 20;

/// How much of a repository's conventions file is carried, for an engine that does not load it.
const CONVENTIONS_EXCERPT: usize = 4_000;

/// Whether a comment was published after `since` (both RFC 3339). Parsed rather than compared as
/// strings: the hosts and this app's own clock write the offset differently (`Z` vs `+00:00`), and
/// lexicographic order across those two spellings is wrong.
///
/// Unparseable input counts as *not* newer. A timestamp nothing can read is not evidence that
/// something happened, and the failure mode of guessing "newer" is re-running every review forever.
pub fn is_newer_than(published: &str, since: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(published),
        chrono::DateTime::parse_from_rfc3339(since),
    ) {
        (Ok(a), Ok(b)) => a > b,
        _ => false,
    }
}

/// Everything a review knows besides the code, uncut.
#[derive(Debug, Clone, Default)]
pub struct ReviewInputs {
    /// The workspace's review contexts and an agent's own prompt — rules for the whole repository,
    /// so every reader gets them.
    pub contexts: Vec<(String, String)>,
    /// The previous run's findings for this PR (empty on a first review, and for a link review).
    pub remembered: Vec<MemoryFinding>,
    /// The PR's open threads on the host.
    pub threads: Vec<PrCommentThread>,
    /// When this PR was last reviewed, to mark what was written since.
    pub since: Option<String>,
    /// The repository's standing false positives.
    pub rules: Vec<FpSuppression>,
    /// What other PRs already settled about these files.
    pub hints: Vec<Hint>,
    /// The PR's checks, already rendered — see [`checks_block`].
    pub checks: Option<String>,
    /// The repository's conventions, for an engine that will not read them itself — see
    /// [`conventions_block`].
    pub conventions: Option<(String, String)>,
}

/// Who a set of contexts is for.
#[derive(Debug, Clone, Copy)]
pub enum Audience<'a> {
    /// A worker that owns these files.
    Group(&'a [String]),
    /// The pass that reads the outline for what spans files.
    CrossFile,
    /// The closing synthesis (and verification) of a fanned-out review.
    Closing,
    /// A single reviewer that reads everything.
    All,
}

impl Audience<'_> {
    /// Whether something about `file` (or about no file at all, when `None`) concerns this reader.
    fn owns(&self, file: Option<&str>) -> bool {
        match (self, file) {
            (Audience::Group(paths), Some(file)) => paths.iter().any(|p| same_path(p, file)),
            // Unlocated things span the PR: the cross-file pass and the closing pass take them.
            (Audience::Group(_), None) => false,
            (Audience::CrossFile, file) => file.is_none(),
            (Audience::Closing | Audience::All, _) => true,
        }
    }
}

/// The contexts one reader gets, in the order they read best: the repository's own rules first,
/// then the facts about this PR, then what was already decided about it.
///
/// `impacts` is passed pre-cut by the caller, which is the one that knows which group a deleted
/// file's impacts belong to.
pub fn contexts_for(inputs: &ReviewInputs, impacts: &[Impact], audience: Audience) -> Vec<(String, String)> {
    let mut out = inputs.contexts.clone();
    let closing = matches!(audience, Audience::Closing);

    if let Some((name, excerpt)) = &inputs.conventions {
        if !closing {
            out.push((format!("Convenciones del repositorio ({name})"), excerpt.clone()));
        }
    }
    if let Some(block) = &inputs.checks {
        out.push(("Estado de CI del PR".to_string(), block.clone()));
    }
    if !closing {
        let hints: Vec<Hint> = match audience {
            Audience::Group(_) => inputs.hints.iter().filter(|h| audience.owns(Some(&h.file))).cloned().collect(),
            Audience::All => inputs.hints.clone(),
            _ => Vec::new(),
        };
        if let Some(block) = hints::block(&hints) {
            out.push(("Hallazgos ya evaluados en otros PRs de este repo".to_string(), block));
        }
        if let Some(block) = graph::block(impacts) {
            out.push(("Impacto fuera del PR (referencias)".to_string(), block));
        }
    }
    if let Some(block) = pending_comments_block(&inputs.remembered, &inputs.threads, inputs.since.as_deref(), audience) {
        out.push(("Conversación abierta en el PR".to_string(), block));
    }
    if !closing {
        // Two "do not raise this" blocks, deliberately not folded into the one above: that block
        // asks the model to *answer* what is still open, and these ask it to stay off ground a human
        // already ruled on.
        let discarded: Vec<MemoryFinding> = inputs
            .remembered
            .iter()
            .filter(|f| matches!(audience, Audience::All | Audience::CrossFile) || audience.owns(f.archivo.as_deref()) || f.archivo.is_none())
            .cloned()
            .collect();
        if let Some(block) = review_memory::discarded_block(&discarded) {
            out.push(("Hallazgos ya descartados en este PR".to_string(), block));
        }
        let rules: Vec<FpSuppression> = inputs
            .rules
            .iter()
            .filter(|r| r.archivo.is_none() || matches!(audience, Audience::All | Audience::CrossFile) || audience.owns(r.archivo.as_deref()))
            .cloned()
            .collect();
        if let Some(block) = review_memory::suppressions_block(&rules) {
            out.push(("Falsos positivos conocidos de este repositorio".to_string(), block));
        }
    }
    out
}

/// The still-open conversation on a pull request, rendered as one context block for the review
/// prompt — cut to what `audience` owns.
///
/// Two sources, deliberately kept apart: the findings **this app** published and still holds
/// active (from the durable review memory — they carry their stable `F-NNN` id, which is what lets
/// reconciliation match the re-review's findings back to the threads already opened for them), and
/// every other thread the host still shows open (a human reviewer's). The instructions matter as
/// much as the list: a finding that persists must be re-reported *with the same file and category*
/// or reconciliation reads it as fixed, and one that really was fixed must be left out and said so
/// in the summary — that is exactly the signal that flips it to `resuelto`.
///
/// Returns `None` when nothing is pending for this reader: a first review has no conversation to
/// carry, and an empty "still open" section only invites the model to invent one.
pub fn pending_comments_block(
    remembered: &[MemoryFinding],
    threads: &[PrCommentThread],
    // When this PR was last reviewed, so anything written since can be marked as such. `None` on a
    // first review, where nothing is new because nothing came before.
    since: Option<&str>,
    audience: Audience,
) -> Option<String> {
    let published: Vec<&MemoryFinding> = remembered
        .iter()
        .filter(|f| f.is_active() && f.thread_id.is_some())
        .filter(|f| audience.owns(f.archivo.as_deref()))
        .collect();
    // Threads CodeFlow opened are already described, in richer terms, by the memory above —
    // listing them again would ask the model to answer the same finding twice.
    let ours: HashSet<i64> = remembered.iter().filter_map(|f| f.thread_id).collect();
    let others: Vec<&PrCommentThread> = threads
        .iter()
        .filter(|t| !ours.contains(&t.id))
        .filter(|t| audience.owns(t.file_path.as_deref()))
        .collect();
    if published.is_empty() && others.is_empty() {
        return None;
    }

    // Leading newline: contexts are rendered as `- {name}: {content}`, and a multi-line block
    // reads as part of that bullet unless it starts on its own line.
    let mut out = String::from(
        "\nEste pull request ya tiene conversación abierta. Además de revisar el diff actual, \
         responde explícitamente por cada punto pendiente si esta iteración lo corrige.\n",
    );

    if !published.is_empty() {
        out.push_str(
            "\n## Hallazgos que esta app publicó y siguen abiertos\n\
             Reglas: si el hallazgo SIGUE presente, vuelve a reportarlo con el mismo archivo y la \
             misma categoría (así se reconoce como el mismo hallazgo y se responde en su hilo). Si \
             ya está corregido, NO lo reportes como hallazgo y dilo en el resumen.\n\n",
        );
        for f in &published {
            let loc = match (&f.archivo, &f.lineas) {
                (Some(file), Some(lines)) => format!(" · `{file}:{lines}`"),
                (Some(file), None) => format!(" · `{file}`"),
                _ => String::new(),
            };
            out.push_str(&format!(
                "- **{}** · {} · categoría `{}`{} — {}\n",
                f.id, f.severity, f.categoria, loc, f.subtitulo
            ));
        }
    }

    if !others.is_empty() {
        out.push_str(
            "\n## Otros comentarios abiertos en el PR\n\
             Son de personas revisoras. Indica en el resumen si el cambio actual los atiende. Los \
             marcados como 🆕 se escribieron DESPUÉS de la última revisión: trátalos como entrada \
             nueva y respóndelos uno por uno en el resumen, aunque el código no haya cambiado.\n\n",
        );
        for thread in others.iter().take(MAX_THREADS) {
            let loc = match (&thread.file_path, thread.start_line) {
                (Some(file), Some(line)) => format!(" (`{file}:{line}`)"),
                (Some(file), None) => format!(" (`{file}`)"),
                _ => String::new(),
            };
            out.push_str(&format!("- Hilo #{}{}\n", thread.id, loc));
            for c in &thread.comments {
                let text: String = c.content.chars().take(COMMENT_EXCERPT).collect();
                let ellipsis = if c.content.chars().count() > COMMENT_EXCERPT { "…" } else { "" };
                let nuevo = match since {
                    Some(s) if is_newer_than(&c.published_date, s) => "🆕 ",
                    _ => "",
                };
                out.push_str(&format!("  - {}{}: {}{}\n", nuevo, c.author, text.replace('\n', " "), ellipsis));
            }
        }
        if others.len() > MAX_THREADS {
            out.push_str(&format!("\n_(+{} hilos abiertos no listados.)_\n", others.len() - MAX_THREADS));
        }
    }

    Some(out)
}

/// Whether there is anything on the PR a closing pass has to answer — a human's thread, or a
/// published finding. Without one, and without findings, the closing pass has nothing to say that
/// a fixed sentence cannot.
pub fn has_conversation(inputs: &ReviewInputs) -> bool {
    pending_comments_block(&inputs.remembered, &inputs.threads, inputs.since.as_deref(), Audience::Closing).is_some()
}

/// The PR's checks, as one context block — only what is not green, and a count of what is.
///
/// A red test suite changes what a finding is worth ("this breaks the parser" next to a failing
/// parser test is a certainty), and a green one rules out a whole class of guesses (it compiles).
/// Two lines in the common case; `None` when the host reported no checks at all.
pub fn checks_block(checks: &PrChecks) -> Option<String> {
    use crate::ci::status;
    if checks.checks.is_empty() {
        return None;
    }
    let mut bad: Vec<String> = Vec::new();
    let (mut green, mut running) = (0usize, 0usize);
    for check in &checks.checks {
        match check.state.as_str() {
            status::SUCCESS | status::SKIPPED => green += 1,
            status::RUNNING | status::QUEUED => running += 1,
            _ => {
                let detail = check.description.as_deref().map(str::trim).filter(|d| !d.is_empty());
                bad.push(match detail {
                    Some(d) => format!("- ✗ {} ({}): {}", check.name, check.state, d.chars().take(160).collect::<String>()),
                    None => format!("- ✗ {} ({})", check.name, check.state),
                });
            }
        }
    }
    let mut out = format!("\n{green} check(s) en verde, {running} en curso, {} con problemas.\n", bad.len());
    for line in bad.iter().take(10) {
        out.push_str(line);
        out.push('\n');
    }
    if !bad.is_empty() {
        out.push_str(
            "Si un hallazgo explica uno de estos fallos, dilo en su 💭 Por qué. No reportes como hallazgo \
             que \"el CI falla\": eso ya lo ve el equipo.\n",
        );
    }
    Some(out)
}

/// The conventions files each engine reads by itself from its working directory. Checked so that
/// one is only ever paid for twice when the engine would not read it at all.
fn native_conventions(engine_id: &str) -> &'static [&'static str] {
    match engine_id {
        "claude" => &["CLAUDE.md", ".claude/CLAUDE.md"],
        "codex" => &["AGENTS.md"],
        "opencode" => &["AGENTS.md", "CLAUDE.md"],
        "gemini" => &["GEMINI.md", "AGENTS.md"],
        "cline" => &[".clinerules"],
        _ => &[],
    }
}

/// The repository's conventions for an engine that will not load them itself: the first of the
/// common conventions files the PR's head has, trimmed. `None` when the engine already reads one
/// the repository has (the usual case — Claude Code and `CLAUDE.md`), or when there is none.
///
/// `read` reads a repository-relative path at the PR's head.
pub fn conventions_block(engine_id: &str, read: &dyn Fn(&str) -> Option<String>) -> Option<(String, String)> {
    if native_conventions(engine_id).iter().any(|name| read(name).is_some_and(|t| !t.trim().is_empty())) {
        return None;
    }
    for name in ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"] {
        let Some(text) = read(name).filter(|t| !t.trim().is_empty()) else { continue };
        let mut excerpt: String = text.chars().take(CONVENTIONS_EXCERPT).collect();
        if text.chars().count() > CONVENTIONS_EXCERPT {
            excerpt.push_str("\n[… recortado]");
        }
        return Some((name.to_string(), format!("\n{excerpt}\n")));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ado::{PrCheck, PrThreadComment};

    fn thread(id: i64, file: Option<&str>, text: &str) -> PrCommentThread {
        PrCommentThread {
            id,
            file_path: file.map(str::to_string),
            start_line: file.map(|_| 3),
            end_line: None,
            comments: vec![PrThreadComment { author: "ana".into(), content: text.into(), published_date: "2026-10-01T10:00:00Z".into() }],
        }
    }

    fn hint(file: &str) -> Hint {
        Hint { file: file.into(), pr_id: 7, date: "2026-09-01".into(), estado: "falso_positivo".into(), categoria: "npe".into(), motivo: None }
    }

    /// A worker hears about its own files and nothing else — the rest is another worker's, paid for
    /// once there instead of N times everywhere.
    #[test]
    fn a_worker_gets_only_what_concerns_its_files() {
        let inputs = ReviewInputs {
            contexts: vec![("Reglas".into(), "usa async".into())],
            threads: vec![thread(1, Some("src/a.ts"), "¿y el null?"), thread(2, Some("src/b.ts"), "renombra"), thread(3, None, "en general bien")],
            hints: vec![hint("src/a.ts"), hint("src/b.ts")],
            ..Default::default()
        };
        let mine = vec!["src/a.ts".to_string()];
        let ctx = contexts_for(&inputs, &[], Audience::Group(&mine));
        let text: String = ctx.iter().map(|(n, c)| format!("{n}: {c}\n")).collect();
        assert!(text.contains("usa async"), "the repository's rules reach everyone");
        assert!(text.contains("¿y el null?"));
        assert!(!text.contains("renombra"), "another worker's thread");
        assert!(!text.contains("en general bien"), "a general comment is the closing pass's to answer");
        assert_eq!(text.matches("`src/b.ts`").count(), 0);

        let closing = contexts_for(&inputs, &[], Audience::Closing);
        let text: String = closing.iter().map(|(n, c)| format!("{n}: {c}\n")).collect();
        assert!(text.contains("en general bien") && text.contains("renombra"));
        assert!(!text.contains("evaluados en otros PRs"), "the closing pass has no use for hints");
    }

    #[test]
    fn checks_say_what_is_red_and_count_the_rest() {
        let check = |name: &str, state: &str| PrCheck {
            kind: "check".into(),
            name: name.into(),
            state: state.into(),
            raw_state: state.into(),
            description: None,
            url: None,
            pipeline_run_id: None,
            required: None,
        };
        let block = checks_block(&PrChecks { head_sha: None, checks: vec![check("build", "success"), check("unit tests", "failed")] }).unwrap();
        assert!(block.contains("1 check(s) en verde"));
        assert!(block.contains("✗ unit tests (failed)"));
        assert!(checks_block(&PrChecks { head_sha: None, checks: vec![] }).is_none());
    }

    #[test]
    fn conventions_are_only_carried_for_an_engine_that_would_not_read_them() {
        let repo = |name: &str| (name == "AGENTS.md").then(|| "Usa pnpm.".to_string());
        assert!(conventions_block("codex", &repo).is_none(), "Codex reads AGENTS.md itself");
        let (name, text) = conventions_block("claude", &repo).expect("Claude does not read AGENTS.md");
        assert_eq!(name, "AGENTS.md");
        assert!(text.contains("Usa pnpm."));
        let claude_md = |name: &str| (name == "CLAUDE.md").then(|| "x".to_string());
        assert!(conventions_block("claude", &claude_md).is_none());
    }
}
