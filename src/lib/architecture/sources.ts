/**
 * The document's sources, as the app keeps and re-reads them.
 *
 * A document generated from a repository, documents or a brief records them in `sources` (and the
 * brief itself in `brief`), so every later AI action — the review board, an ADR, the tutor, a
 * question — reads them again and answers from the real thing rather than from the drawing alone.
 * A cloud read is recorded too, but never re-run behind the person's back: reading an account again
 * takes their authorization again, in the sources dialog.
 */
import type { ArchSource } from "../tauri/architectureCommands";
import type { ArchDoc, Brief, SourceRef } from "./types";

const BRIEF_FIELDS: Array<[keyof Omit<Brief, "drivers">, string]> = [
  ["problem", "Problem"],
  ["goals", "Goals"],
  ["outOfScope", "Out of scope"],
  ["current", "Current state"],
  ["constraints", "Constraints"],
  ["scale", "Expected scale"],
  ["team", "Team"],
  ["compliance", "Compliance"],
  ["budget", "Budget and deadlines"],
];

export const BRIEF_KEYS = BRIEF_FIELDS.map(([key]) => key);

/** Whether the brief says anything at all. */
export function briefFilled(brief: Brief | undefined): boolean {
  if (!brief) return false;
  return BRIEF_FIELDS.some(([key]) => !!brief[key]?.trim()) || !!brief.drivers?.length;
}

/** The brief as the model reads it. Labels in English: the model reads either language, and the
 *  answers are asked for in the person's. */
export function briefText(brief: Brief): string {
  const lines: string[] = [];
  for (const [key, label] of BRIEF_FIELDS) {
    const value = brief[key]?.trim();
    if (value) lines.push(`${label}: ${value}`);
  }
  if (brief.drivers?.length) lines.push(`Quality drivers (weight 1-5): ${brief.drivers.map((d) => `${d.attribute} ${d.weight}`).join(", ")}`);
  return lines.join("\n");
}

/** What can be read again for an AI action without asking: repositories, documents and the brief. */
export function rereadable(doc: ArchDoc): ArchSource[] {
  const out: ArchSource[] = [];
  for (const s of doc.sources ?? []) {
    if (s.kind === "repo" && s.ref) out.push({ kind: "repo", path: s.ref });
    else if (s.kind === "document" && s.ref) out.push({ kind: "document", path: s.ref });
  }
  if (briefFilled(doc.brief)) out.push({ kind: "text", name: "Brief", text: briefText(doc.brief!) });
  return out;
}

const sameSource = (a: SourceRef, b: SourceRef) => a.kind === b.kind && (a.ref ?? a.name) === (b.ref ?? b.name);

/** Records what a generation read: each source once, with the date of its latest read. */
export function stampSources(doc: ArchDoc, read: SourceRef[], brief?: Brief): ArchDoc {
  const next: ArchDoc = structuredClone(doc);
  const kept = (next.sources ?? []).filter((s) => !read.some((r) => sameSource(r, s)));
  next.sources = [...kept, ...read];
  if (!next.sources.length) delete next.sources;
  if (brief !== undefined) {
    if (briefFilled(brief)) next.brief = brief;
    else delete next.brief;
  }
  return next;
}

/** Decision criteria from the brief's quality drivers, for a new decision. */
export function criteriaFromBrief(brief: Brief | undefined, name: (attribute: string) => string): Array<{ id: string; name: string; weight: number }> {
  return (brief?.drivers ?? []).filter((d) => d.weight > 0).map((d) => ({ id: d.attribute, name: name(d.attribute), weight: d.weight }));
}
