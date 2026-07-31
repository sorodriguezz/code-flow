import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listRepoFiles } from "../../lib/tauri/commands";
import { fileIconFor } from "../../lib/fileIcon";
import { useT } from "../../state/languageStore";

/** How many rows the list renders. Filtering happens over the whole repo; only the top slice is
 * drawn, because nobody scrolls a thousand results — they type two more letters. */
const MAX_ROWS = 40;

/** Subsequence match, the way editors' quick-open works: "edvw" finds `EditorView.tsx`. Returns
 * a score (lower is better) or `null` when the query doesn't fit at all. */
function fuzzyScore(path: string, query: string): number | null {
  if (!query) return 0;
  const haystack = path.toLowerCase();
  const name = haystack.slice(haystack.lastIndexOf("/") + 1);

  // A plain substring of the *filename* is what the user almost always means, so it outranks any
  // subsequence spread across the directories.
  const inName = name.indexOf(query);
  if (inName >= 0) return inName;
  const inPath = haystack.indexOf(query);
  if (inPath >= 0) return 100 + inPath;

  let cursor = 0;
  let gaps = 0;
  for (const char of query) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return null;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 1000 + gaps;
}

/** Quick-open: type part of a path, hit Enter, the file opens in a pinned tab. */
export function FilePalette({
  repoPath,
  onPick,
  onClose,
}: {
  repoPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [files, setFiles] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Re-read on every open rather than caching: files appear and vanish between opens, and one
  // walk of a repo is fast enough that a stale list is the worse trade.
  useEffect(() => {
    let cancelled = false;
    void listRepoFiles(repoPath)
      .then((result) => {
        if (!cancelled) setFiles(result);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const matches = useMemo(() => {
    if (!files) return [];
    const needle = query.trim().toLowerCase();
    const scored: { path: string; score: number }[] = [];
    for (const path of files) {
      const score = fuzzyScore(path, needle);
      if (score !== null) scored.push({ path, score });
    }
    scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
    return scored.slice(0, MAX_ROWS).map((s) => s.path);
  }, [files, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = matches[active];
      if (picked) {
        onPick(picked);
        onClose();
      }
    }
  };

  // Portalled to `document.body`, for the reason spelled out at length on `ApiModal`: it opens from
  // inside the editor, the editor lives in `.cf-ambient-bg`, and that element is `isolation:
  // isolate`. The isolation is a stacking context, so no `z-index` here can lift the backdrop over
  // the terminal dock, the AI panel or the status bar — they are later siblings of the isolated
  // element, not descendants of it. Left in place the veil covered the viewport but painted *under*
  // the app chrome, which is why the bars around the palette never dimmed and stayed clickable
  // straight through it. Out here `z-50` puts it with the app's other root overlays: the command
  // palette, Settings, the shortcuts sheet.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("editor.goToFilePlaceholder")}
          className="w-full border-b border-[var(--cf-border)] bg-transparent px-3 py-2.5 text-[13px] outline-none"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-auto py-1">
          {files === null ? (
            <p className="px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("editor.loading")}</p>
          ) : matches.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("titlebar.noResults")}</p>
          ) : (
            matches.map((path, index) => {
              const { Icon, color } = fileIconFor(path);
              const name = path.slice(path.lastIndexOf("/") + 1);
              const dir = path.slice(0, path.length - name.length - 1);
              return (
                <button
                  key={path}
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    onPick(path);
                    onClose();
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left ${
                    index === active ? "bg-[var(--cf-accent-soft)]" : ""
                  }`}
                >
                  <Icon size={13} className="shrink-0" style={{ color }} />
                  <span className="shrink-0 text-[13px] text-[var(--cf-text)]">{name}</span>
                  <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{dir}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
