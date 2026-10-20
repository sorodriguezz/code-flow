import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Columns2,
  FileText,
  Flag,
  FolderGit2,
  FolderOpen,
  GitCompare,
  House,
  MessagesSquare,
  PanelRight,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { Tooltip } from "../../common/Tooltip";
import { toolbarClass } from "../../common/recipes";
import { TaskConversation } from "../AgentTaskDetail";
import { TaskReviewPanel, type ReviewTarget } from "../TaskReviewPanel";
import { RacePanel } from "../RacePanel";
import { BenchTerminalPane } from "../TerminalBench";
import { AgentCliPane } from "./AgentCliPane";
import { WorktreeFileView, WorktreeFiles } from "./WorktreeFiles";
import { reviewKeyOf, RowMark, ROW_STATE, TallyText, useRowLive, useRowTally } from "./rowStatus";
import { agentName } from "../agentName";
import { useBenchStore } from "../../../state/benchStore";
import { useUiStore } from "../../../state/uiStore";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { reviewOf, useTaskReviewStore } from "../../../state/taskReviewStore";
import { pushErrorToast } from "../../../state/toastStore";
import { useT } from "../../../state/languageStore";
import { revealInFileManager } from "../../../lib/tauri/commands";
import { openPathAsProject } from "../../../lib/openAsProject";
import { raceIdOf } from "../../../lib/agents/race";
import { samePath } from "../../../lib/agents/terminalTask";
import { CLI_PROVIDERS, hasCli } from "../../../lib/agents/cliLaunch";
import { startAgentCli } from "../../../lib/agents/startCli";
import { pathKey } from "../../../lib/agents/terminalTask";
import { AI_PROVIDERS } from "../../../lib/aiProviders";
import { useTerminalAgentStore } from "../../../state/terminalAgentStore";
import { LINE_COLOR, LINE_LABEL, LineGlyph } from "./WorktreeRail";
import { cardState, terminalLine } from "../../../lib/agents/worktreeRows";
import type { TerminalAgent } from "../../../types/domain";
import { folderName, type WorktreeRow } from "../../../lib/agents/worktreeRows";
import type { BenchTerminal } from "../../../types/domain";

/**
 * What a tab holds. `home` is the start page of a working copy no task owns; `shell:<id>` is a bench
 * terminal standing in it; `file:<rel>` is one of its files, read-only.
 */
type TabId = "chat" | "cli" | "home" | "changes" | "race" | `shell:${string}` | `file:${string}`;

interface TabSpec {
  id: TabId;
  label: string;
  icon: ReactNode;
  /** What closing it does — absent for the tabs that are always there. */
  close?: () => void;
  /** What the agent in it is doing, drawn after the label while it matters. */
  status?: ReactNode;
}

function providerLabel(id: string): string {
  return AI_PROVIDERS.find((candidate) => candidate.id === id)?.label ?? id;
}

/**
 * One working copy, whole — the centre of the «Worktrees» layout, drawn the way Orca draws it: a
 * strip of tabs (the agent, its CLI, every shell standing in the folder, the changes, any file you
 * opened), split in two when two of them need to be read side by side, and the folder's files down
 * the right.
 *
 * A tab that has been shown stays mounted, hidden, in the pane it was last shown in — two of them
 * are live terminals, and a terminal taken off screen and put back is a fresh xterm replaying a
 * transcript, not the one that was left. Moving a tab to the other pane moves its one instance.
 */
export function WorktreeWorkspace({
  row,
  rowAgents,
  onNewAgent,
}: {
  row: WorktreeRow;
  /** The terminal agents the rail filed under this row (`agentsByRow`) — the one place that decides
   *  which working copy a terminal belongs to, nested folders included. */
  rowAgents: TerminalAgent[];
  onNewAgent: (projectId: string) => void;
}) {
  const t = useT();
  const task = row.task;
  const { state, sending } = useRowLive(row, true);
  const counted = useRowTally(row, sending, !(row.isMain && !task));
  const repoName = useWorkspaceStore(
    (s) => (s.projectsByWorkspace[s.activeWorkspaceId ?? ""] ?? []).find((project) => project.id === row.projectId)?.name ?? "",
  );
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const focusProject = useWorkspaceStore((s) => s.focusProject);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const filesOpen = useWorktreeViewStore((s) => s.filesOpen);
  const cliId = useWorktreeViewStore((s) => s.cliTerminal[row.key] ?? "");
  const preferCli = useWorktreeViewStore((s) => (task ? s.agentMode[task.id] === "cli" : false));
  const terminals = useBenchStore((s) => s.terminals);
  const pendingNotes = useTaskReviewStore((s) => {
    const review = reviewOf(s, reviewKeyOf(row));
    return review.comments.length + (review.general.trim() === "" ? 0 : 1);
  });
  const raceId = task ? raceIdOf(task) : "";

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Files opened from the tree, in the order they were opened. */
  const [files, setFiles] = useState<string[]>([]);
  /** The CLI tab asked for before its terminal exists — it shows the start page until then. */
  const [cliAsked, setCliAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * Whether the bench rows were re-read since this row opened. A terminal mounted here replays the
   * transcript its row carries, and that copy is only as recent as the bench's last read — so the
   * shells wait for one fresh read rather than replaying output from whenever that was.
   */
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!workspaceId) return;
    void useBenchStore
      .getState()
      .refresh(workspaceId)
      .catch(() => undefined)
      .finally(() => {
        if (alive) setFresh(true);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const agents = useTerminalAgentStore((s) => s.agents);
  const spaceName = useWorktreeViewStore((s) => s.names[pathKey(row.path)] ?? "");
  // The shells standing in this folder: opened here, or — an agent's terminal that moved — whose
  // agent the rail filed under this row.
  const shells: BenchTerminal[] = useMemo(
    () =>
      row.path === ""
        ? []
        : terminals.filter(
            (terminal) =>
              terminal.id !== cliId &&
              (samePath(terminal.cwd, row.path) || rowAgents.some((agent) => agent.session_id === terminal.session_id)),
          ),
    [terminals, cliId, row.path, rowAgents],
  );
  /** What the header says: the task's own state, or — with no task — the most urgent of the agents
   *  in its terminals. `null` with nobody here. */
  const terminalState = cardState(rowAgents.flatMap((agent) => terminalLine(agent, undefined) ?? []));
  const agentOf = (terminal: BenchTerminal | null) => (terminal?.session_id ? agents[terminal.session_id] : undefined);
  const cliTerminal = cliId ? (terminals.find((terminal) => terminal.id === cliId) ?? null) : null;
  const hasCliTab = !!cliTerminal || cliAsked;

  const closeTerminal = (terminal: BenchTerminal) =>
    void useBenchStore.getState().closePane(terminal.tab_id, terminal.id).catch((e: unknown) => pushErrorToast(String(e)));

  const agentLabel = task ? agentName(task.agent_name, task.provider, t) : "";
  const tabs: TabSpec[] = [
    ...(task
      ? [{ id: "chat" as const, label: t("wt.tabChat"), icon: <MessagesSquare size={13} /> }]
      : // The start page only while nothing runs here: once a terminal does, «+» is where the next
        // agent starts, as in Orca.
        !cliTerminal && shells.length === 0
        ? [{ id: "home" as const, label: t("wt.tabHome"), icon: <House size={13} /> }]
        : []),
    ...(hasCliTab
      ? [
          {
            id: "cli" as const,
            label: task ? agentLabel : t("wt.modeCli"),
            icon: task ? <ProviderGlyph providerId={task.provider} size={13} /> : <SquareTerminal size={13} />,
            close: () => {
              if (cliTerminal) closeTerminal(cliTerminal);
              useWorktreeViewStore.getState().setCliTerminal(row.key, null);
              if (task) useWorktreeViewStore.getState().setAgentMode(task.id, "chat");
              setCliAsked(false);
            },
          },
        ]
      : []),
    ...shells.map((terminal, at) => {
      // A shell with an agent in it is that agent's tab: its mark, its name, and what it is doing.
      const agent = agentOf(terminal);
      const named = agent?.agent ? providerLabel(agent.agent) : "";
      const twins = named ? shells.filter((other) => agentOf(other)?.agent === agent?.agent) : [];
      return {
        id: `shell:${terminal.id}` as const,
        label: named
          ? twins.length > 1
            ? `${named} ${twins.indexOf(terminal) + 1}`
            : named
          : shells.length > 1
            ? `${t("wt.tabShell")} ${at + 1}`
            : t("wt.tabShell"),
        icon: agent?.agent ? <ProviderGlyph providerId={agent.agent} size={13} /> : <SquareTerminal size={13} />,
        status: agent?.state === "working" || agent?.state === "blocked" ? <LineGlyph state={agent.state} size={8} /> : undefined,
        close: () => closeTerminal(terminal),
      };
    }),
    {
      id: "changes",
      label: pendingNotes > 0 ? `${t("wt.tabChanges")} · ${pendingNotes}` : t("wt.tabChanges"),
      icon: <GitCompare size={13} />,
    },
    ...(raceId !== "" ? [{ id: "race" as const, label: t("wt.tabRace"), icon: <Flag size={13} /> }] : []),
    ...files.map((rel) => ({
      id: `file:${rel}` as const,
      label: folderName(rel),
      icon: <FileText size={13} />,
      close: () => setFiles((current) => current.filter((file) => file !== rel)),
    })),
  ];
  const ids = new Set(tabs.map((tab) => tab.id));
  /** The shell of the first agent at work here, when there is one: what opening the row should show. */
  const agentShell = shells.find((terminal) => agentOf(terminal)?.agent);
  const first: TabId = task
    ? preferCli && cliTerminal
      ? "cli"
      : "chat"
    : cliTerminal
      ? "cli"
      : agentShell
        ? `shell:${agentShell.id}`
        : shells[0]
          ? `shell:${shells[0].id}`
          : "home";

  /** One or two panes; `focus` is the one a click on a tab fills. */
  const [panes, setPanes] = useState<TabId[]>([first]);
  const [focus, setFocus] = useState(0);
  /** What each pane has mounted — a tab lives in one pane at a time. */
  const [mounted, setMounted] = useState<Set<TabId>[]>([new Set([first])]);

  // A tab that went away (a shell closed elsewhere, a race finished) is replaced by the first one.
  const shown = panes.map((tab) => (ids.has(tab) ? tab : first));

  const show = (tab: TabId, pane = focus) => {
    setPanes((current) => {
      const next = current.map((value) => (ids.has(value) ? value : first));
      const other = next.length > 1 ? 1 - pane : -1;
      // Asked for in one pane while it is up in the other: they swap, so it is never on screen twice.
      if (other >= 0 && next[other] === tab) next[other] = next[pane];
      next[pane] = tab;
      return next;
    });
    setMounted((current) =>
      current.map((set, at) => {
        const next = new Set(set);
        if (at === pane) next.add(tab);
        else next.delete(tab);
        return next;
      }),
    );
    setFocus(pane);
  };

  const split = () => {
    if (panes.length > 1) {
      // Back to one: the focused pane's tab stays.
      const keep = shown[focus];
      setPanes([keep]);
      setMounted([new Set([keep, ...mounted[0], ...(mounted[1] ?? [])])]);
      setFocus(0);
      return;
    }
    const current = shown[0];
    const second = (tabs.find((tab) => tab.id !== current && tab.id === "changes") ?? tabs.find((tab) => tab.id !== current))?.id;
    if (!second) return;
    setPanes([current, second]);
    setMounted([new Set([...mounted[0]].filter((tab) => tab !== second)), new Set([second])]);
    setFocus(1);
  };

  // A click on one of the card's lines: bring that agent's tab up — its terminal, or its chat.
  const focusRequest = useWorktreeViewStore((s) => s.focusRequest);
  useEffect(() => {
    if (!focusRequest || focusRequest.rowKey !== row.key || !fresh) return;
    const target = focusRequest.target;
    if (target.kind === "task") {
      if (ids.has("chat")) show("chat");
    } else {
      const terminal = terminals.find((candidate) => candidate.session_id === target.sessionId);
      if (terminal && terminal.id === cliId) show("cli");
      else if (terminal && ids.has(`shell:${terminal.id}`)) show(`shell:${terminal.id}`);
    }
    useWorktreeViewStore.getState().requestFocus(null);
    // `show` and `ids` are this render's; the request is what this effect answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, fresh, row.key]);

  // The bench is read after the row opens: when that read finds an agent at work here and the row
  // is still on its start page, the agent is what to show.
  const landed = useRef(false);
  useEffect(() => {
    if (!fresh || landed.current) return;
    landed.current = true;
    if (shown[0] === "home" && agentShell) show(`shell:${agentShell.id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);

  /** Starts an agent's CLI in a new terminal here, and shows it. */
  const startAgent = async (provider: string) => {
    if (!workspaceId || row.path === "") return;
    setBusy(true);
    try {
      const started = await startAgentCli({
        workspaceId,
        path: row.path,
        provider,
        title: `${providerLabel(provider)} · ${row.branch || folderName(row.path)}`,
      });
      if (started) show(`shell:${started.terminalId}`);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openShell = async () => {
    if (!workspaceId || row.path === "") return;
    setBusy(true);
    try {
      const bench = useBenchStore.getState();
      await bench.addTab(workspaceId, row.path);
      const tabId = useBenchStore.getState().activeTabId;
      const created = tabId ? useBenchStore.getState().focusedPane[tabId] : "";
      if (tabId) await bench.renameTab(tabId, row.branch || folderName(row.path)).catch(() => undefined);
      if (created) show(`shell:${created}`);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openCli = () => {
    setCliAsked(true);
    if (task) useWorktreeViewStore.getState().setAgentMode(task.id, "cli");
    show("cli");
  };

  const openFile = (rel: string) => {
    setFiles((current) => (current.includes(rel) ? current : [...current, rel]));
    show(`file:${rel}`);
  };

  const plusMenu: MenuItem[] = [
    ...CLI_PROVIDERS.map((provider) => ({
      label: t("wt.startAgent", { name: providerLabel(provider) }),
      leading: <ProviderGlyph providerId={provider} size={14} />,
      onClick: () => void startAgent(provider),
    })),
    { label: t("wt.shellOpen"), icon: SquareTerminal, separated: true, onClick: () => void openShell() },
    ...(!hasCliTab && (!task || hasCli(task.provider))
      ? [
          {
            label: task ? t("wt.cliStart", { name: agentLabel }) : t("wt.cliAny"),
            icon: SquareTerminal,
            onClick: openCli,
          },
        ]
      : []),
    { label: t("wt.tabChanges"), icon: GitCompare, onClick: () => show("changes") },
  ];

  const openAsRepo = () => {
    if (row.isMain) {
      if (workspaceId) void focusProject(workspaceId, row.projectId).then(() => setActiveView("changes"));
      return;
    }
    void openPathAsProject(row.path, null, row.branch || undefined).then(() => setActiveView("changes"));
  };

  /**
   * Where the «Cambios» review goes: the task's chat; with no task, the agent CLI in one of this
   * copy's terminals — typed in, as if pasted — and its terminal brought up; with nobody here,
   * nowhere, and the diff is read-only.
   */
  const terminalAgents = rowAgents.filter((agent) => agent.agent);
  const reviewTarget: ReviewTarget = task
    ? { kind: "task" }
    : terminalAgents.length > 0
      ? {
          kind: "terminal",
          agents: terminalAgents.map((agent, at) => {
            const label = providerLabel(agent.agent ?? "");
            const before = terminalAgents.slice(0, at).filter((other) => other.agent === agent.agent).length;
            return { sessionId: agent.session_id, label: before > 0 ? `${label} ${before + 1}` : label };
          }),
          onSent: (sessionId) => {
            const terminal = terminals.find((candidate) => candidate.session_id === sessionId);
            if (!terminal) return;
            if (terminal.id === cliId) show("cli");
            else if (ids.has(`shell:${terminal.id}`)) show(`shell:${terminal.id}`);
          },
        }
      : { kind: "none" };

  const render = (tab: TabId, visible: boolean): ReactNode => {
    if (tab === "chat") return task ? <TaskConversation taskId={task.id} /> : null;
    if (tab === "home") return <AgentLauncher row={row} busy={busy} onStart={(provider) => void startAgent(provider)} onShell={() => void openShell()} onChat={() => onNewAgent(row.projectId)} />;
    if (tab === "cli") return fresh ? <AgentCliPane row={row} visible={visible} /> : null;
    if (tab === "changes") {
      return row.path === "" ? null : <TaskReviewPanel taskId={reviewKeyOf(row)} repoPath={row.path} sendTo={reviewTarget} />;
    }
    if (tab === "race") return raceId ? <RacePanel batchId={raceId} /> : null;
    if (tab.startsWith("shell:")) {
      const terminal = shells.find((candidate) => `shell:${candidate.id}` === tab);
      return terminal && fresh ? (
        <BenchTerminalPane bare terminal={terminal} visible={visible} focused={false} onFocus={() => undefined} onClose={() => closeTerminal(terminal)} />
      ) : null;
    }
    if (tab.startsWith("file:")) return <WorktreeFileView root={row.path} rel={tab.slice("file:".length)} />;
    return null;
  };

  // A space «Nuevo agente» made is called what the rail calls it; anything else, where it is.
  const where = (!task && spaceName) || (row.isMain ? repoName : folderName(row.path));

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={toolbarClass}>
          <RowMark row={row} state={state} size={15} />
          <p className="min-w-[60px] max-w-[45%] shrink-0 truncate text-[14px] font-semibold text-[var(--cf-text)]" title={row.path}>
            {where}
          </p>
          <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-[12px] text-[var(--cf-text-muted)]">
            <span className="truncate font-mono text-[11.5px]">{row.branch || "—"}</span>
            {task && (
              <>
                <span className="text-[var(--cf-text-faint)]">·</span>
                <ProviderGlyph providerId={task.provider} size={12} />
                <span className="truncate">{agentLabel}</span>
              </>
            )}
            <span className="text-[var(--cf-text-faint)]">·</span>
            {!task && terminalState ? (
              <span className={`shrink-0 ${LINE_COLOR[terminalState]}`}>{t(LINE_LABEL[terminalState])}</span>
            ) : (
              <span className={`shrink-0 ${ROW_STATE[state].color}`}>{t(ROW_STATE[state].labelKey)}</span>
            )}
            <TallyText value={counted} className="ml-1" />
          </span>
          <span className="min-w-2 flex-1" />
          <Tooltip label={row.isMain ? t("wt.openRepo") : t("agents.openWorktreeAsRepo")}>
            <button type="button" onClick={openAsRepo} aria-label={t("wt.openRepo")} className={iconButtonClass()}>
              <FolderGit2 size={15} />
            </button>
          </Tooltip>
          <Tooltip label={t("agents.revealWorktree")}>
            <button
              type="button"
              disabled={row.path === ""}
              onClick={() => void revealInFileManager(row.path)}
              aria-label={t("agents.revealWorktree")}
              className={iconButtonClass()}
            >
              <FolderOpen size={15} />
            </button>
          </Tooltip>
          <Tooltip label={t("wt.files")}>
            <button
              type="button"
              onClick={() => useWorktreeViewStore.getState().toggleFiles()}
              aria-pressed={filesOpen}
              aria-label={t("wt.files")}
              className={iconButtonClass({ active: filesOpen })}
            >
              <PanelRight size={15} />
            </button>
          </Tooltip>
        </div>

        {/* The tab strip, terminal-style: what is open in this working copy, one click each. */}
        <div className="flex h-9 shrink-0 items-stretch border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_55%,var(--cf-surface))]">
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
            {tabs.map((tab) => {
              const at = shown.indexOf(tab.id);
              const active = at === focus;
              return (
                <div
                  key={tab.id}
                  className={`group relative flex max-w-[200px] shrink-0 items-stretch border-r border-[var(--cf-border)] text-[12px] ${
                    active
                      ? "bg-[var(--cf-surface)] text-[var(--cf-text)] shadow-[inset_0_2px_0_var(--cf-accent)]"
                      : at >= 0
                        ? "bg-[var(--cf-surface)] text-[var(--cf-text)]"
                        : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                  }`}
                >
                  {/* The whole tab is the button; the close glyph sits over its right padding. */}
                  <button
                    type="button"
                    onClick={() => show(tab.id)}
                    className={`flex min-w-0 flex-1 items-center gap-1.5 pl-3 ${tab.close ? "pr-7" : "pr-4"}`}
                  >
                    <span className="shrink-0">{tab.icon}</span>
                    <span className="truncate">{tab.label}</span>
                    {tab.status && <span className="flex shrink-0 items-center">{tab.status}</span>}
                  </button>
                  {tab.close && (
                    <button
                      type="button"
                      onClick={tab.close}
                      aria-label={t("wt.closeTab")}
                      className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] ${
                        at >= 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              );
            })}
            <Tooltip label={t("wt.newTab")}>
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: rect.left, y: rect.bottom + 2 });
                }}
                aria-label={t("wt.newTab")}
                className="flex w-9 shrink-0 items-center justify-center text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
              >
                <Plus size={14} />
              </button>
            </Tooltip>
          </div>
          <Tooltip label={panes.length > 1 ? t("wt.unsplit") : t("wt.split")}>
            <button
              type="button"
              onClick={split}
              aria-pressed={panes.length > 1}
              aria-label={t("wt.split")}
              className={iconButtonClass({ active: panes.length > 1, className: "mx-1.5 self-center" })}
            >
              <Columns2 size={14} />
            </button>
          </Tooltip>
        </div>

        <div className="flex min-h-0 flex-1">
          {shown.map((paneTab, pane) => (
            <div
              key={pane}
              onPointerDownCapture={() => setFocus(pane)}
              className={`flex min-h-0 min-w-0 flex-1 flex-col ${pane > 0 ? "border-l border-[var(--cf-border)]" : ""}`}
            >
              {[...(mounted[pane] ?? new Set<TabId>())]
                .filter((tab) => ids.has(tab))
                .concat(mounted[pane]?.has(paneTab) ? [] : [paneTab])
                .map((tab) => (
                  <div key={tab} className={tab === paneTab ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                    {render(tab, tab === paneTab)}
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      {filesOpen && row.path !== "" && <WorktreeFiles row={row} onOpen={openFile} />}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={plusMenu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * A working copy nobody is working in: who should. Every agent CLI the app knows, started in a
 * terminal standing here — the way Orca opens a workspace — plus a plain terminal, and a chat agent
 * from the roster for an engine with no CLI of its own (the local model among them).
 */
function AgentLauncher({
  row,
  busy,
  onStart,
  onShell,
  onChat,
}: {
  row: WorktreeRow;
  busy: boolean;
  onStart: (provider: string) => void;
  onShell: () => void;
  onChat: () => void;
}) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-6 py-10">
        <div>
          <p className="text-[14px] font-semibold text-[var(--cf-text)]">{t("wt.launchTitle")}</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {row.isMain ? t("wt.emptyMainHint") : t("wt.launchHint")}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CLI_PROVIDERS.map((provider) => (
            <button
              key={provider}
              type="button"
              disabled={busy || row.path === ""}
              onClick={() => onStart(provider)}
              className="flex h-10 items-center gap-2 rounded-lg border border-[var(--cf-border)] px-3 text-left text-[12.5px] text-[var(--cf-text)] transition-colors hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-hover)] disabled:opacity-50"
            >
              <ProviderGlyph providerId={provider} size={16} />
              <span className="min-w-0 truncate">{providerLabel(provider)}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy || row.path === ""} onClick={onShell} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <SquareTerminal size={12} />
            {t("wt.shellOpen")}
          </button>
          <button type="button" onClick={onChat} className={buttonClass({ variant: "ghost", size: "sm" })}>
            <MessagesSquare size={12} />
            {t("wt.launchChat")}
          </button>
        </div>
      </div>
    </div>
  );
}
