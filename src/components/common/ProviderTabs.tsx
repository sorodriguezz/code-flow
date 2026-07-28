import type { LucideIcon } from "lucide-react";
import { ActivePill } from "./ActivePill";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

export interface ProviderTabOption {
  id: string;
  label?: string;
  labelKey?: TranslationKey;
  icon: LucideIcon;
  available: boolean;
}

/** Row of provider "cards" — one real/selected option plus disabled ones badged "coming
 * soon". Shared between the AI provider picker and the Git hosting picker so both read as
 * one consistent piece of UI rather than two one-off pickers. */
export function ProviderTabs({
  options,
  activeId,
  onSelect,
  layoutId,
}: {
  options: ProviderTabOption[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Distinct per rendered row — two provider rows on screen at once would otherwise share one
   * sliding pill and throw it between them. */
  layoutId: string;
}) {
  const t = useT();

  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.id === activeId;
        return (
          <button
            key={opt.id}
            disabled={!opt.available}
            onClick={() => opt.available && onSelect(opt.id)}
            className={`relative flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium ${
              active
                ? "border-transparent text-[var(--cf-accent)]"
                : opt.available
                  ? "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  : "cursor-not-allowed border-[var(--cf-border)] text-[var(--cf-text-muted)] opacity-45 grayscale"
            }`}
          >
            {/* `-inset-px` so the pill's hairline covers the button's own border rather than
                leaving a grey ring around it. */}
            {active && <ActivePill layoutId={layoutId} inset="-inset-px" radius="rounded-lg" />}
            <span className="relative flex items-center gap-1.5">
              <Icon size={13} />
              {opt.labelKey ? t(opt.labelKey) : opt.label}
              {!opt.available && (
                <span className="ml-0.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide dark:bg-white/10">
                  {t("settings.comingSoon")}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
