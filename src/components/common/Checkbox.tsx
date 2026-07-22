import { Check } from "lucide-react";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

// A real (invisible) checkbox input sits under a styled decorative box, so keyboard
// focus, screen readers, and "click the label text to toggle" all keep working for free.
export function Checkbox({ checked, onChange, disabled, className = "" }: CheckboxProps) {
  return (
    <span className={`relative inline-flex h-4 w-4 shrink-0 ${className}`}>
      <input
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
          borderColor: checked ? "var(--cf-accent)" : "var(--cf-border)",
          backgroundColor: checked ? "var(--cf-accent)" : "transparent",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {checked && <Check size={11} strokeWidth={3} className="text-white" />}
      </span>
    </span>
  );
}
