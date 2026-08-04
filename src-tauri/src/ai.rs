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

/// The longest a message can be and still be *only* a refusal.
///
/// Every real one is a line or two — "Claude AI usage limit reached|1751…", "Insufficient
/// balance. Manage your billing here: …". Nothing a provider says to turn a run down needs a
/// paragraph, so the generous end of "a line or two" is the whole test.
const MAX_REFUSAL_CHARS: usize = 400;

/// Whether a **successful** run's own reply is a refusal rather than an answer.
///
/// A different question from [`quota_signal`], and deliberately stricter. On a failed run any of
/// those phrases anywhere is evidence of why it failed. On a run that *succeeded*, the phrase has
/// to **be** the whole message — because the model is also free to write about rate limits and
/// billing, and it does: a story review that reported "the appointment search is an HTTP call to
/// SAP, which has a rate limit" was matched on its own prose, thrown away, and shown to the user
/// as "you are out of quota" with the finished analysis as the error text.
pub(crate) fn refusal_reply(text: &str) -> bool {
    text.chars().count() <= MAX_REFUSAL_CHARS && quota_signal(text)
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

    // Said before anything is spawned, so a run that then takes two minutes has carried the name of
    // what is taking them from its first second. This is the one place every engine passes through,
    // which is what keeps the answer honest — it is the invocation itself, not what a settings
    // screen elsewhere believes is configured.
    if let Some(ctx) = &ctx {
        ai_runs::emit_engine(ctx, engine.label(), inv.model);
    }

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

/// How much documentation is worth sending in one go. A wiki section past this is a whole product
/// manual, and the stories that come back from it are generic — the answer there is to select fewer
/// pages, which the picker makes easy, not to send more text.
pub const MAX_STORIES_SOURCE_CHARS: usize = 60_000;

/// The instructions behind "generate user stories from this documentation".
///
/// Stored per workspace (`workspace_prompts`, kind `user_stories`) so a team can bend the house
/// style — INVEST wording, Gherkin vs checklist criteria, which language — without touching code.
/// The **output contract** is deliberately restated as rules the model can't reasonably drop: the
/// answer is parsed as JSON, and a template edited into prose would otherwise silently produce a
/// batch that fails to parse.
pub const DEFAULT_USER_STORIES_TEMPLATE: &str = r#"Eres un Product Owner técnico y analista QA especializado en BDD (Behaviour-Driven Development). Por stdin recibes documentación de producto (una o varias páginas de wiki, especificaciones o notas) y, opcionalmente, instrucciones adicionales del usuario.

Tu tarea: derivar historias de usuario listas para el backlog cuyos criterios de aceptación se puedan automatizar con Cucumber TAL CUAL, sin que QA tenga que reescribirlos.

=== INVEST: las seis condiciones que toda historia debe cumplir ===
- Independiente: se puede construir y probar sin esperar a otra historia del lote. Si dos se necesitan mutuamente, fúndelas en una o divídelas por el dato que comparten.
- Negociable: describe el QUÉ y el PARA QUÉ, nunca la solución técnica. Sin nombres de tabla, endpoints, componentes ni librerías.
- Valiosa: el "para <beneficio>" nombra un resultado observable para el negocio o el usuario. "Para que el sistema guarde el dato" no es valor; "para no tener que repetir la dirección en cada compra" sí.
- Estimable: si falta información para dimensionarla, escríbela igual y deja la duda en `notes` y en `open_questions`.
- Pequeña (Small): una historia = una capacidad. Si necesitas más de 6 escenarios, divídela: por regla de negocio, por rol, o separando el camino feliz de las excepciones.
- Testeable: cada criterio termina en algo observable y comprobable. Si no sabes cómo se verificaría, no es un criterio: es un deseo.

=== GHERKIN: sintaxis en español (la que Cucumber acepta con `# language: es`) ===
- Un elemento de `acceptance_criteria` = UN escenario completo, con su línea de título primero:
  Escenario: <qué demuestra este caso>
  Dado <contexto o estado inicial ya existente>
  Cuando <la única acción del actor>
  Entonces <resultado observable>
- Pasos adicionales con `Y` / `Pero`. Palabras clave válidas: Escenario, Esquema del escenario, Ejemplos, Dado, Cuando, Entonces, Y, Pero.
- NUNCA dos `Cuando` en un escenario. Dos acciones son dos escenarios; si el segundo `Cuando` es en realidad preparación, es un `Dado`.
- Cada `Entonces` afirma UN hecho. "Entonces se muestra el resumen y se envía el correo y se descuenta el stock" son tres pasos (`Entonces` + `Y` + `Y`).
- Cuando varios casos solo se diferencian en los datos, usa un esquema en lugar de repetir el escenario:
  Esquema del escenario: <título>
  Dado …
  Cuando … <parametro> …
  Entonces … <resultado>
  Ejemplos:
    | parametro | resultado |
    | valor1    | esperado1 |
    | valor2    | esperado2 |
  Los `<parámetros>` del cuerpo deben coincidir EXACTAMENTE con las cabeceras de la tabla, y toda fila de tabla empieza y termina con `|`.
- Declarativo, no imperativo. "Cuando el cliente confirma el pago", NO "Cuando hace clic en el botón #pagar". Un criterio atado a un selector, una URL o un nombre de pantalla se rompe con el primer rediseño y deja de servir como contrato.
- Tercera persona e impersonal, y sobre todo CONSISTENTE: reutiliza la misma redacción exacta para un paso que significa lo mismo en varias historias. Cada frase distinta es un step definition más que alguien tiene que escribir y mantener.
- Nada de datos inventados: usa los valores que da la documentación, o descríbelos por su regla ("un importe superior al límite diario").

=== COBERTURA: entre 2 y 6 escenarios por historia ===
1. El camino feliz.
2. Al menos un camino alternativo o una variante de datos que importe.
3. Las validaciones, errores y estados vacíos que mencione la documentación.
4. Los límites, cuando haya un umbral numérico o temporal (el valor justo dentro y el justo fuera).
5. Los permisos, cuando la documentación distinga quién puede hacer qué.
Los requisitos no funcionales (rendimiento, auditoría, seguridad, accesibilidad) van como escenario propio con su umbral medible, o como historia aparte si tienen entidad suficiente.

=== CONTENIDO ===
- `narrative` sigue exactamente "Como <rol>, quiero <capacidad>, para <beneficio>". El rol es concreto ("cajero", "cliente registrado", "administrador de la tienda"); no escribas "usuario" a secas si la documentación distingue roles.
- `title` corto (máximo 80 caracteres), sin el prefijo "Historia:".
- `description` en 2-5 frases: contexto, qué entra en el alcance, qué queda FUERA, y las reglas de negocio que aplican.
- `tags` son 1-4 etiquetas cortas en minúsculas y sin espacios (usa guiones). Se publican como etiquetas del work item y también sirven como etiquetas Gherkin (`@checkout`), así que deben ser válidas como tales.
- NO inventes funcionalidad que la documentación no respalde. Toda ambigüedad va a `notes` de la historia afectada y a `open_questions`.
- Escribe SIEMPRE en español, salvo que las instrucciones adicionales pidan otro idioma.

=== ESTIMACIÓN Y CLASIFICACIÓN ===
- `story_points` usa la serie de Fibonacci (1, 2, 3, 5, 8, 13). Usa 0 si no hay base para estimar.
- `priority` es un entero de 1 (crítica) a 4 (baja), siguiendo la convención de Azure Boards.

=== REVISIÓN ANTES DE RESPONDER ===
Repasa cada historia y corrígela si falla algo de esto: ¿el `para` nombra valor real? ¿algún escenario tiene dos `Cuando`? ¿algún `Entonces` afirma más de una cosa? ¿algún paso menciona un botón, una pantalla o un endpoint? ¿hay más de 6 escenarios (entonces divide la historia)? ¿queda algún criterio que no sabrías comprobar?

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con un objeto JSON válido. Nada antes, nada después, sin bloques de código markdown.
- El objeto tiene exactamente esta forma:
{"stories":[{"title":"","narrative":"","description":"","acceptance_criteria":[""],"priority":2,"story_points":3,"tags":[""],"notes":""}],"open_questions":[""]}
- `notes` y `open_questions` pueden ir vacíos ("" y []), el resto de campos siempre presentes.
- Cada elemento de `acceptance_criteria` es UN escenario entero en una sola cadena, con sus saltos de línea escapados como \n. No uses saltos de línea sin escapar dentro de las cadenas JSON."#;

/// How much of a story set is worth sending to a verification run. The stories go on stdin; the
/// *code* is read by the engine itself from the working directory, so this only has to bound the
/// backlog side of the payload.
pub const MAX_STORIES_VERIFY_CHARS: usize = 40_000;

/// The instructions behind "check these acceptance criteria against the code".
///
/// Stored per workspace (`workspace_prompts`, kind `story_verify`) like the generator's, so a team
/// can tighten what counts as evidence. Read-only by construction: the engine is pointed at the
/// repository to *look*, and the prompt says so — nothing here writes a file, and the verdicts land
/// in CodeFlow's own rows rather than in the working copy.
pub const DEFAULT_STORY_VERIFY_TEMPLATE: &str = r#"Eres un QA técnico verificando criterios de aceptación contra el código de un repositorio. Trabajas en el directorio del repositorio y tienes herramientas para leerlo: úsalas antes de responder. Por stdin recibes historias de usuario numeradas, cada una con sus criterios de aceptación en Gherkin, también numerados.

Tu tarea: por CADA criterio, decidir si el código que hay HOY en este repositorio satisface ese comportamiento, y respaldarlo con evidencia del propio repositorio.

=== VEREDICTOS (usa exactamente uno por criterio) ===
- `pass` — encontraste el código que implementa el comportamiento y puedes señalar dónde está.
- `fail` — el comportamiento no existe, o el código hace algo que lo contradice.
- `partial` — una parte está implementada y otra no (por ejemplo el camino feliz sí, pero la validación del criterio no).
- `unknown` — no pudiste determinarlo: el criterio depende de infraestructura, de configuración o de un sistema externo que no está aquí, o es demasiado ambiguo para comprobarlo.

=== REGLAS ===
- NO modifiques, crees ni borres ningún archivo. Esto es una lectura, no un arreglo.
- La evidencia son rutas reales del repositorio con número de línea, relativas a la raíz: "src/pago/checkout.ts:120". Verifica que el archivo existe y que la línea es la relevante; no cites de memoria.
- Sin evidencia citable no puede haber `pass`. Si no encuentras el archivo, el veredicto es `fail` o `unknown`, nunca `pass`.
- Un test automatizado que ya cubra el criterio es la mejor evidencia posible: cítalo y marca `covered_by_test` en true. Un `pass` sin test es código que cumple pero que nada protege — dilo en `note`.
- Ante la duda, `unknown`. Un falso "cumple" es peor que un "no lo sé", porque QA deja de mirar justo donde está el hueco.
- `note` es una frase corta y concreta: qué falta para el `fail`, qué parte falta para el `partial`, o qué te impidió decidir en el `unknown`. Para un `pass` puede ir vacía.
- `summary` es una frase por historia con la conclusión global.
- Escribe SIEMPRE en español.

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con un objeto JSON válido. Nada antes, nada después, sin bloques de código markdown.
- El objeto tiene exactamente esta forma:
{"stories":[{"story":1,"summary":"","criteria":[{"criterion":1,"verdict":"pass","evidence":["ruta/archivo.ext:120"],"note":"","covered_by_test":false}]}]}
- `story` y `criterion` son los números tal y como aparecen en el texto de stdin, empezando en 1. No los reordenes ni los renumeres.
- Incluye TODAS las historias y TODOS sus criterios, también los que queden en `unknown`.
- No uses saltos de línea sin escapar dentro de las cadenas JSON: usa \n."#;

/// How much of one work item is worth sending. A single story is small; the ceiling is here for the
/// description somebody pasted a whole specification into.
pub const MAX_WORK_ITEM_REVIEW_CHARS: usize = 30_000;

/// Which question the review is asking on this run.
///
/// One call per part of the work item rather than one that answers everything, and — since the
/// tabs were split — one part per tab. The user may run only the description, only the criteria,
/// only the tasks, or any combination of the three: each tab owns its own run and its own answer,
/// so nothing on this screen depends on a stage the user chose not to pay for.
///
/// `Analyze` predates the split and is kept because saved sessions still carry its answer. Nothing
/// on the screen runs it any more.
///
/// `Tasks` and `TasksQa` are two stages rather than one with a parameter because they are two
/// prompts a team edits separately: development work is derived from this story and this code, and
/// the QA ladder is a fixed five-step shape a team either keeps or rewrites wholesale.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkItemReviewStage {
    Analyze,
    Description,
    Criteria,
    Tasks,
    TasksQa,
}

/// What kind of thing is being reviewed, which decides what "well written" even means.
///
/// A user story is judged by INVEST and by whether its behaviour is expressible in Gherkin. None of
/// that applies to a bug: asking whether a defect is "Negotiable" is a category error, and the
/// questions that matter — can somebody reproduce this, what was expected, how do we know it is
/// fixed — have no counterpart in the story checklist. One prompt for both would be a checklist
/// that is wrong half the time.
///
/// Only the analysis branches. Acceptance criteria and the work breakdown are the same job either
/// way: describe the observable outcome, then list what it takes to get there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkItemKind {
    Story,
    Bug,
}

/// "Read this story and tell me what is missing from it."
///
/// Points the engine at the repository the story will be built in, so "falta decir qué pasa cuando
/// el pago se rechaza" can be grounded in a rejection path that already exists in the code rather
/// than guessed from the prose. Read-only, like the verification run it sits next to.
///
/// `cwd` is the repository to read, or `None` to judge the story on its text alone — see
/// [`NO_REPO_NOTE`] for what the model is told in that case.
pub const DEFAULT_WORK_ITEM_ANALYZE_TEMPLATE: &str = r#"Eres un analista funcional revisando una historia de usuario que YA está escrita en Azure DevOps. Trabajas en el directorio de un repositorio y tienes herramientas para leerlo: úsalas antes de responder, porque tus propuestas tienen que encajar con el sistema que existe hoy.

Por stdin recibes la historia: su título, su descripción y sus criterios de aceptación actuales (que pueden venir vacíos).

Tu tarea: decir qué le falta a esta historia para estar lista, sin reescribirla tú.

=== QUÉ EVALUAR ===
- INVEST, letra por letra: Independent, Negotiable, Valuable, Estimable, Small, Testable.
- Formato BDD: ¿se entiende quién la pide, qué quiere y para qué? ¿La descripción dice el comportamiento esperado o solo nombra una pantalla?
- Gherkin y testabilidad Cucumber: ¿los criterios actuales son escenarios verificables (Dado/Cuando/Entonces), o son deseos sin condición observable? ¿Falta el camino de error, el borde, el estado vacío?
- Huecos contra el código: comportamientos que el sistema ya tiene y que esta historia ignora, o que la contradicen.

=== REGLAS ===
- NO modifiques, crees ni borres ningún archivo. Esto es una lectura.
- NO reescribas la historia. Cada hallazgo propone UN texto concreto que el humano decidirá si pega o no, y dice a qué parte de la historia pertenece.
- `proposal` es el texto listo para pegar, redactado como iría en la historia — no una instrucción del estilo "deberías añadir...".
- La evidencia son rutas reales del repositorio con línea, relativas a la raíz: "src/pago/checkout.ts:120". Verifica que existen; no cites de memoria. Un hallazgo sin evidencia deja `evidence` vacío, no inventes una.
- Si la historia ya está bien en algo, dilo con `verdict` `ok` y no inventes un hallazgo para rellenar.
- Escribe SIEMPRE en español.

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con un objeto JSON válido. Nada antes, nada después, sin bloques de código markdown.
- El objeto tiene exactamente esta forma:
{"summary":"","invest":[{"letter":"I","verdict":"ok","note":""}],"findings":[{"section":"titulo","severity":"media","issue":"","proposal":"","evidence":["ruta/archivo.ext:12"]}]}
- `letter` es una de: I, N, V, E, S, T. Incluye las seis, en ese orden.
- `verdict` es uno de: `ok`, `weak`, `missing`.
- `section` es una de: `titulo`, `narrativa`, `descripcion`, `criterios`.
- `severity` es una de: `alta`, `media`, `baja`.
- No uses saltos de línea sin escapar dentro de las cadenas JSON: usa \n."#;

/// The same review, asked of a defect instead of a story.
///
/// Same output shape as the story analysis — the screen renders one kind of finding — but the
/// `invest` array carries a different six-point checklist, because a bug that cannot be reproduced
/// is broken in a way "Independent" has no word for.
pub const DEFAULT_WORK_ITEM_BUG_ANALYZE_TEMPLATE: &str = r#"Eres un QA técnico revisando un BUG que YA está reportado en Azure DevOps. Trabajas en el directorio de un repositorio y tienes herramientas para leerlo: úsalas antes de responder, porque un bug se juzga contra el código donde ocurre.

Por stdin recibes el bug: su título, sus pasos para reproducir, la información de entorno si la tiene, y sus criterios de aceptación actuales (que suelen venir vacíos).

Tu tarea: decir qué le falta a este reporte para que alguien pueda arreglarlo y para que QA pueda cerrarlo, sin reescribirlo tú.

=== LOS SEIS PUNTOS (van en `invest`, uno por letra) ===
- R (Reproducible): ¿hay pasos numerados que otra persona pueda seguir sin adivinar? ¿Dice desde qué pantalla o endpoint se empieza?
- E (Esperado): ¿dice qué debería pasar? Un bug sin comportamiento esperado es una opinión.
- O (Obtenido): ¿dice qué pasa en su lugar, con el mensaje, código o captura concretos?
- C (Contexto): entorno, versión, usuario, datos de prueba, navegador o ambiente. ¿Se sabe dónde ocurre?
- A (Alcance): ¿se sabe a quién afecta y con qué frecuencia — siempre, a veces, un solo cliente?
- V (Verificable): ¿hay una condición de cierre observable? ¿Cómo sabrá QA que quedó arreglado?

=== REGLAS ===
- NO modifiques, crees ni borres ningún archivo. Esto es una lectura.
- NO reescribas el bug. Cada hallazgo propone UN texto concreto que el humano decidirá si pega, y dice a qué parte pertenece.
- `proposal` es el texto listo para pegar, redactado como iría en el reporte — no una instrucción del estilo "deberías añadir...".
- Usa el código para ubicar el fallo: si encuentras el archivo o la función donde ocurre lo descrito, cítalo. Si el reporte contradice lo que hace el código, ese es el hallazgo más valioso que puedes dar.
- La evidencia son rutas reales del repositorio con línea, relativas a la raíz: "src/ot/horario.ts:88". Verifica que existen; no cites de memoria. Sin evidencia, deja `evidence` vacío; no la inventes.
- Si el reporte ya está bien en un punto, dilo con `verdict` `ok` y no inventes un hallazgo para rellenar.
- Escribe SIEMPRE en español.

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con un objeto JSON válido. Nada antes, nada después, sin bloques de código markdown.
- El objeto tiene exactamente esta forma:
{"summary":"","invest":[{"letter":"R","verdict":"ok","note":""}],"findings":[{"section":"descripcion","severity":"media","issue":"","proposal":"","evidence":["ruta/archivo.ext:12"]}]}
- `letter` es una de: R, E, O, C, A, V. Incluye las seis, en ese orden.
- `verdict` es uno de: `ok`, `weak`, `missing`.
- `section` es una de: `titulo`, `narrativa`, `descripcion`, `criterios`. Usa `descripcion` para los pasos de reproducción y `criterios` para la condición de cierre.
- `severity` es una de: `alta`, `media`, `baja`.
- No uses saltos de línea sin escapar dentro de las cadenas JSON: usa \n."#;

/// How much of the repository a review run is supposed to read.
///
/// Repeated verbatim into every review template because it is the instruction that decides what a
/// run *costs*. Left unsaid, an agent told to "read the repository" reads the repository: hundreds
/// of files for a story that touches two, several minutes of wall clock, and a context window
/// spent on code that has nothing to do with the question. What the review actually needs is
/// orientation — the shape of the project and the handful of files this story lands in.
const REPO_READING_BUDGET: &str = r#"=== CUÁNTO CÓDIGO LEER ===
- NO leas el repositorio entero. Necesitas orientarte, no auditarlo.
- Empieza por lo que describe el proyecto: README, la documentación del repositorio y los archivos `.md` de contexto. Suelen bastar para saber de qué va.
- Después busca SOLO lo que toca esta historia: los archivos que nombran sus entidades, su pantalla o su endpoint. Búsqueda dirigida, no recorrido exhaustivo.
- Como referencia, entre 5 y 15 archivos abiertos son suficientes. Si has abierto más y sigues sin encontrar lo que buscabas, responde con lo que sepas y deja `evidence` vacío en lo que no puedas respaldar.
- Es preferible una respuesta honesta sin evidencia que una lenta con evidencia inventada."#;

/// "Rewrite this work item's description, and say nothing if it is already fine."
///
/// Its own stage since the tabs were split. It used to be the analysis findings filtered to the
/// prose, which meant the description tab could only show something if the user had paid for a
/// whole-story analysis first — and what it showed were remarks about the description rather than
/// a description. What the tab wants is the field, rewritten, ready to replace what is there.
pub const DEFAULT_WORK_ITEM_DESCRIPTION_TEMPLATE: &str = r#"Eres un analista funcional reescribiendo la DESCRIPCIÓN de un work item que ya está en Azure DevOps. Trabajas en el directorio de un repositorio y tienes herramientas para leerlo.

Por stdin recibes el work item: su tipo, su título, su descripción actual, sus criterios de aceptación y las tareas que ya tiene.

Tu tarea: devolver la descripción completa, lista para reemplazar a la actual — no comentarios sobre ella.

=== QUÉ TIENE QUE DECIR ===
- Para una historia: quién lo pide, qué necesita y para qué; el comportamiento esperado, no solo el nombre de una pantalla; y las reglas de negocio que la condicionan.
- Para un bug: qué pasa, qué debería pasar, en qué entorno y desde cuándo.
- Lo que queda FUERA del alcance, cuando la descripción actual lo deja ambiguo.

=== REGLAS ===
- NO modifiques, crees ni borres ningún archivo. Esto es una lectura.
- Devuelve Markdown: títulos con `##`, listas con `-`, negritas donde ayuden. Nada de HTML.
- Conserva lo que la descripción actual ya dice bien. Reescribir por reescribir le hace perder al equipo el texto que había acordado.
- NO inventes reglas de negocio que no estén ni en el texto ni en el código. Lo que falte y no puedas deducir, déjalo escrito como pregunta abierta al final.
- **Si la descripción actual ya cumple con lo que se espera, devuelve `description` como cadena vacía.** Es una respuesta válida y es la correcta cuando no hay nada que mejorar: no reescribas para justificar la ejecución.
- Escribe SIEMPRE en español.

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con un objeto JSON válido. Nada antes, nada después, sin bloques de código markdown.
- El objeto tiene exactamente esta forma:
{"description":"","rationale":"","evidence":["ruta/archivo.ext:12"]}
- `description` es la descripción entera en una sola cadena, con sus saltos de línea escapados como \n. Vacía si no hay nada que proponer.
- `rationale` es una frase diciendo qué cambiaste y por qué. Vacía si `description` lo está.
- No uses saltos de línea sin escapar dentro de las cadenas JSON: usa \n."#;

/// "Now write the acceptance criteria for the story as it stands."
///
/// Two things it asks for that the old one did not. **The format is the model's call**: a screen
/// with a state machine behind it wants Gherkin, and "el botón exportar aparece para los perfiles
/// A, B y C" is a checklist that Gherkin would only pad out. Forcing one shape on both is how a
/// backlog fills with three-line scenarios whose `Dado` is "el usuario está en la aplicación".
/// When it cannot tell, it says `ambos` and writes the criterion twice — the user picks on screen.
///
/// **And which existing criterion it replaces**, so the screen can colour a rewrite differently
/// from a new one. A rewrite that arrives looking like a new criterion is how a story ends up with
/// the old wording and the corrected one side by side.
pub const DEFAULT_WORK_ITEM_CRITERIA_TEMPLATE: &str = r#"Eres un QA técnico escribiendo criterios de aceptación para una historia de usuario. Trabajas en el directorio de un repositorio y tienes herramientas para leerlo: úsalas, porque los criterios tienen que ser verificables contra este sistema.

Por stdin recibes la historia: título, descripción y los criterios que tenga hasta ahora, numerados desde 1.

Tu tarea: proponer los criterios de aceptación que faltan, y corregir los que estén mal escritos.

=== ELIGE EL FORMATO DE CADA CRITERIO ===
No todo criterio quiere ser Gherkin. Decide uno por uno:
- `gherkin` cuando hay un flujo con disparador y resultado observable: algo pasa, el sistema responde. `Dado ... Cuando ... Entonces ...`, con `Y` para pasos adicionales.
- `checklist` cuando lo que se verifica es una lista de condiciones sin flujo: campos obligatorios, permisos por perfil, formatos aceptados, textos, límites. Una condición por línea, cada una empezando por `- `, redactada como algo que se puede marcar como cumplido o no.
- `ambos` SOLO si de verdad no puedes decidir. En ese caso rellena `gherkin` Y `checklist` con la misma exigencia escrita de las dos formas, y el usuario elegirá cuál se queda.
Elegir mal cuesta más que dudar: un flujo escrito como lista pierde el disparador, y una lista escrita como escenario acaba en `Dado que el usuario está en la aplicación`.

=== REGLAS ===
- NO modifiques, crees ni borres ningún archivo.
- Cada paso o condición describe algo OBSERVABLE. Nada de "Entonces el sistema funciona correctamente": di qué se ve, qué se guarda o qué se responde.
- Cubre el camino feliz, el de error y al menos un borde (vacío, límite, permiso denegado) cuando la historia lo admita.
- Si corriges un criterio que la historia YA tiene, pon su número en `replaces` y escribe la versión corregida entera. Si es nuevo, `replaces` es 0.
- NO repitas un criterio existente que ya esté bien. Cero criterios propuestos es una respuesta válida.
- `rationale` es una frase: por qué hace falta este criterio, o qué le arreglaste al que corriges.
- La evidencia son rutas reales del repositorio con línea, relativas a la raíz. Sin evidencia, deja `evidence` vacío.
- Escribe SIEMPRE en español.

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con un objeto JSON válido. Nada antes, nada después, sin bloques de código markdown.
- El objeto tiene exactamente esta forma:
{"criteria":[{"format":"gherkin","gherkin":"Dado ...\nCuando ...\nEntonces ...","checklist":"","rationale":"","replaces":0,"evidence":[]}]}
- `format` es exactamente `gherkin`, `checklist` o `ambos`.
- `gherkin` va relleno si `format` es `gherkin` o `ambos`; `checklist`, si es `checklist` o `ambos`. El otro queda vacío.
- `replaces` es un número: el del criterio existente que esta versión sustituye, o 0 si es nuevo.
- Cada texto va en una sola cadena, con sus saltos de línea escapados como \n."#;

/// "And now the development work it breaks down into."
///
/// The `[DEV]` prefix is deliberately *not* asked for here — CodeFlow puts it on when it builds the
/// task, so the convention holds even on the run where the model forgets it.
///
/// The three questions are the point of this prompt. "Implementar el endpoint de pago" is a task
/// title that survives refinement and then means something different to everyone who reads it in
/// the sprint; ¿Qué? / ¿Cómo? / ¿Para qué? is the smallest shape that forces the writer to say
/// which files, which approach, and what stops being broken afterwards.
pub const DEFAULT_WORK_ITEM_TASKS_TEMPLATE: &str = r#"Eres un tech lead partiendo una historia de usuario en tareas de DESARROLLO. Trabajas en el directorio de un repositorio y tienes herramientas para leerlo: úsalas, porque las tareas tienen que hablar de este código y no de un sistema imaginario.

Por stdin recibes la historia con sus criterios de aceptación, y la lista de tareas que ya tiene (que puede venir vacía).

Tu tarea: proponer las tareas de desarrollo que faltan para completar la historia. SOLO desarrollo: las de QA las genera otra ejecución.

=== CADA TAREA RESPONDE TRES PREGUNTAS, A NIVEL TÉCNICO ===
- `what` — ¿Qué? Qué hay que construir o cambiar, nombrando el componente, la capa o el archivo. Concreto: "el validador de cupones del checkout", no "la lógica de negocio".
- `how` — ¿Cómo? Con qué enfoque, en qué archivos y respetando qué patrón del repositorio. Cita rutas reales cuando las conozcas. Es la pregunta que evita que dos personas resuelvan lo mismo de dos formas.
- `why` — ¿Para qué? Qué criterio de aceptación o qué comportamiento del sistema queda cubierto cuando esta tarea esté hecha. Si no puedes contestarla, la tarea sobra.
Las tres son técnicas y las tres son obligatorias.

=== REGLAS ===
- NO modifiques, crees ni borres ningún archivo.
- `kind` es siempre `dev` en esta ejecución.
- NO pongas prefijos como [DEV] en el título: los añade la aplicación.
- El título es una acción concreta y corta, empezando por un verbo. Nada de "Trabajar en el checkout".
- NO repitas una tarea que ya existe en la lista recibida. Si una existente se queda corta, propón la que falta y dilo en `what`.
- Parte por unidades que una persona pueda terminar: si una tarea toca la base de datos, la API y la interfaz, son tres.
- La evidencia son rutas reales del repositorio con línea, relativas a la raíz. Sin evidencia, deja `evidence` vacío.
- Cero tareas propuestas es una respuesta válida cuando la historia ya está cubierta por las que tiene.
- Escribe SIEMPRE en español.

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con un objeto JSON válido. Nada antes, nada después, sin bloques de código markdown.
- El objeto tiene exactamente esta forma:
{"tasks":[{"kind":"dev","title":"","what":"","how":"","why":"","evidence":[]}]}
- No uses saltos de línea sin escapar dentro de las cadenas JSON: usa \n."#;

/// The QA ladder, which is a fixed five-step shape rather than a question for the model.
///
/// The titles are the team's convention and do not vary per story: designing the cases, agreeing
/// them with the PO, writing them step by step, running them, and the last check with the
/// business. What varies is which criteria and which edges each step is about, and that is the
/// only thing this prompt asks the model to write.
///
/// It is a template like any other, so a team whose QA ladder has four steps or seven edits it
/// here rather than living with somebody else's process.
pub const DEFAULT_WORK_ITEM_TASKS_QA_TEMPLATE: &str = r#"Eres un QA lead generando las tareas de QA de una historia de usuario. Trabajas en el directorio de un repositorio y tienes herramientas para leerlo.

Por stdin recibes la historia con sus criterios de aceptación, y la lista de tareas que ya tiene.

Tu tarea: devolver EXACTAMENTE estas cinco tareas de QA, en este orden y con estos títulos literales:

1. Título: `Diseñar casos de prueba`
   Descripción base: "Crear títulos de casos de prueba en base a los criterios de aceptación, ruta crítica y escenarios borde."
2. Título: `Validar pruebas con PO`
   Descripción base: "Instancia donde se le presenta al Product Owner los casos de prueba tentativos a ejecutar a nivel de título, generando espacio de feedback para agregar o modificar pruebas."
3. Título: `Elaborar casos de prueba (paso a paso)`
   Descripción base: "Abordar el paso a paso y resultado esperado de casos de prueba."
4. Título: `Ejecutar casos de prueba`
   Descripción base: "Inicio de la ejecución de casos de prueba creados previamente."
5. Título: `Last check con negocio`
   Descripción base: "Inicio de la ejecución de casos de prueba creados previamente."

=== CÓMO RELLENARLAS ===
- `title` es el título literal de la lista, sin prefijo: la aplicación le pone el `[QA]`.
- `what` es la descripción base tal cual, palabra por palabra. No la reescribas.
- `how` es lo único que adaptas a ESTA historia: qué criterios de aceptación cubre ese paso, qué ruta crítica y qué escenarios borde tiene esta historia en concreto. Nombra los criterios por su número.
- `why` es qué queda garantizado cuando ese paso está hecho.
- Si la historia no tiene criterios de aceptación, dilo en `how` de la primera tarea en lugar de inventarlos.

=== REGLAS ===
- NO modifiques, crees ni borres ningún archivo.
- `kind` es siempre `qa` en esta ejecución.
- Las cinco van siempre, aunque la historia ya tenga tareas de QA parecidas: el usuario decide en pantalla cuáles se queda.
- Escribe SIEMPRE en español.

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con un objeto JSON válido. Nada antes, nada después, sin bloques de código markdown.
- El objeto tiene exactamente esta forma:
{"tasks":[{"kind":"qa","title":"","what":"","how":"","why":"","evidence":[]}]}
- No uses saltos de línea sin escapar dentro de las cadenas JSON: usa \n."#;

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

/// How much of a conversation is worth sending to draft a reply to it. Comment threads are prose,
/// not diffs — anything past this is a thread that has already said what it means several times.
const MAX_THREAD_CHARS: usize = 12_000;

/// The instructions behind "draft this reply with AI" on a pull-request comment.
///
/// Deliberately not a stored, user-editable template like the review/commit ones: what it produces
/// is a first draft the user reads and edits in a textarea before anything is posted, so the place
/// to shape the wording is the draft itself, not a settings screen.
const DRAFT_REPLY_PROMPT: &str = "Eres la persona que está respondiendo un comentario de revisión \
    en un pull request. Redacta ÚNICAMENTE el texto del comentario de respuesta.\n\n\
    Reglas:\n\
    - Escribe en el mismo idioma en que está la conversación.\n\
    - Primera persona, tono profesional y directo, sin saludos ni despedidas.\n\
    - Responde al punto concreto que se planteó. Si la INTENCIÓN indica que el cambio no se va a \
      aplicar, explica el motivo con claridad y sin excusas vagas.\n\
    - Breve: 1 a 3 frases. Markdown simple si ayuda (`código` en línea), nada de encabezados.\n\
    - No inventes hechos sobre el código que no estén en la conversación o en la intención.\n\
    - No agregues firmas, ni prefijos tipo \"Respuesta:\", ni comillas alrededor del texto.";

/// Drafts a reply to one pull-request comment thread: the conversation so far plus, optionally, the
/// gist of what the user wants to say ("no aplica, es intencional"). Text only — nothing is posted
/// here, and nothing on disk is touched; the caller shows the draft for editing first.
pub async fn draft_comment_reply(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    conversation: &str,
    note: Option<&str>,
) -> Result<String, String> {
    if conversation.trim().is_empty() {
        return Err("No hay conversación que responder".to_string());
    }

    let truncated: String = conversation.chars().take(MAX_THREAD_CHARS).collect();
    let mut stdin_payload = format!("CONVERSACIÓN EN EL PULL REQUEST:\n{truncated}\n\n");
    match note.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => stdin_payload.push_str(&format!("INTENCIÓN DE LA RESPUESTA:\n{n}\n")),
        None => stdin_payload.push_str(
            "INTENCIÓN DE LA RESPUESTA:\n(no se indicó; deduce del hilo la respuesta más razonable)\n",
        ),
    }

    let mut inv = AiInvocation::new(DRAFT_REPLY_PROMPT, &stdin_payload);
    inv.model = model;
    let run = run(engine, binary, inv).await?;
    // Some engines wrap prose in a fence when asked for "only the text" — the fence is never part
    // of the comment the user meant to leave.
    Ok(strip_code_fence(&run.text))
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

/// Derives user stories with acceptance criteria from documentation.
///
/// Text-in / text-out with no tools and no working directory, like [`inline_edit`] and unlike the
/// review pipeline: the source is documentation the caller already gathered (an Azure DevOps wiki,
/// a handful of Markdown files, pasted text), never something the engine goes and finds. That is
/// what lets this run in a workspace with no repository open at all, on any provider including a
/// local Ollama model.
///
/// Returns the model's raw answer; the caller parses it with [`extract_json_block`], because what
/// to do with a malformed answer (retry, show it, keep the previous batch) is not this layer's call.
pub async fn generate_user_stories(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    source_text: &str,
    instructions: &str,
    count_hint: i64,
    prompt_template: &str,
) -> Result<String, String> {
    if source_text.trim().is_empty() {
        return Err("No hay documentación de la que derivar historias".to_string());
    }

    let truncated: String = source_text.chars().take(MAX_STORIES_SOURCE_CHARS).collect();
    let mut stdin_payload = String::new();
    // The count is a hint, not a rule: documentation that describes three things should not be
    // padded to ten, and the prompt says so rather than the number being sent alone.
    if count_hint > 0 {
        stdin_payload.push_str(&format!(
            "NÚMERO ORIENTATIVO DE HISTORIAS: {count_hint} (aproximado; prioriza la cobertura real \
             de la documentación sobre alcanzar esta cifra)\n\n"
        ));
    }
    match instructions.trim() {
        "" => {}
        extra => stdin_payload.push_str(&format!("INSTRUCCIONES ADICIONALES DEL USUARIO:\n{extra}\n\n")),
    }
    stdin_payload.push_str(&format!("=== DOCUMENTACIÓN ===\n{truncated}"));

    let prompt = if prompt_template.trim().is_empty() {
        DEFAULT_USER_STORIES_TEMPLATE
    } else {
        prompt_template
    };

    let mut inv = AiInvocation::new(prompt, &stdin_payload);
    inv.model = model;
    let run = run(engine, binary, inv).await?;
    Ok(run.text)
}

/// Checks a set of acceptance criteria against the code of a repository.
///
/// The mirror image of [`generate_user_stories`]: that one is text-in/text-out with no repository,
/// this one *needs* the repository and nothing else. The stories go on stdin already numbered; the
/// code is read by the engine itself from `cwd`, which is why this task — unlike generation —
/// cannot be routed to a model with no tools.
///
/// Nothing is written to the working copy. The engine is pointed at the repo to look, the prompt
/// says so, and `auto_approve_edits` is left off, so a run that decided to "fix" a gap would stall
/// on the permission prompt rather than quietly change a file QA is about to test.
#[allow(clippy::too_many_arguments)]
pub async fn verify_stories_against_code(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    stories_text: &str,
    contexts: &[(String, String)],
    allowed_tools: &[String],
    cwd: &str,
    prompt_template: &str,
    mcp_config_path: Option<&str>,
) -> Result<String, String> {
    if stories_text.trim().is_empty() {
        return Err("No hay criterios de aceptación que verificar".to_string());
    }

    let truncated: String = stories_text.chars().take(MAX_STORIES_VERIFY_CHARS).collect();
    let mut stdin_payload = String::new();
    if !contexts.is_empty() {
        stdin_payload.push_str("CONTEXTO DEL PROYECTO:\n");
        for (name, content) in contexts {
            stdin_payload.push_str(&format!("- {name}: {content}\n"));
        }
        stdin_payload.push('\n');
    }
    stdin_payload.push_str("=== HISTORIAS Y CRITERIOS A VERIFICAR ===\n");
    stdin_payload.push_str(&truncated);

    let prompt = if prompt_template.trim().is_empty() {
        DEFAULT_STORY_VERIFY_TEMPLATE
    } else {
        prompt_template
    };

    let mut inv = AiInvocation::new(prompt, &stdin_payload);
    inv.model = model;
    inv.allowed_tools = allowed_tools;
    inv.cwd = Some(cwd);
    inv.mcp_config_path = mcp_config_path;
    let run = run(engine, binary, inv).await?;
    Ok(run.text)
}

/// One stage of reviewing a story that already exists on the board.
///
/// Same shape as [`verify_stories_against_code`] — the story on stdin, the repository read by the
/// engine from its working directory — because it is the same kind of run: read code, judge prose,
/// write nothing.
/// Told to the model when the review runs with no repository attached.
///
/// The templates are written for the grounded case — "úsalas antes de responder", "verifica que
/// las rutas existen" — and a run with no working directory cannot obey either. Overriding it here
/// rather than in a second set of templates keeps one prompt per stage, and keeps a workspace's
/// own customised prompt working in both modes.
const NO_REPO_NOTE: &str = "SIN REPOSITORIO EN ESTA EJECUCIÓN: no tienes acceso al código y no \
    puedes leer archivos. Juzga la historia por su texto y por el contexto del proyecto si lo hay. \
    Deja `evidence` SIEMPRE vacío: no cites rutas ni inventes archivos. No afirmes qué hace el \
    sistema hoy — si algo depende del código, dilo como pregunta abierta en el hallazgo.\n\n";

#[allow(clippy::too_many_arguments)]
pub async fn review_work_item(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    stage: WorkItemReviewStage,
    kind: WorkItemKind,
    story_text: &str,
    contexts: &[(String, String)],
    allowed_tools: &[String],
    cwd: Option<&str>,
    prompt_template: &str,
    mcp_config_path: Option<&str>,
) -> Result<AiRun, String> {
    if story_text.trim().is_empty() {
        return Err("Esa historia no tiene texto que revisar".to_string());
    }

    let truncated: String = story_text.chars().take(MAX_WORK_ITEM_REVIEW_CHARS).collect();
    let mut stdin_payload = String::new();
    match cwd {
        None => stdin_payload.push_str(NO_REPO_NOTE),
        // On stdin rather than baked into each template, so it also governs the run of a team that
        // has replaced the template with its own. The budget is about what a review costs, not
        // about how this team words its prompts.
        Some(_) => {
            stdin_payload.push_str(REPO_READING_BUDGET);
            stdin_payload.push_str("\n\n");
        }
    }
    if !contexts.is_empty() {
        stdin_payload.push_str("CONTEXTO DEL PROYECTO:\n");
        for (name, content) in contexts {
            stdin_payload.push_str(&format!("- {name}: {content}\n"));
        }
        stdin_payload.push('\n');
    }
    stdin_payload.push_str("=== HISTORIA DE USUARIO ===\n");
    stdin_payload.push_str(&truncated);

    let prompt = match prompt_template.trim().is_empty() {
        false => prompt_template,
        true => match (stage, kind) {
            (WorkItemReviewStage::Analyze, WorkItemKind::Bug) => DEFAULT_WORK_ITEM_BUG_ANALYZE_TEMPLATE,
            (WorkItemReviewStage::Analyze, WorkItemKind::Story) => DEFAULT_WORK_ITEM_ANALYZE_TEMPLATE,
            (WorkItemReviewStage::Description, _) => DEFAULT_WORK_ITEM_DESCRIPTION_TEMPLATE,
            (WorkItemReviewStage::Criteria, _) => DEFAULT_WORK_ITEM_CRITERIA_TEMPLATE,
            (WorkItemReviewStage::Tasks, _) => DEFAULT_WORK_ITEM_TASKS_TEMPLATE,
            (WorkItemReviewStage::TasksQa, _) => DEFAULT_WORK_ITEM_TASKS_QA_TEMPLATE,
        },
    };

    let mut inv = AiInvocation::new(prompt, &stdin_payload);
    inv.model = model;
    // No repository means no reason to hand the model file tools: there is nothing for them to
    // reach, and offering them is how a run spends its turns discovering that.
    inv.allowed_tools = match cwd {
        Some(_) => allowed_tools,
        None => &[],
    };
    inv.cwd = cwd;
    inv.mcp_config_path = mcp_config_path;
    // The whole run, not just its text: the caller stamps the answer with the model that actually
    // produced it, which is the only place the CLI's own choice is reported when none was forced.
    run(engine, binary, inv).await
}

/// "Read this repository and write the document somebody needs to run, change and deploy it."
///
/// Grounded, like the review templates: the model has the checkout and file tools, and every claim
/// is supposed to come out of a file it actually opened. Two rules carry most of the weight and are
/// worth naming here rather than only in the prompt:
///
/// - **Omission over invention.** A repository with no database must produce a document with no
///   database section. A checklist prompt that asks for twelve sections gets twelve sections, and
///   the empty ones get filled with the model's idea of what a project like this usually has —
///   which is exactly the documentation that costs a new joiner a day.
/// - **Names, never values, for secrets.** The output is published to a wiki other people read. A
///   document that helpfully pasted the contents of a `.env` would turn a private credential into a
///   page with a URL, and nothing downstream of here would catch it.
pub const DEFAULT_REPO_DOC_TEMPLATE: &str = r#"Eres un ingeniero senior escribiendo la documentación técnica de UN repositorio, para dos lectores a la vez: quien entra hoy al equipo y tiene que levantarlo y cambiar algo, y quien tiene que desplegarlo y arreglarlo un domingo a las tres de la mañana.

Trabajas dentro del repositorio y tienes herramientas para leerlo. Úsalas de verdad antes de escribir una sola línea: este documento vale exactamente lo que hayas abierto y verificado, y se publica tal cual como una página de wiki de Azure DevOps que alguien va a seguir paso a paso.

Por stdin recibes el nombre del repositorio, el contexto que el equipo tenga guardado (notas escritas por personas: son pistas de dónde mirar, no verdad) y, opcionalmente, instrucciones adicionales del usuario.

=== PRIMERO CLASIFICA, LUEGO INVESTIGA, AL FINAL ESCRIBE ===
Antes de documentar nada decide qué clase de repositorio es, porque eso decide qué preguntas tienen sentido: un servicio que queda corriendo (API, web, worker, consumidor de cola), una aplicación que se distribuye e instala (escritorio, móvil, CLI), una librería que se publica en un registro, un job que se ejecuta y termina, o infraestructura y monorepos con varias de las anteriores. Un servicio tiene puertos, réplicas y comprobación de salud; una aplicación instalable tiene instaladores, firma y canal de actualización; una librería tiene versionado y publicación. Preguntarle a una librería por su `/health` es exactamente cómo se inventa una sección entera.

Después recorre el repositorio en este orden, porque la calidad del documento la decide lo que leas, no cómo lo redactes:
1. Manifiestos y archivos de bloqueo (package.json, Cargo.toml, pom.xml, build.gradle, go.mod, pyproject.toml, requirements.txt, *.csproj, Gemfile): qué stack es, qué gestor de paquetes se usa DE VERDAD (lo dice el lockfile, no la costumbre) y qué versiones están fijadas.
2. Los comandos que existen: los `scripts` del manifiesto, Makefile, Taskfile, justfile, la carpeta scripts/, y la configuración del empaquetador o del framework — ahí suele estar el comando que se ejecuta ANTES del que tú escribes en la terminal. Un comando que no salga de uno de esos archivos o del CI no existe.
3. La configuración: .env.example, .env.sample, config/, appsettings*.json, application*.yml, y sobre todo dónde LEE el código su configuración (process.env, import.meta.env, std::env::var, os.Getenv, Environment.GetEnvironmentVariable, System.getenv, @Value, settings.*). Una variable que nadie lee no existe; una que se lee y nadie documentó es justo la que bloquea al lector.
4. El punto de entrada y el recorrido completo de UNA acción, de la primera línea a la última. De ahí sale la arquitectura, no de los nombres de las carpetas.
5. Datos: migraciones, esquemas, ORM, seeds, cadenas de conexión, servicios de base de datos en el compose, y también los motores embebidos (SQLite, DuckDB, LiteDB) que no aparecen como servicio en ninguna parte.
6. Integraciones: clientes HTTP, SDKs, colas, cachés, proveedores de identidad, almacenamiento de objetos, los dominios y puertos que aparezcan literalmente en el código, y los binarios externos que el proceso lanza en tiempo de ejecución.
7. Contenedores y despliegue: Dockerfile, docker-compose*.yml, .devcontainer, charts de Helm, manifiestos de Kubernetes, terraform, .github/workflows, azure-pipelines*.yml, .gitlab-ci.yml, Jenkinsfile, vercel.json, fly.toml, Procfile — y qué secretos consumen esos pipelines, por nombre.
8. Pruebas, linters y formateadores: qué existe de verdad, y qué NO existe.
Si un paso no encuentra nada, eso también es un hallazgo y se escribe. Y el README, que suele estar desactualizado: cuando contradiga al código o a los scripts, manda el código, y dilo en el documento.

=== LAS SECCIONES, Y QUÉ TIENE QUE HABER EN CADA UNA ===

## Qué es y qué resuelve
- Un párrafo que entienda alguien de fuera: qué problema resuelve, para quién, y qué NO hace. El límite informa tanto como el alcance.
- Cierra con una línea diciendo qué clase de entregable es y cómo llega a quien lo usa.
- Si el código repite nombres de dominio que el lector no puede adivinar, añade una tabla corta de tres a ocho filas: Término | Qué significa aquí | Dónde vive en el código. Si el negocio y el código llaman distinto a la misma cosa, dilo: es la primera confusión que va a tener.

## Stack y arquitectura
- Lenguajes, frameworks y runtimes con su versión real y el archivo del que la sacaste.
- La forma del sistema en cinco a diez frases: qué procesos o capas hay, quién habla con quién y en qué dirección, y dónde está cada frontera (proceso, red, IPC, cola, disco).
- El recorrido completo de UNA acción representativa, nombrando en orden los archivos por los que pasa. Eso es lo que convierte un mapa en entendimiento; sin ello la sección es decorativa.
- Una tabla de los directorios que importan: Ruta | Qué vive ahí | Cuándo la tocas. Solo rutas que abriste, no las que supones por convención del framework, y marca las que NO se editan a mano (generadas, vendorizadas, artefactos de build).
- Si aclara algo que la prosa no dice, un bloque ```mermaid con un `flowchart LR` de diez nodos como mucho.

## Requisitos previos
- Una tabla: Herramienta | Versión exigida | De dónde sale esa exigencia | Cómo compruebas que la tienes.
- La versión sale de un archivo (engines, packageManager, .nvmrc, rust-toolchain, el `FROM` del Dockerfile, la imagen o la acción del CI) y ese archivo se cita. Si nadie la fija, escríbelo y propón la que usa el CI, diciendo que es una deducción tuya.
- Separa lo que hace falta para COMPILAR de lo que hace falta para EJECUTAR, e incluye lo que tiene que estar en el PATH y los accesos que hay que PEDIR a alguien: cuentas, tokens, VPN, permisos en un tablero. Un requisito que no se instala sino que se solicita es el que más días cuesta.

## Desarrollo local
- La secuencia exacta en bloques ```bash, un paso por comando, copiada del repositorio y con su gestor de paquetes real: clonar, instalar, configurar, levantar dependencias, migrar, sembrar, arrancar. Cada paso dice qué produce y, si tarda, cuánto.
- Termina SIEMPRE diciendo cómo se comprueba que quedó levantado: el puerto y la URL, la ventana que abre, la línea del log que aparece.
- Si existe un comando que PARECE el correcto y no lo es, avísalo aquí, en una línea, antes de que el lector lo ejecute. Esa advertencia sola vale más que el resto de la sección.
- Si hay un paso obligatorio que no está en el README pero sí en la configuración del proyecto, escríbelo: es justo donde se atasca quien llega nuevo.

## Configuración
- Empieza por una frase que diga por dónde entra la configuración de verdad en este repositorio.
- Si hay variables de entorno, una tabla: Variable | Para qué sirve | Obligatoria | Valor por defecto | Cuándo se usa | Dónde se lee.
  - `Cuándo se usa` es `ejecución`, `build` o `pipeline`: para operar no es lo mismo una variable que lee el proceso vivo que una que solo existe mientras se compila.
  - `Dónde se lee` es la ruta con línea del archivo que la consume. Una fila por variable que el código o el pipeline lean DE VERDAD; si alguna solo aparece en un .env.example que nadie lee, dilo en su fila.
- Si este repositorio NO se configura por variables de entorno, dilo con esas palabras y explica dónde vive entonces la configuración —un archivo que el usuario crea, una base de datos local, el llavero del sistema operativo, la propia interfaz— y cómo se cambia un valor. Al lector que lleva media mañana buscando un `.env` que no existe le devuelves la mañana.
- Nunca escribas el VALOR de un secreto, aunque lo encuentres en un archivo versionado: pon `<secreto>`, di de dónde se obtiene y quién lo entrega.

## Datos y persistencia
- Motor y versión, dónde está definido el esquema, cómo te conectas en local para mirar el dato con tus propios ojos, dónde queda físicamente y qué se respalda.
- Migraciones: dónde están, con qué herramienta y comando se aplican, y CUÁNDO se aplican (al arrancar la aplicación, a mano, o durante el despliegue), más cómo se añade una nueva. Si no hay herramienta de migraciones y el esquema se crea o se parchea desde el propio código, dilo: cambia por completo lo que el lector tiene que hacer para añadir una columna.
- Datos de prueba o seed: cómo se cargan; si no hay, dilo.
- Si este repositorio no tiene base de datos, no describas ninguna: una línea diciendo dónde queda entonces el estado —archivos en disco, memoria, un servicio externo, o en ninguna parte— y sigues.

## Integraciones
- Una tabla, solo con servicios externos que el código llame de verdad: Servicio | Para qué se usa | Protocolo o SDK | Cómo se autentica | Obligatorio | Si no responde | Dónde está el cliente.
- Debajo, el egreso de red: los hosts y puertos a los que este repositorio necesita salir para funcionar, sacados de las URLs del código y de la configuración. Quien tenga que abrir un firewall o configurar un proxy va a leer exactamente esa lista.
- Cuenta también los BINARIOS EXTERNOS que el proceso ejecuta: si la aplicación lanza un programa que el usuario tiene que haber instalado por su cuenta, es una integración, y suele ser lo primero que falla en una máquina nueva.
- Di cuáles son imprescindibles para desarrollar y cuáles puedes dejar apagadas mientras trabajas en otra cosa.

## Cómo cambiar algo
- La sección que el lector usa el día dos, y la más valiosa del documento. Elige de uno a tres cambios representativos y REALES de este repositorio —añadir un endpoint, una pantalla, o un campo que viaje desde la base de datos hasta la interfaz— y da para cada uno la lista ORDENADA de archivos que hay que tocar, con una frase por archivo.
- Incluye los pasos que se olvidan: dar de alta lo nuevo en el índice que el proyecto lleve (tabla de rutas, registro de comandos, contenedor de dependencias, `mod` o `export`, diccionario de traducciones, lista de permisos), y qué SÍNTOMA da olvidarlo. Un despiste que compila y revienta en tiempo de ejecución es exactamente lo que hay que documentar aquí.
- Las convenciones que el código respeta de hecho: nombres, en qué idioma están los identificadores y en cuál los textos de la interfaz, cómo se devuelven los errores.
- Cierra con la verificación: el comando exacto de pruebas y de linter, dónde viven, qué cubren y qué claramente no, y qué significa "está verde" en este repositorio. Si no hay pruebas automatizadas, dilo en una línea y di cuál es entonces la comprobación mínima razonable antes de subir un cambio; eso también es información operativa.

## Build y despliegue
- El comando que produce el artefacto, qué artefacto sale, en qué ruta queda, y qué necesita el build que no necesita la ejecución (toolchains, memoria, variables). Si el pipeline compila distinto que tu máquina, di las dos cosas.
- Qué dispara un despliegue —una rama, una etiqueta, un cambio en un archivo concreto, una ejecución manual— citado del archivo de CI. Es lo que más se malinterpreta y lo que hace que alguien publique sin querer.
- Por qué etapas pasa, qué entornos existen y en qué se diferencian, qué secretos consume el pipeline (por NOMBRE y dónde están configurados), dónde queda publicado el resultado y cómo se revierte.
- Si en el repositorio no hay ningún pipeline, escríbelo tal cual y describe lo que sí haya: un script, un procedimiento manual, o nada.

## Operación
- Cómo se comprueba que está sano: el endpoint, el comando o la señal concreta. Si no existe ninguno, dilo; no inventes un `/health`.
- A dónde van los logs y cómo se sube el nivel de detalle, qué métricas o trazas emite si emite alguna, y qué escribe en disco y dónde.
- Los modos de fallo conocidos, con su síntoma y su causa. Nada de consejos generales de observabilidad: solo lo que este repositorio tenga hoy.

## Trampas
- De tres a ocho entradas, cada una en tres partes: síntoma (lo que el lector va a ver), causa (por qué pasa) y qué hacer.
- Sirven aquí: el comando que parece el bueno y no lo es; la dependencia que no aparece en ningún README; el directorio que tiene que existir aunque esté vacío; el error que se manifiesta lejísimos de su causa; el paso que solo hace falta la primera vez; lo que se comporta distinto según el sistema operativo; los límites de recursos; el archivo raro que sigue en el repositorio y nadie ha borrado.
- Prioriza lo que te costó averiguar A TI leyendo este código: si tuviste que deducir algo que ningún archivo explica, ya tienes una trampa.
- Si encuentras una credencial dentro del repositorio, repórtala aquí como riesgo, nombrando el archivo y SIN copiar el valor.

## Lo que no se pudo determinar
- Obligatoria. Las secciones que omitiste y por qué, lo que dedujiste en lugar de leer, lo que está a medio hacer o abandonado en el código, y las preguntas concretas que alguien del equipo tiene que responder.
- Si el contexto que llegó por stdin contradice al código, la discrepancia queda anotada aquí.
- Un documento que dice hasta dónde llega vale más que uno que aparenta cubrirlo todo. Si de verdad no queda nada, escribe "Nada pendiente"; no la rellenes por quedar bien.

=== QUÉ SE OMITE Y QUÉ NO ===
- Omite por completo la sección que este repositorio no tenga, y anótala en "Lo que no se pudo determinar" con su motivo. Una sección vacía, o rellenada con lo habitual en proyectos parecidos, es peor que no tenerla: alguien la va a seguir.
- Con cuatro excepciones, donde la AUSENCIA es justo el dato que el lector necesita: si no hay variables de entorno, si no hay base de datos, si no hay pipeline de despliegue o si no hay pruebas, la sección se queda y dice exactamente eso en una línea, más dónde vive entonces lo que el lector venía a buscar. Una frase verdadera informa más que una tabla vacía.
- Las secciones que queden conservan el orden y el título de arriba. No las renumeres ni las renombres.

=== REGLAS ===
- NO modifiques, crees ni borres ningún archivo. Esto es una lectura.
- NO inventes nada. Si no lo has visto en un archivo de este repositorio, no se escribe: nada de `DATABASE_URL` porque casi todas las aplicaciones tienen una, nada de `npm test` si no hay script de pruebas, nada de una sección de contenedores sin Dockerfile, nada de un `/health` que nadie definió, nada de `kubectl apply` sin manifiestos, nada de una carpeta `services/` que no abriste. Una sola línea inventada convierte el documento en algo que nadie vuelve a creerse.
- Evidencia obligatoria en Requisitos previos, Desarrollo local, Configuración, Datos y persistencia, Integraciones, Build y despliegue y Trampas: cada versión exigida, cada comando, cada variable, cada migración, cada integración, cada disparador de despliegue y cada trampa cita su origen como `ruta/archivo:línea`, o solo la ruta cuando lo respalda el archivo entero. Ábrelo antes de citarlo; no cites de memoria ni por el nombre.
- Lo que no se pueda determinar leyendo el repositorio se escribe Sin determinar, diciendo qué haría falta para saberlo: una consola, un pipeline que no está aquí, preguntar al equipo. Nunca lo completes con lo que suele tener un proyecto parecido.
- Los comandos que escribas tienen que existir tal cual en el repositorio, con el gestor de paquetes que el repositorio usa. No inventes un `npm run dev` que nadie definió.
- Nunca publiques valores de secretos, tokens, contraseñas, claves ni cadenas de conexión reales, ni aunque estén versionados: solo su nombre y su origen. Esta página la lee gente de fuera del equipo.
- Explica el porqué, no solo el qué. "Ejecuta X" sin decir qué hace ni por qué hace falta no enseña a nadie a arreglarlo cuando falle.
- Si el contexto recibido por stdin contradice al código, manda el código: corrígelo en el texto y anota la discrepancia.
- Precisión antes que cobertura: media página verificada vale más que tres páginas plausibles. El documento se lee entero en unos quince minutos; lo que no quepa, va en tabla.
- Los bloques de código son para comandos y fragmentos cortos, quince líneas como mucho. No pegues archivos enteros: cita la ruta.
- Escribe SIEMPRE en español, en presente y dirigiéndote al lector de tú. Los nombres de archivos, comandos, variables e identificadores van tal cual están en el código, sin traducir, y las rutas relativas a la raíz del repositorio.

=== REVISIÓN ANTES DE RESPONDER ===
Relee el documento como si acabaras de formatear tu máquina y esto fuera lo único que tienes:
- ¿Puedes levantarlo siguiendo solo Desarrollo local, sin abrir ningún otro archivo y sin adivinar en ningún paso?
- ¿Hay algún comando, ruta, versión o variable que no puedas señalar ahora mismo en un archivo real? Bórralo.
- ¿Alguna sección serviría igual para otro proyecto cualquiera? Entonces no dice nada: reescríbela con los nombres de este, o quítala y anótala en la última sección.
- ¿Cómo cambiar algo nombra archivos concretos y en orden, o son consejos genéricos disfrazados?
- ¿Queda alguna sección que exista solo porque estaba en la lista?
- ¿Se ha colado algún valor de secreto?

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con el documento en Markdown. Nada antes, nada después, ninguna nota sobre cómo lo hiciste, y sin envolverlo en un bloque de código.
- La wiki de Azure DevOps ya muestra el título de la página a partir de su ruta: NO abras con un encabezado de nivel 1 que lo repita. El documento empieza directamente por `## Qué es y qué resuelve`.
- Los títulos de sección son los de arriba, con `##`. Dentro de una sección puedes usar `###`; no bajes de ahí.
- Las tablas llevan fila de cabecera y fila de separación con guiones, una fila por línea y sin saltos de línea dentro de una celda. Una celda sin dato se escribe con un guion.
- Los bloques de código van con su lenguaje (```bash, ```sql, ```yaml, ```json), un comando por línea y sin el `$` delante.
- Markdown puro, sin HTML incrustado. Los diagramas, si los hay, en un bloque ```mermaid.
- No respondas en JSON: la salida de esta tarea es el documento."#;

/// "Read these repository documents and write how the system fits together."
///
/// A synthesis, not a survey: its stdin is the grounded documents and it has no checkout, which is
/// the constraint the whole prompt is built around — see [`synthesize_workspace_doc`]. The rule it
/// exists to enforce is that an integration nobody documented is reported as unknown rather than
/// assumed, because a plausible architecture diagram is worse than an incomplete one.
pub const DEFAULT_WORKSPACE_DOC_TEMPLATE: &str = r#"Eres un arquitecto de software escribiendo la página de arquitectura de un sistema formado por VARIOS repositorios. Por stdin recibes el nombre del espacio de trabajo, opcionalmente instrucciones adicionales del usuario, y después la documentación técnica ya generada de cada repositorio, una detrás de otra, separadas por una línea `=== DOCUMENTO DEL REPOSITORIO: <nombre> ===`.

Tu tarea: explicar qué resuelven esos repositorios JUNTOS y cómo están integrados entre sí. Los cruzas, no los repites.

=== DE DÓNDE SALE LO QUE ESCRIBES ===
Esta ejecución NO tiene código delante: no hay repositorio en tu directorio de trabajo, no tienes herramientas para leer archivos y no puedes comprobar nada por tu cuenta. Todo lo que afirmes tiene que estar dicho en alguno de los documentos que llegan por stdin.
- Respalda cada afirmación que no sea evidente nombrando su origen: publica en la cola `pagos.creados` (documento de `pagos-api`).
- Una integración que ningún documento menciona NO existe. No la deduzcas del nombre del repositorio, del stack, ni de cómo suelen montarse estos sistemas. `auth-service` y `web-portal` no se hablan porque sea lo habitual: se hablan si algún documento lo dice.
- Cruza las tablas de configuración, las de integraciones y las listas de egreso de red de cada documento: ahí es donde están las conexiones reales, porque una variable que guarda la URL de otro servicio ES la integración.
- Las secciones «Lo que no se pudo determinar» de cada documento son tu mejor fuente de huecos: lo que un repositorio no supo explicar de sí mismo rara vez lo aclara el de al lado.
- Un documento pudo llegar recortado por longitud, y verás la marca al final. Un documento recortado, uno que se corte a media frase, o un repositorio al que otros nombran pero cuyo documento no llegó, van a «Huecos» tal cual. No completes lo que falta.
- Si solo llega un documento, dilo: la página se limita entonces a la frontera y a los sistemas externos, y no le inventas compañeros.

=== LOS TRES NIVELES DE CONFIANZA ===
Toda integración que describas lleva uno, y son la parte más útil de esta página:
- **Confirmada** — los dos documentos la cuentan: el que llama dice que llama, y el que recibe describe el endpoint, la cola o la tabla por donde le llega.
- **Declarada por un lado** — solo uno de los dos la menciona. Es la más frecuente y la más informativa: casi siempre significa que el otro lado no sabe que alguien depende de él.
- **Sin confirmar** — la sugieren un nombre, una variable de configuración o una URL suelta, pero ningún documento la describe. Va redactada como pregunta, nunca como hecho.

=== QUÉ NO ES ESTA PÁGINA ===
No es la suma de los documentos que recibes. Todo lo que vive dentro de un solo repositorio —sus variables de entorno, cómo se levanta en local, sus migraciones, su pipeline— YA está en la página de ese repositorio y aquí sobra. Menciona un detalle interno solo cuando explique una relación entre componentes: una variable de configuración importa aquí si es la URL con la que un servicio encuentra a otro.

=== ESTRUCTURA ===
Devuelve exactamente estas secciones, en este orden y con estos títulos.

## Qué resuelve el sistema
Entre dos y cinco frases: qué problema cubren estos repositorios en conjunto, y qué se puede hacer con el sistema entero que no se puede hacer con ninguna de sus partes por separado. Aquí no va ninguna tecnología.

## Frontera y actores
- Qué queda DENTRO: los componentes que este espacio de trabajo construye y despliega.
- Qué queda FUERA pero es imprescindible: proveedores de identidad, pasarelas de pago, ERPs, colas gestionadas, APIs de terceros. Nombra cada uno y di quién depende de él.
- Quién lo usa: los actores humanos o automáticos (usuario final, back office, tarea programada, otro sistema) y por dónde entran.

## Componentes
Una tabla con una fila por repositorio: Componente | Responsabilidad | Stack | Cómo se expone. La responsabilidad es una frase con lo que ese componente decide y que no decide nadie más. Si dos filas acaban diciendo lo mismo, no las maquilles: llévalo a «Riesgos y acoplamiento».

## Mapa del sistema
El diagrama Mermaid y, debajo, entre una y tres frases que lean el dibujo en voz alta.

## Integraciones
La sección central de esta página. Empieza por una tabla: Origen | Destino | Protocolo | Contrato | Autenticación | Confianza.
- «Origen» y «Destino» son componentes o sistemas externos del mapa, con el nombre exacto.
- «Protocolo»: HTTP/REST, gRPC, cola o tópico (con su nombre), base de datos compartida, archivo, webhook, SDK.
- «Contrato»: qué se intercambia — el recurso, la ruta, el evento, la tabla. Si un documento da el nombre literal, cópialo tal cual.
- «Autenticación»: cómo se identifica el origen ante el destino (token de servicio, OAuth, clave de API, red privada). Si ningún documento lo dice, escribe «No documentada». Eso es un hallazgo, no un hueco que rellenar de tu cosecha.
- «Confianza»: Confirmada, Declarada por un lado, o Sin confirmar.
Debajo de la tabla, un párrafo corto por cada integración que no sea evidente: qué dispara la llamada, si es síncrona o asíncrona, y qué ocurre cuando el destino no responde (esto último solo si algún documento lo cuenta).

## Flujos extremo a extremo
Entre uno y tres escenarios, los que de verdad atraviesan varios componentes. Por cada uno, un `###` con el nombre del escenario y una lista numerada de pasos; cada paso empieza nombrando el componente que actúa y dice qué entrega al siguiente. Marca en el propio paso cuándo el flujo se apoya en una integración «Sin confirmar»: ahí es donde se rompe la explicación.

## Datos compartidos
Dónde vive cada dato que necesita más de un componente. Por cada almacén: motor, quién escribe y quién lee. Si dos componentes escriben en la misma tabla, dilo aquí y llévalo también a «Riesgos y acoplamiento». Si cada repositorio tiene su propio almacén y no se comparte nada, dilo en una frase y sigue.

## Asuntos transversales
Cómo se resuelven en TODO el sistema —y sobre todo dónde NO se resuelven igual— la identidad y autenticación de usuario, la configuración y los secretos, la observabilidad (logs, trazas, métricas) y el versionado y despliegue coordinado. Las diferencias entre componentes son lo interesante: si dos servicios validan el token de forma distinta, eso es el contenido de esta sección.

## Riesgos y acoplamiento
Lo que hace difícil cambiar este sistema, según lo que dicen los documentos: puntos únicos de fallo, componentes que hay que desplegar a la vez, contratos sin versionar, dependencias circulares, un almacén con varios escritores, responsabilidades duplicadas. Cada riesgo en dos frases: qué es, y qué se rompería. No rellenes con riesgos genéricos de arquitectura; si no se ve en estos documentos, no va.

## Huecos
Obligatoria. Las integraciones sin confirmar, los componentes cuyo documento no explica con quién hablan, los repositorios de los que no llegó documento o llegó recortado, y las contradicciones entre dos documentos (nómbralos a los dos). Formula cada hueco como una pregunta concreta que alguien pueda responder: ¿`pagos-api` expone algún endpoint para `web-portal`, o la llamada pasa por la pasarela? Si de verdad no hay huecos, escribe «Ninguno», pero es raro: repásalo antes.

=== EL DIAGRAMA ===
- Un único bloque cercado con ```mermaid. Azure DevOps lo dibuja al publicar la página.
- Empieza por `flowchart LR`.
- Identificadores cortos, sin puntos, espacios ni guiones; el nombre real va en la etiqueta. Pon SIEMPRE la etiqueta entre comillas: los paréntesis, los dos puntos y las barras sin comillas son lo que rompe el diagrama.
- Formas: paréntesis con corchetes para los actores, corchetes para los componentes del sistema, corchetes con paréntesis para los almacenes de datos, y llaves dobles para los sistemas externos, como en el ejemplo de abajo.
- Los componentes que construye este espacio de trabajo van dentro de un `subgraph` que representa la frontera del sistema. Actores, terceros y almacenes externos quedan fuera.
- Una flecha por cada fila de la tabla de integraciones, etiquetada con el protocolo. Las «Sin confirmar» van con flecha discontinua (`-.->`) y su etiqueta lo dice.
- Si pasas de unos quince nodos, agrupa por dominio en varios subgrafos antes que dibujar una maraña.
- El diagrama no añade ninguna flecha que no esté en la tabla, ni la tabla ninguna que falte en el diagrama.

Ejemplo de la forma esperada:
```mermaid
flowchart LR
  cliente(["Cliente"])
  subgraph sistema["Plataforma de pagos"]
    web["web-portal"]
    api["pagos-api"]
  end
  pasarela{{"Pasarela externa"}}
  bd[("PostgreSQL pagos")]
  cliente --> web
  web -->|HTTP/REST| api
  api -->|SDK| pasarela
  api -->|SQL| bd
  web -.->|sin confirmar| bd
```

=== REGLAS ESTRICTAS DE SALIDA ===
- Responde ÚNICAMENTE con el documento en Markdown. Nada antes, nada después, y no envuelvas el documento entero en un bloque de código; el bloque ```mermaid del mapa sí va dentro, como parte del documento.
- Empieza directamente por `## Qué resuelve el sistema`. NO pongas un título de nivel 1: la página de la wiki ya lleva su nombre en la ruta y un encabezado de nivel 1 en el cuerpo lo duplica.
- Usa los títulos de sección tal cual aparecen arriba, con `##`. Dentro de una sección puedes usar `###`.
- Markdown que Azure DevOps entiende: encabezados, listas, tablas, negrita, código en línea y bloques cercados. Nada de HTML.
- Toda fila de tabla empieza y termina con `|`, y la cabecera lleva debajo su línea de guiones. Una celda sin dato se escribe con un guion, y ninguna celda lleva saltos de línea.
- Nombra los repositorios exactamente como llegan en la línea `=== DOCUMENTO DEL REPOSITORIO: <nombre> ===`, siempre como código en línea.
- Escribe SIEMPRE en español, salvo que las instrucciones adicionales pidan otro idioma.

=== REVISIÓN ANTES DE RESPONDER ===
Repasa el documento y corrígelo si falla algo de esto: ¿hay alguna flecha del diagrama que no esté en la tabla de integraciones, o al revés? ¿queda alguna integración sin nivel de confianza? ¿afirmas algo de un componente que su propio documento no dice? ¿has repetido cómo se instala o se levanta un repositorio? ¿queda algún «probablemente», «suele» o «por lo general» que en realidad es una suposición tuya disfrazada? Si no puedes señalar qué documento respalda una frase, bórrala o conviértela en una pregunta de «Huecos»."#;

/// How much of the per-repository documents the workspace synthesis is fed.
///
/// Generous, because this is the one input the synthesis has: it cannot read the code, so a
/// document truncated in half is a repository it will describe from its first heading. Six full
/// technical documents fit comfortably; a workspace with twenty repositories is a workspace whose
/// architecture page was never going to be one page anyway.
pub const MAX_DOC_SYNTHESIS_CHARS: usize = 200_000;

/// Which document is being written, which decides what "documented" even means.
///
/// A repository document is *grounded*: it reads the code and describes one thing in depth. A
/// workspace document is a *synthesis*: it reads the repository documents and describes what
/// happens between them. Neither prompt is a longer version of the other, and neither run has the
/// other's inputs — see [`synthesize_workspace_doc`] for why the workspace one cannot read code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocScope {
    Repo,
    Workspace,
}

/// Writes the technical documentation for one repository, by reading it.
///
/// The counterpart of the review runs: same grounding, opposite direction — instead of judging a
/// requirement against the code, it describes the code so somebody can operate and change it.
pub async fn generate_repo_doc(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    repo_name: &str,
    instructions: &str,
    contexts: &[(String, String)],
    allowed_tools: &[String],
    cwd: &str,
    prompt_template: &str,
    mcp_config_path: Option<&str>,
) -> Result<AiRun, String> {
    let mut stdin_payload = format!("REPOSITORIO A DOCUMENTAR: {repo_name}\n\n");
    if !contexts.is_empty() {
        stdin_payload.push_str("CONTEXTO DEL PROYECTO:\n");
        for (name, content) in contexts {
            stdin_payload.push_str(&format!("- {name}: {content}\n"));
        }
        stdin_payload.push('\n');
    }
    if !instructions.trim().is_empty() {
        stdin_payload.push_str(&format!("INSTRUCCIONES ADICIONALES DEL USUARIO:\n{}\n\n", instructions.trim()));
    }
    stdin_payload.push_str(
        "El repositorio está en tu directorio de trabajo. Léelo antes de escribir: todo lo que \
         afirmes tiene que salir de un archivo que exista.",
    );

    let prompt = match prompt_template.trim().is_empty() {
        false => prompt_template,
        true => DEFAULT_REPO_DOC_TEMPLATE,
    };

    let mut inv = AiInvocation::new(prompt, &stdin_payload);
    inv.model = model;
    inv.allowed_tools = allowed_tools;
    inv.cwd = Some(cwd);
    inv.mcp_config_path = mcp_config_path;
    run(engine, binary, inv).await
}

/// Writes the workspace document from the repository documents already generated.
///
/// **This run reads no code, and that is structural rather than a shortcut.** No single engine run
/// can see two repositories — `--add-dir` exists on one of the CLIs this app dispatches to, under a
/// different name on another, and not at all on the hosted ones — so a run pointed at one checkout
/// would describe the integration between six services from inside one of them. Feeding it the six
/// grounded documents instead is the one shape that is honest about what it knows, and the prompt
/// says so: an integration no document mentions is reported as unclear, not invented.
pub async fn synthesize_workspace_doc(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    workspace_name: &str,
    instructions: &str,
    per_repo: &[(String, String)],
    prompt_template: &str,
) -> Result<AiRun, String> {
    if per_repo.is_empty() {
        return Err("No hay documentos de repositorio con los que armar el del workspace".to_string());
    }

    let mut stdin_payload = format!("ESPACIO DE TRABAJO: {workspace_name}\n\n");
    if !instructions.trim().is_empty() {
        stdin_payload.push_str(&format!("INSTRUCCIONES ADICIONALES DEL USUARIO:\n{}\n\n", instructions.trim()));
    }

    // Budgeted per repository, never over the concatenation.
    //
    // Capping the assembled payload is the obvious thing and it is silently wrong: the documents
    // are appended in order, so a workspace whose first four repositories are verbose loses the
    // last two entirely — and the synthesis then describes, confidently and with no gap in sight,
    // a system that is missing two of its services. An even share truncates every document a
    // little, which the model can see, instead of deleting some completely, which it cannot.
    let share = MAX_DOC_SYNTHESIS_CHARS / per_repo.len().max(1);
    for (name, document) in per_repo {
        stdin_payload.push_str(&format!("\n\n=== DOCUMENTO DEL REPOSITORIO: {name} ===\n\n"));
        match document.chars().count() > share {
            false => stdin_payload.push_str(document),
            true => {
                stdin_payload.extend(document.chars().take(share));
                stdin_payload.push_str(
                    "\n\n[…documento recortado por longitud. Lo que falta no está disponible en \
                     esta ejecución: no supongas su contenido.]",
                );
            }
        }
        stdin_payload.push('\n');
    }
    let truncated = stdin_payload;

    let prompt = match prompt_template.trim().is_empty() {
        false => prompt_template,
        true => DEFAULT_WORKSPACE_DOC_TEMPLATE,
    };

    // No tools and no working directory: there is nothing to read, and offering file access would
    // only let it wander into whichever repository happened to be the process's cwd.
    let mut inv = AiInvocation::new(prompt, &truncated);
    inv.model = model;
    run(engine, binary, inv).await
}

/// Asks the model to fix JSON it just produced badly, and returns its second attempt.
///
/// Long single-line JSON is where the engines slip: six INVEST verdicts with real notes run to a
/// few thousand characters, and a bracket closed one key too late turns the whole answer into a
/// parse error. The work that produced it — minutes of reading the repository — is already done
/// and is all *in* the broken text, so re-running the review would pay for it twice and could
/// just as easily slip again.
///
/// Deliberately the cheapest call this module makes: no tools, no working directory, no MCP. It
/// is a text-shape repair, and a model that can read the repository is not needed to close a
/// bracket. `error` is passed on because it names the exact position, which is far better than
/// asking the model to find its own mistake.
pub async fn repair_json(
    engine: &dyn AiEngine,
    binary: &str,
    model: &str,
    broken: &str,
    shape: &str,
    error: &str,
) -> Result<String, String> {
    let stdin_payload = format!("=== ERROR DEL PARSER ===\n{error}\n\n=== JSON A REPARAR ===\n{broken}");
    let prompt = format!(
        "Recibes por stdin un JSON mal formado y el error exacto que devolvió el parser.\n\n\
         Tu única tarea es devolverlo bien formado. Reglas:\n\
         - Responde ÚNICAMENTE con el objeto JSON corregido. Nada antes, nada después, sin bloques \
           de código markdown.\n\
         - Conserva TODO el contenido: no resumas, no acortes textos, no elimines elementos de los \
           arrays. Solo arreglas la sintaxis y la estructura.\n\
         - No traduzcas ni reescribas los textos: van tal cual están.\n\
         - Escapa correctamente las comillas y los saltos de línea dentro de las cadenas.\n\
         - El objeto corregido tiene exactamente esta forma:\n{shape}"
    );

    let mut inv = AiInvocation::new(&prompt, &stdin_payload);
    inv.model = model;
    let run = run(engine, binary, inv).await?;
    Ok(run.text)
}

/// The JSON object a model answered with, as text ready to parse — repaired if it has to be.
///
/// **Every stage that asks a model for JSON goes through here**, because the way engines fail at it
/// is not specific to what was asked. The answer is right, the work behind it is done, and one
/// character in eight hundred means none of it can be read: a quote inside a sentence the model
/// forgot to escape, a literal newline in a string, a trailing comma, an answer cut off at the
/// token limit two keys from the end. Re-running costs the minutes it spent reading the repository
/// and can slip again on the next attempt.
///
/// It also does what the plain extraction always did, which is most of what a well-behaved answer
/// needs: engines told "respond with JSON only" still wrap it in a ```json fence, prefix it with
/// "Aquí tienes las historias:" or append a closing remark, and an answer with no object in it at
/// all returns `None` so the caller reports the raw text rather than an offset nobody can see.
///
/// Three passes, cheapest first, and **the first one that yields valid JSON wins**:
///
/// 1. The slice as it stands. An answer that already parses is returned untouched — nothing below
///    ever runs on a well-formed document, so nothing below can damage one.
/// 2. [`repair_json_text`], which fixes the faults deterministically. No model, no round trip.
/// 3. Failing both, the raw slice, so the caller reports what the model actually wrote and can
///    still fall back to asking a model to repair it.
///
/// Several candidate slices are tried in turn because the two ways of finding the object disagree
/// exactly when the object is malformed: brace matching stops early when an unescaped quote
/// confuses it about where strings end, and first-`{`-to-last-`}` swallows any prose written after
/// the object. Taking whichever one parses beats picking a rule and losing content to it.
pub fn json_answer(text: &str) -> Option<std::borrow::Cow<'_, str>> {
    let trimmed = text.trim();
    let start = trimmed.find('{')?;
    let rest = &trimmed[start..];

    let mut candidates: Vec<&str> = Vec::with_capacity(3);
    if let Some(end) = matching_brace(rest) {
        candidates.push(&rest[..=end]);
    }
    if let Some(end) = rest.rfind('}') {
        candidates.push(&rest[..=end]);
    }
    // The truncated case: an answer cut off mid-object has no closing brace anywhere, so neither
    // rule above produces a candidate. Guarded on the object having at least one `"key":` in it —
    // a stray `{` in a sentence is prose, and "repairing" it into `{}` would report an empty
    // answer as a successful one.
    if looks_like_object(rest) {
        candidates.push(rest);
    }
    if candidates.is_empty() {
        return None;
    }

    // Narrowest first while looking for one that already parses: with two objects in the answer,
    // or an object followed by prose, the brace-matched slice is the exact one and the wider
    // candidates are the mistake.
    for candidate in &candidates {
        if serde_json::from_str::<serde_json::Value>(candidate).is_ok() {
            return Some(std::borrow::Cow::Borrowed(candidate));
        }
    }
    // Widest first while repairing, and the order matters: in a truncated answer the last `}` is
    // the end of some *earlier* element, so repairing that slice yields a perfectly valid document
    // that has silently dropped everything after it. The longest candidate that can be made to
    // parse is the one that kept the most of what the model actually said.
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.len()));
    for candidate in &candidates {
        let repaired = repair_json_text(candidate);
        if serde_json::from_str::<serde_json::Value>(&repaired).is_ok() {
            return Some(std::borrow::Cow::Owned(repaired));
        }
    }
    // Nothing read. The widest candidate goes back — it is first after the sort — so the error
    // quotes the whole answer rather than the fragment one of the rules happened to stop at.
    Some(std::borrow::Cow::Borrowed(candidates.first()?))
}

/// The offset of the `}` closing the object that starts at 0, counting strings and escapes.
///
/// Unlike `rfind('}')` this stops at the object's own end, so prose appended after it — or a
/// second object the model helpfully added — is not dragged in. Returns `None` when the braces
/// never balance, which is both the truncated answer and the answer whose strings are broken
/// enough that the scan lost track of them.
fn matching_brace(source: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (at, c) in source.char_indices() {
        if in_string {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => {}
        }
    }
    None
}

/// Whether a slice starting at `{` actually began a JSON object, rather than being a brace that
/// happened to appear in a sentence. One quoted key followed by its colon is enough.
fn looks_like_object(source: &str) -> bool {
    let mut chars = source.char_indices().skip(1).skip_while(|(_, c)| c.is_whitespace());
    if !matches!(chars.next(), Some((_, '"'))) {
        return false;
    }
    let rest = &source[chars.next().map_or(source.len(), |(at, _)| at)..];
    rest.find('"').is_some_and(|close| rest[close + 1..].trim_start().starts_with(':'))
}

/// The faults models actually make in JSON, fixed without asking anyone.
///
/// Every rule here is one that has cost a real run, and each is narrow enough to be a no-op on a
/// well-formed document — which is the only reason it is safe to run at all. Called only after the
/// text has failed to parse, so a valid answer never reaches it.
///
/// - **A quote inside a sentence.** `"la opción "Guardar" del menú"` ends the string three words
///   early and everything after it is garbage to the parser. Whether a `"` closes the string is
///   decided by what comes next: only `:`, `}`, `]` and end-of-input can legitimately follow one,
///   plus a `,` that is itself followed by the start of a key or value. Anything else is a quote
///   inside prose and gets escaped.
/// - **A literal newline in a string.** JSON has no such thing; models write them anyway when the
///   text they are quoting had them.
/// - **A trailing comma** before `}` or `]`.
/// - **Comments.** `//` and `/* */` are JavaScript, not JSON.
/// - **Truncation.** An answer cut off at the token limit ends mid-string, mid-array or on a
///   dangling comma. Closing what is open loses the last element and keeps everything before it,
///   which is the whole point: the alternative is losing all of it.
fn repair_json_text(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len() + 16);
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut at = 0usize;

    while at < chars.len() {
        let c = chars[at];
        if in_string {
            match c {
                '\\' => {
                    out.push('\\');
                    match chars.get(at + 1) {
                        Some(&next) => {
                            out.push(next);
                            at += 1;
                        }
                        // A backslash as the last character would otherwise escape the quote the
                        // truncation fix is about to add, and take the string with it.
                        None => out.push('\\'),
                    }
                }
                '"' => match quote_role(&chars, at) {
                    QuoteRole::Closes => {
                        in_string = false;
                        out.push('"');
                    }
                    QuoteRole::ClosesMissingComma => {
                        in_string = false;
                        out.push('"');
                        out.push(',');
                    }
                    QuoteRole::Inner => out.push_str("\\\""),
                },
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                _ if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                _ => out.push(c),
            }
        } else {
            match c {
                '"' => {
                    // A member starting where a comma should have been: `{"a":1 "b":2}`. The
                    // string-side rule below catches the case where the previous member ended in a
                    // string; this one catches every other kind of value.
                    if needs_separator(&out) {
                        out.push(',');
                    }
                    in_string = true;
                    out.push('"');
                }
                '{' | '[' => {
                    stack.push(c);
                    out.push(c);
                }
                '}' | ']' => {
                    drop_dangling_comma(&mut out);
                    stack.pop();
                    out.push(c);
                }
                '/' if chars.get(at + 1) == Some(&'/') => {
                    while at < chars.len() && chars[at] != '\n' {
                        at += 1;
                    }
                    continue;
                }
                '/' if chars.get(at + 1) == Some(&'*') => {
                    at += 2;
                    while at + 1 < chars.len() && !(chars[at] == '*' && chars[at + 1] == '/') {
                        at += 1;
                    }
                    at += 2;
                    continue;
                }
                _ => out.push(c),
            }
        }
        at += 1;
    }

    if in_string {
        out.push('"');
    }
    drop_dangling_comma(&mut out);
    // A document that stopped on `"key":` is missing its value, and `null` is the honest one —
    // the model never said what it was.
    if out.trim_end().ends_with(':') {
        out.push_str("null");
    }
    for open in stack.iter().rev() {
        out.push(match open {
            '[' => ']',
            _ => '}',
        });
    }
    out
}

/// What a `"` inside a string is doing there.
enum QuoteRole {
    /// It ends the string, as JSON intends.
    Closes,
    /// It ends the string *and* the model forgot the comma after it: `{"a":"x" "b":"y"}`.
    ClosesMissingComma,
    /// It is a quote in the prose that the model forgot to escape.
    Inner,
}

/// Whether the `"` at `at` ends the string, ends it with a comma missing, or is prose.
///
/// Decided by what follows, because that is the only thing that distinguishes them:
///
/// - `:`, `}`, `]` or end of input — a closing quote, as written.
/// - `,` — a closing quote only if the comma is itself followed by the start of a key or a value.
///   `…", y se fue"` is prose; `…", "siguiente"` is not.
/// - `"` — ambiguous, and resolved by looking past the next quoted run: a run followed by `:` is a
///   **key**, which can only be there because the comma before it went missing. A run followed by
///   anything else is prose, which is what `"dijo "hola""` is.
/// - anything else — prose.
///
/// The array counterpart of the missing comma — `["a" "b"]` — is deliberately not inferred: with
/// no `:` to key off, it is indistinguishable from prose, and guessing would corrupt the far more
/// common case of a sentence with a quotation in it.
fn quote_role(chars: &[char], at: usize) -> QuoteRole {
    let skip_space = |mut from: usize| {
        while matches!(chars.get(from), Some(c) if c.is_whitespace()) {
            from += 1;
        }
        from
    };

    let next = skip_space(at + 1);
    match chars.get(next) {
        None | Some(':' | '}' | ']') => QuoteRole::Closes,
        Some(',') => {
            // Deliberately only the three that start a key, an object or an array. Numbers and
            // booleans can follow a comma too, but only inside an array of them — which none of
            // these schemas has — while prose after a comma starting with a digit is common
            // enough that accepting one would break more answers than it fixed.
            match chars.get(skip_space(next + 1)) {
                None | Some('"' | '{' | '[') => QuoteRole::Closes,
                _ => QuoteRole::Inner,
            }
        }
        Some('"') => {
            let mut scan = next + 1;
            while let Some(&c) = chars.get(scan) {
                match c {
                    '\\' => scan += 2,
                    '"' => break,
                    _ => scan += 1,
                }
            }
            match chars.get(skip_space(scan + 1)) {
                Some(':') => QuoteRole::ClosesMissingComma,
                _ => QuoteRole::Inner,
            }
        }
        _ => QuoteRole::Inner,
    }
}

/// Whether a member is about to start where JSON requires a comma first.
///
/// True when the last thing written was the end of a value rather than an opening brace, a comma
/// or a colon — which is exactly the shape of `{"a":1 "b":2}`.
fn needs_separator(out: &str) -> bool {
    match out.trim_end().chars().next_back() {
        None => false,
        Some('{' | '[' | ',' | ':') => false,
        Some(_) => true,
    }
}

/// Trailing whitespace and the comma behind it, if there is one.
fn drop_dangling_comma(out: &mut String) {
    while out.ends_with(char::is_whitespace) {
        out.pop();
    }
    if out.ends_with(',') {
        out.pop();
    }
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

    /// The bug this guards: a *finished* review whose own prose mentioned a rate limit was read
    /// as the provider refusing, so the analysis the user waited for was thrown away and shown
    /// to them as "you are out of quota". A model writing about limits is not a model being
    /// limited — on a successful run the refusal has to be the whole message.
    #[test]
    fn an_answer_that_merely_talks_about_limits_is_not_a_refusal() {
        let analysis = format!(
            "{{\"summary\":\"La búsqueda de citas no es una query local sino una llamada HTTP a \
             IRIS/SAP que tiene rate limit, y el módulo de billing queda fuera del alcance. {}\"}}",
            "Detalle adicional del análisis. ".repeat(20),
        );
        assert!(quota_signal(&analysis), "the phrases really are in there");
        assert!(!refusal_reply(&analysis));
    }

    /// The other side of the same line: a real refusal is short, and still has to be caught even
    /// when the CLI reports it on a run that exited cleanly.
    #[test]
    fn a_short_standalone_refusal_still_reads_as_one() {
        assert!(refusal_reply("Claude AI usage limit reached|1751234567"));
        assert!(refusal_reply("Error: Insufficient balance. Manage your billing here: https://x/billing"));
        assert!(!refusal_reply("error: unknown flag --nope"));
    }

    /// Every wrapper a model has actually put around "respond with JSON only".
    #[test]
    fn json_is_recovered_from_whatever_the_model_wrapped_it_in() {
        let fenced = "Aquí tienes las historias:\n```json\n{\"stories\": []}\n```\nEspero que sirva.";
        assert_eq!(json_answer(fenced).as_deref(), Some("{\"stories\": []}"));
        assert_eq!(json_answer("  {\"a\":{\"b\":1}}  ").as_deref(), Some("{\"a\":{\"b\":1}}"));
    }

    /// Reads a repaired answer the way the callers do, so a test that passes here is a stage that
    /// would have kept its run.
    fn parsed(text: &str) -> serde_json::Value {
        let json = json_answer(text).expect("there is an object in this answer");
        serde_json::from_str(&json).unwrap_or_else(|e| panic!("could not read {json}: {e}"))
    }

    /// A well-formed answer must come back byte for byte. Everything else in the salvage is only
    /// safe because it never runs on one.
    #[test]
    fn a_valid_answer_is_returned_untouched() {
        let good = r#"{"stories":[{"title":"Pagar","criteria":["Dado A\nCuando B"]}],"n":3,"ok":true}"#;
        let wrapped = format!("Aquí tienes:\n```json\n{good}\n```\nEspero que sirva.");
        let answer = json_answer(&wrapped).unwrap();
        assert_eq!(answer.as_ref(), good);
        assert!(matches!(answer, std::borrow::Cow::Borrowed(_)), "no copy is made of a valid answer");
    }

    /// The failure this whole path exists for, in the shape it arrives: a summary quoting the
    /// states it is talking about, with the quotes escaped in some places and not in others.
    #[test]
    fn a_quote_the_model_forgot_to_escape_is_escaped() {
        let broken = r#"{"summary":"Le falta el desempate cuando hay una "Por planificar" y otra "Planificado", y unificar qué es la "hora de liberación"","invest":[]}"#;
        let value = parsed(broken);
        let summary = value["summary"].as_str().expect("a summary survived");
        assert!(summary.contains("una \"Por planificar\" y otra \"Planificado\""));
        assert!(summary.ends_with("la \"hora de liberación\""), "the last quote closed the string");
        assert!(value["invest"].is_array());
    }

    /// The other half of the same decision: a quote that really does end the string, followed by
    /// the next key, must not be escaped into the value.
    #[test]
    fn a_quote_that_really_closes_the_string_is_left_alone() {
        let broken = r#"{"a":"uno "dos"","b":"tres","c":["x "y"","z"]}"#;
        let value = parsed(broken);
        assert_eq!(value["a"], "uno \"dos\"");
        assert_eq!(value["b"], "tres", "the key after the comma is still a key");
        assert_eq!(value["c"][0], "x \"y\"");
        assert_eq!(value["c"][1], "z", "the array did not lose its second element");
    }

    /// The comma between two members, dropped. Serde reports it as `expected ',' or '}'`, the same
    /// complaint an unescaped quote produces — which is why both have to be handled to make that
    /// message stop costing runs.
    #[test]
    fn a_missing_comma_between_members_is_put_back() {
        // After a string value, and after a number: two different rules, same fault.
        let value = parsed(r#"{"summary":"x" "invest":[] "n":1 "ok":true}"#);
        assert_eq!(value["summary"], "x");
        assert!(value["invest"].is_array(), "the second member was not swallowed by the first");
        assert_eq!(value["n"], 1);
        assert_eq!(value["ok"], true);
    }

    /// The other reading of the same two characters. A quoted phrase inside a sentence must stay
    /// inside it rather than being promoted into a key.
    #[test]
    fn a_quotation_inside_a_sentence_is_not_mistaken_for_a_missing_comma() {
        let value = parsed(r#"{"note":"el PO dijo "lo dejamos"","state":"listo"}"#);
        assert_eq!(value["note"], "el PO dijo \"lo dejamos\"");
        assert_eq!(value["state"], "listo");
    }

    /// Models write the newlines the text they are quoting had. JSON has no literal newline in a
    /// string, and serde says so with a different message from the quote case.
    #[test]
    fn literal_newlines_and_tabs_inside_strings_are_escaped() {
        let value = parsed("{\"gherkin\":\"Dado A\nCuando B\tEntonces C\"}");
        assert_eq!(value["gherkin"], "Dado A\nCuando B\tEntonces C");
    }

    /// An answer cut off at the token limit. Everything before the cut is worth more than the
    /// error the whole thing would otherwise become.
    #[test]
    fn a_truncated_answer_keeps_what_arrived() {
        let value = parsed(r#"{"tasks":[{"title":"Uno","detail":"listo"},{"title":"Dos","detail":"a med"#);
        assert_eq!(value["tasks"][0]["title"], "Uno");
        assert_eq!(value["tasks"][1]["detail"], "a med", "the half-written value is kept as it stands");

        // Cut on a dangling comma, and cut on a key with no value.
        assert_eq!(parsed(r#"{"criteria":["a","b","#)["criteria"][1], "b");
        assert!(parsed(r#"{"summary":"x","invest":"#)["invest"].is_null());
    }

    /// Trailing commas and JavaScript comments: neither is JSON, both turn up.
    #[test]
    fn trailing_commas_and_comments_are_dropped() {
        let value = parsed(
            "{\n  // el resumen\n  \"summary\": \"x\",\n  \"findings\": [1, 2,],\n}",
        );
        assert_eq!(value["summary"], "x");
        assert_eq!(value["findings"].as_array().unwrap().len(), 2);
    }

    /// Prose after the object must not be dragged in, and a `}` inside a string must not be
    /// mistaken for the end of it. `rfind('}')` alone gets one of these wrong either way.
    #[test]
    fn the_object_ends_where_the_object_ends() {
        let value = parsed(r#"{"note":"usa }} para cerrar"} Espero que te sirva. }"#);
        assert_eq!(value["note"], "usa }} para cerrar");
    }

    /// An answer with no object in it has to read as "no answer", and a brace that turned up in a
    /// sentence must never be inflated into an empty object the caller would report as a
    /// successful run of nothing.
    #[test]
    fn prose_is_never_salvaged_into_an_empty_object() {
        assert!(json_answer("no pude generar historias").is_none());
        assert!(json_answer("} desordenado {").is_none());
        // This one does carry a brace pair, so it comes back — but as the unreadable text it is,
        // which the caller quotes at the user. What it must not come back as is `{}`.
        let braced = json_answer("usa la sintaxis {clave} para interpolar").expect("a brace pair");
        assert!(serde_json::from_str::<serde_json::Value>(&braced).is_err());
        assert_ne!(braced.as_ref(), "{}");
    }

    /// Beyond repair is not the same as absent: the caller still needs the text to put in front of
    /// the user, and to hand to the model-driven repair pass behind it.
    #[test]
    fn an_unrepairable_answer_comes_back_whole_for_the_error() {
        let hopeless = r#"{"a": <sin valor>, "b": ???}"#;
        let answer = json_answer(hopeless).expect("there is an object here");
        assert!(serde_json::from_str::<serde_json::Value>(&answer).is_err());
        assert!(answer.contains("<sin valor>"), "the user is shown what the model actually wrote");
    }
}
