/** Tagged comments — `// TODO:`, `# FIXME:`, `<!-- NOTE: -->` — lifted out of the source and
 * turned into something navigable, the way VS Code's Comment Anchors does it.
 *
 * The parsing is deliberately line-based and language-agnostic: an anchor is a known tag sitting
 * immediately after *some* comment opener. That's a heuristic, not a parser, and it's the right
 * trade — a real one would need a grammar per language for a feature whose whole value is that it
 * works everywhere, in every file type, including the ones this editor has no tokenizer for.
 */

export interface AnchorTag {
  id: string;
  /** Dot / gutter / ruler colour. Fixed hex rather than a theme variable: these have to stay
   * distinguishable from *each other*, which a palette derived from one accent can't guarantee.
   * Mirrored by the `.cf-anchor-*` gutter rules in `index.css` — adding a tag here means adding
   * a rule there. */
  color: string;
}

/** The tags recognised in source comments. Order is display order in the panel's legend. */
export const ANCHOR_TAGS: AnchorTag[] = [
  { id: "ANCHOR", color: "#10b981" },
  { id: "TODO", color: "#3b82f6" },
  { id: "FIXME", color: "#ef4444" },
  { id: "BUG", color: "#e11d48" },
  { id: "HACK", color: "#f97316" },
  { id: "NOTE", color: "#f59e0b" },
  { id: "REVIEW", color: "#84cc16" },
  { id: "OPTIMIZE", color: "#14b8a6" },
  { id: "SECTION", color: "#8b5cf6" },
  { id: "LINK", color: "#06b6d4" },
  { id: "STUB", color: "#a855f7" },
  { id: "IDEA", color: "#ec4899" },
  { id: "XXX", color: "#94a3b8" },
];

const TAG_BY_ID = new Map(ANCHOR_TAGS.map((tag) => [tag.id, tag]));

export function anchorColor(tagId: string): string {
  return TAG_BY_ID.get(tagId)?.color ?? "#94a3b8";
}

/** Class applied to the tag word itself inside the comment — see the `.cf-anchor-*` rules in
 * `index.css`. Colouring the word (rather than marking the gutter) keeps anchors out of the
 * margin the git change bars and breakpoints already share. */
export function anchorTagClass(tagId: string): string {
  return `cf-anchor cf-anchor-${tagId.toLowerCase()}`;
}

/** Every comment opener across the languages this editor opens: C-family, shell/Python/YAML,
 * SQL/Lua/Haskell, HTML/XML, Lisp/ini, LaTeX/Erlang, and Python docstrings. The lone `*` catches
 * continuation lines inside a block comment (and, harmlessly, Markdown bullets). */
const COMMENT_OPENER = String.raw`(?://+|/\*+|\*+|#+|--+|<!--+|;+|%+|"""|''')`;

/**
 * The pattern that finds anchors, shared by the in-editor scan and the project-wide one.
 *
 * Both sides *must* build it from here: the project scan runs through the repo-search backend
 * (Rust's `regex` crate) and its hits are then re-parsed here to pull the tag and message out. If
 * the two patterns drifted, the panel would list files the second pass then finds nothing in.
 * Kept to syntax both engines accept — no lookaround, no backreferences.
 */
export function anchorPatternSource(tagIds: string[] = ANCHOR_TAGS.map((t) => t.id)): string {
  // `\b` after the tag stops `TODOS` from reading as a `TODO`; the separator is optional so a
  // bare `// ANCHOR` marker still counts.
  return `${COMMENT_OPENER}\\s*(${tagIds.join("|")})\\b[:\\-]?[ \\t]*`;
}

export interface Anchor {
  tag: string;
  /** 1-based, matching what Monaco and the search backend both speak. */
  line: number;
  /** 1-based column of the tag itself — where the editor puts the caret when you jump. */
  column: number;
  /** Whatever follows the tag on that line, trimmed of trailing comment closers. Empty for a
   * bare marker, in which case the panel shows the tag alone. */
  text: string;
}

// A trailing block-comment or HTML close belongs to the comment syntax, not to the note the
// developer wrote, so it's cut before the text reaches the panel.
function stripCommentClose(text: string): string {
  return text.replace(/\s*(?:\*+\/|-->|\*+)\s*$/, "").trim();
}

/** Every anchor on one line — more than one is unusual but legal (`// TODO: a // NOTE: b`). */
function anchorsOnLine(line: string, lineNumber: number, pattern: RegExp): Anchor[] {
  const found: Anchor[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const tag = match[1];
    const rest = line.slice(match.index + match[0].length);
    // Two anchors on one line: the first one's text ends where the second one's opener starts.
    const nextPattern = new RegExp(pattern.source, "g");
    const next = nextPattern.exec(rest);
    found.push({
      tag,
      line: lineNumber,
      column: line.indexOf(tag, match.index) + 1,
      text: stripCommentClose(next ? rest.slice(0, next.index) : rest),
    });
    // A zero-width match would spin forever; the opener guarantees at least one character, but
    // guarding is cheaper than trusting it.
    if (pattern.lastIndex === match.index) pattern.lastIndex++;
  }
  return found;
}

/** Scans a whole file. `enabled` narrows the tag set — an empty set means "all of them", since a
 * filter that hides everything is never what a cleared checkbox list is asking for. */
export function parseAnchors(source: string, enabled?: ReadonlySet<string>): Anchor[] {
  const tagIds = ANCHOR_TAGS.map((t) => t.id).filter((id) => !enabled || enabled.size === 0 || enabled.has(id));
  if (tagIds.length === 0) return [];
  const pattern = new RegExp(anchorPatternSource(tagIds), "g");
  const anchors: Anchor[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    anchors.push(...anchorsOnLine(lines[i], i + 1, pattern));
  }
  return anchors;
}

/** Re-reads one line the search backend already matched, so a project-wide hit carries the same
 * tag and message a locally-parsed one does. Returns `null` for a line the backend matched but
 * this pass doesn't — which shouldn't happen, and is dropped rather than shown half-parsed. */
export function parseAnchorLine(line: string, lineNumber: number, enabled?: ReadonlySet<string>): Anchor | null {
  const tagIds = ANCHOR_TAGS.map((t) => t.id).filter((id) => !enabled || enabled.size === 0 || enabled.has(id));
  if (tagIds.length === 0) return null;
  const pattern = new RegExp(anchorPatternSource(tagIds), "g");
  return anchorsOnLine(line, lineNumber, pattern)[0] ?? null;
}
