import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { tempDir } from "@tauri-apps/api/path";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  CopyCheck,
  Download,
  ExternalLink,
  File as FileIcon,
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
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { useRemoteStore } from "../../state/remoteStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { onRemoteTransfer, type RemoteTransferEvent } from "../../lib/tauri/events";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
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
import { TransferBar, formatSize, joinRemote, parentRemote } from "./remoteChrome";
import { riseDelay } from "../../lib/rise";

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

type SortKey = "name" | "size" | "modified" | "type" | "tier" | "blobType" | "lease";

/** What the side drawer is showing, if anything. */
type Drawer =
  | { kind: "properties"; entry: RemoteFile }
  | { kind: "snapshots"; entry: RemoteFile }
  | null;

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
  const [loadingMore, setLoadingMore] = useState(false);
  const [progress, setProgress] = useState<RemoteTransferEvent | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });

  /**
   * The prefix the *service* is filtering on, and the text the box currently holds.
   *
   * Two states rather than one because a keystroke must not be a request: the search is applied on
   * Enter or on the button, and until then the box is just text. A debounce would be worse — every
   * pause mid-word would be a round trip and a re-page from the beginning.
   */
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");

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

  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);

  /** Copied paths, waiting for a paste. Server-side, so this holds names and never bytes. */
  const [clipboard, setClipboard] = useState<string[]>([]);

  const [drawer, setDrawer] = useState<Drawer>(null);

  const [dragging, setDragging] = useState<RemoteFile | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const transferId = useRef(0);
  const paneId = useId();

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
      try {
        const listing = await remoteListFiles(hostId, target, { prefix, marker: "" });
        setRows(listing.entries);
        setNext(listing.next);
        setPath(listing.path);
        setSelected([]);
        setAnchor(null);
        setDrawer(null);
        setError(null);
      } catch (failure) {
        setError(String(failure));
      }
    },
    [hostId],
  );

  /** The next page, appended. The marker belongs to the service and is passed back untouched. */
  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const listing = await remoteListFiles(hostId, path, { prefix: search, marker: next });
      setRows((current) => [...(current ?? []), ...listing.entries]);
      setNext(listing.next);
    } catch (failure) {
      pushErrorToast(String(failure));
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

  const entries = useMemo(() => {
    const list = [...(rows ?? [])];
    const direction = sort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      // Folders first whatever the column: a folder has no size, no type and no tier, and sorted in
      // among the blobs by a field it does not have it scatters to one end.
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      switch (sort.key) {
        case "size":
          return (a.size - b.size) * direction;
        case "modified":
          return (a.modified - b.modified) * direction;
        case "type":
          return a.content_type.localeCompare(b.content_type) * direction;
        case "tier":
          return a.tier.localeCompare(b.tier) * direction;
        case "blobType":
          return a.blob_type.localeCompare(b.blob_type) * direction;
        case "lease":
          return a.lease_state.localeCompare(b.lease_state) * direction;
        default:
          return a.name.localeCompare(b.name, undefined, { numeric: true }) * direction;
      }
    });
    return list;
  }, [rows, sort]);

  // Drawn only where the service fills them. See the note at the top.
  const columns = {
    tier: entries.some((entry) => entry.tier),
    type: entries.some((entry) => entry.content_type),
    blobType: entries.some((entry) => entry.blob_type),
    lease: entries.some((entry) => entry.lease_state),
  };
  const columnCount = 3 + Object.values(columns).filter(Boolean).length;

  const picked = useMemo(
    () => entries.filter((entry) => selected.includes(entry.path)),
    [entries, selected],
  );

  const atRoot = normalize(path) === normalize(root);
  const creating: "folder" | RootChild = atRoot && rootChild ? rootChild : "folder";
  const rootIcon = atRoot && rootChild ? ROOT_ICON[rootChild] : null;

  const select = (index: number, entry: RemoteFile, event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey) {
      setSelected((current) =>
        current.includes(entry.path)
          ? current.filter((one) => one !== entry.path)
          : [...current, entry.path],
      );
      setAnchor(index);
      return;
    }
    if (event.shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      setSelected(entries.slice(from, to + 1).map((one) => one.path));
      return;
    }
    setSelected([entry.path]);
    setAnchor(index);
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

  const upload = async (directory: boolean) => {
    const chosen = await openDialog({
      multiple: !directory,
      directory,
      title: directory ? t("remote.objUploadFolder") : t("remote.objUploadFiles"),
    });
    const locals = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
    if (locals.length === 0) return;
    await transfer(async (id) => {
      for (const local of locals) {
        await remoteUploadFile(id, hostId, local, joinRemote(path, basename(local)));
      }
    });
  };

  const download = async () => {
    if (picked.length === 0) return;
    const chosen = await openDialog({ directory: true, title: t("remote.objDownloadTitle") });
    const target = Array.isArray(chosen) ? chosen[0] : chosen;
    if (!target) return;
    await transfer(async (id) => {
      for (const entry of picked) {
        await remoteDownloadFile(id, hostId, entry.path, joinLocal(target, entry.name));
      }
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
  const openLocally = async () => {
    const entry = picked[0];
    if (!entry || entry.is_dir) return;
    await transfer(async (id) => {
      const into = joinLocal(await tempDir(), entry.name);
      await remoteDownloadFile(id, hostId, entry.path, into);
      await openPath(into);
    });
  };

  const relocate = async (mode: "rename" | "move") => {
    if (picked.length === 0 || busy) return;
    const answer =
      mode === "rename"
        ? await promptAction(t("remote.objRename"), {
            initial: picked[0].name,
            confirmLabel: t("remote.objRenameConfirm"),
          })
        : await promptAction(t("remote.objMovePrompt"), {
            initial: path,
            confirmLabel: t("remote.objMoveConfirm"),
          });
    if (!answer) return;
    setBusy(true);
    try {
      if (mode === "rename") {
        await remoteRenameFile(hostId, picked[0].path, joinRemote(path, answer));
      } else {
        for (const entry of picked) {
          await remoteRenameFile(hostId, entry.path, joinRemote(answer, entry.name));
        }
      }
      await load(path, search);
    } catch (failure) {
      pushErrorToast(String(failure));
    } finally {
      setBusy(false);
    }
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

  /** Paste: a server-side copy of everything on the clipboard into the folder now open. */
  const paste = async () => {
    if (clipboard.length === 0 || busy) return;
    setBusy(true);
    try {
      for (const from of clipboard) {
        await remoteBlobCopy(hostId, from, joinRemote(path, leafOf(from)));
      }
      await load(path, search);
    } catch (failure) {
      pushErrorToast(String(failure));
    } finally {
      setBusy(false);
    }
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
  const remove = async () => {
    if (picked.length === 0 || busy) return;

    if (atRoot && rootChild) {
      for (const entry of picked) {
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
      await load(path, search);
      return;
    }

    const question =
      picked.length === 1
        ? t("remote.sftpConfirmDelete", { name: picked[0].name })
        : t("remote.objConfirmDeleteMany", { count: picked.length });
    if (!(await confirmAction(question))) return;
    setBusy(true);
    try {
      for (const entry of picked) {
        await remoteRemoveFile(hostId, entry.path, entry.is_dir);
      }
      await load(path, search);
    } catch (failure) {
      pushErrorToast(String(failure));
    } finally {
      setBusy(false);
    }
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

  const copyLink = async () => {
    if (picked.length === 0) return;
    const text = picked.map((entry) => linkFor?.(entry) ?? entry.path).join("\n");
    await navigator.clipboard.writeText(text);
    useToastStore.getState().pushToast(t("remote.objCopied"), "success");
  };

  const takeSnapshot = async () => {
    const entry = picked[0];
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

  if (!host) return <EmptyState icon={Server} title={t("remote.hostGone")} />;

  const one = picked.length === 1 ? picked[0] : null;
  const oneBlob = one && !one.is_dir ? one : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
        <Action icon={ArrowLeft} label={t("remote.objBack")} onClick={() => step(-1)} disabled={historyAt === 0} />
        <Action
          icon={ArrowRight}
          label={t("remote.objForward")}
          onClick={() => step(1)}
          disabled={historyAt >= history.length - 1}
        />
        <Action
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

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {busy && <Loader2 size={13} className="mr-1 animate-spin text-[var(--cf-text-muted)]" />}
          <Action icon={Upload} label={t("remote.objUploadFiles")} onClick={() => void upload(false)} disabled={busy} />
          <Action icon={FolderUp} label={t("remote.objUploadFolder")} onClick={() => void upload(true)} disabled={busy} />
          <Action
            icon={Download}
            label={t("remote.objDownload")}
            onClick={() => void download()}
            disabled={busy || picked.length === 0}
          />
          <Action
            icon={ExternalLink}
            label={t("remote.objOpen")}
            onClick={() => void openLocally()}
            disabled={busy || !oneBlob}
          />
          <Divider />
          {/* Absent rather than disabled where the service has no such request: making a bucket
              takes a region and an access policy, which is a form this browser does not have and
              should not pretend to. A button that can only ever fail is worse than no button. */}
          {(creating === "folder" || ROOT_CREATABLE[creating]) && (
            <Action
              icon={creating === "folder" ? FolderPlus : PackagePlus}
              label={t(NEW_LABEL[creating])}
              onClick={() => void makeDir()}
              disabled={busy}
            />
          )}
          <Action
            icon={CopyCheck}
            label={t("remote.objSelectAll")}
            onClick={() => setSelected(entries.map((entry) => entry.path))}
            disabled={entries.length === 0}
          />
          <Action
            icon={Copy}
            label={t("remote.objCopy")}
            onClick={() => {
              setClipboard(picked.map((entry) => entry.path));
              useToastStore.getState().pushToast(t("remote.objCopiedN", { count: picked.length }), "success");
            }}
            disabled={picked.length === 0}
          />
          <Action
            icon={ClipboardPaste}
            label={t("remote.objPaste")}
            onClick={() => void paste()}
            disabled={busy || clipboard.length === 0}
          />
          <Action
            icon={Pencil}
            label={t("remote.objRename")}
            onClick={() => void relocate("rename")}
            disabled={busy || picked.length !== 1}
          />
          <Action
            icon={FolderInput}
            label={t("remote.objMove")}
            onClick={() => void relocate("move")}
            disabled={busy || picked.length === 0}
          />
          <Action
            icon={Link2}
            label={linkFor ? t("remote.objCopyUrl") : t("remote.objCopyPath")}
            onClick={() => void copyLink()}
            disabled={picked.length === 0}
          />
          <Action
            icon={Trash2}
            label={t("common.delete")}
            onClick={() => void remove()}
            disabled={busy || picked.length === 0}
            danger
          />
          {blobFeatures && (
            <>
              <Divider />
              <Action
                icon={Camera}
                label={t("remote.objSnapshot")}
                onClick={() => void takeSnapshot()}
                disabled={busy || !oneBlob}
              />
              <Action
                icon={RotateCcw}
                label={t("remote.objSnapshots")}
                onClick={() => oneBlob && setDrawer({ kind: "snapshots", entry: oneBlob })}
                disabled={!oneBlob}
              />
              <Action
                icon={Info}
                label={t("remote.objProperties")}
                onClick={() => one && setDrawer({ kind: "properties", entry: one })}
                disabled={!one}
              />
            </>
          )}
          <Divider />
          <Action icon={RefreshCw} label={t("remote.refresh")} onClick={() => void load(path, search)} />
        </div>
      </div>

      {/* The search is a *prefix*, and saying so is the whole honesty of it: it matches the start of
          a name because that is the only thing the service can answer without reading the container
          from end to end. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1">
        <Search size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        <input
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

      <div className="flex min-h-0 flex-1">
        {error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <Server size={24} className="text-[var(--cf-danger)]" />
            <p className="max-w-md whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
              {error}
            </p>
            <button
              type="button"
              onClick={() => void load(root, "")}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <RefreshCw size={13} />
              {t("remote.retry")}
            </button>
          </div>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-[12px]">
              <thead>
                <tr className="text-left text-[11px] text-[var(--cf-text-muted)]">
                  <Header
                    label={t("remote.objColName")}
                    wide
                    active={sort.key === "name"}
                    dir={sort.dir}
                    onClick={() => setSort(nextSort("name", sort))}
                  />
                  {columns.blobType && (
                    <Header
                      label={t("remote.objColBlobType")}
                      active={sort.key === "blobType"}
                      dir={sort.dir}
                      onClick={() => setSort(nextSort("blobType", sort))}
                    />
                  )}
                  {columns.tier && (
                    <Header
                      label={t("remote.objColTier")}
                      active={sort.key === "tier"}
                      dir={sort.dir}
                      onClick={() => setSort(nextSort("tier", sort))}
                    />
                  )}
                  <Header
                    label={t("remote.objColSize")}
                    align="right"
                    active={sort.key === "size"}
                    dir={sort.dir}
                    onClick={() => setSort(nextSort("size", sort))}
                  />
                  <Header
                    label={t("remote.objColModified")}
                    active={sort.key === "modified"}
                    dir={sort.dir}
                    onClick={() => setSort(nextSort("modified", sort))}
                  />
                  {columns.type && (
                    <Header
                      label={t("remote.objColType")}
                      active={sort.key === "type"}
                      dir={sort.dir}
                      onClick={() => setSort(nextSort("type", sort))}
                    />
                  )}
                  {columns.lease && (
                    <Header
                      label={t("remote.objColLease")}
                      active={sort.key === "lease"}
                      dir={sort.dir}
                      onClick={() => setSort(nextSort("lease", sort))}
                    />
                  )}
                </tr>
              </thead>
              <tbody>
                {rows === null ? (
                  <tr>
                    <td colSpan={columnCount} className="p-8 text-center">
                      <Loader2 size={16} className="mx-auto animate-spin text-[var(--cf-text-muted)]" />
                    </td>
                  </tr>
                ) : entries.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount} className="p-8 text-center text-[var(--cf-text-muted)]">
                      {search ? t("remote.objNoMatch", { prefix: search }) : t("remote.sftpEmpty")}
                    </td>
                  </tr>
                ) : (
                  entries.map((entry, at) => (
                    <Row
                      key={entry.path}
                      entry={entry}
                      index={at}
                      language={language}
                      rootIcon={rootIcon}
                      columns={columns}
                      selected={selected.includes(entry.path)}
                      dropping={dropOn === entry.path}
                      onSelect={(event) => select(at, entry, event)}
                      onOpen={() => (entry.is_dir ? go(entry.path) : void openLocally())}
                      onDragStart={() => setDragging(entry)}
                      onDragOver={() =>
                        setDropOn(dragging && entry.is_dir && dragging.path !== entry.path ? entry.path : null)
                      }
                      onDrop={() => {
                        if (dragging && entry.is_dir) void moveInto(dragging, entry);
                        setDragging(null);
                        setDropOn(null);
                      }}
                    />
                  ))
                )}
                {next && (
                  <tr>
                    <td colSpan={columnCount} className="p-3 text-center">
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        disabled={loadingMore}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1 text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-40"
                      >
                        {loadingMore ? <Loader2 size={11} className="animate-spin" /> : <ChevronRight size={11} className="rotate-90" />}
                        {t("remote.objLoadMore")}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

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
        <span>
          {/* "so far", not "of": the service never says how many there are, and a total this cannot
              know is a total that would have to be invented. */}
          {t("remote.objShowing", { count: entries.length })}
          {next ? ` ${t("remote.objMoreAfter")}` : ""}
        </span>
        {picked.length > 0 && (
          <span className="ml-auto">
            {t("remote.objSelected", {
              count: picked.length,
              size: formatSize(picked.reduce((sum, entry) => sum + entry.size, 0)),
            })}
          </span>
        )}
        {clipboard.length > 0 && (
          <span className="flex items-center gap-1">
            <Copy size={10} />
            {clipboard.length}
          </span>
        )}
      </div>

      {progress && <TransferBar progress={progress} />}
    </div>
  );
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

function Row({
  entry,
  index,
  language,
  rootIcon,
  columns,
  selected,
  dropping,
  onSelect,
  onOpen,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  entry: RemoteFile;
  index: number;
  language: string;
  /** Overrides the folder/file glyph when the whole listing is one kind of resource. */
  rootIcon: LucideIcon | null;
  columns: { tier: boolean; type: boolean; blobType: boolean; lease: boolean };
  selected: boolean;
  dropping: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}) {
  const press = useRef<{ x: number; y: number } | null>(null);
  // Capitalised so JSX reads it as a component rather than as an element name.
  const RootIcon = rootIcon;

  return (
    <tr
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        press.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        const start = press.current;
        if (!start) return;
        // The button has to still be down. Without this a press that ended somewhere this row never
        // heard about leaves it armed, and the next *hover* across it starts a drag of whatever was
        // clicked before — which reads as the app moving a file nobody asked it to.
        if (e.buttons === 0) {
          press.current = null;
          return;
        }
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
        press.current = null;
        setDragCursor(true);
        onDragStart();
      }}
      // One handler for both halves of a release: it disarms the press that would otherwise leave
      // this row able to start a drag on a later hover, and it *is* the drop when a drag is in
      // flight.
      onPointerUp={() => {
        press.current = null;
        onDrop();
      }}
      onPointerCancel={() => {
        press.current = null;
      }}
      onPointerEnter={onDragOver}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={riseDelay(index)}
      className={`cf-rise cursor-default outline-none ${
        selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      } ${dropping ? "ring-1 ring-inset ring-[var(--cf-accent)]" : ""}`}
    >
      <td className="max-w-0 px-2 py-1">
        <span className="flex min-w-0 items-center gap-2">
          {RootIcon ? (
            <RootIcon size={13} className="shrink-0 text-[var(--cf-accent)]" />
          ) : entry.is_dir ? (
            <Folder size={13} className="shrink-0 text-[var(--cf-accent)]" />
          ) : (
            <FileIcon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
          )}
          <span className="min-w-0 truncate text-[var(--cf-text)]" title={entry.path}>
            {entry.name}
          </span>
        </span>
      </td>
      {columns.blobType && <Cell>{entry.blob_type}</Cell>}
      {columns.tier && <Cell>{entry.tier}</Cell>}
      <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-[11px] text-[var(--cf-text-muted)]">
        {entry.is_dir ? "" : formatSize(entry.size)}
      </td>
      <Cell>{formatWhen(entry.modified, language)}</Cell>
      {columns.type && (
        <td className="max-w-0 px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">
          <span className="block truncate font-mono">{entry.content_type}</span>
        </td>
      )}
      {columns.lease && (
        <td className="whitespace-nowrap px-2 py-1 text-[11px]">
          {entry.lease_state && entry.lease_state !== "available" ? (
            // The one value worth colouring: a leased blob refuses every write with a 412 that
            // names no lease, so this is the only warning there is before trying.
            <span className="text-[var(--cf-danger)]">{entry.lease_state}</span>
          ) : (
            <span className="text-[var(--cf-text-muted)]">{entry.lease_state}</span>
          )}
        </td>
      )}
    </tr>
  );
}

function Cell({ children }: { children: React.ReactNode }) {
  return (
    <td className="whitespace-nowrap px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">{children}</td>
  );
}

function Header({
  label,
  align = "left",
  wide,
  active,
  dir,
  onClick,
}: {
  label: string;
  align?: "left" | "right";
  /** The column that absorbs the leftover width. Exactly one, or the detail columns stretch and the
   *  names truncate against nothing. */
  wide?: boolean;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th
      className={`sticky top-0 z-10 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1 font-medium ${
        align === "right" ? "text-right" : "text-left"
      } ${wide ? "w-full" : "whitespace-nowrap"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-[var(--cf-text)] ${active ? "text-[var(--cf-text)]" : ""}`}
      >
        {label}
        {active && <ChevronUp size={10} className={dir === "desc" ? "rotate-180" : undefined} />}
      </button>
    </th>
  );
}

function Action({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors disabled:opacity-30 ${
        danger
          ? "hover:bg-black/[0.04] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.06]"
          : "hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
      }`}
    >
      <Icon size={14} />
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />;
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

/** Clicking the sorted column flips it; clicking another starts that one ascending. */
function nextSort(key: SortKey, current: { key: SortKey; dir: "asc" | "desc" }) {
  if (current.key !== key) return { key, dir: "asc" as const };
  return { key, dir: current.dir === "asc" ? ("desc" as const) : ("asc" as const) };
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

/** Empty for 0, which is the listing's "the server didn't say" rather than 1970. */
function formatWhen(epochSeconds: number, language: string): string {
  if (!epochSeconds) return "";
  return new Date(epochSeconds * 1000).toLocaleString(language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
