/**
 * The room of a call with a team: who is in it and what each is doing, what is being said, and
 * the few things a call is controlled with.
 *
 * Laid out as a call is: whoever leads the team large on one side, everybody else — the user
 * first — in a mosaic beside it. Where a face would be, each agent shows the mark of the provider
 * it answers with, so whose model is speaking is seen at a glance; whoever speaks is framed in
 * green. A participant waiting for the word shows its hand, numbered by who asked first, and the
 * user gives the word by pressing it. Under them the conversation is written as it is said. When
 * the call ends the same room shows what was agreed and the team starting on it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { AudioLines, Captions, CaptionsOff, Check, ChevronUp, Copy, Hand, Headphones, Loader2, MessageSquareText, Mic, MicOff, MoreHorizontal, PhoneOff, Search, SendHorizontal, User, Users, X } from "lucide-react";
import type { CallLine, CallSeat, CallState } from "../../../lib/tauri/teamCallCommands";
import { voiceLevel } from "../../../lib/thinking/voice";
import { agentColorVar } from "../../../lib/agents/agentColors";
import { scrollBehavior } from "../../../lib/motion";
import { dictationInputs, type MicInput } from "../../../lib/tauri/dictationCommands";
import { micOptions } from "../../../lib/dictation/micOptions";
import { offerMicSettings, useDictationStore } from "../../../state/dictationStore";
import { useT } from "../../../state/languageStore";
import { ensureSpeechEvents, useSpeechStore } from "../../../state/speechStore";
import { callMicLevel, useTeamCallStore } from "../../../state/teamCallStore";
import { useToastStore } from "../../../state/toastStore";
import { iconButtonClass } from "../../common/Button";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { AgentAvatar, type AgentState } from "../kit/Avatar";
import { Btn, Seg } from "../kit/ui";
import { shortModel } from "../kit/modelName";
import { useAgentStates, useL } from "../state";
import { CallWrapUp } from "./CallWrapUp";
import { VoiceBars } from "./VoiceBars";

type L = (es: string, en: string) => string;

/** `mm:ss` since `from`, or frozen at `until` once the call stopped being live. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How long the call has been going, re-read every second while it is live. */
export function useCallClock(call: CallState): string {
  const [now, setNow] = useState(() => Date.now());
  const live = call.phase === "live";
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return clock(now - call.startedAtMs);
}

/** What a seat is doing, in words, and whether it is the thing to look at. */
export function seatStatus(seat: CallSeat, working: boolean, l: L): { label: string; tone: "speaking" | "busy" | "rest" } {
  switch (seat.state) {
    case "speaking": return { label: l("Hablando", "Speaking"), tone: "speaking" };
    case "thinking": return { label: l("Pensando", "Thinking"), tone: "busy" };
    // Short enough to be read whole on a small tile; the transcript says what it is reading.
    case "looking": return { label: l("Revisa el código", "Reading the code"), tone: "busy" };
    case "hand": return { label: l("Pide la palabra", "Has something to say"), tone: "busy" };
    default: return working ? { label: l("Trabajando", "Working"), tone: "busy" } : { label: l("Escuchando", "Listening"), tone: "rest" };
  }
}

/** What an agent answers with, in words: for the tooltip of the line that shows it short. */
export function engineTitle(seat: CallSeat, l: L): string {
  const account = seat.account || l("la del sistema", "the system's");
  const talks = seat.model || l("el modelo por defecto", "the default model");
  const works = seat.ownModel || l("el modelo por defecto", "the default model");
  return seat.model === seat.ownModel
    ? l(`Responde y trabaja con ${talks} · Cuenta: ${account}`, `Answers and works with ${talks} · Account: ${account}`)
    : l(`En la llamada responde con ${talks}; para revisar el código y trabajar usa ${works} · Cuenta: ${account}`, `On the call it answers with ${talks}; to look at the code and to work it uses ${works} · Account: ${account}`);
}

export { shortModel };

/** What a participant's state is drawn with: the colour of its dot and of its words. */
function stateTone(seat: CallSeat, working: boolean): string {
  if (seat.state === "speaking") return "var(--cf-success)";
  if (seat.state === "hand") return "var(--cf-warning)";
  if (seat.state === "thinking" || seat.state === "looking" || working) return "var(--cf-accent)";
  return "color-mix(in oklab, var(--cf-success) 55%, var(--cf-text-faint))";
}

/** The line of a tile that says what its participant is doing: a dot and a word. */
function StateLine({ label, tone, strong, pulse }: { label: string; tone: string; strong: boolean; pulse: boolean }) {
  return (
    <span role="status" className={`flex min-w-0 items-center gap-1 text-[10.5px] leading-tight ${strong ? "font-medium" : "text-[var(--cf-text-muted)]"}`} style={strong ? { color: tone } : undefined}>
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${pulse ? "animate-pulse" : ""}`} style={{ background: tone }} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

/**
 * The hand of a participant that is waiting for the word: pressing it gives it. With more than one
 * waiting it carries its place in line — whoever finished thinking first is 1.
 */
function HandButton({ seat, waiting, l, large = false }: { seat: CallSeat; waiting: number; l: L; large?: boolean }) {
  const label = waiting > 1
    ? l(`Dar la palabra a ${seat.name} (${seat.hand}.º en pedirla)`, `Give the word to ${seat.name} (number ${seat.hand} in line)`)
    : l(`Dar la palabra a ${seat.name}`, `Give the word to ${seat.name}`);
  return (
    <button
      type="button"
      onClick={() => useTeamCallStore.getState().grant(seat.memberId)}
      title={label}
      aria-label={label}
      className={`flex shrink-0 items-center gap-1 rounded-full bg-[var(--cf-warning)] font-semibold text-black shadow-[0_2px_8px_-2px_color-mix(in_oklab,var(--cf-warning)_70%,transparent)] outline-none transition-transform duration-100 hover:scale-105 focus-visible:shadow-[0_0_0_3px_var(--cf-accent-line)] active:scale-95 ${large ? "h-7 px-2.5 text-[12px]" : "h-6 px-1.5 text-[11px]"}`}
    >
      <Hand className={large ? "h-4 w-4" : "h-3.5 w-3.5"} />
      {waiting > 1 && <span className="tabular-nums">{seat.hand}</span>}
      {large && <span>{l("Pide la palabra", "Wants the word")}</span>}
    </button>
  );
}

/** What can be done with one participant: give it the word, lower its hand, speak to it. */
function SeatMenu({ seat, onAddress, className = "" }: { seat: CallSeat; onAddress: (name: string) => void; className?: string }) {
  const l = useL();
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const { grant, lower } = useTeamCallStore.getState();
  const items: MenuItem[] = [
    ...(seat.hand > 0
      ? [
          { label: l("Dar la palabra", "Give the word"), icon: Hand, onClick: () => grant(seat.memberId) },
          { label: l("Bajar la mano", "Lower the hand"), icon: X, onClick: () => lower(seat.memberId) },
        ]
      : []),
    { label: l(`Hablarle a ${seat.name}`, `Speak to ${seat.name}`), icon: MessageSquareText, onClick: () => onAddress(seat.name), separated: seat.hand > 0 },
  ];
  const label = l(`Opciones de ${seat.name}`, `Options for ${seat.name}`);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={label}
        title={label}
        onClick={() => setAnchor(anchor ? null : (button.current?.getBoundingClientRect() ?? null))}
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-md text-[var(--cf-text-muted)] outline-none transition-opacity hover:bg-[color-mix(in_oklab,var(--cf-text)_12%,transparent)] hover:text-[var(--cf-text)] focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] ${anchor ? "opacity-100" : "opacity-60 group-hover:opacity-100"} ${className}`}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {anchor && (
        <ContextMenu
          x={anchor.left}
          y={anchor.bottom}
          anchor={{ top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right, align: "end" }}
          heading={seat.name}
          items={items}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

/**
 * A participant's name on one line, whatever its length: every tile keeps the same shape. A short
 * last word is what tells two of a kind apart — «Backend senior A» from «Backend senior B» — so it
 * is the middle that gives way, never the end.
 */
function SeatName({ name, className = "" }: { name: string; className?: string }) {
  const cut = name.trimEnd().lastIndexOf(" ");
  const tail = cut > 0 ? name.slice(cut + 1).trim() : "";
  if (!tail || tail.length > 3) return <b className={`block truncate ${className}`}>{name}</b>;
  return (
    <b className={`flex min-w-0 ${className}`}>
      <span className="min-w-0 truncate">{name.slice(0, cut)}</span>
      <span className="shrink-0 whitespace-pre"> {tail}</span>
    </b>
  );
}

/**
 * The voice of whoever is speaking, over its picture: the picture steps back (`steppedBack`)
 * and the wave is what the tile shows, instead of one more thing on top of the rest.
 */
function VoiceOver({ speaking, level, size }: { speaking: boolean; level: () => number; size?: "md" | "lg" }) {
  return (
    <span aria-hidden className={`pointer-events-none absolute inset-0 grid place-items-center transition-opacity duration-200 ${speaking ? "opacity-100" : "opacity-0"}`}>
      <VoiceBars level={level} active={speaking} color="var(--cf-success)" size={size} />
    </span>
  );
}

/** What a picture does while its participant speaks: out of focus and faint, behind the wave. */
const STEPS_BACK = "transition-[filter,opacity,transform] duration-300";
const steppedBack = (speaking: boolean) => `${STEPS_BACK} ${speaking ? "scale-90 opacity-25 blur-[3px]" : ""}`;

/**
 * Who has come into the conversation, in the order they did: whoever said something, and whoever
 * is doing something now — thinking, looking at the code, waiting for the word. The room shows a
 * tile for each of these and not for a team of sixteen that has not been spoken to; everyone is in
 * «Participantes». Once in, a participant stays: a tile that came is not taken away.
 */
export function enteredSeats(before: readonly string[], seats: readonly CallSeat[], lines: readonly CallLine[]): string[] {
  const known = new Set(seats.map((seat) => seat.memberId));
  const entered = before.filter((id) => known.has(id));
  const enter = (id: string) => {
    if (known.has(id) && !entered.includes(id)) entered.push(id);
  };
  for (const line of lines) if (line.kind === "say") enter(line.who);
  for (const seat of seats) if (seat.state !== "listening" || seat.hand > 0) enter(seat.memberId);
  return entered;
}

/** The frame of whoever is speaking: the room's green, the one thing that says «this one» at a glance. */
const speakingFrame = { borderColor: "var(--cf-success)", boxShadow: "0 0 0 1px var(--cf-success), 0 10px 26px -16px var(--cf-success)" };

/**
 * A participant, small: where a face would be, the mark of the provider it answers with — whose
 * model is speaking is seen without reading — and under it who it is and what it is doing.
 */
function SeatTile({ seat, waiting, working, speaking, level, l, onAddress }: {
  seat: CallSeat;
  /** How many participants are waiting for the word. */
  waiting: number;
  working: boolean;
  speaking: boolean;
  level: () => number;
  l: L;
  onAddress: (name: string) => void;
}) {
  const color = agentColorVar(seat.color, seat.agentId);
  const status = seatStatus(seat, working, l);
  const tone = stateTone(seat, working);
  const state: AgentState = seat.state === "thinking" || seat.state === "looking" || (seat.state === "listening" && working) ? "thinking" : seat.state === "hand" ? "waiting" : "idle";
  // A small tile has room for a word or two: the hand on it and the transcript say the rest.
  const short = seat.state === "hand" ? l("Mano alzada", "Hand up") : seat.state === "looking" ? l("En el código", "In the code") : status.label;
  return (
    <div
      title={[seat.name, seat.role, status.label, seat.voiceLabel ? l(`Voz: ${seat.voiceLabel}`, `Voice: ${seat.voiceLabel}`) : "", engineTitle(seat, l), seat.note].filter(Boolean).join(" · ")}
      className="group relative flex min-h-[80px] min-w-0 flex-col overflow-hidden rounded-xl border bg-[var(--cf-surface)] transition-[border-color,box-shadow] duration-200"
      style={speaking ? speakingFrame : seat.hand > 0 ? { borderColor: "var(--cf-warning)" } : { borderColor: "var(--cf-border)" }}
    >
      <div className="relative grid min-h-[24px] flex-1 place-items-center" style={{ background: `color-mix(in oklab, ${color} ${speaking ? 16 : 9}%, var(--cf-sunken))` }}>
        <span className={`grid aspect-square h-[46%] max-h-[56px] min-h-[20px] place-items-center ${steppedBack(speaking)}`}>
          <ProviderGlyph providerId={seat.provider} size={22} className={`h-full w-full ${seat.state !== "listening" ? "" : "opacity-80"}`} />
        </span>
        <VoiceOver speaking={speaking} level={level} />
        {seat.hand > 0 && <span className="absolute left-1.5 top-1.5"><HandButton seat={seat} waiting={waiting} l={l} /></span>}
        <SeatMenu seat={seat} onAddress={onAddress} className="absolute right-1 top-1" />
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-[var(--cf-border)] py-1.5 pl-1.5 pr-1">
        <AgentAvatar agent={{ id: seat.agentId, icon: seat.icon, color: seat.color }} size={20} state={state} />
        <span className="min-w-0 flex-1">
          <SeatName name={seat.name} className="text-[11px] leading-tight tracking-[-0.01em]" />
          <StateLine label={short} tone={tone} strong={status.tone !== "rest"} pulse={status.tone === "busy"} />
        </span>
      </div>
    </div>
  );
}

/** The user's own tile: no provider behind it, a microphone that is open or not. */
function YouTile({ call, status, level, l }: { call: CallState; status: string; level: () => number; l: L }) {
  const speaking = call.phase === "live" && call.hearing;
  return (
    <div
      title={l(`Tú · Diriges el equipo y das la palabra · ${call.mic ? "Micrófono activo" : "Micrófono apagado"}`, `You · You lead the team and give the word · ${call.mic ? "Microphone on" : "Microphone off"}`)}
      className="relative flex min-h-[80px] min-w-0 flex-col overflow-hidden rounded-xl border bg-[var(--cf-surface)] transition-[border-color,box-shadow] duration-200"
      style={speaking ? speakingFrame : { borderColor: "var(--cf-border)" }}
    >
      <div className="relative grid min-h-[24px] flex-1 place-items-center" style={{ background: `color-mix(in oklab, var(--cf-accent) ${speaking ? 16 : 8}%, var(--cf-sunken))` }}>
        <User className={`h-[46%] max-h-[56px] min-h-[20px] w-auto text-[var(--cf-text-muted)] ${steppedBack(speaking)}`} />
        <VoiceOver speaking={speaking} level={level} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-[var(--cf-border)] px-1.5 py-1.5">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-[6px] bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]">
          {call.mic ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[11.5px] leading-tight">{l("Tú", "You")}</b>
          <StateLine label={status} tone={speaking ? "var(--cf-success)" : "var(--cf-text-faint)"} strong={speaking} pulse={false} />
        </span>
      </div>
    </div>
  );
}

/**
 * Whoever leads the team, large: the one the room is arranged around. Its provider's mark where a
 * face would be, what it is doing over it, and under it who it is. What it says is the transcript's.
 */
function LeadTile({ seat, waiting, working, speaking, level, l, onAddress }: {
  seat: CallSeat;
  waiting: number;
  working: boolean;
  speaking: boolean;
  level: () => number;
  l: L;
  onAddress: (name: string) => void;
}) {
  const color = agentColorVar(seat.color, seat.agentId);
  const status = seatStatus(seat, working, l);
  const tone = stateTone(seat, working);
  const state: AgentState = seat.state === "thinking" || seat.state === "looking" || (seat.state === "listening" && working) ? "thinking" : seat.state === "hand" ? "waiting" : "idle";
  return (
    <div
      className="group relative flex min-h-[132px] min-w-0 flex-col overflow-hidden rounded-2xl border bg-[var(--cf-surface)] transition-[border-color,box-shadow] duration-200 @[640px]:min-h-[190px]"
      style={speaking ? speakingFrame : seat.hand > 0 ? { borderColor: "var(--cf-warning)" } : { borderColor: "var(--cf-border)" }}
    >
      <div
        className="relative grid min-h-[72px] flex-1 place-items-center"
        style={{ background: `radial-gradient(120% 90% at 50% 35%, color-mix(in oklab, ${color} ${speaking ? 24 : 15}%, var(--cf-sunken)), color-mix(in oklab, ${color} 5%, var(--cf-sunken)))` }}
      >
        <span
          className={`grid aspect-square h-[62%] max-h-[132px] min-h-[44px] place-items-center rounded-[28%] @[640px]:h-[38%] @[640px]:min-h-[64px] ${steppedBack(speaking)}`}
          style={{ background: "color-mix(in oklab, var(--cf-surface-solid, var(--cf-surface)) 70%, transparent)", boxShadow: `0 0 0 1px color-mix(in oklab, ${color} 30%, transparent), 0 18px 40px -22px ${color}` }}
        >
          <ProviderGlyph providerId={seat.provider} size={56} className="h-[56%] w-[56%]" />
        </span>
        <VoiceOver speaking={speaking} level={level} size="lg" />
        <span className="absolute left-2.5 top-2.5 flex max-w-[calc(100%-44px)] flex-wrap items-center gap-1.5">
          {seat.hand === 0 && <span
            role="status"
            className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium backdrop-blur-sm"
            style={{ color: status.tone === "rest" ? "var(--cf-text-muted)" : tone, background: "color-mix(in oklab, var(--cf-surface-solid, var(--cf-surface)) 82%, transparent)", boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${status.tone === "rest" ? "var(--cf-border-strong)" : tone} 60%, transparent)` }}
          >
            {speaking ? <AudioLines className="h-3.5 w-3.5 shrink-0 animate-pulse" /> : <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.tone === "busy" ? "animate-pulse" : ""}`} style={{ background: tone }} />}
            <span className="truncate">{status.label}</span>
          </span>}
          {seat.hand > 0 && <HandButton seat={seat} waiting={waiting} l={l} large />}
        </span>
        <SeatMenu seat={seat} onAddress={onAddress} className="absolute right-2 top-2.5 !h-6 !w-6" />
      </div>
      <div className="shrink-0 border-t border-[var(--cf-border)] px-3 pb-3 pt-2.5">
        <div className="flex items-center gap-2.5">
          <AgentAvatar agent={{ id: seat.agentId, icon: seat.icon, color: seat.color }} size={32} state={state} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <b className="truncate text-[14px] leading-tight">{seat.name}</b>
              <span className="shrink-0 rounded-full bg-[var(--cf-sunken)] px-1.5 py-px text-[10px] font-medium text-[var(--cf-text-muted)]">{l("Lidera", "Lead")}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1 text-[11.5px] leading-tight text-[var(--cf-text-muted)]" title={engineTitle(seat, l)}>
              <ProviderGlyph providerId={seat.provider} size={11} />
              <span className="min-w-0 truncate">{[shortModel(seat.model) || seat.provider, seat.account, seat.role].filter(Boolean).join(" · ")}</span>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Who is waiting for the word, in the order they asked: pressed, each one speaks. */
function HandsRow({ seats, l }: { seats: CallSeat[]; l: L }) {
  const waiting = seats.filter((seat) => seat.hand > 0).sort((a, b) => a.hand - b.hand);
  if (waiting.length === 0) return null;
  const { grant, lower } = useTeamCallStore.getState();
  return (
    <div role="group" aria-label={l("Piden la palabra", "Waiting for the word")} className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-xl border border-[color-mix(in_oklab,var(--cf-warning)_45%,var(--cf-border))] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))] px-2.5 py-1.5">
      <span className="flex items-center gap-1.5 pr-1 text-[11.5px] font-medium">
        <Hand className="h-3.5 w-3.5 text-[var(--cf-warning)]" />
        {waiting.length === 1 ? l("Pide la palabra", "Wants the word") : l("Piden la palabra", "Want the word")}
      </span>
      {waiting.map((seat) => (
        <span key={seat.memberId} className="flex h-7 items-center rounded-full border border-[var(--cf-border-strong)] bg-[var(--cf-surface)] pl-0.5 pr-0.5">
          <button type="button" onClick={() => grant(seat.memberId)} title={l(`Dar la palabra a ${seat.name}`, `Give the word to ${seat.name}`)} className="flex h-6 items-center gap-1.5 rounded-full pl-1 pr-2 text-[12px] outline-none hover:bg-[var(--cf-hover)] focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)]">
            {waiting.length > 1 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[var(--cf-warning)] px-1 text-[10.5px] font-bold tabular-nums text-black">{seat.hand}</span>}
            <AgentAvatar agent={{ id: seat.agentId, icon: seat.icon, color: seat.color }} size={18} />
            <b className="font-medium">{seat.name}</b>
          </button>
          <button type="button" onClick={() => lower(seat.memberId)} title={l(`Bajar la mano de ${seat.name}`, `Lower ${seat.name}'s hand`)} aria-label={l(`Bajar la mano de ${seat.name}`, `Lower ${seat.name}'s hand`)} className="grid h-5 w-5 place-items-center rounded-full text-[var(--cf-text-muted)] outline-none hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)]">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <span className="ml-auto hidden text-[11px] text-[var(--cf-text-muted)] @[620px]:inline">{l("Tú das la palabra: pulsa a quien quieras oír, o dilo — «adelante, QA».", "You give the word: press whoever you want to hear, or say it — “go ahead, QA”.")}</span>
    </div>
  );
}

/** The conversation, written as it is said, with whoever is on their way to say something. */
function Transcript({ call, lines, query }: { call: CallState; lines: CallLine[]; query: string }) {
  const l = useL();
  const scroll = useRef<HTMLDivElement>(null);
  const seats = useMemo(() => new Map(call.seats.map((seat) => [seat.memberId, seat])), [call.seats]);
  const pending = call.seats.filter((seat) => seat.state === "thinking" || seat.state === "looking");
  const speaker = call.seats.find((seat) => seat.state === "speaking");
  const last = lines[lines.length - 1];
  const wanted = query.trim().toLocaleLowerCase();
  const found = wanted ? lines.filter((line) => line.kind === "say" && `${line.who === "user" ? l("Tú", "You") : line.name} ${line.text}`.toLocaleLowerCase().includes(wanted)) : lines;
  /** The line being said now: the last one of whoever is speaking. */
  const saying = speaker ? [...lines].reverse().find((line) => line.who === speaker.memberId && line.kind === "say")?.id : undefined;
  useEffect(() => {
    if (wanted) return;
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: scrollBehavior() });
  }, [lines.length, last?.text, pending.length, wanted]);
  return (
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-2 py-2" role="log" aria-live="polite" aria-label={l("Transcripción en directo", "Live transcript")}>
      {lines.length === 0 && <p className="px-2 py-1 text-[12.5px] text-[var(--cf-text-muted)]">{l("Lo que se diga aparece aquí.", "What is said shows up here.")}</p>}
      {wanted && found.length === 0 && lines.length > 0 && <p className="px-2 py-1 text-[12.5px] text-[var(--cf-text-muted)]">{l("Nadie dijo eso en esta llamada.", "Nobody said that on this call.")}</p>}
      <ul className="space-y-0.5">
        {found.map((line) => {
          if (line.kind === "note") return <li key={line.id} className="px-2 py-1 pl-[58px] text-[12px] italic text-[var(--cf-text-muted)]">{line.text}</li>;
          const seat = seats.get(line.who);
          const mine = line.who === "user";
          const now = line.id === saying;
          return (
            <li key={line.id} className={`flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-[13px] leading-relaxed ${now ? "bg-[color-mix(in_oklab,var(--cf-accent)_7%,transparent)]" : ""}`}>
              <span className="w-9 shrink-0 pt-px text-[11.5px] tabular-nums text-[var(--cf-text-muted)]">{clock(line.atMs)}</span>
              {mine || !seat
                ? <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-[6px] bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]"><User className="h-3 w-3" /></span>
                : <AgentAvatar agent={{ id: seat.agentId, icon: seat.icon, color: seat.color }} size={20} className="mt-px" />}
              <span className="flex w-[92px] shrink-0 items-center gap-1 @[640px]:w-[128px]">
                {!mine && seat && <ProviderGlyph providerId={seat.provider} size={11} />}
                <b className="min-w-0 truncate font-semibold">{mine ? l("Tú", "You") : line.name}</b>
              </span>
              <span className="min-w-0 flex-1">
                {line.text}
                {line.partial && <span aria-hidden className="ml-0.5 inline-block h-3 w-[2px] translate-y-[2px] animate-pulse rounded-full bg-[var(--cf-text-muted)]" />}
              </span>
              {now && <AudioLines aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-pulse text-[var(--cf-accent)]" />}
            </li>
          );
        })}
        {!wanted && pending.map((seat) => (
          <li key={`pending-${seat.memberId}`} className="flex items-center gap-2 px-2 py-1 pl-[58px] text-[12.5px] text-[var(--cf-text-muted)]">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 truncate">
              {seat.state === "looking"
                ? l(`${seat.name} está consultando el código${seat.note ? `: ${seat.note}` : ""}…`, `${seat.name} is looking at the code${seat.note ? `: ${seat.note}` : ""}…`)
                : l(`${seat.name} está pensando…`, `${seat.name} is thinking…`)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Everybody on the call, a row each: who they are, what they answer with, and — for whoever is
 *  waiting for the word — the two things to do about it. */
function Participants({ call, working, l, onAddress }: { call: CallState; working: Map<string, AgentState>; l: L; onAddress: (name: string) => void }) {
  const { grant, lower } = useTeamCallStore.getState();
  // Whoever is waiting for the word first, in the order they asked; then as they sit.
  const seats = [...call.seats].sort((a, b) => (a.hand || 999) - (b.hand || 999));
  return (
    <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2" aria-label={l("Participantes", "Participants")}>
      {seats.map((seat) => {
        const busy = working.get(seat.agentId) === "thinking";
        const status = seatStatus(seat, busy, l);
        const tone = stateTone(seat, busy);
        return (
          <li key={seat.memberId} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--cf-hover)]">
            <AgentAvatar agent={{ id: seat.agentId, icon: seat.icon, color: seat.color }} size={28} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <b className="truncate text-[12.5px]">{seat.name}</b>
                {seat.lead && <span className="shrink-0 rounded-full bg-[var(--cf-sunken)] px-1.5 py-px text-[10px] font-medium text-[var(--cf-text-muted)]">{l("Lidera", "Lead")}</span>}
              </span>
              <span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--cf-text-muted)]" title={engineTitle(seat, l)}>
                <ProviderGlyph providerId={seat.provider} size={11} />
                <span className="min-w-0 truncate">{[shortModel(seat.model) || seat.provider, seat.account, seat.role, seat.voiceLabel ? l(`voz ${seat.voiceLabel}`, `voice ${seat.voiceLabel}`) : ""].filter(Boolean).join(" · ")}</span>
              </span>
            </span>
            {seat.hand > 0 ? (
              <span className="flex shrink-0 items-center gap-1">
                <Btn small kind="primary" icon={Hand} onClick={() => grant(seat.memberId)}>{l("Dar la palabra", "Give the word")}</Btn>
                <button type="button" onClick={() => lower(seat.memberId)} title={l("Bajar la mano", "Lower the hand")} aria-label={l(`Bajar la mano de ${seat.name}`, `Lower ${seat.name}'s hand`)} className={iconButtonClass({ size: "sm" })}><X className="h-3.5 w-3.5" /></button>
              </span>
            ) : (
              <span className="w-[112px] shrink-0"><StateLine label={status.label} tone={tone} strong={status.tone !== "rest"} pulse={status.tone === "busy"} /></span>
            )}
            <button type="button" onClick={() => onAddress(seat.name)} title={l(`Hablarle a ${seat.name}`, `Speak to ${seat.name}`)} aria-label={l(`Hablarle a ${seat.name}`, `Speak to ${seat.name}`)} className={iconButtonClass({ size: "sm" })}>
              <MessageSquareText className="h-3.5 w-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Why the microphone is not open, and the one thing that fixes it. */
function ListeningNotice({ call }: { call: CallState }) {
  const l = useL();
  const preparing = useTeamCallStore((s) => s.preparing);
  if (call.phase !== "live" || call.listening === "ready") return null;
  const text = call.listening === "missing" ? l("Para hablarle al equipo falta descargar el modelo que escucha. Mientras tanto puedes escribir.", "Talking to the team needs the listening model, which is not downloaded yet. Meanwhile you can type.")
    : call.listening === "denied" ? l("CodeFlow no tiene permiso para usar el micrófono. Mientras tanto puedes escribir.", "CodeFlow is not allowed to use the microphone. Meanwhile you can type.")
    : call.listening === "unsupported" ? l("En este sistema la llamada es por escrito: el equipo te responde con voz.", "On this system the call is typed: the team answers aloud.")
    : l(`El micrófono se detuvo${call.error ? `: ${call.error}` : ""}. Puedes escribir, o volver a abrirlo.`, `The microphone stopped${call.error ? `: ${call.error}` : ""}. You can type, or open it again.`);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface))] px-3 py-2 text-[12px]">
      <MicOff className="h-3.5 w-3.5 shrink-0 text-[var(--cf-warning)]" />
      <span className="min-w-0 flex-1">{text}</span>
      {call.listening === "missing" && <Btn small kind="primary" disabled={preparing} onClick={() => void useTeamCallStore.getState().prepare()}>{preparing ? l("Descargando…", "Downloading…") : l("Preparar la escucha", "Set up listening")}</Btn>}
      {call.listening === "denied" && <Btn small onClick={() => void offerMicSettings()}>{l("Abrir los ajustes", "Open settings")}</Btn>}
      {call.listening === "failed" && <Btn small onClick={() => void useTeamCallStore.getState().mic(true)}>{l("Abrir el micrófono", "Open the microphone")}</Btn>}
    </div>
  );
}

/**
 * Which microphone the call listens with: the small arrow beside the microphone button, as in
 * any call. The app's one choice — the same as in Settings and when a meeting is started — so
 * changing it here changes it everywhere; the call goes on with the new one at once.
 */
function MicChoice({ disabled }: { disabled: boolean }) {
  const l = useL();
  const t = useT();
  const device = useDictationStore((s) => s.device);
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ inputs: MicInput[] | null; anchor: DOMRect } | null>(null);
  // The store holds the choice; a window that never opened Settings has not read it yet.
  useEffect(() => void useDictationStore.getState().load(), []);
  const open = () => {
    const anchor = button.current?.getBoundingClientRect();
    if (!anchor) return;
    setMenu({ inputs: null, anchor });
    // Read as it opens: a headset plugged in a moment ago is there to pick.
    void dictationInputs()
      .then((inputs) => setMenu((now) => (now ? { ...now, inputs } : now)))
      .catch(() => setMenu((now) => (now ? { ...now, inputs: [] } : now)));
  };
  const items: MenuItem[] = micOptions(menu?.inputs ?? null, device, t).map((option) => ({
    label: option.label,
    leading: option.value === device ? <Check className="h-3.5 w-3.5 shrink-0 text-[var(--cf-accent)]" /> : <span className="w-3.5 shrink-0" />,
    onClick: () => {
      if (option.value !== device) void useTeamCallStore.getState().micDevice(option.value);
    },
  }));
  const label = l("Elegir el micrófono", "Choose the microphone");
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => (menu ? setMenu(null) : open())}
        className="-ml-1 grid h-7 w-6 shrink-0 place-items-center rounded-full text-[var(--cf-text-muted)] outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--cf-text)_12%,transparent)] hover:text-[var(--cf-text)] focus-visible:shadow-[0_0_0_3px_var(--cf-accent-line)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronUp className={`h-3.5 w-3.5 transition-transform ${menu ? "rotate-180" : ""}`} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.anchor.left}
          y={menu.anchor.top}
          anchor={{ top: menu.anchor.top, bottom: menu.anchor.bottom, left: menu.anchor.left, right: menu.anchor.right, align: "start" }}
          heading={l("Micrófono", "Microphone")}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** A round button of the call's bar. */
function RoundButton({ label, title, onClick, on, danger, disabled, children }: { label: string; title?: string; onClick: () => void; on?: boolean; danger?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-full outline-none transition-[background-color,color,transform] duration-100 focus-visible:shadow-[0_0_0_3px_var(--cf-accent-line)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? "bg-[var(--cf-danger)] text-white hover:brightness-110"
          : on ? "bg-[var(--cf-accent)] text-white hover:brightness-110"
          : "bg-[var(--cf-sunken)] text-[var(--cf-text)] hover:bg-[color-mix(in_oklab,var(--cf-text)_12%,var(--cf-sunken))]"
      }`}
    >
      {children}
    </button>
  );
}

/** One tab of the panel under the participants. */
function PanelTab({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof Captions; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] ${active ? "bg-[color-mix(in_oklab,var(--cf-accent)_12%,transparent)] font-medium text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/** The whole transcript as text, for the clipboard. */
export function transcriptText(lines: CallLine[], l: L): string {
  return lines.filter((line) => line.kind === "say").map((line) => `[${clock(line.atMs)}] ${line.who === "user" ? l("Tú", "You") : line.name}: ${line.text}`).join("\n");
}

export function CallRoom({ call, grip, controls, shown = true, onClose }: {
  call: CallState;
  /** What makes the header the window's handle. */
  grip?: HTMLAttributes<HTMLDivElement>;
  /** The window's own buttons. */
  controls?: ReactNode;
  /** False while its window is folded away. */
  shown?: boolean;
  onClose: () => void;
}) {
  const l = useL();
  const lines = useTeamCallStore((s) => s.lines);
  const captions = useTeamCallStore((s) => s.captions);
  const speakingOrigin = useSpeechStore((s) => (s.speaking?.phase === "speaking" ? s.speaking.origin : ""));
  const working = useAgentStates();
  const time = useCallClock(call);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"transcript" | "people">("transcript");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const live = call.phase === "live";
  const speaker = call.seats.find((seat) => seat.state === "speaking");
  const waiting = call.seats.filter((seat) => seat.hand > 0).length;
  const lead = call.seats.find((seat) => seat.lead) ?? call.seats[0];
  const others = call.seats.filter((seat) => seat !== lead);
  // Who the room shows beside whoever leads: those who have come into the conversation.
  const entered = useRef<{ call: string; ids: string[] }>({ call: call.id, ids: [] });
  entered.current = { call: call.id, ids: enteredSeats(entered.current.call === call.id ? entered.current.ids : [], others, lines) };
  const inRoom = entered.current.ids.map((id) => others.find((seat) => seat.memberId === id)).filter((seat): seat is CallSeat => !!seat);
  const apart = others.length - inRoom.length;
  // Few tiles are large ones, three or four across; a full team falls back to as many as fit.
  const tiles = inRoom.length + 1;
  const across = tiles <= 6 ? "repeat(3, minmax(0, 1fr))" : tiles <= 12 ? "repeat(4, minmax(0, 1fr))" : "repeat(auto-fill, minmax(116px, 1fr))";
  const { mic, headphones, interrupt, hangUp, say, talk, toggleCaptions } = useTeamCallStore.getState();

  // The bars move with the voice that is playing: this window hears about it like any other.
  useEffect(() => ensureSpeechEvents(), []);

  // The hand, from the keyboard: the space bar stops whoever is speaking; M mutes.
  useEffect(() => {
    if (!live || !shown) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target?.closest("input, textarea, select, button, [contenteditable='true'], [role='menu']")) return;
      if (event.key === " ") {
        event.preventDefault();
        interrupt();
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        void mic(!call.mic);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, shown, call.mic, interrupt, mic]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    say(text);
    setDraft("");
  }, [draft, say]);
  /** Starts a line to one participant: its name is what routes it. */
  const address = useCallback((name: string) => {
    setDraft((now) => (now.trim() ? now : `${name}, `));
    input.current?.focus();
  }, []);

  const micLevel = useCallback(() => callMicLevel(), []);
  const speech = useCallback(() => voiceLevel(), []);
  // The bars move with the one voice that is playing: a seat's, when it is its turn.
  const voiced = (seat: CallSeat) => seat.state === "speaking" && (speakingOrigin === `call:${seat.memberId}` || speakingOrigin === "");
  const you = !live ? l("Fuera de la llamada", "Off the call")
    : call.hearing ? l("Hablando", "Speaking")
    : call.mic ? l("Micrófono activo", "Microphone on")
    : call.listening === "ready" ? l("Micrófono apagado", "Microphone off")
    : l("Escribiendo", "Typing");
  const phaseLabel = live ? l("En llamada", "On the call")
    : call.phase === "closing" ? l("Cerrando", "Wrapping up")
    : call.phase === "countdown" || call.phase === "starting" ? l("Por empezar", "About to start")
    : call.phase === "started" ? l("Trabajando", "Working")
    : l("Terminada", "Ended");
  const phaseTone = live ? "var(--cf-success)" : call.phase === "ended" ? "var(--cf-text-muted)" : "var(--cf-accent)";
  const copy = () => {
    void navigator.clipboard?.writeText(transcriptText(lines, l)).then(
      () => useToastStore.getState().pushToast(l("Transcripción copiada", "Transcript copied"), "success"),
      () => undefined,
    );
  };

  return (
    <>
      <div
        {...grip}
        className={`@container flex shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-4 py-3 ${grip ? "cursor-default select-none" : ""}`}
      >
        <span className="pointer-events-none grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_oklab,var(--cf-success)_14%,var(--cf-surface))] text-[var(--cf-success)]">
          <AudioLines className={`h-4 w-4 ${speaker ? "animate-pulse" : ""}`} />
        </span>
        <div className="pointer-events-none min-w-0 flex-1">
          <b className="block truncate text-[14px]">{call.teamName}</b>
          <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">{l("Llamada con el equipo", "Call with the team")} · {call.seats.length === 1 ? l("1 agente", "1 agent") : l(`${call.seats.length} agentes`, `${call.seats.length} agents`)}</span>
        </div>
        <span className="pointer-events-none flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium tabular-nums" style={{ color: phaseTone, background: `color-mix(in oklab, ${phaseTone} 12%, var(--cf-surface))` }}>
          {live && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: phaseTone }} />}
          {/* In a narrow window the clock alone says it is live: the team's name keeps its room. */}
          <span className={live ? "hidden @[460px]:inline" : ""}>{phaseLabel}{live ? " · " : ""}</span>
          {live && time}
        </span>
        {controls}
        {!controls && !live && call.phase !== "closing" && call.phase !== "starting" && (
          <button type="button" onClick={onClose} title={l("Cerrar", "Close")} aria-label={l("Cerrar la llamada", "Close the call")} className={iconButtonClass({ size: "sm" })}><X className="h-4 w-4" /></button>
        )}
      </div>

      <div className="@container flex min-h-0 flex-1 flex-col gap-2.5 p-3">
        {/* Whoever leads, large, and the rest beside it — under it where the window is narrow. With
            the transcript folded the participants take the room it leaves. */}
        <div
          className={`grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2.5 @[640px]:grid-cols-[minmax(230px,34%)_minmax(0,1fr)] @[640px]:grid-rows-1 ${live && !captions ? "flex-1" : "shrink-0"}`}
          style={live && !captions ? undefined : { height: live ? "clamp(230px, 50%, 480px)" : "clamp(200px, 34%, 320px)" }}
        >
          {lead && (
            <LeadTile seat={lead} waiting={waiting} working={working.get(lead.agentId) === "thinking"} speaking={voiced(lead)} level={speech} l={l} onAddress={address} />
          )}
          <div className="flex min-h-0 flex-col gap-2">
            <div
              className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(116px,1fr))] content-start gap-2 overflow-y-auto pr-0.5 @[640px]:grid-cols-[var(--across)]"
              style={{ "--across": across, gridAutoRows: "minmax(84px, 172px)" } as CSSProperties}
            >
              <YouTile call={call} status={live && !call.hearing && call.listening === "ready" ? (call.mic ? l("Mic activo", "Mic on") : l("Mic apagado", "Mic off")) : you} level={micLevel} l={l} />
              {inRoom.map((seat) => (
                <SeatTile key={seat.memberId} seat={seat} waiting={waiting} working={working.get(seat.agentId) === "thinking"} speaking={voiced(seat)} level={speech} l={l} onAddress={address} />
              ))}
            </div>
            {/* The rest of the team is on the call and listening: a tile comes when one of them is
                spoken to. Until then they are a line, and a list one press away. */}
            {apart > 0 && (
              <button
                type="button"
                disabled={!live}
                onClick={() => {
                  if (!captions) toggleCaptions();
                  setTab("people");
                }}
                title={live ? l("Ver a todos los participantes", "See every participant") : undefined}
                className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-dashed border-[var(--cf-border-strong)] px-2.5 text-left text-[11.5px] text-[var(--cf-text-muted)] outline-none enabled:hover:bg-[var(--cf-hover)] enabled:hover:text-[var(--cf-text)] focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)]"
              >
                <Users className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {apart === 1
                    ? l("1 participante más escucha: aparece aquí cuando le hables", "1 more participant is listening: it shows up here when you speak to it")
                    : l(`${apart} participantes más escuchan: aparecen aquí cuando les hables`, `${apart} more participants are listening: they show up here when you speak to them`)}
                </span>
                {live && <span className="shrink-0 font-medium text-[var(--cf-accent)]">{l("Ver todos", "See all")}</span>}
              </button>
            )}
          </div>
        </div>

        {live ? (
          <>
            <HandsRow seats={call.seats} l={l} />
            <ListeningNotice call={call} />
            {captions && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)]">
                <div role="tablist" aria-label={l("Paneles de la llamada", "Call panels")} className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
                  <PanelTab active={tab === "transcript"} icon={Captions} label={l("Transcripción", "Transcript")} onClick={() => setTab("transcript")} />
                  <PanelTab active={tab === "people"} icon={Users} label={l(`Participantes (${call.seats.length + 1})`, `Participants (${call.seats.length + 1})`)} onClick={() => setTab("people")} />
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <span className="hidden items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_12%,var(--cf-surface))] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-success)] @[460px]:flex">
                      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cf-success)]" />
                      {l("En vivo", "Live")}
                    </span>
                    {tab === "transcript" && (
                      <>
                        <button
                          type="button"
                          aria-pressed={searching}
                          onClick={() => {
                            setSearching(!searching);
                            setQuery("");
                          }}
                          title={l("Buscar en la transcripción", "Search the transcript")}
                          aria-label={l("Buscar en la transcripción", "Search the transcript")}
                          className={iconButtonClass({ size: "sm" })}
                        >
                          <Search className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" disabled={lines.length === 0} onClick={copy} title={l("Copiar la transcripción", "Copy the transcript")} aria-label={l("Copiar la transcripción", "Copy the transcript")} className={iconButtonClass({ size: "sm" })}>
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </span>
                </div>
                {tab === "transcript" && searching && (
                  <div className="shrink-0 border-b border-[var(--cf-border)] px-2 py-1.5">
                    <input
                      autoFocus
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        setSearching(false);
                        setQuery("");
                      }}
                      placeholder={l("Buscar lo que se dijo…", "Search what was said…")}
                      aria-label={l("Buscar en la transcripción", "Search the transcript")}
                      className="h-7 w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 text-[12.5px] outline-none placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)]"
                    />
                  </div>
                )}
                {tab === "transcript" ? <Transcript call={call} lines={lines} query={searching ? query : ""} /> : <Participants call={call} working={working} l={l} onAddress={address} />}
              </div>
            )}
            <form
              className="flex shrink-0 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <input
                ref={input}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={l("Escribe o habla con un agente: «DBA, ¿cómo ves la base?»", "Type or talk to an agent: “DBA, how does the database look?”")}
                aria-label={l("Escribir al equipo", "Type to the team")}
                className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 text-[13px] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
              />
              <button type="submit" disabled={!draft.trim()} title={l("Decirlo", "Say it")} aria-label={l("Decirlo", "Say it")} className={iconButtonClass({ size: "sm" })}><SendHorizontal className="h-4 w-4" /></button>
            </form>
            <div className="flex shrink-0 items-center gap-2 @[520px]:gap-3">
              {/* The two sides take the same room, so the round buttons stay in the middle. */}
              <span className="flex min-w-0 flex-1 basis-0 justify-start">
                <button
                  type="button"
                  role="switch"
                  aria-checked={call.headphones}
                  onClick={() => headphones(!call.headphones)}
                  title={call.headphones
                    ? l("Con audífonos: puedes interrumpir al equipo hablando", "With headphones: speaking interrupts the team")
                    : l("Sin audífonos: mientras un agente habla, interrúmpelo con la mano, la barra espaciadora o diciendo un nombre", "No headphones: while an agent speaks, interrupt with the hand, the space bar or a name")}
                  aria-label={l("Uso audífonos", "Headphones on")}
                  // In a narrow window it is down to its icon: what it does stays within reach.
                  className={`flex h-8 w-8 shrink-0 items-center justify-center gap-1.5 rounded-full border text-[11.5px] outline-none transition-colors focus-visible:shadow-[0_0_0_3px_var(--cf-accent-line)] @[640px]:w-auto @[640px]:px-3 ${call.headphones ? "border-[var(--cf-accent)] bg-[color-mix(in_oklab,var(--cf-accent)_10%,transparent)] text-[var(--cf-accent)]" : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"}`}
                >
                  <Headphones className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden @[640px]:inline">{l("Uso audífonos", "Headphones on")}</span>
                </button>
              </span>
              <span className="flex shrink-0 items-center gap-2 @[520px]:gap-3">
                {/* The microphone and, beside it, which one: one control, as in any call. */}
                <span className="flex shrink-0 items-center rounded-full bg-[var(--cf-sunken)] pr-1">
                  <RoundButton
                    label={call.mic ? l("Silenciar el micrófono", "Mute the microphone") : l("Abrir el micrófono", "Open the microphone")}
                    title={call.listening === "ready" || call.listening === "failed" ? `${call.mic ? l("Silenciar el micrófono", "Mute the microphone") : l("Abrir el micrófono", "Open the microphone")} (M)` : l("El micrófono no está disponible", "The microphone is not available")}
                    on={call.mic}
                    disabled={call.listening !== "ready" && call.listening !== "failed"}
                    onClick={() => void mic(!call.mic)}
                  >
                    {call.mic ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
                  </RoundButton>
                  <MicChoice disabled={call.listening === "unsupported"} />
                </span>
                <RoundButton label={captions ? l("Ocultar la transcripción", "Hide the transcript") : l("Mostrar la transcripción", "Show the transcript")} on={captions} onClick={toggleCaptions}>
                  {captions ? <Captions className="h-5 w-5" /> : <CaptionsOff className="h-5 w-5" />}
                </RoundButton>
                <RoundButton
                  label={l("Pedir la palabra", "Take the word")}
                  title={speaker ? l(`Interrumpir a ${speaker.name} (barra espaciadora)`, `Interrupt ${speaker.name} (space bar)`) : l("Pedir la palabra: detiene a quien esté hablando (barra espaciadora)", "Take the word: stops whoever is speaking (space bar)")}
                  onClick={interrupt}
                >
                  <Hand className="h-5 w-5" />
                </RoundButton>
                <RoundButton label={l("Colgar", "Hang up")} title={l("Colgar: el líder escribe el acta y, si se acordó trabajo, el equipo empieza", "Hang up: the lead writes the minutes and, if work was agreed, the team starts")} danger onClick={hangUp}>
                  <PhoneOff className="h-5 w-5" />
                </RoundButton>
              </span>
              <span className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-2 text-[11px] text-[var(--cf-text-faint)]">
                {/* What the choice does not change is said on hover: spelled out beside the switch it
                    was a second line of text under the controls (the user, 2026-11-25: «quita ese
                    texto de ahí abajo»). */}
                <span className="hidden shrink-0 @[760px]:inline" title={l("Para revisar el código y trabajar usan siempre el suyo; el de un agente se fija en su editor.", "To look at the code and to work they always use their own; an agent's is set in its editor.")}>
                  {l("Conversan con", "They talk with")}
                </span>
                <span className="hidden @[520px]:inline-flex">
                  <Seg
                    size="sm"
                    value={call.talk}
                    onChange={(mode) => void talk(mode)}
                    options={[
                      { value: "fast", label: l("Modelo rápido", "Fast model"), title: l("Conversan con el modelo rápido de su proveedor: responden en un par de segundos. Donde el proveedor no tiene uno, usan el suyo.", "They talk with their provider's fast model: they answer in a couple of seconds. Where the provider has none, they use their own.") },
                      { value: "own", label: l("El suyo", "Their own"), title: l("Conversan con el modelo configurado en cada agente: respuestas más pensadas, con pausas más largas.", "They talk with the model set on each agent: more considered answers, with longer pauses.") },
                    ]}
                  />
                </span>
              </span>
            </div>
          </>
        ) : (
          <CallWrapUp call={call} onClose={onClose} />
        )}
      </div>
    </>
  );
}
