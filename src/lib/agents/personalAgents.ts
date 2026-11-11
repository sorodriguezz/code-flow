import type { WorkspaceAgent } from "../../types/domain";
import type { Language } from "../i18n/translations";
import { builtinLibrary, draftFromTemplate, SYNCED_FIELDS } from "./builtinTemplates";

const BUILTIN_LANGUAGES: Language[] = ["es", "en"];
const AGENT_TEMPLATE_KIND = "agent";
const EMPTY_COUNT = 0;
const PERSONAL_AGENT_FIELDS = [...SYNCED_FIELDS, "name", "enabled", "account_id", "repos", "perms"] as const;

const builtinAgentDefaults = BUILTIN_LANGUAGES.flatMap((language) => {
  const library = builtinLibrary(language);
  const templates = library.filter((item) => item.kind === AGENT_TEMPLATE_KIND);
  return templates.map((template) => {
    const draft = draftFromTemplate(template, template.id, []);
    return { templateId: template.id, draft };
  });
});

export function isPersonalAgent(agent: WorkspaceAgent): boolean {
  const overrideCount = agent.overrides?.length ?? EMPTY_COUNT;
  if (overrideCount > EMPTY_COUNT) return true;

  const defaults = builtinAgentDefaults.filter((entry) => entry.templateId === agent.template_id);
  if (defaults.length === EMPTY_COUNT) return true;

  const matchesDefault = defaults.some(({ draft }) => {
    return PERSONAL_AGENT_FIELDS.every((field) => {
      const actual = agent[field] ?? draft[field];
      const actualValue = JSON.stringify(actual);
      const defaultValue = JSON.stringify(draft[field]);
      return actualValue === defaultValue;
    });
  });
  return !matchesDefault;
}
