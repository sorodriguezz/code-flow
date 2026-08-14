/**
 * A note's headings, as the outline panel lists them.
 *
 * A line scan and not a Markdown parse. The outline is recomputed as the user types (behind a
 * deferred value, but still), and running `marked` over a long note per keystroke is exactly the
 * cost this feature must not have. Headings are the one construct where the line-oriented reading
 * is also the correct one.
 *
 * **The output has to stay index-for-index with what the preview renders**, because that is how an
 * outline click scrolls the rendered document: the panel's Nth row is the Nth `h1…h6` element in
 * the preview (`marked` emits no `id` attributes to aim at, so there is nothing else to match on).
 * Two things follow from that, and both are why this is more than one regex:
 *
 * - **Fenced code is skipped.** A shell snippet full of `# comment` lines would otherwise fill the
 *   outline with commentary — and, worse, shift every real heading after it out of alignment.
 * - **Setext headings are recognised.** `Title` over `=====` is an `<h1>` to every Markdown
 *   renderer including this one's, so missing them would leave the rail one element short of the
 *   document from that point on and send every later click to the wrong section.
 */

export interface Heading {
  /** 1–6. */
  level: number;
  text: string;
  /** Zero-based, so it goes straight to `revealLineInCenter(line + 1)`. */
  line: number;
}

export function outlineOf(content: string): Heading[] {
  const headings: Heading[] = [];
  const lines = content.split("\n");
  let fence: string | null = null;

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at];
    const trimmed = line.trim();

    // Fences open and close with the same character; a ``` inside a ~~~ block is content.
    const opener = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : null;
    if (opener) {
      if (fence === null) fence = opener;
      else if (fence === opener) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const atx = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/.exec(line);
    if (atx) {
      // The closing run of hashes in `## Title ##` is decoration, not text.
      const text = (atx[2] ?? "").replace(/\s+#+\s*$/, "").trim();
      // A bare `##` renders as an empty heading element, so it still counts — dropping it here
      // would shift every index after it.
      headings.push({ level: atx[1].length, text: stripInline(text), line: at });
      continue;
    }

    // Setext: this line is prose and the *next* is a run of `=` or `-`. The preceding line must be
    // non-blank, which is what separates `---` as an underline from `---` as a horizontal rule.
    if (!trimmed) continue;
    const next = lines[at + 1]?.trim();
    if (!next) continue;
    if (/^=+$/.test(next)) {
      headings.push({ level: 1, text: stripInline(trimmed), line: at });
      at++;
    } else if (/^-+$/.test(next)) {
      // A single `-` under text is a list item beginning, not an underline; two or more is setext.
      // (CommonMark allows one, but a lone hyphen under a line is a list far more often than it is
      // a heading, and guessing wrong here silently reorders the whole rail.)
      if (next.length >= 2) {
        headings.push({ level: 2, text: stripInline(trimmed), line: at });
        at++;
      }
    }
  }

  return headings;
}

/** Inline marks off a heading's text, so `**Deploy**` reads as `Deploy` in the rail. */
function stripInline(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}
