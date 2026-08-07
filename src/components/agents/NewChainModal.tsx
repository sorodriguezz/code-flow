import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, BookmarkPlus, Check, Link2, Plus, TerminalSquare, Trash2, Undo2 } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { AI_PROVIDERS, isAgenticProvider, modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { isRunnableAgent, useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { isProviderReady, useProviderStatusStore } from "../../state/providerStatusStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { ALL_REPOS, blankChainStep, type NewChainStep } from "../../types/domain";

/** Mirrors `queries::MAX_CHAIN_STEPS`. The backend refuses past it too — a cap enforced only here
 * is a cap a stale window can walk through. */
const MAX_STEPS = 16;
/** Mirrors `queries::MAX_CHAIN_REPOS`. */
const MAX_REPOS = 16;
/** Mirrors `queries::MAX_CHAIN_ROWS` — the cap on what the steps *expand into*, which is the one a
 * multi-repository plan actually runs into. */
const MAX_ROWS = 64;

interface DraftStep extends NewChainStep {
  /** Local only: a stable key so reordering does not remount every row. */
  key: string;
}

let nextKey = 0;
const draft = (agentId: string): DraftStep => ({
  key: `s${nextKey++}`,
  ...blankChainStep({ agent_id: agentId }),
});

/**
 * Re-points every `on_fail` after the plan has been reordered or shortened.
 *
 * A target is a **position**, and a position stops meaning anything the moment the step at it moves:
 * without this, deleting step 2 silently re-aims every loop that pointed at it onto whatever slid
 * into its place, and the plan still saves. Resolved through the draft keys, which are the only
 * stable identity a step has before it has been written anywhere.
 *
 * Anything that ends up pointing at or past its own step is cleared rather than clamped. A jump
 * forward on failure is a plan skipping the work it has just proved it needs, and guessing which
 * earlier step the user *meant* would be inventing a plan they did not author.
 */
function repoint(before: DraftStep[], after: DraftStep[]): DraftStep[] {
  const positions = new Map(after.map((step, index) => [step.key, index]));
  return after.map((step, index) => {
    if (step.on_fail < 0) return step;
    const moved = positions.get(before[step.on_fail]?.key ?? "");
    return { ...step, on_fail: moved !== undefined && moved < index ? moved : -1 };
  });
}

/** How many engine runs this plan turns into: a step marked "every repository" is one row per
 * repository, and everything else is one row. Mirrors `queries::expand_steps`. */
function expandedRows(steps: DraftStep[], repoCount: number): number {
  return steps.reduce((total, step) => total + (step.project_id === ALL_REPOS ? repoCount : 1), 0);
}

/**
 * Authoring a chain: the repositories it works across, one objective, and an ordered list of agents
 * with an instruction each.
 *
 * All of it is decided here because none of it can move afterwards without lying: the repositories
 * are the working copies the steps will edit, and each step's agent is snapshotted the moment this
 * dialog is submitted, so a roster edited next week does not rewrite a plan that is already
 * running. The folder is the exception — it only says where the chain is filed, and the list can
 * move it later.
 *
 * **One step, one repository.** An engine session sees one working directory, so a plan across
 * three repositories is three sets of turns rather than one turn that somehow spans them — the same
 * constraint the work-item review already runs under. What the dialog offers on top of that is the
 * shorthand: a step set to "every repository" is expanded at creation into one consecutive step per
 * repository, so the common case (do this everywhere) is one row to author and N rows to watch.
 * With a single repository picked, none of this is on screen and the form is what it always was.
 *
 * With `templateId` the same form doubles as the template editor: a saved plan has exactly the
 * fields a chain is authored from, so editing one in a second dialog would mean two forms drifting
 * apart over one shape. A template deliberately does **not** remember repositories — it is meant to
 * be applied in whatever workspace you are in, and repository ids do not survive that trip.
 */
export function NewChainModal({
  onClose,
  onManageAgents,
  initialAgentProjectId = "",
  templateId = null,
}: {
  onClose: () => void;
  onManageAgents: () => void;
  /** The folder the chain and its step tasks are filed under — set when the dialog was opened from
   * one. */
  initialAgentProjectId?: string;
  /** A saved plan opened for editing rather than merely applied: the form starts as that template
   * and saving overwrites it instead of leaving a near-identical copy next to it. */
  templateId?: string | null;
}) {
  const t = useT();
  const roster = useAgentsStore((s) => s.roster);
  const agentProjects = useAgentsStore((s) => s.projects);
  const templates = useChainStore((s) => s.templates);
  const projects = useActiveProjects();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);

  const runnable = useMemo(() => roster.filter(isRunnableAgent), [roster]);

  /** The repository set, in the order it was picked — the first is the chain's own, which is what a
   * step that names none falls back to. Starts as the repository the user is already in. */
  const [projectIds, setProjectIds] = useState<string[]>(() => {
    const first =
      (activeProjectId && projects.some((p) => p.id === activeProjectId) ? activeProjectId : projects[0]?.id) ?? "";
    return first ? [first] : [];
  });
  const [agentProjectId, setAgentProjectId] = useState(() =>
    agentProjects.some((p) => p.id === initialAgentProjectId) ? initialAgentProjectId : "",
  );
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>(() => [draft(""), draft("")]);
  const [busy, setBusy] = useState(false);
  /** The template this dialog is bound to — the prop is only the starting value. Saving binds it,
   * so pressing the button again updates that template instead of creating another one. */
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(templateId);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

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
      return repoint(current, next);
    });

  const removeStep = (key: string) =>
    setSteps((current) => repoint(current, current.filter((step) => step.key !== key)));

  const gateAll = steps.length > 1 && steps.slice(1).every((step) => step.gate);
  const setGateAll = (on: boolean) =>
    setSteps((current) => current.map((step, i) => (i === 0 ? step : { ...step, gate: on })));

  /** Ticking a repository appends it, so the *first* one stays whichever the user picked first —
   * which is the one the chain is filed under and the one an unassigned step runs in. */
  const toggleRepo = (id: string) =>
    setProjectIds((current) => {
      if (current.includes(id)) {
        // A step pointed at a repository that is no longer in the set falls back to the first one,
        // rather than being submitted with a routing the chain cannot honour.
        setSteps((all) => all.map((step) => (step.project_id === id ? { ...step, project_id: "" } : step)));
        return current.filter((kept) => kept !== id);
      }
      return current.length >= MAX_REPOS ? current : [...current, id];
    });

  const rows = expandedRows(steps, projectIds.length);
  const ready = steps.filter((step) => step.agent_id && step.instruction.trim());
  const canStart =
    !busy && projectIds.length > 0 && rows <= MAX_ROWS && ready.length > 0 && ready.length === steps.length;

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
        ...blankChainStep({
          agent_id: runnable.some((a) => a.id === step.agent_id) ? step.agent_id : "",
          instruction: step.instruction,
          gate: step.gate,
          // The verdict and its targets *do* travel: unlike a repository id they mean the same
          // thing in any workspace, and they are most of what makes a plan worth saving twice.
          check_command: step.check_command,
          on_pass: step.on_pass,
          on_fail: step.on_fail,
        }),
      })),
    );
  };

  // Only on mount, and deliberately not keyed on `templates`: saving reloads that list, and an
  // effect that watched it would re-apply the stored plan over whatever the user had typed since.
  useEffect(() => {
    if (!templateId) return;
    applyTemplate(templateId);
    const template = templates.find((candidate) => candidate.id === templateId);
    // The description rides the goal box because that is where `saveAsTemplate` reads it back from;
    // leaving it empty would silently blank the template's description on the next update.
    if (template) setGoal((current) => current || template.description);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Saves the form as a reusable plan, and *remembers what it saved*.
   *
   * The id is state rather than the prop it starts from, because the second press of this button
   * has to mean "update the one I just made". Reading the prop instead left it null for a dialog
   * opened as a new chain, so every press minted another template — the list filled up with
   * identical copies of the same plan, since nothing deduplicates by name and nothing should.
   *
   * The button says so too: after the first save it becomes "update", which is the honest label for
   * what the next press now does. */
  const saveAsTemplate = async () => {
    const name = title.trim();
    if (!name) return;
    setSavingTemplate(true);
    try {
      const saved = await useChainStore.getState().saveTemplate({
        id: savedTemplateId ?? undefined,
        name,
        description: goal.trim(),
        // Repository and phase are dropped on the way in: a template is applied in whatever
        // workspace it is opened in, and an id from another one resolves to nothing there.
        steps: steps.map(({ agent_id, instruction, gate, check_command, on_pass, on_fail }) =>
          blankChainStep({ agent_id, instruction, gate, check_command, on_pass, on_fail }),
        ),
      });
      // `null` means the store had no workspace to save into — announcing success there would be a
      // lie the user only discovers when the template is missing.
      if (!saved) return;
      const updated = savedTemplateId !== null;
      setSavedTemplateId(saved.id);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1400);
      useToastStore
        .getState()
        .pushToast(t(updated ? "agents.templateUpdated" : "agents.templateSaved"), "success");
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSavingTemplate(false);
    }
  };

  const submit = async (start: boolean) => {
    if (!canStart) return;
    setBusy(true);
    try {
      await useChainStore.getState().create({
        projectIds,
        title: title.trim() || goal.trim().split("\n")[0].slice(0, 64) || t("agents.newChain"),
        goal,
        steps: steps.map(({ agent_id, instruction, gate, project_id, phase, check_command, on_pass, on_fail }) => ({
          agent_id,
          instruction,
          gate,
          project_id,
          phase,
          check_command,
          on_pass,
          on_fail,
        })),
        agentProjectId,
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
            disabled={busy || savingTemplate || !canStart || !title.trim()}
            title={t("agents.saveTemplateHint")}
          >
            {savedFlash ? (
              <Check size={13} className="text-[var(--cf-success)]" />
            ) : (
              <BookmarkPlus size={13} />
            )}
            {savedFlash
              ? t("settings.saved")
              : t(savedTemplateId ? "agents.updateTemplate" : "agents.saveTemplate")}
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

        {/* Hidden while a template is being edited: filling this form from a *second* plan would
            mean the update button writing someone else's steps over the one that was opened. */}
        {!templateId && templates.length > 0 && (
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

        <Field label={t("agents.chainName")}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("agents.chainNamePlaceholder")}
            className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        {/* Checkboxes rather than a multi-select, the same call the QA panel makes: the list is the
            workspace's repositories, short enough to read at a glance, and which ones are ticked is
            the whole question. The order of ticking is kept — the first one is the chain's own. */}
        <Field
          label={t("agents.repositories")}
          hint={projectIds.length > 1 ? t("agents.repositoriesMultiHint") : t("agents.repositoryHint")}
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
                      the repository an unassigned step runs in, which is otherwise invisible. */}
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

        {/* Filing, never routing — and one field away from the repository, which is the one place a
            user could reasonably read the two as the same thing. Hence the hint, and hence "no
            project" being an ordinary option: leaving it alone has to look like a decision rather
            than like something left unfilled. The chain's step tasks inherit it. */}
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
            {/* What the plan actually turns into, shown only when the two numbers differ — a step
                set to "every repository" is one row to author and N turns to sit through. */}
            {rows !== steps.length && (
              <span
                className={`text-[11px] tabular-nums ${
                  rows > MAX_ROWS ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"
                }`}
              >
                {t("agents.expandsToRuns", { n: rows, max: MAX_ROWS })}
              </span>
            )}
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
                    onClick={() => removeStep(step.key)}
                    disabled={steps.length === 1}
                    title={t("common.delete")}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] disabled:opacity-30 dark:hover:bg-white/[0.08]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {/* Only once a text-only engine has actually been picked for this step, and only on
                    that step. A permanent note explaining which engines can write would be a
                    paragraph everybody scrolls past; this is the one moment it is the answer to a
                    question the user just asked. Not a block, either — Ollama is a fine analyst or
                    reviewer, and the step it is wrong for is the one that has to change files. */}
                {step.agent_id !== "" &&
                  !isAgenticProvider(runnable.find((a) => a.id === step.agent_id)?.provider ?? "") && (
                    <p className="mb-1.5 text-[11px] leading-snug text-[var(--cf-warning)]">
                      {t("agents.agentTextOnly", {
                        name: providerDisplayLabel(
                          runnable.find((a) => a.id === step.agent_id)?.provider ?? "",
                          t,
                        ),
                      })}
                    </p>
                  )}
                <textarea
                  value={step.instruction}
                  rows={2}
                  onChange={(e) => patch(step.key, { instruction: e.target.value })}
                  placeholder={t("agents.stepInstructionPlaceholder")}
                  className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
                />
                {/* Only once there is a choice to make. With one repository every step runs there
                    and a picker with a single option is a question with one answer — which is why
                    a single-repository chain is authored in exactly the form it always was. */}
                {projectIds.length > 1 && (
                  <div className="mt-1.5">
                    <Select
                      size="sm"
                      value={step.project_id || projectIds[0]}
                      ariaLabel={t("agents.stepRepository")}
                      onChange={(value) => patch(step.key, { project_id: value })}
                      options={[
                        { value: ALL_REPOS, label: t("agents.stepRepoAll", { n: projectIds.length }) },
                        ...projectIds.map((id) => ({
                          value: id,
                          label: projects.find((p) => p.id === id)?.name ?? id,
                        })),
                      ]}
                    />
                  </div>
                )}
                {/* The verdict, and the only thing in this dialog that is not about what an agent
                    is told. A chain used to advance because a turn returned text; this is the one
                    fact in the plan no agent authors. Hidden behind its own line so a plan that
                    does not want one is authored exactly as it always was. */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <TerminalSquare size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <input
                    value={step.check_command}
                    onChange={(e) => patch(step.key, { check_command: e.target.value })}
                    placeholder={t("agents.stepCheckPlaceholder")}
                    title={t("agents.stepCheckHint")}
                    className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
                  />
                </div>
                {/* Only with a check: without one there is no failure to route, and a "where does
                    this go when it fails" on a step that cannot fail is a question with no meaning.
                    Only backwards, too — the loop is the thing worth having, and a forward jump on
                    failure is a plan skipping the work it just proved it needs. */}
                {step.check_command.trim() !== "" && index > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Undo2 size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                    <Select
                      size="sm"
                      value={String(step.on_fail)}
                      ariaLabel={t("agents.stepOnFail")}
                      onChange={(value) => patch(step.key, { on_fail: Number(value) })}
                      options={[
                        { value: "-1", label: t("agents.stepOnFailRetry") },
                        ...steps.slice(0, index).map((earlier, at) => ({
                          value: String(at),
                          label: t("agents.stepOnFailGoto", {
                            n: at + 1,
                            name:
                              runnable.find((a) => a.id === earlier.agent_id)?.name ||
                              t("settings.sddNewAgent"),
                          }),
                        })),
                      ]}
                    />
                  </div>
                )}
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
