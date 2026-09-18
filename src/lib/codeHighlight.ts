import type { CodeTheme } from "./codeThemes";
import { tokenRulesFor } from "./codeThemes";

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
  const match = className.match(LANGUAGE_CLASS);
  if (!match) return null;
  const label = match[1].toLowerCase();
  return ALIASES[label] ?? label;
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

  // Loaded only now, and only once per session: the first code block in the first answer pays for
  // it, and a transcript of prose never does.
  const monaco = await import("monaco-editor");
  const colourOf = colourResolver(theme);
  let done = 0;

  for (const code of blocks) {
    const language = languageOf(code.className);
    const source = code.textContent ?? "";
    // Marked as handled before the work, not after: a block whose language has no tokenizer must
    // not be retried on every re-render.
    code.setAttribute("data-cf-hl", language ?? "text");
    if (!language) continue;

    let lines: ReturnType<typeof monaco.editor.tokenize>;
    try {
      lines = monaco.editor.tokenize(source, language);
    } catch {
      continue;
    }
    if (lines.length === 0) continue;

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
    done += 1;
  }
  return done;
}
