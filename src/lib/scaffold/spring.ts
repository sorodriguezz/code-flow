import { compareTriples, parseTriple } from "./semver";

/**
 * Whether a starter's `versionRange` from start.spring.io admits `boot`.
 *
 * Initializr writes ranges as Maven does — `[3.5.0,4.1.0-M1)`, `(3.4.0,4.0.0]` — or as a bare version
 * meaning "this and later". Prereleases are compared by their numbers alone, which only ever errs
 * towards excluding a starter at a milestone boundary; the server has the last word either way, and
 * answers a mismatch with a sentence the dialog shows.
 */
export function springRangeIncludes(range: string, boot: string): boolean {
  const text = range.trim();
  if (!text) return true;
  const version = parseTriple(boot);
  if (!version) return true;
  const interval = /^([[(])\s*([^,]*?)\s*,\s*([^\])]*?)\s*([\])])$/.exec(text);
  if (!interval) {
    const floor = parseTriple(text);
    return floor ? compareTriples(version, floor) >= 0 : true;
  }
  const [, open, low, high, close] = interval;
  const lo = low ? parseTriple(low) : null;
  const hi = high ? parseTriple(high) : null;
  if (lo) {
    const c = compareTriples(version, lo);
    if (open === "[" ? c < 0 : c <= 0) return false;
  }
  if (hi) {
    const c = compareTriples(version, hi);
    if (close === "]" ? c > 0 : c >= 0) return false;
  }
  return true;
}

/** Initializr's own rule for the default package: the group, then the artifact with everything a
 *  Java identifier cannot hold taken out. */
export function springPackage(group: string, artifact: string): string {
  const clean = (value: string) =>
    value
      .toLowerCase()
      .split(".")
      .map((segment) => segment.replace(/[^a-z0-9_]/g, ""))
      .filter(Boolean)
      .map((segment) => (/^[0-9]/.test(segment) ? `_${segment}` : segment))
      .join(".");
  return [clean(group), clean(artifact)].filter(Boolean).join(".");
}

export const VALID_JAVA_PACKAGE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/;
