import { useEffect, useRef, useState } from "react";
import { Loader2, MessageSquarePlus, MessagesSquare, SendHorizontal } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { newId } from "../ids";
import { useBusy, useMobileStore } from "../store";
import { onInvalidate } from "../invalidate";
import { clearDraft, readDraft, writeDraft } from "../drafts";
import { sinceIso } from "../time";
import { RootBar } from "../ui/RootBar";
import { Screen } from "../ui/Screen";
import { BottomBar } from "../ui/BottomBar";
import { Button, IconButton } from "../ui/Button";
import { EmptyState, ErrorState } from "../ui/Feedback";
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
 *
 * # The draft is not cleared until the turn lands
 *
 * It used to be cleared on *send*, before the request. A turn that failed — a model that refused, a
 * dropped connection, a CLI that was not installed — therefore destroyed the question along with
 * itself, and on a phone keyboard that is a real loss. The draft is written through to storage on
 * every keystroke and removed only by a reply.
 */
export function ChatScreen() {
  const projectId = useMobileStore((s) => s.projectId);
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("chat");
  /** The same flag under its own name, because this screen reads it for two different reasons: to
   *  disable the send button, and to notice a turn of its own finishing while it was away. */
  const chatBusy = busy;
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
  /**
   * Whether the conversation this screen is showing is a real one yet.
   *
   * `conversationId` is seeded with a throwaway `conv-<uuid>` so the very first message has something
   * to file under, and it is only replaced once `list_chat_conversations` answers. That read used to
   * end in `.catch(() => setEntries([]))`, which drew "Todavía no hay conversación en este proyecto"
   * over a project that had one — and left the throwaway id in place, so the next message started a
   * *second* conversation and orphaned the one on the desk. A failed read is now a failure, and
   * nothing can be sent until the identity is known.
   */
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [listFailure, setListFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  /**
   * Which conversation the in-flight reads belong to.
   *
   * Bumped whenever the screen's identity moves — a new project, a new conversation. A response that
   * arrives for an older generation is dropped, which is what stops "Conversación nueva" being
   * repopulated by a reload that was already in the air: the fresh conversation would come back
   * holding the old one's turns *and* its engine resume token, which is the exact identity mix-up
   * this screen's header spends forty lines explaining.
   */
  const generation = useRef(0);
  /**
   * A re-read this screen owes but cannot safely take yet.
   *
   * The invalidation listener used to early-return on `sending`, which meant no listener was
   * mounted at all while a turn was in flight — so a turn added at the desk during those seconds
   * fired into nothing, and re-subscribing afterwards performed no catch-up.
   */
  const owed = useRef(false);
  /** The same, for a turn that was in flight when this screen was last unmounted — see the note by
   *  the effect that reads it. */
  const owedRemote = useRef(false);

  // The most recent conversation for this project, so opening the tab lands you where you were
  // rather than on a blank page. A project with no history starts a new one, which is correct.
  useEffect(() => {
    if (!projectId) return;
    const mine = ++generation.current;
    setListState("loading");
    setListFailure(null);
    void rpc<{ session_id: string }[]>("list_chat_conversations", { projectId })
      .then(async (conversations) => {
        if (generation.current !== mine) return;
        const latest = conversations[0]?.session_id ?? null;
        if (!latest) {
          setConversationId(newConversationId());
          setEngineSessionId(null);
          setEntries([]);
          setListState("ready");
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
        if (generation.current !== mine) return;
        setEntries(turns);
        // The *last* recorded token, and `null` when there is none: turns written before the two
        // ids were separated carry no engine session at all, which simply means the next message
        // starts a fresh engine session while still filing under this same conversation.
        setEngineSessionId(
          turns.reduce<string | null>((last, e) => e.engine_session_id ?? last, null),
        );
        setListState("ready");
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        setListFailure(e instanceof Error ? e.message : String(e));
        setListState("error");
      });
    // `attempt` is the retry button; bumping it re-runs the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, attempt]);

  // The draft follows the conversation it belongs to, so starting a new one does not inherit a
  // half-written question from the old.
  useEffect(() => {
    setDraft(readDraft("chat", conversationId));
  }, [conversationId]);

  // A turn added to *this* conversation somewhere else — at the desk, or on another device.
  useEffect(() => {
    if (!projectId) return;

    const reload = () => {
      if (sending) {
        owed.current = true;
        return;
      }
      owed.current = false;
      const mine = generation.current;
      void rpc<ActivityLogEntry[]>("get_chat_conversation", {
        projectId,
        sessionId: conversationId,
        withTrace: false,
      })
        .then((turns) => {
          // The conversation may have been replaced while this was in flight — "Conversación nueva"
          // is one tap and this read is a round trip.
          if (generation.current !== mine) return;
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

    // The turn that was in flight has landed, and something arrived while it was.
    if (owed.current && !sending) reload();

    // A turn this device sent that finished while this screen was not mounted.
    //
    // The screen is remounted on every tab change (`key={tab}` in `App.tsx`), and an engine turn
    // takes tens of seconds — so "send, tap Repo to check something, tap Chat again" is ordinary.
    // The mount read then misses the row, because the backend has not written it yet, and nothing
    // else ever tells this screen: `send_chat_message`'s own invalidation is dropped by the frame
    // router as this device's own echo. The one signal that survives is the busy flag falling.
    if (!sending && !chatBusy && owedRemote.current) {
      owedRemote.current = false;
      reload();
    }
    if (chatBusy) owedRemote.current = true;

    return onInvalidate("chat", projectId, (detail) => {
      if (detail.conversation !== conversationId) return;
      reload();
    });
  }, [projectId, conversationId, sending, chatBusy]);

  useEffect(() => {
    // The transcript's own scroller, not `scrollIntoView` — which drags every scrollable ancestor
    // and, on this screen, fights the keyboard for the viewport.
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries.length, sending]);

  const send = () => {
    const message = draft.trim();
    // Nothing goes out under a conversation id that may be about to be replaced by the real one.
    if (!message || listState !== "ready") return;
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
        // Only now. A turn that never landed leaves the question in the box, where it can be sent
        // again with one tap instead of retyped.
        setDraft("");
        clearDraft("chat", conversationId);
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

  if (!projectId) {
    return (
      <Screen bar={<RootBar title={t("nav.chat")} />}>
        <EmptyState
          icon={<MessagesSquare size={26} aria-hidden />}
          title={t("repo.noProject")}
          hint={t("repo.noProjectHint")}
        />
      </Screen>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--cf-bg)]">
      <RootBar
        title={t("nav.chat")}
        actions={
          // Starting over. Only offered when there is something to start over *from* — on an empty
          // conversation the button would do nothing visible, and a control that appears to do
          // nothing is worse than one that is absent. Nothing is deleted; the old conversation is
          // still in the history on both clients.
          entries.length > 0 ? (
            <IconButton
              icon={<MessageSquarePlus size={18} />}
              label={t("chat.new")}
              disabled={sending}
              onClick={() => {
                setConversationId(newConversationId());
                setEngineSessionId(null);
                setEntries([]);
              }}
            />
          ) : undefined
        }
      />

      <div ref={scroller} className="cf-scroll min-h-0 flex-1 px-3 pb-3">
        {listState === "error" && (
          <ErrorState
            title={t("chat.loadFailed")}
            detail={listFailure}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        )}
        {listState === "ready" && entries.length === 0 && !sending && (
          <EmptyState
            icon={<MessagesSquare size={26} aria-hidden />}
            title={t("chat.empty")}
            hint={t("chat.emptyHint")}
          />
        )}
        {entries.map((entry) => (
          <div key={entry.id} className="cf-rise mt-3">
            {/* The question, right-aligned and accent-filled; the answer, left and plain. The
                asymmetry is what lets a thumb-scrolled transcript be parsed at a glance without
                reading a single word. */}
            <div className="flex justify-end">
              <p className="cf-selectable max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--cf-accent-strong)] px-3 py-2 text-base text-[var(--cf-accent-contrast)]">
                {entry.question}
              </p>
            </div>
            <div className="mt-1.5 flex justify-start">
              {/* `cf-prose`, not `cf-log`. An answer is paragraphs, and rendering paragraphs at
                  11px monospace — which is what this did — makes the one screen whose whole content
                  is prose the least readable in the client. */}
              <p
                className={`cf-prose max-w-[92%] rounded-2xl rounded-bl-sm border px-3 py-2 ${
                  entry.is_error
                    ? "border-[var(--cf-danger)]/40 bg-[var(--cf-danger-soft)] text-[var(--cf-danger-text)]"
                    : "border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text)]"
                }`}
              >
                {entry.answer}
              </p>
            </div>
            <p className="mt-1 text-2xs text-[var(--cf-text-faint)]">
              {[entry.provider, entry.model, sinceIso(entry.created_at)].filter(Boolean).join(" · ")}
            </p>
          </div>
        ))}
        {sending && (
          <div className="mt-3 flex justify-start">
            <p className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 text-base text-[var(--cf-text-muted)]">
              <Loader2 size={14} className="animate-spin" aria-hidden />
              {t("chat.thinking")}
            </p>
          </div>
        )}
      </div>

      <BottomBar className="p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              writeDraft("chat", conversationId, e.target.value);
            }}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.placeholder")}
            rows={1}
            // No Enter-to-send: on a phone the return key is how you write a second line, and
            // hijacking it turns every paragraph break into an accidental turn that costs money.
            className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2.5 outline-none focus:border-[var(--cf-accent)]"
          />
          <Button
            variant="primary"
            onClick={send}
            loading={sending}
            disabled={busy || listState !== "ready" || draft.trim().length === 0}
            ariaLabel={t("chat.send")}
            icon={sending ? undefined : <SendHorizontal size={17} />}
          />
        </div>
      </BottomBar>
    </div>
  );
}
