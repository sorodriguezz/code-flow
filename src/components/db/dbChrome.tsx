import {
  Braces,
  Columns3,
  Database,
  FileCode2,
  Folder,
  Hash,
  KeyRound,
  KeySquare,
  Layers,
  Leaf,
  ListOrdered,
  Server,
  Table2,
  View,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Kbd, iconButtonClass, type IconButtonSize } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { monogramStyle } from "../../lib/monogram";
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

/**
 * Every text input in this workspace's dialogs: the same field `fieldClass` and `ApiModal`'s `Field`
 * draw — the field fill, the darker field hairline, the accent halo on focus — so a box styled here
 * can't drift from the rest of the app's.
 *
 * Not `fieldClass` itself, because that one fixes the height at 30px, and this string also dresses
 * textareas (the startup script here, two DBML panels elsewhere) whose height is their row count.
 * The padding and the line height are what add up to the same 30px on a single-line input.
 */
export const INPUT =
  "w-full min-w-0 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-[5px] text-[13px] leading-[18px] text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:opacity-50";

/** A labelled control with an optional line of explanation under it — the density the connection
 * dialogs use. Here rather than in one of them because two of them need it. The label is the app's
 * form label: 11px, uppercase, the faint ink section headings use. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-[5px] block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}

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
  redis: "#dc382d",
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
 * for IRIS's multi-model store, a key for Redis. Six distinct silhouettes is all a list of six
 * rows needs.
 *
 * Drawn in `engineInk` wherever they appear, so the glyph in the picker, the tile on a tab and the
 * dot beside a connection in the explorer are the same hue for the same engine.
 */
const ENGINE_ICONS: Record<DbKind, LucideIcon> = {
  postgres: Database,
  supabase: Zap,
  sqlserver: Server,
  iris: Layers,
  mongodb: Leaf,
  // A key, because that is plainly what Redis is — and every shape closer to "fast store"
  // (`Database`, `Zap`, `Server`, `Layers`, `Leaf`) is already taken by one of the five above.
  redis: KeySquare,
};

export function engineIcon(kind: DbKind): LucideIcon {
  return ENGINE_ICONS[kind] ?? Database;
}

/**
 * The engine's colour as *ink*: the brand hue pulled toward the theme's text, which is what
 * `monogramStyle` gives a tile's letters.
 *
 * The raw brand colours are tuned to be told apart, not to be read — Supabase's green and Mongo's
 * leaf green sat under 2:1 on the light sheet as a 14px glyph. Mixed toward the text they keep their
 * hue on both themes and gain the contrast.
 */
export function engineInk(kind: DbKind): string {
  return String(monogramStyle(engineColor(kind)).color);
}

/** The engine's glyph in the engine's own ink. */
export function EngineGlyph({ kind, size = 14 }: { kind: DbKind; size?: number }) {
  const Icon = engineIcon(kind);
  return <Icon size={size} className="shrink-0" style={{ color: engineInk(kind) }} />;
}

/**
 * The dot next to a connection: its engine's colour, hollow when nothing is connected.
 *
 * **Three states, not two.** Filled means there is a session, hollow means there isn't — and
 * `busy` is the one in between, while a connect or a disconnect is in flight. Without it the dot
 * held its old value for however long the round trip took (a cold cluster, an SSH tunnel coming up,
 * a DNS lookup) and then flipped, so the only reading available to the user was that the click had
 * not registered.
 *
 * Drawn as a halo pulsing out of the dot rather than as a spinner: at eight pixels a spinner is a
 * grey smudge, and the halo keeps the dot itself — the thing that carries the engine's colour and
 * the actual state — legible underneath it. It sits in an overlay, so nothing in the row moves when
 * it appears.
 */
export function ConnectionDot({
  kind,
  connected,
  busy = false,
}: {
  kind: DbKind;
  connected: boolean;
  busy?: boolean;
}) {
  const color = engineColor(kind);
  const dot = (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full border transition-colors"
      style={{
        borderColor: color,
        backgroundColor: connected ? color : "transparent",
      }}
    />
  );
  if (!busy) return dot;
  return (
    <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
      <span
        aria-hidden
        className="absolute inset-0 animate-ping rounded-full opacity-75 motion-reduce:animate-none motion-reduce:animate-pulse"
        style={{ backgroundColor: color }}
      />
      {dot}
    </span>
  );
}

/**
 * The engine's tile — the connection's identity on a tab, a toolbar and a tree row.
 *
 * It used to be a 16px square of the raw brand colour with the engine's initial in white, which
 * failed contrast on half the engines (white on Supabase's light green measured under 2:1) and put a
 * letter where every other place in the workspace draws the engine's glyph. Now it is the glyph on a
 * wash of the brand colour, in the brand colour's ink, with a ring of it — the same mix the projects'
 * monograms use, so a tinted tile means "this thing's own colour" everywhere in the app.
 */
export function EngineBadge({
  kind,
  label,
  size = 16,
}: {
  kind: DbKind;
  label: string;
  /** 16 on a tab, 18 on a toolbar or a tree row. */
  size?: number;
}) {
  const Icon = engineIcon(kind);
  return (
    <span
      title={label}
      role="img"
      aria-label={label}
      className="inline-flex shrink-0 items-center justify-center rounded-[5px]"
      style={{ width: size, height: size, ...monogramStyle(engineColor(kind)) }}
    >
      <Icon size={size >= 18 ? 12 : 11} aria-hidden />
    </span>
  );
}

/**
 * The mark on the field a record is identified by — `PK`, IRIS's `ID`, Mongo's `_id` — as the legend
 * chip the schema canvas badges a primary key with: amber, a fixed legend hue, not the accent. One
 * component because three places draw it (the grid's header, the record layout, the records dialog)
 * and a key that looked different in each would read as three different facts.
 */
export function IdentityBadge({ badge, title }: { badge: string; title: string }) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-[3px] bg-[color-mix(in_oklab,var(--cf-warning)_15%,transparent)] px-1 py-[3px] text-[10.5px] font-bold leading-none tracking-[0.03em] text-[var(--cf-warning)]"
    >
      {badge}
    </span>
  );
}

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
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />;
}

/**
 * An icon-only button with its name in the app's tooltip.
 *
 * `iconButtonClass` underneath, so it is the same control the rest of the app draws: 22px by default
 * (the floor — this used to be a 20px square that had to be aimed at), 26px (`size="sm"`) on the
 * 44px toolbars. `active` is for toggles and is announced as `aria-pressed`. The name moved from
 * `title` into `Tooltip`, which is the only way to show a shortcut beside it as a key cap.
 */
export function ToolbarButton({
  onClick,
  title,
  description,
  shortcut,
  disabled,
  active,
  size = "xs",
  dataTour,
  children,
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  /** A second, quieter line in the tooltip — what the button is for, when its name doesn't say. */
  description?: string;
  /** The chord that also does this, as `useShortcutChord` formats it — never a literal. */
  shortcut?: string | null;
  disabled?: boolean;
  active?: boolean;
  size?: IconButtonSize;
  /** Marks this button as a guided-tour anchor. Opt-in per call site rather than derived from the
   *  title, because the tour points at a handful of controls and every other one of these should
   *  stay out of its selector list. */
  dataTour?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip
      label={title}
      description={description}
      trailing={shortcut ? <Kbd>{shortcut}</Kbd> : undefined}
    >
      <button
        type="button"
        data-tour={dataTour}
        onClick={onClick}
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        className={iconButtonClass({ size, active })}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * The icon button that takes something away — a row, a pattern, a saved password.
 *
 * `iconButtonClass`'s shape with the danger hue on hover (or at rest, `tone="danger"`, for the one
 * that stages a deletion). Written out rather than passed to `iconButtonClass` as a className,
 * because two `hover:text-*` utilities on one element have no defined winner.
 */
export function dangerIconButtonClass({
  size = "xs",
  tone = "quiet",
}: { size?: "xs" | "sm"; tone?: "quiet" | "danger" } = {}): string {
  return `inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] disabled:pointer-events-none disabled:opacity-40 ${
    size === "xs" ? "h-[22px] w-[22px]" : "h-[26px] w-[26px]"
  } ${
    tone === "danger"
      ? "text-[var(--cf-danger)]"
      : "text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
  }`;
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
