/**
 * Settings › Revisor › Dependencias: how old a release must be before it is suggested, how long a
 * registry answer is reused, the daily advisory check and the licence policy.
 *
 * No private registries yet — their tokens would have to come from the Llavero and their scopes
 * from `.npmrc`/`nuget.config`; until then the pane says the public registries are the ones asked.
 */

import { useEffect, useState } from "react";
import { useDepsStore, checkAdvisoriesNow } from "../../state/depsStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { DepsConfig } from "../../lib/tauri/depsCommands";
import { Checkbox } from "../common/Checkbox";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { PaneBlock } from "../settings/settingsNav";

function listText(list: string[]): string {
  return list.join(", ");
}

function parseList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function NumberField({ value, min, max, onCommit, label }: { value: number; min: number; max: number; onCommit: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= min && n <= max) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className={fieldClass({ size: "sm", className: "w-20 tabular-nums" })}
    />
  );
}

function ListField({ value, onCommit, label }: { value: string[]; onCommit: (list: string[]) => void; label: string }) {
  const [draft, setDraft] = useState(listText(value));
  useEffect(() => setDraft(listText(value)), [value]);
  return (
    <input
      type="text"
      value={draft}
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(parseList(draft))}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(parseList(draft));
      }}
      className={fieldClass({ size: "sm", className: "w-full font-mono" })}
    />
  );
}

export function DepsSettingsPane() {
  const t = useT();
  const config = useDepsStore((s) => s.config);
  const loadConfig = useDepsStore((s) => s.loadConfig);
  const saveConfig = useDepsStore((s) => s.saveConfig);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void loadConfig().catch((e: unknown) => pushErrorToast(String(e)));
  }, [loadConfig]);

  if (!config) return null;
  const save = (patch: Partial<DepsConfig>) => void saveConfig({ ...config, ...patch }).catch((e: unknown) => pushErrorToast(String(e)));

  const checkNow = async () => {
    setChecking(true);
    try {
      await checkAdvisoriesNow(true);
      pushSuccessToast(t("deps.checkedNow"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <PaneBlock title={t("deps.settingsVersions")} hint={t("deps.settingsVersionsHint")}>
        <div className="mb-2 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
          <span className="w-56">{t("deps.minAge")}</span>
          <NumberField value={config.minReleaseAgeDays} min={0} max={365} label={t("deps.minAge")} onCommit={(n) => save({ minReleaseAgeDays: n })} />
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("deps.days")}</span>
        </div>
        <div className="mb-1 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
          <span className="w-56">{t("deps.cacheTtl")}</span>
          <NumberField value={config.cacheTtlHours} min={1} max={168} label={t("deps.cacheTtl")} onCommit={(n) => save({ cacheTtlHours: n })} />
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("deps.hours")}</span>
        </div>
        <p className="mt-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("deps.registriesNote")}</p>
      </PaneBlock>

      <PaneBlock title={t("deps.settingsAlerts")} hint={t("deps.settingsAlertsHint")}>
        <label className="mb-2 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
          <Checkbox checked={config.alerts} onChange={(checked) => save({ alerts: checked })} />
          {t("deps.alertsToggle")}
        </label>
        <button type="button" disabled={checking || !config.alerts} onClick={() => void checkNow()} className={buttonClass({ variant: "secondary", size: "sm" })}>
          {t("deps.checkNow")}
        </button>
      </PaneBlock>

      <PaneBlock title={t("deps.settingsLicenses")} hint={t("deps.settingsLicensesHint")}>
        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-[12px] text-[var(--cf-text-muted)]">{t("deps.licenseFlagged")}</span>
            <ListField value={config.licenseFlagged} label={t("deps.licenseFlagged")} onCommit={(list) => save({ licenseFlagged: list })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-[var(--cf-text-muted)]">{t("deps.licenseWarn")}</span>
            <ListField value={config.licenseWarn} label={t("deps.licenseWarn")} onCommit={(list) => save({ licenseWarn: list })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-[var(--cf-text-muted)]">{t("deps.licenseAllowed")}</span>
            <ListField value={config.licenseAllowed} label={t("deps.licenseAllowed")} onCommit={(list) => save({ licenseAllowed: list })} />
          </label>
          <label className="flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
            <Checkbox checked={config.flagUnknownLicense} onChange={(checked) => save({ flagUnknownLicense: checked })} />
            {t("deps.flagUnknown")}
          </label>
        </div>
      </PaneBlock>
    </>
  );
}
