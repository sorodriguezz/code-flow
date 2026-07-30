import {
  Archive,
  ArrowRight,
  Briefcase,
  Check,
  FolderInput,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  Trash2,
  Undo2,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import type { ConfirmFlow, ConfirmFlowKind } from "../../state/confirmStore";

/**
 * The picture above a branch/stash confirmation: what the change comes out of, on the left; what
 * it lands in, on the right; and a light travelling between them in that direction.
 *
 * It exists because the sentence alone is easy to read backwards. "Merge Tests into main" and
 * "merge main into Tests" differ by one word, and only one of them is what the button under the
 * cursor does — so the direction is drawn instead of only written.
 */

interface Preset {
  /** Icon in the badge over the connector — the verb. */
  badge: LucideIcon;
  sourceIcon: LucideIcon;
  targetIcon: LucideIcon;
  /** Destructive operations recolour the whole diagram, matching the confirm button. */
  danger?: boolean;
}

const PRESETS: Record<ConfirmFlowKind, Preset> = {
  merge: { badge: GitMerge, sourceIcon: GitBranch, targetIcon: GitBranch },
  detach: { badge: Unlink, sourceIcon: GitBranch, targetIcon: Unlink },
  checkout: { badge: GitBranchPlus, sourceIcon: GitBranch, targetIcon: GitBranch },
  "branch-create": { badge: GitBranchPlus, sourceIcon: GitCommitHorizontal, targetIcon: GitBranch },
  "branch-delete": { badge: Trash2, sourceIcon: GitBranch, targetIcon: Trash2, danger: true },
  "stash-apply": { badge: Check, sourceIcon: Archive, targetIcon: GitBranch },
  "stash-pop": { badge: Undo2, sourceIcon: Archive, targetIcon: GitBranch },
  "stash-drop": { badge: Trash2, sourceIcon: Archive, targetIcon: Trash2, danger: true },
  "workspace-move": { badge: FolderInput, sourceIcon: Briefcase, targetIcon: Briefcase },
};

function Node({
  icon: Icon,
  label,
  emphasis,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  /** The target node is outlined: it's the side the operation changes. */
  emphasis: boolean;
  tone: string;
}) {
  return (
    <div
      title={label}
      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2 py-1.5"
      style={{
        borderColor: emphasis ? tone : "var(--cf-border)",
        background: emphasis ? `color-mix(in oklab, ${tone} 10%, transparent)` : "transparent",
      }}
    >
      <Icon size={12} className="shrink-0" style={{ color: emphasis ? tone : "var(--cf-text-muted)" }} />
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px]"
        style={{ color: emphasis ? "var(--cf-text)" : "var(--cf-text-muted)" }}
      >
        {label}
      </span>
    </div>
  );
}

export function ConfirmFlowDiagram({ flow }: { flow: ConfirmFlow }) {
  const preset = PRESETS[flow.kind];
  const tone = preset.danger ? "var(--cf-danger)" : "var(--cf-accent)";

  return (
    // Extra room at the top, not padding for its own sake: the verb badge hangs above the
    // connector and would otherwise ride out over the tinted box's edge.
    <div className="mb-4 rounded-lg bg-black/[0.02] px-3 pb-3 pt-8 dark:bg-white/[0.03]">
      <div className="flex items-center gap-2">
        <Node icon={preset.sourceIcon} label={flow.source} emphasis={false} tone={tone} />

        {/* The connector is the only thing in normal flow here, so `items-center` on the row lands
            it exactly on the two nodes' centre line — the line the eye reads the arrow along.
            Stacking the badge above it in flow instead made the column the tallest item in the row,
            which pushed the beam a badge's height below that line and left the arrow looking like
            it had slipped off the bottom of the diagram. */}
        <div className="relative flex w-16 shrink-0 items-center gap-0.5">
          {/* Lifted out of flow and hung over the connector, which is why the box above reserves
              the room for it. */}
          <span
            className="absolute bottom-full left-1/2 mb-1.5 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full"
            style={{
              background: `color-mix(in oklab, ${tone} 16%, transparent)`,
              color: tone,
              boxShadow: `0 0 0 1px color-mix(in oklab, ${tone} 28%, transparent)`,
            }}
          >
            <preset.badge size={13} />
          </span>
          <span
            className="relative h-[3px] flex-1 overflow-hidden rounded-full"
            style={{ background: `color-mix(in oklab, ${tone} 22%, transparent)` }}
          >
            <span
              className="cf-flow-beam absolute inset-y-0 left-0 w-full"
              style={{ background: `linear-gradient(90deg, transparent, ${tone}, transparent)` }}
            />
          </span>
          <ArrowRight size={12} className="cf-flow-nudge shrink-0" style={{ color: tone }} />
        </div>

        <Node icon={preset.targetIcon} label={flow.target} emphasis tone={tone} />
      </div>

      {flow.note && (
        <p className="mt-2.5 text-center text-[11px] leading-snug text-[var(--cf-text-muted)]">{flow.note}</p>
      )}
    </div>
  );
}
