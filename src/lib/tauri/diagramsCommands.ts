import { invoke } from "@tauri-apps/api/core";
import type {
  DiagramFolderRow,
  DiagramMetaRow,
  DiagramRow,
  DiagramTemplateRow,
  DiagramThumbnailRow,
  DiagramsWorkspaceTree,
} from "../../types/diagrams";

/**
 * IPC surface for the Diagrams workspace.
 *
 * Kept out of `commands.ts` for the reason `notesCommands.ts` and `remoteCommands.ts` are: nothing
 * here touches git or takes a repository path. What it takes instead is a `workspaceId` on the
 * calls that read or create — a diagram belongs to the workspace, not to whichever repository
 * happens to be selected. Anything addressed by its own id doesn't need one.
 *
 * **`diagramsGetDiagram` is the only call that returns a document.** Everything else — the tree,
 * every mutation's return value — deals in metadata. That is not an accident of the API: the whole
 * design rests on the tree never carrying megabytes of XML, so a second command returning `doc` in
 * bulk would quietly undo it. See `db/diagram_queries.rs`.
 *
 * **Calls answer with a value rather than an error where a failure would be ordinary.** Anything
 * returning `DiagramMetaRow | null` gives `null` when the diagram was deleted underneath the
 * caller, and `diagramsMoveFolder` returns `false` when a drop would have put a folder inside its
 * own subtree. Both are things a second window or a stray drag makes happen; a rejected promise
 * would put a toast on screen for a user who did nothing wrong.
 */

// ---------- load ----------

export const diagramsLoadTree = (workspaceId: string) =>
  invoke<DiagramsWorkspaceTree>("diagrams_load_tree", { workspaceId });

/** One diagram's document. `null` if it has been deleted. */
export const diagramsGetDiagram = (id: string) =>
  invoke<DiagramRow | null>("diagrams_get_diagram", { id });

/**
 * The pictures of the diagrams the gallery is about to draw.
 *
 * Separate from the tree for the reason `DiagramThumbnailRow` gives: a thumbnail is tens of
 * kilobytes and the workspace holds every diagram's metadata at once. Diagrams with no picture yet
 * are simply absent from the answer rather than present and empty.
 */
export const diagramsLoadThumbnails = (ids: string[]) =>
  invoke<DiagramThumbnailRow[]>("diagrams_load_thumbnails", { ids });

// ---------- diagrams ----------

/** `folderId` is optional — `null` is the root, where a diagram made from the gallery lands. */
export const diagramsCreateDiagram = (
  workspaceId: string,
  folderId: string | null,
  title: string,
  doc: string,
  format: string,
  tags: string,
) =>
  invoke<DiagramMetaRow>("diagrams_create_diagram", {
    workspaceId,
    folderId,
    title,
    doc,
    format,
    tags,
  });

/** The autosave path. `null` means the diagram was deleted while it was open. */
export const diagramsSaveDiagram = (
  id: string,
  doc: string,
  format: string,
  thumbnail: string,
) => invoke<DiagramMetaRow | null>("diagrams_save_diagram", { id, doc, format, thumbnail });

/** Rejects a blank title in Rust, so every path into a rename is held to the same rule. */
export const diagramsRenameDiagram = (id: string, title: string) =>
  invoke<DiagramMetaRow | null>("diagrams_rename_diagram", { id, title });

export const diagramsSetTags = (id: string, tags: string) =>
  invoke<DiagramMetaRow | null>("diagrams_set_tags", { id, tags });

/** Refiles a diagram. `null` for the folder is the root, and a real destination. */
export const diagramsMoveDiagram = (id: string, folderId: string | null) =>
  invoke<DiagramMetaRow | null>("diagrams_move_diagram", { id, folderId });

/**
 * Writes one container's diagram order — `ids` is that container's whole list, as arranged.
 *
 * Positions are per container, so this is always called with the diagrams of a single folder (or
 * of the root). A drag that crossed folders calls `diagramsMoveDiagram` first: the positions have
 * to be written against the list the diagram has already joined. See `diagramsStore.dropDiagram`.
 */
export const diagramsReorderDiagrams = (ids: string[]) =>
  invoke<void>("diagrams_reorder_diagrams", { ids });

export const diagramsSetPinned = (id: string, pinned: boolean) =>
  invoke<void>("diagrams_set_pinned", { id, pinned });

export const diagramsDeleteDiagram = (id: string) =>
  invoke<void>("diagrams_delete_diagram", { id });

/** `title` is passed in because "Copy of …" is translated and Rust has no language. */
export const diagramsDuplicateDiagram = (id: string, title: string) =>
  invoke<DiagramMetaRow | null>("diagrams_duplicate_diagram", { id, title });

// ---------- folders ----------

export const diagramsCreateFolder = (
  workspaceId: string,
  parentId: string | null,
  name: string,
  color: string,
) => invoke<DiagramFolderRow>("diagrams_create_folder", { workspaceId, parentId, name, color });

export const diagramsRenameFolder = (id: string, name: string) =>
  invoke<void>("diagrams_rename_folder", { id, name });

export const diagramsSetFolderColor = (id: string, color: string) =>
  invoke<void>("diagrams_set_folder_color", { id, color });

/** `false` means the drop was refused: it would have put the folder inside its own subtree. */
export const diagramsMoveFolder = (id: string, parentId: string | null) =>
  invoke<boolean>("diagrams_move_folder", { id, parentId });

/** The folders' half of `diagramsReorderDiagrams`: one parent's children, in their new order. */
export const diagramsReorderFolders = (ids: string[]) =>
  invoke<void>("diagrams_reorder_folders", { ids });

/** Removes the folder, its subfolders **and every diagram in them**. Confirm before calling. */
export const diagramsDeleteFolder = (id: string) =>
  invoke<void>("diagrams_delete_folder", { id });

// ---------- templates ----------

export const diagramsCreateTemplate = (
  workspaceId: string,
  name: string,
  description: string,
  icon: string,
  doc: string,
  format: string,
  tags: string,
) =>
  invoke<DiagramTemplateRow>("diagrams_create_template", {
    workspaceId,
    name,
    description,
    icon,
    doc,
    format,
    tags,
  });

/** Rewrites a template from the row the caller edited — `doc` included. */
export const diagramsUpdateTemplate = (row: DiagramTemplateRow) =>
  invoke<void>("diagrams_update_template", { row });

export const diagramsDeleteTemplate = (id: string) =>
  invoke<void>("diagrams_delete_template", { id });

// ---------- AI ----------

/**
 * Asks an engine to describe a diagram, and answers with the raw JSON it produced.
 *
 * **Deliberately not parsed here.** The answer is validated by `lib/diagrams/aiLayout.ts`, which is
 * also what turns it into a document — keeping the two together means there is one place that knows
 * what a valid description is, rather than a check here and a second, subtly different one there.
 */
export const diagramsDrawWithAi = (args: {
  title: string;
  /**
   * What is already there, as context. For a drawing that is its *labels* and never its document —
   * see `documentOutline`. For a schema it is the DBML itself, which is already nothing but names.
   */
  outline: string;
  instruction: string;
  /**
   * The diagram's dialect, which decides the prompt and the shape of the answer: `mxgraph` comes
   * back as a JSON graph to lay out, `dbml` as a schema in text. Omitted means the drawing one.
   */
  format?: string;
  runId?: string;
}) => invoke<string>("diagrams_draw_with_ai", args);

// ---------- import ----------

/** Reads a `.drawio` file the user picked in a dialog. Capped and text-only in Rust. */
export const diagramsReadDrawio = (path: string) =>
  invoke<string>("diagrams_read_drawio", { path });
