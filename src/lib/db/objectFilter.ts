/**
 * The name-filter grammar, as two lists instead of one string.
 *
 * A filter is stored as `app_*, !app_old_*` — comma-separated terms, `!` for "not this". That is a
 * good thing to *store*: it is one field, it round-trips through a text box, and it is what every
 * connection saved before the dialog existed already holds. It is a bad thing to *edit*, because the
 * two halves of it do opposite things and the punctuation carrying that distinction is one character
 * wide.
 *
 * So the dialog edits an `include` list and an `exclude` list, and these two functions are the only
 * place that knows they are the same string. The grammar itself is not reimplemented here — matching
 * happens in Rust (`object_filter_matches`), which is the one thing that decides whether a name
 * survives. This is the split and the join, nothing more.
 *
 * **What it cannot express.** A term with a comma in it, and a term that genuinely starts with `!`.
 * Both are limits of the stored format rather than of this parse, and neither is a name any of the
 * five engines will hand back without the user having gone out of their way to create it.
 */
export interface FilterTerms {
  /** Names to keep. Empty means "everything the exclusions don't rule out". */
  include: string[];
  /** Names to drop. Wins over `include`, exactly as the matcher applies it. */
  exclude: string[];
}

export const EMPTY_TERMS: FilterTerms = { include: [], exclude: [] };

/** Splits a stored pattern into the two lists. Blank terms are dropped, so a trailing comma left
 * behind while typing doesn't become an entry nobody can see. */
export function parseFilterTerms(pattern: string): FilterTerms {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of pattern.split(",")) {
    const term = raw.trim();
    if (!term) continue;
    if (term.startsWith("!")) {
      const body = term.slice(1).trim();
      if (body) exclude.push(body);
    } else {
      include.push(term);
    }
  }
  return { include, exclude };
}

/** Joins the two lists back into a stored pattern. Includes first, which is the order someone
 * reading the field expects and the order `parseFilterTerms` will hand back. */
export function formatFilterTerms(terms: FilterTerms): string {
  const clean = (list: string[]) => list.map((term) => term.trim()).filter(Boolean);
  return [...clean(terms.include), ...clean(terms.exclude).map((term) => `!${term}`)].join(", ");
}

/** Whether a set of terms would filter anything at all — what decides between "no filter" and one
 * the user has written but left empty. */
export function hasTerms(terms: FilterTerms): boolean {
  return formatFilterTerms(terms) !== "";
}

// ---------------------------------------------------------------------------
// What is in force where
// ---------------------------------------------------------------------------

/**
 * The object-filter pattern in force for one level of the tree, or `""` for none.
 *
 * A second, small copy of the backend's `object_filter_for` — deliberately, and only so the tree can
 * *say* it is filtered. The backend keeps owning what is actually hidden; nothing here decides which
 * nodes survive. The rule it mirrors: most specific wins and the first match ends it, and a disabled
 * entry answers "no filter" rather than falling through to a broader one.
 */
export function effectiveObjectFilter(
  config: {
    object_filter: string;
    object_filter_enabled: boolean;
    schema_object_filters: { schema: string; folder: string | null; pattern: string; enabled: boolean }[];
  },
  schema: string | null,
  folder: string | null,
): string {
  if (schema !== null) {
    for (const want of [folder, null]) {
      const entry = config.schema_object_filters.find(
        (candidate) =>
          candidate.schema.toLowerCase() === schema.toLowerCase() &&
          (candidate.folder ?? null) === want,
      );
      if (entry) return entry.enabled ? entry.pattern.trim() : "";
      // A folder asking about itself and finding nothing falls through to the schema-wide entry;
      // asking twice with the same `want` would loop, so `null` is only tried once.
      if (want === null) break;
    }
  }
  return config.object_filter_enabled ? config.object_filter.trim() : "";
}

/** Whether anything at all narrows what a schema lists — its own entry, one of its folders', or the
 * connection's. What the tree needs to mark the schema row itself. */
export function schemaIsNarrowed(
  config: {
    object_filter: string;
    object_filter_enabled: boolean;
    schema_object_filters: { schema: string; folder: string | null; pattern: string; enabled: boolean }[];
  },
  schema: string,
): boolean {
  const own = config.schema_object_filters.filter(
    (entry) => entry.schema.toLowerCase() === schema.toLowerCase(),
  );
  if (own.some((entry) => entry.enabled && entry.pattern.trim())) return true;
  // A disabled or empty entry for the schema as a whole is the schema saying "not filtered", which
  // stops the connection's pattern from reaching it — the same precedence the backend applies.
  if (own.some((entry) => (entry.folder ?? null) === null)) return false;
  return config.object_filter_enabled && config.object_filter.trim() !== "";
}
