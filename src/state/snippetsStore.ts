import { create } from "zustand";

/**
 * Snippets: a prefix you type, and the code it expands into.
 *
 * # Why these are the app's own and not Monaco's
 *
 * Monaco has no snippet *storage* — it knows how to insert one (`InsertAsSnippet`, tab stops and
 * all) but has no opinion about where a list of them comes from. VS Code keeps them in `.json`
 * files under the user profile; this keeps them here, in one place the settings screen can edit and
 * the completion provider can read, so adding a snippet takes no file on disk and no restart.
 *
 * # The body is VS Code's syntax, deliberately
 *
 * `$1`, `$2`, `${1:placeholder}` and `$0` mean what they mean everywhere else, because Monaco's
 * snippet parser is the same one — so a snippet copied out of a VS Code settings file works here
 * unchanged, and one written here can go back the other way. Nothing is translated in between.
 *
 * # Scope is a language list, not a file glob
 *
 * A snippet with an empty list is offered everywhere; otherwise it is offered in the languages it
 * names (`typescript`, `javascript`, `rust`, …, as Monaco spells them — the id under the caret is
 * what gets matched). Globs would be a second matching language to learn for a gain nobody asked
 * for: "console.log in JS and TS" is what people actually write.
 */

export interface Snippet {
  id: string;
  /** What you type to summon it. Matched by Monaco's own filtering, so `clg` finds `clg`. */
  prefix: string;
  /** The expansion, in VS Code snippet syntax. */
  body: string;
  /** Shown beside the prefix in the dropdown — the line that says which one this is. */
  description: string;
  /**
   * Monaco language ids this is offered in. Empty means every language.
   *
   * Stored rather than derived because the same prefix usually wants different bodies per language:
   * `clg` is `console.log` in TypeScript and `println!` in Rust, and those are two snippets.
   */
  languages: string[];
}

const STORAGE_KEY = "cf.snippets";

/**
 * The set a fresh install starts with.
 *
 * Enough to make the feature discoverable — you find out snippets exist by typing `clg` and seeing
 * one offered, not by reading a settings screen you had no reason to open — and few enough that the
 * list still reads as *yours* the moment you add one. Every one of them is a line people type
 * dozens of times a day.
 */
const SHIPPED: Snippet[] = [
  {
    id: "shipped-clg",
    prefix: "clg",
    body: "console.log($1);$0",
    description: "console.log",
    languages: ["javascript", "typescript"],
  },
  {
    id: "shipped-cle",
    prefix: "cle",
    body: "console.error($1);$0",
    description: "console.error",
    languages: ["javascript", "typescript"],
  },
  {
    id: "shipped-fn",
    prefix: "fn",
    body: "function ${1:name}(${2:args}) {\n\t$0\n}",
    description: "function",
    languages: ["javascript", "typescript"],
  },
  {
    id: "shipped-afn",
    prefix: "afn",
    body: "const ${1:name} = async (${2:args}) => {\n\t$0\n};",
    description: "async arrow function",
    languages: ["javascript", "typescript"],
  },
  {
    id: "shipped-tryc",
    prefix: "tryc",
    body: "try {\n\t$1\n} catch (${2:error}) {\n\t$0\n}",
    description: "try / catch",
    languages: ["javascript", "typescript"],
  },
];

/**
 * Reads the saved list.
 *
 * A stored list that cannot be parsed is replaced by the shipped one rather than left to throw on
 * every keystroke — the cost of being wrong here is a few snippets, and the cost of throwing is the
 * completion dropdown of every file in the app.
 */
function load(): Snippet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return SHIPPED;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return SHIPPED;
    return parsed.flatMap((entry) => {
      const row = entry as Partial<Snippet>;
      if (typeof row.prefix !== "string" || typeof row.body !== "string" || !row.prefix) return [];
      return [
        {
          id: typeof row.id === "string" && row.id ? row.id : newId(),
          prefix: row.prefix,
          body: row.body,
          description: typeof row.description === "string" ? row.description : "",
          languages: Array.isArray(row.languages) ? row.languages.filter((l) => typeof l === "string") : [],
        },
      ];
    });
  } catch {
    return SHIPPED;
  }
}

function save(snippets: Snippet[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snippets));
  } catch {
    // A full or blocked storage costs the *next* session its edits, not this one its snippets.
  }
}

/** Ids only have to be unique within the list, and the list is small. */
const newId = () => `snippet-${Math.random().toString(36).slice(2, 10)}`;

interface SnippetsState {
  snippets: Snippet[];
  /** Adds an empty one and hands back its id, so the caller can put the cursor in it. */
  add: () => string;
  update: (id: string, patch: Partial<Omit<Snippet, "id">>) => void;
  remove: (id: string) => void;
  /** Back to the shipped set — the escape hatch for a list edited into uselessness. */
  reset: () => void;
}

export const useSnippetsStore = create<SnippetsState>((set, get) => ({
  snippets: load(),

  add: () => {
    const id = newId();
    const next = [...get().snippets, { id, prefix: "", body: "", description: "", languages: [] }];
    set({ snippets: next });
    save(next);
    return id;
  },

  update: (id, patch) => {
    const next = get().snippets.map((snippet) => (snippet.id === id ? { ...snippet, ...patch } : snippet));
    set({ snippets: next });
    save(next);
  },

  remove: (id) => {
    const next = get().snippets.filter((snippet) => snippet.id !== id);
    set({ snippets: next });
    save(next);
  },

  reset: () => {
    set({ snippets: SHIPPED });
    save(SHIPPED);
  },
}));

/**
 * The snippets offered in one language: the ones scoped to it, plus the ones scoped to nothing.
 *
 * A prefix with no body is skipped — a half-written row in the settings screen is not something the
 * editor should be offering while it is being typed.
 */
export function snippetsFor(languageId: string): Snippet[] {
  return useSnippetsStore
    .getState()
    .snippets.filter(
      (snippet) =>
        snippet.prefix.trim() &&
        snippet.body &&
        (snippet.languages.length === 0 || snippet.languages.includes(languageId)),
    );
}
