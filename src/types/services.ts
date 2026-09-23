/**
 * The Services workspace's shapes.
 *
 * Split out of `domain.ts` because this is a workspace of its own, the way `remote.ts` and
 * `notes.ts` are — and because the JSON-in-TEXT columns need parsing helpers that would have no
 * business sitting beside `Project`.
 */

/** How a service's command line came about. All of them end as one line run through a shell; the
 *  kind is set from what created it (the detector, or a command typed by hand) and only decides the
 *  row's glyph. */
export type ServiceKind = "shell" | "script" | "compose";

/**
 * What "it is up" means for one service — what the services waiting for it wait for.
 *
 * - `auto`: the supervisor watches the process tree for a listening port (and, for Compose, the
 *   containers). A process that never opens one is up once it has run a few seconds and gone quiet;
 *   one that exits cleanly before either is a task that finished.
 * - `port` / `log` / `http`: something specific, for when `auto` cannot see it.
 * - `exit`: a one-shot — migrations, seeds. Up means finished cleanly.
 * - `none`: up the moment the process exists.
 */
export type ReadyKind = "auto" | "port" | "log" | "http" | "exit" | "none";

/** A service exactly as the database holds it: the list columns are still JSON. */
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
  /** JSON array of numbers the user pinned. Optional — ports are found by themselves. */
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
  /** JSON array of the ports the last run was seen listening on. Written by the supervisor. */
  detected_ports: string;
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
 * What a service is doing right now, as the supervisor tells it.
 *
 * `waiting` is not a variant of `starting`: `waiting` means nothing has been launched because a
 * dependency has not passed its gate (and `blockedBy` names which), `starting` means the process is
 * up and its own gate has not passed yet. `completed` is a one-shot that finished cleanly — it
 * satisfies its dependents exactly like `ready`.
 */
export type ServiceStatus =
  | "stopped"
  | "waiting"
  | "starting"
  | "ready"
  | "completed"
  | "failed"
  | "stopping"
  | "restarting";

/** Why a service is `failed` (or `restarting`), for the frontend to put into words. */
export type ServiceError =
  | "exited"
  | "exitedClean"
  | "exitedBeforeReady"
  | "gateTimedOut"
  | "dependencyFailed"
  | "dependencyStopped"
  | "spawn";

/** The live half — never persisted, owned by the supervisor. See `services/supervisor.rs`. */
export interface ServiceRuntime {
  id: string;
  workspaceId: string;
  name: string;
  status: ServiceStatus;
  /** A process exists. Apart from `status` because a service can be `failed` and still running (a
   *  gate that never passed), and its row must still offer to stop it. */
  alive: boolean;
  /** The terminal session the current process runs in. */
  sessionId: string | null;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  exitCode: number | null;
  error: ServiceError | null;
  /** Free text to go with `error` — a spawn failure's own message. */
  detail: string | null;
  /** The service this one is waiting for, or whose failure stopped it. */
  blockedBy: string | null;
  restarts: number;
  /** Listening right now, found in the process tree (or published by Compose). */
  ports: number[];
  /** Seen on an earlier run — where a stopped service will be. */
  knownPorts: number[];
}

/** One thing a folder can run, as the detector read it. See `services/detect.rs`. */
export interface ServiceCandidate {
  name: string;
  command: string;
  /** Relative to the scanned folder; empty is the folder itself. */
  cwd: string;
  kind: ServiceKind;
  /** The file it was read from. */
  source: string;
  /** What that file says it does — a script's body, a compose file's services. */
  detail: string;
  readyKind: ReadyKind;
  ports: number[];
  /**
   * Ports the service has to be told about because its process tree will never show them — the
   * ones a `docker run -p` publishes, which Docker holds. They become the service's pinned ports,
   * which its readiness gate probes. Empty for everything else.
   */
  pinnedPorts: number[];
  score: number;
}

export interface ProjectCandidates {
  projectId: string;
  projectName: string;
  path: string;
  candidates: ServiceCandidate[];
}

/** One listening TCP port on the machine, and the service it belongs to when it is one of ours. */
export interface ListeningPort {
  port: number;
  address: string;
  pid: number;
  process: string;
  serviceId: string | null;
  serviceName: string | null;
  workspaceId: string | null;
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
export const serviceDetectedPorts = (service: ServiceRow): number[] =>
  parseJson<number[]>(service.detected_ports ?? "[]", []);
export const serviceEnv = (service: ServiceRow): Record<string, string> =>
  parseJson<Record<string, string>>(service.env, {});

/** Whether a command is a `docker compose up`, which decides the service's kind — the supervisor
 *  reads the command itself. */
export const isComposeCommand = (command: string): boolean =>
  /\bdocker(-compose|\s+compose)\b[\s\S]*\bup\b/.test(command);

/** Whether a command's work happens in containers — a Compose stack or a `docker run` — which puts
 *  the container glyph on its row. */
export const runsContainers = (command: string): boolean =>
  isComposeCommand(command) || /\bdocker\s+(container\s+)?run\b/.test(command);
