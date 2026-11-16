/**
 * A team's fixed flow — the plan it follows when it has no lead, or that a lead starts from — as a
 * graph that reads left to right, and the checks that gate each task or the end of the run.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { FlaskConical, Hammer, Plus, Search, Trash2, Workflow } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { teamDetectChecks } from "../../../lib/tauri/teamCommands";
import { useToastStore } from "../../../state/toastStore";
import type { Team, TeamCheck, TeamCheckKind, TeamPlanStep } from "../../../types/team";
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
          <Empty icon={Workflow} title={l("Sin flujo fijo", "No fixed flow")} hint={team.lead ? l("Con líder, el plan lo arma él en cada corrida y estos pasos no se usan. Sirven para un equipo sin líder.", "With a lead, it plans each run and these steps are not used. They are for a team with no lead.") : l("Sin líder, el equipo sigue estos pasos en orden.", "Without a lead, the team follows these steps in order.")}>
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

const CHECK_KINDS: { value: TeamCheckKind; es: string; en: string }[] = [
  { value: "unit", es: "Unitarias", en: "Unit" },
  { value: "integration", es: "Integración", en: "Integration" },
  { value: "e2e", es: "End-to-end", en: "End-to-end" },
  { value: "lint", es: "Lint y tipos", en: "Lint and types" },
  { value: "other", es: "Otra", en: "Other" },
];

/** The suites a team's members are told about and the app runs, per repository. Repositories
 *  differ — one has only unit tests, another integration and e2e — so each check says what it is,
 *  who runs it and whether the members write tests of its kind. */
export function ChecksTab({ team, update }: { team: Team; update: Update }) {
  const l = useL();
  const projects = useWorkspaceStore((s) => (s.activeWorkspaceId ? s.projectsByWorkspace[s.activeWorkspaceId] ?? NO_PROJECTS : NO_PROJECTS));
  const checks = team.policy.checks;
  const set = (next: TeamCheck[], now = true) => update((t) => ({ ...t, policy: { ...t.policy, checks: next } }), now);
  const patch = (index: number, change: Partial<TeamCheck>) => set(checks.map((c, j) => (j === index ? { ...c, ...change } : c)));
  const [draft, setDraft] = useState<TeamCheck>({ repo: "*", command: "", when: "item", kind: "unit", label: "", write: true });
  const [detecting, setDetecting] = useState(false);
  const kindName = (c: TeamCheck) => c.label?.trim() || l(...(() => { const k = CHECK_KINDS.find((x) => x.value === (c.kind ?? "other")) ?? CHECK_KINDS[4]; return [k.es, k.en] as const; })());
  const whenOptions = [
    { value: "item" as const, label: l("Por tarea", "Per task"), title: l("La app la corre en el worktree del miembro antes de dar la tarea por hecha; si falla, vuelve con el error", "The app runs it in the member's worktree before the task counts as done; a failure sends it back with the error") },
    { value: "final" as const, label: l("Al final", "At the end"), title: l("La app la corre una vez sobre la rama integrada al cerrar la corrida", "The app runs it once on the integrated branch when the run closes") },
    { value: "agent" as const, label: l("La corre el agente", "Agent runs it"), title: l("Solo se le indica al agente, que la corre por su cuenta; la app no la corre (útil para e2e que necesitan un navegador o servicios)", "Only told to the agent, who runs it; the app does not (useful for e2e that need a browser or services)") },
  ];

  /** Reads the suites off each chosen repository and adds the ones not listed yet. */
  const detect = async () => {
    const targets = draft.repo === "*" ? projects : projects.filter((p) => p.id === draft.repo);
    setDetecting(true);
    try {
      const found = (await Promise.all(targets.map((p) => teamDetectChecks(p.id).catch(() => [] as TeamCheck[])))).flat();
      const fresh = found.filter((f) => !checks.some((c) => (c.repo === f.repo || c.repo === "*") && c.command === f.command));
      if (fresh.length) set([...checks, ...fresh]);
      else useToastStore.getState().pushToast(found.length ? l("Las pruebas detectadas ya están en la lista.", "The detected tests are already listed.") : l("No encontré pruebas en ese repositorio. Puedes añadirlas a mano.", "No tests found in that repository. You can add them by hand."), "info");
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4">
        <div>
          <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold"><FlaskConical className="h-4 w-4 text-[var(--cf-accent)]" />{l("Pruebas", "Tests")}</h3>
          <p className="m-0 mt-1 text-[12.5px] text-[var(--cf-text-muted)]">
            {l("Las pruebas que tiene cada repositorio. Cada agente recibe las de su repositorio: cuáles debe escribir o actualizar y cuáles correr antes de terminar. Un repositorio sin pruebas aquí no recibe ninguna.", "The tests each repository has. Each agent is told its repository's: which to write or update and which to run before finishing. A repository with none here gets none.")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--cf-border)] px-2.5 py-2">
          <span className="min-w-[200px] flex-1 text-[12.5px]">
            <b className="font-medium">{l("Si una prueba ya fallaba antes del cambio", "If a test already failed before the change")}</b>
            <span className="block text-[11.5px] text-[var(--cf-text-muted)]">{l("Lo que el cambio rompe bloquea siempre la tarea.", "What the change breaks always blocks the task.")}</span>
          </span>
          <Seg size="sm" value={team.policy.baseline_failures ?? "ignore"} onChange={(baseline_failures) => update((t) => ({ ...t, policy: { ...t.policy, baseline_failures } }))} options={[
            { value: "ignore" as const, label: l("No bloquea", "Don't block"), title: l("La tarea sigue y el fallo queda anotado; el agente no lo toca", "The task goes on and the failure is noted; the agent leaves it alone") },
            { value: "fix" as const, label: l("El agente la arregla", "The agent fixes it"), title: l("El agente debe dejarla pasando aunque no la haya roto él; hace más grande cada tarea", "The agent must make it pass even though it did not break it; makes each task bigger") },
          ]} />
        </div>
        <div className="flex flex-col gap-1.5">
          {checks.map((c, i) => (
            <motion.div key={i} layout className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2.5 py-2">
              <Chip tone={c.kind === "e2e" ? "violet" : c.kind === "integration" ? "warn" : "info"}>{kindName(c)}</Chip>
              <code title={c.command} className="min-w-[120px] flex-1 truncate font-mono text-[12px]">{c.command}</code>
              <span title={l("Repositorio donde corre", "Repository it runs in")} className="text-[11.5px] text-[var(--cf-text-muted)]">{c.repo === "*" ? l("todos", "all") : projects.find((p) => p.id === c.repo)?.name ?? c.repo}</span>
              <Seg size="sm" value={c.when} onChange={(when) => patch(i, { when })} options={whenOptions} />
              <ToggleChip on={!!c.write} onClick={() => patch(i, { write: !c.write })} title={l("El agente agrega o actualiza pruebas de este tipo para lo que cambia", "The agent adds or updates tests of this kind for what it changes")}>
                {l("Las escribe", "Writes them")}
              </ToggleChip>
              <button type="button" aria-label={l("Quitar", "Remove")} title={l("Quita esta prueba; ya no se indica ni se exige", "Removes this test; it is no longer told or required")} onClick={() => set(checks.filter((_, j) => j !== i))} className="grid h-6 w-6 place-items-center rounded-[6px] text-[var(--cf-text-faint)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ))}
          {checks.length === 0 && <span className="text-[12.5px] text-[var(--cf-text-muted)]">{l("Sin pruebas configuradas. Usa «Detectar» para leerlas del repositorio o añádelas a mano.", "No tests set up. Use «Detect» to read them off the repository, or add them by hand.")}</span>}
        </div>
        <div className="flex flex-col gap-2 rounded-[11px] border border-dashed border-[var(--cf-border-strong)] p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <SelectBox value={draft.repo} onChange={(v) => setDraft({ ...draft, repo: v })} className="w-[150px] shrink-0" title={l("En qué repositorio", "Which repository")}>
              <option value="*">{l("Todos los repos", "Every repo")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </SelectBox>
            <Btn small icon={Search} disabled={detecting || projects.length === 0} onClick={() => void detect()} title={l("Lee las pruebas de package.json, Cargo, Maven, Gradle, pytest, Go, .NET, Playwright o Cypress", "Reads the tests off package.json, Cargo, Maven, Gradle, pytest, Go, .NET, Playwright or Cypress")}>
              {detecting ? l("Detectando…", "Detecting…") : l("Detectar pruebas", "Detect tests")}
            </Btn>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SelectBox value={draft.kind ?? "other"} onChange={(v) => { const kind = v as TeamCheckKind; setDraft({ ...draft, kind, write: kind === "unit", when: kind === "e2e" ? "agent" : kind === "integration" ? "final" : "item" }); }} className="w-[130px] shrink-0" title={l("Qué tipo de prueba es", "What kind of test it is")}>
              {CHECK_KINDS.map((k) => <option key={k.value} value={k.value}>{l(k.es, k.en)}</option>)}
            </SelectBox>
            <input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} title={l("Comando que debe terminar sin error (código de salida 0)", "Command that must finish without error (exit code 0)")} placeholder="pnpm test" className={`${field} min-w-[180px] flex-1 font-mono`} />
            <input value={draft.label ?? ""} onChange={(e) => setDraft({ ...draft, label: e.target.value })} title={l("Nombre opcional, por ejemplo «Pruebas de contrato»", "Optional name, e.g. «Contract tests»")} placeholder={l("Nombre (opcional)", "Name (optional)")} className={`${field} w-[150px]`} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Seg size="sm" value={draft.when} onChange={(when) => setDraft({ ...draft, when })} options={whenOptions} />
            <ToggleChip on={!!draft.write} onClick={() => setDraft({ ...draft, write: !draft.write })} title={l("El agente agrega o actualiza pruebas de este tipo para lo que cambia", "The agent adds or updates tests of this kind for what it changes")}>
              {l("Las escribe", "Writes them")}
            </ToggleChip>
            <span className="flex-1" />
            <Btn
              kind="primary"
              small
              icon={Plus}
              title={l("Añade la prueba a la lista", "Adds the test to the list")}
              disabled={!draft.command.trim()}
              onClick={() => {
                set([...checks, { ...draft, command: draft.command.trim(), label: draft.label?.trim() ?? "" }]);
                setDraft({ ...draft, command: "", label: "" });
              }}
            >
              {l("Añadir", "Add")}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
