import { create } from "zustand";
import {
  notesCreateBook,
  notesCreateNote,
  notesCreateTemplate,
  notesDeleteBook,
  notesDeleteNote,
  notesDeleteTemplate,
  notesDuplicateNote,
  notesGetNote,
  notesLoadTree,
  notesMoveBook,
  notesMoveNote,
  notesRenameBook,
  notesReorderBooks,
  notesReorderNotes,
  notesSaveNote,
  notesSearch,
  notesSetBookColor,
  notesSetPinned,
  notesUpdateTemplate,
} from "../lib/tauri/notesCommands";
import { serializeTags, parseTags } from "../lib/notes/tags";
import { toTemplate } from "../lib/notes/templates";
import { descendantIds } from "../lib/notes/tree";
import { translate } from "./languageStore";
import { pushErrorToast } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";
import type {
  Note,
  NoteDraft,
  NoteBookRow,
  NoteGalleryView,
  NoteMetaRow,
  NoteSearchHit,
  NoteSort,
  NoteTemplate,
  NoteTemplateRow,
  NoteViewMode,
} from "../types/notes";

/**
 * The Notes workspace's state.
 *
 * Scoped per workspace like `remoteStore` and `dbStore`, for the plainest reason of the three: a
 * note is writing *about* the work — a decision, a runbook, a meeting — and none of it stops being
 * relevant when you click a different repository.
 *
 * Four things are worth knowing before reading it.
 *
 * 1. **`notes` holds no bodies.** It is `NoteMeta`: title, excerpt, tags, counts. The workspace's
 *    entire note list lives here at once, which is only affordable *because* the bodies don't.
 *    Bodies arrive one at a time through `openNote` and live in `bodies`, which is capped. This is
 *    the frontend half of the rule `db/note_queries.rs` states; breaking either half breaks it.
 *
 * 2. **The editor writes to `draft`, not to `notes`.** A keystroke updates one small object; a
 *    debounce later, `flush` writes it to SQLite and folds the returned metadata back into
 *    `notes`. Typing therefore costs a `set` on a four-field object rather than a rewrite of a
 *    four-hundred-element array, and "unsaved" is a fact the status bar can state rather than
 *    guess.
 *
 * 3. **Search is two searches.** Titles and tags are filtered here, synchronously, on the
 *    keystroke — the metadata is already in memory, so there is nothing to wait for. Bodies are
 *    searched in SQLite behind a debounce, because they are the one thing this store does not
 *    hold. `bodyHits` is that second answer arriving late, and `visibleNotes` unions the two.
 *
 * 4. **Filing and writing are different acts.** Moving a note between books deliberately does
 *    not touch `updated_at` (see `note_queries::move_note`), so an afternoon of tidying doesn't
 *    read as an afternoon of writing in the "recent" ordering.
 *
 * 5. **The list's order is the user's, not the clock's.** `sort` defaults to `"manual"`, which is
 *    the `sort_order` column and is written by exactly one thing: a drag. The four other orderings
 *    are still there to switch to, but none of them can be the default, because the most obvious
 *    candidate — last edited — reorders itself *while you are typing*: every autosave lifts the
 *    open note over the others and the sidebar you were reading rearranges under the cursor. See
 *    `dropNote`.
 */

/** How long after the last keystroke the draft is written. Long enough that a sentence is one
 *  write, short enough that a user who alt-tabs away mid-thought has already been saved. */
const AUTOSAVE_MS = 800;

/** How long after the last keystroke the *body* search runs. Longer than the autosave because it
 *  is a table scan and its answer is additive — the title matches are already on screen. */
const SEARCH_DEBOUNCE_MS = 220;

/**
 * How many note bodies are kept in memory at once.
 *
 * A bound rather than a policy for its own sake: without one, a session spent reading through a
 * large workspace ends with every note's body resident, which is precisely the state the whole
 * metadata/body split exists to avoid. Thirty is far more than the handful anyone moves between in
 * a sitting, and the eviction is least-recently-opened.
 */
const BODY_CACHE_LIMIT = 30;

/**
 * How many times `flush` will re-read the draft and write again before giving up.
 *
 * Each pass exists to catch an edit typed during the previous pass's round trip. Two would cover
 * any realistic case; four is the bound that makes "a very fast typist during a very slow write"
 * still terminate rather than loop, and the draft stays dirty afterwards so the next debounce
 * finishes the job.
 */
const MAX_FLUSH_PASSES = 4;

/**
 * Where the per-workspace preferences live.
 *
 * `app_settings` in the database, through `getSetting`/`setSetting` — **not** `localStorage`, which
 * was the first thing this reached for and was wrong for two reasons. `remoteStore` sets the
 * precedent (see `loadCollapsed` there), and following it is not merely tidiness: `app_settings` is
 * in `snapshot::CORE_TABLES`, so these travel with a backup and land on the restored machine.
 * An open-book arrangement built up over months is exactly the kind of small thing whose loss
 * on a reinstall is annoying out of proportion to its size.
 *
 * The writes are fire-and-forget. A preference that fails to persist is worth no toast — the
 * setting is already applied on screen, and the cost of the failure is re-making it next launch.
 */
/**
 * The books the user has opened — **not** the ones they closed, which is what this used to store.
 *
 * The inversion is the whole point: a tree whose default is "closed" cannot be expressed as a list
 * of exceptions to "open". A workspace of thirty books that all unfold on first launch is a wall of
 * note titles with the books lost inside it; closed, it is a shelf, and opening one is the gesture
 * that says which one you are working in.
 *
 * A different settings key from the old `notes_collapsed_books:*`, deliberately: the stored value
 * means the opposite now, and reading the old one under the new meaning would open exactly the
 * books the user had shut.
 */
const expandedKey = (workspaceId: string) => `notes_expanded_books:${workspaceId}`;
const viewKey = (workspaceId: string) => `notes_view_mode:${workspaceId}`;
const sortKey = (workspaceId: string) => `notes_sort:${workspaceId}`;
const galleryViewKey = (workspaceId: string) => `notes_gallery_view:${workspaceId}`;

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
function toNote(row: NoteMetaRow): Note {
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

interface NotesState {
  workspaceId: string | null;
  loading: boolean;

  notes: Note[];
  books: NoteBookRow[];
  templates: NoteTemplate[];

  /** The open note, or `null` for the gallery. */
  activeId: string | null;
  /** What the editor is editing. `null` while a body is still in flight. */
  draft: NoteDraft | null;
  /** Bodies by note id, capped at `BODY_CACHE_LIMIT`. See the header. */
  bodies: Record<string, string>;
  /** Note ids in the order they were last opened, oldest first — the cache's eviction order. */
  bodyOrder: string[];
  /** A body is being fetched. Distinct from `loading`, which is the whole workspace. */
  openingId: string | null;
  /** A save is in flight. Shown, because a note is a document and "did that save?" is a fair
   *  question to be able to answer without opening it again. */
  saving: boolean;
  /** When the open note was last written, ISO. `null` before the first save of a session. */
  savedAt: string | null;

  /** Filter over the whole workspace. Session state — a search is something you are doing. */
  query: string;
  /** Notes whose *body* matched `query`, by id. The backend's half of the search. */
  bodyHits: Record<string, NoteSearchHit>;
  /** Tags a note must carry to show, ANDed. AND rather than OR because picking two tags is
   *  narrowing; the search box is already the "either" tool. */
  tagFilter: string[];
  /** The book the gallery is showing the inside of. `null` is the shelf — the books themselves. */
  bookFilter: string | null;
  sort: NoteSort;

  /** Book ids the user has opened. Persisted, and closed is the default — see `expandedKey`. */
  expanded: string[];
  /** How the editor splits its space. Persisted for the same reason. */
  viewMode: NoteViewMode;
  /** Cards or rows, in the gallery. Persisted for the same reason. */
  galleryView: NoteGalleryView;
  /** The outline panel's visibility. */
  outlineOpen: boolean;

  setWorkspace: (workspaceId: string) => Promise<void>;
  refresh: () => Promise<void>;

  setQuery: (query: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  setBookFilter: (bookId: string | null) => void;
  setSort: (sort: NoteSort) => void;
  setViewMode: (mode: NoteViewMode) => void;
  setGalleryView: (view: NoteGalleryView) => void;
  toggleOutline: () => void;
  toggleBook: (bookId: string) => void;
  expandBook: (bookId: string) => void;

  openNote: (id: string) => Promise<void>;
  closeNote: () => Promise<void>;
  /** Edits the open note. The only write path the editor uses. */
  editDraft: (patch: Partial<Pick<NoteDraft, "title" | "content" | "tags">>) => void;
  /** Writes the draft now, if it is dirty. Called on close, on switch, and on the debounce. */
  flush: () => Promise<void>;

  /**
   * Writes a new note into `bookId`.
   *
   * `null` means "wherever is sensible", not "nowhere": `resolveBook` picks the book the gallery is
   * showing, else the first one, and makes one if the workspace has none. Every note has a book —
   * see `db/note_queries.rs::create_note` — so the alternative to choosing one here would be a
   * dialog in front of the fastest action in the app.
   */
  createNote: (bookId: string | null, template?: NoteTemplate) => Promise<string | null>;
  deleteNote: (id: string) => Promise<void>;
  duplicateNote: (id: string) => Promise<string | null>;
  togglePinned: (id: string) => Promise<void>;
  moveNote: (id: string, bookId: string) => Promise<void>;
  /**
   * What a drop on a note does: file it into `bookId`, and place it next to `anchor` in that book.
   *
   * One action rather than a move followed by a reorder from the UI, because the two writes have to
   * agree — a note that changed book and was then ordered against the *old* book's list would land
   * somewhere nobody dropped it. `anchor` of `null` is "no particular place": appended, which is
   * what a drop across the middle of a book row means and what filing has always done.
   */
  dropNote: (
    id: string,
    bookId: string,
    anchor: { id: string; after: boolean } | null,
  ) => Promise<void>;

  createBook: (parentId: string | null, name: string) => Promise<string | null>;
  renameBook: (id: string, name: string) => Promise<void>;
  setBookColor: (id: string, color: string) => Promise<void>;
  moveBook: (id: string, parentId: string | null) => Promise<void>;
  /** The books' half of `dropNote`. Refuses, silently, to put a book inside its own subtree. */
  dropBook: (
    id: string,
    parentId: string | null,
    anchor: { id: string; after: boolean } | null,
  ) => Promise<void>;
  /** Deletes the book, its subbooks **and every note inside them**. Confirm before calling. */
  deleteBook: (id: string) => Promise<void>;

  /** Saves a template from explicit content, so both callers — "save this note as a template" and
   *  "duplicate a built-in into mine" — go through one action rather than two shapes of the same
   *  write. */
  createTemplate: (
    name: string,
    description: string,
    icon: string,
    content: string,
    tags: string[],
  ) => Promise<void>;
  updateTemplate: (row: NoteTemplateRow) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
}

/** The pending autosave, if any. Outside the store: a timer is not state anything renders. */
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * The write currently in progress, so a second `flush()` joins it instead of racing it.
 *
 * Outside the store for the same reason the timer is: nothing renders from it. It matters because
 * `flush` is called from four places — the debounce, `openNote`, `closeNote` and the view's
 * unmount — and two of them can easily fire in the same tick.
 */
let pendingFlush: Promise<void> | null = null;
/** The pending body search. Same reasoning. */
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** In-flight `setWorkspace`, so two mounts in the same tick don't both load the tree. */
let pendingLoad: { workspaceId: string; promise: Promise<void> } | null = null;
/**
 * The search whose answer is still welcome.
 *
 * A body search is a table scan behind a debounce, so a slow one can land after the user has typed
 * on and a *newer* one has already answered. Without this, that stale result would replace the
 * fresh one and the panel would show hits for a query nobody has on screen.
 */
let searchToken = 0;

export const useNotesStore = create<NotesState>((set, get) => ({
  workspaceId: null,
  loading: false,
  notes: [],
  books: [],
  templates: [],
  activeId: null,
  draft: null,
  bodies: {},
  bodyOrder: [],
  openingId: null,
  saving: false,
  savedAt: null,
  query: "",
  bodyHits: {},
  tagFilter: [],
  bookFilter: null,
  sort: "manual",
  expanded: [],
  viewMode: "split",
  galleryView: "grid",
  outlineOpen: false,

  setWorkspace: async (workspaceId) => {
    if (pendingLoad?.workspaceId === workspaceId) return pendingLoad.promise;
    if (get().workspaceId === workspaceId && !get().loading) return;

    // The outgoing workspace's unsaved draft, written before anything is dropped. A note is a
    // document: losing the last sentence to a workspace switch is data loss, not a stale cache.
    await get().flush();

    // Any body search still pending against the *outgoing* workspace. Without both lines a
    // debounced search fires after the switch, reads the new `workspaceId` at call time, and scans
    // the wrong workspace for a query the user cleared — and `searchToken` would still match, so
    // the hits would be accepted.
    if (searchTimer) clearTimeout(searchTimer);
    searchToken++;

    const promise = (async () => {
      set({
        workspaceId,
        loading: true,
        // Cleared eagerly rather than on arrival, so a switch never shows the previous
        // workspace's notes under the new workspace's name.
        notes: [],
        books: [],
        templates: [],
        activeId: null,
        draft: null,
        bodies: {},
        bodyOrder: [],
        savedAt: null,
        query: "",
        bodyHits: {},
        tagFilter: [],
        bookFilter: null,
        // Reset to the defaults first; the stored values arrive with the tree below. Without this
        // the incoming workspace briefly wears the outgoing one's view mode.
        expanded: [],
        viewMode: "split",
        galleryView: "grid",
        sort: "manual",
      });
      try {
        // In parallel with the tree rather than before it: four settings reads and one tree read
        // are independent, and serialising them would put three extra round trips in front of the
        // first paint.
        const [tree, expanded, viewMode, galleryView, sort] = await Promise.all([
          notesLoadTree(workspaceId),
          loadPref(expandedKey(workspaceId)),
          loadPref(viewKey(workspaceId)),
          loadPref(galleryViewKey(workspaceId)),
          loadPref(sortKey(workspaceId)),
        ]);
        // The user may have switched again while all that was in flight.
        if (get().workspaceId !== workspaceId) return;
        set({
          notes: tree.notes.map(toNote),
          books: tree.books,
          templates: tree.templates.map(toTemplate),
          expanded: parseList(expanded),
          viewMode: (viewMode as NoteViewMode | null) ?? "split",
          galleryView: galleryView === "list" ? "list" : "grid",
          sort: (sort as NoteSort | null) ?? "manual",
        });
      } catch (error) {
        pushErrorToast(String(error));
      } finally {
        set({ loading: false });
      }
    })();

    pendingLoad = { workspaceId, promise };
    try {
      await promise;
    } finally {
      if (pendingLoad?.workspaceId === workspaceId) pendingLoad = null;
    }
  },

  refresh: async () => {
    const { workspaceId } = get();
    if (!workspaceId) return;
    try {
      const tree = await notesLoadTree(workspaceId);
      set({
        notes: tree.notes.map(toNote),
        books: tree.books,
        templates: tree.templates.map(toTemplate),
      });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  // ---------- filters ----------

  setQuery: (query) => {
    set({ query });
    if (searchTimer) clearTimeout(searchTimer);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      // One character matches most bodies in a workspace, which is a scan whose answer is noise.
      // The title/tag filter still runs — it is synchronous and reads what is already here.
      searchToken++;
      set({ bodyHits: {} });
      return;
    }
    const token = ++searchToken;
    searchTimer = setTimeout(() => {
      const { workspaceId } = get();
      if (!workspaceId) return;
      void notesSearch(workspaceId, trimmed)
        .then((hits) => {
          if (token !== searchToken) return;
          set({ bodyHits: Object.fromEntries(hits.map((hit) => [hit.id, hit])) });
        })
        // Silent: a failed body search leaves the title matches on screen, which is a degraded
        // answer rather than a broken one, and a toast per keystroke would be worse than the miss.
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
  },

  toggleTag: (tag) =>
    set((state) => ({
      tagFilter: state.tagFilter.includes(tag)
        ? state.tagFilter.filter((t) => t !== tag)
        : [...state.tagFilter, tag],
    })),

  clearTags: () => set({ tagFilter: [] }),
  setBookFilter: (bookId) => set({ bookFilter: bookId }),

  setSort: (sort) => {
    const { workspaceId } = get();
    if (workspaceId) void savePref(sortKey(workspaceId), sort);
    set({ sort });
  },

  setViewMode: (mode) => {
    const { workspaceId } = get();
    if (workspaceId) void savePref(viewKey(workspaceId), mode);
    set({ viewMode: mode });
  },

  setGalleryView: (view) => {
    const { workspaceId } = get();
    if (workspaceId) void savePref(galleryViewKey(workspaceId), view);
    set({ galleryView: view });
  },

  toggleOutline: () => set((state) => ({ outlineOpen: !state.outlineOpen })),

  toggleBook: (bookId) => {
    const { workspaceId, expanded } = get();
    const next = expanded.includes(bookId)
      ? expanded.filter((id) => id !== bookId)
      : [...expanded, bookId];
    if (workspaceId) void savePref(expandedKey(workspaceId), JSON.stringify(next));
    set({ expanded: next });
  },

  expandBook: (bookId) => {
    const { workspaceId, expanded } = get();
    if (expanded.includes(bookId)) return;
    const next = [...expanded, bookId];
    if (workspaceId) void savePref(expandedKey(workspaceId), JSON.stringify(next));
    set({ expanded: next });
  },

  // ---------- the open note ----------

  openNote: async (id) => {
    if (get().activeId === id) return;
    // The outgoing note first, and awaited: opening B before A's last sentence has been written
    // would race the two saves.
    await get().flush();

    const cached = get().bodies[id];
    if (cached !== undefined) {
      set((state) => ({
        activeId: id,
        draft: draftFor(state.notes, id, cached),
        savedAt: null,
        bodyOrder: touch(state.bodyOrder, id),
      }));
      return;
    }

    set({ activeId: id, draft: null, openingId: id, savedAt: null });
    try {
      const row = await notesGetNote(id);
      // The user may have clicked on to a third note while this was in flight, or the note may
      // have been deleted from another window. Either way this answer is no longer the question.
      if (get().activeId !== id) return;
      if (!row) {
        set({ activeId: null, draft: null, notes: get().notes.filter((n) => n.id !== id) });
        return;
      }
      set((state) => ({
        draft: { id, title: row.title, content: row.content, tags: parseTags(row.tags), dirty: false },
        ...cacheBody(state, id, row.content),
      }));
    } catch (error) {
      pushErrorToast(String(error));
      set({ activeId: null, draft: null });
    } finally {
      if (get().openingId === id) set({ openingId: null });
    }
  },

  closeNote: async () => {
    await get().flush();
    set({ activeId: null, draft: null, savedAt: null });
  },

  editDraft: (patch) => {
    const { draft } = get();
    if (!draft) return;
    set({ draft: { ...draft, ...patch, dirty: true } });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().flush(), AUTOSAVE_MS);
  },

  flush: async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    // A second caller joins the write already under way rather than starting a parallel one. Two
    // concurrent `notes_save_note` calls for the same row would be a last-writer-wins race over
    // the same content, and the loop below already guarantees the newest draft is the one that
    // ends up written — so joining is both safer and less work.
    if (pendingFlush) return pendingFlush;

    const run = (async () => {
      // **A loop, not a single write, and this is the whole point of the function.**
      //
      // Every caller that awaits `flush()` goes on to *replace* the draft — `openNote` swaps in
      // the next note's, `setWorkspace` clears it. A keystroke landing during the round trip
      // re-dirties the draft behind the await, so a single-shot flush would resolve, the caller
      // would drop that edit, and it would never have reached SQLite. One extra pass costs a
      // round trip nobody waits on; not having it loses the last thing the user typed.
      for (let pass = 0; pass < MAX_FLUSH_PASSES; pass++) {
        const draft = get().draft;
        if (!draft?.dirty) return;

        // Marked clean *before* the await, so a keystroke arriving mid-save sets it again and the
        // next pass picks that up. Clearing it afterwards would swallow exactly that edit.
        set({ draft: { ...draft, dirty: false }, saving: true });
        try {
          const saved = await notesSaveNote(
            draft.id,
            draft.title,
            draft.content,
            serializeTags(draft.tags),
          );
          if (!saved) {
            // Deleted from elsewhere while it was being edited. The editor closes rather than
            // re-creating a row the user removed.
            set((state) => ({
              notes: state.notes.filter((n) => n.id !== draft.id),
              activeId: state.activeId === draft.id ? null : state.activeId,
              draft: state.draft?.id === draft.id ? null : state.draft,
            }));
            return;
          }
          const note = toNote(saved);
          set((state) => ({
            // **Only the fields this save owns.** `save_note` re-reads the whole row, so `saved`
            // also carries `pinned` and `book_id` as they were when *it* ran — and a pin or a
            // drag issued while this write was in flight would be rolled back on screen while the
            // database kept it. Merging the five columns the save actually wrote leaves the
            // optimistic ones alone.
            notes: state.notes.map((existing) =>
              existing.id === note.id
                ? {
                    ...existing,
                    title: note.title,
                    excerpt: note.excerpt,
                    tags: note.tags,
                    word_count: note.word_count,
                    updated_at: note.updated_at,
                  }
                : existing,
            ),
            savedAt: note.updated_at,
            ...cacheBody(state, draft.id, draft.content),
          }));
        } catch (error) {
          // Put back, so the next debounce or the next close tries again rather than losing the
          // edit — but only if the note that failed is still the one open. Marking `state.draft`
          // blindly would flag a *different* note as unsaved when the user had already moved on,
          // and the next flush would rewrite a note nobody edited.
          set((state) =>
            state.draft?.id === draft.id ? { draft: { ...state.draft, dirty: true } } : {},
          );
          pushErrorToast(String(error));
          // Not retried in this loop: a failing backend would spin here, and the user has been
          // told. The next debounce or the next close is the retry.
          return;
        } finally {
          set({ saving: false });
        }
      }
    })();

    pendingFlush = run;
    try {
      await run;
    } finally {
      if (pendingFlush === run) pendingFlush = null;
    }
  },

  // ---------- notes ----------

  createNote: async (bookId, template) => {
    const { workspaceId } = get();
    if (!workspaceId) return null;
    await get().flush();
    const title = template ? template.name : translate("notes.untitled");
    const content = template?.content ?? "";
    const tags = template?.tags ?? [];
    try {
      const book = bookId ?? (await resolveBook(get, translate("notes.defaultBook")));
      if (!book) return null;
      const row = await notesCreateNote(workspaceId, book, title, content, serializeTags(tags));
      const note = toNote(row);
      set((state) => ({
        notes: [note, ...state.notes],
        activeId: note.id,
        draft: { id: note.id, title, content, tags: note.tags, dirty: false },
        savedAt: note.updated_at,
        ...cacheBody(state, note.id, content),
      }));
      // A note created into a closed book must be visible, or the button appears to do nothing
      // at all — which, with books closed by default, is now the ordinary case rather than a
      // corner of it.
      get().expandBook(book);
      return note.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  deleteNote: async (id) => {
    try {
      await notesDeleteNote(id);
      set((state) => {
        const bodies = { ...state.bodies };
        delete bodies[id];
        return {
          notes: state.notes.filter((n) => n.id !== id),
          bodies,
          bodyOrder: state.bodyOrder.filter((bodyId) => bodyId !== id),
          activeId: state.activeId === id ? null : state.activeId,
          // Dropped without flushing: the row is gone, so writing the draft would either fail or
          // — worse — be the one thing that could bring it back.
          draft: state.draft?.id === id ? null : state.draft,
        };
      });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  duplicateNote: async (id) => {
    // The copy is made from the row, so any unsaved edit has to be in it first.
    if (get().draft?.id === id) await get().flush();
    const source = get().notes.find((n) => n.id === id);
    if (!source) return null;
    try {
      const row = await notesDuplicateNote(
        id,
        translate("notes.copyOf", { name: source.title || translate("notes.untitled") }),
      );
      if (!row) return null;
      const note = toNote(row);
      set((state) => ({ notes: [note, ...state.notes] }));
      // **Placed next to the original, not at the end of the book.** `duplicate_note` appends,
      // which under the hand-made order puts the copy at the bottom of a list that may be long and
      // a book that may be shut — so the one action whose whole point is "another one of these"
      // was the one action with nothing to show for it. Best-effort and silent: a copy that exists
      // but sits in the wrong place is not worth a toast, and the row is there either way.
      void placeAfter(get, set, note, source);
      if (note.book_id) get().expandBook(note.book_id);
      return note.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  togglePinned: async (id) => {
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    const pinned = !note.pinned;
    // Optimistic: a pin is one boolean and the row is on screen under the cursor, so waiting a
    // round trip to redraw the icon is the only thing the user would notice.
    set((state) => ({
      notes: state.notes.map((n) => (n.id === id ? { ...n, pinned } : n)),
    }));
    try {
      await notesSetPinned(id, pinned);
    } catch (error) {
      set((state) => ({
        notes: state.notes.map((n) => (n.id === id ? { ...n, pinned: !pinned } : n)),
      }));
      pushErrorToast(String(error));
    }
  },

  moveNote: async (id, bookId) => {
    try {
      const row = await notesMoveNote(id, bookId);
      if (!row) {
        set((state) => ({ notes: state.notes.filter((n) => n.id !== id) }));
        return;
      }
      const note = toNote(row);
      set((state) => ({ notes: state.notes.map((n) => (n.id === id ? note : n)) }));
      get().expandBook(bookId);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  dropNote: async (id, bookId, anchor) => {
    const state = get();
    const moving = state.notes.find((n) => n.id === id);
    // Dropped on its own edge: the gesture has an obvious meaning and it is "nothing". Guarded
    // here rather than in the caller so no drop path can miss it — the note is about to be pulled
    // out of `siblings`, and an anchor that went with it would silently become "append".
    if (!moving || anchor?.id === id) return;
    const changedBook = moving.book_id !== bookId;

    /**
     * **A drop with no anchor is a move, and must not renumber anything.**
     *
     * This is the difference between "put it in that book" and "put it there", and conflating them
     * loses data. The renumbering below writes the destination's whole list from the order that is
     * *on screen* — which is only the user's arrangement while the sort is `manual`. Run it for a
     * filing drop made while sorting by title, and the book's hand-made order is overwritten with
     * an alphabetical one, silently, with the view still showing titles so nothing appears to
     * happen at all. `move_note` already appends the arriving note correctly and touches no
     * sibling, so filing has nothing to gain from the reorder and everything to lose.
     *
     * And a filing drop onto the book a note is already in is simply nothing — the old
     * `fromBookId === target` guard, restored where no drop path can miss it.
     */
    if (!anchor) {
      if (changedBook) await get().moveNote(id, bookId);
      return;
    }

    /**
     * The destination book's whole list, **unfiltered and in the order it is shown right now**.
     *
     * Unfiltered because a search hides rows without moving them: reordering the four notes a
     * query left on screen must not renumber the book as if the other thirty had gone away. In
     * today's order rather than in `sort_order`, because the user may be looking at the list by
     * title or by length — and what they mean by dropping here is "put it there, in *this* list".
     * Writing the positions from what they saw is what makes the switch to `manual` below keep the
     * arrangement they were looking at, with the one note moved. That is only defensible because
     * an anchored drop is an explicit request for a position; see the guard above for why the
     * unanchored one is not.
     */
    const current = filterNotes(state.notes, {
      query: "",
      bodyHits: {},
      tagFilter: [],
      bookId,
      sort: state.sort,
    });
    const siblings = current.filter((n) => n.id !== id);

    const at = siblings.findIndex((n) => n.id === anchor.id);
    const insertAt = at < 0 ? siblings.length : anchor.after ? at + 1 : at;
    const next = [...siblings.slice(0, insertAt), moving, ...siblings.slice(insertAt)];
    const positions = new Map(next.map((note, index) => [note.id, index]));

    // Nothing to write: dropped back where it already was. Compared against the *result* rather
    // than against the target, because "before the note below me" and "after the note above me"
    // are both ways of spelling the place a note is already in.
    if (!changedBook && next.every((note, index) => current[index]?.id === note.id)) return;

    // Optimistic and in one `set`, so the row never blinks through an intermediate list — the
    // reason `remoteStore.dropHost` does the same. Only `sort_order` and `book_id` are touched, so
    // a save in flight for any of these notes still folds its own five columns back in afterwards.
    set({
      notes: state.notes.map((note) => {
        const position = positions.get(note.id);
        if (position === undefined) return note;
        if (note.id === id) return { ...note, book_id: bookId, sort_order: position };
        return note.sort_order === position ? note : { ...note, sort_order: position };
      }),
    });
    // An arrangement that isn't the ordering on screen is an arrangement nobody can see. Reached
    // only from the anchored path, because filing a note into a book is not a request to stop
    // sorting by title.
    if (state.sort !== "manual") get().setSort("manual");
    get().expandBook(bookId);

    try {
      // The move first: `notes_reorder_notes` writes positions, and the other order would leave a
      // window in which the note is numbered against a book it has not joined yet.
      if (changedBook) {
        const row = await notesMoveNote(id, bookId);
        if (!row) {
          // Deleted from another window while it was being dragged.
          set((current) => ({ notes: current.notes.filter((n) => n.id !== id) }));
          return;
        }
      }
      await notesReorderNotes(next.map((note) => note.id));
    } catch (error) {
      pushErrorToast(String(error));
      // The optimistic list is now a guess about a write that failed. Re-read rather than unwound:
      // the drop touched every sibling's position, and the database is the shorter way back.
      void get().refresh();
    }
  },

  // ---------- books ----------

  createBook: async (parentId, name) => {
    const { workspaceId } = get();
    if (!workspaceId) return null;
    try {
      const row = await notesCreateBook(workspaceId, parentId, name, "");
      set((state) => ({ books: [...state.books, row] }));
      if (parentId) get().expandBook(parentId);
      return row.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  renameBook: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const previous = get().books;
    set({ books: previous.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) });
    try {
      await notesRenameBook(id, trimmed);
    } catch (error) {
      set({ books: previous });
      pushErrorToast(String(error));
    }
  },

  setBookColor: async (id, color) => {
    const previous = get().books;
    set({ books: previous.map((f) => (f.id === id ? { ...f, color } : f)) });
    try {
      await notesSetBookColor(id, color);
    } catch (error) {
      set({ books: previous });
      pushErrorToast(String(error));
    }
  },

  moveBook: async (id, parentId) => {
    try {
      const moved = await notesMoveBook(id, parentId);
      // `false` is the backend refusing to put a book inside its own subtree. Silent: the drag
      // simply doesn't land, which is what a rejected drop looks like everywhere else.
      if (!moved) return;
      set((state) => ({
        books: state.books.map((f) => (f.id === id ? { ...f, parent_id: parentId } : f)),
      }));
      if (parentId) get().expandBook(parentId);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  dropBook: async (id, parentId, anchor) => {
    const state = get();
    const moving = state.books.find((f) => f.id === id);
    if (!moving || anchor?.id === id) return;
    // A book inside its own subtree is a ring of rows that is unreachable from the root — the
    // backend refuses it too (`move_book` returns false), but refusing here means the drop simply
    // doesn't land instead of landing and being taken back.
    if (parentId && descendantIds(state.books, id).has(parentId)) return;
    const changedParent = moving.parent_id !== parentId;

    // A drop with no anchor is a move — and onto the parent it already has, it is nothing. Same
    // reasoning as `dropNote`'s: `move_book` appends the arriving book and touches no sibling, so
    // renumbering the destination would be a rewrite nobody asked for.
    if (!anchor) {
      if (changedParent) await get().moveBook(id, parentId);
      return;
    }

    // The destination's children in the order the tree draws them — `buildBookTree`'s ordering,
    // which is the only one books have.
    const current = state.books
      .filter((f) => f.parent_id === parentId)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    const siblings = current.filter((f) => f.id !== id);

    const at = siblings.findIndex((f) => f.id === anchor.id);
    const insertAt = at < 0 ? siblings.length : anchor.after ? at + 1 : at;
    const next = [...siblings.slice(0, insertAt), moving, ...siblings.slice(insertAt)];
    const positions = new Map(next.map((book, index) => [book.id, index]));

    if (!changedParent && next.every((book, index) => current[index]?.id === book.id)) return;

    set({
      books: state.books.map((book) => {
        const position = positions.get(book.id);
        if (position === undefined) return book;
        if (book.id === id) return { ...book, parent_id: parentId, sort_order: position };
        return book.sort_order === position ? book : { ...book, sort_order: position };
      }),
    });
    if (parentId) get().expandBook(parentId);

    try {
      if (changedParent) {
        // `false` is the backend refusing the same cycle the guard above catches. Reaching it means
        // this window's `books` disagreed with the database, so re-read rather than argue.
        if (!(await notesMoveBook(id, parentId))) {
          void get().refresh();
          return;
        }
      }
      await notesReorderBooks(next.map((book) => book.id));
    } catch (error) {
      pushErrorToast(String(error));
      void get().refresh();
    }
  },

  deleteBook: async (id) => {
    // Read before the delete: afterwards the rows are gone and there is no way to ask which books
    // were under this one.
    const doomed = descendantIds(get().books, id);
    try {
      await notesDeleteBook(id);
      // Everything written inside goes with it — there is nowhere for a note to survive to. Re-read
      // rather than patched locally, because working out which notes were in which descendant book
      // is exactly what the query just did.
      await get().refresh();
      set((state) => ({
        // The gallery may have been standing inside the book that just went, or inside one of its
        // subbooks. Either way it is now looking at a shelf that no longer has that book on it.
        bookFilter: state.bookFilter && doomed.has(state.bookFilter) ? null : state.bookFilter,
        // And the editor may have had one of the deleted notes open. `refresh` has already dropped
        // it from `notes`; this drops the draft that would otherwise be written back on the next
        // debounce and re-create a note the user deleted.
        activeId: state.notes.some((note) => note.id === state.activeId) ? state.activeId : null,
        draft: state.notes.some((note) => note.id === state.draft?.id) ? state.draft : null,
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  // ---------- templates ----------

  createTemplate: async (name, description, icon, content, tags) => {
    const { workspaceId } = get();
    if (!workspaceId) return;
    try {
      const row = await notesCreateTemplate(
        workspaceId,
        name,
        description,
        icon,
        content,
        serializeTags(tags),
      );
      set((state) => ({ templates: [...state.templates, toTemplate(row)] }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  updateTemplate: async (row) => {
    try {
      await notesUpdateTemplate(row);
      set((state) => ({
        templates: state.templates.map((t) => (t.id === row.id ? toTemplate(row) : t)),
      }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  deleteTemplate: async (id) => {
    try {
      await notesDeleteTemplate(id);
      set((state) => ({ templates: state.templates.filter((t) => t.id !== id) }));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The book a new note goes into when the caller didn't name one — the "+" in the sidebar header,
 * the empty state's button, a template picked from the strip.
 *
 * Every note has a book, so this cannot answer "none"; the question is only which. It reads down
 * from the most specific thing the user is looking at: the book the gallery is showing, then the
 * book the open note is in, then the first book on the shelf. A workspace with no books at all gets
 * one, because the alternative is a dialog in front of the fastest action in the app — and "make me
 * a book to put this in" is what pressing new-note in an empty workspace means anyway.
 *
 * `null` comes back only when even that failed, which is a backend error the caller has been told
 * about; there is nothing sensible to write into.
 */
async function resolveBook(get: () => NotesState, defaultName: string): Promise<string | null> {
  const state = get();
  if (state.bookFilter && state.books.some((book) => book.id === state.bookFilter)) {
    return state.bookFilter;
  }
  const active = state.notes.find((note) => note.id === state.activeId);
  if (active?.book_id) return active.book_id;
  const first = state.books
    .filter((book) => !book.parent_id)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))[0];
  if (first) return first.id;
  return state.createBook(null, defaultName);
}

/**
 * Moves `note` to sit immediately after `after` in their book's stored order.
 *
 * Written against `sort_order` rather than against whatever the view is sorted by — unlike a drag,
 * which is a statement about the list on screen, this is a statement about the copy belonging next
 * to its original, and it is true in every ordering. It therefore never switches the sort mode
 * either: duplicating a note is not a request to stop sorting by title.
 */
async function placeAfter(
  get: () => NotesState,
  set: (partial: Partial<NotesState>) => void,
  note: Note,
  after: Note,
): Promise<void> {
  const state = get();
  const siblings = state.notes
    .filter((n) => n.book_id === note.book_id && n.id !== note.id)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  const at = siblings.findIndex((n) => n.id === after.id);
  if (at < 0) return;
  const next = [...siblings.slice(0, at + 1), note, ...siblings.slice(at + 1)];
  const positions = new Map(next.map((n, index) => [n.id, index]));
  set({
    notes: state.notes.map((n) => {
      const position = positions.get(n.id);
      if (position === undefined || n.sort_order === position) return n;
      return { ...n, sort_order: position };
    }),
  });
  // Silent: the copy exists and is on screen either way, and the cost of the failure is that it
  // sits at the bottom of the book rather than under its original.
  await notesReorderNotes(next.map((n) => n.id)).catch(() => {});
}

function draftFor(notes: Note[], id: string, content: string): NoteDraft | null {
  const note = notes.find((n) => n.id === id);
  if (!note) return null;
  return { id, title: note.title, content, tags: note.tags, dirty: false };
}

/** `id` moved to the most-recent end of the cache's order. */
function touch(order: string[], id: string): string[] {
  const without = order.filter((existing) => existing !== id);
  without.push(id);
  return without;
}

/** The body cached, with the least-recently-opened evicted once past the cap. */
function cacheBody(
  state: Pick<NotesState, "bodies" | "bodyOrder">,
  id: string,
  content: string,
): Pick<NotesState, "bodies" | "bodyOrder"> {
  const order = touch(state.bodyOrder, id);
  const bodies = { ...state.bodies, [id]: content };
  while (order.length > BODY_CACHE_LIMIT) {
    const evicted = order.shift();
    if (evicted) delete bodies[evicted];
  }
  return { bodies, bodyOrder: order };
}

/** Loads the notes of whichever workspace is active. Mirrors `ensureRemoteStoreLoaded`; called
 *  from `App` on workspace change and from the view on mount. */
export function ensureNotesStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return Promise.resolve();
  return useNotesStore.getState().setWorkspace(workspaceId);
}

/**
 * The notes the list should show, filtered and ordered.
 *
 * A plain function over the store's own arrays rather than a selector, because it takes the
 * caller's `bookId` — the sidebar tree wants the whole workspace's surviving notes so it can
 * place them under their books, while the gallery wants one book's. Both want the same filter
 * and the same sort, and having two of either is how they drift apart.
 *
 * Callers memoise it on the four inputs it reads. It is a couple of passes over an array of a few
 * hundred, which is cheap — but it runs on every keystroke of the search box, and cheap per
 * keystroke is still worth not paying twice per render.
 */
export function filterNotes(
  notes: Note[],
  options: {
    query: string;
    bodyHits: Record<string, NoteSearchHit>;
    tagFilter: string[];
    bookId?: string | null;
    sort: NoteSort;
  },
): Note[] {
  const needle = options.query.trim().toLowerCase();
  const filtered = notes.filter((note) => {
    if (options.bookId !== undefined && note.book_id !== options.bookId) return false;
    // AND across tags — see `tagFilter`'s comment.
    if (options.tagFilter.some((tag) => !note.tags.includes(tag))) return false;
    if (!needle) return true;
    return (
      note.title.toLowerCase().includes(needle) ||
      note.tags.some((tag) => tag.includes(needle)) ||
      // The backend's half: this note's *body* matched, which nothing here could have known.
      options.bodyHits[note.id] !== undefined
    );
  });

  // Pinned first in every ordering, `manual` included. A pin is a statement about importance, and
  // an ordering that buries a pinned note under a freshly-typed one ignores it — while under a
  // hand-made order it stays predictable, because a note dragged above the pinned block simply
  // lands at the top of the unpinned one, which is as close as it can get.
  return filtered.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    switch (options.sort) {
      case "manual":
        // Ties are real: a note whose book was deleted keeps the position it held inside it (see
        // the table's `ON DELETE SET NULL`), so two notes can arrive at the root sharing a number.
        // Creation order breaks them, which is the order they were appended in to begin with.
        return a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);
      case "created":
        return b.created_at.localeCompare(a.created_at);
      case "title":
        return (a.title || "").localeCompare(b.title || "");
      case "words":
        return b.word_count - a.word_count;
      default:
        return b.updated_at.localeCompare(a.updated_at);
    }
  });
}

/**
 * A title as it is compared when resolving a `[[reference]]`.
 *
 * Case- and accent-folded, whitespace collapsed. Nobody retypes a title exactly, and a reference
 * that fails because someone wrote `[[configuracion]]` for a note called "Configuración" is a
 * reference that taught the user the feature is unreliable. `NFD` + stripping combining marks is
 * the standard way to fold accents without a table.
 */
function foldTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Resolves `[[Title]]` against **the whole workspace**, not the book the note sits in.
 *
 * That is the point of the feature as asked for: a reference finds its note whether that note is
 * loose at the root or filed three books deep. It is affordable precisely because of the
 * metadata/body split — every note's title is already in memory, so this is a lookup rather than a
 * query, and the preview can resolve a hundred links without touching the database.
 *
 * Ambiguity is resolved by recency: two notes sharing a title is a real thing that happens (two
 * meetings called "Retro"), and the most recently edited is the better guess. The `title` returned
 * is the note's own, so a reference written in different casing still shows the reader which note
 * it actually points at.
 */
export function resolveNoteLink(
  notes: Note[],
  title: string,
): { id: string; title: string } | null {
  const wanted = foldTitle(title);
  if (!wanted) return null;
  let best: Note | null = null;
  for (const note of notes) {
    if (foldTitle(note.title) !== wanted) continue;
    if (!best || note.updated_at > best.updated_at) best = note;
  }
  return best ? { id: best.id, title: best.title } : null;
}

/**
 * Notes whose title `query` could be completing, best first — what the editor offers after `[[`.
 *
 * Prefix matches lead, because that is what someone typing a title is doing; substring matches
 * follow so a half-remembered middle word still finds it.
 */
export function suggestNoteLinks(notes: Note[], query: string, limit = 12): Note[] {
  const wanted = foldTitle(query);
  const scored: { note: Note; rank: number }[] = [];
  for (const note of notes) {
    if (!note.title) continue;
    const folded = foldTitle(note.title);
    const rank = !wanted ? 2 : folded.startsWith(wanted) ? 0 : folded.includes(wanted) ? 1 : -1;
    if (rank < 0) continue;
    scored.push({ note, rank });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || b.note.updated_at.localeCompare(a.note.updated_at),
  );
  return scored.slice(0, limit).map((entry) => entry.note);
}
