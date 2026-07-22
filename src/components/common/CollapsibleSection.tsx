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
  action?: ReactNode;
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
        {action}
      </div>
      {open && children}
    </div>
  );
}
