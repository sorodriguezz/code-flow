/**
 * Where things *are* in a `package.json`, which is the one question `JSON.parse` cannot answer.
 *
 * The editor annotations — a run button beside each script, a box over `dependencies` — need line
 * numbers, and parsing throws every position away the moment it builds the object. So this walks the
 * raw text and reports the line each key sits on.
 *
 * # Why a scanner and not a regular expression
 *
 * The obvious `/^\s*"([^"]+)"\s*:/` finds keys and also finds every *string value* shaped like one,
 * every key inside `jest.moduleNameMapper`, and the contents of a description that happens to
 * contain a quoted word and a colon. A `package.json` is full of nested objects whose keys are
 * spelled exactly like the ones being looked for — `dependencies` appears again inside
 * `pnpm.overrides`, and `build` is both a script and a field in half the tool configs. Depth is the
 * only thing that tells them apart, and depth needs a scanner that knows when it is inside a string.
 *
 * # What it deliberately does not do
 *
 * It does not validate. A file this refuses to make sense of yields no annotations, and the editor
 * simply shows none — the parse in `packageScripts.ts` is what decides whether a manifest is
 * readable at all, and there is exactly one such decision in the app.
 */

/** A key found in the document, and where. */
export interface KeyPosition {
  /** The key itself, unescaped for the ordinary cases (`\"` and `\\`). */
  key: string;
  /** 1-based, because that is what Monaco counts in. */
  line: number;
  /**
   * The chain of enclosing object keys, outermost first. A top-level key has an empty path; a
   * script has `["scripts"]`.
   */
  path: string[];
}

/** How deep a key can be before it stops being anything this app draws. Two is `scripts.build`. */
const MAX_DEPTH = 2;

/**
 * Every object key in the document down to `MAX_DEPTH`, with its line and its ancestry.
 *
 * One pass, no allocation per character. Arrays are counted as containers so a key inside an object
 * inside an array does not report the depth of its grandparent, but their indices are not paths —
 * nothing here needs to address the third element of `files`.
 */
export function scanKeys(raw: string): KeyPosition[] {
  const found: KeyPosition[] = [];
  /**
   * The enclosing object keys, innermost last.
   *
   * A segment is pushed only for an object that a *key* introduced. The document's own outermost
   * `{` did not come after a key, and neither does an object sitting inside an array, so neither
   * contributes one — which is what makes a top-level key's path empty and a script's exactly
   * `["scripts"]`. Pushing for the root instead offset every path by one and made every lookup here
   * miss.
   */
  const path: string[] = [];
  /** Containers entered. `named` records whether this one pushed onto `path`, so the matching close
   *  pops exactly what its open pushed rather than guessing from the bracket. */
  const stack: { kind: "object" | "array"; named: boolean }[] = [];
  /** The most recent complete key at this depth, waiting to find out whether a `{` follows it. */
  let pendingKey: string | null = null;

  let line = 1;
  let at = 0;

  while (at < raw.length) {
    const ch = raw[at];

    if (ch === "\n") {
      line += 1;
      at += 1;
      continue;
    }

    if (ch === '"') {
      // Read the whole string in one go, honouring escapes, so a `{` or a `:` inside it can never
      // be mistaken for structure. This is the entire reason the function exists.
      const start = at + 1;
      let text = "";
      at = start;
      while (at < raw.length) {
        const c = raw[at];
        if (c === "\\") {
          // Only the two escapes a key realistically carries are decoded; the rest are kept as
          // written, because this string is compared against a name from `JSON.parse` and those two
          // are the ones that would differ. A `\u` sequence in a script name would not match, which
          // costs that one annotation and nothing else.
          const next = raw[at + 1];
          text += next === '"' || next === "\\" ? next : `\\${next ?? ""}`;
          at += 2;
          continue;
        }
        if (c === '"') break;
        if (c === "\n") line += 1;
        text += c;
        at += 1;
      }
      const closedAt = at;
      at += 1;

      // A string is a *key* only when the next non-space character is a colon. Anything else is a
      // value, and values are not addressed here.
      let probe = at;
      while (probe < raw.length && /\s/.test(raw[probe])) probe += 1;
      if (raw[probe] === ":") {
        // The line the key opened on, not the one it closed on — a key never spans lines in
        // practice, but reporting the opening line is the one that stays right if it ever does.
        const openedOn = line - (raw.slice(start, closedAt).match(/\n/g)?.length ?? 0);
        pendingKey = text;
        if (path.length <= MAX_DEPTH - 1) {
          found.push({ key: text, line: openedOn, path: [...path] });
        }
      }
      continue;
    }

    if (ch === "{") {
      // The key that introduced this object becomes the path segment for everything inside it. The
      // root object and an object inside an array have no such key and contribute nothing.
      const named = pendingKey !== null;
      stack.push({ kind: "object", named });
      if (named) path.push(pendingKey as string);
      pendingKey = null;
      at += 1;
      continue;
    }

    if (ch === "[") {
      stack.push({ kind: "array", named: false });
      pendingKey = null;
      at += 1;
      continue;
    }

    if (ch === "}" || ch === "]") {
      const container = stack.pop();
      if (container?.named) path.pop();
      pendingKey = null;
      at += 1;
      continue;
    }

    // A comma ends whatever value was being read, so the key it belonged to is spent.
    if (ch === ",") pendingKey = null;
    at += 1;
  }

  return found;
}

/** The line each `scripts` entry sits on, keyed by script name. Empty when there is no such block. */
export function scriptLines(raw: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (const entry of scanKeys(raw)) {
    if (entry.path.length === 1 && entry.path[0] === "scripts") lines.set(entry.key, entry.line);
  }
  return lines;
}

/**
 * The line the `scripts` key itself is on, or `null`.
 *
 * Its own function rather than a field on `scriptLines`, because it answers a different question:
 * that map is about the entries, this is about the heading the package-manager box floats over.
 */
export function scriptsBlockLine(raw: string): number | null {
  const header = scanKeys(raw).find((entry) => entry.path.length === 0 && entry.key === "scripts");
  return header?.line ?? null;
}

/** The blocks the dependency box annotates, in the order they appear. */
export const DEPENDENCY_BLOCKS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type DependencyBlockName = (typeof DEPENDENCY_BLOCKS)[number];

export interface DependencyBlock {
  name: DependencyBlockName;
  /** The line the block's own key is on — where the box floats. */
  line: number;
  /** Each dependency in it, and the line it sits on. */
  entries: Map<string, number>;
}

/**
 * The dependency blocks present in the document, with the line of every entry.
 *
 * Only the four npm actually installs from. `pnpm.overrides` and `resolutions` are dependency-shaped
 * and are not dependencies: reporting a "latest version" for a pin whose entire purpose is to *not*
 * be the latest would be advice pointing the wrong way.
 */
export function dependencyBlocks(raw: string): DependencyBlock[] {
  const keys = scanKeys(raw);
  const blocks: DependencyBlock[] = [];

  for (const name of DEPENDENCY_BLOCKS) {
    const header = keys.find((entry) => entry.path.length === 0 && entry.key === name);
    if (!header) continue;
    const entries = new Map<string, number>();
    for (const entry of keys) {
      if (entry.path.length === 1 && entry.path[0] === name) entries.set(entry.key, entry.line);
    }
    blocks.push({ name, line: header.line, entries });
  }

  // Document order, so the boxes read down the file rather than in the order the list above happens
  // to name them.
  return blocks.sort((a, b) => a.line - b.line);
}
