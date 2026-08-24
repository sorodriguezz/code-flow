import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { navigated } from "../haptics";
import { useNav } from "../nav";
import { t } from "../i18n";

/**
 * The bar at the top of a screen.
 *
 * # In the flow, not over it
 *
 * A flex child above the screen's scroller, rather than anything positioned. A `fixed` bar has to be
 * paid for with padding at the top of every screen's content, gets that padding wrong on one of
 * them, and — the reason it would actually be a problem here — is positioned against the layout
 * viewport, which is not the box this app lives in once the keyboard is up (see `viewport.ts`).
 *
 * Nothing scrolls under it, so it is opaque: a translucent blurred bar with the page background
 * behind it is a compositing layer on a phone GPU in exchange for no visible difference.
 */
export function AppBar({
  title,
  subtitle,
  leading,
  actions,
  below,
  safeTop = false,
}: {
  /** A string is wrapped in the screen's `<h1>`; a node is placed as-is, and is then responsible
   *  for carrying the heading itself. */
  title: ReactNode;
  subtitle?: ReactNode;
  /** Drawn at the far left — the back control, or nothing on a tab root. */
  leading?: ReactNode;
  actions?: ReactNode;
  /** A row under the title — a segmented control, a filter. Part of the bar so it sticks with it. */
  below?: ReactNode;
  safeTop?: boolean;
}) {
  return (
    <header
      className={`shrink-0 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] ${safeTop ? "cf-safe-top" : ""} cf-safe-x`}
    >
      <div className="flex min-h-[3rem] items-center gap-1 px-1.5">
        {leading}
        <div className="min-w-0 flex-1 px-1.5">
          {typeof title === "string" ? (
            <h1 className="truncate text-md font-semibold leading-tight">{title}</h1>
          ) : (
            title
          )}
          {subtitle && (
            <p className="truncate text-xs leading-tight text-[var(--cf-text-muted)]">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-0.5 pr-0.5">{actions}</div>}
      </div>
      {below}
    </header>
  );
}

/**
 * The app bar a pushed screen wears, with the control that is most of the point of this rewrite.
 *
 * # Why the back control is a labelled target and not a bare chevron
 *
 * It used to be an 18-pixel `<ChevronLeft>` in the corner of a full-screen overlay that covered the
 * tab bar, with an empty accessible name. It was the *only* way out of a diff, and users did not
 * find it — which is the complaint this whole change answers. It is now: the same chevron, plus the
 * word for "back", plus a wider target, plus the tab bar still visible behind the screen, plus the
 * phone's own back button, plus an edge swipe. Any one of those getting missed no longer strands
 * anybody.
 */
export function PushBar({
  title,
  subtitle,
  actions,
  below,
  onBack,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  below?: ReactNode;
  /** Overrides the default, which is the navigation stack's own back. */
  onBack?: () => void;
}) {
  const back = useNav((s) => s.back);
  return (
    <AppBar
      title={title}
      subtitle={subtitle}
      actions={actions}
      below={below}
      leading={
        <button
          type="button"
          onClick={() => {
            navigated();
            (onBack ?? back)();
          }}
          className="cf-tap cf-press -ml-0.5 flex items-center gap-0.5 pl-1 pr-2 text-[var(--cf-accent-text)]"
        >
          <ChevronLeft size={20} aria-hidden />
          <span className="text-base font-medium">{t("common.back")}</span>
        </button>
      }
    />
  );
}
