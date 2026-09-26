/**
 * Does an installed tool satisfy what a framework says it needs?
 *
 * The requirements come from three registries in three dialects, verbatim — npm's `engines.node`
 * (`^20.19.0 || >=22.12.0`), PyPI's `requires-python` (`>=3.10`, `>=3.8,<4`, `~=3.10`), and
 * Composer's `require.php` (`^8.2`, `^7.3|^8.0`) — and the versions they are checked against are the
 * `major.minor.patch` the backend normalises every tool's output to. Each dialect is lowered to the
 * same thing, a union of intervals, and checked there.
 *
 * Deliberately partial: prerelease tags and build metadata are ignored, because what is being tested
 * is a runtime on a developer's machine (a stable `v24.13.0`), never a prerelease. A comparator it
 * cannot read makes the range unreadable, and an unreadable range is reported as satisfied — the
 * panel is advice, and refusing to build because a registry wrote a constraint oddly would be worse
 * than letting the generator have its own say.
 */

export type Dialect = "npm" | "pep440" | "composer";

type Triple = [number, number, number];

/** One bound. `ne` excludes a half-open interval (PEP 440's `!=3.0.*`). */
type Comparator =
  | { op: ">=" | ">" | "<" | "<="; v: Triple }
  | { op: "ne"; from: Triple; to: Triple };

export function parseTriple(raw: string): Triple | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function compareTriples(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Compares two version strings as `major.minor.patch`; unparsable sorts last. */
export function compareVersions(a: string, b: string): number {
  const x = parseTriple(a);
  const y = parseTriple(b);
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  return compareTriples(x, y);
}

/** A partial version — `1`, `1.2`, `1.2.x`, `*` — as the numbers given and how many there were. */
function partial(raw: string): { v: Triple; given: number } | null {
  const text = raw.trim().replace(/^v/, "").replace(/[-+].*$/, "");
  if (text === "" || text === "*" || text === "x" || text === "X") return { v: [0, 0, 0], given: 0 };
  const parts = text.split(".");
  const nums: number[] = [];
  for (const part of parts.slice(0, 3)) {
    if (part === "*" || part === "x" || part === "X") break;
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  const given = nums.length;
  while (nums.length < 3) nums.push(0);
  return { v: [nums[0], nums[1], nums[2]], given };
}

/** The first version past everything `v` covers at `given` components: `1.2` → `1.3.0`. */
function bump(v: Triple, given: number): Triple {
  if (given <= 1) return [v[0] + 1, 0, 0];
  if (given === 2) return [v[0], v[1] + 1, 0];
  return [v[0], v[1], v[2] + 1];
}

/** `[from, to)` as comparators. */
function between(from: Triple, to: Triple): Comparator[] {
  return [
    { op: ">=", v: from },
    { op: "<", v: to },
  ];
}

function caret(p: { v: Triple; given: number }): Comparator[] {
  const [major, minor, patch] = p.v;
  if (p.given === 0) return [];
  if (major > 0 || p.given === 1) return between(p.v, [major + 1, 0, 0]);
  if (minor > 0 || p.given === 2) return between(p.v, [0, minor + 1, 0]);
  return between(p.v, [0, 0, patch + 1]);
}

/** One comparator token in `dialect`, lowered to bounds. `null` when it cannot be read. */
function comparator(token: string, dialect: Dialect): Comparator[] | null {
  const match = /^(\^|~=|~>|~|>=|<=|>|<|===|==|!=|=)?\s*(.*)$/.exec(token.trim());
  if (!match) return null;
  const op = match[1] ?? "";
  const rest = match[2].replace(/@\w+$/, ""); // Composer stability flags: `^8.2@dev`.
  const p = partial(rest);
  if (!p) return null;

  switch (op) {
    case "^":
      return caret(p);
    case "~=": {
      // PEP 440 compatible release: `~=3.10` → >=3.10, ==3.*; `~=3.10.2` → >=3.10.2, ==3.10.*.
      if (p.given < 2) return null;
      return between(p.v, bump(p.v, p.given - 1));
    }
    case "~":
    case "~>": {
      if (p.given === 0) return [];
      // Composer's tilde lets the last component given move (`~8.2` → <9.0); npm's pins the minor
      // whenever one is given (`~1.2` → <1.3.0).
      if (dialect === "composer") return between(p.v, bump(p.v, Math.max(1, p.given - 1)));
      return between(p.v, bump(p.v, Math.min(p.given, 2)));
    }
    case ">=":
      return [{ op: ">=", v: p.v }];
    case ">":
      // `>1.2` means past every 1.2.x.
      return p.given === 0 ? null : [{ op: ">=", v: bump(p.v, p.given) }];
    case "<=":
      return p.given === 0 ? [] : [{ op: "<", v: bump(p.v, p.given) }];
    case "<":
      return [{ op: "<", v: p.v }];
    case "!=": {
      if (p.given === 0) return null;
      const wildcard = /\.\*$/.test(rest.trim());
      return [{ op: "ne", from: p.v, to: wildcard ? bump(p.v, p.given) : [p.v[0], p.v[1], p.v[2] + 1] }];
    }
    default: {
      // Bare or `=`/`==`/`===`. A partial (`1.2`, `3.12.*`, `8.2.x`) is the whole of what it names;
      // three components are one exact version.
      if (p.given === 0) return [];
      if (p.given === 3 && !/\*|x/i.test(rest)) return between(p.v, [p.v[0], p.v[1], p.v[2] + 1]);
      return between(p.v, bump(p.v, p.given));
    }
  }
}

/** A range lowered to a union of intersections. `null` when any part of it cannot be read. */
export function parseRange(range: string, dialect: Dialect): Comparator[][] | null {
  const alternatives =
    dialect === "pep440" ? [range] : range.split(dialect === "composer" ? /\s*\|\|?\s*/ : /\s*\|\|\s*/);
  const sets: Comparator[][] = [];
  for (const alternative of alternatives) {
    const trimmed = alternative.trim();
    if (trimmed === "") {
      sets.push([]);
      continue;
    }
    // npm's hyphen range: `1.2 - 2.3.4`.
    const hyphen = dialect === "npm" ? /^(\S+)\s+-\s+(\S+)$/.exec(trimmed) : null;
    if (hyphen) {
      const from = partial(hyphen[1]);
      const to = partial(hyphen[2]);
      if (!from || !to) return null;
      sets.push([
        { op: ">=", v: from.v },
        to.given === 3 ? { op: "<", v: [to.v[0], to.v[1], to.v[2] + 1] } : { op: "<", v: bump(to.v, to.given) },
      ]);
      continue;
    }
    // Operators may be written apart from their version (`>= 3.8`); glue them back before splitting.
    const glued = trimmed.replace(/(\^|~=|~>|~|>=|<=|>|<|===|==|!=|=)\s+/g, "$1");
    const tokens = glued.split(dialect === "npm" ? /\s+/ : /[\s,]+/).filter(Boolean);
    const set: Comparator[] = [];
    for (const token of tokens) {
      const bounds = comparator(token, dialect);
      if (!bounds) return null;
      set.push(...bounds);
    }
    sets.push(set);
  }
  return sets;
}

function passes(v: Triple, c: Comparator): boolean {
  switch (c.op) {
    case ">=":
      return compareTriples(v, c.v) >= 0;
    case ">":
      return compareTriples(v, c.v) > 0;
    case "<":
      return compareTriples(v, c.v) < 0;
    case "<=":
      return compareTriples(v, c.v) <= 0;
    case "ne":
      return compareTriples(v, c.from) < 0 || compareTriples(v, c.to) >= 0;
  }
}

/**
 * Whether `version` is inside `range`. An empty or unreadable range, or an unparsable version, is
 * satisfied — see the note at the top of this file.
 */
export function satisfies(version: string, range: string | null | undefined, dialect: Dialect): boolean {
  if (!range || !range.trim()) return true;
  const v = parseTriple(version);
  const sets = parseRange(range, dialect);
  if (!v || !sets) return true;
  return sets.some((set) => set.every((c) => passes(v, c)));
}

/** A range as one line of text for the panel: whitespace collapsed, nothing else changed. */
export function describeRange(range: string): string {
  return range.replace(/\s*\|\|\s*/g, " || ").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();
}

/** The shape of a registry line this needs — see `VersionLine` in `./api`. */
interface Line {
  version: string;
  channel: string;
  eol: boolean;
}

/**
 * The line to offer first for `range`: a supported LTS that satisfies it, else the newest supported
 * line that does, else the newest supported one at all — so an install always has a default, and the
 * default is never a line past its end of life when a living one would do.
 */
export function pickLine<T extends Line>(lines: T[], range: string | null | undefined, dialect: Dialect): T | null {
  const living = lines.filter((line) => !line.eol);
  const fits = (line: T) => satisfies(line.version, range, dialect);
  return living.find((line) => line.channel === "lts" && fits(line)) ?? living.find(fits) ?? living[0] ?? lines[0] ?? null;
}
