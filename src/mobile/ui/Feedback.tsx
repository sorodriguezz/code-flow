import type { CSSProperties, ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { t } from "../i18n";
import { Button } from "./Button";

/**
 * Loading, empty and failed — the three states every screen in this client spends most of its life
 * in, and the three it used to draw worst.
 *
 * Before this file: loading was a centred spinner or the word *"Cargando…"*, empty was one grey
 * sentence in the middle of a white page, and failure was an eleven-pixel red line in the header
 * that the user had already scrolled away from. All three read as "nothing here", which is the one
 * meaning that is wrong in two of the three cases.
 */

/** A block of shimmer in the shape of what is coming. */
export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={`cf-skeleton ${className}`} style={style} aria-hidden />;
}

/**
 * The shape of a list, while the list is on its way.
 *
 * Drawn as rows in a card, because that is what arrives — a spinner tells the user to wait, and a
 * skeleton tells them what they are waiting for, which is the difference between a screen that
 * feels slow and one that feels like it is loading.
 */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]"
      role="status"
      aria-label={t("common.loading")}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-3 py-3">
          <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            {/* Deliberately uneven widths. A column of identical bars reads as a loading *graphic*;
                ragged ones read as text that has not arrived. */}
            <Skeleton className={index % 2 === 0 ? "h-3 w-3/4" : "h-3 w-1/2"} />
            <Skeleton className="mt-1.5 h-2.5 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A spinner where a spinner is genuinely the right answer: inline, in a control, or over a
 *  terminal that is already drawn. */
export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <Loader2
      size={size}
      className={`animate-spin text-[var(--cf-text-muted)] ${className}`}
      aria-hidden
    />
  );
}

/**
 * Nothing to show, said as something rather than as an absence.
 *
 * The icon sits on a soft accent disc rather than floating grey on the background: an empty state
 * is the *first* thing many users see on a tab, and a page with one sentence in 13px grey in the
 * middle of it reads as a screen that failed to load.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-8 pb-10 pt-16 text-center">
      <div className="cf-brand-wash flex h-16 w-16 items-center justify-center rounded-2xl border border-[var(--cf-border)] text-[var(--cf-text-muted)]">
        {icon}
      </div>
      <p className="mt-4 text-md font-medium">{title}</p>
      {hint && (
        <p className="mt-1.5 max-w-[19rem] text-base leading-relaxed text-[var(--cf-text-muted)]">
          {hint}
        </p>
      )}
      {action && <div className="mt-4 flex w-full max-w-[16rem] flex-col">{action}</div>}
    </div>
  );
}

/**
 * A read that failed, with the machine's own words and a way to try again.
 *
 * `detail` is kept verbatim and in monospace. It is usually the only part of the screen that names
 * the file, the branch or the host that is actually the problem, and rewriting it into something
 * friendlier is how a UI ends up saying "no se pudo" about eleven different situations.
 */
export function ErrorState({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center px-6 pb-10 pt-14 text-center" role="alert">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--cf-danger)]/30 bg-[var(--cf-danger-soft)] text-[var(--cf-danger-text)]">
        <RefreshCw size={22} aria-hidden />
      </div>
      <p className="mt-4 text-md font-medium">{title}</p>
      {detail && (
        <p className="cf-selectable mt-2 max-w-[22rem] break-words font-mono text-xs leading-relaxed text-[var(--cf-text-muted)]">
          {detail}
        </p>
      )}
      {onRetry && (
        <Button className="mt-4" onClick={onRetry} icon={<RefreshCw size={14} />}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

type BadgeTone = "neutral" | "accent" | "success" | "danger" | "warning";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]",
  accent: "bg-[var(--cf-accent-soft)] text-[var(--cf-accent-text)]",
  success: "bg-[var(--cf-success-soft)] text-[var(--cf-success-text)]",
  danger: "bg-[var(--cf-danger-soft)] text-[var(--cf-danger-text)]",
  warning: "bg-[var(--cf-warning-soft)] text-[var(--cf-warning-text)]",
};

/** A small piece of status attached to a row: a count, a state, a letter from `git status`. */
export function Badge({
  children,
  tone = "neutral",
  icon,
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold ${BADGE_TONES[tone]} ${className}`}
    >
      {icon}
      {children}
    </span>
  );
}
