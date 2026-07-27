import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
}) {
  return (
    // `w-full` as well as `h-full`: this centres its content inside the box it's given, so a
    // caller that drops it into a flex *row* would otherwise get a box shrunk to the width of the
    // text — centred within itself, hard against the left edge of the panel.
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <Icon size={28} className="mb-2 text-[var(--cf-text-muted)]" />
      <p className="text-sm font-medium text-[var(--cf-text)]">{title}</p>
      {subtitle && <p className="max-w-xs text-[13px] text-[var(--cf-text-muted)]">{subtitle}</p>}
    </div>
  );
}
