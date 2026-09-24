import { Check } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { THINKING_DESIGNS } from "../../lib/thinkingDesigns";
import { useThinkingDesignStore } from "../../state/thinkingDesignStore";
import { useT } from "../../state/languageStore";
import { onRadioKeys } from "./settingsNav";

/**
 * The look of the "a model is thinking" mark, as a grid of the designs themselves, running.
 *
 * Each tile shows its design twice: large, where its idea can be seen, and at 14px beside its name —
 * the size it is actually met at, in the assistant's run list, a task row, a tab. A design that only
 * works large is one to know about before picking it. Tiles and selection ring are the Appearance
 * section's mode tiles, so "picked" reads the same way in both.
 *
 * Eight tiles, four across once there is room and two before — a column count they fill. Choosing is
 * instant and global: every orb in every window subscribes to the one setting (`thinkingDesignStore`).
 */
export function ThinkingDesignSettings() {
  const t = useT();
  const design = useThinkingDesignStore((s) => s.design);
  const setDesign = useThinkingDesignStore((s) => s.setDesign);

  return (
    <div className="@container">
      <div
        role="radiogroup"
        aria-label={t("settings.thinkingTitle")}
        onKeyDown={onRadioKeys}
        className="grid grid-cols-2 gap-2.5 p-0.5 @[520px]:grid-cols-4"
      >
        {THINKING_DESIGNS.map(({ id, labelKey }) => {
          const selected = id === design;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                if (!selected) void setDesign(id);
              }}
              // The ring is the selection; a box-shadow, so picking a tile moves nothing.
              className={`flex flex-col gap-2 rounded-lg p-2 text-left transition-[box-shadow,background-color] duration-100 ${
                selected
                  ? "shadow-[0_0_0_2px_var(--cf-accent)]"
                  : "shadow-[0_0_0_1px_var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
              }`}
            >
              <span aria-hidden className="flex h-[76px] items-center justify-center rounded-md bg-[var(--cf-sunken)]">
                <ThinkingOrb size="lg" design={id} />
              </span>
              <span
                className={`flex items-center gap-2 px-0.5 text-[13px] font-medium ${
                  selected ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
                }`}
              >
                <ThinkingOrb size="sm" design={id} />
                <span className="min-w-0 flex-1 break-words">{t(labelKey)}</span>
                {selected && <Check size={13} className="shrink-0 text-[var(--cf-accent)]" />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
