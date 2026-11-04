/** How a run's statuses and messages read in the live view. */
import type { TeamItem, TeamItemKind, TeamItemStatus, TeamMessageKind, TeamRunStatus } from "../../../types/team";
import type { Tone } from "../kit/ui";

export const ITEM_STATUS: Record<TeamItemStatus, [string, string, Tone]> = {
  pending: ["En espera", "Pending", "neutral"],
  gated: ["Espera tu OK", "Needs your OK", "warn"],
  running: ["Trabajando", "Working", "accent"],
  waiting: ["Pregunta", "Asking", "warn"],
  done: ["Hecho", "Done", "ok"],
  error: ["Error", "Error", "bad"],
  cancelled: ["Cancelado", "Cancelled", "neutral"],
  skipped: ["Saltado", "Skipped", "neutral"],
  delegated: ["Delegado", "Delegated", "info"],
};

export const ITEM_KIND: Record<TeamItemKind, [string, string]> = {
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
  running: ["En marcha", "Running", "accent"],
  gated: ["Te espera", "Waiting on you", "warn"],
  paused: ["En pausa", "Paused", "warn"],
  done: ["Terminada", "Done", "ok"],
  failed: ["Falló", "Failed", "bad"],
  aborted: ["Cancelada", "Aborted", "neutral"],
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

export function itemColor(item: Pick<TeamItem, "status">): string {
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
