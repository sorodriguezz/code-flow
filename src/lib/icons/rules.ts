/**
 * The user's own file and folder iconography: an ordered list of rules, first match wins.
 *
 * # One string says everything
 *
 * A rule is written the way a `.gitignore` line is written, because that is the notation every
 * developer already reads without thinking:
 *
 * | Written        | Means                                  |
 * |----------------|----------------------------------------|
 * | `*.spec.ts`    | files ending in `.spec.ts`             |
 * | `src/`         | the folder called `src`                |
 * | `test*`        | files starting with `test`             |
 * | `*migration*`  | anything with `migration` in the name  |
 * | `Dockerfile`   | that exact file                        |
 *
 * The first shape of this feature asked for the same three facts through a text box and two
 * dropdowns, which is five controls per rule and two rows of chrome to say `*.spec.ts`. The `*` and
 * the trailing `/` are not arbitrary punctuation to be memorised — they are a convention, and the
 * panel prints the sentence it parsed underneath the field, so a pattern that means something other
 * than what was intended says so while it is being typed rather than by quietly matching nothing.
 *
 * # Parsed once, stored structured
 *
 * The string is the *interface*, not the storage. It is parsed when edited and stored as the three
 * fields below, so matching a path — which happens for every row of every tree, several hundred
 * times a repaint — never re-parses anything.
 *
 * **Order is the disambiguator, and it is the user's.** `*.spec.ts` and `*.ts` both match
 * `user.spec.ts`, and no reading of the two patterns decides which was meant — the list does, top
 * down.
 */

export type IconRuleTarget = "file" | "folder";

export type IconRuleMatch =
  /** The whole name, exactly: `Dockerfile`, `src/`. */
  | "name"
  /** Ends with. The one that answers `*.spec.ts`, `*.service.ts`, `*.module.css`. */
  | "suffix"
  /** Starts with: `test*`, `use*`. */
  | "prefix"
  /** Anywhere in the name: `*migration*`. */
  | "contains";

export interface IconRule {
  id: string;
  target: IconRuleTarget;
  match: IconRuleMatch;
  /** Compared case-insensitively: `SRC` and `src` are the same folder to everyone but the disk. */
  pattern: string;
  /** Catalogue id — `vscode-icons:folder-type-src`. See `catalog.ts`. */
  icon: string;
  /** Off keeps the rule in the list without applying it, which is how you test what a lower rule
   * would do without losing the one above it. */
  enabled: boolean;
}

/** Whether one rule claims this name. `name` is the basename, not the path: a rule about `src` is
 * about folders called src, not about every file under one. */
export function ruleMatches(rule: IconRule, name: string, isFolder: boolean): boolean {
  if (!rule.enabled) return false;
  if ((rule.target === "folder") !== isFolder) return false;
  const pattern = rule.pattern.trim().toLowerCase();
  if (!pattern) return false;
  const candidate = name.toLowerCase();
  switch (rule.match) {
    case "name":
      return candidate === pattern;
    case "suffix":
      return candidate.endsWith(pattern);
    case "prefix":
      return candidate.startsWith(pattern);
    case "contains":
      return candidate.includes(pattern);
  }
}

/** The catalogue icon for a path, or `null` to leave it to the built-in Lucide set. */
export function customIconFor(rules: IconRule[], path: string, isFolder: boolean): string | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (!name) return null;
  return rules.find((rule) => ruleMatches(rule, name, isFolder))?.icon ?? null;
}

/**
 * What a fresh install starts with.
 *
 * Enough to make the feature visible without anyone opening the panel — and every one of them is a
 * convention this app's own repository uses, so the examples double as a demonstration of each
 * match kind. Not a full icon theme: the built-in Lucide table already covers extensions, and a
 * hundred shipped rules would be a list nobody could find their own two rules in.
 */
export const DEFAULT_ICON_RULES: IconRule[] = [
  { id: "d-spec", target: "file", match: "suffix", pattern: ".spec.ts", icon: "vscode-icons:file-type-testts", enabled: true },
  { id: "d-test", target: "file", match: "suffix", pattern: ".test.ts", icon: "vscode-icons:file-type-testts", enabled: true },
  { id: "d-service", target: "file", match: "suffix", pattern: ".service.ts", icon: "vscode-icons:file-type-ng-service-ts", enabled: true },
  { id: "d-component", target: "file", match: "suffix", pattern: ".component.ts", icon: "vscode-icons:file-type-ng-component-ts", enabled: true },
  { id: "d-module", target: "file", match: "suffix", pattern: ".module.ts", icon: "vscode-icons:file-type-ng-module-ts", enabled: true },
  { id: "d-src", target: "folder", match: "name", pattern: "src", icon: "vscode-icons:folder-type-src", enabled: true },
  { id: "d-components", target: "folder", match: "name", pattern: "components", icon: "vscode-icons:folder-type-component", enabled: true },
  { id: "d-tests", target: "folder", match: "name", pattern: "tests", icon: "vscode-icons:folder-type-test", enabled: true },
  { id: "d-node-modules", target: "folder", match: "name", pattern: "node_modules", icon: "vscode-icons:folder-type-node", enabled: true },
  { id: "d-git", target: "folder", match: "name", pattern: ".git", icon: "vscode-icons:folder-type-git", enabled: true },
];

/**
 * Reads a written pattern into a rule's three fields.
 *
 * Deliberately total: anything at all parses to *something*, because this runs on every keystroke
 * while a pattern is half-typed and a parser that threw would make the field flicker between a rule
 * and an error. `*` alone, or an empty string, yields a rule with an empty pattern — which
 * `ruleMatches` refuses, so a half-written rule matches nothing rather than everything.
 */
export function parseIconPattern(input: string): Pick<IconRule, "target" | "match" | "pattern"> {
  const trimmed = input.trim();
  // The trailing slash is the folder marker, exactly as in a `.gitignore`. Taken off before the
  // stars are read, so `src/` and `*-spec/` both work.
  const folder = trimmed.endsWith("/");
  const body = (folder ? trimmed.slice(0, -1) : trimmed).trim();
  const target: IconRuleTarget = folder ? "folder" : "file";

  const leading = body.startsWith("*");
  const trailing = body.endsWith("*") && body.length > 1;
  const core = body.slice(leading ? 1 : 0, trailing ? -1 : undefined);

  if (leading && trailing) return { target, match: "contains", pattern: core };
  if (leading) return { target, match: "suffix", pattern: core };
  if (trailing) return { target, match: "prefix", pattern: core };
  return { target, match: "name", pattern: core };
}

/** The inverse, for showing a stored rule in the field. */
export function formatIconPattern(rule: Pick<IconRule, "target" | "match" | "pattern">): string {
  const slash = rule.target === "folder" ? "/" : "";
  switch (rule.match) {
    case "name":
      return `${rule.pattern}${slash}`;
    case "suffix":
      return `*${rule.pattern}${slash}`;
    case "prefix":
      return `${rule.pattern}*${slash}`;
    case "contains":
      return `*${rule.pattern}*${slash}`;
  }
}

/** The translation key that describes what a rule does, for the line under the field. Takes the key
 * rather than the sentence so the panel can interpolate the pattern in either language. */
export function iconPatternDescription(rule: Pick<IconRule, "target" | "match">): string {
  return `icons.says.${rule.target}.${rule.match}`;
}

/** Whether two rules claim exactly the same thing. Compared on the parsed fields and not on the
 * written string, so `src/` and ` SRC/ ` are the one rule they obviously are. */
export function sameRuleTarget(a: IconRule, b: IconRule): boolean {
  return (
    a.target === b.target &&
    a.match === b.match &&
    a.pattern.trim().toLowerCase() === b.pattern.trim().toLowerCase()
  );
}

/**
 * Whether a rule is worth showing for a search.
 *
 * Two ways in, because there are two things people type. Sometimes it is *the pattern* — "spec",
 * looking for the rule they wrote. Sometimes it is **a name they saw in the tree** — "src",
 * "srctest", "user.spec.ts" — asking which rule claims it, which is the question the panel exists
 * to answer and the one a plain text filter over patterns cannot: nothing about the string `src`
 * appears in `*.ts`, yet `src.ts` is exactly what that rule draws.
 *
 * Disabled rules answer too. "Why does this file not have my icon" is most often answered by a rule
 * that is turned off, and hiding it from the search would hide the answer.
 */
export function ruleMatchesSearch(rule: IconRule, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (formatIconPattern(rule).toLowerCase().includes(needle)) return true;
  // A trailing slash is the user saying "as a folder"; without one, either could be meant.
  const asFolder = needle.endsWith("/");
  const name = asFolder ? needle.slice(0, -1) : needle;
  const live = { ...rule, enabled: true };
  if (asFolder) return ruleMatches(live, name, true);
  return ruleMatches(live, name, true) || ruleMatches(live, name, false);
}
