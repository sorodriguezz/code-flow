import { ACCENT_OPTIONS } from "../../state/accentStore";

// Reuses the same curated, contrast-checked palette as the accent color setting —
// one set of "safe" colors for the whole app instead of a freeform picker.
const ICON_COLORS = ACCENT_OPTIONS.map((opt) => opt.light);

export function ColorSwatchPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="flex gap-0.5">
      {ICON_COLORS.map((color) => (
        <button
          key={color}
          title={color}
          onClick={() => onChange(color)}
          className="h-3 w-3 rounded-full"
          style={{
            background: color,
            boxShadow: value === color ? `0 0 0 1.5px var(--cf-surface), 0 0 0 3px ${color}` : undefined,
          }}
        />
      ))}
    </div>
  );
}
