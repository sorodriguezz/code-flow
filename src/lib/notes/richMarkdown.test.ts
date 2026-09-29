import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DARK_THEME, findTheme, resolveTokenRule, tokenRulesFor } from "../codeThemes";

/**
 * A Monaco that behaves like 0.56 where this module depends on it. `colorize` brings in a
 * loader-backed (Monarch) grammar — TypeScript's, YAML's — but JSON has none: its tokenizer comes
 * from an `onLanguage` hook that only creating a model fires, and a tick later, since the hook
 * `import()`s the language service. Until a language's tokenizer is in, `tokenize` answers one
 * untyped token per line, which is what painted every JSON block the colour of plain text.
 */
const fake = vi.hoisted(() => {
  const ready = new Set<string>();
  const models: string[] = [];
  const monaco = {
    languages: { getLanguages: () => ["json", "typescript", "yaml"].map((id) => ({ id })) },
    editor: {
      colorize: async (_text: string, language: string) => {
        if (language !== "json") ready.add(language);
        return "";
      },
      createModel: (_value: string, language: string) => {
        models.push(language);
        setTimeout(() => ready.add(language), 0);
        return { dispose: () => undefined };
      },
      tokenize: (text: string, language: string) => {
        const type = ready.has(language) ? `string.${language}` : "";
        return text.split("\n").map(() => [{ offset: 0, type, language }]);
      },
    },
  };
  return { ready, models, monaco };
});

vi.mock("../monacoSetup", () => ({ monaco: fake.monaco }));
// DOMPurify needs a DOM and there is none under vitest here; the sanitising is not what is tested.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

const THEME = findTheme(DEFAULT_DARK_THEME, "dark");
const STRING = resolveTokenRule("string.json", tokenRulesFor(THEME)).foreground;
const PLAIN = resolveTokenRule("", tokenRulesFor(THEME)).foreground;

/** Every colour the render painted a token with, in document order. */
function coloursIn(html: string): string[] {
  return Array.from(html.matchAll(/style="color:([^;"]+)/g), (match) => match[1]);
}

async function render(source: string): Promise<string> {
  const { renderRichMarkdown } = await import("./richMarkdown");
  return renderRichMarkdown(source, THEME, "Copiar", () => null, "No existe");
}

beforeEach(() => {
  // What has been warmed lives as long as the module, as it does for a window: a fresh module per
  // test, so each one starts in a window where nothing has been.
  vi.resetModules();
  fake.ready.clear();
  fake.models.length = 0;
});

describe("code blocks in a note's preview", () => {
  it("tells a coloured block from a cold one", () => {
    // The assertions below rest on these two differing.
    expect(STRING).not.toBe(PLAIN);
  });

  it("colours JSON in a window where nothing has created a JSON model", async () => {
    const html = await render('```json\n{"a": 1}\n```');
    expect(fake.models).toEqual(["json"]);
    expect(coloursIn(html)).toEqual([STRING]);
  });

  it("creates no model for a language colorize already brought in", async () => {
    // A throwaway TypeScript model would wake the TypeScript language service for nothing.
    const html = await render("```ts\nconst a = 1;\n```");
    expect(fake.models).toEqual([]);
    expect(coloursIn(html)).toEqual([STRING]);
  });

  it("warms a fence inside a blockquote or a list item, not only at a line's start", async () => {
    const quoted = ["> ```yaml", "> a: 1", "> ```"];
    const listed = ["- item", "", "  ```json", "  [1]", "  ```"];
    const html = await render([...quoted, "", ...listed].join("\n"));
    expect(coloursIn(html)).toEqual([STRING, STRING]);
  });

  it("leaves a language alone while its blocks are blank", async () => {
    // Blank text never shows a tokenizer, so warming on it would sit out the whole wait for one.
    await render("```json\n\n```");
    expect(fake.models).toEqual([]);
  });
});
