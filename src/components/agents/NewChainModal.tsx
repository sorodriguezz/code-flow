import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, BookmarkPlus, Link2, Plus, Trash2 } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { AI_PROVIDERS, modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { isRunnableAgent, useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { isProviderReady, useProviderStatusStore } from "../../state/providerStatusStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { NewChainStep } from "../../types/domain";

/** Mirrors `queries::MAX_CHAIN_STEPS`. The backend refuses past it too — a cap enforced only here
 * is a cap a stale window can walk through. */
const MAX_STEPS = 8;

interface DraftStep extends NewChainStep {
  /** Local only: a stable key so reordering does not remount every row. */
  key: string;
}

let nextKey = 0;
const draft = (agentId: string): DraftStep => ({
  key: `s${nextKey++}`,
  agent_id: agentId,
  instruction: "",
  gate: false,
});

/**
 * Authoring a chain: one repository, one objective, and an ordered list of agents with an
 * instruction each.
 *
 * All of it is decided here because none of it can move afterwards without lying: the repository
 * is the working copy every step will edit, and each step's agent is snapshotted the moment this
 * dialog is submitted, so a roster edited next week does not rewrite a plan that is already
 * running.
 */
export function NewChainModal({ onClose, onManageAgents }: { onClose: () => void; onManageAgents: () => void }) {
  const t = useT();
  const roster = useAgentsStore((s) => s.roster);
  const templates = useChainStore((s) => s.templates);
  const projects = useActiveProjects();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);

  const runnable = useMemo(() => roster.filter(isRunnableAgent), [roster]);

  const [projectId, setProjectId] = useState(
    () => (activeProjectId && projects.some((p) => p.id === activeProjectId) ? activeProjectId : projects[0]?.id) ?? "",
  );
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>(() => [draft(""), draft("")]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Object.keys(statuses).length === 0) void checkAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The roster can be edited from behind this dialog, so a step pointing at an agent that stopped
  // being runnable is cleared rather than silently submitted with a blank routing.
  useEffect(() => {
    setSteps((current) =>
      current.map((step) =>
        step.agent_id && !runnable.some((a) => a.id === step.agent_id) ? { ...step, agent_id: "" } : step,
      ),
    );
  }, [runnable]);

  const patch = (key: string, change: Partial<DraftStep>) =>
    setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...change } : step)));

  const move = (index: number, delta: number) =>
    setSteps((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const gateAll = steps.length > 1 && steps.slice(1).every((step) => step.gate);
  const setGateAll = (on: boolean) =>
    setSteps((current) => current.map((step, i) => (i === 0 ? step : { ...step, gate: on })));

  const ready = steps.filter((step) => step.agent_id && step.instruction.trim());
  const canStart = !busy && projectId !== "" && ready.length > 0 && ready.length === steps.length;

  /** Fills the form from a saved plan. A step whose agent has since been deleted comes back empty
   * for the user to re-point, rather than being dropped — a plan quietly one step shorter is worse
   * than one with an obvious hole. */
  const applyTemplate = (templateId: string) => {
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) return;
    setTitle((current) => current || template.name);
    setSteps(
      template.steps.map((step) => ({
        key: `s${nextKey++}`,
        agent_id: runnable.some((a) => a.id === step.agent_id) ? step.agent_id : "",
        instruction: step.instruction,
        gate: step.gate,
      })),
    );
  };

  const saveAsTemplate = async () => {
    const name = title.trim();
    if (!name) return;
    await useChainStore.getState().saveTemplate({
      name,
      description: goal.trim(),
      steps: steps.map(({ agent_id, instruction, gate }) => ({ agent_id, instruction, gate })),
    });
    useToastStore.getState().pushToast(t("agents.templateSaved"), "success");
  };

  const submit = async (start: boolean) => {
    if (!canStart) return;
    setBusy(true);
    try {
      await useChainStore.getState().create({
        projectId,
        title: title.trim() || goal.trim().split("\n")[0].slice(0, 64) || t("agents.newChain"),
        goal,
        steps: steps.map(({ agent_id, instruction, gate }) => ({ agent_id, instruction, gate })),
        start,
      });
      onClose();
    } catch (e) {
      // Surfaced rather than swallowed: the backend refuses a plan that is empty or too long, and
      // a dialog that just closes on a rejected create is how a user ends up with nothing and no
      // idea why.
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={Link2}
      title={t("agents.newChainTitle")}
      subtitle={t("agents.newChainSubtitle")}
      width="max-w-2xl"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onManageAgents} disabled={busy}>
            <Plus size={13} />
            {t("agents.newAgent")}
          </GhostButton>
          <GhostButton
            onClick={() => void saveAsTemplate()}
            disabled={busy || !canStart || !title.trim()}
            title={t("agents.saveTemplateHint")}
          >
            <BookmarkPlus size={13} />
            {t("agents.saveTemplate")}
          </GhostButton>
          <span className="ml-auto flex items-center gap-2">
            <GhostButton onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </GhostButton>
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
        {projects.length === 0 && (
          <Note tone="warning">{`${t("agents.noProjects")} — ${t("agents.noProjectsHint")}`}</Note>
        )}

        {templates.length > 0 && (
          <Field label={t("agents.template")}>
            <Select
              size="field"
              value=""
              placeholder={t("agents.templateNone")}
              ariaLabel={t("agents.template")}
              // Deliberately not a controlled "current template": applying one *fills the form* and
              // then lets go. A chain that stayed bound to its template would silently change when
              // the template did, which is the property running chains must not have.
              onChange={applyTemplate}
              options={templates.map((template) => ({
                value: template.id,
                label: `${template.name} — ${t("agents.templateStepsN", { n: template.steps.length })}`,
              }))}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("agents.repository")} hint={t("agents.repositoryHint")}>
            <Select
              size="field"
              value={projectId}
              ariaLabel={t("agents.repository")}
              onChange={setProjectId}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Field>
          <Field label={t("agents.chainName")}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("agents.chainNamePlaceholder")}
              className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
            />
          </Field>
        </div>

        <Field label={t("agents.goal")}>
          <textarea
            autoFocus
            value={goal}
            rows={3}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t("agents.goalPlaceholder")}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("agents.chainSteps")}</span>
            <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              {t("agents.stepsCount", { n: steps.length, max: MAX_STEPS })}
            </span>
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
              <Checkbox checked={gateAll} onChange={setGateAll} />
              {t("agents.gateAll")}
            </label>
          </div>

          <div className="space-y-2">
            {steps.map((step, index) => (
              <div key={step.key} className="rounded-lg border border-[var(--cf-border)] p-2">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-[10px] font-semibold tabular-nums dark:bg-white/[0.1]">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <Select
                      size="sm"
                      value={step.agent_id}
                      placeholder={t("agents.pickAgent")}
                      ariaLabel={t("agents.agent")}
                      onChange={(value) => patch(step.key, { agent_id: value })}
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
                  </span>
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    title={t("agents.chainSteps")}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === steps.length - 1}
                    title={t("agents.chainSteps")}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSteps((current) => current.filter((s) => s.key !== step.key))}
                    disabled={steps.length === 1}
                    title={t("common.delete")}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] disabled:opacity-30 dark:hover:bg-white/[0.08]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <textarea
                  value={step.instruction}
                  rows={2}
                  onChange={(e) => patch(step.key, { instruction: e.target.value })}
                  placeholder={t("agents.stepInstructionPlaceholder")}
                  className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
                />
                {/* Not offered on the first step: there is nothing before it to review. */}
                {index > 0 && (
                  <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
                    <Checkbox checked={step.gate} onChange={(on) => patch(step.key, { gate: on })} />
                    {t("agents.gateBefore")}
                  </label>
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setSteps((current) => [...current, draft("")])}
            disabled={steps.length >= MAX_STEPS}
            className="mt-2 flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-40 disabled:hover:border-[var(--cf-border)] disabled:hover:text-[var(--cf-text)]"
          >
            <Plus size={13} />
            {t("agents.addStep")}
          </button>
        </div>
      </div>
    </ApiModal>
  );
}
