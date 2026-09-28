import { normalizeTag } from "./tags";

/**
 * A Markdown file, as the note it becomes.
 *
 * Pure: the file is read by the caller (`notes_read_import`), and nothing here touches the store —
 * which is what lets the naming rules be checked directly rather than by picking files in a dialog.
 */
export interface ImportedMarkdown {
  title: string;
  content: string;
  tags: string[];
}

/** The largest file the importer reads, mirrored from `notes_cmd::MAX_IMPORT_BYTES`. */
export const MAX_MARKDOWN_IMPORT_BYTES = 5 * 1024 * 1024;

/** What the file picker offers. `.txt` because plenty of Markdown lives under that name. */
export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "txt"];

/**
 * The note a file becomes.
 *
 * **The body is imported as it is**, front matter included: an import that silently rewrote the
 * text would be a second, lossy copy of it, and the front matter is already invisible where it
 * matters — the excerpt skips it (`note_queries::excerpt_of`). What front matter *does* decide is
 * the title and the tags, which is what every tool that writes it (Obsidian, Jekyll, Hugo) means by
 * them. Without a `title:`, the file's name is the title; nothing else is guessed at — a first
 * heading is often a section, not the document's name.
 *
 * A byte-order mark goes and Windows line endings become `\n`, because the editor would otherwise
 * show a stray character on line one and mark every line as changed on the first save.
 */
export function noteFromMarkdownFile(fileName: string, text: string): ImportedMarkdown {
  const content = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const front = frontMatter(content);
  const fromName = fileName
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(md|markdown|mdown|txt)$/i, "")
    .trim();
  return {
    title: front.title || fromName,
    content,
    tags: front.tags,
  };
}

/** `title` and `tags` from a leading `---` block, when there is one. Anything else in it is kept in
 *  the body and otherwise ignored. */
function frontMatter(content: string): { title: string; tags: string[] } {
  const none = { title: "", tags: [] as string[] };
  if (!content.startsWith("---\n")) return none;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return none;
  const lines = content.slice(4, end).split("\n");

  let title = "";
  const tags: string[] = [];
  let inTagList = false;
  for (const line of lines) {
    const item = line.match(/^\s*-\s+(.+)$/);
    if (inTagList && item) {
      tags.push(unquote(item[1]));
      continue;
    }
    inTagList = false;
    const pair = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!pair) continue;
    const [, key, raw] = pair;
    const value = raw.trim();
    if (key.toLowerCase() === "title") {
      title = unquote(value);
    } else if (key.toLowerCase() === "tags") {
      if (value.startsWith("[") && value.endsWith("]")) {
        tags.push(...value.slice(1, -1).split(",").map(unquote));
      } else if (value) {
        // `tags: a, b` and `tags: a b` both occur in the wild.
        tags.push(...value.split(/[,\s]+/).map(unquote));
      } else {
        inTagList = true;
      }
    }
  }
  const clean = [...new Set(tags.map(normalizeTag).filter(Boolean))];
  return { title: title.trim(), tags: clean };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}
