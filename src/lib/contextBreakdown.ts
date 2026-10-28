/**
 * The CLI's `/context` answer, read into categories — system prompt, tools, memory files, skills,
 * messages, free space — so the chat can draw them as bars instead of leaving a table of text.
 *
 * Read from the text the CLI printed and nothing else, so it is tolerant by construction: any line of
 * the shape `<name> … <n>[k|m] tokens [(<p>%)]` is a category, whatever surrounds it (a markdown
 * table, a bullet, a box-drawing prefix). Under three such lines there is no breakdown to draw and
 * the answer is left as the text it is. A format the CLI changes to something else costs the bars,
 * never the answer.
 */

export interface ContextCategory {
  name: string;
  tokens: number;
  /** Of the window, when the line said so. */
  percent: number | null;
  /** Free space is shown but is not "used". */
  free: boolean;
}

export interface ContextBreakdown {
  categories: ContextCategory[];
  /** Tokens used: every category that is not free space. */
  used: number;
}

const LINE = /^[\s|>*\-•⛁⛀⛶⛝─-╿]*([A-Za-z][A-Za-z0-9 ./()&'’_-]*?)\s*[:|]?\s+([\d][\d.,]*)\s*([km]?)\s*tokens?\b(?:[^\d%]*\(?\s*([\d.]+)\s*%)?/i;

function amount(digits: string, unit: string): number | null {
  const value = Number(digits.replace(/,/g, unit ? "." : ""));
  if (!Number.isFinite(value)) return null;
  const scale = unit.toLowerCase() === "k" ? 1000 : unit.toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(value * scale);
}

export function parseContextBreakdown(text: string): ContextBreakdown | null {
  const categories: ContextCategory[] = [];
  for (const raw of text.split("\n")) {
    const found = LINE.exec(raw);
    if (!found) continue;
    const name = found[1].trim().replace(/\s+/g, " ");
    // The window's own total line ("Opus 5.5 · 42k/200k tokens") is not a category.
    if (/^(total|context usage|tokens)$/i.test(name) || name.includes("/")) continue;
    const tokens = amount(found[2], found[3]);
    if (tokens === null) continue;
    categories.push({
      name,
      tokens,
      percent: found[4] === undefined ? null : Number(found[4]),
      free: /free|available|remaining/i.test(name),
    });
  }
  if (categories.length < 3) return null;
  return { categories, used: categories.filter((c) => !c.free).reduce((sum, c) => sum + c.tokens, 0) };
}
