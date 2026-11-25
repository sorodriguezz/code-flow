/**
 * How a run's statuses and messages read in the live view.
 *
 * Statuses use the app's six words everywhere — Por hacer, Trabajando, Te espera, Hecho, Falló,
 * Cancelado — the same as a task's (`agents.status*`) and a Workshop row's (`wt.state.*`), so one
 * piece of work never reads «terminó» in one place and «en curso» in another.
 */
import { INFRA_PROVIDER, type TeamItem, type TeamItemKind, type TeamItemStatus, type TeamMessageKind, type TeamRunStatus } from "../../../types/team";
import type { Tone } from "../kit/ui";

export const ITEM_STATUS: Record<TeamItemStatus, [string, string, Tone]> = {
  pending: ["Por hacer", "To do", "neutral"],
  gated: ["Te espera", "Waiting on you", "warn"],
  running: ["Trabajando", "Working", "accent"],
  waiting: ["Te espera", "Waiting on you", "warn"],
  done: ["Hecho", "Done", "ok"],
  error: ["Error", "Error", "bad"],
  cancelled: ["Cancelado", "Cancelled", "neutral"],
  skipped: ["Saltado", "Skipped", "neutral"],
  delegated: ["Delegado", "Delegated", "info"],
};

export const ITEM_KIND: Record<TeamItemKind, [string, string]> = {
  amend: ["Ajuste del plan", "Plan amendment"],
  plan: ["Plan", "Plan"],
  final: ["Cierre", "Wrap-up"],
  answer: ["Respuesta", "Answer"],
  work: ["Trabajo", "Work"],
  investigate: ["Investigar", "Investigate"],
  review: ["Revisión", "Review"],
  integrate: ["Integrar", "Merge"],
  delegate: ["Delegado", "Delegated"],
  advise: ["Consejo", "Advice"],
};

export const RUN_STATUS: Record<TeamRunStatus, [string, string, Tone]> = {
  running: ["Trabajando", "Working", "accent"],
  gated: ["Te espera", "Waiting on you", "warn"],
  paused: ["En pausa", "Paused", "warn"],
  done: ["Hecho", "Done", "ok"],
  failed: ["Falló", "Failed", "bad"],
  aborted: ["Cancelado", "Cancelled", "neutral"],
};

export const MESSAGE_KIND: Record<TeamMessageKind, [string, string, Tone]> = {
  plan: ["plan", "plan", "info"],
  decision: ["decisión", "decision", "violet"],
  handoff: ["entrega", "handoff", "ok"],
  question: ["pregunta", "question", "warn"],
  answer: ["respuesta", "answer", "accent"],
  note: ["nota", "note", "neutral"],
  finding: ["hallazgo", "finding", "info"],
  status: ["estado", "status", "neutral"],
  merge: ["integración", "merge", "ok"],
  advice: ["consejo", "advice", "violet"],
  error: ["error", "error", "bad"],
};

/**
 * How one item reads right now. The status alone says «Trabajando» for a turn that is still
 * waiting for a slot and for one whose agent finished and whose checks are running, and «Te
 * espera» for an item that only waits for an engine to come back: the words here are the ones for
 * what is actually happening.
 */
export function itemLook(item: Pick<TeamItem, "status" | "intelligence">): [string, string, Tone] {
  const info = item.intelligence;
  if (item.status === "running") {
    if (info?.phase === "queued") return ["En cola", "Queued", "neutral"];
    if (info?.phase === "verifying") return ["Verificando", "Verifying", "info"];
  }
  if (item.status === "waiting" && info?.recovery) {
    if (info.recovery.provider === INFRA_PROVIDER) return ["Reintentando", "Retrying", "neutral"];
    if (info.recovery.resume_at) return ["Espera al motor", "Waiting on engine", "neutral"];
  }
  if (item.status === "pending" && info?.missing_deps?.length) return ["Bloqueada", "Blocked", "warn"];
  if (item.status === "done" && info?.outcome === "partial") return ["Parcial", "Partial", "warn"];
  return ITEM_STATUS[item.status] ?? ITEM_STATUS.pending;
}

/** Whether the item's agent is really at work this second — not queued, not being verified. */
export function isWorking(item: Pick<TeamItem, "status" | "intelligence">): boolean {
  return item.status === "running" && item.intelligence?.phase !== "queued" && item.intelligence?.phase !== "verifying";
}

export function itemColor(item: Pick<TeamItem, "status" | "intelligence">): string {
  if (item.status === "running" && item.intelligence?.phase === "queued") return "var(--cf-border-strong)";
  if (item.status === "running" && item.intelligence?.phase === "verifying") return "var(--cf-blue)";
  switch (item.status) {
    case "running":
      return "var(--cf-accent)";
    case "waiting":
    case "gated":
      return "var(--cf-warning)";
    case "done":
      return "var(--cf-success)";
    case "error":
      return "var(--cf-danger)";
    case "delegated":
      return "var(--cf-blue)";
    default:
      return "var(--cf-border-strong)";
  }
}

export function since(iso: string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
