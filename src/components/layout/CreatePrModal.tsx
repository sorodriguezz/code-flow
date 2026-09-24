import { useEffect, useMemo, useState } from "react";
import { WorkItemPicker } from "./WorkItemPicker";
import type { WorkItem } from "../../types/domain";
import { CloudUpload, GitPullRequest, Loader2, Sparkles, X } from "lucide-react";
import { listBranches, generatePrDescription, gitPushBranch } from "../../lib/tauri/commands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { usePrStore } from "../../state/prStore";
import { pushErrorToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { Select } from "../common/Select";
import type { BranchInfo, Project, PullRequestSummary } from "../../types/domain";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";

const PREFERRED_TARGETS = ["main", "master", "develop", "development"];

interface CreatePrModalProps {
  project: Project;
  onClose: () => void;
  /** The pull request just opened — its caller puts it on screen in the assistant. */
  onCreated: (pr: PullRequestSummary) => void;
}

/**
 * Opens a pull request on the project's linked host. Branches are read straight from the repo on
 * disk (so it works for any linked project, not only the active one); "Generate with AI" drafts a
 * title + description from the diff between the chosen branches and prefills the form.
 */
export function CreatePrModal({ project, onClose, onCreated }: CreatePrModalProps) {
  const t = useT();
  const createPr = usePrStore((s) => s.createPr);

  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(false);
  /**
   * Azure DevOps work items to link. Empty everywhere else — the picker is not drawn at all for a
   * GitHub or GitLab project, because a work item is not a thing those hosts have.
   */
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const isAzure = Boolean(project.ado_org);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const localBranches = useMemo(() => (branches ?? []).filter((b) => !b.is_remote), [branches]);

  /**
   * The source branch exists only here, so the host has nothing to open a pull request *from*.
   *
   * Read off `upstream` rather than off `ahead`: a branch that tracks a remote it has not been
   * pushed to yet is a different problem (the PR opens, it is just empty), while one that tracks
   * nothing cannot be named in an API call at all. `null` while the list is still loading, so the
   * warning cannot flash on before we know.
   */
  const sourceInfo = useMemo(
    () => (source ? (localBranches.find((b) => b.name === source) ?? null) : null),
    [localBranches, source],
  );
  const sourceIsLocalOnly = sourceInfo !== null && sourceInfo.upstream === null;

  /** Re-reads the branch list so a publish is reflected without closing the form. */
  const reloadBranches = async () => {
    const list = await listBranches(project.local_path).catch(() => null);
    if (list) setBranches(list);
  };

  useEffect(() => {
    let cancelled = false;
    void listBranches(project.local_path)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        const local = list.filter((b) => !b.is_remote);
        const head = local.find((b) => b.is_head);
        const src = head?.name ?? local[0]?.name ?? "";
        const tgt =
          local.find((b) => PREFERRED_TARGETS.includes(b.name) && b.name !== src)?.name ??
          local.find((b) => b.name !== src)?.name ??
          "";
        setSource(src);
        setTarget(tgt);
      })
      .catch((e) => {
        if (!cancelled) {
          setBranches([]);
          pushErrorToast(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.local_path]);

  const sameBranch = source !== "" && source === target;
  const canSubmit =
    !creating &&
    !generating &&
    !publishing &&
    title.trim() !== "" &&
    source !== "" &&
    target !== "" &&
    !sameBranch &&
    // Creating the PR would fail on the host with a message about an unknown ref, several seconds
    // later and in the host's words. Refusing here, next to the button that fixes it, is the same
    // refusal said where it can be acted on.
    !sourceIsLocalOnly;
  const busy = creating || generating || publishing;

  /** Publishes the source branch so the host can see it, without leaving the form — every field
   *  typed so far, and any description an AI run spent a minute drafting, stays put. */
  const publish = async () => {
    if (!source || publishing) return;
    setPublishing(true);
    try {
      await gitPushBranch(project.local_path, source);
      await reloadBranches();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setPublishing(false);
    }
  };

  const generate = async () => {
    if (!source || !target || sameBranch) return;
    setGenerating(true);
    // The id is what makes this run exist to the rest of the app. `generate_pr_description` takes it
    // as an option and the backend's `ai_runs::scoped` wrapper short-circuits without one: no
    // registry entry, no output events, and `cancel_ai_run` with nothing to reach — so reading a
    // whole branch diff through a model was the one AI run here that nothing on screen said was
    // happening and nothing could stop. That matters more than for most: this modal is *torn down*
    // rather than closed when the section around it collapses, which used to orphan the run outright.
    const runId = newRunId("pr-desc");
    // The project's workspace, not the active one. They are normally the same — the modal is opened
    // from a repository the user is standing in — but the run outlives the modal, and the row in the
    // status bar has to keep naming where the work belongs after they have moved on. `projectId`
    // brings that repository to the front when the row is followed, which is what makes the panel it
    // opens show this PR's project rather than whichever one happens to be selected.
    useAiRunStore.getState().start(runId, {
      kindKey: "agents.liveKindPrDescription",
      detail: `${source} → ${target}`,
      workspaceId: useWorkspaceStore.getState().workspaceOfProject(project.id),
      // The description lands in this form, not in the assistant — so the row leads to the repository
      // and no further; there is no panel page for a draft that lives in a modal.
      target: { projectId: project.id },
    });
    try {
      const draftText = await generatePrDescription(project.id, source, target, runId);
      if (draftText.title.trim()) setTitle(draftText.title.trim());
      setDescription(draftText.body);
    } catch (e) {
      // Stopping it from the status bar is now possible, and a stop is a decision rather than a
      // failure — the form keeps whatever the user had already typed and says nothing.
      if (!isCancellation(e)) pushErrorToast(String(e));
    } finally {
      useAiRunStore.getState().finish(runId);
      setGenerating(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      const created = await createPr(project.id, {
        title: title.trim(),
        description,
        sourceBranch: source,
        targetBranch: target,
        draft,
        workItemIds: workItems.map((item) => item.id),
      });
      onCreated(created);
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    // No dismiss on the backdrop. This form holds typing the user cannot get back — a description
    // an AI run spent a minute drafting, most of all — and a click that lands beside a Select's
    // popover is indistinguishable from one aimed at it. The X and Cancel are the way out.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-full w-[520px] max-w-[92vw] overflow-auto rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[15px] font-semibold">
            <GitPullRequest size={14} />
            {t("createPr.title")}
          </h3>
          {!busy && (
            <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
              <X size={15} />
            </button>
          )}
        </div>

        {branches !== null && localBranches.length < 2 ? (
          <p className="py-4 text-center text-[12px] text-[var(--cf-text-muted)]">{t("createPr.needTwoBranches")}</p>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
                  {t("createPr.source")}
                </label>
                <Select
                  value={source}
                  onChange={setSource}
                  disabled={busy || branches === null}
                  ariaLabel={t("createPr.source")}
                  options={localBranches.map((b) => ({ value: b.name, label: b.name }))}
                />
              </div>
              <span className="mt-5 text-[var(--cf-text-muted)]">→</span>
              <div className="flex-1">
                <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
                  {t("createPr.target")}
                </label>
                <Select
                  value={target}
                  onChange={setTarget}
                  disabled={busy || branches === null}
                  ariaLabel={t("createPr.target")}
                  options={localBranches.map((b) => ({ value: b.name, label: b.name }))}
                />
              </div>
            </div>
            {sameBranch && <p className="-mt-2 mb-2 text-[11px] text-[var(--cf-danger)]">{t("createPr.sameBranch")}</p>}

            {/* The one blocker this form can clear itself. Drawn as a row with its own action
                rather than as an error above the submit button: the submit button is disabled, so
                a message there would say what is wrong and leave the user to go and fix it in
                another view — losing the description, which is the expensive thing on this form. */}
            {!sameBranch && sourceIsLocalOnly && (
              <div className="-mt-1 mb-3 flex items-center gap-2 rounded-md border border-[var(--cf-warning)]/40 bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-2.5 py-2">
                <p className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                  {t("createPr.branchLocalOnly", { branch: source })}
                </p>
                <button
                  onClick={() => void publish()}
                  disabled={busy}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-warning)] px-2 py-1 text-[11px] font-medium text-[var(--cf-warning)] transition-colors hover:bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] disabled:opacity-40"
                >
                  {publishing ? <Loader2 size={11} className="animate-spin" /> : <CloudUpload size={11} />}
                  {publishing ? t("createPr.publishing") : t("createPr.publish")}
                </button>
              </div>
            )}

            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] font-medium text-[var(--cf-text-muted)]">{t("createPr.titleField")}</label>
              <button
                onClick={generate}
                disabled={busy || sameBranch || !source || !target}
                title={t("createPr.generate")}
                className="flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline disabled:opacity-40"
              >
                {generating ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                {generating ? t("createPr.generating") : t("createPr.generate")}
              </button>
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("createPr.titlePlaceholder")}
              disabled={busy}
              className={fieldClass({ className: "mb-3 w-full" })}
            />

            <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
              {t("createPr.description")}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("createPr.descriptionPlaceholder")}
              rows={7}
              disabled={busy}
              className="mb-3 w-full resize-none rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-50"
            />

            {/* Azure only, and above the draft toggle rather than below it: "Work items must be
                linked" is a branch policy, so this is part of whether the PR will pass its checks
                — not an afterthought next to the submit button. The branch and title are mined for
                an id worth suggesting. */}
            {isAzure && (
              <div className="mb-3">
                <WorkItemPicker
                  projectId={project.id}
                  selected={workItems}
                  onChange={setWorkItems}
                  suggestFrom={`${source} ${title}`}
                />
              </div>
            )}

            <label className="mb-4 flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={busy} />
              {t("createPr.draft")}
            </label>

            <div className="flex justify-end gap-2">
              <button
                disabled={busy}
                onClick={onClose}
                className={buttonClass({ variant: "ghost" })}
              >
                {t("common.cancel")}
              </button>
              <button
                disabled={!canSubmit}
                onClick={submit}
                className={buttonClass({ variant: "primary" })}
              >
                {creating ? <Loader2 size={13} className="animate-spin" /> : <GitPullRequest size={13} />}
                {creating ? t("createPr.creating") : t("createPr.create")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
