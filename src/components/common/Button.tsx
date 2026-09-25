import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * The one button recipe.
 *
 * Before this there were about 37 primary-button class strings in the app, with three different
 * hover treatments (`brightness-110`, `opacity-90`, none), disabled at 40% or 50%, and text from
 * 11 to 13px — every dialog and toolbar had written its own. These four variants and three sizes
 * cover every button the app draws; anything else is an icon button (`iconButtonClass`).
 *
 * The text on a filled button is `--cf-on-accent`, never `white`: on the dark-mode accents white
 * measured under 3:1 for all ten, so the token turns to dark ink there. A filled `danger` button
 * uses the same token for the same reason.
 *
 * Hover darkens (or, on dark, lightens) the fill by mixing in `--cf-text` rather than by
 * `brightness`, which washed the light-mode accents out and dropped their contrast.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,color,box-shadow] duration-100 disabled:pointer-events-none disabled:opacity-45";

const SIZES: Record<ButtonSize, string> = {
  sm: "h-6 px-2 text-[12px]",
  md: "h-7 px-3 text-[13px]",
  lg: "h-8 px-3.5 text-[13px]",
};

const VARIANTS: Record<ButtonVariant, string> = {
  // The `-fill` and `--cf-control` aliases rather than the tokens themselves: identical until the
  // window is see-through, when a control lets some of the backdrop through (see `index.css`).
  primary:
    "bg-[var(--cf-accent-fill)] font-semibold text-[var(--cf-on-accent)] hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))]",
  secondary:
    "bg-[var(--cf-control)] text-[var(--cf-text)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:bg-[color-mix(in_oklab,var(--cf-text)_4%,var(--cf-control))]",
  ghost: "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]",
  danger:
    "bg-[var(--cf-danger-fill)] font-semibold text-[var(--cf-on-accent)] hover:bg-[color-mix(in_oklab,var(--cf-danger-fill)_86%,var(--cf-text))]",
  "danger-ghost":
    "text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)]",
};

export function buttonClass({
  variant = "secondary",
  size = "md",
  className = "",
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return `${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${className}`;
}

export type IconButtonSize = "xs" | "sm" | "md";

const ICON_SIZES: Record<IconButtonSize, string> = {
  xs: "h-[22px] w-[22px]",
  sm: "h-[26px] w-[26px]",
  md: "h-7 w-7",
};

/**
 * A square, icon-only button. 22px is the floor: rows used to carry 13–16px targets that had to be
 * aimed at. `active` is for toggles (a panel that is open, a filter that is on) and pairs with
 * `aria-pressed` at the call site.
 */
export function iconButtonClass({
  size = "sm",
  active = false,
  className = "",
}: { size?: IconButtonSize; active?: boolean; className?: string } = {}): string {
  return `inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40 ${
    ICON_SIZES[size]
  } ${
    active
      ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
      : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
  } ${className}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className = "", type = "button", ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClass({ variant, size, className })} {...rest} />;
});

/** A key cap, for the chords shown in menus, tooltips and the palette. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="cf-kbd">{children}</kbd>;
}
