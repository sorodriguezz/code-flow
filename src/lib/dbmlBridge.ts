import { FORMAT_DBML, FORMAT_EXCALIDRAW, FORMAT_MXGRAPH } from "./diagrams/doc";
import { diagramsLinkFile } from "./tauri/diagramsCommands";
import { focusSatellite } from "./tauri/windows";
import { broadcast } from "./windowBus";
import { isMainWindow, MAIN_LABEL, WINDOW } from "./windowIdentity";
import { translate } from "../state/languageStore";
import { useUiStore } from "../state/uiStore";
import { useWindowStore } from "../state/windowStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { pushErrorToast } from "../state/toastStore";
import type { DiagramFormat } from "../types/diagrams";

/**
 * The bridge between a diagram file in a repository — `.dbml`, `.excalidraw` or `.drawio` — and the
 * Diagrams app.
 *
 * # What "copy" means here, and what it does not
 *
 * Pressing *Open in Diagrams* on one — the schema button in the editor, or the file tree's menu —
 * does not import it. It files the **file itself** as a diagram — a row whose `origin_path` names
 * the working-tree file it mirrors — and from then on the two are one document with two editors on
 * it:
 *
 * - opening the diagram re-reads the file, so the working tree wins whenever they differ;
 * - saving the diagram writes the file, so what is drawn in the app is what git offers to commit;
 * - saving the file re-reads into the diagram, over `repo:fs-changed`.
 *
 * The row is what makes it a *diagram* — a title, a folder, tags, version history, a place in the
 * gallery. The file is what makes it the repository's. Neither is a copy of the other, which is why
 * there is no "sync now" button anywhere and no direction for the user to choose.
 *
 * **Only diagrams tied to a file work this way**: one opened from a repository, or one made in the
 * app and then saved into one ("Save in a repository", `diagrams_save_to_repo`, which ends in the
 * same row shape). Every other diagram has an empty `origin_path`, and nothing here touches it.
 *
 * # Where the diagram opens
 *
 * Wherever the Diagrams app already is. If it has been detached onto its own window that window
 * gets it and comes forward — the point of a floating Diagrams window is that it is where diagrams
 * happen, and opening a second copy in the shell would be the duplication the whole multi-window
 * design rules out (see `codeflow-satellite-windows`'s first invariant). Otherwise the main window
 * shows it on the rail. A repository satellite, which has no rail at all, always hands it to one of
 * those two.
 *
 * Nothing here is destructive to what the receiving window was already editing: `openDiagram`
 * flushes the outgoing draft before it replaces it, exactly as clicking another diagram in the
 * explorer does.
 */

/** The extensions a diagram file is opened by, and the dialect each one is. */
const DIAGRAM_EXTENSIONS: [RegExp, DiagramFormat][] = [
  [/\.dbml$/i, FORMAT_DBML],
  [/\.excalidraw$/i, FORMAT_EXCALIDRAW],
  [/\.(drawio|dio)$/i, FORMAT_MXGRAPH],
];

/** The name a diagram file takes as a diagram: the file's, without its directories or its extension. */
export function diagramTitleForPath(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const extension = DIAGRAM_EXTENSIONS.find(([pattern]) => pattern.test(base))?.[0];
  return (extension ? base.replace(extension, "") : base) || base;
}

/** Whether a path is a schema — the file the editor's own "Open in Diagrams" button is for. */
export function isDbmlPath(path: string | null | undefined): boolean {
  return Boolean(path && path.toLowerCase().endsWith(".dbml"));
}

/**
 * Which editor of the Diagrams app a file opens in, from its extension — or `null` for a file that
 * is not a diagram. The extension and only the extension, for the reason `exportFile.formatOf`
 * gives. A bare `.xml` is not claimed: most XML in a repository is not a drawing.
 */
export function diagramFormatForPath(path: string | null | undefined): DiagramFormat | null {
  if (!path) return null;
  return DIAGRAM_EXTENSIONS.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

/** Whether this bridge can carry a path at all. */
export function isDiagramPath(path: string | null | undefined): boolean {
  return diagramFormatForPath(path) !== null;
}

/**
 * Shows a diagram in *this* window, workspace and all.
 *
 * The receiving end of the routing above, and also the local path when the Diagrams app is already
 * here. It crosses workspaces when it has to: the diagram was asked for by id, and a window that
 * refused to leave the workspace it was on would answer the request with the gallery of a different
 * one. That is a *choice* being made — the user pressed a button naming this diagram — so it goes
 * through `setActiveWorkspace` and is recorded, rather than through `followWorkspace`.
 */
export async function showDiagramHere(workspaceId: string, diagramId: string): Promise<void> {
  // Imported here rather than at the top of the file, because this module is reached from *both*
  // entry points — `App` and `SatelliteApp` both listen for the message — and a static edge from an
  // entry is what pulls a module into that entry's first load. A Remote or vault window will never
  // open a diagram, and `window.html` exists so it does not carry the machinery for one.
  // `notificationStore` reaches this store the same way, for the same reason.
  const { useDiagramsStore } = await import("../state/diagramsStore");

  const workspace = useWorkspaceStore.getState();
  if (workspace.activeWorkspaceId !== workspaceId) {
    workspace.setActiveWorkspace(workspaceId);
  }
  const diagrams = useDiagramsStore.getState();
  if (diagrams.workspaceId !== workspaceId) {
    await diagrams.setWorkspace(workspaceId);
  } else {
    // The tree, even when the workspace already matches: the diagram may have been created by the
    // window that sent us here a moment ago, and this window's copy of the list predates it.
    await diagrams.refresh();
  }
  // In the main window the Diagrams app is one of several on the rail, so it has to be brought up.
  // In a satellite `activeView` is fixed by the window's identity and this is a no-op on it.
  if (isMainWindow()) useUiStore.getState().setActiveView("diagrams");

  /**
   * The diagram is already the open one, which `openDiagram` answers by doing nothing — it is
   * written to make clicking the same row twice free. That is right for a click and wrong here: the
   * press that got us this far *saved the file first*, so the document on screen is a version
   * behind. `syncFromDisk` is what closes that, and it is also what makes this safe when it cannot:
   * a draft with unsaved edits in it is left exactly as it is, because losing work somebody has not
   * saved is worse than showing them a document they will overwrite anyway on their next save.
   * Two editors on one file is last-writer-wins, here as everywhere else.
   */
  const store = useDiagramsStore.getState();
  if (store.activeId === diagramId && store.draft?.id === diagramId) {
    await store.syncFromDisk(diagramId);
    return;
  }
  await store.openDiagram(diagramId);
}

/**
 * Files a diagram file as a diagram and puts it on screen, wherever the Diagrams app lives. Answers
 * `false` without a word for a path that is not a diagram — see `diagramFormatForPath`.
 *
 * Idempotent on the file: the second press reaches the same diagram with its document refreshed
 * from disk, rather than making a second one. Answers `true` when the diagram exists — a caller
 * with a toast to show can then say so — and `false` when the link itself failed, which has already
 * been reported.
 *
 * The caller is responsible for the buffer: a tab with unsaved edits must be written before this
 * is called, or the diagram opens on the file as it is on disk, which is not what is on screen.
 * `EditorView` does exactly that, and says so on the button.
 */
export async function openFileInDiagrams(args: {
  workspaceId: string;
  projectId: string;
  relPath: string;
}): Promise<boolean> {
  const format = diagramFormatForPath(args.relPath);
  if (!format) return false;
  const title = diagramTitleForPath(args.relPath);
  let diagramId: string;
  try {
    const row = await diagramsLinkFile(args.workspaceId, args.projectId, args.relPath, title, format);
    diagramId = row.id;
  } catch (error) {
    // A drawing with several pages is refused before anything is written — see
    // `diagrams_link_file`. Worded here, where there is a language.
    pushErrorToast(
      String(error).startsWith("multi-page:")
        ? translate("diagrams.multiPage", { name: args.relPath.split("/").pop() ?? args.relPath })
        : String(error),
    );
    return false;
  }

  // The Diagrams app on its own desk wins, and keeps whatever it was editing: `openDiagram` there
  // flushes the outgoing draft before it swaps in this one.
  const detached = useWindowStore.getState().detachedLabel("app", "diagrams");
  if (detached && detached !== WINDOW.label) {
    broadcast({ kind: "open-diagram", to: detached, workspaceId: args.workspaceId, diagramId });
    await focusSatellite(detached).catch(() => {
      // A window that has gone since the list was pushed. The message is already out, and if it
      // really is gone nobody acts on it — the diagram is filed either way, which is the part that
      // had to happen.
    });
    return true;
  }

  if (isMainWindow() || detached === WINDOW.label) {
    await showDiagramHere(args.workspaceId, diagramId);
    return true;
  }

  // A repository window: no rail, so it cannot show the Diagrams app itself. The main window can,
  // and bringing it forward is what makes the press read as "it opened over there" rather than as
  // nothing having happened.
  broadcast({ kind: "open-diagram", to: MAIN_LABEL, workspaceId: args.workspaceId, diagramId });
  broadcast({ kind: "focus-main" });
  return true;
}
