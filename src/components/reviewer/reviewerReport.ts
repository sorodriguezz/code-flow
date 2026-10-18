import type { Translate } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ReviewerQuality, ReviewerRunSummary, ReviewerSeverity } from "../../lib/tauri/reviewerCommands";

/**
 * A review as a document to hand on: the verdict and why, the numbers, the failing tests, every
 * issue and hotspot, the least covered files. Written as Markdown — the notes exporter turns it into
 * the HTML page or the PDF (`lib/notes/exportNotes`), so a report looks like any other exported
 * document of the app and needs no layout engine of its own.
 */

const QUALITY: Record<ReviewerQuality, TranslationKey> = {
  reliability: "reviewer.qualityReliability",
  security: "reviewer.qualitySecurity",
  maintainability: "reviewer.qualityMaintainability",
};

const SEVERITY: Record<ReviewerSeverity, TranslationKey> = {
  blocker: "reviewer.severityBlocker",
  high: "reviewer.severityHigh",
  medium: "reviewer.severityMedium",
  low: "reviewer.severityLow",
  info: "reviewer.severityInfo",
};

/** A table cell: no pipes or line breaks to end it early. */
function cell(text: string | number | null | undefined): string {
  return String(text ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function percent(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} %`;
}

function table(head: string[], rows: (string | number | null | undefined)[][]): string {
  if (rows.length === 0) return "";
  const line = (values: (string | number | null | undefined)[]) => `| ${values.map(cell).join(" | ")} |`;
  return [line(head), `| ${head.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n");
}

export function reportTitle(t: Translate, projectName: string): string {
  return t("reviewer.report.title", { project: projectName });
}

export function reviewReportMarkdown(t: Translate, summary: ReviewerRunSummary): string {
  const parts: string[] = [];
  const verdict =
    summary.status === "passed"
      ? t("reviewer.verdictPassed")
      : summary.status === "failed"
        ? t("reviewer.verdictFailed")
        : summary.status === "cancelled"
          ? t("reviewer.verdictCancelled")
          : t("reviewer.verdictError");
  parts.push(
    [
      `**${t("reviewer.report.verdict")}:** ${verdict}`,
      `**${t("reviewer.report.date")}:** ${new Date(summary.finishedAt).toLocaleString()}`,
      summary.commit ? `**${t("reviewer.report.commit")}:** ${summary.branch ? `${summary.branch} · ` : ""}${summary.commit}${summary.dirty ? ` (${t("reviewer.report.dirty")})` : ""}` : null,
      `**SonarQube:** ${summary.sonarqubeVersion}`,
    ]
      .filter(Boolean)
      .join("  \n"),
  );

  const conditions = summary.gate?.conditions ?? [];
  if (conditions.length > 0) {
    parts.push(`## ${t("reviewer.report.gate")}`);
    parts.push(
      table(
        [t("reviewer.report.metric"), t("reviewer.report.value"), t("reviewer.report.threshold"), t("reviewer.report.status")],
        conditions.map((c) => [c.metric, c.actual, `${c.comparator === "LT" ? "≥" : "≤"} ${c.threshold}`, c.status === "ERROR" ? "✗" : "✓"]),
      ),
    );
  }

  const m = summary.measures;
  parts.push(`## ${t("reviewer.report.measures")}`);
  parts.push(
    table(
      [t("reviewer.report.metric"), t("reviewer.report.value")],
      [
        [t("reviewer.qualityReliability"), `${m.reliabilityRating ?? "—"} · ${t("reviewer.issuesCount", { n: m.reliabilityIssues ?? 0 })}`],
        [t("reviewer.qualitySecurity"), `${m.securityRating ?? "—"} · ${t("reviewer.issuesCount", { n: m.securityIssues ?? 0 })}`],
        [t("reviewer.qualityMaintainability"), `${m.maintainabilityRating ?? "—"} · ${t("reviewer.issuesCount", { n: m.maintainabilityIssues ?? 0 })}`],
        [t("reviewer.metricCoverage"), percent(m.coverage)],
        [t("reviewer.metricDuplication"), percent(m.duplicatedLinesDensity)],
        [t("reviewer.report.lines"), m.ncloc?.toLocaleString() ?? "—"],
      ],
    ),
  );

  const tests = summary.tests;
  if (tests && tests.files > 0) {
    parts.push(`## ${t("reviewer.tabTests")}`);
    parts.push(t("reviewer.testsSummary", { passed: tests.passed, failed: tests.failed, skipped: tests.skipped, duration: `${Math.round(tests.durationMs / 100) / 10} s` }));
    if (tests.failures.length > 0) {
      parts.push(
        table(
          [t("reviewer.report.test"), t("reviewer.report.message")],
          tests.failures.map((f) => [`${f.suite ? `${f.suite} › ` : ""}${f.name}`, f.message]),
        ),
      );
    }
  }

  parts.push(`## ${t("reviewer.tabIssues")} (${summary.issuesTotal})`);
  parts.push(
    summary.issues.length === 0
      ? t("reviewer.report.none")
      : table(
          [t("reviewer.report.severity"), t("reviewer.report.quality"), t("reviewer.report.file"), t("reviewer.report.message"), t("reviewer.report.rule")],
          summary.issues.map((i) => [t(SEVERITY[i.severity]), t(QUALITY[i.quality]), `${i.path}${i.line ? `:${i.line}` : ""}`, i.message, i.rule]),
        ),
  );
  if (summary.issuesTotal > summary.issues.length) parts.push(t("reviewer.moreIssues", { n: summary.issuesTotal - summary.issues.length }));

  const hotspots = summary.hotspots ?? [];
  if (hotspots.length > 0) {
    parts.push(`## ${t("reviewer.tabHotspots")} (${hotspots.length})`);
    parts.push(
      table(
        [t("reviewer.report.probability"), t("reviewer.report.status"), t("reviewer.report.file"), t("reviewer.report.message"), t("reviewer.report.rule")],
        hotspots.map((h) => [
          h.probability,
          h.status === "TO_REVIEW" ? t("reviewer.hotspotToReview") : (h.resolution ?? h.status),
          `${h.path}${h.line ? `:${h.line}` : ""}`,
          h.message,
          h.rule,
        ]),
      ),
    );
  }

  const files = summary.coverage.filter((c) => c.isFile && (c.linesToCover ?? 0) > 0);
  if (files.length > 0) {
    parts.push(`## ${t("reviewer.worstFiles")}`);
    parts.push(
      table(
        [t("reviewer.report.file"), t("reviewer.metricCoverage"), t("reviewer.report.uncovered")],
        files.map((f) => [f.path, percent(f.coverage), f.uncoveredLines ?? 0]),
      ),
    );
  }

  return parts.filter((part) => part.trim()).join("\n\n") + "\n";
}
