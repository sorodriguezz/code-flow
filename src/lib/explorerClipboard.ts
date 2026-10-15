/**
 * The explorer's Copy / Cut / Paste, as the decisions they make: which paths go on the clipboard,
 * and where each one lands. Pure, so the rules — VS Code's, deliberately — can be pinned by tests;
 * `FileTree` does the IPC and `explorerClipboardStore` holds the result.
 */

/** Repo-relative parent directory, `""` for a top-level entry — the same answer `FileTree`'s
 *  `parentDir` gives, restated so this module stays free of the component. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/**
 * The selection without anything whose ancestor is also selected — VS Code's `distinctParents`.
 *
 * Copying `src` and `src/a.ts` together means copying `src`: pasting both would land `a.ts` twice,
 * once inside the copied folder and once beside it. Order is kept, duplicates dropped.
 */
export function distinctParents(paths: readonly string[]): string[] {
  const picked = new Set(paths);
  const out: string[] = [];
  for (const path of picked) {
    let covered = false;
    for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
      if (picked.has(path.slice(0, cut))) {
        covered = true;
        break;
      }
    }
    if (!covered) out.push(path);
  }
  return out;
}

/** The row a paste is aimed at: the one right-clicked, or the focused one for ⌘V. `""` with
 *  `isDir` is the repository root — the empty space below the tree. */
export interface PasteTarget {
  path: string;
  isDir: boolean;
}

export interface PasteStep {
  source: string;
  destDir: string;
}

export interface PastePlan {
  steps: PasteStep[];
  /** Folders that would have landed inside themselves. Refused, and named back to the user. */
  refused: string[];
}

/**
 * Where each pasted path lands, VS Code's way.
 *
 * Into the target when it is a folder, beside it when it is a file — the same rule that decides
 * where "New File" lands. One exception, also VS Code's: pasting onto **the very row that was
 * copied** puts the copy beside it rather than inside it, which is what makes ⌘C ⌘V on one row a
 * duplicate (`a copy.ts`, `src copy`). The literal reading would be a folder into itself, or a file
 * into nothing.
 *
 * A folder whose destination is itself or something under it is refused rather than attempted —
 * the backend would refuse it too, but only with an English error, and this is the one mistake a
 * paste can make that deserves a sentence of its own.
 */
export function planPaste(sources: readonly string[], target: PasteTarget, sameRepo = true): PastePlan {
  const into = target.isDir ? target.path : parentOf(target.path);
  const steps: PasteStep[] = [];
  const refused: string[] = [];
  for (const source of sources) {
    // From another repository a source's path says nothing about this one's rows: the same
    // relative path here is a different file, so everything goes where the target says. A folder
    // that really is its own destination (one physical folder in both) the backend refuses.
    if (!sameRepo) {
      steps.push({ source, destDir: into });
      continue;
    }
    const destDir = source === target.path ? parentOf(source) : into;
    if (destDir === source || destDir.startsWith(`${source}/`)) refused.push(source);
    else steps.push({ source, destDir });
  }
  return { steps, refused };
}

/** An absolute path for `rel` in the repository at `repoPath` — what a paste in another repository
 *  (or window) hands the backend. Forward slashes, which every platform's file API accepts. */
export function absoluteIn(repoPath: string, rel: string): string {
  const base = repoPath.replace(/[\\/]+$/, "");
  return rel ? `${base}/${rel}` : base;
}

/**
 * Which clipboard a paste takes: the explorer's own (`"app"`), the files copied in the system's
 * file manager (`"system"`), or nothing.
 *
 * The explorer's Copy records the system clipboard's change counter (`systemStamp`). If the counter
 * has moved on since and the system clipboard now holds files, those were copied *after* the
 * explorer's Copy, and the newer one wins. A counter that moved for anything else — text copied in
 * the editor, "Copy Path" — leaves the explorer's clipboard in charge, as does a counter that is
 * not known on either side.
 */
export function pickPasteSource(
  app: { paths: readonly string[]; systemStamp: number | null },
  system: { stamp: number | null; paths: readonly string[] } | null,
): "app" | "system" | null {
  const appHas = app.paths.length > 0;
  const systemHas = !!system && system.paths.length > 0;
  if (appHas) {
    const unknown = app.systemStamp === null || system === null || system.stamp === null;
    if (unknown || system.stamp === app.systemStamp || !systemHas) return "app";
    return "system";
  }
  return systemHas ? "system" : null;
}

/**
 * `path` after something at `from` moved to `to` — itself, or anything under it when `from` was a
 * folder. Anything else is returned untouched. The rule the editor's tabs follow too
 * (`handlePathMoved`), applied here to what is waiting on the clipboard.
 */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** Whether `path` is `gone` or lies inside it. */
export function isAtOrUnder(path: string, gone: string): boolean {
  return path === gone || path.startsWith(`${gone}/`);
}
