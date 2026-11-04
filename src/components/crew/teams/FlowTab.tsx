/**
 * A team's fixed flow — the plan it follows when it has no lead, or that a lead starts from — as a
 * graph that reads left to right, and the checks that gate each task or the end of the run.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FlaskConical, Hammer, Plus, Search, Trash2, Workflow } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import type { Team, TeamCheck, TeamPlanStep } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { SelectBox, Btn, Chip, Empty, Label, Seg, SPRING, ToggleChip, field } from "../kit/ui";
import { useL } from "../state";

type Update = (fn: (team: Team) => Team, now?: boolean) => void;
const NO_PROJECTS: never[] = [];
const W = 210;
const H = 70;
const GX = 64;
const GY = 18;

/** Columns by the longest chain of dependencies before each step. */
function layers(plan: TeamPlanStep[]): Map<string, { col: number; row: number }> {
  const depth = new Map<string, number>();
  const visit = (key: string, seen: Set<string>): number => {
    if (depth.has(key)) return depth.get(key) as number;
    if (seen.has(key)) return 0;
    seen.add(key);
    const step = plan.find((s) => s.key === key);
    const d = step && step.depends_on.length ? 1 + Math.max(...step.depends_on.filter((k) => plan.some((s) => s.key === k)).map((k) => visit(k, seen)), -1) : 0;
    depth.set(key, d);
    return d;
  };
  for (const s of plan) visit(s.key, new Set());
  const rows = new Map<number, number>();
  const out = new Map<string, { col: number; row: number }>();
  for (const s of plan) {
    const col = depth.get(s.key) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out.set(s.key, { col, row });
  }
  return out;
}

/** Steps that depend on `key`, at any distance — which it may not depend on. */
function downstream(plan: TeamPlanStep[], key: string): Set<string> {
  const out = new Set<string>();
  const walk = (k: string) => {
    for (const s of plan) if (s.depends_on.includes(k) && !out.has(s.key)) {
      out.add(s.key);
      walk(s.key);
    }
  };
  walk(key);
  return out;
}

function StepEditor({ team, step, update, onClose }: { team: Team; step: TeamPlanStep; update: Update; onClose: () => void }) {
  const l = useL();
  const projects = useWorkspaceStore((s) => (s.activeWorkspaceId ? s.projectsByWorkspace[s.activeWorkspaceId] ?? NO_PROJECTS : NO_PROJECTS));
  const blocked = downstream(team.plan, step.key);
  const set = (patch: Partial<TeamPlanStep>, now = false) => update((t) => ({ ...t, plan: t.plan.map((s) => (s.key === step.key ? { ...s, ...patch } : s)) }), now);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <b className="flex-1 text-[13.5px]">{l("Paso", "Step")} <span className="font-mono text-[12px] text-[var(--cf-text-faint)]">{step.key}</span></b>
        <button type="button" onClick={onClose} title={l("Cierra el editor del paso; los cambios ya están guardados", "Closes the step editor; changes are already saved")} className="text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">{l("Listo", "Done")}</button>
      </div>
      <input value={step.title} onChange={(e) => set({ title: e.target.value })} title={l("Nombre corto con el que se ve el paso en el flujo", "Short name the step shows in the flow")} placeholder={l("Título", "Title")} className={field} />
      <textarea value={step.instruction} onChange={(e) => set({ instruction: e.target.value })} title={l("Lo que recibe el miembro: qué hacer y cuándo se da por hecho", "What the member receives: what to do and when it counts as done")} rows={5} placeholder={l("Qué debe hacer, con qué criterio de hecho", "What to do, and what done means")} className={`${field} h-auto resize-y py-2`} />
      <Seg size="sm" value={step.kind} onChange={(kind) => set({ kind }, true)} options={[{ value: "work", label: l("Trabajo", "Work"), icon: Hammer, title: l("El miembro escribe código y cambia archivos", "The member writes code and changes files") }, { value: "investigate", label: l("Investigar", "Investigate"), icon: Search, title: l("El miembro solo lee y analiza, sin modificar nada", "The member only reads and analyses, changing nothing") }]} />
      <div className="flex flex-col gap-1.5">
        <Label>{l("Lo hace", "Done by")}</Label>
        <SelectBox value={step.member} onChange={(v) => set({ member: v }, true)} className="w-full" title={l("Miembro del equipo que ejecuta este paso", "Team member who carries out this step")}>
          {team.members.filter((m) => !m.advisor).map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </SelectBox>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{l("En el repositorio", "In the repository")}</Label>
        <SelectBox value={step.repo} onChange={(v) => set({ repo: v }, true)} className="w-full" title={l("Repositorio donde trabaja este paso", "Repository this step works in")}>
          <option value="">{l("El primero de la tarea", "The task's first")}</option>
          <option value="*">{l("Todos los de la tarea", "All of the task's")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </SelectBox>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{l("Espera a", "Waits for")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {team.plan.filter((s) => s.key !== step.key && !blocked.has(s.key)).map((s) => (
            <ToggleChip key={s.key} title={step.depends_on.includes(s.key) ? l("Deja de esperar a este paso", "Stop waiting for this step") : l("Este paso no empieza hasta que termine aquel", "This step won't start until that one finishes")} on={step.depends_on.includes(s.key)} onClick={() => set({ depends_on: step.depends_on.includes(s.key) ? step.depends_on.filter((k) => k !== s.key) : [...step.depends_on, s.key] }, true)}>
              {s.title || s.key}
            </ToggleChip>
          ))}
        </div>
      </div>
      <div>
        <Btn
          kind="danger"
          small
          icon={Trash2}
          title={l("Borra el paso y lo quita de las esperas de los demás", "Deletes the step and removes it from other steps' waits")}
          onClick={() => {
            update((t) => ({ ...t, plan: t.plan.filter((s) => s.key !== step.key).map((s) => ({ ...s, depends_on: s.depends_on.filter((k) => k !== step.key) })) }), true);
            onClose();
          }}
        >
          {l("Quitar paso", "Remove step")}
        </Btn>
      </div>
    </div>
  );
}

export function FlowTab({ team, update }: { team: Team; update: Update }) {
  const l = useL();
  const roster = useAgentsStore((s) => s.roster);
  const [editing, setEditing] = useState<string | null>(null);
  const pos = useMemo(() => layers(team.plan), [team.plan]);
  const cols = Math.max(1, ...[...pos.values()].map((p) => p.col + 1));
  const rows = Math.max(1, ...[...pos.values()].map((p) => p.row + 1));
  const step = team.plan.find((s) => s.key === editing);
  const workers = team.members.filter((m) => !m.advisor);

  const add = () => {
    let n = team.plan.length + 1;
    while (team.plan.some((s) => s.key === `s${n}`)) n++;
    const key = `s${n}`;
    const last = team.plan[team.plan.length - 1];
    update((t) => ({
      ...t,
      plan: [...t.plan, { key, member: workers[0]?.id ?? "", repo: "", kind: "work", title: "", instruction: "", depends_on: last ? [last.key] : [] }],
    }), true);
    setEditing(key);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle,var(--cf-border)_1px,transparent_1px)] [background-size:22px_22px] p-6">
        {team.plan.length === 0 ? (
          <Empty icon={Workflow} title={l("Sin flujo fijo", "No fixed flow")} hint={team.lead ? l("Con líder, el plan lo arma él en cada corrida. Un flujo fijo le da un punto de partida.", "With a lead, it plans each run. A fixed flow gives it a starting point.") : l("Sin líder, el equipo sigue estos pasos en orden.", "Without a lead, the team follows these steps in order.")}>
            <Btn kind="primary" icon={Plus} onClick={add} title={l("Crea el primer paso del flujo fijo", "Creates the first step of the fixed flow")} disabled={workers.length === 0}>{l("Primer paso", "First step")}</Btn>
            {workers.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Antes, suma miembros en el organigrama.", "First, add members in the org chart.")}</span>}
          </Empty>
        ) : (
          <div className="relative" style={{ width: cols * (W + GX), height: rows * (H + GY) + 40 }}>
            <svg className="pointer-events-none absolute inset-0 overflow-visible" width={cols * (W + GX)} height={rows * (H + GY)} aria-hidden>
              <defs>
                <marker id="cf-flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L8,4 L0,8 Z" fill="var(--cf-border-strong)" />
                </marker>
              </defs>
              {team.plan.flatMap((s) =>
                s.depends_on.map((dep) => {
                  const a = pos.get(dep);
                  const b = pos.get(s.key);
                  if (!a || !b) return null;
                  const x1 = a.col * (W + GX) + W;
                  const y1 = a.row * (H + GY) + H / 2;
                  const x2 = b.col * (W + GX);
                  const y2 = b.row * (H + GY) + H / 2;
                  return <motion.path key={`${dep}-${s.key}`} initial={false} d={`M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2 - 2},${y2}`} animate={{ d: `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2 - 2},${y2}` }} fill="none" stroke="var(--cf-border-strong)" strokeWidth={1.6} markerEnd="url(#cf-flow-arrow)" />;
                }),
              )}
            </svg>
            {team.plan.map((s) => {
              const p = pos.get(s.key) ?? { col: 0, row: 0 };
              const member = team.members.find((m) => m.id === s.member);
              const agent = roster.find((a) => a.id === member?.agent_id);
              return (
                <motion.button
                  key={s.key}
                  type="button"
                  initial={false}
                  animate={{ x: p.col * (W + GX), y: p.row * (H + GY) }}
                  transition={SPRING}
                  onClick={() => setEditing(s.key)}
                  title={l(`${s.title || s.key} · ${member?.name ?? "—"}: clic para editar el paso`, `${s.title || s.key} · ${member?.name ?? "—"}: click to edit the step`)}
                  style={{ width: W, height: H }}
                  className={`absolute left-0 top-0 flex items-center gap-2.5 rounded-[13px] border bg-[var(--cf-surface-raised)] px-2.5 text-left ${editing === s.key ? "border-[var(--cf-accent)] shadow-[0_0_0_2px_var(--cf-accent-soft)]" : "border-[var(--cf-border)] hover:border-[var(--cf-border-strong)]"}`}
                >
                  {member ? <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={34} /> : <span className="h-[34px] w-[34px] rounded-[10px] border-2 border-dashed border-[var(--cf-border-strong)]" />}
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-[12.5px]">{s.title || l("(sin título)", "(untitled)")}</b>
                    <span className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
                      {s.kind === "investigate" ? <Search className="h-3 w-3" /> : <Hammer className="h-3 w-3" />}
                      <span className="truncate">{member?.name ?? "—"}</span>
                    </span>
                  </span>
                </motion.button>
              );
            })}
            <button type="button" onClick={add} title={l("Añade un paso al final del flujo", "Adds a step at the end of the flow")} className="absolute flex items-center gap-1.5 rounded-full border border-dashed border-[var(--cf-border-strong)] bg-[var(--cf-surface)] px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]" style={{ left: 0, top: rows * (H + GY) + 4 }}>
              <Plus className="h-3.5 w-3.5" />
              {l("Paso", "Step")}
            </button>
          </div>
        )}
      </div>
      {step && (
        <aside className="w-[320px] shrink-0 overflow-auto border-l border-[var(--cf-border)] bg-[var(--cf-surface)] p-4">
          <StepEditor team={team} step={step} update={update} onClose={() => setEditing(null)} />
        </aside>
      )}
    </div>
  );
}

export function ChecksTab({ team, update }: { team: Team; update: Update }) {
  const l = useL();
  const projects = useWorkspaceStore((s) => (s.activeWorkspaceId ? s.projectsByWorkspace[s.activeWorkspaceId] ?? NO_PROJECTS : NO_PROJECTS));
  const checks = team.policy.checks;
  const set = (next: TeamCheck[], now = true) => update((t) => ({ ...t, policy: { ...t.policy, checks: next } }), now);
  const [draft, setDraft] = useState<TeamCheck>({ repo: "*", command: "", when: "item" });

  return (
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mx-auto flex max-w-[720px] flex-col gap-4">
        <div>
          <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold"><FlaskConical className="h-4 w-4 text-[var(--cf-accent)]" />{l("Checks", "Checks")}</h3>
          <p className="m-0 mt-1 text-[12.5px] text-[var(--cf-text-muted)]">
            {l("Comandos que deben pasar. Por tarea: corren en el worktree del miembro antes de darla por hecha, y si fallan vuelve con el error. Al final: corren sobre la rama integrada.", "Commands that must pass. Per task: they run in the member's worktree before the task counts as done, and a failure sends it back with the error. At the end: they run on the integrated branch.")}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          {checks.map((c, i) => (
            <motion.div key={i} layout className="flex items-center gap-2 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2.5 py-2">
              <Chip tone={c.when === "final" ? "violet" : "info"} title={c.when === "final" ? l("Corre sobre la rama integrada al terminar la corrida", "Runs on the integrated branch when the run ends") : l("Corre en el worktree del miembro antes de dar la tarea por hecha", "Runs in the member's worktree before the task counts as done")}>{c.when === "final" ? l("Al final", "At the end") : l("Por tarea", "Per task")}</Chip>
              <code title={c.command} className="min-w-0 flex-1 truncate font-mono text-[12px]">{c.command}</code>
              <span title={l("Repositorio donde corre el comando", "Repository the command runs in")} className="text-[11.5px] text-[var(--cf-text-muted)]">{c.repo === "*" ? l("todos", "all") : projects.find((p) => p.id === c.repo)?.name ?? c.repo}</span>
              <button type="button" aria-label={l("Quitar", "Remove")} title={l("Quita este check; ya no se exigirá", "Removes this check; it will no longer be required")} onClick={() => set(checks.filter((_, j) => j !== i))} className="grid h-6 w-6 place-items-center rounded-[6px] text-[var(--cf-text-faint)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ))}
          {checks.length === 0 && <span className="text-[12.5px] text-[var(--cf-text-muted)]">{l("Sin checks: el equipo confía en sus propias pruebas.", "No checks: the team trusts its own tests.")}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-[11px] border border-dashed border-[var(--cf-border-strong)] p-2.5">
          <input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} title={l("Comando que debe terminar sin error (código de salida 0)", "Command that must finish without error (exit code 0)")} placeholder="pnpm test" className={`${field} min-w-[200px] flex-1 font-mono`} />
          <SelectBox value={draft.repo} onChange={(v) => setDraft({ ...draft, repo: v })} className="w-[150px] shrink-0" title={l("En qué repositorio corre el check", "Which repository the check runs in")}>
            <option value="*">{l("Todos los repos", "Every repo")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </SelectBox>
          <Seg size="sm" value={draft.when} onChange={(when) => setDraft({ ...draft, when })} options={[{ value: "item", label: l("Por tarea", "Per task"), title: l("Tras cada tarea, antes de darla por hecha", "After each task, before it counts as done") }, { value: "final", label: l("Al final", "At the end"), title: l("Una vez, sobre la rama integrada al cerrar la corrida", "Once, on the integrated branch when the run closes") }]} />
          <Btn
            kind="primary"
            small
            icon={Plus}
            title={l("Añade el check a la lista", "Adds the check to the list")}
            disabled={!draft.command.trim()}
            onClick={() => {
              set([...checks, { ...draft, command: draft.command.trim() }]);
              setDraft({ ...draft, command: "" });
            }}
          >
            {l("Añadir", "Add")}
          </Btn>
        </div>
      </div>
    </div>
  );
}
