import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ClipboardCopy,
  Columns3,
  Copy,
  Download,
  Eraser,
  Inbox,
  Loader2,
  MailOpen,
  Plus,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  SquareCheck,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { SkeletonRows } from "../common/Skeleton";
import { ColumnsModal } from "../common/ColumnsModal";
import { DataGrid, autoFitWidth, autoFitWidths, type GridColumn } from "../common/DataGrid";
import { range } from "../common/gridBits";
import { useColumnPrefs } from "../common/useColumnPrefs";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { CARD, ToolbarButton, WorkBar, formatWhen } from "./remoteChrome";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { writeFileBytes } from "../../lib/tauri/commands";
import { apiReadTextFile } from "../../lib/tauri/apiCommands";
import { parseCsvGrid, toCsv } from "../../lib/csv";
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
import type { TranslationKey } from "../../lib/i18n/translations";

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
 * the depths fill in behind a bar that says how far along it is, with a Stop on it. Twelve are in the
 * air at a time; see `remotes::cloud::queue::depths` for why not all of them.
 *
 * **The messages are a grid, not a stack of cards, and the body is one line.** A card per message
 * drew the payload in a `<pre>` that wrapped forever: one 40KB job description was the whole pane,
 * and the two facts people open this panel for — the dequeue count and when the thing was inserted —
 * were pushed off the bottom by it. So the same `common/DataGrid` the Table and blob views use, with
 * the body cut to a line and the whole of it on the hover. Nothing is lost that a column cannot say:
 * the id, the timestamps, the receipt and the count are columns, and a column that no message filled
 * is not drawn at all — which is how a peeked list has no Pop receipt header and a received one does.
 *
 * **Deleting is a selection, not a button per row.** The trash can beside every message could only
 * ever mean that message, and clearing forty poison messages was forty clicks and forty confirms.
 * The toolbar's delete says how many it is about to take, asks once, and reports the failures as a
 * count rather than as forty toasts.
 *
 * **What is deliberately not here**: editing a message. That is Update Message, and
 * `remotes::cloud::queue` has no such operation — nine `pub async fn`, none of them an update — so a
 * button for it could only ever fail. Its absence is a statement about the backend, not an oversight.
 */

/** How long a received message stays hidden, by default. Long enough to read it and decide; short
 *  enough that a mistake reappears while the user is still looking at the panel. */
const DEFAULT_VISIBILITY = 30;
/**
 * The service's documented ceiling for a visibility timeout, seven days.
 *
 * Asserted from Azure's documentation rather than from this code: `queue::receive` passes whatever it
 * is given straight through, so the only thing stopping a typo of `999999` from becoming a request
 * the service rejects is this input's own bound.
 */
const MAX_VISIBILITY = 7 * 24 * 60 * 60;
/** The most messages one read can ask for, and therefore also the default: it is the *service's*
 *  maximum, `queue::PEEK_MAX`, which clamps anything larger — so asking for more is not a bigger
 *  read, it is the same read with a number that lies. */
const READ_MAX = 32;
/** How many depths are asked for per round trip. Small enough that the bar moves — a batch is one
 *  IPC call and one repaint — and large enough that the per-call overhead stays negligible. */
const DEPTH_BATCH = 24;

/**
 * The sort key, as a column key rather than as an enum.
 *
 * `null` is a state and not an absence: it is the order the service returned, which for a queue is
 * the order the messages are *in* — front first — and is therefore the only order that means
 * anything about the queue itself. The cycle is ascending → descending → back to it.
 */
type Sort = { column: string; descending: boolean } | null;

/** A value the sort may compare as a number. Deliberately narrower than `Number`, which also accepts
 *  `0x10` and `" 1 "` — see the comparator. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** The two read options are numbers in a row of labels, and both are narrow: a count that goes to 32
 *  and a timeout in seconds are three or four digits, not a text field. */
const NUMBER_INPUT =
  "w-20 rounded-md border border-[var(--cf-border)] bg-transparent px-1.5 py-0.5 text-[11px] tabular-nums outline-none focus:border-[var(--cf-accent)] disabled:opacity-40";

export function QueuePanel({ hostId }: { hostId: string }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [queues, setQueues] = useState<QueueSummary[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [messages, setMessages] = useState<QueueMessage[]>([]);
  /**
   * The visibility window the rows on screen were received for, or `null` when they were peeked.
   *
   * The *number* rather than a boolean, because the banner states a fact about these messages — "these
   * are off the queue for 30s" — and the input beside it is now editable. Read from `visibility`, the
   * banner would re-word itself the moment somebody typed a different timeout into the options row,
   * announcing a window these rows were never hidden for. A peeked list has no pop receipts, so
   * deleting is dead there, which is the other half of what this flag explains.
   */
  const [received, setReceived] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  /** How far the depth pass has got. `null` when it isn't running. */
  const [counting, setCounting] = useState<{ done: number; total: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  /** The row menu holds the *message*, not its index. An index into the sorted view is exactly as
   *  unstable as an index-based selection: a peek landing while the menu is open rebuilds the list,
   *  and Delete would then be pointed at whatever now sits at that position. */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; message: QueueMessage } | null>(
    null,
  );
  const [sort, setSort] = useState<Sort>(null);
  /**
   * The picked message ids.
   *
   * Ids rather than row indices, for the reason the entity grid holds keys and the file browser holds
   * paths: sorting by a column rebuilds the view, and a selection of "rows 3, 4 and 5" would then be
   * three *different* messages with the delete button pointed at them.
   */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  /** Bumped by each read — the grid's scroll-to-top signal. Every read of a queue is a fresh one:
   *  there is no continuation to append, so there is no case where this must *not* move. */
  const [epoch, setEpoch] = useState(0);
  const [customizing, setCustomizing] = useState(false);
  const [working, setWorking] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );
  /** How many messages a read asks for, and how long a receive hides them. Caller parameters on both
   *  commands already (`queue::peek`, `queue::receive`), so the panel's old constants were defaults
   *  masquerading as limits. */
  const [count, setCount] = useState(READ_MAX);
  const [visibility, setVisibility] = useState(DEFAULT_VISIBILITY);
  /** Whether the read-options row is showing. Collapsed by default: it is a bar's worth of height
   *  spent on two numbers most reads never change, and the toolbar's toggle carries the `active` tint
   *  whenever either of them is no longer the default. */
  const [showOptions, setShowOptions] = useState(false);

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
  /**
   * Set by the work bar's stop button; read between iterations of the loops that can run long — a
   * bulk delete, an import of a file of messages.
   *
   * Cooperative rather than an abort: the request in flight finishes, and nothing after it is sent.
   * There is no other way out of a loop of round trips — no single request is slow enough to cancel,
   * and the fortieth is as far away as the first.
   */
  const stopped = useRef(false);
  /**
   * The depth pass has its own stop flag, and it has to.
   *
   * It is the *rail's* work and it runs concurrently with the message pane's by design — opening an
   * account starts the count and peeks the first queue in the same breath — so one flag for both
   * would mean the Stop on either bar ended whichever loop noticed it first.
   */
  const countStopped = useRef(false);
  const anchor = useRef(0);
  /** Ids kept from before an additive sweep began, so dragging back up shrinks the run rather than
   *  leaving a trail behind it. */
  const kept = useRef<Set<string>>(new Set());
  /** Which queue is selected *now*, for the loops that captured a name minutes ago. */
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /**
   * How many messages to read, for `peek`.
   *
   * A ref rather than a dependency: `peek` is the `useCallback` the selection effect runs, so reading
   * `count` from the closure would put it in that effect's dependency list — and typing a `3` into
   * the options row would then re-read the queue on every keystroke.
   */
  const countRef = useRef(count);
  countRef.current = count;
  /** Column preferences, keyed by queue name and cleared by the hook when `hostId` changes — a
   *  different account is a different everything, including the widths. */
  const { prefsFor, update: updatePrefs, version: prefsVersion } = useColumnPrefs(hostId);

  const fail = (e: unknown) => pushErrorToast(String(e));

  // A different account is a different everything — see `TablePanel` for the same guard and the bug
  // that made it necessary.
  useEffect(() => {
    listToken.current += 1;
    msgToken.current += 1;
    setQueues([]);
    setSelected("");
    setMessages([]);
    setReceived(null);
    setSearch("");
    setDraft("");
    setCounting(null);
    setSelectedIds(new Set());
    setSort(null);
    setCount(READ_MAX);
    setVisibility(DEFAULT_VISIBILITY);
    // The column preferences are cleared by `useColumnPrefs`, which watches the same `hostId` — it
    // owns the map, so it owns the reset.
  }, [hostId]);

  const loadQueues = useCallback(async () => {
    const mine = ++listToken.current;
    setLoading(true);
    setCounting(null);
    countStopped.current = false;
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
        // Stopped: the queues that have not been counted keep their -1 and the rail draws them as a
        // dash, which is the truth — "not counted" rather than "empty".
        if (countStopped.current) return;
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
        const found = await remoteQueuePeek(hostId, name, countRef.current);
        if (msgToken.current !== mine) return;
        setMessages(found);
        setReceived(null);
        // A read replaces every row, so the ids that were picked may not be here any more — and a
        // selection that survives into rows the user has not looked at is a delete aimed at guesses.
        setSelectedIds(new Set());
        anchor.current = 0;
        setEpoch((n) => n + 1);
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

  // Selecting a queue starts it over. A sort key belongs to the messages it was clicked over — one
  // queue's bodies say nothing about another's order — and so does the selection.
  useEffect(() => {
    setSort(null);
    setSelectedIds(new Set());
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
    // Guarded like `peek`, and for a sharper reason: these rows carry pop receipts, so deleting them
    // is live. A receive for queue A landing after the user has clicked queue B would put A's
    // deletable messages under B's name — and the delete sends whatever is selected *now*, so the
    // click would delete from B.
    const mine = ++msgToken.current;
    setBusy(true);
    try {
      const found = await remoteQueueReceive(hostId, name, count, visibility);
      if (msgToken.current !== mine) return;
      setMessages(found);
      // The window these rows were actually taken for, not whatever the input says later.
      setReceived(visibility);
      setSelectedIds(new Set());
      anchor.current = 0;
      setEpoch((n) => n + 1);
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
      if (name === selected) {
        setMessages([]);
        setSelectedIds(new Set());
      }
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

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  const declared = useMemo(() => queueColumns(t, language), [t, language]);
  const settings = prefsFor(selected);

  /**
   * Which declared columns this read filled — derived per render rather than accumulated, which is
   * the one place this panel deliberately differs from the object browser.
   *
   * There it is a union across pages, because a continuation can carry a column page one did not and
   * a refresh must not take it away again. A queue read has no continuation: every peek and every
   * receive replaces the whole list, so a union would keep the Pop receipt column drawn over a peeked
   * list that has no receipts in it — an empty column asserting that these rows can be deleted. Thirty
   * two rows is also small enough that `some` per column is cheaper than the state to remember it.
   */
  const filled = useMemo(
    () =>
      new Set(
        declared
          .filter((column) => messages.some((message) => column.filled(message)))
          .map((column) => column.key),
      ),
    [declared, messages],
  );

  /**
   * Every column this queue could draw, in display order: the ones something filled, plus the ones
   * the user pinned by hand, arranged the way they arranged them.
   *
   * `prefsVersion` is in the dependency list on purpose — the preferences live in a ref so they
   * survive clicking to another queue and back, and a ref changing is not something a memo can see.
   */
  const allColumns = useMemo(() => {
    const available = declared.filter(
      (column) => filled.has(column.key) || settings.extra.includes(column.key),
    );
    if (!settings.order) return available;
    const ordered = settings.order
      .map((key) => available.find((column) => column.key === key))
      .filter((column): column is QueueColumn => !!column);
    for (const column of available) if (!ordered.includes(column)) ordered.push(column);
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declared, filled, prefsVersion, selected]);

  const columns = useMemo(
    () => allColumns.filter((column) => !settings.hidden.has(column.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allColumns, prefsVersion, selected],
  );

  /**
   * What the modal lists: every *declared* column, not only the drawn ones.
   *
   * A column nothing filled arrives there unchecked, and checking it is the whole of what "add a
   * column" means for a listing whose fields are fixed by the service — `QueueMessage` has the seven
   * fields it has, so the only useful act is "draw this one anyway". A free-text add-a-column field
   * would offer to pin a name that can never hold a value.
   */
  const modalColumns = useMemo(
    () => [...allColumns, ...declared.filter((column) => !allColumns.includes(column))],
    [allColumns, declared],
  );

  /**
   * The messages as drawn: the queue's own order, or the sort key's.
   *
   * The service offers no ordering at all — a read returns the front of the queue and that is the
   * whole API — so every sort here is over the ≤32 rows on hand, which is also every row there is
   * until somebody receives more.
   */
  const view = useMemo(() => {
    if (!sort) return messages;
    const column = declared.find((one) => one.key === sort.column);
    if (!column) return messages;
    const direction = sort.descending ? -1 : 1;
    return [...messages].sort((a, b) => {
      const left = sortValue(column, a);
      const right = sortValue(column, b);
      // A column that knows its own numeric truth is compared on it and never on its text — see
      // `sortOn`.
      if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
      const leftText = String(left);
      const rightText = String(right);
      // Empty last in both directions: a peeked message has no receipt, and burying the rows with
      // nothing to say under the ones that do is the point of sorting by a column at all.
      if (leftText === "" && rightText === "") return 0;
      if (leftText === "") return 1;
      if (rightText === "") return -1;
      // Both sides plainly decimal, or neither. A looser test would send some pairs down the numeric
      // branch and others down the string one, and a comparator that mixes the two stops being a
      // total order — which `Array.sort` is entitled to answer with arbitrary output.
      if (DECIMAL.test(leftText) && DECIMAL.test(rightText)) {
        return (Number(leftText) - Number(rightText)) * direction;
      }
      return leftText.localeCompare(rightText, undefined, { numeric: true }) * direction;
    });
  }, [messages, sort, declared]);

  // A fresh read sizes its own columns, and only the ones the user has not dragged: a width set by
  // hand is a decision, and re-fitting it on every peek would undo it every few seconds.
  useEffect(() => {
    if (!selected || messages.length === 0) return;
    const current = prefsFor(selected);
    const missing = columns.filter((column) => current.widths[column.key] === undefined);
    if (missing.length === 0) return;
    updatePrefs(selected, { widths: { ...current.widths, ...autoFitWidths(missing, messages) } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, columns, messages]);

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  const picked = useMemo(
    () => view.filter((message) => selectedIds.has(message.id)),
    [view, selectedIds],
  );

  /** The same selection as the grid wants it — indices into what is currently drawn. */
  const pickedIndices = useMemo(() => {
    const indices = new Set<number>();
    view.forEach((message, index) => {
      if (selectedIds.has(message.id)) indices.add(index);
    });
    return indices;
  }, [view, selectedIds]);

  const idsOf = (indices: Iterable<number>) => {
    const ids = new Set<string>();
    for (const index of indices) {
      const message = view[index];
      if (message) ids.add(message.id);
    }
    return ids;
  };

  const selectRow = (row: number, modifiers: { range: boolean; toggle: boolean }) => {
    if (modifiers.range) {
      const [from, to] = anchor.current <= row ? [anchor.current, row] : [row, anchor.current];
      const run = idsOf(range(from, to));
      setSelectedIds((current) => (modifiers.toggle ? new Set([...current, ...run]) : run));
      return;
    }
    anchor.current = row;
    const message = view[row];
    if (!message) return;
    if (modifiers.toggle) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (!next.delete(message.id)) next.add(message.id);
        return next;
      });
      return;
    }
    setSelectedIds(new Set([message.id]));
  };

  const selectRange = (from: number, to: number, additive: boolean) => {
    // Seeded on the first move of an additive sweep, not on every one: it has to be what was
    // selected when the drag *began*, or dragging back up the gutter would keep re-absorbing the run
    // it is in the middle of shrinking.
    if (!additive) kept.current = new Set();
    else if (kept.current.size === 0) kept.current = new Set(selectedIds);
    const run = idsOf(range(Math.min(from, to), Math.max(from, to)));
    setSelectedIds(additive ? new Set([...kept.current, ...run]) : run);
  };

  const allPicked = view.length > 0 && picked.length >= view.length;
  /** How much of the selection can actually be deleted. A peeked row has no pop receipt, and the
   *  service refuses a delete without one — so this, not the selection size, is what the button says
   *  and what enables it. */
  const deletable = useMemo(() => picked.filter((message) => message.pop_receipt), [picked]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * One loop, one bar, one first-failure toast.
   *
   * Shared by the two loops in this panel long enough to need stopping — a bulk delete and an import
   * — because the rules are the same in both and they are rules that are easy to get subtly wrong:
   * the stop is checked *between* items so the request in flight is never orphaned, the tally counts
   * attempts rather than successes so the bar cannot stall on a run of failures, and only the first
   * failure is reported. Forty toasts for one expired receipt is a wall to dismiss, not information.
   */
  const eachWithBar = async <T,>(
    items: T[],
    label: string,
    run: (item: T) => Promise<void>,
  ): Promise<number> => {
    stopped.current = false;
    setWorking({ done: 0, total: items.length, label });
    let failed = 0;
    for (const [at, item] of items.entries()) {
      if (stopped.current) break;
      try {
        await run(item);
      } catch (e) {
        failed += 1;
        if (failed === 1) fail(e);
      }
      setWorking({ done: at + 1, total: items.length, label });
    }
    setWorking(null);
    return failed;
  };

  const removeMessages = async (targets: QueueMessage[]) => {
    // Only what carries a receipt. Sending the rest would be one guaranteed 400 per peeked row, and
    // a "3 of 5 failed" summary for something the panel could see in advance.
    const targeted = targets.filter((message) => message.pop_receipt);
    if (targeted.length === 0 || working) return;
    const question =
      targeted.length === 1
        ? t("remote.queueDeleteMessageConfirm")
        : t("remote.queueDeleteMessagesConfirm", { n: targeted.length });
    if (!(await confirmAction(question, true, t("common.delete")))) return;

    const queue = selected;
    const gone = new Set<string>();
    const failed = await eachWithBar(targeted, t("remote.queueDeleting"), async (message) => {
      await remoteQueueDeleteMessage(hostId, queue, message.id, message.pop_receipt);
      gone.add(message.id);
    });
    if (failed > 1) pushErrorToast(t("remote.queueDeleteFailedSome", { n: failed }));
    // Dropped from the list rather than re-read, and that is deliberate: the only read that brings
    // back rows *with* receipts is another receive, which would take a fresh batch off the queue — a
    // refresh with a side effect. So the deleted rows go and the rest keep the receipts they hold.
    if (selectedRef.current === queue) {
      setMessages((current) => current.filter((message) => !gone.has(message.id)));
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of gone) next.delete(id);
        return next;
      });
    }
    void refreshDepth(queue);
  };

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    useToastStore.getState().pushToast(t("remote.objCopied"), "success");
  };

  /** Every message on screen, or the selection when there is one — the rule every export in this app
   *  follows, and the one that makes "export" safe to press with nothing picked. */
  const exportMessages = async () => {
    const chosen = picked.length > 0 ? picked : view;
    if (chosen.length === 0) return;
    const path = await saveDialog({
      defaultPath: `${selected}.csv`,
      filters: [
        { name: "CSV", extensions: ["csv"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (!path) return;
    // The columns as drawn, so the file matches what was on screen — including a hidden column being
    // absent from it, which is the reason someone hid it. Each cell's text comes from the column
    // itself for the same reason: the file says what the grid said.
    const text = path.toLowerCase().endsWith(".json")
      ? JSON.stringify(chosen, null, 2)
      : toCsv(
          columns.map((column) => column.label),
          chosen.map((message) => columns.map((column) => column.text(message))),
        );
    try {
      await writeFileBytes(path, new TextEncoder().encode(text));
      useToastStore
        .getState()
        .pushToast(t("remote.queueExported", { n: chosen.length, path }), "success");
    } catch (e) {
      fail(e);
    }
  };

  /**
   * A file of messages onto the back of the queue, one `put` each.
   *
   * Confirmed before the first request rather than reported after the last: this is the one action in
   * the panel that *adds* work to a live queue, and nine hundred jobs nobody meant to enqueue is not
   * something a toast at the end can undo.
   */
  const importMessages = async () => {
    const queue = selected;
    if (!queue || working) return;
    const chosen = await openDialog({
      multiple: false,
      filters: [{ name: "CSV / JSON", extensions: ["csv", "json", "txt"] }],
    });
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    if (!path) return;

    let bodies: string[];
    try {
      const text = await apiReadTextFile(path);
      bodies = path.toLowerCase().endsWith(".json")
        ? jsonMessages(text)
        : csvMessages(text, t("remote.queueColBody"));
    } catch (e) {
      return fail(e);
    }
    if (bodies.length === 0) return pushErrorToast(t("remote.queueImportEmpty"));
    if (
      !(await confirmAction(
        t("remote.queueImportConfirm", { n: bodies.length, name: queue }),
        false,
        t("remote.queueImport"),
      ))
    )
      return;

    let written = 0;
    const failed = await eachWithBar(bodies, t("remote.queueImporting"), async (body) => {
      await remoteQueuePut(hostId, queue, body);
      written += 1;
    });
    useToastStore
      .getState()
      .pushToast(t("remote.queueImported", { n: written }), failed > 0 ? "error" : "success");
    // Only if it is still the queue on screen, and a peek rather than a receive: what was just sent
    // is at the *back*, so this shows the front as it was — which is the honest answer, and the depth
    // beside it is what says the messages arrived.
    if (selectedRef.current === queue) {
      void peek(queue);
      void refreshDepth(queue);
    }
  };

  /**
   * What the right-click offers, and what it offers it *on*.
   *
   * The rule is the entity grid's: right-clicking inside the selection acts on the whole selection,
   * right-clicking outside it moves the selection to that row first — so the menu never operates on
   * something the user cannot see is picked. There is no "open": a message has no editor, because
   * Update Message does not exist in the backend, so the acts a single row has are copying its two
   * halves and deleting it.
   */
  const messageMenu = (message: QueueMessage): MenuItem[] => {
    const targets = selectedIds.has(message.id) && picked.length > 1 ? picked : [message];
    const removable = targets.filter((one) => one.pop_receipt);
    return [
      {
        label: t("remote.queueCopyId"),
        icon: Copy,
        onClick: () => void copyText(targets.map((one) => one.id).join("\n")),
      },
      {
        label: t("remote.queueCopyBody"),
        icon: ClipboardCopy,
        onClick: () => void copyText(targets.map((one) => one.body).join("\n")),
      },
      {
        label:
          removable.length > 1
            ? t("remote.queueDeleteMessages", { n: removable.length })
            : t("remote.queueDeleteMessage"),
        icon: Trash2,
        danger: true,
        separated: true,
        disabled: removable.length === 0 || !!working,
        onClick: () => void removeMessages(targets),
      },
    ];
  };

  const depth = queues.find((queue) => queue.name === selected)?.approximate_count ?? -1;

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
            once; the depths are one request per queue, so this is the part that takes the time, the
            part worth reporting, and the one worth a way out of. */}
        {counting && (
          <WorkBar
            compact
            label={t("remote.queueCounting")}
            done={counting.done}
            total={counting.total}
            onStop={() => {
              countStopped.current = true;
            }}
          />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {loading ? (
            // Rows rather than a word: the shape of what is coming, so the wait reads as a list
            // arriving instead of as nothing happening.
            <SkeletonRows count={7} />
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
        {/* The toolbar, over the grid rather than beside every row — which is where an action that
            applies to a *selection* belongs. Allowed to wrap: with the rail beside it this group has
            a few hundred pixels, and buttons that refuse to wrap are buttons off the right edge. */}
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--cf-border)] px-1.5 py-1">
          <span className="min-w-0 truncate pr-2 text-[12px] text-[var(--cf-text)]">
            {selected || t("remote.queuePickOne")}
          </span>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-0.5">
            {busy && (
              <Loader2 size={12} className="mr-1 shrink-0 animate-spin text-[var(--cf-text-muted)]" />
            )}
            <ToolbarButton
              icon={SlidersHorizontal}
              label={t("remote.queueOptions")}
              onClick={() => setShowOptions((on) => !on)}
              disabled={!selected}
              // Tinted while either number is no longer the default, so a read of three messages is
              // never a mystery about why only three came back.
              active={showOptions || count !== READ_MAX || visibility !== DEFAULT_VISIBILITY}
            />
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
            {/* Peek *is* refresh, and there is one button rather than two: a refresh that received
                would consume the queue it was asked to re-read. */}
            <ToolbarButton
              icon={RefreshCw}
              label={t("remote.queuePeek")}
              onClick={() => void peek(selected)}
              disabled={!selected || busy}
            />
            <ToolbarButton
              icon={MailOpen}
              label={t("remote.queueReceive")}
              // The short name is what a screen reader should say; the consequence is what a hover
              // should. Collapsing them would make the accessible name a sentence.
              title={t("remote.queueReceiveHint", { seconds: visibility })}
              onClick={() => void receive(selected)}
              disabled={!selected || busy}
            />
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
            {/* The count is in the label, not only in the confirm: a button that says what it is
                about to take is the last chance to notice that it is forty things and not one. The
                wrapper carries the explanation because a `title` on a *disabled* button is a tooltip
                most browsers never show — pointer events stop at the disabled element. */}
            <span
              className="flex shrink-0"
              title={deletable.length === 0 ? t("remote.queueNeedsReceipts") : undefined}
            >
              <ToolbarButton
                icon={Trash2}
                label={
                  deletable.length > 1
                    ? t("remote.queueDeleteMessages", { n: deletable.length })
                    : t("remote.queueDeleteMessage")
                }
                onClick={() => void removeMessages(picked)}
                disabled={deletable.length === 0 || !!working}
              />
            </span>
            <ToolbarButton
              icon={Eraser}
              label={t("remote.queueClear")}
              onClick={() => void clear(selected)}
              disabled={!selected || !!working}
            />
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
            {/* One button, two states, because "select all" that cannot un-select is a control the
                user has to reach for the Escape key to undo. */}
            <ToolbarButton
              icon={SquareCheck}
              label={allPicked ? t("remote.selectNone") : t("remote.selectAll")}
              onClick={() =>
                setSelectedIds(allPicked ? new Set() : new Set(view.map((message) => message.id)))
              }
              disabled={view.length === 0}
            />
            <ToolbarButton
              icon={Columns3}
              label={t("remote.gridColumns")}
              onClick={() => setCustomizing(true)}
              disabled={!selected}
              active={settings.hidden.size > 0 || settings.extra.length > 0}
            />
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" />
            <ToolbarButton
              icon={Upload}
              label={t("remote.queueImport")}
              onClick={() => void importMessages()}
              disabled={!selected || !!working}
            />
            <ToolbarButton
              icon={Download}
              label={t("remote.queueExport")}
              onClick={() => void exportMessages()}
              disabled={view.length === 0}
            />
          </div>
        </div>

        {/* Both numbers are the *caller's* on this API — `queue::peek` and `queue::receive` have
            taken them as parameters all along — so they belong in the panel rather than as constants
            it hides behind. Enter re-reads, the same as the Table panel's query row. */}
        {showOptions && (
          <div className="shrink-0 space-y-1 border-b border-[var(--cf-border)] px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
                {t("remote.queueCount")}
                <input
                  type="number"
                  min={1}
                  max={READ_MAX}
                  value={count}
                  // Clamped on the way in rather than on the way out: an empty box and a `40` are
                  // both numbers the service would answer differently from what the box says, and a
                  // field that disagrees with the request it produces is worse than a strict one.
                  onChange={(e) => setCount(clamp(Number(e.target.value), 1, READ_MAX))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void peek(selected);
                  }}
                  disabled={!selected}
                  className={NUMBER_INPUT}
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
                {t("remote.queueVisibility")}
                <input
                  type="number"
                  min={1}
                  max={MAX_VISIBILITY}
                  value={visibility}
                  onChange={(e) => setVisibility(clamp(Number(e.target.value), 1, MAX_VISIBILITY))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void peek(selected);
                  }}
                  disabled={!selected}
                  className={NUMBER_INPUT}
                />
              </label>
            </div>
            <p className="text-[10px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("remote.queueCountHint")}
            </p>
            <p className="text-[10px] leading-relaxed text-[var(--cf-text-muted)]">
              {t("remote.queueVisibilityHint")}
            </p>
          </div>
        )}

        {/* A delete of forty messages, an import of nine hundred — the two loops in this panel that
            are long enough to need a way out. */}
        {working && (
          <WorkBar
            label={working.label}
            done={working.done}
            total={working.total}
            onStop={() => {
              stopped.current = true;
            }}
          />
        )}

        {/* Said once, above the rows, rather than repeated on every one: these messages are out of
            the queue right now and come back if nothing deletes them. */}
        {received !== null && (
          <p className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-2 py-1 text-[11px] text-[var(--cf-accent)]">
            <TriangleAlert size={12} className="shrink-0" />
            {t("remote.queueReceivedNote", { seconds: received })}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {!selected ? (
            <EmptyState
              icon={Inbox}
              title={t("remote.queuePickOne")}
              subtitle={t("remote.queuePickOneHint")}
            />
          ) : busy && messages.length === 0 ? (
            // The shape of a grid rather than the shape of the cards this used to draw: the rows that
            // are coming are 26px tall, and a skeleton that promises something else is a layout that
            // jumps when the answer lands.
            <SkeletonRows count={8} />
          ) : view.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={t("remote.queueNoMessages")}
              subtitle={t("remote.queueNoMessagesHint")}
            />
          ) : (
            <DataGrid<QueueMessage>
              resetKey={`${selected}/${epoch}`}
              columns={columns}
              rows={view}
              widths={settings.widths}
              onWidth={(key, width) =>
                updatePrefs(selected, { widths: { ...settings.widths, [key]: width } })
              }
              onAutoFit={(key) => {
                // The grid reports a key; the measurement needs the column, because what a cell says
                // is the column's answer and not the field's.
                const column = columns.find((candidate) => candidate.key === key);
                if (!column) return;
                updatePrefs(selected, {
                  widths: { ...settings.widths, [key]: autoFitWidth(column, messages) },
                });
              }}
              sort={sort}
              onSort={(column) =>
                setSort((current) =>
                  // asc → desc → the queue's own order, which is the state a message list has to be
                  // able to get back to: front-first is the only order that says anything about what
                  // the next reader will get.
                  current?.column !== column
                    ? { column, descending: false }
                    : current.descending
                      ? null
                      : { column, descending: true },
                )
              }
              selected={pickedIndices}
              onSelectRow={selectRow}
              onSelectRange={selectRange}
              onSelectAll={(on) =>
                setSelectedIds(on ? new Set(view.map((message) => message.id)) : new Set())
              }
              // Double-click and Enter take the payload, because that is the only act a single
              // message has: there is nothing to open — no editor, since Update Message does not
              // exist in the backend — and a double-click that does nothing is worse than one that
              // does the obvious thing.
              onOpenRow={(row) => {
                const message = view[row];
                if (message) void copyText(message.body);
              }}
              onRowContextMenu={(row, event) => {
                const message = view[row];
                if (!message) return;
                if (!pickedIndices.has(row)) selectRow(row, { range: false, toggle: false });
                setRowMenu({ x: event.clientX, y: event.clientY, message });
              }}
            />
          )}
        </div>

        {/* What is on screen and what the queue holds, side by side — and no "load more", which is
            not an omission: the Queue API carries no continuation token, 32 is both the request cap
            and the service's ceiling, and the only way to reach what is behind them is a *receive*.
            A "load more" that consumed the queue to page through it would be a lie. */}
        {selected && (
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-1 text-[11px] text-[var(--cf-text-muted)]">
            <span className="tabular-nums">{t("remote.queueLoadedN", { n: view.length })}</span>
            {picked.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums text-[var(--cf-accent)]">
                  {t("remote.queueSelectedN", { n: picked.length })}
                </span>
              </>
            )}
            {depth >= 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{t("remote.queueDepthN", { n: depth })}</span>
              </>
            )}
          </div>
        )}

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
              label: t("remote.refresh"),
              icon: RefreshCw,
              onClick: () => {
                // Re-peeking the queue you are already on has to be a re-read; on any other one it
                // is a selection, which peeks on its own. Doing both would read the queue twice.
                if (menu.name === selected) void peek(menu.name);
                else setSelected(menu.name);
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

      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          heading={rowMenu.message.id}
          items={messageMenu(rowMenu.message)}
          onClose={() => setRowMenu(null)}
        />
      )}

      {customizing && selected && (
        <ColumnsModal
          columns={modalColumns.map((column) => ({ key: column.key, label: column.label }))}
          // The columns nothing filled are drawn unchecked, which is both true and the affordance:
          // checking one is how you pin a column this read left empty — a Pop receipt header over a
          // peeked list, for someone who wants the layout to stop moving between reads.
          hidden={
            new Set([
              ...settings.hidden,
              ...declared
                .filter((column) => !allColumns.includes(column))
                .map((column) => column.key),
            ])
          }
          onApply={(order, hidden) => {
            // A declared column that nothing filled, left checked, is a column the user asked for by
            // hand — which is what `extra` means for a listing whose fields are fixed. Reset
            // (`order === null`) drops them and puts the column list back on the data.
            const extra = order ? order.filter((key) => !filled.has(key) && !hidden.has(key)) : [];
            const shown = new Set([...filled, ...extra]);
            updatePrefs(selected, {
              order,
              // Only what the user could actually see. The unfilled columns arrive here inside
              // `hidden` because that is how the modal drew them, and storing that would keep Pop
              // receipt off the next *receive*, which does fill it.
              hidden: new Set([...hidden].filter((key) => shown.has(key))),
              extra,
            });
          }}
          onClose={() => setCustomizing(false)}
          // No add-a-column field: `QueueMessage` has the fields it has, so a name typed there could
          // never hold a value. See `modalColumns` for what takes its place.
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * One column of a message list, plus the two things a `GridColumn` has no opinion about.
 *
 * `filled` is what makes a peeked list five columns and a received one six without a second table of
 * column sets: the declared list is the same for both, and what differs is which of them the read put
 * anything in. `sortOn` is what keeps a sort honest where the text is a rendering — see below.
 */
type QueueColumn = GridColumn<QueueMessage> & {
  /** Did *this* message put something in the column. */
  filled: (row: QueueMessage) => boolean;
  /**
   * What the column sorts on, where that is not the text it draws.
   *
   * The two timestamps and the count need it: sorted on their text, a localised `12 Aug 2026` sorts
   * under `1 Dec 2025` and `10` sorts under `9`. The text stays the one definition of what the cell
   * *says* — the hover, the auto-fit and the export read it — and this is the one definition of what
   * it *means*.
   */
  sortOn?: (row: QueueMessage) => string | number;
};

/**
 * Every column a message can have, in the order it is drawn.
 *
 * **Identity, payload, then the facts about it.** The body is the only thing drawn in the text
 * colour: everything else is metadata *about* the message, and drawing it at the same weight is how a
 * list turns into a wall of equal words. It is also why the id comes first and stays narrow — it is
 * what you copy, not what you read.
 */
function queueColumns(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  language: string,
): QueueColumn[] {
  const META = "text-[var(--cf-text-muted)]";
  return [
    {
      key: "id",
      label: t("remote.queueColId"),
      text: (row) => row.id,
      // A GUID is a literal the user compares character by character, or pastes into a log search.
      mono: true,
      cellClass: () => META,
      filled: () => true,
    },
    {
      key: "body",
      label: t("remote.queueColBody"),
      text: (row) => row.body,
      mono: true,
      // Cut to one line by the grid, with the whole of it on the hover — which is the fix for a 40KB
      // payload that used to wrap forever and push everything else off the pane. A body that isn't
      // text is drawn as the dim italic every absent-or-unreadable value in this app is.
      cellClass: (row) => (row.is_text ? "" : `italic ${META}`),
      title: (row) => (row.is_text ? row.body : t("remote.queueBinary")),
      filled: () => true,
    },
    {
      key: "inserted",
      label: t("remote.queueColInserted"),
      text: (row) => formatWhen(row.inserted_at, language),
      sortOn: (row) => row.inserted_at,
      cellClass: () => META,
      filled: (row) => row.inserted_at > 0,
    },
    {
      // Parsed by the backend all along (`queue.rs` reads `ExpirationTime`) and drawn nowhere until
      // now: a message about to expire unhandled is the other half of the story the dequeue count
      // tells, and the request had already paid for it.
      key: "expires",
      label: t("remote.queueColExpires"),
      text: (row) => formatWhen(row.expires_at, language),
      sortOn: (row) => row.expires_at,
      cellClass: () => META,
      filled: (row) => row.expires_at > 0,
    },
    {
      key: "dequeued",
      label: t("remote.queueColDequeued"),
      text: (row) => String(row.dequeue_count),
      sortOn: (row) => row.dequeue_count,
      align: "right",
      // The number people open this panel for: a message that keeps coming back. Tinted rather than
      // badged now that it has a column of its own, and the hover says what the number counts.
      cellClass: (row) => (row.dequeue_count > 1 ? "text-[var(--cf-danger)]" : META),
      title: (row) => t("remote.queueDequeued", { n: row.dequeue_count }),
      filled: () => true,
    },
    {
      // Self-revealing, and it is the most useful column in the list for that reason: a peek carries
      // no receipts and a receive does, so this appears exactly when deleting becomes possible — the
      // same signal the warning banner carries, said in the grid.
      key: "receipt",
      label: t("remote.queueColReceipt"),
      text: (row) => row.pop_receipt,
      mono: true,
      cellClass: () => META,
      filled: (row) => row.pop_receipt !== "",
    },
  ];
}

/** What a column is compared on: its own numeric truth where it has one, its text otherwise. */
function sortValue(column: QueueColumn, row: QueueMessage): string | number {
  return column.sortOn ? column.sortOn(row) : (column.text(row) ?? "");
}

function clamp(value: number, low: number, high: number): number {
  return Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : low;
}

/**
 * A JSON file as messages.
 *
 * **A queue message is a value, not a record**, which is what makes this different from the Table
 * panel's import: there are no keys to match and no fields to map, so the only question is which part
 * of each element is the payload. A string element *is* the message; an object's `body` is taken when
 * it has one, so a file this panel exported goes back in as the messages it came from; anything else
 * is re-serialised, because a queue of JSON jobs is the ordinary case and the object somebody wrote
 * in the file is the payload they meant.
 */
function jsonMessages(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const bodies: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      bodies.push(row);
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const body = (row as Record<string, unknown>).body;
    bodies.push(typeof body === "string" ? body : JSON.stringify(row));
  }
  // An empty message is legal on the wire and useless in a queue, and it is what a trailing element
  // of an exported file looks like.
  return bodies.filter((body) => body !== "");
}

/** Header names the message column may go by, whatever language the file was written in. A file
 *  exported from the Spanish UI has to import into the English one — the label moves with the
 *  language and the file does not. */
const BODY_HEADERS = ["body", "message", "mensaje"];

/**
 * A CSV file as messages, where the payload is one column of it.
 *
 * The header is looked *for* rather than assumed: an export from this panel has one and the message
 * is the column labelled as such, while a plain list of payloads pasted into a file has none and
 * every row's first cell is a message. Taking the first column either way would enqueue the *ids* of
 * a file this panel wrote, which is a queue full of GUIDs.
 */
function csvMessages(text: string, bodyLabel: string): string[] {
  const grid = parseCsvGrid(text);
  if (grid.length === 0) return [];
  const wanted = [bodyLabel.trim().toLowerCase(), ...BODY_HEADERS];
  const at = grid[0].findIndex((cell) => wanted.includes(cell.trim().toLowerCase()));
  const rows = at >= 0 ? grid.slice(1) : grid;
  return rows.map((row) => row[at >= 0 ? at : 0] ?? "").filter((body) => body !== "");
}
