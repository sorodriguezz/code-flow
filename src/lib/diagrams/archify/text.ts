/**
 * Text measurement without a DOM.
 *
 * Layout runs in the app and in tests, where there is no canvas to ask, and the page it produces is
 * drawn by a viewer that wants the boxes already sized. So widths are estimated per glyph class — a
 * system sans at the sizes the viewer uses — and boxes carry a little more room than the estimate
 * says it needs. Wrong by a few percent on a given string, never by a lot on a typical one.
 */

const NARROW = new Set("iljtfI.,:;'!|()[]{}/\\ ·");
const WIDE = new Set("mwMW@%—–");

/** Width of `value` in px at `size`, for a regular (or, with `bold`, semibold) system sans. */
export function textWidth(value: string, size: number, bold = false): number {
  let units = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x2e80) units += 1; // CJK and wide forms
    else if (NARROW.has(ch)) units += 0.32;
    else if (WIDE.has(ch)) units += 0.88;
    else if (ch >= "A" && ch <= "Z") units += 0.66;
    else if (ch >= "0" && ch <= "9") units += 0.57;
    else units += 0.55;
  }
  // The estimate runs a touch under what a system font really measures; a box sized to it would
  // leave a long label touching its edge.
  return units * size * (bold ? 1.06 : 1) * 1.06;
}

/** Cuts `value` to fit `width` at `size`, ending in an ellipsis. */
export function clipToWidth(value: string, size: number, width: number, bold = false): string {
  if (textWidth(value, size, bold) <= width) return value;
  let end = value.length;
  while (end > 1 && textWidth(`${value.slice(0, end)}…`, size, bold) > width) end--;
  return `${value.slice(0, Math.max(1, end)).trimEnd()}…`;
}

/**
 * Wraps `value` into at most `maxLines` lines no wider than `width`, breaking at spaces (and after
 * `/`, `-`, `.`, `_` for identifiers and paths that have no spaces). The last line is clipped.
 */
export function wrapToWidth(value: string, size: number, width: number, maxLines: number, bold = false): string[] {
  const tokens = value.trim().split(/(?<=[\s/_.-])/).filter((t) => t.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    const next = line + token;
    if (line && textWidth(next.trimEnd(), size, bold) > width) {
      lines.push(line.trimEnd());
      line = token.trimStart();
    } else {
      line = next;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  if (lines.length === 0) return [""];
  if (lines.length > maxLines) {
    const rest = lines.slice(maxLines - 1).join(" ");
    return [...lines.slice(0, maxLines - 1), clipToWidth(rest, size, width, bold)].map((l) => clipToWidth(l, size, width, bold));
  }
  return lines.map((l) => clipToWidth(l, size, width, bold));
}
