/**
 * The viewer's words, in the app's language.
 *
 * The page carries no dictionary of its own: everything it says is in this object, built once from
 * the app's translations — so a downloaded file speaks the language it was exported in, and a new
 * language is a new set of keys here rather than a change to the page.
 */
import type { TranslationKey } from "../../i18n/translations";
import type { ArchifyMode } from "./ir";
import type { ViewerLabels } from "./viewer/html";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** The keys are assembled from a type or a mode, so the compiler cannot know they exist; the test
 *  beside this file does. */
const key = (name: string) => name as TranslationKey;

const SIMPLE = [
  "search", "zoomIn", "zoomOut", "fit", "panel", "motion", "present", "theme", "export", "route", "style",
  "overview", "incoming", "outgoing", "noRelations", "sources", "noSources", "from", "to", "classification",
  "note", "changes", "close", "untitled", "exitPresent", "reachDirect", "reachUp", "reachDown", "reachLabel",
  "reachDirectHint", "reachUpHint", "reachDownHint", "routeHint", "motionHint", "panelHint", "presentHint",
  "routePickFrom", "routePickTo", "routeNone", "routeFound", "routeReversed", "routeOption",
  "statusDirect", "statusUp", "statusDown", "statusSearch", "reachNoteUp", "reachNoteDown", "legendHint",
] as const;

const TYPES = [
  "frontend", "backend", "database", "cloud", "security", "messagebus", "external",
  "start", "active", "waiting", "decision", "success", "failure", "neutral",
] as const;

export const PRESET_IDS = ["classic", "signal-flow", "blueprint", "editorial"] as const;

export function viewerLabels(t: Translate, mode: ArchifyMode): ViewerLabels {
  const out: ViewerLabels = { types: {} };
  for (const name of SIMPLE) out[name] = t(key(`archify.${name}`));
  out.eyebrow = t(key(`archify.eyebrow.${mode}`));
  out.component = t(key(`archify.entity.${mode}`));
  out.entities = t(key(`archify.entities.${mode}`));
  out.relation = t(key(`archify.relation.${mode}`));
  out.counts = t(key(`archify.counts.${mode}`));
  for (const status of ["added", "removed", "changed"]) out[`status_${status}`] = t(key(`archify.status.${status}`));
  for (const type of TYPES) out.types[type] = t(key(`archify.type.${type}`));
  return out;
}

export function presetNames(t: Translate): Record<string, string> {
  return Object.fromEntries(PRESET_IDS.map((id) => [id, t(key(`archify.preset.${id}`))]));
}
