import {
  Braces,
  Columns3,
  Database,
  FileCode2,
  Folder,
  Hash,
  KeyRound,
  Layers,
  Leaf,
  ListOrdered,
  Server,
  Table2,
  View,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { DbKind, DbNodeKind } from "../../types/database";

/**
 * The shared vocabulary of the database workspace: one icon per node kind, one colour per engine,
 * and the panel chrome the columns share.
 *
 * In its own module because the explorer, the tab strip, the console toolbar and the result grid all
 * need to draw the same table the same way — a tree icon that disagrees with the tab icon for the
 * same object reads as two different things.
 */

/**
 * A panel's surface, and nothing else.
 *
 * It used to be a rounded, bordered, shadowed card floating on the ambient background, with a gap
 * around it. Flush is the layout now: no padding, no gaps, no radius — so a border here would land
 * against the `ResizeHandle`'s seam and draw a second line beside it, and a shadow has nowhere to
 * fall. The only structure between panels is that 1px seam.
 */
export const CARD = "bg-[var(--cf-surface)]";

/** Icons follow the *shape* of the thing, not the engine: a Mongo collection and a SQL table are
 * both "rows of records", so both get the table icon. What differs between engines is the label. */
const NODE_ICONS: Record<DbNodeKind, LucideIcon> = {
  root: Server,
  database: Database,
  schema: Layers,
  table_folder: Folder,
  view_folder: Folder,
  routine_folder: Folder,
  sequence_folder: Folder,
  column_folder: Columns3,
  index_folder: ListOrdered,
  key_folder: KeyRound,
  table: Table2,
  view: View,
  routine: FileCode2,
  sequence: Hash,
  collection: Braces,
  column: Leaf,
  index: ListOrdered,
  key: KeyRound,
};

export function nodeIcon(kind: DbNodeKind): LucideIcon {
  return NODE_ICONS[kind] ?? Folder;
}

/**
 * A tint per engine, so a tab strip mixing two connections stays readable.
 *
 * These are the engines' own brand hues rather than the app's accent: the point is to tell
 * PostgreSQL from SQL Server at a glance, which an accent-derived palette can't do because every
 * connection would be the same colour.
 */
const ENGINE_COLORS: Record<DbKind, string> = {
  postgres: "#3b82f6",
  supabase: "#3ecf8e",
  sqlserver: "#ef4444",
  iris: "#8b5cf6",
  mongodb: "#22c55e",
};

export function engineColor(kind: DbKind): string {
  return ENGINE_COLORS[kind] ?? "var(--cf-accent)";
}

/**
 * A glyph per engine, for the lists where the engine is the thing being chosen.
 *
 * Deliberately not brand logos: lucide ships none of them, and five trademarks redrawn by hand is a
 * licensing question rather than a design one. These are the shapes each engine's own mark suggests
 * — Mongo's leaf, Supabase's bolt — or what the engine plainly is: a server for SQL Server, layers
 * for IRIS's multi-model store. Five distinct silhouettes is all a list of five rows needs.
 *
 * Tinted with `engineColor` wherever they are drawn, so the glyph in the picker and the dot beside a
 * connection in the explorer are the same colour for the same engine.
 */
const ENGINE_ICONS: Record<DbKind, LucideIcon> = {
  postgres: Database,
  supabase: Zap,
  sqlserver: Server,
  iris: Layers,
  mongodb: Leaf,
};

export function engineIcon(kind: DbKind): LucideIcon {
  return ENGINE_ICONS[kind] ?? Database;
}

/** The engine's glyph in the engine's own colour. */
export function EngineGlyph({ kind, size = 14 }: { kind: DbKind; size?: number }) {
  const Icon = engineIcon(kind);
  return <Icon size={size} className="shrink-0" style={{ color: engineColor(kind) }} />;
}

/** The dot next to a connection: its engine's colour, hollow when nothing is connected. */
export function ConnectionDot({ kind, connected }: { kind: DbKind; connected: boolean }) {
  const color = engineColor(kind);
  return (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full border transition-colors"
      style={{
        borderColor: color,
        backgroundColor: connected ? color : "transparent",
      }}
    />
  );
}

/** A small square of the engine's colour with its initial — the connection's identity in a tab. */
export function EngineBadge({ kind, label }: { kind: DbKind; label: string }) {
  return (
    <span
      title={label}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold uppercase text-white"
      style={{ backgroundColor: engineColor(kind) }}
    >
      {label.slice(0, 1)}
    </span>
  );
}

/** Toolbar button, sized to sit in a 20px-tall header row like the API client's. */
/**
 * The hairline between two groups of controls on a toolbar.
 *
 * A toolbar with one gap between every button is a row of eight equal things, and the eye has to
 * read all eight to find the one it wants. The rule says which of them belong together — reload,
 * edit, look, take away, commit — so finding "the one that applies my changes" is picking a group
 * and then a button, not scanning a strip.
 *
 * Deliberately faint and short: it separates, it does not divide. A full-height rule at full
 * strength would read as the edge of a panel and cut the bar into two bars.
 */
export function ToolbarSeparator() {
  return <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-[var(--cf-border)]" />;
}

export function ToolbarButton({
  onClick,
  title,
  disabled,
  active,
  children,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`flex h-5 w-5 items-center justify-center rounded disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
      }`}
    >
      {children}
    </button>
  );
}

/** `1.2 s` / `840 ms` — a duration at the precision that is actually informative. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Thousands-separated, because a row count is read for its magnitude. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}
