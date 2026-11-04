/**
 * «Tareas»: the run's work as it grows. Each new item slides into its column; what waits on what
 * is a line, and lines into work in flight carry a moving dash. Items running side by side are the
 * parallelism — counted in the corner.
 */
import { useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CircleHelp, GitMerge, Lock, RotateCw, SquareTerminal, Zap } from "lucide-react";
import { useAgentsStore } from "../../../state/agentsStore";
import { layoutRun, parallelism } from "../../../lib/agents/runGraph";
import type { TeamRunState } from "../../../types/team";
import { AgentAvatar } from "../kit/Avatar";
import { SPRING } from "../kit/ui";
import { useL } from "../state";
import { ITEM_KIND, ITEM_STATUS, itemColor } from "./look";

const W = 216;
const H = 78;
const GX = 58;
const GY = 16;
const PAD = 24;

export function WorkGraph({ state, selected, onSelect }: { state: TeamRunState; selected: string | null; onSelect: (id: string | null) => void }) {
  const l = useL();
  const roster = useAgentsStore((s) => s.roster);
  const graph = useMemo(() => layoutRun(state.items), [state.items]);
  const par = useMemo(() => parallelism(state.items), [state.items]);
  const box = useRef<HTMLDivElement>(null);
  const lastCols = useRef(graph.cols);
  const byId = useMemo(() => new Map(state.items.map((i) => [i.id, i])), [state.items]);

  // When the plan grows a column, follow it — unless the reader has scrolled back to look.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (graph.cols > lastCols.current && el.scrollLeft + el.clientWidth >= el.scrollWidth - (W + GX) * 1.5) {
      el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
    }
    lastCols.current = graph.cols;
  }, [graph.cols]);

  const width = graph.cols * (W + GX) - GX + PAD * 2;
  const height = graph.rows * (H + GY) - GY + PAD * 2;
  const at = (id: string) => {
    const p = graph.pos.get(id) ?? { col: 0, row: 0 };
    return { x: PAD + p.col * (W + GX), y: PAD + p.row * (H + GY) };
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={box} className="absolute inset-0 overflow-auto bg-[radial-gradient(circle,var(--cf-border)_1px,transparent_1px)] [background-size:22px_22px]" onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
        <div className="relative" style={{ width, height, minWidth: "100%", minHeight: "100%" }} onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={width} height={height} aria-hidden>
            {graph.edges.map((e) => {
              const a = at(e.from);
              const b = at(e.to);
              const target = byId.get(e.to);
              const live = target?.status === "running";
              const x1 = a.x + W;
              const y1 = a.y + H / 2;
              const x2 = b.x;
              const y2 = b.y + H / 2;
              const d = `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`;
              return (
                <g key={`${e.from}-${e.to}`}>
                  <motion.path initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1, d }} transition={{ duration: 0.5 }} fill="none" stroke={live ? "var(--cf-accent)" : e.kind === "delegate" ? "var(--cf-blue)" : "var(--cf-border-strong)"} strokeWidth={live ? 1.8 : 1.4} strokeDasharray={e.kind === "plan" ? "3 4" : undefined} opacity={e.kind === "plan" ? 0.7 : 1} />
                  {live && <path d={d} fill="none" stroke="var(--cf-accent)" strokeWidth={2} className="cf-crew-flow" />}
                </g>
              );
            })}
          </svg>
          <AnimatePresence initial={false}>
            {state.items.map((item) => {
              const { x, y } = at(item.id);
              const member = state.run.members.find((m) => m.id === item.member_id);
              const agent = roster.find((a) => a.id === member?.agent_id);
              const [es, en] = ITEM_STATUS[item.status] ?? ITEM_STATUS.pending;
              const [kes, ken] = ITEM_KIND[item.kind] ?? ITEM_KIND.work;
              const running = item.status === "running";
              const dim = item.status === "skipped" || item.status === "cancelled";
              return (
                <motion.button
                  key={item.id}
                  type="button"
                  initial={{ opacity: 0, scale: 0.85, x, y }}
                  animate={{ opacity: dim ? 0.5 : 1, scale: 1, x, y }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={SPRING}
                  onClick={() => onSelect(item.id)}
                  style={{ width: W, height: H, ["--cf-crew-c" as string]: itemColor(item) }}
                  className={`absolute left-0 top-0 flex flex-col justify-between rounded-[13px] border bg-[var(--cf-surface-raised)] px-2.5 py-2 text-left ${running ? "cf-crew-working" : ""} ${
                    selected === item.id ? "border-[var(--cf-accent)] shadow-[0_0_0_2px_var(--cf-accent-soft)]" : item.status === "waiting" || item.status === "gated" ? "cf-crew-waiting border-[color-mix(in_oklab,var(--cf-warning)_50%,var(--cf-surface))]" : "border-[var(--cf-border)] hover:border-[var(--cf-border-strong)]"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {member ? (
                      <AgentAvatar agent={{ id: member.agent_id, icon: member.icon || agent?.icon, color: member.color || agent?.color }} size={20} />
                    ) : (
                      <span className="h-5 w-5 rounded-[6px] bg-[var(--cf-sunken)]" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{item.member_name || l("Líder", "Lead")}</span>
                    {item.status === "waiting" && <CircleHelp className="h-3.5 w-3.5 text-[var(--cf-warning)]" />}
                    {item.status === "gated" && <Lock className="h-3.5 w-3.5 text-[var(--cf-warning)]" />}
                    {item.merged && <GitMerge className="h-3.5 w-3.5 text-[var(--cf-success)]" />}
                    {item.run_in === "terminal" && <SquareTerminal className="h-3.5 w-3.5 text-[var(--cf-text-faint)]" />}
                  </span>
                  <span className="line-clamp-2 text-[12px] leading-snug">{item.title}</span>
                  <span className="flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: itemColor(item) }} />
                    {l(es, en)} · {l(kes, ken)}
                    {item.attempts > 1 && (
                      <span className="inline-flex items-center gap-0.5" title={l("Intentos", "Attempts")}>
                        · <RotateCw className="h-2.5 w-2.5" />
                        {item.attempts}
                      </span>
                    )}
                    {item.model && <span className="ml-auto truncate font-mono text-[10px] text-[var(--cf-violet)]">{item.model}</span>}
                  </span>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold shadow-[var(--cf-shadow)] ${par.now > 1 ? "border-[var(--cf-accent-line)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)]"}`}>
          <Zap className="h-3.5 w-3.5" />
          {l(`${par.now} en paralelo`, `${par.now} in parallel`)}
          <span className="font-normal text-[var(--cf-text-faint)]">· {l(`pico ${par.peak}`, `peak ${par.peak}`)}</span>
        </span>
      </div>
    </div>
  );
}
