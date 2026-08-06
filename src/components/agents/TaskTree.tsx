import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  Folder,
  FolderOpen,
  GitCompare,
  Link2,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { AGENT_STATUS } from "./agentStatus";
import { chainRollup } from "./chainStatus";
import { RenameRow, Row, menuBlocks } from "./TreeRow";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { relativeTime } from "../api/settingsChrome";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { OPEN_BY_DEFAULT, useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type {
  AgentChain,
  AgentProject,
  AgentTask,
  ChainStepBrief,
  ChainTemplate,
} from "../../types/domain";

/**
 * A row of the tree, before it is drawn.
 *
 * A chain and a task are alternatives at the same level, which is the whole point: a chain is the
 * unit of work you filed, and the tasks it produced belong *inside* it rather than beside it. Every
 * placement decision below — pinned, filed, loose — is made on this and never on the two kinds
 * separately, so the two can never disagree about which section they live in.
 */
type Item = { kind: "chain"; chain: AgentChain } | { kind: "task"; task: AgentTask };

const itemGroup = (item: Item) => (item.kind === "chain" ? item.chain.agent_project_id : item.task.agent_project_id);
const itemPinned = (item: Item) => (item.kind === "chain" ? item.chain.pinned : item.task.pinned);
const itemStamp = (item: Item) => (item.kind === "chain" ? item.chain.updated_at : item.task.updated_at);

/** Which row a menu belongs to. The kind travels with the id because the four row kinds have four
 * different menus and three of them can share an id space only by accident. */
type MenuTarget = { x: number; y: number; kind: "task" | "chain" | "project" | "template"; id: string };
/** The second menu: "move to project", opened at the point the first one was. */
type MoveTarget = { x: number; y: number; kind: "task" | "chain"; id: string };
/** What is being renamed in place. */
type Renaming = { kind: "task" | "project" | "template"; id: string };

const NO_BRIEFS: ChainStepBrief[] = [];

/**
 * The "Tasks" tab: everything this workspace has agents working on, arranged the way it was filed.
 *
 * Four sections, in the order the questions come: which piece of work is this part of (**projects**),
 * what did I say I would come back to (**pinned**), what else is going on (**tasks**), and what do I
 * run over and over (**templates**). An item appears in exactly one of them — pinned wins over
 * filed, filed wins over loose — because a row in two places is a row you act on twice.
 *
 * A chain is one row showing its objective, opened to reveal the tasks its steps produced. That
 * nesting is not decoration: the steps' tasks are ordinary `AgentTask` rows that would otherwise sit
 * loose in the list, several per chain, each named after an instruction and none of them saying what
 * the plan was for.
 */
export function TaskTree({
  tasks,
  query,
  onNewTask,
  onNewChain,
  onNewProject,
  onEditProject,
  onContinueWith,
  onUseTemplate,
  view = "tasks",
}: {
  /** Already filtered by the search box above. */
  tasks: AgentTask[];
  /** What was typed into that box. The list cannot filter chains for us — it only knows about
   * tasks — and a search that quietly left every chain in place would answer the question wrong in
   * the one section most likely to hold the answer. */
  query: string;
  onNewTask: (agentProjectId: string) => void;
  onNewChain: (agentProjectId: string) => void;
  onNewProject: () => void;
  onEditProject: (project: AgentProject) => void;
  onContinueWith: (taskId: string) => void;
  onUseTemplate: (templateId: string) => void;
  /** Which tab is asking. `templates` draws the saved plans alone; everything else about this
   * component — the context menu, the inline rename — is shared, which is why it is a mode rather
   * than a second component. */
  view?: "tasks" | "templates";
}) {
  const t = useT();
  const projects = useAgentsStore((s) => s.projects);
  const open = useAgentsStore((s) => s.open);
  const toggleOpen = useAgentsStore((s) => s.toggleOpen);
  const chains = useChainStore((s) => s.chains);
  const briefsByChain = useChainStore((s) => s.briefsByChain);
  const templates = useChainStore((s) => s.templates);
  const activeView = useUiStore((s) => s.activeView);

  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [move, setMove] = useState<MoveTarget | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);

  // Both menus portal to `document.body`, and this view is hidden rather than unmounted — left
  // open, they would float over whatever the user switched to.
  useEffect(() => {
    if (activeView !== "agents") {
      setMenu(null);
      setMove(null);
    }
  }, [activeView]);

  const needle = query.trim().toLowerCase();

  const { items, chainOfTask } = useMemo(() => {
    const known = new Set(chains.map((chain) => chain.id));
    /** task id → the chain that produced it, for chains that still exist. A brief left behind by a
     * deleted chain is deliberately ignored: its task is then an ordinary task, which is exactly
     * what it has become. */
    const owner = new Map<string, string>();
    for (const [chainId, briefs] of Object.entries(briefsByChain)) {
      if (!known.has(chainId)) continue;
      for (const brief of briefs) if (brief.task_id) owner.set(brief.task_id, chainId);
    }
    // A chain survives a search on its own words *or* on its steps': the tasks handed in have
    // already been filtered, so a chain that still owns one of them is a chain the search found —
    // which is what makes typing a step's agent name pull up the plan it belongs to.
    const surviving = new Set(tasks.map((task) => task.id));
    const keeps = (chain: AgentChain) => {
      if (!needle) return true;
      if (chain.title.toLowerCase().includes(needle) || chain.goal.toLowerCase().includes(needle)) return true;
      return (briefsByChain[chain.id] ?? NO_BRIEFS).some(
        (brief) =>
          (brief.task_id !== "" && surviving.has(brief.task_id)) ||
          brief.agent_name.toLowerCase().includes(needle) ||
          brief.instruction.toLowerCase().includes(needle),
      );
    };
    const rows: Item[] = [
      ...chains.filter(keeps).map((chain) => ({ kind: "chain" as const, chain })),
      ...tasks.filter((task) => !owner.has(task.id)).map((task) => ({ kind: "task" as const, task })),
    ];
    rows.sort((a, b) => itemStamp(b).localeCompare(itemStamp(a)));
    return { items: rows, chainOfTask: owner };
  }, [chains, briefsByChain, tasks, needle]);

  // The three buckets, decided once so the same item cannot fall into two of them.
  const { pinned, byProject, loose } = useMemo(() => {
    const filed = new Set(projects.map((project) => project.id));
    const pinnedRows: Item[] = [];
    const grouped = new Map<string, Item[]>();
    const looseRows: Item[] = [];
    for (const item of items) {
      if (itemPinned(item)) {
        pinnedRows.push(item);
        continue;
      }
      const group = itemGroup(item);
      // A folder that was deleted in another window leaves its id behind on the row; the work falls
      // back to the loose list rather than vanishing into a section that is not drawn.
      if (group && filed.has(group)) {
        const bucket = grouped.get(group);
        if (bucket) bucket.push(item);
        else grouped.set(group, [item]);
        continue;
      }
      looseRows.push(item);
    }
    return { pinned: pinnedRows, byProject: grouped, loose: looseRows };
  }, [items, projects]);

  // The default has to come from the store: `toggleOpen` flips against the same set, and a second
  // copy here that disagreed would make the first click on a section write the value it already
  // had — a control that visibly does nothing once, then works.
  const isOpen = (key: string) => open[key] ?? OPEN_BY_DEFAULT.has(key);
  const projectOf = (id: string) => projects.find((project) => project.id === id) ?? null;

  const closeMenus = () => {
    setMenu(null);
    setMove(null);
  };

  const renderItem = (item: Item, depth: number, chip?: string, at = 0) =>
    item.kind === "chain" ? (
      <ChainGroup
        key={item.chain.id}
        chain={item.chain}
        briefs={briefsByChain[item.chain.id] ?? NO_BRIEFS}
        expanded={needle !== "" || isOpen(`chain:${item.chain.id}`)}
        depth={depth}
        at={at}
        chip={chip}
        onToggle={() => toggleOpen(`chain:${item.chain.id}`)}
        onMenu={(x, y) => setMenu({ x, y, kind: "chain", id: item.chain.id })}
        onTaskMenu={(x, y, id) => setMenu({ x, y, kind: "task", id })}
      />
    ) : renaming?.kind === "task" && renaming.id === item.task.id ? (
      <RenameRow
        key={item.task.id}
        depth={depth}
        value={item.task.title}
        onCancel={() => setRenaming(null)}
        onCommit={(name) => {
          void useAgentsStore.getState().rename(item.task.id, name);
          setRenaming(null);
        }}
      />
    ) : (
      <TaskRow
        key={item.task.id}
        task={item.task}
        depth={depth}
        at={at}
        chip={chip}
        onMenu={(x, y) => setMenu({ x, y, kind: "task", id: item.task.id })}
      />
    );

  /** One saved plan, as a row or as the inline rename it is in the middle of. Lives here rather than
   * inside the templates branch so it keeps sharing this component's context menu and rename state —
   * the tab moved, the machinery behind it did not. */
  const renderTemplate = (template: ChainTemplate, at: number) =>
    renaming?.kind === "template" && renaming.id === template.id ? (
      <RenameRow
        key={template.id}
        value={template.name}
        onCancel={() => setRenaming(null)}
        onCommit={(name) => {
          if (name.trim()) {
            void useChainStore
              .getState()
              .saveTemplate({
                id: template.id,
                name: name.trim(),
                description: template.description,
                steps: template.steps.map(({ agent_id, instruction, gate }) => ({ agent_id, instruction, gate })),
              })
              .catch((e: unknown) => pushErrorToast(String(e)));
          }
          setRenaming(null);
        }}
      />
    ) : (
      <TemplateRow
        key={template.id}
        templateId={template.id}
        at={at}
        name={template.name}
        description={template.description}
        steps={template.steps.length}
        onMenu={(x, y) => setMenu({ x, y, kind: "template", id: template.id })}
      />
    );

  /** Templates are their own tab rather than a fourth section of the tree: they are not work in
   * progress, they are the plans work gets started from, and a collapsed section is where they went
   * unnoticed. The search box above stays honest here by filtering them too — a box that visibly
   * does nothing on one tab reads as broken. */
  if (view === "templates") {
    const matches = needle
      ? templates.filter(
          (template) =>
            template.name.toLowerCase().includes(needle) ||
            template.description.toLowerCase().includes(needle),
        )
      : templates;
    return (
      <>
        <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          <span className="truncate">{t("agents.sectionTemplates")}</span>
          {matches.length > 0 && (
            <span className="shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] font-semibold dark:bg-white/[0.1]">
              {matches.length}
            </span>
          )}
          <button
            type="button"
            onClick={() => onNewChain("")}
            title={t("agents.newTemplate")}
            aria-label={t("agents.newTemplate")}
            className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.06] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.1]"
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="px-1.5 pb-1">
          {matches.length === 0 ? (
            <Hint>{t(needle ? "agents.noMatches" : "agents.templatesEmptyHint")}</Hint>
          ) : (
            matches.map(renderTemplate)
          )}
        </div>

        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={menuItemsFor(menu, {
              t,
              projects,
              chainOfTask,
              onContinueWith,
              onUseTemplate,
              onEditProject,
              onNewTask,
              onNewChain,
              startRename: (kind, id) => setRenaming({ kind, id }),
              startMove: (kind, id) => setMove({ x: menu.x, y: menu.y, kind, id }),
            })}
            onClose={() => setMenu(null)}
          />
        )}
      </>
    );
  }

  // A search that found nothing says so once, rather than drawing three headings and a row of empty
  // hints that each look like an answer.
  if (needle !== "" && items.length === 0) {
    return <p className="px-2 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">{t("agents.noMatches")}</p>;
  }

  return (
    <>
      <Section
        label={t("agents.sectionProjects")}
        count={projects.length}
        expanded={isOpen("sec:projects")}
        onToggle={() => toggleOpen("sec:projects")}
        action={{ icon: Plus, label: t("agents.newProject"), onClick: onNewProject }}
      >
        {projects.length === 0 ? (
          <Hint>{t("agents.projectsEmptyHint")}</Hint>
        ) : (
          projects.map((project, at) => {
            const contents = byProject.get(project.id) ?? [];
            // A search opens everything it could have found something in. Leaving a folder shut
            // during one means the list says "no such task" by omission, from a row the user can
            // see is collapsed.
            const expanded = needle !== "" || isOpen(`proj:${project.id}`);
            return (
              <div key={project.id}>
                {renaming?.kind === "project" && renaming.id === project.id ? (
                  <RenameRow
                    value={project.name}
                    onCancel={() => setRenaming(null)}
                    onCommit={(name) => {
                      if (name.trim()) {
                        void useAgentsStore
                          .getState()
                          .saveProject({ id: project.id, name: name.trim(), description: project.description, color: project.color })
                          .catch((e: unknown) => pushErrorToast(String(e)));
                      }
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <Row
                    selected={false}
                    at={at}
                    title={project.description || project.name}
                    label={project.name}
                    // Items, not tasks: one of these rows can be a whole chain, and counting a
                    // three-step plan as "1 task" would understate the folder by two.
                    meta={
                      project.description.trim() ||
                      (contents.length === 0
                        ? t("agents.projectEmpty")
                        : t("agents.projectItemsN", { n: contents.length }))
                    }
                    glyph={
                      expanded ? (
                        <FolderOpen size={13} style={{ color: project.color }} />
                      ) : (
                        <Folder size={13} style={{ color: project.color }} />
                      )
                    }
                    leading={<Chevron expanded={expanded} onClick={() => toggleOpen(`proj:${project.id}`)} />}
                    menuLabel={t("api.moreActions")}
                    onClick={() => toggleOpen(`proj:${project.id}`)}
                    onMenu={(x, y) => setMenu({ x, y, kind: "project", id: project.id })}
                  />
                )}
                {expanded &&
                  (contents.length === 0 ? (
                    <Hint depth={1}>{t("agents.projectEmpty")}</Hint>
                  ) : (
                    contents.map((item, index) => renderItem(item, 1, undefined, index))
                  ))}
              </div>
            );
          })
        )}
      </Section>

      {/* Only drawn when something is pinned: an empty "Pinned" heading is a permanent reminder of a
          feature rather than a place anything lives. */}
      {pinned.length > 0 && (
        <Section
          label={t("agents.sectionPinned")}
          count={pinned.length}
          expanded={isOpen("sec:pinned")}
          onToggle={() => toggleOpen("sec:pinned")}
        >
          {/* The chip carries the folder the row came from — pinning is the one act that takes a row
              out of its project, so this is where that has to be said. */}
          {pinned.map((item, at) => renderItem(item, 0, projectOf(itemGroup(item))?.name, at))}
        </Section>
      )}

      <Section
        label={t("agents.sectionTasks")}
        count={loose.length}
        expanded={isOpen("sec:tasks")}
        onToggle={() => toggleOpen("sec:tasks")}
      >
        {loose.length === 0 ? (
          <Hint>{t("agents.treeEmpty")}</Hint>
        ) : (
          loose.map((item, at) => renderItem(item, 0, undefined, at))
        )}
      </Section>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItemsFor(menu, {
            t,
            projects,
            chainOfTask,
            onContinueWith,
            onUseTemplate,
            onEditProject,
            onNewTask,
            onNewChain,
            startRename: (kind, id) => setRenaming({ kind, id }),
            startMove: (kind, id) => setMove({ x: menu.x, y: menu.y, kind, id }),
          })}
          onClose={() => setMenu(null)}
        />
      )}

      {/* A second menu rather than a submenu: `ContextMenu` has no nesting, and a dialog for
          "put this in that folder" is three clicks for a choice that is one. */}
      {move && (
        <ContextMenu
          x={move.x}
          y={move.y}
          heading={t("agents.moveToProject")}
          items={[
            {
              label: t("agents.projectNone"),
              icon: Folder,
              onClick: () => fileUnder(move, ""),
            },
            ...projects.map((project, at) => ({
              label: project.name,
              icon: Folder,
              separated: at === 0,
              onClick: () => fileUnder(move, project.id),
            })),
          ]}
          onClose={closeMenus}
        />
      )}
    </>
  );
}

function fileUnder(target: MoveTarget, agentProjectId: string) {
  if (target.kind === "task") void useAgentsStore.getState().setTaskGroup(target.id, agentProjectId);
  else void useChainStore.getState().setGroup(target.id, agentProjectId);
}

/** A collapsible heading with a count and, for the two sections you add to, one action. */
function Section({
  label,
  count,
  expanded,
  onToggle,
  action,
  children,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  action?: { icon: typeof Plus; label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="group/section flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {expanded ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
          <span className="truncate">{label}</span>
          {count > 0 && (
            <span className="shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] font-semibold dark:bg-white/[0.1]">
              {count}
            </span>
          )}
        </button>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            title={action.label}
            aria-label={action.label}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 hover:bg-black/[0.06] hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover/section:opacity-100 dark:hover:bg-white/[0.1]"
          >
            <action.icon size={12} />
          </button>
        )}
      </div>
      {expanded && <div className="px-1.5 pb-1">{children}</div>}
    </section>
  );
}

/** One muted line where a section has nothing in it. Deliberately not an `EmptyState`: three of
 * those stacked down a 320px rail would be the whole list. */
function Hint({ children, depth = 0 }: { children: React.ReactNode; depth?: number }) {
  return (
    <p style={{ paddingLeft: depth * 14 }} className="px-2 py-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
      {children}
    </p>
  );
}

function Chevron({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      // Stops at the chevron: opening a folder must not also swap the middle column, and a chain's
      // expander is right next to the part of the row that does exactly that.
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-4 w-4 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
    >
      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </button>
  );
}

/**
 * A chain, and — opened — the work it produced.
 *
 * The label is the **objective**, not the chain's name: the name is usually the ticket, and what you
 * are looking for in a list of five plans is which one was about the thing you have in mind.
 */
function ChainGroup({
  chain,
  briefs,
  expanded,
  depth,
  at,
  chip,
  onToggle,
  onMenu,
  onTaskMenu,
}: {
  chain: AgentChain;
  briefs: ChainStepBrief[];
  expanded: boolean;
  depth: number;
  at: number;
  chip?: string;
  onToggle: () => void;
  onMenu: (x: number, y: number) => void;
  onTaskMenu: (x: number, y: number, taskId: string) => void;
}) {
  const t = useT();
  const selected = useChainStore((s) => s.selectedId === chain.id);
  const tasks = useAgentsStore((s) => s.tasks);
  const repoName = useRepoName(chain.project_id);
  const { icon: Icon, color, labelKey, done, total, spinner } = chainRollup(chain, briefs);
  const goal = chain.goal.trim().split("\n")[0];

  return (
    <div>
      <Row
        selected={selected}
        depth={depth}
        at={at}
        chip={chip}
        pinned={chain.pinned}
        title={chain.goal || chain.title}
        label={goal || chain.title}
        meta={[t(labelKey), t("agents.chainProgress", { done, total }), repoName].filter(Boolean).join(" · ")}
        glyph={spinner ? <ThinkingOrb size="sm" /> : <Icon size={13} className={color} />}
        leading={<Chevron expanded={expanded} onClick={onToggle} />}
        menuLabel={t("api.moreActions")}
        onClick={() => void useChainStore.getState().select(chain.id)}
        onMenu={onMenu}
      />
      {expanded &&
        [...briefs]
          .sort((a, b) => a.step_index - b.step_index)
          .map((brief, step) => {
            const task = brief.task_id ? (tasks.find((candidate) => candidate.id === brief.task_id) ?? null) : null;
            if (task) {
              return (
                <TaskRow
                  key={brief.id}
                  task={task}
                  depth={depth + 1}
                  at={step}
                  onMenu={(x, y) => onTaskMenu(x, y, task.id)}
                />
              );
            }
            // A step that has not run yet, or whose task was deleted. It stays on screen either way:
            // a plan drawn one row shorter than it is reads as a different plan.
            return (
              <Row
                key={brief.id}
                muted
                selected={false}
                depth={depth + 1}
                at={step}
                title={brief.instruction}
                label={brief.agent_name || t("settings.sddNewAgent")}
                meta={brief.task_id ? t("agents.stepTaskGone") : t("agents.stepGone")}
                glyph={<span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-text-muted)]/50" />}
                menuLabel={t("api.moreActions")}
                onClick={() => undefined}
                onMenu={onMenu}
              />
            );
          })}
    </div>
  );
}

function TaskRow({
  task,
  depth,
  at,
  chip,
  onMenu,
}: {
  task: AgentTask;
  depth: number;
  at: number;
  chip?: string;
  onMenu: (x: number, y: number) => void;
}) {
  const t = useT();
  const selected = useAgentsStore((s) => s.selectedId === task.id);
  const sending = useAgentsStore((s) => s.live[task.id]?.sending ?? false);
  const repoName = useRepoName(task.project_id);

  // The live flag wins over the stored status: the row is the truth about a run in this session,
  // and the persisted `running` is only ever a leftover.
  const status = sending ? "running" : task.status;
  const { icon: Icon, color } = AGENT_STATUS[status];

  const when = relativeTime(task.updated_at, {
    now: t("ai.justNow"),
    minutes: t("ai.minutesAgo"),
    hours: t("ai.hoursAgo"),
    days: t("ai.daysAgo"),
  });

  return (
    <Row
      selected={selected}
      depth={depth}
      at={at}
      chip={chip}
      pinned={task.pinned}
      title={task.goal || task.title}
      label={task.title || t("agents.newTask")}
      meta={[task.agent_name, repoName, when].filter(Boolean).join(" · ")}
      glyph={status === "running" ? <ThinkingOrb size="sm" /> : <Icon size={13} className={color} />}
      menuLabel={t("api.moreActions")}
      onClick={() => {
        // The middle column holds one thing: opening a task puts away whatever chain or template
        // was there.
        void useChainStore.getState().select(null);
        void useAgentsStore.getState().select(task.id);
      }}
      onMenu={onMenu}
    />
  );
}

function TemplateRow({
  templateId,
  at,
  name,
  description,
  steps,
  onMenu,
}: {
  templateId: string;
  at: number;
  name: string;
  description: string;
  steps: number;
  onMenu: (x: number, y: number) => void;
}) {
  const t = useT();
  const selected = useChainStore((s) => s.selectedTemplateId === templateId);
  return (
    <Row
      selected={selected}
      at={at}
      title={description || name}
      label={name}
      meta={t("agents.templateStepsN", { n: steps })}
      glyph={<Link2 size={13} className="text-[var(--cf-text-muted)]" />}
      menuLabel={t("api.moreActions")}
      onClick={() => useChainStore.getState().selectTemplate(templateId)}
      onMenu={onMenu}
    />
  );
}

/** The repository a row runs in, by name. Selected as a string rather than as the project list, so
 * a row does not re-render every time an unrelated repository is touched. */
function useRepoName(projectId: string): string {
  return useWorkspaceStore((s) => {
    const projects = s.activeWorkspaceId ? (s.projectsByWorkspace[s.activeWorkspaceId] ?? []) : [];
    return projects.find((project) => project.id === projectId)?.name ?? "";
  });
}

/** Built from the store rather than from a captured row, for the reason `RowMenu` exists: a turn
 * landing between the right-click and the click replaces the row, and a menu built from the old
 * copy would go on offering an action the row can no longer take. */
function menuItemsFor(
  menu: MenuTarget,
  ctx: {
    t: ReturnType<typeof useT>;
    projects: AgentProject[];
    chainOfTask: Map<string, string>;
    onContinueWith: (taskId: string) => void;
    onUseTemplate: (templateId: string) => void;
    onEditProject: (project: AgentProject) => void;
    onNewTask: (agentProjectId: string) => void;
    onNewChain: (agentProjectId: string) => void;
    startRename: (kind: Renaming["kind"], id: string) => void;
    startMove: (kind: "task" | "chain", id: string) => void;
  },
): MenuItem[] {
  const { t } = ctx;

  if (menu.kind === "task") {
    const store = useAgentsStore.getState;
    const task = store().tasks.find((candidate) => candidate.id === menu.id);
    if (!task) return [];
    const running = store().live[task.id]?.sending ?? false;
    const done = task.status === "done";
    // A step's task is filed wherever its chain is; moving it alone would take it out of the plan it
    // belongs to in every view but this one.
    const inChain = ctx.chainOfTask.has(task.id);

    return menuBlocks(
      [
        // Neither is offered for a step's task: both are answers to "where does this row live", and
        // the answer belongs to the chain. Pinning one step would put it in a section its own plan
        // is not in, which is the one thing this tree promises never to do.
        ...(inChain
          ? []
          : [
              {
                label: t(task.pinned ? "agents.unpin" : "agents.pin"),
                icon: task.pinned ? PinOff : Pin,
                onClick: () => void store().setTaskPinned(task.id, !task.pinned),
              },
              { label: t("agents.moveToProject"), icon: Folder, onClick: () => ctx.startMove("task", task.id) },
            ]),
      ],
      [
        { label: t("agents.rename"), icon: Pencil, onClick: () => ctx.startRename("task", task.id) },
        {
          label: t(done ? "agents.reopen" : "agents.markDone"),
          icon: done ? RotateCcw : CircleCheck,
          onClick: () => void store().setStatus(task.id, done ? "idle" : "done"),
        },
        // Only while there is something to stop — an engine is editing that working copy, and this
        // is the one action in the menu that cannot wait for the task to be opened first.
        ...(running ? [{ label: t("ai.stop"), icon: Square, onClick: () => void store().stop(task.id) }] : []),
      ],
      [
        // Nothing to hand on until it has answered once, and a chain seeded with an empty handoff
        // is the one shape that feature refuses to produce.
        ...(task.turns > 0
          ? [{ label: t("agents.continueWith"), icon: Link2, onClick: () => ctx.onContinueWith(task.id) }]
          : []),
        { label: t("agents.openChanges"), icon: GitCompare, onClick: () => openChanges(task.workspace_id, task.project_id) },
        {
          label: t("agents.copyGoal"),
          icon: Copy,
          onClick: () => void navigator.clipboard.writeText(task.goal).catch((e) => pushErrorToast(String(e))),
        },
      ],
      [
        {
          label: t("agents.deleteTask"),
          icon: Trash2,
          danger: true,
          onClick: () => {
            void confirmAction(t("agents.deleteConfirm", { name: task.title })).then((ok) => {
              if (ok) void store().remove(task.id);
            });
          },
        },
      ],
    );
  }

  if (menu.kind === "chain") {
    const store = useChainStore.getState;
    const chain = store().chains.find((candidate) => candidate.id === menu.id);
    if (!chain) return [];
    // Terminal chains live in this tree too, now that it is where finished work is found. Every
    // action below is guarded on the status rather than on the section it was drawn in.
    const terminal = chain.status === "done" || chain.status === "aborted";

    return menuBlocks(
      [
        {
          label: t(chain.pinned ? "agents.unpin" : "agents.pin"),
          icon: chain.pinned ? PinOff : Pin,
          onClick: () => void store().setPinned(chain.id, !chain.pinned),
        },
        { label: t("agents.moveToProject"), icon: Folder, onClick: () => ctx.startMove("chain", chain.id) },
      ],
      [
        // What "carry on" means depends on why it stopped: a paused chain picks up where it was, a
        // failed one has a step to run again first.
        ...(chain.status === "paused"
          ? [{ label: t("agents.resumeChain"), icon: Play, onClick: () => void store().resume(chain.id) }]
          : []),
        ...(chain.status === "failed"
          ? [{ label: t("agents.retryStep"), icon: Play, onClick: () => void store().retry(chain.id) }]
          : []),
        ...(terminal
          ? []
          : [{ label: t("agents.abortChain"), icon: Square, onClick: () => void store().abort(chain.id) }]),
      ],
      [
        {
          label: t("agents.deleteChain"),
          icon: Trash2,
          danger: true,
          onClick: () => {
            void confirmAction(t("agents.deleteChainConfirm", { name: chain.title })).then((ok) => {
              if (ok) void store().remove(chain.id);
            });
          },
        },
      ],
    );
  }

  if (menu.kind === "project") {
    const project = ctx.projects.find((candidate) => candidate.id === menu.id);
    if (!project) return [];
    return menuBlocks(
      [
        { label: t("agents.newTaskHere"), icon: Plus, onClick: () => ctx.onNewTask(project.id) },
        { label: t("agents.newChainHere"), icon: Link2, onClick: () => ctx.onNewChain(project.id) },
      ],
      [
        { label: t("agents.renameProject"), icon: Pencil, onClick: () => ctx.startRename("project", project.id) },
        { label: t("agents.editProject"), icon: Folder, onClick: () => ctx.onEditProject(project) },
      ],
      [
        {
          label: t("agents.deleteProject"),
          icon: Trash2,
          danger: true,
          onClick: () => {
            void confirmAction(t("agents.deleteProjectConfirm", { name: project.name })).then((ok) => {
              if (!ok) return;
              // The backend unfiles both tables inside the delete; these two calls only bring the
              // copies in memory back in line, and the chain half has to be told separately because
              // the task store may not reach into the chain store.
              void useAgentsStore
                .getState()
                .removeProject(project.id)
                .then(() => useChainStore.getState().forgetProject(project.id))
                .catch((e: unknown) => pushErrorToast(String(e)));
            });
          },
        },
      ],
    );
  }

  const template = useChainStore.getState().templates.find((candidate) => candidate.id === menu.id);
  if (!template) return [];
  return menuBlocks(
    [
      { label: t("agents.useTemplate"), icon: Play, onClick: () => ctx.onUseTemplate(template.id) },
      { label: t("agents.editTemplate"), icon: Pencil, onClick: () => ctx.onUseTemplate(template.id) },
      { label: t("agents.renameTemplate"), icon: Pencil, onClick: () => ctx.startRename("template", template.id) },
    ],
    [
      {
        label: t("agents.deleteTemplate"),
        icon: Trash2,
        danger: true,
        onClick: () => {
          void confirmAction(t("agents.deleteTemplateConfirm", { name: template.name })).then((ok) => {
            if (!ok) return;
            if (useChainStore.getState().selectedTemplateId === template.id) {
              useChainStore.getState().selectTemplate(null);
            }
            void useChainStore.getState().removeTemplate(template.id);
          });
        },
      },
    ],
  );
}

function openChanges(workspaceId: string, projectId: string) {
  void useWorkspaceStore
    .getState()
    .focusProject(workspaceId, projectId)
    .then(() => useUiStore.getState().setActiveView("changes"));
}
