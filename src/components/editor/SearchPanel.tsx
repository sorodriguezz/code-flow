import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Regex,
  Replace,
  ReplaceAll,
  Search,
  WholeWord,
} from "lucide-react";
import { replaceInRepo, searchRepo, type SearchHit, type SearchOptions } from "../../lib/tauri/commands";
import { FileGlyph } from "../common/FileGlyph";
import { useRepoStore } from "../../state/repoStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";

/** Long enough that typing a word doesn't fire a walk of the repo per keystroke, short enough
 * that the results feel like they're keeping up. */
const DEBOUNCE_MS = 250;

/**
 * How long the panel waits after the watcher fires before re-greping.
 *
 * Deliberately more than double the explorer's 250ms coalesce: that one re-lists the expanded
 * directories, this one walks and reads every text file in the repo. A checkout, a `git pull` or an
 * agent writing a dozen files is one burst of events and should cost one walk. The first event of a
 * burst starts the clock and the rest fall inside it, so this is a ceiling on latency rather than
 * something a steady stream of events can keep pushing back.
 */
const FS_COALESCE_MS = 600;

/**
 * How long after a replace the watcher's echo is absorbed rather than acted on.
 *
 * `replace` writes to disk and then rebuilds the list itself, so the `repo:fs-changed` arriving a
 * moment later describes changes the results already include. Absorbing means *accepting* the
 * nonce, not ignoring it — the list ends up marked current rather than permanently stale. Time
 * based rather than a skip-one counter, so a write that somehow produces no event can't leave a
 * token behind that eats the next real one.
 */
const REPLACE_ECHO_MS = 1500;

/** Mirrors `MAX_HITS_PER_FILE` in `search.rs`: a file being edited must not show more hits than the
 * same file will show the moment it is saved. */
const MAX_HITS_PER_FILE = 20;

/** Mirrors `MAX_LINE_CHARS` in `search.rs`. */
const MAX_LINE_CHARS = 400;

/**
 * The matcher `build_matcher` builds in `search.rs`, in JavaScript.
 *
 * It exists because the backend can only see disk, and the buffers being typed into are precisely
 * the ones it gets wrong. For literal, whole-word and case-insensitive matching this is exact: the
 * same escape, the same `\b(?:…)\b` wrapper, the same case flag. In regex mode it is an
 * approximation — JavaScript has lookaround and backreferences, Rust's `regex` crate does not — so
 * a pattern using them can match in an unsaved buffer and not in the saved file beside it. Said out
 * loud rather than papered over: the backend stays the authority for everything on disk, and this
 * only ever runs over the handful of files that are open *and* dirty.
 */
function buildBufferMatcher(query: string, options: SearchOptions): RegExp {
  const body = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = options.wholeWord ? `\\b(?:${body})\\b` : body;
  return new RegExp(pattern, options.caseSensitive ? "" : "i");
}

/**
 * The glob list `build_globs` builds in `search.rs`, in JavaScript — same comma split, same
 * "a pattern with no `/` matches by file name anywhere" rule.
 *
 * `**` has to be consumed before `*` or the single-star branch would eat half of it and leave a
 * pattern that matches nothing. Like its sibling above this is an approximation of `globset` and it
 * only ever runs over open dirty files; everything on disk goes through the real thing.
 */
function buildBufferGlobs(patterns: string): RegExp | null {
  const list = patterns
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  const parts = list.map((pattern) => {
    const normalized = pattern.includes("/") ? pattern : `**/${pattern}`;
    let out = "";
    for (let i = 0; i < normalized.length; i += 1) {
      const ch = normalized[i];
      if (ch === "*" && normalized[i + 1] === "*") {
        // `**/` also has to match zero directories, so `**/x.ts` finds a top-level `x.ts`.
        if (normalized[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else if (ch === "*") out += "[^/]*";
      else if (ch === "?") out += "[^/]";
      else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return out;
  });
  try {
    return new RegExp(`^(?:${parts.join("|")})$`);
  } catch {
    return null;
  }
}

/** Mirrors `truncate_line` in `search.rs`, so a buffer hit and a disk hit for the same long line
 * are cut at the same place. */
function truncateLine(line: string): string {
  const trimmed = line.replace(/[\r\n]+$/, "");
  const chars = [...trimmed];
  return chars.length > MAX_LINE_CHARS ? `${chars.slice(0, MAX_LINE_CHARS).join("")}…` : trimmed;
}

function Toggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
      }`}
    >
      {children}
    </button>
  );
}

/** Find and replace across the project: the same controls an editor's search sidebar has —
 * case, whole word, regex, replace, and include/exclude globs.
 *
 * Replacing writes to files the user may not have open, so it always goes through the backend's
 * checkpoint first: every replace can be undone as a unit from the restore-points list.
 *
 * The results follow the repo rather than describing the moment they were asked for. Two things
 * make that true and they are deliberately separate: `fsNonce` re-runs the backend walk when
 * anything on disk changes, and `dirtyBuffers` lays the *unsaved* editor buffers over the answer.
 * Neither alone is enough — the walk can't see a buffer that was never written, and the overlay
 * can't see a checkout.
 */
export function SearchPanel({
  repoPath,
  fsNonce,
  dirtyBuffers,
  onOpenHit,
  onClose,
}: {
  repoPath: string;
  /**
   * Bumped by `EditorView` every time the watcher reports this repo changed on disk — and already
   * deferred while the Editor sits behind another view, which is the gating a direct
   * `onRepoFsChanged` subscription here would have to duplicate to avoid walking the repo for every
   * `git` command run from the terminal tab.
   */
  fsNonce: number;
  /** The open files with unsaved edits, matched here because the backend only ever sees disk. */
  dirtyBuffers: { path: string; content: string }[];
  onOpenHit: (path: string, line: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [replacing, setReplacing] = useState(false);
  // Only the newest search may write results: a slow query for "a" must not land on top of the
  // fast one for "authenticate" the user has already typed.
  const runRef = useRef(0);
  /** A background re-run is in flight — the watcher's, not the user's. Drives the "updating" note,
   * and never the blanking of the list. */
  const [refreshing, setRefreshing] = useState(false);
  /** The `fsNonce` the displayed results were produced against. A watermark rather than a boolean,
   * so an event arriving *while* a walk is in flight can't be cleared by that walk's own success —
   * it describes a repo that has already moved on. */
  const [searchedNonce, setSearchedNonce] = useState(fsNonce);
  const fsNonceRef = useRef(fsNonce);
  fsNonceRef.current = fsNonce;
  /** Until this moment, a watcher event is this panel's own replace echoing back — see
   * `REPLACE_ECHO_MS`. */
  const echoUntilRef = useRef(0);

  const busy = searching || refreshing;
  const stale = searchedNonce !== fsNonce && Boolean(query.trim());

  const options: SearchOptions = useMemo(
    () => ({ caseSensitive, wholeWord, regex: useRegex, include, exclude }),
    [caseSensitive, wholeWord, useRegex, include, exclude],
  );

  /**
   * One walk of the repo.
   *
   * `background` distinguishes the two reasons this runs, and they want different failure
   * behaviour: the user asking a new question, and the panel catching up with a repo that changed
   * underneath it.
   */
  const run = useCallback(
    async (text: string, current: SearchOptions, background = false) => {
      const token = ++runRef.current;
      // Read before the await: the walk takes as long as it takes, and its results describe the
      // repo as of the moment it *started*. Recording the later nonce would mark the list current
      // against changes it never saw.
      const at = fsNonceRef.current;
      if (!text.trim()) {
        setHits([]);
        setTruncated(false);
        setSearching(false);
        setRefreshing(false);
        setError(null);
        setSearchedNonce(at);
        return;
      }
      if (background) setRefreshing(true);
      else setSearching(true);
      try {
        const outcome = await searchRepo(repoPath, text, current);
        if (token !== runRef.current) return;
        setHits(outcome.hits);
        setTruncated(outcome.truncated);
        setError(null);
        setSearchedNonce(at);
      } catch (e) {
        if (token !== runRef.current) return;
        // A background re-run failing is no reason to throw away results that were right a moment
        // ago: the query hasn't changed, so the likely cause is the repo being mid-rewrite by the
        // very checkout that fired the event. Keep the rows, keep the stale mark, try again on the
        // next event. A foreground failure is the half-typed-regex case and still clears.
        if (!background) {
          setHits([]);
          setTruncated(false);
        }
        // A half-typed regex lands here on nearly every keystroke, so it's shown inline rather
        // than as a toast.
        setError(String(e));
      } finally {
        if (token === runRef.current) {
          setSearching(false);
          setRefreshing(false);
        }
      }
    },
    [repoPath],
  );

  useEffect(() => {
    const id = setTimeout(() => void run(query, options), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, options, run]);

  /**
   * The watcher's answer, coalesced — the whole reason this panel stops going stale.
   *
   * The list is a claim about what is in the repo, and every other thing making that claim — the
   * tree, the open buffers, the change badges — already rebuilds itself when the repo changes. This
   * one didn't: a search run before a checkout, before an agent's edit, or before a save from
   * another window kept showing the old lines at line numbers that had already moved, until the
   * query was retyped.
   *
   * Nothing starts while a walk is already in flight. On a large tree the watcher can fire faster
   * than a walk finishes, and queueing walks would turn a `git pull` into a backlog; instead the
   * list stays marked stale and `busy` falling re-arms this, so the cost self-limits to one walk at
   * a time whatever the repo's size.
   */
  useEffect(() => {
    if (!stale || busy) return;
    const id = window.setTimeout(() => void run(query, options, true), FS_COALESCE_MS);
    return () => window.clearTimeout(id);
  }, [stale, busy, query, options, run]);

  /** This panel's own replace, echoing back off the watcher — accepted rather than acted on, so one
   * click costs one walk instead of two. See `REPLACE_ECHO_MS`. */
  useEffect(() => {
    if (Date.now() >= echoUntilRef.current) return;
    setSearchedNonce(fsNonce);
  }, [fsNonce]);

  /** Deferred so a fast typist isn't re-matching buffers on the keystroke's critical path — the
   * same trade the note editor makes for its preview. */
  const settledBuffers = useDeferredValue(dirtyBuffers);

  /**
   * The unsaved buffers, matched here, per path.
   *
   * A `useMemo` and not another `searchRepo`: it runs over the handful of files that are open *and*
   * dirty, so it can afford to run on every keystroke — which is the entire reason typing in the
   * editor moves the results at all. A path present here answers for itself completely, *including*
   * when it has no matches left, so deleting the last occurrence in a file you're editing removes
   * its group instead of resurrecting the saved one.
   */
  const bufferHits = useMemo(() => {
    const text = query.trim();
    if (!text || settledBuffers.length === 0) return null;
    let matcher: RegExp;
    try {
      matcher = buildBufferMatcher(text, options);
    } catch {
      // A half-typed regex. The foreground run already reports it inline, and there is nothing
      // meaningful to lay over the results until it parses.
      return null;
    }
    const include = buildBufferGlobs(options.include);
    const exclude = buildBufferGlobs(options.exclude);
    const out = new Map<string, SearchHit[]>();
    for (const buffer of settledBuffers) {
      if (include && !include.test(buffer.path)) continue;
      if (exclude && exclude.test(buffer.path)) continue;
      const found: SearchHit[] = [];
      const lines = buffer.content.split("\n");
      for (let i = 0; i < lines.length && found.length < MAX_HITS_PER_FILE; i += 1) {
        const line = lines[i].replace(/\r$/, "");
        if (matcher.test(line)) found.push({ path: buffer.path, line_no: i + 1, line: truncateLine(line) });
      }
      out.set(buffer.path, found);
    }
    return out;
  }, [settledBuffers, query, options]);

  const grouped = useMemo(() => {
    const byFile = new Map<string, SearchHit[]>();
    for (const hit of hits) {
      const overlaid = bufferHits?.get(hit.path);
      if (overlaid) {
        // The buffer answers for this file — but it inherits the disk pass's *position* in the
        // list. A group that jumped to the bottom the moment you typed in it would be its own kind
        // of "the results moved under me".
        if (!byFile.has(hit.path)) byFile.set(hit.path, overlaid);
        continue;
      }
      const existing = byFile.get(hit.path);
      if (existing) existing.push(hit);
      else byFile.set(hit.path, [hit]);
    }
    // Dirty files the backend never reported: the match was typed and not yet saved, which is the
    // case this overlay exists for in the first place.
    if (bufferHits) {
      for (const [path, fileHits] of bufferHits) {
        if (fileHits.length > 0 && !byFile.has(path)) byFile.set(path, fileHits);
      }
    }
    return [...byFile.entries()].filter(([, fileHits]) => fileHits.length > 0);
  }, [hits, bufferHits]);

  /** Counted off what is on screen rather than off the backend's list: with a buffer laid over it
   * the two genuinely differ, and the number under the box has to be the number of rows above it. */
  const shownCount = useMemo(() => grouped.reduce((n, [, fileHits]) => n + fileHits.length, 0), [grouped]);

  const replace = async (onlyPath?: string) => {
    const scope = onlyPath ?? null;
    // Replace writes to disk, and `syncOpenTabs` deliberately leaves dirty tabs alone — so a file
    // the user is editing would silently swallow the replacement the next time they save. The
    // per-file button is disabled outright for those; replace-all can't be, so it says so instead.
    const unsaved = grouped.filter(([path]) => bufferHits?.has(path)).length;
    const confirmed = await confirmAction(
      scope
        ? t("editor.confirmReplaceFile", { file: scope })
        : t("editor.confirmReplaceAll", { n: shownCount, files: grouped.length }) +
            (unsaved > 0 ? t("editor.replaceUnsavedNote", { d: unsaved }) : ""),
      true,
    );
    if (!confirmed) return;
    setReplacing(true);
    try {
      const outcome = await replaceInRepo(repoPath, query, replacement, options, scope);
      useToastStore
        .getState()
        .pushToast(t("editor.replaced", { n: outcome.replacements, files: outcome.files }), "success");
      // The files changed underneath the rest of the app; the status and diffs it shows are now
      // stale, and the results list has to be rebuilt against the new content.
      void useRepoStore.getState().refreshAll();
      // The write we just made reaches the watcher in a moment. This list is already being rebuilt
      // against it on the next line, so that event is an echo — see `REPLACE_ECHO_MS`.
      echoUntilRef.current = Date.now() + REPLACE_ECHO_MS;
      await run(query, options);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setReplacing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--cf-border)] p-1.5">
        <div className="flex items-start gap-1">
          {/* The chevron that folds the replace row open, exactly where editors put it. */}
          <button
            onClick={() => setShowReplace((v) => !v)}
            title={t("editor.toggleReplace")}
            className="mt-1 flex h-5 w-4 shrink-0 items-center justify-center text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            {showReplace ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>

          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5">
              <Search size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && onClose()}
                placeholder={t("editor.searchPlaceholder")}
                className="min-w-0 flex-1 bg-transparent py-1 text-[12px] outline-none"
              />
              <Toggle active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title={t("editor.matchCase")}>
                <CaseSensitive size={12} />
              </Toggle>
              <Toggle active={wholeWord} onClick={() => setWholeWord((v) => !v)} title={t("editor.wholeWord")}>
                <WholeWord size={12} />
              </Toggle>
              <Toggle active={useRegex} onClick={() => setUseRegex((v) => !v)} title={t("editor.useRegex")}>
                <Regex size={12} />
              </Toggle>
            </div>

            {showReplace && (
              <div className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5">
                <Replace size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder={useRegex ? t("editor.replacePlaceholderRegex") : t("editor.replacePlaceholder")}
                  className="min-w-0 flex-1 bg-transparent py-1 text-[12px] outline-none"
                />
                <button
                  onClick={() => void replace()}
                  disabled={hits.length === 0 || replacing}
                  title={t("editor.replaceAll")}
                  aria-label={t("editor.replaceAll")}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"
                >
                  {replacing ? <Loader2 size={12} className="animate-spin" /> : <ReplaceAll size={12} />}
                </button>
              </div>
            )}

            {showFilters && (
              <div className="space-y-1">
                <input
                  value={include}
                  onChange={(e) => setInclude(e.target.value)}
                  placeholder={t("editor.filesToInclude")}
                  className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-1 font-mono text-[11px] outline-none"
                />
                <input
                  value={exclude}
                  onChange={(e) => setExclude(e.target.value)}
                  placeholder={t("editor.filesToExclude")}
                  className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-1 font-mono text-[11px] outline-none"
                />
              </div>
            )}
          </div>

          {/* No close button. The panel is a sidebar section reached from the activity bar, and the
              icon that opens it is the icon that closes it — an X inside as well made "closed" two
              controls in two places disagreeing about one piece of state. Escape still closes it,
              which is what the input's own keydown is for. */}
          <div className="mt-0.5 flex shrink-0 flex-col items-center gap-0.5">
            <Toggle
              active={showFilters || Boolean(include || exclude)}
              onClick={() => setShowFilters((v) => !v)}
              title={t("editor.toggleFilters")}
            >
              <MoreHorizontal size={12} />
            </Toggle>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && <p className="px-3 py-2 text-[11px] text-[var(--cf-danger)]">{error}</p>}
        {/* The standalone spinner only when there is nothing on screen yet. Shown during every
            re-run it pushed the whole list down and back on each save — a re-run is the panel
            agreeing with the repo, not the user asking a new question, so once there are rows the
            spinner rides on the count line below instead. */}
        {searching && shownCount === 0 && (
          <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-[var(--cf-text-muted)]">
            <Loader2 size={11} className="animate-spin" />
            {t("editor.searching")}
          </div>
        )}
        {/* Gated on `stale` as well, so "No matches" can't flash in the window between an edit and
            the re-grep that will find the match the user just typed. */}
        {!busy && !stale && !error && query.trim() && shownCount === 0 && (
          <p className="px-3 py-2 text-[11px] text-[var(--cf-text-muted)]">{t("editor.noMatches")}</p>
        )}
        {shownCount > 0 && (
          <p className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <span>
              {t("editor.matchCount", { hits: shownCount, files: grouped.length })}
              {truncated ? ` · ${t("editor.searchTruncated")}` : ""}
            </span>
            {/* One indicator covering both the coalesce wait and the walk itself, so it can't blink
                off and on again between the two. */}
            {(busy || stale) && (
              <span className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                {t("editor.searchUpdating")}
              </span>
            )}
          </p>
        )}
        {grouped.map(([path, fileHits]) => {
          const isCollapsed = collapsed[path];
          return (
            <div key={path} className="group/file pb-1">
              <div className="flex items-center gap-1 px-1.5 py-0.5">
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [path]: !c[path] }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
                  ) : (
                    <ChevronDown size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
                  )}
                  <FileGlyph path={path} size={12} />
                  <span className="truncate text-[11px] text-[var(--cf-text)]">{path}</span>
                  {/* These hits came from the buffer, not from disk — so a line number that
                      disagrees with a colleague's checkout is explained rather than mysterious. */}
                  {bufferHits?.has(path) && (
                    <span
                      title={t("editor.searchUnsaved")}
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cf-accent)]"
                    />
                  )}
                  <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">{fileHits.length}</span>
                </button>
                {showReplace && (
                  <button
                    onClick={() => void replace(path)}
                    disabled={replacing || Boolean(bufferHits?.has(path))}
                    title={bufferHits?.has(path) ? t("editor.replaceNeedsSave") : t("editor.replaceInFile")}
                    aria-label={t("editor.replaceInFile")}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:bg-black/[0.05] group-hover/file:opacity-100 disabled:opacity-30 dark:hover:bg-white/[0.08]"
                  >
                    <Replace size={11} />
                  </button>
                )}
              </div>
              {!isCollapsed &&
                fileHits.map((hit, at) => (
                  <button
                    // Keyed by position in the group rather than by line number: a hit sliding from
                    // line 40 to 41 as the file above it grows would otherwise remount the row and
                    // replay the rise stagger, flickering the whole list on every keystroke.
                    key={`${hit.path}:${at}`}
                    onClick={() => onOpenHit(hit.path, hit.line_no)}
                    style={riseDelay(at)}
                    className="cf-rise flex w-full items-start gap-2 rounded px-2 py-0.5 pl-7 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  >
                    <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">{hit.line_no}</span>
                    <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                      {hit.line.trim()}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
