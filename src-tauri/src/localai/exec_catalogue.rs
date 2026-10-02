//! The instruct models the hybrid task's executor can download and run on the bundled engine.
//!
//! A second catalogue rather than more rows in [`super::catalogue`], because the two answer
//! opposite questions and each one's first rule rules out the other's models:
//!
//! 1. **Instruct weights, never base.** The executor is *asked* to do something — rewrite this
//!    region so that it does X — and answers with one fenced block. A base model fed that request
//!    continues the text instead of answering it. Inline completion wants exactly the reverse,
//!    which is why its catalogue refuses `-Instruct`.
//!
//! 2. **A licence this app can point at**, the same rule as the completion catalogue and enforced
//!    by the same kind of test. Qwen2.5-Coder-3B is `qwen-research` (non-commercial) and is absent
//!    for that reason; the 7B/14B/32B and Qwen3-Coder-30B-A3B are Apache-2.0.
//!
//! 3. **One file per model.** The official Qwen repositories publish several quantisations split
//!    into `-0000N-of-0000M` parts *and* a joined copy of the same weights. The joined file is the
//!    one listed here: the download pipeline fetches, resumes and verifies exactly one file, and a
//!    split GGUF would need all of its parts present before llama.cpp can open any of them.
//!
//! `size_bytes` and `sha256` were read from `https://huggingface.co/api/models/{repo}/tree/main`
//! (`lfs.size` / `lfs.oid`) on 2026-10-01, and the architecture numbers behind
//! [`ExecModelSpec::kv_bytes_per_token`] from each model's own `config.json` — none of it was copied
//! from a model card.

use super::catalogue::{ModelSpec, Tier};

/// One downloadable executor model.
#[derive(Clone, Copy, Debug)]
pub struct ExecModelSpec {
    /// The fields the download pipeline and the on-disk bookkeeping already understand — see
    /// [`super::download::fetch`] and [`super::models`], which take a [`ModelSpec`] and neither
    /// knows nor cares which catalogue it came from.
    pub spec: ModelSpec,
    /// The context the model was trained for. The ceiling the settings pane offers: asking
    /// llama-server for more than this runs, and degrades quietly past the trained length.
    pub max_ctx: u32,
    /// KV-cache bytes per token of context at f16: `2 · layers · kv_heads · head_dim · 2`.
    ///
    /// What turns "16k of context" into gigabytes before anything is loaded, which is the only
    /// honest way to tell someone on a 16 GB laptop and someone with a 24 GB GPU what fits.
    pub kv_bytes_per_token: u64,
    /// Total parameters in billions. Read by the delegation suggestion, which hands the local model
    /// harder work the bigger it is.
    pub params_b: f32,
}

/// Everything on offer, smallest first — the first row a hesitant user reads is the one that
/// certainly runs on their machine.
pub const EXEC_CATALOGUE: &[ExecModelSpec] = &[
    ExecModelSpec {
        spec: ModelSpec {
            id: "qwen2.5-coder-7b-instruct",
            label: "Qwen2.5-Coder 7B Instruct",
            tier: Tier::Light,
            repo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
            file: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
            size_bytes: 4_683_073_536,
            sha256: "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c",
            params: "7.6B · Q4_K_M",
            min_ram_gb: 8,
            licence: "Apache-2.0",
        },
        max_ctx: 32_768,
        // 28 layers · 4 KV heads · head_dim 128 (3584 / 28).
        kv_bytes_per_token: 2 * 28 * 4 * 128 * 2,
        params_b: 7.6,
    },
    ExecModelSpec {
        spec: ModelSpec {
            id: "qwen2.5-coder-14b-instruct",
            label: "Qwen2.5-Coder 14B Instruct",
            tier: Tier::Balanced,
            repo: "Qwen/Qwen2.5-Coder-14B-Instruct-GGUF",
            file: "qwen2.5-coder-14b-instruct-q4_k_m.gguf",
            size_bytes: 8_988_110_272,
            sha256: "c1e659736d89ac1065fb495330fb824d94001974a4bfa78e7270e43476a8d940",
            params: "14.8B · Q4_K_M",
            min_ram_gb: 16,
            licence: "Apache-2.0",
        },
        max_ctx: 32_768,
        // 48 layers · 8 KV heads · head_dim 128 (5120 / 40).
        kv_bytes_per_token: 2 * 48 * 8 * 128 * 2,
        params_b: 14.8,
    },
    ExecModelSpec {
        spec: ModelSpec {
            id: "qwen3-coder-30b-a3b-instruct",
            label: "Qwen3-Coder 30B-A3B Instruct",
            tier: Tier::Large,
            repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
            file: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
            size_bytes: 18_556_689_568,
            sha256: "fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad",
            // A mixture of experts: all 30.5B have to be resident, but only ~3.3B are read per
            // token, which is why it writes several times faster than the dense 32B below.
            params: "30.5B MoE · Q4_K_M",
            min_ram_gb: 24,
            licence: "Apache-2.0",
        },
        // Trained for 256k. The settings pane caps what it offers well below that — the memory
        // estimate does the talking — but the ceiling is the model's, not ours.
        max_ctx: 262_144,
        // 48 layers · 4 KV heads · head_dim 128.
        kv_bytes_per_token: 2 * 48 * 4 * 128 * 2,
        params_b: 30.5,
    },
    ExecModelSpec {
        spec: ModelSpec {
            id: "qwen2.5-coder-32b-instruct",
            label: "Qwen2.5-Coder 32B Instruct",
            tier: Tier::Large,
            repo: "Qwen/Qwen2.5-Coder-32B-Instruct-GGUF",
            file: "qwen2.5-coder-32b-instruct-q4_k_m.gguf",
            size_bytes: 19_851_335_872,
            sha256: "4d64b316b5e6319d9613e0d97935d9ebd631fc7e334da400d00085eca749d085",
            params: "32.8B · Q4_K_M",
            min_ram_gb: 32,
            licence: "Apache-2.0",
        },
        max_ctx: 32_768,
        // 64 layers · 8 KV heads · head_dim 128.
        kv_bytes_per_token: 2 * 64 * 8 * 128 * 2,
        params_b: 32.8,
    },
];

/// What a user who has chosen nothing is offered: the one model on the list that runs on a 16 GB
/// laptop next to an IDE, a browser and the completion engine.
pub const DEFAULT_EXEC_MODEL_ID: &str = "qwen2.5-coder-7b-instruct";

/// The entry with this id, or `None` for an id from another build's catalogue.
pub fn find(id: &str) -> Option<&'static ExecModelSpec> {
    EXEC_CATALOGUE.iter().find(|entry| entry.spec.id == id)
}

/// The same weights as a catalogue entry, as Ollama's library names them — what the settings pane
/// offers to pull when the server is Ollama, with the entry's memory figures standing for them.
pub struct OllamaTag {
    pub tag: &'static str,
    pub catalogue_id: &'static str,
    /// Every layer of the registry manifest, summed — what the pull downloads. Read from
    /// `registry.ollama.ai/v2/library/<name>/manifests/<tag>` on 2026-10-02.
    pub size_bytes: u64,
}

pub const OLLAMA_TAGS: &[OllamaTag] = &[
    OllamaTag { tag: "qwen2.5-coder:7b", catalogue_id: "qwen2.5-coder-7b-instruct", size_bytes: 4_683_087_074 },
    OllamaTag { tag: "qwen2.5-coder:14b", catalogue_id: "qwen2.5-coder-14b-instruct", size_bytes: 8_988_123_810 },
    OllamaTag { tag: "qwen3-coder:30b", catalogue_id: "qwen3-coder-30b-a3b-instruct", size_bytes: 18_556_700_222 },
    OllamaTag { tag: "qwen2.5-coder:32b", catalogue_id: "qwen2.5-coder-32b-instruct", size_bytes: 19_851_349_410 },
];

#[cfg(test)]
mod tests {
    #[test]
    fn every_ollama_tag_stands_for_a_catalogue_entry_of_its_size() {
        for tag in super::OLLAMA_TAGS {
            let entry = super::find(tag.catalogue_id).unwrap_or_else(|| panic!("{} names no entry", tag.tag));
            // The same weights: within a few MB of the GGUF (the rest is Ollama's template layers).
            let gap = tag.size_bytes.abs_diff(entry.spec.size_bytes);
            assert!(gap < 50_000_000, "{}: {} vs {}", tag.tag, tag.size_bytes, entry.spec.size_bytes);
        }
    }

    use super::*;

    #[test]
    fn ids_and_filenames_are_unique_across_both_catalogues() {
        // Both catalogues download into the same folder, so a shared filename would have one
        // model's download "succeed" against the other's bytes.
        let mut seen_ids = std::collections::HashSet::new();
        let mut seen_files = std::collections::HashSet::new();
        let all = super::super::catalogue::CATALOGUE.iter().chain(EXEC_CATALOGUE.iter().map(|e| &e.spec));
        for spec in all {
            assert!(seen_ids.insert(spec.id), "duplicate id {}", spec.id);
            assert!(seen_files.insert(spec.file), "duplicate filename {}", spec.file);
        }
    }

    #[test]
    fn the_default_is_in_the_catalogue() {
        assert!(find(DEFAULT_EXEC_MODEL_ID).is_some());
    }

    #[test]
    fn every_model_is_offerable() {
        const ALLOWED: &[&str] = &["Apache-2.0", "MIT"];
        for entry in EXEC_CATALOGUE {
            assert!(
                ALLOWED.contains(&entry.spec.licence),
                "{} is licensed {}, which this app cannot offer from a menu",
                entry.spec.id,
                entry.spec.licence,
            );
        }
    }

    #[test]
    fn every_entry_is_an_instruct_model_and_a_single_file() {
        for entry in EXEC_CATALOGUE {
            let file = entry.spec.file.to_ascii_lowercase();
            assert!(file.contains("instruct"), "{} is not an instruct model", entry.spec.file);
            assert!(!file.contains("-of-"), "{} is one part of a split GGUF", entry.spec.file);
            assert!(file.ends_with(".gguf"));
        }
    }

    #[test]
    fn digests_and_architecture_are_filled_in() {
        for entry in EXEC_CATALOGUE {
            let spec = entry.spec;
            assert_eq!(spec.sha256.len(), 64, "{}: not a SHA-256", spec.id);
            assert!(spec.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(spec.size_bytes > 0);
            assert!(entry.max_ctx >= 8_192, "{}: context below what a task needs", spec.id);
            assert!(entry.kv_bytes_per_token > 0);
        }
    }

    #[test]
    fn kv_cache_numbers_match_the_published_architectures() {
        // The 7B's figure is the one measured against Ollama's own `/api/show` on 2026-10-01
        // (28 layers, 4 KV heads, 3584/28): 56 KiB a token.
        assert_eq!(find("qwen2.5-coder-7b-instruct").unwrap().kv_bytes_per_token, 57_344);
        assert_eq!(find("qwen2.5-coder-32b-instruct").unwrap().kv_bytes_per_token, 262_144);
    }
}
