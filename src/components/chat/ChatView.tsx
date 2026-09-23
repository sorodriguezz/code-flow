import { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { FolderGit2, MessagesSquare, Pencil, ShieldCheck } from "lucide-react";
import { ChatTranscript } from "./ChatTranscript";
import { ChatWelcome } from "./ChatWelcome";
import { ChatComposer } from "./ChatComposer";
import type { ContextReading } from "./ContextMeter";
import { ConversationSidebar } from "./ConversationSidebar";
import { GroupView } from "./GroupView";
import { COLUMN_GUTTER, READING_COLUMN } from "./chatChrome";
import type { ChatAppCommand } from "./CommandMenu";
import { ResizeHandle } from "../common/ResizeHandle";
import { openTerminal, writeFileBytes } from "../../lib/tauri/commands";
import { chatAttachBytes, chatAttachFile, type ChatAttachment } from "../../lib/tauri/chatCommands";
import { EMPTY_CONVERSATION, effortKey, useConversationStore } from "../../state/conversationStore";
import { estimateTokens } from "../../lib/contextWindow";
import { appendQuote, passageForNewChat } from "../../lib/quoteSelection";
import { providerCapabilities } from "../../lib/aiProviders";
import { useLayoutStore } from "../../state/layoutStore";
import { useUiStore } from "../../state/uiStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useWindowStore } from "../../state/windowStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/** One shared empty array, so a conversation with no attachments hands the composer the *same*
 *  reference on every render. A fresh `[]` would be a new prop each time and would defeat every
 *  memo below it. */
const EMPTY_ATTACHMENTS: ChatAttachment[] = [];

/** The key the not-yet-created conversation's draft is filed under. Empty rather than a made-up
 *  word because conversation ids are uuids: nothing real can ever collide with it. */
const NEW_CHAT_DRAFT = "";

/**
 * The chat workspace.
 *
 * Three pieces and nothing else: a conversation list on the left, the transcript in the middle, the
 * composer at the bottom of the same column as the transcript. Everything this app normally puts in
 * a header — the repository, the branch, the engine, the run log — is either inside the transcript
 * where the turn it belongs to is, or under the composer where the decision it affects is made.
 * That restraint is the feature. A chat is a reading surface, and the measure of one is how much of
 * the window is the words.
 *
 * # The one thing that is not obvious: what a conversation with no repository means
 *
 * A conversation here is **not bound to a project by default**, and that is the case the whole
 * workspace is designed around rather than a degraded one. Which means the read-only shield in the
 * header is load-bearing and not a badge: with no repository there is no working copy to edit, the
 * backend refuses `auto_approve_edits` and passes a read-only tool set to the engines that honour
 * one, and the run happens in a scratch directory the app owns. A user who does want file edits
 * opens the chat from a repository, and the header says which one. Both states are normal; only one
 * of them can write to your disk, and the header is where that is said.
 */
export function ChatView() {
  const t = useT();
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
  const session = useConversationStore(
    (s) => (s.activeId ? s.byConversation[s.activeId] : undefined) ?? EMPTY_CONVERSATION,
  );
  const init = useConversationStore((s) => s.init);
  const loadConversations = useConversationStore((s) => s.loadConversations);
  const create = useConversationStore((s) => s.create);
  const send = useConversationStore((s) => s.send);
  const setEngine = useConversationStore((s) => s.setEngine);
  const setEffort = useConversationStore((s) => s.setEffort);
  const pendingEffort = useConversationStore((s) => s.pendingEffort);
  const setPendingEffort = useConversationStore((s) => s.setPendingEffort);
  const effortProviders = useConversationStore((s) => s.effortProviders);
  const activeGroupId = useConversationStore((s) => s.activeGroupId);
  const groups = useConversationStore((s) => s.groups);
  const activeGroup = useMemo(
    () => (activeGroupId ? (groups.find((g) => g.id === activeGroupId) ?? null) : null),
    [activeGroupId, groups],
  );
  const attachmentsByConversation = useConversationStore((s) => s.attachments);
  const loadAttachments = useConversationStore((s) => s.loadAttachments);
  const addAttachment = useConversationStore((s) => s.addAttachment);
  const removeAttachment = useConversationStore((s) => s.removeAttachment);
  const pendingAttachments = useConversationStore((s) => s.pendingAttachments);
  const attachPendingFile = useConversationStore((s) => s.attachPending);
  const attachPendingBytes = useConversationStore((s) => s.attachPendingBytes);
  const removePendingAttachment = useConversationStore((s) => s.removePendingAttachment);
  const stopTurn = useConversationStore((s) => s.stop);
  const deselect = useConversationStore((s) => s.deselect);

  // The engine this window would use for a *new* conversation. An open one carries its own, pinned
  // when it was created: switching a conversation's provider mid-way is a context transplant rather
  // than a resume (see `ChatModelPicker`), so the routing setting must not silently reach backwards
  // into a chat that already has turns.
  const routedProvider = useTaskProvider("chat");
  const routedModel = useAiProviderStore((s) => s.taskModels.chat ?? s.model);
  const provider = session.provider || routedProvider;
  // Same fallback for the model, and for the same reason: with no conversation open the composer
  // is describing what the *next* one will start on, which is the workspace routing. Once a
  // conversation exists its own row wins — `chat_send` runs on that, not on the routing.
  const model = session.model || routedModel;
  /**
   * Two gates, and they answer different questions: does this CLI take the flag, and would the
   * model it is pointed at do anything with it. The first is fixed for a build and read once at
   * startup; the second follows the model picker, because opencode and cline drive whatever their
   * configured providers serve — a dial over `ollama/llama3` spends a flag nobody reads.
   *
   * Unknown reads as yes. The probe is one IPC round trip, and defaulting it to no would blink the
   * control out of existence on every engine switch for the ordinary case.
   */
  const effortByModel = useConversationStore((s) => s.effortByModel);
  const ensureEffortSupport = useConversationStore((s) => s.ensureEffortSupport);
  useEffect(() => {
    if (effortProviders.includes(provider)) ensureEffortSupport(provider, model);
  }, [effortProviders, provider, model, ensureEffortSupport]);
  const effortSupported =
    effortProviders.includes(provider) && (effortByModel[effortKey(provider, model)] ?? true);
  const attachments = (activeId && attachmentsByConversation[activeId]) || EMPTY_ATTACHMENTS;

  // Read back from disk when the conversation changes, rather than trusting what is in memory: the
  // files are on disk from the moment they are picked, so a conversation reopened in a second
  // window — or after a restart with a half-composed message — still shows what is staged for it.
  useEffect(() => {
    if (activeId) void loadAttachments(activeId);
  }, [activeId, loadAttachments]);

  const attachPath = useCallback(
    async (path: string) => {
      if (!activeId) return;
      try {
        addAttachment(activeId, await chatAttachFile(activeId, path));
      } catch (e) {
        // The backend refuses a file that is too large, or one it cannot read. Both are worth
        // saying out loud — an attachment that silently fails to appear reads as the app losing it.
        pushErrorToast(String(e));
      }
    },
    [activeId, addAttachment],
  );

  const attachBytes = useCallback(
    async (name: string, data: Uint8Array) => {
      if (!activeId) return;
      try {
        addAttachment(activeId, await chatAttachBytes(activeId, name, Array.from(data)));
      } catch (e) {
        pushErrorToast(String(e));
      }
    },
    [activeId, addAttachment],
  );

  /**
   * The same two, for the composer on the empty state — where the file is picked before the
   * conversation it belongs to exists.
   *
   * Worth having rather than disabling the button, because a document is very often *why* somebody
   * starts a chat: the old paperclip told them to send a message first, which meant asking the
   * question before the thing it is about could be attached. The file is staged now and moved into
   * the conversation the first message creates — see `conversationStore.create`.
   */
  const attachPendingPath = useCallback(
    async (path: string) => {
      try {
        await attachPendingFile(path);
      } catch (e) {
        pushErrorToast(String(e));
      }
    },
    [attachPendingFile],
  );

  const attachPendingData = useCallback(
    async (name: string, data: Uint8Array) => {
      try {
        await attachPendingBytes(name, data);
      } catch (e) {
        pushErrorToast(String(e));
      }
    },
    [attachPendingBytes],
  );

  const sidebarWidth = useLayoutStore((s) => s.sizes.chatSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  // Read here rather than passed down: the badge is the only thing in this view that changes with
  // it, and the setting is global.
  const fileGeneration = usePreferencesStore((s) => s.chatFileGenerationEnabled);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);

  /**
   * What is typed but not sent, **per conversation**.
   *
   * One shared string was the obvious shape and the wrong one: the composer follows you. Half a
   * question typed in one thread appears in the next one you open, and going back to the first
   * finds it empty — so the same bug both plants text where it does not belong and loses text that
   * does. Attachments never had this problem (they are files, filed under the conversation that
   * owns them), which made the composer the one thing in this view that ignored which chat you were
   * in.
   *
   * Held here rather than on `conversationStore`'s session, and that is not laziness. Sessions are
   * **evicted** past `MAX_LIVE_CONVERSATIONS` to keep transcripts and their traces out of memory;
   * an unsent paragraph is a few hundred bytes and is the user's, so it must not be subject to a
   * cap that exists to bound something else entirely. Keeping it here means the expensive thing can
   * still be dropped while the irreplaceable one is not.
   *
   * Not persisted, so a restart loses them. Within a session — which is where this was reported and
   * is where switching chats happens — going back to a thread finds exactly what you left in it.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** The turn whose text is sitting in the composer for a second attempt, per conversation. Held
   *  only so the banner above the composer can say which one — the send itself is an ordinary send,
   *  because nothing here can rewind a turn. Keyed for the same reason the drafts are: the banner
   *  used to follow you into a conversation whose turn 3 was somebody else's. */
  const [editingTurns, setEditingTurns] = useState<Record<string, number>>({});

  /** The key a conversation's unsent state is filed under. The empty string stands for "no
   *  conversation open" — the composer on the welcome screen, whose text belongs to the thread the
   *  first message will create. Ids are uuids, so it cannot collide with one. */
  const draftKey = activeId ?? NEW_CHAT_DRAFT;
  const draft = drafts[draftKey] ?? "";
  const editingTurn = editingTurns[draftKey] ?? null;

  /**
   * Writes a draft under an explicit key.
   *
   * Explicit because two callers change the *conversation* and the draft in the same breath —
   * "send this to another chat" deselects first — and a setter bound to whatever `draftKey` was
   * when the callback was created would file the new text under the conversation the user just
   * left. That is the original bug wearing a different hat.
   */
  const setDraftFor = useCallback((key: string, value: string | ((current: string) => string)) => {
    setDrafts((all) => {
      const current = all[key] ?? "";
      const next = typeof value === "function" ? value(current) : value;
      return next === current ? all : { ...all, [key]: next };
    });
  }, []);
  const setDraft = useCallback(
    (value: string | ((current: string) => string)) => setDraftFor(draftKey, value),
    [setDraftFor, draftKey],
  );
  const setEditingTurn = useCallback(
    (turn: number | null) =>
      setEditingTurns((all) => {
        if (turn === null) {
          if (!(draftKey in all)) return all;
          const rest = { ...all };
          delete rest[draftKey];
          return rest;
        }
        return all[draftKey] === turn ? all : { ...all, [draftKey]: turn };
      }),
    [draftKey],
  );

  useEffect(() => {
    // `init` subscribes to `ai:chat-delta` and is idempotent; the listing is what the sidebar
    // renders. Both on mount, because this view is lazily loaded and is the first thing in the app
    // that needs either.
    init();
    void loadConversations(true);
  }, [init, loadConversations]);

  /**
   * Catch up with the process whenever this view comes back into sight.
   *
   * `init` runs once per webview and is guarded, so on its own it never fires again — which is
   * exactly the case that kept breaking: a chat detached mid-turn and then re-attached remounts
   * this component into a store that has not asked the process anything since the window opened,
   * and draws an idle conversation over a run that is still going.
   *
   * Mount covers detach and re-attach. `focus` and `visibilitychange` cover the rest of the ways a
   * window stops being looked at and comes back — another app in front, a workspace switch, the
   * main window restored from the tray. It is one IPC call over a map with an entry per running
   * turn, which is why it can afford to be this eager; `ciStore` wakes on the same two events for
   * the same reason.
   */
  const adoptInflight = useConversationStore((s) => s.adoptInflight);
  const satellites = useWindowStore((s) => s.satellites);
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === "visible") void adoptInflight();
    };
    wake();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [adoptInflight]);

  /**
   * And once more whenever the set of detached windows changes.
   *
   * The precise signal for re-attaching, and the one the two above can miss. `App.tsx` keeps its
   * views mounted rather than unmounting them on a view change — the never-unmount policy that
   * protects live terminals and API sockets — so this component does *not* remount when the chat
   * comes back from a satellite, and whether the OS sends `focus` to the main window as another one
   * closes is its business, not something to rely on. `windows:satellites` is emitted by the backend
   * whenever a satellite opens or closes, which is exactly the moment a window inherits a turn
   * somebody else was showing.
   */
  useEffect(() => {
    void adoptInflight();
    /**
     * And the list with it, which is the half this was missing.
     *
     * `windows:satellites` fires when the ask box is built and again when the chat comes back from
     * a window of its own, and both are moments this window's list can have fallen behind: every
     * conversation created in another webview is a row this store has never listed. Detaching the
     * chat made it appear — that window boots and lists fresh — and closing it put the stale list
     * back on screen, which is the shape the bug was reported in: "as an island I can see it, back
     * in the app I cannot."
     *
     * One indexed query over a list the sidebar is already rendering, on a signal that fires when a
     * window opens or closes and at no other time.
     */
    void loadConversations(true);
  }, [satellites, adoptInflight, loadConversations]);

  const conversation = useMemo(
    () => conversations.find((candidate) => candidate.id === activeId) ?? null,
    [conversations, activeId],
  );

  /**
   * The repository behind this conversation, when there is one.
   *
   * Searched across **every** workspace rather than the active one, because this list is flat and
   * global: a conversation bound to a repository in another workspace is an ordinary thing to have
   * open here, and narrowing to the active workspace would quietly turn it into a read-only chat on
   * screen while the backend went on treating it as writable. The name for the header comes off the
   * conversation row itself (the backend joins it in), so this lookup exists only for the one thing
   * a row cannot carry — the working-copy path a terminal would open in.
   */
  const project = useMemo(() => {
    if (!session.projectId) return null;
    for (const list of Object.values(projectsByWorkspace)) {
      const found = list.find((candidate) => candidate.id === session.projectId);
      if (found) return found;
    }
    return null;
  }, [projectsByWorkspace, session.projectId]);

  const compacting = useConversationStore((s) => (activeId ? Boolean(s.compacting[activeId]) : false));
  const autoCompactEnabled = usePreferencesStore((s) => s.chatAutoCompactEnabled);
  const cavemanLevels = useConversationStore((s) => s.cavemanLevels);
  const setCaveman = useConversationStore((s) => s.setCaveman);
  const pendingCaveman = useConversationStore((s) => s.pendingCaveman);
  const setPendingCaveman = useConversationStore((s) => s.setPendingCaveman);
  // Asked once per model and cached. `undefined` — not yet answered — and `null` — asked, and the
  // app will not name a window for this one — draw identically, so there is no flash of a wrong bar
  // while the probe is in flight.
  const windowByModel = useConversationStore((s) => s.windowByModel);
  const ensureContextWindow = useConversationStore((s) => s.ensureContextWindow);
  useEffect(() => {
    if (model) ensureContextWindow(model);
  }, [model, ensureContextWindow]);
  const compact = useConversationStore((s) => s.compact);
  const uncompact = useConversationStore((s) => s.uncompact);

  /**
   * How much is in front of the model, assembled from the two places that know.
   *
   * The conversation row carries the *measured* figure — what the engine itself reported reading on
   * the last turn — and the transcript is what an estimate is counted from before any turn has
   * reported. Which of the two is being shown is passed through rather than smoothed over; see
   * `ContextMeter`.
   *
   * The estimate counts **what would actually be sent**, not the whole transcript: on a compacted
   * thread the earlier turns are replaced by the summary, so counting them would report a context
   * the user has already paid a turn to get rid of.
   */
  const contextReading = useMemo<ContextReading | undefined>(() => {
    if (!activeId || !conversation) return undefined;
    // Nothing has been asked yet, so there is nothing to be full of. A ring at 0% on an empty chat
    // is chrome with no information in it.
    if (session.messages.length === 0) return undefined;

    const cut = conversation.compactedThroughTurn;
    const summary = conversation.compactedSummary ?? "";
    const replayed = cut === null ? session.messages : session.messages.filter((m) => m.turn > cut);
    const measured = conversation.contextTokens ?? null;
    const window = windowByModel[model] ?? null;
    // Both halves, because either one alone is wrong: a provider that cannot resume never has a
    // token, and a provider that can may still be starting fresh — which is exactly the state a
    // compaction leaves the thread in.
    const resumes =
      providerCapabilities(session.provider).resumesSessions && Boolean(session.sessionId);
    return {
      tokens:
        measured ??
        estimateTokens([summary, ...replayed.map((m) => m.content)].filter(Boolean).join("\n\n")),
      measured: measured !== null,
      window,
      resumes,
      /*
       * Whether the backend would actually compact this conversation on its own, which is a
       * narrower question than whether the setting is on.
       *
       * A replaying turn is always protected: the backend builds the prefix and measures it against
       * its own budget. A *resuming* one can only be protected where both halves of a percentage
       * exist — a reported occupancy and a window the app will name — and on four of the six
       * engines neither does. Saying "it will compact itself" there would be a promise this app
       * cannot keep, so the panel only makes it where it is true. Mirrors
       * `auto_compact_if_full`.
       */
      autoCompacts:
        autoCompactEnabled && (!resumes || (measured !== null && window !== null)),
      compactedTurns: cut === null ? 0 : cut + 1,
      summary,
      compacting,
      onCompact: () => void compact(activeId),
      onUncompact: () => void uncompact(activeId),
    };
  }, [
    activeId,
    conversation,
    session.messages,
    session.provider,
    session.sessionId,
    model,
    windowByModel,
    autoCompactEnabled,
    compacting,
    compact,
    uncompact,
  ]);

  const onEditRequest = useCallback(
    (turn: number, content: string) => {
      setDraft(content);
      setEditingTurn(turn);
    },
    // Both setters are bound to the conversation that is open *now*. An empty list here would
    // freeze them on the first render's key — which is the welcome screen's — and every edit would
    // land in a draft nobody is looking at.
    [setDraft, setEditingTurn],
  );

  /**
   * "Responder esto" — the selected passage becomes a quote in *this* conversation's composer.
   *
   * It does not send, for the same reason the welcome openers do not: what the user is about to
   * type is the question, and the quote is only the part of the answer they are pointing at. The
   * conversation's own context is already with the engine — resumed or replayed — so nothing has to
   * be re-explained; the quote's whole job is to say *which part* of it the next question is about.
   *
   * Appended to whatever is already in the composer, because quoting after starting to type is the
   * ordinary order of that gesture.
   */
  const onQuoteReply = useCallback(
    (passage: string) => {
      setDraft((current) => appendQuote(current, passage));
      useUiStore.setState((s) => ({ chatComposerFocus: s.chatComposerFocus + 1 }));
    },
    [setDraft],
  );

  /**
   * "Enviar a otro chat" — the passage starts a conversation of its own.
   *
   * `deselect` rather than `create`: a conversation here is minted by its first message (see
   * `onSend`), so this leaves the workspace on the empty state with the passage in the composer and
   * the caret after it. Pressing send creates the thread; changing your mind leaves no empty row in
   * the sidebar, which is the whole reason creation works that way.
   *
   * The passage is carried **unquoted**. In a new chat it is the entire message and there is
   * nothing to distinguish it *from*; see `lib/quoteSelection`.
   */
  const onQuoteNewChat = useCallback(
    (passage: string) => {
      deselect();
      setEditingTurn(null);
      // Written under the new-chat key explicitly, not through `setDraft`: `deselect` has changed
      // which conversation is open, but this closure still holds the old `draftKey`, so the bound
      // setter would put the passage in the thread the user just left.
      setDraftFor(NEW_CHAT_DRAFT, passageForNewChat(passage));
      useUiStore.setState((s) => ({ chatComposerFocus: s.chatComposerFocus + 1 }));
    },
    [deselect, setDraftFor, setEditingTurn],
  );

  /**
   * Sends, creating the conversation on the first message.
   *
   * The creation is here rather than behind the "New chat" button because the empty state has a
   * composer in it: typing a question and pressing Enter is how a chat starts, and a row minted
   * before there is anything to put in it would leave an empty conversation in the sidebar every
   * time somebody opened this view and changed their mind.
   *
   * An edit-and-resend goes down the same path and is deliberately an *ordinary* send. No CLI here
   * can unsay a turn, so "edit" cannot mean "replace turn N" — it means asking a better version of
   * the question with everything said so far still in the engine's context. The banner above the
   * composer says exactly that; what it must not do is look like a rewind.
   */
  const onSend = useCallback(
    (message: string) => {
      setEditingTurn(null);
      if (activeId) {
        send(activeId, message);
        return;
      }
      void create(null, provider, routedModel).then((id) => {
        if (id) send(id, message);
      });
    },
    [activeId, send, create, provider, routedModel, setEditingTurn],
  );

  const onStop = useCallback(() => {
    if (activeId) stopTurn(activeId);
  }, [activeId, stopTurn]);

  /**
   * An opener from the welcome screen: put it in the composer, then hand over the caret.
   *
   * **It does not send.** Every starter is half a sentence — the interesting part is the error, the
   * diff or the snippet that has not been pasted yet — so sending on the click would fire off a
   * question the user had not finished asking, on a surface where each question costs a real turn.
   *
   * The focus is the other half of the gesture and is bumped through `uiStore` rather than a ref,
   * because that is the channel `ChatComposer` already listens on; it also lands the caret at the
   * end of the text, which is exactly where the rest of the question goes.
   */
  const onPickStarter = useCallback(
    (text: string) => {
      setDraft(text);
      useUiStore.setState((s) => ({ chatComposerFocus: s.chatComposerFocus + 1 }));
    },
    [setDraft],
  );

  /** Opens the provider's own CLI where the conversation is anchored. Only offered when there is a
   *  repository behind the chat: the terminal dock is keyed by project, and a shell opened for a
   *  conversation about nothing has nowhere to be filed and no directory to start in. */
  const onOpenTerminal = useMemo(() => {
    if (!project) return undefined;
    return () => {
      void openTerminal(project.local_path).catch((error: unknown) => pushErrorToast(String(error)));
    };
  }, [project]);

  const exportTranscript = useCallback(async () => {
    if (!conversation) return;
    try {
      const path = await saveDialog({
        defaultPath: `${conversation.title || "chat"}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      // Plain markdown with a heading per turn: the transcript is already prose, and anything more
      // structured would be a format only this app can read back.
      const body = session.messages
        .map((message) => {
          // The role verbatim, not a translated label: the export is a file that leaves the app,
          // and `user` / the model id are what make it legible to whatever reads it next.
          const who = message.role === "user" ? "user" : (message.model ?? message.provider ?? "assistant");
          return `### ${who}\n\n${message.content}\n`;
        })
        .join("\n");
      const heading = conversation.title || t("chat.untitled");
      await writeFileBytes(path, new TextEncoder().encode(`# ${heading}\n\n${body}`));
    } catch (error) {
      pushErrorToast(String(error));
    }
  }, [conversation, session.messages, t]);

  const runAppCommand = useCallback(
    (command: ChatAppCommand, args: string) => {
      switch (command) {
        case "new":
          // Not a delete: it drops the *selection*, so the next message starts a new thread and
          // everything said so far is still in the list on the left. `submit` has already emptied
          // the composer by the time this runs, which is why there is no `setDraft("")` here — and
          // why the `/clear` that used to sit beside this was the same command under a name that
          // means "wipe the conversation" everywhere else.
          deselect();
          break;
        case "export":
          void exportTranscript();
          break;
        case "compact":
          // The same action the meter's button runs, plus the one thing the button cannot offer:
          // whatever the user typed after the command steers what the summary keeps. `/compact
          // quédate con las rutas de archivo` is a different summary from `/compact` alone, and
          // there is nowhere else in the app to say so.
          if (activeId) void useConversationStore.getState().compact(activeId, args);
          break;
        case "caveman": {
          /*
           * `/caveman`, `/caveman ultra`, `/caveman off`.
           *
           * What each of those *means* is the backend's — which word stops the mode, what a bare
           * command gives you, which levels exist. This only reports the refusal, because the
           * sentence has to be in the interface language and the list has to be the real one.
           *
           * An unrecognised word is said out loud rather than quietly rounded to a level: a user
           * who typed `/caveman ultra-max` believing they had changed something would go on
           * reading the same answers and blaming the model.
           */
          void useConversationStore
            .getState()
            .applyCaveman(activeId, args)
            .then((applied) => {
              if (applied) return;
              const known = useConversationStore.getState().cavemanLevels;
              pushErrorToast(
                t("chat.cavemanUnknown", { level: args.trim(), levels: known.join(", ") }),
              );
            });
          break;
        }
        case "branch": {
          // From the last turn, which is what "branch this conversation" means with no turn picked.
          // The per-turn branch lives on the bubble's hover row.
          const last = session.messages[session.messages.length - 1];
          if (activeId && last) void useConversationStore.getState().branch(activeId, last.turn);
          break;
        }
      }
    },
    [deselect, exportTranscript, activeId, session.messages, t],
  );

  // Writability follows the conversation's own `projectId`, not the lookup above: a repository the
  // app has not loaded into memory is still a repository, and saying "read-only" because a list was
  // not to hand would be the one kind of lie this header exists to prevent.
  const writable = session.projectId !== null;
  const repoName = conversation?.projectName || project?.name || "";

  return (
    <div className="flex h-full min-h-0 bg-[var(--cf-surface)]" data-tour="chat-view">
      <div
        // The stored width, capped at a share of the window. The handle below lets it reach 420px,
        // which is a third of a comfortable window and two fifths of the smallest one the app
        // allows — a width chosen on a wide monitor should not follow you onto a narrow one and
        // leave the transcript with less room than the list of its own titles. `%` rather than a
        // media query because there is nothing to switch: the cap simply stops applying once the
        // window is wide enough for the number the user picked.
        style={{ width: sidebarWidth, maxWidth: "34%" }}
        className="flex shrink-0 flex-col border-r border-[var(--cf-border)]"
      >
        <ConversationSidebar />
      </div>

      <ResizeHandle
        axis="x"
        value={sidebarWidth}
        min={200}
        max={420}
        onChange={(value) => setSize("chatSidebarWidth", value)}
        onCommit={(value) => commitSize("chatSidebarWidth", value)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The header is one line and carries exactly two facts: what this conversation is called,
            and whether it can touch your disk. Everything else that wanted to be here — the engine,
            the model, the quota — is a click away or sits under the composer beside the control it
            describes. */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4">
          <MessagesSquare size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
            {conversation?.title || t("chat.newChat")}
          </span>

          {activeId &&
            (writable ? (
              <span
                title={t("chat.repoBadge", { name: repoName })}
                className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--cf-border)] px-2 text-[10.5px] leading-[18px] text-[var(--cf-text-muted)]"
              >
                <FolderGit2 size={10} />
                {repoName}
              </span>
            ) : (
              /*
               * Two different true statements, and picking the wrong one is the failure this
               * branch exists to prevent.
               *
               * "Read-only" was accurate while a repo-less turn could not write anything. With
               * file generation on it can — into a directory of its own, holding nothing of the
               * user's, but a badge that still said read-only would be the app lying about the one
               * fact this header carries. What stays true either way is the part that matters:
               * nothing here can reach your repositories.
               */
              <span
                title={t(fileGeneration ? "chat.noRepoWritableHint" : "chat.noRepoHint")}
                className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--cf-border)] px-2 text-[10.5px] leading-[18px] text-[var(--cf-text-muted)]"
              >
                <ShieldCheck size={10} />
                {t(fileGeneration ? "chat.noRepoWritableBadge" : "chat.noRepoBadge")}
              </span>
            ))}

        </div>

        {/* Three states, in the order they exclude each other: a project page, a conversation, or
            the empty hero. `openGroup` and `open` each clear the other's pointer in the store, so
            this cannot render two of them and does not need to decide which wins. */}
        {activeGroup ? (
          <GroupView group={activeGroup} />
        ) : activeId === null ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* `min-h-0` on the scroller and `h-full` inside it, because `ChatWelcome` centres
                itself in the box it is given and a flex child with no minimum would shrink to the
                height of its own text — leaving the hero hard against the composer instead of in
                the middle of the space above it. */}
            <div className={`min-h-0 flex-1 overflow-y-auto ${READING_COLUMN} ${COLUMN_GUTTER}`}>
              <div className="h-full">
                {/* The file opener is only offered when a turn here could actually write one —
                    the same gate the composer's capabilities panel reads. A card promising a
                    spreadsheet on a chat that cannot produce one would be the thing this whole
                    workspace has spent the week removing. */}
                <ChatWelcome onPickStarter={onPickStarter} canWriteFiles={writable || fileGeneration} />
              </div>
            </div>
            {/* The composer is on screen with no conversation open, which is the ChatGPT behaviour
                and is the reason "New chat" almost never has to be clicked: the first message is
                what creates the conversation, so the empty state is a place to start typing rather
                than a place to press a button first. */}
            <ChatComposer
              provider={provider}
              model={model}
              effort={pendingEffort}
              effortSupported={effortSupported}
              onPickEffort={setPendingEffort}
              // The style `/caveman` left here for the conversation the first message will create.
              // Held rather than written, because there is no row yet — see `pendingCaveman`.
              caveman={{ level: pendingCaveman, levels: cavemanLevels, onPick: setPendingCaveman }}
              attachments={pendingAttachments}
              onAttachPath={attachPendingPath}
              onAttachBytes={attachPendingData}
              onRemoveAttachment={(id) => void removePendingAttachment(id)}
              sending={false}
              turns={0}
              draft={draft}
              onDraftChange={setDraft}
              onSend={onSend}
              onStop={onStop}
              canWriteFiles={writable || fileGeneration}
              onRunAppCommand={runAppCommand}
              onOpenTerminal={onOpenTerminal}
            />
          </div>
        ) : (
          <>
            <ChatTranscript
              onEditRequest={onEditRequest}
              onQuoteReply={onQuoteReply}
              onQuoteNewChat={onQuoteNewChat}
            />
            {editingTurn !== null && (
              // Said out loud, because the composer looks identical either way and what is about
              // to happen is not what "edit" usually means. Nothing is replaced: the old turn and
              // its answer stay in the transcript and on disk, because they happened, and this
              // sends a *new* turn with all of that still in the engine's context. Leaving the
              // banner off would let the user believe they had corrected a question they had in
              // fact only asked twice.
              <div className={`${READING_COLUMN} ${COLUMN_GUTTER} shrink-0`}>
                <div className="flex items-center gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
                  <Pencil size={11} className="shrink-0" />
                  <span className="flex-1">{t("chat.reAskingTurn", { n: editingTurn })}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingTurn(null);
                      setDraft("");
                    }}
                    className="shrink-0 text-[var(--cf-accent)] hover:underline"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
            <ChatComposer
              provider={provider}
              model={model}
              effort={session.effort}
              effortSupported={effortSupported}
              onPickEngine={activeId ? (p, m) => setEngine(activeId, p, m) : undefined}
              onPickEffort={activeId ? (e) => setEffort(activeId, e) : undefined}
              attachments={attachments}
              onAttachPath={activeId ? attachPath : undefined}
              onAttachBytes={activeId ? attachBytes : undefined}
              onRemoveAttachment={activeId ? (id) => void removeAttachment(activeId, id) : undefined}
              sending={session.sending}
              turns={session.messages.length}
              draft={draft}
              onDraftChange={setDraft}
              onSend={onSend}
              onStop={onStop}
              canWriteFiles={writable || fileGeneration}
              onRunAppCommand={runAppCommand}
              onOpenTerminal={onOpenTerminal}
              context={contextReading}
              caveman={{
                level: conversation?.cavemanLevel ?? "",
                levels: cavemanLevels,
                onPick: (level) => {
                  if (activeId) void setCaveman(activeId, level);
                },
              }}
              // Shut while a compaction runs, and this is not politeness. The backend takes the
              // conversation's lease for the whole summarising turn, so a message sent meanwhile
              // is refused — and the composer has already cleared the draft by then, so the
              // question is simply gone. A closed box for twenty seconds beats a lost paragraph.
              disabled={compacting}
              disabledReason={t("chat.contextCompacting")}
            />
          </>
        )}
      </div>
    </div>
  );
}
