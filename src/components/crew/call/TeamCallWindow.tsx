/**
 * The call with a team as a window of its own over whichever view is on screen: carried by its header,
 * grown from its sides, filling the view or folded down to a chip on the shelf the team chats
 * fold to — where it goes on saying who is speaking, since a call does not stop for being out of
 * sight.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "framer-motion";
import { AudioLines, Maximize2, Minimize2, Minus, PhoneOff, X } from "lucide-react";
import { centerRect, fitRect, maximizedRect, moveRect, resizeRect, type Area, type Rect } from "../../../lib/floatingRect";
import { callOngoing, useTeamCallStore } from "../../../state/teamCallStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { iconButtonClass } from "../../common/Button";
import { SOFT } from "../kit/ui";
import { useL } from "../state";
import { follow, HANDLES, PRESSABLE } from "../kit/floating";
import { CallRoom, useCallClock } from "./CallRoom";

/** The call of the workspace on screen, if one is drawn here. */
function useCallHere() {
  const call = useTeamCallStore((s) => s.call);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return call && call.workspaceId === workspaceId ? call : null;
}

export function TeamCallWindow({ area, shelf }: { area: Area; shelf: boolean }) {
  const l = useL();
  const call = useCallHere();
  const stored = useTeamCallStore((s) => s.rect);
  const maximized = useTeamCallStore((s) => s.maximized);
  const minimized = useTeamCallStore((s) => s.minimized);
  const [live, setLive] = useState<Rect | null>(null);
  const latest = useRef<Rect | null>(null);
  /** Folded and done folding: out of the layout, so nothing of it can be pressed or tabbed into. */
  const [parked, setParked] = useState(minimized);
  useEffect(() => {
    if (!minimized) {
      setParked(false);
      return;
    }
    const timer = window.setTimeout(() => setParked(true), 360);
    return () => window.clearTimeout(timer);
  }, [minimized]);
  if (!call) return null;

  const resting = fitRect(stored ?? centerRect(area, 880, 760), area);
  const rect = maximized ? maximizedRect(area, shelf) : (live ?? resting);
  const { minimize, toggleMaximized, close, place } = useTeamCallStore.getState();
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
        if (latest.current) place(latest.current);
        latest.current = null;
        setLive(null);
      },
    );
  };
  const controls = (
    <>
      <button type="button" onClick={minimize} title={l("Minimizar: la llamada sigue y queda abajo", "Minimise: the call goes on and stays at the bottom")} aria-label={l("Minimizar la llamada", "Minimise the call")} className={iconButtonClass({ size: "sm" })}>
        <Minus className="h-4 w-4" />
      </button>
      <button type="button" onClick={toggleMaximized} title={maximized ? l("Volver al tamaño anterior", "Back to the previous size") : l("Maximizar", "Maximise")} aria-label={maximized ? l("Volver al tamaño anterior", "Back to the previous size") : l("Maximizar la llamada", "Maximise the call")} className={iconButtonClass({ size: "sm" })}>
        {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      </button>
    </>
  );
  return (
    <motion.section
      role="dialog"
      aria-label={l(`Llamada con el equipo ${call.teamName}`, `Call with the team ${call.teamName}`)}
      data-team-call-window={call.id}
      tabIndex={-1}
      initial={{ opacity: 0, scale: 0.94, y: 18 }}
      animate={minimized ? { opacity: 0, scale: 0.9, y: 36 } : { opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 14 }}
      transition={SOFT}
      inert={minimized}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, transformOrigin: "bottom right" }}
      className={`absolute flex-col overflow-hidden rounded-[16px] border border-[var(--cf-border-strong)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)] outline-none ${parked ? "hidden" : "flex"} ${minimized ? "pointer-events-none" : "pointer-events-auto"} ${live ? "select-none" : ""}`}
    >
      <CallRoom
        call={call}
        shown={!minimized}
        controls={controls}
        onClose={() => void close()}
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
        <div key={handle.name} aria-hidden onPointerDown={(event) => reshape(event, (start, dx, dy) => resizeRect(start, handle.edges, dx, dy, area))} className={`absolute touch-none ${handle.className}`} />
      ))}
    </motion.section>
  );
}

/** Whether a call folded to the shelf is there to be drawn. */
export function useCallFolded(): boolean {
  const call = useCallHere();
  const minimized = useTeamCallStore((s) => s.minimized);
  return !!call && minimized;
}

/** The call, folded: which team, how long, and who is speaking now. */
export function TeamCallChip() {
  const l = useL();
  const call = useCallHere();
  const minimized = useTeamCallStore((s) => s.minimized);
  if (!call || !minimized) return null;
  return <Chip call={call} l={l} />;
}

function Chip({ call, l }: { call: NonNullable<ReturnType<typeof useCallHere>>; l: (es: string, en: string) => string }) {
  const time = useCallClock(call);
  const speaker = call.seats.find((seat) => seat.state === "speaking");
  const ongoing = callOngoing(call);
  const status = call.phase === "live"
    ? speaker ? l(`Habla ${speaker.name}`, `${speaker.name} is speaking`) : call.hearing ? l("Te escucha", "Listening to you") : l(`En llamada · ${time}`, `On the call · ${time}`)
    : call.phase === "closing" ? l("Escribiendo el acta…", "Writing the minutes…")
    : call.phase === "countdown" ? l("El equipo está por empezar", "The team is about to start")
    : call.phase === "starting" ? l("Poniéndose en marcha…", "Getting started…")
    : call.phase === "started" ? l("El equipo está trabajando", "The team is working")
    : l("Llamada terminada", "Call ended");
  const tone = call.phase === "live" ? "var(--cf-success)" : call.phase === "ended" ? "var(--cf-text-muted)" : "var(--cf-accent)";
  const { restore, hangUp, close } = useTeamCallStore.getState();
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.94 }}
      transition={SOFT}
      className="group pointer-events-auto flex h-[46px] max-w-[280px] items-center rounded-[14px] border bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
      style={{ borderColor: tone, background: `color-mix(in oklab, ${tone} 7%, var(--cf-surface))` }}
    >
      <button type="button" onClick={restore} title={l(`Volver a la llamada con ${call.teamName}`, `Back to the call with ${call.teamName}`)} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-[13px] py-1 pl-2 pr-1 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--cf-accent-line)]">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px]" style={{ color: tone, background: `color-mix(in oklab, ${tone} 16%, var(--cf-surface))` }}>
          <AudioLines className={`h-3.5 w-3.5 ${speaker ? "animate-pulse" : ""}`} />
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[12.5px] leading-tight">{call.teamName}</b>
          <span role="status" className="block truncate text-[11px] font-medium leading-tight" style={{ color: tone }}>{status}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => (call.phase === "live" ? hangUp() : void close())}
        disabled={ongoing && call.phase !== "live"}
        title={call.phase === "live" ? l("Colgar", "Hang up") : l("Cerrar", "Close")}
        aria-label={call.phase === "live" ? l("Colgar la llamada", "Hang up the call") : l("Cerrar la llamada", "Close the call")}
        className={`mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md outline-none focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] disabled:opacity-0 ${call.phase === "live" ? "text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_14%,transparent)]" : "text-[var(--cf-text-muted)] opacity-0 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover:opacity-100"}`}
      >
        {call.phase === "live" ? <PhoneOff className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
      </button>
    </motion.div>
  );
}
