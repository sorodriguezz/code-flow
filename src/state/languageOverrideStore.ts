import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

const FILES_KEY = "editor_file_languages";
const EXTENSIONS_KEY = "editor_extension_languages";

/**
 * Languages picked by hand from the Editor's status line, over what the extension says (the user's
 * ask, 2026-09-25: "debería poder darse clic y cambiarlo a mano"). Two scopes, VS Code's two:
 *
 * - **a file** — keyed by its model path (`modelPathFor`), which is the project id plus the path, so
 *   the same `config` in two repositories is two files;
 * - **an extension** — every `.conf` everywhere, VS Code's `files.associations`, keyed with the dot
 *   and lower-cased.
 *
 * A file's pick wins over its extension's, and both win over detection (`useFileLanguage`). Kept in
 * settings rather than in memory, so a pick survives the tab being closed and the app restarting — a
 * language you have to choose again every time you open the file is not a setting.
 */
interface LanguageOverrideState {
  files: Record<string, string>;
  extensions: Record<string, string>;
  init: () => Promise<void>;
  /** `null` goes back to detection. */
  setFileLanguage: (file: string, language: string | null) => Promise<void>;
  /** `null` drops the association. */
  setExtensionLanguage: (extension: string, language: string | null) => Promise<void>;
}

function parseMap(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function withEntry(map: Record<string, string>, key: string, value: string | null): Record<string, string> {
  const { [key]: _previous, ...rest } = map;
  return value ? { ...rest, [key]: value } : rest;
}

export const useLanguageOverrideStore = create<LanguageOverrideState>((set, get) => ({
  files: {},
  extensions: {},

  init: async () => {
    const stored = await getSettings([FILES_KEY, EXTENSIONS_KEY]).catch(() => null);
    set({ files: parseMap(stored?.[FILES_KEY]), extensions: parseMap(stored?.[EXTENSIONS_KEY]) });
  },

  setFileLanguage: async (file, language) => {
    const files = withEntry(get().files, file, language);
    set({ files });
    await setSetting(FILES_KEY, JSON.stringify(files));
  },

  setExtensionLanguage: async (extension, language) => {
    const extensions = withEntry(get().extensions, extension.toLowerCase(), language);
    set({ extensions });
    await setSetting(EXTENSIONS_KEY, JSON.stringify(extensions));
  },
}));

watchSettings([FILES_KEY, EXTENSIONS_KEY], () => useLanguageOverrideStore.getState().init());

/** `.ts` for `src/a.ts`; `null` for a name with no extension (`Dockerfile`) or a dotfile (`.env`). */
export function extensionOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : null;
}
