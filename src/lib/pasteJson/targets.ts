/**
 * What "Paste JSON as Code" writes, per language of the file it is pasted into.
 *
 * The engine is quicktype (`quicktype-core`) — the same one behind VS Code's "Paste JSON as Code"
 * extension, whose output is the bar this is held to. That extension, left at its defaults
 * (`quicktype.justTypes: true`), pastes *types*: interfaces, structs, classes, with none of the
 * converters quicktype can also write. So does this.
 *
 * # Where this departs from quicktype's bare `just-types`
 *
 * Types are only worth pasting if the language's usual JSON decoding can fill them, and for a few
 * languages quicktype's plain types cannot be:
 *
 * - **C#** gets `[JsonPropertyName]` on every property (`attributes-only`). Without it
 *   `System.Text.Json` never maps `created_at` onto `CreatedAt`.
 * - **Swift** gets `Codable` structs with their `CodingKeys` (`initializers: false`, which is the
 *   full renderer minus the convenience initialisers). `just-types` drops `Codable` altogether and
 *   still prints a header promising a `try Model(json)` it did not write.
 * - **Dart** gets `fromJson`/`toJson`. Dart has no reflection-based decoding, so a model class
 *   without them is not a model of anything — and those two methods are precisely what Flutter
 *   developers reach for quicktype to write.
 *
 * # Strings stay strings, unless something turns them into more
 *
 * quicktype can type `"2024-01-01T00:00:00Z"` as a date and `"5d2f…"` as a UUID, but a bare type
 * does no converting: a TypeScript interface saying `Date` over what `JSON.parse` hands back as a
 * string is a lie the compiler will repeat. So dates and UUIDs are inferred only where the
 * language's own decoding makes the richer type true with nothing added — Go's `time.Time`, C#'s
 * `DateTimeOffset` and `Guid`, Swift's `UUID` — or where the pasted code does the converting itself
 * (Dart's `fromJson`). Numbers and booleans inside strings are never "inferred" into anything.
 */

/** quicktype's name for each language this can write. Also the key `shape.ts` lays files out by. */
export type Dialect = "typescript" | "python" | "go" | "rust" | "csharp" | "java" | "kotlin" | "swift" | "dart";

export interface PasteJsonTarget {
  /** The Monaco language id this was looked up by — the file's language, not quicktype's. */
  language: string;
  /** Which quicktype renderer writes it, and so also how the file's head is laid out. */
  dialect: Dialect;
  /** Passed to the renderer as is. quicktype reads every value as a string, booleans included. */
  rendererOptions: Readonly<Record<string, string>>;
  /** Infer ISO-8601 strings as the language's date type — see the file comment for when. */
  dates: boolean;
  /** Same for UUIDs. */
  uuids: boolean;
  /** Infer a string field that repeats a few values as an enum. */
  enums: boolean;
  /** Indentation the language's own formatter insists on, over the editor's setting: gofmt's tab. */
  indentation?: string;
  /** Rewrite the TypeScript quicktype writes into JSDoc `@typedef`s — JavaScript's types. */
  jsdoc?: boolean;
}

const JUST_TYPES = { "just-types": "true" } as const;

const TARGETS: Readonly<Record<string, Omit<PasteJsonTarget, "language">>> = {
  typescript: { dialect: "typescript", rendererOptions: JUST_TYPES, dates: false, uuids: false, enums: true },
  /**
   * JavaScript has no quicktype renderer that writes types — its `javascript` target is the
   * runtime-checked converters and nothing else. What JavaScript calls types are JSDoc typedefs,
   * which editors (TypeScript's checker, underneath) read; so the TypeScript renderer writes plain
   * `type` aliases, which translate into typedefs one for one. See `toJsdoc`.
   */
  javascript: {
    dialect: "typescript",
    rendererOptions: { ...JUST_TYPES, "prefer-types": "true" },
    dates: false,
    uuids: false,
    enums: true,
    jsdoc: true,
  },
  python: { dialect: "python", rendererOptions: JUST_TYPES, dates: false, uuids: false, enums: true },
  go: { dialect: "go", rendererOptions: JUST_TYPES, dates: true, uuids: false, enums: true, indentation: "\t" },
  // `rust` has no `just-types`: its output *is* types, serde derives included. The example `main` it
  // leads with is what `leading-comments` turns off; `dense` drops the blank line it otherwise puts
  // between every field, which is not how anyone writes a struct by hand.
  rust: {
    dialect: "rust",
    rendererOptions: { density: "dense", "leading-comments": "false" },
    dates: false,
    uuids: false,
    enums: true,
  },
  // No enums: `System.Text.Json` reads an enum from its *number*, so quicktype pairs every inferred
  // enum with a converter — and with it a `Converter` class carrying date and time converters the JSON
  // never needed, ~150 lines for one `status` field. A `string` decodes as it stands.
  csharp: {
    dialect: "csharp",
    rendererOptions: { features: "attributes-only" },
    dates: true,
    uuids: true,
    enums: false,
  },
  java: { dialect: "java", rendererOptions: JUST_TYPES, dates: false, uuids: false, enums: true },
  kotlin: { dialect: "kotlin", rendererOptions: JUST_TYPES, dates: false, uuids: false, enums: true },
  swift: { dialect: "swift", rendererOptions: { initializers: "false" }, dates: false, uuids: true, enums: true },
  dart: { dialect: "dart", rendererOptions: {}, dates: true, uuids: false, enums: true },
};

/** What a language this cannot write falls back to, when the user agrees to it. */
export const FALLBACK_LANGUAGE = "typescript";

/** The target for a file in Monaco language `language`, or `null` when this does not write it. */
export function targetFor(language: string): PasteJsonTarget | null {
  const target = TARGETS[language];
  return target ? { language, ...target } : null;
}

/** Every Monaco language id this writes, for the tests and for anything that lists them. */
export const PASTE_JSON_LANGUAGES: readonly string[] = Object.keys(TARGETS);

/**
 * Whether `name` can be a type's name: a letter or `_`, then letters, digits and `_`.
 *
 * Deliberately stricter than what quicktype would accept. It turns anything into *some* identifier —
 * `order-list` becomes `OrderList` — so a loose rule would paste a type called something other than
 * what was typed, and the one thing the prompt asks is what to call it. It still applies each
 * language's casing (`order` is `Order` in every one of them), which is the convention, not a rename.
 */
export function isTypeName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
