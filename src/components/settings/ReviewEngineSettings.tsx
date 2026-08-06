import { useEffect, useState } from "react";
import { Layers, RotateCcw, Ruler, ScanSearch, ShieldAlert, Users } from "lucide-react";
import {
  getReviewEngineConfig,
  resetReviewEngineConfig,
  setReviewEngineConfig,
  type ReviewEngineConfig,
  type ReviewLevelSettings,
} from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { Skeleton } from "../common/Skeleton";
import { Group } from "../api/settingsChrome";

/** The five severities, in report order. Matches `review::contract::Severity` — the backend parses
 * these labels back, accents and all, so they are values rather than display strings. */
const SEVERITIES = ["Blocker", "Crítico", "Mayor", "Menor", "Info"];

/** The level names the engine knows, in the order the depth selector shows them. */
const LEVEL_LABEL: Record<string, string> = {
  basico: "Básico",
  completo: "Completo",
  ultra: "Ultra",
};

/** A labelled number input with a bounded range — every knob on this screen is one of these. */
function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className="block truncate text-[12px] text-[var(--cf-text)]">{label}</span>
        {hint && <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{hint}</span>}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const next = Number(e.target.value);
          // Clamped here rather than trusted: the backend drops an out-of-range override silently
          // (a broken config must never block a review), so a value that would be ignored should
          // never make it onto the screen looking as if it took.
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
        className="w-20 shrink-0 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-right text-[12px] outline-none focus:border-[var(--cf-accent)]"
      />
    </label>
  );
}

function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
      <span className="min-w-0">
        <span className="block truncate text-[12px] text-[var(--cf-text)]">{label}</span>
        {hint && <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{hint}</span>}
      </span>
      <Checkbox checked={checked} onChange={onChange} />
    </label>
  );
}

/** A row of on/off chips — how severities and lenses are picked. */
function ChipPicker({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; label: string; title?: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 py-1">
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            onClick={() => onToggle(option.value)}
            className={`max-w-full truncate rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              on
                ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** One glob per line — the shape everybody already writes scope rules in. */
function GlobList({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="py-1">
      <p className="text-[12px] text-[var(--cf-text)]">{label}</p>
      <p className="mb-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>
      <textarea
        value={value.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n").map((l) => l.trim()).filter(Boolean))}
        rows={6}
        spellCheck={false}
        className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
      />
    </div>
  );
}

/**
 * The workspace's PR review **policy** — the numbers the engine enforces, as opposed to the prompts
 * it hands the model.
 *
 * The distinction is the reason this is its own tab rather than another textarea next to the review
 * standard. What is here is checked in code: the threshold decides which findings survive, the
 * severities decide what is even looked for, the gate decides pass or fail, and all of it is frozen
 * into every saved review so an old one can still say which rules produced it. Written into a prompt
 * instead, none of that would be true — the model would be *asked* to apply a threshold, and nothing
 * would notice when it didn't.
 *
 * Saves on blur, like the rest of Settings.
 */
export function ReviewEngineSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [config, setConfig] = useState<ReviewEngineConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      setConfig(null);
      return;
    }
    void (async () => {
      try {
        const loaded = await getReviewEngineConfig(workspaceId);
        if (!cancelled) setConfig(loaded);
      } catch (e) {
        if (!cancelled) pushErrorToast(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const persist = async (next: ReviewEngineConfig) => {
    if (!workspaceId) return;
    setConfig(next);
    setSaving(true);
    try {
      await setReviewEngineConfig(workspaceId, next);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const patchLevel = (level: string, patch: Partial<ReviewLevelSettings>) => {
    if (!config) return;
    void persist({
      ...config,
      levels: config.levels.map((l) => (l.level === level ? { ...l, ...patch } : l)),
    });
  };

  const restore = async () => {
    if (!workspaceId) return;
    const ok = await confirmAction(t("settings.engineResetConfirm"), true, t("settings.templateReset"));
    if (!ok) return;
    try {
      await resetReviewEngineConfig(workspaceId);
      setConfig(await getReviewEngineConfig(workspaceId));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  if (!workspaceId) {
    return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.reviewSelectWorkspace")}</p>;
  }
  if (!config) {
    return (
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const lensOptions = config.lensCatalog.map(([n, label]) => ({
    value: String(n),
    // The number is the identity; the label is long enough that a chip row of six would wrap into
    // a wall, so it rides in the tooltip instead.
    label: `${n}. ${label.split(":")[0]}`,
    title: label,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("settings.engineHint")}</p>
        <button
          onClick={() => void restore()}
          className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
        >
          <RotateCcw size={11} />
          {t("settings.templateReset")}
        </button>
      </div>

      <div className="rounded-lg border border-[var(--cf-border)] px-3 py-2">
        {config.levels.map((level) => (
          // Shut like every other group here. "Completo" used to open on arrival because it is the
          // level most runs use, but a panel where one section is unrolled and the other six are
          // not reads as "this one needs your attention" — and it pushed the rest off the fold, so
          // the first thing the panel showed was the middle of one level's knobs rather than the
          // list of what can be tuned.
          <Group key={level.level} title={`${t("settings.engineLevel")} · ${LEVEL_LABEL[level.level] ?? level.level}`} collapsible defaultOpen={false}>
            <NumberField
              label={t("settings.engineMinConfidence")}
              hint={t("settings.engineMinConfidenceHint")}
              value={level.minConfidence}
              min={0}
              max={100}
              onChange={(minConfidence) => patchLevel(level.level, { minConfidence })}
            />
            <NumberField
              label={t("settings.engineMinConfidenceBlocker")}
              hint={t("settings.engineMinConfidenceBlockerHint")}
              value={level.minConfidenceBlocker}
              min={0}
              max={100}
              onChange={(minConfidenceBlocker) => patchLevel(level.level, { minConfidenceBlocker })}
            />
            <p className="mt-1.5 text-[12px] text-[var(--cf-text)]">{t("settings.engineSeverities")}</p>
            <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("settings.engineSeveritiesHint")}
            </p>
            <ChipPicker
              options={SEVERITIES.map((s) => ({ value: s, label: s }))}
              selected={level.severities}
              onToggle={(value) => {
                const next = level.severities.includes(value)
                  ? level.severities.filter((s) => s !== value)
                  : [...level.severities, value];
                // An empty list would be "report nothing", which is not a depth level — the
                // backend drops it and falls back to the default, so refusing the last removal
                // here is what keeps the screen honest about what it will do.
                if (next.length > 0) patchLevel(level.level, { severities: next });
              }}
            />
            <p className="mt-1.5 text-[12px] text-[var(--cf-text)]">{t("settings.engineLenses")}</p>
            <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("settings.engineLensesHint")}</p>
            <ChipPicker
              options={lensOptions}
              selected={level.lenses.map(String)}
              onToggle={(value) => {
                const n = Number(value);
                const next = level.lenses.includes(n)
                  ? level.lenses.filter((l) => l !== n)
                  : [...level.lenses, n].sort((a, b) => a - b);
                if (next.length > 0) patchLevel(level.level, { lenses: next });
              }}
            />
            <ToggleField
              label={t("settings.engineSubagents")}
              hint={t("settings.engineSubagentsHint")}
              checked={level.subagents}
              onChange={(subagents) => patchLevel(level.level, { subagents })}
            />
            <ToggleField
              label={t("settings.engineCrossFile")}
              hint={t("settings.engineCrossFileHint")}
              checked={level.crossFile}
              onChange={(crossFile) => patchLevel(level.level, { crossFile })}
            />
            <NumberField
              label={t("settings.engineFilesPerGroup")}
              hint={t("settings.engineFilesPerGroupHint")}
              value={level.filesPerGroup}
              min={1}
              max={100}
              onChange={(filesPerGroup) => patchLevel(level.level, { filesPerGroup })}
            />
            <NumberField
              label={t("settings.engineMaxGroups")}
              hint={t("settings.engineMaxGroupsHint")}
              value={level.maxGroups}
              min={1}
              max={32}
              onChange={(maxGroups) => patchLevel(level.level, { maxGroups })}
            />
          </Group>
        ))}
      </div>

      <div className="rounded-lg border border-[var(--cf-border)] px-3 py-2">
        <Group title={t("settings.engineGate")} collapsible defaultOpen={false}>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <ShieldAlert size={12} className="shrink-0" />
            {t("settings.engineGateHint")}
          </p>
          <ChipPicker
            options={SEVERITIES.map((s) => ({ value: s, label: s }))}
            selected={config.qualityGate.blockingSeverities}
            onToggle={(value) => {
              const current = config.qualityGate.blockingSeverities;
              const next = current.includes(value)
                ? current.filter((s) => s !== value)
                : [...current, value];
              if (next.length > 0) void persist({ ...config, qualityGate: { blockingSeverities: next } });
            }}
          />
        </Group>

        <Group title={t("settings.engineScope")} collapsible defaultOpen={false}>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <ScanSearch size={12} className="shrink-0" />
            {t("settings.engineScopeHint")}
          </p>
          <GlobList
            label={t("settings.engineInclude")}
            hint={t("settings.engineIncludeHint")}
            value={config.scope.include}
            onChange={(include) => void persist({ ...config, scope: { ...config.scope, include } })}
          />
          <GlobList
            label={t("settings.engineExclude")}
            hint={t("settings.engineExcludeHint")}
            value={config.scope.exclude}
            onChange={(exclude) => void persist({ ...config, scope: { ...config.scope, exclude } })}
          />
        </Group>

        <Group title={t("settings.engineContext")} collapsible defaultOpen={false}>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <Ruler size={12} className="shrink-0" />
            {t("settings.engineContextHint")}
          </p>
          <NumberField
            label={t("settings.engineContextLines")}
            hint={t("settings.engineContextLinesHint")}
            value={config.bundles.contextLines}
            min={0}
            max={50}
            onChange={(contextLines) => void persist({ ...config, bundles: { ...config.bundles, contextLines } })}
          />
          <NumberField
            label={t("settings.engineMaxLines")}
            hint={t("settings.engineMaxLinesHint")}
            value={config.bundles.maxLinesPerFile}
            min={50}
            max={20000}
            onChange={(maxLinesPerFile) =>
              void persist({ ...config, bundles: { ...config.bundles, maxLinesPerFile } })
            }
          />
          <NumberField
            label={t("settings.engineMaxKb")}
            hint={t("settings.engineMaxKbHint")}
            value={config.bundles.maxKbPerGroup}
            min={8}
            max={1024}
            onChange={(maxKbPerGroup) => void persist({ ...config, bundles: { ...config.bundles, maxKbPerGroup } })}
          />
        </Group>

        <Group title={t("settings.engineWorkers")} collapsible defaultOpen={false}>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <Users size={12} className="shrink-0" />
            {t("settings.engineWorkersHint")}
          </p>
          <NumberField
            label={t("settings.engineMaxParallel")}
            hint={t("settings.engineMaxParallelHint")}
            value={config.workers.maxParallel}
            min={1}
            max={12}
            onChange={(maxParallel) => void persist({ ...config, workers: { maxParallel } })}
          />
        </Group>

        <Group title={t("settings.engineGraph")} collapsible defaultOpen={false}>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <Layers size={12} className="shrink-0" />
            {t("settings.engineGraphHint")}
          </p>
          <ToggleField
            label={t("settings.engineGraphEnabled")}
            hint={t("settings.engineGraphEnabledHint")}
            checked={config.graph.enabled}
            onChange={(enabled) => void persist({ ...config, graph: { ...config.graph, enabled } })}
          />
          <NumberField
            label={t("settings.engineGraphSymbols")}
            value={config.graph.maxSymbols}
            min={1}
            max={200}
            onChange={(maxSymbols) => void persist({ ...config, graph: { ...config.graph, maxSymbols } })}
          />
          <NumberField
            label={t("settings.engineGraphCallers")}
            value={config.graph.maxCallers}
            min={1}
            max={50}
            onChange={(maxCallers) => void persist({ ...config, graph: { ...config.graph, maxCallers } })}
          />
        </Group>
      </div>

      <p className="text-[10.5px] text-[var(--cf-text-muted)]">
        {saving ? t("settings.engineSaving") : t("settings.templateAutosave")}
      </p>
    </div>
  );
}
