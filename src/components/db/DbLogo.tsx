import type { CSSProperties } from "react";
import { Plug } from "lucide-react";
import { BrandGlyph } from "../ai/ProviderGlyph";
import { monogramStyle } from "../../lib/monogram";
import { defaultDriverId, type DriverDef } from "../../lib/db/drivers";
import { dbLogo, type DbLogo } from "../../lib/db/logos";
import type { DbKind } from "../../types/database";
import { engineColor } from "./dbChrome";

/**
 * A database's mark in the workspace — its own logo — everywhere a connection or a driver is
 * listed: the data sources and drivers lists, the new-connection menu, the explorer's rows, the tabs
 * and toolbars. One component for all of them, so the logo on a tab is the one on the tree row it
 * was opened from.
 *
 * Apart from `dbChrome.tsx` for the weight it brings: see `lib/db/logos.ts`.
 *
 * What gets drawn, in order: the catalogue logo of the driver (or of the engine's own driver, for a
 * connection made before drivers existed); a driver the user added has no brand, so it keeps two
 * letters on its colour; a JDBC connection whose driver is gone gets a plug.
 */
type Mark = { logo: DbLogo; id: string } | { tile: DriverDef } | { plug: DbKind };

function markFor(driver: DriverDef | null | undefined, kind: DbKind | undefined): Mark {
  if (driver?.custom) return { tile: driver };
  const id = driver?.id ?? defaultDriverId(kind ?? "postgres");
  const logo = dbLogo(id);
  if (logo) return { logo, id };
  return driver ? { tile: driver } : { plug: kind ?? "jdbc" };
}

/** What every mark's box says about itself: named when `label` is, hidden from assistive tech when not. */
function boxProps(label?: string) {
  return {
    title: label,
    role: label ? "img" : undefined,
    "aria-label": label,
    "aria-hidden": label ? undefined : true,
  } as const;
}

/**
 * A logo in a `size` square, drawn two pixels inside it — the inset the engine glyphs it replaced had,
 * so a list mixing logos and initials keeps one axis. A mark that isn't square is centred in it.
 *
 * The box sets the colour the mark's `currentColor` parts take: its `ink` on a light sheet, the text
 * colour on a dark one (see `DbLogo.ink`). As a custom property and two classes rather than an inline
 * colour, because the dark rule has to win and an inline colour would beat any class.
 */
function Logo({ logo, id, size, label }: { logo: DbLogo; id: string; size: number; label?: string }) {
  const style = { width: size, height: size, "--cf-db-ink": logo.ink ?? "var(--cf-text)" } as CSSProperties;
  return (
    <span
      {...boxProps(label)}
      className="inline-flex shrink-0 items-center justify-center text-[var(--cf-db-ink)] dark:text-[var(--cf-text)]"
      style={style}
    >
      <BrandGlyph id={id} logo={logo} size={size - 2} />
    </span>
  );
}

/** A user-added driver's two letters on a wash of its colour — the same recipe as the projects'
 *  monograms. */
function DriverTile({ driver, size, label }: { driver: DriverDef; size: number; label?: string }) {
  return (
    <span
      {...boxProps(label)}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-[4px] font-semibold leading-none tracking-[-0.02em]"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, Math.round(size * 0.5)),
        ...monogramStyle(driver.color),
      }}
    >
      {driver.mark}
    </span>
  );
}

function MarkView({ mark, size, label }: { mark: Mark; size: number; label?: string }) {
  if ("logo" in mark) return <Logo logo={mark.logo} id={mark.id} size={size} label={label} />;
  if ("tile" in mark) return <DriverTile driver={mark.tile} size={size} label={label} />;
  return (
    <span
      {...boxProps(label)}
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, color: String(monogramStyle(engineColor(mark.plug)).color) }}
    >
      <Plug size={size - 2} aria-hidden />
    </span>
  );
}

/**
 * The mark a driver is listed with. Always a `size` square, so a list of them keeps its names
 * aligned. `kind` stands in for a driver that isn't known — the engine's own driver is drawn.
 */
export function DriverGlyph({
  driver,
  kind,
  size = 16,
}: {
  driver: DriverDef | null | undefined;
  kind?: DbKind;
  size?: number;
}) {
  return <MarkView mark={markFor(driver, kind)} size={size} />;
}

/**
 * The connection's mark on a tab, a toolbar and a tree row — its driver's logo, named for assistive
 * tech and the tooltip by `label` (the engine's name).
 */
export function EngineBadge({
  kind,
  driver,
  label,
  size = 16,
}: {
  kind: DbKind;
  /** The connection's driver: its logo, or its initials when the user added it. */
  driver?: DriverDef | null;
  label: string;
  /** 16 on a tab, 18 on a toolbar or a tree row. */
  size?: number;
}) {
  return <MarkView mark={markFor(driver, kind)} size={size} label={label} />;
}
