/**
 * «Equipos» in the assistant's panel: the workspace's teams, to talk to from wherever the user is
 * working. A chat with a team and a call each open as a window that floats over the view on screen
 * (`teams/TeamChatWindow`), so starting one here takes nothing away — the code, the diff or the
 * pull request being read stays where it was. A team's past conversations, its calls among them,
 * are gone back to and deleted from here too.
 *
 * Teams only — single agents are talked to from the Agents view (the user, 2026-11-25). It lists
 * what there is and what each is doing, never how they are built: making a team, editing an agent
 * and watching a run stay in the Agents view, one link away.
 *
 * Drawn in a panel that is often 360 px wide: every row is an avatar, two lines that truncate, and
 * buttons that never shrink — worded where there is room, icons where there is not.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, AudioLines, ChevronDown, Loader2, MessageSquare, MessageSquarePlus, Network, Phone, PhoneOff, Trash2 } from "lucide-react";
import { confirmAction } from "../../../state/confirmStore";
import { callOngoing, useTeamCallStore } from "../../../state/teamCallStore";
import { openTeamChatWindow, teamChatBusy, useTeamChatStore } from "../../../state/teamChatStore";
import { useTeamStore } from "../../../state/teamStore";
import { teamChatHistory, type TeamChatSummary } from "../../../lib/tauri/teamCommands";
import { callTeam, chatWithTeam, showAgentsView } from "../../../lib/agents/talk";
import { runIsLive, type Team } from "../../../types/team";
import type { CallState } from "../../../lib/tauri/teamCallCommands";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { Skeleton } from "../../common/Skeleton";
import { TeamAvatar } from "../kit/Avatar";
import { ago } from "../kit/time";
import { useCrewStore, useL, type Space } from "../state";
import { useCrewPanel } from "./useCrewPanel";
import { matchesQuery, teamLine } from "./crewPanelLogic";

/** Minutes and seconds since `startedAtMs`, ticking while `running`. */
function useClock(startedAtMs: number, running: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const seconds = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function goToAgents(space: Space): void {
  showAgentsView();
  const crew = useCrewStore.getState();
  if (space === "equipos") crew.set({ selectedTeamId: null, selectedMemberId: null });
  crew.setSpace(space);
}

/** A row's button: an icon always, its word once the panel is wide enough to carry it. */
function RowButton({ icon: Icon, label, title, tone, disabled, onClick }: {
  icon: typeof Phone;
  label: string;
  title: string;
  tone: "accent" | "success";
  disabled?: boolean;
  onClick: () => void;
}) {
  const color = tone === "success" ? "var(--cf-success)" : "var(--cf-accent)";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
      className={buttonClass({ variant: "secondary", size: "sm", className: "shrink-0 gap-1 px-1.5 @[27rem]:px-2" })}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={disabled ? undefined : { color }} />
      <span className="hidden @[27rem]:inline">{label}</span>
    </button>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <p className="m-0 flex items-center gap-1.5 px-1.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
      {label}
      <span className="tabular-nums tracking-normal">{count}</span>
    </p>
  );
}

/** The call that is going on, above everything: it holds the microphone, so it is said first. */
function CallCard({ call }: { call: CallState }) {
  const l = useL();
  const ongoing = callOngoing(call);
  const time = useClock(call.startedAtMs, ongoing);
  const speaker = call.seats.find((seat) => seat.state === "speaking");
  const live = call.phase === "live";
  const status = live
    ? speaker ? l(`Habla ${speaker.name} · ${time}`, `${speaker.name} is speaking · ${time}`) : l(`En llamada · ${time}`, `On the call · ${time}`)
    : call.phase === "closing" ? l("Escribiendo el acta…", "Writing the minutes…")
    : call.phase === "countdown" ? l("El equipo está por empezar", "The team is about to start")
    : call.phase === "starting" ? l("Poniéndose en marcha…", "Getting started…")
    : call.phase === "started" ? l("El equipo está trabajando", "The team is working")
    : l("Llamada terminada", "Call ended");
  const tone = live ? "var(--cf-success)" : call.phase === "ended" ? "var(--cf-text-muted)" : "var(--cf-accent)";
  const { restore, hangUp, close } = useTeamCallStore.getState();
  return (
    <div
      role="group"
      aria-label={l(`Llamada con ${call.teamName}`, `Call with ${call.teamName}`)}
      className="mt-2 flex items-center gap-2 rounded-[11px] border py-1.5 pl-2 pr-1.5"
      style={{ borderColor: `color-mix(in oklab, ${tone} 45%, var(--cf-border))`, background: `color-mix(in oklab, ${tone} 8%, transparent)` }}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px]" style={{ color: tone, background: `color-mix(in oklab, ${tone} 16%, transparent)` }}>
        <AudioLines className={`h-3.5 w-3.5 ${speaker || call.hearing ? "animate-pulse" : ""}`} />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[12.5px] leading-tight">{call.teamName}</b>
        <span role="status" className="block truncate text-[11px] font-medium leading-tight tabular-nums" style={{ color: tone }}>{status}</span>
      </span>
      <button type="button" onClick={restore} title={l("Volver a la llamada: abre su ventana", "Back to the call: opens its window")} className={buttonClass({ variant: "secondary", size: "sm", className: "shrink-0" })}>
        {l("Volver", "Back")}
      </button>
      {live ? (
        <button type="button" onClick={hangUp} title={l("Colgar", "Hang up")} aria-label={l("Colgar la llamada", "Hang up the call")} className={buttonClass({ variant: "danger-ghost", size: "sm", className: "shrink-0 gap-1 px-1.5 @[27rem]:px-2" })}>
          <PhoneOff className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden @[27rem]:inline">{l("Colgar", "Hang up")}</span>
        </button>
      ) : !ongoing ? (
        <button type="button" onClick={() => void close()} className={buttonClass({ variant: "ghost", size: "sm", className: "shrink-0" })}>
          {l("Cerrar", "Close")}
        </button>
      ) : null}
    </div>
  );
}

/** A team's past conversations — its chats and its calls — unfolded under its row: go back to
 *  one, delete one, or start another. */
function TeamConversations({ team, call }: { team: Team; call: CallState | null }) {
  const l = useL();
  const [items, setItems] = useState<TeamChatSummary[] | null>(null);
  const [removing, setRemoving] = useState("");
  // Read again as its chats change: a conversation written in while this is open belongs here too.
  const revision = useTeamChatStore((s) => Object.values(s.states).filter((state) => state.chat.teamId === team.id).map((state) => `${state.chat.id}:${state.messages.length}`).join("|"));
  // The ones the team is answering now: not to be deleted from under it.
  const busy = useTeamChatStore((s) => Object.values(s.states).filter((state) => state.chat.teamId === team.id && teamChatBusy(state)).map((state) => state.chat.id).join("|"));
  useEffect(() => {
    let live = true;
    void teamChatHistory(team.id).then((list) => { if (live) setItems(list); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [team.id, revision]);
  // One nobody wrote in is not somewhere to go back to.
  const written = (items ?? []).filter((item) => item.messages > 0);
  const remove = async (item: TeamChatSummary) => {
    const whole = item.title.trim() || l("Conversación", "Conversation");
    const name = whole.length > 60 ? `${whole.slice(0, 60).trimEnd()}…` : whole;
    const yes = await confirmAction(
      l(
        `¿Eliminar la conversación «${name}»? Se borran sus mensajes y lo que cada miembro respondió en ella. Los cambios que el equipo hizo en los repositorios se conservan.`,
        `Delete the conversation “${name}”? Its messages and what each member answered in it are removed. The changes the team made in the repositories stay.`,
      ),
      true,
      l("Eliminar", "Delete"),
    );
    if (!yes) return;
    setRemoving(item.id);
    try {
      // Its window, if one is open on it, closes with it (`teamChatStore.remove`).
      if (await useTeamChatStore.getState().remove(item.id)) setItems((list) => (list ?? []).filter((entry) => entry.id !== item.id));
    } finally {
      setRemoving("");
    }
  };
  return (
    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16, ease: "easeOut" }} className="overflow-hidden">
      <ul className="m-0 mb-1 ml-[21px] list-none border-l border-[var(--cf-border)] p-0 pl-2.5">
        {items === null && (
          <li className="py-1" aria-hidden><Skeleton className="h-7 w-full" /></li>
        )}
        {written.slice(0, 8).map((item) => {
          const title = item.title.trim() || l("Conversación", "Conversation");
          // The conversation of the call in progress, or one the team is answering, stays.
          const held = (!!call && callOngoing(call) && call.chatId === item.id) ? l("Está en una llamada: cuelga para poder eliminarla", "It is on a call: hang up to delete it")
            : busy.split("|").includes(item.id) ? l("El equipo está respondiendo: espera a que termine", "The team is answering: wait for it to finish")
            : "";
          return (
            <li key={item.id} className="group relative">
              <button type="button" onClick={() => void openTeamChatWindow(item.id)} className="flex w-full min-w-0 flex-col rounded-md py-1 pl-2 pr-8 text-left outline-none hover:bg-[var(--cf-hover)] focus-visible:shadow-[inset_0_0_0_2px_var(--cf-accent-line)]">
                <span className="block w-full truncate text-[12px] text-[var(--cf-text)]">{title}</span>
                <span className="block w-full truncate text-[11px] text-[var(--cf-text-faint)]">
                  {ago(item.createdAt, l)} · {item.messages === 1 ? l("1 mensaje", "1 message") : l(`${item.messages} mensajes`, `${item.messages} messages`)}
                </span>
              </button>
              <button
                type="button"
                disabled={!!held || removing === item.id}
                onClick={() => void remove(item)}
                title={held || l("Eliminar esta conversación", "Delete this conversation")}
                aria-label={l(`Eliminar la conversación «${title}»`, `Delete the conversation “${title}”`)}
                className={`absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-[var(--cf-text-muted)] outline-none transition-opacity hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] focus-visible:opacity-100 focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-[var(--cf-text-muted)] ${removing === item.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
              >
                {removing === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            </li>
          );
        })}
        {items !== null && written.length === 0 && (
          <li className="px-2 py-1 text-[11.5px] text-[var(--cf-text-faint)]">{l("Aún no han conversado.", "No conversations yet.")}</li>
        )}
        {written.length > 8 && (
          <li className="px-2 py-0.5 text-[11px] text-[var(--cf-text-faint)]">{l(`y ${written.length - 8} más, en el historial del chat`, `and ${written.length - 8} more, in the chat's history`)}</li>
        )}
        <li>
          <button type="button" disabled={!team.lead} onClick={() => void chatWithTeam(team.id, true)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-[var(--cf-accent)] outline-none hover:bg-[var(--cf-hover)] focus-visible:shadow-[inset_0_0_0_2px_var(--cf-accent-line)] disabled:opacity-50">
            <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
            {l("Nueva conversación", "New conversation")}
          </button>
        </li>
      </ul>
    </motion.div>
  );
}

function TeamRow({ team, call }: { team: Team; call: CallState | null }) {
  const l = useL();
  const [open, setOpen] = useState(false);
  const busyChat = useTeamChatStore((s) => Object.values(s.states).find((state) => state.chat.teamId === team.id && teamChatBusy(state)));
  const liveRuns = useTeamStore((s) => s.runs.filter((run) => run.team_id === team.id && runIsLive(run)).length);
  const starting = useTeamCallStore((s) => s.starting);
  const onCall = !!call && call.teamId === team.id && callOngoing(call);
  const active = busyChat?.chat.members.find((member) => member.id === busyChat.chat.activeMemberId);
  const doing = onCall ? l("En llamada", "On a call")
    : busyChat ? (active ? l(`${active.name} trabaja…`, `${active.name} is working…`) : l("El líder coordina…", "The lead is coordinating…"))
    : liveRuns > 0 ? (liveRuns === 1 ? l("1 corrida en marcha", "1 run in progress") : l(`${liveRuns} corridas en marcha`, `${liveRuns} runs in progress`))
    : "";
  const noLead = !team.lead;
  return (
    <li>
      {/* The whole row folds and unfolds its conversations, not only the arrow at its end (the
          user, 2026-11-25); «Chat» and «Llamar» keep their own job. */}
      <div
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) setOpen((was) => !was);
        }}
        className="flex cursor-pointer items-center gap-2 rounded-[10px] py-1.5 pl-1.5 pr-1 hover:bg-[var(--cf-hover)]"
      >
        <TeamAvatar size={30} state={busyChat || liveRuns > 0 ? "thinking" : "idle"} />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[12.5px] leading-tight" title={team.description || team.name}>{team.name}</b>
          {doing
            ? <span role="status" className="block truncate text-[11px] font-medium leading-tight" style={{ color: onCall ? "var(--cf-success)" : "var(--cf-accent)" }}>{doing}</span>
            : <span className="block truncate text-[11px] leading-tight text-[var(--cf-text-muted)]">{teamLine(team, l)}</span>}
        </span>
        <RowButton
          icon={MessageSquare}
          tone="accent"
          label={l("Chat", "Chat")}
          disabled={noLead}
          title={noLead ? l("Elige un líder para conversar con el equipo", "Choose a lead to chat with the team") : l(`Chat con ${team.name}: se abre en una ventana flotante`, `Chat with ${team.name}: it opens in a floating window`)}
          onClick={() => void chatWithTeam(team.id)}
        />
        <RowButton
          icon={Phone}
          tone="success"
          label={onCall ? l("Volver", "Back") : l("Llamar", "Call")}
          disabled={noLead || (starting && !onCall)}
          title={noLead ? l("Elige un líder para llamar al equipo", "Choose a lead to call the team")
            : onCall ? l("Volver a la llamada", "Back to the call")
            : l(`Llamar a ${team.name}: habla con sus agentes por voz, planifiquen juntos y al colgar se ponen a hacerlo`, `Call ${team.name}: talk to its agents by voice, plan together, and when you hang up they get to it`)}
          onClick={() => callTeam(team.id)}
        />
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          title={open ? l("Ocultar sus conversaciones", "Hide its conversations") : l("Ver sus conversaciones", "See its conversations")}
          aria-label={l(`Conversaciones con ${team.name}`, `Conversations with ${team.name}`)}
          className={iconButtonClass({ size: "sm", className: "shrink-0" })}
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      <AnimatePresence initial={false}>{open && <TeamConversations key="conversations" team={team} call={call} />}</AnimatePresence>
    </li>
  );
}

function ManageLink({ label, space }: { label: string; space: Space }) {
  return (
    <button type="button" onClick={() => goToAgents(space)} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[11.5px] text-[var(--cf-text-muted)] outline-none hover:text-[var(--cf-accent)] focus-visible:shadow-[0_0_0_2px_var(--cf-accent-line)]">
      {label}
      <ArrowRight className="h-3 w-3" />
    </button>
  );
}

export function CrewPanel({ workspaceId, query }: { workspaceId: string; query: string }) {
  const l = useL();
  const { teams, loading } = useCrewPanel(workspaceId);
  const call = useTeamCallStore((s) => (s.call && s.call.workspaceId === workspaceId ? s.call : null));
  const shownTeams = teams.filter((team) => matchesQuery(query, team.name, team.description, ...team.members.map((member) => member.name)));

  if (loading && teams.length === 0) {
    return (
      <div className="space-y-2 px-1.5 pt-3" aria-hidden>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (teams.length === 0) {
    return (
      <>
        {call && <CallCard call={call} />}
        <div className="flex flex-col items-center gap-2.5 px-5 py-9 text-center">
          <span className="grid h-10 w-10 place-items-center rounded-[13px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"><Network className="h-5 w-5" /></span>
          <b className="text-[13px]">{l("Aún no hay equipos", "No teams yet")}</b>
          <p className="m-0 max-w-[34ch] text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
            {l("Arma un equipo en Agentes. Desde aquí podrás conversar con él y llamarlo sin dejar lo que estás viendo.", "Build a team in Agents. From here you will chat with it and call it without leaving what you are looking at.")}
          </p>
          <button type="button" onClick={() => goToAgents("equipos")} className={buttonClass({ variant: "primary", size: "sm" })}>
            {l("Ir a Agentes", "Go to Agents")}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {call && <CallCard call={call} />}

      <SectionLabel label={l("Equipos", "Teams")} count={teams.length} />
      {shownTeams.length === 0 ? (
        <p className="m-0 px-1.5 text-[12px] text-[var(--cf-text-faint)]">{l("Ningún equipo coincide.", "No team matches.")}</p>
      ) : (
        <ul className="m-0 list-none p-0">{shownTeams.map((team) => <TeamRow key={team.id} team={team} call={call} />)}</ul>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--cf-border)] px-0.5 pt-1.5">
        <span className="flex min-w-0 items-center gap-1.5 truncate px-1 text-[11px] text-[var(--cf-text-faint)]">
          {loading && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
          <span className="truncate">{l("Se abren en ventanas flotantes.", "They open in floating windows.")}</span>
        </span>
        <ManageLink label={l("Gestionar en Agentes", "Manage in Agents")} space="equipos" />
      </div>
    </>
  );
}
