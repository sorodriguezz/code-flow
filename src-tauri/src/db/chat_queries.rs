//! CRUD over `chat_conversations` and `chat_messages` — the `chat` workspace.
//!
//! The AI panel's per-repository chat is backed by `activity_log` and lives in
//! [`super::queries`]; this is the other one, and the two are deliberately not merged. Read the
//! `chat_conversations` block comment in [`super::migrations`] for why the tables differ. What
//! follows is what that shape means for the functions here.
//!
//! **The list is flat and global.** [`list_conversations`] takes no workspace and no project: the
//! sidebar is one list of threads, newest first, like every chat application the user has ever
//! used. `workspace_id` is stored and never filtered on — it is there for the backup grouping and
//! for the run-isolation stamp, not for the query. A workspace-scoped sidebar was considered and
//! rejected for the obvious reason: the feature exists so that a question about nothing in
//! particular does not require choosing a context first, and a list that hides yesterday's
//! conversation because a different workspace is open reintroduces exactly that.
//!
//! **The list carries no message bodies and the transcript may carry no traces.** Two separate
//! economies, and both matter. [`list_conversations`] projects only the conversation row, so the
//! sidebar costs one statement over a few hundred short rows. [`list_messages`] takes
//! `with_trace`, and when it is false it selects a literal `NULL` in the column's place rather
//! than reading the column and discarding it — a trace runs around 600 KB on a turn with real tool
//! use, so a thirty-turn conversation loaded eagerly is roughly eighteen megabytes crossing the
//! IPC boundary to render a transcript that shows none of it. The distinction is invisible to a
//! caller: nothing can show a trace without asking for one.
//!
//! **Anything that touches a conversation bumps `updated_at`.** That column is the sidebar's
//! order, so a writer that forgets leaves the thread the user is actively in sitting below three
//! they have not opened in a week. [`append_message`], [`rename`], [`update_session`] and
//! [`autotitle_from_first_message`] all bump it; [`set_pinned`] and [`set_archived`] deliberately
//! do **not** — filing a thread is not working on it, and pinning something should not reorder the
//! list under the user's cursor.
//!
//! What is *not* here: any notion of an engine, a session or a run. A conversation's
//! `engine_session_id` is a string this layer stores and returns; which CLI produced it, whether
//! that CLI can resume from it, and what happens when it cannot are all `commands::chat_cmd`'s.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{ChatConversation, ChatGroup, ChatMessageRow, ChatSearchHit};
use super::queries::now;

/// Every column of `chat_conversations`, plus the joined project name. Qualified with `c.`/`p.`
/// because every read here goes through the same `LEFT JOIN`; see [`CONVERSATION_FROM`].
const CONVERSATION_COLUMNS: &str = "c.id, c.workspace_id, c.project_id, p.name, c.title, \
                                    c.provider, c.model, c.system_prompt, c.effort, c.group_id, c.unread, \
                                    (SELECT m.is_error FROM chat_messages m \
                                      WHERE m.conversation_id = c.id \
                                      ORDER BY m.turn DESC LIMIT 1), \
                                    c.engine_session_id, \
                                    c.pinned_at, c.archived_at, c.parent_conversation_id, \
                                    c.branched_at_turn, c.created_at, c.updated_at";

/// A **LEFT** join, and that is the whole point of writing it once: `project_id` is nullable and
/// usually null, so an inner join would return an empty sidebar on a correctly working app.
const CONVERSATION_FROM: &str =
    "FROM chat_conversations c LEFT JOIN projects p ON p.id = c.project_id";

/// The message columns, in the order [`map_message`] reads them.
const MESSAGE_COLUMNS: &str = "id, conversation_id, turn, role, content, provider, model, \
                               engine_version, response_time_ms, is_error, is_cancelled, trace, \
                               created_at";

/// The same list with a literal `NULL` where `trace` was. See the module comment: the column is
/// not read at all, rather than read and dropped.
const MESSAGE_COLUMNS_NO_TRACE: &str = "id, conversation_id, turn, role, content, provider, \
                                        model, engine_version, response_time_ms, is_error, \
                                        is_cancelled, NULL, created_at";

/// How many characters a generated title may be. Roughly what fits on one line of the sidebar at
/// its default width; past that the row elides and the extra characters are storage nobody reads.
const TITLE_CHARS: usize = 60;

/// Characters of body either side of a search match. The same figure `note_queries` uses, for the
/// same reason: enough for the sentence around the hit to be recognisable without the result list
/// turning into a second reading surface.
const SNIPPET_PAD: usize = 60;

fn map_conversation(row: &rusqlite::Row) -> rusqlite::Result<ChatConversation> {
    Ok(ChatConversation {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        project_id: row.get(2)?,
        project_name: row.get(3)?,
        title: row.get(4)?,
        provider: row.get(5)?,
        model: row.get(6)?,
        system_prompt: row.get(7)?,
        effort: row.get(8)?,
        group_id: row.get(9)?,
        unread: row.get::<_, i64>(10)? != 0,
        // `None` on a conversation with no messages at all — a thread that was created and never
        // asked anything has not failed, so the absence reads as false rather than as unknown.
        last_failed: row.get::<_, Option<i64>>(11)?.unwrap_or(0) != 0,
        engine_session_id: row.get(12)?,
        pinned_at: row.get(13)?,
        archived_at: row.get(14)?,
        parent_conversation_id: row.get(15)?,
        branched_at_turn: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
    })
}

fn map_message(row: &rusqlite::Row) -> rusqlite::Result<ChatMessageRow> {
    Ok(ChatMessageRow {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        provider: row.get(5)?,
        model: row.get(6)?,
        engine_version: row.get(7)?,
        response_time_ms: row.get(8)?,
        is_error: row.get::<_, i64>(9)? != 0,
        is_cancelled: row.get::<_, i64>(10)? != 0,
        trace: row.get(11)?,
        created_at: row.get(12)?,
    })
}

// ---------- groups ----------

/// Every folder, in the order the sidebar draws them, each with a live count of what is in it.
///
/// The count is a `LEFT JOIN` rather than a stored column: four different writers move a
/// conversation between groups (filing one, deleting one, deleting a group, branching a thread),
/// and a denormalised counter is a number one of them eventually forgets. Archived conversations
/// are excluded from the count, because the sidebar hides them by default and a folder reading "7"
/// while showing three rows is worse than one extra join over a few hundred rows.
pub fn list_groups(conn: &Connection) -> rusqlite::Result<Vec<ChatGroup>> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, g.color, g.sort_order, g.collapsed, g.instructions, g.created_at,
                COUNT(c.id) FILTER (WHERE c.archived_at IS NULL)
         FROM chat_groups g
         LEFT JOIN chat_conversations c ON c.group_id = g.id
         GROUP BY g.id
         ORDER BY g.sort_order, g.created_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ChatGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            sort_order: row.get(3)?,
            collapsed: row.get::<_, i64>(4)? != 0,
            instructions: row.get(5)?,
            created_at: row.get(6)?,
            conversation_count: row.get(7)?,
        })
    })?;
    rows.collect()
}

/// Opens a folder at the end of the list.
pub fn create_group(conn: &Connection, name: &str, color: &str) -> rusqlite::Result<ChatGroup> {
    let id = Uuid::new_v4().to_string();
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chat_groups", [], |row| row.get(0))?;
    conn.execute(
        "INSERT INTO chat_groups (id, name, color, sort_order, collapsed, instructions, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, '', ?5)",
        params![id, name, color, next, now()],
    )?;
    Ok(ChatGroup {
        id,
        name: name.to_string(),
        color: color.to_string(),
        sort_order: next,
        collapsed: false,
        instructions: String::new(),
        created_at: now(),
        conversation_count: 0,
    })
}

/// One project, by id. Needed on the send path, where the conversation names a group and the group
/// carries the instructions that turn belongs to.
pub fn get_group(conn: &Connection, id: &str) -> rusqlite::Result<Option<ChatGroup>> {
    conn.query_row(
        "SELECT g.id, g.name, g.color, g.sort_order, g.collapsed, g.instructions, g.created_at,
                (SELECT COUNT(*) FROM chat_conversations c
                  WHERE c.group_id = g.id AND c.archived_at IS NULL)
         FROM chat_groups g WHERE g.id = ?1",
        params![id],
        |row| {
            Ok(ChatGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                sort_order: row.get(3)?,
                collapsed: row.get::<_, i64>(4)? != 0,
                instructions: row.get(5)?,
                created_at: row.get(6)?,
                conversation_count: row.get(7)?,
            })
        },
    )
    .optional()
}

/// Rewrites a project's standing instructions.
///
/// Read fresh on every turn rather than copied onto its conversations, so editing them changes what
/// the existing chats are told next time they run. That is what the word implies — a snapshot taken
/// when a chat was created would leave older threads running on a version the user can see on
/// screen and cannot change.
pub fn set_group_instructions(conn: &Connection, id: &str, instructions: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_groups SET instructions = ?2 WHERE id = ?1",
        params![id, instructions],
    )?;
    Ok(())
}

pub fn rename_group(conn: &Connection, id: &str, name: &str, color: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_groups SET name = ?2, color = ?3 WHERE id = ?1",
        params![id, name, color],
    )?;
    Ok(())
}

pub fn set_group_collapsed(conn: &Connection, id: &str, collapsed: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_groups SET collapsed = ?2 WHERE id = ?1",
        params![id, i64::from(collapsed)],
    )?;
    Ok(())
}

/// Removes a folder and returns its conversations to the ungrouped list.
///
/// The `UPDATE` is explicit rather than left to `ON DELETE SET NULL`, and it is not redundant: a
/// database upgraded from a build that predates folders has `group_id` added by `ALTER TABLE`,
/// which SQLite cannot give a foreign key. On those databases the constraint does not exist and
/// this statement is the *only* thing standing between deleting a folder and leaving every chat in
/// it pointing at a row that is gone — invisible in the sidebar, and unreachable.
///
/// Both statements in one transaction, so a folder cannot be removed while its chats still name it.
pub fn delete_group(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("UPDATE chat_conversations SET group_id = NULL WHERE group_id = ?1", params![id])?;
    tx.execute("DELETE FROM chat_groups WHERE id = ?1", params![id])?;
    tx.commit()
}

/// Reorders the folders to exactly the sequence given.
pub fn reorder_groups(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (at, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE chat_groups SET sort_order = ?2 WHERE id = ?1",
            params![id, at as i64],
        )?;
    }
    tx.commit()
}

/// Files a conversation under a folder, or returns it to the ungrouped list with `None`.
///
/// Does **not** bump `updated_at`: filing a thread is not working on it, the same rule
/// [`set_pinned`] and [`set_archived`] follow. Moving three chats into a folder should not reorder
/// the list they are being dragged out of.
pub fn set_conversation_group(
    conn: &Connection,
    conversation_id: &str,
    group_id: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_conversations SET group_id = ?2 WHERE id = ?1",
        params![conversation_id, group_id],
    )?;
    Ok(())
}

// ---------- conversations ----------

/// Opens a thread.
///
/// `project_id` is `Option` and `None` is the ordinary case — a conversation bound to no
/// repository is what the chat workspace is *for*. The caller decides: the sidebar's "New chat"
/// passes `None` even when a repository is open, and only an explicit "chat about this repo"
/// passes a project.
///
/// No title. The row is named by its first user message through
/// [`autotitle_from_first_message`], because the alternatives are a modal before the first word or
/// a sidebar of rows all called "New chat".
pub fn create_conversation(
    conn: &Connection,
    workspace_id: &str,
    project_id: Option<&str>,
    provider: &str,
    model: &str,
    system_prompt: &str,
) -> rusqlite::Result<ChatConversation> {
    let id = Uuid::new_v4().to_string();
    let at = now();
    conn.execute(
        "INSERT INTO chat_conversations
             (id, workspace_id, project_id, title, provider, model, system_prompt,
              engine_session_id, pinned_at, archived_at, parent_conversation_id,
              branched_at_turn, created_at, updated_at)
         VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, NULL, NULL, NULL, NULL, NULL, ?7, ?7)",
        params![id, workspace_id, project_id, provider, model, system_prompt, at],
    )?;
    // Read back rather than assembling the struct from the arguments: the row is the truth, and
    // this is the one place where a column default (`title`, the NULLs) would otherwise have to be
    // duplicated in Rust and kept in step with the schema by hand.
    get_conversation(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// The sidebar's one query: **flat, global, pinned first, then most recently touched.**
///
/// No workspace parameter and no project parameter — see the module comment. The ordering is one
/// rule applied twice rather than two: within the pinned group and within the rest, the order is
/// `updated_at DESC`. Sorting the pinned group by `pinned_at` instead was the other candidate and
/// is worse in the case that matters — pinning is something a user does once, so a pinned-order
/// group freezes, and the thread they pinned *because* they are living in it drifts to the bottom
/// of it.
///
/// `include_archived` widens rather than switches: archiving is the user saying "not now", not
/// "delete", so an archived thread still has to be reachable — from search, and from a list that
/// was asked to show everything.
pub fn list_conversations(
    conn: &Connection,
    include_archived: bool,
) -> rusqlite::Result<Vec<ChatConversation>> {
    // Built rather than parameterised: a `WHERE` clause cannot be bound, and the only two
    // spellings are literals in this file.
    let filter = if include_archived { "" } else { "WHERE c.archived_at IS NULL " };
    let sql = format!(
        "SELECT {CONVERSATION_COLUMNS} {CONVERSATION_FROM} {filter}\
         ORDER BY (c.pinned_at IS NULL), c.updated_at DESC"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([], map_conversation)?;
    rows.collect()
}

pub fn get_conversation(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<ChatConversation>> {
    let sql =
        format!("SELECT {CONVERSATION_COLUMNS} {CONVERSATION_FROM} WHERE c.id = ?1");
    conn.query_row(&sql, params![id], map_conversation).optional()
}

/// Records where the engine got to: the session it will be resumed under, and the model it
/// actually ran.
///
/// The model is written back rather than assumed because a CLI may pick for itself — an empty
/// `model` on the invocation means "engine's choice", and the transcript has to be able to say
/// which choice that was.
pub fn update_session(
    conn: &Connection,
    id: &str,
    engine_session_id: Option<&str>,
    model: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_conversations SET engine_session_id = ?2, model = ?3, updated_at = ?4
         WHERE id = ?1",
        params![id, engine_session_id, model, now()],
    )?;
    Ok(())
}

/// Re-points a conversation at a different engine, or at a different model on the same engine.
///
/// **Changing the provider drops `engine_session_id`, and that is the whole subtlety.** A resume
/// token is minted by one CLI and means nothing to another: handing Codex a session id Claude
/// issued is not a conversation that continues elsewhere, it is an argument the binary rejects.
/// So the token is cleared on a provider change and kept on a mere model change, where the same
/// CLI is still holding the same session. What the user sees either way is that the transcript is
/// intact — it is this app's rows, not the engine's memory — while the *engine* starts fresh, and
/// the first turn after a provider switch is a context transplant rather than a resume.
///
/// The commonest caller is not a person browsing the picker. It is a run that failed with "model
/// not found" and offered the ids it would have accepted: the user presses one, and this is what
/// makes that press stick past the next launch.
pub fn set_engine(conn: &Connection, id: &str, provider: &str, model: &str) -> rusqlite::Result<()> {
    let current: Option<String> = conn
        .query_row("SELECT provider FROM chat_conversations WHERE id = ?1", params![id], |row| row.get(0))
        .optional()?;
    let switched = current.as_deref().is_some_and(|p| p != provider);
    if switched {
        conn.execute(
            "UPDATE chat_conversations
             SET provider = ?2, model = ?3, engine_session_id = NULL, updated_at = ?4
             WHERE id = ?1",
            params![id, provider, model, now()],
        )?;
    } else {
        conn.execute(
            "UPDATE chat_conversations SET provider = ?2, model = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, provider, model, now()],
        )?;
    }
    Ok(())
}

/// Sets how hard the model is asked to think, for every future turn of this conversation.
///
/// An empty string is a meaningful value and the default: it means no flag is sent, which leaves
/// whatever the user configured in the CLI itself in charge. Validation lives at the invocation
/// boundary in `ai::run` rather than here, so a level this build does not know about is stored and
/// simply not forwarded — a future version that learns it will start honouring the row.
pub fn set_effort(conn: &Connection, id: &str, effort: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_conversations SET effort = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, effort, now()],
    )?;
    Ok(())
}

/// Marks a conversation as having something the user has not seen, or clears it.
///
/// Its own statement rather than a side effect of [`append_message`], because the two callers want
/// opposite things at the same moment: the backend sets the flag when an answer is persisted, and
/// the window that was *looking at* that conversation clears it immediately afterwards. Folding it
/// into the insert would leave the second caller with nothing to call.
///
/// Deliberately does not bump `updated_at`: reading a thread is not working on it, the same rule
/// [`set_pinned`] and [`set_archived`] follow.
pub fn set_unread(conn: &Connection, id: &str, unread: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_conversations SET unread = ?2 WHERE id = ?1",
        params![id, i64::from(unread)],
    )?;
    Ok(())
}

pub fn rename(conn: &Connection, id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE chat_conversations SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now()],
    )?;
    Ok(())
}

/// Deletes the thread and, by the table's `ON DELETE CASCADE`, every message in it.
///
/// The cascade is in the schema rather than in a second statement here on purpose: it is the one
/// deletion in this file that must be atomic under every path, including a future caller that
/// deletes through a different statement.
pub fn delete_conversation(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM chat_conversations WHERE id = ?1", params![id])?;
    Ok(())
}

/// Neither this nor [`set_archived`] touches `updated_at` — filing a thread is not working on it,
/// and a pin that reordered the list under the user's cursor would be a surprise every time.
pub fn set_pinned(conn: &Connection, id: &str, pinned: bool) -> rusqlite::Result<()> {
    let at = if pinned { Some(now()) } else { None };
    conn.execute(
        "UPDATE chat_conversations SET pinned_at = ?2 WHERE id = ?1",
        params![id, at],
    )?;
    Ok(())
}

pub fn set_archived(conn: &Connection, id: &str, archived: bool) -> rusqlite::Result<()> {
    let at = if archived { Some(now()) } else { None };
    conn.execute(
        "UPDATE chat_conversations SET archived_at = ?2 WHERE id = ?1",
        params![id, at],
    )?;
    Ok(())
}

// ---------- messages ----------

/// The transcript, oldest first. `with_trace` decides whether the heaviest column in the schema
/// crosses the wire at all — see the module comment.
///
/// Ordered by `turn` and then by `created_at`, not by `turn` alone: the user message and the
/// assistant reply of one exchange deliberately share a turn number (that is what makes "branch at
/// turn N" expressible), so the tiebreak is what keeps the question above its answer.
pub fn list_messages(
    conn: &Connection,
    conversation_id: &str,
    with_trace: bool,
) -> rusqlite::Result<Vec<ChatMessageRow>> {
    let columns = if with_trace { MESSAGE_COLUMNS } else { MESSAGE_COLUMNS_NO_TRACE };
    let sql = format!(
        "SELECT {columns} FROM chat_messages WHERE conversation_id = ?1 \
         ORDER BY turn, created_at"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![conversation_id], map_message)?;
    rows.collect()
}

/// Writes one message and bumps its conversation's `updated_at`.
///
/// Both statements or neither: a message stored under a thread whose `updated_at` still points at
/// yesterday is a thread the sidebar buries, which is the same to the user as having lost it. A
/// transaction rather than trusting two `execute` calls to both land, because the second one can
/// fail on its own (the conversation deleted between the two, from another window).
///
/// The message is taken whole rather than as fifteen parameters: the caller has already built the
/// row — it holds the run's timing, the engine's version string and the trace — and a signature
/// that long is one where two `Option<String>` arguments get swapped without the compiler
/// noticing.
pub fn append_message(conn: &Connection, msg: &ChatMessageRow) -> rusqlite::Result<()> {
    let at = now();
    conn.execute(
        "INSERT INTO chat_messages
             (id, conversation_id, turn, role, content, provider, model, engine_version,
              response_time_ms, is_error, is_cancelled, trace, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            msg.id,
            msg.conversation_id,
            msg.turn,
            msg.role,
            msg.content,
            msg.provider,
            msg.model,
            msg.engine_version,
            msg.response_time_ms,
            i64::from(msg.is_error),
            i64::from(msg.is_cancelled),
            msg.trace,
            if msg.created_at.is_empty() { at.clone() } else { msg.created_at.clone() },
        ],
    )?;
    conn.execute(
        "UPDATE chat_conversations SET updated_at = ?2 WHERE id = ?1",
        params![msg.conversation_id, at],
    )?;
    Ok(())
}

/// The number the next exchange writes its two messages under.
///
/// `MAX + 1` and not `COUNT`, because a turn holds two rows and because deleting a message (an
/// edit that removed one, a branch that trimmed a tail) must not make the next turn collide with a
/// number already used. An empty conversation starts at 0.
pub fn next_turn(conn: &Connection, conversation_id: &str) -> rusqlite::Result<i64> {
    let highest: Option<i64> = conn.query_row(
        "SELECT MAX(turn) FROM chat_messages WHERE conversation_id = ?1",
        params![conversation_id],
        |row| row.get(0),
    )?;
    Ok(highest.map_or(0, |t| t + 1))
}

// ---------- search ----------

/// One hit per conversation, over titles and message bodies.
///
/// `LIKE` with an explicit `ESCAPE`, so a user searching for `100%` or `api_key` searches for
/// those characters rather than for a wildcard that matches everything. SQLite's `LIKE` folds case
/// for ASCII only — searching `ACCIÓN` will not find `acción` — which is a real limitation in a
/// half-Spanish app and a deliberate one here: `note_queries::search_notes` solves it by reading
/// every body into Rust and folding per character, which is affordable over a few hundred notes of
/// a few kilobytes and is not affordable over a corpus whose rows carry 600 KB traces. If this
/// becomes the complaint it may become, the fix is an FTS5 shadow table behind this same
/// signature, not a full scan.
///
/// The snippet comes from the matching message when one matched and from the title otherwise, so a
/// result row always shows *why* it is a result.
pub fn search(
    conn: &Connection,
    query: &str,
    limit: u32,
) -> rusqlite::Result<Vec<ChatSearchHit>> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", escape_like(needle));

    let mut statement = conn.prepare(
        "SELECT c.id, c.title,
                (SELECT m.content FROM chat_messages m
                  WHERE m.conversation_id = c.id AND m.content LIKE ?1 ESCAPE '\\'
                  ORDER BY m.turn, m.created_at LIMIT 1)
         FROM chat_conversations c
         WHERE c.title LIKE ?1 ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM chat_messages m
                        WHERE m.conversation_id = c.id AND m.content LIKE ?1 ESCAPE '\\')
         ORDER BY (c.pinned_at IS NULL), c.updated_at DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![pattern, limit], |row| {
        let title: String = row.get(1)?;
        let body: Option<String> = row.get(2)?;
        let snippet = match body {
            Some(content) => snippet_around(&content, needle),
            None => title.clone(),
        };
        Ok(ChatSearchHit { conversation_id: row.get(0)?, title, snippet })
    })?;
    rows.collect()
}

/// `%`, `_` and the escape character itself, neutralised. Without this a bare `%` typed into the
/// search box matches every conversation in the database.
fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// A window of `content` around the first ASCII-case-insensitive occurrence of `needle`.
///
/// Sliced on `char` boundaries, never on bytes: a body with an accented letter before the match
/// would otherwise panic on a byte index that lands mid-codepoint, and half the strings in this
/// app are Spanish. Falls back to the head of the body when the match cannot be located — which
/// happens exactly when `LIKE` folded a case this function does not, and a first line is a better
/// answer there than an empty snippet.
fn snippet_around(content: &str, needle: &str) -> String {
    let chars: Vec<char> = content.chars().collect();
    let lowered: String = content.to_lowercase();
    let wanted = needle.to_lowercase();

    let found = lowered.find(&wanted).map(|byte_offset| lowered[..byte_offset].chars().count());
    let Some(start_of_match) = found else {
        return chars.iter().take(SNIPPET_PAD * 2).collect();
    };

    let from = start_of_match.saturating_sub(SNIPPET_PAD);
    let to = (start_of_match + wanted.chars().count() + SNIPPET_PAD).min(chars.len());
    chars[from..to].iter().collect()
}

// ---------- naming ----------

/// Names an unnamed thread after its first user message.
///
/// A no-op once the thread has a title, including one the user typed — a rename must survive the
/// next turn, and this runs after every one of them.
///
/// Truncation is on a **word boundary**, because the alternative reads as broken: a sidebar row
/// saying "Por qué el despliegue de produc…" is a sentence cut short, and one saying "Por qué el
/// despliegue de" is a phrase. The boundary is only honoured when there is one late enough to be
/// worth it (past two thirds of the budget); a first "word" longer than the whole limit — a pasted
/// URL, a stack frame — is cut where it is rather than losing the row to a title of nothing.
pub fn autotitle_from_first_message(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let current: Option<String> = conn
        .query_row("SELECT title FROM chat_conversations WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .optional()?;
    match current {
        Some(title) if title.trim().is_empty() => {}
        // Either already named, or the conversation is gone. Both are "nothing to do".
        _ => return Ok(()),
    }

    let first: Option<String> = conn
        .query_row(
            "SELECT content FROM chat_messages WHERE conversation_id = ?1 AND role = 'user'
             ORDER BY turn, created_at LIMIT 1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(source) = first else { return Ok(()) };

    let title = truncate_on_word(source.trim(), TITLE_CHARS);
    if title.is_empty() {
        return Ok(());
    }
    // Not `rename`: naming a thread is a consequence of the turn that was just written, so it must
    // not move the thread in a list the turn has already ordered correctly.
    conn.execute(
        "UPDATE chat_conversations SET title = ?2 WHERE id = ?1",
        params![id, title],
    )?;
    Ok(())
}

/// See [`autotitle_from_first_message`]. Collapses whitespace first, so a message that begins with
/// a fenced block or a hard-wrapped paragraph produces one line rather than a title with newlines
/// in it.
fn truncate_on_word(text: &str, limit: usize) -> String {
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = flattened.chars().collect();
    if chars.len() <= limit {
        return flattened;
    }
    let cut: String = chars[..limit].iter().collect();
    match cut.rfind(' ') {
        Some(space) if space * 3 >= limit * 2 => cut[..space].trim_end().to_string(),
        _ => cut,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One workspace, `w1`, and one project in it, `p1` — the project is here for the orphaning
    /// test, and is deliberately *not* what most conversations in these tests are bound to.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Flow', 'book', '#111', 0, '2026-01-01T00:00:00+00:00');
             INSERT INTO projects (id, workspace_id, name, local_path, color, icon, sort_order,
                                   created_at)
                 VALUES ('p1', 'w1', 'api', '/tmp/api', '#222', 'folder', 0,
                         '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
    }

    fn user_message(conversation_id: &str, turn: i64, content: &str) -> ChatMessageRow {
        ChatMessageRow {
            id: Uuid::new_v4().to_string(),
            conversation_id: conversation_id.to_string(),
            turn,
            role: "user".into(),
            content: content.into(),
            provider: None,
            model: None,
            engine_version: None,
            response_time_ms: None,
            is_error: false,
            is_cancelled: false,
            trace: None,
            created_at: String::new(),
        }
    }

    fn assistant_message(
        conversation_id: &str,
        turn: i64,
        content: &str,
        trace: Option<&str>,
    ) -> ChatMessageRow {
        ChatMessageRow {
            role: "assistant".into(),
            provider: Some("claude".into()),
            model: Some("sonnet".into()),
            trace: trace.map(str::to_string),
            ..user_message(conversation_id, turn, content)
        }
    }

    /// The sidebar's contract in one test: everything pinned is above everything else, and inside
    /// each group the most recently touched thread is first.
    #[test]
    fn the_list_is_flat_with_pinned_threads_on_top() {
        let conn = seeded();
        let first = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        let second = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        let third = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();

        // Touch them in a known order — `updated_at` has microsecond resolution, but three inserts
        // in a row can still land inside one microsecond on a fast machine.
        for (id, at) in [
            (&first.id, "2026-01-01T00:00:01+00:00"),
            (&second.id, "2026-01-01T00:00:02+00:00"),
            (&third.id, "2026-01-01T00:00:03+00:00"),
        ] {
            conn.execute(
                "UPDATE chat_conversations SET updated_at = ?2 WHERE id = ?1",
                params![id, at],
            )
            .unwrap();
        }

        let listed = list_conversations(&conn, false).unwrap();
        let order: Vec<&str> = listed.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(order, vec![&third.id, &second.id, &first.id], "newest first");

        set_pinned(&conn, &first.id, true).unwrap();
        let listed = list_conversations(&conn, false).unwrap();
        assert_eq!(listed[0].id, first.id, "the pinned thread is on top despite being oldest");
        assert_eq!(listed[1].id, third.id, "and the rest keep their own order");
        assert!(listed[0].pinned_at.is_some());

        // Pinning must not have counted as working on the thread.
        assert_eq!(
            listed[0].updated_at, "2026-01-01T00:00:01+00:00",
            "a pin does not reorder the list by touching updated_at"
        );
    }

    /// Archived threads are hidden by default and reachable on request. Archiving is "not now",
    /// not "delete".
    #[test]
    fn archiving_hides_a_thread_without_losing_it() {
        let conn = seeded();
        let chat = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();

        set_archived(&conn, &chat.id, true).unwrap();
        assert!(list_conversations(&conn, false).unwrap().is_empty());
        assert_eq!(list_conversations(&conn, true).unwrap().len(), 1);

        set_archived(&conn, &chat.id, false).unwrap();
        assert_eq!(list_conversations(&conn, false).unwrap().len(), 1);
    }

    /// A repo-bound conversation labels itself through the join; a repo-less one — the normal
    /// case — is simply unlabelled, and the `LEFT` in the join is what keeps it in the list at all.
    #[test]
    fn the_list_labels_the_repo_bound_threads_and_keeps_the_rest() {
        let conn = seeded();
        create_conversation(&conn, "w1", Some("p1"), "claude", "", "").unwrap();
        create_conversation(&conn, "w1", None, "claude", "", "").unwrap();

        let listed = list_conversations(&conn, false).unwrap();
        assert_eq!(listed.len(), 2, "a conversation about nothing is still a conversation");
        let named: Vec<Option<String>> =
            listed.iter().map(|c| c.project_name.clone()).collect();
        assert!(named.contains(&Some("api".to_string())));
        assert!(named.contains(&None));
    }

    /// Turns are `MAX + 1`, and the two halves of one exchange share a number — which is what
    /// makes "branch at turn N" a thing that can be said.
    #[test]
    fn appending_advances_the_turn_and_bumps_the_thread() {
        let conn = seeded();
        let chat = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        assert_eq!(next_turn(&conn, &chat.id).unwrap(), 0, "an empty thread starts at 0");

        conn.execute(
            "UPDATE chat_conversations SET updated_at = '2000-01-01T00:00:00+00:00' WHERE id = ?1",
            params![chat.id],
        )
        .unwrap();

        append_message(&conn, &user_message(&chat.id, 0, "hola")).unwrap();
        append_message(&conn, &assistant_message(&chat.id, 0, "qué tal", None)).unwrap();
        assert_eq!(next_turn(&conn, &chat.id).unwrap(), 1, "both halves shared turn 0");

        append_message(&conn, &user_message(&chat.id, 1, "otra")).unwrap();
        assert_eq!(next_turn(&conn, &chat.id).unwrap(), 2);

        let bumped = get_conversation(&conn, &chat.id).unwrap().unwrap();
        assert!(
            bumped.updated_at > "2000-01-01T00:00:00+00:00".to_string(),
            "writing a message is working on the thread"
        );

        let messages = list_messages(&conn, &chat.id, true).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].role, "user", "the question stays above its answer");
        assert_eq!(messages[1].role, "assistant");
    }

    /// The economy the whole transcript read is built on: without `with_trace`, the heaviest
    /// column in the schema is never selected.
    #[test]
    fn a_transcript_without_traces_carries_none() {
        let conn = seeded();
        let chat = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        let trace = r#"[{"stream":"stdout","line":"running"}]"#;
        append_message(&conn, &assistant_message(&chat.id, 0, "hecho", Some(trace))).unwrap();

        let light = list_messages(&conn, &chat.id, false).unwrap();
        assert_eq!(light.len(), 1);
        assert!(light[0].trace.is_none(), "the trace must not cross the wire unasked");

        let heavy = list_messages(&conn, &chat.id, true).unwrap();
        assert_eq!(heavy[0].trace.as_deref(), Some(trace), "and must be there when it is");
    }

    /// Deleting a thread takes its messages with it — the cascade lives in the schema, so this is
    /// checking the schema as much as the function.
    #[test]
    fn deleting_a_conversation_takes_its_messages() {
        let conn = seeded();
        let chat = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        append_message(&conn, &user_message(&chat.id, 0, "hola")).unwrap();
        append_message(&conn, &assistant_message(&chat.id, 0, "adiós", None)).unwrap();

        delete_conversation(&conn, &chat.id).unwrap();

        assert!(get_conversation(&conn, &chat.id).unwrap().is_none());
        let orphans: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?1",
                params![chat.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0, "a message outside a conversation has no surface to be read from");
    }

    /// **The one that justifies `ON DELETE SET NULL`.** Removing a repository from the sidebar is
    /// housekeeping; it must orphan the chats that happened around it, never shred them.
    #[test]
    fn deleting_a_project_orphans_its_chats_rather_than_shredding_them() {
        let conn = seeded();
        // Foreign keys are off by default on a fresh rusqlite connection, and the cascade under
        // test *is* the schema's — so it has to be asked for explicitly here.
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();

        let chat = create_conversation(&conn, "w1", Some("p1"), "claude", "", "").unwrap();
        append_message(&conn, &user_message(&chat.id, 0, "por qué falla el build")).unwrap();

        conn.execute("DELETE FROM projects WHERE id = 'p1'", []).unwrap();

        let survivor = get_conversation(&conn, &chat.id)
            .unwrap()
            .expect("the conversation outlives the repository it was about");
        assert!(survivor.project_id.is_none(), "orphaned, not deleted");
        assert!(survivor.project_name.is_none());
        assert_eq!(
            list_messages(&conn, &chat.id, false).unwrap().len(),
            1,
            "and it keeps every word of it"
        );
    }

    /// The thread names itself once, from the first thing the user said, and then leaves the
    /// title alone forever.
    #[test]
    fn a_thread_names_itself_from_the_first_message_and_only_once() {
        let conn = seeded();
        let chat = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        append_message(
            &conn,
            &user_message(&chat.id, 0, "  cómo\n  configuro el despliegue automático  "),
        )
        .unwrap();

        autotitle_from_first_message(&conn, &chat.id).unwrap();
        let named = get_conversation(&conn, &chat.id).unwrap().unwrap();
        assert_eq!(
            named.title, "cómo configuro el despliegue automático",
            "whitespace collapsed to one line"
        );

        // A second turn must not rewrite it, and neither must a rename the user typed.
        append_message(&conn, &user_message(&chat.id, 1, "otra cosa entera")).unwrap();
        autotitle_from_first_message(&conn, &chat.id).unwrap();
        assert_eq!(get_conversation(&conn, &chat.id).unwrap().unwrap().title, named.title);

        rename(&conn, &chat.id, "Despliegues").unwrap();
        autotitle_from_first_message(&conn, &chat.id).unwrap();
        assert_eq!(
            get_conversation(&conn, &chat.id).unwrap().unwrap().title,
            "Despliegues",
            "a rename survives the next turn"
        );
    }

    /// Titles are cut at a word, not mid-word — and the cut is on characters, so an accented
    /// letter near the limit cannot panic a byte slice.
    #[test]
    fn a_long_first_message_is_cut_at_a_word() {
        let long = "la configuración del despliegue automático en el entorno de producción y todo";
        let title = truncate_on_word(long, TITLE_CHARS);
        assert!(title.chars().count() <= TITLE_CHARS);
        assert!(!title.ends_with(' '));
        assert!(long.starts_with(&title), "a prefix of the message, not a reflow of it");
        assert!(title.split(' ').count() > 1);

        // A single token longer than the budget has no boundary to honour; it is cut where it is.
        let url = "https://example.invalid/a/very/long/path/that/never/breaks/anywhere/at/all";
        assert_eq!(truncate_on_word(url, TITLE_CHARS).chars().count(), TITLE_CHARS);
    }

    /// Search spans titles and bodies, answers once per thread, and says where it landed.
    #[test]
    fn search_reads_titles_and_bodies_and_answers_once_per_thread() {
        let conn = seeded();
        let named = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        rename(&conn, &named.id, "Notas de despliegue").unwrap();

        let bodied = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        append_message(
            &conn,
            &user_message(&bodied.id, 0, "el despliegue falla y el despliegue vuelve a fallar"),
        )
        .unwrap();

        let hits = search(&conn, "despliegue", 10).unwrap();
        assert_eq!(hits.len(), 2, "one row per conversation, not per match");
        let body_hit = hits.iter().find(|h| h.conversation_id == bodied.id).unwrap();
        assert!(body_hit.snippet.contains("despliegue"), "the snippet shows why it matched");

        let title_hit = hits.iter().find(|h| h.conversation_id == named.id).unwrap();
        assert_eq!(title_hit.title, "Notas de despliegue");
        assert!(!title_hit.snippet.is_empty(), "a title match still gets a snippet");
    }

    /// A bare `%` must search for a percent sign, not match the entire database.
    #[test]
    fn search_treats_wildcards_as_characters() {
        let conn = seeded();
        let plain = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        append_message(&conn, &user_message(&plain.id, 0, "sin nada especial")).unwrap();

        let literal = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        append_message(&conn, &user_message(&literal.id, 0, "el disco al 100% lleno")).unwrap();

        let hits = search(&conn, "100%", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, literal.id);

        assert!(search(&conn, "%", 10).unwrap().len() == 1, "a lone wildcard is a character");
    }

    /// An empty query is not "match everything" — the search box is empty most of the time.
    #[test]
    fn an_empty_query_finds_nothing() {
        let conn = seeded();
        let chat = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        append_message(&conn, &user_message(&chat.id, 0, "hola")).unwrap();
        assert!(search(&conn, "   ", 10).unwrap().is_empty());
    }

    /// The session id and the model the CLI actually chose are written back together, because a
    /// transcript that cannot name the model that answered is a transcript that guesses.
    #[test]
    fn the_engine_session_and_the_model_are_recorded_together() {
        let conn = seeded();
        let chat = create_conversation(&conn, "w1", None, "claude", "", "").unwrap();
        assert!(chat.engine_session_id.is_none());

        update_session(&conn, &chat.id, Some("sess-1"), "claude-sonnet-4-5").unwrap();
        let updated = get_conversation(&conn, &chat.id).unwrap().unwrap();
        assert_eq!(updated.engine_session_id.as_deref(), Some("sess-1"));
        assert_eq!(updated.model, "claude-sonnet-4-5");

        // An engine that cannot resume clears it rather than keeping a stale id around.
        update_session(&conn, &chat.id, None, "claude-sonnet-4-5").unwrap();
        assert!(get_conversation(&conn, &chat.id).unwrap().unwrap().engine_session_id.is_none());
    }
}
