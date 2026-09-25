import { useMemo } from "react";
import { useCsvStore } from "../state/csvStore";
import { extensionOf, useLanguageOverrideStore } from "../state/languageOverrideStore";
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
 * `file` names the file for a separator picked from the editor's toolbar (`csvStore.fileSeparators`)
 * and for a language picked by hand from the status line; without it, only the settings apply.
 *
 * **A language picked by hand wins over all of it** (`languageOverrideStore`): the file's own pick
 * first, then its extension's association, and only then what the extension or the separator says.
 * An extension association applies wherever this hook runs — the diff views too — so a `.conf` read
 * as INI in the editor is INI in the diff of it as well.
 */
export function useFileLanguage(path: string | null, text: string, file?: string): string {
  const rainbow = useCsvStore((s) => s.rainbow);
  const separator = useCsvStore((s) => s.separator);
  const override = useCsvStore((s) => (file ? s.fileSeparators[file] : undefined));
  const picked = useLanguageOverrideStore((s) => (file ? s.files[file] : undefined));
  const associated = useLanguageOverrideStore((s) => {
    const extension = path ? extensionOf(path) : null;
    return extension ? s.extensions[extension] : undefined;
  });

  return useMemo(() => {
    if (!path) return "plaintext";
    if (picked) return picked;
    if (associated) return associated;
    return csvLanguageFor(path, text, { rainbow, separator, override }) ?? languageForPath(path);
  }, [path, text, rainbow, separator, override, picked, associated]);
}
