import type { editor as MonacoEditorNS } from "monaco-editor";
import { bumpLiveTargets, forgetLiveSession, setOpenLive } from "../../state/liveStore";
import { useWorkspaceChatStore } from "../../state/workspaceChatStore";
import { hueOf } from "../sharedChat";
import { collabLiveConnection, type CollabSessionView, type CollabTick } from "../tauri/collabCommands";
import { ModelBinding } from "./binding";
import { LiveSession } from "./session";
import type { LiveFile } from "./wire";

/**
 * The live sessions of this window and what ties them to the rest of the app: which workspace
 * project is which session repository, the editor's attach/detach, and relaying this person's turn
 * as it streams. `state/sharedChatStore` drives it from each sync round.
 */

interface Target {
  sessionId: string;
  repoKey: string;
}

const sessions = new Map<string, LiveSession>();
const starting = new Map<string, Promise<LiveSession | null>>();
/** By workspace project id (the session projects, «api · sesión»). */
const targets = new Map<string, Target>();
/** By chat id: the session it is shared in, for relaying turns. */
const chats = new Map<string, string>();

/** Called after every sync round of a session. */
export async function syncLive(view: CollabSessionView, tick: CollabTick): Promise<void> {
  const sessionId = view.session.id;
  if (tick.ended || view.session.status !== "active") {
    dropLive(sessionId);
    return;
  }
  let changed = false;
  for (const repo of view.repos) {
    if (!repo.sessionProjectId) continue;
    const current = targets.get(repo.sessionProjectId);
    if (current?.sessionId !== sessionId || current.repoKey !== repo.repoKey) {
      targets.set(repo.sessionProjectId, { sessionId, repoKey: repo.repoKey });
      changed = true;
    }
  }
  chats.set(view.session.chatId, sessionId);
  watchTurns();
  // A session that could not connect before is retried every round; once it exists, editors already
  // showing its files must hear about it, so a new one counts as a change too.
  const existed = sessions.has(sessionId);
  const live = await ensureSession(view);
  if (!live) return;
  if (!existed) changed = true;
  await live.setChannelKey(tick.channel ?? null);
  for (const item of tick.liveRemote ?? []) live.mergeRemote({ repoKey: item.repoKey, path: item.path }, item.text, item.updatedBy);
  if (changed) bumpLiveTargets();
}

async function ensureSession(view: CollabSessionView): Promise<LiveSession | null> {
  const id = view.session.id;
  const existing = sessions.get(id);
  if (existing) return existing;
  let pending = starting.get(id);
  if (!pending) {
    pending = collabLiveConnection(id)
      .then((connection) => {
        const live = new LiveSession(id, { id: view.session.personId, nick: view.session.nick }, connection);
        sessions.set(id, live);
        return live;
      })
      .catch(() => null)
      .finally(() => starting.delete(id));
    starting.set(id, pending);
  }
  return pending;
}

export function dropLive(sessionId: string): void {
  const live = sessions.get(sessionId);
  sessions.delete(sessionId);
  live?.dispose();
  for (const [projectId, target] of targets) if (target.sessionId === sessionId) targets.delete(projectId);
  for (const [chatId, id] of chats) if (id === sessionId) chats.delete(chatId);
  forgetLiveSession(sessionId);
}

/** The files open live in a session, for the next sync round. */
export function liveFilesOf(sessionId: string): LiveFile[] {
  return sessions.get(sessionId)?.liveFiles() ?? [];
}

export function isLiveProject(projectId: string): boolean {
  return targets.has(projectId);
}

/** The session project of a repository in a session, for «Seguir». */
export function projectOf(sessionId: string, repoKey: string): string | null {
  for (const [projectId, target] of targets) if (target.sessionId === sessionId && target.repoKey === repoKey) return projectId;
  return null;
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

const bindings = new Map<MonacoEditorNS.ITextModel, { binding: ModelBinding; session: LiveSession; projectId: string; path: string }>();

/**
 * Binds the model an editor shows to its file's live document, when the project is a session
 * project. Returns the detach, or `null` when the file is not live. One binding per model, however
 * many editors (splits) show it; each editor draws the others' cursors and reports its own.
 */
export function attachLive(
  projectId: string,
  path: string,
  model: MonacoEditorNS.ITextModel,
  editor: MonacoEditorNS.IStandaloneCodeEditor,
): (() => void) | null {
  const target = targets.get(projectId);
  const live = target ? sessions.get(target.sessionId) : undefined;
  if (!target || !live) return null;
  const file: LiveFile = { repoKey: target.repoKey, path };
  let entry = bindings.get(model);
  if (!entry) {
    const doc = live.openDoc(file, hueOf(live.me.id));
    entry = { binding: new ModelBinding(model, doc), session: live, projectId, path };
    bindings.set(model, entry);
    setOpenLive(projectId, path, true);
  }
  entry.binding.addEditor(editor);
  const focus = editor.onDidFocusEditorText(() => live.setFocus(file));
  if (editor.hasTextFocus()) live.setFocus(file);
  const current = entry;
  return () => {
    focus.dispose();
    // Off to a file that is not live (or nowhere): the others stop seeing this person in this one.
    live.clearFocus(file);
    current.binding.removeEditor(editor);
    if (current.binding.editorCount > 0 || bindings.get(model) !== current) return;
    bindings.delete(model);
    current.binding.dispose();
    current.session.closeDoc(current.binding.live);
    setOpenLive(current.projectId, current.path, false);
  };
}

// ---------------------------------------------------------------------------
// This person's turn, as it streams
// ---------------------------------------------------------------------------

let watching = false;
const relayed = new Map<string, { sending: boolean; text: string }>();

function watchTurns(): void {
  if (watching) return;
  watching = true;
  useWorkspaceChatStore.subscribe((state) => {
    for (const [chatId, sessionId] of chats) {
      const chat = state.byConversation[chatId];
      const live = sessions.get(sessionId);
      if (!chat || !live) continue;
      const before = relayed.get(chatId) ?? { sending: false, text: "" };
      if (chat.sending && chat.streamText && chat.streamText !== before.text) {
        live.relayTurn(chat.streamText, chat.provider || null, false);
      } else if (!chat.sending && before.sending && before.text) {
        live.relayTurn(before.text, chat.provider || null, true);
      }
      relayed.set(chatId, { sending: chat.sending, text: chat.sending ? chat.streamText : "" });
    }
  });
}
