import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, FolderTree, Loader2, RefreshCw, Tag } from "lucide-react";
import {
  ANCHOR_TAGS,
  anchorColor,
  anchorPatternSource,
  parseAnchorLine,
  parseAnchors,
  type Anchor,
} from "../../lib/anchors";
import { searchRepo } from "../../lib/tauri/commands";
import { fileIconFor } from "../../lib/fileIcon";
import { useT } from "../../state/languageStore";

type Scope = "file" | "project";

/** Cap on a project-wide scan. Anchors are a to-do list, so the useful default is "all of them";
 * this is the runaway guard, not a page size. */
const PROJECT_SCAN_LIMIT = 2000;

interface Located extends Anchor {
  /** Repo-relative path. For the current-file scope this is the open tab's path. */
  path: string;
}

/**
 * Tagged comments turned into a navigable index — the Comment Anchors panel.
 *
 * Two scopes with deliberately different mechanics. The current file is parsed here, in memory,
 * from the buffer the editor is holding: it updates as you type, including on unsaved edits, at
 * a cost of one regex pass over a file that's already in RAM. The project scope goes through the
 * repo-search backend instead — walking and reading the whole tree in the UI thread is exactly
 * what that command exists to avoid — and re-parses each returned line so both scopes produce
 * the same shape.
 */
export function AnchorsPanel({
  repoPath,
  activePath,
  activeContent,
  onOpenAnchor,
}: {
  repoPath: string;
  /** Repo-relative path of the open file, or `null` when no tab is open. */
  activePath: string | null;
  /** The open file's current buffer — unsaved edits included. */
  activeContent: string;
  onOpenAnchor: (path: string, line: number, column: number) => void;
}) {
  const t = useT();
  const [scope, setScope] = useState<Scope>("file");
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [projectAnchors, setProjectAnchors] = useState<Located[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  /** Only the newest scan may write results — switching scope twice quickly would otherwise let
   * the first, slower walk land on top of the second. */
  const runRef = useRef(0);

  const fileAnchors = useMemo<Located[]>(() => {
    if (!activePath) return [];
    return parseAnchors(activeContent, enabled).map((a) => ({ ...a, path: activePath }));
  }, [activePath, activeContent, enabled]);

  const scanProject = useCallback(async () => {
    const token = ++runRef.current;
    setScanning(true);
    setError(null);
    try {
      const tagIds = ANCHOR_TAGS.map((tag) => tag.id).filter((id) => enabled.size === 0 || enabled.has(id));
      const outcome = await searchRepo(
        repoPath,
        anchorPatternSource(tagIds),
        {
          // The pattern is a regex by construction, and it's case-sensitive on purpose: `todo` in
          // prose is not an anchor, which is the convention the tags themselves rely on.
          caseSensitive: true,
          wholeWord: false,
          regex: true,
          include: "",
          exclude: "",
        },
        // Well above the search box's own default: a repo's anchors are a working list you expect
        // to be complete, not a set of results you page through. The backend's per-file cap still
        // applies — a file with more than 20 anchors shows its first 20 here, and all of them in
        // the current-file scope, which has no cap at all.
        PROJECT_SCAN_LIMIT,
      );
      if (token !== runRef.current) return;
      const located: Located[] = [];
      for (const hit of outcome.hits) {
        const anchor = parseAnchorLine(hit.line, hit.line_no, enabled);
        if (anchor) located.push({ ...anchor, path: hit.path });
      }
      setProjectAnchors(located);
      setTruncated(outcome.truncated);
    } catch (e) {
      if (token !== runRef.current) return;
      setProjectAnchors([]);
      setError(String(e));
    } finally {
      if (token === runRef.current) setScanning(false);
    }
  }, [repoPath, enabled]);

  // Scanning the tree is expensive enough that it's kept to an explicit act: entering the scope,
  // changing what's being looked for, or the refresh button. It deliberately does not follow
  // every keystroke the way the current-file scope does.
  useEffect(() => {
    if (scope !== "project") return;
    void scanProject();
  }, [scope, scanProject]);

  const anchors = scope === "file" ? fileAnchors : projectAnchors;

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return anchors;
    return anchors.filter(
      (a) => a.text.toLowerCase().includes(needle) || a.tag.toLowerCase().includes(needle) || a.path.toLowerCase().includes(needle),
    );
  }, [anchors, filter]);

  /** Counts come from the unfiltered set: a legend that renumbered itself as you typed in the
   * filter box would be reporting on the filter, not on the code. */
  const countsByTag = useMemo(() => {
    const counts = new Map<string, number>();
    for (const anchor of anchors) counts.set(anchor.tag, (counts.get(anchor.tag) ?? 0) + 1);
    return counts;
  }, [anchors]);

  const grouped = useMemo(() => {
    const byFile = new Map<string, Located[]>();
    for (const anchor of visible) {
      const existing = byFile.get(anchor.path);
      if (existing) existing.push(anchor);
      else byFile.set(anchor.path, [anchor]);
    }
    return [...byFile.entries()];
  }, [visible]);

  const toggleTag = (id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      // An empty set means "everything", so the first click has to start from the full list —
      // otherwise clicking one tag off would read as turning that one tag *on*.
      if (next.size === 0) for (const tag of ANCHOR_TAGS) next.add(tag.id);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Back to every tag selected is the same thing as no filter at all; collapsing it keeps
      // the project scan's pattern short.
      return next.size === ANCHOR_TAGS.length ? new Set() : next;
    });
  };

  const isTagOn = (id: string) => enabled.size === 0 || enabled.has(id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-[var(--cf-border)] p-1.5">
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] p-0.5">
            {(
              [
                { id: "file", icon: FileText, label: t("anchors.scopeFile") },
                { id: "project", icon: FolderTree, label: t("anchors.scopeProject") },
              ] as const
            ).map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setScope(id)}
                title={label}
                aria-label={label}
                aria-pressed={scope === id}
                className={`flex h-5 w-5 items-center justify-center rounded ${
                  scope === id ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
                }`}
              >
                <Icon size={12} />
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5">
            <Tag size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("anchors.filterPlaceholder")}
              className="min-w-0 flex-1 bg-transparent py-1 text-[12px] outline-none"
            />
          </div>
          {scope === "project" && (
            <button
              onClick={() => void scanProject()}
              disabled={scanning}
              title={t("anchors.rescan")}
              aria-label={t("anchors.rescan")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
            >
              {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </button>
          )}
        </div>

        {/* Legend and filter in one control: each chip says how many of that tag are in scope and
            toggles it out of the list. */}
        <div className="flex flex-wrap gap-1">
          {ANCHOR_TAGS.map((tag) => {
            const count = countsByTag.get(tag.id) ?? 0;
            const on = isTagOn(tag.id);
            return (
              <button
                key={tag.id}
                onClick={() => toggleTag(tag.id)}
                title={t("anchors.toggleTag", { tag: tag.id })}
                aria-pressed={on}
                className={`flex items-center gap-1 rounded px-1 py-0.5 text-[9px] font-medium tracking-wide ${
                  on ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] opacity-40"
                } hover:bg-black/[0.05] dark:hover:bg-white/[0.08]`}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tag.color }} />
                {tag.id}
                {count > 0 && <span className="text-[var(--cf-text-muted)]">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && <p className="px-3 py-2 text-[11px] text-[var(--cf-danger)]">{error}</p>}
        {scanning && (
          <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-[var(--cf-text-muted)]">
            <Loader2 size={11} className="animate-spin" />
            {t("anchors.scanning")}
          </div>
        )}
        {!scanning && !error && visible.length === 0 && (
          <p className="px-3 py-2 text-[11px] text-[var(--cf-text-muted)]">
            {scope === "file" && !activePath ? t("anchors.noFile") : t("anchors.none")}
          </p>
        )}
        {!scanning && visible.length > 0 && (
          <p className="px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
            {t("anchors.count", { n: visible.length, files: grouped.length })}
            {truncated && scope === "project" ? ` · ${t("editor.searchTruncated")}` : ""}
          </p>
        )}

        {grouped.map(([path, items]) => {
          const { Icon, color } = fileIconFor(path);
          return (
            <div key={path} className="pb-1">
              {/* The current-file scope has exactly one group, and repeating the name of the file
                  already named in the breadcrumb above would be noise. */}
              {scope === "project" && (
                <div className="flex items-center gap-1.5 px-2 py-0.5">
                  <Icon size={12} className="shrink-0" style={{ color }} />
                  <span className="truncate text-[11px] text-[var(--cf-text)]">{path}</span>
                  <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">{items.length}</span>
                </div>
              )}
              {items.map((anchor) => (
                <button
                  key={`${anchor.path}:${anchor.line}:${anchor.column}`}
                  onClick={() => onOpenAnchor(anchor.path, anchor.line, anchor.column)}
                  className={`flex w-full items-baseline gap-1.5 rounded px-2 py-0.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04] ${
                    scope === "project" ? "pl-6" : ""
                  }`}
                >
                  <span
                    className="shrink-0 text-[9px] font-semibold tracking-wide"
                    style={{ color: anchorColor(anchor.tag) }}
                  >
                    {anchor.tag}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]">
                    {anchor.text || <span className="italic opacity-60">{t("anchors.bare")}</span>}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">{anchor.line}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
