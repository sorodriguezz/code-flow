import type { AgentDraft, Project, WorkspaceAgent } from "../../types/domain";
import { defaultPolicy, emptyMember, type Team, type TeamMember } from "../../types/team";

export const CONFIGURATION_FORMAT = "codeflow-crew";
export const CONFIGURATION_VERSION = 1;
export const AGENT_CONFIGURATION = "agent";
export const TEAM_CONFIGURATION = "team";
export const EMPTY_TEXT = "";
export const ZERO = 0;
export const ONE = 1;
export const MAX_CONFIGURATION_BYTES = 5_242_880;
const MAX_ENTRIES = 2_048;
const MAX_MEMBERS = 16;
const MAX_PARALLEL = 8;
const OBJECT_TYPE = "object";
const NUMBER_TYPE = "number";
const ALL_REPOSITORIES = "*";
const HEADLESS_MODE = "headless";
const TERMINAL_MODE = "terminal";
const CONFLICT_AUTHOR = "author";
const CONFLICT_USER = "user";
const COPY_NUMBER_START = 2;
const CHECK_WHEN = ["item", "final", "agent"];
const CHECK_KINDS = ["unit", "integration", "e2e", "lint", "other"];
const STEP_KINDS = ["work", "investigate"];
const POLICY_CHOICES: Record<string, string[]> = {
  approve_code: ["never", "first", "each"],
  questions: ["allow", "plan", "never"],
  commit: ["item", "squash", "none"],
  commit_style: ["conventional", "free"],
  integrate: ["merge", "branch", "pr"],
  comms: ["open", "tree", "tree_siblings"],
  baseline_failures: ["ignore", "fix"],
  dod: ["off", "warn", "block"],
  sandbox: ["off", "checks"],
  guarantees: ["off", "warn", "block"],
  permissions: ["restricted", "full"],
};
const REVIEW_EXIGENCE = ["correct", "polished"];
const DECIMAL_POLICY_FIELDS = new Set(["budget_usd", "budget_minutes", "unmetered_minutes"]);
const TEAM_MEMBERS_PROPERTY = "members";

export const CONFIGURATION_ERRORS = {
  invalid: "crew-share-invalid",
  version: "crew-share-version",
  reference: "crew-share-reference",
  repository: "crew-share-repository",
  size: "crew-share-size",
} as const;

type SharedAgent = Omit<AgentDraft, "id" | "workspace_id" | "account_id" | "template_id" | "template_version" | "overrides">;
type SharedTeam = Pick<Team, "name" | "description" | "lead" | "policy" | "members" | "plan">;
export type SharingProject = Pick<Project, "id" | "name">;
export interface ConfigurationFile {
  format: typeof CONFIGURATION_FORMAT;
  version: number;
  kind: typeof AGENT_CONFIGURATION | typeof TEAM_CONFIGURATION;
  repositories: { key: string; name: string }[];
  agents: { key: string; configuration: SharedAgent }[];
  team: SharedTeam | null;
}
export interface ConfigurationImport {
  agents: { key: string; draft: AgentDraft }[];
  team: Team | null;
}

const AGENT_SHAPE: SharedAgent = {
  name: EMPTY_TEXT, role: EMPTY_TEXT, provider: EMPTY_TEXT, model: EMPTY_TEXT,
  prompt: EMPTY_TEXT, enabled: true, effort: EMPTY_TEXT, icon: EMPTY_TEXT,
  color: EMPTY_TEXT, edits: true, repos: [EMPTY_TEXT], run_in: HEADLESS_MODE,
  max_parallel: ONE, model_ladder: [EMPTY_TEXT], perms: [EMPTY_TEXT],
};
const memberDefaults = emptyMember();
const MEMBER_SHAPE = { ...memberDefaults, repos: [EMPTY_TEXT], talks_to: [EMPTY_TEXT], model_ladder: [EMPTY_TEXT] };
const policyDefaults = defaultPolicy();
const POLICY_SHAPE = {
  ...policyDefaults,
  checks: [{ repo: EMPTY_TEXT, command: EMPTY_TEXT, when: CHECK_WHEN[ZERO], kind: "other", label: EMPTY_TEXT, write: false }],
  impact_paths: [EMPTY_TEXT],
  review: { ...policyDefaults.review, of: [EMPTY_TEXT] },
};
const TEAM_SHAPE = {
  name: EMPTY_TEXT, description: EMPTY_TEXT, lead: EMPTY_TEXT, policy: POLICY_SHAPE,
  members: [MEMBER_SHAPE],
  plan: [{ key: EMPTY_TEXT, member: EMPTY_TEXT, repo: EMPTY_TEXT, kind: STEP_KINDS[ZERO], title: EMPTY_TEXT, instruction: EMPTY_TEXT, depends_on: [EMPTY_TEXT] }],
};
const FILE_SHAPE = {
  format: CONFIGURATION_FORMAT, version: CONFIGURATION_VERSION, kind: AGENT_CONFIGURATION,
  repositories: [{ key: EMPTY_TEXT, name: EMPTY_TEXT }],
  agents: [{ key: EMPTY_TEXT, configuration: AGENT_SHAPE }],
};

/** The error's message is the key `ConfigurationSharing` translates; `subject` is what it names. */
export class ConfigurationError extends Error {
  constructor(key: string, readonly subject: string | null = null) {
    super(key);
  }
}

function fail(error: string = CONFIGURATION_ERRORS.invalid, subject: string | null = null): never {
  throw new ConfigurationError(error, subject);
}

function record(value: unknown): Record<string, unknown> {
  const isArray = Array.isArray(value);
  if (value === null || typeof value !== OBJECT_TYPE || isArray) fail();
  return value as Record<string, unknown>;
}

function readShape(value: unknown, shape: unknown): unknown {
  const arrayShape = Array.isArray(shape);
  if (arrayShape) {
    const validArray = Array.isArray(value);
    if (!validArray || value.length > MAX_ENTRIES) fail();
    return value.map((entry) => readShape(entry, shape[ZERO]));
  }
  if (typeof shape === OBJECT_TYPE && shape !== null) {
    const source = record(value);
    const shapeRecord = record(shape);
    const fields = Object.entries(shapeRecord);
    const result: Record<string, unknown> = {};
    for (const [key, fieldShape] of fields) result[key] = readShape(source[key], fieldShape);
    return result;
  }
  if (typeof value !== typeof shape) fail();
  if (typeof value === NUMBER_TYPE) {
    const numeric = value as number;
    const finite = Number.isFinite(numeric);
    if (!finite || numeric < ZERO) fail();
  }
  return value;
}

/** A team policy with the settings added after the file was exported filled in with their
 *  defaults (`single_pass`, `pr_draft`, a check's `kind`), so an older file still imports and gets
 *  them as a new team would. A setting the file has, of the wrong type, still fails. */
function withPolicyDefaults(team: unknown): unknown {
  const source = record(team);
  const policy = source.policy;
  if (typeof policy !== OBJECT_TYPE || policy === null || Array.isArray(policy)) return team;
  const filled: Record<string, unknown> = { ...policyDefaults, ...(policy as Record<string, unknown>) };
  if (Array.isArray(filled.checks)) {
    filled.checks = filled.checks.map((check) => (typeof check === OBJECT_TYPE && check !== null ? { kind: "other", label: EMPTY_TEXT, write: false, ...(check as Record<string, unknown>) } : check));
  }
  return { ...source, policy: filled };
}

function requireText(text: string): void {
  const trimmed = text.trim();
  if (trimmed === EMPTY_TEXT) fail();
}

function uniqueKeys(keys: string[]): Set<string> {
  const unique = new Set(keys);
  if (unique.size !== keys.length) fail();
  for (const key of keys) requireText(key);
  return unique;
}

function requireReference(key: string, keys: Set<string>, exceptions: string[] = []): void {
  const known = keys.has(key);
  const exception = exceptions.includes(key);
  if (!known && !exception) fail(CONFIGURATION_ERRORS.reference);
}

function requireChoice(value: string, choices: readonly string[]): void {
  const valid = choices.includes(value);
  if (!valid) fail();
}

function requireParallel(value: number): void {
  const integer = Number.isInteger(value);
  if (!integer || value < ONE || value > MAX_PARALLEL) fail();
}

function validateTeam(team: SharedTeam, agentKeys: Set<string>, repositoryKeys: Set<string>): void {
  requireText(team.name);
  if (team.members.length > MAX_MEMBERS) fail();
  const memberIds = team.members.map((member) => member.id);
  const memberKeys = uniqueKeys(memberIds);
  const stepIds = team.plan.map((step) => step.key);
  const stepKeys = uniqueKeys(stepIds);
  requireReference(team.lead, memberKeys, [EMPTY_TEXT]);
  const reportingEntries = team.members.map((member): [string, string] => [member.id, member.reports_to || team.lead]);
  const reporting = new Map(reportingEntries);
  for (const member of team.members) {
    requireReference(member.agent_id, agentKeys);
    requireReference(member.reports_to, memberKeys, [EMPTY_TEXT]);
    requireReference(member.escalate_to, memberKeys, [EMPTY_TEXT]);
    requireChoice(member.run_in, [HEADLESS_MODE, TERMINAL_MODE]);
    requireParallel(member.max_parallel);
    for (const target of member.talks_to) requireReference(target, memberKeys);
    for (const repo of member.repos) requireReference(repo, repositoryKeys);
    const ancestors = new Set<string>([member.id]);
    let parent = member.id === team.lead ? EMPTY_TEXT : reporting.get(member.id);
    while (parent) {
      const repeated = ancestors.has(parent);
      if (repeated) fail(CONFIGURATION_ERRORS.reference);
      ancestors.add(parent);
      parent = parent === team.lead ? EMPTY_TEXT : reporting.get(parent);
    }
  }
  for (const step of team.plan) {
    requireReference(step.member, memberKeys);
    requireReference(step.repo, repositoryKeys, [EMPTY_TEXT, ALL_REPOSITORIES]);
    requireChoice(step.kind, STEP_KINDS);
    requireText(step.instruction);
    for (const dependency of step.depends_on) requireReference(dependency, stepKeys);
  }
  const resolvedSteps = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const step of team.plan) {
      const resolved = resolvedSteps.has(step.key);
      const ready = step.depends_on.every((dependency) => resolvedSteps.has(dependency));
      if (!resolved && ready) {
        resolvedSteps.add(step.key);
        progressed = true;
      }
    }
  }
  if (resolvedSteps.size !== team.plan.length) fail(CONFIGURATION_ERRORS.reference);
  const policyEntries = Object.entries(team.policy);
  for (const [field, value] of policyEntries) {
    const choices = POLICY_CHOICES[field];
    if (choices) requireChoice(value as string, choices);
    const decimalAllowed = DECIMAL_POLICY_FIELDS.has(field);
    if (typeof value === NUMBER_TYPE && !decimalAllowed) {
      const integer = Number.isInteger(value);
      if (!integer) fail();
    }
  }
  requireReference(team.policy.conflicts, memberKeys, [CONFLICT_AUTHOR, CONFLICT_USER]);
  requireReference(team.policy.review.reviewer, memberKeys, [EMPTY_TEXT]);
  requireChoice(team.policy.review.exigence, REVIEW_EXIGENCE);
  for (const member of team.policy.review.of) requireReference(member, memberKeys);
  for (const check of team.policy.checks) {
    requireReference(check.repo, repositoryKeys, [ALL_REPOSITORIES]);
    requireChoice(check.when, CHECK_WHEN);
    requireChoice(check.kind ?? "other", CHECK_KINDS);
    requireText(check.command);
  }
}

export function parseConfiguration(text: string): ConfigurationFile {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_CONFIGURATION_BYTES) fail(CONFIGURATION_ERRORS.size);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail(); }
  const source = record(parsed);
  if (source.format !== CONFIGURATION_FORMAT) fail();
  if (source.version !== CONFIGURATION_VERSION) fail(CONFIGURATION_ERRORS.version);
  const base = readShape(source, FILE_SHAPE) as Omit<ConfigurationFile, "team">;
  requireChoice(base.kind, [AGENT_CONFIGURATION, TEAM_CONFIGURATION]);
  const team = source.team === null ? null : readShape(withPolicyDefaults(source.team), TEAM_SHAPE) as SharedTeam;
  const file: ConfigurationFile = { ...base, team };
  const agentIds = file.agents.map((agent) => agent.key);
  const agentKeys = uniqueKeys(agentIds);
  const repositoryIds = file.repositories.map((repo) => repo.key);
  const repositoryKeys = uniqueKeys(repositoryIds);
  for (const repository of file.repositories) requireText(repository.name);
  for (const { configuration } of file.agents) {
    requireText(configuration.name);
    requireChoice(configuration.run_in, [HEADLESS_MODE, TERMINAL_MODE]);
    requireParallel(configuration.max_parallel);
    for (const repo of configuration.repos) requireReference(repo, repositoryKeys);
  }
  if (file.kind === AGENT_CONFIGURATION && (team !== null || file.agents.length !== ONE)) fail();
  if (file.kind === TEAM_CONFIGURATION && team === null) fail();
  if (team) validateTeam(team, agentKeys, repositoryKeys);
  return file;
}

function sharedAgent(agent: WorkspaceAgent): SharedAgent {
  return {
    name: agent.name, role: agent.role, provider: agent.provider, model: agent.model,
    prompt: agent.prompt, enabled: agent.enabled, effort: agent.effort ?? EMPTY_TEXT,
    icon: agent.icon ?? EMPTY_TEXT, color: agent.color ?? EMPTY_TEXT, edits: agent.edits ?? true,
    repos: agent.repos ?? [], run_in: agent.run_in ?? HEADLESS_MODE,
    max_parallel: agent.max_parallel ?? ONE, model_ladder: agent.model_ladder ?? [], perms: agent.perms ?? [],
  };
}

export function configurationForExport(source: WorkspaceAgent | Team, roster: WorkspaceAgent[], projects: SharingProject[]): ConfigurationFile {
  const isTeam = TEAM_MEMBERS_PROPERTY in source;
  const sourceAgentIds = isTeam ? source.members.map((member) => member.agent_id) : [source.id];
  const agentKeys = new Set(sourceAgentIds);
  const sourceAgents = isTeam ? roster.filter((agent) => agentKeys.has(agent.id)) : [source];
  if (sourceAgents.length !== agentKeys.size) fail(CONFIGURATION_ERRORS.reference);
  // Removing a repository from the workspace, or moving it to another one, leaves its id behind in
  // every agent, member, step and check that named it. Those are dropped here rather than refusing
  // the export: they point at nothing, so they never travel anyway. A member whose every repository
  // left travels with none assigned (user, 2026-11-16: refusing the whole export over it was worse
  // than having to assign them again after importing).
  const known = new Set(projects.map((project) => project.id));
  const present = (repos: string[]): string[] => repos.filter((repo) => known.has(repo));
  const scoped = (repo: string) => repo === EMPTY_TEXT || repo === ALL_REPOSITORIES || known.has(repo);
  const agents = sourceAgents.map((agent) => {
    const configuration = sharedAgent(agent);
    return { key: agent.id, configuration: { ...configuration, repos: present(configuration.repos) } };
  });
  const agentRepositories = agents.flatMap((agent) => agent.configuration.repos);
  const repositories = new Set(agentRepositories);
  let team: SharedTeam | null = null;
  if (isTeam) {
    const members = source.members.map((member) => ({ ...member, repos: present(member.repos) }));
    const plan = source.plan.map((step) => (scoped(step.repo) ? step : { ...step, repo: EMPTY_TEXT }));
    // «Completo» is chosen where a team runs, never handed over in a file (the import resets it too).
    const basePolicy = { ...defaultPolicy(), ...source.policy, permissions: "restricted" as const };
    const policy = { ...basePolicy, checks: basePolicy.checks.filter((check) => scoped(check.repo)) };
    team = { name: source.name, description: source.description, lead: source.lead, members, plan, policy };
    for (const member of members) for (const repo of member.repos) repositories.add(repo);
    const scopes = [...plan.map((step) => step.repo), ...policy.checks.map((check) => check.repo)];
    for (const scope of scopes) {
      if (scope !== EMPTY_TEXT && scope !== ALL_REPOSITORIES) repositories.add(scope);
    }
  }
  const portableRepositories = Array.from(repositories).map((key) => {
    const project = projects.find((candidate) => candidate.id === key);
    if (!project) fail(CONFIGURATION_ERRORS.repository);
    return { key, name: project.name };
  });
  const file = { format: CONFIGURATION_FORMAT, version: CONFIGURATION_VERSION, kind: isTeam ? TEAM_CONFIGURATION : AGENT_CONFIGURATION, repositories: portableRepositories, agents, team };
  const serialized = JSON.stringify(file);
  return parseConfiguration(serialized);
}

function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  let suffix = COPY_NUMBER_START;
  let normalized = candidate.toLocaleLowerCase();
  let exists = taken.has(normalized);
  while (exists) {
    candidate = `${name} (${suffix})`;
    suffix += ONE;
    normalized = candidate.toLocaleLowerCase();
    exists = taken.has(normalized);
  }
  taken.add(normalized);
  return candidate;
}

export function prepareConfigurationImport(file: ConfigurationFile, workspaceId: string, repositoryMapping: Record<string, string>, projects: SharingProject[], agentNames: string[], teamNames: string[]): ConfigurationImport {
  const projectIds = projects.map((project) => project.id);
  const targetRepositories = new Set(projectIds);
  const mapRepository = (key: string): string => {
    const mapped = repositoryMapping[key];
    const exists = targetRepositories.has(mapped);
    if (!mapped || !exists) fail(CONFIGURATION_ERRORS.repository);
    return mapped;
  };
  for (const repository of file.repositories) mapRepository(repository.key);
  const normalizedAgentNames = agentNames.map((name) => name.toLocaleLowerCase());
  const takenAgentNames = new Set(normalizedAgentNames);
  const agents = file.agents.map(({ key, configuration }) => {
    const name = uniqueName(configuration.name, takenAgentNames);
    const repos = configuration.repos.map(mapRepository);
    const draft: AgentDraft = { ...configuration, name, repos, id: null, workspace_id: workspaceId, account_id: null, template_id: EMPTY_TEXT, template_version: ZERO, overrides: [] };
    return { key, draft };
  });
  if (!file.team) return { agents, team: null };
  const source = file.team;
  const memberEntries = source.members.map((member): [string, string] => {
    const id = crypto.randomUUID();
    return [member.id, id];
  });
  const memberKeys = new Map(memberEntries);
  const mapMember = (id: string) => memberKeys.get(id) ?? id;
  const mapScope = (key: string) => key === EMPTY_TEXT || key === ALL_REPOSITORIES ? key : mapRepository(key);
  const members: TeamMember[] = source.members.map((member) => ({ ...member, id: mapMember(member.id), repos: member.repos.map(mapRepository), reports_to: mapMember(member.reports_to), escalate_to: mapMember(member.escalate_to), talks_to: member.talks_to.map(mapMember) }));
  const plan = source.plan.map((step) => ({ ...step, member: mapMember(step.member), repo: mapScope(step.repo) }));
  const checks = source.policy.checks.map((check) => ({ ...check, repo: mapScope(check.repo) }));
  const review = { ...source.policy.review, reviewer: mapMember(source.policy.review.reviewer), of: source.policy.review.of.map(mapMember) };
  const policy = { ...source.policy, conflicts: mapMember(source.policy.conflicts), checks, review };
  const normalizedTeamNames = teamNames.map((name) => name.toLocaleLowerCase());
  const takenTeamNames = new Set(normalizedTeamNames);
  const name = uniqueName(source.name, takenTeamNames);
  const lead = mapMember(source.lead);
  const team: Team = { ...source, name, lead, members, plan, policy, id: EMPTY_TEXT, workspace_id: workspaceId, created_at: EMPTY_TEXT, updated_at: EMPTY_TEXT };
  return { agents, team };
}
