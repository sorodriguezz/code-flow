import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ActivePill } from "./ActivePill";
import { Tooltip } from "./Tooltip";
import { segItemClass, segTrackClass } from "./recipes";

export interface SegmentedOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: LucideIcon;
  /** Tooltip; also the accessible name when the option shows only an icon. */
  title?: string;
  disabled?: boolean;
}

/**
 * The segmented control — the one recipe for two to four peer choices that change how the same
 * thing is shown (Unificada / En paralelo, Editor / Dividido / Vista previa, Grafo / Cascada).
 *
 * Before this the app drew eight of them, each with its own track, thumb and text size. The thumb
 * is the raised sheet the active tab and the active app wear, and it slides between options
 * (`ActivePill` with the given `layoutId`, one per control — never shared between two on screen).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  layoutId,
  size = "md",
  full = false,
  className = "",
  ariaLabel,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  layoutId: string;
  size?: "sm" | "md";
  full?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={segTrackClass({ full, className })}>
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        const button = (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            aria-pressed={active}
            aria-label={option.label ? undefined : option.title}
            onClick={() => onChange(option.value)}
            className={segItemClass(active, { size, full, className: "disabled:pointer-events-none disabled:opacity-45" })}
          >
            {active && <ActivePill layoutId={layoutId} variant="raised" />}
            <span className="relative inline-flex min-w-0 items-center gap-1.5">
              {Icon && <Icon size={size === "sm" ? 12 : 13} className="shrink-0" />}
              {option.label && <span className="truncate">{option.label}</span>}
            </span>
          </button>
        );
        return option.title ? (
          <Tooltip key={option.value} label={option.title}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
