import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { FileGlyph } from "../../common/FileGlyph";
import { iconButtonClass } from "../../common/Button";
import { Tooltip } from "../../common/Tooltip";
import { reviewKeyOf } from "./rowStatus";
import { reviewOf, useTaskReviewStore } from "../../../state/taskReviewStore";
import { useT } from "../../../state/languageStore";
import { listDir, readFileText } from "../../../lib/tauri/commands";
import { Markdown } from "../../common/Markdown";
import type { WorktreeRow } from "../../../lib/agents/worktreeRows";
import type { FileEntry } from "../../../types/domain";

/**
 * The working copy's files, on the right of the «Worktrees» layout — what Orca keeps beside its
 * terminals. Read a folder at a time, when it is opened: a worktree is a whole checkout, and walking
 * it up front would be a `node_modules` read nobody asked for.
 *
 * The files the agent changed wear their status colour, so the tree doubles as "where did it work".
 */
export function WorktreeFiles({ row, onOpen }: { row: WorktreeRow; onOpen: (rel: string) => void }) {
  const t = useT();
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const changed = useTaskReviewStore((s) => reviewOf(s, reviewKeyOf(row)).files);

  const read = useCallback(
    async (dir: string) => {
      const entries = await listDir(row.path, dir === "" ? undefined : dir).catch(() => [] as FileEntry[]);
      setDirs((current) => ({ ...current, [dir]: entries }));
    },
    [row.path],
  );

  useEffect(() => {
    setDirs({});
    setOpen(new Set([""]));
    if (row.path) void read("");
  }, [row.path, read]);

  const toggle = (dir: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!dirs[dir]) void read(dir);
      }
      return next;
    });
  };

  const changedPaths = new Set(changed.map((file) => file.path));
  /** A folder holding a changed file, so a collapsed tree still says where to look. */
  const touched = (dir: string) => changed.some((file) => file.path.startsWith(`${dir}/`));

  const render = (dir: string, depth: number): ReactNode =>
    (dirs[dir] ?? []).map((entry) => {
      const isOpen = open.has(entry.path);
      const isChanged = entry.is_dir ? touched(entry.path) : changedPaths.has(entry.path);
      return (
        <div key={entry.path}>
          <button
            type="button"
            onClick={() => (entry.is_dir ? toggle(entry.path) : onOpen(entry.path))}
            className="flex h-[24px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] hover:bg-[var(--cf-hover)]"
            style={{ paddingLeft: 6 + depth * 12 }}
            title={entry.path}
          >
            {entry.is_dir ? (
              <ChevronRight size={12} className={`shrink-0 text-[var(--cf-text-faint)] ${isOpen ? "rotate-90" : ""}`} />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <FileGlyph path={entry.name} isFolder={entry.is_dir} open={isOpen} size={13} />
            <span className={`min-w-0 flex-1 truncate ${isChanged ? "text-[var(--cf-warning)]" : "text-[var(--cf-text)]"}`}>
              {entry.name}
            </span>
          </button>
          {entry.is_dir && isOpen && render(entry.path, depth + 1)}
        </div>
      );
    });

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-l border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))]">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
          {t("wt.files")}
        </span>
        <Tooltip label={t("wt.filesRefresh")}>
          <button
            type="button"
            aria-label={t("wt.filesRefresh")}
            onClick={() => {
              for (const dir of open) void read(dir);
            }}
            className={iconButtonClass({ size: "sm" })}
          >
            <RefreshCw size={12} />
          </button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">{render("", 0)}</div>
    </aside>
  );
}

/** One file of the working copy, read-only: Markdown rendered, anything else as numbered lines. */
export function WorktreeFileView({ root, rel }: { root: string; rel: string }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setText(null);
    setError("");
    void readFileText(root, rel)
      .then((value) => alive && setText(value))
      .catch((e: unknown) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [root, rel]);

  if (error) return <p className="p-4 text-[12.5px] text-[var(--cf-danger)]">{error}</p>;
  if (text === null) return <p className="p-4 text-[12.5px] text-[var(--cf-text-muted)]">{t("wt.fileLoading")}</p>;

  if (/\.(md|markdown|mdx)$/i.test(rel)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <Markdown source={text} className="cf-markdown-preview mx-auto max-w-[820px]" />
      </div>
    );
  }
  // A table row per line is cheap until it is not: past this the rest is cut, and the note says so.
  const all = text.split("\n");
  const lines = all.length > MAX_LINES ? all.slice(0, MAX_LINES) : all;
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--cf-surface)]">
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
        <tbody>
          {lines.map((line, at) => (
            <tr key={at}>
              <td className="w-0 select-none whitespace-nowrap px-3 text-right text-[var(--cf-text-faint)]">{at + 1}</td>
              <td className="whitespace-pre pr-4 text-[var(--cf-text)]">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {all.length > MAX_LINES && (
        <p className="px-3 py-2 text-[11.5px] text-[var(--cf-text-muted)]">{t("wt.fileCut", { n: MAX_LINES })}</p>
      )}
    </div>
  );
}

const MAX_LINES = 5000;
