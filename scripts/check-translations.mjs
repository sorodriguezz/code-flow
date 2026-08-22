// Asserts that the two translation dictionaries hold exactly the same keys.
//
// `tsc` already catches this — `translations.es.ts` is written `satisfies Record<TranslationKey,
// string>`, so a missing key is a type error in one direction and an extra key is one in the other.
// The problem is *when*: `tsc` runs only inside `pnpm build`, which nobody runs before pushing, so
// the failure surfaces in the release job, on a Windows runner, twenty minutes in.
//
// This does the same check in about a second with no TypeScript and no Rust toolchain, which is
// what makes it cheap enough to gate every pull request. It is the single most likely regression in
// any change that touches the UI: adding an English string and forgetting the Spanish one.
//
// Deliberately a text scan rather than an import. These modules are TypeScript with a `satisfies`
// clause, so running them means a transpiler and a resolver — several seconds and two dependencies
// to serve a question that is answerable with a regular expression over quoted keys at the start of
// a line.

import { readFileSync } from "node:fs";

const FILES = {
  en: "src/lib/i18n/translations.ts",
  es: "src/lib/i18n/translations.es.ts",
};

/** Keys are always written as a quoted string at the start of an indented line, followed by a
 *  colon. Values can be multi-line, so anchoring to the line start is what keeps a colon inside a
 *  sentence from being read as a key. */
const KEY = /^\s{2}"([^"]+)":/gm;

function keysOf(path) {
  const source = readFileSync(path, "utf8");
  const found = [];
  for (const match of source.matchAll(KEY)) found.push(match[1]);
  return found;
}

const en = keysOf(FILES.en);
const es = keysOf(FILES.es);

const problems = [];

for (const [language, keys] of Object.entries({ en, es })) {
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) problems.push(`${language}: duplicate key "${key}"`);
    seen.add(key);
  }
}

const enSet = new Set(en);
const esSet = new Set(es);
for (const key of en) if (!esSet.has(key)) problems.push(`missing from es: "${key}"`);
for (const key of es) if (!enSet.has(key)) problems.push(`missing from en: "${key}"`);

if (problems.length > 0) {
  console.error(`translations: ${problems.length} problem(s)\n`);
  for (const problem of problems.slice(0, 50)) console.error(`  ${problem}`);
  if (problems.length > 50) console.error(`  … and ${problems.length - 50} more`);
  process.exit(1);
}

console.log(`translations: ${en.length} keys, en and es agree`);
