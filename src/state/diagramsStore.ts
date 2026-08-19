import { create } from "zustand";
import {
  diagramsCreateDiagram,
  diagramsCreateFolder,
  diagramsCreateTemplate,
  diagramsDeleteTemplate,
  diagramsDeleteDiagram,
  diagramsDeleteFolder,
  diagramsDuplicateDiagram,
  diagramsGetDiagram,
  diagramsLoadThumbnails,
  diagramsLoadTree,
  diagramsMoveDiagram,
  diagramsMoveFolder,
  diagramsRenameDiagram,
  diagramsRenameFolder,
  diagramsReorderDiagrams,
  diagramsReorderFolders,
  diagramsSaveDiagram,
  diagramsSetFolderColor,
  diagramsSetPinned,
  diagramsSetTags,
  diagramsUpdateTemplate,
} from "../lib/tauri/diagramsCommands";
import { builtInTemplates, toTemplate } from "../lib/diagrams/builtinTemplates";
import { DEFAULT_FORMAT, emptyDoc } from "../lib/diagrams/doc";
import {
  DEFAULT_EXPORT_OPTIONS,
  parseExportOptions,
  type ImageExportOptions,
  type PendingExport,
} from "../lib/diagrams/exportOptions";
import { appendCells } from "../lib/diagrams/mxgraph";
import { descendantIds } from "../lib/diagrams/tree";
// Reused rather than copied: these take `string[]` and `{ tags: string[] }[]`, so nothing about
// them is note-shaped except which file they were first needed in. Two implementations of "how a
// tag is normalized" is how `deploy` and `Deploy` become different tags in different workspaces.
import { parseTags, serializeTags } from "../lib/notes/tags";
import { translate } from "./languageStore";
import { pushErrorToast } from "./toastStore";
import { useAiRunStore } from "./aiRunStore";
import { useWorkspaceStore } from "./workspaceStore";
// Type only, so the layout module stays out of this store's runtime graph: `aiByDiagram` keeps
// what the panel produced, it does not produce it.
import type { AiGraph } from "../lib/diagrams/aiLayout";
import type {
  Diagram,
  DiagramFolderRow,
  DiagramFormat,
  DiagramGalleryView,
  DiagramMetaRow,
  DiagramSort,
  DiagramTemplate,
  DiagramTemplateRow,
} from "../types/diagrams";

/**
 * The diagram being edited, before it is saved.
 *
 * The editor writes here and only here; the debounced save copies it into the row and folds the
 * answer back into `diagrams`. That indirection is what lets drawing stay at the speed of a drag
 * while the database is written at the speed of a person pausing — and what makes "unsaved" a state
 * the view can show honestly rather than a guess. It is also why the frame can be remounted (a
 * theme change, a language change) without losing an edit: the store holds the document, not the
 * iframe.
 */
export interface DiagramDraft {
  id: string;
  doc: string;
  format: DiagramFormat;
  /** The last picture the editor exported, waiting to be written with the document. */
  thumbnail: string;
  /** Whether anything here differs from the row. Drives the status line and the flush-on-close. */
  dirty: boolean;
}

/**
 * A "Draw with AI" generation, filed under the diagram it was started on.
 *
 * Here rather than in `DiagramAiPanel`'s own state, which is where it lived. That panel is
 * unmounted by everything: the back-to-gallery button, a workspace switch, leaving the view, the
 * guided tour. A `useState` dies with it — so a generation that took a minute to arrive was
 * destroyed by a click on the gallery, while the notification it had already filed went on saying
 * "Diagram drawn" about shapes that existed nowhere.
 *
 * Keyed by diagram rather than held as one slot beside `draft`, for the reason every other feature
 * in this app now keys its runs: several diagrams can be drawing at once, and a single
 * `runId`/`result` pair would offer the fourth one's answer on the first one's canvas and let its
 * Stop button cancel a run the user could not see.
 *
 * Each entry carries the workspace it started in, **stamped at the click** and never read back off
 * the active workspace when the answer lands. That stamp is what lets this map outlive
 * `setWorkspace` (see `clearedWorkspaceState`): an entry knows where it belongs, so nothing
 * downstream has to guess.
 */
export type DiagramAiRun = {
  /** The run id, so a panel re-opened long afterwards can still stop what it started — and so a
   *  late answer can prove it is still the run this diagram is waiting on. */
  runId: string;
  /** The workspace the diagram was in when the run began. Never `activeWorkspaceId` at the end. */
  workspaceId: string;
  /** When it began. The one fact about a run that cannot be recovered afterwards, and the panel
   *  that would show it is precisely the thing not guaranteed to have been mounted throughout —
   *  the same reasoning as `storiesStore.runStartedAt`. */
  startedAt: number;
} & (
  | { status: "running" }
  /** The validated answer, waiting for the user to look at it and press Add to canvas. */
  | { status: "ready"; graph: AiGraph }
);

/** How long after the last edit the document is written. Long enough that a continuous drag is one
 *  write, short enough that walking away from the keyboard has already saved. */
const SAVE_DEBOUNCE_MS = 900;

/**
 * The Diagrams workspace's state: the tree, the open document, and the writes that organise them.
 *
 * Modelled on `notesStore`, and it shares the four rules that make a tree of documents usable:
 *
 * **The list never carries documents — nor pictures.** `diagrams` is metadata. Documents arrive one
 * at a time into `draft`; thumbnails arrive in batches into `thumbnails`, for the cards on screen.
 * See `db/diagram_queries.rs`.
 *
 * **The store holds the document, not the editor.** draw.io lives in an iframe that is remounted
 * whenever the theme or the language changes, so anything only the iframe knew would be lost on a
 * theme toggle. `draft` is the truth and the frame is told what to draw.
 *
 * **Optimistic, then reconciled.** A drag writes the new arrangement into state before the write
 * goes out — a row that snaps back for a frame reads as a failed drag — and a failure re-reads the
 * tree rather than unwinding, because a drop touched every sibling's position.
 *
 * **The root is a place.** `folder_id === null` is where a diagram made from the gallery lives,
 * not an error state to be corrected.
 */

const expandedKey = (workspaceId: string) => `diagrams_expanded_folders:${workspaceId}`;
const sortKey = (workspaceId: string) => `diagrams_sort:${workspaceId}`;
const galleryViewKey = (workspaceId: string) => `diagrams_gallery_view:${workspaceId}`;
/** Whether the shipped templates have been written into this workspace yet. Not "whether
 *  `templates` is empty" — a workspace someone has deleted every template from must stay empty,
 *  not have the starters reappear on the next launch. */
const templatesSeededKey = (workspaceId: string) => `diagrams_templates_seeded:${workspaceId}`;
/** The export dialog's last answer. Deliberately the odd one out among the keys above: no
 *  `:${workspaceId}` suffix, because a 20-point border or a transparent background is a habit of
 *  the person exporting, not a property of the project they happen to have open. Scoping it per
 *  workspace would mean re-answering the same dialog the same way once per project. */
const EXPORT_OPTIONS_KEY = "diagrams_export_options";

async function loadPref(key: string): Promise<string | null> {
  const { getSetting } = await import("../lib/tauri/commands");
  try {
    return (await getSetting(key)) ?? null;
  } catch {
    return null;
  }
}

async function savePref(key: string, value: string): Promise<void> {
  const { setSetting } = await import("../lib/tauri/commands");
  await setSetting(key, value).catch(() => {});
}

/** A stored row as the UI holds it — the one place `tags` stops being JSON. */
function toDiagram(row: DiagramMetaRow): Diagram {
  return { ...row, tags: parseTags(row.tags) };
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

interface DiagramsState {
  workspaceId: string | null;
  loading: boolean;

  diagrams: Diagram[];
  folders: DiagramFolderRow[];
  /** Every template in the workspace — shipped and user-saved alike. See `builtinTemplates`. */
  templates: DiagramTemplate[];

  /** The diagram open in the editor. `null` is the gallery. */
  activeId: string | null;
  /** The open diagram's document. `null` while it is still in flight, or when none is open. */
  draft: DiagramDraft | null;
  /** The id whose document is being fetched, so a second click doesn't start a second fetch. */
  openingId: string | null;
  /** A write is in progress. */
  saving: boolean;
  /** When the last write landed, for the status line. */
  savedAt: string | null;
  /**
   * Pictures, by diagram id, for the cards currently drawn.
   *
   * A cache rather than part of `diagrams`: thumbnails are fetched for what is on screen, and
   * keeping them beside the metadata would put the whole workspace's images in the tree load. An
   * id that is absent simply has no picture yet — the card falls back to its glyph.
   */
  thumbnails: Record<string, string>;
  /**
   * A whole document the editor should display, or `null`.
   *
   * The AI panel and the iframe never speak to each other — the panel produces shapes, the store
   * combines them with what is already drawn, and `DrawioFrame` posts the result. That indirection
   * is what lets the panel be unmounted, or the frame be remounted by a theme change, without
   * either having to know about the other.
   *
   * **A whole document rather than just the new shapes**, because draw.io's `merge` action puts
   * the incoming model on a *second page* instead of into the open drawing — see `appendCells`.
   */
  pendingLoad: string | null;
  /**
   * The document as it was before the last AI generation, while undoing it is still meaningful.
   *
   * draw.io's own undo stack is reset by a `load`, so `⌘Z` cannot take a generation back out — this
   * is what does instead. Cleared by the next real edit: once the user has drawn on top, going back
   * would throw away their work rather than the generation's.
   */
  undoGeneration: string | null;
  /**
   * An export the user asked the editor for, or `null`.
   *
   * The same one-way channel as `pendingLoad`, and for the same reason: the toolbar that offers
   * "Export as PNG" is not the component holding the iframe. `DrawioFrame` picks this up, asks the
   * editor, and writes the file when the answer comes back.
   *
   * Its formats come from `ExportFormat` rather than being spelled out again, so a format cannot
   * be offered by the menu and be unknown here — the two lists drifting apart is how `.drawio`
   * came to be a filter with nothing that could ask for it.
   *
   * It carries the picture options as well as the format, in one object rather than in a second
   * field beside this one: the request travels in a single `set`, so there is no window in which
   * the frame could read a new format against the previous dialog's answer. `PendingExport` being
   * a discriminated union is the other half of that — see `exportOptions.ts`.
   */
  pendingExport: PendingExport | null;
  /**
   * The last answer the export dialog got, so it does not have to be typed again.
   *
   * Loaded once with the workspace and written back on every confirm. Not per workspace, and not
   * reset when one is switched — see `EXPORT_OPTIONS_KEY`.
   */
  exportOptions: ImageExportOptions;

  /**
   * Whether the "Draw with AI" window is up over the canvas.
   *
   * In the store rather than in `DiagramsView`'s own state, where it started, because two things
   * outside that component now decide it: the sparkle injected into the editor's toolbar, which
   * lives in another document entirely, and the guided tour, whose stage has to be able to put the
   * panel on screen to point at it — and to take it away again on the step after, in both
   * directions. A `useState` can be set by a callback handed downwards; it cannot be *described*
   * by a tour step. See `TourStage`.
   */
  aiOpen: boolean;

  /**
   * Every generation in flight or waiting to be applied, by diagram id. See `DiagramAiRun`.
   *
   * Deliberately **not** cleared by `setWorkspace` — see `clearedWorkspaceState`, which is where
   * that decision is written down.
   */
  aiByDiagram: Record<string, DiagramAiRun>;

  /** The search box. Matches titles and tags — there is no document search yet. */
  query: string;
  /** ANDed, not ORed: adding a tag narrows. Two tags means "carries both". */
  tagFilter: string[];
  /** Which folder the gallery is showing. `null` is the whole workspace. */
  folderFilter: string | null;
  sort: DiagramSort;

  /** Folder ids the user has opened. Persisted, and closed is the default — see `expandedKey`. */
  expanded: string[];
  galleryView: DiagramGalleryView;

  /**
   * Points the whole workspace at `workspaceId`, dropping everything the outgoing one had on
   * screen. `null` — the state a deleted workspace leaves behind — empties it and loads nothing.
   *
   * Called on mount through `ensureDiagramsStoreLoaded` and, for every switch after that, from the
   * subscription at the bottom of this file.
   */
  setWorkspace: (workspaceId: string | null) => Promise<void>;
  refresh: () => Promise<void>;

  setQuery: (query: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  setFolderFilter: (folderId: string | null) => void;
  setSort: (sort: DiagramSort) => void;
  setGalleryView: (view: DiagramGalleryView) => void;
  toggleFolder: (folderId: string) => void;
  expandFolder: (folderId: string) => void;

  /** Fetches the document and opens the editor on it. */
  openDiagram: (id: string) => Promise<void>;
  /** Writes anything unsaved and goes back to the gallery, unmounting the editor. */
  closeDiagram: () => Promise<void>;
  /** One edit from the editor. Debounced into a write; see `SAVE_DEBOUNCE_MS`. */
  editDoc: (doc: string) => void;
  /** The picture the editor just exported. Stored with the next write of the document. */
  setThumbnail: (id: string, thumbnail: string) => void;
  /**
   * Writes the draft now, if it is dirty.
   *
   * Called from every path that could drop it — closing, switching workspace, hiding the window —
   * and a no-op when nothing is pending, so it costs nothing in the common case.
   */
  flush: () => Promise<void>;
  /** Fetches the pictures of `ids` that aren't already cached. */
  loadThumbnails: (ids: string[]) => Promise<void>;

  /**
   * Adds generated shapes to `diagramId`'s drawing. See `pendingLoad`.
   *
   * Takes the diagram it is meant for rather than trusting whatever is open: see the guard in the
   * implementation for what that stops.
   *
   * **Answers whether the shapes landed.** `false` means nothing was written and the caller still
   * holds the only copy — it must not treat the generation as consumed. The answer is not
   * decoration: the window can be up over a diagram whose document is still in flight
   * (`openingId`), which is exactly the state that following a notification into another
   * workspace leaves it in, and a caller that assumed success there would drop a finished
   * generation on the floor with nothing drawn and nothing said.
   */
  applyGenerated: (diagramId: string, doc: string) => boolean;
  /**
   * Records that a generation has started on `diagramId`, and returns the entry it wrote — whose
   * `workspaceId` is the stamp everything downstream must quote.
   *
   * `null` when that diagram already has a run in flight, so the caller stops rather than starting
   * a second one nothing can attribute. Per diagram, never store-wide: two diagrams generating at
   * once is a thing the user asked for.
   */
  startAiRun: (diagramId: string, runId: string) => DiagramAiRun | null;
  /**
   * The end of a generation: `graph` parks the answer against its diagram, `null` drops the entry
   * — it failed, it was stopped, or it has been put on the canvas.
   *
   * Ignored unless `runId` is still the run that diagram is waiting on, which is what keeps a slow
   * answer from landing on top of a newer one started after it.
   */
  settleAiRun: (diagramId: string, runId: string, graph: AiGraph | null) => void;
  /** Called by the frame once it has posted the document. */
  clearPendingLoad: () => void;
  /** Opens or closes the "Draw with AI" window. See `aiOpen`. */
  setAiOpen: (open: boolean) => void;
  /** Puts the drawing back as it was before the last generation. */
  undoLastGeneration: () => void;
  /** Called on a real user edit, which is what makes the generation no longer the last thing done. */
  clearGenerationUndo: () => void;
  /** Asks the editor for a file. See `pendingExport`. */
  requestExport: (request: PendingExport) => void;
  /** Remembers what the export dialog was told, and writes it through to settings. */
  setExportOptions: (options: ImageExportOptions) => void;
  /**
   * Opens a `.drawio` file from disk as a new diagram, and opens it. Returns its title, or `null`
   * when the dialog was dismissed or the read failed.
   */
  importDrawio: (folderId: string | null) => Promise<string | null>;
  /** Called by the frame once it has posted the export request. */
  clearPendingExport: () => void;

  /** Creates a diagram from a template's document, carrying its tags across. */
  createFromTemplate: (folderId: string | null, template: DiagramTemplate) => Promise<string | null>;
  /** Saves explicit content as a template — used by "save this diagram as one" and by the seed. */
  createTemplate: (
    name: string,
    description: string,
    icon: string,
    doc: string,
    format: DiagramFormat,
    tags: string[],
  ) => Promise<void>;
  updateTemplate: (row: DiagramTemplateRow) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;

  createDiagram: (folderId: string | null, title?: string) => Promise<string | null>;
  renameDiagram: (id: string, title: string) => Promise<void>;
  setTags: (id: string, tags: string[]) => Promise<void>;
  deleteDiagram: (id: string) => Promise<void>;
  duplicateDiagram: (id: string) => Promise<string | null>;
  togglePinned: (id: string) => Promise<void>;
  moveDiagram: (id: string, folderId: string | null) => Promise<void>;
  /**
   * A drop, resolved. `anchor` null files into `folderId`; an anchor places it next to that row.
   * See `diagramsDragStore` for why those are two gestures rather than one.
   */
  dropDiagram: (
    id: string,
    folderId: string | null,
    anchor: { id: string; after: boolean } | null,
  ) => Promise<void>;

  createFolder: (parentId: string | null, name: string) => Promise<string | null>;
  renameFolder: (id: string, name: string) => Promise<void>;
  setFolderColor: (id: string, color: string) => Promise<void>;
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  /** The folders' half of `dropDiagram`. Refuses, silently, to nest a folder in its own subtree. */
  dropFolder: (
    id: string,
    parentId: string | null,
    anchor: { id: string; after: boolean } | null,
  ) => Promise<void>;
  /** Deletes the folder, its subfolders **and every diagram inside them**. Confirm before calling. */
  deleteFolder: (id: string) => Promise<void>;
}

/** In-flight `setWorkspace`, so two mounts in the same tick don't both load the tree. */
let pendingLoad: { workspaceId: string; promise: Promise<void> } | null = null;
/** The pending debounced save. Outside the store: a timer is not state anything renders. */
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * The write currently in progress, so a second `flush()` joins it instead of racing it.
 *
 * Outside the store for the same reason the timer is. It matters because `flush` is called from
 * four places — the debounce, `openDiagram`, `closeDiagram` and the view's unmount — and two of
 * them can easily fire in the same tick.
 */
let pendingFlush: Promise<void> | null = null;
/** Thumbnail ids already requested, so a re-render doesn't re-ask for the same pictures. */
let requestedThumbnails = new Set<string>();

/**
 * Restarts the debounce.
 *
 * A free function rather than a store action because it is called from two of them and does not
 * belong in the public surface — nothing outside this file should be able to schedule a write
 * without having made an edit.
 */
function scheduleSave(get: () => DiagramsState): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void get().flush();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Everything on screen that belongs to the workspace being left.
 *
 * One definition rather than two literals, because `setWorkspace` has two ways out — it loads the
 * incoming workspace, or it empties the view because there is no incoming workspace — and a field
 * cleared in one path and forgotten in the other is exactly how the new workspace ends up wearing
 * the old one's state.
 *
 * `exportOptions` is deliberately absent, and its absence is the point: everything here is dropped
 * so the incoming workspace never briefly wears the outgoing one's state, but the export dialog's
 * answer does not belong to a workspace at all. Clearing it by symmetry with its neighbours would
 * make the dialog forget the user's margin every time they changed workspace — a bug that only
 * shows up after a switch, and only to whoever noticed they had set it.
 *
 * **`aiByDiagram` is absent for the opposite reason**: it belongs to *its own* workspace, not to
 * this one. Diagram ids are UUIDs, so nothing in it can collide with the incoming workspace's
 * rows, and every entry carries the workspace it started in — while clearing it would destroy the
 * one thing the user is waiting on, and do it precisely for the run that most needed to survive:
 * the one they walked away from. A generation must outlive a look at another workspace; that is
 * the whole point of holding it here rather than in the panel.
 *
 * `aiOpen`, on the other hand, *is* here. The window it draws opens over whichever diagram is
 * open and takes the caret as it does (`autoFocus`), so left standing it would pop itself up over
 * the first diagram opened in the next workspace — a window nobody asked for, about a drawing it
 * was not written for.
 */
function clearedWorkspaceState(): Partial<DiagramsState> {
  return {
    aiOpen: false,
    diagrams: [],
    folders: [],
    templates: [],
    activeId: null,
    draft: null,
    openingId: null,
    savedAt: null,
    thumbnails: {},
    pendingLoad: null,
    undoGeneration: null,
    pendingExport: null,
    query: "",
    tagFilter: [],
    folderFilter: null,
    // Back to the defaults; the stored values arrive with the tree, when there is one.
    expanded: [],
    sort: "manual",
    galleryView: "grid",
  };
}

/**
 * Stops any generation still drawing into the diagrams named here.
 *
 * The counterpart of `stopNoteAiRuns`, and for the same reason: dropping the `aiByDiagram` entry
 * when the diagram is deleted left an engine drawing into a document that had ceased to exist, and
 * its success notification still announced a diagram nobody could open. Cancelling routes the
 * panel through its `isCancellation` branch, which reports nothing — the right amount to say about
 * a run the user ended by deleting what it was for.
 */
function stopDiagramAiRuns(runs: Record<string, DiagramAiRun>, diagramIds: Iterable<string>): void {
  for (const diagramId of diagramIds) {
    const run = runs[diagramId];
    if (run?.status === "running") void useAiRunStore.getState().cancel(run.runId);
  }
}

export const useDiagramsStore = create<DiagramsState>((set, get) => ({
  workspaceId: null,
  loading: false,
  diagrams: [],
  folders: [],
  templates: [],
  activeId: null,
  draft: null,
  openingId: null,
  saving: false,
  savedAt: null,
  thumbnails: {},
  pendingLoad: null,
  undoGeneration: null,
  pendingExport: null,
  exportOptions: DEFAULT_EXPORT_OPTIONS,
  aiOpen: false,
  aiByDiagram: {},
  query: "",
  tagFilter: [],
  folderFilter: null,
  sort: "manual",
  expanded: [],
  galleryView: "grid",

  setWorkspace: async (workspaceId) => {
    if (pendingLoad?.workspaceId === workspaceId) return pendingLoad.promise;
    if (get().workspaceId === workspaceId && !get().loading) return;

    // The outgoing workspace's unsaved edit, written before anything is dropped. A diagram is a
    // document: losing the last shape to a workspace switch is data loss, not a stale cache.
    await get().flush();
    requestedThumbnails = new Set();

    // No workspace to load — what a deleted workspace leaves behind. The view empties rather than
    // keeping the drawings of the one that is gone, and nothing is fetched.
    if (!workspaceId) {
      // Dropped along with the state it was going to fill. Leaving it would strand the workspace it
      // names: coming back to that same one is a `pendingLoad?.workspaceId === workspaceId` hit on
      // the first line above, which hands back a promise whose own guard now sees a different
      // `workspaceId` and writes nothing — an empty view that no further switch repairs.
      pendingLoad = null;
      set({ workspaceId: null, loading: false, ...clearedWorkspaceState() });
      return;
    }

    const promise = (async () => {
      // Cleared eagerly rather than on arrival, so a switch never shows the previous workspace's
      // diagrams under the new workspace's name.
      set({ workspaceId, loading: true, ...clearedWorkspaceState() });
      try {
        // In parallel with the tree rather than before it: the settings reads and the tree read are
        // independent, and serialising them would put five round trips before the first paint.
        const [tree, expanded, sort, galleryView, templatesSeeded, storedExportOptions] =
          await Promise.all([
            diagramsLoadTree(workspaceId),
            loadPref(expandedKey(workspaceId)),
            loadPref(sortKey(workspaceId)),
            loadPref(galleryViewKey(workspaceId)),
            loadPref(templatesSeededKey(workspaceId)),
            loadPref(EXPORT_OPTIONS_KEY),
          ]);
        // The user may have switched again while all that was in flight.
        if (get().workspaceId !== workspaceId) return;
        set({
          diagrams: tree.diagrams.map(toDiagram),
          folders: tree.folders,
          templates: tree.templates.map(toTemplate),
          expanded: parseList(expanded),
          sort: (sort as DiagramSort | null) ?? "manual",
          galleryView: galleryView === "list" ? "list" : "grid",
          exportOptions: parseExportOptions(storedExportOptions),
        });

        /**
         * The shipped templates, written in as ordinary rows the first time this workspace is ever
         * opened — once, tracked by the flag above rather than by "the list is empty", so deleting
         * all five stays deleted instead of them reappearing on the next launch. From here on a
         * seeded template is a row like any other.
         *
         * Sequential rather than `Promise.all`: five calls, once, ever, isn't worth the concurrency,
         * and it keeps `sort_order` (assigned by the backend in insertion order) in the curated
         * order rather than whatever order five racing writes happened to land in.
         */
        if (templatesSeeded !== "1") {
          const seeded: DiagramTemplateRow[] = [];
          for (const template of builtInTemplates()) {
            try {
              seeded.push(
                await diagramsCreateTemplate(
                  workspaceId,
                  template.name,
                  template.description,
                  template.icon,
                  template.doc,
                  template.format,
                  serializeTags(template.tags),
                ),
              );
            } catch {
              // Silent, like the rest of this block's writes: a workspace that ends up with four
              // starters instead of five isn't worth a toast, and the one failure mode here — a
              // broken database — is one every other action in this load already reports.
            }
          }
          await savePref(templatesSeededKey(workspaceId), "1");
          if (seeded.length > 0 && get().workspaceId === workspaceId) {
            set((state) => ({ templates: [...state.templates, ...seeded.map(toTemplate)] }));
          }
        }
      } catch (error) {
        pushErrorToast(String(error));
      } finally {
        // Guarded on the workspace still being this one, the way `dbStore` does it. A switch made
        // while this load was in flight has its own load running: clearing the flag unconditionally
        // would report *that* one finished, and the view would draw the empty tree it has so far as
        // though it were the whole workspace.
        if (get().workspaceId === workspaceId) set({ loading: false });
      }
    })();

    pendingLoad = { workspaceId, promise };
    try {
      await promise;
    } finally {
      if (pendingLoad?.workspaceId === workspaceId) pendingLoad = null;
    }
  },

  /** Re-reads the tree, keeping the view state. The way back from a failed optimistic write. */
  refresh: async () => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    try {
      const tree = await diagramsLoadTree(workspaceId);
      if (get().workspaceId !== workspaceId) return;
      set({
        diagrams: tree.diagrams.map(toDiagram),
        folders: tree.folders,
        templates: tree.templates.map(toTemplate),
      });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  setQuery: (query) => set({ query }),

  toggleTag: (tag) =>
    set((state) => ({
      tagFilter: state.tagFilter.includes(tag)
        ? state.tagFilter.filter((t) => t !== tag)
        : [...state.tagFilter, tag],
    })),

  clearTags: () => set({ tagFilter: [] }),

  setFolderFilter: (folderId) => set({ folderFilter: folderId }),

  setSort: (sort) => {
    set({ sort });
    const workspaceId = get().workspaceId;
    if (workspaceId) void savePref(sortKey(workspaceId), sort);
  },

  setGalleryView: (galleryView) => {
    set({ galleryView });
    const workspaceId = get().workspaceId;
    if (workspaceId) void savePref(galleryViewKey(workspaceId), galleryView);
  },

  toggleFolder: (folderId) => {
    const expanded = get().expanded.includes(folderId)
      ? get().expanded.filter((id) => id !== folderId)
      : [...get().expanded, folderId];
    set({ expanded });
    const workspaceId = get().workspaceId;
    if (workspaceId) void savePref(expandedKey(workspaceId), JSON.stringify(expanded));
  },

  /** Opens a folder without closing it if it is already open — what a drop into it needs. */
  expandFolder: (folderId) => {
    if (get().expanded.includes(folderId)) return;
    get().toggleFolder(folderId);
  },

  openDiagram: async (id) => {
    if (get().activeId === id && get().draft?.id === id) return;
    if (get().openingId === id) return;
    // The outgoing diagram's edit, before this one replaces it.
    await get().flush();

    // `undoGeneration` goes with the diagram it was captured on. It holds a whole document — the
    // one *this* diagram had before its last generation — and `undoLastGeneration` writes it into
    // whatever `draft` is current, so carrying it across would let the undo button on diagram B
    // replace B's drawing with A's. The button is drawn from this field, so leaving it set also
    // offers an undo for something the user never did here.
    set({ activeId: id, openingId: id, draft: null, savedAt: null, undoGeneration: null });
    try {
      const row = await diagramsGetDiagram(id);
      // The user may have clicked elsewhere while the document was in flight.
      if (get().openingId !== id) return;
      if (!row) {
        // Deleted from another window between the click and the fetch.
        set((state) => ({
          diagrams: state.diagrams.filter((d) => d.id !== id),
          activeId: null,
          openingId: null,
        }));
        return;
      }
      set((state) => ({
        draft: {
          id: row.id,
          doc: row.doc,
          format: row.format,
          thumbnail: row.thumbnail,
          dirty: false,
        },
        openingId: null,
        // Seeded from the row so the gallery behind the editor is already right on the way back.
        thumbnails: row.thumbnail
          ? { ...state.thumbnails, [row.id]: row.thumbnail }
          : state.thumbnails,
      }));
    } catch (error) {
      pushErrorToast(String(error));
      set({ openingId: null, activeId: null });
    }
  },

  closeDiagram: async () => {
    await get().flush();
    set({ activeId: null, draft: null, openingId: null, savedAt: null });
  },

  editDoc: (doc) => {
    const draft = get().draft;
    // An edit for a diagram that is no longer open — the frame was unmounted mid-message. Dropped
    // rather than written, or a close would be followed by one last write into the previous
    // document.
    if (!draft) return;
    if (draft.doc === doc) return;
    set({ draft: { ...draft, doc, dirty: true } });
    scheduleSave(get);
  },

  setThumbnail: (id, thumbnail) => {
    const draft = get().draft;
    if (!draft || draft.id !== id) return;
    if (draft.thumbnail === thumbnail) return;
    // Into the cache as well as the draft, so the gallery behind the editor is already up to date
    // when the user goes back — before the write has even landed.
    set((state) => ({
      draft: { ...draft, thumbnail, dirty: true },
      thumbnails: { ...state.thumbnails, [id]: thumbnail },
    }));
    scheduleSave(get);
  },

  flush: async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    if (pendingFlush) return pendingFlush;
    const draft = get().draft;
    if (!draft?.dirty) return;

    pendingFlush = (async () => {
      set({ saving: true });
      try {
        const row = await diagramsSaveDiagram(draft.id, draft.doc, draft.format, draft.thumbnail);
        if (!row) {
          // Deleted from another window while it was open.
          set((state) => ({
            diagrams: state.diagrams.filter((d) => d.id !== draft.id),
            draft: null,
            activeId: null,
          }));
          return;
        }
        set((state) => ({
          diagrams: state.diagrams.map((d) => (d.id === row.id ? toDiagram(row) : d)),
          // Only cleared when what was written is still what the draft holds. An edit that landed
          // while the write was in flight must stay dirty, or it is never saved at all.
          draft:
            state.draft && state.draft.id === draft.id && state.draft.doc === draft.doc
              ? { ...state.draft, dirty: false }
              : state.draft,
          savedAt: new Date().toISOString(),
        }));
      } catch (error) {
        pushErrorToast(String(error));
      } finally {
        set({ saving: false });
        pendingFlush = null;
      }
    })();
    return pendingFlush;
  },

  loadThumbnails: async (ids) => {
    const wanted = ids.filter((id) => !requestedThumbnails.has(id));
    if (wanted.length === 0) return;
    // Marked before the round trip, not after: this is called from a render, and two renders in the
    // same frame would otherwise both ask for the same pictures.
    for (const id of wanted) requestedThumbnails.add(id);
    const workspaceId = get().workspaceId;
    try {
      const rows = await diagramsLoadThumbnails(wanted);
      if (get().workspaceId !== workspaceId) return;
      if (rows.length === 0) return;
      set((state) => {
        const thumbnails = { ...state.thumbnails };
        for (const row of rows) thumbnails[row.id] = row.thumbnail;
        return { thumbnails };
      });
    } catch {
      // Silent, and the ids stay marked. A gallery card without its picture draws its glyph; a
      // toast for it would report a failure the user cannot act on, on a screen they are only
      // scrolling past.
    }
  },

  applyGenerated: (diagramId, doc) => {
    const draft = get().draft;
    // **Into the diagram it was generated for, or into nothing.**
    //
    // The `!draft` half of this guard was here and the comment above it claimed the rest, which
    // was not true: a result now survives the panel being closed and the workspace being changed,
    // so "the open diagram" and "the diagram this was drawn for" are routinely different things.
    // Without the id comparison, pressing Add to canvas after opening another diagram appends X's
    // shapes into Y, marks Y dirty and — three seconds later — autosaves them there, with nothing
    // on screen to say what happened. Ids are UUIDs, so this also covers the cross-workspace case:
    // a draft belonging to another workspace cannot answer to this id.
    //
    // Both refusals are reported rather than swallowed, so the panel can keep its answer parked
    // instead of consuming one that never reached the canvas.
    if (!draft || draft.id !== diagramId) return false;
    const combined = appendCells(draft.doc, doc);
    if (combined === draft.doc) return false;
    set({
      draft: { ...draft, doc: combined, dirty: true },
      pendingLoad: combined,
      undoGeneration: draft.doc,
    });
    scheduleSave(get);
    return true;
  },

  startAiRun: (diagramId, runId) => {
    // Stamped from the store's own workspace rather than from the active one, and read here — on
    // the click, before anything is awaited — because this is the last moment at which the two are
    // guaranteed to be the same answer.
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    // Per diagram. A second run on the *same* diagram would take the first one's slot, leaving its
    // answer unattributable and its Stop button pointing at a run nobody is waiting on.
    if (get().aiByDiagram[diagramId]?.status === "running") return null;
    const entry: DiagramAiRun = { runId, workspaceId, startedAt: Date.now(), status: "running" };
    set((state) => ({ aiByDiagram: { ...state.aiByDiagram, [diagramId]: entry } }));
    return entry;
  },

  settleAiRun: (diagramId, runId, graph) => {
    const current = get().aiByDiagram[diagramId];
    // Not "is this diagram open?" but "is this run still the one it is waiting on?" — the
    // difference being that leaving the screen, or the workspace, no longer discards the answer.
    // A run whose entry has been taken over by a newer one has nothing left to say.
    if (current?.runId !== runId) return;
    set((state) => {
      const aiByDiagram = { ...state.aiByDiagram };
      if (graph) aiByDiagram[diagramId] = { ...current, status: "ready", graph };
      else delete aiByDiagram[diagramId];
      return { aiByDiagram };
    });
  },

  clearPendingLoad: () => set({ pendingLoad: null }),

  setAiOpen: (open) => set({ aiOpen: open }),

  undoLastGeneration: () => {
    const { draft, undoGeneration } = get();
    if (!draft || undoGeneration === null) return;
    set({
      draft: { ...draft, doc: undoGeneration, dirty: true },
      pendingLoad: undoGeneration,
      undoGeneration: null,
    });
    scheduleSave(get);
  },

  clearGenerationUndo: () => {
    if (get().undoGeneration === null) return;
    set({ undoGeneration: null });
  },

  requestExport: (request) => {
    if (!get().draft) return;
    set({ pendingExport: request });
  },

  setExportOptions: (options) => {
    set({ exportOptions: options });
    // Fire-and-forget, like every other preference written from this store: the value the user
    // sees is already in state, and a settings write that loses a race is one dialog re-answered,
    // not a document lost.
    void savePref(EXPORT_OPTIONS_KEY, JSON.stringify(options));
  },

  clearPendingExport: () => set({ pendingExport: null }),

  importDrawio: async (folderId) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    try {
      const { openDrawioFile } = await import("../lib/diagrams/exportFile");
      const file = await openDrawioFile();
      if (!file) return null;
      // Stored as `mxgraph` without inspecting it. A `.drawio` file *is* the dialect the editor
      // reads, and a validator here would be a second, worse XML parser in front of the one that
      // is about to open it — the editor's own failure mode for a bad document is visible and
      // recoverable, which a rejection at the door would not be.
      const row = await diagramsCreateDiagram(
        workspaceId,
        folderId,
        file.name,
        file.xml,
        DEFAULT_FORMAT,
        serializeTags([]),
      );
      set((state) => ({
        diagrams: [...state.diagrams, toDiagram(row)],
        activeId: row.id,
        draft: { id: row.id, doc: file.xml, format: DEFAULT_FORMAT, thumbnail: "", dirty: false },
        openingId: null,
        savedAt: null,
      }));
      if (folderId) get().expandFolder(folderId);
      return row.title;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  createFromTemplate: async (folderId, template) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    try {
      const row = await diagramsCreateDiagram(
        workspaceId,
        folderId,
        template.name,
        template.doc,
        template.format,
        serializeTags(template.tags),
      );
      // The draft is built here rather than fetched back — the document is the template's, which is
      // already in hand. Same reasoning as `createDiagram`.
      set((state) => ({
        diagrams: [...state.diagrams, toDiagram(row)],
        activeId: row.id,
        draft: {
          id: row.id,
          doc: template.doc,
          format: template.format,
          thumbnail: "",
          dirty: false,
        },
        openingId: null,
        savedAt: null,
      }));
      if (folderId) get().expandFolder(folderId);
      return row.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  createTemplate: async (name, description, icon, doc, format, tags) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return;
    try {
      const row = await diagramsCreateTemplate(
        workspaceId,
        name,
        description,
        icon,
        doc,
        format,
        serializeTags(tags),
      );
      set((state) => ({ templates: [...state.templates, toTemplate(row)] }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  updateTemplate: async (row) => {
    try {
      await diagramsUpdateTemplate(row);
      set((state) => ({
        templates: state.templates.map((t) => (t.id === row.id ? toTemplate(row) : t)),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  deleteTemplate: async (id) => {
    try {
      await diagramsDeleteTemplate(id);
      set((state) => ({ templates: state.templates.filter((t) => t.id !== id) }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  createDiagram: async (folderId, title) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    try {
      const row = await diagramsCreateDiagram(
        workspaceId,
        folderId,
        title?.trim() || translate("diagrams.untitled"),
        emptyDoc(),
        DEFAULT_FORMAT,
        serializeTags([]),
      );
      // The draft is built here rather than fetched back: the document is the empty one just
      // sent, so a round trip would only ask the database to repeat it — and would leave the
      // editor on a skeleton for the length of it.
      set((state) => ({
        diagrams: [...state.diagrams, toDiagram(row)],
        activeId: row.id,
        draft: { id: row.id, doc: emptyDoc(), format: DEFAULT_FORMAT, thumbnail: "", dirty: false },
        openingId: null,
        savedAt: null,
      }));
      if (folderId) get().expandFolder(folderId);
      return row.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  renameDiagram: async (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    // Written first, then mirrored — the backend is what rejects a blank title, and updating the
    // tree before it answered would show a name the database refused. Same rule as
    // `workspaceStore.renameWorkspace`.
    try {
      const row = await diagramsRenameDiagram(id, trimmed);
      if (!row) {
        // Deleted from another window while it was being renamed.
        set((state) => ({ diagrams: state.diagrams.filter((d) => d.id !== id) }));
        return;
      }
      set((state) => ({
        diagrams: state.diagrams.map((d) => (d.id === id ? toDiagram(row) : d)),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  setTags: async (id, tags) => {
    try {
      const row = await diagramsSetTags(id, serializeTags(tags));
      if (!row) {
        set((state) => ({ diagrams: state.diagrams.filter((d) => d.id !== id) }));
        return;
      }
      set((state) => ({
        diagrams: state.diagrams.map((d) => (d.id === id ? toDiagram(row) : d)),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  deleteDiagram: async (id) => {
    stopDiagramAiRuns(get().aiByDiagram, [id]);
    try {
      // The pending write first, and only if it is for a *different* diagram: flushing a draft
      // belonging to the row about to be deleted would resurrect nothing but would spend a write
      // and, worse, could land after the delete and fail noisily.
      if (get().draft?.id !== id) await get().flush();
      else if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      await diagramsDeleteDiagram(id);
      set((state) => ({
        diagrams: state.diagrams.filter((d) => d.id !== id),
        activeId: state.activeId === id ? null : state.activeId,
        draft: state.draft?.id === id ? null : state.draft,
        thumbnails: Object.fromEntries(
          Object.entries(state.thumbnails).filter(([key]) => key !== id),
        ),
        // Dropped with the row it was filed under, like the thumbnail above it. `aiByDiagram` is
        // the one map here that survives a workspace switch, so an entry left behind for a diagram
        // that no longer exists is one nothing will ever clear — and a parked generation is a whole
        // graph, not a flag. A run still in flight was cancelled above (`stopDiagramAiRuns`); one
        // that beats the cancel settles into a key that is gone and writes nothing, see
        // `settleAiRun`.
        aiByDiagram: Object.fromEntries(
          Object.entries(state.aiByDiagram).filter(([key]) => key !== id),
        ),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  duplicateDiagram: async (id) => {
    const source = get().diagrams.find((d) => d.id === id);
    if (!source) return null;
    try {
      const row = await diagramsDuplicateDiagram(
        id,
        translate("diagrams.copyOf", { title: source.title }),
      );
      if (!row) return null;
      // Deliberately does not open the copy. `activeId` now means "open in the editor", and
      // duplicating is a filing action taken from the gallery — yanking the user into a canvas
      // they did not ask for is not what the menu entry says.
      set((state) => ({ diagrams: [...state.diagrams, toDiagram(row)] }));
      return row.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  togglePinned: async (id) => {
    const diagram = get().diagrams.find((d) => d.id === id);
    if (!diagram) return;
    const pinned = !diagram.pinned;
    // Optimistic: a pin is a one-bit toggle whose whole value is that it responds instantly.
    set((state) => ({
      diagrams: state.diagrams.map((d) => (d.id === id ? { ...d, pinned } : d)),
    }));
    await diagramsSetPinned(id, pinned).catch((error: unknown) => {
      pushErrorToast(String(error));
      set((state) => ({
        diagrams: state.diagrams.map((d) => (d.id === id ? { ...d, pinned: !pinned } : d)),
      }));
    });
  },

  moveDiagram: async (id, folderId) => {
    const diagram = get().diagrams.find((d) => d.id === id);
    if (!diagram || diagram.folder_id === folderId) return;
    try {
      const row = await diagramsMoveDiagram(id, folderId);
      if (!row) {
        set((state) => ({ diagrams: state.diagrams.filter((d) => d.id !== id) }));
        return;
      }
      set((state) => ({
        diagrams: state.diagrams.map((d) => (d.id === id ? toDiagram(row) : d)),
      }));
      if (folderId) get().expandFolder(folderId);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  dropDiagram: async (id, folderId, anchor) => {
    const state = get();
    const moving = state.diagrams.find((d) => d.id === id);
    // Dropped on its own edge: the gesture has an obvious meaning and it is "nothing". Guarded here
    // rather than in the caller so no drop path can miss it — the diagram is about to be pulled out
    // of `siblings`, and an anchor that went with it would silently become "append".
    if (!moving || anchor?.id === id) return;
    const changedFolder = moving.folder_id !== folderId;

    /**
     * **A drop with no anchor is a move, and must not renumber anything.**
     *
     * The distinction `notesStore.dropNote` documents at length, and it matters here for the same
     * reason: the renumbering below writes the destination's whole list from the order that is *on
     * screen*, which is only the user's arrangement while the sort is `manual`. Run it for a filing
     * drop made while sorting by title and the folder's hand-made order is overwritten with an
     * alphabetical one — silently, with the view still showing titles, so nothing appears to have
     * happened at all. `move_diagram` already appends the arriving row correctly and touches no
     * sibling, so filing has nothing to gain from the reorder and everything to lose.
     */
    if (!anchor) {
      if (changedFolder) await get().moveDiagram(id, folderId);
      return;
    }

    /**
     * The destination's whole list, **unfiltered and in the order it is shown right now**.
     *
     * Unfiltered because a search hides rows without moving them: reordering the four diagrams a
     * query left on screen must not renumber the folder as if the other thirty had gone away. In
     * today's order rather than in `sort_order`, because what the user means by dropping here is
     * "put it there, in *this* list" — which is only defensible because an anchored drop is an
     * explicit request for a position. See the guard above for why the unanchored one is not.
     */
    const current = filterDiagrams(state.diagrams, {
      query: "",
      tagFilter: [],
      folderId,
      sort: state.sort,
    });
    const siblings = current.filter((d) => d.id !== id);

    const at = siblings.findIndex((d) => d.id === anchor.id);
    const insertAt = at < 0 ? siblings.length : anchor.after ? at + 1 : at;
    const next = [...siblings.slice(0, insertAt), moving, ...siblings.slice(insertAt)];
    const positions = new Map(next.map((diagram, index) => [diagram.id, index]));

    // Nothing to write: dropped back where it already was. Compared against the *result* rather
    // than against the target, because "before the row below me" and "after the row above me" are
    // both ways of spelling the place a row is already in.
    if (!changedFolder && next.every((diagram, index) => current[index]?.id === diagram.id)) return;

    // Optimistic and in one `set`, so the row never blinks through an intermediate list.
    set({
      diagrams: state.diagrams.map((diagram) => {
        const position = positions.get(diagram.id);
        if (position === undefined) return diagram;
        if (diagram.id === id) return { ...diagram, folder_id: folderId, sort_order: position };
        return diagram.sort_order === position ? diagram : { ...diagram, sort_order: position };
      }),
    });
    // An arrangement that isn't the ordering on screen is an arrangement nobody can see. Reached
    // only from the anchored path, because filing a diagram is not a request to stop sorting by
    // title.
    if (state.sort !== "manual") get().setSort("manual");
    if (folderId) get().expandFolder(folderId);

    try {
      // The move first: `diagrams_reorder_diagrams` writes positions, and the other order would
      // leave a window in which the row is numbered against a folder it has not joined yet.
      if (changedFolder) {
        const row = await diagramsMoveDiagram(id, folderId);
        if (!row) {
          set((current) => ({ diagrams: current.diagrams.filter((d) => d.id !== id) }));
          return;
        }
      }
      await diagramsReorderDiagrams(next.map((diagram) => diagram.id));
    } catch (error) {
      pushErrorToast(String(error));
      // The optimistic list is now a guess about a write that failed. Re-read rather than unwound:
      // the drop touched every sibling's position, and the database is the shorter way back.
      void get().refresh();
    }
  },

  createFolder: async (parentId, name) => {
    const workspaceId = get().workspaceId;
    if (!workspaceId) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    try {
      const row = await diagramsCreateFolder(workspaceId, parentId, trimmed, "");
      set((state) => ({ folders: [...state.folders, row] }));
      if (parentId) get().expandFolder(parentId);
      return row.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  renameFolder: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await diagramsRenameFolder(id, trimmed);
      set((state) => ({
        folders: state.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f)),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  setFolderColor: async (id, color) => {
    // Optimistic: a colour swatch that lags behind the click reads as a broken picker.
    const previous = get().folders.find((f) => f.id === id)?.color ?? "";
    set((state) => ({ folders: state.folders.map((f) => (f.id === id ? { ...f, color } : f)) }));
    await diagramsSetFolderColor(id, color).catch((error: unknown) => {
      pushErrorToast(String(error));
      set((state) => ({
        folders: state.folders.map((f) => (f.id === id ? { ...f, color: previous } : f)),
      }));
    });
  },

  moveFolder: async (id, parentId) => {
    const folder = get().folders.find((f) => f.id === id);
    if (!folder || folder.parent_id === parentId) return;
    // Checked here as well as in Rust, and not instead of it: this one stops the optimistic write
    // from ever drawing an impossible tree, while the backend's is what holds against a second
    // window. Neither makes the other redundant.
    if (parentId && descendantIds(get().folders, id).has(parentId)) return;
    try {
      const moved = await diagramsMoveFolder(id, parentId);
      if (!moved) return;
      set((state) => ({
        folders: state.folders.map((f) => (f.id === id ? { ...f, parent_id: parentId } : f)),
      }));
      if (parentId) get().expandFolder(parentId);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  dropFolder: async (id, parentId, anchor) => {
    const state = get();
    const moving = state.folders.find((f) => f.id === id);
    if (!moving || anchor?.id === id) return;
    // A folder cannot become its own descendant. Refused silently: the highlight already declined
    // to draw, so the user has had their answer.
    if (parentId && descendantIds(state.folders, id).has(parentId)) return;
    const changedParent = moving.parent_id !== parentId;

    if (!anchor) {
      if (changedParent) await get().moveFolder(id, parentId);
      return;
    }

    const current = state.folders
      .filter((f) => f.parent_id === parentId)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    const siblings = current.filter((f) => f.id !== id);

    const at = siblings.findIndex((f) => f.id === anchor.id);
    const insertAt = at < 0 ? siblings.length : anchor.after ? at + 1 : at;
    const next = [...siblings.slice(0, insertAt), moving, ...siblings.slice(insertAt)];
    const positions = new Map(next.map((folder, index) => [folder.id, index]));

    if (!changedParent && next.every((folder, index) => current[index]?.id === folder.id)) return;

    set({
      folders: state.folders.map((folder) => {
        const position = positions.get(folder.id);
        if (position === undefined) return folder;
        if (folder.id === id) return { ...folder, parent_id: parentId, sort_order: position };
        return folder.sort_order === position ? folder : { ...folder, sort_order: position };
      }),
    });
    if (parentId) get().expandFolder(parentId);

    try {
      if (changedParent) {
        const moved = await diagramsMoveFolder(id, parentId);
        // Refused by the backend against a tree this window hasn't seen yet. Re-read, because the
        // optimistic reparent above is now wrong.
        if (!moved) {
          void get().refresh();
          return;
        }
      }
      await diagramsReorderFolders(next.map((folder) => folder.id));
    } catch (error) {
      pushErrorToast(String(error));
      void get().refresh();
    }
  },

  deleteFolder: async (id) => {
    const doomed = descendantIds(get().folders, id);
    stopDiagramAiRuns(
      get().aiByDiagram,
      get()
        .diagrams.filter((d) => d.folder_id !== null && doomed.has(d.folder_id))
        .map((d) => d.id),
    );
    try {
      await diagramsDeleteFolder(id);
      set((state) => {
        const diagrams = state.diagrams.filter(
          (d) => !(d.folder_id !== null && doomed.has(d.folder_id)),
        );
        const survives = (id: string | null) => id !== null && diagrams.some((d) => d.id === id);
        return {
          folders: state.folders.filter((f) => !doomed.has(f.id)),
          diagrams,
          // The open diagram may have been inside what was just deleted.
          activeId: survives(state.activeId) ? state.activeId : null,
          draft: survives(state.draft?.id ?? null) ? state.draft : null,
          // The same reasoning as `deleteDiagram`'s, applied to everything the folder took with it.
          aiByDiagram: Object.fromEntries(
            Object.entries(state.aiByDiagram).filter(([diagramId]) => survives(diagramId)),
          ),
          folderFilter: doomed.has(state.folderFilter ?? "") ? null : state.folderFilter,
          expanded: state.expanded.filter((f) => !doomed.has(f)),
        };
      });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },
}));

/** Loads the active workspace's tree, if there is one. Called from the view's mount. */
export function ensureDiagramsStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return Promise.resolve();
  return useDiagramsStore.getState().setWorkspace(workspaceId);
}

/**
 * A diagram belongs to the workspace it was drawn in, so switching workspace swaps the whole board.
 *
 * This is the line that was missing. Every other workspace-scoped store had one — `apiStore`,
 * `dbStore`, `remoteStore` and `notesStore` through `App`'s switch effect, `docsStore` and
 * `chainStore` through a subscription like this one — and Diagrams, added last, had neither. The
 * result was not a stale list you could refresh away: `createDiagram` and `createFolder` send
 * `get().workspaceId` to the backend, so with the store still pointing at the workspace it was
 * first opened in, every drawing made after a switch was *written* to that first workspace. It then
 * showed up in whichever workspace you happened to be in, because the store never reloaded — which
 * is what "the diagrams are global" looks like from the outside.
 *
 * Here rather than in `App`, for the reason `notesStore`'s copy of this comment gives: a rule kept
 * in `App` is a rule the next store can be shipped without.
 *
 * The guard keeps the load lazy — a store that has never hydrated has nothing to show from the
 * wrong workspace, and switching it here would pull the draw.io bundle in behind a workspace change
 * the user made for some other reason.
 */
useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId === previous.activeWorkspaceId) return;
  const { workspaceId, loading } = useDiagramsStore.getState();
  if (workspaceId === null && !loading) return;
  void useDiagramsStore.getState().setWorkspace(state.activeWorkspaceId);
});

/**
 * The diagrams the list should show, filtered and ordered.
 *
 * A plain function over the store's own arrays rather than a selector, because it takes the
 * caller's `folderId` — the sidebar tree wants the whole workspace's surviving diagrams so it can
 * place them under their folders, while the gallery wants one folder's. Both want the same filter
 * and the same sort, and having two of either is how they drift apart.
 *
 * Callers memoise it on the inputs it reads.
 */
export function filterDiagrams(
  diagrams: Diagram[],
  options: {
    query: string;
    tagFilter: string[];
    /** Omit to search every folder; pass `null` for the root specifically. */
    folderId?: string | null;
    sort: DiagramSort;
  },
): Diagram[] {
  const needle = options.query.trim().toLowerCase();
  const filtered = diagrams.filter((diagram) => {
    if (options.folderId !== undefined && diagram.folder_id !== options.folderId) return false;
    // AND across tags — see `tagFilter`'s comment.
    if (options.tagFilter.some((tag) => !diagram.tags.includes(tag))) return false;
    if (!needle) return true;
    return (
      diagram.title.toLowerCase().includes(needle) ||
      diagram.tags.some((tag) => tag.includes(needle))
    );
  });

  // Pinned first in every ordering, `manual` included. A pin is a statement about importance, and
  // an ordering that buries a pinned diagram under a freshly-touched one ignores it.
  return filtered.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    switch (options.sort) {
      case "manual":
        // Ties are real: a diagram whose folder was deleted keeps the position it held inside it
        // (see the table's `ON DELETE SET NULL`), so two can arrive at the root sharing a number.
        // Creation order breaks them, which is the order they were appended in to begin with.
        return a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);
      case "created":
        return b.created_at.localeCompare(a.created_at);
      case "title":
        return (a.title || "").localeCompare(b.title || "");
      default:
        return b.updated_at.localeCompare(a.updated_at);
    }
  });
}
