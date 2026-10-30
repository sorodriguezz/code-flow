import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Download, Eraser, FolderGit2, History, Link2, ListChecks, ListPlus, Loader2, Paperclip, Pencil, Play, RotateCcw, Search, SquarePen, Square, Trash2, UsersRound } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AiRunLog } from "./AiRunLog";
import { ContextSources } from "./ContextSources";
import { ChatModelPicker } from "./ChatModelPicker";
import { menuRowClass, useDismiss } from "./docParts";
import { AttachmentBar } from "../chat/AttachmentBar";
import { AnswerLengthPicker } from "../chat/AnswerLengthPicker";
import { CavemanChip } from "../chat/CavemanChip";
import { ChatFindBar, useChatFind } from "../chat/ChatFind";
import { ContextMeter, type ContextReading } from "../chat/ContextMeter";
import { SkillChip } from "../chat/ChatComposer";
import { CommandMenu, appCommandFor, type ChatAppCommand } from "../chat/CommandMenu";
import { exportChatConversation, exportMenuItems } from "../chat/exportChat";
import { McpMenu } from "../chat/McpMenu";
import { MentionMenu, useMentions } from "../chat/MentionMenu";
import { ContextMenu } from "../common/ContextMenu";
import { TurnReview } from "./TurnReview";
import { EffortPicker } from "../chat/EffortPicker";
import { ChatMessageBubble, dayDivider, type ChatBubbleActions } from "../chat/ChatMessageBubble";
import { QueuedMessages, type ComposerQueue } from "../chat/QueuedMessages";
import { popoverClass } from "../common/recipes";
import { useTextMenu } from "../common/TextMenu";
import { DictationBar, DictationMic, useDictatingHere } from "../dictation/DictationControls";
import { openWorkspaceChat } from "../../lib/aiPanelNav";
import { resolveAccount } from "../../lib/aiAccounts";
import { providerCapabilities, providerDisplayLabel } from "../../lib/aiProviders";
import { estimateTokens } from "../../lib/contextWindow";
import { useAutosizeTextarea } from "../../lib/useAutosizeTextarea";
import { useEffortSupported } from "../../lib/useEffortSupport";
import { isImagePath, useImageDrop } from "../../lib/useImageDrop";
import { useModelReadsImages } from "../../lib/useModelReadsImages";
import { workspaceChatSnapshot, type ChatAttachment, type ContextReset, type SkillPick, type WorkspaceChatSnapshot } from "../../lib/tauri/chatCommands";
import { repoRows, reposReady, type RepoRow } from "../../lib/wsChatRepos";
import { turnNotes } from "../../lib/wsChatTurnNotes";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useAiAccountsStore } from "../../state/aiAccountsStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useChainStore } from "../../state/chainStore";
import { discardChatQueue, useChatQueue, useChatQueueHold } from "../../state/chatQueueStore";
import { confirmAction } from "../../state/confirmStore";
import { useConversationStore } from "../../state/conversationStore";
import { registerDictationSend } from "../../state/dictationStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { EMPTY_WS_CHAT, EMPTY_WS_LIST, pinWsChat, useWorkspaceChatStore, wsChatQueueKey, type WsChatMessage } from "../../state/workspaceChatStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

const STICK_PX = 48;
const MAX_COMPOSER_HEIGHT = 180;
const PENDING_SHELL = { role: "assistant" as const, content: "" };
const NO_FILES: ChatAttachment[] = [];
const NO_PROJECTS: { name: string; local_path: string; id: string }[] = [];

/**
 * A chat with every repository of the workspace, in its own tab of the assistant — beside, not
 * instead of, the repository chat. It runs in a folder of its own with each repository in reach,
 * and every question carries the repositories as they are (path, branch, and the specification or
 * harness folders the user keeps in them — `src-tauri/src/workspace_chat.rs`). Opened from a chain
 * in Tareas, it also carries that chain's brief, to carry it on.
 *
 * The composer is the repository chat's: engine, thinking level, queue, Stop, dictation, images.
 */
export function WorkspaceChat({
  tabKey,
  workspaceId,
  conversationId,
  fresh,
  focusChainId,
  active,
}: {
  tabKey: string;
  workspaceId: string;
  conversationId: string;
  fresh: boolean;
  focusChainId: string | null;
  active: boolean;
}) {
  const t = useT();
  const locale = useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US";
  const session = useWorkspaceChatStore((s) => s.byConversation[conversationId]) ?? EMPTY_WS_CHAT;
  const draft = useAiPanelStore((s) => s.drafts[tabKey] ?? "");
  const setDraft = (text: string) => useAiPanelStore.getState().setDraft(tabKey, text);
  const cancelling = useAiRunStore((s) => (session.runId ? (s.cancelling[session.runId] ?? false) : false));
  const projects = useWorkspaceStore((s) => s.projectsByWorkspace[workspaceId] ?? NO_PROJECTS);
  const repoCount = projects.length;
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  // The session is on screen: the store's memory cap leaves it alone.
  useEffect(() => pinWsChat(conversationId), [conversationId]);
  useEffect(() => {
    const store = useWorkspaceChatStore.getState();
    store.prepare(conversationId, workspaceId, { focusChainId, fresh });
    if (!fresh) void store.ensureLoaded(conversationId, workspaceId);
  }, [conversationId, workspaceId, fresh, focusChainId]);
  const retryLoad = () => void useWorkspaceChatStore.getState().ensureLoaded(conversationId, workspaceId);
  const loadFailed = !!session.loadError && !session.loaded;
  const loading = !fresh && !session.loaded && !session.loadError;

  // A question refused before it ran comes back to the box.
  useEffect(() => {
    if (session.restored === null) return;
    const text = useWorkspaceChatStore.getState().takeRestored(conversationId);
    if (text) setDraft(draft ? `${text}\n${draft}` : text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.restored, conversationId]);

  // ── What the next turn is told about the workspace ───────────────────────────────────────
  const [snapshot, setSnapshot] = useState<WorkspaceChatSnapshot | null>(null);
  const focus = session.focusChainId || focusChainId || "";
  // A repository added or removed changes what the next turn is told: read it again.
  const projectsKey = projects.map((p) => `${p.id}:${p.local_path}`).join("|");
  useEffect(() => {
    if (!active || session.sending) return;
    let live = true;
    void workspaceChatSnapshot(workspaceId).then(
      (next) => live && setSnapshot(next),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [active, session.sending, workspaceId, projectsKey]);
  const rows = useMemo(() => repoRows(projects, snapshot?.repos), [projects, snapshot?.repos]);
  const scope = useWorkspaceChatStore((s) => s.scopeRepos[conversationId] ?? null);
  const focusChain = useChainStore((s) => (focus ? (s.chains.find((c) => c.id === focus) ?? null) : null));

  // ── Engine, level and role ─────────────────────────────────────────────────────────────────
  const routedProvider = useTaskProvider("chat");
  const routedModel = useAiProviderStore((s) => s.taskModels.chat ?? s.model);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  // The conversation's engine, else the routing.
  const provider = session.provider || routedProvider;
  const model = session.provider ? session.model : routedModel;
  const account =
    session.accountId ??
    resolveAccount({ accounts, taskPins, workspaceDefaults, providerDefaults }, provider, "chat", workspaceId);
  const effortSupported = useEffortSupported(provider, model);
  const pickEngine = (nextProvider: string, nextModel: string, nextAccount?: string) =>
    void useWorkspaceChatStore.getState().setEngine(conversationId, nextProvider, nextModel, nextAccount ?? null);

  // ── Scrolling ──────────────────────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    setShowJump(!atBottom.current);
  };
  const toBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottom.current = true;
    setShowJump(false);
  };
  useLayoutEffect(() => {
    if (active) toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, active]);
  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
    else setShowJump(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.messages.length, session.streamText.length, session.sending]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current && el.clientHeight > 0) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // ── Composer ───────────────────────────────────────────────────────────────────────────────
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useAutosizeTextarea(boxRef, draft, MAX_COMPOSER_HEIGHT);
  /** Where the caret is in the box — what the `@` menu reads the mention being typed from. */
  const [caret, setCaret] = useState(0);
  const mentionRepos = useMemo(() => projects.map((p) => ({ name: p.name, path: p.local_path })), [projects]);
  const mentions = useMentions({
    repos: mentionRepos,
    workspaceId,
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
  /** The skill staged for the next question — dropped when the engine changes, as in the repository chat. */
  const [skill, setSkill] = useState<SkillPick | null>(null);
  useEffect(() => {
    setSkill(null);
  }, [provider]);
  const cavemanLevels = useWorkspaceChatStore((s) => s.cavemanLevels);
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null);
  const canExport = session.persisted && session.messages.length > 0;
  const runAppCommand = (command: ChatAppCommand, args = "") => {
    if (command === "caveman") {
      // The backend decides what a word means; an unknown one is said out loud, never rounded.
      void useWorkspaceChatStore
        .getState()
        .applyCaveman(conversationId, args)
        .then((applied) => {
          if (applied) return;
          const known = useWorkspaceChatStore.getState().cavemanLevels;
          pushErrorToast(t("chat.cavemanUnknown", { level: args.trim(), levels: known.join(", ") }));
        });
    } else if (command === "new") {
      openWorkspaceChat(workspaceId);
    } else if (command === "clear") {
      void useWorkspaceChatStore.getState().clearContext(conversationId);
    } else if (command === "export" && canExport) {
      const rect = boxRef.current?.getBoundingClientRect();
      setExportMenu({ x: rect ? rect.left + 8 : 16, y: rect ? rect.top - 8 : 16 });
    }
  };
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const command = appCommandFor(text, "workspace");
    if (command) {
      useWorkspaceChatStore.getState().cancelEdit(conversationId);
      setDraft("");
      runAppCommand(command.id, command.args);
      return;
    }
    if (useWorkspaceChatStore.getState().editing[conversationId]) {
      // The box keeps its text until the thread was cut (the user may decline, or the cut be refused).
      void useWorkspaceChatStore
        .getState()
        .submitEdit(conversationId, text, { skill })
        .then((sent) => {
          if (!sent) return;
          setDraft("");
          setSkill(null);
          useAiPanelStore.getState().markChatStarted(tabKey);
          toBottom();
        });
      return;
    }
    useWorkspaceChatStore.getState().submit(conversationId, text, { skill });
    setDraft("");
    setSkill(null);
    useAiPanelStore.getState().markChatStarted(tabKey);
    toBottom();
  };
  /**
   * An option picked on the question card at the end of an answer, sent as the next message.
   *
   * The card is drawn by the bubble either way; without this it drew its options disabled, so a
   * turn that ended by asking something offered three buttons that did nothing and the only way
   * through was to retype the answer (user report, 2026-10-19: "tampoco me deja hacer clic sobre
   * eso para responder"). The repository chat has had this since the card existed — this is the
   * same wiring for the workspace one.
   */
  const answerQuestion = (text: string) => {
    useWorkspaceChatStore.getState().submit(conversationId, text);
    useAiPanelStore.getState().markChatStarted(tabKey);
    toBottom();
  };

  /** «Ejecutar el plan»: plan mode off, and the go-ahead as the next question. */
  const runPlan = () => {
    useWorkspaceChatStore.getState().setPlan(conversationId, false);
    useWorkspaceChatStore.getState().submit(conversationId, t("assistant.runPlanMessage"));
    useAiPanelStore.getState().markChatStarted(tabKey);
    toBottom();
  };
  // ── Context ───────────────────────────────────────────────────────────────────────────────
  // The same gauge the repository chat carries, on the same two sources: the engine's own figure
  // when it reports one (Claude), and an estimate over the turns since the last `/clear` when it
  // does not. A chat that spans several repositories fills a window faster than one that does not,
  // so this is if anything the one that needed it more.
  const windowByModel = useConversationStore((s) => s.windowByModel);
  const compacting = useWorkspaceChatStore((s) => s.compacting[conversationId] ?? false);
  const meterModel = session.model || model;
  useEffect(() => {
    if (meterModel) useConversationStore.getState().ensureContextWindow(meterModel);
  }, [meterModel]);
  const wasSending = useRef(session.sending);
  useEffect(() => {
    if (wasSending.current && !session.sending && meterModel) useConversationStore.getState().ensureContextWindow(meterModel, true);
    wasSending.current = session.sending;
  }, [session.sending, meterModel]);
  const contextReading = useMemo<ContextReading | undefined>(() => {
    if (session.messages.length === 0) return undefined;
    // The turns since the last reset (a `/clear`, or a change of account): what a fresh engine
    // session is told again. A reset still waiting for its question leaves nothing to count, and
    // what the engine measured described the context before it.
    const startsAt = session.contextResets.reduce((at, reset) => Math.max(at, reset.turn), -1);
    const lastTurn = session.messages[session.messages.length - 1]?.turn ?? -1;
    const waiting = startsAt > lastTurn;
    const counted = session.messages
      .filter((m) => m.turn >= startsAt)
      .map((m) => m.content)
      .join("\n\n");
    const measured = waiting ? null : session.contextTokens;
    const estimated = estimateTokens(counted);
    return {
      // An earlier turn's figure is a floor once the thread has talked on: see `ChatView`.
      tokens: measured === null ? estimated : session.contextStale ? Math.max(measured, estimated) : measured,
      measured: measured !== null,
      // A measurement from an earlier turn is drawn as an approximation rather than as a fact.
      stale: waiting ? false : session.contextStale,
      conversationTokens: estimated,
      window: meterModel ? (windowByModel[meterModel] ?? null) : null,
      resumes: providerCapabilities(session.provider || provider).resumesSessions && Boolean(session.engineSessionId) && !waiting,
      compactedTurns: 0,
      autoCompacts: false,
      summary: "",
      compacting,
      // The app's own compaction, which works on any engine, and not the word `/compact` sent as a
      // question — this chat replays its prefix rather than resuming a CLI session, so that word
      // reached the model and was answered as the question it looked like.
      onCompact: session.persisted ? () => void useWorkspaceChatStore.getState().compact(conversationId) : undefined,
      onUncompact: () => {},
    };
  }, [session.messages, session.contextResets, session.contextTokens, session.contextStale, session.engineSessionId, session.provider, session.persisted, provider, meterModel, windowByModel, conversationId, compacting]);

  /** The `/` menu is open while the draft is one token that begins with a slash. */
  const slash = draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1).toLowerCase() : null;
  const menuOpen = slash !== null && !slash.includes(" ");
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useChatFind({ rootRef, contentRef, scrollRef });
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => registerDictationSend(boxRef.current, () => submitRef.current()));
  const dictating = useDictatingHere(boxRef);
  const textMenu = useTextMenu();

  // ── Attachments ───────────────────────────────────────────────────────────────────────────
  // The repository chat's rule: any file, picked, pasted or dropped onto the composer, copied under
  // this conversation's folder and named to the engine with the next question, which reads it with
  // its own file-reading tool. `readsImages` says what the chip may promise about an image, not
  // whether attaching is offered.
  const readsImages = useModelReadsImages(provider, model);
  const staged = useWorkspaceChatStore((s) => s.attachments[conversationId]) ?? NO_FILES;
  const attachPaths = async (paths: string[]) => {
    for (const path of paths) await useWorkspaceChatStore.getState().attachFilePath(conversationId, path);
    boxRef.current?.focus();
  };
  const attachFiles = async () => {
    const picked = await openDialog({ multiple: true });
    await attachPaths(typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : []);
  };
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
      useWorkspaceChatStore.getState().attachFileBytes(conversationId, `pegado.${extension}`, new Uint8Array(buffer)),
    );
  };
  const composerRef = useRef<HTMLDivElement>(null);
  const dropOver = useImageDrop(
    composerRef,
    (paths) => {
      // An image dropped on an engine that cannot look at one is kept, not refused: the file is
      // still there to be read, and the notice says what will happen to it rather than pretending
      // the drop failed.
      if (!readsImages && paths.some(isImagePath)) {
        useToastStore.getState().pushToast(t("chat.attachImageBlind", { provider: providerDisplayLabel(provider, t) }), "info");
      }
      void attachPaths(paths);
    },
    () => true,
  );

  // ── Turn actions ──────────────────────────────────────────────────────────────────────────
  /** «Editar y reenviar»: the question whose text is in the box. Sending it replaces the thread from
   *  that question on (`workspaceChatStore.submitEdit`), as the repository chat's «Editar» does. */
  const editing = useWorkspaceChatStore((s) => s.editing[conversationId]) ?? null;
  useEffect(() => {
    if (!draft.trim()) useWorkspaceChatStore.getState().cancelEdit(conversationId);
  }, [draft, conversationId]);
  /** The handlers the bubbles' actions call, read through a ref so the actions can be memoised on
   *  the transcript: `ChatMessageBubble` compares its props by reference, and a fresh object per
   *  render would re-draw every turn on every streamed token of the one being written. */
  const handlers = useRef({ setDraft, pickEngine, answerQuestion, provider });
  handlers.current = { setDraft, pickEngine, answerQuestion, provider };
  const actionsByMessage = useMemo(
    () =>
      session.messages.map((message, index): ChatBubbleActions | undefined => {
        const canAct = !session.sending;
        const question = session.messages[index - 1];
        // Ask the same question again — on a failed turn this is the retry.
        const askAgain =
          canAct && message.role === "assistant" && question?.role === "user"
            ? () => {
                useWorkspaceChatStore.getState().submit(conversationId, question.content);
                useAiPanelStore.getState().markChatStarted(tabKey);
                toBottom();
              }
            : undefined;
        if (message.isError) {
          return { onPickModel: (next) => handlers.current.pickEngine(handlers.current.provider, next), onRegenerate: askAgain };
        }
        if (message.role === "user") {
          return canAct
            ? {
                onEdit: () => {
                  handlers.current.setDraft(message.content);
                  useWorkspaceChatStore.getState().beginEdit(conversationId, index);
                  requestAnimationFrame(() => boxRef.current?.focus());
                },
              }
            : undefined;
        }
        return {
          onRegenerate: askAgain,
          onBranch:
            canAct && session.persisted && !message.isCancelled
              ? () => void useWorkspaceChatStore.getState().branchAt(conversationId, message.turn)
              : undefined,
          // Only the last answer, and only while nothing is running: an option clicked on an older
          // card would be answering a question the conversation moved past.
          onAnswer: index === session.messages.length - 1 && canAct ? (text: string) => handlers.current.answerQuestion(text) : undefined,
        };
      }),
    // `toBottom` only touches refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.messages, session.sending, conversationId, tabKey],
  );
  const lastTurn = session.messages[session.messages.length - 1]?.turn ?? -1;
  /** Resets whose question has not been asked yet: drawn at the end. */
  const waitingResets = useMemo(() => session.contextResets.filter((reset) => reset.turn > lastTurn), [session.contextResets, lastTurn]);

  const queueKey = wsChatQueueKey(conversationId);
  const queuedMessages = useChatQueue(queueKey);
  const queueHeld = useChatQueueHold(queueKey);
  const queue = useMemo<ComposerQueue>(
    () => ({
      items: queuedMessages,
      held: queueHeld,
      busy: session.sending,
      onRemove: (id) => useWorkspaceChatStore.getState().discardQueued(conversationId, id),
      onEdit: (id) => {
        const item = useWorkspaceChatStore.getState().editQueued(conversationId, id);
        if (!item) return null;
        const current = useAiPanelStore.getState().drafts[tabKey] ?? "";
        useAiPanelStore.getState().setDraft(tabKey, current.trim() ? `${item.text}\n${current}` : item.text);
        boxRef.current?.focus();
        return item;
      },
      onResume: () => useWorkspaceChatStore.getState().resumeQueue(conversationId),
      onDiscardAll: () => discardChatQueue(queueKey),
    }),
    [queuedMessages, queueHeld, session.sending, conversationId, tabKey, queueKey],
  );

  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "");
  /** The workspace's project a turn's repository folder belongs to — «Abrir» switches to it. */
  const projectOfPath = (path: string) => projects.find((p) => samePath(p.local_path, path));

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <ChatFindBar find={find} />
      {/* Outside the scroller on purpose: this strip says which repositories the chat can see, and
          carries find, export, history and "new chat". Inside it, it was the first thing to scroll
          away — so a conversation long enough to be worth searching was exactly the one whose
          search button had gone. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
        <ReposChip
          rows={rows}
          total={snapshot?.repoCount ?? repoCount}
          scope={scope}
          onScope={(ids) => useWorkspaceChatStore.getState().setScope(conversationId, ids)}
        />
        {focusChain && (
          <span className="inline-flex min-w-0 items-center gap-1 truncate" title={t("assistant.wsChatFocusHint")}>
            <Link2 size={10} className="shrink-0" />
            <span className="truncate">{focusChain.title}</span>
          </span>
        )}
        {session.plan && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)] px-1.5 py-px text-[10.5px] font-semibold text-[var(--cf-accent)]"
            title={t("assistant.planModeHint")}
          >
            <ListChecks size={9} />
            {t("assistant.planModeBadge")}
          </span>
        )}
        <span className="ml-auto" />
        {session.messages.length > 0 && (
          <button
            type="button"
            onClick={find.show}
            title={t("chat.find")}
            aria-label={t("chat.find")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
          >
            <Search size={12} />
          </button>
        )}
        {canExport && (
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
        <HistoryMenu workspaceId={workspaceId} current={conversationId} />
        <button
          type="button"
          onClick={() => openWorkspaceChat(workspaceId)}
          title={t("assistant.wsChatNew")}
          aria-label={t("assistant.wsChatNew")}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <SquarePen size={12} />
        </button>
      </div>
      <div ref={scrollRef} onScroll={onScroll} tabIndex={-1} onContextMenu={textMenu.onText} className="cf-paper-scroll relative min-h-0 flex-1 overflow-auto px-3 pb-3 pt-2.5 outline-none">
        {exportMenu && (
          <ContextMenu
            x={exportMenu.x}
            y={exportMenu.y}
            items={exportMenuItems(
              (format, traces) => void exportChatConversation(conversationId, format, traces, session.title || workspaceName),
            )}
            onClose={() => setExportMenu(null)}
          />
        )}

        <div ref={contentRef} className="space-y-2.5 wrap-anywhere">
          {loading && (
            <p role="status" className="flex items-center justify-center gap-1.5 pt-10 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={13} className="animate-spin" />
              {t("assistant.wsChatLoading")}
            </p>
          )}
          {loadFailed && (
            <div role="alert" className="mx-auto mt-10 flex max-w-[320px] flex-col items-center gap-2 text-center">
              <AlertCircle size={18} className="text-[var(--cf-danger)]" />
              <p className="text-[12.5px] text-[var(--cf-text)]">{t("assistant.wsChatLoadFailed")}</p>
              <p className="max-h-16 overflow-hidden text-[11px] text-[var(--cf-text-muted)]">{session.loadError}</p>
              <button
                type="button"
                onClick={retryLoad}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--cf-border)] px-2.5 py-1 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <RotateCcw size={11} />
                {t("ai.retryRun")}
              </button>
            </div>
          )}
          {session.messages.map((message, i) => {
            const day = dayDivider(message, session.messages[i - 1], locale);
            return (
              <Fragment key={message.id}>
                {day && (
                  <div className="flex items-center gap-2 pt-1.5">
                    <div className="h-px flex-1 bg-[var(--cf-border)]" />
                    <span className="text-[10.5px] text-[var(--cf-text-muted)]">{day}</span>
                    <div className="h-px flex-1 bg-[var(--cf-border)]" />
                  </div>
                )}
                {/* Above the question the engine started over at (`/clear`, or another account). */}
                {session.messages[i - 1]?.turn !== message.turn &&
                  session.contextResets
                    .filter((reset) => reset.turn === message.turn)
                    .map((reset) => <ResetLine key={`${reset.reason}-${reset.turn}`} reset={reset} />)}
                <ChatMessageBubble
                  message={message}
                  sessionId={session.engineSessionId}
                  actions={actionsByMessage[i]}
                />
                {message.role === "assistant" && message.context && <ContextSources sources={message.context} />}
                {message.role === "assistant" && <TurnNotes message={message} />}
                {message.role === "assistant" &&
                  message.changes?.map((change) => (
                    <TurnReview
                      key={change.repoPath}
                      repoPath={change.repoPath}
                      repoLabel={change.repo}
                      changes={{ checkpointId: change.checkpointId, paths: change.paths }}
                      canOpen={!!projectOfPath(change.repoPath)}
                      openProjectId={projectOfPath(change.repoPath)?.id === activeProjectId ? undefined : projectOfPath(change.repoPath)?.id}
                    />
                  ))}
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
              </Fragment>
            );
          })}
          {waitingResets.map((reset) => (
            <ResetLine key={`${reset.reason}-${reset.turn}`} reset={reset} />
          ))}
          {session.sending && session.runId && (
            <AiRunLog
              runId={session.runId}
              running
              startedAt={session.runStartedAt}
              answering={!!session.streamText}
              showStop={false}
              onRetry={() => useWorkspaceChatStore.getState().retryTurn(conversationId)}
            >
              {session.streamText && <ChatMessageBubble message={PENDING_SHELL} streamText={session.streamText} />}
            </AiRunLog>
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
          </button>
        )}
        {editing && (
          // Said out loud: the box looks the same either way, and this one replaces the thread from
          // that question on.
          <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] text-[var(--cf-text-muted)]">
            <Pencil size={10} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t("chat.editingTurn", { n: editing.fromTurn })}</span>
            <button
              type="button"
              onClick={() => {
                useWorkspaceChatStore.getState().cancelEdit(conversationId);
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
            surface="workspace"
            scope={{ accountId: account ?? "system", workspaceId, projectId: null, conversationId: session.persisted ? conversationId : null }}
            onRunApp={(command) => {
              setDraft("");
              runAppCommand(command);
            }}
            onInsert={(name) => {
              setDraft(`${name} `);
              boxRef.current?.focus();
            }}
            onPickSkill={(picked) => {
              if (!picked.model_invocable && provider === "claude") {
                setDraft(`/${picked.name} `);
              } else {
                setSkill({ name: picked.name, source: picked.source, path: picked.path });
                setDraft("");
              }
              boxRef.current?.focus();
            }}
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
            providerLabel={providerDisplayLabel(provider, t)}
            onRemove={(id) => useWorkspaceChatStore.getState().removeAttachment(conversationId, id)}
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
              if (mentions.onKeyDown(e)) return;
              // Esc leaves an edit: the box goes back to a new question, empty.
              if (e.key === "Escape" && editing && !menuOpen && !e.nativeEvent.isComposing) {
                e.preventDefault();
                useWorkspaceChatStore.getState().cancelEdit(conversationId);
                setDraft("");
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              session.sending
                ? t("chat.queuePlaceholder")
                : session.plan
                  ? t("assistant.planPlaceholder")
                  : t("assistant.wsChatPlaceholder", { workspace: workspaceName })
            }
            aria-label={t("assistant.wsChatPlaceholder", { workspace: workspaceName })}
            className="max-h-[180px] resize-none bg-transparent px-1.5 py-1 text-[13px] leading-relaxed outline-none placeholder:text-[var(--cf-text-muted)]"
          />
          {dictating ? (
            <div className="flex items-center gap-1.5 px-0.5">
              <DictationBar />
            </div>
          ) : (
            <div className="@container flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5">
              <ChatModelPicker
                liveModel={session.model || null}
                chatActive={session.messages.length > 0}
                bound={{ provider, model, account }}
                onPick={pickEngine}
              />
              <EffortPicker
                compact
                value={session.effort}
                supported={effortSupported}
                onPick={(level) => void useWorkspaceChatStore.getState().setEffort(conversationId, level)}
              />
              <AnswerLengthPicker compact />
              <CavemanChip
                level={session.cavemanLevel}
                levels={cavemanLevels}
                onPick={(level) => void useWorkspaceChatStore.getState().setCaveman(conversationId, level)}
              />
              {contextReading && <ContextMeter reading={contextReading} />}
              {/* Plan mode: read-only turns that answer with a plan, then «Ejecutar el plan». */}
              <button
                type="button"
                onClick={() => useWorkspaceChatStore.getState().setPlan(conversationId, !session.plan)}
                aria-pressed={session.plan}
                aria-label={t("assistant.planMode")}
                title={t("assistant.planModeHint")}
                className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] ${
                  session.plan
                    ? "bg-[color-mix(in_oklab,var(--cf-accent)_14%,transparent)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                }`}
              >
                <ListChecks size={13} />
                {/* The label gives way when the panel is narrow: the icon, title and name stay. */}
                <span className="hidden @[26rem]:inline">{t("assistant.planMode")}</span>
              </button>
              {/* The CLI's own MCP servers, switched for this conversation once it exists. */}
              <McpMenu
                provider={provider}
                scope={{ accountId: account ?? "system", workspaceId, conversationId: session.persisted ? conversationId : null }}
              />
              {/* Always offered: a file is something every engine can read, whatever it can see. */}
              <button
                type="button"
                onClick={() => void attachFiles()}
                title={readsImages ? t("chat.attach") : t("chat.attachTextOnly", { provider: providerDisplayLabel(provider, t) })}
                aria-label={t("chat.attach")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
              >
                <Paperclip size={13} />
              </button>
              <span className="flex-1" />
              {session.sending ? (
                <>
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
                    type="button"
                    onClick={() => useWorkspaceChatStore.getState().stop(conversationId)}
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
    </div>
  );
}

/** This workspace's chats, newest first: open one, or delete it. */
function HistoryMenu({ workspaceId, current }: { workspaceId: string; current: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const list = useWorkspaceChatStore((s) => s.listByWorkspace[workspaceId] ?? EMPTY_WS_LIST);
  const locale = useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US";
  useEffect(() => {
    if (open) void useWorkspaceChatStore.getState().loadList(workspaceId);
  }, [open, workspaceId]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("assistant.wsChatHistory")}
        aria-label={t("assistant.wsChatHistory")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <History size={12} />
      </button>
      {open && (
        <div role="menu" className={`absolute right-0 top-full z-40 mt-1 max-h-80 w-72 overflow-y-auto ${popoverClass}`}>
          {list.length === 0 && <p className="px-2.5 py-2 text-[12px] text-[var(--cf-text-faint)]">{t("assistant.wsChatNoHistory")}</p>}
          {list.map((row) => (
            <div key={row.id} className="group flex items-center">
              <button
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  openWorkspaceChat(workspaceId, { conversationId: row.id });
                }}
                className={menuRowClass(row.id === current, "min-w-0 flex-1")}
              >
                <span className="min-w-0">
                  <span className="block truncate">{row.title || t("assistant.newChat")}</span>
                  <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">
                    {new Date(row.updatedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void confirmAction(t("assistant.wsChatDeleteConfirm", { name: row.title || t("assistant.newChat") })).then((ok) => {
                    if (!ok) return;
                    // Closed only when it was deleted: a running chat is refused, and its tab stays.
                    void useWorkspaceChatStore.getState().remove(row.id).then((deleted) => {
                      if (deleted) useAiPanelStore.getState().close(`wschat:${row.id}`, workspaceId);
                    });
                  });
                }}
                title={t("common.delete")}
                aria-label={t("common.delete")}
                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] opacity-0 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)] focus:opacity-100 group-hover:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Two spellings of one folder: a trailing separator is not a different repository. */
function samePath(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, "") === b.replace(/[/\\]+$/, "");
}

/** The line drawn above the question the engine started over at. */
function ResetLine({ reset }: { reset: ContextReset }) {
  const t = useT();
  const account = reset.reason === "account";
  const label = account ? t("assistant.accountBreak") : t("assistant.contextCleared");
  const rule = account ? "bg-[color-mix(in_oklab,var(--cf-warning)_40%,transparent)]" : "bg-[var(--cf-border)]";
  const Icon = account ? UsersRound : Eraser;
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-2 py-1">
      <div className={`h-px flex-1 ${rule}`} />
      <span className={`flex min-w-0 items-center gap-1 text-[11px] font-medium ${account ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"}`}>
        <Icon size={11} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <div className={`h-px flex-1 ${rule}`} />
    </div>
  );
}

/**
 * «n repos» — which repositories the chat can see, and which of them this conversation is about.
 *
 * Shows `ready/total` in the warning colour when a folder is gone or is no repository; the popover
 * lists every repository with its branch and state, and a checkbox each to limit the conversation
 * to some of them (`scope`: project ids, `null` for all). Opens on click or Enter/Space, closes on
 * Escape or a click outside.
 */
function ReposChip({
  rows,
  total,
  scope,
  onScope,
}: {
  rows: RepoRow[];
  total: number;
  scope: string[] | null;
  onScope: (ids: string[] | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const ready = reposReady(rows);
  const problems = rows.length - ready;
  const picked = scope ? rows.filter((row) => scope.includes(row.id)) : rows;
  const label =
    problems > 0
      ? t("assistant.wsChatReposPartial", { on: ready, n: rows.length })
      : scope && picked.length < rows.length
        ? t("assistant.wsChatReposScoped", { on: picked.length, n: rows.length })
        : t("assistant.wsChatRepos", { n: rows.length > 0 ? rows.length : total });
  const toggle = (id: string) => {
    const current = scope ?? rows.map((row) => row.id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    // Everything ticked is «all»; nothing ticked would answer about nothing, so it is refused.
    if (next.length === 0) return;
    onScope(next.length === rows.length ? null : next);
  };
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}. ${t("assistant.wsChatReposOpen")}`}
        title={problems > 0 ? t("assistant.wsChatReposProblem") : t("assistant.wsChatHint")}
        className={`inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-[var(--cf-hover)] ${
          problems > 0 ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        }`}
      >
        <FolderGit2 size={11} className="shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <div role="dialog" aria-label={t("assistant.wsChatReposTitle")} className={`absolute left-0 top-full z-40 mt-1 max-h-72 w-72 max-w-[85vw] overflow-y-auto ${popoverClass}`}>
          {rows.length === 0 && <p className="px-2.5 py-2 text-[12px] text-[var(--cf-text-faint)]">{t("assistant.wsChatReposNone")}</p>}
          {rows.map((row) => {
            const checked = !scope || scope.includes(row.id);
            return (
              <label key={row.id} className="flex cursor-pointer items-start gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--cf-hover)]">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={row.state === "missing"}
                  onChange={() => toggle(row.id)}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[var(--cf-text)]" title={row.path}>{row.name}</span>
                  <span
                    className={`block truncate text-[11px] ${row.state === "ok" ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-warning)]"}`}
                  >
                    {row.state === "missing"
                      ? t("assistant.wsChatRepoMissing")
                      : row.state === "notRepo"
                        ? t("assistant.wsChatRepoNotGit")
                        : row.branch || row.path}
                  </span>
                </span>
              </label>
            );
          })}
          {scope && (
            <button
              type="button"
              onClick={() => onScope(null)}
              className="w-full border-t border-[var(--cf-border)] px-2.5 py-1.5 text-left text-[11.5px] text-[var(--cf-accent)] hover:underline"
            >
              {t("assistant.wsChatReposAll")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The quiet lines under an answer: what the turn cost, and folders where its edits cannot be undone. */
function TurnNotes({ message }: { message: WsChatMessage }) {
  const t = useT();
  const notes = turnNotes(message, t);
  if (!notes.usage && !notes.unprotected) return null;
  return (
    <div className="space-y-0.5 px-0.5">
      {notes.usage && <p className="text-[10.5px] text-[var(--cf-text-faint)]">{notes.usage}</p>}
      {notes.unprotected && (
        <p className="flex items-start gap-1 text-[11px] text-[var(--cf-warning)]" title={message.unprotectedDirs?.join("\n")}>
          <AlertCircle size={11} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{notes.unprotected}</span>
        </p>
      )}
    </div>
  );
}
