import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FolderGit2, GitBranch, Info, Network, Play, Split, Trophy, User, WandSparkles, Waypoints, type LucideIcon } from "lucide-react";
import { useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { useTeamStore } from "../../state/teamStore";
import { useBacklogStore } from "../../state/backlogStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { LaunchError, launch, planLaunch, type LaunchInput, type LaunchMode } from "../../lib/agents/launch";
import { repoColorVar } from "../../lib/agents/agentColors";
import { composeGoal } from "../../lib/backlog/status";
import { emptyBacklogItem, type BacklogItem, type BacklogMode } from "../../types/crew";
import type { PolicyPreset } from "../../types/team";
import { AgentAvatar, TeamAvatar } from "./kit/Avatar";
import { Btn, Label, Modal, SPRING, Switch, ToggleChip, field } from "./kit/ui";
import { useCrewStore, useL } from "./state";

type Who = { kind: "agent" | "team"; id: string } | null;

const MODES: { id: LaunchMode; icon: LucideIcon; es: [string, string]; en: [string, string] }[] = [
  { id: "solo", icon: User, es: ["Solo", "Una tarea por repositorio, cada una en su worktree"], en: ["Solo", "One task per repository, each in its own worktree"] },
  { id: "race", icon: Trophy, es: ["Carrera", "Varios agentes, el mismo objetivo; te quedas con el mejor"], en: ["Race", "Several agents, one goal; you keep the best"] },
  { id: "team", icon: Network, es: ["Equipo", "El líder planifica y reparte por su jerarquía"], en: ["Team", "The lead plans and splits it down its hierarchy"] },
  { id: "flow", icon: Waypoints, es: ["Flujo fijo", "Pasos en orden, con compuertas"], en: ["Fixed flow", "Steps in order, with gates"] },
  { id: "hybrid", icon: Split, es: ["Híbrido", "Uno fuerte planifica y el modelo local escribe"], en: ["Hybrid", "A strong model plans and the local one writes"] },
];

const PRESETS: { id: PolicyPreset; es: string; en: string }[] = [
  { id: "autonomous", es: "Autónomo", en: "Autonomous" },
  { id: "supervised", es: "Supervisado", en: "Supervised" },
  { id: "stepwise", es: "Paso a paso", en: "Step by step" },
];

const ERRORS: Record<string, [string, string]> = {
  "crew.launch.needGoal": ["Escribe el objetivo.", "Write the goal."],
  "crew.launch.needRepo": ["Este workspace no tiene repositorios.", "This workspace has no repositories."],
  "crew.launch.needTeam": ["Este modo es para un equipo.", "This mode is for a team."],
  "crew.launch.needAgent": ["Este modo es para un agente.", "This mode is for an agent."],
  "crew.launch.needRacers": ["Una carrera necesita al menos dos agentes.", "A race needs at least two agents."],
  "crew.launch.needFlow": ["Elige un flujo con pasos.", "Pick a flow with steps."],
  "crew.launch.agentGone": ["Ese agente ya no está en el roster.", "That agent is no longer in the roster."],
};

export function LaunchDialog({ goal: initialGoal, assignee, cardId }: { goal?: string; assignee?: Who; cardId?: string }) {
  const l = useL();
  const close = useCrewStore((s) => s.close);
  const crew = useCrewStore();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projects = useActiveProjects();
  const roster = useAgentsStore((s) => s.roster);
  const teams = useTeamStore((s) => s.teams);
  const templates = useChainStore((s) => s.templates);
  const card = useBacklogStore((s) => (cardId ? s.items.find((i) => i.id === cardId) ?? null : null));
  const runnable = roster.filter((a) => a.enabled && a.provider && a.model);

  const [goal, setGoal] = useState(initialGoal ?? "");
  const [who, setWho] = useState<Who>(assignee ?? (card?.assignee_kind ? { kind: card.assignee_kind, id: card.assignee_id } : null));
  const [mode, setMode] = useState<LaunchMode>(() => {
    const stored = card?.mode;
    if (stored && stored !== "story") return stored as LaunchMode;
    return (assignee ?? (card?.assignee_kind ? { kind: card.assignee_kind } : null))?.kind === "team" ? "team" : "solo";
  });
  const [racers, setRacers] = useState<string[]>(card?.mode_config.racers ?? []);
  const [repos, setRepos] = useState<string[]>(card?.repos.length ? card.repos : projects.slice(0, 1).map((p) => p.id));
  const [branch, setBranch] = useState(card?.mode_config.branch ?? "");
  const [worktree, setWorktree] = useState(card?.mode_config.worktree ?? true);
  const [preset, setPreset] = useState<PolicyPreset | undefined>(card?.mode_config.preset);
  const [flowId, setFlowId] = useState<string>(card?.mode_config.flowTemplateId ?? "");
  const [busy, setBusy] = useState(false);

  const team = who?.kind === "team" ? teams.find((t) => t.id === who.id) ?? null : null;
  const agent = who?.kind === "agent" ? roster.find((a) => a.id === who.id) ?? null : null;
  const flows = useMemo(() => {
    const list = templates.filter((t) => t.kind === "chain" && t.steps.length > 0).map((t) => ({ id: t.id, name: t.name, steps: t.steps.map((s) => ({ agentId: s.agent_id, instruction: s.instruction, gate: s.gate })) }));
    if (team && team.plan.length > 0) {
      list.unshift({
        id: `team:${team.id}`,
        name: l("Plan fijo del equipo", "The team's fixed plan"),
        steps: team.plan.map((s) => ({ agentId: team.members.find((m) => m.id === s.member)?.agent_id ?? "", instruction: s.instruction, gate: false })).filter((s) => s.agentId),
      });
    }
    return list;
  }, [templates, team, l]);
  const modeOk = (m: LaunchMode) => (m === "team" ? who?.kind === "team" : m === "flow" ? true : who?.kind !== "team");
  const effectiveGoal = goal.trim() || (card ? composeGoal(card) : "");

  const explain = (() => {
    const name = team?.name ?? agent?.name ?? "";
    switch (mode) {
      case "solo":
        return l(`Se crea una tarea por repositorio marcado (${repos.length}). ${worktree ? "Cada una en su worktree: tu copia queda limpia." : "Trabaja en la copia del repositorio."}`, `One task per ticked repository (${repos.length}). ${worktree ? "Each in its own worktree: your copy stays clean." : "Works in the repository's copy."}`);
      case "race":
        return l(`Compiten ${1 + racers.length} agentes, cada uno en su worktree. Al final comparas diffs, tests y costo.`, `${1 + racers.length} agents compete, each in its own worktree. Then you compare diffs, tests and cost.`);
      case "team":
        return l(`${name}: el líder lee el objetivo, propone un plan y reparte. Las preguntas suben por la jerarquía antes de llegarte.`, `${name}: the lead reads the goal, proposes a plan and splits it. Questions climb the hierarchy before reaching you.`);
      case "flow":
        return l("Se sigue un flujo de pasos en orden; cada compuerta espera tu OK.", "A flow of steps runs in order; each gate waits for your OK.");
      case "hybrid":
        return l(`${name} planifica y revisa; el modelo local escribe el código. Ahorra costo.`, `${name} plans and reviews; the local model writes the code. Saves cost.`);
    }
  })();

  const modeConfig = (): BacklogItem["mode_config"] => ({ racers, branch, worktree, preset, flowTemplateId: flowId || undefined });

  const saveCard = async (status: BacklogItem["status"] | null): Promise<BacklogItem | null> => {
    if (!workspaceId) return null;
    const base = card ?? { ...emptyBacklogItem(workspaceId, "task"), title: (goal.trim().split("\n")[0] || l("Tarea nueva", "New task")).slice(0, 90), body: goal.trim() };
    return useBacklogStore.getState().save({
      ...base,
      assignee_kind: who?.kind ?? "",
      assignee_id: who?.id ?? "",
      mode: mode as BacklogMode,
      mode_config: modeConfig(),
      repos,
      status: status ?? base.status,
    });
  };

  const onAssign = async () => {
    setBusy(true);
    const saved = await saveCard(card && card.status !== "backlog" ? null : "ready");
    setBusy(false);
    if (saved) close();
  };

  const onLaunch = async () => {
    if (!workspaceId || !who) return;
    const flow = flows.find((f) => f.id === flowId) ?? flows[0];
    const input: LaunchInput = {
      goal: effectiveGoal,
      title: card?.title,
      mode,
      assignee: who,
      repos,
      racers,
      worktree,
      branch,
      preset,
      flowSteps: mode === "flow" ? flow?.steps : undefined,
    };
    setBusy(true);
    try {
      const plan = planLaunch(input, projects[0]?.id ?? null, () => crypto.randomUUID());
      const agents = useAgentsStore.getState();
      const chains = useChainStore.getState();
      const result = await launch(input, plan, {
        workspaceId,
        roster: agents.roster,
        teams: useTeamStore.getState().teams,
        createTask: (i) => agents.create(i),
        sendTask: (id, g) => useAgentsStore.getState().send(id, g),
        createChain: (i) => chains.create(i),
        createHybrid: (i) => chains.createHybrid(i),
        startTeam: (i) => useTeamStore.getState().start(i),
      });
      const saved = await saveCard("doing");
      if (saved) for (const link of result.links) await useBacklogStore.getState().link(saved.id, link.kind, link.refId);
      close();
      if (result.open?.kind === "team_run") {
        crew.setSpace("en-vivo");
        void useTeamStore.getState().select(result.open.id);
      } else if (result.open?.kind === "task") {
        crew.open({ kind: "task", id: result.open.id });
      } else if (result.open?.kind === "chain") {
        crew.open({ kind: "chain", id: result.open.id });
      }
    } catch (error) {
      const key = error instanceof LaunchError ? error.message : "";
      const pair = ERRORS[key];
      pushErrorToast(pair ? l(pair[0], pair[1]) : String(error));
    } finally {
      setBusy(false);
    }
  };

  const title = !cardId ? l("Dale una tarea", "Hand out a task") : who ? l(`¿Cómo lo hace ${team?.name ?? agent?.name ?? ""}?`, `How does ${team?.name ?? agent?.name ?? ""} do it?`) : l("¿Quién lo hace?", "Who does it?");

  return (
    <Modal
      title={title}
      subtitle={card ? card.title : l("Describe el objetivo, elige quién y cómo, y lánzalo.", "Describe the goal, pick who and how, and launch it.")}
      leading={team ? <TeamAvatar size={40} /> : agent ? <AgentAvatar agent={agent} size={40} /> : <span className="grid h-10 w-10 place-items-center rounded-[12px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"><WandSparkles className="h-5 w-5" /></span>}
      onClose={close}
      footer={
        <>
          <span className="text-[12px] text-[var(--cf-text-faint)]">{who ? "" : l("Elige a alguien, o suelta un agente del dock sobre una tarjeta.", "Pick someone, or drop an agent from the dock on a card.")}</span>
          <span className="flex-1" />
          <Btn kind="ghost" onClick={close} title={l("Cierra sin crear nada", "Closes without creating anything")}>{l("Cancelar", "Cancel")}</Btn>
          <Btn onClick={() => void onAssign()} title={card ? l("Deja la tarjeta asignada sin empezar", "Assigns the card without starting it") : l("Guarda la tarea para lanzarla después", "Saves the task to launch later")} disabled={!who || busy || (!card && !goal.trim())}>
            {card ? l("Solo asignar", "Just assign") : l("Guardar en el backlog", "Save to the backlog")}
          </Btn>
          <Btn kind="primary" icon={Play} onClick={() => void onLaunch()} title={l("Crea la tarea y la empieza ya", "Creates the task and starts it now")} disabled={!who || busy || !effectiveGoal || !modeOk(mode)}>
            {l("Lanzar ahora", "Launch now")}
          </Btn>
        </>
      }
    >
      {!card && (
        <div className="flex flex-col gap-1.5">
          <Label>{l("Objetivo", "Goal")}</Label>
          <textarea title={l("Lo que quieres lograr, con tus palabras", "What you want done, in your own words")} autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} className={`${field} h-auto py-2`} placeholder={l("Ej.: agregar recordatorio de cita 24 h antes por correo", "E.g.: email an appointment reminder 24 h before")} />
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Label>{l("Quién", "Who")}</Label>
        <div className="flex flex-wrap gap-2">
          {runnable.map((a) => (
            <Pick key={a.id} title={l(`${a.name} hace la tarea`, `${a.name} does the task`)} on={who?.kind === "agent" && who.id === a.id} onClick={() => { setWho({ kind: "agent", id: a.id }); if (mode === "team") setMode("solo"); }}>
              <AgentAvatar agent={a} size={24} />
              <span>{a.name}</span>
            </Pick>
          ))}
          {teams.map((t) => (
            <Pick key={t.id} title={l(`El equipo ${t.name} la planifica y reparte`, `Team ${t.name} plans and splits it`)} on={who?.kind === "team" && who.id === t.id} onClick={() => { setWho({ kind: "team", id: t.id }); setMode("team"); }}>
              <TeamAvatar size={24} />
              <span>{t.name}</span>
            </Pick>
          ))}
          {runnable.length === 0 && teams.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Aún no hay agentes: créalos en «Agentes».", "No agents yet: create them in «Agents».")}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label>{l("Cómo", "How")}</Label>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
          {MODES.map((m) => {
            const on = m.id === mode;
            const ok = modeOk(m.id);
            const [name, desc] = l("es", "en") === "es" ? m.es : m.en;
            return (
              <motion.button
                key={m.id}
                type="button"
                transition={SPRING}
                disabled={!ok}
                title={desc}
                onClick={() => setMode(m.id)}
                className={`flex flex-col gap-1.5 rounded-[12px] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  on ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_15%,transparent)]" : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[var(--cf-border-strong)]"
                }`}
              >
                <span className={`grid h-8 w-8 place-items-center rounded-[9px] ${on ? "bg-[var(--cf-accent)] text-[var(--cf-on-accent)]" : "bg-[var(--cf-sunken)] text-[var(--cf-accent)]"}`}>
                  <m.icon className="h-4 w-4" />
                </span>
                <b className="text-[13px]">{name}</b>
                <small className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{desc}</small>
              </motion.button>
            );
          })}
        </div>
        <div className="flex items-start gap-2.5 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2.5 text-[12.5px] text-[var(--cf-text-muted)]">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cf-accent)]" />
          <span>{explain}</span>
        </div>
        {mode === "race" && (
          <div className="flex flex-col gap-1.5">
            <Label>{l("Compiten además", "Also racing")}</Label>
            <div className="flex flex-wrap gap-2">
              {runnable.filter((a) => a.id !== who?.id && (a.edits ?? true)).map((a) => (
                <Pick key={a.id} title={l(`${a.name} compite con el mismo objetivo`, `${a.name} races on the same goal`)} on={racers.includes(a.id)} onClick={() => setRacers((r) => (r.includes(a.id) ? r.filter((x) => x !== a.id) : [...r, a.id].slice(0, 4)))}>
                  <AgentAvatar agent={a} size={22} />
                  <span>{a.name}</span>
                </Pick>
              ))}
            </div>
          </div>
        )}
        {mode === "flow" && (
          <div className="flex flex-wrap gap-2">
            {flows.length === 0 ? (
              <span className="text-[12px] text-[var(--cf-text-muted)]">{l("No hay flujos guardados. Diséñalos en «Equipos › Flujo fijo».", "No saved flows. Design them in «Teams › Fixed flow».")}</span>
            ) : (
              flows.map((f) => <ToggleChip key={f.id} on={(flowId || flows[0]?.id) === f.id} onClick={() => setFlowId(f.id)} icon={Waypoints} title={l(`Flujo de ${f.steps.length} pasos`, `Flow with ${f.steps.length} steps`)}>{f.name} · {f.steps.length}</ToggleChip>)
            )}
          </div>
        )}
        {mode === "team" && (
          <div className="flex flex-wrap items-center gap-2">
            <Label>{l("Permisos para esta corrida", "Permissions for this run")}</Label>
            {PRESETS.map((p) => <ToggleChip key={p.id} on={preset === p.id} onClick={() => setPreset(preset === p.id ? undefined : p.id)} title={p.id === "autonomous" ? l("El equipo actúa sin pedirte permiso", "The team acts without asking you") : p.id === "supervised" ? l("Te pide permiso solo para lo delicado", "Asks you only for risky steps") : l("Te pide permiso en cada paso", "Asks you at every step")}>{l(p.es, p.en)}</ToggleChip>)}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{l("Repositorios", "Repositories")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {projects.map((p) => (
            <ToggleChip key={p.id} on={repos.includes(p.id)} dot={repoColorVar(p.id)} icon={FolderGit2} title={l("Incluir este repositorio en la tarea", "Include this repository in the task")} onClick={() => setRepos((r) => (r.includes(p.id) ? r.filter((x) => x !== p.id) : [...r, p.id]))}>
              {p.name}
            </ToggleChip>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        {mode === "team" && (
          <div className="flex min-w-[220px] flex-col gap-1.5">
            <Label>{l("Rama destino", "Target branch")}</Label>
            <div className="relative">
              <GitBranch className="absolute left-2.5 top-2 h-4 w-4 text-[var(--cf-text-faint)]" />
              <input title={l("Rama a la que el equipo entrega su trabajo", "Branch the team delivers its work to")} value={branch} onChange={(e) => setBranch(e.target.value)} className={`${field} pl-8`} placeholder={l("la que esté activa (main, develop…)", "the checked-out one (main, develop…)")} />
            </div>
          </div>
        )}
        {mode === "solo" && (
          <div className="min-w-[240px]">
            <Switch checked={worktree} onChange={setWorktree} label={l("Worktree propio", "Its own worktree")} hint={l("no toca tu copia de trabajo", "leaves your working copy alone")} />
          </div>
        )}
      </div>
    </Modal>
  );
}

function Pick({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <motion.button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={on}
      className={`flex items-center gap-2 rounded-[10px] border py-1 pl-1 pr-2.5 text-[12.5px] font-medium transition-colors ${
        on ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_16%,transparent)]" : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[var(--cf-border-strong)]"
      }`}
    >
      {children}
    </motion.button>
  );
}
