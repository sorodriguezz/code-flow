//! Deterministic (regex-based) secret scanner for the pre-commit gate.
//!
//! This is intentionally NOT the `secrets` module (that one stores the user's own PATs/tokens in
//! the OS keyring). Here we look at the *staged diff* and flag credentials the user is about to
//! commit — API keys, tokens, private keys, hardcoded passwords.
//!
//! Design choices:
//! - **Only added lines** (`origin == "+"`) are scanned. A secret sitting in a context line was
//!   already in the repo; this gate is about what *this* commit introduces.
//! - **Regex, not AI**: fast, offline, free, and deterministic — no false "looks clean" from a
//!   model. An optional AI confirmation pass can layer on later without changing this contract.
//! - One hit per line at most, to keep the report readable.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::git::diff::FileDiffInfo;

/// A single credential-looking match found in the staged diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretHit {
    /// Repo-relative path of the file the match is in.
    pub file: String,
    /// 1-based line number in the new file (0 if libgit2 didn't report one).
    pub line: u32,
    /// Stable rule id (e.g. `"github-token"`) — safe to match on in the UI.
    pub rule: String,
    /// Human-readable rule label (technical proper-noun names, left untranslated).
    pub rule_name: String,
    /// `"critical"` or `"warning"` — drives the severity color in the UI.
    pub severity: String,
    /// Masked snippet of the matched value — enough to recognize it, not enough to leak it.
    pub preview: String,
}

struct Rule {
    id: &'static str,
    name: &'static str,
    severity: &'static str,
    /// When true, the matched value is run through [`is_placeholder`] and skipped if it looks
    /// like a template/example rather than a real secret. Only the noisy generic rule sets this.
    check_placeholder: bool,
    re: Regex,
}

impl Rule {
    fn new(id: &'static str, name: &'static str, severity: &'static str, pattern: &str) -> Rule {
        Rule {
            id,
            name,
            severity,
            check_placeholder: false,
            // Patterns are static and covered by tests; a compile failure is a programmer error.
            re: Regex::new(pattern).unwrap_or_else(|e| panic!("bad secret regex '{id}': {e}")),
        }
    }
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let mut generic = Rule::new(
            "hardcoded-secret",
            "Hardcoded secret assignment",
            "warning",
            r#"(?i)(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token)\s*[:=]\s*['"](?P<val>[^'"\n]{8,})['"]"#,
        );
        generic.check_placeholder = true;

        vec![
            Rule::new(
                "private-key",
                "Private key (PEM)",
                "critical",
                r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----",
            ),
            Rule::new("aws-access-key", "AWS access key id", "critical", r"\bAKIA[0-9A-Z]{16}\b"),
            Rule::new(
                "aws-secret-key",
                "AWS secret access key",
                "critical",
                r#"(?i)aws_secret_access_key\s*[:=]\s*['"]?(?P<val>[A-Za-z0-9/+=]{40})['"]?"#,
            ),
            Rule::new(
                "github-token",
                "GitHub token",
                "critical",
                r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b",
            ),
            Rule::new("github-pat", "GitHub fine-grained PAT", "critical", r"\bgithub_pat_[A-Za-z0-9_]{22,}\b"),
            // `glpat-` prefixes every GitLab personal access token, and a project one as well.
            // Without this a leaked GitLab token walks past a scan that catches its GitHub
            // equivalent — and CodeFlow now asks users to create one.
            Rule::new("gitlab-pat", "GitLab access token", "critical", r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
            Rule::new("google-api-key", "Google API key", "critical", r"\bAIza[0-9A-Za-z\-_]{35}\b"),
            Rule::new("slack-token", "Slack token", "critical", r"\bxox[baprs]-[0-9A-Za-z-]{10,48}\b"),
            Rule::new(
                "slack-webhook",
                "Slack webhook URL",
                "warning",
                r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+",
            ),
            Rule::new("stripe-secret-key", "Stripe secret key", "critical", r"\bsk_live_[0-9A-Za-z]{16,}\b"),
            Rule::new("stripe-restricted-key", "Stripe restricted key", "critical", r"\brk_live_[0-9A-Za-z]{16,}\b"),
            Rule::new("openai-key", "OpenAI API key", "critical", r"\bsk-proj-[A-Za-z0-9_-]{20,}\b"),
            Rule::new("npm-token", "npm access token", "critical", r"\bnpm_[A-Za-z0-9]{36}\b"),
            Rule::new(
                "azure-storage-key",
                "Azure storage account key",
                "critical",
                r"(?i)AccountKey=[A-Za-z0-9+/=]{40,}",
            ),
            Rule::new(
                "jwt",
                "JSON Web Token (JWT)",
                "warning",
                r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
            ),
            generic,
        ]
    })
}

/// Values that look like templates/examples rather than real secrets — cuts most of the noise
/// from the generic assignment rule (`token = "your-token-here"`, `secret = "${ENV_VAR}"`, …).
fn is_placeholder(v: &str) -> bool {
    if v.contains("${") || v.contains("{{") || v.contains("process.env") || v.contains("os.environ") || v.contains("getenv") {
        return true;
    }
    let lower = v.to_lowercase();
    const NEEDLES: [&str; 9] =
        ["example", "changeme", "placeholder", "your-", "your_", "yourtoken", "xxxx", "todo", "<"];
    NEEDLES.iter().any(|n| lower.contains(n))
}

/// Masks a matched value so the report shows its shape without exposing the credential.
fn mask(matched: &str) -> String {
    let t = matched.trim();
    let n = t.chars().count();
    if n <= 6 {
        return "•".repeat(n.max(3));
    }
    let head: String = t.chars().take(3).collect();
    let tail: String = t.chars().skip(n - 2).collect();
    let dots = (n - 5).min(16);
    format!("{head}{}{tail}", "•".repeat(dots))
}

/// Scans the added lines of a staged diff and returns every credential-looking match.
pub fn scan_diff(files: &[FileDiffInfo]) -> Vec<SecretHit> {
    let rules = rules();
    let mut hits = Vec::new();
    for file in files {
        let path = file.new_path.as_deref().or(file.old_path.as_deref()).unwrap_or("?");
        for hunk in &file.hunks {
            for line in &hunk.lines {
                // Only newly-added content — context/removed lines aren't what we're committing.
                if line.origin != "+" {
                    continue;
                }
                for rule in rules {
                    let Some(caps) = rule.re.captures(&line.content) else {
                        continue;
                    };
                    let whole = caps.get(0).unwrap();
                    let value = caps.name("val").map(|m| m.as_str()).unwrap_or_else(|| whole.as_str());
                    if rule.check_placeholder && is_placeholder(value) {
                        continue;
                    }
                    hits.push(SecretHit {
                        file: path.to_string(),
                        line: line.new_lineno.unwrap_or(0),
                        rule: rule.id.to_string(),
                        rule_name: rule.name.to_string(),
                        severity: rule.severity.to_string(),
                        preview: mask(value),
                    });
                    // One hit per line keeps the report readable.
                    break;
                }
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::{DiffHunkInfo, DiffLine};

    fn added(content: &str) -> FileDiffInfo {
        FileDiffInfo {
            old_path: None,
            new_path: Some("config.ts".into()),
            status: "modified".into(),
            binary: false,
            hunks: vec![DiffHunkInfo {
                header: "@@".into(),
                lines: vec![DiffLine {
                    origin: "+".into(),
                    content: content.into(),
                    old_lineno: None,
                    new_lineno: Some(42),
                }],
            }],
        }
    }

    fn context(content: &str) -> FileDiffInfo {
        let mut f = added(content);
        f.hunks[0].lines[0].origin = " ".into();
        f
    }

    #[test]
    fn detects_github_token() {
        let hits = scan_diff(&[added("const t = \"ghp_0123456789abcdefghijklmnopqrstuvwxyz\";")]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rule, "github-token");
        assert_eq!(hits[0].line, 42);
        assert!(!hits[0].preview.contains("0123456789")); // masked
    }

    /// The GitLab equivalent, which the app now asks users to create — so a staged one has to be
    /// caught the same way a staged GitHub token is.
    #[test]
    fn detects_gitlab_token() {
        // Built at runtime so the full literal never lands in the source: written whole, GitHub's
        // push protection blocks every push of this repo as if the fixture were a live token.
        let token = format!("glpat-{}", "AbCdEf1234567890xyzQ");
        let hits = scan_diff(&[added(&format!("GITLAB_TOKEN={token}"))]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rule, "gitlab-pat");
        assert!(!hits[0].preview.contains("AbCdEf1234567890"), "the token must be masked");
    }

    /// `glpat-` on its own is a prefix, not a credential — flagging every mention of it would
    /// train people to click past the warning that matters.
    #[test]
    fn a_bare_gitlab_prefix_is_not_a_token() {
        assert!(scan_diff(&[added("// tokens start with glpat-")]).is_empty());
    }

    #[test]
    fn detects_aws_and_private_key() {
        assert_eq!(scan_diff(&[added("key = AKIAIOSFODNN7EXAMPLE")]).len(), 1);
        assert_eq!(scan_diff(&[added("-----BEGIN RSA PRIVATE KEY-----")]).len(), 1);
    }

    #[test]
    fn ignores_context_lines() {
        assert!(scan_diff(&[context("const t = \"ghp_0123456789abcdefghijklmnopqrstuvwxyz\";")]).is_empty());
    }

    #[test]
    fn skips_placeholders() {
        assert!(scan_diff(&[added("password = \"your-password-here\"")]).is_empty());
        assert!(scan_diff(&[added("token = \"${GITHUB_TOKEN}\"")]).is_empty());
    }

    #[test]
    fn flags_real_hardcoded_password() {
        let hits = scan_diff(&[added("password = \"hunter2correcthorse\"")]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rule, "hardcoded-secret");
        assert_eq!(hits[0].severity, "warning");
    }

    #[test]
    fn clean_line_has_no_hits() {
        assert!(scan_diff(&[added("const total = a + b; // sums the values")]).is_empty());
    }
}
