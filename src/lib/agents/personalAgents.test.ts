import { describe, expect, it } from "vitest";
import type { WorkspaceAgent } from "../../types/domain";
import type { Language } from "../i18n/translations";
import { builtinLibrary, draftFromTemplate } from "./builtinTemplates";
import { isPersonalAgent } from "./personalAgents";

const TEST_SUITE = "personal agents";
const DEFAULTS_TEST = "hides unchanged built-in agents in both languages";
const CREATED_TEST = "keeps agents created from scratch, custom templates and duplicated names";
const MODIFIED_TEST = "keeps changes to identity, routing, appearance, instructions and permissions";
const OPTIONAL_FIELDS_TEST = "recognizes defaults on older rows without optional fields";
const ROSTER_TEST = "filters mixed rosters without removing their underlying agents";
const LANGUAGES: Language[] = ["es", "en"];
const TEMPLATE_KIND = "agent";
const WORKSPACE_ID = "workspace";
const AGENT_ID = "agent";
const EMPTY_TEXT = "";
const EMPTY_COUNT = 0;
const FIRST_ITEM = 0;
const CUSTOM_TEMPLATE_ID = "custom-template";
const UNKNOWN_TEMPLATE_ID = "builtin:unknown-template";
const CUSTOM_NAME = "My agent";
const CUSTOM_ROLE = "Custom role";
const CUSTOM_PROMPT = "Custom instructions";
const CUSTOM_PROVIDER = "custom-provider";
const CUSTOM_MODEL = "custom-model";
const CUSTOM_ACCOUNT = "custom-account";
const CUSTOM_EFFORT = "low";
const CUSTOM_ICON = "brain";
const CUSTOM_COLOR = "rose";
const CUSTOM_PARALLELISM = 3;
const TERMINAL_MODE = "terminal";
const CUSTOM_PERMISSION = "push";
const OVERRIDDEN_FIELD = "model";

function builtinAgents(language: Language): WorkspaceAgent[] {
  const library = builtinLibrary(language);
  const templates = library.filter((template) => template.kind === TEMPLATE_KIND);
  return templates.map((template) => {
    const draft = draftFromTemplate(template, WORKSPACE_ID, []);
    return { ...draft, id: template.id, sort_order: EMPTY_COUNT, created_at: EMPTY_TEXT };
  });
}

const spanishAgents = builtinAgents(LANGUAGES[FIRST_ITEM]);
const original = spanishAgents[FIRST_ITEM];

describe(TEST_SUITE, () => {
  it(DEFAULTS_TEST, () => {
    for (const language of LANGUAGES) {
      const defaults = builtinAgents(language);
      const visible = defaults.filter(isPersonalAgent);
      expect(visible).toHaveLength(EMPTY_COUNT);
    }
  });

  it(CREATED_TEST, () => {
    const createdAgents = [
      { ...original, template_id: EMPTY_TEXT },
      { ...original, template_id: CUSTOM_TEMPLATE_ID },
      { ...original, template_id: UNKNOWN_TEMPLATE_ID },
      { ...original, name: CUSTOM_NAME },
    ];
    const visible = createdAgents.filter(isPersonalAgent);
    expect(visible).toEqual(createdAgents);
  });

  it(MODIFIED_TEST, () => {
    const changes: Partial<WorkspaceAgent>[] = [
      { name: CUSTOM_NAME }, { role: CUSTOM_ROLE }, { prompt: CUSTOM_PROMPT },
      { provider: CUSTOM_PROVIDER }, { model: CUSTOM_MODEL }, { account_id: CUSTOM_ACCOUNT },
      { effort: CUSTOM_EFFORT }, { icon: CUSTOM_ICON }, { color: CUSTOM_COLOR },
      { enabled: false }, { edits: !original.edits }, { run_in: TERMINAL_MODE },
      { max_parallel: CUSTOM_PARALLELISM }, { model_ladder: [CUSTOM_MODEL] },
      { repos: [WORKSPACE_ID] }, { perms: [CUSTOM_PERMISSION] }, { overrides: [OVERRIDDEN_FIELD] },
    ];
    for (const change of changes) {
      const edited = { ...original, ...change };
      const visible = isPersonalAgent(edited);
      expect(visible).toBe(true);
    }
  });

  it(OPTIONAL_FIELDS_TEST, () => {
    const older = { ...original, account_id: undefined, repos: undefined, perms: undefined, run_in: undefined, max_parallel: undefined, model_ladder: undefined };
    const visible = isPersonalAgent(older);
    expect(visible).toBe(false);
  });

  it(ROSTER_TEST, () => {
    const custom = { ...original, id: AGENT_ID, template_id: EMPTY_TEXT };
    const edited = { ...original, model: CUSTOM_MODEL };
    const roster = [...spanishAgents, custom, edited];
    const expectedRoster = [...roster];
    const expectedVisible = [custom, edited];
    const visible = roster.filter(isPersonalAgent);
    expect(visible).toEqual(expectedVisible);
    expect(roster).toEqual(expectedRoster);
  });
});
