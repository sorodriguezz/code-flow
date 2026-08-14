import { lazy, memo, Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Columns2, FileDiff, Rows3, X } from "lucide-react";
import type { FileDiffInfo } from "../../types/domain";
import { EmptyState } from "../common/EmptyState";
import { useT } from "../../state/languageStore";
import { lineClasses } from "../../lib/diffText";
import { fileStatusLabelKey, fileStatusColor as statusColor } from "../../lib/fileStatus";

/**
 * The split view's editor pane, and the only part of this file that needs Monaco.
 *
 * Lazy on purpose, and it is what keeps the 4 MB editor off the boot path. This component is
 * imported statically by the commit list, the Changes panel and the stash viewer — all of which are
 * on the first frame — so anything it reaches is in the entry chunk. Unified is the default mode
 * and renders plain DOM, so the overwhelmingly common path through a diff never needs an editor at
 * all; pressing the split toggle is what asks for one.
 */
const SplitFileDiff = lazy(() => import("./SplitFileDiff").then((m) => ({ default: m.SplitFileDiff })));

type ViewMode = "unified" | "split";

const MIN_SPLIT_HEIGHT = 120;
const MAX_SPLIT_HEIGHT = 640;
const SPLIT_LINE_HEIGHT = 19;

/** `leading-5` on the unified hunk body, in pixels — one rendered code line. */
const UNIFIED_LINE_HEIGHT = 20;
/** The `@@ … @@` bar above a unified hunk: one `leading-5` line plus its `py-1`. */
const UNIFIED_HUNK_HEADER_HEIGHT = 28;

/**
 * The height a unified hunk will take, from its line count alone.
 *
 * Only ever an estimate — a long line wraps (`whitespace-pre-wrap break-all`) and takes two rows —
 * which is exactly why it is handed to `contain-intrinsic-size` with the `auto` keyword: the
 * browser uses this number until the hunk has been rendered once and its real height is known, and
 * from then on it remembers the real one. So the guess only has to be close enough that the
 * scrollbar doesn't visibly resettle on the first pass down a file.
 */
function unifiedHunkHeight(lineCount: number): number {
  return UNIFIED_HUNK_HEADER_HEIGHT + lineCount * UNIFIED_LINE_HEIGHT;
}

/** The height a file's pane will take, computed from the hunks alone — no strings built, no editor
 * mounted. This is what lets the list reserve its full scroll height before any of it has loaded,
 * so the scrollbar doesn't grow under the pointer and the change map's marks stay where they are. */
function splitHeightOf(file: FileDiffInfo): number {
  let original = 0;
  let modified = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.origin === "-") original += 1;
      else if (line.origin === "+") modified += 1;
      else {
        original += 1;
        modified += 1;
      }
    }
  }
  const lines = Math.max(original, modified);
  return Math.min(MAX_SPLIT_HEIGHT, Math.max(MIN_SPLIT_HEIGHT, lines * SPLIT_LINE_HEIGHT + 24));
}

/** One tick's height in the change map, and so the strip's own resolution: two ticks closer
 *  together than this cannot be told apart, which is what sets the bucket count in `ChangeMap`. */
const MARK_HEIGHT = 2;

/**
 * A compact overview strip along the right edge, in the same spirit as VS Code's overview ruler:
 * colored ticks showing where the additions and deletions are in the diff as a whole, clickable to
 * jump straight there. Shown in **both** modes — split gets Monaco's own ruler per file, but that
 * one only ever covers the file it belongs to, and this is the map of the whole commit.
 *
 * **It draws one tick per bucket, not one per changed line.** It used to be one absolutely
 * positioned `<div>` per changed line, uncapped: a 20,000-line commit built 20,000 nodes — several
 * megabytes of layout — inside a strip twelve pixels wide. The information those nodes carry is
 * bounded by the strip's height in *pixels*, so past a few hundred they were provably drawing on
 * top of each other. The strip is measured and quantized into one bucket per tick-height, which is
 * the finest grain it can actually show; the bucket count comes from the measurement rather than
 * from a constant, so a tall window gets a finer map and a short one does not lie about its detail.
 *
 * **A bucket holding both an addition and a deletion draws both**, side by side across the strip's
 * width — green left, red right. Collapsing those to one colour would erase the churn reading on a
 * rewritten file, which is the one thing this strip is best at saying.
 */
function ChangeMap({
  files,
  containerRef,
}: {
  files: FileDiffInfo[];
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [buckets, setBuckets] = useState(0);

  const { totalRows, marks } = useMemo(() => {
    // First pass counts rows only — no allocation, and the bucket index needs the total before it
    // can place anything.
    let total = 0;
    for (const file of files) {
      total += 1;
      for (const hunk of file.hunks) total += 1 + hunk.lines.length;
    }
    if (total === 0 || buckets === 0) {
      return { totalRows: total, marks: [] as { bucket: number; add: boolean; del: boolean }[] };
    }
    // Two flags per bucket, not a list of lines: whether *anything* was added or removed in this
    // slice of the diff is the entire signal a 2px tick can carry.
    const added = new Uint8Array(buckets);
    const removed = new Uint8Array(buckets);
    let row = 0;
    for (const file of files) {
      row += 1;
      for (const hunk of file.hunks) {
        row += 1;
        for (const line of hunk.lines) {
          if (line.origin === "+" || line.origin === "-") {
            const bucket = Math.min(buckets - 1, Math.floor((row / total) * buckets));
            if (line.origin === "+") added[bucket] = 1;
            else removed[bucket] = 1;
          }
          row += 1;
        }
      }
    }
    const marks: { bucket: number; add: boolean; del: boolean }[] = [];
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      if (added[bucket] || removed[bucket]) {
        marks.push({ bucket, add: added[bucket] === 1, del: removed[bucket] === 1 });
      }
    }
    return { totalRows: total, marks };
  }, [files, buckets]);

  const hasRows = totalRows > 0;
  // Measured in a layout effect so the first painted frame already has its ticks — a `useEffect`
  // here would show an empty strip for one frame every time a diff opens. Re-runs when the strip
  // appears, because with nothing to show it isn't in the DOM for the ref to catch.
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = (height: number) => setBuckets(Math.max(1, Math.floor(height / MARK_HEIGHT)));
    measure(el.clientHeight);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasRows]);

  if (!hasRows) return null;

  const jumpTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    el.scrollTo({ top: ratio * el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div
      ref={stripRef}
      onClick={jumpTo}
      className="sticky top-0 h-full w-3 shrink-0 cursor-pointer self-stretch bg-black/[0.02] dark:bg-white/[0.04]"
    >
      <div className="relative h-full w-full">
        {marks.map((m) => {
          const top = `${(m.bucket / buckets) * 100}%`;
          const both = m.add && m.del;
          return (
            <div key={m.bucket}>
              {m.add && (
                <div
                  className={`absolute left-0.5 rounded-[1px] ${both ? "right-1/2" : "right-0.5"}`}
                  style={{ top, height: MARK_HEIGHT, background: "var(--cf-success)" }}
                />
              )}
              {m.del && (
                <div
                  className={`absolute right-0.5 rounded-[1px] ${both ? "left-1/2" : "left-0.5"}`}
                  style={{ top, height: MARK_HEIGHT, background: "var(--cf-danger)" }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffViewImpl({
  files,
  onClose,
}: {
  files: FileDiffInfo[];
  /**
   * Dismisses the diff. Supplied only where the diff is one pane of a view that reads perfectly
   * well without it — the Changes screen — and left out where the diff *is* the view, as in the
   * stash dialog, whose own chrome already closes it.
   *
   * Must be referentially stable. This component is memoised on its props precisely so that
   * dragging the panel's resize handle doesn't rebuild a large diff on every pointer move, and an
   * inline arrow would defeat that on every parent render.
   */
  onClose?: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<ViewMode>("unified");
  const scrollRef = useRef<HTMLDivElement>(null);

  if (files.length === 0) {
    return <EmptyState icon={FileDiff} title={t("diff.noChanges")} subtitle={t("diff.noChangesHint")} />;
  }

  /** Shared by both modes, so the close button can't exist in one view and not the other. Sits
   * outside the scroll container in both, so it stays put while the diff scrolls under it. */
  const toolbar = (
    <div className="flex shrink-0 items-center justify-end gap-1.5 border-b border-[var(--cf-border)] px-3 py-1.5">
      <div className="flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] p-0.5">
        <button
          onClick={() => setMode("unified")}
          title={t("diff.unifiedView")}
          className={`flex h-5 w-5 items-center justify-center rounded ${
            mode === "unified" ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
          }`}
        >
          <Rows3 size={12} />
        </button>
        <button
          onClick={() => setMode("split")}
          title={t("diff.splitView")}
          className={`flex h-5 w-5 items-center justify-center rounded ${
            mode === "split" ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
          }`}
        >
          <Columns2 size={12} />
        </button>
      </div>
      {onClose && (
        <button
          onClick={onClose}
          title={t("diff.close")}
          aria-label={t("diff.close")}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );

  if (mode === "split") {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="flex min-h-0 flex-1">
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto">
            <div className="divide-y divide-[var(--cf-border)]">
              {files.map((file, i) => {
                const color = statusColor(file.status);
                return (
                  <div key={i}>
                    <div
                      className="sticky top-0 z-10 flex items-center gap-2 border-b-2 bg-[var(--cf-surface-raised)] px-3 py-2 text-[12px] font-semibold shadow-sm"
                      // `contain: paint` stays — it keeps the header's repaints out of the rest of
                      // the list. `will-change: transform` does not: it promotes the element to its
                      // own composited layer *for the element's whole lifetime*, and this header is
                      // emitted once per file, so a 200-file commit was holding 200 permanent GPU
                      // textures (~23MB) to smooth a transform that only happens while that one file
                      // is on screen. `position: sticky` already gets promoted when it needs to be.
                      style={{ borderBottomColor: color, contain: "paint" }}
                    >
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                        style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}
                      >
                        {t(fileStatusLabelKey(file.status))}
                      </span>
                      <span className="truncate font-mono text-[var(--cf-text)]">{file.new_path ?? file.old_path}</span>
                    </div>
                    {/* The fallback is the very element `SplitFileDiff` itself renders until it
                        intersects the viewport (and most panes in a long diff are showing exactly
                        that at any moment), so the chunk arriving changes nothing on screen. */}
                    <Suspense fallback={<div style={{ height: splitHeightOf(file) }} className="bg-[var(--cf-bg)]" />}>
                      <SplitFileDiff file={file} height={splitHeightOf(file)} />
                    </Suspense>
                  </div>
                );
              })}
            </div>
          </div>
          <ChangeMap files={files} containerRef={scrollRef} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {toolbar}
      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto">
          <div className="divide-y divide-[var(--cf-border)]">
            {files.map((file, i) => {
              const color = statusColor(file.status);
              return (
                <div key={i}>
                  <div
                    className="sticky top-0 z-10 flex items-center gap-2 border-b-2 bg-[var(--cf-surface-raised)] px-3 py-2 text-[12px] font-semibold shadow-sm"
                    // See the same header in the split branch above: `contain: paint` earns its
                    // place, `will-change: transform` was buying one permanent composited layer per
                    // file in the commit for a promotion `position: sticky` already gets on its own.
                    style={{ borderBottomColor: color, contain: "paint" }}
                  >
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                      style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}
                    >
                      {t(fileStatusLabelKey(file.status))}
                    </span>
                    <span className="truncate font-mono text-[var(--cf-text)]">{file.new_path ?? file.old_path}</span>
                  </div>
                  {file.hunks.map((hunk, hIdx) => (
                    // `select-text` re-enables selection here (the app-wide `body { user-select: none }`
                    // otherwise makes this custom-rendered diff feel like an image). The line-number
                    // gutters keep `select-none`, so a copy grabs the code without the line numbers —
                    // matching what the Monaco-backed split view already allows.
                    <div
                      key={hIdx}
                      className="select-text font-mono text-[12px] leading-5"
                      /**
                       * The whole diff is still in the DOM — nothing is truncated, nothing is
                       * unmounted, find-in-page and select-all still reach every line — but the
                       * browser is told it may skip *rendering* a hunk that is nowhere near the
                       * viewport, and use the reserved height instead. That is what turns a
                       * ten-thousand-line commit from "lay out ten thousand lines before the first
                       * frame" into "lay out the two hunks you can see".
                       *
                       * `auto` in front of the size is load-bearing: the estimate below is only a
                       * guess (a long line wraps), and `auto` means the browser replaces it with the
                       * hunk's real height once it has rendered once, so the scrollbar settles and
                       * stays settled.
                       *
                       * Worth knowing where this does and does not fire: Chromium has had it for
                       * years, Safari only since 18.0. On macOS 13/14 this is a silent no-op and the
                       * view behaves exactly as it did before — the win here is Windows and current
                       * macOS, and nothing regresses on the older ones.
                       */
                      style={{
                        contentVisibility: "auto",
                        containIntrinsicSize: `auto ${unifiedHunkHeight(hunk.lines.length)}px`,
                      }}
                    >
                      <div className="bg-[var(--cf-accent-soft)] px-3 py-1 text-[var(--cf-accent)]">{hunk.header}</div>
                      {hunk.lines.map((line, lIdx) => (
                        <div key={lIdx} className={`flex gap-3 px-3 ${lineClasses(line.origin)}`}>
                          <span className="w-8 shrink-0 select-none text-right text-[var(--cf-text-muted)]">
                            {line.old_lineno ?? ""}
                          </span>
                          <span className="w-8 shrink-0 select-none text-right text-[var(--cf-text-muted)]">
                            {line.new_lineno ?? ""}
                          </span>
                          <span className="whitespace-pre-wrap break-all">
                            {line.origin === "+" || line.origin === "-" ? line.origin : " "}
                            {line.content}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        <ChangeMap files={files} containerRef={scrollRef} />
      </div>
    </div>
  );
}

/** Memoized on `files` — dragging the diff panel's resize handle only changes the panel's
 * width in the parent (`GraphView`/`ChangesPanel`), which re-renders every drag tick; without
 * this, a large commit's whole line-by-line diff tree (or several Monaco `DiffEditor`s in
 * split mode) would get rebuilt on every pointermove instead of just resizing. */
export const DiffView = memo(DiffViewImpl);
