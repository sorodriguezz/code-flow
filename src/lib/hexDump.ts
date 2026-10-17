/**
 * The text of a hex dump, as `xxd` and VS Code's Hex Editor lay it out: the offset, sixteen bytes in
 * pairs, and the same bytes as text with anything unprintable as a dot.
 */
export function hexDump(bytes: ArrayLike<number>, start = 0): string {
  const lines: string[] = [];
  for (let row = 0; row < bytes.length; row += 16) {
    let hex = "";
    let text = "";
    for (let i = 0; i < 16; i++) {
      const at = row + i;
      if (at < bytes.length) {
        const byte = bytes[at];
        hex += byte.toString(16).padStart(2, "0");
        text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
      } else {
        hex += "  ";
      }
      hex += i % 2 === 1 ? " " : "";
      if (i === 7) hex += " ";
    }
    lines.push(`${(start + row).toString(16).padStart(8, "0")}  ${hex} ${text}`);
  }
  return lines.join("\n");
}
