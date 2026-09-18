import { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { FolderGit2, MessagesSquare, Pencil, ShieldCheck } from "lucide-react";
import { ChatTranscript } from "./ChatTranscript";
import { ChatComposer } from "./ChatComposer";
import { ConversationSidebar } from "./ConversationSidebar";
import { GroupView } from "./GroupView";
import { COLUMN_GUTTER, READING_COLUMN } from "./chatChrome";
import type { ChatAppCommand } from "./CommandMenu";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { openTerminal, writeFileBytes } from "../../lib/tauri/commands";
import { chatAttachBytes, chatAttachFile, type ChatAttachment } from "../../lib/tauri/chatCommands";
import { EMPTY_CONVERSATION, useConversationStore } from "../../state/conversationStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useUiStore } from "../../state/uiStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { useWindowStore } from "../../state/windowStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/** One shared empty array, so a conversation with no attachments hands the composer the *same*
 *  reference on every render. A fresh `[]` would be a new prop each time and would defeat every
 *  memo below it. */
const EMPTY_ATTACHMENTS: ChatAttachment[] = [];

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
  const effortSupported = effortProviders.includes(provider);
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

  const sidebarWidth = useLayoutStore((s) => s.sizes.chatSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const openSettings = useUiStore((s) => s.openSettings);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);

  const [draft, setDraft] = useState("");
  /** The turn whose text is sitting in the composer for a second attempt. Held only so the banner
   *  above the composer can say which one — the send itself is an ordinary send, because nothing
   *  here can rewind a turn. `null` for an ordinary message, which is almost always. */
  const [editingTurn, setEditingTurn] = useState<number | null>(null);

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
  }, [satellites, adoptInflight]);

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

  const onEditRequest = useCallback((turn: number, content: string) => {
    setDraft(content);
    setEditingTurn(turn);
  }, []);

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
    [activeId, send, create, provider, routedModel],
  );

  const onStop = useCallback(() => {
    if (activeId) stopTurn(activeId);
  }, [activeId, stopTurn]);

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
    (command: ChatAppCommand) => {
      switch (command) {
        case "new":
          deselect();
          break;
        case "clear":
          // Not a delete and deliberately not one: it drops the *selection*, so the next message
          // starts somewhere new and everything said so far is still in the list on the left.
          setDraft("");
          deselect();
          break;
        case "model":
        case "provider":
          // Both land on the same screen because they are the same setting: the chat task's route
          // is a provider *and* a model, and splitting them into two destinations would mean one of
          // the two commands always took you to the wrong half.
          openSettings("review");
          break;
        case "export":
          void exportTranscript();
          break;
        case "branch": {
          // From the last turn, which is what "branch this conversation" means with no turn picked.
          // The per-turn branch lives on the bubble's hover row.
          const last = session.messages[session.messages.length - 1];
          if (activeId && last) void useConversationStore.getState().branch(activeId, last.turn);
          break;
        }
      }
    },
    [deselect, openSettings, exportTranscript, activeId, session.messages],
  );

  // Writability follows the conversation's own `projectId`, not the lookup above: a repository the
  // app has not loaded into memory is still a repository, and saying "read-only" because a list was
  // not to hand would be the one kind of lie this header exists to prevent.
  const writable = session.projectId !== null;
  const repoName = conversation?.projectName || project?.name || "";

  return (
    <div className="flex h-full min-h-0 bg-[var(--cf-surface)]" data-tour="chat-view">
      <div
        style={{ width: sidebarWidth }}
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
              <span
                title={t("chat.noRepoHint")}
                className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--cf-border)] px-2 text-[10.5px] leading-[18px] text-[var(--cf-text-muted)]"
              >
                <ShieldCheck size={10} />
                {t("chat.noRepoBadge")}
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
            {/* `min-h-0` on the scroller and `h-full` inside it, because `EmptyState` centres
                itself in the box it is given and a flex child with no minimum would shrink to the
                height of its own text — leaving the hero hard against the composer instead of in
                the middle of the space above it. */}
            <div className={`min-h-0 flex-1 overflow-y-auto ${READING_COLUMN} ${COLUMN_GUTTER}`}>
              <div className="h-full">
                <EmptyState
                  icon={MessagesSquare}
                  title={t("chat.emptyTitle")}
                  subtitle={t("chat.emptyBody")}
                />
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
              attachments={EMPTY_ATTACHMENTS}
              sending={false}
              turns={0}
              draft={draft}
              onDraftChange={setDraft}
              onSend={onSend}
              onStop={onStop}
              onRunAppCommand={runAppCommand}
              onOpenTerminal={onOpenTerminal}
            />
          </div>
        ) : (
          <>
            <ChatTranscript onEditRequest={onEditRequest} />
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
              onRunAppCommand={runAppCommand}
              onOpenTerminal={onOpenTerminal}
            />
          </>
        )}
      </div>
    </div>
  );
}
