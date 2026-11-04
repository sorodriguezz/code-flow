//! Artifacts: the named deliverables a chat answer carries — a page, a document, a diagram, a
//! component — written as a fenced `artefacto` block and kept here, versioned by name, so the bubble
//! can draw them as a card and any other chat of the workspace can cite them (`@artefacto:<name>`).
//!
//! The block (told to every engine by [`ARTIFACT_RULES`], mirrored by `src/lib/chatArtifacts.ts`):
//!
//! ````text
//! ````artefacto {"name": "informe-api", "type": "markdown", "title": "Informe de la API"}
//! …content, which may hold its own ``` fences…
//! ````
//! ````
//!
//! Extracted on the backend when an answer is filed, so no window has to remember to save it.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Appended to `ai::chat_turn_rules`: how to hand over a deliverable. Every engine reads it — it is
/// a format, not a tool.
pub const ARTIFACT_RULES: &str = "\n\n[CodeFlow] Cuando entregues algo autocontenido para conservar \
     (una página HTML, un documento, un diagrama Mermaid, un SVG, un componente o script completo de más de \
     ~20 líneas), ponlo en un artefacto: una cerca de CUATRO comillas invertidas con la palabra artefacto y \
     una cabecera JSON en la misma línea, el contenido, y la cerca de cierre:\n\
     ````artefacto {\"name\": \"nombre-corto\", \"type\": \"html|markdown|mermaid|svg|code\", \"title\": \"…\", \"language\": \"ts\"}\n\
     …\n````\n\
     Repetir un name crea una versión nueva de ese artefacto. No lo uses para fragmentos cortos ni \
     explicaciones: esos van como siempre.";

/// One block found in an answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedArtifact {
    pub name: String,
    pub title: String,
    /// `html` · `markdown` · `mermaid` · `svg` · `code`.
    pub kind: String,
    pub language: String,
    pub content: String,
}

/// A stored version, without its content — what lists show.
#[derive(Debug, Clone, Serialize)]
pub struct ArtifactSummary {
    pub id: String,
    pub workspace_id: String,
    /// `panel` (repo chat) · `ws` (workspace chat) · `chat` (the Chat app).
    pub surface: String,
    pub conversation_id: String,
    pub project_id: Option<String>,
    pub message_id: String,
    pub name: String,
    pub title: String,
    pub kind: String,
    pub language: String,
    pub version: i64,
    /// How many versions the name has (on a latest-per-name listing).
    pub versions: i64,
    pub size: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Artifact {
    #[serde(flatten)]
    pub summary: ArtifactSummary,
    pub content: String,
}

/// Where an answer was filed — what its artifacts are stamped with.
pub struct Origin<'a> {
    pub workspace_id: &'a str,
    pub surface: &'a str,
    pub conversation_id: &'a str,
    pub project_id: Option<&'a str>,
    pub message_id: &'a str,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_artifacts (
            id              TEXT PRIMARY KEY,
            workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            surface         TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
            message_id      TEXT NOT NULL DEFAULT '',
            name            TEXT NOT NULL,
            title           TEXT NOT NULL DEFAULT '',
            kind            TEXT NOT NULL,
            language        TEXT NOT NULL DEFAULT '',
            content         TEXT NOT NULL,
            version         INTEGER NOT NULL,
            created_at      TEXT NOT NULL,
            UNIQUE (workspace_id, name, version)
         );
         CREATE INDEX IF NOT EXISTS idx_chat_artifacts_conv ON chat_artifacts(conversation_id);
         CREATE INDEX IF NOT EXISTS idx_chat_artifacts_ws ON chat_artifacts(workspace_id, name);",
    )
}

/// `informe API v2` → `informe-api-v2`. Never empty: `artefacto` when nothing usable is left.
pub fn slug(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.trim().to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            other => other,
        };
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_matches(|c| c == '-' || c == '.').chars().take(60).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "artefacto".to_string() } else { out }
}

/// What a `type` says, as one of the five kinds — and the language it implies when it named one.
fn kind_of(raw: &str) -> (&'static str, String) {
    match raw.trim().to_lowercase().as_str() {
        "html" | "htm" | "page" | "pagina" | "página" => ("html", String::new()),
        "markdown" | "md" | "document" | "documento" | "doc" | "text" | "texto" => ("markdown", String::new()),
        "mermaid" | "diagram" | "diagrama" => ("mermaid", String::new()),
        "svg" => ("svg", String::new()),
        "" | "code" | "codigo" | "código" | "script" | "component" | "componente" => ("code", String::new()),
        other => ("code", other.to_string()),
    }
}

/// The run of one fence character a line opens with (up to three spaces of indent): its char,
/// its length and what follows it.
fn fence(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let c = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = rest.chars().take_while(|x| *x == c).count();
    (n >= 3).then(|| (c, n, &rest[n..]))
}

/// The header after the word: JSON, or `key="value"` pairs as a fallback.
fn header(raw: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(raw) {
        return Some(map);
    }
    let mut map = serde_json::Map::new();
    let mut rest = raw;
    while let Some(eq) = rest.find('=') {
        let key = rest[..eq].trim().trim_start_matches(',').trim().to_string();
        let after = rest[eq + 1..].trim_start();
        let (value, tail) = if let Some(stripped) = after.strip_prefix('"') {
            match stripped.find('"') {
                Some(end) => (&stripped[..end], &stripped[end + 1..]),
                None => (stripped, ""),
            }
        } else {
            let end = after.find(char::is_whitespace).unwrap_or(after.len());
            (&after[..end], &after[end..])
        };
        if !key.is_empty() {
            map.insert(key, serde_json::Value::String(value.to_string()));
        }
        rest = tail;
    }
    (!map.is_empty()).then_some(map)
}

fn field(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| map.get(*k).and_then(|v| v.as_str()).map(|s| s.trim().to_string()))
        .unwrap_or_default()
}

/// Every artifact block in `text`, in order.
///
/// The closing fence is a bare line of the opening character at least as long as the opener. A
/// line of the same character that long *with* an info string opens a nested block, whose bare
/// closer is then not the artifact's — so a Markdown artifact a model fenced with three backticks
/// still keeps its own code blocks. A block left open runs to the end of the answer.
pub fn parse(text: &str) -> Vec<ParsedArtifact> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some((c, n, rest)) = fence(lines[i]) else {
            i += 1;
            continue;
        };
        let info = rest.trim_start();
        let lower = info.to_lowercase();
        let word = ["artefacto", "artifact"].into_iter().find(|w| {
            lower.starts_with(w) && lower[w.len()..].chars().next().is_none_or(|x| x.is_whitespace() || x == '{')
        });
        let Some(word) = word else {
            // An ordinary fence: skip over it whole, so an artifact block quoted inside one stays a quote.
            let mut j = i + 1;
            while j < lines.len() {
                if let Some((c2, n2, r2)) = fence(lines[j]) {
                    if c2 == c && n2 >= n && r2.trim().is_empty() {
                        break;
                    }
                }
                j += 1;
            }
            i = j + 1;
            continue;
        };
        let mut start = i + 1;
        let mut meta = header(&info[word.len()..]);
        if meta.is_none() {
            if let Some(next) = lines.get(start) {
                if next.trim_start().starts_with('{') {
                    if let Some(found) = header(next) {
                        meta = Some(found);
                        start += 1;
                    }
                }
            }
        }
        let meta = meta.unwrap_or_default();
        let mut depth = 0usize;
        let mut end = lines.len();
        let mut j = start;
        while j < lines.len() {
            if let Some((c2, n2, r2)) = fence(lines[j]) {
                if c2 == c && n2 >= n {
                    if r2.trim().is_empty() {
                        if depth == 0 {
                            end = j;
                            break;
                        }
                        depth -= 1;
                    } else {
                        depth += 1;
                    }
                }
            }
            j += 1;
        }
        let content = lines[start..end.min(lines.len())].join("\n");
        let title = field(&meta, &["title", "titulo", "título"]);
        let named = field(&meta, &["name", "nombre", "id"]);
        let (kind, implied) = kind_of(&field(&meta, &["type", "tipo", "kind"]));
        let language = {
            let given = field(&meta, &["language", "lenguaje", "lang"]);
            if given.is_empty() { implied } else { given.to_lowercase() }
        };
        let name = slug(if !named.is_empty() { &named } else if !title.is_empty() { &title } else { "" });
        if !content.trim().is_empty() {
            out.push(ParsedArtifact { name, title, kind: kind.to_string(), language, content });
        }
        i = end + 1;
    }
    out
}

const SUMMARY_COLUMNS: &str =
    "id, workspace_id, surface, conversation_id, project_id, message_id, name, title, kind, language, version, length(content), created_at";

fn map_summary(row: &rusqlite::Row) -> rusqlite::Result<ArtifactSummary> {
    Ok(ArtifactSummary {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        surface: row.get(2)?,
        conversation_id: row.get(3)?,
        project_id: row.get(4)?,
        message_id: row.get(5)?,
        name: row.get(6)?,
        title: row.get(7)?,
        kind: row.get(8)?,
        language: row.get(9)?,
        version: row.get(10)?,
        versions: 1,
        size: row.get(11)?,
        created_at: row.get(12)?,
    })
}

/// Files the artifacts of one answer: a name seen before gets the next version, unless its newest
/// version already holds the same content (an answer stored twice, a regenerated one that said the
/// same). Returns what was filed.
pub fn store(conn: &Connection, origin: &Origin, found: &[ParsedArtifact]) -> rusqlite::Result<Vec<ArtifactSummary>> {
    let mut filed = Vec::new();
    for artifact in found {
        let latest: Option<(i64, String)> = conn
            .query_row(
                "SELECT version, content FROM chat_artifacts WHERE workspace_id = ?1 AND name = ?2 ORDER BY version DESC LIMIT 1",
                params![origin.workspace_id, artifact.name],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if latest.as_ref().is_some_and(|(_, content)| content == &artifact.content) {
            continue;
        }
        let version = latest.map_or(1, |(v, _)| v + 1);
        let id = uuid::Uuid::new_v4().to_string();
        let at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO chat_artifacts (id, workspace_id, surface, conversation_id, project_id, message_id, name, title, kind, language, content, version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                origin.workspace_id,
                origin.surface,
                origin.conversation_id,
                origin.project_id,
                origin.message_id,
                artifact.name,
                artifact.title,
                artifact.kind,
                artifact.language,
                artifact.content,
                version,
                at
            ],
        )?;
        filed.push(get_by_id(conn, &id)?.map(|a| a.summary).ok_or(rusqlite::Error::QueryReturnedNoRows)?);
    }
    Ok(filed)
}

/// [`parse`] then [`store`] — what both chats call on an answer they just filed. Errors are the
/// caller's to ignore: an artifact that failed to file must not cost the user the answer.
pub fn file_answer(conn: &Connection, origin: &Origin, answer: &str) -> rusqlite::Result<Vec<ArtifactSummary>> {
    let found = parse(answer);
    if found.is_empty() {
        return Ok(Vec::new());
    }
    store(conn, origin, &found)
}

pub fn get_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Artifact>> {
    conn.query_row(
        &format!("SELECT {SUMMARY_COLUMNS}, content FROM chat_artifacts WHERE id = ?1"),
        params![id],
        |row| Ok(Artifact { summary: map_summary(row)?, content: row.get(13)? }),
    )
    .optional()
}

/// A name's version (`None` = newest) in a workspace.
pub fn get(conn: &Connection, workspace_id: &str, name: &str, version: Option<i64>) -> rusqlite::Result<Option<Artifact>> {
    let name = slug(name);
    let sql = format!(
        "SELECT {SUMMARY_COLUMNS}, content FROM chat_artifacts WHERE workspace_id = ?1 AND name = ?2 {} ORDER BY version DESC LIMIT 1",
        if version.is_some() { "AND version = ?3" } else { "AND ?3 IS NULL" }
    );
    let found = conn
        .query_row(&sql, params![workspace_id, name, version], |row| Ok(Artifact { summary: map_summary(row)?, content: row.get(13)? }))
        .optional()?;
    Ok(match found {
        Some(mut a) => {
            a.summary.versions = count_versions(conn, workspace_id, &a.summary.name)?;
            Some(a)
        }
        None => None,
    })
}

fn count_versions(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM chat_artifacts WHERE workspace_id = ?1 AND name = ?2", params![workspace_id, name], |row| row.get(0))
}

/// Every version of a name, newest first, with content.
pub fn versions(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<Vec<Artifact>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SUMMARY_COLUMNS}, content FROM chat_artifacts WHERE workspace_id = ?1 AND name = ?2 ORDER BY version DESC"
    ))?;
    let rows = stmt.query_map(params![workspace_id, slug(name)], |row| Ok(Artifact { summary: map_summary(row)?, content: row.get(13)? }))?;
    let mut list: Vec<Artifact> = rows.collect::<rusqlite::Result<_>>()?;
    let n = list.len() as i64;
    for a in &mut list {
        a.summary.versions = n;
    }
    Ok(list)
}

/// The newest version of each name — of one conversation, or of the whole workspace.
pub fn list(conn: &Connection, workspace_id: &str, conversation_id: Option<&str>) -> rusqlite::Result<Vec<ArtifactSummary>> {
    let sql = format!(
        "SELECT {SUMMARY_COLUMNS}, (SELECT COUNT(*) FROM chat_artifacts b WHERE b.workspace_id = a.workspace_id AND b.name = a.name)
         FROM chat_artifacts a
         WHERE a.workspace_id = ?1
           AND a.version = (SELECT MAX(version) FROM chat_artifacts c WHERE c.workspace_id = a.workspace_id AND c.name = a.name {})
           {}
         ORDER BY a.created_at DESC",
        if conversation_id.is_some() { "AND c.conversation_id = ?2" } else { "" },
        if conversation_id.is_some() { "AND a.conversation_id = ?2" } else { "" },
    );
    let mut stmt = conn.prepare(&sql)?;
    let map = |row: &rusqlite::Row| {
        let mut s = map_summary(row)?;
        s.versions = row.get(13)?;
        Ok(s)
    };
    let rows = match conversation_id {
        Some(id) => stmt.query_map(params![workspace_id, id], map)?.collect(),
        None => stmt.query_map(params![workspace_id], map)?.collect(),
    };
    rows
}

/// Removes every version of a name.
pub fn delete(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM chat_artifacts WHERE workspace_id = ?1 AND name = ?2", params![workspace_id, slug(name)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_backticks_keep_inner_fences() {
        let text = "Aquí va:\n\n````artefacto {\"name\": \"Guía API\", \"type\": \"markdown\", \"title\": \"Guía\"}\n# Guía\n```ts\nconst a = 1;\n```\nfin\n````\n\nListo.";
        let found = parse(text);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "guia-api");
        assert_eq!(found[0].kind, "markdown");
        assert_eq!(found[0].content, "# Guía\n```ts\nconst a = 1;\n```\nfin");
    }

    #[test]
    fn three_backticks_still_nest_by_info_string() {
        let text = "```artefacto {\"name\":\"doc\",\"type\":\"md\"}\nintro\n```bash\nls\n```\nmore\n```\nafter";
        let found = parse(text);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].content, "intro\n```bash\nls\n```\nmore");
    }

    #[test]
    fn header_on_next_line_pairs_and_language_as_type() {
        let text = "````artifact\n{\"name\": \"x\", \"type\": \"tsx\"}\nexport const X = 1;\n````\n````artefacto name=\"pagina\" type=\"html\"\n<p>hi</p>\n````";
        let found = parse(text);
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].kind.as_str(), found[0].language.as_str()), ("code", "tsx"));
        assert_eq!(found[1].name, "pagina");
        assert_eq!(found[1].kind, "html");
    }

    #[test]
    fn ordinary_fences_and_quoted_blocks_are_not_artifacts() {
        let text = "````md\n````artefacto {\"name\":\"q\"}\nx\n````\n````\n```js\nx\n```";
        assert!(parse(text).is_empty());
    }

    #[test]
    fn unclosed_block_runs_to_the_end_and_empty_is_dropped() {
        assert_eq!(parse("````artefacto {\"name\":\"a\"}\nline").len(), 1);
        assert!(parse("````artefacto {\"name\":\"a\"}\n\n````").is_empty());
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY);
             INSERT INTO workspaces VALUES ('w');",
        )
        .unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn names_version_and_identical_content_is_not_a_version() {
        let conn = db();
        let origin = Origin { workspace_id: "w", surface: "panel", conversation_id: "c1", project_id: None, message_id: "m1" };
        let one = file_answer(&conn, &origin, "````artefacto {\"name\":\"plan\"}\nv1\n````").unwrap();
        assert_eq!(one[0].version, 1);
        assert!(file_answer(&conn, &origin, "````artefacto {\"name\":\"plan\"}\nv1\n````").unwrap().is_empty());
        let other = Origin { conversation_id: "c2", message_id: "m2", ..origin };
        let two = file_answer(&conn, &other, "````artefacto {\"name\":\"plan\"}\nv2\n````").unwrap();
        assert_eq!(two[0].version, 2);
        assert_eq!(get(&conn, "w", "Plan", None).unwrap().unwrap().content, "v2");
        assert_eq!(get(&conn, "w", "plan", Some(1)).unwrap().unwrap().content, "v1");
        assert_eq!(versions(&conn, "w", "plan").unwrap().len(), 2);
        let all = list(&conn, "w", None).unwrap();
        assert_eq!((all.len(), all[0].version, all[0].versions), (1, 2, 2));
        let of_first = list(&conn, "w", Some("c1")).unwrap();
        assert_eq!((of_first.len(), of_first[0].version), (1, 1));
        assert_eq!(delete(&conn, "w", "plan").unwrap(), 2);
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("  Informe de la API v2! "), "informe-de-la-api-v2");
        assert_eq!(slug("¿?"), "artefacto");
        assert_eq!(slug("ñandú.md"), "nandu.md");
    }
}
