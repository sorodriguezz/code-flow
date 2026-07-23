import { memo, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Columns2, FileDiff, Rows3 } from "lucide-react";
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

function SplitFileDiff({ file }: { file: FileDiffInfo }) {
  const resolved = useThemeStore((s) => s.resolved);
  const { original, modified } = useMemo(() => reconstructSides(file), [file]);
  const path = file.new_path ?? file.old_path ?? "";
  const lineCount = Math.max(original.split("\n").length, modified.split("\n").length);
  const height = Math.min(MAX_SPLIT_HEIGHT, Math.max(MIN_SPLIT_HEIGHT, lineCount * SPLIT_LINE_HEIGHT + 24));

  return (
    <DiffEditor
      height={height}
      language={languageForPath(path)}
      original={original}
      modified={modified}
      theme={resolved === "dark" ? "vs-dark" : "vs"}
      options={{
        readOnly: true,
        fontSize: 13,
        renderSideBySide: true,
        // Monaco silently collapses side-by-side into a unified-looking layout below ~900px
        // wide (e.g. inside a modal) unless told not to — the whole point of this toggle is
        // an actual two-pane view, so never let it fall back on its own.
        useInlineViewWhenSpaceIsLimited: false,
        automaticLayout: true,
      }}
    />
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

function DiffViewImpl({ files }: { files: FileDiffInfo[] }) {
  const t = useT();
  const [mode, setMode] = useState<ViewMode>("unified");
  const scrollRef = useRef<HTMLDivElement>(null);

  if (files.length === 0) {
    return <EmptyState icon={FileDiff} title={t("diff.noChanges")} subtitle={t("diff.noChangesHint")} />;
  }

  const modeToggle = (
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
  );

  if (mode === "split") {
    return (
      <div className="flex h-full">
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto">
          <div className="flex items-center justify-end border-b border-[var(--cf-border)] px-3 py-1.5">{modeToggle}</div>
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
                  <SplitFileDiff file={file} />
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
        <div className="flex items-center justify-end border-b border-[var(--cf-border)] px-3 py-1.5">{modeToggle}</div>
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
                  <div key={hIdx} className="font-mono text-[12px] leading-5">
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
