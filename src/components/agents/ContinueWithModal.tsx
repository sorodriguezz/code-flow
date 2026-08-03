import { useEffect, useMemo, useState } from "react";
import { Link2 } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { AI_PROVIDERS, modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { isRunnableAgent, useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { isProviderReady, useProviderStatusStore } from "../../state/providerStatusStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/**
 * "Carry on from here" — the smallest useful chain, and the one people actually reach for.
 *
 * A finished task becomes step 1 of a new chain, already done, with its answer as the handoff. The
 * user picks who goes next and what they should do with it. Nothing is copied by hand and the
 * original task is untouched: it keeps its own transcript and simply gains a place in a plan.
 */
export function ContinueWithModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const t = useT();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === taskId) ?? null);
  const roster = useAgentsStore((s) => s.roster);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);

  const runnable = useMemo(() => roster.filter(isRunnableAgent), [roster]);
  const [agentId, setAgentId] = useState(() => runnable[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");
  const [gate, setGate] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Object.keys(statuses).length === 0) void checkAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!task) return null;
  const agent = runnable.find((a) => a.id === agentId) ?? null;
  const canStart = !busy && agent !== null && instruction.trim() !== "";

  const submit = async (start: boolean) => {
    if (!canStart || !agent) return;
    setBusy(true);
    try {
      await useChainStore.getState().continueFrom({
        sourceTaskId: taskId,
        title: task.title,
        goal: task.goal,
        steps: [{ agent_id: agent.id, instruction, gate }],
        // The chain carries on the task's work, so it is filed where that task was — asking again
        // here would be asking the same question twice about one piece of work.
        agentProjectId: task.agent_project_id,
        start,
      });
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={Link2}
      title={t("agents.continueTitle")}
      subtitle={t("agents.continueSubtitle")}
      width="max-w-lg"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </GhostButton>
          <span className="ml-auto flex items-center gap-2">
            <GhostButton onClick={() => void submit(false)} disabled={!canStart}>
              {t("agents.createChainOnly")}
            </GhostButton>
            <PrimaryButton onClick={() => void submit(true)} disabled={!canStart}>
              {t("agents.startChain")}
            </PrimaryButton>
          </span>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {runnable.length === 0 && <Note tone="warning">{t("agents.agentIncomplete")}</Note>}
        {task.turns === 0 && <Note tone="warning">{t("agents.continueNeedsAnswer")}</Note>}

        <Field label={t("agents.continueSource")}>
          <p className="rounded-md border border-dashed border-[var(--cf-border)] px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)]">
            {task.agent_name || t("settings.sddNewAgent")} · {task.title}
          </p>
        </Field>

        <Field label={t("agents.agent")} hint={agent?.role.trim() || undefined}>
          <Select
            size="field"
            value={agentId}
            placeholder={t("agents.pickAgent")}
            ariaLabel={t("agents.agent")}
            onChange={setAgentId}
            options={runnable.map((a) => ({
              value: a.id,
              label: `${a.name || t("settings.sddNewAgent")} — ${providerDisplayLabel(a.provider, t)} · ${modelDisplayLabel(
                a.provider,
                a.model,
                t,
              )}`,
              icon: AI_PROVIDERS.find((p) => p.id === a.provider)?.icon,
              disabled: !isProviderReady(statuses, a.provider),
            }))}
          />
        </Field>

        <Field label={t("agents.chainSteps")}>
          <textarea
            autoFocus
            value={instruction}
            rows={5}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={t("agents.stepInstructionPlaceholder")}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        <label className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <Checkbox checked={gate} onChange={setGate} />
          {t("agents.gateBefore")}
        </label>
      </div>
    </ApiModal>
  );
}
