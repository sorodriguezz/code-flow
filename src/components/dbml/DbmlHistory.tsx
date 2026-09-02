import { useEffect, useMemo, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { changedLines, HISTORY_LIMIT, type Revision } from "../../lib/dbml/history";
import { readLayout } from "../../lib/dbml/layout";
import { ICON_BUTTON } from "../diagrams/diagramsChrome";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The last few things that happened to this document, and a way back to any of them.
 *
 * Rows are changes rather than snapshots — see `lib/dbml/history.ts` — so each one can say what it
 * did in the two numbers a reader actually wants (`+3 −1`) and expand into the lines behind them.
 *
 * **Reverting is itself a change**, and that is deliberate rather than an implementation detail:
 * putting the document back writes a new revision, so the state you left is still at the top of the
 * list and one click away. A history you can fall out of by using it is worse than no history,
 * because the moment it is wrong is the moment you were relying on it.
 */

const CAUSE_LABEL: Record<Revision["cause"], TranslationKey> = {
  edited: "dbml.history.edited",
  moved: "dbml.history.moved",
  marked: "dbml.history.marked",
  formatted: "dbml.history.formatted",
  rearranged: "dbml.history.rearranged",
  imported: "dbml.history.imported",
  merged: "dbml.history.merged",
  reverted: "dbml.history.reverted",
};

export function DbmlHistory({
  revisions,
  onRevert,
  onClose,
}: {
  revisions: Revision[];
  /** Handed the document as it was before that change. */
  onRevert: (doc: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(revisions[0]?.id ?? null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-30" onMouseDown={onClose} />
      <aside className="absolute right-2 top-[38px] z-40 flex max-h-[calc(100%-52px)] w-[380px] flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]">
        <header className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2.5 py-[7px]">
          <span className="min-w-0 flex-1 truncate text-[9.5px] font-semibold uppercase tracking-[0.09em] text-[var(--cf-text-muted)]">
            {t("dbml.history")}
          </span>
          <button
            type="button"
            className={ICON_BUTTON}
            title={t("dbml.history.close")}
            aria-label={t("dbml.history.close")}
            onClick={onClose}
          >
            <X size={12} />
          </button>
        </header>

        {revisions.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {t("dbml.history.empty")}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <p className="px-2.5 pb-1 text-[10px] leading-snug text-[var(--cf-text-muted)]">
              {t("dbml.history.hint", { count: String(HISTORY_LIMIT) })}
            </p>
            {revisions.map((revision) => (
              <Row
                key={revision.id}
                revision={revision}
                expanded={open === revision.id}
                onToggle={() => setOpen((current) => (current === revision.id ? null : revision.id))}
                onRevert={() => {
                  onRevert(revision.before);
                  onClose();
                }}
              />
            ))}
          </div>
        )}
      </aside>
    </>
  );
}

function Row({
  revision,
  expanded,
  onToggle,
  onRevert,
}: {
  revision: Revision;
  expanded: boolean;
  onToggle: () => void;
  onRevert: () => void;
}) {
  const t = useT();
  /**
   * Compared on the *DBML halves*, not on the stored documents.
   *
   * A document is the schema plus a trailing comment holding the box positions, and dragging a box
   * rewrites only that comment. Diffing the raw text would report a drag as one changed line whose
   * content is a blob of JSON coordinates — true, and no use to anybody: what the reader wants to
   * know is that nothing about the *schema* changed, which is exactly what an empty diff says.
   */
  const halves = useMemo(
    () => [readLayout(revision.before).source, readLayout(revision.after).source] as const,
    [revision.before, revision.after],
  );
  // The lines only for the row that is open. A ten-row list would otherwise diff ten documents on
  // every render of the panel, and nine of those answers are not on screen.
  const diff = useMemo(
    () => (expanded ? changedLines(halves[0], halves[1]) : null),
    [expanded, halves],
  );
  const summary = useMemo(() => changedLines(halves[0], halves[1], 0), [halves]);

  return (
    <div className="border-b border-[var(--cf-border)] last:border-b-0">
      <div className="flex items-center gap-1.5 px-2.5 py-[5px]">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text)]">
            {t(CAUSE_LABEL[revision.cause])}
          </span>
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-[var(--cf-success)]">
            {summary.added > 0 ? `+${summary.added}` : ""}
          </span>
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-[var(--cf-danger)]">
            {summary.removed > 0 ? `−${summary.removed}` : ""}
          </span>
          <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-[var(--cf-text-muted)]">
            {new Date(revision.at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </button>
        <button
          type="button"
          onClick={onRevert}
          title={t("dbml.history.revert")}
          aria-label={t("dbml.history.revert")}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-accent-soft)] hover:text-[var(--cf-accent)]"
        >
          <RotateCcw size={11} />
        </button>
      </div>

      {expanded && diff && (
        <div className="max-h-[220px] overflow-auto border-t border-[var(--cf-border)] bg-[var(--cf-field)] px-1 py-1">
          {diff.lines.length === 0 ? (
            <p className="px-1.5 py-1 text-[10px] text-[var(--cf-text-muted)]">
              {t("dbml.history.noLines")}
            </p>
          ) : (
            diff.lines.map((line, at) => (
              <div
                key={`${line.kind}-${line.line}-${at}`}
                className="flex items-baseline gap-1.5 font-mono text-[10px] leading-[1.45]"
                style={{
                  color: line.kind === "add" ? "var(--cf-success)" : "var(--cf-danger)",
                }}
              >
                <span className="w-[10px] shrink-0 text-center opacity-70">
                  {line.kind === "add" ? "+" : "−"}
                </span>
                <span className="w-[26px] shrink-0 text-right tabular-nums opacity-50">
                  {line.line}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{line.text}</span>
              </div>
            ))
          )}
          {diff.truncated > 0 && (
            <p className="px-1.5 pt-1 text-[9.5px] italic text-[var(--cf-text-muted)]">
              {t("dbml.history.more", { count: String(diff.truncated) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
