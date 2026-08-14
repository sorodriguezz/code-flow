/**
 * The Notes workspace's types.
 *
 * Two layers, and the split is the point. **Wire types** (`*Row`) mirror the Rust structs in
 * `db::models` field for field, including the awkward parts — `tags` is the JSON *string* SQLite
 * stores, `pinned` is whatever serde made of an INTEGER. **View types** (`Note`, `NoteTemplate`)
 * are what the components use, with the tags already parsed into an array.
 *
 * Keeping them apart means the JSON is parsed exactly once, at the store boundary
 * (`notesStore`'s `toNote`/`toTemplate`), instead of in every component that wants to render a
 * chip. A `tags.map()` in a list row would re-parse the same string on every keystroke of an
 * unrelated search box.
 *
 * The other thing to know is the body split. `Note` has **no `content`** — it is the metadata the
 * list and the gallery draw, and the workspace holds every one of them at once. Bodies come one at
 * a time through `notesGetNote` and live in the store's own cache. See `db/note_queries.rs` for the
 * reasoning; this is the frontend half of the same rule.
 */

// ---------------------------------------------------------------------------
// Wire — exact mirrors of `db::models`
// ---------------------------------------------------------------------------

/** A note without its body, as it comes off the IPC boundary. `tags` is a JSON array of strings. */
export interface NoteMetaRow {
  id: string;
  workspace_id: string;
  /** `null` is the root of the tree, which is where an unfiled note lives. */
  book_id: string | null;
  title: string;
  /** First prose of the body with the marks stripped — derived in Rust on every save. */
  excerpt: string;
  tags: string;
  pinned: boolean;
  word_count: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** One note, body included. The only shape that carries `content`. */
export interface NoteRow extends NoteMetaRow {
  content: string;
}

export interface NoteBookRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  /** Empty for "no colour", which draws the book in the muted default. */
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface NoteTemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  /** A key of `TEMPLATE_ICONS` in `lib/notes/templateIcons.ts`. */
  icon: string;
  content: string;
  tags: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface NotesWorkspaceTree {
  notes: NoteMetaRow[];
  books: NoteBookRow[];
  templates: NoteTemplateRow[];
}

/** A note whose *body* matched a search, with the stretch of it that did. */
export interface NoteSearchHit {
  id: string;
  snippet: string;
  /** Where the match starts **inside `snippet`**, in characters. */
  match_start: number;
  match_len: number;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** A note as the UI holds it: metadata only, tags parsed. */
export interface Note extends Omit<NoteMetaRow, "tags"> {
  tags: string[];
}

export interface NoteTemplate extends Omit<NoteTemplateRow, "tags"> {
  tags: string[];
  /**
   * Set on the templates that ship with the app rather than living in the database.
   *
   * They are read through `translate`, so their name and body follow the user's language — which
   * a row could not do. The flag is what stops the UI offering to rename or delete one: there is
   * no row behind it to change. "Duplicate to my templates" is the way to edit one, and it makes
   * a real row.
   */
  builtIn?: boolean;
}

/** How the editor splits its space. Persisted per workspace. */
export type NoteViewMode = "editor" | "split" | "preview";

/** How the gallery orders its cards. Persisted per workspace. */
export type NoteSort = "updated" | "created" | "title" | "words";

/**
 * The note being edited, before it is saved.
 *
 * The editor writes here and only here; the debounced save copies it into the row and folds the
 * answer back into `notes`. That indirection is what lets typing stay at the speed of a keystroke
 * while the database is written at the speed of a person pausing — and what makes "unsaved" a
 * state the status bar can show honestly rather than a guess.
 */
export interface NoteDraft {
  id: string;
  title: string;
  content: string;
  tags: string[];
  /** Whether anything here differs from the row. Drives the status bar and the flush-on-close. */
  dirty: boolean;
}

/**
 * One row of the explorer tree, already flattened.
 *
 * The tree is nested data drawn as a list, and flattening it in a `useMemo` rather than recursing
 * in JSX is what keeps a deep book from re-rendering its whole subtree when one note inside it
 * is renamed: every row is its own memoised component keyed by id, and the parent hands it a
 * `depth` instead of nesting it.
 */
export type NoteTreeRow =
  | { kind: "book"; id: string; depth: number; book: NoteBook; noteCount: number }
  | { kind: "note"; id: string; depth: number; note: Note };

export interface NoteBook extends NoteBookRow {
  /** Children, so the flattener can walk without re-scanning the array per level. */
  children: NoteBook[];
}
