/**
 * «Bandejas»: every agent with what is on its plate, across all the runs and the board.
 *
 * A run shows its own members; this shows the agent. One card per agent of the roster: what waits
 * on you because of it (a question it asked, a task of its that failed, an approval), what it is
 * doing now, and what comes next — the ones something waits on first. Every row opens where the
 * thing lives: the run, the conversation, the board card. Nothing here is stored or decided.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, CircleHelp, Hand, Hourglass, Inbox, Kanban, Loader2, Mail, RefreshCw, XCircle, type LucideIcon } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamStore } from "../../../state/teamStore";
import { teamInboxes, type TeamAgentInbox, type TeamInboxEntry } from "../../../lib/tauri/teamCommands";
import { AgentAvatar } from "../kit/Avatar";
import { Btn, Empty, SOFT, ToggleChip } from "../kit/ui";
import { ago } from "../kit/time";
import { useCrewStore, useL } from "../state";

type L = (es: string, en: string) => string;
/** How many rows a card shows before «ver más». */
const SHOWN = 5;

function entryLook(kind: TeamInboxEntry["kind"], l: L): { icon: LucideIcon; color: string; label: string; spin?: boolean } {
  switch (kind) {
    case "question":
      return { icon: CircleHelp, color: "var(--cf-warning)", label: l("Te preguntó", "Asked you") };
    case "failure":
      return { icon: XCircle, color: "var(--cf-danger)", label: l("Falló", "Failed") };
    case "gate":
      return { icon: Hand, color: "var(--cf-warning)", label: l("Espera", "Waiting") };
    case "task":
      return { icon: Loader2, color: "var(--cf-accent)", label: l("Trabajando", "Working"), spin: true };
    case "note":
      return { icon: Mail, color: "var(--cf-blue)", label: l("Mensaje sin leer", "Unread message") };
    case "queued":
      return { icon: Hourglass, color: "var(--cf-text-faint)", label: l("Sigue", "Next") };
    default:
      return { icon: Kanban, color: "var(--cf-text-faint)", label: l("Tarjeta", "Card") };
  }
}

function Tally({ value, label, color, title }: { value: number; label: string; color: string; title: string }) {
  const on = value > 0;
  return (
    <span title={title} className="flex min-w-0 flex-1 flex-col rounded-[9px] px-2 py-1.5" style={{ background: on ? `color-mix(in oklab, ${color} 9%, transparent)` : "var(--cf-sunken)" }}>
      <b className="text-[15px] leading-none tabular-nums" style={{ color: on ? color : "var(--cf-text-faint)" }}>{value}</b>
      <span className="mt-1 truncate text-[10.5px] leading-none text-[var(--cf-text-muted)]">{label}</span>
    </span>
  );
}

function EntryRow({ entry }: { entry: TeamInboxEntry }) {
  const l = useL();
  const crew = useCrewStore();
  const look = entryLook(entry.kind, l);
  const Icon = look.icon;
  const open = () => {
    if (entry.kind === "card") {
      crew.setSpace("tablero");
      crew.open({ kind: "card", id: entry.cardId });
      return;
    }
    if (entry.kind === "note" && entry.memberId) {
      crew.open({ kind: "chat", runId: entry.runId, memberId: entry.memberId });
      return;
    }
    crew.setSpace("en-vivo");
    void useTeamStore.getState().select(entry.runId);
  };
  const where = entry.kind === "card" ? l("En el tablero", "On the board") : entry.runTitle;
  return (
    <li className="border-t border-[var(--cf-border)] first:border-t-0">
      <button
        type="button"
        onClick={open}
        title={entry.kind === "card" ? l("Abre la tarjeta", "Opens the card") : entry.kind === "note" ? l("Abre su conversación en esa corrida", "Opens its conversation in that run") : l("Abre la corrida", "Opens the run")}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-[var(--cf-hover)]"
      >
        <span className="mt-[1px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full" style={{ background: `color-mix(in oklab, ${look.color} 14%, transparent)`, color: look.color }}>
          <Icon className={`h-3 w-3 ${look.spin ? "animate-spin [animation-duration:2.4s]" : ""}`} strokeWidth={2.4} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] leading-snug text-[var(--cf-text)]">{entry.title}</span>
          {entry.detail && <span className="line-clamp-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{entry.detail}</span>}
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-faint)]">
            <span style={{ color: ["question", "failure", "gate"].includes(entry.kind) ? look.color : undefined }}>{look.label}</span>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate">{where}</span>
            {entry.at && <><span aria-hidden>·</span><span className="shrink-0 whitespace-nowrap">{ago(entry.at, l)}</span></>}
          </span>
        </span>
      </button>
    </li>
  );
}

function InboxCard({ inbox }: { inbox: TeamAgentInbox }) {
  const l = useL();
  const agent = useAgentsStore((s) => s.roster.find((a) => a.id === inbox.agentId));
  const [all, setAll] = useState(false);
  const shown = all ? inbox.entries : inbox.entries.slice(0, SHOWN);
  const rest = inbox.entries.length - shown.length;
  const state = inbox.working > 0 ? "thinking" : inbox.waiting > 0 ? "waiting" : "idle";
  return (
    <motion.article layout transition={SOFT} className={`flex min-w-0 flex-col gap-2.5 rounded-[14px] border bg-[var(--cf-surface-raised)] p-3 ${inbox.waiting > 0 ? "border-[color-mix(in_oklab,var(--cf-warning)_55%,var(--cf-border))]" : "border-[var(--cf-border)]"}`}>
      <header className="flex items-center gap-2.5">
        {agent ? <AgentAvatar agent={agent} size={34} state={state} /> : <span className="h-[34px] w-[34px] shrink-0 rounded-[10px] bg-[var(--cf-sunken)]" />}
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px]" title={inbox.name}>{inbox.name}</b>
          <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]" title={inbox.teams.join(", ")}>
            {inbox.teams.length > 0 ? inbox.teams.join(" · ") : l("Sin equipo", "In no team")}
            <span className="text-[var(--cf-text-faint)]"> · {inbox.model}</span>
          </span>
        </span>
      </header>
      <div className="flex gap-1.5">
        <Tally value={inbox.waiting} label={l("Te esperan", "Wait on you")} color="var(--cf-warning)" title={l("Preguntas que hizo, tareas suyas que fallaron y aprobaciones pendientes", "Questions it asked, tasks of its that failed and pending approvals")} />
        <Tally value={inbox.working} label={l("En curso", "In hand")} color="var(--cf-accent)" title={l("Tareas en las que trabaja ahora", "Tasks it is working on now")} />
        <Tally value={inbox.queued} label={l("Siguen", "Up next")} color="var(--cf-text-muted)" title={l("Tareas y tarjetas asignadas que aún no empieza", "Assigned tasks and cards it has not started")} />
      </div>
      {inbox.entries.length === 0 ? (
        <span className="flex items-center gap-1.5 rounded-[9px] border border-dashed border-[var(--cf-border-strong)] px-2.5 py-2 text-[11.5px] text-[var(--cf-text-faint)]">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {l("Nada en su bandeja", "Nothing in its inbox")}
        </span>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-[9px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-0">
          {shown.map((entry, index) => <EntryRow key={`${entry.kind}:${entry.itemId}:${entry.messageId}:${entry.cardId}:${index}`} entry={entry} />)}
          {(rest > 0 || all) && inbox.entries.length > SHOWN && (
            <li className="border-t border-[var(--cf-border)]">
              <button type="button" onClick={() => setAll(!all)} className="w-full px-2.5 py-1.5 text-left text-[11.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]">
                {all ? l("Ver menos", "Show fewer") : rest === 1 ? l("Ver 1 más", "Show 1 more") : l(`Ver ${rest} más`, `Show ${rest} more`)}
              </button>
            </li>
          )}
        </ul>
      )}
    </motion.article>
  );
}

/** How many entries, over every agent, wait on the user — the tab's badge. */
export function useInboxWaiting(): number {
  const workspaceId = useTeamStore((s) => s.workspaceId);
  const runs = useTeamStore((s) => s.runs);
  const pulse = useMemo(() => runs.map((run) => `${run.id}:${run.status}:${run.gate}`).join("|"), [runs]);
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!workspaceId) return;
    let gone = false;
    void teamInboxes(workspaceId)
      .then((all) => !gone && setWaiting(all.reduce((n, inbox) => n + inbox.waiting, 0)))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [workspaceId, pulse]);
  return waiting;
}

export function InboxBoard({ query }: { query: string }) {
  const l = useL();
  const workspaceId = useTeamStore((s) => s.workspaceId);
  const runs = useTeamStore((s) => s.runs);
  const [inboxes, setInboxes] = useState<TeamAgentInbox[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyOnly, setBusyOnly] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setInboxes(await teamInboxes(workspaceId));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setInboxes(null);
    void load();
  }, [load]);

  const pulse = useMemo(() => runs.map((run) => `${run.id}:${run.status}:${run.gate}:${run.updated_at}`).join("|"), [runs]);
  useEffect(() => {
    if (inboxes !== null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulse]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (inboxes ?? [])
      .filter((inbox) => !busyOnly || inbox.entries.length > 0)
      .filter((inbox) => !q || `${inbox.name} ${inbox.role} ${inbox.model} ${inbox.teams.join(" ")} ${inbox.entries.map((e) => `${e.title} ${e.runTitle}`).join(" ")}`.toLowerCase().includes(q));
  }, [inboxes, query, busyOnly]);

  if (inboxes === null) {
    return error ? (
      <Empty icon={AlertTriangle} title={l("No se pudieron leer las bandejas", "The inboxes could not be read")} hint={error}>
        <Btn kind="primary" icon={RefreshCw} onClick={() => void load()}>{l("Reintentar", "Retry")}</Btn>
      </Empty>
    ) : (
      <div className="grid flex-1 place-items-center text-[12px] text-[var(--cf-text-muted)]">{l("Cargando bandejas…", "Loading inboxes…")}</div>
    );
  }
  if (inboxes.length === 0) {
    return <Empty icon={Inbox} title={l("Todavía no hay agentes", "No agents yet")} hint={l("Cuando crees agentes, aquí verás qué tiene cada uno entre manos y qué espera de ti.", "Once you create agents, you will see here what each has in hand and what it waits on you for.")} />;
  }
  const waiting = inboxes.reduce((n, inbox) => n + inbox.waiting, 0);
  const working = inboxes.filter((inbox) => inbox.working > 0).length;
  const idle = inboxes.filter((inbox) => inbox.entries.length === 0).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 text-[11.5px] text-[var(--cf-text-muted)]">
        <span>
          {waiting === 0 ? l("Nada te espera", "Nothing waits on you") : waiting === 1 ? l("1 cosa te espera", "1 thing waits on you") : l(`${waiting} cosas te esperan`, `${waiting} things wait on you`)}
          {" · "}
          {working === 1 ? l("1 agente trabajando", "1 agent working") : l(`${working} agentes trabajando`, `${working} agents working`)}
          {" · "}
          {idle === 1 ? l("1 libre", "1 free") : l(`${idle} libres`, `${idle} free`)}
        </span>
        <span className="flex-1" />
        <ToggleChip on={busyOnly} onClick={() => setBusyOnly(!busyOnly)} title={l("Muestra solo los agentes que tienen algo en su bandeja", "Shows only the agents with something in their inbox")}>{l("Solo con algo", "Only with something")}</ToggleChip>
        <Btn small kind="ghost" icon={RefreshCw} disabled={loading} title={l("Vuelve a leer las bandejas", "Reads the inboxes again")} onClick={() => void load()}>{l("Actualizar", "Refresh")}</Btn>
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(min(310px,100%),1fr))] items-start gap-3 overflow-y-auto p-4 pt-3">
        {shown.map((inbox) => <InboxCard key={inbox.agentId} inbox={inbox} />)}
        {shown.length === 0 && <p className="col-span-full m-0 p-6 text-center text-[12.5px] text-[var(--cf-text-muted)]">{busyOnly ? l("Ningún agente tiene algo pendiente.", "No agent has anything pending.") : l("Ningún agente coincide.", "No agent matches.")}</p>}
      </div>
    </div>
  );
}
