//! The hybrid task: a subscription CLI plans and reviews, a local model writes the code.
//!
//! # Why this exists
//!
//! A subscription (Claude Code, Codex, agy) is a quota, and the expensive part of most changes is
//! not deciding what to do — it is writing the files. A model on the user's own machine can write
//! files for free, but it cannot be handed a repository: a 7B with a 16k window drowns in the context
//! an agentic CLI piles up, and Ollama's OpenAI-compatible endpoint silently cuts a long prompt down
//! to its default window (measured: 6,982 tokens arrived as 2,050 and the model invented an answer).
//!
//! So the work is split along that line, the way Aider's architect/editor mode and CrewAI's role
//! crews split it:
//!
//! 1. **Plan** — the subscription CLI reads the repository (read-only, enforced) and returns a JSON
//!    plan: one task per file, each with a self-contained instruction and the minimum references,
//!    cut to fit the executor's budget. See [`plan`].
//! 2. **Execute** — *this app*, not an agent, walks the plan. Each task is one stateless request to
//!    the local model carrying only its instruction, the file or regions it rewrites, and the
//!    references that fit; the answer is one fenced block, which this app validates and writes.
//!    Nothing accumulates between tasks, which is the whole point. See [`local_llm`], [`budget`].
//! 3. **Review** — the subscription CLI sees the diff since a baseline, fixes what is wrong and
//!    does the tasks the local model could not.
//!
//! A run is an agent chain (`kind = 'hybrid'`, three steps) for the same reasons a story run is
//! one; the plan's tasks live in `hybrid_items`, inside the execute step, never as chain steps.
//!
//! # Hardware
//!
//! Nothing here assumes the machine it was written on. The context, and therefore how much each
//! task may carry, comes from the chosen model and the memory the machine has — see
//! [`budget::machine`] and [`budget::suggest_ctx`].

pub mod apply;
pub mod budget;
pub mod config;
pub mod execute;
pub mod local_llm;
pub mod plan;
pub mod prompts;
pub mod runtime;
pub mod triage;

#[cfg(test)]
mod live_run;
