// Fails when a tracked source file holds a raw control byte — a NUL, an ESC, a Ctrl-C written into
// the file itself — where the escape that spells it belongs (`\0`, `\x1b`, `\x03`).
//
// The runtime never notices: the byte and its escape compile to the same string. Everything that
// reads the file as text does. One NUL in the first 8000 bytes and git calls the whole file binary,
// so `git diff`, `git log -p` and a pull request's diff shrink to "Binary files … differ" for every
// reviewer, human or model, and grep and ripgrep stop printing its lines. The rest leave the diff
// readable but hide inside it: a terminal draws nothing for them, so a comparison against Ctrl-C
// reads as a comparison against the empty string.
//
// Nobody types one on purpose. The usual source is a tool that writes files through an escaped
// transport (a JSON payload, say) and decodes an escape meant for the file one layer too early.
// That is a property of the tooling rather than a slip anyone learns from, hence a gate on every
// pull request rather than a note to be careful.
//
// A regular expression over `git ls-files`, like check-translations.mjs, because the question needs
// no parser: tab, LF and CR are the only bytes below 0x20 that belong in source, and DEL never does.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Hand-written code, TypeScript, JavaScript and Rust alike. The icons tracked beside it are binary
 *  on purpose. */
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|rs)$/;

/** Every C0 control except tab, LF and CR, plus DEL. */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((path) => SOURCE.test(path));

const problems = [];

for (const path of files) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    // Deleted from the working tree but not yet from the index: nothing left to scan.
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const match of source.matchAll(CONTROL)) {
    const before = source.slice(0, match.index);
    const line = before.split("\n").length;
    const column = match.index - before.lastIndexOf("\n");
    const byte = match[0].charCodeAt(0).toString(16).padStart(2, "0");
    problems.push(`${path}:${line}:${column}: raw 0x${byte}`);
  }
}

if (problems.length > 0) {
  console.error(`control bytes: ${problems.length} problem(s)\n`);
  for (const problem of problems.slice(0, 50)) console.error(`  ${problem}`);
  if (problems.length > 50) console.error(`  … and ${problems.length - 50} more`);
  console.error("\nWrite each as its escape (\\0, \\x1b, …): the same string at runtime, and text to git.");
  process.exit(1);
}

console.log(`control bytes: none in ${files.length} source files`);
