import { Check, Laptop, Moon, Sun } from "lucide-react";
import { useThemeStore } from "../../state/themeStore";
import { ACCENT_OPTIONS, useAccentStore } from "../../state/accentStore";
import type { ThemePreference } from "../../types/domain";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

const OPTIONS: { id: ThemePreference; labelKey: TranslationKey; icon: typeof Sun }[] = [
  { id: "light", labelKey: "settings.themeLight", icon: Sun },
  { id: "dark", labelKey: "settings.themeDark", icon: Moon },
  { id: "system", labelKey: "settings.themeSystem", icon: Laptop },
];

export function ThemeSettings() {
  const t = useT();
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const resolved = useThemeStore((s) => s.resolved);
  const accentId = useAccentStore((s) => s.accentId);
  const setAccent = useAccentStore((s) => s.setAccent);

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.appearance")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.chooseTheme")}</p>
      <div className="flex gap-2">
        {OPTIONS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setPreference(id)}
            className={`flex flex-1 flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-[13px] ${
              preference === id
                ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            }`}
          >
            <Icon size={18} />
            {t(labelKey)}
          </button>
        ))}
      </div>

      <h3 className="mb-1 mt-6 text-sm font-semibold">{t("settings.accentColor")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.accentColorHint")}</p>
      <div className="flex flex-wrap gap-2">
        {ACCENT_OPTIONS.map((opt) => {
          const selected = accentId === opt.id;
          const swatch = resolved === "dark" ? opt.dark : opt.light;
          return (
            <button
              key={opt.id}
              title={opt.label}
              onClick={() => setAccent(opt.id, resolved)}
              className="flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--cf-surface)]"
              style={{ background: swatch, boxShadow: selected ? `0 0 0 2px ${swatch}` : undefined }}
            >
              {selected && <Check size={14} className="text-white" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
