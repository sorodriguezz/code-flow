use serde::Deserialize;
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
}

fn quota_signal(text: &str) -> bool {
    let lower = text.to_lowercase();
    QUOTA_SIGNALS.iter().any(|s| lower.contains(s))
}

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
/// instead of a generic error banner. Returns the reply text plus the session id Claude
/// Code assigned this run, so a caller doing multi-turn conversation (chat) can pass it
/// back in via `resume_session_id` on the next call.
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
) -> Result<(String, Option<String>), String> {
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
    let stdout = String::from_utf8_lossy(&output.stdout);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if quota_signal(&stderr) {
            return Err(format!("{QUOTA_MARKER}{}", stderr.trim()));
        }
        if quota_signal(&stdout) {
            return Err(format!("{QUOTA_MARKER}{}", stdout.trim()));
        }
        return Err(format!("claude exited with an error: {stderr}"));
    }

    if let Ok(parsed) = serde_json::from_str::<ClaudeCliResult>(&stdout) {
        if let Some(text) = &parsed.result {
            let trimmed = text.trim();
            if parsed.is_error || quota_signal(trimmed) {
                if quota_signal(trimmed) {
                    return Err(format!("{QUOTA_MARKER}{trimmed}"));
                }
                return Err(trimmed.to_string());
            }
            if !trimmed.is_empty() {
                return Ok((trimmed.to_string(), parsed.session_id.clone()));
            }
        }
    }

    let fallback = stdout.trim();
    if fallback.is_empty() {
        return Err("claude produced no output".to_string());
    }
    if quota_signal(fallback) {
        return Err(format!("{QUOTA_MARKER}{fallback}"));
    }
    Ok((fallback.to_string(), None))
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

    let (text, _) =
        invoke_claude(binary_path, prompt, None, COMMIT_MESSAGE_MODEL, &[], None, None, &truncated, None).await?;
    Ok(text)
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

    let (review, _) = invoke_claude(
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
    Ok(stamp_footer(&review, "pr-review", model))
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

    let (result, _) = invoke_claude(
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
    Ok(stamp_footer(&result, "análisis pre-commit", model))
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
) -> Result<(String, Option<String>), String> {
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
    let (text, _) = invoke_claude(
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
    Ok(text)
}
