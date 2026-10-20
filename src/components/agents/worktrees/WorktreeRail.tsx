import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Flag,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  LayoutGrid,
  ListFilter,
  MessageCircleQuestion,
  Pin,
  PinOff,
  Plus,
  Search,
  TerminalSquare,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { Tooltip } from "../../common/Tooltip";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { explorerClass, explorerHeadClass, fieldClass, sectionLabelClass } from "../../common/recipes";
import { LayoutSwitch } from "./LayoutSwitch";
import { TallyText, useRowLive, useRowTally } from "./rowStatus";
import { relativeTime } from "../../api/settingsChrome";
import { agentName } from "../agentName";
import { useAgentsStore } from "../../../state/agentsStore";
import { useBenchStore } from "../../../state/benchStore";
import { useTerminalAgentStore } from "../../../state/terminalAgentStore";
import { useUiStore } from "../../../state/uiStore";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { pushErrorToast } from "../../../state/toastStore";
import { useT } from "../../../state/languageStore";
import { revealInFileManager } from "../../../lib/tauri/commands";
import { openPathAsProject } from "../../../lib/openAsProject";
import { raceIdOf } from "../../../lib/agents/race";
import { pathKey } from "../../../lib/agents/terminalTask";
import {
  LANES,
  cardState,
  folderName,
  laneOf,
  railSections,
  taskLine,
  terminalLine,
  type AgentLine,
  type LaneId,
  type LineState,
  type RailSection,
  type RepoBlock,
  type WorktreeRow,
} from "../../../lib/agents/worktreeRows";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { TerminalAgent } from "../../../types/domain";

/** Where a click on a card goes: the card, or one of its agents. */
export type RailTarget = AgentLine["target"] | null;

/** The lanes as the rail draws them: Orca's four, in its colours' spirit. */
export const LANE_LOOK: Record<LaneId, { icon: LucideIcon; color: string; labelKey: TranslationKey }> = {
  todo: {
    icon: Circle,
    color: "text-[var(--cf-text-muted)]",
    labelKey: "wt.lane.todo",
  },
  progress: {
    icon: CircleDashed,
    color: "text-[var(--cf-warning)]",
    labelKey: "wt.lane.progress",
  },
  review: {
    icon: GitPullRequest,
    color: "text-[var(--cf-accent)]",
    labelKey: "wt.lane.review",
  },
  done: {
    icon: CircleCheck,
    color: "text-[var(--cf-success)]",
    labelKey: "wt.lane.done",
  },
};

export const LINE_LABEL: Record<LineState, TranslationKey> = {
  working: "wt.line.working",
  blocked: "wt.line.blocked",
  error: "wt.line.error",
  done: "wt.line.done",
  idle: "wt.line.idle",
};

export const LINE_COLOR: Record<LineState, string> = {
  working: "text-[var(--cf-accent)]",
  blocked: "text-[var(--cf-warning)]",
  error: "text-[var(--cf-danger)]",
  done: "text-[var(--cf-success)]",
  idle: "text-[var(--cf-text-muted)]",
};

/** Lines a card shows before it says "and N more". */
const MAX_LINES = 3;
/** The drag payload: the folder of the card being moved. */
const DRAG_TYPE = "application/x-codeflow-worktree";

/** Re-renders every half minute, so ages ("hace 3 min") keep up without a timer per card. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * The left rail of the «Worktrees» layout, drawn the way Orca draws its workspaces: not one list per
 * repository but sections by **status** — pinned on top, then «Por hacer», «En curso», «En revisión»,
 * «Hecho» — that the user files each working copy under (from the card's menu, or by dragging it
 * onto another section). Grouping by repository is one switch away.
 *
 * A card is a working copy and **everyone working in it**: every agent CLI running in one of its
 * terminals — read live from the terminal by the backend, so a `claude` started by hand shows up
 * too — and its chat task when it has one, the local model included. Each line says what the agent
 * was asked, what it answered and how long ago, behind the glyph every surface shares: the orb while
 * it works, an amber question while it waits on you, green when it finished, red when it failed.
 */
export function WorktreeRail({
  width,
  blocks,
  byRow,
  selectedKey,
  onSelect,
  onNewWorkspace,
  onHelp,
}: {
  width: number;
  /** The tasks on the rail (`listedBlocks`), or every working copy when the user asked for all. */
  blocks: RepoBlock[];
  /** Every terminal agent, filed under its row (`agentsByRow`) by the view. */
  byRow: ReadonlyMap<string, TerminalAgent[]>;
  selectedKey: string | null;
  onSelect: (row: WorktreeRow, target?: RailTarget) => void;
  /** Opens «Nuevo espacio» — on a repository, or `""` for the first one. */
  onNewWorkspace: (projectId: string) => void;
  onHelp: () => void;
}) {
  const t = useT();
  const now = useClock();
  const [query, setQuery] = useState("");
  const [optionsAt, setOptionsAt] = useState<{ x: number; y: number } | null>(null);
  const display = useWorktreeViewStore((s) => s.display);
  const gridRace = useWorktreeViewStore((s) => s.gridRace);
  const setDisplay = useWorktreeViewStore((s) => s.setDisplay);
  const grouping = useWorktreeViewStore((s) => s.grouping);
  const lanes = useWorktreeViewStore((s) => s.lanes);
  const pinned = useWorktreeViewStore((s) => s.pinned);
  const folded = useWorktreeViewStore((s) => s.folded);
  const repoFilter = useWorktreeViewStore((s) => s.repoFilter);
  const names = useWorktreeViewStore((s) => s.names);
  const showAll = useWorktreeViewStore((s) => s.showAll);
  const benchOpen = useBenchStore((s) => s.open);
  const rosterOpen = useAgentsStore((s) => s.rosterOpen);
  const toggleRoster = useAgentsStore((s) => s.toggleRoster);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const toggleBench = () => {
    const bench = useBenchStore.getState();
    if (bench.open) bench.hide();
    else if (workspaceId) void bench.show(workspaceId).catch((e: unknown) => pushErrorToast(String(e)));
  };

  /** The blocks with only the rows the search and the repository filter keep. */
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const hit = (row: WorktreeRow, repoName: string) =>
      needle === "" ||
      [
        row.branch,
        folderName(row.path),
        names[pathKey(row.path)] ?? "",
        row.task?.title ?? "",
        row.task?.agent_name ?? "",
        repoName,
        ...(byRow.get(row.key) ?? []).flatMap((agent) => [agent.agent ?? "", agent.prompt, agent.summary]),
      ].some((text) => text.toLowerCase().includes(needle));
    return blocks
      .filter((block) => repoFilter === "" || block.repo.id === repoFilter)
      .map((block) => {
        const rows = block.rows.filter((row) => hit(row, block.repo.name));
        return {
          ...block,
          rows,
          items: rows.map((row) => ({ kind: "row" as const, row })),
        };
      });
  }, [blocks, query, repoFilter, byRow, names]);

  const sections = useMemo(() => railSections(shown, { grouping, lanes, pinned }), [shown, grouping, lanes, pinned]);
  const repoOf = useMemo(() => new Map(blocks.map((block) => [block.repo.id, block.repo])), [blocks]);
  const total = shown.reduce((n, block) => n + block.rows.length, 0);
  const gridAll = display === "grid" && gridRace === null;
  const firstRepo = blocks[0]?.repo.id ?? "";

  const options: MenuItem[] = [
    {
      label: t("wt.groupBy"),
      icon: LayoutGrid,
      onClick: () => undefined,
      children: [
        {
          label: t("wt.groupStatus"),
          icon: grouping === "status" ? Check : undefined,
          onClick: () => useWorktreeViewStore.getState().setGrouping("status"),
        },
        {
          label: t("wt.groupProject"),
          icon: grouping === "project" ? Check : undefined,
          onClick: () => useWorktreeViewStore.getState().setGrouping("project"),
        },
      ],
    },
    ...(blocks.length > 1
      ? [
          {
            label: t("wt.showRepos"),
            icon: FolderGit2,
            onClick: () => undefined,
            children: [{ id: "", name: t("wt.allRepos") }, ...blocks.map((block) => block.repo)].map((repo) => ({
              label: repo.name,
              icon: repoFilter === repo.id ? Check : undefined,
              onClick: () => useWorktreeViewStore.getState().setRepoFilter(repo.id),
            })),
          },
        ]
      : []),
    {
      label: t("wt.showAll"),
      icon: showAll ? Check : FolderOpen,
      separated: true,
      onClick: () => useWorktreeViewStore.getState().toggleShowAll(),
    },
  ];

  return (
    <div style={{ width }} className={`${explorerClass} h-full overflow-hidden`}>
      <LayoutSwitch />
      <div className={explorerHeadClass}>
        <button
          type="button"
          disabled={firstRepo === ""}
          onClick={() => onNewWorkspace(repoFilter)}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          <Plus size={13} />
          {t("wt.newAgent")}
        </button>
        <span className="min-w-1 flex-1" />
        <Tooltip label={t("wt.gridAll")}>
          <button
            type="button"
            onClick={() => setDisplay(gridAll ? "one" : "grid", null)}
            aria-pressed={gridAll}
            aria-label={t("wt.gridAll")}
            className={iconButtonClass({ active: gridAll })}
          >
            <LayoutGrid size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t("bench.title")}>
          <button
            type="button"
            onClick={toggleBench}
            aria-pressed={benchOpen}
            aria-label={t("bench.title")}
            className={iconButtonClass({ active: benchOpen })}
          >
            <TerminalSquare size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t("agents.manageAgents")}>
          <button
            type="button"
            onClick={toggleRoster}
            aria-pressed={rosterOpen}
            aria-label={t("agents.manageAgents")}
            className={iconButtonClass({ active: rosterOpen })}
          >
            <Users size={15} />
          </button>
        </Tooltip>
        <Tooltip label={t("agents.help")}>
          <button type="button" onClick={onHelp} aria-label={t("agents.help")} className={iconButtonClass()}>
            <CircleHelp size={15} />
          </button>
        </Tooltip>
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2.5 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("wt.search")}
            aria-label={t("wt.search")}
            className={fieldClass({ size: "sm", className: "w-full pl-7" })}
          />
        </div>
        <Tooltip label={t("wt.viewOptions")}>
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setOptionsAt({ x: rect.left, y: rect.bottom + 2 });
            }}
            aria-label={t("wt.viewOptions")}
            className={iconButtonClass({
              active: repoFilter !== "" || grouping !== "status",
            })}
          >
            <ListFilter size={14} />
          </button>
        </Tooltip>
      </div>

      <p className={`${sectionLabelClass} px-3.5`}>
        <span className="min-w-0 flex-1">{t("wt.spaces")}</span>
        <span className="tabular-nums tracking-normal">{total}</span>
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sections.map((section) => (
          <Section
            key={section.id}
            section={section}
            label={sectionLabel(section, t, repoOf)}
            folded={folded.includes(section.id)}
            searching={query.trim() !== ""}
          >
            {section.rows.map((row) => (
              <RailCard
                key={row.key}
                row={row}
                repo={repoOf.get(row.projectId) ?? null}
                selected={display === "one" && row.key === selectedKey}
                agents={byRow.get(row.key) ?? []}
                now={now}
                pinned={pinned.includes(pathKey(row.path))}
                lane={laneOf(row, lanes)}
                onSelect={onSelect}
              />
            ))}
          </Section>
        ))}
        {total === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
            {query.trim() ? t("wt.noMatch") : t("wt.noTasks")}
          </p>
        )}
      </div>

      {optionsAt && <ContextMenu x={optionsAt.x} y={optionsAt.y} items={options} onClose={() => setOptionsAt(null)} />}
    </div>
  );
}

function sectionLabel(section: RailSection, t: ReturnType<typeof useT>, repos: Map<string, { name: string }>): string {
  if (section.id === "pinned") return t("wt.pinned");
  if (section.lane) return t(LANE_LOOK[section.lane].labelKey);
  return repos.get(section.projectId ?? "")?.name ?? "";
}

/** One section: a header with its count that folds it, and — on a status section — a place to drop
 *  a card, which files it there. */
function Section({
  section,
  label,
  folded,
  searching,
  children,
}: {
  section: RailSection;
  label: string;
  folded: boolean;
  /** While searching every section is open: a match must not hide behind a fold. */
  searching: boolean;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const look = section.lane ? LANE_LOOK[section.lane] : null;
  const Icon: LucideIcon = section.id === "pinned" ? Pin : (look?.icon ?? FolderGit2);
  const open = searching || !folded;
  const droppable = section.lane !== null;

  const onDragOver = (event: DragEvent) => {
    if (!droppable || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  const onDrop = (event: DragEvent) => {
    setOver(false);
    const path = event.dataTransfer.getData(DRAG_TYPE);
    if (!droppable || !path || !section.lane) return;
    event.preventDefault();
    useWorktreeViewStore.getState().setLane(path, section.lane);
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`mb-1 rounded-lg transition-colors ${over ? "bg-[var(--cf-accent-soft)]" : ""}`}
    >
      <button
        type="button"
        onClick={() => useWorktreeViewStore.getState().toggleFold(section.id)}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] font-semibold text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-[var(--cf-text-faint)] transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Icon
          size={13}
          className={`shrink-0 ${section.id === "pinned" ? "text-[var(--cf-text-muted)]" : (look?.color ?? "text-[var(--cf-text-muted)]")}`}
        />
        <span className="min-w-0 truncate">{label}</span>
        <span
          className={`shrink-0 rounded-full px-1.5 text-[10.5px] font-medium tabular-nums leading-[16px] ${
            section.rows.length > 0 ? "bg-[var(--cf-hover)] text-[var(--cf-text-muted)]" : "text-[var(--cf-text-faint)]"
          }`}
        >
          {section.rows.length}
        </span>
      </button>
      {open && <div className="space-y-0.5 pb-1">{children}</div>}
    </div>
  );
}

/**
 * One working copy: the state of whoever is in it, its name — bold while something finished that
 * the user has not looked at — the repository and branch, and a line per agent.
 */
function RailCard({
  row,
  repo,
  selected,
  agents,
  now,
  pinned,
  lane,
  onSelect,
}: {
  row: WorktreeRow;
  repo: { id: string; name: string; color?: string } | null;
  selected: boolean;
  agents: TerminalAgent[];
  now: number;
  pinned: boolean;
  lane: LaneId;
  onSelect: (row: WorktreeRow, target?: RailTarget) => void;
}) {
  const t = useT();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const { state, sending, unread: taskUnread } = useRowLive(row, selected);
  // A main checkout nobody works in has nothing worth counting, and reading its diff on every open
  // of the view would be the cost of a number nobody asked about.
  const counted = useRowTally(row, sending, !(row.isMain && !row.task));
  const seenAt = useTerminalAgentStore((s) => s.seenAt);
  const name = useWorktreeViewStore((s) => s.names[pathKey(row.path)] ?? "");
  const task = row.task;
  const repoName = repo?.name ?? "";

  const lines = useMemo(() => {
    const out: AgentLine[] = [];
    if (task) out.push(taskLine(task, state, taskUnread));
    for (const agent of agents) {
      const line = terminalLine(agent, seenAt[agent.session_id]);
      if (line) out.push(line);
    }
    return out;
  }, [task, state, taskUnread, agents, seenAt]);
  const overall = cardState(lines);
  const unread = !selected && lines.some((line) => line.unread);
  // A task row is its task; a space «Nuevo agente» made is its name — and until it has one, what its
  // agent was first asked; a bare working copy is where it is.
  const asked = agents.find((agent) => agent.prompt)?.prompt ?? "";
  const title = task
    ? task.title || agentName(task.agent_name, task.provider, t)
    : name || asked || (row.isMain ? repoName : folderName(row.path));
  const raceId = task ? raceIdOf(task) : "";

  const openAsRepo = () => {
    if (row.isMain) {
      const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      if (workspaceId) {
        void useWorkspaceStore
          .getState()
          .focusProject(workspaceId, row.projectId)
          .then(() => useUiStore.getState().setActiveView("changes"));
      }
      return;
    }
    void openPathAsProject(row.path, null, row.branch || undefined).then(() => useUiStore.getState().setActiveView("changes"));
  };

  const menu: MenuItem[] = [
    {
      label: pinned ? t("wt.unpin") : t("wt.pin"),
      icon: pinned ? PinOff : Pin,
      onClick: () => useWorktreeViewStore.getState().togglePin(row.path),
    },
    {
      label: t("wt.moveTo"),
      icon: LANE_LOOK[lane].icon,
      onClick: () => undefined,
      children: LANES.map((id) => ({
        label: t(LANE_LOOK[id].labelKey),
        icon: id === lane ? Check : LANE_LOOK[id].icon,
        onClick: () => useWorktreeViewStore.getState().setLane(row.path, id),
      })),
    },
    ...(raceId
      ? [
          {
            label: t("wt.compare"),
            icon: Flag,
            onClick: () => useWorktreeViewStore.getState().setDisplay("grid", raceId),
          },
        ]
      : []),
    // Off the rail: the folder and its branch stay, the space just stops being listed as a task.
    ...(!task && (name || pinned)
      ? [
          {
            label: t("wt.forget"),
            icon: X,
            onClick: () => {
              const view = useWorktreeViewStore.getState();
              view.setName(row.path, "");
              if (pinned) view.togglePin(row.path);
            },
          },
        ]
      : []),
    {
      label: row.isMain ? t("wt.openRepo") : t("agents.openWorktreeAsRepo"),
      icon: FolderGit2,
      separated: true,
      onClick: openAsRepo,
    },
    {
      label: t("agents.revealWorktree"),
      icon: FolderOpen,
      disabled: row.path === "",
      onClick: () => void revealInFileManager(row.path),
    },
  ];

  const ago = (at: number) =>
    at > 0
      ? relativeTime(new Date(Math.min(at, now)).toISOString(), {
          now: t("ai.justNow"),
          minutes: t("ai.minutesAgo"),
          hours: t("ai.hoursAgo"),
          days: t("ai.daysAgo"),
        })
      : "";

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        draggable={row.path !== ""}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, row.path);
          event.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => onSelect(row)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(row);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuAt({ x: event.clientX, y: event.clientY });
        }}
        title={row.path}
        className={`block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:shadow-[inset_0_0_0_1px_var(--cf-accent)] ${
          selected ? "bg-[var(--cf-accent-soft)] shadow-[inset_0_0_0_1px_var(--cf-border)]" : "hover:bg-[var(--cf-hover)]"
        }`}
      >
        <span className="flex items-center gap-2">
          <LineGlyph state={overall} />
          <span
            className={`min-w-0 flex-1 truncate text-[13px] ${unread ? "font-bold text-[var(--cf-text)]" : "font-semibold text-[var(--cf-text)]"}`}
          >
            {title}
          </span>
          {row.isMain && (
            <span className="shrink-0 rounded border border-[var(--cf-border)] px-1 text-[10px] leading-[15px] text-[var(--cf-text-muted)]">
              {t("wt.primary")}
            </span>
          )}
          {raceId && <Flag size={11} className="shrink-0 text-[var(--cf-text-faint)]" aria-label={t("wt.tabRace")} />}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-[18px]">
          <span className="flex max-w-[45%] shrink-0 items-center gap-1 rounded border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1 text-[10.5px] leading-[16px] text-[var(--cf-text-muted)]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-[2px]" style={{ background: repo?.color || "var(--cf-text-faint)" }} />
            <span className="truncate">{repoName}</span>
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-faint)]">{row.branch || "—"}</span>
          <TallyText value={counted} />
        </span>
        {lines.slice(0, MAX_LINES).map((line) => (
          <span
            key={line.key}
            role="button"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(row, line.target);
            }}
            className="mt-1 flex min-w-0 items-center gap-1.5 rounded pl-[18px] text-[11.5px] hover:bg-[var(--cf-hover)]"
          >
            <LineGlyph state={line.state} size={8} />
            {line.provider ? (
              <ProviderGlyph providerId={line.provider} size={12} />
            ) : (
              <TerminalSquare size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            )}
            <span
              className={`min-w-0 flex-1 truncate ${line.unread ? "font-semibold text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}
            >
              {line.prompt || line.detail ? (
                <>
                  {line.prompt}
                  {line.prompt && line.detail ? <span className="text-[var(--cf-text-faint)]"> — </span> : null}
                  {line.detail && <span className="text-[var(--cf-text-faint)]">{line.detail}</span>}
                </>
              ) : (
                t(LINE_LABEL[line.state])
              )}
            </span>
            <span
              className={`shrink-0 tabular-nums ${line.state === "blocked" ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-faint)]"}`}
            >
              {line.state === "working" || line.state === "blocked" ? t(LINE_LABEL[line.state]) : ago(line.at)}
            </span>
          </span>
        ))}
        {lines.length > MAX_LINES && (
          <span className="mt-1 block pl-[18px] text-[11px] text-[var(--cf-text-faint)]">
            {t("wt.moreAgents", { n: lines.length - MAX_LINES })}
          </span>
        )}
      </div>
      {/* Beside the card, not in it: React events bubble through a portal to the tree that rendered
        it, and a menu inside the card would select the card with every item clicked. */}
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} items={menu} onClose={() => setMenuAt(null)} />}
    </>
  );
}

/**
 * The glyph every surface uses for what an agent is doing: the orb while it works, an amber
 * question while it waits on the user, a red dot when it failed, green when it finished, a grey dot
 * at rest — and a hollow ring with nobody there at all.
 */
export function LineGlyph({ state, size = 10 }: { state: LineState | null; size?: number }) {
  const box = { width: size, height: size };
  if (state === "working") {
    return (
      <span className="flex shrink-0 items-center justify-center" style={box}>
        <ThinkingOrb size="sm" />
      </span>
    );
  }
  if (state === "blocked") {
    return <MessageCircleQuestion size={size + 3} className="shrink-0 text-[var(--cf-warning)]" />;
  }
  const fill: Record<Exclude<LineState, "working" | "blocked">, string> = {
    error: "bg-[var(--cf-danger)]",
    done: "bg-[var(--cf-success)]",
    idle: "bg-[var(--cf-text-faint)]",
  };
  return state ? (
    <span className={`shrink-0 rounded-full ${fill[state]}`} style={box} />
  ) : (
    <span className="shrink-0 rounded-full border-[1.5px] border-[var(--cf-text-faint)]" style={box} />
  );
}
