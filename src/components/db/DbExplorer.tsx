import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Filter,
  Database,
  Eraser,
  FileCode2,
  FolderCode,
  FolderOpen,
  FolderPlus,
  Hash,
  KeyRound,
  LayoutList,
  Loader2,
  Network,
  Pencil,
  Play,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Table2,
  Trash,
  Trash2,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { ResizeHandle } from "../common/ResizeHandle";
import { ActivePill } from "../common/ActivePill";
import { CARD, ConnectionDot, ToolbarButton, engineColor, engineIcon, nodeIcon } from "./dbChrome";
import { DbHistoryList } from "./DbHistoryList";
import { EngineMenu, menuAnchor } from "./EngineMenu";
import { effectiveObjectFilter, schemaIsNarrowed } from "../../lib/db/objectFilter";
import {
  describeConnection,
  groupConnections,
  nodeKey,
  parseSpec,
  UNGROUPED,
  useDbStore,
  type DbSidebarSection,
} from "../../state/dbStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useDbDragStore } from "../../state/dbDragStore";
import { useDbObjectDragStore } from "../../state/dbObjectDragStore";
import { DRAG_THRESHOLD, setDragCursor } from "../../lib/pointerDrag";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { dbChildren } from "../../lib/tauri/dbCommands";
import { riseDelay } from "../../lib/rise";
import {
  createTemplate,
  objectReference,
  sqlTemplate,
  type SqlTemplate,
} from "../../lib/db/sqlTemplates";
import {
  engineInfo,
  type DbConnectionRow,
  type DbConsole,
  type DbNode,
  type DbNodeKind,
  type DbNodeRef,
} from "../../types/database";

/**
 * What a schema's filter menu offers, in order.
 *
 * Tables first because that is the answer nine times in ten, and "everything" last because it is the
 * blunt one — a pattern written there covers the folders that have none of their own. The four
 * folders are exactly the ones the backend narrows in `filter_children`; column, index and key
 * folders hold parts of an object rather than objects, and filtering those by name is a list nobody
 * asks for.
 */
const FILTERABLE_FOLDERS: {
  folder: DbNodeKind | null;
  label: TranslationKey;
  separated?: boolean;
}[] = [
  { folder: "table_folder", label: "db.catTables" },
  { folder: "view_folder", label: "db.catViews" },
  { folder: "routine_folder", label: "db.catRoutines" },
  { folder: "sequence_folder", label: "db.catSequences" },
  { folder: null, label: "db.filterEverythingHere", separated: true },
];

/** The folder kinds a filter can sit on, for the "is this list narrowed?" lookup. */
const FOLDER_FILTER_KINDS = new Set<DbNodeKind>([
  "table_folder",
  "view_folder",
  "routine_folder",
  "sequence_folder",
]);

const WIDTH_MIN = 220;
const WIDTH_MAX = 520;

/** Beyond this the result list stops being a list; the query wants narrowing, not more scrolling. */
const MAX_RESULTS = 200;

/**
 * The database explorer: connections, and lazily what is inside them.
 *
 * The tree is **not** a model of the database — it is a cache of what the server last said was under
 * each node (see `dbStore`). Nothing derives structure from it, so a table created in a console
 * shows up as soon as its folder is refreshed, and there is no stale-tree state to reconcile.
 */

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

function TreeRow({
  depth,
  at = 0,
  icon,
  name,
  detail,
  expandable,
  expanded,
  loading,
  active,
  onToggle,
  onOpen,
  onSelect,
  onKeyDown,
  onContextMenu,
  leading,
  badge,
  color,
  title,
  drag,
  dropTarget,
}: {
  depth: number;
  /** Place among the rows it arrives with — all the entry animation needs to stagger. */
  at?: number;
  icon: React.ReactNode;
  name: string;
  detail?: string;
  /** Hover text for the whole row, for what is worth keeping but not worth a line of its own. */
  title?: string;
  expandable: boolean;
  expanded: boolean;
  loading?: boolean;
  active?: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  /** Single click. Only the connection rows take one — it is what the ordering arrows act on. */
  onSelect?: () => void;
  /** Keys the row itself doesn't handle: `Alt`+arrows on a connection, and nothing anywhere else. */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  leading?: React.ReactNode;
  /** A mark after the name — today only "what is under here is filtered". After the name and not
   * before it so the names of sibling rows still line up. */
  badge?: React.ReactNode;
  color?: string;
  /** Pointer plumbing for the rows that can be dragged. Spread onto the row rather than handled
   * here, so a row that isn't draggable carries no handlers at all.
   *
   * Two kinds of row use it and they need different halves: a connection is dragged *and* dropped
   * onto, so it wires all four; a table is only ever dragged *out* — into a console — and wires the
   * first two. Hence every handler being optional. */
  drag?: {
    onPointerDown?: (e: React.PointerEvent) => void;
    onPointerMove?: (e: React.PointerEvent) => void;
    onPointerEnter?: () => void;
    onPointerUp?: () => void;
  };
  /** Drawn as the line a drop would land on. Omitted entirely by rows nothing lands on. */
  dropTarget?: boolean;
}) {
  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={active}
      title={title}
      tabIndex={0}
      {...drag}
      // A click *selects*, it never expands: expanding is the chevron's job alone. A single click on
      // the row used to toggle, which made every attempt to point at a node fold or unfold it — and
      // on a slow connection, expanding is a round trip, so brushing past a schema went and fetched
      // it. Selecting costs nothing and reaches nothing.
      onClick={onSelect}
      // Falls back to the chevron's job only for a node that *has* one — a folder with no open
      // action of its own. On a leaf (a column, a key) there is nothing to expand, and calling
      // toggle there would send a fetch for children that cannot exist.
      onDoubleClick={() => {
        if (onOpen) onOpen();
        else if (expandable) onToggle();
      }}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (onOpen) onOpen();
          else if (expandable) onToggle();
        } else if (e.key === "ArrowRight" && expandable && !expanded) {
          e.preventDefault();
          onToggle();
        } else if (e.key === "ArrowLeft" && expandable && expanded) {
          e.preventDefault();
          onToggle();
        } else {
          onKeyDown?.(e);
        }
      }}
      style={{ paddingLeft: 6 + depth * 12, ...riseDelay(at) }}
      // The insertion point is the row's own top border rather than a floating line: the tree has
      // no spare pixels between rows, and a border that is transparent when idle keeps every row
      // exactly where it was — a drag that shifted the list under the pointer would move the target
      // out from under it.
      className={`cf-rise group flex w-full cursor-default items-center gap-1 rounded-md py-[3px] pr-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
        // Only the rows that can be dropped onto carry the border, transparent or not: giving it to
        // every row would add a pixel to each of the hundreds a schema can hold, for a line that
        // only ever draws on a connection. Keyed off `dropTarget` rather than off `drag`, because a
        // table row is draggable without being droppable — it would otherwise have paid the pixel.
        dropTarget !== undefined
          ? dropTarget
            ? "border-t border-[var(--cf-accent)]"
            : "border-t border-transparent"
          : ""
      } ${
        active
          ? "bg-[var(--cf-accent-soft)]"
          : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      {/* The only thing that expands. `stopPropagation` so a double click here folds and unfolds
          rather than also firing the row's open action. */}
      <span
        onClick={(e) => {
          if (!expandable) return;
          e.stopPropagation();
          onToggle();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        // The *press* stops here too, and it has to: a draggable row captures the pointer on
        // `pointerdown`, and a captured pointer retargets the `click` to whatever holds the capture
        // — so the chevron's own click was being delivered to the row instead, and toggling never
        // ran. That left the connection rows with no way to expand at all: theirs is the one level
        // of the tree whose double click opens a console rather than falling back to the chevron.
        // The cost is that the chevron is not a drag handle, which is the right way round anyway.
        onPointerDown={(e) => e.stopPropagation()}
        aria-hidden={!expandable}
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-muted)] ${
          expandable ? "cursor-pointer hover:text-[var(--cf-text)]" : ""
        }`}
      >
        {loading ? (
          <Loader2 size={11} className="animate-spin" />
        ) : expandable ? (
          expanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )
        ) : null}
      </span>
      {leading}
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" style={{ color }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--cf-text)]">{name}</span>
      {badge}
      {detail && (
        <span className="max-w-[45%] shrink-0 truncate text-[11px] text-[var(--cf-text-muted)]">
          {detail}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The lazy subtree
// ---------------------------------------------------------------------------

function refOf(node: DbNode): DbNodeRef {
  return {
    kind: node.kind,
    database: node.database,
    schema: node.schema,
    // A column/index/key node's *own* name isn't what identifies its parent relation, so folders
    // and children under a table carry the table through `name`. For a relation, both are the same.
    name: node.kind === "column" || node.kind === "index" || node.kind === "key"
      ? node.table
      : node.table ?? node.name,
  };
}

/**
 * A drag released over a row or a heading.
 *
 * One helper rather than the logic inlined at both call sites, because ending the drag is the part
 * that must happen whatever the drop turns out to be — including the drop onto itself, which is the
 * commonest one: a click that travelled five pixels.
 */
function useDbDrop() {
  const dropConnection = useDbStore((s) => s.dropConnection);
  const endDrag = useDbDragStore((s) => s.end);

  return (group: string, beforeConnectionId: string | null) => {
    const drag = useDbDragStore.getState().drag;
    endDrag();
    setDragCursor(false);
    if (!drag || drag.connectionId === beforeConnectionId) return;
    void dropConnection(drag.connectionId, group, beforeConnectionId);
  };
}

function NodeSubtree({
  connectionId,
  node,
  depth,
  at,
}: {
  connectionId: string;
  node: DbNode;
  depth: number;
  at: number;
}) {
  const t = useT();
  const nodeRef = useMemo(() => refOf(node), [node]);
  const key = nodeKey(connectionId, nodeRef);
  const expanded = useDbStore((s) => s.expanded.includes(key));
  const loading = useDbStore((s) => s.loadingNodes.includes(key));
  const children = useDbStore((s) => s.children[key]);
  const error = useDbStore((s) => s.nodeErrors[key]);
  const openModal = useDbModalStore((s) => s.openDbModal);
  const dragPress = useDbObjectDragStore((s) => s.press);
  const dragBegin = useDbObjectDragStore((s) => s.begin);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** The second menu: which statement to draft, once "Generate SQL" has been picked. */
  const [generateMenu, setGenerateMenu] = useState<{ x: number; y: number } | null>(null);
  /** The other second menu: which of a schema's folders to narrow. */
  const [filterMenu, setFilterMenu] = useState<{ x: number; y: number } | null>(null);
  /**
   * The connection's own row, for reading the filters off it.
   *
   * Subscribed to the *row*, with the parse outside the selector. `parseSpec` runs `JSON.parse` and
   * spreads defaults over it, so it hands back a new object every call — a selector that returned
   * one was a snapshot that never compared equal to itself, which is `useSyncExternalStore`'s
   * definition of an infinite loop. It took the whole tree down with "Maximum update depth exceeded"
   * as soon as one node mounted. `find` returns the row object itself, stable until the connection
   * is actually rewritten.
   */
  const connectionRow = useDbStore((s) => s.connections.find((c) => c.id === connectionId) ?? null);
  /**
   * What is narrowing whatever this node lists, or `null` when nothing is.
   *
   * A tree that quietly shows nine of ninety tables is the worst thing this feature can do, and the
   * one question it leaves the user with — "is this everything?" — has no answer anywhere on screen.
   * This is that answer, on the row whose children are short.
   */
  const narrowing = useMemo(() => {
    const config = connectionRow ? parseSpec(connectionRow) : null;
    if (!config) return null;
    if (node.kind === "database") {
      // The pattern only. `schemas_filtered` says the tick-list *counts* as a filter, not that it
      // hides anything — with every schema ticked it hides nothing, and there is no way to tell from
      // here: the tree only knows the schemas that already survived it. Marking the row on that flag
      // put a badge on a list nothing was missing from, which is worse than no badge at all.
      const pattern = config.schema_filter.trim();
      return config.schema_filter_enabled && pattern ? pattern : null;
    }
    if (node.kind === "schema") {
      if (!schemaIsNarrowed(config, node.name)) return null;
      // The pattern where one covers the whole schema. Where only some of its folders are narrowed
      // there is no single pattern to name, and saying which is the folder rows' own job.
      return effectiveObjectFilter(config, node.name, null) || t("db.narrowedInside");
    }
    if (FOLDER_FILTER_KINDS.has(node.kind) && node.schema) {
      return effectiveObjectFilter(config, node.schema, node.kind) || null;
    }
    return null;
  }, [connectionRow, node.kind, node.name, node.schema, t]);
  const Icon = nodeIcon(node.kind);

  const store = useDbStore.getState();
  const isRelation = node.kind === "table" || node.kind === "view" || node.kind === "collection";
  // Objects that are nothing but their definition. A routine has no rows and a sequence has one
  // number, so "open" can't mean the data grid for them — which is why they used to mean nothing at
  // all: no double-click, no menu, a name in the tree you could only look at.
  const isDefinition = node.kind === "routine" || node.kind === "sequence";
  // The level that *is* a schema, which differs by engine: a schema on the four SQL engines, and a
  // database on Mongo, which has no schema level at all. The same rule the diagram uses, hoisted
  // because the overview needs it too.
  const isSchemaLike =
    node.kind === "schema" ||
    (node.kind === "database" &&
      !engineInfo(
        useDbStore.getState().connections.find((c) => c.id === connectionId)?.kind ?? "postgres",
      ).sql);

  const openData = () => {
    if (!isRelation) return;
    store.openData(connectionId, nodeRef, node.name);
  };

  const showDdl = () => void store.openDdl(connectionId, nodeRef, node.name);

  /** Every object of this schema side by side, with its type, dates, size and comment. */
  const showObjects = () => store.openSchema(connectionId, nodeRef, node.name);

  /**
   * Drops a generated statement into a new console.
   *
   * The columns come from the catalog, so this is async — and it is deliberately allowed to fail:
   * a connection that can't be read still gets a draft, with a marker where the column list would
   * have been, rather than nothing at all.
   */
  const generate = async (template: SqlTemplate) => {
    const kind = useDbStore.getState().connections.find((c) => c.id === connectionId)?.kind;
    if (!kind) return;
    const columnNode: DbNodeRef = { ...nodeRef, kind: "column_folder" };
    const columns = await dbChildren(connectionId, columnNode).catch(() => [] as DbNode[]);
    // Straight to `dbChildren` rather than through `refreshNode`, so this is one of the few reads
    // that opens a session without the store noticing. See `syncConnected`.
    void store.syncConnected();
    store.newConsole(
      connectionId,
      node.database ?? undefined,
      node.schema ?? undefined,
      sqlTemplate(template, node, kind, columns.map((column) => column.name)),
    );
  };

  const menuItems: MenuItem[] = [];
  if (isRelation) {
    menuItems.push({ label: t("db.openData"), icon: Table2, onClick: openData });
    menuItems.push({ label: t("db.showDdl"), icon: FileCode2, onClick: showDdl });
    menuItems.push({
      label: t("db.selectRows"),
      icon: Play,
      onClick: () =>
        store.newConsole(
          connectionId,
          node.database ?? undefined,
          node.schema ?? undefined,
          selectStarFor(connectionId, node),
        ),
    });
    // Its own menu rather than eight more rows here: these are alternatives to each other and a
    // question of their own ("which statement?"), and folding them into the actions above would
    // bury "Open data" — the thing you actually came to do — under a wall of SQL verbs.
    menuItems.push({
      label: t("db.generateSql"),
      icon: Wand2,
      onClick: () => setGenerateMenu(menu),
    });
  }
  if (isDefinition) {
    menuItems.push({ label: t("db.showDdl"), icon: FileCode2, onClick: showDdl });
  }
  if (isSchemaLike) {
    menuItems.push({ label: t("db.showObjects"), icon: LayoutList, onClick: showObjects });
  }
  if (node.kind === "database" || node.kind === "schema") {
    menuItems.push({
      label: t("db.newConsole"),
      icon: FileCode2,
      onClick: () =>
        store.newConsole(connectionId, node.database ?? undefined, node.schema ?? undefined),
    });
    // The diagram hangs off the level that *has* a shape to draw, which differs by engine: a schema
    // on the four SQL engines, and a database on Mongo, which has no schema level at all. Offering
    // it on a Mongo database rather than nowhere is the whole point — the collections and the
    // references between them are exactly what nobody can see from a tree.
    if (isSchemaLike) {
      menuItems.push({
        label: t("db.showDiagram"),
        icon: Network,
        onClick: () => store.openDiagram(connectionId, nodeRef, diagramLabel(node)),
      });
    }
    // Creating, from the container you are pointing at. A draft in a console rather than a form:
    // a table is columns, types, keys and defaults, and a dialog that asked for all of that would
    // be a worse editor than the console next door — while the part that *is* worth automating,
    // qualifying the name with the right schema in the right quoting style, is done here.
    const engineKind = useDbStore.getState().connections.find((c) => c.id === connectionId)?.kind;
    if (engineKind) {
      menuItems.push({
        label: t("db.createTable"),
        icon: Table2,
        separated: true,
        onClick: () =>
          store.newConsole(
            connectionId,
            node.database ?? undefined,
            node.schema ?? undefined,
            createTemplate("table", engineKind, node.kind === "schema" ? node.name : null),
          ),
      });
      // Only where a schema is a thing you can create: on Mongo it isn't, and under a schema the
      // answer to "new schema" is its database, not this node.
      if (node.kind === "database" && engineInfo(engineKind).sql) {
        menuItems.push({
          label: t("db.createSchema"),
          icon: FolderPlus,
          onClick: () =>
            store.newConsole(
              connectionId,
              node.database ?? undefined,
              undefined,
              createTemplate("schema", engineKind, null),
            ),
        });
      }
    }
  }
  /**
   * Filtering from the tree.
   *
   * One rule, all the way down: **you right-click the container and narrow what it holds.** A
   * database holds schemas, so that is where "which schemas are listed" belongs. A schema holds
   * tables and views and routines, so that is where those are narrowed — not on the folder rows
   * themselves, which you would have to expand the schema to reach in order to say something about
   * what is inside it.
   *
   * Which of a schema's folders is a *second* menu rather than four entries in this one, the same
   * shape "Generate SQL" uses two items above: the common answer is tables, and the other three are
   * one click further rather than three lines of noise on every schema's menu.
   *
   * The scope is the gesture, so the dialog itself never asks about it.
   */
  if (node.kind === "database") {
    menuItems.push({
      label: t("db.filterMenu"),
      icon: Filter,
      separated: true,
      // On Mongo this level lists collections rather than schemas — the same filter, and the dialog
      // titles it in the engine's own word.
      onClick: () =>
        openModal({ kind: "objectFilter", connectionId, target: { kind: "schemas" } }),
    });
  } else if (node.kind === "schema") {
    menuItems.push({
      label: t("db.filterMenu"),
      icon: Filter,
      separated: true,
      // Anchored where the first menu was, so the second opens over it rather than wherever the
      // pointer drifted to while reading.
      onClick: () => setFilterMenu(menu),
    });
  }
  menuItems.push({
    label: t("db.copyName"),
    icon: Copy,
    onClick: () => void navigator.clipboard.writeText(qualifiedName(node)),
  });
  if (node.has_children) {
    menuItems.push({
      label: t("db.refresh"),
      icon: RefreshCw,
      onClick: () => void store.refreshNode(connectionId, nodeRef, key),
    });
  }

  return (
    <>
      <TreeRow
        depth={depth}
        at={at}
        /**
         * Dragging a relation out of the tree, to drop its name into a console.
         *
         * Only relations: a schema or a folder is not something a query names, and a column would
         * want a different reference than `schema.table` — worth having, but not by pretending it
         * is the same drag.
         *
         * The text is rendered here, at the press, rather than at the drop. The engine is known
         * here and the quoting rules live one import away in `sqlTemplates`; a console working it
         * out on release would be a second place in the app that knows how SQL Server spells a
         * quote. See `dbObjectDragStore`.
         */
        drag={
          isRelation
            ? {
                onPointerDown: (e) => {
                  // Left button only. A right-click opens the menu, and picking the row up under
                  // it would leave the tree dragging something the user never grabbed.
                  if (e.button !== 0) return;
                  const kind = useDbStore.getState().connections.find(
                    (c) => c.id === connectionId,
                  )?.kind;
                  if (!kind) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  dragPress(
                    {
                      connectionId,
                      text: objectReference(node, kind),
                      label: node.name,
                    },
                    e.clientX,
                    e.clientY,
                  );
                },
                onPointerMove: (e) => {
                  // No button held is a hover, whatever the store still remembers.
                  if (e.buttons === 0) return;
                  const origin = useDbObjectDragStore.getState().origin;
                  if (!origin || useDbObjectDragStore.getState().drag) return;
                  // The threshold is what keeps a click from being a one-pixel drag — without it
                  // every click on a table would arm a drop.
                  if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < DRAG_THRESHOLD) return;
                  dragBegin();
                  // Capture is released so the console underneath receives its own pointer events;
                  // held, every move would keep reporting this row and no drop could be aimed.
                  e.currentTarget.releasePointerCapture(e.pointerId);
                },
              }
            : undefined
        }
        icon={<Icon size={12} />}
        name={node.name}
        detail={node.detail}
        badge={
          narrowing ? (
            <span
              // The pattern itself in the tooltip, because "filtered" alone leaves the next
              // question unanswered — you want to know *by what*, and then to go change it.
              title={t("db.narrowedBy", { pattern: narrowing })}
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-accent)]"
            >
              <Filter size={10} />
            </span>
          ) : undefined
        }
        expandable={node.has_children}
        expanded={expanded}
        loading={loading}
        onToggle={() => void store.toggleNode(connectionId, nodeRef, key)}
        onOpen={
          isRelation ? openData : isDefinition ? showDdl : isSchemaLike ? showObjects : undefined
        }
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {expanded && error && (
        <p
          style={{ paddingLeft: 24 + depth * 12 }}
          className="flex items-start gap-1 py-1 pr-2 text-[11px] text-[var(--cf-danger)]"
        >
          <AlertTriangle size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      {expanded &&
        !error &&
        children?.map((child, index) => (
          <NodeSubtree
            key={child.id}
            connectionId={connectionId}
            node={child}
            depth={depth + 1}
            at={index}
          />
        ))}
      {expanded && !error && children?.length === 0 && (
        <p
          style={{ paddingLeft: 24 + depth * 12 }}
          className="py-1 text-[11px] italic text-[var(--cf-text-muted)]"
        >
          {t("db.empty")}
        </p>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {filterMenu && (
        <ContextMenu
          x={filterMenu.x}
          y={filterMenu.y}
          heading={t("db.filterMenu")}
          items={FILTERABLE_FOLDERS.map((entry) => ({
            label: t(entry.label),
            icon: Filter,
            separated: entry.separated,
            onClick: () =>
              openModal({
                kind: "objectFilter",
                connectionId,
                target: { kind: "objects", schema: node.name, folder: entry.folder },
              }),
          }))}
          onClose={() => setFilterMenu(null)}
        />
      )}
      {generateMenu && (
        <ContextMenu
          x={generateMenu.x}
          y={generateMenu.y}
          heading={t("db.generateSql")}
          items={GENERATED.filter(
            (entry) => !entry.appliesTo || entry.appliesTo.includes(node.kind),
          ).map((entry) => ({
            label: t(entry.label),
            icon: entry.icon,
            separated: entry.separated,
            onClick: () => void generate(entry.template),
          }))}
          onClose={() => setGenerateMenu(null)}
        />
      )}
    </>
  );
}

/**
 * The statements the generator offers, grouped the way SQL itself is talked about: the ones that
 * read or change rows (DML), the ones that define the object (DDL), and the ones that say who may
 * touch it (DCL).
 *
 * Inside the DDL group the order is not alphabetical: `CREATE` first, then the two that destroy the
 * whole object. Being last in their group puts the most irreversible rows furthest from `SELECT` at
 * the top, which is where the pointer arrives.
 */
const GENERATED: {
  template: SqlTemplate;
  label: TranslationKey;
  icon: LucideIcon;
  separated?: boolean;
  /** Node kinds the draft makes sense for. Absent means every relation this menu opens on. */
  appliesTo?: DbNodeKind[];
}[] = [
  { template: "select", label: "db.sql.select", icon: Search },
  { template: "count", label: "db.sql.count", icon: Hash },
  { template: "insert", label: "db.sql.insert", icon: Plus },
  { template: "update", label: "db.sql.update", icon: Pencil },
  { template: "delete", label: "db.sql.delete", icon: Trash2 },
  { template: "create", label: "db.sql.create", icon: FileCode2, separated: true },
  // Not offered on a view: a view holds no rows of its own, so `TRUNCATE` against one is an error
  // rather than a statement worth drafting. `DROP` is offered — it just becomes `DROP VIEW`.
  { template: "truncate", label: "db.sql.truncate", icon: Eraser, appliesTo: ["table", "collection"] },
  { template: "drop", label: "db.sql.drop", icon: Trash },
  { template: "grant", label: "db.sql.grant", icon: KeyRound, separated: true },
  { template: "revoke", label: "db.sql.revoke", icon: KeyRound },
];

/** `schema.table`, or just the name when there is no schema (Mongo). */
function qualifiedName(node: DbNode): string {
  return node.schema ? `${node.schema}.${node.name}` : node.name;
}

/** What a diagram tab is called. Qualified with the database, because two databases on the same
 * server routinely have a `public` schema and the tab strip has to tell them apart. */
function diagramLabel(node: DbNode): string {
  return node.database && node.kind === "schema" ? `${node.database}.${node.name}` : node.name;
}

/** The starter statement "Select rows" drops into a new console. */
function selectStarFor(connectionId: string, node: DbNode): string {
  const connection = useDbStore.getState().connections.find((c) => c.id === connectionId);
  if (connection && !engineInfo(connection.kind).sql) {
    return `db.${node.name}.find({}).limit(50)`;
  }
  const target = qualifiedName(node);
  // `TOP` for IRIS and SQL Server, `LIMIT` for Postgres: the console runs this as-is, so it has to
  // be valid in the dialect it lands in.
  if (connection?.kind === "sqlserver" || connection?.kind === "iris") {
    return `SELECT TOP 50 * FROM ${target}`;
  }
  return `SELECT * FROM ${target} LIMIT 50`;
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

function ConnectionBranch({
  row,
  index,
  total,
}: {
  row: DbConnectionRow;
  /** Place among the rows it is drawn with — its group's members, or the loose list. Only for the
   * stagger and for hiding the "move up" item on the first row; the move itself is the store's. */
  index: number;
  total: number;
}) {
  const t = useT();
  const press = useDbDragStore((s) => s.press);
  const begin = useDbDragStore((s) => s.begin);
  const hoverDrag = useDbDragStore((s) => s.hover);
  const isDropTarget = useDbDragStore((s) => s.drag !== null && s.overConnectionId === row.id);
  const commitDrop = useDbDrop();
  const rootRef: DbNodeRef = { kind: "root", database: null, schema: null, name: null };
  const key = nodeKey(row.id, rootRef);
  const expanded = useDbStore((s) => s.expanded.includes(key));
  const loading = useDbStore((s) => s.loadingNodes.includes(key));
  const children = useDbStore((s) => s.children[key]);
  const error = useDbStore((s) => s.nodeErrors[key]);
  const connected = useDbStore((s) => s.connected.includes(row.id));
  const connections = useDbStore((s) => s.connections);
  // Filtered *outside* the selector: a selector that builds a new array returns a different snapshot
  // on every store read, which is an infinite render loop the moment anything else in the store
  // changes — connecting, which writes `connected` and `children`, was enough to trip it.
  const allConsoles = useDbStore((s) => s.consoles);
  const consoles = useMemo(
    () => allConsoles.filter((c) => c.connection_id === row.id),
    [allConsoles, row.id],
  );
  const groups = useDbStore((s) => s.groups);
  const openModal = useDbModalStore((s) => s.openDbModal);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Where to put it. A second menu rather than a submenu: `ContextMenu` has no nesting, and the
   * list of groups is exactly the sort of thing that would need one. */
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number } | null>(null);

  const store = useDbStore.getState();
  const selected = useDbStore((s) => s.selectedConnectionId === row.id);

  const move = (direction: -1 | 1) => void store.moveConnection(row.id, direction);

  /** Every folder the tree knows about — the rows the user made, plus any name a connection carries
   * without one — so "move to" can never be missing a group that is visibly on screen. */
  const groupNames = [
    ...new Set([
      ...groups.map((group) => group.name.trim()),
      ...connections.map((c) => c.group_name.trim()),
    ]),
  ]
    .filter((name) => name !== UNGROUPED)
    .sort((a, b) => a.localeCompare(b));

  const groupItems: MenuItem[] = [
    {
      label: t("db.ungrouped"),
      icon: FolderOpen,
      onClick: () => void store.setConnectionGroup(row.id, UNGROUPED),
    },
    ...groupNames.map((name, i) => ({
      label: name,
      icon: FolderCode,
      separated: i === 0,
      onClick: () => void store.setConnectionGroup(row.id, name),
    })),
  ];

  const menuItems: MenuItem[] = [
    {
      label: t("db.newConsole"),
      icon: FileCode2,
      onClick: () => store.newConsole(row.id),
    },
    connected
      ? { label: t("db.disconnect"), icon: Plug, onClick: () => void store.disconnect(row.id) }
      : { label: t("db.connect"), icon: PlugZap, onClick: () => void store.connect(row.id) },
    {
      label: t("db.refresh"),
      icon: RefreshCw,
      onClick: () => void store.refreshNode(row.id, rootRef, key),
    },
    {
      label: t("db.editConnection"),
      icon: Pencil,
      onClick: () => openModal({ kind: "connection", connectionId: row.id }),
    },
    {
      label: t("db.duplicate"),
      icon: Copy,
      onClick: () => void store.duplicateConnection(row.id),
    },
    {
      label: `${t("db.moveToGroup")}…`,
      icon: FolderCode,
      separated: true,
      // Anchored where the first menu was, so the second opens over it rather than wherever the
      // pointer drifted to while reading.
      onClick: () => setGroupMenu(menu),
    },
  ];
  if (index > 0) {
    menuItems.push({ label: t("db.moveUp"), icon: ArrowUp, onClick: () => move(-1), separated: true });
  }
  if (index < total - 1) {
    menuItems.push({ label: t("db.moveDown"), icon: ArrowDown, onClick: () => move(1) });
  }
  menuItems.push({
    label: t("db.delete"),
    icon: Trash2,
    danger: true,
    separated: true,
    onClick: async () => {
      if (await confirmAction(t("db.deleteConfirm", { name: row.name }))) {
        void store.deleteConnection(row.id);
      }
    },
  });

  // The engine's own glyph, not the generic cylinder. A connection row used to carry the same
  // `Database` icon as the `postgres` database *inside* it, so the two levels of the tree that mean
  // the most different things looked identical — and nothing anywhere in the row said whether you
  // were pointing at IRIS or at Mongo. This is the same glyph the engine picker and the connection
  // dialog draw, in the same colour, so an engine looks like itself everywhere it appears.
  const EngineIcon = engineIcon(row.kind);

  return (
    <>
      <TreeRow
        depth={0}
        at={index}
        drag={{
          onPointerDown: (e) => {
            // Left button only. A right-click opens the menu, and picking the row up under it would
            // leave the tree dragging something the user never grabbed.
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            press(row.id, row.group_name, e.clientX, e.clientY);
          },
          onPointerMove: (e) => {
            const origin = useDbDragStore.getState().origin;
            if (!origin || useDbDragStore.getState().drag) return;
            // The threshold is what keeps a click from being a one-pixel drag.
            if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < DRAG_THRESHOLD) return;
            begin();
            setDragCursor(true);
            // Capture is released so the rows the pointer crosses receive their own enter events —
            // with it held, every move would keep reporting this row.
            e.currentTarget.releasePointerCapture(e.pointerId);
          },
          onPointerEnter: () => hoverDrag(row.id, row.group_name),
          onPointerUp: () => commitDrop(row.group_name, row.id),
        }}
        dropTarget={isDropTarget}
        icon={<EngineIcon size={12} />}
        color={engineColor(row.kind)}
        name={row.name}
        detail={undefined}
        // Where it points, on hover rather than on a line of its own. A connection URL is long
        // enough to wrap the sidebar and repeat under every connection, which crowded out the names
        // — the thing you actually read the tree for. The row's own colour dot already says whether
        // it is open, and the connection dialog says the rest in full.
        title={describeConnection(row)}
        expandable
        expanded={expanded}
        loading={loading}
        active={selected}
        onToggle={() => void store.toggleNode(row.id, rootRef, key)}
        onOpen={() => store.newConsole(row.id)}
        onSelect={() => store.selectConnection(row.id)}
        // `Alt` rather than the bare arrows: bare up/down is how a tree moves the *cursor*, and a
        // key that reorders the estate must not be the one a hand reaches for to look around. It is
        // also the gesture every editor uses to move the thing under the caret.
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          store.selectConnection(row.id);
          move(e.key === "ArrowUp" ? -1 : 1);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Right-clicking selects too: a menu about this connection that left the selection on
          // another one would put two rows on screen claiming to be the one being acted on.
          store.selectConnection(row.id);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        leading={<ConnectionDot kind={row.kind} connected={connected} />}
      />
      {/* Saved consoles sit above the server's own tree: they are this workspace's work, and the
          reason to open a connection more often than the schema is. */}
      {expanded && <SavedConsolesFolder consoles={consoles} connectionId={row.id} />}
      {expanded && error && (
        <p className="flex items-start gap-1 py-1 pl-[26px] pr-2 text-[11px] text-[var(--cf-danger)]">
          <AlertTriangle size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      {expanded &&
        !error &&
        children?.map((child, childIndex) => (
          <NodeSubtree key={child.id} connectionId={row.id} node={child} depth={1} at={childIndex} />
        ))}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {groupMenu && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          items={groupItems}
          heading={t("db.moveToGroup")}
          onClose={() => setGroupMenu(null)}
        />
      )}
    </>
  );
}

/**
 * The connection's saved consoles, under a folder of their own.
 *
 * Loose leaves between the connection and its databases read as "something odd is in my schema" —
 * a saved console called `Console 1` sitting where `postgres` sits says nothing about what it is or
 * that it can be saved at all. A named folder answers both, so it is drawn even when empty: it is
 * the only place in the app that says saving a console is a thing you can do, and a folder that
 * appears only once you have already found the feature teaches nobody.
 *
 * Open/closed is local state rather than the store's `expanded`: that list is keyed by server nodes
 * and cleared whenever a connection is touched, and this folder has nothing to do with a session.
 *
 * Folded on arrival. What you open a connection to look at is its databases, and this folder sat
 * above them with every saved console unrolled — pushing the tree itself down the panel by however
 * many consoles had accumulated. The count stays on the row while it is folded, which is the part
 * that has to be visible: it says there is something in here without spending the room to list it.
 */
function SavedConsolesFolder({
  consoles,
  connectionId,
}: {
  consoles: DbConsole[];
  connectionId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const store = useDbStore.getState();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <TreeRow
        depth={1}
        icon={<FolderCode size={12} />}
        name={t("db.savedConsoles")}
        detail={consoles.length > 0 ? String(consoles.length) : undefined}
        expandable
        expanded={open}
        onToggle={() => setOpen((current) => !current)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {open && consoles.length === 0 && (
        <p className="py-1 pl-[38px] pr-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t("db.savedConsolesEmpty")}
        </p>
      )}
      {open &&
        consoles.map((console, at) => (
          <SavedConsoleRow
            key={console.id}
            console={console}
            connectionId={connectionId}
            at={at}
          />
        ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: t("db.newConsole"),
              icon: FileCode2,
              onClick: () => store.newConsole(connectionId),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/**
 * A saved console's row while it is being named, in place of the row itself.
 *
 * Editing where the name is read rather than in a dialog, because renaming is one word long and a
 * modal to type one word into is three clicks around it. Enter and blur commit, Escape leaves the
 * name alone — and the flag that says *which* console is being renamed lives in the store, so the
 * save that creates one can set it and have the row come up ready to type in.
 */
function ConsoleNameInput({ saved }: { saved: DbConsole }) {
  const [value, setValue] = useState(saved.name);
  const store = useDbStore.getState();
  // Escape unmounts this row, and an unmount is not a blur React will tell us about — but it costs
  // nothing to be sure the cancel path can never be overtaken by the commit one.
  const cancelled = useRef(false);

  return (
    <div style={{ paddingLeft: 6 + 2 * 12 }} className="flex items-center gap-1 py-[3px] pr-1.5">
      <span className="h-3.5 w-3.5 shrink-0" />
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-muted)]">
        <FileCode2 size={12} />
      </span>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          if (!cancelled.current) void store.renameConsole(saved.id, value);
        }}
        onKeyDown={(e) => {
          // The tree above listens for arrows and Enter; none of that should reach it from here.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            void store.renameConsole(saved.id, value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelled.current = true;
            store.setRenamingConsole(null);
          }
        }}
        className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-[var(--cf-field)] px-1 py-[1px] text-[13px] outline-none"
      />
    </div>
  );
}

/**
 * The inline editor a group is named in. Selects on mount, commits on Enter or blur, cancels on
 * Escape — the same shape `ConsoleNameInput` has, and for the same reason: naming a folder is one
 * word, and a modal to type one word into is three clicks around it.
 */
function GroupNameInput({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  // Escape unmounts this row, and an unmount is not a blur React will tell us about — but it costs
  // nothing to be sure the cancel path can never be overtaken by the commit one.
  const settled = useRef(false);

  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    onCommit(draft);
  };

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        // The tree above listens for arrows and Enter; none of that should reach it from here.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled.current = true;
          onCancel();
        }
      }}
      className="min-w-0 flex-1 select-text rounded border border-[var(--cf-accent)] bg-[var(--cf-field)] px-1 py-px text-[12px] outline-none"
    />
  );
}

/**
 * One folder in the connection tree, with its connections under it.
 *
 * The members are indented by a wrapper rather than by a `depth` threaded through every row: a
 * connection's subtree already numbers its own levels from the connection, and a group is a shelf
 * the whole subtree sits on, not another level inside it. One padding here moves the branch and
 * everything it will ever expand into, and `ConnectionBranch` never learns it is in a folder.
 */
function GroupSection({
  group,
  members,
  collapsed,
  at,
  onToggle,
  onNewGroup,
}: {
  group: string;
  members: DbConnectionRow[];
  collapsed: boolean;
  at: number;
  onToggle: () => void;
  onNewGroup: () => void;
}) {
  const t = useT();
  const store = useDbStore.getState();
  const openModal = useDbModalStore((s) => s.openDbModal);
  const hoverDrag = useDbDragStore((s) => s.hover);
  const isDropTarget = useDbDragStore(
    (s) => s.drag !== null && s.overGroup === group && s.overConnectionId === null,
  );
  const commitDrop = useDbDrop();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [engineMenu, setEngineMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);

  const label = group || t("db.ungrouped");

  /**
   * Deleting a folder, with the one thing worth confirming spelled out.
   *
   * The connections survive — the backend moves them to ungrouped and never deletes them — so the
   * prompt says exactly that rather than the generic "are you sure": the fear this dialog exists to
   * answer is "am I about to lose my databases, their consoles and their saved passwords", and the
   * answer is no.
   */
  const removeGroup = async () => {
    const message =
      members.length > 0
        ? t("db.deleteGroupWithConnections", { name: label, count: String(members.length) })
        : t("db.deleteGroupConfirm", { name: label });
    if (await confirmAction(message)) void store.deleteGroup(group);
  };

  const menuItems: MenuItem[] = [
    {
      label: `${t("db.newConnectionHere")}…`,
      icon: Plus,
      onClick: () => setEngineMenu(menu),
    },
    { label: t("db.newGroup"), icon: FolderPlus, onClick: onNewGroup },
  ];
  // Renaming or deleting the ungrouped bucket is meaningless: it is the absence of a group, so
  // renaming it would write a literal name onto every connection that deliberately has none, and
  // deleting it would have nothing to delete.
  if (group !== UNGROUPED) {
    menuItems.push(
      {
        label: t("db.renameGroup"),
        icon: Pencil,
        separated: true,
        onClick: () => setRenaming(true),
      },
      { label: t("db.deleteGroup"), icon: Trash2, danger: true, onClick: () => void removeGroup() },
    );
  }

  return (
    <div className="py-0.5">
      <div
        role="treeitem"
        aria-expanded={!collapsed}
        tabIndex={0}
        // Dropping on the heading means "into this group, at the end" — the move that has no row to
        // aim at, and the only way into a group that is empty or collapsed.
        onPointerEnter={() => hoverDrag(null, group)}
        onPointerUp={() => commitDrop(group, null)}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={riseDelay(at)}
        className={`cf-rise group flex w-full cursor-default items-center gap-1 rounded-md px-1.5 py-[3px] text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
          isDropTarget
            ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]"
            : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        }`}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-muted)]">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
        {renaming ? (
          <GroupNameInput
            value={group}
            onCommit={(value) => {
              setRenaming(false);
              if (value.trim()) void store.renameGroup(group, value.trim());
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text-muted)]">
              {label}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              {members.length}
            </span>
          </>
        )}
      </div>

      {!collapsed && (
        <div className="pl-3">
          {members.map((row, index) => (
            <ConnectionBranch key={row.id} row={row} index={index} total={members.length} />
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {engineMenu && (
        <EngineMenu
          x={engineMenu.x}
          y={engineMenu.y}
          onPick={(engine) => openModal({ kind: "newConnection", engine, group })}
          onClose={() => setEngineMenu(null)}
        />
      )}
    </div>
  );
}

/** One saved console, as a leaf under its connection. */
function SavedConsoleRow({
  console: saved,
  connectionId,
  at,
}: {
  console: DbConsole;
  connectionId: string;
  at: number;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const renaming = useDbStore((s) => s.renamingConsoleId === saved.id);
  const store = useDbStore.getState();
  const open = () => store.openConsole(connectionId, saved.id);

  if (renaming) return <ConsoleNameInput saved={saved} />;

  const items: MenuItem[] = [
    { label: t("db.openInConsole"), icon: FileCode2, onClick: open },
    {
      label: t("db.rename"),
      icon: Pencil,
      onClick: () => store.setRenamingConsole(saved.id),
    },
    {
      label: t("db.delete"),
      icon: Trash2,
      danger: true,
      onClick: async () => {
        if (await confirmAction(t("db.deleteConsoleConfirm", { name: saved.name }))) {
          void store.deleteConsole(saved.id);
        }
      },
    },
  ];

  return (
    <>
      <TreeRow
        depth={2}
        at={at}
        icon={<FileCode2 size={12} />}
        name={saved.name}
        detail={saved.database_name}
        expandable={false}
        expanded={false}
        onToggle={open}
        onOpen={open}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Search across what has been loaded
// ---------------------------------------------------------------------------

/**
 * Searches the nodes already read, not the server.
 *
 * A server-side search would need a catalog query per engine and would still only cover the
 * databases the user has opened. Being explicit that this searches "what you've expanded" is more
 * honest than a search box that silently misses half the schema — and the count says how much was
 * looked at.
 */
function SearchResults({ query }: { query: string }) {
  const t = useT();
  const children = useDbStore((s) => s.children);
  const connections = useDbStore((s) => s.connections);
  const store = useDbStore.getState();

  const hits = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const out: { connectionId: string; node: DbNode }[] = [];
    let scanned = 0;
    for (const [key, nodes] of Object.entries(children)) {
      const connectionId = key.split("|")[0];
      for (const node of nodes) {
        scanned += 1;
        if (
          (node.kind === "table" || node.kind === "view" || node.kind === "collection") &&
          node.name.toLowerCase().includes(needle)
        ) {
          out.push({ connectionId, node });
        }
      }
    }
    return { out: out.slice(0, MAX_RESULTS), scanned };
  }, [children, query]);

  if (hits.out.length === 0) {
    return (
      <p className="px-3 py-4 text-center text-[12px] text-[var(--cf-text-muted)]">
        {t("db.searchNoResults", { query: query.trim() })}
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      {hits.out.map(({ connectionId, node }) => {
        const Icon = nodeIcon(node.kind);
        const connection = connections.find((c) => c.id === connectionId);
        return (
          <button
            key={`${connectionId}|${node.id}`}
            onClick={() => store.openData(connectionId, refOf(node), node.name)}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <Icon size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-[var(--cf-text)]">{node.name}</span>
              <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">
                {[connection?.name, node.database, node.schema].filter(Boolean).join(" / ")}
              </span>
            </span>
          </button>
        );
      })}
      <p className="px-2 py-2 text-[11px] italic text-[var(--cf-text-muted)]">
        {t("db.searchScope", { n: String(hits.scanned) })}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sidebar
// ---------------------------------------------------------------------------

export function DbExplorer() {
  const t = useT();
  const width = useLayoutStore((s) => s.sizes.dbSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const connections = useDbStore((s) => s.connections);
  const groups = useDbStore((s) => s.groups);
  const collapsedGroups = useDbStore((s) => s.collapsedGroups);
  const toggleGroup = useDbStore((s) => s.toggleGroup);
  const createGroup = useDbStore((s) => s.createGroup);
  const section = useDbStore((s) => s.section);
  const setSection = useDbStore((s) => s.setSection);
  const openModal = useDbModalStore((s) => s.openDbModal);
  const [query, setQuery] = useState("");
  /** Where the "which engine?" menu is anchored, when the `+` has expanded it. */
  const [engineMenu, setEngineMenu] = useState<{ x: number; y: number } | null>(null);
  /** The unnamed folder being typed into, if the user just asked for one. */
  const [creatingGroup, setCreatingGroup] = useState(false);
  const dragging = useDbDragStore((s) => s.drag !== null);
  const ungroupHover = useDbDragStore((s) => s.hover);
  const ungroupTarget = useDbDragStore(
    (s) => s.drag !== null && s.overGroup === UNGROUPED && s.overConnectionId === null,
  );
  const ungroupDrop = useDbDrop();

  // Released over the search box, the toolbar, or off the window entirely: none of those are drop
  // targets, but every one of them still ends the drag. Without this the body keeps `cf-dragging`
  // and the next click lands on a tree that thinks it is still being dragged.
  useEffect(() => {
    const cancel = () => {
      const state = useDbDragStore.getState();
      if (!state.drag && !state.origin) return;
      state.end();
      setDragCursor(false);
    };
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  const sections: { id: DbSidebarSection; label: string }[] = [
    { id: "explorer", label: t("db.explorer") },
    { id: "history", label: t("db.history") },
  ];

  const buckets = useMemo(
    () => groupConnections(connections, groups),
    [connections, groups],
  );
  /**
   * The tree in two parts: the folders, then the connections that are in none.
   *
   * Ungrouped used to be a folder of its own — a "Sin grupo" heading with a chevron and a count,
   * sitting among the real groups and looking exactly like one. It isn't one: it is the absence of
   * a group, it can't be renamed or deleted, and a heading that exists only to say "these have no
   * heading" costs a row and a level of indentation to say nothing. The loose connections are now
   * drawn as themselves, under the folders and behind a rule that separates the two kinds of thing
   * without naming the second.
   */
  const folders = useMemo(() => buckets.filter(([name]) => name !== UNGROUPED), [buckets]);
  const loose = useMemo(
    () => buckets.find(([name]) => name === UNGROUPED)?.[1] ?? [],
    [buckets],
  );
  /** Whether the tree has folders at all. Without any, it stays the flat list it has always been. */
  const foldered = folders.length > 0;

  /** Right-clicking the empty space below the tree — what the "Sin grupo" heading used to be the
   * only place to reach, now that it is gone. */
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <div
        data-tour="db-explorer"
        style={{ width }}
        // `select-none` across the whole panel. Nothing in here is text you read *out of*: a row is
        // a thing you point at, its name is one "Copy the name" away in the context menu, and a
        // history entry is opened by clicking it rather than by being retyped. What the selection
        // did instead was get in the way — the double click that opens a table left the name it
        // opened highlighted behind it, and now that rows can be dragged into a console, the press
        // that starts a drag would sweep a selection across every row it crossed. The two text
        // fields opt back in with `select-text`, since a search box you cannot select inside is
        // unusable — and under a `user-select: none` ancestor WebKit takes it from them too.
        className={`flex h-full min-h-0 shrink-0 select-none flex-col overflow-hidden ${CARD}`}
      >
        <div
          data-tour="db-explorer-actions"
          className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1"
        >
          <span className="mr-auto min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("db.title")}
          </span>
          {/* The whole set, not one connection: the way into "set my databases up" that doesn't
              require having a connection to right-click first — including arranging the order,
              which is a pair of arrows in there rather than a permanent pair up here. */}
          <ToolbarButton
            onClick={() => openModal({ kind: "connections" })}
            title={t("db.manageConnections")}
          >
            <Settings2 size={13} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              setSection("explorer");
              setCreatingGroup(true);
            }}
            title={t("db.newGroup")}
          >
            <FolderPlus size={13} />
          </ToolbarButton>
          <ToolbarButton
            onClick={(e) => setEngineMenu(menuAnchor(e))}
            title={t("db.newConnection")}
          >
            <Plus size={13} />
          </ToolbarButton>
        </div>

        <div className="flex shrink-0 gap-0.5 px-1.5 pt-1.5">
          {sections.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSection(entry.id)}
              title={entry.label}
              className={`relative min-w-0 flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium ${
                section === entry.id
                  ? "text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              }`}
            >
              {section === entry.id && <ActivePill layoutId="cf-db-section-pill" />}
              <span className="relative block truncate">{entry.label}</span>
            </button>
          ))}
        </div>

        {section === "explorer" && (
          <div className="relative shrink-0 px-1.5 py-1.5">
            <Search
              size={12}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("db.searchPlaceholder")}
              className="w-full select-text rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] py-1 pl-6 pr-6 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                title={t("db.clearSearch")}
                aria-label={t("db.clearSearch")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {section === "history" ? (
            <DbHistoryList />
          ) : query.trim() ? (
            <SearchResults query={query} />
          ) : connections.length === 0 && !foldered && !creatingGroup ? (
            // Just the state, no call to action: the "+" in the header is already the one way to
            // add a connection, and repeating it here as a second button (plus a list of the
            // engines, which the engine menu itself shows) made an empty panel look busier than a
            // full one.
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              <Database size={22} className="text-[var(--cf-text-muted)]" />
              <p className="text-[13px] text-[var(--cf-text)]">{t("db.noConnections")}</p>
            </div>
          ) : (
            <div
              role="tree"
              onContextMenu={(e) => {
                e.preventDefault();
                setTreeMenu({ x: e.clientX, y: e.clientY });
              }}
              className="min-h-0 flex-1 overflow-auto p-1"
            >
              {creatingGroup && (
                <div className="flex items-center gap-1 px-1.5 py-[3px]">
                  <FolderPlus size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <GroupNameInput
                    value=""
                    onCommit={(value) => {
                      setCreatingGroup(false);
                      if (value.trim()) void createGroup(value);
                    }}
                    onCancel={() => setCreatingGroup(false)}
                  />
                </div>
              )}
              {folders.map(([group, members], at) => (
                <GroupSection
                  key={group}
                  group={group}
                  members={members}
                  at={at}
                  collapsed={collapsedGroups.includes(group)}
                  onToggle={() => toggleGroup(group)}
                  onNewGroup={() => setCreatingGroup(true)}
                />
              ))}
              {/* Only when there is something on both sides of it: a rule above the first connection
                  of a tree that has no folders would be a line under nothing. */}
              {foldered && loose.length > 0 && (
                <div className="mx-1 my-1.5 border-t border-[var(--cf-border)]" />
              )}
              {/* The loose connections are also the way *out* of a group. Every other target is a
                  row or a heading, and "no group" has neither — so the area they live in is the
                  target, and while a drag is live it says so rather than being an invisible band of
                  nothing. Without this, a connection dragged into a folder could only be taken back
                  out through the row menu. */}
              <div
                onPointerEnter={() => ungroupHover(null, UNGROUPED)}
                onPointerUp={() => ungroupDrop(UNGROUPED, null)}
                className={`rounded-md ${
                  ungroupTarget ? "bg-[var(--cf-accent-soft)] ring-1 ring-[var(--cf-accent)]" : ""
                }`}
              >
                {loose.map((row, index) => (
                  <ConnectionBranch key={row.id} row={row} index={index} total={loose.length} />
                ))}
                {dragging && loose.length === 0 && (
                  <p className="px-2 py-3 text-center text-[11px] text-[var(--cf-text-muted)]">
                    {t("db.dropToUngroup")}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <ResizeHandle
        axis="x"
        value={width}
        min={WIDTH_MIN}
        max={WIDTH_MAX}
        onChange={(value) => setSize("dbSidebarWidth", value)}
        onCommit={(value) => commitSize("dbSidebarWidth", value)}
      />

      {treeMenu && (
        <ContextMenu
          x={treeMenu.x}
          y={treeMenu.y}
          items={[
            {
              label: `${t("db.newConnection")}…`,
              icon: Plus,
              // Anchored where the first menu was, so the engines open over it rather than wherever
              // the pointer drifted to while reading.
              onClick: () => setEngineMenu(treeMenu),
            },
            { label: t("db.newGroup"), icon: FolderPlus, onClick: () => setCreatingGroup(true) },
          ]}
          onClose={() => setTreeMenu(null)}
        />
      )}
      {engineMenu && (
        <EngineMenu
          x={engineMenu.x}
          y={engineMenu.y}
          onPick={(engine) => openModal({ kind: "newConnection", engine })}
          onClose={() => setEngineMenu(null)}
        />
      )}
    </>
  );
}
