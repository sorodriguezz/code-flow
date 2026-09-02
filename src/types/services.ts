/**
 * The Services workspace's shapes.
 *
 * Split out of `domain.ts` because this is a workspace of its own, the way `remote.ts` and
 * `notes.ts` are — and because the three JSON-in-TEXT columns need parsing helpers that would have
 * no business sitting beside `Project`.
 */

/** How a service's command line is built. All three end as one line typed into a pty; the kind
 *  only decides what the editor offers to fill it in with. */
export type ServiceKind = "shell" | "script" | "compose";

/**
 * What "it is up" means for one service.
 *
 * `none` is honest rather than lazy: for a one-shot command (`prisma migrate`, a seed script) there
 * is nothing to wait for but the process itself. Everything else exists so `dependsOn` can mean
 * something — starting the API the instant the database *process* exists, rather than when it
 * accepts connections, is the failure this whole feature is here to avoid.
 */
export type ReadyKind = "none" | "port" | "log" | "http";

/** A service exactly as the database holds it: the three list columns are still JSON. */
export interface ServiceRow {
  id: string;
  workspace_id: string;
  group_id: string | null;
  name: string;
  kind: ServiceKind;
  project_id: string | null;
  cwd: string;
  command: string;
  /** JSON object. */
  env: string;
  /** JSON array of numbers. */
  ports: string;
  ready_kind: ReadyKind;
  ready_value: string;
  /** JSON array of service ids. */
  depends_on: string;
  autorestart: boolean;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ServiceGroup {
  id: string;
  workspace_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * What a service is doing right now.
 *
 * `waiting` is not a variant of `starting`, and keeping them apart is what makes a slow group
 * legible: `waiting` means nothing has been launched because a dependency has not opened its gate,
 * and the row can name which one. `starting` means the process is up and the gate has not passed
 * yet. Collapsed into one state, the answer to "why is nothing happening" would be unavailable
 * exactly when it is asked.
 */
export type ServiceStatus = "stopped" | "waiting" | "starting" | "ready" | "failed";

/** The live half — never persisted. See the note at the top of `db/service_queries.rs`. */
export interface ServiceRuntime {
  status: ServiceStatus;
  /** The terminal session this service is running in, or `null` when it is not running. The pane
   *  renders from this id exactly as it renders a shell in the dock. */
  sessionId: string | null;
  /** When the process started, for the uptime on the row. */
  startedAt: number | null;
  /** Why it failed, when it did. Empty otherwise rather than stale: a message left over from a
   *  previous failure on a service that is now running is worse than no message. */
  error: string;
  /** Which service this one is waiting for, while `waiting`. The answer to "why is nothing
   *  happening", available at the moment it is asked. */
  blockedBy: string | null;
  /** How many times it has been restarted automatically since the last manual start. Reset by a
   *  manual start; capped by `MAX_AUTORESTARTS`. */
  restarts: number;
}

/** Parses one of the JSON columns, answering with the fallback rather than throwing — a row that
 *  somehow holds bad JSON must not take the whole list down with it. */
export function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export const serviceDeps = (service: ServiceRow): string[] => parseJson<string[]>(service.depends_on, []);
export const servicePorts = (service: ServiceRow): number[] => parseJson<number[]>(service.ports, []);
export const serviceEnv = (service: ServiceRow): Record<string, string> =>
  parseJson<Record<string, string>>(service.env, {});
