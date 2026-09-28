/**
 * How a notebook reaches the editor tab that holds its file.
 *
 * The tab's text **is** the notebook as far as the rest of the editor is concerned: its dirty dot,
 * the checked save (`write_editor_file`), the "changed on disk" question, the crash journal and the
 * quit guard's list of unsaved work all read `tab.content`. So a notebook never keeps edits of its
 * own — every change, typed or produced by a kernel, is serialized and written into the tab through
 * this, and every change that arrives the other way (a reload, the raw JSON view, a restored draft)
 * is read back from it.
 *
 * A registry rather than a prop because the writer is not always on screen: a kernel keeps printing
 * into a notebook whose tab is not the active one, and its output has to land in the file all the
 * same. `EditorView` registers its tabs here per project; a project the window has left (its editor
 * parked) has no host, and its notebooks wait until it comes back.
 */
export interface NotebookHost {
  /** The tab's text now — `null` when no writable tab holds that path. */
  read: (path: string) => string | null;
  write: (path: string, text: string) => void;
}

const hosts = new Map<string, NotebookHost>();

export function registerNotebookHost(repoPath: string, host: NotebookHost): () => void {
  hosts.set(repoPath, host);
  return () => {
    if (hosts.get(repoPath) === host) hosts.delete(repoPath);
  };
}

export function notebookHost(repoPath: string): NotebookHost | undefined {
  return hosts.get(repoPath);
}

/** Whether a path is a notebook the editor opens as one. */
export function isNotebookPath(path: string | null | undefined): boolean {
  return !!path && path.toLowerCase().endsWith(".ipynb");
}

/** The key a notebook's session is filed under: repository and path, since two repositories can
 *  both hold an `analysis.ipynb`. */
export function notebookKey(repoPath: string, path: string): string {
  return `${repoPath}\u0000${path}`;
}
