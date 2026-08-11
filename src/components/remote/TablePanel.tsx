import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Columns3,
  Copy,
  Database,
  Download,
  Filter,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sigma,
  SquareCheck,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { EntityEditorModal } from "./EntityEditorModal";
import { TableColumnsModal } from "./TableColumnsModal";
import { EntityGrid, autoFitWidth, autoFitWidths, cellText } from "./EntityGrid";
import { CARD, ToolbarButton } from "./remoteChrome";
import { confirmAction } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { writeFileBytes } from "../../lib/tauri/commands";
import { apiReadTextFile } from "../../lib/tauri/apiCommands";
import {
  remoteTableCreate,
  remoteTableDeleteEntity,
  remoteTableQuery,
  remoteTableRemove,
  remoteTableUpsert,
  remoteTables,
} from "../../lib/tauri/remoteCommands";
import type { TablePage, TableSummary } from "../../types/remote";

/**
 * Azure Table storage: the account's tables down one side, an entity grid beside it.
 *
 * **The columns come from the data, because there is no schema.** Two entities in one table may
 * carry entirely different properties, so the grid's header is the union of everything this panel
 * has seen in this table — with `PartitionKey`, `RowKey` and `Timestamp` pinned first, since those
 * three are the only ones the service guarantees. The union is kept across queries rather than
 * rebuilt from each page, because Azure stores no nulls: a property nothing currently sets is a
 * column that would otherwise vanish and come back as the data changes under it. What the service
 * genuinely cannot supply, "Customize columns" pins by hand — see `TableColumnsModal`.
 *
 * **The filter box says what a filter costs.** A query on both keys is a point read; one on the
 * partition scans that partition; one on neither scans the table and is billed accordingly. The
 * service will run all three without comment, so the panel is where the difference is stated —
 * quietly, under the box, rather than as a warning nobody reads twice.
 *
 * **Every request carries a token, and a stale answer is dropped.** An answer can land after the
 * user has moved on — to another table, or, before `RemoteView` gave each tab its own panel, to
 * another account entirely — and writing it then labels one table's grid with another's rows. There
 * is a token per conversation rather than one for the panel; see the note beside them for why
 * sharing one made each request cancel the other two.
 */

/** How the sort key cycles: unsorted → ascending → descending → unsorted. The third state is the
 *  only way back to the order the service returned, which for a Table is `PartitionKey`, `RowKey`
 *  and is often the order that means something. */
type Sort = { column: string; descending: boolean } | null;

/** The three the service always supplies, in the order every Azure tool draws them. */
const PINNED = ["PartitionKey", "RowKey", "Timestamp"];

/** A value the sort may compare as a number. Deliberately narrower than `Number` — see the sort. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** What the user has decided about one table's columns, kept for as long as the tab is open so
 *  clicking away to another table and back doesn't undo it. */
interface ColumnPrefs {
  /** Pinned display order, or `null` to follow the data. */
  order: string[] | null;
  hidden: Set<string>;
  /** Columns the user named that no entity has yet carried — kept apart from `known` so that
   *  "Reset" can drop them and a fresh query cannot. */
  extra: string[];
  /** Widths the user dragged. Anything not in here is auto-fitted to the content. */
  widths: Record<string, number>;
}

export function TablePanel({ hostId }: { hostId: string }) {
  const t = useT();
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [tableSearch, setTableSearch] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  /**
   * The last result, and the table it came from.
   *
   * The name is not decoration. Clicking another table sets `selected` immediately while the query
   * for it is still going out, so for a beat this holds the *previous* table's entities — and
   * anything reading it in that window reads one table's data under another's name. The auto-fit
   * did exactly that: it measured the old rows and stored the widths under the new table, which then
   * never re-fitted because they were no longer missing. A grid of 36-character GUID keys followed
   * by one of "1" and "2" kept the GUID-wide column, and the reverse arrived truncated.
   */
  const [page, setPage] = useState<{ table: string; data: TablePage } | null>(null);
  /** Every property name seen in this table so far. See the note at the top. */
  const [known, setKnown] = useState<string[]>(PINNED);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * The selection, held as `PartitionKey`/`RowKey` pairs rather than as row indices.
   *
   * An index means nothing across a re-order, and this grid re-orders: sorting by a column rebuilds
   * the view, and a selection of "rows 3, 4 and 5" would silently become three *different* entities
   * under it — with a Delete button pointed at them. The two keys are what the service itself
   * addresses an entity by and the one identity that survives a sort, a re-query and a "load more".
   */
  const [pickedKeys, setPickedKeys] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>(null);
  /** The row menu holds the *entity*, not its index. An index into `view` is exactly as unstable as
   *  the selection was before it moved to keys: a refresh landing while the menu is open rebuilds
   *  `view`, and Delete would then be pointed at whatever entity now sits at that position. */
  const [menu, setMenu] = useState<{ x: number; y: number; entity: Record<string, unknown> } | null>(
    null,
  );
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const [editing, setEditing] = useState<{ entity: Record<string, unknown> | null } | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [stats, setStats] = useState<{
    table: string;
    count: number;
    partitions: number;
    /** The scan was stopped before the end, so `count` is a floor rather than the total. */
    partial: boolean;
  } | null>(null);
  const [working, setWorking] = useState<{ done: number; total: number; label: string } | null>(
    null,
  );

  const anchor = useRef(0);
  /**
   * One request token per concern, and they must not be shared.
   *
   * A stale answer has to be dropped, but "stale" is per conversation: the rail listing, the entity
   * query and the statistics scan run against the same account and cancel nothing of each other's.
   * A single counter made every one of them cancel the other two — and because each clears its own
   * busy flag only when it is still current, the loser's spinner then never came down. Refreshing
   * the rail while a query was in flight left the toolbar disabled for the life of the tab.
   */
  const listToken = useRef(0);
  const queryToken = useRef(0);
  const scanToken = useRef(0);
  /** What is selected *now*, for the loops that captured a table name minutes ago. */
  const selectedRef = useRef("");
  selectedRef.current = selected;
  /**
   * Set by the progress bar's stop button; read between iterations of the three loops that can run
   * long — the count, the import and a bulk delete.
   *
   * A count over a large table is hundreds of round trips and the confirm says so, but "you were
   * warned" is not a way out of a scan somebody started by accident. Stopping is cooperative rather
   * than an abort: the request in flight finishes, and nothing after it is sent.
   */
  const stopped = useRef(false);
  const prefs = useRef(new Map<string, ColumnPrefs>());

  const fail = (e: unknown) => pushErrorToast(String(e));
  const prefsFor = (table: string): ColumnPrefs =>
    prefs.current.get(table) ?? { order: null, hidden: new Set(), extra: [], widths: {} };
  /** Bumped by each *fresh* query, never by a continuation — the grid's scroll-to-top signal. */
  const [queryEpoch, setQueryEpoch] = useState(0);
  const [prefsVersion, setPrefsVersion] = useState(0);
  const updatePrefs = (table: string, changes: Partial<ColumnPrefs>) => {
    prefs.current.set(table, { ...prefsFor(table), ...changes });
    setPrefsVersion((n) => n + 1);
  };

  // A different account is a different everything. Without this the rail would keep the previous
  // account's tables under the new account's name until the listing came back, and — the bug this
  // guard exists for — the selected table would be queried against an account that has never had
  // one by that name.
  useEffect(() => {
    listToken.current += 1;
    queryToken.current += 1;
    scanToken.current += 1;
    setTables([]);
    setSelected("");
    setPage(null);
    setKnown(PINNED);
    setPickedKeys(new Set());
    setSort(null);
    setFilter("");
    setStats(null);
    setTableSearch("");
    prefs.current.clear();
  }, [hostId]);

  const loadTables = useCallback(async () => {
    const mine = ++listToken.current;
    setLoading(true);
    try {
      const found = await remoteTables(hostId);
      if (listToken.current !== mine) return;
      setTables(found);
      setSelected((current) =>
        current && found.some((one) => one.name === current) ? current : found[0]?.name ?? "",
      );
    } catch (e) {
      if (listToken.current === mine) fail(e);
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  /** Runs the query from the first page. `more` continues from where the last one stopped. */
  const run = useCallback(
    async (name: string, expression: string, more?: TablePage) => {
      if (!name) {
        setPage(null);
        return;
      }
      const mine = ++queryToken.current;
      setBusy(true);
      try {
        const next = await remoteTableQuery(
          hostId,
          name,
          expression,
          "",
          more?.next_partition_key ?? "",
          more?.next_row_key ?? "",
        );
        if (queryToken.current !== mine) return;
        // A query started for one table can land after the user has clicked another — the tail of a
        // bulk delete refreshing `orders` while `customers` is on screen. It won the token fairly,
        // so the token cannot catch this; the name has to.
        if (selectedRef.current !== name) return;
        // Appending rather than replacing on a continuation: the point of "load more" is a longer
        // list, and a grid that jumped to page two would lose whatever the user was comparing.
        setPage((current) =>
          more && current?.table === name
            ? { table: name, data: { ...next, rows: [...current.data.rows, ...next.rows] } }
            : { table: name, data: next },
        );
        if (!more) {
          setPickedKeys(new Set());
          // A fresh result, as opposed to another page of the same one. The grid scrolls back to
          // the top for the first and must not for the second.
          setQueryEpoch((n) => n + 1);
        }
        // Union, never replacement — the whole argument is in the file's opening note.
        setKnown((current) => {
          const merged = [...current];
          for (const column of next.columns) if (!merged.includes(column)) merged.push(column);
          return merged.length === current.length ? current : merged;
        });
      } catch (e) {
        if (queryToken.current === mine) {
          fail(e);
          if (!more) setPage(null);
        }
      } finally {
        // Unconditionally — see the note on the tokens. Nothing else will lower a spinner this call
        // raised.
        setBusy(false);
      }
    },
    [hostId],
  );

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  // Selecting a table starts it over: a filter written for one table is meaningless against
  // another, and so is a sort key that table hasn't got.
  useEffect(() => {
    setFilter("");
    setSort(null);
    setPickedKeys(new Set());
    setKnown(PINNED);
    setStats(null);
    void run(selected, "");
  }, [selected, run]);

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  const settings = prefsFor(selected);

  /**
   * Every column the grid could draw, in display order: what the data has, plus what the user
   * pinned, arranged the way they arranged it.
   *
   * `prefsVersion` is in the dependency list on purpose. The preferences live in a ref rather than
   * in state because they are keyed by table and have to survive clicking to another table and
   * back — which the table-change effect above would wipe if they were state — and a ref changing
   * is not something a memo can see. The counter is what makes it visible.
   */
  const allColumns = useMemo(() => {
    const available = [...known];
    for (const column of settings.extra) if (!available.includes(column)) available.push(column);
    if (!settings.order) return available;
    const ordered = settings.order.filter((column) => available.includes(column));
    for (const column of available) if (!ordered.includes(column)) ordered.push(column);
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known, prefsVersion, selected]);

  const columns = useMemo(
    () => allColumns.filter((column) => !settings.hidden.has(column)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allColumns, prefsVersion, selected],
  );

  const rows = page?.table === selected ? page.data.rows : [];

  /**
   * The rows as drawn: the service's order, or the sort key's.
   *
   * Sorted here rather than by the service because the service cannot: a Table's only server-side
   * order is `PartitionKey` then `RowKey`, and `$orderby` is not part of the API. What this sorts is
   * therefore what has been loaded, which the status line says out loud — a sort over three pages of
   * a scan is a sort over three pages, not over the table.
   */
  const view = useMemo(() => {
    if (!sort) return rows;
    const column = sort.column;
    const direction = sort.descending ? -1 : 1;
    return [...rows].sort((a, b) => {
      const left = cellText(a, column);
      const right = cellText(b, column);
      // Absent last in both directions: a missing property is not a small value, and burying the
      // rows that have nothing to say under the ones that do is the point of sorting by it.
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      // Both sides plainly decimal, or neither. `Number` also accepts `0x10`, `0b101` and `" 1 "`,
      // so a looser test sends some pairs down the numeric branch and others down the string one —
      // and a comparator that mixes the two stops being a total order, which `Array.sort` is
      // entitled to turn into arbitrary output rather than a wrong-but-stable order.
      if (DECIMAL.test(left) && DECIMAL.test(right)) {
        return (Number(left) - Number(right)) * direction;
      }
      return left.localeCompare(right, undefined, { numeric: true }) * direction;
    });
  }, [rows, sort]);

  // A fresh page sizes its own columns. Only the ones the user hasn't dragged: a width set by hand
  // is a decision, and re-fitting it on every "load more" would undo it every few seconds.
  //
  // It measures `rows`, which is empty until the page on hand belongs to the selected table — that
  // is what keeps one table's widths from being measured off another's data and then stored under a
  // name that will never re-fit them.
  useEffect(() => {
    if (!selected || rows.length === 0) return;
    const current = prefsFor(selected);
    const missing = columns.filter((column) => current.widths[column] === undefined);
    if (missing.length === 0) return;
    const fitted = autoFitWidths(missing, rows);
    updatePrefs(selected, { widths: { ...current.widths, ...fitted } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, columns, rows]);

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /**
   * An entity's identity.
   *
   * Joined on NUL rather than on a space or a slash: a space is perfectly legal in both keys, so
   * `"a b" + "c"` and `"a" + "b c"` would come out as the same string, and two unrelated entities
   * would select — and delete — as one. A control character is one of the few things the service
   * refuses in a key, which is exactly what makes it safe to join on.
   */
  const identify = (row: Record<string, unknown>) =>
    `${String(row.PartitionKey ?? "")}\u0000${String(row.RowKey ?? "")}`;

  /** The selection as the grid wants it — indices into what is currently drawn. */
  const picked = useMemo(() => {
    const indices = new Set<number>();
    view.forEach((row, index) => {
      if (pickedKeys.has(identify(row))) indices.add(index);
    });
    return indices;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, pickedKeys]);

  const keysOf = (indices: Iterable<number>) => {
    const keys = new Set<string>();
    for (const index of indices) {
      const row = view[index];
      if (row) keys.add(identify(row));
    }
    return keys;
  };

  const selectRow = (row: number, modifiers: { range: boolean; toggle: boolean }) => {
    if (modifiers.range) {
      const [from, to] = anchor.current <= row ? [anchor.current, row] : [row, anchor.current];
      const run = keysOf(range(from, to));
      setPickedKeys((current) => (modifiers.toggle ? new Set([...current, ...run]) : run));
      return;
    }
    anchor.current = row;
    const key = view[row] ? identify(view[row]) : null;
    if (!key) return;
    if (modifiers.toggle) {
      setPickedKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    setPickedKeys(new Set([key]));
  };

  /** Rows kept from before an additive sweep began, so dragging back up shrinks the run rather than
   *  leaving a trail behind it. */
  const kept = useRef<Set<string>>(new Set());
  const selectRange = (from: number, to: number, additive: boolean) => {
    // Seeded on the first move of an additive sweep, not on every one: it has to be what was
    // selected when the drag *began*, or dragging back up the gutter would keep re-absorbing the run
    // it is in the middle of shrinking.
    if (!additive) kept.current = new Set();
    else if (kept.current.size === 0) kept.current = new Set(pickedKeys);
    const run = keysOf(range(Math.min(from, to), Math.max(from, to)));
    setPickedKeys(additive ? new Set([...kept.current, ...run]) : run);
  };

  const pickedRows = useMemo(
    () => view.filter((row) => pickedKeys.has(identify(row))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, pickedKeys],
  );
  const one = pickedRows.length === 1 ? pickedRows[0] : null;
  const allPicked = view.length > 0 && pickedRows.length >= view.length;

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const keyOf = (row: Record<string, unknown>) => ({
    partition: String(row.PartitionKey ?? ""),
    rowKey: String(row.RowKey ?? ""),
  });

  const removeEntities = async (entities: Record<string, unknown>[]) => {
    if (entities.length === 0) return;
    const message =
      entities.length === 1
        ? t("remote.tableDeleteEntityConfirm", {
            key: `${keyOf(entities[0]).partition}/${keyOf(entities[0]).rowKey}`,
          })
        : t("remote.tableDeleteEntitiesConfirm", { n: String(entities.length) });
    if (!(await confirmAction(message, true, t("common.delete")))) return;

    const table = selected;
    stopped.current = false;
    setWorking({ done: 0, total: entities.length, label: t("remote.tableDeleting") });
    let failed = 0;
    for (const [at, entity] of entities.entries()) {
      if (stopped.current) break;
      const { partition, rowKey } = keyOf(entity);
      try {
        await remoteTableDeleteEntity(hostId, table, partition, rowKey);
      } catch (e) {
        failed += 1;
        // The first failure is reported and the rest are counted: forty toasts for a bad key is a
        // wall to dismiss, not information.
        if (failed === 1) fail(e);
      }
      setWorking({ done: at + 1, total: entities.length, label: t("remote.tableDeleting") });
    }
    setWorking(null);
    if (failed > 1) {
      pushErrorToast(t("remote.tableDeleteFailedSome", { n: String(failed) }));
    }
    setPickedKeys(new Set());
    // Only if it is still the table on screen: `run` wins the token, so it would paint `orders`
    // under a rail that is highlighting `customers`.
    if (selectedRef.current === table) void run(table, filter);
  };

  const deleteTable = async (name: string) => {
    if (!(await confirmAction(t("remote.tableDeleteConfirm", { name }), true, t("common.delete"))))
      return;
    try {
      await remoteTableRemove(hostId, name);
      if (selected === name) setSelected("");
      void loadTables();
    } catch (e) {
      fail(e);
    }
  };

  const createTable = async () => {
    const name = await promptAction(t("remote.tableNewPrompt"), {
      initial: "",
      placeholder: "mytable",
      confirmLabel: t("common.create"),
      // Checked here rather than after the round trip: the service answers a bad name with
      // `InvalidResourceName` and no rule in it, and the rule is the whole content of the message.
      validate: (value) =>
        /^[A-Za-z][A-Za-z0-9]{2,62}$/.test(value.trim()) ? null : t("remote.tableNameRule"),
    });
    if (!name) return;
    try {
      await remoteTableCreate(hostId, name.trim());
      await loadTables();
      setSelected(name.trim());
    } catch (e) {
      fail(e);
    }
  };

  /**
   * How many entities the table holds, and across how many partitions.
   *
   * Counted rather than read, because the service keeps no count: there is no `COUNT(*)` and no
   * metadata field for it. So this is a full scan asking for one property per entity — the cheapest
   * shape the count can take, and still a scan, which is why it is a button rather than a number
   * that appears on its own.
   */
  const tableStats = async () => {
    const table = selected;
    if (!table) return;
    if (
      !(await confirmAction(
        t("remote.tableStatsConfirm", { name: table }),
        false,
        t("remote.tableCount"),
      ))
    )
      return;
    const mine = ++scanToken.current;
    const partitions = new Set<string>();
    let count = 0;
    let cursor: TablePage | undefined;
    stopped.current = false;
    setWorking({ done: 0, total: 0, label: t("remote.tableCounting") });
    try {
      do {
        const next: TablePage = await remoteTableQuery(
          hostId,
          table,
          "",
          // Only the partition key comes back: the rows are counted, not read, and a scan that
          // dragged every property across the wire would cost many times as much for the same
          // number.
          "PartitionKey",
          cursor?.next_partition_key ?? "",
          cursor?.next_row_key ?? "",
        );
        if (scanToken.current !== mine) return;
        count += next.rows.length;
        for (const row of next.rows) partitions.add(String(row.PartitionKey ?? ""));
        setWorking({ done: count, total: 0, label: t("remote.tableCounting") });
        // The partition token alone continues — see `remotes::cloud::table::query`. Requiring the
        // row key too made this count stop at the first page that ended on a partition boundary.
        cursor = next.next_partition_key ? next : undefined;
      } while (cursor && !stopped.current);
      // Recorded either way, and labelled: a partial count is still the answer to "is this table
      // big", which is usually the question. `partial` is what stops it being read as the total.
      setStats({ table, count, partitions: partitions.size, partial: !!cursor });
    } catch (e) {
      if (scanToken.current === mine) fail(e);
    } finally {
      // Unconditionally, unlike the other guards: if something else bumped the token mid-scan, this
      // loop is the only thing that will ever clear the bar it put up, and a progress bar nobody
      // owns any more sits there for the life of the tab.
      setWorking(null);
    }
  };

  /** Every loaded row, or the selection when there is one — the rule every export in this app
   *  follows, and the one that makes "export" safe to press with nothing picked. */
  const exportRows = async () => {
    const chosen = pickedRows.length > 0 ? pickedRows : view;
    if (chosen.length === 0) return;
    const path = await saveDialog({
      defaultPath: `${selected}.csv`,
      filters: [
        { name: "CSV", extensions: ["csv"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (!path) return;
    const json = path.toLowerCase().endsWith(".json");
    // The columns as drawn, so an export matches what was on screen — including a hidden column
    // being absent from it, which is the reason someone hid it.
    const text = json ? JSON.stringify(chosen, null, 2) : toCsv(columns, chosen);
    try {
      await writeFileBytes(path, new TextEncoder().encode(text));
      useToastStore
        .getState()
        .pushToast(t("remote.tableExported", { n: String(chosen.length), path }), "success");
    } catch (e) {
      fail(e);
    }
  };

  /**
   * Entities from a file, one upsert each.
   *
   * JSON (an array of objects) and CSV, which are what an export produces and what anybody who has
   * one of these tables already has lying around. Every row needs both keys — the service addresses
   * an entity by them and has nothing to do with a row that names neither — so a file missing them
   * is rejected before a single request goes out rather than half way through.
   */
  const importRows = async () => {
    const table = selected;
    if (!table) return;
    const chosen = await openDialog({
      multiple: false,
      filters: [{ name: "CSV / JSON", extensions: ["csv", "json"] }],
    });
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    if (!path) return;

    let entities: Record<string, unknown>[];
    try {
      const text = await apiReadTextFile(path);
      entities = path.toLowerCase().endsWith(".json") ? parseJsonRows(text) : parseCsv(text);
    } catch (e) {
      return fail(e);
    }
    if (entities.length === 0) return pushErrorToast(t("remote.tableImportEmpty"));
    const missing = entities.findIndex(
      (row) => !String(row.PartitionKey ?? "") || !String(row.RowKey ?? ""),
    );
    if (missing >= 0) {
      return pushErrorToast(t("remote.tableImportNeedsKeys", { row: String(missing + 1) }));
    }
    if (
      !(await confirmAction(
        t("remote.tableImportConfirm", { n: String(entities.length), name: table }),
        false,
        t("remote.tableImport"),
      ))
    )
      return;

    stopped.current = false;
    setWorking({ done: 0, total: entities.length, label: t("remote.tableImporting") });
    let failed = 0;
    let written = 0;
    for (const [at, entity] of entities.entries()) {
      if (stopped.current) break;
      try {
        await remoteTableUpsert(hostId, table, entity);
        written += 1;
      } catch (e) {
        failed += 1;
        if (failed === 1) fail(e);
      }
      setWorking({ done: at + 1, total: entities.length, label: t("remote.tableImporting") });
    }
    setWorking(null);
    useToastStore
      .getState()
      .pushToast(t("remote.tableImported", { n: String(written) }), failed > 0 ? "error" : "success");
    if (selectedRef.current === table) void run(table, filter);
  };

  /** Which of the three shapes this filter is, so the cost is stated rather than discovered. */
  const shape = (() => {
    const text = filter.toLowerCase();
    const hasPartition = text.includes("partitionkey");
    const hasRow = text.includes("rowkey");
    if (hasPartition && hasRow) return t("remote.tableFilterPoint");
    if (hasPartition) return t("remote.tableFilterPartition");
    return t("remote.tableFilterScan");
  })();

  const visibleTables = useMemo(() => {
    const needle = tableSearch.trim().toLowerCase();
    return needle ? tables.filter((one) => one.name.toLowerCase().includes(needle)) : tables;
  }, [tables, tableSearch]);

  const rowMenu = (entity: Record<string, unknown>): MenuItem[] => {
    const targets =
      pickedKeys.has(identify(entity)) && pickedRows.length > 1 ? pickedRows : [entity];
    return [
      {
        label: t("remote.entityEdit"),
        icon: Pencil,
        onClick: () => setEditing({ entity }),
        disabled: targets.length > 1,
      },
      {
        label: t("remote.entityCopyKeys"),
        icon: Copy,
        onClick: () =>
          void navigator.clipboard.writeText(
            targets.map((one) => `${keyOf(one).partition}\t${keyOf(one).rowKey}`).join("\n"),
          ),
      },
      {
        label:
          targets.length > 1
            ? t("remote.tableDeleteEntities", { n: String(targets.length) })
            : t("remote.tableDeleteEntity"),
        icon: Trash2,
        danger: true,
        separated: true,
        disabled: !!working,
        onClick: () => void removeEntities(targets),
      },
    ];
  };

  return (
    <div className={`flex h-full min-h-0 ${CARD}`}>
      {/* The tables, as a rail. A search box above them because an account with sixty tables is
          ordinary and scrolling for one by eye is not a way to find it. */}
      <div className="flex w-56 shrink-0 flex-col border-r border-[var(--cf-border)]">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
          <span className="mr-auto truncate text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("remote.tables")}
            {tables.length > 0 && (
              <span className="ml-1 tabular-nums opacity-60">{tables.length}</span>
            )}
          </span>
          <ToolbarButton icon={Plus} label={t("remote.tableNew")} onClick={() => void createTable()} />
          <ToolbarButton
            icon={RefreshCw}
            label={t("remote.refresh")}
            onClick={() => void loadTables()}
          />
        </div>
        <div className="shrink-0 border-b border-[var(--cf-border)] px-2 py-1">
          <div className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-1.5">
            <Search size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
            <input
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              placeholder={t("remote.tableSearch")}
              className="min-w-0 flex-1 bg-transparent py-1 text-[11px] outline-none"
            />
            {tableSearch && (
              <button
                type="button"
                onClick={() => setTableSearch("")}
                aria-label={t("common.clear")}
                className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={11} />
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {loading ? (
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
              <Loader2 size={11} className="animate-spin" />
              {t("remote.loading")}
            </p>
          ) : tables.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
              {t("remote.tablesEmpty")}
            </p>
          ) : visibleTables.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
              {t("remote.tableSearchEmpty")}
            </p>
          ) : (
            visibleTables.map((one) => (
              <button
                key={one.name}
                onClick={() => setSelected(one.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTableMenu({ x: e.clientX, y: e.clientY, name: one.name });
                }}
                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] ${
                  one.name === selected
                    ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
              >
                <Table2 size={12} className="shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{one.name}</span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The toolbar, over the header rather than beside every row — which is where Storage
            Explorer puts it, and where an action that applies to a *selection* belongs. A delete
            button on each row can only ever mean that row, and pressing it forty times is not what
            deleting forty entities should be. */}
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--cf-border)] px-1.5 py-1">
          <ToolbarButton
            icon={Filter}
            label={t("remote.tableQuery")}
            onClick={() => setShowFilter((on) => !on)}
            active={showFilter || filter.length > 0}
            disabled={!selected}
          />
          <span aria-hidden className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
          <ToolbarButton
            icon={Plus}
            label={t("remote.entityAdd")}
            onClick={() => setEditing({ entity: null })}
            disabled={!selected}
          />
          <ToolbarButton
            icon={Pencil}
            label={t("remote.entityEdit")}
            onClick={() => one && setEditing({ entity: one })}
            disabled={!one}
          />
          <ToolbarButton
            icon={Trash2}
            label={
              pickedRows.length > 1
                ? t("remote.tableDeleteEntities", { n: String(pickedRows.length) })
                : t("remote.tableDeleteEntity")
            }
            onClick={() => void removeEntities(pickedRows)}
            // Also while a long job is running: both loops write the same progress bar and read the
            // same stop flag, so two at once means one bar counting two things and a Stop that ends
            // whichever notices first.
            disabled={pickedRows.length === 0 || !!working}
          />
          <span aria-hidden className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
          <ToolbarButton
            icon={SquareCheck}
            label={allPicked ? t("remote.selectNone") : t("remote.selectAll")}
            onClick={() =>
              setPickedKeys(allPicked ? new Set() : keysOf(range(0, view.length - 1)))
            }
            disabled={view.length === 0}
          />
          <ToolbarButton
            icon={Columns3}
            label={t("remote.tableColumns")}
            onClick={() => setCustomizing(true)}
            disabled={!selected}
            active={settings.hidden.size > 0 || settings.extra.length > 0}
          />
          <span aria-hidden className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
          <ToolbarButton
            icon={Upload}
            label={t("remote.tableImport")}
            onClick={() => void importRows()}
            disabled={!selected || !!working}
          />
          <ToolbarButton
            icon={Download}
            label={t("remote.tableExport")}
            onClick={() => void exportRows()}
            disabled={view.length === 0}
          />
          <ToolbarButton
            icon={Sigma}
            label={t("remote.tableStats")}
            onClick={() => void tableStats()}
            disabled={!selected || !!working}
          />
          <ToolbarButton
            icon={RefreshCw}
            label={t("remote.refresh")}
            onClick={() => void run(selected, filter)}
            // Also while a long job is running: re-querying mid-count bumps the request token, and
            // the count would carry on scanning with nothing left on screen to say so.
            disabled={!selected || busy || !!working}
          />
          {busy && <Loader2 size={12} className="ml-1 animate-spin text-[var(--cf-text-muted)]" />}
          <span className="ml-auto min-w-0 truncate pl-2 text-[11px] text-[var(--cf-text-muted)]">
            {selected}
          </span>
        </div>

        {showFilter && (
          <div className="shrink-0 border-b border-[var(--cf-border)] px-2 py-1.5">
            <div className="flex items-center gap-1">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void run(selected, filter);
                }}
                placeholder="PartitionKey eq 'eu' and RowKey eq '42'"
                disabled={!selected}
                autoFocus
                className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)] disabled:opacity-40"
              />
              <button
                type="button"
                onClick={() => void run(selected, filter)}
                disabled={!selected || busy}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
              >
                {t("remote.tableRun")}
              </button>
            </div>
            {selected && <p className="pt-1 text-[10px] text-[var(--cf-text-muted)]">{shape}</p>}
          </div>
        )}

        {/* One line for a long-running loop — an import of 900 rows, a count over a whole table.
            Determinate where a total is known and a running tally where it is not, because "how many
            so far" is the only honest answer to a scan whose length nobody knows in advance. */}
        {working && (
          <div className="shrink-0 border-b border-[var(--cf-border)] px-3 py-1.5">
            <div className="flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
              <Loader2 size={11} className="shrink-0 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{working.label}</span>
              <span className="shrink-0 tabular-nums">
                {working.total > 0 ? `${working.done} / ${working.total}` : working.done}
              </span>
              <button
                type="button"
                onClick={() => {
                  stopped.current = true;
                }}
                title={t("remote.tableStop")}
                aria-label={t("remote.tableStop")}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
              >
                <X size={12} />
              </button>
            </div>
            <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
              <div
                className={`h-full rounded-full bg-[var(--cf-accent)] ${
                  working.total > 0 ? "transition-[width] duration-150" : "animate-pulse"
                }`}
                style={{
                  width: working.total > 0 ? `${(working.done / working.total) * 100}%` : "100%",
                }}
              />
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {!selected ? (
            <EmptyState
              icon={Database}
              title={t("remote.tablePickOne")}
              subtitle={t("remote.tablePickOneHint")}
            />
          ) : busy && page?.table !== selected ? (
            <EmptyState icon={Database} title={t("remote.loading")} subtitle={selected} />
          ) : view.length === 0 ? (
            <EmptyState
              icon={Database}
              title={t("remote.tableNoRows")}
              subtitle={t("remote.tableNoRowsHint")}
            />
          ) : (
            <EntityGrid
              resetKey={`${selected}/${queryEpoch}`}
              columns={columns}
              rows={view}
              widths={settings.widths}
              onWidth={(column, width) =>
                updatePrefs(selected, { widths: { ...settings.widths, [column]: width } })
              }
              onAutoFit={(column) =>
                updatePrefs(selected, {
                  widths: { ...settings.widths, [column]: autoFitWidth(column, rows) },
                })
              }
              sort={sort}
              onSort={(column) =>
                setSort((current) =>
                  // asc → desc → the service's own order, which is the state the user asked to be
                  // able to get back to.
                  current?.column !== column
                    ? { column, descending: false }
                    : current.descending
                      ? null
                      : { column, descending: true },
                )
              }
              selected={picked}
              onSelectRow={selectRow}
              onSelectRange={selectRange}
              onSelectAll={(on) =>
                setPickedKeys(on ? keysOf(range(0, view.length - 1)) : new Set())
              }
              onOpenRow={(row) => view[row] && setEditing({ entity: view[row] })}
              onRowContextMenu={(row, event) => {
                const entity = view[row];
                if (!entity) return;
                if (!picked.has(row)) selectRow(row, { range: false, toggle: false });
                setMenu({ x: event.clientX, y: event.clientY, entity });
              }}
            />
          )}
        </div>

        {/* What is on screen, said plainly: a sort and a "load more" both act on the rows loaded so
            far, and neither says anything about the table. */}
        {selected && (
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-1 text-[11px] text-[var(--cf-text-muted)]">
            <span className="tabular-nums">
              {t("remote.tableLoadedN", { n: String(rows.length) })}
            </span>
            {pickedRows.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums text-[var(--cf-accent)]">
                  {t("remote.tableSelectedN", { n: String(pickedRows.length) })}
                </span>
              </>
            )}
            {stats?.table === selected && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums" title={t("remote.tableStatsHint")}>
                  {t(stats.partial ? "remote.tableStatsPartial" : "remote.tableStatsLine", {
                    n: String(stats.count),
                    p: String(stats.partitions),
                  })}
                </span>
              </>
            )}
            {/* The partition token is the continuation; the row key only comes with it when the
                next page resumes inside a partition. Requiring both hid this button — and with it
                the rest of the table — whenever a page ended on a boundary. */}
            {page?.table === selected && page.data.next_partition_key && (
              <button
                type="button"
                onClick={() => void run(selected, filter, page.data)}
                disabled={busy}
                className="ml-auto rounded px-1 text-[var(--cf-accent)] underline-offset-2 hover:underline disabled:opacity-40"
              >
                {t("remote.tableMore")}
              </button>
            )}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={rowMenu(menu.entity)}
          onClose={() => setMenu(null)}
        />
      )}
      {tableMenu && (
        <ContextMenu
          x={tableMenu.x}
          y={tableMenu.y}
          heading={tableMenu.name}
          items={[
            {
              label: t("remote.refresh"),
              icon: RefreshCw,
              onClick: () => {
                // Re-running the table you are already on has to re-run the *filter* you are still
                // looking at. Dropping it would fill the grid with every row while the box above
                // still claimed a subset — the grid asserting something that isn't true.
                if (tableMenu.name === selected) void run(tableMenu.name, filter);
                else setSelected(tableMenu.name);
              },
            },
            {
              label: t("common.delete"),
              icon: Trash2,
              danger: true,
              separated: true,
              onClick: () => void deleteTable(tableMenu.name),
            },
          ]}
          onClose={() => setTableMenu(null)}
        />
      )}
      {editing && selected && (
        <EntityEditorModal
          hostId={hostId}
          table={selected}
          entity={editing.entity}
          columns={allColumns}
          onClose={() => setEditing(null)}
          onSaved={() => void run(selected, filter)}
        />
      )}
      {customizing && selected && (
        <TableColumnsModal
          columns={allColumns}
          hidden={settings.hidden}
          onApply={(order, hidden) =>
            updatePrefs(selected, {
              order,
              hidden,
              // Anything ordered that the data has never produced is a column the user pinned by
              // hand, and it has to outlive the next query that doesn't mention it.
              extra: order ? order.filter((column) => !known.includes(column)) : [],
            })
          }
          onClose={() => setCustomizing(false)}
        />
      )}
    </div>
  );
}

/** `[from..to]`, inclusive. Written out because a selection's ends are both real rows. */
function range(from: number, to: number): number[] {
  if (to < from) return [];
  return Array.from({ length: to - from + 1 }, (_, at) => from + at);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180: quote anything containing a comma, a quote or a newline, and double the quotes. */
function csvCell(value: string | null): string {
  if (value === null) return "";
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map((column) => csvCell(column)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(cellText(row, column))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * An array of objects, or one object. Anything else is not a set of entities.
 *
 * The service's own document-level annotations (`odata.metadata`, `odata.etag`) are dropped — an
 * export written by this panel carries them, and sending an entity's old etag back as if it were a
 * property is rejected. The `Name@odata.type` form is *kept*, because that is what makes an exported
 * Int64 come back an Int64 rather than a string of digits.
 */
function parseJsonRows(text: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed)
    ? parsed.filter((row) => row && typeof row === "object")
    : parsed && typeof parsed === "object"
      ? [parsed as Record<string, unknown>]
      : [];
  return rows.map((row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !key.startsWith("odata.") && key !== "Timestamp"),
    ),
  );
}

/**
 * A CSV into entities, header row first.
 *
 * Written out rather than split on commas because a `RowKey` holding a path — which is most of them
 * on the tables people actually keep — contains commas, and a naive split turns one entity into
 * three columns of nonsense. Values stay strings: the service infers the type, and guessing that
 * `007` is the number seven is how a key stops matching.
 */
function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (quoted) {
      if (character === '"') {
        if (text[at + 1] === '"') {
          cell += '"';
          at += 1;
        } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      // A `\r\n` is one break, not two.
      if (character === "\r" && text[at + 1] === "\n") at += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((one) => one.some((value) => value !== ""));
  if (!header) return [];
  return body.map((values) => {
    const entity: Record<string, unknown> = {};
    header.forEach((column, index) => {
      const name = column.trim();
      // `Timestamp` is the service's and rejected on write; an export round-tripping through this
      // would otherwise fail on every row.
      if (!name || name === "Timestamp" || name.includes("@odata.")) return;
      const value = values[index] ?? "";
      if (value !== "") entity[name] = value;
    });
    return entity;
  });
}
