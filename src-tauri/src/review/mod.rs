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
//! | [`contract`] | The level's resolved contract (threshold, severities, lenses, effort, verification) and the gate policy. Numbers, not prose. |
//! | [`checkout`] | The read-only checkout of the PR's head commit the reviewers' tools read from. |
//! | [`outline`] | Which symbols each changed file declares, and which of their lines the PR touched. |
//! | [`plan`] | Scope filtering, skip triage, and the split of the files into balanced worker groups. |
//! | [`bundle`] | The reading bundle each worker gets: whole methods, numbered, `>` on what changed. |
//! | [`graph`] | Blast radius — who else in the repository calls the symbols this PR touched. |
//! | [`hints`] | What the saved review memory already settled about these same files, in other PRs. |
//! | [`context`] | Cutting all of that (and the PR's conversation) down to what each reviewer's files need. |
//! | [`merge`] | Parsing the workers' findings, deduping, filtering by contract, numbering. |
//! | [`verify`] | Grounding each finding in the code it names, and the level's refutation pass. |
//! | [`render`] | Findings back to the canonical review Markdown the whole frontend already reads. |
//!
//! **The output format is not this module's to change.** `render` emits exactly the shape
//! `src/lib/parseAnalysis.ts` parses and `review::merge::parse` reads back — the leading
//! `📈 CALIDAD:` line and the `### {emoji} [{Severidad} · {Tipo}] {Categoría} · F-NNN` blocks. That
//! contract is what lets the pipeline be rewritten underneath without touching posting, the finding
//! cards, or a single saved review.

pub mod bundle;
pub mod checkout;
pub mod context;
pub mod contract;
pub mod graph;
pub mod hints;
pub mod merge;
pub mod outline;
pub mod plan;
pub mod render;
pub mod verify;
