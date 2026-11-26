/**
 * Putting a preparation a model proposed (`note_relations::prep`) into the note it is for: each
 * list under the heading the «Preparar reunión» template already has, in the template's own empty
 * line when it is still there, and the earlier notes it was read from as `[[links]]` at the foot.
 *
 * Pure text in, text out, so the same merge serves the note open in the editor and one that was
 * left meanwhile. Nothing the person wrote is replaced, and a line already in the note is not
 * added again — running it twice does not double the note.
 */

export interface PrepLine {
  text: string;
  /** The title of the note it came from, or `""`. */
  from: string;
}

export interface PrepProposal {
  known: PrepLine[];
  questions: PrepLine[];
  decisions: PrepLine[];
  risks: PrepLine[];
}

export interface PrepSource {
  id: string;
  title: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

/** The headings, as the template writes them in the language on screen. */
export interface PrepLabels {
  known: string;
  questions: string;
  decisions: string;
  risks: string;
  sources: string;
}

const HEADING = /^#{1,6}\s/;
const EMPTY_ITEM = /^\s*[-*]\s*(\[\s?\])?\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

const fold = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, " ").trim();

/** A title that can sit inside `[[…]]` — see `noteLinks`. */
const linkable = (title: string) => title.trim() !== "" && !/[[\]\n]/.test(title);

function render(line: PrepLine, task: boolean): string {
  const from = line.from.trim() ? ` *(${line.from.trim().replace(/\*/g, "\\*")})*` : "";
  return `- ${task ? "[ ] " : ""}${line.text.trim()}${from}`;
}

/** `items` under `## heading`: over the section's first empty item, else after its last line; a
 *  section that is not there is added before the closing rule, or at the end. */
function intoSection(lines: string[], heading: string, items: string[]): string[] {
  if (items.length === 0) return lines;
  const at = lines.findIndex((line) => HEADING.test(line) && fold(line.replace(/^#+\s*/, "")) === fold(heading));
  if (at < 0) {
    const rule = lines.reduce((found, line, index) => (RULE.test(line) ? index : found), -1);
    const before = rule >= 0 ? rule : lines.length;
    const head = lines.slice(0, before);
    while (head.length > 0 && head[head.length - 1].trim() === "") head.pop();
    const tail = lines.slice(before);
    return [...head, ...(head.length > 0 ? [""] : []), `## ${heading}`, "", ...items, ...(tail.length > 0 ? ["", ...tail] : [])];
  }
  let end = lines.length;
  for (let index = at + 1; index < lines.length; index++) {
    if (HEADING.test(lines[index]) || RULE.test(lines[index])) {
      end = index;
      break;
    }
  }
  const blank = lines.findIndex((line, index) => index > at && index < end && EMPTY_ITEM.test(line));
  if (blank >= 0) return [...lines.slice(0, blank), ...items, ...lines.slice(blank + 1)];
  let last = end - 1;
  while (last > at && lines[last].trim() === "") last--;
  // Straight after a list's last item; a blank line first when what is there is prose or the heading.
  const gap = last > at && /^\s*[-*]\s/.test(lines[last]) ? [] : [""];
  return [...lines.slice(0, last + 1), ...gap, ...items, ...lines.slice(last + 1)];
}

/**
 * `content` with the proposal in it. `sources` are the notes the model was shown; only the ones a
 * line names are listed at the foot.
 */
export function mergePreparation(content: string, proposal: PrepProposal, sources: PrepSource[], labels: PrepLabels): string {
  const already = fold(content);
  const fresh = (list: PrepLine[]) => list.filter((line) => line.text.trim() !== "" && !already.includes(fold(line.text)));
  let lines = content.replace(/\r\n/g, "\n").split("\n");
  lines = intoSection(lines, labels.known, fresh(proposal.known).map((line) => render(line, false)));
  lines = intoSection(lines, labels.questions, fresh(proposal.questions).map((line) => render(line, true)));
  lines = intoSection(lines, labels.decisions, fresh(proposal.decisions).map((line) => render(line, true)));
  lines = intoSection(lines, labels.risks, fresh(proposal.risks).map((line) => render(line, false)));
  const named = new Set([...proposal.known, ...proposal.questions, ...proposal.decisions, ...proposal.risks].map((line) => fold(line.from)).filter(Boolean));
  const cited = sources
    .filter((source) => named.has(fold(source.title)))
    .map((source) => `- ${linkable(source.title) ? `[[${source.title.trim()}]]` : source.title.trim()}${source.date ? ` · ${source.date}` : ""}`)
    .filter((line) => !already.includes(fold(line)));
  lines = intoSection(lines, labels.sources, cited);
  return lines.join("\n");
}

/** How many lines of the proposal are not in `content` yet. */
export function freshLines(content: string, proposal: PrepProposal): number {
  const already = fold(content);
  return [...proposal.known, ...proposal.questions, ...proposal.decisions, ...proposal.risks].filter((line) => line.text.trim() !== "" && !already.includes(fold(line.text))).length;
}
