import { useEffect, useMemo, useState } from "react";
import { Bot, Plus } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { AI_PROVIDERS, modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { isRunnableAgent, useAgentsStore } from "../../state/agentsStore";
import { isProviderReady, useProviderStatusStore } from "../../state/providerStatusStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";

/**
 * Air's first step, as a dialog: who does the work, where, and what the work is.
 *
 * All three are decided here and not later because two of them are effectively final — the agent
 * is what the task *is*, and the repository is the working copy its turns will edit — so asking
 * for them up front is what keeps the task detail from having to explain why they are greyed out.
 * The folder is the odd one out: it can be changed from the list whenever, and is asked for here
 * only so that opening this dialog from inside a folder lands the task in it.
 *
 * Starting the task also sends the goal as its first turn. A task that exists but has said nothing
 * is a row that looks like work and isn't; if the user wanted to think about it longer they can
 * close the dialog.
 */
export function NewTaskModal({
  onClose,
  onManageAgents,
  initialAgentProjectId = "",
  suspended = false,
}: {
  onClose: () => void;
  onManageAgents: () => void;
  /** The folder the task is filed under to begin with — set when the dialog was opened from one. */
  initialAgentProjectId?: string;
  /** True while the agent editor is stacked on top of this dialog. Passed to `ApiModal`'s `busy`,
   * which is what takes this dialog's own Escape handler out of the window: both modals bind one,
   * neither can stop the other's, so a single Escape meant to back out of the editor was closing
   * this one underneath it — taking the typed goal with it. */
  suspended?: boolean;
}) {
  const t = useT();
  const roster = useAgentsStore((s) => s.roster);
  const agentProjects = useAgentsStore((s) => s.projects);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projects = useActiveProjects();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);

  const runnable = useMemo(() => roster.filter(isRunnableAgent), [roster]);

  const [agentId, setAgentId] = useState(() => runnable[0]?.id ?? "");
  const [projectId, setProjectId] = useState(
    () => (activeProjectId && projects.some((p) => p.id === activeProjectId) ? activeProjectId : projects[0]?.id) ?? "",
  );
  const [agentProjectId, setAgentProjectId] = useState(() =>
    agentProjects.some((p) => p.id === initialAgentProjectId) ? initialAgentProjectId : "",
  );
  const [goal, setGoal] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (Object.keys(statuses).length === 0) void checkAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The roster can be edited from behind this dialog ("new agent" opens the editor over it), so the
  // selection follows the list rather than being fixed at mount.
  useEffect(() => {
    if (!runnable.some((a) => a.id === agentId)) setAgentId(runnable[0]?.id ?? "");
  }, [runnable, agentId]);

  const agent = runnable.find((a) => a.id === agentId) ?? null;
  const providerMissing = agent !== null && !isProviderReady(statuses, agent.provider);
  const canStart =
    !starting && agent !== null && projectId !== "" && goal.trim() !== "" && workspaceId !== null && !providerMissing;

  const start = async () => {
    if (!agent || !canStart) return;
    setStarting(true);
    try {
      const task = await useAgentsStore.getState().create({ projectId, agent, goal, agentProjectId });
      useAgentsStore.getState().send(task.id, goal);
      onClose();
    } finally {
      setStarting(false);
    }
  };

  return (
    <ApiModal
      icon={Bot}
      title={t("agents.newTaskTitle")}
      subtitle={t("agents.newTaskSubtitle")}
      width="max-w-lg"
      busy={starting || suspended}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onManageAgents} disabled={starting}>
            <Plus size={13} />
            {t("agents.newAgent")}
          </GhostButton>
          <span className="ml-auto flex items-center gap-2">
            <GhostButton onClick={onClose} disabled={starting}>
              {t("common.cancel")}
            </GhostButton>
            <PrimaryButton onClick={() => void start()} disabled={!canStart}>
              {t("agents.start")}
            </PrimaryButton>
          </span>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {runnable.length === 0 && <Note tone="warning">{t("agents.agentIncomplete")}</Note>}
        {runnable.length > 0 && projects.length === 0 && (
          <Note tone="warning">{`${t("agents.noProjects")} — ${t("agents.noProjectsHint")}`}</Note>
        )}
        {providerMissing && <Note tone="warning">{t("settings.providerMissing")}</Note>}

        {/* The role rides the agent field rather than sitting at the foot of the form: down there
            it read as a note about the goal, which is the one thing it is not. */}
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

        <Field label={t("agents.repository")} hint={t("agents.repositoryHint")}>
          <Select
            size="field"
            value={projectId}
            ariaLabel={t("agents.repository")}
            onChange={setProjectId}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
          />
        </Field>

        {/* Filing, never routing — and directly under the field that *is* routing, which is the one
            place a user could reasonably read the two as the same thing. Hence the hint, and hence
            "no project" being an ordinary option rather than an empty select: leaving it alone has
            to look like a decision, not like something left unfilled. */}
        <Field label={t("agents.project")} hint={t("agents.projectHint")}>
          <Select
            size="field"
            value={agentProjectId}
            ariaLabel={t("agents.project")}
            onChange={setAgentProjectId}
            options={[
              { value: "", label: t("agents.projectNone") },
              ...agentProjects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </Field>

        <Field label={t("agents.goal")}>
          <textarea
            autoFocus
            value={goal}
            rows={7}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter starts it without reaching for the mouse; a bare Enter keeps making
              // paragraphs, because a goal is usually more than one line.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void start();
              }
            }}
            placeholder={t("agents.goalPlaceholder")}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>
      </div>
    </ApiModal>
  );
}
