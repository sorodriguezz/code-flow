import { useT } from "../../state/languageStore";
import type { ReviewLevel } from "../../state/prStore";

/** Compact segmented control for the review depth (básico / completo / ultra). The choice is
 * shared through `prStore`, so wherever a review is launched from — the AI panel, the title-bar
 * shortcut, the "review a PR from its link" modal — it runs at the same level. */
export function ReviewLevelSelector({
  value,
  onChange,
  disabled,
}: {
  value: ReviewLevel;
  onChange: (level: ReviewLevel) => void;
  disabled: boolean;
}) {
  const t = useT();
  const levels: ReviewLevel[] = ["basico", "completo", "ultra"];
  return (
    <div className="flex items-center rounded-md border border-[var(--cf-border)] p-0.5" title={t("pr.levelHint")}>
      {levels.map((level) => (
        <button
          key={level}
          onClick={() => onChange(level)}
          disabled={disabled}
          className={`rounded px-2 py-1 text-[11px] font-medium capitalize transition-colors disabled:opacity-50 ${
            value === level
              ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
              : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          }`}
        >
          {t(`pr.level.${level}` as never)}
        </button>
      ))}
    </div>
  );
}
