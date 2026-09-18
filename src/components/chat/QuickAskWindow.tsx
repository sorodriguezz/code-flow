import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUpRight, MessagesSquare } from "lucide-react";
import { ChatComposer } from "./ChatComposer";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { ThinkingBlock } from "./ThinkingBlock";
import { AiRunLog } from "../ai/AiRunLog";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { providerCapabilities } from "../../lib/aiProviders";
import type { ChatAttachment } from "../../lib/tauri/chatCommands";
import { EMPTY_CONVERSATION, useConversationStore } from "../../state/conversationStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useT } from "../../state/languageStore";
import { broadcast } from "../../lib/windowBus";

/** The bubble a turn-in-flight is drawn into. Module-level so the memoised bubble is not handed a
 *  fresh object on every chunk. */
const PENDING_SHELL = { role: "assistant" as const, content: "" };

/** The ask box takes no attachments on purpose: it is one question and one answer, gone a few
 *  seconds later, and a file staged in a window that hides on blur is a file the user loses track
 *  of. Attach from the chat workspace, where the conversation is the thing that persists. */
const EMPTY_QUICK_ATTACHMENTS: ChatAttachment[] = [];

/**
 * The quick-ask window: one question, one answer, and nothing else at all.
 *
 * Summoned by a global hotkey over whatever the user was doing, expected to be gone a few seconds
 * later. So it has no sidebar, no header and no model picker — every one of those would be a
 * permanent control on a window whose whole point is that it is temporary, and the routing they
 * would change already has a home in Settings and in the full workspace.
 *
 * # It is a real conversation, not a scratchpad
 *
 * The question asked here creates an ordinary row in the same flat list as everything else, which
 * is the decision worth defending: the alternative — an ephemeral turn that evaporates with the
 * window — throws away the one thing that makes a quick ask worth having twice. Half the value of
 * asking a question in four seconds is finding the answer again on Thursday. "Open in CodeFlow"
 * therefore has something to open, and closing this window loses nothing.
 *
 * # Escape closes, and closing does not cancel
 *
 * A run outlives the window that started it — it is a subprocess in the Rust process, and
 * `aiRunStore` has already broadcast it to the main window's status bar, where it can be watched
 * and stopped. So dismissing this window is genuinely free, which is what lets Escape be bound to
 * it without a confirmation. The turn lands in its conversation whenever it lands.
 */
export function QuickAskWindow() {
  const t = useT();
  const init = useConversationStore((s) => s.init);
  const create = useConversationStore((s) => s.create);
  const send = useConversationStore((s) => s.send);
  const stopTurn = useConversationStore((s) => s.stop);
  const streamingText = useConversationStore((s) => s.streamingText);
  const streamingThinking = useConversationStore((s) => s.streamingThinking);

  /** The conversation this window has asked into, if it has asked yet. Local rather than the
   *  store's `activeId`: the main window's selection is its own business, and a quick ask must not
   *  move what somebody is reading over there. */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const session = useConversationStore(
    (s) => (conversationId ? s.byConversation[conversationId] : undefined) ?? EMPTY_CONVERSATION,
  );

  const [draft, setDraft] = useState("");
  const [logExpanded, setLogExpanded] = useState(false);

  const routedProvider = useTaskProvider("chat");
  const routedModel = useAiProviderStore((s) => s.taskModels.chat ?? s.model);
  const provider = session.provider || routedProvider;
  const model = session.model || routedModel;

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Hidden rather than closed: the window is re-summoned by a hotkey many times a session, and
      // rebuilding a webview each time is the difference between "instant" and "a beat".
      void getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSend = useCallback(
    (message: string) => {
      if (conversationId) {
        send(conversationId, message);
        return;
      }
      // Unbound, which is what makes it read-only: a question asked from a hotkey over an unrelated
      // app has no business holding a lease on a working copy, let alone writing to one.
      void create(null, provider, routedModel).then((id) => {
        if (!id) return;
        setConversationId(id);
        send(id, message);
      });
    },
    [conversationId, send, create, provider, routedModel],
  );

  const onStop = useCallback(() => {
    if (conversationId) stopTurn(conversationId);
  }, [conversationId, stopTurn]);

  const pendingId = session.pendingMessageId;
  const pendingText = pendingId ? (streamingText[pendingId] ?? "") : "";
  const pendingThinking = pendingId ? (streamingThinking[pendingId] ?? "") : "";

  /** The last answer, which is all this window ever shows. A quick ask that grew a scrollback would
   *  be the full workspace with the sidebar missing. */
  const answer = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      if (session.messages[i].role === "assistant") return session.messages[i];
    }
    return null;
  }, [session.messages]);

  const streamsTokens = providerCapabilities(provider).streamsTokens;

  return (
    <div className="flex h-full flex-col bg-[var(--cf-surface)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4">
        {!answer && !session.sending && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessagesSquare size={22} className="text-[var(--cf-text-muted)]" />
            <p className="text-[12px] text-[var(--cf-text-muted)]">
              {t("chat.quickAskTitle")}
            </p>
          </div>
        )}

        {session.sending && (
          <div className="space-y-2">
            {pendingThinking && <ThinkingBlock text={pendingThinking} live />}
            {pendingText && (
              <ChatMessageBubble message={PENDING_SHELL} variant="reading" streamText={pendingText} />
            )}
            {/* The same honest strip the full transcript shows, and here for the sharper version of
                the same reason: five of the six engines produce no text at all until the turn is
                over, and in a window this small an empty rectangle for forty seconds reads as a
                window that failed to open. */}
            <AiRunLog
              runId={session.runId ?? undefined}
              running
              startedAt={session.runStartedAt}
              expanded={logExpanded}
              onToggle={() => setLogExpanded((v) => !v)}
            />
            {!streamsTokens && !pendingText && (
              <p className="text-[10.5px] text-[var(--cf-text-muted)]">{t("chat.noStreamingNotice")}</p>
            )}
          </div>
        )}

        {answer && !session.sending && (
          <ChatMessageBubble
            message={{
              role: answer.role,
              content: answer.content,
              createdAt: answer.createdAt,
              provider: answer.provider ?? undefined,
              model: answer.model ?? undefined,
              isError: answer.isError,
              isCancelled: answer.isCancelled,
            }}
            variant="reading"
          />
        )}
      </div>

      <ChatComposer
        compact
        provider={provider}
        model={model}
        effort={session.effort}
        effortSupported={false}
        attachments={EMPTY_QUICK_ATTACHMENTS}
        sending={session.sending}
        turns={session.messages.length}
        draft={draft}
        onDraftChange={setDraft}
        onSend={onSend}
        onStop={onStop}
        // The `/` menu's app commands all act on a workspace this window does not have — a sidebar
        // to make a new chat in, a settings screen to open, a transcript to export. Rather than
        // offering six rows that would each need a special case here, the menu's own pass-through
        // section is what this window uses, and everything else is one click away through the link
        // below.
        onRunAppCommand={() => {}}
      />

      {conversationId && (
        <button
          type="button"
          onClick={() => {
            // Brings the main window forward and gets out of the way. It deliberately does **not**
            // select this conversation over there, because it cannot: each window holds its own
            // `conversationStore`, and `open()` called here would move a pointer in *this* webview
            // that nothing else reads. Selecting it in the main window needs an addressed message
            // on `windowBus` — the shape `open-diagram` already has — which this feature does not
            // add. The cost of the gap is small and bounded: the flat list is sorted by recency, so
            // the conversation just asked is the first row in the sidebar.
            broadcast({ kind: "focus-main" });
            void getCurrentWindow().hide();
          }}
          className="flex shrink-0 items-center justify-center gap-1 pb-2 text-[10.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <ProviderGlyph providerId={provider} size={10} />
          {t("chat.quickAskOpenFull")}
          <ArrowUpRight size={10} />
        </button>
      )}
    </div>
  );
}
