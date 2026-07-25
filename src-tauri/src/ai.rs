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

use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const MAX_DIFF_CHARS: usize = 20_000;
pub const MAX_REVIEW_DIFF_CHARS: usize = 120_000;

/// Prefix the frontend looks for to render a dedicated "you're out of quota" notice instead of
/// a generic error banner. Both engines emit it, so it lives here.
pub const QUOTA_MARKER: &str = "QUOTA_EXCEEDED::";

const QUOTA_SIGNALS: [&str; 6] = [
    "usage limit",
    "rate limit",
    "quota exceeded",
    "resets at",
    "try again in",
    "limit reached",
];

/// Whether a CLI's message reads like a quota/rate-limit refusal rather than a genuine error —
/// shared by every engine's output interpreter.
pub(crate) fn quota_signal(text: &str) -> bool {
    let lower = text.to_lowercase();
    QUOTA_SIGNALS.iter().any(|s| lower.contains(s))
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
}

/// Resolves the engine for a provider id. Unknown/empty ids fall back to Claude so a corrupt or
/// missing `ai_provider` setting can never leave the app with no working engine.
pub fn engine_for(provider: &str) -> Box<dyn AiEngine> {
    match provider {
        "gemini" => Box::new(crate::gemini::GeminiEngine),
        _ => Box::new(crate::claude::ClaudeEngine),
    }
}

/// macOS GUI apps inherit launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) rather than
/// the one from the user's shell profile, so a bare `claude`/`gemini` that resolves fine in a
/// terminal isn't found at all when CodeFlow is launched from Finder — while on Windows GUI
/// processes *do* get the user's full PATH, which is why this never showed up there. Prepend the
/// directories the CLI installers actually use (npm/bun/pnpm globals, Homebrew) so the lookup
/// succeeds either way (a `binary_path` that's already absolute ignores PATH and is unaffected).
#[cfg(not(target_os = "windows"))]
fn augment_path(cmd: &mut Command) {
    use std::path::PathBuf;

    let Some(home) = dirs::home_dir() else { return };
    let mut search: Vec<PathBuf> = vec![
        home.join(".local/bin"),
        home.join(".claude/local"),
        home.join(".bun/bin"),
        home.join("Library/pnpm"),
        home.join(".npm-global/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(current) = std::env::var_os("PATH") {
        search.extend(std::env::split_paths(&current));
    }
    if let Ok(joined) = std::env::join_paths(search) {
        cmd.env("PATH", joined);
    }
}

#[cfg(target_os = "windows")]
fn augment_path(_cmd: &mut Command) {}

/// Shared subprocess plumbing for every headless AI invocation: builds the engine's command,
/// pipes `stdin_content` in, waits for it, and hands the output back to the engine to interpret.
async fn run(engine: &dyn AiEngine, binary: &str, inv: AiInvocation<'_>) -> Result<AiRun, String> {
    let mut cmd = engine.build_command(binary, &inv);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    augment_path(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch '{binary}': {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(inv.stdin_content.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
    engine.interpret(
        output.status.success(),
        &output.status.to_string(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

/// The engine can't reliably know the real wall-clock time or which model string it was actually
/// launched with, so the app stamps this footer on itself rather than asking the prompt to
/// fabricate it. `label` is the engine's display name (e.g. "Claude Code" / "Gemini").
fn stamp_footer(body: &str, kind: &str, label: &str, model: &str) -> String {
    let model_label = if model.trim().is_empty() { "modelo predeterminado" } else { model };
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
    format!("{body}\n\n---\n🤖 Análisis automatizado ({kind}) · {label} ({model_label}) · {timestamp}")
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

/// Reviews a pull request's diff with the active engine, folding in the workspace's enabled
/// review contexts/MD instructions as extra background. Returns a Markdown review body —
/// nothing gets posted to the VCS host here, that's a separate explicit step.
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

    let prompt = if prompt_template.trim().is_empty() {
        DEFAULT_REVIEW_PROMPT
    } else {
        prompt_template
    };

    let mut inv = AiInvocation::new(prompt, &stdin_payload);
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
    // is just the one-time context (stdin = data, `-p` = ask).
    let is_first_turn = session_id.is_none();
    let mut stdin_payload = String::new();
    if is_first_turn && !contexts.is_empty() {
        stdin_payload.push_str("PROJECT CONTEXT:\n");
        for (name, content) in contexts {
            stdin_payload.push_str(&format!("- {name}: {content}\n"));
        }
    }

    let system_prompt = if is_first_turn { Some(DEFAULT_CHAT_SYSTEM_PROMPT) } else { None };

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
