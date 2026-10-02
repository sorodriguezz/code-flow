import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, RotateCcw } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Tooltip } from "../common/Tooltip";
import { buttonClass } from "../common/Button";
import { chipClass, fieldClass } from "../common/recipes";
import { tokensLabel } from "../settings/LocalModelSettings";
import { useChainStore } from "../../state/chainStore";
import { useHybridStore } from "../../state/hybridStore";
import { useT } from "../../state/languageStore";
import { filePath, repoName } from "./hybridText";
import type { HybridCheck, HybridItem, HybridItemEdit } from "../../lib/tauri/hybridCommands";
import type { AgentChain, AgentChainStep } from "../../types/domain";

/**
 * A hybrid run's plan, waiting for a yes: what the subscription wrote, task by task, before the
 * local model writes any of it.
 *
 * Everything here is a decision the plan can still take for free — leave a task out, rewrite its
 * instruction, send it to the subscription instead of the local model, tick which of the proposed
 * checks may run. Nothing is written until **Ejecutar**, and what it writes is exactly what is on
 * screen. A plan that is wrong as a whole goes back to the planner with a sentence about why.
 *
 * Checks start unticked unless this repository approved the same command before, or a template the
 * user wrote brought it: they run in the user's own shell, and a model proposing a command is not
 * the user agreeing to it.
 */
export function HybridPlanGate({ chain, steps }: { chain: AgentChain; steps: AgentChainStep[] }) {
  const t = useT();
  const view = useHybridStore((s) => s.views[chain.id]);
  const gateStep = steps.find((step) => step.status === "pending" && step.phase === "execute");

  useEffect(() => {
    void useHybridStore.getState().load(chain.id);
  }, [chain.id, chain.updated_at]);

  /** Per item: the gate's edits. Seeded once per item and never re-seeded, so typing survives the
   *  chain's own writes. */
  const [edits, setEdits] = useState<Record<string, HybridItemEdit>>({});
  const [checks, setChecks] = useState<HybridCheck[] | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [redo, setRedo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!view) return;
    setEdits((current) => {
      const missing = view.items.filter((item) => !(item.id in current));
      if (missing.length === 0) return current;
      const next = { ...current };
      for (const item of missing) {
        next[item.id] = { id: item.id, instruction: item.instruction, assignee: item.assignee, enabled: item.enabled };
      }
      return next;
    });
    setChecks(
      (current) =>
        current ??
        view.run.checks.filter(
          (check) => hasCheck(view.trusted_checks, check) || hasCheck(view.run.approved_checks, check),
        ),
    );
  }, [view]);

  const counts = useMemo(() => {
    const kept = Object.values(edits).filter((edit) => edit.enabled);
    return { local: kept.filter((e) => e.assignee === "local").length, sub: kept.filter((e) => e.assignee === "sub").length };
  }, [edits]);

  if (!view || !gateStep) return null;
  const { run, items } = view;

  const patch = (item: HybridItem, change: Partial<HybridItemEdit>) =>
    setEdits((current) => ({ ...current, [item.id]: { ...(current[item.id] ?? item), ...change } }));

  const approve = async () => {
    setBusy(true);
    try {
      const ok = await useChainStore.getState().approveHybrid({
        chainId: chain.id,
        stepId: gateStep.id,
        edits: items.map((item) => edits[item.id] ?? item),
        checks: checks ?? [],
        note,
      });
      if (ok) await useHybridStore.getState().load(chain.id);
    } finally {
      setBusy(false);
    }
  };

  const replan = () => {
    void useChainStore.getState().rerunFrom(chain.id, 0, redo ?? "");
    setRedo(null);
  };

  return (
    <div className="flex min-h-0 shrink-0 flex-col border-t border-[var(--cf-border)]">
      <div className="flex shrink-0 items-baseline gap-2 px-3 pb-1 pt-2">
        <span className="text-[12px] font-semibold">{t("agents.hybridPlanTitle")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]">
          {t("agents.hybridPlanBudget", { tokens: tokensLabel(run.budget_input), model: run.model, ctx: tokensLabel(run.ctx) })}
        </span>
      </div>
      {run.plan_summary.trim() !== "" && (
        <p className="shrink-0 px-3 pb-1.5 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{run.plan_summary}</p>
      )}

      <div className="max-h-[46vh] min-h-0 space-y-1.5 overflow-y-auto px-3 pb-2">
        {items.map((item) => {
          const edit = edits[item.id] ?? item;
          const expanded = open === item.id;
          return (
            <div
              key={item.id}
              className={`rounded-lg border px-2.5 py-1.5 ${edit.enabled ? "border-[var(--cf-border-strong)]" : "border-[var(--cf-border)] opacity-60"}`}
            >
              <div className="flex items-center gap-2">
                <Checkbox checked={edit.enabled} onChange={(on) => patch(item, { enabled: on })} />
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : item.id)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  title={item.title}
                >
                  <ChevronRight size={12} className={`shrink-0 text-[var(--cf-text-faint)] transition-transform ${expanded ? "rotate-90" : ""}`} />
                  <span className="min-w-0 truncate font-mono text-[12px] text-[var(--cf-text)]">{filePath(view, item.project_id, item.file)}</span>
                </button>
                <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{targetLabel(item, t)}</span>
                <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{t(DIFFICULTY_KEY[item.difficulty])}</span>
                <Tooltip label={t("agents.hybridAssigneeHint")}>
                  <button
                    type="button"
                    disabled={item.action === "delete"}
                    onClick={() => patch(item, { assignee: edit.assignee === "local" ? "sub" : "local" })}
                    className={chipClass(edit.assignee === "local" ? "ok" : "accent", "cursor-pointer disabled:cursor-default")}
                  >
                    {edit.assignee === "local" ? t("agents.hybridLocal") : t("agents.hybridSubscription")}
                  </button>
                </Tooltip>
              </div>
              {expanded && (
                <div className="mt-1.5 space-y-1.5 pl-6">
                  <textarea
                    value={edit.instruction}
                    rows={4}
                    onChange={(e) => patch(item, { instruction: e.target.value })}
                    className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
                  />
                  {item.context.length > 0 && (
                    <ul className="space-y-0.5 text-[11px] text-[var(--cf-text-muted)]">
                      {item.context.map((reference, at) => (
                        <li key={at} className="truncate">
                          <span className="font-mono">{filePath(view, reference.repo ?? item.project_id, reference.file)}</span>
                          {reference.start_line !== null && ` L${reference.start_line}–${reference.end_line ?? reference.start_line}`}
                          {reference.why && ` — ${reference.why}`}
                        </li>
                      ))}
                    </ul>
                  )}
                  {item.acceptance.length > 0 && (
                    <ul className="list-inside list-disc text-[11px] text-[var(--cf-text-muted)]">
                      {item.acceptance.map((line, at) => (
                        <li key={at}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {run.checks.length > 0 && (
          <div className="pt-1">
            <p className="mb-1 text-[11px] font-medium text-[var(--cf-text-muted)]">{t("agents.hybridChecks")}</p>
            {run.checks.map((check) => (
              <label key={`${check.repo} ${check.command}`} className="flex cursor-pointer items-center gap-2 py-0.5">
                <Checkbox
                  checked={hasCheck(checks ?? [], check)}
                  onChange={(on) =>
                    setChecks((current) => {
                      const list = current ?? [];
                      return on ? [...list, check] : list.filter((c) => !sameCheck(c, check));
                    })
                  }
                />
                {view.repos.length > 1 && (
                  <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{repoName(view, check.repo)}</span>
                )}
                <code className="min-w-0 truncate font-mono text-[12px]">{check.command}</code>
              </label>
            ))}
          </div>
        )}

        {run.plan_risks.length > 0 && (
          <ul className="list-inside list-disc pt-1 text-[11px] text-[var(--cf-text-muted)]">
            {run.plan_risks.map((risk, at) => (
              <li key={at}>{risk}</li>
            ))}
          </ul>
        )}

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("agents.hybridNotePlaceholder")}
          className={fieldClass({ size: "sm", className: "mt-1 w-full" })}
        />
      </div>

      {redo !== null && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-2">
          <input
            autoFocus
            value={redo}
            onChange={(e) => setRedo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRedo(null);
              if (e.key === "Enter") replan();
            }}
            placeholder={t("agents.hybridReplanPlaceholder")}
            className={fieldClass({ size: "sm", className: "flex-1" })}
          />
          <button type="button" onClick={replan} className={buttonClass({ variant: "primary", size: "sm" })}>
            {t("agents.hybridReplan")}
          </button>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-3 py-2">
        <button
          type="button"
          disabled={busy || counts.local + counts.sub === 0}
          onClick={() => void approve()}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          <Check size={12} />
          {t("agents.hybridExecute", { local: counts.local, sub: counts.sub })}
        </button>
        <button
          type="button"
          onClick={() => setRedo((current) => (current === null ? "" : null))}
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          <RotateCcw size={12} />
          {t("agents.hybridReplan")}
        </button>
      </div>
    </div>
  );
}

const sameCheck = (a: HybridCheck, b: HybridCheck) => a.repo === b.repo && a.command === b.command;
const hasCheck = (list: HybridCheck[], check: HybridCheck) => list.some((other) => sameCheck(other, check));

const DIFFICULTY_KEY = {
  easy: "agents.hybridEasy",
  medium: "agents.hybridMedium",
  hard: "agents.hybridHard",
} as const;

function targetLabel(item: HybridItem, t: ReturnType<typeof useT>): string {
  if (item.action === "create") return t("agents.hybridCreate");
  if (item.action === "delete") return t("agents.hybridDelete");
  if (item.regions.length === 0) return t("agents.hybridModify");
  return item.regions.map((region) => `L${region.start_line}–${region.end_line}`).join(", ");
}
