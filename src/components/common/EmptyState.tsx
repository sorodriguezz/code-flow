import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /**
   * The one thing to do about being empty — a "New note" button, an "Add a connection" button.
   *
   * **It goes inside this box rather than beside it**, and that is the whole point of the prop.
   * This component is `h-full`, so a caller that puts a button next to it in a flex column gets a
   * box that claims the entire pane and a button stranded at the very bottom of it, a screen away
   * from the sentence it answers. `ApiView` works around that by wrapping this in a height-less
   * `div` — which is correct, and is also a piece of CSS reasoning nobody should have to rediscover
   * to put a button under a message. Passed here, the button is laid out by the same centred
   * column as the text and the two arrive as one group.
   */
  action?: ReactNode;
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
      {/* `shrink-0` for the same reason as the icon, and `mt-2` because the gap that separates two
          lines of prose is too tight to separate prose from a control. */}
      {action && <div className="mt-2 shrink-0">{action}</div>}
    </div>
  );
}
