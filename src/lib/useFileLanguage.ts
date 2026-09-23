import { useMemo } from "react";
import { useCsvStore } from "../state/csvStore";
import { csvLanguageFor } from "./csvDialect";
import { languageForPath } from "./monacoLanguage";

/**
 * The Monaco language a file is shown in: `languageForPath`, except for delimited text, whose
 * language is its separator (see `csvDialect.ts`) and therefore depends on what is in it and on the
 * CSV settings — which is why this is a hook and `languageForPath` is not.
 *
 * `text` is only read for a delimited file, and should be what the file held when it was opened
 * (a tab's `originalContent`), not the live buffer: a separator guessed from every keystroke would
 * re-colour the whole file the moment somebody typed a `;` into the header.
 *
 * `file` names the file for a separator picked from the editor's toolbar (`csvStore.fileSeparators`);
 * without it, only the settings apply.
 */
export function useFileLanguage(path: string | null, text: string, file?: string): string {
  const rainbow = useCsvStore((s) => s.rainbow);
  const separator = useCsvStore((s) => s.separator);
  const override = useCsvStore((s) => (file ? s.fileSeparators[file] : undefined));

  return useMemo(() => {
    if (!path) return "plaintext";
    return csvLanguageFor(path, text, { rainbow, separator, override }) ?? languageForPath(path);
  }, [path, text, rainbow, separator, override]);
}
