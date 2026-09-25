import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Clock, FilePen, Lock, Square, UsersRound } from "lucide-react";
import { useIsQueued, repoHolder } from "../../lib/repoQueue";
import { resolveAccount } from "../../lib/aiAccounts";
import { ChatMessageBubble, dayDivider } from "../chat/ChatMessageBubble";
import { AiRunLog } from "./AiRunLog";
import { ChatModelPicker } from "./ChatModelPicker";
import { EMPTY_CHAT, engineFor, useChatStore, type ChatEngine } from "../../state/chatStore";
import { EMPTY_CONVERSATIONS, useChatHistoryStore } from "../../state/activityStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/** How far from the bottom still counts as "reading the newest", for following a reply as it lands. */
const STICK_PX = 48;
/** Roughly eight lines; past it the box scrolls instead of eating the transcript. */
const MAX_COMPOSER_HEIGHT = 180;

/**
 * A conversation with the repository, in its own tab.
 *
 * The same turn machinery as before (`send_chat_message` over `activity_log`, which is also what the
 * paired phone reads), with the conversation rather than the project deciding what is shown — and
 * the behaviour the chat workspace already had and this panel lacked:
 *
 * - **Stop is in the composer**, where the hand is, and the run card above does not repeat it.
 * - **It follows the reply only while you are at the bottom.** Reading back no longer gets yanked
 *   down every time a turn lands; a "jump to latest" pill offers the way back instead.
 * - **The draft belongs to the conversation** and outlives the tab switch — and a question stopped
 *   while it was queued comes back into the box rather than vanishing.
 * - **The engine belongs to the conversation.** The chip no longer rewrites the chat routing for
 *   every other chat: a pick applies here, and a conversation stays on the engine it has been
 *   answering on even if the routing changes.
 * - **A busy repository is said before sending**, and what is sent waits its turn instead of being
 *   handed back with a toast.
 */
export function PanelChat({
  tabKey,
  projectId,
  conversationId,
  fresh,
}: {
  tabKey: string;
  projectId: string;
  conversationId: string;
  fresh: boolean;
}) {
  const t = useT();
  const locale = useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US";
  const accountName = useAccountName();
  const session = useChatStore((s) => s.byConversation[conversationId]) ?? EMPTY_CHAT;
  const picked = useChatStore((s) => s.engineByConversation[conversationId]);
  const send = useChatStore((s) => s.send);
  const project = useWorkspaceStore((s) =>
    Object.values(s.projectsByWorkspace)
      .flat()
      .find((p) => p.id === projectId) ?? null,
  );
  const workspaceId = useWorkspaceStore((s) => s.workspaceOfProject(projectId));
  const draft = useAiPanelStore((s) => s.drafts[tabKey] ?? "");
  const setDraft = (text: string) => useAiPanelStore.getState().setDraft(tabKey, text);
  const queued = useIsQueued(session.sending ? session.runId : null);
  const cancelling = useAiRunStore((s) => (session.runId ? (s.cancelling[session.runId] ?? false) : false));

  // Read back from disk when this session has not got it — a conversation reopened from history,
  // or restored with its tab after a restart. A blank new chat has nothing to read.
  useEffect(() => {
    if (!fresh) void useChatStore.getState().ensureLoaded(projectId, conversationId);
  }, [fresh, projectId, conversationId]);

  // A conversation deleted from history while its tab is open has nothing left behind it: forget it
  // and close the tab, rather than keep showing — or re-create on the next message — something gone.
  // Only a *persisted* one is reconciled: a first turn still running, or stopped, has no row by design.
  const conversations = useChatHistoryStore((s) => s.byProject[projectId] ?? EMPTY_CONVERSATIONS);
  const historyLoaded = useChatHistoryStore((s) => s.loaded[projectId] ?? false);
  const loadHistory = useChatHistoryStore((s) => s.load);
  useEffect(() => {
    if (!historyLoaded) void loadHistory(projectId);
  }, [historyLoaded, loadHistory, projectId]);
  useEffect(() => {
    if (!historyLoaded) return;
    const current = useChatStore.getState().byConversation[conversationId];
    if (!current || current.sending || !current.persisted || current.messages.length === 0) return;
    if (conversations.some((c) => c.session_id === conversationId)) return;
    useChatStore.getState().discard(conversationId);
    useAiPanelStore.getState().close(tabKey, workspaceId ?? undefined);
  }, [conversations, historyLoaded, conversationId, tabKey, workspaceId]);

  // A question stopped while queued comes back to where it was typed.
  useEffect(() => {
    if (session.restored === null) return;
    const text = useChatStore.getState().takeRestored(conversationId);
    if (text) setDraft(draft ? `${text}\n${draft}` : text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.restored, conversationId]);

  // ── Engine ────────────────────────────────────────────────────────────────────────────────
  const routedProvider = useTaskProvider("chat");
  const routedModel = useAiProviderStore((s) => s.taskModels.chat ?? s.model);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  const engine = engineFor(session, picked);
  const provider = engine?.provider ?? routedProvider;
  const model = engine?.model ?? routedModel;
  const account =
    picked?.account ?? resolveAccount({ accounts, taskPins, workspaceDefaults, providerDefaults }, provider, "chat", workspaceId);
  const pickEngine = (nextProvider: string, nextModel: string, nextAccount?: string) => {
    const next: ChatEngine = { provider: nextProvider, model: nextModel, account: nextAccount ?? picked?.account ?? null };
    useChatStore.getState().setEngine(conversationId, next);
  };

  // ── Repository lease ──────────────────────────────────────────────────────────────────────
  // Another conversation, an analysis or a fix in this repository holds the one lease a turn needs.
  // Said before sending; what is sent then waits instead of bouncing.
  const activeRuns = useAiRunStore((s) => s.active);
  const holder = useMemo(
    () => (session.sending ? null : repoHolder(projectId)),
    // `activeRuns` is what changes when a holder comes or goes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, session.sending, activeRuns],
  );

  // ── Scrolling ─────────────────────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (atBottom.current) setShowJump(false);
  };
  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setShowJump(false);
  };
  // Opened at the newest turn.
  useLayoutEffect(() => {
    toBottom();
  }, [conversationId]);
  // Follows what is being written only while the reader is at the bottom.
  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
    else setShowJump(true);
  }, [session.messages.length, session.streamText.length, session.sending]);

  // ── Composer ──────────────────────────────────────────────────────────────────────────────
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [draft]);
  const submit = () => {
    const text = draft.trim();
    if (!text || session.sending) return;
    send(projectId, conversationId, text);
    setDraft("");
    useAiPanelStore.getState().markChatStarted(tabKey);
    toBottom();
  };
  const stop = () => {
    if (session.runId) void useAiRunStore.getState().cancel(session.runId);
  };

  const repoName = project?.name ?? "";
  const lastUser = session.messages.map((m) => m.role).lastIndexOf("user");
  const [logExpanded, setLogExpanded] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto px-3 pb-3 pt-2.5">
        <div className="mb-2.5 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <span className="min-w-0 truncate">{repoName}</span>
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_13%,transparent)] px-1.5 py-px text-[10.5px] font-semibold text-[var(--cf-warning)]"
            title={t("assistant.canEditHint", { repo: repoName })}
          >
            <FilePen size={9} />
            {t("assistant.canEdit")}
          </span>
        </div>

        <div className="space-y-2.5">
          {session.messages.map((message, i) => {
            const day = dayDivider(message, session.messages[i - 1], locale);
            return (
              <Fragment key={i}>
                {day && (
                  <div className="flex items-center gap-2 pt-1.5">
                    <div className="h-px flex-1 bg-[var(--cf-border)]" />
                    <span className="text-[10.5px] text-[var(--cf-text-muted)]">{day}</span>
                    <div className="h-px flex-1 bg-[var(--cf-border)]" />
                  </div>
                )}
                {message.accountBreak && (
                  // Where the engine lost the thread: nothing above this line is in its context.
                  <AccountBreak
                    label={t("assistant.accountBreak")}
                    detail={t("assistant.accountBreakHint", {
                      account: accountName(message.accountBreak.provider, message.accountBreak.accountId),
                    })}
                  />
                )}
                <ChatMessageBubble
                  message={message}
                  actions={message.isError ? { onPickModel: (next) => pickEngine(provider, next) } : undefined}
                />
                {queued && i === lastUser && (
                  <p className="flex items-center justify-end gap-1 text-[10.5px] text-[var(--cf-warning)]">
                    <Clock size={10} className="shrink-0" />
                    {queued.holder ? t("assistant.queuedBehind", { holder: queued.holder }) : t("assistant.queuedUnknown")}
                  </p>
                )}
              </Fragment>
            );
          })}
          {session.sending && session.runId && !queued && (
            <>
              {/* The composer carries Stop; the card says what the engine is doing. */}
              <AiRunLog
                runId={session.runId}
                running
                startedAt={session.runStartedAt}
                showStop={false}
                expanded={logExpanded}
                onToggle={() => setLogExpanded((v) => !v)}
              />
              {session.streamText && (
                <ChatMessageBubble message={{ role: "assistant", content: "" }} streamText={session.streamText} />
              )}
            </>
          )}
        </div>
      </div>

      <div className="relative shrink-0 border-t border-[var(--cf-border)] px-2.5 pb-2.5 pt-2">
        {showJump && (
          <button
            onClick={toBottom}
            className="absolute bottom-full left-1/2 z-10 mb-2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2.5 py-1 text-[11px] font-medium text-[var(--cf-text)] shadow-[var(--cf-shadow)]"
          >
            <ArrowDown size={11} />
            {t("chat.jumpToLatest")}
          </button>
        )}
        {holder && !session.sending && (
          <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[var(--cf-warning)]" title={t("assistant.repoLeaseHint")}>
            <Lock size={11} className="shrink-0" />
            <span className="min-w-0 truncate">{t("assistant.repoBusy", { holder })}</span>
          </p>
        )}
        <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5 focus-within:border-[color-mix(in_oklab,var(--cf-accent)_45%,var(--cf-border))]">
          <textarea
            ref={boxRef}
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter breaks the line. Never mid-composition: an input method
              // uses Enter to accept a candidate, and sending then posts half a sentence.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t("assistant.askPlaceholder", { repo: repoName })}
            aria-label={t("assistant.askPlaceholder", { repo: repoName })}
            className="max-h-[180px] resize-none bg-transparent px-1.5 py-1 text-[13px] leading-relaxed outline-none placeholder:text-[var(--cf-text-muted)]"
          />
          <div className="flex items-center gap-1.5 px-0.5">
            <ChatModelPicker
              liveModel={session.model}
              chatActive={session.messages.length > 0}
              bound={{ provider, model, account }}
              onPick={pickEngine}
            />
            <span className="flex-1" />
            {session.sending ? (
              <button
                onClick={stop}
                disabled={cancelling}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--cf-border)] px-2 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)] disabled:opacity-50"
              >
                <Square size={9} className="fill-current" />
                {cancelling ? t("ai.stopping") : t("chat.stop")}
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!draft.trim()}
                title={holder ? t("assistant.sendQueued") : t("chat.send")}
                aria-label={t("chat.send")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))] disabled:opacity-40"
              >
                {holder ? <Clock size={12} /> : <ArrowUp size={13} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The line drawn above the first question another account answered — see `turnsToMessages`. */
function AccountBreak({ label, detail }: { label: string; detail: string }) {
  return (
    <div role="separator" aria-label={`${label}. ${detail}`} title={detail} className="flex items-center gap-2 pt-1.5">
      <div className="h-px flex-1 bg-[color-mix(in_oklab,var(--cf-warning)_40%,transparent)]" />
      <span className="flex min-w-0 items-center gap-1 text-[10.5px] font-medium text-[var(--cf-warning)]">
        <UsersRound size={10} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <div className="h-px flex-1 bg-[color-mix(in_oklab,var(--cf-warning)_40%,transparent)]" />
    </div>
  );
}
