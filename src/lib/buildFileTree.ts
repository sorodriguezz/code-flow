import type { FileStatusEntry } from "../types/domain";

export interface FileTreeDir {
  type: "dir";
  name: string;
  path: string;
  children: FileTreeNode[];
}

export interface FileTreeFile {
  type: "file";
  name: string;
  entry: FileStatusEntry;
}

export type FileTreeNode = FileTreeDir | FileTreeFile;

function sortDir(dir: FileTreeDir) {
  dir.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of dir.children) {
    if (child.type === "dir") sortDir(child);
  }
}

/** Groups a flat list of repo-relative paths into a nested directory tree, the same shape
 * the file explorer and the Changes tab's optional tree view both want. */
export function buildFileTree(entries: FileStatusEntry[]): FileTreeNode[] {
  const root: FileTreeDir = { type: "dir", name: "", path: "", children: [] };
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      let dir = current.children.find((c) => c.type === "dir" && c.name === name) as FileTreeDir | undefined;
      if (!dir) {
        dir = { type: "dir", name, path, children: [] };
        current.children.push(dir);
      }
      current = dir;
    }
    const name = parts[parts.length - 1] ?? entry.path;
    current.children.push({ type: "file", name, entry });
  }
  sortDir(root);
  return root.children;
}
