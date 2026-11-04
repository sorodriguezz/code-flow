/**
 * One way to hand work to agents, for the board, the ⌘K launcher and an agent's card: «who» (an
 * agent or a team) and «how» (alone, a race, the team, a fixed flow, hybrid) become the engines
 * the app already has — tasks, races, chains, hybrid runs and team runs.
 *
 * `planLaunch` is pure (what would be created), `launch` carries it out through the stores. The
 * split is what the tests pin: the plan for each mode, without a backend.
 */
import type { NewChainStep, WorkspaceAgent } from "../../types/domain";
import type { BacklogLinkKind } from "../../types/crew";
import { applyPreset, defaultPolicy, type PolicyPreset, type Team } from "../../types/team";

export type LaunchMode = "solo" | "race" | "team" | "flow" | "hybrid";

export interface LaunchInput {
  goal: string;
  title?: string;
  mode: LaunchMode;
  assignee: { kind: "agent" | "team"; id: string };
  /** Project ids, first one first. Empty means the workspace's first repository. */
  repos: string[];
  /** A race's other runners (agent ids). */
  racers?: string[];
  /** Each task in a worktree of its own — forced in a race. */
  worktree?: boolean;
  /** A team run's target branch for every repository, `""` the one checked out. */
  branch?: string;
  /** Per repository, over `branch`: project id → target branch. */
  branches?: Record<string, string>;
  /** A team run's permission preset, on top of the team's own policy. */
  preset?: PolicyPreset;
  /** A fixed flow: the agents in order (from a chain template or the team's fixed plan). */
  flowSteps?: { agentId: string; instruction: string; gate?: boolean }[];
  agentProjectId?: string;
}

export type LaunchStep =
  | { kind: "task"; projectId: string; agentId: string; worktree: boolean; batch?: string }
  | { kind: "chain"; projectIds: string[]; steps: NewChainStep[] }
  | { kind: "hybrid"; projectIds: string[]; plannerAgentId: string }
  | { kind: "team"; teamId: string; repos: { projectId: string; targetBranch: string }[]; preset?: PolicyPreset };

export class LaunchError extends Error {}

function step(agentId: string, instruction: string, gate = false): NewChainStep {
  return { agent_id: agentId, instruction, gate, project_id: "", phase: "", check_command: "", on_pass: -1, on_fail: -1, review: null };
}

/** What a launch would create. Throws `LaunchError` with a translation key for what is missing. */
export function planLaunch(input: LaunchInput, firstRepo: string | null, newBatch: () => string): LaunchStep[] {
  const repos = input.repos.length ? input.repos : firstRepo ? [firstRepo] : [];
  if (!input.goal.trim()) throw new LaunchError("crew.launch.needGoal");
  if (repos.length === 0) throw new LaunchError("crew.launch.needRepo");
  const { assignee } = input;
  switch (input.mode) {
    case "team": {
      if (assignee.kind !== "team") throw new LaunchError("crew.launch.needTeam");
      return [{ kind: "team", teamId: assignee.id, repos: repos.map((projectId) => ({ projectId, targetBranch: input.branches?.[projectId] ?? input.branch ?? "" })), preset: input.preset }];
    }
    case "race": {
      if (assignee.kind !== "agent") throw new LaunchError("crew.launch.needAgent");
      const racers = [assignee.id, ...(input.racers ?? []).filter((id) => id !== assignee.id)];
      if (racers.length < 2) throw new LaunchError("crew.launch.needRacers");
      const batch = newBatch();
      return racers.map((agentId) => ({ kind: "task", projectId: repos[0], agentId, worktree: true, batch }));
    }
    case "flow": {
      const steps = input.flowSteps?.length
        ? input.flowSteps.map((s) => step(s.agentId, s.instruction, s.gate))
        : assignee.kind === "agent"
          ? [step(assignee.id, input.goal)]
          : [];
      if (steps.length === 0) throw new LaunchError("crew.launch.needFlow");
      return [{ kind: "chain", projectIds: repos, steps }];
    }
    case "hybrid": {
      if (assignee.kind !== "agent") throw new LaunchError("crew.launch.needAgent");
      return [{ kind: "hybrid", projectIds: repos, plannerAgentId: assignee.id }];
    }
    case "solo":
    default: {
      if (assignee.kind === "team") throw new LaunchError("crew.launch.needAgent");
      return repos.map((projectId) => ({ kind: "task", projectId, agentId: assignee.id, worktree: input.worktree ?? true }));
    }
  }
}

/** What carries a plan out — the stores' own actions, injected so the plan can be tested alone. */
export interface LaunchDeps {
  workspaceId: string;
  roster: WorkspaceAgent[];
  teams: Team[];
  createTask: (input: { projectId: string; agent: WorkspaceAgent; goal: string; agentProjectId?: string; worktree?: boolean; batch?: string }) => Promise<{ id: string }>;
  sendTask: (taskId: string, goal: string) => boolean;
  createChain: (input: { projectIds: string[]; title: string; goal: string; steps: NewChainStep[]; agentProjectId: string; start: boolean }) => Promise<{ chain: { id: string } }>;
  createHybrid: (input: { projectIds: string[]; title: string; goal: string; plannerAgentId: string; agentProjectId: string; gate: boolean; start: boolean }) => Promise<{ chain: { id: string } }>;
  startTeam: (input: { teamId: string; goal: string; title?: string; repos: { projectId: string; targetBranch: string }[]; policy?: ReturnType<typeof defaultPolicy> | null; agentProjectId?: string }) => Promise<string | null>;
}

export interface Launched {
  links: { kind: BacklogLinkKind; refId: string }[];
  /** What to open afterwards. */
  open: { kind: "task" | "chain" | "team_run"; id: string } | null;
}

/** Carries out a launch. Tasks are created first and sent afterwards, so a failed create never
 * leaves half a set with turns already running — the same order the old task dialog kept. */
export async function launch(input: LaunchInput, plan: LaunchStep[], deps: LaunchDeps): Promise<Launched> {
  const links: Launched["links"] = [];
  let open: Launched["open"] = null;
  const title = input.title?.trim() || "";
  const created: { id: string }[] = [];
  for (const s of plan) {
    if (s.kind === "task") {
      const agent = deps.roster.find((a) => a.id === s.agentId);
      if (!agent) throw new LaunchError("crew.launch.agentGone");
      const task = await deps.createTask({ projectId: s.projectId, agent, goal: input.goal, agentProjectId: input.agentProjectId, worktree: s.worktree, batch: s.batch });
      created.push(task);
      links.push({ kind: s.batch ? "race" : "task", refId: task.id });
      open ??= { kind: "task", id: task.id };
    } else if (s.kind === "chain") {
      const detail = await deps.createChain({ projectIds: s.projectIds, title, goal: input.goal, steps: s.steps, agentProjectId: input.agentProjectId ?? "", start: true });
      links.push({ kind: "chain", refId: detail.chain.id });
      open ??= { kind: "chain", id: detail.chain.id };
    } else if (s.kind === "hybrid") {
      const detail = await deps.createHybrid({ projectIds: s.projectIds, title, goal: input.goal, plannerAgentId: s.plannerAgentId, agentProjectId: input.agentProjectId ?? "", gate: true, start: true });
      links.push({ kind: "chain", refId: detail.chain.id });
      open ??= { kind: "chain", id: detail.chain.id };
    } else {
      const team = deps.teams.find((t) => t.id === s.teamId);
      const policy = team && s.preset ? applyPreset(team.policy, s.preset) : null;
      const runId = await deps.startTeam({ teamId: s.teamId, goal: input.goal, title: title || undefined, repos: s.repos, policy, agentProjectId: input.agentProjectId });
      if (runId) {
        links.push({ kind: "team_run", refId: runId });
        open ??= { kind: "team_run", id: runId };
      }
    }
  }
  for (const task of created) deps.sendTask(task.id, input.goal);
  return { links, open };
}
