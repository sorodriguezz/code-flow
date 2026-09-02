//! CRUD over `services` and `service_groups` — the Services workspace's definitions.
//!
//! Scoped per workspace like `remote_queries` and `datasource_queries`, and for a stronger reason
//! than either: the thing a group starts is a *system*, and a system spans repositories. A service
//! filed under one checkout could not name the backend in another that it waits for.
//!
//! # What is deliberately not stored
//!
//! Anything about what is *running*. No pid, no status, no session id. Those are facts about this
//! process, and a row claiming a pid that died with the previous launch is worse than no row: it
//! would make the list confidently wrong every morning. The live state is the terminal registry's,
//! keyed by the session each service was started into, and it is rebuilt from nothing on every
//! launch — which is the correct amount of memory for it to have.
//!
//! # JSON in TEXT columns
//!
//! `env`, `ports` and `depends_on` are JSON, parsed on the frontend. The alternative — three side
//! tables and three joins — buys ordering and referential integrity for lists that are read whole,
//! written whole, and never queried across. `depends_on` in particular is walked by the executor in
//! one pass over the workspace's services; a join would not make that faster and would make adding
//! a field a migration.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{Service, ServiceGroup};
use super::queries::now;

const SERVICE_COLUMNS: &str = "id, workspace_id, group_id, name, kind, project_id, cwd, command, \
     env, ports, ready_kind, ready_value, depends_on, autorestart, color, sort_order, created_at, \
     updated_at";
const GROUP_COLUMNS: &str = "id, workspace_id, name, sort_order, created_at, updated_at";

fn map_service(row: &rusqlite::Row) -> rusqlite::Result<Service> {
    Ok(Service {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        group_id: row.get(2)?,
        name: row.get(3)?,
        kind: row.get(4)?,
        project_id: row.get(5)?,
        cwd: row.get(6)?,
        command: row.get(7)?,
        env: row.get(8)?,
        ports: row.get(9)?,
        ready_kind: row.get(10)?,
        ready_value: row.get(11)?,
        depends_on: row.get(12)?,
        autorestart: row.get::<_, i64>(13)? != 0,
        color: row.get(14)?,
        sort_order: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

fn map_group(row: &rusqlite::Row) -> rusqlite::Result<ServiceGroup> {
    Ok(ServiceGroup {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn list_services(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Service>> {
    let sql = format!(
        "SELECT {SERVICE_COLUMNS} FROM services WHERE workspace_id = ?1 ORDER BY sort_order, name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([workspace_id], map_service)?;
    rows.collect()
}

pub fn list_groups(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<ServiceGroup>> {
    let sql = format!(
        "SELECT {GROUP_COLUMNS} FROM service_groups WHERE workspace_id = ?1 ORDER BY sort_order, name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([workspace_id], map_group)?;
    rows.collect()
}

pub fn get_service(conn: &Connection, id: &str) -> rusqlite::Result<Option<Service>> {
    let sql = format!("SELECT {SERVICE_COLUMNS} FROM services WHERE id = ?1");
    conn.query_row(&sql, [id], map_service).optional()
}

/// The next free slot in a workspace's list, so a new row lands at the end rather than at 0 —
/// where it would tie with whatever is already there and sort by name against it.
fn next_order(conn: &Connection, table: &str, workspace_id: &str) -> rusqlite::Result<i64> {
    let sql = format!("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {table} WHERE workspace_id = ?1");
    conn.query_row(&sql, [workspace_id], |row| row.get(0))
}

#[allow(clippy::too_many_arguments)]
pub fn create_service(conn: &Connection, service: &Service) -> rusqlite::Result<Service> {
    let id = if service.id.is_empty() { Uuid::new_v4().to_string() } else { service.id.clone() };
    let stamp = now();
    let order = next_order(conn, "services", &service.workspace_id)?;
    conn.execute(
        "INSERT INTO services (id, workspace_id, group_id, name, kind, project_id, cwd, command,
             env, ports, ready_kind, ready_value, depends_on, autorestart, color, sort_order,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)",
        params![
            id,
            service.workspace_id,
            service.group_id,
            service.name.trim(),
            service.kind,
            service.project_id,
            service.cwd,
            service.command,
            service.env,
            service.ports,
            service.ready_kind,
            service.ready_value,
            service.depends_on,
            i64::from(service.autorestart),
            service.color,
            order,
            stamp,
        ],
    )?;
    get_service(conn, &id).map(|found| found.expect("just inserted"))
}

/// Rewrites everything about a service except where it sits in the list.
///
/// `sort_order` is left alone on purpose: it is moved by dragging, which has its own call, and a
/// save from the editor carrying a stale position would silently undo a reorder made since the
/// dialog was opened.
pub fn update_service(conn: &Connection, service: &Service) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE services SET group_id = ?2, name = ?3, kind = ?4, project_id = ?5, cwd = ?6,
             command = ?7, env = ?8, ports = ?9, ready_kind = ?10, ready_value = ?11,
             depends_on = ?12, autorestart = ?13, color = ?14, updated_at = ?15
         WHERE id = ?1",
        params![
            service.id,
            service.group_id,
            service.name.trim(),
            service.kind,
            service.project_id,
            service.cwd,
            service.command,
            service.env,
            service.ports,
            service.ready_kind,
            service.ready_value,
            service.depends_on,
            i64::from(service.autorestart),
            service.color,
            now(),
        ],
    )?;
    Ok(())
}

/// Deletes a service, and takes it out of everyone else's `depends_on`.
///
/// The second half is what keeps the executor honest: a dependency naming a service that no longer
/// exists would be a gate that never opens, so the group it belongs to would sit at "waiting"
/// forever with nothing on screen explaining what it is waiting for. Rewriting the lists here means
/// the invariant is maintained by the one operation that can break it.
pub fn delete_service(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let workspace_id: Option<String> = conn
        .query_row("SELECT workspace_id FROM services WHERE id = ?1", [id], |row| row.get(0))
        .optional()?;
    conn.execute("DELETE FROM services WHERE id = ?1", [id])?;
    let Some(workspace_id) = workspace_id else { return Ok(()) };

    let siblings = list_services(conn, &workspace_id)?;
    for sibling in siblings {
        let Ok(deps) = serde_json::from_str::<Vec<String>>(&sibling.depends_on) else { continue };
        if !deps.iter().any(|dep| dep == id) {
            continue;
        }
        let kept: Vec<String> = deps.into_iter().filter(|dep| dep != id).collect();
        let encoded = serde_json::to_string(&kept).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "UPDATE services SET depends_on = ?2, updated_at = ?3 WHERE id = ?1",
            params![sibling.id, encoded, now()],
        )?;
    }
    Ok(())
}

pub fn create_group(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<ServiceGroup> {
    let id = Uuid::new_v4().to_string();
    let stamp = now();
    let order = next_order(conn, "service_groups", workspace_id)?;
    conn.execute(
        "INSERT INTO service_groups (id, workspace_id, name, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, workspace_id, name.trim(), order, stamp],
    )?;
    let sql = format!("SELECT {GROUP_COLUMNS} FROM service_groups WHERE id = ?1");
    conn.query_row(&sql, [&id], map_group)
}

pub fn rename_group(conn: &Connection, id: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE service_groups SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name.trim(), now()],
    )?;
    Ok(())
}

/// Deletes a group. Its services survive, ungrouped — `ON DELETE SET NULL` in the schema, said
/// there rather than here so it holds however the row is removed.
pub fn delete_group(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM service_groups WHERE id = ?1", [id])?;
    Ok(())
}

/// Writes a new order for a workspace's services, in the order given.
pub fn reorder_services(conn: &Connection, workspace_id: &str, ids: &[String]) -> rusqlite::Result<()> {
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE services SET sort_order = ?3, updated_at = ?4 WHERE id = ?1 AND workspace_id = ?2",
            params![id, workspace_id, index as i64, now()],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            r#"
            DELETE FROM workspaces;
            INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                VALUES ('w1', 'Tienda', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');
            "#,
        )
        .unwrap();
        conn
    }

    fn service(id: &str, name: &str, deps: &str) -> Service {
        Service {
            id: id.to_string(),
            workspace_id: "w1".into(),
            group_id: None,
            name: name.into(),
            kind: "shell".into(),
            project_id: None,
            cwd: "/tmp".into(),
            command: "true".into(),
            env: "{}".into(),
            ports: "[]".into(),
            ready_kind: "none".into(),
            ready_value: String::new(),
            depends_on: deps.into(),
            autorestart: false,
            color: String::new(),
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// New rows land at the end of the list rather than tying at zero.
    #[test]
    fn services_keep_the_order_they_were_added_in() {
        let conn = seeded();
        create_service(&conn, &service("", "postgres", "[]")).unwrap();
        create_service(&conn, &service("", "redis", "[]")).unwrap();
        create_service(&conn, &service("", "api", "[]")).unwrap();

        let names: Vec<String> =
            list_services(&conn, "w1").unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["postgres", "redis", "api"]);
    }

    /// The invariant `delete_service` exists to keep: a dependency on a service that is gone would
    /// be a gate that never opens, and a group stuck at "waiting" with nothing naming the cause.
    #[test]
    fn deleting_a_service_removes_it_from_everyone_that_waited_for_it() {
        let conn = seeded();
        let db = create_service(&conn, &service("db", "postgres", "[]")).unwrap();
        create_service(&conn, &service("api", "api-auth", &format!("[\"{}\"]", db.id))).unwrap();

        delete_service(&conn, &db.id).unwrap();

        let api = get_service(&conn, "api").unwrap().unwrap();
        assert_eq!(api.depends_on, "[]", "the dangling dependency is gone");
    }

    /// Deleting a group must not take the definitions with it — the services are the work, the
    /// group is only how they are filed.
    #[test]
    fn deleting_a_group_keeps_its_services() {
        let conn = seeded();
        let group = create_group(&conn, "w1", "POC").unwrap();
        let mut svc = service("s1", "web", "[]");
        svc.group_id = Some(group.id.clone());
        create_service(&conn, &svc).unwrap();

        delete_group(&conn, &group.id).unwrap();

        let found = get_service(&conn, "s1").unwrap().unwrap();
        assert_eq!(found.group_id, None, "it is ungrouped, not deleted");
        assert!(list_groups(&conn, "w1").unwrap().is_empty());
    }

    /// A workspace going away takes its services with it, which is what the foreign key is for.
    #[test]
    fn deleting_the_workspace_takes_its_services() {
        let conn = seeded();
        create_service(&conn, &service("s1", "web", "[]")).unwrap();
        conn.execute("PRAGMA foreign_keys = ON", []).unwrap();
        conn.execute("DELETE FROM workspaces WHERE id = 'w1'", []).unwrap();
        assert!(list_services(&conn, "w1").unwrap().is_empty());
    }
}
