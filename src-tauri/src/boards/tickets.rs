//! Tickets: the work items *assigned to you*, as the «Tickets» section of Agentes › Tareas lists
//! them, and what turns one into code — a branch named after it, an agent briefed with it, a pull
//! request that points back at it.
//!
//! (user, 2026-10-23: «Tickets conectados al código, en Agentes › Tareas … En cada ticket, un botón
//! «Empezar» que crea la rama con un nombre a partir del ticket (`feature/AB-123-titulo`) y abre un
//! agente en un worktree con el ticket completo … Al abrir el PR se agrega el enlace al ticket
//! (`AB#123` o `Fixes #123`) y el ticket pasa a «En revisión»; al hacer merge, a «Hecho».»)
//!
//! This file holds the normalised shapes and every rule that is a pure function of them — the
//! branch name, the key a branch carries, which of a board's states means "in review", the line a
//! pull request gets, the first prompt — so each is tested without a network. The reads live in
//! [`super::assigned`], the state changes in [`super::transitions`], the ticket ↔ branch record in
//! [`super::ticket_links`].

use serde::{Deserialize, Serialize};

use super::BoardProvider;

// ---------- shapes ----------

/// One ticket as the list shows it — the same fields whichever board it came from.
///
/// Deserialisable as well, because the frontend hands the row back to every command that acts on
/// it: the row already says which account, which container and which key, and re-deriving those
/// from a uid would be a second parser to keep in step with this one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Ticket {
    /// `azure` | `jira` | `linear` | `github` | `gitlab` | `monday`.
    pub provider: String,
    /// Which connection: the Azure organisation, the Jira site, the GitHub/GitLab host, the Linear
    /// organisation key, the monday account slug — what `board_auth` is keyed by.
    pub account: String,
    /// The container, as a person reads it: Azure project, Jira project, `owner/repo`, Linear team,
    /// monday board.
    pub project: String,
    /// The same container as a write addresses it: Azure project name, Jira project key, repo path,
    /// Linear team id, monday board id.
    #[serde(default)]
    pub container_id: String,
    /// The host's number: Azure's id, GitHub/GitLab's issue number, monday's item id, the numeric
    /// part of a Jira/Linear key.
    pub id: i64,
    /// What a write addresses it by, where that is not the id: Jira's `ABC-123`, Linear's `ENG-123`,
    /// GitHub/GitLab's `owner/repo#12`. Empty on Azure and monday.
    #[serde(default)]
    pub key: String,
    pub title: String,
    pub state: String,
    /// `todo` | `doing` | `review` | `done` | empty when the board does not say.
    #[serde(default)]
    pub state_category: String,
    #[serde(default)]
    pub work_item_type: String,
    /// The sprint, iteration, cycle or milestone, as its own name. Empty when it has none.
    #[serde(default)]
    pub sprint: String,
    #[serde(default)]
    pub priority: String,
    pub url: String,
    #[serde(default)]
    pub updated_at: String,
    /// monday's status column id — the one board whose state lives in a column of its own choosing.
    #[serde(default)]
    pub state_field: String,
}

/// A comment, rendered to HTML the frontend sanitises before showing it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TicketComment {
    pub author: String,
    pub created_at: String,
    pub body_html: String,
}

/// Everything «Empezar» briefs an agent with, and the detail pane shows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TicketDetail {
    pub ticket: Ticket,
    pub description_html: String,
    /// Empty when the board has no such field and the description did not carry a criteria heading.
    pub acceptance_criteria_html: String,
    /// Newest last, at most [`MAX_COMMENTS`].
    pub comments: Vec<TicketComment>,
}

/// One state a ticket can be moved to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TicketState {
    /// What the move sends: Azure's and monday's state name, Jira's transition id, Linear's state
    /// id, GitHub/GitLab's `open`/`closed`.
    pub id: String,
    /// The state the ticket ends up in, as the board names it.
    pub name: String,
    #[serde(default)]
    pub category: String,
}

/// A connection that could not be read — reported beside the list rather than failing it, so one
/// expired token does not hide every other board's tickets.
#[derive(Debug, Clone, Serialize)]
pub struct TicketSourceError {
    pub provider: String,
    pub account: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct TicketList {
    pub tickets: Vec<Ticket>,
    pub errors: Vec<TicketSourceError>,
}

/// A state change CodeFlow made, so the toast can say what moved and undo can put it back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketMove {
    pub ticket: Ticket,
    pub from: String,
    pub to: String,
}

/// Comments a detail reads — the recent conversation, not the whole history.
pub const MAX_COMMENTS: usize = 20;

impl Ticket {
    pub fn board(&self) -> BoardProvider {
        BoardProvider::parse(&self.provider)
    }

    /// Unique across every connection: `provider:account:key-or-id`.
    pub fn uid(&self) -> String {
        ticket_uid(&self.provider, &self.account, &self.key, self.id)
    }

    /// The token a branch name carries: the key where the board has one people say aloud (Jira,
    /// Linear), the number everywhere else.
    pub fn branch_token(&self) -> String {
        match self.board() {
            BoardProvider::Jira | BoardProvider::Linear if !self.key.trim().is_empty() => self.key.trim().to_ascii_uppercase(),
            _ => self.id.to_string(),
        }
    }

    /// How the chip names it: `ABC-123`, `#123`.
    pub fn display_key(&self) -> String {
        match self.board() {
            BoardProvider::Jira | BoardProvider::Linear if !self.key.trim().is_empty() => self.key.trim().to_string(),
            _ => format!("#{}", self.id),
        }
    }

    /// Whether this is a bug, by type or by label — what picks the `bugfix/` prefix.
    pub fn is_bug(&self) -> bool {
        let kind = fold(&self.work_item_type);
        kind.contains("bug") || kind.contains("defect") || kind.contains("incidente") || kind.contains("error")
    }
}

pub fn ticket_uid(provider: &str, account: &str, key: &str, id: i64) -> String {
    let which = if key.trim().is_empty() { id.to_string() } else { key.trim().to_string() };
    format!("{}:{}:{which}", provider.trim().to_ascii_lowercase(), account.trim().to_ascii_lowercase())
}

// ---------- text ----------

/// Lower case with the accents a Spanish or Portuguese board name carries dropped — "En revisión"
/// and "en revision" are one state name.
pub fn fold(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            c => c,
        })
        .collect()
}

/// The title as a branch-name slug: ASCII letters and digits, single dashes, at most `max` bytes
/// cut at a word boundary — `Iniciar sesión con Google (SSO)` → `iniciar-sesion-con-google-sso`.
pub fn slug(title: &str, max: usize) -> String {
    let mut out = String::new();
    for c in fold(title).chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    if out.len() <= max {
        return out.to_string();
    }
    // Cut at the last dash inside the budget, so the name ends on a whole word.
    let cut = &out[..max];
    match cut.rfind('-') {
        Some(at) if at > max / 2 => cut[..at].to_string(),
        _ => cut.trim_end_matches('-').to_string(),
    }
}

/// A prefix as a git ref segment: `feature/`, `bugfix/`. Blank means none; a missing trailing
/// slash is added, since `featureAB-123` is never what was meant.
fn clean_prefix(prefix: &str) -> String {
    let parts: Vec<String> = prefix.split('/').map(|part| slug(part, 40)).filter(|part| !part.is_empty()).collect();
    match parts.is_empty() {
        true => String::new(),
        false => format!("{}/", parts.join("/")),
    }
}

/// The branch «Empezar» creates: `{prefix}{token}-{slug}` — `feature/ABC-123-iniciar-sesion`,
/// `bugfix/4821-totales-mal-redondeados`. Always a valid ref name: every character is ASCII
/// alphanumeric, `-` or `/`, no segment is empty and none ends in `.lock`.
pub fn branch_name(ticket: &Ticket, feature_prefix: &str, bug_prefix: &str) -> String {
    let prefix = clean_prefix(if ticket.is_bug() { bug_prefix } else { feature_prefix });
    let token: String = ticket.branch_token().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let token = if token.is_empty() { "ticket".to_string() } else { token };
    let title = slug(&ticket.title, 40);
    match title.is_empty() {
        true => format!("{prefix}{token}"),
        false => format!("{prefix}{token}-{title}"),
    }
}

// ---------- which state is "in review", which is "done" ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Review,
    Done,
}

/// Names a board gives "the code is waiting on a reviewer", best first. Matched whole after
/// folding; `Resolved` is last because on Azure's Agile process it is the step before Closed.
const REVIEW_NAMES: &[&str] = &[
    "in review",
    "en revision",
    "code review",
    "in code review",
    "review",
    "revision",
    "ready for review",
    "por revisar",
    "en revision de codigo",
    "pr open",
    "in pr",
    "resolved",
    "resuelto",
];

const DONE_NAMES: &[&str] = &["done", "hecho", "closed", "cerrado", "completed", "completado", "terminado", "finalizado", "merged"];

/// Words that mark a terminal state that is *not* the work being done.
const NOT_DONE: &[&str] = &["cancel", "removed", "eliminad", "descartad", "won't", "wont", "duplicate", "rejected", "rechazad"];

/// Picks the state a ticket should move to: a name the list knows first, then the board's own
/// category. `None` when nothing fits — GitHub has no review state, and guessing one is worse than
/// leaving the ticket where it is.
pub fn auto_pick(states: &[TicketState], target: Target) -> Option<TicketState> {
    let names = match target {
        Target::Review => REVIEW_NAMES,
        Target::Done => DONE_NAMES,
    };
    for wanted in names {
        if let Some(state) = states.iter().find(|s| fold(s.name.trim()) == *wanted) {
            return Some(state.clone());
        }
    }
    let category = match target {
        Target::Review => "review",
        Target::Done => "done",
    };
    states
        .iter()
        .find(|s| s.category == category && !NOT_DONE.iter().any(|word| fold(&s.name).contains(word)))
        .cloned()
}

/// The configured target if the board still offers it, else [`auto_pick`].
pub fn resolve_target(states: &[TicketState], configured: Option<&str>, target: Target) -> Option<TicketState> {
    if let Some(name) = configured.map(str::trim).filter(|n| !n.is_empty()) {
        if let Some(state) = states.iter().find(|s| fold(&s.name) == fold(name)) {
            return Some(state.clone());
        }
    }
    auto_pick(states, target)
}

/// The key the per-board target setting is stored under: one per container, since a process (and
/// so its state names) is per project.
pub fn board_key(ticket: &Ticket) -> String {
    format!(
        "{}:{}:{}",
        ticket.provider.to_ascii_lowercase(),
        ticket.account.to_ascii_lowercase(),
        if ticket.container_id.is_empty() { &ticket.project } else { &ticket.container_id }
    )
}

// ---------- the pull request ----------

/// What a pull request opened from a ticket's branch carries.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PrReference {
    /// Put in front of the title when it is not there yet: `[ABC-123] `. Empty where the board
    /// links from the body instead.
    pub title_prefix: String,
    /// Appended to the description: `AB#123`, `Fixes #12`, the Jira key with its URL.
    pub body_line: String,
    /// Azure work items linked through the API at creation — only when the pull request is on an
    /// Azure repository of the same organisation.
    pub work_item_ids: Vec<i64>,
}

/// Where the pull request is opened, as much of it as the reference depends on.
#[derive(Debug, Clone, Default)]
pub struct PrHost {
    /// `azure` | `github` | `gitlab` | `bitbucket`.
    pub provider: String,
    /// The Azure organisation, or the GitHub/GitLab host.
    pub account: String,
    /// `owner/repo`, `group/project`.
    pub repo: String,
}

/// The reference a pull request gets, per board — and per host, because the same Azure work item
/// is `AB#123` from GitHub (the Azure Boards app's syntax) and a real link from Azure Repos.
pub fn pr_reference(ticket: &Ticket, host: &PrHost) -> PrReference {
    let mut out = PrReference::default();
    match ticket.board() {
        BoardProvider::Azure => {
            let same_org = host.provider == "azure" && host.account.eq_ignore_ascii_case(&ticket.account);
            if same_org {
                // Azure Repos links it for real; `#123` in the text renders as the work item too.
                out.body_line = format!("Work item: #{}", ticket.id);
                out.work_item_ids = vec![ticket.id];
            } else {
                out.body_line = format!("AB#{}", ticket.id);
            }
        }
        BoardProvider::Github | BoardProvider::Gitlab => {
            let (repo, number) = super::issues::split_key(&ticket.key).unwrap_or((ticket.project.clone(), ticket.id));
            let same_tracker = host.provider == ticket.provider
                && host.account.eq_ignore_ascii_case(&ticket.account)
                && host.repo.trim_matches('/').eq_ignore_ascii_case(repo.trim_matches('/'));
            out.body_line = match same_tracker {
                true => format!("Fixes #{number}"),
                false if host.provider == ticket.provider && host.account.eq_ignore_ascii_case(&ticket.account) => {
                    format!("Fixes {repo}#{number}")
                }
                // Another host cannot close it; the link is all that is left.
                false => format!("Ticket: {}", ticket.url),
            };
        }
        BoardProvider::Jira | BoardProvider::Linear => {
            let key = ticket.display_key();
            out.title_prefix = format!("[{key}] ");
            out.body_line = match ticket.url.trim().is_empty() {
                true => key,
                false => format!("{key}: {}", ticket.url.trim()),
            };
        }
        BoardProvider::Monday => {
            out.body_line = format!("Ticket: {}", ticket.url.trim());
        }
    }
    out
}

/// The title with the prefix in front, unless it is already there in some form.
pub fn apply_title(title: &str, reference: &PrReference) -> String {
    let prefix = reference.title_prefix.trim();
    if prefix.is_empty() {
        return title.to_string();
    }
    let key = prefix.trim_start_matches('[').trim_end_matches(']');
    if title.to_ascii_uppercase().contains(&key.to_ascii_uppercase()) {
        return title.to_string();
    }
    format!("{prefix} {}", title.trim())
}

/// The description with the reference line at the end, unless it already says it.
pub fn apply_body(body: &str, reference: &PrReference) -> String {
    let line = reference.body_line.trim();
    if line.is_empty() || body.contains(line) {
        return body.to_string();
    }
    match body.trim().is_empty() {
        true => line.to_string(),
        false => format!("{}\n\n{line}", body.trim_end()),
    }
}

// ---------- the first prompt ----------

/// The most of each part the prompt carries — a ticket with a 40-page description is briefed with
/// its head and a pointer to the rest.
const PART_MAX: usize = 6_000;
const COMMENT_MAX: usize = 800;

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{}…", head.trim_end())
}

/// What the agent is told first: the ticket whole — title, description, acceptance criteria, the
/// recent comments and the link — and the branch it is already on.
pub fn ticket_prompt(detail: &TicketDetail, branch: &str) -> String {
    let ticket = &detail.ticket;
    let mut out = format!("Trabaja en el ticket {} — {}\n", ticket.display_key(), ticket.title.trim());
    let facts: Vec<String> = [
        (!ticket.work_item_type.is_empty()).then(|| format!("Tipo: {}", ticket.work_item_type)),
        (!ticket.state.is_empty()).then(|| format!("Estado: {}", ticket.state)),
        (!ticket.sprint.is_empty()).then(|| format!("Sprint: {}", ticket.sprint)),
        (!ticket.priority.is_empty()).then(|| format!("Prioridad: {}", ticket.priority)),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !facts.is_empty() {
        out.push_str(&facts.join(" · "));
        out.push('\n');
    }
    if !ticket.url.is_empty() {
        out.push_str(&format!("Enlace: {}\n", ticket.url));
    }
    out.push_str(&format!("Rama: {branch} (ya creada; estás en ella)\n"));

    let description = super::html_to_text(&detail.description_html);
    if !description.trim().is_empty() {
        out.push_str(&format!("\n## Descripción\n{}\n", clip(&description, PART_MAX)));
    }
    let criteria = super::html_to_text(&detail.acceptance_criteria_html);
    if !criteria.trim().is_empty() {
        out.push_str(&format!("\n## Criterios de aceptación\n{}\n", clip(&criteria, PART_MAX)));
    }
    let comments: Vec<String> = detail
        .comments
        .iter()
        .filter_map(|comment| {
            let body = super::html_to_text(&comment.body_html);
            let body = clip(&body, COMMENT_MAX);
            (!body.is_empty()).then(|| {
                let when = comment.created_at.get(..10).unwrap_or(&comment.created_at);
                format!("- {} ({when}): {}", comment.author.trim(), body.replace('\n', " "))
            })
        })
        .collect();
    if !comments.is_empty() {
        out.push_str(&format!("\n## Comentarios recientes\n{}\n", comments.join("\n")));
    }
    out.push_str(
        "\nImplementa lo que pide el ticket en esta rama y cumple los criterios de aceptación. \
         Si algo del ticket no está claro, pregunta antes de suponer. Al terminar, resume qué cambiaste; \
         no abras el pull request ni hagas push sin preguntar.",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(provider: &str, id: i64, key: &str, title: &str) -> Ticket {
        Ticket {
            provider: provider.into(),
            account: "acme".into(),
            project: "Web".into(),
            id,
            key: key.into(),
            title: title.into(),
            url: format!("https://example.test/{id}"),
            ..Default::default()
        }
    }

    fn state(id: &str, name: &str, category: &str) -> TicketState {
        TicketState { id: id.into(), name: name.into(), category: category.into() }
    }

    #[test]
    fn slugs_fold_accents_and_cut_on_a_word() {
        assert_eq!(slug("Iniciar sesión con Google (SSO)", 40), "iniciar-sesion-con-google-sso");
        assert_eq!(slug("  ¿Qué?  ", 40), "que");
        assert_eq!(slug("uno dos tres cuatro cinco seis siete ocho", 20), "uno-dos-tres-cuatro");
        assert_eq!(slug("!!!", 40), "");
    }

    #[test]
    fn branch_names_per_board() {
        let jira = ticket("jira", 123, "abc-123", "Iniciar sesión con Google");
        assert_eq!(branch_name(&jira, "feature/", "bugfix/"), "feature/ABC-123-iniciar-sesion-con-google");
        let mut bug = ticket("azure", 4821, "", "Totales mal redondeados");
        bug.work_item_type = "Bug".into();
        assert_eq!(branch_name(&bug, "feature/", "bugfix/"), "bugfix/4821-totales-mal-redondeados");
        let issue = ticket("github", 12, "acme/web#12", "Fix: login");
        assert_eq!(branch_name(&issue, "feat", ""), "feat/12-fix-login");
        assert_eq!(branch_name(&issue, "", ""), "12-fix-login");
        let untitled = ticket("linear", 7, "ENG-7", "…");
        assert_eq!(branch_name(&untitled, "feature/", "bugfix/"), "feature/ENG-7");
    }

    #[test]
    fn branch_names_are_valid_refs_whatever_the_prefix() {
        let t = ticket("jira", 1, "AB-1", "x");
        assert_eq!(branch_name(&t, " ../weird prefix//.lock ", ""), "weird-prefix/lock/AB-1-x");
    }

    #[test]
    fn review_and_done_are_picked_by_name_then_category() {
        let azure = vec![
            state("New", "New", "todo"),
            state("Active", "Active", "doing"),
            state("Resolved", "Resolved", "review"),
            state("Closed", "Closed", "done"),
            state("Removed", "Removed", "done"),
        ];
        assert_eq!(auto_pick(&azure, Target::Review).unwrap().name, "Resolved");
        assert_eq!(auto_pick(&azure, Target::Done).unwrap().name, "Closed");

        let spanish = vec![state("11", "Por hacer", "todo"), state("21", "En revisión", "doing"), state("31", "Hecho", "done")];
        assert_eq!(auto_pick(&spanish, Target::Review).unwrap().id, "21");
        assert_eq!(auto_pick(&spanish, Target::Done).unwrap().id, "31");

        let custom = vec![state("a", "Shipped", "done"), state("b", "Canceled", "done")];
        assert_eq!(auto_pick(&custom, Target::Done).unwrap().id, "a");
        assert!(auto_pick(&custom, Target::Review).is_none());

        let github = vec![state("open", "open", "todo"), state("closed", "closed", "done")];
        assert!(auto_pick(&github, Target::Review).is_none(), "no review state is invented");
        assert_eq!(auto_pick(&github, Target::Done).unwrap().id, "closed");
    }

    #[test]
    fn a_configured_target_wins_while_the_board_still_has_it() {
        let states = vec![state("1", "Code Review", "doing"), state("2", "QA", "doing")];
        assert_eq!(resolve_target(&states, Some("qa"), Target::Review).unwrap().id, "2");
        assert_eq!(resolve_target(&states, Some("Gone"), Target::Review).unwrap().id, "1");
        assert_eq!(resolve_target(&states, None, Target::Review).unwrap().id, "1");
    }

    #[test]
    fn pr_references_per_board_and_host() {
        let azure = ticket("azure", 123, "", "x");
        let on_azure = PrHost { provider: "azure".into(), account: "ACME".into(), repo: String::new() };
        let r = pr_reference(&azure, &on_azure);
        assert_eq!(r.work_item_ids, vec![123]);
        assert_eq!(r.body_line, "Work item: #123");
        let on_github = PrHost { provider: "github".into(), account: "github.com".into(), repo: "acme/web".into() };
        let r = pr_reference(&azure, &on_github);
        assert_eq!(r.body_line, "AB#123");
        assert!(r.work_item_ids.is_empty());

        let mut issue = ticket("github", 12, "acme/web#12", "x");
        issue.account = "github.com".into();
        assert_eq!(pr_reference(&issue, &on_github).body_line, "Fixes #12");
        let other_repo = PrHost { repo: "acme/api".into(), ..on_github.clone() };
        assert_eq!(pr_reference(&issue, &other_repo).body_line, "Fixes acme/web#12");

        let jira = ticket("jira", 5, "ABC-5", "x");
        let r = pr_reference(&jira, &on_github);
        assert_eq!(r.title_prefix, "[ABC-5] ");
        assert_eq!(r.body_line, "ABC-5: https://example.test/5");
        assert_eq!(apply_title("Login con Google", &r), "[ABC-5] Login con Google");
        assert_eq!(apply_title("ABC-5 login", &r), "ABC-5 login");
        assert_eq!(apply_body("", &r), "ABC-5: https://example.test/5");
        assert_eq!(apply_body("Cambios.", &r), "Cambios.\n\nABC-5: https://example.test/5");
        assert_eq!(apply_body("Cambios.\n\nABC-5: https://example.test/5", &r), "Cambios.\n\nABC-5: https://example.test/5");
    }

    #[test]
    fn the_prompt_carries_the_whole_ticket() {
        let mut t = ticket("jira", 5, "ABC-5", "Login con Google");
        t.state = "To Do".into();
        t.sprint = "Sprint 12".into();
        let detail = TicketDetail {
            ticket: t,
            description_html: "<p>Permitir <b>SSO</b>.</p>".into(),
            acceptance_criteria_html: "<ol><li>Dado un usuario</li></ol>".into(),
            comments: vec![TicketComment { author: "Ana".into(), created_at: "2026-10-20T10:00:00Z".into(), body_html: "<p>Ojo con\nlos tokens</p>".into() }],
        };
        let prompt = ticket_prompt(&detail, "feature/ABC-5-login-con-google");
        assert!(prompt.starts_with("Trabaja en el ticket ABC-5 — Login con Google"));
        assert!(prompt.contains("Estado: To Do · Sprint: Sprint 12"));
        assert!(prompt.contains("Rama: feature/ABC-5-login-con-google"));
        assert!(prompt.contains("## Descripción\nPermitir SSO."));
        assert!(prompt.contains("## Criterios de aceptación"));
        assert!(prompt.contains("Dado un usuario"));
        assert!(prompt.contains("- Ana (2026-10-20): Ojo con los tokens"));
        assert!(prompt.contains("https://example.test/5"));
    }

    #[test]
    fn uids_and_keys() {
        assert_eq!(ticket("Jira", 5, "ABC-5", "x").uid(), "jira:acme:ABC-5");
        assert_eq!(ticket("azure", 9, "", "x").uid(), "azure:acme:9");
        assert_eq!(ticket("azure", 9, "", "x").display_key(), "#9");
        assert_eq!(ticket("linear", 9, "ENG-9", "x").display_key(), "ENG-9");
    }
}
