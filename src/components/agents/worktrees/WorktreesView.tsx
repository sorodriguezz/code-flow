import { useEffect, useMemo, useState } from "react";
import { FolderGit2, Plus } from "lucide-react";
import { buttonClass } from "../../common/Button";
import { EmptyState } from "../../common/EmptyState";
import { ResizeHandle } from "../../common/ResizeHandle";
import { CARD } from "../../api/panelChrome";
import { WorktreeRail, type RailTarget } from "./WorktreeRail";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { WorktreeWorkspace } from "./WorktreeWorkspace";
import { WorktreeGrid } from "./WorktreeGrid";
import { useAgentsStore } from "../../../state/agentsStore";
import { useBenchStore } from "../../../state/benchStore";
import { useTerminalAgentStore } from "../../../state/terminalAgentStore";
import { useLayoutStore } from "../../../state/layoutStore";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { useActiveProjects, useWorkspaceStore } from "../../../state/workspaceStore";
import { useT } from "../../../state/languageStore";
import { agentsByRow, buildRepoBlocks, listedBlocks, type WorktreeRow } from "../../../lib/agents/worktreeRows";
import { samePath } from "../../../lib/agents/terminalTask";
import { raceIdOf } from "../../../lib/agents/race";

const RAIL_MIN = 240;
const RAIL_MAX = 520;

/**
 * The «Worktrees» layout of the agent console: the rail of working copies on the left, and on the
 * right either the one that is open or a grid of several at once.
 *
 * Shares the task list's column width (one setting for "how wide is the left rail here"), its
 * selection (a task row open here is the task open in the other layout) and the bench: the middle
 * column is the bench whenever the bench is up, in both layouts.
 */
export function WorktreesView({ onNewAgent, onHelp }: { onNewAgent: (projectId: string) => void; onHelp: () => void }) {
  const t = useT();
  const projects = useActiveProjects();
  const tasks = useAgentsStore((s) => s.tasks);
  const selectedTaskId = useAgentsStore((s) => s.selectedId);
  const selectedKey = useWorktreeViewStore((s) => s.selectedKey);
  const listings = useWorktreeViewStore((s) => s.listings);
  const display = useWorktreeViewStore((s) => s.display);
  const gridRace = useWorktreeViewStore((s) => s.gridRace);
  const benchOpen = useBenchStore((s) => s.open);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const width = useLayoutStore((s) => s.sizes.agentsListWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const repos = useMemo(
    () => projects.map((project) => ({ id: project.id, name: project.name, local_path: project.local_path, color: project.color })),
    [projects],
  );
  const agents = useTerminalAgentStore((s) => s.agents);
  /** «Nuevo espacio», open on a repository (`""` for the first one). */
  const [creating, setCreating] = useState<string | null>(null);
  /** A working copy just made, to open as soon as its row exists — the listing is read after it. */
  const [arriving, setArriving] = useState<{ path: string; sessionId: string | null } | null>(null);

  // The terminals' agents, read from the backend once and followed from then on.
  useEffect(() => {
    useTerminalAgentStore.getState().init();
  }, []);
  /** How many worktrees the tasks say exist — a task made with one of its own is a new listing. */
  const worktreeTasks = tasks.filter((task) => (task.worktree_path ?? "").trim()).length;

  // Listed when the view opens, when the repositories change and when a task gains or loses a
  // worktree — never on a timer: a worktree made by hand outside the app shows up on the next of those.
  useEffect(() => {
    void useWorktreeViewStore.getState().refreshListings(repos);
  }, [repos, worktreeTasks]);

  const blocks = useMemo(() => buildRepoBlocks(repos, listings, tasks), [repos, listings, tasks]);
  const allRows = useMemo(() => blocks.flatMap((block) => block.rows), [blocks]);
  // Every terminal agent under the row whose folder it is in — over every row, so a nested worktree
  // keeps its own agent even while its parent is the only one on the rail.
  const byRow = useMemo(() => agentsByRow(allRows, agents), [allRows, agents]);
  const names = useWorktreeViewStore((s) => s.names);
  const pinned = useWorktreeViewStore((s) => s.pinned);
  const showAll = useWorktreeViewStore((s) => s.showAll);
  /** What the rail lists: the tasks, not every folder git knows about — see `isListed`. */
  const listed = useMemo(
    () => (showAll ? blocks : listedBlocks(blocks, { names, pinned, byRow })),
    [showAll, blocks, names, pinned, byRow],
  );
  const listedRows = useMemo(() => listed.flatMap((block) => block.rows), [listed]);

  /** The open row: the selected task's when it has one here, the remembered plain row, or the first
   *  task on the rail — so the right side is never empty while there is work to show. */
  const current: WorktreeRow | null = useMemo(() => {
    const byTask = selectedTaskId ? allRows.find((row) => row.task?.id === selectedTaskId) : undefined;
    if (byTask) return byTask;
    const byKey = selectedKey ? listedRows.find((row) => row.key === selectedKey) : undefined;
    if (byKey) return byKey;
    return listedRows.find((row) => row.task) ?? listedRows[0] ?? null;
  }, [allRows, listedRows, selectedTaskId, selectedKey]);

  // The task open on the right is the task selected for every other surface too — which is also
  // what loads its transcript.
  useEffect(() => {
    if (current?.task && current.task.id !== useAgentsStore.getState().selectedId) {
      void useAgentsStore.getState().select(current.task.id);
    }
  }, [current]);

  // Unread marks: whatever lands while a row is open counts as seen.
  useEffect(() => {
    useWorktreeViewStore.getState().observe(tasks, display === "one" ? (current?.task?.id ?? null) : null);
  }, [tasks, current, display]);

  // The same for the agents in the open row's terminals — and they are the ones on screen, so a turn
  // that ends there does not also raise a notification about itself.
  const currentAgents = useMemo(() => (current ? (byRow.get(current.key) ?? []) : []), [byRow, current]);
  const openSessions = useMemo(
    () => (display === "one" ? currentAgents.map((agent) => agent.session_id) : []),
    [display, currentAgents],
  );
  useEffect(() => {
    const store = useTerminalAgentStore.getState();
    store.setVisible(openSessions);
    if (!document.hidden) store.ack(openSessions);
  }, [openSessions, agents]);

  // The grid mounts terminals too, and they replay what the bench last read — so it waits for a
  // fresh read, as the workspace's own terminal tabs do.
  const [gridFresh, setGridFresh] = useState(false);
  useEffect(() => {
    if (display !== "grid" || !workspaceId) {
      setGridFresh(false);
      return;
    }
    let alive = true;
    void useBenchStore
      .getState()
      .refresh(workspaceId)
      .catch(() => undefined)
      .finally(() => {
        if (alive) setGridFresh(true);
      });
    return () => {
      alive = false;
    };
  }, [display, workspaceId]);

  const select = (row: WorktreeRow, target?: RailTarget) => {
    const view = useWorktreeViewStore.getState();
    view.requestFocus(target ? { rowKey: row.key, target } : null);
    if (row.task) {
      view.selectKey(null);
      void useAgentsStore.getState().select(row.task.id);
    } else {
      view.selectKey(row.key);
      void useAgentsStore.getState().select(null);
    }
    if (view.display === "grid") view.setDisplay("one");
  };

  useEffect(() => {
    if (!arriving) return;
    const row = allRows.find((candidate) => samePath(candidate.path, arriving.path));
    if (!row) return;
    setArriving(null);
    select(row, arriving.sessionId ? { kind: "terminal", sessionId: arriving.sessionId } : undefined);
    // `select` is this render's; the arrival is what this effect answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arriving, allRows]);

  const gridRows = gridRace ? allRows.filter((row) => row.task && raceIdOf(row.task) === gridRace) : allRows.filter((row) => row.task);

  return (
    <>
      <WorktreeRail
        width={width}
        blocks={listed}
        byRow={byRow}
        selectedKey={current?.key ?? null}
        onSelect={select}
        onNewWorkspace={(projectId) => setCreating(projectId)}
        onHelp={onHelp}
      />
      <ResizeHandle
        axis="x"
        value={width}
        min={RAIL_MIN}
        max={RAIL_MAX}
        seamless
        onChange={(value) => setSize("agentsListWidth", value)}
        onCommit={(value) => commitSize("agentsListWidth", value)}
      />
      {!benchOpen && (
        <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${CARD}`}>
          {display === "grid" ? (
            gridFresh ? <WorktreeGrid rows={gridRows} raceId={gridRace} onOpen={select} /> : null
          ) : current ? (
            <WorktreeWorkspace key={current.key} row={current} rowAgents={currentAgents} onNewAgent={onNewAgent} />
          ) : (
            repos.length === 0 ? (
              <EmptyState icon={FolderGit2} title={t("wt.noRepos")} subtitle={t("wt.noReposHint")} />
            ) : (
              <EmptyState
                icon={FolderGit2}
                title={t("wt.noTasks")}
                subtitle={t("wt.noTasksHint")}
                action={
                  <button type="button" onClick={() => setCreating("")} className={buttonClass({ variant: "primary", size: "sm" })}>
                    <Plus size={12} />
                    {t("wt.newAgent")}
                  </button>
                }
              />
            )
          )}
        </div>
      )}
      {creating !== null && (
        <NewWorkspaceDialog
          repos={repos}
          initialProjectId={creating || (current?.projectId ?? "")}
          onClose={() => setCreating(null)}
          onChat={(projectId: string) => {
            setCreating(null);
            onNewAgent(projectId);
          }}
          onCreated={(path, sessionId) => setArriving({ path, sessionId })}
        />
      )}
    </>
  );
}
