import type { TranslationKey } from "./i18n/translations";

/**
 * The colours a row in a workspace tree can be marked with, and what each one is called.
 *
 * **One list for both trees.** Notes' books and Diagrams' folders had a copy each, identical value
 * for value and deliberately so — the point of a marker colour is that "the blue one" means the
 * same thing wherever you are in the app, and two lists is how that quietly stops being true. This
 * is that agreement written down once.
 *
 * **Deliberately few.** Nine including "none". This is a marker, not a palette: the colour's whole
 * job is telling two rows apart at a glance, and a picker with thirty swatches turns choosing one
 * into a task. That is also why it is not [`WORKSPACE_COLORS`], which has thirty-odd on purpose —
 * a workspace colour is an *identity* for something you have fifteen of, while a folder colour is
 * a highlighter.
 *
 * **Every entry carries a name**, which is the reason this file exists rather than a bare array of
 * hex strings. A menu of unlabelled dots cannot be read by a screen reader, cannot be searched, and
 * cannot be described to a colleague; the version of it that showed `#a855f7` as the label was
 * worse still, since nobody knows which one that is either.
 *
 * Ordered by hue, so the list reads as a spectrum rather than as a bag of colours.
 */
export interface Swatch {
  /** The stored value. Empty is "no colour", which draws the row in the muted default. */
  value: string;
  labelKey: TranslationKey;
}

export const TREE_COLORS: readonly Swatch[] = [
  { value: "", labelKey: "color.none" },
  { value: "#ef4444", labelKey: "color.red" },
  { value: "#f97316", labelKey: "color.orange" },
  { value: "#eab308", labelKey: "color.yellow" },
  { value: "#22c55e", labelKey: "color.green" },
  { value: "#06b6d4", labelKey: "color.cyan" },
  { value: "#6366f1", labelKey: "color.indigo" },
  { value: "#a855f7", labelKey: "color.purple" },
  { value: "#ec4899", labelKey: "color.pink" },
] as const;
