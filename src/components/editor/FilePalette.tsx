import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileSearch, Loader2 } from "lucide-react";
import { listRepoFiles } from "../../lib/tauri/commands";
import { FileGlyph } from "../common/FileGlyph";
import { Kbd } from "../common/Button";
import { useShortcutChord } from "../../lib/useShortcutHint";
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
  const openChord = useShortcutChord()("editor.goToFile");
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
  // The command palette's shell, row for row — the two are the same gesture (type, arrow, Enter)
  // and a second look for the same thing would be a second thing to learn.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="cf-fade-in flex max-h-[64vh] w-[600px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-4">
          <FileSearch size={17} className="shrink-0 text-[var(--cf-text-faint)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("editor.goToFilePlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--cf-text-faint)]"
          />
          {/* The key that brings this back, from the binding registry — where the placeholder
              used to spell it out, Ctrl on a Mac included. */}
          {openChord && <Kbd>{openChord}</Kbd>}
        </div>
        <div ref={listRef} className="flex-1 overflow-auto p-1.5">
          {files === null ? (
            <p className="flex items-center justify-center gap-2 px-2 py-6 text-[13px] text-[var(--cf-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              {t("editor.loading")}
            </p>
          ) : matches.length === 0 ? (
            <p className="px-2 py-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("titlebar.noResults")}</p>
          ) : (
            matches.map((path, index) => {
              const name = path.slice(path.lastIndexOf("/") + 1);
              const dir = path.slice(0, path.length - name.length - 1);
              return (
                <button
                  key={path}
                  data-active={index === active}
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    onPick(path);
                    onClose();
                  }}
                  className={`flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left ${
                    index === active ? "bg-[var(--cf-accent-soft)]" : ""
                  }`}
                >
                  <FileGlyph path={path} />
                  <span className="shrink-0 text-[13px] text-[var(--cf-text)]">{name}</span>
                  <span className="truncate font-mono text-[11px] text-[var(--cf-text-faint)]">{dir}</span>
                </button>
              );
            })
          )}
        </div>
        {/* The keys, always in view: this is a keyboard surface, and the keys are its controls. */}
        <div className="flex shrink-0 items-center gap-4 border-t border-[var(--cf-border)] px-3.5 py-2 text-[12px] text-[var(--cf-text-faint)]">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
