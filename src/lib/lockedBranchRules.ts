import type { BranchInfo } from "../types/domain";

/**
 * The locked-branch pattern language, ported to the frontend so the settings screen can *show* what
 * a rule covers before it is saved.
 *
 * **`src-tauri/src/git/lock_rules.rs` remains the authority.** Nothing here decides whether a branch
 * is locked — the guards deep in the git layer do, and `list_branches` reports the answer as
 * `is_locked` / `locked_by_rule`. This exists because a preview is worth nothing if it arrives after
 * the save: a user typing `release*` should see that it also covers `release` itself (it does, and
 * `release/*` does not) while the caret is still in the box.
 *
 * That makes this a mirror, and a mirror that drifts is worse than no mirror at all — it would
 * promise a lock the backend refuses to apply. The behaviours reproduced from `matches_pattern`,
 * each one deliberate:
 *
 * - `*` matches any run of characters, **slashes included**, so `release/*` covers `release/2025/q1`.
 * - `?` matches **exactly one** character, a slash included.
 * - A pattern with no wildcard is an exact name: `main` is not `mainline` and not `feature/main`.
 * - Case is folded **over ASCII only** — `Develop` and `develop` are one rule, `Función` and
 *   `función` are two. A JS `toLowerCase()` here would fold accents the backend does not.
 * - The pattern is trimmed; the branch name is not.
 * - An empty pattern matches nothing, rather than everything.
 * - A trailing `*` matches the empty rest, which is why `release*` covers `release`.
 * - Iterative backtracking, not recursion, for the same reason as the original: `*a*a*a*…` would
 *   otherwise cost a stack frame per star.
 */

/** ASCII-only fold, mirroring Rust's `to_ascii_lowercase`. See the module note. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Whether a branch name is covered by one pattern.
 *
 * `Array.from` rather than an index loop over the string: Rust iterates `chars()`, so `?` is one
 * *code point* there, and a UTF-16 walk would count an emoji as two characters.
 */
export function matchesLockPattern(pattern: string, name: string): boolean {
  const p = Array.from(asciiLower(pattern.trim()));
  const n = Array.from(asciiLower(name));
  if (p.length === 0) return false;

  let pi = 0;
  let ni = 0;
  let star = -1;
  let resume = 0;

  while (ni < n.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === n[ni])) {
      pi += 1;
      ni += 1;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      resume = ni;
      pi += 1;
    } else if (star >= 0) {
      // Give the last star one more character and try again.
      pi = star + 1;
      resume += 1;
      ni = resume;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

/**
 * Whether two entries are the same rule, by the backend's test: trimmed, compared case-insensitively
 * over ASCII (`lock_rules::normalize`).
 *
 * Narrower than the `toLowerCase()` compare the panel used to do, and deliberately: that one folded
 * Unicode the backend leaves alone, so it treated two rules as one and dropped the second silently.
 */
export function sameLockRule(a: string, b: string): boolean {
  return asciiLower(a.trim()) === asciiLower(b.trim());
}

/** Trims, drops blanks and collapses duplicates — first spelling wins, as in `lock_rules::normalize`.
 *  Used to clean a paste before sending; the saved list is still whatever the backend returns. */
export function normalizeLockRules(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (!out.some((existing) => sameLockRule(existing, trimmed))) out.push(trimmed);
  }
  return out;
}

/**
 * Splits what was typed or pasted into patterns.
 *
 * On whitespace, because a git ref cannot contain any — so the split is lossless — with a *trailing*
 * comma stripped per token so that pasting `main, master` works. Interior commas survive: a comma is
 * legal in a branch name, which is the whole reason the list is stored as JSON rather than as a
 * comma-separated string.
 */
export function splitLockPatterns(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((token) => token.replace(/,+$/, "").trim())
    .filter((token) => token !== "");
}

/**
 * What one pattern covers in the repository that is open, split into two lists.
 *
 * `exempt` is the third state the sidebar's padlock has a tooltip for and this screen otherwise
 * could not show: a branch this rule matches whose own padlock has been deliberately *opened*. It is
 * inferred rather than reported — `is_locked === false` on a rule-matched local branch can only be an
 * explicit override in that repository's `.git/config` — which is sound because the branch list is
 * re-read after every rule read and write.
 *
 * Remote branches are dropped: they are never locked.
 */
export function lockRuleCoverage(
  pattern: string,
  branches: BranchInfo[],
): { covered: BranchInfo[]; exempt: BranchInfo[] } {
  const covered: BranchInfo[] = [];
  const exempt: BranchInfo[] = [];
  for (const branch of branches) {
    if (branch.is_remote) continue;
    if (!matchesLockPattern(pattern, branch.name)) continue;
    covered.push(branch);
    if (!branch.is_locked) exempt.push(branch);
  }
  return { covered, exempt };
}
