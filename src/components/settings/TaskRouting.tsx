import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { getSetting, listAiModels, setSetting } from "../../lib/tauri/commands";
import { AI_PROVIDERS, isAgenticProvider } from "../../lib/aiProviders";
import { AI_TASKS } from "../../lib/aiTasks";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useProviderStatusStore } from "../../state/providerStatusStore";
import { useT } from "../../state/languageStore";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { CUSTOM_MODEL, ModelField, customModelPlaceholder, modelOptionsFor, parseModel } from "./modelPicker";

/**
 * Per-task provider + model routing: point commit messages at a local model, PR review at Opus,
 * "fix with AI" at opencode, and so on. Every row defaults to "inherit", so the whole table can be
 * ignored by anyone happy with one provider for everything.
 *
 * Storage mirrors the backend's fallback chain exactly (`provider_for` / `load_ai_config`):
 * `ai_provider_{task}` for the provider (blank = inherit the global default) and
 * `{provider}_{task}_model` for the model (blank = that provider's base model).
 */
export function TaskRouting() {
  const t = useT();
  const defaultProvider = useAiProviderStore((s) => s.providerId);
  const taskProviders = useAiProviderStore((s) => s.taskProviders);
  const setTaskProvider = useAiProviderStore((s) => s.setTaskProvider);
  const refresh = useAiProviderStore((s) => s.refresh);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkProviders = useProviderStatusStore((s) => s.checkAll);

  // The providers card is collapsed by default, so it may never have mounted — without this,
  // opening only this card would show every provider as fine and grey out nothing.
  useEffect(() => {
    if (Object.keys(useProviderStatusStore.getState().byProvider).length === 0) void checkProviders();
  }, [checkProviders]);

  // Model lists are per provider and never change within a session — cached in a ref so fetching
  // them can't retrigger the effect that fetches them.
  const modelCache = useRef<Record<string, string[]>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const effectiveProvider = (task: string) => taskProviders[task]?.trim() || defaultProvider;

  const providerLabel = (id: string) => {
    const p = AI_PROVIDERS.find((x) => x.id === id);
    if (!p) return id;
    return p.label ?? (p.labelKey ? t(p.labelKey) : id);
  };

  // Re-read whenever routing changes: a task pointed at another provider shows that provider's
  // models and its own stored override.
  const routingSignature = `${defaultProvider}::${AI_TASKS.map((task) => taskProviders[task.key] ?? "").join("|")}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const providers = Array.from(new Set(AI_TASKS.map((task) => effectiveProvider(task.key))));
      await Promise.all(
        providers.map(async (p) => {
          if (modelCache.current[p]) return;
          modelCache.current[p] = await listAiModels(p).catch(() => []);
        }),
      );
      if (cancelled) return;

      const nextChoice: Record<string, string> = {};
      const nextCustom: Record<string, string> = {};
      await Promise.all(
        AI_TASKS.map(async ({ key }) => {
          const provider = effectiveProvider(key);
          const stored = await getSetting(`${provider}_${key}_model`).catch(() => null);
          const ids = modelOptionsFor(provider, modelCache.current[provider] ?? []).map((o) => o.id);
          const parsed = parseModel(stored, ids);
          nextChoice[key] = parsed.choice;
          nextCustom[key] = parsed.custom;
        }),
      );
      if (cancelled) return;
      setChoice(nextChoice);
      setCustom(nextCustom);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routingSignature]);

  const persistModel = async (task: string, value: string) => {
    await setSetting(`${effectiveProvider(task)}_${task}_model`, value);
    await refresh();
  };

  if (loading) {
    return (
      <div className="space-y-3" aria-hidden>
        {AI_TASKS.map((task) => (
          <Skeleton key={task.key} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {AI_TASKS.map((task) => {
        const provider = effectiveProvider(task.key);
        const inherited = !taskProviders[task.key]?.trim();
        // A task that needs tool use can't run on a local model — including when it inherits a
        // default that happens to be one, which the row has to call out rather than silently fail.
        const broken = task.agenticOnly && !isAgenticProvider(provider);
        const options = modelOptionsFor(provider, modelCache.current[provider] ?? []);

        return (
          <div key={task.key} className="rounded-lg border border-[var(--cf-border)] p-2.5">
            <div className="mb-1.5">
              <p className="text-[12.5px] font-medium text-[var(--cf-text)]">{t(task.labelKey)}</p>
              <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{t(task.hintKey)}</p>
            </div>

            <div className="flex gap-1.5">
              <div className="w-[38%] shrink-0">
                <Select
                  size="sm"
                  ariaLabel={t("settings.taskProviderLabel")}
                  value={taskProviders[task.key]?.trim() ?? ""}
                  onChange={(v) => void setTaskProvider(task.key, v)}
                  options={[
                    { value: "", label: t("settings.taskInherit", { provider: providerLabel(defaultProvider) }) },
                    // Providers that aren't installed stay listed but disabled — so it's clear they
                    // exist and what's missing, rather than silently vanishing from the list.
                    ...AI_PROVIDERS.filter((p) => p.available)
                      .filter((p) => !task.agenticOnly || isAgenticProvider(p.id))
                      .map((p) => {
                        const missing = statuses[p.id]?.available === false;
                        return {
                          value: p.id,
                          label: missing ? `${providerLabel(p.id)} — ${t("settings.providerMissing")}` : providerLabel(p.id),
                          disabled: missing,
                        };
                      }),
                  ]}
                />
              </div>
              <div className="min-w-0 flex-1">
                <ModelField
                  size="sm"
                  options={options}
                  choice={choice[task.key] ?? ""}
                  custom={custom[task.key] ?? ""}
                  defaultLabel={t("settings.taskModelInherit")}
                  customPlaceholder={customModelPlaceholder(provider, t("settings.modelIdPlaceholder"))}
                  onChoice={(v) => {
                    setChoice((prev) => ({ ...prev, [task.key]: v }));
                    // "Custom" isn't a model id — wait for the text before persisting anything.
                    if (v !== CUSTOM_MODEL) void persistModel(task.key, v);
                  }}
                  onCustom={(v) => {
                    setCustom((prev) => ({ ...prev, [task.key]: v }));
                    void persistModel(task.key, v.trim());
                  }}
                />
              </div>
            </div>

            {broken && (
              <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-danger)]">
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                {inherited ? t("settings.taskAgenticInherited") : t("settings.taskAgenticRequired")}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
