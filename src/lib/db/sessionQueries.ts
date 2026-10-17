import type { DbKind } from "../../types/database";

/**
 * What the sessions monitor asks each engine, and how it stops a session.
 *
 * Plain catalog SQL over the ordinary `db_execute`, so it needs no driver code of its own and shows
 * exactly what the account is allowed to see: a login without `pg_read_all_stats` (or `VIEW SERVER
 * STATE`, `PROCESS`, `SELECT ON v$session`) gets its own sessions only, or an error naming the
 * missing grant — the server's answer, not ours.
 *
 * Every listing returns the same column names first — `id`, `user`, `database`, `state`,
 * `seconds`, `blocked_by`, `query` — so the monitor can sort by time and mark blocking chains
 * without knowing the engine. `id` is whatever the kill statement takes (`sid,serial#` on Oracle).
 */
export interface SessionDialect {
  list: string;
  /** Stops the running statement, keeping the session. Absent where the engine has no such thing. */
  cancel?: (id: string) => string;
  kill: (id: string) => string;
}

const digits = (id: string) => {
  if (!/^\d+$/.test(id)) throw new Error(`not a session id: ${id}`);
  return id;
};

export function sessionDialect(kind: DbKind): SessionDialect | null {
  switch (kind) {
    case "postgres":
    case "supabase":
      return {
        list: `SELECT pid AS id, usename AS "user", datname AS "database", state,
  COALESCE(EXTRACT(EPOCH FROM now() - query_start)::bigint, 0) AS seconds,
  NULLIF(array_to_string(pg_blocking_pids(pid), ','), '') AS blocked_by,
  query, application_name AS app, client_addr::text AS client,
  NULLIF(concat_ws(':', wait_event_type, wait_event), '') AS waiting
FROM pg_stat_activity
WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'
ORDER BY seconds DESC`,
        cancel: (id) => `SELECT pg_cancel_backend(${digits(id)})`,
        kill: (id) => `SELECT pg_terminate_backend(${digits(id)})`,
      };
    case "mysql":
    case "mariadb":
      return {
        list: `SELECT ID AS id, USER AS user, DB AS \`database\`, COMMAND AS state, TIME AS seconds,
  NULL AS blocked_by, INFO AS query, HOST AS client, STATE AS waiting
FROM information_schema.PROCESSLIST
WHERE ID <> CONNECTION_ID()
ORDER BY TIME DESC`,
        cancel: (id) => `KILL QUERY ${digits(id)}`,
        kill: (id) => `KILL ${digits(id)}`,
      };
    case "sqlserver":
      return {
        list: `SELECT s.session_id AS id, s.login_name AS [user], DB_NAME(COALESCE(r.database_id, s.database_id)) AS [database],
  COALESCE(r.status, s.status) AS state, COALESCE(r.total_elapsed_time, 0) / 1000 AS seconds,
  NULLIF(r.blocking_session_id, 0) AS blocked_by, t.text AS query, s.program_name AS app, s.host_name AS client,
  r.wait_type AS waiting
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
ORDER BY seconds DESC`,
        kill: (id) => `KILL ${digits(id)}`,
      };
    case "oracle":
      return {
        list: `SELECT s.sid || ',' || s.serial# AS id, s.username AS "user", s.schemaname AS "database", s.status AS state,
  s.last_call_et AS seconds, s.blocking_session AS blocked_by,
  (SELECT q.sql_text FROM v$sql q WHERE q.sql_id = s.sql_id AND ROWNUM = 1) AS query,
  s.program AS app, s.machine AS client, s.event AS waiting
FROM v$session s
WHERE s.type = 'USER' AND s.sid <> SYS_CONTEXT('USERENV', 'SID')
ORDER BY s.last_call_et DESC`,
        cancel: (id) => `ALTER SYSTEM CANCEL SQL '${oracleId(id)}'`,
        kill: (id) => `ALTER SYSTEM KILL SESSION '${oracleId(id)}' IMMEDIATE`,
      };
    default:
      return null;
  }
}

function oracleId(id: string): string {
  if (!/^\d+,\d+$/.test(id)) throw new Error(`not a session id: ${id}`);
  return id;
}

/**
 * Who is holding whom up: the ids that block at least one other session. A `blocked_by` may list
 * several (Postgres' `pg_blocking_pids` does), comma-separated.
 */
export function blockers(rows: { id: string; blockedBy: string | null }[]): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    for (const id of (row.blockedBy ?? "").split(",")) {
      // Oracle's `blocking_session` is a bare SID; match it against the `sid,serial#` ids.
      const trimmed = id.trim();
      if (!trimmed) continue;
      const hit = rows.find((other) => other.id === trimmed || other.id.split(",")[0] === trimmed);
      if (hit) out.add(hit.id);
    }
  }
  return out;
}
