import {
  BookOpen,
  Bug,
  CalendarDays,
  CheckSquare,
  ClipboardList,
  FileText,
  GitBranch,
  Lightbulb,
  Repeat,
  Rocket,
  Siren,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * The icons a template may carry.
 *
 * **A fixed set, not a lookup into lucide's export map.** The tempting version of this file is
 * `import * as icons from "lucide-react"` and a name-to-component lookup, which would let a
 * template use any of the two thousand glyphs in the library. It would also pull all two thousand
 * into the bundle: a namespace import is the one thing that defeats tree-shaking completely, and
 * the cost lands on every user whether or not they ever open the template picker.
 *
 * Twelve is more than enough to make a template recognisable in a list, which is the entire job.
 * The picker offers exactly these, so a stored name can only ever be one of them — and `iconOf`
 * still falls back rather than trusting that, because the value comes from a database.
 */
export const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  "file-text": FileText,
  users: Users,
  "calendar-days": CalendarDays,
  "git-branch": GitBranch,
  siren: Siren,
  "clipboard-list": ClipboardList,
  repeat: Repeat,
  "book-open": BookOpen,
  lightbulb: Lightbulb,
  rocket: Rocket,
  bug: Bug,
  "check-square": CheckSquare,
};

/** The order the picker offers them in. */
export const TEMPLATE_ICON_NAMES = Object.keys(TEMPLATE_ICONS);

/** A stored icon name as a component, falling back to the generic document. */
export function iconOf(name: string): LucideIcon {
  return TEMPLATE_ICONS[name] ?? FileText;
}
