export interface FindingLocation {
  file: string;
  startLine: number;
  endLine: number;
}

export interface AnalysisFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  type: string;
  category: string;
  subtitle: string;
  location: FindingLocation | null;
  why: string;
  suggestion: string;
  exampleLang: string;
  exampleCode: string;
  confidence: number | null;
}

export interface QualityGrades {
  reliability: string;
  security: string;
  maintainability: string;
}

export interface ParsedAnalysis {
  findings: AnalysisFinding[];
  /** Any prose before the first finding heading (e.g. a one-line "looks fine ✅" reply) —
   * also the fallback: if nothing matched the expected format at all, the full raw text
   * ends up here so something reasonable always renders. */
  summary: string;
  footer: string | null;
  /** The model's own A–E self-assessment for this change, parsed from the leading
   * "📈 CALIDAD" line — `null` if it didn't follow that format. */
  grades: QualityGrades | null;
}

const FOOTER_RE = /\n?---\n🤖[^\n]*$/;
const GRADES_RE = /^📈\s*CALIDAD:\s*Fiabilidad=([A-E])\s+Seguridad=([A-E])\s+Mantenibilidad=([A-E])\s*$/m;
const HEADER_RE = /^###\s*(🚨|⚠️|ℹ️)\s*\[([^·\]]+)·([^\]]+)\]\s*([^·]+)·\s*(F-\d+)\s*$/;

function severityFromEmoji(emoji: string): AnalysisFinding["severity"] {
  if (emoji === "🚨") return "critical";
  if (emoji === "⚠️") return "warning";
  return "info";
}

/** Parses "{file}:{startLine}-{endLine}" (or a single "{file}:{line}") from the finding's
 * "📍 Ubicación" field — the file/line this comment gets anchored to when posted to the PR. */
function parseLocation(raw: string | undefined): FindingLocation | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(.+?):(\d+)(?:-(\d+))?\s*$/);
  if (!m) return null;
  const startLine = Number(m[2]);
  const endLine = m[3] ? Number(m[3]) : startLine;
  return { file: m[1].trim(), startLine, endLine };
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

  let grades: QualityGrades | null = null;
  const gradesMatch = text.match(GRADES_RE);
  if (gradesMatch && gradesMatch.index !== undefined) {
    grades = { reliability: gradesMatch[1], security: gradesMatch[2], maintainability: gradesMatch[3] };
    text = (text.slice(0, gradesMatch.index) + text.slice(gradesMatch.index + gradesMatch[0].length)).trim();
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

    const subtitleMatch = block.match(/^([\s\S]*?)\n\n?(?:📍|💭)/);
    const locationMatch = block.match(/📍\s*Ubicaci[oó]n:\s*([^\n]+)/);
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
      location: parseLocation(locationMatch?.[1]),
      why: (whyMatch?.[1] ?? "").trim(),
      suggestion: (suggestionMatch?.[1] ?? "").trim(),
      exampleLang: codeMatch?.[1] ?? "",
      exampleCode: codeMatch?.[2] ?? "",
      confidence: confidenceMatch ? Number(confidenceMatch[1]) : null,
    });
  }

  return { findings, summary: summaryLines.join("\n").trim(), footer, grades };
}

const SEVERITY_EMOJI: Record<AnalysisFinding["severity"], string> = {
  critical: "🚨",
  warning: "⚠️",
  info: "ℹ️",
};

const SEVERITY_DOT: Record<AnalysisFinding["severity"], string> = {
  critical: "🔴",
  warning: "🟡",
  info: "🔵",
};

const SEVERITY_LABEL_ES: Record<AnalysisFinding["severity"], string> = {
  critical: "Crítico",
  warning: "Menor",
  info: "Info",
};

export function locationLabel(location: FindingLocation): string {
  return `${location.file}:${location.startLine}${location.endLine !== location.startLine ? `-${location.endLine}` : ""}`;
}

/** No critical findings = the change is postable/mergeable as far as this review is
 * concerned — computed deterministically rather than asking the model to self-report a
 * pass/fail that might contradict its own findings list. */
export function computeQualityGatePassed(findings: AnalysisFinding[]): boolean {
  return !findings.some((f) => f.severity === "critical");
}

/** Reconstructs one finding as a standalone markdown block — the same shape the model
 * produced for it in the first place, just without the other findings around it, and
 * without the "📍 Ubicación" line (redundant once the comment is anchored to that exact
 * line on the PR). Used to post a PR review as one comment thread per finding instead of one
 * giant comment. */
export function formatFindingAsComment(finding: AnalysisFinding): string {
  const lines = [`### ${SEVERITY_EMOJI[finding.severity]} [${finding.type}] ${finding.category} · ${finding.id}`, "", finding.subtitle];
  if (finding.why) lines.push("", `💭 **Por qué:** ${finding.why}`);
  if (finding.suggestion) lines.push("", `💡 **Sugerencia:** ${finding.suggestion}`);
  if (finding.exampleCode) lines.push("", "🛠️ Ejemplo de solución:", `\`\`\`${finding.exampleLang}`, finding.exampleCode, "```");
  if (finding.confidence !== null) lines.push("", `🎯 Confianza: ${finding.confidence}/100`);
  return lines.join("\n");
}

export interface ReviewCommentInput {
  content: string;
  location: FindingLocation | null;
}

/** The full set of Azure DevOps comment threads for one review: the summary first (Quality
 * Gate + grades + findings table, unanchored), then one thread per finding — anchored to its
 * file/line when the model reported one, a general comment otherwise. */
export function buildReviewComments(parsed: ParsedAnalysis, date: string): ReviewCommentInput[] {
  return [
    { content: formatSummaryComment(parsed, date), location: null },
    ...parsed.findings.map((f) => ({ content: formatFindingAsComment(f), location: f.location })),
  ];
}

/** The instruction text sent to Claude for the "Resolve with AI" action — unlike
 * `formatFindingAsComment` (which omits location because the PR comment is already anchored
 * to that line), this needs the location spelled out since it's the only way Claude knows
 * where to make the edit. */
export function formatFindingAsFixPrompt(finding: AnalysisFinding): string {
  const lines = [`Hallazgo ${finding.id} (${finding.severity}): ${finding.subtitle}`];
  if (finding.location) lines.push(`Ubicación: ${locationLabel(finding.location)}`);
  if (finding.why) lines.push(`Por qué: ${finding.why}`);
  if (finding.suggestion) lines.push(`Sugerencia: ${finding.suggestion}`);
  if (finding.exampleCode) lines.push("Ejemplo de solución:", `\`\`\`${finding.exampleLang}`, finding.exampleCode, "```");
  return lines.join("\n");
}

/** The overview comment posted once per review — Quality Gate + A–E grades + a table linking
 * every posted finding to its file/line, mirroring a standard "PR review summary" format. */
export function formatSummaryComment(parsed: ParsedAnalysis, date: string): string {
  const passed = computeQualityGatePassed(parsed.findings);
  const lines = [`### 📋 Revisión automatizada (pr-review) — ${date}`, "", `🛡️ **Quality Gate:** ${passed ? "✅ PASSED" : "❌ FAILED"}`];
  if (parsed.grades) {
    lines.push(
      `🔵 Fiabilidad **${parsed.grades.reliability}** · 🔒 Seguridad **${parsed.grades.security}** · 🔧 Mantenibilidad **${parsed.grades.maintainability}**`,
    );
  }
  lines.push("");

  if (parsed.findings.length === 0) {
    lines.push(parsed.summary || "✅ No se encontraron problemas en este cambio.");
    return lines.join("\n");
  }

  const bySeverity = (sev: AnalysisFinding["severity"]) => parsed.findings.filter((f) => f.severity === sev).length;
  const counts = (["critical", "warning", "info"] as const)
    .map((sev) => ({ sev, n: bySeverity(sev) }))
    .filter(({ n }) => n > 0)
    .map(({ sev, n }) => `${n} ${SEVERITY_LABEL_ES[sev]}`);
  lines.push(`**Hallazgos posteados:** ${parsed.findings.length} (${counts.join(" · ")})`, "");
  lines.push("| | ID | Hallazgo | Archivo | Confianza |", "|---|---|---|---|---|");
  for (const f of parsed.findings) {
    const loc = f.location ? `\`${locationLabel(f.location)}\`` : "—";
    lines.push(`| ${SEVERITY_DOT[f.severity]} | ${f.id} | ${f.type} / ${f.category} | ${loc} | ${f.confidence ?? "—"} |`);
  }
  return lines.join("\n");
}
