import { useCallback, useEffect, useState } from "react";
import { Eraser, Inbox, Plus, RefreshCw, Send, Trash2, TriangleAlert } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { CARD } from "./remoteChrome";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { RemoteQueueTab } from "../../state/remoteStore";
import {
  remoteQueueClear,
  remoteQueueDeleteMessage,
  remoteQueuePeek,
  remoteQueuePut,
  remoteQueueReceive,
  remoteQueueRemove,
  remoteQueues,
} from "../../lib/tauri/remoteCommands";
import type { QueueMessage, QueueSummary } from "../../types/remote";

/**
 * Azure Queue storage: the account's queues down one side, the selected one's messages beside it.
 *
 * **Peek is the default and receive is a button, which is the whole design.** Looking at a work
 * queue must not take work out of it, so opening one reads the front without consuming anything.
 * Receiving is the destructive read — it hides messages for a visibility window and hands back the
 * pop receipts that deleting needs — so it says so, and the messages it returns are marked.
 *
 * A tab is a *host*, not a queue: selecting is a click in the list, the same way the file browser
 * shows one directory of one machine rather than opening a tab per folder.
 */

/** How long a received message stays hidden. Long enough to read it and decide; short enough that
 *  a mistake reappears while the user is still looking at the panel. */
const VISIBILITY_SECONDS = 30;
const HOW_MANY = 32;

export function QueuePanel({ tab }: { tab: RemoteQueueTab }) {
  const t = useT();
  const [queues, setQueues] = useState<QueueSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [messages, setMessages] = useState<QueueMessage[]>([]);
  /** Whether what is on screen came from a receive. A peeked list has no pop receipts, so the
   *  delete button would be dead — saying which read produced these rows is what explains that. */
  const [received, setReceived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const fail = (e: unknown) => pushErrorToast(String(e));

  const loadQueues = useCallback(async () => {
    setLoading(true);
    try {
      const found = await remoteQueues(tab.hostId);
      setQueues(found);
      // Land on the first queue rather than an empty pane: an account with one queue should not
      // need a click to show it.
      setSelected((current) => (current && found.some((q) => q.name === current) ? current : found[0]?.name ?? ""));
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, [tab.hostId]);

  const peek = useCallback(
    async (name: string) => {
      if (!name) return setMessages([]);
      setBusy(true);
      try {
        setMessages(await remoteQueuePeek(tab.hostId, name, HOW_MANY));
        setReceived(false);
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    },
    [tab.hostId],
  );

  useEffect(() => {
    void loadQueues();
  }, [loadQueues]);

  useEffect(() => {
    void peek(selected);
  }, [selected, peek]);

  const receive = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      setMessages(await remoteQueueReceive(tab.hostId, selected, HOW_MANY, VISIBILITY_SECONDS));
      setReceived(true);
      void loadQueues();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!selected || !draft.trim()) return;
    try {
      await remoteQueuePut(tab.hostId, selected, draft);
      setDraft("");
      await peek(selected);
      void loadQueues();
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (message: QueueMessage) => {
    try {
      await remoteQueueDeleteMessage(tab.hostId, selected, message.id, message.pop_receipt);
      setMessages((current) => current.filter((one) => one.id !== message.id));
      void loadQueues();
    } catch (e) {
      fail(e);
    }
  };

  const clear = async () => {
    if (!selected) return;
    const ok = await confirmAction(t("remote.queueClearConfirm", { name: selected }), true, t("remote.queueClear"));
    if (!ok) return;
    try {
      await remoteQueueClear(tab.hostId, selected);
      setMessages([]);
      void loadQueues();
    } catch (e) {
      fail(e);
    }
  };

  const deleteQueue = async (name: string) => {
    const ok = await confirmAction(t("remote.queueDeleteConfirm", { name }), true, t("common.delete"));
    if (!ok) return;
    try {
      await remoteQueueRemove(tab.hostId, name);
      if (selected === name) setSelected("");
      void loadQueues();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className={`flex h-full min-h-0 ${CARD}`}>
      {/* The queues, as a rail. Narrow and fixed: a name and a depth is all a queue has to show
          from the outside, and the messages are what the width is for. */}
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--cf-border)]">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
          <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("remote.queues")}
          </span>
          <IconButton icon={RefreshCw} label={t("remote.refresh")} onClick={() => void loadQueues()} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {loading ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("remote.loading")}</p>
          ) : queues.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("remote.queuesEmpty")}</p>
          ) : (
            queues.map((queue) => (
              <button
                key={queue.name}
                onClick={() => setSelected(queue.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void deleteQueue(queue.name);
                }}
                className={`group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] ${
                  queue.name === selected
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
              >
                <Inbox size={12} className="shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{queue.name}</span>
                {/* -1 is "the depth read failed for this one", which is not the same as empty. */}
                <span className="shrink-0 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
                  {queue.approximate_count < 0 ? "—" : `~${queue.approximate_count}`}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
          <span className="mr-auto min-w-0 truncate text-[12px] text-[var(--cf-text)]">
            {selected || t("remote.queuePickOne")}
          </span>
          <IconButton
            icon={RefreshCw}
            label={t("remote.queuePeek")}
            onClick={() => void peek(selected)}
            disabled={!selected || busy}
          />
          <button
            type="button"
            onClick={() => void receive()}
            disabled={!selected || busy}
            title={t("remote.queueReceiveHint", { seconds: VISIBILITY_SECONDS })}
            className="shrink-0 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-40"
          >
            {t("remote.queueReceive")}
          </button>
          <IconButton
            icon={Eraser}
            label={t("remote.queueClear")}
            onClick={() => void clear()}
            disabled={!selected}
            danger
          />
        </div>

        {/* Said once, above the rows, rather than repeated on every one: these messages are out of
            the queue right now and come back if nothing deletes them. */}
        {received && (
          <p className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-2 py-1 text-[11px] text-[var(--cf-accent)]">
            <TriangleAlert size={12} className="shrink-0" />
            {t("remote.queueReceivedNote", { seconds: VISIBILITY_SECONDS })}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!selected ? (
            <EmptyState icon={Inbox} title={t("remote.queuePickOne")} subtitle={t("remote.queuePickOneHint")} />
          ) : messages.length === 0 ? (
            <EmptyState icon={Inbox} title={t("remote.queueNoMessages")} subtitle={t("remote.queueNoMessagesHint")} />
          ) : (
            messages.map((message) => (
              <div key={message.id} className="group border-b border-[var(--cf-border)] px-2 py-1.5">
                <div className="flex items-center gap-2 text-[10px] text-[var(--cf-text-muted)]">
                  <span className="truncate font-mono">{message.id}</span>
                  {/* The number people open this panel for: a message that keeps coming back. */}
                  {message.dequeue_count > 1 && (
                    <span className="shrink-0 rounded bg-[var(--cf-danger)]/10 px-1 text-[var(--cf-danger)]">
                      {t("remote.queueDequeued", { n: message.dequeue_count })}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 tabular-nums">
                    {message.inserted_at ? new Date(message.inserted_at * 1000).toLocaleString() : "—"}
                  </span>
                  {message.pop_receipt && (
                    <IconButton
                      icon={Trash2}
                      label={t("remote.queueDeleteMessage")}
                      onClick={() => void remove(message)}
                      danger
                    />
                  )}
                </div>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--cf-text)]">
                  {message.body}
                </pre>
                {!message.is_text && (
                  <p className="text-[10px] text-[var(--cf-text-muted)]">{t("remote.queueBinary")}</p>
                )}
              </div>
            ))
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 border-t border-[var(--cf-border)] p-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            placeholder={t("remote.queuePutPlaceholder")}
            disabled={!selected}
            className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!selected || !draft.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
          >
            <Send size={12} />
            {t("remote.queuePut")}
          </button>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: typeof Plus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08] ${
        danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-text)]"
      }`}
    >
      <Icon size={13} />
    </button>
  );
}
