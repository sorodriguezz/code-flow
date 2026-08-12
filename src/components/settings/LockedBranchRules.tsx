import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Lock, LockOpen, Plus, RotateCcw, TriangleAlert, X } from "lucide-react";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useRepoStore } from "../../state/repoStore";
import { defaultLockedBranchRules } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { riseDelay } from "../../lib/rise";
import { Note, Tag } from "../api/settingsChrome";
import {
  lockRuleCoverage,
  matchesLockPattern,
  normalizeLockRules,
  sameLockRule,
  splitLockPatterns,
} from "../../lib/lockedBranchRules";
import type { BranchInfo } from "../../types/domain";

/**
 * The branches that come locked in every repository, without anyone having clicked a padlock.
 *
 * This lives in settings rather than beside the padlock because it is the one part of the feature
 * that isn't about a branch: "nothing merges into main" is true of every repository the user will
 * ever open, and a per-branch switch makes them re-assert it on each one, from memory, before the
 * first mistake rather than after it. The padlock keeps its job — the exception to this list, in
 * both directions — which is why nothing here can lock a branch you have deliberately opened.
 *
 * ## Why it is a list of rows rather than a cloud of chips
 *
 * A pattern on its own is an abstraction, and the screen used to show nothing but the pattern. The
 * question people actually have is "does this cover the branch I care about" — so each row carries
 * what the rule is doing *right now* in the repository that is open: how many of its branches it
 * covers, and how many of those have had their padlock opened by hand anyway. A chip has no room for
 * any of that.
 *
 * Matching is done here (see `lib/lockedBranchRules`) rather than asked of the backend, because the
 * preview has to keep up with a caret in a text box. The backend stays the authority: what a row
 * reports is cross-checked against the `is_locked` / `locked_by_rule` flags `list_branches` already
 * returns for the open repository.
 */
export function LockedBranchRules() {
  const t = useT();
  const rules = usePreferencesStore((s) => s.lockedBranchRules);
  const setRules = usePreferencesStore((s) => s.setLockedBranchRules);
  const restore = usePreferencesStore((s) => s.restoreLockedBranchRules);
  const reload = usePreferencesStore((s) => s.reloadLockedBranchRules);
  // The open repository's branches, for the match counts. Reading them is free and has no side
  // effects: this panel is a modal sibling of the repo view, so the list is whatever the view
  // already loaded, and it is `[]` when no repository is open.
  const branches = useRepoStore((s) => s.branches);
  const repoPath = useRepoStore((s) => s.repoPath);
  const [draft, setDraft] = useState("");
  /** The shipped list, so "default" / "yours" and the quick-add chips name the real defaults rather
   *  than a copy of them that drifts. `null` means the read failed — the badges and chips are then
   *  simply absent, because guessing which rules are defaults would be worse than not saying. */
  const [defaults, setDefaults] = useState<string[] | null>(null);

  // A `null` list is normally the read having failed, but it is also what the store holds for the
  // moment between mount and `init()` resolving. Asking again on mount collapses the two: whichever
  // it was, this is what turns it into a list.
  useEffect(() => {
    if (usePreferencesStore.getState().lockedBranchRules === null) {
      void reload().catch(() => {});
    }
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    void defaultLockedBranchRules()
      .then((list) => {
        if (!cancelled) setDefaults(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: string[]) => {
    try {
      await setRules(next);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  /** Edits are computed from the store as it is *now*, not from the render that drew the row: two
   * removals clicked before the first save comes back would otherwise both start from the same
   * snapshot and the second would put the first one's row back. */
  const edit = (change: (current: string[]) => string[]) => {
    const current = usePreferencesStore.getState().lockedBranchRules;
    if (current === null) return;
    void save(change(current));
  };

  const localBranches = useMemo(() => branches.filter((b) => !b.is_remote), [branches]);
  const hasRepo = repoPath !== null && localBranches.length > 0;
  const repoName = repoPath?.split(/[/\\]/).filter(Boolean).pop() ?? "";

  /**
   * Every rule's coverage, in one pass.
   *
   * Memoised on both inputs because `branches` is a fresh array on every filesystem-watcher tick and
   * after every rule write — recomputing rules × branches on each of those would be work nobody
   * asked for, on a screen that is idle.
   */
  const coverage = useMemo(() => {
    const list = rules ?? [];
    return new Map(list.map((rule) => [rule, lockRuleCoverage(rule, localBranches)]));
  }, [rules, localBranches]);

  /** How many local branches are covered by *any* rule — the header's one-line summary. Counted over
   *  branches rather than summed over rules, so a branch two rules match is still one branch. */
  const coveredCount = useMemo(() => {
    const list = rules ?? [];
    return localBranches.filter((b) => list.some((rule) => matchesLockPattern(rule, b.name))).length;
  }, [rules, localBranches]);

  // ---------------------------------------------------------------------------
  // The composer
  // ---------------------------------------------------------------------------

  const patterns = splitLockPatterns(draft);
  const duplicate =
    rules !== null && patterns.length > 0 && patterns.every((p) => rules.some((r) => sameLockRule(r, p)));
  const addable = patterns.length > 0 && !duplicate;

  const add = () => {
    if (!addable) return;
    edit((current) => normalizeLockRules([...current, ...patterns]));
    // Cleared only once the edit has been accepted — it used to be cleared first, so a duplicate
    // ate what the user typed and said nothing.
    setDraft("");
  };

  const missingDefaults = (defaults ?? []).filter(
    (d) => rules !== null && !rules.some((r) => sameLockRule(r, d)),
  );

  // `null` is "we don't know what the rules are", not "there are none" — so nothing here offers to
  // save a list, which at this point could only be a list built on top of a blank the backend never
  // agreed to. The rules themselves are still being enforced; it's only this screen that is in the
  // dark, and the way out is to ask again.
  if (rules === null) {
    return (
      <Frame>
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          <div className="flex items-start justify-between gap-3 bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
            <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("settings.lockedBranchesUnavailable")}
            </p>
            <button
              type="button"
              onClick={() => void reload().catch((e) => pushErrorToast(String(e)))}
              className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
            >
              <RotateCcw size={11} />
              {t("settings.lockedBranchesReload")}
            </button>
          </div>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
        {/* A literal tint rather than --cf-surface-raised: that var equals --cf-surface in the light
            theme, so the band would only be visible in dark mode. */}
        <div className="border-b border-[var(--cf-border)] bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
          <div className="flex items-center justify-between gap-3">
            <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium">
              <Lock size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
              {t("settings.lockedBranchesRulesLabel")}
              <span className="shrink-0 rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-normal tabular-nums text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
                {rules.length}
              </span>
            </p>
            {/* Asked first, like the review engine's reset and unlike the prompt templates': this one
                discards a list the user typed, and there is nothing to undo it with. The confirm
                names the list it is about to write, fetched rather than spelled out in the copy —
                the defaults live in one place, in Rust, and a sentence repeating them drifts. */}
            <button
              type="button"
              onClick={async () => {
                const shipped = defaults ?? (await defaultLockedBranchRules().catch(() => null));
                if (shipped === null) {
                  pushErrorToast(t("settings.lockedBranchesUnavailable"));
                  return;
                }
                const confirmed = await confirmAction(
                  t("settings.lockedBranchesRestoreConfirm", { patterns: shipped.join(", ") }),
                  true,
                  t("settings.lockedBranchesRestore"),
                );
                if (!confirmed) return;
                await restore().catch((e) => pushErrorToast(String(e)));
              }}
              className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
            >
              <RotateCcw size={11} />
              {t("settings.lockedBranchesRestore")}
            </button>
          </div>
          <p className="mt-0.5 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
            {hasRepo
              ? t("settings.lockedBranchesCovered", {
                  n: coveredCount,
                  m: localBranches.length,
                  repo: repoName,
                })
              : t("settings.lockedBranchesNoRepo")}
          </p>
        </div>

        {rules.length > 0 ? (
          <ul className="divide-y divide-[var(--cf-border)]">
            {rules.map((rule, at) => (
              <RuleRow
                key={rule}
                rule={rule}
                at={at}
                coverage={coverage.get(rule)}
                hasRepo={hasRepo}
                kind={defaults === null ? null : defaults.some((d) => sameLockRule(d, rule)) ? "default" : "custom"}
                onRemove={() => edit((current) => current.filter((r) => r !== rule))}
              />
            ))}
          </ul>
        ) : (
          // Worth saying out loud: an empty list is a supported answer that survives a restart, and
          // "no rows" on its own is indistinguishable from a list that failed to load.
          <div className="px-3 py-2.5">
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              <LockOpen size={12} className="mt-[1px] shrink-0" />
              {t("settings.lockedBranchesEmpty")}
            </p>
            {missingDefaults.length > 0 && (
              <div className="mt-2">
                <p className="mb-1.5 text-[11px] text-[var(--cf-text-muted)]">
                  {t("settings.lockedBranchesMissingDefaults")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {missingDefaults.map((pattern) => (
                    <QuickAdd
                      key={pattern}
                      pattern={pattern}
                      label={t("settings.lockedBranchesAddDefault", { pattern })}
                      onClick={() => edit((current) => normalizeLockRules([...current, pattern]))}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* The composer, in a band of its own: on a list of rows a bare input floating underneath
            read as another row rather than as the way to add one. */}
        <div className="border-t border-[var(--cf-border)] bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
          <div className="flex gap-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                add();
              }}
              aria-label={t("settings.lockedBranchesInputLabel")}
              placeholder={t("settings.lockedBranchesPlaceholder")}
              className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-[var(--cf-accent)]"
            />
            <button
              type="button"
              onClick={add}
              disabled={!addable}
              className="rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] disabled:opacity-40 dark:hover:bg-white/[0.04]"
            >
              {t("settings.add")}
            </button>
          </div>
          {/* One live line rather than four static ones: while the box is empty there is nothing to
              say, and the legend below already explains the language. */}
          <p aria-live="polite" className="mt-1 min-h-[15px] text-[11px] leading-snug">
            <DraftFeedback
              patterns={patterns}
              duplicate={duplicate}
              hasRepo={hasRepo}
              branches={localBranches}
              t={t}
            />
          </p>
        </div>
      </div>

      {/* The pattern language, as four things you can look at rather than one paragraph to parse. */}
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        <LegendItem token="*" text={t("settings.lockedBranchesLegendStar")} />
        <LegendItem token="?" text={t("settings.lockedBranchesLegendQuestion")} />
        <LegendItem token="ab" text={t("settings.lockedBranchesLegendExact")} />
        <LegendItem token="Aa" text={t("settings.lockedBranchesLegendCase")} />
      </div>

      <div className="mt-2">
        <Note>{t("settings.lockedBranchesBlocks")}</Note>
        <Note>{t("settings.lockedBranchesOverride")}</Note>
        <Note>{t("settings.lockedBranchesLocalOnly")}</Note>
      </div>
    </Frame>
  );
}

/** The heading and description, shared by the loaded and the unknown state so the section reads the
 *  same either way — the only difference being what the card can honestly show. */
function Frame({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
      <h4 className="text-[13px] font-medium">{t("settings.lockedBranchesTitle")}</h4>
      <p className="mb-2 mt-0.5 text-[13px] text-[var(--cf-text-muted)]">
        {t("settings.lockedBranchesDescription")}
      </p>
      {children}
    </div>
  );
}

/**
 * One rule, and what it is doing in the repository that is open.
 *
 * The count is omitted entirely when there is no repository, rather than shown as "none here": with
 * no branches to match against, "none" is a sentence shaped exactly like the truthful case and it
 * would be a lie.
 */
function RuleRow({
  rule,
  at,
  coverage,
  hasRepo,
  kind,
  onRemove,
}: {
  rule: string;
  at: number;
  coverage: { covered: BranchInfo[]; exempt: BranchInfo[] } | undefined;
  hasRepo: boolean;
  kind: "default" | "custom" | null;
  onRemove: () => void;
}) {
  const t = useT();
  const covered = coverage?.covered ?? [];
  const exempt = coverage?.exempt ?? [];
  const names = (list: BranchInfo[]) => list.map((b) => b.name).join(", ");

  return (
    <li style={riseDelay(at)} className="cf-rise flex items-center gap-2 px-3 py-2">
      <Lock size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={rule}>
        {rule}
      </span>
      {kind !== null && (
        <Tag tone={kind === "default" ? "muted" : "accent"}>
          {t(kind === "default" ? "settings.lockedBranchesKindDefault" : "settings.lockedBranchesKindCustom")}
        </Tag>
      )}
      {hasRepo && (
        <span
          className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]"
          title={
            covered.length > 0
              ? t("settings.lockedBranchesRowMatchList", { names: names(covered) })
              : undefined
          }
        >
          {covered.length > 0
            ? t("settings.lockedBranchesRowMatches", { n: covered.length })
            : t("settings.lockedBranchesRowNoMatches")}
        </span>
      )}
      {hasRepo && exempt.length > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-[var(--cf-warning)]"
          title={t("settings.lockedBranchesRowExemptList", { names: names(exempt) })}
        >
          <TriangleAlert size={11} />
          {t("settings.lockedBranchesRowExempt", { n: exempt.length })}
        </span>
      )}
      <button
        type="button"
        title={t("settings.lockedBranchesRemove", { pattern: rule })}
        aria-label={t("settings.lockedBranchesRemove", { pattern: rule })}
        onClick={onRemove}
        className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.06]"
      >
        <X size={12} />
      </button>
    </li>
  );
}

/** What the typed pattern would do, live. Nothing while the box is empty. */
function DraftFeedback({
  patterns,
  duplicate,
  hasRepo,
  branches,
  t,
}: {
  patterns: string[];
  duplicate: boolean;
  hasRepo: boolean;
  branches: BranchInfo[];
  t: ReturnType<typeof useT>;
}) {
  if (patterns.length === 0) return null;
  if (duplicate) {
    return (
      <span className="text-[var(--cf-warning)]">
        {t("settings.lockedBranchesDuplicate", { pattern: patterns[0] })}
      </span>
    );
  }
  // A lone `*` locks every local branch in every repository, which is a legitimate choice and a
  // drastic one — so it is said out loud, and Add stays enabled.
  if (patterns.some((p) => p.trim() === "*")) {
    return <span className="text-[var(--cf-warning)]">{t("settings.lockedBranchesCoversAll")}</span>;
  }
  if (patterns.length > 1) {
    return (
      <span className="text-[var(--cf-text-muted)]">
        {t("settings.lockedBranchesWillAddMany", { n: patterns.length })}
      </span>
    );
  }
  if (!hasRepo) return null;
  const covered = branches.filter((b) => matchesLockPattern(patterns[0], b.name));
  return (
    <span className="text-[var(--cf-text-muted)]">
      {covered.length > 0
        ? t("settings.lockedBranchesWouldCover", {
            n: covered.length,
            names: covered.map((b) => b.name).join(", "),
          })
        : t("settings.lockedBranchesMatchesNothingHere")}
    </span>
  );
}

/** A default that isn't in the list, as one click to put it back — the non-destructive half of
 *  "restore defaults", which replaces everything. */
function QuickAdd({
  pattern,
  label,
  onClick,
}: {
  pattern: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex max-w-full items-center gap-1 truncate rounded-full border border-[var(--cf-border)] px-2.5 py-1 font-mono text-[11px] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
    >
      <Plus size={10} className="shrink-0" />
      {pattern}
    </button>
  );
}

/** One line of the pattern legend: the token as it is typed, then what it does. */
function LegendItem({ token, text }: { token: string; text: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <code className="shrink-0 rounded bg-black/[0.05] px-1 font-mono text-[10px] text-[var(--cf-text)] dark:bg-white/[0.08]">
        {token}
      </code>
      <span>{text}</span>
    </span>
  );
}
