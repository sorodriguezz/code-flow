/**
 * The Diagrams workspace's types.
 *
 * The same two layers as `types/notes.ts`, for the same reason. **Wire types** (`*Row`, `*Meta`)
 * mirror the Rust structs in `db::models` field for field, including the awkward parts — `tags` is
 * the JSON *string* SQLite stores. **View types** (`Diagram`, `DiagramFolder`) are what the
 * components use, with the tags already parsed.
 *
 * Keeping them apart means the JSON is parsed exactly once, at the store boundary
 * (`diagramsStore`'s `toDiagram`), instead of in every component that draws a chip.
 *
 * The other thing to know is the document split. `Diagram` has **no `doc`** and **no `thumbnail`**
 * — it is the metadata the tree and the gallery draw, and the workspace holds every one of them at
 * once. Documents come one at a time through `diagramsGetDiagram`; pictures come in batches through
 * `diagramsLoadThumbnails`, for the cards actually on screen. See `db/diagram_queries.rs` for the
 * reasoning; this is the frontend half of the same rule.
 */

// ---------------------------------------------------------------------------
// Wire — exact mirrors of `db::models`
// ---------------------------------------------------------------------------

/**
 * Which dialect a diagram's document is written in.
 *
 * A string rather than a bare literal type because it is a *column*, and the whole point of the
 * column is that a document written by one editor stays readable when another one ships. Code that
 * branches on it must have a default arm; code that only stores and forwards it — which is most of
 * the app — should not look at it at all.
 */
export type DiagramFormat = "mxgraph" | (string & {});

/** A diagram without its document, as it comes off the IPC boundary. `tags` is a JSON array. */
export interface DiagramMetaRow {
  id: string;
  workspace_id: string;
  /** `null` is the root of the tree, which is where an unfiled diagram lives. */
  folder_id: string | null;
  title: string;
  format: DiagramFormat;
  tags: string;
  pinned: boolean;
  /** Vertices plus edges, derived in Rust on every save. Zero for a format Rust can't count. */
  shape_count: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** One diagram, document included. The only shape that carries `doc`. */
export interface DiagramRow extends DiagramMetaRow {
  doc: string;
  /** A `data:` URI, exactly as the editor exported it. Empty for a diagram never saved. */
  thumbnail: string;
}

/**
 * One diagram's picture, fetched apart from its metadata.
 *
 * **Not a field of `DiagramMetaRow`**, and that is the point: a thumbnail is a rendered PNG of tens
 * of kilobytes, and the workspace holds every diagram's metadata at once. The gallery asks for the
 * cards it is about to draw. See `db/diagram_queries.rs`.
 */
export interface DiagramThumbnailRow {
  id: string;
  thumbnail: string;
}

export interface DiagramFolderRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  /** Empty for "no colour", which draws the folder in the muted default. */
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * A diagram skeleton the user starts from.
 *
 * Carries its own `doc`, unlike `DiagramMetaRow` — a template *is* its document, and there are a
 * handful of them rather than hundreds, so the rule that keeps documents out of the tree has
 * nothing to say here.
 */
export interface DiagramTemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  /** A key of `TEMPLATE_ICONS` in `lib/diagrams/templateIcons.ts`. */
  icon: string;
  doc: string;
  format: DiagramFormat;
  tags: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DiagramsWorkspaceTree {
  diagrams: DiagramMetaRow[];
  folders: DiagramFolderRow[];
  templates: DiagramTemplateRow[];
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** A diagram as the UI holds it: metadata only, tags parsed. */
export interface Diagram extends Omit<DiagramMetaRow, "tags"> {
  tags: string[];
}

/** A template as the UI holds it: tags parsed. */
export interface DiagramTemplate extends Omit<DiagramTemplateRow, "tags"> {
  tags: string[];
}

/** A folder with its children resolved, so the flattener can walk without re-scanning per level. */
export interface DiagramFolder extends DiagramFolderRow {
  children: DiagramFolder[];
}

/** How the gallery draws its folders and diagrams — cards or rows. Persisted per workspace. */
export type DiagramGalleryView = "grid" | "list";

/**
 * How the list orders its diagrams. Persisted per workspace.
 *
 * `manual` is the default and the other three are views onto it, for the reason `NoteSort`
 * documents: a diagram list is a thing people arrange, and an ordering by `updated_at` rearranges
 * itself every time one of them is *touched*.
 */
export type DiagramSort = "manual" | "updated" | "created" | "title";

/**
 * One row of the explorer tree, already flattened.
 *
 * The tree is nested data drawn as a list, and flattening it in a `useMemo` rather than recursing
 * in JSX is what keeps a deep folder from re-rendering its whole subtree when one diagram inside
 * it is renamed: every row is its own memoised component keyed by id, and the parent hands it a
 * `depth` instead of nesting it.
 */
export type DiagramTreeRow =
  | { kind: "folder"; id: string; depth: number; folder: DiagramFolder; diagramCount: number }
  | { kind: "diagram"; id: string; depth: number; diagram: Diagram };
