/**
 * The keyring's sidebar: folders, the search box, and the entry list.
 *
 * The list is flat under whichever folder is selected rather than a full tree of entries, and that
 * is on purpose: a keyring is something you *search*, not something you browse. Typing two letters
 * of a site name is how anyone finds a password, so the search box is the primary control and the
 * folders are a way to narrow it — not the other way round.
 *
 * Search matches title, account line, site and tags. **Never a secret** — those are not in memory to
 * match against, and matching against them would mean decrypting the whole vault on every keystroke.
 */

import { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileUp,
  Folder,
  FolderPlus,
  Globe,
  Paperclip,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";

import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useVaultDragStore, type VaultDrag } from "../../state/vaultDragStore";
import { useVaultModalStore } from "../../state/vaultModalStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { filterVaultItems, useVaultStore } from "../../state/vaultStore";
import type { VaultFolderRow, VaultItem, VaultItemKind } from "../../types/vault";
import { ICON_BUTTON, ROW, ROW_ACTIVE, ROW_IDLE, kindIcon } from "./vaultChrome";

/** What the "new entry" menu offers, in the order it offers it: the three everyday ones, then the
 *  three that describe a piece of infrastructure, then the two documents and the file drawer. */
const KINDS: VaultItemKind[] = [
  "login",
  "key",
  "database",
  "server",
  "storage",
  "card",
  "identity",
  "note",
  "file",
];

/** The folders as a tree, so the sidebar can indent without re-scanning the array per level. */
function tree(folders: VaultFolderRow[], parent: string | null): VaultFolderRow[] {
  return folders.filter((folder) => (folder.parent_id ?? null) === parent);
}

export function VaultExplorer() {
  const folders = useVaultStore((s) => s.folders);
  const items = useVaultStore((s) => s.items);
  const query = useVaultStore((s) => s.query);
  const folderFilter = useVaultStore((s) => s.folderFilter);
  const tagFilter = useVaultStore((s) => s.tagFilter);
  const sort = useVaultStore((s) => s.sort);
  const activeId = useVaultStore((s) => s.activeId);
  const expanded = useVaultStore((s) => s.expanded);
  const trashOpen = useVaultStore((s) => s.trashOpen);
  const t = useT();

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);

  const drag = useVaultDragStore((s) => s.drag);
  const over = useVaultDragStore((s) => s.over);
  /** A drop just happened, so the click the release also produces must not select the row.
   *
   *  A ref plus a `setTimeout(0)` rather than `preventDefault`, copying `NoteExplorer.finishDrag`:
   *  a drop that lands on a row the re-render unmounts produces no click at all, and clearing the
   *  flag on the click would then leave it armed and swallow the *next* real one. */
  const swallowClick = useRef(false);

  /** Every folder inside the one being dragged, so a folder cannot be dropped into itself. */
  const forbidden = useMemo(() => {
    if (drag?.kind !== "folder") return new Set<string>();
    const found = new Set<string>([drag.id]);
    // Repeated passes rather than recursion: the list is flat and small, and this terminates on the
    // pass that adds nothing — which is also what makes it safe on a subtree that is already cyclic.
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of folders) {
        if (folder.parent_id && found.has(folder.parent_id) && !found.has(folder.id)) {
          found.add(folder.id);
          grew = true;
        }
      }
    }
    return found;
  }, [drag, folders]);

  /** Whether this folder is a legal destination for what is being dragged. */
  const canDrop = (folderId: string | null): boolean => {
    if (!drag) return false;
    if (drag.kind === "folder") {
      if (folderId !== null && forbidden.has(folderId)) return false;
      // Dropping a folder where it already is changes nothing.
      const current = folders.find((f) => f.id === drag.id)?.parent_id ?? null;
      return current !== folderId;
    }
    return drag.fromFolderId !== folderId;
  };

  const beginPress = (event: React.PointerEvent, entry: VaultDrag) => {
    // Left button only. A right-click opens the menu, and picking the row up under it would leave
    // the tree dragging something the user never grabbed.
    if (event.button !== 0) return;
    useVaultDragStore.getState().press(entry, event.clientX, event.clientY);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = useVaultDragStore.getState();
    // A press whose release was never seen would otherwise leave `origin` armed and start a phantom
    // drag on the next pass over the tree.
    if (event.buttons === 0) {
      finishDrag();
      return;
    }
    if (!state.origin || state.drag) return;
    const travelled = Math.hypot(event.clientX - state.origin.x, event.clientY - state.origin.y);
    if (travelled < DRAG_THRESHOLD) return;
    state.begin();
    setDragCursor(true);
  };

  const finishDrag = () => {
    const state = useVaultDragStore.getState();
    // Read before `end()` clears it — see `swallowClick`.
    if (state.drag) swallowClick.current = true;
    if (state.drag || state.origin) {
      state.end();
      setDragCursor(false);
    }
    if (swallowClick.current) window.setTimeout(() => (swallowClick.current = false), 0);
  };

  /** Commits a drop onto `folderId`. Re-checked here rather than read off `over`, so the drop is
   *  decided by where the pointer actually let go. */
  const commitDrop = (folderId: string | null) => {
    const live = useVaultDragStore.getState().drag;
    if (!live || !canDrop(folderId)) return;
    const store = useVaultStore.getState();
    if (live.kind === "item") void store.moveItem(live.id, folderId);
    else void store.moveFolder(live.id, folderId);
  };

  const visible = useMemo(
    () => filterVaultItems(items, query, folderFilter, tagFilter, sort),
    [items, query, folderFilter, tagFilter, sort],
  );

  const countIn = (folderId: string) =>
    items.filter((item) => item.folder_id === folderId).length;

  const createEntry = async (kind: VaultItemKind) => {
    const store = useVaultStore.getState();
    const id = await store.createItem(kind, t(`vault.kind.${kind}`), folderFilter);
    if (!id) return;
    // Straight into the form: a new entry is empty, and landing on a read view of nothing would
    // make "Edit" a step everyone takes every time.
    await store.openItem(id);
    store.setEditing(true);
  };

  const folderMenu = (folder: VaultFolderRow, at: { x: number; y: number }): MenuItem[] => {
    const workspaces = useWorkspaceStore.getState().workspaces;
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const global = folder.workspace_id === "";
    return [
      {
        label: t("vault.renameFolder"),
        onClick: () => {
          void promptAction(t("vault.newFolderPrompt"), { initial: folder.name }).then(
            (name) => name && void useVaultStore.getState().renameFolder(folder.id, name),
          );
        },
      },
      {
        // The keyring's own version of the scope menu the other trees carry. Not the shared
        // `scopeMenuItems` helper: this one files into `""` rather than flipping a `scope` column,
        // because the vault deliberately has no foreign key to `workspaces` — see the table comment.
        label: global ? t("vault.fileHere") : t("vault.fileEverywhere"),
        icon: Globe,
        separated: true,
        onClick: () =>
          void useVaultStore
            .getState()
            .setFolderWorkspace(folder.id, global ? (activeWorkspaceId ?? "") : ""),
      },
      ...(global || workspaces.length < 2
        ? []
        : [
            {
              label: t("scope.moveToWorkspace"),
              onClick: () =>
                setMenu({
                  ...at,
                  items: workspaces
                    .filter((workspace) => workspace.id !== folder.workspace_id)
                    .map((workspace) => ({
                      label: workspace.name,
                      onClick: () =>
                        void useVaultStore
                          .getState()
                          .setFolderWorkspace(folder.id, workspace.id),
                    })),
                }),
            },
          ]),
      {
        label: t("vault.deleteFolder"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () => {
          void confirmAction(t("vault.deleteFolderConfirm", { name: folder.name }), true).then(
            (ok) => ok && void useVaultStore.getState().deleteFolder(folder.id),
          );
        },
      },
    ];
  };

  const itemMenu = (item: VaultItem, at: { x: number; y: number }): MenuItem[] => {
    const workspaces = useWorkspaceStore.getState().workspaces;
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const global = item.workspace_id === "";
    return [
      {
        label: t(item.favorite ? "vault.unpin" : "vault.pin"),
        icon: Star,
        onClick: () => void useVaultStore.getState().toggleFavorite(item.id),
      },
      {
        label: global ? t("vault.fileHere") : t("vault.fileEverywhere"),
        icon: Globe,
        separated: true,
        onClick: () =>
          void useVaultStore
            .getState()
            .setItemWorkspace(item.id, global ? (activeWorkspaceId ?? "") : ""),
      },
      ...(workspaces.length < 2
        ? []
        : [
            {
              label: t("scope.moveToWorkspace"),
              onClick: () =>
                setMenu({
                  ...at,
                  items: workspaces.map((workspace) => ({
                    label: workspace.name,
                    onClick: () =>
                      void useVaultStore.getState().setItemWorkspace(item.id, workspace.id),
                  })),
                }),
            },
          ]),
      {
        label: t("vault.delete"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () => void useVaultStore.getState().deleteItem(item.id),
      },
    ];
  };

  const renderFolders = (parent: string | null, depth: number) =>
    tree(folders, parent).map((folder) => {
      const open = expanded.includes(folder.id);
      const children = tree(folders, folder.id);
      return (
        <div key={folder.id}>
          <button
            type="button"
            style={{ paddingLeft: 8 + depth * 12 }}
            onPointerDown={(event) =>
              beginPress(event, {
                kind: "folder",
                id: folder.id,
                fromFolderId: folder.parent_id ?? null,
              })
            }
            onPointerEnter={() =>
              useVaultDragStore.getState().hover(canDrop(folder.id) ? { folderId: folder.id } : null)
            }
            onPointerUp={() => commitDrop(folder.id)}
            onClick={() => {
              if (swallowClick.current) return;
              useVaultStore.getState().setFolderFilter(folderFilter === folder.id ? null : folder.id);
              if (children.length) useVaultStore.getState().toggleFolder(folder.id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              const at = { x: event.clientX, y: event.clientY };
              setMenu({ ...at, items: folderMenu(folder, at) });
            }}
            className={`${ROW} ${
              over?.folderId === folder.id
                ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
                : drag?.id === folder.id
                  ? "opacity-40"
                  : folderFilter === folder.id
                    ? ROW_ACTIVE
                    : ROW_IDLE
            }`}
          >
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-muted)]">
              {children.length ? (
                open ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )
              ) : null}
            </span>
            <Folder
              size={13}
              className="shrink-0"
              style={folder.color ? { color: folder.color } : undefined}
            />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            {folder.workspace_id === "" && (
              <Globe size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
            )}
            <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
              {countIn(folder.id) || ""}
            </span>
          </button>
          {open && renderFolders(folder.id, depth + 1)}
        </div>
      );
    });

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      // All of it on the container rather than per row, the way `NoteExplorer` does it: the rows are
      // plain buttons with no memoisation, so a handler per row would re-render the whole sidebar on
      // every pixel of a drag.
      //
      // `onPointerLeave` is unguarded on purpose — guarding it on `drag` would leave a pending
      // `origin` armed when someone presses a row and slides out without releasing, and the next
      // move back in would measure travel from the stale origin and start a drag nobody began.
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onPointerLeave={finishDrag}
    >
      <div className="flex items-center gap-1 px-2 pb-1.5 pt-2">
        <div className="relative flex-1">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
          />
          <input
            value={query}
            onChange={(event) => useVaultStore.getState().setQuery(event.target.value)}
            placeholder={t("vault.searchPlaceholder")}
            data-tour="vault-search"
            className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] py-1 pl-7 pr-2 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
          />
        </div>
        <button
          type="button"
          title={t("vault.newFolder")}
          aria-label={t("vault.newFolder")}
          onClick={() => {
            void promptAction(t("vault.newFolderPrompt")).then(
              (name) => name && void useVaultStore.getState().createFolder(folderFilter, name),
            );
          }}
          className={ICON_BUTTON}
        >
          <FolderPlus size={13} />
        </button>
        <button
          type="button"
          title={t("vault.import.button")}
          aria-label={t("vault.import.button")}
          onClick={() => useVaultModalStore.getState().openVaultModal({ kind: "import" })}
          className={ICON_BUTTON}
          data-tour="vault-import"
        >
          <FileUp size={13} />
        </button>
        <button
          type="button"
          title={t("vault.newEntry")}
          aria-label={t("vault.newEntry")}
          onClick={(event) => setNewMenu({ x: event.clientX, y: event.clientY })}
          className={ICON_BUTTON}
          data-tour="vault-new"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {/* Also the root drop target: dropping here takes an entry out of every folder, which is a
            genuine destination rather than the absence of one. */}
        <button
          type="button"
          onPointerEnter={() =>
            useVaultDragStore.getState().hover(canDrop(null) ? { folderId: null } : null)
          }
          onPointerUp={() => commitDrop(null)}
          onClick={() => {
            if (swallowClick.current) return;
            useVaultStore.getState().setFolderFilter(null);
            useVaultStore.getState().setTrashOpen(false);
          }}
          className={`${ROW} ${
            over && over.folderId === null
              ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
              : !folderFilter && !trashOpen
                ? ROW_ACTIVE
                : ROW_IDLE
          }`}
        >
          <span className="w-3.5 shrink-0" aria-hidden />
          <Globe size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("vault.allItems")}</span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
            {items.length}
          </span>
        </button>

        {renderFolders(null, 0)}

        <button
          type="button"
          onClick={() => useVaultStore.getState().setTrashOpen(!trashOpen)}
          className={`${ROW} ${trashOpen ? ROW_ACTIVE : ROW_IDLE}`}
          data-tour="vault-trash"
        >
          <span className="w-3.5 shrink-0" aria-hidden />
          <Trash2 size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("vault.trash")}</span>
        </button>

        <div className="mt-2 border-t border-[var(--cf-border)] pt-2">
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-[11.5px] italic text-[var(--cf-text-muted)]">
              {t(query ? "vault.noMatches" : "vault.empty")}
            </p>
          ) : (
            visible.map((item) => {
              const Glyph = kindIcon(item.kind);
              return (
                <button
                  key={item.id}
                  type="button"
                  onPointerDown={(event) =>
                    beginPress(event, {
                      kind: "item",
                      id: item.id,
                      fromFolderId: item.folder_id,
                    })
                  }
                  // An entry is not a drop target — only folders and the root are — so hovering one
                  // mid-drag clears the destination rather than leaving the last folder lit.
                  onPointerEnter={() => useVaultDragStore.getState().hover(null)}
                  onClick={() => {
                    if (swallowClick.current) return;
                    void useVaultStore.getState().openItem(item.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const at = { x: event.clientX, y: event.clientY };
                    setMenu({ ...at, items: itemMenu(item, at) });
                  }}
                  className={`${ROW} ${
                    drag?.id === item.id
                      ? "opacity-40"
                      : activeId === item.id
                        ? ROW_ACTIVE
                        : ROW_IDLE
                  }`}
                >
                  <Glyph size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{item.title}</span>
                    {item.subtitle && (
                      <span className="truncate text-[10.5px] text-[var(--cf-text-muted)]">
                        {item.subtitle}
                      </span>
                    )}
                  </span>
                  {item.attachments > 0 && (
                    <Paperclip size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
                  )}
                  {item.workspace_id === "" && (
                    <Globe size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
                  )}
                  {item.favorite && (
                    <Star size={10} className="shrink-0 text-[var(--cf-accent)]" fill="currentColor" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {newMenu && (
        <ContextMenu
          x={newMenu.x}
          y={newMenu.y}
          heading={t("vault.newEntry")}
          items={KINDS.map((kind) => ({
            label: t(`vault.kind.${kind}`),
            icon: kindIcon(kind),
            onClick: () => void createEntry(kind),
          }))}
          onClose={() => setNewMenu(null)}
        />
      )}
    </div>
  );
}
