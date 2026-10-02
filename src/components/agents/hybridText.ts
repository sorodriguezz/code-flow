import type { HybridView } from "../../lib/tauri/hybridCommands";

/**
 * The hybrid panes' pure helpers — kept apart from the components so a test can read them without
 * loading the stores (which listen to the app's events the moment they are imported).
 */

/** A repository's name in this run; an empty id is the first. */
export function repoName(view: HybridView, projectId: string): string {
  const repo = projectId ? view.repos.find((candidate) => candidate.project_id === projectId) : view.repos[0];
  return repo?.name ?? "";
}

/** A path, prefixed with its repository when the run spans more than one. */
export function filePath(view: HybridView, projectId: string, file: string): string {
  return view.repos.length > 1 ? `${repoName(view, projectId)}/${file}` : file;
}

export type Verdict = "ok" | "fixed" | "pending";

/** The review's last `VERDICT:` line — the same reading `hybrid::prompts::parse_verdict` makes. */
export function verdictOf(answer: string): Verdict | null {
  const lines = answer.split(/\r?\n/).reverse();
  for (const raw of lines) {
    const line = raw.trim().replace(/^[*`]+|[*`]+$/g, "").trim();
    const match = /^verdict:[\s*`]*([a-z]+)/i.exec(line);
    if (!match) continue;
    const word = match[1].toUpperCase();
    if (word === "OK") return "ok";
    if (word === "FIXED" || word === "CORREGIDO") return "fixed";
    if (word === "PENDING" || word === "PENDIENTE") return "pending";
  }
  return null;
}

/** The review's answer without its closing `VERDICT:` line — the chip above already says it. */
export function withoutVerdict(answer: string): string {
  const lines = answer.trimEnd().split(/\r?\n/);
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (/^[*`\s]*verdict:/i.test(lines[at])) {
      lines.splice(at, 1);
      break;
    }
  }
  return lines.join("\n").trim();
}
