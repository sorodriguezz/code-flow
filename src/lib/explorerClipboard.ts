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
export function planPaste(sources: readonly string[], target: PasteTarget): PastePlan {
  const into = target.isDir ? target.path : parentOf(target.path);
  const steps: PasteStep[] = [];
  const refused: string[] = [];
  for (const source of sources) {
    const destDir = source === target.path ? parentOf(source) : into;
    if (destDir === source || destDir.startsWith(`${source}/`)) refused.push(source);
    else steps.push({ source, destDir });
  }
  return { steps, refused };
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
