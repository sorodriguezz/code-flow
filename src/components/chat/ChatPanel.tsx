import { useState } from "react";
import { ArrowUp, ExternalLink, Loader2, Plus, Sparkles, Wrench, X } from "lucide-react";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { usePrStore } from "../../state/prStore";
import { useT } from "../../state/languageStore";

interface Message {
  role: "user" | "assistant";
  content: string;
}

function PrReviewPanel() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const pr = usePrStore((s) => s.selectedPr);
  const reviewText = usePrStore((s) => s.reviewText);
  const reviewLoading = usePrStore((s) => s.reviewLoading);
  const reviewError = usePrStore((s) => s.reviewError);
  const posting = usePrStore((s) => s.posting);
  const posted = usePrStore((s) => s.posted);
  const reviewPr = usePrStore((s) => s.reviewPr);
  const postReview = usePrStore((s) => s.postReview);
  const selectPr = usePrStore((s) => s.selectPr);

  if (!project || !pr) return null;

  const runReview = () => void reviewPr(project.id, pr.id);
  const publish = () => {
    if (!reviewText) return;
    if (!window.confirm(t("chat.confirmPost", { id: pr.id }))) return;
    void postReview(project.id, pr.id, reviewText);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl">
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3">
            <div className="min-w-0 flex-1">
              <p className="mb-0.5 truncate text-[14px] font-semibold">
                #{pr.id} {pr.title}
              </p>
              <p className="text-[12px] text-[var(--cf-text-muted)]">
                {t("chat.prBy", { author: pr.author })} · {t("chat.prBranches", { source: pr.source_branch, target: pr.target_branch })}
              </p>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline"
              >
                <ExternalLink size={10} />
                {t("chat.viewOnAdo")}
              </a>
            </div>
            <button
              onClick={() => selectPr(null)}
              title={t("chat.backToChat")}
              className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={14} />
            </button>
          </div>

          {reviewLoading && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--cf-border)] p-4 text-[13px] text-[var(--cf-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              {t("chat.reviewing")}
            </div>
          )}

          {!reviewLoading && reviewError && (
            <div className="rounded-lg border border-[var(--cf-danger)]/30 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] p-4">
              <p className="text-[13px] text-[var(--cf-danger)]">
                {reviewError.isQuotaExceeded ? t("changes.quotaMessage") : reviewError.message}
              </p>
              {reviewError.isQuotaExceeded && (
                <p className="mt-1 text-[12px] text-[var(--cf-text-muted)]">
                  {reviewError.resetHint
                    ? t("changes.quotaRetry", { hint: reviewError.resetHint })
                    : t("changes.quotaRetryLater")}
                </p>
              )}
            </div>
          )}

          {!reviewLoading && !reviewError && reviewText && (
            <div className="whitespace-pre-wrap rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 text-[13px] leading-relaxed text-[var(--cf-text)]">
              {reviewText}
            </div>
          )}

          {!reviewLoading && !reviewError && !reviewText && (
            <p className="text-[13px] text-[var(--cf-text-muted)]">{t("chat.awaitingReview")}</p>
          )}
        </div>
      </div>

      <div className="border-t border-[var(--cf-border)] p-3">
        <div className="mx-auto flex max-w-2xl items-center justify-end gap-2">
          {reviewText && !reviewLoading && (
            <button
              onClick={publish}
              disabled={posting || posted}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[13px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
            >
              {posting ? <Loader2 size={13} className="animate-spin" /> : null}
              {posted ? t("chat.posted") : posting ? t("chat.posting") : t("chat.postToPr")}
            </button>
          )}
          <button
            onClick={runReview}
            disabled={reviewLoading}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {reviewLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {reviewLoading ? t("chat.reviewing") : reviewText ? t("chat.reviewAgain") : t("chat.reviewWithClaude")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const openSettings = useUiStore((s) => s.openSettings);
  const selectedPr = usePrStore((s) => s.selectedPr);

  const send = () => {
    if (!input.trim()) return;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: input.trim() },
      {
        role: "assistant",
        content: t("chat.notWiredUp"),
      },
    ]);
    setInput("");
  };

  if (selectedPr) return <PrReviewPanel />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
              <Sparkles size={22} />
            </div>
            <p className="text-lg font-semibold">{t("chat.title")}</p>
            <p className="max-w-xs text-[13px] text-[var(--cf-text-muted)]">
              {t("chat.hint")}{" "}
              <button onClick={() => openSettings("context")} className="text-[var(--cf-accent)] underline">
                {t("chat.configure")}
              </button>
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`rounded-lg px-3 py-2 text-[13px] ${
                  m.role === "user"
                    ? "ml-auto max-w-[80%] bg-[var(--cf-accent)] text-white"
                    : "mr-auto max-w-[80%] bg-[var(--cf-surface-raised)] text-[var(--cf-text)]"
                }`}
              >
                {m.content}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--cf-border)] p-3">
        <div className="mx-auto flex max-w-2xl flex-col gap-2 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={t("chat.placeholder")}
            rows={2}
            className="resize-none bg-transparent px-2 py-1 text-[13px] outline-none"
          />
          <div className="flex items-center gap-2 px-1">
            <span className="rounded-md bg-black/[0.05] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
              {t("settings.claude")}
            </span>
            <span className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
              <Wrench size={11} />
              {t("chat.tools")}
            </span>
            <button className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
              <Plus size={13} />
            </button>
            <button
              onClick={send}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--cf-accent)] text-white"
            >
              <ArrowUp size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
