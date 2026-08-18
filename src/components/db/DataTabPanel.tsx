import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Braces,
  Columns3,
  Copy,
  CopyPlus,
  Download,
  Loader2,
  Pencil,
  Plus,
  List,
  RotateCcw,
  Rows3,
  SlidersHorizontal,
  Table as TableIcon,
  RefreshCw,
  Save,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../api/CollectionTree";
import { recordModel } from "../../lib/db/engineModel";
import { documentWithoutId } from "../../lib/db/mongoDocument";
import { DocumentList, type DocumentActions, type DocumentState } from "./DocumentList";
import { QueryOptionsPanel } from "./QueryOptionsPanel";
import { RecordGrid } from "./RecordGrid";
import { ResultGrid, type GridRowAction } from "./ResultGrid";
import { cellMenuItems } from "./cellMenu";
import { nodeLabel } from "./SqlConsolePanel";
import { EngineBadge, ToolbarButton, ToolbarSeparator, formatCount, formatDuration } from "./dbChrome";
import {
  buildEdits,
  displayCell,
  displayDocument,
  hasPrimaryKey,
  pendingCount,
  useDbStore,
  type DbDataTab,
} from "../../state/dbStore";
import { useDbModalStore } from "../../state/dbModalStore";
import { useDbCommandStore } from "../../state/dbCommandStore";
import { useToastStore } from "../../state/toastStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { EXPORT_EXTENSIONS, formatResult, type ExportFormat } from "../../lib/db/resultExport";
import {
  EMPTY_QUERY_OPTIONS,
  engineInfo,
  hasQueryOptions,
  type DbForeignKey,
  type DbKind,
  type DbQueryOptions,
} from "../../types/database";

const PAGE_SIZES = [50, 100, 200, 500, 1000];

/**
 * What the floating menu is showing.
 *
 * `export` carries the rows it is about — an empty list meaning the whole page — so the format the
 * user then picks can't apply to a different set than the item they opened it from named.
 */
type PanelMenu =
  | { x: number; y: number; kind: "row"; row: number }
  /** A right-click that landed on a value. Carries the column as well as the row, because the four
   *  clipboard entries are about one cell while everything under them is about the record. */
  | { x: number; y: number; kind: "cell"; row: number; column: string }
  | { x: number; y: number; kind: "export"; rows: number[] }
  | { x: number; y: number; kind: "pageSize" };

/**
 * One relation's rows, editable.
 *
 * The editing model is the whole design: **nothing is written until Apply.** Typing stages a change,
 * the changed cell is tinted, the pending count sits on the Apply button, and Apply sends the batch —
 * showing every statement it generated first. A grid that saved on blur would make an accidental
 * keystroke on a production table indistinguishable from an intentional edit.
 *
 * A selection is the second half of that model: the row numbers down the left select rows the way a
 * file list does, and what the selection is *for* — export these, stage these for deletion, read
 * these one field per line — is what the bar above the grid offers. Deleting a selection stages it
 * like every other edit; the Delete key does the same, and Apply is still what writes.
 *
 * The other thing worth knowing: **a table without a primary key is edited by matching every column
 * of the row.** That works, and it can match more than one row when the table holds exact
 * duplicates, so the panel says so before applying rather than after.
 */
export function DataTabPanel({ tab }: { tab: DbDataTab }) {
  const t = useT();
  const connection = useDbStore((s) => s.connections.find((c) => c.id === tab.connectionId));
  const openModal = useDbModalStore((s) => s.openDbModal);
  const store = useDbStore.getState();
  const [menu, setMenu] = useState<PanelMenu | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  /**
   * Which rows the gutter has selected, by index into the page.
   *
   * Here rather than in the store because it is about *this* look at the data: it indexes the page
   * on screen, so it cannot survive a reload, a sort or a page turn — and a persisted tab that
   * reopened with rows 3, 4 and 9 "selected" would be pointing at rows nobody chose.
   */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /**
   * Grid or record: rows across, or one record per column read down the page.
   *
   * A view state, so it lives here and not in the store — it is about this look at the data, like
   * the selection, and a persisted tab that reopened sideways would be surprising.
   */
  const [layout, setLayout] = useState<"grid" | "record">("grid");
  /**
   * Which of the three Mongo views is up: the document list, the raw text, or the grid.
   *
   * Only meaningful on an engine that returns documents, and it opens on `documents` there — a
   * collection is read as documents, and the grid's flattening invents a schema the collection does
   * not have (see `DocumentList`). On a relational engine this stays `grid` and the switcher is not
   * drawn at all, because "documents" is not a way of looking at a row.
   */
  const [docView, setDocView] = useState<"documents" | "json" | "grid">("documents");
  /**
   * Whether the query options are expanded.
   *
   * A view state like the two above, and closed by default: seven boxes above the pager is a lot of
   * screen to spend on a query that is usually just a filter. It opens itself for a tab that has
   * options set, so a restored or a re-pointed tab never filters by something invisible.
   */
  const [optionsOpen, setOptionsOpen] = useState(false);
  /** Where a ⇧-click measures its run from. */
  const anchor = useRef<number | null>(null);
  /** What a ⌘-drag must not throw away: the selection as it stood when the drag began. */
  const kept = useRef<Set<number>>(new Set());

  const engine = connection ? engineInfo(connection.kind) : null;
  /**
   * Whether a record here *is* a document — which is what the editing actions ask.
   *
   * Asked of the engine and not of the result, unlike `hasDocuments` below. An empty collection
   * returns no documents and is still a collection, and the one thing you want to do with an empty
   * collection is put the first document in it.
   */
  const documentStore = engine ? !engine.sql : false;
  /** Whether the query's own sort is what these documents came back in — see the grid below. */
  const sortedByOptions = tab.options.sort.trim() !== "";
  /**
   * Whether the documents on screen are whole ones.
   *
   * A projection returns *part* of a document, and the two actions that write a document write it
   * whole — a replacement built from a projected document would delete every field the projection
   * left out, and a clone of one would be a copy missing them. So both are off while a projection
   * is set, and the panel says so.
   *
   * A cell edit is unaffected and stays: it is a `$set` on the field it names, and knows nothing
   * about the fields it doesn't.
   */
  const wholeDocuments = !documentStore || tab.options.projection.trim() === "";
  /**
   * Whether a document on this page can be pointed at again.
   *
   * Mongo keys an edit on `_id`. A projection that dropped it leaves the editor matching on every
   * field that *did* come back, which can match a document nobody chose — which is precisely what
   * the panel's existing "no primary key" warning is about, so it is folded into that rather than
   * given a second warning of its own.
   */
  const identifiedDocuments =
    !documentStore ||
    (tab.result?.columns.length ?? 0) === 0 ||
    (tab.result?.columns.some((column) => column.name === "_id") ?? false);
  const staged = pendingCount(tab);
  const identified = hasPrimaryKey(tab) && identifiedDocuments;

  // A restored tab has no rows yet — reopening the app deliberately doesn't fire a query per tab —
  // so the first look at one is what loads it.
  useEffect(() => {
    if (!tab.result && !tab.loading && !tab.error) void store.loadData(tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // A tab that arrived with options set shows them. Only ever opens the panel — closing it again is
  // the user's to do, and re-opening it under them on the next render would be a fight.
  useEffect(() => {
    if (hasQueryOptions(tab.options)) setOptionsOpen(true);
  }, [tab.id, tab.options]);

  // New rows, new indexes. See the note on `selected`.
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
    kept.current = new Set();
  }, [tab.result]);

  /** Whose rules the grids read these fields by. A connection deleted out from under an open tab
   *  leaves its rows on screen, and they are better read as an ordinary relational result — the
   *  same fallback `recordModel` makes for a kind it doesn't know — than not read at all. */
  const engineKind: DbKind = connection?.kind ?? "postgres";
  /** Rows or documents, in this engine's own noun — see `EngineRecordModel.counts`. */
  const counts = recordModel(engineKind).counts;

  const primaryKeys = useMemo(
    () =>
      new Set(
        tab.columns.filter((column) => column.column?.primary_key).map((column) => column.name),
      ),
    [tab.columns],
  );

  /** By column, since that is how the grid asks — "the cell I'm on, where does it lead?". A column
   * in two foreign keys keeps the first, which is the one the catalog listed first. */
  const foreignKeys = useMemo(() => {
    const byColumn = new Map<string, DbForeignKey>();
    for (const key of tab.foreignKeys) {
      if (!byColumn.has(key.column)) byColumn.set(key.column, key);
    }
    return byColumn;
  }, [tab.foreignKeys]);

  /**
   * The cells the grid tints as changed.
   *
   * A document rewritten as a whole tints its entire row, because that is what is staged: the write
   * replaces every field, and marking one cell would understate it. The values on screen are still
   * the server's — a staged document is text, and re-deriving cells from it would mean parsing the
   * shell dialect in the webview, which this workspace deliberately never does (see
   * `lib/db/mongoDocument`). The tint says "this row has a rewrite staged"; the row's Edit button
   * opens the rewrite, and the document views draw it.
   */
  const changed = useMemo(() => {
    const cells = new Set(Object.keys(tab.pending));
    for (const row of Object.keys(tab.replaced)) {
      for (const column of tab.result?.columns ?? []) cells.add(`${row}:${column.name}`);
    }
    return cells;
  }, [tab.pending, tab.replaced, tab.result]);
  const deleted = useMemo(() => new Set(tab.deleted), [tab.deleted]);

  // --------------------------------------------------------------- documents
  //
  // What the two document views draw: the server's page with any staged rewrite standing in for the
  // document it replaces, and the staged new documents after it. One list rather than two, so a
  // card's index is the only thing an action needs — the ones past the server's count are the new
  // ones, which is also exactly how the grid tells its inserted rows apart.

  /** How many of the documents on screen came from the server. */
  const documentCount = tab.result?.documents.length ?? 0;

  const documents = useMemo(
    () => [
      ...Array.from({ length: documentCount }, (_, index) => displayDocument(tab, index)),
      ...tab.insertedDocs,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.result, tab.replaced, tab.insertedDocs],
  );

  /** Whether there is anything for the document views to draw. Staged documents count: on an empty
   *  collection they are the only thing there is to look at, and the grid cannot draw one. */
  const hasDocuments = documentStore && documents.length > 0;

  /** Which rows have anything staged against them, by index. Collected once rather than searched
   *  per card: a page of five hundred documents against a table of twenty columns would otherwise
   *  walk ten thousand keys per card, five hundred times, on every render. */
  const editedRows = useMemo(() => {
    const rows = new Set(Object.keys(tab.replaced).map(Number));
    for (const key of Object.keys(tab.pending)) rows.add(Number(key.split(":")[0]));
    return rows;
  }, [tab.pending, tab.replaced]);

  /** What Apply would do to the document on this card — what tints it. A row whose *cells* were
   *  edited in the grid counts as edited here too: it is the same staged write seen from the other
   *  view, and a card that looked untouched would be lying about what Apply is about to send. */
  const documentState = (index: number): DocumentState => {
    if (index >= documentCount) return "new";
    if (deleted.has(index)) return "deleted";
    return editedRows.has(index) ? "edited" : "clean";
  };

  /** Opens a document in the editor. Staging, not saving — see `DocumentEditorModal`. */
  const editDocument = (index: number) => {
    const isNew = index >= documentCount;
    openModal({
      kind: "document",
      title: isNew
        ? t("db.newDocumentIn", { name: nodeLabel(tab.node) })
        : t("db.documentNumberIn", {
            n: String(tab.offset + index + 1),
            name: nodeLabel(tab.node),
          }),
      text: documents[index] ?? "",
      mode: "edit",
      onSave: (text) =>
        isNew
          ? store.setInsertedDocument(tab.id, index - documentCount, text)
          : store.setDocument(tab.id, index, text),
    });
  };

  /**
   * Stages a new document and makes sure it can be seen.
   *
   * The grid draws the server's rows and the rows staged in *its* shape; a document staged as text
   * has no cells until it is written, and turning it into some would mean parsing the shell dialect
   * here, which this workspace never does. So the view that can draw it comes forward. Staging
   * something the user then cannot find is the worse of the two surprises.
   */
  const stageDocument = (text: string) => {
    store.addDocument(tab.id, text);
    setDocView((current) => (current === "grid" ? "documents" : current));
  };

  /** Opens a copy of the document, ready to be inserted as a new one. The `_id` is dropped so the
   *  server assigns a fresh one — see `documentWithoutId`. */
  const cloneDocument = (index: number) => {
    openModal({
      kind: "document",
      title: t("db.cloneOf", { name: nodeLabel(tab.node) }),
      text: documentWithoutId(documents[index] ?? ""),
      mode: "clone",
      onSave: stageDocument,
    });
  };

  /** Stages a deletion, or takes one back. A staged *new* document has nothing to delete on the
   *  server, so its button drops the card instead. */
  const deleteDocument = (index: number) => {
    if (index >= documentCount) store.removeInsertedDocument(tab.id, index - documentCount);
    else store.toggleDeleteRow(tab.id, index);
  };

  /** A blank document, opened in the editor. What `+` means on a collection: a schemaless store has
   *  no column list to make a row of nulls from, so "add" is "write one". */
  const addDocument = () => {
    openModal({
      kind: "document",
      title: t("db.newDocumentIn", { name: nodeLabel(tab.node) }),
      text: "{\n  \n}",
      mode: "clone",
      onSave: stageDocument,
    });
  };

  /** What a card offers besides Copy, which it always offers. The two that write a whole document
   *  drop out under a projection — see `wholeDocuments`. */
  const documentActions: DocumentActions = {
    onEdit: wholeDocuments ? editDocument : undefined,
    onClone: wholeDocuments ? cloneDocument : undefined,
    onDelete: deleteDocument,
  };

  /** The same actions, pinned to the right of a grid row. The grid only ever shows the server's
   *  documents, so an index here is an index into the page. Copy is always there; the ones that
   *  write are there when the documents are whole ones. */
  const rowActions = (row: number): GridRowAction[] => {
    const actions: GridRowAction[] = [];
    if (wholeDocuments) {
      actions.push({
        id: "edit",
        icon: Pencil,
        label: t("db.editDocument"),
        onClick: () => editDocument(row),
        disabled: deleted.has(row),
      });
    }
    actions.push({
      id: "copy",
      icon: Copy,
      label: t("db.copyDocument"),
      onClick: () => void navigator.clipboard.writeText(documents[row] ?? ""),
    });
    if (wholeDocuments) {
      actions.push({
        id: "clone",
        icon: CopyPlus,
        label: t("db.cloneDocument"),
        onClick: () => cloneDocument(row),
      });
    }
    // Deleting is not affected by a projection: it says which document to remove, not what is in
    // it. The row gutter and the row menu offer it either way, and a button that came and went
    // between the three views would be the odd one out.
    actions.push({
      id: "delete",
      icon: deleted.has(row) ? RotateCcw : Trash2,
      label: deleted.has(row) ? t("db.undoDelete") : t("db.deleteDocument"),
      onClick: () => deleteDocument(row),
      danger: !deleted.has(row),
    });
    return actions;
  };

  /** Runs the query as it now stands: the filter and the options are one question, so they are
   *  applied together and always land on page one — the documents a new query brings to the top are
   *  the reason it was asked for. */
  const applyQuery = () => {
    store.updateData(tab.id, {
      filter: tab.filterDraft,
      options: tab.optionsDraft,
      offset: 0,
    });
    void store.loadData(tab.id);
  };

  const resetQuery = () => {
    store.updateData(tab.id, {
      filter: "",
      filterDraft: "",
      options: EMPTY_QUERY_OPTIONS,
      optionsDraft: EMPTY_QUERY_OPTIONS,
      offset: 0,
    });
    void store.loadData(tab.id);
  };

  /** The selection in page order, which is the order everything downstream should see it in. */
  const selectedRows = useMemo(
    () => [...selected].sort((a, b) => a - b),
    [selected],
  );

  /**
   * A click on a row number.
   *
   * Plain click picks one, ⇧ extends from the anchor, ⌘/Ctrl adds or removes one — and clicking the
   * only selected row clears it, so there is a way back to "nothing selected" that isn't hunting for
   * the header box.
   */
  const selectRow = (row: number, mods: { range: boolean; toggle: boolean }) => {
    // Always the first thing a press does, so a sweep that follows starts from what is on screen
    // now rather than from what the previous sweep happened to leave behind.
    kept.current = new Set();
    setSelected((current) => {
      if (mods.range && anchor.current !== null) {
        const [from, to] = [anchor.current, row].sort((a, b) => a - b);
        const next = new Set(mods.toggle ? current : []);
        for (let index = from; index <= to; index += 1) next.add(index);
        return next;
      }
      anchor.current = row;
      if (mods.toggle) {
        const next = new Set(current);
        if (!next.delete(row)) next.add(row);
        return next;
      }
      if (current.size === 1 && current.has(row)) return new Set();
      return new Set([row]);
    });
  };

  /**
   * A run swept out by dragging down the row numbers.
   *
   * Recomputed from the anchor every time rather than accumulated, so dragging back up *shrinks*
   * the run — which is what a drag means everywhere else and what accumulating would get wrong.
   * `additive` (the drag began with ⌘/Ctrl) keeps whatever was selected before it started.
   */
  const selectRange = (from: number, to: number, additive: boolean) => {
    const [start, end] = from <= to ? [from, to] : [to, from];
    setSelected((current) => {
      if (!additive) kept.current = new Set();
      else if (kept.current.size === 0) kept.current = new Set(current);
      const next = new Set(kept.current);
      for (let index = start; index <= end; index += 1) next.add(index);
      return next;
    });
  };

  const selectAll = (on: boolean) => {
    anchor.current = null;
    kept.current = new Set();
    setSelected(on ? new Set((tab.result?.rows ?? []).map((_, index) => index)) : new Set());
  };

  /**
   * A click on a column header: ascending → descending → unsorted, then round again.
   *
   * The third state is the one grids usually leave out, and it is the one you want most often — a
   * sort you added to look at something once otherwise has to be undone by sorting by something
   * else. ⇧ (or ⌘/Ctrl) adds the column to the sort instead of replacing it, so "newest first,
   * then by name" is two clicks; the same cycle then applies to that column alone, and its third
   * click drops it out of the sort and leaves the rest.
   */
  const cycleSort = (column: string, additive: boolean) => {
    const current = tab.sort;
    const index = current.findIndex((key) => key.column === column);
    let next: typeof current;
    if (index < 0) {
      next = additive ? [...current, { column, descending: false }] : [{ column, descending: false }];
    } else if (!current[index].descending) {
      const flipped = { column, descending: true };
      next = additive ? current.map((key, i) => (i === index ? flipped : key)) : [flipped];
    } else {
      next = additive ? current.filter((_, i) => i !== index) : [];
    }
    // Back to page one: the rows a sort brings to the top are the reason it was asked for, and
    // staying on page nine of the old order would hide them.
    store.updateData(tab.id, { sort: next, offset: 0 });
    void store.loadData(tab.id);
  };

  /** Stages the selection for deletion — nothing is written until Apply, as everywhere else here. */
  const deleteSelected = () => {
    if (selectedRows.length === 0) return;
    store.setDeletedRows(tab.id, selectedRows, true);
  };

  /** One field per line, for rows too wide to read across. Falls back to the whole page. */
  const openRecords = (rows: number[]) => {
    if (!tab.result) return;
    const indexes = rows.length > 0 ? rows : tab.result.rows.map((_, index) => index);
    if (indexes.length === 0) return;
    openModal({
      kind: "records",
      title: nodeLabel(tab.node),
      engine: engineKind,
      columns: tab.result.columns,
      // This tab knows its table, so the modal gets what the catalog says as well as what the
      // engine says — which is what lets it mark the key and name the references the console's
      // own record view has no way to resolve.
      primaryKeys,
      foreignKeys,
      // The row's own number travels with it: a record read on its own is worth nothing if you
      // can't find the row it came from back in the grid.
      records: indexes.map((index) => ({
        index,
        values: tab.result?.rows[index] ?? [],
      })),
    });
  };

  /** Saves rows in a format. `rows` empty means the page. */
  const exportRows = async (format: ExportFormat, rows: number[]) => {
    if (!tab.result) return;
    const picked =
      rows.length > 0 ? rows.map((index) => tab.result?.rows[index] ?? []) : tab.result.rows;
    // Mongo's own documents are picked the same way: exporting three selected documents as JSON
    // has to keep their nesting, which the column/value flattening would throw away.
    const documents =
      rows.length > 0
        ? rows.map((index) => tab.result?.documents[index]).filter((doc): doc is string => doc !== undefined)
        : tab.result.documents;
    const contents = formatResult(
      { ...tab.result, rows: picked, documents },
      format,
      nodeLabel(tab.node),
    );
    const saved = await apiSaveFile(
      `${tab.node.name ?? "rows"}.${EXPORT_EXTENSIONS[format]}`,
      contents,
    ).catch(() => null);
    if (saved) useToastStore.getState().pushToast(t("db.exported", { path: saved }), "success");
  };

  // ⌫/Del stages the selection for deletion, the way it does in a file list — but only when the
  // grid is what the keystroke was meant for: a cell editor, the WHERE box and any other input own
  // their own backspace.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selected.size === 0) return;
      // A modal has the user's attention; a keystroke aimed at it must not reach the grid behind.
      if (useDbModalStore.getState().modal !== null) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      e.preventDefault();
      store.setDeletedRows(tab.id, [...selected].sort((a, b) => a - b), true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, store, tab.id]);

  /** Reloading throws staged edits away (row indexes shift), so it asks first when there are any. */
  const reload = async () => {
    if (staged > 0 && !(await confirmAction(t("db.discardEditsConfirm", { n: String(staged) })))) {
      return;
    }
    void store.loadData(tab.id);
  };

  const apply = () => {
    const edits = buildEdits(tab);
    if (edits.length === 0) return;
    openModal({
      kind: "preview",
      title: t("db.applyTitle", { n: String(staged) }),
      // What will run, before it runs. The backend returns the same list afterwards, so the two are
      // checkable against each other.
      statements: edits.map((edit) =>
        describeEdit(edit.kind, edit.values.length, edit.keys.length, edit.document !== undefined),
      ),
      onConfirm: () => void store.applyEdits(tab.id),
    });
  };

  // The keyboard routes to the three things this panel's toolbar and pager do. Every request is
  // consumed, handled or not: leaving one pending would replay it the moment another tab mounts.
  const request = useDbCommandStore((s) => s.request);
  useEffect(() => {
    if (!request) return;
    useDbCommandStore.getState().consume();
    if (request.command === "refresh") void reload();
    else if (request.command === "apply") apply();
    else if (request.command === "filter") {
      filterRef.current?.focus();
      filterRef.current?.select();
    }
    // `reload` and `apply` close over the tab, and re-running on every render would consume the
    // request twice; the nonce is what makes a repeated command a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  const page = Math.floor(tab.offset / tab.limit) + 1;
  const lastPage = tab.total === null ? null : Math.max(1, Math.ceil(tab.total / tab.limit));

  /**
   * The row menu.
   *
   * Right-clicking inside the selection acts on the selection; right-clicking outside it acts on
   * the row under the pointer, which is also what the click did to the selection a moment earlier.
   * Anything else would delete rows the user was not pointing at.
   */
  const rowMenu = (row: number, x: number, y: number): MenuItem[] => {
    const inSelection = selected.has(row);
    const rows = inSelection ? selectedRows : [row];
    const items: MenuItem[] = [];
    // On a collection the menu leads with what a document is edited by — the same actions the cards
    // and the grid's row buttons offer, so right-clicking never turns out to be the poorer route.
    // Only for one document: "edit these six" is not a thing a document editor can mean.
    if (documentStore && rows.length === 1) {
      // The two that write a whole document are absent under a projection, for the reason
      // `wholeDocuments` gives — the menu can't offer what the buttons refuse.
      if (wholeDocuments) {
        items.push({
          label: t("db.editDocument"),
          icon: Pencil,
          onClick: () => editDocument(row),
        });
        items.push({
          label: t("db.cloneDocument"),
          icon: CopyPlus,
          onClick: () => cloneDocument(row),
        });
      }
      items.push({
        label: t("db.copyDocument"),
        icon: Copy,
        onClick: () => void navigator.clipboard.writeText(documents[row] ?? ""),
      });
    }
    if (inSelection && rows.length > 1) {
      items.push({
        label: t("db.deleteSelectedRows", { n: String(rows.length) }),
        icon: Trash2,
        danger: true,
        onClick: () => store.setDeletedRows(tab.id, rows, true),
      });
    } else {
      items.push({
        label: deleted.has(row) ? t("db.undoDelete") : t("db.deleteRow"),
        icon: Trash2,
        danger: !deleted.has(row),
        onClick: () => store.toggleDeleteRow(tab.id, row),
      });
    }
    items.push({
      label: rows.length > 1 ? t("db.viewRecordsN", { n: String(rows.length) }) : t("db.viewRecord"),
      icon: Rows3,
      onClick: () => openRecords(rows),
    });
    items.push({
      label:
        rows.length > 1 ? t("db.exportSelectedN", { n: String(rows.length) }) : t("db.exportRow"),
      icon: Download,
      // Opens the format list where this menu already is: the formats are a second question about
      // the same rows, not a different menu somewhere else on screen.
      onClick: () => setMenu({ x, y, kind: "export", rows }),
    });
    items.push({
      label: rows.length > 1 ? t("db.copyRowsN", { n: String(rows.length) }) : t("db.copyRow"),
      icon: Copy,
      onClick: () => {
        const text = rows
          .map((index) =>
            (tab.result?.rows[index] ?? [])
              .map((value) => (value === null ? "NULL" : value))
              .join("\t"),
          )
          .join("\n");
        void navigator.clipboard.writeText(text);
      },
    });
    return items;
  };

  /**
   * The cell menu: four clipboard entries about one value, then the whole row menu under them.
   *
   * Composed rather than replacing, because a right-click has to keep answering both questions. The
   * row entries — copy the record, duplicate it, delete it, export it — were the only thing here
   * before, and dropping them the moment cells got a menu of their own would be a straight loss on
   * the gesture people already use.
   */
  const cellMenu = (row: number, column: string, x: number, y: number): MenuItem[] => {
    const serverRows = tab.result?.rows.length ?? 0;
    // Past the server's rows is one of the locally appended ones, which are indexed from zero in
    // their own list and staged through a different setter — the same split `ResultGrid.commit`
    // makes, and getting it wrong here would write an edit into an unrelated row.
    const inserted = row >= serverRows;
    const columnIndex = (tab.result?.columns ?? []).findIndex((entry) => entry.name === column);
    const value = inserted
      ? (tab.inserted[row - serverRows]?.[columnIndex] ?? null)
      : displayCell(tab, row, column);

    const items = cellMenuItems(
      {
        value,
        onSet: (next) =>
          inserted
            ? store.setInsertedCell(tab.id, row - serverRows, column, next)
            : store.setCell(tab.id, row, column, next),
      },
      t,
    );

    /**
     * A locally added row gets no row menu, and that is a correctness rule rather than a tidiness
     * one.
     *
     * Every entry `rowMenu` builds is addressed by an index into `tab.result.rows`, which a new row
     * is past the end of. "Delete row" would stage `serverRows + n` into `tab.deleted`, and
     * `buildEdits` resolves its key columns through `cellAt` — `undefined` for a row the server
     * never sent — so the statement that reached the database was `DELETE … WHERE id = NULL`,
     * against a row the user was only *drafting*. Copy and Export were quieter about it and
     * produced an empty record.
     *
     * The one thing that does make sense on a draft is throwing it away, which is the same action
     * as the row's own discard button and takes the local index the same way.
     */
    if (inserted) {
      return [
        ...items,
        {
          label: t("db.discardRow"),
          icon: Trash2,
          danger: true,
          separated: true,
          onClick: () => store.removeInsertedRow(tab.id, row - serverRows),
        },
      ];
    }

    // The hairline that says where "this value" stops and "this record" starts.
    const rows = rowMenu(row, x, y);
    if (rows.length > 0) rows[0] = { ...rows[0], separated: true };
    return [...items, ...rows];
  };

  const exportItems = (rows: number[]): MenuItem[] =>
    (["csv", "tsv", "json", "sql", "markdown"] as ExportFormat[]).map((format) => ({
      label: t("db.exportAs", { format: format.toUpperCase() }),
      icon: Download,
      onClick: () => void exportRows(format, rows),
    }));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        {connection && <EngineBadge kind={connection.kind} label={engine?.label ?? ""} />}
        {/* Which connection these rows came from, in words. The engine badge says *what kind* of
            server it is, which is not the same question — two of the three connections in a
            workspace are usually the same engine, and the one you must not confuse is production
            with staging. The console has always said it; the grid used to leave it to the tab. */}
        <span
          className="max-w-[150px] shrink truncate text-[12px] text-[var(--cf-text-muted)]"
          title={connection?.name ?? t("db.connectionGone")}
        >
          {connection?.name ?? t("db.connectionGone")}
        </span>
        <span className="text-[var(--cf-text-muted)]">/</span>
        <span className="max-w-[240px] truncate text-[12px] font-medium text-[var(--cf-text)]">
          {nodeLabel(tab.node)}
        </span>

        {/*
          Four groups, in the order the work happens: re-read the table, change it, choose how to
          look at it or take it away, and then decide what to do with what you changed.

          The last group is the reason for the grouping. Discard used to be an icon three buttons to
          the left of Apply, which put the two halves of one decision at opposite ends of a strip
          with the layout toggle between them — so "undo what I just did" had to be hunted for, next
          to controls that do nothing to the data at all. The pair now reads as one question.
        */}
        <div className="ml-auto flex items-center gap-1">
          {tab.loading ? (
            <ToolbarButton onClick={() => void store.cancelRun(tab.id)} title={t("db.cancel")}>
              <Square size={12} className="text-[var(--cf-danger)]" />
            </ToolbarButton>
          ) : (
            <ToolbarButton onClick={() => void reload()} title={t("db.refresh")}>
              <RefreshCw size={12} />
            </ToolbarButton>
          )}

          <ToolbarSeparator />

          {/* On a collection this writes a document, not a row of nulls: there is no column list to
              make one from, and a schemaless store's "add" has always meant "write one". */}
          <ToolbarButton
            onClick={() => (documentStore ? addDocument() : store.addRow(tab.id))}
            title={documentStore ? t("db.addDocument") : t("db.addRow")}
          >
            <Plus size={13} />
          </ToolbarButton>

          <ToolbarSeparator />

          {/* Three ways to read documents, in Compass's own order: the list, the raw text, the
              grid. A switcher rather than the two-state toggle beside it, because these are three
              alternatives and a toggle can only ever say "the other one". */}
          {hasDocuments && (
            <>
              <ToolbarButton
                onClick={() => setDocView("documents")}
                active={docView === "documents"}
                title={t("db.documentList")}
              >
                <List size={12} />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => setDocView("json")}
                active={docView === "json"}
                title={t("db.showJson")}
              >
                <Braces size={12} />
              </ToolbarButton>
              <ToolbarButton
                onClick={() => setDocView("grid")}
                active={docView === "grid"}
                title={t("db.showGrid")}
              >
                <TableIcon size={12} />
              </ToolbarButton>
              <ToolbarSeparator />
            </>
          )}

          {/* How to look at the page, not what to do with a selection — which is why the "read
              these as records" action lives on the selection bar instead of beside this. Hidden
              while documents are up: transposing a grid is a question about a grid. */}
          {(!hasDocuments || docView === "grid") && (
            <ToolbarButton
              onClick={() => setLayout((current) => (current === "grid" ? "record" : "grid"))}
              active={layout === "record"}
              disabled={!tab.result}
              title={layout === "grid" ? t("db.recordLayout") : t("db.gridLayout")}
            >
              {layout === "grid" ? <Columns3 size={12} /> : <Rows3 size={12} />}
            </ToolbarButton>
          )}
          <ToolbarButton
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right - 180, y: rect.bottom + 2, kind: "export", rows: selectedRows });
            }}
            disabled={!tab.result || tab.result.rows.length === 0}
            title={
              selectedRows.length > 0
                ? t("db.exportSelectedN", { n: String(selectedRows.length) })
                : t("db.export")
            }
          >
            <Download size={12} />
          </ToolbarButton>

          <ToolbarSeparator />

          {/* Worded, not an icon: it is the other answer to the question Apply asks, and an icon
              beside a labelled button reads as a lesser control rather than as the alternative.
              `CircleX` and not a bin — nothing is deleted here. The staged edits are dropped and the
              rows go back to what the server last said, which is a cancel, not a destruction. */}
          <button
            type="button"
            onClick={() => store.revertEdits(tab.id)}
            disabled={staged === 0}
            title={t("db.revert")}
            className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-[3px] text-[12px] font-medium text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--cf-border)] disabled:hover:text-[var(--cf-text-muted)]"
          >
            <CircleX size={11} />
            {t("db.discard")}
          </button>
          <button
            onClick={apply}
            disabled={staged === 0}
            className="flex items-center gap-1 rounded-md bg-[var(--cf-accent)] px-2 py-[3px] text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save size={11} />
            {staged > 0 ? t("db.applyN", { n: String(staged) }) : t("db.apply")}
          </button>
        </div>
      </div>

      {/* The warning that matters: without a primary key, an edit is matched by every column. */}
      {tab.result && tab.columns.length > 0 && !identified && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-warning)]/[0.08] px-2 py-1 text-[11px] text-[var(--cf-text)]">
          <AlertTriangle size={12} className="mt-[1px] shrink-0 text-[var(--cf-warning)]" />
          {t("db.noPrimaryKeyWarning")}
        </p>
      )}

      {/* And the one a projection brings: what is on screen is part of a document, so the actions
          that write a document back are gone until it is cleared. Said rather than left to be
          discovered by noticing two buttons missing. */}
      {!wholeDocuments && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-warning)]/[0.08] px-2 py-1 text-[11px] text-[var(--cf-text)]">
          <AlertTriangle size={12} className="mt-[1px] shrink-0 text-[var(--cf-warning)]" />
          {t("db.projectionWarning")}
        </p>
      )}

      {/* Grid. Isolated so the selection bar below floats over the grid and nothing else. */}
      <div className="relative isolate min-h-0 flex-1">
        {tab.error ? (
          <div className="p-3">
            <p className="flex items-start gap-2 rounded-md border border-[var(--cf-danger)]/40 bg-[var(--cf-danger)]/[0.06] p-2 font-mono text-[12px] text-[var(--cf-danger)]">
              <AlertTriangle size={13} className="mt-[2px] shrink-0" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{tab.error}</span>
            </p>
          </div>
        ) : hasDocuments && docView !== "grid" ? (
          // The same cards either way — see `DocumentList` for why one component draws both. What
          // differs is only whether the braces are drawn, so a document edited in one view and
          // looked at in the other is recognisably the same document.
          <div className="flex h-full min-h-0 flex-col">
            <DocumentList
              documents={documents}
              offset={tab.offset}
              mode={docView === "json" ? "json" : "fields"}
              actions={documentActions}
              stateOf={documentState}
            />
          </div>
        ) : tab.result ? (
          // The same props either way: the two are one dataset seen along different axes, and
          // anything that behaved differently between them would be a bug rather than a feature.
          (() => {
            const shared = {
              engine: engineKind,
              columns: tab.result.columns,
              rows: tab.result.rows,
              displayValue: (row: number, column: string) => displayCell(tab, row, column),
              onEdit: ({ row, column, value }: { row: number; column: string; value: string | null }) =>
                store.setCell(tab.id, row, column, value),
              changed,
              deletedRows: deleted,
              insertedRows: tab.inserted,
              onEditInserted: ({
                row,
                column,
                value,
              }: {
                row: number;
                column: string;
                value: string | null;
              }) => store.setInsertedCell(tab.id, row, column, value),
              onRemoveInserted: (row: number) => store.removeInsertedRow(tab.id, row),
              onRowContextMenu: (row: number, event: React.MouseEvent) => {
                // Right-clicking outside the selection moves it, so the menu that opens is about
                // the row under the pointer and not about rows somewhere else on screen.
                if (!selected.has(row)) selectRow(row, { range: false, toggle: false });
                setMenu({ x: event.clientX, y: event.clientY, kind: "row", row });
              },
              onCellContextMenu: (row: number, column: string, event: React.MouseEvent) => {
                // The same selection move as above, but never for a locally added row: the grids
                // exclude those from the selection by construction (`selected = !inserted && …`),
                // and putting an out-of-range index in there is what let `rowMenu` believe a draft
                // was one of the rows being acted on.
                const serverRows = tab.result?.rows.length ?? 0;
                if (row < serverRows && !selected.has(row)) {
                  selectRow(row, { range: false, toggle: false });
                }
                setMenu({ x: event.clientX, y: event.clientY, kind: "cell", row, column });
              },
              selectedRows: selected,
              onSelectRow: selectRow,
              onSelectRange: selectRange,
              onSelectAllRows: selectAll,
              primaryKeys,
              foreignKeys,
              // Only where a row *is* a document. On a table the four of them have no meaning —
              // there is no document to edit, clone or copy, and deleting a row is what the gutter
              // and the menu already do.
              rowActions: documentStore ? rowActions : undefined,
              onFollowForeignKey: (key: DbForeignKey, value: string | null) =>
                store.followForeignKey(tab, key, value),
            };
            return layout === "record" ? (
              <RecordGrid {...shared} />
            ) : (
              // Sorting is the grid's alone: it is a click on a column header, and in the record
              // view a column header is a record.
              //
              // A sort written into the options is the query's sort, and the server applies it in
              // place of the headers' — so the headers stop offering one rather than offering one
              // that would be quietly ignored. `ResultGrid` draws a header without `onSort` as
              // plain text, which is exactly the right thing for a sort that is set elsewhere.
              <ResultGrid
                {...shared}
                onSort={sortedByOptions ? undefined : cycleSort}
                sort={sortedByOptions ? [] : tab.sort}
              />
            );
          })()
        ) : null}

        {/* What the selection can do, only while there is one — and floating over the grid rather
            than stacked above it. In the flow it pushed the whole grid down the instant a selection
            appeared, which during a press-and-drag means the rows move out from under the pointer
            on the very first one. A bar that is always there would cost a row of screen to say
            "nothing is selected". */}
        {selectedRows.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center px-2">
            <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1 shadow-[var(--cf-shadow)]">
              <span className="text-[11px] font-medium text-[var(--cf-text)]">
                {t(counts.selected, { n: String(selectedRows.length) })}
              </span>
              <ToolbarButton
                onClick={() => openRecords(selectedRows)}
                title={t("db.viewRecordsSelected")}
              >
                <Rows3 size={12} />
              </ToolbarButton>
              <ToolbarButton
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: rect.left, y: rect.top - 4, kind: "export", rows: selectedRows });
                }}
                title={t("db.exportSelectedN", { n: String(selectedRows.length) })}
              >
                <Download size={12} />
              </ToolbarButton>
              <ToolbarButton onClick={deleteSelected} title={t("db.deleteSelectedHint")}>
                <Trash2 size={12} className="text-[var(--cf-danger)]" />
              </ToolbarButton>
              <button
                type="button"
                onClick={() => selectAll(false)}
                className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <X size={11} />
                {t("db.clearSelection")}
              </button>
            </div>
          </div>
        )}

        {tab.loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-[var(--cf-surface)]/70 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("db.loading")}
          </div>
        )}
      </div>

      {/* The query bar: the options, the pager and the filter, in one form.
          One form because the filter and the options are one question — Enter in any of the boxes
          asks it, and asking it twice (once for the predicate, once for the projection) would mean
          two round trips for one edit. The pager's own buttons carry `type="button"`, so they page
          rather than submit. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Applied on submit, not per keystroke: a half-written predicate would otherwise run —
          // and fail — on every character.
          applyQuery();
        }}
        className="shrink-0 border-t border-[var(--cf-border)]"
      >
        {documentStore && optionsOpen && (
          <QueryOptionsPanel
            value={tab.optionsDraft}
            onChange={(patch: Partial<DbQueryOptions>) =>
              store.updateData(tab.id, { optionsDraft: { ...tab.optionsDraft, ...patch } })
            }
            onReset={resetQuery}
          />
        )}

        {/* Pager.
            One line that never wraps: every part of it is two or three characters, and the moment one
            of them folds onto a second line ("1 /" over "1") the bar stops reading as a control and
            starts reading as broken. So each piece is `whitespace-nowrap`, and the bar scrolls
            sideways in a panel too narrow for all of it rather than reflowing. */}
        <div className="flex items-center gap-1.5 overflow-x-auto px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">
          <ToolbarButton
            onClick={() => {
              store.updateData(tab.id, { offset: Math.max(0, tab.offset - tab.limit) });
              void store.loadData(tab.id);
            }}
            disabled={tab.offset === 0 || tab.loading}
            title={t("db.previousPage")}
          >
            <ChevronLeft size={13} />
          </ToolbarButton>
          <span className="shrink-0 whitespace-nowrap tabular-nums">
            {lastPage === null ? t("db.pageN", { n: String(page) }) : `${page} / ${lastPage}`}
          </span>
          <ToolbarButton
            onClick={() => {
              store.updateData(tab.id, { offset: tab.offset + tab.limit });
              void store.loadData(tab.id);
            }}
            // Enabled on a full page even when the total isn't known yet: the count is a separate,
            // slower query and paging shouldn't wait for it.
            disabled={
              tab.loading ||
              (tab.result !== null && tab.result.rows.length < tab.limit) ||
              (lastPage !== null && page >= lastPage)
            }
            title={t("db.nextPage")}
          >
            <ChevronRight size={13} />
          </ToolbarButton>

          {/* The page size, as a number you click — not a dropdown wide enough to hold a sentence.
              The choice is between five numbers and the current one is two or three digits, so the
              control is sized for a number and the list opens where it stands. */}
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4, kind: "pageSize" });
            }}
            title={t("db.perPage", { n: formatCount(tab.limit) })}
            className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded border border-[var(--cf-border)] px-1.5 py-[1px] tabular-nums text-[var(--cf-text)] hover:border-[var(--cf-accent)]"
          >
            {formatCount(tab.limit)}
            <ChevronDown size={11} className="text-[var(--cf-text-muted)]" />
          </button>

          <ToolbarSeparator />

          {/* The filter sits down here rather than in the toolbar above. It belongs with the pager:
              both narrow the same result set, and a predicate typed above the grid competed for the
              eye with the connection and table it was already showing. It also costs no height here —
              the pager's middle was empty — and it is the one control on this bar that should take
              whatever width is left over, so it grows while everything else stays its own size. */}
          <div className="flex min-w-[140px] flex-1 items-center gap-1">
            <span className="shrink-0 text-[10px] uppercase tracking-wide">
              {engine?.sql ? "WHERE" : t("db.filter")}
            </span>
            <input
              ref={filterRef}
              value={tab.filterDraft}
              onChange={(e) => store.updateData(tab.id, { filterDraft: e.target.value })}
              placeholder={engine?.sql ? t("db.wherePlaceholder") : t("db.filterPlaceholder")}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1.5 py-[2px] font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:font-sans focus:border-[var(--cf-accent)]"
            />
            {/* Only on the engines that have more to ask than a predicate. The dot says an option is
                set while the panel is shut, so a page narrowed by a projection or a limit can never
                look like an unfiltered one. */}
            {documentStore && (
              <span className="relative flex shrink-0 items-center">
                <ToolbarButton
                  onClick={() => setOptionsOpen((current) => !current)}
                  active={optionsOpen}
                  title={t("db.queryOptions")}
                >
                  <SlidersHorizontal size={12} />
                </ToolbarButton>
                {!optionsOpen && hasQueryOptions(tab.options) && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -right-[1px] -top-[1px] h-1.5 w-1.5 rounded-full bg-[var(--cf-accent)]"
                  />
                )}
              </span>
            )}
          </div>

          <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap tabular-nums">
            {tab.result && <span>{formatDuration(tab.result.duration_ms)}</span>}
            <span>
              {tab.total === null
                ? t(counts.n, { n: formatCount(tab.result?.rows.length ?? 0) })
                : t(counts.ofTotal, {
                    n: formatCount(tab.result?.rows.length ?? 0),
                    total: formatCount(tab.total),
                  })}
            </span>
          </span>
        </div>
      </form>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={menu.kind === "pageSize" ? t("db.rowsPerPage") : undefined}
          items={
            menu.kind === "row"
              ? rowMenu(menu.row, menu.x, menu.y)
              : menu.kind === "cell"
                ? cellMenu(menu.row, menu.column, menu.x, menu.y)
                : menu.kind === "export"
                ? exportItems(menu.rows)
                : PAGE_SIZES.map((size) => ({
                    label: t("db.perPage", { n: formatCount(size) }),
                    onClick: () => {
                      store.updateData(tab.id, { limit: size, offset: 0 });
                      void store.loadData(tab.id);
                    },
                  }))
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** A one-line description of a staged edit, for the confirmation sheet. The real SQL comes back from
 * the backend after it runs — generating it twice, here and there, is how the two drift apart. */
function describeEdit(kind: string, values: number, keys: number, document: boolean): string {
  // A document edit writes the whole document, so counting columns would describe the wrong thing —
  // and "replace" rather than "update" is the word that matters here: a field left out is a field
  // removed.
  if (document) {
    return kind === "insert"
      ? "INSERT — one document"
      : `REPLACE — the whole document, matched on ${keys} field(s)`;
  }
  if (kind === "insert") return `INSERT — ${values} column(s)`;
  if (kind === "delete") return `DELETE — matched on ${keys} column(s)`;
  return `UPDATE — ${values} column(s), matched on ${keys}`;
}
