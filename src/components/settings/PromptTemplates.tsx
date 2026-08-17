import { useEffect, useRef, useState } from "react";
import {
  Bug,
  Calculator,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  FileCode2,
  FileText,
  FlaskConical,
  Gauge,
  GitCommit,
  GitMerge,
  Glasses,
  ListChecks,
  Network,
  Split,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  defaultAnalyzeTemplate,
  defaultCommitTemplate,
  defaultResolveConflictTemplate,
  defaultWorkspacePrompt,
  getSetting,
  getWorkspacePrompt,
  setSetting,
  setWorkspacePrompt,
} from "../../lib/tauri/commands";
import { modelRouteLabel } from "../ai/ModelTag";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Skeleton } from "../common/Skeleton";

interface TemplateDef {
  /** Settings key holding the user's version. */
  key: string;
  /** Pre-rename key, read as a fallback so an old customization survives. */
  legacy: string;
  /** The `AiTask` this template feeds — used to show which engine will actually run it. */
  task: string;
  icon: LucideIcon;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
  rows: number;
  loadDefault: () => Promise<string>;
}

/** Every customizable prompt, including the two (PR description, conflict resolution) the backend
 * has always supported but that had no UI. Order matches the task list above them. */
const TEMPLATES: TemplateDef[] = [
  {
    key: "commit_template",
    legacy: "claude_commit_template",
    task: "commit",
    icon: GitCommit,
    labelKey: "task.commit",
    hintKey: "settings.commitTemplateHint",
    rows: 5,
    loadDefault: defaultCommitTemplate,
  },
  {
    key: "analyze_template",
    legacy: "claude_analyze_template",
    task: "analyze",
    icon: ScanSearch,
    labelKey: "task.analyze",
    hintKey: "settings.analyzeTemplateHint",
    rows: 10,
    loadDefault: defaultAnalyzeTemplate,
  },
  {
    key: "resolve_conflict_template",
    legacy: "claude_resolve_conflict_template",
    task: "conflict",
    icon: GitMerge,
    labelKey: "task.conflict",
    hintKey: "settings.conflictTemplateHint",
    rows: 8,
    loadDefault: defaultResolveConflictTemplate,
  },
];

interface WorkspacePromptDef {
  kind: string;
  /** The `AiTask` whose routing runs it — the row's second line names that engine. Two prompts in
   *  one group can differ here: writing stories and checking them against code are not the same
   *  job, and a team routinely points them at different models. */
  task: string;
  icon: LucideIcon;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}

/**
 * The per-workspace prompts, grouped by the tab of the stories section that runs them.
 *
 * Separate from `TEMPLATES` because they are stored per *workspace* rather than globally: how a
 * team writes acceptance criteria is a property of that team's backlog, not of this installation,
 * and two workspaces on one machine routinely disagree about it.
 *
 * They are here rather than only in the screens that run them because this is where somebody goes
 * when the output came out wrong. The defaults describe one way of working — Gherkin or a
 * checklist, a five-step QA ladder, a documentation page with eleven fixed sections — and a team
 * whose process differs should be changing the instruction rather than fighting its output card by
 * card.
 */
const WORKSPACE_PROMPT_GROUPS: {
  titleKey: TranslationKey;
  hintKey: TranslationKey;
  prompts: WorkspacePromptDef[];
}[] = [
  {
    titleKey: "settings.storyPromptsTitle",
    hintKey: "settings.storyPromptsHint",
    prompts: [
      {
        kind: "user_stories",
        task: "stories",
        icon: ClipboardList,
        labelKey: "settings.sPromptStories",
        hintKey: "settings.sPromptStoriesHint",
      },
      {
        kind: "story_verify",
        task: "story_verify",
        icon: ShieldCheck,
        labelKey: "settings.sPromptVerify",
        hintKey: "settings.sPromptVerifyHint",
      },
    ],
  },
  {
    titleKey: "settings.prReviewPromptsTitle",
    hintKey: "settings.prReviewPromptsHint",
    prompts: [
      {
        kind: "review_lenses",
        task: "review",
        icon: Glasses,
        labelKey: "settings.prPromptLenses",
        hintKey: "settings.prPromptLensesHint",
      },
      {
        kind: "review_level_basico",
        task: "review",
        icon: Gauge,
        labelKey: "settings.prPromptLevelBasico",
        hintKey: "settings.prPromptLevelHint",
      },
      {
        kind: "review_level_completo",
        task: "review",
        icon: Gauge,
        labelKey: "settings.prPromptLevelCompleto",
        hintKey: "settings.prPromptLevelHint",
      },
      {
        kind: "review_level_ultra",
        task: "review",
        icon: Gauge,
        labelKey: "settings.prPromptLevelUltra",
        hintKey: "settings.prPromptLevelHint",
      },
      {
        kind: "review_worker",
        task: "review",
        icon: Users,
        labelKey: "settings.prPromptWorker",
        hintKey: "settings.prPromptWorkerHint",
      },
      {
        kind: "review_crossfile",
        task: "review",
        icon: Split,
        labelKey: "settings.prPromptCrossfile",
        hintKey: "settings.prPromptCrossfileHint",
      },
      {
        kind: "review_summary",
        task: "review",
        icon: FileText,
        labelKey: "settings.prPromptSummary",
        hintKey: "settings.prPromptSummaryHint",
      },
    ],
  },
  {
    titleKey: "settings.reviewPromptsTitle",
    hintKey: "settings.reviewPromptsHint",
    prompts: [
      {
        kind: "work_item_analyze",
        task: "work_item_review",
        icon: ScanSearch,
        labelKey: "settings.wiPromptAnalyze",
        hintKey: "settings.wiPromptAnalyzeHint",
      },
      {
        kind: "work_item_bug_analyze",
        task: "work_item_review",
        icon: Bug,
        labelKey: "settings.wiPromptBugAnalyze",
        hintKey: "settings.wiPromptBugAnalyzeHint",
      },
      {
        kind: "work_item_description",
        task: "work_item_review",
        icon: FileText,
        labelKey: "settings.wiPromptDescription",
        hintKey: "settings.wiPromptDescriptionHint",
      },
      {
        kind: "work_item_criteria",
        task: "work_item_review",
        icon: ListChecks,
        labelKey: "settings.wiPromptCriteria",
        hintKey: "settings.wiPromptCriteriaHint",
      },
      {
        kind: "work_item_tasks",
        task: "work_item_review",
        icon: ClipboardCheck,
        labelKey: "settings.wiPromptTasks",
        hintKey: "settings.wiPromptTasksHint",
      },
      {
        kind: "work_item_tasks_qa",
        task: "work_item_review",
        icon: FlaskConical,
        labelKey: "settings.wiPromptTasksQa",
        hintKey: "settings.wiPromptTasksQaHint",
      },
      // Not a prompt of its own — the hours the row above estimates with, spliced into it at
      // `{{ESTIMACION_QA}}`. Its own row because recalibrating a table against the team's closed
      // tasks is a different act, and a different rhythm, from rewriting how the ladder is worded.
      {
        kind: "work_item_qa_estimation",
        task: "work_item_review",
        icon: Calculator,
        labelKey: "settings.wiPromptQaEstimation",
        hintKey: "settings.wiPromptQaEstimationHint",
      },
    ],
  },
  {
    titleKey: "settings.wikiPromptsTitle",
    hintKey: "settings.wikiPromptsHint",
    prompts: [
      {
        kind: "repo_doc",
        task: "wiki",
        icon: FileCode2,
        labelKey: "settings.wikiPromptRepo",
        hintKey: "settings.wikiPromptRepoHint",
      },
      {
        kind: "workspace_doc",
        task: "wiki",
        icon: Network,
        labelKey: "settings.wikiPromptWorkspace",
        hintKey: "settings.wikiPromptWorkspaceHint",
      },
    ],
  },
];

interface Loaded {
  /** What's in the editor. */
  value: string;
  /** The built-in text, for the "customized?" comparison and the reset action. */
  fallback: string;
}

/** The shared shell of a template row: the summary line, its state chip, and the body it folds. */
function TemplateRow({
  icon: Icon,
  label,
  sublabel,
  sublabelProvider,
  custom,
  saved,
  open,
  onToggle,
  children,
}: {
  icon: LucideIcon;
  label: string;
  /** "Claude Code · Opus 5" — which engine current routing sends this template to. */
  sublabel: string;
  /** That engine's provider id, so the line can carry its mark. Separate from `sublabel` because
   *  the label is a sentence and the glyph is not part of it. */
  sublabelProvider?: string;
  custom: boolean;
  saved: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="rounded-lg border border-[var(--cf-border)]">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 p-2.5 text-left">
        <ChevronDown
          size={14}
          className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <Icon size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-[var(--cf-text)]">{label}</span>
          <span className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
            {sublabelProvider && <ProviderGlyph providerId={sublabelProvider} size={11} />}
            <span className="min-w-0 truncate">{sublabel}</span>
          </span>
        </span>
        {saved ? (
          <span className="shrink-0 text-[10px] font-medium text-[var(--cf-success)]">{t("settings.saved")}</span>
        ) : custom ? (
          <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--cf-accent)]">
            {t("settings.templateCustom")}
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] font-medium text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
            {t("settings.templateDefault")}
          </span>
        )}
      </button>
      {open && <div className="border-t border-[var(--cf-border)] p-3">{children}</div>}
    </div>
  );
}

/**
 * One per-workspace prompt, in the same row as the global ones.
 *
 * Its own loader rather than a shared one, because a workspace prompt has a different lifetime:
 * switching workspace has to re-read it, and an unsaved edit has to be flushed before that read
 * lands on top of it. Autosaves on blur like everything else on this screen.
 */
function WorkspacePromptRow({
  kind,
  icon,
  label,
  hint,
  engine,
  engineProvider,
}: {
  kind: string;
  icon: LucideIcon;
  label: string;
  hint: string;
  engine: string;
  engineProvider: string;
}) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [value, setValue] = useState<string | null>(null);
  const [fallback, setFallback] = useState("");
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const latest = useRef<string | null>(null);
  const persisted = useRef("");

  useEffect(() => {
    let cancelled = false;
    if (!workspaceId) {
      setValue(null);
      return;
    }
    void (async () => {
      const [content, def] = await Promise.all([
        getWorkspacePrompt(workspaceId, kind).catch(() => null),
        defaultWorkspacePrompt(kind).catch(() => ""),
      ]);
      if (cancelled) return;
      const resolved = content ?? def;
      setFallback(def);
      setValue(resolved);
      latest.current = resolved;
      persisted.current = resolved;
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, kind]);

  // Closing Settings right after typing wouldn't always fire a blur — flush anything unsaved.
  useEffect(
    () => () => {
      if (!workspaceId) return;
      const current = latest.current;
      if (current !== null && current.trim() !== persisted.current.trim()) {
        void setWorkspacePrompt(workspaceId, kind, current.trim());
      }
    },
    [workspaceId, kind],
  );

  const persist = async () => {
    const current = latest.current;
    if (!workspaceId || current === null || current.trim() === persisted.current.trim()) return;
    await setWorkspacePrompt(workspaceId, kind, current.trim());
    persisted.current = current.trim();
    setSaved(true);
    setTimeout(() => setSaved(false), 1400);
  };

  const reset = async () => {
    if (!workspaceId) return;
    setValue(fallback);
    latest.current = fallback;
    // Blanked rather than overwritten with the default text: an empty override is what makes the
    // backend fall back, so a later change to the built-in prompt still reaches this workspace.
    await setWorkspacePrompt(workspaceId, kind, "");
    persisted.current = fallback.trim();
  };

  const custom = value !== null && value.trim() !== fallback.trim();

  return (
    <TemplateRow
      icon={icon}
      label={label}
      sublabel={engine}
      sublabelProvider={engineProvider}
      custom={custom}
      saved={saved}
      open={open}
      onToggle={() => setOpen((was) => !was)}
    >
      <p className="mb-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>
      {!workspaceId ? (
        <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.reviewSelectWorkspace")}</p>
      ) : value === null ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              latest.current = e.target.value;
            }}
            onBlur={() => void persist()}
            rows={16}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10.5px] text-[var(--cf-text-muted)]">{t("settings.templateAutosave")}</span>
            {custom && (
              <button
                onClick={() => void reset()}
                className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
              >
                <RotateCcw size={11} />
                {t("settings.templateReset")}
              </button>
            )}
          </div>
        </>
      )}
    </TemplateRow>
  );
}

/**
 * The prompt each AI action sends. Rewritten from a flat list of identical-looking rows into
 * something you can actually read at a glance: every row says whether it's still the built-in
 * prompt or one you've edited, and which engine will run it (which per-task routing made
 * non-obvious). Edits save on blur, like the rest of this screen — no Save button to forget.
 */
export function PromptTemplates() {
  const t = useT();
  const taskProviders = useAiProviderStore((s) => s.taskProviders);
  const taskModels = useAiProviderStore((s) => s.taskModels);
  const defaultProvider = useAiProviderStore((s) => s.providerId);

  const [loaded, setLoaded] = useState<Record<string, Loaded> | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  // Mirrors `loaded` for the unmount flush — reading state directly in the cleanup would capture
  // the value from the render that registered it, i.e. before the user's last keystrokes.
  const latest = useRef<Record<string, Loaded> | null>(null);
  const persisted = useRef<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        TEMPLATES.map(async (tpl) => {
          const [stored, legacy, fallback] = await Promise.all([
            getSetting(tpl.key).catch(() => null),
            getSetting(tpl.legacy).catch(() => null),
            tpl.loadDefault().catch(() => ""),
          ]);
          const value = (stored?.trim() ? stored : legacy?.trim() ? legacy : fallback) ?? fallback;
          return [tpl.key, { value, fallback }] as const;
        }),
      );
      if (cancelled) return;
      const next = Object.fromEntries(entries);
      setLoaded(next);
      latest.current = next;
      persisted.current = Object.fromEntries(entries.map(([key, v]) => [key, v.value]));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Blur normally persists, but closing Settings straight after typing wouldn't always fire one —
  // flush anything still unsaved on the way out.
  useEffect(
    () => () => {
      const current = latest.current;
      if (!current) return;
      for (const [key, entry] of Object.entries(current)) {
        if (entry.value.trim() !== persisted.current[key]?.trim()) {
          void setSetting(key, entry.value.trim());
        }
      }
    },
    [],
  );

  const update = (key: string, value: string) => {
    setLoaded((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: { ...prev[key], value } };
      latest.current = next;
      return next;
    });
  };

  const persist = async (key: string) => {
    const entry = latest.current?.[key];
    if (!entry || entry.value.trim() === persisted.current[key]?.trim()) return;
    await setSetting(key, entry.value.trim());
    persisted.current[key] = entry.value.trim();
    setSavedFlash(key);
    setTimeout(() => setSavedFlash((k) => (k === key ? null : k)), 1400);
  };

  const reset = async (tpl: TemplateDef) => {
    const entry = latest.current?.[tpl.key];
    if (!entry) return;
    update(tpl.key, entry.fallback);
    await setSetting(tpl.key, "");
    persisted.current[tpl.key] = entry.fallback.trim();
  };

  /** "Claude Code · Opus 5" for the engine that will run this template, per current routing. Not
   * the hook, because this is called once per template inside a map. */
  const engineFor = (task: string) =>
    modelRouteLabel(taskProviders[task]?.trim() || defaultProvider, taskModels[task] ?? "", t);
  /** The same routing decision as `engineFor`, as the id its mark is looked up by. */
  const providerFor = (task: string) => taskProviders[task]?.trim() || defaultProvider;

  if (!loaded) {
    return (
      <div className="space-y-2" aria-hidden>
        {TEMPLATES.map((tpl) => (
          <Skeleton key={tpl.key} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {TEMPLATES.map((tpl) => {
        const entry = loaded[tpl.key];
        const isCustom = entry.value.trim() !== entry.fallback.trim();
        const isOpen = expanded === tpl.key;

        return (
          <TemplateRow
            key={tpl.key}
            icon={tpl.icon}
            label={t(tpl.labelKey)}
            sublabel={engineFor(tpl.task)}
            sublabelProvider={providerFor(tpl.task)}
            custom={isCustom}
            saved={savedFlash === tpl.key}
            open={isOpen}
            onToggle={() => setExpanded(isOpen ? null : tpl.key)}
          >
            {
              <>
                <p className="mb-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t(tpl.hintKey)}</p>
                <textarea
                  value={entry.value}
                  onChange={(e) => update(tpl.key, e.target.value)}
                  onBlur={() => void persist(tpl.key)}
                  rows={tpl.rows}
                  spellCheck={false}
                  className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
                />
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[10.5px] text-[var(--cf-text-muted)]">
                    {t("settings.templateAutosave")}
                  </span>
                  {isCustom && (
                    <button
                      onClick={() => void reset(tpl)}
                      className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                    >
                      <RotateCcw size={11} />
                      {t("settings.templateReset")}
                    </button>
                  )}
                </div>
              </>
            }
          </TemplateRow>
        );
      })}

      {/* Per workspace, and said so: the rows above apply to this installation, and these to the
          backlog of whichever workspace is open. Without the line saying which, a team that
          rewrote its criteria prompt and then switched workspace would find it gone. */}
      {WORKSPACE_PROMPT_GROUPS.map((group) => (
        <div key={group.titleKey} className="pt-3">
          <h4 className="text-[12.5px] font-semibold text-[var(--cf-text)]">{t(group.titleKey)}</h4>
          <p className="mb-2 mt-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t(group.hintKey)}</p>
          <div className="space-y-2">
            {group.prompts.map((prompt) => (
              <WorkspacePromptRow
                key={prompt.kind}
                kind={prompt.kind}
                icon={prompt.icon}
                label={t(prompt.labelKey)}
                hint={t(prompt.hintKey)}
                engine={engineFor(prompt.task)}
                engineProvider={providerFor(prompt.task)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
