import { useEffect, useMemo, useState } from "react";
import { Bot, Plus } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { AI_PROVIDERS, isAgenticProvider, modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { isRunnableAgent, useAgentsStore } from "../../state/agentsStore";
import { isProviderReady, useProviderStatusStore } from "../../state/providerStatusStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { AgentTask } from "../../types/domain";

/** Mirrors `queries::MAX_CHAIN_REPOS`, and for the same reason rather than by coincidence: what a
 * ceiling here bounds is how many engine sessions one press of a button starts. */
const MAX_REPOS = 12;

/**
 * Air's first step, as a dialog: who does the work, where, and what the work is.
 *
 * All three are decided here and not later because two of them are effectively final — the agent
 * is what the task *is*, and the repository is the working copy its turns will edit — so asking
 * for them up front is what keeps the task detail from having to explain why they are greyed out.
 * The folder is the odd one out: it can be changed from the list whenever, and is asked for here
 * only so that opening this dialog from inside a folder lands the task in it.
 *
 * **One task, one repository — so N repositories are N tasks.** An engine session sees a single
 * working directory, which is why a task's repository is fixed once it has turns; ticking several
 * here is therefore shorthand for "the same assignment, once per repository" and creates one
 * sibling task in each, not one task that somehow spans them. They start together and actually run
 * together: the one-agent-per-repository guard is per repository, and these are all in different
 * ones.
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
  /** The repositories to assign this work in, in the order they were ticked — that order is the
   * order the tasks are created in, and the first is the one the detail pane lands on. Starts as
   * the repository the user is already in, so the single-repository case is unchanged. */
  const [projectIds, setProjectIds] = useState<string[]>(() => {
    const first =
      (activeProjectId && projects.some((p) => p.id === activeProjectId) ? activeProjectId : projects[0]?.id) ?? "";
    return first ? [first] : [];
  });
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

  const toggleRepo = (id: string) =>
    setProjectIds((current) => {
      if (current.includes(id)) return current.filter((kept) => kept !== id);
      return current.length >= MAX_REPOS ? current : [...current, id];
    });

  const agent = runnable.find((a) => a.id === agentId) ?? null;
  const providerMissing = agent !== null && !isProviderReady(statuses, agent.provider);
  const canStart =
    !starting &&
    agent !== null &&
    projectIds.length > 0 &&
    goal.trim() !== "" &&
    workspaceId !== null &&
    !providerMissing;

  const start = async () => {
    if (!agent || !canStart) return;
    setStarting(true);
    try {
      const store = useAgentsStore.getState();
      // Created first, sent afterwards. Sending inside the loop would leave a half-made set behind
      // a failed create with turns already running in it; this way the only thing a failure can
      // leave is tasks that have said nothing, which is what closing the dialog leaves anyway.
      const created: AgentTask[] = [];
      for (const projectId of projectIds) {
        created.push(await store.create({ projectId, agent, goal, agentProjectId }));
      }
      for (const task of created) store.send(task.id, goal);
      // `create` selects whatever it just made, so the pane would otherwise open on the repository
      // ticked last. The first one is the one the user started from.
      if (created.length > 1) void store.select(created[0].id);
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
              {projectIds.length > 1 ? t("agents.startN", { n: projectIds.length }) : t("agents.start")}
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
        {/* Only once a text-only engine has been picked. It is not a block — a local model is a
            perfectly good thing to think out loud with — but a task expecting files to change is a
            task that would otherwise finish green having changed nothing. */}
        {agent !== null && !isAgenticProvider(agent.provider) && (
          <Note tone="warning">{t("agents.agentTextOnly", { name: providerDisplayLabel(agent.provider, t) })}</Note>
        )}

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

        {/* Checkboxes rather than a select, the same call the chain dialog makes: the list is the
            workspace's repositories, short enough to read at a glance, and which ones are ticked is
            the whole question. With one ticked this is the field it always was; the hint only
            changes once ticking a second one has stopped meaning "instead of". */}
        <Field
          label={projectIds.length > 1 ? t("agents.repositories") : t("agents.repository")}
          hint={projectIds.length > 1 ? t("agents.taskReposMultiHint") : t("agents.repositoryHint")}
        >
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-[var(--cf-border)] px-2 py-1.5">
            {projects.map((repo) => {
              const at = projectIds.indexOf(repo.id);
              return (
                <label
                  key={repo.id}
                  className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text)]"
                >
                  <Checkbox
                    checked={at !== -1}
                    disabled={at === -1 && projectIds.length >= MAX_REPOS}
                    onChange={() => toggleRepo(repo.id)}
                  />
                  <span className="min-w-0 truncate">{repo.name}</span>
                  {/* Only the first one is called out, and only once there is more than one: it is
                      the task the dialog leaves open, which is otherwise invisible. */}
                  {at === 0 && projectIds.length > 1 && (
                    <span className="shrink-0 rounded bg-black/[0.05] px-1.5 py-[1px] text-[10px] text-[var(--cf-text-muted)] dark:bg-white/[0.07]">
                      {t("agents.repoPrimary")}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
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
