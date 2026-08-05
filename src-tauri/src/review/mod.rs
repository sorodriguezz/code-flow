//! The PR review engine: everything mechanical about a review that used to be left to the model.
//!
//! Ported from the transversal `WF-PR-REVIEWER` runbook, whose division of labour is the whole
//! idea: **the scripts resolve everything deterministic — what to read, how to split it, what
//! survives the threshold, how findings are numbered — and the model contributes the one thing
//! that isn't mechanical: reading the code and judging it.** There, that split was Python +
//! PowerShell reading a REST API; here it is Rust reading the local clone, which is both faster
//! and the reason the app still installs nothing on the user's machine.
//!
//! The pipeline, in the order a review runs it:
//!
//! | Module | What it owns |
//! |---|---|
//! | [`contract`] | The level's resolved contract (threshold, severities, lenses) and the gate policy. Numbers, not prose. |
//! | [`outline`] | Which symbols each changed file declares, and which of their lines the PR touched. |
//! | [`plan`] | Scope filtering, skip triage, and the split of the files into balanced worker groups. |
//! | [`bundle`] | The reading bundle each worker gets: whole methods, numbered, `>` on what changed. |
//! | [`graph`] | Blast radius — who else in the repository calls the symbols this PR touched. |
//! | [`hints`] | What the saved review memory already settled about these same files, in other PRs. |
//! | [`merge`] | Parsing the workers' findings, deduping, filtering by contract, numbering. |
//! | [`render`] | Findings back to the canonical review Markdown the whole frontend already reads. |
//!
//! **The output format is not this module's to change.** `render` emits exactly the shape
//! `src/lib/parseAnalysis.ts` parses and `review_memory::parse_findings` remembers — the leading
//! `📈 CALIDAD:` line and the `### {emoji} [{Severidad} · {Tipo}] {Categoría} · F-NNN` blocks. That
//! contract is what lets the pipeline be rewritten underneath without touching posting, the finding
//! cards, or a single saved review.

pub mod bundle;
pub mod contract;
pub mod graph;
pub mod hints;
pub mod merge;
pub mod outline;
pub mod plan;
pub mod render;
