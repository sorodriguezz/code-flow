export interface AnalysisFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  type: string;
  category: string;
  subtitle: string;
  why: string;
  suggestion: string;
  exampleLang: string;
  exampleCode: string;
  confidence: number | null;
}

export interface ParsedAnalysis {
  findings: AnalysisFinding[];
  /** Any prose before the first finding heading (e.g. a one-line "looks fine ✅" reply) —
   * also the fallback: if nothing matched the expected format at all, the full raw text
   * ends up here so something reasonable always renders. */
  summary: string;
  footer: string | null;
}

const FOOTER_RE = /\n?---\n🤖[^\n]*$/;
const HEADER_RE = /^###\s*(🚨|⚠️|ℹ️)\s*\[([^·\]]+)·([^\]]+)\]\s*([^·]+)·\s*(F-\d+)\s*$/;

function severityFromEmoji(emoji: string): AnalysisFinding["severity"] {
  if (emoji === "🚨") return "critical";
  if (emoji === "⚠️") return "warning";
  return "info";
}

/** Parses the structured "### {emoji} [Severity · Type] Category · F-00N" findings format
 * the review/analysis prompts are instructed to produce. Deliberately lenient — a finding
 * that doesn't fully match every sub-field still renders with whatever it has, and text
 * that never even opens a heading falls back to `summary` rather than disappearing. */
export function parseAnalysis(raw: string): ParsedAnalysis {
  let text = raw.trim();
  let footer: string | null = null;
  const footerMatch = text.match(FOOTER_RE);
  if (footerMatch && footerMatch.index !== undefined) {
    footer = footerMatch[0].replace(/^\n?---\n/, "").trim();
    text = text.slice(0, footerMatch.index).trim();
  }

  const lines = text.split("\n");
  const findings: AnalysisFinding[] = [];
  const summaryLines: string[] = [];
  let sawHeader = false;
  let i = 0;

  while (i < lines.length) {
    const headerMatch = lines[i].match(HEADER_RE);
    if (!headerMatch) {
      if (!sawHeader) summaryLines.push(lines[i]);
      i++;
      continue;
    }
    sawHeader = true;
    const [, emoji, , typeRaw, categoryRaw, id] = headerMatch;
    i++;
    const blockLines: string[] = [];
    while (i < lines.length && !lines[i].match(HEADER_RE)) {
      blockLines.push(lines[i]);
      i++;
    }
    const block = blockLines.join("\n").trim();

    const subtitleMatch = block.match(/^([\s\S]*?)\n\n?💭/);
    const whyMatch = block.match(/💭\s*Por qué:\s*([\s\S]*?)\n\n?💡/);
    const suggestionMatch = block.match(/💡\s*Sugerencia:\s*([\s\S]*?)\n\n?(?:🛠️|🎯)/);
    const codeMatch = block.match(/```(\w*)\n([\s\S]*?)```/);
    const confidenceMatch = block.match(/🎯\s*Confianza:\s*(\d+)/);

    findings.push({
      id: id.trim(),
      severity: severityFromEmoji(emoji),
      type: typeRaw.trim(),
      category: categoryRaw.trim(),
      subtitle: (subtitleMatch?.[1] ?? block.split("\n")[0] ?? "").trim(),
      why: (whyMatch?.[1] ?? "").trim(),
      suggestion: (suggestionMatch?.[1] ?? "").trim(),
      exampleLang: codeMatch?.[1] ?? "",
      exampleCode: codeMatch?.[2] ?? "",
      confidence: confidenceMatch ? Number(confidenceMatch[1]) : null,
    });
  }

  return { findings, summary: summaryLines.join("\n").trim(), footer };
}
