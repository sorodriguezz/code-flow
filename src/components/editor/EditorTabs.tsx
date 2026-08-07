import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ClipboardCopy, Pin, PinOff, SplitSquareHorizontal, X } from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { FileGlyph } from "../common/FileGlyph";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useRowHoverStore } from "../../state/rowHoverStore";
import { useTabDragStore, type TabDrag, type TabDropTarget } from "../../state/tabDragStore";
import { useT } from "../../state/languageStore";

export interface EditorTabItem {
  path: string;
  dirty: boolean;
  /** Ephemeral tab (single click in the tree): shown in italics and reused by the next
   * single-click open instead of piling up a tab per file you merely peeked at. */
  preview: boolean;
  /** Kept at the head of the strip, out of the way of everything that opens and closes around it.
   * The opposite end of the same scale as `preview`, and never both: pinning a peeked file makes
   * it permanent. */
  pinned: boolean;
}

/** The right-click actions, as one prop rather than four — the strip only forwards them, and this
 * component's parents already carry a long list of callbacks each. */
export interface TabMenuActions {
  togglePinned: (path: string) => void;
  closeAll: () => void;
  copyPath: (path: string) => void;
  splitRight: (path: string) => void;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function parentDir(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

/** Only files whose basename collides with another open tab get a dimmed folder suffix —
 * two `index.ts` tabs are indistinguishable otherwise, but adding the path to every tab
 * would just be noise. */
function buildSuffixes(tabs: EditorTabItem[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    const name = baseName(tab.path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const suffixes = new Map<string, string>();
  for (const tab of tabs) {
    if ((counts.get(baseName(tab.path)) ?? 0) > 1) suffixes.set(tab.path, parentDir(tab.path));
  }
  return suffixes;
}

/** Which gap in `strip` the pointer is nearest: the first tab whose midpoint is right of the
 * cursor, or the end. Measuring against midpoints is what lets you drop a tab *after* the one
 * you're hovering — the half of the gesture a per-tab drop target can't express. */
function insertionIndexIn(strip: HTMLElement, clientX: number): number {
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-cf-tab]"));
  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) return i;
  }
  return tabs.length;
}

/** Hit-tests the pointer against every editor group on screen — this is what makes dragging a tab
 * into *another* split work, since the source strip is the only thing tracking the gesture. */
function dropTargetAt(x: number, y: number): TabDropTarget | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;

  const strip = el.closest<HTMLElement>("[data-cf-tabstrip]");
  if (strip?.dataset.cfTabstrip) {
    return { groupId: strip.dataset.cfTabstrip, index: insertionIndexIn(strip, x), zone: "strip" };
  }

  const body = el.closest<HTMLElement>("[data-cf-panebody]");
  const groupId = body?.dataset.cfPanebody;
  if (groupId) {
    // Dropping on the body means "this group", with no opinion about where — so, the end.
    const target = document.querySelector<HTMLElement>(`[data-cf-tabstrip="${CSS.escape(groupId)}"]`);
    return { groupId, index: target?.querySelectorAll("[data-cf-tab]").length ?? 0, zone: "body" };
  }
  return null;
}

export function EditorTabs({
  groupId,
  tabs,
  activePath,
  onSelect,
  onClose,
  onPin,
  onDropTab,
  menu,
  actions,
}: {
  groupId: string;
  tabs: EditorTabItem[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Promotes a preview tab to a permanent one — VS Code's "keep open", not the pin in `menu`. */
  onPin: (path: string) => void;
  /** `targetIndex` is an insertion point in the *target* group's tab order. The parent decides
   * whether that's a reorder or a move between splits. */
  onDropTab: (payload: TabDrag, targetGroupId: string, targetIndex: number) => void;
  menu: TabMenuActions;
  actions?: ReactNode;
}) {
  const t = useT();
  /** The tab the context menu was opened on, with the point to draw it at. */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: EditorTabItem } | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const ghostRef = useRef<HTMLDivElement | null>(null);
  /** Set when a press turned into a drag, so the `click` that follows `pointerup` doesn't also
   * select the tab the drag just moved. */
  const suppressClickRef = useRef(false);

  const drag = useTabDragStore((s) => s.drag);
  const hoveredKey = useRowHoverStore((s) => s.key);
  const over = useTabDragStore((s) => s.over);
  const origin = useTabDragStore((s) => s.origin);
  const draggingHere = drag?.groupId === groupId;
  const dropAt = over?.groupId === groupId && over.zone === "strip" ? over.index : null;

  const suffixes = useMemo(() => buildSuffixes(tabs), [tabs]);

  // Selecting a tab from the palette/tree (or closing its neighbour) can leave the active
  // one scrolled out of the strip — pull it back into view the way the editor does.
  useEffect(() => {
    if (!activePath) return;
    tabRefs.current.get(activePath)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath, tabs.length]);

  // A tab strip is a horizontal row inside a vertical layout, so a trackpad-less mouse can
  // only ever produce vertical wheel deltas over it — translate those into scrolling.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
  };

  /**
   * The whole drag gesture, driven by pointer events on `window` so it keeps tracking once the
   * cursor leaves this strip — which is the entire point, since the interesting drop targets are
   * in the *other* panes.
   */
  const beginDrag = (e: React.PointerEvent<HTMLDivElement>, path: string) => {
    // Left button only; the middle one closes a tab.
    if (e.button !== 0) return;
    const from = { x: e.clientX, y: e.clientY };
    let started = false;

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_THRESHOLD) return;
        started = true;
        suppressClickRef.current = true;
        setDragCursor(true);
        useTabDragStore.getState().start({ groupId, path }, ev.clientX, ev.clientY);
      }
      // The label is moved directly rather than through state: a re-render of every strip on
      // every pointer move would make the drag stutter.
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      }
      useTabDragStore.getState().hover(dropTargetAt(ev.clientX, ev.clientY));
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!started) return;
      const target = dropTargetAt(ev.clientX, ev.clientY);
      setDragCursor(false);
      useTabDragStore.getState().end();
      // Dropped on nothing droppable — the tab stays where it was, like every editor.
      if (target) onDropTab({ groupId, path }, target.groupId, target.index);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const dropBar = <div className="my-1 w-0.5 shrink-0 rounded-full bg-[var(--cf-accent)]" />;

  const menuItems = (tab: EditorTabItem): MenuItem[] => [
    {
      label: tab.pinned ? t("editor.unpinTab") : t("editor.pinTab"),
      icon: tab.pinned ? PinOff : Pin,
      onClick: () => menu.togglePinned(tab.path),
    },
    { label: t("editor.copyPath"), icon: ClipboardCopy, onClick: () => menu.copyPath(tab.path) },
    { label: t("editor.splitRight"), icon: SplitSquareHorizontal, onClick: () => menu.splitRight(tab.path) },
    { label: t("editor.closeAllTabs"), icon: X, separated: true, onClick: menu.closeAll },
  ];

  return (
    <div className="flex shrink-0 items-stretch border-b border-[var(--cf-border)] bg-[var(--cf-bg)]">
      <div
        ref={stripRef}
        data-cf-tabstrip={groupId}
        onWheel={onWheel}
        className="cf-tab-strip flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {tabs.map((tab, index) => {
          const active = tab.path === activePath;
          const hoverKey = `tab:${groupId}:${tab.path}`;
          const suffix = suffixes.get(tab.path);
          return (
            <Fragment key={tab.path}>
              {dropAt === index && dropBar}
              <div
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.path, el);
                  else tabRefs.current.delete(tab.path);
                }}
                data-cf-tab={tab.path}
                role="tab"
                aria-selected={active}
                title={tab.path}
                onPointerDown={(e) => beginDrag(e, tab.path)}
                onPointerEnter={() => useRowHoverStore.getState().enter(hoverKey)}
                onPointerLeave={() => useRowHoverStore.getState().leave(hoverKey)}
                // Kills the browser's own press-and-sweep text selection without costing the
                // `click`/`dblclick` that follow — preventing it on `pointerdown` instead would
                // suppress those compatibility events too. Left button only: the right one has a
                // `contextmenu` to raise, and nothing to select by sweeping.
                onMouseDown={(e) => e.button === 0 && e.preventDefault()}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({ x: e.clientX, y: e.clientY, tab });
                }}
                onClick={() => {
                  // Swallows the click the browser fires after a drag's `pointerup`.
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  onSelect(tab.path);
                }}
                onDoubleClick={() => onPin(tab.path)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(tab.path);
                  }
                }}
                className={`group relative flex h-9 max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-[var(--cf-border)] pl-3 pr-2 text-[12px] transition-colors ${
                  active
                    ? "bg-[var(--cf-surface)] text-[var(--cf-text)]"
                    : `text-[var(--cf-text-muted)] ${hoverKey === hoveredKey && !drag ? "cf-row-hover" : ""}`
                } ${draggingHere && drag?.path === tab.path ? "opacity-40" : ""}`}
              >
                {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-[var(--cf-accent)]" />}
                <FileGlyph path={tab.path} />
                <span className={`truncate ${tab.preview ? "italic" : ""}`}>{baseName(tab.path)}</span>
                {suffix && (
                  <span className="truncate text-[10px] text-[var(--cf-text-muted)] opacity-70">{suffix}</span>
                )}
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    // A pinned tab's slot is the pin itself, so the one click it takes to put a
                    // tab back in the churn is the same click that took it out.
                    if (tab.pinned) menu.togglePinned(tab.path);
                    else onClose(tab.path);
                  }}
                  title={tab.pinned ? t("editor.unpinTab") : t("editor.closeTab")}
                  className={`ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ${
                    active || tab.pinned ? "" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {/* The dirty dot lives in the close button's slot, like VS Code: it turns into
                      an × on hover so a modified tab is still one click from closing. */}
                  {tab.dirty ? (
                    <>
                      <span className="h-2 w-2 rounded-full bg-[var(--cf-text)] group-hover:hidden" />
                      {tab.pinned ? (
                        <PinOff size={11} className="hidden group-hover:block" />
                      ) : (
                        <X size={12} className="hidden group-hover:block" />
                      )}
                    </>
                  ) : tab.pinned ? (
                    <Pin size={11} className="fill-current" />
                  ) : (
                    <X size={12} />
                  )}
                </button>
              </div>
            </Fragment>
          );
        })}
        {/* Dropping past the last tab appends. */}
        {dropAt === tabs.length && dropBar}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2 border-l border-[var(--cf-border)] px-2">{actions}</div>
      )}

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={menuItems(tabMenu.tab)}
          onClose={() => setTabMenu(null)}
        />
      )}

      {/* Portalled to `body` so nothing's `overflow` can clip it, and `pointer-events-none` so it
          never becomes the element `elementFromPoint` finds under the cursor. */}
      {draggingHere &&
        drag &&
        origin &&
        createPortal(
          <div
            ref={ghostRef}
            style={{ transform: `translate(${origin.x + 12}px, ${origin.y + 12}px)` }}
            className="pointer-events-none fixed left-0 top-0 z-[100] flex items-center gap-1.5 rounded-md border border-[var(--cf-accent)] bg-[var(--cf-surface)] px-2 py-1 text-[11px] text-[var(--cf-text)] shadow-lg"
          >
            {baseName(drag.path)}
          </div>,
          document.body,
        )}
    </div>
  );
}
