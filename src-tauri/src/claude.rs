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
    "You are reviewing a pull request. Read the PR title, description, project-specific \
     review context, and diff piped on stdin, then write a concise code review in Markdown: \
     a short summary, then a bulleted list of concrete issues (bugs, risks, style problems), \
     each pointing at the relevant file. Call out anything you'd block the PR on. If \
     everything looks fine, say so briefly instead of inventing nitpicks. Do not restate \
     the whole diff back.";

/// Shared subprocess plumbing for every headless Claude invocation: spawns the binary,
/// pipes `stdin_content` in, and interprets `--output-format json` output — including
/// detecting a quota/rate-limit failure so the frontend can show a dedicated notice
/// instead of a generic error banner.
async fn invoke_claude(
    binary_path: &str,
    prompt: &str,
    model: &str,
    allowed_tools: &[String],
    cwd: Option<&str>,
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

    invoke_claude(binary_path, prompt, COMMIT_MESSAGE_MODEL, &[], None, &truncated).await
}

/// Reviews a pull request's diff with the user's configured review model/tools, folding
/// in the project's enabled review contexts as extra background. Returns a Markdown
/// review body — nothing gets posted to Azure DevOps here, that's a separate explicit step.
pub async fn review_pull_request(
    binary_path: &str,
    model: &str,
    pr_title: &str,
    pr_description: &str,
    contexts: &[(String, String)],
    diff_text: &str,
    allowed_tools: &[String],
    cwd: &str,
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

    invoke_claude(binary_path, DEFAULT_REVIEW_PROMPT, model, allowed_tools, Some(cwd), &stdin_payload).await
}
