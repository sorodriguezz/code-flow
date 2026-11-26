/**
 * The room of a call with a team: who is in it and what each is doing, what is being said, and
 * the few things a call is controlled with.
 *
 * Every participant has a tile — the user's first — with its state in words and its voice in
 * bars, so who is speaking is seen without reading. Under them the conversation is written as it
 * is said. When the call ends the same room shows what was agreed and the team starting on it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { AudioLines, Captions, CaptionsOff, Check, ChevronUp, Hand, Headphones, Loader2, Mic, MicOff, PhoneOff, SendHorizontal, User, X } from "lucide-react";
import type { CallLine, CallSeat, CallState } from "../../../lib/tauri/teamCallCommands";
import { voiceLevel } from "../../../lib/thinking/voice";
import { agentColorVar } from "../../../lib/agents/agentColors";
import { scrollBehavior } from "../../../lib/motion";
import { dictationInputs, type MicInput } from "../../../lib/tauri/dictationCommands";
import { micOptions } from "../../../lib/dictation/micOptions";
import { offerMicSettings, useDictationStore } from "../../../state/dictationStore";
import { useT } from "../../../state/languageStore";
import { useSpeechStore } from "../../../state/speechStore";
import { callMicLevel, showingTeamCall, useTeamCallStore } from "../../../state/teamCallStore";
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

function Tile({ name, role, status, tone, color, avatar, level, speaking, title, badge, engine, dense = false }: {
  name: string;
  role: string;
  /** A large team: the tiles are small, so the role is left to the tooltip and the name gets its room. */
  dense?: boolean;
  /** Under the role: whose engine, which model and which account — or nothing, for the user. */
  engine?: ReactNode;
  status: string;
  tone: "speaking" | "busy" | "rest";
  color: string;
  avatar: ReactNode;
  level: () => number;
  speaking: boolean;
  title?: string;
  badge?: ReactNode;
}) {
  return (
    <div
      title={title}
      className="relative flex min-w-0 flex-col items-center gap-0.5 rounded-xl border bg-[var(--cf-surface)] px-2 pb-2.5 pt-3.5 text-center transition-[border-color,box-shadow,background-color] duration-200"
      style={speaking
        ? { borderColor: color, boxShadow: `0 0 0 1px ${color}, 0 10px 28px -14px ${color}`, background: `color-mix(in oklab, ${color} 6%, var(--cf-surface))` }
        : { borderColor: "var(--cf-border)" }}
    >
      {badge && <span className="absolute right-2 top-2">{badge}</span>}
      {avatar}
      {/* The whole name, on two lines when it needs them: «Backend senior A» and «Backend senior B»
          cut to one line are the same tile twice. */}
      <b className="mt-1.5 line-clamp-2 w-full break-words text-[13px] leading-tight">{name}</b>
      {!dense && <span className="block w-full truncate text-[11.5px] leading-tight text-[var(--cf-text-muted)]">{role || " "}</span>}
      {/* From here down it sits at the bottom, so a name on two lines beside one on one leaves the
          states of a row at one height. */}
      <span className="mt-auto flex h-[15px] w-full min-w-0 shrink-0 items-center justify-center gap-1 pt-0.5 text-[10.5px] leading-none text-[var(--cf-text-faint)]">{engine}</span>
      <span role="status" className={`mt-1 block w-full truncate text-[11.5px] leading-tight ${tone === "rest" ? "text-[var(--cf-text-muted)]" : "font-medium"}`} style={tone === "rest" ? undefined : { color }}>
        {status}
      </span>
      <VoiceBars level={level} active={speaking} color={color} />
    </div>
  );
}

/** The conversation, written as it is said, with whoever is on their way to say something. */
function Transcript({ call, lines }: { call: CallState; lines: CallLine[] }) {
  const l = useL();
  const scroll = useRef<HTMLDivElement>(null);
  const colors = useMemo(() => new Map(call.seats.map((seat) => [seat.memberId, agentColorVar(seat.color, seat.agentId)])), [call.seats]);
  const pending = call.seats.filter((seat) => seat.state === "thinking" || seat.state === "looking");
  const last = lines[lines.length - 1];
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: scrollBehavior() });
  }, [lines.length, last?.text, pending.length]);
  return (
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-[var(--cf-sunken)] px-4 py-3" role="log" aria-live="polite" aria-label={l("Transcripción en directo", "Live transcript")}>
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{l("Transcripción en directo", "Live transcript")}</div>
      {lines.length === 0 && <p className="text-[12.5px] text-[var(--cf-text-muted)]">{l("Lo que se diga aparece aquí.", "What is said shows up here.")}</p>}
      <ul className="space-y-1.5">
        {lines.map((line) => line.kind === "note" ? (
          <li key={line.id} className="text-[12px] italic text-[var(--cf-text-muted)]">{line.text}</li>
        ) : (
          <li key={line.id} className="text-[13px] leading-relaxed">
            <span className="tabular-nums text-[var(--cf-text-muted)]">{clock(line.atMs)} · </span>
            <b className="font-semibold" style={line.who === "user" ? undefined : { color: colors.get(line.who) }}>{line.who === "user" ? l("Tú", "You") : line.name}</b>
            <span className="text-[var(--cf-text-muted)]"> — </span>
            <span>{line.text}</span>
            {line.partial && <span aria-hidden className="ml-0.5 inline-block h-3 w-[2px] translate-y-[2px] animate-pulse rounded-full bg-[var(--cf-text-muted)]" />}
          </li>
        ))}
        {pending.map((seat) => (
          <li key={`pending-${seat.memberId}`} className="flex items-center gap-2 text-[12.5px] text-[var(--cf-text-muted)]">
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
  const head = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const live = call.phase === "live";
  /** More participants than sit comfortably large: smaller tiles, and the transcript keeps its room. */
  const dense = call.seats.length > 8;
  const speaker = call.seats.find((seat) => seat.state === "speaking");
  const { mic, headphones, interrupt, hangUp, say, talk, toggleCaptions } = useTeamCallStore.getState();

  // Whoever announces that the team started asks whether this is in sight.
  useEffect(() => (shown && head.current ? showingTeamCall(head.current) : undefined), [shown]);

  // The hand, from the keyboard: the space bar stops whoever is speaking; M mutes.
  useEffect(() => {
    if (!live || !shown) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target?.closest("input, textarea, select, button, [contenteditable='true']")) return;
      if (!head.current?.closest("[data-team-call-window]")?.contains(document.activeElement) && document.activeElement !== document.body) return;
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

  const micLevel = useCallback(() => callMicLevel(), []);
  const speech = useCallback(() => voiceLevel(), []);
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

  return (
    <>
      <div
        ref={head}
        {...grip}
        className={`@container flex shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] px-4 py-3 ${grip ? "cursor-grab touch-none select-none active:cursor-grabbing" : ""}`}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_oklab,var(--cf-success)_14%,var(--cf-surface))] text-[var(--cf-success)]">
          <AudioLines className={`h-4 w-4 ${speaker ? "animate-pulse" : ""}`} />
        </span>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px]">{call.teamName}</b>
          <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">{l("Llamada con el equipo", "Call with the team")} · {call.seats.length === 1 ? l("1 agente", "1 agent") : l(`${call.seats.length} agentes`, `${call.seats.length} agents`)}</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium tabular-nums" style={{ color: phaseTone, background: `color-mix(in oklab, ${phaseTone} 12%, var(--cf-surface))` }}>
          {live && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: phaseTone }} />}
          {/* In a narrow window the clock alone says it is live: the team's name keeps its room. */}
          <span className={live ? "hidden @[460px]:inline" : ""}>{phaseLabel}{live ? " · " : ""}</span>
          {live && time}
        </span>
        {controls && <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--cf-border)]" />}
        {controls}
        {!live && call.phase !== "closing" && call.phase !== "starting" && (
          <button type="button" onClick={onClose} title={l("Cerrar", "Close")} aria-label={l("Cerrar la llamada", "Close the call")} className={iconButtonClass({ size: "sm" })}><X className="h-4 w-4" /></button>
        )}
      </div>

      <div className="@container flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* A small team on a live call sits three across, large, like people in a room; a larger
            one, or a call that is over and has minutes to show, takes as many across as fit. */}
        <div
          className={`grid shrink-0 gap-2 @[520px]:gap-2.5 ${live && call.seats.length <= 5 ? "grid-cols-3" : ""}`}
          style={{
            gridTemplateColumns: live && call.seats.length <= 5 ? undefined : `repeat(auto-fill, minmax(${dense ? 118 : 112}px, 1fr))`,
            // A large team leaves the transcript half the room; its tiles scroll when they are more.
            maxHeight: captions || !live ? (dense ? "50%" : "58%") : undefined,
            overflowY: "auto",
          }}
        >
          <Tile
            name={l("Tú", "You")}
            role={l("Diriges el equipo", "You lead the team")}
            status={you}
            tone={call.hearing ? "speaking" : "rest"}
            color="var(--cf-accent)"
            speaking={live && call.hearing}
            level={micLevel}
            dense={dense}
            title={l("Tú · Diriges el equipo", "You · You lead the team")}
            avatar={<span className={`grid place-items-center bg-[var(--cf-sunken)] text-[var(--cf-text-muted)] ${dense ? "h-9 w-9 rounded-[11px]" : "h-11 w-11 rounded-[14px]"}`}><User className={dense ? "h-4 w-4" : "h-5 w-5"} /></span>}
          />
          {call.seats.map((seat) => {
            const color = agentColorVar(seat.color, seat.agentId);
            const busy = working.get(seat.agentId) === "thinking";
            const status = seatStatus(seat, busy, l);
            const state: AgentState = seat.state === "thinking" || seat.state === "looking" || (seat.state === "listening" && busy) ? "thinking" : seat.state === "hand" ? "waiting" : "idle";
            // The bars move with the one voice that is playing: this seat's, when it is its turn.
            const speaking = seat.state === "speaking" && (speakingOrigin === `call:${seat.memberId}` || speakingOrigin === "");
            return (
              <Tile
                key={seat.memberId}
                name={seat.name}
                role={seat.role}
                status={status.label}
                tone={status.tone}
                color={color}
                speaking={speaking}
                level={speech}
                dense={dense}
                title={[seat.name, seat.role, seat.lead ? l("Lidera el equipo", "Leads the team") : "", seat.voiceLabel ? l(`Voz: ${seat.voiceLabel}`, `Voice: ${seat.voiceLabel}`) : "", seat.note].filter(Boolean).join(" · ")}
                badge={seat.state === "hand" ? <Hand className="h-3.5 w-3.5" style={{ color }} /> : undefined}
                engine={
                  <span className="flex min-w-0 items-center gap-1" title={engineTitle(seat, l)}>
                    <ProviderGlyph providerId={seat.provider} size={11} />
                    <span className="min-w-0 truncate">{[shortModel(seat.model), seat.account].filter(Boolean).join(" · ") || seat.provider}</span>
                  </span>
                }
                avatar={<AgentAvatar agent={{ id: seat.agentId, icon: seat.icon, color: seat.color }} size={dense ? 36 : 44} state={state} />}
              />
            );
          })}
        </div>

        {live ? (
          <>
            <ListeningNotice call={call} />
            {captions && <Transcript call={call} lines={lines} />}
            {!captions && <div className="min-h-0 flex-1" />}
            <form
              className="flex shrink-0 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={l("Escribe en vez de hablar: «DBA, ¿cómo ves la base?»", "Type instead of speaking: “DBA, how does the database look?”")}
                aria-label={l("Escribir al equipo", "Type to the team")}
                className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 text-[13px] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]"
              />
              <button type="submit" disabled={!draft.trim()} title={l("Decirlo", "Say it")} aria-label={l("Decirlo", "Say it")} className={iconButtonClass({ size: "sm" })}><SendHorizontal className="h-4 w-4" /></button>
            </form>
            <div className="flex shrink-0 items-center justify-center gap-2 pt-1 @[520px]:gap-3">
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
                className={`mr-auto flex h-8 w-8 shrink-0 items-center justify-center gap-1.5 rounded-full border text-[11.5px] outline-none transition-colors focus-visible:shadow-[0_0_0_3px_var(--cf-accent-line)] @[520px]:w-auto @[520px]:px-3 ${call.headphones ? "border-[var(--cf-accent)] bg-[color-mix(in_oklab,var(--cf-accent)_10%,transparent)] text-[var(--cf-accent)]" : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"}`}
              >
                <Headphones className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden @[520px]:inline">{l("Uso audífonos", "Headphones on")}</span>
              </button>
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
              {/* As wide as the switch on the other side, so the four buttons stay in the middle. */}
              <span className="ml-auto w-8 shrink-0 @[520px]:w-[118px]" aria-hidden />
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-[var(--cf-text-faint)]">
              {/* What the choice does not change is said on hover: spelled out beside the switch it
                  was a second line of text under the controls (the user, 2026-11-25: «quita ese
                  texto de ahí abajo»). */}
              <span title={l("Para revisar el código y trabajar usan siempre el suyo; el de un agente se fija en su editor.", "To look at the code and to work they always use their own; an agent's is set in its editor.")}>
                {l("Conversan con", "They talk with")}
              </span>
              <Seg
                size="sm"
                value={call.talk}
                onChange={(mode) => void talk(mode)}
                options={[
                  { value: "fast", label: l("Modelo rápido", "Fast model"), title: l("El modelo rápido de su proveedor: responden en un par de segundos. Donde el proveedor no tiene uno, usan el suyo.", "Their provider's fast model: they answer in a couple of seconds. Where the provider has none, they use their own.") },
                  { value: "own", label: l("El suyo", "Their own"), title: l("El modelo configurado en cada agente: respuestas más pensadas, con pausas más largas.", "The model set on each agent: more considered answers, with longer pauses.") },
                ]}
              />
            </div>
          </>
        ) : (
          <CallWrapUp call={call} onClose={onClose} />
        )}
      </div>
    </>
  );
}
