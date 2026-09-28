import type { languages } from "monaco-editor";

/**
 * Single-file components — `.vue`, `.svelte`, `.astro` — as HTML that knows what `lang="ts"` means.
 *
 * `monacoLanguage` opens the three as `html`: their outer shape is markup, and HTML is what brings
 * tag completion and the formatter along. Monaco's HTML grammar already hands a `<script>` block
 * to the JavaScript tokenizer and a `<style>` block to CSS, which covers most of such a file. What
 * it does not read is the attribute these files use to say otherwise: it looks at `type` and
 * nothing else, so `<script lang="ts">` came out as JavaScript and `<style lang="scss">` as CSS.
 *
 * This adds `lang` beside `type`, with the same states in the same shape — `type`'s own — so the
 * stack unwinds at `</script>` exactly as it does for `type="module"`. It changes nothing for a
 * plain HTML file, where `lang` on a `<script>` is not a thing anyone writes.
 *
 * What is still not coloured: Vue's `{{ }}`, Svelte's `{#if}` and Astro's `---` front matter, which
 * are text to an HTML grammar. Each would need a grammar of its own, and a component's script and
 * styles are most of what there is to read.
 */

type Rule = languages.IMonarchLanguageRule;

/** `lang` values and the mime type Monaco registered the language they name under. */
const SCRIPT_LANGS: [RegExp, string][] = [[/["'](?:ts|typescript|tsx)["']/, "text/typescript"]];
const STYLE_LANGS: [RegExp, string][] = [
  [/["'](?:scss)["']/, "text/x-scss"],
  [/["'](?:less)["']/, "text/x-less"],
];

function langStates(tag: "script" | "style", langs: [RegExp, string][], fallback: string) {
  const custom = tag === "script" ? "@scriptWithCustomType" : "@styleWithCustomType";
  const embedded = tag === "script" ? "@scriptEmbedded" : "@styleEmbedded";
  const close = new RegExp(`<\\/${tag}\\s*>`);
  const afterLang: Rule[] = [
    [/=/, "delimiter", `@${tag}AfterLangEquals`],
    [/>/, { token: "delimiter", next: embedded, nextEmbedded: fallback }],
    [/[ \t\r\n]+/, ""],
    [close, { token: "@rematch", next: "@pop" }],
  ];
  const afterLangEquals: Rule[] = [
    ...langs.map(([pattern, mime]): Rule => [pattern, { token: "attribute.value", switchTo: `${custom}.${mime}` }]),
    // Any other value — `lang="js"`, `lang="postcss"` — is the tag's ordinary language.
    [/"[^"]*"|'[^']*'/, { token: "attribute.value", switchTo: `${custom}.${fallback}` }],
    [/>/, { token: "delimiter", next: embedded, nextEmbedded: fallback }],
    [/[ \t\r\n]+/, ""],
    [close, { token: "@rematch", next: "@pop" }],
  ];
  return { afterLang, afterLangEquals };
}

/**
 * Teaches Monaco's HTML grammar the `lang` attribute, in place. Answers whether it changed
 * anything — `false` for a grammar already taught, or one whose states are not where they were
 * when this was written (a Monaco release that reshaped them is left exactly as it shipped).
 */
export function teachLangAttribute(language: languages.IMonarchLanguage): boolean {
  const tokenizer = language.tokenizer as Record<string, Rule[] | undefined>;
  const script = tokenizer.script;
  const style = tokenizer.style;
  if (!script || !style || !tokenizer.scriptWithCustomType || !tokenizer.styleWithCustomType) return false;
  if (tokenizer.scriptAfterLang) return false;

  const scriptStates = langStates("script", SCRIPT_LANGS, "text/javascript");
  const styleStates = langStates("style", STYLE_LANGS, "text/css");
  // First, ahead of the rule that reads any other attribute name.
  script.unshift([/lang\b/, "attribute.name", "@scriptAfterLang"]);
  style.unshift([/lang\b/, "attribute.name", "@styleAfterLang"]);
  tokenizer.scriptAfterLang = scriptStates.afterLang;
  tokenizer.scriptAfterLangEquals = scriptStates.afterLangEquals;
  tokenizer.styleAfterLang = styleStates.afterLang;
  tokenizer.styleAfterLangEquals = styleStates.afterLangEquals;
  return true;
}
