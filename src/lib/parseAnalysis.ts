import type { SavedFinding } from "../types/domain";

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
 * "📍 Ubicación" field — the file/line this comment gets anchored to when posted to the PR.
 * The model markdown-formats file paths/identifiers everywhere else in its output (it isn't
 * told not to here either), so e.g. "`src/foo.ts:24-27`" is just as likely as the plain form
 * the prompt actually asks for — strip that wrapping before matching, or a location that
 * parses to nothing silently falls back to an unanchored comment. */
function parseLocation(raw: string | undefined): FindingLocation | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/[`*_]+/g, "").trim();
  const m = cleaned.match(/^(.+?):(\d+)(?:-(\d+))?\s*$/);
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
    // This helper posts every finding, so the summary describes every finding.
    { content: formatSummaryComment(parsed, date, parsed.findings), location: null },
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

/** The **fix-pack**: the review's findings as an actionable JSON artifact (schema
 * `pr-review-fixpack/v1`) another agent can consume to apply the fixes — fields renamed to action
 * terms (`problema`/`causa`/`correccion`) rather than the review's own. Provider-neutral: it's a
 * string you can copy, export, or post. */
export function buildFixpack(parsed: ParsedAnalysis, prId: number): string {
  const hallazgos = parsed.findings.map((f) => ({
    id: f.id,
    severidad: f.severity,
    tipo: f.type,
    categoria: f.category,
    archivo: f.location?.file ?? null,
    lineas: f.location ? locationLabel(f.location).split(":")[1] ?? null : null,
    problema: f.subtitle,
    causa: f.why,
    correccion: f.suggestion,
    codigo_sugerido: f.exampleCode || null,
    confianza: f.confidence,
  }));
  return JSON.stringify(
    { schema: "pr-review-fixpack/v1", pr: prId, generado: new Date().toISOString(), hallazgos },
    null,
    2,
  );
}

/**
 * The overview comment posted once per review — Quality Gate + A–E grades + a table linking every
 * posted finding to its file/line, mirroring a standard "PR review summary" format.
 *
 * `posted` is what the reviewer actually chose to publish, and it's what the table and the count
 * describe: the summary must not announce findings that were never posted (it says "Hallazgos
 * posteados", and a table of comments nobody can find on the PR is worse than no table).
 *
 * The **Quality Gate and the grades stay computed from the whole review**, deliberately. They
 * judge the change, not the reviewer's selection — a Blocker doesn't stop being a Blocker because
 * it wasn't posted, and letting the gate flip to PASSED by unticking a box would make it a
 * meaningless badge. When the two sets differ, the count says so, so nobody reads a FAILED gate
 * over a one-row table as a contradiction.
 */
/**
 * What the durable review memory adds to a summary that the review text alone can't say: which
 * findings this PR has already *closed* over its iterations, and under what scope and depth the
 * run happened. Read from the saved run (`get_review_run`), so it is the reviewer's own record
 * rather than anything the model reports about itself.
 */
export interface SummaryMemory {
  /** Findings the memory holds as `resuelto` — reported in an earlier iteration, gone in this one. */
  resolved: SavedFinding[];
  /** Which run of this PR this is (1 = first review). */
  iter: number;
  /** `basico` · `completo` · `ultra`. */
  level: string;
  engine: string;
  model: string;
  files: number;
  additions: number;
  deletions: number;
}

/** The lenses each depth actually applies — the same split the backend's level directive makes
 * (`ai.rs`: básico is a Blocker/Crítico triage, completo runs the five main lenses, ultra adds
 * maintainability in depth). Printed in the summary so a reader knows what was *not* looked at. */
const REVIEW_LENSES: Record<string, string[]> = {
  basico: ["correctness", "seguridad", "solo Blocker/Crítico de alta confianza"],
  completo: ["correctness", "seguridad", "rendimiento", "contrato / integridad de datos", "tests"],
  ultra: [
    "correctness",
    "seguridad",
    "rendimiento",
    "contrato / integridad de datos",
    "tests",
    "mantenibilidad a fondo",
  ],
};

/** A stored finding's severity is a free string; anything unrecognized reads as `info` rather than
 * crashing the table it's rendered into. */
function severityOf(raw: string): AnalysisFinding["severity"] {
  return raw === "critical" || raw === "warning" ? raw : "info";
}

export function formatSummaryComment(
  parsed: ParsedAnalysis,
  date: string,
  posted: AnalysisFinding[],
  memory?: SummaryMemory | null,
): string {
  const passed = computeQualityGatePassed(parsed.findings);
  const lines = [`### 📋 Revisión automatizada (pr-review) — ${date}`, "", `🛡️ **Quality Gate:** ${passed ? "✅ PASSED" : "❌ FAILED"}`];
  if (parsed.grades) {
    lines.push(
      `🔵 Fiabilidad **${parsed.grades.reliability}** · 🔒 Seguridad **${parsed.grades.security}** · 🔧 Mantenibilidad **${parsed.grades.maintainability}**`,
    );
  }
  lines.push("");

  // Everything the memory carries as done: what earlier iterations of this same PR reported and
  // this one no longer finds. It's the half of the story the review text can't tell — a clean run
  // looks identical whether the PR never had a defect or had three that were all fixed.
  const resolved = memory?.resolved ?? [];
  const counts = (["critical", "warning", "info"] as const)
    .map((sev) => ({ sev, n: posted.filter((f) => f.severity === sev).length }))
    .filter(({ n }) => n > 0)
    .map(({ sev, n }) => `${n} ${SEVERITY_LABEL_ES[sev]}`);

  if (posted.length === 0 && resolved.length === 0) {
    // Nothing open and nothing on the record: the review's own prose is the whole summary.
    lines.push(
      parsed.findings.length > 0
        ? `La revisión encontró ${parsed.findings.length} hallazgo(s), ninguno de los cuales se publicó como comentario.`
        : parsed.summary || "✅ No se encontraron problemas en este cambio.",
    );
    lines.push(...scopeLines(memory));
    return lines.join("\n");
  }

  const tally: string[] = [];
  if (posted.length > 0) {
    const outOf = posted.length < parsed.findings.length ? ` de ${parsed.findings.length}` : "";
    tally.push(`📌 ${posted.length}${outOf} publicado(s) (${counts.join(" · ")})`);
  }
  if (resolved.length > 0) tally.push(`✔️ ${resolved.length} resuelto(s)`);
  lines.push(`**Hallazgos:** ${tally.join(" · ")}`, "");

  lines.push("| | ID | Hallazgo | Archivo | 🎯 | Estado |", "|---|---|---|---|---|---|");
  for (const f of posted) {
    const loc = f.location ? `\`${locationLabel(f.location)}\`` : "—";
    lines.push(
      `| ${SEVERITY_DOT[f.severity]} | ${f.id} | ${f.type} / ${f.category} | ${loc} | ${f.confidence ?? "—"} | 🔸 Abierto |`,
    );
  }
  // Struck through, because the row is history rather than a request: the reader should see at a
  // glance which lines still need something from them.
  for (const f of resolved) {
    const loc = f.archivo ? `~~\`${f.archivo}${f.lineas ? `:${f.lineas}` : ""}\`~~` : "—";
    const dot = SEVERITY_DOT[severityOf(f.severity)];
    lines.push(
      `| ${dot} | ~~${f.id}~~ | ~~${f.categoria}~~ | ${loc} | ${f.confianza != null ? `~~${f.confianza}~~` : "—"} | ✔️ Resuelto |`,
    );
  }

  lines.push(...scopeLines(memory));
  if (parsed.summary.trim()) lines.push("", parsed.summary.trim());
  if (memory?.engine) {
    lines.push(
      "",
      "---",
      `🤖 _Generado desde la memoria local de revisiones de CodeFlow · Revisor: **${memory.engine}${
        memory.model ? ` (${memory.model})` : ""
      }** · Selección hecha por el humano._`,
    );
  }
  return lines.join("\n");
}

/** What the run actually looked at, and under which lenses — the two lines that turn a verdict
 * into something auditable. Empty when the run predates scope tracking, rather than printing a
 * confident "0 archivos". */
function scopeLines(memory?: SummaryMemory | null): string[] {
  if (!memory) return [];
  const out: string[] = [];
  const scope: string[] = [];
  if (memory.files > 0) {
    scope.push(`${memory.files} archivo(s)`, `+${memory.additions} / -${memory.deletions}`);
  }
  if (memory.iter > 0) scope.push(`iteración ${memory.iter}`);
  if (memory.level) scope.push(`nivel **${memory.level}**`);
  if (scope.length > 0) out.push("", `**Alcance analizado:** ${scope.join(" · ")}`);
  const lenses = REVIEW_LENSES[memory.level];
  if (lenses) out.push(`**Lentes aplicadas:** ${lenses.join(" · ")}`);
  return out;
}
