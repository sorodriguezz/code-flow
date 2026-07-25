import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Bot,
  Check,
  ChevronDown,
  Cpu,
  FileText,
  FolderOpen,
  GitCommit,
  GitPullRequest,
  RotateCcw,
  ScanSearch,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  defaultAnalyzeTemplate,
  defaultCommitTemplate,
  defaultReviewTemplate,
  getSetting,
  listAiModels,
  setSetting,
} from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Checkbox } from "../common/Checkbox";
import { Skeleton } from "../common/Skeleton";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { ProviderTabs } from "../common/ProviderTabs";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useToastStore } from "../../state/toastStore";
import { AI_PROVIDERS, PROVIDER_MODELS, modelDisplayLabel, type AiModelOption } from "../../lib/aiProviders";

/** Per-provider settings live under `${providerId}_${suffix}` — binary/model/tools are
 * intrinsically provider-specific, so switching the provider tab loads that provider's own. */
const providerKey = (providerId: string, suffix: string) => `${providerId}_${suffix}`;

/** Prompt templates are shared across every provider (the same instructions are sent whichever
 * engine runs). Stored under an unprefixed key, with a fallback read from the legacy `claude_*`
 * key so an existing customization survives the rename. */
const SHARED_TEMPLATE_KEYS = {
  commit: { key: "commit_template", legacy: "claude_commit_template" },
  review: { key: "review_template", legacy: "claude_review_template" },
  analyze: { key: "analyze_template", legacy: "claude_analyze_template" },
};

/** The four per-provider model settings. `base` (`${provider}_model`) drives chat and is the
 * default for the others; the rest are optional per-task overrides read by the Rust `AiTask`
 * dispatch (empty = use the task's default). */
const MODEL_SUFFIX: Record<ModelKey, string> = {
  base: "model",
  commit: "commit_model",
  analyze: "analyze_model",
  review: "review_model",
};

type ModelKey = "base" | "commit" | "analyze" | "review";
const MODEL_KEYS: ModelKey[] = ["base", "commit", "analyze", "review"];

const CUSTOM_MODEL = "__custom__";

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

const KNOWN_TOOL_IDS = new Set(TOOL_OPTIONS.map((t) => t.id));
const DEFAULT_CLAUDE_TOOLS = TOOL_OPTIONS.filter((t) => t.recommended).map((t) => t.id);

const emptyModels = (): Record<ModelKey, string> => ({ base: "", commit: "", analyze: "", review: "" });

/** Default tool selection for a fresh provider with nothing saved yet — Claude gets its
 * recommended preset; other providers start empty (the user adds raw tool names). */
function defaultToolsFor(providerId: string): string[] {
  return providerId === "claude" ? DEFAULT_CLAUDE_TOOLS : [];
}

function defaultBinaryFor(providerId: string): string {
  return AI_PROVIDERS.find((p) => p.id === providerId)?.defaultBinary ?? providerId;
}

/** Splits a stored model id into the dropdown choice + custom-text buffer: an id present in
 * `knownIds` selects its option, a blank means "default", and anything else is a custom id the
 * user typed. `knownIds` is the effective option set (the CLI's live list when available, else the
 * curated fallback), so a model that really exists doesn't get mislabelled "custom". */
function parseModel(raw: string | null | undefined, knownIds: string[]): { choice: string; custom: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { choice: "", custom: "" };
  if (knownIds.includes(trimmed)) return { choice: trimmed, custom: "" };
  return { choice: CUSTOM_MODEL, custom: trimmed };
}

/** The option set to show for a provider: the CLI's live models when we got them, else the curated
 * fallback list. Live ids (e.g. `opencode/claude-sonnet-5`) are shown verbatim — they're already
 * the exact string the CLI expects. */
function modelOptionsFor(providerId: string, dynamicModels: string[]): AiModelOption[] {
  if (dynamicModels.length > 0) return dynamicModels.map((id) => ({ id, label: id }));
  return PROVIDER_MODELS[providerId] ?? [];
}

/** Reads the shared template's new key, falling back to the legacy `claude_*` key. */
async function loadSharedTemplate(spec: { key: string; legacy: string }): Promise<string> {
  const [current, legacy] = await Promise.all([
    getSetting(spec.key).catch(() => null),
    getSetting(spec.legacy).catch(() => null),
  ]);
  return (current && current.trim() ? current : legacy) ?? "";
}

/** A titled card that visually groups a set of settings, with an icon chip + subtitle header —
 * the same card language used elsewhere in the app (connection cards, the AI panel headers).
 * When `collapsible`, the header toggles the body open/closed (a chevron marks the state); the
 * per-provider config uses this so the tall binary/model/tools block stays folded away by default. */
function GroupCard({
  icon: Icon,
  title,
  subtitle,
  children,
  collapsible = false,
  defaultOpen = true,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = !collapsible || open;

  const header = (
    <>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight">{title}</p>
        {subtitle && <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{subtitle}</p>}
      </div>
      {collapsible && (
        <ChevronDown
          size={16}
          className={`mt-0.5 shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "" : "-rotate-90"}`}
        />
      )}
    </>
  );

  return (
    <div className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`flex w-full items-start gap-2.5 text-left ${expanded ? "mb-4" : ""}`}
        >
          {header}
        </button>
      ) : (
        <div className="mb-4 flex items-start gap-2.5">{header}</div>
      )}
      {expanded && children}
    </div>
  );
}

/** Placeholder shown in the per-provider card while its binary/model/tools load — chiefly the
 * CLI's live model list (`listAiModels`), which can take a beat, so the switch feels responsive. */
function ProviderConfigSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-full" />
      </div>
      <Skeleton className="h-9 w-full" />
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}

/** A labelled setting row: label on top, control, then an optional hint below — the app's
 * standard field layout, factored out so every field lines up identically. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">{hint}</p>}
    </div>
  );
}

/** A model picker: default option → option list → custom id. Fully controlled; the parent owns
 * the choice + custom-text buffer (so provider switches reload cleanly) and the `options` list
 * (the CLI's live models when available, else the curated fallback). */
function ModelField({
  options,
  choice,
  custom,
  defaultLabel,
  customHint,
  customPlaceholder,
  onChoice,
  onCustom,
}: {
  options: AiModelOption[];
  choice: string;
  custom: string;
  defaultLabel: string;
  /** Per-provider "where to find the ID" note, shown under the custom input. */
  customHint?: ReactNode;
  customPlaceholder?: string;
  onChoice: (v: string) => void;
  onCustom: (v: string) => void;
}) {
  const t = useT();
  return (
    <>
      <select
        value={choice}
        onChange={(e) => onChoice(e.target.value)}
        className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
      >
        <option value="">{defaultLabel}</option>
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.labelKey ? t(opt.labelKey) : opt.label}
          </option>
        ))}
        <option value={CUSTOM_MODEL}>{t("settings.modelCustom")}</option>
      </select>
      {choice === CUSTOM_MODEL && (
        <>
          <input
            value={custom}
            onChange={(e) => onCustom(e.target.value)}
            placeholder={customPlaceholder ?? "model ID"}
            className="mt-1.5 w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] font-mono outline-none focus:border-[var(--cf-accent)]"
          />
          {customHint && <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{customHint}</p>}
        </>
      )}
    </>
  );
}

/** The reset-to-default control shown on the right of each template's collapsible header. */
function ResetAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
    >
      <RotateCcw size={11} />
      {label}
    </button>
  );
}

export function ClaudeSettings() {
  const t = useT();
  const providerId = useAiProviderStore((s) => s.providerId);
  const setProvider = useAiProviderStore((s) => s.setProvider);
  const pushToast = useToastStore((s) => s.pushToast);
  const activeProvider = AI_PROVIDERS.find((p) => p.id === providerId);
  const providerLabel = activeProvider
    ? activeProvider.label ?? (activeProvider.labelKey ? t(activeProvider.labelKey) : providerId)
    : providerId;
  const ProviderIcon = activeProvider?.icon ?? Bot;
  const showToolPresets = providerId === "claude";

  const [binaryPath, setBinaryPath] = useState("claude");
  // True while the active provider's binary/model/tools (and its live model list) are being
  // fetched — drives the skeleton so switching providers gives immediate feedback.
  const [loading, setLoading] = useState(true);
  // Which provider the binary/model/tools state currently belongs to. The auto-save effect only
  // runs once this matches the active provider, so it never fires mid-switch (when the state still
  // holds the previous provider's values) and never writes them under the wrong provider's keys.
  const [hydratedProvider, setHydratedProvider] = useState<string | null>(null);
  // The provider CLI's live model list (e.g. `opencode models`), when it exposes one. Empty → the
  // dropdowns fall back to the curated `PROVIDER_MODELS` list for this provider.
  const [dynamicModels, setDynamicModels] = useState<string[]>([]);
  const [modelChoice, setModelChoice] = useState<Record<ModelKey, string>>(emptyModels());
  const [modelCustom, setModelCustom] = useState<Record<ModelKey, string>>(emptyModels());
  const [tools, setTools] = useState<string[]>(DEFAULT_CLAUDE_TOOLS);
  const [customTool, setCustomTool] = useState("");
  const [commitTemplate, setCommitTemplate] = useState("");
  const [defaultTemplate, setDefaultTemplate] = useState("");
  const [reviewTemplate, setReviewTemplate] = useState("");
  const [defaultReviewTemplateText, setDefaultReviewTemplateText] = useState("");
  const [analyzeTemplate, setAnalyzeTemplate] = useState("");
  const [defaultAnalyzeTemplateText, setDefaultAnalyzeTemplateText] = useState("");
  const [saved, setSaved] = useState(false);
  const [snapshot, setSnapshot] = useState({
    binaryPath: "claude",
    models: emptyModels(),
    tools: DEFAULT_CLAUDE_TOOLS,
    commitTemplate: "",
    reviewTemplate: "",
    analyzeTemplate: "",
  });

  const resolvedModel = (key: ModelKey) =>
    modelChoice[key] === CUSTOM_MODEL ? modelCustom[key].trim() : modelChoice[key];
  const models: Record<ModelKey, string> = {
    base: resolvedModel("base"),
    commit: resolvedModel("commit"),
    analyze: resolvedModel("analyze"),
    review: resolvedModel("review"),
  };
  const setChoiceFor = (key: ModelKey, v: string) => setModelChoice((prev) => ({ ...prev, [key]: v }));
  const setCustomFor = (key: ModelKey, v: string) => setModelCustom((prev) => ({ ...prev, [key]: v }));
  // The list every model dropdown shows: the CLI's live models when available, else the curated one.
  const modelOptions = modelOptionsFor(providerId, dynamicModels);

  // Where to find a valid model ID for the "Custom" field — command to list them for CLIs that can
  // (opencode / agy), or how Claude names them (it has no list command).
  const modelsListCommand = providerId === "gemini" ? "agy models" : providerId === "opencode" ? "opencode models" : null;
  const customModelHint: ReactNode = modelsListCommand ? (
    <>
      {t("settings.modelIdHintRun")}{" "}
      <code className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[10.5px] dark:bg-white/[0.1]">
        {modelsListCommand}
      </code>
    </>
  ) : providerId === "claude" ? (
    t("settings.modelIdHintClaude")
  ) : (
    t("settings.modelIdHintGeneric")
  );
  const customModelPlaceholder =
    providerId === "gemini"
      ? "e.g. gemini-3.6-flash-high"
      : providerId === "opencode"
        ? "e.g. opencode/claude-sonnet-5"
        : providerId === "claude"
          ? "e.g. sonnet — or claude-sonnet-5"
          : t("settings.modelIdPlaceholder");

  // Shared templates load once — they don't change when the provider tab does.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ct, fallback, rt, reviewFallback, at, analyzeFallback] = await Promise.all([
        loadSharedTemplate(SHARED_TEMPLATE_KEYS.commit),
        defaultCommitTemplate(),
        loadSharedTemplate(SHARED_TEMPLATE_KEYS.review),
        defaultReviewTemplate(),
        loadSharedTemplate(SHARED_TEMPLATE_KEYS.analyze),
        defaultAnalyzeTemplate(),
      ]);
      if (cancelled) return;
      const loadedTemplate = ct || fallback;
      const loadedReviewTemplate = rt || reviewFallback;
      const loadedAnalyzeTemplate = at || analyzeFallback;
      setDefaultTemplate(fallback);
      setCommitTemplate(loadedTemplate);
      setDefaultReviewTemplateText(reviewFallback);
      setReviewTemplate(loadedReviewTemplate);
      setDefaultAnalyzeTemplateText(analyzeFallback);
      setAnalyzeTemplate(loadedAnalyzeTemplate);
      setSnapshot((prev) => ({
        ...prev,
        commitTemplate: loadedTemplate,
        reviewTemplate: loadedReviewTemplate,
        analyzeTemplate: loadedAnalyzeTemplate,
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-provider binary/models/tools reload whenever the active provider changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [b, base, commit, analyze, review, toolsRaw, dyn] = await Promise.all([
        getSetting(providerKey(providerId, "binary_path")).catch(() => null),
        getSetting(providerKey(providerId, MODEL_SUFFIX.base)).catch(() => null),
        getSetting(providerKey(providerId, MODEL_SUFFIX.commit)).catch(() => null),
        getSetting(providerKey(providerId, MODEL_SUFFIX.analyze)).catch(() => null),
        getSetting(providerKey(providerId, MODEL_SUFFIX.review)).catch(() => null),
        getSetting(providerKey(providerId, "allowed_tools")).catch(() => null),
        // Ask the provider's CLI for its real model list (empty for CLIs that don't expose one).
        listAiModels(providerId).catch(() => [] as string[]),
      ]);
      if (cancelled) return;
      const loadedBinary = b || defaultBinaryFor(providerId);
      // Classify stored models against the effective option set (live list if we got one, else the
      // curated fallback) so a real model isn't mislabelled as a custom id.
      const knownIds = modelOptionsFor(providerId, dyn).map((o) => o.id);
      const parsed: Record<ModelKey, { choice: string; custom: string }> = {
        base: parseModel(base, knownIds),
        commit: parseModel(commit, knownIds),
        analyze: parseModel(analyze, knownIds),
        review: parseModel(review, knownIds),
      };
      setDynamicModels(dyn);
      const loadedTools = toolsRaw
        ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : defaultToolsFor(providerId);

      setBinaryPath(loadedBinary);
      setModelChoice({
        base: parsed.base.choice,
        commit: parsed.commit.choice,
        analyze: parsed.analyze.choice,
        review: parsed.review.choice,
      });
      setModelCustom({
        base: parsed.base.custom,
        commit: parsed.commit.custom,
        analyze: parsed.analyze.custom,
        review: parsed.review.custom,
      });
      setTools(loadedTools);
      setSnapshot((prev) => ({
        ...prev,
        binaryPath: loadedBinary,
        models: {
          base: parsed.base.choice === CUSTOM_MODEL ? parsed.base.custom : parsed.base.choice,
          commit: parsed.commit.choice === CUSTOM_MODEL ? parsed.commit.custom : parsed.commit.choice,
          analyze: parsed.analyze.choice === CUSTOM_MODEL ? parsed.analyze.custom : parsed.analyze.choice,
          review: parsed.review.choice === CUSTOM_MODEL ? parsed.review.custom : parsed.review.choice,
        },
        tools: loadedTools,
      }));
      setHydratedProvider(providerId);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const toggleTool = (id: string) => {
    setTools((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  };

  const addCustomTool = () => {
    const name = customTool.trim();
    if (!name || tools.includes(name)) return;
    setTools((prev) => [...prev, name]);
    setCustomTool("");
  };

  const removeTool = (id: string) => setTools((prev) => prev.filter((t) => t !== id));

  const browseBinary = async () => {
    const file = await open({ multiple: false, directory: false, title: t("settings.selectClaudeBinaryTitle") });
    if (typeof file === "string") setBinaryPath(file);
  };

  // Switching the provider tab persists `ai_provider` immediately — so the confirmation toast is
  // honest ("selected — now powering …"). No-ops for the already-active tab to avoid a repeat toast.
  const handleSelectProvider = async (id: string) => {
    if (id === providerId) return;
    await setProvider(id);
    const p = AI_PROVIDERS.find((x) => x.id === id);
    const label = p ? (p.label ?? (p.labelKey ? t(p.labelKey) : id)) : id;
    pushToast(t("settings.providerAppliedToast", { provider: label }), "success");
  };

  // For Claude the "custom" chips are tools outside its preset checklist; for other providers,
  // every tool is a custom chip (they have no preset).
  const customTools = showToolPresets ? tools.filter((t) => !KNOWN_TOOL_IDS.has(t)) : tools;
  const sortedTools = [...tools].sort();
  // The per-provider config (binary/models/tools) auto-applies as you change it; this tracks a
  // pending diff so the auto-save effect knows what to persist.
  const providerDirty =
    binaryPath !== snapshot.binaryPath ||
    MODEL_KEYS.some((k) => models[k] !== snapshot.models[k]) ||
    sortedTools.join(",") !== [...snapshot.tools].sort().join(",");
  // The Save button owns only the shared prompt templates now.
  const templatesDirty =
    commitTemplate !== snapshot.commitTemplate ||
    reviewTemplate !== snapshot.reviewTemplate ||
    analyzeTemplate !== snapshot.analyzeTemplate;

  // Persist the per-provider config the moment the user changes it — binary, models and tools now
  // apply on the spot, so the Save button is no longer involved. Runs synchronously (no debounce)
  // so nothing is lost if Settings is closed right after a change; the effect below gates it so it
  // only ever writes the hydrated provider's own keys.
  const persistProviderConfig = async () => {
    await Promise.all([
      setSetting(providerKey(providerId, "binary_path"), binaryPath),
      setSetting(providerKey(providerId, MODEL_SUFFIX.base), models.base),
      setSetting(providerKey(providerId, MODEL_SUFFIX.commit), models.commit),
      setSetting(providerKey(providerId, MODEL_SUFFIX.analyze), models.analyze),
      setSetting(providerKey(providerId, MODEL_SUFFIX.review), models.review),
      setSetting(providerKey(providerId, "allowed_tools"), tools.join(",")),
    ]);
    // Keep the chat chip's model in sync with the base model.
    useAiProviderStore.getState().setModel(models.base);
    setSnapshot((prev) => ({ ...prev, binaryPath, models: { ...models }, tools }));
  };

  // Auto-apply per-provider changes. Gated on hydration + no in-flight load so it never runs with
  // stale/mismatched state; the value deps make it re-fire on every change (a bare `providerDirty`
  // wouldn't, since it stays `true` across successive edits).
  useEffect(() => {
    if (loading || hydratedProvider !== providerId || !providerDirty) return;
    void persistProviderConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loading,
    hydratedProvider,
    providerId,
    providerDirty,
    binaryPath,
    models.base,
    models.commit,
    models.analyze,
    models.review,
    sortedTools.join(","),
  ]);

  // Success toast confirming a model is now live, by its friendly name (raw id if custom/unknown).
  const notifyModelApplied = (resolved: string) =>
    pushToast(
      t("settings.modelAppliedToast", { model: modelDisplayLabel(providerId, resolved, t), provider: providerLabel }),
      "success",
    );

  // The Save button owns only the shared prompt templates.
  const saveTemplates = async () => {
    await Promise.all([
      setSetting(SHARED_TEMPLATE_KEYS.commit.key, commitTemplate.trim()),
      setSetting(SHARED_TEMPLATE_KEYS.review.key, reviewTemplate.trim()),
      setSetting(SHARED_TEMPLATE_KEYS.analyze.key, analyzeTemplate.trim()),
    ]);
    setSnapshot((prev) => ({
      ...prev,
      commitTemplate: commitTemplate.trim(),
      reviewTemplate: reviewTemplate.trim(),
      analyzeTemplate: analyzeTemplate.trim(),
    }));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const inputClass =
    "w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]";

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.aiSectionTitle")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.aiSectionHint")}</p>
      <ProviderTabs options={AI_PROVIDERS} activeId={providerId} onSelect={handleSelectProvider} />

      <div className="mt-5 space-y-4">
        {/* ── Per-provider configuration: binary, models, tools ── */}
        <GroupCard
          icon={ProviderIcon}
          title={providerLabel}
          subtitle={t("settings.providerConfigHint")}
          collapsible
          defaultOpen={false}
        >
          {loading ? (
            <ProviderConfigSkeleton />
          ) : (
          <div className="space-y-4">
            <Field label={t("settings.binaryLabel")} hint={t("settings.binaryHint")}>
              <div className="flex gap-1.5">
                <input
                  value={binaryPath}
                  onChange={(e) => setBinaryPath(e.target.value)}
                  className={`${inputClass} flex-1 font-mono`}
                />
                <button
                  onClick={browseBinary}
                  title={t("settings.selectClaudeBinaryTitle")}
                  className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  <FolderOpen size={13} />
                  {t("settings.browse")}
                </button>
              </div>
            </Field>

            <Field label={t("settings.baseModel")} hint={t("settings.baseModelHint")}>
              <ModelField
                options={modelOptions}
                choice={modelChoice.base}
                custom={modelCustom.base}
                defaultLabel={t("settings.modelDefault")}
                customHint={customModelHint}
                customPlaceholder={customModelPlaceholder}
                onChoice={(v) => {
                  setChoiceFor("base", v);
                  // Concrete pick (a listed model or "default") applies immediately — confirm it.
                  // "Custom" waits until the user types the id, so no premature toast there.
                  if (v !== CUSTOM_MODEL) notifyModelApplied(v);
                }}
                onCustom={(v) => setCustomFor("base", v)}
              />
            </Field>

            <div className="rounded-lg border border-[var(--cf-border)] px-2.5 py-1">
              <CollapsibleSection icon={Cpu} title={t("settings.taskModelsTitle")}>
                <p className="mb-2.5 text-[11px] text-[var(--cf-text-muted)]">{t("settings.taskModelsHint")}</p>
                <div className="space-y-3 pb-1">
                  <Field label={t("settings.commitModelLabel")}>
                    <ModelField
                      options={modelOptions}
                      choice={modelChoice.commit}
                      custom={modelCustom.commit}
                      defaultLabel={t("settings.modelFastDefault")}
                      customHint={customModelHint}
                      customPlaceholder={customModelPlaceholder}
                      onChoice={(v) => setChoiceFor("commit", v)}
                      onCustom={(v) => setCustomFor("commit", v)}
                    />
                  </Field>
                  <Field label={t("settings.analyzeModelLabel")}>
                    <ModelField
                      options={modelOptions}
                      choice={modelChoice.analyze}
                      custom={modelCustom.analyze}
                      defaultLabel={t("settings.modelSameAsBase")}
                      customHint={customModelHint}
                      customPlaceholder={customModelPlaceholder}
                      onChoice={(v) => setChoiceFor("analyze", v)}
                      onCustom={(v) => setCustomFor("analyze", v)}
                    />
                  </Field>
                  <Field label={t("settings.reviewModelLabel")}>
                    <ModelField
                      options={modelOptions}
                      choice={modelChoice.review}
                      custom={modelCustom.review}
                      defaultLabel={t("settings.modelSameAsBase")}
                      customHint={customModelHint}
                      customPlaceholder={customModelPlaceholder}
                      onChoice={(v) => setChoiceFor("review", v)}
                      onCustom={(v) => setCustomFor("review", v)}
                    />
                  </Field>
                </div>
              </CollapsibleSection>
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
                {t("settings.allowedTools")}
              </label>
              <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.allowedToolsHint")}</p>
              {showToolPresets ? (
                <div className="space-y-1.5 rounded-lg border border-[var(--cf-border)] p-2.5">
                  {TOOL_OPTIONS.map((tool) => (
                    <label
                      key={tool.id}
                      className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                    >
                      <Checkbox checked={tools.includes(tool.id)} onChange={() => toggleTool(tool.id)} className="mt-0.5" />
                      <span>
                        <span className="block text-[13px] font-medium">{tool.id}</span>
                        <span className="block text-[11px] text-[var(--cf-text-muted)]">{t(tool.descriptionKey)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.toolsProviderHint")}</p>
              )}

              {customTools.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {customTools.map((tool) => (
                    <span
                      key={tool}
                      className="flex items-center gap-1 rounded-md bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--cf-accent)]"
                    >
                      {tool}
                      <button onClick={() => removeTool(tool)}>
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                !showToolPresets && <p className="mt-2 text-[11px] italic text-[var(--cf-text-muted)]">{t("settings.toolsNone")}</p>
              )}

              <div className="mt-2 flex gap-1.5">
                <input
                  value={customTool}
                  onChange={(e) => setCustomTool(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomTool();
                    }
                  }}
                  placeholder={t("settings.addCustomTool")}
                  className={`${inputClass} flex-1 font-mono`}
                />
                <button
                  onClick={addCustomTool}
                  className="rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                >
                  {t("settings.add")}
                </button>
              </div>
            </div>
          </div>
          )}
        </GroupCard>

        {/* ── Shared prompt templates: one set used by every provider ── */}
        <GroupCard icon={FileText} title={t("settings.templatesTitle")} subtitle={t("settings.templatesSharedHint")}>
          <div className="space-y-2.5">
            <CollapsibleSection
              icon={GitCommit}
              title={t("settings.commitTemplate")}
              action={<ResetAction label={t("settings.reset")} onClick={() => setCommitTemplate(defaultTemplate)} />}
            >
              <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.commitTemplateHint")}</p>
              <textarea
                value={commitTemplate}
                onChange={(e) => setCommitTemplate(e.target.value)}
                rows={5}
                className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
              />
            </CollapsibleSection>

            <CollapsibleSection
              icon={GitPullRequest}
              title={t("settings.reviewTemplate")}
              action={
                <ResetAction label={t("settings.reset")} onClick={() => setReviewTemplate(defaultReviewTemplateText)} />
              }
            >
              <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.reviewTemplateHint")}</p>
              <textarea
                value={reviewTemplate}
                onChange={(e) => setReviewTemplate(e.target.value)}
                rows={10}
                className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
              />
            </CollapsibleSection>

            <CollapsibleSection
              icon={ScanSearch}
              title={t("settings.analyzeTemplate")}
              action={
                <ResetAction
                  label={t("settings.reset")}
                  onClick={() => setAnalyzeTemplate(defaultAnalyzeTemplateText)}
                />
              }
            >
              <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.analyzeTemplateHint")}</p>
              <textarea
                value={analyzeTemplate}
                onChange={(e) => setAnalyzeTemplate(e.target.value)}
                rows={10}
                className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
              />
            </CollapsibleSection>
          </div>

          <button
            onClick={saveTemplates}
            disabled={!templatesDirty}
            className="mt-4 flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
          >
            {saved ? <Check size={13} /> : null}
            {saved ? t("settings.saved") : t("common.save")}
          </button>
        </GroupCard>
      </div>
    </section>
  );
}
