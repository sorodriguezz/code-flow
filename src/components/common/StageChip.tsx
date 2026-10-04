import { useT } from "../../state/languageStore";

/**
 * "ALFA" / "BETA" — the word an app that is still settling wears beside its name: in the rail's
 * tooltip, in the title row's crumb, in a detached window's title. One definition, so the three
 * agree on the word, the colour and the size. The explanation, when there is one, is the tooltip.
 */
export function StageChip({
  stage,
  title,
  size = "md",
}: {
  stage: "alpha" | "beta";
  title?: string;
  /** `sm` for a tab, where the label beside it is 13px and a 10.5px chip would shout over it. */
  size?: "sm" | "md";
}) {
  const t = useT();
  return (
    <span
      title={title}
      className={`shrink-0 rounded-[4px] bg-[color-mix(in_oklab,var(--cf-warning)_18%,transparent)] font-bold uppercase leading-none tracking-[0.06em] text-[var(--cf-warning)] ${
        size === "sm" ? "px-[3px] py-[2px] text-[9px]" : "px-1 py-px text-[10.5px]"
      }`}
    >
      {t(stage === "alpha" ? "common.alpha" : "common.beta")}
    </span>
  );
}
