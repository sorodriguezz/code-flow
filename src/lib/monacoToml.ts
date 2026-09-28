// Not `from "./monacoSetup"` — that module imports this one. See `monacoDbml.ts` for the same note.
import * as monaco from "monaco-editor";

/**
 * TOML, registered once and loaded when first needed.
 *
 * The id is registered at startup — `monacoLanguage` has always mapped `.toml` to `toml`, but
 * nothing ever registered that id, so the mapping pointed at a language Monaco did not have and
 * every manifest opened as plain text. The grammar (`tomlGrammar.ts`) is its own chunk, fetched by
 * `onLanguage` the first time a model is created with the id: the moment it is needed, and never
 * in a session that opens no TOML at all. Monaco re-tokenizes the open model when the provider
 * lands, so the file colours itself a frame after it appears.
 */

let registered = false;

export function registerTomlLanguage(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: "toml", extensions: [".toml"], aliases: ["TOML", "toml"] });
  monaco.languages.onLanguage("toml", () => {
    void import("./tomlGrammar").then(({ TOML_CONFIG, TOML_GRAMMAR }) => {
      monaco.languages.setLanguageConfiguration("toml", TOML_CONFIG);
      monaco.languages.setMonarchTokensProvider("toml", TOML_GRAMMAR);
    });
  });
}
