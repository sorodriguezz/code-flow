import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Columns2, FileDiff, Rows3, X } from "lucide-react";
import type { FileDiffInfo } from "../../types/domain";
import { EmptyState } from "../common/EmptyState";
import { useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";
import { languageForPath } from "../../lib/monacoLanguage";
import { fileStatusLabelKey, fileStatusColor as statusColor } from "../../lib/fileStatus";

type ViewMode = "unified" | "split";

function lineClasses(origin: string): string {
  if (origin === "+") return "bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] text-[var(--cf-text)]";
  if (origin === "-") return "bg-[color-mix(in_oklab,var(--cf-danger)_14%,transparent)] text-[var(--cf-text)]";
  return "text-[var(--cf-text-muted)]";
}

/** Rebuilds the two full-text sides of a file's diff from its hunks — the diff commands
 * already run with (near-)unlimited context lines, so for anything but a huge commit-view
 * diff this reproduces the whole original/modified file, which is what the side-by-side
 * Monaco DiffEditor needs (it diffs two full texts itself, not a hunk list). */
function reconstructSides(file: FileDiffInfo): { original: string; modified: string } {
  const original: string[] = [];
  const modified: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.origin === "-") original.push(line.content);
      else if (line.origin === "+") modified.push(line.content);
      else {
        original.push(line.content);
        modified.push(line.content);
      }
    }
  }
  return { original: original.join("\n"), modified: modified.join("\n") };
}

const MIN_SPLIT_HEIGHT = 120;
const MAX_SPLIT_HEIGHT = 640;
const SPLIT_LINE_HEIGHT = 19;

/** How far outside the viewport an editor starts loading. A screenful of lead time, so scrolling
 * at a normal pace always lands on one that is already up rather than on a placeholder. */
const PRELOAD_MARGIN = "800px";

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

/**
 * One file's side-by-side pane, mounted only once it is near the viewport.
 *
 * Every file used to get its own `DiffEditor` the moment split mode opened, all of them at once.
 * Each one is two Monaco models, a diff computed in a worker, a tokenizer pass over the whole file
 * and — with `automaticLayout` — its own resize observer. On a commit that touches a lockfile that
 * is tens of thousands of lines through a JSON tokenizer *before the first frame*, which is why the
 * view arrived already stuck: the work was not slow to scroll, it was all being done up front for
 * panes that were nowhere near the screen.
 *
 * Reconstructing the two sides is deferred with it. That is where the big strings get built, and
 * building them for a file nobody has scrolled to is the same waste one step earlier.
 */
function SplitFileDiff({ file, height }: { file: FileDiffInfo; height: number }) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const holderRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  const path = file.new_path ?? file.old_path ?? "";

  useEffect(() => {
    // Once up it stays up: tearing an editor down on scroll-out only to rebuild it on the way back
    // trades a one-off cost for a repeating one, and scrolling a diff is mostly back and forth.
    if (live) return;
    const el = holderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setLive(true),
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [live]);

  const sides = useMemo(() => (live ? reconstructSides(file) : null), [live, file]);

  return (
    <div ref={holderRef} style={{ height }}>
      {sides ? (
        <DiffEditor
          height="100%"
          language={languageForPath(path)}
          original={sides.original}
          modified={sides.modified}
          theme={monacoTheme}
          options={{
            readOnly: true,
            fontSize: 13,
            renderSideBySide: true,
            // Monaco silently collapses side-by-side into a unified-looking layout below ~900px
            // wide (e.g. inside a modal) unless told not to — the whole point of this toggle is
            // an actual two-pane view, so never let it fall back on its own.
            useInlineViewWhenSpaceIsLimited: false,
            automaticLayout: true,
            // A generated lockfile can take Monaco's differ arbitrarily long. Past this it falls
            // back to a coarser result, which for a file you are scrolling past is the right
            // trade — an approximate diff beats a frozen pane.
            maxComputationTime: 2000,
            scrollBeyondLastLine: false,
          }}
        />
      ) : (
        <div className="h-full bg-[var(--cf-bg)]" />
      )}
    </div>
  );
}

/** A compact overview strip along the right edge, in the same spirit as VS Code's overview
 * ruler: one colored tick per added/removed line, positioned proportionally to that line's
 * place in the overall diff, clickable to jump straight there. Only shown in unified mode —
 * the split view already gets Monaco's own overview ruler for free. */
function ChangeMap({
  files,
  containerRef,
}: {
  files: FileDiffInfo[];
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { totalRows, marks } = useMemo(() => {
    let row = 0;
    const marks: { row: number; color: string }[] = [];
    for (const file of files) {
      row += 1;
      for (const hunk of file.hunks) {
        row += 1;
        for (const line of hunk.lines) {
          if (line.origin === "+") marks.push({ row, color: "var(--cf-success)" });
          else if (line.origin === "-") marks.push({ row, color: "var(--cf-danger)" });
          row += 1;
        }
      }
    }
    return { totalRows: row, marks };
  }, [files]);

  if (totalRows === 0) return null;

  const jumpTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    el.scrollTo({ top: ratio * el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div
      onClick={jumpTo}
      className="sticky top-0 h-full w-3 shrink-0 cursor-pointer self-stretch bg-black/[0.02] dark:bg-white/[0.04]"
    >
      <div className="relative h-full w-full">
        {marks.map((m, i) => (
          <div
            key={i}
            className="absolute left-0.5 right-0.5 rounded-[1px]"
            style={{ top: `${(m.row / totalRows) * 100}%`, height: 2, background: m.color }}
          />
        ))}
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

  /** Shared by both modes, so the close button can't exist in one view and not the other. */
  const toolbar = (
    <div className="flex items-center justify-end gap-1.5 border-b border-[var(--cf-border)] px-3 py-1.5">
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
      <div className="flex h-full">
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto">
          {toolbar}
          <div className="divide-y divide-[var(--cf-border)]">
            {files.map((file, i) => {
              const color = statusColor(file.status);
              return (
                <div key={i}>
                  <div
                    className="sticky top-0 z-10 flex items-center gap-2 border-b-2 bg-[var(--cf-surface-raised)] px-3 py-2 text-[12px] font-semibold shadow-sm"
                    style={{ borderBottomColor: color, willChange: "transform", contain: "paint" }}
                  >
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                      style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}
                    >
                      {t(fileStatusLabelKey(file.status))}
                    </span>
                    <span className="truncate font-mono text-[var(--cf-text)]">{file.new_path ?? file.old_path}</span>
                  </div>
                  <SplitFileDiff file={file} height={splitHeightOf(file)} />
                </div>
              );
            })}
          </div>
        </div>
        <ChangeMap files={files} containerRef={scrollRef} />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto">
        {toolbar}
        <div className="divide-y divide-[var(--cf-border)]">
          {files.map((file, i) => {
            const color = statusColor(file.status);
            return (
              <div key={i}>
                <div
                  className="sticky top-0 z-10 flex items-center gap-2 border-b-2 bg-[var(--cf-surface-raised)] px-3 py-2 text-[12px] font-semibold shadow-sm"
                  style={{ borderBottomColor: color, willChange: "transform", contain: "paint" }}
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
                  <div key={hIdx} className="select-text font-mono text-[12px] leading-5">
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
  );
}

/** Memoized on `files` — dragging the diff panel's resize handle only changes the panel's
 * width in the parent (`GraphView`/`ChangesPanel`), which re-renders every drag tick; without
 * this, a large commit's whole line-by-line diff tree (or several Monaco `DiffEditor`s in
 * split mode) would get rebuilt on every pointermove instead of just resizing. */
export const DiffView = memo(DiffViewImpl);
