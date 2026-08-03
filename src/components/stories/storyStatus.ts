import {
  BookText,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  FileText,
  FolderGit2,
  type LucideIcon,
} from "lucide-react";
import type { QualityDimension, QualitySeverity } from "../../lib/gherkin";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { StoryBatchStatus, StoryDraftStatus, StorySourceKind, StoryVerdict } from "../../types/domain";

/**
 * How each batch state is drawn, in one place so the list row and the detail header can never
 * disagree about what "ready" looks like. Mirrors `agentStatus` for the same reason it exists
 * there — and `generating` likewise has no glyph of its own, because it wears the app's
 * `ThinkingOrb` like every other live AI run.
 */
export const BATCH_STATUS: Record<
  StoryBatchStatus,
  { icon: LucideIcon; color: string; labelKey: TranslationKey }
> = {
  draft: { icon: Circle, color: "text-[var(--cf-text-muted)]", labelKey: "stories.statusDraft" },
  generating: { icon: Circle, color: "text-[var(--cf-accent)]", labelKey: "stories.statusGenerating" },
  ready: { icon: CircleCheck, color: "text-[var(--cf-accent)]", labelKey: "stories.statusReady" },
  error: { icon: CircleAlert, color: "text-[var(--cf-danger)]", labelKey: "stories.statusError" },
};

/** Where a story stands with the host. `draft` is the normal state and deliberately quiet —
 * a backlog is mostly unpublished, and colouring the majority state is how a list stops
 * communicating anything. */
export const STORY_STATUS: Record<
  StoryDraftStatus,
  { icon: LucideIcon; color: string; labelKey: TranslationKey }
> = {
  draft: { icon: Circle, color: "text-[var(--cf-text-muted)]", labelKey: "stories.storyDraft" },
  published: { icon: CircleCheck, color: "text-[var(--cf-success)]", labelKey: "stories.storyPublished" },
  error: { icon: CircleAlert, color: "text-[var(--cf-danger)]", labelKey: "stories.storyError" },
};

/** What the documentation came from — shown wherever a batch names its provenance. */
export const SOURCE_KIND: Record<StorySourceKind, { icon: LucideIcon; labelKey: TranslationKey }> = {
  wiki: { icon: BookText, labelKey: "stories.sourceWiki" },
  files: { icon: FolderGit2, labelKey: "stories.sourceFiles" },
  text: { icon: FileText, labelKey: "stories.sourceText" },
};

/**
 * How a verdict about the code is drawn.
 *
 * `unknown` is deliberately *not* red: it is a real answer ("nobody has proven this either way"),
 * and colouring it as a failure would make a run that honestly reported its limits look worse than
 * one that guessed. Red is reserved for `fail`, which is a claim the code contradicts.
 */
export const VERDICT: Record<StoryVerdict, { icon: LucideIcon; color: string; labelKey: TranslationKey }> = {
  pass: { icon: CircleCheck, color: "text-[var(--cf-success)]", labelKey: "qa.verdictPass" },
  partial: { icon: CircleDot, color: "text-[var(--cf-warning)]", labelKey: "qa.verdictPartial" },
  fail: { icon: CircleX, color: "text-[var(--cf-danger)]", labelKey: "qa.verdictFail" },
  unknown: { icon: CircleDashed, color: "text-[var(--cf-text-muted)]", labelKey: "qa.verdictUnknown" },
};

/** How a lint finding is drawn. Errors are the ones that make a criterion unrunnable; warnings are
 * the ones a team can knowingly accept; info is a nudge. */
export const SEVERITY: Record<QualitySeverity, { color: string; labelKey: TranslationKey }> = {
  error: { color: "text-[var(--cf-danger)]", labelKey: "qa.severityError" },
  warn: { color: "text-[var(--cf-warning)]", labelKey: "qa.severityWarn" },
  info: { color: "text-[var(--cf-text-muted)]", labelKey: "qa.severityInfo" },
};

/** The label shown on a finding — the INVEST letter it belongs to, or Gherkin. Naming the letter
 * is what turns "this looks off" into something a refinement session can actually discuss. */
export const DIMENSION: Record<QualityDimension, TranslationKey> = {
  independent: "qa.dimIndependent",
  negotiable: "qa.dimNegotiable",
  valuable: "qa.dimValuable",
  estimable: "qa.dimEstimable",
  small: "qa.dimSmall",
  testable: "qa.dimTestable",
  gherkin: "qa.dimGherkin",
  format: "qa.dimFormat",
};

/** Azure Boards' own priority scale, 1 (critical) to 4 (low). `0` is CodeFlow's own "say nothing",
 * which leaves the field at whatever the work item type defaults to. */
export const PRIORITIES: { value: number; labelKey: TranslationKey }[] = [
  { value: 0, labelKey: "stories.priorityUnset" },
  { value: 1, labelKey: "stories.priority1" },
  { value: 2, labelKey: "stories.priority2" },
  { value: 3, labelKey: "stories.priority3" },
  { value: 4, labelKey: "stories.priority4" },
];

/** The Fibonacci ladder teams actually estimate on, plus "no estimate". Free text would be more
 * flexible and much worse: half the value of a story-point field is that everyone picks from the
 * same short list. */
export const STORY_POINTS = [0, 1, 2, 3, 5, 8, 13, 21];
