//! Provider-neutral AI layer.
//!
//! Every AI feature in CodeFlow (commit messages, PR review, pre-commit analysis, chat,
//! "fix with AI") drives a headless CLI subprocess. The specifics of *which* CLI — its binary,
//! flags, and how it reports results — live behind the [`AiEngine`] trait so a second provider
//! (Gemini, and later Codex/local) is a new `impl`, not a fork of every call site. This mirrors
//! the VCS side's `LinkedRepo` dispatch.
//!
//! Split of concerns:
//! - **This module** owns everything shared: the run plumbing ([`run`]), the prompt *templates*
//!   (provider-independent — the same instructions are sent whichever engine is active), quota
//!   detection, `PATH` augmentation, and the high-level operations.
//! - **Each engine** (`claude::ClaudeEngine`, `gemini::GeminiEngine`) owns only what differs:
//!   the default binary, how a command is built, and how that CLI's output is parsed.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::ai_runs::{self, RunCtx};

pub const MAX_DIFF_CHARS: usize = 20_000;
pub const MAX_REVIEW_DIFF_CHARS: usize = 120_000;
/// Per-side cap for conflict resolution — a file whose one side is bigger than this is better
/// merged by hand than fed whole to the model.
pub const MAX_CONFLICT_SIDE_CHARS: usize = 40_000;

/// Prefix the frontend looks for to render a dedicated "you're out of quota" notice instead of
/// a generic error banner. Both engines emit it, so it lives here.
pub const QUOTA_MARKER: &str = "QUOTA_EXCEEDED::";

/// Phrases that mean "the provider refused because of a limit or your account balance", not that
/// something is broken. The billing ones matter for the credit-based CLIs (opencode bills per
/// token, so it answers with "Insufficient balance" rather than a rate limit).
const QUOTA_SIGNALS: [&str; 11] = [
    "usage limit",
    "rate limit",
    "quota exceeded",
    "resets at",
    "try again in",
    "limit reached",
    "insufficient balance",
    "insufficient credit",
    "out of credit",
    "payment required",
    "billing",
];

/// Whether a CLI's message reads like a quota/billing refusal rather than a genuine error —
/// shared by every engine's output interpreter.
pub(crate) fn quota_signal(text: &str) -> bool {
    let lower = text.to_lowercase();
    QUOTA_SIGNALS.iter().any(|s| lower.contains(s))
}

/// Tags a limit/billing refusal with [`QUOTA_MARKER`] so the frontend renders its dedicated notice
/// instead of a bare red error. The subprocess engines do this inside their own `interpret`; the
/// HTTP ones never reach that, so [`run`] applies it to their results here.
fn mark_quota(result: Result<AiRun, String>) -> Result<AiRun, String> {
    result.map_err(|e| {
        if e.starts_with(QUOTA_MARKER) || !quota_signal(&e) {
            e
        } else {
            format!("{QUOTA_MARKER}{e}")
        }
    })
}

/// Removes terminal escape sequences from a CLI's output. The engines run headless but still
/// colourize (opencode paints its errors red), and those raw `ESC[91m` bytes would otherwise be
/// rendered literally in the UI. Handles CSI (colour/cursor) and OSC (hyperlink/title) sequences.
pub(crate) fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: ESC [ params… final byte in @–~
            Some('[') => {
                for byte in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&byte) {
                        break;
                    }
                }
            }
            // OSC: ESC ] … terminated by BEL or ESC \
            Some(']') => {
                while let Some(byte) = chars.next() {
                    if byte == '\u{7}' {
                        break;
                    }
                    if byte == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            // Any other two-byte escape: the second char is already consumed.
            _ => {}
        }
    }
    out
}

// ---------- provider-independent prompt templates ----------
// These are the instructions sent to whichever engine is active. They are deliberately NOT
// per-provider: a user's customized commit/review/analyze template must apply identically
// whether the active engine is Claude, Gemini, Codex, or a local model.

pub const DEFAULT_COMMIT_TEMPLATE: &str =
    "Write a single concise git commit message (Conventional Commits style, imperative \
     mood, summary line under 72 chars, no body) for the staged diff piped on stdin. \
     Respond with ONLY the commit message text — no quotes, no markdown, no explanation.";

pub const DEFAULT_REVIEW_PROMPT: &str =
    "Eres un revisor de código senior revisando un pull request. Se te entrega el título, la \
     descripción, el contexto del proyecto y el diff por stdin.\n\n\
     Antes que nada, en la primera línea de tu respuesta, califica el cambio completo con \
     EXACTAMENTE este formato:\n\n\
     📈 CALIDAD: Fiabilidad={A-E} Seguridad={A-E} Mantenibilidad={A-E}\n\n\
     Criterio de las notas (A = mejor, E = peor), evaluando SOLO lo que toca este diff:\n\
     - Fiabilidad: A si no hay bugs/riesgos lógicos, B si hay solo hallazgos menores, C si hay \
     advertencias, D si hay un hallazgo crítico, E si hay varios.\n\
     - Seguridad: igual criterio pero solo con hallazgos de seguridad.\n\
     - Mantenibilidad: igual criterio pero con estilo/complejidad/duplicación.\n\n\
     Luego, para cada problema real que encuentres (bugs, riesgos de seguridad, rendimiento, \
     integración, estilo importante — no inventes hallazgos triviales si el código está bien), \
     responde en Markdown con EXACTAMENTE este formato, uno por hallazgo, en este orden:\n\n\
     ### {emoji} [{Severidad} · {Tipo}] {Categoría corta} · F-{número correlativo de 3 dígitos}\n\n\
     {Un subtítulo de una línea, algo más largo que el título, describiendo el problema puntual}\n\n\
     📍 Ubicación: {ruta relativa exacta del archivo desde la raíz del repo}:{línea inicio}-{línea fin}\n\n\
     💭 Por qué: {explicación concreta del problema, citando archivo y línea/función relevante}\n\n\
     💡 Sugerencia: {qué cambiar exactamente para resolverlo}\n\n\
     🛠️ Ejemplo de solución:\n\
     ```{lenguaje}\n\
     {fragmento de código mostrando la solución concreta}\n\
     ```\n\n\
     🎯 Confianza: {0-100}/100\n\n\
     ---\n\n\
     Reglas:\n\
     - Responde SIEMPRE en español — el subtítulo, el \"Por qué\", la \"Sugerencia\" y \
     cualquier otro texto libre deben estar en español, sin importar el idioma del título, la \
     descripción del PR, el diff, o los comentarios/nombres en el código.\n\
     - Usa 🚨 para Crítico, ⚠️ para Advertencia/Mayor, ℹ️ para Menor/Sugerencia.\n\
     - Numera los hallazgos F-001, F-002, etc. en el orden en que aparecen en el diff.\n\
     - La línea \"📍 Ubicación\" es obligatoria en cada hallazgo y debe usar la ruta real del \
     archivo tal como aparece en el diff (encabezado `+++ b/...`) y el rango de línea real del \
     lado nuevo del diff — esto se usa para anclar el comentario a esa línea exacta en el PR, \
     así que no la omitas ni la inventes. Escríbela en TEXTO PLANO, sin backticks ni ningún \
     otro formato Markdown (a diferencia del resto de la respuesta, donde sí puedes usar \
     backticks para código) — el valor se parsea literalmente para ubicar el comentario.\n\
     - Sé específico y cita archivos/líneas reales del diff — no generalices.\n\
     - No repitas el diff completo ni resumas cambios que no son problemáticos.\n\
     - Si no encuentras ningún problema real, dilo brevemente en un par de líneas con ✅ después \
     de la línea de CALIDAD, sin inventar hallazgos ni usar la plantilla anterior.";

/// The default per-workspace **PR review standard** — the methodology every review follows,
/// seeded into each workspace and editable from Settings. Ported from the transversal
/// `WF-PR-REVIEWER` runbook (SonarQube-style taxonomy, A–E ratings, Quality Gate, review
/// lenses) and kept deliberately project-agnostic: it describes *how* to review, never the
/// rules of any one repository — those belong in each workspace's review contexts / MD files.
///
/// It doubles as the review prompt, so its OUTPUT FORMAT section must stay byte-compatible with
/// the frontend parser (`parseAnalysis.ts`): the leading `📈 CALIDAD:` line, the
/// `### {emoji} [{Severidad} · {Tipo}] {Categoría} · F-NNN` finding header (emoji ∈ 🚨/⚠️/ℹ️),
/// and the `📍 Ubicación` / `💭 Por qué` / `💡 Sugerencia` / `🛠️` / `🎯 Confianza` fields — those
/// anchor comments to the PR, so changing them silently breaks posting.
pub const DEFAULT_PR_REVIEW_STANDARD: &str = r#"Eres un revisor de código senior. Revisas un pull request y produces una revisión rigurosa, accionable y en ESPAÑOL. Por stdin recibes el título del PR, su descripción, el contexto de revisión del proyecto y el diff.

Este es el ESTÁNDAR DE REVISIÓN base (transversal a cualquier repositorio). Trata el "PROJECT REVIEW CONTEXT" que venga por stdin como reglas adicionales del proyecto que complementan —nunca reemplazan— este estándar.

## Lentes de revisión (revisa el diff bajo cada una)
1. Correctness — bugs de lógica, off-by-one, null/undefined, flujo de control roto, race conditions.
2. Seguridad — inyección, authn/authz, secretos en código, deserialización insegura, SSRF, path traversal, cripto débil. Marca como "Security Hotspot" el código sensible que requiere ojo humano pero no es una vuln demostrable.
3. Rendimiento — N+1, trabajo en hot paths, asincronía/concurrencia mal usada, complejidad innecesaria.
4. Contrato / integridad de datos — breaking changes de API/DTO/esquema, migraciones, validación en bordes de confianza.
5. Tests — cobertura ausente de lo que se agrega/modifica, tests tautológicos, asserts débiles.
6. Mantenibilidad — dead code, duplicación, naming confuso, complejidad, restos de debug.

## Taxonomía (estilo SonarQube)
- Tipo: uno de `Bug` (Fiabilidad) · `Vulnerabilidad` (Seguridad) · `Security Hotspot` (Seguridad) · `Code Smell` (Mantenibilidad).
- Severidad (5): `Blocker` (data loss, auth bypass, caída en prod, fuga de secretos, breaking change sin migración) · `Crítico` (bug que seguro dispara en uso normal, falta de validación en un borde real, regresión de perf en hot path) · `Mayor` (bug de edge-case, manejo de errores ausente, cambio de contrato que necesita mitigación) · `Menor` (higiene: limpieza de recursos, ruido de logs, retries) · `Info` (nitpick subjetivo).
- Confianza (0–100): 0 falso positivo/pre-existente · 25 quizá real, sin verificar · 50 real pero raro/nitpick · 75 real e impactante, muy probable en prod · 100 cierto, demostrable directo del diff.

## Qué descartar (en todos los casos)
- Lo pre-existente: mismo código ya presente en la rama destino (solo revisas lo que el diff agrega/cambia).
- Lo ya discutido en comentarios/threads del PR.
- Tipos/lint/formato: lo cubre CI. No inventes hallazgos triviales si el código está bien.

## Ratings A–E (por dimensión, según el PEOR hallazgo de esa dimensión)
A sin hallazgos · B peor=Menor · C peor=Mayor · D peor=Crítico · E peor=Blocker.
Fiabilidad ← Bugs · Seguridad ← Vulnerabilidades + Security Hotspots · Mantenibilidad ← Code Smells.

## Quality Gate
PASSED si NO hay ningún hallazgo `Blocker` ni `Crítico`; FAILED en caso contrario. Es binario (solo PASSED/FAILED). Los `Menor`/`Info` no cambian el gate.

────────────────────────────────────────────────────────
## FORMATO DE SALIDA (obligatorio y exacto)

En la PRIMERA línea de tu respuesta, califica el cambio completo con EXACTAMENTE este formato (evaluando SOLO lo que toca el diff):

📈 CALIDAD: Fiabilidad={A-E} Seguridad={A-E} Mantenibilidad={A-E}

Luego, para cada hallazgo real, responde en Markdown con EXACTAMENTE este bloque, uno por hallazgo, en este orden:

### {emoji} [{Severidad} · {Tipo}] {Categoría corta} · F-{número correlativo de 3 dígitos}

{Un subtítulo de una línea, algo más largo que el título, describiendo el problema puntual}

📍 Ubicación: {ruta relativa exacta del archivo desde la raíz del repo}:{línea inicio}-{línea fin}

💭 Por qué: {explicación concreta del problema, citando archivo y línea/función relevante; ≤ 80 palabras}

💡 Sugerencia: {qué cambiar exactamente para resolverlo}

🛠️ Ejemplo de solución:
```{lenguaje}
{fragmento de código mostrando la solución concreta}
```

🎯 Confianza: {0-100}/100

---

Reglas del formato:
- Responde SIEMPRE en español (subtítulo, "Por qué", "Sugerencia" y todo texto libre), sin importar el idioma del PR, del diff o del código.
- `{emoji}` mapea desde la severidad y debe ser EXACTAMENTE uno de estos tres: usa 🚨 para `Blocker` y `Crítico`, ⚠️ para `Mayor`, ℹ️ para `Menor` e `Info`. El `{Severidad}` dentro de los corchetes SÍ lleva el nivel fino (Blocker/Crítico/Mayor/Menor/Info).
- `{Tipo}` es uno de `Bug`/`Vulnerabilidad`/`Code Smell`/`Security Hotspot`.
- `{Categoría corta}` es un slug específico en kebab-case (p. ej. `null-dereference`, `sql-injection`, `dead-code`) — NUNCA repitas ahí la dimensión ni el tipo.
- Numera F-001, F-002, … en el orden en que los hallazgos aparecen en el diff.
- La línea "📍 Ubicación" es OBLIGATORIA en cada hallazgo y debe usar la ruta real del archivo tal como aparece en el diff (encabezado `+++ b/...`) y el rango de línea real del lado nuevo del diff — se usa para anclar el comentario a esa línea exacta en el PR. Escríbela en TEXTO PLANO, sin backticks ni Markdown (a diferencia del resto, donde sí puedes usar backticks). No la omitas ni la inventes.
- Sé específico y cita archivos/líneas reales del diff — no generalices ni repitas el diff completo.
- Ordena los hallazgos por severidad (Blocker→Info) y, dentro de cada severidad, por confianza descendente.
- Si NO encuentras ningún problema real, dilo en un par de líneas con ✅ justo después de la línea de CALIDAD, sin inventar hallazgos ni usar la plantilla de arriba."#;

pub const DEFAULT_ANALYZE_TEMPLATE: &str =
    "Eres un revisor de código senior. Se te entrega por stdin el contexto del proyecto y el \
     diff de cambios que TODAVÍA NO SE HAN COMMITEADO (working directory), justo antes de que \
     el usuario los comitee.\n\n\
     Analiza el diff buscando específicamente:\n\
     - Vulnerabilidades de seguridad (inyección, secretos hardcodeados, validación de entrada \
     faltante, uso inseguro de APIs, etc.)\n\
     - Bugs y errores lógicos\n\
     - Problemas de rendimiento\n\
     - Código que rompe las convenciones o reglas del proyecto (si se entrega contexto)\n\n\
     Antes que nada, en la primera línea de tu respuesta, califica el cambio completo con \
     EXACTAMENTE este formato:\n\n\
     📈 CALIDAD: Fiabilidad={A-E} Seguridad={A-E} Mantenibilidad={A-E}\n\n\
     Criterio de las notas (A = mejor, E = peor), evaluando SOLO lo que toca este diff:\n\
     - Fiabilidad: A si no hay bugs/riesgos lógicos, B si hay solo hallazgos menores, C si hay \
     advertencias, D si hay un hallazgo crítico, E si hay varios.\n\
     - Seguridad: igual criterio pero solo con hallazgos de seguridad.\n\
     - Mantenibilidad: igual criterio pero con estilo/complejidad/duplicación.\n\n\
     Luego, para cada problema real que encuentres, responde en Markdown con EXACTAMENTE este \
     formato, uno por hallazgo, en este orden:\n\n\
     ### {emoji} [{Severidad} · {Tipo}] {Categoría corta} · F-{número correlativo de 3 dígitos}\n\n\
     {Un subtítulo de una línea, algo más largo que el título, describiendo el problema puntual}\n\n\
     📍 Ubicación: {ruta relativa exacta del archivo desde la raíz del repo}:{línea inicio}-{línea fin}\n\n\
     💭 Por qué: {explicación concreta del problema, citando archivo y línea/función relevante}\n\n\
     💡 Sugerencia: {qué cambiar exactamente para resolverlo}\n\n\
     🛠️ Ejemplo de solución:\n\
     ```{lenguaje}\n\
     {fragmento de código mostrando la solución concreta}\n\
     ```\n\n\
     🎯 Confianza: {0-100}/100\n\n\
     ---\n\n\
     Reglas:\n\
     - Responde SIEMPRE en español, sin importar el idioma del código, nombres o comentarios.\n\
     - Usa 🚨 para Crítico, ⚠️ para Advertencia/Mayor, ℹ️ para Menor/Sugerencia.\n\
     - Numera los hallazgos F-001, F-002, etc. en el orden en que aparecen en el diff.\n\
     - La línea \"📍 Ubicación\" es obligatoria en cada hallazgo, con la ruta real del archivo y \
     el rango de línea real del lado nuevo del diff, en TEXTO PLANO sin backticks ni ningún \
     otro formato Markdown — el valor se parsea literalmente.\n\
     - Sé específico y cita archivos/líneas reales del diff — no generalices.\n\
     - No repitas el diff completo ni resumas cambios que no son problemáticos.\n\
     - Si no encuentras ningún problema real, dilo brevemente en un par de líneas con ✅ después \
     de la línea de CALIDAD, sin inventar hallazgos ni usar la plantilla anterior.";

const DEFAULT_CHAT_SYSTEM_PROMPT: &str =
    "Eres el asistente de IA integrado en CodeFlow, un cliente Git de escritorio. Estás \
     conversando con el usuario sobre el repositorio que tiene abierto — usa las herramientas \
     disponibles (leer archivos, buscar código, revisar el estado de git, etc.) cuando haga \
     falta para responder con precisión en lugar de adivinar. Responde en el mismo idioma en \
     el que te escribe el usuario. Sé conciso y directo: esto es una conversación, no un \
     reporte formal — no uses el formato de hallazgos estructurados que usarías en una revisión \
     de PR a menos que el usuario lo pida explícitamente.";

const FIX_FINDING_SYSTEM_PROMPT: &str =
    "Eres un desarrollador senior aplicando una corrección de code review directamente en el \
     repositorio abierto. Se te entrega por stdin el hallazgo específico a corregir: su \
     ubicación (archivo y línea), por qué es un problema, y la sugerencia de solución.\n\n\
     Instrucciones:\n\
     - Abre el archivo indicado y aplica el fix exactamente en esa ubicación — no toques otros \
     archivos ni código no relacionado con este hallazgo puntual.\n\
     - Sigue el estilo y las convenciones ya usadas en ese archivo/proyecto.\n\
     - NO hagas commit ni ejecutes git — limítate a modificar el/los archivo(s) en el working \
     directory; el usuario decide cuándo comitear.\n\
     - Si al mirar el código el problema ya no existe (cambió desde que se generó el hallazgo), \
     no modifiques nada y dilo brevemente.\n\
     - Responde en una o dos líneas en español confirmando qué cambiaste (o que no hiciste \
     cambios y por qué) — no repitas el diff ni el hallazgo completo.";

/// One finished AI run: the reply plus the metadata a caller may want to keep.
#[derive(Debug)]
pub struct AiRun {
    pub text: String,
    /// Session to resume on the next turn of a multi-turn conversation (chat). `None` for
    /// engines/turns that don't report one.
    pub session_id: Option<String>,
    /// Model the CLI actually ran, when it reported exactly one. `None` when the run fanned out
    /// across several models or the CLI didn't say — callers fall back to the configured setting.
    pub model: Option<String>,
}

/// One headless invocation, described in provider-neutral terms. Each [`AiEngine`] translates
/// these into its own CLI's flags in [`AiEngine::build_command`].
pub struct AiInvocation<'a> {
    /// The "ask" — passed as an argument (`-p`). The *data* goes on stdin via `stdin_content`.
    pub prompt: &'a str,
    /// Extra system instructions to append for this run, if any.
    pub system_prompt: Option<&'a str>,
    /// Model id to force; empty means "let the CLI pick its own default".
    pub model: &'a str,
    /// Raw tool names to allow — provider-specific strings, passed through verbatim.
    pub allowed_tools: &'a [String],
    /// Working directory to run in.
    pub cwd: Option<&'a str>,
    /// Path to a `--mcp-config`-style JSON file, if the workspace has MCP servers enabled.
    pub mcp_config_path: Option<&'a str>,
    /// Data piped to the process's stdin (the diff, PR context, the finding to fix, …).
    pub stdin_content: &'a str,
    /// Session id to resume, for multi-turn chat.
    pub resume_session_id: Option<&'a str>,
    /// Semantic "auto-approve file create/edit tools" flag. Each engine maps it to its own
    /// permission concept (Claude `--permission-mode acceptEdits`, Gemini `--approval-mode …`).
    /// Runs are headless (no TTY), so an interactive permission prompt can never be answered —
    /// the write-capable flows (chat, "fix with AI") set this so they can actually change files.
    pub auto_approve_edits: bool,
}

impl<'a> AiInvocation<'a> {
    /// A minimal invocation — just an ask and its stdin data — with every optional knob off.
    /// Callers set the fields they need afterward.
    pub fn new(prompt: &'a str, stdin_content: &'a str) -> Self {
        Self {
            prompt,
            system_prompt: None,
            model: "",
            allowed_tools: &[],
            cwd: None,
            mcp_config_path: None,
            stdin_content,
            resume_session_id: None,
            auto_approve_edits: false,
        }
    }
}

/// How an engine actually talks to its model. Most engines are headless CLI subprocesses; the
/// HTTP ones are the exception, so [`run`] branches on this instead of forcing them to masquerade
/// as a process. For every `Http` variant the `binary` argument threaded through
/// [`run`]/[`list_models`] carries the base URL rather than a path.
///
/// The variant is what routes the call, and it carries the credential when there is one — that
/// way engines stay stateless from the caller's point of view and no operation signature has to
/// grow an `api_key` parameter.
pub enum Transport {
    Subprocess,
    /// A local Ollama server — no credential.
    Ollama,
    /// Any endpoint speaking OpenAI's `/v1/chat/completions`: OpenAI itself, Azure OpenAI,
    /// OpenRouter, Groq, a local vLLM… Only the base URL and key differ.
    OpenAiCompatible { api_key: String },
}

/// A headless AI CLI. Implementors describe how to launch their binary and how to read its
/// output; everything else (spawning, piping stdin, quota handling) is shared in [`run`].
pub trait AiEngine: Send + Sync {
    /// Human label for footers and the chat chip, e.g. `"Claude Code"`.
    fn label(&self) -> &'static str;
    /// Binary to run when the user hasn't configured a path.
    fn default_binary(&self) -> &'static str;
    /// Fast/cheap model for mechanical tasks (commit messages), regardless of the configured
    /// review model. Empty means "let the CLI pick".
    fn commit_message_model(&self) -> &'static str;
    /// The write-access tool set for "fix with AI" — provider-specific tool names. This is fixed
    /// per engine (not user-configurable): clicking "fix" is itself the write opt-in.
    fn fix_tools(&self) -> Vec<String>;
    /// Build the CLI command for one invocation. `binary` is the resolved path; the caller adds
    /// the stdio pipes and `PATH`, so implementors only set args + working directory.
    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command;
    /// Turn a finished run into its reply (plus session/model) or a user-facing error. `success`
    /// is the process exit status; `stdout`/`stderr` are lossy-UTF-8 decoded.
    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String>;
    /// CLI args that make the binary print its available models, one id per line — or `None` if the
    /// CLI has no such command, in which case the frontend falls back to a curated list. This is
    /// how the model picker shows what's *actually* installed/configured rather than a hardcoded
    /// guess. opencode has `opencode models`; the Claude/Gemini CLIs don't expose a stable
    /// machine-readable list, so they stay `None`.
    fn list_models_args(&self) -> Option<Vec<String>> {
        None
    }

    /// Turns the stdout of [`AiEngine::list_models_args`] into model ids.
    ///
    /// The default is one id per line, which is what `opencode models` and `agy models` print. An
    /// engine whose listing is written for humans rather than for scripts overrides this — `grok
    /// models` reports "Available models:" and a bulleted list, and taking that verbatim would put
    /// three sentences in the model picker.
    fn parse_models(&self, stdout: &str) -> Vec<String> {
        stdout
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    }

    /// Models this engine can enumerate *without running anything* — typically from a catalog its
    /// CLI already keeps on disk. Checked before [`AiEngine::list_models_args`], so an engine with
    /// no listing subcommand can still offer a current list.
    fn cached_models(&self) -> Option<Vec<String>> {
        None
    }

    /// How this engine reaches its model. Defaults to a CLI subprocess; only the local Ollama
    /// engine overrides this to [`Transport::Http`].
    fn transport(&self) -> Transport {
        Transport::Subprocess
    }

    /// Whether this engine can run an agentic tool loop (read/edit/write files, MCP). The CLI
    /// engines can; a plain local completion model (Ollama) cannot, so the "fix with AI" and MCP
    /// features are hidden for it in the UI and refused defensively in the backend.
    fn agentic(&self) -> bool {
        true
    }

    /// What gets piped to the process's stdin. Defaults to the invocation's data payload, which is
    /// what every engine that takes its instructions as arguments wants. An engine whose CLI can't
    /// safely receive a multi-line argument (npm `.cmd` shims reject them) overrides this to send
    /// the whole brief — system prompt, ask and data — down the pipe instead.
    fn stdin_payload(&self, inv: &AiInvocation) -> String {
        inv.stdin_content.to_string()
    }

    /// Whether the engine carries a conversation forward on its own side between turns (the CLIs'
    /// `--resume` / `--continue` sessions). Ollama doesn't — each HTTP request stands alone — so
    /// [`chat_with_repo`] re-sends the system prompt and project context on every turn for it,
    /// instead of only on the first.
    fn resumes_sessions(&self) -> bool {
        true
    }
}

/// Resolves the engine for a provider id. Unknown/empty ids fall back to Claude so a corrupt or
/// missing `ai_provider` setting can never leave the app with no working engine.
pub fn engine_for(provider: &str) -> Box<dyn AiEngine> {
    match provider {
        "gemini" => Box::new(crate::gemini::GeminiEngine),
        "grok" => Box::new(crate::grok::GrokEngine),
        "opencode" => Box::new(crate::opencode::OpenCodeEngine),
        "codex" => Box::new(crate::codex::CodexEngine),
        "ollama" | "local" => Box::new(crate::ollama::OllamaEngine),
        // The key is read here, from the OS keyring, so it rides along in the engine's transport
        // and no operation signature needs an extra parameter for it.
        "openai" => Box::new(crate::openai::OpenAiEngine {
            api_key: crate::secrets::get_secret(&crate::secrets::ai_api_key("openai"))
                .ok()
                .flatten()
                .unwrap_or_default(),
        }),
        _ => Box::new(crate::claude::ClaudeEngine),
    }
}

/// The directories the AI CLI installers drop their binaries in — prepended to `PATH` (and
/// searched by [`resolve_binary`]) so a bare `claude`/`gemini`/`opencode` resolves regardless of
/// how the app inherited its environment. On macOS a GUI app launched from Finder gets launchd's
/// minimal `PATH`; on Windows an app already running when the CLI was installed keeps the stale
/// pre-install `PATH`. An absolute `binary_path` set in Settings ignores all this and is unaffected.
#[cfg(not(target_os = "windows"))]
fn install_dirs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".claude/local"));
        dirs.push(home.join(".opencode/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join("Library/pnpm"));
        dirs.push(home.join(".npm-global/bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

#[cfg(target_os = "windows")]
fn install_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local").join("bin")); // native installer (Claude)
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join(".opencode").join("bin")); // opencode install script
    }
    // npm global bin on Windows is `%APPDATA%\npm` (dirs::data_dir() == Roaming AppData).
    if let Some(appdata) = dirs::data_dir() {
        dirs.push(appdata.join("npm"));
    }
    if let Some(local) = dirs::data_local_dir() {
        // Antigravity CLI (`agy`) installs to `%LOCALAPPDATA%\agy\bin`.
        dirs.push(local.join("agy").join("bin"));
        // The Codex desktop app ships the CLI here and does *not* put it on `PATH`, so without
        // this entry a perfectly working install still probes as "not found".
        dirs.push(local.join("Programs").join("OpenAI").join("Codex").join("bin"));
    }
    dirs
}

/// The install dirs followed by the process's current `PATH` — the ordered search space for both
/// setting the child's `PATH` and resolving the program name.
fn search_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = install_dirs();
    if let Some(current) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&current));
    }
    dirs
}

fn apply_path(cmd: &mut Command, dirs: &[std::path::PathBuf]) {
    if let Ok(joined) = std::env::join_paths(dirs) {
        cmd.env("PATH", joined);
    }
}

/// Non-Windows: nothing to resolve — the child's augmented `PATH` finds the binary and Unix has no
/// executable-extension quirk.
#[cfg(not(target_os = "windows"))]
fn resolve_binary(binary: &str, _dirs: &[std::path::PathBuf]) -> String {
    binary.to_string()
}

/// Windows: turn a bare command name into a full path *including its extension*. `CreateProcess`
/// (what `Command` uses) only auto-appends `.exe`, so a Node CLI installed as a `<name>.cmd` shim —
/// which is how `opencode` and `gemini` land when installed via npm — is invisible to a bare
/// `Command::new("opencode")`, and being a batch file can't be executed directly anyway. Resolving
/// to the full `.cmd` path lets `std::process::Command` route it through `cmd.exe` with correct
/// argument escaping (Rust ≥1.77). A real `.exe` (e.g. Claude's native installer) is preferred over
/// the `.cmd`/`.bat` shim. A name that already has a path separator or extension is trusted as-is.
#[cfg(target_os = "windows")]
fn resolve_binary(binary: &str, dirs: &[std::path::PathBuf]) -> String {
    use std::path::Path;
    if binary.contains('/') || binary.contains('\\') || Path::new(binary).extension().is_some() {
        return binary.to_string();
    }
    for dir in dirs {
        for ext in ["exe", "cmd", "bat"] {
            let candidate = dir.join(format!("{binary}.{ext}"));
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    binary.to_string()
}

/// Locates `binary` the same way [`run`] will: an explicit path is checked as-is, a bare name is
/// looked up across the install dirs and `PATH` (trying Windows' executable extensions, since the
/// npm-installed CLIs land as `.cmd` shims). `None` means launching it would fail.
fn find_on_path(binary: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(binary);
    if path.is_absolute() || binary.contains('/') || binary.contains('\\') {
        return path.is_file().then(|| path.to_path_buf());
    }
    #[cfg(target_os = "windows")]
    let extensions: &[&str] = &["exe", "cmd", "bat", ""];
    #[cfg(not(target_os = "windows"))]
    let extensions: &[&str] = &[""];

    for dir in search_dirs() {
        for ext in extensions {
            let candidate = if ext.is_empty() { dir.join(binary) } else { dir.join(format!("{binary}.{ext}")) };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Whether a provider is usable *right now*, for the Settings "available / not found" badge.
/// Subprocess engines are checked by locating their binary; the HTTP engine by asking its endpoint
/// for models. `detail` is the resolved path (or endpoint) when available, and a short raw reason
/// when not — the frontend wraps it in a translated label rather than showing it bare.
pub async fn probe(engine: &dyn AiEngine, binary: &str) -> (bool, String) {
    match engine.transport() {
        Transport::Ollama => match crate::ollama::fetch_tags(binary).await {
            Ok(models) => (true, format!("{} · {} modelos", binary, models.len())),
            Err(e) => (false, e),
        },
        Transport::OpenAiCompatible { api_key } => {
            if api_key.trim().is_empty() {
                return (false, "missing-api-key".to_string());
            }
            match crate::openai::fetch_models(binary, &api_key).await {
                Ok(models) => (true, format!("{} · {} modelos", binary, models.len())),
                Err(e) => (false, e),
            }
        }
        Transport::Subprocess => match find_on_path(binary) {
            Some(path) => (true, path.to_string_lossy().into_owned()),
            None => (false, binary.to_string()),
        },
    }
}

/// Drains one of the child's pipes: accumulates the raw bytes for the engine's own interpreter
/// while streaming complete lines to the frontend as they arrive.
///
/// Bytes rather than a `String` accumulator on purpose — a multi-byte character split across two
/// `read` calls would decode into replacement characters if each chunk were decoded on its own,
/// silently corrupting the very output an engine is about to parse. Line splitting happens on the
/// byte buffer for the same reason: each emitted line is a complete byte sequence.
async fn pump<R: tokio::io::AsyncRead + Unpin>(
    pipe: Option<R>,
    stream: &'static str,
    ctx: Option<RunCtx>,
) -> Vec<u8> {
    let mut collected: Vec<u8> = Vec::new();
    let Some(mut pipe) = pipe else { return collected };

    let mut buf = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let read = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        collected.extend_from_slice(&buf[..read]);
        let Some(ctx) = &ctx else { continue };

        pending.extend_from_slice(&buf[..read]);
        while let Some(idx) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=idx).collect();
            ai_runs::emit_line(ctx, stream, &strip_ansi(&String::from_utf8_lossy(&line)));
        }
        // A CLI drawing a progress bar rewrites one line forever with `\r` and never sends a
        // newline; without this the buffer would grow unbounded and the user would see nothing.
        if pending.len() > 8192 {
            ai_runs::emit_line(ctx, stream, &strip_ansi(&String::from_utf8_lossy(&pending)));
            pending.clear();
        }
    }
    if let Some(ctx) = &ctx {
        if !pending.is_empty() {
            ai_runs::emit_line(ctx, stream, &strip_ansi(&String::from_utf8_lossy(&pending)));
        }
    }
    collected
}

/// Shared subprocess plumbing for every headless AI invocation: builds the engine's command,
/// pipes `stdin_content` in, streams its output while it runs, and hands the result back to the
/// engine to interpret. Cancellable at any point when the caller wrapped this in
/// [`ai_runs::scoped`].
async fn run(engine: &dyn AiEngine, binary: &str, inv: AiInvocation<'_>) -> Result<AiRun, String> {
    let ctx = ai_runs::current();
    let mut cancel = ctx.as_ref().and_then(|c| ai_runs::subscribe(&c.run_id));

    // HTTP engines don't spawn a process — `binary` is the base URL. Everything below (binary
    // resolution, PATH, stdin piping) is subprocess-only, so hand off before any of it. They get
    // no live output (a single request answers all at once) but they do get cancellation, by
    // dropping the in-flight request.
    match engine.transport() {
        Transport::Ollama => {
            return tokio::select! {
                result = crate::ollama::complete(binary, &inv) => mark_quota(result),
                _ = ai_runs::cancelled(&mut cancel) => Err(ai_runs::CANCELLED_MARKER.to_string()),
            }
        }
        Transport::OpenAiCompatible { api_key } => {
            return tokio::select! {
                result = crate::openai::complete(binary, &api_key, &inv) => mark_quota(result),
                _ = ai_runs::cancelled(&mut cancel) => Err(ai_runs::CANCELLED_MARKER.to_string()),
            }
        }
        Transport::Subprocess => {}
    }

    let dirs = search_dirs();
    let program = resolve_binary(binary, &dirs);
    let mut cmd = engine.build_command(&program, &inv);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_path(&mut cmd, &dirs);
    // The engines build their own `Command`, so the no-console-window flag is applied here —
    // the one place every engine's command passes through on its way to being spawned.
    crate::proc::hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch '{binary}': {e}"))?;

    // Feed stdin from a separate task, concurrently with waiting for the output, for two reasons:
    // (1) an engine that *ignores* stdin (opencode delivers its payload via `--file` instead)
    //     would otherwise deadlock — once the OS pipe buffer fills, an inline `write_all().await`
    //     never completes because nothing drains it, and we'd never reach `wait_with_output`. Here
    //     the write just fails with `BrokenPipe` when the child exits, which we ignore.
    // (2) an engine that *does* read stdin still needs EOF to start producing output — dropping the
    //     handle at the end of the task sends it. Doing both concurrently is correct either way.
    let stdin_content = engine.stdin_payload(&inv);
    let mut stdin_handle = child.stdin.take();
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin_handle.take() {
            let _ = stdin.write_all(stdin_content.as_bytes()).await;
            // `stdin` drops here → EOF.
        }
    });

    // Both pipes are drained concurrently with the wait: reading them only after the process
    // exits would deadlock any CLI whose output outgrows the OS pipe buffer, and there'd be
    // nothing to stream in the meantime.
    let stdout_task = tokio::spawn(pump(child.stdout.take(), "stdout", ctx.clone()));
    let stderr_task = tokio::spawn(pump(child.stderr.take(), "stderr", ctx.clone()));

    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| e.to_string())?,
        _ = ai_runs::cancelled(&mut cancel) => {
            ai_runs::kill_tree(&mut child).await;
            // The pumps end on their own once the pipes close with the process; awaiting them
            // keeps the tasks from outliving the run and emitting into a finished one.
            let _ = tokio::join!(stdout_task, stderr_task, writer);
            return Err(ai_runs::CANCELLED_MARKER.to_string());
        }
    };

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    let _ = writer.await;
    // Stripped here rather than per-engine: every CLI colourizes, and no interpreter wants to see
    // escape bytes — least of all the UI, which would render them as literal `[91m` noise.
    engine.interpret(
        status.success(),
        &status.to_string(),
        &strip_ansi(&String::from_utf8_lossy(&stdout)),
        &strip_ansi(&String::from_utf8_lossy(&stderr)),
    )
}

/// Runs a quick, read-only auxiliary CLI command (e.g. listing models) and captures its output,
/// reusing [`run`]'s binary resolution + `PATH` augmentation. No stdin plumbing — this isn't for
/// model invocations, just for asking the CLI about itself.
async fn capture(binary: &str, args: &[String]) -> Result<std::process::Output, String> {
    let dirs = search_dirs();
    let program = resolve_binary(binary, &dirs);
    let mut cmd = crate::proc::command(&program);
    cmd.args(args);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    apply_path(&mut cmd, &dirs);
    cmd.output().await.map_err(|e| format!("failed to launch '{binary}': {e}"))
}

/// Lists the models the engine's CLI reports as available (one id per line). Returns an empty list
/// for engines with no listing command ([`AiEngine::list_models_args`] is `None`) — no process is
/// spawned in that case — so the frontend can fall back to its curated per-provider list.
pub async fn list_models(engine: &dyn AiEngine, binary: &str) -> Result<Vec<String>, String> {
    // The HTTP engines list over their own API, not via a CLI subcommand.
    match engine.transport() {
        Transport::Ollama => return crate::ollama::list_models(binary).await,
        Transport::OpenAiCompatible { api_key } => return crate::openai::list_models(binary, &api_key).await,
        Transport::Subprocess => {}
    }
    // A catalog the CLI already wrote to disk beats spawning it (and is the only option for CLIs
    // with no listing subcommand).
    if let Some(models) = engine.cached_models() {
        return Ok(models);
    }
    let Some(args) = engine.list_models_args() else {
        return Ok(Vec::new());
    };
    let output = capture(binary, &args).await?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        return Err(format!(
            "'{binary} {}' failed: {}",
            args.join(" "),
            if detail.is_empty() { "no output" } else { detail }
        ));
    }
    Ok(engine.parse_models(&String::from_utf8_lossy(&output.stdout)))
}

/// The engine CLI's own version — what a chat turn records next to its model, so "which build
/// answered this?" is still answerable in a conversation reopened weeks later.
///
/// Cached per binary for the life of the process: otherwise every chat turn would pay for an
/// extra process spawn, and a CLI doesn't change version underneath a running app. A failed probe
/// is cached too (as `None`), so a missing/older binary isn't re-spawned on every message. HTTP
/// engines have no CLI to ask, so they report `None` and the stamp simply omits the version.
pub async fn engine_version(engine: &dyn AiEngine, binary: &str) -> Option<String> {
    if !matches!(engine.transport(), Transport::Subprocess) {
        return None;
    }
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(binary).cloned()) {
        return hit;
    }

    let version = match capture(binary, &["--version".to_string()]).await {
        // Not every CLI prints its banner on stdout, so stderr is the second place to look.
        Ok(out) if out.status.success() => parse_version(&strip_ansi(&String::from_utf8_lossy(&out.stdout)))
            .or_else(|| parse_version(&strip_ansi(&String::from_utf8_lossy(&out.stderr)))),
        _ => None,
    };
    if let Ok(mut c) = cache.lock() {
        c.insert(binary.to_string(), version.clone());
    }
    version
}

/// Pulls the version out of a `--version` banner. The CLIs disagree on shape — a bare `2.0.14`,
/// `2.0.14 (Claude Code)`, `codex-cli 0.20.0` — so the first dotted-numeric token wins and the
/// whole first line is the fallback for anything that doesn't look like one.
fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().map(str::trim).find(|l| !l.is_empty())?;
    let token = line
        .split_whitespace()
        .find(|t| {
            let core = t.trim_start_matches('v');
            core.contains('.') && core.starts_with(|c: char| c.is_ascii_digit())
        })
        .unwrap_or(line);
    // Capped: the fallback is an arbitrary banner line, and this ends up in a one-line stamp
    // under a chat bubble.
    let value: String = token.trim_start_matches('v').trim().chars().take(40).collect();
    (!value.is_empty()).then_some(value)
}

/// The engine can't reliably know the real wall-clock time or which model string it was actually
/// launched with, so the app stamps this footer on itself rather than asking the prompt to
/// fabricate it. `label` is the engine's display name (e.g. "Claude Code" / "Gemini").
fn stamp_footer(body: &str, kind: &str, label: &str, model: &str) -> String {
    let model_label = if model.trim().is_empty() { "modelo predeterminado" } else { model };
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
    format!("{body}\n\n---\n🤖 Análisis automatizado ({kind}) · {label} ({model_label}) · {timestamp}")
}

pub const DEFAULT_PR_DESCRIPTION_TEMPLATE: &str =
    "Eres un desarrollador experimentado redactando la descripción de un pull request. Se te \
     entrega la rama origen, la rama destino y el diff por stdin.\n\n\
     Devuelve EXACTAMENTE este formato, empezando por la línea del título:\n\n\
     TITLE: {un título conciso en imperativo, estilo Conventional Commits, máximo 72 caracteres}\n\n\
     ## Resumen\n\
     {1-3 frases explicando qué hace este PR y por qué}\n\n\
     ## Cambios\n\
     - {un punto por cada cambio relevante del diff}\n\n\
     ## Notas\n\
     {riesgos, pendientes o consideraciones para el revisor; escribe \"Ninguna\" si no hay}\n\n\
     Reglas:\n\
     - Responde SIEMPRE en español.\n\
     - Básate ÚNICAMENTE en el diff; no inventes cambios que no aparezcan.\n\
     - La primera línea DEBE empezar con \"TITLE: \" seguido del título.\n\
     - No incluyas el diff crudo ni bloques de código salvo que sean imprescindibles.\n\
     - Responde solo con la descripción, sin texto adicional antes o después.";

pub const DEFAULT_RESOLVE_CONFLICT_TEMPLATE: &str =
    "Eres un ingeniero de software resolviendo un conflicto de merge de git. Se te entregan por \
     stdin tres versiones de un mismo archivo: BASE (el ancestro común), OURS (la rama actual) y \
     THEIRS (la rama entrante).\n\n\
     Tu tarea: producir el contenido final del archivo integrando de forma coherente los cambios \
     de ambos lados (OURS y THEIRS) y preservando la intención de cada uno. Usa BASE para entender \
     qué cambió cada lado respecto al original.\n\n\
     Reglas ESTRICTAS de salida:\n\
     - Responde ÚNICAMENTE con el contenido COMPLETO del archivo ya resuelto.\n\
     - NO incluyas marcadores de conflicto (<<<<<<<, =======, >>>>>>>).\n\
     - NO envuelvas la respuesta en bloques de código markdown (```), ni añadas explicaciones, \
     comentarios ni texto antes o después del contenido.\n\
     - Conserva el estilo, la indentación y el formato del archivo.\n\
     - Si ambos lados hacen cambios compatibles, inclúyelos ambos; si son incompatibles, elige la \
     integración más razonable sin perder funcionalidad.";

pub const DEFAULT_INLINE_EDIT_PROMPT: &str =
    "Eres un programador editando un fragmento de código dentro de un archivo. Por stdin recibes \
     el archivo completo como contexto, el fragmento seleccionado y la instrucción del usuario.\n\n\
     Tu tarea: devolver el fragmento seleccionado reescrito según la instrucción.\n\n\
     Reglas ESTRICTAS de salida:\n\
     - Responde ÚNICAMENTE con el código que reemplaza al fragmento seleccionado.\n\
     - NO devuelvas el archivo completo, solo el fragmento reescrito.\n\
     - NO uses bloques de código markdown (```) ni añadas explicaciones antes o después.\n\
     - Conserva la indentación, el estilo y el lenguaje del archivo.\n\
     - Si la instrucción no se puede aplicar, devuelve el fragmento original sin cambios.";

/// Rewrites the selected fragment of a file according to a natural-language instruction — the
/// editor's inline edit. Text-in/text-out on purpose: no tools, no file writes, so it works with
/// every provider (a local Ollama model included) and the result lands in the editor's buffer as
/// a normal, undoable edit rather than as a change made behind the user's back.
pub async fn inline_edit(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    file_path: &str,
    file_content: &str,
    selection: &str,
    instruction: &str,
) -> Result<String, String> {
    if selection.trim().is_empty() {
        return Err("No hay código seleccionado para editar".to_string());
    }
    let context: String = file_content.chars().take(MAX_DIFF_CHARS).collect();
    let stdin_payload = format!(
        "ARCHIVO: {file_path}\n\n\
         === CONTENIDO DEL ARCHIVO (contexto) ===\n{context}\n\n\
         === FRAGMENTO SELECCIONADO ===\n{selection}\n\n\
         === INSTRUCCIÓN ===\n{instruction}"
    );

    let mut inv = AiInvocation::new("Reescribe el fragmento seleccionado según la instrucción.", &stdin_payload);
    inv.system_prompt = Some(DEFAULT_INLINE_EDIT_PROMPT);
    inv.model = model;
    let run = run(engine, binary, inv).await?;
    Ok(strip_code_fence(&run.text))
}

/// Some models wrap their answer in a ```lang fence despite being told not to — strip a single
/// outer fence so what gets written to disk is the raw file content.
fn strip_code_fence(text: &str) -> String {
    let t = text.trim();
    if !t.starts_with("```") {
        return t.to_string();
    }
    let after_open = match t.find('\n') {
        Some(nl) => &t[nl + 1..],
        None => return String::new(),
    };
    let body = after_open.trim_end().strip_suffix("```").unwrap_or(after_open);
    body.trim_end().to_string()
}

// ---------- high-level, provider-neutral operations ----------

pub async fn generate_commit_message(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    diff: &str,
    prompt_template: &str,
) -> Result<String, String> {
    if diff.trim().is_empty() {
        return Err("No staged changes to summarize".to_string());
    }

    let truncated: String = diff.chars().take(MAX_DIFF_CHARS).collect();
    let prompt = if prompt_template.trim().is_empty() {
        DEFAULT_COMMIT_TEMPLATE
    } else {
        prompt_template
    };

    let mut inv = AiInvocation::new(prompt, &truncated);
    // `model` is resolved by the caller: the user's per-task commit override, or the engine's
    // fast model ([`AiEngine::commit_message_model`]) when they haven't set one.
    inv.model = model;
    let run = run(engine, binary, inv).await?;
    Ok(run.text)
}

/// Drafts a pull-request description from the diff between two branches, with the active engine.
/// Returns the raw model text (a `TITLE:` line followed by a Markdown body) — the command layer
/// splits it into title/body. No footer is stamped: this text goes straight into a PR field.
pub async fn generate_pr_description(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    source_branch: &str,
    target_branch: &str,
    diff_text: &str,
    prompt_template: &str,
) -> Result<String, String> {
    if diff_text.trim().is_empty() {
        return Err("No hay diferencias entre las ramas para describir".to_string());
    }

    let truncated: String = diff_text.chars().take(MAX_REVIEW_DIFF_CHARS).collect();
    let stdin_payload =
        format!("RAMA ORIGEN: {source_branch}\nRAMA DESTINO: {target_branch}\n\nDIFF:\n{truncated}");

    let prompt = if prompt_template.trim().is_empty() {
        DEFAULT_PR_DESCRIPTION_TEMPLATE
    } else {
        prompt_template
    };

    let mut inv = AiInvocation::new(prompt, &stdin_payload);
    inv.model = model;
    let run = run(engine, binary, inv).await?;
    Ok(run.text)
}

/// Proposes a merged version of a conflicted file from its base/ours/theirs versions. Returns the
/// full resolved file content (conflict markers and any wrapping code fence stripped) — the caller
/// writes it to disk only after the user accepts.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_conflict(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    file_path: &str,
    base: &str,
    ours: &str,
    theirs: &str,
    prompt_template: &str,
) -> Result<String, String> {
    let cap = |s: &str| -> String { s.chars().take(MAX_CONFLICT_SIDE_CHARS).collect() };
    let stdin_payload = format!(
        "ARCHIVO: {file_path}\n\n\
         === BASE (ancestro común) ===\n{}\n\n\
         === OURS (rama actual) ===\n{}\n\n\
         === THEIRS (rama entrante) ===\n{}",
        cap(base),
        cap(ours),
        cap(theirs),
    );

    let prompt = if prompt_template.trim().is_empty() {
        DEFAULT_RESOLVE_CONFLICT_TEMPLATE
    } else {
        prompt_template
    };

    let mut inv = AiInvocation::new(prompt, &stdin_payload);
    inv.model = model;
    let run = run(engine, binary, inv).await?;
    Ok(strip_code_fence(&run.text))
}

/// Reviews a pull request's diff with the active engine, folding in the workspace's enabled
/// review contexts/MD instructions as extra background. Returns a Markdown review body —
/// nothing gets posted to the VCS host here, that's a separate explicit step.
/// The depth directive appended to the review prompt for the chosen level — confidence threshold,
/// which severities survive, and how much to report. Mirrors the WF-PR-REVIEWER level rules
/// (report-standard §2). Unknown/empty levels fall back to `completo`.
fn review_level_directive(level: &str) -> &'static str {
    match level {
        "basico" | "básico" => "## NIVEL DE REVISIÓN ACTIVO: básico\n\
            Triage rápido. Reporta SOLO hallazgos con confianza ≥ 75 y severidad Blocker o Crítico. \
            Ignora Mayor/Menor/Info. Sé breve: no listes nada que no sea un bloqueante real de alta \
            confianza. Si no hay Blocker/Crítico de alta confianza, dilo con ✅ tras la línea de CALIDAD.",
        "ultra" => "## NIVEL DE REVISIÓN ACTIVO: ultra\n\
            Revisión exhaustiva. Aplica las 6 lentes (incluida mantenibilidad a fondo). Reporta \
            hallazgos con confianza ≥ 50 e INCLUYE Info/nitpicks. Lee el método completo alrededor \
            de cada cambio antes de concluir; prioriza precisión sobre brevedad.",
        _ => "## NIVEL DE REVISIÓN ACTIVO: completo\n\
            Revisión a fondo con las 5 lentes principales. Reporta hallazgos con confianza ≥ 60 \
            (los Blocker con ≥ 50). Incluye Blocker/Crítico/Mayor/Menor; omite los Info salvo que \
            sean claramente útiles. No inventes hallazgos triviales si el código está bien.",
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn review_pull_request(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    pr_title: &str,
    pr_description: &str,
    contexts: &[(String, String)],
    diff_text: &str,
    allowed_tools: &[String],
    cwd: &str,
    prompt_template: &str,
    level: &str,
    mcp_config_path: Option<&str>,
) -> Result<String, String> {
    if diff_text.trim().is_empty() {
        return Err("This pull request has no changes to review".to_string());
    }

    let truncated: String = diff_text.chars().take(MAX_REVIEW_DIFF_CHARS).collect();
    let description = if pr_description.trim().is_empty() {
        "(no description)"
    } else {
        pr_description
    };

    let mut stdin_payload = format!("PR TITLE: {pr_title}\n\nPR DESCRIPTION:\n{description}\n\n");
    if !contexts.is_empty() {
        stdin_payload.push_str("PROJECT REVIEW CONTEXT:\n");
        for (name, content) in contexts {
            stdin_payload.push_str(&format!("- {name}: {content}\n"));
        }
        stdin_payload.push('\n');
    }
    stdin_payload.push_str("DIFF:\n");
    stdin_payload.push_str(&truncated);

    let base_prompt = if prompt_template.trim().is_empty() {
        DEFAULT_REVIEW_PROMPT
    } else {
        prompt_template
    };
    // The level directive rides at the end of the prompt so it overrides any default depth the
    // standard implies — the standard describes the method, the level tunes how deep/strict.
    let prompt = format!("{base_prompt}\n\n{}", review_level_directive(level));

    let mut inv = AiInvocation::new(&prompt, &stdin_payload);
    inv.model = model;
    inv.allowed_tools = allowed_tools;
    inv.cwd = Some(cwd);
    inv.mcp_config_path = mcp_config_path;
    let run = run(engine, binary, inv).await?;
    // Prefer what the CLI reports it actually ran over what was configured — they differ
    // whenever `model` is empty and the CLI picked its own default.
    Ok(stamp_footer(&run.text, "pr-review", engine.label(), run.model.as_deref().unwrap_or(model)))
}

/// Scans the working directory's not-yet-committed diff for bugs/vulnerabilities/perf issues
/// before the user commits — same idea as `review_pull_request` but scoped to local changes.
#[allow(clippy::too_many_arguments)]
pub async fn analyze_changes(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    contexts: &[(String, String)],
    diff_text: &str,
    allowed_tools: &[String],
    cwd: &str,
    prompt_template: &str,
    mcp_config_path: Option<&str>,
) -> Result<String, String> {
    if diff_text.trim().is_empty() {
        return Err("No hay cambios sin commitear para analizar".to_string());
    }

    let truncated: String = diff_text.chars().take(MAX_REVIEW_DIFF_CHARS).collect();

    let mut stdin_payload = String::new();
    if !contexts.is_empty() {
        stdin_payload.push_str("PROJECT CONTEXT:\n");
        for (name, content) in contexts {
            stdin_payload.push_str(&format!("- {name}: {content}\n"));
        }
        stdin_payload.push('\n');
    }
    stdin_payload.push_str("DIFF:\n");
    stdin_payload.push_str(&truncated);

    let prompt = if prompt_template.trim().is_empty() {
        DEFAULT_ANALYZE_TEMPLATE
    } else {
        prompt_template
    };

    let mut inv = AiInvocation::new(prompt, &stdin_payload);
    inv.model = model;
    inv.allowed_tools = allowed_tools;
    inv.cwd = Some(cwd);
    inv.mcp_config_path = mcp_config_path;
    let run = run(engine, binary, inv).await?;
    Ok(stamp_footer(&run.text, "análisis pre-commit", engine.label(), run.model.as_deref().unwrap_or(model)))
}

/// Open-ended, multi-turn chat about the currently open repository — unlike review/analyze this
/// isn't a one-shot call, so it resumes the same CLI session across turns (via `session_id`)
/// instead of re-explaining the whole conversation each message.
#[allow(clippy::too_many_arguments)]
pub async fn chat_with_repo(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    contexts: &[(String, String)],
    message: &str,
    session_id: Option<&str>,
    allowed_tools: &[String],
    cwd: &str,
    mcp_config_path: Option<&str>,
) -> Result<AiRun, String> {
    // Project context and the system prompt only need to be established once — a resumed session
    // already carries the earlier turns forward. `-p` carries the user's actual message; stdin
    // is just the one-time context (stdin = data, `-p` = ask). An engine that doesn't resume
    // sessions server-side (Ollama) has nothing carrying them forward, so it gets them every turn.
    let needs_context = session_id.is_none() || !engine.resumes_sessions();
    let mut stdin_payload = String::new();
    if needs_context && !contexts.is_empty() {
        stdin_payload.push_str("PROJECT CONTEXT:\n");
        for (name, content) in contexts {
            stdin_payload.push_str(&format!("- {name}: {content}\n"));
        }
    }

    let system_prompt = if needs_context { Some(DEFAULT_CHAT_SYSTEM_PROMPT) } else { None };

    let mut inv = AiInvocation::new(message, &stdin_payload);
    inv.system_prompt = system_prompt;
    inv.model = model;
    inv.allowed_tools = allowed_tools;
    inv.cwd = Some(cwd);
    inv.mcp_config_path = mcp_config_path;
    inv.resume_session_id = session_id;
    // The chat is meant to help work on the repo, so let it create/edit files without an
    // (unanswerable, headless) permission prompt. Running commands still needs the shell tool
    // enabled in Settings.
    inv.auto_approve_edits = true;
    run(engine, binary, inv).await
}

/// Applies a single code-review finding's fix directly to the working tree. Unlike the read-only
/// review/analyze/chat flows, this needs write access, so it always runs with the engine's fixed
/// write-capable tool set regardless of the user's general `allowedTools` setting — clicking
/// "fix with AI" is itself the write-access opt-in for this one action.
pub async fn apply_finding_fix(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    finding_prompt: &str,
    cwd: &str,
) -> Result<String, String> {
    // Defensive: the UI hides "fix with AI" for non-agentic providers, but never let a local model
    // silently "fix" nothing (it has no write tools) if the command is reached some other way.
    if !engine.agentic() {
        return Err(
            "Este proveedor local no puede aplicar cambios automáticamente. Usa Claude, Gemini u Open Code para \"Corregir con IA\".".to_string(),
        );
    }
    let tools = engine.fix_tools();
    let mut inv = AiInvocation::new("Aplica la corrección para el hallazgo entregado por stdin.", finding_prompt);
    inv.system_prompt = Some(FIX_FINDING_SYSTEM_PROMPT);
    inv.model = model;
    inv.allowed_tools = &tools;
    inv.cwd = Some(cwd);
    inv.auto_approve_edits = true;
    let run = run(engine, binary, inv).await?;
    Ok(run.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_colour_codes_from_a_cli_error() {
        let raw = "\u{1b}[0m\u{1b}[91m\u{1b}[1mError: \u{1b}[0mInsufficient balance.";
        assert_eq!(strip_ansi(raw), "Error: Insufficient balance.");
    }

    #[test]
    fn strips_osc_hyperlink_sequences() {
        let raw = "see \u{1b}]8;;https://example.com\u{7}the docs\u{1b}]8;;\u{7}";
        assert_eq!(strip_ansi(raw), "see the docs");
    }

    #[test]
    fn leaves_ordinary_text_untouched() {
        assert_eq!(strip_ansi("feat: add thing [skip ci]"), "feat: add thing [skip ci]");
    }

    /// The four `--version` shapes the supported CLIs actually print. The `v` prefix and the
    /// surrounding words are noise; the number is the only part worth stamping on a chat turn.
    #[test]
    fn reads_the_version_out_of_each_cli_banner() {
        assert_eq!(parse_version("2.0.14 (Claude Code)").as_deref(), Some("2.0.14"));
        assert_eq!(parse_version("codex-cli 0.20.0\n").as_deref(), Some("0.20.0"));
        assert_eq!(parse_version("v1.4.2").as_deref(), Some("1.4.2"));
        assert_eq!(parse_version("\n  0.9.1  \nsecond line").as_deref(), Some("0.9.1"));
    }

    /// A banner with no version-shaped token still says *something* useful, but an empty probe
    /// (a binary that printed nothing) must report nothing rather than a blank stamp.
    #[test]
    fn falls_back_to_the_banner_line_and_rejects_empty_output() {
        assert_eq!(parse_version("nightly build").as_deref(), Some("nightly build"));
        assert_eq!(parse_version("   \n  "), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn a_credit_balance_refusal_counts_as_a_quota_signal() {
        assert!(quota_signal("Error: Insufficient balance. Manage your billing here: https://x/billing"));
    }

    #[test]
    fn a_genuine_failure_is_not_a_quota_signal() {
        assert!(!quota_signal("error: unknown flag --nope"));
    }
}
