import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  EyeOff,
  Filter,
  Database,
  FileCode2,
  FolderPlus,
  Hash,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Table2,
  Trash2,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { BetaBadge } from "../common/BetaBadge";
import { ResizeHandle } from "../common/ResizeHandle";
import { ActivePill } from "../common/ActivePill";
import { CARD, ConnectionDot, ToolbarButton, nodeIcon } from "./dbChrome";
import { DbHistoryList } from "./DbHistoryList";
import { EngineMenu, menuAnchor } from "./EngineMenu";
import {
  describeConnection,
  nodeKey,
  useDbStore,
  type DbSidebarSection,
} from "../../state/dbStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useLayoutStore } from "../../state/layoutStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { dbChildren } from "../../lib/tauri/dbCommands";
import { createTemplate, sqlTemplate, type SqlTemplate } from "../../lib/db/sqlTemplates";
import {
  engineInfo,
  type DbConnectionRow,
  type DbConsole,
  type DbNode,
  type DbNodeRef,
} from "../../types/database";

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
  icon,
  name,
  detail,
  expandable,
  expanded,
  loading,
  active,
  onToggle,
  onOpen,
  onContextMenu,
  leading,
  color,
}: {
  depth: number;
  icon: React.ReactNode;
  name: string;
  detail?: string;
  expandable: boolean;
  expanded: boolean;
  loading?: boolean;
  active?: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  leading?: React.ReactNode;
  color?: string;
}) {
  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={0}
      onClick={onToggle}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (onOpen ?? onToggle)();
        } else if (e.key === "ArrowRight" && expandable && !expanded) {
          e.preventDefault();
          onToggle();
        } else if (e.key === "ArrowLeft" && expandable && expanded) {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={`group flex w-full cursor-default items-center gap-1 rounded-md py-[3px] pr-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-[var(--cf-accent)] ${
        active
          ? "bg-[var(--cf-accent-soft)]"
          : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      }`}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--cf-text-muted)]">
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

function NodeSubtree({
  connectionId,
  node,
  depth,
}: {
  connectionId: string;
  node: DbNode;
  depth: number;
}) {
  const t = useT();
  const nodeRef = useMemo(() => refOf(node), [node]);
  const key = nodeKey(connectionId, nodeRef);
  const expanded = useDbStore((s) => s.expanded.includes(key));
  const loading = useDbStore((s) => s.loadingNodes.includes(key));
  const children = useDbStore((s) => s.children[key]);
  const error = useDbStore((s) => s.nodeErrors[key]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** The second menu: which statement to draft, once "Generate SQL" has been picked. */
  const [generateMenu, setGenerateMenu] = useState<{ x: number; y: number } | null>(null);
  const Icon = nodeIcon(node.kind);

  const store = useDbStore.getState();
  const isRelation = node.kind === "table" || node.kind === "view" || node.kind === "collection";

  const openData = () => {
    if (!isRelation) return;
    store.openData(connectionId, nodeRef, node.name);
  };

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
    menuItems.push({
      label: t("db.showDdl"),
      icon: FileCode2,
      onClick: () => void store.openDdl(connectionId, nodeRef, node.name),
    });
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
  if (node.kind === "database" || node.kind === "schema") {
    menuItems.push({
      label: t("db.newConsole"),
      icon: FileCode2,
      onClick: () =>
        store.newConsole(connectionId, node.database ?? undefined, node.schema ?? undefined),
    });
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
  // Filtering from the tree, on the schema you are looking at — which is where you realise you
  // never want to see it again. The dialog's Schemas tab is the same list, for editing it as a set.
  if (node.kind === "schema") {
    menuItems.push({
      label: t("db.onlyThisSchema"),
      icon: Filter,
      separated: true,
      onClick: () => void store.setVisibleSchemas(connectionId, () => [node.name]),
    });
    menuItems.push({
      label: t("db.hideThisSchema"),
      icon: EyeOff,
      onClick: () =>
        void store.setVisibleSchemas(connectionId, (known) =>
          known.filter((name) => name !== node.name),
        ),
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
        icon={<Icon size={12} />}
        name={node.name}
        detail={node.detail}
        expandable={node.has_children}
        expanded={expanded}
        loading={loading}
        onToggle={() => {
          if (node.has_children) void store.toggleNode(connectionId, nodeRef, key);
          else if (isRelation) openData();
        }}
        onOpen={isRelation ? openData : undefined}
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
        children?.map((child) => (
          <NodeSubtree
            key={child.id}
            connectionId={connectionId}
            node={child}
            depth={depth + 1}
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
      {generateMenu && (
        <ContextMenu
          x={generateMenu.x}
          y={generateMenu.y}
          heading={t("db.generateSql")}
          items={GENERATED.map((entry) => ({
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
 * read or change rows (DML), the one that defines the object (DDL), and the ones that say who may
 * touch it (DCL).
 */
const GENERATED: {
  template: SqlTemplate;
  label: TranslationKey;
  icon: LucideIcon;
  separated?: boolean;
}[] = [
  { template: "select", label: "db.sql.select", icon: Search },
  { template: "count", label: "db.sql.count", icon: Hash },
  { template: "insert", label: "db.sql.insert", icon: Plus },
  { template: "update", label: "db.sql.update", icon: Pencil },
  { template: "delete", label: "db.sql.delete", icon: Trash2 },
  { template: "create", label: "db.sql.create", icon: FileCode2, separated: true },
  { template: "grant", label: "db.sql.grant", icon: KeyRound, separated: true },
  { template: "revoke", label: "db.sql.revoke", icon: KeyRound },
];

/** `schema.table`, or just the name when there is no schema (Mongo). */
function qualifiedName(node: DbNode): string {
  return node.schema ? `${node.schema}.${node.name}` : node.name;
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

function ConnectionBranch({ row, index, total }: { row: DbConnectionRow; index: number; total: number }) {
  const t = useT();
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
  const openModal = useDbModalStore((s) => s.openDbModal);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const store = useDbStore.getState();

  /** Moves this connection one place, by rewriting the whole order — the backend takes a list, so
   * there is no separate "swap" to get out of step with it. */
  const move = (direction: -1 | 1) => {
    const ids = connections.map((c) => c.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void store.reorderConnections(ids);
  };

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

  return (
    <>
      <TreeRow
        depth={0}
        icon={<Database size={12} />}
        name={row.name}
        detail={undefined}
        expandable
        expanded={expanded}
        loading={loading}
        onToggle={() => void store.toggleNode(row.id, rootRef, key)}
        onOpen={() => store.newConsole(row.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        leading={<ConnectionDot kind={row.kind} connected={connected} />}
      />
      {/* Where it points, always visible: the difference between staging and production is a
          hostname, and it should never take a hover to see which one is open. */}
      <p className="truncate pb-0.5 pl-[38px] pr-2 text-[11px] text-[var(--cf-text-muted)]">
        {describeConnection(row)}
      </p>
      {/* Saved consoles sit above the server's own tree: they are this workspace's work, and the
          reason to open a connection more often than the schema is. */}
      {expanded &&
        consoles.map((console) => (
          <SavedConsoleRow key={console.id} console={console} connectionId={row.id} />
        ))}
      {expanded && error && (
        <p className="flex items-start gap-1 py-1 pl-[26px] pr-2 text-[11px] text-[var(--cf-danger)]">
          <AlertTriangle size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
      {expanded &&
        !error &&
        children?.map((child) => (
          <NodeSubtree key={child.id} connectionId={row.id} node={child} depth={1} />
        ))}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
}

/** One saved console, as a leaf under its connection. */
function SavedConsoleRow({
  console: saved,
  connectionId,
}: {
  console: DbConsole;
  connectionId: string;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const store = useDbStore.getState();
  const open = () => store.openConsole(connectionId, saved.id);

  const items: MenuItem[] = [
    { label: t("db.openInConsole"), icon: FileCode2, onClick: open },
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
        depth={1}
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
  const section = useDbStore((s) => s.section);
  const setSection = useDbStore((s) => s.setSection);
  const openModal = useDbModalStore((s) => s.openDbModal);
  const [query, setQuery] = useState("");
  /** Where the "which engine?" menu is anchored, when the `+` has expanded it. */
  const [engineMenu, setEngineMenu] = useState<{ x: number; y: number } | null>(null);

  const sections: { id: DbSidebarSection; label: string }[] = [
    { id: "explorer", label: t("db.explorer") },
    { id: "history", label: t("db.history") },
  ];

  return (
    <>
      <div
        style={{ width }}
        className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden ${CARD}`}
      >
        <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2 py-1">
          {/* The badge is here too, not only on the menu row that leads here: a beta mark that is
              visible for the second the menu is open has told nobody anything. */}
          <span className="mr-auto flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("db.title")}
            </span>
            <BetaBadge />
          </span>
          {/* The whole set, not one connection: the way into "set my databases up" that doesn't
              require having a connection to right-click first. */}
          <ToolbarButton
            onClick={() => openModal({ kind: "connections" })}
            title={t("db.manageConnections")}
          >
            <Settings2 size={13} />
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
              className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] py-1 pl-6 pr-6 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
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
          ) : connections.length === 0 ? (
            // Just the state, no call to action: the "+" in the header is already the one way to
            // add a connection, and repeating it here as a second button (plus a list of the
            // engines, which the engine menu itself shows) made an empty panel look busier than a
            // full one.
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              <Database size={22} className="text-[var(--cf-text-muted)]" />
              <p className="text-[13px] text-[var(--cf-text)]">{t("db.noConnections")}</p>
            </div>
          ) : (
            <div role="tree" className="min-h-0 flex-1 overflow-auto p-1">
              {connections.map((row, index) => (
                <ConnectionBranch
                  key={row.id}
                  row={row}
                  index={index}
                  total={connections.length}
                />
              ))}
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
