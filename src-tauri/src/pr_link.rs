//! Turns a pull-request **web** URL — the thing people paste into a chat — into the
//! coordinates the provider REST clients already take.
//!
//! This is deliberately the mirror image of `github::detect_from_remote_url` /
//! `ado::detect_from_remote_url`: those read a *git remote*, this reads the *browser link*,
//! and both end up at the same `{host, owner, repo}` / `{org, project, repo}` shape. Nothing
//! here talks to a network — resolving the link to a real PR (and to a local repo) is
//! `commands::ado_cmd::resolve_pr_link`'s job.

/// Where a pasted pull-request link points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrLinkTarget {
    /// `host` is "github.com" or a GitHub Enterprise hostname — same meaning as everywhere
    /// else: it picks both the token to use and the REST base URL.
    GitHub { host: String, owner: String, repo: String, number: i64 },
    Azure { org: String, project: String, repo: String, number: i64 },
    /// `project` is the full path including every group (`acme/backend/auth`), and `number` is the
    /// merge request's per-project `iid` — the number the URL shows.
    GitLab { host: String, project: String, number: i64 },
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decodes the `%XX` escapes a browser puts in the path — Azure DevOps org/project/repo names
/// routinely contain spaces ("Marketing Website" → `Marketing%20Website`), and the REST clients
/// re-encode them themselves, so what we hand them has to be the decoded name. A stray `%` that
/// isn't a valid escape is left as-is rather than dropped.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Splits a pasted link into its host and its decoded path segments, tolerating everything a
/// real copy/paste carries: a missing scheme, a `?_a=files` query, a `#discussion_r…` fragment,
/// a trailing slash.
fn split(url: &str) -> Option<(String, Vec<String>)> {
    let cleaned = url
        .trim()
        .split('#')
        .next()?
        .split('?')
        .next()?
        .trim_end_matches('/');
    let without_scheme = cleaned
        .strip_prefix("https://")
        .or_else(|| cleaned.strip_prefix("http://"))
        .unwrap_or(cleaned);
    let without_userinfo = without_scheme.rsplit('@').next().unwrap_or(without_scheme);
    let (host, path) = without_userinfo.split_once('/')?;
    if host.is_empty() {
        return None;
    }
    let segments = path.split('/').filter(|s| !s.is_empty()).map(percent_decode).collect();
    Some((host.to_string(), segments))
}

/// Recognizes a GitHub PR link — `https://{host}/{owner}/{repo}/pull/{n}` plus whatever tab
/// follows it (`/files`, `/commits`, …). As with a git remote, the host must be one we *know*
/// is GitHub (`known_github_hosts` = github.com plus the user's connected Enterprise hosts):
/// an arbitrary self-hosted host with the same path shape could be anything.
fn parse_github(host: &str, segments: &[String], known_github_hosts: &[String]) -> Option<PrLinkTarget> {
    let matched = known_github_hosts.iter().find(|h| h.eq_ignore_ascii_case(host))?;
    let [owner, repo, kind, number, ..] = segments else {
        return None;
    };
    if !kind.eq_ignore_ascii_case("pull") && !kind.eq_ignore_ascii_case("pulls") {
        return None;
    }
    Some(PrLinkTarget::GitHub {
        host: matched.clone(),
        owner: owner.clone(),
        repo: repo.trim_end_matches(".git").to_string(),
        number: number.parse().ok()?,
    })
}

/// Recognizes an Azure DevOps PR link in the shapes the portal actually produces:
/// `dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{n}`, the same without the project
/// segment (Azure omits it when the project and repo share a name), and the legacy
/// `{org}.visualstudio.com` host with an optional `/DefaultCollection` prefix.
fn parse_azure(host: &str, segments: &[String]) -> Option<PrLinkTarget> {
    let lower = host.to_ascii_lowercase();
    let (org, rest): (String, &[String]) = if lower == "dev.azure.com" {
        let (org, rest) = segments.split_first()?;
        (org.clone(), rest)
    } else {
        (lower.strip_suffix(".visualstudio.com")?.to_string(), segments)
    };

    let rest = match rest.first() {
        Some(first) if first.eq_ignore_ascii_case("DefaultCollection") => &rest[1..],
        _ => rest,
    };

    let is_git = |s: &String| s.eq_ignore_ascii_case("_git");
    let is_pr = |s: &String| s.eq_ignore_ascii_case("pullrequest") || s.eq_ignore_ascii_case("pullrequests");

    match rest {
        [project, git, repo, pr, number, ..] if is_git(git) && is_pr(pr) => Some(PrLinkTarget::Azure {
            org,
            project: project.clone(),
            repo: repo.clone(),
            number: number.parse().ok()?,
        }),
        // No project segment — Azure drops it when it matches the repository name.
        [git, repo, pr, number, ..] if is_git(git) && is_pr(pr) => Some(PrLinkTarget::Azure {
            org,
            project: repo.clone(),
            repo: repo.clone(),
            number: number.parse().ok()?,
        }),
        _ => None,
    }
}

/// Recognizes a GitLab merge-request link.
///
/// GitLab's shape is `https://{host}/{group}/…/{project}/-/merge_requests/{iid}`, and the project
/// path in front of it can be any number of segments deep because groups nest. The `-` segment is
/// GitLab's own separator between a project's path and the route inside it, which is what makes
/// the split unambiguous however deep the groups go. Instances predating it (GitLab 12) omit the
/// `-`, so a bare `…/merge_requests/{iid}` is accepted too.
///
/// As with GitHub Enterprise, the host must be one we already know is GitLab: a self-managed
/// instance is indistinguishable from any other git server by its URL alone.
fn parse_gitlab(host: &str, segments: &[String], known_gitlab_hosts: &[String]) -> Option<PrLinkTarget> {
    let matched = known_gitlab_hosts.iter().find(|h| h.eq_ignore_ascii_case(host))?;
    // The *last* `merge_requests`, so a project literally named `merge_requests` can't shadow the
    // route — its own MR link would carry the word twice.
    let route = segments
        .iter()
        .rposition(|s| s.eq_ignore_ascii_case("merge_requests") || s.eq_ignore_ascii_case("merge_request"))?;
    let number: i64 = segments.get(route + 1)?.parse().ok()?;

    let mut path_end = route;
    if path_end > 0 && segments[path_end - 1] == "-" {
        path_end -= 1;
    }
    let project = segments[..path_end].join("/");
    // A namespace and a project at the very least; anything shorter isn't a GitLab project path.
    if project.split('/').filter(|s| !s.is_empty()).count() < 2 {
        return None;
    }

    Some(PrLinkTarget::GitLab {
        host: matched.clone(),
        project: project.trim_end_matches(".git").to_string(),
        number,
    })
}

/// Parses a pasted pull-request or merge-request link. Returns `None` for anything that isn't one
/// on a host we can talk to — including a GitHub Enterprise or self-managed GitLab host the user
/// hasn't connected yet, which is indistinguishable from any other self-hosted git server.
pub fn parse(
    url: &str,
    known_github_hosts: &[String],
    known_gitlab_hosts: &[String],
) -> Option<PrLinkTarget> {
    let (host, segments) = split(url)?;
    parse_github(&host, &segments, known_github_hosts)
        .or_else(|| parse_gitlab(&host, &segments, known_gitlab_hosts))
        .or_else(|| parse_azure(&host, &segments))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> Vec<String> {
        vec!["github.com".to_string(), "ghe.contoso.com".to_string()]
    }

    fn gitlab_hosts() -> Vec<String> {
        vec!["gitlab.com".to_string(), "git.contoso.com".to_string()]
    }

    /// The tests below name the GitHub allowlist explicitly and take the GitLab one as read.
    fn parse(url: &str, known_github_hosts: &[String]) -> Option<PrLinkTarget> {
        super::parse(url, known_github_hosts, &gitlab_hosts())
    }

    #[test]
    fn parses_github_links() {
        assert_eq!(
            parse("https://github.com/acme/widget/pull/42", &hosts()),
            Some(PrLinkTarget::GitHub {
                host: "github.com".into(),
                owner: "acme".into(),
                repo: "widget".into(),
                number: 42,
            })
        );
        // A deep link to a tab, with a query and a fragment, is the same PR.
        assert_eq!(
            parse("https://github.com/acme/widget/pull/42/files?w=1#diff-abc", &hosts()),
            Some(PrLinkTarget::GitHub {
                host: "github.com".into(),
                owner: "acme".into(),
                repo: "widget".into(),
                number: 42,
            })
        );
        // Enterprise host, only because it's connected.
        assert!(matches!(
            parse("https://ghe.contoso.com/team/app/pull/7", &hosts()),
            Some(PrLinkTarget::GitHub { number: 7, .. })
        ));
        assert_eq!(parse("https://ghe.unknown.com/team/app/pull/7", &hosts()), None);
    }

    #[test]
    fn parses_azure_links() {
        assert_eq!(
            parse("https://dev.azure.com/contoso/Marketing%20Website/_git/site/pullrequest/9", &hosts()),
            Some(PrLinkTarget::Azure {
                org: "contoso".into(),
                project: "Marketing Website".into(),
                repo: "site".into(),
                number: 9,
            })
        );
        assert_eq!(
            parse("https://contoso.visualstudio.com/DefaultCollection/Web/_git/api/pullrequest/3?_a=files", &hosts()),
            Some(PrLinkTarget::Azure {
                org: "contoso".into(),
                project: "Web".into(),
                repo: "api".into(),
                number: 3,
            })
        );
        // Project segment omitted — it matches the repository name.
        assert_eq!(
            parse("https://dev.azure.com/contoso/_git/api/pullrequest/11", &hosts()),
            Some(PrLinkTarget::Azure {
                org: "contoso".into(),
                project: "api".into(),
                repo: "api".into(),
                number: 11,
            })
        );
    }

    #[test]
    fn parses_gitlab_links() {
        assert_eq!(
            parse("https://gitlab.com/acme/widget/-/merge_requests/42", &hosts()),
            Some(PrLinkTarget::GitLab {
                host: "gitlab.com".into(),
                project: "acme/widget".into(),
                number: 42,
            })
        );
        // Nested groups — the case GitHub's two-segment rule cannot express.
        assert_eq!(
            parse("https://gitlab.com/acme/backend/services/auth/-/merge_requests/7/diffs?view=inline", &hosts()),
            Some(PrLinkTarget::GitLab {
                host: "gitlab.com".into(),
                project: "acme/backend/services/auth".into(),
                number: 7,
            })
        );
        // The pre-GitLab-12 shape, with no `-` separator.
        assert_eq!(
            parse("https://git.contoso.com/team/app/merge_requests/3", &hosts()),
            Some(PrLinkTarget::GitLab {
                host: "git.contoso.com".into(),
                project: "team/app".into(),
                number: 3,
            })
        );
        // A self-managed instance nobody has connected is indistinguishable from any other git
        // server, so it stays unrecognized rather than being guessed at.
        assert_eq!(parse("https://git.unknown.com/team/app/-/merge_requests/3", &hosts()), None);
    }

    /// A project literally called `merge_requests` must not shadow the route it is named after.
    #[test]
    fn a_project_named_after_the_route_still_parses() {
        assert_eq!(
            parse("https://gitlab.com/acme/merge_requests/-/merge_requests/5", &hosts()),
            Some(PrLinkTarget::GitLab {
                host: "gitlab.com".into(),
                project: "acme/merge_requests".into(),
                number: 5,
            })
        );
    }

    #[test]
    fn rejects_non_pr_links() {
        assert_eq!(parse("https://github.com/acme/widget", &hosts()), None);
        assert_eq!(parse("https://github.com/acme/widget/issues/42", &hosts()), None);
        assert_eq!(parse("https://dev.azure.com/contoso/Web/_git/api", &hosts()), None);
        assert_eq!(parse("https://gitlab.com/acme/widget/-/issues/42", &hosts()), None);
        assert_eq!(parse("https://gitlab.com/acme/widget", &hosts()), None);
        assert_eq!(parse("not a url", &hosts()), None);
    }
}
