import { translate } from "../../state/languageStore";
import type { TranslationKey } from "../i18n/translations";
import type { NoteTemplate, NoteTemplateRow } from "../../types/notes";
import { parseTags } from "./tags";

/**
 * The templates that ship with the app.
 *
 * A constant here, but not what the picker shows. `notesStore.setWorkspace` writes these into
 * `note_templates` as ordinary rows the first time a workspace is opened — once, tracked by a
 * settings flag rather than by "the table happens to be empty" — so from the picker's point of
 * view a shipped template and one the user wrote are the same kind of thing: editable, deletable,
 * indistinguishable. The trade this makes is the one "duplicate to my templates" already made for
 * anyone who used it: a seeded row stops following the app's language, because a row holds one
 * language and there is no other way to give someone an editable copy.
 *
 * This constant is still what the six *are* — the picker no longer reads it directly, but the seed
 * step does, once, in whatever language the workspace is opened in first.
 *
 * They are also *why* the picker exists at all. A notes app whose "new" button makes an empty file
 * teaches nothing about what to write; six openings that are already the right shape is most of
 * what a template feature is for.
 */

/** A placeholder a template body may carry. Substituted at the moment a note is made from it. */
const VARIABLES = ["date", "time", "datetime", "title"] as const;
type Variable = (typeof VARIABLES)[number];

/** `as const` so the ids are literal types: the `notes.tpl.${id}.name` keys below are then checked
 *  against `TranslationKey` rather than cast, and a template added without its three strings is a
 *  compile error instead of a blank row in the picker. */
const BUILT_INS = [
  { id: "meeting", icon: "users", tags: ["reunion"] },
  { id: "daily", icon: "calendar-days", tags: ["diario"] },
  { id: "decision", icon: "git-branch", tags: ["decision", "arquitectura"] },
  { id: "runbook", icon: "siren", tags: ["runbook", "operaciones"] },
  { id: "spec", icon: "clipboard-list", tags: ["spec"] },
  { id: "retro", icon: "repeat", tags: ["retro"] },
] as const satisfies readonly { id: string; icon: string; tags: readonly string[] }[];

/**
 * The six shipped templates, translated — the shape `notesStore`'s one-time seed writes into the
 * database. Not memoised: it runs once per workspace, ever, so there is nothing to gain by caching
 * it and a cache keyed on nothing would risk seeding a stale language if that ever changed.
 */
export function builtInTemplates(): NoteTemplate[] {
  return BUILT_INS.map(({ id, icon, tags }) => ({
    id: `builtin:${id}`,
    workspace_id: "",
    name: translate(`notes.tpl.${id}.name` satisfies TranslationKey),
    description: translate(`notes.tpl.${id}.desc` satisfies TranslationKey),
    icon,
    content: translate(`notes.tpl.${id}.body` satisfies TranslationKey),
    tags: [...tags],
    sort_order: -1,
    created_at: "",
    updated_at: "",
  }));
}

/** A stored row as the UI holds it. */
export function toTemplate(row: NoteTemplateRow): NoteTemplate {
  return { ...row, tags: parseTags(row.tags) };
}

/**
 * A template body with its placeholders filled in.
 *
 * `{{date}}`, `{{time}}`, `{{datetime}}` and `{{title}}`, in the user's locale — the same set
 * Obsidian and HackMD use, so someone arriving from either finds what they expect. An unknown
 * placeholder is left exactly as written rather than blanked: `{{jira}}` in a template is far more
 * likely to be a note to the reader than a typo, and eating it would hide it.
 */
export function fillTemplate(content: string, title: string, at: Date = new Date()): string {
  const values: Record<Variable, string> = {
    date: at.toLocaleDateString(),
    time: at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    datetime: at.toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    title,
  };
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
    const key = name.toLowerCase() as Variable;
    return VARIABLES.includes(key) ? values[key] : whole;
  });
}

/**
 * The title a note made from a template should start with.
 *
 * The template's first `# Heading`, with its placeholders filled — because a template that opens
 * "# Reunión — {{date}}" has already said what the note is called, and asking the user to retype it
 * into the title field is asking them to say it twice. Falls back to the template's name.
 */
export function titleFromTemplate(template: NoteTemplate, at: Date = new Date()): string {
  const heading = /^#\s+(.+)$/m.exec(template.content)?.[1]?.trim();
  return fillTemplate(heading || template.name, template.name, at);
}
