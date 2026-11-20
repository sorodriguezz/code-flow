import { ChevronsRight } from "lucide-react";
import { explorerClass } from "./recipes";
import { LAYOUT_DEFAULTS, useLayoutStore, type LayoutKey } from "../../state/layoutStore";

/**
 * A side panel folded to a bar: the full height, 28px wide, the whole of it one button that unfolds
 * the panel. What a panel shows after its seam was dragged well past the minimum (see
 * `ResizeHandle`'s `collapseBeyond`) — the room goes to the content beside it, and the panel is one
 * click away (user, 2026-11-19).
 */
export function CollapsedPanelBar({
  label,
  title,
  onExpand,
  tour,
}: {
  /** The panel's name, written down the bar. */
  label: string;
  /** Tooltip and accessible name of the button. */
  title: string;
  onExpand: () => void;
  /** The panel's `data-tour` anchor, kept on the bar so a tour step still finds it. */
  tour?: string;
}) {
  return (
    <button
      type="button"
      data-tour={tour}
      onClick={onExpand}
      title={title}
      aria-label={title}
      aria-expanded={false}
      className={`${explorerClass} group flex h-full w-[28px] shrink-0 select-none flex-col items-center gap-3 overflow-hidden py-3 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]`}
    >
      <ChevronsRight size={14} className="shrink-0 group-hover:text-[var(--cf-accent)]" />
      <span className="whitespace-nowrap text-[11px] font-medium tracking-wide [writing-mode:vertical-rl]">{label}</span>
    </button>
  );
}

/**
 * Folding for a side panel whose width is a `LayoutKey`: whether it is folded, and the two moves.
 * `expand` puts the panel back at its suggested width (`LAYOUT_DEFAULTS`), not at whatever narrow
 * width it was being dragged through when it folded.
 */
export function useCollapsiblePanel(key: LayoutKey) {
  const collapsed = useLayoutStore((s) => s.collapsedPanels.includes(key));
  const setPanelCollapsed = useLayoutStore((s) => s.setPanelCollapsed);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  return {
    collapsed,
    /** Spread onto the panel's `ResizeHandle`: dragged 80px past the minimum, it folds. */
    handleProps: { collapseBeyond: 80, onCollapse: () => setPanelCollapsed(key, true) },
    expand: () => {
      setSize(key, LAYOUT_DEFAULTS[key]);
      commitSize(key, LAYOUT_DEFAULTS[key]);
      setPanelCollapsed(key, false);
    },
  };
}
