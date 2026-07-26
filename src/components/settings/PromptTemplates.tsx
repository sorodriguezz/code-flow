import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  GitCommit,
  GitMerge,
  GitPullRequest,
  RotateCcw,
  ScanSearch,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import {
  defaultAnalyzeTemplate,
  defaultCommitTemplate,
  defaultPrDescriptionTemplate,
  defaultResolveConflictTemplate,
  defaultReviewTemplate,
  getSetting,
  setSetting,
} from "../../lib/tauri/commands";
import { AI_PROVIDERS, modelDisplayLabel } from "../../lib/aiProviders";
import { useAiProviderStore } from "../../state/aiProviderStore";
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
    key: "review_template",
    legacy: "claude_review_template",
    task: "review",
    icon: GitPullRequest,
    labelKey: "task.review",
    hintKey: "settings.reviewTemplateHint",
    rows: 10,
    loadDefault: defaultReviewTemplate,
  },
  {
    key: "pr_description_template",
    legacy: "claude_pr_description_template",
    task: "pr_description",
    icon: SquarePen,
    labelKey: "task.prDescription",
    hintKey: "settings.prDescriptionTemplateHint",
    rows: 8,
    loadDefault: defaultPrDescriptionTemplate,
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

interface Loaded {
  /** What's in the editor. */
  value: string;
  /** The built-in text, for the "customized?" comparison and the reset action. */
  fallback: string;
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

  /** "Claude Code · Opus 5" for the engine that will run this template, per current routing. */
  const engineFor = (task: string) => {
    const providerId = taskProviders[task]?.trim() || defaultProvider;
    const provider = AI_PROVIDERS.find((p) => p.id === providerId);
    const label = provider ? (provider.label ?? (provider.labelKey ? t(provider.labelKey) : providerId)) : providerId;
    return `${label} · ${modelDisplayLabel(providerId, taskModels[task] ?? "", t)}`;
  };

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
        const Icon = tpl.icon;

        return (
          <div key={tpl.key} className="rounded-lg border border-[var(--cf-border)]">
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : tpl.key)}
              className="flex w-full items-center gap-2 p-2.5 text-left"
            >
              <ChevronDown
                size={14}
                className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${isOpen ? "" : "-rotate-90"}`}
              />
              <Icon size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-[var(--cf-text)]">
                  {t(tpl.labelKey)}
                </span>
                <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{engineFor(tpl.task)}</span>
              </span>
              {savedFlash === tpl.key ? (
                <span className="shrink-0 text-[10px] font-medium text-[var(--cf-success)]">
                  {t("settings.saved")}
                </span>
              ) : isCustom ? (
                <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--cf-accent)]">
                  {t("settings.templateCustom")}
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] font-medium text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
                  {t("settings.templateDefault")}
                </span>
              )}
            </button>

            {isOpen && (
              <div className="border-t border-[var(--cf-border)] p-3">
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
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
