import type { EnvConfig, EnvPortBinding, EnvProposal, EnvStatus, EnvView } from "../../types/containersEnvs";

/**
 * What the Entornos page works out on its own — a port's link, a status's tone, the project name a
 * branch will get — kept apart from the page so it can be checked without an engine or a DOM. The
 * rules that matter (the offset, the override, the names) live in `src-tauri/src/containers/envs`;
 * these only mirror them for the preview.
 */

/** Same rule as `plan::slug` in the backend: lowercase ASCII letters and digits, the rest one `-`. */
export function slug(text: string, max: number): string {
  let out = "";
  for (const c of text.toLowerCase()) {
    if (/[a-z0-9]/.test(c)) out += c;
    else if (out && !out.endsWith("-")) out += "-";
  }
  return out.replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}

/** `<repo>-<branch>`, as `plan::compose_project_name` makes it — shown before the environment exists. */
export function composeProjectPreview(repo: string, branch: string): string {
  const r = slug(repo, 30);
  const b = slug(branch, 63);
  const joined = r && b ? `${r}-${b}` : r || b || "env";
  return joined.slice(0, 63).replace(/-+$/, "");
}

/** A branch name worth sending: what `git check-ref-format --branch` refuses most often, said early. */
export function plausibleBranch(name: string): boolean {
  const b = name.trim();
  if (!b || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".") || b.endsWith(".lock")) return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(b) || b.includes("..") || b.includes("@{") || b.includes("//")) return false;
  return true;
}

/** The address a published port answers on from this computer, for a web port; `null` for UDP or
 *  an unpublished one. */
export function portUrl(port: EnvPortBinding): string | null {
  if (port.host == null || port.protocol.toLowerCase() === "udp") return null;
  const ip = port.hostIp.trim();
  const host = !ip || ip === "0.0.0.0" || ip === "::" || ip === "127.0.0.1" || ip === "::1" ? "localhost" : ip.includes(":") ? `[${ip}]` : ip;
  return `http://${host}:${port.host}`;
}

/** `8180`, or `8100-8105` for a range. */
export function hostPortLabel(port: EnvPortBinding): string {
  if (port.host == null) return "—";
  return port.hostEnd != null ? `${port.host}-${port.hostEnd}` : String(port.host);
}

/** The ports worth a row: the published ones, by service then port. */
export function publishedPorts(env: Pick<EnvView, "ports">): EnvPortBinding[] {
  return env.ports.filter((p) => p.host != null).sort((a, b) => a.service.localeCompare(b.service) || (a.host ?? 0) - (b.host ?? 0));
}

export function statusTone(status: EnvStatus): "ok" | "warn" | "bad" | "idle" {
  switch (status) {
    case "running":
      return "ok";
    case "partial":
      return "warn";
    case "unknown":
      return "bad";
    default:
      return "idle";
  }
}

/** A Compose stack is started as a job (its output in the jobs panel); a devcontainer by the backend. */
export function runsAsJob(env: Pick<EnvView, "config">): boolean {
  return env.config.kind === "compose";
}

/** `containers_envs_remove` refused a checkout with uncommitted changes. */
export const WORKTREE_DIRTY = "WORKTREE_DIRTY: ";
export function isDirtyRefusal(error: unknown): boolean {
  return String(error).includes(WORKTREE_DIRTY);
}

/** The proposal the dialog starts on: the recommended one, else the first that can run. */
export function initialProposal(proposals: EnvProposal[]): EnvProposal | null {
  return proposals.find((p) => p.recommended && p.available) ?? proposals.find((p) => p.available) ?? null;
}

/** What installs the Dev Containers CLI — shown for the user to run, never run from here. */
export const DEVCONTAINER_CLI_INSTALL = "npm i -g @devcontainers/cli";

/** `containers_envs_up` refused: the branch's `initializeCommand` is not the one approved. */
export const INIT_CHANGED = "INIT_CHANGED: ";

/** The commands of an `INIT_CHANGED` refusal, to show and approve word for word; `null` otherwise. */
export function initChangedCommands(error: unknown): string[] | null {
  const text = String(error);
  const at = text.indexOf(INIT_CHANGED);
  if (at < 0) return null;
  try {
    const list: unknown = JSON.parse(text.slice(at + INIT_CHANGED.length).trim());
    return Array.isArray(list) && list.every((c) => typeof c === "string") ? (list as string[]) : null;
  } catch {
    return null;
  }
}

/** A direct run of a file with `features` waits for the user's explicit "run without features". */
export function featuresBlock(proposal: Pick<EnvProposal, "kind" | "features"> | null, withoutFeatures: boolean): boolean {
  return !!proposal && proposal.kind === "devcontainer" && proposal.features.length > 0 && !withoutFeatures;
}

/** The configuration a new environment is created with: the proposal's, with the user's choices —
 *  running without features, and the `initializeCommand` they were shown, approved. */
export function configFor(proposal: Pick<EnvProposal, "config" | "kind" | "features" | "initialize">, withoutFeatures: boolean): EnvConfig {
  if (proposal.config.kind !== "devcontainer") return proposal.config;
  return { ...proposal.config, withoutFeatures: proposal.kind === "devcontainer" && proposal.features.length > 0 && withoutFeatures, approvedInit: [...proposal.initialize] };
}
