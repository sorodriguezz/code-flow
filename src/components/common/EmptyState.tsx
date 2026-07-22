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
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <Icon size={28} className="mb-2 text-[var(--cf-text-muted)]" />
      <p className="text-sm font-medium text-[var(--cf-text)]">{title}</p>
      {subtitle && <p className="max-w-xs text-[13px] text-[var(--cf-text-muted)]">{subtitle}</p>}
    </div>
  );
}
