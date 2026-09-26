/**
 * One table for everything an AI task is: which engine runs it, and what that engine is told.
 *
 * This replaces two sub-tabs — "Model per task" and "Prompt templates" — that were the same screen
 * cut in half. The tell was in the old code: the templates pane imported the routing store purely
 * so it could print "Claude Code · Opus 5" under each prompt, because a prompt without its engine
 * is half an answer, and the two lived a tab apart. Sixteen routing rows in one flat list and
 * twenty-four prompts in another, neither searchable.
 *
 * So the unit is the task, the prompts hang off it, and there is one search box over both.
 *
 * Three things are deliberate about the layout:
 *
 * 1. **Nothing is truncated.** Task names, prompt names and hints all wrap. A row here is two lines
 *    tall when it needs to be; a name you can only half-read is worse than a taller row.
 * 2. **Collapsed rows still say the state.** Which engine, how many prompts, how many you edited,
 *    and whether something is misrouted — all readable without opening anything, because the
 *    question this screen usually gets asked is "what is set up wrong", not "let me change one".
 * 3. **One thing open at a time.** Both levels are accordions. Several open prompts is several
 *    hundred lines of text on one scroll, and then the search box is the only way back.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import { useAiModelsStore } from "../../state/aiModelsStore";
import { AI_PROVIDERS, isAgenticProvider } from "../../lib/aiProviders";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { AI_TASKS, AI_TASK_AREAS, type AiTaskDef } from "../../lib/aiTasks";
import {
  AI_PROMPTS,
  contractHolds,
  loadPromptDefault,
  loadPromptValue,
  promptsForTask,
  resetPromptValue,
  savePromptValue,
  type PromptDef,
} from "../../lib/aiPrompts";
import { collapseUnchanged, countChanges, diffLines } from "../../lib/textDiff";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useProviderStatusStore } from "../../state/providerStatusStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT, type Translate } from "../../state/languageStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { modelRouteLabel } from "../ai/ModelTag";
import { chipClass, fieldClass } from "../common/recipes";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { CUSTOM_MODEL, ModelField, customModelPlaceholder, modelOptionsFor, parseModel } from "./modelPicker";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { SYSTEM_ACCOUNT, resolveAccount, validPreference } from "../../lib/aiAccounts";

/** A prompt's text as it stands, beside the built-in it would fall back to. */
interface PromptState {
  value: string;
  fallback: string;
}

/** The small uppercase heading over a group — an area of tasks, or the engine / prompts of one. */
const SECTION_LABEL = "text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

/** An accordion card: an accent hairline while open, a stronger one on hover while closed. */
function accordionClass(open: boolean): string {
  return `rounded-lg border transition-colors duration-100 ${
    open
      ? "border-[var(--cf-accent-line)] bg-[var(--cf-hover)]"
      : "border-[var(--cf-border)] hover:border-[var(--cf-border-strong)]"
  }`;
}

/** Accent-and-case-insensitive, so "revision" finds "Revisión". Same fold as the settings search. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function AiTasksSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // ---------- routing ----------
  const defaultProvider = useAiProviderStore((s) => s.providerId);
  const taskProviders = useAiProviderStore((s) => s.taskProviders);
  const taskModels = useAiProviderStore((s) => s.taskModels);
  const setTaskProvider = useAiProviderStore((s) => s.setTaskProvider);
  const refresh = useAiProviderStore((s) => s.refresh);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkProviders = useProviderStatusStore((s) => s.checkAll);
  const modelsByProvider = useAiModelsStore((s) => s.byProvider);
  const ensureModels = useAiModelsStore((s) => s.ensure);
  const rememberModel = useAiModelsStore((s) => s.remember);

  const [choice, setChoice] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [routingLoaded, setRoutingLoaded] = useState(false);
  const ensureAccounts = useAiAccountsStore((s) => s.ensure);

  useEffect(() => {
    void ensureAccounts();
  }, [ensureAccounts]);

  // ---------- prompts ----------
  const [prompts, setPrompts] = useState<Record<string, PromptState> | null>(null);
  const latest = useRef<Record<string, PromptState> | null>(null);
  const persisted = useRef<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  // ---------- view ----------
  const [query, setQuery] = useState("");
  const [onlyCustom, setOnlyCustom] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);

  const effectiveProvider = (task: string) => taskProviders[task]?.trim() || defaultProvider;

  // The providers pane may never have mounted, and without its probe every provider reads as fine.
  useEffect(() => {
    if (Object.keys(useProviderStatusStore.getState().byProvider).length === 0) void checkProviders();
  }, [checkProviders]);

  // Re-read whenever routing changes: a task pointed at another provider shows that provider's
  // models and its own stored override.
  const routingSignature = `${defaultProvider}::${AI_TASKS.map((task) => taskProviders[task.key] ?? "").join("|")}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
      setRoutingLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routingSignature]);

  // Every prompt is loaded up front rather than on expand, for two reasons the UI depends on: the
  // collapsed rows have to say how many prompts you have edited, and the search matches prompt
  // *text*, not only its name. Two dozen reads at mount, once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        AI_PROMPTS.map(async (prompt) => {
          const fallback = await loadPromptDefault(prompt);
          const value = await loadPromptValue(prompt, workspaceId, fallback);
          return [prompt.id, { value, fallback }] as const;
        }),
      );
      if (cancelled) return;
      const next = Object.fromEntries(entries);
      setPrompts(next);
      latest.current = next;
      persisted.current = Object.fromEntries(entries.map(([id, state]) => [id, state.value]));
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Blur persists, but closing Settings straight after typing does not always fire one.
  useEffect(
    () => () => {
      const current = latest.current;
      if (!current) return;
      for (const prompt of AI_PROMPTS) {
        const entry = current[prompt.id];
        if (!entry) continue;
        if (entry.value.trim() !== persisted.current[prompt.id]?.trim()) {
          void savePromptValue(prompt, workspaceId, entry.value);
        }
      }
    },
    [workspaceId],
  );

  const persistModel = async (task: string, value: string) => {
    const provider = effectiveProvider(task);
    if (value.trim()) void rememberModel(provider, value);
    await setSetting(`${provider}_${task}_model`, value);
    await refresh();
  };

  const updatePrompt = (id: string, value: string) => {
    setPrompts((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [id]: { ...prev[id], value } };
      latest.current = next;
      return next;
    });
  };

  const persistPrompt = async (prompt: PromptDef) => {
    const entry = latest.current?.[prompt.id];
    if (!entry || entry.value.trim() === persisted.current[prompt.id]?.trim()) return;
    await savePromptValue(prompt, workspaceId, entry.value);
    persisted.current[prompt.id] = entry.value.trim();
    setSavedFlash(prompt.id);
    setTimeout(() => setSavedFlash((id) => (id === prompt.id ? null : id)), 1400);
  };

  const resetPrompt = async (prompt: PromptDef) => {
    const entry = latest.current?.[prompt.id];
    if (!entry) return;
    updatePrompt(prompt.id, entry.fallback);
    await resetPromptValue(prompt, workspaceId);
    persisted.current[prompt.id] = entry.fallback.trim();
  };

  const isCustom = (prompt: PromptDef): boolean => {
    const entry = prompts?.[prompt.id];
    return !!entry && entry.value.trim() !== entry.fallback.trim();
  };

  /**
   * Which tasks survive the search box and the filter.
   *
   * A task matches on its own name or hint, and also on any of its prompts — so typing the name of
   * a prompt surfaces the task holding it rather than nothing. Which prompt matched is passed down
   * so the row can open on it.
   */
  const visible = useMemo(() => {
    const wanted = fold(query.trim());
    return AI_TASKS.map((task) => {
      const taskPrompts = promptsForTask(task.key);
      const custom = taskPrompts.filter(isCustom);
      if (onlyCustom && custom.length === 0) return null;

      if (!wanted) return { task, prompts: taskPrompts, matched: [] as PromptDef[] };

      const taskHit = fold(t(task.labelKey)).includes(wanted) || fold(t(task.hintKey)).includes(wanted);
      const matched = taskPrompts.filter(
        (prompt) =>
          fold(t(prompt.labelKey)).includes(wanted) ||
          fold(prompts?.[prompt.id]?.value ?? "").includes(wanted),
      );
      if (!taskHit && matched.length === 0) return null;
      return { task, prompts: taskPrompts, matched };
    }).filter((entry): entry is { task: AiTaskDef; prompts: PromptDef[]; matched: PromptDef[] } => entry !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, onlyCustom, prompts, t]);

  const customCount = useMemo(() => AI_PROMPTS.filter(isCustom).length, [prompts]);

  if (!routingLoaded || !prompts) {
    return (
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-8 w-full" />
        {AI_TASKS.slice(0, 8).map((task) => (
          <Skeleton key={task.key} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* ---------- what only the free chat may do ---------- */}
      <FreeChatOptions query={query} t={t} />

      {/* ---------- the toolbar ---------- */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.tasksSearchPlaceholder")}
            aria-label={t("settings.tasksSearchPlaceholder")}
            className={fieldClass({ className: "w-full pl-8 pr-7" })}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("common.clear")}
              className={iconButtonClass({ size: "xs", className: "absolute right-1 top-1/2 -translate-y-1/2" })}
            >
              <X size={13} />
            </button>
          )}
        </div>
        {/* A filter that stays on, so it wears the pressed look while it does — written out because
            the button recipe has no "on" variant, and at the field's 30px so the toolbar is one line. */}
        <button
          type="button"
          onClick={() => setOnlyCustom((was) => !was)}
          aria-pressed={onlyCustom}
          className={`inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition-[background-color,color,box-shadow] duration-100 ${
            onlyCustom
              ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]"
              : "bg-[var(--cf-surface)] text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          }`}
        >
          <SlidersHorizontal size={13} />
          {t("settings.tasksOnlyCustom")}
          <span className="tabular-nums opacity-70">{customCount}</span>
        </button>
      </div>

      {visible.length === 0 ? (
        <p className="px-3 py-6 text-center text-[13px] text-[var(--cf-text-muted)]">
          {onlyCustom && !query ? t("settings.tasksNoCustom") : t("settings.tasksNoMatch", { query })}
        </p>
      ) : (
        AI_TASK_AREAS.map((area) => {
          const rows = visible.filter((entry) => entry.task.area === area.id);
          if (rows.length === 0) return null;
          return (
            <section key={area.id} className="mb-4 last:mb-0">
              <h4 className={`mb-1.5 ${SECTION_LABEL}`}>{t(area.labelKey)}</h4>
              <div className="space-y-1.5">
                {rows.map(({ task, prompts: taskPrompts, matched }) => (
                  <TaskRow
                    key={task.key}
                    task={task}
                    prompts={taskPrompts}
                    state={prompts}
                    open={openTask === task.key}
                    onToggle={() => {
                      setOpenTask((current) => (current === task.key ? null : task.key));
                      // A search that matched inside a prompt opens straight onto it — otherwise
                      // the user is told "it's in here somewhere" and has to hunt again.
                      setOpenPrompt(matched.length > 0 ? matched[0].id : null);
                    }}
                    openPrompt={openPrompt}
                    onTogglePrompt={(id) => setOpenPrompt((current) => (current === id ? null : id))}
                    savedFlash={savedFlash}
                    workspaceId={workspaceId}
                    // routing
                    defaultProvider={defaultProvider}
                    selectedProvider={taskProviders[task.key]?.trim() ?? ""}
                    taskModels={taskModels}
                    statuses={statuses}
                    modelsByProvider={modelsByProvider}
                    choice={choice[task.key] ?? ""}
                    custom={custom[task.key] ?? ""}
                    onProvider={(value) => void setTaskProvider(task.key, value)}
                    onChoice={(value) => {
                      setChoice((prev) => ({ ...prev, [task.key]: value }));
                      if (value !== CUSTOM_MODEL) void persistModel(task.key, value);
                    }}
                    onCustom={(value) => {
                      setCustom((prev) => ({ ...prev, [task.key]: value }));
                      void persistModel(task.key, value.trim());
                    }}
                    // prompts
                    onPromptChange={updatePrompt}
                    onPromptBlur={persistPrompt}
                    onPromptReset={resetPrompt}
                    t={t}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

/**
 * What the free chat may do on its own — the Chat tab and the quick ask, the conversations that run
 * without a repository. Grouped under one row because neither switch touches anything else on this
 * screen: the assistant's chat always runs in a repository (no files to build beside it) and resumes
 * its engine's session instead of replaying the transcript (nothing to summarise). Both used to sit
 * above the task list, reading as if they governed every task below them.
 *
 * Closed, the row says which switches are on. A search that names one of them opens it, the way a
 * search that matches a prompt opens that task.
 */
function FreeChatOptions({ query, t }: { query: string; t: Translate }) {
  const fileGeneration = usePreferencesStore((s) => s.chatFileGenerationEnabled);
  const setFileGeneration = usePreferencesStore((s) => s.setChatFileGenerationEnabled);
  const autoCompact = usePreferencesStore((s) => s.chatAutoCompactEnabled);
  const setAutoCompact = usePreferencesStore((s) => s.setChatAutoCompactEnabled);
  const [expanded, setExpanded] = useState(false);

  const options = [
    {
      id: "files",
      on: fileGeneration,
      set: setFileGeneration,
      label: t("settings.chatFileGenerationLabel"),
      hint: t("settings.chatFileGenerationHint"),
      short: t("settings.freeChatFilesShort"),
    },
    {
      id: "compact",
      on: autoCompact,
      set: setAutoCompact,
      label: t("settings.chatAutoCompactLabel"),
      hint: t("settings.chatAutoCompactHint"),
      short: t("settings.freeChatCompactShort"),
    },
  ];
  const needle = fold(query.trim());
  const matched = needle !== "" && options.some((option) => fold(`${option.label} ${option.hint}`).includes(needle));
  const open = expanded || matched;
  const on = options.filter((option) => option.on);

  return (
    <div className={`mb-3 ${accordionClass(open)}`}>
      <button
        type="button"
        onClick={() => setExpanded((was) => !was)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={13} className="mt-[3px] shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={13} className="mt-[3px] shrink-0 text-[var(--cf-text-muted)]" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium leading-snug text-[var(--cf-text)]">{t("settings.freeChatTitle")}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("settings.freeChatHint")}</span>
        </span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {on.length === 0 ? (
            <span className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.freeChatNoneOn")}</span>
          ) : (
            on.map((option) => (
              <span key={option.id} className={chipClass("accent")}>
                {option.short}
              </span>
            ))
          )}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-[var(--cf-border)] px-2.5 py-2.5 pl-[29px]">
          {options.map((option) => (
            <label key={option.id} className="flex items-start gap-2 text-[13px]">
              <span className="mt-[2px]">
                <Checkbox checked={option.on} onChange={(checked) => void option.set(checked)} />
              </span>
              <span>
                {option.label}
                <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** One task: its engine, its prompts, and enough state on the closed row to not have to open it. */
function TaskRow({
  task,
  prompts,
  state,
  open,
  onToggle,
  openPrompt,
  onTogglePrompt,
  savedFlash,
  workspaceId,
  defaultProvider,
  selectedProvider,
  taskModels,
  statuses,
  modelsByProvider,
  choice,
  custom,
  onProvider,
  onChoice,
  onCustom,
  onPromptChange,
  onPromptBlur,
  onPromptReset,
  t,
}: {
  task: AiTaskDef;
  prompts: PromptDef[];
  state: Record<string, PromptState>;
  open: boolean;
  onToggle: () => void;
  openPrompt: string | null;
  onTogglePrompt: (id: string) => void;
  savedFlash: string | null;
  workspaceId: string | null;
  defaultProvider: string;
  selectedProvider: string;
  taskModels: Record<string, string>;
  statuses: Record<string, { available?: boolean } | undefined>;
  modelsByProvider: Record<string, string[]>;
  choice: string;
  custom: string;
  onProvider: (value: string) => void;
  onChoice: (value: string) => void;
  onCustom: (value: string) => void;
  onPromptChange: (id: string, value: string) => void;
  onPromptBlur: (prompt: PromptDef) => void;
  onPromptReset: (prompt: PromptDef) => void;
  t: Translate;
}) {
  const provider = selectedProvider || defaultProvider;
  const inherited = !selectedProvider;
  const broken = task.agenticOnly && !isAgenticProvider(provider);
  const options = modelOptionsFor(provider, modelsByProvider[provider] ?? []);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  const setTaskPin = useAiAccountsStore((s) => s.setTaskPin);
  const nameOf = useAccountName();
  const providerAccounts = accounts.filter((account) => account.provider === provider);
  // Named on the closed row only where there is a choice, so a single-account install reads exactly
  // as it did: "Opus · Trabajo".
  const engineLabel =
    modelRouteLabel(provider, taskModels[task.key] ?? "", t) +
    (providerAccounts.length > 0
      ? ` · ${nameOf(
          provider,
          resolveAccount({ accounts, taskPins, workspaceDefaults, providerDefaults }, provider, task.key, workspaceId),
        )}`
      : "");

  const editedCount = prompts.filter((prompt) => {
    const entry = state[prompt.id];
    return entry && entry.value.trim() !== entry.fallback.trim();
  }).length;
  const brokenContract = prompts.some((prompt) => {
    const entry = state[prompt.id];
    return entry && !contractHolds(prompt, entry.value);
  });

  const providerLabel = (id: string) => {
    const found = AI_PROVIDERS.find((entry) => entry.id === id);
    if (!found) return id;
    return found.label ?? (found.labelKey ? t(found.labelKey) : id);
  };

  return (
    <div className={accordionClass(open)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={13} className="mt-[3px] shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={13} className="mt-[3px] shrink-0 text-[var(--cf-text-muted)]" />
        )}

        <span className="min-w-0 flex-1">
          {/* Wraps. A task name is the only thing telling you whether this is the row you want. */}
          <span className="block text-[13px] font-medium leading-snug text-[var(--cf-text)]">
            {t(task.labelKey)}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {t(task.hintKey)}
          </span>
        </span>

        {/* The state of the row, readable closed. `flex-wrap` and no truncation: on a narrow
            settings pane these stack under each other rather than being cut. */}
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {brokenContract && (
            <span title={t("prompts.contractBrokenShort")} className={chipClass("warn")}>
              <AlertTriangle size={11} />
              {t("prompts.contractBrokenShort")}
            </span>
          )}
          {editedCount > 0 && (
            <span className={chipClass("accent")}>{t("settings.tasksEditedCount", { n: editedCount })}</span>
          )}
          {prompts.length === 0 && (
            <span className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.tasksNoPrompt")}</span>
          )}
          {/* Misrouted reads in red *and* with the triangle — never by colour alone. */}
          <span
            className={`flex items-center gap-1 text-[11px] ${
              broken ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"
            }`}
          >
            {broken && <AlertTriangle size={11} className="shrink-0" />}
            <ProviderGlyph providerId={provider} size={13} />
            {engineLabel}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--cf-border)] px-2.5 py-2.5">
          {/* ---------- engine ---------- */}
          <p className={`mb-1.5 ${SECTION_LABEL}`}>{t("settings.tasksEngineGroup")}</p>
          <div className="flex flex-wrap gap-1.5">
            <div className="min-w-[180px] flex-1">
              <Select
                size="sm"
                ariaLabel={t("settings.taskProviderLabel")}
                value={selectedProvider}
                onChange={onProvider}
                options={[
                  {
                    value: "",
                    label: t("settings.taskInherit", { provider: providerLabel(defaultProvider) }),
                    leading: <ProviderGlyph providerId={defaultProvider} size={13} />,
                  },
                  ...AI_PROVIDERS.filter((p) => p.available)
                    .filter((p) => !task.agenticOnly || isAgenticProvider(p.id))
                    .filter((p) => statuses[p.id]?.available !== false || p.id === selectedProvider)
                    .map((p) => ({
                      value: p.id,
                      label:
                        statuses[p.id]?.available === false
                          ? `${providerLabel(p.id)} — ${t("settings.providerMissing")}`
                          : providerLabel(p.id),
                      leading: <ProviderGlyph providerId={p.id} size={13} />,
                    })),
                ]}
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <ModelField
                size="sm"
                options={options}
                choice={choice}
                custom={custom}
                defaultLabel={t("settings.taskModelInherit")}
                customPlaceholder={customModelPlaceholder(provider, t("settings.modelIdPlaceholder"))}
                onChoice={onChoice}
                onCustom={onCustom}
              />
            </div>
            {providerAccounts.length > 0 && (
              <div className="min-w-[140px] flex-1">
                <Select
                  size="sm"
                  ariaLabel={t("accounts.pickerLabel")}
                  value={validPreference(accounts, provider, taskPins[task.key])}
                  onChange={(value) => void setTaskPin(task.key, value)}
                  options={[
                    {
                      value: "",
                      // What the row falls back to without a pin of its own: the workspace's
                      // default, then the provider's, then the system login.
                      label: t("accounts.automaticNamed", {
                        account: nameOf(
                          provider,
                          resolveAccount({ accounts, taskPins, workspaceDefaults, providerDefaults }, provider, null, workspaceId),
                        ),
                      }),
                    },
                    { value: SYSTEM_ACCOUNT, label: nameOf(provider, null) },
                    ...providerAccounts.map((account) => ({ value: account.id, label: account.label })),
                  ]}
                />
              </div>
            )}
          </div>

          {broken && (
            <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-danger)]">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              {inherited ? t("settings.taskAgenticInherited") : t("settings.taskAgenticRequired")}
            </p>
          )}

          {/* ---------- prompts ---------- */}
          {prompts.length > 0 && (
            <>
              <p className={`mb-1.5 mt-3 ${SECTION_LABEL}`}>{t("settings.tasksPromptGroup")}</p>
              <div className="space-y-1">
                {prompts.map((prompt) => (
                  <PromptRow
                    key={prompt.id}
                    prompt={prompt}
                    state={state[prompt.id]}
                    open={openPrompt === prompt.id}
                    saved={savedFlash === prompt.id}
                    hasWorkspace={workspaceId !== null}
                    onToggle={() => onTogglePrompt(prompt.id)}
                    onChange={(value) => onPromptChange(prompt.id, value)}
                    onBlur={() => onPromptBlur(prompt)}
                    onReset={() => onPromptReset(prompt)}
                    t={t}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One prompt: what it is, whether you changed it, and — open — the text plus a diff of your edit. */
function PromptRow({
  prompt,
  state,
  open,
  saved,
  hasWorkspace,
  onToggle,
  onChange,
  onBlur,
  onReset,
  t,
}: {
  prompt: PromptDef;
  state: PromptState | undefined;
  open: boolean;
  saved: boolean;
  hasWorkspace: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
  onBlur: () => void;
  onReset: () => void;
  t: Translate;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const Icon = prompt.icon;
  const custom = !!state && state.value.trim() !== state.fallback.trim();
  const contractBroken = !!state && !contractHolds(prompt, state.value);
  const unavailable = prompt.scope === "workspace" && !hasWorkspace;

  const diff = useMemo(() => {
    if (!showDiff || !state) return null;
    const lines = diffLines(state.fallback, state.value);
    return { lines: collapseUnchanged(lines), counts: countChanges(lines) };
  }, [showDiff, state]);

  return (
    <div
      className={`rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] transition-colors duration-100 ${
        open || unavailable ? "" : "hover:border-[var(--cf-border-strong)]"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        disabled={unavailable}
        className={`flex w-full items-start gap-2 px-2 py-1.5 text-left ${unavailable ? "opacity-50" : ""}`}
      >
        {/* Top-aligned, so a name that wraps keeps its icon on the first line; the nudges centre
            that first line on the 20px chips beside it. */}
        <Icon size={13} className="mt-1 shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 flex-1 py-0.5">
          <span className="block text-[12px] leading-snug text-[var(--cf-text)]">{t(prompt.labelKey)}</span>
        </span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {/* Which scope a prompt lives in changes who it affects, so it is on the closed row
              rather than inside. */}
          <span className={chipClass("neutral")}>
            {t(prompt.scope === "global" ? "prompts.scopeGlobal" : "prompts.scopeWorkspace")}
          </span>
          {contractBroken && <AlertTriangle size={12} className="text-[var(--cf-warning)]" />}
          {saved ? (
            <Check size={13} className="text-[var(--cf-success)]" />
          ) : custom ? (
            <span className={chipClass("accent")}>{t("settings.templateCustom")}</span>
          ) : null}
        </span>
      </button>

      {open && state && (
        <div className="border-t border-[var(--cf-border)] px-2 py-2">
          <p className="mb-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t(prompt.hintKey)}</p>

          {/* The contract warning sits above the field, not under it: it is the thing to read
              before typing, and a warning below a 16-row textarea is a warning off screen. */}
          {prompt.contract && (
            <p
              className={`mb-2 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug ${
                contractBroken
                  ? "bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] text-[var(--cf-warning)]"
                  : "text-[var(--cf-text-muted)]"
              }`}
            >
              <AlertTriangle size={11} className="mt-[2px] shrink-0" />
              <span>{t(contractBroken ? "prompts.contractBroken" : prompt.contract.warningKey)}</span>
            </p>
          )}

          {showDiff && diff ? (
            <div className="overflow-x-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)]">
              <div className="min-w-full font-mono text-[12px] leading-relaxed">
                {diff.lines.map((line, index) =>
                  line === null ? (
                    <div
                      key={`gap-${index}`}
                      className="border-y border-[var(--cf-border)] bg-[var(--cf-hover)] px-2 py-0.5 text-center text-[11px] text-[var(--cf-text-muted)]"
                    >
                      ⋯
                    </div>
                  ) : (
                    <div
                      key={index}
                      className={`whitespace-pre-wrap break-words px-2 ${
                        line.kind === "added"
                          ? "bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] text-[var(--cf-text)]"
                          : line.kind === "removed"
                            ? "bg-[color-mix(in_oklab,var(--cf-danger)_12%,transparent)] text-[var(--cf-text-muted)] line-through decoration-[var(--cf-danger)]/40"
                            : "text-[var(--cf-text-muted)]"
                      }`}
                    >
                      {line.text || " "}
                    </div>
                  ),
                )}
              </div>
            </div>
          ) : (
            <textarea
              value={state.value}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onBlur}
              rows={16}
              spellCheck={false}
              aria-label={t(prompt.labelKey)}
              className={fieldClass({
                size: "sm",
                className: "h-auto w-full resize-y py-1.5 font-mono leading-relaxed",
              })}
            />
          )}

          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.templateAutosave")}</span>
            <div className="flex items-center gap-1">
              {custom && (
                // Tinted while the diff stands in for the editor; the label already says which way it goes.
                <button
                  type="button"
                  onClick={() => setShowDiff((was) => !was)}
                  className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] font-medium transition-colors duration-100 ${
                    showDiff
                      ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                      : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                  }`}
                >
                  <FileDiff size={13} />
                  {showDiff
                    ? t("prompts.diffHide")
                    : t("prompts.diffShow", {
                        added: countChanges(diffLines(state.fallback, state.value)).added,
                      })}
                </button>
              )}
              {custom && (
                <button
                  type="button"
                  onClick={() => {
                    setShowDiff(false);
                    onReset();
                  }}
                  className={buttonClass({ variant: "ghost", size: "sm" })}
                >
                  <RotateCcw size={13} />
                  {t("settings.templateReset")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
