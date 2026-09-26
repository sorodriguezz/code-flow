import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import { AiRunLog } from "../ai/AiRunLog";
import {
  ChatMessageBubble,
  dayDivider,
  type ChatBubbleActions,
  type ChatBubbleMessage,
} from "./ChatMessageBubble";
import { ThinkingBlock } from "./ThinkingBlock";
import { SelectionActions } from "./SelectionActions";
import { CompactionMark } from "./CompactionMark";
import { COLUMN_GUTTER, READING_COLUMN, useLocale } from "./chatChrome";
import { providerCapabilities } from "../../lib/aiProviders";
import { diagnoseRun, serviceOnPort } from "../../lib/runDiagnosis";
import { useAiRunStore } from "../../state/aiRunStore";
import { useT } from "../../state/languageStore";
import type { ChatOutput } from "../../lib/tauri/chatCommands";
import { EMPTY_CONVERSATION, useConversationStore } from "../../state/conversationStore";
import type { ConversationMessage } from "../../state/conversationStore";

/**
 * How far from the bottom still counts as "at the bottom".
 *
 * Not zero, and the margin is load-bearing. Sub-pixel layout, a scrollbar that appears mid-turn and
 * an image finishing its decode all leave `scrollHeight - scrollTop - clientHeight` at two or three
 * pixels when the view is visually pinned to the tail, and a strict comparison would read every one
 * of those as "the user scrolled up" and stop following. Forty pixels is under one line of body
 * text, so nothing a person could deliberately scroll to falls inside it.
 */
const STICK_THRESHOLD = 40;

/**
 * The transcript.
 *
 * # The auto-scroll, which is the whole component
 *
 * Getting this wrong is the single most irritating bug a chat UI can have, and it has exactly two
 * failure modes, both of which come from the same mistake: treating "follow the tail" as a property
 * of the *messages* rather than of the *reader*.
 *
 * - Always scrolling means a user reading back through a long answer is yanked to the bottom every
 *   time another hundred tokens land. There is no recovery: scroll up, lose it, scroll up, lose it.
 * - Never scrolling means the reply writes itself off-screen and the user has to chase it down.
 *
 * So the state here is one boolean — *is the reader at the bottom* — and it is derived from where
 * the container actually is, on every scroll event, rather than from which gesture caused it. That
 * choice is what makes this robust: a programmatic `scrollTo` fires `scroll` just like a wheel does,
 * and code that tried to tell them apart (a flag set around the call, a timestamp, a wheel listener)
 * has to be right about event ordering in every browser and is wrong the first time a scroll is
 * interrupted. Measuring the position instead cannot disagree with itself — after a scroll to the
 * bottom the distance is zero, so the boolean stays true without anyone having to remember to
 * restore it.
 *
 * The pill is the other half. Stopping the auto-scroll without offering a way back would trade an
 * irritating bug for a stranding one, and it carries the *reason* it appeared — there is new
 * content down there — rather than being a permanent "scroll down" affordance.
 */
export function ChatTranscript({
  onEditRequest,
  onQuoteReply,
  onQuoteNewChat,
}: {
  /** Puts a past user turn back in the composer for editing. Lives in `ChatView` because the
   *  composer is a sibling, not a child — the transcript knows which turn, not where the caret is. */
  onEditRequest: (turn: number, content: string) => void;
  /** Quotes a selected passage into this conversation's composer. Same division of labour as
   *  `onEditRequest`: the transcript knows what was selected, `ChatView` owns the draft. */
  onQuoteReply: (passage: string) => void;
  /** Carries a selected passage into a conversation that does not exist yet. */
  onQuoteNewChat: (passage: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const activeId = useConversationStore((s) => s.activeId);
  const session = useConversationStore(
    (s) => (s.activeId ? s.byConversation[s.activeId] : undefined) ?? EMPTY_CONVERSATION,
  );
  const streamingText = useConversationStore((s) => s.streamingText);
  const streamingThinking = useConversationStore((s) => s.streamingThinking);
  const skipReveal = useConversationStore((s) => s.skipReveal);
  /** The live log of the turn in flight, read for a failure the run is stuck in rather than for
   *  display — `AiRunLog` already draws the lines themselves. */
  const liveLines = useAiRunStore((s) => (session.runId ? s.linesByRun[session.runId] : undefined));
  const diagnosis = useMemo(() => diagnoseRun(liveLines), [liveLines]);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The scroller's single child, whose height IS the transcript's height — observed rather than
   *  derived, so a reveal that grows the text without changing any state still moves the view. */
  const contentRef = useRef<HTMLDivElement>(null);
  /** Whether the reader is at the tail. A ref rather than state: it is read inside layout effects
   *  on every chunk, and a re-render per token to store a boolean nobody renders is wasted work. */
  const stick = useRef(true);
  /** The pill's visibility, which *is* rendered — so it is state, and it only flips when the
   *  reader crosses the threshold rather than on every scroll event. */
  const [detached, setDetached] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  /**
   * Where this conversation was compacted, if it was.
   *
   * Two primitive selectors rather than one returning the conversation row: a selector that built
   * an object would hand back a new reference on every store change and re-render the transcript
   * on every keystroke anywhere in the app.
   */
  const compactedThrough = useConversationStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.compactedThroughTurn ?? null,
  );
  const compactedSummary = useConversationStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.compactedSummary ?? "",
  );
  const uncompact = useConversationStore((s) => s.uncompact);

  const atBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
  }, []);

  const jump = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setDetached(false);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const onScroll = useCallback(() => {
    const bottom = atBottom();
    stick.current = bottom;
    setDetached((was) => (was === !bottom ? was : !bottom));
  }, [atBottom]);

  const pendingId = session.pendingMessageId;
  const pendingText = pendingId ? (streamingText[pendingId] ?? "") : "";
  const pendingThinking = pendingId ? (streamingThinking[pendingId] ?? "") : "";
  const count = session.messages.length;

  // Follow the tail — but only if the reader is still on it. `useLayoutEffect` and not `useEffect`
  // so the correction happens in the same frame the new content is painted in; with the async one
  // the transcript visibly jumps after the token appears, once per token.
  useLayoutEffect(() => {
    if (stick.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [count, pendingText, pendingThinking, session.sending]);

  /**
   * The same rule, driven by the content's own height instead of by a dependency list.
   *
   * The effect above cannot see the case that matters most. Five of the six providers cannot type,
   * so their answers arrive whole and are uncovered by the typewriter in `conversationStore` — and
   * during that reveal *none* of those four dependencies change: the message is already in
   * `session.messages` so `count` is fixed, `pendingMessageId` is null so `pendingText` stays the
   * empty string, and `sending` is already false. The answer grew by six paragraphs and nothing
   * asked the transcript to follow it.
   *
   * It was worse than a missed scroll. `detached` is only ever set from `onScroll`, and nothing
   * scrolled — so `stick` stayed true, the pill never appeared, and the reader was left with no
   * way back to an answer being written off the bottom of the screen.
   *
   * A `ResizeObserver` on the content is the honest signal, because the question is not "did state
   * change" but "did this get taller". That also picks up, for free, the three cases nobody had
   * handled: a composer growing as the user types, the window being resized mid-answer, and an
   * image finishing loading after its markdown rendered.
   */
  useLayoutEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // A different conversation is a different document: re-attach to the tail and land there without
  // an animation, because animating a jump the reader did not ask for is how a switch comes to feel
  // like a scroll they have to undo.
  useEffect(() => {
    stick.current = true;
    setDetached(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  const streamsTokens = providerCapabilities(session.provider).streamsTokens;

  const onSkipReveal = useCallback(() => skipReveal(activeId ?? ""), [skipReveal, activeId]);

  if (!activeId) return null;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div ref={contentRef} className={`${READING_COLUMN} ${COLUMN_GUTTER} space-y-5 py-8`}>
          {/* `session.loaded` and not just an empty array: a conversation whose transcript is
              still in flight also has no messages, and telling the reader "nothing asked yet" for
              two frames about a chat they can see in the sidebar is worse than showing nothing. */}
          {count === 0 && session.loaded && !session.sending && (
            <div className="flex flex-col items-center gap-3 pt-16 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
                <AiSparkles size={20} />
              </div>
              <p className="text-[14px] font-semibold">{t("chat.emptyTurnTitle")}</p>
              <p className="max-w-[360px] text-[13px] leading-relaxed text-[var(--cf-text-muted)]">
                {t("chat.emptyTurnSubtitle")}
              </p>
            </div>
          )}

          {session.messages.map((message, index) => (
            <Fragment key={message.id}>
              <TranscriptTurn
                message={message}
                previous={session.messages[index - 1]}
                locale={locale}
                conversationId={activeId}
                // Every action on a turn is disabled while another one is running, for the reason
                // `chat_send` enforces on its own side: a conversation holds one lease and can only
                // resume its engine session once at a time. A turn still being uncovered by the
                // typewriter is excluded for a softer reason: its text on screen is not yet the text
                // that would be replayed, so a cost chip counting it would be counting a lie.
                canAct={!session.sending && session.revealingMessageId === null}
                revealing={message.id === session.revealingMessageId}
                onSkipReveal={onSkipReveal}
                onEditRequest={onEditRequest}
              />
              {/* The line the engine's memory starts at. Drawn between the turns it covers and the
                  ones sent verbatim, which is the only place it means anything — a band at the top
                  of the transcript would say "this was compacted" without saying *how far*. */}
              {compactedThrough !== null &&
                message.turn === compactedThrough &&
                session.messages[index + 1]?.turn !== compactedThrough && (
                  <CompactionMark
                    turns={compactedThrough + 1}
                    summary={compactedSummary}
                    onUndo={() => void uncompact(activeId)}
                  />
                )}
            </Fragment>
          ))}

          {session.sending && (
            <div className="space-y-2">
              {pendingThinking && <ThinkingBlock text={pendingThinking} live />}
              {pendingText && (
                <ChatMessageBubble
                  message={PENDING_SHELL}
                  variant="reading"
                  streamText={pendingText}
                />
              )}
              {/*
                The honest progress mark, and the reason it is here for *every* provider rather than
                only the four that cannot type.

                For Claude the text above is already the evidence, and this strip is merely the tool
                calls behind it. For the other five there is nothing above at all until the turn
                lands — their headless modes emit structured steps and no intra-message text — so
                this strip is the entire answer to "is it alive", and a `ThinkingOrb` sitting where
                the reply will be would be a decoration standing in for information the app actually
                has. `AiRunLog` already renders the steps and the elapsed time; there is nothing
                to add and a lot to get wrong by re-drawing it.

                Its Stop is the one thing this view does not want. The composer's send button has
                already become Stop while a turn runs, and it sits where the hand already is — two
                buttons for one action, one above the transcript and one below it, read as two
                different actions.
              */}
              <AiRunLog
                runId={session.runId ?? undefined}
                running
                startedAt={session.runStartedAt}
                showStop={false}
                expanded={logExpanded}
                onToggle={() => setLogExpanded((v) => !v)}
              />
              {/* What the log is actually saying, while it is still saying it.
                  A CLI pointed at an endpoint that is not listening retries rather than fails, so
                  without this the run spins until the user gives up and presses Stop — with the
                  explanation on screen the whole time, in a wall of identical orange lines nobody
                  should have to read. See `lib/runDiagnosis`. */}
              {diagnosis && (
                <p className="px-0.5 text-[11px] leading-relaxed text-[var(--cf-warning)]">
                  {serviceOnPort(diagnosis.url)
                    ? t("chat.endpointUnreachableKnown", {
                        url: diagnosis.url,
                        service: serviceOnPort(diagnosis.url) ?? "",
                      })
                    : t("chat.endpointUnreachable", { url: diagnosis.url })}
                </p>
              )}
              {!streamsTokens && !pendingText && !diagnosis && (
                <p className="px-0.5 text-[10.5px] text-[var(--cf-text-muted)]">
                  {t("chat.noStreamingNotice")}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Scoped to the scroller, so a selection in the sidebar or the composer is somebody else's.
          It portals to the body and positions itself from the viewport, which is why it can be a
          sibling here rather than inside the clipping scroll box. */}
      <SelectionActions scope={scrollRef} onQuoteReply={onQuoteReply} onQuoteNewChat={onQuoteNewChat} />

      {detached && (
        <button
          type="button"
          onClick={() => jump()}
          className="cf-fade-in absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-1.5 text-[12px] text-[var(--cf-text)] shadow-[var(--cf-shadow)]"
        >
          <ArrowDown size={12} />
          {t("chat.jumpToLatest")}
        </button>
      )}
    </div>
  );
}

/** The bubble a turn-in-flight is drawn into. A frozen module-level constant rather than an object
 *  literal in JSX: `ChatMessageBubble` is memoised on its props, and a fresh `{}` per render would
 *  defeat that on exactly the component that re-renders sixty times a second. */
const PENDING_SHELL = { role: "assistant" as const, content: "" };

/**
 * One turn plus, when the day changes, the divider announcing it.
 *
 * Memoised on primitives and on the message object's own identity, which together are what make the
 * memo on `ChatMessageBubble` mean anything. The bubble compares its props by reference, so a
 * parent that rebuilt `{ role, content, … }` and `{ onRegenerate, … }` inline on every render would
 * hand it two fresh objects per commit and re-render every turn in the transcript on every token of
 * the one in flight — the memo would still be there, still doing nothing, and the profile would
 * look exactly like no memo at all. Converting the row and binding the callbacks *here*, behind a
 * memo of its own, is what keeps both stable: the store never mutates a stored message, so
 * `message` is a stable key, and the store's own actions are stable by construction.
 */
const TranscriptTurn = memo(function TranscriptTurn({
  message,
  previous,
  locale,
  conversationId,
  canAct,
  revealing,
  onSkipReveal,
  onEditRequest,
}: {
  message: ConversationMessage;
  previous: ConversationMessage | undefined;
  locale: string;
  conversationId: string;
  canAct: boolean;
  /** This turn is the one the typewriter is currently uncovering. */
  revealing: boolean;
  onSkipReveal: () => void;
  onEditRequest: (turn: number, content: string) => void;
}) {
  const t = useT();
  const regenerate = useConversationStore((s) => s.regenerate);
  const branch = useConversationStore((s) => s.branch);
  const setEngine = useConversationStore((s) => s.setEngine);
  const sessionProvider = useConversationStore((s) => s.byConversation[conversationId]?.provider ?? null);
  /**
   * The files this turn wrote, resolved against what the directory holds now.
   *
   * Two sources, deliberately. The message says *which paths were this turn's* — nothing else can,
   * since the directory is a flat set of files with no memory of who wrote what. The listing says
   * what still exists and how big it is, so a file the user has since deleted quietly loses its chip
   * instead of keeping one that fails when pressed.
   */
  const listing = useConversationStore((s) => s.outputs[conversationId]);
  const produced = useMemo(() => {
    const paths = message.outputs;
    if (!paths || !listing) return undefined;
    const files = paths
      .map((path) => listing.find((file) => file.path === path))
      .filter((file): file is ChatOutput => file !== undefined);
    return files.length > 0 ? { conversationId, files } : undefined;
  }, [message.outputs, listing, conversationId]);

  const bubble = useMemo<ChatBubbleMessage>(
    () => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      provider: message.provider ?? undefined,
      model: message.model ?? undefined,
      engineVersion: message.engineVersion ?? undefined,
      responseTimeMs: message.responseTimeMs ?? undefined,
      trace: message.trace ?? undefined,
      isError: message.isError,
      isCancelled: message.isCancelled,
    }),
    [message],
  );

  const actions = useMemo<ChatBubbleActions>(
    () => ({
      onRegenerate: canAct && message.role === "assistant" ? () => regenerate(message.turn) : undefined,
      onEdit: canAct && message.role === "user" ? () => onEditRequest(message.turn, message.content) : undefined,
      onBranch: canAct ? () => void branch(conversationId, message.turn) : undefined,
      // Every one of these replays the prefix up to and including this turn — see `CostChip`.
      replayTurns: message.turn,
      // Only on a failed turn, and only when the failure named a model: this is the "model not
      // found" remedy, and the ids come from the CLI's own "did you mean". The provider is the
      // conversation's, not the message's — a turn that failed before the engine reported anything
      // has no provider on it, and the thread's is the one being repaired.
      onPickModel:
        message.isError && sessionProvider
          ? (model: string) => void setEngine(conversationId, sessionProvider, model)
          : undefined,
    }),
    [canAct, message, conversationId, regenerate, branch, onEditRequest, setEngine, sessionProvider],
  );

  const day = useMemo(() => dayDivider(bubble, previous && { role: previous.role, content: "", createdAt: previous.createdAt }, locale), [bubble, previous, locale]);

  return (
    <Fragment>
      {day && (
        <div className="flex items-center gap-2 pt-1">
          <div className="h-px flex-1 bg-[var(--cf-border)]" />
          <span className="text-[10.5px] text-[var(--cf-text-muted)]">{day}</span>
          <div className="h-px flex-1 bg-[var(--cf-border)]" />
        </div>
      )}
      {/* A finished turn keeps whatever reasoning it arrived with, folded shut. It is *above* the
          answer because that is the order it happened in, and shut because after the fact it is a
          monologue sitting over the thing the reader came for. */}
      {message.thinking && <ThinkingBlock text={message.thinking} live={false} />}
      {/* `group` here and not on the bubble: the hover row lives inside the bubble component but
          must reveal on hover of the whole turn, divider excluded. */}
      <div className="group">
        <ChatMessageBubble message={bubble} variant="reading" actions={actions} outputs={produced} />
        {revealing && (
          // The typewriter is a courtesy, not a rule. An answer that is already whole on disk and
          // merely being uncovered at reading speed must always be skippable, or the kindness
          // becomes an artificial wait — which is the exact failure of every "realistic typing"
          // effect that cannot be interrupted.
          <button
            type="button"
            onClick={onSkipReveal}
            className="mt-1 text-[10.5px] text-[var(--cf-accent)] hover:underline"
          >
            {t("chat.skipReveal")}
          </button>
        )}
      </div>
    </Fragment>
  );
});
