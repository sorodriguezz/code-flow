//! The assistant panel's **workspace chat**: one conversation that talks to every repository of a
//! workspace at once, and that knows what the workspace's SDD/Harness agents are in the middle of.
//!
//! It is a `chat_conversations` row with `workspace_scope = 1` (see `db::chat_queries`), run by
//! `commands::chat_cmd::chat_send` like any chat-workspace thread — streaming, effort, compaction,
//! titles — with four differences, all decided here:
//!
//! - **Where it runs.** Not in a repository: in a folder of its own per workspace
//!   ([`working_dir`]), stable so an engine session resumes, with every repository that exists on
//!   disk handed to the engine as an extra directory (Claude/agy/Codex `--add-dir`). An engine
//!   without that flag still gets the absolute paths, and is told to use them.
//! - **What it may do.** Write, like the repository chat: edits auto-approved, a checkpoint per
//!   repository around each turn.
//! - **What it is told once.** [`system_prompt`]: the role, and that the live state arrives with
//!   every message. A system prompt only reaches an engine when its session starts, so nothing that
//!   changes lives there.
//! - **What it is told every turn.** [`live_block`]: the repositories (path, branch) and the agent
//!   work in flight — chains, story runs, hybrid runs, running tasks — compact, so the user can ask
//!   about them and carry them on from the chat. A chat opened *for* one chain also gets that
//!   chain's whole brief ([`chain_brief`]) once per session.
//!
//! The snapshot is read from the database each turn, never cached: the point of it is to be what
//! the Agents view shows right now.

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::queries;

/// One repository of the workspace, as the model is told about it.
#[derive(Debug, Clone, PartialEq)]
pub struct RepoLine {
    pub name: String,
    pub path: String,
    /// The checked-out branch; `""` when detached, unreadable or missing.
    pub branch: String,
    pub on_disk: bool,
}

/// The workspace's repositories, in the sidebar's order, with their branch read off disk.
pub fn repos(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<RepoLine>> {
    Ok(repo_lines(queries::list_projects(conn, workspace_id)?))
}

/// [`repos`] for projects already read — so a caller holding the database lock can let it go
/// before every repository is opened to read its branch.
pub fn repo_lines(projects: Vec<crate::db::models::Project>) -> Vec<RepoLine> {
    projects
        .into_iter()
        .map(|project| {
            let on_disk = std::path::Path::new(&project.local_path).is_dir();
            let branch = if on_disk { current_branch(&project.local_path) } else { String::new() };
            RepoLine { name: project.name, path: project.local_path, branch, on_disk }
        })
        .collect()
}

fn current_branch(path: &str) -> String {
    git2::Repository::open(path)
        .ok()
        .and_then(|repo| repo.head().ok().and_then(|head| head.shorthand().map(str::to_string)))
        .unwrap_or_default()
}

/// The folders the engine is given besides its own: every repository that exists on disk.
pub fn extra_dirs(repos: &[RepoLine]) -> Vec<String> {
    repos.iter().filter(|repo| repo.on_disk).map(|repo| repo.path.clone()).collect()
}

/// Where a workspace's chats run: a folder of the app's own, one per workspace, created on first
/// use. Stable, because a CLI keys its sessions by working directory.
pub fn working_dir(workspace_id: &str) -> std::path::PathBuf {
    // The id is the app's own, but it becomes a path segment: anything that is not plainly safe is
    // replaced rather than trusted.
    let safe: String = workspace_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    crate::paths::state_dir().join("workspace-chat").join(if safe.is_empty() { "_".to_string() } else { safe })
}

/// The role, said once per engine session. Everything that changes is in [`live_block`].
pub fn system_prompt(workspace_name: &str, cwd: &str, extra_dirs_reach: bool) -> String {
    let reach = if extra_dirs_reach {
        "Tienes acceso a esas carpetas además de la tuya."
    } else {
        "Tu herramienta puede no tener esas carpetas como propias: usa siempre las rutas absolutas, y si \
         alguna no te deja leer o escribir, dilo en vez de suponer su contenido."
    };
    format!(
        "Eres el asistente del workspace «{workspace_name}» de CodeFlow, que agrupa varios repositorios. \
         No estás dentro de uno solo: tu directorio de trabajo ({cwd}) es una carpeta propia de este chat, \
         y los repositorios del workspace están en las rutas absolutas que lista el bloque «Estado del \
         workspace» que acompaña a cada mensaje (el último bloque manda; los anteriores pueden estar \
         desactualizados). {reach}\n\n\
         Trabaja con esas rutas absolutas: lee, busca, edita y ejecuta comandos entrando en el repositorio \
         que toque. Puedes editar en cualquiera de ellos; cada turno deja un punto de restauración por \
         repositorio. Si un cambio afecta a varios repositorios, di antes en una línea qué vas a tocar y \
         dónde, y mantén los cambios coherentes entre ellos.\n\n\
         El bloque también resume el trabajo de los agentes SDD/Harness del workspace (cadenas, \
         historias, ejecuciones híbridas y tareas). Si el usuario te pide retomarlo, continúa ese trabajo \
         directamente en los repositorios que indica. No puedes aprobar compuertas ni reanudar o detener \
         cadenas desde aquí: si hace falta, dile que lo haga en Tareas. No menciones el bloque salvo que \
         te pregunten por él o sea relevante. Responde en el idioma del usuario."
    )
}

/// One chain of the workspace that is not finished, with the step it is at.
#[derive(Debug, Clone, PartialEq)]
pub struct ChainLine {
    pub id: String,
    pub title: String,
    /// `chain` | `story` | `hybrid`.
    pub kind: String,
    pub status: String,
    pub step_count: i64,
    pub last_reason: String,
    pub repos: Vec<String>,
    pub step: Option<StepLine>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepLine {
    /// Zero-based.
    pub index: i64,
    pub agent_name: String,
    pub phase: String,
    pub status: String,
    pub repo: String,
    /// What the gate will send when approved — only meaningful on a gated step.
    pub pending_input: String,
    pub last_error: String,
}

/// An agent task running (or just finished badly) outside any chain.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskLine {
    pub title: String,
    pub agent_name: String,
    pub status: String,
    pub repo: String,
    pub last_error: String,
}

/// How many of each the block lists — the newest. The block rides every message; a workspace with
/// thirty paused plans must not turn each question into a report.
const MAX_CHAINS: i64 = 8;
const MAX_TASKS: i64 = 6;
/// How far back a failure still counts as "in the middle of" something.
const RECENT_FAILURE_DAYS: i64 = 3;

fn recent_cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(RECENT_FAILURE_DAYS)).to_rfc3339()
}

/// The workspace's unfinished chains, newest first — plus `focus`, whatever its state.
pub fn chains(conn: &Connection, workspace_id: &str, focus: &str) -> rusqlite::Result<Vec<ChainLine>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.kind, c.status, c.step_count, c.last_reason
           FROM agent_chains c JOIN projects p ON p.id = c.project_id
          WHERE p.workspace_id = ?1
            AND (c.status IN ('queued', 'running', 'gated', 'paused')
                 OR (c.status = 'failed' AND c.updated_at >= ?3)
                 OR (c.id = ?2 AND ?2 <> ''))
          ORDER BY (c.id = ?2) DESC, c.updated_at DESC
          LIMIT ?4",
    )?;
    let rows: Vec<ChainLine> = stmt
        .query_map(params![workspace_id, focus, recent_cutoff(), MAX_CHAINS], |row| {
            Ok(ChainLine {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                status: row.get(3)?,
                step_count: row.get(4)?,
                last_reason: row.get(5)?,
                repos: Vec::new(),
                step: None,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter()
        .map(|mut chain| {
            chain.repos = chain_repo_names(conn, &chain.id)?;
            chain.step = current_step(conn, &chain.id)?;
            Ok(chain)
        })
        .collect()
}

fn chain_repo_names(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(p.name, '') FROM agent_chain_repos r LEFT JOIN projects p ON p.id = r.project_id
          WHERE r.chain_id = ?1 ORDER BY r.position",
    )?;
    let names = stmt.query_map(params![chain_id], |row| row.get::<_, String>(0))?;
    names.filter(|name| !matches!(name, Ok(n) if n.is_empty())).collect()
}

/// The step a chain is at: the one running, else the first still to run (a gate waits on it), else
/// the last one touched.
fn current_step(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<StepLine>> {
    conn.query_row(
        "SELECT s.step_index, s.agent_name, s.phase, s.status, COALESCE(p.name, ''), s.pending_input, s.last_error
           FROM agent_chain_steps s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.chain_id = ?1
          ORDER BY CASE s.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                   CASE WHEN s.status IN ('running', 'pending') THEN s.step_index ELSE -s.step_index END
          LIMIT 1",
        params![chain_id],
        |row| {
            Ok(StepLine {
                index: row.get(0)?,
                agent_name: row.get(1)?,
                phase: row.get(2)?,
                status: row.get(3)?,
                repo: row.get(4)?,
                pending_input: row.get(5)?,
                last_error: row.get(6)?,
            })
        },
    )
    .optional()
}

/// Agent tasks of the workspace running on their own (a chain's step tasks are told with the
/// chain), and the ones that failed lately.
pub fn tasks(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<TaskLine>> {
    let mut stmt = conn.prepare(
        "SELECT t.title, t.agent_name, t.status, COALESCE(p.name, ''), t.last_error
           FROM agent_tasks t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.workspace_id = ?1
            AND (t.status = 'running' OR (t.status = 'error' AND t.updated_at >= ?2))
            AND t.id NOT IN (SELECT task_id FROM agent_chain_steps WHERE task_id <> '')
          ORDER BY t.updated_at DESC
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![workspace_id, recent_cutoff(), MAX_TASKS], |row| {
        Ok(TaskLine {
            title: row.get(0)?,
            agent_name: row.get(1)?,
            status: row.get(2)?,
            repo: row.get(3)?,
            last_error: row.get(4)?,
        })
    })?;
    rows.collect()
}

fn chain_kind_label(kind: &str) -> &'static str {
    match kind {
        "story" => "Historia (SDD)",
        "hybrid" => "Ejecución híbrida",
        _ => "Cadena",
    }
}

fn status_label(status: &str) -> &str {
    match status {
        "queued" => "en cola",
        "running" => "ejecutándose",
        "gated" => "esperando aprobación en una compuerta",
        "paused" => "en pausa",
        "failed" => "falló",
        "done" => "terminada",
        "aborted" => "abortada",
        "error" => "falló",
        "idle" => "en espera",
        other => other,
    }
}

/// `text` on one line, cut to `max` characters with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        one_line
    } else {
        format!("{}…", one_line.chars().take(max).collect::<String>())
    }
}

/// The block appended to every message: repositories and agent work, compact.
pub fn live_block(repos: &[RepoLine], chains: &[ChainLine], tasks: &[TaskLine]) -> String {
    let mut out = String::from(
        "\n\n---\nEstado del workspace (lo añade CodeFlow en cada mensaje; no lo escribió el usuario):\nRepositorios:",
    );
    if repos.is_empty() {
        out.push_str(" ninguno.");
    }
    for repo in repos {
        out.push_str(&format!("\n- {} — {}", repo.name, repo.path));
        if !repo.on_disk {
            out.push_str(" (no está en disco)");
        } else if !repo.branch.is_empty() {
            out.push_str(&format!(" (rama {})", repo.branch));
        }
    }
    if chains.is_empty() && tasks.is_empty() {
        out.push_str("\nTrabajo de agentes en curso: ninguno.");
        return out;
    }
    out.push_str("\nTrabajo de agentes en curso:");
    for chain in chains {
        out.push_str(&format!(
            "\n- {} «{}» — {}",
            chain_kind_label(&chain.kind),
            clip(&chain.title, 80),
            status_label(&chain.status)
        ));
        if let Some(step) = &chain.step {
            out.push_str(&format!("; paso {}/{}", step.index + 1, chain.step_count.max(step.index + 1)));
            if !step.agent_name.is_empty() {
                out.push_str(&format!(": {}", step.agent_name));
            }
            if !step.phase.is_empty() {
                out.push_str(&format!(" (fase {})", step.phase));
            }
            if !step.repo.is_empty() {
                out.push_str(&format!(" en {}", step.repo));
            }
            if chain.status == "gated" && !step.pending_input.trim().is_empty() {
                out.push_str(&format!("; enviará al aprobar: «{}»", clip(&step.pending_input, 220)));
            }
            if !step.last_error.trim().is_empty() && chain.status != "running" {
                out.push_str(&format!("; error: {}", clip(&step.last_error, 160)));
            }
        }
        if !chain.last_reason.trim().is_empty() && chain.status != "running" {
            out.push_str(&format!("; motivo: {}", clip(&chain.last_reason, 120)));
        }
        if !chain.repos.is_empty() {
            out.push_str(&format!("; repos: {}", chain.repos.join(", ")));
        }
        out.push_str(&format!("; id {}", chain.id));
    }
    for task in tasks {
        out.push_str(&format!("\n- Tarea «{}»", clip(&task.title, 80)));
        if !task.agent_name.is_empty() {
            out.push_str(&format!(" ({})", task.agent_name));
        }
        if !task.repo.is_empty() {
            out.push_str(&format!(" en {}", task.repo));
        }
        out.push_str(&format!(" — {}", status_label(&task.status)));
        if task.status == "error" && !task.last_error.trim().is_empty() {
            out.push_str(&format!(": {}", clip(&task.last_error, 160)));
        }
    }
    out
}

/// How much of one step's handoff a chain's brief carries — its tail, which is where an agent says
/// what it did and what is left.
const BRIEF_OUTPUT_CHARS: usize = 1_500;
const BRIEF_TOTAL_CHARS: usize = 12_000;

/// Everything a chain is about, for a chat opened to carry it on: its goal and each step — who, in
/// which repository, what it was told, how it went and the end of what it answered. `None` for a
/// chain that no longer exists.
pub fn chain_brief(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<String>> {
    let head: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT title, goal, kind, status FROM agent_chains WHERE id = ?1",
            params![chain_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((title, goal, kind, status)) = head else { return Ok(None) };
    let mut out = format!(
        "{} «{}» (id {chain_id}) — {}.\nObjetivo: {}\nRepositorios: {}\nPasos:",
        chain_kind_label(&kind),
        title,
        status_label(&status),
        if goal.trim().is_empty() { "(sin objetivo escrito)".to_string() } else { goal.trim().to_string() },
        chain_repo_names(conn, chain_id)?.join(", "),
    );
    let mut stmt = conn.prepare(
        "SELECT s.step_index, s.agent_name, s.phase, s.status, COALESCE(p.name, ''), s.instruction,
                s.output_text, s.last_error
           FROM agent_chain_steps s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.chain_id = ?1 ORDER BY s.step_index",
    )?;
    let steps = stmt.query_map(params![chain_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    for step in steps {
        let (index, agent, phase, status, repo, instruction, output, error) = step?;
        out.push_str(&format!("\n{}. {}", index + 1, if agent.is_empty() { "agente" } else { &agent }));
        if !phase.is_empty() {
            out.push_str(&format!(" (fase {phase})"));
        }
        if !repo.is_empty() {
            out.push_str(&format!(" en {repo}"));
        }
        out.push_str(&format!(" — {status}"));
        if !instruction.trim().is_empty() {
            out.push_str(&format!("\n   Instrucción: {}", clip(&instruction, 400)));
        }
        if !output.trim().is_empty() {
            let tail: String = {
                let chars: Vec<char> = output.trim().chars().collect();
                let start = chars.len().saturating_sub(BRIEF_OUTPUT_CHARS);
                let kept: String = chars[start..].iter().collect();
                if start > 0 { format!("…{kept}") } else { kept }
            };
            out.push_str(&format!("\n   Resultado: {tail}"));
        }
        if !error.trim().is_empty() {
            out.push_str(&format!("\n   Error: {}", clip(&error, 300)));
        }
        if out.chars().count() > BRIEF_TOTAL_CHARS {
            out = out.chars().take(BRIEF_TOTAL_CHARS).collect::<String>();
            out.push_str("\n…(recortado)");
            break;
        }
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'Flow', 'book', '#111', 0, '2026-01-01T00:00:00+00:00'),
                        ('w2', 'Other', 'book', '#111', 1, '2026-01-01T00:00:00+00:00');
             INSERT INTO projects (id, workspace_id, name, local_path, color, icon, sort_order, created_at)
                 VALUES ('p1', 'w1', 'api', '/nowhere/api', '#222', 'folder', 0, '2026-01-01T00:00:00+00:00'),
                        ('p2', 'w1', 'web', '/nowhere/web', '#222', 'folder', 1, '2026-01-01T00:00:00+00:00'),
                        ('p3', 'w2', 'elsewhere', '/nowhere/x', '#222', 'folder', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
    }

    fn chain(conn: &Connection, id: &str, project: &str, kind: &str, status: &str, updated_at: &str) {
        conn.execute(
            "INSERT INTO agent_chains (id, project_id, title, goal, status, current_step, step_count, kind, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'ship it', ?4, 1, 2, ?5, ?6, ?6)",
            params![id, project, format!("Plan {id}"), status, kind, updated_at],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_chain_repos (chain_id, project_id, position) VALUES (?1, ?2, 0)",
            params![id, project],
        )
        .unwrap();
    }

    fn step(conn: &Connection, chain_id: &str, index: i64, status: &str, pending_input: &str, output: &str) {
        conn.execute(
            "INSERT INTO agent_chain_steps (id, chain_id, step_index, agent_name, phase, status, pending_input,
                                            output_text, project_id, instruction, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'implement', ?5, ?6, ?7, 'p2', 'do the thing', '2026-01-01', '2026-01-01')",
            params![format!("{chain_id}-{index}"), chain_id, index, format!("Agent{index}"), status, pending_input, output],
        )
        .unwrap();
    }

    #[test]
    fn repos_lists_the_workspace_only_and_says_what_is_missing() {
        let conn = seeded();
        let repos = repos(&conn, "w1").unwrap();
        assert_eq!(repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["api", "web"]);
        assert!(repos.iter().all(|r| !r.on_disk));
        assert!(extra_dirs(&repos).is_empty());
        let block = live_block(&repos, &[], &[]);
        assert!(block.contains("- api — /nowhere/api (no está en disco)"));
        assert!(block.contains("Trabajo de agentes en curso: ninguno."));
    }

    #[test]
    fn the_snapshot_carries_open_chains_and_their_gate_but_not_finished_or_foreign_ones() {
        let conn = seeded();
        let now = chrono::Utc::now().to_rfc3339();
        chain(&conn, "gated", "p1", "story", "gated", &now);
        step(&conn, "gated", 0, "done", "", "analysed");
        step(&conn, "gated", 1, "pending", "Implement the plan in web", "");
        chain(&conn, "done", "p1", "chain", "done", &now);
        chain(&conn, "old-fail", "p1", "chain", "failed", "2020-01-01T00:00:00+00:00");
        chain(&conn, "foreign", "p3", "chain", "running", &now);

        let listed = chains(&conn, "w1", "").unwrap();
        assert_eq!(listed.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["gated"]);
        let gated = &listed[0];
        let at = gated.step.as_ref().unwrap();
        assert_eq!((at.index, at.status.as_str(), at.repo.as_str()), (1, "pending", "web"));
        assert_eq!(gated.repos, vec!["api".to_string()]);

        let block = live_block(&[], &listed, &[]);
        assert!(block.contains("Historia (SDD) «Plan gated» — esperando aprobación"), "{block}");
        assert!(block.contains("paso 2/2: Agent1 (fase implement) en web"), "{block}");
        assert!(block.contains("enviará al aprobar: «Implement the plan in web»"), "{block}");
        assert!(block.contains("id gated"));

        // A chain the chat was opened for is listed whatever its state, first.
        let focused = chains(&conn, "w1", "done").unwrap();
        assert_eq!(focused.first().map(|c| c.id.as_str()), Some("done"));
    }

    #[test]
    fn tasks_skip_chain_steps_and_old_failures() {
        let conn = seeded();
        let now = chrono::Utc::now().to_rfc3339();
        for (id, status, updated) in [("t-run", "running", now.as_str()), ("t-old", "error", "2020-01-01"), ("t-step", "running", now.as_str())] {
            conn.execute(
                "INSERT INTO agent_tasks (id, workspace_id, project_id, agent_name, title, conversation_id, status, created_at, updated_at)
                 VALUES (?1, 'w1', 'p1', 'Reviewer', ?1, ?1, ?2, ?3, ?3)",
                params![id, status, updated],
            )
            .unwrap();
        }
        chain(&conn, "c", "p1", "chain", "running", &now);
        conn.execute(
            "INSERT INTO agent_chain_steps (id, chain_id, step_index, task_id, created_at, updated_at)
             VALUES ('c-0', 'c', 0, 't-step', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        let listed = tasks(&conn, "w1").unwrap();
        assert_eq!(listed.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["t-run"]);
        let block = live_block(&[], &[], &listed);
        assert!(block.contains("- Tarea «t-run» (Reviewer) en api — ejecutándose"), "{block}");
    }

    #[test]
    fn a_chain_brief_tells_every_step_and_keeps_the_tail_of_long_output() {
        let conn = seeded();
        chain(&conn, "c", "p1", "hybrid", "paused", "2026-01-01");
        let long = format!("{}END", "x".repeat(5_000));
        step(&conn, "c", 0, "done", "", &long);
        step(&conn, "c", 1, "pending", "", "");
        let brief = chain_brief(&conn, "c").unwrap().unwrap();
        assert!(brief.starts_with("Ejecución híbrida «Plan c» (id c) — en pausa."), "{brief}");
        assert!(brief.contains("Objetivo: ship it"));
        assert!(brief.contains("1. Agent0 (fase implement) en web — done"));
        assert!(brief.contains("Instrucción: do the thing"));
        assert!(brief.contains("END"));
        assert!(brief.contains("Resultado: …"));
        assert!(brief.contains("2. Agent1"));
        assert!(chain_brief(&conn, "missing").unwrap().is_none());
    }

    #[test]
    fn the_working_dir_is_one_safe_segment_per_workspace() {
        let dir = working_dir("../evil/ws");
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("___evil_ws"));
        assert_eq!(dir.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()), Some("workspace-chat"));
    }
}
