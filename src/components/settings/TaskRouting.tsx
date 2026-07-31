import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import { useAiModelsStore } from "../../state/aiModelsStore";
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

  const modelsByProvider = useAiModelsStore((s) => s.byProvider);
  const ensureModels = useAiModelsStore((s) => s.ensure);
  const rememberModel = useAiModelsStore((s) => s.remember);
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
      // Shared cache, so the lists here match the provider rows and the chat picker — including
      // any model id typed by hand into a "Custom" field.
      await ensureModels(Array.from(new Set(AI_TASKS.map((task) => effectiveProvider(task.key)))));
      if (cancelled) return;
      const cache = useAiModelsStore.getState().byProvider;

      const nextChoice: Record<string, string> = {};
      const nextCustom: Record<string, string> = {};
      await Promise.all(
        AI_TASKS.map(async ({ key }) => {
          const provider = effectiveProvider(key);
          const stored = await getSetting(`${provider}_${key}_model`).catch(() => null);
          const ids = modelOptionsFor(provider, cache[provider] ?? []).map((o) => o.id);
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
    const provider = effectiveProvider(task);
    // Keep hand-typed ids as future options — see the store's `remember`.
    if (value.trim()) void rememberModel(provider, value);
    await setSetting(`${provider}_${task}_model`, value);
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
        const selected = taskProviders[task.key]?.trim() ?? "";
        const inherited = !selected;
        // A task that needs tool use can't run on a local model — including when it inherits a
        // default that happens to be one, which the row has to call out rather than silently fail.
        const broken = task.agenticOnly && !isAgenticProvider(provider);
        const options = modelOptionsFor(provider, modelsByProvider[provider] ?? []);

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
                  value={selected}
                  onChange={(v) => void setTaskProvider(task.key, v)}
                  options={[
                    { value: "", label: t("settings.taskInherit", { provider: providerLabel(defaultProvider) }) },
                    // Only what can actually run the task. This list used to keep every provider and
                    // grey out the ones that aren't installed, which made it half menu and half
                    // catalogue: "what is available to install" is the Providers tab's job, and it
                    // says so there with the reason and the fix. Here they were rows you could
                    // neither pick nor act on, between the ones you could.
                    //
                    // The exception is a provider this task is *already* set to. Dropping that one
                    // would leave the select showing a value it doesn't list — the row would read as
                    // inheriting when it isn't — so a broken assignment stays visible, and stays
                    // labelled with why, until it's changed.
                    //
                    // A provider that hasn't been probed yet is `undefined` rather than `false`, so
                    // nothing disappears while the statuses are still coming in.
                    ...AI_PROVIDERS.filter((p) => p.available)
                      .filter((p) => !task.agenticOnly || isAgenticProvider(p.id))
                      .filter((p) => statuses[p.id]?.available !== false || p.id === selected)
                      .map((p) => {
                        const missing = statuses[p.id]?.available === false;
                        return {
                          value: p.id,
                          label: missing ? `${providerLabel(p.id)} — ${t("settings.providerMissing")}` : providerLabel(p.id),
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
