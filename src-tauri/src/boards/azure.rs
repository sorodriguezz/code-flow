//! Azure DevOps **Wiki** (read) and **Boards** (read + write).
//!
//! Split from [`crate::ado`] rather than added to it: that module is the pull-request client, and
//! everything here belongs to a different half of the product — the wiki a requirement is written
//! in, and the work item it ends up as. The low-level plumbing (auth header, org normalisation,
//! path encoding, the `{value: […]}` envelope) is shared from there, so both halves speak to the
//! same server the same way.
//!
//! The board half of this module is reached through [`super`], which normalises it against Jira;
//! the wiki half is called directly, because Jira has nothing to normalise it against. Everything
//! whose name still begins with `Ado` is in that second group by definition — an Azure concept with
//! no counterpart worth pretending to.
//!
//! Nothing here **deletes**. Work items are read, created and edited; whatever a review concludes
//! goes back through the user's own hands. Wiki pages are the one thing that can be written over —
//! [`put_wiki_page`] is a conditional PUT, so a page edited by somebody else since it was read
//! refuses the write instead of silently winning it.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::{
    criteria_to_html, escape_html, text_to_html, BoardProvider, ItemRef, NewChildItem, NewWorkItem,
    WorkItem, WorkItemChild, WorkItemEdit, WorkItemRef, WorkItemType,
};
use crate::ado::{auth_header, client, encode_segment, get_json, normalize_org, ListResponse, API_VERSION};

/// Percent-encodes a value going into a *query string*. Same rule as a path segment — wiki page
/// paths carry `/` and spaces, and both have to survive as data rather than be read as structure.
fn encode_query(value: &str) -> String {
    encode_segment(value)
}

// ---------- wiki ----------

#[derive(Debug, Clone, Serialize)]
pub struct AdoWiki {
    pub id: String,
    pub name: String,
    /// "projectWiki" or "codeWiki" — a code wiki is a folder of Markdown inside a Git repo, and
    /// its pages are addressed exactly like a project wiki's, so the distinction is only ever
    /// shown to the user.
    pub kind: String,
    /// The Git repository behind the wiki. Every wiki has one — a project wiki gets a hidden repo
    /// created with it — and it is the only place the page's history lives: the pages API answers
    /// content, never who wrote it. Empty if the host stopped sending it.
    pub repository_id: String,
}

#[derive(Deserialize)]
struct RawWiki {
    id: String,
    name: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(rename = "repositoryId", default)]
    repository_id: String,
}

pub async fn list_wikis(org: &str, project: &str, pat: &str) -> Result<Vec<AdoWiki>, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!("https://dev.azure.com/{org}/{project}/_apis/wiki/wikis?api-version={API_VERSION}");
    let parsed: ListResponse<RawWiki> = get_json(&url, pat).await?;
    Ok(parsed
        .value
        .into_iter()
        .map(|w| AdoWiki { id: w.id, name: w.name, kind: w.kind, repository_id: w.repository_id })
        .collect())
}

/// One page of a wiki, flattened out of the tree the API answers with.
///
/// `depth` is kept because the tree is what makes a wiki readable — a flat list of forty paths is
/// not something you can find a requirement in, and rebuilding the nesting on the frontend from
/// the slashes in `path` would get the ordering wrong (the API's `order` is per-level).
#[derive(Debug, Clone, Serialize)]
pub struct AdoWikiPage {
    /// The wiki-absolute path, e.g. `/Producto/Checkout`. This is the page's identity.
    pub path: String,
    /// The last segment, for display. `/` (the wiki root) reads as an empty title.
    pub title: String,
    pub depth: i64,
    pub has_children: bool,
}

#[derive(Deserialize)]
struct RawWikiPage {
    #[serde(default)]
    path: Option<String>,
    #[serde(rename = "subPages", default)]
    sub_pages: Vec<RawWikiPage>,
    #[serde(default)]
    content: Option<String>,
    /// Where the page's Markdown lives inside the wiki's Git repository — the key its history is
    /// filed under, and not derivable from `path` (spaces become dashes, and a page with children
    /// is a file *and* a folder).
    #[serde(rename = "gitItemPath", default)]
    git_item_path: Option<String>,
}

fn page_title(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).replace('-', " ")
}

/// Walks the tree the API returns into the flat, depth-tagged list the picker renders. The root
/// itself is skipped: it is the wiki, not a page, and has no content of its own.
fn flatten_pages(node: &RawWikiPage, depth: i64, out: &mut Vec<AdoWikiPage>) {
    for child in &node.sub_pages {
        let Some(path) = child.path.as_deref().filter(|p| !p.is_empty() && *p != "/") else {
            continue;
        };
        out.push(AdoWikiPage {
            path: path.to_string(),
            title: page_title(path),
            depth,
            has_children: !child.sub_pages.is_empty(),
        });
        flatten_pages(child, depth + 1, out);
    }
}

/// Every page of a wiki, in the order the wiki itself lists them.
///
/// `recursionLevel=full` is one request for the whole tree; asking level by level would be one
/// round trip per folder, which for a real product wiki is dozens.
pub async fn list_wiki_pages(
    org: &str,
    project: &str,
    wiki: &str,
    pat: &str,
) -> Result<Vec<AdoWikiPage>, String> {
    let org = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let wiki_enc = encode_segment(wiki);
    let url = format!(
        "https://dev.azure.com/{org}/{project_enc}/_apis/wiki/wikis/{wiki_enc}/pages\
         ?path=%2F&recursionLevel=full&includeContent=false&api-version={API_VERSION}"
    );
    let root: RawWikiPage = get_json(&url, pat).await?;
    let mut pages = Vec::new();
    flatten_pages(&root, 0, &mut pages);
    Ok(pages)
}

/// One page's Markdown. Empty for a page that is only a folder — which is a real state in Azure
/// DevOps wikis and not an error, so it comes back as an empty string rather than a failure.
pub async fn get_wiki_page(
    org: &str,
    project: &str,
    wiki: &str,
    path: &str,
    pat: &str,
) -> Result<String, String> {
    let org = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let wiki_enc = encode_segment(wiki);
    let path_enc = encode_query(path);
    let url = format!(
        "https://dev.azure.com/{org}/{project_enc}/_apis/wiki/wikis/{wiki_enc}/pages\
         ?path={path_enc}&includeContent=true&api-version={API_VERSION}"
    );
    let page: RawWikiPage = get_json(&url, pat).await?;
    Ok(page.content.unwrap_or_default())
}

/// One wiki page as Azure holds it right now: its Markdown, and who has touched it.
///
/// The history is the reason this exists next to [`get_wiki_page`]. Somebody bringing an existing
/// page into the app is about to edit — and eventually overwrite — a page other people wrote, and
/// "last changed by Marta three days ago" is the one fact that decides whether that is a good idea.
#[derive(Debug, Clone, Serialize)]
pub struct AdoWikiPageDetail {
    /// The wiki-absolute path, exactly as asked for.
    pub path: String,
    /// The last segment, readable — what the wiki shows as the page's name.
    pub title: String,
    pub content: String,
    /// A browser URL for the page.
    pub url: String,
    /// Who first committed the page, and when (ISO-8601). Empty when unknown — see
    /// `history_truncated`, and note a PAT that can read pages cannot always read the repository
    /// they live in. Never a guess: an empty string means the app does not know.
    pub created_by: String,
    pub created_at: String,
    /// Who last changed it, and when. The pair that matters before overwriting.
    pub modified_by: String,
    pub modified_at: String,
    /// Commits that touched this page, up to [`MAX_PAGE_COMMITS`]. `0` when the history could not
    /// be read at all.
    pub revisions: i64,
    /// Whether the page has more history than was read. When true the creation is genuinely
    /// unknown rather than merely old, and `created_*` stay empty instead of naming whichever
    /// commit happened to be last in the window.
    pub history_truncated: bool,
}

/// How far back the page history is read. Ten years of a wiki page is a handful of commits; the
/// cap only exists so a page somebody rewrites daily can't turn one import into a long download.
const MAX_PAGE_COMMITS: usize = 200;

#[derive(Deserialize)]
struct RawCommit {
    #[serde(default)]
    author: Option<RawCommitAuthor>,
}

#[derive(Deserialize)]
struct RawCommitAuthor {
    #[serde(default)]
    name: String,
    #[serde(default)]
    date: String,
}

/// The commits that touched one path in the wiki's repository, newest first.
///
/// Best effort by contract: the caller wants the page either way, so every failure here — no
/// repository id, a PAT without code-read scope, a wiki whose repo was rewritten — comes back as
/// an empty list rather than an error that would take the content down with it.
async fn wiki_page_commits(
    org_enc: &str,
    project_enc: &str,
    repository_id: &str,
    git_item_path: &str,
    pat: &str,
) -> Vec<RawCommit> {
    if repository_id.is_empty() || git_item_path.is_empty() {
        return Vec::new();
    }
    let repo_enc = encode_segment(repository_id);
    let item_enc = encode_query(git_item_path);
    let top = MAX_PAGE_COMMITS;
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{repo_enc}/commits\
         ?searchCriteria.itemPath={item_enc}&searchCriteria.$top={top}&api-version={API_VERSION}"
    );
    match get_json::<ListResponse<RawCommit>>(&url, pat).await {
        Ok(parsed) => parsed.value,
        Err(_) => Vec::new(),
    }
}

/// Reads one page by its exact path, with whatever history the host will give up.
///
/// `wiki` is the identifier the rest of this module uses — an id or a name — and it is resolved
/// against the project's wikis here, because the repository the history lives in is only on that
/// listing. A wiki that does not resolve still returns the page: the content is the point, the
/// history is the bonus.
pub async fn get_wiki_page_detail(
    org: &str,
    project: &str,
    wiki: &str,
    path: &str,
    pat: &str,
) -> Result<AdoWikiPageDetail, String> {
    if path.trim().is_empty() || !path.starts_with('/') {
        return Err("La ruta de la página tiene que empezar por «/»".to_string());
    }

    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let wiki_enc = encode_segment(wiki);
    let path_enc = encode_query(path);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/wiki/wikis/{wiki_enc}/pages\
         ?path={path_enc}&includeContent=true&api-version={API_VERSION}"
    );
    let page: RawWikiPage = get_json(&url, pat).await?;

    let repository_id = list_wikis(org, project, pat)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|w| w.id == wiki || w.name == wiki)
        .map(|w| w.repository_id)
        .unwrap_or_default();
    let git_item_path = page.git_item_path.unwrap_or_default();
    let commits = wiki_page_commits(&org_enc, &project_enc, &repository_id, &git_item_path, pat).await;

    let truncated = commits.len() >= MAX_PAGE_COMMITS;
    let author_of = |commit: Option<&RawCommit>| -> (String, String) {
        match commit.and_then(|c| c.author.as_ref()) {
            Some(a) => (a.name.clone(), a.date.clone()),
            None => (String::new(), String::new()),
        }
    };
    let (modified_by, modified_at) = author_of(commits.first());
    let (created_by, created_at) = match truncated {
        true => (String::new(), String::new()),
        false => author_of(commits.last()),
    };

    Ok(AdoWikiPageDetail {
        title: page_title(path),
        content: page.content.unwrap_or_default(),
        url: format!(
            "https://dev.azure.com/{org_enc}/{project_enc}/_wiki/wikis/{wiki_enc}?pagePath={path_enc}"
        ),
        path: path.to_string(),
        created_by,
        created_at,
        modified_by,
        modified_at,
        revisions: commits.len() as i64,
        history_truncated: truncated,
    })
}

/// Where a published page ended up.
#[derive(Debug, Clone, Serialize)]
pub struct AdoWikiPageRef {
    /// The wiki-absolute path it was written to.
    pub path: String,
    /// A browser URL for the page.
    pub url: String,
    /// Whether the page existed already. The caller says "created" or "updated" from this rather
    /// than guessing, because the two are genuinely different news to somebody publishing.
    pub updated: bool,
}

#[derive(Deserialize)]
struct RawPutPage {
    #[serde(rename = "eTag", default)]
    _etag: Option<String>,
}

/// The current version tag of a page, or `None` if it does not exist yet.
///
/// Azure's wiki write is a conditional PUT: creating wants no `If-Match`, and updating *requires*
/// the page's current ETag — a PUT without one against an existing page is refused with 412 rather
/// than overwriting it. That refusal is a feature (it is what stops this app clobbering an edit
/// somebody made a minute ago), so the ETag is read immediately before the write, and a page that
/// changed in between fails loudly instead of silently winning.
async fn wiki_page_etag(
    org_enc: &str,
    project_enc: &str,
    wiki_enc: &str,
    path: &str,
    pat: &str,
) -> Result<Option<String>, String> {
    let path_enc = encode_query(path);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/wiki/wikis/{wiki_enc}/pages\
         ?path={path_enc}&api-version={API_VERSION}"
    );
    let res = client()
        .get(&url)
        .header("Authorization", auth_header(pat))
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;

    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Azure DevOps returned {status}: {body}"));
    }
    // Azure quotes the tag and `If-Match` wants it back exactly as it was given, quotes included.
    Ok(res
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string))
}

/// Creates or overwrites one wiki page.
///
/// The one thing in this module that changes a page somebody else may be reading, which is why it
/// is conditional (see [`wiki_page_etag`]) and why the caller shows the user the target before it
/// runs. Azure creates missing parent folders on its own, so `/Producto/Checkout/Errores` works
/// without three round trips.
pub async fn put_wiki_page(
    org: &str,
    project: &str,
    wiki: &str,
    path: &str,
    content: &str,
    pat: &str,
) -> Result<AdoWikiPageRef, String> {
    if path.trim().is_empty() || !path.starts_with('/') {
        return Err("La ruta de la página tiene que empezar por «/»".to_string());
    }

    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let wiki_enc = encode_segment(wiki);
    let etag = wiki_page_etag(&org_enc, &project_enc, &wiki_enc, path, pat).await?;

    let path_enc = encode_query(path);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/wiki/wikis/{wiki_enc}/pages\
         ?path={path_enc}&api-version={API_VERSION}"
    );
    let mut request = client()
        .put(&url)
        .header("Authorization", auth_header(pat))
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "content": content }).to_string());
    if let Some(etag) = &etag {
        request = request.header(reqwest::header::IF_MATCH, etag);
    }

    let res = request.send().await.map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(match status {
            // The one failure worth translating: it means the page moved under us between the read
            // and the write, and "412" tells the user nothing about what to do next.
            reqwest::StatusCode::PRECONDITION_FAILED => {
                "Esa página cambió en Azure DevOps mientras se publicaba. Vuelve a intentarlo para \
                 escribir sobre la versión actual."
                    .to_string()
            }
            _ => format!("Azure DevOps returned {status}: {body}"),
        });
    }
    // The body is read and discarded: what the caller needs is "it landed", and the page URL is
    // built from the path rather than from the response, which does not carry a browser link.
    let _: RawPutPage = res.json().await.unwrap_or(RawPutPage { _etag: None });

    Ok(AdoWikiPageRef {
        url: format!(
            "https://dev.azure.com/{org_enc}/{project_enc}/_wiki/wikis/{wiki_enc}?pagePath={path_enc}"
        ),
        path: path.to_string(),
        updated: etag.is_some(),
    })
}

/// Reads several pages and concatenates them under their own headings.
///
/// One requirement rarely lives on one page, and the alternative — making the user open each page,
/// copy it and paste it together — is the manual work this whole screen exists to remove. Pages are
/// fetched a few at a time so selecting twenty doesn't open twenty connections.
pub async fn get_wiki_pages_combined(
    org: &str,
    project: &str,
    wiki: &str,
    paths: &[String],
    pat: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;

    // Each request owns its arguments rather than borrowing this function's: a future built from
    // borrowed `&str`s can't be named generally enough to go through a stream combinator, and
    // cloning four short strings per page is nothing next to the round trip they're about to make.
    let jobs: Vec<_> = paths
        .iter()
        .map(|path| {
            let (org, project, wiki, pat, path) = (
                org.to_string(),
                project.to_string(),
                wiki.to_string(),
                pat.to_string(),
                path.clone(),
            );
            async move {
                let content = get_wiki_page(&org, &project, &wiki, &path, &pat).await;
                (path, content)
            }
        })
        .collect();
    let sections: Vec<(String, Result<String, String>)> =
        futures_util::stream::iter(jobs).buffered(4).collect().await;

    let mut out = String::new();
    let mut failures: Vec<String> = Vec::new();
    for (path, content) in sections {
        match content {
            Ok(text) if !text.trim().is_empty() => {
                out.push_str(&format!("\n\n# === {path} ===\n\n{text}\n"));
            }
            // A folder page with no body is not worth reporting; a page that couldn't be read is.
            Ok(_) => {}
            Err(e) => failures.push(format!("{path}: {e}")),
        }
    }
    if out.trim().is_empty() {
        return Err(if failures.is_empty() {
            "Las páginas seleccionadas no tienen contenido".to_string()
        } else {
            failures.join("\n")
        });
    }
    Ok(out.trim_start().to_string())
}

// ---------- work item types, areas and iterations ----------

#[derive(Deserialize)]
struct RawWorkItemType {
    name: String,
    #[serde(rename = "referenceName", default)]
    reference_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    color: String,
    #[serde(rename = "isDisabled", default)]
    is_disabled: bool,
}

/// The project's enabled work item types. Which ones exist depends on the process the project was
/// created with — Agile has "User Story", Scrum "Product Backlog Item", Basic "Issue" — so this is
/// read from the host rather than hard-coded anywhere.
pub async fn list_work_item_types(
    org: &str,
    project: &str,
    pat: &str,
) -> Result<Vec<WorkItemType>, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url =
        format!("https://dev.azure.com/{org}/{project}/_apis/wit/workitemtypes?api-version={API_VERSION}");
    let parsed: ListResponse<RawWorkItemType> = get_json(&url, pat).await?;
    Ok(parsed
        .value
        .into_iter()
        .filter(|t| !t.is_disabled)
        .map(|t| WorkItemType {
            name: t.name,
            reference_name: t.reference_name,
            description: t.description,
            color: t.color,
            // Azure's hierarchy is a link between items, not a property of the type: any type can
            // be a child of any other, so nothing here is a sub-task type the way Jira means it.
            subtask: false,
        })
        .collect())
}

#[derive(Deserialize)]
struct RawTypeField {
    #[serde(rename = "referenceName", default)]
    reference_name: String,
    /// What the field is called on the work item form — "Activity", "Original Estimate", and on a
    /// Spanish-language organisation the Spanish for both.
    #[serde(default)]
    name: String,
}

/// Every field this work item type actually has: by reference name, and by the name a person sees.
///
/// The reference names are what keeps a publish from being rejected wholesale: a Basic-process
/// "Issue" has no acceptance-criteria field and no story points, and Azure answers a patch naming a
/// field the type doesn't define with a 400 for the *whole* work item. Knowing the list up front
/// means the story is created with whatever the type can hold instead of not being created at all.
///
/// The labels solve the other half of the same problem, the half a fixed reference name cannot.
/// "Task Type" is not one field across Azure: it is `Microsoft.VSTS.CMMI.TaskType` on a CMMI
/// project, absent from stock Agile and Scrum, and on a customised process a custom field whose
/// reference name carries a GUID nobody could hard-code. What *is* stable is what the team calls
/// it on the form, which is what [`TypeFields::by_any_label`] looks it up by.
#[derive(Debug, Clone, Default)]
pub struct TypeFields {
    reference_names: HashSet<String>,
    /// Lowercased display name → reference name.
    by_label: HashMap<String, String>,
}

impl TypeFields {
    /// Whether the type defines this field, by reference name.
    pub fn has(&self, reference_name: &str) -> bool {
        self.reference_names.contains(reference_name)
    }

    /// The reference name of the first of `labels` the type carries, matched case-insensitively.
    ///
    /// A list rather than one name because the same field answers to different words depending on
    /// the organisation's language and on whoever named the custom one — passing "Task Type" and
    /// "Tipo de tarea" is how one call covers both without the caller knowing which it will be.
    pub fn by_any_label(&self, labels: &[&str]) -> Option<&str> {
        labels
            .iter()
            .find_map(|label| self.by_label.get(&label.to_ascii_lowercase()))
            .map(String::as_str)
    }
}

pub async fn work_item_type_fields(
    org: &str,
    project: &str,
    work_item_type: &str,
    pat: &str,
) -> Result<TypeFields, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let type_enc = encode_segment(work_item_type);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/wit/workitemtypes/{type_enc}/fields\
         ?api-version={API_VERSION}"
    );
    let parsed: ListResponse<RawTypeField> = get_json(&url, pat).await?;
    let mut fields = TypeFields::default();
    for field in parsed.value {
        if !field.name.trim().is_empty() {
            fields
                .by_label
                .insert(field.name.trim().to_ascii_lowercase(), field.reference_name.clone());
        }
        fields.reference_names.insert(field.reference_name);
    }
    Ok(fields)
}

/// One node of the area or iteration tree, as the path a work item field takes.
#[derive(Debug, Clone, Serialize)]
pub struct AdoClassificationNode {
    /// `Proyecto\Area\Sub` — exactly what `System.AreaPath` / `System.IterationPath` expect.
    pub path: String,
    pub name: String,
    pub depth: i64,
}

#[derive(Deserialize)]
struct RawClassificationNode {
    name: String,
    #[serde(default)]
    children: Vec<RawClassificationNode>,
}

/// Builds each node's field value from the chain of *names*, not from the `path` the API reports.
///
/// Azure's own `path` for a classification node carries a `\Area\` / `\Iteration\` segment
/// (`\Fabrikam\Area\Web`) that `System.AreaPath` must **not** contain (`Fabrikam\Web`). Walking the
/// names is the only form that is correct for both trees.
fn flatten_nodes(node: &RawClassificationNode, prefix: &str, depth: i64, out: &mut Vec<AdoClassificationNode>) {
    let path = if prefix.is_empty() { node.name.clone() } else { format!("{prefix}\\{}", node.name) };
    out.push(AdoClassificationNode { path: path.clone(), name: node.name.clone(), depth });
    for child in &node.children {
        flatten_nodes(child, &path, depth + 1, out);
    }
}

/// The project's area or iteration tree, flattened. `structure` is `areas` or `iterations`.
pub async fn list_classification_nodes(
    org: &str,
    project: &str,
    structure: &str,
    pat: &str,
) -> Result<Vec<AdoClassificationNode>, String> {
    let structure = match structure {
        "iterations" => "iterations",
        _ => "areas",
    };
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/wit/classificationnodes/{structure}\
         ?$depth=6&api-version={API_VERSION}"
    );
    let root: RawClassificationNode = get_json(&url, pat).await?;
    let mut out = Vec::new();
    flatten_nodes(&root, "", 0, &mut out);
    Ok(out)
}

// ---------- creating a work item ----------

#[derive(Deserialize)]
struct RawCreatedWorkItem {
    id: i64,
    #[serde(rename = "_links", default)]
    links: Option<RawLinks>,
}

#[derive(Deserialize)]
struct RawLinks {
    #[serde(default)]
    html: Option<RawHref>,
}

#[derive(Deserialize)]
struct RawHref {
    #[serde(default)]
    href: Option<String>,
}

/// The three fields the estimate lives in, one per process template. Only the one this type
/// actually defines is sent — see [`work_item_type_fields`].
///
/// Per *process*, not per type: an Agile bug carries Story Points exactly like the user story next
/// to it, and an Agile Feature carries Effort. Reading these as "the story field, the PBI field and
/// the requirement field" is what makes it look like a bug has no estimate.
const ESTIMATE_FIELDS: [&str; 3] = [
    // Agile — User Story, Bug
    "Microsoft.VSTS.Scheduling.StoryPoints",
    // Scrum — Product Backlog Item, Bug; and Agile — Feature, Epic
    "Microsoft.VSTS.Scheduling.Effort",
    // CMMI — Requirement
    "Microsoft.VSTS.Scheduling.Size",
];

// ---------- who new work items go to ----------

/// The field a work item's owner lives in, on every process template Azure ships.
const ASSIGNED_TO: &str = "System.AssignedTo";

/// The two halves of an hours estimate. Both are on Task in every stock process, and on the
/// backlog item types only in some — which is why every write of them is behind a `has`.
const ORIGINAL_ESTIMATE: &str = "Microsoft.VSTS.Scheduling.OriginalEstimate";
const REMAINING_WORK: &str = "Microsoft.VSTS.Scheduling.RemainingWork";

/// What kind of work a task is, on the stock Agile and Scrum Task. A picklist: writing a value it
/// does not offer is refused, so the values sent are Azure's own English ones.
const ACTIVITY: &str = "Microsoft.VSTS.Common.Activity";

/// The names a "task type" field answers to on the form, in the order they are tried. Stock Azure
/// has no such field outside CMMI, so this is mostly for a customised process — a team that added
/// one and calls it something else can be covered by adding the word here.
const TASK_TYPE_LABELS: [&str; 4] =
    ["Task Type", "Tipo de tarea", "Tipo de Tarea", "TaskType"];

/// Whoever the token belongs to, remembered for the life of the process.
///
/// Everything this app creates is created *by* that person — it is their PAT — so it lands assigned
/// to them rather than in the unassigned pile somebody has to triage afterwards. Azure has no `@Me`
/// for a field write (the macro is a *query* one), so the person has to be resolved by name first.
///
/// Cached because that resolution is a round trip whose answer cannot change while the app runs: a
/// publish of twenty stories would otherwise ask twenty times. Keyed by the token as well as the
/// org, so a PAT swapped in Settings is a different question rather than a stale answer. Only a
/// successful lookup is stored — a probe that failed because the network was down should be asked
/// again, not remembered as "nobody".
///
/// `None` when the lookup fails, never an error: not knowing who to assign to is a reason to create
/// the item unassigned, not a reason to refuse to create it.
async fn assignee(org: &str, pat: &str) -> Option<String> {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    pat.hash(&mut hasher);
    let key = format!("{}|{:x}", normalize_org(org), hasher.finish());

    fn memo() -> &'static std::sync::Mutex<HashMap<String, String>> {
        static MEMO: std::sync::OnceLock<std::sync::Mutex<HashMap<String, String>>> =
            std::sync::OnceLock::new();
        MEMO.get_or_init(Default::default)
    }

    if let Some(hit) = memo().lock().ok().and_then(|memo| memo.get(&key).cloned()) {
        return Some(hit);
    }
    let identity = crate::ado::authenticated_identity(org, pat).await.ok()?;
    if let Ok(mut memo) = memo().lock() {
        memo.insert(key, identity.clone());
    }
    Some(identity)
}

/// Why a create came back without a work item.
///
/// The distinction exists for exactly one caller — [`create_assigned`] retries, and a retry is only
/// safe when nothing was created the first time.
struct CreateFailed {
    message: String,
    /// The server read the patch and refused it, so there is nothing on the board. A request that
    /// never completed, or whose answer did not parse, is *not* this: the item may well exist, and
    /// sending it again would leave two.
    refused: bool,
}

async fn post_create(
    url: &str,
    ops: &[serde_json::Value],
    pat: &str,
) -> Result<RawCreatedWorkItem, CreateFailed> {
    let unknown =
        |message: String| CreateFailed { message, refused: false };
    let res = client()
        .post(url)
        .header("Authorization", auth_header(pat))
        .header("Content-Type", "application/json-patch+json")
        .body(serde_json::to_string(ops).map_err(|e| unknown(e.to_string()))?)
        .send()
        .await
        .map_err(|e| unknown(format!("couldn't reach Azure DevOps: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(CreateFailed {
            message: format!("Azure DevOps returned {status}: {body}"),
            refused: true,
        });
    }
    res.json().await.map_err(|e| unknown(format!("unexpected response from Azure DevOps: {e}")))
}

/// Sends a create, and if Azure refuses it, sends it again with only what the item cannot do
/// without.
///
/// `optional` is everything the work item is *better* with and fine without — who it belongs to,
/// what kind of work it is, how long it should take. Azure validates all of it server-side and
/// rejects the whole patch over any one of them: an identity it cannot resolve, an Activity value
/// a customised picklist does not offer, an estimate field the type turns out not to accept. None
/// of that is worth losing the task over, and none of it is knowable from here without asking the
/// server one question per field — so the second attempt asks the only question that matters, by
/// sending the item stripped back to what the user actually typed.
///
/// The retry reports *its own* failure rather than the first one: by then the refusal can only be
/// about the required half, which is the half the user can do something about.
async fn create_item(
    url: &str,
    required: Vec<serde_json::Value>,
    optional: Vec<serde_json::Value>,
    org: &str,
    pat: &str,
) -> Result<RawCreatedWorkItem, String> {
    let mut ops = required.clone();
    ops.extend(optional);
    if let Some(person) = assignee(org, pat).await {
        ops.push(serde_json::json!({
            "op": "add",
            "path": format!("/fields/{ASSIGNED_TO}"),
            "value": person,
        }));
    }

    match post_create(url, &ops, pat).await {
        Ok(created) => Ok(created),
        Err(failed) if failed.refused && ops.len() > required.len() => {
            post_create(url, &required, pat).await.map_err(|again| again.message)
        }
        Err(failed) => Err(failed.message),
    }
}

/// Creates one work item.
///
/// `available_fields` is the type's own field list; `None` means "don't filter" (the probe failed,
/// and refusing to publish because we couldn't read a field list would be worse than trying). Every
/// optional field is dropped when blank rather than sent empty, so a story that says nothing about
/// its iteration inherits the project's default instead of being pinned to the root.
pub async fn create_work_item(
    org: &str,
    project: &str,
    work_item_type: &str,
    item: &NewWorkItem<'_>,
    available_fields: Option<&TypeFields>,
    pat: &str,
) -> Result<ItemRef, String> {
    if item.title.trim().is_empty() {
        return Err("La historia no tiene título".to_string());
    }

    let has = |field: &str| available_fields.is_none_or(|fields| fields.has(field));

    // The narrative and the description share one field: Azure has no separate "story" field, and
    // splitting them across Description and a comment would put half the story where nobody reads it.
    let mut description_html = String::new();
    if !item.narrative.trim().is_empty() {
        description_html.push_str(&format!("<p><b>{}</b></p>", escape_html(item.narrative.trim())));
    }
    description_html.push_str(&text_to_html(item.description));

    // The criteria are the whole point of the screen, so a type without a dedicated field (a
    // Basic-process "Issue") gets them appended to its description rather than losing them.
    let criteria_html = criteria_to_html(item.acceptance_criteria);
    let criteria_own_field = !criteria_html.is_empty() && has("Microsoft.VSTS.Common.AcceptanceCriteria");
    if !criteria_html.is_empty() && !criteria_own_field {
        description_html.push_str(&format!("<p><b>Criterios de aceptación</b></p>{criteria_html}"));
    }

    let mut fields: Vec<(&str, serde_json::Value)> =
        vec![("System.Title", serde_json::json!(item.title.trim()))];
    if !description_html.is_empty() && has("System.Description") {
        fields.push(("System.Description", serde_json::json!(description_html)));
    }
    if criteria_own_field {
        fields.push(("Microsoft.VSTS.Common.AcceptanceCriteria", serde_json::json!(criteria_html)));
    }
    if !item.area_path.trim().is_empty() && has("System.AreaPath") {
        fields.push(("System.AreaPath", serde_json::json!(item.area_path.trim())));
    }
    if !item.iteration_path.trim().is_empty() && has("System.IterationPath") {
        fields.push(("System.IterationPath", serde_json::json!(item.iteration_path.trim())));
    }
    if !item.tags.trim().is_empty() && has("System.Tags") {
        fields.push(("System.Tags", serde_json::json!(item.tags.trim())));
    }
    if item.priority > 0 && has("Microsoft.VSTS.Common.Priority") {
        fields.push(("Microsoft.VSTS.Common.Priority", serde_json::json!(item.priority)));
    }
    if item.story_points > 0.0 {
        if let Some(field) = ESTIMATE_FIELDS.iter().find(|f| has(f)) {
            fields.push((field, serde_json::json!(item.story_points)));
        }
    }
    // Hours, alongside the points rather than instead of them: they answer different questions, and
    // a process template that carries both expects both. A type that carries neither — an Agile
    // User Story does not have Original Estimate — drops them here rather than at the server.
    if item.original_estimate > 0.0 && has(ORIGINAL_ESTIMATE) {
        fields.push((ORIGINAL_ESTIMATE, serde_json::json!(item.original_estimate)));
    }
    if item.remaining_work > 0.0 && has(REMAINING_WORK) {
        fields.push((REMAINING_WORK, serde_json::json!(item.remaining_work)));
    }

    let ops: Vec<serde_json::Value> = fields
        .into_iter()
        .map(|(field, value)| {
            serde_json::json!({ "op": "add", "path": format!("/fields/{field}"), "value": value })
        })
        .collect();

    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let type_enc = encode_segment(work_item_type);
    // The `$` before the type is part of Azure's route, not a typo — `POST .../workitems/$User Story`.
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/wit/workitems/%24{type_enc}\
         ?api-version={API_VERSION}"
    );
    // No `optional` half on this side: everything a story carries was typed by the user, and
    // publishing it to the wrong area path silently would be worse than telling them it failed.
    let created = create_item(&url, ops, Vec::new(), org, pat).await?;
    let url = created
        .links
        .and_then(|l| l.html)
        .and_then(|h| h.href)
        .unwrap_or_else(|| {
            format!("https://dev.azure.com/{org_enc}/{project_enc}/_workitems/edit/{}", created.id)
        });
    // No `key`: on Azure the id is what people read out loud, and inventing a second name for it
    // would put two different labels on the same item depending on which screen you were looking at.
    Ok(ItemRef { id: created.id, url, key: String::new() })
}

// ---------- writing back to a work item that already exists ----------

/// Applies an edit to a work item that already exists.
///
/// The counterpart to [`create_work_item`], and the first thing in this module that changes a work
/// item somebody else may be looking at. Two consequences are deliberate:
///
/// - **`replace` on a field that may not exist yet.** Azure's JSON-Patch treats `add` on a field as
///   "set it", so `add` is used throughout: `replace` fails on a story whose Acceptance Criteria
///   field has never been filled in, which is exactly the story this screen exists to fix.
/// - **The criteria are rewritten whole, never merged.** The user curated the list on screen; a
///   merge would reintroduce what they deleted, and there is no identity on a criterion to merge by.
pub async fn update_work_item(
    org: &str,
    id: i64,
    edit: &WorkItemEdit,
    pat: &str,
) -> Result<ItemRef, String> {
    if id <= 0 {
        return Err("Ese identificador de work item no es válido".to_string());
    }

    let mut fields: Vec<(&str, serde_json::Value)> = Vec::new();
    if let Some(title) = &edit.title {
        if title.trim().is_empty() {
            return Err("El work item no puede quedarse sin título".to_string());
        }
        fields.push(("System.Title", serde_json::json!(title.trim())));
    }
    let prose = |text: &String| match edit.prose_is_html {
        true => text.clone(),
        false => text_to_html(text),
    };
    if let Some(description) = &edit.description {
        fields.push(("System.Description", serde_json::json!(prose(description))));
    }
    if let Some(steps) = &edit.repro_steps {
        fields.push(("Microsoft.VSTS.TCM.ReproSteps", serde_json::json!(prose(steps))));
    }
    if let Some(criteria) = &edit.acceptance_criteria {
        fields.push((
            "Microsoft.VSTS.Common.AcceptanceCriteria",
            serde_json::json!(criteria_to_html(criteria)),
        ));
    }
    // Into the field the item already uses, read from the item itself rather than guessed from its
    // type: `ESTIMATE_FIELDS` holds one name per process template, only one of which the type
    // defines, and writing the wrong one is a 400 for the whole patch. An item that has never been
    // estimated reports no field, so the ladder is walked and the first name is used — which is
    // the Agile one, and the only one an Agile story would have accepted anyway.
    if let Some(effort) = edit.effort {
        let field = match edit.effort_field.trim() {
            "" => ESTIMATE_FIELDS[0],
            named => named,
        };
        fields.push((field, serde_json::json!(effort)));
    }
    if fields.is_empty() {
        return Err("No hay nada que publicar".to_string());
    }

    let ops: Vec<serde_json::Value> = fields
        .into_iter()
        .map(|(field, value)| {
            serde_json::json!({ "op": "add", "path": format!("/fields/{field}"), "value": value })
        })
        .collect();

    let org_enc = encode_segment(&normalize_org(org));
    let url =
        format!("https://dev.azure.com/{org_enc}/_apis/wit/workitems/{id}?api-version={API_VERSION}");
    let res = client()
        .patch(&url)
        .header("Authorization", auth_header(pat))
        .header("Content-Type", "application/json-patch+json")
        .body(serde_json::to_string(&ops).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Azure DevOps returned {status}: {body}"));
    }

    Ok(ItemRef {
        id,
        url: format!("https://dev.azure.com/{org_enc}/_workitems/edit/{id}"),
        key: String::new(),
    })
}

/// Creates one child work item under an existing parent.
///
/// The parent link is part of the same create rather than a second call: a task that exists for a
/// moment with no parent is a task somebody's board query can pick up as orphaned, and a failure
/// between the two calls would leave exactly that behind permanently.
/// Where a work item is filed: its area, and the iteration that puts it in a sprint.
///
/// Read from the host rather than taken from whatever the screen last loaded, because those are
/// exactly the two fields somebody moves on the board — dragging a story into the next sprint is
/// the commonest edit there is, and a task created from a stale copy lands in the sprint the story
/// used to be in, which is worse than landing nowhere.
///
/// Asks for the two fields by name, so this stays one small response however large the item is.
pub async fn classification_of(org: &str, id: i64, pat: &str) -> Result<(String, String), String> {
    let org_enc = encode_segment(&normalize_org(org));
    let url = format!(
        "https://dev.azure.com/{org_enc}/_apis/wit/workitems/{id}\
         ?fields=System.AreaPath,System.IterationPath&api-version={API_VERSION}"
    );
    let raw: RawWorkItem = get_json(&url, pat).await?;
    Ok((
        field_str(&raw.fields, "System.AreaPath"),
        field_str(&raw.fields, "System.IterationPath"),
    ))
}

/// `available_fields` plays the same part it does in [`create_work_item`], and one part more: the
/// planning fields a task carries are the ones this screen is asked to fill, and which of them the
/// type has — and what the team calls the one that holds "QA" — is only knowable from it. `None`
/// means the probe failed, and the fields go out unfiltered rather than the task not being created.
pub async fn create_child_work_item(
    org: &str,
    project: &str,
    parent_id: i64,
    work_item_type: &str,
    task: &NewChildItem<'_>,
    available_fields: Option<&TypeFields>,
    pat: &str,
) -> Result<ItemRef, String> {
    if task.title.trim().is_empty() {
        return Err("Esa tarea no tiene título".to_string());
    }
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let type_enc = encode_segment(work_item_type);
    let has = |field: &str| available_fields.is_none_or(|fields| fields.has(field));

    // What the task is: its words, and where it hangs. Nothing here is negotiable, so nothing here
    // is dropped on a retry.
    let mut required = vec![serde_json::json!({
        "op": "add",
        "path": "/fields/System.Title",
        "value": task.title.trim(),
    })];
    if !task.detail.trim().is_empty() {
        required.push(serde_json::json!({
            "op": "add",
            "path": "/fields/System.Description",
            "value": text_to_html(task.detail),
        }));
    }
    // `Hierarchy-Reverse` points *up*: the relation is added to the child and names the parent.
    required.push(serde_json::json!({
        "op": "add",
        "path": "/relations/-",
        "value": {
            "rel": "System.LinkTypes.Hierarchy-Reverse",
            "url": format!("https://dev.azure.com/{org_enc}/_apis/wit/workItems/{parent_id}"),
        },
    }));

    // How the board plans it. Every one is filtered against the type's own field list first, and
    // whatever survives that and is still refused is dropped by the retry — see [`create_item`].
    let mut optional: Vec<serde_json::Value> = Vec::new();
    let mut field = |name: &str, value: serde_json::Value| {
        optional.push(serde_json::json!({
            "op": "add",
            "path": format!("/fields/{name}"),
            "value": value,
        }));
    };
    if !task.activity.trim().is_empty() && has(ACTIVITY) {
        field(ACTIVITY, serde_json::json!(task.activity.trim()));
    }
    // Only where the project actually has such a field — stock Agile and Scrum do not, and naming a
    // field the type has never heard of is a 400 for the whole task rather than one ignored value.
    if !task.task_type.trim().is_empty() {
        if let Some(name) = available_fields.and_then(|fields| fields.by_any_label(&TASK_TYPE_LABELS))
        {
            field(name, serde_json::json!(task.task_type.trim()));
        }
    }
    if task.priority > 0 && has("Microsoft.VSTS.Common.Priority") {
        field("Microsoft.VSTS.Common.Priority", serde_json::json!(task.priority));
    }
    if task.original_estimate > 0.0 && has(ORIGINAL_ESTIMATE) {
        field(ORIGINAL_ESTIMATE, serde_json::json!(task.original_estimate));
    }
    if task.remaining_work > 0.0 && has(REMAINING_WORK) {
        field(REMAINING_WORK, serde_json::json!(task.remaining_work));
    }
    // Blank means the parent had none, in which case Azure's own default for the project is a
    // better answer than pinning the task to the root.
    if !task.area_path.trim().is_empty() && has("System.AreaPath") {
        field("System.AreaPath", serde_json::json!(task.area_path.trim()));
    }
    if !task.iteration_path.trim().is_empty() && has("System.IterationPath") {
        field("System.IterationPath", serde_json::json!(task.iteration_path.trim()));
    }

    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/wit/workitems/%24{type_enc}\
         ?api-version={API_VERSION}"
    );
    let created = create_item(&url, required, optional, org, pat).await?;
    let html = created
        .links
        .and_then(|l| l.html)
        .and_then(|h| h.href)
        .unwrap_or_else(|| format!("https://dev.azure.com/{org_enc}/_workitems/edit/{}", created.id));
    Ok(ItemRef { id: created.id, url: html, key: String::new() })
}

// ---------- reading a work item that already exists ----------

#[derive(Deserialize)]
struct RawWorkItem {
    id: i64,
    #[serde(default)]
    fields: HashMap<String, serde_json::Value>,
    #[serde(default)]
    relations: Vec<RawRelation>,
    #[serde(rename = "_links", default)]
    links: Option<RawLinks>,
}

#[derive(Deserialize)]
struct RawRelation {
    #[serde(default)]
    rel: String,
    #[serde(default)]
    url: String,
}

fn field_str(fields: &HashMap<String, serde_json::Value>, name: &str) -> String {
    fields.get(name).and_then(|value| value.as_str()).unwrap_or_default().to_string()
}

/// An identity field, as the person's display name.
///
/// Azure returns AssignedTo as an identity object, not a string — `{"displayName": …,
/// "uniqueName": …}` — so [`field_str`] would read it as empty. The string fallback covers the
/// old on-premises servers that still send a combined `"Name <email>"` string.
fn field_person(fields: &HashMap<String, serde_json::Value>, name: &str) -> String {
    let Some(value) = fields.get(name) else { return String::new() };
    value
        .get("displayName")
        .and_then(|display| display.as_str())
        .or_else(|| value.as_str())
        .unwrap_or_default()
        .to_string()
}

/// The first of `names` the item actually filled in, and which one that was.
///
/// Prose lives in a different field per work item type — `System.Description` for a story, Repro
/// Steps for a bug, Symptom for a CMMI bug — and the type list is open: an inherited process can
/// rename or add. Asking the item what it has beats deciding from its type name, which would have
/// to be matched against a catalogue that a customer's own process is free to fall outside of.
fn first_filled<'a>(
    fields: &HashMap<String, serde_json::Value>,
    names: &[&'a str],
) -> (String, &'a str) {
    for name in names {
        let value = field_str(fields, name);
        if !value.trim().is_empty() {
            return (value, name);
        }
    }
    (String::new(), "")
}

/// A numeric field, as a number.
///
/// Story points and effort come back as JSON numbers, so [`field_str`]'s `as_str` returns `None`
/// for them and the estimate would read as absent rather than as five. The string fallback is for
/// an inherited process that declared its own estimate field as text.
fn field_f64(fields: &HashMap<String, serde_json::Value>, name: &str) -> Option<f64> {
    let value = fields.get(name)?;
    value.as_f64().or_else(|| value.as_str()?.trim().parse().ok())
}

/// The estimate and the field it came from. `ESTIMATE_FIELDS` is process-wide rather than
/// per-type: an Agile bug carries Story Points exactly like the story next to it does.
fn estimate_of(fields: &HashMap<String, serde_json::Value>) -> (f64, String) {
    for name in ESTIMATE_FIELDS {
        if let Some(value) = field_f64(fields, name) {
            return (value, name.to_string());
        }
    }
    (0.0, String::new())
}

/// The id at the end of `…/_apis/wit/workItems/1234` — how a relation names what it points at.
fn id_from_relation_url(url: &str) -> Option<i64> {
    url.rsplit('/').next()?.parse().ok()
}

/// Azure's batch read caps at 200 ids, and a story with more children than that has a problem this
/// screen can't help with.
const MAX_CHILDREN: usize = 200;

/// One work item, plus the children it already has.
///
/// Addressed by organisation rather than by project: the id is unique across the organisation, so
/// this still resolves an item that has been moved since the link was copied.
pub async fn get_work_item(org: &str, id: i64, pat: &str) -> Result<WorkItem, String> {
    if id <= 0 {
        return Err("Ese identificador de work item no es válido".to_string());
    }
    let org_enc = encode_segment(&normalize_org(org));
    let url = format!(
        "https://dev.azure.com/{org_enc}/_apis/wit/workitems/{id}\
         ?$expand=relations&api-version={API_VERSION}"
    );
    let raw: RawWorkItem = get_json(&url, pat).await?;

    let child_ids: Vec<i64> = raw
        .relations
        .iter()
        .filter(|relation| relation.rel == "System.LinkTypes.Hierarchy-Forward")
        .filter_map(|relation| id_from_relation_url(&relation.url))
        .take(MAX_CHILDREN)
        .collect();
    // Best-effort: the story is what the user asked for, and a child in a project this PAT cannot
    // read must not cost them the whole item.
    let children = match child_ids.is_empty() {
        true => Vec::new(),
        false => list_work_items(&org_enc, &child_ids, pat).await.unwrap_or_default(),
    };

    let html_url = raw
        .links
        .and_then(|links| links.html)
        .and_then(|link| link.href)
        .unwrap_or_else(|| format!("https://dev.azure.com/{org_enc}/_workitems/edit/{id}"));

    // The GET asks for no `fields=` filter, so everything the item has is already in hand — the
    // description and the estimate are a mapping problem here, not another round trip.
    let (repro_steps_html, _) = first_filled(
        &raw.fields,
        &["Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.CMMI.Symptom"],
    );
    let (effort, effort_field) = estimate_of(&raw.fields);

    Ok(WorkItem {
        id: raw.id,
        url: html_url,
        key: String::new(),
        work_item_type: field_str(&raw.fields, "System.WorkItemType"),
        title: field_str(&raw.fields, "System.Title"),
        state: field_str(&raw.fields, "System.State"),
        team_project: field_str(&raw.fields, "System.TeamProject"),
        // Azure addresses a project by the same name it shows, so the two are one string here.
        container_id: field_str(&raw.fields, "System.TeamProject"),
        description_html: field_str(&raw.fields, "System.Description"),
        repro_steps_html,
        system_info_html: field_str(&raw.fields, "Microsoft.VSTS.TCM.SystemInfo"),
        acceptance_criteria_html: field_str(&raw.fields, "Microsoft.VSTS.Common.AcceptanceCriteria"),
        effort,
        effort_field,
        tags: field_str(&raw.fields, "System.Tags"),
        area_path: field_str(&raw.fields, "System.AreaPath"),
        iteration_path: field_str(&raw.fields, "System.IterationPath"),
        children,
    })
}

async fn list_work_items(
    org_enc: &str,
    ids: &[i64],
    pat: &str,
) -> Result<Vec<WorkItemChild>, String> {
    let list = ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
    // `errorPolicy=omit` returns the readable ones instead of failing the batch over a single item
    // the PAT can't see — and it reports those as nulls, hence the `Option` in the envelope.
    let url = format!(
        "https://dev.azure.com/{org_enc}/_apis/wit/workitems\
         ?ids={list}&fields=System.Title,System.State,System.WorkItemType,System.Description,\
         Microsoft.VSTS.TCM.ReproSteps,Microsoft.VSTS.CMMI.Symptom,System.AssignedTo\
         &errorPolicy=omit&api-version={API_VERSION}"
    );
    let raw: ListResponse<Option<RawWorkItem>> = get_json(&url, pat).await?;
    Ok(raw
        .value
        .into_iter()
        .flatten()
        .map(|item| {
            let (description_html, _) = first_filled(
                &item.fields,
                &["System.Description", "Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.CMMI.Symptom"],
            );
            WorkItemChild {
                url: format!("https://dev.azure.com/{org_enc}/_workitems/edit/{}", item.id),
                id: item.id,
                key: String::new(),
                work_item_type: field_str(&item.fields, "System.WorkItemType"),
                title: field_str(&item.fields, "System.Title"),
                state: field_str(&item.fields, "System.State"),
                description_html,
                assigned_to: field_person(&item.fields, "System.AssignedTo"),
            }
        })
        .collect())
}

/// Enough of a percent-decoder for one path segment: project names travel as `%20`-style escapes
/// and have to come back as the name the user would recognise.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 3 <= bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[at + 1..at + 3], 16) {
                out.push(byte);
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_string())
}

/// Reads a work item out of whatever the user pasted: an edit URL, a board URL that names the item
/// in its query string, or the bare number somebody read out in standup.
///
/// Deliberately lenient about the host. Azure DevOps is served from `dev.azure.com`, from the older
/// `{org}.visualstudio.com`, and from on-premises Server installs on any hostname at all — so what
/// identifies a work item here is the `_workitems` segment, not the domain it sits under.
pub fn parse_work_item_ref(input: &str) -> Option<WorkItemRef> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }

    // A bare id, with or without the `#` people put in front of it in chat.
    let bare = text.strip_prefix('#').unwrap_or(text);
    if let Ok(id) = bare.parse::<i64>() {
        return (id > 0).then_some(WorkItemRef {
            org: None,
            project: None,
            id,
            key: String::new(),
            provider: BoardProvider::Azure,
        });
    }

    let without_scheme = text.split_once("://").map_or(text, |(_, rest)| rest);
    let (path, query) = without_scheme.split_once('?').unwrap_or((without_scheme, ""));
    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty()).collect();
    let host = *segments.first()?;
    if !host.contains('.') {
        return None;
    }

    let marker = segments.iter().position(|segment| segment.eq_ignore_ascii_case("_workitems"));
    let id = match marker {
        Some(at) => segments.iter().skip(at + 1).find_map(|segment| segment.parse::<i64>().ok()),
        // A board or backlog URL names the card it has open in the query string instead.
        None => query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(key, _)| key.eq_ignore_ascii_case("workitem") || key.eq_ignore_ascii_case("id"))
            .and_then(|(_, value)| value.parse::<i64>().ok()),
    }?;
    if id <= 0 {
        return None;
    }

    // On `{org}.visualstudio.com` the organisation is the subdomain, so the first path segment is
    // already the project; everywhere else the organisation is that first segment.
    let (org, project_at) = match host.strip_suffix(".visualstudio.com") {
        Some(name) => (Some(percent_decode(name)), 1),
        None => (
            segments.get(1).filter(|s| !s.starts_with('_')).map(|s| percent_decode(s)),
            2,
        ),
    };
    let project = segments
        .get(project_at)
        .filter(|segment| !segment.starts_with('_'))
        .filter(|_| marker.is_none_or(|at| project_at < at))
        .map(|segment| percent_decode(segment));

    Some(WorkItemRef { org, project, id, key: String::new(), provider: BoardProvider::Azure })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Azure half of a reference. `key` and `provider` are constant on this arm — spelling them
    /// out in every expectation would bury the two fields each test is actually about.
    fn azure_ref(org: Option<&str>, project: Option<&str>, id: i64) -> Option<WorkItemRef> {
        Some(WorkItemRef {
            org: org.map(str::to_string),
            project: project.map(str::to_string),
            id,
            key: String::new(),
            provider: BoardProvider::Azure,
        })
    }

    #[test]
    fn reads_a_work_item_out_of_an_edit_url() {
        assert_eq!(
            parse_work_item_ref("https://dev.azure.com/fabrikam/Web%20Store/_workitems/edit/4821"),
            azure_ref(Some("fabrikam"), Some("Web Store"), 4821)
        );
    }

    /// The older host puts the organisation in the subdomain, which moves every path segment along
    /// one — read positionally, the project would come back as the organisation.
    #[test]
    fn the_visualstudio_host_keeps_its_org_in_the_subdomain() {
        assert_eq!(
            parse_work_item_ref("https://fabrikam.visualstudio.com/Checkout/_workitems/edit/12"),
            azure_ref(Some("fabrikam"), Some("Checkout"), 12)
        );
    }

    /// A URL with no project in it must not promote `_workitems` into the project slot.
    #[test]
    fn an_org_level_url_reports_no_project() {
        assert_eq!(
            parse_work_item_ref("https://dev.azure.com/fabrikam/_workitems/edit/7"),
            azure_ref(Some("fabrikam"), None, 7)
        );
    }

    /// Dragging a card open on a board never leaves `_workitems` in the path — the id is in the
    /// query string, and that is the URL sitting in the address bar when someone copies it.
    #[test]
    fn a_board_url_names_its_open_card_in_the_query() {
        assert_eq!(
            parse_work_item_ref("https://dev.azure.com/fabrikam/Checkout/_boards/board/t/Team/Stories/?workitem=903"),
            azure_ref(Some("fabrikam"), Some("Checkout"), 903)
        );
    }

    #[test]
    fn a_bare_id_carries_no_org_of_its_own() {
        assert_eq!(
            parse_work_item_ref("  #4821 "),
            azure_ref(None, None, 4821)
        );
        assert_eq!(parse_work_item_ref("4821"), azure_ref(None, None, 4821));
    }

    #[test]
    fn nothing_that_names_no_work_item_parses() {
        assert_eq!(parse_work_item_ref(""), None);
        assert_eq!(parse_work_item_ref("0"), None);
        assert_eq!(parse_work_item_ref("-3"), None);
        assert_eq!(parse_work_item_ref("una historia sobre el checkout"), None);
        assert_eq!(parse_work_item_ref("https://dev.azure.com/fabrikam/Checkout/_git/repo"), None);
    }

    fn fields_of(pairs: &[(&str, serde_json::Value)]) -> HashMap<String, serde_json::Value> {
        pairs.iter().map(|(k, v)| ((*k).to_string(), v.clone())).collect()
    }

    /// The bug case that started this: `System.Description` exists on the type and is empty,
    /// because the Agile bug form writes its prose into Repro Steps instead.
    #[test]
    fn a_bug_narrates_in_its_repro_steps() {
        let fields = fields_of(&[
            ("System.Description", serde_json::json!("")),
            ("Microsoft.VSTS.TCM.ReproSteps", serde_json::json!("<div>1. Abrir la OT</div>")),
        ]);
        let (text, from) = first_filled(
            &fields,
            &["Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.CMMI.Symptom"],
        );
        assert_eq!(text, "<div>1. Abrir la OT</div>");
        assert_eq!(from, "Microsoft.VSTS.TCM.ReproSteps");
    }

    #[test]
    fn a_field_nobody_filled_in_names_nothing() {
        let fields = fields_of(&[("Microsoft.VSTS.TCM.ReproSteps", serde_json::json!("   "))]);
        let (text, from) = first_filled(&fields, &["Microsoft.VSTS.TCM.ReproSteps"]);
        assert!(text.is_empty());
        assert_eq!(from, "", "whitespace is not prose");
    }

    /// The estimate arrives as a JSON *number*, so the string accessor reads it as absent — which
    /// is exactly how an estimated story came back saying it had none.
    #[test]
    fn the_estimate_is_read_as_a_number() {
        let fields = fields_of(&[("Microsoft.VSTS.Scheduling.StoryPoints", serde_json::json!(5))]);
        assert_eq!(field_str(&fields, "Microsoft.VSTS.Scheduling.StoryPoints"), "");
        assert_eq!(estimate_of(&fields), (5.0, "Microsoft.VSTS.Scheduling.StoryPoints".to_string()));
    }

    #[test]
    fn scrum_and_cmmi_estimates_are_found_under_their_own_names() {
        let scrum = fields_of(&[("Microsoft.VSTS.Scheduling.Effort", serde_json::json!(8.0))]);
        assert_eq!(estimate_of(&scrum).0, 8.0);
        let cmmi = fields_of(&[("Microsoft.VSTS.Scheduling.Size", serde_json::json!("13"))]);
        assert_eq!(cmmi.len(), 1);
        assert_eq!(estimate_of(&cmmi).0, 13.0, "a process that declared it as text still counts");
    }

    /// Basic defines no estimate field at all, so "no estimate" has to be a legitimate answer
    /// rather than something the UI reports as a failed read.
    #[test]
    fn an_unestimated_item_reports_zero_and_no_field() {
        assert_eq!(estimate_of(&fields_of(&[])), (0.0, String::new()));
    }

    fn type_fields(pairs: &[(&str, &str)]) -> TypeFields {
        let mut fields = TypeFields::default();
        for (label, reference) in pairs {
            fields.by_label.insert(label.to_ascii_lowercase(), reference.to_string());
            fields.reference_names.insert(reference.to_string());
        }
        fields
    }

    /// The point of looking a field up by its label: the reference name behind "Task Type" is a
    /// GUID on a customised process and nothing at all on a stock Agile one, so the only stable
    /// handle on it is what the team sees on the form.
    #[test]
    fn a_task_type_field_is_found_by_whatever_the_form_calls_it() {
        let custom = type_fields(&[("Task Type", "Custom.a1b2c3.TaskType")]);
        assert_eq!(custom.by_any_label(&TASK_TYPE_LABELS), Some("Custom.a1b2c3.TaskType"));

        // Case is not the team's problem, and a Spanish-language organisation names it in Spanish.
        let spanish = type_fields(&[("tipo de tarea", "Custom.Tipo")]);
        assert_eq!(spanish.by_any_label(&TASK_TYPE_LABELS), Some("Custom.Tipo"));

        // Stock Agile has no such field, and inventing one would fail the whole create.
        let agile = type_fields(&[("Activity", ACTIVITY), ("Priority", "Microsoft.VSTS.Common.Priority")]);
        assert_eq!(agile.by_any_label(&TASK_TYPE_LABELS), None);
        assert!(agile.has(ACTIVITY));
        assert!(!agile.has(ORIGINAL_ESTIMATE), "a type that has no such field must say so");
    }

    /// A relation points at the API route, not the page — the id is the last segment either way,
    /// and reading it wrong would attach somebody else's children to the story.
    #[test]
    fn a_relation_url_gives_up_its_id() {
        assert_eq!(
            id_from_relation_url("https://dev.azure.com/fabrikam/_apis/wit/workItems/512"),
            Some(512)
        );
        assert_eq!(id_from_relation_url("https://dev.azure.com/fabrikam/_apis/wit/workItems/"), None);
    }

    /// A classification node's work-item field value is the chain of names — never the `path`
    /// Azure reports, which carries an `\Area\` segment `System.AreaPath` must not contain.
    #[test]
    fn classification_paths_are_built_from_names() {
        let root = RawClassificationNode {
            name: "Fabrikam".to_string(),
            children: vec![RawClassificationNode {
                name: "Web".to_string(),
                children: vec![RawClassificationNode { name: "Checkout".to_string(), children: vec![] }],
            }],
        };
        let mut out = Vec::new();
        flatten_nodes(&root, "", 0, &mut out);
        let paths: Vec<&str> = out.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, ["Fabrikam", "Fabrikam\\Web", "Fabrikam\\Web\\Checkout"]);
        assert_eq!(out[2].depth, 2);
    }

    /// The wiki tree arrives nested and has to come out flat *and* depth-tagged, with the root
    /// itself left out — it is the wiki, not a page.
    #[test]
    fn wiki_pages_flatten_without_the_root() {
        let root = RawWikiPage {
            path: Some("/".to_string()),
            content: None,
            git_item_path: None,
            sub_pages: vec![RawWikiPage {
                path: Some("/Producto".to_string()),
                content: None,
                git_item_path: None,
                sub_pages: vec![RawWikiPage {
                    path: Some("/Producto/Checkout-web".to_string()),
                    content: None,
                    git_item_path: None,
                    sub_pages: vec![],
                }],
            }],
        };
        let mut out = Vec::new();
        flatten_pages(&root, 0, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path, "/Producto");
        assert!(out[0].has_children);
        assert_eq!(out[1].depth, 1);
        // Wiki paths spell spaces as dashes; the title is what a human reads.
        assert_eq!(out[1].title, "Checkout web");
    }

    /// Everything written in the app is plain text, and the fields it lands in are HTML.
    #[test]
    fn text_and_criteria_are_escaped_into_html() {
        let html = text_to_html("Primer párrafo <con marcado>\nsegunda línea\n\nOtro párrafo");
        assert!(html.contains("&lt;con marcado&gt;"), "{html}");
        assert!(html.contains("<br>segunda línea"), "{html}");
        assert_eq!(html.matches("<p>").count(), 2, "{html}");

        let criteria = criteria_to_html(&[
            "Dado que soy usuario\nCuando entro\nEntonces veo el panel".to_string(),
            "   ".to_string(),
        ]);
        assert!(criteria.starts_with("<ol><li>"), "{criteria}");
        assert_eq!(criteria.matches("<li>").count(), 1, "{criteria}");
        assert!(criteria_to_html(&[]).is_empty());
    }
}
