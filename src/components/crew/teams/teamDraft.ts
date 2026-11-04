/**
 * Editing a team: a local draft that saves itself a moment after the last change, so dragging
 * three members around is one save, and a refusal from the backend (a cycle, a tree too deep)
 * puts the stored team back.
 */
import { useEffect, useRef, useState } from "react";
import { useTeamStore } from "../../../state/teamStore";
import { useAgentsStore } from "../../../state/agentsStore";
import { useLibraryStore } from "../../../state/libraryStore";
import { draftFromTemplate, type AgentTemplateBody } from "../../../lib/agents/builtinTemplates";
import { emptyMember, type Team, type TeamMember } from "../../../types/team";
import type { WorkspaceAgent } from "../../../types/domain";
import { lNow } from "../state";

export function useTeamDraft(teamId: string | null) {
  const stored = useTeamStore((s) => (teamId ? s.teams.find((t) => t.id === teamId) ?? null : null));
  const [draft, setDraft] = useState<Team | null>(stored);
  const pending = useRef<Team | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!pending.current) setDraft(stored);
  }, [stored]);

  const flush = async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    if (!next) return;
    const saved = await useTeamStore.getState().saveTeam(next);
    if (pending.current === next) pending.current = null;
    if (!saved && !pending.current) setDraft(useTeamStore.getState().teams.find((t) => t.id === next.id) ?? null);
  };

  useEffect(
    () => () => {
      void flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teamId],
  );

  const update = (fn: (team: Team) => Team, now = false) => {
    setDraft((current) => {
      if (!current) return current;
      const next = fn(current);
      pending.current = next;
      return next;
    });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), now ? 0 : 500);
  };

  return { team: draft, update, flush };
}

/** A roster agent as a member: its own scope copied, so the team can narrow it without touching
 * the agent. Icon and colour stay the agent's unless the team changes them. */
export function memberFromAgent(agent: WorkspaceAgent, reportsTo: string): TeamMember {
  return {
    ...emptyMember(),
    agent_id: agent.id,
    name: agent.name,
    role: agent.role,
    edits: agent.edits ?? true,
    run_in: agent.run_in ?? "headless",
    max_parallel: agent.max_parallel ?? 1,
    repos: agent.repos ?? [],
    model_ladder: agent.model_ladder ?? [],
    reports_to: reportsTo,
  };
}

/** The roster agent made from a library template, created now. */
export async function agentFromTemplate(templateId: string, workspaceId: string): Promise<{ agent: WorkspaceAgent; advisor: boolean } | null> {
  const template = useLibraryStore.getState().all().find((t) => t.id === templateId && t.kind === "agent");
  if (!template) return null;
  const roster = useAgentsStore.getState().roster;
  const agent = await useAgentsStore.getState().saveAgent(draftFromTemplate(template, workspaceId, roster.map((a) => a.name)));
  return { agent, advisor: Boolean((template.body as AgentTemplateBody).advisor) };
}

/** A new member for `agent` under `reportsTo` (`""` the lead). An advisor never reports to anyone
 * and never edits. */
export function buildMember(agent: WorkspaceAgent, reportsTo: string, advisor = false): TeamMember {
  const member = memberFromAgent(agent, advisor ? "" : reportsTo);
  if (advisor) {
    member.advisor = true;
    member.edits = false;
    member.role = member.role || lNow("Asesor", "Advisor");
  }
  return member;
}

/** The team with `member` in it. The first member of an empty team without a fixed plan becomes
 * its lead; reporting to the lead is stored as `""`. */
export function insertMember(team: Team, member: TeamMember): Team {
  const next = { ...member, reports_to: member.reports_to === team.lead ? "" : member.reports_to };
  const becomesLead = !next.advisor && team.members.length === 0 && !team.lead && team.plan.length === 0;
  return { ...team, members: [...team.members, next], lead: becomesLead ? next.id : team.lead };
}
