import { useEffect, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  FolderOpen,
  Loader2,
  RotateCw,
  Star,
  X,
} from "lucide-react";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import { AI_PROVIDERS, isAgenticProvider, modelDisplayLabel, type AiProviderOption } from "../../lib/aiProviders";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useProviderStatusStore } from "../../state/providerStatusStore";
import { useAiModelsStore } from "../../state/aiModelsStore";
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
  // Last, and not recommended, because it is the only one here that multiplies the others: a turn
  // that may spawn sub-agents is a turn whose cost and whose reach are both decided by the model.
  { id: "Task", descriptionKey: "settings.toolTaskDesc" },
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
  if (providerId === "codex") return t("settings.modelIdHintCodex");
  if (providerId === "opencode") return t("settings.modelIdHintOpencode");
  if (providerId === "cline") return t("settings.modelIdHintCline");
  return t("settings.modelIdHintGeneric");
}

/** A copyable one-line command. Installing is the user's call, so this hands them the exact string
 * rather than running anything. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className="group flex w-full items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-black/[0.03] px-2 py-1 text-left font-mono text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] dark:bg-white/[0.05]"
    >
      <span className="min-w-0 flex-1 truncate">{command}</span>
      {copied ? (
        <Check size={11} className="shrink-0 text-[var(--cf-success)]" />
      ) : (
        <Copy size={11} className="shrink-0 text-[var(--cf-text-muted)] opacity-0 group-hover:opacity-100" />
      )}
    </button>
  );
}

/** How to get this provider working: the install command (when there's a canonical one), whatever
 * has to run afterwards (sign-in, pulling a model), and a link to its official docs. */
function SetupHelp({ provider }: { provider: AiProviderOption }) {
  const t = useT();
  if (!provider.setup) return null;
  const { url, command, postCommand } = provider.setup;
  return (
    <div className="space-y-1.5 rounded-lg border border-[var(--cf-border)] p-2.5">
      <p className="text-[11.5px] font-medium text-[var(--cf-text)]">{t("settings.setupTitle")}</p>
      {command && <CommandLine command={command} />}
      {postCommand && <CommandLine command={postCommand} />}
      <button
        onClick={() => void openExternalUrl(url)}
        className="flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline"
      >
        <ExternalLink size={11} />
        {t("settings.setupDocs")}
      </button>
      {command && <p className="text-[10.5px] text-[var(--cf-text-muted)]">{t("settings.setupRestartHint")}</p>}
    </div>
  );
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
  const invalidateModels = useAiModelsStore((s) => s.invalidate);
  const rememberModel = useAiModelsStore((s) => s.remember);
  const ensureModels = useAiModelsStore((s) => s.ensure);
  const status = useProviderStatusStore((s) => s.byProvider[provider.id]);
  const pushToast = useToastStore((s) => s.pushToast);

  const [expanded, setExpanded] = useState(false);
  const [binaryPath, setBinaryPath] = useState("");
  const [choice, setChoice] = useState("");
  const [custom, setCustom] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [customTool, setCustomTool] = useState("");
  const [loaded, setLoaded] = useState(false);
  // `undefined` until the shared store has this provider's list — i.e. still loading.
  const dynamicModels = useAiModelsStore((s) => s.byProvider[provider.id]);
  const modelsLoaded = dynamicModels !== undefined;

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
      // **Empty when unset, and that is not the same as "nothing is allowed".** The backend only
      // passes `--allowedTools` when this list is non-empty, so an absent setting means the engine
      // runs with its own full tool set. Seeding the checkboxes with a recommendation here — which
      // is what this used to do — drew three ticked boxes over a restriction that did not exist:
      // the pane showed a read-only agent while the agent could write, and the difference only
      // appeared the first time you touched anything, because touching it is what wrote the list.
      setTools(storedTools ? storedTools.split(",").map((s) => s.trim()).filter(Boolean) : []);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  // Asking a CLI for its models spawns a process, so only do it for a row the user opened. The
  // shared store is what fetches — so the list (live ∪ hand-typed ids) is the same one the routing
  // table and the chat picker see.
  useEffect(() => {
    if (!expanded) return;
    void ensureModels([provider.id]);
  }, [expanded, provider.id, ensureModels, dynamicModels]);

  // Re-classify the stored model once the real option set is known, so a listed model isn't left
  // sitting in the "custom" box.
  useEffect(() => {
    if (!dynamicModels) return;
    let cancelled = false;
    void (async () => {
      const stored = await getSetting(providerKey(provider.id, "model")).catch(() => null);
      if (cancelled) return;
      const parsed = parseModel(stored, modelOptionsFor(provider.id, dynamicModels).map((o) => o.id));
      setChoice(parsed.choice);
      setCustom(parsed.custom);
    })();
    return () => {
      cancelled = true;
    };
  }, [dynamicModels, provider.id]);

  const saveBinary = async (value: string) => {
    setBinaryPath(value);
    await setSetting(providerKey(provider.id, "binary_path"), value);
    await recheck(provider.id);
  };

  const saveModel = async (value: string) => {
    // A hand-typed id becomes a normal option next time — the only way Claude Code and Codex,
    // which can't enumerate their models, ever learn about new ones.
    if (value.trim()) void rememberModel(provider.id, value);
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
          {/* The brand mark where the provider has one — see `ProviderGlyph`. Untinted on
              purpose: a logo whose colour is muted grey is a logo nobody recognises. */}
          <ProviderGlyph providerId={provider.id} size={14} />
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
                  {t("settings.providerMissingBinary", { binary: status.binary })}
                </p>
              )}

              {!agentic && (
                <p className="rounded-md border border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-accent)_8%,transparent)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
                  {t("settings.localProviderNote")}
                </p>
              )}

              {/* Up top when it isn't working, so "Not found" is immediately actionable; tucked
                  below the config once it is, where it's reference rather than a to-do. */}
              {status && !status.available && <SetupHelp provider={provider} />}

              <Field label={t("settings.binaryLabel")} hint={t("settings.binaryHint")}>
                <div className="flex gap-1.5">
                  <input
                    value={binaryPath}
                    onChange={(e) => setBinaryPath(e.target.value)}
                    onBlur={(e) => void saveBinary(e.target.value)}
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

              <Field
                label={t("settings.baseModel")}
                hint={t("settings.baseModelHint")}
                action={
                  // The list is fetched live, but cached — this forces a re-fetch without
                  // restarting, for when the provider ships a model mid-session.
                  <button
                    onClick={() => invalidateModels(provider.id)}
                    disabled={!modelsLoaded}
                    title={t("settings.refreshModels")}
                    className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:opacity-50"
                  >
                    <RotateCw size={11} className={modelsLoaded ? "" : "animate-spin"} />
                    {t("settings.refreshModels")}
                  </button>
                }
              >
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

              {/* Only Claude Code's CLI takes an allow-list. For the other agentic CLIs the
                  setting would be inert, so they get an explanation of what actually governs
                  their access instead of a control that does nothing. */}
              {agentic && !provider.usesToolAllowlist && (
                <p className="rounded-md border border-[var(--cf-border)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
                  {t("settings.toolsSandboxNote")}
                </p>
              )}

              {agentic && provider.usesToolAllowlist && (
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
                    {t("settings.allowedTools")}
                  </label>
                  <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.allowedToolsHint")}</p>
                  {/* What an empty list actually means, said where the empty list is. Without this
                      the checklist reads as "nothing is permitted" — the opposite of the truth —
                      and the recommended set stays discoverable as a button rather than as three
                      ticks that were never saved. */}
                  {/* The second state is the one the honest empty list created. Ticking a single box
                      used to inherit the three that were pre-ticked; now it means exactly itself,
                      which is truthful and can leave an engine holding `Bash` and no way to open a
                      file. Rather than silently ticking boxes nobody asked for, the pane says what
                      the current list actually amounts to and keeps the one-click fix on screen.
                      Keyed on `Read` alone: it is the tool whose absence stops everything, while a
                      list without Edit or Write is an ordinary read-only choice and warning about
                      it would be noise. */}
                  {(tools.length === 0 || !tools.includes("Read")) && (
                    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-[var(--cf-warning)]/40 bg-[color-mix(in_oklab,var(--cf-warning)_8%,transparent)] px-2.5 py-2">
                      <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
                        {t(tools.length === 0 ? "settings.toolsUnrestricted" : "settings.toolsNoRead")}
                      </span>
                      <button
                        onClick={() =>
                          void saveTools(
                            tools.length === 0
                              ? defaultToolsFor(provider.id)
                              : // Added to what is already ticked rather than replacing it: the user
                                // chose those, and a fix that discarded a deliberate `Bash` to
                                // install a recommendation would be the silent rewrite this whole
                                // change exists to stop.
                                [...new Set([...defaultToolsFor(provider.id), ...tools])],
                          )
                        }
                        className="shrink-0 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                      >
                        {t(tools.length === 0 ? "settings.toolsUseRecommended" : "settings.toolsAddRecommended")}
                      </button>
                    </div>
                  )}
                  {/* The way back out. A user who ticked one box has created a restriction that also
                      governs their agent tasks, and without this the only route back to "no limit"
                      is unticking every box one at a time and guessing that empty means open. */}
                  {tools.length > 0 && (
                    <button
                      onClick={() => void saveTools([])}
                      className="mb-2 text-[11px] text-[var(--cf-text-muted)] underline hover:text-[var(--cf-accent)]"
                    >
                      {t("settings.toolsClearRestriction")}
                    </button>
                  )}
                  {(
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

              {status?.available && <SetupHelp provider={provider} />}
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
    </div>
  );
}
