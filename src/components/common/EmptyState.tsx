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
      {/* `shrink-0` or the icon is the first thing to go. An SVG in a column flex container has no
          content to establish a minimum height with, so when the text below it doesn't fit the box
          the caller gave us, the browser takes the space out of the icon — which turns a 28px glyph
          into a two-pixel smear rather than overflowing visibly enough for anyone to notice. */}
      <Icon size={28} className="mb-2 shrink-0 text-[var(--cf-text-muted)]" />
      <p className="text-sm font-medium text-[var(--cf-text)]">{title}</p>
      {subtitle && <p className="max-w-xs text-[13px] text-[var(--cf-text-muted)]">{subtitle}</p>}
    </div>
  );
}
