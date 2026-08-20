import type { FileEntry } from "../types/domain";

/**
 * Which files the explorer draws *underneath* another file: a spec under its source, the lockfiles
 * under `package.json`, a compiled `.js` under the `.ts` it came from.
 *
 * **Nothing here touches the disk.** Same class of thing as `hiddenFilesStore`: a view arrangement
 * over one already-loaded directory listing. The paths in git, in search and in the tabs are
 * untouched, and `list_dir` remains the only truth about what exists.
 *
 * # The layout is a SUBTRACTION, never a construction
 *
 * The obvious implementation walks the patterns and *builds* a list of rows to draw. It is also the
 * one that loses files: every branch that forgets to emit an entry — a parent that matched but was
 * filtered out, a chain, a child claimed twice — is a file that silently stops being drawn, and a
 * file explorer that sometimes doesn't show a file is worse than one with no nesting at all.
 *
 * So `roots` is `entries` minus the entries that got a parent, and `parentOf` may only ever point
 * at a *root*. Those two facts together make "the file vanished" unrepresentable rather than
 * merely unlikely: to disappear, an entry would have to be absent from `roots` (so something
 * claimed it) while its parent is absent too (so the parent was claimed as well) — and a claimed
 * parent is not what `parentOf` stores, because step 6 walks every claim up to the first entry
 * nobody claimed before writing it down. The check a reader can run in their head, for any
 * directory: `roots.length + Σ childrenOf === entries.length`.
 *
 * # Depth is exactly one, and chains collapse
 *
 * `user.ts` takes in `user.spec.ts`; `user.spec.ts` would itself take in `user.spec.js`. Nesting
 * that faithfully would put `user.spec.js` two levels down, behind two twisties, which is a
 * directory tree growing a second directory tree inside a single folder — and a file three
 * indents from where its path says it is reads as being in a subfolder that does not exist.
 * Chains collapse to their root instead: `user.ts` takes in both. One twisty, one indent, and the
 * set of rows under a parent is exactly "everything the patterns say derives from this file".
 *
 * # Unlike `lib/icons/rules.ts`, the ORDER of the list means nothing
 *
 * There, order is the whole disambiguation: `*.spec.ts` and `*.ts` both claim `user.spec.ts` and
 * only the user can say which was meant, so the list decides top-down. Here the question is not
 * "which pattern" but "which of two files is the parent", and that has an answer nobody has to
 * write down: the **longer parent name** wins, because `user.service.ts` is a more specific origin
 * for `user.service.spec.ts` than `user.ts` is. Making order significant here would mean asking
 * the user to rank patterns to get an answer the filenames already give. Ties (two parents of
 * equal name length) go to whichever came first in the listing, which is stable because `list_dir`
 * is.
 *
 * # `children` is a `string[]`, though the panel edits one comma-separated line
 *
 * The same trade `rules.ts` makes: the written string is the *interface*, not the storage. It is
 * split when edited and stored split, so matching — which runs over every entry of every listing —
 * never re-parses a line. `parseChildren`/`formatChildren` are the only two places the two forms
 * meet.
 */

/**
 * One rule: a parent, and the templates for the files it takes in.
 *
 * `parent` is a filename with at most one `*` (`*.ts`, `package.json`). `children` are templates
 * expanded against the parent's capture (`${capture}.spec.ts`) and may themselves hold a `*`
 * (`tsconfig.*.json`, `.env.*`) for the families whose members are not derivable from one name.
 */
export interface NestingPattern {
  id: string;
  parent: string;
  children: string[];
  /** Off keeps the rule in the list without applying it — how you find out which pattern is
   *  responsible for a nest you did not expect, without losing the pattern. */
  enabled: boolean;
}

/** How one directory listing is drawn. */
export interface NestingLayout {
  /** The rows drawn at the directory's own indent — `entries` minus everything that got a parent,
   *  so folders stay first and `list_dir`'s order survives. */
  roots: FileEntry[];
  /** Parent path → the entries drawn under it, in listing order. Keys are always members of
   *  `roots`. */
  childrenOf: Map<string, FileEntry[]>;
  /** Child path → parent path, for the callers that need to point at a row that may be inside a
   *  closed nest. Values are always members of `roots`. */
  parentOf: Map<string, string>;
}

/**
 * The empty results, as module-level constants.
 *
 * Both exist so the "nesting is off" branch in `FileTree` can hand its rows the *same object
 * identity* on every render. `TreeNode` is `memo`'d on the assumption that every prop is stable,
 * and a fresh `new Map()` per render would turn the whole tree into a per-row comparison that
 * stops nothing — making the feature cost repaints precisely when it is switched off.
 */
export const EMPTY_NESTS: ReadonlyMap<string, FileEntry[]> = new Map();
export const EMPTY_PARENTS: ReadonlyMap<string, string> = new Map();

/**
 * Whether `name` is a parent under `pattern`, and what the first `*` captured.
 *
 * Returns the captured text, `""` for a pattern with no `*` that matched exactly, or `null` for no
 * match — so callers test against `null` rather than against emptiness, since an exact-name parent
 * legitimately captures nothing.
 *
 * **More than one `*` is allowed**, and the extra ones are what make "a name with a role segment in
 * it" expressible: `*.*.ts` is every `x.controller.ts` and no `user.ts`, which is the difference
 * between a file that is a by-product of its neighbour and one that is its sibling. Only the first
 * star is captured — the rest are anonymous — because `${capture}` is one hole and numbering them
 * would be a small language in a settings field. A rule that needs the whole stem uses
 * `${basename}`, which is what the shipped `n-suffix-ts` does.
 *
 * Compared case-insensitively, on the same reasoning as `ruleMatches`: macOS and Windows do not
 * distinguish either, so a pattern that worked on one machine and not on a colleague's would be a
 * difference nobody could see by reading the two.
 */
export function matchParent(pattern: string, name: string): string | null {
  const parts = pattern.toLowerCase().split("*");
  if (parts.length === 1) return pattern.toLowerCase() === name.toLowerCase() ? "" : null;

  const lower = name.toLowerCase();
  const head = parts[0];
  const tail = parts[parts.length - 1];
  // The length guard is what stops head and tail from overlapping: without it `a*a` would "match"
  // the name `a` by reading the same character twice and capture a negative slice.
  if (name.length < head.length + tail.length) return null;
  if (!lower.startsWith(head)) return null;
  if (!lower.endsWith(tail)) return null;

  const end = lower.length - tail.length;
  let at = head.length;
  // Where the first star's run stops: the start of the first literal that follows it, or the tail
  // when there is nothing in between.
  let capturedTo = end;
  let firstLiteral = true;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const found = lower.indexOf(part, at);
    if (found < 0 || found + part.length > end) return null;
    if (firstLiteral) {
      capturedTo = found;
      firstLiteral = false;
    }
    at = found + part.length;
  }

  // Sliced out of the original, not the lowercased copy: the capture is fed back into child names
  // (which are matched case-insensitively anyway) and into the panel's preview line, where seeing
  // your own casing is the point.
  return name.slice(head.length, capturedTo);
}

/**
 * Fills a child template in.
 *
 * Exactly three placeholders, and deliberately no more: `${capture}` (what the parent's `*` took),
 * `${basename}` (the parent's name without its last extension) and `${extname}` (that extension,
 * without the dot). Anything richer — a regex, an index, arithmetic — would be a small language
 * inside a settings field, and the failure mode of a small language is that it fails silently: the
 * pattern nests nothing and there is nowhere to read why.
 */
export function expandTemplate(template: string, capture: string, parentName: string): string {
  const dot = parentName.lastIndexOf(".");
  const basename = dot > 0 ? parentName.slice(0, dot) : parentName;
  const extname = dot > 0 ? parentName.slice(dot + 1) : "";
  return template.replace(/\$\{(capture|basename|extname)\}/g, (_, token: string) =>
    token === "capture" ? capture : token === "basename" ? basename : extname,
  );
}

/**
 * `*` matches any run of characters, possibly empty.
 *
 * Walked with `indexOf` rather than compiled to a `RegExp`, for two reasons that both matter here:
 * a user's pattern is arbitrary text and every regex metacharacter in it would need escaping (a
 * `.` in `tsconfig.*.json` is a literal dot to everyone who writes one), and this runs once per
 * candidate per glob template — thousands of times for a large listing — where building a regex
 * object is the expensive part.
 */
export function globMatches(glob: string, name: string): boolean {
  const parts = glob.toLowerCase().split("*");
  const candidate = name.toLowerCase();
  if (parts.length === 1) return candidate === parts[0];
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!candidate.startsWith(first) || !candidate.endsWith(last)) return false;
  let at = first.length;
  const end = candidate.length - last.length;
  // Head and tail must not overlap, or `*x*` would match `x` twice over.
  if (at > end) return false;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!part) continue;
    const found = candidate.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/** A claim on a child, and how strongly it is held. */
interface Claim {
  parent: string;
  /** The parent's name length. `user.service.ts` beats `user.ts` for `user.service.spec.ts`
   *  because it is the more specific origin — see the header. */
  strength: number;
}

/**
 * Breaks every cycle in `claims`, in place, so the walk that follows cannot loop forever.
 *
 * Cycles are unreachable with the shipped patterns but perfectly writable by hand — `*.a` taking
 * in `${capture}.b` while `*.b` takes in `${capture}.a` makes `x.a` and `x.b` each other's parent.
 * The member that appears *first in the listing* keeps its place as a root, because that is the
 * one answer that does not depend on which file the scan happened to start from. Each break
 * deletes one claim, and there are finitely many, so this terminates.
 */
function breakCycles(claims: Map<string, Claim>, order: Map<string, number>): void {
  /** Paths already known to reach an unclaimed root, so the ordinary acyclic case stays linear. */
  const settled = new Set<string>();
  for (const start of [...claims.keys()]) {
    while (!settled.has(start)) {
      const walked: string[] = [];
      const onPath = new Set<string>();
      let cursor = start;
      let looped = false;
      while (claims.has(cursor) && !settled.has(cursor)) {
        if (onPath.has(cursor)) {
          const cycle = walked.slice(walked.indexOf(cursor));
          const victim = cycle.reduce((a, b) =>
            (order.get(a) ?? 0) <= (order.get(b) ?? 0) ? a : b,
          );
          claims.delete(victim);
          looped = true;
          break;
        }
        onPath.add(cursor);
        walked.push(cursor);
        cursor = claims.get(cursor)!.parent;
      }
      // Re-walk from the same start after a break: the chain above the cycle is still unresolved.
      if (looped) continue;
      for (const path of walked) settled.add(path);
      settled.add(start);
    }
  }
}

/**
 * The arrangement for one directory listing.
 *
 * Only ever matches siblings against siblings — a parent in another folder is not a parent, since
 * the row would have to be drawn somewhere its path does not say it is. Directories neither nest
 * nor are nested: a folder is already a container, and its row is a real drop target that must
 * keep meaning "move into this folder".
 */
export function resolveNesting(entries: FileEntry[], patterns: NestingPattern[]): NestingLayout {
  const files = entries.filter((entry) => !entry.is_dir);
  const active = patterns.filter((pattern) => pattern.enabled && pattern.parent.trim() !== "");
  // One file cannot nest under itself, and no patterns cannot nest anything. Returning `entries`
  // by identity here (not a copy) keeps the untouched case free for the memo above.
  if (files.length < 2 || active.length === 0) {
    return { roots: entries, childrenOf: new Map(), parentOf: new Map() };
  }

  const byName = new Map<string, FileEntry>();
  const order = new Map<string, number>();
  entries.forEach((entry, index) => order.set(entry.path, index));
  // Last one wins on a case-only collision, which only a case-sensitive filesystem can produce and
  // which no pattern could have told apart anyway.
  for (const file of files) byName.set(file.name.toLowerCase(), file);

  /**
   * The listing sorted by name, so a glob child can be answered without walking all of it.
   *
   * A glob only ever matches names that **start with its leading literal** — `globMatches` says so
   * in its first line — so the candidates for `user.controller.*.ts` are a contiguous run of the
   * sorted names, found by binary search. Without this the glob branch below is a full scan per
   * parent, which is quadratic and stops being theoretical the moment a rule's parent is a shape
   * most of the directory has: a folder of 3,000 role-suffixed files took 608ms to arrange, and one
   * of 9,000 took five and a half seconds, all of it between the click and the tree appearing.
   */
  const sorted = [...files].sort((a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const keys = sorted.map((file) => file.name.toLowerCase());
  const withPrefix = (prefix: string): FileEntry[] => {
    if (!prefix) return sorted;
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (keys[mid] < prefix) low = mid + 1;
      else high = mid;
    }
    const found: FileEntry[] = [];
    for (let at = low; at < keys.length && keys[at].startsWith(prefix); at += 1) found.push(sorted[at]);
    return found;
  };

  const claims = new Map<string, Claim>();
  const claim = (child: FileEntry, parent: FileEntry) => {
    // A file is never its own child — reachable with a template like `${capture}.ts` under `*.ts`.
    if (child.path === parent.path) return;
    const held = claims.get(child.path);
    // Strictly greater, so an equally specific later parent does not displace an earlier one: the
    // tie is broken by listing order, which is stable, rather than by pattern order, which is not
    // something the user was asked to think about.
    if (held && held.strength >= parent.name.length) return;
    claims.set(child.path, { parent: parent.path, strength: parent.name.length });
  };

  for (const parent of files) {
    for (const pattern of active) {
      const capture = matchParent(pattern.parent.trim(), parent.name);
      if (capture === null) continue;
      for (const template of pattern.children) {
        const expanded = expandTemplate(template.trim(), capture, parent.name);
        if (!expanded) continue;
        const star = expanded.indexOf("*");
        if (star >= 0) {
          // A glob child (`tsconfig.*.json`, `${basename}.*.ts`): no single name to look up, so the
          // candidates are the run of names sharing its leading literal — see `withPrefix`.
          for (const candidate of withPrefix(expanded.slice(0, star).toLowerCase())) {
            if (globMatches(expanded, candidate.name)) claim(candidate, parent);
          }
        } else {
          // The overwhelmingly common shape, and the reason `byName` exists: one Map hit instead
          // of a scan, which is what keeps a directory of a few hundred files off the profile.
          const candidate = byName.get(expanded.toLowerCase());
          if (candidate) claim(candidate, parent);
        }
      }
    }
  }

  breakCycles(claims, order);

  const parentOf = new Map<string, string>();
  for (const [child, held] of claims) {
    // Up to the first entry nobody claimed. This is the chain collapse, and it is also what makes
    // `parentOf` safe to subtract from `entries`: the value written here is by construction an
    // entry with no claim on it, and therefore an entry that survives into `roots`.
    let root = held.parent;
    while (claims.has(root)) root = claims.get(root)!.parent;
    parentOf.set(child, root);
  }

  const childrenOf = new Map<string, FileEntry[]>();
  // Driven off `entries` rather than off `parentOf`, so the rows under a parent come out in the
  // same order they would have had in the directory itself.
  for (const entry of entries) {
    const parent = parentOf.get(entry.path);
    if (parent === undefined) continue;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(entry);
    else childrenOf.set(parent, [entry]);
  }

  return { roots: entries.filter((entry) => !parentOf.has(entry.path)), childrenOf, parentOf };
}

/**
 * What a fresh install nests.
 *
 * Every one of these is a derivation somebody would describe in words — "the spec of", "the
 * lockfile of", "the compiled output of" — because that is the line this list has to stay on. A
 * pattern that groups files which merely *look* related is the reason people turn the feature off.
 *
 * Which is why `*.ts` taking in `${capture}.*.ts` is **not** here, though VS Code ships something
 * like it: it would have `user.ts` swallow `user.model.ts`, and a model is a sibling module, not a
 * by-product of its neighbour.
 *
 * `n-suffix-ts` is the same idea with that objection designed out, and the difference is one star.
 * Its parent is `*.*.ts` — a name that *already carries a role segment* — so `user.ts` never
 * matches it and `user.model.ts` is never claimed by anything. What does match is
 * `user.controller.ts`, and what it takes in is `user.controller.<anything>.ts`: the docs for that
 * controller, its spec, its mock. Those are by-products by the same test as the rest of this list,
 * and enumerating the suffixes one at a time — `.docs.ts`, then the next one somebody invents —
 * is a list that is always one convention behind the codebase it is describing.
 */
export const DEFAULT_NESTING_PATTERNS: NestingPattern[] = [
  {
    id: "n-ts",
    parent: "*.ts",
    children: [
      "${capture}.spec.ts",
      "${capture}.test.ts",
      "${capture}.e2e-spec.ts",
      "${capture}.js",
      "${capture}.d.ts",
      "${capture}.js.map",
    ],
    enabled: true,
  },
  {
    id: "n-tsx",
    parent: "*.tsx",
    children: ["${capture}.spec.tsx", "${capture}.test.tsx", "${capture}.module.css", "${capture}.stories.tsx"],
    enabled: true,
  },
  {
    id: "n-js",
    parent: "*.js",
    children: ["${capture}.spec.js", "${capture}.test.js", "${capture}.js.map", "${capture}.min.js"],
    enabled: true,
  },
  {
    // Angular, and the same convention `DEFAULT_ICON_RULES` already recognises — a component is
    // four files with one name, which is the case file nesting was invented for.
    id: "n-angular",
    parent: "*.component.ts",
    children: [
      "${capture}.component.html",
      "${capture}.component.css",
      "${capture}.component.scss",
      "${capture}.component.spec.ts",
    ],
    enabled: true,
  },
  {
    // Everything hanging off a file that already names its role: `user.controller.docs.ts` and
    // `user.controller.spec.ts` under `user.controller.ts`. See the note above for why the parent
    // needs the second star, and `matchParent` for what it means.
    id: "n-suffix-ts",
    parent: "*.*.ts",
    children: ["${basename}.*.ts"],
    enabled: true,
  },
  { id: "n-vue", parent: "*.vue", children: ["${capture}.spec.ts", "${capture}.stories.ts"], enabled: true },
  { id: "n-svelte", parent: "*.svelte", children: ["${capture}.spec.ts", "${capture}.test.ts"], enabled: true },
  { id: "n-rs", parent: "*.rs", children: ["${capture}_test.rs"], enabled: true },
  { id: "n-go", parent: "*.go", children: ["${capture}_test.go"], enabled: true },
  {
    id: "n-py",
    parent: "*.py",
    children: ["test_${capture}.py", "${capture}_test.py", "${capture}.pyi"],
    enabled: true,
  },
  {
    id: "n-package",
    parent: "package.json",
    children: [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
      "npm-shrinkwrap.json",
      ".npmrc",
      ".nvmrc",
    ],
    enabled: true,
  },
  { id: "n-cargo", parent: "Cargo.toml", children: ["Cargo.lock"], enabled: true },
  { id: "n-tsconfig", parent: "tsconfig.json", children: ["tsconfig.*.json"], enabled: true },
  { id: "n-env", parent: ".env", children: [".env.*"], enabled: true },
  {
    id: "n-docker",
    parent: "Dockerfile",
    children: [".dockerignore", "docker-compose.yml", "docker-compose.*.yml"],
    enabled: true,
  },
  {
    id: "n-readme",
    parent: "README.md",
    children: ["CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "LICENSE.md", "SECURITY.md"],
    enabled: true,
  },
];

/** The comma-separated line the panel edits, read into the stored form. Blank entries are dropped
 *  rather than kept, so a trailing comma while typing does not become a template that expands to
 *  nothing and matches every file whose name is empty. */
export function parseChildren(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The inverse, for showing a stored pattern in the field. */
export function formatChildren(children: string[]): string {
  return children.join(", ");
}

/**
 * The pattern read back as the sentence it means, for the line under the fields.
 *
 * The capture is the literal `example` — a neutral placeholder, never a name out of the repository
 * that happens to be open. This is the same device `rules.ts` describes: printing what was parsed
 * while it is being typed is what lets a pattern that means something other than what was intended
 * say so, instead of quietly nesting nothing.
 */
export function previewOf(pattern: NestingPattern): { parent: string; children: string[] } {
  const parent = pattern.parent.trim().replace("*", "example");
  const capture = pattern.parent.includes("*") ? "example" : "";
  return {
    parent,
    children: pattern.children.map((template) =>
      expandTemplate(template.trim(), capture, parent).replace(/\*/g, "example"),
    ),
  };
}

/**
 * A fresh pattern id.
 *
 * The same shape as `newRuleId`, and — for the same reason that one moved out of `IconRulesPanel` —
 * next to the type it identifies rather than inside the panel: the id shape is part of what a
 * pattern *is*, and a second minter written elsewhere is a second chance to change it and only
 * remember one of them. Ids only have to be unique within one small local list, so a value off the
 * clock is enough and keeps the settings row readable when somebody opens it.
 */
export function newNestingPatternId(): string {
  return `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}
