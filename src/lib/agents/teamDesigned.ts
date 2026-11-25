/**
 * A team a chat made with the `team_create` tool (`team::designer`): what the window says about
 * it, and where it takes the user. The backend announces it as `crew:team-designed`.
 */
import type { Team } from "../../types/team";

export const TEAM_DESIGNED_EVENT = "crew:team-designed";

export interface TeamDesigned {
  team: Team;
  /** An existing team's definition was replaced, rather than a team added. */
  updated: boolean;
  /** How many roster agents were made for it. */
  newAgents: number;
}

/** The toast's line: what happened, and what it cost the roster. */
export function teamDesignedMessage({ team, updated, newAgents }: TeamDesigned, spanish: boolean): string {
  const seats = team.members.length;
  if (spanish) {
    const what = updated ? `El chat actualizó el equipo «${team.name}»` : `El chat creó el equipo «${team.name}»`;
    const size = `${seats} ${seats === 1 ? "puesto" : "puestos"}`;
    const made = newAgents === 0 ? "con agentes que ya tenías" : newAgents === 1 ? "1 agente nuevo" : `${newAgents} agentes nuevos`;
    return `${what}: ${size}, ${made}.`;
  }
  const what = updated ? `The chat updated the team «${team.name}»` : `The chat created the team «${team.name}»`;
  const size = `${seats} ${seats === 1 ? "seat" : "seats"}`;
  const made = newAgents === 0 ? "with agents you already had" : newAgents === 1 ? "1 new agent" : `${newAgents} new agents`;
  return `${what}: ${size}, ${made}.`;
}

export const TEAM_PROPOSED_EVENT = "crew:team-proposed";

/** What the backend says when a chat that could not create a team left one to be accepted. */
export interface TeamProposed {
  id: string;
  workspaceId: string;
  name: string;
  seats: number;
  newAgents: number;
  updating: boolean;
}

export function teamProposedMessage({ name, seats, newAgents, updating }: TeamProposed, spanish: boolean): string {
  if (spanish) {
    const what = updating ? `El chat propone cambiar el equipo «${name}»` : `El chat propone el equipo «${name}»`;
    const made = newAgents === 0 ? "con agentes que ya tienes" : newAgents === 1 ? "1 agente nuevo" : `${newAgents} agentes nuevos`;
    return `${what}: ${seats} ${seats === 1 ? "puesto" : "puestos"}, ${made}. Tú decides si se crea.`;
  }
  const what = updating ? `The chat proposes changing the team «${name}»` : `The chat proposes the team «${name}»`;
  const made = newAgents === 0 ? "with agents you already have" : newAgents === 1 ? "1 new agent" : `${newAgents} new agents`;
  return `${what}: ${seats} ${seats === 1 ? "seat" : "seats"}, ${made}. You decide whether it is created.`;
}

/** Opens a proposal's review in Agentes › Equipos. */
export async function openTeamProposal(workspaceId: string, id: string): Promise<void> {
  const [{ followTarget }, { useCrewStore }, { useTeamStore }] = await Promise.all([
    import("../../state/notificationStore"),
    import("../../components/crew/crewStore"),
    import("../../state/teamStore"),
  ]);
  await followTarget(workspaceId, { view: "agents" });
  await useTeamStore.getState().loadProposals(workspaceId);
  useCrewStore.getState().setSpace("equipos");
  useCrewStore.getState().set({ selectedTeamId: null, selectedMemberId: null });
  useCrewStore.getState().open({ kind: "teamProposal", id });
}

/** Opens the team in Agentes › Equipos — in its own workspace, when the user has moved to another
 * since. Loaded on demand: the stores it touches import this one's. */
export async function openDesignedTeam(team: Team): Promise<void> {
  const [{ followTarget }, { useCrewStore }, { useTeamStore }] = await Promise.all([
    import("../../state/notificationStore"),
    import("../../components/crew/crewStore"),
    import("../../state/teamStore"),
  ]);
  await followTarget(team.workspace_id, { view: "agents" });
  // The list may not have been loaded yet in this window: the editor needs the team in it.
  if (!useTeamStore.getState().teams.some((known) => known.id === team.id)) await useTeamStore.getState().load(team.workspace_id);
  useCrewStore.getState().setSpace("equipos");
  useCrewStore.getState().set({ selectedTeamId: team.id, selectedMemberId: null, overlay: null });
}
