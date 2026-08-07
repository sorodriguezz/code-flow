import { useEffect, useState } from "react";
import {
  Check,
  ExternalLink,
  FolderGit2,
  GitCompare,
  Link2,
  Play,
  SkipForward,
  Square,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  Undo2,
  Wand2,
} from "lucide-react";
import { chainStatusOf, reasonText, stepColor } from "./chainStatus";
import { StoryPlanGate } from "./StoryPlanGate";
import { AiRunLog } from "../ai/AiRunLog";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useAgentsStore } from "../../state/agentsStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useChainStore } from "../../state/chainStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { AgentChainStep, ChainRepo } from "../../types/domain";

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
  // Resolved, not finished-well: a skipped step is one the plan is past. `step_count` is the
  // denominator the plan was authored with, so a chain whose steps have not loaded yet reads 0%
  // rather than 0/0.
  const resolved = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  const stepTotal = Math.max(steps.length, chain.step_count);
  const progressPct = stepTotal > 0 ? Math.round((resolved / stepTotal) * 100) : 0;
  const { icon: StatusIcon, color, labelKey } = chainStatusOf(chain);
  const reason = reasonText(chain.last_reason, t);
  const store = useChainStore.getState();

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
      {/* Same 29px as the rails either side — see the note on the task header. */}
      <div className="flex h-[29px] shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        {chain.kind === "story" ? (
          <Wand2 size={14} className="shrink-0 text-[var(--cf-accent)]" />
        ) : (
          <Link2 size={14} className="shrink-0 text-[var(--cf-accent)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={chain.goal || chain.title}>
          {chain.title}
        </span>
        {chain.work_item_url && (
          <button
            type="button"
            onClick={() => void openExternalUrl(chain.work_item_url).catch((e: unknown) => pushErrorToast(String(e)))}
            title={t("agents.storyOpenBoard")}
            className="flex shrink-0 items-center gap-1 rounded bg-black/[0.05] px-1.5 py-[1px] text-[10px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] dark:bg-white/[0.07]"
          >
            {chain.work_item_key || `#${chain.work_item_id}`}
            <ExternalLink size={9} />
          </button>
        )}
        <span className={`flex shrink-0 items-center gap-1.5 text-[11px] ${color}`}>
          {chain.status === "running" ? <ThinkingOrb size="sm" /> : <StatusIcon size={12} />}
          <span className="truncate">{t(labelKey)}</span>
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {t("agents.stepN", { n: chain.current_step + 1, total: chain.step_count })}
        </span>
        {/* One repository reads as its name; several read as a count, because the names would not
            fit and the number is the thing that changes how you read the plan below. */}
        {chain.repo_count > 1 ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
            <FolderGit2 size={11} />
            {t("agents.chainRepos", { n: chain.repo_count })}
          </span>
        ) : (
          projectName && (
            <span className="max-w-[160px] shrink-0 truncate text-[11px] text-[var(--cf-text-muted)]">
              {projectName}
            </span>
          )
        )}
      </div>

      {/* The plan's own progress, hairline-thin and directly under its title. A chain is the one
          thing in this app that genuinely knows how far along it is — steps are countable, unlike
          the inside of a single run — so this is determinate where `AiRunLog`'s bar cannot be. It
          counts skipped steps as passed: they are resolved, and a bar that stalled on them would
          say the plan was stuck when it is moving. */}
      <div className="h-[2px] shrink-0 bg-black/[0.06] dark:bg-white/[0.08]">
        <div className="cf-chain-progress h-full" style={{ width: `${progressPct}%` }} />
      </div>

      <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-black/[0.02] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-warning)] dark:bg-white/[0.03]">
        <TriangleAlert size={11} className="mt-[2px] shrink-0" />
        <span>
          {t("agents.writesWorkingTree")}
          {/* Every repository the chain can write to, named. A warning that names one working copy
              while the plan can edit five is worse than no warning. */}
          {repos.length > 0
            ? ` — ${repos.map((repo) => repo.name || t("chain.projectGone")).join(" · ")}`
            : projectName
              ? ` — ${projectName}`
              : ""}
        </span>
      </p>

      {reason && (
        <p className="shrink-0 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
          {reason}
        </p>
      )}

      {/* No `space-y` any more: the gap between two steps is the rail, and a margin on top of it
          would break the line the rail exists to draw. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {chain.goal.trim() !== "" && (
          <p className="mb-2 whitespace-pre-wrap rounded-lg border border-dashed border-[var(--cf-border)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {chain.goal}
          </p>
        )}
        {steps.map((step, at) => {
          const next = steps[at + 1];
          return (
            <div key={step.id}>
              {/* The two halves of a story run, named. 2N rows in one flat list is honest about what
                  runs but says nothing about the shape, and the shape — read everything, stop, then
                  write some of it — is the whole point of the feature. */}
              {step.phase !== "" && step.phase !== steps[at - 1]?.phase && (
                <p className="mb-1 mt-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {t(step.phase === "analyze" ? "agents.storyPhaseAnalyze" : "agents.storyPhaseImplement")}
                </p>
              )}
              <StepRow step={step} isGate={gated && step.id === waiting?.id} showRepo={chain.repo_count > 1} />
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

      {planGate ? (
        <StoryPlanGate chain={chain} steps={steps} />
      ) : (
        gated && (
          <div className="shrink-0 border-t border-[var(--cf-border)] px-3 py-2">
            <p className="mb-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("agents.gatePreview")}</p>
            <textarea
              value={draft ?? ""}
              rows={6}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
            />
          </div>
        )
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[var(--cf-border)] px-3 py-2">
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
            <Action primary icon={Check} label={t("agents.approveContinue")} onClick={() => void store.approve(chainId, draft ?? "")} />
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
        <span className="ml-auto flex items-center gap-1.5">
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
      {/* 20px, so the 2px rail straddles 20–22 and its centre lands on the badge's: 1px border +
          10px of `px-2.5` + half of the 20px number circle. */}
      <div className={`cf-chain-rail ml-[20px] h-3 ${carried ? "cf-chain-rail-done" : ""}`}>
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
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium ${
        primary
          ? "bg-[var(--cf-accent)] text-white hover:brightness-110"
          : danger
            ? "border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
            : "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function StepRow({
  step,
  isGate,
  showRepo,
}: {
  step: AgentChainStep;
  isGate: boolean;
  /** Only when the chain has more than one: with one repository every step runs there, and a badge
   * repeating it on every row is noise. */
  showRepo: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const select = useAgentsStore((s) => s.select);
  const taskExists = useAgentsStore((s) => s.tasks.some((task) => task.id === step.task_id));
  // Whether the run behind this step is still ours. A step marked `running` with no live run is
  // one whose engine outlived a webview reload — the work is coming back, but there is no log to
  // show for it, and saying so beats a spinner that never moves.
  const live = useAiRunStore((s) => (step.run_id ? (s.active[step.run_id] ?? false) : false));

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${
        isGate ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-[10px] font-semibold tabular-nums dark:bg-white/[0.1]">
          {step.step_index + 1}
        </span>
        {step.status === "running" ? (
          <ThinkingOrb size="sm" />
        ) : (
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stepColor(step.status).replace("text-", "bg-")}`} />
        )}
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
          className="min-w-0 flex-1 text-left"
          title={step.instruction}
        >
          <span className="block truncate text-[12.5px] text-[var(--cf-text)]">
            {step.agent_name || t("settings.sddNewAgent")}
          </span>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{step.instruction}</span>
        </button>
        {showRepo && (
          <span className="flex max-w-[140px] shrink-0 items-center gap-1 truncate text-[10.5px] text-[var(--cf-text-muted)]">
            <FolderGit2 size={10} className="shrink-0" />
            {step.project_name || t("chain.projectGone")}
          </span>
        )}
        {step.gate && (
          <span className="shrink-0 rounded bg-black/[0.05] px-1.5 py-[1px] text-[10px] text-[var(--cf-text-muted)] dark:bg-white/[0.07]">
            {t("agents.gateBefore")}
          </span>
        )}
        {step.status === "running" && !live && (
          <span className="shrink-0 text-[10px] text-[var(--cf-warning)]">{t("agents.stepRecovered")}</span>
        )}
        {/* A step back in the queue after a failed turn. Without this it is a `pending` row with a
            red error under it and nothing saying the chain is about to try again by itself — which
            reads as "it stopped", the exact thing the auto-retry exists to stop happening. */}
        {step.status === "pending" && step.attempts > 0 && (
          <span className="shrink-0 text-[10px] text-[var(--cf-warning)]">
            {step.last_error === "chain.checkFailed"
              ? t("agents.stepRejected")
              : t("agents.stepRetrying", { n: step.attempts + 1, max: MAX_STEP_ATTEMPTS })}
          </span>
        )}
        {step.task_id !== "" && !taskExists && (
          <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">{t("agents.stepTaskGone")}</span>
        )}
      </div>

      {step.status === "running" && step.run_id && live && (
        <div className="mt-1.5">
          <AiRunLog runId={step.run_id} running expanded={logOpen} onToggle={() => setLogOpen((v) => !v)} />
        </div>
      )}

      {/* What this step is verified by, and where a failure sends the plan. On the row rather than
          behind an expander: a plan that loops is a different plan, and reading it as a straight
          list because the back-edge was one click away is the misreading worth spending a line on. */}
      {(step.check_command !== "" || step.on_fail >= 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--cf-text-muted)]">
          {step.check_command !== "" && (
            <span className="flex min-w-0 items-center gap-1">
              <TerminalSquare size={10} className="shrink-0" />
              <code className="min-w-0 truncate font-mono">{step.check_command}</code>
            </span>
          )}
          {step.on_fail >= 0 && (
            <span className="flex shrink-0 items-center gap-1 text-[var(--cf-warning)]">
              <Undo2 size={10} />
              {t("agents.stepLoopsTo", { n: step.on_fail + 1 })}
            </span>
          )}
        </div>
      )}

      {/* Why it was sent back, in the words of the step that sent it. Only while it is still
          waiting to run again — once it passes, the backend clears this, and a stale complaint
          under a green step would be the pane disagreeing with itself. */}
      {step.feedback !== "" && step.status === "pending" && (
        <p className="mt-1.5 max-h-32 select-text overflow-auto whitespace-pre-wrap rounded-md bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
          {step.feedback}
        </p>
      )}

      {step.last_error && (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] text-[var(--cf-danger)]">
          {reasonText(step.last_error, t)}
        </p>
      )}

      {step.output_text && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1.5 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            {open ? "▾" : "▸"} {t("agents.stepOutput")}
          </button>
          {/* The step's own answer — selectable, since the reason to expand it is to take
              something out of it and feed it somewhere else. */}
          {open && (
            <p className="mt-1 max-h-40 select-text overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--cf-text-muted)] dark:bg-white/[0.04]">
              {step.output_text}
            </p>
          )}
          {step.output_truncated && (
            <p className="mt-1 text-[10.5px] text-[var(--cf-warning)]">{t("agents.outputTruncated")}</p>
          )}
        </>
      )}
    </div>
  );
}
