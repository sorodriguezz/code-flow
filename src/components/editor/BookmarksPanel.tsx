import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bookmark, ChevronDown, ChevronRight, Circle, Trash2, X } from "lucide-react";
import { useBookmarkStore } from "../../state/bookmarkStore";
import { useDebugStore, normalizePath } from "../../state/debugStore";
import { fileIconFor } from "../../lib/fileIcon";
import { readFileText } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";

/**
 * The two kinds of "come back to this line", in one list.
 *
 * Bookmarks and breakpoints are unrelated features with unrelated storage — one is a personal note,
 * the other is where a debugger stops — but they answer the same question when you are looking for
 * one: *where was I?* Keeping them in separate panels means knowing which kind you left behind
 * before you can go and find it, so they share a column and stay clearly labelled.
 *
 * Both sections are grouped by file for the same reason a file tree is: a flat list of line numbers
 * from four files is a list you have to read, not one you can scan.
 */

interface Row {
  /** Repo-relative — what the editor opens and what the panel groups by. */
  path: string;
  line: number;
  label: string;
  /** Identifies the row for removal: a bookmark id, or the absolute path for a breakpoint. */
  key: string;
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function groupByFile(rows: Row[]): [string, Row[]][] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const bucket = groups.get(row.path);
    if (bucket) bucket.push(row);
    else groups.set(row.path, [row]);
  }
  return [...groups.entries()];
}

function Section({
  title,
  icon,
  rows,
  emptyLabel,
  onOpen,
  onRemove,
  onClear,
  clearLabel,
}: {
  title: string;
  icon: ReactNode;
  rows: Row[];
  emptyLabel: string;
  onOpen: (row: Row) => void;
  onRemove: (row: Row) => void;
  onClear?: () => void;
  clearLabel?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  /**
   * Files folded shut, by path. Collapsed rather than expanded by default, and session-only: which
   * files you have folded is a way of reading the list right now, not a setting worth remembering
   * past the point where the marks themselves change.
   */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupByFile(rows), [rows]);

  const toggleFile = (path: string) =>
    setFolded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="mb-1">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {open ? (
            <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          )}
          {icon}
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {title}
          </span>
          <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{rows.length}</span>
        </button>
        {onClear && rows.length > 0 && (
          <button
            onClick={onClear}
            title={clearLabel}
            aria-label={clearLabel}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {open &&
        (rows.length === 0 ? (
          <p className="px-2 pb-2 pl-6 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {emptyLabel}
          </p>
        ) : (
          groups.map(([path, fileRows]) => {
            const { Icon, color } = fileIconFor(path);
            const shut = folded.has(path);
            return (
              <div key={path}>
                {/* The file row folds its own lines away. Four marks across three files is a
                    column of text to read rather than scan, and the file you are done with is
                    the one you want out of the way — so the fold is here and not only on the
                    section above, which would take the other files with it. */}
                <button
                  onClick={() => toggleFile(path)}
                  title={path}
                  aria-expanded={!shut}
                  className="flex w-full items-center gap-1.5 py-0.5 pl-3 pr-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  {shut ? (
                    <ChevronRight size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
                  ) : (
                    <ChevronDown size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
                  )}
                  <Icon size={11} className="shrink-0" style={{ color }} />
                  <span className="shrink-0 text-[11px] text-[var(--cf-text)]">{fileName(path)}</span>
                  <span className="min-w-0 truncate text-[10px] text-[var(--cf-text-muted)]">
                    {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}
                  </span>
                  {/* Only while shut: with the lines showing, the count is the lines themselves. */}
                  {shut && (
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--cf-text-muted)]">
                      {fileRows.length}
                    </span>
                  )}
                </button>
                {!shut &&
                  fileRows.map((row, at) => (
                    <div
                      key={row.key}
                      style={riseDelay(at)}
                      className="cf-rise group flex items-center gap-1.5 py-0.5 pl-9 pr-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    >
                      <button
                        onClick={() => onOpen(row)}
                        title={t("bookmarks.goTo")}
                        className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                      >
                        <span className="shrink-0 font-mono text-[11px] text-[var(--cf-accent)]">
                          {row.line}
                        </span>
                        <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                          {row.label}
                        </span>
                      </button>
                      <button
                        onClick={() => onRemove(row)}
                        title={t("bookmarks.remove")}
                        aria-label={t("bookmarks.remove")}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-danger)] group-hover:opacity-100"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
              </div>
            );
          })
        ))}
    </div>
  );
}

export function BookmarksPanel({
  repoPath,
  onOpen,
}: {
  /** Absolute path of the open project — breakpoints are stored absolute and shown relative. */
  repoPath: string;
  onOpen: (path: string, line: number) => void;
}) {
  const t = useT();
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const removeBookmark = useBookmarkStore((s) => s.remove);
  const clearBookmarks = useBookmarkStore((s) => s.clear);
  const breakpoints = useDebugStore((s) => s.breakpoints);
  const toggleBreakpoint = useDebugStore((s) => s.toggleBreakpoint);

  const bookmarkRows = useMemo<Row[]>(
    () => bookmarks.map((mark) => ({ ...mark, key: mark.id })),
    [bookmarks],
  );

  /**
   * Breakpoints live under absolute paths, because that is what a debug adapter speaks. Only the
   * ones inside the open project can be shown: a row the editor cannot open is a dead end, and the
   * panel has no business listing files from a repo that isn't on screen.
   */
  const breakpointPlaces = useMemo(() => {
    const root = normalizePath(`${repoPath}/`);
    const places: { path: string; line: number; key: string }[] = [];
    for (const [absolute, lines] of Object.entries(breakpoints)) {
      if (!absolute.startsWith(root)) continue;
      const relative = absolute.slice(root.length);
      for (const line of lines) {
        places.push({ path: relative, line, key: `${absolute}:${line}` });
      }
    }
    return places.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }, [breakpoints, repoPath]);

  /**
   * The text of every breakpointed line, so those rows read like the bookmarks above them rather
   * than as a bare number.
   *
   * A bookmark carries its own label — it was captured from the buffer at the moment it was set —
   * but a breakpoint is just a line number in the debug store, so the text has to be fetched. From
   * disk, and only for the handful of files that actually hold one: the alternative is keeping every
   * breakpointed file open in memory to label a list. Unsaved edits therefore show the saved text,
   * which is the right trade for a label nobody edits from here.
   */
  const [lineText, setLineText] = useState<Record<string, string[]>>({});
  const filesWithBreakpoints = useMemo(
    () => [...new Set(breakpointPlaces.map((place) => place.path))].sort().join("\n"),
    [breakpointPlaces],
  );

  useEffect(() => {
    if (filesWithBreakpoints === "") {
      setLineText({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      filesWithBreakpoints.split("\n").map(async (path) => {
        const text = await readFileText(repoPath, path).catch(() => null);
        return [path, text === null ? [] : text.split("\n")] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setLineText(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [filesWithBreakpoints, repoPath]);

  const breakpointRows = useMemo<Row[]>(
    () =>
      breakpointPlaces.map((place) => ({
        ...place,
        label: lineText[place.path]?.[place.line - 1]?.trim() ?? "",
      })),
    [breakpointPlaces, lineText],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[var(--cf-border)] px-2 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("bookmarks.title")}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        <Section
          title={t("bookmarks.section")}
          icon={<Bookmark size={11} className="shrink-0 text-[var(--cf-warning)]" />}
          rows={bookmarkRows}
          emptyLabel={t("bookmarks.empty")}
          onOpen={(row) => onOpen(row.path, row.line)}
          onRemove={(row) => removeBookmark(row.key)}
          onClear={clearBookmarks}
          clearLabel={t("bookmarks.clear")}
        />
        <Section
          title={t("bookmarks.breakpoints")}
          icon={<Circle size={9} className="shrink-0 fill-[var(--cf-danger)] text-[var(--cf-danger)]" />}
          rows={breakpointRows}
          emptyLabel={t("bookmarks.noBreakpoints")}
          onOpen={(row) => onOpen(row.path, row.line)}
          // Back through the same toggle the gutter uses, so the two never disagree about what is set.
          onRemove={(row) => toggleBreakpoint(`${repoPath}/${row.path}`, row.line)}
        />
      </div>
    </div>
  );
}
