//! The assistant panel's **workspace chat**: one conversation that talks to every repository of a
//! workspace at once.
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
//! - **What it is told once.** [`system_prompt`]: the role, and that the repositories arrive with
//!   every message. A system prompt only reaches an engine when its session starts, so nothing that
//!   changes lives there.
//! - **What it is told every turn.** [`live_block`]: the repositories — path, branch, and the
//!   specification or harness folders the user keeps in them ([`SPEC_DIRS`]: spec-kit, OpenSpec,
//!   Kiro…), which the model is told to read and follow.
//!
//! It is not tied to the app's own agents. A chat opened from a chain to carry it on («Continuar en
//! chat del workspace», in Tareas) is the one exception, and it is opt-in: that chain's whole brief
//! ([`chain_brief`]) rides the first turn of the session.

use rusqlite::{params, Connection, OptionalExtension};

/// One repository of the workspace, as the model is told about it.
#[derive(Debug, Clone, PartialEq)]
pub struct RepoLine {
    /// The project's id.
    pub id: String,
    pub name: String,
    pub path: String,
    /// The checked-out branch; `""` when detached, unreadable or missing.
    pub branch: String,
    pub on_disk: bool,
    /// Whether it is a git repository (its root, as the checkpoints open it). A folder that exists
    /// but is not one is handed to the engine all the same, yet a turn cannot snapshot it: edits
    /// there have no restore point.
    pub is_git: bool,
    /// The [`SPEC_DIRS`] it has, in that order, with a trailing `/`.
    pub spec_dirs: Vec<String>,
}

/// Folders where specification-driven or harness tooling keeps a repository's specs, plans and
/// steering — spec-kit (`.specify/`, `specs/`), OpenSpec, Kiro, Agent OS, BMAD, and a plain
/// `harness/`. Whichever of them a repository has is named on its line, so the model reads what the
/// user left there instead of rediscovering, or contradicting, it.
pub const SPEC_DIRS: &[&str] =
    &[".specify", "specs", "openspec", ".kiro/specs", ".kiro/steering", ".agent-os", ".bmad-core", "harness", ".harness"];

/// The [`SPEC_DIRS`] under `root` that are folders.
pub fn spec_dirs(root: &std::path::Path) -> Vec<String> {
    SPEC_DIRS.iter().filter(|dir| root.join(dir).is_dir()).map(|dir| format!("{dir}/")).collect()
}

/// The workspace's repositories (`queries::list_projects`, the sidebar's order) with their branch and
/// specification folders read off disk — opened one by one, so not under the database lock.
pub fn repo_lines(projects: Vec<crate::db::models::Project>) -> Vec<RepoLine> {
    projects
        .into_iter()
        .map(|project| {
            let root = std::path::Path::new(&project.local_path);
            let on_disk = root.is_dir();
            let branch = if on_disk { current_branch(&project.local_path) } else { String::new() };
            let spec_dirs = if on_disk { spec_dirs(root) } else { Vec::new() };
            let is_git = on_disk && git2::Repository::open(&project.local_path).is_ok();
            RepoLine { id: project.id, name: project.name, path: project.local_path, branch, on_disk, is_git, spec_dirs }
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

/// The folders the engine can write in that no turn can snapshot: on disk but not a git repository.
/// The chat reply names them so the UI can warn that edits there cannot be undone.
pub fn unprotected_dirs(repos: &[RepoLine]) -> Vec<String> {
    repos.iter().filter(|repo| repo.on_disk && !repo.is_git).map(|repo| repo.path.clone()).collect()
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

/// The workspace whose chat folder `dir` is ([`working_dir`]), however it is spelled. What lets a
/// tool that only knows where its run works — the knowledge search, the memories — answer for the
/// whole workspace there.
pub fn workspace_of_dir(conn: &Connection, dir: &str) -> Option<String> {
    if !dir.contains("workspace-chat") {
        return None;
    }
    let wanted = crate::repo_identity::canonical_path(dir);
    crate::db::queries::list_workspaces(conn)
        .ok()?
        .into_iter()
        .map(|workspace| workspace.id)
        .find(|id| crate::repo_identity::canonical_path(&working_dir(id).to_string_lossy()) == wanted)
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
         Si junto a un repositorio el bloque nombra carpetas de especificación o de harness, léelas antes \
         de cambiar lo que describen y síguelas. Si tienes la herramienta search_knowledge, úsala antes de \
         suponer por qué o cómo hace algo un repositorio, o qué se decidió: busca en todos los repositorios, \
         las carpetas de documentos y las notas del workspace. No menciones el bloque salvo que te pregunten \
         por él o sea relevante. Responde en el idioma del usuario."
    )
}

fn chain_repo_names(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(p.name, '') FROM agent_chain_repos r LEFT JOIN projects p ON p.id = r.project_id
          WHERE r.chain_id = ?1 ORDER BY r.position",
    )?;
    let names = stmt.query_map(params![chain_id], |row| row.get::<_, String>(0))?;
    names.filter(|name| !matches!(name, Ok(n) if n.is_empty())).collect()
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

/// The block appended to every message: the repositories, each with its path, its branch and the
/// specification folders it has.
pub fn live_block(repos: &[RepoLine]) -> String {
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
            continue;
        }
        if !repo.branch.is_empty() {
            out.push_str(&format!(" (rama {})", repo.branch));
        }
        if !repo.spec_dirs.is_empty() {
            out.push_str(&format!("; carpetas de especificación: {}", repo.spec_dirs.join(", ")));
        }
        if !repo.is_git {
            out.push_str(
                " (no es un repositorio git: sin punto de restauración; los cambios que se hagan ahí no se pueden deshacer desde CodeFlow)",
            );
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
    // What the system prompt used to say for every workspace chat, now said only where a chain is
    // being carried on: the chat works in the repositories, the chain's controls stay in Tareas.
    out.push_str(
        "\nNo puedes aprobar compuertas ni reanudar o detener esta cadena desde el chat: si hace falta, \
         dile al usuario que lo haga en Tareas.",
    );
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
        let repos = repo_lines(crate::db::queries::list_projects(&conn, "w1").unwrap());
        assert_eq!(repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["api", "web"]);
        assert!(repos.iter().all(|r| !r.on_disk && r.spec_dirs.is_empty()));
        assert!(extra_dirs(&repos).is_empty());
        let block = live_block(&repos);
        assert!(block.contains("- api — /nowhere/api (no está en disco)"));
        // Repositories only: the app's own agents are not this chat's business.
        assert!(!block.contains("agentes"), "{block}");
        assert!(live_block(&[]).ends_with("Repositorios: ninguno."));
    }

    /// The specification and harness folders a user keeps in a repository are named on its line, so
    /// the model reads them; a file with one of those names is not a folder and is not named.
    #[test]
    fn a_repository_s_spec_folders_are_named_on_its_line() {
        let root = std::env::temp_dir().join(format!("cf-ws-spec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("specs/001-login")).unwrap();
        std::fs::create_dir_all(root.join(".kiro/steering")).unwrap();
        std::fs::create_dir_all(root.join(".kiro/hooks")).unwrap();
        std::fs::write(root.join("harness"), "not a folder").unwrap();
        assert_eq!(spec_dirs(&root), vec!["specs/".to_string(), ".kiro/steering/".to_string()]);

        let line = RepoLine {
            id: "p".into(),
            name: "api".into(),
            path: root.to_string_lossy().into_owned(),
            branch: "main".into(),
            on_disk: true,
            is_git: true,
            spec_dirs: spec_dirs(&root),
        };
        let block = live_block(std::slice::from_ref(&line));
        assert!(block.ends_with("(rama main); carpetas de especificación: specs/, .kiro/steering/"), "{block}");
        assert!(system_prompt("Flow", "/tmp/x", true).contains("carpetas de especificación o de harness"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_that_is_not_a_git_repository_is_marked_as_unprotected() {
        let root = std::env::temp_dir().join(format!("cf-ws-nogit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.to_string_lossy().into_owned();
        let plain = RepoLine { id: "n".into(), name: "notes".into(), path: path.clone(), branch: String::new(), on_disk: true, is_git: false, spec_dirs: vec![] };
        let missing = RepoLine { id: "g".into(), name: "gone".into(), path: "/nowhere/gone".into(), branch: String::new(), on_disk: false, is_git: false, spec_dirs: vec![] };
        let block = live_block(&[plain.clone(), missing.clone()]);
        assert!(block.contains("(no es un repositorio git: sin punto de restauración"), "{block}");
        assert!(block.contains("- gone — /nowhere/gone (no está en disco)"), "{block}");
        assert_eq!(unprotected_dirs(&[plain.clone(), missing]), vec![path.clone()], "a missing folder is not writable at all");
        // The engine still gets the folder: only the warning is new.
        assert_eq!(extra_dirs(&[plain]), vec![path]);
        git2::Repository::init(&root).unwrap();
        let lines = repo_lines(vec![crate::db::models::Project {
            id: "p".into(),
            workspace_id: "w".into(),
            name: "repo".into(),
            local_path: root.to_string_lossy().into_owned(),
            remote_url: None,
            color: String::new(),
            icon: String::new(),
            ado_org: None,
            ado_project: None,
            ado_repo_id: None,
            github_owner: None,
            github_repo: None,
            github_host: None,
            gitlab_project: None,
            gitlab_host: None,
            sort_order: 0,
            created_at: String::new(),
            bitbucket_workspace: None,
            bitbucket_repo: None,
        }]);
        assert!(lines[0].is_git && unprotected_dirs(&lines).is_empty());
        let _ = std::fs::remove_dir_all(&root);
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
        assert!(brief.ends_with("dile al usuario que lo haga en Tareas."), "{brief}");
        assert!(chain_brief(&conn, "missing").unwrap().is_none());
    }

    #[test]
    fn the_working_dir_is_one_safe_segment_per_workspace() {
        let dir = working_dir("../evil/ws");
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("___evil_ws"));
        assert_eq!(dir.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()), Some("workspace-chat"));
    }
}
