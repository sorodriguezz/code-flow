import { useCallback, useMemo, useRef, useState } from "react";
import {
  Copy,
  FolderOpen,
  FolderPlus,
  LayoutTemplate,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Table2,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { DiagramTreeRow } from "./DiagramTreeRow";
import { TemplatePickerModal } from "./TemplatePickerModal";
import { ICON_BUTTON } from "./diagramsChrome";
import { TREE_COLORS } from "../../lib/swatchColors";
import { FORMAT_DBML } from "../../lib/diagrams/doc";
import { buildFolderTree, descendantIds, flattenTree } from "../../lib/diagrams/tree";
import type { DiagramTreeRow as DiagramTreeRowData } from "../../types/diagrams";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { filterDiagrams, useDiagramsStore } from "../../state/diagramsStore";
import {
  edgeAt,
  useDiagramsDragStore,
  type DiagramsDrag,
  type DiagramsDropPlan,
} from "../../state/diagramsDragStore";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/** How close to an edge of the list the pointer must get before it scrolls, and by how much. */
const AUTOSCROLL_EDGE = 28;
const AUTOSCROLL_STEP = 12;

/**
 * The explorer: search, and the folder tree.
 *
 * The sibling of `NoteExplorer`, and everything that file says about performance applies here.
 * The tree is flattened into a plain array in a `useMemo` keyed on the things that can change it,
 * each row is a `memo`'d component taking primitives, and the callbacks handed down are
 * `useCallback`'d against the store's own stable actions.
 *
 * **The drag is pointer-driven**, because Tauri's webview swallows HTML5 `dragstart` — see
 * `diagramsDragStore`. A press becomes a drag after `DRAG_THRESHOLD` pixels, which is what keeps a
 * click on a diagram from being read as a one-pixel drag onto itself.
 *
 * **A drop either files or orders**, decided by where in the row it lands and resolved by
 * `planDrop`. That is the half of the hand-made ordering the user can see: `sort_order` is only
 * ever written by a drag, so this component is the only way the list's order is ever set.
 *
 * The one behavioural difference from the notes tree is the root. A note must live in a book, so
 * that tree's root strip accepts books only; here it accepts **both**, because a diagram outside
 * every folder is an ordinary diagram and dragging one back out has to be possible.
 */
export function DiagramExplorer() {
  const diagrams = useDiagramsStore((s) => s.diagrams);
  const folders = useDiagramsStore((s) => s.folders);
  const query = useDiagramsStore((s) => s.query);
  const tagFilter = useDiagramsStore((s) => s.tagFilter);
  const expanded = useDiagramsStore((s) => s.expanded);
  const activeId = useDiagramsStore((s) => s.activeId);
  const sort = useDiagramsStore((s) => s.sort);

  const setQuery = useDiagramsStore((s) => s.setQuery);
  const toggleFolder = useDiagramsStore((s) => s.toggleFolder);
  const setFolderFilter = useDiagramsStore((s) => s.setFolderFilter);
  const folderFilter = useDiagramsStore((s) => s.folderFilter);
  const importDrawio = useDiagramsStore((s) => s.importDrawio);
  const openDiagram = useDiagramsStore((s) => s.openDiagram);
  const closeDiagram = useDiagramsStore((s) => s.closeDiagram);
  const createDiagram = useDiagramsStore((s) => s.createDiagram);
  const createFolder = useDiagramsStore((s) => s.createFolder);
  const renameDiagram = useDiagramsStore((s) => s.renameDiagram);
  const renameFolder = useDiagramsStore((s) => s.renameFolder);
  const setFolderColor = useDiagramsStore((s) => s.setFolderColor);
  const duplicateDiagram = useDiagramsStore((s) => s.duplicateDiagram);
  const togglePinned = useDiagramsStore((s) => s.togglePinned);
  const deleteDiagram = useDiagramsStore((s) => s.deleteDiagram);
  const deleteFolder = useDiagramsStore((s) => s.deleteFolder);
  const dropDiagram = useDiagramsStore((s) => s.dropDiagram);
  const dropFolder = useDiagramsStore((s) => s.dropFolder);

  const drag = useDiagramsDragStore((s) => s.drag);
  const over = useDiagramsDragStore((s) => s.over);
  const press = useDiagramsDragStore((s) => s.press);
  const beginDrag = useDiagramsDragStore((s) => s.begin);
  const hoverDrag = useDiagramsDragStore((s) => s.hover);
  const endDrag = useDiagramsDragStore((s) => s.end);

  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Which row holds the tree's single tab stop. See `DiagramTreeRow`'s roving-tabindex comment. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** The folder the template picker will file into, or `undefined` when it is closed. `null` is a
   *  real value here — it means the root — so the closed state cannot be `null`. */
  const [picking, setPicking] = useState<string | null | undefined>(undefined);
  const treeRef = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);

  const untitled = t("diagrams.untitled");

  // `folderId` is omitted, so this is the whole workspace's surviving diagrams — the tree places
  // each under its own folder rather than showing one folder's worth.
  const visible = useMemo(
    () => filterDiagrams(diagrams, { query, tagFilter, sort }),
    [diagrams, query, tagFilter, sort],
  );

  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const filtering = query.trim().length > 0 || tagFilter.length > 0;
  /**
   * The folders drawn open.
   *
   * **A filtered tree ignores which folders are shut**: a match hidden inside a closed folder is a
   * search that lies about what it found — and with folders closed by default, that would be every
   * match. The user's own set comes back the moment the box is cleared, because it was never
   * changed.
   */
  const expandedSet = useMemo(
    () => (filtering ? new Set(folders.map((folder) => folder.id)) : new Set(expanded)),
    [filtering, folders, expanded],
  );
  const rows = useMemo(() => flattenTree(tree, visible, expandedSet), [tree, visible, expandedSet]);

  /** The folders a drop may not land in: the dragged folder and everything under it. */
  const forbidden = useMemo(
    () => (drag?.kind === "folder" ? descendantIds(folders, drag.id) : null),
    [drag, folders],
  );

  // ---------- drag ----------

  const onPressDown = useCallback(
    (event: React.PointerEvent, row: DiagramTreeRowData) => {
      // Left button only: a right-click opens the menu, and a middle-click must not start a drag
      // that has no way to be released.
      if (event.button !== 0) return;
      press(
        {
          kind: row.kind,
          id: row.id,
          fromFolderId:
            row.kind === "folder" ? row.folder.parent_id : row.diagram.folder_id,
        },
        event.clientX,
        event.clientY,
      );
    },
    [press],
  );

  /**
   * Whether a drag has just ended, so the click that follows it can be ignored.
   *
   * A pointer-driven drag does not suppress the browser's own click: a release over a row fires
   * `pointerup` and *then* `click`, so dropping a diagram into a folder would also toggle that
   * folder. A ref rather than state because nothing renders from it and a re-render here would cost
   * the whole tree.
   *
   * Cleared on a timeout rather than by the click it is waiting for. The two events are dispatched
   * in the same input task, so a `setTimeout(0)` scheduled during `pointerup` always runs after the
   * click — and clearing it *only* on the click would leave the flag armed forever whenever a drop
   * lands somewhere that produces no click at all, swallowing the next real one instead.
   */
  const swallowClick = useRef(false);

  const finishDrag = useCallback(() => {
    setDragCursor(false);
    // Read before `endDrag` clears it: a release with no drag behind it is an ordinary click and
    // must not be swallowed.
    if (useDiagramsDragStore.getState().drag !== null) {
      swallowClick.current = true;
      setTimeout(() => {
        swallowClick.current = false;
      }, 0);
    }
    endDrag();
  }, [endDrag]);

  /**
   * One listener on the container rather than one per row: the pointer leaves the pressed row
   * almost immediately, so a per-row `onPointerMove` would stop firing exactly when the drag is
   * deciding whether it has started.
   *
   * **Bound on the capture phase**, which is load-bearing rather than tidy. The rows resolve where
   * a drop would land by measuring themselves, and this handler *scrolls the list underneath them*.
   * On the bubble phase it would run second, so every move inside the autoscroll band would leave
   * the insertion line drawn against the layout as it was before the scroll — an aim you cannot
   * correct, because correcting it scrolls again.
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const { origin, drag: live } = useDiagramsDragStore.getState();
      if (live) {
        autoScroll(treeRef.current, event.clientY);
        return;
      }
      if (!origin) return;
      // No button held means this is a plain hover, not a drag. Without the check a press whose
      // release we never saw — the pointer left the window, the OS took the gesture — leaves
      // `origin` armed, and the next time the pointer crosses the sidebar it travels far enough to
      // start a drag nobody began.
      if (event.buttons === 0) {
        finishDrag();
        return;
      }
      const travelled = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
      if (travelled < DRAG_THRESHOLD) return;
      beginDrag();
      setDragCursor(true);
    },
    [beginDrag, finishDrag],
  );

  /**
   * What a release over `row`, in zone `edge`, would actually write — or `null` for "nothing".
   *
   * **An ordering edge only means something between rows of the same kind.** A diagram has no place
   * in the sequence of folders and a folder none in the sequence of diagrams — `flattenTree` draws
   * the two as separate runs — so a diagram over a folder's top edge, or a folder over a diagram,
   * collapses to filing. That is both the only coherent reading and the forgiving one.
   *
   * Used for the highlight *and* for the write, so what lights up under the pointer is by
   * construction what a release performs.
   */
  const planDrop = useCallback(
    (
      live: DiagramsDrag,
      row: DiagramTreeRowData,
      edge: "into" | "before" | "after",
    ): DiagramsDropPlan | null => {
      // A row is never its own destination — neither inside itself nor next to itself.
      if (live.id === row.id) return null;
      const ordering = edge !== "into" && live.kind === row.kind;

      if (row.kind === "folder") {
        /**
         * An **open folder has no usable bottom edge**, and this is the one place the geometry and
         * the meaning come apart. `flattenTree` draws an expanded folder's contents immediately
         * below its header, so a line along that header's underside sits above the folder's own
         * first child — while the drop it stands for places the item after the *whole subtree*,
         * several rows further down. Rather than draw a line pointing at the wrong gap, the band
         * falls back to filing, which is what the middle of the row already means. Ordering that
         * folder downwards is still one gesture away: the top edge of the next sibling.
         */
        const drawnOpen =
          expandedSet.has(row.id) &&
          (row.diagramCount > 0 || folders.some((folder) => folder.parent_id === row.id));
        if (!ordering || (edge === "after" && drawnOpen)) {
          // A folder into its own subtree is refused by the backend too (`move_folder` returns
          // false), but catching it here means the row never lights up as a target at all.
          if (live.kind === "folder" && forbidden?.has(row.id)) return null;
          return { mode: "into", folderId: row.folder.id };
        }
        // Next to a folder is *among its siblings*, so the destination is its parent — which may
        // itself be inside the subtree being dragged, and which is the root for a top-level folder.
        const parentId = row.folder.parent_id;
        if (parentId !== null && forbidden?.has(parentId)) return null;
        return { mode: "order", anchorId: row.id, after: edge === "after", folderId: parentId };
      }

      const folderId = row.diagram.folder_id;
      if (!ordering) {
        // Filing "into" a diagram row means into the folder that diagram is in — which for a
        // root-level diagram is the root, and that is a real destination here.
        if (live.kind === "folder" && folderId !== null && forbidden?.has(folderId)) return null;
        return { mode: "into", folderId };
      }
      return { mode: "order", anchorId: row.id, after: edge === "after", folderId };
    },
    [forbidden, expandedSet, folders],
  );

  /** The zone of `row` the pointer is in — measured here, not in the row, so that an ordinary
   *  mouse-over of the tree costs no layout. See `DiagramTreeRow`'s `onHover`. */
  const zoneAt = (event: React.PointerEvent, row: DiagramTreeRowData) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return edgeAt(row.kind, event.clientY - rect.top, rect.height);
  };

  const onHoverRow = useCallback(
    (event: React.PointerEvent, row: DiagramTreeRowData) => {
      const { drag: live } = useDiagramsDragStore.getState();
      // Guarded before anything is measured: this fires for every pixel of every ordinary pass of
      // the pointer across the tree, and nothing below it is free.
      if (!live) return;
      hoverDrag(planDrop(live, row, zoneAt(event, row)));
    },
    [hoverDrag, planDrop],
  );

  const commit = useCallback(
    (plan: DiagramsDropPlan | null) => {
      const { drag: live } = useDiagramsDragStore.getState();
      if (!live || !plan) return;
      const anchor = plan.mode === "order" ? { id: plan.anchorId, after: plan.after } : null;
      if (live.kind === "folder") void dropFolder(live.id, plan.folderId, anchor);
      else void dropDiagram(live.id, plan.folderId, anchor);
    },
    [dropDiagram, dropFolder],
  );

  const commitDrop = useCallback(
    (event: React.PointerEvent, row: DiagramTreeRowData) => {
      const { drag: live } = useDiagramsDragStore.getState();
      if (!live) return;
      // Re-resolved from the release point rather than read off the store's `over`, so a drop is
      // decided by where the pointer actually let go — the two agree, because it is the same
      // function over the same inputs.
      commit(planDrop(live, row, zoneAt(event, row)));
    },
    [commit, planDrop],
  );

  // ---------- selection ----------

  const onSelectRow = useCallback(
    (row: DiagramTreeRowData) => {
      if (swallowClick.current) return;
      setFocusedId(row.id);
      void openDiagram(row.id);
    },
    [openDiagram],
  );

  const onToggleRow = useCallback(
    (row: DiagramTreeRowData) => {
      if (swallowClick.current) return;
      setFocusedId(row.id);
      // Not while filtering. Every folder is drawn open then, whatever the stored set says, so a
      // toggle would write the opposite of what the chevron shows and the row would not move — a
      // click that appears to do nothing and quietly rearranges the tree once the box is cleared.
      if (!filtering) toggleFolder(row.id);
      // And the gallery goes to that folder, so clicking a folder in the sidebar means the same
      // thing as clicking its card.
      setFolderFilter(row.id);
      // Back to the gallery: clicking a folder is navigation, and leaving the editor open over a
      // folder the user has just navigated away from would show them a diagram from somewhere else.
      // `closeDiagram` writes anything pending first.
      void closeDiagram();
    },
    [toggleFolder, setFolderFilter, closeDiagram, filtering],
  );

  /**
   * Arrow-key navigation over the flattened tree.
   *
   * The flattening is what makes this a few lines rather than a recursive walk: "next row" is
   * `rows[index ± 1]`, whatever its depth. Left/Right collapse and expand the way every file tree
   * does — Right on a collapsed folder opens it and on an open one steps into it, Left closes it
   * and on a leaf steps out to its parent.
   */
  const onTreeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const KEYS = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "];
      if (!KEYS.includes(event.key)) return;
      const current = focusedId ?? rows[0]?.id ?? null;
      const index = rows.findIndex((row) => row.id === current);
      if (index === -1) return;
      const row = rows[index];
      event.preventDefault();

      const focus = (next: number) => {
        const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
        if (!target) return;
        setFocusedId(target.id);
        // The DOM node has to take focus too, or a screen reader is told nothing moved.
        treeRef.current
          ?.querySelector<HTMLElement>(`[data-diagram-row="${CSS.escape(target.id)}"]`)
          ?.focus();
      };

      switch (event.key) {
        case "ArrowDown":
          focus(index + 1);
          break;
        case "ArrowUp":
          focus(index - 1);
          break;
        case "Home":
          focus(0);
          break;
        case "End":
          focus(rows.length - 1);
          break;
        case "ArrowRight":
          if (row.kind === "folder" && !expandedSet.has(row.id)) toggleFolder(row.id);
          else focus(index + 1);
          break;
        case "ArrowLeft":
          if (row.kind === "folder" && expandedSet.has(row.id)) toggleFolder(row.id);
          else {
            // Out to the parent: the nearest row above at a shallower depth.
            for (let at = index - 1; at >= 0; at--) {
              if (rows[at].depth < row.depth) {
                focus(at);
                break;
              }
            }
          }
          break;
        default:
          if (row.kind === "folder") toggleFolder(row.id);
          else void openDiagram(row.id);
      }
    },
    [rows, focusedId, expandedSet, toggleFolder, openDiagram],
  );

  // ---------- menus ----------

  /** `event` is needed for its coordinates: the colour entry replaces the menu in place, at the
   *  same point the first one opened at. */
  const folderMenu = useCallback(
    (event: React.MouseEvent, folderId: string, name: string): MenuItem[] => [
      {
        label: t("diagrams.newDiagramHere"),
        icon: Plus,
        onClick: () => void createDiagram(folderId),
      },
      {
        label: t("diagrams.newDbmlDiagramHere"),
        icon: Table2,
        onClick: () => void createDiagram(folderId, undefined, FORMAT_DBML),
      },
      {
        label: t("diagrams.newFromTemplate"),
        icon: LayoutTemplate,
        onClick: () => setPicking(folderId),
      },
      {
        label: t("diagrams.newSubfolder"),
        icon: FolderPlus,
        onClick: () => {
          void promptAction(t("diagrams.newFolderPrompt"), {
            confirmLabel: t("diagrams.create"),
          }).then((value) => value && void createFolder(folderId, value));
        },
      },
      {
        label: t("diagrams.rename"),
        icon: Pencil,
        separated: true,
        onClick: () => {
          void promptAction(t("diagrams.renameFolderPrompt"), {
            initial: name,
            confirmLabel: t("diagrams.rename"),
          }).then((value) => value && void renameFolder(folderId, value));
        },
      },
      {
        label: t("diagrams.colour"),
        icon: Palette,
        // Replaces this menu with the swatch list at the same point, rather than nesting — a
        // submenu that opens on hover is a submenu you close by accident.
        onClick: () =>
          setMenu({
            x: event.clientX,
            y: event.clientY,
            items: TREE_COLORS.map((swatch) => ({
              label: t(swatch.labelKey),
              leading: (
                <span
                  aria-hidden
                  className="h-3 w-3 rounded-full border border-[var(--cf-border)]"
                  style={{ background: swatch.value || "transparent" }}
                />
              ),
              onClick: () => void setFolderColor(folderId, swatch.value),
            })),
          }),
      },
      {
        label: t("diagrams.deleteFolder"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () => {
          void confirmAction(t("diagrams.deleteFolderConfirm", { name })).then(
            (ok) => ok && void deleteFolder(folderId),
          );
        },
      },
    ],
    [t, createDiagram, createFolder, renameFolder, setFolderColor, deleteFolder],
  );

  const diagramMenu = useCallback(
    (id: string, title: string, pinned: boolean): MenuItem[] => [
      {
        label: t("diagrams.rename"),
        icon: Pencil,
        onClick: () => {
          void promptAction(t("diagrams.renamePrompt"), {
            initial: title,
            confirmLabel: t("diagrams.rename"),
          }).then((value) => value && void renameDiagram(id, value));
        },
      },
      {
        label: pinned ? t("diagrams.unpin") : t("diagrams.pin"),
        icon: pinned ? PinOff : Pin,
        onClick: () => void togglePinned(id),
      },
      {
        label: t("diagrams.duplicate"),
        icon: Copy,
        onClick: () => void duplicateDiagram(id),
      },
      {
        label: t("diagrams.delete"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () => {
          void confirmAction(
            t("diagrams.deleteConfirm", { title: title || t("diagrams.untitled") }),
          ).then((ok) => ok && void deleteDiagram(id));
        },
      },
    ],
    [t, renameDiagram, togglePinned, duplicateDiagram, deleteDiagram],
  );

  const onRowMenu = useCallback(
    (event: React.MouseEvent, row: DiagramTreeRowData) => {
      event.preventDefault();
      setFocusedId(row.id);
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items:
          row.kind === "folder"
            ? folderMenu(event, row.id, row.folder.name)
            : diagramMenu(row.id, row.diagram.title, row.diagram.pinned),
      });
    },
    [folderMenu, diagramMenu],
  );

  // ---------- render ----------

  const dropEdgeFor = (row: DiagramTreeRowData): "into" | "before" | "after" | null => {
    if (!drag || !over) return null;
    if (over.mode === "order") {
      return over.anchorId === row.id ? (over.after ? "after" : "before") : null;
    }
    // The row being dragged shows as lifted rather than as its own destination.
    if (drag.id === row.id) return null;
    const container = row.kind === "folder" ? row.folder.id : row.diagram.folder_id;
    return over.folderId === container ? "into" : null;
  };

  /**
   * The root strip's plan.
   *
   * Unlike the notes tree, this accepts **both kinds**: a diagram outside every folder is an
   * ordinary diagram, so this strip is how one is dragged back out. `null` when the dragged row is
   * already at the root, so the strip doesn't light up for a drop that would write nothing.
   */
  const rootPlan: DiagramsDropPlan | null =
    drag && drag.fromFolderId !== null ? { mode: "into", folderId: null } : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onPointerMoveCapture={onPointerMove}
      // On the container, so releasing over a gap between rows ends the drag rather than leaving it
      // live and armed for the next click anywhere in the app.
      onPointerUp={finishDrag}
      // A gesture the OS or the browser takes over — a touch turning into a scroll, a window losing
      // focus mid-drag. Without it `body.cf-dragging` stays on and the whole app keeps a grabbing
      // cursor and refuses to select text until the next successful drag.
      onPointerCancel={finishDrag}
      onPointerLeave={finishDrag}
    >
      <div className="shrink-0 space-y-2 border-b border-[var(--cf-border)] p-2">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("diagrams.title")}
          </span>
          <button
            type="button"
            className={ICON_BUTTON}
            title={t("diagrams.newFolder")}
            aria-label={t("diagrams.newFolder")}
            onClick={() => {
              void promptAction(t("diagrams.newFolderPrompt"), {
                confirmLabel: t("diagrams.create"),
              }).then((value) => value && void createFolder(null, value));
            }}
          >
            <FolderPlus size={13} />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            title={t("diagrams.import")}
            aria-label={t("diagrams.import")}
            onClick={() => {
              void importDrawio(folderFilter).then((name) => {
                if (name) {
                  useToastStore.getState().pushToast(t("diagrams.imported", { name }), "success");
                }
              });
            }}
          >
            <FolderOpen size={13} />
          </button>
          {/* Opens the picker rather than making a blank diagram outright: "blank" is the first
              entry inside it, so this one button is the whole door into a new diagram instead of
              one button here and a different one in the gallery doing almost the same thing.
              Files into the folder being shown, which is what the gallery's button used to do. */}
          <button
            type="button"
            className={ICON_BUTTON}
            title={t("diagrams.newDiagram")}
            aria-label={t("diagrams.newDiagram")}
            onClick={() => setPicking(folderFilter)}
            data-tour="diagrams-new"
          >
            <Plus size={13} />
          </button>
        </div>

        <div className="relative" data-tour="diagrams-search">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
          />
          <input
            ref={searchField}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setQuery("")}
            placeholder={t("diagrams.searchPlaceholder")}
            aria-label={t("diagrams.searchPlaceholder")}
            spellCheck={false}
            className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] py-1 pl-6 pr-6 text-[11.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchField.current?.focus();
              }}
              aria-label={t("diagrams.clearSearch")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div
        ref={treeRef}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
        role="tree"
        aria-label={t("diagrams.title")}
        data-tour="diagrams-tree"
        onKeyDown={onTreeKeyDown}
      >
        {rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11.5px] text-[var(--cf-text-muted)]">
            {filtering ? t("diagrams.noMatches") : t("diagrams.treeEmpty")}
          </p>
        ) : (
          rows.map((row) => (
            <DiagramTreeRow
              key={row.id}
              row={row}
              active={row.kind === "diagram" && row.id === activeId}
              collapsed={row.kind === "folder" && !expandedSet.has(row.id)}
              dropEdge={dropEdgeFor(row)}
              dragging={drag?.id === row.id}
              focused={row.id === (focusedId ?? rows[0]?.id)}
              untitledLabel={untitled}
              onSelect={onSelectRow}
              onToggle={onToggleRow}
              onHover={onHoverRow}
              onDrop={commitDrop}
              onPressDown={onPressDown}
              onMenu={onRowMenu}
            />
          ))
        )}

        {/* The root as a drop target. It has no row of its own — root-level diagrams sit at depth 0
            with nothing above them — so without this strip there is no way to drag anything *out*
            of a folder, only deeper into one. `min-h` rather than `flex-1` because the list
            scrolls: a growing spacer would push the scrollbar around as rows are filtered. */}
        <div
          className={`mt-1 min-h-8 rounded-md transition-colors ${
            over?.mode === "into" && over.folderId === null
              ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
              : ""
          }`}
          onPointerEnter={() => hoverDrag(rootPlan)}
          onPointerUp={() => commit(rootPlan)}
          aria-hidden
        />
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {picking !== undefined && (
        <TemplatePickerModal folderId={picking} onClose={() => setPicking(undefined)} />
      )}
    </div>
  );
}

/** Scrolls the list when the pointer is dragged near either end of it. Without this a drag can
 *  only reach the rows that happen to be on screen when it starts. */
function autoScroll(list: HTMLElement | null, clientY: number) {
  if (!list) return;
  const rect = list.getBoundingClientRect();
  if (clientY < rect.top + AUTOSCROLL_EDGE) list.scrollTop -= AUTOSCROLL_STEP;
  else if (clientY > rect.bottom - AUTOSCROLL_EDGE) list.scrollTop += AUTOSCROLL_STEP;
}
