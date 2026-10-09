/**
 * Markdown as it is said aloud: what a reader sees, without what only a screen can show.
 *
 * Code blocks, tables and URLs go — read out they are noise, and «Resumen hablado» exists for an
 * answer that is mostly code. Inline code stays when it is a word («`npm install`») and goes when
 * it is a line. Headings, list markers, emphasis and quotes lose their marks; a line that ended
 * without punctuation gets a full stop, so a list is read as a list of sentences rather than one
 * breathless run.
 */
export function speakable(markdown: string): string {
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    // Fenced code, closed or still open at the end of a streamed answer.
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/~~~[\s\S]*?(~~~|$)/g, "\n")
    .replace(/<[^>\n]+>/g, " ")
    .split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    // Tables and rules.
    if (/^\|.*\|$/.test(line) || /^[-*_=\s|:]{3,}$/.test(line)) continue;
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^\d+[.)]\s+/, "")
      // Images say nothing; links say their text.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/`([^`]+)`/g, (_, code: string) => (code.length <= 32 && !/[{};=<>/\\]/.test(code) ? code : ""))
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)([^*_\s][^*_]*?)\1/g, "$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    out.push(/[.!?…:;,]$/.test(line) ? line : `${line}.`);
  }
  return out.join(" ").replace(/\s+([.,;:!?])/g, "$1").trim();
}
