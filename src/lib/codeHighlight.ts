import type { CodeTheme } from "./codeThemes";
import { tokenRulesFor } from "./codeThemes";
import { reportError } from "./diagnostics";

type Monaco = typeof import("monaco-editor");

/**
 * Colours a rendered code block, using the same tokenizer and the same palette as the editor.
 *
 * # Why Monaco and not a highlighting library
 *
 * The app already carries Monaco, already registers its languages, and already exposes the 21 code
 * themes as token→colour rules ([`tokenRulesFor`]). Adding highlight.js or shiki for the chat would
 * mean a second grammar set and a second palette, and the two would disagree — a TypeScript block
 * in a chat answer would be coloured differently from the same code in the editor one pane away.
 * `codeSnap` already made this exact choice for the same reason, and says so.
 *
 * # Why it happens after render and not inside `renderMarkdown`
 *
 * Two reasons, and the second is the one that matters. Monaco is a 4.4 MB chunk: pulling it into
 * the markdown pipeline would load it for every message in every transcript, including the ones
 * with no code in them. And `renderMarkdown` is synchronous and sanitises with DOMPurify —
 * injecting a wall of coloured `<span>`s into the string it produces would mean either widening the
 * sanitiser's allow-list on a path that renders untrusted model output, or re-sanitising afterwards
 * and hoping the two passes agree.
 *
 * So this walks the DOM *after* the sanitised HTML is mounted, replaces each `<code>`'s text with
 * spans it builds itself, and never parses a string as HTML. The colours are set as inline styles
 * on elements this module constructs, so nothing from the model can reach the style attribute.
 *
 * # Degradation is the normal case, not the failure case
 *
 * A language whose tokenizer has not been loaded this session yields one untyped token per line,
 * which renders as plain text in the foreground colour. A fenced block with no language, or with a
 * language Monaco does not know, does the same. That is a fair outcome and deliberately not an
 * error: a code block that is readable and uncoloured beats one that is missing.
 */

/** What `marked` puts on a fenced block's `<code>`: `language-ts`, `language-python`, … */
const LANGUAGE_CLASS = /(?:^|\s)language-([\w+#-]+)/;

/**
 * Fence labels people actually type, mapped to the ids Monaco registers.
 *
 * Only the ones that differ. Anything absent is passed through unchanged, which is right far more
 * often than it is wrong — `typescript`, `python`, `rust`, `json`, `css` and `html` all already
 * match, and a label that matches nothing degrades to plain text rather than failing.
 */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  golang: "go",
  htm: "html",
  jsonc: "json",
  psql: "pgsql",
  postgres: "pgsql",
  tf: "hcl",
  dockerfile: "dockerfile",
  make: "makefile",
  vue: "html",
  svelte: "html",
};

/** The language a fenced block declares, normalised — or `null` for a bare fence.
 *
 * Takes the class string rather than the element so it is a pure function of its input: the DOM is
 * the caller's business, and a language table is the part worth pinning down in tests. */
export function languageOf(className: string): string | null {
  const label = fenceLabelOf(className)?.toLowerCase();
  if (!label) return null;
  return ALIASES[label] ?? label;
}

/** The fence label exactly as the model wrote it — `ts`, `json`, `bash` — for the bar over the
 *  block. Not `languageOf`: that is Monaco's id (`typescript`, `shell`), and a label that differs
 *  from what the answer's own text says reads as a correction nobody asked for. */
export function fenceLabelOf(className: string): string | null {
  return className.match(LANGUAGE_CLASS)?.[1] ?? null;
}

/** Whether `tokenize` answered the way it answers when the language has no tokenizer registered:
 *  one untyped token per line. A real tokenizer names what it finds — `delimiter.bracket.json`,
 *  `keyword.ts` — so this is how a cold language is told apart from a loaded one. */
export function untyped<Token extends { type: string }>(lines: readonly (readonly Token[])[]): boolean {
  return lines.every((line) => line.length <= 1 && (line[0]?.type ?? "") === "");
}

/**
 * Builds the colour lookup once per theme: Monaco reports a token type like
 * `string.quoted.ts`, and the rules are matched longest-prefix-first, which is how Monaco's own
 * theme matcher resolves them. Doing it per token would re-scan the rule list thousands of times
 * for a long answer.
 */
function colourResolver(theme: CodeTheme): (tokenType: string) => string | undefined {
  // Longest first, so `comment.doc` wins over `comment` for a doc block.
  const rules = tokenRulesFor(theme)
    .filter((rule) => rule.foreground)
    .sort((a, b) => b.token.length - a.token.length);
  const cache = new Map<string, string | undefined>();
  return (tokenType: string) => {
    const hit = cache.get(tokenType);
    if (hit !== undefined || cache.has(tokenType)) return hit;
    // `""` is the fallback rule and matches everything, which is why it sorts last.
    const rule = rules.find((r) => r.token === "" || tokenType.startsWith(r.token));
    const colour = rule?.foreground;
    cache.set(tokenType, colour);
    return colour;
  };
}

/** Languages whose tokenizer has been pulled in, one promise each so a burst of blocks in the same
 *  language waits on one load rather than starting several. Module-level: the tokenizers live in
 *  Monaco's own global registry, so a second window or a later transcript inherits nothing from
 *  this map — but within a window, warming a language is permanent and paid once. */
const warmed = new Map<string, Promise<void>>();

/**
 * Makes sure Monaco can actually tokenize `language` before anybody asks it to.
 *
 * **`monaco.editor.tokenize` is synchronous, and Monaco's languages are not.** All ~90 are
 * *registered* the moment `monaco-editor` is imported, so `getLanguages()` lists them and
 * `tokenize` accepts the id — but each one's Monarch grammar is a separate module fetched on
 * demand, and until it arrives `tokenize` answers with one catch-all token per line. Not an error,
 * not an empty result: a shape that looks exactly like a file with no syntax in it. Every token
 * then resolves to the theme's fallback colour and the block comes out the colour of plain text.
 *
 * Which is the bug this exists for, and it was invisible for the worst possible reason: the block
 * is marked `data-cf-hl` before the work, so the one pass that ran with no grammar was also the
 * only pass that would ever run. The first answer of a session came out grey and stayed grey,
 * while a later one — by then something else had pulled the grammar in — came out coloured. In a
 * detached chat window, where nothing else ever loads Monaco, *nothing* was coloured, which is how
 * it was finally reported.
 *
 * `colorize` is the fix because it is the public call that loads a grammar: it is async precisely
 * because it waits for one. The text handed to it is empty — the return value is thrown away and
 * the load is the entire point.
 *
 * A language Monaco cannot serve rejects, is swallowed, and gets tokenized cold anyway: that block
 * renders as plain text, which is what it would have done regardless.
 *
 * # JSON, which `colorize` cannot warm
 *
 * `colorize` only waits for a grammar that sits behind a *loader* — every Monarch language does.
 * JSON does not: Monaco ships no Monarch grammar for it, and its tokenizer is installed by the JSON
 * language service from an `onLanguage` hook, alongside completions and validation. That hook fires
 * when a **model** in the language is created (`TextModel` asks for the language's "rich features"),
 * and `colorize` creates none. So `colorize` resolved at once, `tokenize` went on answering cold,
 * and every JSON block in the chat came out plain — unless an editor in the same window had opened
 * a `.json` file first, which is why it looked fine on one machine and grey on another. The app's
 * own TOML grammar (`monacoToml`) is installed the same way.
 *
 * So a language that is still cold after `colorize` gets a throwaway model — created and disposed
 * at once, which is all the hook needs — and a short wait for the tokenizer the hook installs:
 * polled, because Monaco publishes no event for it. `sample` is the caller's first non-blank block
 * in the language, the only honest test of "does this now colour?" — blank text shows no tokenizer
 * however long it waits. A language that never gets a tokenizer (`plaintext`) spends
 * `HOOK_WAIT_MS` once per session. In the chat only its own blocks wait on it — see
 * `highlightCodeBlocks`, which colours each language as soon as it is ready.
 *
 * Shared with the Notes preview (`lib/notes/richMarkdown`), which had the same grey JSON. A note
 * is painted in one pass, so there that wait holds back the whole note's colours — once per
 * session, with the plain rendering on screen meanwhile. The memo is per window either way: a
 * language warmed for the chat is warm for a note, and the other way round.
 */
export function warm(monaco: Monaco, language: string, sample: string): Promise<void> {
  let pending = warmed.get(language);
  if (!pending) {
    pending = (async () => {
      await monaco.editor.colorize("", language, {}).catch(() => undefined);
      const known = monaco.languages.getLanguages().some((entry) => entry.id === language);
      if (!known || !coldFor(monaco, language, sample)) return;
      try {
        monaco.editor.createModel("", language).dispose();
      } catch {
        return;
      }
      for (let waited = 0; waited < HOOK_WAIT_MS; waited += HOOK_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, HOOK_POLL_MS));
        if (!coldFor(monaco, language, sample)) return;
      }
    })();
    warmed.set(language, pending);
  }
  return pending;
}

/** How long a language whose tokenizer comes from an `onLanguage` hook gets to produce one. The hook
 *  is an `import()` of the language service: a microtask away in a build, where it sits in the
 *  monaco chunk, one request away under the dev server. */
const HOOK_WAIT_MS = 1500;
const HOOK_POLL_MS = 25;

function coldFor(monaco: Monaco, language: string, sample: string): boolean {
  try {
    return untyped(monaco.editor.tokenize(sample, language));
  } catch {
    return true;
  }
}

/**
 * Colours every fenced block inside `host`, in place.
 *
 * Idempotent by construction: a block it has already touched carries `data-cf-hl`, so re-running it
 * after a re-render is a no-op rather than a second pass over spans it produced itself.
 *
 * Returns the number of blocks it coloured, which is what the caller logs or ignores. It never
 * throws — a tokenizer that refuses a language leaves that block as it was.
 */
export async function highlightCodeBlocks(host: HTMLElement, theme: CodeTheme): Promise<number> {
  const blocks = Array.from(host.querySelectorAll("pre > code")).filter(
    (code) => !code.hasAttribute("data-cf-hl") && (code.textContent ?? "").length > 0,
  );
  if (blocks.length === 0) return 0;

  // Marked as handled before the work, not after: a block whose language has no tokenizer must not
  // be retried on every re-render.
  const byLanguage = new Map<string, Element[]>();
  for (const code of blocks) {
    const language = languageOf(code.className);
    code.setAttribute("data-cf-hl", language ?? "text");
    if (language) byLanguage.set(language, [...(byLanguage.get(language) ?? []), code]);
  }
  if (byLanguage.size === 0) return 0;

  // Loaded only now, and only once per session: the first code block in the first answer pays for
  // it, and a transcript of prose never does. The editor's own setup rather than bare
  // `monaco-editor`, so a block is tokenized by exactly what the editor would use — the languages
  // the app registers itself (TOML, DBML, ObjectScript) and its fixes to Monaco's grammars
  // (TypeScript decorators) included — and so no language service a warm-up wakes (see `warm`)
  // ever starts before the app has configured it.
  let monaco: Monaco;
  try {
    ({ monaco } = await import("./monacoSetup"));
  } catch (error) {
    // A chunk that failed to load leaves every block plain, which is readable; saying so in the app
    // log is what makes "the code has no colour on this machine" answerable.
    reportError("code-highlight", error);
    return 0;
  }
  const colourOf = colourResolver(theme);

  // Each language is coloured the moment *its* tokenizer is in, not when every language's is: one
  // that has to wait on a hook (see `warm`) holds back its own blocks and nobody else's.
  const coloured = await Promise.all(
    Array.from(byLanguage, async ([language, codes]) => {
      // The first block with something in it is what `warm` tests the tokenizer against. A language
      // whose blocks are all blank has nothing to colour, and must not be recorded as warmed on the
      // strength of a sample that could never have shown a tokenizer.
      const sample = codes.map((code) => code.textContent ?? "").find((text) => /\S/.test(text));
      if (sample === undefined) return 0;
      await warm(monaco, language, sample);
      return codes.filter((code) => paint(monaco, code, language, colourOf)).length;
    }),
  );
  return coloured.reduce((sum, n) => sum + n, 0);
}

/** Replaces one block's text with coloured spans. False when the tokenizer refused the language. */
function paint(
  monaco: Monaco,
  code: Element,
  language: string,
  colourOf: (tokenType: string) => string | undefined,
): boolean {
  const source = code.textContent ?? "";
  let lines: ReturnType<Monaco["editor"]["tokenize"]>;
  try {
    lines = monaco.editor.tokenize(source, language);
  } catch {
    return false;
  }
  if (lines.length === 0) return false;

  const sourceLines = source.split("\n");
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < sourceLines.length; i += 1) {
    if (i > 0) fragment.appendChild(document.createTextNode("\n"));
    const text = sourceLines[i];
    const tokens = lines[i];
    if (!tokens || tokens.length === 0) {
      fragment.appendChild(document.createTextNode(text));
      continue;
    }
    for (let t = 0; t < tokens.length; t += 1) {
      // A token runs from its own offset to the next one's, and the last to end of line.
      const start = tokens[t].offset;
      const end = t + 1 < tokens.length ? tokens[t + 1].offset : text.length;
      const slice = text.slice(start, end);
      if (!slice) continue;
      const colour = colourOf(tokens[t].type);
      if (!colour) {
        fragment.appendChild(document.createTextNode(slice));
        continue;
      }
      const span = document.createElement("span");
      // `textContent`, never `innerHTML`: this is model output, and the whole reason this runs
      // on the DOM instead of on the HTML string is that nothing here should ever be parsed.
      span.textContent = slice;
      span.style.color = colour;
      fragment.appendChild(span);
    }
  }
  code.replaceChildren(fragment);
  return true;
}
