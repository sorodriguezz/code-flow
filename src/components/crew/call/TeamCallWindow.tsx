/**
 * The call with a team, folded: the chip it leaves on the main window's shelf — beside the chats'
 * — where it goes on saying who is speaking, since a call does not stop for being out of sight.
 * The call itself is drawn in a window of its own (`float/FloatWindow`).
 */
import { motion } from "framer-motion";
import { AudioLines, PhoneOff, X } from "lucide-react";
import { callOngoing, useTeamCallStore } from "../../../state/teamCallStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { SOFT } from "../kit/ui";
import { useL } from "../state";
import { useCallClock } from "./CallRoom";

/** The call of the workspace on screen, if there is one. */
function useCallHere() {
  const call = useTeamCallStore((s) => s.call);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  return call && call.workspaceId === workspaceId ? call : null;
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
  const hands = call.seats.filter((seat) => seat.hand > 0).length;
  const status = call.phase === "live"
    ? speaker ? l(`Habla ${speaker.name}`, `${speaker.name} is speaking`)
      : hands > 0 ? (hands === 1 ? l("1 pide la palabra", "1 wants the word") : l(`${hands} piden la palabra`, `${hands} want the word`))
      : call.hearing ? l("Te escucha", "Listening to you") : l(`En llamada · ${time}`, `On the call · ${time}`)
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
