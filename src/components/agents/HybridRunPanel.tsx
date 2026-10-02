import { useEffect } from "react";
import { ArrowUpRight, Check, CheckCheck, Circle, MessageSquareText, SkipForward, TriangleAlert, Undo2 } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Tooltip } from "../common/Tooltip";
import { buttonClass, iconButtonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { filePath, verdictOf, withoutVerdict } from "./hybridText";
import { useChainStore } from "../../state/chainStore";
import { useHybridStore } from "../../state/hybridStore";
import { confirmAction } from "../../state/confirmStore";
import { pushSuccessToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { HybridItem, HybridRun, HybridView, HybridWhy, RunFile } from "../../lib/tauri/hybridCommands";
import type { AgentChain, AgentChainStep } from "../../types/domain";

/**
 * What the local model is doing with the plan, task by task — and with the review's corrections,
 * round by round — and, once the run is over, what it all came to.
 *
 * Every number on the result is measured, none is a guess: tokens the local server says it wrote,
 * tokens the subscription's CLI says the plan and the review spent. There is no "saved $X": that
 * would be a counterfactual, and this pane shows what happened.
 */
export function HybridRunPanel({
  chain,
  steps,
  idle,
}: {
  chain: AgentChain;
  steps: AgentChainStep[];
  /** The plan is not moving: undo is only offered then, never under a running step. */
  idle: boolean;
}) {
  const t = useT();
  const view = useHybridStore((s) => s.views[chain.id]);
  const progress = useHybridStore((s) => s.progress);
  const executeStatus = steps.find((step) => step.phase === "execute")?.status;

  useEffect(() => {
    void useHybridStore.getState().load(chain.id);
  }, [chain.id, chain.updated_at, executeStatus]);

  if (!view || view.items.length === 0) return null;
  const { run, items } = view;
  const review = steps.find((step) => step.phase === "review");
  const finished = executeStatus === "done";
  const rounds = [...new Set(items.map((item) => item.round))].sort((a, b) => a - b);
  const shown = (file: RunFile) => (view.repos.length > 1 ? `${file.repo}/${file.path}` : file.path);

  const undoAll = async () => {
    const files = await useHybridStore.getState().changedPaths(chain.id);
    if (files.length === 0) return;
    const list = files.slice(0, 8).map(shown).join("\n");
    const more = files.length > 8 ? `\n${t("agents.hybridUndoMore", { n: files.length - 8 })}` : "";
    const ok = await confirmAction(`${t("agents.hybridUndoConfirm", { n: files.length })}\n\n${list}${more}`, true, t("agents.hybridUndoAll"));
    if (!ok) return;
    const restored = await useHybridStore.getState().undo(chain.id);
    if (restored.length > 0) pushSuccessToast(t("agents.hybridUndone", { n: restored.length }));
  };

  const undoOne = async (item: HybridItem) => {
    const file: RunFile = { project_id: item.project_id || view.repos[0]?.project_id || "", repo: "", path: item.file };
    const ok = await confirmAction(
      t("agents.hybridUndoFileConfirm", { file: filePath(view, item.project_id, item.file) }),
      true,
      t("agents.hybridUndoFile"),
    );
    if (!ok) return;
    const restored = await useHybridStore.getState().undo(chain.id, [file]);
    if (restored.length > 0) pushSuccessToast(t("agents.hybridUndone", { n: restored.length }));
  };

  return (
    <div className="mt-4">
      {rounds.map((round) => {
        const ofRound = items.filter((item) => item.round === round);
        const delegated = ofRound.filter((item) => item.enabled && item.assignee === "local");
        const done = ofRound.filter((item) => item.status === "done");
        const heading =
          round === 0
            ? t(run.direct ? "agents.hybridDirectTasks" : "agents.hybridTasks", { done: done.length, local: delegated.length })
            : t("agents.hybridFixRound", { round, max: view.max_fix_rounds, done: done.length, local: delegated.length });
        return (
          <div key={round} className={round > 0 ? "mt-3" : undefined}>
            <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)] after:h-px after:flex-1 after:bg-[var(--cf-border)] after:content-['']">
              {heading}
            </p>
            <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
              {ofRound.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  path={filePath(view, item.project_id, item.file)}
                  live={progress[item.id]}
                  onUndo={idle && item.status === "done" ? () => void undoOne(item) : undefined}
                />
              ))}
            </div>
          </div>
        );
      })}

      {finished && (
        <Result view={view} run={run} items={items} review={review} chain={chain} idle={idle} onUndoAll={() => void undoAll()} />
      )}
    </div>
  );
}

function ItemRow({
  item,
  path,
  live,
  onUndo,
}: {
  item: HybridItem;
  path: string;
  live?: { tokens: number; elapsedMs: number };
  onUndo?: () => void;
}) {
  const t = useT();
  const forReview = item.enabled && item.assignee === "sub" && item.status === "pending";
  const icon =
    item.status === "done" ? (
      <Check size={13} className="text-[var(--cf-success)]" />
    ) : item.status === "reviewed" ? (
      <CheckCheck size={13} className="text-[var(--cf-text-muted)]" />
    ) : item.status === "running" ? (
      <ThinkingOrb size="sm" />
    ) : item.status === "failed" ? (
      <TriangleAlert size={13} className="text-[var(--cf-danger)]" />
    ) : item.status === "escalated" || forReview ? (
      <ArrowUpRight size={13} className="text-[var(--cf-text-muted)]" />
    ) : item.status === "skipped" ? (
      <SkipForward size={13} className="text-[var(--cf-text-muted)]" />
    ) : (
      <Circle size={11} className="text-[var(--cf-text-faint)]" />
    );
  let detail = "";
  let tone = "text-[var(--cf-text-muted)]";
  // The kind, in the reader's language; the sentence itself is English (the review model reads it)
  // and stays one hover away.
  const reason = item.error_code ? t(WHY_KEY[item.error_code]) : item.error;
  if (item.status === "done") {
    detail = t("agents.hybridItemDone", {
      added: item.lines_added,
      removed: item.lines_removed,
      input: compact(item.tokens_in),
      output: compact(item.tokens_out),
      seconds: Math.round(item.ms / 1000),
    });
  } else if (item.status === "running") {
    detail = live
      ? t("agents.hybridItemWriting", { tokens: live.tokens, rate: rate(live) })
      : t("agents.hybridItemReading");
    tone = "text-[var(--cf-accent)]";
  } else if (item.status === "failed") {
    detail = reason;
    tone = "text-[var(--cf-danger)]";
  } else if (item.status === "escalated") {
    detail = t("agents.hybridItemEscalated", { reason });
  } else if (item.status === "reviewed") {
    detail = t("agents.hybridItemReviewed");
  } else if (item.status === "skipped") {
    detail = item.enabled ? reason || t("agents.hybridItemSkipped") : t("agents.hybridItemLeftOut");
  } else if (forReview) {
    detail = t("agents.hybridItemForReview");
  }
  return (
    <div className="flex items-center gap-2.5 border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className={`min-w-0 truncate font-mono text-[12px] ${item.enabled ? "text-[var(--cf-text)]" : "text-[var(--cf-text-faint)] line-through"}`} title={item.title}>
        {path}
      </span>
      <span
        className={`ml-auto min-w-0 max-w-[55%] truncate text-right text-[11px] tabular-nums ${tone}`}
        title={item.error && item.error !== detail ? `${detail}\n${item.error}` : detail}
      >
        {detail}
      </span>
      {onUndo && (
        <Tooltip label={t("agents.hybridUndoFile")}>
          <button type="button" onClick={onUndo} aria-label={t("agents.hybridUndoFile")} className={iconButtonClass({ size: "xs" })}>
            <Undo2 size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function Result({
  view,
  run,
  items,
  review,
  chain,
  idle,
  onUndoAll,
}: {
  view: HybridView;
  run: HybridRun;
  items: HybridItem[];
  review?: AgentChainStep;
  chain: AgentChain;
  idle: boolean;
  onUndoAll: () => void;
}) {
  const t = useT();
  const done = items.filter((item) => item.status === "done");
  const written = items.reduce((sum, item) => sum + item.tokens_out, 0);
  const seconds = Math.round(items.reduce((sum, item) => sum + item.ms, 0) / 1000);
  const verdict = review?.status === "done" ? verdictOf(review.output_text) : null;
  // Skipped by the run itself, and still skipped: a review somebody asked for since is a review.
  const skipped = review?.status === "skipped" && run.review_skip !== "" ? run.review_skip : null;
  const leftOver =
    chain.last_reason === "chain.hybridPending" && review?.output_text ? withoutVerdict(review.output_text) : "";
  const askForReview = () => {
    if (review) void useChainStore.getState().rerunFrom(chain.id, review.step_index, "");
  };
  return (
    <div className="mt-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {verdict && <span className={chipClass(verdict === "pending" ? "warn" : "ok")}>{t(VERDICT_KEY[verdict])}</span>}
        {skipped && (
          <Tooltip label={t(skipped === "direct" ? "agents.hybridNoReviewDirectHint" : "agents.hybridNoReviewSmallHint")}>
            <span className={chipClass("neutral")}>
              {t(skipped === "direct" ? "agents.hybridNoReviewDirect" : "agents.hybridNoReviewSmall")}
            </span>
          </Tooltip>
        )}
        {run.fix_round > 0 && (
          <span className="text-[11px] text-[var(--cf-text-muted)]">{t("agents.hybridFixRoundsDone", { n: run.fix_round })}</span>
        )}
      </div>
      <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
        <Metric
          label={t("agents.hybridLocalWritten")}
          value={t("agents.hybridLocalWrittenValue", { files: done.length, tokens: compact(written), seconds })}
        />
        <Metric
          label={t("agents.hybridSubscriptionSpent")}
          value={t("agents.hybridSubscriptionSpentValue", {
            plan: compact(run.plan_input_tokens + run.plan_output_tokens),
            review: compact(run.review_input_tokens + run.review_output_tokens),
          })}
        />
      </div>
      {leftOver && (
        <p className="mt-2 max-h-32 select-text overflow-auto whitespace-pre-wrap rounded-md bg-[var(--cf-sunken)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
          {leftOver}
        </p>
      )}
      {/* "Review changes" is the chain's own footer action, there for every finished plan. */}
      {idle && (
        <div className="mt-2.5 flex flex-wrap justify-end gap-2">
          {skipped && review && (
            <button type="button" onClick={askForReview} className={buttonClass({ variant: "secondary", size: "sm" })}>
              <MessageSquareText size={13} />
              {t("agents.hybridAskReview", { agent: review.agent_name || "" })}
            </button>
          )}
          <button type="button" onClick={onUndoAll} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <Undo2 size={13} />
            {t("agents.hybridUndoAll")}
          </button>
        </div>
      )}
      {view.repos.length > 1 && (
        <p className="mt-2 text-[11px] text-[var(--cf-text-muted)]">
          {t("agents.hybridRepos", { repos: view.repos.map((repo) => repo.name).join(", ") })}
        </p>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[var(--cf-sunken)] px-2.5 py-2">
      <p className="text-[11px] text-[var(--cf-text-muted)]">{label}</p>
      <p className="mt-0.5 text-[13px] font-medium tabular-nums text-[var(--cf-text)]">{value}</p>
    </div>
  );
}

const WHY_KEY = {
  file: "agents.hybridWhyFile",
  moved: "agents.hybridWhyMoved",
  "too-big": "agents.hybridWhyTooBig",
  "cut-prompt": "agents.hybridWhyCutPrompt",
  server: "agents.hybridWhyServer",
  answer: "agents.hybridWhyAnswer",
  changed: "agents.hybridWhyChanged",
  dependency: "agents.hybridWhyDependency",
} as const satisfies Record<HybridWhy, string>;

const VERDICT_KEY = {
  ok: "agents.hybridVerdictOk",
  fixed: "agents.hybridVerdictFixed",
  pending: "agents.hybridVerdictPending",
} as const;

function compact(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function rate(live: { tokens: number; elapsedMs: number }): string {
  if (live.elapsedMs <= 0) return "—";
  return (live.tokens / (live.elapsedMs / 1000)).toFixed(1);
}
