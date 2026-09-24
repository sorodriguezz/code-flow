import { useEffect, useMemo, useState } from "react";
import { Archive, ChevronDown, ChevronRight, RotateCcw, X } from "lucide-react";
import { changedLines, HISTORY_PAGE, type Revision } from "../../lib/dbml/history";
import { readLayout } from "../../lib/dbml/layout";
import { iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { PANE_HEAD, PANE_TITLE } from "../diagrams/diagramsChrome";
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
  onOlder,
  onClose,
}: {
  revisions: Revision[];
  /** Handed the document as it was before that change. */
  onRevert: (doc: string) => void;
  /** Opens the saved-version history, which reaches further back than this session does. */
  onOlder: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(revisions[0]?.id ?? null);
  /** How many rows are on screen. Grows a page at a time and never shrinks — a list that collapsed
   *  back under you while you were reading it would lose your place. */
  const [shown, setShown] = useState(HISTORY_PAGE);
  const visible = revisions.slice(0, shown);
  const remaining = revisions.length - visible.length;

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
      {/* The popover surface — raised, hairline, the app's shadow — with no inner padding: the
          rows below run edge to edge and carry their own. `top-12` clears the 44px toolbar it
          drops from. */}
      <aside className="absolute right-2 top-12 z-40 flex max-h-[calc(100%-60px)] w-[380px] flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]">
        <header className={PANE_HEAD}>
          <span className={PANE_TITLE}>{t("dbml.history")}</span>
          <Tooltip label={t("dbml.history.close")}>
            <button
              type="button"
              className={iconButtonClass({ size: "xs" })}
              aria-label={t("dbml.history.close")}
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </Tooltip>
        </header>

        {revisions.length === 0 ? (
          <p className="px-3 py-4 text-center text-[12px] leading-snug text-[var(--cf-text-muted)]">
            {t("dbml.history.empty")}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <p className="px-3 pb-1.5 pt-1 text-[11px] leading-snug text-[var(--cf-text-faint)]">
              {t("dbml.history.hint")}
            </p>
            {visible.map((revision) => (
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
            {remaining > 0 && (
              <button
                type="button"
                onClick={() => setShown((count) => count + HISTORY_PAGE)}
                className="flex h-8 w-full items-center justify-center gap-1.5 border-t border-[var(--cf-border)] px-3 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
              >
                <ChevronDown size={13} />
                {t("dbml.history.showMore", {
                  count: String(Math.min(remaining, HISTORY_PAGE)),
                })}
              </button>
            )}
          </div>
        )}

        {/* Older than this session. The list above is what changed while the diagram has been open;
            `doc_versions` keeps snapshots of the saved document from before that, including from
            previous days — which is where "I need what it looked like on Tuesday" actually lives.
            Always offered, including when the session list is empty, because that is exactly the
            state a freshly opened diagram is in.

            In the document's own colour and wearing a chevron, not muted like a footnote: this is
            the *only* way into the saved versions from the schema editor — the diagram header's
            second button for them is gone, see `DiagramsView` — so it has to read as a door rather
            than as a caption under the list. */}
        <button
          type="button"
          onClick={() => {
            onOlder();
            onClose();
          }}
          className="flex h-9 shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 text-[13px] text-[var(--cf-text)] transition-colors hover:bg-[var(--cf-hover)]"
        >
          <Archive size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-left">{t("dbml.history.older")}</span>
          <ChevronRight size={14} className="shrink-0 text-[var(--cf-text-faint)]" />
        </button>
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
      <div className="flex min-h-[34px] items-center gap-1.5 py-1 pl-3 pr-2 transition-colors hover:bg-[var(--cf-hover)]">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--cf-text)]">
            {t(CAUSE_LABEL[revision.cause])}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-success)]">
            {summary.added > 0 ? `+${summary.added}` : ""}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-danger)]">
            {summary.removed > 0 ? `−${summary.removed}` : ""}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-text-faint)]">
            {new Date(revision.at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </button>
        <Tooltip label={t("dbml.history.revert")}>
          <button
            type="button"
            onClick={onRevert}
            aria-label={t("dbml.history.revert")}
            className={iconButtonClass({ size: "xs" })}
          >
            <RotateCcw size={13} />
          </button>
        </Tooltip>
      </div>

      {/* A code well: the sunken tone every read-only block of code inside a sheet wears. */}
      {expanded && diff && (
        <div className="max-h-[220px] overflow-auto border-t border-[var(--cf-border)] bg-[var(--cf-sunken)] px-1.5 py-1.5">
          {diff.lines.length === 0 ? (
            <p className="px-1.5 py-1 text-[11px] text-[var(--cf-text-muted)]">
              {t("dbml.history.noLines")}
            </p>
          ) : (
            diff.lines.map((line, at) => (
              <div
                key={`${line.kind}-${line.line}-${at}`}
                className="flex items-baseline gap-1.5 font-mono text-[11px] leading-[1.5]"
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
            <p className="px-1.5 pt-1 text-[11px] italic text-[var(--cf-text-faint)]">
              {t("dbml.history.more", { count: String(diff.truncated) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
