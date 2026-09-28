import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The rail's "open in its own window" corner. It was a `span role="button"` nested inside the app's
 * `<button>` — interactive content inside interactive content, which HTML forbids and which left the
 * corner unannounced. It is a sibling button now, with a name of its own.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../../state/languageStore", () => ({
  useT: () => (key: string, params?: Record<string, string>) => (params?.name ? `${key}:${params.name}` : key),
  translate: (key: string) => key,
  useLanguageStore: (select: (s: { language: string }) => unknown) => select({ language: "en" }),
}));

const { AppRail } = await import("./AppRail");

/** The deepest `<button>` nesting in a piece of markup. */
function buttonDepth(html: string): number {
  let depth = 0;
  let deepest = 0;
  for (const tag of html.match(/<\/?button\b/g) ?? []) {
    depth += tag.startsWith("</") ? -1 : 1;
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

describe("AppRail", () => {
  const html = renderToStaticMarkup(<AppRail />);

  it("never nests one control inside another", () => {
    expect(buttonDepth(html)).toBe(1);
    expect(html).not.toContain('role="button"');
  });

  it("names the corner that opens an app in a window of its own", () => {
    expect(html).toContain("windows.openInWindow");
    expect(html).toMatch(/<button[^>]*aria-label="[^"]*windows\.openInWindow"/);
  });

  // A `//` line placed between JSX tags is not a comment — React renders it as text. One such
  // block once put a paragraph of source commentary on screen in every rail slot.
  it("renders no source comments as text", () => {
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).not.toMatch(/\/\/|\/\*/);
  });
});
