import { useMemo } from "react";
import {
  ArrowLeft,
  CircleAlert,
  ClipboardCheck,
  Copy,
  ExternalLink,
  ListChecks,
  Plus,
  ScanSearch,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { CARD } from "../api/panelChrome";
import { Select } from "../common/Select";
import { useWorkItemReviewStore } from "../../state/workItemReviewStore";
import { useT } from "../../state/languageStore";
import { useActiveProjects } from "../../state/workspaceStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import type { ProposedTask, ReviewFinding, StorySection, WorkItemReviewStage } from "../../types/domain";

const FIELD =
  "w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]";

const SEVERITY: Record<ReviewFinding["severity"], string> = {
  alta: "text-[var(--cf-danger)]",
  media: "text-[var(--cf-warning)]",
  baja: "text-[var(--cf-text-muted)]",
};

const INVEST_TONE = {
  ok: "text-[var(--cf-success)]",
  weak: "text-[var(--cf-warning)]",
  missing: "text-[var(--cf-danger)]",
} as const;

function copy(text: string, done: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => useToastStore.getState().pushToast(done, "success"))
    .catch((e: unknown) => pushErrorToast(String(e)));
}

/** A labelled block, same shape as the story card's fields so the two screens read as one app. */
function Block({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {label}
        </span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </div>
  );
}

/** The button that starts — or stops — one stage of the review. */
function StageButton({ stage, label, icon: Icon }: { stage: WorkItemReviewStage; label: string; icon: typeof ScanSearch }) {
  const t = useT();
  const running = useWorkItemReviewStore((s) => Boolean(s.runByStage[stage]));
  const ready = useWorkItemReviewStore((s) => Boolean(s.item) && Boolean(s.projectId));

  if (running) {
    return (
      <button
        type="button"
        onClick={() => void useWorkItemReviewStore.getState().stop(stage)}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
      >
        <Square size={11} />
        {t("huReview.stop")}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={() => void useWorkItemReviewStore.getState().run(stage)}
      className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--cf-border)] disabled:hover:text-[var(--cf-text)]"
    >
      <Icon size={11} />
      {label}
    </button>
  );
}

/** What the analysis found, and the text it proposes for it. */
function FindingRow({ finding, at }: { finding: ReviewFinding; at: number }) {
  const t = useT();
  const key = `finding:${at}`;
  const dismissed = useWorkItemReviewStore((s) => Boolean(s.dismissed[key]));
  if (dismissed) return null;

  const insert = () => {
    const store = useWorkItemReviewStore.getState();
    const text = finding.proposal.trim();
    if (!text) return;
    // Insertion appends rather than replaces: the proposal is one paragraph's worth of an argument
    // the user is having with their own story, and overwriting what they wrote would be the review
    // editing the story after all.
    const target: StorySection = finding.section;
    if (target === "titulo") store.setTitle(text);
    else if (target === "criterios") store.addCriterion(text);
    else store.setDescription(`${store.description}${store.description ? "\n\n" : ""}${text}`);
    store.dismiss(key);
  };

  return (
    <div className="rounded-md border border-[var(--cf-border)] px-2.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--cf-text-muted)] dark:bg-white/[0.1]">
          {t(`huReview.section.${finding.section}`)}
        </span>
        <span className={`text-[10px] font-semibold uppercase ${SEVERITY[finding.severity] ?? SEVERITY.baja}`}>
          {finding.severity}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-[var(--cf-text)]">{finding.issue}</p>
      {finding.proposal.trim() && (
        <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-dashed border-[var(--cf-border)] px-2 py-1.5 text-[12px] leading-relaxed text-[var(--cf-text)]">
          {finding.proposal}
        </p>
      )}
      {finding.evidence.length > 0 && (
        <p className="mt-1 font-mono text-[10.5px] text-[var(--cf-text-muted)]">{finding.evidence.join(" · ")}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        {finding.proposal.trim() && (
          <>
            <button type="button" onClick={insert} className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--cf-accent)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
              {t("huReview.insert")}
            </button>
            <button
              type="button"
              onClick={() => copy(finding.proposal, t("huReview.copied"))}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            >
              <Copy size={11} />
              {t("huReview.copy")}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => useWorkItemReviewStore.getState().dismiss(key)}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          {t("huReview.discard")}
        </button>
      </div>
    </div>
  );
}

function TaskRow({ task, at }: { task: ProposedTask; at: number }) {
  const t = useT();
  const key = `task:${at}`;
  const dismissed = useWorkItemReviewStore((s) => Boolean(s.dismissed[key]));
  if (dismissed) return null;

  return (
    <div className="rounded-md border border-[var(--cf-border)] px-2.5 py-2">
      <p className="font-mono text-[12px] font-medium text-[var(--cf-text)]">{task.title}</p>
      {task.detail && <p className="mt-1 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{task.detail}</p>}
      {task.evidence.length > 0 && (
        <p className="mt-1 font-mono text-[10.5px] text-[var(--cf-text-muted)]">{task.evidence.join(" · ")}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => copy(`${task.title}\n\n${task.detail}`, t("huReview.copied"))}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-accent)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          <Copy size={11} />
          {t("huReview.copy")}
        </button>
        <button
          type="button"
          onClick={() => useWorkItemReviewStore.getState().dismiss(key)}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          {t("huReview.discard")}
        </button>
      </div>
    </div>
  );
}

/**
 * Reviewing a user story that is already written on the board.
 *
 * The opposite direction to the rest of this workspace: instead of deriving a backlog from
 * documentation, it takes one story that exists and asks what it is missing. The story sits on the
 * left, editable; what the AI proposes sits on the right, and moves left only when the user says so.
 *
 * Nothing is written to Azure DevOps from this screen. Everything the review produces leaves through
 * the user's own hands — inserted into the local copy, or copied out — which is what makes it safe to
 * run against a board other people are working from.
 */
export function WorkItemReviewView({ onClose }: { onClose: () => void }) {
  const t = useT();
  const repos = useActiveProjects();
  const input = useWorkItemReviewStore((s) => s.input);
  const org = useWorkItemReviewStore((s) => s.org);
  const projectId = useWorkItemReviewStore((s) => s.projectId);
  const loading = useWorkItemReviewStore((s) => s.loading);
  const error = useWorkItemReviewStore((s) => s.error);
  const item = useWorkItemReviewStore((s) => s.item);
  const title = useWorkItemReviewStore((s) => s.title);
  const description = useWorkItemReviewStore((s) => s.description);
  const criteria = useWorkItemReviewStore((s) => s.criteria);
  const analysis = useWorkItemReviewStore((s) => s.analysis);
  const proposedCriteria = useWorkItemReviewStore((s) => s.proposedCriteria);
  const proposedTasks = useWorkItemReviewStore((s) => s.proposedTasks);
  const dismissed = useWorkItemReviewStore((s) => s.dismissed);

  const store = useWorkItemReviewStore.getState;
  const liveCriteria = useMemo(
    () => proposedCriteria.filter((_, at) => !dismissed[`criterion:${at}`]),
    [proposedCriteria, dismissed],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-bg)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          title={t("huReview.back")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
        >
          <ArrowLeft size={14} />
        </button>
        <span className="shrink-0 text-[13px] font-medium text-[var(--cf-text)]">{t("huReview.title")}</span>

        <input
          value={input}
          onChange={(e) => store().setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void store().load();
          }}
          placeholder={t("huReview.inputPlaceholder")}
          className={`${FIELD} ml-2 max-w-md`}
        />
        <input
          value={org}
          onChange={(e) => store().setOrg(e.target.value)}
          placeholder={t("huReview.orgPlaceholder")}
          className={`${FIELD} w-40 shrink-0`}
        />
        <button
          type="button"
          disabled={loading || !input.trim()}
          onClick={() => void store().load()}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? t("huReview.loading") : t("huReview.load")}
        </button>
      </div>

      {error && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">
          <CircleAlert size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {!item ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p className="max-w-md text-center text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("huReview.empty")}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* The story, editable. Local only — see the component note. */}
          <div className={`flex min-w-0 flex-1 flex-col overflow-y-auto px-3 py-3 ${CARD}`}>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--cf-text-muted)] dark:bg-white/[0.1]">
                {item.work_item_type} #{item.id}
              </span>
              <span className="text-[11px] text-[var(--cf-text-muted)]">{item.state}</span>
              <button
                type="button"
                onClick={() => void openExternalUrl(item.url).catch((e: unknown) => pushErrorToast(String(e)))}
                title={t("huReview.openInAzure")}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-accent)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                <ExternalLink size={11} />
                {t("huReview.openInAzure")}
              </button>
            </div>

            <p className="mb-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("huReview.localOnly")}</p>

            <div className="space-y-2.5">
              <Block label={t("stories.fieldTitle")}>
                <input value={title} onChange={(e) => store().setTitle(e.target.value)} className={FIELD} />
              </Block>

              <Block label={t("stories.fieldDescription")}>
                <textarea
                  value={description}
                  rows={8}
                  onChange={(e) => store().setDescription(e.target.value)}
                  className={`${FIELD} resize-y leading-relaxed`}
                />
              </Block>

              <Block
                label={t("stories.fieldCriteria")}
                action={
                  <button
                    type="button"
                    onClick={() => store().addCriterion("")}
                    className="flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline"
                  >
                    <Plus size={11} />
                    {t("stories.addCriterion")}
                  </button>
                }
              >
                <div className="space-y-1.5">
                  {criteria.length === 0 && (
                    <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.noCriteria")}</p>
                  )}
                  {criteria.map((criterion, at) => (
                    <div key={at} className="flex items-start gap-1.5">
                      <span className="mt-2 w-4 shrink-0 text-right text-[10px] tabular-nums text-[var(--cf-text-muted)]">
                        {at + 1}
                      </span>
                      <textarea
                        value={criterion}
                        rows={4}
                        onChange={(e) => store().setCriterion(at, e.target.value)}
                        className={`${FIELD} resize-y font-mono text-[11px] leading-relaxed`}
                      />
                      <button
                        type="button"
                        onClick={() => store().removeCriterion(at)}
                        title={t("stories.removeCriterion")}
                        className="mt-1.5 shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </Block>

              <Block label={t("huReview.existingTasks")}>
                {item.children.length === 0 ? (
                  <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.noTasks")}</p>
                ) : (
                  <div className="space-y-1">
                    {item.children.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => void openExternalUrl(child.url).catch((e: unknown) => pushErrorToast(String(e)))}
                        className="flex w-full items-baseline gap-2 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-left hover:border-[var(--cf-accent)]"
                      >
                        <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">#{child.id}</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">{child.title}</span>
                        <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">{child.state}</span>
                      </button>
                    ))}
                  </div>
                )}
              </Block>
            </div>
          </div>

          {/* What the review proposes. */}
          <div className="flex w-[420px] shrink-0 flex-col overflow-y-auto border-l border-[var(--cf-border)] px-3 py-3">
            <Block label={t("huReview.repo")}>
              <Select
                size="field"
                value={projectId}
                placeholder={t("huReview.pickRepo")}
                ariaLabel={t("huReview.repo")}
                onChange={(value) => store().setProject(value)}
                options={repos.map((repo) => ({ value: repo.id, label: repo.name }))}
              />
              <p className="mt-1 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{t("huReview.repoHint")}</p>
            </Block>

            <div className="mt-4 space-y-4">
              <Block
                label={t("huReview.analysis")}
                action={<StageButton stage="analyze" label={t("huReview.runAnalysis")} icon={ScanSearch} />}
              >
                {!analysis ? (
                  <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.analysisHint")}</p>
                ) : (
                  <div className="space-y-2">
                    {analysis.summary && (
                      <p className="text-[12px] leading-snug text-[var(--cf-text)]">{analysis.summary}</p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {analysis.invest.map((letter) => (
                        <span
                          key={letter.letter}
                          title={letter.note}
                          className={`rounded border border-[var(--cf-border)] px-1.5 py-0.5 text-[11px] font-semibold ${INVEST_TONE[letter.verdict] ?? ""}`}
                        >
                          {letter.letter}
                        </span>
                      ))}
                    </div>
                    {analysis.findings.map((finding, at) => (
                      <FindingRow key={at} finding={finding} at={at} />
                    ))}
                  </div>
                )}
              </Block>

              <Block
                label={t("huReview.criteria")}
                action={<StageButton stage="criteria" label={t("huReview.runCriteria")} icon={ListChecks} />}
              >
                {liveCriteria.length === 0 ? (
                  <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.criteriaHint")}</p>
                ) : (
                  <div className="space-y-2">
                    {proposedCriteria.map((criterion, at) =>
                      dismissed[`criterion:${at}`] ? null : (
                        <div key={at} className="rounded-md border border-[var(--cf-border)] px-2.5 py-2">
                          <p className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--cf-text)]">
                            {criterion.gherkin}
                          </p>
                          {criterion.rationale && (
                            <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                              {criterion.rationale}
                            </p>
                          )}
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                store().addCriterion(criterion.gherkin);
                                store().dismiss(`criterion:${at}`);
                              }}
                              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--cf-accent)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                            >
                              {t("huReview.addToStory")}
                            </button>
                            <button
                              type="button"
                              onClick={() => copy(criterion.gherkin, t("huReview.copied"))}
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                            >
                              <Copy size={11} />
                              {t("huReview.copy")}
                            </button>
                            <button
                              type="button"
                              onClick={() => store().dismiss(`criterion:${at}`)}
                              className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                            >
                              {t("huReview.discard")}
                            </button>
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </Block>

              <Block
                label={t("huReview.tasks")}
                action={<StageButton stage="tasks" label={t("huReview.runTasks")} icon={ClipboardCheck} />}
              >
                {proposedTasks.length === 0 ? (
                  <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.tasksHint")}</p>
                ) : (
                  <div className="space-y-2">
                    {proposedTasks.map((task, at) => (
                      <TaskRow key={at} task={task} at={at} />
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        copy(
                          proposedTasks
                            .filter((_, at) => !dismissed[`task:${at}`])
                            .map((task) => task.title)
                            .join("\n"),
                          t("huReview.copied"),
                        )
                      }
                      className="flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline"
                    >
                      <Copy size={11} />
                      {t("huReview.copyAllTasks")}
                    </button>
                  </div>
                )}
              </Block>
            </div>

            <button
              type="button"
              onClick={() => store().reset()}
              className="mt-6 flex items-center gap-1.5 self-start rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
            >
              <X size={11} />
              {t("huReview.clear")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
