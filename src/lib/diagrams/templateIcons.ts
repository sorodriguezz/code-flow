import {
  Boxes,
  Cloud,
  Database,
  GitBranch,
  Layers,
  ListOrdered,
  Network,
  Share2,
  Shapes,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * The icons a diagram template may carry.
 *
 * **A fixed set, not a lookup into lucide's export map**, for the reason `lib/notes/templateIcons`
 * spells out: `import * as icons from "lucide-react"` would let a template name any of two thousand
 * glyphs and would pull all two thousand into the bundle, because a namespace import is the one
 * thing that defeats tree-shaking completely. Eleven is more than enough to make a template
 * recognisable in a list, which is the entire job.
 */
export const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  workflow: Workflow,
  layers: Layers,
  "list-ordered": ListOrdered,
  database: Database,
  network: Network,
  boxes: Boxes,
  cloud: Cloud,
  "git-branch": GitBranch,
  share2: Share2,
  shapes: Shapes,
  users: Users,
};

/** The default, for a stored name this build doesn't know. */
const FALLBACK = Workflow;

/** The component for a stored icon name. Falls back rather than trusting the database — the value
 *  can predate this build, or come from a hand-edited row. */
export function templateIcon(name: string): LucideIcon {
  return TEMPLATE_ICONS[name] ?? FALLBACK;
}
