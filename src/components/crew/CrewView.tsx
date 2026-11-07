/**
 * «Agentes»: the workspace's agents, teams and work, in five spaces over one dock.
 *
 * - **Tablero**: the local backlog — stories and tasks you hand to an agent or a team.
 * - **Equipos**: who answers to whom, drawn and edited as an org chart, and how each team works.
 * - **Agentes**: the roster and the template library, and the wizard that makes an agent.
 * - **En vivo**: the runs as they happen — the work graph growing, the channel, each member's chat,
 *   the advisor, the decisions, and what it all costs.
 * - **Taller**: worktrees, the terminal bench, races and hybrid runs.
 *
 * It is the same in the main window and in an island: every run moves in the backend
 * (`src-tauri/src/runner`) and every window only watches and sends orders.
 */
import { useEffect, useMemo, useState } from "react";
import { Inbox } from "./live/Inbox";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, Bot, Hand, Kanban, Network, SquareTerminal, WandSparkles } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { useTeamStore } from "../../state/teamStore";
import { useBenchStore } from "../../state/benchStore";
import { useBacklogStore } from "../../state/backlogStore";
import { useLibraryStore } from "../../state/libraryStore";
import { useTicketStore } from "../../state/ticketStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { EmptyState } from "../common/EmptyState";
import { recoveryNeedsUser, runIsLive } from "../../types/team";
import { TerminalBench } from "../agents/TerminalBench";
import { DragLayer } from "./kit/drag";
import { CrewHost, Seg, SOFT } from "./kit/ui";
import { Dock } from "./Dock";
import { LaunchDialog } from "./LaunchDialog";
import { ChainEditorPane, ChainPane, RacePane, StoryPane, TaskPane } from "./Panes";
import { DeciderDialog, GovernorDialog } from "./Settings";
import { BoardSpace } from "./board/BoardSpace";
import { CardDrawer } from "./board/CardDrawer";
import { TeamsSpace } from "./teams/TeamsSpace";
import { TeamChatPane } from "./teams/TeamChatPane";
import { TeamTemplatesDialog } from "./teams/TeamTemplates";
import { RosterSpace } from "./roster/RosterSpace";
import { AgentWizard } from "./roster/AgentWizard";
import { LiveSpace } from "./live/LiveSpace";
import { MemberChat } from "./live/MemberChat";
import { WORKSHOP_BAR, WorkshopSpace } from "./workshop/WorkshopSpace";
import { useCrewStore, useL, type Space } from "./state";

/** The spaces about who works — drawn apart from the ones about the work. */
const CAST: readonly Space[] = ["equipos", "agentes"];

export function CrewView() {
  const l = useL();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeView = useUiStore((s) => s.activeView);
  const space = useCrewStore((s) => s.space);
  const overlay = useCrewStore((s) => s.overlay);
  const setSpace = useCrewStore((s) => s.setSpace);
  const open = useCrewStore((s) => s.open);
  const runs = useTeamStore((s) => s.runs);
  const [inbox, setInbox] = useState(false);
  const states = useTeamStore((s) => s.states);
  const chains = useChainStore((s) => s.chains);
  const tasks = useAgentsStore((s) => s.tasks);
  const live = useAgentsStore((s) => s.live);
  const workshopTab = useCrewStore((s) => s.workshopTab);
  const benchOpen = useBenchStore((s) => s.open);
  /** The bench is a live xterm per pane: once mounted it stays, and leaving is a class. */
  const [benchMounted, setBenchMounted] = useState(false);
  const benchShown = space === "taller" && workshopTab === "bench";

  useEffect(() => {
    if (benchShown || benchOpen) setBenchMounted(true);
  }, [benchShown, benchOpen]);

  // Something opened the bench (a worktree's terminal button, a team member that runs in a
  // terminal): bring it into view. Leaving it closes it, so the two never disagree.
  useEffect(() => {
    if (!benchOpen) return;
    const crew = useCrewStore.getState();
    if (crew.space !== "taller") crew.setSpace("taller");
    if (crew.workshopTab !== "bench") crew.set({ workshopTab: "bench" });
  }, [benchOpen]);
  useEffect(() => {
    if (!benchShown && useBenchStore.getState().open) useBenchStore.getState().hide();
  }, [benchShown]);

  useEffect(() => {
    void useAgentsStore.getState().setWorkspace(workspaceId);
    void useChainStore.getState().setWorkspace(workspaceId);
    void useTeamStore.getState().load(workspaceId);
    void useBacklogStore.getState().load(workspaceId);
    if (!useLibraryStore.getState().loaded) void useLibraryStore.getState().load();
    if (!useTicketStore.getState().loaded) void useTicketStore.getState().loadCache();
    if (workspaceId) void useBenchStore.getState().refresh(workspaceId);
  }, [workspaceId]);

  // A live run's state is fetched once it is listed, so the views can draw it.
  useEffect(() => {
    for (const run of runs) if (runIsLive(run) && !states[run.id]) void useTeamStore.getState().refresh(run.id);
  }, [runs, states]);

  // The board's columns follow the work linked to each card.
  useEffect(() => {
    const index = {
      tasks: new Map(tasks.map((t) => [t.id, t])),
      chains: new Map(chains.map((c) => [c.id, c])),
      runs: new Map(runs.map((r) => [r.id, r])),
      sending: new Set(Object.entries(live).filter(([, v]) => v.sending).map(([id]) => id)),
    };
    useBacklogStore.getState().syncDerived(index);
  }, [tasks, chains, runs, live]);

  // ⌘K anywhere in the view: hand out a task.
  useEffect(() => {
    if (activeView !== "agents") return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "k" && key !== "n") return;
      if (useCrewStore.getState().overlay || useUiStore.getState().settingsOpen) return;
      e.preventDefault();
      open({ kind: "launch" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeView, open]);

  const liveCount = runs.filter(runIsLive).length;
  const needsYou = useMemo(() => {
    let n = 0;
    for (const run of runs) {
      if (run.status === "gated") n++;
      const state = states[run.id];
      if (state) n += state.messages.filter((m) => m.kind === "question" && m.to_id === "user" && !m.answered_at).length;
      if (runIsLive(run)) n += Number(recoveryNeedsUser(state).length > 0);
    }
    n += chains.filter((c) => c.status === "gated").length;
    return n;
  }, [runs, states, chains]);

  if (!workspaceId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]">
        <EmptyState icon={Bot} title={l("Abre un workspace", "Open a workspace")} subtitle={l("Los agentes, equipos y el tablero son de cada workspace.", "Agents, teams and the board belong to a workspace.")} />
      </div>
    );
  }

  const spaces: { value: Space; label: string; icon: typeof Kanban; badge?: React.ReactNode; title: string }[] = [
    { value: "tablero", label: l("Tablero", "Board"), icon: Kanban, title: l("Las tareas e historias por columna. Arrastra un agente o un equipo a una tarjeta para que la trabaje.", "Tasks and stories by column. Drag an agent or a team onto a card to have it worked on.") },
    { value: "equipos", label: l("Equipos", "Teams"), icon: Network, title: l("Arma equipos: quién lidera, quién reporta a quién y cómo trabajan (aprobaciones, presupuesto, integración).", "Build teams: who leads, who reports to whom and how they work (approvals, budget, merging).") },
    { value: "agentes", label: l("Agentes", "Agents"), icon: Bot, title: l("Tus agentes: modelo, rol, instrucciones y permisos. Se crean desde una plantilla o desde cero.", "Your agents: model, role, instructions and permissions. Made from a template or from scratch.") },
    {
      value: "en-vivo",
      label: l("En vivo", "Live"),
      icon: Activity,
      title: l("Lo que se está ejecutando ahora: el canal del equipo, cada miembro trabajando y lo que espera tu respuesta.", "What is running now: the team's channel, each member at work and what waits for your answer."),
      badge: liveCount ? <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-[var(--cf-accent)] px-1 text-[10.5px] font-semibold text-[var(--cf-on-accent)]">{liveCount}</span> : undefined,
    },
    { value: "taller", label: l("Taller", "Workshop"), icon: SquareTerminal, title: l("Las terminales de los agentes que trabajan en modo terminal: míralos trabajar o escríbeles.", "The terminals of agents that work in terminal mode: watch them work or type to them.") },
  ];

  return (
    <CrewHost.Provider value={host}>
    <div ref={setHost} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--cf-surface)]">
      <div className="relative flex shrink-0 items-center gap-3 border-b border-[var(--cf-border)] px-3.5 py-2.5">
        {/* The work on the left; who does it — teams and agents — on the right. */}
        <Seg
          value={space}
          onChange={(next) => {
            if (next === "en-vivo") void useTeamStore.getState().select(null);
            setSpace(next);
          }}
          options={spaces.filter((o) => !CAST.includes(o.value))}
          className="min-w-0 shrink"
        />
        <span className="flex-1" />
        <AnimatePresence>
          {needsYou > 0 && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              type="button"
              data-inbox-toggle
              aria-expanded={inbox}
              onClick={() => setInbox((v) => !v)}
              title={l("Lo que espera tu respuesta, de todas las corridas", "What waits on your answer, from every run")}
              className="cf-crew-waiting flex h-[28px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_15%,var(--cf-surface))] px-3 text-[12px] font-semibold text-[var(--cf-warning)]"
              style={{ ["--cf-crew-c" as string]: "var(--cf-warning)" }}
            >
              <Hand className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{l(`Te necesitan ${needsYou}`, `${needsYou} need you`)}</span>
              <span className="sm:hidden">{needsYou}</span>
            </motion.button>
          )}
        </AnimatePresence>
        <AnimatePresence>{inbox && <Inbox onClose={() => setInbox(false)} />}</AnimatePresence>
        <span data-tour="agents-tree-actions" className="flex shrink-0 items-center gap-1.5">
          <Seg
            value={space}
            onChange={(next) => {
              // Coming into Teams starts on the list; a team opens when you pick it.
              if (next === "equipos" && space !== "equipos") useCrewStore.setState({ selectedTeamId: null, selectedMemberId: null });
              setSpace(next);
            }}
            options={spaces.filter((o) => CAST.includes(o.value))}
            className="min-w-0 shrink-0"
          />
          {/* Small on purpose: ⌘K is the way in, this is where it is found. */}
          <button type="button" onClick={() => open({ kind: "launch" })} title={l("Dale una tarea a un agente o equipo (⌘K)", "Hand a task to an agent or team (⌘K)")} aria-label={l("Dale una tarea", "Hand out a task")} className={iconButtonClass({ size: "sm" })}>
            <WandSparkles className="h-4 w-4" />
          </button>
        </span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden" data-tour="agents-tree">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={space} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SOFT} className="absolute inset-0 flex min-h-0 flex-col">
            {space === "tablero" && <BoardSpace />}
            {space === "equipos" && <TeamsSpace />}
            {space === "agentes" && <RosterSpace />}
            {space === "en-vivo" && <LiveSpace />}
            {space === "taller" && <WorkshopSpace benchMounted={benchMounted} />}
          </motion.div>
        </AnimatePresence>
        {benchMounted && (
          <div className={benchShown ? "absolute inset-x-0 bottom-0 flex min-h-0 flex-col" : "hidden"} style={{ top: WORKSHOP_BAR }}>
            <TerminalBench />
          </div>
        )}
      </div>

      <Dock />
      <DragLayer />

      {overlay?.kind === "launch" && <LaunchDialog goal={overlay.goal} assignee={overlay.assignee} cardId={overlay.cardId} projectId={overlay.projectId} attachments={overlay.attachments} />}
      {overlay?.kind === "wizard" && <AgentWizard templateId={overlay.templateId} agentId={overlay.agentId} />}
      {overlay?.kind === "card" && <CardDrawer cardId={overlay.id} />}
      {overlay?.kind === "chat" && <MemberChat key={`${overlay.runId}:${overlay.memberId}:${overlay.taskId ?? ""}`} runId={overlay.runId} memberId={overlay.memberId} taskId={overlay.taskId} />}
      {overlay?.kind === "task" && <TaskPane taskId={overlay.id} />}
      {overlay?.kind === "teamChat" && <TeamChatPane key={overlay.id} chatId={overlay.id} />}
      {overlay?.kind === "chain" && <ChainPane chainId={overlay.id} />}
      {overlay?.kind === "teamTemplates" && <TeamTemplatesDialog />}
      {overlay?.kind === "decider" && <DeciderDialog />}
      {overlay?.kind === "governor" && <GovernorDialog />}
      {overlay?.kind === "race" && <RacePane batchId={overlay.batchId} />}
      {overlay?.kind === "chainEditor" && <ChainEditorPane templateId={overlay.templateId} />}
      {overlay?.kind === "story" && <StoryPane />}
    </div>
    </CrewHost.Provider>
  );
}
