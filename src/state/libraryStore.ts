import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { libraryDelete, libraryList, librarySave } from "../lib/tauri/crewCommands";
import { builtinLibrary, isBuiltin } from "../lib/agents/builtinTemplates";
import type { LibraryItem } from "../types/crew";
import { useLanguageStore } from "./languageStore";

/**
 * The agent and team templates every workspace can use: the built-in ones (from code, in the
 * reader's language) merged with the user's own and their edited copies of built-ins.
 */
interface LibraryState {
  saved: LibraryItem[];
  loaded: boolean;
  load: () => Promise<void>;
  /** Built-ins first, each replaced by the user's edited copy when there is one. */
  all: () => LibraryItem[];
  save: (item: LibraryItem) => Promise<LibraryItem>;
  remove: (id: string) => Promise<void>;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  saved: [],
  loaded: false,
  load: async () => {
    const saved = await libraryList().catch(() => [] as LibraryItem[]);
    set({ saved, loaded: true });
  },
  all: () => {
    const lang = useLanguageStore.getState().language;
    const saved = get().saved;
    const edited = new Map(saved.filter((item) => item.based_on).map((item) => [item.based_on, item]));
    const builtins = builtinLibrary(lang).map((item) => edited.get(item.id) ?? item);
    const own = saved.filter((item) => !item.based_on || !isBuiltin(item.based_on));
    return [...builtins, ...own];
  },
  save: async (item) => {
    // Editing a built-in saves a copy that points back at it.
    const toSave = isBuiltin(item.id) ? { ...item, id: "", based_on: item.id } : item;
    const saved = await librarySave(toSave);
    set((s) => ({ saved: [...s.saved.filter((x) => x.id !== saved.id), saved] }));
    return saved;
  },
  remove: async (id) => {
    if (isBuiltin(id)) return;
    set((s) => ({ saved: s.saved.filter((x) => x.id !== id) }));
    await libraryDelete(id);
  },
}));

if (typeof window !== "undefined") {
  void listen("crew:library", () => void useLibraryStore.getState().load()).catch(() => undefined);
}
