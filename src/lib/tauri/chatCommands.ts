import { invoke } from "@tauri-apps/api/core";
import type { ChatReply as EngineReply } from "./commands";
// Type-only, so nothing here depends on the store at runtime and no import cycle can form. The
// alternative — a third copy of `{ stream, text }` under `src/types/` — would be a shape that has
// to be kept in step with the one the log component actually renders, which is this one.
import type { AiRunLine } from "../../state/aiRunStore";

/**
 * IPC surface for the `chat` workspace.
 *
 * Its own module rather than another block in the 2431-line `commands.ts`, for the reason
 * `notesCommands.ts` and `dbCommands.ts` are: nothing here takes a repository path. A conversation
 * addresses itself by its own id, and the one call that needs more — creating one — takes a
 * `workspaceId` and an *optional* `projectId`, because a chat about no repository at all is the
 * default case in this workspace rather than the exception.
 *
 * Two things about this surface are worth knowing before using it.
 *
 * **`chatGetConversation` does not return traces unless you ask.** A single agentic turn's trace
 * runs to hundreds of kilobytes, so a thirty-turn conversation loaded eagerly would move tens of
 * megabytes across the IPC boundary to render a list of bubbles that shows none of it. `withTrace`
 * defaults to `false` on the Rust side; pass `true` only for the one conversation whose trace the
 * user has actually opened.
 *
 * **`chatSend` resolves at the *end* of the turn.** While it is pending the backend may be emitting
 * `ai:chat-delta` events for the assistant message it is about to return — see `onAiChatDelta` in
 * `events.ts`. The reply's `message_id` is what ties those chunks to the row that finally lands, so
 * a caller that streams must reconcile the two rather than appending the reply on its own.
 */

/** One conversation's metadata row. The transcript is fetched separately — see
 *  `chatGetConversation`. */
export interface ChatConversation {
  id: string;
  workspaceId: string;
  /** `null` for a conversation about no repository, which is the ordinary case here. It also goes
   *  back to `null` when the project is deleted (`ON DELETE SET NULL`): losing a repository must
   *  orphan the chats that mentioned it, never shred them. */
  projectId: string | null;
  /** Display name for `projectId`, joined in by the backend so the sidebar does not have to hold a
   *  project list to render a row. Absent when there is no project. */
  projectName?: string | null;
  title: string;
  provider: string;
  model: string;
  systemPrompt: string;
  /** One of {@link CHAT_EFFORTS}, or `""` for "leave the CLI's own default alone". Empty is a real
   *  state: a user who configured a level inside the CLI has already answered this question. */
  effort: string;
  /** The folder this thread is filed under, or `null` for the ungrouped list. Deleting a group
   *  returns its chats here — removing a folder never removes what is in it. */
  groupId: string | null;
  /** An answer landed here that has not been looked at. Cleared when the conversation is opened. */
  unread: boolean;
  /** Whether the most recent turn failed, derived by the listing query from the last message. */
  lastFailed: boolean;
  /** The engine's own resume token for the most recent turn, which is a different thing from `id` —
   *  see the comment on `ChatSession.conversationId` in `state/chatStore.ts` for why the app mints
   *  its own identity instead of borrowing the CLI's. `null` until a turn has landed. */
  engineSessionId: string | null;
  pinnedAt: string | null;
  archivedAt: string | null;
  /** Set when this conversation was forked from another at `branchedAtTurn`. A branch is a *new*
   *  engine session replaying the prefix as context — no CLI here can rewind one — so the link is
   *  provenance for the UI, not something the engine knows about. */
  parentConversationId: string | null;
  branchedAtTurn: number | null;
  createdAt: string;
  updatedAt: string;
}

/** One message. Deliberately one row per message rather than per (question, answer) pair the way
 *  `activity_log` stores the AI panel's chat: edit, regenerate and branch all need a message they
 *  can address by id. */
export interface ChatMessageRow {
  id: string;
  conversationId: string;
  turn: number;
  role: "user" | "assistant";
  content: string;
  provider?: string | null;
  model?: string | null;
  engineVersion?: string | null;
  responseTimeMs?: number | null;
  isError: boolean;
  isCancelled: boolean;
  /**
   * What the engine printed while producing this answer, or `null`/absent when the row was read
   * without `withTrace`.
   *
   * The column is `TEXT` holding a JSON array, so what arrives here may well be the raw string
   * rather than a parsed array depending on how the backend chooses to hand it over.
   * `conversationStore`'s `traceOf` normalizes both shapes and applies the same line formatting the
   * live log uses, so a reopened turn reads identically to a fresh one. Do not consume this field
   * directly.
   */
  trace?: AiRunLine[] | null;
  createdAt: string;
}

/** A slash command the composer's `/` menu can offer for a provider.
 *
 * `source` is shown to the user and is not decoration: "cli-reported" means the list came out of
 * that CLI's own handshake on the most recent run and is therefore true of the installed binary,
 * "documented" means the app read a curated or shipped list and the binary was never asked, and
 * "app" means the command never reaches a CLI at all because the frontend handles it. Collapsing
 * the three would put a command that cannot work next to one that always does. */
export interface ProviderCommand {
  name: string;
  description: string;
  source: "cli-reported" | "documented" | "app";
}

/** One hit from the sidebar's search: enough to render a row and open it, and no transcript. */
export interface ChatSearchHit {
  conversationId: string;
  title: string;
  snippet: string;
}

/**
 * What a finished turn answers with.
 *
 * Extends the engine reply the AI panel already receives (`commands.ts`) with the id of the row the
 * answer was persisted as. That id is the join between the streamed chunks and the finished
 * message: `ai:chat-delta` carries it from the first chunk onward, long before this promise
 * resolves, so without it a streaming transcript could not tell whether the text it has been
 * growing is the same answer that just landed.
 *
 * Snake case, unlike the rest of this module, because it extends a struct that already serializes
 * that way — see the note in the report.
 */
export interface ChatReply extends EngineReply {
  message_id: string;
}

// ---------- conversations ----------

/** `projectId` is nullable on purpose: binding a conversation to a repository is what *grants* it
 *  write access, so the default has to be the read-only one. */
export const chatCreateConversation = (
  workspaceId: string,
  projectId: string | null,
  provider: string,
  model: string,
) => invoke<ChatConversation>("chat_create_conversation", { workspaceId, projectId, provider, model });

/** The whole flat list, pinned first then by recency — **not** filtered by workspace. The workspace
 *  is still stored (backup grouping, the run-isolation stamp), but a chat list that hides
 *  yesterday's conversation because the user switched workspace is a list nobody trusts. */
export const chatListConversations = (includeArchived?: boolean) =>
  invoke<ChatConversation[]>("chat_list_conversations", { includeArchived: includeArchived ?? null });

/** One conversation's transcript. See the module doc for why `withTrace` defaults to `false`. */
export const chatGetConversation = (conversationId: string, withTrace?: boolean) =>
  invoke<ChatMessageRow[]>("chat_get_conversation", { conversationId, withTrace: withTrace ?? null });

export const chatRenameConversation = (conversationId: string, title: string) =>
  invoke<void>("chat_rename_conversation", { conversationId, title });

/** Re-points the conversation at an engine. A provider change also clears the resume token on the
 *  Rust side, because a session id minted by one CLI means nothing to another. */
export const chatSetEngine = (conversationId: string, provider: string, model: string) =>
  invoke<void>("chat_set_engine", { conversationId, provider, model });

export const chatSetUnread = (conversationId: string, unread: boolean) =>
  invoke<void>("chat_set_unread", { conversationId, unread });

/**
 * How hard the model is asked to think, in this app's vocabulary.
 *
 * Four steps, mirroring `ai::effort` on the Rust side, because four is the most the *shortest*
 * provider scale maps onto without two of them collapsing into the same flag. Every CLI spells
 * this differently — Claude takes `--effort`, Codex wants a config override, opencode calls it a
 * model variant, Cline calls it `--thinking` — and the translation is each engine's, not this
 * file's.
 */
export const CHAT_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

/** Sets the level for every future turn of a conversation. `""` clears it. */
export const chatSetEffort = (conversationId: string, effort: string) =>
  invoke<void>("chat_set_effort", { conversationId, effort });

/** Which provider ids accept a level at all, asked of the engines rather than hardcoded here —
 *  so the composer hides the control instead of offering a dial that turns nothing. */
export const chatEffortSupport = () => invoke<string[]>("chat_effort_support");

export const chatDeleteConversation = (conversationId: string) =>
  invoke<void>("chat_delete_conversation", { conversationId });

export const chatSetPinned = (conversationId: string, pinned: boolean) =>
  invoke<void>("chat_set_pinned", { conversationId, pinned });

/** Archiving is not deleting: the rows stay, the sidebar stops listing them by default. */
export const chatSetArchived = (conversationId: string, archived: boolean) =>
  invoke<void>("chat_set_archived", { conversationId, archived });

export const chatSearchConversations = (query: string, limit?: number) =>
  invoke<ChatSearchHit[]>("chat_search_conversations", { query, limit: limit ?? null });

/** Forks the conversation at `atTurn` into a new one carrying the prefix. Cheap to store and
 *  expensive to run — the new conversation starts a fresh engine session and replays the prefix as
 *  context, because no CLI here can rewind one. */
export const chatBranchConversation = (conversationId: string, atTurn: number) =>
  invoke<ChatConversation>("chat_branch_conversation", { conversationId, atTurn });

// ---------- turns ----------

/**
 * Runs one turn and resolves when it is over.
 *
 * `runId` is minted by the caller (`newRunId("chat")`) rather than by the backend so the stop
 * button, the status bar row and the live output stream all exist from the frame the question is
 * asked — a run id handed back at the end would be useless to every one of them.
 *
 * `provider` and `model` override the conversation's stored routing for this turn only. Passing a
 * different provider is a context transplant rather than a resume: the new CLI has no session to
 * continue, so the backend re-sends the stored transcript. Say so in the UI before doing it.
 *
 * `stream` asks for token deltas. It is honoured only where the engine can actually produce them
 * (today: Claude alone — see `providerCapabilities`), and ignored everywhere else, so a caller may
 * always pass `true` without first checking.
 */
export const chatSend = (
  conversationId: string,
  message: string,
  runId?: string,
  provider?: string | null,
  model?: string | null,
  stream?: boolean,
  /** Attachment ids staged for this turn — file names under the conversation's own folder, never
   *  paths, so the frontend cannot name a file outside it. */
  attachments?: string[],
) =>
  invoke<ChatReply>("chat_send", {
    conversationId,
    message,
    attachments: attachments ?? null,
    runId: runId ?? null,
    provider: provider ?? null,
    model: model ?? null,
    stream: stream ?? null,
  });

// ---------- provider surface ----------

/**
 * The slash commands this provider can actually be sent.
 *
 * Read at call time and never cached across providers: the Claude list is whatever the most recent
 * run's handshake reported on *this* machine, and Grok's is parsed from a file in the user's home
 * that its own installer updates. A provider that reports none answers with an empty array, which
 * is the honest answer — the menu then offers app-level commands and a way into the real CLI
 * instead of inventing a surface that would fail on send.
 */
export const chatProviderCommands = (provider: string) =>
  invoke<ProviderCommand[]>("chat_provider_commands", { provider });

// ---------- groups ----------

/**
 * A folder in the chat sidebar.
 *
 * Global, like the conversation list it organises — a chat is filed by what it is about, not by
 * which workspace happened to be open when it started. `collapsed` lives on the row rather than in
 * frontend state so the shape of the sidebar survives a restart and matches in a detached window.
 */
export interface ChatGroup {
  id: string;
  name: string;
  /** Empty means no colour chosen; the row draws the default dot. */
  color: string;
  sortOrder: number;
  collapsed: boolean;
  /** Standing instructions for every conversation in this project, appended to the base system
   *  prompt on every turn. Read fresh at send time, so editing them changes what the existing chats
   *  are told next time they run. */
  instructions: string;
  createdAt: string;
  /** How many unarchived conversations are filed here, counted by the query rather than stored. */
  conversationCount: number;
}

export const chatListGroups = () => invoke<ChatGroup[]>("chat_list_groups");

export const chatCreateGroup = (name: string, color: string) =>
  invoke<ChatGroup>("chat_create_group", { name, color });

export const chatRenameGroup = (groupId: string, name: string, color: string) =>
  invoke<void>("chat_rename_group", { groupId, name, color });

/** Removes the folder. Its conversations go back to the ungrouped list — this never deletes a
 *  chat, which is the one rule the feature has to get right. */
export const chatDeleteGroup = (groupId: string) => invoke<void>("chat_delete_group", { groupId });

export const chatSetGroupCollapsed = (groupId: string, collapsed: boolean) =>
  invoke<void>("chat_set_group_collapsed", { groupId, collapsed });

export const chatReorderGroups = (ids: string[]) => invoke<void>("chat_reorder_groups", { ids });

/** Files a conversation under a folder, or returns it to the ungrouped list with `null`. */
export const chatSetConversationGroup = (conversationId: string, groupId: string | null) =>
  invoke<void>("chat_set_conversation_group", { conversationId, groupId });

// ---------- attachments ----------

/**
 * A file attached to a conversation.
 *
 * Always a **copy** under the app's own state root, never the path the user picked. Two reasons,
 * both of which bite in ordinary use: the original can be moved or deleted the moment after
 * attaching it, and several of these engines run with a restricted view of the filesystem, so a
 * path under Downloads is not necessarily one the CLI may open.
 *
 * The copy lives as long as the **conversation**, not the turn. Deleting it the moment the model
 * has read it sounds tidier and is wrong: a follow-up question can make the model read it again,
 * and Cline — which cannot resume — re-sends the whole context every turn, so a vanished path
 * fails outright.
 */
export interface ChatAttachment {
  /** The stored file name, which is also how it is addressed for removal and for sending. */
  id: string;
  /** What the user called it, for the chip in the composer. */
  name: string;
  /** Absolute path to the copy — what the engine is told to read. */
  path: string;
  bytes: number;
  /** Whether an engine that understands images would see this as one. Only Codex has a flag that
   *  hands a model an actual image; everywhere else this decides what the UI may promise. */
  isImage: boolean;
}

/** Copies a file the user picked into the conversation's own directory. */
export const chatAttachFile = (conversationId: string, sourcePath: string) =>
  invoke<ChatAttachment>("chat_attach_file", { conversationId, sourcePath });

/** Stores bytes with no file behind them — a pasted screenshot, or a drop that hands over data. */
export const chatAttachBytes = (conversationId: string, name: string, data: number[]) =>
  invoke<ChatAttachment>("chat_attach_bytes", { conversationId, name, data });

export const chatListAttachments = (conversationId: string) =>
  invoke<ChatAttachment[]>("chat_list_attachments", { conversationId });

export const chatRemoveAttachment = (conversationId: string, attachmentId: string) =>
  invoke<void>("chat_remove_attachment", { conversationId, attachmentId });

/** Collects attachment folders whose conversation is gone. Run once at startup: the per-delete
 *  cleanup cannot cover a crash, or a workspace deletion that cascaded rows away without passing
 *  through the chat commands. Returns how many folders it removed. */
export const chatSweepAttachments = () => invoke<number>("chat_sweep_attachments");

export const chatSetGroupInstructions = (groupId: string, instructions: string) =>
  invoke<void>("chat_set_group_instructions", { groupId, instructions });

/** A project's shared reference documents. Unlike a conversation attachment these are named to the
 *  engine **once per session** rather than on every turn — see `chat_cmd`. */
export const chatGroupAttachFile = (groupId: string, sourcePath: string) =>
  invoke<ChatAttachment>("chat_group_attach_file", { groupId, sourcePath });

export const chatGroupListContext = (groupId: string) =>
  invoke<ChatAttachment[]>("chat_group_list_context", { groupId });

export const chatGroupRemoveContext = (groupId: string, attachmentId: string) =>
  invoke<void>("chat_group_remove_context", { groupId, attachmentId });

/**
 * A chat turn the Rust process is still working on.
 *
 * The app's source of truth for "is this conversation busy", and deliberately not the local store:
 * every window has its own `conversationStore`, so a turn started in one is invisible to another
 * unless it asks. The run itself lives in the Rust process and outlives any window, workspace
 * switch or view change — this is how a window that opened mid-turn finds out.
 */
export interface InflightTurn {
  conversationId: string;
  runId: string;
  /** The row the answer will become, and the key `ai:chat-delta` carries — which is what lets an
   *  adopting window render tokens that are already arriving. */
  messageId: string;
  provider: string;
  /** Epoch milliseconds, so an adopting window's elapsed timer counts from when the turn really
   *  started rather than from when that window opened. */
  startedAtMs: number;
}

export const chatInflightTurns = () => invoke<InflightTurn[]>("chat_inflight_turns");
