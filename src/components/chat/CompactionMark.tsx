import { useState } from "react";
import { ChevronDown, Shrink, Undo2 } from "lucide-react";
import { useT } from "../../state/languageStore";

/**
 * The line where the engine's memory of this conversation starts.
 *
 * # Why the summary is shown at all
 *
 * Compaction is the only operation in this workspace that changes what the model knows without
 * changing anything the user can see. The messages above this line are still on screen, still
 * scrollable, still exactly as they were — and the engine will never read them again. That gap
 * between what the transcript shows and what the model has is the whole hazard, and the only honest
 * way to close it is to put the replacement text *in the transcript*, at the point where the
 * substitution happens, and let it be read.
 *
 * So this is not a status badge. It is the summary, folded shut.
 *
 * # Why it is in the flow rather than pinned
 *
 * A banner at the top of the transcript could say "this conversation was compacted" but not *how
 * far* — and how far is the only part that lets the reader judge whether the thing they are about
 * to refer back to still exists as far as the model is concerned. Drawn in place, the line answers
 * that by being somewhere.
 */
export function CompactionMark({
  turns,
  summary,
  onUndo,
}: {
  /** How many turns the summary stands in for. */
  turns: number;
  summary: string;
  onUndo: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className="py-1">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-[var(--cf-border)]" />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-full border border-[var(--cf-border)] px-2 py-0.5 text-[10px] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-text)]"
        >
          <Shrink size={10} className="shrink-0" />
          {t("chat.compactionMark", { n: turns })}
          <ChevronDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <div className="h-px flex-1 bg-[var(--cf-border)]" />
      </div>

      {open && (
        <div className="mt-2 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3">
          <p className="mb-1.5 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("chat.compactionExplains")}
          </p>
          {/* The model's own words, whitespace and all. Not rendered as Markdown on purpose: this
              is the literal string that will be sent, and formatting it would put a gap between
              what is read here and what the engine receives — which is the one thing this panel
              exists to eliminate. */}
          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--cf-text)]">
            {summary}
          </p>
          <button
            type="button"
            onClick={onUndo}
            className="mt-2 flex items-center gap-1 text-[10.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
          >
            <Undo2 size={10} />
            {t("chat.compactionUndo")}
          </button>
        </div>
      )}
    </div>
  );
}
