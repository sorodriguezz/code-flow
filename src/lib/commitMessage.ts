/**
 * The commit box's helpers that are only text: trailers (`Co-authored-by`, `Signed-off-by`), a line
 * for `.gitignore`, and the history ↑ walks through.
 */

/** A `Key: value` trailer line, as git reads them at the end of a message. */
const TRAILER = /^[A-Za-z][\w-]*: .+$/;

/** `message` with `trailer` in its trailer block — started after a blank line if there is none, and
 *  left as it is when that exact line is already there. */
export function withTrailer(message: string, trailer: string): string {
  const body = message.replace(/\s+$/, "");
  if (body.split("\n").some((line) => line.trim() === trailer)) return message;
  if (!body) return trailer;
  const paragraphs = body.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1].split("\n");
  const inBlock = paragraphs.length > 1 && last.every((line) => TRAILER.test(line.trim()));
  return `${body}${inBlock ? "\n" : "\n\n"}${trailer}`;
}

/** `Name <email>`, the shape both trailers take. */
export function person(name: string, email: string): string {
  return `${name.trim()} <${email.trim()}>`;
}

/** `.gitignore`'s text with `pattern` added on a line of its own — unchanged when that line is
 *  already there. Keeps the file's line endings. */
export function withIgnored(text: string, pattern: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (text.split(/\r?\n/).some((line) => line.trim() === pattern)) return text;
  const base = text.length === 0 || text.endsWith("\n") ? text : `${text}${eol}`;
  return `${base}${pattern}${eol}`;
}

/** The pattern that ignores exactly one repository path, anchored to the root. */
export function ignorePatternFor(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

/** The pattern for every file with the extension `path` has, or `null` for one without. */
export function extensionPatternFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `*${name.slice(dot)}` : null;
}

const HISTORY_MAX = 30;

function historyKey(repoPath: string): string {
  return `cf-commit-messages:${repoPath}`;
}

/** The messages committed here from this box, newest first — per machine, so localStorage. */
export function readMessageHistory(repoPath: string): string[] {
  try {
    const raw = localStorage.getItem(historyKey(repoPath));
    const value = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function rememberMessage(repoPath: string, message: string): void {
  const text = message.trim();
  if (!text) return;
  const next = [text, ...readMessageHistory(repoPath).filter((entry) => entry !== text)].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(historyKey(repoPath), JSON.stringify(next));
  } catch {
    // Storage refused: the history simply does not grow on this machine.
  }
}

/** What ↑ walks: this box's own messages first, then the repository's recent subjects, once each. */
export function messageHistory(own: string[], subjects: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...own, ...subjects]) {
    const text = entry.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= HISTORY_MAX) break;
  }
  return out;
}
