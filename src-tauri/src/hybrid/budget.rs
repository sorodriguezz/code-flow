//! How much one task may carry, whether a model fits the machine, and how fast it will write there
//! — any machine.
//!
//! Nothing in this file knows what it was written on. A 16 GB laptop, a 64 GB workstation and a PC
//! with a 24 GB GPU get different numbers from the same inputs: the model's size and architecture
//! (from its own metadata), the context the user picked, and the machine as [`super::hardware`]
//! reads it — how much memory, where, and how fast it reads. The numbers then drive three things:
//! the warnings in the settings pane, the model it points at, and the budget the planner is told to
//! cut tasks to.

pub use super::hardware::{GpuKind, Machine};

/// Characters per token assumed when a server cannot count for us.
///
/// Deliberately low (code tokenizes at roughly 3–4 characters a token, prose at 4–5): an estimate
/// that runs high makes a prompt look bigger than it is, so the budget errs on the side of fitting.
pub const CHARS_PER_TOKEN: f64 = 3.0;

/// Tokens of `text`, estimated.
pub fn estimate_tokens(text: &str) -> u64 {
    (text.chars().count() as f64 / CHARS_PER_TOKEN).ceil() as u64
}

/// How a context window is split for one task.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Budget {
    pub ctx: u32,
    /// Reserved for the answer. A rewritten region has to fit in it whole.
    pub output: u32,
    /// What the prompt — rules, instruction, target, references — may use.
    pub input: u32,
}

/// Room the chat template and the server's own bookkeeping take, kept out of both halves.
pub const TEMPLATE_SLACK: u32 = 512;

/// A quarter of the window for the answer, never less than 2k (a short file has to fit) and never
/// more than 8k (past that, a task is too big for one local answer and should have been split).
pub fn budget_for(ctx: u32) -> Budget {
    let output = ((ctx as f64 * 0.25).round() as u32).clamp(2_048, 8_192);
    let input = ctx.saturating_sub(output).saturating_sub(TEMPLATE_SLACK);
    Budget { ctx, output, input }
}

/// Whether the server cut the prompt.
///
/// Compares what was sent (estimated, or counted exactly when the server can count) with what the
/// server says it processed. Below half means the prompt was truncated: the measured case is a
/// 6,982-token prompt Ollama processed as 2,050 — a ratio of 0.29 against the exact count, and
/// lower still against the estimate. Prompts under 1k tokens are never judged; the template and
/// the estimate's error are the same order of size there.
pub fn truncated(sent_tokens: u64, reported: Option<u64>) -> bool {
    match reported {
        Some(reported) if sent_tokens >= 1_024 => (reported as f64) < sent_tokens as f64 * 0.5,
        _ => false,
    }
}

/// Which tasks the planner may hand to the local model.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Delegate {
    Easy,
    Medium,
    All,
}

impl Delegate {
    pub fn from_setting(raw: &str) -> Option<Self> {
        match raw.trim() {
            "easy" => Some(Self::Easy),
            "medium" => Some(Self::Medium),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Easy => "easy",
            Self::Medium => "medium",
            Self::All => "all",
        }
    }

    /// Whether a task the planner rated `difficulty` goes to the local model.
    pub fn admits(self, difficulty: &str) -> bool {
        match (self, difficulty) {
            (Self::All, _) => true,
            (Self::Medium, "easy" | "medium") => true,
            (Self::Easy, "easy") => true,
            _ => false,
        }
    }
}

/// The delegation a model of this size is suggested. Bigger models get harder work: a 30B handles
/// what a planner rates "hard" often enough to be worth trying first; a 7B does not.
pub fn suggest_delegate(params_b: Option<f32>) -> Delegate {
    match params_b {
        Some(b) if b >= 30.0 => Delegate::All,
        Some(b) if b < 4.0 => Delegate::Easy,
        _ => Delegate::Medium,
    }
}

/// Memory llama.cpp will want beyond the weights and the cache: compute buffers, the runtime.
pub const WORKING_OVERHEAD: u64 = 512 * 1024 * 1024;

/// Weights + KV cache for `ctx` tokens + working memory.
pub fn memory_need(model_bytes: u64, kv_bytes_per_token: u64, ctx: u32) -> u64 {
    model_bytes + kv_bytes_per_token * ctx as u64 + WORKING_OVERHEAD
}

/// How a model of a given footprint sits on this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fit {
    Comfortable,
    /// Fits, with little to spare — other apps can push it over.
    Tight,
    /// More than the GPU can hold: part of the model runs on the CPU, several times slower.
    SpillsToCpu,
    /// More than the machine has at all.
    DoesNotFit,
    Unknown,
}

/// Where `need` bytes (plus `also_resident`, the completion engine's model when it is loaded) land.
pub fn fit(need: u64, also_resident: u64, machine: &Machine) -> Fit {
    let total = need + also_resident;
    let ceiling = match machine.gpu {
        // A discrete card spills into system RAM; unified memory has nowhere else to go.
        GpuKind::Discrete => machine.ram_bytes + machine.gpu_bytes.unwrap_or(0),
        _ => machine.ram_bytes,
    };
    if machine.ram_bytes == 0 {
        return Fit::Unknown;
    }
    if total > ceiling {
        return Fit::DoesNotFit;
    }
    match machine.gpu_bytes {
        Some(gpu) if total > gpu => Fit::SpillsToCpu,
        Some(gpu) if total as f64 > gpu as f64 * 0.85 => Fit::Tight,
        Some(_) => Fit::Comfortable,
        // No GPU figure: judged against RAM, conservatively.
        None if total as f64 > machine.ram_bytes as f64 * 0.75 => Fit::Tight,
        None => Fit::Comfortable,
    }
}

/// The share of the memory's bandwidth that generating a token actually draws: llama.cpp does not
/// reach the bus's peak. Calibrated on the one measurement this repository has — qwen2.5-coder 7B
/// Q4_K_M at a 16k window wrote 21 tokens a second on an M4, whose memory Apple rates at 120 GB/s,
/// which is 0.88 of what the bandwidth allows. Set a little under that, so the estimate errs slow.
pub const BANDWIDTH_EFFICIENCY: f64 = 0.85;

/// What llama.cpp's `--fit` leaves free on each GPU: its `--fit-target` default, 1024 MiB.
pub const GPU_MARGIN: u64 = 1 << 30;

/// Writing speeds, in tokens a second, that someone waiting on a task tells apart. An answer is a
/// rewritten region, a few hundred to a few thousand tokens: at 20 a second that is a minute or
/// two, at 10 it is a coffee, and under 5 the task outlasts the reason it was started.
pub const FAST_TPS: f64 = 20.0;
pub const USABLE_TPS: f64 = 10.0;
pub const SLOW_TPS: f64 = 5.0;

/// A model, as far as its writing speed is concerned.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    /// The weights, as loaded.
    pub bytes: u64,
    pub kv_bytes_per_token: u64,
    /// The share of the weights read for each token: 1 for a dense model; for a mixture of experts,
    /// its active parameters over its total (Qwen3-Coder 30B-A3B reads 3.3B of its 30.5B).
    pub active_share: f64,
}

/// Bytes read to write one token: the weights every token uses, and the KV cache of the tokens
/// before it — taken at half the window, since a task's prompt fills most of it and the answer
/// starts where the prompt ends.
pub fn bytes_per_token(shape: &Shape, ctx: u32) -> f64 {
    shape.bytes as f64 * shape.active_share.clamp(0.01, 1.0) + shape.kv_bytes_per_token as f64 * f64::from(ctx) / 2.0
}

/// The share of a model llama.cpp keeps in GPU memory, placed the way `--fit` places it: all of it
/// when it fits beside the margin and the completion engine's model, the part that fits otherwise.
/// None of it on a machine whose GPU has no memory of its own.
pub fn gpu_share(shape: &Shape, ctx: u32, also_resident: u64, machine: &Machine) -> f64 {
    let Some(gpu_bytes) = machine.gpu_bytes.filter(|_| matches!(machine.gpu, GpuKind::Discrete | GpuKind::Unified)) else {
        return 0.0;
    };
    let resident = shape.bytes + shape.kv_bytes_per_token * u64::from(ctx);
    let room = gpu_bytes.saturating_sub(GPU_MARGIN + WORKING_OVERHEAD + also_resident);
    (room as f64 / resident.max(1) as f64).clamp(0.0, 1.0)
}

/// Tokens a second `shape` writes on `machine` at `ctx`, estimated: the bytes each token reads,
/// split between the memories the model's parts live in, each at its bandwidth.
///
/// `None` when the speed of a memory holding part of it is unknown. An estimate, and shown as one:
/// **Probar** measures.
pub fn write_speed(shape: &Shape, ctx: u32, also_resident: u64, machine: &Machine) -> Option<f64> {
    let on_gpu = gpu_share(shape, ctx, also_resident, machine);
    let per_token = bytes_per_token(shape, ctx);
    let mut seconds = 0.0;
    if on_gpu > 0.0 {
        seconds += per_token * on_gpu / machine.gpu_bandwidth? as f64;
    }
    if on_gpu < 1.0 {
        seconds += per_token * (1.0 - on_gpu) / machine.ram_bandwidth? as f64;
    }
    (seconds > 0.0).then(|| BANDWIDTH_EFFICIENCY / seconds)
}

/// How an estimated writing speed reads to someone waiting on a task.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Pace {
    Fast,
    Usable,
    Slow,
    /// Under [`SLOW_TPS`]: technically running.
    Crawl,
    Unknown,
}

pub fn pace(tps: Option<f64>) -> Pace {
    match tps {
        None => Pace::Unknown,
        Some(tps) if tps >= FAST_TPS => Pace::Fast,
        Some(tps) if tps >= USABLE_TPS => Pace::Usable,
        Some(tps) if tps >= SLOW_TPS => Pace::Slow,
        Some(_) => Pace::Crawl,
    }
}

/// The row to point at as the model for this machine, by index. `rows` come smallest first, as the
/// catalogue lists them, each with its fit and its estimated speed at the same window.
///
/// The largest model that fits with room *and* writes at a usable pace. Fitting alone was the old
/// rule, and it pointed a PC whose model lives in system RAM at a dense 32B — there is room for one
/// in 32 GB, read at two tokens a second — while Qwen3-Coder 30B-A3B, a mixture that reads a tenth
/// of itself per token, writes several times faster there than even the 7B. When nothing that fits
/// with room is usable, the fastest of them; with no speed known at all, the largest, as before.
pub fn recommend(rows: &[(Fit, Option<f64>)]) -> Option<usize> {
    let roomy: Vec<usize> = (0..rows.len()).filter(|&i| rows[i].0 == Fit::Comfortable).collect();
    if let Some(&usable) = roomy.iter().rev().find(|&&i| rows[i].1.is_some_and(|tps| tps >= USABLE_TPS)) {
        return Some(usable);
    }
    roomy
        .iter()
        .filter_map(|&i| rows[i].1.map(|tps| (i, tps)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
        .or_else(|| roomy.last().copied())
}

/// The windows the settings pane offers, up to the model's ceiling.
pub const CTX_STEPS: [u32; 6] = [8_192, 16_384, 32_768, 65_536, 131_072, 262_144];

pub fn ctx_options(max_ctx: Option<u32>) -> Vec<u32> {
    let ceiling = max_ctx.unwrap_or(32_768);
    let mut steps: Vec<u32> = CTX_STEPS.iter().copied().filter(|&step| step <= ceiling).collect();
    if steps.is_empty() {
        steps.push(ceiling.max(2_048));
    }
    steps
}

/// The largest window that sits comfortably, never above 64k.
///
/// The cap is about speed, not memory: prompt evaluation on a local model runs at a few hundred
/// tokens a second, so a task carrying 100k tokens of context would spend minutes reading before it
/// wrote a line — and the planner, told the budget, would happily fill it. When the model's size or
/// architecture is unknown the answer is 16k, the smallest window a useful task fits in comfortably.
pub fn suggest_ctx(
    model_bytes: Option<u64>,
    kv_bytes_per_token: Option<u64>,
    max_ctx: Option<u32>,
    also_resident: u64,
    machine: &Machine,
) -> u32 {
    let options: Vec<u32> = ctx_options(max_ctx).into_iter().filter(|&ctx| ctx <= 65_536).collect();
    let smallest = options.first().copied().unwrap_or(8_192);
    let (Some(model_bytes), Some(kv)) = (model_bytes, kv_bytes_per_token) else {
        return options.iter().copied().filter(|&ctx| ctx <= 16_384).max().unwrap_or(smallest);
    };
    options
        .iter()
        .copied()
        .filter(|&ctx| fit(memory_need(model_bytes, kv, ctx), also_resident, machine) == Fit::Comfortable)
        .max()
        .unwrap_or(smallest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hybrid::hardware::{unified_gpu_share, DISCRETE_GPU_BANDWIDTH};

    const GIB: u64 = 1 << 30;
    const GB: u64 = 1_000_000_000;

    fn mac(gib: u64) -> Machine {
        let ram = gib * GIB;
        Machine {
            ram_bytes: ram,
            ram_bandwidth: Some(112 * GB),
            gpu: GpuKind::Unified,
            gpu_bytes: Some(unified_gpu_share(ram)),
            gpu_name: None,
            gpu_bandwidth: Some(120 * GB),
        }
    }

    fn pc_with_card(ram_gib: u64, vram_gib: u64) -> Machine {
        Machine {
            ram_bytes: ram_gib * GIB,
            ram_bandwidth: Some(50 * GB),
            gpu: GpuKind::Discrete,
            gpu_bytes: Some(vram_gib * GIB),
            gpu_name: None,
            gpu_bandwidth: Some(DISCRETE_GPU_BANDWIDTH),
        }
    }

    /// A PC whose GPU has no memory of its own, its RAM reading at `gbs` GB/s.
    fn pc_without_card(ram_gib: u64, gbs: u64) -> Machine {
        Machine {
            ram_bytes: ram_gib * GIB,
            ram_bandwidth: Some(gbs * GB),
            gpu: GpuKind::Integrated,
            gpu_bytes: None,
            gpu_name: Some("Intel(R) UHD Graphics 770".into()),
            gpu_bandwidth: None,
        }
    }

    const Q7: u64 = 4_683_073_536;
    const Q14: u64 = 8_988_110_272;
    const Q30A3: u64 = 18_556_689_568;
    const Q32: u64 = 19_851_335_872;

    const DENSE_7B: Shape = Shape { bytes: Q7, kv_bytes_per_token: 57_344, active_share: 1.0 };
    const DENSE_14B: Shape = Shape { bytes: Q14, kv_bytes_per_token: 196_608, active_share: 1.0 };
    const MOE_30B: Shape = Shape { bytes: Q30A3, kv_bytes_per_token: 98_304, active_share: 3.3 / 30.5 };
    const DENSE_32B: Shape = Shape { bytes: Q32, kv_bytes_per_token: 262_144, active_share: 1.0 };
    /// The catalogue, smallest first, as `recommend` receives it.
    const CATALOGUE: [Shape; 4] = [DENSE_7B, DENSE_14B, MOE_30B, DENSE_32B];

    fn rows_at_16k(machine: &Machine) -> Vec<(Fit, Option<f64>)> {
        CATALOGUE
            .iter()
            .map(|shape| {
                let need = memory_need(shape.bytes, shape.kv_bytes_per_token, 16_384);
                (fit(need, 0, machine), write_speed(shape, 16_384, 0, machine))
            })
            .collect()
    }

    #[test]
    fn the_budget_reserves_a_quarter_within_bounds() {
        assert_eq!(budget_for(16_384), Budget { ctx: 16_384, output: 4_096, input: 11_776 });
        assert_eq!(budget_for(8_192).output, 2_048);
        assert_eq!(budget_for(65_536).output, 8_192, "an answer never needs more than 8k");
        assert_eq!(budget_for(1_024).input, 0, "never underflows");
    }

    #[test]
    fn truncation_is_caught_and_a_normal_estimate_is_not_flagged() {
        // The measured case: a 28.7k-character file (≈9.6k estimated) processed as 2,050 tokens.
        assert!(truncated(estimate_tokens(&"x".repeat(28_900)), Some(2_050)));
        // Prose tokenizes at ~4.5 chars a token, so the estimate runs ~1.5× high: not truncation.
        assert!(!truncated(9_600, Some(6_400)));
        assert!(!truncated(500, Some(10)), "short prompts are never judged");
        assert!(!truncated(9_600, None), "no count, no verdict");
    }

    #[test]
    fn delegation_follows_the_difficulty_ladder() {
        assert!(Delegate::Medium.admits("easy") && Delegate::Medium.admits("medium"));
        assert!(!Delegate::Medium.admits("hard"));
        assert!(Delegate::All.admits("hard"));
        assert!(!Delegate::Easy.admits("medium"));
        assert_eq!(suggest_delegate(Some(7.6)), Delegate::Medium);
        assert_eq!(suggest_delegate(Some(32.8)), Delegate::All);
        assert_eq!(suggest_delegate(None), Delegate::Medium);
    }

    #[test]
    fn a_16_gb_mac_fits_a_7b_and_not_a_32b() {
        let machine = mac(16);
        assert_eq!(fit(memory_need(Q7, 57_344, 16_384), 0, &machine), Fit::Comfortable);
        assert_eq!(fit(memory_need(Q32, 262_144, 8_192), 0, &machine), Fit::DoesNotFit);
        // The 14B only just fits what macOS lets the GPU use at 8k, and spills past it at 16k.
        assert_eq!(fit(memory_need(Q14, 196_608, 8_192), 0, &machine), Fit::Tight);
        assert_eq!(fit(memory_need(Q14, 196_608, 16_384), 0, &machine), Fit::SpillsToCpu);
    }

    #[test]
    fn a_24_gb_card_holds_a_32b_only_with_a_short_window() {
        let machine = pc_with_card(64, 24);
        assert_eq!(fit(memory_need(Q32, 262_144, 8_192), 0, &machine), Fit::Tight);
        assert_eq!(fit(memory_need(Q32, 262_144, 32_768), 0, &machine), Fit::SpillsToCpu);
        assert_eq!(fit(memory_need(Q14, 196_608, 32_768), 0, &machine), Fit::Comfortable);
    }

    #[test]
    fn the_completion_engine_counts_against_the_same_memory() {
        let machine = mac(16);
        let need = memory_need(Q7, 57_344, 32_768);
        assert_eq!(fit(need, 0, &machine), Fit::Comfortable);
        assert_ne!(fit(need, 8_098_525_600, &machine), Fit::Comfortable, "a 7B completion model next to it");
    }

    #[test]
    fn suggested_windows_scale_with_the_machine() {
        assert_eq!(suggest_ctx(Some(Q7), Some(57_344), Some(32_768), 0, &mac(16)), 32_768);
        assert_eq!(suggest_ctx(Some(Q32), Some(262_144), Some(32_768), 0, &mac(64)), 32_768);
        assert_eq!(suggest_ctx(Some(Q32), Some(262_144), Some(32_768), 0, &pc_with_card(64, 24)), 8_192);
        assert_eq!(suggest_ctx(None, None, Some(32_768), 0, &mac(16)), 16_384, "unknown model → 16k");
        // A 256k-trained model is still offered at most 64k by default.
        assert!(suggest_ctx(Some(18_556_689_568), Some(98_304), Some(262_144), 0, &mac(128)) <= 65_536);
    }

    #[test]
    fn the_estimate_lands_on_the_one_measurement() {
        // qwen2.5-coder 7B Q4_K_M at 16k wrote 21 tokens a second on an M4 16 GB (Ollama 0.35.0),
        // with Metal holding the 12,124 MiB the engine reports.
        let machine = Machine { gpu_bytes: Some(12_124 << 20), ..mac(16) };
        let tps = write_speed(&DENSE_7B, 16_384, 0, &machine).unwrap();
        assert!((18.0..23.0).contains(&tps), "{tps:.1} tok/s");
        assert_eq!(pace(Some(tps)), Pace::Usable);
    }

    #[test]
    fn a_pc_without_a_card_writes_at_the_pace_of_its_ram() {
        // 32 GB of dual-channel DDR4-3200: about 40 GB/s measured.
        let machine = pc_without_card(32, 40);
        let rows = rows_at_16k(&machine);
        let paces: Vec<Pace> = rows.iter().map(|row| pace(row.1)).collect();
        assert_eq!(paces, vec![Pace::Slow, Pace::Crawl, Pace::Usable, Pace::Crawl]);
        // Every one of them fits; fitting is not what decides here.
        assert!(rows.iter().all(|row| row.0 != Fit::DoesNotFit));
        assert_eq!(recommend(&rows), Some(2), "the mixture, which reads a tenth of itself per token");
    }

    #[test]
    fn slow_ram_still_points_at_the_fastest_model_that_fits() {
        // One channel of DDR4-2666: about 18 GB/s. Nothing is usable; the mixture is least bad.
        let rows = rows_at_16k(&pc_without_card(32, 18));
        assert!(rows.iter().all(|row| pace(row.1) != Pace::Usable && pace(row.1) != Pace::Fast));
        assert_eq!(recommend(&rows), Some(2));
        // With 16 GB the mixture does not fit with room, and the 7B is what is left.
        assert_eq!(recommend(&rows_at_16k(&pc_without_card(16, 18))), Some(0));
    }

    #[test]
    fn a_card_that_holds_the_model_writes_fast() {
        let machine = pc_with_card(32, 12);
        let rows = rows_at_16k(&machine);
        assert_eq!(pace(rows[0].1), Pace::Fast, "the 7B lives in VRAM");
        assert!(gpu_share(&MOE_30B, 16_384, 0, &machine) < 1.0, "the 30B spills");
        assert_eq!(recommend(&rows), Some(0));
    }

    #[test]
    fn the_16_gb_mac_is_still_pointed_at_the_7b() {
        assert_eq!(recommend(&rows_at_16k(&mac(16))), Some(0));
    }

    #[test]
    fn without_a_speed_the_largest_model_with_room_is_the_answer() {
        let machine = Machine { ram_bandwidth: None, ..pc_without_card(32, 40) };
        let rows = rows_at_16k(&machine);
        assert!(rows.iter().all(|row| row.1.is_none()));
        let roomy = rows.iter().rposition(|row| row.0 == Fit::Comfortable);
        assert_eq!(recommend(&rows), roomy);
        assert_eq!(recommend(&[]), None);
    }

    #[test]
    fn a_mixture_reads_its_active_share_and_the_cache() {
        let dense = bytes_per_token(&DENSE_32B, 0);
        assert_eq!(dense, Q32 as f64);
        let mixture = bytes_per_token(&MOE_30B, 16_384);
        let expected = Q30A3 as f64 * 3.3 / 30.5 + 98_304.0 * 8_192.0;
        assert!((mixture - expected).abs() < 1.0);
    }

    #[test]
    fn ctx_options_stop_at_the_model_ceiling() {
        assert_eq!(ctx_options(Some(32_768)), vec![8_192, 16_384, 32_768]);
        assert_eq!(ctx_options(Some(4_096)), vec![4_096]);
        assert_eq!(ctx_options(None), vec![8_192, 16_384, 32_768]);
    }
}
