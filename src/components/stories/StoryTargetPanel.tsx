import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Plug, RefreshCw, SquarePen } from "lucide-react";
import { StoryPromptModal } from "./StoryPromptModal";
import { StoryVerifyPromptModal } from "./StoryVerifyPromptModal";
import { CARD } from "../api/panelChrome";
import { Group, Note } from "../api/settingsChrome";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { loadAdoConnections } from "../../lib/adoConnections";
import {
  adoListClassificationNodes,
  adoListProjects,
  adoListWorkItemTypes,
} from "../../lib/tauri/commands";
import { targetFrom, useStoriesStore, type BoardsTarget } from "../../state/storiesStore";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useActiveProjects } from "../../state/workspaceStore";
import type { AdoClassificationNode, AdoWorkItemType } from "../../types/domain";

/** The work item types most teams mean by "user story", so the picker lands on one instead of on
 * whatever the process happens to list first (which is "Bug" on Agile). */
const PREFERRED_TYPES = ["User Story", "Product Backlog Item", "Historia de usuario", "Requirement", "Issue"];

/** Indents a classification path so the tree is legible in a flat list — an area three levels deep
 * is otherwise indistinguishable from a root one at a glance. */
function nodeLabel(node: AdoClassificationNode): string {
  return `${"  ".repeat(node.depth)}${node.name}`;
}

/**
 * Where this batch publishes: organization, project, work item type, area and iteration.
 *
 * Every list is read from the host rather than typed or assumed — which work item types exist
 * depends on the process the project was created with, and an area path that doesn't exist is a
 * publish that fails one story at a time. The four are dependent, so picking a project clears
 * what was chosen below it instead of leaving a stale type from another project selected.
 *
 * Saved to the batch on every change, not behind a Save button: this is configuration for an
 * action that happens later, and a half-configured target simply leaves the publish button
 * disabled with a reason.
 */
export function StoryTargetPanel({ batchId, width }: { batchId: string; width: number }) {
  const t = useT();
  const batch = useStoriesStore((s) => s.batches.find((b) => b.id === batchId) ?? null);
  const openSettings = useUiStore((s) => s.openSettings);
  const repos = useActiveProjects();

  const [orgs, setOrgs] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [types, setTypes] = useState<AdoWorkItemType[]>([]);
  const [areas, setAreas] = useState<AdoClassificationNode[]>([]);
  const [iterations, setIterations] = useState<AdoClassificationNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState(batch?.instructions ?? "");
  const [tags, setTags] = useState(batch?.tags ?? "");
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [editingVerifyPrompt, setEditingVerifyPrompt] = useState(false);

  const target = batch ? targetFrom(batch) : null;
  const org = target?.org ?? "";
  const project = target?.project ?? "";

  // The batch can be swapped underneath this panel (it is keyed on the batch, so in practice it
  // remounts) — following the row keeps the textarea honest if that ever stops being true.
  useEffect(() => setInstructions(batch?.instructions ?? ""), [batch?.instructions]);
  useEffect(() => setTags(batch?.tags ?? ""), [batch?.tags]);

  useEffect(() => {
    void loadAdoConnections()
      .then((connections) => setOrgs(connections.map((c) => c.org)))
      .catch(() => setOrgs([]));
  }, []);

  const save = useCallback(
    (patch: Partial<BoardsTarget>) => {
      if (!target) return;
      void useStoriesStore.getState().setTarget(batchId, { ...target, ...patch });
    },
    [batchId, target],
  );

  /** Everything below the organization, refetched together — they all depend on the project. */
  const loadProjectLists = useCallback(
    async (nextOrg: string, nextProject: string) => {
      if (!nextOrg || !nextProject) {
        setTypes([]);
        setAreas([]);
        setIterations([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [typeList, areaList, iterationList] = await Promise.all([
          adoListWorkItemTypes(nextOrg, nextProject),
          adoListClassificationNodes(nextOrg, nextProject, "areas"),
          adoListClassificationNodes(nextOrg, nextProject, "iterations"),
        ]);
        setTypes(typeList);
        setAreas(areaList);
        setIterations(iterationList);
      } catch (e: unknown) {
        // Reported in the panel, not as a toast: the lists are right here, and the reason they are
        // empty belongs next to them.
        setError(String(e));
        setTypes([]);
        setAreas([]);
        setIterations([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!org) {
      setProjects([]);
      return;
    }
    void adoListProjects(org)
      .then((list) => setProjects(list.map((p) => p.name)))
      .catch((e: unknown) => {
        setProjects([]);
        setError(String(e));
      });
  }, [org]);

  useEffect(() => {
    void loadProjectLists(org, project);
  }, [org, project, loadProjectLists]);

  // Lands on the type the team actually files stories as — once per list, and only when nothing is
  // chosen, so it never overrides a deliberate pick. The ref is what makes it *once*: `save` is
  // rebuilt on every render (the target is derived, not stored), so without it this effect would
  // re-run and re-write until the store's answer came back.
  const autoPicked = useRef<string | null>(null);
  useEffect(() => {
    if (!target || target.workItemType || types.length === 0) return;
    if (autoPicked.current === project) return;
    const preferred =
      types.find((type) => PREFERRED_TYPES.includes(type.name)) ??
      types.find((type) => PREFERRED_TYPES.some((name) => type.name.includes(name)));
    if (!preferred) return;
    autoPicked.current = project;
    save({ workItemType: preferred.name });
  }, [types, target, project, save]);

  if (!batch || !target) return null;

  return (
    <aside
      style={{ width }}
      className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-[var(--cf-border)] ${CARD}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("stories.target")}
        </span>
        {org && project && (
          <button
            type="button"
            onClick={() => void loadProjectLists(org, project)}
            title={t("stories.reloadLists")}
            aria-label={t("stories.reloadLists")}
            className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <Group title={t("stories.targetAzure")}>
          {orgs.length === 0 ? (
            <>
              <Note tone="warning">{t("stories.noAdoConnection")}</Note>
              <button
                type="button"
                onClick={() => openSettings("azure", "azure")}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <Plug size={12} />
                {t("stories.connectAzure")}
              </button>
            </>
          ) : (
            <div className="space-y-2.5">
              <Field label={t("stories.organization")}>
                <Select
                  size="field"
                  value={org}
                  placeholder={t("stories.pickOrganization")}
                  ariaLabel={t("stories.organization")}
                  // Everything below is scoped to the organization; keeping a project from the
                  // previous one would publish into a board that doesn't exist here.
                  onChange={(value) =>
                    save({ org: value, project: "", workItemType: "", areaPath: "", iterationPath: "" })
                  }
                  options={orgs.map((name) => ({ value: name, label: name }))}
                />
              </Field>

              <Field label={t("stories.project")}>
                <Select
                  size="field"
                  value={project}
                  disabled={!org}
                  placeholder={t("stories.pickProject")}
                  ariaLabel={t("stories.project")}
                  onChange={(value) =>
                    save({ project: value, workItemType: "", areaPath: "", iterationPath: "" })
                  }
                  options={projects.map((name) => ({ value: name, label: name }))}
                />
              </Field>

              <Field label={t("stories.workItemType")} hint={t("stories.workItemTypeHint")}>
                <Select
                  size="field"
                  value={target.workItemType}
                  disabled={!project || types.length === 0}
                  placeholder={t("stories.pickType")}
                  ariaLabel={t("stories.workItemType")}
                  onChange={(value) => save({ workItemType: value })}
                  options={types.map((type) => ({
                    value: type.name,
                    label: type.name,
                    leading: (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: `#${type.color || "888888"}` }}
                      />
                    ),
                  }))}
                />
              </Field>

              <Field label={t("stories.areaPath")} hint={t("stories.pathHint")}>
                <Select
                  size="field"
                  value={target.areaPath}
                  disabled={!project || areas.length === 0}
                  placeholder={t("stories.pathDefault")}
                  ariaLabel={t("stories.areaPath")}
                  onChange={(value) => save({ areaPath: value })}
                  options={[
                    { value: "", label: t("stories.pathDefault") },
                    ...areas.map((node) => ({ value: node.path, label: nodeLabel(node) })),
                  ]}
                />
              </Field>

              <Field label={t("stories.iterationPath")} hint={t("stories.pathHint")}>
                <Select
                  size="field"
                  value={target.iterationPath}
                  disabled={!project || iterations.length === 0}
                  placeholder={t("stories.pathDefault")}
                  ariaLabel={t("stories.iterationPath")}
                  onChange={(value) => save({ iterationPath: value })}
                  options={[
                    { value: "", label: t("stories.pathDefault") },
                    ...iterations.map((node) => ({ value: node.path, label: nodeLabel(node) })),
                  ]}
                />
              </Field>

              <Field label={t("stories.batchTags")} hint={t("stories.batchTagsHint")}>
                {/* Local until blur, unlike the dropdowns above: a select fires once per choice,
                    a text field would fire once per keystroke — and each one is a database write. */}
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  onBlur={() => {
                    if (tags !== target.tags) save({ tags });
                  }}
                  placeholder="backlog; checkout"
                  className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
                />
              </Field>

              {error && (
                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">
                  <CircleAlert size={11} className="mt-[2px] shrink-0" />
                  <span className="min-w-0 break-words">{error}</span>
                </p>
              )}
            </div>
          )}
        </Group>

        <Group title={t("stories.generation")}>
          <Field label={t("stories.instructions")} hint={t("stories.instructionsRailHint")}>
            <textarea
              value={instructions}
              rows={4}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => {
                if (instructions !== batch.instructions) {
                  void useStoriesStore.getState().setInstructions(batchId, instructions);
                }
              }}
              placeholder={t("stories.instructionsPlaceholder")}
              className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
            />
          </Field>
          {batch.provider && (
            <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">
              {t("stories.ranOn", { provider: batch.provider, model: batch.model || "—" })}
            </p>
          )}
          <Note>{t("stories.promptHint")}</Note>
          <button
            type="button"
            onClick={() => setEditingPrompt(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <SquarePen size={12} />
            {t("stories.editPrompt")}
          </button>
        </Group>

        {/* QA: which repository the criteria are checked against, and where the .feature lands.
            A separate choice from the Azure target above — one says where the backlog is filed,
            this one says where the behaviour is supposed to already exist. */}
        <Group title={t("qa.group")}>
          {repos.length === 0 ? (
            <Note tone="warning">{t("qa.noRepos")}</Note>
          ) : (
            <Field label={t("qa.repository")} hint={t("qa.repositoryHint")}>
              <Select
                size="field"
                value={batch.verify_project_id ?? ""}
                placeholder={t("qa.pickRepository")}
                ariaLabel={t("qa.repository")}
                onChange={(value) =>
                  void useStoriesStore.getState().setVerifyProject(batchId, value || null)
                }
                options={[
                  { value: "", label: t("qa.noRepository") },
                  ...repos.map((repo) => ({ value: repo.id, label: repo.name })),
                ]}
              />
            </Field>
          )}
          <Note>{t("qa.groupHint")}</Note>
          {batch.verified_at && (
            <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">
              {t("qa.lastVerified", {
                at: new Date(batch.verified_at).toLocaleString(),
                provider: batch.verify_provider || "—",
                model: batch.verify_model || "—",
              })}
            </p>
          )}
          <button
            type="button"
            onClick={() => setEditingVerifyPrompt(true)}
            className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <SquarePen size={12} />
            {t("qa.editVerifyPrompt")}
          </button>
        </Group>
      </div>

      {editingPrompt && <StoryPromptModal onClose={() => setEditingPrompt(false)} />}
      {editingVerifyPrompt && <StoryVerifyPromptModal onClose={() => setEditingVerifyPrompt(false)} />}
    </aside>
  );
}
