import { useEffect, useState } from "react";
import { Braces } from "lucide-react";
import { appScriptsKey, getSetting, getSettings, providerCaps, setSetting, type ProviderCaps } from "../../lib/tauri/commands";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { Segmented } from "../common/Segmented";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

type Choice = "on" | "off";

/**
 * «Scripts de CodeFlow»: per provider, whether its runs get `app_run` — a script over the app's
 * commands that only hands the model what it returns (`src-tauri/src/app_script.rs`).
 *
 * What each provider *can* do comes from the backend (`provider_caps::ProviderCaps::app_scripts`),
 * so this list cannot claim a reach the server does not give: agy and Grok read a token that never
 * acts, so their scripts only look; the user's own command gets no CodeFlow tools at all.
 */
export function AppScriptsSettings() {
  const t = useT();
  const [caps, setCaps] = useState<ProviderCaps[] | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [mapOff, setMapOff] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const all = await providerCaps();
        const saved = await getSettings(all.map((c) => appScriptsKey(c.id)));
        const map = await getSetting("codemap_mcp");
        if (!live) return;
        setCaps(all);
        setMapOff(map === "false");
        setChoices(
          Object.fromEntries(
            all.map((c) => {
              const raw = saved[appScriptsKey(c.id)];
              return [c.id, raw === "on" || raw === "off" ? raw : c.appScriptsDefault ? "on" : "off"];
            }),
          ),
        );
      } catch {
        if (live) setCaps([]);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!caps || caps.length === 0) return null;

  const choose = (id: string, next: Choice) => {
    const before = choices[id];
    setChoices((all) => ({ ...all, [id]: next }));
    void setSetting(appScriptsKey(id), next).catch((error: unknown) => {
      setChoices((all) => ({ ...all, [id]: before }));
      pushErrorToast(String(error));
    });
  };

  return (
    <section aria-labelledby="app-scripts-title" className="space-y-2 rounded-xl bg-[var(--cf-surface)] p-3 shadow-[inset_0_0_0_1px_var(--cf-border)]">
      <div className="flex items-start gap-2">
        <span className="mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)] text-[var(--cf-accent)]">
          <Braces size={13} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 id="app-scripts-title" className="text-[12.5px] font-medium text-[var(--cf-text)]">
            {t("settings.appScriptsTitle")}
          </h3>
          <p className="mt-0.5 max-w-[68ch] text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("settings.appScriptsHint")}</p>
        </div>
      </div>
      {mapOff && (
        <p className="rounded-md bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-2.5 py-1.5 text-[11.5px] leading-snug text-[var(--cf-warning)]">
          {t("settings.appScriptsMapOff")}
        </p>
      )}
      <ul className={`divide-y divide-[var(--cf-border)] overflow-hidden rounded-lg bg-[var(--cf-surface-raised)] shadow-[inset_0_0_0_1px_var(--cf-border)] ${mapOff ? "opacity-60" : ""}`}>
        {caps.map((cap) => (
          <ProviderScriptsRow key={cap.id} cap={cap} choice={choices[cap.id] ?? "off"} onChoose={(next) => choose(cap.id, next)} t={t} />
        ))}
      </ul>
    </section>
  );
}

function ProviderScriptsRow({
  cap,
  choice,
  onChoose,
  t,
}: {
  cap: ProviderCaps;
  choice: Choice;
  onChoose: (next: Choice) => void;
  t: ReturnType<typeof useT>;
}) {
  const name = providerDisplayLabel(cap.id, t) || cap.label;
  const hint: TranslationKey | null =
    cap.appScripts === "none"
      ? "settings.appScriptsNoneHint"
      : cap.appScripts === "read"
        ? "settings.appScriptsReadOnlyHint"
        : cap.inProcess
          ? "settings.appScriptsLocalHint"
          : null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <ProviderGlyph providerId={cap.id} size={14} className="text-[var(--cf-text-muted)]" />
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] text-[var(--cf-text)]">{name}</span>
          {hint && <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">{t(hint)}</span>}
        </span>
      </span>
      {cap.appScripts === "none" ? (
        <span className="rounded-full px-2 py-[1px] text-[10.5px] text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)]">
          {t("settings.appScriptsNone")}
        </span>
      ) : (
        <span className="flex items-center gap-2">
          {cap.appScripts === "read" && (
            <span className="rounded-full px-2 py-[1px] text-[10.5px] text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)]">
              {t("settings.appScriptsReadOnly")}
            </span>
          )}
          <Segmented<Choice>
            size="sm"
            layoutId={`app-scripts-${cap.id}`}
            ariaLabel={`${t("settings.appScriptsTitle")} · ${name}`}
            value={choice}
            onChange={onChoose}
            options={[
              { value: "on", label: t("settings.appScriptsAuto") },
              { value: "off", label: t("settings.appScriptsOff") },
            ]}
          />
        </span>
      )}
    </li>
  );
}
