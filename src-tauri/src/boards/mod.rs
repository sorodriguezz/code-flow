//! The board a backlog is published to, whichever product that happens to be.
//!
//! Three implementations sit behind this module — [`azure`] for Azure DevOps Boards, [`jira`] for
//! Jira, [`monday`] for monday.com — and everything above it (the story set, the review screen, the
//! publish button) speaks only the normalised types declared here. That is the same shape the pull-request side already
//! uses for GitHub/GitLab/Azure: each client normalises to one set of structs, and a `match` at the
//! edge picks the client. A feature that works on one board therefore works on the others without a
//! second code path — which is what let monday.com arrive as a third arm rather than a second
//! pipeline.
//!
//! **What is deliberately not abstracted.** Wikis live in [`azure`] alone and are reached directly:
//! neither of the others has one, Jira's sibling product Confluence is a separate API with separate
//! credentials, and pretending otherwise would put a dead menu in front of most users. Area and
//! iteration paths are the same story in miniature — an Azure concept with no counterpart elsewhere,
//! so they stay on the Azure arm and the target panel only offers them when the target is Azure.
//!
//! **Where the three stop resembling each other.** The three target slots are named for Azure
//! because it defined them first, and each host reads them as its own: organisation / project /
//! work item type, site / project key / issue type, account / board / group. That mapping holds
//! because all three answer the same question — which host, which container, where inside it. What
//! does *not* generalise is that Azure and Jira have a schema and monday does not: see
//! [`monday::BoardSchema`] for what had to be detected rather than named.
//!
//! Nothing here **deletes**. Work items are read, created and edited; whatever a review concludes
//! still goes back through the user's own hands.

pub mod azure;
pub mod jira;
pub mod monday;

use serde::{Deserialize, Serialize};

// ---------- which board ----------

/// Which product a story set (or a review session) is pointed at.
///
/// Stored as a plain string on the row rather than as an integer, so a database opened by an older
/// build reads `azure` and behaves exactly as it did. Anything unrecognised — including the empty
/// string every row had before this column existed — is Azure, which is what those rows were.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoardProvider {
    /// The default, and what every row that predates the other two means.
    #[default]
    Azure,
    Jira,
    Monday,
}

impl BoardProvider {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "jira" => Self::Jira,
            "monday" => Self::Monday,
            _ => Self::Azure,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Azure => "azure",
            Self::Jira => "jira",
            Self::Monday => "monday",
        }
    }
}

/// How a host expects its token presented.
///
/// Two arms rather than one because monday.com is the exception that proves the rule: Azure DevOps
/// and Jira both wrap the token in HTTP Basic and differ only in what goes in the user half, so one
/// shape covered both. monday sends the token bare, with no scheme word at all — a difference this
/// has to model rather than paper over, because getting it wrong is a 401 that reads like a bad
/// password and sends the user off to reissue a token that was fine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScheme {
    /// `Basic base64(user:secret)` — Azure DevOps and Jira.
    Basic,
    /// The token exactly as issued — monday.com.
    Raw,
}

/// The credentials for one board.
///
/// Azure DevOps ignores the user half (`:{pat}`), Jira wants the account e-mail
/// (`{email}:{token}`), monday wants neither. One struct rather than three because those are
/// *values*, not protocols, and the moment each is its own type every caller has to know which
/// board it is talking to just to pass a password through.
#[derive(Debug, Clone)]
pub struct BoardAuth {
    /// Empty except for Jira Cloud, where it is the account e-mail.
    pub user: String,
    pub secret: String,
    pub scheme: AuthScheme,
}

impl BoardAuth {
    /// An Azure DevOps personal access token.
    pub fn pat(pat: impl Into<String>) -> Self {
        Self { user: String::new(), secret: pat.into(), scheme: AuthScheme::Basic }
    }

    /// A Jira account e-mail and API token.
    pub fn basic(user: impl Into<String>, token: impl Into<String>) -> Self {
        Self { user: user.into(), secret: token.into(), scheme: AuthScheme::Basic }
    }

    /// A monday.com personal API token, sent as-is.
    pub fn raw(token: impl Into<String>) -> Self {
        Self { user: String::new(), secret: token.into(), scheme: AuthScheme::Raw }
    }

    /// The `Authorization` header value. Shared so the clients cannot drift on how a token is
    /// encoded — the failure mode of that drift is a 401 that looks like a wrong password.
    pub fn header(&self) -> String {
        match self.scheme {
            AuthScheme::Raw => self.secret.clone(),
            AuthScheme::Basic => {
                use base64::Engine;
                let token = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", self.user, self.secret));
                format!("Basic {token}")
            }
        }
    }
}

// ---------- what a board holds ----------

/// Where inside the container a published story lands: Azure's "User Story", Jira's "Story",
/// monday's group.
///
/// Read from the host rather than hard-coded. Azure's list depends on the process the project was
/// created with, Jira's on the issue-type scheme attached to it, monday's on the groups somebody
/// made — none is knowable from here, and guessing wrong means publishing into something that isn't
/// there. monday's entries are not *types* at all, but they answer the same question the other two
/// answer, and the picker is one control.
#[derive(Debug, Clone, Serialize)]
pub struct WorkItemType {
    pub name: String,
    /// The value the create call actually sends. Azure's reference name, Jira's issue-type id.
    pub reference_name: String,
    pub description: String,
    /// Hex without the leading `#`; empty when the host doesn't colour its types.
    pub color: String,
    /// Jira's sub-task types, which cannot be created at the top level. Always `false` on Azure,
    /// where the hierarchy is a link rather than a property of the type.
    #[serde(default)]
    pub subtask: bool,
}

/// Everything one story contributes to a work item. Assembled by the command layer from the stored
/// draft, so no client has to know what a draft row looks like.
pub struct NewWorkItem<'a> {
    pub title: &'a str,
    /// The "Como … quiero … para …" line. Rendered above the description so the work item opens
    /// with the story itself rather than with its context.
    pub narrative: &'a str,
    pub description: &'a str,
    pub acceptance_criteria: &'a [String],
    /// Azure only; ignored by Jira, which has no such field. Empty means "leave the project
    /// default", which is what Azure applies when the field is absent.
    pub area_path: &'a str,
    pub iteration_path: &'a str,
    /// Comma- or semicolon-separated. Azure stores them as one string, Jira as an array of labels;
    /// the split happens in the client that needs it.
    pub tags: &'a str,
    /// `0` means unset for both — the host's own defaults beat a made-up number.
    pub priority: i64,
    pub story_points: f64,
    /// Hours the work is expected to take, and hours of it still to do. Azure keeps them in two
    /// fields because they diverge as the work happens; at creation they are the same number, and
    /// the caller is what decides that rather than this being clever about it.
    ///
    /// `0.0` means unset, as everything else here does.
    pub original_estimate: f64,
    pub remaining_work: f64,
}

/// Everything one accepted task contributes to the child work item it becomes.
///
/// A struct rather than the eight positional arguments this used to be: the last four are all
/// numbers and short strings, and a call site that passes `2, 4.0, 4.0` reads the same whichever
/// order they are in. Every field is optional in the "0 or empty means leave it alone" sense the
/// rest of this module uses — a board that has no such field, or a task nobody estimated, publishes
/// with what it does have.
#[derive(Debug, Clone, Default)]
pub struct NewChildItem<'a> {
    pub title: &'a str,
    /// The three questions, as Markdown. Converted to the host's own prose format on the way out.
    pub detail: &'a str,
    /// What kind of work this is, in the words the board's own field uses: Azure's Activity is a
    /// picklist whose Agile values are Development, Testing, Design, Deployment, Documentation and
    /// Requirements. Empty leaves the field alone.
    pub activity: &'a str,
    /// The team's own label for the same distinction, when the project carries a separate field for
    /// it — `QA` on a QA task. Written only where such a field exists; see
    /// [`azure::TypeFields::by_any_label`].
    pub task_type: &'a str,
    pub priority: i64,
    pub original_estimate: f64,
    pub remaining_work: f64,
    /// Where the parent is filed. Copied onto the child so a task shows up in the same sprint as
    /// the story it belongs to — Azure does not inherit either through the parent link, and a task
    /// left on the project root is one that never appears on the board anybody is working from.
    pub area_path: &'a str,
    pub iteration_path: &'a str,
}

/// A work item that now exists, as little of it as the caller needs to record and link to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemRef {
    /// The host's numeric id. Jira issues have one of these as well as their key, and storing the
    /// number is what let this column stay an integer through the Jira work.
    pub id: i64,
    /// The page a human opens, not the REST resource.
    pub url: String,
    /// Jira's `PROJ-123`. Empty on Azure, where the id *is* what people say out loud, and the UI
    /// falls back to `#id` when this is empty.
    #[serde(default)]
    pub key: String,
}

/// What the review screen sends back to a story it has been editing.
///
/// Every field is optional and `None` means **leave it alone**, which is not the same as clearing
/// it. The screen publishes in three steps and each one has to be able to write its own part
/// without touching the others — an empty string is a real value here ("the user emptied this"),
/// so absence has to be spelled separately from emptiness.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct WorkItemEdit {
    pub title: Option<String>,
    /// Plain text unless [`prose_is_html`](Self::prose_is_html) says otherwise.
    pub description: Option<String>,
    /// A bug's steps. Azure keeps these in their own field; Jira has no equivalent and appends
    /// them to the description instead.
    pub repro_steps: Option<String>,
    /// One whole scenario per element.
    pub acceptance_criteria: Option<Vec<String>>,
    /// The estimate, in whatever unit the item's own process names it — story points on Agile,
    /// effort on Scrum, size on CMMI. Written to the field the item *already* reports using, so a
    /// value typed on the review screen lands where the board shows it rather than in a second
    /// field the team never looks at. `Some(0.0)` clears it.
    pub effort: Option<f64>,
    /// The reference name of the field the estimate lives in on *this* item, as the item reported
    /// it. Empty when it has never been estimated and the client has to pick. Azure only.
    #[serde(default)]
    pub effort_field: String,
    /// Whether the prose above is already HTML and must be written through untouched.
    ///
    /// The review screen edits the description in a Markdown editor, and Markdown put through
    /// [`text_to_html`] arrives on the board as a paragraph beginning with two literal hash marks.
    /// The rendering is done where the Markdown parser already lives — the frontend, which
    /// sanitises its output before it leaves — and this flag is how that pre-rendered HTML gets
    /// past the escaping that every other caller still needs.
    #[serde(default)]
    pub prose_is_html: bool,
}

/// A work item as the review screen needs it.
///
/// The prose arrives as HTML in every case. Azure stores it that way already; Jira does not, and its
/// client converts on the way out — done there rather than here so the screen has exactly one kind
/// of text to render and cannot end up showing raw markup for one board and prose for the other.
#[derive(Debug, Clone, Serialize)]
pub struct WorkItem {
    pub id: i64,
    pub url: String,
    /// Jira's `PROJ-123`; empty on Azure.
    #[serde(default)]
    pub key: String,
    pub work_item_type: String,
    pub title: String,
    pub state: String,
    /// The project it lives in, by display name. Read from the item rather than taken from the link:
    /// a link copied before the item was moved names the old one.
    pub team_project: String,
    /// The same container, by whatever identifier a write to it takes: Azure's project name, Jira's
    /// project key, monday's numeric board id.
    ///
    /// Separate from `team_project` because on monday those are not the same string, and an update
    /// addressed by board *name* is an update to nothing. Empty falls back to `team_project`, which
    /// is what the other two use for both.
    #[serde(default)]
    pub container_id: String,
    pub description_html: String,
    /// Where a **Bug** actually keeps its prose on Azure (`Microsoft.VSTS.TCM.ReproSteps`). Empty on
    /// Jira, which has no such field.
    pub repro_steps_html: String,
    /// Environment, version, OS. Azure only.
    pub system_info_html: String,
    /// Empty when the board has no such field, which is not a failure: a Basic-process "Issue" and
    /// a stock Jira issue both keep their criteria inside the description.
    pub acceptance_criteria_html: String,
    /// The estimate, whatever this board calls it. `0.0` means "not estimated".
    pub effort: f64,
    /// Which field the estimate came out of, so the UI can say "Story Points" or "Effort" rather
    /// than inventing a name for a number whose meaning is per-process.
    pub effort_field: String,
    pub tags: String,
    /// Azure only; empty on Jira.
    pub area_path: String,
    pub iteration_path: String,
    /// The tasks the item already has, which the review shows before proposing any of its own.
    pub children: Vec<WorkItemChild>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkItemChild {
    pub id: i64,
    pub url: String,
    #[serde(default)]
    pub key: String,
    pub work_item_type: String,
    pub title: String,
    pub state: String,
    /// What the task actually says — so the review screen can show it without a round trip to the
    /// browser.
    pub description_html: String,
    /// Who it is assigned to, by display name. Empty when nobody is.
    pub assigned_to: String,
}

/// What a pasted work-item reference resolves to.
///
/// `org` and `project` are `None` for a bare id or key — the caller fills those in from the
/// connection the workspace is already pointed at, which is the common case for someone reading a
/// number off a board they have open.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkItemRef {
    /// The Azure organisation, or the Jira site.
    pub org: Option<String>,
    pub project: Option<String>,
    /// Azure's work item id. On Jira this is `0` until the key is resolved against the host, since
    /// a Jira URL carries the key and never the numeric id.
    pub id: i64,
    /// Jira's `PROJ-123`; empty for Azure.
    #[serde(default)]
    pub key: String,
    /// Which client can act on this reference. Derived from the shape of what was pasted.
    pub provider: BoardProvider,
}

// ---------- text, shared ----------

/// Escapes the four characters that would otherwise be read as markup.
///
/// Everything a story carries is authored as plain text in the app, so it is escaped and wrapped
/// before it reaches a field the host stores as HTML — pasting raw text into one renders every `<`
/// as a broken tag and collapses every line break.
pub(crate) fn escape_html(text: &str) -> String {
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

/// Replaces balanced `delim … delim` runs with `open … close`.
///
/// An unpaired delimiter is left as the character it is: an asterisk in prose is far more often a
/// footnote or a wildcard than half an emphasis, and a run with nothing but whitespace between its
/// markers is not emphasis either.
fn wrap_pairs(text: &str, delim: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(delim) {
        let after = &rest[start + delim.len()..];
        let Some(end) = after.find(delim) else { break };
        if after[..end].trim().is_empty() {
            // Not emphasis — copy the opening marker through and carry on past it.
            out.push_str(&rest[..start + delim.len()]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..start]);
        out.push_str(open);
        out.push_str(&after[..end]);
        out.push_str(close);
        rest = &after[end + delim.len()..];
    }
    out.push_str(rest);
    out
}

/// One line of Markdown's *inline* markers, on text that is escaped first so nothing in it can be
/// read as markup. Code before emphasis, and `**` before `*`, so the longer marker wins.
fn inline_md(text: &str) -> String {
    let escaped = escape_html(text);
    let code = wrap_pairs(&escaped, "`", "<code>", "</code>");
    let bold = wrap_pairs(&code, "**", "<strong>", "</strong>");
    wrap_pairs(&bold, "*", "<em>", "</em>")
}

/// The list marker a line opens with, and the text after it.
///
/// `- `, `* ` and `1. ` are the three the models are asked for and the three a person writing in
/// the app's own editor types. The bool is "this list is numbered".
fn list_item(line: &str) -> Option<(bool, &str)> {
    let line = line.trim_start();
    if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
        return Some((false, rest.trim()));
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        if let Some(rest) = line[digits..].strip_prefix(". ") {
            return Some((true, rest.trim()));
        }
    }
    None
}

/// Markdown → HTML, for the subset a work item is actually written in.
///
/// Every surface upstream of here treats this text as Markdown — the app's own editors render it
/// through `marked`, and the review prompts ask the models for it — so by the time a description
/// reaches a board it has `- ` bullets and `**bold**` in it. Escaping that wholesale is what put a
/// literal dash inside every bullet Azure drew: the marker rendered as text *and* the host drew its
/// own bullet in front of it. This turns each marker into the markup it stands for instead.
///
/// A deliberate subset — lists of both kinds, bold, italic, inline code, headings flattened to
/// bold, and paragraphs. Tables, images, links and fenced blocks are left as the characters they
/// were typed as, because a half-rendered table reads worse than a plain one.
///
/// `wrap_paragraphs` is off for text that is already inside a block element (a `<li>`), where a
/// `<p>` buys nothing but margins.
fn md_blocks(text: &str, wrap_paragraphs: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut paragraph: Vec<String> = Vec::new();
    let mut items: Vec<String> = Vec::new();
    let mut ordered = false;

    fn flush_paragraph(lines: &mut Vec<String>, wrap: bool, out: &mut String) {
        if lines.is_empty() {
            return;
        }
        let body = lines.join("<br>");
        match wrap {
            true => out.push_str(&format!("<p>{body}</p>")),
            // A bare block needs something between it and the next one, or two paragraphs read as
            // one — `<br>` is the separator that works inside a `<li>`.
            false => {
                if !out.is_empty() {
                    out.push_str("<br>");
                }
                out.push_str(&body);
            }
        }
        lines.clear();
    }

    fn flush_list(items: &mut Vec<String>, ordered: bool, out: &mut String) {
        if items.is_empty() {
            return;
        }
        let tag = if ordered { "ol" } else { "ul" };
        let body: String = items.iter().map(|item| format!("<li>{item}</li>")).collect();
        out.push_str(&format!("<{tag}>{body}</{tag}>"));
        items.clear();
    }

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush_list(&mut items, ordered, &mut out);
            flush_paragraph(&mut paragraph, wrap_paragraphs, &mut out);
            continue;
        }
        if let Some((numbered, content)) = list_item(trimmed) {
            flush_paragraph(&mut paragraph, wrap_paragraphs, &mut out);
            // A list that changes kind mid-way is two lists, not one mislabelled one.
            if !items.is_empty() && numbered != ordered {
                flush_list(&mut items, ordered, &mut out);
            }
            ordered = numbered;
            items.push(inline_md(content));
            continue;
        }
        flush_list(&mut items, ordered, &mut out);
        // A heading has no counterpart in a work item field — Azure's own editor writes bold for
        // the same job — so it becomes the emphasis it was standing in for.
        let heading = trimmed.trim_start_matches('#');
        match heading.len() < trimmed.len() && heading.starts_with(' ') {
            true => paragraph.push(format!("<strong>{}</strong>", inline_md(heading.trim()))),
            false => paragraph.push(inline_md(trimmed)),
        }
    }
    flush_list(&mut items, ordered, &mut out);
    flush_paragraph(&mut paragraph, wrap_paragraphs, &mut out);
    out
}

/// Markdown → HTML paragraphs. A blank line starts a new block, a single newline is a break, which
/// is how the text reads in the editor it was written in.
pub(crate) fn text_to_html(text: &str) -> String {
    md_blocks(text, true)
}

/// Strips the bullet from a criterion whose whole body is one bulleted line.
///
/// A criterion is already an item of the criteria list, so a list *inside* it that holds a single
/// entry is a bullet drawn under a number for one sentence — the host indents it and the reader
/// gets two markers for one requirement. Two or more lines are a real checklist and keep theirs.
///
/// The title line, if there is one, is not part of the count: `**Título**` followed by one bullet
/// is still one bullet.
fn unwrap_lone_bullet(criterion: &str) -> String {
    let lines: Vec<&str> = criterion.lines().collect();
    let bullets = lines.iter().filter(|line| list_item(line).is_some()).count();
    if bullets != 1 {
        return criterion.to_string();
    }
    lines
        .iter()
        .map(|line| match list_item(line) {
            Some((_, rest)) => rest,
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The acceptance criteria as an ordered list. One `<li>` per criterion; a criterion written in
/// Gherkin keeps its Dado/Cuando/Entonces on their own lines inside its own item, and one written
/// as a checklist becomes a real nested list rather than lines that start with a dash.
///
/// A criterion may open with a bold title line (`**Fijación del destino**`), which the review
/// screen writes and reads back. Nothing here treats it specially — it is Markdown like the rest,
/// and it renders as the lead-in it looks like.
pub(crate) fn criteria_to_html(criteria: &[String]) -> String {
    let items: Vec<String> = criteria
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .map(|c| format!("<li>{}</li>", md_blocks(&unwrap_lone_bullet(c), false)))
        .collect();
    if items.is_empty() {
        return String::new();
    }
    format!("<ol>{}</ol>", items.join(""))
}

/// HTML → plain text, well enough to hand to a board that stores prose as text.
///
/// The inverse of [`text_to_html`], and lossy on purpose: it recovers the paragraph and list breaks
/// that carry the meaning and drops the rest of the markup. It exists because the review screen
/// composes its description as HTML for Azure, and a Jira publish of that same draft would otherwise
/// write literal tags into the issue where the prose should be.
pub(crate) fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut chars = html.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '<' {
            out.push(c);
            continue;
        }
        // Read the tag name so the ones that mean "a line ended here" can leave a newline behind.
        let mut tag = String::new();
        for inner in chars.by_ref() {
            if inner == '>' {
                break;
            }
            tag.push(inner);
        }
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase();
        // `<li>` deliberately does *not* get a `- ` marker here, tempting as it looks now that the
        // outbound side writes real lists: both tags leaving a newline is what puts a blank line
        // between items, and `split_criteria` reads a list of scenarios back apart on exactly that.
        // See `a_list_comes_back_as_separate_blocks`.
        match name.as_str() {
            "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                out.push('\n')
            }
            _ => {}
        }
    }

    let unescaped = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");

    // Collapse the runs of blank lines the tag walk leaves behind (`</p><p>` is two newlines).
    let mut lines: Vec<&str> = Vec::new();
    for line in unescaped.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() && lines.last().map(|l: &&str| l.is_empty()).unwrap_or(true) {
            continue;
        }
        lines.push(trimmed);
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines.join("\n")
}

// ---------- dispatch ----------

/// The kinds of work item this board offers.
pub async fn list_work_item_types(
    provider: BoardProvider,
    org: &str,
    project: &str,
    auth: &BoardAuth,
) -> Result<Vec<WorkItemType>, String> {
    match provider {
        BoardProvider::Azure => azure::list_work_item_types(org, project, &auth.secret).await,
        BoardProvider::Jira => jira::list_issue_types(org, project, auth).await,
        BoardProvider::Monday => monday::list_groups(project, auth).await,
    }
}

/// Creates one work item.
///
/// `available_fields` is Azure's per-type field list, used to drop fields the type does not define;
/// it is meaningless to Jira and ignored there. Passing it through rather than hiding it behind
/// another round trip keeps the batch publish at one probe for the whole set.
pub async fn create_work_item(
    provider: BoardProvider,
    org: &str,
    project: &str,
    work_item_type: &str,
    item: &NewWorkItem<'_>,
    available_fields: Option<&azure::TypeFields>,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    match provider {
        BoardProvider::Azure => {
            azure::create_work_item(org, project, work_item_type, item, available_fields, &auth.secret)
                .await
        }
        BoardProvider::Jira => jira::create_issue(org, project, work_item_type, item, auth).await,
        BoardProvider::Monday => monday::create_item(org, project, work_item_type, item, auth).await,
    }
}

/// Applies an edit to a work item that already exists.
#[allow(clippy::too_many_arguments)]
pub async fn update_work_item(
    provider: BoardProvider,
    org: &str,
    project: &str,
    id: i64,
    key: &str,
    edit: &WorkItemEdit,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    match provider {
        BoardProvider::Azure => azure::update_work_item(org, id, edit, &auth.secret).await,
        BoardProvider::Jira => jira::update_issue(org, key, edit, auth).await,
        // The only arm that needs the container: monday addresses a column write by board *and*
        // item, so an update that knows only the item has nothing to send it to.
        BoardProvider::Monday => monday::update_item(org, project, id, edit, auth).await,
    }
}

/// Creates one child work item under an existing parent.
///
/// The planning fields on `task` are Azure's alone for now: Jira keeps its estimate in a
/// `timetracking` object and its "kind of work" in whatever custom field the site defined, and
/// monday in a board-specific column — neither is a mapping this can make without asking the host
/// what it has, and neither host refuses a create over a field it was not sent.
#[allow(clippy::too_many_arguments)]
pub async fn create_child_work_item(
    provider: BoardProvider,
    org: &str,
    project: &str,
    parent_id: i64,
    parent_key: &str,
    work_item_type: &str,
    task: &NewChildItem<'_>,
    available_fields: Option<&azure::TypeFields>,
    auth: &BoardAuth,
) -> Result<ItemRef, String> {
    match provider {
        BoardProvider::Azure => {
            azure::create_child_work_item(
                org,
                project,
                parent_id,
                work_item_type,
                task,
                available_fields,
                &auth.secret,
            )
            .await
        }
        BoardProvider::Jira => {
            jira::create_subtask(
                org,
                project,
                parent_key,
                work_item_type,
                task.title,
                task.detail,
                auth,
            )
            .await
        }
        BoardProvider::Monday => {
            monday::create_subitem(org, project, parent_id, task.title, task.detail, auth).await
        }
    }
}

/// Reads one work item and the children it already has.
pub async fn get_work_item(
    provider: BoardProvider,
    org: &str,
    id: i64,
    key: &str,
    auth: &BoardAuth,
) -> Result<WorkItem, String> {
    match provider {
        BoardProvider::Azure => azure::get_work_item(org, id, &auth.secret).await,
        BoardProvider::Jira => jira::get_issue(org, key, auth).await,
        BoardProvider::Monday => monday::get_item(org, id, auth).await,
    }
}

/// Reads a work item out of whatever the user pasted.
///
/// Tried in the order that cannot mis-fire. monday claims only `*.monday.com` links and Jira only a
/// key (`PROJ-123`) or a `/browse/` segment — none of which an Azure URL ever contains — so the
/// Azure parser, the one that accepts a bare number, only ever sees what the other two declined.
/// That ordering is what keeps a bare `4821` meaning today exactly what it meant before either of
/// them existed here.
pub fn parse_work_item_ref(input: &str) -> Option<WorkItemRef> {
    monday::parse_item_ref(input)
        .or_else(|| jira::parse_issue_ref(input))
        .or_else(|| azure::parse_work_item_ref(input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pasted_reference_goes_to_the_board_that_recognises_it() {
        let azure = parse_work_item_ref("https://dev.azure.com/contoso/Web/_workitems/edit/42")
            .expect("an Azure URL is a reference");
        assert_eq!(azure.provider, BoardProvider::Azure);
        assert_eq!(azure.id, 42);

        let jira = parse_work_item_ref("https://acme.atlassian.net/browse/WEB-42")
            .expect("a Jira URL is a reference");
        assert_eq!(jira.provider, BoardProvider::Jira);
        assert_eq!(jira.key, "WEB-42");

        let monday = parse_work_item_ref("https://acme.monday.com/boards/9/pulses/42")
            .expect("a monday URL is a reference");
        assert_eq!(monday.provider, BoardProvider::Monday);
        assert_eq!(monday.id, 42);

        // A bare number is ambiguous, and Azure is what it meant before the other two existed here.
        let bare = parse_work_item_ref("42").expect("a bare id is a reference");
        assert_eq!(bare.provider, BoardProvider::Azure);
    }

    #[test]
    fn each_host_gets_the_token_in_the_shape_it_expects() {
        // Azure ignores the user half; Jira needs the account e-mail in it. Both are HTTP Basic,
        // which is why one struct covers them — and monday is why it needed a scheme anyway.
        assert!(BoardAuth::pat("tok").header().starts_with("Basic "));
        assert_ne!(BoardAuth::pat("tok").header(), BoardAuth::basic("a@b.c", "tok").header());
        assert_eq!(BoardAuth::raw("tok").header(), "tok");
    }

    #[test]
    fn html_survives_the_round_trip_back_to_text() {
        let text = "Primer párrafo.\nSegunda línea.\n\nOtro párrafo.";
        assert_eq!(html_to_text(&text_to_html(text)), text);
    }

    #[test]
    fn an_entity_comes_back_as_the_character_it_stood_for() {
        assert_eq!(html_to_text("<p>a &amp; b &lt; c</p>"), "a & b < c");
    }

    /// One blank line between items, not one newline — which is exactly what the Jira client needs.
    /// The criteria go back into a description as blocks separated by a blank line, and that is what
    /// `split_criteria` reads them back out on; collapsing them to single newlines here would turn a
    /// list of scenarios into one scenario the next time the issue was read.
    #[test]
    fn a_list_comes_back_as_separate_blocks() {
        assert_eq!(html_to_text("<ol><li>uno</li><li>dos</li></ol>"), "uno\n\ndos");
    }

    /// The bug this exists for: a bulleted line used to reach the board as the literal characters
    /// `- algo`, which the host then drew its own bullet in front of. It has to arrive as a list.
    #[test]
    fn a_bulleted_line_becomes_a_list_and_not_a_dash() {
        let html = text_to_html("Hace falta:\n- lo primero\n- lo segundo");
        assert_eq!(html, "<p>Hace falta:</p><ul><li>lo primero</li><li>lo segundo</li></ul>");
        assert!(!html.contains("- lo"), "{html}");
    }

    #[test]
    fn numbered_and_bulleted_lists_do_not_run_into_each_other() {
        let html = text_to_html("1. uno\n2. dos\n- otro");
        assert_eq!(html, "<ol><li>uno</li><li>dos</li></ol><ul><li>otro</li></ul>");
    }

    /// Emphasis and code become markup; a lone asterisk stays the character somebody typed.
    #[test]
    fn inline_markers_become_markup_only_in_pairs() {
        assert_eq!(
            text_to_html("Pon **el total** en `precio_neto` y un 3 * 4"),
            "<p>Pon <strong>el total</strong> en <code>precio_neto</code> y un 3 * 4</p>"
        );
    }

    /// A title is a bold lead-in, and a criterion whose whole body is one bullet loses it — the
    /// criterion is already an item of the list around it, so the bullet would be a second marker
    /// for one requirement.
    #[test]
    fn a_titled_criterion_leads_with_its_name_and_drops_a_lone_bullet() {
        let html = criteria_to_html(&[
            "**Fijación del destino**\n- El tipo de destino se fija a Hospital del Trabajador"
                .to_string(),
        ]);
        assert_eq!(
            html,
            "<ol><li><strong>Fijación del destino</strong><br>\
             El tipo de destino se fija a Hospital del Trabajador</li></ol>"
        );
        assert!(!html.contains("<ul>"), "one bullet is not a list: {html}");
    }

    /// A criterion written as a checklist is a list *inside* its own numbered item — one bullet
    /// drawn by the host, not a bullet plus a dash. Nothing may be escaped into visible markup.
    #[test]
    fn a_checklist_criterion_nests_instead_of_flattening() {
        let html = criteria_to_html(&[
            "El formulario exige:\n- correo\n- teléfono".to_string(),
            "Dado que entro\nCuando guardo\nEntonces veo el aviso".to_string(),
        ]);
        assert_eq!(
            html,
            "<ol>\
             <li>El formulario exige:<ul><li>correo</li><li>teléfono</li></ul></li>\
             <li>Dado que entro<br>Cuando guardo<br>Entonces veo el aviso</li>\
             </ol>"
        );
    }
}
