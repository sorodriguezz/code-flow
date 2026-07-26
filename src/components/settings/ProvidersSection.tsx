import { useEffect, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, CircleAlert, CircleCheck, FolderOpen, Loader2, Star, X } from "lucide-react";
import { getSetting, listAiModels, setSetting } from "../../lib/tauri/commands";
import { AI_PROVIDERS, isAgenticProvider, modelDisplayLabel, type AiProviderOption } from "../../lib/aiProviders";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useProviderStatusStore } from "../../state/providerStatusStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Checkbox } from "../common/Checkbox";
import { Skeleton } from "../common/Skeleton";
import {
  CUSTOM_MODEL,
  Field,
  ModelField,
  customModelPlaceholder,
  modelOptionsFor,
  parseModel,
} from "./modelPicker";

const providerKey = (providerId: string, suffix: string) => `${providerId}_${suffix}`;

interface ToolOption {
  id: string;
  descriptionKey: TranslationKey;
  recommended?: boolean;
}

// Claude Code's built-in tools. Other providers name their tools differently, so this preset
// checklist is shown only for Claude; other providers configure raw tool names via the
// custom-tool input below (the per-provider "raw tools" model).
const TOOL_OPTIONS: ToolOption[] = [
  { id: "Read", descriptionKey: "settings.toolReadDesc", recommended: true },
  { id: "Grep", descriptionKey: "settings.toolGrepDesc", recommended: true },
  { id: "Glob", descriptionKey: "settings.toolGlobDesc", recommended: true },
  { id: "WebFetch", descriptionKey: "settings.toolWebFetchDesc" },
  { id: "WebSearch", descriptionKey: "settings.toolWebSearchDesc" },
  { id: "Bash", descriptionKey: "settings.toolBashDesc" },
  { id: "Edit", descriptionKey: "settings.toolEditDesc" },
  { id: "Write", descriptionKey: "settings.toolWriteDesc" },
  { id: "NotebookEdit", descriptionKey: "settings.toolNotebookEditDesc" },
];

const KNOWN_TOOL_IDS = new Set(TOOL_OPTIONS.map((tool) => tool.id));
const DEFAULT_CLAUDE_TOOLS = TOOL_OPTIONS.filter((tool) => tool.recommended).map((tool) => tool.id);

const defaultToolsFor = (providerId: string) => (providerId === "claude" ? DEFAULT_CLAUDE_TOOLS : []);
const defaultBinaryFor = (providerId: string) =>
  AI_PROVIDERS.find((p) => p.id === providerId)?.defaultBinary ?? providerId;

/** Where to find a valid model ID for the "Custom" field — a listing command for the CLIs that
 * have one, or how the provider names its models. */
function customModelHint(providerId: string, t: (key: TranslationKey) => string): ReactNode {
  const command = providerId === "gemini" ? "agy models" : providerId === "opencode" ? "opencode models" : null;
  if (command) {
    return (
      <>
        {t("settings.modelIdHintRun")}{" "}
        <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[10.5px] dark:bg-white/[0.1]">
          {command}
        </code>
      </>
    );
  }
  if (providerId === "claude") return t("settings.modelIdHintClaude");
  if (providerId === "ollama") return t("settings.modelIdHintOllama");
  return t("settings.modelIdHintGeneric");
}

/** Availability badge: green when the CLI/endpoint answered, amber when it didn't. Blank while the
 * first check is still running, so nothing flashes "not found" before it's actually known. */
function StatusBadge({ providerId }: { providerId: string }) {
  const t = useT();
  const status = useProviderStatusStore((s) => s.byProvider[providerId]);
  const checking = useProviderStatusStore((s) => s.checking);

  if (!status) {
    return checking ? <Loader2 size={11} className="animate-spin text-[var(--cf-text-muted)]" /> : null;
  }
  return status.available ? (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--cf-success)]">
      <CircleCheck size={10} />
      {t("settings.providerReady")}
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--cf-warning)]">
      <CircleAlert size={10} />
      {t("settings.providerMissing")}
    </span>
  );
}

/**
 * One provider: header always shows what it is, whether it's installed and which base model it
 * runs; expanding reveals its binary/endpoint, base model and tool access. Each row owns its own
 * settings (`{provider}_*`) and persists them as they change, so configuring one provider never
 * disturbs another — which is what made the old shared-tab form feel like it moved things on
 * its own.
 */
function ProviderRow({ provider }: { provider: AiProviderOption }) {
  const t = useT();
  const defaultProviderId = useAiProviderStore((s) => s.providerId);
  const setDefaultProvider = useAiProviderStore((s) => s.setProvider);
  const refreshRouting = useAiProviderStore((s) => s.refresh);
  const recheck = useProviderStatusStore((s) => s.check);
  const status = useProviderStatusStore((s) => s.byProvider[provider.id]);
  const pushToast = useToastStore((s) => s.pushToast);

  const [expanded, setExpanded] = useState(false);
  const [binaryPath, setBinaryPath] = useState("");
  const [choice, setChoice] = useState("");
  const [custom, setCustom] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [customTool, setCustomTool] = useState("");
  const [dynamicModels, setDynamicModels] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const isOllama = provider.id === "ollama";
  const agentic = isAgenticProvider(provider.id);
  const label = provider.label ?? (provider.labelKey ? t(provider.labelKey) : provider.id);
  const isDefault = provider.id === defaultProviderId;
  const resolvedModel = choice === CUSTOM_MODEL ? custom.trim() : choice;

  // Header data only — cheap local settings reads, so every row can show its model without
  // spawning any CLI. The live model list waits until the row is actually opened.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedBinary, storedModel, storedTools] = await Promise.all([
        getSetting(providerKey(provider.id, "binary_path")).catch(() => null),
        getSetting(providerKey(provider.id, "model")).catch(() => null),
        getSetting(providerKey(provider.id, "allowed_tools")).catch(() => null),
      ]);
      if (cancelled) return;
      setBinaryPath(storedBinary || defaultBinaryFor(provider.id));
      const parsed = parseModel(storedModel, modelOptionsFor(provider.id, []).map((o) => o.id));
      setChoice(parsed.choice);
      setCustom(parsed.custom);
      setTools(
        storedTools ? storedTools.split(",").map((s) => s.trim()).filter(Boolean) : defaultToolsFor(provider.id),
      );
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  // Asking a CLI for its models spawns a process, so only do it for a row the user opened.
  useEffect(() => {
    if (!expanded || modelsLoaded) return;
    let cancelled = false;
    void (async () => {
      const live = await listAiModels(provider.id).catch(() => [] as string[]);
      if (cancelled) return;
      setDynamicModels(live);
      // Re-classify the stored model now that the real option set is known, so a listed model
      // isn't left sitting in the "custom" box.
      const stored = await getSetting(providerKey(provider.id, "model")).catch(() => null);
      if (cancelled) return;
      const parsed = parseModel(stored, modelOptionsFor(provider.id, live).map((o) => o.id));
      setChoice(parsed.choice);
      setCustom(parsed.custom);
      setModelsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, modelsLoaded, provider.id]);

  const saveBinary = async (value: string) => {
    setBinaryPath(value);
    await setSetting(providerKey(provider.id, "binary_path"), value);
    await recheck(provider.id);
  };

  const saveModel = async (value: string) => {
    await setSetting(providerKey(provider.id, "model"), value);
    if (isDefault) useAiProviderStore.getState().setModel(value);
    // Tasks inheriting this provider now resolve to a different model.
    await refreshRouting();
  };

  const saveTools = async (next: string[]) => {
    setTools(next);
    await setSetting(providerKey(provider.id, "allowed_tools"), next.join(","));
  };

  const browseBinary = async () => {
    const file = await openDialog({ multiple: false, directory: false, title: t("settings.selectClaudeBinaryTitle") });
    if (typeof file === "string") void saveBinary(file);
  };

  const makeDefault = async () => {
    await setDefaultProvider(provider.id);
    pushToast(t("settings.providerSelectedToast", { provider: label }), "success");
  };

  const options = modelOptionsFor(provider.id, dynamicModels);
  const modelLabel = resolvedModel ? modelDisplayLabel(provider.id, resolvedModel, t) : t("settings.modelDefault");
  const Icon = provider.icon;
  const inputClass =
    "w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]";

  return (
    <div className="rounded-lg border border-[var(--cf-border)]">
      <div className="flex items-center gap-2 p-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            size={14}
            className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
          <Icon size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="shrink-0 text-[13px] font-medium">{label}</span>
          <StatusBadge providerId={provider.id} />
          {loaded && <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-muted)]">{modelLabel}</span>}
        </button>

        {isDefault ? (
          <span
            title={t("settings.providerDefaultTitle")}
            className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--cf-accent)]"
          >
            <Star size={10} />
            {t("settings.providerDefault")}
          </span>
        ) : (
          <button
            onClick={makeDefault}
            className="shrink-0 rounded-md px-2 py-0.5 text-[10.5px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            {t("settings.providerMakeDefault")}
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-3.5 border-t border-[var(--cf-border)] p-3">
          {!loaded ? (
            <>
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </>
          ) : (
            <>
              {status && !status.available && (
                <p className="rounded-md border border-[color-mix(in_oklab,var(--cf-warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-2.5 py-2 text-[11.5px] leading-snug text-[var(--cf-text)]">
                  {isOllama
                    ? t("settings.providerMissingOllama", { detail: status.detail })
                    : t("settings.providerMissingBinary", { binary: status.binary })}
                </p>
              )}

              {!agentic && (
                <p className="rounded-md border border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-accent)_8%,transparent)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
                  {t("settings.localProviderNote")}
                </p>
              )}

              <Field
                label={isOllama ? t("settings.ollamaEndpointLabel") : t("settings.binaryLabel")}
                hint={isOllama ? t("settings.ollamaEndpointHint") : t("settings.binaryHint")}
              >
                <div className="flex gap-1.5">
                  <input
                    value={binaryPath}
                    onChange={(e) => setBinaryPath(e.target.value)}
                    onBlur={(e) => void saveBinary(e.target.value)}
                    className={`${inputClass} flex-1 font-mono`}
                  />
                  {!isOllama && (
                    <button
                      onClick={browseBinary}
                      title={t("settings.selectClaudeBinaryTitle")}
                      className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    >
                      <FolderOpen size={13} />
                      {t("settings.browse")}
                    </button>
                  )}
                </div>
              </Field>

              <Field label={t("settings.baseModel")} hint={t("settings.baseModelHint")}>
                <ModelField
                  options={options}
                  choice={choice}
                  custom={custom}
                  defaultLabel={t("settings.modelDefault")}
                  customHint={customModelHint(provider.id, t)}
                  customPlaceholder={customModelPlaceholder(provider.id, t("settings.modelIdPlaceholder"))}
                  onChoice={(v) => {
                    setChoice(v);
                    // "Custom" isn't an id — wait for the text before persisting.
                    if (v !== CUSTOM_MODEL) void saveModel(v);
                  }}
                  onCustom={(v) => {
                    setCustom(v);
                    void saveModel(v.trim());
                  }}
                />
              </Field>

              {agentic && (
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
                    {t("settings.allowedTools")}
                  </label>
                  <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.allowedToolsHint")}</p>
                  {provider.id === "claude" ? (
                    <div className="space-y-1.5 rounded-lg border border-[var(--cf-border)] p-2.5">
                      {TOOL_OPTIONS.map((tool) => (
                        <label
                          key={tool.id}
                          className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                        >
                          <Checkbox
                            checked={tools.includes(tool.id)}
                            onChange={() =>
                              void saveTools(
                                tools.includes(tool.id) ? tools.filter((x) => x !== tool.id) : [...tools, tool.id],
                              )
                            }
                            className="mt-0.5"
                          />
                          <span>
                            <span className="block text-[13px] font-medium">{tool.id}</span>
                            <span className="block text-[11px] text-[var(--cf-text-muted)]">
                              {t(tool.descriptionKey)}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.toolsProviderHint")}</p>
                  )}

                  {tools.filter((tool) => !KNOWN_TOOL_IDS.has(tool)).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {tools
                        .filter((tool) => !KNOWN_TOOL_IDS.has(tool))
                        .map((tool) => (
                          <span
                            key={tool}
                            className="flex items-center gap-1 rounded-md bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--cf-accent)]"
                          >
                            {tool}
                            <button onClick={() => void saveTools(tools.filter((x) => x !== tool))}>
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                    </div>
                  )}

                  <div className="mt-2 flex gap-1.5">
                    <input
                      value={customTool}
                      onChange={(e) => setCustomTool(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        const name = customTool.trim();
                        if (!name || tools.includes(name)) return;
                        void saveTools([...tools, name]);
                        setCustomTool("");
                      }}
                      placeholder={t("settings.addCustomTool")}
                      className={`${inputClass} flex-1 font-mono`}
                    />
                    <button
                      onClick={() => {
                        const name = customTool.trim();
                        if (!name || tools.includes(name)) return;
                        void saveTools([...tools, name]);
                        setCustomTool("");
                      }}
                      className="rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    >
                      {t("settings.add")}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The "which engines do I have" half of the AI settings: every provider, its availability, and
 * its configuration — separate from the "which engine runs what" routing table below it. */
export function ProvidersSection() {
  const t = useT();
  const checkAll = useProviderStatusStore((s) => s.checkAll);
  const checking = useProviderStatusStore((s) => s.checking);

  useEffect(() => {
    void checkAll();
  }, [checkAll]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <button
          onClick={() => void checkAll()}
          disabled={checking}
          className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:opacity-50"
        >
          {checking ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          {t("settings.providerRecheck")}
        </button>
      </div>
      {AI_PROVIDERS.filter((p) => p.available).map((provider) => (
        <ProviderRow key={provider.id} provider={provider} />
      ))}
      {AI_PROVIDERS.some((p) => !p.available) && (
        <p className="pt-1 text-[11px] text-[var(--cf-text-muted)]">
          {t("settings.providersComingSoon", {
            providers: AI_PROVIDERS.filter((p) => !p.available)
              .map((p) => p.label ?? p.id)
              .join(", "),
          })}
        </p>
      )}
    </div>
  );
}
