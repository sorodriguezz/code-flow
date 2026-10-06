import type { TranslationKey } from "../i18n/translations";

/**
 * The ten colours a table's border and a sticky note can wear in a DBML diagram, and their names.
 *
 * Ten on purpose — the user's number: enough to give each domain of a schema its own, few enough
 * that "the teal tables" means something at a glance. Written into the code as DBML's own hex
 * settings (`[headercolor: …]`, `Note … [color: …]`), so a schema pasted into dbdiagram.io keeps
 * them; any other hex a hand-edit puts there is still drawn, the menus just offer these.
 *
 * Mid-tone hues that hold on both themes, ordered as a spectrum. Named, for the same reasons
 * `swatchColors.ts` gives: a row of unlabelled dots is unreadable to a screen reader and
 * undescribable to a colleague.
 */
export const DBML_COLORS: readonly { value: string; labelKey: TranslationKey }[] = [
  { value: "#ef4444", labelKey: "color.red" },
  { value: "#f97316", labelKey: "color.orange" },
  { value: "#eab308", labelKey: "color.yellow" },
  { value: "#22c55e", labelKey: "color.green" },
  { value: "#14b8a6", labelKey: "color.teal" },
  { value: "#06b6d4", labelKey: "color.cyan" },
  { value: "#3b82f6", labelKey: "color.blue" },
  { value: "#6366f1", labelKey: "color.indigo" },
  { value: "#a855f7", labelKey: "color.purple" },
  { value: "#ec4899", labelKey: "color.pink" },
];

/** A sticky note with no colour of its own: the yellow of a paper post-it. */
export const DEFAULT_NOTE_COLOR = "#eab308";
