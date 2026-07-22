import { useLanguageStore, useT } from "../../state/languageStore";
import type { Language } from "../../lib/i18n/translations";

// Language names stay in their own language (endonyms) — "English"/"Español" don't change
// depending on the currently selected UI language, same as any language picker.
const OPTIONS: { id: Language; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];

export function GeneralSettings() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.general")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.languageHint")}</p>
      <div className="flex gap-2">
        {OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setLanguage(opt.id)}
            className={`flex-1 rounded-lg border px-3 py-2.5 text-[13px] font-medium ${
              language === opt.id
                ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.translationNote")}</p>
    </section>
  );
}
