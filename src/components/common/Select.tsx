import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Marks what kind of thing the option is — a local branch vs a remote one, say. Shown both in
   * the menu and on the closed trigger, so the kind of the current value stays readable once the
   * menu is gone. Optional: an option list where every entry is the same kind doesn't need it. */
  icon?: LucideIcon;
  /**
   * A mark rendered before the label, in the menu and on the closed trigger.
   *
   * Where `icon` inherits the row's colour, this keeps whatever colour it brings — it is for marks
   * whose colour *is* the information, like a database engine's brand hue, which must not fade to
   * muted grey on the rows that happen not to be selected.
   */
  leading?: ReactNode;
}

export interface SelectGroup {
  /** Group heading shown above its options (like a native <optgroup>). */
  label: string;
  options: SelectOption[];
}

export type SelectItems = Array<SelectOption | SelectGroup>;

function isGroup(item: SelectOption | SelectGroup): item is SelectGroup {
  return (item as SelectGroup).options !== undefined;
}

/** All options flattened in display order — used for keyboard navigation and to resolve the
 * label of the current value. */
function flatten(items: SelectItems): SelectOption[] {
  const out: SelectOption[] = [];
  for (const item of items) {
    if (isGroup(item)) out.push(...item.options);
    else out.push(item);
  }
  return out;
}

const SIZE = {
  sm: "px-1.5 py-0.5 text-[12px]",
  md: "px-2.5 py-1.5 text-[13px]",
  /**
   * `md`'s metrics rebuilt on the 12px text every form `<input>` in the app uses. The page's
   * line-height is unitless, so a 13px trigger next to a 12px input is 1.5px taller and their
   * bottom edges visibly miss each other — this is the size to reach for whenever a select shares
   * a row, or a stack of rows, with text fields.
   */
  field: "px-2 py-1.5 text-[12px]",
} as const;

/**
 * A drop-in replacement for a native `<select>`, built as a real element list so the open menu
 * can be themed — options highlight in a soft tint of the user's accent color (a native `<select>`
 * only offers the OS's grey/blue highlight), and the chevron sits with proper spacing instead of
 * jammed against the edge. Supports flat option lists and grouped options, keyboard navigation,
 * and renders the menu in a portal so it's never clipped by a modal or scroll container.
 */
export function Select({
  value,
  onChange,
  options,
  disabled = false,
  placeholder,
  size = "md",
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectItems;
  disabled?: boolean;
  placeholder?: string;
  size?: keyof typeof SIZE;
  className?: string;
  ariaLabel?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const flat = useMemo(() => flatten(options), [options]);
  const selected = flat.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? "";
  const SelectedIcon = selected?.icon;

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Prefer opening downward; flip up only when there's clearly more room above.
    const below = spaceBelow >= 200 || spaceBelow >= spaceAbove;
    const maxHeight = Math.min(288, (below ? spaceBelow : spaceAbove) - 12);
    setPos({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(120, maxHeight),
      top: below ? rect.bottom + 4 : undefined,
      bottom: below ? undefined : window.innerHeight - rect.top + 4,
    });
  }, []);

  // Position on open, and keep it pinned to the trigger while scrolling/resizing.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  // Close on any click that lands outside both the trigger and the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the keyboard-highlighted option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const openMenu = () => {
    if (disabled) return;
    const current = flat.findIndex((o) => o.value === value);
    setActiveIndex(current >= 0 ? current : flat.findIndex((o) => !o.disabled));
    setOpen(true);
  };

  const commit = (opt: SelectOption) => {
    if (opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const step = (dir: 1 | -1) => {
    if (flat.length === 0) return;
    let i = activeIndex;
    for (let n = 0; n < flat.length; n++) {
      i = (i + dir + flat.length) % flat.length;
      if (!flat[i].disabled) break;
    }
    setActiveIndex(i);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIndex >= 0 && flat[activeIndex]) commit(flat[activeIndex]);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  // Walk items in display order, assigning each option its flat index for highlight/selection.
  let idx = -1;
  const rows: ReactNode[] = [];
  const renderOption = (opt: SelectOption, i: number) => {
    const isActive = i === activeIndex;
    const isSelected = opt.value === value;
    const Icon = opt.icon;
    return (
      <div
        key={`o-${opt.value}-${i}`}
        role="option"
        aria-selected={isSelected}
        data-index={i}
        onMouseEnter={() => !opt.disabled && setActiveIndex(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => commit(opt)}
        className={`flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[13px] ${
          opt.disabled
            ? "cursor-not-allowed text-[var(--cf-text-muted)] opacity-50"
            : `cursor-pointer ${isSelected ? "font-medium text-[var(--cf-accent)]" : "text-[var(--cf-text)]"} ${
                isActive ? "bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]" : ""
              }`
        }`}
      >
        {/* The icon sits inside the label's flex box so it inherits the row's colour — muted,
            accent when selected — rather than being a separate thing to keep in step. */}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {opt.leading}
          {Icon && <Icon size={13} className="shrink-0 opacity-70" />}
          <span className="truncate">{opt.label}</span>
        </span>
        {isSelected && <Check size={14} className="shrink-0 text-[var(--cf-accent)]" />}
      </div>
    );
  };
  for (const item of options) {
    if (isGroup(item)) {
      rows.push(
        <div
          key={`g-${item.label}`}
          className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]"
        >
          {item.label}
        </div>,
      );
      for (const opt of item.options) rows.push(renderOption(opt, ++idx));
    } else {
      rows.push(renderOption(item, ++idx));
    }
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className={`flex w-full items-center justify-between gap-2 rounded-md border bg-[var(--cf-surface)] text-left outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
          SIZE[size]
        } ${open ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)] focus:border-[var(--cf-accent)]"} ${className}`}
      >
        <span
          className={`flex min-w-0 flex-1 items-center gap-1.5 ${selected ? "" : "text-[var(--cf-text-muted)]"}`}
        >
          {selected?.leading}
          {SelectedIcon && <SelectedIcon size={13} className="shrink-0 opacity-70" />}
          <span className="truncate">{label}</span>
        </span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            style={{
              position: "fixed",
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: pos.maxHeight,
            }}
            className="z-[9999] overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
          >
            {rows}
          </div>,
          document.body,
        )}
    </>
  );
}
