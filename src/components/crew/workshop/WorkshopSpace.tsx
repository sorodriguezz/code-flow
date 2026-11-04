/**
 * «Taller»: the hands-on side. The worktrees every agent works in, the terminal bench (live shells,
 * kept alive by `CrewView` while you look elsewhere), and every piece of work ever started here —
 * solo tasks, races, fixed flows, hybrids — with the flow templates that start them.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { BookOpen, Cpu, FolderTree, GitFork, ListTree, MessageSquare, Pencil, Plus, Search, SquareTerminal, Trophy, Workflow } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useChainStore } from "../../../state/chainStore";
import { useBenchStore } from "../../../state/benchStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { groupRaces, raceStamp, raceStatus } from "../../../lib/agents/race";
import { isTeamTask } from "../../../types/team";
import type { AgentChain, AgentTask } from "../../../types/domain";
import { WorktreesView } from "../../agents/worktrees/WorktreesView";
import { AvatarStack } from "../kit/Avatar";
import { Btn, Chip, Empty, Label, Modal, Seg, SPRING, ToggleChip, field, type Tone } from "../kit/ui";
import { money, useCrewStore, useL } from "../state";

/** The toolbar's height: the bench host in `CrewView` sits right under it. */
export const WORKSHOP_BAR = 46;

const NO_BRIEFS: never[] = [];

function tone(status: string): Tone {
  if (status === "running" || status === "queued") return "accent";
  if (status === "gated" || status === "paused" || status === "idle") return "warn";
  if (status === "error" || status === "failed") return "bad";
  if (status === "done") return "ok";
  return "neutral";
}

const STATUS: Record<string, [string, string]> = {
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

type Row =
  | { kind: "task"; id: string; title: string; status: string; stamp: string; cost: number; agents: { id: string; icon?: string; color?: string }[]; sub: string }
  | { kind: "race"; id: string; title: string; status: string; stamp: string; cost: number; agents: { id: string; icon?: string; color?: string }[]; sub: string }
  | { kind: "flow" | "story" | "hybrid"; id: string; title: string; status: string; stamp: string; cost: number; agents: { id: string; icon?: string; color?: string }[]; sub: string };

function WorkList() {
  const l = useL();
  const crew = useCrewStore();
  const tasks = useAgentsStore((s) => s.tasks);
  const live = useAgentsStore((s) => s.live);
  const roster = useAgentsStore((s) => s.roster);
  const chains = useChainStore((s) => s.chains);
  const briefsByChain = useChainStore((s) => s.briefsByChain);
  const templates = useChainStore((s) => s.templates);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "task" | "race" | "flow" | "hybrid">("all");
  const [onlyOpen, setOnlyOpen] = useState(false);

  const rows = useMemo(() => {
    const look = (agentId: string) => {
      const a = roster.find((x) => x.id === agentId);
      return { id: agentId || "none", icon: a?.icon, color: a?.color };
    };
    const owner = new Set<string>();
    for (const [chainId, briefs] of Object.entries(briefsByChain)) {
      if (!chains.some((c) => c.id === chainId)) continue;
      for (const b of briefs ?? NO_BRIEFS) if (b.task_id) owner.add(b.task_id);
    }
    const own = tasks.filter((t) => !isTeamTask(t) && !t.archived);
    const sending = new Set(Object.entries(live).filter(([, v]) => v.sending).map(([id]) => id));
    const { races, memberOf } = groupRaces(own, owner);
    const out: Row[] = [];
    for (const t of own) {
      if (owner.has(t.id) || memberOf.has(t.id)) continue;
      out.push({ kind: "task", id: t.id, title: t.title || t.goal, status: sending.has(t.id) ? "running" : t.status, stamp: t.updated_at, cost: t.cost_usd ?? 0, agents: [look(t.agent_id)], sub: t.agent_name });
    }
    for (const r of races) {
      out.push({ kind: "race", id: r.batchId, title: r.tasks[0]?.goal || r.tasks[0]?.title || r.batchId, status: raceStatus(r.tasks, sending), stamp: raceStamp(r), cost: r.tasks.reduce((s, t) => s + (t.cost_usd ?? 0), 0), agents: r.tasks.map((t: AgentTask) => look(t.agent_id)), sub: r.tasks.map((t) => t.agent_name).join(" vs ") });
    }
    for (const c of chains as AgentChain[]) {
      const briefs = briefsByChain[c.id] ?? NO_BRIEFS;
      out.push({ kind: c.kind === "hybrid" ? "hybrid" : c.kind === "story" ? "story" : "flow", id: c.id, title: c.title || c.goal, status: c.status, stamp: c.updated_at, cost: 0, agents: [], sub: c.kind === "story" ? c.work_item_title : l(`${briefs.length} pasos`, `${briefs.length} steps`) });
    }
    const needle = q.trim().toLowerCase();
    return out
      .filter((r) => kind === "all" || r.kind === kind || (kind === "flow" && r.kind === "story"))
      .filter((r) => !onlyOpen || !["done", "cancelled", "aborted"].includes(r.status))
      .filter((r) => !needle || `${r.title} ${r.sub}`.toLowerCase().includes(needle))
      .sort((a, b) => b.stamp.localeCompare(a.stamp));
  }, [tasks, live, roster, chains, briefsByChain, q, kind, onlyOpen, l]);

  const open = (r: Row) => {
    if (r.kind === "task") crew.open({ kind: "task", id: r.id });
    else if (r.kind === "race") crew.open({ kind: "race", batchId: r.id });
    else crew.open({ kind: "chain", id: r.id });
  };
  const icon = { task: MessageSquare, race: Trophy, flow: Workflow, story: BookOpen, hybrid: Cpu } as const;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-3 py-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={l("Buscar trabajo", "Search work")} className={`${field} h-[28px] w-[200px] pl-8`} />
          </label>
          <ToggleChip on={kind === "all"} onClick={() => setKind("all")}>{l("Todo", "All")}</ToggleChip>
          <ToggleChip on={kind === "task"} icon={MessageSquare} onClick={() => setKind("task")}>{l("Tareas", "Tasks")}</ToggleChip>
          <ToggleChip on={kind === "race"} icon={Trophy} onClick={() => setKind("race")}>{l("Carreras", "Races")}</ToggleChip>
          <ToggleChip on={kind === "flow"} icon={Workflow} onClick={() => setKind("flow")}>{l("Flujos", "Flows")}</ToggleChip>
          <ToggleChip on={kind === "hybrid"} icon={Cpu} onClick={() => setKind("hybrid")}>{l("Híbridos", "Hybrids")}</ToggleChip>
          <ToggleChip on={onlyOpen} onClick={() => setOnlyOpen((v) => !v)}>{l("Solo abiertos", "Open only")}</ToggleChip>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-3">
          {rows.map((r, i) => {
            const Icon = icon[r.kind];
            const [es, en] = STATUS[r.status] ?? [r.status, r.status];
            return (
              <motion.button
                key={`${r.kind}:${r.id}`}
                type="button"
                layout
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...SPRING, delay: Math.min(i, 14) * 0.015 }}
                onClick={() => open(r)}
                className="flex items-center gap-2.5 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2 text-left hover:border-[var(--cf-border-strong)]"
              >
                <Icon className="h-4 w-4 shrink-0 text-[var(--cf-text-muted)]" />
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[12.5px]">{r.title}</b>
                  <span className="block truncate text-[11px] text-[var(--cf-text-faint)]">{r.sub}</span>
                </span>
                {r.kind === "task" || r.kind === "race" ? <AvatarStack agents={r.agents} size={20} /> : null}
                {r.cost > 0 && <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">{money(r.cost)}</span>}
                <Chip tone={tone(r.status)}>{l(es, en)}</Chip>
              </motion.button>
            );
          })}
          {rows.length === 0 && <Empty icon={ListTree} title={l("Nada por aquí", "Nothing here")} hint={l("Lo que lances desde el tablero o con «Dale una tarea» aparece aquí también.", "Whatever you launch from the board or with «Hand out a task» shows up here too.")} />}
        </div>
      </div>
      <aside className="hidden w-[290px] shrink-0 flex-col gap-3 overflow-auto border-l border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_45%,var(--cf-surface))] p-3 lg:flex">
        <div className="flex flex-col gap-1.5">
          <Label>{l("Crear", "Create")}</Label>
          <Btn icon={Workflow} onClick={() => crew.open({ kind: "chainEditor", templateId: null })}>{l("Nuevo flujo fijo", "New fixed flow")}</Btn>
          <Btn icon={BookOpen} onClick={() => crew.open({ kind: "story" })}>{l("Realizar una historia", "Realize a story")}</Btn>
          <Btn icon={GitFork} onClick={() => crew.open({ kind: "launch" })}>{l("Carrera o híbrido…", "Race or hybrid…")}</Btn>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{l("Plantillas de flujo", "Flow templates")}</Label>
          {templates.map((t) => (
            <button key={t.id} type="button" onClick={() => crew.open({ kind: "chainEditor", templateId: t.id })} className="flex items-center gap-2 rounded-[9px] border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-left hover:border-[var(--cf-border-strong)]">
              {t.kind === "hybrid" ? <Cpu className="h-3.5 w-3.5 text-[var(--cf-text-muted)]" /> : <Workflow className="h-3.5 w-3.5 text-[var(--cf-text-muted)]" />}
              <span className="min-w-0 flex-1 truncate text-[12px]">{t.name}</span>
              <Pencil className="h-3 w-3 text-[var(--cf-text-faint)]" />
            </button>
          ))}
          {templates.length === 0 && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{l("Guarda un flujo como plantilla para reusarlo desde «Dale una tarea».", "Save a flow as a template to reuse it from «Hand out a task».")}</span>}
        </div>
      </aside>
    </div>
  );
}

function WorktreesHelp({ onClose }: { onClose: () => void }) {
  const l = useL();
  return (
    <Modal title={l("Worktrees", "Worktrees")} leading={<span className="grid h-10 w-10 place-items-center rounded-[12px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"><FolderTree className="h-5 w-5" /></span>} onClose={onClose}>
      <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[12.5px]">
        <li>{l("Cada tarea con worktree trabaja en una copia aparte del repositorio, en su propia rama: varios agentes no se pisan.", "Each task with a worktree works in its own copy of the repository, on its own branch: several agents never step on each other.")}</li>
        <li>{l("Aquí ves todos, por repositorio: sus archivos, su diff, su terminal y la revisión antes de integrar.", "Here you see them all, by repository: their files, their diff, their terminal and the review before merging.")}</li>
        <li>{l("En una carrera, la rejilla pone a los competidores lado a lado para comparar.", "In a race, the grid puts the racers side by side to compare.")}</li>
      </ul>
    </Modal>
  );
}

export function WorkshopSpace({ benchMounted }: { benchMounted: boolean }) {
  const l = useL();
  const crew = useCrewStore();
  const tab = useCrewStore((s) => s.workshopTab);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const terminals = useBenchStore((s) => s.terminals.length);
  const [help, setHelp] = useState(false);

  const pick = (next: typeof tab) => {
    if (next === "bench" && workspaceId) void useBenchStore.getState().show(workspaceId);
    else if (tab === "bench") useBenchStore.getState().hide();
    crew.set({ workshopTab: next });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3" style={{ height: WORKSHOP_BAR }}>
        <Seg
          size="sm"
          value={tab}
          onChange={pick}
          options={[
            { value: "worktrees", label: "Worktrees", icon: FolderTree },
            { value: "bench", label: l("Terminales", "Terminals"), icon: SquareTerminal, badge: terminals ? <span className="text-[10.5px] text-[var(--cf-text-faint)]">{terminals}</span> : undefined },
            { value: "races", label: l("Todo el trabajo", "All work"), icon: ListTree },
          ]}
        />
        <span className="flex-1" />
        {tab === "races" && <Btn small kind="primary" icon={Plus} onClick={() => crew.open({ kind: "launch" })}>{l("Dale una tarea", "Hand out a task")}</Btn>}
      </div>
      {tab === "worktrees" && (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <WorktreesView onNewAgent={() => crew.open({ kind: "launch" })} onHelp={() => setHelp(true)} />
        </div>
      )}
      {/* The bench itself is drawn by `CrewView` over this space, outside the transitions, so its
          shells survive switching tabs and spaces. This only holds the place (and says so while
          it first mounts). */}
      {tab === "bench" && <div className="min-h-0 flex-1">{!benchMounted && <span className="grid h-full place-items-center text-[12px] text-[var(--cf-text-muted)]">…</span>}</div>}
      {tab === "races" && <WorkList />}
      {help && <WorktreesHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
