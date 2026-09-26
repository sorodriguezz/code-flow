import type { TreeRow } from "./tauri/commands";

/**
 * The explorer's "Generate Tree", in the exact text of the VS Code extension `file-tree-generator`
 * (Shinotatwu-DS) — the format people already paste into READMEs:
 *
 *     📦src
 *      ┣ 📂components
 *      ┃ ┣ 📜App.tsx
 *      ┃ ┗ 📜index.ts
 *      ┗ 📜main.tsx
 *
 * The root carries 📦, folders 📂 and files 📜. Every entry line is one space, `┃ ` per level above
 * it, then `┣ ` — or `┗ ` for the last of its siblings — then the icon and the name.
 *
 * **Every level above draws `┃`, even below a `┗`.** That is the extension's own output, not a slip
 * here: it indents with `┃ ` per depth and never asks whether that ancestor was the last of its
 * siblings, so a folder at the bottom of a list still has a rail running down beside its contents.
 * Kept on purpose: the point of the format is to be *that* format, the one a README already holds,
 * and a "corrected" tree would stop matching it.
 *
 * Only the printing lives here. What is walked — the explorer's order, its hidden entries, folders
 * git ignores, the cap — is `fsops::dir_tree`'s.
 */
export function renderFileTree(name: string, rows: readonly TreeRow[], note?: string | null): string {
  const lines = [`📦${name}`];
  for (const row of rows) {
    lines.push(` ${"┃ ".repeat(row.depth)}${row.last ? "┗ " : "┣ "}${row.is_dir ? "📂" : "📜"}${row.name}`);
  }
  // Below a blank line, so the tree can still be copied as it is without taking the note along.
  if (note) lines.push("", note);
  return `${lines.join("\n")}\n`;
}

/**
 * What the tab holding a generated tree is called: `tree-src.txt`.
 *
 * Plain text rather than `.md`: the tree is not Markdown until someone puts it in a fence, and as a
 * Markdown file its preview would run every line into one paragraph and read `__init__.py` as bold.
 */
export function treeFileName(name: string): string {
  return `tree-${name}.txt`;
}
