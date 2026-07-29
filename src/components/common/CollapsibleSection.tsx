import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";

export function CollapsibleSection({
  icon: Icon,
  title,
  action,
  defaultOpen = false,
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
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Icon size={12} />
          {title}
        </button>
        {typeof action === "function" ? action({ open, expand: () => setOpen(true) }) : action}
      </div>
      {open && children}
    </div>
  );
}
