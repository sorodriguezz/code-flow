import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ChevronDown, Copy, Folder, Plus, ShieldAlert, X } from "lucide-react";
import { createPortal } from "react-dom";
import { badgeColor, badgeLabel, protocolIcon } from "./methodStyle";
import { preventMiddleClickAutoscroll } from "../../lib/pointerDrag";
import { ContextMenu, type MenuItem} from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip";
import { Kbd, iconButtonClass } from "../common/Button";
import { chipClass, docTabClass, popoverClass } from "../common/recipes";
import { useShortcutChord } from "../../lib/useShortcutHint";
import { useApiStore, type ApiEntityTab, type ApiTab } from "../../state/apiStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useCollabStore } from "../../state/collabStore";
import { useRowHoverStore } from "../../state/rowHoverStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { PROTOCOL_NAMES } from "../../lib/api/protocol";
import { API_PROTOCOLS, type ApiProtocol } from "../../types/api";

/**
 * Every tab is this wide, rather than as wide as the name it holds.
 *
 * Request names come from whoever wrote the collection, and an imported spec routinely mixes "Create
 * user" with "Creates list of users with given input array" — sized to content, the strip becomes a
 * row of tabs with no two edges alike, and the close button you are aiming for sits somewhere new on
 * every one. A fixed column also means a tab does not resize under the cursor when a rename or a
 * protocol switch changes its label.
 *
 * Fixed rather than shared-and-shrinking (the browser behaviour): the strip already scrolls, with a
 * wheel handler and a `scrollIntoView` on activation to go with it. Letting tabs shrink instead
 * would trade those for tabs that get unreadable exactly when there are the most of them.
 *
 * Matches the document tab's `max-w-[220px]` (`docTabClass`), so every strip of open things in the
 * window — the editor's files, these requests, a database's queries — agrees.
 */
const TAB_W = 220;

/**
 * The request tabs across the top of the builder.
 *
 * Deliberately *not* draggable: `apiStore` has no action that reorders `openTabs`, and a gesture
 * that rearranged them only in this component would be forgotten the moment the tab list is
 * persisted (which happens on every draft keystroke). Reordering belongs behind a store action,
 * not behind local state pretending to be one.
 */
export function RequestTabs() {
  const t = useT();
  const openTabs = useApiStore((s) => s.openTabs);
  const entityTabs = useApiStore((s) => s.entityTabs);
  const tabOrder = useApiStore((s) => s.tabOrder);
  const activeTabId = useApiStore((s) => s.activeTabId);
  const setActiveTab = useApiStore((s) => s.setActiveTab);
  const closeTab = useApiStore((s) => s.closeTab);
  const openScratchTab = useApiStore((s) => s.openScratchTab);
  const hoveredKey = useRowHoverStore((s) => s.key);
  const conflicts = useCollabStore((s) => s.conflicts);
  const openModal = useApiModalStore((s) => s.openApiModal);
  const chord = useShortcutChord();

  // Only requests can be open in a tab, so only those conflicts can be painted on one.
  const conflicted = useMemo(
    () => new Set(conflicts.filter((c) => c.kind === "request").map((c) => c.id)),
    [conflicts],
  );

  const stripRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [protocolMenu, setProtocolMenu] = useState<{ left: number; top: number } | null>(null);
  /** The right-clicked tab, by id rather than by value: the tab it names is re-derived on every
   *  render, so holding the object would leave the menu acting on a stale draft if a sync landed
   *  while it was open. */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Opening a request from the tree can append a tab past the right edge of the strip.
  useEffect(() => {
    if (!activeTabId) return;
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, openTabs.length]);

  // A horizontal strip inside a vertical layout never receives horizontal wheel deltas from a
  // plain mouse — translate the vertical ones, the way the editor's tab strip does.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
  };

  const requestClose = async (tab: ApiTab | ApiEntityTab) => {
    if (tab.dirty) {
      const name = tab.name || t("api.untitledRequest");
      if (!(await confirmAction(t("editor.closeDirtyConfirm", { name })))) return;
    }
    closeTab(tab.id);
  };

  /**
   * One strip, two lists. `tabOrder` is the only thing that knows how they interleave — a tab is
   * looked up in whichever list holds it, so a collection opened between two requests stays where
   * it was opened rather than being herded to one end.
   */
  type StripEntry = { kind: "request"; tab: ApiTab } | { kind: "entity"; tab: ApiEntityTab };
  const strip = tabOrder.flatMap<StripEntry>((id) => {
    const request = openTabs.find((tab) => tab.id === id);
    if (request) return [{ kind: "request", tab: request }];
    const entity = entityTabs.find((tab) => tab.id === id);
    return entity ? [{ kind: "entity", tab: entity }] : [];
  });

  /**
   * The right-click menu on a tab.
   *
   * Only two entries, and both already exist elsewhere in the strip — the point of the menu is
   * that Clone has nowhere else to live, since a duplicate is a gesture on the tab rather than on
   * the row behind it (a scratch tab has no row at all). Close is here because a menu with a
   * single item reads as an accident.
   *
   * Clone is offered for request tabs only: a collection's or folder's settings tab edits a row,
   * so "duplicate" there would mean duplicating the row — which is what the tree's own Duplicate
   * already does, and does properly.
   */
  const menuItems = (id: string): MenuItem[] => {
    const entry = strip.find((candidate) => candidate.tab.id === id);
    if (!entry) return [];
    const items: MenuItem[] = [];
    if (entry.kind === "request") {
      items.push({
        label: t("api.cloneTab"),
        icon: Copy,
        // No toast: the copy opens focused, with its unsaved dot showing, which says more about
        // what just happened than a line of text at the corner of the screen would.
        onClick: () => useApiStore.getState().cloneTab(id),
      });
    }
    items.push({
      label: t("common.close"),
      icon: X,
      separated: entry.kind === "request",
      onClick: () => void requestClose(entry.tab),
    });
    return items;
  };

  // The document-tab strip (`docStripClass`'s tone and height), built in two parts because the new-
  // request buttons stay put while the tabs scroll. The hairline is an inset shadow on the outer
  // row rather than a border, and the scroller keeps a pixel of bottom padding: that is what lets
  // the active tab (`docTabClass`, `-mb-px`) reach down over the line and melt into the sheet below
  // instead of being clipped a pixel short of it by the scroller's own overflow.
  return (
    <div className="flex h-9 shrink-0 items-stretch bg-[var(--cf-sunken)] shadow-[inset_0_-1px_0_var(--cf-border)]">
      <div
        ref={stripRef}
        onWheel={onWheel}
        role="tablist"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {strip.map(({ kind, tab }) => {
          const active = tab.id === activeTabId;
          const hoverKey = `apitab:${tab.id}`;
          // A frozen record is the one thing on this strip that is not about the tab's own state:
          // it says a decision is owed before this request can sync again, so it outranks both the
          // method badge's colour and the unsaved dot for attention.
          // Two sources, one badge. The sync layer freezes records whose *saved* versions diverged;
          // `staleAgainst` catches the case it structurally cannot see — a change that arrived while
          // this tab held unsaved edits. To the person looking at the tab they are the same
          // sentence: someone else touched this, and you have to say which version wins.
          // Settings tabs are outside all of this: the sync layer freezes requests, and a
          // collection's own row is last-write-wins with no decision to owe anyone.
          const inConflict =
            kind === "request" &&
            (tab.staleAgainst !== undefined ||
              (tab.requestId !== null && conflicted.has(tab.requestId)));
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el);
                else tabRefs.current.delete(tab.id);
              }}
              role="tab"
              aria-selected={active}
              title={kind === "request" ? tab.draft.url || tab.name || t("api.untitledRequest") : tab.name}
              onPointerEnter={() => useRowHoverStore.getState().enter(hoverKey)}
              onPointerLeave={() => useRowHoverStore.getState().leave(hoverKey)}
              // Kills press-and-sweep text selection without costing the `click` that follows.
              // The middle button is cancelled for a different reason entirely (see
              // `preventMiddleClickAutoscroll`); the right one is left alone, because it has a
              // `contextmenu` to raise and cancelling the press cancels the menu with it.
              onMouseDown={(e) => {
                if (e.button === 0) e.preventDefault();
                else preventMiddleClickAutoscroll(e);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ x: e.clientX, y: e.clientY, id: tab.id });
              }}
              onClick={() => setActiveTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                void requestClose(tab);
              }}
              style={{ width: TAB_W }}
              // The active tab takes the sheet's colour and melts into the page below it; there is no
              // accent bar over it any more. A tab owing a conflict decision keeps its warning wash
              // whichever tab is active, and the active one of those also keeps a warning rule on
              // top — it outranks everything else on the strip for attention.
              className={docTabClass(
                active,
                `cursor-pointer select-none ${
                  !active && hoverKey === hoveredKey ? "cf-row-hover" : ""
                } ${inConflict && !active ? "bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)]" : ""}`,
              )}
            >
              {active && inConflict && (
                <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-[var(--cf-warning)]" />
              )}
              {kind === "request" ? (
                <span
                  className="shrink-0 font-mono text-[10.5px] font-bold"
                  style={{ color: badgeColor(tab.draft.protocol, tab.draft.method) }}
                >
                  {badgeLabel(tab.draft.protocol, tab.draft.method)}
                </span>
              ) : tab.kind === "collection" ? (
                <Boxes size={14} className="shrink-0 text-[var(--cf-accent)]" />
              ) : (
                <Folder size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
              )}
              <span className={`truncate ${tab.dirty ? "italic" : ""}`}>
                {tab.name || t(kind === "request" ? "api.untitledRequest" : "api.untitledCollection")}
              </span>
              {inConflict && (
                <Tooltip label={t("api.conflict.badge")} description={t("api.conflict.tabHint")} side="bottom">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      // A stale tab is resolved in the tab itself, where both versions are; only the
                      // sync layer's frozen records have anything to show in the modal.
                      if (tab.staleAgainst !== undefined) setActiveTab(tab.id);
                      else openModal({ kind: "conflicts" });
                    }}
                    className={chipClass("warn", "hover:bg-[color-mix(in_oklab,var(--cf-warning)_24%,transparent)]")}
                  >
                    <ShieldAlert size={12} />
                    {t("api.conflict.badge")}
                  </button>
                </Tooltip>
              )}
              <Tooltip
                label={tab.dirty ? t("api.unsaved") : t("common.close")}
                trailing={chord("editor.closeTab") ? <Kbd>{chord("editor.closeTab")}</Kbd> : undefined}
                side="bottom"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestClose(tab);
                  }}
                  aria-label={t("common.close")}
                  className={iconButtonClass({
                    size: "xs",
                    className: `ml-auto ${
                      active || tab.dirty ? "" : "opacity-0 group-hover/doctab:opacity-100 focus-visible:opacity-100"
                    }`,
                  })}
                >
                  {/* The unsaved dot lives in the close slot and turns into an × on hover, so a
                      modified tab is still one click from closing. */}
                  {tab.dirty ? (
                    <>
                      <span className="h-2 w-2 rounded-full bg-[var(--cf-accent)] group-hover/doctab:hidden" />
                      <X size={13} className="hidden group-hover/doctab:block" />
                    </>
                  ) : (
                    <X size={13} />
                  )}
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>

      {/* Split control: the plus is the common case (a plain HTTP request, one click), the caret
          is for the five protocols you'd otherwise have to create-then-convert to reach. */}
      <div className="flex shrink-0 items-center gap-px px-1.5">
        <Tooltip label={t("api.newRequest")} side="bottom">
          <button
            type="button"
            onClick={() => openScratchTab()}
            aria-label={t("api.newRequest")}
            className={iconButtonClass({ size: "sm" })}
          >
            <Plus size={16} />
          </button>
        </Tooltip>
        <Tooltip label={t("api.protocol")} side="bottom">
          <button
            type="button"
            ref={plusRef}
            onClick={() => {
              const rect = plusRef.current?.getBoundingClientRect();
              if (rect) setProtocolMenu({ left: rect.right, top: rect.bottom + 4 });
            }}
            aria-label={t("api.protocol")}
            aria-haspopup="menu"
            aria-expanded={protocolMenu !== null}
            className={iconButtonClass({ size: "sm", active: protocolMenu !== null, className: "!w-[18px]" })}
          >
            <ChevronDown size={13} />
          </button>
        </Tooltip>
      </div>

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={menuItems(tabMenu.id)}
          onClose={() => setTabMenu(null)}
        />
      )}

      {protocolMenu &&
        createPortal(
          <>
            {/* Full-viewport catcher instead of a document listener: it closes the menu on the
                same click that would otherwise also press whatever is underneath. */}
            <div className="fixed inset-0 z-[9998]" onMouseDown={() => setProtocolMenu(null)} />
            <div
              role="menu"
              style={{ position: "fixed", left: protocolMenu.left, top: protocolMenu.top }}
              className={`z-[9999] w-[250px] -translate-x-full ${popoverClass}`}
            >
              {API_PROTOCOLS.map((protocol: ApiProtocol) => {
                const Icon = protocolIcon(protocol);
                return (
                  <button
                    key={protocol}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProtocolMenu(null);
                      openScratchTab(protocol);
                    }}
                    // `menuItemClass`'s row, grown to two lines for the hint under each name.
                    className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-[var(--cf-hover)]"
                  >
                    {/* Nudged onto the title's baseline rather than centred on the whole item: the
                        hint below wraps to two lines for half of these, and an icon centred on the
                        pair drifts down the list as the wrapping changes. */}
                    <Icon
                      size={15}
                      className="mt-[2px] shrink-0"
                      style={{ color: badgeColor(protocol, "") }}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] text-[var(--cf-text)]">
                        {t("api.newRequestOf", { protocol: PROTOCOL_NAMES[protocol] })}
                      </span>
                      <span className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
                        {t(`api.protocolHint.${protocol}` as const)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
