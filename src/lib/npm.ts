import { invoke } from "@tauri-apps/api/core";

/**
 * The npm registry, as the editor's annotations see it.
 *
 * A thin binding over `src-tauri/src/npm.rs` plus the two things that are genuinely frontend
 * concerns: comparing a version against the range a manifest pins, and ordering versions by semver
 * rather than by string. Neither belongs in a transport module, and both are what decide whether the
 * box says "up to date" or offers an upgrade.
 */

export interface LatestVersion {
  name: string;
  /** Empty when the lookup failed — which is not "up to date" and must never be drawn as such. */
  latest: string;
  description: string;
  /** The registry's or the network's own sentence. Empty on success. */
  error: string;
}

export interface PackageVersions {
  name: string;
  latest: string;
  /** Every published version, in the registry's order. Sort with `bySemverDesc` before showing. */
  versions: string[];
  description: string;
}

export interface SearchHit {
  name: string;
  version: string;
  description: string;
  publisher: string;
}

export const npmLatestVersions = (names: string[]) =>
  invoke<LatestVersion[]>("npm_latest_versions", { names });

export const npmPackageVersions = (name: string) =>
  invoke<PackageVersions>("npm_package_versions", { name });

export const npmSearch = (text: string, limit?: number) =>
  invoke<SearchHit[]>("npm_search", { text, limit });

/**
 * The version a range is pinned at, with the range operator taken off.
 *
 * Not a semver range solver, and deliberately not: this exists to answer "what does the manifest
 * say" for a side-by-side against `latest`, not to decide what `pnpm install` would resolve to. That
 * answer lives in the lockfile, and a box that guessed at it would disagree with the lockfile
 * exactly when it mattered.
 *
 * `workspace:*`, `catalog:`, `file:`, `link:`, `npm:` aliases and git URLs return `null` — those are
 * not registry versions and comparing them against one would be comparing two different questions.
 */
/** A parsed dependency range: how wide it is, and the lowest version it accepts. */
export interface PinnedRange {
  /** `^`, `~`, or `""` for an exact pin. */
  operator: "^" | "~" | "";
  major: number;
  minor: number;
  patch: number;
}

/**
 * The range a manifest pins, split into how wide it is and where it starts.
 *
 * **Partial versions are accepted**, and that was a real omission: `"@types/node": "^20"` and
 * `"typescript": "^5"` are ordinary ways to write a dependency, and requiring three numbers meant
 * seven of the eight entries in a typical `devDependencies` were quietly unevaluable — counted as
 * up to date because nothing could say otherwise. A missing number means zero, which is npm's own
 * reading of `^20`.
 *
 * `workspace:*`, `catalog:`, `file:`, `link:`, `npm:` aliases and git URLs return `null` — those are
 * not registry versions, and comparing them against one would be answering a different question.
 * So does anything with a second comparator (`>=1 <2`): a real range expression is more than this
 * needs to understand, and guessing at one is worse than saying nothing.
 */
export function pinnedVersion(range: string): PinnedRange | null {
  const value = range.trim();
  if (!value) return null;
  // A protocol prefix means the dependency does not come from the registry at all.
  if (/^[a-z]+:/i.test(value)) return null;
  if (value === "*" || value === "latest") return null;
  const match = /^([\^~]?)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return {
    operator: (match[1] as "^" | "~" | "") || "",
    major: Number(match[2]),
    minor: Number(match[3] ?? 0),
    patch: Number(match[4] ?? 0),
  };
}

/** The three numbers and the prerelease tail, or `null` for anything that is not a plain version. */
function parts(version: string): { nums: number[]; pre: string } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) return null;
  return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" };
}

/**
 * Semver order: newest first.
 *
 * String order is not version order — `1.10.0` sorts before `1.9.0`, which would put a nine-month-old
 * release at the top of the picker. A release beats a prerelease of the same numbers, which is
 * semver's own rule and also the one a person picking a version to install expects.
 */
export function bySemverDesc(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  // Anything unparseable sorts last rather than throwing the comparison off; the registry does
  // publish the occasional oddity.
  if (!left && !right) return a.localeCompare(b);
  if (!left) return 1;
  if (!right) return -1;
  for (let at = 0; at < 3; at++) {
    if (left.nums[at] !== right.nums[at]) return right.nums[at] - left.nums[at];
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return -1;
  if (!right.pre) return 1;
  return right.pre.localeCompare(left.pre);
}

/**
 * What the newest published version means for the line this manifest wrote.
 *
 * # Why this is not "latest is bigger than what you wrote"
 *
 * That was the first rule and it cries wolf constantly. `"lucide-react": "^1.14.0"` against a latest
 * of `1.20.2` is not out of date in any sense the file cares about: the caret already accepts
 * `1.20.2`, so an install picks it up and the manifest never changes. Flagging it would mark most of
 * a healthy project amber and train you to ignore the colour.
 *
 * So the answer has three values rather than two, and the editor draws each differently:
 *
 * * `outOfRange` — the newest version your range refuses. Taking it means **editing this file**.
 *   `^1.14.0` is out of range once a `2.0.0` exists; `~1.14.0` once `1.15.0` does; a bare `1.14.0`
 *   the moment anything newer is published. This is the one worth a colour.
 * * `inRange` — newer, and already allowed. Worth *printing the number*, because "what is current"
 *   is the question that prompted the check, but not worth flagging: an install answers it and the
 *   file never changes.
 * * `none` — nothing newer, or a side that is not a plain version. An unknown answer is not an
 *   upgrade and must never be drawn as one.
 */
export type UpdateKind = "none" | "inRange" | "outOfRange";

export function updateKind(range: string, latest: string): UpdateKind {
  const pinned = pinnedVersion(range);
  const newest = parts(latest);
  if (!pinned || !newest) return "none";
  const [major, minor, patch] = newest.nums;
  const newer =
    major > pinned.major ||
    (major === pinned.major &&
      (minor > pinned.minor || (minor === pinned.minor && patch > pinned.patch)));
  if (!newer) return "none";
  switch (pinned.operator) {
    case "^":
      return major > pinned.major ? "outOfRange" : "inRange";
    // `newer` already puts the major at or above the pinned one, so at the same major a bigger
    // minor is the whole of what a tilde refuses.
    case "~":
      return major > pinned.major || minor > pinned.minor ? "outOfRange" : "inRange";
    default:
      return "outOfRange";
  }
}

/**
 * Whether the newest published version falls **outside** what the manifest allows — the half of
 * `updateKind` that needs a hand on this file. Kept as its own name because that is the question
 * the counts in the dependency box ask, and `=== "outOfRange"` at each call site reads like an
 * implementation detail leaking.
 */
export function isOutdated(range: string, latest: string): boolean {
  return updateKind(range, latest) === "outOfRange";
}
