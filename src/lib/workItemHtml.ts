/**
 * Azure's work-item prose, as text.
 *
 * Description and Acceptance Criteria are stored as HTML, written by a rich-text editor that emits
 * whatever the person pasted into it — Word markup, nested `<div>`s, `<br>` where a paragraph was
 * meant. The review screen shows that as plain text and sends the same string to the model, which is
 * the point: the story that gets judged has to be the story on screen.
 *
 * Deliberately lossy and deliberately one-way. Nothing here rebuilds HTML to write back, because
 * round-tripping someone else's formatting through a text box is how a table becomes four lines of
 * run-on prose in a board other people are working from.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Azure's HTML as readable text: block tags become line breaks, list items get a bullet. */
export function htmlToText(html: string): string {
  if (!html.trim()) return "";
  return decodeEntities(
    html
      // Script and style would otherwise survive as their own source code once the tags are gone.
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|tr)\s*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/(td|th)\s*>/gi, "\t")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r/g, "")
    // Three or more blank lines is the editor's leftovers, never the author's intent.
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * The criteria field split into scenarios.
 *
 * Gherkin has no separator of its own, so a field holding four scenarios is one blob of text. Split
 * on the line that opens a scenario when there is one, and fall back to blank lines — which is how
 * someone who never wrote `Escenario:` still separated them.
 */
export function splitCriteria(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const opener = /^\s*(?:-\s*)?(escenario|scenario|esquema del escenario|scenario outline)\b/i;
  const lines = trimmed.split("\n");
  if (lines.some((line) => opener.test(line))) {
    const scenarios: string[] = [];
    for (const line of lines) {
      if (opener.test(line) || scenarios.length === 0) scenarios.push(line);
      else scenarios[scenarios.length - 1] += `\n${line}`;
    }
    return scenarios.map((s) => s.trim()).filter(Boolean);
  }

  return trimmed
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

/**
 * The whole story as one payload for the model.
 *
 * Labelled in Spanish because the prompts are: the section headings are what the model matches its
 * `section` answers against, so these strings and `StorySection` have to keep saying the same thing.
 */
export function storyPayload(input: {
  title: string;
  description: string;
  criteria: string[];
  tasks: { title: string; state: string }[];
}): string {
  const parts = [`TÍTULO: ${input.title.trim()}`];

  parts.push(`\nDESCRIPCIÓN:\n${input.description.trim() || "(vacía)"}`);

  parts.push(
    input.criteria.length > 0
      ? `\nCRITERIOS DE ACEPTACIÓN ACTUALES:\n${input.criteria
          .map((criterion, at) => `${at + 1}. ${criterion}`)
          .join("\n\n")}`
      : "\nCRITERIOS DE ACEPTACIÓN ACTUALES: (ninguno)",
  );

  parts.push(
    input.tasks.length > 0
      ? `\nTAREAS QUE YA EXISTEN:\n${input.tasks
          .map((task) => `- ${task.title} [${task.state}]`)
          .join("\n")}`
      : "\nTAREAS QUE YA EXISTEN: (ninguna)",
  );

  return parts.join("\n");
}
