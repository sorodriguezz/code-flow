import { useEffect, useMemo, useState } from "react";
import { Blend, Bookmark, Bot, Plus, Settings2, Zap } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { chipClass, fieldClass } from "../common/recipes";
import { Field } from "../settings/modelPicker";
import { localErrorText, modelLabelOf, tokensLabel } from "../settings/LocalModelSettings";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import {
  hybridTriage,
  LOCAL_NOT_READY,
  MULTI_REPO_UNSUPPORTED,
  SPANS_REPOS,
  type HybridTriage,
} from "../../lib/tauri/hybridCommands";
import { modelKeyFor } from "../../lib/tauri/localExecCommands";
import { useChainStore } from "../../state/chainStore";
import { useLocalExecStore } from "../../state/localExecStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { useUiStore } from "../../state/uiStore";
import { isAgenticProvider, modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { isRunnableAgent, useAgentsStore } from "../../state/agentsStore";
import { isProviderReady, useProviderStatusStore } from "../../state/providerStatusStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { AgentTask, HybridTemplateConfig } from "../../types/domain";

/** Mirrors `queries::MAX_CHAIN_REPOS`, and for the same reason rather than by coincidence: what a
 * ceiling here bounds is how many engine sessions one press of a button starts. */
const MAX_REPOS = 12;

/** Which kind of task the dialog makes, remembered between openings. */
type Mode = "agent" | "hybrid";
const MODE_KEY = "agents_new_task_mode";

const BACKEND_LABEL: Record<string, string> = { bundled: "CodeFlow", ollama: "Ollama", openai: "OpenAI" };

/** How long the objective has to sit still before it is read for a direct run. */
const TRIAGE_DEBOUNCE_MS = 450;

/** The commands typed in the checks box: one per line, blanks dropped. */
const parseChecks = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

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
 * ones. A hybrid task is the exception: a planner whose CLI takes extra directories plans across
 * all of them at once.
 *
 * Starting the task also sends the goal as its first turn. A task that exists but has said nothing
 * is a row that looks like work and isn't; if the user wanted to think about it longer they can
 * close the dialog.
 *
 * In hybrid mode the objective is read as it is typed: a change that names a file or two small
 * enough for the local model goes to it directly — no plan, no review, no subscription tokens —
 * and the line under the objective says so, with a way to plan it anyway.
 */
export function NewTaskModal({
  onClose,
  onManageAgents,
  initialAgentProjectId = "",
  templateId = null,
  suspended = false,
}: {
  onClose: () => void;
  onManageAgents: () => void;
  /** The folder the task is filed under to begin with — set when the dialog was opened from one. */
  initialAgentProjectId?: string;
  /** A hybrid template opened from the list: the dialog starts as that template and saving updates
   *  it. */
  templateId?: string | null;
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
  const templates = useChainStore((s) => s.templates);
  const hybridTemplates = useMemo(() => templates.filter((template) => template.kind === "hybrid"), [templates]);

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
  /** One agent working alone, or a hybrid run: this agent plans and reviews, the local model writes. */
  const [mode, setMode] = useState<Mode>(templateId ? "hybrid" : "agent");
  /** Stop for approval between the plan and the local execution. On by default: the plan is the
   *  one moment the work can still be redirected for free. */
  const [gate, setGate] = useState(true);
  /** Several repositories, one plan across them — when the planner's CLI can see them all. */
  const [onePlan, setOnePlan] = useState(true);
  /** Commands that validate the change, one per line: approved by typing them. */
  const [checksText, setChecksText] = useState("");
  /** What the objective says about going straight to the local model, and whether the user asked
   *  for a plan anyway. */
  const [triage, setTriage] = useState<HybridTriage | null>(null);
  const [forcePlan, setForcePlan] = useState(false);
  /** The hybrid template this dialog is bound to — saving again updates it rather than minting a
   *  copy (see `NewChainModal`'s `savedTemplateId`). */
  const [boundTemplateId, setBoundTemplateId] = useState<string | null>(templateId);
  const [templateName, setTemplateName] = useState("");
  /** The template's own review mode and delegation, which a run made from it takes over Settings. */
  const [templateOverrides, setTemplateOverrides] = useState<Pick<HybridTemplateConfig, "review_mode" | "delegate">>({
    review_mode: "",
    delegate: "",
  });
  const [naming, setNaming] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const local = useLocalExecStore((s) => s.state);
  const localLoading = useLocalExecStore((s) => s.loading || (s.refreshing && !s.state));
  const openSettingsAt = useUiStore((s) => s.openSettingsAt);

  useEffect(() => {
    if (Object.keys(statuses).length === 0) void checkAll();
    if (templateId) return;
    void getSetting(MODE_KEY).then((saved) => {
      if (saved === "hybrid") setMode("hybrid");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The local model is only asked about once the dialog is in hybrid mode — it means a few short
  // network checks, which a plain task has no use for.
  useEffect(() => {
    if (mode === "hybrid") void useLocalExecStore.getState().load();
  }, [mode]);

  const applyTemplate = (id: string) => {
    const template = hybridTemplates.find((candidate) => candidate.id === id);
    const config = template?.hybrid;
    if (!template || !config) return;
    setMode("hybrid");
    if (runnable.some((candidate) => candidate.id === config.planner_agent_id)) setAgentId(config.planner_agent_id);
    setGoal((current) => current || config.goal);
    setGate(config.gate);
    setChecksText(config.checks.join("\n"));
    setTemplateOverrides({ review_mode: config.review_mode, delegate: config.delegate });
    setTemplateName(template.name);
    setBoundTemplateId(template.id);
  };

  // Opened as a template: only on mount, like `NewChainModal` — a save reloads the list, and
  // re-applying then would overwrite what the user typed since.
  useEffect(() => {
    if (templateId) applyTemplate(templateId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeMode = (next: Mode) => {
    setMode(next);
    void setSetting(MODE_KEY, next).catch(() => undefined);
  };

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
  const hybrid = mode === "hybrid";
  const localReady = Boolean(local?.reachable && local.model);
  const spansRepos = agent !== null && SPANS_REPOS.has(agent.provider);
  const oneRunAcross = hybrid && projectIds.length > 1 && spansRepos && onePlan;

  // Read for a direct run once the objective settles. One repository only — a change across two
  // is never small — and only with a local model that can take it.
  const triageKey = hybrid && localReady && projectIds.length === 1 ? `${projectIds[0]}\n${goal.trim()}` : "";
  useEffect(() => {
    if (!triageKey || !goal.trim()) {
      setTriage(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void hybridTriage(projectIds, goal)
        .then((answer) => {
          if (!stale) setTriage(answer);
        })
        .catch(() => {
          if (!stale) setTriage(null);
        });
    }, TRIAGE_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triageKey, local?.model, local?.ctx]);

  const direct = hybrid && projectIds.length === 1 && triage?.direct === true && !forcePlan;

  const canStart =
    !starting &&
    agent !== null &&
    projectIds.length > 0 &&
    goal.trim() !== "" &&
    workspaceId !== null &&
    !providerMissing &&
    (!hybrid || localReady);

  const startHybrid = async () => {
    if (!agent) return;
    const chains = useChainStore.getState();
    const checks = parseChecks(checksText);
    const overrides = { review_mode: templateOverrides.review_mode, delegate: templateOverrides.delegate, checks };
    // One plan across the repositories when the planner can see them all; otherwise one run per
    // repository, as with tasks. They queue for the local model by themselves — it serves one
    // generation at a time.
    const groups = oneRunAcross ? [projectIds] : projectIds.map((id) => [id]);
    let first: string | null = null;
    try {
      for (const group of groups) {
        const detail = await chains.createHybrid({
          projectIds: group,
          title: "",
          goal,
          plannerAgentId: agent.id,
          agentProjectId,
          gate,
          start: true,
          directFiles: direct && triage ? triage.files.map((file) => file.path) : null,
          overrides,
        });
        first ??= detail.chain.id;
      }
    } catch (error) {
      // Refused before anything ran — the model went away since this dialog read it, or the
      // planner cannot take several repositories. Whatever was created before the refusal stands,
      // and is where the dialog lands.
      const message = error instanceof Error ? error.message : String(error);
      pushErrorToast(
        message === LOCAL_NOT_READY
          ? t("localexec.notReady")
          : message === MULTI_REPO_UNSUPPORTED
            ? t("chain.multiRepoUnsupported")
            : message,
      );
      void useLocalExecStore.getState().refresh();
      if (!first) return;
    }
    if (first) void chains.select(first);
    onClose();
  };

  const start = async () => {
    if (!agent || !canStart) return;
    setStarting(true);
    try {
      if (hybrid) {
        await startHybrid();
        return;
      }
      const store = useAgentsStore.getState();
      // Created first, sent afterwards. Sending inside the loop would leave a half-made set behind
      // a failed create with turns already running in it; this way the only thing a failure can
      // leave is tasks that have said nothing, which is what closing the dialog leaves anyway.
      const created: AgentTask[] = [];
      for (const projectId of projectIds) {
        created.push(await store.create({ projectId, agent, goal, agentProjectId }));
      }
      // A refusal here is the one-agent-per-repository guard, and `send` says so itself, naming the
      // repository. The dialog still closes on it: the task exists, `create` selected it, and it
      // opens with its goal on screen and a Run button — the retry is one click away once the
      // repository is free, instead of a task that silently never started.
      for (const task of created) store.send(task.id, goal);
      // `create` selects whatever it just made, so the pane would otherwise open on the repository
      // ticked last. The first one is the one the user started from.
      if (created.length > 1) void store.select(created[0].id);
      onClose();
    } finally {
      setStarting(false);
    }
  };

  /** Saves the hybrid setup as a template, and remembers which: the next save updates it. */
  const saveTemplate = async () => {
    const name = templateName.trim();
    if (!name || !agent) return;
    setSavingTemplate(true);
    try {
      const saved = await useChainStore.getState().saveHybridTemplate({
        id: boundTemplateId ?? undefined,
        name,
        description: "",
        config: {
          planner_agent_id: agent.id,
          goal: goal.trim(),
          gate,
          review_mode: templateOverrides.review_mode,
          delegate: templateOverrides.delegate,
          checks: parseChecks(checksText),
        },
      });
      if (!saved) return;
      const updated = boundTemplateId !== null;
      setBoundTemplateId(saved.id);
      setNaming(false);
      pushSuccessToast(t(updated ? "agents.templateUpdated" : "agents.templateSaved"));
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setSavingTemplate(false);
    }
  };

  const startLabel = projectIds.length > 1 && !oneRunAcross ? t("agents.startN", { n: projectIds.length }) : t("agents.start");

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
              {startLabel}
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

        <div className="flex items-center gap-2">
          <Segmented
            options={[
              { value: "agent" as Mode, label: t("agents.modeAgent"), icon: Bot },
              { value: "hybrid" as Mode, label: t("agents.modeHybrid"), icon: Blend, title: t("agents.modeHybridHint") },
            ]}
            value={mode}
            onChange={changeMode}
            layoutId="cf-new-task-mode"
            size="sm"
            ariaLabel={t("agents.mode")}
          />
          {/* Applying a saved hybrid setup; hidden once the dialog is bound to one — filling the
              form from a second template would leave it unclear which one "update" saves. */}
          {hybrid && (
            <div className="ml-auto flex items-center gap-1.5">
              {!boundTemplateId && hybridTemplates.length > 0 && (
                <div className="w-44">
                  <Select
                    size="sm"
                    value=""
                    placeholder={t("agents.hybridFromTemplate")}
                    ariaLabel={t("agents.template")}
                    onChange={applyTemplate}
                    options={hybridTemplates.map((template) => ({ value: template.id, label: template.name }))}
                  />
                </div>
              )}
              <Tooltip label={t(boundTemplateId ? "agents.updateTemplate" : "agents.saveTemplate")}>
                <button
                  type="button"
                  disabled={starting || agent === null}
                  aria-label={t(boundTemplateId ? "agents.updateTemplate" : "agents.saveTemplate")}
                  aria-pressed={naming}
                  onClick={() => {
                    if (!templateName.trim()) setTemplateName(goal.trim().split("\n")[0]?.slice(0, 60) ?? "");
                    setNaming((open) => !open);
                  }}
                  className={iconButtonClass({ size: "sm", active: naming })}
                >
                  <Bookmark size={13} />
                </button>
              </Tooltip>
            </div>
          )}
        </div>

        {hybrid && naming && (
          <div className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-2 py-1.5">
            <Bookmark size={13} className="shrink-0 text-[var(--cf-accent)]" />
            <input
              autoFocus
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveTemplate();
                if (e.key === "Escape") setNaming(false);
              }}
              placeholder={t("agents.templateName")}
              className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}
            />
            <button
              type="button"
              disabled={savingTemplate || !templateName.trim()}
              onClick={() => void saveTemplate()}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              {t(boundTemplateId ? "agents.updateTemplate" : "agents.saveTemplate")}
            </button>
          </div>
        )}

        {/* The role rides the agent field rather than sitting at the foot of the form: down there
            it read as a note about the goal, which is the one thing it is not. */}
        <Field
          label={hybrid ? t("agents.hybridPlannerLabel") : t("agents.agent")}
          hint={hybrid ? t("agents.hybridPlannerHint") : agent?.role.trim() || undefined}
        >
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
              leading: <ProviderGlyph providerId={a.provider} size={13} />,
              disabled: !isProviderReady(statuses, a.provider),
            }))}
          />
        </Field>

        {hybrid && (
          <Field
            label={t("agents.hybridLocalLabel")}
            hint={localReady && local ? t("agents.hybridBudgetHint", { tokens: tokensLabel(local.budget.input) }) : undefined}
            action={
              <button
                type="button"
                onClick={() => openSettingsAt("claude", "localModel")}
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                <Settings2 size={12} />
                {t("agents.hybridConfigure")}
              </button>
            }
          >
            {localLoading || !local ? (
              <Skeleton className="h-[30px] w-full" />
            ) : (
              <div className="flex items-center gap-2">
                <span className={chipClass("neutral")}>{BACKEND_LABEL[local.backend] ?? local.backend}</span>
                <div className="min-w-0 flex-1">
                  <Select
                    size="field"
                    value={local.model ?? ""}
                    placeholder={t("localexec.noModels")}
                    ariaLabel={t("agents.hybridLocalLabel")}
                    disabled={!local.reachable && local.backend !== "bundled"}
                    onChange={(value) => void useLocalExecStore.getState().set(modelKeyFor(local.backend), value)}
                    options={local.models
                      .filter((model) => local.backend !== "bundled" || model.installed)
                      .map((model) => ({
                        value: model.id,
                        label: [model.label, model.params].filter(Boolean).join(" · "),
                      }))}
                  />
                </div>
                <span className="shrink-0 text-[12px] tabular-nums text-[var(--cf-text-muted)]">{tokensLabel(local.ctx)}</span>
              </div>
            )}
            {local && !localReady && !localLoading && (
              <div className="mt-1.5">
                <Note tone="warning">
                  {localErrorText(local, t, { url: local.url, model: modelLabelOf(local) }) ?? t("localexec.noServer")}
                </Note>
              </div>
            )}
          </Field>
        )}

        {/* Checkboxes rather than a select, the same call the chain dialog makes: the list is the
            workspace's repositories, short enough to read at a glance, and which ones are ticked is
            the whole question. With one ticked this is the field it always was; the hint only
            changes once ticking a second one has stopped meaning "instead of". */}
        <Field
          label={projectIds.length > 1 ? t("agents.repositories") : t("agents.repository")}
          hint={
            projectIds.length > 1
              ? oneRunAcross
                ? t("agents.hybridOnePlanHint")
                : t("agents.taskReposMultiHint")
              : t("agents.repositoryHint")
          }
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
                    <span className="shrink-0 rounded bg-[var(--cf-hover)] px-1.5 py-[1px] text-[10.5px] text-[var(--cf-text-muted)]">
                      {t("agents.repoPrimary")}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {hybrid && projectIds.length > 1 && (
            <div className="mt-1.5">
              {spansRepos ? (
                <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text)]">
                  <Checkbox checked={onePlan} onChange={setOnePlan} />
                  {t("agents.hybridOnePlan", { n: projectIds.length })}
                </label>
              ) : (
                <span className="text-[11px] text-[var(--cf-text-muted)]">{t("agents.hybridOnePlanUnsupported")}</span>
              )}
            </div>
          )}
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
            autoFocus={!templateId}
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
          {hybrid && triage?.direct && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              <Zap size={12} className={`mt-px shrink-0 ${forcePlan ? "" : "text-[var(--cf-accent)]"}`} />
              <span className="min-w-0">
                {forcePlan
                  ? t("agents.hybridDirectDeclined")
                  : t("agents.hybridDirect", { files: triage.files.map((file) => file.path).join(", ") })}{" "}
                <button
                  type="button"
                  onClick={() => setForcePlan((current) => !current)}
                  className="text-[var(--cf-accent)] hover:underline"
                >
                  {forcePlan ? t("agents.hybridDirectUse") : t("agents.hybridDirectPlanAnyway")}
                </button>
              </span>
            </p>
          )}
        </Field>

        {hybrid && (
          <Field label={t("agents.hybridChecksLabel")} hint={t("agents.hybridChecksHint")}>
            <textarea
              value={checksText}
              rows={2}
              spellCheck={false}
              onChange={(e) => setChecksText(e.target.value)}
              placeholder={t("agents.hybridChecksPlaceholder")}
              className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
            />
          </Field>
        )}

        {/* A direct run has no plan to approve. */}
        {hybrid && !direct && (
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text)]">
            <Checkbox checked={gate} onChange={setGate} />
            {t("agents.hybridGate")}
          </label>
        )}
      </div>
    </ApiModal>
  );
}
