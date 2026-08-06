import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ExternalLink, Plus, Trash2, TriangleAlert } from "lucide-react";
import { PRIORITIES, STORY_POINTS, STORY_STATUS } from "./storyStatus";
import {
  CriterionVerdictRow,
  QualityBadge,
  QualityIssues,
  VerdictBadge,
} from "./StoryQualityPanel";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { confirmAction } from "../../state/confirmStore";
import { editsFrom, parseVerdicts, useStoriesStore, type StoryEdits } from "../../state/storiesStore";
import { lintStory } from "../../lib/gherkin";
import { riseDelay } from "../../lib/rise";
import { useT } from "../../state/languageStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import type { StoryDraft } from "../../types/domain";

function sameEdits(a: StoryEdits, b: StoryEdits): boolean {
  return (
    a.title === b.title &&
    a.narrative === b.narrative &&
    a.description === b.description &&
    a.priority === b.priority &&
    a.storyPoints === b.storyPoints &&
    a.originalEstimate === b.originalEstimate &&
    a.tags === b.tags &&
    a.notes === b.notes &&
    a.acceptanceCriteria.length === b.acceptanceCriteria.length &&
    a.acceptanceCriteria.every((c, i) => c === b.acceptanceCriteria[i])
  );
}

/**
 * One user story, as a card that is read collapsed and edited expanded.
 *
 * Collapsed by default: a generation produces eight of these at once, and eight open editors is a
 * wall of textareas nobody reads. What stays visible is what you review a backlog *by* — the title,
 * the "Como… quiero… para…" line, and how many acceptance criteria there are.
 *
 * Edits are saved when a field loses focus rather than on every keystroke or behind a "Save"
 * button: a keystroke-per-write would hit SQLite on every letter, and a button turns "I fixed a
 * typo in nine stories" into nine extra clicks with nine chances to lose one.
 */
export function StoryCard({
  batchId,
  story,
  index,
  selected,
}: {
  batchId: string;
  story: StoryDraft;
  index: number;
  selected: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<StoryEdits>(() => editsFrom(story));

  // The row can be replaced underneath the card — a publish rewrites every story of the batch, and
  // a re-generation replaces the unpublished ones outright. Following the row is only safe while
  // the card is closed; reseeding an open editor would take whatever is being typed with it.
  useEffect(() => {
    if (!open) setDraft(editsFrom(story));
  }, [story, open]);

  const published = story.work_item_id > 0;
  // What the board calls it: Jira's key, or Azure's id with the `#` people put in front of it.
  // Falling back on the id rather than on the key means a story published before this column
  // existed still shows the label it always did.
  const publishedLabel = story.work_item_key || `#${story.work_item_id}`;
  const { icon: StatusIcon, color } = STORY_STATUS[story.status];

  // Linted from what is on screen, not from what is saved: the whole value of a deterministic
  // check is that it answers while the criterion is still being typed. Nothing here touches the
  // database — the save still happens on blur.
  const quality = useMemo(
    () =>
      lintStory({
        ...story,
        title: draft.title,
        narrative: draft.narrative,
        description: draft.description,
        acceptance_criteria: JSON.stringify(draft.acceptanceCriteria),
        priority: draft.priority,
        story_points: draft.storyPoints,
        original_estimate: draft.originalEstimate,
        tags: draft.tags,
        notes: draft.notes,
      }),
    [story, draft],
  );

  // The verdicts, by contrast, come from the saved row and only from it: they are an answer about
  // the text that was actually sent, and the backend drops them the moment that text changes.
  const verdicts = useMemo(() => parseVerdicts(story.verify_criteria), [story.verify_criteria]);

  const commit = () => {
    if (sameEdits(draft, editsFrom(story))) return;
    void useStoriesStore.getState().saveStory(batchId, story.id, draft);
  };

  const patch = (fields: Partial<StoryEdits>) => setDraft((current) => ({ ...current, ...fields }));

  const setCriterion = (i: number, value: string) =>
    patch({ acceptanceCriteria: draft.acceptanceCriteria.map((c, at) => (at === i ? value : c)) });

  return (
    <article
      // Selection is a rail on the left edge, not a fill. Every story in a batch starts selected,
      // so a filled card marked the default state rather than a choice — eight of them turned the
      // list into a block of accent colour that the scores and the open-questions box then had to
      // compete with. The checkbox already says "selected"; the rail just makes it scannable down
      // the column. The 2px left border is on both states so flipping one only recolours it.
      // `index` is the story's place in the batch, which is also its place in the list — so the
      // stagger comes free, without the card having to be told twice where it is.
      style={riseDelay(index)}
      className={`cf-rise rounded-md border border-l-2 bg-[var(--cf-bg)] transition-colors ${
        selected
          ? "border-[var(--cf-border)] border-l-[var(--cf-accent)]"
          : "border-[var(--cf-border)] border-l-[var(--cf-border)]"
      }`}
    >
      <div className="flex items-start gap-2 px-2 py-2">
        <span className="mt-[2px] shrink-0">
          <Checkbox
            checked={selected}
            // A published story can't be in a selection the publish button acts on, so offering it
            // checked would promise something that will not happen.
            disabled={published}
            onChange={() => useStoriesStore.getState().toggleSelected(batchId, story.id)}
          />
        </span>

        <button
          type="button"
          onClick={() => {
            if (open) commit();
            setOpen((wasOpen) => !wasOpen);
          }}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <ChevronRight
            size={13}
            className={`mt-[3px] shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--cf-text-muted)]">
                {index + 1}.
              </span>
              <span className="min-w-0 truncate text-[13px] font-medium text-[var(--cf-text)]">
                {draft.title || t("stories.untitledStory")}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-[var(--cf-text-muted)]">
              {draft.narrative || t("stories.noNarrative")}
            </span>
          </span>
        </button>

        <span className="flex shrink-0 items-center gap-1.5 pt-[2px]">
          <VerdictBadge status={story.verify_status} at={story.verified_at} />
          <QualityBadge quality={quality} />
          <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--cf-text-muted)] dark:bg-white/[0.1]">
            {t("stories.criteriaCount", { n: draft.acceptanceCriteria.length })}
          </span>
          {draft.storyPoints > 0 && (
            <span className="rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--cf-text-muted)] dark:bg-white/[0.1]">
              {t("stories.pointsShort", { n: draft.storyPoints })}
            </span>
          )}
          {published ? (
            <button
              type="button"
              onClick={() => void openExternalUrl(story.work_item_url).catch((e) => pushErrorToast(String(e)))}
              title={t("stories.openWorkItem", { id: publishedLabel })}
              className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--cf-success)] hover:brightness-110"
            >
              <ExternalLink size={9} />
              {publishedLabel}
            </button>
          ) : (
            <StatusIcon size={12} className={color} />
          )}
        </span>
      </div>

      {story.status === "error" && story.last_error && (
        <p className="mx-2 mb-2 flex items-start gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--cf-danger)_35%,transparent)] px-2 py-1 text-[11px] leading-snug text-[var(--cf-danger)]">
          <TriangleAlert size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words">{story.last_error}</span>
        </p>
      )}

      {open && (
        <div className="space-y-2.5 border-t border-[var(--cf-border)] px-3 py-2.5">
          {published && <p className="text-[11px] text-[var(--cf-text-muted)]">{t("stories.editPublishedHint")}</p>}

          {/* What is wrong with the story *as a story* — INVEST, not Gherkin. First, because it is
              the part a refinement session argues about, and because a story that fails "valuable"
              or "small" makes every criterion under it the wrong shape. */}
          <CardField label={t("qa.storyQuality")} hint={t("qa.storyQualityHint")}>
            <QualityIssues quality={quality} />
          </CardField>

          {story.verify_summary && (
            <p className="rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {story.verify_summary}
            </p>
          )}

          <CardField label={t("stories.fieldTitle")}>
            <input
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              onBlur={commit}
              placeholder={t("stories.fieldTitlePlaceholder")}
              className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
            />
          </CardField>

          <CardField label={t("stories.fieldNarrative")} hint={t("stories.fieldNarrativeHint")}>
            <input
              value={draft.narrative}
              onChange={(e) => patch({ narrative: e.target.value })}
              onBlur={commit}
              placeholder={t("stories.fieldNarrativePlaceholder")}
              className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
            />
          </CardField>

          <CardField label={t("stories.fieldDescription")}>
            <textarea
              value={draft.description}
              rows={3}
              onChange={(e) => patch({ description: e.target.value })}
              onBlur={commit}
              className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
            />
          </CardField>

          <CardField
            label={t("stories.fieldCriteria")}
            hint={t("stories.fieldCriteriaHint")}
            action={
              <button
                type="button"
                onClick={() => patch({ acceptanceCriteria: [...draft.acceptanceCriteria, ""] })}
                className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
              >
                <Plus size={11} />
                {t("stories.addCriterion")}
              </button>
            }
          >
            <div className="space-y-1.5">
              {draft.acceptanceCriteria.length === 0 && (
                <p className="text-[11px] text-[var(--cf-text-muted)]">{t("stories.noCriteria")}</p>
              )}
              {draft.acceptanceCriteria.map((criterion, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="mt-2 w-4 shrink-0 text-right text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <textarea
                      value={criterion}
                      rows={4}
                      onChange={(e) => setCriterion(i, e.target.value)}
                      onBlur={commit}
                      placeholder={t("stories.criterionPlaceholder")}
                      className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
                    />
                    {/* Both readings of this exact criterion, directly under it: what is wrong with
                        how it is written, and what the code says about it. Kept next to the text
                        rather than pooled at the bottom — a list that says "criterio 3" makes the
                        reader count boxes to find it. */}
                    <QualityIssues quality={quality} criterion={i} />
                    {verdicts[i] && <CriterionVerdictRow verdict={verdicts[i]} />}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const next = draft.acceptanceCriteria.filter((_, at) => at !== i);
                      setDraft((current) => ({ ...current, acceptanceCriteria: next }));
                      void useStoriesStore
                        .getState()
                        .saveStory(batchId, story.id, { ...draft, acceptanceCriteria: next });
                    }}
                    title={t("stories.removeCriterion")}
                    aria-label={t("stories.removeCriterion")}
                    className="mt-1.5 shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </CardField>

          <div className="grid grid-cols-4 gap-2">
            <CardField label={t("stories.fieldPriority")}>
              <Select
                size="field"
                value={String(draft.priority)}
                ariaLabel={t("stories.fieldPriority")}
                onChange={(value) => {
                  const priority = Number(value);
                  setDraft((current) => ({ ...current, priority }));
                  void useStoriesStore.getState().saveStory(batchId, story.id, { ...draft, priority });
                }}
                options={PRIORITIES.map((p) => ({ value: String(p.value), label: t(p.labelKey) }))}
              />
            </CardField>
            <CardField label={t("stories.fieldPoints")}>
              <Select
                size="field"
                value={String(draft.storyPoints)}
                ariaLabel={t("stories.fieldPoints")}
                onChange={(value) => {
                  const storyPoints = Number(value);
                  setDraft((current) => ({ ...current, storyPoints }));
                  void useStoriesStore.getState().saveStory(batchId, story.id, { ...draft, storyPoints });
                }}
                options={STORY_POINTS.map((points) => ({
                  value: String(points),
                  label: points === 0 ? t("stories.pointsUnset") : String(points),
                }))}
              />
            </CardField>
            {/* Hours, next to the points rather than instead of them: Azure keeps both, and this
                is the number a sprint's capacity is planned against. Typed rather than picked,
                because unlike points there is no agreed ladder of them. */}
            <CardField label={t("stories.fieldEstimate")} hint={t("stories.fieldEstimateHint")}>
              <input
                type="number"
                min={0}
                step={0.5}
                value={draft.originalEstimate > 0 ? String(draft.originalEstimate) : ""}
                placeholder={t("stories.pointsUnset")}
                aria-label={t("stories.fieldEstimate")}
                onChange={(e) => patch({ originalEstimate: Math.max(0, Number(e.target.value) || 0) })}
                onBlur={commit}
                className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] tabular-nums outline-none focus:border-[var(--cf-accent)]"
              />
            </CardField>
            <CardField label={t("stories.fieldTags")} hint={t("stories.fieldTagsHint")}>
              <input
                value={draft.tags}
                onChange={(e) => patch({ tags: e.target.value })}
                onBlur={commit}
                className="w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
              />
            </CardField>
          </div>

          <CardField label={t("stories.fieldNotes")} hint={t("stories.fieldNotesHint")}>
            <textarea
              value={draft.notes}
              rows={2}
              onChange={(e) => patch({ notes: e.target.value })}
              onBlur={commit}
              className="w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
            />
          </CardField>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                void confirmAction(
                  t(published ? "stories.deleteStoryPublishedConfirm" : "stories.deleteStoryConfirm", {
                    name: draft.title || t("stories.untitledStory"),
                  }),
                ).then((ok) => {
                  if (ok) void useStoriesStore.getState().removeStory(batchId, story.id);
                });
              }}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
            >
              <Trash2 size={12} />
              {t("stories.deleteStory")}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function CardField({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {label}
        </label>
        {action}
      </div>
      {children}
      {hint && <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">{hint}</p>}
    </div>
  );
}
