import { useEffect, useRef, useState } from "react";
import { ACCENT_OPTIONS } from "../../state/accentStore";

// Reuses the same curated, contrast-checked palette as the accent color setting —
// one set of "safe" colors for the whole app instead of a freeform picker.
const ICON_COLORS = ACCENT_OPTIONS.map((opt) => opt.light);

// Collapsed to just the currently selected color so it can sit compactly next to actions
// like the delete button, instead of always showing every option inline — click it to
// pop open the rest of the palette.
export function ColorSwatchPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={value}
        className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/20"
        style={{ background: value }}
      />
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-20 mt-1 flex w-[92px] flex-wrap gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2 shadow-[var(--cf-shadow)]"
        >
          {ICON_COLORS.map((color) => (
            <button
              key={color}
              title={color}
              onClick={() => {
                onChange(color);
                setOpen(false);
              }}
              className="h-3.5 w-3.5 rounded-full"
              style={{
                background: color,
                boxShadow: value === color ? `0 0 0 1.5px var(--cf-surface-raised), 0 0 0 3px ${color}` : undefined,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
