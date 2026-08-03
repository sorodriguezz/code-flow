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
} from "lucide-react";
import { StoryCard } from "./StoryCard";
import { SOURCE_KIND } from "./storyStatus";
import { CARD } from "../api/panelChrome";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { isPublishable, parseOpenQuestions, useStoriesStore } from "../../state/storiesStore";
import { confirmAction } from "../../state/confirmStore";
import { featureFileName, lintBatch, parseCriteria, toFeatureFile } from "../../lib/gherkin";
import { useT } from "../../state/languageStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";

/** How many stories a re-generation asks for. A hint, not a rule — the prompt says so, and the
 * model is told to prioritise covering the documentation over hitting the number. */
const DEFAULT_COUNT = 8;

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
  const generating = useStoriesStore((s) => s.runByBatch[batchId] !== undefined);
  const verifying = useStoriesStore((s) => s.verifyRunByBatch[batchId] !== undefined);
  const publishing = useStoriesStore((s) => s.publishingBatchId === batchId);
  const [showSource, setShowSource] = useState(false);

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
  const canVerify =
    Boolean(batch.verify_project_id) &&
    list.some((story) => parseCriteria(story.acceptance_criteria).length > 0);
  const { icon: SourceIcon } = SOURCE_KIND[batch.source_kind];

  const generate = () => void useStoriesStore.getState().generate(batchId, DEFAULT_COUNT);

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
            <button
              type="button"
              onClick={() => setShowSource((open) => !open)}
              title={t("stories.toggleSource")}
              className="block max-w-full truncate text-left text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              {batch.source_ref || t(SOURCE_KIND[batch.source_kind].labelKey)}
            </button>
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
            disabled={!batch.verify_project_id}
            title={batch.verify_project_id ? t("qa.saveFeatureHint") : t("qa.verifyNoRepo")}
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
            </h4>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] leading-snug text-[var(--cf-text)]">
              {openQuestions.map((question, i) => (
                <li key={i}>{question}</li>
              ))}
            </ul>
          </section>
        )}

        {list.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <EmptyState
              icon={Sparkles}
              title={t(generating ? "stories.generatingTitle" : "stories.noStories")}
              subtitle={t(generating ? "stories.generatingHint" : "stories.noStoriesHint")}
            />
            {!generating && (
              <button
                type="button"
                onClick={generate}
                className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <Sparkles size={13} />
                {t("stories.generate")}
              </button>
            )}
          </div>
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
