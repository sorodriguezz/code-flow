import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { useRemoteStore } from "../../state/remoteStore";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { onRemoteTransfer, type RemoteTransferEvent } from "../../lib/tauri/events";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import {
  remoteDownloadFile,
  remoteListFiles,
  remoteListLocalFiles,
  remoteMakeDir,
  remoteRemoveFile,
  remoteRenameFile,
  remoteUploadFile,
} from "../../lib/tauri/remoteCommands";
import type { RemoteFile, RemoteListing } from "../../types/remote";
import { riseDelay } from "../../lib/rise";

/**
 * Files, both sides at once.
 *
 * **Two panes rather than one.** A single browser with a "switch to local" toggle is smaller to
 * build and worse to use: a transfer is a statement about *two* places, and you cannot check you are
 * putting the file in the right directory if only one of them is on screen. This is why every FTP
 * client that has survived looks like this.
 *
 * Both halves render from one shape and one component — see `sftp::list_local` for why the backend
 * hands local entries back in the remote entry's clothing. The permission string under each name is
 * the detail worth keeping from Termius: it is the answer to "why did that upload fail", and it
 * costs a line that was empty anyway.
 *
 * **The transfer buttons are the middle column.** Direction is chosen by which way the arrow points,
 * not by which pane you started in — which means the same click means the same thing regardless of
 * where the selection happens to be.
 */
export interface SftpPanelProps {
  hostId: string;
  /**
   * Where the remote pane opens, and what its Home button goes back to. Empty means the far side
   * decides — the login directory over SFTP, the bucket list on S3.
   *
   * It exists for the Azure account panel, whose Blob and Files pages are the same browser pointed
   * at `/blob` and `/files`: the service is the first segment of the path (see
   * `remotes::cloud::account`), so "which service" and "which directory" are one question and one
   * component answers both.
   */
  root?: string;
  /** What the remote pane calls itself. Defaults to the host's name. */
  title?: string;
}

export function SftpPanel({ hostId, root = "", title }: SftpPanelProps) {
  const width = useLayoutStore((s) => s.sizes.remoteSftpLocalWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const host = useRemoteStore((s) => s.hosts.find((entry) => entry.id === hostId) ?? null);
  const t = useT();

  const [local, setLocal] = useState<RemoteListing | null>(null);
  const [remote, setRemote] = useState<RemoteListing | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [localPick, setLocalPick] = useState<RemoteFile | null>(null);
  const [remotePick, setRemotePick] = useState<RemoteFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RemoteTransferEvent | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  /** Identifies this pane's transfer, so a late event from a previous one is ignored rather than
   *  jerking the bar backwards.
   *
   *  Prefixed with a per-instance id, because two of these panels can be alive at once: the Azure
   *  account panel keeps Blob and Files mounted side by side, and a counter that restarted at zero
   *  in each would have both bars move for one transfer. */
  const transferId = useRef(0);
  const paneId = useId();
  /**
   * The entry being dragged and which side it came from.
   *
   * Pointer-driven, like every other drag in this app — Tauri's webview swallows HTML5 `dragstart`
   * entirely (see `lib/pointerDrag`). Held as state rather than a ref because the target pane
   * highlights while it is set.
   */
  const [dragging, setDragging] = useState<{ side: "local" | "remote"; entry: RemoteFile } | null>(
    null,
  );
  const [dropSide, setDropSide] = useState<"local" | "remote" | null>(null);

  // A release anywhere ends it, including over chrome that is not a drop target.
  useEffect(() => {
    const cancel = () => {
      setDragging(null);
      setDropSide(null);
      setDragCursor(false);
    };
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onRemoteTransfer((event) => {
      if (event.id === `${paneId}-${transferId.current}`) setProgress(event);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const loadLocal = useCallback(async (path: string) => {
    try {
      const listing = await remoteListLocalFiles(path);
      setLocal(listing);
      setLocalPath(listing.path);
      setLocalPick(null);
    } catch (error) {
      pushErrorToast(String(error));
    }
  }, []);

  const loadRemote = useCallback(
    async (path: string) => {
      try {
        const listing = await remoteListFiles(hostId, path);
        setRemote(listing);
        setRemotePath(listing.path);
        setRemotePick(null);
        setRemoteError(null);
      } catch (error) {
        // Kept in the pane rather than thrown as a toast: an SFTP failure is almost always about
        // *this host* — a key with a passphrase the agent doesn't have, a server with the subsystem
        // disabled — and the message belongs where the user is looking, next to a Retry.
        setRemoteError(String(error));
      }
    },
    [hostId],
  );

  useEffect(() => {
    void loadLocal("");
    void loadRemote(root);
  }, [loadLocal, loadRemote, root]);

  /**
   * Moves `pick` in `direction`. Directories included — the backend walks them.
   *
   * Takes the entry rather than reading the selection, so a drop can transfer what was dragged
   * even when it is not what is selected.
   */
  const transfer = async (direction: "up" | "down", pick: RemoteFile | null) => {
    if (!pick || busy) return;
    const id = `${paneId}-${++transferId.current}`;
    setBusy(true);
    setProgress(null);
    try {
      if (direction === "up") {
        await remoteUploadFile(id, hostId, pick.path, joinRemote(remotePath, pick.name));
        await loadRemote(remotePath);
      } else {
        await remoteDownloadFile(id, hostId, pick.path, joinLocal(localPath, pick.name));
        await loadLocal(localPath);
      }
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  if (!host) return <EmptyState icon={Server} title={t("remote.hostGone")} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
      <div style={{ width }} className="flex min-w-0 shrink-0 flex-col">
        <FilePane
          icon={HardDrive}
          title={t("remote.sftpLocal")}
          listing={local}
          selected={localPick}
          onSelect={setLocalPick}
          onOpen={(entry) => void loadLocal(entry.path)}
          onUp={() => void loadLocal(parentLocal(localPath))}
          onRefresh={() => void loadLocal(localPath)}
          onDragStart={(entry) => setDragging({ side: "local", entry })}
          // Only the *other* side is a drop target: dropping a file back where it came from is a
          // copy onto itself, and the backend would truncate it before reading it.
          dropTarget={dragging?.side === "remote"}
          dropActive={dropSide === "local"}
          onDragOver={() => dragging?.side === "remote" && setDropSide("local")}
          onDrop={() => {
            if (dragging?.side === "remote") void transfer("down", dragging.entry);
            setDragging(null);
            setDropSide(null);
          }}
        />
      </div>

      <ResizeHandle
        axis="x"
        value={width}
        min={240}
        max={900}
        onChange={(value) => setSize("remoteSftpLocalWidth", value)}
        onCommit={(value) => void commitSize("remoteSftpLocalWidth", value)}
      />

      <div className="flex shrink-0 flex-col items-center justify-center gap-2 px-1">
        <TransferButton
          icon={ArrowRight}
          label={t("remote.sftpUpload")}
          disabled={!localPick || busy}
          onClick={() => void transfer("up", localPick)}
        />
        <TransferButton
          icon={ArrowLeft}
          label={t("remote.sftpDownload")}
          disabled={!remotePick || busy}
          onClick={() => void transfer("down", remotePick)}
        />
        {busy && <Loader2 size={12} className="animate-spin text-[var(--cf-text-muted)]" />}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {remoteError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Server size={24} className="text-[var(--cf-danger)]" />
            <p className="max-w-md whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
              {remoteError}
            </p>
            <button
              type="button"
              onClick={() => void loadRemote(root)}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <RefreshCw size={13} />
              {t("remote.retry")}
            </button>
          </div>
        ) : (
          <FilePane
            icon={Server}
            title={title ?? host.name}
            listing={remote}
            selected={remotePick}
            onSelect={setRemotePick}
            onOpen={(entry) => void loadRemote(entry.path)}
            onUp={() => void loadRemote(parentRemote(remotePath))}
            onRefresh={() => void loadRemote(remotePath)}
            onDragStart={(entry) => setDragging({ side: "remote", entry })}
            dropTarget={dragging?.side === "local"}
            dropActive={dropSide === "remote"}
            onDragOver={() => dragging?.side === "local" && setDropSide("remote")}
            onDrop={() => {
              if (dragging?.side === "local") void transfer("up", dragging.entry);
              setDragging(null);
              setDropSide(null);
            }}
            onMakeDir={async (name) => {
              try {
                await remoteMakeDir(hostId, joinRemote(remotePath, name));
                await loadRemote(remotePath);
              } catch (error) {
                pushErrorToast(String(error));
              }
            }}
            onRename={async (entry, name) => {
              try {
                // Renaming *is* moving in SFTP, so the destination is built from the directory the
                // pane is in rather than from the entry's own path — which is what makes a name
                // with a `/` in it fail loudly instead of silently relocating the file.
                await remoteRenameFile(hostId, entry.path, joinRemote(remotePath, name));
                await loadRemote(remotePath);
              } catch (error) {
                pushErrorToast(String(error));
              }
            }}
            onDelete={async (entry) => {
              if (!(await confirmAction(t("remote.sftpConfirmDelete", { name: entry.name }))))
                return;
              try {
                await remoteRemoveFile(hostId, entry.path, entry.is_dir);
                await loadRemote(remotePath);
              } catch (error) {
                pushErrorToast(String(error));
              }
            }}
          />
        )}
      </div>
      </div>

      {progress && <TransferBar progress={progress} />}
    </div>
  );
}

/**
 * One bar for the whole transfer.
 *
 * The count is only shown for more than one file: on a single file "1 of 1" is noise, and on a
 * folder it is the only thing that says how much is left to start.
 */
function TransferBar({ progress }: { progress: RemoteTransferEvent }) {
  const percent = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  return (
    <div className="shrink-0 border-t border-[var(--cf-border)] px-3 py-1.5">
      <div className="flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
        <span className="min-w-0 flex-1 truncate font-mono">{progress.name}</span>
        {progress.files > 1 && (
          <span className="shrink-0 tabular-nums">
            {progress.file_index}/{progress.files}
          </span>
        )}
        <span className="shrink-0 tabular-nums">{Math.round(percent)}%</span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
        <div
          className="h-full rounded-full bg-[var(--cf-accent)] transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function TransferButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof ArrowRight;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-30 disabled:hover:border-[var(--cf-border)] disabled:hover:text-[var(--cf-text-muted)]"
    >
      <Icon size={14} />
    </button>
  );
}

function FilePane({
  icon: Icon,
  title,
  listing,
  selected,
  onSelect,
  onOpen,
  onUp,
  onRefresh,
  onMakeDir,
  onDelete,
  onRename,
  onDragStart,
  dropTarget,
  dropActive,
  onDragOver,
  onDrop,
}: {
  icon: typeof Server;
  title: string;
  listing: RemoteListing | null;
  selected: RemoteFile | null;
  onSelect: (entry: RemoteFile) => void;
  onOpen: (entry: RemoteFile) => void;
  onUp: () => void;
  onRefresh: () => void;
  /** Only the remote side offers these — the local one has Finder/Explorer, which is better at it. */
  onMakeDir?: (name: string) => void;
  onDelete?: (entry: RemoteFile) => void;
  onRename?: (entry: RemoteFile, name: string) => void;
  onDragStart: (entry: RemoteFile) => void;
  /** Whether a drag is in flight *from the other pane*. */
  dropTarget: boolean;
  dropActive: boolean;
  onDragOver: () => void;
  onDrop: () => void;
}) {
  const t = useT();
  const press = useRef<{ x: number; y: number; entry: RemoteFile } | null>(null);

  return (
    <div
      onPointerEnter={onDragOver}
      onPointerUp={onDrop}
      className={`flex h-full min-h-0 flex-col ${
        dropActive ? "ring-1 ring-inset ring-[var(--cf-accent)]" : ""
      } ${dropTarget && !dropActive ? "ring-1 ring-inset ring-[var(--cf-accent)]/30" : ""}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        <Icon size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="shrink-0 text-[12px] font-medium text-[var(--cf-text)]">{title}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-[var(--cf-text-muted)]">
          {listing?.path ?? ""}
        </span>
        <button
          type="button"
          onClick={onUp}
          title={t("remote.sftpUp")}
          aria-label={t("remote.sftpUp")}
          className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <ChevronRight size={13} className="-rotate-90" />
        </button>
        {onMakeDir && (
          <button
            type="button"
            onClick={() => {
              const name = window.prompt(t("remote.sftpNewFolder"));
              if (name?.trim()) onMakeDir(name.trim());
            }}
            title={t("remote.sftpNewFolder")}
            aria-label={t("remote.sftpNewFolder")}
            className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <FolderPlus size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          title={t("remote.refresh")}
          aria-label={t("remote.refresh")}
          className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {listing === null ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={16} className="animate-spin text-[var(--cf-text-muted)]" />
          </div>
        ) : listing.entries.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12px] text-[var(--cf-text-muted)]">
            {t("remote.sftpEmpty")}
          </p>
        ) : (
          listing.entries.map((entry, at) => (
            <div
              key={entry.path}
              role="button"
              tabIndex={0}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                press.current = { x: e.clientX, y: e.clientY, entry };
              }}
              onPointerMove={(e) => {
                const start = press.current;
                if (!start) return;
                // The button has to still be down. Without this, a press that ended anywhere this
                // row never heard about — over the other pane, over the toolbar, outside the
                // window — leaves the row armed, and the next *hover* across it starts a drag of
                // whatever was clicked before. That is not a hypothetical: it left the grabbing
                // cursor stuck on, ate the second click of a double-click so folders wouldn't
                // open, and turned a plain click on the far pane into a real transfer.
                if (e.buttons === 0) {
                  press.current = null;
                  return;
                }
                if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
                press.current = null;
                setDragCursor(true);
                onDragStart(start.entry);
              }}
              // Disarms with the release that ends the click, so the guard above is the backstop
              // rather than the only thing holding this together.
              onPointerUp={() => {
                press.current = null;
              }}
              onPointerCancel={() => {
                press.current = null;
              }}
              onClick={() => onSelect(entry)}
              onDoubleClick={() => entry.is_dir && onOpen(entry)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  entry.is_dir ? onOpen(entry) : onSelect(entry);
                }
              }}
              style={riseDelay(at)}
              className={`cf-rise group flex cursor-default items-center gap-2 px-2 py-1 outline-none ${
                selected?.path === entry.path
                  ? "bg-[var(--cf-accent-soft)]"
                  : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              }`}
            >
              <span className="shrink-0 text-[var(--cf-text-muted)]">
                {entry.is_link ? (
                  <Link2 size={13} />
                ) : entry.is_dir ? (
                  <Folder size={13} className="text-[var(--cf-accent)]" />
                ) : (
                  <FileIcon size={13} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-[var(--cf-text)]">{entry.name}</span>
                {/* Under the name, the way Termius does it — and it is the answer to "why did that
                    upload fail", which is otherwise a trip to the shell. */}
                <span className="block truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
                  {entry.permissions}
                </span>
              </span>
              {!entry.is_dir && (
                <span className="shrink-0 tabular-nums text-[11px] text-[var(--cf-text-muted)]">
                  {formatSize(entry.size)}
                </span>
              )}
              <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                {onRename && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const name = window.prompt(t("remote.sftpRename"), entry.name);
                      if (name?.trim() && name.trim() !== entry.name) onRename(entry, name.trim());
                    }}
                    aria-label={t("remote.sftpRename")}
                    title={t("remote.sftpRename")}
                    className="rounded p-0.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                  >
                    <Pencil size={12} />
                  </button>
                )}
                {onDelete && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(entry);
                    }}
                    aria-label={t("common.delete")}
                    title={t("common.delete")}
                    className="rounded p-0.5 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Remote paths are always `/`-separated, even when the server is Windows. */
function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** Local paths use whichever separator the listing came back with, so this works on both. */
function joinLocal(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function parentLocal(path: string): string {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = trimmed.lastIndexOf(sep);
  // On Windows the parent of `C:\x` is `C:\`, which needs the separator kept or it becomes the
  // drive-relative `C:` — a different directory entirely.
  if (cut <= 0) return sep;
  const parent = trimmed.slice(0, cut);
  return /^[a-z]:$/i.test(parent) ? `${parent}\\` : parent;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
