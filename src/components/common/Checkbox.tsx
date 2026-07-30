import { useEffect, useRef } from "react";
import { Check, Minus } from "lucide-react";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /**
   * "Some of what this box stands for is checked" — a select-all over a partial selection.
   *
   * Only meaningful on a box that governs others, and it is a look rather than a third value:
   * `checked` still says what a click reports, so an indeterminate select-all decides for itself
   * whether the click means "all" or "none".
   */
  indeterminate?: boolean;
  className?: string;
}

// A real (invisible) checkbox input sits under a styled decorative box, so keyboard
// focus, screen readers, and "click the label text to toggle" all keep working for free.
export function Checkbox({
  checked,
  onChange,
  disabled,
  indeterminate = false,
  className = "",
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  // Not an attribute — the mixed state exists only as a DOM property, and setting it is what makes
  // a screen reader say "mixed" instead of "unchecked".
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const filled = checked || indeterminate;
  return (
    <span className={`relative inline-flex h-4 w-4 shrink-0 ${className}`}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className="pointer-events-none flex h-4 w-4 items-center justify-center rounded-[4px] border transition-colors duration-100 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--cf-accent)] peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-[var(--cf-surface)]"
        style={{
          borderColor: filled ? "var(--cf-accent)" : "var(--cf-border)",
          backgroundColor: filled ? "var(--cf-accent)" : "transparent",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {checked ? (
          <Check size={11} strokeWidth={3} className="text-white" />
        ) : indeterminate ? (
          <Minus size={11} strokeWidth={3} className="text-white" />
        ) : null}
      </span>
    </span>
  );
}
