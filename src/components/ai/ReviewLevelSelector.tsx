import { useId } from "react";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import type { ReviewLevel } from "../../state/prStore";

const LEVELS: ReviewLevel[] = ["basico", "completo", "ultra"];

/** The review depth (básico / completo / ultra) as the app's segmented control — three peer
 * choices about the same run. The choice is shared through `prStore`, so wherever a review is
 * launched from — the AI panel, the title-bar shortcut, the "review a PR from its link" modal — it
 * runs at the same level. */
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
  // Several of these can be mounted at once — one per open review, plus the link modal — and each
  // needs a thumb of its own to slide.
  const id = useId();
  return (
    <Tooltip label={t("pr.levelHint")}>
      <Segmented
        size="sm"
        layoutId={`review-level-${id}`}
        value={value}
        onChange={onChange}
        options={LEVELS.map((level) => ({ value: level, label: t(`pr.level.${level}` as never), disabled }))}
      />
    </Tooltip>
  );
}
