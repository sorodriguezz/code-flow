/**
 * «En vivo»: the team runs as they happen. Pick a run from the list to see its work three ways
 * (the graph that grows, the hierarchy with messages travelling it, the members' lanes) and the
 * side keeps the channel and the run's numbers. Everything here only watches and sends orders —
 * the runs move in the backend, so this page is the same in the main window and in an island.
 */
import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, BarChart3, GitBranch, Hand, Kanban, MessagesSquare, Network, Pause, Pin, PinOff, Play, Search, Square, Trash2, Users, WandSparkles } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import { useBacklogStore } from "../../../state/backlogStore";
import { useT } from "../../../state/languageStore";
import { confirmAction } from "../../../state/confirmStore";
import { recoveryNeedsUser, runIsLive, type TeamRun, type TeamRunState } from "../../../types/team";
import { TeamAvatar } from "../kit/Avatar";
import { Btn, Chip, Empty, Seg, field } from "../kit/ui";
import { money, useCrewStore, useL } from "../state";
import { RUN_STATUS } from "./look";
import { WorkGraph } from "./WorkGraph";
import { TeamFlow } from "./TeamFlow";
import { Lanes } from "./Lanes";
import { Channel } from "./Channel";
import { Insights } from "./Insights";
import { GateCard, ItemPanel } from "./RunParts";

function useWide(query = "(min-width: 1180px)") {
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return wide;
}

function waitingQuestions(state: TeamRunState | undefined): number {
  return state?.messages.filter((m) => m.kind === "question" && m.to_id === "user" && !m.answered_at).length ?? 0;
}

function RunList({ runs, states }: { runs: TeamRun[]; states: Record<string, TeamRunState> }) {
  const l = useL();
  const [query, setQuery] = useState("");
  const entries = useMemo(() => runs
    .map((run) => ({
      run,
      pending: waitingQuestions(states[run.id]) + Number(run.status === "gated")
        + Number(runIsLive(run) && recoveryNeedsUser(states[run.id]).length > 0),
    }))
    .sort((a, b) => Number(b.pending > 0) - Number(a.pending > 0)
      || Number(runIsLive(b.run)) - Number(runIsLive(a.run))
      || Number(b.run.pinned) - Number(a.run.pinned)
      || b.run.updated_at.localeCompare(a.run.updated_at)), [runs, states]);
  const q = query.trim().toLowerCase();
  const shown = entries.filter(({ run }) => `${run.title} ${run.goal} ${run.team_name}`.toLowerCase().includes(q));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3.5 py-2.5">
        <label className="relative w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={l("Buscar corrida o equipo", "Search run or team")} placeholder={l("Buscar corrida o equipo", "Search run or team")} className={`${field} h-[30px] pl-8`} />
        </label>
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">
          {runs.length === 1 ? l("1 corrida", "1 run") : l(`${runs.length} corridas`, `${runs.length} runs`)}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3 overflow-y-auto p-3.5">
        {shown.map(({ run, pending }) => {
          const [es, en, tone] = RUN_STATUS[run.status];
          const working = states[run.id]?.items.some((i) => i.status === "running");
          return (
            <button key={run.id} type="button" onClick={() => void useTeamStore.getState().select(run.id)} className="flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3.5 text-left transition-colors hover:border-[var(--cf-accent-line)]">
              <span className="flex w-full items-center gap-2.5">
                <TeamAvatar size={36} state={working ? "thinking" : "idle"} />
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[13.5px]">{run.title || run.goal}</b>
                  <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">{run.team_name}</span>
                </span>
                {run.pinned && <Pin aria-label={l("Fijada", "Pinned")} className="h-3.5 w-3.5 shrink-0 text-[var(--cf-text-muted)]" />}
              </span>
              <span className="flex flex-wrap gap-1.5">
                <Chip tone={tone}>{l(es, en)}</Chip>
                {pending > 0 && (
                  <Chip tone="warn" icon={Hand} title={l("Preguntas o aprobaciones que esperan por ti", "Questions or approvals waiting for you")}>
                    {pending === 1 ? l("1 aviso pendiente", "1 pending notice") : l(`${pending} avisos pendientes`, `${pending} pending notices`)}
                  </Chip>
                )}
              </span>
            </button>
          );
        })}
        {shown.length === 0 && <p className="col-span-full m-0 p-6 text-center text-[12.5px] text-[var(--cf-text-muted)]">{l("Ninguna corrida coincide.", "No run matches.")}</p>}
      </div>
    </div>
  );
}

function RunHeader({ state }: { state: TeamRunState }) {
  const l = useL();
  const t = useT();
  const crew = useCrewStore();
  const { run } = state;
  const store = useTeamStore.getState();
  const card = useBacklogStore((s) => s.items.find((i) => i.links.some((lnk) => lnk.kind === "team_run" && lnk.ref_id === run.id)));
  const [es, en, tone] = RUN_STATUS[run.status];
  const remove = async () => {
    if (await confirmAction(l("¿Borrar esta corrida, con su canal y sus worktrees? Lo integrado queda en tus ramas.", "Delete this run, with its channel and worktrees? What was merged stays on your branches."))) await store.removeRun(run.id);
  };
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-[var(--cf-border)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <TeamAvatar size={30} state={state.items.some((i) => i.status === "running") ? "thinking" : "idle"} />
        <div className="min-w-[200px] flex-1">
          <b className="block truncate text-[14px]">{run.title || run.goal}</b>
          <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
            <Users className="h-3 w-3" />
            {run.team_name}
            <Chip tone={tone} title={l("Estado de la corrida", "Run status")}>{l(es, en)}</Chip>
            <span title={l("Turnos usados de los permitidos", "Turns used of those allowed")}>{l(`${run.dispatches}/${run.policy.max_dispatches} turnos`, `${run.dispatches}/${run.policy.max_dispatches} turns`)}</span>
            {run.policy.budget_usd > 0 && <span>· {l("tope", "cap")} {money(run.policy.budget_usd)}</span>}
          </span>
        </div>
        {card && (
          <Btn small icon={Kanban} onClick={() => crew.open({ kind: "card", id: card.id })} title={l("La tarjeta del tablero", "The board card")}>
            <span className="max-w-[140px] truncate">{card.title}</span>
          </Btn>
        )}
        {run.status === "running" && <Btn small icon={Pause} title={l("Detiene a todos los miembros sin perder el trabajo", "Stops every member without losing work")} onClick={() => void store.control(run.id, "pause")}>{l("Pausar", "Pause")}</Btn>}
        {run.status === "paused" && <Btn small kind="primary" icon={Play} title={l("Reanuda la corrida donde quedó", "Resumes the run where it stopped")} onClick={() => void store.control(run.id, "resume")}>{l("Seguir", "Resume")}</Btn>}
        {runIsLive(run) && (
          <Btn small kind="danger" icon={Square} title={l("Detiene la corrida por completo, sin reanudar", "Stops the run for good, no resuming")} onClick={() => void confirmAction(l("¿Cancelar la corrida? Lo que está en curso se detiene.", "Abort the run? What is in flight stops.")).then((ok) => { if (ok) void store.control(run.id, "abort"); })}>
            {l("Cancelar", "Abort")}
          </Btn>
        )}
        <button type="button" title={run.pinned ? l("Desfijar", "Unpin") : l("Fijar", "Pin")} onClick={() => void store.setPinned(run.id, !run.pinned)} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
          {run.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
        </button>
        {!runIsLive(run) && (
          <button type="button" title={l("Borrar corrida", "Delete run")} onClick={() => void remove()} className="grid h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {state.repos.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-[var(--cf-text-muted)]">
          {state.repos.map((r) => (
            // The repository and where the work lands; the run's own branch and folder are in the tooltip.
            <span key={r.project_id} className="inline-flex items-center gap-1" title={`${r.integration_branch} → ${r.target_branch}\n${r.integration_path}`}>
              <GitBranch className="h-3 w-3" />
              <b className="font-medium text-[var(--cf-text)]">{r.name}</b>
              <span>→ <span className="font-mono">{r.target_branch}</span></span>
              {r.status === "merged" && <span className="text-[var(--cf-success)]">· {l("integrado", "merged")}</span>}
              {r.status === "failed" && <span className="text-[var(--cf-danger)]" title={r.last_error}>· {l("falló", "failed")}</span>}
              {r.status === "left" && <span>· {l("en su rama", "on its branch")}</span>}
            </span>
          ))}
        </div>
      )}
      {run.status === "paused" && run.last_reason && <span className="text-[11.5px] text-[var(--cf-warning)]">{t(run.last_reason as never)}</span>}
    </div>
  );
}

function RunPage({ state }: { state: TeamRunState }) {
  const l = useL();
  const crew = useCrewStore();
  const tab = useCrewStore((s) => s.liveTab);
  const wide = useWide();
  const [selected, setSelected] = useState<string | null>(null);
  const [rail, setRail] = useState<"canal" | "panel">("canal");
  const item = state.items.find((i) => i.id === selected) ?? null;
  const asks = waitingQuestions(state);
  const view = !wide && (tab === "canal" || tab === "panel") ? tab : tab === "canal" || tab === "panel" ? "tareas" : tab;

  useEffect(() => setSelected(null), [state.run.id]);

  const tabs = [
    { value: "tareas" as const, label: l("Tareas", "Tasks"), icon: Activity },
    { value: "equipo" as const, label: l("Equipo", "Team"), icon: Network },
    { value: "miembros" as const, label: l("Miembros", "Members"), icon: Users },
    ...(wide
      ? []
      : [
          { value: "canal" as const, label: l("Canal", "Channel"), icon: MessagesSquare, badge: asks ? <span className="grid h-4 min-w-4 place-items-center rounded-full bg-[var(--cf-warning)] px-1 text-[10px] text-white">{asks}</span> : undefined },
          { value: "panel" as const, label: l("Números", "Numbers"), icon: BarChart3 },
        ]),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunHeader state={state} />
      {state.run.status === "gated" && <GateCard state={state} />}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5">
            <Seg size="sm" value={view} onChange={(v) => crew.set({ liveTab: v })} options={tabs} />
          </div>
          <div className="relative mt-2 flex min-h-0 flex-1 flex-col border-t border-[var(--cf-border)]">
            {view === "tareas" && <WorkGraph state={state} selected={selected} onSelect={setSelected} />}
            {view === "equipo" && <TeamFlow state={state} />}
            {view === "miembros" && <Lanes state={state} onOpenItem={(id) => { setSelected(id); crew.set({ liveTab: "tareas" }); }} />}
            {view === "canal" && <Channel state={state} />}
            {view === "panel" && <div className="min-h-0 flex-1 overflow-auto"><Insights state={state} onOpenItem={setSelected} /></div>}
            {item && <ItemPanel state={state} item={item} onClose={() => setSelected(null)} />}
          </div>
        </div>
        {wide && (
          <aside style={{ width: state.items.filter((i) => !["advise", "answer"].includes(i.kind)).length <= 3 ? 520 : 380 }} className="flex shrink-0 flex-col border-l border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_45%,var(--cf-surface))]">
            <div className="shrink-0 px-2.5 pt-2.5">
              <Seg
                size="sm"
                value={rail}
                onChange={setRail}
                options={[
                  { value: "canal", label: l("Canal", "Channel"), icon: MessagesSquare, title: l("Planes, entregas, preguntas y decisiones del equipo, en orden; aquí respondes lo que te preguntan", "The team's plans, deliveries, questions and decisions, in order; answer what you're asked here"), badge: asks ? <span className="grid h-4 min-w-4 place-items-center rounded-full bg-[var(--cf-warning)] px-1 text-[10px] text-white">{asks}</span> : undefined },
                  { value: "panel", label: l("Recursos y decisiones", "Resources and decisions"), icon: BarChart3, title: l("Costo y recursos de la corrida, alertas (bucles, atascos, presupuesto), quién habla con quién y las dudas que se decidieron sin preguntarte", "The run's cost and resources, alerts (loops, stuck work, budget), who talks to whom and the doubts settled without asking you") },
                ]}
              />
            </div>
            <div className="mt-2 flex min-h-0 flex-1 flex-col border-t border-[var(--cf-border)]">
              {rail === "canal" ? <Channel state={state} compact /> : <div className="min-h-0 flex-1 overflow-auto"><Insights state={state} onOpenItem={setSelected} /></div>}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export function LiveSpace() {
  const l = useL();
  const crew = useCrewStore();
  const runs = useTeamStore((s) => s.runs);
  const states = useTeamStore((s) => s.states);
  const selectedRunId = useTeamStore((s) => s.selectedRunId);
  const loading = useTeamStore((s) => s.loading);

  if (selectedRunId) {
    const state = states[selectedRunId];
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <Btn small kind="ghost" icon={ArrowLeft} title={l("Vuelve a la lista de corridas", "Back to the run list")} onClick={() => void useTeamStore.getState().select(null)}>
            {l("Corridas", "Runs")}
          </Btn>
        </div>
        {state ? <RunPage key={selectedRunId} state={state} /> : <div className="grid flex-1 place-items-center text-[12px] text-[var(--cf-text-muted)]">{l("Cargando corrida…", "Loading run…")}</div>}
      </div>
    );
  }

  if (loading && runs.length === 0) {
    return <div className="grid flex-1 place-items-center text-[12px] text-[var(--cf-text-muted)]">{l("Cargando corridas…", "Loading runs…")}</div>;
  }

  if (runs.length === 0) {
    return (
      <Empty icon={Activity} title={l("Nada en marcha", "Nothing running")} hint={l("Cuando un equipo trabaje, aquí lo verás crecer: el plan, quién hace qué en paralelo, lo que se dicen y lo que cuesta.", "When a team works, you will see it grow here: the plan, who does what in parallel, what they tell each other and what it costs.")}>
        <Btn kind="primary" icon={WandSparkles} title={l("Abre el lanzador para asignar una tarea a un equipo", "Opens the launcher to assign a task to a team")} onClick={() => crew.open({ kind: "launch" })}>{l("Dale una tarea a un equipo", "Hand a team a task")}</Btn>
      </Empty>
    );
  }

  return <RunList runs={runs} states={states} />;
}
