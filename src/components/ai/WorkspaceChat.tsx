import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Check, Download, FolderGit2, History, Link2, ListChecks, ListPlus, Paperclip, Play, Search, SquarePen, Square, Trash2, Workflow } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AiRunLog } from "./AiRunLog";
import { ChatModelPicker } from "./ChatModelPicker";
import { menuRowClass, useDismiss } from "./docParts";
import { AttachmentBar } from "../chat/AttachmentBar";
import { AnswerLengthPicker } from "../chat/AnswerLengthPicker";
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
import { ChatMessageBubble, dayDivider } from "../chat/ChatMessageBubble";
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
import { listWorkspaceAgents } from "../../lib/tauri/commands";
import { workspaceChatSnapshot, type ChatAttachment, type SkillPick, type WorkspaceChatSnapshot } from "../../lib/tauri/chatCommands";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useAiAccountsStore } from "../../state/aiAccountsStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useChainStore } from "../../state/chainStore";
import { useChatQueue, useChatQueueHold } from "../../state/chatQueueStore";
import { confirmAction } from "../../state/confirmStore";
import { useConversationStore } from "../../state/conversationStore";
import { registerDictationSend } from "../../state/dictationStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { EMPTY_WS_CHAT, EMPTY_WS_LIST, useWorkspaceChatStore, wsChatQueueKey } from "../../state/workspaceChatStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { WorkspaceAgent } from "../../types/domain";

const STICK_PX = 48;
const MAX_COMPOSER_HEIGHT = 180;
const PENDING_SHELL = { role: "assistant" as const, content: "" };
const NO_AGENTS: WorkspaceAgent[] = [];
const NO_FILES: ChatAttachment[] = [];
const NO_PROJECTS: { name: string; local_path: string; id: string }[] = [];

/**
 * A chat with every repository of the workspace, in its own tab of the assistant — beside, not
 * instead of, the repository chat. It runs in a folder of its own with each repository in reach,
 * and every question carries the workspace's live state: the repositories and the SDD/Harness work
 * in flight (`src-tauri/src/workspace_chat.rs`), so a chain, a story or a hybrid run can be asked
 * about and carried on from here. One of the workspace's agents can be put in charge of it.
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

  useEffect(() => {
    const store = useWorkspaceChatStore.getState();
    store.prepare(conversationId, workspaceId, { focusChainId });
    if (!fresh) void store.ensureLoaded(conversationId, workspaceId);
  }, [conversationId, workspaceId, fresh, focusChainId]);

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
  useEffect(() => {
    if (!active || session.sending) return;
    let live = true;
    void workspaceChatSnapshot(workspaceId, focus || null).then(
      (next) => live && setSnapshot(next),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [active, session.sending, workspaceId, focus]);
  const focusChain = useChainStore((s) => (focus ? (s.chains.find((c) => c.id === focus) ?? null) : null));

  // ── Engine, level and role ─────────────────────────────────────────────────────────────────
  const [agents, setAgents] = useState<WorkspaceAgent[]>(NO_AGENTS);
  useEffect(() => {
    let live = true;
    void listWorkspaceAgents(workspaceId).then(
      (list) => live && setAgents(list.filter((agent) => agent.enabled)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const agent = session.agentId ? (agents.find((a) => a.id === session.agentId) ?? null) : null;
  const routedProvider = useTaskProvider("chat");
  const routedModel = useAiProviderStore((s) => s.taskModels.chat ?? s.model);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  // The agent in charge answers on its own engine; otherwise the conversation's, else the routing.
  const provider = agent?.provider || session.provider || routedProvider;
  const model = agent ? agent.model : session.provider ? session.model : routedModel;
  const account =
    (agent ? agent.account_id : session.accountId) ??
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
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null);
  const canExport = session.persisted && session.messages.length > 0;
  const runAppCommand = (command: ChatAppCommand) => {
    if (command === "new") {
      openWorkspaceChat(workspaceId);
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
      setDraft("");
      runAppCommand(command.id);
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
    // The whole thread: this chat has no `/clear`, so there is no point to count from but the
    // start — unlike the repository chat, which slices from its last reset.
    const counted = session.messages.map((m) => m.content).join("\n\n");
    const measured = session.contextTokens;
    const estimated = estimateTokens(counted);
    return {
      tokens: measured ?? estimated,
      measured: measured !== null,
      // A measurement from an earlier turn is drawn as an approximation rather than as a fact.
      stale: session.contextStale,
      conversationTokens: estimated,
      window: meterModel ? (windowByModel[meterModel] ?? null) : null,
      resumes: providerCapabilities(session.provider || provider).resumesSessions && Boolean(session.engineSessionId),
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
  }, [session.messages, session.contextTokens, session.contextStale, session.engineSessionId, session.provider, session.persisted, provider, meterModel, windowByModel, conversationId, compacting]);

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
    }),
    [queuedMessages, queueHeld, session.sending, conversationId, tabKey],
  );

  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "");
  const activePath = projects.find((p) => p.id === activeProjectId)?.local_path ?? null;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <ChatFindBar find={find} />
      {/* Outside the scroller on purpose: this strip says which repositories the chat can see, and
          carries find, export, history and "new chat". Inside it, it was the first thing to scroll
          away — so a conversation long enough to be worth searching was exactly the one whose
          search button had gone. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
        <span
          className="inline-flex min-w-0 items-center gap-1 truncate"
          title={snapshot?.text ?? t("assistant.wsChatHint")}
        >
          <FolderGit2 size={11} className="shrink-0" />
          <span className="truncate">{t("assistant.wsChatRepos", { n: snapshot?.repos ?? repoCount })}</span>
        </span>
        {snapshot && snapshot.inFlight > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--cf-accent)_13%,transparent)] px-1.5 py-px text-[10.5px] font-semibold text-[var(--cf-accent)]"
            title={snapshot.text}
          >
            <Workflow size={9} />
            {t("assistant.wsChatInFlight", { n: snapshot.inFlight })}
          </span>
        )}
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
      <div ref={scrollRef} onScroll={onScroll} tabIndex={-1} onContextMenu={textMenu.onText} className="relative min-h-0 flex-1 overflow-auto px-3 pb-3 pt-2.5 outline-none">
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
                <ChatMessageBubble
                  message={message}
                  sessionId={session.engineSessionId}
                  actions={{
                    ...(message.isError && !agent ? { onPickModel: (next: string) => pickEngine(provider, next) } : {}),
                    // Only the last answer, and only while nothing is running: an option clicked on
                    // an older card would be answering a question the conversation moved past.
                    onAnswer:
                      message.role === "assistant" &&
                      !message.isError &&
                      i === session.messages.length - 1 &&
                      !session.sending
                        ? answerQuestion
                        : undefined,
                  }}
                />
                {message.role === "assistant" &&
                  message.changes?.map((change) => (
                    <TurnReview
                      key={change.repoPath}
                      repoPath={change.repoPath}
                      repoLabel={change.repo}
                      changes={{ checkpointId: change.checkpointId, paths: change.paths }}
                      canOpen={change.repoPath === activePath}
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
          {session.sending && session.runId && (
            <AiRunLog
              runId={session.runId}
              running
              startedAt={session.runStartedAt}
              answering={!!session.streamText}
              showStop={false}
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
            <div className="flex items-center gap-1.5 px-0.5">
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
              {contextReading && <ContextMeter reading={contextReading} />}
              {/* Plan mode: read-only turns that answer with a plan, then «Ejecutar el plan». */}
              <button
                type="button"
                onClick={() => useWorkspaceChatStore.getState().setPlan(conversationId, !session.plan)}
                aria-pressed={session.plan}
                title={t("assistant.planModeHint")}
                className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] ${
                  session.plan
                    ? "bg-[color-mix(in_oklab,var(--cf-accent)_14%,transparent)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                }`}
              >
                <ListChecks size={13} />
                {t("assistant.planMode")}
              </button>
              {/* The CLI's own MCP servers, switched for this conversation once it exists. */}
              <McpMenu
                provider={provider}
                scope={{ accountId: account ?? "system", workspaceId, conversationId: session.persisted ? conversationId : null }}
              />
              {agents.length > 0 && (
                <AgentMenu
                  agents={agents}
                  current={agent}
                  onPick={(id) => void useWorkspaceChatStore.getState().setAgent(conversationId, id)}
                />
              )}
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

/** The SDD/Harness agent in charge of this chat — none, or one of the workspace's enabled ones. */
function AgentMenu({
  agents,
  current,
  onPick,
}: {
  agents: WorkspaceAgent[];
  current: WorkspaceAgent | null;
  onPick: (agentId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const pick = (id: string) => {
    setOpen(false);
    onPick(id);
  };
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={current ? t("assistant.wsChatAgentOn", { agent: current.name }) : t("assistant.wsChatAgentHint")}
        aria-label={t("assistant.wsChatAgent")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-6 max-w-[140px] items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-[var(--cf-hover)] ${
          current ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        }`}
      >
        <Bot size={13} className="shrink-0" />
        {current && <span className="min-w-0 truncate">{current.name}</span>}
      </button>
      {open && (
        <div role="menu" className={`absolute bottom-full right-0 z-40 mb-1 w-60 max-w-[calc(100vw-16px)] ${popoverClass}`}>
          <button role="menuitem" onClick={() => pick("")} className={menuRowClass(!current)}>
            <Check size={13} className={`mt-0.5 shrink-0 ${current ? "invisible" : ""}`} />
            <span className="min-w-0 truncate">{t("assistant.wsChatNoAgent")}</span>
          </button>
          {agents.map((agent) => (
            <button key={agent.id} role="menuitem" onClick={() => pick(agent.id)} className={menuRowClass(current?.id === agent.id)}>
              <Check size={13} className={`mt-0.5 shrink-0 ${current?.id === agent.id ? "" : "invisible"}`} />
              <span className="min-w-0">
                <span className="block truncate">{agent.name}</span>
                <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]">
                  {[agent.role, agent.provider, agent.model].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
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
                    void useWorkspaceChatStore.getState().remove(row.id).then(() => {
                      useAiPanelStore.getState().close(`wschat:${row.id}`, workspaceId);
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
