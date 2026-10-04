import { useLanguageStore } from "../../state/languageStore";

/**
 * What the whiteboard editor gets when it asks for `@excalidraw/mermaid-to-excalidraw` — see the
 * alias in `vite.config.ts`.
 *
 * Excalidraw loads that converter on demand, for its "Mermaid to Excalidraw" tool and for pasted
 * Mermaid text, and it brings all of Mermaid with it: Cytoscape, KaTeX, d3, a Langium grammar.
 * Bundling that pushed the production build past the 4 GB heap the release workflow gives it, for a
 * feature this app already covers its own way — "Draw with AI" puts a described diagram on a
 * whiteboard. So the converter is replaced by this, and both of Excalidraw's callers already handle
 * a converter that fails: the dialog shows the message, and a paste falls back to pasting the text.
 */
export async function parseMermaidToExcalidraw(): Promise<never> {
  throw new Error(
    useLanguageStore.getState().language === "es"
      ? "La conversión de Mermaid no está incluida en CodeFlow. Usa «Dibujar con IA» para describir el diagrama."
      : "Mermaid conversion is not included in CodeFlow. Use “Draw with AI” to describe the diagram.",
  );
}
