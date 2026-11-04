/**
 * One card of the board, opened: what it asks for, who has it, the work started from it and who is
 * on it right now. Edits save as you type; the linked work opens where it lives (a task's chat, a
 * chain's run, a team run in «En vivo»), and a member at work opens its own chat.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  BookOpen,
  Bug,
  ExternalLink,
  FileText,
  Flag,
  FolderGit2,
  GitBranch,
  Link2,
  ListChecks,
  MessageSquare,
  Plus,
  SquareCheckBig,
  Tag,
  Trash2,
  Trophy,
  WandSparkles,
  Workflow,
  X,
} from "lucide-react";
import { useBacklogStore } from "../../../state/backlogStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useTeamStore } from "../../../state/teamStore";
import { useChainStore } from "../../../state/chainStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { confirmAction } from "../../../state/confirmStore";
import { openExternalUrl } from "../../../lib/tauri/commands";
import { teamRunArtifacts } from "../../../lib/tauri/teamCommands";
import type { ChatArtifactSummary } from "../../../lib/tauri/chatRefsCommands";
import { ArtifactViewer, artifactIcon } from "../../chat/ArtifactViewer";
import { emptyBacklogItem, type BacklogItem, type BacklogKind, type BacklogLink, type Criterion } from "../../../types/crew";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { Btn, Chip, Drawer, IconBtn, Label, Seg, ToggleChip, field, type Tone } from "../kit/ui";
import { Checkbox } from "../../common/Checkbox";
import { fieldClass } from "../../common/recipes";
import { money, useCrewStore, useL } from "../state";

const NO_PROJECTS: never[] = [];

const STATUS_LABEL: Record<string, [string, string]> = {
  draft: ["Borrador", "Draft"],
  running: ["Trabajando", "Working"],
  idle: ["Para revisar", "To review"],
  done: ["Hecho", "Done"],
  error: ["Error", "Error"],
  cancelled: ["Cancelado", "Cancelled"],
  queued: ["En cola", "Queued"],
  gated: ["Te espera", "Waiting on you"],
  paused: ["En pausa", "Paused"],
  failed: ["Falló", "Failed"],
  aborted: ["Cancelado", "Aborted"],
};

function useSaver(item: BacklogItem | undefined) {
  const [draft, setDraft] = useState<BacklogItem | undefined>(item);
  const timer = useRef<number | null>(null);
  const pending = useRef<BacklogItem | null>(null);
  const id = item?.id;

  useEffect(() => {
    setDraft(item);
    // Only when a different card opens: the store's echo of our own save must not undo typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const flush = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    // Links and the column are the store's: the work moves them, not this form.
    const stored = useBacklogStore.getState().items.find((x) => x.id === next.id);
    void useBacklogStore.getState().save(stored ? { ...next, links: stored.links, status: stored.status, rank: stored.rank } : next);
  };

  useEffect(() => flush, []);

  const patch = (p: Partial<BacklogItem>, now = false) => {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, ...p };
      pending.current = next;
      return next;
    });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, now ? 0 : 450);
  };

  return { draft, patch, flush };
}

function LinkRow({ link }: { link: BacklogLink }) {
  const l = useL();
  const crew = useCrewStore();
  const task = useAgentsStore((s) => (link.kind === "task" || link.kind === "race" ? s.tasks.find((t) => t.id === link.ref_id) : undefined));
  const chain = useChainStore((s) => (link.kind === "chain" ? s.chains.find((c) => c.id === link.ref_id) : undefined));
  const run = useTeamStore((s) => (link.kind === "team_run" ? s.runs.find((r) => r.id === link.ref_id) : undefined));

  const title = task?.title || task?.goal || chain?.title || chain?.goal || run?.title || run?.goal || l("(ya no existe)", "(no longer exists)");
  const status = task?.status ?? chain?.status ?? run?.status ?? "";
  const tone: Tone = ["running", "queued"].includes(status) ? "accent" : ["gated", "paused"].includes(status) ? "warn" : ["error", "failed", "aborted"].includes(status) ? "bad" : status === "done" ? "ok" : "neutral";
  const Icon = link.kind === "team_run" ? Activity : link.kind === "chain" ? Workflow : link.kind === "race" ? Trophy : MessageSquare;
  const kindLabel =
    link.kind === "team_run" ? l("Equipo", "Team") : link.kind === "chain" ? l("Flujo", "Flow") : link.kind === "race" ? l("Carrera", "Race") : l("Tarea", "Task");

  const open = () => {
    if (task) crew.open({ kind: "task", id: task.id });
    else if (chain) crew.open({ kind: "chain", id: chain.id });
    else if (run) {
      crew.close();
      crew.setSpace("en-vivo");
      void useTeamStore.getState().select(run.id);
    }
  };

  return (
    <button
      type="button"
      onClick={open}
      title={l("Abre este trabajo", "Opens this work")}
      disabled={!task && !chain && !run}
      className="flex w-full items-center gap-2.5 rounded-[9px] border border-[var(--cf-border)] px-2.5 py-2 text-left hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-hover)] disabled:opacity-60"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium">{title}</span>
        <span className="block text-[11px] text-[var(--cf-text-faint)]">
          {kindLabel}
          {task?.cost_usd ? ` · ${money(task.cost_usd)}` : ""}
          {task?.agent_name ? ` · ${task.agent_name}` : ""}
        </span>
      </span>
      {status && <Chip tone={tone}>{l(...(STATUS_LABEL[status] ?? [status, status]))}</Chip>}
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-faint)]" />
    </button>
  );
}

/** Members of the card's team runs with an item in flight or waiting: one click opens their chat. */
function WorkingNow({ item }: { item: BacklogItem }) {
  const l = useL();
  const crew = useCrewStore();
  const states = useTeamStore((s) => s.states);
  const roster = useAgentsStore((s) => s.roster);
  const rows = useMemo(() => {
    const out: { runId: string; memberId: string; name: string; agentId: string; icon: string; color: string; title: string; waiting: boolean }[] = [];
    for (const link of item.links) {
      if (link.kind !== "team_run") continue;
      const state = states[link.ref_id];
      if (!state) continue;
      for (const it of state.items) {
        if (it.status !== "running" && it.status !== "waiting") continue;
        const member = state.run.members.find((m) => m.id === it.member_id);
        if (!member || out.some((o) => o.runId === state.run.id && o.memberId === member.id)) continue;
        const agent = roster.find((a) => a.id === member.agent_id);
        out.push({
          runId: state.run.id,
          memberId: member.id,
          name: member.name || agent?.name || "",
          agentId: member.agent_id,
          icon: member.icon || agent?.icon || "",
          color: member.color || agent?.color || "",
          title: it.title,
          waiting: it.status === "waiting",
        });
      }
    }
    return out;
  }, [item.links, states, roster]);

  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <Label>{l("Trabajando ahora", "Working now")}</Label>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <motion.button
            key={`${row.runId}:${row.memberId}`}
            type="button"
            layout
            onClick={() => crew.open({ kind: "chat", runId: row.runId, memberId: row.memberId })}
            title={l(`Abre el chat de ${row.name}`, `Opens ${row.name}'s chat`)}
            className="flex items-center gap-2.5 rounded-[10px] border border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)] px-2.5 py-2 text-left hover:brightness-[1.03]"
          >
            <AgentAvatar agent={{ id: row.agentId, icon: row.icon, color: row.color }} size={30} state={row.waiting ? "waiting" : "thinking"} />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-[12.5px]">{row.name}</b>
              <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">{row.title}</span>
            </span>
            <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--cf-accent)]">
              <MessageSquare className="h-3.5 w-3.5" />
              {l("Su chat", "Chat")}
            </span>
          </motion.button>
        ))}
      </div>
    </section>
  );
}

function Artifacts({ item }: { item: BacklogItem }) {
  const l = useL();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const runIds = item.links.filter((lnk) => lnk.kind === "team_run").map((lnk) => lnk.ref_id);
  const key = runIds.join(",");
  const messages = useTeamStore((s) => runIds.reduce((n, id) => n + (s.states[id]?.messages.length ?? 0), 0));
  const [list, setList] = useState<ChatArtifactSummary[]>([]);
  const [open, setOpen] = useState<ChatArtifactSummary | null>(null);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    void Promise.all(key.split(",").map((id) => teamRunArtifacts(id).catch(() => [] as ChatArtifactSummary[]))).then((lists) => {
      if (alive) setList(lists.flat());
    });
    return () => {
      alive = false;
    };
  }, [key, messages]);

  if (list.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <Label>{l("Artefactos del equipo", "Team artifacts")}</Label>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {list.map((a) => {
          const Icon = artifactIcon(a.kind);
          return (
            <button key={a.id} type="button" title={l("Ver el artefacto", "View the artifact")} onClick={() => setOpen(a)} className="flex items-center gap-2 rounded-[9px] border border-[var(--cf-border)] px-2.5 py-2 text-left hover:border-[var(--cf-border-strong)] hover:bg-[var(--cf-hover)]">
              <Icon className="h-4 w-4 shrink-0 text-[var(--cf-violet)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{a.title || a.name}</span>
                <span className="block truncate font-mono text-[10.5px] text-[var(--cf-text-faint)]">
                  {a.name} · v{a.version}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {open && <ArtifactViewer workspaceId={workspaceId} name={open.name} projectId={open.project_id} onClose={() => setOpen(null)} />}
    </section>
  );
}

function Criteria({ criteria, onChange }: { criteria: Criterion[]; onChange: (next: Criterion[]) => void }) {
  const l = useL();
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t) return;
    onChange([...criteria, { id: crypto.randomUUID(), text: t, done: false }]);
    setText("");
  };
  const done = criteria.filter((c) => c.done).length;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Label>{l("Criterios de aceptación", "Acceptance criteria")}</Label>
        {criteria.length > 0 && <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">{done}/{criteria.length}</span>}
      </div>
      <div className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
          {criteria.map((c) => (
            <motion.div key={c.id} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="group flex items-center gap-2 rounded-[8px] px-1 py-1 hover:bg-[var(--cf-hover)]">
              <span title={c.done ? l("Marcar como pendiente", "Mark as pending") : l("Marcar como cumplido", "Mark as met")}>
                <Checkbox checked={c.done} onChange={(done) => onChange(criteria.map((x) => (x.id === c.id ? { ...x, done } : x)))} />
              </span>
              <input
                value={c.text}
                onChange={(e) => onChange(criteria.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)))}
                className={`min-w-0 flex-1 bg-transparent text-[12.5px] outline-none ${c.done ? "text-[var(--cf-text-muted)] line-through" : ""}`}
              />
              <IconBtn title={l("Quitar el criterio", "Remove the criterion")} icon={X} onClick={() => onChange(criteria.filter((x) => x.id !== c.id))} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <div className="flex gap-1.5">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={l("Dado… cuando… entonces…", "Given… when… then…")} className={field} />
        <Btn icon={Plus} onClick={add} disabled={!text.trim()} title={l("Añade el criterio (Enter)", "Adds the criterion (Enter)")}>{l("Añadir", "Add")}</Btn>
      </div>
    </section>
  );
}

function Subtasks({ parent }: { parent: BacklogItem }) {
  const l = useL();
  const crew = useCrewStore();
  const items = useBacklogStore((s) => s.items);
  const children = useMemo(() => items.filter((i) => i.parent_id === parent.id), [items, parent.id]);
  const [text, setText] = useState("");
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    await useBacklogStore.getState().save({
      ...emptyBacklogItem(parent.workspace_id, "task"),
      parent_id: parent.id,
      title: t,
      repos: parent.repos,
      status: parent.status === "done" ? "backlog" : parent.status === "doing" || parent.status === "review" ? "ready" : parent.status,
    });
  };
  if (parent.kind !== "story" && children.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <Label>{l("Subtareas", "Subtasks")}</Label>
      {children.map((child) => (
        <button key={child.id} type="button" title={l("Abre la subtarea", "Opens the subtask")} onClick={() => crew.open({ kind: "card", id: child.id })} className="flex items-center gap-2 rounded-[8px] border border-[var(--cf-border)] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-[var(--cf-hover)]">
          <SquareCheckBig className={`h-3.5 w-3.5 ${child.status === "done" ? "text-[var(--cf-success)]" : "text-[var(--cf-text-faint)]"}`} />
          <span className={`min-w-0 flex-1 truncate ${child.status === "done" ? "text-[var(--cf-text-muted)] line-through" : ""}`}>{child.title}</span>
          <Chip>{child.status}</Chip>
        </button>
      ))}
      <div className="flex gap-1.5">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} placeholder={l("Una tarea de esta historia", "A task of this story")} className={field} />
        <Btn icon={Plus} onClick={() => void add()} disabled={!text.trim()} title={l("Crea la subtarea en esta historia (Enter)", "Creates the subtask in this story (Enter)")}>{l("Crear", "Create")}</Btn>
      </div>
    </section>
  );
}

export function CardDrawer({ cardId }: { cardId: string }) {
  const l = useL();
  const crew = useCrewStore();
  const stored = useBacklogStore((s) => s.items.find((i) => i.id === cardId));
  const { draft, patch, flush } = useSaver(stored);
  const roster = useAgentsStore((s) => s.roster);
  const teams = useTeamStore((s) => s.teams);
  const projects = useWorkspaceStore((s) => (s.activeWorkspaceId ? s.projectsByWorkspace[s.activeWorkspaceId] ?? NO_PROJECTS : NO_PROJECTS));
  const tasks = useAgentsStore((s) => s.tasks);
  const [labelText, setLabelText] = useState("");

  useEffect(() => {
    if (!stored && useBacklogStore.getState().loaded) crew.close();
  }, [stored, crew]);

  if (!draft || !stored) return null;
  const item = { ...draft, links: stored.links, status: stored.status };
  const close = () => {
    flush();
    crew.close();
  };
  const agent = item.assignee_kind === "agent" ? roster.find((a) => a.id === item.assignee_id) : null;
  const team = item.assignee_kind === "team" ? teams.find((t) => t.id === item.assignee_id) : null;
  const cost = item.links.reduce((sum, lnk) => sum + (lnk.kind === "task" || lnk.kind === "race" ? tasks.find((t) => t.id === lnk.ref_id)?.cost_usd ?? 0 : 0), 0);
  const manual = item.status === "backlog" || item.status === "ready";

  const launch = () => {
    flush();
    crew.open({
      kind: "launch",
      cardId: item.id,
      assignee: item.assignee_kind ? { kind: item.assignee_kind, id: item.assignee_id } : undefined,
    });
  };
  const remove = async () => {
    const ok = await confirmAction(l(`¿Borrar «${item.title || "sin título"}»? Lo que ya corrió no se borra.`, `Delete «${item.title || "untitled"}»? Work that already ran is kept.`));
    if (!ok) return;
    crew.close();
    await useBacklogStore.getState().remove(item.id);
  };
  const addLabel = () => {
    const t = labelText.trim();
    if (!t || item.labels.includes(t)) return setLabelText("");
    patch({ labels: [...item.labels, t] }, true);
    setLabelText("");
  };

  const kinds: { value: BacklogKind; label: string; icon: typeof BookOpen }[] = [
    { value: "story", label: l("Historia", "Story"), icon: BookOpen },
    { value: "task", label: l("Tarea", "Task"), icon: SquareCheckBig },
    { value: "bug", label: "Bug", icon: Bug },
  ];

  return (
    <Drawer onClose={close} width={520} label="card">
        <header className="flex flex-col gap-3 border-b border-[var(--cf-border)] px-5 pb-4 pt-4">
          <div className="flex items-center gap-2">
            <Seg size="sm" value={item.kind} onChange={(kind) => patch({ kind }, true)} options={kinds} />
            <span className="flex-1" />
            {item.ticket && (
              <button type="button" title={l("Abre el ticket original", "Opens the original ticket")} onClick={() => item.ticket?.url && void openExternalUrl(item.ticket.url)} className="inline-flex items-center gap-1 font-mono text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]">
                <Link2 className="h-3.5 w-3.5" />
                {item.ticket.key}
              </button>
            )}
            <IconBtn title={l("Cerrar (Esc)", "Close (Esc)")} icon={X} onClick={close} />
          </div>
          <textarea
            value={item.title}
            onChange={(e) => patch({ title: e.target.value.replace(/\n/g, " ") })}
            rows={1}
            placeholder={l("¿Qué hay que hacer?", "What needs doing?")}
            className="field-sizing-content w-full resize-none rounded-md bg-transparent text-[17px] font-semibold leading-snug outline-none placeholder:text-[var(--cf-text-faint)]"
          />
          <div className="flex flex-wrap items-center gap-2">
            {manual ? (
              <Seg
                size="sm"
                value={item.status}
                onChange={(status) => void useBacklogStore.getState().move(item.id, status, item.rank)}
                options={[
                  { value: "backlog", label: "Backlog", title: l("Aún sin preparar: nadie la toma sola", "Not ready yet: nobody picks it up on their own") },
                  { value: "ready", label: l("Listo", "Ready"), title: l("Lista para trabajar: se puede lanzar o arrastrar un agente o equipo encima", "Ready to work: launch it or drag an agent or team onto it") },
                ]}
              />
            ) : (
              <Chip tone={item.status === "done" ? "ok" : item.status === "review" ? "warn" : "accent"}>{item.status === "doing" ? l("En curso", "Doing") : item.status === "review" ? l("Revisión", "Review") : l("Hecho", "Done")}</Chip>
            )}
            <Seg
              size="sm"
              value={String(item.priority)}
              onChange={(p) => patch({ priority: Number(p) }, true)}
              options={[0, 1, 2, 3].map((p) => ({
                value: String(p),
                label: p === 0 ? "—" : `P${4 - p}`,
                icon: p === 0 ? undefined : Flag,
                title: p === 0 ? l("Sin prioridad", "No priority") : l(`Prioridad P${4 - p}${p === 3 ? " (la más alta)" : ""}`, `Priority P${4 - p}${p === 3 ? " (highest)" : ""}`),
              }))}
            />
            {cost > 0 && <Chip title={l("Lo que lleva gastado esta tarjeta", "What this card has spent so far")}>{money(cost)}</Chip>}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-4">
          <section className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3">
            {agent ? <AgentAvatar agent={agent} size={36} /> : team ? <TeamAvatar size={38} /> : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] border border-dashed border-[var(--cf-border-strong)] text-[var(--cf-text-faint)]">?</span>}
            <span className="min-w-0 flex-1">
              <b className="block truncate text-[13px]">{agent?.name ?? team?.name ?? l("Sin asignar", "Unassigned")}</b>
              <span className="block text-[11.5px] text-[var(--cf-text-muted)]">
                {agent ? `${agent.model}${agent.effort ? ` · ${agent.effort}` : ""}` : team ? l(`Equipo de ${team.members.length}`, `Team of ${team.members.length}`) : l("Suelta un agente o un equipo del dock sobre la tarjeta.", "Drop an agent or a team from the dock onto the card.")}
              </span>
            </span>
            <Btn
              kind="primary"
              icon={WandSparkles}
              onClick={launch}
              title={item.links.length ? l("Lanza la tarjeta otra vez", "Launches the card again") : agent || team ? l("Empieza el trabajo con quien la tiene asignada", "Starts the work with its assignee") : l("Elige quién la hace y cómo", "Choose who does it and how")}
            >
              {item.links.length ? l("Otra vez", "Again") : agent || team ? l("Lanzar", "Launch") : l("Asignar", "Assign")}
            </Btn>
          </section>

          <WorkingNow item={item} />

          {item.links.length > 0 && (
            <section className="flex flex-col gap-2">
              <Label>{l("Trabajo enlazado", "Linked work")}</Label>
              <div className="flex flex-col gap-1.5">
                {item.links.map((link) => (
                  <LinkRow key={link.id} link={link} />
                ))}
              </div>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <Label>{l("Descripción", "Description")}</Label>
            <textarea
              value={item.body}
              onChange={(e) => patch({ body: e.target.value })}
              rows={5}
              placeholder={l("Contexto, enlaces, lo que el agente debe saber…", "Context, links, what the agent should know…")}
              className={`${field} h-auto min-h-[110px] resize-y py-2 leading-relaxed`}
            />
          </section>

          <Criteria criteria={item.criteria} onChange={(criteria) => patch({ criteria }, true)} />
          <Subtasks parent={item} />

          <section className="flex flex-col gap-2">
            <Label>{l("Repositorios", "Repositories")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {projects.map((p) => {
                const on = item.repos.includes(p.id);
                return (
                  <ToggleChip
                    key={p.id}
                    on={on}
                    icon={FolderGit2}
                    title={on ? l(`Quitar ${p.name} de la tarjeta`, `Remove ${p.name} from the card`) : l(`Trabajar también en ${p.name}`, `Also work in ${p.name}`)}
                    onClick={() => patch({ repos: on ? item.repos.filter((r) => r !== p.id) : [...item.repos, p.id] }, true)}
                  >
                    {p.name}
                  </ToggleChip>
                );
              })}
              {projects.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Este workspace no tiene repositorios.", "This workspace has no repositories.")}</span>}
            </div>
            {item.mode_config.branch && (
              <span title={l("Rama de trabajo", "Working branch")} className="inline-flex items-center gap-1 text-[11.5px] text-[var(--cf-text-muted)]">
                <GitBranch className="h-3.5 w-3.5" />
                {item.mode_config.branch}
              </span>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <Label>{l("Etiquetas", "Labels")}</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {item.labels.map((label) => (
                <Chip key={label} icon={Tag} className="h-6 pr-0.5">
                  {label}
                  <button type="button" title={l("Quitar la etiqueta", "Remove the label")} aria-label={l("Quitar", "Remove")} onClick={() => patch({ labels: item.labels.filter((x) => x !== label) }, true)} className="grid h-4 w-4 place-items-center rounded-[4px] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]">
                    <X className="h-3 w-3" />
                  </button>
                </Chip>
              ))}
              <input value={labelText} onChange={(e) => setLabelText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addLabel()} onBlur={addLabel} placeholder={l("+ etiqueta", "+ label")} title={l("Escribe y pulsa Enter para añadirla", "Type and press Enter to add it")} className={fieldClass({ size: "sm", className: "w-[130px]" })} />
            </div>
          </section>

          <Artifacts item={item} />

          {item.links.length === 0 && item.criteria.length === 0 && !item.body && (
            <p className="m-0 flex items-start gap-2 rounded-lg border border-[var(--cf-border)] p-3 text-[12px] text-[var(--cf-text-muted)]">
              <FileText className="mt-0.5 h-4 w-4 shrink-0" />
              {l(
                "Los criterios y la descripción viajan con la tarea: el agente o el equipo los recibe como parte del objetivo.",
                "Criteria and description travel with the task: the agent or team gets them as part of the goal.",
              )}
            </p>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-[var(--cf-border)] px-5 py-3">
          <Btn kind="danger" small icon={Trash2} onClick={() => void remove()} title={l("Borra la tarjeta del tablero", "Deletes the card from the board")}>{l("Borrar", "Delete")}</Btn>
          <span className="flex-1" />
          <span title={l("Cada cambio se guarda al momento", "Every change is saved right away")} className="inline-flex items-center gap-1 text-[11.5px] text-[var(--cf-text-faint)]">
            <ListChecks className="h-3.5 w-3.5" />
            {l("Se guarda solo", "Saves as you type")}
          </span>
        </footer>
    </Drawer>
  );
}

