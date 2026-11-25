import type { EvidenceEntry, SandboxNetwork, SandboxStatus, SandboxView, SecurityPolicy } from "../../types/containersSandbox";

/**
 * What the Sandboxes page works out from the broker's rows — the tone of a state, which actions a
 * state allows, a command's line, the counts of a timeline — kept apart from the page so each rule is
 * checked without an engine or a DOM.
 */

export type Tone = "ok" | "warn" | "bad" | "idle";

export function statusTone(status: SandboxStatus): Tone {
  switch (status) {
    case "running":
      return "ok";
    case "creating":
    case "stopped":
      return "warn";
    case "failed":
    case "blocked":
      return "bad";
    default:
      return "idle";
  }
}

/** Whether its container may still exist (what Destroy is for). */
export function isLive(status: SandboxStatus): boolean {
  return status === "creating" || status === "running" || status === "stopped";
}

export function actionsFor(status: SandboxStatus): { exec: boolean; stop: boolean; start: boolean; destroy: boolean; forget: boolean; cancel: boolean } {
  return {
    exec: status === "running",
    stop: status === "running",
    start: status === "stopped",
    destroy: status === "running" || status === "stopped" || status === "creating",
    forget: !isLive(status),
    cancel: status === "creating",
  };
}

/** `3000, 8080 5173` → the container ports, valid ones only, once each. */
export function parsePortList(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/[\s,;]+/)) {
    if (!/^\d{1,5}$/.test(word)) continue;
    const n = Number(word);
    if (n < 1 || n > 65535 || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

/** An argv as a person would type it: words with blanks or quotes are quoted. */
export function argvLine(argv: string[] | undefined): string {
  return (argv ?? []).map((w) => (w === "" || /[\s'"$`\\]/.test(w) ? `'${w.replace(/'/g, "'\\''")}'` : w)).join(" ");
}

export function fmtDuration(ms: number | undefined): string {
  const value = Math.max(0, ms ?? 0);
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes} min ${Math.round((value % 60_000) / 1000)} s`;
}

/** How a timeline entry reads at a glance. */
export function evidenceTone(entry: EvidenceEntry): Tone {
  switch (entry.kind) {
    case "exec":
    case "test":
      if (entry.data.timedOut || entry.data.cancelled) return "warn";
      return entry.data.exitCode === 0 ? "ok" : "bad";
    case "policy":
    case "hardening": {
      const list = entry.data.violations ?? [];
      if (list.some((v) => v.blocking)) return "bad";
      return list.length ? "warn" : "ok";
    }
    case "error":
      return "bad";
    case "cancelled":
      return "warn";
    default:
      return "idle";
  }
}

/** The commands of a timeline: how many, how many were tests, how many did not exit 0. */
export function commandCounts(timeline: EvidenceEntry[]): { commands: number; tests: number; failed: number } {
  const commands = timeline.filter((e) => e.kind === "exec" || e.kind === "test");
  return {
    commands: commands.length,
    tests: commands.filter((e) => e.kind === "test").length,
    failed: commands.filter((e) => e.data.exitCode !== 0).length,
  };
}

/** What a sandbox is for, in one line: its story, its task, or its own title. */
export function sandboxLabel(row: Pick<SandboxView, "storyTitle" | "taskTitle" | "title" | "containerName">): string {
  return row.storyTitle || row.taskTitle || row.title || row.containerName;
}

export const NETWORKS: SandboxNetwork[] = ["none", "internal", "internet"];

/** Which network policies a workspace's security policy lets a sandbox have. */
export function allowedNetworks(policy: SecurityPolicy | null): SandboxNetwork[] {
  return policy?.restrictNetwork ? ["none", "internal"] : NETWORKS;
}

/** The policy's switches, in the order the settings list them. */
export const POLICY_RULES = [
  "noPrivileged",
  "noEngineSocket",
  "noHostMounts",
  "requireNonRoot",
  "requireLimits",
  "restrictNetwork",
  "blockCriticalVulns",
  "requireSigned",
  "enforceInFlows",
] as const satisfies readonly (keyof SecurityPolicy)[];

export type PolicyRule = (typeof POLICY_RULES)[number];

export function samePolicy(a: SecurityPolicy, b: SecurityPolicy): boolean {
  return (
    POLICY_RULES.every((rule) => a[rule] === b[rule]) && a.signingKey.trim() === b.signingKey.trim() && a.sandboxImage.trim() === b.sandboxImage.trim()
  );
}
