/**
 * The repository's tasks, read from `.vscode/tasks.json` — the file VS Code users already have — so
 * a project's "build", "lint" or "deploy" runs from the editor's Tareas tab without being defined a
 * second time. Run in the terminal dock, like VS Code's own shell tasks.
 *
 * What is read: `label`, `type` (`shell`, `process`, `npm`), `command`, `args`, `script` (npm),
 * `options.cwd`, and the `windows` / `osx` / `linux` overrides of those. The variables a command
 * commonly names are filled in (`${workspaceFolder}`, `${file}`, `${relativeFile}`, `${fileDirname}`,
 * `${fileBasename}`, `${env:NAME}` left to the shell); problem matchers, dependencies and background
 * tasks are not this app's — a task with `dependsOn` and no command of its own is listed, not run.
 */

export interface RepoTask {
  label: string;
  /** The command line, variables filled in; `null` when the task has nothing of its own to run. */
  command: string | null;
  /** Absolute. */
  cwd: string;
  /** VS Code's group (`build`, `test`) for the row's hint. */
  group: string | null;
}

/** JSON with comments and trailing commas, as VS Code writes it — stripped to plain JSON. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
    } else if (c === '"') {
      inString = true;
      out += c;
      i += 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

type Platform = "windows" | "macos" | "linux" | "unknown";

interface RawTask {
  label?: unknown;
  type?: unknown;
  command?: unknown;
  args?: unknown;
  script?: unknown;
  options?: { cwd?: unknown };
  group?: unknown;
  windows?: RawTask;
  osx?: RawTask;
  linux?: RawTask;
}

function arg(value: unknown): string {
  if (typeof value === "string") return /\s/.test(value) && !/^["']/.test(value) ? `"${value}"` : value;
  if (value && typeof value === "object" && "value" in value) return arg((value as { value: unknown }).value);
  return "";
}

export interface TaskContext {
  repoPath: string;
  /** The open file, repo-relative — for `${file}` and friends. */
  file: string | null;
  platform: Platform;
  packageManager: string;
}

/** `${workspaceFolder}`, `${file}` and friends filled in — shared with `vscodeLaunch`. */
export function fillVariables(text: string, ctx: Pick<TaskContext, "repoPath" | "file">): string {
  const root = ctx.repoPath.replace(/[\\/]+$/, "");
  const file = ctx.file ?? "";
  const abs = file ? `${root}/${file}` : "";
  const dir = abs ? abs.slice(0, abs.lastIndexOf("/")) : root;
  const base = file.slice(file.lastIndexOf("/") + 1);
  return text
    .replace(/\$\{workspaceFolder\}|\$\{workspaceRoot\}/g, root)
    .replace(/\$\{workspaceFolderBasename\}/g, root.slice(root.lastIndexOf("/") + 1))
    .replace(/\$\{relativeFile\}/g, file)
    .replace(/\$\{fileDirname\}/g, dir)
    .replace(/\$\{fileBasenameNoExtension\}/g, base.replace(/\.[^.]+$/, ""))
    .replace(/\$\{fileBasename\}/g, base)
    .replace(/\$\{file\}/g, abs);
}

/** The tasks of a `tasks.json` text — `[]` when it does not parse, rather than an error per row. */
export function parseTasks(text: string, ctx: TaskContext): RepoTask[] {
  let raw: { tasks?: unknown };
  try {
    raw = JSON.parse(stripJsonc(text)) as { tasks?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(raw.tasks)) return [];
  const os = ctx.platform === "windows" ? "windows" : ctx.platform === "macos" ? "osx" : "linux";
  return (raw.tasks as RawTask[]).flatMap((base) => {
    const task: RawTask = { ...base, ...(base[os] ?? {}), options: { ...base.options, ...(base[os]?.options ?? {}) } };
    const label = typeof task.label === "string" ? task.label : typeof task.script === "string" ? `npm: ${task.script}` : null;
    if (!label) return [];
    let command: string | null = null;
    if (task.type === "npm" && typeof task.script === "string") {
      command = `${ctx.packageManager} run ${task.script}`;
    } else if (typeof task.command === "string" && task.command.trim()) {
      const args = Array.isArray(task.args) ? task.args.map(arg).filter(Boolean) : [];
      // The command is a command line already (a shell task's usual form); only the args are quoted.
      command = fillVariables([task.command.trim(), ...args].join(" "), ctx);
    }
    const cwd = typeof task.options?.cwd === "string" ? fillVariables(task.options.cwd, ctx) : ctx.repoPath;
    const group = typeof task.group === "string" ? task.group : task.group && typeof task.group === "object" && "kind" in task.group ? String((task.group as { kind: unknown }).kind) : null;
    return [{ label, command, cwd, group }];
  });
}

/** What «Crear tasks.json» writes: VS Code's own shape, one example task to edit. */
export const TASKS_TEMPLATE = `{
  // Tareas del proyecto: CodeFlow y VS Code las leen de este archivo.
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "npm run build",
      "group": "build"
    }
  ]
}
`;
