/**
 * The panel chrome shared by the API client's three columns.
 *
 * Lifted out of `ApiView` into its own module because the columns import it and `ApiView` imports
 * the columns — a cycle that happens to work for a string constant and would stop working the
 * moment anything here needed a value at module-init time.
 *
 * Matches the Editor view's rail/tree/editor panels, so the two views read as the same app rather
 * than as two layouts that merely coexist. Now just a surface: the layout is flush, so a border
 * would double the `ResizeHandle`'s seam and a shadow would have nowhere to fall.
 */
export const CARD = "bg-[var(--cf-surface)]";
