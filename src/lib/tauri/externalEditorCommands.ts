import { invoke } from "./invoke";

/** An editor CodeFlow can open a folder in (`external_editor::EDITORS`). */
export interface ExternalEditor {
  id: string;
  label: string;
  /** Found on this machine — its app, or its command on the PATH. */
  installed: boolean;
}

export interface ExternalEditorState {
  /** Every editor known, installed or not, in «automatic»'s order. */
  editors: ExternalEditor[];
  /** The app's choice; `""` is automatic. */
  default: string;
  /** What «automatic» opens on this machine. */
  auto: string;
  /** Workspace id → its choice, only where one was made. */
  workspaces: Record<string, string>;
  /** Repository id → its choice, only where one was made. */
  projects: Record<string, string>;
}

export const externalEditorState = () => invoke<ExternalEditorState>("external_editor_state");

/** Opens `path` in `editor`, or else in the one chosen for the repository and its workspace.
 *  Resolves to the editor's name. */
export const openInExternalEditor = (path: string, opts: { projectId?: string | null; workspaceId?: string | null; editor?: string | null } = {}) =>
  invoke<string>("open_in_external_editor", { path, projectId: opts.projectId ?? null, workspaceId: opts.workspaceId ?? null, editor: opts.editor ?? null });
