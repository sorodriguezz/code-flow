/**
 * Saved arrangements of the bench: "dev" is a server, a test watcher and an agent, each in its own
 * pane and each already running.
 *
 * # Why this is worth saving at all
 *
 * The panes are cheap to make and expensive to *set up*: three shells is three `cd`s and three
 * command lines, typed again every morning and after every restart. A layout is that typing, kept.
 *
 * # Why nothing starts by itself
 *
 * There is no "run this when the project opens". A layout starts processes — a dev server, a
 * watcher, an agent CLI — and starting them because a window appeared is the kind of help that costs
 * a user's battery and their ports without being asked. It is one click, and the click is theirs.
 *
 * Pure: the shape is read back from a settings row, which is untrusted input like any other stored
 * JSON, and everything that decides what a saved layout *means* belongs where it can be tested.
 */

/** One pane of a layout. */
export interface LayoutPane {
  /** Where the shell starts. Empty means the user's home, which is what the backend does with it. */
  cwd: string;
  /** What the pane is called, or empty for the shell's own name. */
  title?: string;
  /** Typed into the shell as soon as it exists, or empty for a pane that is just a shell. */
  command?: string;
}

export interface BenchLayout {
  /** What the user called it. Unique within a workspace — saving under an existing name replaces it,
   *  which is what "save" means when you have rearranged the tab you saved last week. */
  name: string;
  panes: LayoutPane[];
}

/** The most panes one layout may hold. A bench of eight shells is already unreadable, and this is
 *  the guard against a hand-edited settings row asking for four hundred. */
export const MAX_PANES = 8;

/** The layouts in a stored settings row. Anything malformed comes back empty rather than throwing
 *  in the toolbar that draws the menu. */
export function parseLayouts(raw: string | null): BenchLayout[] {
  if (!raw?.trim()) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.map(validLayout).filter((layout): layout is BenchLayout => layout !== null);
  } catch {
    return [];
  }
}

export const serializeLayouts = (layouts: readonly BenchLayout[]): string => JSON.stringify(layouts);

function validLayout(value: unknown): BenchLayout | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (name === "") return null;
  if (!Array.isArray(row.panes)) return null;
  const panes = row.panes
    .map(validPane)
    .filter((pane): pane is LayoutPane => pane !== null)
    .slice(0, MAX_PANES);
  // A layout with no panes is not an arrangement; it would open a tab and nothing in it.
  return panes.length === 0 ? null : { name, panes };
}

function validPane(value: unknown): LayoutPane | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const cwd = typeof row.cwd === "string" ? row.cwd : "";
  const title = typeof row.title === "string" ? row.title.trim() : "";
  const command = typeof row.command === "string" ? row.command.trim() : "";
  return { cwd, ...(title ? { title } : {}), ...(command ? { command } : {}) };
}

/**
 * `layouts` with `layout` saved: replacing the one of the same name, or appended.
 *
 * Case-insensitively, because "Dev" and "dev" in one menu are two rows nobody can tell apart.
 */
export function withLayout(layouts: readonly BenchLayout[], layout: BenchLayout): BenchLayout[] {
  const at = layouts.findIndex((entry) => entry.name.toLowerCase() === layout.name.toLowerCase());
  if (at < 0) return [...layouts, layout];
  return layouts.map((entry, index) => (index === at ? layout : entry));
}

/** `layouts` without the one called `name`. */
export function withoutLayout(layouts: readonly BenchLayout[], name: string): BenchLayout[] {
  return layouts.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
}

/** The one called `name`, or `null`. */
export function layoutNamed(layouts: readonly BenchLayout[], name: string): BenchLayout | null {
  return layouts.find((entry) => entry.name.toLowerCase() === name.toLowerCase()) ?? null;
}
