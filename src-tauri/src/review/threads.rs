//! What the pull request's own threads already decided about the findings this app published.
//!
//! A finding posted to the PR gets answered there, not here: the team closes its thread as *won't
//! fix*, or replies "Falso positivo: el padre ya valida". Before this, that answer reached the next
//! re-review only as context, and the finding came back as active — re-judged, re-paid for, and
//! counted against the gate — until somebody repeated the same verdict by hand in this app. Ported
//! from the reference PR-review tool's `tools/lib/threads.py` (README § "Hilos del PR"), whose rules
//! are deliberately narrow, because a loose reading auto-closes real defects:
//!
//! - **The host's status** of the finding's own thread — Azure's `wontFix`, `byDesign`, `closed` —
//!   is a dismissal. Its last human comment only says *which kind* (debt, false positive, ignored);
//!   with no clear word, `wontFix`/`closed` are `ignorado` and `byDesign` is `falso_positivo`. Won't
//!   fix means "we won't act on it", not "the finding is wrong". GitHub and GitLab only have
//!   "resolved", which says nothing about which of those it was, so there only the words count.
//! - **Words** — on an open or resolved thread, or in the finding's block of a reply to this app's
//!   summary comment — count only when the comment **opens** with the verdict ("Falso positivo: …",
//!   "No aplica …", "Deuda técnica: …", "Ignorar: …"), not negated, not asked, and not followed by a
//!   contrast that asks for a change. Further in, it is only the PR's word: kept as
//!   [`VeredictoPr`] for a human to apply with one click. A comment opening with a fix claim
//!   ("Corregido en …") changes nothing but sends the finding back to be re-judged.
//! - **The delta beats words:** when the finding's file changed in this iteration a text-only
//!   dismissal does not apply — the code moved, so it is re-read and re-judged, with the verdict
//!   offered. An explicit host status still applies.
//! - **This app's own posts are never a verdict** — its finding comments, its "sigue presente" /
//!   "resuelto" follow-ups, its summary and its mark replies — told apart by their bodies, not their
//!   author: the app posts as the signed-in user, and that same user replying by hand is a human.
//!
//! Everything here is pure: [`read`] turns the threads into one reading per finding, and [`apply`]
//! moves the memory with [`set_finding_state`], the one way anything outside reconciliation does.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use crate::review_memory::{set_finding_state, MemoryFinding, VeredictoPr, ESTADO_DEUDA};

/// How this app's summary comment opens (`buildSummaryComment` in `src/lib/parseAnalysis.ts`).
pub const SUMMARY_HEADING: &str = "### 📋 Revisión automatizada";

/// What every mark reply this app posts carries (`mark_reply_body`): the thread's status after one
/// is this app's doing, not the team's.
const OUR_MARK: &str = "_Marcado desde CodeFlow";

/// A comment, host-neutral.
#[derive(Debug, Clone, Default)]
pub struct HostComment {
    pub author: String,
    pub content: String,
    pub published: String,
}

/// A thread, host-neutral, with what the host says about its state.
#[derive(Debug, Clone, Default)]
pub struct HostThread {
    pub id: i64,
    /// Azure DevOps' status, lower-cased (`active`, `fixed`, `wontfix`, `closed`, `bydesign`,
    /// `pending`). `None` on hosts that have no such thing.
    pub status: Option<String>,
    /// GitHub's / GitLab's "resolved conversation" — which says nothing about *why*.
    pub resolved: bool,
    /// A PR-level comment, on no file.
    pub general: bool,
    /// When the thread last moved (a status change included), where the host says.
    pub updated: Option<String>,
    pub comments: Vec<HostComment>,
}

impl HostThread {
    /// A thread as the shared listing returns it (GitHub, GitLab, Bitbucket — and Azure's open ones).
    pub fn from_listed(t: &crate::ado::PrCommentThread) -> Self {
        HostThread {
            id: t.id,
            status: None,
            resolved: t.resolved,
            general: t.file_path.is_none(),
            updated: None,
            comments: t.comments.iter().map(comment_of).collect(),
        }
    }

    /// An Azure thread with its status — closed ones included (`ado::list_pr_thread_states`).
    pub fn from_azure(t: &crate::ado::PrThreadState) -> Self {
        let status = t.status.trim().to_lowercase();
        HostThread {
            id: t.id,
            resolved: status == "fixed",
            status: Some(status),
            general: t.file_path.is_none(),
            updated: t.last_updated.clone(),
            comments: t.comments.iter().map(comment_of).collect(),
        }
    }
}

fn comment_of(c: &crate::ado::PrThreadComment) -> HostComment {
    HostComment { author: c.author.clone(), content: c.content.clone(), published: c.published_date.clone() }
}

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/// The three ways the team rules a finding out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    FalsoPositivo,
    Ignorado,
    Deuda,
}

impl Kind {
    pub fn estado(self) -> &'static str {
        match self {
            Kind::FalsoPositivo => "falso_positivo",
            Kind::Ignorado => "ignorado",
            Kind::Deuda => ESTADO_DEUDA,
        }
    }
}

/// How a verdict reached the memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// The thread's status on the host.
    Status,
    /// A reply on the finding's own thread.
    Texto,
    /// The finding's block in a reply to the summary comment.
    Resumen,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Status => "status",
            Via::Texto => "texto",
            Via::Resumen => "resumen",
        }
    }
}

// Matched over an accent-folded, lower-cased copy (`fold`). Kept short and unambiguous on purpose:
// a loose phrase ("lo vemos después") would auto-close real findings.
const FALSE_POSITIVE_PHRASES: &[&str] = &[
    "falso positivo", "falsos positivos", "false positive", "no aplica", "no corresponde",
    "es intencional", "son intencionales", "es a proposito", "son a proposito", "es adrede",
    "by design", "asi es correcto", "not a bug", "not an issue", "no es un problema", "no es un bug",
    "not applicable", "does not apply", "doesn't apply",
];
const IGNORED_PHRASES: &[&str] = &[
    "wontfix", "won't fix", "wont fix", "will not fix", "no se va a corregir", "no lo vamos a arreglar",
    "lo dejamos asi", "queda como esta",
];
/// Accepted debt is not "we won't act on it": the defect is real and owned, so it stays visible.
/// Checked first — "deuda aceptada" also reads as a decision not to act, and the more specific
/// verdict has to win.
const DEBT_PHRASES: &[&str] = &[
    "deuda aceptada", "deuda tecnica aceptada", "accepted debt", "accepted as technical debt",
    "accepted as tech debt", "accepted tech debt", "es deuda tecnica", "queda como deuda",
    "lo dejamos como deuda", "se acepta la deuda", "se acepta como deuda", "asumimos la deuda",
    "va al backlog", "queda en el backlog", "goes to the backlog",
];
// What only *types* a dismissal a thread's status already made — too loose to create one.
const TYPING_DEBT_EXTRA: &[&str] = &["aceptado como deuda", "aceptada como deuda", "deuda acotada"];
const TYPING_FALSE_POSITIVE_EXTRA: &[&str] = &["por diseno"];
const TYPING_IGNORED_EXTRA: &[&str] = &["se ignora"];

/// The state labels themselves, as a team answering in the report's own vocabulary opens a reply.
/// `strict` labels are imperatives ("Ignore …") that also start ordinary sentences, so they count
/// only followed by a separator ("Ignorar: …", "Ignore.").
const STATE_LABELS: &[(&str, Kind, bool)] = &[
    ("deuda tecnica", Kind::Deuda, false),
    ("technical debt", Kind::Deuda, false),
    ("tech debt", Kind::Deuda, false),
    ("falso positivo", Kind::FalsoPositivo, false),
    ("false positive", Kind::FalsoPositivo, false),
    ("ignorado", Kind::Ignorado, false),
    ("ignored", Kind::Ignorado, false),
    ("ignorar", Kind::Ignorado, true),
    ("ignore", Kind::Ignorado, true),
];

/// A verdict opens the comment when its phrase starts inside the first sentence, within this many
/// characters. "Corregido en abc. No aplica el cambio sugerido tal cual" must not read as a verdict.
const OPENING_WINDOW: usize = 60;
/// Characters before a phrase, within its sentence, inspected for a negation.
const NEGATION_WINDOW: usize = 32;
/// How much of a human's words becomes the reason.
const REASON_CHARS: usize = 500;

macro_rules! pattern {
    ($name:ident, $re:expr) => {
        fn $name() -> &'static Regex {
            static RE: OnceLock<Regex> = OnceLock::new();
            RE.get_or_init(|| Regex::new($re).expect("a valid pattern"))
        }
    };
}

pattern!(negation, r"\b(?:no es|no son|not a|isn't|is not|aren't|are not|no me parece|tampoco es|no creo|no pienso|no parece|dudo que|don't think|do not think|not)\b");
// A bare negator right before the phrase: "no es intencional" holds "es intencional" behind "no ".
pattern!(negator_before, r"\b(?:no|not|tampoco|nunca|never)\s+$");
// A dismissal followed, in its sentence, by a contrast asking for a change is not a dismissal.
pattern!(contrast, r"\b(?:pero|sin embargo|aunque|igual hay que|hay que (?:cambiar|corregir|arreglar|ajustar|revisar)\w*|but|however|still (?:need|should|has to))\b");
pattern!(sentence_end, r"[.!?\n;]");
pattern!(leading_noise, r"^[^a-z0-9]+");
pattern!(leading_id, r"^f-\d{3,}");
// A comment that opens by saying the code changed is a claim to verify, never a dismissal.
pattern!(fix_claim, r"^(?:ya\s+)?(?:(?:lo|la|los|las|se)\s+)?(?:corregid[oa]s?|corregi|corregimos|corrigio|corrijo|arreglad[oa]s?|arregle|arreglamos|arreglo|agregad[oa]s?|agregue|agregamos|anadid[oa]s?|resuelt[oa]s?|resolvi|resolvimos|solucionad[oa]s?|ajustad[oa]s?|ajuste|ajustamos|cambiad[oa]s?|cambie|cambiamos|modificad[oa]s?|implementad[oa]s?|aplicad[oa]s?|hecho|listo|fixed|done|resolved|addressed|added|changed|updated)\b");
// …and one that says so further in is about a fix: the PR's word to weigh, never a sync.
pattern!(fix_mention, r"\b(?:corregid[oa]s?|corregi|corregimos|corrigio|arreglad[oa]s?|arregle|arreglamos|solucionad[oa]s?|fixed)\b");
// The last word on a closed thread taking the dismissal back.
pattern!(retraction, r"\b(?:me equivoque|nos equivocamos|tiene[ns]? razon|si aplica|hay que (?:corregir|cambiar|arreglar)\w*|lo (?:voy a |vamos a )?(?:corrijo|corregir|corregimos|arreglo|arreglar)|i was wrong|(?:needs?|has|have) to be fixed|should be fixed|will fix)\b");
// This app's finding heading: `### <emoji> [Tipo] categoría · F-NNN`.
pattern!(finding_heading, r"^### .*· F-\d{3,}\s*$");
// --- the summary's per-finding blocks ---
pattern!(id_re, r"(?i)\bF-\d{3,}\b");
pattern!(anchor, r"(?i)^\s*(?:>\s*)?(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*`?F-\d{3,}\b`?(?:\s*(?:,|/|&|\by\b|\be\b|\band\b)\s*`?F-\d{3,}\b`?)*");
// What may sit between two ids sharing one justification ("F-002 y F-004: no aplican").
pattern!(id_gap, r"(?i)^[\s,/&*_`]*(?:(?:y|e|and)[\s,/&*_`]*)?$");
pattern!(trail_join, r"(?i)(?:\s+(?:y|e|and))?[\s,;:`*_]*$");
pattern!(lead_paren, r"^\([^)]*\)");
pattern!(table_rule_cell, r"^:?-{2,}:?$");

const SEG_NOISE: &[char] = &[' ', '\t', ':', '—', '–', '-', '·', '*', '_', '`', '|', '.', ',', ';', '>'];

/// Lower-case, accents stripped, a typographic apostrophe read as the plain one — so "No aplicá",
/// "NO APLICA" and "isn’t", as a phone writes it, match like everything else.
fn fold(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            '’' | '‘' => '\'',
            other => other,
        })
        .collect()
}

fn clip(text: &str, limit: usize) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= limit {
        return t;
    }
    let cut: String = t.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// The folded comment from its first word on: emoji, bullets, bold and the `F-0NN` it may open
/// with ("F-002 — Falso positivo") dropped.
fn lead(text: &str) -> String {
    let folded = fold(text);
    let once = leading_noise().replace(&folded, "");
    let no_id = leading_id().replace(&once, "");
    leading_noise().replace(&no_id, "").into_owned()
}

/// The state whose own label opens `lead`, and whether its sentence then asks for a change anyway.
/// `None` when asked or taken back right there ("Falso positivo? no…", "Ignorado no, …").
fn label_verdict(lead: &str) -> Option<(Kind, bool)> {
    for &(label, kind, strict) in STATE_LABELS {
        let Some(rest) = lead.strip_prefix(label) else { continue };
        if rest.chars().next().is_some_and(char::is_alphanumeric) {
            continue;
        }
        let rest = rest.trim_start_matches([' ', '*', '_', '`']);
        if rest.starts_with('?') || rest == "no" || rest.starts_with("no ") || rest.starts_with("no,") {
            return None;
        }
        if strict && !(rest.is_empty() || rest.starts_with([':', '—', '–', '-', '.', ',', ';', '!', ')'])) {
            continue;
        }
        let sentence = sentence_end().find(rest).map_or(rest, |m| &rest[..m.start()]);
        return Some((kind, contrast_in(sentence)));
    }
    None
}

/// A contrast in `text` — except one that is itself negated ("no pero…" never asks for anything).
fn contrast_in(text: &str) -> bool {
    contrast().find_iter(text).any(|m| !text[..m.start()].ends_with("no "))
}

fn last_chars(text: &str, n: usize) -> &str {
    match text.char_indices().rev().nth(n.saturating_sub(1)) {
        Some((at, _)) => &text[at..],
        None => text,
    }
}

/// Where the first of `phrases` that *does* dismiss starts in `folded` — not one negated in its own
/// sentence ("no creo que sea un falso positivo"), asked ("¿esto es intencional?") or followed by a
/// contrast asking for a change ("no aplica acá, pero hay que cambiarlo").
fn phrase_at(folded: &str, phrases: &[&str]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for p in phrases {
        let mut from = 0;
        while let Some(rel) = folded[from..].find(p) {
            let idx = from + rel;
            let before_all = &folded[..idx];
            let start = sentence_end().find_iter(before_all).last().map_or(0, |m| m.end());
            let before = &before_all[start..];
            let tail = &folded[idx + p.len()..];
            let end = sentence_end().find(tail);
            let negated = !p.starts_with("no ")
                && (negation().is_match(last_chars(before, NEGATION_WINDOW)) || negator_before().is_match(before));
            let asked = before.contains('¿') || end.is_some_and(|m| m.as_str() == "?");
            let sentence_tail = end.map_or(tail, |m| &tail[..m.start()]);
            if negated || asked || contrast_in(sentence_tail) {
                from = idx + p.chars().next().map_or(1, char::len_utf8);
                continue;
            }
            best = Some(best.map_or(idx, |b| b.min(idx)));
            break;
        }
    }
    best
}

/// What one human comment (or one summary block) says about a finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reading {
    /// Nothing a verdict can be read from.
    Nothing,
    /// It opens by saying the code was fixed: re-judge it, change nothing.
    FixClaim,
    /// It opens with the verdict — the only words that apply on their own.
    Opening(Kind),
    /// The verdict is there, but further in (or beside a fix claim, or a contrast): offered, never applied.
    Mention(Kind),
}

/// Reads one comment. A state's own label first, or a dismissal phrase inside its first sentence
/// and within [`OPENING_WINDOW`], is an opening; a phrase further in is a mention. The most specific
/// verdict wins wherever it sits (debt, then ignored, then false positive): "No aplica. Queda como
/// deuda" is debt, and it does open with one.
pub fn read_comment(text: &str) -> Reading {
    let lead = lead(text);
    if fix_claim().is_match(&lead) {
        return Reading::FixClaim;
    }
    if let Some((kind, contrasted)) = label_verdict(&lead) {
        return if contrasted { Reading::Mention(kind) } else { Reading::Opening(kind) };
    }
    let first = sentence_end().find(&lead).map_or(lead.len(), |m| m.start());
    let limit = OPENING_WINDOW.min(first);
    let hits: Vec<(Kind, usize)> = [(DEBT_PHRASES, Kind::Deuda), (IGNORED_PHRASES, Kind::Ignorado), (FALSE_POSITIVE_PHRASES, Kind::FalsoPositivo)]
        .into_iter()
        .filter_map(|(phrases, kind)| phrase_at(&lead, phrases).map(|at| (kind, at)))
        .collect();
    let Some(&(kind, _)) = hits.first() else { return Reading::Nothing };
    let opens = hits.iter().map(|(_, at)| *at).min().unwrap_or(usize::MAX) <= limit;
    if fix_mention().is_match(&lead) {
        // It also says the code was fixed: a phrase that opens it is only the PR's word, and one
        // further in is no verdict at all.
        return if opens { Reading::Mention(kind) } else { Reading::Nothing };
    }
    if opens { Reading::Opening(kind) } else { Reading::Mention(kind) }
}

/// Which kind of dismissal a thread the team closed as one is. The status already said
/// "dismissed", so the words only type it — the wider typing vocabulary included — and with no
/// clear word the status's own meaning decides.
fn dismissal_type(text: &str, status: &str) -> Kind {
    let lead = lead(text);
    if let Some((kind, _)) = label_verdict(&lead) {
        return kind;
    }
    let with = |base: &[&'static str], extra: &[&'static str]| -> Vec<&'static str> { base.iter().chain(extra).copied().collect() };
    for (phrases, kind) in [
        (with(DEBT_PHRASES, TYPING_DEBT_EXTRA), Kind::Deuda),
        (with(FALSE_POSITIVE_PHRASES, TYPING_FALSE_POSITIVE_EXTRA), Kind::FalsoPositivo),
        (with(IGNORED_PHRASES, TYPING_IGNORED_EXTRA), Kind::Ignorado),
    ] {
        if phrase_at(&lead, &phrases).is_some() {
            return kind;
        }
    }
    if status == "bydesign" { Kind::FalsoPositivo } else { Kind::Ignorado }
}

fn is_dismissal_status(status: &str) -> bool {
    matches!(status, "wontfix" | "bydesign" | "closed")
}

/// Statuses on which the last human comment is read for its words.
fn is_text_status(status: &str) -> bool {
    matches!(status, "" | "active" | "pending" | "unknown" | "fixed")
}

// ---------------------------------------------------------------------------------------------
// This app's own posts
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Post {
    Human,
    Ours,
    /// One of this app's mark replies: what the thread's status says after it is this app's doing.
    OurMark,
}

/// Whether a comment is one this app wrote — by its body, since the app posts as the signed-in user
/// and the same user replying by hand is a human whose words count.
fn post_kind(content: &str) -> Post {
    let body = content.trim_start();
    if body.contains(OUR_MARK) {
        return Post::OurMark;
    }
    if body.starts_with(SUMMARY_HEADING) {
        return Post::Ours;
    }
    // A finding's comment, possibly after the line saying it landed outside the diff.
    let heading = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !(l.starts_with("📍") && l.contains("fuera del diff")));
    if heading.is_some_and(|h| finding_heading().is_match(h)) {
        return Post::Ours;
    }
    // The follow-ups a re-publish leaves (`follow_up_text`).
    if (body.starts_with("✔️") || body.starts_with("➡️"))
        && (body.contains("Resuelto en la iteración") || body.contains("Sigue presente en la iteración"))
    {
        return Post::Ours;
    }
    Post::Human
}

/// Whether `content` is one of this app's own posts on a pull request.
#[cfg(test)]
fn is_app_post(content: &str) -> bool {
    post_kind(content) != Post::Human
}

fn is_summary(thread: &HostThread) -> bool {
    thread.comments.first().is_some_and(|c| c.content.trim_start().starts_with(SUMMARY_HEADING))
}

/// `a` strictly after `b`: as instants when both parse, as text otherwise (both are ISO-shaped).
fn after(a: &str, b: &str) -> bool {
    match (chrono::DateTime::parse_from_rfc3339(a), chrono::DateTime::parse_from_rfc3339(b)) {
        (Ok(x), Ok(y)) => x > y,
        _ => !a.is_empty() && a > b,
    }
}

// ---------------------------------------------------------------------------------------------
// Reading the threads
// ---------------------------------------------------------------------------------------------

/// A verdict the PR gave on one finding.
#[derive(Debug, Clone, PartialEq)]
pub struct Signal {
    pub kind: Kind,
    pub via: Via,
    /// The human's words (or what the status change says), clipped.
    pub motivo: String,
    pub autor: String,
    /// When it was said — the comment, or the thread's last move for a bare status.
    pub at: String,
    /// It opened the comment (or is a status): applies on its own. Otherwise it is only offered.
    pub opening: bool,
}

/// Everything the PR said about one finding.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FindingReading {
    pub signal: Option<Signal>,
    /// It was answered with a fix claim (or its thread resolved with no verdict): re-judge it now,
    /// even if its file did not change.
    pub rejudge: bool,
    /// When that claim was made.
    pub rejudge_at: Option<String>,
}

/// The finding's own thread.
fn read_own(thread: &HostThread) -> (FindingReading, Option<String>) {
    let status = thread.status.clone().unwrap_or_default();
    let last_mark = thread.comments.iter().rposition(|c| post_kind(&c.content) == Post::OurMark);
    let since = last_mark.map_or(0, |i| i + 1);
    let last_human = thread.comments[since..].iter().rfind(|c| post_kind(&c.content) == Post::Human);
    let last_human_at = last_human.map(|c| c.published.clone());
    let mut out = FindingReading::default();

    // A status the team set (not one this app's own mark left behind) is the dismissal; the words
    // only type it — unless they take it back.
    if is_dismissal_status(&status) && last_mark.is_none() {
        if last_human.is_some_and(|c| retraction().is_match(&fold(&c.content))) {
            return (out, last_human_at);
        }
        let kind = dismissal_type(last_human.map_or("", |c| c.content.as_str()), &status);
        out.signal = Some(Signal {
            kind,
            via: Via::Status,
            motivo: last_human
                .map(|c| clip(&c.content, REASON_CHARS))
                .unwrap_or_else(|| format!("El equipo cerró el hilo del PR como «{}».", status_label(&status))),
            autor: last_human.map(|c| c.author.clone()).unwrap_or_default(),
            at: last_human
                .map(|c| c.published.clone())
                .or_else(|| thread.updated.clone())
                .unwrap_or_default(),
            opening: true,
        });
        return (out, last_human_at);
    }
    if !is_text_status(&status) && !is_dismissal_status(&status) {
        return (out, last_human_at);
    }
    if let Some(c) = last_human {
        let reading = read_comment(&c.content);
        match reading {
            Reading::Opening(kind) | Reading::Mention(kind) => {
                out.signal = Some(Signal {
                    kind,
                    via: Via::Texto,
                    motivo: clip(&c.content, REASON_CHARS),
                    autor: c.author.clone(),
                    at: c.published.clone(),
                    opening: matches!(reading, Reading::Opening(_)),
                });
            }
            Reading::FixClaim => {
                out.rejudge = true;
                out.rejudge_at = Some(c.published.clone());
            }
            Reading::Nothing => {}
        }
    }
    // Resolved by somebody with no verdict said: they think it is fixed — the reviewer checks.
    if out.signal.is_none() && last_mark.is_none() && (thread.resolved || status == "fixed") {
        out.rejudge = true;
        out.rejudge_at = out.rejudge_at.or_else(|| thread.updated.clone()).or(last_human_at.clone());
    }
    (out, last_human_at)
}

fn status_label(status: &str) -> &str {
    match status {
        "wontfix" => "won't fix",
        "bydesign" => "by design",
        "closed" => "closed",
        other => other,
    }
}

/// One finding's block of a human reply to the summary.
#[derive(Debug, Clone, PartialEq)]
struct Block {
    ids: Vec<String>,
    /// What the verdict is read from: the anchor line without its ids and `(sev · categoría)`.
    head: String,
    /// The head plus the block's lines — the reason.
    reason: String,
    preamble: String,
    /// It started at a line that opens with its id(s) (or a table row), not a mid-sentence mention.
    anchored: bool,
}

/// `(text before the first id, [(ids, segment up to the next group)])`. Ids with only separators
/// between them share one segment.
fn split_mentions(text: &str) -> (String, Vec<(Vec<String>, String)>) {
    let ms: Vec<regex::Match> = id_re().find_iter(text).collect();
    let Some(first) = ms.first() else { return (text.to_string(), Vec::new()) };
    let mut groups: Vec<(Vec<String>, usize, usize)> = Vec::new();
    let mut ids = vec![first.as_str().to_uppercase()];
    let mut last_end = first.end();
    for m in &ms[1..] {
        if id_gap().is_match(&text[last_end..m.start()]) {
            ids.push(m.as_str().to_uppercase());
        } else {
            groups.push((std::mem::take(&mut ids), last_end, m.start()));
            ids.push(m.as_str().to_uppercase());
        }
        last_end = m.end();
    }
    groups.push((ids, last_end, text.len()));
    let groups = groups
        .into_iter()
        .map(|(mut ids, s, e)| {
            let mut seen = std::collections::HashSet::new();
            ids.retain(|id| seen.insert(id.clone()));
            (ids, text[s..e].to_string())
        })
        .collect();
    (text[..first.start()].to_string(), groups)
}

/// `(ids, text)` of a markdown table row, `None` when `line` is not one. The row is the unit: in
/// "| ✅ Corregidos | F-001, F-006 |" the ids close it, and splitting at each id would hand them the
/// next row's label.
fn table_row(line: &str) -> Option<(Vec<String>, String)> {
    let s = line.trim();
    if !s.starts_with('|') || s.matches('|').count() < 2 {
        return None;
    }
    let cells: Vec<&str> = s.trim_matches('|').split('|').map(str::trim).collect();
    if cells.iter().filter(|c| !c.is_empty()).all(|c| table_rule_cell().is_match(c)) {
        return Some((Vec::new(), String::new()));
    }
    let mut ids: Vec<String> = Vec::new();
    for m in id_re().find_iter(s) {
        let id = m.as_str().to_uppercase();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut texts = Vec::new();
    for c in cells {
        if id_gap().is_match(&id_re().replace_all(c, "")) {
            continue; // ids only, or empty
        }
        let rest = match anchor().find(c) {
            Some(m) => c[m.end()..].trim_start_matches(SEG_NOISE),
            None => c,
        };
        if !rest.is_empty() {
            texts.push(rest.to_string());
        }
    }
    Some((ids, texts.join(" — ")))
}

/// A preamble that introduces a list ("Falsos positivos:", "### Deuda") lends its verdict to the ids
/// under it; a plain sentence does not.
fn is_list_header(preamble: &str) -> bool {
    let p = preamble.trim().trim_matches(['*', '_', ' ']);
    p.ends_with(':') || preamble.trim_start().starts_with('#')
}

/// A human reply to the summary → one block per finding it answers. One reply often answers several
/// findings, each with its own justification:
///
/// ```text
/// F-001 (Mayor · unbounded-loop) — Resuelto.
/// Se corrigió la guarda…
///
/// F-002 (Menor · contract-mismatch) — Falso positivo, sin cambios.
/// fmt() ya maneja el caso boolean…
/// ```
///
/// A line that *starts* with id(s) opens a block, running over the following lines until the next
/// such line or a blank-separated paragraph that doesn't start with an id (which becomes the
/// preamble of later blocks). A table row is one block. With no anchor line at all ("F-003 es falso
/// positivo, F-005 no aplica") the text is split at every id mention instead.
fn split_by_finding(text: &str) -> Vec<Block> {
    struct Raw {
        ids: Vec<String>,
        seg: String,
        extra: Vec<String>,
        preamble: String,
        anchored: bool,
    }
    let lines: Vec<&str> = text.lines().collect();
    let mut raw: Vec<Raw> = Vec::new();
    let anchored_text = lines.iter().any(|ln| anchor().is_match(ln) || table_row(ln).is_some_and(|(ids, _)| !ids.is_empty()));
    if !anchored_text {
        let joined = lines.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" ");
        let (preamble, groups) = split_mentions(&joined);
        raw = groups
            .into_iter()
            .map(|(ids, seg)| Raw { ids, seg, extra: Vec::new(), preamble: preamble.clone(), anchored: false })
            .collect();
    } else {
        let mut context: Vec<String> = Vec::new();
        let mut cur: Option<usize> = None;
        let (mut anchor_only, mut blank) = (false, false);
        for ln in lines {
            if ln.trim().is_empty() {
                blank = true;
                continue;
            }
            if let Some((ids, row_text)) = table_row(ln) {
                if !ids.is_empty() {
                    raw.push(Raw { ids, seg: row_text, extra: Vec::new(), preamble: context.join(" "), anchored: true });
                }
                cur = None;
                anchor_only = false;
                blank = true; // a table closes the paragraph
                continue;
            }
            if anchor().is_match(ln) {
                let (_, groups) = split_mentions(ln);
                let pre = context.join(" ");
                for (ids, seg) in groups {
                    raw.push(Raw { ids, seg, extra: Vec::new(), preamble: pre.clone(), anchored: true });
                    cur = Some(raw.len() - 1);
                }
                anchor_only = true;
            } else if let Some(i) = cur.filter(|_| !blank || anchor_only) {
                raw[i].extra.push(ln.trim().to_string());
                anchor_only = false;
            } else {
                if cur.is_some() || blank {
                    context.clear(); // a new free paragraph replaces the previous context
                }
                cur = None;
                context.push(ln.trim().to_string());
            }
            blank = false;
        }
    }

    raw.into_iter()
        .map(|b| {
            let seg = trail_join().replace(&b.seg, "").trim_start_matches(SEG_NOISE).to_string();
            let own = lead_paren().replace(&seg, "").trim_start_matches(SEG_NOISE).to_string();
            let (head, reason) = if !own.is_empty() {
                let mut reason = vec![own.clone()];
                reason.extend(b.extra.iter().cloned());
                (own, reason.join(" "))
            } else if let Some(first) = b.extra.first() {
                (first.clone(), b.extra.join(" "))
            } else {
                // "F-003 (el framework valida)": the parenthesis IS the justification.
                (String::new(), seg)
            };
            Block { ids: b.ids, head, reason, preamble: b.preamble.trim().to_string(), anchored: b.anchored }
        })
        .collect()
}

/// The latest word each finding id got in replies to the summary (or, where the host has no reply
/// chain — GitHub's conversation comments — in a PR-level comment written after it).
fn summary_words(threads: &[HostThread], flat_general: bool) -> HashMap<String, FindingReading> {
    let mut words: HashMap<String, (String, FindingReading)> = HashMap::new();
    let first_summary_at = threads
        .iter()
        .filter(|t| is_summary(t))
        .filter_map(|t| t.comments.first().map(|c| c.published.clone()))
        .min_by(|a, b| if after(a, b) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less });

    let mut replies: Vec<(&HostComment, bool)> = Vec::new();
    for t in threads {
        if is_summary(t) {
            replies.extend(t.comments.iter().skip(1).map(|c| (c, false)));
        } else if flat_general && t.general {
            if let Some(since) = &first_summary_at {
                replies.extend(t.comments.iter().filter(|c| after(&c.published, since)).map(|c| (c, true)));
            }
        }
    }
    for (c, needs_anchor) in replies {
        if post_kind(&c.content) != Post::Human {
            continue;
        }
        for blk in split_by_finding(&c.content) {
            if needs_anchor && !blk.anchored {
                continue;
            }
            let mut reading = read_comment(&blk.head);
            let mut reason = blk.reason.clone();
            if reading == Reading::Nothing && !blk.preamble.is_empty() && is_list_header(&blk.preamble) {
                // "Falsos positivos:" above the list IS the verdict of every id under it.
                reading = match read_comment(&blk.preamble) {
                    Reading::Opening(k) | Reading::Mention(k) => Reading::Opening(k),
                    _ => Reading::Nothing,
                };
                if reason.is_empty() {
                    reason = blk.preamble.clone();
                }
            }
            let word = match reading {
                Reading::Opening(kind) | Reading::Mention(kind) => FindingReading {
                    signal: Some(Signal {
                        kind,
                        via: Via::Resumen,
                        motivo: clip(&reason, REASON_CHARS),
                        autor: c.author.clone(),
                        at: c.published.clone(),
                        opening: matches!(reading, Reading::Opening(_)),
                    }),
                    ..Default::default()
                },
                Reading::FixClaim => FindingReading { rejudge: true, rejudge_at: Some(c.published.clone()), ..Default::default() },
                // Context, not a verdict — but it is the latest word on the id, and it retracts an
                // earlier dismissal ("F-002 me equivoqué, hay que corregirlo").
                Reading::Nothing => FindingReading::default(),
            };
            for id in &blk.ids {
                let newer = words.get(id).is_none_or(|(at, _)| !after(at, &c.published));
                if newer {
                    words.insert(id.clone(), (c.published.clone(), word.clone()));
                }
            }
        }
    }
    words.into_iter().map(|(id, (_, w))| (id, w)).collect()
}

/// What the PR said about each active finding, by id. Only findings that are still active can be
/// moved: a ruled-out one already carries a human verdict, and a resolved one is history.
///
/// Precedence, per finding: its own thread beats the summary, and a summary verdict older than the
/// last human word on its own thread is nobody's last word. A verdict older than the moment a human
/// reopened the finding here is the one they overrode, and is dropped.
pub fn read(findings: &[MemoryFinding], threads: &[HostThread], flat_general: bool) -> Vec<(String, FindingReading)> {
    let by_id: HashMap<i64, &HostThread> = threads.iter().map(|t| (t.id, t)).collect();
    let summary = summary_words(threads, flat_general);
    let mut out = Vec::new();
    for f in findings.iter().filter(|f| f.is_active()) {
        let (own, own_last) = match f.thread_id.and_then(|id| by_id.get(&id)) {
            Some(t) => read_own(t),
            None => (FindingReading::default(), None),
        };
        let mut reading = own;
        if reading.signal.is_none() {
            if let Some(word) = summary.get(&f.id.to_uppercase()) {
                let word_at = word.signal.as_ref().map(|s| s.at.clone()).or_else(|| word.rejudge_at.clone()).unwrap_or_default();
                if !own_last.as_deref().is_some_and(|own| after(own, &word_at)) {
                    reading.signal = word.signal.clone();
                    if word.rejudge {
                        reading.rejudge = true;
                        reading.rejudge_at = word.rejudge_at.clone();
                    }
                }
            }
        }
        if let (Some(s), Some(reopened)) = (&reading.signal, &f.hilo_pr.reabierto_en) {
            if !after(&s.at, reopened) {
                reading.signal = None;
            }
        }
        if let (Some(at), Some(reopened)) = (&reading.rejudge_at, &f.hilo_pr.reabierto_en) {
            if !after(at, reopened) && reading.signal.is_none() && f.thread_id.is_some() {
                // A claim from before the reopening was already weighed when the human reopened it.
                reading.rejudge = false;
            }
        }
        if reading.signal.is_some() || reading.rejudge {
            out.push((f.id.clone(), reading));
        }
    }
    out
}

/// Whether the readings are a reason to review again even though no code moved: a verdict that
/// would apply (it moves the memory, so it never repeats), or anything said since the last run.
pub fn worth_a_rerun(readings: &[(String, FindingReading)], since: Option<&str>) -> bool {
    readings.iter().any(|(_, r)| {
        r.signal.as_ref().is_some_and(|s| s.opening)
            || since.is_some_and(|since| {
                r.signal.as_ref().is_some_and(|s| after(&s.at, since)) || r.rejudge_at.as_deref().is_some_and(|at| after(at, since))
            })
    })
}

/// One verdict this re-review took from the PR.
#[derive(Debug, Clone, PartialEq)]
pub struct Synced {
    pub id: String,
    pub estado: &'static str,
    pub via: Via,
    pub motivo: String,
}

/// What [`apply`] did.
#[derive(Debug, Clone, Default)]
pub struct SyncOutcome {
    pub applied: Vec<Synced>,
    /// Findings now carrying a verdict for a human to apply.
    pub suggested: usize,
    /// Ids to re-judge in this re-review even if their file did not change.
    pub rejudge: Vec<String>,
    /// Whether any finding changed (what decides writing the memory back).
    pub changed: bool,
}

/// Moves the memory by the readings: a status verdict, or an opening one on a file this iteration
/// did not change, applies — through [`set_finding_state`], the human's words as the reason, marked
/// as synced. Everything else the PR said is kept as the finding's [`VeredictoPr`]. Every active
/// finding's pending verdict is recomputed here, so a reply that was edited or taken back stops
/// being offered.
///
/// `changed_files`: the files that changed since the previous run; `None` when the run cannot tell
/// (a first or full review, a review with no clone) — nothing then counts as "the code moved".
pub fn apply(
    findings: &mut [MemoryFinding],
    readings: &[(String, FindingReading)],
    changed_files: Option<&[String]>,
    iter: usize,
) -> SyncOutcome {
    let mut out = SyncOutcome::default();
    let by_id: HashMap<&str, &FindingReading> = readings.iter().map(|(id, r)| (id.as_str(), r)).collect();
    for f in findings.iter_mut().filter(|f| f.is_active()) {
        let before = f.hilo_pr.veredicto_pr.clone();
        f.hilo_pr.veredicto_pr = None;
        let Some(reading) = by_id.get(f.id.as_str()) else {
            out.changed |= before.is_some();
            continue;
        };
        let moved = match (&f.archivo, changed_files) {
            (Some(file), Some(changed)) => changed.iter().any(|c| super::outline::same_path(c, file)),
            _ => false,
        };
        if reading.rejudge {
            out.rejudge.push(f.id.clone());
        }
        let Some(s) = &reading.signal else {
            out.changed |= before.is_some();
            continue;
        };
        // The delta beats words: the code moved, so a phrase about the old code is re-checked.
        let applies = s.opening && (s.via == Via::Status || !moved);
        if applies && set_finding_state(f, s.kind.estado(), Some(s.motivo.clone()), iter).is_ok() {
            f.hilo_pr.sincronizado_desde_hilo = true;
            f.hilo_pr.sincronizado_via = Some(s.via.as_str().to_string());
            f.hilo_pr.sincronizado_en_iter = Some(iter);
            out.applied.push(Synced { id: f.id.clone(), estado: s.kind.estado(), via: s.via, motivo: s.motivo.clone() });
            out.changed = true;
            continue;
        }
        if moved && s.via != Via::Status && !out.rejudge.contains(&f.id) {
            out.rejudge.push(f.id.clone());
        }
        f.hilo_pr.veredicto_pr = Some(VeredictoPr {
            estado: s.kind.estado().to_string(),
            motivo: s.motivo.clone(),
            via: s.via.as_str().to_string(),
            autor: s.autor.clone(),
            fecha: s.at.clone(),
        });
        out.suggested += 1;
        out.changed |= before != f.hilo_pr.veredicto_pr;
    }
    out
}

fn estado_label(estado: &str) -> &'static str {
    match estado {
        "falso_positivo" => "falso positivo",
        ESTADO_DEUDA => "deuda técnica",
        _ => "ignorado",
    }
}

/// The report's lines for what iteration `iter` took from the PR — one per finding, with the
/// human's words, so the reader sees which state was not decided by this app. `None` when nothing.
pub fn report_lines(findings: &[MemoryFinding], iter: usize) -> Option<String> {
    let lines: Vec<String> = findings
        .iter()
        .filter(|f| f.hilo_pr.sincronizado_desde_hilo && f.hilo_pr.sincronizado_en_iter == Some(iter))
        .map(|f| {
            let motivo = f.motivo_descarte.as_deref().map(|m| clip(m, 160)).unwrap_or_default();
            let quote = if motivo.is_empty() { String::new() } else { format!(" («{motivo}»)") };
            format!("🔄 Sincronizado desde el PR: {} → {}{}\n", f.id, estado_label(&f.estado), quote)
        })
        .collect();
    (!lines.is_empty()).then(|| format!("{}\n", lines.concat()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(text: &str) -> Reading {
        read_comment(text)
    }

    #[test]
    fn a_comment_that_opens_with_the_verdict_counts_in_spanish_and_english() {
        assert_eq!(kind("Falso positivo: el padre ya valida el id."), Reading::Opening(Kind::FalsoPositivo));
        assert_eq!(kind("No aplica, el endpoint es interno."), Reading::Opening(Kind::FalsoPositivo));
        assert_eq!(kind("**Es intencional**: el retry lo maneja la cola."), Reading::Opening(Kind::FalsoPositivo));
        assert_eq!(kind("Deuda técnica: lo migramos en Q3."), Reading::Opening(Kind::Deuda));
        assert_eq!(kind("Deuda aceptada, va al backlog."), Reading::Opening(Kind::Deuda));
        assert_eq!(kind("Ignorar: es código generado."), Reading::Opening(Kind::Ignorado));
        assert_eq!(kind("No se va a corregir: el módulo se elimina."), Reading::Opening(Kind::Ignorado));
        assert_eq!(kind("🙈 Ignorado — nadie genera clientes así."), Reading::Opening(Kind::Ignorado));
        assert_eq!(kind("False positive: the caller already checks for null."), Reading::Opening(Kind::FalsoPositivo));
        assert_eq!(kind("Not a bug, this is by design."), Reading::Opening(Kind::FalsoPositivo));
        assert_eq!(kind("Won't fix: the module is being removed."), Reading::Opening(Kind::Ignorado));
        assert_eq!(kind("Tech debt — tracked in JIRA-123."), Reading::Opening(Kind::Deuda));
        assert_eq!(kind("Ignore. Generated code."), Reading::Opening(Kind::Ignorado));
        // Accents and case are not what decides.
        assert_eq!(kind("NO APLICÁ acá"), Reading::Opening(Kind::FalsoPositivo));
        // "No aplica. Queda como deuda" is debt — the more specific verdict wins wherever it sits.
        assert_eq!(kind("No aplica. Queda como deuda hasta el refactor."), Reading::Opening(Kind::Deuda));
    }

    #[test]
    fn a_negated_or_asked_verdict_is_no_verdict() {
        assert_eq!(kind("No creo que sea un falso positivo, revisemos."), Reading::Nothing);
        assert_eq!(kind("No es intencional, hay que cambiarlo."), Reading::Nothing);
        assert_eq!(kind("¿Esto es intencional?"), Reading::Nothing);
        assert_eq!(kind("Falso positivo? no, hay que cambiarlo"), Reading::Nothing);
        assert_eq!(kind("Is this a false positive?"), Reading::Nothing);
        assert_eq!(kind("This isn't a false positive."), Reading::Nothing);
        assert_eq!(kind("It isn’t a false positive, please fix it."), Reading::Nothing);
        // A dismissal followed by a contrast asking for a change.
        assert_eq!(kind("El retry no aplica acá, pero hay que cambiarlo igual."), Reading::Nothing);
        assert_eq!(kind("Not an issue here, but we still need to rename it."), Reading::Nothing);
        // "Ignore …" opening an ordinary sentence is an imperative, not a verdict.
        assert_eq!(kind("Ignore the formatting, the null check is the real problem."), Reading::Nothing);
    }

    #[test]
    fn a_verdict_further_in_is_only_offered() {
        assert_eq!(
            kind("Lo revisé con el equipo y después de mirarlo un buen rato concluimos que es un falso positivo."),
            Reading::Mention(Kind::FalsoPositivo)
        );
        assert_eq!(kind("Gracias por el aviso. Esto no aplica porque el flag está apagado."), Reading::Mention(Kind::FalsoPositivo));
        assert_eq!(kind("Thanks. We discussed it and it is accepted debt for now."), Reading::Mention(Kind::Deuda));
        // A label opening it with a contrast: the PR's word, never applied alone.
        assert_eq!(kind("Falso positivo, pero hay que documentarlo."), Reading::Mention(Kind::FalsoPositivo));
    }

    #[test]
    fn a_fix_claim_reopens_judgement_and_never_dismisses() {
        assert_eq!(kind("Corregido en abc123."), Reading::FixClaim);
        assert_eq!(kind("Ya lo corregí, gracias."), Reading::FixClaim);
        assert_eq!(kind("Fixed in 4f2e1a9."), Reading::FixClaim);
        assert_eq!(kind("Corregido en abc. No aplica el cambio sugerido tal cual."), Reading::FixClaim);
        // A dismissal phrase beside a fix mention is only the PR's word.
        assert_eq!(kind("No aplica tal cual; lo arreglé de otra forma."), Reading::Mention(Kind::FalsoPositivo));
        assert_eq!(kind("Buen punto, gracias."), Reading::Nothing);
    }

    #[test]
    fn the_status_types_the_dismissal_when_the_words_do_not() {
        assert_eq!(dismissal_type("", "wontfix"), Kind::Ignorado);
        assert_eq!(dismissal_type("", "closed"), Kind::Ignorado);
        assert_eq!(dismissal_type("", "bydesign"), Kind::FalsoPositivo);
        assert_eq!(dismissal_type("Lo dejamos, gracias.", "bydesign"), Kind::FalsoPositivo);
        assert_eq!(dismissal_type("Deuda técnica: Q3.", "wontfix"), Kind::Deuda);
        assert_eq!(dismissal_type("Aceptado como deuda.", "closed"), Kind::Deuda);
        assert_eq!(dismissal_type("Es intencional por el contrato.", "wontfix"), Kind::FalsoPositivo);
        assert_eq!(dismissal_type("Es por diseño.", "closed"), Kind::FalsoPositivo);
        assert_eq!(dismissal_type("Accepted as tech debt.", "bydesign"), Kind::Deuda);
    }

    #[test]
    fn this_apps_own_posts_are_told_apart_by_their_bodies() {
        assert!(is_app_post("### 🔴 [Bug] npe · F-002\n\nUn null llega al render."));
        assert!(is_app_post("📍 `src/a.ts:4` _(fuera del diff del pull request: publicado como comentario general)_\n\n### 🟡 [Code Smell] naming · F-010\n\nx"));
        assert!(is_app_post("➡️ _Sigue presente en la iteración 3 — 2026-09-28._"));
        assert!(is_app_post("✔️ **F-002** — Resuelto en la iteración 2 — 2026-09-28."));
        assert!(is_app_post("### 📋 Revisión automatizada (pr-review) — 2026-10-01\n\n🛡️ **Quality Gate:** ✅ PASSED"));
        assert!(is_app_post("🚫 **Falso positivo** — descartado por la persona revisora.\n\n_Marcado desde CodeFlow. Este hallazgo no se volverá a reportar._"));
        assert!(!is_app_post("Falso positivo: el padre valida."));
        assert!(!is_app_post("### Nota\nEsto es mío"));
    }

    // --- fixtures -------------------------------------------------------------------------

    fn c(author: &str, content: &str, at: &str) -> HostComment {
        HostComment { author: author.into(), content: content.into(), published: at.into() }
    }

    const OURS: &str = "### 🔴 [Bug] npe · F-002\n\nUn null llega al render.";

    fn thread(id: i64, status: Option<&str>, comments: Vec<HostComment>) -> HostThread {
        HostThread { id, status: status.map(str::to_string), comments, ..Default::default() }
    }

    fn finding(id: &str, file: &str, thread: Option<i64>) -> MemoryFinding {
        serde_json::from_value(serde_json::json!({
            "id": id, "severity": "critical", "tipo": "Bug", "categoria": "npe", "subtitulo": "x",
            "archivo": file, "lineas": "10", "confianza": 90,
            "estado": if thread.is_some() { "posteado" } else { "abierto" },
            "thread_id": thread,
        }))
        .unwrap()
    }

    fn sync(findings: &mut [MemoryFinding], threads: &[HostThread], changed: Option<&[String]>) -> SyncOutcome {
        let readings = read(findings, threads, false);
        apply(findings, &readings, changed, 3)
    }

    #[test]
    fn an_azure_wont_fix_thread_syncs_typed_by_its_last_human_comment() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, Some("wontfix"), vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("ana", "Deuda técnica: lo migramos en Q3.", "2026-10-02T10:00:00Z")])];
        // Its file changed — a status applies anyway.
        let changed = vec!["src/a.ts".to_string()];
        let out = sync(&mut fs, &threads, Some(&changed));
        assert_eq!(out.applied.len(), 1);
        assert_eq!(fs[0].estado, ESTADO_DEUDA);
        assert_eq!(fs[0].motivo_descarte.as_deref(), Some("Deuda técnica: lo migramos en Q3."));
        assert!(fs[0].hilo_pr.sincronizado_desde_hilo);
        assert_eq!(fs[0].hilo_pr.sincronizado_via.as_deref(), Some("status"));
        assert_eq!(fs[0].hilo_pr.sincronizado_en_iter, Some(3));
    }

    #[test]
    fn a_bare_status_falls_back_to_its_own_meaning() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7)), finding("F-003", "src/b.ts", Some(8))];
        let mut by_design = thread(7, Some("bydesign"), vec![c("me", OURS, "2026-10-01T10:00:00Z")]);
        by_design.updated = Some("2026-10-02T09:00:00Z".into());
        let closed = thread(8, Some("closed"), vec![c("me", OURS, "2026-10-01T10:00:00Z")]);
        sync(&mut fs, &[by_design, closed], None);
        assert_eq!(fs[0].estado, "falso_positivo");
        assert!(fs[0].motivo_descarte.as_deref().unwrap().contains("by design"));
        assert_eq!(fs[1].estado, "ignorado");
    }

    #[test]
    fn a_closed_thread_whose_last_word_takes_it_back_does_not_sync() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, Some("wontfix"), vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("ana", "Me equivoqué, hay que corregirlo.", "2026-10-02T10:00:00Z")])];
        let out = sync(&mut fs, &threads, None);
        assert!(out.applied.is_empty());
        assert_eq!(fs[0].estado, "posteado");
    }

    #[test]
    fn our_own_mark_left_the_status_and_is_never_read_back() {
        // Marked here (the app replied and closed it as won't fix), then reopened here: the thread
        // still says won't fix, and that is this app's doing.
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(
            7,
            Some("wontfix"),
            vec![
                c("me", OURS, "2026-10-01T10:00:00Z"),
                c("me", "🚫 **Falso positivo** — descartado por la persona revisora.\n\n_Marcado desde CodeFlow. Este hallazgo no se volverá a reportar en las próximas revisiones._", "2026-10-02T10:00:00Z"),
            ],
        )];
        let out = sync(&mut fs, &threads, None);
        assert!(out.applied.is_empty() && out.suggested == 0);
        assert_eq!(fs[0].estado, "posteado");
    }

    #[test]
    fn the_same_account_replying_by_hand_still_counts() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, Some("active"), vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("me", "Falso positivo: el padre ya valida.", "2026-10-02T10:00:00Z")])];
        let out = sync(&mut fs, &threads, Some(&[]));
        assert_eq!(out.applied, vec![Synced { id: "F-002".into(), estado: "falso_positivo", via: Via::Texto, motivo: "Falso positivo: el padre ya valida.".into() }]);
        assert_eq!(fs[0].hilo_pr.sincronizado_via.as_deref(), Some("texto"));
    }

    #[test]
    fn the_delta_beats_words_but_not_a_status() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, Some("active"), vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("ana", "No aplica: el flag está apagado.", "2026-10-02T10:00:00Z")])];
        let changed = vec!["/src/a.ts".to_string()];
        let out = sync(&mut fs, &threads, Some(&changed));
        assert!(out.applied.is_empty());
        assert_eq!(out.rejudge, vec!["F-002".to_string()]);
        assert_eq!(fs[0].estado, "posteado");
        let v = fs[0].hilo_pr.veredicto_pr.as_ref().expect("offered instead");
        assert_eq!((v.estado.as_str(), v.via.as_str(), v.autor.as_str()), ("falso_positivo", "texto", "ana"));
    }

    #[test]
    fn a_mid_comment_verdict_is_offered_not_applied() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, None, vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("bea", "Gracias. Lo hablamos y para nosotros es un falso positivo.", "2026-10-02T10:00:00Z")])];
        let out = sync(&mut fs, &threads, None);
        assert!(out.applied.is_empty());
        assert_eq!(out.suggested, 1);
        assert_eq!(fs[0].hilo_pr.veredicto_pr.as_ref().unwrap().estado, "falso_positivo");
        // The next re-review recomputes it: the reply edited away, the offer goes too.
        let edited = vec![thread(7, None, vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("bea", "Gracias.", "2026-10-02T10:00:00Z")])];
        let out = sync(&mut fs, &edited, None);
        assert!(out.changed && fs[0].hilo_pr.veredicto_pr.is_none());
    }

    #[test]
    fn a_fix_claim_forces_a_rejudge_without_moving_the_state() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, Some("active"), vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("ana", "Corregido en 4f2e1a9.", "2026-10-02T10:00:00Z")])];
        let out = sync(&mut fs, &threads, Some(&[]));
        assert_eq!(out.rejudge, vec!["F-002".to_string()]);
        assert_eq!(fs[0].estado, "posteado");
        assert!(worth_a_rerun(&read(&fs, &threads, false), Some("2026-10-01T12:00:00Z")));
        assert!(!worth_a_rerun(&read(&fs, &threads, false), Some("2026-10-03T00:00:00Z")));
    }

    #[test]
    fn a_github_resolved_conversation_alone_decides_nothing_but_asks_for_a_look() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let mut t = thread(7, None, vec![c("me", OURS, "2026-10-01T10:00:00Z")]);
        t.resolved = true;
        let out = sync(&mut fs, &[t.clone()], None);
        assert!(out.applied.is_empty());
        assert_eq!(out.rejudge, vec!["F-002".to_string()]);
        // …while resolved with an opening verdict, the words decide.
        t.comments.push(c("ana", "Won't fix: legacy module.", "2026-10-02T10:00:00Z"));
        sync(&mut fs, &[t], None);
        assert_eq!(fs[0].estado, "ignorado");
    }

    #[test]
    fn a_summary_reply_answers_each_finding_by_its_id() {
        let mut fs = vec![
            finding("F-001", "src/a.ts", Some(7)),
            finding("F-002", "src/b.ts", Some(8)),
            finding("F-003", "src/c.ts", None),
            finding("F-004", "src/d.ts", None),
        ];
        let summary = thread(
            50,
            None,
            vec![
                c("me", "### 📋 Revisión automatizada (pr-review) — 2026-10-01\n\n| | F-001 | x |", "2026-10-01T10:00:00Z"),
                c(
                    "ana",
                    "F-001 (Mayor · unbounded-loop) — Corregido en abc.\nSe corrigió la guarda.\n\nF-002 (Menor · npe) — Falso positivo, sin cambios.\nfmt() ya maneja el caso.\n\nF-003 y F-004: no aplican, es código generado.",
                    "2026-10-02T10:00:00Z",
                ),
            ],
        );
        let threads = vec![thread(7, Some("active"), vec![c("me", OURS, "2026-10-01T10:00:00Z")]), thread(8, Some("active"), vec![c("me", OURS, "2026-10-01T10:00:00Z")]), summary];
        let out = sync(&mut fs, &threads, Some(&[]));
        assert_eq!(fs[0].estado, "posteado");
        assert!(out.rejudge.contains(&"F-001".to_string()));
        assert_eq!(fs[1].estado, "falso_positivo");
        assert_eq!(fs[1].hilo_pr.sincronizado_via.as_deref(), Some("resumen"));
        assert!(fs[1].motivo_descarte.as_deref().unwrap().contains("fmt() ya maneja el caso"));
        // "no aplican" is not a phrase of the list, but "no aplica" is in it.
        assert_eq!(fs[2].estado, "falso_positivo");
        assert_eq!(fs[3].estado, "falso_positivo");
    }

    #[test]
    fn a_list_header_lends_its_verdict_and_a_later_reply_retracts() {
        let mut fs = vec![finding("F-005", "src/a.ts", None), finding("F-006", "src/b.ts", None)];
        let summary = thread(
            50,
            None,
            vec![
                c("me", "### 📋 Revisión automatizada (pr-review) — 2026-10-01", "2026-10-01T10:00:00Z"),
                c("ana", "Ignored:\n- F-005 generated\n- F-006 generated", "2026-10-02T10:00:00Z"),
                c("ana", "F-006: me equivoqué, hay que corregirlo.", "2026-10-03T10:00:00Z"),
            ],
        );
        sync(&mut fs, &[summary], None);
        assert_eq!(fs[0].estado, "ignorado");
        assert_eq!(fs[1].estado, "abierto");
    }

    #[test]
    fn the_findings_own_thread_beats_an_older_summary_word() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![
            thread(7, Some("active"), vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("ana", "Lo miro mañana.", "2026-10-04T10:00:00Z")]),
            thread(50, None, vec![c("me", "### 📋 Revisión automatizada (pr-review) — 2026-10-01", "2026-10-01T10:00:00Z"), c("ana", "F-002: falso positivo.", "2026-10-02T10:00:00Z")]),
        ];
        let out = sync(&mut fs, &threads, None);
        assert!(out.applied.is_empty());
        assert_eq!(fs[0].estado, "posteado");
    }

    #[test]
    fn on_github_a_later_conversation_comment_naming_the_id_is_a_summary_reply() {
        let mut fs = vec![finding("F-002", "src/a.ts", None)];
        let mut summary = thread(50, None, vec![c("me", "### 📋 Revisión automatizada (pr-review) — 2026-10-01", "2026-10-01T10:00:00Z")]);
        summary.general = true;
        let mut reply = thread(51, None, vec![c("ana", "F-002: deuda técnica, lo vemos en el refactor.", "2026-10-02T10:00:00Z")]);
        reply.general = true;
        // A mid-sentence mention in a loose comment is not an answer.
        let mut chatter = thread(52, None, vec![c("bea", "Me parece que F-003 es un falso positivo", "2026-10-02T11:00:00Z")]);
        chatter.general = true;
        let threads = vec![summary, reply, chatter];
        let readings = read(&fs, &threads, true);
        apply(&mut fs, &readings, None, 2);
        assert_eq!(fs[0].estado, ESTADO_DEUDA);
        assert!(read(&fs, &threads, false).is_empty());
    }

    #[test]
    fn a_reopened_finding_is_not_dismissed_again_by_the_verdict_it_overrode() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, Some("wontfix"), vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("ana", "Ignorado.", "2026-10-02T10:00:00Z")])];
        sync(&mut fs, &threads, None);
        assert_eq!(fs[0].estado, "ignorado");
        set_finding_state(&mut fs[0], "abierto", None, 3).unwrap();
        assert!(fs[0].hilo_pr.reabierto_en.is_some() && !fs[0].hilo_pr.sincronizado_desde_hilo);
        let out = sync(&mut fs, &threads, None);
        assert!(out.applied.is_empty());
        assert_eq!(fs[0].estado, "posteado");
        // A new word after the reopening does count.
        let mut again = threads.clone();
        again[0].comments.push(c("ana", "Ignorado: sigue sin importar.", "2099-01-01T00:00:00Z"));
        sync(&mut fs, &again, None);
        assert_eq!(fs[0].estado, "ignorado");
    }

    #[test]
    fn only_active_findings_move() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        fs[0].estado = "resuelto".into();
        let threads = vec![thread(7, Some("wontfix"), vec![c("me", OURS, "2026-10-01T10:00:00Z")])];
        assert!(read(&fs, &threads, false).is_empty());
    }

    #[test]
    fn synced_discards_feed_the_dont_raise_again_block_and_the_report() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, Some("active"), vec![c("me", OURS, "2026-10-01T10:00:00Z"), c("ana", "Falso positivo: el padre ya valida el id antes de llamar.", "2026-10-02T10:00:00Z")])];
        sync(&mut fs, &threads, None);
        let block = crate::review_memory::discarded_block(&fs).expect("a human verdict");
        assert!(block.contains("F-002") && block.contains("el padre ya valida"));
        assert_eq!(
            report_lines(&fs, 3).unwrap(),
            "🔄 Sincronizado desde el PR: F-002 → falso positivo («Falso positivo: el padre ya valida el id antes de llamar.»)\n\n"
        );
        assert!(report_lines(&fs, 4).is_none());
    }

    #[test]
    fn a_synced_finding_round_trips_through_the_stored_json() {
        let mut fs = vec![finding("F-002", "src/a.ts", Some(7))];
        let threads = vec![thread(7, Some("bydesign"), vec![c("me", OURS, "2026-10-01T10:00:00Z")])];
        sync(&mut fs, &threads, None);
        let json = serde_json::to_value(&fs[0]).unwrap();
        assert_eq!(json["sincronizado_desde_hilo"], true);
        assert_eq!(json["sincronizado_via"], "status");
        let back: MemoryFinding = serde_json::from_value(json).unwrap();
        assert_eq!(back.hilo_pr, fs[0].hilo_pr);
        // A run written before any of this reads back as "the PR said nothing".
        let old = finding("F-009", "x", None);
        assert_eq!(old.hilo_pr, crate::review_memory::HiloPr::default());
        assert!(serde_json::to_value(&old).unwrap().get("veredicto_pr").is_none());
    }

    #[test]
    fn a_table_row_and_bare_mentions_split_per_id() {
        let blocks = split_by_finding("| ✅ Corregidos | F-001, F-006 |\n| 🚫 Falso positivo | F-002 |");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].ids, vec!["F-001", "F-006"]);
        assert_eq!(read_comment(&blocks[1].head), Reading::Opening(Kind::FalsoPositivo));
        let loose = split_by_finding("Revisado: F-003 es falso positivo, F-005 no aplica");
        assert_eq!(loose.iter().map(|b| b.ids.clone()).collect::<Vec<_>>(), vec![vec!["F-003".to_string()], vec!["F-005".to_string()]]);
        assert!(loose.iter().all(|b| !b.anchored));
        assert_eq!(read_comment(&loose[0].head), Reading::Opening(Kind::FalsoPositivo));
    }
}
