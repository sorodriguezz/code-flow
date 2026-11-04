/**
 * The side of the org chart: the team's rules when nobody is picked, the member's scope when one
 * is. Every field saves itself (`teamDraft`); nothing here runs anything.
 */
import { useState, type ReactNode } from "react";
import {
  Brain,
  Coins,
  Crown,
  GitBranch,
  Lightbulb,
  MessagesSquare,
  Pencil,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  Star,
  Trash2,
  UserRoundCog,
  Wrench,
} from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useModelOptions } from "../kit/models";
import { canReport, removeMember, reparent, subtree } from "../../../lib/agents/hierarchy";
import { applyPreset, presetOf, type PolicyPreset, type Team, type TeamMember, type TeamPolicy } from "../../../types/team";
import { AgentAvatar, TeamAvatar } from "../kit/Avatar";
import { Btn, Label, Panel, Seg, Stepper, Switch, ToggleChip, field } from "../kit/ui";
import { useCrewStore, useL } from "../state";

type Update = (fn: (team: Team) => Team, now?: boolean) => void;
const NO_PROJECTS: never[] = [];

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[12.5px]">{label}</span>
        {hint && <span className="block text-[11.5px] text-[var(--cf-text-muted)]">{hint}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}

function usePanels(initial: string) {
  const [open, setOpen] = useState<Set<string>>(() => new Set([initial]));
  return {
    is: (id: string) => open.has(id),
    toggle: (id: string) =>
      setOpen((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  };
}

function MoneyInput({ value, onChange, step = 1, suffix }: { value: number; onChange: (v: number) => void; step?: number; suffix: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={0}
        step={step}
        value={value || ""}
        placeholder="∞"
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className={`${field} h-[28px] w-[86px] text-right tabular-nums`}
      />
      <span className="w-[42px] text-[11.5px] text-[var(--cf-text-muted)]">{suffix}</span>
    </span>
  );
}

export function TeamInspector({ team, update }: { team: Team; update: Update }) {
  const l = useL();
  const crew = useCrewStore();
  const panels = usePanels("work");
  const p = team.policy;
  const set = (patch: Partial<TeamPolicy>, now = true) => update((t) => ({ ...t, policy: { ...t.policy, ...patch } }), now);
  const preset = presetOf(p);
  const advisor = team.members.find((m) => m.advisor);
  const others = team.members.filter((m) => !m.advisor);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <TeamAvatar size={44} />
        <div className="min-w-0 flex-1">
          <input value={team.name} onChange={(e) => update((t) => ({ ...t, name: e.target.value }))} placeholder={l("Nombre del equipo", "Team name")} className="w-full bg-transparent text-[15px] font-semibold outline-none" />
          <input value={team.description} onChange={(e) => update((t) => ({ ...t, description: e.target.value }))} placeholder={l("¿Para qué es este equipo?", "What is this team for?")} className="w-full bg-transparent text-[12px] text-[var(--cf-text-muted)] outline-none" />
        </div>
      </div>

      <Panel title={l("Cómo trabaja", "How it works")} icon={Settings2} open={panels.is("work")} onToggle={() => panels.toggle("work")}>
        <Seg<PolicyPreset | "custom">
          size="sm"
          value={preset ?? "custom"}
          onChange={(v) => v !== "custom" && update((t) => ({ ...t, policy: applyPreset(t.policy, v) }), true)}
          options={[
            { value: "autonomous", label: l("Autónomo", "Autonomous") },
            { value: "supervised", label: l("Supervisado", "Supervised") },
            { value: "stepwise", label: l("Paso a paso", "Step by step") },
            ...(preset ? [] : [{ value: "custom" as const, label: l("A medida", "Custom") }]),
          ]}
        />
        <Switch checked={p.approve_plan} onChange={(approve_plan) => set({ approve_plan })} label={l("Apruebo el plan", "I approve the plan")} hint={l("El líder espera tu visto bueno antes de repartir.", "The lead waits for your go before handing out work.")} />
        <Row label={l("Apruebo el código", "I approve code")}>
          <select value={p.approve_code} onChange={(e) => set({ approve_code: e.target.value as TeamPolicy["approve_code"] })} className={`${field} h-[28px] w-[130px]`}>
            <option value="never">{l("Nunca", "Never")}</option>
            <option value="first">{l("El primero", "The first")}</option>
            <option value="each">{l("Cada uno", "Each one")}</option>
          </select>
        </Row>
        <Switch checked={p.approve_merge} onChange={(approve_merge) => set({ approve_merge })} label={l("Apruebo la integración", "I approve the merge")} />
        <Row label={l("Preguntas para ti", "Questions for you")}>
          <select value={p.questions} onChange={(e) => set({ questions: e.target.value as TeamPolicy["questions"] })} className={`${field} h-[28px] w-[130px]`}>
            <option value="allow">{l("Cuando quieran", "Any time")}</option>
            <option value="plan">{l("Solo al planear", "Only planning")}</option>
            <option value="never">{l("Nunca", "Never")}</option>
          </select>
        </Row>
        <Row label={l("Líder", "Lead")} hint={team.lead ? undefined : l("Sin líder, el equipo sigue el flujo fijo.", "Without a lead, the team follows the fixed flow.")}>
          <select
            value={team.lead}
            onChange={(e) => {
              const lead = e.target.value;
              update((t) => ({ ...t, lead, members: t.members.map((m) => (m.id === lead ? { ...m, reports_to: "", advisor: false } : m.reports_to === lead ? { ...m, reports_to: "" } : m)) }), true);
            }}
            className={`${field} h-[28px] w-[150px]`}
          >
            <option value="">{l("Ninguno (flujo fijo)", "None (fixed flow)")}</option>
            {others.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Row>
      </Panel>

      <Panel title="Git" icon={GitBranch} open={panels.is("git")} onToggle={() => panels.toggle("git")}>
        <Row label={l("Commits", "Commits")}>
          <select value={p.commit} onChange={(e) => set({ commit: e.target.value as TeamPolicy["commit"] })} className={`${field} h-[28px] w-[150px]`}>
            <option value="item">{l("Uno por tarea", "One per task")}</option>
            <option value="squash">{l("Uno al final", "One at the end")}</option>
            <option value="none">{l("Ninguno", "None")}</option>
          </select>
        </Row>
        <Row label={l("Estilo", "Style")}>
          <Seg size="sm" value={p.commit_style} onChange={(commit_style) => set({ commit_style })} options={[{ value: "conventional", label: "Conventional" }, { value: "free", label: l("Libre", "Free") }]} />
        </Row>
        <Row label={l("Al terminar", "When done")}>
          <Seg size="sm" value={p.integrate} onChange={(integrate) => set({ integrate })} options={[{ value: "merge", label: l("Integrar", "Merge") }, { value: "branch", label: l("Dejar rama", "Leave branch") }]} />
        </Row>
        <Switch checked={p.push} onChange={(push) => set({ push })} label={l("Hacer push", "Push")} />
        <Row label={l("Conflictos", "Conflicts")}>
          <select value={p.conflicts} onChange={(e) => set({ conflicts: e.target.value })} className={`${field} h-[28px] w-[150px]`}>
            <option value="author">{l("Los resuelve el autor", "The author solves them")}</option>
            <option value="user">{l("Me los pasan a mí", "Hand them to me")}</option>
            {others.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </Row>
        <Switch checked={p.cleanup} onChange={(cleanup) => set({ cleanup })} label={l("Limpiar worktrees al terminar", "Clean worktrees when done")} />
      </Panel>

      <Panel title={l("Revisión", "Review")} icon={ShieldCheck} open={panels.is("review")} onToggle={() => panels.toggle("review")}>
        <Switch checked={p.review.enabled} onChange={(enabled) => set({ review: { ...p.review, enabled } })} label={l("Revisión entre pares", "Peer review")} hint={l("Un miembro revisa el trabajo de otros antes de integrarlo.", "A member reviews others' work before it is merged.")} />
        {p.review.enabled && (
          <>
            <Row label={l("Revisa", "Reviewer")}>
              <select value={p.review.reviewer} onChange={(e) => set({ review: { ...p.review, reviewer: e.target.value } })} className={`${field} h-[28px] w-[150px]`}>
                <option value="">{l("El líder", "The lead")}</option>
                {others.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </Row>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Revisa a (vacío: todos los que editan)", "Reviews (empty: everyone who edits)")}</span>
              <div className="flex flex-wrap gap-1.5">
                {others.map((m) => (
                  <ToggleChip key={m.id} on={p.review.of.includes(m.id)} onClick={() => set({ review: { ...p.review, of: p.review.of.includes(m.id) ? p.review.of.filter((x) => x !== m.id) : [...p.review.of, m.id] } })}>
                    {m.name}
                  </ToggleChip>
                ))}
              </div>
            </div>
            <Row label={l("Exigencia", "Bar")}>
              <Seg size="sm" value={p.review.exigence} onChange={(exigence) => set({ review: { ...p.review, exigence } })} options={[{ value: "correct", label: l("Correcto", "Correct") }, { value: "polished", label: l("Pulido", "Polished") }]} />
            </Row>
            <Row label={l("Vueltas máximas", "Max laps")}>
              <Stepper value={p.review.laps} min={1} max={8} onChange={(laps) => set({ review: { ...p.review, laps } })} label="laps" />
            </Row>
          </>
        )}
        <Switch checked={p.lead_final_check} onChange={(lead_final_check) => set({ lead_final_check })} label={l("El líder revisa al final", "The lead checks at the end")} />
      </Panel>

      <Panel title={l("Recursos y presupuesto", "Resources and budget")} icon={Coins} open={panels.is("budget")} onToggle={() => panels.toggle("budget")}>
        <Row label={l("Tareas a la vez", "Tasks at once")}>
          <Stepper value={p.max_parallel} min={1} max={12} onChange={(max_parallel) => set({ max_parallel })} label="parallel" />
        </Row>
        <Row label={l("Intentos por tarea", "Attempts per task")}>
          <Stepper value={p.max_attempts} min={1} max={6} onChange={(max_attempts) => set({ max_attempts })} label="attempts" />
        </Row>
        <Row label={l("Rondas del líder", "Lead rounds")}>
          <Stepper value={p.lead_rounds} min={1} max={20} onChange={(lead_rounds) => set({ lead_rounds })} label="rounds" />
        </Row>
        <Row label={l("Rondas de un sub-líder", "Sub-lead rounds")}>
          <Stepper value={p.sub_lead_rounds} min={1} max={12} onChange={(sub_lead_rounds) => set({ sub_lead_rounds })} label="sub rounds" />
        </Row>
        <div className="my-1 h-px bg-[var(--cf-border)]" />
        <Row label={l("Gasto", "Spend")} hint={l("Vacío: sin límite", "Empty: no limit")}>
          <MoneyInput value={p.budget_usd} step={0.5} onChange={(budget_usd) => set({ budget_usd }, false)} suffix="USD" />
        </Row>
        <Row label="Tokens">
          <MoneyInput value={p.budget_tokens} step={10000} onChange={(budget_tokens) => set({ budget_tokens }, false)} suffix="tok" />
        </Row>
        <Row label={l("Minutos de agente", "Agent minutes")}>
          <MoneyInput value={p.budget_minutes} step={5} onChange={(budget_minutes) => set({ budget_minutes }, false)} suffix="min" />
        </Row>
        <Row label={l("Avisar al", "Warn at")}>
          <MoneyInput value={p.budget_warn_pct} step={5} onChange={(budget_warn_pct) => set({ budget_warn_pct: Math.min(100, budget_warn_pct) }, false)} suffix="%" />
        </Row>
        <p className="m-0 text-[11.5px] text-[var(--cf-text-muted)]">{l("Al llegar al tope el equipo espera tu aprobación; si apruebas, el presupuesto crece la mitad.", "At the cap the team waits for your approval; approving grows the budget by half.")}</p>
      </Panel>

      <Panel title={l("Comunicación", "Communication")} icon={MessagesSquare} open={panels.is("comms")} onToggle={() => panels.toggle("comms")}>
        <Seg
          size="sm"
          value={p.comms}
          onChange={(comms) => set({ comms })}
          options={[
            { value: "open", label: l("Abierta", "Open") },
            { value: "tree", label: l("Por jerarquía", "Chain") },
            { value: "tree_siblings", label: l("Jerarquía y pares", "Chain + peers") },
          ]}
        />
        <p className="m-0 text-[11.5px] text-[var(--cf-text-muted)]">
          {p.comms === "open"
            ? l("Cualquiera puede escribirle a cualquiera.", "Anyone can message anyone.")
            : p.comms === "tree"
              ? l("Cada uno habla con su jefe y con quienes le reportan; lo demás pasa por el jefe.", "Each talks to its manager and reports; the rest goes through the manager.")
              : l("Como por jerarquía, y además entre quienes comparten jefe.", "Like chain, plus those who share a manager.")}
        </p>
        <Switch checked={p.escalate_questions} onChange={(escalate_questions) => set({ escalate_questions })} label={l("Las preguntas suben por la cadena", "Questions climb the chain")} hint={l("Solo el líder te pregunta a ti.", "Only the lead asks you.")} />
        <Row label={l("Notas por tarea", "Notes per task")} hint={l("0: sin límite", "0: no limit")}>
          <Stepper value={p.max_notes_per_item} min={0} max={30} onChange={(max_notes_per_item) => set({ max_notes_per_item })} label="notes" />
        </Row>
        <Row label={l("Aviso de ping-pong", "Ping-pong alert")} hint={l("Idas y vueltas entre dos", "Back-and-forths between two")}>
          <Stepper value={p.ping_pong_laps} min={2} max={10} onChange={(ping_pong_laps) => set({ ping_pong_laps })} label="laps" />
        </Row>
      </Panel>

      <Panel title={l("Decisor y asesor", "Decider and advisor")} icon={Brain} open={panels.is("decider")} onToggle={() => panels.toggle("decider")}>
        <Switch checked={p.decider} onChange={(decider) => set({ decider })} label={l("Usar la capa de decisión", "Use the decision layer")} hint={l("Reintentar o escalar lo vota un modelo barato antes de gastar un turno del líder.", "Retry or escalate is voted by a cheap model before paying for a lead turn.")} />
        <div>
          <Btn small icon={Settings2} onClick={() => crew.open({ kind: "decider" })}>{l("Configurar decisor", "Set up the decider")}</Btn>
        </div>
        <div className="my-1 h-px bg-[var(--cf-border)]" />
        {advisor ? (
          <div className="flex items-center gap-2 rounded-[9px] border border-dashed border-[color-mix(in_oklab,var(--cf-violet)_45%,var(--cf-surface))] p-2">
            <Lightbulb className="h-4 w-4 text-[var(--cf-violet)]" />
            <span className="min-w-0 flex-1 text-[12px]">
              {l(`«${advisor.name}» aconseja antes del plan, ante un error repetido y antes de terminar.`, `«${advisor.name}» advises before the plan, on a repeated error and before finishing.`)}
            </span>
          </div>
        ) : (
          <p className="m-0 text-[11.5px] text-[var(--cf-text-muted)]">
            {l("Arrastra la plantilla «Asesor» al organigrama: un modelo fuerte que solo lee y aconseja en tres momentos, con un resumen en vez de toda la conversación.", "Drag the «Advisor» template onto the chart: a strong model that only reads and advises at three moments, from a digest instead of the whole conversation.")}
          </p>
        )}
      </Panel>
    </div>
  );
}

export function MemberInspector({ team, member, update, onClose }: { team: Team; member: TeamMember; update: Update; onClose: () => void }) {
  const l = useL();
  const crew = useCrewStore();
  const agent = useAgentsStore((s) => s.roster.find((a) => a.id === member.agent_id));
  const projects = useWorkspaceStore((s) => (s.activeWorkspaceId ? s.projectsByWorkspace[s.activeWorkspaceId] ?? NO_PROJECTS : NO_PROJECTS));
  const models = useModelOptions(agent?.provider ?? "");

  const isLead = member.id === team.lead;
  const reports = subtree(team.members, team.lead, member.id);
  const others = team.members.filter((m) => m.id !== member.id);
  const set = (patch: Partial<TeamMember>, now = true) => update((t) => ({ ...t, members: t.members.map((m) => (m.id === member.id ? { ...m, ...patch } : m)) }), now);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={46} />
        <div className="min-w-0 flex-1">
          <input value={member.name} onChange={(e) => set({ name: e.target.value }, false)} className="w-full bg-transparent text-[15px] font-semibold outline-none" />
          <input value={member.role} onChange={(e) => set({ role: e.target.value }, false)} placeholder={l("Su papel en este equipo", "Its part in this team")} className="w-full bg-transparent text-[12px] text-[var(--cf-text-muted)] outline-none" />
        </div>
        <button type="button" onClick={onClose} className="text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">{l("Equipo", "Team")} ›</button>
      </div>

      {agent && (
        <button type="button" onClick={() => crew.open({ kind: "wizard", agentId: agent.id })} className="flex items-center gap-2 rounded-[10px] border border-[var(--cf-border)] px-2.5 py-2 text-left hover:bg-[var(--cf-hover)]">
          <UserRoundCog className="h-4 w-4 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 flex-1 text-[12px]">
            <b>{agent.name}</b>
            <span className="text-[var(--cf-text-muted)]"> · {agent.provider} · {agent.model}{agent.effort ? ` · ${agent.effort}` : ""}</span>
          </span>
          <Pencil className="h-3.5 w-3.5 text-[var(--cf-text-faint)]" />
        </button>
      )}

      <div className="flex flex-wrap gap-1.5">
        {isLead ? (
          <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_14%,var(--cf-surface))] px-2.5 text-[12px] font-semibold text-[var(--cf-warning)]"><Crown className="h-3.5 w-3.5" />{l("Es el líder", "Is the lead")}</span>
        ) : (
          !member.advisor && (
            <Btn small icon={Crown} onClick={() => update((t) => ({ ...t, lead: member.id, members: t.members.map((m) => (m.id === member.id ? { ...m, reports_to: "" } : m)) }), true)}>
              {l("Hacer líder", "Make lead")}
            </Btn>
          )
        )}
      </div>

      <div className="flex flex-col gap-0.5 rounded-[11px] border border-[var(--cf-border)] px-3 py-1.5">
        {!isLead && !member.advisor && (
          <Switch
            checked={member.leads}
            onChange={(leads) => set({ leads })}
            label={<span className="inline-flex items-center gap-1.5"><Star className="h-3.5 w-3.5 text-[var(--cf-accent)]" />{l("Sub-líder", "Sub-lead")}</span>}
            hint={reports.length ? l(`Planifica y reparte entre los ${reports.length} de su rama.`, `Plans and delegates among the ${reports.length} in its branch.`) : l("Suelta a alguien sobre él para darle una rama.", "Drop someone on it to give it a branch.")}
          />
        )}
        {(isLead || member.leads) && (
          <Switch checked={member.hands_on} onChange={(hands_on) => set({ hands_on })} label={<span className="inline-flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5" />{l("También trabaja", "Also works")}</span>} hint={l("Además de repartir, se puede asignar tareas a sí mismo.", "Besides delegating, it can take tasks itself.")} />
        )}
        {!isLead && (
          <Switch
            checked={member.advisor}
            onChange={(advisor) =>
              update((t) => {
                const members = advisor ? removeMember(t.members, t.lead, member.id) : t.members.filter((m) => m.id !== member.id);
                return { ...t, members: [...members, { ...member, advisor, leads: false, reports_to: "", edits: advisor ? false : member.edits }] };
              }, true)
            }
            label={<span className="inline-flex items-center gap-1.5"><Lightbulb className="h-3.5 w-3.5 text-[var(--cf-violet)]" />{l("Asesor", "Advisor")}</span>}
            hint={l("No recibe trabajo: aconseja en tres momentos.", "Gets no work: advises at three moments.")}
          />
        )}
        {!member.advisor && <Switch checked={member.edits} onChange={(edits) => set({ edits })} label={l("Puede editar archivos", "Can edit files")} />}
      </div>

      {!member.advisor && (
        <>
          <Row label={l("Corre en", "Runs in")}>
            <Seg size="sm" value={member.run_in} onChange={(run_in) => set({ run_in })} options={[{ value: "headless", label: l("Fondo", "Background") }, { value: "terminal", label: l("Terminal", "Terminal"), icon: SquareTerminal }]} />
          </Row>
          <Row label={l("Tareas a la vez", "Tasks at once")}>
            <Stepper value={member.max_parallel} min={1} max={6} onChange={(max_parallel) => set({ max_parallel })} label="parallel" />
          </Row>
        </>
      )}

      {!isLead && !member.advisor && (
        <div className="flex flex-col gap-1.5">
          <Label>{l("Reporta a", "Reports to")}</Label>
          <select
            value={member.reports_to}
            onChange={(e) => update((t) => ({ ...t, members: reparent(t.members, t.lead, member.id, e.target.value) }), true)}
            className={field}
          >
            <option value="">{team.lead ? `${team.members.find((m) => m.id === team.lead)?.name ?? ""} (${l("líder", "lead")})` : l("Nadie", "Nobody")}</option>
            {others
              .filter((m) => m.id !== team.lead && !m.advisor)
              .map((m) => {
                const verdict = canReport(team.members, team.lead, member.id, m.id);
                return (
                  <option key={m.id} value={m.id} disabled={!verdict.ok}>
                    {m.name}
                    {!verdict.ok ? ` — ${verdict.reason === "cycle" ? l("está en su rama", "in its branch") : l("muy hondo", "too deep")}` : ""}
                  </option>
                );
              })}
          </select>
        </div>
      )}

      {!member.advisor && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label>{l("Si se atasca, escala a", "When stuck, escalates to")}</Label>
            <select value={member.escalate_to} onChange={(e) => set({ escalate_to: e.target.value })} className={field}>
              <option value="">{l("Su jefe (por defecto)", "Its manager (default)")}</option>
              {others.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {team.policy.comms !== "open" && (
            <div className="flex flex-col gap-1.5">
              <Label>{l("Además habla con", "Also talks to")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {others.map((m) => (
                  <ToggleChip key={m.id} on={member.talks_to.includes(m.id)} onClick={() => set({ talks_to: member.talks_to.includes(m.id) ? member.talks_to.filter((x) => x !== m.id) : [...member.talks_to, m.id] })}>
                    {m.name}
                  </ToggleChip>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>{l("Repositorios (vacío: los de la tarea)", "Repositories (empty: the task's)")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {projects.map((p) => (
                <ToggleChip key={p.id} on={member.repos.includes(p.id)} onClick={() => set({ repos: member.repos.includes(p.id) ? member.repos.filter((x) => x !== p.id) : [...member.repos, p.id] })}>
                  {p.name}
                </ToggleChip>
              ))}
            </div>
          </div>

          {models.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <Label>{l("Escalera de modelos al reintentar", "Model ladder on retry")}</Label>
              <p className="m-0 text-[11.5px] text-[var(--cf-text-muted)]">{l("Empieza barato y sube solo si falla. En orden de clic.", "Starts cheap and climbs only on failure. In click order.")}</p>
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => {
                  const index = member.model_ladder.indexOf(m.id);
                  return (
                    <ToggleChip key={m.id} on={index >= 0} onClick={() => set({ model_ladder: index >= 0 ? member.model_ladder.filter((x) => x !== m.id) : [...member.model_ladder, m.id] })}>
                      {index >= 0 && <b className="tabular-nums">{index + 1}</b>}
                      {m.label}
                    </ToggleChip>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      <div className="pt-1">
        <Btn
          kind="danger"
          small
          icon={Trash2}
          onClick={() => {
            update((t) => {
              const members = removeMember(t.members, t.lead, member.id);
              const lead = t.lead === member.id ? members.find((m) => !m.advisor)?.id ?? "" : t.lead;
              return { ...t, members: members.map((m) => (m.id === lead ? { ...m, reports_to: "" } : m)), lead };
            }, true);
            onClose();
          }}
        >
          {l("Sacar del equipo", "Take out of the team")}
        </Btn>
      </div>
    </div>
  );
}
