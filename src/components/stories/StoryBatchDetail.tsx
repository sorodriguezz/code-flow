import { useMemo, useState } from "react";
import {
  ClipboardList,
  CircleHelp,
  Copy,
  ExternalLink,
  FileCode,
  Gauge,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { OpenQuestionsModal } from "./OpenQuestionsModal";
import { StoryCard } from "./StoryCard";
import { SOURCE_KIND } from "./storyStatus";
import { AiRunLog } from "../ai/AiRunLog";
import { ModelTag } from "../ai/ModelTag";
import { CARD } from "../api/panelChrome";
import { relativeTime } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { ThinkingOrb } from "../common/ThinkingOrb";
import {
  isPublishable,
  parseOpenQuestions,
  parseVerifyProjectIds,
  useStoriesStore,
} from "../../state/storiesStore";
import { confirmAction } from "../../state/confirmStore";
import { featureFileName, lintBatch, parseCriteria, toFeatureFile } from "../../lib/gherkin";
import { useT } from "../../state/languageStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";

/**
 * The open batch: what it was derived from, the stories in it, and the two buttons that matter —
 * generate, and publish.
 *
 * The stories are cards rather than rows because every one of them is *edited* here. That is the
 * point of the screen: a model's proposal is a first draft, and the review it gets before it
 * becomes a work item is the difference between a backlog and a pile of generated text.
 */
export function StoryBatchDetail({ batchId }: { batchId: string }) {
  const t = useT();
  const batch = useStoriesStore((s) => s.batches.find((b) => b.id === batchId) ?? null);
  const stories = useStoriesStore((s) => s.storiesByBatch[batchId]);
  const selection = useStoriesStore((s) => s.selectionByBatch[batchId]);
  const runId = useStoriesStore((s) => s.runByBatch[batchId]);
  const verifyRunId = useStoriesStore((s) => s.verifyRunByBatch[batchId]);
  const runStartedAt = useStoriesStore((s) => s.runStartedAt);
  const generating = runId !== undefined;
  const verifying = verifyRunId !== undefined;
  const publishing = useStoriesStore((s) => s.publishingByBatch[batchId] !== undefined);
  const [showSource, setShowSource] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [runLogOpen, setRunLogOpen] = useState(false);
  const [verifyLogOpen, setVerifyLogOpen] = useState(false);

  const openQuestions = useMemo(
    () => (batch ? parseOpenQuestions(batch.open_questions) : []),
    [batch],
  );
  // The whole set's INVEST/Gherkin read, recomputed from the rows. Cheap (no model, no I/O) and
  // memoised only because it runs over every criterion of every story on each render.
  const quality = useMemo(() => lintBatch(stories ?? []), [stories]);

  if (!batch) {
    return <EmptyState icon={ClipboardList} title={t("stories.selectBatch")} />;
  }

  const list = stories ?? [];
  const selected = selection ?? [];
  const publishableCount = list.filter((story) => story.work_item_id === 0).length;
  const targetReady = isPublishable(batch);
  const verifyRepos = parseVerifyProjectIds(batch.verify_project_ids);
  const canVerify =
    verifyRepos.length > 0 &&
    list.some((story) => parseCriteria(story.acceptance_criteria).length > 0);
  const { icon: SourceIcon } = SOURCE_KIND[batch.source_kind];
  const generatedOn = Boolean(batch.generated_at && batch.provider);

  const generate = () => void useStoriesStore.getState().generate(batchId);

  const copyFeature = () => {
    void navigator.clipboard
      .writeText(toFeatureFile(batch, list))
      .then(() => useToastStore.getState().pushToast(t("qa.featureCopied"), "success"))
      .catch((e: unknown) => pushErrorToast(String(e)));
  };

  // Confirmed every time, not only when it would overwrite: this writes into the user's source
  // tree, and a re-export is meant to replace the previous file — so the click that does it should
  // be the one that says which file.
  const saveFeature = () => {
    void confirmAction(t("qa.saveFeatureConfirm", { name: featureFileName(batch) })).then((ok) => {
      if (!ok) return;
      void useStoriesStore
        .getState()
        .exportFeature(batchId)
        .then((path) => {
          if (path) useToastStore.getState().pushToast(t("qa.featureSaved", { path }), "success");
        });
    });
  };

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-hidden ${CARD}`}>
      <header className="shrink-0 border-b border-[var(--cf-border)] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-text)_5%,transparent)]">
            {generating ? <ThinkingOrb size="sm" /> : <SourceIcon size={13} className="text-[var(--cf-text-muted)]" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-[var(--cf-text)]">
              {batch.title || t("stories.untitled")}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowSource((open) => !open)}
                title={t("stories.toggleSource")}
                className="min-w-0 shrink truncate text-left text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                {batch.source_ref || t(SOURCE_KIND[batch.source_kind].labelKey)}
              </button>
              {/* Which model wrote these stories — the one question the screen could not answer,
                  and the first one worth asking when a set comes back thin, generic or in the
                  wrong language. Frozen on the batch, so it keeps naming the model that actually
                  ran even after the routing in Settings has moved on. Absent until a generation
                  has succeeded: the chip by the Generate button already says what would run. */}
              {generatedOn && (
                <ModelTag
                  providerId={batch.provider}
                  model={batch.model}
                  title={t("stories.generatedWithHint", {
                    when:
                      relativeTime(batch.generated_at, {
                        now: t("ai.justNow"),
                        minutes: t("ai.minutesAgo"),
                        hours: t("ai.hoursAgo"),
                        days: t("ai.daysAgo"),
                      }) || batch.generated_at,
                  })}
                />
              )}
            </span>
          </span>

          {generating ? (
            <HeaderButton onClick={() => void useStoriesStore.getState().stop(batchId)} icon={Square}>
              {t("stories.stop")}
            </HeaderButton>
          ) : (
            <HeaderButton onClick={generate} icon={list.length === 0 ? Sparkles : RefreshCw}>
              {t(list.length === 0 ? "stories.generate" : "stories.regenerate")}
            </HeaderButton>
          )}
          {/* Verification is its own run with its own stop button: it reads a working copy while
              generation reads documentation, and neither has a reason to wait for the other. */}
          {list.length > 0 &&
            (verifying ? (
              <HeaderButton onClick={() => void useStoriesStore.getState().stopVerify(batchId)} icon={Square}>
                {t("stories.stop")}
              </HeaderButton>
            ) : (
              <HeaderButton
                onClick={() => void useStoriesStore.getState().verify(batchId)}
                icon={ShieldCheck}
                disabled={!canVerify}
                title={canVerify ? t("qa.verifyHint") : t("qa.verifyNoRepo")}
              >
                {t("qa.verify")}
              </HeaderButton>
            ))}
          <HeaderButton
            onClick={() => void useStoriesStore.getState().publish(batchId)}
            icon={Upload}
            primary
            disabled={publishing || generating || selected.length === 0 || !targetReady}
            title={
              !targetReady
                ? t("stories.targetIncomplete")
                : selected.length === 0
                  ? t("stories.nothingSelected")
                  : undefined
            }
          >
            {publishing
              ? t("stories.publishing")
              : t("stories.publishN", { n: selected.length })}
          </HeaderButton>
          {/* Off the screen, not out of the record — the same gesture the review and the wiki both
              have. The set exists in the database with every story and every edit in it; this only
              deselects it, and the list on the left is where it is picked back up. No confirmation,
              because there is nothing to lose: unlike the wiki's, which guards an unsaved editor
              buffer, every field here was already written when it lost focus. */}
          <button
            type="button"
            onClick={() => void useStoriesStore.getState().select(null)}
            title={t("stories.closeBatchHint")}
            aria-label={t("stories.closeBatch")}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
          >
            <X size={14} />
          </button>
        </div>

        {/* The exact text the model was given. Collapsed by default and one click away, because
            "why did it write that?" is answered here and nowhere else — the wiki has moved on. */}
        {showSource && (
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] p-2 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
            {batch.source_text}
          </pre>
        )}

        {batch.status === "error" && batch.last_error && (
          <p className="mt-2 flex items-start gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--cf-danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] px-2 py-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">
            <TriangleAlert size={12} className="mt-[2px] shrink-0" />
            <span className="min-w-0 break-words">{batch.last_error}</span>
          </p>
        )}

        {!targetReady && list.length > 0 && (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
            <TriangleAlert size={12} className="mt-[2px] shrink-0 text-[var(--cf-warning)]" />
            <span>{t("stories.targetIncompleteHint")}</span>
          </p>
        )}
      </header>

      {/* What the run is actually doing, while it does it. The header's orb says *that* something is
          happening and nothing more — which is enough on a first generation, where the empty list
          below is already an explanation, but not on a regeneration: there the stories stay on
          screen unchanged, so a spinning glyph in the corner is the only difference between "the
          model is rewriting these" and "nothing happened". This card is the same one the AI panel
          uses, so the answer to "which engine and model" comes from the run's own announcement
          rather than from Settings — per-task routing means those two can differ. */}
      {(generating || verifying) && (
        <div className="shrink-0 space-y-1.5 border-b border-[var(--cf-border)] px-3 py-2">
          {generating && (
            <AiRunLog
              runId={runId}
              running
              startedAt={runId ? (runStartedAt[runId] ?? null) : null}
              label={t(list.length === 0 ? "stories.generatingTitle" : "stories.regeneratingTitle")}
              expanded={runLogOpen}
              onToggle={() => setRunLogOpen((open) => !open)}
            />
          )}
          {/* Verification is its own run, so it gets its own card rather than sharing one — the two
              can be in flight together and a single card would have to pick a winner. */}
          {verifying && (
            <AiRunLog
              runId={verifyRunId}
              running
              startedAt={verifyRunId ? (runStartedAt[verifyRunId] ?? null) : null}
              label={t("stories.verifyingTitle")}
              expanded={verifyLogOpen}
              onToggle={() => setVerifyLogOpen((open) => !open)}
            />
          )}
        </div>
      )}

      {list.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
            <Checkbox
              checked={selected.length > 0 && selected.length === publishableCount}
              indeterminate={selected.length > 0 && selected.length < publishableCount}
              disabled={publishableCount === 0}
              onChange={(checked) => useStoriesStore.getState().selectAll(batchId, checked)}
            />
            {t("stories.selectedOf", { n: selected.length, total: publishableCount })}
          </label>
          {/* The set's INVEST/Gherkin read, next to the counts it qualifies. A backlog of ten
              stories with three unrunnable criteria looks identical to a good one until something
              says so here. */}
          <span
            title={t("qa.batchQualityHint", {
              clean: quality.clean,
              warnings: quality.warnings,
              errors: quality.errors,
            })}
            className={`ml-auto flex items-center gap-1 text-[11px] font-semibold ${
              quality.errors > 0
                ? "text-[var(--cf-danger)]"
                : quality.warnings > 0
                  ? "text-[var(--cf-warning)]"
                  : "text-[var(--cf-success)]"
            }`}
          >
            <Gauge size={12} />
            {t("qa.batchQuality", { score: quality.score })}
          </span>
          <span className="text-[11px] text-[var(--cf-text-muted)]">
            {t("stories.countStories", { n: list.length })}
          </span>
          <ToolbarButton onClick={copyFeature} icon={Copy} title={t("qa.copyFeatureHint")}>
            {t("qa.copyFeature")}
          </ToolbarButton>
          <ToolbarButton
            onClick={saveFeature}
            icon={FileCode}
            disabled={verifyRepos.length === 0}
            title={verifyRepos.length > 0 ? t("qa.saveFeatureHint") : t("qa.verifyNoRepo")}
          >
            {t("qa.saveFeature")}
          </ToolbarButton>
          <ToolbarButton onClick={() => void useStoriesStore.getState().addStory(batchId)} icon={Plus}>
            {t("stories.addStory")}
          </ToolbarButton>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {openQuestions.length > 0 && (
          <section className="mb-3 rounded-md border border-[color-mix(in_oklab,var(--cf-warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--cf-warning)_7%,transparent)] px-3 py-2">
            <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-warning)]">
              <CircleHelp size={12} />
              {t("stories.openQuestions")}
              {/* The way out of the box, next to the thing it is a way out of. Reading the questions
                  and answering them is one movement, and the rail is too far from here for it. */}
              <button
                type="button"
                onClick={() => setAnswering(true)}
                className="ml-auto rounded-md border border-[color-mix(in_oklab,var(--cf-warning)_45%,transparent)] px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-[var(--cf-warning)] hover:bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)]"
              >
                {t("stories.answerThem")}
              </button>
            </h4>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] leading-snug text-[var(--cf-text)]">
              {openQuestions.map((question, i) => (
                <li key={i}>{question}</li>
              ))}
            </ul>
          </section>
        )}

        {/* Nothing here while a generation runs: the run card above is already saying what is
            happening, with the model and the elapsed time behind it. This used to carry its own
            centred "Writing the stories…", which put the same sentence on screen twice. */}
        {list.length === 0 && generating ? null : list.length === 0 ? (
          // The button is the empty state's `action` and not a sibling of it: `EmptyState` is
          // `h-full`, so beside it the message centred itself in the whole scrollport and the
          // button was pushed to the bottom edge, a screen away from the sentence it answers.
          <EmptyState
            icon={Sparkles}
            title={t("stories.noStories")}
            subtitle={t("stories.noStoriesHint")}
            action={
              /* Unconditional: this branch is only reached when the list is empty *and* nothing is
                 generating — the generating case returned null above. */
              <button
                type="button"
                onClick={generate}
                className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <Sparkles size={13} />
                {t("stories.generate")}
              </button>
            }
          />
        ) : (
          <div className="space-y-2">
            {list.map((story, i) => (
              <StoryCard
                key={story.id}
                batchId={batchId}
                story={story}
                index={i}
                selected={selected.includes(story.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Once anything has been published the board is the source of truth, so the footer offers a
          way to it rather than making the user find the work item by number. */}
      {list.some((story) => story.work_item_url) && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <span className="truncate">
            {t("stories.publishedInto", {
              type: batch.work_item_type,
              project: batch.ado_project,
            })}
          </span>
          <button
            type="button"
            onClick={() => {
              const first = list.find((story) => story.work_item_url);
              if (first) void openExternalUrl(first.work_item_url).catch((e) => pushErrorToast(String(e)));
            }}
            className="ml-auto flex shrink-0 items-center gap-1 hover:text-[var(--cf-accent)]"
          >
            <ExternalLink size={11} />
            {t("stories.openInBoards")}
          </button>
        </footer>
      )}

      {answering && <OpenQuestionsModal batchId={batchId} onClose={() => setAnswering(false)} />}
    </div>
  );
}

/** The quieter buttons on the counts row — same affordance as the header's, one step down in
 * weight, because none of them starts a run. */
function ToolbarButton({
  onClick,
  icon: Icon,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  icon: typeof Plus;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--cf-border)] disabled:hover:text-[var(--cf-text-muted)]"
    >
      <Icon size={12} />
      {children}
    </button>
  );
}

function HeaderButton({
  onClick,
  icon: Icon,
  disabled,
  primary,
  title,
  children,
}: {
  onClick: () => void;
  icon: typeof Sparkles;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? "bg-[var(--cf-accent)] text-white hover:brightness-110"
          : "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      }`}
    >
      <Icon size={13} />
      {children}
    </button>
  );
}
