//! CRUD over `diagrams` and `diagram_folders` — the Diagrams workspace.
//!
//! The sibling of [`super::note_queries`], and close enough to it that the differences are worth
//! stating up front. Everything else in this file is that module with the nouns changed.
//!
//! **The tree never carries documents — nor pictures.** [`load_tree`] projects [`DiagramMeta`],
//! which is every column of `diagrams` except `doc` and `thumbnail`. Documents arrive one at a time
//! through [`get_diagram`]; thumbnails arrive in batches through [`load_thumbnails`], for the cards
//! actually being drawn. A workspace of two hundred diagrams is tens of megabytes of XML and
//! several more of PNG, and the explorer draws titles. This is the same rule the notes module opens
//! with, one order of magnitude further down.
//!
//! **The root is a real place.** A note is forced into a book; a diagram is not. `folder_id` may be
//! null, and that is where a diagram created from the gallery lands — filing is a decision worth
//! postponing until after the thing exists. Every query below that scopes by folder therefore uses
//! `IS` rather than `=`, so the root behaves like any other container.
//!
//! **`doc` is opaque here, and `format` says what it is.** Nothing in this file parses a document
//! except [`derive`], which counts shapes and switches on the format to do it. That is deliberate:
//! which editor writes these rows is a decision above this layer, and it must stay one.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    DiagramFolderRow, DiagramMeta, DiagramRow, DiagramTemplateRow, DiagramThumbnail,
    DiagramsWorkspaceTree,
};
use super::queries::now;

/// Every column *except* `doc` **and `thumbnail`**. See the module comment for both exclusions.
const DIAGRAM_META_COLUMNS: &str = "id, workspace_id, folder_id, title, format, tags, \
                                    pinned, shape_count, sort_order, created_at, updated_at";
const DIAGRAM_COLUMNS: &str = "id, workspace_id, folder_id, title, doc, format, thumbnail, tags, \
                               pinned, shape_count, sort_order, created_at, updated_at";
const FOLDER_COLUMNS: &str =
    "id, workspace_id, parent_id, name, color, sort_order, created_at, updated_at";
const TEMPLATE_COLUMNS: &str = "id, workspace_id, name, description, icon, doc, format, tags, \
                                sort_order, created_at, updated_at";

/// The dialect an embedded draw.io reads and writes. The only one [`derive`] knows how to count.
const FORMAT_MXGRAPH: &str = "mxgraph";
/// The schema dialect. Mirrors `FORMAT_DBML` in `lib/diagrams/doc.ts`.
const FORMAT_DBML: &str = "dbml";

fn map_folder(row: &rusqlite::Row) -> rusqlite::Result<DiagramFolderRow> {
    Ok(DiagramFolderRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        parent_id: row.get(2)?,
        name: row.get(3)?,
        color: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn map_meta(row: &rusqlite::Row) -> rusqlite::Result<DiagramMeta> {
    Ok(DiagramMeta {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        folder_id: row.get(2)?,
        title: row.get(3)?,
        format: row.get(4)?,
        tags: row.get(5)?,
        pinned: row.get(6)?,
        shape_count: row.get(7)?,
        sort_order: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn map_diagram(row: &rusqlite::Row) -> rusqlite::Result<DiagramRow> {
    Ok(DiagramRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        folder_id: row.get(2)?,
        title: row.get(3)?,
        doc: row.get(4)?,
        format: row.get(5)?,
        thumbnail: row.get(6)?,
        tags: row.get(7)?,
        pinned: row.get(8)?,
        shape_count: row.get(9)?,
        sort_order: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn map_template(row: &rusqlite::Row) -> rusqlite::Result<DiagramTemplateRow> {
    Ok(DiagramTemplateRow {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        icon: row.get(4)?,
        doc: row.get(5)?,
        format: row.get(6)?,
        tags: row.get(7)?,
        sort_order: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

// ---------------------------------------------------------------------------
// Derived columns
// ---------------------------------------------------------------------------

/// How many shapes a document holds: vertices plus edges.
///
/// The counterpart of `note_queries::derive`, and it exists for the same reason — it is what a list
/// wants from a document it is not allowed to read. Whatever writes `doc` rewrites this, or the
/// gallery shows a count that stopped being true.
///
/// **Counted by substring, not by parsing.** An mxGraph document marks its cells with `vertex="1"`
/// and `edge="1"`, and a DBML one opens a block with `Table` or `Enum` at the start of a line and
/// declares a relationship with `Ref:` or an inline `ref:`. This layer has no business holding
/// either an XML parser or a DBML one for a single integer. A format it does not recognise counts
/// zero rather than guessing — a wrong number in a caption is worse than none, and the gallery
/// hides the caption when the count is zero.
fn derive(doc: &str, format: &str) -> i64 {
    match format {
        FORMAT_MXGRAPH => {
            (doc.matches("vertex=\"1\"").count() + doc.matches("edge=\"1\"").count()) as i64
        }
        FORMAT_DBML => count_dbml(doc),
        _ => 0,
    }
}

/// Tables, enums and relationships in a DBML document.
///
/// Line-oriented, and deliberately so: a `Table` inside a note or a comment is text, not a table,
/// and anchoring on the start of the line is what tells the two apart without parsing. Inline
/// `[ref: > …]` counts as well as a standalone `Ref:`, because both are one relationship — that is
/// exactly what the frontend draws.
fn count_dbml(doc: &str) -> i64 {
    let mut count = 0usize;
    for line in doc.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("table ")
            || lower.starts_with("enum ")
            || lower.starts_with("ref:")
            || lower.starts_with("ref ")
        {
            count += 1;
        } else if lower.contains("ref:") {
            // An inline reference in a column's settings — `author_id integer [ref: > users.id]`.
            count += 1;
        }
    }
    count as i64
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/// Everything the workspace needs to draw its tree and its gallery, in one round trip. No documents.
pub fn load_tree(conn: &Connection, workspace_id: &str) -> rusqlite::Result<DiagramsWorkspaceTree> {
    let mut folder_stmt = conn.prepare(&format!(
        "SELECT {FOLDER_COLUMNS} FROM diagram_folders WHERE workspace_id = ?1 \
         ORDER BY sort_order, name"
    ))?;
    let folders = folder_stmt
        .query_map(params![workspace_id], map_folder)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut diagram_stmt = conn.prepare(&format!(
        "SELECT {DIAGRAM_META_COLUMNS} FROM diagrams WHERE workspace_id = ?1 \
         ORDER BY sort_order, title"
    ))?;
    let diagrams = diagram_stmt
        .query_map(params![workspace_id], map_meta)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut template_stmt = conn.prepare(&format!(
        "SELECT {TEMPLATE_COLUMNS} FROM diagram_templates WHERE workspace_id = ?1 \
         ORDER BY sort_order, name"
    ))?;
    let templates = template_stmt
        .query_map(params![workspace_id], map_template)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(DiagramsWorkspaceTree { diagrams, folders, templates })
}

/// One diagram's document. The only call in this module that returns `doc`; see the module comment.
pub fn get_diagram(conn: &Connection, id: &str) -> rusqlite::Result<Option<DiagramRow>> {
    conn.query_row(
        &format!("SELECT {DIAGRAM_COLUMNS} FROM diagrams WHERE id = ?1"),
        params![id],
        map_diagram,
    )
    .optional()
}

/// The pictures of the diagrams named in `ids`, and only those.
///
/// The gallery's half of the metadata split: it draws cards for what is on screen and asks for
/// those thumbnails, rather than every diagram in the workspace shipping its picture with the tree.
/// See [`DiagramThumbnail`].
///
/// The ids are interpolated as a bound-parameter list rather than as text — `ids` reaches this from
/// the frontend, and a `format!` of user-supplied strings into SQL is the one mistake this file
/// must not contain.
pub fn load_thumbnails(conn: &Connection, ids: &[String]) -> rusqlite::Result<Vec<DiagramThumbnail>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
    let mut stmt = conn.prepare(&format!(
        "SELECT id, thumbnail FROM diagrams WHERE id IN ({placeholders}) AND thumbnail <> ''"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |row| {
        Ok(DiagramThumbnail { id: row.get(0)?, thumbnail: row.get(1)? })
    })?;
    rows.collect()
}

/// The metadata of one diagram, for the write paths to answer with.
///
/// `None` is not an error: the row can be gone because another window deleted it while this one was
/// dragging or renaming. Every mutation below returns this shape so the frontend can drop the row
/// from its list instead of showing a toast for something the user did not do wrong.
fn meta_of(conn: &Connection, id: &str) -> rusqlite::Result<Option<DiagramMeta>> {
    conn.query_row(
        &format!("SELECT {DIAGRAM_META_COLUMNS} FROM diagrams WHERE id = ?1"),
        params![id],
        map_meta,
    )
    .optional()
}

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

/// Appends a diagram to `folder_id` — or to the root, which `None` means.
pub fn create_diagram(
    conn: &Connection,
    workspace_id: &str,
    folder_id: Option<&str>,
    title: &str,
    doc: &str,
    format: &str,
    tags: &str,
) -> rusqlite::Result<DiagramMeta> {
    let id = Uuid::new_v4().to_string();
    let stamp = now();
    // Positions are per container, so the new row takes the end of *its* list rather than of the
    // workspace's. `IS` and not `=`, so the root counts as a container like any other.
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM diagrams \
         WHERE workspace_id = ?1 AND folder_id IS ?2",
        params![workspace_id, folder_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO diagrams \
         (id, workspace_id, folder_id, title, doc, format, thumbnail, tags, pinned, shape_count, \
          sort_order, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, 0, ?8, ?9, ?10, ?10)",
        params![
            id,
            workspace_id,
            folder_id,
            title,
            doc,
            format,
            tags,
            derive(doc, format),
            sort_order,
            stamp
        ],
    )?;

    // Read back rather than assembled here: the row is the truth, and a hand-built struct is how
    // the two drift the day a column gains a default.
    meta_of(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Writes a diagram's document, and everything derived from it.
///
/// The autosave path for whatever editor is mounted. `None` means the diagram was deleted while it
/// was open — see [`meta_of`].
pub fn save_diagram(
    conn: &Connection,
    id: &str,
    doc: &str,
    format: &str,
    thumbnail: &str,
) -> rusqlite::Result<Option<DiagramMeta>> {
    let changed = conn.execute(
        "UPDATE diagrams SET doc = ?2, format = ?3, thumbnail = ?4, shape_count = ?5, \
         updated_at = ?6 WHERE id = ?1",
        params![id, doc, format, thumbnail, derive(doc, format), now()],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    meta_of(conn, id)
}

/// Renames a diagram. Blank titles are the caller's to reject — see `diagrams_cmd`.
pub fn rename_diagram(
    conn: &Connection,
    id: &str,
    title: &str,
) -> rusqlite::Result<Option<DiagramMeta>> {
    conn.execute(
        "UPDATE diagrams SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now()],
    )?;
    meta_of(conn, id)
}

/// Replaces a diagram's tags wholesale. `tags` is a JSON array, verbatim as the frontend built it.
pub fn set_diagram_tags(
    conn: &Connection,
    id: &str,
    tags: &str,
) -> rusqlite::Result<Option<DiagramMeta>> {
    conn.execute(
        "UPDATE diagrams SET tags = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, tags, now()],
    )?;
    meta_of(conn, id)
}

/// Refiles a diagram into another folder — or out of every folder, which `None` means.
///
/// The row lands at the end of its new container, because a drop that files and a drop that orders
/// are two different gestures (see `diagramsDragStore`): a drag that crossed folders calls this,
/// and then [`reorder_diagrams`] writes the positions against the list it has already joined.
pub fn move_diagram(
    conn: &Connection,
    id: &str,
    folder_id: Option<&str>,
) -> rusqlite::Result<Option<DiagramMeta>> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM diagrams \
         WHERE workspace_id = (SELECT workspace_id FROM diagrams WHERE id = ?1) \
           AND folder_id IS ?2",
        params![id, folder_id],
        |row| row.get(0),
    )?;
    let changed = conn.execute(
        "UPDATE diagrams SET folder_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, folder_id, sort_order, now()],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    meta_of(conn, id)
}

/// Writes one container's diagram order — `ids` is that container's whole list, as arranged.
pub fn reorder_diagrams(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE diagrams SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    tx.commit()
}

pub fn set_diagram_pinned(conn: &Connection, id: &str, pinned: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE diagrams SET pinned = ?2 WHERE id = ?1",
        params![id, pinned],
    )?;
    Ok(())
}

pub fn delete_diagram(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM diagrams WHERE id = ?1", params![id])?;
    Ok(())
}

/// Copies a diagram, document and all, into the same folder.
///
/// `title` comes from the caller because "Copy of …" is translated and Rust has no language — the
/// same reason `note_queries::duplicate_note` takes one.
pub fn duplicate_diagram(
    conn: &Connection,
    id: &str,
    title: &str,
) -> rusqlite::Result<Option<DiagramMeta>> {
    let Some(source) = get_diagram(conn, id)? else {
        return Ok(None);
    };
    let copy = create_diagram(
        conn,
        &source.workspace_id,
        source.folder_id.as_deref(),
        title,
        &source.doc,
        &source.format,
        &source.tags,
    )?;
    // Carried over separately: `create_diagram` writes an empty thumbnail because a new diagram has
    // no picture yet, but a copy of a drawn one does — and the gallery would otherwise show the
    // duplicate as a blank card until it was next opened and saved.
    if !source.thumbnail.is_empty() {
        conn.execute(
            "UPDATE diagrams SET thumbnail = ?2 WHERE id = ?1",
            params![copy.id, source.thumbnail],
        )?;
    }
    meta_of(conn, &copy.id)
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

pub fn create_folder(
    conn: &Connection,
    workspace_id: &str,
    parent_id: Option<&str>,
    name: &str,
    color: &str,
) -> rusqlite::Result<DiagramFolderRow> {
    let id = Uuid::new_v4().to_string();
    let stamp = now();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM diagram_folders \
         WHERE workspace_id = ?1 AND parent_id IS ?2",
        params![workspace_id, parent_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO diagram_folders \
         (id, workspace_id, parent_id, name, color, sort_order, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, workspace_id, parent_id, name, color, sort_order, stamp],
    )?;

    conn.query_row(
        &format!("SELECT {FOLDER_COLUMNS} FROM diagram_folders WHERE id = ?1"),
        params![id],
        map_folder,
    )
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE diagram_folders SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, now()],
    )?;
    Ok(())
}

pub fn set_folder_color(conn: &Connection, id: &str, color: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE diagram_folders SET color = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, color, now()],
    )?;
    Ok(())
}

/// Whether `folder_id` is `ancestor_id` or sits somewhere beneath it.
///
/// The guard [`move_folder`] needs, and the reason it is a recursive query rather than a walk in
/// the frontend: the frontend's tree is a snapshot, and the check has to hold against the database
/// as it is at the moment of the write.
fn is_within(conn: &Connection, folder_id: &str, ancestor_id: &str) -> rusqlite::Result<bool> {
    let depth: i64 = conn.query_row(
        "WITH RECURSIVE ancestry(id) AS ( \
             SELECT ?1 \
             UNION ALL \
             SELECT folder.parent_id FROM diagram_folders folder JOIN ancestry \
                 ON folder.id = ancestry.id \
             WHERE folder.parent_id IS NOT NULL \
         ) \
         SELECT COUNT(*) FROM ancestry WHERE id = ?2",
        params![folder_id, ancestor_id],
        |row| row.get(0),
    )?;
    Ok(depth > 0)
}

/// Reparents a folder. `false` means the drop was refused because it would have put the folder
/// inside its own subtree — an ordinary consequence of a stray drag, not a fault to raise on.
pub fn move_folder(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
) -> rusqlite::Result<bool> {
    if let Some(parent) = parent_id {
        if parent == id || is_within(conn, parent, id)? {
            return Ok(false);
        }
    }
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM diagram_folders \
         WHERE workspace_id = (SELECT workspace_id FROM diagram_folders WHERE id = ?1) \
           AND parent_id IS ?2",
        params![id, parent_id],
        |row| row.get(0),
    )?;
    conn.execute(
        "UPDATE diagram_folders SET parent_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, parent_id, sort_order, now()],
    )?;
    Ok(true)
}

/// The folders' half of [`reorder_diagrams`]: one parent's children, in their new order.
pub fn reorder_folders(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE diagram_folders SET sort_order = ?2 WHERE id = ?1",
            params![id, index as i64],
        )?;
    }
    tx.commit()
}

/// Removes the folder, its subfolders **and every diagram in them**. Confirm before calling.
///
/// The diagrams go first and explicitly, in the same transaction: `diagrams.folder_id` is
/// `ON DELETE SET NULL`, so leaving it to the constraint would empty the folder into the root
/// instead of deleting it — a pile of orphans the user did not ask to keep. The subfolders follow
/// through `diagram_folders.parent_id`'s own cascade.
pub fn delete_folder(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 \
             UNION ALL \
             SELECT folder.id FROM diagram_folders folder JOIN subtree \
                 ON folder.parent_id = subtree.id \
         ) \
         DELETE FROM diagrams WHERE folder_id IN (SELECT id FROM subtree)",
        params![id],
    )?;
    tx.execute("DELETE FROM diagram_folders WHERE id = ?1", params![id])?;
    tx.commit()
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/// Saves a template. Used by both callers — "save this diagram as a template" and the one-time
/// seeding of the shipped set — so there is one write rather than two shapes of the same one.
pub fn create_template(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
    description: &str,
    icon: &str,
    doc: &str,
    format: &str,
    tags: &str,
) -> rusqlite::Result<DiagramTemplateRow> {
    let id = Uuid::new_v4().to_string();
    let stamp = now();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM diagram_templates WHERE workspace_id = ?1",
        params![workspace_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO diagram_templates \
         (id, workspace_id, name, description, icon, doc, format, tags, sort_order, created_at, \
          updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![id, workspace_id, name, description, icon, doc, format, tags, sort_order, stamp],
    )?;

    conn.query_row(
        &format!("SELECT {TEMPLATE_COLUMNS} FROM diagram_templates WHERE id = ?1"),
        params![id],
        map_template,
    )
}

/// Rewrites a template from the row the caller edited. Everything but `id`, `workspace_id` and the
/// timestamps is the user's to change — including `doc`, which is how "update this template from
/// the diagram I just drew" works without a second command.
pub fn update_template(conn: &Connection, row: &DiagramTemplateRow) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE diagram_templates SET name = ?2, description = ?3, icon = ?4, doc = ?5, \
         format = ?6, tags = ?7, updated_at = ?8 WHERE id = ?1",
        params![
            row.id,
            row.name,
            row.description,
            row.icon,
            row.doc,
            row.format,
            row.tags,
            now()
        ],
    )?;
    Ok(())
}

pub fn delete_template(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM diagram_templates WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two workspaces, so the isolation below has something to fail against.
    fn workspaces() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Flow', 'workflow', '#111', 0, '2026-01-01T00:00:00+00:00'),
                        ('w2', 'Otro', 'workflow', '#222', 1, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
    }

    /// The caption under a gallery card, for both dialects.
    ///
    /// It matters more than a caption normally would because [`derive`] is what *writes*
    /// `shape_count`, on every save: a format whose count is wrong shows a wrong number on every
    /// card in the workspace, and a format that counts zero shows no caption at all — which is what
    /// a DBML diagram did before this branch existed.
    #[test]
    fn a_document_is_counted_in_its_own_dialect() {
        let drawing = r#"<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
            <mxCell id="a" vertex="1"/><mxCell id="b" vertex="1"/><mxCell id="e" edge="1"/>
            </root></mxGraphModel>"#;
        assert_eq!(derive(drawing, FORMAT_MXGRAPH), 3);

        let schema = "// a comment mentioning Table and Ref:\n\
             Table users {\n  id integer [pk]\n}\n\
             Table posts {\n  id integer [pk]\n  author_id integer [ref: > users.id]\n}\n\
             Enum role { admin }\n\
             Ref: posts.id > users.id\n";
        // Two tables, one enum, one inline reference and one standalone: five.
        assert_eq!(derive(schema, FORMAT_DBML), 5);

        // A document in neither dialect counts nothing rather than guessing — the gallery hides a
        // zero, and a wrong number is worse than none.
        assert_eq!(derive(drawing, "something-else"), 0);
        assert_eq!(derive("", FORMAT_DBML), 0);
    }

    /// Every read in this module is filtered by workspace, and this is the test that says so out
    /// loud.
    ///
    /// It is here because of the bug it does *not* catch, which is worth writing down: the backend
    /// has always scoped these reads correctly, and Diagrams still behaved as though it had not.
    /// The store that calls `load_tree` keeps its own `workspace_id` and sends it back on every
    /// write, and nothing was telling it the workspace had changed — so a board opened in `w1` went
    /// on showing `w1` while the user was in `w2`, and every drawing made there was filed into
    /// `w1`. The fix lives in `diagramsStore.ts`; this locks the half it leans on.
    #[test]
    fn a_workspace_sees_only_its_own_diagrams_folders_and_templates() {
        let conn = workspaces();

        let here = create_folder(&conn, "w1", None, "Aqui", "").unwrap();
        let there = create_folder(&conn, "w2", None, "Alla", "").unwrap();
        create_diagram(&conn, "w1", Some(&here.id), "Dibujo de w1", "<mxfile/>", "drawio", "[]")
            .unwrap();
        create_diagram(&conn, "w2", Some(&there.id), "Dibujo de w2", "<mxfile/>", "drawio", "[]")
            .unwrap();
        create_template(&conn, "w1", "Plantilla de w1", "", "workflow", "", "drawio", "[]").unwrap();
        create_template(&conn, "w2", "Plantilla de w2", "", "workflow", "", "drawio", "[]").unwrap();

        let second = load_tree(&conn, "w2").unwrap();
        assert_eq!(
            second.diagrams.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
            ["Dibujo de w2"],
        );
        assert_eq!(
            second.folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["Alla"],
        );
        assert_eq!(
            second.templates.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["Plantilla de w2"],
        );

        // And the other way round, so a passing test cannot mean "load_tree returns nothing".
        let first = load_tree(&conn, "w1").unwrap();
        assert_eq!(
            first.diagrams.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
            ["Dibujo de w1"],
        );
        assert_eq!(
            first.folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["Aqui"],
        );
    }

    /// Deleting a workspace takes its drawings with it, which is the other half of "a diagram
    /// belongs to a workspace" — and the half a foreign key, not a query, is responsible for.
    #[test]
    fn deleting_a_workspace_takes_its_diagrams_with_it() {
        let conn = workspaces();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

        let folder = create_folder(&conn, "w2", None, "Alla", "").unwrap();
        create_diagram(&conn, "w2", Some(&folder.id), "Dibujo", "<mxfile/>", "drawio", "[]")
            .unwrap();
        create_template(&conn, "w2", "Plantilla", "", "workflow", "", "drawio", "[]").unwrap();
        create_diagram(&conn, "w1", None, "Sobreviviente", "<mxfile/>", "drawio", "[]").unwrap();

        conn.execute("DELETE FROM workspaces WHERE id = 'w2'", []).unwrap();

        let left = load_tree(&conn, "w2").unwrap();
        assert!(left.diagrams.is_empty() && left.folders.is_empty() && left.templates.is_empty());
        assert_eq!(load_tree(&conn, "w1").unwrap().diagrams.len(), 1, "and only its own went");
    }
}
