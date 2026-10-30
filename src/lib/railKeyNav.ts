/**
 * Where the arrow keys take focus on a vertical toolbar of `count` buttons: one step per
 * ArrowUp/ArrowDown (stopping at the ends, not wrapping — the rail has a start and an end the user
 * can feel), Home/End to the first/last. `null` for any other key, so the caller leaves it alone.
 */
export function stepRailIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = Math.min(Math.max(current, 0), last);
  switch (key) {
    case "ArrowDown":
      return Math.min(at + 1, last);
    case "ArrowUp":
      return Math.max(at - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * The one app button that is in the Tab order: the one last focused if it is still on the rail,
 * else the open app, else the first. `null` only for an empty rail. A remembered key that names an
 * app which has since left (switched off, renamed) must never win — it would leave no stop at all.
 */
export function railTabStop(keys: readonly string[], remembered: string | null, openKey: string | null): string | null {
  if (remembered && keys.includes(remembered)) return remembered;
  if (openKey && keys.includes(openKey)) return openKey;
  return keys[0] ?? null;
}
