/**
 * The team chats as floating windows over the Agents view.
 *
 * A chat used to be a side sheet with a veil behind it, in the view's one overlay: while it was
 * open the org chart or the run it was about could not be seen, and nothing else could open. A
 * window is carried by its header, grows from its sides, fills the view or folds down to a chip
 * on the shelf at the bottom — where it shows whether the team is still working and lights up
 * when it has answered. The space behind stays in use the whole time.
 *
 * The conversation of a folded window stays mounted: a draft, the scroll and a turn in progress
 * are there when it comes back.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Maximize2, Minimize2, Minus, X } from "lucide-react";
import { teamChatBusy, useTeamChatStore } from "../../../state/teamChatStore";
import { useTeamChatWindowStore, type TeamChatWindow } from "../../../state/teamChatWindowStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { defaultRect, fitRect, maximizedRect, moveRect, resizeRect, type Area, type Edges, type Rect } from "../../../lib/floatingRect";
import { iconButtonClass } from "../../common/Button";
import { TeamAvatar } from "../kit/Avatar";
import { SOFT } from "../kit/ui";
import { useL } from "../state";
import { TeamChatContent } from "./TeamChatPane";

/** The eight places a window is resized from: four sides, four corners. */
const HANDLES: { name: string; edges: Edges; className: string }[] = [
  { name: "n", edges: { top: true }, className: "inset-x-4 top-0 h-1.5 cursor-ns-resize" },
  { name: "s", edges: { bottom: true }, className: "inset-x-4 bottom-0 h-1.5 cursor-ns-resize" },
  { name: "w", edges: { left: true }, className: "inset-y-4 left-0 w-1.5 cursor-ew-resize" },
  { name: "e", edges: { right: true }, className: "inset-y-4 right-0 w-1.5 cursor-ew-resize" },
  { name: "nw", edges: { top: true, left: true }, className: "left-0 top-0 h-4 w-4 cursor-nwse-resize" },
  { name: "ne", edges: { top: true, right: true }, className: "right-0 top-0 h-4 w-4 cursor-nesw-resize" },
  { name: "sw", edges: { bottom: true, left: true }, className: "bottom-0 left-0 h-4 w-4 cursor-nesw-resize" },
  { name: "se", edges: { bottom: true, right: true }, className: "bottom-0 right-0 h-4 w-4 cursor-nwse-resize" },
];

/** What in a header is pressed for itself, and so does not carry the window. */
const PRESSABLE = "button, a, input, textarea, select, [role='combobox'], [role='listbox'], [role='option']";

/** The size of the layer the windows float in, kept as it changes. */
function useArea(layer: RefObject<HTMLDivElement | null>): Area | null {
  const [area, setArea] = useState<Area | null>(null);
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const measure = () => setArea({ w: element.clientWidth, h: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [layer]);
  return area;
}

/** Follows the pointer from a press until it is let go, wherever it travels meanwhile. */
function follow(event: ReactPointerEvent<HTMLElement>, onMove: (dx: number, dy: number) => void, onEnd: () => void): void {
  const target = event.currentTarget;
  const { clientX, clientY, pointerId } = event;
  target.setPointerCapture?.(pointerId);
  const move = (e: PointerEvent) => onMove(e.clientX - clientX, e.clientY - clientY);
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    onEnd();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

function FloatingChat({ win, area, shelf }: { win: TeamChatWindow; area: Area; shelf: boolean }) {
  const l = useL();
  const stored = useTeamChatWindowStore((s) => s.rect);
  const maximized = useTeamChatWindowStore((s) => s.maximized);
  const teamName = useTeamChatStore((s) => s.states[win.chatId]?.chat.teamName);
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
  const controls = (
    <>
      <button
        type="button"
        onClick={() => minimize(win.key)}
        title={l("Minimizar: queda abajo y avisa cuando el equipo termine", "Minimise: it stays at the bottom and tells you when the team is done")}
        aria-label={l("Minimizar el chat del equipo", "Minimise the team chat")}
        className={iconButtonClass({ size: "sm" })}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={toggleMaximized}
        title={maximized ? l("Volver al tamaño anterior", "Back to the previous size") : l("Maximizar", "Maximise")}
        aria-label={maximized ? l("Volver al tamaño anterior", "Back to the previous size") : l("Maximizar el chat del equipo", "Maximise the team chat")}
        className={iconButtonClass({ size: "sm" })}
      >
        {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      </button>
    </>
  );

  return (
    <motion.section
      role="dialog"
      aria-label={teamName ? l(`Chat del equipo ${teamName}`, `Chat of the team ${teamName}`) : l("Chat del equipo", "Team chat")}
      data-team-chat-window={win.chatId}
      initial={{ opacity: 0, scale: 0.96, y: 14 }}
      animate={win.minimized ? { opacity: 0, scale: 0.9, y: 36 } : { opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 14 }}
      transition={SOFT}
      inert={win.minimized}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, transformOrigin: "bottom right" }}
      className={`absolute flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border-strong)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)] ${parked ? "hidden" : "flex"} ${win.minimized ? "pointer-events-none" : "pointer-events-auto"} ${live ? "select-none" : ""}`}
    >
      <TeamChatContent
        key={win.chatId}
        chatId={win.chatId}
        shown={!win.minimized}
        onClose={() => close(win.key)}
        controls={controls}
        grip={{
          onPointerDown: (event) => {
            if ((event.target as HTMLElement).closest(PRESSABLE)) return;
            reshape(event, (start, dx, dy) => moveRect(start, dx, dy, area));
          },
          onDoubleClick: (event) => {
            if (!(event.target as HTMLElement).closest(PRESSABLE)) toggleMaximized();
          },
        }}
      />
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

/** A folded window: which team, what it is doing, and whether it has something to be read. */
function Chip({ win }: { win: TeamChatWindow }) {
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
        title={l(`Abrir el chat con ${name}`, `Open the chat with ${name}`)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-[13px] py-1 pl-2 pr-1 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--cf-accent-line)]"
      >
        <TeamAvatar size={28} state={busy ? "thinking" : "idle"} />
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
        title={busy ? l("Cerrar: el equipo sigue trabajando y avisa al terminar", "Close: the team keeps working and tells you when it is done") : l("Cerrar", "Close")}
        aria-label={l(`Cerrar el chat con ${name}`, `Close the chat with ${name}`)}
        className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--cf-text-muted)] opacity-0 outline-none hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

/** The layer over a view's content where its team chats float, and the shelf they fold down to. */
export function TeamChatWindows() {
  const l = useL();
  const layer = useRef<HTMLDivElement>(null);
  const area = useArea(layer);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const windows = useTeamChatWindowStore((s) => s.windows);
  const states = useTeamChatStore((s) => s.states);
  // A window belongs to its conversation's workspace; one still being read is shown meanwhile.
  const here = windows.filter((w) => {
    const state = states[w.chatId];
    return !state || state.chat.workspaceId === workspaceId;
  });
  const folded = here.filter((w) => w.minimized);

  // A chip names its team and says what it is doing: read each folded conversation once.
  useEffect(() => {
    for (const w of folded) if (!useTeamChatStore.getState().states[w.chatId]) void useTeamChatStore.getState().refresh(w.chatId);
  }, [folded.map((w) => w.chatId).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-[40] overflow-hidden">
      {/* The shelf first, so a window carried over it covers it rather than being covered. */}
      <div role="group" aria-label={l("Chats de equipo minimizados", "Minimised team chats")} className="absolute bottom-2.5 right-3 flex max-w-[calc(100%-24px)] flex-row-reverse flex-wrap-reverse items-end gap-2">
        <AnimatePresence initial={false}>
          {folded.map((w) => <Chip key={w.key} win={w} />)}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {area && here.map((w) => <FloatingChat key={w.key} win={w} area={area} shelf={folded.length > 0} />)}
      </AnimatePresence>
    </div>
  );
}
