import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eraser,
  Inbox,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { Skeleton } from "../common/Skeleton";
import { ContextMenu } from "../api/CollectionTree";
import { CARD, ToolbarButton } from "./remoteChrome";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import {
  remoteQueueClear,
  remoteQueueCreate,
  remoteQueueDeleteMessage,
  remoteQueueDepths,
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
 *
 * **The names arrive before the numbers, and the numbers are counted on screen.** A queue's depth is
 * not in the listing — it is one `comp=metadata` request per queue — so an account with two hundred
 * of them used to spend a minute showing the word "Loading…" and nothing else, which is
 * indistinguishable from being broken. Now the listing (one request) draws the rail immediately and
 * the depths fill in behind a bar that says how far along it is. Twelve are in the air at a time;
 * see `remotes::cloud::queue::depths` for why not all of them.
 */

/** How long a received message stays hidden. Long enough to read it and decide; short enough that
 *  a mistake reappears while the user is still looking at the panel. */
const VISIBILITY_SECONDS = 30;
const HOW_MANY = 32;
/** How many depths are asked for per round trip. Small enough that the bar moves — a batch is one
 *  IPC call and one repaint — and large enough that the per-call overhead stays negligible. */
const DEPTH_BATCH = 24;

export function QueuePanel({ hostId }: { hostId: string }) {
  const t = useT();
  const [queues, setQueues] = useState<QueueSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [messages, setMessages] = useState<QueueMessage[]>([]);
  /** Whether what is on screen came from a receive. A peeked list has no pop receipts, so the
   *  delete button would be dead — saying which read produced these rows is what explains that. */
  const [received, setReceived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  /** How far the depth pass has got. `null` when it isn't running. */
  const [counting, setCounting] = useState<{ done: number; total: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);

  /**
   * Two request tokens, not one, and the split is load-bearing.
   *
   * A stale answer has to be dropped — the panel is reused across accounts, and a listing for the
   * one you just left must not repaint the one you are looking at. But the *rail* and the *messages*
   * are two independent conversations, and sharing a counter between them made each one cancel the
   * other: `loadQueues` selects the first queue, that fires a `peek`, and a single shared token
   * would then have moved past the depth pass still awaiting its first batch — so on every open of
   * every account, no depth was ever written and the counting bar sat at 0 forever.
   */
  const listToken = useRef(0);
  const msgToken = useRef(0);

  const fail = (e: unknown) => pushErrorToast(String(e));

  // A different account is a different everything — see `TablePanel` for the same guard and the bug
  // that made it necessary.
  useEffect(() => {
    listToken.current += 1;
    msgToken.current += 1;
    setQueues([]);
    setSelected("");
    setMessages([]);
    setReceived(false);
    setSearch("");
    setDraft("");
    setCounting(null);
  }, [hostId]);

  const loadQueues = useCallback(async () => {
    const mine = ++listToken.current;
    setLoading(true);
    setCounting(null);
    try {
      const found = await remoteQueues(hostId);
      if (listToken.current !== mine) return;
      setQueues(found);
      setLoading(false);
      // Land on the first queue rather than an empty pane: an account with one queue should not
      // need a click to show it.
      setSelected((current) =>
        current && found.some((q) => q.name === current) ? current : found[0]?.name ?? "",
      );

      // The depths, in batches, behind a bar. Each batch is written as it lands so the rail fills
      // in from the top rather than all at once at the end.
      if (found.length === 0) return;
      setCounting({ done: 0, total: found.length });
      for (let at = 0; at < found.length; at += DEPTH_BATCH) {
        const batch = found.slice(at, at + DEPTH_BATCH).map((queue) => queue.name);
        let depths: number[];
        try {
          depths = await remoteQueueDepths(hostId, batch);
        } catch {
          // A failed batch leaves those queues at -1 — "the depth read failed", which the rail draws
          // as a dash. Reporting it would be a toast per batch for an account whose credential
          // simply can't read queue metadata.
          depths = batch.map(() => -1);
        }
        if (listToken.current !== mine) return;
        setQueues((current) =>
          current.map((queue) => {
            const index = batch.indexOf(queue.name);
            return index >= 0 ? { ...queue, approximate_count: depths[index] ?? -1 } : queue;
          }),
        );
        setCounting({ done: Math.min(at + DEPTH_BATCH, found.length), total: found.length });
      }
    } catch (e) {
      if (listToken.current === mine) fail(e);
    } finally {
      // Unconditionally: whoever superseded this pass owns the *content* of the rail, but nothing
      // else will ever take down the spinner and the bar this pass put up, and a progress bar with
      // no owner sits at 40% for the life of the tab.
      setLoading(false);
      setCounting(null);
    }
  }, [hostId]);

  const peek = useCallback(
    async (name: string) => {
      if (!name) {
        setMessages([]);
        return;
      }
      const mine = ++msgToken.current;
      setBusy(true);
      try {
        const found = await remoteQueuePeek(hostId, name, HOW_MANY);
        if (msgToken.current !== mine) return;
        setMessages(found);
        setReceived(false);
      } catch (e) {
        if (msgToken.current === mine) fail(e);
      } finally {
        if (msgToken.current === mine) setBusy(false);
      }
    },
    [hostId],
  );

  useEffect(() => {
    void loadQueues();
  }, [loadQueues]);

  useEffect(() => {
    void peek(selected);
  }, [selected, peek]);

  /** Re-reads one queue's depth after something changed it, rather than re-counting the account. */
  const refreshDepth = async (name: string) => {
    try {
      const [depth] = await remoteQueueDepths(hostId, [name]);
      setQueues((current) =>
        current.map((queue) =>
          queue.name === name ? { ...queue, approximate_count: depth ?? -1 } : queue,
        ),
      );
    } catch {
      // The list is still right; only one number is stale, and it is labelled approximate.
    }
  };

  const receive = async (name: string) => {
    if (!name) return;
    // Guarded like `peek`, and for a sharper reason: these rows carry pop receipts, so the trash
    // button beside each one is live. A receive for queue A landing after the user has clicked
    // queue B would put A's deletable messages under B's name — and `remove` sends whatever
    // `selected` says, so the click would delete from B.
    const mine = ++msgToken.current;
    setBusy(true);
    try {
      const found = await remoteQueueReceive(hostId, name, HOW_MANY, VISIBILITY_SECONDS);
      if (msgToken.current !== mine) return;
      setMessages(found);
      setReceived(true);
      void refreshDepth(name);
    } catch (e) {
      if (msgToken.current === mine) fail(e);
    } finally {
      if (msgToken.current === mine) setBusy(false);
    }
  };

  const send = async () => {
    if (!selected || !draft.trim()) return;
    try {
      await remoteQueuePut(hostId, selected, draft);
      setDraft("");
      await peek(selected);
      void refreshDepth(selected);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (message: QueueMessage) => {
    try {
      await remoteQueueDeleteMessage(hostId, selected, message.id, message.pop_receipt);
      setMessages((current) => current.filter((one) => one.id !== message.id));
      void refreshDepth(selected);
    } catch (e) {
      fail(e);
    }
  };

  /**
   * Empties one queue — the one named, never "the selected one".
   *
   * The rail's context menu can only say which queue it means by passing it: a `setSelected` before
   * the call cannot reach a closure that has already captured the old value, so a menu that set the
   * selection and then called a no-argument `clear` emptied whichever queue happened to be selected
   * — right-click one queue, destroy another, with the confirm naming the wrong one.
   */
  const clear = async (name: string) => {
    if (!name) return;
    const ok = await confirmAction(
      t("remote.queueClearConfirm", { name }),
      true,
      t("remote.queueClear"),
    );
    if (!ok) return;
    try {
      await remoteQueueClear(hostId, name);
      if (name === selected) setMessages([]);
      void refreshDepth(name);
    } catch (e) {
      fail(e);
    }
  };

  const deleteQueue = async (name: string) => {
    const ok = await confirmAction(t("remote.queueDeleteConfirm", { name }), true, t("common.delete"));
    if (!ok) return;
    try {
      await remoteQueueRemove(hostId, name);
      if (selected === name) setSelected("");
      void loadQueues();
    } catch (e) {
      fail(e);
    }
  };

  const createQueue = async () => {
    const name = await promptAction(t("remote.queueNewPrompt"), {
      placeholder: "work-items",
      confirmLabel: t("common.create"),
      // Checked as it is typed: the service answers a bad name with `InvalidResourceName` and none
      // of the rule, and the rule is the whole content of the message.
      validate: (value) =>
        /^[a-z0-9]([a-z0-9-]{1,61})[a-z0-9]$/.test(value.trim()) && !value.includes("--")
          ? null
          : t("remote.queueNameRule"),
    });
    if (!name) return;
    try {
      await remoteQueueCreate(hostId, name.trim());
      await loadQueues();
      setSelected(name.trim());
    } catch (e) {
      fail(e);
    }
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? queues.filter((one) => one.name.toLowerCase().includes(needle)) : queues;
  }, [queues, search]);

  return (
    <div className={`flex h-full min-h-0 ${CARD}`}>
      {/* The queues, as a rail. Narrow and fixed: a name and a depth is all a queue has to show
          from the outside, and the messages are what the width is for. */}
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--cf-border)]">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
          <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("remote.queues")}
            {queues.length > 0 && (
              <span className="ml-1 tabular-nums opacity-60">{queues.length}</span>
            )}
          </span>
          <ToolbarButton icon={Plus} label={t("remote.queueNew")} onClick={() => void createQueue()} />
          <ToolbarButton
            icon={RefreshCw}
            label={t("remote.refresh")}
            onClick={() => void loadQueues()}
          />
        </div>
        <div className="shrink-0 border-b border-[var(--cf-border)] px-2 py-1">
          <div className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-1.5">
            <Search size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("remote.queueSearch")}
              className="min-w-0 flex-1 bg-transparent py-1 text-[11px] outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label={t("common.clear")}
                className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={11} />
              </button>
            )}
          </div>
        </div>

        {/* What the panel is doing, in numbers. The listing is one request and is over almost at
            once; the depths are one request per queue, so this is the part that takes the time and
            the part worth reporting. */}
        {counting && (
          <div className="shrink-0 border-b border-[var(--cf-border)] px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--cf-text-muted)]">
              <Loader2 size={10} className="shrink-0 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{t("remote.queueCounting")}</span>
              <span className="shrink-0 tabular-nums">
                {counting.done}/{counting.total}
              </span>
            </div>
            <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
              <div
                className="h-full rounded-full bg-[var(--cf-accent)] transition-[width] duration-150"
                style={{ width: `${(counting.done / Math.max(1, counting.total)) * 100}%` }}
              />
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {loading ? (
            // Rows rather than a word: the shape of what is coming, so the wait reads as a list
            // arriving instead of as nothing happening.
            <div className="space-y-1.5 p-1">
              {Array.from({ length: 7 }).map((_, at) => (
                <Skeleton key={at} className="h-4" style={{ width: `${58 + ((at * 11) % 36)}%` }} />
              ))}
            </div>
          ) : queues.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
              {t("remote.queuesEmpty")}
            </p>
          ) : visible.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
              {t("remote.queueSearchEmpty")}
            </p>
          ) : (
            visible.map((queue) => (
              <button
                key={queue.name}
                onClick={() => setSelected(queue.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, name: queue.name });
                }}
                className={`group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] ${
                  queue.name === selected
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
              >
                <Inbox size={12} className="shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{queue.name}</span>
                {/* -1 is "the depth isn't known" — either not counted yet or the read failed for
                    this one — which is not the same as empty. */}
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
          {busy && <Loader2 size={12} className="shrink-0 animate-spin text-[var(--cf-text-muted)]" />}
          <ToolbarButton
            icon={RefreshCw}
            label={t("remote.queuePeek")}
            onClick={() => void peek(selected)}
            disabled={!selected || busy}
          />
          <button
            type="button"
            onClick={() => void receive(selected)}
            disabled={!selected || busy}
            title={t("remote.queueReceiveHint", { seconds: VISIBILITY_SECONDS })}
            className="shrink-0 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-40"
          >
            {t("remote.queueReceive")}
          </button>
          <ToolbarButton
            icon={Eraser}
            label={t("remote.queueClear")}
            onClick={() => void clear(selected)}
            disabled={!selected}
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
            <EmptyState
              icon={Inbox}
              title={t("remote.queuePickOne")}
              subtitle={t("remote.queuePickOneHint")}
            />
          ) : busy && messages.length === 0 ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 5 }).map((_, at) => (
                <Skeleton key={at} className="h-8" />
              ))}
            </div>
          ) : messages.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={t("remote.queueNoMessages")}
              subtitle={t("remote.queueNoMessagesHint")}
            />
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
                    <button
                      type="button"
                      onClick={() => void remove(message)}
                      title={t("remote.queueDeleteMessage")}
                      aria-label={t("remote.queueDeleteMessage")}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
                    >
                      <Trash2 size={12} />
                    </button>
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={menu.name}
          items={[
            {
              label: t("remote.queuePeek"),
              icon: RefreshCw,
              onClick: () => {
                setSelected(menu.name);
                void peek(menu.name);
              },
            },
            {
              label: t("remote.queueClear"),
              icon: Eraser,
              danger: true,
              separated: true,
              onClick: () => void clear(menu.name),
            },
            {
              label: t("common.delete"),
              icon: Trash2,
              danger: true,
              onClick: () => void deleteQueue(menu.name),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
