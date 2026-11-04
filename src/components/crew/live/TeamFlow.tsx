/**
 * «Equipo»: the run's members in their hierarchy, each showing what it is on right now. Every
 * message between two of them travels the chart as a dot, so who is talking to whom is visible
 * without reading the channel.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Crown, Lightbulb, Star } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { layoutOrg } from "../../../lib/agents/hierarchy";
import type { TeamMessage, TeamRunState } from "../../../types/team";
import { AgentAvatar, type AgentState } from "../kit/Avatar";
import { SPRING } from "../kit/ui";
import { useCrewStore, useL } from "../state";
import { MESSAGE_KIND } from "./look";

const SIZE = { w: 196, h: 74, gapX: 26, gapY: 60 };
const PAD = 30;

interface Particle {
  id: string;
  from: string;
  to: string;
  color: string;
}

function particleColor(m: TeamMessage): string {
  switch (m.kind) {
    case "question":
      return "var(--cf-warning)";
    case "handoff":
    case "merge":
      return "var(--cf-success)";
    case "advice":
    case "decision":
      return "var(--cf-violet)";
    case "error":
      return "var(--cf-danger)";
    default:
      return "var(--cf-accent)";
  }
}

export function TeamFlow({ state }: { state: TeamRunState }) {
  const l = useL();
  const crew = useCrewStore();
  const roster = useAgentsStore((s) => s.roster);
  const { run } = state;
  const layout = useMemo(() => layoutOrg(run.members, run.lead, SIZE), [run.members, run.lead]);
  const at = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const seen = useRef<Set<string> | null>(null);
  const [particles, setParticles] = useState<Particle[]>([]);
  const lastBetween = useMemo(() => {
    const map = new Map<string, TeamMessage>();
    for (const m of state.messages) if (m.from_id && at.has(m.from_id)) map.set(m.from_id, m);
    return map;
  }, [state.messages, at]);

  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(state.messages.map((m) => m.id));
      return;
    }
    const fresh: Particle[] = [];
    for (const m of state.messages) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      const to = m.to_id === "lead" ? run.lead : m.to_id;
      if (!at.has(m.from_id)) continue;
      const targets = to === "all" ? run.members.filter((x) => x.id !== m.from_id).map((x) => x.id) : at.has(to) ? [to] : [];
      for (const t of targets) fresh.push({ id: `${m.id}:${t}`, from: m.from_id, to: t, color: particleColor(m) });
    }
    if (fresh.length === 0) return;
    setParticles((p) => [...p, ...fresh].slice(-24));
    const timer = window.setTimeout(() => setParticles((p) => p.filter((x) => !fresh.includes(x))), 1500);
    return () => window.clearTimeout(timer);
  }, [state.messages, at, run.lead, run.members]);

  const center = (id: string) => {
    const n = at.get(id);
    return n ? { x: PAD + n.x + SIZE.w / 2, y: PAD + n.y + SIZE.h / 2 } : null;
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle,var(--cf-border)_1px,transparent_1px)] [background-size:22px_22px]">
      <div className="relative mx-auto" style={{ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }}>
        {layout.frames.map((f) => (
          <div key={f.id} className="pointer-events-none absolute rounded-[18px] border border-dashed border-[var(--cf-accent-line)] bg-[color-mix(in_oklab,var(--cf-accent)_4%,transparent)]" style={{ left: PAD + f.x, top: PAD + f.y, width: f.w, height: f.h }} />
        ))}
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={layout.width + PAD * 2} height={layout.height + PAD * 2} aria-hidden>
          {layout.edges.map((e) => {
            const a = at.get(e.from);
            const b = at.get(e.to);
            if (!a || !b) return null;
            const x1 = PAD + a.x + SIZE.w / 2;
            const y1 = PAD + a.y + SIZE.h;
            const x2 = PAD + b.x + SIZE.w / 2;
            const y2 = PAD + b.y;
            const mid = (y1 + y2) / 2;
            return <path key={`${e.from}-${e.to}`} d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`} fill="none" stroke="var(--cf-border-strong)" strokeWidth={1.5} />;
          })}
          <AnimatePresence>
            {particles.map((p) => {
              const a = center(p.from);
              const b = center(p.to);
              if (!a || !b) return null;
              return (
                <motion.circle key={p.id} r={5} fill={p.color} initial={{ cx: a.x, cy: a.y, opacity: 0 }} animate={{ cx: b.x, cy: b.y, opacity: [0, 1, 1, 0] }} exit={{ opacity: 0 }} transition={{ duration: 1.2, ease: "easeInOut" }} />
              );
            })}
          </AnimatePresence>
        </svg>
        {run.members.map((m) => {
          const n = at.get(m.id);
          if (!n) return null;
          const agent = roster.find((a) => a.id === m.agent_id);
          const mine = state.items.filter((i) => i.member_id === m.id);
          const current = mine.find((i) => i.status === "running") ?? mine.find((i) => i.status === "waiting");
          const done = mine.filter((i) => i.status === "done").length;
          const avatarState: AgentState = mine.some((i) => i.status === "running") ? "thinking" : mine.some((i) => i.status === "waiting") ? "waiting" : mine.some((i) => i.status === "error") ? "error" : "idle";
          const last = lastBetween.get(m.id);
          return (
            <motion.button
              key={m.id}
              type="button"
              initial={false}
              animate={{ x: PAD + n.x, y: PAD + n.y }}
              transition={SPRING}
              onClick={() => crew.open({ kind: "chat", runId: run.id, memberId: m.id })}
              title={l("Abrir su chat", "Open its chat")}
              style={{ width: SIZE.w, height: SIZE.h }}
              className={`absolute left-0 top-0 flex items-center gap-2.5 rounded-[14px] border bg-[var(--cf-surface-raised)] px-2.5 text-left hover:border-[var(--cf-border-strong)] ${m.advisor ? "border-dashed border-[color-mix(in_oklab,var(--cf-violet)_45%,var(--cf-surface))]" : "border-[var(--cf-border)]"}`}
            >
              <AgentAvatar agent={{ id: m.agent_id, icon: m.icon || agent?.icon, color: m.color || agent?.color }} size={40} state={avatarState} />
              <span className="min-w-0 flex-1">
                <b className="flex items-center gap-1 truncate text-[12.5px]">
                  {m.name}
                  {m.id === run.lead && <Crown className="h-3 w-3 shrink-0 text-[var(--cf-warning)]" />}
                  {m.leads && <Star className="h-3 w-3 shrink-0 text-[var(--cf-accent)]" />}
                  {m.advisor && <Lightbulb className="h-3 w-3 shrink-0 text-[var(--cf-violet)]" />}
                </b>
                <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{current ? current.title : last ? `${l((MESSAGE_KIND[last.kind] ?? MESSAGE_KIND.note)[0], (MESSAGE_KIND[last.kind] ?? MESSAGE_KIND.note)[1])}: ${last.body}` : l("Libre", "Free")}</span>
                <span className="block text-[10.5px] tabular-nums text-[var(--cf-text-faint)]">
                  {done}/{mine.length} · {m.model}
                </span>
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
