import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";

export function CollapsibleSection({
  icon: Icon,
  title,
  action,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  icon: LucideIcon;
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
      <div className="mb-1 flex items-center justify-between">
        <button
          onClick={() => change(!open)}
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Icon size={12} />
          {title}
        </button>
        {typeof action === "function" ? action({ open, expand: () => change(true) }) : action}
      </div>
      {open && children}
    </div>
  );
}
