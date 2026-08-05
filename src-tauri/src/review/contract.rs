//! The review's two policies, as data rather than as prose the model applies from memory.
//!
//! A **level contract** answers "how deep does this review go": the confidence threshold, which
//! severities are worth reporting, which lenses are active, and how much parallelism to spend. A
//! **gate policy** answers the other question the team reads as a traffic light: which severities
//! make the Quality Gate fail.
//!
//! Both used to live as a paragraph inside the prompt (`review_level_directive`), which meant the
//! numbers existed only in the model's reading of them: two runs of the same PR at the same level
//! could filter differently and nothing noticed. Here they are values — resolved once, published to
//! the model in the bundle header, applied by [`super::merge`], and frozen into the run's memory so
//! a review read months later still says which rules produced it.
//!
//! Per-workspace overrides come from `review_engine_config` (the equivalent of WF-PR-REVIEWER's
//! `pr-review.config.json`). A stored value that is out of range is ignored rather than fatal: a
//! broken config degrades to the defaults, because it must never be able to block a review.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The three depth levels, in the spelling the frontend's `ReviewLevel` union already uses.
pub const LEVELS: [&str; 3] = ["basico", "completo", "ultra"];

/// Folds every spelling a level can arrive in — the store's own ids, an accented "básico", the
/// English words a user might type into an agent prompt — onto one of [`LEVELS`]. Anything
/// unrecognised is `completo`, which is the documented default rather than a guess.
pub fn normalize_level(level: &str) -> &'static str {
    match level.trim().to_lowercase().as_str() {
        "basico" | "básico" | "basic" => "basico",
        "ultra" | "exhaustivo" => "ultra",
        _ => "completo",
    }
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/// A finding's severity, most severe first.
///
/// The derived `Ord` **is** the report order (`Blocker < Critico < …`), which is why the variants
/// are declared in this sequence and not alphabetically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Severity {
    Blocker,
    Critico,
    Mayor,
    Menor,
    Info,
}

impl Severity {
    pub const ALL: [Severity; 5] =
        [Severity::Blocker, Severity::Critico, Severity::Mayor, Severity::Menor, Severity::Info];

    /// Reads a severity out of whatever the model wrote between the brackets.
    ///
    /// Deliberately tolerant of both languages and of missing accents. The prompt asks for the
    /// Spanish labels, but the same standard is fed to engines that answer in English half the
    /// time, and a `Critical` that parsed as "unknown" would be silently dropped by the threshold
    /// filter — the one failure mode this whole module exists to prevent.
    pub fn parse(raw: &str) -> Option<Self> {
        let key = raw.trim().to_lowercase();
        let key = key.trim_matches(|c: char| !c.is_alphanumeric());
        match key {
            "blocker" | "bloqueante" => Some(Severity::Blocker),
            "critico" | "crítico" | "critical" | "critica" | "crítica" => Some(Severity::Critico),
            "mayor" | "major" | "advertencia" | "warning" => Some(Severity::Mayor),
            "menor" | "minor" => Some(Severity::Menor),
            "info" | "nit" | "nitpick" | "sugerencia" | "informativo" => Some(Severity::Info),
            _ => None,
        }
    }

    /// The canonical label written back into the report — always Spanish, always accented, so two
    /// runs never render the same severity two ways.
    pub fn label(self) -> &'static str {
        match self {
            Severity::Blocker => "Blocker",
            Severity::Critico => "Crítico",
            Severity::Mayor => "Mayor",
            Severity::Menor => "Menor",
            Severity::Info => "Info",
        }
    }

    /// The heading emoji. Only three exist, and which severity maps to which is part of the format
    /// contract with `parseAnalysis.ts` — it derives the UI's critical/warning/info bucket from
    /// this character alone, so a fourth emoji would render as `info`.
    pub fn emoji(self) -> &'static str {
        match self {
            Severity::Blocker | Severity::Critico => "🚨",
            Severity::Mayor => "⚠️",
            Severity::Menor | Severity::Info => "ℹ️",
        }
    }

    /// The A–E rating a dimension gets when this is the **worst** finding in it. `A` is the absence
    /// of findings, so it is not reachable from here.
    pub fn rating(self) -> char {
        match self {
            Severity::Blocker => 'E',
            Severity::Critico => 'D',
            Severity::Mayor => 'C',
            // The published table stops at Minor; an Info is still a finding, so it lands on the
            // same rung rather than pretending the dimension is spotless.
            Severity::Menor | Severity::Info => 'B',
        }
    }
}

/// A finding's type, which is what its dimension is derived from — the two are never chosen
/// independently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FindingType {
    Bug,
    Vulnerabilidad,
    SecurityHotspot,
    CodeSmell,
}

impl FindingType {
    pub fn parse(raw: &str) -> Option<Self> {
        let key = raw.trim().to_lowercase().replace(['-', '_'], " ");
        let key = key.split_whitespace().collect::<Vec<_>>().join(" ");
        match key.as_str() {
            "bug" | "defecto" => Some(FindingType::Bug),
            "vulnerabilidad" | "vulnerability" | "vuln" => Some(FindingType::Vulnerabilidad),
            "security hotspot" | "hotspot" | "punto caliente" => Some(FindingType::SecurityHotspot),
            "code smell" | "codesmell" | "smell" | "mantenibilidad" => Some(FindingType::CodeSmell),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            FindingType::Bug => "Bug",
            FindingType::Vulnerabilidad => "Vulnerabilidad",
            FindingType::SecurityHotspot => "Security Hotspot",
            FindingType::CodeSmell => "Code Smell",
        }
    }

    /// Which of the three A–E ratings this type feeds. Derived, never an independent choice:
    /// Reliability ← Bugs · Security ← Vulnerabilities + Hotspots · Maintainability ← Code Smells.
    pub fn dimension(self) -> Dimension {
        match self {
            FindingType::Bug => Dimension::Fiabilidad,
            FindingType::Vulnerabilidad | FindingType::SecurityHotspot => Dimension::Seguridad,
            FindingType::CodeSmell => Dimension::Mantenibilidad,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Dimension {
    Fiabilidad,
    Seguridad,
    Mantenibilidad,
}

/// The three A–E ratings of one review, each from the worst finding in its dimension.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Ratings {
    pub fiabilidad: char,
    pub seguridad: char,
    pub mantenibilidad: char,
}

impl Default for Ratings {
    fn default() -> Self {
        Self { fiabilidad: 'A', seguridad: 'A', mantenibilidad: 'A' }
    }
}

// ---------------------------------------------------------------------------
// Lenses
// ---------------------------------------------------------------------------

/// The built-in review lenses, one line each, in the format the editable `review_lenses` prompt
/// stores them: `<n>. <label>`.
///
/// They travel in each bundle's header rather than in every worker's prompt — with N groups, the
/// prompt copy was N copies of the same checklist, and the worker had no way to know which lenses
/// its level had actually switched on.
pub const DEFAULT_LENSES: &str = "\
1. Correctitud: lógica invertida, off-by-one, null/undefined, errores sin manejar, races, flujo de control roto.
2. Seguridad (OWASP): inyección, authn/authz, secretos en código, deserialización insegura, SSRF, path traversal, cripto débil, validación en bordes de confianza.
3. Rendimiento: N+1, loops sin tope, I/O síncrono en caliente, leaks, falta de paginación o cancelación, bloqueo dentro de async.
4. API / contrato / datos: breaking changes de DTO o esquema, migraciones, retrocompatibilidad, idempotencia, transacciones.
5. Tests y mantenibilidad del cambio: rutas nuevas o modificadas sin cobertura, asserts débiles, código muerto o restos de debug.
6. Mantenibilidad general: duplicación, naming confuso, complejidad innecesaria.";

/// Parses the `review_lenses` prompt into `{number: label}`.
///
/// Lenient on the separator (`1.`, `1)`, `1 -`) because this text is edited by hand and a lens that
/// stopped parsing would silently vanish from every bundle header. A line that carries no leading
/// number is skipped rather than guessed at.
pub fn parse_lenses(text: &str) -> BTreeMap<u8, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let digits: String = trimmed.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            continue;
        }
        let Ok(n) = digits.parse::<u8>() else { continue };
        let label = trimmed[digits.len()..]
            .trim_start()
            .trim_start_matches(['.', ')', '-', ':'])
            .trim();
        if !label.is_empty() {
            out.insert(n, label.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Level contract
// ---------------------------------------------------------------------------

/// One level's resolved contract — every number the review is held to, with nothing left to infer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelContract {
    pub level: String,
    /// Confidence a finding needs to survive.
    pub min_confidence: u8,
    /// The threshold `Blocker` gets instead, deliberately lower: the cost of staying quiet about a
    /// possible data loss or auth bypass is not symmetric with the cost of a false positive.
    pub min_confidence_blocker: u8,
    /// Which severities this level reports at all. Independent of the threshold — a `Menor` at
    /// confidence 100 still does not survive `basico`.
    pub severities: Vec<Severity>,
    /// Which lenses are active, by number into the lens catalog.
    pub lenses: Vec<u8>,
    /// Whether the review may fan out across parallel workers.
    pub subagents: bool,
    /// Whether nitpicks (`Info`) are wanted. Reported in the prose; the hard filter is `severities`.
    pub nitpicks: bool,
    /// Target files per worker group.
    pub files_per_group: usize,
    /// Ceiling on the number of groups, so a 300-file PR does not open 60 subprocesses.
    pub max_groups: usize,
    /// Whether to spend one extra pass reading only the outline, for the lenses that span files
    /// (API/contract, breaking changes, migrations) and that no single-file worker can see.
    pub cross_file: bool,
}

impl LevelContract {
    /// The threshold that applies to a given severity.
    pub fn threshold_for(&self, severity: Severity) -> u8 {
        match severity {
            Severity::Blocker => self.min_confidence_blocker,
            _ => self.min_confidence,
        }
    }

    pub fn reports(&self, severity: Severity) -> bool {
        self.severities.contains(&severity)
    }

    /// The severity labels this contract reports, for the bundle header and the report.
    pub fn severity_labels(&self) -> Vec<&'static str> {
        self.severities.iter().map(|s| s.label()).collect()
    }
}

/// Built-in defaults per level — the values that used to be a prose table inside the prompt.
fn level_defaults(level: &str) -> LevelContract {
    match normalize_level(level) {
        "basico" => LevelContract {
            level: "basico".into(),
            min_confidence: 75,
            min_confidence_blocker: 75,
            severities: vec![Severity::Blocker, Severity::Critico],
            lenses: vec![1, 2],
            subagents: false,
            nitpicks: false,
            files_per_group: 5,
            max_groups: 4,
            cross_file: false,
        },
        "ultra" => LevelContract {
            level: "ultra".into(),
            min_confidence: 50,
            min_confidence_blocker: 50,
            severities: Severity::ALL.to_vec(),
            lenses: vec![1, 2, 3, 4, 5, 6],
            subagents: true,
            nitpicks: true,
            // Fewer files each, more groups: every worker reads less code more deeply instead of
            // piling the whole PR into four giant bundles.
            files_per_group: 3,
            max_groups: 8,
            cross_file: true,
        },
        _ => LevelContract {
            level: "completo".into(),
            min_confidence: 60,
            min_confidence_blocker: 50,
            severities: vec![Severity::Blocker, Severity::Critico, Severity::Mayor, Severity::Menor],
            lenses: vec![1, 2, 3, 4, 5],
            subagents: true,
            nitpicks: false,
            files_per_group: 5,
            max_groups: 4,
            cross_file: true,
        },
    }
}

/// A workspace's per-field override of one level. Every field is optional: what is absent falls
/// through to [`level_defaults`], so a later change to a built-in default still reaches a workspace
/// that only ever customised its threshold.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LevelOverride {
    pub min_confidence: Option<u8>,
    pub min_confidence_blocker: Option<u8>,
    pub severities: Option<Vec<String>>,
    pub lenses: Option<Vec<u8>>,
    pub subagents: Option<bool>,
    pub nitpicks: Option<bool>,
    pub files_per_group: Option<usize>,
    pub max_groups: Option<usize>,
    pub cross_file: Option<bool>,
}

/// Which severities make the Quality Gate `FAILED`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GateConfig {
    pub blocking_severities: Vec<String>,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self { blocking_severities: vec!["Blocker".into(), "Crítico".into()] }
    }
}

/// Which files a review is allowed to look at, as glob patterns.
///
/// Applied **before** anything is read, so what is out of scope never reaches a bundle, a token
/// budget, or the model's attention. The exclude list is the one from the transversal runbook:
/// build output, lockfiles, snapshots and generated code, none of which a human reviews either.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ScopeConfig {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

impl Default for ScopeConfig {
    fn default() -> Self {
        Self {
            include: vec!["**".into()],
            exclude: [
                "**/node_modules/**",
                "**/dist/**",
                "**/build/**",
                "**/out/**",
                "**/target/**",
                "**/coverage/**",
                "**/__snapshots__/**",
                "**/*.snap",
                "**/*.min.js",
                "**/*.min.css",
                "**/*.map",
                "**/*.lock",
                "package-lock.json",
                "pnpm-lock.yaml",
                "yarn.lock",
                "Cargo.lock",
                "**/*.generated.*",
                "**/*.g.dart",
                "**/*.designer.cs",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        }
    }
}

/// Blast-radius settings. The caps are not defensive — without them one symbol with 200 callers
/// would enter the prompt whole.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GraphConfig {
    pub enabled: bool,
    pub max_symbols: usize,
    pub max_callers: usize,
}

impl Default for GraphConfig {
    fn default() -> Self {
        Self { enabled: true, max_symbols: 40, max_callers: 10 }
    }
}

/// How much code a reading bundle may carry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BundleConfig {
    /// Lines of padding around each touched symbol.
    pub context_lines: usize,
    /// Ceiling on the lines included from any one file.
    pub max_lines_per_file: usize,
    /// Ceiling on a whole group's bundle; past it the files with the fewest changed lines degrade
    /// to a stub naming their symbols, which the model can still open itself.
    pub max_kb_per_group: usize,
}

impl Default for BundleConfig {
    fn default() -> Self {
        Self { context_lines: 3, max_lines_per_file: 800, max_kb_per_group: 64 }
    }
}

/// How many workers may actually run at once, independently of how many groups the plan produced.
///
/// The cap is about cost and rate limits rather than about CPU: each worker is a full model
/// invocation, so four groups running at once is four times the burn of one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkersConfig {
    pub max_parallel: usize,
}

impl Default for WorkersConfig {
    fn default() -> Self {
        Self { max_parallel: 4 }
    }
}

/// The whole per-workspace review engine configuration — CodeFlow's equivalent of
/// WF-PR-REVIEWER's `pr-review.config.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewEngineConfig {
    pub levels: BTreeMap<String, LevelOverride>,
    pub quality_gate: GateConfig,
    pub scope: ScopeConfig,
    pub graph: GraphConfig,
    pub bundles: BundleConfig,
    pub workers: WorkersConfig,
}

impl ReviewEngineConfig {
    /// Parses a stored configuration, falling back to the defaults when it is missing or unreadable.
    ///
    /// Never an error: a configuration nobody can parse is a reason to review with the built-in
    /// rules, not a reason to refuse to review.
    pub fn load(stored: Option<&str>) -> Self {
        stored
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default()
    }
}

/// A level's effective contract: built-in defaults with the workspace's overrides applied field by
/// field.
///
/// An override with an impossible value (a confidence above 100, an empty severity list, a lens
/// number nothing maps to) is dropped rather than honoured — the same fault tolerance the rest of
/// the configuration has, and for the same reason.
pub fn resolve_level_contract(level: &str, config: &ReviewEngineConfig) -> LevelContract {
    let level = normalize_level(level);
    let mut contract = level_defaults(level);
    let Some(over) = config.levels.get(level) else { return contract };

    if let Some(v) = over.min_confidence.filter(|v| *v <= 100) {
        contract.min_confidence = v;
    }
    if let Some(v) = over.min_confidence_blocker.filter(|v| *v <= 100) {
        contract.min_confidence_blocker = v;
    }
    if let Some(list) = &over.severities {
        let parsed: Vec<Severity> = list.iter().filter_map(|s| Severity::parse(s)).collect();
        if !parsed.is_empty() {
            // Canonical order, so the published contract never depends on how the config was typed.
            contract.severities = Severity::ALL.iter().copied().filter(|s| parsed.contains(s)).collect();
        }
    }
    if let Some(list) = &over.lenses {
        let mut lenses: Vec<u8> = list.iter().copied().filter(|n| *n >= 1).collect();
        lenses.sort_unstable();
        lenses.dedup();
        if !lenses.is_empty() {
            contract.lenses = lenses;
        }
    }
    if let Some(v) = over.subagents {
        contract.subagents = v;
    }
    if let Some(v) = over.nitpicks {
        contract.nitpicks = v;
    }
    if let Some(v) = over.files_per_group.filter(|v| (1..=100).contains(v)) {
        contract.files_per_group = v;
    }
    if let Some(v) = over.max_groups.filter(|v| (1..=32).contains(v)) {
        contract.max_groups = v;
    }
    if let Some(v) = over.cross_file {
        contract.cross_file = v;
    }
    contract
}

// ---------------------------------------------------------------------------
// The settings screen's view of all this
// ---------------------------------------------------------------------------

/// One level as the settings screen shows and saves it: every value present, and severities as the
/// labels a human reads rather than as enum variant names.
///
/// A view rather than the contract itself because the two have opposite needs. The contract is
/// resolved — defaults with overrides applied — while what is *stored* is only the overrides; and
/// the screen has to render the effective numbers even for a workspace that has never customised
/// anything. Saving a view writes every field as an explicit override, which is what "the screen
/// shows what will happen" costs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelView {
    pub level: String,
    pub min_confidence: u8,
    pub min_confidence_blocker: u8,
    pub severities: Vec<String>,
    pub lenses: Vec<u8>,
    pub subagents: bool,
    pub nitpicks: bool,
    pub files_per_group: usize,
    pub max_groups: usize,
    pub cross_file: bool,
}

impl From<&LevelContract> for LevelView {
    fn from(c: &LevelContract) -> Self {
        Self {
            level: c.level.clone(),
            min_confidence: c.min_confidence,
            min_confidence_blocker: c.min_confidence_blocker,
            severities: c.severity_labels().into_iter().map(str::to_string).collect(),
            lenses: c.lenses.clone(),
            subagents: c.subagents,
            nitpicks: c.nitpicks,
            files_per_group: c.files_per_group,
            max_groups: c.max_groups,
            cross_file: c.cross_file,
        }
    }
}

impl From<&LevelView> for LevelOverride {
    fn from(v: &LevelView) -> Self {
        Self {
            min_confidence: Some(v.min_confidence),
            min_confidence_blocker: Some(v.min_confidence_blocker),
            severities: Some(v.severities.clone()),
            lenses: Some(v.lenses.clone()),
            subagents: Some(v.subagents),
            nitpicks: Some(v.nitpicks),
            files_per_group: Some(v.files_per_group),
            max_groups: Some(v.max_groups),
            cross_file: Some(v.cross_file),
        }
    }
}

/// The whole configuration, resolved — what the settings screen renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedConfig {
    pub levels: Vec<LevelView>,
    pub quality_gate: GateConfig,
    pub scope: ScopeConfig,
    pub graph: GraphConfig,
    pub bundles: BundleConfig,
    pub workers: WorkersConfig,
    /// Every lens the catalog knows, so the level editor can offer them by name instead of by
    /// number. Filled from the workspace's editable `review_lenses` prompt.
    pub lens_catalog: Vec<(u8, String)>,
}

/// Resolves a stored configuration into the shape the settings screen edits.
pub fn resolve_all(config: &ReviewEngineConfig, lenses_text: &str) -> ResolvedConfig {
    ResolvedConfig {
        levels: LEVELS
            .iter()
            .map(|l| LevelView::from(&resolve_level_contract(l, config)))
            .collect(),
        quality_gate: config.quality_gate.clone(),
        scope: config.scope.clone(),
        graph: config.graph.clone(),
        bundles: config.bundles.clone(),
        workers: config.workers.clone(),
        lens_catalog: parse_lenses(lenses_text).into_iter().collect(),
    }
}

/// Turns an edited view back into the stored configuration.
pub fn from_resolved(view: &ResolvedConfig) -> ReviewEngineConfig {
    ReviewEngineConfig {
        levels: view
            .levels
            .iter()
            .map(|l| (normalize_level(&l.level).to_string(), LevelOverride::from(l)))
            .collect(),
        quality_gate: view.quality_gate.clone(),
        scope: view.scope.clone(),
        graph: view.graph.clone(),
        bundles: view.bundles.clone(),
        workers: view.workers.clone(),
    }
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

/// The severities the workspace's policy blocks on, parsed and in canonical order.
pub fn blocking_severities(config: &ReviewEngineConfig) -> Vec<Severity> {
    let parsed: Vec<Severity> = config
        .quality_gate
        .blocking_severities
        .iter()
        .filter_map(|s| Severity::parse(s))
        .collect();
    if parsed.is_empty() {
        return vec![Severity::Blocker, Severity::Critico];
    }
    Severity::ALL.iter().copied().filter(|s| parsed.contains(s)).collect()
}

/// Whether a review's gate means anything at all: only when the review **reports** every severity
/// the gate blocks on.
///
/// The two policies are independent and can contradict each other. With `Mayor` among the blocking
/// severities and a `basico` review — which does not report `Mayor` at all — the pull request comes
/// out `PASSED` without anyone having looked for one. That is a `PASSED` nobody earned, and saying
/// so is the only honest thing the report can do with it.
pub fn gate_is_conclusive(blocking: &[Severity], reported: &[Severity]) -> bool {
    blocking.iter().all(|s| reported.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severities_parse_across_languages_and_accents() {
        assert_eq!(Severity::parse("Crítico"), Some(Severity::Critico));
        assert_eq!(Severity::parse("critico"), Some(Severity::Critico));
        assert_eq!(Severity::parse("Critical"), Some(Severity::Critico));
        assert_eq!(Severity::parse("  MAYOR "), Some(Severity::Mayor));
        assert_eq!(Severity::parse("nonsense"), None);
    }

    /// The derived `Ord` is the report order, and the report is sorted by it — if the variants are
    /// ever reordered, this is what says so.
    #[test]
    fn severity_order_is_most_severe_first() {
        let mut all = vec![Severity::Menor, Severity::Blocker, Severity::Info, Severity::Mayor];
        all.sort();
        assert_eq!(all, vec![Severity::Blocker, Severity::Mayor, Severity::Menor, Severity::Info]);
    }

    /// Only three emoji exist, because `parseAnalysis.ts` derives its whole severity bucket from
    /// this character.
    #[test]
    fn every_severity_maps_to_one_of_the_three_known_emoji() {
        for s in Severity::ALL {
            assert!(["🚨", "⚠️", "ℹ️"].contains(&s.emoji()), "{:?} has an unknown emoji", s);
        }
    }

    #[test]
    fn a_type_decides_its_own_dimension() {
        assert_eq!(FindingType::Bug.dimension(), Dimension::Fiabilidad);
        assert_eq!(FindingType::SecurityHotspot.dimension(), Dimension::Seguridad);
        assert_eq!(FindingType::Vulnerabilidad.dimension(), Dimension::Seguridad);
        assert_eq!(FindingType::CodeSmell.dimension(), Dimension::Mantenibilidad);
    }

    #[test]
    fn levels_resolve_to_their_documented_defaults() {
        let cfg = ReviewEngineConfig::default();
        let basic = resolve_level_contract("basico", &cfg);
        assert_eq!(basic.min_confidence, 75);
        assert!(!basic.subagents, "basico is a single pass");
        assert!(!basic.reports(Severity::Mayor));

        let full = resolve_level_contract("completo", &cfg);
        assert_eq!(full.min_confidence, 60);
        assert_eq!(full.min_confidence_blocker, 50, "Blocker gets its own, lower bar");
        assert!(!full.reports(Severity::Info));

        let ultra = resolve_level_contract("ultra", &cfg);
        assert!(ultra.reports(Severity::Info));
        assert_eq!(ultra.lenses.len(), 6);
    }

    /// An unknown level is `completo`, not an error — the level arrives from a store, a URL and
    /// occasionally an agent's prose.
    #[test]
    fn an_unknown_level_falls_back_to_completo() {
        let cfg = ReviewEngineConfig::default();
        assert_eq!(resolve_level_contract("whatever", &cfg).level, "completo");
        assert_eq!(resolve_level_contract("básico", &cfg).level, "basico");
    }

    #[test]
    fn overrides_apply_field_by_field() {
        let mut cfg = ReviewEngineConfig::default();
        cfg.levels.insert(
            "completo".into(),
            LevelOverride {
                min_confidence: Some(80),
                severities: Some(vec!["Blocker".into(), "Info".into()]),
                ..Default::default()
            },
        );
        let c = resolve_level_contract("completo", &cfg);
        assert_eq!(c.min_confidence, 80, "the overridden field changes");
        assert_eq!(c.min_confidence_blocker, 50, "the ones left alone keep their default");
        assert_eq!(c.severities, vec![Severity::Blocker, Severity::Info], "and come back in canonical order");
    }

    /// A configuration nobody can honour degrades to the defaults; it never blocks a review.
    #[test]
    fn impossible_overrides_are_ignored() {
        let mut cfg = ReviewEngineConfig::default();
        cfg.levels.insert(
            "completo".into(),
            LevelOverride {
                min_confidence: Some(140),
                severities: Some(vec!["nonsense".into()]),
                files_per_group: Some(0),
                ..Default::default()
            },
        );
        let c = resolve_level_contract("completo", &cfg);
        assert_eq!(c.min_confidence, 60);
        assert_eq!(c.files_per_group, 5);
        assert!(c.reports(Severity::Mayor), "the unusable severity list was dropped whole");
    }

    #[test]
    fn a_broken_config_is_not_fatal() {
        assert_eq!(ReviewEngineConfig::load(Some("{{{")).workers.max_parallel, 4);
        assert_eq!(ReviewEngineConfig::load(None).graph.enabled, true);
        // A partial config keeps the defaults for everything it doesn't mention.
        let partial = ReviewEngineConfig::load(Some(r#"{"workers":{"maxParallel":2}}"#));
        assert_eq!(partial.workers.max_parallel, 2);
        assert_eq!(partial.bundles.max_lines_per_file, 800);
    }

    #[test]
    fn the_gate_is_inconclusive_when_it_blocks_on_something_the_level_never_looks_for() {
        let reported = vec![Severity::Blocker, Severity::Critico];
        assert!(gate_is_conclusive(&[Severity::Blocker, Severity::Critico], &reported));
        assert!(
            !gate_is_conclusive(&[Severity::Blocker, Severity::Mayor], &reported),
            "a PASSED nobody earned has to be recognisable"
        );
    }

    #[test]
    fn lenses_parse_from_their_editable_text() {
        let lenses = parse_lenses(DEFAULT_LENSES);
        assert_eq!(lenses.len(), 6);
        assert!(lenses[&2].to_lowercase().contains("seguridad"));
        // Hand-edited text: separators vary, blank and unnumbered lines are skipped.
        let custom = parse_lenses("1) Uno\n\n2 - Dos\nsin numero\n3. Tres");
        assert_eq!(custom.len(), 3);
        assert_eq!(custom[&2], "Dos");
    }
}
