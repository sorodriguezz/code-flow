import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Bookmark,
  Boxes,
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Plus,
  Pencil,
  Play,
  Link2,
  PauseCircle,
  RefreshCw,
  Share2,
  ShieldAlert,
  Star,
  Trash2,
  Unlink,
  Users,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { badgeColor, badgeLabel, statusColor } from "./methodStyle";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { canDrop, useApiDragStore, type ApiDrag, type ApiDropZone } from "../../state/apiDragStore";
import { useApiStore } from "../../state/apiStore";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useApiModalStore } from "../../state/apiModalStore";
import { useCollabStore, type ShareHealth } from "../../state/collabStore";
import { useRowHoverStore } from "../../state/rowHoverStore";
import { confirmAction } from "../../state/confirmStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { encodeInvite, syncCollection } from "../../lib/api/sync";
import { supabaseAnonKey } from "../../lib/tauri/apiCommands";
import { defaultRequestSpec } from "../../types/api";
import type { ApiFolder, ApiProtocol, ApiRequestRow, SavedExample } from "../../types/api";

/** Row indent per level, and the left gutter every row starts from. */
const INDENT = 14;
const ROW_PAD = 6;

/** The twisty column, and the glyph column beside it — the method badge on a request, the folder
 * icon on a container. Sharing one width is what puts every name on the same left edge, so a
 * request reads as the sibling of the folder above it rather than as something inside it. */
const TWISTY_W = 12;
const GLYPH_W = 38;

/** How much of a folder row's height, top and bottom, aims *between* rows rather than into it.
 * Small enough that the middle — "into this folder" — is what you hit without trying. */
const EDGE_FRACTION = 0.28;

/** How long the pointer has to rest on a collapsed container before it springs open. Without it a
 * deep move is impossible: you can't drop into a folder you can't see the inside of. */
const SPRING_LOAD_MS = 600;

type ApiNodeKind = "collection" | "folder" | "request";

interface NodeRef {
  kind: ApiNodeKind;
  id: string;
  collectionId: string;
  /** The container the node lives in — a folder's `parent_id`, a request's `folder_id`. */
  parentId: string | null;
  name: string;
}

/** An in-progress "new request"/"new folder": the inline input the explorer uses, not a modal. */
interface Draft {
  kind: "folder" | "request";
  collectionId: string;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// Badges — shared with the sidebar's search results and the history list
// ---------------------------------------------------------------------------

/**
 * The little uppercase tag in front of every request row — a verb for HTTP, the protocol name for
 * everything else. Colour and wording come from `methodStyle` so the tree, the tab strip and the
 * URL bar can never disagree about what a POST looks like.
 */
export function MethodBadge({ protocol, method }: { protocol: ApiProtocol; method: string }) {
  return (
    <span
      style={{ color: badgeColor(protocol, method), width: GLYPH_W }}
      className="shrink-0 truncate text-right font-mono text-[9px] font-bold uppercase leading-none tracking-tight"
    >
      {badgeLabel(protocol, method)}
    </span>
  );
}

/**
 * The hairlines tying a row to its ancestors, one per level above it.
 *
 * Each row draws only its own segment, so the lines read as continuous down a subtree without any
 * row having to know how tall that subtree is. They sit on the centre of each level's twisty
 * column, which is what makes a line point at the chevron that collapses the branch it belongs to.
 */
function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="pointer-events-none absolute top-0 h-full w-px bg-[var(--cf-border)]"
          style={{ left: level * INDENT + ROW_PAD + TWISTY_W / 2 }}
        />
      ))}
    </>
  );
}

/** The glyph column: whatever goes in it is pushed against the name, so icons of different sizes
 * still leave every name on the same left edge. */
function GlyphSlot({ children }: { children: ReactNode }) {
  return (
    <span style={{ width: GLYPH_W }} className="flex shrink-0 items-center justify-end">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Context menu — shared with the sidebar's "…" button
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  danger?: boolean;
  /** Draws a hairline above this item. */
  separated?: boolean;
}

/** A floating menu at a point, portalled so no scroll container can clip it. Positioned after
 * mount because its size is only known once it's rendered — the clamp is what keeps a menu opened
 * near the bottom of the window from hanging off the edge. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    // Capture phase: the scroll that matters happens inside the sidebar, not on the window, and
    // a menu left floating over rows that have moved on points at the wrong node.
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      className="z-[9999] min-w-[172px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
    >
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {item.separated && i > 0 && <div className="my-1 h-px bg-[var(--cf-border)]" />}
          <button
            role="menuitem"
            onClick={() => {
              onClose();
              item.onClick();
            }}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] ${
              item.danger ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"
            }`}
          >
            <item.icon size={13} className="shrink-0 opacity-70" />
            <span className="truncate">{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Tree grouping
// ---------------------------------------------------------------------------

interface GroupedTree {
  folders: Map<string, ApiFolder[]>;
  requests: Map<string, ApiRequestRow[]>;
}

/** `\0` can't appear in a uuid, so no pair of ids can collide into one key. */
const containerKey = (collectionId: string, parentId: string | null) =>
  `${collectionId}\u0000${parentId ?? ""}`;

function pushInto<T>(map: Map<string, T[]>, key: string, value: T) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** A row whose `spec` is corrupt simply has no examples, the same way it still opens as a request. */
function readExamples(row: ApiRequestRow): SavedExample[] {
  try {
    const spec = JSON.parse(row.spec) as { examples?: unknown };
    return Array.isArray(spec.examples) ? (spec.examples as SavedExample[]) : [];
  } catch {
    return [];
  }
}

function groupTree(folders: ApiFolder[], requests: ApiRequestRow[]): GroupedTree {
  const grouped: GroupedTree = { folders: new Map(), requests: new Map() };
  for (const folder of [...folders].sort((a, b) => a.sort_order - b.sort_order)) {
    pushInto(grouped.folders, containerKey(folder.collection_id, folder.parent_id), folder);
  }
  for (const request of [...requests].sort((a, b) => a.sort_order - b.sort_order)) {
    pushInto(grouped.requests, containerKey(request.collection_id, request.folder_id), request);
  }
  return grouped;
}

/**
 * A gap in the list as *rendered* → the index `moveNode` wants.
 *
 * The rendered list still contains the row being dragged; the backend renumbers the destination
 * with it already removed. Every gap past its current position therefore shifts down by one, and
 * both gaps around it collapse onto the same slot — which is exactly what makes a drag that goes
 * nowhere a no-op instead of an off-by-one.
 */
function storeIndex(gap: number, draggedAt: number): number {
  return draggedAt >= 0 && gap > draggedAt ? gap - 1 : gap;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface TreeRowProps {
  node: NodeRef;
  depth: number;
  /** Containers, and requests that have saved examples to unfold; `undefined` on a plain request. */
  expanded?: boolean;
  /** Requests only: set when the row has examples, so it gets a twisty instead of the spacer. */
  onToggle?: () => void;
  /** Collections only: current pin state, and the toggle for it. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Collections only: `null` when the collection isn't shared. */
  share?: ShareHealth | null;
  /** Requests only: this record is frozen waiting for a decision. */
  conflicted?: boolean;
  protocol?: ApiProtocol;
  method?: string;
  renaming: boolean;
  dragging: boolean;
  /** The pointer is aiming *into* this container, as opposed to at a gap beside it. */
  dropInto: boolean;
  onActivate: () => void;
  onMenu: (x: number, y: number) => void;
  /** Containers only: the inline "+" that starts a new request without opening the menu. */
  onQuickAdd?: () => void;
  onBeginDrag?: (e: React.PointerEvent<HTMLElement>) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  /** True once, right after a drag, so the trailing click doesn't also open the request. */
  suppressClick: () => boolean;
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  pinned,
  onTogglePin,
  share,
  conflicted,
  protocol,
  method,
  renaming,
  dragging,
  dropInto,
  onActivate,
  onMenu,
  onQuickAdd,
  onBeginDrag,
  onRename,
  onCancelRename,
  suppressClick,
}: TreeRowProps) {
  const t = useT();
  const hoverKey = `api:${node.id}`;
  // Only this row and the one being left re-render when the pointer moves between them, which is
  // what makes tracking hover in state affordable on a tree this size.
  const isHovered = useRowHoverStore((s) => s.key === hoverKey);
  const anyDrag = useApiDragStore((s) => s.drag !== null);
  const isContainer = node.kind !== "request";

  return (
    <div
      data-cf-apirow={node.id}
      data-cf-apikind={node.kind}
      data-cf-apicol={node.collectionId}
      data-cf-apiparent={node.parentId ?? ""}
      role="treeitem"
      aria-expanded={isContainer || onToggle ? expanded : undefined}
      title={node.name}
      // A div rather than a button because the row carries its own "…" button, and a button
      // inside a button is invalid — so focus and the Enter/Space activation come back by hand.
      tabIndex={renaming ? -1 : 0}
      onPointerDown={onBeginDrag}
      onPointerEnter={() => useRowHoverStore.getState().enter(hoverKey)}
      onPointerLeave={() => useRowHoverStore.getState().leave(hoverKey)}
      // Kills the browser's own press-and-sweep text selection without costing the `click` that
      // follows — preventing it on `pointerdown` would suppress that too.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (suppressClick()) return;
        onActivate();
      }}
      onKeyDown={(e) => {
        if (renaming || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      style={{ paddingLeft: depth * INDENT + ROW_PAD }}
      className={`group relative flex cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-1 text-[13px] ${
        // Nothing but the drop target lights up while a drag is in flight.
        isHovered && !anyDrag ? "cf-row-hover" : ""
      } ${
        dropInto ? "bg-[var(--cf-accent-soft)] ring-1 ring-inset ring-[var(--cf-accent)]" : ""
      } ${dragging ? "opacity-40" : ""}`}
    >
      <IndentGuides depth={depth} />

      {isContainer ? (
        <>
          <span style={{ width: TWISTY_W }} className="flex shrink-0 justify-center">
            {expanded ? (
              <ChevronDown size={12} className="text-[var(--cf-text-muted)]" />
            ) : (
              <ChevronRight size={12} className="text-[var(--cf-text-muted)]" />
            )}
          </span>
          <GlyphSlot>
            {node.kind === "collection" ? (
              <Boxes size={13} className="text-[var(--cf-accent)]" />
            ) : expanded ? (
              <FolderOpen size={13} className="text-[var(--cf-text-muted)]" />
            ) : (
              <Folder size={13} className="text-[var(--cf-text-muted)]" />
            )}
          </GlyphSlot>
        </>
      ) : (
        <>
          {/* A request is a leaf until it has examples, and then it unfolds like a container —
              except the row itself still opens the request, so the twisty takes its own click. */}
          {onToggle ? (
            <button
              title={t("api.example.toggle")}
              aria-label={t("api.example.toggle")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              style={{ width: TWISTY_W }}
              className="flex shrink-0 items-center justify-center text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span style={{ width: TWISTY_W }} className="shrink-0" />
          )}
          <MethodBadge protocol={protocol ?? "http"} method={method ?? "GET"} />
        </>
      )}

      {renaming ? (
        <input
          autoFocus
          defaultValue={node.name}
          // The row above swallows presses to stop text selection and to arm the drag; the input
          // has to opt out of both or it can never take focus or a caret.
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRename(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={onCancelRename}
          className="min-w-0 flex-1 rounded-sm border border-[var(--cf-accent)] bg-[var(--cf-bg)] px-1 py-0 text-[13px] text-[var(--cf-text)] outline-none"
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate ${
            node.kind === "request" ? "text-[var(--cf-text)]" : "font-medium text-[var(--cf-text)]"
          }`}
        >
          {node.name || t("api.untitledRequest")}
        </span>
      )}

      {/* Shared, and how it is going — one glyph rather than a row of tags, because the sidebar's
          job is the tree and collaboration is a property of it, not a second thing in it. */}
      {share && (
        <span
          title={
            share === "conflict"
              ? t("api.collab.rowConflict")
              : share === "error"
                ? t("api.collab.rowError")
                : share === "paused"
                  ? t("api.collab.rowPaused")
                  : share === "syncing"
                    ? t("api.collab.syncing")
                    : t("api.collab.rowShared")
          }
          className={`flex h-4 w-4 shrink-0 items-center justify-center ${
            share === "conflict" || share === "error" || share === "paused"
              ? "text-[var(--cf-warning)]"
              : share === "syncing"
                ? "animate-pulse text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)]"
          }`}
        >
          {share === "conflict" ? <ShieldAlert size={12} /> : share === "paused" ? <PauseCircle size={12} /> : <Users size={12} />}
        </span>
      )}
      {conflicted && (
        <span
          title={t("api.collab.rowConflict")}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--cf-warning)]"
        >
          <ShieldAlert size={12} />
        </span>
      )}

      {/* The one control here that stays lit when it's off-hover: a pin is state, not an action,
          and it's the reason the row is where it is in the list. */}
      {onTogglePin && (
        <button
          title={pinned ? t("api.unpinCollection") : t("api.pinCollection")}
          aria-label={pinned ? t("api.unpinCollection") : t("api.pinCollection")}
          aria-pressed={pinned}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${
            pinned
              ? "text-[var(--cf-accent)]"
              : "text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-text)] group-hover:opacity-100"
          }`}
        >
          <Star size={12} fill={pinned ? "currentColor" : "none"} />
        </button>
      )}

      {/* Creating a request is the overwhelmingly common thing to do to a collection, and it was
          two clicks behind the menu. Sits left of the overflow, revealed on hover like it. */}
      {onQuickAdd && (
        <button
          title={t("api.newRequest")}
          aria-label={t("api.newRequest")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onQuickAdd();
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-text)] group-hover:opacity-100"
        >
          <Plus size={13} />
        </button>
      )}

      <button
        title={t("api.moreActions")}
        aria-label={t("api.moreActions")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu(rect.left, rect.bottom + 2);
        }}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-text)] group-hover:opacity-100"
      >
        <MoreHorizontal size={13} />
      </button>
    </div>
  );
}

/**
 * One saved example, nested under the request it was captured from.
 *
 * Deliberately outside the drag system: an example belongs to its request and can't be filed
 * anywhere else, so it carries none of the `data-cf-api*` markers the hit-test reads and never
 * arms a drag.
 */
function ExampleRow({
  example,
  depth,
  active,
  renaming,
  onActivate,
  onMenu,
  onRename,
  onCancelRename,
}: {
  example: SavedExample;
  depth: number;
  /** This example is the one the active tab is currently showing. */
  active: boolean;
  renaming: boolean;
  onActivate: () => void;
  onMenu: (x: number, y: number) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const t = useT();
  const hoverKey = `api-example:${example.id}`;
  const isHovered = useRowHoverStore((s) => s.key === hoverKey);
  const anyDrag = useApiDragStore((s) => s.drag !== null);

  return (
    <div
      role="treeitem"
      title={example.name}
      tabIndex={renaming ? -1 : 0}
      onPointerEnter={() => useRowHoverStore.getState().enter(hoverKey)}
      onPointerLeave={() => useRowHoverStore.getState().leave(hoverKey)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (renaming || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      style={{ paddingLeft: depth * INDENT + ROW_PAD }}
      className={`group relative flex cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-1 text-[13px] ${
        active ? "bg-[var(--cf-accent-soft)]" : isHovered && !anyDrag ? "cf-row-hover" : ""
      }`}
    >
      <IndentGuides depth={depth} />
      <span style={{ width: TWISTY_W }} className="flex shrink-0 justify-center">
        <Bookmark size={11} className="text-[var(--cf-text-muted)]" />
      </span>
      <span
        style={{ color: statusColor(example.status), width: GLYPH_W }}
        className="shrink-0 truncate text-right font-mono text-[9px] font-bold leading-none tracking-tight"
      >
        {example.status}
      </span>

      {renaming ? (
        <input
          autoFocus
          defaultValue={example.name}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRename(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={onCancelRename}
          className="min-w-0 flex-1 rounded-sm border border-[var(--cf-accent)] bg-[var(--cf-bg)] px-1 py-0 text-[13px] text-[var(--cf-text)] outline-none"
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate ${
            active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
          }`}
        >
          {example.name || t("api.example.untitled")}
        </span>
      )}

      <button
        title={t("api.moreActions")}
        aria-label={t("api.moreActions")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu(rect.left, rect.bottom + 2);
        }}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-text)] group-hover:opacity-100"
      >
        <MoreHorizontal size={13} />
      </button>
    </div>
  );
}

function DraftRow({
  kind,
  depth,
  onSubmit,
  onCancel,
}: {
  kind: "folder" | "request";
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div
      style={{ paddingLeft: depth * INDENT + ROW_PAD }}
      className="relative flex items-center gap-1.5 py-0.5 pr-2 text-[13px]"
    >
      <IndentGuides depth={depth} />
      <span style={{ width: TWISTY_W }} className="shrink-0" />
      <GlyphSlot>
        {kind === "folder" ? (
          <Folder size={13} className="text-[var(--cf-text-muted)]" />
        ) : (
          <FilePlus size={13} className="text-[var(--cf-text-muted)]" />
        )}
      </GlyphSlot>
      <input
        autoFocus
        placeholder={t(kind === "folder" ? "api.untitledFolder" : "api.untitledRequest")}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        // Clicking away abandons the entry rather than committing it — a half-typed name losing
        // focus shouldn't leave a stray request behind.
        onBlur={onCancel}
        className="min-w-0 flex-1 rounded-sm border border-[var(--cf-accent)] bg-[var(--cf-bg)] px-1 py-0 text-[13px] text-[var(--cf-text)] outline-none"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export function CollectionTree() {
  const t = useT();
  const collections = useApiStore((s) => s.collections);
  const folders = useApiStore((s) => s.folders);
  const requests = useApiStore((s) => s.requests);

  const activeTabId = useApiStore((s) => s.activeTabId);
  // Which example the tab on screen is reading, so the tree can point at it.
  const activeExampleId = useApiRuntimeStore((s) =>
    activeTabId ? (s.exampleViews[activeTabId]?.exampleId ?? null) : null,
  );

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<NodeRef | null>(null);
  const [renamingExample, setRenamingExample] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeRef } | null>(null);
  const [exampleMenu, setExampleMenu] = useState<{
    x: number;
    y: number;
    requestId: string;
    example: SavedExample;
  } | null>(null);
  const openModal = useApiModalStore((s) => s.openApiModal);
  const pushToast = useToastStore((s) => s.pushToast);

  // Reduced to id sets here rather than selected as sets in the store: a selector that builds a
  // new Set every call is a new reference every render, which is the shape zustand re-renders on
  // forever. The source arrays only change when a sync round actually applied something.
  const shares = useCollabStore((s) => s.shares);
  const conflicts = useCollabStore((s) => s.conflicts);
  const shareHealth = useCollabStore((s) => s.health);
  // `health` folds in `syncAuto`, which lives in another store — subscribed here so flipping the
  // toggle repaints the glyphs instead of leaving them stale until something else re-renders.
  useApiStore((s) => s.settings.syncAuto);
  const sharedIds = useMemo(() => new Set(shares.map((share) => share.collection_id)), [shares]);
  const conflictedIds = useMemo(
    () => new Set(conflicts.filter((c) => c.kind === "request").map((c) => c.id)),
    [conflicts],
  );

  const drag = useApiDragStore((s) => s.drag);
  const over = useApiDragStore((s) => s.over);
  const origin = useApiDragStore((s) => s.origin);

  // Pinned first, then the workspace's own order within each group — so pinning is a promotion,
  // not a reshuffle: unpin and a collection drops back exactly where it was.
  const ordered = useMemo(
    () =>
      [...collections].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || a.sort_order - b.sort_order,
      ),
    [collections],
  );
  const grouped = useMemo(() => groupTree(folders, requests), [folders, requests]);

  // Parsed per change to `requests`, not per render: `spec` is a JSON blob and this tree
  // re-renders on every pointer move during a drag. Rows without examples stay out of the map so
  // the common case is a miss, not an empty array.
  const examplesByRequest = useMemo(() => {
    const map = new Map<string, SavedExample[]>();
    for (const row of requests) {
      const examples = readExamples(row);
      if (examples.length > 0) map.set(row.id, examples);
    }
    return map;
  }, [requests]);

  // The drag's hit-test runs on every pointer move and needs the same grouping the render used;
  // a ref keeps it reading the current one without rebuilding the maps per move.
  const groupedRef = useRef(grouped);
  groupedRef.current = grouped;
  const suppressClickRef = useRef(false);
  const renamingRef = useRef<NodeRef | null>(renaming);
  renamingRef.current = renaming;
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const childFolders = (collectionId: string, parentId: string | null) =>
    grouped.folders.get(containerKey(collectionId, parentId)) ?? [];
  const childRequests = (collectionId: string, parentId: string | null) =>
    grouped.requests.get(containerKey(collectionId, parentId)) ?? [];

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const expand = (id: string) =>
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

  // ---------- mutations ----------

  const startDraft = (kind: "folder" | "request", collectionId: string, parentId: string | null) => {
    expand(parentId ?? collectionId);
    setDraft({ kind, collectionId, parentId });
  };

  const submitDraft = async (name: string) => {
    if (!draft) return;
    const trimmed = name.trim();
    setDraft(null);
    const state = useApiStore.getState();
    if (draft.kind === "folder") {
      await state.createFolder(draft.collectionId, draft.parentId, trimmed || t("api.untitledFolder"));
      return;
    }
    const created = await state.createRequest(
      draft.collectionId,
      draft.parentId,
      trimmed || t("api.untitledRequest"),
      defaultRequestSpec(),
    );
    // A request you just named is a request you want to edit, so it opens straight away.
    if (created) useApiStore.getState().openRequest(created.id);
  };

  const commitRename = async (node: NodeRef, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === node.name) return;
    const state = useApiStore.getState();
    if (node.kind === "collection") {
      const collection = state.collections.find((c) => c.id === node.id);
      if (collection) await state.updateCollection({ ...collection, name: trimmed });
    } else if (node.kind === "folder") {
      const folder = state.folders.find((f) => f.id === node.id);
      if (folder) await state.updateFolder({ ...folder, name: trimmed });
    } else {
      const request = state.requests.find((r) => r.id === node.id);
      if (request) await state.updateRequest({ ...request, name: trimmed });
    }
  };

  const remove = async (node: NodeRef) => {
    const message =
      node.kind === "collection"
        ? t("api.deleteCollectionConfirm", { name: node.name })
        : node.kind === "folder"
          ? t("api.deleteFolderConfirm", { name: node.name })
          : t("api.deleteRequestConfirm", { name: node.name });
    if (!(await confirmAction(message, true, t("api.delete")))) return;
    const state = useApiStore.getState();
    if (node.kind === "collection") await state.deleteCollection(node.id);
    else if (node.kind === "folder") await state.deleteFolder(node.id);
    else await state.deleteRequest(node.id);
  };

  // ---------- examples ----------

  /** Read from the store rather than the render's map, since these run after an `await`. */
  const currentExamples = (requestId: string): SavedExample[] => {
    const row = useApiStore.getState().requests.find((r) => r.id === requestId);
    return row ? readExamples(row) : [];
  };

  const openExample = (requestId: string, example: SavedExample) => {
    useApiStore.getState().openRequest(requestId);
    // `openRequest` is synchronous, so the tab it opened (or focused) is already there.
    const tab = useApiStore.getState().openTabs.find((t) => t.requestId === requestId);
    if (tab) useApiRuntimeStore.getState().showExample(tab.id, example);
  };

  /** Runs `update` over every tab that happens to be reading `exampleId` right now. */
  const forEachViewer = (exampleId: string, update: (tabId: string) => void) => {
    for (const [tabId, view] of Object.entries(useApiRuntimeStore.getState().exampleViews)) {
      if (view.exampleId === exampleId) update(tabId);
    }
  };

  const renameExample = async (requestId: string, example: SavedExample, name: string) => {
    setRenamingExample(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === example.name) return;
    const renamed = { ...example, name: trimmed };
    await useApiStore
      .getState()
      .setRequestExamples(
        requestId,
        currentExamples(requestId).map((e) => (e.id === example.id ? renamed : e)),
      );
    // The banner in the response panel names the example it's showing; leaving it on the old
    // name would be the one place in the app still calling it that.
    forEachViewer(example.id, (tabId) => useApiRuntimeStore.getState().showExample(tabId, renamed));
  };

  const deleteExample = async (requestId: string, example: SavedExample) => {
    const message = t("api.example.deleteConfirm", { name: example.name });
    if (!(await confirmAction(message, true, t("api.delete")))) return;
    await useApiStore
      .getState()
      .setRequestExamples(
        requestId,
        currentExamples(requestId).filter((e) => e.id !== example.id),
      );
    forEachViewer(example.id, (tabId) => useApiRuntimeStore.getState().closeExample(tabId));
  };

  const exampleMenuItems = (requestId: string, example: SavedExample): MenuItem[] => [
    { label: t("api.rename"), icon: Pencil, onClick: () => setRenamingExample(example.id) },
    {
      label: t("api.delete"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () => void deleteExample(requestId, example),
    },
  ];

  const copyInvite = async (collectionId: string, name: string) => {
    const token = await useCollabStore.getState().tokenFor(collectionId);
    if (token === null) return;
    const key = (await supabaseAnonKey().catch(() => null)) ?? "";
    await navigator.clipboard.writeText(
      encodeInvite({ url: useApiStore.getState().settings.supabaseUrl, key, token, name }),
    );
    pushToast(t("api.collab.inviteCopied"), "success");
  };

  const stopSharing = async (collectionId: string, name: string) => {
    if (!(await confirmAction(t("api.collab.leaveConfirm", { name })))) return;
    await useCollabStore.getState().leave(collectionId);
  };

  const menuItems = (node: NodeRef): MenuItem[] => {
    const items: MenuItem[] = [];
    if (node.kind !== "request") {
      const parentId = node.kind === "collection" ? null : node.id;
      items.push({
        label: t("api.newRequest"),
        icon: FilePlus,
        onClick: () => startDraft("request", node.collectionId, parentId),
      });
      items.push({
        label: t("api.newFolder"),
        icon: FolderPlus,
        onClick: () => startDraft("folder", node.collectionId, parentId),
      });
      items.push({
        label: t("api.runner.run"),
        icon: Play,
        separated: true,
        onClick: () => openModal({ kind: "runner", collectionId: node.collectionId, folderId: parentId }),
      });
    }
    if (node.kind === "collection") {
      const pinned = collections.find((c) => c.id === node.id)?.pinned ?? false;
      items.push({
        label: pinned ? t("api.unpinCollection") : t("api.pinCollection"),
        icon: Star,
        separated: true,
        onClick: () => void useApiStore.getState().toggleCollectionPinned(node.id),
      });
      items.push({
        label: t("api.export.title"),
        icon: Share2,
        onClick: () => openModal({ kind: "export", collectionId: node.id }),
      });
      if (sharedIds.has(node.id)) {
        items.push({
          label: t("api.collab.copyInvite"),
          icon: Link2,
          separated: true,
          onClick: () => void copyInvite(node.id, node.name),
        });
        items.push({
          label: t("api.collab.syncNow"),
          icon: RefreshCw,
          onClick: () => void syncCollection(node.id).catch(() => {}),
        });
        items.push({
          label: t("api.collab.leave"),
          icon: Unlink,
          onClick: () => void stopSharing(node.id, node.name),
        });
      } else {
        // Straight to the collaboration settings rather than a modal of its own: sharing a
        // collection is a decision about the whole setup — which project, which workspaces are
        // already sharing what — and a one-off dialog showed a single collection with none of it.
        items.push({
          label: t("api.collab.shareCollection"),
          icon: Users,
          separated: true,
          onClick: () => openModal({ kind: "settings", tab: "collab" }),
        });
      }
    }
    items.push({
      label: t("api.rename"),
      icon: Pencil,
      separated: node.kind !== "request",
      onClick: () => setRenaming(node),
    });
    if (node.kind !== "folder") {
      items.push({
        label: t("api.duplicate"),
        icon: Copy,
        onClick: () =>
          node.kind === "collection"
            ? void useApiStore.getState().duplicateCollection(node.id)
            : void useApiStore.getState().duplicateRequest(node.id),
      });
    }
    items.push({ label: t("api.delete"), icon: Trash2, danger: true, separated: true, onClick: () => void remove(node) });
    return items;
  };

  // ---------- drag ----------

  /**
   * Where a drop at (x, y) would land, or `null` when it can't land there.
   *
   * The pointer is hit-tested against the rows' `data-cf-api*` markers rather than tracked with
   * per-row handlers, which is what lets a row stand in for a slot beside it: the top and bottom
   * slivers of a folder aim at the gaps around it, the middle aims inside, and a request — which
   * can't contain anything — splits cleanly in half.
   */
  const zoneAt = (x: number, y: number, dragged: ApiDrag): ApiDropZone | null => {
    const element = document.elementFromPoint(x, y);
    const row = element?.closest<HTMLElement>("[data-cf-apirow]") ?? null;
    const kind = row?.dataset.cfApikind as ApiNodeKind | undefined;
    const id = row?.dataset.cfApirow;
    if (!row || !kind || !id) return null;

    const list = (collectionId: string, parentId: string | null) =>
      dragged.kind === "folder"
        ? (groupedRef.current.folders.get(containerKey(collectionId, parentId)) ?? [])
        : (groupedRef.current.requests.get(containerKey(collectionId, parentId)) ?? []);

    const into = (collectionId: string, parentId: string | null): ApiDropZone => {
      const siblings = list(collectionId, parentId);
      const at = siblings.findIndex((n) => n.id === dragged.id);
      return { collectionId, parentId, index: storeIndex(siblings.length, at), mode: "into" };
    };

    const between = (
      collectionId: string,
      parentId: string | null,
      rowKind: "folder" | "request",
      rowId: string,
      side: "before" | "after",
    ): ApiDropZone => {
      const siblings = list(collectionId, parentId);
      const at = siblings.findIndex((n) => n.id === dragged.id);
      let gap: number;
      if (rowKind === dragged.kind) {
        const index = siblings.findIndex((n) => n.id === rowId);
        gap = index < 0 ? siblings.length : side === "before" ? index : index + 1;
      } else {
        // Folders always render above requests inside a container, so a gap in the *other* list
        // resolves to this one's near edge. The indicator then redraws where the node really
        // lands, rather than lying about the slot the pointer happens to be in.
        gap = dragged.kind === "folder" ? siblings.length : 0;
      }
      return { collectionId, parentId, index: storeIndex(gap, at), mode: "between" };
    };

    const collectionId = kind === "collection" ? id : (row.dataset.cfApicol ?? "");
    const parentId = row.dataset.cfApiparent ? row.dataset.cfApiparent : null;
    const rect = row.getBoundingClientRect();
    const fraction = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;

    let zone: ApiDropZone;
    if (kind === "collection") {
      zone = into(id, null);
    } else if (kind === "folder") {
      if (fraction < EDGE_FRACTION) zone = between(collectionId, parentId, "folder", id, "before");
      else if (fraction > 1 - EDGE_FRACTION) zone = between(collectionId, parentId, "folder", id, "after");
      else zone = into(collectionId, id);
    } else {
      zone = between(collectionId, parentId, "request", id, fraction < 0.5 ? "before" : "after");
    }
    return canDrop(dragged, zone, useApiStore.getState().folders) ? zone : null;
  };

  const isCurrentSlot = (dragged: ApiDrag, zone: ApiDropZone): boolean => {
    const siblings =
      dragged.kind === "folder"
        ? (groupedRef.current.folders.get(containerKey(zone.collectionId, zone.parentId)) ?? [])
        : (groupedRef.current.requests.get(containerKey(zone.collectionId, zone.parentId)) ?? []);
    const at = siblings.findIndex((n) => n.id === dragged.id);
    return at >= 0 && at === zone.index;
  };

  const beginDrag = (e: React.PointerEvent<HTMLElement>, node: NodeRef) => {
    if (e.button !== 0 || node.kind === "collection" || renamingRef.current) return;
    const from = { x: e.clientX, y: e.clientY };
    const dragged: ApiDrag = {
      kind: node.kind === "folder" ? "folder" : "request",
      id: node.id,
      collectionId: node.collectionId,
      name: node.name,
    };
    let started = false;
    let spring: { id: string; timer: number } | null = null;

    /** Rests the pointer on a container long enough and it opens — otherwise a folder that starts
     * collapsed can never be dropped into. */
    const armSpring = (id: string | null) => {
      if (spring?.id === id) return;
      if (spring) clearTimeout(spring.timer);
      spring = null;
      if (id === null) return;
      spring = { id, timer: window.setTimeout(() => expand(id), SPRING_LOAD_MS) };
    };

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_THRESHOLD) return;
        started = true;
        suppressClickRef.current = true;
        setDragCursor(true);
        useApiDragStore.getState().start(dragged, ev.clientX, ev.clientY);
      }
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      }
      const zone = zoneAt(ev.clientX, ev.clientY, dragged);
      useApiDragStore.getState().hover(zone);
      armSpring(zone?.mode === "into" ? (zone.parentId ?? zone.collectionId) : null);
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      armSpring(null);
      if (!started) return;
      const zone = zoneAt(ev.clientX, ev.clientY, dragged);
      setDragCursor(false);
      useApiDragStore.getState().end();
      // Dropped on nothing droppable, or back where it started: the tree stays as it was rather
      // than paying a round trip to renumber a list into the order it already had.
      if (zone && !isCurrentSlot(dragged, zone)) {
        void useApiStore.getState().moveNode(dragged.kind, dragged.id, zone.collectionId, zone.parentId, zone.index);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const takeSuppressedClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  // ---------- render ----------

  /** The insertion line for one gap, or nothing when the pointer isn't aiming at it. */
  const dropLine = (
    collectionId: string,
    parentId: string | null,
    kind: "folder" | "request",
    gap: number,
    siblings: { id: string }[],
    depth: number,
  ) => {
    if (!drag || !over || over.mode !== "between" || drag.kind !== kind) return null;
    if (over.collectionId !== collectionId || over.parentId !== parentId) return null;
    const at = siblings.findIndex((n) => n.id === drag.id);
    // The gaps either side of the dragged row are the same slot; drawing both would put two lines
    // on screen for one destination.
    if (at >= 0 && gap === at + 1) return null;
    if (over.index !== storeIndex(gap, at)) return null;
    return (
      <div style={{ marginLeft: depth * INDENT + ROW_PAD }} className="relative h-0">
        <span className="pointer-events-none absolute -top-px left-0 right-2 h-[2px] rounded-full bg-[var(--cf-accent)]" />
      </div>
    );
  };

  const renderChildren = (collectionId: string, parentId: string | null, depth: number) => {
    const folderRows = childFolders(collectionId, parentId);
    const requestRows = childRequests(collectionId, parentId);
    const draftHere =
      draft && draft.collectionId === collectionId && draft.parentId === parentId ? draft : null;

    // Only a collection announces that it's empty; an empty folder just shows nothing, the way
    // every file explorer does.
    if (parentId === null && folderRows.length === 0 && requestRows.length === 0 && !draftHere && !drag) {
      return (
        <p
          style={{ paddingLeft: depth * INDENT + ROW_PAD }}
          className="py-0.5 text-[11px] text-[var(--cf-text-muted)]"
        >
          {t("api.noRequests")}
        </p>
      );
    }

    return (
      <>
        {draftHere && (
          <DraftRow
            kind={draftHere.kind}
            depth={depth}
            onSubmit={(name) => void submitDraft(name)}
            onCancel={() => setDraft(null)}
          />
        )}
        {folderRows.map((folder, i) => (
          <Fragment key={folder.id}>
            {dropLine(collectionId, parentId, "folder", i, folderRows, depth)}
            {renderFolder(folder, depth)}
          </Fragment>
        ))}
        {dropLine(collectionId, parentId, "folder", folderRows.length, folderRows, depth)}
        {requestRows.map((request, i) => (
          <Fragment key={request.id}>
            {dropLine(collectionId, parentId, "request", i, requestRows, depth)}
            {renderRequest(request, depth)}
          </Fragment>
        ))}
        {dropLine(collectionId, parentId, "request", requestRows.length, requestRows, depth)}
      </>
    );
  };

  const renderRequest = (request: ApiRequestRow, depth: number) => {
    const node: NodeRef = {
      kind: "request",
      id: request.id,
      collectionId: request.collection_id,
      parentId: request.folder_id,
      name: request.name,
    };
    const examples = examplesByRequest.get(request.id);
    const isExpanded = examples !== undefined && expanded.has(request.id);
    const row = (
      <TreeRow
        node={node}
        depth={depth}
        expanded={examples ? isExpanded : undefined}
        onToggle={examples ? () => toggle(request.id) : undefined}
        protocol={request.protocol}
        method={request.method}
        conflicted={conflictedIds.has(request.id)}
        renaming={renaming?.id === request.id}
        dragging={drag?.id === request.id}
        dropInto={false}
        onActivate={() => useApiStore.getState().openRequest(request.id)}
        onMenu={(x, y) => setMenu({ x, y, node })}
        onBeginDrag={(e) => beginDrag(e, node)}
        onRename={(name) => void commitRename(node, name)}
        onCancelRename={() => setRenaming(null)}
        suppressClick={takeSuppressedClick}
      />
    );
    if (!examples) return row;
    return (
      <div>
        {row}
        {isExpanded &&
          examples.map((example) => (
            <ExampleRow
              key={example.id}
              example={example}
              depth={depth + 1}
              active={activeExampleId === example.id}
              renaming={renamingExample === example.id}
              onActivate={() => openExample(request.id, example)}
              onMenu={(x, y) => setExampleMenu({ x, y, requestId: request.id, example })}
              onRename={(name) => void renameExample(request.id, example, name)}
              onCancelRename={() => setRenamingExample(null)}
            />
          ))}
      </div>
    );
  };

  const renderFolder = (folder: ApiFolder, depth: number) => {
    const node: NodeRef = {
      kind: "folder",
      id: folder.id,
      collectionId: folder.collection_id,
      parentId: folder.parent_id,
      name: folder.name,
    };
    const isExpanded = expanded.has(folder.id);
    return (
      <div>
        <TreeRow
          node={node}
          depth={depth}
          expanded={isExpanded}
          renaming={renaming?.id === folder.id}
          dragging={drag?.id === folder.id}
          dropInto={over?.mode === "into" && over.parentId === folder.id}
          onActivate={() => toggle(folder.id)}
          onMenu={(x, y) => setMenu({ x, y, node })}
          onQuickAdd={() => startDraft("request", folder.collection_id, folder.id)}
          onBeginDrag={(e) => beginDrag(e, node)}
          onRename={(name) => void commitRename(node, name)}
          onCancelRename={() => setRenaming(null)}
          suppressClick={takeSuppressedClick}
        />
        {isExpanded && renderChildren(folder.collection_id, folder.id, depth + 1)}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tree" className="min-h-0 flex-1 overflow-auto py-1">
        {ordered.length === 0 ? (
          <EmptyState icon={Boxes} title={t("api.noCollections")} />
        ) : (
          ordered.map((collection) => {
            const node: NodeRef = {
              kind: "collection",
              id: collection.id,
              collectionId: collection.id,
              parentId: null,
              name: collection.name,
            };
            const isExpanded = expanded.has(collection.id);
            return (
              <div key={collection.id}>
                <TreeRow
                  node={node}
                  depth={0}
                  expanded={isExpanded}
                  pinned={collection.pinned}
                  onTogglePin={() => void useApiStore.getState().toggleCollectionPinned(collection.id)}
                  share={sharedIds.has(collection.id) ? shareHealth(collection.id) : null}
                  renaming={renaming?.id === collection.id}
                  dragging={false}
                  dropInto={over?.mode === "into" && over.parentId === null && over.collectionId === collection.id}
                  onActivate={() => toggle(collection.id)}
                  onMenu={(x, y) => setMenu({ x, y, node })}
                  onQuickAdd={() => startDraft("request", collection.id, null)}
                  onRename={(name) => void commitRename(node, name)}
                  onCancelRename={() => setRenaming(null)}
                  suppressClick={takeSuppressedClick}
                />
                {isExpanded && renderChildren(collection.id, null, 1)}
              </div>
            );
          })
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} />
      )}

      {exampleMenu && (
        <ContextMenu
          x={exampleMenu.x}
          y={exampleMenu.y}
          items={exampleMenuItems(exampleMenu.requestId, exampleMenu.example)}
          onClose={() => setExampleMenu(null)}
        />
      )}

      {/* Portalled so no ancestor's `overflow` clips it, and click-through so it never becomes the
          element `elementFromPoint` finds under the cursor. */}
      {drag &&
        origin &&
        createPortal(
          <div
            ref={ghostRef}
            style={{ transform: `translate(${origin.x + 12}px, ${origin.y + 12}px)` }}
            className="pointer-events-none fixed left-0 top-0 z-[100] rounded-md border border-[var(--cf-accent)] bg-[var(--cf-surface)] px-2 py-1 text-[11px] text-[var(--cf-text)] shadow-lg"
          >
            {drag.name || t("api.untitledRequest")}
          </div>,
          document.body,
        )}
    </div>
  );
}
