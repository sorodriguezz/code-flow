//! The Learning Engine: fine-tuning local models on what CodeFlow has seen work — the user's
//! decision (2026-10-19) to have it now, not later.
//!
//! The pipeline, each step its own module:
//!
//! 1. **Datasets** ([`datasets`]) from approved experiences of workspaces that allow training: the
//!    turns the user kept, redacted, split train/valid/test by group so a near-duplicate never sits on
//!    both sides, with a manifest that names every source.
//! 2. **An environment of its own** ([`env`]): a Python venv under `state_dir()/training/venv`,
//!    created only when the user asks — `mlx-lm` on Apple Silicon, PEFT on an NVIDIA card.
//! 3. **Training** ([`trainer`]): LoRA on a supported base, in the background, with its progress, a
//!    log, cancellation and resumption from the last saved adapter.
//! 4. **Evaluation and publication** ([`evaluation`]): the candidate and its base are measured with
//!    the same bench (`crate::evals`); an adapter that loses a task the base passed, or tool calling,
//!    is not published. Publishing keeps the previous one for rollback.
//! 5. **Serving** ([`serving`]): a published adapter is a model of the «CodeFlow» provider,
//!    `adapter:<id>`, served on this machine — an MLX one by `mlx_lm server`, a PEFT one converted
//!    to a GGUF LoRA ([`gguf_lora`]) and applied by the bundled `llama-server --lora`.
//!
//! Nothing here runs on its own unless the mode says so ([`Mode`]); the default is manual.

pub mod datasets;
pub mod env;
pub mod evaluation;
pub mod gguf_lora;
pub mod serving;
pub mod trainer;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const KEY_MODE: &str = "learning_mode";

/// When training happens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Datasets and training runs only when the user starts them.
    #[default]
    Manual,
    /// Datasets are prepared on their own; training waits for the user's go.
    Assisted,
    /// Candidates are trained when there is data and a resource window; still only published after
    /// passing the evaluation gate.
    Supervised,
}

impl Mode {
    pub fn from_setting(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("assisted") => Mode::Assisted,
            Some("supervised") => Mode::Supervised,
            _ => Mode::Manual,
        }
    }
}

/// Where training keeps its files: datasets, runs, adapters, the venv.
pub fn root() -> PathBuf {
    crate::paths::state_dir().join("training")
}

/// How a base model is trained here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Worker {
    /// `mlx-lm` on Apple Silicon.
    Mlx,
    /// PEFT on an NVIDIA card.
    Cuda,
}

/// A model that can be fine-tuned, and where its trainable weights come from.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Base {
    pub id: &'static str,
    pub label: &'static str,
    pub family: &'static str,
    /// MLX weights (or HF weights `mlx-lm` converts on load).
    pub mlx_repo: &'static str,
    /// Hugging Face weights for PEFT.
    pub hf_repo: &'static str,
    /// Proven to train and serve with this app's pipeline. A hybrid Mamba model (Nemotron) is not
    /// assumed to: it must pass a validation run first ([`env::validated`]).
    pub proven: bool,
    pub licence: &'static str,
    /// What the first training run downloads (the MLX weights), roughly.
    pub approx_gb: f32,
    /// The least memory LoRA on it fits in, measured or estimated from the weights plus activations.
    pub min_ram_gb: u32,
    /// The card memory BF16 LoRA with PEFT needs (no 4-bit path on CUDA yet).
    pub cuda_vram_gb: u32,
    /// The Local model catalogue row (`localai::exec_catalogue`) holding this base as GGUF: what a
    /// PEFT adapter is applied to by `llama-server --lora`. `None`: its PEFT adapters can't be served.
    pub gguf: Option<&'static str>,
    /// A mixture of experts: PEFT leaves the routed experts alone (`--exclude-experts`), because a
    /// LoRA on each expert has no single GGUF tensor to land on.
    pub moe: bool,
}

pub const BASES: &[Base] = &[
    Base {
        id: "qwen2.5-0.5b-instruct",
        label: "Qwen2.5 0.5B Instruct",
        family: "qwen",
        mlx_repo: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
        hf_repo: "Qwen/Qwen2.5-0.5B-Instruct",
        proven: true,
        licence: "Apache-2.0",
        approx_gb: 0.3,
        min_ram_gb: 8,
        cuda_vram_gb: 3,
        gguf: None,
        moe: false,
    },
    Base {
        id: "qwen3-4b-instruct-2507",
        label: "Qwen3 4B Instruct",
        family: "qwen",
        mlx_repo: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
        hf_repo: "Qwen/Qwen3-4B-Instruct-2507",
        proven: true,
        licence: "Apache-2.0",
        approx_gb: 2.3,
        min_ram_gb: 16,
        cuda_vram_gb: 12,
        gguf: Some("qwen3-4b-instruct-2507"),
        moe: false,
    },
    Base {
        id: "qwen2.5-coder-7b-instruct",
        label: "Qwen2.5-Coder 7B Instruct",
        family: "qwen",
        mlx_repo: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
        hf_repo: "Qwen/Qwen2.5-Coder-7B-Instruct",
        proven: true,
        licence: "Apache-2.0",
        approx_gb: 4.3,
        min_ram_gb: 16,
        cuda_vram_gb: 20,
        gguf: Some("qwen2.5-coder-7b-instruct"),
        moe: false,
    },
    Base {
        id: "nemotron-3-nano-4b",
        label: "Nemotron 3 Nano 4B",
        family: "nemotron",
        mlx_repo: "nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16",
        hf_repo: "nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16",
        proven: false,
        licence: "NVIDIA-Nemotron-Open-Model-License",
        approx_gb: 7.9,
        min_ram_gb: 16,
        cuda_vram_gb: 12,
        gguf: Some("nemotron-3-nano-4b"),
        moe: false,
    },
    Base {
        id: "nemotron-3-nano-30b-a3b",
        label: "Nemotron 3 Nano 30B-A3B",
        family: "nemotron",
        mlx_repo: "mlx-community/NVIDIA-Nemotron-3-Nano-30B-A3B-4bit",
        hf_repo: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
        proven: false,
        licence: "NVIDIA-Open-Model-License",
        approx_gb: 17.8,
        min_ram_gb: 32,
        cuda_vram_gb: 70,
        gguf: Some("nemotron-3-nano-30b-a3b"),
        moe: true,
    },
];

pub fn base(id: &str) -> Option<&'static Base> {
    BASES.iter().find(|b| b.id == id)
}

/// Whether LoRA on `base` fits this machine with `worker`.
pub fn fits(base: &Base, worker: Worker, machine: &crate::hybrid::hardware::Machine) -> bool {
    const GIB: u64 = 1 << 30;
    match worker {
        // Unified memory: the whole of it, less a little the OS always keeps.
        Worker::Mlx => machine.ram_bytes + GIB / 2 >= u64::from(base.min_ram_gb) * GIB,
        Worker::Cuda => machine.gpu_bytes.unwrap_or(0) + GIB / 2 >= u64::from(base.cuda_vram_gb) * GIB,
    }
}

/// The worker this machine can run, if any.
pub fn worker_here(machine: &crate::hybrid::hardware::Machine) -> Option<Worker> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Some(Worker::Mlx);
    }
    let nvidia = machine.gpu == crate::hybrid::hardware::GpuKind::Discrete
        && machine.gpu_name.as_deref().is_some_and(|name| name.to_ascii_lowercase().contains("nvidia"));
    nvidia.then_some(Worker::Cuda)
}

/// What the Learning pane shows of training: an event per step on `ai:learning`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningEvent {
    /// `env` | `train` | `eval`.
    pub kind: &'static str,
    pub id: String,
    /// `running` | `done` | `failed` | `cancelled`.
    pub state: &'static str,
    pub line: Option<String>,
    pub progress: Option<serde_json::Value>,
}

pub fn emit(app: &tauri::AppHandle, event: LearningEvent) {
    use tauri::Emitter;
    let _ = app.emit("ai:learning", event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bases_are_unique_and_nemotron_is_not_assumed_to_train() {
        let mut ids: Vec<&str> = BASES.iter().map(|b| b.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), BASES.len());
        assert!(BASES.iter().filter(|b| b.family == "nemotron").all(|b| !b.proven));
        assert!(base("qwen2.5-0.5b-instruct").is_some_and(|b| b.proven));
        for b in BASES {
            if let Some(gguf) = b.gguf {
                assert!(crate::localai::exec_catalogue::find(gguf).is_some(), "{} points at a missing GGUF row", b.id);
            }
        }
    }

    #[test]
    fn the_mode_defaults_to_manual() {
        assert_eq!(Mode::from_setting(None), Mode::Manual);
        assert_eq!(Mode::from_setting(Some("supervised")), Mode::Supervised);
        assert_eq!(Mode::from_setting(Some("x")), Mode::Manual);
    }
}

/// The whole pipeline against the real trainer — ignored by default, and it downloads the base the
/// first time (Qwen2.5 0.5B Instruct, 4-bit MLX, ~0.3 GB, into `training/hf`).
///
/// `CODEFLOW_LEARNING_LIVE=1 cargo test --lib learning::live -- --ignored --nocapture`
///
/// Trains a LoRA adapter on a dozen examples, serves it, asks it one question through the server,
/// and runs the gate's comparison on the tools and text suites (the agent suite is too much for a
/// 0.5B model to say anything with).
#[cfg(test)]
mod live {
    use super::*;
    use crate::hybrid::config::{OnFail, ReviewMode, Settings};

    fn examples() -> String {
        let pairs = [
            ("What does `git stash` do?", "It shelves your uncommitted changes so the working tree is clean; `git stash pop` brings them back."),
            ("How do I undo the last commit but keep the changes?", "Run `git reset --soft HEAD~1`: the commit is gone, its changes stay staged."),
            ("Rename a branch locally", "Use `git branch -m old-name new-name` (or `git branch -m new-name` for the current one)."),
            ("Show the files changed in the last commit", "Run `git show --stat HEAD`."),
            ("Delete a remote branch", "Run `git push origin --delete branch-name`."),
            ("See who changed a line", "Run `git blame path/to/file` and look up the line."),
            ("Discard changes to one file", "Run `git restore path/to/file`."),
            ("List branches by last commit", "Run `git branch --sort=-committerdate`."),
            ("Squash the last three commits", "Run `git reset --soft HEAD~3` and commit again with one message."),
            ("Find the commit that introduced a bug", "Use `git bisect start`, mark `git bisect bad` and `git bisect good <commit>`, and test each step."),
            ("Change the last commit message", "Run `git commit --amend -m \"new message\"` before pushing."),
            ("Pull without a merge commit", "Run `git pull --rebase`."),
        ];
        pairs
            .iter()
            .map(|(q, a)| {
                serde_json::json!({ "messages": [
                    { "role": "system", "content": "You are CodeFlow's coding assistant." },
                    { "role": "user", "content": q },
                    { "role": "assistant", "content": a },
                ]})
                .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Kills the adapter server however the test ends: a panic skips the `serving::stop` at the end,
    /// and a test process never drops the slot's static, so the server outlived every failed run.
    struct StopServing;

    impl Drop for StopServing {
        fn drop(&mut self) {
            serving::shutdown();
        }
    }

    fn bare_settings() -> Settings {
        Settings {
            backend: None,
            url_ollama: None,
            url_openai: None,
            model_bundled: None,
            model_ollama: None,
            model_openai: None,
            ctx: Some(8_192),
            delegate: None,
            on_fail: OnFail::Review,
            unload: false,
            review_mode: ReviewMode::Local,
        }
    }

    /// Serves `target`, asks one question greedily (after `system`, when given), and returns the answer.
    async fn ask_with(target: &serving::Target, system: Option<&str>, question: &str) -> String {
        let (served, _lease) = serving::ensure(target, None).await.expect("served");
        let mut messages = Vec::new();
        if let Some(system) = system {
            messages.push(serde_json::json!({ "role": "system", "content": system }));
        }
        messages.push(serde_json::json!({ "role": "user", "content": question }));
        let answer: serde_json::Value = reqwest::Client::new()
            .post(format!("{}/v1/chat/completions", served.url))
            .json(&serde_json::json!({
                "model": served.model,
                "messages": messages,
                "max_tokens": 48,
                "temperature": 0,
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        answer["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string()
    }

    async fn ask(target: &serving::Target, question: &str) -> String {
        ask_with(target, None, question).await
    }

    /// Writes an MLX adapter again the way PEFT lays one out (`lora_A` `[r, in]`, `lora_B` `[out, r]`,
    /// `lora_alpha = scale · r`), so both readers can be held to the same output.
    fn write_as_peft(mlx: &std::path::Path, out: &std::path::Path) {
        std::fs::create_dir_all(out).unwrap();
        let adapter = gguf_lora::read_adapter(mlx).unwrap();
        let mut tensors = std::collections::BTreeMap::new();
        for pair in &adapter.pairs {
            tensors.insert(format!("base_model.model.{}.lora_A.weight", pair.module), pair.a.clone());
            tensors.insert(format!("base_model.model.{}.lora_B.weight", pair.module), pair.b.clone());
        }
        gguf_lora::write_safetensors(&out.join("adapter_model.safetensors"), &tensors).unwrap();
        let config = serde_json::json!({ "r": adapter.rank, "lora_alpha": adapter.alpha, "use_rslora": false });
        std::fs::write(out.join("adapter_config.json"), config.to_string()).unwrap();
    }

    /// Synthesised PEFT adapters over the GGUFs the Local model pane has downloaded: every adaptable
    /// tensor of a few layers, read off the base's own header and named back the Hugging Face way.
    /// A zero `B` must leave the greedy answer untouched; a random one must change it — so
    /// `llama-server` found every tensor, accepted every shape, and applied the deltas.
    ///
    /// `CODEFLOW_LEARNING_LIVE=1 cargo test --lib learning::live::synthetic -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn synthetic_peft_adapters_load_into_llama_server() {
        if std::env::var("CODEFLOW_LEARNING_LIVE").is_err() {
            return;
        }
        let _stop = StopServing;
        let modules: &[(&str, &str)] = &[
            ("attn_q", "q_proj"),
            ("attn_k", "k_proj"),
            ("attn_v", "v_proj"),
            ("attn_output", "o_proj"),
            ("ffn_gate", "gate_proj"),
            ("ffn_up", "up_proj"),
            ("ffn_down", "down_proj"),
            ("ssm_in", "in_proj"),
            ("ssm_out", "out_proj"),
        ];
        for base in BASES.iter().filter(|b| b.gguf.is_some()) {
            let Ok(model) = serving::base_gguf(base) else {
                eprintln!("{}: GGUF not downloaded, skipped", base.id);
                continue;
            };
            let header = gguf_lora::read_header(&model).unwrap();
            let arch = header.arch.clone().unwrap();
            let nemotron = arch == "nemotron_h";
            let mut layers: Vec<usize> = header
                .tensors
                .keys()
                .filter_map(|name| name.strip_prefix("blk.")?.split('.').next()?.parse().ok())
                .collect();
            layers.sort_unstable();
            layers.dedup();
            let picked: Vec<usize> = layers.iter().copied().filter(|l| l % 7 == 0).collect();
            let rank = 4;
            let build = |zero_b: bool, dir: &std::path::Path| {
                std::fs::create_dir_all(dir).unwrap();
                let mut tensors = std::collections::BTreeMap::new();
                let mut seed = 1u32;
                let mut noise = |n: usize| -> Vec<f32> {
                    (0..n)
                        .map(|_| {
                            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                            ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.2
                        })
                        .collect()
                };
                for &layer in &picked {
                    for (gguf, hf) in modules {
                        let Some(dims) = header.tensors.get(&format!("blk.{layer}.{gguf}.weight")) else { continue };
                        let (input, output) = (dims[0] as usize, dims[1] as usize);
                        let module = if nemotron {
                            format!("backbone.layers.{layer}.mixer.{hf}")
                        } else if gguf.starts_with("attn") {
                            format!("model.layers.{layer}.self_attn.{hf}")
                        } else {
                            format!("model.layers.{layer}.mlp.{hf}")
                        };
                        let b = if zero_b { vec![0.0; output * rank] } else { noise(output * rank) };
                        tensors.insert(format!("base_model.model.{module}.lora_A.weight"), gguf_lora::Tensor { shape: vec![rank, input], data: noise(rank * input) });
                        tensors.insert(format!("base_model.model.{module}.lora_B.weight"), gguf_lora::Tensor { shape: vec![output, rank], data: b });
                    }
                }
                gguf_lora::write_safetensors(&dir.join("adapter_model.safetensors"), &tensors).unwrap();
                std::fs::write(dir.join("adapter_config.json"), serde_json::json!({ "r": rank, "lora_alpha": 64 }).to_string()).unwrap();
                gguf_lora::convert(dir, &model, &dir.join("adapter.gguf")).unwrap()
            };
            let work = std::env::temp_dir().join(format!("codeflow-synthetic-{}-{}", base.id, std::process::id()));
            let zero = build(true, &work.join("zero"));
            build(false, &work.join("noise"));
            eprintln!("{} ({arch}): {} adapted tensors in layers {picked:?}", base.id, zero.layers);
            let target = |lora: Option<std::path::PathBuf>| serving::Target::Llama { model: model.clone(), lora, alias: base.id.into(), ctx: 4_096 };
            let question = "Name three prime numbers.";
            let plain = ask(&target(None), question).await;
            let unchanged = ask(&target(Some(work.join("zero").join("adapter.gguf"))), question).await;
            let changed = ask(&target(Some(work.join("noise").join("adapter.gguf"))), question).await;
            eprintln!("  base:  {plain:?}\n  zero:  {unchanged:?}\n  noise: {changed:?}");
            assert_eq!(plain, unchanged, "{}: a zero LoRA must not change the answer", base.id);
            assert_ne!(plain, changed, "{}: a random LoRA must change the answer", base.id);
            // The gate's own path once: the bench reaching llama-server as an OpenAI server (alias in
            // the listing, tools through its chat template), base and zero LoRA scoring alike.
            if base.id == "qwen3-4b-instruct-2507" {
                let settings = Settings { ctx: Some(8_192), ..bare_settings() };
                let options = crate::evals::Options { runs: 1, suites: vec![crate::evals::corpus::Suite::Tools], ..crate::evals::Options::default() };
                let say = |p: crate::evals::Progress| eprintln!("  [{}/{}] {}", p.done + 1, p.total, p.step);
                let before = evaluation::measure(&settings, &target(None), None, &options, say, None).await.expect("base measured");
                let after = evaluation::measure(&settings, &target(Some(work.join("zero").join("adapter.gguf"))), Some("zero"), &options, say, None).await.expect("zero measured");
                let tools = |r: &crate::evals::report::Report| r.conformance.as_ref().map(|c| c.passed);
                eprintln!("  tools: base {:?} · zero LoRA {:?}", tools(&before), tools(&after));
                assert!(before.aborted.is_none() && tools(&before).is_some_and(|n| n >= 5), "{}", before.summary());
                assert!(evaluation::gate(&before, &after).is_empty(), "{:?}", evaluation::gate(&before, &after));
            }
            let _ = std::fs::remove_dir_all(work);
        }
        serving::stop(true).await;
    }

    #[tokio::test]
    #[ignore]
    async fn train_serve_and_measure() {
        if std::env::var("CODEFLOW_LEARNING_LIVE").is_err() {
            return;
        }
        let _stop = StopServing;
        eprintln!("training root: {}", root().display());
        let base = base("qwen2.5-0.5b-instruct").unwrap();
        let work = std::env::temp_dir().join(format!("codeflow-learning-live-{}", std::process::id()));
        let data = work.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let all = examples();
        let lines: Vec<&str> = all.lines().collect();
        std::fs::write(data.join("train.jsonl"), lines[..8].join("\n")).unwrap();
        std::fs::write(data.join("valid.jsonl"), lines[8..10].join("\n")).unwrap();
        std::fs::write(data.join("test.jsonl"), lines[10..].join("\n")).unwrap();
        let out = work.join("adapter");
        let spec = trainer::Spec {
            worker: Worker::Mlx,
            base,
            dataset_dir: data.clone(),
            out_dir: out.clone(),
            params: trainer::Params {
                iters: std::env::var("CODEFLOW_LEARNING_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(60),
                batch_size: 2,
                num_layers: 8,
                learning_rate: std::env::var("CODEFLOW_LEARNING_LR").ok().and_then(|v| v.parse().ok()).unwrap_or(3e-5),
                max_seq_length: 1024,
            },
            resume_from: None,
        };
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let started = std::time::Instant::now();
        let (ended, progress) = trainer::train_process(&spec, rx, |line, _, moved| {
            if moved || line.contains("rror") {
                eprintln!("  {line}");
            }
        })
        .await;
        eprintln!("trained in {:.0} s: {ended:?} {progress:?}", started.elapsed().as_secs_f64());
        assert_eq!(ended, trainer::Ended::Done);
        assert!(progress.val_loss.unwrap() < progress.first_val_loss.unwrap(), "the validation loss should fall");

        let mlx = serving::Target::Mlx { repo: base.mlx_repo.into(), adapter: Some(out.clone()) };
        let mlx_answer = ask(&mlx, "How do I rename a branch locally?").await;
        eprintln!("mlx + adapter: {mlx_answer:?}");
        assert!(!mlx_answer.trim().is_empty());

        // The same adapter through llama.cpp: converted to a GGUF LoRA over the reference GGUF of the
        // same base, and — written again as PEFT would write it — converted to the very same bytes.
        let reference = root().join("reference").join("qwen2.5-0.5b-instruct-q8_0.gguf");
        if reference.is_file() {
            let converted = gguf_lora::convert(&out, &reference, &out.join("adapter.gguf")).expect("converted");
            eprintln!("converted: {converted:?}");
            let peft = work.join("peft");
            write_as_peft(&out, &peft);
            gguf_lora::convert(&peft, &reference, &peft.join("adapter.gguf")).expect("peft converted");
            assert_eq!(std::fs::read(out.join("adapter.gguf")).unwrap(), std::fs::read(peft.join("adapter.gguf")).unwrap(), "PEFT and MLX shapes convert alike");
            // What it memorised: training questions, asked the way training asked them. The MLX base is
            // 4-bit and this GGUF is Q8, so free answers drift apart; memorised ones must not. Measured
            // 2026-10-20: 4/4 at 60 steps × 3e-5 (and 150 × 1e-5); an adapter driven to overfit
            // (30 × 1e-4) kept 2/4 and looped on the rest — it had learned the 4-bit weights' quirks,
            // not just the answers. The conversion is the same either way.
            let llama = |lora: Option<std::path::PathBuf>| serving::Target::Llama { model: reference.clone(), lora, alias: base.id.into(), ctx: 4_096 };
            let system = Some("You are CodeFlow's coding assistant.");
            let learned = [
                ("Show the files changed in the last commit", "git show --stat HEAD"),
                ("Delete a remote branch", "git push origin --delete"),
                ("Discard changes to one file", "git restore"),
                ("List branches by last commit", "git branch --sort=-committerdate"),
            ];
            let (mut by_mlx, mut by_lora, mut by_base) = (0, 0, 0);
            for (question, command) in learned {
                let from_mlx = ask_with(&mlx, system, question).await;
                let from_base = ask_with(&llama(None), system, question).await;
                let from_lora = ask_with(&llama(Some(peft.join("adapter.gguf"))), system, question).await;
                eprintln!("{question}\n  mlx + adapter: {from_mlx:?}\n  llama base:    {from_base:?}\n  llama + lora:  {from_lora:?}");
                by_mlx += usize::from(from_mlx.contains(command));
                by_lora += usize::from(from_lora.contains(command));
                by_base += usize::from(from_base.starts_with("Run `") && from_base.contains(command));
            }
            eprintln!("memorised answers — mlx {by_mlx}/4, llama + lora {by_lora}/4, llama base (verbatim) {by_base}/4");
            assert!(by_lora >= 3 && by_lora + 1 >= by_mlx, "the converted LoRA should reproduce what the adapter learned");
        } else {
            eprintln!("(no reference GGUF at {} — llama.cpp leg skipped)", reference.display());
        }

        let settings = bare_settings();
        let options = |adapter: Option<&str>| crate::evals::Options {
            runs: 1,
            suites: vec![crate::evals::corpus::Suite::Tools, crate::evals::corpus::Suite::Text],
            adapter: adapter.map(str::to_string),
            ..crate::evals::Options::default()
        };
        let say = |p: crate::evals::Progress| eprintln!("  [{}/{}] {}", p.done + 1, p.total, p.step);
        let bare = serving::Target::Mlx { repo: base.mlx_repo.into(), adapter: None };
        let before = evaluation::measure(&settings, &bare, None, &options(None), say, None).await.expect("base measured");
        let after = evaluation::measure(&settings, &mlx, Some("live"), &options(Some("live")), say, None).await.expect("candidate measured");
        serving::stop(true).await;
        eprintln!("\nbase:\n{}\ncandidate:\n{}", before.summary(), after.summary());
        eprintln!("gate: {:?}", evaluation::gate(&before, &after));
        let _ = std::fs::remove_dir_all(work);
    }
}
