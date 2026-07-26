/** Which debugger backs each language.
 *
 * Node is the odd one out: it ships its own debugger, so the app talks to it directly and there
 * is nothing to install. Everything else follows the same model as VS Code — a *debug adapter*
 * for that language, installed separately, that the app drives over DAP. That's why the entries
 * below are mostly a command line and a launch config: adding a language is configuration, not
 * code.
 */

export interface DebugAdapter {
  id: string;
  label: string;
  /** File extensions this adapter claims, used to pick it from the open file. */
  extensions: string[];
  /** `null` means the built-in Node backend — no adapter process at all. */
  command: string | null;
  args: string[];
  /** Adapter-specific launch object; `program` and `cwd` are filled in at launch time. This is
   * the same JSON a VS Code `launch.json` entry carries, minus the editor's own keys. */
  launch: Record<string, unknown>;
  /** What to install when the adapter isn't found — shown verbatim in the error. */
  install: string;
}

export const DEBUG_ADAPTERS: DebugAdapter[] = [
  {
    id: "node",
    label: "Node.js",
    extensions: ["js", "mjs", "cjs"],
    command: null,
    args: [],
    launch: {},
    install: "",
  },
  {
    id: "python",
    label: "Python",
    extensions: ["py"],
    command: "python",
    args: ["-m", "debugpy.adapter"],
    launch: {
      type: "python",
      request: "launch",
      console: "internalConsole",
      justMyCode: true,
      python: ["python"],
    },
    install: "pip install debugpy",
  },
  {
    id: "coreclr",
    label: "C# / .NET",
    extensions: ["cs", "dll"],
    command: "netcoredbg",
    args: ["--interpreter=vscode"],
    launch: { type: "coreclr", request: "launch", console: "internalConsole" },
    // Microsoft's own `vsdbg` is licensed for use only from Microsoft products, so the adapter
    // here is the open-source one.
    install: "netcoredbg (github.com/Samsung/netcoredbg)",
  },
  {
    id: "custom",
    label: "Custom adapter",
    extensions: [],
    command: "",
    args: [],
    launch: { request: "launch" },
    install: "any DAP adapter that speaks over stdio",
  },
];

export function adapterById(id: string): DebugAdapter {
  return DEBUG_ADAPTERS.find((a) => a.id === id) ?? DEBUG_ADAPTERS[0];
}

/** The adapter that claims this file's extension, if any — what the panel preselects. */
export function adapterForFile(path: string): DebugAdapter | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return DEBUG_ADAPTERS.find((a) => a.extensions.includes(extension)) ?? null;
}
