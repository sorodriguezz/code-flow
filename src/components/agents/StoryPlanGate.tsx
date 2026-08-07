import { useEffect, useMemo, useState } from "react";
import { Check, CircleSlash, FolderGit2, TriangleAlert } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { useChainStore } from "../../state/chainStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { AgentChain, AgentChainStep } from "../../types/domain";

/** What phase one said about one repository. `unknown` is not a failure of the story — it is an
 * answer this screen could not read, which is a different thing and is shown as such. */
type Verdict = "touches" | "clear" | "unknown";

/**
 * The verdict line, read out of the analysis.
 *
 * "DOES NOT TOUCH" is tested first for the obvious reason: it contains "TOUCH", and the other order
 * would report every negative as a positive. Anchored to a line so a verdict quoted inside the prose
 * ("the verdict for the gateway was DOES NOT TOUCH") cannot outvote the real one at the top.
 */
function verdictOf(output: string): Verdict {
  if (/^\s*VERDICT:\s*DOES\s+NOT\s+TOUCH/im.test(output)) return "clear";
  if (/^\s*VERDICT:\s*TOUCHES/im.test(output)) return "touches";
  return "unknown";
}

/**
 * The message a step opens with, composed here exactly as `queries::compose_chain_input` composes
 * it in Rust.
 *
 * Duplicated on purpose, and only for the steps behind the gate: the chain parks at the *first* one,
 * so that one already has its message frozen on disk and this screen shows it verbatim. The others
 * have not been reached, so there is nothing to show unless it is built — and it has to be built
 * before it is shown, because what the user edits here is sent verbatim and would otherwise be a
 * preview of a message that never existed.
 */
function composeInput(goal: string, instruction: string, previous: AgentChainStep | null): string {
  let out = "";
  if (goal.trim()) out += `## Objective\n${goal.trim()}\n\n`;
  if (previous && previous.output_text.trim()) {
    out += `## Context — ${previous.agent_name} (step ${previous.step_index + 1})\n${previous.output_text.trim()}\n\n`;
  }
  return `${out}## Your task\n${instruction.trim()}`;
}

interface Row {
  step: AgentChainStep;
  repoName: string;
  verdict: Verdict;
  analysis: string;
  /** The message this repository's agent would be sent, as it stands. The starting value of the
   * editor, never read again once the user has one open. */
  seed: string;
}

/**
 * The decision the whole feature exists for.
 *
 * Phase one has read every candidate repository and said, for each, whether it has to change and
 * what would change in it. Nothing has been written yet. This is where a person reads those N
 * answers side by side, drops the repositories that turned out not to be involved, edits what is
 * left, and only then lets the second agent start.
 *
 * A repository whose verdict could not be read starts **unticked**. An unreadable answer is not
 * consent, and the one thing this screen must never do is write to a working copy nobody agreed to.
 */
export function StoryPlanGate({
  chain,
  steps,
  onDone,
}: {
  chain: AgentChain;
  steps: AgentChainStep[];
  /** Called once the plan has been approved, so the pane can drop back to its ordinary shape. */
  onDone?: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const analyses = steps.filter((step) => step.phase === "analyze");
    return steps
      .filter((step) => step.phase === "implement" && (step.status === "pending" || step.status === "skipped"))
      .map((step): Row => {
        const analysis = analyses.find((a) => a.project_id === step.project_id) ?? null;
        const previous = analysis && analysis.output_text.trim() ? analysis : null;
        return {
          step,
          repoName: step.project_name,
          verdict: analysis ? verdictOf(analysis.output_text) : "unknown",
          analysis: analysis?.output_text ?? "",
          // The step the chain is parked at already has its message frozen on disk, and that one is
          // shown verbatim; the ones behind it have never been reached, so theirs is composed.
          seed: step.pending_input.trim() || composeInput(chain.goal, step.instruction, previous),
        };
      });
  }, [chain.goal, steps]);

  /** One entry per repository: whether it goes ahead, and what its agent will be sent. */
  const [decisions, setDecisions] = useState<Record<string, { include: boolean; input: string }>>({});

  // Seeded per row and **never re-seeded**: the steps are rewritten on every chain-level write, and
  // an effect that recomputed the whole map would wipe an edit being typed. Only rows that have no
  // decision yet get one, which is also what makes this correct on the first render, when the
  // detail load has not landed and there are no rows at all.
  useEffect(() => {
    setDecisions((current) => {
      const missing = rows.filter((row) => !(row.step.id in current));
      if (missing.length === 0) return current;
      const next = { ...current };
      for (const row of missing) {
        // A repository whose verdict could not be read starts off. An unreadable answer is not
        // consent, and nothing here may write to a working copy nobody agreed to.
        next[row.step.id] = { include: row.verdict === "touches", input: row.seed };
      }
      return next;
    });
  }, [rows]);

  const chosen = rows.filter((row) => decisions[row.step.id]?.include);

  const approve = () => {
    setBusy(true);
    void useChainStore
      .getState()
      .approvePlan(
        chain.id,
        rows.map((row) => ({
          stepId: row.step.id,
          include: decisions[row.step.id]?.include ?? false,
          input: decisions[row.step.id]?.input ?? "",
        })),
      )
      .then(() => onDone?.())
      .catch((e: unknown) => pushErrorToast(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex min-h-0 shrink-0 flex-col border-t border-[var(--cf-border)]">
      <div className="flex shrink-0 items-baseline gap-2 px-3 pb-1 pt-2">
        <span className="text-[12px] font-semibold">{t("agents.storyPlanTitle")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]">
          {t("agents.storyPlanHint")}
        </span>
      </div>

      <div className="max-h-[46vh] min-h-0 space-y-2 overflow-y-auto px-3 pb-2">
        {rows.map((row) => {
          const decision = decisions[row.step.id] ?? { include: false, input: "" };
          const patch = (change: Partial<{ include: boolean; input: string }>) =>
            setDecisions((current) => ({
              ...current,
              [row.step.id]: { ...(current[row.step.id] ?? decision), ...change },
            }));
          return (
            <div
              key={row.step.id}
              className={`rounded-lg border px-2.5 py-2 ${
                decision.include ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"
              }`}
            >
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={decision.include} onChange={(on) => patch({ include: on })} />
                <FolderGit2 size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                  {row.repoName || t("chain.projectGone")}
                </span>
                <VerdictChip verdict={row.verdict} />
              </label>

              {row.analysis.trim() === "" ? (
                <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("agents.storyNoAnalysis")}</p>
              ) : (
                <Analysis text={row.analysis} />
              )}

              {/* Only for the repositories that are going ahead: what a repository nobody is
                  touching would be told is not a question worth putting on screen. */}
              {decision.include && (
                <textarea
                  value={decision.input}
                  rows={6}
                  onChange={(e) => patch({ input: e.target.value })}
                  className="mt-1.5 w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-3 py-2">
        <button
          type="button"
          disabled={busy}
          onClick={approve}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium disabled:opacity-50 ${
            chosen.length > 0
              ? "bg-[var(--cf-accent)] text-white hover:brightness-110"
              : "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)]"
          }`}
        >
          {chosen.length > 0 ? <Check size={12} /> : <CircleSlash size={12} />}
          {chosen.length > 0
            ? t("agents.storyApproveN", { n: chosen.length })
            : t("agents.storyApproveNone")}
        </button>
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--cf-warning)]">
          <TriangleAlert size={11} />
          {t("agents.writesWorkingTree")}
        </span>
      </div>
    </div>
  );
}

function VerdictChip({ verdict }: { verdict: Verdict }) {
  const t = useT();
  const tone =
    verdict === "touches"
      ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
      : verdict === "clear"
        ? "bg-black/[0.05] text-[var(--cf-text-muted)] dark:bg-white/[0.07]"
        : "bg-black/[0.05] text-[var(--cf-warning)] dark:bg-white/[0.07]";
  const label =
    verdict === "touches"
      ? "agents.storyVerdictTouches"
      : verdict === "clear"
        ? "agents.storyVerdictClear"
        : "agents.storyVerdictUnknown";
  return <span className={`shrink-0 rounded px-1.5 py-[1px] text-[10px] ${tone}`}>{t(label)}</span>;
}

/** The analysis itself, collapsed. Expanded it is selectable — the reason to open one is to take
 * something out of it and paste it into the message below. */
function Analysis({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1.5 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      >
        {open ? "▾" : "▸"} {t("agents.stepOutput")}
      </button>
      {open && (
        <p className="mt-1 max-h-48 select-text overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--cf-text-muted)] dark:bg-white/[0.04]">
          {text}
        </p>
      )}
    </>
  );
}
