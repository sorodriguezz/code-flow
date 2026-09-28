import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ListChecks, Minus, Plus, Undo2, X } from "lucide-react";
import type { DiffHunkInfo, DiffLine, FileDiffInfo, HunkRef } from "../../types/domain";
import { useRepoStore } from "../../state/repoStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { lineClasses } from "../../lib/diffText";
import {
  hunkAnchors,
  hunkLineIds,
  lineId,
  pruneSelection,
  rangeIds,
  selectionCounts,
  selectionPayload,
} from "../../lib/lineSelection";
import { buttonClass, iconButtonClass } from "../common/Button";
import { InlineContent } from "./DiffInline";

/**
 * What the Changes screen hands `DiffView` to make its unified diff *stageable*: which side the file
 * is on, its path, and the same file at the store's narrow context, which is where the per-hunk
 * buttons come from (see `hunkAnchors`). Memoise it in the caller — `DiffView` is memoised on props.
 */
export interface DiffStaging {
  /** The staged side offers "unstage"; the other one offers "stage" and "discard". */
  staged: boolean;
  path: string;
  narrow: FileDiffInfo | undefined;
  /** `false` for a path lines cannot be picked out of at all — a submodule, whose "diff" is two
   *  commit ids. Its row's own buttons are the whole of what can be done to it. */
  pickable: boolean;
}

/**
 * The unified diff of one file, with lines to pick and hunks to act on — Fork's and GitKraken's
 * gesture set: click a line number to select that line, drag or shift-click for a range, ⌘/Ctrl-click
 * to add or remove one; then stage, unstage or discard exactly those. Each hunk (at git's usual three
 * lines of context) carries its own buttons above its first line.
 *
 * Nothing here decides what to write. The selection is sent as the rows it drew and the backend
 * finds them in a diff it recomputes, or refuses — see `git/lines.rs`.
 */
export function StagingDiff({
  file,
  staging,
  scrollRef,
  changeMap,
}: {
  file: FileDiffInfo;
  staging: DiffStaging;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** `DiffView`'s overview strip, drawn beside the rows as it is in the plain view. */
  changeMap: ReactNode;
}) {
  const t = useT();
  const busy = useRepoStore((s) => s.busy);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const dragging = useRef(false);
  // The handlers read the file through a ref so they keep one identity across refreshes, and the
  // memoised rows only re-render when their own `selected` flips — a drag across a long file would
  // otherwise re-render every row on every line it crosses.
  const fileRef = useRef(file);
  fileRef.current = file;

  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [staging.path, staging.staged]);

  // A refresh keeps whatever it still has — see `pruneSelection` for why an edited line drops out.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = pruneSelection(file, prev);
      return next.size === prev.size ? prev : next;
    });
  }, [file]);

  useEffect(() => {
    const end = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  const onGutterDown = useCallback((id: string, event: React.MouseEvent) => {
    if (event.button !== 0) return;
    // No text selection while picking lines: a drag down the gutter is a range of lines, not a copy.
    event.preventDefault();
    if (event.shiftKey && anchor.current) {
      setSelected(new Set(rangeIds(fileRef.current, anchor.current, id)));
      return;
    }
    anchor.current = id;
    if (event.metaKey || event.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    dragging.current = true;
    setSelected((prev) => (prev.size === 1 && prev.has(id) ? new Set() : new Set([id])));
  }, []);

  const onGutterEnter = useCallback((id: string) => {
    if (!dragging.current || !anchor.current) return;
    setSelected(new Set(rangeIds(fileRef.current, anchor.current, id)));
  }, []);

  // The per-hunk buttons only where `hunk.rs` can act: a modified file. A new, deleted or conflicted
  // one is a single whole-file change, which the row's own buttons already are.
  const anchors = useMemo(
    () =>
      staging.pickable && staging.narrow?.status === "modified"
        ? hunkAnchors(file, staging.narrow)
        : new Map<string, number>(),
    [file, staging.narrow, staging.pickable],
  );
  const hunkTotal = staging.narrow?.hunks.length ?? 0;
  const selectable =
    staging.pickable && !["conflicted", "typechange", "renamed"].includes(file.status) && !file.binary;
  const counts = useMemo(() => selectionCounts(file, selected), [file, selected]);

  const runLines = async (op: "stage" | "unstage" | "discard") => {
    const payload = selectionPayload(file, staging.path, selected);
    if (payload.lines.length === 0) return;
    if (op === "discard") {
      const ok = await confirmAction(
        t("lines.discardConfirm", { n: String(payload.lines.length), path: staging.path }),
        true,
        t("lines.discard"),
      );
      if (!ok) return;
    }
    const repo = useRepoStore.getState();
    const done =
      op === "stage"
        ? await repo.stageLines(payload)
        : op === "unstage"
          ? await repo.unstageLines(payload)
          : await repo.discardLines(payload);
    if (done) setSelected(new Set());
  };

  const runHunk = async (op: "stage" | "unstage" | "discard", hunk: DiffHunkInfo) => {
    const ref: HunkRef = { file_path: staging.path, header: hunk.header, lines: hunk.lines };
    if (op === "discard") {
      const ok = await confirmAction(t("lines.discardHunkConfirm", { path: staging.path }), true, t("lines.discardHunk"));
      if (!ok) return;
    }
    const repo = useRepoStore.getState();
    if (op === "stage") await repo.stageHunk(ref);
    else if (op === "unstage") await repo.unstageHunk(ref);
    else await repo.discardHunk(ref);
  };

  const selectHunk = (hunk: DiffHunkInfo) => {
    const ids = hunkLineIds(hunk);
    anchor.current = ids[ids.length - 1] ?? null;
    setSelected(new Set(ids));
  };

  const hint = t("lines.gutterHint");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto">
          <div className="divide-y divide-[var(--cf-border)]">
            {file.hunks.map((hunk, hIdx) => (
              <div key={hIdx} className="select-text font-mono text-[12px] leading-5">
                <div
                  className={`border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-accent)_6%,var(--cf-surface))] px-3 py-1 text-[var(--cf-text-muted)] ${
                    hIdx > 0 ? "border-t" : ""
                  }`}
                >
                  {hunk.header}
                </div>
                {hunk.lines.map((line, lIdx) => {
                  const narrowIndex = anchors.get(`${hIdx}:${lIdx}`);
                  const id = selectable ? lineId(line) : null;
                  const narrowHunk = narrowIndex === undefined ? undefined : staging.narrow?.hunks[narrowIndex];
                  return (
                    <Fragment key={lIdx}>
                      {narrowHunk && narrowIndex !== undefined && (
                        <HunkBar
                          index={narrowIndex}
                          total={hunkTotal}
                          staged={staging.staged}
                          disabled={busy}
                          onAct={(op) => void runHunk(op, narrowHunk)}
                          onSelect={() => selectHunk(narrowHunk)}
                        />
                      )}
                      <Row
                        line={line}
                        lines={hunk.lines}
                        index={lIdx}
                        id={id}
                        selected={id !== null && selected.has(id)}
                        hint={hint}
                        onDown={onGutterDown}
                        onEnter={onGutterEnter}
                      />
                    </Fragment>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {changeMap}
      </div>
      {selected.size > 0 && (
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] pl-3 pr-2">
          <span className="mr-auto flex min-w-0 items-center gap-2 text-[12px] tabular-nums text-[var(--cf-text-muted)]">
            {t("lines.selected", { n: String(selected.size) })}
            {counts.added > 0 && <span className="text-[var(--cf-success)]">+{counts.added}</span>}
            {counts.removed > 0 && <span className="text-[var(--cf-danger)]">−{counts.removed}</span>}
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            title={t("lines.clear")}
            aria-label={t("lines.clear")}
            className={iconButtonClass({ size: "xs" })}
          >
            <X size={13} />
          </button>
          {staging.staged ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void runLines("unstage")}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              <Minus size={13} />
              {t("lines.unstage")}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runLines("discard")}
                className={buttonClass({ variant: "danger-ghost", size: "sm" })}
              >
                <Undo2 size={13} />
                {t("lines.discard")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runLines("stage")}
                className={buttonClass({ variant: "primary", size: "sm" })}
              >
                <Plus size={13} />
                {t("lines.stage")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One diff row. Memoised: only a row whose `selected` changed re-renders during a drag. */
const Row = memo(function Row({
  line,
  lines,
  index,
  id,
  selected,
  hint,
  onDown,
  onEnter,
}: {
  line: DiffLine;
  lines: DiffLine[];
  index: number;
  /** `null` for a row that cannot be picked — context, or a file lines cannot be staged in. */
  id: string | null;
  selected: boolean;
  hint: string;
  onDown: (id: string, event: React.MouseEvent) => void;
  onEnter: (id: string) => void;
}) {
  return (
    <div
      className={`flex gap-3 px-3 ${lineClasses(line.origin)}`}
      // The accent rule on the left edge is the selection — a second fill over the green or red would
      // hide which kind of line was picked.
      style={
        selected
          ? {
              boxShadow: "inset 3px 0 0 var(--cf-accent)",
              background: "color-mix(in oklab, var(--cf-accent) 16%, transparent)",
            }
          : undefined
      }
    >
      <span
        onMouseDown={id ? (event) => onDown(id, event) : undefined}
        onMouseEnter={id ? () => onEnter(id) : undefined}
        title={id ? hint : undefined}
        className={`flex shrink-0 select-none gap-3 text-[var(--cf-text-faint)] ${
          id ? "cursor-pointer hover:text-[var(--cf-text)]" : ""
        }`}
      >
        <span className="w-8 text-right tabular-nums">{line.old_lineno ?? ""}</span>
        <span className="w-8 text-right tabular-nums">{line.new_lineno ?? ""}</span>
      </span>
      <span className="whitespace-pre-wrap break-all">
        {line.origin === "+" || line.origin === "-" ? line.origin : " "}
        <InlineContent line={line} lines={lines} index={index} />
      </span>
    </div>
  );
});

/** The buttons above one hunk: stage/discard it (or unstage it), or select its lines to pick from. */
function HunkBar({
  index,
  total,
  staged,
  disabled,
  onAct,
  onSelect,
}: {
  index: number;
  total: number;
  staged: boolean;
  disabled: boolean;
  onAct: (op: "stage" | "unstage" | "discard") => void;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-7 select-none items-center gap-1 border-y border-[var(--cf-border)] bg-[var(--cf-sunken)] pl-3 pr-2 font-sans text-[11px] text-[var(--cf-text-muted)]">
      <span className="mr-auto tabular-nums">{t("lines.hunkLabel", { n: String(index + 1), total: String(total) })}</span>
      <button
        type="button"
        onClick={onSelect}
        title={t("lines.selectHunk")}
        aria-label={t("lines.selectHunk")}
        className={iconButtonClass({ size: "xs" })}
      >
        <ListChecks size={12} />
      </button>
      {staged ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAct("unstage")}
          className={buttonClass({ variant: "ghost", size: "sm", className: "h-[22px] px-1.5 text-[11px]" })}
        >
          <Minus size={12} />
          {t("lines.unstageHunk")}
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAct("discard")}
            title={t("lines.discardHunk")}
            aria-label={t("lines.discardHunk")}
            className={iconButtonClass({ size: "xs", className: "hover:text-[var(--cf-danger)]" })}
          >
            <Undo2 size={12} />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAct("stage")}
            className={buttonClass({ variant: "ghost", size: "sm", className: "h-[22px] px-1.5 text-[11px]" })}
          >
            <Plus size={12} />
            {t("lines.stageHunk")}
          </button>
        </>
      )}
    </div>
  );
}
