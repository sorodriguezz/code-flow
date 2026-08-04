import { useEffect, useState } from "react";
import { Check, GitCompare, Link2, Play, SkipForward, Square, Trash2, TriangleAlert } from "lucide-react";
import { chainStatusOf, reasonText, stepColor } from "./chainStatus";
import { AiRunLog } from "../ai/AiRunLog";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useAgentsStore } from "../../state/agentsStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useChainStore } from "../../state/chainStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { AgentChainStep } from "../../types/domain";

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

  useEffect(() => {
    setDraft(gated ? (waiting?.pending_input ?? "") : null);
    // Keyed on the step, not on the chain: re-seeding on every chain write would wipe an edit
    // being typed while a sibling field updates.
  }, [gated, waiting?.id, waiting?.pending_input]);

  if (!chain) return null;
  const { icon: StatusIcon, color, labelKey } = chainStatusOf(chain);
  const reason = reasonText(chain.last_reason, t);
  const store = useChainStore.getState();

  const openChanges = () => {
    void focusProject(useWorkspaceStore.getState().activeWorkspaceId ?? "", chain.project_id).then(() =>
      setActiveView("changes"),
    );
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
        <Link2 size={14} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={chain.goal || chain.title}>
          {chain.title}
        </span>
        <span className={`flex shrink-0 items-center gap-1.5 text-[11px] ${color}`}>
          {chain.status === "running" ? <ThinkingOrb size="sm" /> : <StatusIcon size={12} />}
          <span className="truncate">{t(labelKey)}</span>
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {t("agents.stepN", { n: chain.current_step + 1, total: chain.step_count })}
        </span>
        {projectName && (
          <span className="max-w-[160px] shrink-0 truncate text-[11px] text-[var(--cf-text-muted)]">
            {projectName}
          </span>
        )}
      </div>

      <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-black/[0.02] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-warning)] dark:bg-white/[0.03]">
        <TriangleAlert size={11} className="mt-[2px] shrink-0" />
        <span>
          {t("agents.writesWorkingTree")}
          {projectName ? ` — ${projectName}` : ""}
        </span>
      </p>

      {reason && (
        <p className="shrink-0 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
          {reason}
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {chain.goal.trim() !== "" && (
          <p className="whitespace-pre-wrap rounded-lg border border-dashed border-[var(--cf-border)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {chain.goal}
          </p>
        )}
        {steps.map((step) => (
          <StepRow key={step.id} step={step} isGate={gated && step.id === waiting?.id} />
        ))}
      </div>

      {gated && (
        <div className="shrink-0 border-t border-[var(--cf-border)] px-3 py-2">
          <p className="mb-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("agents.gatePreview")}</p>
          <textarea
            value={draft ?? ""}
            rows={6}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </div>
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
        {gated && (
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

function StepRow({ step, isGate }: { step: AgentChainStep; isGate: boolean }) {
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
        {step.gate && (
          <span className="shrink-0 rounded bg-black/[0.05] px-1.5 py-[1px] text-[10px] text-[var(--cf-text-muted)] dark:bg-white/[0.07]">
            {t("agents.gateBefore")}
          </span>
        )}
        {step.status === "running" && !live && (
          <span className="shrink-0 text-[10px] text-[var(--cf-warning)]">{t("agents.stepRecovered")}</span>
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
          {open && (
            <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-black/[0.03] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--cf-text-muted)] dark:bg-white/[0.04]">
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
