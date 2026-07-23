import { LogOut, Trash2 } from "lucide-react";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { Language } from "../../lib/i18n/translations";
import { quitApp, resetAppData } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { usePlatform } from "../../lib/platform";

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
  const platform = usePlatform();
  const dataPath = platform === "windows" ? "C:\\CodeFlow" : "~/CodeFlow";

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

      <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.appLifecycle")}</h3>
        <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.appLifecycleHint")}</p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={async () => {
              if (await confirmAction(t("settings.quitConfirm"))) void quitApp();
            }}
            className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-3 py-2 text-[13px] font-medium text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)]"
          >
            <LogOut size={14} />
            {t("settings.quitApp")}
          </button>
        </div>
      </div>

      <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.resetData")}</h3>
        <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">
          {t("settings.resetDataHint", { path: dataPath })}
        </p>
        <button
          onClick={async () => {
            if (await confirmAction(t("settings.resetDataConfirm", { path: dataPath }))) void resetAppData();
          }}
          className="flex items-center gap-2 rounded-md border border-[var(--cf-danger)]/40 px-3 py-2 text-[13px] font-medium text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)]"
        >
          <Trash2 size={14} />
          {t("settings.resetDataButton")}
        </button>
      </div>
    </section>
  );
}
