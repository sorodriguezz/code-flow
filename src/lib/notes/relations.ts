/**
 * Related notes, as the Notes view words and draws them. The pairs themselves are kept by the
 * backend (`note_relations`): this is how one is read from the note being looked at.
 */
import type { Translate } from "../../state/languageStore";
import type { TranslationKey } from "../i18n/translations";
import type { NoteRelation } from "../../types/notes";

/** What the other note is to the one being read. */
export type RelationRole = "continuesFrom" | "continuedIn" | "related";

export function relationRole(relation: Pick<NoteRelation, "kind" | "direction">): RelationRole {
  if (relation.kind !== "continues") return "related";
  // The other note came before: this one continues it. It came after: it continues this one.
  return relation.direction === "earlier" ? "continuesFrom" : "continuedIn";
}

export const ROLE_LABEL: Record<RelationRole, TranslationKey> = {
  continuesFrom: "notes.relations.continuesFrom",
  continuedIn: "notes.relations.continuedIn",
  related: "notes.relations.related",
};

/** Why the two are related, in a line: what a model said, else the words they share. */
export function relationWhy(relation: Pick<NoteRelation, "reason" | "shared">, t: Translate): string {
  if (relation.reason.trim()) return relation.reason.trim();
  if (relation.shared.length === 0) return "";
  return t("notes.relations.shares", { words: relation.shared.join(", ") });
}

/** Everything known about a pair, for a tooltip. */
export function relationSummary(relation: NoteRelation, t: Translate): string {
  const lines = [`${t(ROLE_LABEL[relationRole(relation)])}: ${relation.title.trim() || t("notes.untitled")}`];
  const why = relationWhy(relation, t);
  if (why) lines.push(why);
  if (relation.resolved.length > 0) lines.push(`${t("notes.relations.resolved")}: ${relation.resolved.join("; ")}`);
  if (relation.pending.length > 0) lines.push(`${t("notes.relations.pending")}: ${relation.pending.join("; ")}`);
  return lines.join("\n");
}

/** The same key for a pair whichever way round it is given. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * The graph's edges with the related pairs added: a pair already joined by a `[[link]]` stays one
 * line — drawn as the link it is — and the rest are returned in `related`, to be drawn apart.
 */
export function mergeGraphEdges(edges: [string, string][], relations: [string, string, string][] = []): { edges: [string, string][]; related: Set<string> } {
  const seen = new Set(edges.map(([from, to]) => pairKey(from, to)));
  const related = new Set<string>();
  const merged = [...edges];
  for (const [later, earlier] of relations) {
    const key = pairKey(later, earlier);
    if (later === earlier || seen.has(key)) continue;
    seen.add(key);
    related.add(key);
    merged.push([later, earlier]);
  }
  return { edges: merged, related };
}

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** The notes that can be linked to one by hand: by title, accents and case aside, leaving out
 *  itself and the ones already related. With no query, the most recently touched. */
export function linkCandidates<N extends { id: string; title: string; updated_at: string }>(notes: N[], query: string, exclude: Set<string>, limit = 8): N[] {
  const wanted = fold(query).split(/\s+/).filter(Boolean);
  return notes
    .filter((note) => !exclude.has(note.id) && wanted.every((word) => fold(note.title).includes(word)))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit);
}
