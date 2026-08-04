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

/**
 * Azure's HTML as readable text: block tags become line breaks, list items get a bullet, and the
 * handful of marks Markdown has a spelling for keep it.
 *
 * The marks are why this is not simply a tag strip. The review screen edits the description in a
 * Markdown editor and publishes what it renders, so a heading written there reaches the board as
 * an `<h2>` — and a strip would bring it back as a bare line, losing the structure on every round
 * trip until the document was flat. What comes back now is the same document, spelled the way it
 * was written.
 *
 * Still deliberately lossy in the other direction: tables, images and anything with attributes
 * come back as their text. Round-tripping someone else's formatting through a text box is how a
 * table becomes four lines of run-on prose in a board other people are working from, and a partial
 * answer that admits it beats a faithful one that is wrong in the interesting cases.
 */
export function htmlToText(html: string): string {
  if (!html.trim()) return "";
  return decodeEntities(
    html
      // Script and style would otherwise survive as their own source code once the tags are gone.
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      // Before the closing-tag pass, which turns `</h2>` into the newline that ends the line.
      .replace(/<h([1-6])(\s[^>]*)?>/gi, (_whole, level: string) => `\n${"#".repeat(Number(level))} `)
      // The optional-`\s` group is load-bearing: `<i[^>]*>` would also match `<img …>` and quietly
      // turn every image into an underscore.
      .replace(/<(strong|b)(\s[^>]*)?>|<\/(strong|b)\s*>/gi, "**")
      .replace(/<(em|i)(\s[^>]*)?>|<\/(em|i)\s*>/gi, "_")
      .replace(/<code(\s[^>]*)?>|<\/code\s*>/gi, "`")
      .replace(/<\/(p|div|h[1-6]|tr)\s*>/gi, "\n")
      // The closing tag *and* the whitespace after it, before the bullets go in. A pretty-printed
      // `</li>\n<li>` would otherwise leave a blank line between every item, which Markdown reads
      // back as a loose list — the same items, spaced like paragraphs.
      .replace(/<\/li\s*>\s*/gi, "")
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
 * The criteria field split into criteria, from the HTML rather than from its text.
 *
 * Azure stores the field as one blob, but when that blob is a list the boundaries are *in* it:
 * `<li>` is exactly "one criterion", written there by whoever published it — CodeFlow itself does,
 * and so does Azure's own editor. Reading them off the markup is unambiguous, which splitting the
 * flattened text can never be: a criterion whose body is a checklist arrives as bulleted lines
 * indistinguishable from four criteria that happen to be bullets, and the text-based split has to
 * guess. It used to guess wrong on the commonest input there is — the criteria CodeFlow published
 * itself come back as `<li>a</li><li>b</li>` with nothing between them, which flattens to two
 * bulleted lines with no blank line to split on, and the whole list opened as a single criterion.
 *
 * Falls back to [`splitCriteria`] when there is no list: a field somebody typed as paragraphs is
 * still a field with criteria in it.
 */
export function splitCriteriaHtml(html: string): string[] {
  const items = topLevelListItems(html)
    .map((item) => htmlToText(item))
    .filter((item) => item.trim());
  return items.length > 0 ? items : splitCriteria(htmlToText(html));
}

/**
 * The bodies of the outermost `<li>` elements, nested lists left inside them.
 *
 * A regex cannot do this, and the one that used to be here got it wrong the moment a criterion had
 * a list of its own in it: `<li>…<ul><li>a</li><li>b</li></ul></li>` ends at the *inner* `</li>`
 * for a non-greedy match, so one criterion came back as three fragments with a stray `<ul>` in the
 * first. That input is the ordinary case now — a criterion written as a checklist is published as a
 * real nested list, because a list flattened to lines beginning with a dash renders in Azure with
 * the dash *and* a bullet the host draws in front of it.
 *
 * So: walk the item tags, counting depth, and cut only where the depth returns to zero.
 */
function topLevelListItems(html: string): string[] {
  const items: string[] = [];
  const tags = /<(\/?)li[^>]*>/gi;
  let depth = 0;
  let openedAt = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    const closing = tag[1] === "/";
    if (!closing) {
      if (depth === 0) openedAt = tag.index + tag[0].length;
      depth += 1;
      continue;
    }
    // A stray `</li>` with nothing open is malformed markup, not the end of anything.
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0) items.push(html.slice(openedAt, tag.index));
  }
  return items;
}

/**
 * The criteria field split into scenarios, given only its text.
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
  workItemType: string;
  effort: string;
  description: string;
  /** A bug's steps, which is where its prose actually lives. Empty for a story. */
  reproSteps: string;
  /** Environment and version, when the bug reported any. */
  systemInfo: string;
  criteria: string[];
  tasks: { title: string; state: string }[];
}): string {
  const parts = [`TIPO: ${input.workItemType.trim() || "(desconocido)"}`, `TÍTULO: ${input.title.trim()}`];

  // Said even when absent: "sin estimar" is a finding in itself, and a model that never sees the
  // field cannot tell the difference between unestimated and not shown to it.
  parts.push(`ESTIMACIÓN: ${input.effort.trim() || "sin estimar"}`);

  parts.push(`\nDESCRIPCIÓN:\n${input.description.trim() || "(vacía)"}`);

  if (input.reproSteps.trim()) {
    parts.push(`\nPASOS PARA REPRODUCIR:\n${input.reproSteps.trim()}`);
  }
  if (input.systemInfo.trim()) {
    parts.push(`\nENTORNO:\n${input.systemInfo.trim()}`);
  }

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
