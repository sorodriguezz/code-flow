/**
 * The panel chrome shared by the API client's three columns.
 *
 * Lifted out of `ApiView` into its own module because the columns import it and `ApiView` imports
 * the columns — a cycle that happens to work for a string constant and would stop working the
 * moment anything here needed a value at module-init time.
 *
 * Copied in spirit from the Editor view's rail/tree/editor cards, so the two views read as the
 * same app rather than as two layouts that merely coexist.
 */
export const CARD =
  "rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]";
