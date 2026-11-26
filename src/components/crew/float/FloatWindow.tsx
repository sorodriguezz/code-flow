/**
 * What a floating window holds: a conversation with a team, one with a single agent, or the call
 * with a team — each in a window of the system's of its own (`windows::float_open`), which goes
 * beside the app's, to another screen, and as many at once as are opened.
 *
 * The window has no frame: the header of what it holds is what it is carried by, and its three
 * buttons are its own — fold it down to its chip on the main window's shelf, fill the screen,
 * close it. Folding hides it with everything in it: a draft, the scroll and a turn in progress are
 * there when it comes back. Closing a conversation stops what was being answered in it.
 *
 * Which conversation it shows and whether it is folded is the main window's to say
 * (`teamChatWindowStore`, `teamCallStore`); this window asks it and is told.
 */
import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, Minus, Square, Unlink, X } from "lucide-react";
import { FLOAT, type FloatRef } from "../../../lib/floats";
import { closeChatWindow } from "../../../lib/agents/talk";
import { toggleMaximize } from "../../../lib/windowControls";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamCallStore } from "../../../state/teamCallStore";
import { useTeamChatStore } from "../../../state/teamChatStore";
import { teamChatOnScreen, useTeamChatWindowStore } from "../../../state/teamChatWindowStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { iconButtonClass } from "../../common/Button";
import { EmptyState } from "../../common/EmptyState";
import { CallRoom } from "../call/CallRoom";
import { PRESSABLE } from "../kit/floating";
import { useL } from "../state";
import { AgentChatContent } from "../teams/AgentChatContent";
import { TeamChatContent } from "../teams/TeamChatPane";

/** What makes a header the window's handle: pressed, it carries the window; pressed twice, it
 *  fills the screen or goes back. A press on a button in it is the button's. */
function useGrip(): HTMLAttributes<HTMLDivElement> {
  return useMemo(
    () => ({
      onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest(PRESSABLE)) return;
        event.preventDefault();
        if (event.detail >= 2) void toggleMaximize().catch(() => {});
        else void getCurrentWindow().startDragging().catch(() => {});
      },
    }),
    [],
  );
}

/** ⌘W / Ctrl+W is this window's own close, not the system's: what closing means is the window's. */
function useCloseChord(close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "w" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The window's three buttons, where a window has them. */
function Controls({ onMinimize, minimizeTitle, onClose, closeTitle, closeLabel }: {
  onMinimize: () => void;
  minimizeTitle: string;
  onClose: () => void;
  closeTitle: string;
  closeLabel: string;
}) {
  const l = useL();
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <span aria-hidden className="mr-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
      <button type="button" onClick={onMinimize} title={minimizeTitle} aria-label={l("Minimizar", "Minimise")} className={iconButtonClass({ size: "sm" })}>
        <Minus className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => void toggleMaximize().catch(() => {})} title={l("Maximizar o volver al tamaño anterior", "Maximise, or back to the previous size")} aria-label={l("Maximizar", "Maximise")} className={iconButtonClass({ size: "sm" })}>
        <Square className="h-3 w-3" />
      </button>
      <button type="button" onClick={onClose} title={closeTitle} aria-label={closeLabel} className={iconButtonClass({ size: "sm" })}>
        <X className="h-4 w-4" />
      </button>
    </span>
  );
}

/** A conversation with one agent: gone when its task is, and its chip lit when a turn ends unseen. */
function AgentChat({ float, taskId, shown, controls, grip }: { float: FloatRef; taskId: string; shown: boolean; controls: ReactNode; grip: HTMLAttributes<HTMLDivElement> }) {
  const l = useL();
  const busy = useAgentsStore((s) => (s.live[taskId]?.sending ?? false) || s.tasks.find((task) => task.id === taskId)?.status === "running");
  const gone = useAgentsStore((s) => !!s.workspaceId && s.workspaceId === float.workspaceId && !s.loading && !s.tasks.some((task) => task.id === taskId));
  // The conversation was deleted somewhere else: nothing is left for this window to show.
  useEffect(() => {
    if (gone) useTeamChatWindowStore.getState().close(float.key);
  }, [gone, float.key]);
  // A turn that ends with nobody looking lights the chip, as a team's does.
  const was = useRef(busy);
  useEffect(() => {
    if (was.current && !busy && !teamChatOnScreen(taskId)) {
      const failed = useAgentsStore.getState().tasks.find((task) => task.id === taskId)?.status === "error";
      useTeamChatWindowStore.getState().markUnread(taskId, failed ? "error" : "done");
    }
    was.current = busy;
  }, [busy, taskId]);
  const known = useAgentsStore((s) => s.tasks.some((task) => task.id === taskId));
  // Until its conversation is read the window still has to be a window: carried, folded, closed.
  if (!known) {
    return (
      <>
        <div {...grip} className="flex shrink-0 cursor-default select-none items-center gap-2.5 border-b border-[var(--cf-border)] px-4 py-3">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--cf-text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--cf-text-muted)]">{l("Abriendo la conversación…", "Opening the conversation…")}</span>
          {controls}
        </div>
        <div className="min-h-0 flex-1" />
      </>
    );
  }
  return <AgentChatContent key={taskId} taskId={taskId} shown={shown} controls={controls} grip={grip} />;
}

function ChatFloat({ float }: { float: FloatRef }) {
  const l = useL();
  const grip = useGrip();
  const win = useTeamChatWindowStore((s) => s.windows.find((w) => w.key === float.key));
  const chatId = win?.chatId ?? float.chatId;
  const shown = !(win?.minimized ?? false);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const chatWorkspace = useTeamChatStore((s) => (float.kind === "team" ? s.states[chatId]?.chat.workspaceId : undefined));
  const wanted = float.workspaceId || chatWorkspace || "";
  // The conversation is its workspace's: the window goes where it is, and reads that workspace's
  // agents and tasks — a turn is sent, and drawn, from here.
  useEffect(() => {
    if (wanted && workspaceId && wanted !== workspaceId) void useWorkspaceStore.getState().followWorkspace(wanted);
  }, [wanted, workspaceId]);
  useEffect(() => {
    const id = wanted || workspaceId;
    if (id && useAgentsStore.getState().workspaceId !== id) void useAgentsStore.getState().setWorkspace(id);
  }, [wanted, workspaceId]);

  const agent = float.kind === "agent";
  const close = () => closeChatWindow({ key: float.key, kind: agent ? "agent" : "team", chatId });
  useCloseChord(close);
  const controls = (
    <Controls
      onMinimize={() => useTeamChatWindowStore.getState().minimize(float.key)}
      minimizeTitle={agent
        ? l("Minimizar: queda abajo en CodeFlow y avisa cuando el agente termine", "Minimise: it stays at the bottom of CodeFlow and tells you when the agent is done")
        : l("Minimizar: queda abajo en CodeFlow y avisa cuando el equipo termine", "Minimise: it stays at the bottom of CodeFlow and tells you when the team is done")}
      onClose={close}
      closeTitle={agent
        ? l("Cerrar: si el agente estaba respondiendo, se detiene", "Close: if the agent was answering, it stops")
        : l("Cerrar: si el equipo estaba respondiendo, se detiene", "Close: if the team was answering, it stops")}
      closeLabel={agent ? l("Cerrar el chat con el agente", "Close the chat with the agent") : l("Cerrar el chat del equipo", "Close the team chat")}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]" data-team-chat-window={chatId}>
      {agent
        ? <AgentChat float={float} taskId={chatId} shown={shown} controls={controls} grip={grip} />
        : <TeamChatContent key={chatId} chatId={chatId} shown={shown} controls={controls} grip={grip} />}
    </div>
  );
}

function CallFloat() {
  const l = useL();
  const grip = useGrip();
  const call = useTeamCallStore((s) => s.call);
  const minimized = useTeamCallStore((s) => s.minimized);
  const [read, setRead] = useState(false);
  useEffect(() => {
    void useTeamCallStore.getState().resume().finally(() => setRead(true));
  }, []);
  // The call was let go of while this window was on its way: there is nothing to show.
  useEffect(() => {
    if (read && !call) void getCurrentWindow().close().catch(() => {});
  }, [read, call]);
  const { minimize, hangUp, close } = useTeamCallStore.getState();
  const phase = call?.phase;
  /** Closing a call that is going on is hanging up: its minutes, and the work if there is any. */
  const end = () => {
    if (phase === "live") hangUp();
    else if (phase !== "closing" && phase !== "starting") void close();
  };
  // ⌘W on a call that is going on folds it: a call does not end by a keystroke.
  useCloseChord(() => (phase === "live" || phase === "closing" || phase === "countdown" || phase === "starting" ? minimize() : void close()));
  if (!call) return <div className="h-full bg-[var(--cf-surface)]" />;
  const controls = (
    <Controls
      onMinimize={minimize}
      minimizeTitle={l("Minimizar: la llamada sigue y queda abajo en CodeFlow", "Minimise: the call goes on and stays at the bottom of CodeFlow")}
      onClose={end}
      closeTitle={phase === "live" ? l("Colgar: el líder escribe el acta y, si se acordó trabajo, el equipo empieza", "Hang up: the lead writes the minutes and, if work was agreed, the team starts") : l("Cerrar", "Close")}
      closeLabel={phase === "live" ? l("Colgar la llamada", "Hang up the call") : l("Cerrar la llamada", "Close the call")}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]" data-team-call-window={call.id}>
      <CallRoom call={call} shown={!minimized} controls={controls} grip={grip} onClose={() => void close()} />
    </div>
  );
}

/** The page of a floating window, by what it was opened on. */
export function FloatWindow() {
  const l = useL();
  if (!FLOAT) return <EmptyState icon={Unlink} title={l("Esta ventana no tiene nada que mostrar", "This window has nothing to show")} />;
  return FLOAT.kind === "call" ? <CallFloat /> : <ChatFloat float={FLOAT} />;
}
