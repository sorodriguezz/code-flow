import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUpRight, MessagesSquare, X } from "lucide-react";
import { ChatComposer } from "./ChatComposer";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { ThinkingBlock } from "./ThinkingBlock";
import { AiRunLog } from "../ai/AiRunLog";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { providerCapabilities } from "../../lib/aiProviders";
import type { ChatAttachment, ChatOutput } from "../../lib/tauri/chatCommands";
import { EMPTY_CONVERSATION, effortKey, useConversationStore } from "../../state/conversationStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { openConversationInApp } from "../../lib/chatBridge";

/** The bubble a turn-in-flight is drawn into. Module-level so the memoised bubble is not handed a
 *  fresh object on every chunk. */
const PENDING_SHELL = { role: "assistant" as const, content: "" };

/** The ask box takes no attachments on purpose: it is one question and one answer, gone a few
 *  seconds later, and a file staged in a window that hides on blur is a file the user loses track
 *  of. Attach from the chat workspace, where the conversation is the thing that persists. */
const EMPTY_QUICK_ATTACHMENTS: ChatAttachment[] = [];

/** Same stable-reference trick for the files a turn left behind. */
const EMPTY_OUTPUTS: ChatOutput[] = [];

/**
 * The quick-ask window: one question, one answer, and nothing else at all.
 *
 * Summoned by a global hotkey over whatever the user was doing, expected to be gone a few seconds
 * later. So it has no sidebar and no transcript — both would be the full workspace with pieces
 * missing rather than a box for one question.
 *
 * # Everything needed to ask *this* question is in this window
 *
 * Which engine answers, how hard it thinks, and the way out. The window is built with
 * `decorations(false)` (see `open_quick_ask`), so there is no title bar to hang any of it on and no
 * close button but the one drawn here — a box summoned over another application cannot send the
 * user somewhere else to configure it and still be the cheap thing it claims to be.
 *
 * The two pickers cost one short row under the input and they are not decoration: the model decides
 * who answers, and the level is the difference between an answer in two seconds and an answer in
 * forty. Both are also the only place those can be set for the conversation this window is about to
 * create — before the first question there is no row anywhere else to carry them.
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
  const setEngine = useConversationStore((s) => s.setEngine);
  const setEffort = useConversationStore((s) => s.setEffort);
  const setPendingEffort = useConversationStore((s) => s.setPendingEffort);
  const pendingEffort = useConversationStore((s) => s.pendingEffort);
  const effortProviders = useConversationStore((s) => s.effortProviders);
  const effortByModel = useConversationStore((s) => s.effortByModel);
  const ensureEffortSupport = useConversationStore((s) => s.ensureEffortSupport);

  /** The conversation this window has asked into, if it has asked yet. Local rather than the
   *  store's `activeId`: the main window's selection is its own business, and a quick ask must not
   *  move what somebody is reading over there. */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const session = useConversationStore(
    (s) => (conversationId ? s.byConversation[conversationId] : undefined) ?? EMPTY_CONVERSATION,
  );

  /** The files the last answer produced, resolved against the live listing — the same join
   *  `ChatTranscript` does, for the same reason. A turn asked from here can write files like any
   *  other repo-less turn, and a file the user is never shown is the failure this window's "Open in
   *  CodeFlow" link exists to prevent. */
  const listing = useConversationStore(
    (s) => (conversationId ? s.outputs[conversationId] : undefined) ?? EMPTY_OUTPUTS,
  );

  const [draft, setDraft] = useState("");
  const [logExpanded, setLogExpanded] = useState(false);

  const fileGeneration = usePreferencesStore((s) => s.chatFileGenerationEnabled);
  const routedProvider = useTaskProvider("chat");
  const routedModel = useAiProviderStore((s) => s.taskModels.chat ?? s.model);
  const provider = session.provider || routedProvider;
  const model = session.model || routedModel;

  // Engine gate synchronously, model gate a tick later — see the note on `effortSupported` in
  // `ChatView`, which this window deliberately mirrors rather than simplifies: the ask box runs the
  // same engines against the same routing, and a control that behaved differently in the small
  // window would be a second answer to one question.
  useEffect(() => {
    if (effortProviders.includes(provider)) ensureEffortSupport(provider, model);
  }, [effortProviders, provider, model, ensureEffortSupport]);
  const effortSupported =
    effortProviders.includes(provider) && (effortByModel[effortKey(provider, model)] ?? true);

  useEffect(() => {
    init();
  }, [init]);

  /**
   * The caret goes in the box, every time the box appears.
   *
   * Without this the window opened with nothing focused at all: the chord raised a composer and
   * the next thing the user typed went nowhere, so the box had to be *clicked* before it could be
   * used. On the one surface whose entire promise is "press the chord and start typing", that is
   * the difference between a feature and a party trick.
   *
   * **`onFocusChanged` and not just mount**, and that is the part that is easy to get wrong: this
   * window is hidden and shown, not built and destroyed (see the Escape handler below and
   * `quick_ask_close`), so it mounts exactly once and every summon after the first would have
   * arrived with a dead caret. The window regaining focus is the signal that covers all of them —
   * the first open, every re-summon, and clicking back to the box from another application.
   *
   * `ChatComposer` owns the focusing itself, through a counter in `uiStore` rather than a ref
   * passed down; bumping it is how anything asks. The counter is bumped directly rather than
   * through `focusChatComposer`, which would also set `activeView` — meaningless in a window with
   * no rail, and a write to shared state this window has no business making.
   */
  useEffect(() => {
    const focusComposer = () =>
      useUiStore.setState((s) => ({ chatComposerFocus: s.chatComposerFocus + 1 }));
    focusComposer();
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) focusComposer();
    });
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

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

  /** Before the first question there is no row to write the level to, so it is held as this
   *  window's pending level and `create` applies it to the conversation it makes — which is what
   *  keeps the *opening* question from being the one turn that ignored the dial. After that the
   *  conversation owns it, exactly as in the full workspace. */
  const onPickEffort = useCallback(
    (value: string) => {
      if (conversationId) return setEffort(conversationId, value);
      setPendingEffort(value);
    },
    [conversationId, setEffort, setPendingEffort],
  );

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

  const producedFiles = useMemo(() => {
    const paths = answer?.outputs;
    if (!conversationId || !paths) return undefined;
    const files = paths
      .map((path) => listing.find((file) => file.path === path))
      .filter((file): file is ChatOutput => file !== undefined);
    return files.length > 0 ? { conversationId, files } : undefined;
  }, [answer, listing, conversationId]);

  const streamsTokens = providerCapabilities(provider).streamsTokens;

  return (
    <div className="flex h-full flex-col bg-[var(--cf-surface)]">
      {/* The strip that belongs to the window rather than to the app.

          `open_quick_ask` builds this window with `decorations(false)`, so the platform draws no
          title bar to grab — and nothing here drew one either, which left a box that appears
          wherever it was centred and cannot be moved off whatever it landed on top of. A window
          summoned over another application is precisely the one you need to *shift* to see what is
          underneath, so this is the frame's one remaining job. A real row in the column rather than
          an absolutely-positioned overlay, so it can never take a press meant for the answer.

          # Why this is not `data-tauri-drag-region`

          Every other bar in the app uses the attribute, and the attribute carries a second
          behaviour with it that the rest of the app wants and this window must not have: a
          double-click on a drag region maximizes. Tauri's injected handler does it, and
          `lib/overlayDragRegion` does it again on macOS, where the first one waits for the mouseup.

          A maximized ask box is a 720×420 window that has just covered the whole screen — while
          `always_on_top`, with no task-bar entry and no title bar to put it back from. The only way
          out is to find this strip again and double-click it a second time, which is not a state to
          drop somebody into for a slip of the finger. So the press is bound to the one thing this
          window actually needs. Direct hits only, which is what the bare attribute would have meant
          too: the close button beside it keeps its own press. */}
      <div
        onMouseDown={(event) => {
          if (event.button !== 0 || event.target !== event.currentTarget) return;
          // Keeps the press from starting a text selection that the drag would then smear across
          // the window. The platform's move loop takes the pointer from here.
          event.preventDefault();
          void getCurrentWindow().startDragging();
        }}
        className="flex h-7 shrink-0 cursor-default select-none items-center justify-end px-2"
      >
        {/* The only way out that can be seen. Escape does the same thing and is what most presses
            will use, but a window with no frame and no title bar offers a mouse absolutely nothing,
            and a keyboard shortcut nobody was told about is not an affordance.

            Hides rather than destroys, exactly as Escape does: this box is summoned many times in a
            session and rebuilding its webview each time is the difference between "instant" and "a
            beat". Nothing is lost either way — the conversation is in SQLite from the moment the
            question was asked, and a run already under way is a subprocess that outlives the window
            and is watched from the main window's status bar. */}
        <button
          type="button"
          onClick={() => void getCurrentWindow().hide()}
          title={t("chat.quickAskClose")}
          aria-label={t("chat.quickAskClose")}
          className="rounded-md p-1 text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.07]"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1">
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
              // The composer under it turns into Stop, and in a window this narrow a second one on
              // the card is not a redundancy the eye can ignore — it is half the row.
              showStop={false}
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
            outputs={producedFiles}
          />
        )}
      </div>

      <ChatComposer
        provider={provider}
        model={model}
        effort={conversationId ? session.effort : pendingEffort}
        // Engine and model, the same two gates the full composer applies: the CLI has to take the
        // flag and the model has to be one that reads it. Unknown counts as yes.
        effortSupported={effortSupported}
        onPickEffort={onPickEffort}
        // Before the first question there is no row to re-point, and the chip falls through to the
        // workspace's chat routing on its own — which is exactly what the next question will run
        // on. Once a conversation exists it owns its engine, so the pick goes to the row instead.
        onPickEngine={conversationId ? (p, m) => setEngine(conversationId, p, m) : undefined}
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
        // Always repo-less by construction (see `onSend`), so the only question is the setting.
        canWriteFiles={fileGeneration}
        onRunAppCommand={() => {}}
      />

      {conversationId && (
        <button
          type="button"
          onClick={() => {
            // Hands the conversation to whichever window holds the chat workspace — the detached
            // one if there is one, the main window otherwise — and only then gets out of the way.
            //
            // This used to broadcast `focus-main` and stop there, on the reasoning that selecting
            // the conversation over there was impossible from here: each window holds its own
            // `conversationStore`, so `open()` called in this webview moves a pointer nothing else
            // reads, and the flat list is sorted by recency so the thread just asked is the first
            // row in the sidebar anyway. The second half of that was the part that did not survive
            // contact: the sidebar over there was *listed before this conversation existed*, so the
            // button brought a window forward that had never heard of it. `openConversationInApp`
            // is the addressed message that closes it — the shape `open-diagram` already had.
            void openConversationInApp(conversationId).finally(() => {
              void getCurrentWindow().hide();
            });
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
