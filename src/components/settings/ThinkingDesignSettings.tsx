import { useState } from "react";
import { Check } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Segmented } from "../common/Segmented";
import { THINKING_DESIGNS, type ThinkingDesign } from "../../lib/thinkingDesigns";
import type { ThinkingActivity } from "../../lib/thinking/activity";
import type { TranslationKey } from "../../lib/i18n/translations";
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
 * Sixteen tiles, four across once there is room and two before — column counts they fill. Choosing is
 * instant and global: every orb in every window subscribes to the one setting (`thinkingDesignStore`),
 * the run card's included. The large preview runs in the "thinking" phase, where every design that
 * reacts to a phase shows its liveliest light; pointing at a tile (or focusing it) plays its finish
 * — what a turn's gutter shows the moment the answer lands, otherwise seen only in passing.
 *
 * Above the grid, the state every tile previews (user: "no tiene animación como de trabajando,
 * pensando, error…" — the reactions existed but only "thinking" could be seen here). Seven peers in
 * one segmented row: they are all the same question, "what does it look like when…". On an ending
 * (Terminado, Error) pointing at a tile replays it. «Hablando» (2026-10-09) is the reading aloud:
 * every mark breathes with the voice (`.cf-orb--speaking`), here with a speech-like stand-in.
 */
type PreviewState = "think" | "read" | "work" | "write" | "speak" | "quiet" | "done" | "failed";

/** Module-level, so the tiles hand every orb the same object across renders. */
const PREVIEWS: Record<PreviewState, ThinkingActivity> = {
  think: { phase: "think" },
  read: { phase: "read" },
  work: { phase: "edit" },
  write: { phase: "write" },
  speak: { phase: "speak" },
  quiet: { phase: "think", quiet: true },
  done: { done: true },
  failed: { failed: true },
};

const PREVIEW_LABELS: Record<PreviewState, TranslationKey> = {
  think: "settings.thinkingState.think",
  read: "settings.thinkingState.read",
  work: "settings.thinkingState.work",
  write: "settings.thinkingState.write",
  speak: "settings.thinkingState.speak",
  quiet: "settings.thinkingState.quiet",
  done: "settings.thinkingState.done",
  failed: "settings.thinkingState.failed",
};

export function ThinkingDesignSettings() {
  const t = useT();
  const design = useThinkingDesignStore((s) => s.design);
  const setDesign = useThinkingDesignStore((s) => s.setDesign);
  const [finishing, setFinishing] = useState<ThinkingDesign | null>(null);
  const [preview, setPreview] = useState<PreviewState>("think");
  /** Per tile, how many times an ending has been replayed: the orb is keyed by it, and a fresh mount
   *  is what plays an ending again when the state itself has not changed. */
  const [replays, setReplays] = useState<Partial<Record<ThinkingDesign, number>>>({});
  const ending = preview === "done" || preview === "failed";
  const point = (id: ThinkingDesign) => {
    setFinishing(id);
    if (ending) setReplays((was) => ({ ...was, [id]: (was[id] ?? 0) + 1 }));
  };

  return (
    <div className="@container">
      <div className="mb-2.5 overflow-x-auto p-0.5">
        <Segmented
          size="sm"
          layoutId="thinking-preview"
          ariaLabel={t("settings.thinkingPreview")}
          value={preview}
          onChange={setPreview}
          options={(Object.keys(PREVIEWS) as PreviewState[]).map((value) => ({ value, label: t(PREVIEW_LABELS[value]) }))}
        />
      </div>
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
              onPointerEnter={() => point(id)}
              onPointerLeave={() => setFinishing((was) => (was === id ? null : was))}
              onFocus={() => point(id)}
              onBlur={() => setFinishing((was) => (was === id ? null : was))}
              title={t("settings.thinkingFinishHint")}
              // The ring is the selection; a box-shadow, so picking a tile moves nothing.
              className={`flex flex-col gap-2 rounded-lg p-2 text-left transition-[box-shadow,background-color] duration-100 ${
                selected
                  ? "shadow-[0_0_0_2px_var(--cf-accent)]"
                  : "shadow-[0_0_0_1px_var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
              }`}
            >
              <span aria-hidden className="flex h-[76px] items-center justify-center rounded-md bg-[var(--cf-sunken)]">
                <ThinkingOrb
                  key={replays[id] ?? 0}
                  size="lg"
                  design={id}
                  activity={!ending && finishing === id ? PREVIEWS.done : PREVIEWS[preview]}
                />
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
