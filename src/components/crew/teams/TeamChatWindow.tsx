/**
 * The shelf at the bottom of the main window: where the conversations with teams and with single
 * agents — and the call — fold down to.
 *
 * Each of them is a window of the system's of its own now (`float/FloatWindow`,
 * `windows::float_open`): beside the app's, on another screen, several at once. Folding one hides
 * it and leaves its chip here, which shows whether the team or the agent is still working, lights
 * up when it has answered, and brings the window back when it is pressed.
 *
 * The shelf is the app's, not a view's (`App.tsx` mounts it over the view's sheet): a chat started
 * from the assistant's panel leaves its chip over the code, and one started in Agents is still
 * there after walking to another view.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { teamChatBusy, useTeamChatStore } from "../../../state/teamChatStore";
import { useTeamChatWindowStore, type TeamChatWindow } from "../../../state/teamChatWindowStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useUiStore } from "../../../state/uiStore";
import { closeChatWindow } from "../../../lib/agents/talk";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { SOFT } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { TeamCallChip, useCallFolded } from "../call/TeamCallWindow";

/** Whether the agent is answering the conversation `taskId` right now. */
function useAgentBusy(taskId: string): boolean {
  return useAgentsStore((s) => (s.live[taskId]?.sending ?? false) || s.tasks.find((task) => task.id === taskId)?.status === "running");
}

/** A folded window, whoever it is with: who, what they are doing, and whether there is something to read. */
function ChipShell({ win, avatar, name, status, busy, openTitle, closeLabel, closeTitle }: {
  win: TeamChatWindow;
  avatar: ReactNode;
  name: string;
  status: string;
  busy: boolean;
  openTitle: string;
  closeLabel: string;
  closeTitle: string;
}) {
  const unread = !busy && win.unread;
  const tone = unread === "error" ? "var(--cf-danger)" : "var(--cf-accent)";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.94 }}
      transition={SOFT}
      className={`group pointer-events-auto flex h-[46px] max-w-[260px] items-center rounded-[14px] border bg-[var(--cf-surface)] shadow-[var(--cf-shadow)] ${unread ? "" : "border-[var(--cf-border-strong)]"}`}
      style={unread ? { borderColor: tone, background: `color-mix(in oklab, ${tone} 8%, var(--cf-surface))` } : undefined}
    >
      <button
        type="button"
        onClick={() => useTeamChatWindowStore.getState().restore(win.key)}
        title={openTitle}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-[13px] py-1 pl-2 pr-1 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--cf-accent-line)]"
      >
        {avatar}
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[12.5px] leading-tight">{name}</b>
          <span role="status" className={`block truncate text-[11px] leading-tight ${unread || busy ? "font-medium" : "text-[var(--cf-text-muted)]"}`} style={unread || busy ? { color: tone } : undefined}>
            {status}
          </span>
        </span>
        {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--cf-accent)]" />}
        {unread && (
          <span aria-hidden className="relative grid h-3.5 w-3.5 shrink-0 place-items-center">
            <span className="absolute h-3 w-3 animate-ping rounded-full opacity-50" style={{ background: tone }} />
            <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => closeChatWindow(win)}
        title={closeTitle}
        aria-label={closeLabel}
        className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--cf-text-muted)] opacity-0 outline-none hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

/** A team's folded window: what the team is doing, and whether it has answered. */
function TeamChip({ win }: { win: TeamChatWindow }) {
  const l = useL();
  const state = useTeamChatStore((s) => s.states[win.chatId]);
  const busy = teamChatBusy(state);
  const chat = state?.chat;
  const active = chat?.members.find((m) => m.id === chat.activeMemberId);
  const name = chat?.teamName ?? (win.title || l("Chat del equipo", "Team chat"));
  const unread = !busy && win.unread;
  const status = busy
    ? chat?.status === "cancelling" ? l("Deteniendo…", "Stopping…") : active ? l(`${active.name} trabaja…`, `${active.name} is working…`) : l("El líder coordina…", "The lead is coordinating…")
    : unread === "done" ? l("Respondió", "Answered")
    : unread === "error" ? l("Terminó con error", "Ended with an error")
    : l("Chat del equipo", "Team chat");
  return (
    <ChipShell
      win={win}
      avatar={<TeamAvatar size={28} state={busy ? "thinking" : "idle"} />}
      name={name}
      status={status}
      busy={busy}
      openTitle={l(`Abrir el chat con ${name}`, `Open the chat with ${name}`)}
      closeLabel={l(`Cerrar el chat con ${name}`, `Close the chat with ${name}`)}
      closeTitle={busy ? l("Cerrar: detiene lo que el equipo estaba respondiendo", "Close: stops what the team was answering") : l("Cerrar", "Close")}
    />
  );
}

/** An agent's folded window: whether it is still answering, and whether it has. */
function AgentChip({ win }: { win: TeamChatWindow }) {
  const l = useL();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === win.chatId));
  const look = useAgentsStore((s) => s.roster.find((agent) => agent.id === win.teamId));
  const busy = useAgentBusy(win.chatId);
  const name = look?.name ?? task?.agent_name ?? (win.title || l("Agente", "Agent"));
  const unread = !busy && win.unread;
  const status = busy ? l("Trabajando…", "Working…")
    : unread === "done" ? l("Respondió", "Answered")
    : unread === "error" ? l("Terminó con error", "Ended with an error")
    : l("Chat con el agente", "Chat with the agent");
  return (
    <ChipShell
      win={win}
      avatar={<AgentAvatar agent={{ id: win.teamId || win.chatId, icon: look?.icon, color: look?.color }} size={28} state={busy ? "thinking" : "idle"} />}
      name={name}
      status={status}
      busy={busy}
      openTitle={l(`Abrir el chat con ${name}`, `Open the chat with ${name}`)}
      closeLabel={l(`Cerrar el chat con ${name}`, `Close the chat with ${name}`)}
      closeTitle={busy ? l("Cerrar: detiene lo que el agente estaba respondiendo", "Close: stops what the agent was answering") : l("Cerrar", "Close")}
    />
  );
}

interface Insets { top: number; right: number; bottom: number; left: number }

/**
 * How far in from its parent's sides the layer sits. Nothing over most views: a window may float
 * anywhere on them. Over the Agents view it keeps to where that view draws its spaces
 * (`crewStore.stage`), as it did when the layer was that view's own — so a window never covers
 * its header, and the shelf never sits on its dock.
 */
function useInsets(layer: RefObject<HTMLDivElement | null>): Insets | null {
  const onAgents = useUiStore((s) => s.activeView === "agents");
  const stage = useCrewStore((s) => s.stage);
  const [insets, setInsets] = useState<Insets | null>(null);
  useLayoutEffect(() => {
    const parent = layer.current?.parentElement;
    // In an island the layer is drawn inside the stage itself: there is nothing to keep clear of.
    if (!onAgents || !stage || !parent || parent === stage || !parent.contains(stage)) {
      setInsets(null);
      return;
    }
    const measure = () => {
      const outer = parent.getBoundingClientRect();
      const inner = stage.getBoundingClientRect();
      // Not laid out — the view is hidden, or still arriving.
      if (inner.width === 0 || inner.height === 0) return setInsets(null);
      const next = { top: inner.top - outer.top, right: outer.right - inner.right, bottom: outer.bottom - inner.bottom, left: inner.left - outer.left };
      setInsets((was) => (was && was.top === next.top && was.right === next.right && was.bottom === next.bottom && was.left === next.left ? was : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [layer, onAgents, stage]);
  return insets;
}

/** The shelf the chats and the call fold down to, over whichever view is on screen. */
export function FloatShelf() {
  const l = useL();
  const layer = useRef<HTMLDivElement>(null);
  const insets = useInsets(layer);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const windows = useTeamChatWindowStore((s) => s.windows);
  const states = useTeamChatStore((s) => s.states);
  // A chip belongs to its conversation's workspace; a team's still being read is shown meanwhile.
  const folded = windows.filter((w) => {
    if (!w.minimized) return false;
    const of = w.kind === "agent" ? w.workspaceId : (states[w.chatId]?.chat.workspaceId ?? w.workspaceId);
    return !of || of === workspaceId;
  });
  const callFolded = useCallFolded();

  // A chip names its team and says what it is doing: read each folded conversation once.
  useEffect(() => {
    for (const w of folded) if (w.kind === "team" && !useTeamChatStore.getState().states[w.chatId]) void useTeamChatStore.getState().refresh(w.chatId);
  }, [folded.map((w) => w.chatId).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={layer} style={insets ?? undefined} className={`pointer-events-none absolute z-[40] overflow-hidden ${insets ? "" : "inset-0"}`}>
      <div role="group" aria-label={l("Chats y llamadas minimizados", "Minimised chats and calls")} className="absolute bottom-2.5 right-3 flex max-w-[calc(100%-24px)] flex-row-reverse flex-wrap-reverse items-end gap-2">
        <AnimatePresence initial={false}>
          {callFolded && <TeamCallChip key="call" />}
          {folded.map((w) => (w.kind === "agent" ? <AgentChip key={w.key} win={w} /> : <TeamChip key={w.key} win={w} />))}
        </AnimatePresence>
      </div>
    </div>
  );
}
