import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { tempDir } from "@tauri-apps/api/path";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  File as FileIcon,
  FileDown,
  Folder,
  FolderInput,
  FolderPlus,
  FolderUp,
  HardDrive,
  Info,
  Link2,
  Loader2,
  Package,
  PackagePlus,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Sigma,
  SquareCheck,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ColumnsModal } from "../common/ColumnsModal";
import { DataGrid, autoFitWidth, autoFitWidths, type GridColumn } from "../common/DataGrid";
import { range } from "../common/gridBits";
import { useColumnPrefs } from "../common/useColumnPrefs";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { useRemoteStore } from "../../state/remoteStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { onRemoteTransfer, type RemoteTransferEvent } from "../../lib/tauri/events";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { writeFileBytes } from "../../lib/tauri/commands";
import { toCsv } from "../../lib/csv";
import {
  remoteBlobCopy,
  remoteDeleteContainer,
  remoteBlobDeleteSnapshot,
  remoteBlobProperties,
  remoteBlobRestoreSnapshot,
  remoteBlobSnapshot,
  remoteBlobSnapshots,
  remoteDownloadFile,
  remoteListFiles,
  remoteMakeDir,
  remoteRemoveFile,
  remoteRenameFile,
  remoteUploadFile,
} from "../../lib/tauri/remoteCommands";
import type { BlobProperties, BlobSnapshot, RemoteFile } from "../../types/remote";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  ToolbarButton,
  TransferBar,
  WorkBar,
  formatSize,
  formatWhen,
  joinRemote,
  parentRemote,
} from "./remoteChrome";

/**
 * One side only: the store, in a table.
 *
 * **Why this is not `SftpPanel`.** Two panes are right for a shell host, where a transfer is a
 * statement about two places and you want to see both. They are wrong for object storage, where the
 * local half is a file picker's job — the OS already has a better browser for this machine than this
 * app will ever have — and half the window spent drawing `~` is half the window not spent on what is
 * actually in the container.
 *
 * **A container is not a directory, and this is where that stops being pedantry.** It has no size
 * anyone can ask for, no recursive delete, and no end: it holds as many blobs as you have put in it,
 * which may be millions. So the listing is paged rather than read whole, the search is a *prefix*
 * handed to the service rather than a filter run over rows that came back, and neither is a
 * nicety — they are the difference between a panel that opens and a panel that hangs.
 *
 * **What the width buys is columns.** An object has a content type, a storage tier, a blob type and
 * a lease, and every one of them changes what you can do with it: an `Archive` blob cannot be read
 * until it is rehydrated, a leased one refuses writes, a page blob is a VM disk. A column is drawn
 * only when something in the listing filled it — an Azure Files share has no tiers, and a column
 * that is always empty is a lie about what the service has.
 *
 * **The grid is `common/DataGrid`, and the columns are declared rather than laid out.** This panel
 * used to draw its own `<table>` with `table-layout: auto` and two `max-w-0` cells, which is a
 * layout with no answer to "how wide is Name": the browser measured the widest key in the *loaded*
 * page and moved every seam whenever a "load more" landed a longer one. A declared list with a
 * width per key, a `colgroup`'s worth of fixed widths, a draggable seam and a double-click auto-fit
 * is the fix, and it is the same grid the Table entity view already uses — one grid, so a column
 * behaves the same wherever the user meets one.
 *
 * **Which columns exist is cumulative, across pages *and* across re-reads of the same folder.** The
 * old set was recomputed from the rows on hand, so a tier that only page two carried appeared when
 * you paged forward and disappeared the moment you refreshed. Kept as a union it does neither, and
 * it resets on navigation because a share's columns are not a container's.
 */
export interface ObjectBrowserProps {
  hostId: string;
  /**
   * Where the browser opens, and the floor it will not climb above. Empty means the far side
   * decides — the bucket list on S3.
   */
  root?: string;
  /** What the first breadcrumb says. Defaults to the host's name. */
  title?: string;
  /**
   * What the *root* holds, when the answer is not "folders".
   *
   * **Because a container is not a folder, and the root is the one place that matters.** The grid
   * opens one like a folder on purpose — a second kind of row would be a second thing every
   * operation had to learn — but creating one, deleting one and naming one are all different acts,
   * so the button, the icon and the rules read this instead of assuming.
   */
  rootChild?: RootChild;
  /** The URL an entry is reachable at, when the far side has one. Only the caller knows: this
   *  component sees paths, and a path is not an address. */
  linkFor?: (entry: RemoteFile) => string;
  /** Whether this service has blob-only operations — snapshots, tiers, properties. */
  blobFeatures?: boolean;
}

/**
 * What the root of a store holds. One idea, three names — and they are not interchangeable: a
 * bucket's name is global to all of AWS, a container's is scoped to its account, and a share has a
 * quota. What they share is that none of them is a folder.
 */
export type RootChild = "container" | "share" | "bucket";

/** What the side drawer is showing, if anything. */
type Drawer =
  | { kind: "properties"; entry: RemoteFile }
  | { kind: "snapshots"; entry: RemoteFile }
  | null;

/**
 * The sort key, as a column key rather than as an enum of the seven columns.
 *
 * `null` is a state and not an absence: it is the order the service returned, which for a listing is
 * the order the service is cheapest at and often the only one that means anything (a marker-paged
 * container is lexicographic on the wire). The cycle is ascending → descending → back to it.
 */
type Sort = { column: string; descending: boolean } | null;

/** A value the sort may compare as a number. Deliberately narrower than `Number`, which also accepts
 *  `0x10` and `" 1 "` — see the comparator. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

export function ObjectBrowser({
  hostId,
  root = "",
  title,
  rootChild,
  linkFor,
  blobFeatures,
}: ObjectBrowserProps) {
  const host = useRemoteStore((s) => s.hosts.find((entry) => entry.id === hostId) ?? null);
  const language = useLanguageStore((s) => s.language);
  const t = useT();

  const [rows, setRows] = useState<RemoteFile[] | null>(null);
  const [path, setPath] = useState(root);
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A listing is in flight. Separate from `busy`, which is a *transfer*: refreshing while a download
   *  runs is legitimate, and one flag for both would disable each on the other's account. */
  const [reading, setReading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [progress, setProgress] = useState<RemoteTransferEvent | null>(null);
  const [sort, setSort] = useState<Sort>(null);

  /**
   * The prefix the *service* is filtering on, and the text the box currently holds.
   *
   * Two states rather than one because a keystroke must not be a request: the search is applied on
   * Enter or on the button, and until then the box is just text. A debounce would be worse — every
   * pause mid-word would be a round trip and a re-page from the beginning.
   */
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  /** Whether the prefix row is showing. Collapsed by default, like the Table panel's query row: it
   *  is a bar's worth of height spent on a control most navigation never touches, and the toolbar's
   *  toggle carries the `active` tint whenever a prefix is actually applied. */
  const [showSearch, setShowSearch] = useState(false);

  /** The typed path, while it is being typed. `null` when the breadcrumb is showing instead. */
  const [pathDraft, setPathDraft] = useState<string | null>(null);

  /**
   * Where the browser has been, and where in that it is standing.
   *
   * A stack with a cursor rather than two stacks: going somewhere new from the middle of the
   * history truncates the forward half, which is what every browser does and what two stacks make
   * awkward to express.
   */
  const [history, setHistory] = useState<string[]>([root]);
  const [historyAt, setHistoryAt] = useState(0);

  /**
   * The picked paths.
   *
   * A `Set`, not an array, because the row render asks "am I selected?" once per row: with an array
   * that is a `.includes()` scan per row, so selecting everything in a 5,000-object container cost
   * ~25 million string comparisons per render — and the listing renders twice for one click. The
   * *order* of a selection is never used; `picked` below re-derives it from `entries`, which is the
   * order the user sees. Paths rather than row indices for the reason the entity grid holds keys: a
   * sort re-orders the view, and "rows 3, 4 and 5" would then be three different objects with the
   * Delete button pointed at them.
   */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  /** Copied paths, waiting for a paste. Server-side, so this holds names and never bytes. */
  const [clipboard, setClipboard] = useState<string[]>([]);

  const [drawer, setDrawer] = useState<Drawer>(null);
  const [customizing, setCustomizing] = useState(false);
  /** The row menu holds the *entry*, not its index. An index into `entries` is exactly as unstable
   *  as an index-based selection: a refresh landing while the menu is open rebuilds the listing, and
   *  Delete would then be pointed at whatever now sits at that position. */
  const [menu, setMenu] = useState<{ x: number; y: number; entry: RemoteFile } | null>(null);
  const [working, setWorking] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );

  /**
   * What the last count found, and which listing it was a count *of*.
   *
   * Both halves of that listing, because both change the number: the folder, and the prefix the
   * service was filtering on when the walk ran. The status line draws this only where all of it still
   * matches, which is why the count survives navigating away and back rather than being cleared —
   * throwing away a scan that cost two hundred round trips because somebody looked in a subfolder is
   * the opposite of what a button behind a confirm is for.
   */
  const [stats, setStats] = useState<{
    path: string;
    prefix: string;
    count: number;
    bytes: number;
    /** The walk stopped before the last marker — the Stop button, or the user leaving the folder — so
     *  `count` is a floor rather than the total. */
    partial: boolean;
  } | null>(null);

  /** Which declared columns something has filled, unioned across every page and every re-read of
   *  this folder. See the file's opening note for why this is not derived per render. */
  const [filled, setFilled] = useState<Set<string>>(() => new Set());
  /** Bumped by each *fresh* listing, never by a continuation — the grid's scroll-to-top signal. */
  const [epoch, setEpoch] = useState(0);

  const [dragging, setDragging] = useState<RemoteFile | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const transferId = useRef(0);
  const paneId = useId();

  /**
   * One token for the listing, shared by the first page and its continuations.
   *
   * They are one conversation: a fresh read has to cancel a page-two request that is still out — it
   * would otherwise append the old folder's rows under the new folder's breadcrumb — and a
   * continuation must never cancel the fresh read that supersedes it. Two live instances of this
   * panel already coexist under one account (blob and files, both mounted, one hidden), which is why
   * this is per-instance state rather than anything module-wide.
   */
  const listToken = useRef(0);
  /**
   * Set by the work bar's stop button; read between iterations of the loops that can run long — a
   * bulk delete, a paste of forty blobs, a move, a selection uploaded or downloaded, the count.
   *
   * Cooperative rather than an abort: the request in flight finishes, and nothing after it is sent.
   * There is no other way out of a loop of round trips — no single request is slow enough to cancel,
   * and the fortieth is as far away as the first.
   *
   * One flag for all of them and one bar, which is why every button that starts one of these loops is
   * disabled while another runs: two at once would be one bar counting two things and a Stop that
   * ended whichever noticed it first.
   */
  const stopped = useRef(false);
  const anchor = useRef(0);
  /** Rows kept from before an additive sweep began, so dragging back up shrinks the run rather than
   *  leaving a trail behind it. */
  const kept = useRef<Set<string>>(new Set());
  /** The press that may become a drag, and the row it started on. One ref for the whole grid rather
   *  than one per row — only one row can be under the pointer when the button goes down — but it
   *  carries the path, because a `pointermove` after that press is delivered to whichever row the
   *  pointer is now over and that row must not start dragging itself. */
  const press = useRef<{ x: number; y: number; path: string } | null>(null);
  /** Where the browser is *now*, for the loops that captured a folder minutes ago. */
  const pathRef = useRef(path);
  pathRef.current = path;
  /**
   * The declared columns, for the loading code.
   *
   * A ref rather than a dependency: the column list closes over `t` and the language (its labels are
   * translations), and putting it in `load`'s dependency list would make a language switch re-issue
   * the listing and throw the user back to the root.
   */
  const declaredRef = useRef<FileColumn[]>([]);
  /**
   * Column preferences, keyed by listing and cleared when the host changes.
   *
   * `hostId` never changes for a given instance — both call sites mount one browser per host — so
   * the reset is a statement of that invariant rather than something this panel relies on.
   */
  const { prefsFor, update: updatePrefs, version: prefsVersion } = useColumnPrefs(hostId);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onRemoteTransfer((event) => {
      if (event.id === `${paneId}-${transferId.current}`) setProgress(event);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [paneId]);

  useEffect(() => {
    const cancel = () => {
      setDragging(null);
      setDropOn(null);
      setDragCursor(false);
    };
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  /** Loads the first page of `target`. The prefix is passed explicitly so a search and a navigation
   *  can be one request rather than two. */
  const load = useCallback(
    async (target: string, prefix: string) => {
      const mine = ++listToken.current;
      // Read before the await: it is where we were, and it is what decides whether the answer is a
      // new listing or another reading of the one on screen.
      const from = pathRef.current;
      setReading(true);
      try {
        const page = await remoteListFiles(hostId, target, { prefix, marker: "" });
        if (listToken.current !== mine) return;
        const fills = fillsOf(declaredRef.current, page.entries);
        // A different folder is a different listing, and its columns are its own: a sort by `tier`
        // means nothing in a share, and a Tier header over a share's rows is a header over an empty
        // column. The *same* folder read again — a refresh, another prefix — unions instead, which
        // is the whole point of a cumulative set: a column page two filled must not vanish when
        // page one is read on its own.
        const fresh = normalize(page.path) !== normalize(from);
        setRows(page.entries);
        setNext(page.next);
        setPath(page.path);
        setFilled((current) => (fresh ? fills : union(current, fills)));
        if (fresh) setSort(null);
        setSelected(new Set());
        anchor.current = 0;
        setDrawer(null);
        setError(null);
        setEpoch((n) => n + 1);
      } catch (failure) {
        if (listToken.current !== mine) return;
        setError(String(failure));
        // A failed *fresh* listing has nothing to show: leaving the previous folder's rows under
        // this folder's breadcrumb is the grid asserting something that isn't true. A failed
        // continuation keeps what it had — see `loadMore`.
        setRows(null);
        setNext("");
      } finally {
        // Unconditionally: nothing else will lower a spinner this call raised.
        setReading(false);
      }
    },
    [hostId],
  );

  /** The next page, appended. The marker belongs to the service and is passed back untouched. */
  const loadMore = async () => {
    // `reading` is in the guard, not only `loadingMore`, and it is the half that is easy to miss: a
    // fresh read increments the token *before* it awaits, so a continuation started while one is in
    // flight borrows the token the fresh read is already holding and neither cancels the other. Both
    // then land — the fresh page one replacing the rows, this page two appending to them — and the
    // listing ends up with a stale page glued under a current one and `next` set to a marker that
    // belongs to a listing nobody is looking at any more.
    if (!next || loadingMore || reading) return;
    // Borrowed, not taken: a continuation is a page *of* the listing that is already loaded, so a
    // fresh read bumping this cancels it and it cancels nothing itself.
    const mine = listToken.current;
    setLoadingMore(true);
    try {
      const page = await remoteListFiles(hostId, path, { prefix: search, marker: next });
      if (listToken.current !== mine) return;
      setRows((current) => [...(current ?? []), ...page.entries]);
      setNext(page.next);
      setFilled((current) => union(current, fillsOf(declaredRef.current, page.entries)));
      // No epoch bump: the point of "load more" is a longer list, and a grid that scrolled back to
      // the top would lose whatever the user was reading when they asked for it.
    } catch (failure) {
      if (listToken.current === mine) pushErrorToast(String(failure));
    } finally {
      setLoadingMore(false);
    }
  };

  /** Navigates, remembering where we were. Clears the search: a prefix belongs to the folder it was
   *  typed in, and carrying it into the next one hides everything for no stated reason. */
  const go = useCallback(
    (target: string) => {
      setSearch("");
      setSearchDraft("");
      setPathDraft(null);
      setHistory((current) => [...current.slice(0, historyAt + 1), target]);
      setHistoryAt((at) => at + 1);
      void load(target, "");
    },
    [historyAt, load],
  );

  const step = (by: -1 | 1) => {
    const to = historyAt + by;
    if (to < 0 || to >= history.length) return;
    setHistoryAt(to);
    setSearch("");
    setSearchDraft("");
    setPathDraft(null);
    void load(history[to], "");
  };

  useEffect(() => {
    void load(root, "");
    setHistory([root]);
    setHistoryAt(0);
  }, [load, root]);

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  const atRoot = normalize(path) === normalize(root);
  const creating: "folder" | RootChild = atRoot && rootChild ? rootChild : "folder";
  const rootIcon = atRoot && rootChild ? ROOT_ICON[rootChild] : null;

  const declared = useMemo(() => fileColumns(t, rootIcon, language), [t, rootIcon, language]);
  declaredRef.current = declared;

  /**
   * Which listing's column preferences apply, and it is deliberately neither per folder nor per
   * service.
   *
   * Per folder would mean an entry per prefix and widths that reset on every navigation — the
   * opposite of what dragging a seam is for. Per service alone would carry the container list's Name
   * width into a folder of 200-character keys. The root and the inside of a store are the two
   * listings whose columns genuinely differ, so they are the two scopes.
   */
  const scope = `${normalize(root) || "/"}${atRoot ? ":root" : ":inside"}`;
  const settings = prefsFor(scope);

  /**
   * Every column this listing could draw, in display order: the ones something filled, plus the ones
   * the user pinned by hand, arranged the way they arranged them.
   *
   * `prefsVersion` is in the dependency list on purpose — the preferences live in a ref so they
   * survive navigating away and back, and a ref changing is not something a memo can see.
   */
  const allColumns = useMemo(() => {
    const available = declared.filter(
      (column) => filled.has(column.key) || settings.extra.includes(column.key),
    );
    if (!settings.order) return available;
    const ordered = settings.order
      .map((key) => available.find((column) => column.key === key))
      .filter((column): column is FileColumn => !!column);
    for (const column of available) if (!ordered.includes(column)) ordered.push(column);
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declared, filled, prefsVersion, scope]);

  const columns = useMemo(
    () => allColumns.filter((column) => !settings.hidden.has(column.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allColumns, prefsVersion, scope],
  );

  /**
   * What the modal lists: every *declared* column, not only the drawn ones.
   *
   * A column nothing filled arrives there unchecked, and checking it is the whole of what "add a
   * column" means for a listing whose fields are fixed by the service — there is nothing to invent,
   * `RemoteFile` has the fields it has, so the only useful act is "draw this one anyway". A free-text
   * add-a-column field would offer to pin a name that can never hold a value.
   */
  const modalColumns = useMemo(
    () => [...allColumns, ...declared.filter((column) => !allColumns.includes(column))],
    [allColumns, declared],
  );

  const entries = useMemo(() => {
    const list = [...(rows ?? [])];
    const column = sort ? declared.find((one) => one.key === sort.column) : null;
    const direction = sort?.descending ? -1 : 1;
    list.sort((a, b) => {
      // Folders first whatever the column, and in the unsorted state too: a folder has no size, no
      // type and no tier, and sorted in among the blobs by a field it does not have it scatters to
      // one end. It is also what every file browser does, which is the grammar people arrive with.
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      // No sort key: whatever the service said, in the order it said it. `Array.sort` is stable, so
      // returning 0 here really does preserve it.
      if (!column) return 0;
      const left = sortValue(column, a);
      const right = sortValue(column, b);
      // A column that knows its own numeric truth is compared on it and never on its text — see
      // `sortOn`.
      if (typeof left === "number" && typeof right === "number") {
        return (left - right) * direction;
      }
      const one = String(left);
      const two = String(right);
      // Empty last in both directions: a folder with no content type is not the smallest content
      // type, and burying the rows with nothing to say under the ones that do is the point of
      // sorting by a column at all.
      if (one === "" && two === "") return 0;
      if (one === "") return 1;
      if (two === "") return -1;
      // Both sides plainly decimal, or neither. A looser test would send some pairs down the numeric
      // branch and others down the string one, and a comparator that mixes the two stops being a
      // total order — which `Array.sort` is entitled to answer with arbitrary output.
      if (DECIMAL.test(one) && DECIMAL.test(two)) return (Number(one) - Number(two)) * direction;
      return one.localeCompare(two, undefined, { numeric: true }) * direction;
    });
    return list;
  }, [rows, sort, declared]);

  // A fresh listing sizes its own columns, and only the ones the user has not dragged: a width set
  // by hand is a decision, and re-fitting it on every "load more" would undo it every few seconds.
  useEffect(() => {
    if (!rows || rows.length === 0) return;
    const current = prefsFor(scope);
    const missing = columns.filter((column) => current.widths[column.key] === undefined);
    if (missing.length === 0) return;
    updatePrefs(scope, { widths: { ...current.widths, ...autoFitWidths(missing, rows) } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, columns, rows]);

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  const picked = useMemo(
    () => entries.filter((entry) => selected.has(entry.path)),
    [entries, selected],
  );

  /** The same selection as the grid wants it — indices into what is currently drawn. */
  const pickedIndices = useMemo(() => {
    const indices = new Set<number>();
    entries.forEach((entry, index) => {
      if (selected.has(entry.path)) indices.add(index);
    });
    return indices;
  }, [entries, selected]);

  const pathsOf = (indices: Iterable<number>) => {
    const paths = new Set<string>();
    for (const index of indices) {
      const entry = entries[index];
      if (entry) paths.add(entry.path);
    }
    return paths;
  };

  const selectRow = (row: number, modifiers: { range: boolean; toggle: boolean }) => {
    if (modifiers.range) {
      const [from, to] = anchor.current <= row ? [anchor.current, row] : [row, anchor.current];
      const run = pathsOf(range(from, to));
      setSelected((current) => (modifiers.toggle ? new Set([...current, ...run]) : run));
      return;
    }
    anchor.current = row;
    const entry = entries[row];
    if (!entry) return;
    if (modifiers.toggle) {
      setSelected((current) => {
        const next = new Set(current);
        if (!next.delete(entry.path)) next.add(entry.path);
        return next;
      });
      return;
    }
    setSelected(new Set([entry.path]));
  };

  const selectRange = (from: number, to: number, additive: boolean) => {
    // Seeded on the first move of an additive sweep, not on every one: it has to be what was
    // selected when the drag *began*, or dragging back up the gutter would keep re-absorbing the run
    // it is in the middle of shrinking.
    if (!additive) kept.current = new Set();
    else if (kept.current.size === 0) kept.current = new Set(selected);
    const run = pathsOf(range(Math.min(from, to), Math.max(from, to)));
    setSelected(additive ? new Set([...kept.current, ...run]) : run);
  };

  const allPicked = entries.length > 0 && picked.length >= entries.length;
  const one = picked.length === 1 ? picked[0] : null;
  const oneBlob = one && !one.is_dir ? one : null;

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * One loop, one bar, one first-failure toast.
   *
   * Shared by every loop in this panel long enough to need stopping — upload, download, delete, paste,
   * move — because the rules are the same in all of them and they are rules that are easy to get
   * subtly wrong: the stop is checked *between* items so the request in flight is never orphaned, the
   * tally counts attempts rather than successes so the bar cannot stall on a folder of failures, and
   * only the first failure is reported. Forty toasts for one bad prefix is a wall to dismiss, not
   * information.
   *
   * First in this section rather than beside the delete it was written for: the two transfers reach for
   * it as well, and a helper declared below its first caller is a helper the next reader assumes is
   * not shared.
   */
  const eachWithBar = async <T,>(
    items: T[],
    label: string,
    run: (item: T) => Promise<void>,
  ): Promise<number> => {
    stopped.current = false;
    setWorking({ done: 0, total: items.length, label });
    let failed = 0;
    for (const [at, item] of items.entries()) {
      if (stopped.current) break;
      try {
        await run(item);
      } catch (failure) {
        failed += 1;
        if (failed === 1) pushErrorToast(String(failure));
      }
      setWorking({ done: at + 1, total: items.length, label });
    }
    setWorking(null);
    return failed;
  };

  const transfer = async (run: (id: string) => Promise<void>) => {
    if (busy) return;
    const id = `${paneId}-${++transferId.current}`;
    setBusy(true);
    setProgress(null);
    try {
      await run(id);
      await load(path, search);
    } catch (failure) {
      pushErrorToast(String(failure));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  /**
   * Upload, which is a loop exactly when the picker returned more than one thing.
   *
   * A *folder* is one call and the backend walks it, so its transfer knows how many files it holds and
   * `TransferBar` counts them itself — that case needs nothing from the work bar. A selection of forty
   * files is forty calls, each of them a transfer reporting `1/1`, so the pile has nothing counting it
   * and no way out. Same rule and same reason as `download`; the two halves of a transfer should not
   * behave differently for the same gesture.
   */
  const upload = async (directory: boolean) => {
    if (busy || working) return;
    const chosen = await openDialog({
      multiple: !directory,
      directory,
      title: directory ? t("remote.objUploadFolder") : t("remote.objUploadFiles"),
    });
    const locals = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
    if (locals.length === 0) return;
    await transfer(async (id) => {
      if (locals.length === 1) {
        await remoteUploadFile(id, hostId, locals[0], joinRemote(path, basename(locals[0])));
        return;
      }
      const failed = await eachWithBar(locals, t("remote.objUploading"), (local) =>
        remoteUploadFile(id, hostId, local, joinRemote(path, basename(local))),
      );
      if (failed > 1) pushErrorToast(t("remote.objUploadFailedSome", { n: failed }));
    });
  };

  /**
   * Download, and the one action in this panel that draws two bars at once.
   *
   * They say different things and both are needed. `TransferBar` reports the *bytes* of the file that
   * is moving; the work bar reports which file of how many. The per-transfer counter cannot stand in
   * for the second, because every entry here is a transfer of its own — forty selected blobs are forty
   * calls, each one reporting `1/1` — so a selection has always been forty bars that each fill from
   * zero with nothing saying how much of the pile is left, and no way out of it once started.
   *
   * One target keeps the single bar it always had: `1 / 1` beside a Stop that cannot take effect until
   * the only request has already finished is an affordance that does nothing.
   */
  const download = async (targets: RemoteFile[]) => {
    if (targets.length === 0 || busy || working) return;
    const chosen = await openDialog({ directory: true, title: t("remote.objDownloadTitle") });
    const target = Array.isArray(chosen) ? chosen[0] : chosen;
    if (!target) return;
    await transfer(async (id) => {
      if (targets.length === 1) {
        await remoteDownloadFile(id, hostId, targets[0].path, joinLocal(target, targets[0].name));
        return;
      }
      const failed = await eachWithBar(targets, t("remote.objDownloading"), (entry) =>
        remoteDownloadFile(id, hostId, entry.path, joinLocal(target, entry.name)),
      );
      // The loop swallowed each failure so the rest of the pile could carry on, which makes this the
      // only place the size of what did not arrive can be said. One failure already spoke for itself.
      if (failed > 1) pushErrorToast(t("remote.objDownloadFailedSome", { n: failed }));
    });
  };

  /**
   * Opens a blob in whatever this machine opens that kind of file with.
   *
   * There is nothing to open *in place* — the bytes are on the far side — so it downloads to the
   * OS temp directory first and hands the path to the system. A copy, not the blob: editing what
   * comes up changes a temporary file and nothing in the container, which is worth knowing before
   * you type into it.
   */
  const openLocally = async (entry: RemoteFile | null) => {
    if (!entry || entry.is_dir) return;
    await transfer(async (id) => {
      const into = joinLocal(await tempDir(), entry.name);
      await remoteDownloadFile(id, hostId, entry.path, into);
      await openPath(into);
    });
  };

  /** Double-click, Enter on the row number, and the menu's first entry: a folder is navigated into,
   *  anything else is handed to the OS. */
  const openEntry = (entry: RemoteFile | undefined) => {
    if (!entry) return;
    if (entry.is_dir) go(entry.path);
    else void openLocally(entry);
  };

  const relocate = async (mode: "rename" | "move", targets: RemoteFile[]) => {
    if (targets.length === 0 || busy || working) return;
    const answer =
      mode === "rename"
        ? await promptAction(t("remote.objRename"), {
            initial: targets[0].name,
            confirmLabel: t("remote.objRenameConfirm"),
          })
        : await promptAction(t("remote.objMovePrompt"), {
            initial: path,
            confirmLabel: t("remote.objMoveConfirm"),
          });
    if (!answer) return;
    const here = path;
    const prefix = search;

    if (mode === "rename") {
      setBusy(true);
      try {
        await remoteRenameFile(hostId, targets[0].path, joinRemote(here, answer));
        await load(here, prefix);
      } catch (failure) {
        pushErrorToast(String(failure));
      } finally {
        setBusy(false);
      }
      return;
    }

    // A move of forty objects is forty round trips on a service that has no bulk rename, which is
    // exactly the shape the work bar exists for: a tally, and a way out.
    await eachWithBar(targets, t("remote.objMoving"), (entry) =>
      remoteRenameFile(hostId, entry.path, joinRemote(answer, entry.name)),
    );
    if (normalize(pathRef.current) === normalize(here)) await load(here, prefix);
  };

  const moveInto = async (entry: RemoteFile, folder: RemoteFile) => {
    if (entry.path === folder.path || busy) return;
    setBusy(true);
    try {
      await remoteRenameFile(hostId, entry.path, joinRemote(folder.path, entry.name));
      await load(path, search);
    } catch (failure) {
      pushErrorToast(String(failure));
    } finally {
      setBusy(false);
    }
  };

  /** Paste: a server-side copy of everything on the clipboard into one folder — the one that is
   *  open, or the one that was right-clicked. */
  const paste = async (into: string) => {
    if (clipboard.length === 0 || busy || working) return;
    const here = path;
    const prefix = search;
    await eachWithBar(clipboard, t("remote.objCopying"), (from) =>
      remoteBlobCopy(hostId, from, joinRemote(into, leafOf(from))),
    );
    // Only if the browser is still where the paste was aimed: a listing painted over a folder the
    // user has since left is one folder's rows under another's breadcrumb.
    if (normalize(pathRef.current) === normalize(here)) await load(here, prefix);
  };

  /**
   * Delete, which is two different operations depending on where you are standing.
   *
   * **A blob is a yes/no. A container is a name you have to type.** Deleting a container takes
   * every blob in it — possibly millions, with no undo and no trash on the far side — so a dialog
   * whose default is one keystroke away from destroying it is the wrong dialog. Typing the name is
   * the standard for exactly this, and it is what Storage Explorer asks for too. The backend keeps
   * the two apart as separate verbs so this stays a guarantee rather than a habit of the UI.
   */
  const remove = async (targets: RemoteFile[]) => {
    if (targets.length === 0 || busy || working) return;
    const here = path;
    const prefix = search;

    if (atRoot && rootChild) {
      for (const entry of targets) {
        const typed = await promptAction(
          t(CONFIRM_DELETE[rootChild], { name: entry.name }),
          {
            confirmLabel: t("common.delete"),
            validate: (candidate) =>
              candidate === entry.name ? null : t("remote.objTypeTheName", { name: entry.name }),
          },
        );
        // Cancelled: stop here rather than carrying on to the next one. Someone who backs out of
        // deleting the first of three has not agreed to the other two.
        if (typed !== entry.name) return;
        setBusy(true);
        try {
          await remoteDeleteContainer(hostId, entry.path);
        } catch (failure) {
          pushErrorToast(String(failure));
          break;
        } finally {
          setBusy(false);
        }
      }
      // No work bar on this leg on purpose: the dialogs *are* the progress. One typed name per
      // container is a pace nothing needs a tally beside.
      if (normalize(pathRef.current) === normalize(here)) await load(here, prefix);
      return;
    }

    const question =
      targets.length === 1
        ? t("remote.sftpConfirmDelete", { name: targets[0].name })
        : t("remote.objConfirmDeleteMany", { count: targets.length });
    if (!(await confirmAction(question))) return;
    const failed = await eachWithBar(targets, t("remote.objDeleting"), (entry) =>
      remoteRemoveFile(hostId, entry.path, entry.is_dir),
    );
    if (failed > 1) pushErrorToast(t("remote.objDeleteFailedSome", { n: failed }));
    setSelected(new Set());
    if (normalize(pathRef.current) === normalize(here)) await load(here, prefix);
  };

  const makeDir = async () => {
    const name = await promptAction(t(NEW_PROMPT[creating]), {
      confirmLabel: t("common.create"),
      validate:
        creating === "folder"
          ? undefined
          : (candidate) => (namesATopLevel(candidate) ? null : t("remote.objNameRule")),
    });
    if (!name) return;
    try {
      await remoteMakeDir(hostId, joinRemote(path, name));
      await load(path, search);
    } catch (failure) {
      pushErrorToast(String(failure));
    }
  };

  const copyLink = async (targets: RemoteFile[]) => {
    if (targets.length === 0) return;
    const text = targets.map((entry) => linkFor?.(entry) ?? entry.path).join("\n");
    await navigator.clipboard.writeText(text);
    useToastStore.getState().pushToast(t("remote.objCopied"), "success");
  };

  const copyEntries = (targets: RemoteFile[]) => {
    setClipboard(targets.map((entry) => entry.path));
    useToastStore.getState().pushToast(t("remote.objCopiedN", { count: targets.length }), "success");
  };

  /**
   * How many entries this listing holds, and how many bytes they add up to.
   *
   * **A count, because no such number exists to read.** A container has no size and no entry count
   * anywhere in its metadata — neither does a share, neither does a bucket — so the only answer is to
   * list the thing to its end: one request per page of 200, which over a container of half a million
   * blobs is thousands of them. That is the whole reason this is a button behind a confirm rather than
   * a figure the status bar quietly fills in, and the reason the bar it puts up has a Stop.
   *
   * **One level deep, and the confirm has to say so.** `remote_list_files` answers with this folder's
   * own rows plus the prefixes under it; what is *inside* those prefixes would be a walk per subfolder
   * and a recursion no exposed command does. Anyone arriving from Storage Explorer's recursive folder
   * statistics would otherwise read this number as that one.
   *
   * **It walks from the first page, not from where the grid stopped.** Resuming at the loaded marker
   * and seeding the tally with the rows on hand would save those requests, at the price of a count
   * whose correctness depends on nothing having re-read the listing since — a refresh, a prefix, a
   * "load more" in flight. A number that is quietly wrong after an interaction nobody connects to it
   * is worse than one that costs a few more round trips.
   */
  const countHere = async () => {
    const here = path;
    // The prefix the grid is showing, not "everything": a count that answered for rows the listing is
    // filtering out would be a number beside a listing it does not describe.
    const prefix = search;
    if (reading || busy || working) return;
    if (
      !(await confirmAction(
        t("remote.objStatsConfirm", { name: atRoot ? (title ?? host?.name ?? "") : leafOf(here) }),
        false,
        t("remote.objCount"),
      ))
    )
      return;

    let marker = "";
    let count = 0;
    let bytes = 0;
    stopped.current = false;
    setWorking({ done: 0, total: 0, label: t("remote.objCounting") });
    try {
      do {
        const page = await remoteListFiles(hostId, here, { prefix, marker });
        count += page.entries.length;
        // A folder contributes to the count and nothing to the total, which is the same fact the Size
        // column states by staying blank: a prefix has no bytes of its own, and the bytes under it are
        // exactly what this walk is not counting.
        for (const entry of page.entries) if (!entry.is_dir) bytes += entry.size;
        marker = page.next;
        // A running tally with no total, so the bar pulses rather than inventing a percentage of a
        // length nobody knows until the last page comes back.
        setWorking({ done: count, total: 0, label: t("remote.objCounting") });
        // Navigating away ends it as surely as the Stop does. The pages are being fetched for a
        // listing that is no longer on screen, and spending three hundred round trips on a folder the
        // user has left is the cost this confirm exists to make deliberate.
      } while (marker && !stopped.current && normalize(pathRef.current) === normalize(here));
      // Recorded either way, and labelled: "at least 40,000" is still the answer to "is this container
      // big", which is usually the question. `partial` is what keeps it from being read as the total.
      setStats({ path: normalize(here), prefix, count, bytes, partial: !!marker });
    } catch (failure) {
      pushErrorToast(String(failure));
    } finally {
      // Unconditionally: nothing else will ever take down a bar this loop put up.
      setWorking(null);
    }
  };

  /**
   * The listing as a file — every row on screen, or the selection when there is one.
   *
   * That last rule is what makes Export safe to press with nothing picked, and it is the rule the two
   * sibling panels follow, so the button means the same thing on all three pages.
   */
  const exportListing = async () => {
    const chosen = picked.length > 0 ? picked : entries;
    if (chosen.length === 0) return;
    // Named after the folder: a directory of exports needs something in the filename that says which
    // listing each one was.
    const file = await saveDialog({
      defaultPath: `${leafOf(path) || host?.name || "listing"}.csv`,
      filters: [
        { name: "CSV", extensions: ["csv"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (!file) return;
    // CSV is the *grid's* answer: the columns as drawn, in the order they are drawn, each cell's text
    // taken from the column itself — so a hidden column is absent from the file, which is the reason
    // somebody hid it. JSON is the *row* as the service gave it, every field of it, which is the split
    // the entity and queue exports already make; a file browser that quietly dropped `permissions`
    // from its JSON would be the one page whose export meant something else.
    const text = file.toLowerCase().endsWith(".json")
      ? JSON.stringify(chosen, null, 2)
      : toCsv(
          columns.map((column) => column.label),
          chosen.map((entry) => columns.map((column) => column.text(entry))),
        );
    try {
      await writeFileBytes(file, new TextEncoder().encode(text));
      useToastStore
        .getState()
        .pushToast(t("remote.objExported", { n: chosen.length, path: file }), "success");
    } catch (failure) {
      pushErrorToast(String(failure));
    }
  };

  const takeSnapshot = async (entry: RemoteFile | null) => {
    if (!entry || entry.is_dir || busy) return;
    setBusy(true);
    try {
      await remoteBlobSnapshot(hostId, entry.path);
      useToastStore.getState().pushToast(t("remote.objSnapshotTaken"), "success");
      setDrawer({ kind: "snapshots", entry });
    } catch (failure) {
      pushErrorToast(String(failure));
    } finally {
      setBusy(false);
    }
  };

  /**
   * What the right-click offers, and what it offers it *on*.
   *
   * The rule is the entity grid's: right-clicking inside the selection acts on the whole selection,
   * right-clicking outside it moves the selection to that row first — so the menu never operates on
   * something the user cannot see is picked. Everything here already exists as a toolbar button;
   * what the menu adds is the two acts that are about one particular row and read wrongly as global
   * buttons: opening it, and pasting *into* it.
   */
  const rowMenu = (entry: RemoteFile): MenuItem[] => {
    const targets = selected.has(entry.path) && picked.length > 1 ? picked : [entry];
    const items: MenuItem[] = [
      {
        label: t("remote.objOpen"),
        icon: entry.is_dir ? Folder : ExternalLink,
        onClick: () => openEntry(entry),
        disabled: targets.length > 1,
      },
      {
        label: t("remote.objDownload"),
        icon: Download,
        onClick: () => void download(targets),
        disabled: busy || !!working,
      },
      {
        label: linkFor ? t("remote.objCopyUrl") : t("remote.objCopyPath"),
        icon: Link2,
        onClick: () => void copyLink(targets),
      },
      { label: t("remote.objCopy"), icon: Copy, onClick: () => copyEntries(targets) },
    ];
    if (entry.is_dir && clipboard.length > 0) {
      items.push({
        label: t("remote.objPasteInto", { name: entry.name }),
        icon: ClipboardPaste,
        onClick: () => void paste(entry.path),
        disabled: busy || !!working,
      });
    }
    items.push(
      {
        label: t("remote.objRename"),
        icon: Pencil,
        onClick: () => void relocate("rename", targets),
        disabled: targets.length > 1 || busy || !!working,
      },
      {
        label: t("remote.objMove"),
        icon: FolderInput,
        onClick: () => void relocate("move", targets),
        disabled: busy || !!working,
      },
    );
    // Blob's alone, and the same two conditions the toolbar applies: properties will answer for a
    // container, a snapshot only for a blob. A share has neither — `blob_leg` refuses `/files` — so
    // offering them there would be offering a 400.
    if (blobFeatures && targets.length === 1) {
      items.push({
        label: t("remote.objProperties"),
        icon: Info,
        onClick: () => setDrawer({ kind: "properties", entry }),
      });
      if (!entry.is_dir) {
        items.push({
          label: t("remote.objSnapshots"),
          icon: RotateCcw,
          onClick: () => setDrawer({ kind: "snapshots", entry }),
        });
      }
    }
    items.push({
      label:
        targets.length > 1 ? t("remote.objDeleteMany", { count: targets.length }) : t("common.delete"),
      icon: Trash2,
      danger: true,
      separated: true,
      disabled: busy || !!working,
      onClick: () => void remove(targets),
    });
    return items;
  };

  if (!host) return <EmptyState icon={Server} title={t("remote.hostGone")} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--cf-border)] px-1.5 py-1">
        <ToolbarButton
          icon={ArrowLeft}
          label={t("remote.objBack")}
          onClick={() => step(-1)}
          disabled={historyAt === 0}
        />
        <ToolbarButton
          icon={ArrowRight}
          label={t("remote.objForward")}
          onClick={() => step(1)}
          disabled={historyAt >= history.length - 1}
        />
        <ToolbarButton
          icon={ChevronUp}
          label={t("remote.sftpUp")}
          onClick={() => go(clampToRoot(parentRemote(path), root))}
          disabled={atRoot}
        />

        {pathDraft === null ? (
          <div className="flex min-w-0 items-center">
            <Breadcrumb path={path} root={root} title={title ?? host.name} onGo={go} />
            <button
              type="button"
              onClick={() => setPathDraft(path)}
              title={t("remote.objEditPath")}
              aria-label={t("remote.objEditPath")}
              className="ml-0.5 shrink-0 rounded p-1 text-[var(--cf-text-muted)] opacity-60 hover:opacity-100"
            >
              <Pencil size={11} />
            </button>
          </div>
        ) : (
          // Typing a path beats clicking to it when you already know where you are going — which is
          // most of the time, because a path is what a colleague pastes you.
          <input
            autoFocus
            value={pathDraft}
            spellCheck={false}
            onChange={(e) => setPathDraft(e.target.value)}
            onBlur={() => setPathDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(clampToRoot(pathDraft.trim(), root));
              if (e.key === "Escape") setPathDraft(null);
            }}
            className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-0.5 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
          />
        )}

        {/* Allowed to shrink and wrap, not pinned: with the properties drawer open beside a 204px
            service rail this group has ~400px to live in, and seventeen buttons that refuse to wrap
            are seventeen buttons half of which are off the right-hand edge — which is the other half
            of "las acciones se ven mal". `justify-end` keeps the wrapped rows against the same edge
            the group is anchored to. */}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-0.5">
          {(busy || reading) && (
            <Loader2 size={12} className="mr-1 animate-spin text-[var(--cf-text-muted)]" />
          )}
          <ToolbarButton
            icon={Search}
            label={t("remote.objSearch")}
            onClick={() => setShowSearch((on) => !on)}
            active={showSearch || search.length > 0}
          />
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
          {/* Disabled while any long job runs, not only during a transfer: a second pile of files
              would write over the one bar the first is counting in, and share its Stop. */}
          <ToolbarButton
            icon={Upload}
            label={t("remote.objUploadFiles")}
            onClick={() => void upload(false)}
            disabled={busy || !!working}
          />
          <ToolbarButton
            icon={FolderUp}
            label={t("remote.objUploadFolder")}
            onClick={() => void upload(true)}
            disabled={busy || !!working}
          />
          <ToolbarButton
            icon={Download}
            label={t("remote.objDownload")}
            onClick={() => void download(picked)}
            disabled={busy || !!working || picked.length === 0}
          />
          <ToolbarButton
            icon={ExternalLink}
            label={t("remote.objOpen")}
            onClick={() => void openLocally(oneBlob)}
            disabled={busy || !oneBlob}
          />
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
          {/* Absent rather than disabled where the service has no such request: making a bucket
              takes a region and an access policy, which is a form this browser does not have and
              should not pretend to. A button that can only ever fail is worse than no button. */}
          {(creating === "folder" || ROOT_CREATABLE[creating]) && (
            <ToolbarButton
              icon={creating === "folder" ? FolderPlus : PackagePlus}
              label={t(NEW_LABEL[creating])}
              onClick={() => void makeDir()}
              disabled={busy}
            />
          )}
          {/* One button, two states, because "select all" that cannot un-select is a control the
              user has to reach for the Escape key to undo. */}
          <ToolbarButton
            icon={SquareCheck}
            label={allPicked ? t("remote.selectNone") : t("remote.selectAll")}
            onClick={() =>
              setSelected(allPicked ? new Set() : new Set(entries.map((entry) => entry.path)))
            }
            disabled={entries.length === 0}
          />
          <ToolbarButton
            icon={Columns3}
            label={t("remote.gridColumns")}
            onClick={() => setCustomizing(true)}
            disabled={rows === null}
            active={settings.hidden.size > 0 || settings.extra.length > 0}
          />
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
          <ToolbarButton
            icon={Copy}
            label={t("remote.objCopy")}
            onClick={() => copyEntries(picked)}
            disabled={picked.length === 0}
          />
          <ToolbarButton
            icon={ClipboardPaste}
            label={t("remote.objPaste")}
            onClick={() => void paste(path)}
            disabled={busy || !!working || clipboard.length === 0}
          />
          <ToolbarButton
            icon={Pencil}
            label={t("remote.objRename")}
            onClick={() => void relocate("rename", picked)}
            disabled={busy || !!working || picked.length !== 1}
          />
          <ToolbarButton
            icon={FolderInput}
            label={t("remote.objMove")}
            onClick={() => void relocate("move", picked)}
            disabled={busy || !!working || picked.length === 0}
          />
          <ToolbarButton
            icon={Link2}
            label={linkFor ? t("remote.objCopyUrl") : t("remote.objCopyPath")}
            onClick={() => void copyLink(picked)}
            disabled={picked.length === 0}
          />
          {/* The count is in the label, not only in the confirm: a button that says what it is about
              to take is the last chance to notice that it is forty things and not one. Disabled
              while a long job runs, because both loops write the same bar and read the same stop
              flag — two at once means one bar counting two things. */}
          <ToolbarButton
            icon={Trash2}
            label={
              picked.length > 1
                ? t("remote.objDeleteMany", { count: picked.length })
                : t("common.delete")
            }
            onClick={() => void remove(picked)}
            disabled={busy || !!working || picked.length === 0}
          />
          {blobFeatures && (
            <>
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
              <ToolbarButton
                icon={Camera}
                label={t("remote.objSnapshot")}
                onClick={() => void takeSnapshot(oneBlob)}
                disabled={busy || !oneBlob}
              />
              <ToolbarButton
                icon={RotateCcw}
                label={t("remote.objSnapshots")}
                onClick={() => oneBlob && setDrawer({ kind: "snapshots", entry: oneBlob })}
                disabled={!oneBlob}
              />
              <ToolbarButton
                icon={Info}
                label={t("remote.objProperties")}
                onClick={() => one && setDrawer({ kind: "properties", entry: one })}
                disabled={!one}
              />
            </>
          )}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
          {/* Not guarded on `working`, unlike its neighbours: writing the rows already on screen to a
              file is client-side, borrows no bar and sends no request, so there is nothing for it to
              collide with while a long job runs. */}
          <ToolbarButton
            icon={FileDown}
            label={t("remote.objExport")}
            onClick={() => void exportListing()}
            disabled={entries.length === 0}
          />
          {/* Disabled while anything else is reading, because the count *is* a reading: it walks the
              same listing with the same command, and two walks sharing one bar and one stop flag is
              one bar counting two things. */}
          <ToolbarButton
            icon={Sigma}
            label={t("remote.objStats")}
            onClick={() => void countHere()}
            disabled={rows === null || reading || busy || !!working}
          />
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
          <ToolbarButton
            icon={RefreshCw}
            label={t("remote.refresh")}
            onClick={() => void load(path, search)}
            // Also while a long job runs: a re-read bumps the listing token, and the loop would
            // carry on against a folder the grid has stopped showing.
            disabled={reading || busy || !!working}
          />
        </div>
      </div>

      {/* The search is a *prefix*, and saying so is the whole honesty of it: it matches the start of
          a name because that is the only thing the service can answer without reading the container
          from end to end. */}
      {showSearch && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1">
          <Search size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          <input
            autoFocus
            value={searchDraft}
            spellCheck={false}
            placeholder={t("remote.objSearchHint")}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setSearch(searchDraft.trim());
                void load(path, searchDraft.trim());
              }
              if (e.key === "Escape") {
                setSearchDraft("");
                setSearch("");
                void load(path, "");
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-0.5 font-mono text-[11px] outline-none placeholder:text-[var(--cf-text-muted)]"
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearchDraft("");
                setSearch("");
                void load(path, "");
              }}
              className="flex shrink-0 items-center gap-1 rounded bg-[var(--cf-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--cf-accent)]"
            >
              {search}
              <X size={9} />
            </button>
          )}
        </div>
      )}

      {/* A delete of forty blobs, a paste of a folder's worth, a selection uploaded or downloaded, a
          count that walks the container to its end — the loops in this panel long enough to need a way
          out. Above the grid rather than below it, where `TransferBar` sits: during a bulk transfer both
          are up, and the one that says which file of how many belongs beside the listing it is working
          through. */}
      {working && (
        <WorkBar
          label={working.label}
          done={working.done}
          total={working.total}
          onStop={() => {
            stopped.current = true;
          }}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {/* One `cf-rise` on the box the grid lives in rather than one per row: a windowed row
            re-mounts every time it scrolls back into the window, and a per-row entrance would
            re-animate mid-scroll. */}
        <div className="cf-rise min-h-0 min-w-0 flex-1 overflow-hidden">
          {error ? (
            // Inside the grid area, not over the whole panel: the breadcrumb and Refresh are how
            // anyone gets out of a failed listing, and an error that replaced them left the panel
            // with nothing to press but the sidebar.
            <EmptyState icon={Server} title={t("remote.objListFailed")} subtitle={error} />
          ) : rows === null ? (
            <EmptyState icon={Folder} title={t("remote.loading")} subtitle={path} />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={Folder}
              title={search ? t("remote.objNoMatch", { prefix: search }) : t("remote.objNothingHere")}
              subtitle={search ? undefined : t("remote.objNothingHereHint")}
            />
          ) : (
            <DataGrid<RemoteFile>
              resetKey={`${path}/${epoch}`}
              columns={columns}
              rows={entries}
              widths={settings.widths}
              onWidth={(key, width) =>
                updatePrefs(scope, { widths: { ...settings.widths, [key]: width } })
              }
              onAutoFit={(key) => {
                // The grid reports a key; the measurement needs the column, because what a cell says
                // is the column's answer and not the field's. Measured against every loaded row, not
                // only the ones on screen.
                const column = columns.find((candidate) => candidate.key === key);
                if (!column) return;
                updatePrefs(scope, {
                  widths: { ...settings.widths, [key]: autoFitWidth(column, rows) },
                });
              }}
              sort={sort}
              onSort={(column) =>
                setSort((current) =>
                  // asc → desc → the service's own order, which is the state a paged listing has to
                  // be able to get back to.
                  current?.column !== column
                    ? { column, descending: false }
                    : current.descending
                      ? null
                      : { column, descending: true },
                )
              }
              selected={pickedIndices}
              onSelectRow={selectRow}
              onSelectRange={selectRange}
              onSelectAll={(on) =>
                setSelected(on ? new Set(entries.map((entry) => entry.path)) : new Set())
              }
              onOpenRow={(row) => openEntry(entries[row])}
              onRowContextMenu={(row, event) => {
                const entry = entries[row];
                if (!entry) return;
                if (!pickedIndices.has(row)) selectRow(row, { range: false, toggle: false });
                setMenu({ x: event.clientX, y: event.clientY, entry });
              }}
              // The file browser's grammar: a click on a row is a pick of that row, wherever in the
              // row it landed.
              selectOnRowClick
              rowBody={(_, entry) => ({
                className: dropOn === entry.path ? "ring-1 ring-inset ring-[var(--cf-accent)]" : "",
                onPointerDown: (e) => {
                  // The gutter belongs to the selection sweep and to nothing else: a press on the
                  // row number is the start of a run, and arming the move from it would turn every
                  // sweep into a file move. The row number is the only button inside a row, which is
                  // what makes this test enough.
                  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                  press.current = { x: e.clientX, y: e.clientY, path: entry.path };
                },
                onPointerMove: (e) => {
                  const start = press.current;
                  // Only the row the press began on may become a drag. Without the path this row
                  // would start dragging *itself* the moment a press somewhere else moved over it,
                  // because a pointermove with no capture goes to whatever is under the pointer.
                  if (!start || start.path !== entry.path) return;
                  // The button has to still be down. Without this a press that ended somewhere this
                  // row never heard about leaves it armed, and the next *hover* across it starts a
                  // drag of whatever was clicked before — which reads as the app moving a file
                  // nobody asked it to.
                  if (e.buttons === 0) {
                    press.current = null;
                    return;
                  }
                  if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
                  press.current = null;
                  setDragCursor(true);
                  setDragging(entry);
                },
                // One handler for both halves of a release: it disarms the press that would
                // otherwise leave this row able to start a drag on a later hover, and it *is* the
                // drop when a drag is in flight.
                onPointerUp: () => {
                  press.current = null;
                  if (dragging && entry.is_dir) void moveInto(dragging, entry);
                  setDragging(null);
                  setDropOn(null);
                },
                onPointerCancel: () => {
                  press.current = null;
                },
                onPointerEnter: () =>
                  setDropOn(
                    dragging && entry.is_dir && dragging.path !== entry.path ? entry.path : null,
                  ),
              })}
            />
          )}
        </div>

        {drawer && (
          <DetailDrawer
            hostId={hostId}
            drawer={drawer}
            language={language}
            onClose={() => setDrawer(null)}
            onChanged={() => void load(path, search)}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-1 text-[11px] text-[var(--cf-text-muted)]">
        <span className="tabular-nums">
          {/* "so far", not "of": the service never says how many there are, and a total this cannot
              know is a total that would have to be invented. */}
          {t("remote.objShowing", { count: entries.length })}
          {next ? ` ${t("remote.objMoreAfter")}` : ""}
        </span>
        {picked.length > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums text-[var(--cf-accent)]">
              {t("remote.objSelected", {
                count: picked.length,
                size: formatSize(picked.reduce((sum, entry) => sum + entry.size, 0)),
              })}
            </span>
          </>
        )}
        {clipboard.length > 0 && (
          <>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-1">
              <Copy size={10} />
              {clipboard.length}
            </span>
          </>
        )}
        {/* Only over the listing it was counted from — the same folder *and* the same prefix. A number
            that stayed put while the rows under it changed would be the status bar asserting something
            it has no reason to believe any more. */}
        {stats && stats.path === normalize(path) && stats.prefix === search && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums" title={t("remote.objStatsHint")}>
              {t(stats.partial ? "remote.objStatsPartial" : "remote.objStatsLine", {
                n: stats.count,
                size: formatSize(stats.bytes),
              })}
            </span>
          </>
        )}
        {/* Here rather than as a last row in the table: a control inside the grid body scrolls with
            the rows and is a row-shaped thing that is not a row. */}
        {next && (
          <button
            type="button"
            onClick={() => void loadMore()}
            // Also while the listing is being re-read: see `loadMore` for what a continuation of a
            // listing that is being replaced under it appends.
            disabled={loadingMore || reading}
            className="ml-auto shrink-0 rounded px-1 text-[var(--cf-accent)] underline-offset-2 hover:underline disabled:opacity-40"
          >
            {t("remote.objLoadMore")}
          </button>
        )}
      </div>

      {progress && <TransferBar progress={progress} />}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={menu.entry.name}
          items={rowMenu(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}

      {customizing && (
        <ColumnsModal
          columns={modalColumns.map((column) => ({ key: column.key, label: column.label }))}
          // The columns nothing filled are drawn unchecked, which is both true and the affordance:
          // checking one is how you pin a column the service left empty in this listing.
          hidden={
            new Set([
              ...settings.hidden,
              ...declared
                .filter((column) => !allColumns.includes(column))
                .map((column) => column.key),
            ])
          }
          onApply={(order, hidden) => {
            // A declared column that nothing filled, left checked, is a column the user asked for by
            // hand — which is what `extra` means for a listing whose fields are fixed. Reset
            // (`order === null`) drops them and puts the column list back on the data.
            const extra = order
              ? order.filter((key) => !filled.has(key) && !hidden.has(key))
              : [];
            const shown = new Set([...filled, ...extra]);
            updatePrefs(scope, {
              order,
              // Only what the user could actually see. The unfilled columns arrive here inside
              // `hidden` because that is how the modal drew them, and storing that would keep Tier
              // off a folder that turns out to have tiers two pages later.
              hidden: new Set([...hidden].filter((key) => shown.has(key))),
              extra,
            });
          }}
          onClose={() => setCustomizing(false)}
          // No add-a-column field: `RemoteFile` has the fields it has, so a name typed there could
          // never hold a value. See `modalColumns` for what takes its place.
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * One column of an object listing, plus the two things a `GridColumn` has no opinion about.
 *
 * `filled` is the whole reason this panel draws three columns over a container list and seven inside
 * a blob folder without a second table of column sets: the declared list is the same everywhere, and
 * what differs is which of them a listing put anything in. It is a `RemoteFile` question, not an
 * Azure one — an S3 listing fills none of the four cloud fields and gets Name/Size/Modified for
 * exactly the same reason a share does.
 */
type FileColumn = GridColumn<RemoteFile> & {
  /** Did *this* row put something in the column. Unioned across pages by `fillsOf`. */
  filled: (row: RemoteFile) => boolean;
  /**
   * What the column sorts on, where that is not the text it draws.
   *
   * Size and Modified are the two that need it, and they need it badly: sorted on their text, `900 B`
   * comes after `1.2 MB` and a localised `12 Aug 2026` sorts under `1 Dec 2025`. The text stays the
   * one definition of what the cell *says* — the hover, the auto-fit and any export read it — and
   * this is the one definition of what it *means*.
   */
  sortOn?: (row: RemoteFile) => string | number;
};

/**
 * Every column an object listing can have, in the order it is drawn.
 *
 * **The three universal ones first, the service-specific ones after**, which moves Blob type and
 * Tier from where they used to sit (in front of Size) on purpose: the same three columns were
 * landing in different places on the blob page and the files page, so the eye had to re-learn the
 * table per service.
 *
 * Only Name is drawn in the text colour. Everything else is metadata *about* the thing the row is,
 * and drawing it at the same weight as the name is how a listing turns into a wall of equal words —
 * the same hierarchy the old table had, kept.
 */
function fileColumns(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  rootIcon: LucideIcon | null,
  language: string,
): FileColumn[] {
  const META = "text-[var(--cf-text-muted)]";
  return [
    {
      key: "name",
      label: t("remote.objColName"),
      text: (row) => row.name,
      cell: (row) => {
        // Capitalised so JSX reads it as a component rather than as an element name.
        const Glyph = rootIcon ?? (row.is_dir ? Folder : FileIcon);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Glyph
              size={13}
              className={`shrink-0 ${
                rootIcon || row.is_dir ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
              }`}
            />
            <span className="min-w-0 truncate">{row.name}</span>
          </span>
        );
      },
      // The path, not the name: the name is already on screen, and the hover is the only place the
      // rest of it — the container it is in, the prefixes above it — can be read.
      title: (row) => row.path,
      filled: () => true,
    },
    {
      key: "size",
      label: t("remote.objColSize"),
      // Blank for a folder rather than `0 B`: a prefix has no size, and a container's size is a
      // question the service will not answer at all.
      text: (row) => (row.is_dir ? "" : formatSize(row.size)),
      sortOn: (row) => row.size,
      align: "right",
      cellClass: () => META,
      filled: (row) => !row.is_dir,
    },
    {
      key: "modified",
      label: t("remote.objColModified"),
      text: (row) => formatWhen(row.modified, language),
      sortOn: (row) => row.modified,
      cellClass: () => META,
      filled: (row) => row.modified > 0,
    },
    {
      key: "content_type",
      label: t("remote.objColType"),
      text: (row) => row.content_type,
      // A MIME type is a literal the user may want to compare character by character.
      mono: true,
      cellClass: () => META,
      filled: (row) => row.content_type !== "",
    },
    {
      key: "blob_type",
      label: t("remote.objColBlobType"),
      text: (row) => row.blob_type,
      cellClass: () => META,
      filled: (row) => row.blob_type !== "",
    },
    {
      key: "tier",
      label: t("remote.objColTier"),
      text: (row) => row.tier,
      cellClass: () => META,
      filled: (row) => row.tier !== "",
    },
    {
      key: "lease_state",
      label: t("remote.objColLease"),
      text: (row) => row.lease_state,
      // The one value worth colouring: a leased blob refuses every write with a 412 that names no
      // lease, so this is the only warning there is before trying.
      cellClass: (row) =>
        row.lease_state && row.lease_state !== "available" ? "text-[var(--cf-danger)]" : META,
      filled: (row) => row.lease_state !== "",
    },
  ];
}

/**
 * Which declared columns this page of rows filled.
 *
 * One pass with an early exit, and it matters: this used to be four `entries.some()` scans of the
 * whole listing on every render — including the renders a hover or a drag causes — where a listing
 * can be five thousand blobs long.
 */
function fillsOf(columns: FileColumn[], entries: RemoteFile[]): Set<string> {
  const found = new Set<string>();
  for (const entry of entries) {
    for (const column of columns) {
      if (!found.has(column.key) && column.filled(entry)) found.add(column.key);
    }
    if (found.size === columns.length) break;
  }
  return found;
}

/** `current ∪ extra`, and `current` itself when `extra` adds nothing — an identical set as a new
 *  object is a re-render of the grid for no change. */
function union(current: Set<string>, extra: Set<string>): Set<string> {
  for (const key of extra) if (!current.has(key)) return new Set([...current, ...extra]);
  return current;
}

/** What a column is compared on: its own numeric truth where it has one, its text otherwise. */
function sortValue(column: FileColumn, row: RemoteFile): string | number {
  return column.sortOn ? column.sortOn(row) : (column.text(row) ?? "");
}

/**
 * The right-hand drawer: what this thing *is*, or what it used to be.
 *
 * Both views are per-entry and both need a request of their own, so they are one component with two
 * bodies rather than two panels competing for the same edge of the window.
 */
function DetailDrawer({
  hostId,
  drawer,
  language,
  onClose,
  onChanged,
}: {
  hostId: string;
  drawer: NonNullable<Drawer>;
  language: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [properties, setProperties] = useState<BlobProperties | null>(null);
  const [snapshots, setSnapshots] = useState<BlobSnapshot[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const path = drawer.entry.path;
  const kind = drawer.kind;

  const reload = useCallback(async () => {
    setFailure(null);
    try {
      if (kind === "properties") {
        setProperties(await remoteBlobProperties(hostId, path));
      } else {
        setSnapshots(await remoteBlobSnapshots(hostId, path));
      }
    } catch (error) {
      setFailure(String(error));
    }
  }, [hostId, path, kind]);

  useEffect(() => {
    setProperties(null);
    setSnapshots(null);
    void reload();
  }, [reload]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
      await reload();
      onChanged();
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-[var(--cf-border)]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        {kind === "properties" ? <Info size={12} /> : <Camera size={12} />}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{drawer.entry.name}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <X size={12} />
        </button>
      </div>

      {failure ? (
        <p className="whitespace-pre-wrap p-3 text-[11px] leading-relaxed text-[var(--cf-danger)]">{failure}</p>
      ) : kind === "properties" ? (
        properties === null ? (
          <Loader2 size={14} className="m-4 animate-spin self-center text-[var(--cf-text-muted)]" />
        ) : (
          <div className="p-2">
            <p className="break-all pb-2 font-mono text-[10px] text-[var(--cf-text-muted)]">{properties.url}</p>
            {properties.rows.map(([name, value]) => (
              <div key={name} className="border-t border-[var(--cf-border)] py-1">
                <span className="block text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">{name}</span>
                <span className="block break-all font-mono text-[11px] text-[var(--cf-text)]">{value}</span>
              </div>
            ))}
          </div>
        )
      ) : snapshots === null ? (
        <Loader2 size={14} className="m-4 animate-spin self-center text-[var(--cf-text-muted)]" />
      ) : snapshots.length === 0 ? (
        <p className="p-3 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("remote.objNoSnapshots")}</p>
      ) : (
        <div className="p-2">
          {snapshots.map((snapshot) => (
            <div key={snapshot.stamp} className="border-t border-[var(--cf-border)] py-1.5">
              <span className="block font-mono text-[10px] text-[var(--cf-text)]">
                {formatWhen(snapshot.modified, language) || snapshot.stamp}
              </span>
              <span className="block text-[10px] text-[var(--cf-text-muted)]">{formatSize(snapshot.size)}</span>
              <div className="flex gap-1 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      // Confirmed because it overwrites the live blob with an older copy, and the
                      // copy it replaces is only recoverable if somebody thought to snapshot it.
                      if (!(await confirmAction(t("remote.objConfirmRestore")))) return;
                      await remoteBlobRestoreSnapshot(hostId, path, snapshot.stamp);
                    })
                  }
                  className="flex items-center gap-1 rounded border border-[var(--cf-border)] px-1.5 py-0.5 text-[10px] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-40"
                >
                  <RotateCcw size={9} />
                  {t("remote.objRestore")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await remoteBlobDeleteSnapshot(hostId, path, snapshot.stamp);
                    })
                  }
                  className="flex items-center gap-1 rounded border border-[var(--cf-border)] px-1.5 py-0.5 text-[10px] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)] disabled:opacity-40"
                >
                  <Trash2 size={9} />
                  {t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/**
 * Where you are, one clickable segment at a time.
 *
 * Everything at or above `root` collapses into the first crumb: the service is not a folder the
 * user chose to be in, it is the page they opened, and a crumb that navigated above it would land
 * the browser somewhere this panel has no rail entry for.
 */
function Breadcrumb({
  path,
  root,
  title,
  onGo,
}: {
  path: string;
  root: string;
  title: string;
  onGo: (path: string) => void;
}) {
  const base = normalize(root);
  const inner = normalize(path).slice(base.length).split("/").filter(Boolean);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5 text-[12px]">
      <button
        type="button"
        onClick={() => onGo(root)}
        className="shrink-0 rounded px-1 py-0.5 font-medium text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      >
        {title}
      </button>
      {inner.map((segment, at) => (
        <span key={`${segment}-${at}`} className="flex min-w-0 items-center">
          <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          <button
            type="button"
            onClick={() => onGo(`${base}/${inner.slice(0, at + 1).join("/")}`)}
            className="min-w-0 truncate rounded px-1 py-0.5 font-mono text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
          >
            {segment}
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * What a top-level resource looks like, since neither of them is a folder.
 *
 * A container gets the box the create button already uses, so the thing you make and the thing you
 * see are the same shape. A share gets a drive: it is quota'd storage you mount, which is how
 * anybody who has used one thinks about it.
 */
const ROOT_ICON: Record<RootChild, LucideIcon> = {
  container: Package,
  share: HardDrive,
  bucket: Package,
};

/**
 * Whether the root will accept a new one.
 *
 * A container and a share are made with a name and nothing else. A bucket takes a region and an
 * access policy — decisions with cost and blast radius that belong in the AWS console, not behind a
 * one-field prompt. See `s3::make_dir`, which refuses for the same reason.
 */
const ROOT_CREATABLE: Record<RootChild, boolean> = {
  container: true,
  share: true,
  bucket: false,
};

/**
 * What the create button says, per thing it is about to create.
 *
 * Whole strings rather than a noun interpolated into "New {x}": the article and the agreement move
 * with the noun in most of the languages this app is translated into, and a sentence assembled from
 * parts is a sentence no translator can fix.
 */
const NEW_LABEL: Record<"folder" | RootChild, TranslationKey> = {
  folder: "remote.objNewFolder",
  container: "remote.objNewContainer",
  share: "remote.objNewShare",
  bucket: "remote.objNewBucket",
};

const NEW_PROMPT: Record<"folder" | RootChild, TranslationKey> = {
  folder: "remote.objNewFolderPrompt",
  container: "remote.objNewContainerPrompt",
  share: "remote.objNewSharePrompt",
  bucket: "remote.objNewBucketPrompt",
};

/** Which sentence the typed confirmation asks. Each names the thing by its own word, because
 *  "container" in front of somebody looking at a bucket is a dialog they will not read. */
const CONFIRM_DELETE: Record<RootChild, TranslationKey> = {
  container: "remote.objConfirmContainer",
  share: "remote.objConfirmShare",
  bucket: "remote.objConfirmBucket",
};

/**
 * Azure's rule for a container or a share name, which is also the rule for an S3 bucket: 3 to 63
 * characters, lowercase alphanumerics and single hyphens, starting and ending on an alphanumeric.
 *
 * The lookahead is what forbids `--` and a trailing `-` in one pass. A folder gets none of this —
 * it is a prefix, and a prefix is whatever bytes you put in front of a key.
 */
const TOP_LEVEL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/;

/**
 * The three names the rule above is wrong about.
 *
 * `$web` holds a static website and `$root` is the container a blob at the account's bare root lives
 * in — both are things a person creates on purpose, and both break every clause of the rule. A check
 * that blocks a valid action is worse than the opaque error it was written to replace.
 */
const RESERVED_NAMES = new Set(["$root", "$web", "$logs"]);

function namesATopLevel(name: string): boolean {
  return RESERVED_NAMES.has(name) || TOP_LEVEL_NAME.test(name);
}

/** `/blob/photos/` and `/blob/photos` are the same directory; the browser compares them as strings. */
function normalize(path: string): string {
  return path.replace(/\/+$/, "");
}

/** The Up button, and a typed path, stop at the page's own root rather than climbing the account. */
function clampToRoot(candidate: string, root: string): string {
  const base = normalize(root);
  if (!base) return candidate;
  return normalize(candidate).startsWith(base) ? candidate : root;
}

/** Local paths use whichever separator the picker handed back, so this works on both platforms. */
function joinLocal(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The last segment of a remote path, which is always `/`-separated. */
function leafOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

