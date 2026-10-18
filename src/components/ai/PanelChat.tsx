import { Fragment, Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Clock, Download, Eraser, FilePen, ImagePlus, ListChecks, ListPlus, MessageSquareShare, Pencil, Play, Search, Square, Users, UsersRound } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { CommandMenu, appCommandFor, type ChatAppCommand } from "../chat/CommandMenu";
import { SkillChip } from "../chat/ChatComposer";
import { AttachmentBar } from "../chat/AttachmentBar";
import { MentionMenu, useMentions } from "../chat/MentionMenu";
import { TurnReview } from "./TurnReview";
import { useTextMenu } from "../common/TextMenu";
import { useModelReadsImages } from "../../lib/useModelReadsImages";
import { IMAGE_EXTENSIONS, useImageDrop } from "../../lib/useImageDrop";
import { useAutosizeTextarea } from "../../lib/useAutosizeTextarea";
import type { ChatAttachment } from "../../lib/tauri/chatCommands";
import { McpMenu } from "../chat/McpMenu";
import { QueuedMessages, type ComposerQueue } from "../chat/QueuedMessages";
import { chatQueueKey, useChatQueue, useChatQueueHold } from "../../state/chatQueueStore";
import { FOCUS_CHAT_EVENT, SEND_CHAT_EVENT, openChat, openNewChat, takePendingSend } from "../../lib/aiPanelNav";
import { moveChatToApp } from "../../lib/moveChatToApp";
import { openTerminal } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import { registerDictationSend } from "../../state/dictationStore";
import { DictationBar, DictationMic, useDictatingHere } from "../dictation/DictationControls";
import { useIsQueued, repoHolder } from "../../lib/repoQueue";
import { resolveAccount } from "../../lib/aiAccounts";
import { ChatMessageBubble, dayDivider, type ChatBubbleActions, type CodeBlockTarget } from "../chat/ChatMessageBubble";
import { ChatFindBar, useChatFind } from "../chat/ChatFind";
import { ContextMeter, type ContextReading } from "../chat/ContextMeter";
import { insertCodeAtCaret, useApplyCodeStore } from "../../lib/codeToEditor";
import { estimateTokens } from "../../lib/contextWindow";
import { providerCapabilities } from "../../lib/aiProviders";
import { branchChatConversation } from "../../lib/tauri/commands";
import { useConversationStore } from "../../state/conversationStore";
import { exportMenuItems, exportRepoConversation } from "../chat/exportChat";
import { ContextMenu } from "../common/ContextMenu";
import { AiRunLog } from "./AiRunLog";
import { ChatModelPicker } from "./ChatModelPicker";
import { AnswerLengthPicker } from "../chat/AnswerLengthPicker";
import { EffortPicker } from "../chat/EffortPicker";
import { useEffortSupported } from "../../lib/useEffortSupport";
import { EMPTY_CHAT, engineFor, useChatStore, type ChatEngine, type ChatSkillPick } from "../../state/chatStore";
import { EMPTY_CONVERSATIONS, useChatHistoryStore } from "../../state/activityStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useAccountName, useAiAccountsStore } from "../../state/aiAccountsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useLanguageStore, useT } from "../../state/languageStore";

// Lazy, as the editor it diffs in is: a static import put all of Monaco on the boot path, since
// the panel is part of the shell.
const ApplyCodeModal = lazy(() => import("./ApplyCodeModal").then((m) => ({ default: m.ApplyCodeModal })));

/** Whether a question was Claude's own `/compact` — here it is the CLI's, not the app's (see
 *  `CommandSurface`), and it answers with no text: the reply under it says what happened. */
function isCompactCommand(message: { role: string; content: string } | undefined): boolean {
  return message?.role === "user" && /^\/compact(\s|$)/i.test(message.content.trim());
}

const NO_FILES: ChatAttachment[] = [];

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
 * - **It opens on the newest turn, and follows the reply only while you are at the bottom.**
 *   Coming back to the tab lands on the newest turn too, wherever it was left; reading back no
 *   longer gets yanked down every time a turn lands, and a "jump to latest" pill offers the way back.
 * - **The draft belongs to the conversation** and outlives the tab switch — and a question stopped
 *   while it was queued comes back into the box rather than vanishing.
 * - **The engine belongs to the conversation.** The chip no longer rewrites the chat routing for
 *   every other chat: a pick applies here, and a conversation stays on the engine it has been
 *   answering on even if the routing changes.
 * - **A busy repository is said before sending**, and what is sent waits its turn instead of being
 *   handed back with a toast.
 * - **Enter keeps working while a turn runs.** What is sent then waits above the box and goes out
 *   in order as each answer lands — the chat workspace's queue, over this store's turns (see
 *   `chatQueueStore`). Not the repository wait above: that one is a sent turn waiting for a lease,
 *   this is a message not sent yet.
 */
/** The bubble the answer in flight is drawn into — module-level, because `ChatMessageBubble` is
 *  memoised on its props and a fresh object per render would defeat it on the one component that
 *  re-renders with every chunk. */
const PENDING_SHELL = { role: "assistant" as const, content: "" };

export function PanelChat({
  tabKey,
  projectId,
  conversationId,
  fresh,
  active,
}: {
  tabKey: string;
  projectId: string;
  conversationId: string;
  fresh: boolean;
  /** This tab is the one on screen. A tab left open stays mounted, hidden (`AiPanel`'s
   *  `KEEP_ALIVE`), and coming back to it is entering the conversation again — see the scrolling. */
  active: boolean;
}) {
  const t = useT();
  const locale = useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US";
  const accountName = useAccountName();
  const session = useChatStore((s) => s.byConversation[conversationId]) ?? EMPTY_CHAT;
  const picked = useChatStore((s) => s.engineByConversation[conversationId]);
  const project = useWorkspaceStore((s) =>
    Object.values(s.projectsByWorkspace)
      .flat()
      .find((p) => p.id === projectId) ?? null,
  );
  const workspaceId = useWorkspaceStore((s) => s.workspaceOfProject(projectId));
  const draft = useAiPanelStore((s) => s.drafts[tabKey] ?? "");
  const setDraft = (text: string) => useAiPanelStore.getState().setDraft(tabKey, text);
  const queued = useIsQueued(session.sending ? session.runId : null);
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null);
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
  const effort = useChatStore((s) => s.effortByConversation[conversationId] ?? "");
  const effortSupported = useEffortSupported(provider, model);
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
  /** The turns inside the scroller, observed with it — see the last effect below. */
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** Whether the reader is away from the newest turn — the round ↓ shows for as long as they are,
   *  the way every AI chat does, not only when something new arrives. */
  const [showJump, setShowJump] = useState(false);
  /** Something landed below while they were reading above — the ↓ carries a dot for it. */
  const [newBelow, setNewBelow] = useState(false);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    setShowJump(!atBottom.current);
    if (atBottom.current) setNewBelow(false);
  };
  /** `smooth` for the button — a jump the eye can follow — and instant for following a reply. */
  const toBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottom.current = true;
    setShowJump(false);
    setNewBelow(false);
  };
  // Opened at the newest turn, and entered at it again whenever the tab comes back to the front. A
  // hidden tab cannot be scrolled: a reply that landed meanwhile was "followed" by a scroll that did
  // nothing, and the tab came back wherever it had been left — above the answer, with no ↓ saying
  // so. Entering a conversation is reading its newest turn, whatever was being read when it was
  // left. In the commit that shows the tab, so the first frame on screen is already the newest.
  useLayoutEffect(() => {
    if (active) toBottom();
    // `toBottom` only touches refs and state setters, none of which change between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, active]);
  // Follows what is being written only while the reader is at the bottom.
  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
    else {
      setShowJump(true);
      setNewBelow(true);
    }
  }, [session.messages.length, session.streamText.length, session.sending]);
  /**
   * What the effects above cannot see: a size changing under a reader at the bottom, read from the
   * boxes rather than from the store. The queue strip and the attachments grow the composer, which
   * shrinks the scroller from below, and the newest lines went under it; a code block coloured or
   * an image decoded after the render grows the turns without touching anything the effects above
   * watch. Either way the view stays on the newest — and only then: someone reading back is left
   * where they are.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // A hidden tab measures nothing; the effect above lands it when it is shown.
      if (atBottom.current && el.clientHeight > 0) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // ── Composer ──────────────────────────────────────────────────────────────────────────────
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(boxRef, draft, MAX_COMPOSER_HEIGHT);
  /** Where the caret is in the box — what the `@` menu reads the mention being typed from. */
  const [caret, setCaret] = useState(0);
  const mentions = useMentions({
    repoPath: project?.local_path ?? null,
    text: draft,
    caret,
    onInsert: (next) => {
      setDraft(next.text);
      setCaret(next.caret);
      requestAnimationFrame(() => {
        boxRef.current?.focus();
        boxRef.current?.setSelectionRange(next.caret, next.caret);
      });
    },
  });
  // The editor's «Preguntar en el chat» put a mention in this tab's draft: the box takes focus, the
  // caret after it, for the question to be typed.
  useEffect(() => {
    const onFocus = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== tabKey) return;
      const box = boxRef.current;
      if (!box) return;
      box.focus();
      const end = box.value.length;
      box.setSelectionRange(end, end);
      setCaret(end);
    };
    // The graph's «Explicar con IA» filled the draft and wants it sent as it stands.
    const onSend = (event: Event) => {
      if ((event as CustomEvent<string>).detail === tabKey && takePendingSend(tabKey)) submitRef.current();
    };
    // Opened for it, and mounted after the event went out.
    if (takePendingSend(tabKey)) requestAnimationFrame(() => submitRef.current());
    window.addEventListener(FOCUS_CHAT_EVENT, onFocus);
    window.addEventListener(SEND_CHAT_EVENT, onSend);
    return () => {
      window.removeEventListener(FOCUS_CHAT_EVENT, onFocus);
      window.removeEventListener(SEND_CHAT_EVENT, onSend);
    };
  }, [tabKey]);
  /** Plan mode: each turn runs read-only and answers with a plan (see `ai::PLAN_MODE_NOTE`). */
  const planMode = useChatStore((s) => s.planByConversation[conversationId] ?? false);
  // The skill staged for the next question — dropped when the engine changes, since a skill is one
  // CLI's and the next engine may not have it.
  const [skill, setSkill] = useState<ChatSkillPick | null>(null);
  useEffect(() => {
    setSkill(null);
  }, [provider]);

  /**
   * The panel's own commands — see `CommandSurface`. Everything else behind a slash is the CLI's.
   *
   * Typed or clicked while a turn runs, `/clear` **waits its turn** (the store's `submit` queues it):
   * the questions already queued were asked of the session they were written in, and only the ones
   * after it should start fresh. `/new` and `/export` act on the tab, not on a turn, and run now.
   */
  const runAppCommand = (command: ChatAppCommand) => {
    if (command === "new") {
      openNewChat(projectId);
    } else if (command === "clear") {
      useChatStore.getState().submit(projectId, conversationId, "/clear", { command: { id: "clear", args: "" } });
    } else if (command === "export" && session.persisted && session.messages.length > 0) {
      const rect = boxRef.current?.getBoundingClientRect();
      setExportMenu({ x: rect ? rect.left + 8 : 16, y: rect ? rect.top - 8 : 16 });
    } else if (command === "move") {
      void moveChatToApp(projectId, conversationId);
    }
  };

  const submit = () => {
    // From the store, not the render: a send asked for from outside can land before the re-render.
    const text = (useAiPanelStore.getState().drafts[tabKey] ?? draft).trim();
    // No `sending` guard any more: a message sent while a turn runs is queued by the store.
    if (!text) return;
    // A typed app command runs instead of being sent — `/clear` must not reach a model as seven
    // characters. Anything else starting with a slash is the CLI's, and goes through as written.
    const command = appCommandFor(text, "panel");
    if (command) {
      setDraft("");
      runAppCommand(command.id);
      return;
    }
    useChatStore.getState().submit(projectId, conversationId, text, { skill });
    setDraft("");
    setSkill(null);
    useAiPanelStore.getState().markChatStarted(tabKey);
    toBottom();
  };
  /** «Ejecutar el plan»: plan mode off, and the go-ahead as the next question — the engine resumes
   *  its own session, so the plan it wrote is what it carries out. */
  const runPlan = () => {
    useChatStore.getState().setPlan(conversationId, false);
    useChatStore.getState().submit(projectId, conversationId, t("assistant.runPlanMessage"), {});
    useAiPanelStore.getState().markChatStarted(tabKey);
    toBottom();
  };
  /** What the card under a model's question sends: the answer, as the next message. */
  const answerQuestion = (text: string) => {
    useChatStore.getState().submit(projectId, conversationId, text, {});
    useAiPanelStore.getState().markChatStarted(tabKey);
    toBottom();
  };
  // «Dictar»: stop-and-send runs the submit of the render that holds the transcript.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => registerDictationSend(boxRef.current, () => submitRef.current()));
  const dictating = useDictatingHere(boxRef);

  // ── Images ────────────────────────────────────────────────────────────────────────────────
  // Offered only where the model can look at one (`useModelReadsImages`): copied into this
  // conversation's own folder when picked or pasted, sent with the next question.
  const readsImages = useModelReadsImages(provider, model);
  const staged = useChatStore((s) => s.attachments[conversationId]) ?? NO_FILES;
  const attachPaths = async (paths: string[]) => {
    for (const path of paths) await useChatStore.getState().attachImagePath(conversationId, path);
    boxRef.current?.focus();
  };
  const attachImages = async () => {
    const picked = await openDialog({ multiple: true, filters: [{ name: t("assistant.images"), extensions: IMAGE_EXTENSIONS }] });
    await attachPaths(typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : []);
  };
  /** Images dragged from the desktop onto the composer. */
  const composerRef = useRef<HTMLDivElement>(null);
  const dropOver = useImageDrop(composerRef, (paths) => {
    if (readsImages) void attachPaths(paths);
    else pushErrorToast(t("assistant.imagesUnsupported"));
  });
  /** A screenshot pasted into the box becomes an attachment — or, for a model that cannot see one,
   *  is said not to be rather than vanishing. Text pastes are left alone. */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    if (!readsImages) {
      pushErrorToast(t("assistant.imagesUnsupported"));
      return;
    }
    const extension = (file.type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
    void file.arrayBuffer().then((buffer) =>
      useChatStore.getState().attachImageBytes(conversationId, `pegado.${extension}`, new Uint8Array(buffer)),
    );
  };
  /** Right-click: Copy on a selected passage, Cut / Copy / Paste in the box. */
  const textMenu = useTextMenu();

  /** This conversation's queue — the same strip, and the same rules, as the chat workspace's. Its
   *  names say "message" on purpose: `queued` above is the repository wait, a different thing. */
  const queueKey = chatQueueKey("panel", conversationId);
  const queuedMessages = useChatQueue(queueKey);
  const queueHeld = useChatQueueHold(queueKey);
  const queue = useMemo<ComposerQueue>(
    () => ({
      items: queuedMessages,
      held: queueHeld,
      busy: session.sending,
      onRemove: (id) => useChatStore.getState().discardQueued(conversationId, id),
      // Back into the box, in front of whatever is there: it was written first.
      onEdit: (id) => {
        const item = useChatStore.getState().editQueued(conversationId, id);
        if (!item) return null;
        const current = useAiPanelStore.getState().drafts[tabKey] ?? "";
        useAiPanelStore.getState().setDraft(tabKey, current.trim() ? `${item.text}\n${current}` : item.text);
        if (item.skill) setSkill(item.skill);
        boxRef.current?.focus();
        return item;
      },
      onResume: () => useChatStore.getState().resumeQueue(conversationId),
    }),
    [queuedMessages, queueHeld, session.sending, conversationId, tabKey],
  );
  /** The `/` menu is open while the draft is one token that begins with a slash. */
  const slash = draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1).toLowerCase() : null;
  const menuOpen = slash !== null && !slash.includes(" ");
  const stop = () => {
    if (session.runId) void useAiRunStore.getState().cancel(session.runId);
  };

  const repoName = project?.name ?? "";
  const lastUser = session.messages.map((m) => m.role).lastIndexOf("user");

  // ── Turn actions ──────────────────────────────────────────────────────────────────────────
  /** The question whose text is in the box for a second attempt — only so the line above the box
   *  can say which. The send is an ordinary one: no engine can unsay a turn, so the original and its
   *  answer stay, and this asks again with them in context (the Chat app's «Editar y reenviar»). */
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => {
    if (!draft.trim()) setEditing(null);
  }, [draft]);
  /** «Bifurcar desde aquí»: a new conversation with the turns up to this answer, in its own tab.
   *  It starts a fresh engine session, which is told the transcript (`claude_cmd::panel_transcript`). */
  const branchAt = async (createdAt: string) => {
    const fresh = crypto.randomUUID();
    const title = session.title || session.messages[0]?.content.slice(0, 60) || "";
    try {
      const copied = await branchChatConversation(projectId, conversationId, fresh, createdAt, t("assistant.branchTitle", { title }));
      if (copied === 0) return;
      await openChat(projectId, fresh);
    } catch (e) {
      pushErrorToast(t("assistant.branchFailed", { error: String(e) }));
    }
  };
  /** The handlers the bubbles' actions call — read through a ref, so the actions themselves can be
   *  memoised on the transcript: `ChatMessageBubble` compares its props by reference, and a fresh
   *  object per render would re-draw every turn on every token of the one being written. */
  const handlers = useRef({ setDraft, pickEngine, answerQuestion, branchAt, provider });
  handlers.current = { setDraft, pickEngine, answerQuestion, branchAt, provider };
  const actions = useMemo(
    () =>
      session.messages.map((message, index): ChatBubbleActions | undefined => {
        const canAct = !session.sending;
        if (message.isError) return { onPickModel: (next) => handlers.current.pickEngine(handlers.current.provider, next) };
        if (message.role === "user") {
          return canAct
            ? {
                onEdit: () => {
                  handlers.current.setDraft(message.content);
                  setEditing(Math.floor(index / 2) + 1);
                  requestAnimationFrame(() => boxRef.current?.focus());
                },
              }
            : undefined;
        }
        const latest = index === session.messages.length - 1;
        const question = session.messages[index - 1];
        const at = message.createdAt;
        return {
          onRegenerate:
            canAct && question?.role === "user"
              ? () => {
                  useChatStore.getState().submit(projectId, conversationId, question.content, {});
                  useAiPanelStore.getState().markChatStarted(tabKey);
                  toBottom();
                }
              : undefined,
          onBranch: canAct && session.persisted && !message.isCancelled && at ? () => void handlers.current.branchAt(at) : undefined,
          onAnswer: latest && canAct ? (text: string) => handlers.current.answerQuestion(text) : undefined,
        };
      }),
    // `toBottom` only touches refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.messages, session.sending, session.persisted, projectId, conversationId, tabKey],
  );

  // ── Code blocks → editor ──────────────────────────────────────────────────────────────────
  const codeTarget = useMemo<CodeBlockTarget>(
    () => ({
      insert: (code) => insertCodeAtCaret(projectId, code),
      apply: (code, path) => useApplyCodeStore.getState().open({ tabKey, projectId, code, path }),
    }),
    [projectId, tabKey],
  );
  const applyRequest = useApplyCodeStore((s) => (s.request?.tabKey === tabKey ? s.request : null));

  // ── Context ───────────────────────────────────────────────────────────────────────────────
  const windowByModel = useConversationStore((s) => s.windowByModel);
  const meterModel = session.model ?? model;
  useEffect(() => {
    if (meterModel) useConversationStore.getState().ensureContextWindow(meterModel);
  }, [meterModel]);
  const wasSending = useRef(session.sending);
  useEffect(() => {
    if (wasSending.current && !session.sending && meterModel) useConversationStore.getState().ensureContextWindow(meterModel, true);
    wasSending.current = session.sending;
  }, [session.sending, meterModel]);
  /** How full the engine's context is — measured when the engine said (Claude), else counted from
   *  the turns since the last `/clear`, which is what a fresh session is told again. */
  const contextReading = useMemo<ContextReading | undefined>(() => {
    if (session.messages.length === 0) return undefined;
    const since = session.messages.map((m) => !!m.contextReset).lastIndexOf(true);
    const counted = (since < 0 ? session.messages : session.messages.slice(since)).map((m) => m.content).join("\n\n");
    const measured = session.resetPending ? null : session.contextTokens;
    return {
      tokens: measured ?? estimateTokens(counted),
      measured: measured !== null,
      window: meterModel ? (windowByModel[meterModel] ?? null) : null,
      resumes: providerCapabilities(provider).resumesSessions && Boolean(session.sessionId) && !session.resetPending,
      compactedTurns: 0,
      autoCompacts: false,
      summary: "",
      compacting: false,
      // Claude's own `/compact`, sent as the next turn; the other engines have none to send.
      onCompact:
        provider === "claude"
          ? () => {
              useChatStore.getState().submit(projectId, conversationId, "/compact", {});
              toBottom();
            }
          : undefined,
      onUncompact: () => {},
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.messages, session.contextTokens, session.resetPending, session.sessionId, provider, meterModel, windowByModel, projectId, conversationId]);

  // ── Find ──────────────────────────────────────────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useChatFind({ rootRef, contentRef, scrollRef });

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <ChatFindBar find={find} />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // Focusable, so a click in the transcript puts the focus here and ⌘F finds in this chat.
        tabIndex={-1}
        onContextMenu={textMenu.onText}
        className="relative min-h-0 flex-1 overflow-auto px-3 pb-3 pt-2.5 outline-none"
      >
        <div className="mb-2.5 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          <span className="min-w-0 truncate">{repoName}</span>
          {planMode ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)] px-1.5 py-px text-[10.5px] font-semibold text-[var(--cf-accent)]"
              title={t("assistant.planModeHint")}
            >
              <ListChecks size={9} />
              {t("assistant.planModeBadge")}
            </span>
          ) : (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_13%,transparent)] px-1.5 py-px text-[10.5px] font-semibold text-[var(--cf-warning)]"
              title={t("assistant.canEditHint", { repo: repoName })}
            >
              <FilePen size={9} />
              {t("assistant.canEdit")}
            </span>
          )}
          {session.messages.length > 0 && (
            <button
              type="button"
              onClick={find.show}
              title={t("chat.find")}
              aria-label={t("chat.find")}
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
            >
              <Search size={12} />
            </button>
          )}
          {/* Out as a file, once there is a conversation on disk to write out — the export reads
              what was recorded, not what this tab happens to be holding. */}
          {session.persisted && session.messages.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setExportMenu({ x: rect.right - 4, y: rect.bottom + 2 });
              }}
              title={t("chat.export")}
              aria-label={t("chat.export")}
              aria-haspopup="menu"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
            >
              <Download size={12} />
            </button>
          )}
          {/* To the chat workspace, for good — with everything it holds, still on this repository.
              Not while a turn runs or messages wait: they belong to the session it is in. */}
          {session.persisted && session.messages.length > 0 && (
            <button
              type="button"
              onClick={() => void moveChatToApp(projectId, conversationId)}
              disabled={session.sending || queuedMessages.length > 0}
              title={session.sending || queuedMessages.length > 0 ? t("assistant.moveBusy") : t("assistant.moveToChat")}
              aria-label={t("assistant.moveToChat")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <MessageSquareShare size={12} />
            </button>
          )}
        </div>
        {exportMenu && (
          <ContextMenu
            x={exportMenu.x}
            y={exportMenu.y}
            items={exportMenuItems(
              (format, traces) => void exportRepoConversation(projectId, conversationId, repoName, format, traces),
            )}
            onClose={() => setExportMenu(null)}
          />
        )}

        {/* `wrap-anywhere`: see the same class on the Chat app's column (`ChatTranscript`). */}
        <div ref={contentRef} className="space-y-2.5 wrap-anywhere">
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
                {message.contextReset && (
                  // Where `/clear` took effect: the engine started again from here.
                  <ContextBreak label={t("assistant.contextCleared")} />
                )}
                <ChatMessageBubble
                  message={message}
                  actions={actions[i]}
                  codeTarget={project ? codeTarget : undefined}
                  emptyText={
                    message.role === "assistant" && isCompactCommand(session.messages[i - 1])
                      ? t("chat.compactedReply")
                      : undefined
                  }
                />
                {message.role === "assistant" && message.changes && project && (
                  <TurnReview repoPath={project.local_path} changes={message.changes} />
                )}
                {message.role === "assistant" &&
                  message.plan &&
                  !message.isError &&
                  i === session.messages.length - 1 &&
                  !session.sending && (
                    <button
                      type="button"
                      onClick={runPlan}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--cf-border)] px-2 py-1 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                    >
                      <Play size={11} />
                      {t("assistant.runPlan")}
                    </button>
                  )}
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
                answering={!!session.streamText}
                showStop={false}
                onRetry={() => useChatStore.getState().retryTurn(conversationId)}
              >
                {session.streamText && <ChatMessageBubble message={PENDING_SHELL} streamText={session.streamText} />}
              </AiRunLog>
            </>
          )}
        </div>
      </div>

      <div className="relative shrink-0 border-t border-[var(--cf-border)] px-2.5 pb-2.5 pt-2">
        {showJump && (
          <button
            onClick={() => toBottom(true)}
            title={t("chat.jumpToLatest")}
            aria-label={t("chat.jumpToLatest")}
            className="absolute bottom-full left-1/2 z-10 mb-2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] text-[var(--cf-text)] shadow-[var(--cf-shadow)] transition-colors hover:bg-[var(--cf-hover)]"
          >
            <ArrowDown size={15} />
            {newBelow && (
              <span aria-hidden className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-[var(--cf-accent-fill)]" />
            )}
          </button>
        )}
        {/* Not a wait any more: the repository is shared (see `ai_locks`). Said so the user knows
            two agents are in the same checkout — each is told about the other in its prompt. */}
        {holder && !session.sending && (
          <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[var(--cf-text-muted)]" title={t("assistant.repoLeaseHint")}>
            <Users size={11} className="shrink-0" />
            <span className="min-w-0 truncate">{t("assistant.repoBusy", { holder })}</span>
          </p>
        )}
        {session.resetPending && !session.sending && (
          <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[var(--cf-text-muted)]" title={t("assistant.contextClearedHint")}>
            <Eraser size={11} className="shrink-0" />
            <span className="min-w-0 truncate">{t("assistant.contextCleared")}</span>
          </p>
        )}
        {editing !== null && (
          // Said out loud: the box looks the same either way, and nothing is replaced — the original
          // turn and its answer stay, and this asks again with them in context.
          <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[var(--cf-text-muted)]">
            <Pencil size={10} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t("chat.reAskingTurn", { n: editing })}</span>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setDraft("");
              }}
              className="shrink-0 text-[var(--cf-accent)] hover:underline"
            >
              {t("common.cancel")}
            </button>
          </p>
        )}
        {menuOpen && (
          <CommandMenu
            query={slash ?? ""}
            provider={provider}
            surface="panel"
            scope={{ accountId: account ?? "system", workspaceId: workspaceId ?? null, projectId }}
            onRunApp={(command) => {
              setDraft("");
              runAppCommand(command);
            }}
            onInsert={(name) => {
              setDraft(`${name} `);
              boxRef.current?.focus();
            }}
            onPickSkill={(picked) => {
              // A Claude skill only a person may start runs as its own slash command.
              if (!picked.model_invocable && provider === "claude") {
                setDraft(`/${picked.name} `);
              } else {
                setSkill({ name: picked.name, source: picked.source, path: picked.path });
                setDraft("");
              }
              boxRef.current?.focus();
            }}
            onOpenTerminal={
              project
                ? () => void openTerminal(project.local_path).catch((error: unknown) => pushErrorToast(String(error)))
                : undefined
            }
          />
        )}
        {mentions.open && !menuOpen && <MentionMenu items={mentions.items} index={mentions.index} onPick={mentions.pick} />}
        <QueuedMessages queue={queue} />
        {textMenu.menu}
        <div
          ref={composerRef}
          className={`flex flex-col gap-1.5 rounded-xl border bg-[var(--cf-surface-raised)] p-1.5 focus-within:border-[color-mix(in_oklab,var(--cf-accent)_45%,var(--cf-border))] ${
            dropOver ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)]"
          }`}
        >
          <AttachmentBar
            files={staged}
            canSeeImages={readsImages}
            onRemove={(id) => useChatStore.getState().removeAttachment(conversationId, id)}
          />
          {skill && <SkillChip name={skill.name} onRemove={() => setSkill(null)} />}
          <textarea
            ref={boxRef}
            data-ai-input="inline"
            value={draft}
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={onPaste}
            onContextMenu={textMenu.onField}
            onKeyDown={(e) => {
              // The `@` menu takes its keys first: arrows walk it, Enter/Tab pick, Escape hides it.
              if (mentions.onKeyDown(e)) return;
              // Enter sends; Shift+Enter breaks the line. Never mid-composition: an input method
              // uses Enter to accept a candidate, and sending then posts half a sentence.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              session.sending
                ? t("chat.queuePlaceholder")
                : planMode
                  ? t("assistant.planPlaceholder")
                  : t("assistant.askPlaceholder", { repo: repoName })
            }
            aria-label={t("assistant.askPlaceholder", { repo: repoName })}
            className="max-h-[180px] resize-none bg-transparent px-1.5 py-1 text-[13px] leading-relaxed outline-none placeholder:text-[var(--cf-text-muted)]"
          />
          {dictating ? (
            <div className="flex items-center gap-1.5 px-0.5">
              <DictationBar />
            </div>
          ) : (
          <div className="flex items-center gap-1.5 px-0.5">
            <ChatModelPicker
              liveModel={session.model}
              chatActive={session.messages.length > 0}
              bound={{ provider, model, account }}
              onPick={pickEngine}
            />
            {/* How hard it thinks, per conversation — the chat workspace's dial. */}
            <EffortPicker
              compact
              value={effort}
              supported={effortSupported}
              onPick={(level) => useChatStore.getState().setEffort(conversationId, level)}
            />
            <AnswerLengthPicker compact />
            {contextReading && <ContextMeter reading={contextReading} />}
            {/* Plan mode: read-only turns that answer with a plan, then «Ejecutar el plan». */}
            <button
              type="button"
              onClick={() => useChatStore.getState().setPlan(conversationId, !planMode)}
              aria-pressed={planMode}
              title={t("assistant.planModeHint")}
              className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] ${
                planMode
                  ? "bg-[color-mix(in_oklab,var(--cf-accent)_14%,transparent)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
              }`}
            >
              <ListChecks size={13} />
              {t("assistant.planMode")}
            </button>
            {/* The CLI's own MCP servers, switched for this repository. */}
            <McpMenu provider={provider} scope={{ accountId: account ?? "system", workspaceId: workspaceId ?? null, projectId }} />
            {/* Absent, not disabled, for a model that cannot look at an image — the same rule as the
                chat workspace's controls: a button that cannot do anything is worse than none. */}
            {readsImages && (
              <button
                type="button"
                onClick={() => void attachImages()}
                title={t("assistant.attachImage")}
                aria-label={t("assistant.attachImage")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
              >
                <ImagePlus size={13} />
              </button>
            )}
            <span className="flex-1" />
            {session.sending ? (
              <>
                {/* Only while there is something to queue — Enter does the same — and beside Stop,
                    never instead of it: both stay live for the whole turn. */}
                {draft.trim() && (
                  <button
                    onClick={submit}
                    title={t("chat.queueAdd")}
                    aria-label={t("chat.queueAdd")}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                  >
                    <ListPlus size={13} />
                  </button>
                )}
                <button
                  onClick={stop}
                  disabled={cancelling}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--cf-border)] px-2 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)] disabled:opacity-50"
                >
                  <Square size={9} className="fill-current" />
                  {cancelling ? t("ai.stopping") : t("chat.stop")}
                </button>
              </>
            ) : (
              <>
                <DictationMic field={boxRef} className="h-6 w-6" iconSize={13} />
                <button
                  onClick={submit}
                  disabled={!draft.trim()}
                  title={t("chat.send")}
                  aria-label={t("chat.send")}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))] disabled:opacity-40"
                >
                  <ArrowUp size={13} />
                </button>
              </>
            )}
          </div>
          )}
        </div>
      </div>
      {applyRequest && project && (
        <Suspense fallback={null}>
          <ApplyCodeModal request={applyRequest} repoPath={project.local_path} />
        </Suspense>
      )}
    </div>
  );
}

/** The line drawn above the first question after `/clear`: the engine started again from here. */
function ContextBreak({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-2 pt-1.5">
      <div className="h-px flex-1 bg-[var(--cf-border)]" />
      <span className="flex min-w-0 items-center gap-1 text-[10.5px] font-medium text-[var(--cf-text-muted)]">
        <Eraser size={10} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <div className="h-px flex-1 bg-[var(--cf-border)]" />
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
