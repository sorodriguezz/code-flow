import type { WorklogRequest } from "../../../lib/tauri/worklogCommands";

/**
 * The pure half of «Resumen de tu trabajo» in Notas: reading a summary note back (its marker, its
 * summary without «Fuentes») and turning the summary's Markdown into what pastes well in Slack and
 * in Teams (user, 2026-10-23: «Copiar para Slack o Teams, o exportar»). Copying is the only way out —
 * nothing here sends anything anywhere.
 */

/** Written by `worklog::render::marker` at the end of a summary note. */
export const MARKER = "<!-- codeflow:worklog ";

/** The request a summary note was made with — what «Regenerar» asks again — or `null`. */
export function requestOf(content: string): WorklogRequest | null {
  const at = content.lastIndexOf(MARKER);
  if (at < 0) return null;
  const start = at + MARKER.length;
  const end = content.indexOf("-->", start);
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end).trim()) as WorklogRequest;
    return parsed && typeof parsed === "object" && typeof parsed.period === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** The summary alone: the note without its «Fuentes» section and marker. */
export function summaryOf(content: string): string {
  let text = content;
  const marker = text.lastIndexOf(MARKER);
  if (marker >= 0) text = text.slice(0, marker);
  const details = text.lastIndexOf("<details>");
  if (details >= 0) text = text.slice(0, details);
  return `${text.trim()}\n`;
}

/** Inline Markdown → Slack mrkdwn: `**b**` → `*b*`, `[t](u)` → `<u|t>`; code stays as it is. */
function slackInline(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text: string, url: string) => `<${url}|${text.replace(/[<>|]/g, "")}>`)
    .replace(/\[([^\]]+)\]\(#[^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/__([^_]+)__/g, "*$1*");
}

/** Markdown → Slack's mrkdwn, which has no headings or Markdown links. */
export function toSlack(markdown: string): string {
  const out: string[] = [];
  for (const raw of markdown.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`*${slackInline(heading[1]).replace(/\*/g, "")}*`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      out.push(`${"    ".repeat(depth)}• ${slackInline(bullet[2])}`);
      continue;
    }
    out.push(slackInline(raw));
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlInline(line: string): string {
  return escapeHtml(line)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[([^\]]+)\]\(#[^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Markdown → the small HTML Teams keeps when pasted (headings as bold lines, lists, links, code).
 * Copied as `text/html` with the Markdown as its plain-text twin.
 */
export function toTeamsHtml(markdown: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) out.push("</ul>");
    inList = false;
  };
  for (const raw of markdown.split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (heading) {
      closeList();
      out.push(`<p><b>${htmlInline(heading[1])}</b></p>`);
    } else if (bullet) {
      if (!inList) out.push("<ul>");
      inList = true;
      out.push(`<li>${htmlInline(bullet[1])}</li>`);
    } else if (raw.trim()) {
      closeList();
      out.push(`<p>${htmlInline(raw)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return out.join("");
}

/** `#cf-commit=<workspaceId>:<projectId>:<sha>` — a commit's link in a summary's «Fuentes». */
export function commitOf(href: string): { workspaceId: string; projectId: string; sha: string } | null {
  const match = /^#cf-commit=([^:]+):([^:]+):([0-9a-f]{7,64})$/i.exec(href.trim());
  return match ? { workspaceId: match[1], projectId: match[2], sha: match[3] } : null;
}

/** `YYYY-MM-DD` of a date, in local time — what a custom range sends. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
