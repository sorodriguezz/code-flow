// Not `from "./monacoSetup"` — that module imports this one. See `monacoDbml.ts` for the same note.
import * as monaco from "monaco-editor";
import { useEditorDisplayStore } from "../state/editorDisplayStore";

/**
 * Prisma's schema language, registered once and loaded when first needed — and switchable, from
 * Settings › Editor › Display.
 *
 * Registered and loaded the way `monacoToml` is: the id up front, so `.prisma` maps to a language
 * Monaco has; the grammar (`prismaGrammar.ts`) as its own chunk, the first time a model is created
 * with the id.
 *
 * **Off draws the file plain, it does not unmap it.** Turning the colours off swaps the grammar for
 * one that gives every character the default token, rather than handing the file `plaintext`: the
 * status line still says Prisma, `//` still toggles a comment and brackets still match — only the
 * colours go. And a tokens provider is global to Monaco, so the swap repaints every open schema, in
 * every editor of the window, the moment the switch moves; changing a model's language would have
 * meant finding them all.
 */

let registered = false;

/** Every character the default colour. */
const PLAIN: monaco.languages.IMonarchLanguage = { defaultToken: "", tokenizer: { root: [[/.+/, ""]] } };

export function registerPrismaLanguage(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: "prisma", extensions: [".prisma"], aliases: ["Prisma", "prisma"] });
  monaco.languages.onLanguage("prisma", () => {
    const display = useEditorDisplayStore;
    // The setting is read before the first paint, so a schema with the colours off never flashes them.
    void Promise.all([import("./prismaGrammar"), display.getState().init()]).then(([{ PRISMA_CONFIG, PRISMA_GRAMMAR }]) => {
      monaco.languages.setLanguageConfiguration("prisma", PRISMA_CONFIG);
      let shown: boolean | null = null;
      const apply = (on: boolean) => {
        if (on === shown) return;
        shown = on;
        monaco.languages.setMonarchTokensProvider("prisma", on ? PRISMA_GRAMMAR : PLAIN);
      };
      apply(display.getState().prismaHighlight);
      display.subscribe((state) => apply(state.prismaHighlight));
    });
  });
}
