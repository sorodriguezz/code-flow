import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { tapped } from "../haptics";

/**
 * Every button in this client, in one place.
 *
 * # Why the variants are named after intent
 *
 * The screens used to spell each button out in eight Tailwind classes, which meant there were as
 * many button designs as there were buttons: the commit button and the approve button were both
 * "the primary action" and were two different heights, two different radii and two different text
 * sizes. Naming the intent instead — `primary`, `secondary`, `ghost`, `danger` — is what makes the
 * whole app agree on what a primary action looks like, and makes changing that a one-line edit.
 *
 * # The loading state is part of the button, not beside it
 *
 * Half the actions here run over wifi against a machine in another room, and several of them run an
 * AI engine and take minutes. A button that stays exactly as it was while that happens is a button
 * people press twice. `loading` swaps the label for a spinner *at the same width*, so the layout
 * does not jump and the row does not reflow under a thumb that is still on the glass.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-[var(--cf-accent-strong)] text-[var(--cf-accent-contrast)] font-medium shadow-card",
  secondary:
    "border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text)]",
  ghost: "text-[var(--cf-text-muted)]",
  danger: "bg-[var(--cf-danger)] text-white font-medium",
  success: "bg-[var(--cf-success)] text-white font-medium",
};

const SIZES: Record<Size, string> = {
  // Still 44px tall through `cf-tap`; the padding is what changes, and with it how much room the
  // label has to breathe.
  sm: "px-3 text-sm gap-1.5 rounded-md",
  md: "px-4 text-base gap-2 rounded-lg",
  lg: "px-5 text-lg gap-2 rounded-lg",
};

export function Button({
  children,
  onClick,
  variant = "secondary",
  size = "md",
  disabled,
  loading,
  icon,
  full,
  className = "",
  ariaLabel,
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: Variant;
  size?: Size;
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  /** Stretches to the width of its container. The default is to size to content. */
  full?: boolean;
  className?: string;
  /** Required when there is no text child — an icon is not a name. */
  ariaLabel?: string;
}) {
  const isDisabled = disabled || loading;
  return (
    <button
      type="button"
      disabled={isDisabled}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      onClick={() => {
        if (isDisabled) return;
        // The receipt. Fired here rather than in each caller so that no action can forget it, and
        // before the handler runs so it lands while the thumb is still down.
        tapped();
        onClick?.();
      }}
      className={`cf-tap cf-press flex items-center justify-center ${SIZES[size]} ${VARIANTS[variant]} disabled:opacity-40 ${full ? "w-full" : ""} ${className}`}
    >
      {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

/**
 * A button that is only an icon — a back chevron, a stop square, a dismiss cross.
 *
 * `label` is not optional, and that is the point of having this component at all. Every icon-only
 * control in this client used to be a bare `<button>` with a `title`, which screen readers on touch
 * devices do not announce: VoiceOver read "button", eleven times, down the Repo screen. The label
 * is a required parameter so the next one cannot be written without one.
 */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  tone = "muted",
  className = "",
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "muted" | "text" | "accent" | "danger";
  className?: string;
}) {
  const tones = {
    muted: "text-[var(--cf-text-muted)]",
    text: "text-[var(--cf-text)]",
    accent: "text-[var(--cf-accent-text)]",
    danger: "text-[var(--cf-danger-text)]",
  };
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onClick={() => {
        if (disabled) return;
        tapped();
        onClick?.();
      }}
      className={`cf-tap cf-press flex shrink-0 items-center justify-center rounded-md ${tones[tone]} disabled:opacity-40 ${className}`}
    >
      {icon}
    </button>
  );
}
