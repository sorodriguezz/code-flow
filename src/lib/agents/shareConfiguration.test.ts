import { describe, expect, it } from "vitest";
import type { WorkspaceAgent } from "../../types/domain";
import { emptyMember, emptyTeam, type Team } from "../../types/team";
import { CONFIGURATION_ERRORS, CONFIGURATION_VERSION, EMPTY_TEXT, ONE, ZERO, configurationForExport, parseConfiguration, prepareConfigurationImport, type ConfigurationFile } from "./shareConfiguration";

const SUITE = "shared agent and team configurations";
const WORKSPACE = "source-workspace";
const TARGET_WORKSPACE = "target-workspace";
const AGENT_ID = "source-agent";
const SECOND_AGENT_ID = "second-agent";
const AGENT_NAME = "Arquitecto";
const TEAM_NAME = "Equipo de desarrollo";
const PROVIDER = "claude";
const MODEL = "claude-sonnet";
const PROMPT = "Revisa la arquitectura antes de editar.";
const ACCOUNT = "private-account";
const TEMPLATE = "builtin:architect";
const REPOSITORY = "source-repository";
const TARGET_REPOSITORY = "destination-repository";
const REPOSITORY_NAME = "Backend";
const MEMBER_ID = "lead-member";
const SECOND_MEMBER_ID = "developer-member";
const STEP_KEY = "implement";
const CHECK_COMMAND = "pnpm test";
const STEP_INSTRUCTION = "Implementa los cambios del plan.";
const ALL_REPOSITORIES = "*";
const AUTHOR = "author";
const TERMINAL = "terminal";
const PERMISSIONS = ["cmds", "commit"];
const FIRST_CHECK = "final";
const STEP_KIND = "work";
const PRIVATE_FIELD = "account_id";
const INVALID_FILE = "{broken";
const UNKNOWN_FORMAT = "another-format";
const INVALID_MEMBER = "missing-member";
const INVALID_REPOSITORY = "missing-repository";
const PROPERTIES_TO_REJECT = ["enabled", "prompt", "max_parallel", "repos"];
const NAME_WITH_SUFFIX = `${AGENT_NAME} (2)`;
const NEXT_NAME = `${AGENT_NAME} (3)`;
const TESTS = {
  portable: "exports agent settings without workspace, account or template bindings",
  team: "exports a complete team and deduplicates shared agents",
  roundTrip: "round trips the complete configuration",
  imports: "creates independent agents and remaps repository restrictions",
  hierarchy: "remaps hierarchy, review, communication and plan references together",
  names: "chooses unique names without replacing existing configurations",
  mapping: "rejects missing repository mappings instead of widening permissions",
  foreign: "rejects mappings outside the destination workspace",
  invalid: "rejects invalid JSON and unrelated files",
  version: "rejects unsupported versions",
  shape: "rejects missing and mistyped settings",
  unknown: "strips unrecognized fields from imported settings",
  reference: "rejects missing agents, members and repositories",
  cycles: "rejects reporting and plan cycles",
  duplicates: "rejects duplicate keys",
  empty: "exports and imports an empty team",
  mutated: "does not mutate the source configuration during import",
  reserved: "preserves special repository selectors and conflict roles",
  unavailable: "refuses export when a team agent or repository no longer exists",
  enums: "rejects unsupported modes and invalid numeric settings",
} as const;

const projects = [{ id: REPOSITORY, name: REPOSITORY_NAME }];
const targetProjects = [{ id: TARGET_REPOSITORY, name: REPOSITORY_NAME }];
const mapping = { [REPOSITORY]: TARGET_REPOSITORY };

function agent(id = AGENT_ID): WorkspaceAgent {
  return {
    id, workspace_id: WORKSPACE, name: AGENT_NAME, role: PROMPT, provider: PROVIDER,
    model: MODEL, prompt: PROMPT, enabled: true, sort_order: ZERO, created_at: EMPTY_TEXT,
    account_id: ACCOUNT, template_id: TEMPLATE, template_version: ONE, overrides: [],
    edits: false, repos: [REPOSITORY], run_in: TERMINAL, max_parallel: ONE,
    model_ladder: [MODEL], perms: PERMISSIONS,
  };
}

function team(): Team {
  const lead = { ...emptyMember(), id: MEMBER_ID, agent_id: AGENT_ID, name: AGENT_NAME, repos: [REPOSITORY], talks_to: [SECOND_MEMBER_ID] };
  const developer = { ...emptyMember(), id: SECOND_MEMBER_ID, agent_id: AGENT_ID, name: AGENT_NAME, reports_to: MEMBER_ID, escalate_to: MEMBER_ID, talks_to: [MEMBER_ID], repos: [REPOSITORY] };
  const source = emptyTeam(WORKSPACE);
  const review = { ...source.policy.review, enabled: true, reviewer: MEMBER_ID, of: [SECOND_MEMBER_ID] };
  return {
    ...source, name: TEAM_NAME, lead: MEMBER_ID, members: [lead, developer],
    plan: [{ key: STEP_KEY, member: SECOND_MEMBER_ID, repo: REPOSITORY, kind: STEP_KIND, title: STEP_KEY, instruction: STEP_INSTRUCTION, depends_on: [] }],
    policy: { ...source.policy, conflicts: SECOND_MEMBER_ID, review, checks: [{ repo: REPOSITORY, command: CHECK_COMMAND, when: FIRST_CHECK }] },
  };
}

function exportedTeam(): ConfigurationFile {
  const source = team();
  const roster = [agent()];
  return configurationForExport(source, roster, projects);
}

function parseAttempt(file: unknown) {
  const text = JSON.stringify(file);
  return () => parseConfiguration(text);
}

describe(SUITE, () => {
  it(TESTS.portable, () => {
    const source = agent();
    const file = configurationForExport(source, [source], projects);
    const configuration = file.agents[ZERO].configuration;
    expect(configuration).toMatchObject({ name: AGENT_NAME, provider: PROVIDER, model: MODEL, prompt: PROMPT, edits: false, run_in: TERMINAL, perms: PERMISSIONS });
    expect(configuration).not.toHaveProperty(PRIVATE_FIELD);
    const serialized = JSON.stringify(file);
    expect(serialized).not.toContain(ACCOUNT);
    expect(serialized).not.toContain(WORKSPACE);
    expect(serialized).not.toContain(TEMPLATE);
    expect(file.repositories).toEqual([{ key: REPOSITORY, name: REPOSITORY_NAME }]);
  });

  it(TESTS.team, () => {
    const file = exportedTeam();
    expect(file.agents).toHaveLength(ONE);
    expect(file.team?.members).toHaveLength(ONE + ONE);
    expect(file.team?.policy.checks[ZERO].command).toBe(CHECK_COMMAND);
  });

  it(TESTS.roundTrip, () => {
    const file = exportedTeam();
    const text = JSON.stringify(file);
    const result = parseConfiguration(text);
    expect(result).toEqual(file);
  });

  it(TESTS.imports, () => {
    const file = exportedTeam();
    const imported = prepareConfigurationImport(file, TARGET_WORKSPACE, mapping, targetProjects, [], []);
    expect(imported.agents[ZERO].draft).toMatchObject({ id: null, workspace_id: TARGET_WORKSPACE, account_id: null, template_id: EMPTY_TEXT, repos: [TARGET_REPOSITORY], model: MODEL, perms: PERMISSIONS });
    expect(imported.team?.members[ZERO].repos).toEqual([TARGET_REPOSITORY]);
    expect(imported.team?.policy.checks[ZERO].repo).toBe(TARGET_REPOSITORY);
  });

  it(TESTS.hierarchy, () => {
    const file = exportedTeam();
    const result = prepareConfigurationImport(file, TARGET_WORKSPACE, mapping, targetProjects, [], []);
    const imported = result.team!;
    const [lead, developer] = imported.members;
    expect(lead.id).not.toBe(MEMBER_ID);
    expect(imported.lead).toBe(lead.id);
    expect(developer.reports_to).toBe(lead.id);
    expect(developer.escalate_to).toBe(lead.id);
    expect(lead.talks_to).toEqual([developer.id]);
    expect(imported.policy.review.reviewer).toBe(lead.id);
    expect(imported.policy.review.of).toEqual([developer.id]);
    expect(imported.policy.conflicts).toBe(developer.id);
    expect(imported.plan[ZERO].member).toBe(developer.id);
    expect(imported.plan[ZERO].repo).toBe(TARGET_REPOSITORY);
  });

  it(TESTS.names, () => {
    const file = exportedTeam();
    const result = prepareConfigurationImport(file, TARGET_WORKSPACE, mapping, targetProjects, [AGENT_NAME, NAME_WITH_SUFFIX], [TEAM_NAME]);
    expect(result.agents[ZERO].draft.name).toBe(NEXT_NAME);
    expect(result.team?.name).toBe(`${TEAM_NAME} (2)`);
  });

  it(TESTS.mapping, () => {
    const file = exportedTeam();
    const attempt = () => prepareConfigurationImport(file, TARGET_WORKSPACE, {}, targetProjects, [], []);
    expect(attempt).toThrow(CONFIGURATION_ERRORS.repository);
  });

  it(TESTS.foreign, () => {
    const file = exportedTeam();
    const attempt = () => prepareConfigurationImport(file, TARGET_WORKSPACE, mapping, projects, [], []);
    expect(attempt).toThrow(CONFIGURATION_ERRORS.repository);
  });

  it(TESTS.invalid, () => {
    const malformed = () => parseConfiguration(INVALID_FILE);
    expect(malformed).toThrow(CONFIGURATION_ERRORS.invalid);
    const file = exportedTeam();
    const unrelated = parseAttempt({ ...file, format: UNKNOWN_FORMAT });
    expect(unrelated).toThrow(CONFIGURATION_ERRORS.invalid);
  });

  it(TESTS.version, () => {
    const file = exportedTeam();
    const attempt = parseAttempt({ ...file, version: CONFIGURATION_VERSION + ONE });
    expect(attempt).toThrow(CONFIGURATION_ERRORS.version);
  });

  it.each(PROPERTIES_TO_REJECT)(TESTS.shape, (field) => {
    const file = exportedTeam();
    const configuration = file.agents[ZERO].configuration as unknown as Record<string, unknown>;
    delete configuration[field];
    const attempt = parseAttempt(file);
    expect(attempt).toThrow(CONFIGURATION_ERRORS.invalid);
  });

  it(TESTS.unknown, () => {
    const file = exportedTeam();
    const configuration = file.agents[ZERO].configuration;
    const incoming = { ...file, agents: [{ key: AGENT_ID, configuration: { ...configuration, account_id: ACCOUNT } }] };
    const text = JSON.stringify(incoming);
    const parsed = parseConfiguration(text);
    expect(parsed.agents[ZERO].configuration).not.toHaveProperty(PRIVATE_FIELD);
  });

  it(TESTS.reference, () => {
    const file = exportedTeam();
    file.team!.lead = INVALID_MEMBER;
    const missingMember = parseAttempt(file);
    expect(missingMember).toThrow(CONFIGURATION_ERRORS.reference);
    file.team!.lead = MEMBER_ID;
    file.team!.members[ZERO].agent_id = SECOND_AGENT_ID;
    const missingAgent = parseAttempt(file);
    expect(missingAgent).toThrow(CONFIGURATION_ERRORS.reference);
    file.team!.members[ZERO].agent_id = AGENT_ID;
    file.team!.plan[ZERO].repo = INVALID_REPOSITORY;
    const missingRepository = parseAttempt(file);
    expect(missingRepository).toThrow(CONFIGURATION_ERRORS.reference);
  });

  it(TESTS.cycles, () => {
    const file = exportedTeam();
    file.team!.members[ONE].reports_to = SECOND_MEMBER_ID;
    const reporting = parseAttempt(file);
    expect(reporting).toThrow(CONFIGURATION_ERRORS.reference);
    file.team!.members[ONE].reports_to = MEMBER_ID;
    file.team!.plan[ZERO].depends_on = [STEP_KEY];
    const plan = parseAttempt(file);
    expect(plan).toThrow(CONFIGURATION_ERRORS.reference);
  });

  it(TESTS.duplicates, () => {
    const file = exportedTeam();
    file.agents.push(file.agents[ZERO]);
    const attempt = parseAttempt(file);
    expect(attempt).toThrow(CONFIGURATION_ERRORS.invalid);
  });

  it(TESTS.empty, () => {
    const source = { ...emptyTeam(WORKSPACE), name: TEAM_NAME };
    const file = configurationForExport(source, [], []);
    const result = prepareConfigurationImport(file, TARGET_WORKSPACE, {}, [], [], []);
    expect(result.agents).toHaveLength(ZERO);
    expect(result.team?.members).toHaveLength(ZERO);
  });

  it(TESTS.mutated, () => {
    const file = exportedTeam();
    const before = JSON.stringify(file);
    prepareConfigurationImport(file, TARGET_WORKSPACE, mapping, targetProjects, [], []);
    const after = JSON.stringify(file);
    expect(after).toBe(before);
  });

  it(TESTS.reserved, () => {
    const source = team();
    source.policy.conflicts = AUTHOR;
    source.policy.checks[ZERO].repo = ALL_REPOSITORIES;
    source.plan[ZERO].repo = EMPTY_TEXT;
    const roster = [agent()];
    const file = configurationForExport(source, roster, projects);
    const result = prepareConfigurationImport(file, TARGET_WORKSPACE, mapping, targetProjects, [], []);
    expect(result.team?.policy.conflicts).toBe(AUTHOR);
    expect(result.team?.policy.checks[ZERO].repo).toBe(ALL_REPOSITORIES);
    expect(result.team?.plan[ZERO].repo).toBe(EMPTY_TEXT);
  });

  it(TESTS.unavailable, () => {
    const source = team();
    const missingAgent = () => configurationForExport(source, [], projects);
    expect(missingAgent).toThrow(CONFIGURATION_ERRORS.reference);
    const roster = [agent()];
    const missingRepository = () => configurationForExport(source, roster, []);
    expect(missingRepository).toThrow(CONFIGURATION_ERRORS.repository);
  });

  it(TESTS.enums, () => {
    const file = exportedTeam();
    file.agents[ZERO].configuration.max_parallel = ZERO;
    const invalidNumber = parseAttempt(file);
    expect(invalidNumber).toThrow(CONFIGURATION_ERRORS.invalid);
    file.agents[ZERO].configuration.max_parallel = ONE;
    file.team!.policy.commit = UNKNOWN_FORMAT as Team["policy"]["commit"];
    const invalidMode = parseAttempt(file);
    expect(invalidMode).toThrow(CONFIGURATION_ERRORS.invalid);
  });
});
