import { Users } from "lucide-react";
import { agentIcon } from "../../../lib/agents/agentIcons";
import { agentColorVar } from "../../../lib/agents/agentColors";

export type AgentState = "idle" | "thinking" | "waiting" | "error" | "done";

/** An agent as the view draws it everywhere: its icon on its colour. A turn in flight is a border
 * whose gradient travels (never a rotating box), waiting on you is a soft halo. */
export function AgentAvatar({
  agent,
  size = 28,
  state = "idle",
  className = "",
  title,
}: {
  agent: { id: string; icon?: string; color?: string };
  size?: number;
  state?: AgentState;
  className?: string;
  title?: string;
}) {
  const Icon = agentIcon(agent.icon, agent.id);
  const color = agentColorVar(agent.color, agent.id);
  const stateClass = state === "thinking" ? "cf-crew-working" : state === "waiting" ? "cf-crew-waiting" : "";
  return (
    <span
      title={title}
      className={`relative inline-grid shrink-0 place-items-center ${stateClass} ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        color,
        background: `color-mix(in oklab, ${color} 15%, var(--cf-surface))`,
        boxShadow: state === "error" ? `inset 0 0 0 1.5px var(--cf-danger)` : `inset 0 0 0 1px color-mix(in oklab, ${color} 30%, var(--cf-surface))`,
        ["--cf-crew-c" as string]: color,
      }}
    >
      <Icon style={{ width: Math.round(size * 0.55), height: Math.round(size * 0.55) }} strokeWidth={2} />
    </span>
  );
}

/** A team: a hexagon, the shape that reads as «several» next to the agents' squares. */
export function TeamAvatar({ size = 28, className = "", state = "idle" }: { size?: number; className?: string; state?: AgentState }) {
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center text-[var(--cf-accent)] ${state === "thinking" ? "cf-crew-breathe" : ""} ${className}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 30 30" className="absolute inset-0 h-full w-full" aria-hidden>
        <path
          d="M15 1.8 26.4 8.4v13.2L15 28.2 3.6 21.6V8.4Z"
          fill="color-mix(in oklab, var(--cf-accent) 14%, var(--cf-surface))"
          stroke="color-mix(in oklab, var(--cf-accent) 45%, var(--cf-surface))"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <Users className="relative" style={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }} />
    </span>
  );
}

/** Several agents, overlapped — who is working on a card right now. */
export function AvatarStack({ agents, size = 20, max = 4 }: { agents: { id: string; icon?: string; color?: string }[]; size?: number; max?: number }) {
  const shown = agents.slice(0, max);
  return (
    <span className="inline-flex items-center">
      {shown.map((agent, index) => (
        <span key={agent.id} style={{ marginLeft: index ? -Math.round(size * 0.3) : 0 }} className="rounded-[8px] ring-2 ring-[var(--cf-surface)]">
          <AgentAvatar agent={agent} size={size} />
        </span>
      ))}
      {agents.length > max && <span className="ml-1 text-[11px] text-[var(--cf-text-muted)]">+{agents.length - max}</span>}
    </span>
  );
}
