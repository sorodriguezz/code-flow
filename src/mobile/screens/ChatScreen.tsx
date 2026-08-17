import { useEffect, useRef, useState } from "react";
import { Loader2, MessageSquarePlus, SendHorizontal } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { newId } from "../ids";
import { useBusy, useMobileStore } from "../store";
import { onInvalidate } from "../invalidate";
import type { ActivityLogEntry } from "../../types/domain";

/** A brand-new conversation id, in the shape the desktop mints (`chatStore.send`) — the same
 *  prefix, because both clients write into one `activity_log` and a row's origin should not be
 *  readable from its id. `newId` rather than `crypto.randomUUID`, which does not exist on a page
 *  served over plain HTTP; see `ids.ts`. */
const newConversationId = () => `conv-${newId()}`;

/**
 * A conversation with whichever engine this workspace routes to.
 *
 * # What the phone does not choose
 *
 * Provider, model and prompt are never sent. The allowlist passes `None` for all three, so the turn
 * routes exactly as the desktop would route it. That is not a limitation to be lifted later — it is
 * the point. A device on a home network should not be able to pick what somebody's API bill looks
 * like, and the routing already has a home in Settings where that decision belongs.
 *
 * # Two ids, and why conflating them broke every turn
 *
 * A conversation here has **two** identifiers, and this screen used to hold one variable for both.
 *
 * * `conversationId` is the *app's* name for the conversation — a `conv-<uuid>` minted by whichever
 *   client starts it, stable for its whole life. It is what every turn is filed under, and it is
 *   what `ChatConversationSummary.session_id` and `get_chat_conversation`'s `sessionId` both mean.
 * * `engineSessionId` is the *CLI's* resume token, which the engine hands back with each reply and
 *   which the next turn passes as `--resume`. Engines are inconsistent about it — one reports a
 *   fixed sentinel for every run, another mints a fresh token per resumed turn — which is exactly
 *   why the app cannot borrow it as an identity.
 *
 * Sending the conversation id in the engine slot asked the CLI to resume a session it had never
 * issued: on a project with any history every turn from this phone errored, and on a fresh one each
 * turn became its own throwaway conversation whose junk id was then loaded back into the resume slot
 * on the next open — a failure that could not recover on its own. They are kept apart here, and the
 * backend's `send_chat_message` takes both.
 */
export function ChatScreen() {
  const { projectId, run } = useMobileStore();
  const busy = useBusy("chat");
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  /** The app's id for the conversation on screen — see the note above. Never null: a project with
   *  no history gets a fresh one so the first turn has something to file under. */
  const [conversationId, setConversationId] = useState<string>(newConversationId);
  /** The engine's resume token, or `null` to start a fresh engine session under the same
   *  conversation. Seeded from the last turn that recorded one, because a CLI may hand out a new
   *  token per turn and only the most recent one is live. */
  const [engineSessionId, setEngineSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  /**
   * A re-read this screen owes but cannot safely take yet.
   *
   * The invalidation listener used to early-return on `sending`, which meant no listener was
   * mounted at all while a turn was in flight — so a turn added at the desk during those seconds
   * fired into nothing, and re-subscribing afterwards performed no catch-up. The transcript stayed
   * missing that turn until the tab was reopened.
   *
   * A ref and not a local in the effect: the whole point is to survive the effect re-running, which
   * is exactly what `sending` flipping back does.
   */
  const owed = useRef(false);

  // The most recent conversation for this project, so opening the tab lands you where you were
  // rather than on a blank page. A project with no history starts a new one, which is correct.
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void rpc<{ session_id: string }[]>("list_chat_conversations", { projectId })
      .then(async (conversations) => {
        if (!alive) return;
        const latest = conversations[0]?.session_id ?? null;
        if (!latest) {
          setConversationId(newConversationId());
          setEngineSessionId(null);
          setEntries([]);
          return;
        }
        setConversationId(latest);
        const turns = await rpc<ActivityLogEntry[]>("get_chat_conversation", {
          projectId,
          // The **conversation** id, which is what this command has always wanted.
          sessionId: latest,
          // The trace is the engine's thinking-out-loud for each turn — tens of kilobytes per
          // answer that this screen never draws. Asking for the turns without it is the difference
          // between opening instantly and waiting on wifi.
          withTrace: false,
        }).catch(() => [] as ActivityLogEntry[]);
        if (!alive) return;
        setEntries(turns);
        // The *last* recorded token, and `null` when there is none: turns written before the two
        // ids were separated carry no engine session at all, which simply means the next message
        // starts a fresh engine session while still filing under this same conversation.
        setEngineSessionId(turns.reduce<string | null>((last, e) => e.engine_session_id ?? last, null));
      })
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [projectId]);

  // A turn added to *this* conversation somewhere else — at the desk, or on another device.
  //
  // Only this conversation, and only while nothing is in flight here. Reloading a transcript over
  // an optimistic bubble would make the question the user just asked vanish and come back; and
  // switching to whatever conversation moved would move the screen out from under somebody reading
  // an older one, which is the bug the desktop's own chat store is shaped around. A change to any
  // other conversation is picked up the next time this tab is opened.
  useEffect(() => {
    if (!projectId) return;

    const reload = () => {
      if (sending) {
        owed.current = true;
        return;
      }
      owed.current = false;
      void rpc<ActivityLogEntry[]>("get_chat_conversation", {
        projectId,
        sessionId: conversationId,
        withTrace: false,
      })
        .then((turns) => {
          setEntries(turns);
          // The engine session moved with whatever turn was just added elsewhere. Left at the old
          // token, the next message from this phone would ask the CLI to continue from before that
          // turn — the two clients would share a transcript and fork the engine's context.
          setEngineSessionId((current) =>
            turns.reduce<string | null>((last, e) => e.engine_session_id ?? last, current),
          );
        })
        // A failed re-read leaves what is on screen alone: it is the last thing the desktop
        // actually said, which is a better answer than an empty transcript.
        .catch(() => undefined);
    };

    // The turn that was in flight has landed, and something arrived while it was. Taken now, on the
    // same pass that re-runs this effect when `sending` clears.
    if (owed.current && !sending) reload();

    return onInvalidate("chat", projectId, (detail) => {
      if (detail.conversation !== conversationId) return;
      reload();
    });
  }, [projectId, conversationId, sending]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [entries.length, sending]);

  if (!projectId) {
    return <p className="p-6 text-center text-[13px] text-[var(--cf-text-muted)]">{t("repo.noProject")}</p>;
  }

  const send = () => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    setSending(true);
    void run(async () => {
      try {
        const reply = await rpc<{ text: string; session_id: string | null; provider: string }>(
          "send_chat_message",
          // Both ids, in their own slots. `conversationId` is what the turn is filed under — without
          // it the backend mints a new conversation per message, so the desk sees a stack of
          // one-turn activities instead of the conversation you are having.
          { projectId, message, conversationId, sessionId: engineSessionId },
        );
        // The engine's token for the *next* turn. A reply with none leaves the previous one
        // standing rather than clearing it: "the CLI did not say" is not "start over".
        if (reply.session_id) setEngineSessionId(reply.session_id);
        // Appended locally rather than re-reading the conversation: the backend has already
        // persisted the turn, and a refetch would be a second round trip to learn what the reply
        // just told us.
        setEntries((current) => [
          ...current,
          {
            id: newId(),
            project_id: projectId,
            // The conversation, not the engine token — this row is a copy of what the backend just
            // wrote, and stamping the resume token here is what used to feed the wrong id back into
            // the next open.
            session_id: conversationId,
            engine_session_id: reply.session_id,
            question: message,
            answer: reply.text,
            trace: null,
            created_at: new Date().toISOString(),
            response_time_ms: null,
            is_error: false,
            provider: reply.provider,
          } as ActivityLogEntry,
        ]);
      } finally {
        setSending(false);
      }
    }, "chat");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Starting over.
          Only offered when there is something to start over *from* — on an empty conversation the
          button would do nothing visible, and a control that appears to do nothing is worse than
          one that is absent. A fresh conversation id and no engine session: the next turn files
          itself under a new activity and starts the CLI from nothing, which is exactly what the
          desktop's own new-chat does. Nothing is deleted; the old conversation is still in the
          history on both clients. */}
      {entries.length > 0 && (
        <div className="shrink-0 px-3 pt-2">
          <button
            type="button"
            disabled={sending}
            onClick={() => {
              setConversationId(newConversationId());
              setEngineSessionId(null);
              setEntries([]);
              setDraft("");
            }}
            className="cf-tap flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--cf-border)] text-[12px] disabled:opacity-40"
          >
            <MessageSquarePlus size={13} /> {t("chat.new")}
          </button>
        </div>
      )}

      <div className="cf-scroll flex-1 px-3 pb-3">
        {entries.length === 0 && !sending && (
          <p className="mt-8 text-center text-[13px] text-[var(--cf-text-muted)]">{t("chat.empty")}</p>
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="mt-3">
            {/* The question, right-aligned and accent-filled; the answer, left and plain. The
                asymmetry is what lets a thumb-scrolled transcript be parsed at a glance without
                reading a single word. */}
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--cf-accent)] px-3 py-2 text-[13px] text-white">
                {entry.question}
              </p>
            </div>
            <div className="mt-1.5 flex justify-start">
              <p
                className={`cf-log max-w-[92%] rounded-2xl rounded-bl-sm border px-3 py-2 ${
                  entry.is_error
                    ? "border-[var(--cf-danger)]/40 text-[var(--cf-danger)]"
                    : "border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text)]"
                }`}
              >
                {entry.answer}
              </p>
            </div>
          </div>
        ))}
        {sending && (
          <div className="mt-3 flex justify-start">
            <Loader2 size={16} className="animate-spin text-[var(--cf-text-muted)]" />
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="shrink-0 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("chat.placeholder")}
            rows={1}
            // No Enter-to-send: on a phone the return key is how you write a second line, and
            // hijacking it turns every paragraph break into an accidental turn that costs money.
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 outline-none focus:border-[var(--cf-accent)]"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || sending || draft.trim().length === 0}
            aria-label={t("chat.send")}
            className="cf-tap flex items-center justify-center rounded-lg bg-[var(--cf-accent)] px-3 text-white disabled:opacity-40"
          >
            <SendHorizontal size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
