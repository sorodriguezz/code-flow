import { useEffect, useState } from "react";
import { Copy, FileSearch } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { storyBatchPrompt } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import type { StoryBatchPrompt } from "../../types/domain";

function copy(text: string, done: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => useToastStore.getState().pushToast(done, "success"))
    .catch((e: unknown) => pushErrorToast(String(e)));
}

/** One channel of the run, with the text as it was sent and a way to take it somewhere else. */
function PromptBlock({ label, hint, text }: { label: string; hint: string; text: string }) {
  const t = useT();
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {label}
        </h4>
        <span className="ml-auto text-[10px] text-[var(--cf-text-muted)]">
          {t("stories.usedPromptChars", { n: text.length.toLocaleString() })}
        </span>
        <button
          type="button"
          onClick={() => copy(text, t("stories.usedPromptCopied"))}
          title={t("stories.usedPromptCopy")}
          aria-label={t("stories.usedPromptCopy")}
          className="text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
        >
          <Copy size={12} />
        </button>
      </div>
      <Note>{hint}</Note>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] p-2 font-mono text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
        {text}
      </pre>
    </section>
  );
}

/**
 * What this set's stories actually came out of: the standing instructions and this set's own
 * payload, as the model received them.
 *
 * Read-only on purpose, and separate from [`StoryPromptModal`], which edits the workspace template
 * going forward. The question this answers is backwards-looking — "why did it write *that*?" — and
 * an editor is the wrong shape for it: the run has already happened, and the pieces shown here are
 * a snapshot frozen when it did, not the live template that has since been edited.
 *
 * Sets generated before the snapshot existed fall back to today's pieces, which the modal labels as
 * a reconstruction rather than passing off as history.
 */
export function StoryRunPromptModal({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const t = useT();
  const [data, setData] = useState<StoryBatchPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void storyBatchPrompt(batchId)
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((e: unknown) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [batchId]);

  const subtitle = !data
    ? undefined
    : data.generated_at
      ? t("stories.usedPromptRanOn", {
          at: new Date(data.generated_at).toLocaleString(),
          provider: data.provider || "—",
          model: data.model || "—",
        })
      : t("stories.usedPromptNeverRan");

  return (
    <ApiModal
      icon={FileSearch}
      title={t("stories.usedPromptTitle")}
      subtitle={subtitle}
      width="max-w-3xl"
      height="h-[80vh]"
      onClose={onClose}
      footer={
        <>
          {data && (
            <GhostButton
              onClick={() =>
                copy(`${data.prompt}\n\n${data.stdin}`, t("stories.usedPromptCopied"))
              }
            >
              <Copy size={12} />
              {t("stories.usedPromptCopyAll")}
            </GhostButton>
          )}
          <span className="ml-auto">
            <GhostButton onClick={onClose}>{t("common.close")}</GhostButton>
          </span>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {error && <Note tone="warning">{error}</Note>}
        {!data && !error && (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("stories.usedPromptLoading")}</p>
        )}
        {data && (
          <>
            {!data.from_snapshot && <Note tone="warning">{t("stories.usedPromptStale")}</Note>}
            {data.truncated && <Note tone="warning">{t("stories.usedPromptTruncated")}</Note>}
            <PromptBlock
              label={t("stories.usedPromptInstructions")}
              hint={t("stories.usedPromptInstructionsHint")}
              text={data.prompt}
            />
            <PromptBlock
              label={t("stories.usedPromptPayload")}
              hint={t("stories.usedPromptPayloadHint")}
              text={data.stdin}
            />
          </>
        )}
      </div>
    </ApiModal>
  );
}
