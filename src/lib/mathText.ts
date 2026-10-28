/** A run of text and a formula in it, in the order they are written. */
export type MathSegment = { kind: "text"; value: string } | { kind: "inline" | "display"; value: string };

/**
 * Finds the formulas in a paragraph of an answer: `$$…$$` is a displayed formula, `$…$` one inside the
 * line. Strict about what counts, so prices stay prices — no space just inside either dollar and no digit
 * right after the closing one ("$5 and $10" is money, not a formula), and `\$` is a dollar sign.
 *
 * Pure text in, segments out: the renderer (KaTeX, loaded on demand) is the caller's, so this is the one
 * place the rule lives and the one that is tested.
 */
export function splitMath(text: string): MathSegment[] {
  const out: MathSegment[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ kind: "text", value: plain });
    plain = "";
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\" && text[at + 1] === "$") {
      plain += "$";
      at += 2;
      continue;
    }
    if (char === "$") {
      if (text[at + 1] === "$") {
        const end = text.indexOf("$$", at + 2);
        const body = end === -1 ? "" : text.slice(at + 2, end).trim();
        if (end !== -1 && body) {
          flush();
          out.push({ kind: "display", value: body });
          at = end + 2;
          continue;
        }
      } else {
        const found = /^\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/.exec(text.slice(at));
        if (found) {
          flush();
          out.push({ kind: "inline", value: found[1] });
          at += found[0].length;
          continue;
        }
      }
    }
    plain += char;
    at += 1;
  }
  flush();
  return out;
}

/** Whether a text node is worth a pass at all. */
export function mayContainMath(text: string): boolean {
  return text.includes("$");
}
