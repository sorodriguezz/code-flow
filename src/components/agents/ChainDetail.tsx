import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  GitCompare,
  Link2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Square,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { areaClass } from "./areaClass";
import { chainStatusOf, reasonText } from "./chainStatus";
import { StoryPlanGate } from "./StoryPlanGate";
import { AiRunLog } from "../ai/AiRunLog";
import { buttonClass, iconButtonClass, type ButtonVariant } from "../common/Button";
import { chipClass, fieldClass, toolbarClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { useAgentsStore } from "../../state/agentsStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useChainStore } from "../../state/chainStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { AgentChainStep, ChainRepo, ChainStepStatus } from "../../types/domain";

/**
 * One chain, open: the plan, where it has got to, and the one decision it is waiting on.
 *
 * The action bar has a row for every state, including the two that are easy to forget — a chain
 * that is running still needs a stop, and one that is queued still needs an abort. A state with no
 * control is a state the user is stuck in.
 */
export function ChainDetail({ chainId }: { chainId: string }) {
  const t = useT();
  const chain = useChainStore((s) => s.chains.find((c) => c.id === chainId) ?? null);
  const steps = useChainStore((s) => s.stepsByChain[chainId] ?? EMPTY_STEPS);
  const repos = useChainStore((s) => s.reposByChain[chainId] ?? EMPTY_REPOS);
  const projectName = useWorkspaceStore((s) => {
    const projects = s.activeWorkspaceId ? (s.projectsByWorkspace[s.activeWorkspaceId] ?? []) : [];
    return projects.find((p) => p.id === chain?.project_id)?.name ?? "";
  });
  const setActiveView = useUiStore((s) => s.setActiveView);
  const focusProject = useWorkspaceStore((s) => s.focusProject);

  /** The gate's message, editable. Seeded once per gate so typing is never overwritten. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The note for a whole-plan re-run, or `null` while the box is closed. `""` is a real value —
   * "run it again exactly as it was" is the common case, and the box opening at all is what makes
   * the second click the confirmation this needs. */
  const [rerunAll, setRerunAll] = useState<string | null>(null);
  const gated = chain?.status === "gated";
  const waiting = steps.find((step) => step.status === "pending");
  /** Whether this gate is the story review — the one decision the plain "here is the message"
   * textarea cannot express, because it is about N repositories rather than one message. */
  const planGate = gated && chain?.kind === "story" && waiting?.phase === "implement";

  useEffect(() => {
    setDraft(gated ? (waiting?.pending_input ?? "") : null);
    // Keyed on the step, not on the chain: re-seeding on every chain write would wipe an edit
    // being typed while a sibling field updates.
  }, [gated, waiting?.id, waiting?.pending_input]);

  if (!chain) return null;
  // Resolved, not finished-well: a skipped step is one the plan is past.
  const resolved = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  // `step_count` is the denominator the plan was authored with, so a chain whose steps have not
  // loaded yet draws its shape rather than an empty strip.
  const stepTotal = Math.max(steps.length, chain.step_count);
  const { icon: StatusIcon, color, labelKey } = chainStatusOf(chain);
  const reason = reasonText(chain.last_reason, t);
  const store = useChainStore.getState();
  /** Whether the plan is standing still. Re-running anything while a turn is mid-flight would be
   * asking two agents for the same working copy — which is also the only state the backend's own
   * `rerun_chain_from` refuses outright. */
  const idle = chain.status !== "running" && chain.status !== "queued";

  /** The repository whose diff the user is actually asking for: the one the plan is at, not the
   * chain's first — on a multi-repo chain those are routinely different, and sending someone to a
   * clean tree while the edits sit in another is worse than not offering the button. */
  const openChanges = () => {
    const at =
      steps.find((step) => step.status === "running") ??
      waiting ??
      [...steps].reverse().find((step) => step.status === "done");
    void focusProject(
      useWorkspaceStore.getState().activeWorkspaceId ?? "",
      at?.project_id || chain.project_id,
    ).then(() => setActiveView("changes"));
  };

  const remove = () => {
    void confirmAction(t("agents.deleteChainConfirm", { name: chain.title })).then((ok) => {
      if (ok) void store.remove(chainId);
    });
  };

  return (
    <>
      {/* The toolbar every surface shares — 44px, level with the explorer's head beside it. The
          status is said in words and a static glyph: while the plan runs, the orb is on its row in
          the tree and on the run card below, and a third copy up here would only add motion. */}
      <div className={toolbarClass}>
        {chain.kind === "story" ? (
          <Wand2 size={16} className="shrink-0 text-[var(--cf-accent)]" />
        ) : (
          <Link2 size={16} className="shrink-0 text-[var(--cf-accent)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={chain.goal || chain.title}>
          {chain.title}
        </span>
        {chain.work_item_url && (
          <Tooltip label={t("agents.storyOpenBoard")}>
            <button
              type="button"
              onClick={() => void openExternalUrl(chain.work_item_url).catch((e: unknown) => pushErrorToast(String(e)))}
              className={chipClass("neutral", "font-mono transition-colors hover:text-[var(--cf-accent)]")}
            >
              {chain.work_item_key || `#${chain.work_item_id}`}
              <ExternalLink size={11} />
            </button>
          </Tooltip>
        )}
        <span className={`flex shrink-0 items-center gap-1.5 text-[12px] font-medium ${color}`}>
          <StatusIcon size={14} />
          <span className="truncate">{t(labelKey)}</span>
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-[var(--cf-text-faint)]">
          {t("agents.stepN", { n: chain.current_step + 1, total: chain.step_count })}
        </span>
        {/* One repository reads as its name; several read as a count, because the names would not
            fit — they are on the badge's tooltip instead, which is where you go when the question
            is "which working copies can this plan write to". */}
        {chain.repo_count > 1 ? (
          <span
            className={chipClass("neutral")}
            title={repos.map((repo) => repo.name || t("chain.projectGone")).join(" · ")}
          >
            <FolderGit2 size={12} />
            {t("agents.chainRepos", { n: chain.repo_count })}
          </span>
        ) : (
          projectName && (
            <span className={chipClass("neutral", "max-w-[180px]")}>
              <FolderGit2 size={12} className="shrink-0" />
              <span className="min-w-0 truncate">{projectName}</span>
            </span>
          )
        )}
        {/* Closes the pane, not the plan. Deselecting is a view change and nothing else — the
            scheduler advances the chain from the store, so a running step keeps running, its turn
            still lands, and the row in the tree keeps counting. Sitting on the open plan to keep it
            alive is exactly the thing an autonomous run should not ask of anyone. */}
        <Tooltip label={t("agents.closeChain")}>
          <button
            type="button"
            onClick={() => void useChainStore.getState().select(null)}
            aria-label={t("agents.closeChain")}
            className={iconButtonClass()}
          >
            <X size={15} />
          </button>
        </Tooltip>
      </div>

      {/* The plan's own progress, directly under its title — one cell per step, in plan order. A
          chain is the one thing in this app that genuinely knows how far along it is (steps are
          countable, the inside of a single run is not), so this is determinate where `AiRunLog`'s
          bar cannot be, and *which* step it is at is as much of the answer as how many are left.
          Skipped counts as resolved: a strip that stalled on them would say the plan was stuck
          when it is moving — it just wears the muted colour rather than the green. */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={stepTotal}
        aria-valuenow={resolved}
        aria-label={t("agents.chainProgress", { done: resolved, total: stepTotal })}
        className="flex h-[3px] shrink-0 items-stretch gap-[2px]"
      >
        {Array.from({ length: stepTotal }, (_, at) => (
          <span key={at} className={`cf-chain-seg ${SEG_CLASS[steps[at]?.status ?? "pending"]}`}>
            <span className="cf-chain-seg-fill" />
          </span>
        ))}
      </div>

      {reason && (
        <p className="shrink-0 border-b border-[var(--cf-border)] px-4 py-2 text-[12px] text-[var(--cf-text-muted)]">
          {reason}
        </p>
      )}

      {/* No `space-y` any more: the gap between two steps is the rail, and a margin on top of it
          would break the line the rail exists to draw. The plan reads down one column of a
          readable width rather than stretching across a wide window. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-[760px]">
          {chain.goal.trim() !== "" && (
            <p className="mb-3 whitespace-pre-wrap rounded-lg border border-dashed border-[var(--cf-border-strong)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--cf-text-muted)]">
              {chain.goal}
            </p>
          )}
          {steps.map((step, at) => {
            const next = steps[at + 1];
            return (
              // Assembled top-down, one row after the next, in the order the chain runs in — the
              // shape of the thing the pane is describing. Capped at a dozen because past that the
              // stagger stops reading as a sequence and starts reading as a slow list.
              <div
                key={step.id}
                className="cf-step-in"
                style={{ animationDelay: `${Math.min(at, 12) * 45}ms` }}
              >
                {/* The two halves of a story run, named. 2N rows in one flat list is honest about what
                    runs but says nothing about the shape, and the shape — read everything, stop, then
                    write some of it — is the whole point of the feature. */}
                {step.phase !== "" && step.phase !== steps[at - 1]?.phase && (
                  <p className="mb-2 mt-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)] after:h-px after:flex-1 after:bg-[var(--cf-border)] after:content-['']">
                    {t(step.phase === "analyze" ? "agents.storyPhaseAnalyze" : "agents.storyPhaseImplement")}
                  </p>
                )}
                <StepRow
                  step={step}
                  isGate={gated && step.id === waiting?.id}
                  showRepo={chain.repo_count > 1}
                  idle={idle}
                />
                {next && (
                  <StepRail
                    carried={step.status === "done"}
                    flowing={step.status === "done" && next.status === "running"}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {planGate ? (
        <StoryPlanGate chain={chain} steps={steps} />
      ) : (
        gated && (
          <div className="shrink-0 border-t border-[var(--cf-border)] px-4 py-2.5">
            <p className="mb-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("agents.gatePreview")}</p>
            <textarea
              value={draft ?? ""}
              rows={6}
              onChange={(e) => setDraft(e.target.value)}
              className={areaClass({ size: "sm", mono: true })}
            />
          </div>
        )
      )}

      {/* The whole plan again, with an optional word about what to do differently.

          A box rather than a confirmation dialog, and the same box the per-step ↺ opens: re-running
          a plan is not a yes/no question — the useful version of it is "again, but keep the API
          stable" — and a modal that only asked "are you sure?" would send anyone who wanted to say
          that back to the step rows. Opening it is also what makes the second click the
          confirmation, which N engine sessions against a real working copy deserve. */}
      {rerunAll !== null && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
          <input
            autoFocus
            value={rerunAll}
            onChange={(e) => setRerunAll(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRerunAll(null);
              if (e.key !== "Enter") return;
              e.preventDefault();
              void store.rerunFrom(chainId, 0, rerunAll);
              setRerunAll(null);
            }}
            placeholder={t("agents.rerunChainPlaceholder")}
            className={fieldClass({ size: "sm", className: "flex-1" })}
          />
          <button
            type="button"
            onClick={() => {
              void store.rerunFrom(chainId, 0, rerunAll);
              setRerunAll(null);
            }}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            {t("agents.rerunChainGo", { n: stepTotal })}
          </button>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
        {chain.status === "running" && (
          <Action
            icon={Square}
            label={t("agents.stopStep")}
            onClick={() => {
              const live = steps.find((s) => s.status === "running");
              if (live?.task_id) void useAgentsStore.getState().stop(live.task_id);
            }}
          />
        )}
        {/* The story review carries its own approve — it approves N repositories at once, and a
            second button beside it that approved only the next one would be a trap. */}
        {gated && !planGate && (
          <>
            {/* `waiting` is the step this gate was drawn from, and it goes with the approval as a
                precondition: the pane can be minutes old (a phone may have answered the same gate
                from the sofa), and clearing a gate that has already moved on would force a chain
                mid-run back to `queued`. */}
            <Action primary icon={Check} label={t("agents.approveContinue")} onClick={() => void store.approve(chainId, draft ?? "", waiting?.id)} />
            <Action icon={GitCompare} label={t("agents.openChanges")} onClick={openChanges} />
            <Action icon={SkipForward} label={t("agents.skipStep")} onClick={() => void store.skip(chainId)} />
          </>
        )}
        {chain.status === "paused" && (
          <Action primary icon={Play} label={t("agents.resumeChain")} onClick={() => void store.resume(chainId)} />
        )}
        {chain.status === "failed" && (
          <>
            <Action primary icon={Play} label={t("agents.retryStep")} onClick={() => void store.retry(chainId)} />
            <Action icon={SkipForward} label={t("agents.skipStep")} onClick={() => void store.skip(chainId)} />
          </>
        )}
        {(chain.status === "done" || chain.status === "aborted") && (
          <Action icon={GitCompare} label={t("agents.openChanges")} onClick={openChanges} />
        )}
        {/* Offered from every state the plan is not moving in, finished included — which is the
            state it is most often asked for from. The per-step ↺ can already do this from step one;
            what it cannot do is say so, and "run the whole thing again" is a decision about the
            plan, not about its first row. */}
        {idle && (
          <Action
            icon={RotateCcw}
            label={t("agents.rerunChain")}
            onClick={() => setRerunAll((current) => (current === null ? "" : null))}
          />
        )}
        <span className="ml-auto flex items-center gap-2">
          {!["done", "aborted"].includes(chain.status) && (
            <Action icon={Square} label={t("agents.abortChain")} onClick={() => void store.abort(chainId)} />
          )}
          <Action danger icon={Trash2} label={t("agents.deleteChain")} onClick={remove} />
        </span>
      </div>
    </>
  );
}

const EMPTY_STEPS: AgentChainStep[] = [];
const EMPTY_REPOS: ChainRepo[] = [];

/** How each step paints its cell in the progress strip. `pending` is the bare track, so it has no
 * class of its own — an empty cell is the absence of an answer, not a state to colour. */
const SEG_CLASS: Record<ChainStepStatus, string> = {
  pending: "",
  running: "cf-chain-seg-run",
  done: "cf-chain-seg-done",
  error: "cf-chain-seg-error",
  interrupted: "cf-chain-seg-warn",
  skipped: "cf-chain-seg-skipped",
};

/** Mirrors `queries::MAX_STEP_ATTEMPTS`. Only ever displayed — the backend is what counts. */
const MAX_STEP_ATTEMPTS = 3;

/**
 * The segment between two steps: the thing the feature is named after, drawn.
 *
 * Lined up on the step number rather than on the card edge, so the rail runs through the badges
 * and the column reads as one line rather than as a decoration down the side. `carried` is the
 * handoff having happened — this step answered, and its answer is what opens the next one — and
 * `flowing` is the single moment that answer is actually in transit, which is the only thing here
 * that moves.
 */
function StepRail({ carried, flowing }: { carried: boolean; flowing: boolean }) {
  return (
    <div className="flex" aria-hidden="true">
      {/* 23px, so the 2px rail straddles 23–25 and its centre lands on the badge's: 1px border +
          12px of `px-3` + half of the 22px number circle. */}
      <div className="cf-chain-rail ml-[23px] h-3.5">
        {/* The green grows downward when the handoff happens rather than appearing whole, so the
            segment says which way the plan runs and not merely that it passed. */}
        <span className={`cf-chain-rail-fill ${carried ? "cf-chain-rail-fill-on" : ""}`} />
        {flowing && <span className="cf-chain-beam" />}
      </div>
    </div>
  );
}

function Action({
  icon: Icon,
  label,
  onClick,
  primary,
  danger,
}: {
  icon: typeof Check;
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  const variant: ButtonVariant = primary ? "primary" : danger ? "danger-ghost" : "secondary";
  return (
    <button type="button" onClick={onClick} className={buttonClass({ variant })}>
      <Icon size={14} />
      {label}
    </button>
  );
}

/**
 * The step's number, and what became of it — one mark rather than the number plus the status dot
 * that used to sit beside it. The two always described the same step, and the dot spent a column
 * saying what the badge can say by being that colour.
 *
 * The number survives every state it can: it is the step's name in the plan, in the rail, and in
 * the "loops back to 2" note, so swapping it for a glyph would cost the reader their place. It
 * gives way only where the glyph *is* the answer — a tick, a fault, a step stepped over.
 *
 * Running is the one state that moves: a ring turns around the number, which is the pane's answer
 * to "where is it right now" from across the room.
 *
 * A step behind a gate that has not run yet wears its number filled in the accent: the stop is part
 * of the plan's shape, and it should be visible from the number column alone — before the chain
 * gets there, not only once it is parked.
 */
export function StepBadge({ status, index, gate = false }: { status: ChainStepStatus; index: number; gate?: boolean }) {
  const tone =
    status === "done"
      ? "bg-[color-mix(in_oklab,var(--cf-success)_18%,transparent)] text-[var(--cf-success)]"
      : status === "error"
        ? "bg-[color-mix(in_oklab,var(--cf-danger)_18%,transparent)] text-[var(--cf-danger)]"
        : status === "interrupted"
          ? "bg-[color-mix(in_oklab,var(--cf-warning)_18%,transparent)] text-[var(--cf-warning)]"
          : status === "running"
            ? "cf-step-ring bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : gate && status === "pending"
              ? "bg-[var(--cf-accent)] text-[var(--cf-on-accent)]"
              : "bg-[var(--cf-press)] text-[var(--cf-text-muted)]";

  return (
    <span
      className={`relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums transition-colors ${tone}`}
    >
      {status === "done" ? (
        <Check size={12} strokeWidth={3} className="cf-step-pop" />
      ) : status === "error" ? (
        <TriangleAlert size={11} />
      ) : status === "skipped" ? (
        <SkipForward size={11} />
      ) : (
        index + 1
      )}
    </span>
  );
}

/**
 * "Review before running this step", as a chip with the pause glyph. In the accent while the gate is
 * still ahead of the plan; quiet once the step has been reached, when it is history rather than a
 * stop coming up.
 */
export function GateChip({ ahead }: { ahead: boolean }) {
  const t = useT();
  return (
    <span className={chipClass(ahead ? "accent" : "neutral", "max-w-full")}>
      <Pause size={11} className="shrink-0" />
      <span className="min-w-0 truncate">{t("agents.gateBefore")}</span>
    </span>
  );
}

function StepRow({
  step,
  isGate,
  showRepo,
  idle,
}: {
  step: AgentChainStep;
  isGate: boolean;
  /** Whether the plan is standing still. Re-running from a step while another one is mid-turn would
   * be asking two agents for the same working copy. */
  idle: boolean;
  /** Only when the chain has more than one: with one repository every step runs there, and a badge
   * repeating it on every row is noise. */
  showRepo: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  /** The re-run note being typed, or `null` when the box is closed. `""` is a real value — a
   * re-run with nothing to add is a legitimate thing to ask for. */
  const [rerun, setRerun] = useState<string | null>(null);
  const select = useAgentsStore((s) => s.select);
  const taskExists = useAgentsStore((s) => s.tasks.some((task) => task.id === step.task_id));
  // Whether the run behind this step is still ours. A step marked `running` with no live run is
  // one whose engine outlived a webview reload — the work is coming back, but there is no log to
  // show for it, and saying so beats a spinner that never moves.
  const live = useAiRunStore((s) => (step.run_id ? (s.active[step.run_id] ?? false) : false));
  const running = step.status === "running";

  return (
    <div
      className={`relative rounded-lg border bg-[var(--cf-surface)] px-3 py-2.5 transition-colors ${
        running
          ? "cf-step-live border-[var(--cf-accent-line)]"
          : isGate
            ? "border-[var(--cf-accent)] shadow-[0_0_0_1px_var(--cf-accent)]"
            : "border-[var(--cf-border)]"
      }`}
    >
      {/* Only ever on one row — a chain runs one step — so the pane has exactly one thing moving in
          it at a time, and that thing is where the work is. */}
      {running && (
        <span className="cf-step-scan" aria-hidden="true">
          <span className="cf-step-scan-beam" />
        </span>
      )}
      <div className="flex items-center gap-2.5">
        {/* No orb beside the badge: the badge already says which step the plan is on, and the
            engine burning context for it wears its orb once, on the run card below. A `running`
            step without a live run is the reload case the `stepRecovered` note explains. */}
        <StepBadge status={step.status} index={step.step_index} gate={step.gate} />
        <button
          type="button"
          onClick={() => {
            if (step.task_id && taskExists) {
              useChainStore.getState().select(null);
              void select(step.task_id);
            } else {
              setOpen((v) => !v);
            }
          }}
          className="min-w-0 flex-1 rounded-md text-left"
          title={step.instruction}
        >
          <span className="block truncate text-[13px] font-semibold text-[var(--cf-text)]">
            {step.agent_name || t("settings.sddNewAgent")}
          </span>
          <span className="block truncate text-[12px] text-[var(--cf-text-muted)]">{step.instruction}</span>
        </button>
        {showRepo && (
          <span className={chipClass("neutral", "max-w-[140px]")}>
            <FolderGit2 size={11} className="shrink-0" />
            <span className="min-w-0 truncate">{step.project_name || t("chain.projectGone")}</span>
          </span>
        )}
        {step.gate && (
          <span className="flex min-w-0 max-w-[45%] shrink">
            <GateChip ahead={step.status === "pending"} />
          </span>
        )}
        {running && !live && <span className={chipClass("warn")}>{t("agents.stepRecovered")}</span>}
        {/* A step back in the queue after a failed turn. Without this it is a `pending` row with a
            red error under it and nothing saying the chain is about to try again by itself — which
            reads as "it stopped", the exact thing the auto-retry exists to stop happening. */}
        {step.status === "pending" && step.attempts > 0 && (
          <span className={chipClass("warn")}>
            <RotateCcw size={11} />
            {step.last_error === "chain.checkFailed"
              ? t("agents.stepRejected")
              : t("agents.stepRetrying", { n: step.attempts + 1, max: MAX_STEP_ATTEMPTS })}
          </span>
        )}
        {step.task_id !== "" && !taskExists && <span className={chipClass("neutral")}>{t("agents.stepTaskGone")}</span>}
        {/* Only while nothing is running, and on every step rather than only the failed ones: the
            common reason to send a plan back is not that it broke but that you have looked at what
            it did and want it done differently. */}
        {idle && (
          <Tooltip label={t("agents.rerunFromHere")}>
            <button
              type="button"
              onClick={() => setRerun((current) => (current === null ? "" : null))}
              aria-label={t("agents.rerunFromHere")}
              aria-pressed={rerun !== null}
              className={iconButtonClass({ size: "xs", active: rerun !== null })}
            >
              <RotateCcw size={13} />
            </button>
          </Tooltip>
        )}
      </div>

      {rerun !== null && (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            value={rerun}
            onChange={(e) => setRerun(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRerun(null);
              if (e.key !== "Enter") return;
              e.preventDefault();
              void useChainStore.getState().rerunFrom(step.chain_id, step.step_index, rerun);
              setRerun(null);
            }}
            placeholder={t("agents.rerunNotePlaceholder")}
            className={fieldClass({ size: "sm", className: "flex-1" })}
          />
          <button
            type="button"
            onClick={() => {
              void useChainStore.getState().rerunFrom(step.chain_id, step.step_index, rerun);
              setRerun(null);
            }}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            {t("agents.rerunGo")}
          </button>
        </div>
      )}

      {/* The run card, and with it the one orb this step's run wears in the pane. */}
      {running && step.run_id && live && (
        <div className="mt-2.5">
          <AiRunLog runId={step.run_id} running expanded={logOpen} onToggle={() => setLogOpen((v) => !v)} />
        </div>
      )}

      {/* What this step is verified by, and where a failure sends the plan. On the row rather than
          behind an expander: a plan that loops is a different plan, and reading it as a straight
          list because the back-edge was one click away is the misreading worth spending a line on. */}
      {(step.check_command !== "" || step.on_fail >= 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
          {step.check_command !== "" && (
            <span className="flex min-w-0 items-center gap-1.5">
              <TerminalSquare size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
              <code className="min-w-0 truncate font-mono">{step.check_command}</code>
            </span>
          )}
          {step.on_fail >= 0 && (
            <span className={chipClass("warn")}>
              <Undo2 size={11} />
              {t("agents.stepLoopsTo", { n: step.on_fail + 1 })}
            </span>
          )}
        </div>
      )}

      {/* Why it was sent back, in the words of the step that sent it. Only while it is still
          waiting to run again — once it passes, the backend clears this, and a stale complaint
          under a green step would be the pane disagreeing with itself. */}
      {step.feedback !== "" && step.status === "pending" && (
        <p className="mt-2 max-h-32 select-text overflow-auto whitespace-pre-wrap rounded-md bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
          {step.feedback}
        </p>
      )}

      {step.last_error && (
        <p className="mt-2 flex items-start gap-1.5 whitespace-pre-wrap break-words text-[12px] text-[var(--cf-danger)]">
          <TriangleAlert size={13} className="mt-[2px] shrink-0" />
          <span className="min-w-0">{reasonText(step.last_error, t)}</span>
        </p>
      )}

      {step.output_text && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-2 mt-1.5" })}
          >
            <ChevronRight size={13} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
            {t("agents.stepOutput")}
          </button>
          {/* The step's own answer — selectable, since the reason to expand it is to take
              something out of it and feed it somewhere else. */}
          {open && (
            <p className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap rounded-md bg-[var(--cf-sunken)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
              {step.output_text}
            </p>
          )}
          {step.output_truncated && (
            <p className="mt-1 text-[11px] text-[var(--cf-warning)]">{t("agents.outputTruncated")}</p>
          )}
        </>
      )}
    </div>
  );
}
