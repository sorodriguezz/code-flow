import { useMemo, useState, type ReactNode } from "react";
import { Bookmark, ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import { useBookmarkStore } from "../../state/bookmarkStore";
import { FileGlyph } from "../common/FileGlyph";
import { Tooltip } from "../common/Tooltip";
import { Kbd } from "../common/Button";
import { explorerHeadClass, explorerTitleClass } from "../common/recipes";
import { useShortcutChord } from "../../lib/useShortcutHint";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";

/**
 * The shared 22px icon button, for the two actions here that take something away. Its own string
 * rather than `iconButtonClass` because the difference is the hover — the danger tint, so the press
 * says what it does before it happens — and a second hover colour on that recipe would be a tie for
 * the stylesheet to break rather than an override.
 */
const REMOVE_BUTTON =
  "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)]";

/**
 * The lines the user marked, and nothing else.
 *
 * Breakpoints were listed here too, under their own heading, as a second «come back to this line».
 * They already have their list in «Ejecutar y depurar», with the controls that go with them, so
 * here they were the same rows twice (user ask, 2026-11-23).
 *
 * Grouped by file for the same reason a file tree is: a flat list of line numbers from four files
 * is a list you have to read, not one you can scan.
 */

interface Row {
  /** Repo-relative — what the editor opens and what the panel groups by. */
  path: string;
  line: number;
  label: string;
  /** Identifies the row for removal: the bookmark's id. */
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
  emptyKey,
  onOpen,
  onRemove,
  onClear,
  clearLabel,
}: {
  title: string;
  icon: ReactNode;
  rows: Row[];
  emptyLabel: string;
  /** The chord that adds one, drawn as a key cap after the sentence — from the binding registry,
   *  which is why it is not written into `emptyLabel` any more. */
  emptyKey?: string | null;
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
      <div className="flex items-center gap-1 pr-0.5">
        <button
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[var(--cf-text-faint)] hover:text-[var(--cf-text)]"
        >
          {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          {icon}
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.06em]">{title}</span>
          <span className="shrink-0 text-[11px] font-medium tabular-nums">{rows.length}</span>
        </button>
        {onClear && rows.length > 0 && (
          <Tooltip side="bottom" label={clearLabel}>
            <button onClick={onClear} aria-label={clearLabel} className={REMOVE_BUTTON}>
              <Trash2 size={13} />
            </button>
          </Tooltip>
        )}
      </div>

      {open &&
        (rows.length === 0 ? (
          <p className="px-2 pb-2 pl-7 text-[12px] leading-snug text-[var(--cf-text-faint)]">
            {emptyLabel}
            {emptyKey && (
              <>
                {" "}
                <Kbd>{emptyKey}</Kbd>
              </>
            )}
          </p>
        ) : (
          groups.map(([path, fileRows]) => {
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
                  className="flex h-[26px] w-full items-center gap-1.5 rounded-md pl-3 pr-2 text-left hover:bg-[var(--cf-hover)]"
                >
                  {shut ? (
                    <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
                  ) : (
                    <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
                  )}
                  <FileGlyph path={path} size={13} />
                  <span className="shrink-0 text-[12px] text-[var(--cf-text)]">{fileName(path)}</span>
                  <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-faint)]">
                    {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}
                  </span>
                  {/* Only while shut: with the lines showing, the count is the lines themselves. */}
                  {shut && (
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)]">
                      {fileRows.length}
                    </span>
                  )}
                </button>
                {!shut &&
                  fileRows.map((row, at) => (
                    <div
                      key={row.key}
                      style={riseDelay(at)}
                      className="cf-rise group flex h-[26px] items-center gap-1.5 rounded-md pl-9 pr-0.5 hover:bg-[var(--cf-hover)]"
                    >
                      <button
                        onClick={() => onOpen(row)}
                        title={t("bookmarks.goTo")}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-accent)]">
                          {row.line}
                        </span>
                        <span className="truncate font-mono text-[12px] text-[var(--cf-text-muted)]">
                          {row.label}
                        </span>
                      </button>
                      <Tooltip side="right" label={t("bookmarks.remove")}>
                        <button
                          onClick={() => onRemove(row)}
                          aria-label={t("bookmarks.remove")}
                          className={`${REMOVE_BUTTON} opacity-0 focus-visible:opacity-100 group-hover:opacity-100`}
                        >
                          <X size={13} />
                        </button>
                      </Tooltip>
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
  onOpen,
}: {
  onOpen: (path: string, line: number) => void;
}) {
  const t = useT();
  /** The key that bookmarks the caret's line, for the empty section's hint. */
  const toggleChord = useShortcutChord()("editor.bookmarkToggle");
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const removeBookmark = useBookmarkStore((s) => s.remove);
  const clearBookmarks = useBookmarkStore((s) => s.clear);
  const bookmarkRows = useMemo<Row[]>(
    () => bookmarks.map((mark) => ({ ...mark, key: mark.id })),
    [bookmarks],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The head every panel of the activity rail wears. */}
      <div className={explorerHeadClass}>
        <span className={explorerTitleClass}>
          <span className="truncate">{t("bookmarks.title")}</span>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2.5">
        <Section
          title={t("bookmarks.section")}
          icon={<Bookmark size={13} className="shrink-0 text-[var(--cf-warning)]" />}
          rows={bookmarkRows}
          emptyLabel={t("bookmarks.empty")}
          emptyKey={toggleChord}
          onOpen={(row) => onOpen(row.path, row.line)}
          onRemove={(row) => removeBookmark(row.key)}
          onClear={clearBookmarks}
          clearLabel={t("bookmarks.clear")}
        />
      </div>
    </div>
  );
}
