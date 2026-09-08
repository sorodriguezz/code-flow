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
 * once. Documents come one at a time through `diagramsPullFile`; pictures come in batches through
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
 *
 * Two dialects exist. `mxgraph` is the drawing one, edited by the embedded draw.io; `dbml` is a
 * database schema as text, edited by `components/dbml/DbmlWorkbench`. The branch between them is in
 * exactly one place — `DiagramsView` picks the editor — which is what the column was for.
 */
export type DiagramFormat = "mxgraph" | "dbml" | (string & {});

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
  /**
   * The project whose working tree holds [`origin_path`], or `""`.
   *
   * A project id and not a checkout path, so moving the repository on disk does not break the
   * link. A project that has since been removed leaves the diagram readable and stops it syncing.
   */
  origin_project_id: string;
  /**
   * The repo-relative file this diagram mirrors, or `""` for a diagram made in the app.
   *
   * Non-empty is the whole of what makes a diagram a **bridge**: its document is re-read from that
   * file when it is opened, and every save writes the file back. It rides on the *metadata* rather
   * than only on the full row because the explorer marks a linked diagram, and the explorer never
   * fetches documents. Use `isLinked` rather than testing the field, so there is one answer to
   * "is this a bridge?" in the frontend.
   */
  origin_path: string;
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
 * A linked diagram and how its file is doing. Mirrors `DiagramSync` in `diagrams_cmd`.
 *
 * Two fields rather than a rejected promise, because a file that cannot be read is not a failed
 * call: the diagram still opens, on the last document it had. Checking out a branch without that
 * file is the ordinary way to get here.
 */
export interface DiagramSync {
  /** `null` when the diagram itself is gone — deleted from another window. */
  row: DiagramRow | null;
  /** Empty when the working tree was read. Otherwise the reason, already a sentence. */
  file_error: string;
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
  /**
   * The repository this folder collects `.dbml` files for, or `""` for a folder the user made.
   *
   * Identity rather than decoration: the second schema opened from the same repository finds its
   * way here by this, so the folder can be renamed, moved and coloured like any other and still be
   * where the next one lands.
   */
  origin_project_id: string;
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

/**
 * Whether this diagram is a bridge onto a file in a working tree.
 *
 * One predicate rather than `origin_path !== ""` spelled out in a dozen components: every one of
 * them would be a place for the emptiness convention to be misremembered, and the answer decides
 * whether saving writes somebody's repository.
 */
export function isLinked(diagram: Pick<Diagram, "origin_path"> | null | undefined): boolean {
  return Boolean(diagram && diagram.origin_path !== "");
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
