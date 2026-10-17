import { readFileText } from "./tauri/commands";
import { stripJsonc } from "./vscodeTasks";

/**
 * What the repository's `.vscode/extensions.json` recommends, read for the one part this app can act
 * on: the language servers. An extension is VS Code's packaging of a server (`svelte.svelte-vscode`
 * is the Svelte server, `rust-lang.rust-analyzer` is rust-analyzer), so a recommendation names the
 * server the project expects — and when that server is not installed here, the editor says so,
 * with the command that installs it. No extension is ever installed: there is no marketplace.
 */

export const VSCODE_EXTENSIONS_FILE = ".vscode/extensions.json";

/** Marketplace id → `LANGUAGE_SERVERS` id. Lower case; ids are case-insensitive in VS Code. */
const SERVER_OF_EXTENSION: Record<string, string> = {
  "ms-python.python": "pyright",
  "ms-python.vscode-pylance": "pyright",
  "ms-pyright.pyright": "pyright",
  "charliermarsh.ruff": "ruff",
  "redhat.vscode-yaml": "yaml",
  "ms-azuretools.vscode-docker": "docker",
  "ms-azuretools.vscode-containers": "docker",
  "bradlc.vscode-tailwindcss": "tailwind",
  "mads-hartmann.bash-ide-vscode": "bash",
  "bmewburn.vscode-intelephense-client": "intelephense",
  "vue.volar": "vue",
  "svelte.svelte-vscode": "svelte",
  "astro-build.astro-vscode": "astro",
  "rust-lang.rust-analyzer": "rust-analyzer",
  "golang.go": "gopls",
  "llvm-vs-code-extensions.vscode-clangd": "clangd",
  "ms-vscode.cpptools": "clangd",
  "ms-dotnettools.csharp": "csharp",
  "ms-dotnettools.csdevkit": "csharp",
  "sumneko.lua": "lua",
  "shopify.ruby-lsp": "ruby",
  "tamasfe.even-better-toml": "taplo",
  "hashicorp.terraform": "terraform",
  "redhat.java": "jdtls",
  "vscjava.vscode-java-pack": "jdtls",
  "fwcd.kotlin": "kotlin",
};

/** The servers an `extensions.json` text recommends, in its order, without repeats. */
export function recommendedServers(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return [];
  }
  const list =
    parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { recommendations?: unknown }).recommendations)
      ? ((parsed as { recommendations: unknown[] }).recommendations as unknown[])
      : [];
  const out: string[] = [];
  for (const id of list) {
    if (typeof id !== "string") continue;
    const server = SERVER_OF_EXTENSION[id.toLowerCase()];
    if (server && !out.includes(server)) out.push(server);
  }
  return out;
}

const cache = new Map<string, Promise<string[]>>();

/** The repository's recommendations, read once per repository and session. */
export function repoRecommendedServers(repoPath: string): Promise<string[]> {
  let pending = cache.get(repoPath);
  if (!pending) {
    pending = readFileText(repoPath, VSCODE_EXTENSIONS_FILE)
      .then(recommendedServers)
      .catch(() => []);
    cache.set(repoPath, pending);
  }
  return pending;
}

/** Read again — the file was just saved. */
export function forgetRecommendedServers(repoPath: string): void {
  cache.delete(repoPath);
}
