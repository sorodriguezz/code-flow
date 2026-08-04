import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, FileSearch, Plug, RefreshCw, SquarePen } from "lucide-react";
import { StoryPromptModal } from "./StoryPromptModal";
import { StoryRunPromptModal } from "./StoryRunPromptModal";
import { StoryVerifyPromptModal } from "./StoryVerifyPromptModal";
import { CARD } from "../api/panelChrome";
import { Group, Note } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { loadAdoConnections } from "../../lib/adoConnections";
import { loadJiraConnections } from "../../lib/jiraConnections";
import { loadMondayConnections } from "../../lib/mondayConnections";
import {
  adoListClassificationNodes,
  adoListProjects,
  boardListItemTypes,
  jiraListProjects,
  mondayBoardSchema,
  mondayListBoards,
} from "../../lib/tauri/commands";
import {
  parseVerifyProjectIds,
  targetFrom,
  useStoriesStore,
  type BoardsTarget,
} from "../../state/storiesStore";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useActiveProjects } from "../../state/workspaceStore";
import type {
  AdoClassificationNode,
  BoardItemType,
  BoardProvider,
  MondayBoardSchema,
} from "../../types/domain";

/** One entry of a target's host list. `value` is what gets stored; `label` is what is shown. */
interface Option {
  value: string;
  label: string;
}

/** The work item types most teams mean by "user story", so the picker lands on one instead of on
 * whatever the process happens to list first (which is "Bug" on Agile). */
const PREFERRED_TYPES = ["User Story", "Product Backlog Item", "Historia de usuario", "Requirement", "Issue"];

/**
 * What gets stored for a chosen slot.
 *
 * An id for Jira and monday, a name for Azure — because that is what each host's create call takes.
 * Two schemes on one Jira site can both define "Task" and two groups on a monday board can share a
 * title, so a name would resolve against whichever the API felt like; Azure, conversely, addresses a
 * work item type by the name shown on the form.
 */
function typeValue(type: BoardItemType, byId: boolean): string {
  return byId ? type.reference_name : type.name;
}

/** Indents a classification path so the tree is legible in a flat list — an area three levels deep
 * is otherwise indistinguishable from a root one at a glance. */
function nodeLabel(node: AdoClassificationNode): string {
  return `${"  ".repeat(node.depth)}${node.name}`;
}

/**
 * Where this batch publishes: the board, then the host, the container and the slot it names.
 *
 * Every list is read from the host rather than typed or assumed — which work item types exist
 * depends on the Azure process, the Jira issue-type scheme or the groups somebody made on a monday
 * board, and an area path that doesn't exist is a publish that fails one story at a time. The fields are dependent, so picking a project clears
 * what was chosen below it instead of leaving a stale type from another project selected; changing
 * the *board* clears all of it, because none of those values means anything on the other one.
 *
 * Area and iteration appear only for Azure. They are not disabled-but-visible: Jira has no such
 * concept at all, and a greyed-out field implies one that could be filled in.
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
  const [sites, setSites] = useState<Option[]>([]);
  const [mondayAccounts, setMondayAccounts] = useState<Option[]>([]);
  const [mondaySchema, setMondaySchema] = useState<MondayBoardSchema | null>(null);
  const [projects, setProjects] = useState<Option[]>([]);
  const [types, setTypes] = useState<BoardItemType[]>([]);
  const [areas, setAreas] = useState<AdoClassificationNode[]>([]);
  const [iterations, setIterations] = useState<AdoClassificationNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState(batch?.instructions ?? "");
  const [tags, setTags] = useState(batch?.tags ?? "");
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [showingRunPrompt, setShowingRunPrompt] = useState(false);
  const [editingVerifyPrompt, setEditingVerifyPrompt] = useState(false);

  const target = batch ? targetFrom(batch) : null;
  const provider: BoardProvider = target?.provider ?? "azure";
  const isJira = provider === "jira";
  const isMonday = provider === "monday";
  const org = target?.org ?? "";
  const project = target?.project ?? "";
  const hosts: Option[] =
    isJira ? sites : isMonday ? mondayAccounts : orgs.map((name) => ({ value: name, label: name }));
  const verifyIds = useMemo(
    () => (batch ? parseVerifyProjectIds(batch.verify_project_ids) : []),
    [batch],
  );

  // The batch can be swapped underneath this panel (it is keyed on the batch, so in practice it
  // remounts) — following the row keeps the textarea honest if that ever stops being true.
  useEffect(() => setInstructions(batch?.instructions ?? ""), [batch?.instructions]);
  useEffect(() => setTags(batch?.tags ?? ""), [batch?.tags]);

  useEffect(() => {
    void loadAdoConnections()
      .then((connections) => setOrgs(connections.map((c) => c.org)))
      .catch(() => setOrgs([]));
    // Both lists are loaded whichever board is selected, so switching boards doesn't wait on a
    // round trip to find out there is nothing connected.
    void loadJiraConnections()
      .then((connections) =>
        setSites(
          connections.map((c) => ({
            value: c.site,
            // The account is part of the identity here: two connections to the same site under
            // different accounts see different projects.
            label: c.email ? `${c.site} · ${c.email}` : c.site,
          })),
        ),
      )
      .catch(() => setSites([]));
    void loadMondayConnections()
      .then((connections) =>
        setMondayAccounts(
          connections.map((c) => ({ value: c.slug, label: c.name || c.slug })),
        ),
      )
      .catch(() => setMondayAccounts([]));
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
    async (nextProvider: BoardProvider, nextOrg: string, nextProject: string) => {
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
          boardListItemTypes(nextProvider, nextOrg, nextProject),
          // Azure-only trees. Asking Jira for them would be a guaranteed 404 on every project pick.
          nextProvider === "azure"
            ? adoListClassificationNodes(nextOrg, nextProject, "areas")
            : Promise.resolve([]),
          nextProvider === "azure"
            ? adoListClassificationNodes(nextOrg, nextProject, "iterations")
            : Promise.resolve([]),
        ]);
        // A sub-task type can't be created without a parent, and a story has none — offering one
        // would be offering a publish that fails for every story in the set.
        setTypes(typeList.filter((type) => !type.subtask));
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
    // The stored value differs by board because the create call does: Azure addresses a project by
    // name, Jira by key. Storing what each host wants is what keeps `publish` from having to
    // translate — and a key shown on its own ("WEB") tells a Jira user less than "WEB · Web Store".
    const list = isJira
      ? jiraListProjects(org).then((found) =>
          found.map((p) => ({ value: p.key, label: p.name ? `${p.key} · ${p.name}` : p.key })),
        )
      : isMonday
        ? mondayListBoards(org).then((found) => found.map((b) => ({ value: b.id, label: b.name })))
        : adoListProjects(org).then((found) => found.map((p) => ({ value: p.name, label: p.name })));
    void list
      .then(setProjects)
      .catch((e: unknown) => {
        setProjects([]);
        setError(String(e));
      });
  }, [org, isJira, isMonday]);

  // The mapping is read alongside the lists rather than at publish time, so "this board has nowhere
  // to put a story" is something the panel says while the user is still choosing the board.
  useEffect(() => {
    if (!isMonday || !org || !project) {
      setMondaySchema(null);
      return;
    }
    void mondayBoardSchema(org, project)
      .then(setMondaySchema)
      .catch(() => setMondaySchema(null));
  }, [isMonday, org, project]);

  useEffect(() => {
    void loadProjectLists(provider, org, project);
  }, [provider, org, project, loadProjectLists]);

  // Lands on the type the team actually files stories as — once per list, and only when nothing is
  // chosen, so it never overrides a deliberate pick. The ref is what makes it *once*: `save` is
  // rebuilt on every render (the target is derived, not stored), so without it this effect would
  // re-run and re-write until the store's answer came back.
  const autoPicked = useRef<string | null>(null);
  useEffect(() => {
    if (!target || target.workItemType || types.length === 0) return;
    // Only Azure and Jira have a conventional "this is what a story is" type. A monday group is
    // whatever somebody named it, so landing on the first one would be a decision, not a default.
    if (isMonday) return;
    if (autoPicked.current === project) return;
    const preferred =
      types.find((type) => PREFERRED_TYPES.includes(type.name)) ??
      types.find((type) => PREFERRED_TYPES.some((name) => type.name.includes(name)));
    if (!preferred) return;
    autoPicked.current = project;
    save({ workItemType: typeValue(preferred, isJira || isMonday) });
  }, [types, target, project, save, isMonday, isJira]);

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
            onClick={() => void loadProjectLists(provider, org, project)}
            title={t("stories.reloadLists")}
            aria-label={t("stories.reloadLists")}
            className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <Group
          title={
            isJira
              ? t("stories.targetJira")
              : isMonday
                ? t("stories.targetMonday")
                : t("stories.targetAzure")
          }
        >
          <div className="mb-2.5">
            <Field label={t("stories.board")} hint={t("stories.boardHint")}>
              <Select
                size="field"
                value={provider}
                ariaLabel={t("stories.board")}
                // Nothing below survives the switch. An org, a project and a type are all names on
                // one host, and carrying them across would leave a target that looks configured and
                // fails on the first story.
                onChange={(value) =>
                  save({
                    provider: value as BoardProvider,
                    org: "",
                    project: "",
                    workItemType: "",
                    areaPath: "",
                    iterationPath: "",
                  })
                }
                options={[
                  { value: "azure", label: t("stories.targetAzure") },
                  { value: "jira", label: t("stories.targetJira") },
                  { value: "monday", label: t("stories.targetMonday") },
                ]}
              />
            </Field>
          </div>

          {hosts.length === 0 ? (
            <>
              <Note tone="warning">
                {isJira
                  ? t("stories.noJiraConnection")
                  : isMonday
                    ? t("stories.noMondayConnection")
                    : t("stories.noAdoConnection")}
              </Note>
              <button
                type="button"
                onClick={() => openSettings("azure", isJira ? "jira" : isMonday ? "monday" : "azure")}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <Plug size={12} />
                {isJira
                  ? t("stories.connectJira")
                  : isMonday
                    ? t("stories.connectMonday")
                    : t("stories.connectAzure")}
              </button>
            </>
          ) : (
            <div className="space-y-2.5">
              <Field
                label={
                  isJira ? t("stories.site") : isMonday ? t("stories.account") : t("stories.organization")
                }
              >
                <Select
                  size="field"
                  value={org}
                  placeholder={
                    isJira
                      ? t("stories.pickSite")
                      : isMonday
                        ? t("stories.pickAccount")
                        : t("stories.pickOrganization")
                  }
                  ariaLabel={
                    isJira ? t("stories.site") : isMonday ? t("stories.account") : t("stories.organization")
                  }
                  // Everything below is scoped to the host; keeping a project from the previous one
                  // would publish into a board that doesn't exist here.
                  onChange={(value) =>
                    save({ org: value, project: "", workItemType: "", areaPath: "", iterationPath: "" })
                  }
                  options={hosts}
                />
              </Field>

              <Field label={isMonday ? t("stories.board_") : t("stories.project")}>
                <Select
                  size="field"
                  value={project}
                  disabled={!org}
                  placeholder={isMonday ? t("stories.pickBoard") : t("stories.pickProject")}
                  ariaLabel={isMonday ? t("stories.board_") : t("stories.project")}
                  onChange={(value) =>
                    save({ project: value, workItemType: "", areaPath: "", iterationPath: "" })
                  }
                  options={projects}
                />
              </Field>

              <Field
                label={
                  isJira
                    ? t("stories.issueType")
                    : isMonday
                      ? t("stories.group")
                      : t("stories.workItemType")
                }
                hint={
                  isJira
                    ? t("stories.issueTypeHint")
                    : isMonday
                      ? t("stories.groupHint")
                      : t("stories.workItemTypeHint")
                }
              >
                <Select
                  size="field"
                  value={target.workItemType}
                  disabled={!project || types.length === 0}
                  placeholder={t("stories.pickType")}
                  ariaLabel={
                    isJira
                      ? t("stories.issueType")
                      : isMonday
                        ? t("stories.group")
                        : t("stories.workItemType")
                  }
                  onChange={(value) => save({ workItemType: value })}
                  options={types.map((type) => ({
                    value: typeValue(type, isJira || isMonday),
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

              {/* monday only: what this app worked out about a board that has no schema. Printed
                  rather than assumed, because it is the one target where the app is guessing. */}
              {isMonday && project && mondaySchema && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                    {t("stories.mondayMapping")}
                  </p>
                  {mondaySchema.text_column ? (
                    <ul className="space-y-0.5 text-[11px] text-[var(--cf-text)]">
                      <li>
                        {t("stories.mondayMappingText", { column: mondaySchema.text_column.title })}
                      </li>
                      {mondaySchema.numbers_column && (
                        <li>
                          {t("stories.mondayMappingPoints", {
                            column: mondaySchema.numbers_column.title,
                          })}
                        </li>
                      )}
                    </ul>
                  ) : (
                    // Said here, while the board is still being chosen, rather than discovered as a
                    // failed publish twelve stories in.
                    <Note tone="warning">{t("stories.mondayNoTextColumn")}</Note>
                  )}
                  <Note>{t("stories.mondayMappingHint")}</Note>
                </div>
              )}

              {/* Azure only, and absent rather than disabled elsewhere: a greyed-out field implies a
                  value that could be filled in, and neither of the other boards has one. */}
              {!isJira && !isMonday && (
                <>
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
                </>
              )}

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
                  className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
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

        {/* Both closed to start: the Azure target above is what a new set needs first, and these two
            are read again only when a generation came out wrong or QA is about to run. */}
        <Group title={t("stories.generation")} collapsible defaultOpen={false}>
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
              className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
            />
          </Field>
          {batch.provider && (
            <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">
              {t("stories.ranOn", { provider: batch.provider, model: batch.model || "—" })}
            </p>
          )}
          <Note>{t("stories.promptHint")}</Note>
          {/* Two prompts, and the order says which is which: what this set already ran with (a
              record, above) and what the next one will run with (an editor, below). */}
          <button
            type="button"
            onClick={() => setShowingRunPrompt(true)}
            className="mb-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <FileSearch size={12} />
            {t("stories.usedPrompt")}
          </button>
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
        <Group title={t("qa.group")} collapsible defaultOpen={false}>
          {repos.length === 0 ? (
            <Note tone="warning">{t("qa.noRepos")}</Note>
          ) : (
            <>
              {/* Checkboxes rather than a multi-select: the list is the workspace's repositories,
                  short enough to read at a glance, and which ones are ticked is the whole question
                  this group answers. */}
              <Field label={t("qa.repositories")} hint={t("qa.repositoriesHint")}>
                <div className="space-y-1 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5">
                  {repos.map((repo) => (
                    <label
                      key={repo.id}
                      className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text)]"
                    >
                      <Checkbox
                        checked={verifyIds.includes(repo.id)}
                        onChange={(on) =>
                          void useStoriesStore
                            .getState()
                            .setVerifyProjects(
                              batchId,
                              on ? [...verifyIds, repo.id] : verifyIds.filter((id) => id !== repo.id),
                            )
                        }
                      />
                      <span className="min-w-0 truncate">{repo.name}</span>
                    </label>
                  ))}
                </div>
              </Field>

              {/* Only once there is a choice to make. With one repository the export already lands
                  there, and a dropdown with a single option is a question with one answer. */}
              {verifyIds.length > 1 && (
                <Field label={t("qa.featureRepository")} hint={t("qa.featureRepositoryHint")}>
                  <Select
                    size="field"
                    value={batch.feature_project_id ?? verifyIds[0]}
                    ariaLabel={t("qa.featureRepository")}
                    onChange={(value) =>
                      void useStoriesStore.getState().setFeatureProject(batchId, value || null)
                    }
                    options={verifyIds.map((id) => ({
                      value: id,
                      label: repos.find((repo) => repo.id === id)?.name ?? id,
                    }))}
                  />
                </Field>
              )}
            </>
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
      {showingRunPrompt && (
        <StoryRunPromptModal batchId={batchId} onClose={() => setShowingRunPrompt(false)} />
      )}
      {editingVerifyPrompt && <StoryVerifyPromptModal onClose={() => setEditingVerifyPrompt(false)} />}
    </aside>
  );
}
