import { laneColor } from "../../../lib/graphLayout";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { TeamItemKind, TeamItemStatus, TeamMessageKind, TeamRunStatus } from "../../../types/team";

/** One colour per member, in roster order — the same palette the commit graph's lanes use. */
export function memberColor(index: number): string {
  return laneColor(index);
}

export function statusTone(status: TeamItemStatus | TeamRunStatus): { dot: string; text: string } {
  switch (status) {
    case "running":
      return { dot: "bg-[var(--cf-accent)] animate-pulse", text: "text-[var(--cf-accent)]" };
    case "done":
      return { dot: "bg-[var(--cf-success)]", text: "text-[var(--cf-success)]" };
    case "error":
    case "failed":
      return { dot: "bg-[var(--cf-danger)]", text: "text-[var(--cf-danger)]" };
    case "waiting":
    case "gated":
    case "paused":
      return { dot: "bg-[var(--cf-warning)]", text: "text-[var(--cf-warning)]" };
    default:
      return { dot: "bg-[var(--cf-text-faint)]", text: "text-[var(--cf-text-muted)]" };
  }
}

export function itemKindKey(kind: TeamItemKind): TranslationKey {
  return `team.kind.${kind}` as TranslationKey;
}

export function messageKindKey(kind: TeamMessageKind): TranslationKey {
  return `team.msg.${kind}` as TranslationKey;
}
