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
    /// like a template/example rather than a real secret. Only the noisy generic rules set this.
    check_placeholder: bool,
    /// When true, a value that cannot be a credential — a number, a boolean — is skipped too. For
    /// the unquoted `.env` rule, where `API_TOKEN_TTL=3600`-shaped lines would otherwise dominate.
    skip_trivial: bool,
    re: Regex,
}

impl Rule {
    fn new(id: &'static str, name: &'static str, severity: &'static str, pattern: &str) -> Rule {
        Rule {
            id,
            name,
            severity,
            check_placeholder: false,
            skip_trivial: false,
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

        // The same idea for `.env` files and shell exports, where the value carries no quotes and the
        // quoted rule above never sees it: `DB_PASSWORD=hunter2`, `export API_KEY=abc…`.
        //
        // Narrower than the quoted rule on purpose, because unquoted `NAME=value` is also what half
        // the code in the world looks like. The whole line must be the assignment; the name must be
        // UPPER_SNAKE (the env convention) and *end* in the sensitive word, so `API_KEY` and
        // `STRIPE_SECRET_KEY` count while `TOKEN_TTL` and `PASSWORD_MIN_LENGTH` do not; and the value
        // must be one token of credential-ish characters — a call, an index or a variable
        // (`get_secret()`, `env["X"]`, `$X`) cannot match at all.
        let mut dotenv = Rule::new(
            "dotenv-secret",
            "Secret in an environment assignment",
            "warning",
            r#"^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|PASS|PWD|SECRET|SECRET_KEY|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_SECRET|CREDENTIALS?)\s*=\s*(?P<val>[A-Za-z0-9_\-+/=.:@!%^&*~,]{4,})\s*(?:#.*)?$"#,
        );
        dotenv.check_placeholder = true;
        dotenv.skip_trivial = true;

        // A password spelled into a URL: `https://user:pass@example.com`, `postgres://app:pw@db:5432`.
        // Only the password half is the secret, so that is what the preview masks; a URL with just a
        // user (`ssh://git@example.com`) has none and does not match.
        let mut url = Rule::new(
            "url-credentials",
            "Credentials in a URL",
            "warning",
            r#"(?i)\b[a-z][a-z0-9+.\-]*://[^\s:/@'"]+:(?P<val>[^\s@/'"]+)@[^\s/'"@]+"#,
        );
        url.check_placeholder = true;

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
            // `sk-ant-api03-…`, `sk-ant-admin01-…`: every Anthropic key carries this prefix.
            Rule::new("anthropic-key", "Anthropic API key", "critical", r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
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
            dotenv,
            url,
        ]
    })
}

/// Values that look like templates/examples rather than real secrets — cuts most of the noise
/// from the generic assignment rules (`token = "your-token-here"`, `secret = "${ENV_VAR}"`,
/// `API_KEY=<your-key>`, `postgres://user:password@localhost`, …).
fn is_placeholder(v: &str) -> bool {
    if v.contains("${") || v.contains("{{") || v.contains("process.env") || v.contains("os.environ") || v.contains("getenv") {
        return true;
    }
    // `$DB_PASSWORD` is a reference to the secret, not the secret.
    if v.starts_with('$') {
        return true;
    }
    let lower = v.to_lowercase();
    const NEEDLES: [&str; 12] = [
        "example", "changeme", "placeholder", "your-", "your_", "yourtoken", "xxx", "todo", "<", "redacted", "dummy",
        "replace",
    ];
    if NEEDLES.iter().any(|n| lower.contains(n)) {
        return true;
    }
    // The word standing in for itself — `user:password@host` in every README.
    const STAND_INS: [&str; 6] = ["password", "passwd", "pass", "secret", "token", "pwd"];
    if STAND_INS.contains(&lower.as_str()) {
        return true;
    }
    // One character repeated — `********`, `........`, `0000`.
    let mut chars = v.chars();
    chars.next().is_some_and(|first| chars.all(|c| c == first))
}

/// A value no credential looks like: a number, a boolean, a null.
fn is_trivial(v: &str) -> bool {
    let lower = v.to_lowercase();
    v.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-')
        || matches!(lower.as_str(), "true" | "false" | "yes" | "no" | "on" | "off" | "null" | "none" | "nil")
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
                    if rule.skip_trivial && is_trivial(value) {
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

    fn rule_of(line: &str) -> Option<String> {
        scan_diff(&[added(line)]).first().map(|h| h.rule.clone())
    }

    /// `.env` files and shell exports carry no quotes, and the quoted rule never saw them.
    #[test]
    fn detects_unquoted_env_assignments() {
        for line in [
            "API_KEY=abcd1234efgh5678",
            "DB_PASSWORD=hunter2correct",
            "export STRIPE_SECRET_KEY=live_0123456789",
            "JWT_SECRET = s3cr3t-value  # rotate monthly",
            "SMTP_PASS=mail-pass-99",
        ] {
            assert_eq!(rule_of(line).as_deref(), Some("dotenv-secret"), "for: {line}");
        }
        let hits = scan_diff(&[added("DB_PASSWORD=hunter2correct")]);
        assert!(!hits[0].preview.contains("hunter2correct"), "the value is masked");
    }

    /// The false positives the unquoted rule has to stay clear of: empty values, placeholders,
    /// references to another variable, numbers and flags, names that merely *contain* the word, and
    /// code that happens to be shaped like an assignment.
    #[test]
    fn unquoted_env_rule_skips_what_is_not_a_secret() {
        for line in [
            "API_KEY=",
            "API_KEY=changeme",
            "API_KEY=${API_KEY}",
            "API_KEY=$API_KEY",
            "API_KEY=<your-key>",
            "API_KEY=xxx",
            "API_KEY=xxxxxxxx",
            "DB_PASSWORD=********",
            "DB_PASSWORD=password",
            "SESSION_TOKEN=12345678",
            "AUTH_TOKEN=true",
            "TOKEN_TTL=3600",
            "PASSWORD_MIN_LENGTH=12",
            "SECRET_NAME=billing-service",
            "API_KEY=os.getenv(\"API_KEY\")",
            "    API_KEY=config[\"key\"]",
            "const API_KEY = loadKey();",
            "db_password=lowercase-is-code-not-env",
        ] {
            assert_eq!(rule_of(line), None, "should not flag: {line}");
        }
    }

    #[test]
    fn detects_anthropic_keys() {
        // Built at runtime for the same reason as the GitLab fixture: push protection.
        let key = format!("sk-ant-api03-{}", "AbCdEfGh0123456789_IjKlMnOpQrStUv-wxyz");
        let hits = scan_diff(&[added(&format!("const client = new Anthropic({{ apiKey: \"{key}\" }});"))]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rule, "anthropic-key");
        assert_eq!(hits[0].severity, "critical");
        assert!(!hits[0].preview.contains("AbCdEfGh0123456789"));
        // In an env file too, where it wins over the generic assignment rule.
        assert_eq!(rule_of(&format!("ANTHROPIC_API_KEY={key}")).as_deref(), Some("anthropic-key"));
        assert_eq!(rule_of("// keys look like sk-ant-…"), None);
    }

    #[test]
    fn detects_credentials_in_urls() {
        for line in [
            "remote = https://deploy:Sup3rS3cret!@example.com/o/r.git",
            "DATABASE_URL=postgres://app:k8s-db-pw-771@db.example.com:5432/app",
            "mongo: mongodb+srv://svc:Zr7qLm2x@cluster0.example.com/db",
        ] {
            assert_eq!(rule_of(line).as_deref(), Some("url-credentials"), "for: {line}");
        }
        let hits = scan_diff(&[added("url = https://deploy:Sup3rS3cret!@example.com/")]);
        assert!(!hits[0].preview.contains("Sup3rS3cret"), "only a masked password is shown");
    }

    #[test]
    fn urls_without_a_real_password_are_left_alone() {
        for line in [
            "https://example.com/path?x=1",
            "ssh://git@example.com:22/o/r.git",
            "git@example.com:o/r.git",
            "postgres://user:password@localhost:5432/db",
            "postgres://user:${DB_PASSWORD}@localhost/db",
            "https://user:<token>@example.com",
            "redis://:changeme@localhost:6379",
        ] {
            assert_eq!(rule_of(line), None, "should not flag: {line}");
        }
    }
}
