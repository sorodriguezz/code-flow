import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, Folder, FolderGit2, GitBranch, GitCompareArrows, StickyNote } from "lucide-react";
import { FileGlyph } from "../common/FileGlyph";
import { listRepoFiles } from "../../lib/tauri/commands";
import { notesLoadTree } from "../../lib/tauri/notesCommands";
import { codemapFind, type SymbolHit } from "../../lib/tauri/codemapCommands";
import { rankPaths } from "../../lib/fuzzyPath";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * `@` in the assistant's chats: type `@` and part of a name, pick a row, and the question carries the
 * mention. The text itself stays what the user wrote; the backend reads the mentions back out.
 *
 * - **Repository chat** (`repoPath`): files and folders (`@src/app.ts`), symbols from the repo map's
 *   index — inserted as their file and line range (`@src/app.ts:10-24`, the form the editor's «Preguntar
 *   en el chat» already sends) — and two that name no path: `@cambios`, the uncommitted changes, and
 *   `@rama`, what the branch adds over its base (`ai::special_mentions`, which attaches the diffs).
 * - **Workspace chat** (`repos`): the repositories first (`@api/`), then that repository's paths
 *   (`@api/src/app.ts`) — `ai::workspace_mentioned_paths` resolves them to absolute paths.
 * - **Both** (`workspaceId`): `[[` and part of a title offers the workspace's notes, inserted as
 *   `[[Título]]` — Notas' own link syntax — which `ai::note_mention_note` reads into the turn in
 *   full, under the knowledge rules (never a local-only book for a cloud engine).
 */

/** Rows offered. The list is narrowed by typing, not by scrolling. */
const MAX_ROWS = 12;
/** Symbols among them, ahead of the paths: a name typed is more often a function than a file. */
const MAX_SYMBOLS = 5;
/** The index is asked once typing pauses, and only for a name long enough to mean something. */
const SYMBOL_DELAY_MS = 150;
const SYMBOL_MIN_CHARS = 2;

/** How long a repository's file list is reused before it is walked again: long enough that typing
 *  a mention never waits, short enough that a file created a moment ago is there next time. */
const FRESH_MS = 30_000;

const cache = new Map<string, { at: number; paths: string[] }>();

/** One row of the menu. `insert` is what goes after the `@`. */
export interface MentionItem {
  kind: "path" | "symbol" | "changes" | "branch" | "repo" | "note";
  insert: string;
  /** The bold part of the row and the muted part after it. */
  label: string;
  detail: string;
  /** For a path or a symbol: the file, for its glyph. */
  path?: string;
}

/** Every file of the repository, and every folder above one (with a trailing `/`). */
function withFolders(files: string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    let cut = file.lastIndexOf("/");
    while (cut > 0) {
      const folder = file.slice(0, cut);
      if (folders.has(folder)) break;
      folders.add(folder);
      cut = folder.lastIndexOf("/");
    }
  }
  return [...files, ...[...folders].map((folder) => `${folder}/`)];
}

function useRepoPaths(repoPath: string | null, enabled: boolean): string[] {
  const [paths, setPaths] = useState<string[]>(() => (repoPath ? (cache.get(repoPath)?.paths ?? []) : []));
  useEffect(() => {
    if (!enabled || !repoPath) {
      setPaths([]);
      return;
    }
    const hit = cache.get(repoPath);
    setPaths(hit?.paths ?? []);
    if (hit && Date.now() - hit.at < FRESH_MS) return;
    let live = true;
    void listRepoFiles(repoPath)
      .then((files) => {
        const all = withFolders(files);
        cache.set(repoPath, { at: Date.now(), paths: all });
        if (live) setPaths(all);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repoPath, enabled]);
  return paths;
}

const noteCache = new Map<string, { at: number; titles: { title: string; book: string }[] }>();

/** The workspace's note titles (its own and the global ones), for `[[`. */
function useNoteTitles(workspaceId: string | null, enabled: boolean): { title: string; book: string }[] {
  const [titles, setTitles] = useState<{ title: string; book: string }[]>(() => (workspaceId ? (noteCache.get(workspaceId)?.titles ?? []) : []));
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    const hit = noteCache.get(workspaceId);
    if (hit) setTitles(hit.titles);
    if (hit && Date.now() - hit.at < FRESH_MS) return;
    let live = true;
    void notesLoadTree(workspaceId)
      .then((tree) => {
        const books = new Map(tree.books.map((book) => [book.id, book.name]));
        const all = tree.notes
          .filter((note) => note.title.trim())
          .map((note) => ({ title: note.title.trim(), book: note.book_id ? (books.get(note.book_id) ?? "") : "" }));
        noteCache.set(workspaceId, { at: Date.now(), titles: all });
        if (live) setTitles(all);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId, enabled]);
  return titles;
}

/** Case and accents folded, as the backend matches a cited title. */
function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** The `[[title` being typed at the caret — where its `[[` starts and what follows — or `null`. */
export function noteMentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /\[\[([^\[\]\n]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 2, query: match[1] };
}

/** `text` with the `[[…` at `start` replaced by the whole link and a space, and where the caret goes. */
export function insertNoteMention(text: string, start: number, caret: number, title: string): { text: string; caret: number } {
  const inserted = `[[${title}]] `;
  const rest = text.slice(caret).replace(/^[^\s\]]*\]{0,2}/, "").replace(/^ /, "");
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}

/** The index's declarations matching `query`, asked once typing pauses. */
function useSymbols(repoPath: string | null, query: string, enabled: boolean): SymbolHit[] {
  const [hits, setHits] = useState<SymbolHit[]>([]);
  useEffect(() => {
    if (!enabled || !repoPath || query.length < SYMBOL_MIN_CHARS || query.includes("/")) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      codemapFind(repoPath, query)
        .then((found) => live && setHits(found.slice(0, MAX_SYMBOLS)))
        .catch(() => live && setHits([]));
    }, SYMBOL_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [repoPath, query, enabled]);
  return hits;
}

/** The name a repository goes by in a mention: whitespace as `-`, so it stays one token — the same
 *  rule as `ai::mention_name`. */
export function mentionName(repoName: string): string {
  return repoName.trim().split(/\s+/).join("-");
}

/** The words `@cambios` / `@rama` go by in the user's language — the backend reads both. */
function specialWords(language: string): { changes: string; branch: string } {
  return language === "es" ? { changes: "cambios", branch: "rama" } : { changes: "changes", branch: "branch" };
}

/** The `@word` being typed at the caret — its start in the text and what follows the `@` — or
 *  `null` when the caret is not in one. An email's `@` has a letter before it, so it is not one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

/** `text` with the mention at `start` (as typed up to `caret`) replaced by `@insert` — and a space,
 *  unless it is a folder or a repository the user goes on typing into — and where the caret goes. */
export function insertMention(text: string, start: number, caret: number, insert: string): { text: string; caret: number } {
  const inserted = insert.endsWith("/") ? `@${insert}` : `@${insert} `;
  const rest = text.slice(caret).replace(/^\S*/, "").replace(/^ /, "");
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}

function pathItem(path: string, prefix = ""): MentionItem {
  const folder = path.endsWith("/");
  const bare = folder ? path.slice(0, -1) : path;
  const cut = bare.lastIndexOf("/");
  return {
    kind: "path",
    insert: `${prefix}${path}`,
    label: `${cut < 0 ? bare : bare.slice(cut + 1)}${folder ? "/" : ""}`,
    detail: prefix ? `${prefix}${cut < 0 ? "" : bare.slice(0, cut)}` : cut < 0 ? "" : bare.slice(0, cut),
    path,
  };
}

/**
 * The state the composer needs for the menu: the matches for the mention at the caret, which one
 * is highlighted, and a key handler that walks them — call it first in the textarea's `onKeyDown`;
 * it returns `true` when it took the key.
 */
export function useMentions({
  repoPath = null,
  repos,
  workspaceId = null,
  text,
  caret,
  onInsert,
}: {
  /** The repository chat's repository. */
  repoPath?: string | null;
  /** The workspace chat's repositories, instead. */
  repos?: { name: string; path: string }[];
  /** Whose notes `[[` offers. */
  workspaceId?: string | null;
  text: string;
  caret: number;
  onInsert: (next: { text: string; caret: number }) => void;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const noteMention = workspaceId ? noteMentionAt(text, caret) : null;
  const mention = noteMention ?? mentionAt(text, caret);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const active = mention !== null && dismissedAt !== mention.start;
  const query = mention?.query ?? "";

  // The workspace chat: `@repo/…` narrows to that repository's paths.
  const slash = query.indexOf("/");
  const inRepo = repos && slash > 0 ? (repos.find((repo) => mentionName(repo.name) === query.slice(0, slash)) ?? null) : null;
  const listedRepo = repos ? (inRepo?.path ?? null) : repoPath;
  const pathQuery = inRepo ? query.slice(slash + 1) : query;
  const paths = useRepoPaths(listedRepo, active && !noteMention && (!repos || inRepo !== null));
  const symbols = useSymbols(repoPath, query, active && !noteMention && !repos);
  const notes = useNoteTitles(workspaceId, active && noteMention !== null);

  const items = useMemo<MentionItem[]>(() => {
    if (!active) return [];
    if (noteMention) {
      const needle = fold(query.trim());
      const label = t("chat.mentionNote");
      return notes
        .filter((note) => fold(note.title).includes(needle))
        .slice(0, MAX_ROWS)
        .map((note) => ({ kind: "note" as const, insert: note.title, label: note.title, detail: note.book || label }));
    }
    if (repos) {
      if (inRepo) return rankPaths(paths, pathQuery, MAX_ROWS).map((path) => pathItem(path, `${mentionName(inRepo.name)}/`));
      const needle = query.toLowerCase();
      return repos
        .filter((repo) => mentionName(repo.name).toLowerCase().includes(needle))
        .slice(0, MAX_ROWS)
        .map((repo) => ({ kind: "repo" as const, insert: `${mentionName(repo.name)}/`, label: mentionName(repo.name), detail: repo.path }));
    }
    const words = specialWords(language);
    const needle = query.toLowerCase();
    const special: MentionItem[] = [];
    if (words.changes.startsWith(needle)) special.push({ kind: "changes", insert: words.changes, label: words.changes, detail: t("chat.mentionChanges") });
    if (words.branch.startsWith(needle)) special.push({ kind: "branch", insert: words.branch, label: words.branch, detail: t("chat.mentionBranch") });
    const found: MentionItem[] = symbols.map((hit) => ({
      kind: "symbol",
      insert: `${hit.path}:${hit.start}-${hit.end}`,
      label: hit.name,
      detail: `${hit.path}:${hit.start}`,
      path: hit.path,
    }));
    const rest = MAX_ROWS - special.length - found.length;
    return [...special, ...found, ...rankPaths(paths, query, Math.max(0, rest)).map((path) => pathItem(path))];
  }, [active, noteMention, notes, repos, inRepo, paths, pathQuery, query, symbols, language, t]);

  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [mention?.query, mention?.start]);
  // A new `@` somewhere else is a new mention: Escape on the last one does not hide this one.
  useEffect(() => {
    if (mention === null) setDismissedAt(null);
  }, [mention === null]);

  const pick = (item: MentionItem) => {
    if (!mention) return;
    onInsert(item.kind === "note" ? insertNoteMention(text, mention.start, caret, item.insert) : insertMention(text, mention.start, caret, item.insert));
  };

  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!active || items.length === 0 || !mention) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (i + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (i - 1 + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
      e.preventDefault();
      pick(items[Math.min(index, items.length - 1)]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissedAt(mention.start);
      return true;
    }
    return false;
  };

  return { open: active && items.length > 0, items, index, pick, onKeyDown };
}

function ItemIcon({ item }: { item: MentionItem }) {
  const muted = "shrink-0 text-[var(--cf-text-muted)]";
  switch (item.kind) {
    case "changes":
      return <GitCompareArrows size={12} className={muted} />;
    case "branch":
      return <GitBranch size={12} className={muted} />;
    case "repo":
      return <FolderGit2 size={12} className={muted} />;
    case "note":
      return <StickyNote size={12} className={muted} />;
    case "symbol":
      return <Braces size={12} className="shrink-0 text-[var(--cf-accent)]" />;
    case "path":
      return item.insert.endsWith("/") ? <Folder size={12} className={muted} /> : <FileGlyph path={item.path ?? item.insert} size={12} />;
  }
}

export function MentionMenu({ items, index, onPick }: { items: MentionItem[]; index: number; onPick: (item: MentionItem) => void }) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t("chat.mentionTitle")}
      className="cf-fade-in mb-1.5 max-h-[260px] overflow-y-auto rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] py-1 shadow-[var(--cf-shadow)]"
    >
      <p className="px-2.5 pb-0.5 pt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--cf-text-faint)]">
        {t("chat.mentionTitle")}
      </p>
      {items.map((item, i) => (
        <button
          key={`${item.kind}:${item.insert}`}
          type="button"
          role="option"
          aria-selected={i === index}
          data-active={i === index}
          // Not a click: the textarea keeps focus, so typing goes on where it was.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          className={`flex h-[26px] w-full items-center gap-2 px-2.5 text-left text-[12px] ${
            i === index ? "bg-[var(--cf-hover)]" : "hover:bg-[var(--cf-hover)]"
          }`}
        >
          <ItemIcon item={item} />
          <span className="shrink-0 text-[var(--cf-text)]">{item.label}</span>
          <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-faint)]">{item.detail}</span>
        </button>
      ))}
    </div>
  );
}
