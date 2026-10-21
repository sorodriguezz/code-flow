/**
 * The workspace's architecture documents, in folders of this section's own: within each level the
 * folders by name, then the documents — pinned first, then the most recently changed. A new one is
 * an empty sheet to drag components onto, or one generated from sources; an `.arch.json` file comes
 * in through Import with its text — comments and all — kept as it is.
 *
 * Every row that can be acted on has a ⋮ (and the same menu on right-click). A document or folder is
 * filed by dragging it onto a folder, or onto the list's empty space for the top level — or with
 * «Mover a» in its menu. The drag is pointer-driven: Tauri's webview swallows HTML5 `dragstart`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Copy, FilePlus2, Folder, FolderInput, FolderPlus, GitBranch, MoreVertical, Network, Pencil, Pin, PinOff, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { parseArchText } from "../../lib/architecture/parse";
import { repoMenuItems } from "../../lib/repoMenu";
import type { TranslationKey } from "../../lib/i18n/translations";
import { diagramsReadImport } from "../../lib/tauri/diagramsCommands";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { folderSubtree, useArchitectureStore, type ArchFolder, type ArchItem } from "../../state/architectureStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast } from "../../state/toastStore";
import { iconButtonClass } from "../common/Button";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { explorerHeadClass, fieldClass, rowClass } from "../common/recipes";
import { useArchSourceDialog } from "./sources/ArchSourceDialog";
import { AiSparkles } from "../common/AiGlyph";

type Menu = { x: number; y: number; items: MenuItem[]; heading?: string; anchor?: { top: number; bottom: number; left: number; right: number; align?: "start" | "end" } };

const anchorOf = (el: Element, align: "start" | "end" = "end") => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, align };
};

type Dragged = { kind: "doc" | "folder"; id: string };
/** Where a drop lands: a folder's id, or `ROOT` for the top of the list. */
const ROOT = "";
const INDENT = 14;

export function ArchitectureExplorer() {
  const t = useT();
  const items = useArchitectureStore((s) => s.items);
  const folders = useArchitectureStore((s) => s.folders);
  const folded = useArchitectureStore((s) => s.folded);
  const activeId = useArchitectureStore((s) => s.activeId);
  const workspaceId = useArchitectureStore((s) => s.workspaceId);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<Menu & { rowKey?: string } | null>(null);
  const [drag, setDrag] = useState<{ what: Dragged; over: string | null } | null>(null);
  const pressed = useRef<{ what: Dragged; x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const searchField = useRef<HTMLInputElement>(null);
  const store = () => useArchitectureStore.getState();

  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (needle ? items.filter((i) => i.title.toLowerCase().includes(needle) || i.originPath.toLowerCase().includes(needle)) : items), [items, needle]);
  const folderName = (id: string | null) => folders.find((f) => f.id === id)?.name ?? "";

  // The drag: a press becomes one past the threshold; the target is whatever drop zone is under
  // the pointer; letting go files the row there.
  useEffect(() => {
    const target = (x: number, y: number) => {
      const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-arch-drop]");
      return zone ? (zone.dataset.archDrop ?? null) : null;
    };
    const onMove = (event: PointerEvent) => {
      const press = pressed.current;
      if (!press) return;
      if (!dragged.current) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
        dragged.current = true;
        setDragCursor(true);
      }
      setDrag({ what: press.what, over: target(event.clientX, event.clientY) });
    };
    const onUp = (event: PointerEvent) => {
      const press = pressed.current;
      pressed.current = null;
      if (!press || !dragged.current) return;
      setDragCursor(false);
      setDrag(null);
      const over = target(event.clientX, event.clientY);
      if (over === null) return;
      const into = over === ROOT ? null : over;
      if (press.what.kind === "doc") void store().moveToFolder(press.what.id, into);
      else if (press.what.id !== into) void store().moveFolder(press.what.id, into);
      // The click that follows a drag is not a click on the row.
      window.setTimeout(() => { dragged.current = false; }, 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const press = (what: Dragged) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragged.current = false;
    pressed.current = { what, x: event.clientX, y: event.clientY };
  };

  const newFolder = (parentId: string | null = null) =>
    void promptAction(t("arch.folder.newPrompt"), { confirmLabel: t("arch.folder.create") }).then((name) => name && void store().createFolder(name, parentId));

  const newMenu = (event: React.MouseEvent) =>
    setMenu({
      x: event.clientX,
      y: event.clientY,
      anchor: anchorOf(event.currentTarget),
      heading: t("arch.new"),
      items: [
        {
          label: t("arch.template.minimal"),
          icon: FilePlus2,
          onClick: () => void store().create(),
        },
        {
          label: t("arch.gen.fromSources"),
          leading: <AiSparkles size={14} />,
          onClick: () => useArchSourceDialog.getState().openAs("new"),
        },
        { label: t("arch.folder.new"), icon: FolderPlus, separated: true, onClick: () => newFolder() },
      ],
    });

  const importFile = async () => {
    const picked = await openDialog({ multiple: false, filters: [{ name: t("tabbar.architecture"), extensions: ["json", "jsonc"] }] });
    if (typeof picked !== "string") return;
    try {
      const text = await diagramsReadImport(picked);
      const parsed = parseArchText(text);
      if (!parsed.ok) {
        pushErrorToast(t("arch.importInvalid", { reason: t(`arch.parse.${parsed.error.code}` as TranslationKey) }));
        return;
      }
      const name = (picked.split(/[\\/]/).pop() ?? "").replace(/(\.arch)?\.jsonc?$/i, "");
      await store().importText(text, parsed.doc.meta?.title || name);
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  /** «Mover a»: every folder but the row's own subtree, and the top of the list. */
  const moveTargets = (current: string | null, onPick: (folderId: string | null) => void, skip?: Set<string>): MenuItem[] => {
    const depthOf = (f: ArchFolder): number => (f.parentId ? 1 + depthOf(folders.find((x) => x.id === f.parentId) ?? { ...f, parentId: null }) : 0);
    const ordered: ArchFolder[] = [];
    const walk = (parent: string | null) => folders.filter((f) => f.parentId === parent).forEach((f) => { ordered.push(f); walk(f.id); });
    walk(null);
    return [
      { label: t("arch.moveToRoot"), disabled: current === null, onClick: () => onPick(null) },
      ...ordered
        .filter((f) => !skip?.has(f.id))
        .map((f, i) => ({ label: `${"  ".repeat(depthOf(f))}${f.name}`, icon: Folder, separated: i === 0, disabled: f.id === current, onClick: () => onPick(f.id) })),
    ];
  };

  const docMenuItems = (item: ArchItem): MenuItem[] => [
    {
      label: t("arch.rename"),
      icon: Pencil,
      onClick: () =>
        void promptAction(t("arch.renamePrompt"), { initial: item.title, confirmLabel: t("arch.rename") }).then((value) => value && void store().rename(item.id, value)),
    },
    { label: t("arch.duplicate"), icon: Copy, onClick: () => void store().duplicate(item.id) },
    { label: item.pinned ? t("arch.unpin") : t("arch.pin"), icon: item.pinned ? PinOff : Pin, onClick: () => void store().setPinned(item.id, !item.pinned) },
    ...(folders.length ? [{ label: t("arch.moveTo"), icon: FolderInput, onClick: () => {}, children: moveTargets(item.folderId, (to) => void store().moveToFolder(item.id, to)) }] : []),
    ...repoMenuItems({
      workspaceId,
      originPath: item.originPath,
      own: true,
      separated: true,
      onSave: (projectId) => void store().open(item.id).then(() => store().saveToRepo(projectId)),
      onUnlink: () => void store().unlink(item.id),
    }),
    {
      label: t("arch.delete"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () => void confirmAction(t("arch.deleteConfirm", { title: item.title })).then((ok) => ok && void store().remove(item.id)),
    },
  ];

  const folderMenuItems = (folder: ArchFolder): MenuItem[] => {
    const subtree = folderSubtree(folders, folder.id);
    const inside = items.filter((i) => i.folderId && subtree.has(i.folderId)).length;
    return [
      { label: t("arch.folder.newHere"), icon: FilePlus2, onClick: () => void store().create(undefined, folder.id) },
      { label: t("arch.folder.newSub"), icon: FolderPlus, onClick: () => newFolder(folder.id) },
      {
        label: t("arch.folder.rename"),
        icon: Pencil,
        separated: true,
        onClick: () =>
          void promptAction(t("arch.folder.renamePrompt"), { initial: folder.name, confirmLabel: t("arch.rename") }).then((value) => value && void store().renameFolder(folder.id, value)),
      },
      ...(folders.length > 1 || folder.parentId
        ? [{ label: t("arch.moveTo"), icon: FolderInput, onClick: () => {}, children: moveTargets(folder.parentId, (to) => void store().moveFolder(folder.id, to), subtree) }]
        : []),
      {
        label: t("arch.folder.delete"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () =>
          void confirmAction(inside ? t("arch.folder.deleteConfirm", { name: folder.name, n: inside }) : t("arch.folder.deleteEmpty", { name: folder.name })).then(
            (ok) => ok && void store().deleteFolder(folder.id),
          ),
      },
    ];
  };

  const openMenu = (event: React.MouseEvent, rowKey: string, menuItems: MenuItem[], fromButton: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items: menuItems, rowKey, anchor: fromButton ? anchorOf(event.currentTarget) : undefined });
  };

  /** The ⋮ at a row's end: shown on hover, and kept while its menu is open. */
  const kebab = (rowKey: string, menuItems: () => MenuItem[]) => (
    <button
      type="button"
      aria-label={t("arch.more")}
      title={t("arch.more")}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => openMenu(event, rowKey, menuItems(), true)}
      className={`grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md text-[var(--cf-text-muted)] transition-opacity hover:bg-[var(--cf-press)] hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover:opacity-100 ${menu?.rowKey === rowKey ? "opacity-100" : "opacity-0"}`}
    >
      <MoreVertical size={14} />
    </button>
  );

  const docRow = (item: ArchItem, depth: number) => {
    const selected = item.id === activeId;
    const key = `doc:${item.id}`;
    return (
      <div key={item.id} role="option" aria-selected={selected} className={`group ${rowClass(selected, "h-[30px] pr-1")} ${drag?.what.id === item.id ? "opacity-50" : ""}`} style={{ paddingLeft: 8 + depth * INDENT }} onContextMenu={(event) => openMenu(event, key, docMenuItems(item), false)}>
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
          onPointerDown={press({ kind: "doc", id: item.id })}
          onClick={() => {
            if (dragged.current) return;
            void store().open(item.id);
          }}
        >
          <Network size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          {needle && item.folderId ? <span className="max-w-[40%] shrink-0 truncate text-[11px] text-[var(--cf-text-faint)]">{folderName(item.folderId)}</span> : null}
          {item.originPath ? <GitBranch size={12} className="shrink-0 text-[var(--cf-text-faint)]" aria-label={item.originPath} /> : null}
          {item.pinned ? <Pin size={11} className="shrink-0 text-[var(--cf-text-faint)]" /> : null}
          <span className={`shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)] group-hover:hidden ${menu?.rowKey === key ? "hidden" : ""}`}>{item.components || ""}</span>
        </button>
        {kebab(key, () => docMenuItems(item))}
      </div>
    );
  };

  const folderRows = (parentId: string | null, depth: number): React.ReactNode[] =>
    folders
      .filter((f) => f.parentId === parentId)
      .flatMap((folder) => {
        const open = !folded.includes(folder.id);
        const key = `folder:${folder.id}`;
        const target = drag && drag.over === folder.id && !(drag.what.kind === "folder" && folderSubtree(folders, drag.what.id).has(folder.id));
        const docs = shown.filter((i) => i.folderId === folder.id);
        const count = items.filter((i) => i.folderId === folder.id).length;
        return [
          <div
            key={key}
            data-arch-drop={folder.id}
            className={`group ${rowClass(false, "h-[30px] pr-1")} ${target ? "bg-[var(--cf-accent-soft)] outline outline-1 outline-[var(--cf-accent)]" : ""} ${drag?.what.id === folder.id ? "opacity-50" : ""}`}
            style={{ paddingLeft: 4 + depth * INDENT }}
            onContextMenu={(event) => openMenu(event, key, folderMenuItems(folder), false)}
          >
            <button
              type="button"
              aria-expanded={open}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
              onPointerDown={press({ kind: "folder", id: folder.id })}
              onClick={() => { if (!dragged.current) store().toggleFolder(folder.id); }}
            >
              <ChevronRight size={13} className={`shrink-0 text-[var(--cf-text-faint)] transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
              <Folder size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
              <span className={`shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)] group-hover:hidden ${menu?.rowKey === key ? "hidden" : ""}`}>{count || ""}</span>
            </button>
            {kebab(key, () => folderMenuItems(folder))}
          </div>,
          ...(open ? [...folderRows(folder.id, depth + 1), ...docs.map((item) => docRow(item, depth + 1))] : []),
        ];
      });

  const rootTarget = drag?.over === ROOT;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-tour="arch-explorer">
      <div className={`${explorerHeadClass} @container`}>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-muted)]">
          <span className="@max-[140px]:hidden">{t("tabbar.architecture")}</span>
        </span>
        <button type="button" className={iconButtonClass({ size: "sm" })} title={t("arch.import")} aria-label={t("arch.import")} onClick={() => void importFile()}>
          <Upload size={14} />
        </button>
        <button type="button" className={iconButtonClass({ size: "sm" })} title={t("arch.new")} aria-label={t("arch.new")} onClick={newMenu} data-tour="arch-new">
          <Plus size={15} />
        </button>
      </div>

      <div className="relative mx-2 mb-1.5 shrink-0">
        <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]" />
        <input
          ref={searchField}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && setQuery("")}
          placeholder={t("arch.search")}
          aria-label={t("arch.search")}
          spellCheck={false}
          className={fieldClass({ size: "sm", className: "w-full pl-6 pr-6" })}
        />
        {query ? (
          <button
            type="button"
            onClick={() => { setQuery(""); searchField.current?.focus(); }}
            aria-label={t("arch.clearSearch")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      <div
        className={`min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 ${rootTarget && drag ? "rounded-md bg-[color-mix(in_oklab,var(--cf-accent)_6%,transparent)]" : ""}`}
        role="listbox"
        aria-label={t("tabbar.architecture")}
        data-arch-drop={ROOT}
      >
        {needle ? shown.map((item) => docRow(item, 0)) : [...folderRows(null, 0), ...shown.filter((i) => !i.folderId || !folders.some((f) => f.id === i.folderId)).map((item) => docRow(item, 0))]}
        {!shown.length && (needle || !folders.length) ? <p className="m-0 px-2 py-1.5 text-[12px] text-[var(--cf-text-faint)]">{needle ? t("arch.noMatches") : t("arch.empty")}</p> : null}
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} heading={menu.heading} anchor={menu.anchor} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
