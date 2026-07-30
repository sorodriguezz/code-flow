import { useT } from "../../state/languageStore";

/**
 * "This one has not been through as many hands as the rest yet."
 *
 * One component rather than the tag written inline wherever it is needed: a beta marker that is a
 * warning tint in one place and a grey pill in another stops reading as a status and starts reading
 * as decoration. Sized and coloured to be read once and then ignored — it must not compete with the
 * label it sits beside.
 */
export function BetaBadge({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <span
      className={`shrink-0 rounded bg-[color-mix(in_oklab,var(--cf-warning)_18%,transparent)] px-1 py-[1px] text-[9px] font-bold uppercase tracking-wide text-[var(--cf-warning)] ${className}`}
    >
      {t("common.beta")}
    </span>
  );
}
