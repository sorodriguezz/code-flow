/**
 * The Agents view's own UI state, and the selectors every space shares: who is working right now,
 * on what, and how the board's cards relate to the work started from them.
 */
import { useLanguageStore } from "../../state/languageStore";
import { useAgentsStore } from "../../state/agentsStore";
import { useTeamStore } from "../../state/teamStore";
import type { AgentState } from "./kit/Avatar";
import type { TeamRunState } from "../../types/team";

export { useCrewStore, type Overlay, type Space } from "./crewStore";

/** Spanish and English side by side, picked by the reader's language. The view's strings live
 * next to where they are used, like the built-in templates' prompts. */
export function useL() {
  const lang = useLanguageStore((s) => s.language);
  return (es: string, en: string) => (lang === "es" ? es : en);
}

export function lNow(es: string, en: string): string {
  return useLanguageStore.getState().language === "es" ? es : en;
}

/** What an agent is doing across the workspace: a turn in flight on one of its tasks or team
 * items, a question waiting on you, or nothing. */
export function useAgentStates(): Map<string, AgentState> {
  const tasks = useAgentsStore((s) => s.tasks);
  const live = useAgentsStore((s) => s.live);
  const states = useTeamStore((s) => s.states);
  const map = new Map<string, AgentState>();
  for (const task of tasks) {
    if (!task.agent_id) continue;
    if (live[task.id]?.sending || task.status === "running") map.set(task.agent_id, "thinking");
  }
  for (const state of Object.values(states)) {
    if (!state || !["running", "gated", "paused"].includes(state.run.status)) continue;
    for (const item of state.items) {
      const member = state.run.members.find((m) => m.id === item.member_id);
      if (!member) continue;
      if (item.status === "running") map.set(member.agent_id, "thinking");
      else if (item.status === "waiting" && map.get(member.agent_id) !== "thinking") map.set(member.agent_id, "waiting");
    }
  }
  return map;
}

/** The members of a run working or waiting right now, as roster agent ids. */
export function activeAgents(state: TeamRunState | undefined): string[] {
  if (!state) return [];
  const ids = new Set<string>();
  for (const item of state.items) {
    if (item.status !== "running" && item.status !== "waiting") continue;
    const member = state.run.members.find((m) => m.id === item.member_id);
    if (member) ids.add(member.agent_id);
  }
  return [...ids];
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(n);
}
