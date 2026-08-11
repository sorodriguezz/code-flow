//! monday.com **items** (read + write), normalised to the shapes in [`super`].
//!
//! The odd one out of the three, in three ways that shaped everything here.
//!
//! **It is GraphQL.** One endpoint, one POST, a query string in the body — so none of the REST
//! plumbing the other two share applies, and this module carries its own. The version is pinned
//! rather than left to default: monday ships a new API version every quarter and promotes it to
//! "current", so a client that sends no version is a client that silently changes behaviour on
//! somebody else's schedule.
//!
//! **It has no schema.** This is the real difference, and it is not a detail. Azure has
//! `System.Description`; Jira has `description`; monday has *whatever columns this board happens to
//! have*, with ids that are per-board (`long_text_mkq1a2`). There is no description field, no
//! estimate field and no acceptance-criteria field to write to — only columns somebody created. So
//! the board's own columns are read and matched **by type** (see [`BoardSchema`]), and what was
//! detected is reported to the screen rather than applied silently: a mapping the user cannot see is
//! a mapping they cannot correct.
//!
//! **It has no work item types.** Its hierarchy is account → board → group → item, so the three
//! target slots hold the account, the **board** and the **group**. A group is what "where does this
//! land" means here, and it is required for the same reason a work item type is on Azure: without
//! it the host picks, and the user finds out afterwards.
//!
//! What is deliberately **not** written: tags and priority. A monday tags column addresses labels by
//! id rather than by name, and priority is a status column whose labels are per-board — so both
//! would mean guessing at values, and a guess that lands is worse than a field left alone, because
//! nobody goes back to check a field that looks filled in.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

use super::{
    criteria_to_html, html_to_text, text_to_html, BoardAuth, BoardProvider, ItemRef, NewWorkItem,
    WorkItem, WorkItemChild, WorkItemEdit, WorkItemRef, WorkItemType,
};

const ENDPOINT: &str = "https://api.monday.com/v2";

/// The API version this client is written against.
///
/// Pinned on purpose. monday promotes a new version to "current" every quarter and an unversioned
/// call follows it, which means the alternative to pinning is a client whose behaviour changes on a
/// date nobody here chose. Raising it is a deliberate edit with the changelog read.
const API_VERSION: &str = "2026-07";

/// How many children of one item are worth reading, and how many boards the picker lists.
const MAX_CHILDREN: usize = 50;
const MAX_BOARDS: usize = 200;

/// The heading acceptance criteria are filed under inside the description column, and the marker
/// used to find them again. The same trick the Jira client uses, and for the same reason: with no
/// field of their own, the only thing that makes a round trip work is writing a boundary the reader
/// can look for.
const CRITERIA_HEADING: &str = "Criterios de aceptación";

// ---------- talking to the host ----------

/// One client for the process, cloned per call — see `crate::github::client` for why building a
/// rustls client per request cost a full TLS handshake and an unshared connection pool every time.
/// Nothing here varies the transport per call, so the pool is pure gain.
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

#[derive(Deserialize)]
struct GraphQlResponse<T> {
    // No `serde(default)` on this one: the attribute would demand `T: Default` of every payload
    // type, and an `Option` is already absent-tolerant without it.
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphQlError>,
}

#[derive(Deserialize)]
struct GraphQlError {
    #[serde(default)]
    message: String,
}

/// Runs one query or mutation and returns its `data`.
///
/// GraphQL answers a *failed* request with HTTP 200 and an `errors` array, so a status check alone
/// would read every failure as a success and then fail to deserialise, reporting a parse problem for
/// what was actually a permissions one. Both are checked, errors first.
async fn run<T: for<'de> Deserialize<'de>>(
    query: &str,
    variables: serde_json::Value,
    auth: &BoardAuth,
) -> Result<T, String> {
    let body = serde_json::json!({ "query": query, "variables": variables });
    let res = client()
        .post(ENDPOINT)
        .header("Authorization", auth.header())
        .header("Content-Type", "application/json")
        .header("API-Version", API_VERSION)
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| format!("no se pudo conectar con monday.com: {e}"))?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() && text.trim().is_empty() {
        return Err(format!("monday.com devolvió {status}"));
    }

    let parsed: GraphQlResponse<T> = serde_json::from_str(&text)
        .map_err(|e| format!("respuesta inesperada de monday.com ({e}): {}", text.trim()))?;
    if !parsed.errors.is_empty() {
        let detail: Vec<String> = parsed.errors.into_iter().map(|e| e.message).collect();
        return Err(format!("monday.com rechazó la petición: {}", detail.join("; ")));
    }
    parsed.data.ok_or_else(|| "monday.com no devolvió datos".to_string())
}

// ---------- the account ----------

#[derive(Deserialize)]
struct MeData {
    me: MeUser,
}

#[derive(Deserialize)]
struct MeUser {
    #[serde(default)]
    account: Option<RawAccount>,
}

#[derive(Deserialize)]
struct RawAccount {
    #[serde(default)]
    name: String,
    /// The subdomain — `acme` for `acme.monday.com`. Unique per account, which is what makes it a
    /// key rather than a label.
    #[serde(default)]
    slug: String,
}

/// Who this token belongs to: the account slug and its display name.
///
/// There is one API host for every monday customer, so unlike Azure and Jira there is no URL to
/// identify a connection by — the token *is* the identity. Asking the host who it belongs to is what
/// lets two accounts be connected side by side without the user inventing a name for each, and what
/// gives the item URLs their subdomain.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MondayAccount {
    pub slug: String,
    pub name: String,
}

pub async fn whoami(auth: &BoardAuth) -> Result<MondayAccount, String> {
    let data: MeData = run(
        "query { me { account { name slug } } }",
        serde_json::json!({}),
        auth,
    )
    .await?;
    let account = data
        .me
        .account
        .ok_or_else(|| "Ese token no está asociado a ninguna cuenta de monday.com".to_string())?;
    if account.slug.trim().is_empty() {
        return Err("monday.com no informó el subdominio de la cuenta".to_string());
    }
    Ok(MondayAccount { slug: account.slug, name: account.name })
}

/// The page a person opens for one item.
fn item_url(slug: &str, board_id: &str, item_id: i64) -> String {
    format!("https://{slug}.monday.com/boards/{board_id}/pulses/{item_id}")
}

// ---------- boards and groups ----------

#[derive(Debug, Clone, serde::Serialize)]
pub struct MondayBoard {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct BoardsData {
    #[serde(default)]
    boards: Vec<RawBoard>,
}

#[derive(Deserialize)]
struct RawBoard {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    columns: Vec<RawColumn>,
    #[serde(default)]
    groups: Vec<RawGroup>,
}

#[derive(Deserialize, Clone)]
struct RawColumn {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(rename = "type", default)]
    kind: String,
}

#[derive(Deserialize)]
struct RawGroup {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
}

/// The boards this token can see, most recently used first.
pub async fn list_boards(auth: &BoardAuth) -> Result<Vec<MondayBoard>, String> {
    let data: BoardsData = run(
        &format!(
            "query {{ boards(limit: {MAX_BOARDS}, state: active, order_by: used_at) \
             {{ id name }} }}"
        ),
        serde_json::json!({}),
        auth,
    )
    .await?;
    Ok(data
        .boards
        .into_iter()
        .filter(|b| !b.id.trim().is_empty())
        .map(|b| MondayBoard { id: b.id, name: b.name })
        .collect())
}

/// The board's groups, as the target picker's third slot.
///
/// Returned as [`WorkItemType`] because that is what the slot holds on the other two boards and the
/// picker is one control. A group is not a *type* — nothing about it changes the shape of an item —
/// but it answers the same question the type answers there: where does a published story land.
pub async fn list_groups(board_id: &str, auth: &BoardAuth) -> Result<Vec<WorkItemType>, String> {
    let board = read_board(board_id, auth).await?;
    Ok(board
        .groups
        .into_iter()
        .filter(|g| !g.id.trim().is_empty())
        .map(|g| WorkItemType {
            name: g.title,
            reference_name: g.id,
            description: String::new(),
            color: String::new(),
            // monday's sub-items are a hierarchy, not a kind of group — nothing here is excluded
            // from being published into.
            subtask: false,
        })
        .collect())
}

async fn read_board(board_id: &str, auth: &BoardAuth) -> Result<RawBoard, String> {
    if board_id.trim().is_empty() {
        return Err("Falta el tablero de monday.com".to_string());
    }
    let data: BoardsData = run(
        "query ($ids: [ID!]) { boards(ids: $ids) { id name columns { id title type } \
         groups { id title } } }",
        serde_json::json!({ "ids": [board_id.trim()] }),
        auth,
    )
    .await?;
    data.boards
        .into_iter()
        .next()
        .ok_or_else(|| format!("El tablero {board_id} no existe o este token no lo ve"))
}

// ---------- which column is what ----------

/// The columns of one board, matched to the things a story has.
///
/// Detected **by type**, not by title: a title is whatever somebody typed, in whatever language, and
/// matching on it would work on the boards it was tested against and quietly fail on the rest.
/// Matching on type is narrower and honest — a board with no long-text column genuinely has nowhere
/// to put a story, and that is worth refusing rather than working around.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BoardSchema {
    /// Where the narrative, the description and the criteria go. `None` means this board cannot hold
    /// a story, which is a real state and one the screen reports.
    pub text_column: Option<DetectedColumn>,
    /// Where the estimate goes. Optional: a board with no numbers column publishes stories without
    /// their points rather than not at all.
    pub numbers_column: Option<DetectedColumn>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DetectedColumn {
    pub id: String,
    /// The column's own title, so the panel can say *which* column it picked. The whole point of
    /// reporting the mapping is that "description → Notes" is checkable and "description → detected"
    /// is not.
    pub title: String,
}

impl From<&RawColumn> for DetectedColumn {
    fn from(column: &RawColumn) -> Self {
        Self { id: column.id.clone(), title: column.title.clone() }
    }
}

fn detect(columns: &[RawColumn]) -> BoardSchema {
    let first_of = |kind: &str| columns.iter().find(|c| c.kind == kind);
    BoardSchema {
        // `long_text` first: a story's prose is multi-line, and a short text column would truncate
        // it at the host rather than here, where it could be reported.
        text_column: first_of("long_text").or_else(|| first_of("text")).map(DetectedColumn::from),
        numbers_column: first_of("numbers").map(DetectedColumn::from),
    }
}

/// Remembered per board for the life of the process: publishing twenty stories must not be twenty
/// extra round trips asking the same board what its columns are, and columns do not change while
/// the app is open often enough to matter.
fn schema_memo() -> &'static Mutex<HashMap<String, BoardSchema>> {
    static MEMO: OnceLock<Mutex<HashMap<String, BoardSchema>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn board_schema(board_id: &str, auth: &BoardAuth) -> Result<BoardSchema, String> {
    if let Ok(memo) = schema_memo().lock() {
        if let Some(hit) = memo.get(board_id) {
            return Ok(hit.clone());
        }
    }
    let board = read_board(board_id, auth).await?;
    let schema = detect(&board.columns);
    if let Ok(mut memo) = schema_memo().lock() {
        memo.insert(board_id.to_string(), schema.clone());
    }
    Ok(schema)
}

// ---------- writing ----------

/// The description column's payload: narrative, prose, then the criteria under a heading.
///
/// Identical in shape to what the Jira client composes, because both are solving the same problem —
/// one text field for three things — and a story published to both boards should read the same on
/// each.
fn compose_text(narrative: &str, description: &str, criteria: &[String]) -> String {
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
        out.push_str(&format!("{CRITERIA_HEADING}\n\n"));
        for criterion in listed {
            out.push_str(criterion);
            out.push_str("\n\n");
        }
    }
    out.trim_end().to_string()
}

/// The inverse: prose, then whatever was filed under the heading.
///
/// A column this app never wrote has no heading and comes back whole as prose — the honest answer,
/// and the same call the Jira client makes. Guessing that some list halfway down is "really" the
/// acceptance criteria would be wrong exactly on the screen whose job is to report what a story is
/// missing.
fn split_text(text: &str) -> (String, Vec<String>) {
    let Some(at) = text.find(CRITERIA_HEADING) else {
        return (text.trim().to_string(), Vec::new());
    };
    let prose = text[..at].trim().to_string();
    let rest = text[at + CRITERIA_HEADING.len()..].trim();
    let criteria: Vec<String> = rest
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .map(str::to_string)
        .collect();
    (prose, criteria)
}

/// Builds the `column_values` argument: a JSON **string** whose keys are column ids.
///
/// The two formats are not the same and both are verified against the API reference — a long-text
/// column takes `{"text": …}` and a numbers column takes a bare quoted string. Sending one shape
/// where the other belongs is rejected for the whole item, not for the field.
fn column_values(schema: &BoardSchema, text: &str, points: f64) -> Result<String, String> {
    let mut values = serde_json::Map::new();
    if let Some(column) = &schema.text_column {
        if !text.trim().is_empty() {
            values.insert(column.id.clone(), serde_json::json!({ "text": text }));
        }
    }
    if let Some(column) = &schema.numbers_column {
        if points > 0.0 {
            // Trailing `.0` trimmed: monday shows "3" for a whole number and "3.0" reads as a
            // precision this estimate does not have.
            let rendered = match points.fract() == 0.0 {
                true => format!("{}", points as i64),
                false => format!("{points}"),
            };
            values.insert(column.id.clone(), serde_json::json!(rendered));
        }
    }
    serde_json::to_string(&serde_json::Value::Object(values)).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct CreateItemData {
    create_item: Option<RawCreated>,
}

#[derive(Deserialize)]
struct CreateSubitemData {
    create_subitem: Option<RawCreated>,
}

#[derive(Deserialize)]
struct RawCreated {
    #[serde(default)]
    id: String,
}

fn numeric_id(raw: &str) -> i64 {
    raw.trim().parse().unwrap_or(0)
}

/// Creates one item.
///
/// `slug` is the account subdomain, needed only to build the link a human opens — monday's create
/// mutation answers with an id and nothing else, and an item nobody can click through to is an item
/// the publish log cannot point at.
pub async fn create_item(
    slug: &str,
    board_id: &str,
    group_id: &str,
    item: &NewWorkItem<'_>,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    if item.title.trim().is_empty() {
        return Err("La historia no tiene título".to_string());
    }
    let schema = board_schema(board_id, auth).await?;
    let text = compose_text(item.narrative, item.description, item.acceptance_criteria);
    if schema.text_column.is_none() && !text.is_empty() {
        // Refused rather than published as a bare title. A story whose narrative and criteria were
        // silently dropped looks published, and the person planning from that board has no way to
        // find out what it was supposed to say.
        return Err(
            "Este tablero de monday.com no tiene ninguna columna de texto donde escribir la \
             historia. Añade una columna de tipo «Texto largo» al tablero y vuelve a publicar."
                .to_string(),
        );
    }

    let values = column_values(&schema, &text, item.story_points)?;
    let data: CreateItemData = run(
        "mutation ($board: ID!, $group: String, $name: String!, $values: JSON) { \
         create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values) \
         { id } }",
        serde_json::json!({
            "board": board_id.trim(),
            // Absent rather than empty: monday reads a missing group as "the board's first", which
            // is the only sensible default, and rejects an empty string outright.
            "group": (!group_id.trim().is_empty()).then(|| group_id.trim()),
            "name": item.title.trim(),
            "values": values,
        }),
        auth,
    )
    .await?;

    let created = data.create_item.ok_or_else(|| "monday.com no creó el elemento".to_string())?;
    let id = numeric_id(&created.id);
    Ok(ItemRef { id, url: item_url(slug, board_id, id), key: String::new() })
}

/// Creates one sub-item under an existing item.
///
/// No board id and no group: a sub-item belongs to its parent, and monday puts it on the parent's
/// own sub-items board — which is why its columns are not this board's columns, and why the detail
/// goes in the name rather than into a column that may not exist there.
pub async fn create_subitem(
    slug: &str,
    board_id: &str,
    parent_id: i64,
    title: &str,
    _detail: &str,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    if title.trim().is_empty() {
        return Err("Esa tarea no tiene título".to_string());
    }
    if parent_id <= 0 {
        return Err("No se sabe bajo qué elemento colgar la tarea".to_string());
    }
    let data: CreateSubitemData = run(
        "mutation ($parent: ID!, $name: String!) { \
         create_subitem(parent_item_id: $parent, item_name: $name) { id } }",
        serde_json::json!({ "parent": parent_id.to_string(), "name": title.trim() }),
        auth,
    )
    .await?;
    let created = data.create_subitem.ok_or_else(|| "monday.com no creó la subtarea".to_string())?;
    let id = numeric_id(&created.id);
    Ok(ItemRef { id, url: item_url(slug, board_id, id), key: String::new() })
}

/// Applies an edit to an item that already exists.
///
/// The text column is rewritten whole, criteria included, because on monday they live *inside* it —
/// there is no separate field to patch. So an edit that names only one half reads the item first and
/// keeps the other, the same care the Jira client takes for the same reason.
pub async fn update_item(
    slug: &str,
    board_id: &str,
    item_id: i64,
    edit: &WorkItemEdit,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    if item_id <= 0 {
        return Err("Ese identificador de elemento no es válido".to_string());
    }
    let schema = board_schema(board_id, auth).await?;

    if let Some(title) = &edit.title {
        if title.trim().is_empty() {
            return Err("El elemento no puede quedarse sin título".to_string());
        }
        // The item's name is not a column value, so it takes its own mutation. `name` is the
        // pseudo-column monday exposes it under.
        // Untyped: the two mutations below answer with the item they touched, and there is nothing
        // in it worth reading — the id was already known. What matters is whether they errored, and
        // `run` has already turned a GraphQL `errors` array into a `Err` by the time this returns.
        let _: serde_json::Value = run(
            "mutation ($board: ID!, $item: ID!, $value: String!) { \
             change_simple_column_value(board_id: $board, item_id: $item, column_id: \"name\", \
             value: $value) { id } }",
            serde_json::json!({
                "board": board_id.trim(),
                "item": item_id.to_string(),
                "value": title.trim(),
            }),
            auth,
        )
        .await?;
    }

    let touches_prose = edit.description.is_some() || edit.repro_steps.is_some();
    if touches_prose || edit.acceptance_criteria.is_some() {
        let Some(column) = schema.text_column.clone() else {
            return Err(
                "Este tablero de monday.com no tiene ninguna columna de texto donde escribir."
                    .to_string(),
            );
        };

        // The review screen hands prose over as HTML when it has rendered Markdown itself. monday
        // stores text, so that has to be undone here rather than written through.
        let plain = |text: &String| match edit.prose_is_html {
            true => html_to_text(text),
            false => text.clone(),
        };

        // Only fetched when the rewrite would otherwise lose the half not being sent.
        let existing = match touches_prose && edit.acceptance_criteria.is_some() {
            true => None,
            false => Some(read_item_text(board_id, item_id, &column.id, auth).await?),
        };
        let (existing_prose, existing_criteria) =
            existing.as_deref().map(split_text).unwrap_or_else(|| (String::new(), Vec::new()));

        let mut prose = match &edit.description {
            Some(description) => plain(description),
            None => existing_prose,
        };
        if let Some(steps) = &edit.repro_steps {
            let steps = plain(steps);
            if !steps.trim().is_empty() {
                prose.push_str(&format!("\n\nPasos para reproducir\n\n{}", steps.trim()));
            }
        }
        let criteria = match &edit.acceptance_criteria {
            Some(criteria) => criteria.clone(),
            None => existing_criteria,
        };

        let values = serde_json::json!({ column.id: { "text": compose_text("", &prose, &criteria) } });
        let _: serde_json::Value = run(
            "mutation ($board: ID!, $item: ID!, $values: JSON!) { \
             change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) \
             { id } }",
            serde_json::json!({
                "board": board_id.trim(),
                "item": item_id.to_string(),
                "values": serde_json::to_string(&values).map_err(|e| e.to_string())?,
            }),
            auth,
        )
        .await?;
    }

    Ok(ItemRef { id: item_id, url: item_url(slug, board_id, item_id), key: String::new() })
}

// ---------- reading ----------

#[derive(Deserialize)]
struct ItemsData {
    #[serde(default)]
    items: Vec<RawItem>,
}

#[derive(Deserialize)]
struct RawItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    board: Option<RawItemBoard>,
    #[serde(default)]
    group: Option<RawGroup>,
    #[serde(default)]
    column_values: Vec<RawColumnValue>,
    #[serde(default)]
    subitems: Vec<RawItem>,
}

#[derive(Deserialize)]
struct RawItemBoard {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawColumnValue {
    #[serde(default)]
    id: String,
    /// The rendered content. Read instead of `value` on purpose: `value` is a JSON blob whose shape
    /// is per column type, and every one of those shapes would have to be handled to get at a string
    /// this already is.
    #[serde(default)]
    text: Option<String>,
    #[serde(rename = "type", default)]
    kind: String,
}

const ITEM_FIELDS: &str = "id name board { id name } group { id title } \
     column_values { id text type }";

async fn read_item_text(
    board_id: &str,
    item_id: i64,
    column_id: &str,
    auth: &BoardAuth,
) -> Result<String, String> {
    let _ = board_id;
    let data: ItemsData = run(
        "query ($ids: [ID!]) { items(ids: $ids) { id column_values { id text } } }",
        serde_json::json!({ "ids": [item_id.to_string()] }),
        auth,
    )
    .await?;
    Ok(data
        .items
        .into_iter()
        .next()
        .and_then(|item| {
            item.column_values
                .into_iter()
                .find(|value| value.id == column_id)
                .and_then(|value| value.text)
        })
        .unwrap_or_default())
}

/// Reads one item and the sub-items it already has.
pub async fn get_item(slug: &str, item_id: i64, auth: &BoardAuth) -> Result<WorkItem, String> {
    if item_id <= 0 {
        return Err("Ese identificador de elemento no es válido".to_string());
    }
    let data: ItemsData = run(
        &format!(
            "query ($ids: [ID!]) {{ items(ids: $ids) {{ {ITEM_FIELDS} \
             subitems {{ id name column_values {{ id text type }} }} }} }}"
        ),
        serde_json::json!({ "ids": [item_id.to_string()] }),
        auth,
    )
    .await?;
    let raw = data
        .items
        .into_iter()
        .next()
        .ok_or_else(|| format!("El elemento {item_id} no existe o este token no lo ve"))?;

    let board_id = raw.board.as_ref().map(|b| b.id.clone()).unwrap_or_default();
    // Read straight off the item rather than through `board_schema`, which would be a second round
    // trip to learn what the answer already contains.
    let text = first_text(&raw.column_values);
    let (prose, criteria) = split_text(&text);
    let effort = first_number(&raw.column_values);

    let children: Vec<WorkItemChild> = raw
        .subitems
        .into_iter()
        .take(MAX_CHILDREN)
        .map(|child| {
            let child_id = numeric_id(&child.id);
            WorkItemChild {
                url: item_url(slug, &board_id, child_id),
                id: child_id,
                key: String::new(),
                // monday has no per-item type. Empty rather than invented — the review screen
                // already handles a child that doesn't name one.
                work_item_type: String::new(),
                title: child.name,
                state: String::new(),
                description_html: text_to_html(&first_text(&child.column_values)),
                assigned_to: String::new(),
            }
        })
        .collect();

    Ok(WorkItem {
        id: numeric_id(&raw.id),
        url: item_url(slug, &board_id, numeric_id(&raw.id)),
        key: String::new(),
        // The group, which is the closest thing this board has to "what kind of thing is this".
        work_item_type: raw.group.map(|g| g.title).unwrap_or_default(),
        title: raw.name,
        state: String::new(),
        team_project: raw.board.as_ref().map(|b| b.name.clone()).unwrap_or_default(),
        // The board *id*, which is not its name — an update addressed by name reaches nothing.
        container_id: board_id.clone(),
        description_html: text_to_html(&prose),
        // Neither field exists here, and the review screen's own "this board doesn't have that"
        // handling is the single place that decides what to show for it.
        repro_steps_html: String::new(),
        system_info_html: String::new(),
        acceptance_criteria_html: criteria_to_html(&criteria),
        effort,
        effort_field: match effort > 0.0 {
            true => "Números".to_string(),
            false => String::new(),
        },
        tags: String::new(),
        area_path: String::new(),
        iteration_path: String::new(),
        children,
    })
}

/// The first long-text (else text) column that has content — the same precedence [`detect`] uses,
/// applied to an answer that already carries the types.
fn first_text(values: &[RawColumnValue]) -> String {
    let pick = |kind: &str| {
        values
            .iter()
            .find(|value| value.kind == kind && value.text.as_deref().unwrap_or("").trim() != "")
            .and_then(|value| value.text.clone())
    };
    pick("long_text").or_else(|| pick("text")).unwrap_or_default()
}

fn first_number(values: &[RawColumnValue]) -> f64 {
    values
        .iter()
        .filter(|value| value.kind == "numbers")
        .find_map(|value| value.text.as_deref()?.trim().parse::<f64>().ok())
        .unwrap_or(0.0)
}

// ---------- what the user pasted ----------

/// Reads an item out of a monday.com link.
///
/// URLs only, and deliberately: `https://acme.monday.com/boards/123/pulses/456` is unmistakable,
/// while a bare number is what an Azure work item looks like and has meant here since before either
/// of the other boards existed. Claiming it would silently move every existing reference.
pub fn parse_item_ref(input: &str) -> Option<WorkItemRef> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }
    let without_scheme = text.split_once("://").map_or(text, |(_, rest)| rest);
    let (path, _) = without_scheme.split_once('?').unwrap_or((without_scheme, ""));
    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty()).collect();
    let host = *segments.first()?;
    let slug = host.strip_suffix(".monday.com")?;
    if slug.is_empty() || slug.contains('.') {
        return None;
    }

    let board = segments
        .iter()
        .position(|segment| segment.eq_ignore_ascii_case("boards"))
        .and_then(|at| segments.get(at + 1))
        .filter(|id| id.chars().all(|c| c.is_ascii_digit()))?;
    let item = segments
        .iter()
        .position(|segment| segment.eq_ignore_ascii_case("pulses"))
        .and_then(|at| segments.get(at + 1))
        .and_then(|id| id.parse::<i64>().ok())
        .filter(|id| *id > 0)?;

    Some(WorkItemRef {
        org: Some(slug.to_string()),
        project: Some((*board).to_string()),
        id: item,
        key: String::new(),
        provider: BoardProvider::Monday,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_travels_bare_rather_than_wrapped() {
        // The one place monday differs from the other two boards at the protocol level.
        assert_eq!(BoardAuth::raw("abc123").header(), "abc123");
    }

    #[test]
    fn the_columns_are_matched_by_type_not_by_title() {
        let columns = vec![
            RawColumn { id: "t1".into(), title: "Resumen".into(), kind: "text".into() },
            RawColumn { id: "lt1".into(), title: "Notas".into(), kind: "long_text".into() },
            RawColumn { id: "n1".into(), title: "Puntos".into(), kind: "numbers".into() },
            RawColumn { id: "s1".into(), title: "Estado".into(), kind: "status".into() },
        ];
        let schema = detect(&columns);
        // Long text wins over short text: a story's prose is multi-line.
        assert_eq!(schema.text_column.as_ref().map(|c| c.id.as_str()), Some("lt1"));
        assert_eq!(schema.text_column.as_ref().map(|c| c.title.as_str()), Some("Notas"));
        assert_eq!(schema.numbers_column.as_ref().map(|c| c.id.as_str()), Some("n1"));
    }

    /// A board with nowhere to put a story is a real state, not an error to paper over.
    #[test]
    fn a_board_with_no_text_column_reports_none() {
        let columns = vec![RawColumn {
            id: "s1".into(),
            title: "Estado".into(),
            kind: "status".into(),
        }];
        let schema = detect(&columns);
        assert!(schema.text_column.is_none());
        assert!(schema.numbers_column.is_none());
    }

    #[test]
    fn the_two_column_formats_are_not_the_same_shape() {
        let schema = BoardSchema {
            text_column: Some(DetectedColumn { id: "lt1".into(), title: "Notas".into() }),
            numbers_column: Some(DetectedColumn { id: "n1".into(), title: "Puntos".into() }),
        };
        let json: serde_json::Value =
            serde_json::from_str(&column_values(&schema, "Hola", 5.0).unwrap()).unwrap();
        // Long text takes an object, numbers take a quoted string. Swapping them is a rejected item.
        assert_eq!(json["lt1"], serde_json::json!({ "text": "Hola" }));
        assert_eq!(json["n1"], serde_json::json!("5"));
    }

    #[test]
    fn a_whole_estimate_is_written_without_a_decimal_tail() {
        let schema = BoardSchema {
            text_column: None,
            numbers_column: Some(DetectedColumn { id: "n1".into(), title: "P".into() }),
        };
        let json: serde_json::Value =
            serde_json::from_str(&column_values(&schema, "", 3.0).unwrap()).unwrap();
        assert_eq!(json["n1"], serde_json::json!("3"));
        let half: serde_json::Value =
            serde_json::from_str(&column_values(&schema, "", 0.5).unwrap()).unwrap();
        assert_eq!(half["n1"], serde_json::json!("0.5"));
    }

    /// Nothing is sent for a field the board can't hold, rather than an empty value that would
    /// overwrite whatever was there.
    #[test]
    fn an_absent_column_contributes_nothing() {
        let schema = BoardSchema { text_column: None, numbers_column: None };
        assert_eq!(column_values(&schema, "Hola", 5.0).unwrap(), "{}");
    }

    #[test]
    fn the_criteria_survive_the_round_trip_through_one_column() {
        let criteria = vec![
            "Escenario: alta\nDado un cliente\nCuando confirma\nEntonces se registra".to_string(),
            "Escenario: baja\nDado un cliente\nCuando cancela\nEntonces se cierra".to_string(),
        ];
        let composed = compose_text("Como cliente, quiero X, para Y", "Contexto.", &criteria);
        let (prose, back) = split_text(&composed);
        assert!(prose.starts_with("Como cliente"));
        assert!(prose.contains("Contexto."));
        assert_eq!(back, criteria);
    }

    #[test]
    fn a_column_written_elsewhere_is_all_prose() {
        let (prose, criteria) = split_text("Solo texto.\n\nY más texto.");
        assert_eq!(prose, "Solo texto.\n\nY más texto.");
        assert!(criteria.is_empty());
    }

    #[test]
    fn reads_an_item_out_of_a_board_link() {
        let found = parse_item_ref("https://acme.monday.com/boards/123456/pulses/789012").unwrap();
        assert_eq!(found.provider, BoardProvider::Monday);
        assert_eq!(found.org.as_deref(), Some("acme"));
        assert_eq!(found.project.as_deref(), Some("123456"));
        assert_eq!(found.id, 789012);
    }

    /// Everything that is not unmistakably a monday link belongs to another board.
    #[test]
    fn nothing_else_is_a_monday_reference() {
        assert_eq!(parse_item_ref("4821"), None);
        assert_eq!(parse_item_ref("WEB-42"), None);
        assert_eq!(parse_item_ref("https://dev.azure.com/f/W/_workitems/edit/4821"), None);
        assert_eq!(parse_item_ref("https://acme.atlassian.net/browse/WEB-42"), None);
        // A board link with no item named is a board, not an item.
        assert_eq!(parse_item_ref("https://acme.monday.com/boards/123456"), None);
        assert_eq!(parse_item_ref(""), None);
    }
}
