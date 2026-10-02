//! How much one task may carry, and whether a model fits the machine — any machine.
//!
//! Nothing in this file knows what it was written on. A 16 GB laptop, a 64 GB workstation and a PC
//! with a 24 GB GPU get different numbers from the same three inputs: the model's size and
//! architecture (from its own metadata), the context the user picked, and the memory the machine
//! reports. The numbers then drive two things: the warning in the settings pane, and the budget the
//! planner is told to cut tasks to.

use std::sync::OnceLock;

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

/// What kind of memory a model's weights will live in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GpuKind {
    /// Apple Silicon: one pool shared by CPU and GPU, of which macOS lets the GPU wire a share.
    Unified,
    /// A graphics card with its own memory (detected through `nvidia-smi`).
    Discrete,
    /// Neither could be established. The estimate falls back to RAM, and **Probar** — which asks
    /// the server how much it actually placed on the GPU — is the real answer.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Machine {
    pub ram_bytes: u64,
    pub gpu: GpuKind,
    /// What the GPU can hold: the card's memory, or macOS's GPU share of unified memory.
    pub gpu_bytes: Option<u64>,
    pub gpu_name: Option<String>,
}

const GIB: u64 = 1 << 30;

/// This machine's memory, read once — it does not change while the app runs.
pub fn machine() -> Machine {
    static CACHE: OnceLock<Machine> = OnceLock::new();
    CACHE.get_or_init(read_machine).clone()
}

fn read_machine() -> Machine {
    let ram_bytes = {
        let mut system = sysinfo::System::new();
        system.refresh_memory();
        system.total_memory()
    };
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Machine {
            ram_bytes,
            gpu: GpuKind::Unified,
            gpu_bytes: Some(unified_gpu_share(ram_bytes)),
            gpu_name: Some("Apple Silicon".to_string()),
        };
    }
    if let Some((name, bytes)) = nvidia_gpu() {
        return Machine { ram_bytes, gpu: GpuKind::Discrete, gpu_bytes: Some(bytes), gpu_name: Some(name) };
    }
    Machine { ram_bytes, gpu: GpuKind::Unknown, gpu_bytes: None, gpu_name: None }
}

/// The part of unified memory macOS lets the GPU wire by default: about two thirds up to 36 GB,
/// about three quarters above. Approximate on purpose — the exact limit is a Metal property this
/// app does not read — and **Probar** reports what the server actually placed.
pub fn unified_gpu_share(ram_bytes: u64) -> u64 {
    if ram_bytes <= 36 * GIB {
        ram_bytes / 3 * 2
    } else {
        ram_bytes / 4 * 3
    }
}

/// The first NVIDIA card's name and memory, from `nvidia-smi`, when there is one.
fn nvidia_gpu() -> Option<(String, u64)> {
    let output = crate::proc::std_command("nvidia-smi")
        .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_nvidia_smi(&String::from_utf8_lossy(&output.stdout))
}

/// `NVIDIA GeForce RTX 4090, 24564` (MiB) → the name and bytes of the first card.
pub fn parse_nvidia_smi(stdout: &str) -> Option<(String, u64)> {
    let line = stdout.lines().find(|line| !line.trim().is_empty())?;
    let (name, mib) = line.rsplit_once(',')?;
    let mib: u64 = mib.trim().parse().ok()?;
    Some((name.trim().to_string(), mib * 1024 * 1024))
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

    fn mac(gib: u64) -> Machine {
        let ram = gib * GIB;
        Machine { ram_bytes: ram, gpu: GpuKind::Unified, gpu_bytes: Some(unified_gpu_share(ram)), gpu_name: None }
    }

    fn pc_with_card(ram_gib: u64, vram_gib: u64) -> Machine {
        Machine { ram_bytes: ram_gib * GIB, gpu: GpuKind::Discrete, gpu_bytes: Some(vram_gib * GIB), gpu_name: None }
    }

    const Q7: u64 = 4_683_073_536;
    const Q14: u64 = 8_988_110_272;
    const Q32: u64 = 19_851_335_872;

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
    fn nvidia_smi_output_parses() {
        assert_eq!(
            parse_nvidia_smi("NVIDIA GeForce RTX 4090, 24564\n"),
            Some(("NVIDIA GeForce RTX 4090".to_string(), 24_564 * 1024 * 1024))
        );
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("garbage"), None);
    }

    #[test]
    fn ctx_options_stop_at_the_model_ceiling() {
        assert_eq!(ctx_options(Some(32_768)), vec![8_192, 16_384, 32_768]);
        assert_eq!(ctx_options(Some(4_096)), vec![4_096]);
        assert_eq!(ctx_options(None), vec![8_192, 16_384, 32_768]);
    }
}
