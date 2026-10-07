//! Docker Hub, for picking an image to run: the public search and tag lists the Hub's own site
//! reads, no account needed.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const HUB: &str = "https://hub.docker.com";
/// The search runs as the image field is typed into: an answer later than this is no answer.
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubRepo {
    /// `nginx` for an official image, `bitnami/redis` for anyone else's.
    pub name: String,
    pub description: String,
    pub stars: u64,
    pub pulls: u64,
    pub official: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubTag {
    pub name: String,
    /// The compressed size of the image the tag points to, when the Hub says.
    pub size: Option<u64>,
    /// When the tag was last pushed (RFC 3339).
    pub updated: Option<String>,
}

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                // The Hub throttles anonymous clients; one that names itself is not taken for a scraper.
                .user_agent("CodeFlow")
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// What to search for: printable, short, and the characters an image name or a word is made of —
/// the Hub reads `nginx:alpine` and `docker.io/library/nginx` as well as `nginx`.
fn check_term(term: &str) -> Result<&str, String> {
    let term = term.trim();
    if term.is_empty() {
        return Err("write what to look for on Docker Hub".into());
    }
    if term.chars().count() > 100 {
        return Err("a Docker Hub search is at most 100 characters".into());
    }
    if !term.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '/' | ':' | '@' | '+')) {
        return Err(format!("\"{term}\" cannot be searched: use letters, digits, spaces and - _ . / :"));
    }
    Ok(term)
}

/// One part of a repository's name as the Hub keeps it: lowercase letters and digits, joined by
/// `.`, `_` or `-`.
fn valid_component(part: &str) -> bool {
    let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    part.len() <= 255 && edge(part.chars().next()) && edge(part.chars().last()) && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// `nginx`, `bitnami/redis` — or a whole reference to one, `docker.io/bitnami/redis:7` — as the
/// Hub's namespace and name. An official image lives under `library`. The Hub's names are all
/// lowercase, so `Nginx` can only have meant `nginx`.
pub fn hub_path(repo: &str) -> Result<(String, String), String> {
    let original = repo.trim();
    let mut reference = original.to_lowercase();
    // A tag or a digest names a version of the repository, not another repository.
    if let Some(at) = reference.find('@') {
        reference.truncate(at);
    }
    if let Some((name, tag)) = reference.rsplit_once(':') {
        if !tag.contains('/') {
            reference = name.to_string();
        }
    }
    let reference = ["docker.io/", "index.docker.io/", "registry-1.docker.io/"].iter().find_map(|host| reference.strip_prefix(host)).unwrap_or(&reference);
    let parts: Vec<&str> = reference.split('/').collect();
    let (namespace, name) = match parts.as_slice() {
        [name] => ("library", *name),
        // `localhost:5000/app`, `quay.io/app`: another registry, which the Hub knows nothing about.
        [host, _] if *host == "localhost" || host.contains(['.', ':']) => return Err(format!("{original} is not on Docker Hub")),
        [namespace, name] => (*namespace, *name),
        _ => return Err(format!("{original} is not on Docker Hub (its repositories are `name` or `owner/name`)")),
    };
    if !valid_component(namespace) || !valid_component(name) {
        return Err(format!("\"{original}\" is not a Docker Hub repository"));
    }
    Ok((namespace.to_string(), name.to_string()))
}

/// A refusal of the Hub's, said the way the panel shows it. `repo` names what a 404 was about.
fn status_error(code: u16, retry_after: Option<&str>, repo: Option<&str>) -> String {
    match code {
        404 => match repo {
            Some(repo) => format!("{repo} is not on Docker Hub"),
            None => "Docker Hub has no such page (HTTP 404)".into(),
        },
        // Anonymous use is rate-limited per address; the Hub may say for how long.
        429 => match retry_after.and_then(|s| s.trim().parse::<u64>().ok()) {
            Some(seconds) => format!("Docker Hub is limiting requests from this computer; try again in {seconds} s"),
            None => "Docker Hub is limiting requests from this computer; try again in a minute".into(),
        },
        401 | 403 => match repo {
            Some(repo) => format!("{repo} is private or not on Docker Hub"),
            None => format!("Docker Hub refused the request (HTTP {code})"),
        },
        500..=599 => format!("Docker Hub is having trouble (HTTP {code}); try again later"),
        _ => format!("Docker Hub refused the request (HTTP {code})"),
    }
}

/// One GET of the Hub's API: the body, or why there is none.
async fn fetch(request: reqwest::RequestBuilder, repo: Option<&str>) -> Result<String, String> {
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("Docker Hub did not answer within {} s", TIMEOUT.as_secs())
        } else {
            format!("could not reach Docker Hub: {e}")
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        let retry_after = response.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).map(str::to_string);
        return Err(status_error(status.as_u16(), retry_after.as_deref(), repo));
    }
    response.text().await.map_err(|e| format!("Docker Hub's answer was cut short: {e}"))
}

/// A count the Hub prints as a number (or, defensively, as digits in a string).
fn count(value: &Value, key: &str) -> u64 {
    match value.get(key) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// The `results` of one page of the Hub's answer.
fn results(body: &str) -> Result<Vec<Value>, String> {
    let doc: Value = serde_json::from_str(body).map_err(|_| "Docker Hub answered something that is not JSON".to_string())?;
    match doc.get("results") {
        Some(Value::Array(list)) => Ok(list.clone()),
        Some(Value::Null) | None if doc.get("count").is_some() => Ok(vec![]),
        _ => Err("Docker Hub answered without results".into()),
    }
}

/// `GET /v2/search/repositories/` as repositories.
pub fn parse_search(body: &str) -> Result<Vec<HubRepo>, String> {
    Ok(results(body)?
        .iter()
        .filter_map(|hit| {
            let name = hit.get("repo_name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty())?;
            let official = hit.get("is_official").and_then(Value::as_bool).unwrap_or(false);
            // The search names official images bare; `library/` is the same image, written longer.
            let name = if official { name.strip_prefix("library/").unwrap_or(name) } else { name };
            Some(HubRepo {
                name: name.to_string(),
                description: hit.get("short_description").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
                stars: count(hit, "star_count"),
                pulls: count(hit, "pull_count"),
                official,
            })
        })
        .collect())
}

/// `GET /v2/repositories/{namespace}/{name}/tags/` as tags.
pub fn parse_tags(body: &str) -> Result<Vec<HubTag>, String> {
    Ok(results(body)?
        .iter()
        .filter_map(|tag| {
            let name = tag.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty())?;
            Some(HubTag {
                name: name.to_string(),
                // No image weighs nothing: a 0 is the Hub not knowing the size, not an empty image.
                size: tag.get("full_size").and_then(Value::as_u64).filter(|size| *size > 0),
                updated: ["last_updated", "tag_last_pushed"]
                    .iter()
                    .find_map(|key| tag.get(*key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()))
                    .map(str::to_string),
            })
        })
        .collect())
}

pub async fn search(term: &str, limit: usize) -> Result<Vec<HubRepo>, String> {
    let term = check_term(term)?;
    let page_size = limit.clamp(1, 100).to_string();
    let request = client().get(format!("{HUB}/v2/search/repositories/")).query(&[("query", term), ("page_size", page_size.as_str())]);
    parse_search(&fetch(request, None).await?)
}

pub async fn tags(repo: &str, limit: usize) -> Result<Vec<HubTag>, String> {
    let (namespace, name) = hub_path(repo)?;
    let mut url = reqwest::Url::parse(HUB).map_err(|e| e.to_string())?;
    // Path segments are encoded one by one; the trailing empty one is the slash the API expects.
    url.path_segments_mut().map_err(|_| "Docker Hub's address cannot take a path".to_string())?.extend(["v2", "repositories", namespace.as_str(), name.as_str(), "tags", ""]);
    let page_size = limit.clamp(1, 100).to_string();
    let request = client().get(url).query(&[("page_size", page_size.as_str()), ("ordering", "last_updated")]);
    let shown = if namespace == "library" { name.clone() } else { format!("{namespace}/{name}") };
    parse_tags(&fetch(request, Some(&shown)).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real `?query=redis&page_size=3` answer.
    const SEARCH: &str = r#"{"count":52272,"next":"https://hub.docker.com/v2/search/repositories/?page=2&page_size=3&query=redis","previous":"","results":[
        {"repo_name":"mcp/redis","short_description":"Access to Redis database operations.","star_count":14,"pull_count":143190,"repo_owner":"","is_automated":false,"is_official":false},
        {"repo_name":"redis","short_description":"Redis is the world’s fastest data platform for caching, vector search, and NoSQL databases.","star_count":13623,"pull_count":11391000431,"repo_owner":"","is_automated":false,"is_official":true},
        {"repo_name":"library/postgres","short_description":null,"star_count":null,"pull_count":"42","is_official":true},
        {"repo_name":"","short_description":"no name, no row"}]}"#;

    /// Trimmed from a real `library/redis/tags/?ordering=last_updated` answer.
    const TAGS: &str = r#"{"count":1000,"next":null,"previous":null,"results":[
        {"creator":1156886,"id":1071685103,"images":[{"architecture":"amd64","digest":"sha256:6e91","os":"linux","size":55569153}],"last_updated":"2026-10-06T06:08:18.891524Z","name":"trixie","repository":21187,"full_size":55569153,"v2":true,"tag_status":"active","tag_last_pushed":"2026-10-06T06:08:18.891524Z","digest":"sha256:c940"},
        {"name":"8-alpine","full_size":0,"last_updated":null,"tag_last_pushed":"2026-10-01T00:00:00Z"},
        {"name":"old","full_size":null}]}"#;

    #[test]
    fn search_results_read_into_repositories() {
        let repos = parse_search(SEARCH).unwrap();
        assert_eq!(repos.len(), 3, "a hit without a name is dropped");
        assert_eq!(repos[0], HubRepo { name: "mcp/redis".into(), description: "Access to Redis database operations.".into(), stars: 14, pulls: 143_190, official: false });
        assert_eq!(repos[1].name, "redis");
        assert!(repos[1].official);
        assert_eq!(repos[1].pulls, 11_391_000_431, "pulls beyond u32");
        assert_eq!(repos[2].name, "postgres", "an official image is named bare");
        assert_eq!((repos[2].description.as_str(), repos[2].stars, repos[2].pulls), ("", 0, 42), "nulls read as nothing, digits as a count");
        assert!(parse_search(r#"{"count":0,"next":"","previous":"","results":[]}"#).unwrap().is_empty());
        assert!(parse_search("<html>Too Many Requests</html>").is_err());
        assert!(parse_search(r#"{"message":"oops"}"#).is_err());
    }

    #[test]
    fn tags_read_with_their_size_and_date() {
        let tags = parse_tags(TAGS).unwrap();
        assert_eq!(tags[0], HubTag { name: "trixie".into(), size: Some(55_569_153), updated: Some("2026-10-06T06:08:18.891524Z".into()) });
        assert_eq!(tags[1], HubTag { name: "8-alpine".into(), size: None, updated: Some("2026-10-01T00:00:00Z".into()) }, "0 bytes is an unknown size; the push date stands in");
        assert_eq!(tags[2], HubTag { name: "old".into(), size: None, updated: None });
    }

    #[test]
    fn repositories_as_hub_paths() {
        let path = |r: &str| hub_path(r).map(|(ns, name)| format!("{ns}/{name}"));
        assert_eq!(path("nginx").unwrap(), "library/nginx");
        assert_eq!(path("bitnami/redis").unwrap(), "bitnami/redis");
        assert_eq!(path(" Nginx ").unwrap(), "library/nginx", "the Hub's names are lowercase");
        assert_eq!(path("docker.io/library/nginx:1.27-alpine").unwrap(), "library/nginx");
        assert_eq!(path("bitnami/redis@sha256:abc").unwrap(), "bitnami/redis");
        assert_eq!(path("my_org/app.v2-x").unwrap(), "my_org/app.v2-x");
        assert!(path("quay.io/app").unwrap_err().contains("not on Docker Hub"));
        assert!(path("localhost:5000/app").unwrap_err().contains("not on Docker Hub"));
        assert!(path("ghcr.io/owner/app").is_err());
        for bad in ["", "  ", "-x", "a/b/c", "a b", "../etc", "a/-b", "a/b?c", "_x/y"] {
            assert!(hub_path(bad).is_err(), "{bad:?} is refused");
        }
    }

    #[test]
    fn search_terms_are_checked() {
        assert_eq!(check_term("  redis ").unwrap(), "redis");
        assert!(check_term("nginx:alpine").is_ok() && check_term("docker.io/library/nginx").is_ok() && check_term("post gres").is_ok());
        assert!(check_term("").is_err());
        assert!(check_term("a\nb").is_err());
        assert!(check_term("x&page_size=1000").is_err());
        assert!(check_term(&"a".repeat(101)).is_err());
    }

    #[test]
    fn refusals_read_plainly() {
        assert_eq!(status_error(404, None, Some("bitnami/nope")), "bitnami/nope is not on Docker Hub");
        assert!(status_error(429, Some("30"), None).ends_with("try again in 30 s"));
        assert!(status_error(429, None, None).ends_with("try again in a minute"));
        assert!(status_error(429, Some("Wed, 21 Oct 2026 07:28:00 GMT"), None).ends_with("a minute"), "a date is not a number of seconds");
        assert!(status_error(503, None, None).contains("having trouble"));
        assert_eq!(status_error(418, None, None), "Docker Hub refused the request (HTTP 418)");
    }

    /// Against the real Hub: `CODEFLOW_LIVE_CONTAINERS=1 cargo test --lib containers::hub::tests::live
    /// -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_hub() {
        if std::env::var("CODEFLOW_LIVE_CONTAINERS").is_err() {
            return;
        }
        let repos = search("redis", 5).await.unwrap();
        println!("{repos:#?}");
        assert!(repos.iter().any(|r| r.name == "redis" && r.official));
        let official = tags("redis", 5).await.unwrap();
        println!("{official:#?}");
        assert_eq!(official.len(), 5);
        assert!(official.iter().all(|t| t.updated.is_some()));
        assert!(!tags("grafana/grafana", 3).await.unwrap().is_empty());
        assert_eq!(tags("cf-test-nobody/cf-test-nothing", 3).await.unwrap_err(), "cf-test-nobody/cf-test-nothing is not on Docker Hub");
    }
}
