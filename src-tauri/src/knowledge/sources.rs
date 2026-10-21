//! The knowledge that is not a folder of files: what the app itself holds — notes, meetings,
//! generated documentation, story drafts, pull-request review findings — and a repository's recent
//! commit messages.
//!
//! Each is a collection of documents ([`super::index::DocStamp`]) read in two steps, so a refresh is
//! cheap enough to run before every search: the **stamps** (id, version, title, where it lives) of
//! every row, one small query; then the **bodies** of only the rows whose version the index does not
//! have. Both are reads of the app's database, taken briefly and released (the caller locks).
//!
//! **Privacy is decided here, per document, at every refresh.** A note in a local-only book — its own
//! or any book above it — is stamped private, and so is a meeting recorded into one; the index never
//! hands a private chunk to a cloud engine ([`super::index::search_fts_ranked`]). A book switched to
//! local-only flips its notes' flag on the next refresh without reloading a body, and the search
//! re-checks the database for every note it returns anyway (`super::drop_unshareable`). Secrets are
//! redacted by the index before any text is chunked.
//!
//! Collections, by key prefix: `notes:<workspace>` / `notes:global`, `meetings:<workspace>` /
//! `meetings:global` (a meeting goes where its note does), `docs:<workspace>`, `stories:<workspace>`,
//! `reviews:<project>`, `commits:<project>`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use super::chunker::Kind;
use super::index::{DocBody, DocStamp};

/// The owner of the global notes and meetings, in a collection key.
pub const GLOBAL: &str = "global";
/// Commit messages a repository's collection keeps: the recent history a "why did this change"
/// question is about, without indexing a decade of it.
pub const COMMITS_KEPT: usize = 200;

/// The note books that are local-only: marked so, or inside one that is.
pub fn local_only_books(conn: &Connection) -> HashSet<String> {
    let Ok(mut stmt) = conn.prepare(
        "WITH RECURSIVE lo(id) AS (
             SELECT id FROM note_books WHERE local_only = 1
             UNION
             SELECT b.id FROM note_books b JOIN lo ON b.parent_id = lo.id
         )
         SELECT id FROM lo",
    ) else {
        return HashSet::new();
    };
    stmt.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// The `WHERE` part that picks the notes `owner` holds: a workspace's own (not global) notes, or the
/// global ones.
const OWNED_NOTES: &str = "n.deleted_at = '' AND (CASE WHEN ?1 = 'global' THEN n.scope = 'global' ELSE n.workspace_id = ?1 AND n.scope != 'global' END)";

fn title_or_excerpt(title: String, excerpt: &str) -> String {
    if title.trim().is_empty() { excerpt.chars().take(80).collect() } else { title }
}

/// Runs `sql` (with one `IN (…)` list of `ids`) in slices SQLite's variable limit allows.
fn by_ids<T>(conn: &Connection, sql_before_in: &str, ids: &[String], mut row: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>) -> Vec<T> {
    let mut out = Vec::new();
    for slice in ids.chunks(400) {
        let marks = (1..=slice.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        let Ok(mut stmt) = conn.prepare(&format!("{sql_before_in} ({marks})")) else { continue };
        let values: Vec<&dyn rusqlite::ToSql> = slice.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let rows: Vec<T> = match stmt.query_map(values.as_slice(), &mut row) {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        };
        out.extend(rows);
    }
    out
}

/// The notes `owner` (a workspace id or [`GLOBAL`]) holds, as stamps: `note:<id>`, versioned by
/// `updated_at`, labelled by their book.
pub fn note_stamps(conn: &Connection, owner: &str) -> rusqlite::Result<Vec<DocStamp>> {
    let private = local_only_books(conn);
    let mut stmt = conn.prepare(&format!(
        "SELECT n.id, n.updated_at, n.title, n.excerpt, COALESCE(n.book_id, ''), COALESCE(b.name, '')
         FROM notes n LEFT JOIN note_books b ON b.id = n.book_id WHERE {OWNED_NOTES}"
    ))?;
    let rows = stmt
        .query_map(params![owner], |r| {
            let book: String = r.get(4)?;
            Ok(DocStamp {
                path: format!("note:{}", r.get::<_, String>(0)?),
                version: r.get(1)?,
                private: private.contains(&book),
                title: title_or_excerpt(r.get(2)?, &r.get::<_, String>(3)?),
                label: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The bodies of `paths` (`note:<id>`).
pub fn note_bodies(conn: &Connection, paths: &[String]) -> HashMap<String, DocBody> {
    let ids: Vec<String> = paths.iter().filter_map(|p| p.strip_prefix("note:")).map(str::to_string).collect();
    by_ids(conn, "SELECT id, content FROM notes WHERE id IN", &ids, |r| {
        Ok((format!("note:{}", r.get::<_, String>(0)?), DocBody { kind: Kind::Markdown, prose: true, text: r.get(1)? }))
    })
    .into_iter()
    .collect()
}

/// The meetings recorded into the notes `owner` holds: `meeting:<id>`, private when their note is,
/// versioned by every change a transcript can take (a new line, a second pass, a hand edit).
pub fn meeting_stamps(conn: &Connection, owner: &str) -> rusqlite::Result<Vec<DocStamp>> {
    let private = local_only_books(conn);
    let mut stmt = conn.prepare(&format!(
        "SELECT m.id, m.updated_at || '#' || (SELECT COUNT(*) || '.' || COALESCE(MAX(seq), 0) || '.' || COALESCE(SUM(length(text)), 0) || '.' || COALESCE(SUM(edited), 0)
                                              FROM meeting_lines l WHERE l.meeting_id = m.id),
                n.title, n.excerpt, COALESCE(n.book_id, ''), m.started_at
         FROM meetings m JOIN notes n ON n.id = m.note_id WHERE {OWNED_NOTES}"
    ))?;
    let rows = stmt
        .query_map(params![owner], |r| {
            let book: String = r.get(4)?;
            let started: String = r.get(5)?;
            Ok(DocStamp {
                path: format!("meeting:{}", r.get::<_, String>(0)?),
                version: r.get(1)?,
                private: private.contains(&book),
                title: title_or_excerpt(r.get(2)?, &r.get::<_, String>(3)?),
                label: format!("meeting {}", started.replace('T', " ").chars().take(16).collect::<String>()),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Minutes of transcript under one heading: a chunk is a stretch of the conversation, titled by
/// where it starts, so an answer can say "at 00:12:00".
const MEETING_SECTION_MS: i64 = 3 * 60 * 1000;

fn clock(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// A transcript as Markdown: a `## hh:mm:ss` heading every few minutes, then `Speaker: text` lines.
pub fn transcript_markdown(lines: &[(i64, String, String)]) -> String {
    let mut out = String::new();
    let mut section = -1;
    for (start, speaker, text) in lines {
        let this = start / MEETING_SECTION_MS;
        if this != section {
            section = this;
            out.push_str(&format!("\n## {}\n\n", clock(this * MEETING_SECTION_MS)));
        }
        out.push_str(&format!("{speaker}: {}\n", text.trim()));
    }
    out.trim_start().to_string()
}

/// The transcripts of `paths` (`meeting:<id>`), speakers by the names the user gave them.
pub fn meeting_bodies(conn: &Connection, paths: &[String]) -> HashMap<String, DocBody> {
    let mut out = HashMap::new();
    for path in paths {
        let Some(id) = path.strip_prefix("meeting:") else { continue };
        let Ok(mut stmt) = conn.prepare(
            "SELECT l.start_ms, COALESCE(NULLIF(s.name, ''), l.speaker), l.text FROM meeting_lines l
             LEFT JOIN meeting_speakers s ON s.meeting_id = l.meeting_id AND s.key = l.speaker
             WHERE l.meeting_id = ?1 ORDER BY l.start_ms, l.seq",
        ) else {
            continue;
        };
        let lines: Vec<(i64, String, String)> =
            stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default();
        out.insert(path.clone(), DocBody { kind: Kind::Markdown, prose: true, text: transcript_markdown(&lines) });
    }
    out
}

/// The workspace's generated documentation pages (`doc:<id>`), labelled by the repository they
/// document. Pages still being written are left for the next refresh.
pub fn doc_stamps(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<DocStamp>> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.updated_at, d.title, COALESCE(p.name, '') FROM doc_pages d LEFT JOIN projects p ON p.id = d.project_id
         WHERE d.workspace_id = ?1 AND d.content != '' AND d.status != 'generating'",
    )?;
    let rows = stmt
        .query_map(params![workspace_id], |r| {
            let project: String = r.get(3)?;
            Ok(DocStamp {
                path: format!("doc:{}", r.get::<_, String>(0)?),
                version: r.get(1)?,
                private: false,
                title: r.get(2)?,
                label: if project.is_empty() { "workspace".to_string() } else { project },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn doc_bodies(conn: &Connection, paths: &[String]) -> HashMap<String, DocBody> {
    let ids: Vec<String> = paths.iter().filter_map(|p| p.strip_prefix("doc:")).map(str::to_string).collect();
    by_ids(conn, "SELECT id, content FROM doc_pages WHERE id IN", &ids, |r| {
        Ok((format!("doc:{}", r.get::<_, String>(0)?), DocBody { kind: Kind::Markdown, prose: true, text: r.get(1)? }))
    })
    .into_iter()
    .collect()
}

/// The workspace's story drafts (`story:<id>`), labelled by their set.
pub fn story_stamps(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<DocStamp>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.updated_at, s.title, b.title FROM story_drafts s JOIN story_batches b ON b.id = s.batch_id WHERE b.workspace_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![workspace_id], |r| {
            Ok(DocStamp { path: format!("story:{}", r.get::<_, String>(0)?), version: r.get(1)?, private: false, title: r.get(2)?, label: r.get(3)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// A story as Markdown: the narrative, the description, the criteria, the notes, and what the last
/// check against the code concluded.
pub fn story_markdown(narrative: &str, description: &str, criteria_json: &str, notes: &str, verify: &str, verify_summary: &str, key: &str) -> String {
    let mut out = String::new();
    for part in [narrative, description] {
        if !part.trim().is_empty() {
            out.push_str(part.trim());
            out.push_str("\n\n");
        }
    }
    let criteria: Vec<String> = serde_json::from_str(criteria_json).unwrap_or_default();
    if !criteria.is_empty() {
        out.push_str("## Acceptance criteria\n\n");
        for criterion in criteria {
            out.push_str(&format!("- {}\n", criterion.trim().replace('\n', "\n  ")));
        }
        out.push('\n');
    }
    if !notes.trim().is_empty() {
        out.push_str(&format!("## Notes\n\n{}\n\n", notes.trim()));
    }
    if !verify.is_empty() {
        out.push_str(&format!("Checked against the code: {verify}{}\n", if verify_summary.trim().is_empty() { String::new() } else { format!(" — {}", verify_summary.trim()) }));
    }
    if !key.is_empty() {
        out.push_str(&format!("Published as {key}\n"));
    }
    out.trim().to_string()
}

pub fn story_bodies(conn: &Connection, paths: &[String]) -> HashMap<String, DocBody> {
    let ids: Vec<String> = paths.iter().filter_map(|p| p.strip_prefix("story:")).map(str::to_string).collect();
    by_ids(
        conn,
        "SELECT id, narrative, description, acceptance_criteria, notes, verify_status, verify_summary,
                CASE WHEN work_item_key != '' THEN work_item_key WHEN work_item_id > 0 THEN '#' || work_item_id ELSE '' END
         FROM story_drafts WHERE id IN",
        &ids,
        |r| {
            let text = story_markdown(&r.get::<_, String>(1)?, &r.get::<_, String>(2)?, &r.get::<_, String>(3)?, &r.get::<_, String>(4)?, &r.get::<_, String>(5)?, &r.get::<_, String>(6)?, &r.get::<_, String>(7)?);
            Ok((format!("story:{}", r.get::<_, String>(0)?), DocBody { kind: Kind::Markdown, prose: true, text }))
        },
    )
    .into_iter()
    .collect()
}

fn text_of(value: &serde_json::Value, key: &str) -> String {
    match &value[key] {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// The findings of the latest review of every pull request of `project_id`, one document each
/// (`review:PR<n>/<finding id>`), labelled by the pull request. Stamps and bodies at once: the
/// findings arrive together in one JSON column, so there is nothing to save by reading them twice.
/// Versioned by the finding's own content, so a finding marked a false positive is re-read.
pub fn review_docs(conn: &Connection, project_id: &str) -> rusqlite::Result<(Vec<DocStamp>, HashMap<String, DocBody>)> {
    let mut stmt = conn.prepare(
        "SELECT r.pr_id, COALESCE(json_extract(r.meta, '$.pr_title'), ''), r.findings FROM review_runs r
         WHERE r.project_id = ?1
           AND r.created_at = (SELECT MAX(r2.created_at) FROM review_runs r2 WHERE r2.project_id = r.project_id AND r2.pr_id = r.pr_id)",
    )?;
    let runs: Vec<(i64, String, String)> = stmt.query_map(params![project_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    let (mut stamps, mut bodies) = (Vec::new(), HashMap::new());
    for (pr, pr_title, findings) in runs {
        let findings: Vec<serde_json::Value> = serde_json::from_str(&findings).unwrap_or_default();
        for (index, finding) in findings.iter().enumerate() {
            let id = Some(text_of(finding, "id")).filter(|id| !id.is_empty()).unwrap_or_else(|| format!("{}", index + 1));
            let path = format!("review:PR{pr}/{id}");
            let place = match (text_of(finding, "archivo"), text_of(finding, "lineas")) {
                (file, _) if file.is_empty() => String::new(),
                (file, lines) if lines.is_empty() => format!("File: {file}\n"),
                (file, lines) => format!("File: {file}:{lines}\n"),
            };
            let comment = text_of(finding, "comentario_md");
            let reason = text_of(finding, "motivo_descarte");
            let text = format!(
                "{} · {} · {} · state {}\n{place}{}{}",
                text_of(finding, "severity"),
                text_of(finding, "tipo"),
                text_of(finding, "categoria"),
                text_of(finding, "estado"),
                if reason.is_empty() { String::new() } else { format!("Dismissed: {reason}\n") },
                if comment.trim().is_empty() { format!("\n{}", text_of(finding, "subtitulo")) } else { format!("\n{}", comment.trim()) },
            );
            let version = format!("{:x}", Sha256::digest(finding.to_string().as_bytes()));
            let label = if pr_title.is_empty() { format!("PR #{pr}") } else { format!("PR #{pr} — {pr_title}") };
            stamps.push(DocStamp { path: path.clone(), version, private: false, title: text_of(finding, "subtitulo"), label });
            bodies.insert(path, DocBody { kind: Kind::Markdown, prose: true, text });
        }
    }
    Ok((stamps, bodies))
}

/// The last [`COMMITS_KEPT`] commits reachable from `root`'s HEAD (`commit:<sha 12>`), and the HEAD
/// itself. `None` for a folder that is not a repository, or one with no commit yet. Lexical only:
/// commit messages are many, short, and asked about by their exact words.
pub fn commit_docs(root: &Path, label: &str) -> Option<(String, Vec<DocStamp>, HashMap<String, DocBody>)> {
    let repo = git2::Repository::open(root).ok()?;
    let head = repo.head().ok()?.peel_to_commit().ok()?;
    let mut walk = repo.revwalk().ok()?;
    walk.push(head.id()).ok()?;
    let _ = walk.set_sorting(git2::Sort::TIME);
    let (mut stamps, mut bodies) = (Vec::new(), HashMap::new());
    for oid in walk.flatten().take(COMMITS_KEPT) {
        let Ok(commit) = repo.find_commit(oid) else { continue };
        let sha = oid.to_string();
        let path = format!("commit:{}", &sha[..12]);
        let when = chrono::DateTime::from_timestamp(commit.time().seconds(), 0).map(|t| t.format("%Y-%m-%d").to_string()).unwrap_or_default();
        let author = commit.author().name().unwrap_or_default().to_string();
        let message = commit.message().unwrap_or_default().trim().to_string();
        stamps.push(DocStamp { path: path.clone(), version: sha, private: false, title: commit.summary().unwrap_or_default().to_string(), label: label.to_string() });
        bodies.insert(path, DocBody { kind: Kind::Text, prose: false, text: format!("{message}\n\n{author} · {when}") });
    }
    Some((head.id().to_string(), stamps, bodies))
}

/// The commit `root` is at now, `None` outside a repository.
pub fn head_of(root: &Path) -> Option<String> {
    let repo = git2::Repository::open(root).ok()?;
    let head = repo.head().ok()?.peel_to_commit().ok()?;
    Some(head.id().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transcript_reads_as_sections_of_minutes_with_named_speakers() {
        let lines = vec![
            (5_000, "Ana".to_string(), "Hola a todos".to_string()),
            (65_000, "p1".to_string(), " propongo CQRS ".to_string()),
            (190_000, "Ana".to_string(), "De acuerdo".to_string()),
        ];
        let text = transcript_markdown(&lines);
        assert_eq!(text, "## 00:00:00\n\nAna: Hola a todos\np1: propongo CQRS\n\n## 00:03:00\n\nAna: De acuerdo\n");
    }

    #[test]
    fn a_story_reads_as_its_parts() {
        let text = story_markdown("Como cajero, quiero…", "", r#"["Dado X\nCuando Y","Entonces Z"]"#, "", "pass", "todo cubierto", "PROJ-7");
        assert!(text.starts_with("Como cajero"));
        assert!(text.contains("## Acceptance criteria\n\n- Dado X\n  Cuando Y\n- Entonces Z"));
        assert!(text.contains("Checked against the code: pass — todo cubierto"));
        assert!(text.ends_with("Published as PROJ-7"));
    }
}
