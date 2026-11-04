import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Bug, BookOpen, Coins, Download, Flag, FolderGit2, Hand, Link2, ListChecks, MessageSquare, Plus, RefreshCw, Search, SquareCheckBig } from "lucide-react";
import { useBacklogStore } from "../../../state/backlogStore";
import { useTicketStore } from "../../../state/ticketStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamStore } from "../../../state/teamStore";
import { useChainStore } from "../../../state/chainStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { ticketUid } from "../../../lib/tickets/ticketKeys";
import { rankBetween, workState } from "../../../lib/backlog/status";
import { emptyBacklogItem, type BacklogItem, type BacklogKind, type BacklogStatus } from "../../../types/crew";
import type { Ticket } from "../../../lib/tauri/ticketCommands";
import { AgentAvatar, AvatarStack, TeamAvatar } from "../kit/Avatar";
import { useDragSource, useDropTarget, type DragPayload } from "../kit/drag";
import { Btn, Chip, ToggleChip, field } from "../kit/ui";
import { activeAgents, money, useCrewStore, useL } from "../state";

const COLUMNS: { id: BacklogStatus; es: string; en: string; color: string }[] = [
  { id: "backlog", es: "Backlog", en: "Backlog", color: "var(--cf-text-faint)" },
  { id: "ready", es: "Listo", en: "Ready", color: "var(--cf-agent-cyan)" },
  { id: "doing", es: "En curso", en: "Doing", color: "var(--cf-accent)" },
  { id: "review", es: "Revisión", en: "Review", color: "var(--cf-warning)" },
  { id: "done", es: "Hecho", en: "Done", color: "var(--cf-success)" },
];

function KindChip({ kind }: { kind: BacklogKind }) {
  const l = useL();
  if (kind === "story") return <Chip tone="violet" icon={BookOpen}>{l("HU", "Story")}</Chip>;
  if (kind === "bug") return <Chip tone="bad" icon={Bug}>Bug</Chip>;
  return <Chip tone="info" icon={SquareCheckBig}>{l("Tarea", "Task")}</Chip>;
}

function useWork() {
  const tasks = useAgentsStore((s) => s.tasks);
  const live = useAgentsStore((s) => s.live);
  const chains = useChainStore((s) => s.chains);
  const runs = useTeamStore((s) => s.runs);
  const states = useTeamStore((s) => s.states);
  return useMemo(
    () => ({
      index: {
        tasks: new Map(tasks.map((t) => [t.id, t])),
        chains: new Map(chains.map((c) => [c.id, c])),
        runs: new Map(runs.map((r) => [r.id, r])),
        sending: new Set(Object.entries(live).filter(([, v]) => v.sending).map(([id]) => id)),
      },
      states,
      tasks,
    }),
    [tasks, live, chains, runs, states],
  );
}

function CardView({ item }: { item: BacklogItem }) {
  const l = useL();
  const crew = useCrewStore();
  const roster = useAgentsStore((s) => s.roster);
  const teams = useTeamStore((s) => s.teams);
  const work = useWork();
  const items = useBacklogStore((s) => s.items);
  const drag = useDragSource({ kind: "card", id: item.id }, () => (
    <div className="w-[250px] rounded-[11px] border border-[var(--cf-accent)] bg-[var(--cf-surface-raised)] p-2.5 text-[13px] font-semibold">{item.title}</div>
  ));
  const drop = useDropTarget(
    `card:${item.id}`,
    (p) => p.kind === "agent" || p.kind === "team" || (p.kind === "card" && p.id !== item.id),
    (p) => onDropOnCard(p, item),
  );

  const state = workState(item, work.index);
  const running = state === "live";
  const needsYou = state === "needs-you";
  const done = item.criteria.filter((c) => c.done).length;
  const subtasks = items.filter((i) => i.parent_id === item.id).length;
  const runLinks = item.links.filter((lnk) => lnk.kind === "team_run");
  const taskLinks = item.links.filter((lnk) => lnk.kind === "task" || lnk.kind === "race");
  const active = runLinks.flatMap((lnk) => activeAgents(work.states[lnk.ref_id]));
  const activeShown = [...new Set(active)].map((id) => roster.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const cost = taskLinks.reduce((sum, lnk) => sum + (work.index.tasks.get(lnk.ref_id)?.cost_usd ?? 0), 0);
  const progress = (() => {
    const run = runLinks.map((lnk) => work.states[lnk.ref_id]).find(Boolean);
    if (run) {
      const items = run.items.filter((i) => !["plan", "final", "answer", "advise"].includes(i.kind));
      return items.length ? items.filter((i) => i.status === "done").length / items.length : 0.05;
    }
    return null;
  })();
  const agent = item.assignee_kind === "agent" ? roster.find((a) => a.id === item.assignee_id) : null;
  const team = item.assignee_kind === "team" ? teams.find((t) => t.id === item.assignee_id) : null;

  return (
    <motion.article
      layout
      layoutId={`card-${item.id}`}
      {...drag}
      {...drop.props}
      onClick={() => crew.open({ kind: "card", id: item.id })}
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && crew.open({ kind: "card", id: item.id })}
      className={`relative flex cursor-grab touch-none flex-col gap-1.5 rounded-[11px] border bg-[var(--cf-surface-raised)] p-2.5 transition-shadow hover:shadow-[var(--cf-shadow)] active:cursor-grabbing ${
        running ? "cf-crew-working border-[var(--cf-accent-line)]" : "border-[var(--cf-border)] hover:border-[var(--cf-border-strong)]"
      }`}
      style={{ ["--cf-crew-c" as string]: "var(--cf-accent)" }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <KindChip kind={item.kind} />
        {item.priority > 0 && (
          <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${item.priority >= 3 ? "text-[var(--cf-danger)]" : item.priority === 2 ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-faint)]"}`}>
            <Flag className="h-3 w-3" />P{4 - item.priority}
          </span>
        )}
        {item.ticket && (
          <span className="inline-flex items-center gap-0.5 font-mono text-[10.5px] text-[var(--cf-text-muted)]">
            <Link2 className="h-3 w-3" />
            {item.ticket.key}
          </span>
        )}
        {needsYou && <Chip tone="warn" icon={Hand} className="ml-auto">{l("Te necesita", "Needs you")}</Chip>}
      </div>
      <h4 className="m-0 text-[13px] font-semibold leading-snug">{item.title}</h4>
      {(item.criteria.length > 0 || item.repos.length > 0 || subtasks > 0 || cost > 0) && (
        <div className="flex flex-wrap items-center gap-2.5 text-[11.5px] text-[var(--cf-text-muted)]">
          {item.criteria.length > 0 && <span className="inline-flex items-center gap-1"><ListChecks className="h-3.5 w-3.5" />{done}/{item.criteria.length}</span>}
          {subtasks > 0 && <span className="inline-flex items-center gap-1"><SquareCheckBig className="h-3.5 w-3.5" />{subtasks}</span>}
          {item.repos.length > 0 && <span className="inline-flex items-center gap-1"><FolderGit2 className="h-3.5 w-3.5" />{item.repos.length}</span>}
          {runLinks.length > 0 && <span className="inline-flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5" />{runLinks.reduce((n, lnk) => n + (work.states[lnk.ref_id]?.messages.length ?? 0), 0)}</span>}
          {cost > 0 && <span className="inline-flex items-center gap-1"><Coins className="h-3.5 w-3.5" />{money(cost)}</span>}
        </div>
      )}
      {progress !== null && item.status !== "done" && (
        <div className="h-[5px] overflow-hidden rounded-full bg-[var(--cf-border)]">
          <motion.i className="block h-full rounded-full bg-[linear-gradient(90deg,var(--cf-accent),var(--cf-agent-cyan))]" animate={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {activeShown.length > 0 && <AvatarStack agents={activeShown} size={20} />}
        <span className="flex-1" />
        {agent ? (
          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold"><AgentAvatar agent={agent} size={20} />{agent.name}</span>
        ) : team ? (
          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold"><TeamAvatar size={20} />{team.name}</span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--cf-border-strong)] px-2 py-0.5 text-[11.5px] text-[var(--cf-text-faint)]"><Hand className="h-3 w-3" />{l("Sin asignar", "Unassigned")}</span>
        )}
      </div>
      {drop.over && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-[11px] border-2 border-dashed border-[var(--cf-accent)] bg-[color-mix(in_oklab,var(--cf-accent)_14%,var(--cf-surface))] text-[12.5px] font-semibold text-[var(--cf-accent)]">
          {l("Soltar para asignar", "Drop to assign")}
        </div>
      )}
    </motion.article>
  );
}

function onDropOnCard(p: DragPayload, target: BacklogItem) {
  const crew = useCrewStore.getState();
  if (p.kind === "agent" || p.kind === "team") {
    crew.open({ kind: "launch", cardId: target.id, assignee: { kind: p.kind, id: p.id } });
    return;
  }
  if (p.kind === "card") moveInto(p.id, target.status, target.id);
}

/** Moves a card to a column, before `beforeId` or last. Dropped on «doing», an assigned card
 * starts with what its assignment says; an unassigned one asks who. */
function moveInto(cardId: string, status: BacklogStatus, beforeId: string | null) {
  const store = useBacklogStore.getState();
  const card = store.items.find((i) => i.id === cardId);
  if (!card) return;
  if (status === "doing" && card.status !== "doing" && card.links.length === 0) {
    useCrewStore.getState().open({ kind: "launch", cardId: card.id, assignee: card.assignee_kind ? { kind: card.assignee_kind, id: card.assignee_id } : undefined });
    return;
  }
  const column = store.items.filter((i) => i.status === status && !i.parent_id && i.id !== cardId).sort((a, b) => a.rank - b.rank);
  const at = beforeId ? column.findIndex((i) => i.id === beforeId) : -1;
  const rank = at >= 0 ? rankBetween(at > 0 ? column[at - 1].rank : null, column[at].rank) : rankBetween(column.length ? column[column.length - 1].rank : null, null);
  void store.move(cardId, status, rank);
}

function Column({ id, title, color, cards }: { id: BacklogStatus; title: string; color: string; cards: BacklogItem[] }) {
  const l = useL();
  const drop = useDropTarget(`col:${id}`, (p) => p.kind === "card" || (p.kind === "ticket" && id !== "doing"), (p) => {
    if (p.kind === "card") moveInto(p.id, id, null);
    if (p.kind === "ticket") void importTicket(p.id, id);
  });
  return (
    <section {...drop.props} className={`flex min-h-0 w-[272px] shrink-0 flex-col rounded-[12px] border bg-[var(--cf-sunken)] transition-colors ${drop.over ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"}`}>
      <header className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span className="h-2 w-2 rounded-[3px]" style={{ background: color }} />
        <h3 className="m-0 text-[12.5px] font-semibold">{title}</h3>
        <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">{cards.length}</span>
      </header>
      <div className="flex min-h-[60px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2.5 pt-1">
        {cards.map((c) => (
          <CardView key={c.id} item={c} />
        ))}
        {cards.length === 0 && <div className="rounded-[10px] border-[1.5px] border-dashed border-[var(--cf-border-strong)] px-2.5 py-4 text-center text-[12px] text-[var(--cf-text-faint)]">{l("Suelta aquí una tarjeta", "Drop a card here")}</div>}
      </div>
    </section>
  );
}

async function importTicket(uid: string, status: BacklogStatus) {
  const ticket = useTicketStore.getState().tickets.find((t) => ticketUid(t) === uid);
  if (!ticket) return;
  const kind: BacklogKind = /bug|defect|incid/i.test(ticket.work_item_type) ? "bug" : /story|historia|feature|epic/i.test(ticket.work_item_type) ? "story" : "task";
  const [card] = await useBacklogStore.getState().importTickets([
    { provider: ticket.provider, uid, key: ticket.key || `#${ticket.id}`, url: ticket.url, title: ticket.title, kind, body: "" },
  ]);
  if (card && status !== "backlog") await useBacklogStore.getState().move(card.id, status, card.rank);
}

function TicketView({ ticket }: { ticket: Ticket }) {
  const uid = ticketUid(ticket);
  const drag = useDragSource({ kind: "ticket", id: uid }, () => <div className="w-[240px] rounded-[11px] border border-[var(--cf-blue)] bg-[var(--cf-surface-raised)] p-2.5 text-[12.5px] font-semibold">{ticket.title}</div>);
  return (
    <article {...drag} title={ticket.state} className="flex cursor-grab touch-none flex-col gap-1.5 rounded-[11px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2.5 hover:border-[var(--cf-border-strong)] active:cursor-grabbing">
      <div className="flex items-center gap-1.5">
        <Chip tone={/bug/i.test(ticket.work_item_type) ? "bad" : "violet"}>{ticket.work_item_type || "Ticket"}</Chip>
        <span className="font-mono text-[10.5px] text-[var(--cf-text-muted)]">{ticket.key || `#${ticket.id}`}</span>
      </div>
      <h4 className="m-0 text-[12.5px] font-semibold leading-snug">{ticket.title}</h4>
    </article>
  );
}

function Inbox() {
  const l = useL();
  const tickets = useTicketStore((s) => s.tickets);
  const loading = useTicketStore((s) => s.loading);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const imported = useBacklogStore((s) => new Set(s.items.map((i) => i.ticket?.uid).filter(Boolean)));
  const pending = tickets.filter((t) => !imported.has(ticketUid(t)));
  const groups = new Map<string, Ticket[]>();
  for (const t of pending) groups.set(t.provider, [...(groups.get(t.provider) ?? []), t]);
  return (
    <section className="flex min-h-0 w-[262px] shrink-0 flex-col rounded-[12px] border border-dashed border-[var(--cf-border-strong)] bg-[color-mix(in_oklab,var(--cf-blue)_5%,var(--cf-sunken))]">
      <header className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <span className="h-2 w-2 rounded-[3px] bg-[var(--cf-blue)]" />
        <h3 className="m-0 text-[12.5px] font-semibold">{l("Entrada", "Inbox")}</h3>
        <span className="text-[11px] text-[var(--cf-text-faint)]">{pending.length}</span>
        <span className="flex-1" />
        <button type="button" title={l("Traer tickets", "Fetch tickets")} onClick={() => void useTicketStore.getState().refresh(workspaceId)} className="grid h-6 w-6 place-items-center rounded-[6px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>
      <p className="m-0 px-3 pb-1 text-[11.5px] text-[var(--cf-text-faint)]">{l("Tickets de tus tableros (Azure DevOps, Jira…). Arrástralos al backlog.", "Tickets from your boards (Azure DevOps, Jira…). Drag them into the backlog.")}</p>
      <div className="flex min-h-[60px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2.5 pt-1">
        {[...groups.entries()].map(([provider, list]) => (
          <div key={provider} className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5 px-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--cf-text-muted)]">
              <Download className="h-3 w-3" />
              {provider}
            </span>
            {list.slice(0, 40).map((t) => (
              <TicketView key={ticketUid(t)} ticket={t} />
            ))}
          </div>
        ))}
        {pending.length === 0 && <div className="rounded-[10px] border-[1.5px] border-dashed border-[var(--cf-border-strong)] px-2.5 py-4 text-center text-[12px] text-[var(--cf-text-faint)]">{l("Sin tickets nuevos", "No new tickets")}</div>}
      </div>
    </section>
  );
}

export function BoardSpace() {
  const l = useL();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const items = useBacklogStore((s) => s.items);
  const roster = useAgentsStore((s) => s.roster);
  const teams = useTeamStore((s) => s.teams);
  const crew = useCrewStore();
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const selectedTicket = useTicketStore((s) => s.selectedUid);

  // The sidebar's ticket chip «reveals» a ticket here: open its card, importing it if needed.
  useEffect(() => {
    if (!selectedTicket) return;
    const card = useBacklogStore.getState().items.find((i) => i.ticket?.uid === selectedTicket);
    if (card) crew.open({ kind: "card", id: card.id });
    else void importTicket(selectedTicket, "backlog");
    useTicketStore.setState({ selectedUid: null });
  }, [selectedTicket, crew]);

  const assignees = [...new Set(items.filter((i) => i.assignee_kind).map((i) => `${i.assignee_kind}:${i.assignee_id}`))];
  const visible = items
    .filter((i) => !i.parent_id)
    .filter((i) => filter === "all" || (filter === "none" ? !i.assignee_kind : `${i.assignee_kind}:${i.assignee_id}` === filter))
    .filter((i) => !query.trim() || `${i.title} ${i.body} ${i.ticket?.key ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  const create = async (kind: BacklogKind) => {
    if (!workspaceId) return;
    const saved = await useBacklogStore.getState().save({ ...emptyBacklogItem(workspaceId, kind), title: kind === "story" ? l("Nueva historia", "New story") : l("Nueva tarea", "New task") });
    if (saved) crew.open({ kind: "card", id: saved.id });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3.5 py-2.5">
        <ToggleChip on={filter === "all"} onClick={() => setFilter("all")}>{l("Todo", "All")}</ToggleChip>
        <ToggleChip on={filter === "none"} onClick={() => setFilter("none")}>{l("Sin asignar", "Unassigned")}</ToggleChip>
        {assignees.slice(0, 6).map((key) => {
          const [kind, id] = key.split(":");
          const name = kind === "team" ? teams.find((t) => t.id === id)?.name : roster.find((a) => a.id === id)?.name;
          if (!name) return null;
          return <ToggleChip key={key} on={filter === key} onClick={() => setFilter(key)}>{name}</ToggleChip>;
        })}
        <div className="relative ml-1 w-[200px]">
          <Search className="absolute left-2.5 top-[7px] h-4 w-4 text-[var(--cf-text-faint)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={l("Buscar", "Search")} className={`${field} h-[30px] pl-8`} />
        </div>
        <span className="flex-1" />
        <Btn small icon={Plus} onClick={() => void create("story")}>{l("Historia", "Story")}</Btn>
        <Btn small icon={Plus} onClick={() => void create("task")}>{l("Tarea", "Task")}</Btn>
      </div>
      <div className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-3.5">
        <Inbox />
        {COLUMNS.map((c) => (
          <Column key={c.id} id={c.id} title={l(c.es, c.en)} color={c.color} cards={visible.filter((i) => i.status === c.id).sort((a, b) => a.rank - b.rank)} />
        ))}
      </div>
    </div>
  );
}
