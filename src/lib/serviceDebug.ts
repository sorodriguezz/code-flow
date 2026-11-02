/**
 * Whether a service can run in debug mode: its command starts Node, whose inspector the supervisor
 * opens (`NODE_OPTIONS=--inspect`) and the editor's debugger attaches to. Bun and Deno speak other
 * protocols, and anything else (a JVM, Python, a container) has no inspector to open this way.
 */

const NODE_COMMANDS = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "corepack",
  "nest",
  "tsx",
  "ts-node",
  "ts-node-dev",
  "vite-node",
  "nodemon",
  "next",
  "nuxt",
  "nuxi",
]);

/** The program a shell command line runs first: past `VAR=value` assignments and `cross-env`/`env`,
 *  with a path and a Windows `.cmd`/`.exe` taken off. */
function firstProgram(command: string): string | null {
  const words = command.trim().split(/\s+/);
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (word === "cross-env" || word === "env") continue;
    const name = word.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "";
    return name.replace(/\.(cmd|exe|ps1)$/i, "").toLowerCase();
  }
  return null;
}

export function canDebugService(command: string): boolean {
  const program = firstProgram(command);
  return program !== null && NODE_COMMANDS.has(program);
}
