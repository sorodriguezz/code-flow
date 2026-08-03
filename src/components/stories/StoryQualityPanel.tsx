import { CircleCheck, FlaskConical, Gauge } from "lucide-react";
import { DIMENSION, SEVERITY, VERDICT } from "./storyStatus";
import { useT } from "../../state/languageStore";
import type { QualityIssue, StoryQuality } from "../../lib/gherkin";
import type { CriterionVerdict, StoryVerdict } from "../../types/domain";

/**
 * The QA read of one story: how well it is written (INVEST + Gherkin, decided here) and whether
 * the code already satisfies it (decided by a model, against the repository).
 *
 * The two are drawn side by side on purpose. A story can be beautifully written and unimplemented,
 * or implemented and untestable, and those are opposite problems with opposite owners — the first
 * belongs to refinement, the second to the sprint. Merging them into one "health" number would
 * hide exactly the distinction that makes the panel useful.
 */

/** Where a score sits. Thresholds rather than a gradient: a backlog is triaged, not graded, and
 * three buckets is what a person can act on at a glance. */
function scoreTone(level: StoryQuality["level"]): string {
  if (level === "error") return "text-[var(--cf-danger)]";
  if (level === "warn") return "text-[var(--cf-warning)]";
  return "text-[var(--cf-success)]";
}

const PILL =
  "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap";

/** The INVEST/Gherkin score as it appears on a collapsed card. */
export function QualityBadge({ quality }: { quality: StoryQuality }) {
  const t = useT();
  const problems = quality.issues.filter((issue) => issue.severity !== "info").length;
  return (
    <span
      title={
        problems === 0
          ? t("qa.badgeClean")
          : t("qa.badgeProblems", { n: problems, score: quality.score })
      }
      className={`${PILL} bg-black/[0.06] dark:bg-white/[0.1] ${scoreTone(quality.level)}`}
    >
      <Gauge size={9} />
      {quality.score}
    </span>
  );
}

/** The verdict of the last check against the code, as it appears on a collapsed card. Absent
 * entirely when nothing has been checked — an empty state here would just be noise on every card
 * of every set that has never run a verification. */
export function VerdictBadge({ status, at }: { status: StoryVerdict | ""; at: string }) {
  const t = useT();
  if (!status) return null;
  const { icon: Icon, color, labelKey } = VERDICT[status];
  return (
    <span
      title={at ? t("qa.verifiedAt", { at: new Date(at).toLocaleString() }) : t(labelKey)}
      className={`${PILL} bg-black/[0.06] dark:bg-white/[0.1] ${color}`}
    >
      <Icon size={9} />
      {t(labelKey)}
    </span>
  );
}

/** One lint finding: severity dot, the INVEST letter (or Gherkin) it belongs to, and what to do. */
function IssueRow({ issue }: { issue: QualityIssue }) {
  const t = useT();
  const { color } = SEVERITY[issue.severity];
  return (
    <li className="flex items-start gap-1.5 text-[11px] leading-snug">
      <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-current ${color}`} />
      <span className="min-w-0">
        <span className="mr-1 font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t(DIMENSION[issue.dimension])}
        </span>
        <span className="text-[var(--cf-text)]">{t(issue.messageKey, issue.params)}</span>
      </span>
    </li>
  );
}

/**
 * The findings for a story, or for one of its criteria.
 *
 * `criterion` selects: `undefined` shows only what is wrong with the story as a whole, a number
 * shows only what is wrong with that criterion. Each finding is therefore shown exactly once, next
 * to the text it is about — a single flat list at the bottom of the card would make the reader
 * match "criterio 3" back up by counting boxes.
 */
export function QualityIssues({
  quality,
  criterion,
}: {
  quality: StoryQuality;
  criterion?: number;
}) {
  const t = useT();
  const issues = quality.issues.filter((issue) => issue.criterion === criterion);
  if (issues.length === 0) {
    // Only the story-level list says "nothing to report": on a criterion, silence is the message.
    if (criterion !== undefined) return null;
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-[var(--cf-success)]">
        <CircleCheck size={11} />
        {t("qa.noIssues")}
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {issues.map((issue, i) => (
        <IssueRow key={i} issue={issue} />
      ))}
    </ul>
  );
}

/**
 * What the code says about one criterion: the verdict, the files that back it, and whether a test
 * already covers it.
 *
 * The evidence is shown in full rather than behind a tooltip because it is the only thing that
 * makes a verdict checkable. A `pass` nobody can trace to a file is a claim; a `pass` with
 * `src/pago/checkout.ts:120` under it is something QA can open and disagree with.
 */
export function CriterionVerdictRow({ verdict }: { verdict: CriterionVerdict }) {
  const t = useT();
  const { icon: Icon, color, labelKey } = VERDICT[verdict.verdict] ?? VERDICT.unknown;
  return (
    <div className="mt-1 rounded-md border border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-text)_3%,transparent)] px-2 py-1.5">
      <p className={`flex items-center gap-1.5 text-[11px] font-semibold ${color}`}>
        <Icon size={11} className="shrink-0" />
        {t(labelKey)}
        {verdict.covered_by_test && (
          <span
            title={t("qa.coveredByTestHint")}
            className="ml-auto flex items-center gap-1 rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--cf-text-muted)] dark:bg-white/[0.1]"
          >
            <FlaskConical size={9} />
            {t("qa.coveredByTest")}
          </span>
        )}
      </p>
      {verdict.note && (
        <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{verdict.note}</p>
      )}
      {verdict.evidence.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {verdict.evidence.map((reference, i) => (
            <li key={i} className="truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
              {reference}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
