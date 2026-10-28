//! Arquitectura's AI: the prompts, the payload, and the skills that ride only on this section's runs.
//!
//! The skills are compiled into the binary ([`skills_table`]) and written, at most once per change,
//! into an app-owned working folder — `state_dir/architecture/workdir`, with the same files under
//! `.claude/skills` (Claude, Grok) and `.agents/skills` (Codex). Every run started from Arquitectura
//! uses that folder as its working directory, and nothing else does: that is the whole of "these
//! skills exist only in this section". The user's repositories and home folder are never touched.
//!
//! The section answers; it does not act. Runs are read-only, skills that describe writing files or
//! running scripts are told not to, and changes come back as an `arch-patch` block the person
//! applies change by change in the app (see the `codeflow-architecture` skill for the contract).
//!
//! A document can be generated from sources — a repository, documents, a brief, a cloud snapshot
//! read with the person's authorization ([`sources`], [`cloud`]) — and the lenses' answers are
//! grounded in the same sources, read again for each question (never the cloud: that needs a new
//! authorization).

pub mod cloud;
pub mod repo_card;
pub mod system;
mod skills_table;
pub mod sources;

use std::fs;
use std::path::{Path, PathBuf};

use crate::paths;

/// The skills, by folder name — the order the UI lists them in.
pub const SKILLS: &[&str] = &[
    "codeflow-architecture",
    "grilling",
    "architecture-designer",
    "system-design",
    "architecture",
    "design-code-architecture",
    "ddia-systems",
    "security-threat-model",
    "stride-analysis-patterns",
    "documentation-and-adrs",
    "c4-architecture",
    "domain-modeling",
    "teach",
    "cloud-design-patterns",
    "aws-well-architected-review",
    "google-cloud-solution-architecture",
    "design-system",
];

const NATIVE_ROOTS: [&str; 2] = [".claude/skills", ".agents/skills"];

/// The working folder of every Arquitectura run, its skills written and current.
pub fn workdir() -> Result<PathBuf, String> {
    let root = paths::state_dir().join("architecture").join("workdir");
    install_skills(&root)?;
    Ok(root)
}

/// Writes the compiled skills under `root`'s native skill folders. Only files whose text differs are
/// rewritten (temp file + rename), and skill folders the app no longer ships are removed — but only
/// under these two roots, which are this app's own.
fn install_skills(root: &Path) -> Result<(), String> {
    for native in NATIVE_ROOTS {
        let base = root.join(native);
        fs::create_dir_all(&base).map_err(|e| format!("{}: {e}", base.display()))?;
        for (rel, text) in skills_table::FILES {
            let dest = base.join(rel);
            if fs::read_to_string(&dest).map(|have| have == *text).unwrap_or(false) {
                continue;
            }
            if let Some(dir) = dest.parent() {
                fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            let tmp = dest.with_extension("cf-tmp");
            fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
            fs::rename(&tmp, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        }
        if let Ok(entries) = fs::read_dir(&base) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if entry.path().is_dir() && !SKILLS.contains(&name.as_str()) {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    Ok(())
}

/// What the person asked Arquitectura's AI to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// A free question about the document (the Ask lens).
    Ask,
    /// The architecture review board: a verdict and graded findings.
    Review,
    /// Write a decision record into `decisions`.
    Adr,
    /// A STRIDE threat model over the zones' trust boundaries.
    Threats,
    /// Teach: explain, then check understanding.
    Tutor,
    /// Design a whole document from an idea.
    Design,
    /// Generate a whole document from sources (repository, documents, brief, cloud snapshot).
    Generate,
    /// Update the open document from sources: changes, not a new document.
    Update,
}

impl Action {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "ask" => Self::Ask,
            "review" => Self::Review,
            "adr" => Self::Adr,
            "threats" => Self::Threats,
            "tutor" => Self::Tutor,
            "design" => Self::Design,
            "generate" => Self::Generate,
            "update" => Self::Update,
            _ => return None,
        })
    }

    /// The bundled skills this action opens, besides the contract every action reads first.
    pub fn skills(self) -> &'static [&'static str] {
        match self {
            Self::Ask => &["grilling", "architecture-designer", "system-design"],
            Self::Review => &["architecture", "system-design", "ddia-systems"],
            Self::Adr => &["documentation-and-adrs", "architecture-designer"],
            Self::Threats => &["security-threat-model", "stride-analysis-patterns"],
            Self::Tutor => &["teach", "cloud-design-patterns"],
            Self::Design => &["grilling", "architecture-designer", "design-code-architecture"],
            Self::Generate => &["architecture-designer", "c4-architecture", "google-cloud-solution-architecture", "aws-well-architected-review", "system-design"],
            Self::Update => &["architecture-designer"],
        }
    }

    fn task(self, english: bool) -> &'static str {
        match (self, english) {
            (Self::Ask, false) => "Responde la pregunta de la persona sobre este documento de arquitectura.",
            (Self::Ask, true) => "Answer the person's question about this architecture document.",
            (Self::Review, false) => {
                "Haz la revisión de un comité de arquitectura de este documento. Empieza con `## Veredicto`: \
                 APROBADO, APROBADO CON OBSERVACIONES o RECHAZADO, y una línea de por qué. Luego los hallazgos, \
                 del más grave al menos, cada uno como `### Bloqueante|Mayor|Menor — título` con Dónde (los \
                 componentes por nombre), Problema, Riesgo y Corrección. Las reglas automáticas ya encontraron lo \
                 estructural (te las paso): no las repitas; busca lo que ellas no ven — requisitos, consistencia, \
                 operación, lo que el diagrama no dice. Cierra con `## Qué está bien` y, si corresponde, un bloque \
                 `arch-patch` con las correcciones que se pueden escribir en el documento."
            }
            (Self::Review, true) => {
                "Review this document as an architecture review board. Start with `## Verdict`: APPROVED, \
                 APPROVED WITH REMARKS or REJECTED, and one line of why. Then the findings, worst first, each as \
                 `### Blocker|Major|Minor — title` with Where (components by name), Problem, Risk and Fix. The \
                 automatic rules already found the structural issues (given below): do not repeat them; look for \
                 what they cannot see — requirements, consistency, operations, what the diagram does not say. End \
                 with `## What is good` and, when it applies, an `arch-patch` block with the fixes that can be \
                 written into the document."
            }
            (Self::Adr, false) => {
                "Escribe una decisión de arquitectura (ADR) sobre lo que pide la persona, en el formato `decisions` \
                 del documento: al menos tres opciones, incluida la más simple (no hacer nada o un monolito \
                 modular), criterios con peso 1–5 tomados de lo que importa aquí, puntaje 1–5 de cada opción en \
                 cada criterio, exactamente una recomendada, confianza 0–100, consecuencias y cuándo revisarla, y \
                 `affects` con los ids. Explica la recomendación en pocas líneas y entrega la decisión como un \
                 bloque `arch-patch` que la agrega a `decisions` (op add)."
            }
            (Self::Adr, true) => {
                "Write an architecture decision record (ADR) about what the person asks, in the document's \
                 `decisions` shape: at least three options including the simplest (do nothing or a modular \
                 monolith), criteria weighted 1–5 from what matters here, a 1–5 score for every option on every \
                 criterion, exactly one recommended, confidence 0–100, consequences, when to revisit, and `affects` \
                 with the ids. Explain the recommendation in a few lines and deliver the decision as an \
                 `arch-patch` block that adds it to `decisions` (op add)."
            }
            (Self::Threats, false) => {
                "Haz un modelo de amenazas STRIDE de este documento. Las zonas son los límites de confianza: cada \
                 conexión que cruza una zona es una entrada. Una tabla Amenaza | Dónde (componente o conexión) | \
                 Impacto | Mitigación, priorizada; luego lo que falta saber. Si conviene registrar algo, un bloque \
                 `arch-patch` que agrega riesgos a `risks` o notas."
            }
            (Self::Threats, true) => {
                "Write a STRIDE threat model of this document. Zones are trust boundaries: every connection that \
                 crosses a zone is an entry point. A table Threat | Where (component or connection) | Impact | \
                 Mitigation, prioritised; then what is still unknown. When something should be recorded, an \
                 `arch-patch` block that adds risks to `risks` or notes."
            }
            (Self::Tutor, false) => {
                "Eres tutor de arquitectura. Usa este documento como material: explica lo que la persona pide con \
                 los componentes reales del diagrama, de lo simple a lo detallado, y termina con una o dos \
                 preguntas para comprobar que se entendió (bloque `pregunta`). Si no pidió nada concreto, elige el \
                 patrón más interesante del diagrama y enséñalo."
            }
            (Self::Tutor, true) => {
                "You are an architecture tutor. Use this document as material: explain what the person asks with \
                 the diagram's real components, from simple to detailed, and end with one or two questions that \
                 check understanding (a `pregunta` block). When nothing specific was asked, pick the most \
                 instructive pattern in the diagram and teach it."
            }
            (Self::Design, false) => {
                "Diseña la arquitectura que la persona describe. Si te falta algo que cambia el diseño (carga, \
                 latencia, equipo, cumplimiento, presupuesto), pregunta primero en una ronda (bloque `pregunta`). \
                 Cuando tengas lo suficiente, entrega el documento completo en un bloque `arch-doc`, con una \
                 explicación breve de las decisiones y una decisión ADR-001 dentro de `decisions`."
            }
            (Self::Design, true) => {
                "Design the architecture the person describes. When something that changes the design is missing \
                 (load, latency, team, compliance, budget), ask first in one round (a `pregunta` block). Once you \
                 have enough, deliver the whole document in an `arch-doc` block, with a short explanation of the \
                 choices and an ADR-001 inside `decisions`."
            }
            (Self::Generate, false) => GENERATE_ES,
            (Self::Generate, true) => GENERATE_EN,
            (Self::Update, false) => UPDATE_ES,
            (Self::Update, true) => UPDATE_EN,
        }
    }
}

/// What "generate from sources" demands, shared by both languages' task text: the evidence lines
/// and the honesty rules that make the lenses worth reading.
const SOURCE_RULES_EN: &str = "Rules for the sources: \
    (1) Model only what the sources show or clearly imply; do not add components for completeness. \
    (2) Every component, connection, decision and risk gets `evidence`: one or more lines in exactly these \
    forms — `repo:<path>:<line> — what it says`, `doc:<name> — what`, `brief — what`, `azure:<resource id>`, \
    `aws:<arn>`, `gcp:<resource name>` — copied from the facts and listings given (the `cite` attribute of \
    each source says which form). A connection inferred from names or types says so in its evidence line. \
    (3) `sim`: take `replicas` from Kubernetes/HPA/Helm/Terraform/compose/SKU facts and the traffic from the \
    brief's scale; whatever you had to guess, mark the component's `sim.estimated: true`. \
    (4) Decisions come from the ADR files (title, status, date, context, consequences, with their \
    `repo:` evidence); add an open decision only when the sources show a choice still being made. Risks come \
    from what the sources say or plainly lack (no TLS on an ingress, one replica, a hard-coded external). \
    (5) Zones follow the real structure: provider (cloud), resource group / account / project (group), \
    cluster / namespace (cluster), tiers inside them, external providers apart. Use official icon ids \
    (`azure:…`, `aws:…`, `gcp:…`, `logos:…`) when you know them, generic glyphs otherwise. \
    (6) Write `flow` for the main request, step-numbered on the connections. \
    (7) Never write secrets, keys, connection strings or environment values, and never write `positions` or \
    `sources` — the app keeps those.";
const SOURCE_RULES_ES: &str = "Reglas para las fuentes: \
    (1) Modela solo lo que las fuentes muestran o implican claramente; no agregues componentes por completar. \
    (2) Cada componente, conexión, decisión y riesgo lleva `evidence`: una o más líneas exactamente en estas \
    formas — `repo:<ruta>:<línea> — qué dice`, `doc:<nombre> — qué`, `brief — qué`, `azure:<id del recurso>`, \
    `aws:<arn>`, `gcp:<nombre del recurso>` — copiadas de los hechos y listados entregados (el atributo `cite` \
    de cada fuente dice qué forma usar). Una conexión deducida de nombres o tipos lo dice en su evidencia. \
    (3) `sim`: toma `replicas` de los hechos de Kubernetes/HPA/Helm/Terraform/compose/SKU y el tráfico de la \
    escala del brief; lo que tuviste que suponer, márcalo con `sim.estimated: true` en ese componente. \
    (4) Las decisiones salen de los archivos ADR (título, estado, fecha, contexto, consecuencias, con su \
    evidencia `repo:`); agrega una decisión abierta solo si las fuentes muestran una elección pendiente. Los \
    riesgos salen de lo que las fuentes dicen o claramente no tienen (un ingress sin TLS, una réplica, un \
    externo fijo en el código). \
    (5) Las zonas siguen la estructura real: proveedor (cloud), resource group / cuenta / proyecto (group), \
    clúster / namespace (cluster), capas dentro, proveedores externos aparte. Usa ids de iconos oficiales \
    (`azure:…`, `aws:…`, `gcp:…`, `logos:…`) cuando los conozcas, glifos genéricos si no. \
    (6) Escribe `flow` para la petición principal, con los pasos numerados en las conexiones. \
    (7) Nunca escribas secretos, claves, connection strings ni valores de entorno, y nunca escribas `positions` \
    ni `sources`: esos los lleva la app.";

const GENERATE_EN: &str = concat!(
    "Generate the architecture document of the system the sources below describe. First a few lines on what \
     you found and what you could not tell from the sources; then the whole document in one `arch-doc` block \
     (`\"format\": \"codeflow.architecture/1\"`). If the person gave a focus, honour it. ",
    "Rules for the sources: see below.",
);
const GENERATE_ES: &str = concat!(
    "Genera el documento de arquitectura del sistema que describen las fuentes de abajo. Primero unas líneas \
     sobre lo que encontraste y lo que las fuentes no permiten saber; luego el documento completo en un solo \
     bloque `arch-doc` (`\"format\": \"codeflow.architecture/1\"`). Si la persona dio un enfoque, respétalo. ",
    "Reglas para las fuentes: ver abajo.",
);
const UPDATE_EN: &str = concat!(
    "Update the open architecture document (given below) with what the sources show: what is missing, what \
     changed, what the document says that the sources contradict. List the differences briefly, then one \
     `arch-patch` block with one change per difference (new components placed in a zone, `evidence` added to \
     what the sources confirm, `sim` figures corrected). Do not rewrite what already matches. ",
    "Rules for the sources: see below.",
);
const UPDATE_ES: &str = concat!(
    "Actualiza el documento de arquitectura abierto (abajo) con lo que muestran las fuentes: lo que falta, lo \
     que cambió, lo que el documento dice y las fuentes contradicen. Enumera las diferencias brevemente y luego \
     un bloque `arch-patch` con un cambio por diferencia (componentes nuevos ubicados en una zona, `evidence` \
     en lo que las fuentes confirman, cifras de `sim` corregidas). No reescribas lo que ya coincide. ",
    "Reglas para las fuentes: ver abajo.",
);

/// One earlier turn of the Ask lens's conversation.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Turn {
    pub role: String,
    pub text: String,
}

/// The system prompt: the section's role, which skills to open (by path inside the working folder),
/// the app's question rule, and the action's own task. `provider` decides how a skill is opened —
/// Claude has a Skill tool; the rest read the file.
pub fn system_prompt(action: Action, english: bool, provider: &str) -> String {
    let open = |name: &str| match provider {
        "claude" => format!("`{name}` (Skill tool, or .claude/skills/{name}/SKILL.md)"),
        "codex" => format!("`{name}` (.agents/skills/{name}/SKILL.md)"),
        _ => format!("`{name}` (.claude/skills/{name}/SKILL.md)"),
    };
    let skills = action.skills().iter().map(|s| open(s)).collect::<Vec<_>>().join(", ");
    let intro = if english {
        "You are CodeFlow's architecture assistant, inside the Arquitectura app. Answer in English unless \
         the person writes in another language. You may read files in your working folder (only the skills); \
         do not write files and do not run commands."
    } else {
        "Eres el asistente de arquitectura de CodeFlow, dentro de la app Arquitectura. Responde en español, \
         salvo que la persona escriba en otro idioma. Puedes leer archivos de tu carpeta de trabajo (solo las \
         skills); no escribas archivos ni ejecutes comandos."
    };
    let skills_line = if english {
        format!("Before answering, open {} — the contract of this section — and then, as needed: {skills}.", open("codeflow-architecture"))
    } else {
        format!("Antes de responder, abre {} —el contrato de esta sección— y luego, según haga falta: {skills}.", open("codeflow-architecture"))
    };
    let rules = match (action, english) {
        (Action::Generate | Action::Update, true) => format!("\n\n{SOURCE_RULES_EN}"),
        (Action::Generate | Action::Update, false) => format!("\n\n{SOURCE_RULES_ES}"),
        _ => String::new(),
    };
    format!("{intro}\n\n{skills_line}\n\n{}{rules}{}", action.task(english), crate::ai::QUESTION_RULES)
}

/// What generation reads: the sources in tagged blocks, the open document when updating, the focus.
pub fn generate_payload(sources: &str, document: Option<&str>, focus: &str, english: bool) -> String {
    let mut out = String::new();
    let focus = focus.trim();
    out.push_str(if english { "=== FOCUS ===\n" } else { "=== ENFOQUE ===\n" });
    out.push_str(if focus.is_empty() { if english { "none: model the whole system the sources describe" } else { "ninguno: modela el sistema completo que describen las fuentes" } } else { focus });
    out.push_str("\n\n");
    if let Some(doc) = document {
        out.push_str("=== CURRENT ARCHITECTURE DOCUMENT (JSON) ===\n");
        out.push_str(doc.trim());
        out.push_str("\n\n");
    }
    out.push_str(if english { "=== SOURCES ===\n" } else { "=== FUENTES ===\n" });
    out.push_str(sources.trim());
    out.push('\n');
    // The system map is read from the code, so it outranks anything inferred from a summary.
    if sources.contains("kind=\"system\"") {
        out.push_str(if english {
            "\nA `system` source lists how the repositories connect, found in their code. Draw every `verified` connection; draw an `inferred` one as uncertain and say why; never connect an `unresolved` call to a guess — list it as a call to something outside these repositories.\n"
        } else {
            "\nUna fuente `system` lista cómo se conectan los repositorios, encontrado en su código. Dibuja toda conexión `verified`; dibuja una `inferred` como incierta y di por qué; nunca conectes una llamada `unresolved` a una suposición — lista como una llamada a algo fuera de estos repositorios.\n"
        });
    }
    out
}

/// The data on stdin: the document and what the app computed about it, the sources it was made from
/// (read again now, when it has any), then the conversation.
pub fn payload(document: &str, context: &str, sources: &str, history: &[Turn], english: bool) -> String {
    let mut out = String::new();
    out.push_str("=== ARCHITECTURE DOCUMENT (JSON) ===\n");
    out.push_str(document.trim());
    out.push_str("\n\n");
    if !context.trim().is_empty() {
        out.push_str(if english { "=== WHAT THE APP COMPUTED (review rules, simulation) ===\n" } else { "=== LO QUE CALCULÓ LA APP (reglas de revisión, simulación) ===\n" });
        out.push_str(context.trim());
        out.push_str("\n\n");
    }
    if !sources.trim().is_empty() {
        out.push_str(if english {
            "=== THE SOURCES THIS DOCUMENT WAS MADE FROM (read again now; ground your answer in them and cite them like the evidence lines) ===\n"
        } else {
            "=== LAS FUENTES DE LAS QUE SALIÓ ESTE DOCUMENTO (releídas ahora; apoya tu respuesta en ellas y cítalas como las líneas de evidencia) ===\n"
        });
        out.push_str(sources.trim());
        out.push_str("\n\n");
    }
    let recent: Vec<&Turn> = history.iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
    if !recent.is_empty() {
        out.push_str(if english { "=== CONVERSATION SO FAR ===\n" } else { "=== CONVERSACIÓN HASTA AHORA ===\n" });
        for turn in recent {
            let who = if turn.role == "user" { if english { "Person" } else { "Persona" } } else { "Asistente" };
            out.push_str(&format!("{who}: {}\n\n", turn.text.trim()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_skill_is_compiled_in_with_a_matching_name() {
        for name in SKILLS {
            let skill = skills_table::FILES.iter().find(|(rel, _)| *rel == format!("{name}/SKILL.md"));
            let (_, text) = skill.unwrap_or_else(|| panic!("{name}/SKILL.md is not in the table"));
            let declared = text.lines().find_map(|l| l.strip_prefix("name:")).map(|v| v.trim().trim_matches('"').to_string());
            assert_eq!(declared.as_deref(), Some(*name), "{name}: front matter name");
        }
        for (rel, _) in skills_table::FILES {
            let top = rel.split('/').next().unwrap();
            assert!(SKILLS.contains(&top), "{top} is compiled in but not listed");
        }
    }

    #[test]
    fn generation_asks_for_evidence_and_keeps_the_apps_fields_out() {
        assert_eq!(Action::parse("generate"), Some(Action::Generate));
        assert_eq!(Action::parse("update"), Some(Action::Update));
        for english in [true, false] {
            let prompt = system_prompt(Action::Generate, english, "claude");
            assert!(prompt.contains("arch-doc") && prompt.contains("`evidence`") && prompt.contains("sim.estimated: true"));
            assert!(prompt.contains("repo:<") && prompt.contains("azure:<") && prompt.contains("`positions`"));
            let update = system_prompt(Action::Update, english, "codex");
            assert!(update.contains("arch-patch") && update.contains("`evidence`"));
            assert!(!system_prompt(Action::Ask, english, "claude").contains("sim.estimated"));
        }
        let p = generate_payload("<source n=\"1\">x</source>", Some("{\"b\":2}"), "", true);
        assert!(p.contains("=== FOCUS ===\nnone") && p.contains("{\"b\":2}") && p.ends_with("</source>\n"));
        let lens = payload("{}", "", "<source n=\"1\">facts</source>", &[], true);
        assert!(lens.contains("THE SOURCES THIS DOCUMENT WAS MADE FROM") && lens.contains("facts"));
    }

    #[test]
    fn every_action_names_skills_that_ship() {
        for action in ["ask", "review", "adr", "threats", "tutor", "design", "generate", "update"] {
            let a = Action::parse(action).unwrap();
            for s in a.skills() {
                assert!(SKILLS.contains(s), "{action} opens {s}, which is not shipped");
            }
            let prompt = system_prompt(a, false, "codex");
            assert!(prompt.contains(".agents/skills/codeflow-architecture/SKILL.md"));
        }
    }

    #[test]
    fn installs_and_prunes_only_its_own_folders() {
        let dir = std::env::temp_dir().join(format!("cf-arch-skills-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".claude/skills/stale")).unwrap();
        install_skills(&dir).unwrap();
        assert!(dir.join(".claude/skills/codeflow-architecture/SKILL.md").is_file());
        assert!(dir.join(".agents/skills/teach/SKILL.md").is_file());
        assert!(!dir.join(".claude/skills/stale").exists());
        install_skills(&dir).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_payload_carries_the_document_and_the_last_turns() {
        let history: Vec<Turn> = (0..20).map(|i| Turn { role: if i % 2 == 0 { "user".into() } else { "assistant".into() }, text: format!("t{i}") }).collect();
        let p = payload("{\"a\":1}", "rules: none", "", &history, false);
        assert!(p.contains("{\"a\":1}"));
        assert!(p.contains("rules: none"));
        assert!(p.contains("t19") && !p.contains("t7\n"));
    }
}
