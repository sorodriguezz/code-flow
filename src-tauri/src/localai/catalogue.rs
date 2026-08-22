//! The models CodeFlow offers to download for inline completion, and nothing else.
//!
//! Three rules decided every entry here, and each of them ruled something out:
//!
//! 1. **Base weights, never `-Instruct`.** Ghost text is fill-in-the-middle: the model is handed
//!    the code before the caret and the code after it, and must produce only what belongs between
//!    them. An instruction-tuned model answers a *request* — it opens with "Here's the function:"
//!    and wraps the code in a fence, and both of those land in the middle of the user's file. The
//!    `ggml-org/*` repos below are the base conversions, and they are the same files llama.cpp's
//!    own `--fim-qwen-*` presets pull (`common/arg.cpp`), which is the strongest available
//!    evidence that they are the ones the FIM path is exercised against.
//!
//! 2. **Native FIM tokens in the GGUF.** [`crate::localai::engine`] never writes `<|fim_prefix|>`
//!    and friends; it posts plain prefix and suffix to `/infill` and llama-server assembles the
//!    prompt from the model's own vocabulary. A model whose GGUF lacks those tokens is rejected by
//!    the server with "Infill is not supported by this model", so a wrong entry here fails loudly
//!    at the first keystroke rather than quietly producing prose.
//!
//! 3. **A licence this app can point at.** Which is why there is a hole where the 3B should be:
//!    Qwen2.5-Coder-3B is published under `qwen-research`, not Apache-2.0, alone among its
//!    siblings — 0.5B, 1.5B, 7B and 14B are all Apache-2.0. A non-commercial licence is not
//!    something to hand a user of a commercial desktop app from a menu, so the jump is 1.5B → 7B
//!    even though 3B is exactly the size most laptops would want. If that gap ever needs filling,
//!    StarCoder2-3B is the candidate to check, not the 3B Qwen.
//!
//! `size_bytes` and `sha256` were not copied from a model card. Each was read from
//! `https://huggingface.co/api/models/{repo}/tree/main`, whose `lfs.oid` is the file's SHA-256, and
//! the 0.5B was downloaded and hashed to confirm the two agree. See [`super::download`] for the
//! cheaper check it does at request time.

/// Which machine an entry is meant for. Purely advisory — nothing refuses to download a model the
/// machine cannot comfortably run — but it is what the settings pane sorts and labels by, and the
/// honest answer to "which one do I pick" for someone who does not follow model releases.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    /// Runs on anything, including a laptop with no usable GPU. Completes a line, not a function.
    Light,
    /// The default. The smallest model that reliably finishes a *block* rather than a line.
    Balanced,
    /// Wants real memory and a real GPU. Noticeably better at code it has to infer rather than
    /// copy from the surrounding lines.
    Large,
}

/// One downloadable model.
///
/// `&'static str` throughout rather than `String`: this is a compile-time constant that is read
/// far more often than it is built, and keeping it borrowed means the catalogue costs no
/// allocation to consult and cannot drift from the binary that ships it.
#[derive(Clone, Copy, Debug)]
pub struct ModelSpec {
    /// Stable across releases. This is what lands in `app_settings` as the active model and what
    /// names the file on disk, so renaming one orphans a user's download.
    pub id: &'static str,
    /// Shown as-is, untranslated. It is the model's name, not a sentence of ours.
    pub label: &'static str,
    pub tier: Tier,
    /// The Hugging Face repository. Combined with [`Self::file`] by [`Self::url`].
    pub repo: &'static str,
    /// The file inside that repository, and the name it keeps under `paths::models_dir()`.
    pub file: &'static str,
    /// Exact, from the HF API. A download that ends at a different length is a truncated download,
    /// which is worth catching before the hash does because it costs nothing to check.
    pub size_bytes: u64,
    /// Lowercase hex SHA-256 of the file's contents.
    pub sha256: &'static str,
    /// For the settings row. Not parsed anywhere.
    pub params: &'static str,
    /// Rough working set for the model plus its KV cache at the context size
    /// [`super::engine::CTX_SIZE`] launches with. Advisory; see [`Tier`].
    pub min_ram_gb: u32,
    /// SPDX identifier where there is one. Every entry must be a licence this app can offer
    /// without qualification — see rule 3 in the module comment.
    pub licence: &'static str,
}

impl ModelSpec {
    /// Where the weights come from.
    ///
    /// Built rather than stored because the two halves are already fields and a third copy of the
    /// same string is a third place for a typo. Note that this 302s to a CDN host, so whatever
    /// fetches it must follow redirects — see [`super::download`].
    pub fn url(&self) -> String {
        format!("https://huggingface.co/{}/resolve/main/{}", self.repo, self.file)
    }
}

/// Everything on offer, in the order the settings pane shows them: smallest first, so the row a
/// hesitant user reads first is the one that will certainly work on their machine.
pub const CATALOGUE: &[ModelSpec] = &[
    ModelSpec {
        id: "qwen2.5-coder-0.5b",
        label: "Qwen2.5-Coder 0.5B",
        tier: Tier::Light,
        repo: "ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF",
        file: "qwen2.5-coder-0.5b-q8_0.gguf",
        size_bytes: 531_068_128,
        sha256: "d0f8cd6c49bab52a0abdbe47948518b1f4d9b1a8a2a6825099cea31cea10ac56",
        params: "0.5B · Q8_0",
        min_ram_gb: 2,
        licence: "Apache-2.0",
    },
    ModelSpec {
        id: "qwen2.5-coder-1.5b",
        label: "Qwen2.5-Coder 1.5B",
        tier: Tier::Balanced,
        repo: "ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF",
        file: "qwen2.5-coder-1.5b-q8_0.gguf",
        size_bytes: 1_646_573_056,
        sha256: "29871c94d15727a6e243f79a37113d4ae625a6215b5e800bf41a23af2da32832",
        params: "1.5B · Q8_0",
        min_ram_gb: 4,
        licence: "Apache-2.0",
    },
    ModelSpec {
        id: "qwen2.5-coder-7b",
        label: "Qwen2.5-Coder 7B",
        tier: Tier::Large,
        repo: "ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF",
        file: "qwen2.5-coder-7b-q8_0.gguf",
        size_bytes: 8_098_525_600,
        sha256: "0ef48dc94a3c551a6736ac2601de38413dc9aa9318534b16e8baee08290a4aaf",
        params: "7B · Q8_0",
        min_ram_gb: 12,
        licence: "Apache-2.0",
    },
];

/// What a user who has expressed no preference gets offered.
///
/// The 1.5B and not the 0.5B, even though the 0.5B is a third of the download and measurably
/// quicker. The 0.5B completes the line you are on; asked for anything it has to infer rather than
/// copy from two lines above, it produces something plausible and wrong, and a user whose first
/// five minutes are spent rejecting those concludes that local completion does not work. The 1.5B
/// is the smallest one where the common case — finishing a call whose shape the surrounding code
/// already implies — is right often enough to be worth the keystroke it saves.
pub const DEFAULT_MODEL_ID: &str = "qwen2.5-coder-1.5b";

/// The entry with this id, or `None` for an id from a newer build's catalogue.
///
/// `None` rather than a panic or a fallback to the default: a settings row naming a model this
/// binary does not know is a downgrade, and silently completing with a *different* model than the
/// one the user chose is worse than saying the choice is no longer available.
pub fn find(id: &str) -> Option<&'static ModelSpec> {
    CATALOGUE.iter().find(|spec| spec.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_filenames_are_unique() {
        // Two entries sharing either one would have them overwrite each other on disk, and the
        // second download would silently "succeed" against the first one's bytes.
        for (i, a) in CATALOGUE.iter().enumerate() {
            for b in CATALOGUE.iter().skip(i + 1) {
                assert_ne!(a.id, b.id, "duplicate id {}", a.id);
                assert_ne!(a.file, b.file, "duplicate filename {}", a.file);
            }
        }
    }

    #[test]
    fn the_default_is_in_the_catalogue() {
        assert!(
            find(DEFAULT_MODEL_ID).is_some(),
            "DEFAULT_MODEL_ID names a model that is not in CATALOGUE, so a fresh install would \
             offer a download that cannot be resolved",
        );
    }

    /// Rule 3 in the module comment, as a test rather than as a comment somebody has to remember.
    ///
    /// The specific trap this exists for: Qwen2.5-Coder ships 0.5B/1.5B/7B/14B under Apache-2.0 and
    /// the 3B under `qwen-research`, which is non-commercial. The sizes read as one family and the
    /// licences are not, so adding "the obvious missing middle entry" is exactly the mistake that
    /// would put a non-commercial model in front of a paying user.
    #[test]
    fn every_model_is_offerable() {
        const ALLOWED: &[&str] = &["Apache-2.0", "MIT"];
        for spec in CATALOGUE {
            assert!(
                ALLOWED.contains(&spec.licence),
                "{} is licensed {}, which this app cannot offer from a menu. If the licence is \
                 genuinely fine, add it to ALLOWED here and say why.",
                spec.id,
                spec.licence,
            );
        }
    }

    #[test]
    fn digests_are_lowercase_hex_sha256() {
        for spec in CATALOGUE {
            assert_eq!(spec.sha256.len(), 64, "{}: not a SHA-256", spec.id);
            assert!(
                spec.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{}: digest must be lowercase hex, because that is what `hex::encode` produces \
                 and the comparison in `download` is a plain string equality",
                spec.id,
            );
            assert!(spec.size_bytes > 0, "{}: size_bytes is required", spec.id);
        }
    }

    #[test]
    fn url_is_the_resolve_form() {
        let spec = find("qwen2.5-coder-1.5b").expect("catalogue entry");
        assert_eq!(
            spec.url(),
            "https://huggingface.co/ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF/resolve/main/qwen2.5-coder-1.5b-q8_0.gguf",
        );
    }
}
