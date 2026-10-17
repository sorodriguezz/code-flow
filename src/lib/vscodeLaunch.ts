import { fillVariables, stripJsonc } from "./vscodeTasks";
import type { Platform } from "./platform";

/**
 * The repository's debug configurations, read from `.vscode/launch.json` — the file VS Code users
 * already have — so «Ejecutar y depurar» offers "Launch API" and "Debug tests" by name instead of a
 * program to type.
 *
 * Each `type` is mapped onto one of the app's debuggers (`debugAdapters.ts`): `node` / `pwa-node` to
 * the built-in Node backend, `python` / `debugpy` to debugpy, `coreclr` to netcoredbg. The adapters
 * receive the configuration as VS Code would send it — `env`, `justMyCode`, `module`, `console` —
 * since the launch object *is* the same JSON (see `DebugAdapter.launch`). What the built-in Node
 * backend reads is `program`, `args` and `cwd`; a configuration that needs more than that (`attach`,
 * `runtimeExecutable`) is listed, with the reason it cannot start here.
 *
 * `${workspaceFolder}`, `${file}` and the rest are filled in as `tasks.json`'s are, and the
 * `windows` / `osx` / `linux` blocks are merged over the configuration on their platform.
 * `preLaunchTask` is not run: the Tareas tab is where it is, and the row says so.
 */

export interface LaunchEntry {
  name: string;
  /** `debugAdapters` id, or `null` when nothing here can run this `type`. */
  adapterId: string | null;
  /** Absolute, variables filled in. Empty when the configuration names a module instead. */
  program: string;
  args: string[];
  cwd: string;
  /** The whole configuration, filled in, minus the keys that are VS Code's own and not the adapter's. */
  launch: Record<string, unknown>;
  /** Why it cannot start here — shown on the row. `null` for one that can. */
  unsupported: string | null;
  preLaunchTask: string | null;
}

export interface LaunchContext {
  repoPath: string;
  /** The open file, repo-relative. */
  file: string | null;
  platform: Platform;
}

const ADAPTER_OF_TYPE: Record<string, string> = {
  node: "node",
  "pwa-node": "node",
  node2: "node",
  python: "python",
  debugpy: "python",
  coreclr: "coreclr",
};

/** Keys the editor reads and the adapter must not be sent. */
const EDITOR_KEYS = new Set([
  "name",
  "preLaunchTask",
  "postDebugTask",
  "presentation",
  "internalConsoleOptions",
  "serverReadyAction",
  "windows",
  "osx",
  "linux",
]);

const PLATFORM_KEY: Record<Platform, string | null> = {
  windows: "windows",
  macos: "osx",
  linux: "linux",
  unknown: null,
};

function fillDeep(value: unknown, ctx: LaunchContext): unknown {
  if (typeof value === "string") return fillVariables(value, ctx);
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, ctx));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fillDeep(inner, ctx)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Relative paths in a configuration are relative to the repository, as in VS Code. */
function absolute(path: string, root: string): string {
  if (!path) return path;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(path)) return path;
  return `${root}/${path.replace(/^\.\//, "")}`;
}

/** The configurations of a `launch.json` text — `[]` when it does not parse. */
export function parseLaunch(text: string, ctx: LaunchContext): LaunchEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return [];
  }
  const configurations = isRecord(parsed) && Array.isArray(parsed.configurations) ? parsed.configurations : [];
  const root = ctx.repoPath.replace(/[\\/]+$/, "");
  const platformKey = PLATFORM_KEY[ctx.platform];
  const entries: LaunchEntry[] = [];

  for (const raw of configurations) {
    if (!isRecord(raw) || typeof raw.name !== "string") continue;
    const own = platformKey && isRecord(raw[platformKey]) ? (raw[platformKey] as Record<string, unknown>) : {};
    const merged = fillDeep({ ...raw, ...own }, ctx) as Record<string, unknown>;
    const type = typeof merged.type === "string" ? merged.type : "";
    const request = merged.request === "attach" ? "attach" : "launch";
    const adapterId = ADAPTER_OF_TYPE[type] ?? null;
    const program = typeof merged.program === "string" ? absolute(merged.program, root) : "";
    const args = Array.isArray(merged.args) ? merged.args.filter((arg): arg is string => typeof arg === "string") : [];
    const cwd = typeof merged.cwd === "string" ? absolute(merged.cwd, root) : root;

    const launch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(merged)) if (!EDITOR_KEYS.has(key)) launch[key] = value;
    if (program) launch.program = program;
    launch.cwd = cwd;

    let unsupported: string | null = null;
    if (!adapterId) unsupported = type ? `type "${type}"` : "type";
    else if (adapterId === "node") {
      if (request === "attach") unsupported = "attach";
      else if (typeof merged.runtimeExecutable === "string" && merged.runtimeExecutable !== "node")
        unsupported = "runtimeExecutable";
      else if (!program) unsupported = "program";
    } else if (adapterId === "python" && request === "launch" && !program && typeof merged.module !== "string") {
      unsupported = "program";
    }

    entries.push({
      name: raw.name,
      adapterId,
      program,
      args,
      cwd,
      launch,
      unsupported,
      preLaunchTask: typeof raw.preLaunchTask === "string" ? raw.preLaunchTask : null,
    });
  }
  return entries;
}

/** What «Crear launch.json» writes: one configuration for the language of the open file. */
export function launchTemplate(adapterId: string | null): string {
  const configuration =
    adapterId === "python"
      ? {
          name: "Python: archivo actual",
          type: "debugpy",
          request: "launch",
          program: "${file}",
          console: "internalConsole",
          justMyCode: true,
        }
      : adapterId === "coreclr"
        ? {
            name: ".NET: lanzar",
            type: "coreclr",
            request: "launch",
            program: "${workspaceFolder}/bin/Debug/net8.0/app.dll",
            cwd: "${workspaceFolder}",
          }
        : {
            name: "Node: archivo actual",
            type: "node",
            request: "launch",
            program: "${file}",
            cwd: "${workspaceFolder}",
          };
  return `${JSON.stringify({ version: "0.2.0", configurations: [configuration] }, null, 2)}\n`;
}
