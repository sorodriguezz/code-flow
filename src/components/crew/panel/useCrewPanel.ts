/**
 * The workspace's teams, for the assistant's panel: read once when the panel asks for them, exactly
 * as the Agents view reads them when it opens — the same store, so whichever of the two is opened
 * second finds them already there.
 *
 * Teams only: the panel talks to teams, and the agents are the Agents view's (the user,
 * 2026-11-25: «solo quiero que existan equipos»). So the roster is not read from here either.
 *
 * Stores only: the panel's Inbox imports this to count the teams, and must not pay for the chat.
 */
import { useEffect } from "react";
import { useTeamStore } from "../../../state/teamStore";
import { NO_WORKSPACE } from "../../../state/aiPanelStore";
import type { Team } from "../../../types/team";

const NO_TEAMS: Team[] = [];

export interface CrewOfPanel {
  teams: Team[];
  /** Still being read for the first time: nothing to say yet about what there is. */
  loading: boolean;
}

export function useCrewPanel(workspaceId: string): CrewOfPanel {
  const real = workspaceId && workspaceId !== NO_WORKSPACE ? workspaceId : null;
  useEffect(() => {
    if (!real) return;
    // `load` reads again every time it is called: only when this workspace's are not the ones held.
    if (useTeamStore.getState().workspaceId !== real) void useTeamStore.getState().load(real);
  }, [real]);
  const teams = useTeamStore((s) => (real && s.workspaceId === real ? s.teams : NO_TEAMS));
  const loading = useTeamStore((s) => !!real && (s.workspaceId !== real || (s.loading && s.teams.length === 0)));
  return { teams, loading };
}
