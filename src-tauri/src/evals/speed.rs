//! How fast a model reads and writes here — the measurement behind **Probar** in the «Local model»
//! pane and the speed line of a bench report, so both always say the same thing.

use serde::{Deserialize, Serialize};

use crate::hybrid::budget;
use crate::hybrid::local_llm::{self, BackendKind, ChatRequest, Endpoint, LocalError};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SpeedSample {
    pub sent_tokens: u64,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    /// Tokens a second the prompt was read at.
    pub prompt_tps: Option<f64>,
    /// Tokens a second the answer was written at.
    pub gen_tps: Option<f64>,
    pub first_token_ms: Option<u64>,
    pub total_ms: u64,
    /// Share of the model Ollama placed on the GPU (`None` elsewhere).
    pub gpu_share: Option<f64>,
    /// The server processed far fewer tokens than were sent: its window is smaller than configured.
    pub truncated: bool,
}

/// What one measurement needs to know about the model it talks to.
pub struct Probe<'a> {
    pub endpoint: &'a Endpoint,
    pub model: &'a str,
    pub kind: BackendKind,
    pub ctx: u32,
    /// Input budget of the window: the prompt is sized from it.
    pub input_budget: u32,
    pub think: Option<bool>,
}

/// Ordinary code up to about `target_tokens`, then a small request.
///
/// Sized from the budget rather than fixed: the failure this exists to catch is a server whose real
/// window is smaller than the one configured (LM Studio and llama.cpp both start at 4k unless told
/// otherwise), and only a prompt longer than that window exposes it.
pub fn probe_prompt(target_tokens: u64) -> String {
    let mut prompt = String::from("Reference code (do not repeat it):\n\n```ts\n");
    for i in 0.. {
        if budget::estimate_tokens(&prompt) >= target_tokens {
            break;
        }
        prompt.push_str(&format!(
            "export function normalizeRecord{i}(input: Record<string, unknown>): Record<string, string> {{\n  const out: Record<string, string> = {{}};\n  for (const [key, value] of Object.entries(input)) {{\n    out[key.trim().toLowerCase()] = String(value ?? \"\").trim();\n  }}\n  return out;\n}}\n\n"
        ));
    }
    prompt.push_str("```\n\nTask: write a TypeScript function `sumAll(values: number[]): number` that returns the sum. Answer with one fenced code block and nothing else.");
    prompt
}

/// Measures one request. Prompt length is capped so evaluation stays well under a minute on a laptop.
pub async fn measure(probe: &Probe<'_>) -> Result<SpeedSample, LocalError> {
    let system = "You write code. Answer with exactly one fenced code block.";
    let user = probe_prompt(u64::from(probe.input_budget.saturating_sub(256)).clamp(1_024, 6_000));
    let sent_tokens = match local_llm::count_tokens(probe.endpoint, &format!("{system}\n{user}")).await {
        Some(exact) => exact,
        None => budget::estimate_tokens(system) + budget::estimate_tokens(&user),
    };
    let request = ChatRequest {
        model: probe.model,
        system,
        user: &user,
        num_ctx: (probe.kind == BackendKind::Ollama).then_some(probe.ctx),
        max_tokens: 160,
        temperature: 0.0,
        think: probe.think,
        keep_alive: None,
        schema: None,
    };
    let outcome = local_llm::chat(probe.endpoint, &request, |_| {}, std::future::pending::<()>()).await?;
    let truncated = budget::truncated(sent_tokens, outcome.prompt_tokens);
    let prompt_ms = outcome.prompt_ms.or(outcome.first_token_ms);
    let gen_ms = outcome.gen_ms.or_else(|| outcome.first_token_ms.map(|first| outcome.total_ms.saturating_sub(first)));
    let gpu_share = local_llm::ollama_residency(probe.endpoint)
        .await
        .into_iter()
        .find(|(name, _, _)| name == probe.model)
        .filter(|(_, size, _)| *size > 0)
        .map(|(_, size, vram)| (vram as f64 / size as f64).clamp(0.0, 1.0));
    Ok(SpeedSample {
        sent_tokens,
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        prompt_tps: rate(outcome.prompt_tokens.or(Some(sent_tokens)), prompt_ms),
        gen_tps: rate(outcome.completion_tokens, gen_ms),
        first_token_ms: outcome.first_token_ms,
        total_ms: outcome.total_ms,
        gpu_share,
        truncated,
    })
}

fn rate(tokens: Option<u64>, ms: Option<u64>) -> Option<f64> {
    match (tokens, ms) {
        (Some(tokens), Some(ms)) if ms > 0 && tokens > 0 => Some(tokens as f64 * 1000.0 / ms as f64),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_grows_to_its_target_and_ends_with_the_task() {
        let short = probe_prompt(500);
        let long = probe_prompt(4_000);
        assert!(budget::estimate_tokens(&long) > budget::estimate_tokens(&short) * 4);
        assert!(long.ends_with("nothing else."));
    }

    #[test]
    fn rates_need_both_numbers() {
        assert_eq!(rate(Some(200), Some(1000)), Some(200.0));
        assert_eq!(rate(Some(200), Some(0)), None);
        assert_eq!(rate(None, Some(10)), None);
    }
}
