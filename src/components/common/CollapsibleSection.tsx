import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";

export function CollapsibleSection({
  icon: Icon,
  title,
  action,
  defaultOpen = false,
  onOpenChange,
  dense = false,
  children,
}: {
  /** Optional only because `dense` does not draw one — every full-size section should have one. */
  icon?: LucideIcon;
  title: string;
  // Header buttons — the "+" ones in particular — usually reveal a form or a modal that lives
  // in `children`, and `children` isn't mounted while the section is collapsed, so their state
  // flips with nothing on screen. Pass a function instead of a node to get `expand` (and the
  // current `open`) and unfold the section as part of the same click.
  action?: ReactNode | ((ctx: { open: boolean; expand: () => void }) => ReactNode);
  defaultOpen?: boolean;
  /**
   * Told every time the section folds or unfolds, `expand()` from `action` included.
   *
   * For sections whose *contents cost something to produce*: not rendering the children is only
   * half of staying cheap, because the work that feeds them is started by effects in the parent,
   * which stays mounted whatever this section is showing. Unfolding is the signal that the user
   * has asked for that work — see `PullRequestsSection`, which does not talk to the host at all
   * until this fires.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * The panel-width variant: smaller type, tighter tracking, no icon.
   *
   * For a narrow column rather than a settings pane — the DBML inspector is 236px by default, and
   * at that width the standard header's 11px uppercase with an icon in front of it takes a third of
   * the line before the title starts. This matches the heading the inspector already drew before it
   * had a chevron, so folding arrived there as a new *behaviour* rather than as a restyle.
   *
   * A variant rather than a fork: the two headers do the same job and one of them being a size
   * smaller is not a reason for a second component to keep in step with this one.
   */
  dense?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Silent when nothing moved: `expand()` is called by header buttons that don't know or care
  // whether the section was already unfolded, and reporting those as openings would make the
  // callback a click counter rather than a state change. Consumers get to be non-idempotent.
  const change = (next: boolean) => {
    if (next === open) return;
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div>
      <div className={`flex items-center justify-between ${dense ? "mb-0.5" : "mb-1"}`}>
        <button
          onClick={() => change(!open)}
          className={`flex min-w-0 items-center gap-1 font-semibold uppercase text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] ${
            dense ? "text-[9px] tracking-[0.09em]" : "text-[11px] tracking-wide"
          }`}
        >
          {open ? (
            <ChevronDown size={dense ? 10 : 11} className="shrink-0" />
          ) : (
            <ChevronRight size={dense ? 10 : 11} className="shrink-0" />
          )}
          {/* The glyph is what goes first when the row gets narrow: at 9px the chevron already says
              "this folds", and the title is the only part that cannot be inferred. */}
          {!dense && Icon && <Icon size={12} />}
          <span className="truncate">{title}</span>
        </button>
        {typeof action === "function" ? action({ open, expand: () => change(true) }) : action}
      </div>
      {open && children}
    </div>
  );
}
