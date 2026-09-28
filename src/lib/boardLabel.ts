import type { TranslationKey } from "./i18n/translations";

/**
 * The name of the board a story or a review talks to — "Azure Boards", "Jira", "monday.com" — for
 * every sentence that says where something went or stays.
 *
 * Those sentences all used to say "Azure" whatever the board was, so a Jira publish announced work
 * items created on Azure Boards and a monday review asked to overwrite a description "in Azure
 * DevOps". An unknown value names Azure, which is what every row that predates the other two means
 * (`BoardProvider`'s default on the Rust side).
 */
export function boardLabelKey(provider: string | null | undefined): TranslationKey {
  switch ((provider ?? "").trim().toLowerCase()) {
    case "jira":
      return "stories.targetJira";
    case "monday":
      return "stories.targetMonday";
    default:
      return "stories.targetAzure";
  }
}
