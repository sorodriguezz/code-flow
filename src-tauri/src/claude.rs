use serde::Deserialize;
use std::collections::BTreeMap;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Commit-message generation always runs on Haiku regardless of the user's configured
/// review model — it's a small, mechanical task that doesn't need a bigger model.
const COMMIT_MESSAGE_MODEL: &str = "claude-haiku-4-5-20251001";
const MAX_DIFF_CHARS: usize = 20_000;
const MAX_REVIEW_DIFF_CHARS: usize = 120_000;

/// Prefix the frontend looks for to render a dedicated "you're out of quota" notice
/// instead of a generic error banner.
const QUOTA_MARKER: &str = "QUOTA_EXCEEDED::";

const QUOTA_SIGNALS: [&str; 6] = [
    "usage limit",
    "rate limit",
    "quota exceeded",
    "resets at",
    "try again in",
    "limit reached",
];

#[derive(Deserialize)]
struct ClaudeCliResult {
    result: Option<String>,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    session_id: Option<String>,
    /// Token accounting keyed by the model id the CLI *actually* used. This is the only way to
    /// report a concrete version when no `--model` was passed and the CLI picked for itself.
    #[serde(default, rename = "modelUsage")]
    model_usage: BTreeMap<String, serde_json::Value>,
}

/// One finished Claude run: the reply plus the metadata a caller may want to keep.
#[derive(Debug)]
pub struct ClaudeRun {
    pub text: String,
    /// Session to `--resume` on the next turn of a multi-turn conversation.
    pub session_id: Option<String>,
    /// Model the CLI actually ran, when it reported exactly one. A turn that fanned out to
    /// several models (a subagent on a different one, say) is left as `None` rather than
    /// arbitrarily naming one of them — callers fall back to the configured setting.
    pub model: Option<String>,
}

fn model_used(parsed: &ClaudeCliResult) -> Option<String> {
    match parsed.model_usage.len() {
        1 => parsed.model_usage.keys().next().cloned(),
        _ => None,
    }
}

fn quota_signal(text: &str) -> bool {
    let lower = text.to_lowercase();
    QUOTA_SIGNALS.iter().any(|s| lower.contains(s))
}

/// macOS GUI apps inherit launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) rather
/// than the one from the user's shell profile, so a bare `claude` that resolves fine in a
/// terminal isn't found at all when CodeFlow is launched from Finder — while on Windows GUI
/// processes *do* get the user's full PATH, which is why this never showed up there. Prepend
/// the directories the Claude Code installers actually use so the lookup succeeds either way
/// (a `binary_path` that's already absolute ignores PATH and is unaffected).
#[cfg(not(target_os = "windows"))]
fn augment_path(cmd: &mut Command) {
    use std::path::PathBuf;

    let Some(home) = dirs::home_dir() else { return };
    let mut search: Vec<PathBuf> = vec![
        home.join(".local/bin"),
        home.join(".claude/local"),
        home.join(".bun/bin"),
        home.join("Library/pnpm"),
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

/// Shared subprocess plumbing for every headless Claude invocation: spawns the binary,
/// pipes `stdin_content` in, and interprets `--output-format json` output — including
/// detecting a quota/rate-limit failure so the frontend can show a dedicated notice
/// instead of a generic error banner. Returns the reply plus the session id Claude Code
/// assigned this run, so a caller doing multi-turn conversation (chat) can pass it back in via
/// `resume_session_id` on the next call, and the model that actually answered.
#[allow(clippy::too_many_arguments)]
async fn invoke_claude(
    binary_path: &str,
    prompt: &str,
    system_prompt: Option<&str>,
    model: &str,
    allowed_tools: &[String],
    cwd: Option<&str>,
    mcp_config_path: Option<&str>,
    stdin_content: &str,
    resume_session_id: Option<&str>,
) -> Result<ClaudeRun, String> {
    let mut cmd = Command::new(binary_path);
    cmd.arg("-p").arg(prompt);
    if let Some(sp) = system_prompt {
        cmd.arg("--append-system-prompt").arg(sp);
    }
    if !model.trim().is_empty() {
        cmd.arg("--model").arg(model);
    }
    cmd.arg("--output-format").arg("json");
    if !allowed_tools.is_empty() {
        cmd.arg("--allowedTools").arg(allowed_tools.join(","));
    }
    if let Some(path) = mcp_config_path {
        cmd.arg("--mcp-config").arg(path).arg("--strict-mcp-config");
    }
    if let Some(id) = resume_session_id {
        cmd.arg("--resume").arg(id);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    augment_path(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch '{binary_path}': {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_content.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
    interpret_output(
        output.status.success(),
        &output.status.to_string(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

/// Turns one finished `claude --output-format json` run into either its reply text (plus the
/// session id) or an error message for the frontend.
///
/// Under `--output-format json` the CLI reports its *own* failures on stdout — as
/// `{"is_error":true,"result":"<reason>"}` — and exits non-zero leaving stderr **empty**. So
/// stdout has to be parsed before the exit status is judged: branching on the status first and
/// reporting stderr discarded the only copy of the reason (expired auth, unknown model, …) and
/// left the user staring at a bare "claude exited with an error:" with nothing after it.
fn interpret_output(
    success: bool,
    status_label: &str,
    stdout: &str,
    stderr: &str,
) -> Result<ClaudeRun, String> {
    let parsed = serde_json::from_str::<ClaudeCliResult>(stdout).ok();
    let result_text = parsed
        .as_ref()
        .and_then(|p| p.result.as_deref())
        .map(str::trim)
        .filter(|t| !t.is_empty());

    if let Some(text) = result_text {
        if quota_signal(text) {
            return Err(format!("{QUOTA_MARKER}{text}"));
        }
        if !success || parsed.as_ref().is_some_and(|p| p.is_error) {
            return Err(text.to_string());
        }
        let model = parsed.as_ref().and_then(model_used);
        return Ok(ClaudeRun {
            text: text.to_string(),
            session_id: parsed.and_then(|p| p.session_id),
            model,
        });
    }

    if !success {
        if quota_signal(stderr) {
            return Err(format!("{QUOTA_MARKER}{}", stderr.trim()));
        }
        if quota_signal(stdout) {
            return Err(format!("{QUOTA_MARKER}{}", stdout.trim()));
        }
        // Neither stream carried a usable message — report the exit status rather than an
        // error string that trails off into nothing.
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("sin salida en stdout ni stderr");
        return Err(format!("claude exited with an error ({status_label}): {detail}"));
    }

    let fallback = stdout.trim();
    if fallback.is_empty() {
        return Err("claude produced no output".to_string());
    }
    if quota_signal(fallback) {
        return Err(format!("{QUOTA_MARKER}{fallback}"));
    }
    Ok(ClaudeRun { text: fallback.to_string(), session_id: None, model: None })
}

pub async fn generate_commit_message(binary_path: &str, diff: &str, prompt_template: &str) -> Result<String, String> {
    if diff.trim().is_empty() {
        return Err("No staged changes to summarize".to_string());
    }

    let truncated: String = diff.chars().take(MAX_DIFF_CHARS).collect();
    let prompt = if prompt_template.trim().is_empty() {
        DEFAULT_COMMIT_TEMPLATE
    } else {
        prompt_template
    };

    let run =
        invoke_claude(binary_path, prompt, None, COMMIT_MESSAGE_MODEL, &[], None, None, &truncated, None).await?;
    Ok(run.text)
}

/// Reviews a pull request's diff with the user's configured review model/tools, folding
/// in the workspace's enabled review contexts/MD instructions as extra background. Returns
/// a Markdown review body — nothing gets posted to Azure DevOps here, that's a separate
/// explicit step.
#[allow(clippy::too_many_arguments)]
pub async fn review_pull_request(
    binary_path: &str,
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

    let run = invoke_claude(
        binary_path,
        prompt,
        None,
        model,
        allowed_tools,
        Some(cwd),
        mcp_config_path,
        &stdin_payload,
        None,
    )
    .await?;
    // Prefer what the CLI reports it actually ran over what was configured — they differ
    // whenever `model` is empty and the CLI picked its own default.
    Ok(stamp_footer(&run.text, "pr-review", run.model.as_deref().unwrap_or(model)))
}

/// Claude can't reliably know the real wall-clock time or which model string it was
/// actually launched with, so the app stamps this footer on itself rather than asking the
/// prompt to fabricate it.
fn stamp_footer(body: &str, kind: &str, model: &str) -> String {
    let model_label = if model.trim().is_empty() { "modelo predeterminado" } else { model };
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
    format!("{body}\n\n---\n🤖 Análisis automatizado ({kind}) · Claude Code ({model_label}) · {timestamp}")
}

/// Scans the working directory's not-yet-committed diff for bugs/vulnerabilities/perf
/// issues before the user commits — same idea as `review_pull_request` but scoped to local
/// changes instead of a PR, and with no title/description to fold in.
#[allow(clippy::too_many_arguments)]
pub async fn analyze_changes(
    binary_path: &str,
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

    let run = invoke_claude(
        binary_path,
        prompt,
        None,
        model,
        allowed_tools,
        Some(cwd),
        mcp_config_path,
        &stdin_payload,
        None,
    )
    .await?;
    Ok(stamp_footer(&run.text, "análisis pre-commit", run.model.as_deref().unwrap_or(model)))
}

const DEFAULT_CHAT_SYSTEM_PROMPT: &str =
    "Eres el asistente de IA integrado en CodeFlow, un cliente Git de escritorio. Estás \
     conversando con el usuario sobre el repositorio que tiene abierto — usa las herramientas \
     disponibles (leer archivos, buscar código, revisar el estado de git, etc.) cuando haga \
     falta para responder con precisión en lugar de adivinar. Responde en el mismo idioma en \
     el que te escribe el usuario. Sé conciso y directo: esto es una conversación, no un \
     reporte formal — no uses el formato de hallazgos estructurados que usarías en una revisión \
     de PR a menos que el usuario lo pida explícitamente.";

/// Open-ended, multi-turn chat about the currently open repository — unlike
/// `review_pull_request`/`analyze_changes` this isn't a one-shot "analyze this diff" call, so
/// it resumes the same Claude Code session across turns (via `session_id`) instead of
/// re-explaining the whole conversation from scratch every message.
#[allow(clippy::too_many_arguments)]
pub async fn chat_with_repo(
    binary_path: &str,
    model: &str,
    contexts: &[(String, String)],
    message: &str,
    session_id: Option<&str>,
    allowed_tools: &[String],
    cwd: &str,
    mcp_config_path: Option<&str>,
) -> Result<ClaudeRun, String> {
    // Project context and the system prompt only need to be established once — a resumed
    // session already carries the earlier turns (and Claude's own system prompt) forward.
    // `-p` below carries the user's actual message; stdin is just the one-time context, same
    // division of labor as `review_pull_request`/`analyze_changes` (stdin = data, `-p` = ask).
    let is_first_turn = session_id.is_none();
    let mut stdin_payload = String::new();
    if is_first_turn && !contexts.is_empty() {
        stdin_payload.push_str("PROJECT CONTEXT:\n");
        for (name, content) in contexts {
            stdin_payload.push_str(&format!("- {name}: {content}\n"));
        }
    }

    let system_prompt = if is_first_turn { Some(DEFAULT_CHAT_SYSTEM_PROMPT) } else { None };

    invoke_claude(
        binary_path,
        message,
        system_prompt,
        model,
        allowed_tools,
        Some(cwd),
        mcp_config_path,
        &stdin_payload,
        session_id,
    )
    .await
}

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

/// Applies a single code-review finding's fix directly to the working tree — unlike every
/// other Claude invocation in this file (review/analyze/chat), this one needs write access,
/// so it always runs with a fixed `Read/Edit/Write/Grep/Glob` tool set regardless of the
/// user's general chat `allowedTools` setting (that setting is for the read-only chat/review
/// flows; clicking "fix with AI" is itself the write-access opt-in for this one action).
pub async fn apply_finding_fix(
    binary_path: &str,
    model: &str,
    finding_prompt: &str,
    cwd: &str,
) -> Result<String, String> {
    let allowed_tools = [
        "Read".to_string(),
        "Edit".to_string(),
        "Write".to_string(),
        "Grep".to_string(),
        "Glob".to_string(),
    ];
    let run = invoke_claude(
        binary_path,
        "Aplica la corrección para el hallazgo entregado por stdin.",
        Some(FIX_FINDING_SYSTEM_PROMPT),
        model,
        &allowed_tools,
        Some(cwd),
        None,
        finding_prompt,
        None,
    )
    .await?;
    Ok(run.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real payload from a failing `claude -p … --output-format json` run on macOS: exit
    /// status 1, **empty stderr**, and the actual reason only present on stdout. The old
    /// status-first branch reported stderr here, which is what produced the truncated
    /// "claude exited with an error:" the user saw.
    const FAILED_RUN_STDOUT: &str = r#"{"is_error":true,"stop_reason":"stop_sequence",
        "session_id":"8c166654-4807-4d62-a1d7-33909c2efd55","subtype":"success",
        "result":"Failed to authenticate: OAuth session expired and could not be refreshed"}"#;

    #[test]
    fn surfaces_the_reason_json_carries_when_stderr_is_empty() {
        let err = interpret_output(false, "exit status: 1", FAILED_RUN_STDOUT, "").unwrap_err();
        assert_eq!(
            err,
            "Failed to authenticate: OAuth session expired and could not be refreshed"
        );
    }

    #[test]
    fn falls_back_to_the_exit_status_when_nothing_explains_the_failure() {
        let err = interpret_output(false, "exit status: 127", "", "").unwrap_err();
        assert_eq!(
            err,
            "claude exited with an error (exit status: 127): sin salida en stdout ni stderr"
        );
    }

    #[test]
    fn a_quota_failure_still_gets_the_marker_the_frontend_looks_for() {
        let stdout = r#"{"is_error":true,"result":"Claude usage limit reached, resets at 5pm"}"#;
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    #[test]
    fn a_successful_run_still_returns_the_reply_and_session_id() {
        let stdout = r#"{"is_error":false,"session_id":"abc-123","result":"  feat: add thing  "}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.text, "feat: add thing");
        assert_eq!(run.session_id.as_deref(), Some("abc-123"));
    }

    #[test]
    fn non_json_stdout_on_a_clean_exit_is_passed_through() {
        let run = interpret_output(true, "exit status: 0", "plain text\n", "").unwrap();
        assert_eq!(run.text, "plain text");
        assert_eq!(run.session_id, None);
        assert_eq!(run.model, None);
    }

    /// The whole point of reading `modelUsage`: with no `--model` passed the CLI picks its own
    /// model, and this is the only place the run says which one it actually was.
    #[test]
    fn reports_the_model_the_cli_actually_ran() {
        let stdout = r#"{"result":"ok","modelUsage":{"claude-opus-4-8":{"outputTokens":12}}}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.model.as_deref(), Some("claude-opus-4-8"));
    }

    /// A turn that fanned out across models has no single honest answer, so it reports none
    /// and the UI falls back to whatever is configured.
    #[test]
    fn stays_silent_when_more_than_one_model_ran() {
        let stdout =
            r#"{"result":"ok","modelUsage":{"claude-opus-4-8":{},"claude-haiku-4-5-20251001":{}}}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.model, None);
    }

    /// Older/edge payloads simply omit the field — that must not break parsing.
    #[test]
    fn a_missing_model_usage_field_is_not_an_error() {
        let stdout = r#"{"result":"ok","session_id":"s1"}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.model, None);
        assert_eq!(run.text, "ok");
    }
}
