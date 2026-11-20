import { Blocks, Layers } from "lucide-react";
import { BrandGlyph } from "../ai/ProviderGlyph";
import { IMAGE_LOGOS } from "../../lib/containers/logos";
import { dbLogo } from "../../lib/db/logos";
import type { BrandLogo } from "../../lib/icons/brandLogos";
import { glyphIdOf } from "./pageModel";

/**
 * The tile a container, an image or a Compose project wears at the start of its row — the mark of
 * what it runs when the app has one (`glyphIdOf`), else a neutral layers glyph. It gives the lists
 * something to scan by besides names: a column of Postgres, nginx and Node marks reads faster than a
 * column of `snappy_turing`s.
 */

/** Database images borrow the database catalogue's marks rather than a second copy. */
const FROM_DB: Record<string, string> = { postgresql: "postgresql", mysql: "mysql", mariadb: "mariadb", mongodb: "mongodb", redis: "redis", mssql: "sqlserver" };

function logoFor(id: string | null): BrandLogo | null {
  if (!id) return null;
  if (FROM_DB[id]) return dbLogo(FROM_DB[id]);
  return IMAGE_LOGOS[id] ?? null;
}

const TILE = "flex shrink-0 items-center justify-center rounded-[7px] bg-[var(--cf-hover)] shadow-[inset_0_0_0_1px_var(--cf-border)]";

export function ImageGlyph({ reference, size = 26, dim = false }: { reference: string; size?: number; dim?: boolean }) {
  const id = glyphIdOf(reference);
  const logo = logoFor(id);
  const inner = Math.round(size * 0.58);
  return (
    <span aria-hidden className={`${TILE} ${dim ? "opacity-55 grayscale" : ""}`} style={{ width: size, height: size }}>
      {logo && id ? <BrandGlyph id={`image-${id}`} logo={logo} size={inner} className="text-[var(--cf-text)]" /> : <Layers size={inner} className="text-[var(--cf-text-muted)]" />}
    </span>
  );
}

/** A Compose project's tile: the stack, not any one of its images. */
export function ProjectGlyph({ size = 26 }: { size?: number }) {
  return (
    <span aria-hidden className={TILE} style={{ width: size, height: size }}>
      <Blocks size={Math.round(size * 0.55)} className="text-[var(--cf-text-muted)]" />
    </span>
  );
}

/** A plain tile with a Lucide icon — volumes and networks, which have no image to show. */
export function IconTile({ icon: Icon, size = 26 }: { icon: typeof Layers; size?: number }) {
  return (
    <span aria-hidden className={TILE} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.55)} className="text-[var(--cf-text-muted)]" />
    </span>
  );
}
