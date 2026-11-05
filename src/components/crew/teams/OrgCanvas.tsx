/**
 * The team as an org chart. Drop an agent (or a template) on a member and it reports to them; drag
 * a member onto another to move it with its whole branch, onto the background to report to the
 * lead, onto the bin to take it out. A move that would make a loop or a tree too deep is refused
 * on the spot, with the reason, before anything is saved.
 */
import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Crown, Eye, Lightbulb, Minus, Plus, Scan, Star, SquareTerminal, Trash2, UserPlus, Wrench } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { pushErrorToast } from "../../../state/toastStore";
import { canReport, layoutOrg, removeMember, reparent, type MoveVerdict } from "../../../lib/agents/hierarchy";
import type { Team, TeamMember } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { useDragSource, useDragStore, useDropTarget, type DragPayload } from "../kit/drag";
import { SPRING } from "../kit/ui";
import { lNow, useAgentStates, useL } from "../state";
import { agentFromTemplate, buildMember, insertMember } from "./teamDraft";

const SIZE = { w: 184, h: 68, gapX: 26, gapY: 56 };

function refusal(verdict: MoveVerdict): string {
  if (verdict.ok) return "";
  switch (verdict.reason) {
    case "cycle":
      return lNow("Así quedaría reportando a alguien de su propia rama.", "It would report to someone in its own branch.");
    case "depth":
      return lNow("La jerarquía no puede tener más de 3 niveles bajo el líder.", "The hierarchy cannot go more than 3 levels below the lead.");
    case "advisor":
      return lNow("El asesor no tiene a nadie a cargo.", "The advisor has nobody under it.");
    case "lead":
      return lNow("El líder no reporta a nadie del equipo.", "The lead reports to nobody in the team.");
    default:
      return "";
  }
}

type Update = (fn: (team: Team) => Team, now?: boolean) => void;

/** What dropping something on a member (or on the lead's level, `target = ""`) does. */
export async function dropOnto(team: Team, update: Update, payload: DragPayload, target: string, onAdded?: (id: string) => void) {
  const boss = target && team.members.find((m) => m.id === target)?.advisor ? "" : target;
  if (payload.kind === "node") {
    const verdict = canReport(team.members, team.lead, payload.id, boss);
    if (!verdict.ok) {
      if (verdict.reason !== "self") pushErrorToast(refusal(verdict));
      return;
    }
    update((t) => ({ ...t, members: reparent(t.members, t.lead, payload.id, boss) }), true);
    return;
  }
  if (payload.kind === "agent") {
    const agent = useAgentsStore.getState().roster.find((a) => a.id === payload.id);
    if (!agent) return;
    const member = buildMember(agent, boss);
    update((t) => insertMember(t, member), true);
    onAdded?.(member.id);
    return;
  }
  if (payload.kind === "template") {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!workspaceId) return;
    const made = await agentFromTemplate(payload.id, workspaceId).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (!made) return;
    const member = buildMember(made.agent, boss, made.advisor);
    update((t) => insertMember(t, member), true);
    onAdded?.(member.id);
  }
}

const accepts = (p: DragPayload) => p.kind === "agent" || p.kind === "template" || p.kind === "node";

function Node({
  member,
  team,
  x,
  y,
  selected,
  onSelect,
  update,
}: {
  member: TeamMember;
  team: Team;
  x: number;
  y: number;
  selected: boolean;
  onSelect: (id: string) => void;
  update: Update;
}) {
  const l = useL();
  const agent = useAgentsStore((s) => s.roster.find((a) => a.id === member.agent_id));
  const states = useAgentStates();
  const isLead = member.id === team.lead;
  const drag = useDragSource({ kind: "node", id: member.id }, () => (
    <span className="flex items-center gap-2 rounded-[12px] border border-[var(--cf-accent)] bg-[var(--cf-surface)] py-1 pl-1 pr-3 text-[12.5px] font-medium">
      <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={26} />
      {member.name}
    </span>
  ));
  const dragging = useDragStore((s) => s.payload);
  const verdict = dragging?.kind === "node" ? canReport(team.members, team.lead, dragging.id, member.advisor ? "" : member.id) : null;
  const drop = useDropTarget(
    `node:${member.id}`,
    (p) => accepts(p) && !(p.kind === "node" && p.id === member.id),
    (p) => void dropOnto(team, update, p, member.id, onSelect),
  );
  const blocked = drop.over && verdict && !verdict.ok;
  const state = states.get(member.agent_id) ?? "idle";

  return (
    <motion.div
      className="absolute left-0 top-0"
      initial={false}
      animate={{ x, y }}
      transition={SPRING}
      style={{ width: SIZE.w, height: SIZE.h }}
    >
      <button
        type="button"
        {...drag}
        {...drop.props}
        onClick={() => onSelect(member.id)}
        aria-pressed={selected}
        title={`${member.name || agent?.name || "—"}${member.role || agent?.role ? ` · ${member.role || agent?.role}` : ""} — ${l("clic para ver su ficha; arrástralo para moverlo con su rama", "click to open its details; drag to move it with its branch")}`}
        className={`group relative flex h-full w-full cursor-grab touch-none items-center gap-2.5 rounded-[14px] border bg-[var(--cf-surface-raised)] px-2.5 text-left shadow-[0_1px_2px_rgba(0,0,0,0.05)] transition-[border-color,box-shadow] active:cursor-grabbing ${
          blocked
            ? "border-[var(--cf-danger)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-danger)_18%,transparent)]"
            : drop.over
              ? "border-[var(--cf-accent)] shadow-[0_0_0_3px_var(--cf-accent-soft)]"
              : selected
                ? "border-[var(--cf-accent)] shadow-[0_0_0_2px_var(--cf-accent-soft)]"
                : member.advisor
                  ? "border-dashed border-[color-mix(in_oklab,var(--cf-violet)_45%,var(--cf-surface))]"
                  : "border-[var(--cf-border)] hover:border-[var(--cf-border-strong)]"
        }`}
      >
        <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={40} state={state} />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[12.5px]">{member.name || agent?.name || "—"}</b>
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{member.role || agent?.role || agent?.model || ""}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[var(--cf-text-faint)]">
            {!member.edits && <span title={l("Solo lectura: no modifica archivos", "Read only: does not change files")}><Eye className="h-3 w-3" /></span>}
            {member.run_in === "terminal" && <span title={l("Corre en una terminal visible", "Runs in a visible terminal")}><SquareTerminal className="h-3 w-3" /></span>}
            {member.hands_on && <span title={l("Además de coordinar, también hace tareas", "Besides coordinating, it also does tasks")}><Wrench className="h-3 w-3" /></span>}
            {member.max_parallel > 1 && <span title={l(`Hasta ${member.max_parallel} tareas a la vez`, `Up to ${member.max_parallel} tasks at once`)} className="text-[10px] font-semibold tabular-nums">×{member.max_parallel}</span>}
            {agent?.model && <span title={l("Modelo que usa", "Model it uses")} className="truncate font-mono text-[10px]">{agent.model}</span>}
          </span>
        </span>
        {isLead && (
          <span title={l("Líder", "Lead")} className="absolute -top-2.5 left-3 grid h-5 w-5 place-items-center rounded-full bg-[var(--cf-warning)] text-white shadow">
            <Crown className="h-3 w-3" />
          </span>
        )}
        {member.leads && !isLead && (
          <span title={l("Sub-líder: planifica su rama", "Sub-lead: plans its branch")} className="absolute -top-2.5 left-3 grid h-5 w-5 place-items-center rounded-full bg-[var(--cf-accent)] text-white shadow">
            <Star className="h-3 w-3" />
          </span>
        )}
        {member.advisor && (
          <span title={l("Asesor", "Advisor")} className="absolute -top-2.5 left-3 grid h-5 w-5 place-items-center rounded-full bg-[var(--cf-violet)] text-white shadow">
            <Lightbulb className="h-3 w-3" />
          </span>
        )}
        {drop.over && !blocked && dragging?.kind !== "node" && (
          <span className="pointer-events-none absolute -bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--cf-accent)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--cf-on-accent)]">
            <UserPlus className="h-3 w-3" />
            {member.advisor ? l("al líder", "to the lead") : l("le reporta", "reports here")}
          </span>
        )}
        {blocked && verdict && !verdict.ok && verdict.reason !== "self" && (
          <span className="pointer-events-none absolute -bottom-3 left-1/2 max-w-[220px] -translate-x-1/2 truncate whitespace-nowrap rounded-full bg-[var(--cf-danger)] px-2 py-0.5 text-[10.5px] font-semibold text-white">
            {verdict.reason === "cycle" ? l("haría un ciclo", "makes a loop") : verdict.reason === "depth" ? l("demasiado hondo", "too deep") : l("no", "no")}
          </span>
        )}
      </button>
    </motion.div>
  );
}

function Bin({ team, update, onRemoved }: { team: Team; update: Update; onRemoved: (id: string) => void }) {
  const l = useL();
  const drop = useDropTarget(
    "org:bin",
    (p) => p.kind === "node",
    (p) => {
      const leaving = team.members.find((m) => m.id === p.id);
      if (!leaving) return;
      update((t) => {
        const members = removeMember(t.members, t.lead, p.id);
        const lead = t.lead === p.id ? members.find((m) => !m.advisor)?.id ?? "" : t.lead;
        return { ...t, members: lead !== t.lead ? members.map((m) => (m.id === lead ? { ...m, reports_to: "" } : m)) : members, lead };
      }, true);
      onRemoved(p.id);
    },
  );
  if (!drop.dragging) return null;
  return (
    <motion.div
      {...drop.props}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      className={`absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border-2 border-dashed px-4 py-2 text-[12.5px] font-semibold ${
        drop.over ? "border-[var(--cf-danger)] bg-[color-mix(in_oklab,var(--cf-danger)_14%,var(--cf-surface))] text-[var(--cf-danger)]" : "border-[var(--cf-border-strong)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)]"
      }`}
    >
      <Trash2 className="h-4 w-4" />
      {l("Soltar aquí para sacarlo del equipo", "Drop here to take it out")}
    </motion.div>
  );
}

export function OrgCanvas({ team, update, selected, onSelect }: { team: Team; update: Update; selected: string | null; onSelect: (id: string | null) => void }) {
  const l = useL();
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutOrg(team.members, team.lead, SIZE), [team.members, team.lead]);
  const at = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const drop = useDropTarget("org:canvas", accepts, (p) => void dropOnto(team, update, p, "", onSelect));
  const pad = 40;
  const lead = at.get(team.lead);

  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
      <div
        {...drop.props}
        className={`absolute inset-0 overflow-auto bg-[radial-gradient(circle,var(--cf-border)_1px,transparent_1px)] [background-size:22px_22px] transition-colors ${drop.over ? "bg-[color-mix(in_oklab,var(--cf-accent)_5%,transparent)]" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        {team.members.length === 0 ? (
          <div className="grid h-full place-items-center p-6">
            <div className={`flex max-w-[380px] flex-col items-center gap-2 rounded-[18px] border-2 border-dashed p-8 text-center ${drop.over ? "border-[var(--cf-accent)] text-[var(--cf-accent)]" : "border-[var(--cf-border-strong)] text-[var(--cf-text-muted)]"}`}>
              <UserPlus className="h-8 w-8" />
              <b className="text-[13.5px] text-[var(--cf-text)]">{l("Arrastra aquí al primero", "Drag the first one here")}</b>
              <span className="text-[12.5px]">{l("El primero que sueltes será el líder. Luego suelta a los demás sobre quien les toque reportar.", "The first one you drop becomes the lead. Then drop the rest on whoever they report to.")}</span>
            </div>
          </div>
        ) : (
          <div style={{ width: (layout.width + pad * 2) * zoom, height: (layout.height + pad * 2 + 30) * zoom, minWidth: "100%" }} className="relative" onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
            <div className="absolute left-1/2 top-0 origin-top" style={{ width: layout.width + pad * 2, height: layout.height + pad * 2, transform: `translateX(-50%) scale(${zoom})` }} onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
              <div className="absolute" style={{ left: pad, top: pad + 10, width: layout.width, height: layout.height }}>
                {layout.frames.map((f) => {
                  const m = team.members.find((x) => x.id === f.id);
                  return (
                    <motion.div
                      key={f.id}
                      initial={false}
                      animate={{ x: f.x, y: f.y, width: f.w, height: f.h }}
                      transition={SPRING}
                      className="pointer-events-none absolute left-0 top-0 rounded-[18px] border border-dashed border-[var(--cf-accent-line)] bg-[color-mix(in_oklab,var(--cf-accent)_4%,transparent)]"
                    >
                      <span className="absolute bottom-1.5 right-3 text-[10.5px] font-semibold text-[var(--cf-accent)]">
                        {l(`Rama de ${m?.name ?? ""}`, `${m?.name ?? ""}'s branch`)}
                      </span>
                    </motion.div>
                  );
                })}
                <svg className="pointer-events-none absolute inset-0 overflow-visible" width={layout.width} height={layout.height} aria-hidden>
                  {layout.edges.map((e) => {
                    const a = at.get(e.from);
                    const b = at.get(e.to);
                    if (!a || !b) return null;
                    const x1 = a.x + SIZE.w / 2;
                    const y1 = a.y + SIZE.h;
                    const x2 = b.x + SIZE.w / 2;
                    const y2 = b.y;
                    const mid = (y1 + y2) / 2;
                    return (
                      <motion.path
                        key={`${e.from}-${e.to}`}
                        initial={false}
                        d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`}
                        animate={{ d: `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}` }}
                        transition={SPRING}
                        fill="none"
                        stroke="var(--cf-border-strong)"
                        strokeWidth={1.6}
                      />
                    );
                  })}
                  {lead &&
                    team.members
                      .filter((m) => m.advisor)
                      .map((m) => {
                        const b = at.get(m.id);
                        if (!b) return null;
                        return (
                          <motion.path
                            key={`adv-${m.id}`}
                            initial={false}
                            d={`M${lead.x + SIZE.w},${lead.y + SIZE.h / 2} L${b.x},${b.y + SIZE.h / 2}`}
                            animate={{ d: `M${lead.x + SIZE.w},${lead.y + SIZE.h / 2} L${b.x},${b.y + SIZE.h / 2}` }}
                            fill="none"
                            stroke="var(--cf-violet)"
                            strokeWidth={1.4}
                            strokeDasharray="4 4"
                            opacity={0.7}
                          />
                        );
                      })}
                </svg>
                {team.members.map((m) => {
                  const n = at.get(m.id);
                  if (!n) return null;
                  return <Node key={m.id} member={m} team={team} x={n.x} y={n.y} selected={selected === m.id} onSelect={onSelect} update={update} />;
                })}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface)] p-0.5 shadow-[var(--cf-shadow)]">
        <button type="button" aria-label="−" title={l("Alejar", "Zoom out")} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setZoom(1)} title={l("Tamaño real", "Actual size")} className="h-7 min-w-[44px] rounded-[7px] px-1 text-[11.5px] tabular-nums text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" aria-label="+" title={l("Acercar", "Zoom in")} onClick={() => setZoom((z) => Math.min(1.4, +(z + 0.1).toFixed(2)))} className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={l("Que quepa", "Fit")}
          onClick={() => {
            const rect = box.current?.getBoundingClientRect();
            if (rect) setZoom(Math.max(0.5, Math.min(1.2, +Math.min(rect.width / (layout.width + pad * 2), rect.height / (layout.height + pad * 2 + 30)).toFixed(2))));
          }}
          className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
        >
          <Scan className="h-3.5 w-3.5" />
        </button>
      </div>
      <Bin team={team} update={update} onRemoved={(id) => selected === id && onSelect(null)} />
    </div>
  );
}
