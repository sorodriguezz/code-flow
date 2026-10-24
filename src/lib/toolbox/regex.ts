/**
 * The regex tester's evaluation — JavaScript's own engine, so what matches here is what matches in
 * the code being written. Run inside a worker by the UI (`regexWorker.ts`) so a pattern that
 * backtracks for ever freezes a thread that can be killed, not the window.
 */

export interface RegexGroup {
  /** `1`, `2`… or the name of a named group. */
  name: string;
  value: string | undefined;
  start: number | null;
  end: number | null;
}

export interface RegexMatch {
  index: number;
  end: number;
  value: string;
  groups: RegexGroup[];
}

export interface RegexResult {
  matches: RegexMatch[];
  /** The text with the replacement applied, when one was given. */
  replaced: string | null;
  /** Stopped at `limit` matches. */
  truncated: boolean;
}

export function compileRegex(pattern: string, flags: string): RegExp {
  // `d` gives the groups' positions; added silently so the UI can highlight them.
  const all = Array.from(new Set((flags + "d").split(""))).join("");
  return new RegExp(pattern, all);
}

export function runRegex(pattern: string, flags: string, text: string, replacement: string | null, limit = 1000): RegexResult {
  const re = compileRegex(pattern, flags);
  const matches: RegexMatch[] = [];
  let truncated = false;
  const global = re.global || re.sticky;
  const names = new Map<number, string>();
  // Group numbers of named groups, in source order, so `1` and `year` are not both listed.
  let n = 0;
  for (const m of pattern.matchAll(/\\.|\[(?:\\.|[^\]])*\]|\((\?<([A-Za-z_$][\w$]*)>|\?[:=!<])?/g)) {
    if (!m[0].startsWith("(")) continue;
    if (m[1] && !m[2]) continue;
    n++;
    if (m[2]) names.set(n, m[2]);
  }
  const scan = global ? re : new RegExp(re.source, re.flags + "g");
  scan.lastIndex = 0;
  for (let m = scan.exec(text); m; m = scan.exec(text)) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    const indices = (m as RegExpExecArray & { indices?: [number, number][] }).indices;
    const groups: RegexGroup[] = [];
    for (let g = 1; g < m.length; g++) {
      const span = indices?.[g];
      groups.push({ name: names.get(g) ?? String(g), value: m[g], start: span ? span[0] : null, end: span ? span[1] : null });
    }
    matches.push({ index: m.index, end: m.index + m[0].length, value: m[0], groups });
    if (!global) break;
    // A zero-length match would otherwise match at the same place for ever.
    if (m[0] === "") scan.lastIndex += re.unicode || re.flags.includes("v") ? Math.max(1, String.fromCodePoint(text.codePointAt(scan.lastIndex) ?? 0).length) : 1;
  }
  const replaced = replacement === null ? null : text.replace(new RegExp(re.source, re.flags.replace("d", "")), replacement);
  return { matches, replaced, truncated };
}
