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
     Para cada problema real que encuentres (bugs, riesgos de seguridad, rendimiento, \
     integración, estilo importante — no inventes hallazgos triviales si el código está bien), \
     responde en Markdown con EXACTAMENTE este formato, uno por hallazgo, en este orden:\n\n\
     ### {emoji} [{Severidad} · {Tipo}] {Categoría corta} · F-{número correlativo de 3 dígitos}\n\n\
     {Un subtítulo de una línea, algo más largo que el título, describiendo el problema puntual}\n\n\
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
     - Sé específico y cita archivos/líneas reales del diff — no generalices.\n\
     - No repitas el diff completo ni resumas cambios que no son problemáticos.\n\
     - Si no encuentras ningún problema real, dilo brevemente en un par de líneas con ✅, sin \
     inventar hallazgos ni usar la plantilla anterior.";

/// Shared subprocess plumbing for every headless Claude invocation: spawns the binary,
/// pipes `stdin_content` in, and interprets `--output-format json` output — including
/// detecting a quota/rate-limit failure so the frontend can show a dedicated notice
/// instead of a generic error banner.
#[allow(clippy::too_many_arguments)]
async fn invoke_claude(
    binary_path: &str,
    prompt: &str,
    model: &str,
    allowed_tools: &[String],
    cwd: Option<&str>,
    mcp_config_path: Option<&str>,
    stdin_content: &str,
) -> Result<String, String> {
    let mut cmd = Command::new(binary_path);
    cmd.arg("-p").arg(prompt);
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
                return Ok(trimmed.to_string());
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
    Ok(fallback.to_string())
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

    invoke_claude(binary_path, prompt, COMMIT_MESSAGE_MODEL, &[], None, None, &truncated).await
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

    let review =
        invoke_claude(binary_path, prompt, model, allowed_tools, Some(cwd), mcp_config_path, &stdin_payload).await?;

    // Claude can't reliably know the real wall-clock time or which model string it was
    // actually launched with, so the app stamps that footer on itself rather than asking
    // the prompt to fabricate it.
    let model_label = if model.trim().is_empty() { "modelo predeterminado" } else { model };
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M");
    Ok(format!(
        "{review}\n\n---\n🤖 Revisión automatizada (pr-review) · Claude Code ({model_label}) · {timestamp}"
    ))
}
