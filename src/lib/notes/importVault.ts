import { noteFromMarkdownFile, type ImportedMarkdown } from "./importMarkdown";

/**
 * A vault or an export read into notes, keeping where each file sat as the books it lands in.
 *
 * **Obsidian** is Markdown already, `[[links]]` included — imported as written (front matter
 * decides title and tags, as for a single file).
 *
 * **Notion's** "Markdown & CSV" export is Markdown with two habits undone here: every file and
 * folder name ends in a 32-character id (`Plan de lanzamiento 1a2b…f0.md`), and a link to another
 * page is a relative path to that file (`[Plan](Plan%20de%20lanzamiento%201a2b…f0.md)`) — which
 * becomes `[[Plan de lanzamiento]]`, the note it now is.
 */

export type VaultKind = "obsidian" | "notion";

export interface VaultFile {
  /** The folder the file sat in, relative to the vault, `/`-separated. */
  dir: string;
  name: string;
  content: string;
}

export type VaultNote = ImportedMarkdown & { folders: string[] };

const NOTION_ID = /\s+[0-9a-f]{32}(?=$|\.)/i;

/** A Notion export, recognised by the ids on its file names. */
export function looksLikeNotion(files: VaultFile[]): boolean {
  return files.some((file) => NOTION_ID.test(file.name));
}

function stripNotionId(name: string): string {
  return name.replace(NOTION_ID, "").trim();
}

/** Notion's relative page links as `[[Title]]`. External links and images are left alone. */
export function notionLinks(content: string): string {
  return content.replace(/\[([^\]\n]*)\]\(([^)\s]+\.md)\)/g, (whole, _text: string, target: string) => {
    if (/^[a-z]+:\/\//i.test(target)) return whole;
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      // A malformed escape: the link as written is still the best guess at its name.
    }
    const base = decoded.split("/").pop() ?? decoded;
    const title = stripNotionId(base.replace(/\.md$/i, ""));
    return title ? `[[${title}]]` : whole;
  });
}

export function fromVault(files: VaultFile[], kind: VaultKind): VaultNote[] {
  return files.map((file) => {
    const notion = kind === "notion";
    const name = notion ? stripNotionId(file.name.replace(/\.(md|markdown|mdown|txt)$/i, "")) + ".md" : file.name;
    let content = file.content;
    if (notion) {
      content = notionLinks(content);
      // Notion opens every page with its own title as a heading; the note's title says it already.
      const title = name.replace(/\.md$/, "");
      content = content.replace(/^﻿?#\s+(.+)\n+/, (heading, text: string) => (text.trim() === title ? "" : heading));
    }
    const note = noteFromMarkdownFile(name, content);
    const folders = file.dir
      .split("/")
      .map((segment) => (notion ? stripNotionId(segment) : segment).trim())
      .filter(Boolean);
    return { ...note, folders };
  });
}
