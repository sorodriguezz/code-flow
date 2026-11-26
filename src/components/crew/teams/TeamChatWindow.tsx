/**
 * The conversations with teams and with single agents — and the call — as floating windows over
 * whichever view is on screen.
 *
 * A chat used to be a side sheet with a veil behind it, in the Agents view's one overlay: while it
 * was open the org chart or the run it was about could not be seen, and nothing else could open. A
 * window is carried by its header, grows from its sides, fills the view or folds down to a chip
 * on the shelf at the bottom — where it shows whether the team or the agent is still working and
 * lights up when it has answered. The space behind stays in use the whole time.
 *
 * The layer is the app's, not a view's (`App.tsx` mounts it over the view's sheet): a chat started
 * from the assistant's panel floats over the code, and one started in Agents is still there after
 * walking to another view. The conversation of a folded window stays mounted: a draft, the scroll
 * and a turn in progress are there when it comes back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Maximize2, Minimize2, Minus, X } from "lucide-react";
import { teamChatBusy, useTeamChatStore } from "../../../state/teamChatStore";
import { teamChatOnScreen, useTeamChatWindowStore, type TeamChatWindow } from "../../../state/teamChatWindowStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useUiStore } from "../../../state/uiStore";
import { defaultRect, fitRect, maximizedRect, moveRect, resizeRect, type Area, type Rect } from "../../../lib/floatingRect";
import { follow, HANDLES, PRESSABLE, useArea } from "../kit/floating";
import { iconButtonClass } from "../../common/Button";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { SOFT } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { TeamChatContent } from "./TeamChatPane";
import { AgentChatContent } from "./AgentChatContent";
import { TeamCallChip, TeamCallWindow, useCallFolded } from "../call/TeamCallWindow";

/** What a window hands the conversation drawn in it: its buttons, and what makes a header its handle. */
interface WindowParts {
  controls: ReactNode;
  grip: HTMLAttributes<HTMLDivElement>;
  close: () => void;
}

/** The floating frame itself, whatever it holds: placed, carried, pulled, maximised, folded. */
function FloatingFrame({ win, area, shelf, label, children }: { win: TeamChatWindow; area: Area; shelf: boolean; label: string; children: (parts: WindowParts) => ReactNode }) {
  const l = useL();
  const stored = useTeamChatWindowStore((s) => s.rect);
  const maximized = useTeamChatWindowStore((s) => s.maximized);
  /** The frame while it is being carried or pulled; it is kept once the pointer lets go. */
  const [live, setLive] = useState<Rect | null>(null);
  const latest = useRef<Rect | null>(null);
  /** Folded and done folding: out of the layout, so nothing of it can be pressed or tabbed into. */
  const [parked, setParked] = useState(win.minimized);
  useEffect(() => {
    if (!win.minimized) {
      setParked(false);
      return;
    }
    // Once it has had the time to fold. A timer, not the animation's own end: that one is not
    // told when motion is reduced or the window is in the background.
    const timer = window.setTimeout(() => setParked(true), 360);
    return () => window.clearTimeout(timer);
  }, [win.minimized]);
  const resting = fitRect(stored ?? defaultRect(area), area);
  const rect = maximized ? maximizedRect(area, shelf) : (live ?? resting);

  const reshape = (event: ReactPointerEvent<HTMLElement>, next: (start: Rect, dx: number, dy: number) => Rect) => {
    if (event.button !== 0 || maximized) return;
    const start = resting;
    follow(
      event,
      (dx, dy) => {
        latest.current = next(start, dx, dy);
        setLive(latest.current);
      },
      () => {
        if (latest.current) useTeamChatWindowStore.getState().place(latest.current);
        latest.current = null;
        setLive(null);
      },
    );
  };

  const { minimize, close, toggleMaximized } = useTeamChatWindowStore.getState();
  const agent = win.kind === "agent";
  const controls = (
    <>
      <button
        type="button"
        onClick={() => minimize(win.key)}
        title={agent
          ? l("Minimizar: queda abajo y avisa cuando el agente termine", "Minimise: it stays at the bottom and tells you when the agent is done")
          : l("Minimizar: queda abajo y avisa cuando el equipo termine", "Minimise: it stays at the bottom and tells you when the team is done")}
        aria-label={agent ? l("Minimizar el chat con el agente", "Minimise the chat with the agent") : l("Minimizar el chat del equipo", "Minimise the team chat")}
        className={iconButtonClass({ size: "sm" })}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={toggleMaximized}
        title={maximized ? l("Volver al tamaño anterior", "Back to the previous size") : l("Maximizar", "Maximise")}
        aria-label={maximized ? l("Volver al tamaño anterior", "Back to the previous size") : agent ? l("Maximizar el chat con el agente", "Maximise the chat with the agent") : l("Maximizar el chat del equipo", "Maximise the team chat")}
        className={iconButtonClass({ size: "sm" })}
      >
        {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      </button>
    </>
  );

  return (
    <motion.section
      role="dialog"
      aria-label={label}
      data-team-chat-window={win.chatId}
      initial={{ opacity: 0, scale: 0.96, y: 14 }}
      animate={win.minimized ? { opacity: 0, scale: 0.9, y: 36 } : { opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 14 }}
      transition={SOFT}
      inert={win.minimized}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, transformOrigin: "bottom right" }}
      className={`absolute flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border-strong)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)] ${parked ? "hidden" : "flex"} ${win.minimized ? "pointer-events-none" : "pointer-events-auto"} ${live ? "select-none" : ""}`}
    >
      {children({
        controls,
        close: () => close(win.key),
        grip: {
          onPointerDown: (event) => {
            if ((event.target as HTMLElement).closest(PRESSABLE)) return;
            reshape(event, (start, dx, dy) => moveRect(start, dx, dy, area));
          },
          onDoubleClick: (event) => {
            if (!(event.target as HTMLElement).closest(PRESSABLE)) toggleMaximized();
          },
        },
      })}
      {!maximized && HANDLES.map((handle) => (
        <div
          key={handle.name}
          aria-hidden
          onPointerDown={(event) => reshape(event, (start, dx, dy) => resizeRect(start, handle.edges, dx, dy, area))}
          className={`absolute touch-none ${handle.className}`}
        />
      ))}
    </motion.section>
  );
}

function FloatingChat({ win, area, shelf }: { win: TeamChatWindow; area: Area; shelf: boolean }) {
  const l = useL();
  const teamName = useTeamChatStore((s) => s.states[win.chatId]?.chat.teamName);
  return (
    <FloatingFrame win={win} area={area} shelf={shelf} label={teamName ? l(`Chat del equipo ${teamName}`, `Chat of the team ${teamName}`) : l("Chat del equipo", "Team chat")}>
      {({ controls, grip, close }) => <TeamChatContent key={win.chatId} chatId={win.chatId} shown={!win.minimized} onClose={close} controls={controls} grip={grip} />}
    </FloatingFrame>
  );
}

/** Whether the agent is answering the conversation `taskId` right now. */
function useAgentBusy(taskId: string): boolean {
  return useAgentsStore((s) => (s.live[taskId]?.sending ?? false) || s.tasks.find((task) => task.id === taskId)?.status === "running");
}

function FloatingAgent({ win, area, shelf }: { win: TeamChatWindow; area: Area; shelf: boolean }) {
  const l = useL();
  const name = useAgentsStore((s) => s.tasks.find((task) => task.id === win.chatId)?.agent_name);
  const gone = useAgentsStore((s) => s.workspaceId === win.workspaceId && !s.loading && !s.tasks.some((task) => task.id === win.chatId));
  const busy = useAgentBusy(win.chatId);
  // The conversation was deleted somewhere else: nothing is left for this window to show.
  useEffect(() => {
    if (gone) useTeamChatWindowStore.getState().close(win.key);
  }, [gone, win.key]);
  // A turn that ends with nobody looking lights the chip, as a team's does.
  const was = useRef(busy);
  useEffect(() => {
    if (was.current && !busy && !teamChatOnScreen(win.chatId)) {
      const failed = useAgentsStore.getState().tasks.find((task) => task.id === win.chatId)?.status === "error";
      useTeamChatWindowStore.getState().markUnread(win.chatId, failed ? "error" : "done");
    }
    was.current = busy;
  }, [busy, win.chatId]);
  return (
    <FloatingFrame win={win} area={area} shelf={shelf} label={name ? l(`Chat con ${name}`, `Chat with ${name}`) : l("Chat con el agente", "Chat with the agent")}>
      {({ controls, grip, close }) => <AgentChatContent key={win.chatId} taskId={win.chatId} shown={!win.minimized} onClose={close} controls={controls} grip={grip} />}
    </FloatingFrame>
  );
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
        onClick={() => useTeamChatWindowStore.getState().close(win.key)}
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
  const name = chat?.teamName ?? l("Chat del equipo", "Team chat");
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
      closeTitle={busy ? l("Cerrar: el equipo sigue trabajando y avisa al terminar", "Close: the team keeps working and tells you when it is done") : l("Cerrar", "Close")}
    />
  );
}

/** An agent's folded window: whether it is still answering, and whether it has. */
function AgentChip({ win }: { win: TeamChatWindow }) {
  const l = useL();
  const task = useAgentsStore((s) => s.tasks.find((candidate) => candidate.id === win.chatId));
  const look = useAgentsStore((s) => s.roster.find((agent) => agent.id === win.teamId));
  const busy = useAgentBusy(win.chatId);
  const name = look?.name ?? task?.agent_name ?? l("Agente", "Agent");
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
      closeTitle={busy ? l("Cerrar: el agente sigue trabajando y avisa al terminar", "Close: the agent keeps working and tells you when it is done") : l("Cerrar", "Close")}
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

/** The layer over the view on screen where the chats and the call float, and the shelf they fold down to. */
export function TeamChatWindows() {
  const l = useL();
  const layer = useRef<HTMLDivElement>(null);
  const area = useArea(layer);
  const insets = useInsets(layer);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const windows = useTeamChatWindowStore((s) => s.windows);
  const states = useTeamChatStore((s) => s.states);
  // A window belongs to its conversation's workspace; a team's still being read is shown meanwhile.
  const here = windows.filter((w) => {
    if (w.kind === "agent") return w.workspaceId === workspaceId;
    const state = states[w.chatId];
    return !state || state.chat.workspaceId === workspaceId;
  });
  const folded = here.filter((w) => w.minimized);
  // The call folds to the same shelf: a window fills the view down to it whichever sits there.
  const callFolded = useCallFolded();
  const shelf = folded.length > 0 || callFolded;

  // A chip names its team and says what it is doing: read each folded conversation once.
  useEffect(() => {
    for (const w of folded) if (w.kind === "team" && !useTeamChatStore.getState().states[w.chatId]) void useTeamChatStore.getState().refresh(w.chatId);
  }, [folded.map((w) => w.chatId).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={layer} style={insets ?? undefined} className={`pointer-events-none absolute z-[40] overflow-hidden ${insets ? "" : "inset-0"}`}>
      {/* The shelf first, so a window carried over it covers it rather than being covered. */}
      <div role="group" aria-label={l("Chats y llamadas minimizados", "Minimised chats and calls")} className="absolute bottom-2.5 right-3 flex max-w-[calc(100%-24px)] flex-row-reverse flex-wrap-reverse items-end gap-2">
        <AnimatePresence initial={false}>
          {callFolded && <TeamCallChip key="call" />}
          {folded.map((w) => (w.kind === "agent" ? <AgentChip key={w.key} win={w} /> : <TeamChip key={w.key} win={w} />))}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {area && here.map((w) => (w.kind === "agent" ? <FloatingAgent key={w.key} win={w} area={area} shelf={shelf} /> : <FloatingChat key={w.key} win={w} area={area} shelf={shelf} />))}
      </AnimatePresence>
      {/* Over the chats: a call is what is being attended to while it is open. */}
      <AnimatePresence>
        {area && <TeamCallWindow key="call" area={area} shelf={shelf} />}
      </AnimatePresence>
    </div>
  );
}
