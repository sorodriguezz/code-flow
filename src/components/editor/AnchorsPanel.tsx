import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, FolderTree, Loader2, RefreshCw, Search, Tag, Tags } from "lucide-react";
import { ANCHOR_TAGS, anchorColor, anchorPatternSource, parseAnchorLine, parseAnchors, type Anchor } from "../../lib/anchors";
import { searchRepo } from "../../lib/tauri/commands";
import { FileGlyph } from "../common/FileGlyph";
import { Tooltip } from "../common/Tooltip";
import { Segmented } from "../common/Segmented";
import { iconButtonClass } from "../common/Button";
import { explorerHeadClass, explorerTitleClass, fieldClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";

type Scope = "file" | "project";
/** How the project's anchors are listed: under their file, or under their tag — every TODO together. */
type GroupBy = "file" | "tag";

/** Cap on a project-wide scan. Anchors are a to-do list, so the useful default is "all of them";
 * this is the runaway guard, not a page size. */
const PROJECT_SCAN_LIMIT = 2000;

/** The tag badge's width: every row's text starts at the same column, whichever tag it carries. */
const BADGE_WIDTH = 68;

interface Located extends Anchor {
  /** Repo-relative path. For the current-file scope this is the open tab's path. */
  path: string;
}

interface Group {
  key: string;
  items: Located[];
}

/** `a/b/c.ts` → `{ name: "c.ts", dir: "a/b" }`. */
function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/** A tag's colour, as the tint behind its badge and chip. */
function tint(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
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
 *
 * Both always find **every** tag, and the tag chips filter what is listed in memory. They used to
 * narrow the scan itself, which made a chip switched off lose its count (the scan no longer found
 * its anchors) and cost a whole project walk per click.
 *
 * The project list reads the way a file list should: the file's **name** first, its folder after it
 * and dimmer — a long path cut at the end used to cut exactly the name off. Each group folds.
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
  const [groupBy, setGroupBy] = useState<GroupBy>("file");
  /** The tags shown — empty for all of them. A chip adds its tag, so the first click reads as
   *  "only these", the way a filter chip does. */
  const [only, setOnly] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  /** Folded groups, by their key (a path or a tag). */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [projectAnchors, setProjectAnchors] = useState<Located[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  /** Only the newest scan may write results — switching scope twice quickly would otherwise let
   * the first, slower walk land on top of the second. */
  const runRef = useRef(0);

  const fileAnchors = useMemo<Located[]>(() => {
    if (!activePath) return [];
    return parseAnchors(activeContent).map((a) => ({ ...a, path: activePath }));
  }, [activePath, activeContent]);

  const scanProject = useCallback(async () => {
    const token = ++runRef.current;
    setScanning(true);
    setError(null);
    try {
      const outcome = await searchRepo(
        repoPath,
        anchorPatternSource(),
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
        const anchor = parseAnchorLine(hit.line, hit.line_no);
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
  }, [repoPath]);

  // Scanning the tree is expensive enough that it's kept to an explicit act: entering the scope or
  // the refresh button. It deliberately does not follow every keystroke the way the current-file
  // scope does.
  useEffect(() => {
    if (scope !== "project") return;
    void scanProject();
  }, [scope, scanProject]);

  const anchors = scope === "file" ? fileAnchors : projectAnchors;

  /** Counts come from the unfiltered set: a legend that renumbered itself as you typed in the
   * filter box would be reporting on the filter, not on the code. */
  const countsByTag = useMemo(() => {
    const counts = new Map<string, number>();
    for (const anchor of anchors) counts.set(anchor.tag, (counts.get(anchor.tag) ?? 0) + 1);
    return counts;
  }, [anchors]);

  /** The chips: the tags this scope has, in the legend's order — plus any chosen that has none now,
   *  so a choice never goes invisible while it still filters. */
  const presentTags = useMemo(
    () => ANCHOR_TAGS.filter((tag) => (countsByTag.get(tag.id) ?? 0) > 0 || only.has(tag.id)),
    [countsByTag, only],
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return anchors.filter(
      (a) =>
        (only.size === 0 || only.has(a.tag)) &&
        (!needle || a.text.toLowerCase().includes(needle) || a.tag.toLowerCase().includes(needle) || a.path.toLowerCase().includes(needle)),
    );
  }, [anchors, filter, only]);

  const fileCount = useMemo(() => new Set(visible.map((a) => a.path)).size, [visible]);

  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Located[]>();
    for (const anchor of visible) {
      const key = groupBy === "tag" ? anchor.tag : anchor.path;
      const existing = byKey.get(key);
      if (existing) existing.push(anchor);
      else byKey.set(key, [anchor]);
    }
    const list = [...byKey.entries()].map(([key, items]) => ({ key, items }));
    // By tag, in the legend's order — the order the tags are introduced in.
    if (groupBy === "tag") {
      const rank = new Map(ANCHOR_TAGS.map((tag, index) => [tag.id, index]));
      list.sort((a, b) => (rank.get(a.key) ?? 99) - (rank.get(b.key) ?? 99));
    }
    return list;
  }, [visible, groupBy]);

  const toggleTag = (id: string) =>
    setOnly((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleFold = (key: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** The current file is one group with no header; grouping by tag gives it headers again. */
  const withHeaders = scope === "project" || groupBy === "tag";
  const allFolded = groups.length > 0 && groups.every((group) => folded.has(group.key));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The head every panel of the activity rail wears: its name, and its panel-wide actions. */}
      <div className={explorerHeadClass}>
        <span className={`${explorerTitleClass} mr-auto`}>
          <span className="truncate">{t("anchors.title")}</span>
        </span>
        {withHeaders && groups.length > 1 && (
          <Tooltip side="bottom" label={allFolded ? t("anchors.expandAll") : t("anchors.collapseAll")}>
            <button
              onClick={() => setFolded(allFolded ? new Set() : new Set(groups.map((group) => group.key)))}
              aria-label={allFolded ? t("anchors.expandAll") : t("anchors.collapseAll")}
              className={iconButtonClass({ size: "sm" })}
            >
              {allFolded ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
            </button>
          </Tooltip>
        )}
        {scope === "project" && (
          <Tooltip side="bottom" label={t("anchors.rescan")}>
            <button onClick={() => void scanProject()} disabled={scanning} aria-label={t("anchors.rescan")} className={iconButtonClass({ size: "sm" })}>
              {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          </Tooltip>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-b border-[var(--cf-border)] px-3 pb-2.5">
        <div className="flex items-center gap-1.5">
          {/* Two peer ways of reading the same list — the segmented control. */}
          <Segmented<Scope>
            size="sm"
            layoutId="cf-anchors-scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: "file", icon: FileText, title: t("anchors.scopeFile") },
              { value: "project", icon: FolderTree, title: t("anchors.scopeProject") },
            ]}
          />
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("anchors.filterPlaceholder")}
              className={fieldClass({ size: "sm", className: "w-full pl-7" })}
            />
          </div>
        </div>

        {/* The tags this scope has, as filter chips: each in its own colour, with its count. None
            chosen is all of them; a chip chosen shows only its tag (and the others chosen). */}
        {presentTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {only.size > 0 && (
              <button
                onClick={() => setOnly(new Set())}
                className="flex h-[22px] items-center rounded-full px-2 text-[11px] font-medium text-[var(--cf-accent)] hover:bg-[var(--cf-hover)]"
              >
                {t("anchors.allTags")}
              </button>
            )}
            {presentTags.map((tag) => {
              const count = countsByTag.get(tag.id) ?? 0;
              const chosen = only.has(tag.id);
              const dimmed = only.size > 0 && !chosen;
              return (
                <Tooltip key={tag.id} side="bottom" label={t(chosen ? "anchors.tagChosen" : "anchors.tagOnly", { tag: tag.id })}>
                  <button
                    onClick={() => toggleTag(tag.id)}
                    aria-pressed={chosen}
                    className={`flex h-[22px] items-center gap-1.5 rounded-full pl-2 pr-2 text-[11px] font-medium tracking-[0.02em] transition-[background-color,opacity,box-shadow] duration-100 ${
                      dimmed ? "opacity-45 hover:opacity-80" : ""
                    }`}
                    style={{
                      color: dimmed ? "var(--cf-text-muted)" : "var(--cf-text)",
                      background: chosen ? tint(tag.color, 22) : tint(tag.color, 10),
                      boxShadow: chosen ? `inset 0 0 0 1px ${tint(tag.color, 70)}` : undefined,
                    }}
                  >
                    <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: tag.color }} />
                    {tag.id}
                    <span className="tabular-nums text-[var(--cf-text-muted)]">{count}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2.5 pt-1">
        {error && <p className="px-2 py-2 text-[12px] text-[var(--cf-danger)]">{error}</p>}
        {scanning && (
          <div className="flex items-center gap-1.5 px-2 py-2 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("anchors.scanning")}
          </div>
        )}
        {!scanning && !error && visible.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Tags size={22} className="text-[var(--cf-text-faint)]" />
            <p className="text-[12px] text-[var(--cf-text-muted)]">
              {scope === "file" && !activePath ? t("anchors.noFile") : anchors.length > 0 ? t("anchors.noneMatch") : t("anchors.none")}
            </p>
          </div>
        )}
        {!scanning && visible.length > 0 && (
          <div className="flex items-center gap-2 px-2 pb-1 pt-1.5">
            <p className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-[var(--cf-text-faint)]">
              {scope === "project" ? t("anchors.count", { n: visible.length, files: fileCount }) : t("anchors.countFile", { n: visible.length })}
              {truncated && scope === "project" ? ` · ${t("editor.searchTruncated")}` : ""}
            </p>
            <Segmented<GroupBy>
              size="sm"
              layoutId="cf-anchors-group"
              value={groupBy}
              onChange={setGroupBy}
              ariaLabel={t("anchors.groupBy")}
              options={[
                { value: "file", icon: FileText, title: t("anchors.groupByFile") },
                { value: "tag", icon: Tag, title: t("anchors.groupByTag") },
              ]}
            />
          </div>
        )}

        {!scanning &&
          groups.map((group) => {
            const open = !folded.has(group.key);
            return (
              <div key={group.key} className="pb-0.5">
                {withHeaders && (
                  <GroupHeader
                    group={group}
                    by={groupBy}
                    open={open}
                    onToggle={() => toggleFold(group.key)}
                  />
                )}
                {open &&
                  group.items.map((anchor, at) => (
                    <AnchorRow
                      key={`${anchor.path}:${anchor.line}:${anchor.column}`}
                      anchor={anchor}
                      // Grouped by tag, the tag is the header's and the file is the row's.
                      showTag={groupBy === "file"}
                      showFile={groupBy === "tag" && scope === "project"}
                      indented={withHeaders}
                      style={riseDelay(at)}
                      bareLabel={t("anchors.bare")}
                      onOpen={() => onOpenAnchor(anchor.path, anchor.line, anchor.column)}
                    />
                  ))}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/** A group's head: the file (name, then its folder) or the tag, its count, and the fold. */
function GroupHeader({ group, by, open, onToggle }: { group: Group; by: GroupBy; open: boolean; onToggle: () => void }) {
  const { name, dir } = splitPath(group.key);
  return (
    // Sticky on the panel's own surface, so a long group keeps saying whose anchors these are while
    // it scrolls — the hover tint is the button's, over that opaque ground.
    <div className="sticky top-0 z-[1] bg-[var(--cf-surface)]">
      <button
        onClick={onToggle}
        aria-expanded={open}
        title={by === "file" ? group.key : undefined}
        className="flex h-[26px] w-full items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-[var(--cf-hover)]"
      >
        <ChevronRight size={12} className={`shrink-0 text-[var(--cf-text-faint)] transition-transform duration-100 ${open ? "rotate-90" : ""}`} />
        {by === "file" ? (
          <>
            <FileGlyph path={group.key} size={13} />
            <span className="shrink-0 truncate text-[12px] font-medium text-[var(--cf-text)]" style={{ maxWidth: "65%" }}>
              {name}
            </span>
            {/* The folder, cut from its *start*: its last folders are the ones that say where it is. */}
            {dir && (
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-faint)]" style={{ direction: "rtl", textAlign: "left" }}>
                <bdi>{dir}</bdi>
              </span>
            )}
          </>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: anchorColor(group.key) }} />
            <span className="text-[11.5px] font-semibold tracking-[0.02em] text-[var(--cf-text)]">{group.key}</span>
          </span>
        )}
        <span
          className={`${by === "file" && dir ? "" : "ml-auto"} shrink-0 rounded-full bg-[var(--cf-hover)] px-1.5 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]`}
        >
          {group.items.length}
        </span>
      </button>
    </div>
  );
}

/** One anchor: its tag as a badge of fixed width (so every text starts in one column), its text,
 *  and where it is — the line, or `file:line` when grouped by tag. */
function AnchorRow({
  anchor,
  showTag,
  showFile,
  indented,
  style,
  bareLabel,
  onOpen,
}: {
  anchor: Located;
  showTag: boolean;
  showFile: boolean;
  indented: boolean;
  style: CSSProperties;
  bareLabel: string;
  onOpen: () => void;
}) {
  const color = anchorColor(anchor.tag);
  const where = showFile ? `${splitPath(anchor.path).name}:${anchor.line}` : String(anchor.line);
  return (
    <button
      onClick={onOpen}
      style={style}
      title={`${anchor.tag}${anchor.text ? `: ${anchor.text}` : ""}\n${anchor.path}:${anchor.line}`}
      className={`cf-rise group/anchor flex h-[26px] w-full items-center gap-2 rounded-md pr-2 text-left hover:bg-[var(--cf-hover)] ${indented ? "pl-[22px]" : "pl-2"}`}
    >
      {showTag ? (
        <span
          className="flex h-[18px] shrink-0 items-center justify-center rounded px-1 text-[10px] font-semibold tracking-[0.03em]"
          style={{ width: BADGE_WIDTH, color, background: tint(color, 14) }}
        >
          {anchor.tag}
        </span>
      ) : (
        <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: color }} />
      )}
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)] opacity-85 group-hover/anchor:opacity-100">
        {anchor.text || <span className="italic text-[var(--cf-text-faint)]">{bareLabel}</span>}
      </span>
      <span className="max-w-[45%] shrink-0 truncate font-mono text-[10.5px] tabular-nums text-[var(--cf-text-faint)]">{where}</span>
    </button>
  );
}
