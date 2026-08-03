//! Azure DevOps **Wiki** (read) and **Boards** (read + write).
//!
//! Split from [`crate::ado`] rather than added to it: that module is the pull-request client, and
//! everything here belongs to a different half of the product — the wiki a requirement is written
//! in, and the work item it ends up as. The low-level plumbing (auth header, org normalisation,
//! path encoding, the `{value: […]}` envelope) is shared from there, so both halves speak to the
//! same server the same way.
//!
//! Nothing here edits or deletes anything that already exists on the host: wiki pages and work
//! items are read, and work items are created. A story that is already on the board can be pulled
//! in and reviewed, but whatever the review concludes goes back through the user's own hands.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

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
}

#[derive(Deserialize)]
struct RawWiki {
    id: String,
    name: String,
    #[serde(rename = "type", default)]
    kind: String,
}

pub async fn list_wikis(org: &str, project: &str, pat: &str) -> Result<Vec<AdoWiki>, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!("https://dev.azure.com/{org}/{project}/_apis/wiki/wikis?api-version={API_VERSION}");
    let parsed: ListResponse<RawWiki> = get_json(&url, pat).await?;
    Ok(parsed
        .value
        .into_iter()
        .map(|w| AdoWiki { id: w.id, name: w.name, kind: w.kind })
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

#[derive(Debug, Clone, Serialize)]
pub struct AdoWorkItemType {
    pub name: String,
    pub reference_name: String,
    pub description: String,
    /// Hex without the leading `#`, as Azure reports it — the picker tints its dot with it.
    pub color: String,
}

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
) -> Result<Vec<AdoWorkItemType>, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url =
        format!("https://dev.azure.com/{org}/{project}/_apis/wit/workitemtypes?api-version={API_VERSION}");
    let parsed: ListResponse<RawWorkItemType> = get_json(&url, pat).await?;
    Ok(parsed
        .value
        .into_iter()
        .filter(|t| !t.is_disabled)
        .map(|t| AdoWorkItemType {
            name: t.name,
            reference_name: t.reference_name,
            description: t.description,
            color: t.color,
        })
        .collect())
}

#[derive(Deserialize)]
struct RawTypeField {
    #[serde(rename = "referenceName", default)]
    reference_name: String,
}

/// The reference names of every field this work item type actually has.
///
/// This is what keeps a publish from being rejected wholesale: a Basic-process "Issue" has no
/// acceptance-criteria field and no story points, and Azure answers a patch naming a field the type
/// doesn't define with a 400 for the *whole* work item. Knowing the field list up front means the
/// story is created with whatever the type can hold instead of not being created at all.
pub async fn work_item_type_fields(
    org: &str,
    project: &str,
    work_item_type: &str,
    pat: &str,
) -> Result<HashSet<String>, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let type_enc = encode_segment(work_item_type);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/wit/workitemtypes/{type_enc}/fields\
         ?api-version={API_VERSION}"
    );
    let parsed: ListResponse<RawTypeField> = get_json(&url, pat).await?;
    Ok(parsed.value.into_iter().map(|f| f.reference_name).collect())
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

/// The fields Azure DevOps stores as HTML rather than as Markdown. Everything a story carries is
/// authored as plain text in the app, so it is escaped and wrapped here — pasting raw text into an
/// HTML field renders every `<` as a broken tag and collapses every line break.
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// Plain text → HTML paragraphs. A blank line starts a new paragraph, a single newline is a break,
/// which is how the text reads in the editor it was written in.
fn text_to_html(text: &str) -> String {
    text.split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .map(|block| format!("<p>{}</p>", escape_html(block).replace('\n', "<br>")))
        .collect::<Vec<_>>()
        .join("")
}

/// The acceptance criteria as an ordered list. One `<li>` per criterion; a criterion written in
/// Gherkin keeps its Dado/Cuando/Entonces on their own lines inside its own item.
fn criteria_to_html(criteria: &[String]) -> String {
    let items: Vec<String> = criteria
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .map(|c| format!("<li>{}</li>", escape_html(c).replace('\n', "<br>")))
        .collect();
    if items.is_empty() {
        return String::new();
    }
    format!("<ol>{}</ol>", items.join(""))
}

/// Everything one story contributes to a work item. Assembled by the command layer from the stored
/// draft, so this module never has to know what a draft row looks like.
pub struct NewWorkItem<'a> {
    pub title: &'a str,
    /// The "Como … quiero … para …" line. Rendered above the description so the work item opens
    /// with the story itself rather than with its context.
    pub narrative: &'a str,
    pub description: &'a str,
    pub acceptance_criteria: &'a [String],
    /// Empty means "leave the project default", which is what Azure applies when the field is absent.
    pub area_path: &'a str,
    pub iteration_path: &'a str,
    /// Comma- or semicolon-separated, as Azure stores tags.
    pub tags: &'a str,
    /// `0` means unset for both — Azure's own defaults are better than a made-up number.
    pub priority: i64,
    pub story_points: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoWorkItemRef {
    pub id: i64,
    /// The page a human opens, not the REST resource.
    pub url: String,
}

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
    available_fields: Option<&HashSet<String>>,
    pat: &str,
) -> Result<AdoWorkItemRef, String> {
    if item.title.trim().is_empty() {
        return Err("La historia no tiene título".to_string());
    }

    let has = |field: &str| available_fields.is_none_or(|fields| fields.contains(field));

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
    let res = client()
        .post(&url)
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
    let created: RawCreatedWorkItem =
        res.json().await.map_err(|e| format!("unexpected response from Azure DevOps: {e}"))?;
    let url = created
        .links
        .and_then(|l| l.html)
        .and_then(|h| h.href)
        .unwrap_or_else(|| {
            format!("https://dev.azure.com/{org_enc}/{project_enc}/_workitems/edit/{}", created.id)
        });
    Ok(AdoWorkItemRef { id: created.id, url })
}

// ---------- reading a work item that already exists ----------

/// A work item as the review screen needs it.
///
/// The prose arrives as the HTML Azure stores it in, unconverted. The review only reads it, and
/// leaving one converter — the frontend's, which has to render the thing anyway — is what keeps the
/// text the user is looking at and the text the analysis judged from drifting apart.
#[derive(Debug, Clone, Serialize)]
pub struct AdoWorkItem {
    pub id: i64,
    pub url: String,
    pub work_item_type: String,
    pub title: String,
    pub state: String,
    /// The project it lives in. Read rather than taken from the link: this is addressed by
    /// organisation, and a link copied before the item was moved names the old one.
    pub team_project: String,
    pub description_html: String,
    /// `Microsoft.VSTS.TCM.ReproSteps`, which is where a **Bug** actually keeps its prose.
    ///
    /// The Agile and Scrum bug forms have no Description box at all — the field exists on the type,
    /// so the API returns it without complaint, and it is always empty. Reading only
    /// `System.Description` is why a bug loaded with nothing to review.
    pub repro_steps_html: String,
    /// `Microsoft.VSTS.TCM.SystemInfo` — environment, version, OS. Half the context of a bug report
    /// lives here rather than in the steps.
    pub system_info_html: String,
    /// Empty when the process template has no such field, which is not a failure: a Basic-process
    /// "Issue" keeps its criteria inside the description.
    pub acceptance_criteria_html: String,
    /// The estimate, whatever this process calls it. `0.0` means "not estimated" — which for a
    /// Basic-process item is the only possible answer, since Basic defines no estimate field.
    pub effort: f64,
    /// Which field the estimate came out of, so the UI can say "Story Points" or "Effort" rather
    /// than inventing a name for a number whose meaning is per-process.
    pub effort_field: String,
    pub tags: String,
    pub area_path: String,
    pub iteration_path: String,
    /// Hierarchy children — the tasks the story already has, which the review shows before
    /// proposing any of its own.
    pub children: Vec<AdoWorkItemChild>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdoWorkItemChild {
    pub id: i64,
    pub url: String,
    pub work_item_type: String,
    pub title: String,
    pub state: String,
}

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
pub async fn get_work_item(org: &str, id: i64, pat: &str) -> Result<AdoWorkItem, String> {
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

    Ok(AdoWorkItem {
        id: raw.id,
        url: html_url,
        work_item_type: field_str(&raw.fields, "System.WorkItemType"),
        title: field_str(&raw.fields, "System.Title"),
        state: field_str(&raw.fields, "System.State"),
        team_project: field_str(&raw.fields, "System.TeamProject"),
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
) -> Result<Vec<AdoWorkItemChild>, String> {
    let list = ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
    // `errorPolicy=omit` returns the readable ones instead of failing the batch over a single item
    // the PAT can't see — and it reports those as nulls, hence the `Option` in the envelope.
    let url = format!(
        "https://dev.azure.com/{org_enc}/_apis/wit/workitems\
         ?ids={list}&fields=System.Title,System.State,System.WorkItemType\
         &errorPolicy=omit&api-version={API_VERSION}"
    );
    let raw: ListResponse<Option<RawWorkItem>> = get_json(&url, pat).await?;
    Ok(raw
        .value
        .into_iter()
        .flatten()
        .map(|item| AdoWorkItemChild {
            url: format!("https://dev.azure.com/{org_enc}/_workitems/edit/{}", item.id),
            id: item.id,
            work_item_type: field_str(&item.fields, "System.WorkItemType"),
            title: field_str(&item.fields, "System.Title"),
            state: field_str(&item.fields, "System.State"),
        })
        .collect())
}

/// What a pasted work-item reference resolves to.
///
/// `org` and `project` are `None` for a bare id — the caller fills those in from the organisation
/// the workspace is already pointed at, which is the common case for someone reading a number off
/// a board they have open.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkItemRef {
    pub org: Option<String>,
    pub project: Option<String>,
    pub id: i64,
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
        return (id > 0).then_some(WorkItemRef { org: None, project: None, id });
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

    Some(WorkItemRef { org, project, id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_work_item_out_of_an_edit_url() {
        assert_eq!(
            parse_work_item_ref("https://dev.azure.com/fabrikam/Web%20Store/_workitems/edit/4821"),
            Some(WorkItemRef {
                org: Some("fabrikam".to_string()),
                project: Some("Web Store".to_string()),
                id: 4821,
            })
        );
    }

    /// The older host puts the organisation in the subdomain, which moves every path segment along
    /// one — read positionally, the project would come back as the organisation.
    #[test]
    fn the_visualstudio_host_keeps_its_org_in_the_subdomain() {
        assert_eq!(
            parse_work_item_ref("https://fabrikam.visualstudio.com/Checkout/_workitems/edit/12"),
            Some(WorkItemRef {
                org: Some("fabrikam".to_string()),
                project: Some("Checkout".to_string()),
                id: 12,
            })
        );
    }

    /// A URL with no project in it must not promote `_workitems` into the project slot.
    #[test]
    fn an_org_level_url_reports_no_project() {
        assert_eq!(
            parse_work_item_ref("https://dev.azure.com/fabrikam/_workitems/edit/7"),
            Some(WorkItemRef { org: Some("fabrikam".to_string()), project: None, id: 7 })
        );
    }

    /// Dragging a card open on a board never leaves `_workitems` in the path — the id is in the
    /// query string, and that is the URL sitting in the address bar when someone copies it.
    #[test]
    fn a_board_url_names_its_open_card_in_the_query() {
        assert_eq!(
            parse_work_item_ref("https://dev.azure.com/fabrikam/Checkout/_boards/board/t/Team/Stories/?workitem=903"),
            Some(WorkItemRef {
                org: Some("fabrikam".to_string()),
                project: Some("Checkout".to_string()),
                id: 903,
            })
        );
    }

    #[test]
    fn a_bare_id_carries_no_org_of_its_own() {
        assert_eq!(
            parse_work_item_ref("  #4821 "),
            Some(WorkItemRef { org: None, project: None, id: 4821 })
        );
        assert_eq!(
            parse_work_item_ref("4821"),
            Some(WorkItemRef { org: None, project: None, id: 4821 })
        );
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
            sub_pages: vec![RawWikiPage {
                path: Some("/Producto".to_string()),
                content: None,
                sub_pages: vec![RawWikiPage {
                    path: Some("/Producto/Checkout-web".to_string()),
                    content: None,
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
