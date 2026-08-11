//! Jira **issues** (read + write), normalised to the shapes in [`super`].
//!
//! Speaks REST **v2**, not v3, and that is the load-bearing decision in this file. Jira Cloud's v3
//! takes prose as ADF — a JSON document tree — so every description, every acceptance criterion and
//! every task the app writes would have to be built as a node graph, and every one it reads flattened
//! back. v2 takes and returns those same fields as strings, is still served by Jira Cloud, and is
//! what Jira Server/Data Center speaks as well. One client therefore covers all three hosts, and the
//! text the user typed is the text that arrives.
//!
//! **What Jira does not have**, and how each gap is answered rather than hidden:
//!
//! - *No acceptance-criteria field.* Appended to the description under a heading, exactly as the
//!   Azure client does for a Basic-process Issue that has no such field either.
//! - *No repro-steps field.* Same treatment.
//! - *No area or iteration path.* Ignored; the target panel doesn't offer them for a Jira target.
//! - *Story points and priority live wherever the site put them.* Both are discovered from the host
//!   and remembered per site — see [`story_points_field`] and [`priority_ladder`] — and both are
//!   best-effort: an issue is worth creating without its estimate, never worth failing over one.
//!
//! Nothing here deletes. Issues are created, read and updated.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

use super::{
    criteria_to_html, html_to_text, text_to_html, BoardAuth, BoardProvider, ItemRef, NewWorkItem,
    WorkItem, WorkItemChild, WorkItemEdit, WorkItemRef, WorkItemType,
};

/// How many children of one issue are worth reading. The review screen lists them to avoid proposing
/// a task that already exists; past a point that list stops being something a person reads.
const MAX_CHILDREN: usize = 50;

/// The heading the criteria are filed under inside a description, and the marker used to find them
/// again when the issue is read back. Deliberately the same string in both directions: a round trip
/// through this client has to return what it wrote, or the review screen shows the criteria twice.
const CRITERIA_HEADING: &str = "Criterios de aceptación";

// ---------- talking to the host ----------

/// Accepts whatever the user saved as their "site" — `acme`, `acme.atlassian.net`, or a full
/// `https://acme.atlassian.net/anything` URL — and reduces it to the origin every request hangs off.
///
/// A bare word is expanded to `.atlassian.net` because that is what a Cloud user means by their site
/// name; anything already carrying a dot is taken as a hostname, which is what makes Server and Data
/// Center installs on a private domain work without a second setting.
pub fn normalize_site(site: &str) -> String {
    let trimmed = site.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = without_scheme.split('/').next().unwrap_or(without_scheme);
    if host.contains('.') {
        format!("https://{host}")
    } else {
        format!("https://{host}.atlassian.net")
    }
}

/// One client for the process, cloned per call — see `crate::github::client` for why building a
/// rustls client per request cost a full TLS handshake and an unshared connection pool every time.
/// Nothing here varies the transport per call, so the pool is pure gain.
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

/// Percent-encodes one path segment. Issue keys are safe by construction, but project keys reach
/// this from a text field and a stray space would otherwise split the path.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Turns a failed response into the message the user sees.
///
/// Jira reports what was wrong in `errorMessages` and `errors`, and those are the only part worth
/// showing — the raw body is a wall of JSON that says "400" in eleven different ways. The status is
/// kept in front so an authentication problem still reads as one when the body is empty.
async fn fail(status: reqwest::StatusCode, body: String) -> String {
    #[derive(Deserialize, Default)]
    struct JiraErrors {
        #[serde(rename = "errorMessages", default)]
        messages: Vec<String>,
        #[serde(default)]
        errors: HashMap<String, String>,
    }
    let parsed: JiraErrors = serde_json::from_str(&body).unwrap_or_default();
    let mut detail: Vec<String> = parsed.messages;
    detail.extend(parsed.errors.into_iter().map(|(field, message)| format!("{field}: {message}")));
    if detail.is_empty() {
        return format!("Jira devolvió {status}: {}", body.trim());
    }
    format!("Jira devolvió {status}: {}", detail.join("; "))
}

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str, auth: &BoardAuth) -> Result<T, String> {
    let res = client()
        .get(url)
        .header("Authorization", auth.header())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("no se pudo conectar con Jira: {e}"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(fail(status, body).await);
    }
    serde_json::from_str(&body).map_err(|e| format!("respuesta inesperada de Jira: {e}"))
}

async fn send_json(
    method: reqwest::Method,
    url: &str,
    payload: &serde_json::Value,
    auth: &BoardAuth,
) -> Result<String, String> {
    let res = client()
        .request(method, url)
        .header("Authorization", auth.header())
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(payload).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("no se pudo conectar con Jira: {e}"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(fail(status, body).await);
    }
    Ok(body)
}

// ---------- what this site calls things ----------

/// Per-site answers to "which field is that, here?", remembered for the life of the process.
///
/// Both lookups are a whole extra round trip and neither answer changes while the app is open, so
/// asking once per site is the difference between one call and one call *per story* on a publish of
/// twenty. A wrong answer cached would be a real cost — hence only successful lookups are stored;
/// a failed probe is retried next time rather than remembered as "this site has no estimate field".
fn site_memo() -> &'static Mutex<HashMap<String, String>> {
    static MEMO: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn memo_get(key: &str) -> Option<String> {
    site_memo().lock().ok()?.get(key).cloned()
}

fn memo_put(key: &str, value: String) {
    if let Ok(mut memo) = site_memo().lock() {
        memo.insert(key.to_string(), value);
    }
}

#[derive(Deserialize)]
struct RawField {
    id: String,
    #[serde(default)]
    name: String,
}

/// The custom field this site keeps story points in, if it has one.
///
/// There is no fixed id for it: `customfield_10016` is common on Jira Cloud and wrong often enough
/// that hard-coding it would silently drop the estimate on every other site. Both spellings Atlassian
/// has shipped are accepted — team-managed projects call it "Story point estimate", company-managed
/// ones "Story Points".
async fn story_points_field(site: &str, auth: &BoardAuth) -> Option<String> {
    let cache_key = format!("{site}|points");
    if let Some(hit) = memo_get(&cache_key) {
        return (!hit.is_empty()).then_some(hit);
    }
    let fields: Vec<RawField> = get_json(&format!("{site}/rest/api/2/field"), auth).await.ok()?;
    let found = fields.into_iter().find(|field| {
        let name = field.name.trim().to_ascii_lowercase();
        name == "story points" || name == "story point estimate"
    })?;
    memo_put(&cache_key, found.id.clone());
    Some(found.id)
}

#[derive(Deserialize)]
struct RawPriority {
    id: String,
}

/// This site's priorities, most urgent first, as the ids a create call takes.
///
/// Azure's 1-4 scale is mapped onto them **by position**, not by name: an instance is free to rename
/// or replace the whole ladder, and a scheme with three levels should still turn a priority-1 story
/// into its most urgent one rather than into nothing. Cached as a comma-joined list because the memo
/// holds strings and a second map for one lookup is not worth its own lock.
async fn priority_ladder(site: &str, auth: &BoardAuth) -> Vec<String> {
    let cache_key = format!("{site}|priorities");
    if let Some(hit) = memo_get(&cache_key) {
        return hit.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect();
    }
    let Ok(priorities) = get_json::<Vec<RawPriority>>(&format!("{site}/rest/api/2/priority"), auth).await
    else {
        return Vec::new();
    };
    let ids: Vec<String> = priorities.into_iter().map(|p| p.id).collect();
    if !ids.is_empty() {
        memo_put(&cache_key, ids.join(","));
    }
    ids
}

/// Azure's 1 (critical) … 4 (low) onto whatever ladder this site has.
///
/// Clamped rather than scaled: a 4 on a three-level scheme is its lowest, not two thirds of the way
/// down it. `None` when the site reported no priorities at all, which is a site that does not want
/// the field set.
fn priority_id(ladder: &[String], priority: i64) -> Option<String> {
    if ladder.is_empty() || priority <= 0 {
        return None;
    }
    let index = ((priority - 1) as usize).min(ladder.len() - 1);
    ladder.get(index).cloned()
}

// ---------- projects ----------

/// One project on this site, as the target picker lists it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct JiraProject {
    /// The key a create call sends (`WEB`), which is also what people call the project.
    pub key: String,
    pub name: String,
}

#[derive(Deserialize)]
struct RawProjectSearch {
    #[serde(default)]
    values: Vec<RawProjectSummary>,
}

#[derive(Deserialize)]
struct RawProjectSummary {
    #[serde(default)]
    key: String,
    #[serde(default)]
    name: String,
}

/// The projects this account can see.
///
/// Tries the paged endpoint first and falls back to the flat one. Jira Cloud deprecated the flat
/// `/project` in favour of `/project/search`, and Jira Server never shipped `/project/search` at
/// all — so a single call is wrong on one host or the other, and which host this is is exactly what
/// the app does not want to make the user declare.
pub async fn list_projects(site: &str, auth: &BoardAuth) -> Result<Vec<JiraProject>, String> {
    let site = normalize_site(site);
    if site.is_empty() {
        return Err("Falta el sitio de Jira".to_string());
    }
    let paged: Result<RawProjectSearch, String> = get_json(
        &format!("{site}/rest/api/2/project/search?maxResults=200&orderBy=name"),
        auth,
    )
    .await;
    let summaries = match paged {
        Ok(found) => found.values,
        Err(_) => get_json::<Vec<RawProjectSummary>>(&format!("{site}/rest/api/2/project"), auth).await?,
    };
    Ok(summaries
        .into_iter()
        .filter(|p| !p.key.trim().is_empty())
        .map(|p| JiraProject { key: p.key, name: p.name })
        .collect())
}

// ---------- issue types ----------

#[derive(Deserialize)]
struct RawProject {
    #[serde(rename = "issueTypes", default)]
    issue_types: Vec<RawIssueType>,
}

#[derive(Deserialize)]
struct RawIssueType {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    subtask: bool,
}

/// The issue types this project actually offers.
///
/// Read from the project rather than from the site: which types exist is a property of the issue
/// type scheme attached to the project, and a site-wide list would offer types that the create call
/// then rejects. Sub-task types are returned too, flagged — the publish picker hides them (a sub-task
/// cannot be created without a parent) while the task step needs exactly those.
pub async fn list_issue_types(
    site: &str,
    project: &str,
    auth: &BoardAuth,
) -> Result<Vec<WorkItemType>, String> {
    let site = normalize_site(site);
    if site.is_empty() {
        return Err("Falta el sitio de Jira".to_string());
    }
    let url = format!("{site}/rest/api/2/project/{}", encode_segment(project));
    let project: RawProject = get_json(&url, auth).await?;
    Ok(project
        .issue_types
        .into_iter()
        .map(|t| WorkItemType {
            name: t.name,
            // The id, not the name: two schemes on one site can both define "Task", and the create
            // call resolves a name against the wrong one without ever saying so.
            reference_name: t.id,
            description: t.description,
            color: String::new(),
            subtask: t.subtask,
        })
        .collect())
}

// ---------- creating ----------

#[derive(Deserialize)]
struct RawCreated {
    /// Jira reports ids as strings even though they are numbers.
    #[serde(default)]
    id: String,
    #[serde(default)]
    key: String,
}

fn numeric_id(raw: &str) -> i64 {
    raw.trim().parse().unwrap_or(0)
}

/// The page a person opens for an issue.
fn browse_url(site: &str, key: &str) -> String {
    format!("{site}/browse/{key}")
}

/// Jira stores labels as an array with no spaces allowed in a value; the app carries them as one
/// string separated by `;` or `,`. Spaces inside a label become hyphens rather than being dropped —
/// a label the user wrote is a label they meant.
fn labels_of(tags: &str) -> Vec<String> {
    tags.split([';', ','])
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(|tag| tag.replace(char::is_whitespace, "-"))
        .collect()
}

/// The description as Jira stores it: the narrative, the prose, then the criteria under a heading.
///
/// One field for all three because Jira has nowhere else to put them. The heading is what makes the
/// round trip work — [`split_criteria`] finds it again when the issue is read back, so a review of an
/// issue this app published sees its criteria as criteria rather than as a wall of description.
fn compose_description(narrative: &str, description: &str, criteria: &[String]) -> String {
    let mut out = String::new();
    if !narrative.trim().is_empty() {
        out.push_str(narrative.trim());
        out.push_str("\n\n");
    }
    if !description.trim().is_empty() {
        out.push_str(description.trim());
        out.push_str("\n\n");
    }
    let listed: Vec<&str> = criteria.iter().map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
    if !listed.is_empty() {
        out.push_str(&format!("h3. {CRITERIA_HEADING}\n\n"));
        for criterion in listed {
            out.push_str(criterion);
            out.push_str("\n\n");
        }
    }
    out.trim_end().to_string()
}

/// The inverse of [`compose_description`]: prose, then whatever was filed under the criteria heading.
///
/// Split on the heading and nothing else. A description that never went through this app has no such
/// heading and comes back whole as prose, which is the honest answer — guessing that a bulleted list
/// halfway down is "really" the acceptance criteria would be wrong often enough to matter on the one
/// screen whose job is to tell the user what their story is missing.
fn split_criteria(description: &str) -> (String, Vec<String>) {
    let marker = format!("h3. {CRITERIA_HEADING}");
    let Some(at) = description.find(&marker) else {
        return (description.trim().to_string(), Vec::new());
    };
    let prose = description[..at].trim().to_string();
    let rest = description[at + marker.len()..].trim();
    let criteria: Vec<String> = rest
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .map(str::to_string)
        .collect();
    (prose, criteria)
}

/// Creates one issue.
pub async fn create_issue(
    site: &str,
    project: &str,
    issue_type: &str,
    item: &NewWorkItem<'_>,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    if item.title.trim().is_empty() {
        return Err("La historia no tiene título".to_string());
    }
    let site = normalize_site(site);
    if site.is_empty() {
        return Err("Falta el sitio de Jira".to_string());
    }

    let mut fields = serde_json::Map::new();
    fields.insert("project".into(), serde_json::json!({ "key": project.trim() }));
    fields.insert("summary".into(), serde_json::json!(item.title.trim()));
    fields.insert("issuetype".into(), issue_type_ref(issue_type));

    let description = compose_description(item.narrative, item.description, item.acceptance_criteria);
    if !description.is_empty() {
        fields.insert("description".into(), serde_json::json!(description));
    }
    let labels = labels_of(item.tags);
    if !labels.is_empty() {
        fields.insert("labels".into(), serde_json::json!(labels));
    }
    if item.story_points > 0.0 {
        if let Some(field) = story_points_field(&site, auth).await {
            fields.insert(field, serde_json::json!(item.story_points));
        }
    }
    if item.priority > 0 {
        if let Some(id) = priority_id(&priority_ladder(&site, auth).await, item.priority) {
            fields.insert("priority".into(), serde_json::json!({ "id": id }));
        }
    }

    let payload = serde_json::json!({ "fields": fields });
    let body = send_json(
        reqwest::Method::POST,
        &format!("{site}/rest/api/2/issue"),
        &payload,
        auth,
    )
    .await?;
    let created: RawCreated =
        serde_json::from_str(&body).map_err(|e| format!("respuesta inesperada de Jira: {e}"))?;
    Ok(ItemRef {
        id: numeric_id(&created.id),
        url: browse_url(&site, &created.key),
        key: created.key,
    })
}

/// An issue type by id when it looks like one, by name otherwise.
///
/// [`list_issue_types`] hands back ids, so the picker's value is an id and this takes the first
/// branch. The name branch is for a type that arrived some other way — a saved target from before
/// the picker, or a value typed by hand — and is worth keeping because failing it would be failing a
/// publish over a spelling Jira itself would have accepted.
fn issue_type_ref(issue_type: &str) -> serde_json::Value {
    let value = issue_type.trim();
    if !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) {
        serde_json::json!({ "id": value })
    } else {
        serde_json::json!({ "name": value })
    }
}

/// The id of this project's sub-task type, if it has one.
///
/// Remembered per project for the same reason the estimate field is: a publish of twelve tasks would
/// otherwise ask twelve times for an answer that cannot change while the app is open. `None` when the
/// project defines no sub-task type at all, which is a real configuration — the caller then falls
/// back to whatever name it was given and lets Jira be the one to refuse it.
async fn subtask_type_id(site: &str, project: &str, auth: &BoardAuth) -> Option<String> {
    let cache_key = format!("{site}|{project}|subtask");
    if let Some(hit) = memo_get(&cache_key) {
        return (!hit.is_empty()).then_some(hit);
    }
    let types = list_issue_types(site, project, auth).await.ok()?;
    let found = types.into_iter().find(|t| t.subtask)?;
    memo_put(&cache_key, found.reference_name.clone());
    Some(found.reference_name)
}

/// Creates one issue as the child of an existing one.
///
/// The parent link is set in the same create rather than added afterwards, for the reason it is on
/// Azure too: an item that exists for a moment with no parent is one somebody's board query picks up
/// as orphaned, and a failure between two calls would leave exactly that behind for good.
pub async fn create_subtask(
    site: &str,
    project: &str,
    parent_key: &str,
    issue_type: &str,
    title: &str,
    description: &str,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    if title.trim().is_empty() {
        return Err("Esa tarea no tiene título".to_string());
    }
    if parent_key.trim().is_empty() {
        return Err("No se sabe bajo qué incidencia colgar la tarea".to_string());
    }
    let site = normalize_site(site);

    // "Sub-task" is what the caller asks for and what a stock English site calls it; a Spanish one
    // calls it "Subtarea" and a customised scheme calls it whatever it likes. Resolving against the
    // project's own types is the difference between this working on any site and working on one.
    let resolved_type = match issue_type.trim().chars().all(|c| c.is_ascii_digit()) {
        true => issue_type.trim().to_string(),
        false => subtask_type_id(&site, project, auth)
            .await
            .unwrap_or_else(|| issue_type.trim().to_string()),
    };

    let mut fields = serde_json::Map::new();
    fields.insert("project".into(), serde_json::json!({ "key": project.trim() }));
    fields.insert("parent".into(), serde_json::json!({ "key": parent_key.trim() }));
    fields.insert("summary".into(), serde_json::json!(title.trim()));
    fields.insert("issuetype".into(), issue_type_ref(&resolved_type));
    if !description.trim().is_empty() {
        fields.insert("description".into(), serde_json::json!(description.trim()));
    }

    let payload = serde_json::json!({ "fields": fields });
    let body = send_json(
        reqwest::Method::POST,
        &format!("{site}/rest/api/2/issue"),
        &payload,
        auth,
    )
    .await?;
    let created: RawCreated =
        serde_json::from_str(&body).map_err(|e| format!("respuesta inesperada de Jira: {e}"))?;
    Ok(ItemRef {
        id: numeric_id(&created.id),
        url: browse_url(&site, &created.key),
        key: created.key,
    })
}

// ---------- updating ----------

/// Applies an edit to an issue that already exists.
///
/// The description is rebuilt whole, criteria included, because on Jira they live *inside* it: there
/// is no separate field to patch, so writing the criteria means writing the description. That makes
/// one behaviour of the review screen sharper here than on Azure — sending criteria without also
/// sending the prose would drop the prose — so this reads the issue first and keeps whichever half
/// the edit did not mention.
pub async fn update_issue(
    site: &str,
    key: &str,
    edit: &WorkItemEdit,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    if key.trim().is_empty() {
        return Err("Esa referencia de incidencia no es válida".to_string());
    }
    let site = normalize_site(site);
    let key = key.trim();

    let mut fields = serde_json::Map::new();
    if let Some(title) = &edit.title {
        if title.trim().is_empty() {
            return Err("La incidencia no puede quedarse sin título".to_string());
        }
        fields.insert("summary".into(), serde_json::json!(title.trim()));
    }

    // Jira stores prose as text. The review screen hands it over as HTML when it has rendered
    // Markdown itself, so that flag has to be undone here rather than written through.
    let plain = |text: &String| match edit.prose_is_html {
        true => html_to_text(text),
        false => text.clone(),
    };

    let touches_prose = edit.description.is_some() || edit.repro_steps.is_some();
    if touches_prose || edit.acceptance_criteria.is_some() {
        // Only fetched when the composed description would otherwise lose the half not being sent.
        let existing = match touches_prose && edit.acceptance_criteria.is_some() {
            true => None,
            false => Some(read_raw_description(&site, key, auth).await?),
        };
        let (existing_prose, existing_criteria) = existing
            .as_deref()
            .map(split_criteria)
            .unwrap_or_else(|| (String::new(), Vec::new()));

        let mut prose = match &edit.description {
            Some(description) => plain(description),
            None => existing_prose,
        };
        if let Some(steps) = &edit.repro_steps {
            let steps = plain(steps);
            if !steps.trim().is_empty() {
                // No repro-steps field here, so they follow the description under their own heading
                // instead of overwriting it.
                prose.push_str(&format!("\n\nh3. Pasos para reproducir\n\n{}", steps.trim()));
            }
        }
        let criteria = match &edit.acceptance_criteria {
            Some(criteria) => criteria.clone(),
            None => existing_criteria,
        };
        fields.insert(
            "description".into(),
            serde_json::json!(compose_description("", &prose, &criteria)),
        );
    }

    if fields.is_empty() {
        return Err("No hay nada que publicar".to_string());
    }

    let payload = serde_json::json!({ "fields": fields });
    send_json(
        reqwest::Method::PUT,
        &format!("{site}/rest/api/2/issue/{}", encode_segment(key)),
        &payload,
        auth,
    )
    .await?;

    Ok(ItemRef { id: 0, url: browse_url(&site, key), key: key.to_string() })
}

async fn read_raw_description(site: &str, key: &str, auth: &BoardAuth) -> Result<String, String> {
    let url = format!("{site}/rest/api/2/issue/{}?fields=description", encode_segment(key));
    let issue: RawIssue = get_json(&url, auth).await?;
    Ok(issue.fields.description.unwrap_or_default())
}

// ---------- reading ----------

#[derive(Deserialize)]
struct RawIssue {
    #[serde(default)]
    id: String,
    #[serde(default)]
    key: String,
    #[serde(default)]
    fields: RawIssueFields,
}

#[derive(Deserialize, Default)]
struct RawIssueFields {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<RawNamed>,
    #[serde(default)]
    issuetype: Option<RawNamed>,
    #[serde(default)]
    project: Option<RawNamedProject>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    assignee: Option<RawPerson>,
    /// Everything else the issue carries, so the estimate can be read out of whichever custom field
    /// this site keeps it in without a struct field per site.
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct RawNamed {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawNamedProject {
    #[serde(default)]
    key: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawPerson {
    #[serde(rename = "displayName", default)]
    display_name: String,
}

#[derive(Deserialize)]
struct RawSearch {
    #[serde(default)]
    issues: Vec<RawIssue>,
}

/// Reads one issue and the children it already has.
pub async fn get_issue(site: &str, key: &str, auth: &BoardAuth) -> Result<WorkItem, String> {
    if key.trim().is_empty() {
        return Err("Esa referencia de incidencia no es válida".to_string());
    }
    let site = normalize_site(site);
    let key = key.trim();

    let url = format!("{site}/rest/api/2/issue/{}", encode_segment(key));
    let raw: RawIssue = get_json(&url, auth).await?;

    let description = raw.fields.description.clone().unwrap_or_default();
    let (prose, criteria) = split_criteria(&description);

    let effort_field = story_points_field(&site, auth).await.unwrap_or_default();
    let effort = raw
        .fields
        .extra
        .get(&effort_field)
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);

    let children = children_of(&site, key, auth).await.unwrap_or_default();

    Ok(WorkItem {
        id: numeric_id(&raw.id),
        url: browse_url(&site, &raw.key),
        key: raw.key.clone(),
        work_item_type: raw.fields.issuetype.map(|t| t.name).unwrap_or_default(),
        title: raw.fields.summary,
        state: raw.fields.status.map(|s| s.name).unwrap_or_default(),
        team_project: raw
            .fields
            .project
            .as_ref()
            .map(|p| match p.name.is_empty() {
                true => p.key.clone(),
                false => p.name.clone(),
            })
            .unwrap_or_default(),
        // The key, not the name: a create call inside this project addresses it by key.
        container_id: raw.fields.project.as_ref().map(|p| p.key.clone()).unwrap_or_default(),
        description_html: text_to_html(&prose),
        // Jira has neither field. Empty rather than absent, so the review screen's own "this board
        // doesn't have that" handling is the single place that decides what to show.
        repro_steps_html: String::new(),
        system_info_html: String::new(),
        acceptance_criteria_html: criteria_to_html(&criteria),
        effort,
        // Named after what a person calls it, not after `customfield_10016`.
        effort_field: match effort > 0.0 {
            true => "Story Points".to_string(),
            false => String::new(),
        },
        tags: raw.fields.labels.join("; "),
        area_path: String::new(),
        iteration_path: String::new(),
        children,
    })
}

/// The issue's children, by query rather than from its `subtasks` array.
///
/// The array names them but carries no description and no assignee, and the review screen shows
/// both. One search returns the lot with every field already filled in, and it also picks up the
/// children of a company-managed project, which are ordinary issues linked by parent rather than
/// sub-tasks and never appear in that array at all.
async fn children_of(site: &str, key: &str, auth: &BoardAuth) -> Result<Vec<WorkItemChild>, String> {
    let jql = format!("parent={key}");
    let url = format!(
        "{site}/rest/api/2/search?jql={}&maxResults={MAX_CHILDREN}\
         &fields=summary,status,issuetype,description,assignee",
        encode_segment(&jql)
    );
    let found: RawSearch = get_json(&url, auth).await?;
    Ok(found
        .issues
        .into_iter()
        .map(|issue| WorkItemChild {
            url: browse_url(site, &issue.key),
            id: numeric_id(&issue.id),
            key: issue.key,
            work_item_type: issue.fields.issuetype.map(|t| t.name).unwrap_or_default(),
            title: issue.fields.summary,
            state: issue.fields.status.map(|s| s.name).unwrap_or_default(),
            description_html: text_to_html(&issue.fields.description.unwrap_or_default()),
            assigned_to: issue.fields.assignee.map(|a| a.display_name).unwrap_or_default(),
        })
        .collect())
}

// ---------- what the user pasted ----------

/// Whether a word is shaped like an issue key: `PROJ-123`.
///
/// The project part is letters, digits and underscores starting with a letter, which is what Jira
/// enforces on a project key. Checked rather than assumed because this decides which board a pasted
/// reference goes to, and a false positive would send an Azure reference to a Jira client.
fn looks_like_key(value: &str) -> bool {
    let Some((project, number)) = value.rsplit_once('-') else { return false };
    if project.is_empty() || number.is_empty() {
        return false;
    }
    let mut chars = project.chars();
    let starts_ok = chars.next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false);
    starts_ok
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && number.chars().all(|c| c.is_ascii_digit())
}

/// Reads an issue out of whatever the user pasted: a browse URL, the modern
/// `.../jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-12` form, or the bare key.
///
/// Returns `None` for anything that isn't recognisably Jira — including a bare number, which is what
/// an Azure work item looks like and what this app meant by it before Jira existed here.
pub fn parse_issue_ref(input: &str) -> Option<WorkItemRef> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }

    // A bare key, with or without the `#` people put in front of it in chat.
    let bare = text.strip_prefix('#').unwrap_or(text).trim();
    if looks_like_key(&bare.to_ascii_uppercase()) && !bare.contains('/') {
        let key = bare.to_ascii_uppercase();
        return Some(WorkItemRef {
            org: None,
            project: key.rsplit_once('-').map(|(project, _)| project.to_string()),
            id: 0,
            key,
            provider: BoardProvider::Jira,
        });
    }

    let without_scheme = text.split_once("://").map_or(text, |(_, rest)| rest);
    let (path, query) = without_scheme.split_once('?').unwrap_or((without_scheme, ""));
    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty()).collect();
    let host = *segments.first()?;
    if !host.contains('.') {
        return None;
    }

    // `/browse/PROJ-12` is the canonical link; a board or backlog URL names the open card in its
    // query string instead, which is the URL actually sitting in the address bar when someone copies
    // it off a sprint board.
    let from_path = segments
        .iter()
        .position(|segment| segment.eq_ignore_ascii_case("browse"))
        .and_then(|at| segments.get(at + 1))
        .map(|key| key.to_ascii_uppercase())
        .filter(|key| looks_like_key(key));
    let key = from_path.or_else(|| {
        query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(name, _)| {
                name.eq_ignore_ascii_case("selectedIssue") || name.eq_ignore_ascii_case("issueKey")
            })
            .map(|(_, value)| value.to_ascii_uppercase())
            .filter(|key| looks_like_key(key))
    })?;

    Some(WorkItemRef {
        org: Some(format!("https://{host}")),
        project: key.rsplit_once('-').map(|(project, _)| project.to_string()),
        id: 0,
        key,
        provider: BoardProvider::Jira,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_is_reduced_to_the_origin_every_request_hangs_off() {
        assert_eq!(normalize_site("acme"), "https://acme.atlassian.net");
        assert_eq!(normalize_site("acme.atlassian.net"), "https://acme.atlassian.net");
        assert_eq!(normalize_site("https://acme.atlassian.net/"), "https://acme.atlassian.net");
        assert_eq!(normalize_site("https://acme.atlassian.net/jira/software"), "https://acme.atlassian.net");
        // A private host is taken as written — that is what makes Server and Data Center work.
        assert_eq!(normalize_site("https://jira.interno.local"), "https://jira.interno.local");
        assert_eq!(normalize_site("  "), "");
    }

    #[test]
    fn the_criteria_survive_the_round_trip_through_one_description_field() {
        let criteria = vec![
            "Escenario: alta\nDado un cliente\nCuando confirma\nEntonces se registra".to_string(),
            "Escenario: baja\nDado un cliente\nCuando cancela\nEntonces se cierra".to_string(),
        ];
        let composed = compose_description("Como cliente, quiero X, para Y", "Contexto.", &criteria);
        let (prose, back) = split_criteria(&composed);
        assert!(prose.starts_with("Como cliente"));
        assert!(prose.contains("Contexto."));
        assert_eq!(back, criteria);
    }

    /// A description this app never wrote has no heading, and guessing where its criteria "really"
    /// are would be wrong on exactly the screen that exists to report what a story is missing.
    #[test]
    fn a_description_written_elsewhere_is_all_prose() {
        let (prose, criteria) = split_criteria("Solo texto.\n\nY más texto.");
        assert_eq!(prose, "Solo texto.\n\nY más texto.");
        assert!(criteria.is_empty());
    }

    #[test]
    fn a_label_keeps_the_words_the_user_wrote() {
        assert_eq!(labels_of("checkout; pagos en linea,  "), vec!["checkout", "pagos-en-linea"]);
        assert!(labels_of("  ").is_empty());
    }

    #[test]
    fn only_what_is_shaped_like_an_issue_key_is_one() {
        assert!(looks_like_key("PROJ-123"));
        assert!(looks_like_key("A1_B-7"));
        assert!(!looks_like_key("123"));
        assert!(!looks_like_key("1PROJ-123"));
        assert!(!looks_like_key("PROJ-"));
        assert!(!looks_like_key("PROJ-12a"));
    }

    #[test]
    fn reads_an_issue_out_of_the_links_people_actually_paste() {
        let browse = parse_issue_ref("https://acme.atlassian.net/browse/WEB-42").unwrap();
        assert_eq!(browse.key, "WEB-42");
        assert_eq!(browse.org.as_deref(), Some("https://acme.atlassian.net"));
        assert_eq!(browse.project.as_deref(), Some("WEB"));

        let board = parse_issue_ref(
            "https://acme.atlassian.net/jira/software/projects/WEB/boards/1?selectedIssue=WEB-9",
        )
        .unwrap();
        assert_eq!(board.key, "WEB-9");

        let bare = parse_issue_ref("web-42").unwrap();
        assert_eq!(bare.key, "WEB-42");
        assert_eq!(bare.org, None);
    }

    /// A bare number is an Azure work item, and always was. Claiming it here would silently move
    /// every existing reference onto the wrong client.
    #[test]
    fn a_bare_number_is_not_a_jira_reference() {
        assert_eq!(parse_issue_ref("4821"), None);
        assert_eq!(parse_issue_ref("#4821"), None);
        assert_eq!(parse_issue_ref("https://dev.azure.com/fabrikam/Web/_workitems/edit/4821"), None);
        assert_eq!(parse_issue_ref(""), None);
    }

    #[test]
    fn the_priority_ladder_is_mapped_by_position_and_clamped() {
        let ladder = vec!["1".to_string(), "2".to_string(), "3".to_string()];
        assert_eq!(priority_id(&ladder, 1).as_deref(), Some("1"));
        assert_eq!(priority_id(&ladder, 3).as_deref(), Some("3"));
        // A 4 on a three-level scheme is its lowest, not nothing.
        assert_eq!(priority_id(&ladder, 4).as_deref(), Some("3"));
        assert_eq!(priority_id(&ladder, 0), None);
        assert_eq!(priority_id(&[], 2), None);
    }

    #[test]
    fn an_issue_type_travels_as_an_id_when_it_is_one() {
        assert_eq!(issue_type_ref("10001"), serde_json::json!({ "id": "10001" }));
        assert_eq!(issue_type_ref("Story"), serde_json::json!({ "name": "Story" }));
    }
}
