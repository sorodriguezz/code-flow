import { FlaskConical } from "lucide-react";
import type { DeterministicConfig, ReviewEngineConfig, ReviewRuleInfo } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { Group } from "../api/settingsChrome";

/** The level names the engine knows, as the depth selector shows them. */
const LEVEL_LABEL: Record<string, string> = { basico: "Básico", completo: "Completo", ultra: "Ultra" };

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`flex items-center justify-between gap-3 py-1 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <span className="min-w-0">
        <span className="block break-words text-[12px] leading-snug text-[var(--cf-text)]">{label}</span>
        {hint && <span className="block break-words text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</span>}
      </span>
      <Checkbox checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

/** Whether a rule runs, as the backend decides it: the master switch, then its own override, then its default. */
export function ruleEnabled(cfg: DeterministicConfig, rule: ReviewRuleInfo): boolean {
  return cfg.rules && (cfg.ruleOverrides[rule.id] ?? rule.enabledByDefault);
}

/**
 * The review's deterministic pass — the pre-scan of the added lines and the rules that hand the
 * reviewers verified facts. Its own component because it is its own concern: everything here runs
 * before any model, and none of it can fail a review.
 */
export function DeterministicSettings({
  config,
  persist,
}: {
  config: ReviewEngineConfig;
  persist: (next: ReviewEngineConfig) => void;
}) {
  const t = useT();
  const cfg = config.deterministic;
  if (!cfg) return null;
  const save = (patch: Partial<DeterministicConfig>) => persist({ ...config, deterministic: { ...cfg, ...patch } });

  return (
    <Group title={t("settings.engineDeterministic")} collapsible defaultOpen={false}>
      <p className="mb-1 flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        <FlaskConical size={12} className="mt-px shrink-0" />
        {t("settings.engineDeterministicHint")}
      </p>
      <Toggle
        label={t("settings.enginePrescan")}
        hint={t("settings.enginePrescanHint")}
        checked={cfg.prescan}
        onChange={(prescan) => save({ prescan })}
      />
      <Toggle
        label={t("settings.engineRules")}
        hint={t("settings.engineRulesHint")}
        checked={cfg.rules}
        onChange={(rules) => save({ rules })}
      />
      <div className="ml-3 border-l border-[var(--cf-border)] pl-3">
        {(config.ruleCatalog ?? []).map((rule) => (
          <Toggle
            key={rule.id}
            label={`${rule.id} · ${rule.title}`}
            hint={t("settings.engineRuleHint", {
              levels: rule.levels.map((l) => LEVEL_LABEL[l] ?? l).join(", "),
              paths: rule.paths.join(", "),
            })}
            checked={ruleEnabled(cfg, rule)}
            disabled={!cfg.rules}
            onChange={(on) => save({ ruleOverrides: { ...cfg.ruleOverrides, [rule.id]: on } })}
          />
        ))}
      </div>
    </Group>
  );
}
