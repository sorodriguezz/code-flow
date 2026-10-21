//! The skills.sh registry, browsed from Settings › Herramientas de IA › Skills instead of copied by
//! hand: a search, and what a skill is for before it is installed.
//!
//! # Where the answers come from
//!
//! - **The search** is `GET https://skills.sh/api/search?q=…` — the endpoint the registry's own CLI
//!   (`npx skills find`) asks, which takes no credentials. One word is a fuzzy match, several a
//!   semantic one; up to a hundred results, each `{id, source, skillId, name, installs}`. The
//!   documented `/api/v1/…` API wants a Vercel OIDC token this app does not have.
//! - **What a skill does** is its `SKILL.md`'s `description` — the text an agent itself reads to
//!   decide when to use it — fetched from GitHub's raw files at the paths skill repositories use.
//!   When none of them is there (a site-hosted source, an unusual layout) the registry page's own
//!   `<meta name="description">` stands in, which is the same text cut at ~160 characters.
//!
//! Installing is unchanged: `npx skills add <source> --skill <skillId>` (`commands::skills_cmd`).

use std::time::Duration;

use serde::{Deserialize, Serialize};

const SEARCH_URL: &str = "https://skills.sh/api/search";
const PAGE_BASE: &str = "https://www.skills.sh";
/// The most of a `SKILL.md`'s body shown as a preview.
const PREVIEW_CHARS: usize = 1_500;

/// One search result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySkill {
    pub id: String,
    /// `owner/repo`, or a domain for a site-hosted source.
    pub source: String,
    /// What `npx skills add <source> --skill <skillId>` installs — the folder it creates.
    pub skill_id: String,
    pub name: String,
    #[serde(default)]
    pub installs: u64,
}

/// What a skill is for, before installing it.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDetail {
    pub description: String,
    /// The start of the `SKILL.md`'s instructions, front matter removed — empty when only the
    /// registry page's description could be read.
    pub preview: String,
    /// The skill's page on skills.sh (installs, security audits, the whole file).
    pub page_url: String,
    /// The `SKILL.md` on GitHub, when that is where the description came from.
    pub file_url: Option<String>,
}

#[derive(Deserialize)]
struct SearchAnswer {
    #[serde(default)]
    skills: Vec<RegistrySkill>,
}

fn client() -> Result<reqwest::Client, String> {
    crate::http_clients::cached("skills-registry", || {
        reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(concat!("CodeFlow/", env!("CARGO_PKG_VERSION")))
    })
}

/// Skills matching `query` (at least two characters, as the registry requires), most installed
/// first within the registry's own ranking.
pub async fn search(query: &str) -> Result<Vec<RegistrySkill>, String> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let client = client()?;
    // The registry answers 503 now and then under load; one retry after a beat covers it.
    let mut last = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
        let response = match client.get(SEARCH_URL).query(&[("q", query)]).send().await {
            Ok(response) => response,
            Err(error) => {
                last = format!("skills.sh could not be reached ({error})");
                continue;
            }
        };
        let status = response.status();
        if status.as_u16() == 503 || status.as_u16() == 429 {
            last = format!("skills.sh is busy right now ({status}); try again in a moment");
            continue;
        }
        if !status.is_success() {
            return Err(format!("skills.sh answered {status}"));
        }
        let answer: SearchAnswer = response.json().await.map_err(|e| format!("skills.sh sent an answer this app cannot read ({e})"))?;
        return Ok(answer.skills.into_iter().filter(|s| valid_source(&s.source) && valid_slug(&s.skill_id)).collect());
    }
    Err(last)
}

/// What `skill_id` of `source` is for: its `SKILL.md`'s description and the start of its body, or
/// the registry page's description when the file cannot be found.
pub async fn describe(source: &str, skill_id: &str) -> Result<RegistryDetail, String> {
    if !valid_source(source) || !valid_slug(skill_id) {
        return Err("That is not a skill the registry lists".to_string());
    }
    // A site-hosted source's page lives under `/site/` (`/site/mintlify.com/mintlify`).
    let page_url = if is_github(source) { format!("{PAGE_BASE}/{source}/{skill_id}") } else { format!("{PAGE_BASE}/site/{source}/{skill_id}") };
    let client = client()?;
    if is_github(source) {
        let candidates = candidate_paths(skill_id);
        let fetches = candidates.iter().map(|path| {
            let url = format!("https://raw.githubusercontent.com/{source}/HEAD/{path}");
            let client = client.clone();
            async move {
                let response = client.get(&url).send().await.ok()?;
                if !response.status().is_success() {
                    return None;
                }
                Some((url, response.text().await.ok()?))
            }
        });
        // In the order the paths are listed: the first one that is this skill wins.
        for (path, found) in candidates.iter().zip(futures_util::future::join_all(fetches).await) {
            let Some((url, text)) = found else { continue };
            let meta = crate::skill_meta::parse(&text);
            let named = meta.name.as_deref().is_some_and(|name| name.eq_ignore_ascii_case(skill_id));
            // A repository's root `SKILL.md` is this skill only if it says so.
            if *path == "SKILL.md" && !named {
                continue;
            }
            let Some(description) = meta.description.filter(|d| !d.trim().is_empty()) else { continue };
            let file_url = url.replace("https://raw.githubusercontent.com/", "https://github.com/").replacen("/HEAD/", "/blob/HEAD/", 1);
            return Ok(RegistryDetail { description: description.trim().to_string(), preview: preview(&text), page_url, file_url: Some(file_url) });
        }
    }
    let response = client.get(&page_url).send().await.map_err(|e| format!("skills.sh could not be reached ({e})"))?;
    if !response.status().is_success() {
        return Err(format!("skills.sh answered {} for that skill", response.status()));
    }
    let html = response.text().await.map_err(|e| e.to_string())?;
    let description = meta_description(&html).ok_or("skills.sh does not say what this skill does")?;
    Ok(RegistryDetail { description, preview: String::new(), page_url, file_url: None })
}

/// Where skill repositories keep a skill's `SKILL.md`, most common first.
fn candidate_paths(skill_id: &str) -> Vec<String> {
    vec![
        format!("skills/{skill_id}/SKILL.md"),
        format!("{skill_id}/SKILL.md"),
        format!(".claude/skills/{skill_id}/SKILL.md"),
        format!(".agents/skills/{skill_id}/SKILL.md"),
        format!("plugins/{skill_id}/SKILL.md"),
        "SKILL.md".to_string(),
    ]
}

/// `owner/repo` — a GitHub source — rather than a domain.
fn is_github(source: &str) -> bool {
    source.split('/').count() == 2
}

/// `owner/repo` or `domain.tld`: nothing that could walk out of the URL it is put into.
fn valid_source(source: &str) -> bool {
    let parts: Vec<&str> = source.split('/').collect();
    (1..=2).contains(&parts.len()) && parts.iter().all(|part| valid_slug(part) && !part.starts_with('.'))
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty() && slug.len() <= 120 && slug != "." && slug != ".." && slug.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// The instructions after the front matter, cut at [`PREVIEW_CHARS`] on a line.
fn preview(text: &str) -> String {
    let body = match text.strip_prefix("---") {
        Some(rest) => rest.split_once("\n---").map(|(_, after)| after).unwrap_or(rest),
        None => text,
    };
    let body = body.trim();
    if body.chars().count() <= PREVIEW_CHARS {
        return body.to_string();
    }
    let cut: String = body.chars().take(PREVIEW_CHARS).collect();
    let cut = cut.rsplit_once('\n').map(|(head, _)| head).unwrap_or(&cut);
    format!("{}\n…", cut.trim_end())
}

/// The page's `<meta name="description" content="…">`, its entities decoded.
fn meta_description(html: &str) -> Option<String> {
    let at = html.find(r#"<meta name="description" content=""#)?;
    let rest = &html[at + r#"<meta name="description" content=""#.len()..];
    let raw = &rest[..rest.find('"')?];
    let text = raw
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_search_answer_is_read_as_the_cli_gets_it() {
        let answer: SearchAnswer = serde_json::from_str(
            r#"{"query":"pdf","searchType":"fuzzy","skills":[{"id":"anthropics/skills/pdf","source":"anthropics/skills","skillId":"pdf","name":"pdf","installs":213790}]}"#,
        )
        .unwrap();
        assert_eq!(answer.skills[0], RegistrySkill { id: "anthropics/skills/pdf".into(), source: "anthropics/skills".into(), skill_id: "pdf".into(), name: "pdf".into(), installs: 213_790 });
    }

    #[test]
    fn only_plain_sources_and_slugs_reach_a_url() {
        assert!(valid_source("anthropics/skills") && valid_source("mintlify.com") && valid_slug("react-pdf"));
        for bad in ["../etc", "a/b/c", "owner/.git", "", "a b/c", "owner/repo?x=1"] {
            assert!(!valid_source(bad), "{bad}");
        }
        assert!(!valid_slug("..") && !valid_slug("a/b") && !valid_slug("x%2F"));
    }

    #[test]
    fn the_preview_is_the_body_without_its_front_matter() {
        let text = "---\nname: pdf\ndescription: PDFs.\n---\n\n# PDF Processing Guide\n\nRead PDFs.\n";
        assert_eq!(preview(text), "# PDF Processing Guide\n\nRead PDFs.");
        let long = format!("---\nname: x\n---\n{}", "line of text\n".repeat(400));
        let cut = preview(&long);
        assert!(cut.chars().count() <= PREVIEW_CHARS + 2 && cut.ends_with('…'));
    }

    #[test]
    fn the_page_description_is_read_with_its_entities_decoded() {
        let html = r#"<head><meta name="description" content="Use this when the user&#x27;s PDF has &quot;forms&quot; &amp; tables"/></head>"#;
        assert_eq!(meta_description(html).as_deref(), Some(r#"Use this when the user's PDF has "forms" & tables"#));
        assert_eq!(meta_description("<head></head>"), None);
    }

    /// Against the real registry. `CODEFLOW_TEST_SKILLS_SH=1 cargo test --lib skills_registry -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn live_search_and_describe() {
        if std::env::var("CODEFLOW_TEST_SKILLS_SH").is_err() {
            return;
        }
        let found = search("pdf").await.unwrap();
        assert!(found.iter().any(|s| s.id == "anthropics/skills/pdf"), "{found:?}");
        let detail = describe("anthropics/skills", "pdf").await.unwrap();
        assert!(detail.description.to_lowercase().contains("pdf"), "{detail:?}");
        assert!(detail.file_url.is_some() && !detail.preview.is_empty());
    }
}
