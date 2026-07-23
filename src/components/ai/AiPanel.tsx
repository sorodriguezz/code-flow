import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  History,
  Loader2,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { renderMarkdown } from "../../lib/markdown";
import { parseAnalysis, buildReviewComments } from "../../lib/parseAnalysis";
import { listPrCommentThreads } from "../../lib/tauri/commands";
import { FindingCard, QualityGateBadges, SHORT_SUMMARY_MAX } from "./FindingCard";
import { PrCommentCard } from "./PrCommentCard";
import {
  mergeActivityEntries,
  entryKey,
  entryTitle,
  entryTimestamp,
  entryVisual,
  findActiveEntryKey,
  type ActivityEntry,
} from "../../lib/activityEntries";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLayoutStore } from "../../state/layoutStore";
import { usePrStore } from "../../state/prStore";
import { useJobsStore, EMPTY_JOBS } from "../../state/jobsStore";
import { useChatStore, EMPTY_CHAT, type ChatMessage } from "../../state/chatStore";
import { useChatHistoryStore, EMPTY_CONVERSATIONS } from "../../state/activityStore";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { AI_PROVIDERS } from "../../lib/aiProviders";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { ResizeHandle } from "../common/ResizeHandle";
import { EmptyState } from "../common/EmptyState";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ActivityModal } from "./ActivityModal";
import { AnalyzeSection } from "./AnalyzeSection";
import type { PullRequestSummary, PrCommentThread } from "../../types/domain";

const PANEL_MIN = 280;
const PANEL_MAX = 520;

function relativeTime(ts: number, t: (key: TranslationKey, vars?: Record<string, string | number>) => string): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return t("ai.justNow");
  if (mins < 60) return t("ai.minutesAgo", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("ai.hoursAgo", { n: hours });
  return t("ai.daysAgo", { n: Math.round(hours / 24) });
}

/** Unified "Activity" list — background jobs (PR review / pre-commit analysis) and past
 * chat conversations combined and sorted by recency, so there's one place to reopen anything
 * Claude has done for this project instead of two separate sections. */
function ActivitySection({ projectId }: { projectId: string }) {
  const t = useT();
  const jobs = useJobsStore((s) => s.byProject[projectId] ?? EMPTY_JOBS);
  const jobsLoaded = useJobsStore((s) => s.loaded[projectId]);
  const loadJobHistory = useJobsStore((s) => s.load);
  const prsByProject = usePrStore((s) => s.prsByProject);
  const selectedPr = usePrStore((s) => s.selectedPr);
  const selectPr = usePrStore((s) => s.selectPr);
  const analyzeOpen = useAnalyzeUiStore((s) => s.open);
  const conversations = useChatHistoryStore((s) => s.byProject[projectId] ?? EMPTY_CONVERSATIONS);
  const chatLoaded = useChatHistoryStore((s) => s.loaded[projectId]);
  const loadChatHistory = useChatHistoryStore((s) => s.load);
  const activeSessionId = useChatStore((s) => s.byProject[projectId]?.sessionId ?? null);
  const switchTo = useChatStore((s) => s.switchTo);
  const [collapsed, setCollapsed] = useState(true);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!chatLoaded) void loadChatHistory(projectId);
    if (!jobsLoaded) void loadJobHistory(projectId);
  }, [projectId, chatLoaded, loadChatHistory, jobsLoaded, loadJobHistory]);

  const entries = useMemo(() => mergeActivityEntries(jobs, conversations), [jobs, conversations]);
  if (entries.length === 0) return null;

  const activeEntryKey = findActiveEntryKey(entries, {
    selectedPrId: selectedPr?.id ?? null,
    analyzeOpen,
    activeSessionId,
  });

  const runningCount = jobs.filter((j) => j.status === "running").length;
  const topFive = entries.slice(0, 5);

  const openEntry = (entry: ActivityEntry) => {
    if (entry.type === "chat") {
      // Clear whatever else the panel might currently be showing — otherwise the chat
      // switches underneath a still-visible PR review or analysis section.
      selectPr(null);
      useAnalyzeUiStore.getState().hide();
      void switchTo(projectId, entry.conv.session_id);
      return;
    }
    if (entry.job.kind === "pr-review") {
      const pr = prsByProject[projectId]?.find((p) => p.id === entry.job.meta.prId);
      if (pr) {
        useAnalyzeUiStore.getState().hide();
        selectPr(pr);
      }
    } else if (entry.job.kind === "analyze-changes") {
      selectPr(null);
      useAnalyzeUiStore.getState().show();
    }
  };

  return (
    <div className="shrink-0 border-b border-[var(--cf-border)]">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)] hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <History size={11} />
        {t("ai.history")}
        {runningCount > 0 && (
          <span className="rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-bold text-[var(--cf-accent)]">
            {runningCount}
          </span>
        )}
        <span className="ml-auto">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-0.5 px-1.5 pb-2">
          {topFive.map((entry) => {
            const { icon: Icon, color, spinning } = entryVisual(entry);
            const isActive = entryKey(entry) === activeEntryKey;
            return (
              <button
                key={entryKey(entry)}
                title={entryTitle(entry)}
                onClick={() => openEntry(entry)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  isActive ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                }`}
              >
                <Icon size={12} className={spinning ? "shrink-0 animate-spin" : "shrink-0"} style={{ color }} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">{entryTitle(entry)}</span>
                <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">
                  {relativeTime(entryTimestamp(entry), t)}
                </span>
              </button>
            );
          })}
          <button
            onClick={() => setShowModal(true)}
            className="w-full rounded-md px-2 py-1 text-center text-[11px] font-medium text-[var(--cf-accent)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            {t("ai.viewAll")}
          </button>
        </div>
      )}
      {showModal && <ActivityModal projectId={projectId} onClose={() => setShowModal(false)} />}
    </div>
  );
}

function PrReviewSection({ projectId, pr }: { projectId: string; pr: PullRequestSummary }) {
  const t = useT();
  const reviewPr = usePrStore((s) => s.reviewPr);
  const postReview = usePrStore((s) => s.postReview);
  const selectPr = usePrStore((s) => s.selectPr);
  const posting = usePrStore((s) => s.posting);
  const posted = usePrStore((s) => s.posted);
  const jobs = useJobsStore((s) => s.byProject[projectId] ?? EMPTY_JOBS);
  const job = useMemo(
    () => jobs.find((j) => j.kind === "pr-review" && j.meta.prId === pr.id) ?? null,
    [jobs, pr.id],
  );

  const loading = job?.status === "running";
  const error = job?.status === "error" ? job.error : null;
  const reviewText = job?.status === "done" ? job.result : null;
  const parsed = useMemo(() => (reviewText ? parseAnalysis(reviewText) : null), [reviewText]);
  const findings = parsed?.findings ?? [];
  const summary = parsed?.summary ?? "";

  // One Azure DevOps comment thread per finding (anchored to its file/line) plus a summary
  // thread with the Quality Gate and a findings table — instead of one comment dumping the
  // whole review.
  const comments = useMemo(() => {
    if (!reviewText || !parsed) return [];
    return buildReviewComments(parsed, new Date().toISOString().slice(0, 10));
  }, [reviewText, parsed]);

  const runReview = () => reviewPr(projectId, pr.id);
  const publish = async () => {
    if (comments.length === 0) return;
    if (!(await confirmAction(t("chat.confirmPost", { id: pr.id, n: comments.length }), false))) return;
    void postReview(projectId, pr.id, comments);
  };

  // Existing comment threads on the PR — e.g. from a human reviewer — refetched fresh every
  // time this PR is opened rather than cached, since they can change outside of CodeFlow at
  // any time (someone replies, resolves a thread, etc.).
  const [openThreads, setOpenThreads] = useState<PrCommentThread[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listPrCommentThreads(projectId, pr.id)
      .then((threads) => {
        if (!cancelled) setOpenThreads(threads);
      })
      .catch(() => {
        if (!cancelled) setOpenThreads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, pr.id]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4">
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3">
          <div className="min-w-0 flex-1">
            <p className="mb-0.5 truncate text-[13px] font-semibold">
              #{pr.id} {pr.title}
            </p>
            <p className="text-[11px] text-[var(--cf-text-muted)]">
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
            {!loading && !error && parsed && (
              <div className="mt-1.5">
                <QualityGateBadges grades={parsed.grades} findings={findings} />
              </div>
            )}
          </div>
          <button
            onClick={() => selectPr(null)}
            title={t("chat.backToChat")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={14} />
          </button>
        </div>

        {openThreads.length > 0 && (
          <div className="mb-4 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("pr.openComments", { n: openThreads.length })}
            </p>
            {openThreads.map((thread) => (
              <PrCommentCard key={thread.id} thread={thread} projectId={projectId} prSourceBranch={pr.source_branch} />
            ))}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-3 rounded-lg border border-[var(--cf-border)] p-4 text-[12px] text-[var(--cf-text-muted)]">
            <ThinkingOrb size="sm" />
            {t("ai.working")}
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-[var(--cf-danger)]/30 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] p-4">
            <p className="text-[12px] text-[var(--cf-danger)]">
              {error.isQuotaExceeded ? t("changes.quotaMessage") : error.message}
            </p>
            {error.isQuotaExceeded && (
              <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">
                {error.resetHint ? t("changes.quotaRetry", { hint: error.resetHint }) : t("changes.quotaRetryLater")}
              </p>
            )}
          </div>
        )}

        {!loading && !error && reviewText && findings.length === 0 && (
          summary.length > SHORT_SUMMARY_MAX ? (
            <div
              className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
            />
          ) : (
            <p className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 text-[12px] leading-relaxed text-[var(--cf-text)]">
              {summary}
            </p>
          )
        )}

        {!loading && !error && reviewText && findings.length > 0 && (
          <div className="space-y-3">
            {summary && (
              <div
                className="cf-markdown-preview rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3.5 py-2.5"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }}
              />
            )}
            <div className="space-y-2">
              {findings.map((finding) => (
                <FindingCard
                  key={finding.id}
                  finding={finding}
                  defaultOpen={finding.severity !== "info"}
                  projectId={projectId}
                  prSourceBranch={pr.source_branch}
                />
              ))}
            </div>
          </div>
        )}

        {!loading && !error && !reviewText && (
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("chat.awaitingReview")}</p>
        )}
      </div>

      <div className="border-t border-[var(--cf-border)] p-3">
        <div className="flex items-center justify-end gap-2">
          {reviewText && !loading && (
            <button
              onClick={publish}
              disabled={posting || posted}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]"
            >
              {posting ? <Loader2 size={12} className="animate-spin" /> : null}
              {posted ? t("chat.posted") : posting ? t("chat.posting") : t("chat.postToPr")}
            </button>
          )}
          <button
            onClick={runReview}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {loading ? t("chat.reviewing") : reviewText ? t("chat.reviewAgain") : t("chat.reviewWithClaude")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Copies `text`, flashing a checkmark for a moment — same "copied" feedback pattern used
 * elsewhere in the app (e.g. the project path copy in Settings). */
function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return [copied, copy];
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const t = useT();
  const [copied, copy] = useCopy();
  const html = useMemo(
    () => (message.role === "assistant" ? renderMarkdown(message.content) : null),
    [message.role, message.content],
  );

  return (
    <div
      className={`group relative rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed ${
        message.role === "user"
          ? "ml-auto max-w-[85%] whitespace-pre-wrap bg-[var(--cf-accent)] text-white"
          : "mr-auto max-w-[85%] bg-[color-mix(in_oklab,var(--cf-accent)_6%,var(--cf-surface))] text-[var(--cf-text)]"
      }`}
    >
      {html !== null ? (
        <div className="cf-markdown-preview cf-markdown-chat" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        message.content
      )}
      <button
        onClick={() => copy(message.content)}
        title={t("chat.copyMessage")}
        className={`absolute -top-2 flex h-5 w-5 items-center justify-center rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] opacity-0 shadow-sm group-hover:opacity-100 ${
          message.role === "user" ? "-left-2" : "-right-2"
        }`}
      >
        {copied ? <Check size={11} className="text-[var(--cf-success)]" /> : <Copy size={11} className="text-[var(--cf-text-muted)]" />}
      </button>
    </div>
  );
}

function ChatSection({ projectId }: { projectId: string }) {
  const t = useT();
  const chat = useChatStore((s) => s.byProject[projectId] ?? EMPTY_CHAT);
  const send = useChatStore((s) => s.send);
  const clearChat = useChatStore((s) => s.clear);
  const providerId = useAiProviderStore((s) => s.providerId);
  const provider = AI_PROVIDERS.find((p) => p.id === providerId) ?? AI_PROVIDERS[0];
  const providerLabel = provider.labelKey ? t(provider.labelKey) : provider.label;
  const [input, setInput] = useState("");
  const openSettings = useUiStore((s) => s.openSettings);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedAll, copyAll] = useCopy();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages.length, chat.sending]);

  const submit = () => {
    if (!input.trim() || chat.sending) return;
    send(projectId, input);
    setInput("");
  };

  const copyConversation = () => {
    const transcript = chat.messages
      .map((m) => `${m.role === "user" ? t("chat.you") : t("chat.title")}: ${m.content}`)
      .join("\n\n");
    copyAll(transcript);
  };

  return (
    <div className="flex h-full flex-col">
      {chat.messages.length > 0 && (
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-[var(--cf-border)] px-2 py-1">
          <button
            onClick={() => clearChat(projectId)}
            title={t("chatHistory.newChat")}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <Plus size={11} />
            {t("chatHistory.newChat")}
          </button>
          <button
            onClick={copyConversation}
            title={t("chat.copyAll")}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {copiedAll ? <Check size={11} className="text-[var(--cf-success)]" /> : <Copy size={11} />}
            {copiedAll ? t("chat.copied") : t("chat.copyAll")}
          </button>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-auto p-4">
        {chat.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
              <Sparkles size={18} />
            </div>
            <p className="text-[14px] font-semibold">{t("chat.title")}</p>
            <p className="max-w-[220px] text-[12px] text-[var(--cf-text-muted)]">
              {t("chat.hint")}{" "}
              <button onClick={() => openSettings("context")} className="text-[var(--cf-accent)] underline">
                {t("chat.configure")}
              </button>
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {chat.messages.map((m, i) => (
              <ChatBubble key={i} message={m} />
            ))}
            {chat.sending && (
              <div className="mr-auto flex max-w-[85%] items-center gap-2 rounded-lg bg-[var(--cf-surface-raised)] px-2.5 py-1.5">
                <ThinkingOrb size="sm" />
                <span className="text-[11px] text-[var(--cf-text-muted)]">{t("ai.working")}</span>
              </div>
            )}
            {chat.error && (
              <div className="rounded-lg border border-[var(--cf-danger)]/30 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] p-2.5">
                <p className="text-[11px] text-[var(--cf-danger)]">
                  {chat.error.isQuotaExceeded ? t("changes.quotaMessage") : chat.error.message}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--cf-border)] p-2.5">
        <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t("chat.placeholder")}
            rows={2}
            className="resize-none bg-transparent px-1.5 py-1 text-[12px] outline-none"
          />
          <div className="flex items-center gap-1.5 px-0.5">
            <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[10px] text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
              {providerLabel}
            </span>
            <button
              onClick={submit}
              disabled={!input.trim() || chat.sending}
              className="ml-auto flex h-5 w-5 items-center justify-center rounded-md bg-[var(--cf-accent)] text-white disabled:opacity-40"
            >
              {chat.sending ? <Loader2 size={12} className="animate-spin" /> : <ArrowUp size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Rendered by App.tsx inside an `AnimatePresence` so mount/unmount slides the panel in/out
 * instead of popping — width is what's animated, so the resize handle's own drag updates
 * (which set inline width directly) aren't fighting a CSS transition mid-drag. */
export function AiPanel() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const selectedPr = usePrStore((s) => s.selectedPr);
  const analyzeOpen = useAnalyzeUiStore((s) => s.open);
  const toggle = useUiStore((s) => s.toggleAiPanel);
  const width = useLayoutStore((s) => s.sizes.aiPanelWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex shrink-0 overflow-hidden"
    >
      <ResizeHandle
        axis="x"
        value={width}
        min={PANEL_MIN}
        max={PANEL_MAX}
        invert
        onChange={(w) => setSize("aiPanelWidth", w)}
        onCommit={(w) => commitSize("aiPanelWidth", w)}
      />
      <aside
        style={{ width }}
        className="flex shrink-0 flex-col overflow-hidden border-l border-[var(--cf-border)] bg-[var(--cf-surface)]"
      >
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-3">
          <Sparkles size={13} className="text-[var(--cf-accent)]" />
          <span className="text-[12px] font-semibold">{t("chat.title")}</span>
          <button
            onClick={toggle}
            title={t("ai.closePanel")}
            className="ml-auto flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <X size={13} />
          </button>
        </div>
        {!project ? (
          <EmptyState icon={Sparkles} title={t("ai.noProject")} />
        ) : (
          <>
            <ActivitySection projectId={project.id} />
            <div className="min-h-0 flex-1">
              {selectedPr ? (
                <PrReviewSection projectId={project.id} pr={selectedPr} />
              ) : analyzeOpen ? (
                <AnalyzeSection projectId={project.id} />
              ) : (
                <ChatSection projectId={project.id} />
              )}
            </div>
          </>
        )}
      </aside>
    </motion.div>
  );
}
