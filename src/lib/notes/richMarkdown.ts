import * as monaco from "monaco-editor";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { resolveTokenRule, tokenRulesFor, type CodeTheme } from "../codeThemes";

/**
 * The note preview's Markdown renderer: the shared one plus highlighted code and a copy button.
 *
 * **Loaded on demand, and that is structural.** It imports `monaco-editor`, which is the largest
 * chunk in the app — so a static import from anywhere the Notes gallery reaches would put the whole
 * editor on the path of a screen that draws cards. `NotePreview` imports this with a dynamic
 * `import()` and renders the plain Markdown until it resolves, which is why `renderMarkdown` in
 * `lib/markdown.ts` stays as it is and is not extended in place.
 *
 * **Why Monaco's own tokenizer rather than a highlighting library.** Two reasons, and the first is
 * the one that decided it: in split view the same code is on screen twice, and any other
 * highlighter would colour the right-hand copy differently from the left-hand one — a difference
 * the eye reads as a bug in the note. Tokenising with Monaco and painting with `tokenRulesFor`
 * means the preview is the editor's colours by construction, in whichever of the twenty-one themes
 * the user picked. The second is that it costs no new dependency; `codeSnap` already does exactly
 * this to paint a snapshot onto a canvas.
 */

/** Fence labels people write, mapped to the ids Monaco tokenises under. */
const FENCE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  console: "shell",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  "c#": "csharp",
  golang: "go",
  psql: "pgsql",
  postgres: "pgsql",
};

/**
 * Languages whose tokenizer has been pulled in this session.
 *
 * Monaco *registers* every basic language at import but loads each tokenizer only when something
 * asks for it — so `tokenize` on a language the user has never opened a file in returns one untyped
 * token per line, i.e. plain text. For an editor that is invisible (opening a `.js` loads it on the
 * way). For this it would be the normal case: most notes quote a language the session never touched,
 * and the preview would silently never colour anything.
 *
 * `colorize` is the public API that *waits* for the tokenizer, so one throwaway call per language
 * warms it; everything after is the synchronous `tokenize` this module actually paints with. The
 * set makes it once per language per session rather than once per render.
 */
const warmed = new Set<string>();

async function warm(language: string): Promise<void> {
  if (!language || warmed.has(language)) return;
  warmed.add(language);
  try {
    await monaco.editor.colorize("x", language, {});
  } catch {
    // An unknown language id. `highlight` degrades to plain text on its own; nothing to do.
  }
}

function languageOf(fence: string | undefined): string {
  // A fence may carry more than the language (```js title=foo), so only the first word counts.
  const label = (fence ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!label) return "";
  return FENCE_ALIASES[label] ?? label;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ESCAPES[character]);
}

/**
 * One code block as coloured HTML.
 *
 * Falls back to plain escaped text whenever anything is missing — an unknown fence label, a
 * language whose tokenizer this session has never loaded, a tokenizer that throws. `codeSnap`
 * documents the same degradation and it is the right one: uncoloured code is readable, and a
 * preview that refuses to render a block because it could not name the language is not.
 */
function highlight(code: string, language: string, theme: CodeTheme): string {
  if (!language) return escapeHtml(code);

  let lines: monaco.Token[][];
  try {
    lines = monaco.editor.tokenize(code, language);
  } catch {
    return escapeHtml(code);
  }
  // An unloaded tokenizer yields one untyped token per line, which would paint everything the
  // foreground colour — the same as not trying, but with the markup cost. Bail instead.
  if (lines.length === 0) return escapeHtml(code);

  const rules = tokenRulesFor(theme);
  const source = code.split("\n");

  return source
    .map((line, index) => {
      const tokens = lines[index];
      if (!tokens || tokens.length === 0) return escapeHtml(line);
      return tokens
        .map((token, at) => {
          const from = token.offset;
          const to = at + 1 < tokens.length ? tokens[at + 1].offset : line.length;
          const text = line.slice(from, to);
          if (!text) return "";
          const rule = resolveTokenRule(token.type, rules);
          // `fontStyle` is `"italic"` or absent — the palettes carry no bold rule, so there is no
          // weight branch to write here.
          const style = rule.fontStyle
            ? `color:${rule.foreground};font-style:${rule.fontStyle}`
            : `color:${rule.foreground}`;
          return `<span style="${style}">${escapeHtml(text)}</span>`;
        })
        .join("");
    })
    .join("\n");
}

/**
 * The copy button's markup.
 *
 * It carries no copy of the code — the handler reads the sibling `<code>`'s `textContent` instead.
 * Duplicating the block into a `data-` attribute would double the size of every preview and give
 * the two copies a way to disagree after sanitising.
 */
function copyButton(label: string): string {
  return (
    `<button type="button" class="cf-code-copy" data-cf-copy aria-label="${escapeHtml(label)}" ` +
    `title="${escapeHtml(label)}">` +
    // Inline SVG rather than a lucide component: this is an HTML string, not JSX. Two rounded
    // rectangles — the same glyph `lucide-react`'s `Copy` draws, so the button matches every other
    // copy affordance in the app.
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>` +
    `<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>` +
    `</svg></button>`
  );
}

/**
 * `source` as sanitized HTML, with fenced code highlighted and a copy button on every block.
 *
 * `copyLabel` is passed in rather than translated here so this module stays free of the language
 * store — it is imported lazily and a store subscription behind a dynamic import is a needless
 * ordering hazard.
 */
/**
 * Resolves a `[[reference]]` to the note it names.
 *
 * A function rather than a map so the caller decides how forgiving the match is — the store's
 * version is case- and accent-insensitive, because nobody retypes a title exactly. Returning
 * `null` is a *reference to a note that is not there*, which is drawn differently rather than
 * dropped: a broken link the reader can see is worth far more than prose that quietly reads as if
 * nothing were missing.
 */
export type NoteLinkResolver = (title: string) => { id: string; title: string } | null;

/**
 * `[[Title]]` as an inline token.
 *
 * A `marked` extension rather than a regex pass over the finished HTML, because a pass over HTML
 * cannot tell a `[[…]]` in a paragraph from one inside a code fence — and a note explaining this
 * syntax is exactly the note where that goes wrong. As an inline extension it is `marked` that
 * decides what counts as text, so fenced and inline code are already excluded.
 */
function noteLinkExtension(resolve: NoteLinkResolver, missingLabel: string) {
  return {
    name: "noteLink",
    level: "inline" as const,
    start(src: string) {
      return src.indexOf("[[");
    },
    tokenizer(src: string) {
      // No newline in the class: a `[[` that never closes is punctuation, not a link that ate the
      // rest of the document.
      const match = /^\[\[([^\]\n]+)\]\]/.exec(src);
      if (!match) return undefined;
      return { type: "noteLink", raw: match[0], text: match[1].trim() };
    },
    renderer(token: { text: string }) {
      const target = resolve(token.text);
      if (!target) {
        return (
          `<span class="cf-note-link cf-note-link-missing" title="${escapeHtml(missingLabel)}">` +
          `${escapeHtml(token.text)}</span>`
        );
      }
      // `data-cf-note` carries the id; the delegated handler in `NotePreview` opens it. Not an
      // `href`, because there is no URL for a note and a real anchor would let a click escape into
      // the webview's navigation.
      return (
        `<span class="cf-note-link" role="link" tabindex="0" data-cf-note="${escapeHtml(target.id)}" ` +
        `title="${escapeHtml(target.title)}">${escapeHtml(token.text)}</span>`
      );
    },
  };
}

export async function renderRichMarkdown(
  source: string,
  theme: CodeTheme,
  copyLabel: string,
  resolveNote: NoteLinkResolver,
  missingLabel: string,
): Promise<string> {
  // Every language the document quotes, warmed before a single block is painted — see `warm`.
  // Done up front rather than per block so one pass covers a note that repeats a language, and so
  // the render itself stays synchronous once they are all in.
  const languages = new Set<string>();
  for (const match of source.matchAll(/^ {0,3}(?:```|~~~)([^\n]*)$/gm)) {
    const language = languageOf(match[1]);
    if (language) languages.add(language);
  }
  await Promise.all([...languages].map(warm));

  const renderer = new Marked({
    gfm: true,
    breaks: false,
    extensions: [noteLinkExtension(resolveNote, missingLabel)],
    renderer: {
      code({ text, lang }: { text: string; lang?: string }) {
        const language = languageOf(lang);
        const body = highlight(text, language, theme);
        // `data-lang` labels the block in the corner; empty for an unlabelled fence, which the CSS
        // then draws nothing for.
        return (
          `<div class="cf-code-block" data-lang="${escapeHtml(language)}">` +
          `${copyButton(copyLabel)}<pre><code>${body}</code></pre></div>`
        );
      },
    },
  });

  const html = renderer.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    // `target` matches `lib/markdown.ts`. The rest is this renderer's own markup: the button needs
    // its marker attribute to be found by the delegated click handler, and the wrapper needs
    // `data-lang` for the label. `style` is already allowed by default and is what carries the
    // token colours — DOMPurify keeps `color`/`font-*` and drops anything that could escape.
    ADD_ATTR: ["target", "data-cf-copy", "data-lang", "data-cf-note", "role", "tabindex"],
  });
}
